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
//! 3. The fork proof of the source state (`MessageProof.sourceFork`, [`source_shape`]) proves the shape of the state
//!    under `source.state_root`, by the rule of `ForkShape.judge`: one of [`ALLOWED_SHAPES`], with the genesis validators
//!    root of the chain. The shape picks the rule of step 4. No fork slot is read for it: the chain schedule of the
//!    [`ChainSpec`] plays no part in the rule, so a fork that the schedule does not know yet is followed as soon as its
//!    first block is proven.
//! 4. `source.body_root` commits to the execution block hash. A plain shape (before Gloas):
//!    `execution_payload.block_hash`, one combined branch (body field 9, then payload field 12). The progressive shape
//!    (Gloas on): the `parent_block_hash` of the bid of the source block (index 2856), and the source block is a block
//!    AFTER the execution block (see [`crate::layout::message_block_hash_gindex_for_fork`] for the soundness argument).
//!    The full `ExecutionPayloadHeader` is never hashed.
//!
//! Every hash on this path is SHA-256, except the keccak256 of the execution header.
//!
//! Branches must have the exact length: padding is not accepted. A branch built for the other path has the wrong
//! length or the wrong index, so the bridge refuses it.

use crate::abi::{BeaconBlockHeader as AbiBeaconBlockHeader, ForkProof, MessageProof};
use crate::chain::{ChainSpec, ForkName};
use crate::error::{Error, Result};
use crate::layout::{
    block_hash_gindex_for_fork, is_block_roots_position, is_historical_summaries_position, state_layout_for_fork,
    ObservedShape, BLOCK_HASH_GINDEX_GLOAS, BLOCK_ROOTS_VECTOR_DEPTH, HISTORICAL_SUMMARIES_LIST_DEPTH,
    OBSERVED_SHAPE_PLAIN_DEPTH_FIVE, OBSERVED_SHAPE_PLAIN_DEPTH_SEVEN, OBSERVED_SHAPE_PLAIN_DEPTH_SIX,
    OBSERVED_SHAPE_PROGRESSIVE, SHAPE_PROGRESSIVE, SLOTS_PER_HISTORICAL_ROOT,
};
use crate::ssz::{is_valid_exact_branch, progressive_container_branch};
use crate::ssz_state::{ForkData, ParsedState};
use crate::types::BeaconBlockHeader;
use alloy_primitives::{keccak256, FixedBytes, B256};

/// The state shapes that a message source may have, in the order in which `ForkShape.judge` tries them. It is the list
/// `ForkShape.allowedShapes` of the contracts: plain depth 5, 6 and 7, then the progressive form. A Solidity test and a
/// Rust test pin both lists to these values, so the deposit gate and the message verifier keep one list.
pub const ALLOWED_SHAPES: [ObservedShape; 4] = [
    OBSERVED_SHAPE_PLAIN_DEPTH_FIVE,
    OBSERVED_SHAPE_PLAIN_DEPTH_SIX,
    OBSERVED_SHAPE_PLAIN_DEPTH_SEVEN,
    OBSERVED_SHAPE_PROGRESSIVE,
];

/// The version as a leaf: four bytes, right-padded to 32, as `ForkShape.judge` hashes `bytes32(version)`.
fn version_leaf(version: FixedBytes<4>) -> B256 {
    let mut leaf = [0u8; 32];
    leaf[..4].copy_from_slice(version.as_slice());
    B256::from(leaf)
}

/// The shape of the state under `state_root`, by the rule of `ForkShape.judge`: the first allowed shape for which the
/// version branch proves `fork.version` at the version position of that shape and the genesis validators root branch
/// proves `genesis_validators_root` at the root position of that shape. Both branches must have the exact length.
///
/// A prover cannot claim another shape than the state has: the genesis validators root position of each shape lies where
/// the other shapes hold a fixed leaf or a hash (see `BeaconLayoutLib._provenShape`).
///
/// # Errors
/// `InvalidForkShapeProof` when no allowed shape has both branches valid.
pub fn source_shape(fork: &ForkProof, state_root: &B256, genesis_validators_root: &B256) -> Result<u8> {
    let leaf = version_leaf(fork.version);
    ALLOWED_SHAPES
        .iter()
        .find(|shape| {
            is_valid_exact_branch(&leaf, &fork.versionBranch, shape.current_version_gindex, state_root)
                && is_valid_exact_branch(
                    genesis_validators_root,
                    &fork.genesisValidatorsRootBranch,
                    shape.genesis_validators_root_gindex,
                    state_root,
                )
        })
        .map(|shape| shape.shape)
        .ok_or(Error::InvalidForkShapeProof)
}

/// The fork proof of a parsed state: the version branch (`Fork.previous_version`, the node over `Fork.epoch`, then the
/// state levels) and the genesis validators root branch, for the shape of the state. The prover attaches it to a message
/// whose source header names this state.
pub fn fork_proof_of_state(state: &ParsedState) -> ForkProof {
    fork_proof_of_fields(&state.field_roots, state.shape != crate::layout::ContainerShape::Plain, &state.fork)
}

/// The fork proof of a state given by its field roots: a plain container, or the progressive one of Gloas.
///
/// # Panics
/// Panics when field 3 of `field_roots` is not the root of `fork`: the state does not hold that fork.
pub fn fork_proof_of_fields(field_roots: &[B256], progressive: bool, fork: &ForkData) -> ForkProof {
    let version_branch = match progressive {
        true => crate::gate::progressive_fork_version_branch(field_roots, fork),
        false => crate::gate::fork_version_branch(field_roots, fork),
    };
    let root_branch = match progressive {
        true => progressive_container_branch(field_roots, STATE_FIELD_GENESIS_VALIDATORS_ROOT).1,
        false => crate::ssz::branch_for_leaf(field_roots, STATE_FIELD_GENESIS_VALIDATORS_ROOT).1,
    };
    ForkProof {
        version: FixedBytes::from(fork.current_version),
        versionBranch: version_branch,
        genesisValidatorsRootBranch: root_branch,
    }
}

/// The position of `genesis_validators_root` among the `BeaconState` fields.
const STATE_FIELD_GENESIS_VALIDATORS_ROOT: usize = 1;

/// The execution block hash position of a message source of `shape` at `slot`: 2856 (the bid `parent_block_hash`) for
/// the progressive shape; for a plain shape, the payload `block_hash` position that the validated layout of the slot
/// holds, which this reference models by the fork of the slot. A plain state is never Gloas, so a slot that the schedule
/// already counts as Gloas takes the Fulu position.
///
/// # Errors
/// `UnsupportedFork` for a slot before Capella.
pub fn message_block_hash_gindex_for_shape(spec: &ChainSpec, shape: u8, slot: u64) -> Result<u64> {
    if shape == SHAPE_PROGRESSIVE {
        return Ok(BLOCK_HASH_GINDEX_GLOAS);
    }
    block_hash_gindex_for_fork(spec.fork_at_slot(slot).min(ForkName::Fulu))
}

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
    // A Gloas anchor has a progressive state: its `block_roots` is at 352 and its `historical_summaries` at 2950, and the
    // position rules take both. The anchor only proves the SOURCE HEADER. The execution block of the source comes from the
    // source body, by the rule that the fork proof of the source state picks (`verify_beacon_path`). This reference models
    // the validated layout row of the anchor by the fork of the anchor slot; the bridge reads its table.
    let layout = state_layout_for_fork(spec.fork_at_slot(anchor_slot))?;
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
/// `stored_anchor_root` is what `lightClient.headers(anchorHeader.slot)` returns. Zero means "not stored". The genesis
/// validators root of the fork proof is the one of the chain (`spec.genesis_validators_root`), which the light client of
/// the bridge holds. The order of the checks is the order of the bridge: anchor, ancestry, fork proof, block hash.
///
/// # Errors
/// `AnchorNotStored`, `DepositNotBeforeAnchor`, `UnsupportedFork`, `DepositBeforeCapella`, `HistoricalIndexOutOfRange`,
/// `InvalidAncestryBranch`, `InvalidForkShapeProof`, `InvalidBlockHashBranch`.
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

    let shape = source_shape(&proof.sourceFork, &source.state_root, &spec.genesis_validators_root)?;
    let block_hash = keccak256(&proof.executionHeaderRlp);
    let hash_gindex = message_block_hash_gindex_for_shape(spec, shape, source.slot)?;
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

    /// Claim: a Gloas anchor builds its leaves at the progressive positions. The recent leaf is `352 * 8192 + slot % 8192`
    /// (depth 21) and the historical leaf follows the stated order from 2950 (depth 50). The first Gloas slot of Sepolia is
    /// 353024 * 32. A Fulu anchor of the slot before still builds the Electra leaf (depth 19), so the fork of the ANCHOR
    /// selects the layout.
    #[test]
    fn a_gloas_anchor_builds_progressive_leaves() {
        use crate::chain::SEPOLIA;
        let gloas_slot = 353_024 * 32;
        let recent = ancestry_leaf_gindex(&SEPOLIA, gloas_slot + 100, gloas_slot + 50).unwrap();
        assert_eq!(recent, 352 * 8192 + (gloas_slot + 50) % 8192);
        assert_eq!(gindex_depth(recent), 21);
        let source = gloas_slot - 20_000;
        let historical = ancestry_leaf_gindex(&SEPOLIA, gloas_slot + 100, source).unwrap();
        let era_index = source / 8192 - SEPOLIA.capella_era().unwrap();
        assert_eq!(historical, historical_leaf_gindex(2950, era_index, source).unwrap());
        assert_eq!(gindex_depth(historical), 11 + 1 + 24 + 1 + 13);
        let electra = ancestry_leaf_gindex(&SEPOLIA, gloas_slot - 1, gloas_slot - 50).unwrap();
        assert_eq!(gindex_depth(electra), 19);
    }

    /// Claim: the index of the execution block of a message source follows the proven SHAPE of the source state, not the
    /// fork schedule: the progressive shape reads 2856 (the bid `parent_block_hash`) also in a slot that the Ethereum
    /// schedule (Gloas at `FAR_FUTURE_EPOCH`) counts as Fulu; a plain shape reads the payload position, 812 in a Fulu or a
    /// Sepolia Gloas slot (a plain state is never Gloas) and 412 in a Capella slot. The layout function
    /// `block_hash_gindex_for_fork` stays closed to Gloas. Why it matters: this is the rule the bridge applies, and the
    /// schedule of a chain does not know a fork before it is scheduled.
    #[test]
    fn the_source_shape_picks_the_block_hash_index() {
        use crate::chain::{ETHEREUM_MAINNET, PULSECHAIN, SEPOLIA};
        let fulu_slot = 411_392 * 32 + 5;
        assert_eq!(message_block_hash_gindex_for_shape(&ETHEREUM_MAINNET, SHAPE_PROGRESSIVE, fulu_slot), Ok(2856));
        assert_eq!(message_block_hash_gindex_for_shape(&ETHEREUM_MAINNET, 6, fulu_slot), Ok(812));
        assert_eq!(message_block_hash_gindex_for_shape(&SEPOLIA, 6, 353_024 * 32 + 5), Ok(812));
        assert_eq!(message_block_hash_gindex_for_shape(&SEPOLIA, SHAPE_PROGRESSIVE, 353_024 * 32 + 5), Ok(2856));
        assert_eq!(message_block_hash_gindex_for_shape(&PULSECHAIN, 5, 10_872_000), Ok(412));
        assert_eq!(
            block_hash_gindex_for_fork(SEPOLIA.fork_at_slot(353_024 * 32)),
            Err(Error::GloasPayloadNotFinalized)
        );
    }

    /// Claim: `source_shape` follows `ForkShape.judge`. For each allowed shape, the honest proof of a state of that shape
    /// gives the shape. The proof of one shape never passes for a state of another shape, a wrong genesis validators root
    /// fails, an empty proof fails, and a valid proof of a plain depth 8 state (outside the list) fails. Why it matters:
    /// the shape picks the rule, so a proof that claims another shape than the state has would open the other rule.
    #[test]
    fn the_source_shape_is_proven_and_only_the_allowed_shapes_pass() {
        let root = B256::repeat_byte(0x5a);
        let states: Vec<(u8, ParsedStateLike)> =
            [5u8, 6, 7, SHAPE_PROGRESSIVE].iter().map(|shape| (*shape, state_of_shape(*shape, root))).collect();
        for (shape, state) in &states {
            assert_eq!(source_shape(&state.proof, &state.root, &root), Ok(*shape), "honest shape {shape}");
            assert_eq!(
                source_shape(&state.proof, &state.root, &B256::repeat_byte(0x5b)),
                Err(Error::InvalidForkShapeProof),
                "another chain, shape {shape}"
            );
            for (other, other_state) in &states {
                if other == shape {
                    continue;
                }
                assert_eq!(
                    source_shape(&other_state.proof, &state.root, &root),
                    Err(Error::InvalidForkShapeProof),
                    "the proof of shape {other} on a state of shape {shape}"
                );
            }
        }
        let empty =
            ForkProof { version: FixedBytes::ZERO, versionBranch: Vec::new(), genesisValidatorsRootBranch: Vec::new() };
        assert_eq!(source_shape(&empty, &states[0].1.root, &root), Err(Error::InvalidForkShapeProof));
        let deep = state_of_shape(8, root);
        assert_eq!(deep.proof.versionBranch.len(), 10, "a valid depth 8 proof");
        assert_eq!(source_shape(&deep.proof, &deep.root, &root), Err(Error::InvalidForkShapeProof));
    }

    /// Claim: the Rust list of allowed shapes is 5, 6, 7 and 255 in this order, the list of `ForkShape.allowedShapes`
    /// (`test/hardened/ForkRuleFromProof.t.sol` pins the Solidity side to the same values). Why it matters: the deposit gate
    /// and the message verifier must follow one list.
    #[test]
    fn the_allowed_shapes_are_the_list_of_the_contracts() {
        let shapes: Vec<u8> = ALLOWED_SHAPES.iter().map(|shape| shape.shape).collect();
        assert_eq!(shapes, vec![5, 6, 7, 255]);
    }

    /// A state and its fork proof.
    struct ParsedStateLike {
        root: B256,
        proof: ForkProof,
    }

    /// A state of `shape` (a plain depth, or 255) with distinct field roots, `genesis_validators_root` = `root`, and a
    /// `fork` field that holds the version `0x07000000` (progressive) or `0x06000000` (plain).
    fn state_of_shape(shape: u8, root: B256) -> ParsedStateLike {
        use crate::ssz::{merkleize, progressive_container_root};
        let progressive = shape == SHAPE_PROGRESSIVE;
        let count = if progressive { 46 } else { (1usize << shape) - 1 };
        let fork = ForkData {
            previous_version: [0x05, 0, 0, 0],
            current_version: if progressive { [0x07, 0, 0, 0] } else { [0x06, 0, 0, 0] },
            epoch: 364_032,
        };
        let mut fields: Vec<B256> = (0..count).map(|index| B256::with_last_byte(index as u8 ^ 0xa5)).collect();
        fields[1] = root;
        fields[3] = fork.hash_tree_root();
        let state_root = if progressive { progressive_container_root(&fields) } else { merkleize(&fields) };
        ParsedStateLike { root: state_root, proof: fork_proof_of_fields(&fields, progressive, &fork) }
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
