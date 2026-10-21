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
}

/// `SLOTS_PER_HISTORICAL_ROOT`: the length of `BeaconState.block_roots`.
///
/// Source: `/eth/v1/config/spec` on both chains (see the chain specification fixtures); consensus-specs
/// `presets/mainnet/phase0.yaml`. A test compares this constant with both fixtures.
pub const SLOTS_PER_HISTORICAL_ROOT: u64 = 8192;

/// Depth of the `block_roots` vector below its field node: `log2(8192)`.
pub const BLOCK_ROOTS_VECTOR_DEPTH: u32 = 13;

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
    use crate::ssz::gindex_depth;

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
}
