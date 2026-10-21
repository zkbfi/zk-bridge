//! Where beacon data comes from.
//!
//! One trait, two sources. [`http::HttpBeaconSource`] talks to a beacon node. [`dev::DevBeaconSource`] serves Anvil,
//! which has no beacon chain: it treats an execution block as final once it lies a set number of blocks below the
//! latest block, and it builds a synthetic beacon chain over the real execution blocks.
//!
//! The service asks the source four things. Which source blocks are final. What the next light-client update must be
//! for a deposit. What the beacon part of a withdrawal looks like. What evidence the vault needs for its layout rows.

#[cfg(feature = "dev-source")]
pub mod dev;
pub mod http;

use crate::chain::ExecutionReader;
use crate::error::Result;
use crate::light_client::{BeaconHeader, BeaconPath, ChainKind};
use crate::prover::ProofStatement;
use alloy_primitives::B256;

/// The block of a deposit, as the source chain reports it.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct DepositBlock {
    /// The block number.
    pub number: u64,
    /// The block hash.
    pub hash: B256,
    /// The block timestamp. On a beacon chain it fixes the slot.
    pub timestamp: u64,
}

/// What the destination light client holds, as the service read it.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct LightClientState {
    /// The slot of the head.
    pub head_slot: u64,
    /// The header root stored for the head.
    pub head_root: B256,
    /// The execution block hash stored for the head.
    pub head_execution_hash: B256,
    /// The genesis validators root of the tracked chain.
    pub genesis_validators_root: B256,
    /// Slots per sync committee period.
    pub slots_per_period: u64,
    /// The committee hash stored for the period of the head.
    pub head_committee_hash: B256,
    /// The committee hash stored for the period after the head, or zero.
    pub next_committee_hash: B256,
}

/// The answer to "what must the light client do for this deposit".
#[derive(Clone, Debug)]
pub enum UpdatePlan {
    /// The light client already holds a header that covers the deposit block.
    Covered,
    /// The source has no final header that covers the deposit block yet. Wait.
    NotYetFinal,
    /// Submit this update. Afterwards ask again.
    Update(Box<ProofStatement>),
}

/// Evidence for `BridgeVault.addBlockRootsLayout`.
#[derive(Clone, Debug)]
pub struct RootsEvidence {
    /// The candidate generalized index of `BeaconState.block_roots`.
    pub gindex: u64,
    /// A stored header; its state root holds the block roots.
    pub later_header: BeaconHeader,
    /// A stored earlier slot.
    pub earlier_slot_a: u64,
    /// Another stored earlier slot.
    pub earlier_slot_b: u64,
    /// Branch from the stored root at `earlier_slot_a` to the later state root.
    pub branch_a: Vec<B256>,
    /// Branch from the stored root at `earlier_slot_b` to the later state root.
    pub branch_b: Vec<B256>,
}

/// Evidence for `BridgeVault.addBlockHashLayout`.
#[derive(Clone, Debug)]
pub struct HashEvidence {
    /// The candidate generalized index of `execution_payload.block_hash`.
    pub gindex: u64,
    /// A stored header.
    pub header: BeaconHeader,
    /// Branch from the stored execution block hash to the body root of the header.
    pub branch: Vec<B256>,
}

/// Evidence for `BridgeVault.addHistoricalSummariesLayout`.
#[derive(Clone, Debug)]
pub struct HistoricalEvidence {
    /// The candidate generalized index of `BeaconState.historical_summaries`.
    pub gindex: u64,
    /// A stored header; its state root holds the historical summaries.
    pub anchor_header: BeaconHeader,
    /// A stored slot more than 8192 slots below the anchor, in a completed era.
    pub earlier_slot: u64,
    /// Branch from the stored root at `earlier_slot` to the anchor state root.
    pub branch: Vec<B256>,
}

/// A source of beacon data for one source chain.
pub trait BeaconSource: Send + Sync {
    /// The name that logs show.
    fn name(&self) -> &'static str;

    /// The `lc-core` chain configuration that applies to this source.
    fn chain_kind(&self) -> ChainKind;

    /// The highest source block that counts as final, or `None` when there is none yet.
    ///
    /// A real chain answers with its `finalized` tag. The development source answers with a depth rule.
    fn finalized_execution_block(&self, source: &dyn ExecutionReader) -> Result<Option<u64>>;

    /// What the light client must do next for a deposit.
    fn next_update(
        &self,
        deposit: &DepositBlock,
        light_client: &LightClientState,
        stored_slots: &[u64],
        source: &dyn ExecutionReader,
    ) -> Result<UpdatePlan>;

    /// The beacon part of the withdrawal for a deposit block.
    fn withdrawal_path(
        &self,
        deposit: &DepositBlock,
        light_client: &LightClientState,
        stored_slots: &[u64],
        source: &dyn ExecutionReader,
    ) -> Result<BeaconPath>;

    /// Evidence for a `block_roots` layout row that covers `anchor_slot`, or `None` when the stored headers do not
    /// yet allow it.
    fn roots_layout_evidence(
        &self,
        anchor: &BeaconHeader,
        stored_slots: &[u64],
        source: &dyn ExecutionReader,
    ) -> Result<Option<RootsEvidence>>;

    /// Evidence for a `historical_summaries` layout row that covers `anchor.slot`, or `None` when the stored headers
    /// do not yet allow it (no stored slot lies in a completed era more than 8192 slots below the anchor).
    fn historical_layout_evidence(
        &self,
        anchor: &BeaconHeader,
        stored_slots: &[u64],
        source: &dyn ExecutionReader,
    ) -> Result<Option<HistoricalEvidence>>;

    /// Evidence for a block hash layout row from the stored header with the highest slot at or below `at_or_below`,
    /// or `None` when no stored header qualifies.
    fn hash_layout_evidence(
        &self,
        at_or_below: u64,
        stored_slots: &[u64],
        source: &dyn ExecutionReader,
    ) -> Result<Option<HashEvidence>>;
}
