//! Where beacon data comes from: a standard beacon node, read by [`http::HttpBeaconSource`].
//!
//! The source answers three questions. What update folds the light client from its stored head to the newest final
//! header of the source chain. What the beacon part of a message proof looks like. What evidence the destination bridge
//! needs for its layout rows.

pub mod branch_store;
pub mod http;
pub mod state_store;

use crate::light_client::{BeaconHeader, UpdateInput};
use alloy_primitives::B256;

/// A source block, as the source chain reports it.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct SourceBlock {
    /// The block number.
    pub number: u64,
    /// The block hash.
    pub hash: B256,
    /// The block timestamp. On a beacon chain it fixes the slot.
    pub timestamp: u64,
}

/// The head that a light client stores: where an update starts, or which header anchors a message proof.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct StoredHead {
    /// The slot of the head.
    pub slot: u64,
    /// The header root stored for the head.
    pub root: B256,
    /// The committee hash stored for the period after the head, or zero when the light client holds none. An update
    /// from this head must carry the next committee exactly when this hash is not zero.
    pub next_committee_hash: B256,
}

/// A fold that moves a light client from its stored head toward the newest final header.
#[derive(Clone, Debug)]
pub struct UpdatePlan {
    /// The store and the updates that the light-client program reads. The updates number 1 to 64.
    pub input: UpdateInput,
    /// The slot of the newest final header that the beacon node reported. The fold ends there unless the head lags by
    /// more than one fold can cover. Then the new head is lower, and a second run continues.
    pub latest_finalized_slot: u64,
}

/// Evidence for `MessageBridge.addBlockRootsLayout`.
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

/// Evidence for `MessageBridge.addBlockHashLayout`.
#[derive(Clone, Debug)]
pub struct HashEvidence {
    /// The candidate generalized index of `execution_payload.block_hash`.
    pub gindex: u64,
    /// A stored header.
    pub header: BeaconHeader,
    /// Branch from the stored execution block hash to the body root of the header.
    pub branch: Vec<B256>,
}

/// Evidence for `MessageBridge.addHistoricalSummariesLayout`.
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
