//! The beacon path of a message proof, with the fork proof of the source state: from a finalized anchor to the execution
//! block hash of the source block.
//!
//! 1. `hash_tree_root(anchor_header)` equals the stored header root of the anchor slot.
//! 2. `anchor.state_root` commits to the source header, on the recent or the historical path that the two slots pick
//!    (`lc_core::ancestry`, [`ancestry_leaf_gindex`], which documents both paths).
//! 3. The fork proof of the source state (`MessageProof.sourceFork`, [`source_shape`]) proves the shape of the state
//!    under `source.state_root`, by the rule of `ForkShape.judge`: one of [`ALLOWED_SHAPES`], with the genesis validators
//!    root of the chain. The shape picks the rule of step 4. No fork slot is read for it: the chain schedule of the
//!    [`ChainSpec`] plays no part in the rule, so a fork that the schedule does not know yet is followed as soon as its
//!    first block is proven.
//! 4. `source.body_root` commits to the execution block hash. A plain shape (before Gloas):
//!    `execution_payload.block_hash`, one combined branch (body field 9, then payload field 12). The progressive shape
//!    (Gloas on): the `parent_block_hash` of the bid of the source block (index 2856), and the source block is a block
//!    AFTER the execution block (see `lc_core::layout::message_block_hash_gindex_for_fork` for the soundness argument).
//!    The full `ExecutionPayloadHeader` is never hashed.
//!
//! Every hash on this path is SHA-256, except the keccak256 of the execution header.
//!
//! Branches must have the exact length: padding is not accepted. A branch built for the other path has the wrong
//! length or the wrong index, so the bridge refuses it.

use super::abi::{BeaconBlockHeader as AbiBeaconBlockHeader, ForkProof, MessageProof};
use alloy_primitives::{keccak256, FixedBytes, B256};
use lc_core::ancestry::ancestry_leaf_gindex;
use lc_core::chain::{ChainSpec, ForkName};
use lc_core::gate::{fork_version_branch, progressive_fork_version_branch};
use lc_core::layout::{
    block_hash_gindex_for_fork, ContainerShape, ObservedShape, BLOCK_HASH_GINDEX_GLOAS,
    OBSERVED_SHAPE_PLAIN_DEPTH_FIVE, OBSERVED_SHAPE_PLAIN_DEPTH_SEVEN, OBSERVED_SHAPE_PLAIN_DEPTH_SIX,
    OBSERVED_SHAPE_PROGRESSIVE, SHAPE_PROGRESSIVE,
};
use lc_core::ssz::{branch_for_leaf, is_valid_exact_branch, progressive_container_branch};
use lc_core::ssz_state::{ForkData, ParsedState};
use lc_core::types::BeaconBlockHeader;
use lc_core::{Error, Result};

/// The state shapes that a message source may have, in the order in which `ForkShape.judge` tries them. It is the list
/// `ForkShape.allowedShapes` of the contracts: plain depth 5, 6 and 7, then the progressive form. A Solidity test and a
/// Rust test pin both lists to these values, so the deposit gate and the message verifier keep one list.
pub const ALLOWED_SHAPES: [ObservedShape; 4] = [
    OBSERVED_SHAPE_PLAIN_DEPTH_FIVE,
    OBSERVED_SHAPE_PLAIN_DEPTH_SIX,
    OBSERVED_SHAPE_PLAIN_DEPTH_SEVEN,
    OBSERVED_SHAPE_PROGRESSIVE,
];

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
    fork_proof_of_fields(&state.field_roots, state.shape != ContainerShape::Plain, &state.fork)
}

/// The fork proof of a state given by its field roots: a plain container, or the progressive one of Gloas.
///
/// # Panics
/// Panics when field 3 of `field_roots` is not the root of `fork`: the state does not hold that fork.
pub fn fork_proof_of_fields(field_roots: &[B256], progressive: bool, fork: &ForkData) -> ForkProof {
    let version_branch = match progressive {
        true => progressive_fork_version_branch(field_roots, fork),
        false => fork_version_branch(field_roots, fork),
    };
    let root_branch = match progressive {
        true => progressive_container_branch(field_roots, STATE_FIELD_GENESIS_VALIDATORS_ROOT).1,
        false => branch_for_leaf(field_roots, STATE_FIELD_GENESIS_VALIDATORS_ROOT).1,
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

    /// Claim: the index of the execution block of a message source follows the proven SHAPE of the source state, not the
    /// fork schedule: the progressive shape reads 2856 (the bid `parent_block_hash`) also in a slot that the Ethereum
    /// schedule (Gloas at `FAR_FUTURE_EPOCH`) counts as Fulu; a plain shape reads the payload position, 812 in a Fulu or a
    /// Sepolia Gloas slot (a plain state is never Gloas) and 412 in a Capella slot. The layout function
    /// `block_hash_gindex_for_fork` stays closed to Gloas. Why it matters: this is the rule the bridge applies, and the
    /// schedule of a chain does not know a fork before it is scheduled.
    #[test]
    fn the_source_shape_picks_the_block_hash_index() {
        use lc_core::chain::{ETHEREUM_MAINNET, PULSECHAIN, SEPOLIA};
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
        use lc_core::ssz::{merkleize, progressive_container_root};
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
}
