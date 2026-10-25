//! Generalized indices per fork.
//!
//! The values come from `ethereum/consensus-specs` (master, fetched 2026-10-20):
//! - `specs/altair/light-client/sync-protocol.md`, section "Constants"
//! - `specs/capella/light-client/sync-protocol.md`, section "Constants"
//! - `specs/deneb/light-client/sync-protocol.md`, section "Helpers"
//! - `specs/electra/light-client/sync-protocol.md`, sections "Constants" and "Helpers"
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
/// Gloas changes the body layout and is not supported.
///
/// # Errors
/// `UnsupportedFork` for Phase0, Altair, Bellatrix and Gloas.
pub fn state_layout_for_fork(fork: ForkName) -> Result<StateLayout> {
    match fork {
        ForkName::Capella | ForkName::Deneb => Ok(CAPELLA_DENEB_STATE_LAYOUT),
        ForkName::Electra | ForkName::Fulu => Ok(ELECTRA_STATE_LAYOUT),
        ForkName::Phase0 | ForkName::Altair | ForkName::Bellatrix | ForkName::Gloas => {
            Err(Error::UnsupportedFork { fork })
        }
    }
}

/// Selects the execution payload header form for a fork.
///
/// # Errors
/// `UnsupportedFork` for forks without a supported light-client layout.
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
        for fork in [ForkName::Phase0, ForkName::Altair, ForkName::Bellatrix, ForkName::Gloas] {
            assert_eq!(state_layout_for_fork(fork), Err(Error::UnsupportedFork { fork }));
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
}
