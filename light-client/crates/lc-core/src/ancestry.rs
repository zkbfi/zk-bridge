//! The beacon path of a message proof: from a finalized anchor to the execution block hash of the source block.
//!
//! The light client stores only finalized beacon headers, by slot. The source transaction sits in an arbitrary earlier block.
//! The path is:
//!
//! 1. `hash_tree_root(anchor_header)` equals the stored header root of the anchor slot.
//! 2. `anchor.state_root` commits to the source header through one of two paths. The bridge picks the path from the two
//!    slots. The prover never picks it. `distance = anchor_slot - source_slot`.
//!    - Recent path, `0 < distance <= 8192`: leaf `hash_tree_root(source_header)` at the generalized index of
//!      `block_roots[source_slot % 8192]`. `get_block_root_at_slot` in `specs/phase0/beacon-chain.md` asserts
//!      `slot < state.slot <= slot + SLOTS_PER_HISTORICAL_ROOT`.
//!    - Historical path, `distance > 8192`: the era of the source block is complete at the anchor, and
//!      `state.historical_summaries[era - capellaEra].block_summary_root` is the root of that era's `block_roots`.
//!      Generalized index, built in this order (see [`historical_leaf_gindex`]): the field, the list data node, the
//!      list position, `block_summary_root`, the position inside the era.
//! 3. `source.body_root` commits to `execution_payload.block_hash`. One combined branch (body field 9, then payload
//!    field 12) leads from the block hash to the body root. The full `ExecutionPayloadHeader` is never hashed.
//!
//! Every hash on this path is SHA-256, except the keccak256 of the execution header.
//!
//! Branches must have the exact length: padding is not accepted. A branch built for the other path has the wrong
//! length or the wrong index, so the bridge refuses it.

use crate::abi::{BeaconBlockHeader as AbiBeaconBlockHeader, MessageProof};
use crate::chain::{ChainSpec, ForkName};
use crate::error::{Error, Result};
use crate::layout::{
    block_hash_gindex_for_fork, is_block_roots_position, is_historical_summaries_position, state_layout_for_fork,
    BLOCK_ROOTS_VECTOR_DEPTH, HISTORICAL_SUMMARIES_LIST_DEPTH, SLOTS_PER_HISTORICAL_ROOT,
};
use crate::ssz::is_valid_exact_branch;
use crate::types::BeaconBlockHeader;
use alloy_primitives::{keccak256, B256};

impl From<&AbiBeaconBlockHeader> for BeaconBlockHeader {
    fn from(header: &AbiBeaconBlockHeader) -> Self {
        Self {
            slot: header.slot,
            proposer_index: header.proposerIndex,
            parent_root: header.parentRoot,
            state_root: header.stateRoot,
            body_root: header.bodyRoot,
        }
    }
}

impl From<&BeaconBlockHeader> for AbiBeaconBlockHeader {
    fn from(header: &BeaconBlockHeader) -> Self {
        Self {
            slot: header.slot,
            proposerIndex: header.proposer_index,
            parentRoot: header.parent_root,
            stateRoot: header.state_root,
            bodyRoot: header.body_root,
        }
    }
}

/// Which ancestry path proves the source header.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum AncestryPath {
    /// `0 < distance <= 8192`: through `state.block_roots`.
    Recent,
    /// `distance > 8192`: through `state.historical_summaries`.
    Historical,
}

/// Chooses the ancestry path from the two slots. The edge belongs to the recent path: distance 8192 is recent.
///
/// # Errors
/// `DepositNotBeforeAnchor` when `source_slot >= anchor_slot`.
pub fn ancestry_path_for_slots(anchor_slot: u64, source_slot: u64) -> Result<AncestryPath> {
    if source_slot >= anchor_slot {
        return Err(Error::DepositNotBeforeAnchor { anchor_slot, source_slot });
    }
    if anchor_slot - source_slot <= SLOTS_PER_HISTORICAL_ROOT {
        return Ok(AncestryPath::Recent);
    }
    Ok(AncestryPath::Historical)
}

/// The generalized index of `block_roots[slot % 8192]`, given the generalized index of the `block_roots` field.
///
/// # Errors
/// `LayoutPositionInvalid` when the field index is not an accepted `block_roots` position (37, 69 or 133): the bridge
/// accepts no other.
pub fn block_roots_leaf_gindex(block_roots_field_gindex: u64, source_slot: u64) -> Result<u64> {
    if !is_block_roots_position(block_roots_field_gindex) {
        return Err(Error::LayoutPositionInvalid { gindex: block_roots_field_gindex });
    }
    Ok((block_roots_field_gindex << BLOCK_ROOTS_VECTOR_DEPTH) | (source_slot % SLOTS_PER_HISTORICAL_ROOT))
}

/// The generalized index of `historical_summaries[index].block_summary_root.block_roots[source_slot % 8192]`.
///
/// Built in this order, from the generalized index `g` of the `historical_summaries` field in `BeaconState`:
/// 1. `g = historical_summaries_field_gindex`
/// 2. `g = g * 2`: the list data root, past the length mix-in
/// 3. `g = g * 2^24 + index`: the list position (`HISTORICAL_ROOTS_LIMIT = 2^24`)
/// 4. `g = g * 2 + 0`: `HistoricalSummary.block_summary_root`
/// 5. `g = g * 2^13 + source_slot % 8192`: the position inside that era's `block_roots`
///
/// The branch for this index has `depth(field) + 1 + 24 + 1 + 13` entries: 44 in the Capella and Deneb layouts, 45 in
/// the Electra and Fulu layouts.
///
/// # Errors
/// `LayoutPositionInvalid` when the field index is not an accepted `historical_summaries` position (59, 91 or 155).
/// `HistoricalIndexOutOfRange` when `index >= 2^24`: it would spill into the neighbouring subtree.
pub fn historical_leaf_gindex(historical_summaries_field_gindex: u64, index: u64, source_slot: u64) -> Result<u64> {
    if !is_historical_summaries_position(historical_summaries_field_gindex) {
        return Err(Error::LayoutPositionInvalid { gindex: historical_summaries_field_gindex });
    }
    if index >= 1u64 << HISTORICAL_SUMMARIES_LIST_DEPTH {
        return Err(Error::HistoricalIndexOutOfRange { index });
    }
    let mut gindex = historical_summaries_field_gindex;
    gindex *= 2;
    gindex = (gindex << HISTORICAL_SUMMARIES_LIST_DEPTH) + index;
    gindex *= 2;
    gindex = (gindex << BLOCK_ROOTS_VECTOR_DEPTH) + source_slot % SLOTS_PER_HISTORICAL_ROOT;
    Ok(gindex)
}

/// The generalized index the bridge uses to check the ancestry branch, for either path.
///
/// `capella_era` is the immutable `capellaEra` of the bridge (`ChainSpec::capella_era`).
///
/// # Errors
/// `DepositNotBeforeAnchor`, `UnsupportedFork` (anchor fork), `DepositBeforeCapella`, `HistoricalIndexOutOfRange`,
/// `LayoutPositionInvalid`.
pub fn ancestry_leaf_gindex(spec: &ChainSpec, anchor_slot: u64, source_slot: u64) -> Result<u64> {
    let path = ancestry_path_for_slots(anchor_slot, source_slot)?;
    let anchor_fork = spec.fork_at_slot(anchor_slot);
    // A Gloas anchor has a progressive state. Its `block_roots` and `historical_summaries` positions (352 and 2950) fail
    // the position rules of the deployed Solidity, and the block hash path goes through the bid. Refuse it by name.
    if anchor_fork >= ForkName::Gloas {
        return Err(Error::UnsupportedFork { fork: anchor_fork });
    }
    let layout = state_layout_for_fork(anchor_fork)?;
    if path == AncestryPath::Recent {
        return block_roots_leaf_gindex(layout.block_roots_gindex, source_slot);
    }
    let capella_era = spec.capella_era()?;
    let source_era = source_slot / SLOTS_PER_HISTORICAL_ROOT;
    if source_era < capella_era {
        return Err(Error::DepositBeforeCapella { source_era, capella_era });
    }
    historical_leaf_gindex(layout.historical_summaries_gindex, source_era - capella_era, source_slot)
}

/// Verifies the beacon path and returns the execution block hash of the source block.
///
/// `stored_anchor_root` is what `lightClient.headers(anchorHeader.slot)` returns. Zero means "not stored".
///
/// # Errors
/// `AnchorNotStored`, `DepositNotBeforeAnchor`, `UnsupportedFork`, `DepositBeforeCapella`, `HistoricalIndexOutOfRange`,
/// `InvalidAncestryBranch`, `InvalidBlockHashBranch`.
pub fn verify_beacon_path(spec: &ChainSpec, proof: &MessageProof, stored_anchor_root: &B256) -> Result<B256> {
    let anchor = BeaconBlockHeader::from(&proof.anchorHeader);
    let source = BeaconBlockHeader::from(&proof.sourceHeader);

    let anchor_root = anchor.hash_tree_root();
    if *stored_anchor_root == B256::ZERO || anchor_root != *stored_anchor_root {
        return Err(Error::AnchorNotStored);
    }

    let ancestry_gindex = ancestry_leaf_gindex(spec, anchor.slot, source.slot)?;
    if !is_valid_exact_branch(&source.hash_tree_root(), &proof.ancestryBranch, ancestry_gindex, &anchor.state_root) {
        return Err(Error::InvalidAncestryBranch);
    }

    let block_hash = keccak256(&proof.executionHeaderRlp);
    let hash_gindex = block_hash_gindex_for_fork(spec.fork_at_slot(source.slot))?;
    if !is_valid_exact_branch(&block_hash, &proof.blockHashBranch, hash_gindex, &source.body_root) {
        return Err(Error::InvalidBlockHashBranch);
    }
    Ok(block_hash)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::chain::{ETHEREUM_MAINNET, PULSECHAIN};
    use crate::ssz::gindex_depth;

    /// Claim: the path follows the distance. 1 and 8192 are recent, 8193 is historical, 0 and negative are refused.
    /// Why it matters: the bridge, not the prover, picks the path, so the edge must sit on exactly one side.
    #[test]
    fn path_follows_the_distance() {
        let anchor = 100_000;
        assert_eq!(ancestry_path_for_slots(anchor, anchor - 1), Ok(AncestryPath::Recent));
        assert_eq!(ancestry_path_for_slots(anchor, anchor - 8192), Ok(AncestryPath::Recent));
        assert_eq!(ancestry_path_for_slots(anchor, anchor - 8193), Ok(AncestryPath::Historical));
        assert_eq!(
            ancestry_path_for_slots(anchor, anchor),
            Err(Error::DepositNotBeforeAnchor { anchor_slot: anchor, source_slot: anchor })
        );
        assert!(ancestry_path_for_slots(anchor, anchor + 1).is_err());
    }

    /// Claim: the historical index, built step by step as the build contract lists it, equals the closed form
    /// `((field * 2) * 2^24 + index) * 2 * 2^13 + slot % 8192`, and for index 0 and slot 0 it equals `field * 2^39`
    /// (1 + 1 + 24 + 1 + 13 = 39 doublings), computed by hand.
    /// Why it matters: a wrong order or a missing `* 2` points at a different node and no honest proof verifies.
    #[test]
    fn historical_gindex_follows_the_stated_order() {
        let (field, index, slot) = (59u64, 1_326u64, 10_866_001u64);
        let step_one = field;
        let step_two = step_one * 2;
        let step_three = step_two * (1 << 24) + index;
        let step_four = step_three * 2;
        let step_five = step_four * (1 << 13) + slot % 8192;
        assert_eq!(historical_leaf_gindex(field, index, slot), Ok(step_five));
        // Hand computed anchor: index 0, slot 0 gives 59 * 2 * 2^24 * 2 * 2^13 = 59 * 2^39.
        assert_eq!(historical_leaf_gindex(59, 0, 0), Ok(59 << 39));
        assert_eq!(historical_leaf_gindex(91, 0, 0), Ok(91 << 39));
        // The order matters: any other order gives another number.
        assert_ne!(step_five, ((field * (1 << 24) + index) * 2 * 2) * (1 << 13) + slot % 8192);
    }

    /// Claim: the branch lengths are exactly 44 (Capella and Deneb layouts) and 45 (Electra and Fulu layouts), the
    /// numbers in the paper review, and the recent path stays at 18 and 19.
    #[test]
    fn branch_lengths_are_exact() {
        assert_eq!(gindex_depth(historical_leaf_gindex(59, 5, 77).unwrap()), 44);
        assert_eq!(gindex_depth(historical_leaf_gindex(91, 5, 77).unwrap()), 45);
        assert_eq!(gindex_depth(historical_leaf_gindex(155, 5, 77).unwrap()), 46);
        assert_eq!(gindex_depth(block_roots_leaf_gindex(133, 77).unwrap()), 20);
        assert_eq!(gindex_depth(block_roots_leaf_gindex(37, 77).unwrap()), 18);
        assert_eq!(gindex_depth(block_roots_leaf_gindex(69, 77).unwrap()), 19);
    }

    /// Claim: an index of 2^24 or more is refused instead of spilling into the next subtree. The control: 2^24 - 1 works.
    #[test]
    fn index_at_the_list_limit_is_refused() {
        assert!(historical_leaf_gindex(59, (1 << 24) - 1, 0).is_ok());
        assert_eq!(historical_leaf_gindex(59, 1 << 24, 0), Err(Error::HistoricalIndexOutOfRange { index: 1 << 24 }));
    }

    /// Claim: the bridge picks the leaf index per path, and it takes `capellaEra` from the chain. On Ethereum a message in
    /// era 758 has index 0 and a message in era 757 is refused; on PulseChain era 0 has index 0.
    /// Why it matters: this is the era formula, and an off-by-one makes a whole era unreachable.
    #[test]
    fn leaf_index_uses_capella_era_of_the_chain() {
        let anchor = 15_500_000;
        let first_capella_slot = 758 * 8192;
        let leaf = ancestry_leaf_gindex(&ETHEREUM_MAINNET, anchor, first_capella_slot).unwrap();
        assert_eq!(leaf, historical_leaf_gindex(91, 0, first_capella_slot).unwrap());
        let next_era = ancestry_leaf_gindex(&ETHEREUM_MAINNET, anchor, first_capella_slot + 8192).unwrap();
        assert_eq!(next_era, historical_leaf_gindex(91, 1, first_capella_slot + 8192).unwrap());
        assert_eq!(
            ancestry_leaf_gindex(&ETHEREUM_MAINNET, anchor, first_capella_slot - 1),
            Err(Error::DepositBeforeCapella { source_era: 757, capella_era: 758 })
        );
        let pulsechain = ancestry_leaf_gindex(&PULSECHAIN, 10_900_000, 100).unwrap();
        assert_eq!(pulsechain, historical_leaf_gindex(59, 0, 100).unwrap());
    }

    /// Claim: a Gloas anchor is refused by name instead of failing on a position rule. The first Gloas slot of Sepolia is 353024 * 32
    /// (Gloas). The control: the Fulu slot before the fork builds a leaf.
    #[test]
    fn a_gloas_anchor_is_unsupported() {
        use crate::chain::SEPOLIA;
        let gloas_slot = 353_024 * 32;
        assert_eq!(
            ancestry_leaf_gindex(&SEPOLIA, gloas_slot + 100, gloas_slot + 50),
            Err(Error::UnsupportedFork { fork: ForkName::Gloas })
        );
        assert!(ancestry_leaf_gindex(&SEPOLIA, gloas_slot - 1, gloas_slot - 50).is_ok());
    }

    /// Claim: the leaf builders take only the positions that the bridge accepts, and refuse a neighbour of each. The
    /// deeper positions 133 and 155 build leaves, the neighbours 36, 38, 132, 134, 58, 60, 154 and 156 do not.
    /// Why it matters: a position that the bridge refuses must not yield a leaf that a prover could use to build evidence.
    #[test]
    fn leaf_builders_take_only_accepted_positions() {
        for position in [37, 69, 133] {
            assert!(block_roots_leaf_gindex(position, 5).is_ok(), "{position}");
            for neighbour in [position - 1, position + 1] {
                assert_eq!(
                    block_roots_leaf_gindex(neighbour, 5),
                    Err(Error::LayoutPositionInvalid { gindex: neighbour })
                );
            }
        }
        for position in [59, 91, 155] {
            assert!(historical_leaf_gindex(position, 0, 5).is_ok(), "{position}");
            for neighbour in [position - 1, position + 1] {
                assert_eq!(
                    historical_leaf_gindex(neighbour, 0, 5),
                    Err(Error::LayoutPositionInvalid { gindex: neighbour })
                );
            }
        }
        // A position of the other field is refused too, although it has an accepted shape.
        assert_eq!(block_roots_leaf_gindex(59, 5), Err(Error::LayoutPositionInvalid { gindex: 59 }));
        assert_eq!(historical_leaf_gindex(37, 0, 5), Err(Error::LayoutPositionInvalid { gindex: 37 }));
    }
}
