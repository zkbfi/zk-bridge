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
    /// `get_generalized_index(BeaconState, "genesis_validators_root")`: the layout witness. Field 1 in every layout.
    ///
    /// A plain state of depth `d` puts it at `2^d + 1` (33, 65, 129 for `d` = 5, 6, 7). The Gloas progressive state puts
    /// it at node 40. The program checks a branch of this field against the attested state root, with the chain's own
    /// `genesis_validators_root` as the leaf. A state of another shape cannot match, because a node at this position is
    /// then a different field, padding, or a hash that is not that root (see `docs/hardened-build-contract.md`).
    pub witness_gindex: u64,
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

/// The layout of a plain `BeaconState` tree of `depth`, computed from the field indices and not copied.
///
/// A plain container pads its fields to `2^depth` leaves, so field `n` has the index `2^depth + n`. Source of the field
/// indices: `finalized_checkpoint` 20, `current_sync_committee` 22, `next_sync_committee` 23, `block_roots` 5 and
/// `historical_summaries` 27 (`specs/phase0/beacon-chain.md`, `specs/altair/beacon-chain.md` and
/// `specs/capella/beacon-chain.md`). `root` is field 1 of `Checkpoint`, so the finalized root is `(2^depth + 20) * 2 + 1`.
/// Depth 5 gives 105, 54, 55 and depth 6 gives 169, 86, 87, the constants of the light-client specifications.
pub const fn plain_state_layout(depth: u32) -> StateLayout {
    let first_field = 1u64 << depth;
    StateLayout {
        finalized_root_gindex: (first_field + STATE_FIELD_FINALIZED_CHECKPOINT) * 2 + 1,
        current_sync_committee_gindex: first_field + STATE_FIELD_CURRENT_SYNC_COMMITTEE,
        next_sync_committee_gindex: first_field + STATE_FIELD_NEXT_SYNC_COMMITTEE,
        block_roots_gindex: first_field + BLOCK_ROOTS_FIELD_INDEX,
        historical_summaries_gindex: first_field + HISTORICAL_SUMMARIES_FIELD_INDEX,
        witness_gindex: first_field + STATE_FIELD_GENESIS_VALIDATORS_ROOT,
    }
}

/// Position of `genesis_validators_root` among the `BeaconState` fields in every fork, plain and progressive.
pub const STATE_FIELD_GENESIS_VALIDATORS_ROOT: u64 = 1;

/// Position of `fork` among the `BeaconState` fields in every fork, plain and progressive.
pub const STATE_FIELD_FORK: u64 = 3;

/// Position of `current_version` among the `Fork` fields (`previous_version`, `current_version`, `epoch`).
pub const FORK_FIELD_CURRENT_VERSION: u64 = 1;

/// `Fork` is a plain container of three fields, so its tree has four leaves: depth 2.
const FORK_TREE_DEPTH: u32 = 2;

/// The generalized index of `fork.current_version` in a plain `BeaconState` of `depth`: `((2^depth + 3) * 4) + 1`.
///
/// Depth 5 gives 141, depth 6 gives 269 and depth 7 gives 525. The branch has `depth + 2` entries.
pub const fn plain_current_version_gindex(depth: u32) -> u64 {
    (((1u64 << depth) + STATE_FIELD_FORK) << FORK_TREE_DEPTH) + FORK_FIELD_CURRENT_VERSION
}

/// Position of `finalized_checkpoint` among the `BeaconState` fields in every plain layout.
const STATE_FIELD_FINALIZED_CHECKPOINT: u64 = 20;

/// Position of `current_sync_committee` among the `BeaconState` fields in every plain layout.
const STATE_FIELD_CURRENT_SYNC_COMMITTEE: u64 = 22;

/// Position of `next_sync_committee` among the `BeaconState` fields in every plain layout.
const STATE_FIELD_NEXT_SYNC_COMMITTEE: u64 = 23;

/// Layout of the Capella and Deneb `BeaconState` (28 fields, tree depth 5).
///
/// Source: `specs/altair/light-client/sync-protocol.md` "Constants": 105, 54, 55.
/// `block_roots` is field 5, so its index is 32 + 5 = 37 (the field order is in `specs/phase0/beacon-chain.md`,
/// container `BeaconState`).
pub const CAPELLA_DENEB_STATE_LAYOUT: StateLayout = plain_state_layout(5);

/// Layout of the Electra and Fulu `BeaconState` (more than 32 fields, tree depth 6).
///
/// Source: `specs/electra/light-client/sync-protocol.md` "Constants": 169, 86, 87.
/// `block_roots` is field 5, so its index is 64 + 5 = 69.
pub const ELECTRA_STATE_LAYOUT: StateLayout = plain_state_layout(6);

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

/// `Fork`: `previous_version`, `current_version`, `epoch`. Source: `specs/phase0/beacon-chain.md`, section "Fork".
pub const FORK: ContainerDefinition = ContainerDefinition {
    name: "Fork",
    source: "specs/phase0/beacon-chain.md, Fork",
    shape: ContainerShape::Plain,
    fields: &["previous_version", "current_version", "epoch"],
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

/// `get_generalized_index(BeaconState, "genesis_validators_root")` in Gloas = 40. Derived from the field list, not copied:
/// chunk 1 is the first leaf of the 4 leaf subtree at node 20 (leaves 40 to 43), so the node is 40 and the branch has 5
/// entries (two inside the subtree, then the rest nodes up to the progressive root and `active_fields`).
pub const WITNESS_GINDEX_GLOAS: u64 = 40;

/// `get_generalized_index(BeaconState, "fork", "current_version")` in Gloas = 169. `fork` is chunk 3, the second leaf of the
/// 4 leaf subtree at node 10 under the rest node 5: node 42. `Fork` has three fields, so it is a plain container of depth 2,
/// and `current_version` (field 1) is node 42 * 4 + 1. The branch has 7 entries. `BeaconForkGate` checks it for a route whose
/// fork version is Gloas.
pub const FORK_VERSION_GINDEX_GLOAS: u64 = 169;

/// `get_generalized_index(BeaconState, "latest_block_hash")` in Gloas = 2947, derived like [`BLOCK_ROOTS_GINDEX_GLOAS`]:
/// `latest_block_hash` is field 24 of the state, chunk 24 is leaf 2944 + 3 of the 64 leaf subtree at node 46. Depth 11.
///
/// This is the anchor of the execution block of a finalized Gloas head. The state transition writes the field in
/// `process_parent_execution_payload` (`specs/gloas/beacon-chain.md`, function `apply_parent_execution_payload`): when the
/// block builds on a FULL parent, `state.latest_block_hash = parent_bid.block_hash`. A block that builds on an EMPTY parent
/// leaves it alone. So in the post-state of a finalized block the field names the newest execution payload that a
/// beacon block of the finalized chain confirmed. That payload sits in finalized history, one slot or more before the
/// finalized slot. It is never the payload of the finalized slot itself: that payload is confirmed by a later block.
pub const LATEST_BLOCK_HASH_GINDEX_GLOAS: u64 = 2947;

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
/// The positions are NOT of the form `2^depth + field_index`. `BeaconProofVerifier` accepts `block_roots` 352 (depth 8)
/// and `historical_summaries` 2950 (depth 11) as two fixed positions next to the depth rule. See
/// [`is_gloas_block_roots_position`].
pub const GLOAS_STATE_LAYOUT: StateLayout = StateLayout {
    finalized_root_gindex: FINALIZED_ROOT_GINDEX_GLOAS,
    current_sync_committee_gindex: CURRENT_SYNC_COMMITTEE_GINDEX_GLOAS,
    next_sync_committee_gindex: NEXT_SYNC_COMMITTEE_GINDEX_GLOAS,
    block_roots_gindex: BLOCK_ROOTS_GINDEX_GLOAS,
    historical_summaries_gindex: HISTORICAL_SUMMARIES_GINDEX_GLOAS,
    witness_gindex: WITNESS_GINDEX_GLOAS,
};

/// Whether `gindex` is the position of `block_roots` in the Gloas `BeaconState` (352). A progressive container fixes the
/// position of each field for good, so the position is one number and not a depth rule.
pub fn is_gloas_block_roots_position(gindex: u64) -> bool {
    gindex == BLOCK_ROOTS_GINDEX_GLOAS
}

/// Whether `gindex` is the position of `historical_summaries` in the Gloas `BeaconState` (2950).
pub fn is_gloas_historical_summaries_position(gindex: u64) -> bool {
    gindex == HISTORICAL_SUMMARIES_GINDEX_GLOAS
}

/// Whether `gindex` is the position of the execution block hash in the Gloas `BeaconBlockBody` (2856, through the bid).
///
/// It is not a layout position: [`is_block_hash_position`] rejects it, so `addBlockHashLayout` stays closed to Gloas. A
/// message proof reads it through [`message_block_hash_gindex_for_fork`], as the fixed rule of a source header at or after
/// the Gloas fork.
pub fn is_gloas_block_hash_position(gindex: u64) -> bool {
    gindex == BLOCK_HASH_GINDEX_GLOAS
}

/// Which root a compact header branch leads to.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum CompactAnchorRoot {
    /// The body root of the beacon header: Capella to Fulu.
    Body,
    /// The state root of the beacon header: Gloas, where `state.latest_block_hash` is the anchor.
    State,
}

/// Where the branch of a compact header leads: a generalized index and the root it must reach.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct CompactAnchor {
    /// The generalized index of the execution block hash.
    pub gindex: u64,
    /// The root of the beacon header that the branch must reach.
    pub root: CompactAnchorRoot,
}

/// The branch lengths of the state proofs that the programs accept, and the layout of each.
///
/// The length of the finality branch is the depth of the generalized index, so it names the layout. Length 6 is a plain
/// state of depth 5 (indices 105, 54, 55), length 7 a plain state of depth 6 (169, 86, 87), length 8 a plain state of
/// depth 7 (297, 150, 151), length 9 the Gloas progressive state (735, 2945, 2946). Every other length is refused.
///
/// Depth 7 is allowed because the layout witness ([`StateLayout::witness_gindex`]) proves the claimed shape: on a chain
/// that is truly of another depth, the witness lands on a node that cannot hold the genesis validators root.
pub const ALLOWED_FINALITY_BRANCH_LENGTHS: [usize; 4] = [6, 7, 8, 9];

/// The layout of a plain `BeaconState` of depth 7 (more than 64 fields): finality 297, committees 150 and 151, witness 129.
pub const DEPTH_SEVEN_STATE_LAYOUT: StateLayout = plain_state_layout(7);

/// The state layout that a finality branch of `length` entries names.
///
/// # Errors
/// `UnsupportedStateBranchLength` for every length other than 6, 7, 8 and 9.
pub fn state_layout_for_finality_branch_length(length: usize) -> Result<StateLayout> {
    match length {
        6 => Ok(CAPELLA_DENEB_STATE_LAYOUT),
        7 => Ok(ELECTRA_STATE_LAYOUT),
        8 => Ok(DEPTH_SEVEN_STATE_LAYOUT),
        9 => Ok(GLOAS_STATE_LAYOUT),
        _ => Err(Error::UnsupportedStateBranchLength { length }),
    }
}

/// The shape value that the fork observation reports for a plain `BeaconState` of depth 5.
pub const SHAPE_PLAIN_DEPTH_FIVE: u8 = 5;

/// The shape value for a plain `BeaconState` of depth 6.
pub const SHAPE_PLAIN_DEPTH_SIX: u8 = 6;

/// The shape value for a plain `BeaconState` of depth 7.
pub const SHAPE_PLAIN_DEPTH_SEVEN: u8 = 7;

/// The shape value for the Gloas progressive `BeaconState`. It is 255 and not a depth, so no plain depth can collide with it.
pub const SHAPE_PROGRESSIVE: u8 = 255;

/// One state shape that a fork observation may prove: its reported value, and the two positions that the proofs use.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct ObservedShape {
    /// The value in the output: 5, 6, 7 or 255 ([`SHAPE_PROGRESSIVE`]).
    pub shape: u8,
    /// Where `fork.current_version` sits: 141, 269, 525 for plain depths 5, 6, 7 and 169 for the progressive form.
    pub current_version_gindex: u64,
    /// Where `genesis_validators_root` sits: 33, 65, 129 and 40 (the layout witness).
    pub witness_gindex: u64,
}

const fn plain_observed_shape(depth: u32) -> ObservedShape {
    ObservedShape {
        shape: depth as u8,
        current_version_gindex: plain_current_version_gindex(depth),
        witness_gindex: plain_state_layout(depth).witness_gindex,
    }
}

/// The plain depth 5 shape.
pub const OBSERVED_SHAPE_PLAIN_DEPTH_FIVE: ObservedShape = plain_observed_shape(5);

/// The plain depth 6 shape.
pub const OBSERVED_SHAPE_PLAIN_DEPTH_SIX: ObservedShape = plain_observed_shape(6);

/// The plain depth 7 shape.
pub const OBSERVED_SHAPE_PLAIN_DEPTH_SEVEN: ObservedShape = plain_observed_shape(7);

/// The Gloas progressive shape: `fork.current_version` at 169 and the witness at 40.
pub const OBSERVED_SHAPE_PROGRESSIVE: ObservedShape = ObservedShape {
    shape: SHAPE_PROGRESSIVE,
    current_version_gindex: FORK_VERSION_GINDEX_GLOAS,
    witness_gindex: WITNESS_GINDEX_GLOAS,
};

/// The shapes that a version branch of `length` entries may claim, in the order the program tries them.
///
/// The version branch has `depth + 2` entries in a plain state, so length 7 is plain depth 5 or the progressive form
/// (both reach depth 7), length 8 is plain depth 6 and length 9 is plain depth 7. The program takes the first candidate
/// for which BOTH the version branch and the witness branch verify. Any other length has no candidate.
pub fn observed_shape_candidates(length: usize) -> &'static [ObservedShape] {
    match length {
        7 => &[OBSERVED_SHAPE_PLAIN_DEPTH_FIVE, OBSERVED_SHAPE_PROGRESSIVE],
        8 => &[OBSERVED_SHAPE_PLAIN_DEPTH_SIX],
        9 => &[OBSERVED_SHAPE_PLAIN_DEPTH_SEVEN],
        _ => &[],
    }
}

/// The anchor that a compact header branch of `length` entries names, or `None` for a length that no layout has.
///
/// Length 8 is index 412 (Capella payload, depth 4) under the body root, length 9 is 812 (Deneb and later payload, depth
/// 5) under the body root, and length 11 is 2947 (`latest_block_hash`) under the STATE root. The body of every layout
/// has depth 4, so 41, 668 and 1324 have no length here. The keccak check of the header RLP in
/// `update::verify_finalized_execution` is mandatory: it is the only guard for 2947 on a Capella or Deneb state, and for
/// 412 on a Deneb payload.
pub fn compact_anchor_for_branch_length(length: usize) -> Option<CompactAnchor> {
    match length {
        8 => Some(CompactAnchor { gindex: BLOCK_HASH_GINDEX_CAPELLA, root: CompactAnchorRoot::Body }),
        9 => Some(CompactAnchor { gindex: BLOCK_HASH_GINDEX_DENEB, root: CompactAnchorRoot::Body }),
        11 => Some(CompactAnchor { gindex: LATEST_BLOCK_HASH_GINDEX_GLOAS, root: CompactAnchorRoot::State }),
        _ => None,
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

/// Whether `gindex` is the position of `block_roots` in a state of an accepted depth (37, 69 or 133), or the fixed Gloas
/// position 352. It mirrors `_isBlockRootsPosition` in `BeaconProofVerifier.sol`.
pub fn is_block_roots_position(gindex: u64) -> bool {
    is_state_field_position(gindex, BLOCK_ROOTS_FIELD_INDEX) || is_gloas_block_roots_position(gindex)
}

/// Whether `gindex` is the position of `historical_summaries` in a state of an accepted depth (59, 91 or 155), or the
/// fixed Gloas position 2950. It mirrors `_isHistoricalSummariesPosition` in `BeaconProofVerifier.sol`.
pub fn is_historical_summaries_position(gindex: u64) -> bool {
    is_state_field_position(gindex, HISTORICAL_SUMMARIES_FIELD_INDEX) || is_gloas_historical_summaries_position(gindex)
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
/// `UnsupportedFork` for forks without a supported layout. `GloasPayloadNotFinalized` for Gloas: the body of a Gloas block
/// holds a bid and no payload, and no rule binds a message proof to the payload of a Gloas source block yet.
pub fn block_hash_gindex_for_fork(fork: ForkName) -> Result<u64> {
    if fork >= ForkName::Gloas {
        return Err(Error::GloasPayloadNotFinalized);
    }
    match execution_header_form_for_fork(fork)? {
        ExecutionHeaderForm::Capella => Ok(BLOCK_HASH_GINDEX_CAPELLA),
        ExecutionHeaderForm::Deneb => Ok(BLOCK_HASH_GINDEX_DENEB),
    }
}

/// The index that proves the execution block of a MESSAGE source header, chosen by the fork of that header's slot.
///
/// Before Gloas it is `execution_payload.block_hash` of the body ([`block_hash_gindex_for_fork`]). From Gloas on it is
/// `signed_execution_payload_bid.message.parent_block_hash` ([`BLOCK_HASH_GINDEX_GLOAS`], 2856). The source header is then
/// a beacon block `B` that comes AFTER the block of the proven execution block `X`, not the block of `X`.
///
/// Why this is sound. `process_execution_payload_bid` asserts `bid.parent_block_hash == state.latest_block_hash`
/// (`specs/gloas/beacon-chain.md`). `state.latest_block_hash` is written only by `apply_parent_execution_payload`, from
/// the `block_hash` of a parent bid whose payload the child block confirmed (a FULL parent). So `parent_block_hash` of a
/// block on the canonical chain always names a payload that the canonical chain accepted. A block on an EMPTY parent
/// names an older accepted payload, which is also canonical. The bridge never accepts the bid's own `block_hash`: that
/// payload may be withheld. The block of `X` needs no slot in the proof: any ancestor of the stored head whose bid
/// names `X` as its parent proves `X`.
///
/// # Errors
/// `UnsupportedFork` for forks without a supported layout.
pub fn message_block_hash_gindex_for_fork(fork: ForkName) -> Result<u64> {
    match fork >= ForkName::Gloas {
        true => Ok(BLOCK_HASH_GINDEX_GLOAS),
        false => block_hash_gindex_for_fork(fork),
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
        // Gloas has its own refusal (`GloasPayloadNotFinalized`), tested in `gloas_indices_derive_from_the_field_lists`.
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
        for position in [37, 69, 133, 352] {
            assert!(is_block_roots_position(position));
            assert!(!is_block_roots_position(position - 1), "{position}: the field before");
            assert!(!is_block_roots_position(position + 1), "{position}: the field after");
        }
        for position in [59, 91, 155, 2950] {
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
    /// specification (735, 2945, 2946, 2856) and 2947 for `latest_block_hash` (field 24). The control: a reordered field list gives another number, so the derivation
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

        assert_eq!(state_layout_for_fork(ForkName::Gloas), Ok(GLOAS_STATE_LAYOUT));
        assert_eq!(state.field_position("latest_block_hash"), Some(24));
        assert_eq!(path_gindex(&[(state, "latest_block_hash")]), Some(2947));
        assert_eq!(2947, LATEST_BLOCK_HASH_GINDEX_GLOAS);
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
        assert_eq!(gindex_depth(LATEST_BLOCK_HASH_GINDEX_GLOAS), 11);
        assert_eq!(gindex_depth(BLOCK_ROOTS_GINDEX_GLOAS), 8);
        assert_eq!(gindex_depth(HISTORICAL_SUMMARIES_GINDEX_GLOAS), 11);
    }

    /// Claim: the position rules accept the two Gloas state positions (352 and 2950) and no neighbour, and still refuse the
    /// Gloas block hash position 2856. The refusal is on purpose: a message proof from a Gloas source block has no sound
    /// binding to its payload yet.
    #[test]
    fn position_rules_take_gloas_state_positions_and_refuse_the_gloas_block_hash() {
        assert!(is_block_roots_position(352) && !is_block_roots_position(351) && !is_block_roots_position(353));
        assert!(
            is_historical_summaries_position(2950)
                && !is_historical_summaries_position(2949)
                && !is_historical_summaries_position(2951)
        );
        assert!(!is_block_hash_position(2856));
        assert!(!is_block_roots_position(2950) && !is_historical_summaries_position(352));
        assert!(is_gloas_block_roots_position(352) && !is_gloas_block_roots_position(353));
        assert!(is_gloas_historical_summaries_position(2950) && !is_gloas_historical_summaries_position(2949));
        assert!(is_gloas_block_hash_position(2856) && !is_gloas_block_hash_position(2857));
    }

    /// Claim: the plain layouts are computed from the depth and equal the constants of the light-client specifications,
    /// written here as literals: depth 5 gives 105, 54, 55 and depth 6 gives 169, 86, 87. Depth 7 gives 297, 150, 151 (the
    /// layout that length 8 names).
    /// Why it matters: the program derives the indices from the depth, so a wrong formula would move every proof.
    #[test]
    fn plain_layouts_come_from_the_depth() {
        let depth_five = plain_state_layout(5);
        assert_eq!(
            (
                depth_five.finalized_root_gindex,
                depth_five.current_sync_committee_gindex,
                depth_five.next_sync_committee_gindex
            ),
            (105, 54, 55)
        );
        let depth_six = plain_state_layout(6);
        assert_eq!(
            (
                depth_six.finalized_root_gindex,
                depth_six.current_sync_committee_gindex,
                depth_six.next_sync_committee_gindex
            ),
            (169, 86, 87)
        );
        let depth_seven = plain_state_layout(7);
        assert_eq!(
            (
                depth_seven.finalized_root_gindex,
                depth_seven.current_sync_committee_gindex,
                depth_seven.next_sync_committee_gindex
            ),
            (297, 150, 151)
        );
        assert_eq!(CAPELLA_DENEB_STATE_LAYOUT, depth_five);
        assert_eq!(ELECTRA_STATE_LAYOUT, depth_six);
    }

    /// Claim: the finality branch length names the layout: 6, 7, 8 and 9 give plain depth 5, plain depth 6, plain depth 7
    /// and the Gloas layout, and every other length from 0 to 12 is refused.
    /// Why it is safe: each allowed length is the depth of the finality index of exactly one layout, so no length names two.
    /// Length 8 is allowed only because the layout witness proves the shape of the state.
    #[test]
    fn the_finality_branch_length_names_the_layout() {
        assert_eq!(state_layout_for_finality_branch_length(6), Ok(CAPELLA_DENEB_STATE_LAYOUT));
        assert_eq!(state_layout_for_finality_branch_length(7), Ok(ELECTRA_STATE_LAYOUT));
        assert_eq!(state_layout_for_finality_branch_length(8), Ok(plain_state_layout(7)));
        assert_eq!(state_layout_for_finality_branch_length(8), Ok(DEPTH_SEVEN_STATE_LAYOUT));
        assert_eq!(state_layout_for_finality_branch_length(9), Ok(GLOAS_STATE_LAYOUT));
        assert_eq!(ALLOWED_FINALITY_BRANCH_LENGTHS, [6, 7, 8, 9]);
        for length in (0..=12).filter(|length| ![6, 7, 8, 9].contains(length)) {
            assert_eq!(
                state_layout_for_finality_branch_length(length),
                Err(Error::UnsupportedStateBranchLength { length })
            );
        }
        for length in [64, 1024, usize::MAX] {
            assert_eq!(
                state_layout_for_finality_branch_length(length),
                Err(Error::UnsupportedStateBranchLength { length })
            );
        }
        for length in ALLOWED_FINALITY_BRANCH_LENGTHS {
            let layout = state_layout_for_finality_branch_length(length).unwrap();
            assert_eq!(gindex_depth(layout.finalized_root_gindex) as usize, length);
        }
    }

    /// Claim: the witness position is field 1 of the state: 33, 65 and 129 for plain depths 5, 6 and 7 (written here as
    /// literals), and node 40 for Gloas, which DERIVES from the field list. The branch lengths are 5, 6, 7 and 5.
    /// Why it matters: the witness is the only evidence that ties a claimed layout to the real tree. A wrong position
    /// would make the honest branch fail, or accept a branch of another field.
    #[test]
    fn the_witness_position_is_field_one_of_each_layout() {
        assert_eq!(CAPELLA_DENEB_STATE_LAYOUT.witness_gindex, 33);
        assert_eq!(ELECTRA_STATE_LAYOUT.witness_gindex, 65);
        assert_eq!(DEPTH_SEVEN_STATE_LAYOUT.witness_gindex, 129);
        assert_eq!(GLOAS_STATE_LAYOUT.witness_gindex, 40);
        assert_eq!(BEACON_STATE_GLOAS.field_position("genesis_validators_root"), Some(1));
        assert_eq!(path_gindex(&[(&BEACON_STATE_GLOAS, "genesis_validators_root")]), Some(WITNESS_GINDEX_GLOAS));
        for (finality_length, witness_length) in [(6usize, 5u32), (7, 6), (8, 7), (9, 5)] {
            let layout = state_layout_for_finality_branch_length(finality_length).unwrap();
            assert_eq!(gindex_depth(layout.witness_gindex), witness_length, "finality length {finality_length}");
        }
    }

    /// Claim: no two allowed layouts share a witness position, and the witness position of each layout differs from every
    /// finality and committee position of every layout.
    /// Why it matters: plain depth 5 and Gloas share the witness length 5. Only the position, chosen by the finality
    /// length, tells them apart.
    #[test]
    fn witness_positions_are_distinct() {
        let layouts: Vec<StateLayout> =
            ALLOWED_FINALITY_BRANCH_LENGTHS.iter().map(|length| state_layout_for_finality_branch_length(*length).unwrap()).collect();
        let witnesses: Vec<u64> = layouts.iter().map(|layout| layout.witness_gindex).collect();
        for (index, witness) in witnesses.iter().enumerate() {
            assert!(!witnesses[index + 1..].contains(witness), "{witness} repeats");
            for layout in &layouts {
                assert_ne!(*witness, layout.finalized_root_gindex);
                assert_ne!(*witness, layout.current_sync_committee_gindex);
                assert_ne!(*witness, layout.next_sync_committee_gindex);
            }
        }
        assert_eq!(gindex_depth(witnesses[0]), gindex_depth(witnesses[3]), "plain 5 and Gloas share a witness length");
    }

    /// Claim: a compact branch of 8, 9 or 11 entries names index 412, 812 or 2947, under the body root for the first two and
    /// the state root for the last. Every other length from 0 to 16 names nothing.
    #[test]
    fn the_compact_branch_length_names_the_anchor() {
        assert_eq!(
            compact_anchor_for_branch_length(8),
            Some(CompactAnchor { gindex: 412, root: CompactAnchorRoot::Body })
        );
        assert_eq!(
            compact_anchor_for_branch_length(9),
            Some(CompactAnchor { gindex: 812, root: CompactAnchorRoot::Body })
        );
        assert_eq!(
            compact_anchor_for_branch_length(11),
            Some(CompactAnchor { gindex: 2947, root: CompactAnchorRoot::State })
        );
        for length in (0..=16).filter(|length| ![8, 9, 11].contains(length)) {
            assert_eq!(compact_anchor_for_branch_length(length), None, "length {length}");
        }
    }

    /// Claim: the `fork` field of the Gloas state is chunk 3, and `fork.current_version` is node 169, which the gate checks
    /// with a progressive rule. The depth rule `(2^depth + 3) * 4 + 1` gives 141 at depth 5, 269 at depth 6 and 525 at
    /// depth 7: none of them is 169.
    #[test]
    fn gloas_fork_version_index_differs_from_the_depth_rule() {
        let derived = path_gindex(&[(&BEACON_STATE_GLOAS, "fork"), (&FORK, "current_version")]);
        assert_eq!(derived, Some(169));
        assert_eq!(derived, Some(FORK_VERSION_GINDEX_GLOAS));
        assert_eq!(gindex_depth(FORK_VERSION_GINDEX_GLOAS), 7);
        for depth in 5..=7u32 {
            assert_ne!(((1u64 << depth) + 3) * 4 + 1, 169);
        }
    }

    /// Claim: `fork.current_version` sits at `((2^depth + 3) * 4) + 1` in a plain state: 141, 269 and 525, with branch
    /// lengths 7, 8 and 9. In the Gloas progressive state it sits at 169 (length 7), derived from the field list.
    /// Why it matters: the fork observation proves the version at one of these positions. The shape follows from where the
    /// branch verifies.
    #[test]
    fn the_version_position_follows_the_depth() {
        assert_eq!(plain_current_version_gindex(5), 141);
        assert_eq!(plain_current_version_gindex(6), 269);
        assert_eq!(plain_current_version_gindex(7), 525);
        assert_eq!(gindex_depth(141), 7);
        assert_eq!(gindex_depth(269), 8);
        assert_eq!(gindex_depth(525), 9);
        assert_eq!(OBSERVED_SHAPE_PROGRESSIVE.current_version_gindex, 169);
        assert_eq!(gindex_depth(169), 7);
    }

    /// Claim: a version branch of 7 entries has two candidates, tried in this order: plain depth 5, then progressive. A
    /// branch of 8 entries has plain depth 6 only, and 9 entries plain depth 7 only. Every other length has none.
    /// The shape values are 5, 6, 7 and 255, and the witness position of each candidate is 33, 65, 129 and 40.
    /// Why it matters: length 7 is ambiguous (plain depth 5 and Gloas both reach depth 7), so the program must try both
    /// and accept the first for which the version AND the witness verify.
    #[test]
    fn the_version_branch_length_names_the_shape_candidates() {
        assert_eq!(observed_shape_candidates(7), &[OBSERVED_SHAPE_PLAIN_DEPTH_FIVE, OBSERVED_SHAPE_PROGRESSIVE]);
        assert_eq!(observed_shape_candidates(8), &[OBSERVED_SHAPE_PLAIN_DEPTH_SIX]);
        assert_eq!(observed_shape_candidates(9), &[OBSERVED_SHAPE_PLAIN_DEPTH_SEVEN]);
        for length in (0..=16).chain([64, usize::MAX]).filter(|length| ![7, 8, 9].contains(length)) {
            assert!(observed_shape_candidates(length).is_empty(), "length {length}");
        }
        assert_eq!((SHAPE_PLAIN_DEPTH_FIVE, SHAPE_PLAIN_DEPTH_SIX, SHAPE_PLAIN_DEPTH_SEVEN, SHAPE_PROGRESSIVE), (5, 6, 7, 255));
        let rows: Vec<(u8, u64, u64)> = [7usize, 8, 9]
            .iter()
            .flat_map(|length| observed_shape_candidates(*length))
            .map(|candidate| (candidate.shape, candidate.current_version_gindex, candidate.witness_gindex))
            .collect();
        assert_eq!(rows, vec![(5, 141, 33), (255, 169, 40), (6, 269, 65), (7, 525, 129)]);
        for length in [7usize, 8, 9] {
            for candidate in observed_shape_candidates(length) {
                assert_eq!(gindex_depth(candidate.current_version_gindex) as usize, length);
            }
        }
    }
}
