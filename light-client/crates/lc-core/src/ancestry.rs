//! The beacon path of a withdrawal: from a finalized anchor to the execution block hash of the deposit block.
//!
//! The light client stores only finalized beacon headers, by slot. A deposit sits in an arbitrary earlier block.
//! The path is:
//!
//! 1. `hash_tree_root(anchor_header)` equals the stored header root of the anchor slot.
//! 2. `anchor.state_root` commits to `BeaconState.block_roots`. A branch from the root of the deposit header to the
//!    state root, at the generalized index of `block_roots[deposit_slot % 8192]`, proves the deposit header.
//! 3. `deposit.body_root` commits to `execution_payload.block_hash`. One combined branch (body field 9, then payload
//!    field 12) leads from the block hash to the body root. The full `ExecutionPayloadHeader` is never hashed.
//!
//! The window is `SLOTS_PER_HISTORICAL_ROOT` = 8192 slots (`get_block_root_at_slot` in `specs/phase0/beacon-chain.md`
//! asserts `slot < state.slot <= slot + SLOTS_PER_HISTORICAL_ROOT`). Older deposits need `historical_summaries`
//! (Capella and later). That path is not built: the proof returns `DepositOutsideHistoricalWindow`.
//! Every hash on this path is SHA-256, except the keccak256 of the execution header.
//!
//! Branches must have the exact length: padding is not accepted.

use crate::abi::{BeaconBlockHeader as AbiBeaconBlockHeader, WithdrawalProof};
use crate::chain::ChainSpec;
use crate::error::{Error, Result};
use crate::layout::{
    block_hash_gindex_for_fork, state_layout_for_fork, BLOCK_ROOTS_VECTOR_DEPTH, SLOTS_PER_HISTORICAL_ROOT,
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

/// The generalized index of `block_roots[slot % 8192]`, given the generalized index of the `block_roots` field.
pub fn block_roots_leaf_gindex(block_roots_field_gindex: u64, deposit_slot: u64) -> u64 {
    (block_roots_field_gindex << BLOCK_ROOTS_VECTOR_DEPTH) | (deposit_slot % SLOTS_PER_HISTORICAL_ROOT)
}

/// Verifies the beacon path and returns the execution block hash of the deposit block.
///
/// `stored_anchor_root` is what `lightClient.headers(anchorHeader.slot)` returns. Zero means "not stored".
///
/// # Errors
/// `AnchorNotStored`, `DepositOutsideHistoricalWindow`, `UnsupportedFork`, `InvalidBlockRootsBranch`, `InvalidBlockHashBranch`.
pub fn verify_beacon_path(spec: &ChainSpec, proof: &WithdrawalProof, stored_anchor_root: &B256) -> Result<B256> {
    let anchor = BeaconBlockHeader::from(&proof.anchorHeader);
    let deposit = BeaconBlockHeader::from(&proof.depositHeader);

    let anchor_root = anchor.hash_tree_root();
    if *stored_anchor_root == B256::ZERO || anchor_root != *stored_anchor_root {
        return Err(Error::AnchorNotStored);
    }
    if deposit.slot >= anchor.slot || anchor.slot - deposit.slot > SLOTS_PER_HISTORICAL_ROOT {
        return Err(Error::DepositOutsideHistoricalWindow { anchor_slot: anchor.slot, deposit_slot: deposit.slot });
    }

    let layout = state_layout_for_fork(spec.fork_at_slot(anchor.slot))?;
    let roots_gindex = block_roots_leaf_gindex(layout.block_roots_gindex, deposit.slot);
    if !is_valid_exact_branch(&deposit.hash_tree_root(), &proof.blockRootsBranch, roots_gindex, &anchor.state_root) {
        return Err(Error::InvalidBlockRootsBranch);
    }

    let block_hash = keccak256(&proof.executionHeaderRlp);
    let hash_gindex = block_hash_gindex_for_fork(spec.fork_at_slot(deposit.slot))?;
    if !is_valid_exact_branch(&block_hash, &proof.blockHashBranch, hash_gindex, &deposit.body_root) {
        return Err(Error::InvalidBlockHashBranch);
    }
    Ok(block_hash)
}
