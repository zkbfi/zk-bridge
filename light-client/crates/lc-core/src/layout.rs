//! Generalized indices per fork.
//!
//! The values come from `ethereum/consensus-specs` (master, fetched 2026-10-20):
//! - `specs/altair/light-client/sync-protocol.md`, section "Constants"
//! - `specs/capella/light-client/sync-protocol.md`, section "Constants"
//! - `specs/deneb/light-client/sync-protocol.md`, section "Helpers"
//! - `specs/electra/light-client/sync-protocol.md`, sections "Constants" and "Helpers"
//! - `specs/gloas/light-client/sync-protocol.md`, sections "Constants" and "Helpers", and `specs/gloas/beacon-chain.md`,
//!   section "Modified containers" (field lists) with `eip-7495.md` and `eip-7916.md` (progressive containers)
//!
//! The spec selects the beacon state indices by the epoch of the ATTESTED header slot
//! (`finalized_root_gindex_at_slot`). It selects the execution header form by the epoch of each header's own slot
//! (`get_lc_execution_root`).

use crate::chain::ForkName;
use crate::error::{Error, Result};
use crate::ssz::gindex_depth;

/// Generalized indices of fields inside `BeaconState` that the light client uses.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct StateLayout {
    /// `get_generalized_index(BeaconState, "finalized_checkpoint", "root")`.
    pub finalized_root_gindex: u64,
    /// `get_generalized_index(BeaconState, "current_sync_committee")`.
    pub current_sync_committee_gindex: u64,
    /// `get_generalized_index(BeaconState, "next_sync_committee")`.
    pub next_sync_committee_gindex: u64,
    /// `get_generalized_index(BeaconState, "block_roots")`. The vector holds 8192 roots below this node.
    pub block_roots_gindex: u64,
    /// `get_generalized_index(BeaconState, "historical_summaries")`. Field 27 in Capella through Fulu.
    pub historical_summaries_gindex: u64,
}

/// `SLOTS_PER_HISTORICAL_ROOT`: the length of `BeaconState.block_roots`.
///
/// Source: `/eth/v1/config/spec` on both chains (see the chain specification fixtures); consensus-specs
/// `presets/mainnet/phase0.yaml`. A test compares this constant with both fixtures.
pub const SLOTS_PER_HISTORICAL_ROOT: u64 = 8192;

/// Depth of the `block_roots` vector below its field node: `log2(8192)`.
pub const BLOCK_ROOTS_VECTOR_DEPTH: u32 = 13;

/// Depth of the `historical_summaries` list below its data node: `log2(HISTORICAL_ROOTS_LIMIT)` with
/// `HISTORICAL_ROOTS_LIMIT = 2**24` (`HistoricalSummaries.LIMIT` in `specs/capella/beacon-chain.md`).
pub const HISTORICAL_SUMMARIES_LIST_DEPTH: u32 = 24;

/// Position of `historical_summaries` among the `BeaconState` fields, in Capella, Deneb, Electra and Fulu.
///
/// Source: container `BeaconState` in `specs/capella/beacon-chain.md` (28 fields; `historical_summaries` is the last,
/// field 27, marked "New in Capella"). `specs/deneb`, `specs/electra` and `specs/fulu` `beacon-chain.md` only append
/// fields after it (Electra 37 fields, Fulu 38), so the position stays 27. Checked on 2026-10-20 by counting the fields of
/// each fork's `BeaconState` in those four files.
pub const HISTORICAL_SUMMARIES_FIELD_INDEX: u64 = 27;

/// Position of `block_roots` among the `BeaconState` fields (phase0 field order).
pub const BLOCK_ROOTS_FIELD_INDEX: u64 = 5;

/// Position of `execution_payload` among the `BeaconBlockBody` fields, in Capella through Fulu (index 25 at depth 4).
pub const EXECUTION_PAYLOAD_FIELD_INDEX: u64 = 9;

/// Position of `block_hash` among the `ExecutionPayload` fields, in Capella through Fulu.
pub const BLOCK_HASH_FIELD_INDEX: u64 = 12;

/// The tree depths of `BeaconState` that a layout position may have: 32, 64 or 128 leaves (up to 128 fields).
///
/// The same rule as `_isStateFieldPosition` in `BeaconProofVerifier.sol`. Today's layouts use depth 5 (Capella, Deneb) and depth 6
/// (Electra, Fulu). Depth 7 is allowed so that a later fork with more than 64 fields needs no new bridge.
pub const STATE_DEPTHS: core::ops::RangeInclusive<u32> = 5..=7;

/// The tree depths of `BeaconBlockBody` that a block hash position may have: 16 or 32 leaves.
pub const BODY_DEPTHS: core::ops::RangeInclusive<u32> = 4..=5;

/// The tree depths of `ExecutionPayload` that a block hash position may have: 16 or 32 leaves.
pub const PAYLOAD_DEPTHS: core::ops::RangeInclusive<u32> = 4..=5;

/// Layout of the Capella and Deneb `BeaconState` (28 fields, tree depth 5).
///
/// Source: `specs/altair/light-client/sync-protocol.md` "Constants": 105, 54, 55.
/// `block_roots` is field 5, so its index is 32 + 5 = 37 (the field order is in `specs/phase0/beacon-chain.md`,
/// container `BeaconState`).
pub const CAPELLA_DENEB_STATE_LAYOUT: StateLayout = StateLayout {
    finalized_root_gindex: 105,
    current_sync_committee_gindex: 54,
    next_sync_committee_gindex: 55,
    block_roots_gindex: 37,
    historical_summaries_gindex: 32 + HISTORICAL_SUMMARIES_FIELD_INDEX,
};

/// Layout of the Electra and Fulu `BeaconState` (more than 32 fields, tree depth 6).
///
/// Source: `specs/electra/light-client/sync-protocol.md` "Constants": 169, 86, 87.
/// `block_roots` is field 5, so its index is 64 + 5 = 69.
pub const ELECTRA_STATE_LAYOUT: StateLayout = StateLayout {
    finalized_root_gindex: 169,
    current_sync_committee_gindex: 86,
    next_sync_committee_gindex: 87,
    block_roots_gindex: 69,
    historical_summaries_gindex: 64 + HISTORICAL_SUMMARIES_FIELD_INDEX,
};

/// `EXECUTION_PAYLOAD_GINDEX`: `get_generalized_index(BeaconBlockBody, "execution_payload")` = 25.
///
/// Source: `specs/capella/light-client/sync-protocol.md` "Constants". Deneb and Electra use it unchanged
/// (`specs/deneb/light-client/sync-protocol.md` and `specs/electra/light-client/sync-protocol.md`
/// reuse `EXECUTION_PAYLOAD_GINDEX` with `floorlog2` and `get_subtree_index`).
pub const EXECUTION_PAYLOAD_GINDEX: u64 = 25;

/// `get_generalized_index(BeaconBlockBody, "execution_payload", "block_hash")` for Capella: 25 * 16 + 12 = 412.
///
/// `execution_payload` is body field 9 (index 25, `specs/capella/light-client/sync-protocol.md`). `ExecutionPayload` has
/// 15 fields in Capella (`specs/capella/beacon-chain.md`, container `ExecutionPayload`), a tree of depth 4, and
/// `block_hash` is its field 12. The branch has 8 entries.
pub const BLOCK_HASH_GINDEX_CAPELLA: u64 = EXECUTION_PAYLOAD_GINDEX * 16 + 12;

/// The same for Deneb, Electra and Fulu: 25 * 32 + 12 = 812.
///
/// `ExecutionPayload` has 17 fields from Deneb on (`specs/deneb/beacon-chain.md`, container `ExecutionPayload`; Electra
/// does not change it), a tree of depth 5. The body keeps depth 4 (13 fields in Electra). The branch has 9 entries.
pub const BLOCK_HASH_GINDEX_DENEB: u64 = EXECUTION_PAYLOAD_GINDEX * 32 + 12;

// ---------------------------------------------------------------------------------------------------------------------
// Gloas
// ---------------------------------------------------------------------------------------------------------------------
//
// From Gloas on, `BeaconState`, `BeaconBlockBody` and `ExecutionPayloadBid` are progressive containers. A progressive
// container does not pad its fields to a power of two. Chunk `i` sits in a subtree of 1, then 4, then 16, then 64 (and so
// on) leaves. So a generalized index is no longer `2^depth + field_index`. The code below keeps the field lists of the
// specification and derives every index from the names.

/// How a container merkleizes its fields.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ContainerShape {
    /// A plain `Container`: the fields are the leaves of a binary tree padded to a power of two.
    Plain,
    /// A `ProgressiveContainer` whose `ACTIVE_FIELDS` has `width` bits, all set. The root is
    /// `hash(merkleize_progressive(field_roots), active_fields)`, so the progressive tree is the left child of the root.
    Progressive {
        /// The `width` of `active_fields(width=N)`. It equals the number of fields.
        width: usize,
    },
}

/// A container type: its name, the source of its field list, its shape and its field names in order.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct ContainerDefinition {
    /// The name in the specification.
    pub name: &'static str,
    /// Where the field list comes from.
    pub source: &'static str,
    /// Plain or progressive.
    pub shape: ContainerShape,
    /// Field names in specification order.
    pub fields: &'static [&'static str],
}

impl ContainerDefinition {
    /// The position of a field by name.
    pub fn field_position(&self, field: &str) -> Option<usize> {
        self.fields.iter().position(|name| *name == field)
    }

    /// The generalized index of a field, given the generalized index of the container node. `None` when the field name is
    /// unknown or the index would not fit in 64 bits.
    ///
    /// Plain container: `container * 2^ceil_log2(field count) + position`. Progressive container: the progressive tree
    /// is the left child of the container node, and the chunk index gives the subtree (see [`progressive_chunk_gindex`]).
    pub fn field_gindex(&self, container_gindex: u64, field: &str) -> Option<u64> {
        let position = self.field_position(field)?;
        match self.shape {
            ContainerShape::Plain => {
                container_gindex.checked_mul(self.fields.len().next_power_of_two() as u64)?.checked_add(position as u64)
            }
            ContainerShape::Progressive { width } => {
                assert_eq!(width, self.fields.len(), "ACTIVE_FIELDS must have one bit per field");
                progressive_chunk_gindex(container_gindex.checked_mul(2)?, position as u64)
            }
        }
    }
}

/// The generalized index of chunk `chunk_index` of a progressive Merkle tree whose root has the generalized index
/// `tree_root`. Source: `eip-7916.md`, section "Progressive Merkle tree".
///
/// The tree is `hash(merkleize(chunks[:n], n), rest)` with `n` = 1, 4, 16, 64 and so on. The subtree of level `k` is the
/// left child (`2 * root_k`), and the rest is the right child (`2 * root_k + 1`). Level `k` holds `4^k` leaves.
pub fn progressive_chunk_gindex(tree_root: u64, chunk_index: u64) -> Option<u64> {
    let mut root = tree_root;
    let mut first_chunk = 0u64;
    let mut leaves = 1u64;
    loop {
        if chunk_index < first_chunk.checked_add(leaves)? {
            return root.checked_mul(2)?.checked_mul(leaves)?.checked_add(chunk_index - first_chunk);
        }
        first_chunk += leaves;
        root = root.checked_mul(2)?.checked_add(1)?;
        leaves = leaves.checked_mul(4)?;
    }
}

/// The generalized index at the end of a path of `(container, field)` steps, starting at the root (index 1).
/// `None` when a field name is unknown.
pub fn path_gindex(path: &[(&ContainerDefinition, &str)]) -> Option<u64> {
    path.iter().try_fold(1u64, |node, (container, field)| container.field_gindex(node, field))
}

/// `Checkpoint`: `epoch`, `root`. Source: `specs/phase0/beacon-chain.md`, section "Checkpoint".
pub const CHECKPOINT: ContainerDefinition = ContainerDefinition {
    name: "Checkpoint",
    source: "specs/phase0/beacon-chain.md, Checkpoint",
    shape: ContainerShape::Plain,
    fields: &["epoch", "root"],
};

/// `SignedExecutionPayloadBid`: a plain container. Source: `specs/gloas/beacon-chain.md`, section
/// "SignedExecutionPayloadBid".
pub const SIGNED_EXECUTION_PAYLOAD_BID: ContainerDefinition = ContainerDefinition {
    name: "SignedExecutionPayloadBid",
    source: "specs/gloas/beacon-chain.md, SignedExecutionPayloadBid",
    shape: ContainerShape::Plain,
    fields: &["message", "signature"],
};

/// `ExecutionPayloadBid`: 12 fields, `ACTIVE_FIELDS = active_fields(width=12)`. Source: `specs/gloas/beacon-chain.md`,
/// section "ExecutionPayloadBid".
pub const EXECUTION_PAYLOAD_BID: ContainerDefinition = ContainerDefinition {
    name: "ExecutionPayloadBid",
    source: "specs/gloas/beacon-chain.md, ExecutionPayloadBid",
    shape: ContainerShape::Progressive { width: 12 },
    fields: &[
        "parent_block_hash",
        "parent_block_root",
        "block_hash",
        "prev_randao",
        "fee_recipient",
        "gas_limit",
        "builder_index",
        "slot",
        "value",
        "execution_payment",
        "blob_kzg_commitments",
        "execution_requests_root",
    ],
};

/// The Gloas `BeaconBlockBody`: 13 fields, `ACTIVE_FIELDS = active_fields(width=13)`. Source: `specs/gloas/beacon-chain.md`,
/// section "Modified containers", `BeaconBlockBody`. The fields `execution_payload`, `blob_kzg_commitments` and
/// `execution_requests` are gone. `signed_execution_payload_bid`, `payload_attestations` and `parent_execution_requests`
/// are new.
pub const BEACON_BLOCK_BODY_GLOAS: ContainerDefinition = ContainerDefinition {
    name: "BeaconBlockBody",
    source: "specs/gloas/beacon-chain.md, Modified containers, BeaconBlockBody",
    shape: ContainerShape::Progressive { width: 13 },
    fields: &[
        "randao_reveal",
        "eth1_data",
        "graffiti",
        "proposer_slashings",
        "attester_slashings",
        "attestations",
        "deposits",
        "voluntary_exits",
        "sync_aggregate",
        "bls_to_execution_changes",
        "signed_execution_payload_bid",
        "payload_attestations",
        "parent_execution_requests",
    ],
};

/// The Gloas `BeaconState`: 46 fields, `ACTIVE_FIELDS = active_fields(width=46)`. Source: `specs/gloas/beacon-chain.md`,
/// section "Modified containers", `BeaconState`. `latest_execution_payload_header` is gone. Builder and payload fields
/// are new.
pub const BEACON_STATE_GLOAS: ContainerDefinition = ContainerDefinition {
    name: "BeaconState",
    source: "specs/gloas/beacon-chain.md, Modified containers, BeaconState",
    shape: ContainerShape::Progressive { width: 46 },
    fields: &[
        "genesis_time",
        "genesis_validators_root",
        "slot",
        "fork",
        "latest_block_header",
        "block_roots",
        "state_roots",
        "historical_roots",
        "eth1_data",
        "eth1_data_votes",
        "eth1_deposit_index",
        "validators",
        "balances",
        "randao_mixes",
        "slashings",
        "previous_epoch_participation",
        "current_epoch_participation",
        "justification_bits",
        "previous_justified_checkpoint",
        "current_justified_checkpoint",
        "finalized_checkpoint",
        "inactivity_scores",
        "current_sync_committee",
        "next_sync_committee",
        "latest_block_hash",
        "next_withdrawal_index",
        "next_withdrawal_validator_index",
        "historical_summaries",
        "deposit_requests_start_index",
        "deposit_balance_to_consume",
        "exit_balance_to_consume",
        "earliest_exit_epoch",
        "consolidation_balance_to_consume",
        "earliest_consolidation_epoch",
        "pending_deposits",
        "pending_partial_withdrawals",
        "pending_consolidations",
        "proposer_lookahead",
        "builders",
        "next_withdrawal_builder_index",
        "execution_payload_availability",
        "builder_pending_payments",
        "builder_pending_withdrawals",
        "latest_execution_payload_bid",
        "payload_expected_withdrawals",
        "ptc_window",
    ],
};

/// `FINALIZED_ROOT_GINDEX_GLOAS`: `get_generalized_index(BeaconState, "finalized_checkpoint", "root")` = 735.
///
/// Source: `specs/gloas/light-client/sync-protocol.md`, section "New constants". Chunk 20 sits in the 16 leaf subtree at
/// node 22 (leaves 352 to 367) and is leaf 367. `root` is field 1 of `Checkpoint`: 367 * 2 + 1. The branch has 9 entries.
pub const FINALIZED_ROOT_GINDEX_GLOAS: u64 = 735;

/// `CURRENT_SYNC_COMMITTEE_GINDEX_GLOAS` = 2945. Source: same section. Chunk 22 sits in the 64 leaf subtree at node 46
/// (leaves 2944 to 3007), second leaf. The branch has 11 entries.
pub const CURRENT_SYNC_COMMITTEE_GINDEX_GLOAS: u64 = 2945;

/// `NEXT_SYNC_COMMITTEE_GINDEX_GLOAS` = 2946. Chunk 23 is the third leaf of the same subtree.
pub const NEXT_SYNC_COMMITTEE_GINDEX_GLOAS: u64 = 2946;

/// `get_generalized_index(BeaconState, "block_roots")` in Gloas = 352. Derived from the field list (chunk 5 is the first
/// leaf of the 16 leaf subtree), not copied from a constant of the specification. Depth 8. The specification keeps
/// `BlockRoots` as a vector of `SLOTS_PER_HISTORICAL_ROOT` roots (the Gloas files do not list it among the modified
/// types, and the fork upgrade copies it unchanged).
pub const BLOCK_ROOTS_GINDEX_GLOAS: u64 = 352;

/// `get_generalized_index(BeaconState, "historical_summaries")` in Gloas = 2950, derived like [`BLOCK_ROOTS_GINDEX_GLOAS`]:
/// chunk 27 is leaf 2944 + 6. Depth 11. `HistoricalSummaries` stays a list of `HistoricalSummary` with limit
/// `HISTORICAL_ROOTS_LIMIT` = 2^24 (not in the Gloas lists of modified types; the upgrade copies it).
pub const HISTORICAL_SUMMARIES_GINDEX_GLOAS: u64 = 2950;

/// `EXECUTION_BLOCK_HASH_GINDEX_GLOAS`: `get_generalized_index(BeaconBlockBody, "signed_execution_payload_bid", "message",
/// "parent_block_hash")` = 2856. Source: `specs/gloas/light-client/sync-protocol.md`, section "New constants".
///
/// Chunk 10 of the body is leaf 357 (16 leaf subtree at node 22). `message` is field 0 of `SignedExecutionPayloadBid`: 714.
/// The bid is progressive, so its tree is node 1428 and `parent_block_hash` (chunk 0) is node 2856. The branch has 11 entries.
///
/// IMPORTANT: this is the PARENT execution block hash of the bid, the block that the bid builds on. It is not the hash of
/// the execution payload of the same beacon block (that payload is the bid's `block_hash`, and it may be revealed later or
/// never).
pub const BLOCK_HASH_GINDEX_GLOAS: u64 = 2856;

/// Layout of the Gloas `BeaconState` (46 fields, progressive).
///
/// The positions are NOT of the form `2^depth + field_index`. The deployed Solidity rules (`_isStateFieldPosition` in
/// `BeaconProofVerifier.sol`) reject `block_roots` 352 (depth 8) and `historical_summaries` 2950 (depth 11), so a Gloas
/// source chain needs a Solidity change. See [`is_gloas_block_roots_position`].
pub const GLOAS_STATE_LAYOUT: StateLayout = StateLayout {
    finalized_root_gindex: FINALIZED_ROOT_GINDEX_GLOAS,
    current_sync_committee_gindex: CURRENT_SYNC_COMMITTEE_GINDEX_GLOAS,
    next_sync_committee_gindex: NEXT_SYNC_COMMITTEE_GINDEX_GLOAS,
    block_roots_gindex: BLOCK_ROOTS_GINDEX_GLOAS,
    historical_summaries_gindex: HISTORICAL_SUMMARIES_GINDEX_GLOAS,
};

/// Whether `gindex` is the position of `block_roots` in the Gloas `BeaconState` (352).
///
/// The deployed Solidity rule (`_isStateFieldPosition`) REJECTS this position: it accepts depths 5 to 7 only, and 352 has
/// depth 8. A bridge that must accept a Gloas source chain needs a Solidity change in `BeaconProofVerifier` and
/// `BeaconForkGate`. [`is_block_roots_position`] keeps the Solidity rule and returns false for 352.
pub fn is_gloas_block_roots_position(gindex: u64) -> bool {
    gindex == BLOCK_ROOTS_GINDEX_GLOAS
}

/// Whether `gindex` is the position of `historical_summaries` in the Gloas `BeaconState` (2950). The deployed Solidity
/// rule rejects it (depth 11). See [`is_gloas_block_roots_position`].
pub fn is_gloas_historical_summaries_position(gindex: u64) -> bool {
    gindex == HISTORICAL_SUMMARIES_GINDEX_GLOAS
}

/// Whether `gindex` is the position of the execution block hash in the Gloas `BeaconBlockBody` (2856, through the bid).
/// The deployed Solidity rule (`_isBlockHashPosition`) accepts 412, 668, 812 and 1324 only, so it rejects 2856.
pub fn is_gloas_block_hash_position(gindex: u64) -> bool {
    gindex == BLOCK_HASH_GINDEX_GLOAS
}

/// The generalized index that proves the execution block hash of a light-client header in the COMPACT form
/// (`execution_block_hash` plus `execution_branch`), chosen by the fork at the slot of the header itself.
///
/// This is `is_valid_light_client_header` of `specs/gloas/light-client/sync-protocol.md`: Gloas 2856, Deneb to Fulu 812,
/// Capella 412.
///
/// # Errors
/// `UnsupportedFork` before Capella. The specification accepts a zero hash with an empty branch there, but the bridge
/// needs a non-zero execution block hash, so it refuses these headers.
pub fn compact_block_hash_gindex_for_fork(fork: ForkName) -> Result<u64> {
    match fork {
        ForkName::Gloas => Ok(BLOCK_HASH_GINDEX_GLOAS),
        ForkName::Deneb | ForkName::Electra | ForkName::Fulu => Ok(BLOCK_HASH_GINDEX_DENEB),
        ForkName::Capella => Ok(BLOCK_HASH_GINDEX_CAPELLA),
        ForkName::Phase0 | ForkName::Altair | ForkName::Bellatrix => Err(Error::UnsupportedFork { fork }),
    }
}

/// Whether `gindex` is field `field_index` of a `BeaconState` tree of an accepted depth: `2^depth + field_index`.
///
/// This is the one rule for `block_roots` and `historical_summaries` positions. It mirrors `_isStateFieldPosition` in
/// `BeaconProofVerifier.sol`. The accepted positions of `block_roots` are 37, 69 and 133, and of `historical_summaries` 59, 91 and
/// 155. Only 37, 69, 59 and 91 exist in a layout of today.
pub fn is_state_field_position(gindex: u64, field_index: u64) -> bool {
    if gindex == 0 {
        return false;
    }
    let depth = gindex_depth(gindex);
    if !STATE_DEPTHS.contains(&depth) {
        return false;
    }
    gindex == (1u64 << depth) + field_index
}

/// Whether `gindex` is the position of `block_roots` in a state of an accepted depth (37, 69 or 133).
pub fn is_block_roots_position(gindex: u64) -> bool {
    is_state_field_position(gindex, BLOCK_ROOTS_FIELD_INDEX)
}

/// Whether `gindex` is the position of `historical_summaries` in a state of an accepted depth (59, 91 or 155).
pub fn is_historical_summaries_position(gindex: u64) -> bool {
    is_state_field_position(gindex, HISTORICAL_SUMMARIES_FIELD_INDEX)
}

/// Whether `gindex` is the position of `execution_payload.block_hash` in a body and a payload of accepted depths:
/// `(2^body_depth + 9) * 2^payload_depth + 12`. These are 412, 668, 812 and 1324. It mirrors `_isBlockHashPosition` in
/// `BeaconProofVerifier.sol`. Only 412 (Capella) and 812 (Deneb and later) exist in a layout of today.
pub fn is_block_hash_position(gindex: u64) -> bool {
    BODY_DEPTHS.clone().any(|body_depth| {
        let payload_field = (1u64 << body_depth) + EXECUTION_PAYLOAD_FIELD_INDEX;
        PAYLOAD_DEPTHS.clone().any(|payload_depth| gindex == (payload_field << payload_depth) + BLOCK_HASH_FIELD_INDEX)
    })
}

/// Selects the `execution_payload.block_hash` generalized index for a fork.
///
/// # Errors
/// `UnsupportedFork` for forks without a supported layout.
pub fn block_hash_gindex_for_fork(fork: ForkName) -> Result<u64> {
    match execution_header_form_for_fork(fork)? {
        ExecutionHeaderForm::Capella => Ok(BLOCK_HASH_GINDEX_CAPELLA),
        ExecutionHeaderForm::Deneb => Ok(BLOCK_HASH_GINDEX_DENEB),
    }
}

/// Which field list the `ExecutionPayloadHeader` has.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ExecutionHeaderForm {
    /// 15 fields, no blob fields.
    Capella,
    /// 17 fields: adds `blob_gas_used` and `excess_blob_gas`. Electra and later keep this form.
    Deneb,
}

/// Selects the beacon state layout for a fork.
///
/// Altair and Bellatrix headers carry no execution payload, so a bridge cannot use them.
/// Gloas has its own progressive layout ([`GLOAS_STATE_LAYOUT`]). Its `block_roots` and `historical_summaries` positions
/// fail the position rules of the deployed Solidity, so the message ancestry code refuses Gloas anchors.
///
/// # Errors
/// `UnsupportedFork` for Phase0, Altair and Bellatrix.
pub fn state_layout_for_fork(fork: ForkName) -> Result<StateLayout> {
    match fork {
        ForkName::Capella | ForkName::Deneb => Ok(CAPELLA_DENEB_STATE_LAYOUT),
        ForkName::Electra | ForkName::Fulu => Ok(ELECTRA_STATE_LAYOUT),
        ForkName::Gloas => Ok(GLOAS_STATE_LAYOUT),
        ForkName::Phase0 | ForkName::Altair | ForkName::Bellatrix => Err(Error::UnsupportedFork { fork }),
    }
}

/// Selects the execution payload header form for a fork.
///
/// Gloas has no execution payload header. Its light-client headers use the compact form
/// ([`compact_block_hash_gindex_for_fork`]), so this function refuses Gloas.
///
/// # Errors
/// `UnsupportedFork` for forks without a payload header: before Capella, and Gloas.
pub fn execution_header_form_for_fork(fork: ForkName) -> Result<ExecutionHeaderForm> {
    match fork {
        ForkName::Capella => Ok(ExecutionHeaderForm::Capella),
        ForkName::Deneb | ForkName::Electra | ForkName::Fulu => Ok(ExecutionHeaderForm::Deneb),
        ForkName::Phase0 | ForkName::Altair | ForkName::Bellatrix | ForkName::Gloas => {
            Err(Error::UnsupportedFork { fork })
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Claim: the branch depths are 6/5/5 for Capella and 7/6/6 for Electra, as the real update lengths show
    /// (the live Ethereum update has a 7 entry finality branch and a 6 entry committee branch).
    #[test]
    fn depths_match_the_published_branch_lengths() {
        assert_eq!(gindex_depth(CAPELLA_DENEB_STATE_LAYOUT.finalized_root_gindex), 6);
        assert_eq!(gindex_depth(CAPELLA_DENEB_STATE_LAYOUT.current_sync_committee_gindex), 5);
        assert_eq!(gindex_depth(ELECTRA_STATE_LAYOUT.finalized_root_gindex), 7);
        assert_eq!(gindex_depth(ELECTRA_STATE_LAYOUT.next_sync_committee_gindex), 6);
        assert_eq!(gindex_depth(EXECUTION_PAYLOAD_GINDEX), 4);
    }

    /// Claim: the combined block hash indices are 412 (depth 8) and 812 (depth 9).
    #[test]
    fn block_hash_indices() {
        assert_eq!(BLOCK_HASH_GINDEX_CAPELLA, 412);
        assert_eq!(BLOCK_HASH_GINDEX_DENEB, 812);
        assert_eq!(gindex_depth(412), 8);
        assert_eq!(gindex_depth(812), 9);
        assert_eq!(block_hash_gindex_for_fork(ForkName::Electra), Ok(812));
    }

    /// Claim: `historical_summaries` is field 27, so its index is 59 in the 28 field layouts (depth 5) and 91 in the
    /// 37 and 38 field layouts (depth 6). The numbers are counted by hand from the container field lists in
    /// consensus-specs (see the constant). A wrong index would send every historical proof to the wrong node.
    #[test]
    fn historical_summaries_indices() {
        assert_eq!(CAPELLA_DENEB_STATE_LAYOUT.historical_summaries_gindex, 59);
        assert_eq!(ELECTRA_STATE_LAYOUT.historical_summaries_gindex, 91);
        assert_eq!(gindex_depth(59), 5);
        assert_eq!(gindex_depth(91), 6);
        assert_eq!(HISTORICAL_SUMMARIES_LIST_DEPTH, 24);
    }

    /// Claim: Deneb and Capella share state indices, Electra differs. Mixing them up is the "wrong fork" attack.
    #[test]
    fn electra_differs_from_deneb() {
        assert_eq!(state_layout_for_fork(ForkName::Capella), state_layout_for_fork(ForkName::Deneb));
        assert_ne!(state_layout_for_fork(ForkName::Deneb), state_layout_for_fork(ForkName::Electra));
        assert_eq!(state_layout_for_fork(ForkName::Fulu), state_layout_for_fork(ForkName::Electra));
    }

    /// Claim: forks without execution payloads or with an unknown layout are refused.
    #[test]
    fn unsupported_forks_are_refused() {
        // Gloas left this list on purpose: it has a layout now (see the Gloas tests below). It still has no payload header.
        for fork in [ForkName::Phase0, ForkName::Altair, ForkName::Bellatrix] {
            assert_eq!(state_layout_for_fork(fork), Err(Error::UnsupportedFork { fork }));
        }
        for fork in [ForkName::Phase0, ForkName::Altair, ForkName::Bellatrix, ForkName::Gloas] {
            assert_eq!(execution_header_form_for_fork(fork), Err(Error::UnsupportedFork { fork }));
        }
    }

    /// Claim: the position rule accepts exactly the bridge's set. `block_roots` is 37, 69 or 133, `historical_summaries` is
    /// 59, 91 or 155, and the block hash is 412, 668, 812 or 1324, each written out by hand from the field index and the
    /// depth. The neighbour on each side of every accepted position is refused.
    /// Why it matters: the bridge accepts these positions and no others. A light client that knew fewer would refuse a
    /// layout the bridge accepts, and one that knew more would accept a layout the bridge refuses.
    #[test]
    fn position_rule_matches_the_bridge() {
        for position in [37, 69, 133] {
            assert!(is_block_roots_position(position));
            assert!(!is_block_roots_position(position - 1), "{position}: the field before");
            assert!(!is_block_roots_position(position + 1), "{position}: the field after");
        }
        for position in [59, 91, 155] {
            assert!(is_historical_summaries_position(position));
            assert!(!is_historical_summaries_position(position - 1), "{position}: the field before");
            assert!(!is_historical_summaries_position(position + 1), "{position}: the field after");
        }
        for position in [412, 668, 812, 1324] {
            assert!(is_block_hash_position(position));
            assert!(!is_block_hash_position(position - 1), "{position}: the field before");
            assert!(!is_block_hash_position(position + 1), "{position}: the field after");
        }
    }

    /// Claim: the accepted positions of one field never double as another field's, and the depths outside the allowed
    /// range are refused. Depth 4 (21), depth 8 (261 and 283) and the root are refused, as are a body of depth 3 (284)
    /// and a body of depth 6 (2348).
    /// Why it matters: the depth bounds are half of the rule, and an off-by-one in a bound shows only at the edge.
    #[test]
    fn position_rule_refuses_depths_outside_the_range() {
        assert!(!is_block_roots_position(21));
        assert!(!is_block_roots_position(261));
        assert!(!is_historical_summaries_position(283));
        assert!(!is_block_roots_position(0) && !is_block_roots_position(1));
        assert!(!is_block_hash_position(0));
        // Body depth 3 with payload depth 4: (8 + 9) * 16 + 12. Body depth 6 with payload depth 5: (64 + 9) * 32 + 12.
        assert!(!is_block_hash_position(284));
        assert!(!is_block_hash_position(2348));
        assert!(!is_block_roots_position(59) && !is_historical_summaries_position(37));
    }

    /// Claim: every position in today's layout tables obeys the rule. Why it matters: the table and the rule must not
    /// drift apart, because the bridge accepts only positions that obey the rule.
    #[test]
    fn todays_layouts_obey_the_rule() {
        for layout in [CAPELLA_DENEB_STATE_LAYOUT, ELECTRA_STATE_LAYOUT] {
            assert!(is_block_roots_position(layout.block_roots_gindex));
            assert!(is_historical_summaries_position(layout.historical_summaries_gindex));
        }
        assert!(is_block_hash_position(BLOCK_HASH_GINDEX_CAPELLA));
        assert!(is_block_hash_position(BLOCK_HASH_GINDEX_DENEB));
    }

    /// Claim: every Gloas index DERIVES from the field lists, and the derived values equal the constants of the
    /// specification (735, 2945, 2946, 2856). The control: a reordered field list gives another number, so the derivation
    /// depends on the names.
    #[test]
    fn gloas_indices_derive_from_the_field_lists() {
        let state = &BEACON_STATE_GLOAS;
        assert_eq!(state.fields.len(), 46);
        assert_eq!(state.shape, ContainerShape::Progressive { width: 46 });
        assert_eq!(state.field_position("finalized_checkpoint"), Some(20));
        assert_eq!(state.field_position("current_sync_committee"), Some(22));
        assert_eq!(state.field_position("next_sync_committee"), Some(23));
        assert_eq!(state.field_position("block_roots"), Some(5));
        assert_eq!(state.field_position("historical_summaries"), Some(27));

        let finalized_root = path_gindex(&[(state, "finalized_checkpoint"), (&CHECKPOINT, "root")]);
        assert_eq!(finalized_root, Some(735));
        assert_eq!(finalized_root, Some(FINALIZED_ROOT_GINDEX_GLOAS));
        assert_eq!(path_gindex(&[(state, "current_sync_committee")]), Some(2945));
        assert_eq!(path_gindex(&[(state, "next_sync_committee")]), Some(2946));
        assert_eq!(path_gindex(&[(state, "block_roots")]), Some(352));
        assert_eq!(path_gindex(&[(state, "historical_summaries")]), Some(2950));
        assert_eq!(2945, CURRENT_SYNC_COMMITTEE_GINDEX_GLOAS);
        assert_eq!(2946, NEXT_SYNC_COMMITTEE_GINDEX_GLOAS);
        assert_eq!(352, BLOCK_ROOTS_GINDEX_GLOAS);
        assert_eq!(2950, HISTORICAL_SUMMARIES_GINDEX_GLOAS);

        let body = &BEACON_BLOCK_BODY_GLOAS;
        assert_eq!(body.fields.len(), 13);
        assert_eq!(body.field_position("signed_execution_payload_bid"), Some(10));
        let block_hash = path_gindex(&[
            (body, "signed_execution_payload_bid"),
            (&SIGNED_EXECUTION_PAYLOAD_BID, "message"),
            (&EXECUTION_PAYLOAD_BID, "parent_block_hash"),
        ]);
        assert_eq!(block_hash, Some(2856));
        assert_eq!(block_hash, Some(BLOCK_HASH_GINDEX_GLOAS));
        assert_eq!(EXECUTION_PAYLOAD_BID.fields.len(), 12);
        assert_eq!(EXECUTION_PAYLOAD_BID.field_position("parent_block_hash"), Some(0));

        assert_eq!(GLOAS_STATE_LAYOUT, state_layout_for_fork(ForkName::Gloas).unwrap());
        let mut shuffled = BEACON_STATE_GLOAS.fields.to_vec();
        shuffled.swap(20, 21);
        let moved = ContainerDefinition { fields: Box::leak(shuffled.into_boxed_slice()), ..BEACON_STATE_GLOAS };
        assert_ne!(path_gindex(&[(&moved, "finalized_checkpoint"), (&CHECKPOINT, "root")]), Some(735));
    }

    /// Claim: the subtree boundaries of a progressive tree sit where the text of `eip-7916.md` puts them. Chunk 0 is node 4,
    /// chunks 1 to 4 are nodes 40 to 43, chunks 5 to 20 are 352 to 367 and chunks 21 to 84 are 2944 to 3007 (counted by
    /// hand: node 2 is the progressive root; 4 = 2 * 2; the rest nodes are 5, 11, 23, 47; the left children are 10, 22, 46).
    #[test]
    fn progressive_subtree_boundaries() {
        let at = |chunk| progressive_chunk_gindex(2, chunk).unwrap();
        assert_eq!(at(0), 4);
        assert_eq!((at(1), at(4)), (40, 43));
        assert_eq!((at(5), at(20)), (352, 367));
        assert_eq!((at(21), at(84)), (2944, 3007));
        assert_eq!(at(85), 47 * 2 * 256);
    }

    /// Claim: the branch depths match the length of the real Sepolia data: finality 9, committees 11, execution 11. A
    /// real finality update of Sepolia (Gloas) has a finality branch of 9 entries and an execution branch of 11.
    #[test]
    fn gloas_branch_depths() {
        assert_eq!(gindex_depth(FINALIZED_ROOT_GINDEX_GLOAS), 9);
        assert_eq!(gindex_depth(CURRENT_SYNC_COMMITTEE_GINDEX_GLOAS), 11);
        assert_eq!(gindex_depth(NEXT_SYNC_COMMITTEE_GINDEX_GLOAS), 11);
        assert_eq!(gindex_depth(BLOCK_HASH_GINDEX_GLOAS), 11);
        assert_eq!(gindex_depth(BLOCK_ROOTS_GINDEX_GLOAS), 8);
        assert_eq!(gindex_depth(HISTORICAL_SUMMARIES_GINDEX_GLOAS), 11);
    }

    /// Claim: the deployed Solidity position rules reject every Gloas position, and the separate Gloas rules accept exactly
    /// these and no neighbour. This is the finding for the owner: a Gloas source chain needs a Solidity change.
    #[test]
    fn solidity_rules_reject_gloas_positions() {
        assert!(!is_block_roots_position(352));
        assert!(!is_historical_summaries_position(2950));
        assert!(!is_block_hash_position(2856));
        assert!(is_gloas_block_roots_position(352) && !is_gloas_block_roots_position(353));
        assert!(is_gloas_historical_summaries_position(2950) && !is_gloas_historical_summaries_position(2949));
        assert!(is_gloas_block_hash_position(2856) && !is_gloas_block_hash_position(2857));
    }

    /// Claim: the compact header index follows the fork of the header slot: 412, 812 (Deneb, Electra, Fulu), 2856; before
    /// Capella it is refused.
    #[test]
    fn compact_block_hash_index_follows_the_fork() {
        assert_eq!(compact_block_hash_gindex_for_fork(ForkName::Capella), Ok(412));
        for fork in [ForkName::Deneb, ForkName::Electra, ForkName::Fulu] {
            assert_eq!(compact_block_hash_gindex_for_fork(fork), Ok(812));
        }
        assert_eq!(compact_block_hash_gindex_for_fork(ForkName::Gloas), Ok(2856));
        assert_eq!(
            compact_block_hash_gindex_for_fork(ForkName::Bellatrix),
            Err(Error::UnsupportedFork { fork: ForkName::Bellatrix })
        );
    }

    /// Claim: the `fork` field of the Gloas state is chunk 3, and `fork.current_version` is node 169, which the gate would
    /// have to check with a progressive rule. The deployed gate computes `(2^depth + 3) * 4 + 1`, which is 105 at depth 5
    /// and 217 at depth 6 and 441 at depth 7: none of them is 169.
    #[test]
    fn gloas_fork_version_index_differs_from_the_gate_rule() {
        let fork_container = ContainerDefinition {
            name: "Fork",
            source: "specs/phase0/beacon-chain.md, Fork",
            shape: ContainerShape::Plain,
            fields: &["previous_version", "current_version", "epoch"],
        };
        let derived = path_gindex(&[(&BEACON_STATE_GLOAS, "fork"), (&fork_container, "current_version")]);
        assert_eq!(derived, Some(169));
        for depth in 5..=7u32 {
            assert_ne!(((1u64 << depth) + 3) * 4 + 1, 169);
        }
    }
}
