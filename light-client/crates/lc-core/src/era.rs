//! Builders for the ancestry branch of a withdrawal, from a parsed anchor state.
//!
//! The vault picks the path from the two slots (see [`crate::ancestry`]). These functions build the matching branch.
//!
//! - Recent path: [`recent_ancestry_branch`], the branch of `state.block_roots[slot % 8192]`.
//! - Historical path: [`historical_ancestry_branch`], the branch of
//!   `state.historical_summaries[era - capellaEra].block_summary_root.block_roots[slot % 8192]`.
//!
//! The historical path needs the 8192 block roots of the deposit era. Never read them from an old state: a node can
//! serve an old state one `historical_summaries` entry short, and that state does not hash to its own root. Rebuild the
//! roots from the canonical block roots of the node with [`era_block_roots`]. [`historical_ancestry_branch`] then
//! checks the result against the `block_summary_root` of the anchor state, so a wrong root cannot pass.

use crate::ancestry::historical_leaf_gindex;
use crate::error::{Error, Result};
use crate::layout::{
    CAPELLA_DENEB_STATE_LAYOUT, HISTORICAL_SUMMARIES_FIELD_INDEX, HISTORICAL_SUMMARIES_LIST_DEPTH,
    SLOTS_PER_HISTORICAL_ROOT,
};
use crate::ssz::{branch_for_leaf, branch_for_leaf_with_limit, hash_pair, is_valid_exact_branch, merkleize, u64_chunk};
use crate::ssz_state::ParsedState;
use alloy_primitives::B256;
use std::collections::BTreeMap;

/// The position of `block_roots` among the Capella `BeaconState` fields.
const STATE_FIELD_BLOCK_ROOTS: usize = 5;

/// The first slot of an era.
pub const fn era_first_slot(era: u64) -> u64 {
    era * SLOTS_PER_HISTORICAL_ROOT
}

/// Rebuilds the `block_roots` vector of an era from canonical block roots.
///
/// `canonical` maps a slot to the root of the block that the canonical chain has in that slot. An empty slot is
/// absent. `process_slot` stores the root of the latest block header at every slot, so an empty slot repeats the root
/// of the block before it. `canonical` must hold the last block before the era (any slot below the first slot of the
/// era), or a block at the first slot.
///
/// # Errors
/// `NoBlockBeforeEra` when the vector would start with an unknown root.
pub fn era_block_roots(era: u64, canonical: &BTreeMap<u64, B256>) -> Result<Vec<B256>> {
    let start = era_first_slot(era);
    let mut current = canonical.range(..start).next_back().map(|(_, root)| *root);
    (start..start + SLOTS_PER_HISTORICAL_ROOT)
        .map(|slot| {
            current = canonical.get(&slot).copied().or(current);
            current.ok_or(Error::NoBlockBeforeEra { era })
        })
        .collect()
}

/// The branch of `block_roots[slot % 8192]` in the state: the vector branch, then the field branch.
pub fn recent_ancestry_branch(state: &ParsedState, slot: u64) -> Vec<B256> {
    let mut branch = branch_for_leaf(&state.block_roots, (slot % SLOTS_PER_HISTORICAL_ROOT) as usize).1;
    branch.extend(branch_for_leaf(&state.field_roots, STATE_FIELD_BLOCK_ROOTS).1);
    branch
}

/// The branch of the historical path, 44 entries in the Capella layout, from the block roots of the deposit era.
///
/// `capella_era` is the immutable `capellaEra` of the vault (`ChainSpec::capella_era`). `era_roots` are the 8192 block
/// roots of the era of `slot` (see [`era_block_roots`]). The function checks that they hash to the `block_summary_root`
/// of the anchor state, and that the finished branch leads from `era_roots[slot % 8192]` to the state root.
///
/// # Errors
/// `DepositBeforeCapella`, `HistoricalSummaryMissing`, `EraRootsMismatch`, `InvalidAncestryBranch`,
/// `HistoricalIndexOutOfRange`.
pub fn historical_ancestry_branch(
    state: &ParsedState,
    capella_era: u64,
    slot: u64,
    era_roots: &[B256],
) -> Result<Vec<B256>> {
    let era = slot / SLOTS_PER_HISTORICAL_ROOT;
    let index = era.checked_sub(capella_era).ok_or(Error::DepositBeforeCapella { deposit_era: era, capella_era })?;
    let summaries = state.historical_summaries.len() as u64;
    let Some(&(blocks, states)) =
        usize::try_from(index).ok().and_then(|position| state.historical_summaries.get(position))
    else {
        return Err(Error::HistoricalSummaryMissing { era, summaries });
    };
    if era_roots.len() as u64 != SLOTS_PER_HISTORICAL_ROOT || merkleize(era_roots) != blocks {
        return Err(Error::EraRootsMismatch { era });
    }
    let position = index as usize;
    let summary_roots: Vec<B256> = state.historical_summaries.iter().map(|(b, s)| hash_pair(b, s)).collect();
    let mut branch = branch_for_leaf(era_roots, (slot % SLOTS_PER_HISTORICAL_ROOT) as usize).1;
    branch.push(states);
    branch.extend(branch_for_leaf_with_limit(&summary_roots, position, HISTORICAL_SUMMARIES_LIST_DEPTH).1);
    branch.push(u64_chunk(summaries));
    branch.extend(branch_for_leaf(&state.field_roots, HISTORICAL_SUMMARIES_FIELD_INDEX as usize).1);
    let gindex = historical_leaf_gindex(CAPELLA_DENEB_STATE_LAYOUT.historical_summaries_gindex, index, slot)?;
    let leaf = era_roots[(slot % SLOTS_PER_HISTORICAL_ROOT) as usize];
    if !is_valid_exact_branch(&leaf, &branch, gindex, &state.root()) {
        return Err(Error::InvalidAncestryBranch);
    }
    Ok(branch)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::ssz::merkleize_with_limit;
    use crate::ssz::mix_in_length;
    use crate::ssz_state::ForkData;
    use crate::types::SyncCommittee;
    use alloy_primitives::keccak256;

    /// A parsed state whose `block_roots` and `historical_summaries` the test controls. Other fields hold filler.
    /// `summaries` holds the block roots of each complete era, in list order.
    fn state_with_eras(anchor_slot: u64, eras: &[Vec<B256>]) -> ParsedState {
        let block_roots: Vec<B256> = (0..8192u64).map(|slot| keccak256(format!("recent/{slot}"))).collect();
        let historical_summaries: Vec<(B256, B256)> = eras
            .iter()
            .enumerate()
            .map(|(index, roots)| (merkleize(roots), keccak256(format!("state-summary/{index}"))))
            .collect();
        let summary_roots: Vec<B256> = historical_summaries.iter().map(|(b, s)| hash_pair(b, s)).collect();
        let mut field_roots: Vec<B256> = (0..28u64).map(|field| keccak256(format!("field/{field}"))).collect();
        field_roots[5] = merkleize(&block_roots);
        field_roots[27] =
            mix_in_length(&merkleize_with_limit(&summary_roots, 1 << 24), historical_summaries.len() as u64);
        let committee = SyncCommittee { pubkeys: Vec::new(), aggregate_pubkey: Default::default() };
        ParsedState {
            field_roots,
            block_roots,
            current_sync_committee: committee.clone(),
            next_sync_committee: committee,
            slot: anchor_slot,
            fork: ForkData { previous_version: [2, 0, 0, 0], current_version: [3, 0, 0, 0], epoch: 3 },
            finalized_checkpoint: (0, B256::ZERO),
            historical_summaries,
        }
    }

    fn era_of_roots(era: u64) -> Vec<B256> {
        (0..8192u64).map(|offset| keccak256(format!("era/{era}/{offset}"))).collect()
    }

    /// Claim: the historical branch of every slot position leads from the era root to the state root at the generalized
    /// index of `lc_core::ancestry`, and has 44 entries. Roots that do not hash to the summary are refused, and so is an
    /// era the state has no summary for (the era is not complete) or one before `capellaEra`.
    /// Why it matters: the vault checks the same index. A branch from the wrong era or the wrong roots reverts on chain.
    #[test]
    fn historical_branch_verifies_and_wrong_input_is_refused() {
        let capella_era = 2;
        let eras = [era_of_roots(2), era_of_roots(3), era_of_roots(4)];
        let anchor_slot = 8192 * 7 + 100;
        let state = state_with_eras(anchor_slot, &eras);
        for (era, slot) in [(2u64, 8192 * 2), (3, 8192 * 3 + 4000), (4, 8192 * 5 - 1)] {
            let roots = &eras[(era - capella_era) as usize];
            let branch = historical_ancestry_branch(&state, capella_era, slot, roots).unwrap();
            assert_eq!(branch.len(), 44);
            let gindex = historical_leaf_gindex(59, era - capella_era, slot).unwrap();
            assert!(is_valid_exact_branch(&roots[(slot % 8192) as usize], &branch, gindex, &state.root()));
            // Control: the same branch does not verify at the index of the neighbouring era.
            let other = historical_leaf_gindex(59, era - capella_era + 1, slot).unwrap();
            assert!(!is_valid_exact_branch(&roots[(slot % 8192) as usize], &branch, other, &state.root()));
        }
        let mut wrong = eras[1].clone();
        wrong[7] = keccak256(b"wrong");
        assert_eq!(
            historical_ancestry_branch(&state, capella_era, 8192 * 3 + 7, &wrong),
            Err(Error::EraRootsMismatch { era: 3 })
        );
        assert_eq!(
            historical_ancestry_branch(&state, capella_era, 8192 * 3, &eras[1][..8000]),
            Err(Error::EraRootsMismatch { era: 3 })
        );
        assert_eq!(
            historical_ancestry_branch(&state, capella_era, 8192 * 5, &era_of_roots(5)),
            Err(Error::HistoricalSummaryMissing { era: 5, summaries: 3 })
        );
        assert_eq!(
            historical_ancestry_branch(&state, capella_era, 8192, &era_of_roots(1)),
            Err(Error::DepositBeforeCapella { deposit_era: 1, capella_era })
        );
    }

    /// Claim: the recent branch leads from `block_roots[slot % 8192]` to the state root at the recent generalized index.
    #[test]
    fn recent_branch_verifies() {
        let state = state_with_eras(100_000, &[]);
        let slot = 99_000;
        let branch = recent_ancestry_branch(&state, slot);
        let gindex = crate::ancestry::block_roots_leaf_gindex(37, slot).unwrap();
        assert_eq!(branch.len(), 18);
        assert!(is_valid_exact_branch(&state.block_roots[(slot % 8192) as usize], &branch, gindex, &state.root()));
    }

    /// Claim: an empty slot repeats the root of the block before it, including across the era border, and a map with
    /// no block at or before the era start is refused.
    /// Why it matters: a wrong carry changes the hash tree root of the era, and no branch then verifies.
    #[test]
    fn empty_slots_repeat_the_previous_root() {
        let era = 3;
        let start = era_first_slot(era);
        let (before, first, later) = (keccak256(b"before"), keccak256(b"first"), keccak256(b"later"));
        let canonical = BTreeMap::from([(start - 5, before), (start + 2, first), (start + 4000, later)]);
        let roots = era_block_roots(era, &canonical).unwrap();
        assert_eq!(roots.len(), 8192);
        assert_eq!(roots[0], before, "slot 0 of the era is empty: it repeats the block before the era");
        assert_eq!(roots[1], before);
        assert_eq!(roots[2], first);
        assert_eq!(roots[3999], first);
        assert_eq!(roots[4000], later);
        assert_eq!(roots[8191], later);
        let without_previous = BTreeMap::from([(start + 2, first)]);
        assert_eq!(era_block_roots(era, &without_previous), Err(Error::NoBlockBeforeEra { era }));
        let at_start = BTreeMap::from([(start, first)]);
        assert_eq!(era_block_roots(era, &at_start).unwrap()[0], first);
    }
}
