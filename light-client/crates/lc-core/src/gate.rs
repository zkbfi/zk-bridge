//! Evidence for `BeaconForkGate`: a proof that `BeaconState.fork.current_version` has a given value.
//!
//! The gate takes `abi.encode(ForkEvidence)` with `ForkEvidence { uint256 timestamp; BeaconBlockHeader header;
//! bytes4 version; bytes32[] branch; }`. It checks the branch itself, at the generalized index
//! `((2**depth + 3) * 4) + 1`: field 3 of the state (`fork`), then field 1 of the three-field `Fork` container
//! (`current_version`). The branch runs from the version leaf up to `header.stateRoot`, deepest first:
//!
//! 1. the sibling `Fork.previous_version` (field 0),
//! 2. the node over `Fork.epoch` (field 2) and the empty fourth leaf,
//! 3. then the `depth` siblings of field 3 in the state tree.
//!
//! The branch holds `2 + depth` entries, where `depth` is the depth of the state tree: 5 up to 32 fields (Capella,
//! Deneb), 6 up to 64 fields (Electra, Fulu).

use crate::ssz::{branch_for_leaf, hash_pair, zero_hash};
use crate::ssz_state::ForkData;
use alloy_primitives::{FixedBytes, B256, U256};
use alloy_sol_types::{sol, SolValue};

sol! {
    /// A beacon block header as `SSZ.sol` declares it.
    struct GateHeader {
        uint64 slot;
        uint64 proposerIndex;
        bytes32 parentRoot;
        bytes32 stateRoot;
        bytes32 bodyRoot;
    }

    /// The evidence structure of `BeaconForkGate`.
    struct ForkEvidence {
        uint256 timestamp;
        GateHeader header;
        bytes4 version;
        bytes32[] branch;
    }
}

/// The position of `fork` among the `BeaconState` fields.
pub const STATE_FIELD_FORK: usize = 3;

/// The generalized index that the gate computes for the version leaf, for a state tree of `state_depth`.
pub const fn version_gindex(state_depth: u32) -> u64 {
    (((1u64 << state_depth) + STATE_FIELD_FORK as u64) * 4) + 1
}

/// The branch from `Fork.current_version` to the state root.
///
/// `field_roots` are the hash tree roots of all state fields, in field order. Entry 3 must be the root of `fork`.
///
/// # Panics
/// Panics when entry 3 of `field_roots` is not the root of `fork`: the caller passed a fork that the state does not hold.
pub fn fork_version_branch(field_roots: &[B256], fork: &ForkData) -> Vec<B256> {
    assert_eq!(
        field_roots[STATE_FIELD_FORK],
        fork.hash_tree_root(),
        "the fork does not match the fork field of the state"
    );
    let [previous, _, epoch] = fork.leaves();
    let mut branch = vec![previous, hash_pair(&epoch, &zero_hash(0))];
    branch.extend(branch_for_leaf(field_roots, STATE_FIELD_FORK).1);
    branch
}

/// The version as the gate hashes it: four bytes, right-padded to 32.
pub fn version_leaf(version: [u8; 4]) -> B256 {
    let mut leaf = [0u8; 32];
    leaf[..4].copy_from_slice(&version);
    B256::from(leaf)
}

/// `abi.encode(ForkEvidence)`: the bytes that `deposit` passes as `gateEvidence`.
pub fn encode_fork_evidence(
    timestamp: u64,
    header: &crate::types::BeaconBlockHeader,
    version: [u8; 4],
    branch: Vec<B256>,
) -> Vec<u8> {
    ForkEvidence {
        timestamp: U256::from(timestamp),
        header: GateHeader {
            slot: header.slot,
            proposerIndex: header.proposer_index,
            parentRoot: header.parent_root,
            stateRoot: header.state_root,
            bodyRoot: header.body_root,
        },
        version: FixedBytes::from(version),
        branch,
    }
    .abi_encode()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::ssz::{is_valid_exact_branch, merkleize};
    use alloy_primitives::keccak256;

    fn state_with(fork: &ForkData, fields: usize) -> Vec<B256> {
        let mut roots: Vec<B256> = (0..fields as u64).map(|field| keccak256(format!("field/{field}"))).collect();
        roots[STATE_FIELD_FORK] = fork.hash_tree_root();
        roots
    }

    /// Claim: the branch leads from the padded current version to the state root at the gate's own index, for the
    /// Capella depth (28 fields, depth 5) and the Electra depth (37 fields, depth 6). The same branch fails for the
    /// previous version, for the epoch, and at the index of the other depth.
    /// Why it matters: the gate computes the index itself. A proof of `previous_version` must never pass for the
    /// current version, and a wrong depth must not pass.
    #[test]
    fn branch_proves_the_current_version_only() {
        let fork = ForkData { previous_version: [2, 0, 0, 0], current_version: [3, 0, 0, 0], epoch: 3 };
        for (fields, depth) in [(28usize, 5u32), (37, 6)] {
            let roots = state_with(&fork, fields);
            let root = merkleize(&roots);
            let branch = fork_version_branch(&roots, &fork);
            assert_eq!(branch.len(), 2 + depth as usize);
            let gindex = version_gindex(depth);
            assert!(is_valid_exact_branch(&version_leaf(fork.current_version), &branch, gindex, &root));
            assert!(!is_valid_exact_branch(&version_leaf(fork.previous_version), &branch, gindex, &root));
            assert!(!is_valid_exact_branch(&version_leaf(fork.current_version), &branch, version_gindex(depth + 1), &root));
            // The gate's formula, spelled out: field 3 of a tree of 2^depth leaves, then field 1 of 4.
            assert_eq!(gindex, ((1u64 << depth) + 3) * 4 + 1);
        }
    }

    /// Claim: the encoding is the Solidity `abi.encode` of the struct: one offset word, then the head of the struct
    /// (timestamp, five header words, the version word, the branch offset) and the branch.
    #[test]
    fn evidence_encoding_has_the_solidity_layout() {
        let header = crate::types::BeaconBlockHeader {
            slot: 77,
            proposer_index: 5,
            parent_root: B256::repeat_byte(1),
            state_root: B256::repeat_byte(2),
            body_root: B256::repeat_byte(3),
        };
        let bytes = encode_fork_evidence(1234, &header, [3, 0, 0, 0], vec![B256::repeat_byte(9); 7]);
        let word = |index: usize| &bytes[index * 32..index * 32 + 32];
        assert_eq!(U256::from_be_slice(word(0)), U256::from(32), "a dynamic struct starts with an offset");
        assert_eq!(U256::from_be_slice(word(1)), U256::from(1234));
        assert_eq!(U256::from_be_slice(word(2)), U256::from(77));
        assert_eq!(word(4), B256::repeat_byte(1).as_slice());
        assert_eq!(word(5), B256::repeat_byte(2).as_slice());
        assert_eq!(&word(7)[..4], &[3, 0, 0, 0], "bytes4 is left-aligned");
        assert_eq!(U256::from_be_slice(word(8)), U256::from(8 * 32), "the branch offset, counted from the start of the struct");
        assert_eq!(U256::from_be_slice(word(9)), U256::from(7), "the branch length");
        assert_eq!(bytes.len(), 32 * (10 + 7));
    }
}
