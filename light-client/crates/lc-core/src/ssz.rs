//! SimpleSerialize (SSZ) merkleization and Merkle branch verification.
//!
//! Every function is pure and has no dependency on the rest of the crate, so a contract or another
//! program can reuse it on its own. Every hash on these paths is SHA-256.

use alloy_primitives::B256;
use sha2::{Digest, Sha256};

/// SHA-256 of `data`.
pub fn sha256(data: &[u8]) -> B256 {
    B256::from_slice(&Sha256::digest(data))
}

/// SHA-256 of the concatenation of two 32-byte nodes: the parent of two tree nodes.
pub fn hash_pair(left: &B256, right: &B256) -> B256 {
    let mut hasher = Sha256::new();
    hasher.update(left.as_slice());
    hasher.update(right.as_slice());
    B256::from_slice(&hasher.finalize())
}

/// The root of an all-zero subtree of the given depth. Depth 0 is a single zero chunk.
pub fn zero_hash(depth: u32) -> B256 {
    let mut node = B256::ZERO;
    for _ in 0..depth {
        node = hash_pair(&node, &node);
    }
    node
}

/// Smallest `depth` such that `2^depth >= count`. Returns 0 for 0 and 1.
pub fn ceil_log2(count: u64) -> u32 {
    if count <= 1 {
        return 0;
    }
    64 - (count - 1).leading_zeros()
}

/// Merkleizes `chunks` as the leaves of a tree with `limit` leaves. Missing leaves count as zero chunks.
///
/// This is `merkleize(chunks, limit)` of the SSZ specification. It never builds the zero padding.
///
/// # Panics
/// Panics when `chunks.len() > limit`. Callers pass compile-time limits, so this is a programming error.
pub fn merkleize_with_limit(chunks: &[B256], limit: u64) -> B256 {
    assert!(chunks.len() as u64 <= limit, "more chunks than the SSZ limit");
    let depth = ceil_log2(limit);
    if chunks.is_empty() {
        return zero_hash(depth);
    }
    let mut layer = chunks.to_vec();
    for level in 0..depth {
        if layer.len() % 2 == 1 {
            layer.push(zero_hash(level));
        }
        layer = layer.chunks_exact(2).map(|pair| hash_pair(&pair[0], &pair[1])).collect();
    }
    layer[0]
}

/// Merkleizes `chunks` with the limit equal to the chunk count rounded up to a power of two.
/// This is the rule for containers and fixed-size vectors.
pub fn merkleize(chunks: &[B256]) -> B256 {
    merkleize_with_limit(chunks, chunks.len().max(1) as u64)
}

/// Mixes the length of a list into its root: `hash(root, length as 32-byte little endian)`.
pub fn mix_in_length(root: &B256, length: u64) -> B256 {
    let mut length_chunk = [0u8; 32];
    length_chunk[..8].copy_from_slice(&length.to_le_bytes());
    hash_pair(root, &B256::from(length_chunk))
}

/// The chunk of a `uint64`: little endian, zero padded.
pub fn u64_chunk(value: u64) -> B256 {
    let mut chunk = [0u8; 32];
    chunk[..8].copy_from_slice(&value.to_le_bytes());
    B256::from(chunk)
}

/// Splits `bytes` into zero padded 32-byte chunks. Empty input gives no chunks.
pub fn pack_bytes(bytes: &[u8]) -> Vec<B256> {
    bytes
        .chunks(32)
        .map(|piece| {
            let mut chunk = [0u8; 32];
            chunk[..piece.len()].copy_from_slice(piece);
            B256::from(chunk)
        })
        .collect()
}

/// Hash tree root of a fixed-size byte vector of any length (`ByteVector[N]`).
pub fn byte_vector_root(bytes: &[u8]) -> B256 {
    merkleize(&pack_bytes(bytes))
}

/// Hash tree root of a `ByteList[max_bytes]`.
pub fn byte_list_root(bytes: &[u8], max_bytes: u64) -> B256 {
    let limit = max_bytes.div_ceil(32);
    mix_in_length(&merkleize_with_limit(&pack_bytes(bytes), limit), bytes.len() as u64)
}

/// `floorlog2` of a generalized index: the depth of the node below the root.
pub const fn gindex_depth(gindex: u64) -> u32 {
    63 - gindex.leading_zeros()
}

/// The position of a generalized index among the nodes at its depth. This is `get_subtree_index`.
pub const fn gindex_subtree_index(gindex: u64) -> u64 {
    gindex - (1u64 << gindex_depth(gindex))
}

/// Verifies a Merkle branch. This is `is_valid_merkle_branch` of the consensus specs.
///
/// `branch[i]` is the sibling at height `i` above the leaf. It returns false when the branch is shorter than `depth`.
pub fn is_valid_merkle_branch(leaf: &B256, branch: &[B256], depth: u32, index: u64, root: &B256) -> bool {
    if branch.len() < depth as usize {
        return false;
    }
    let mut node = *leaf;
    for height in 0..depth {
        let sibling = &branch[height as usize];
        node = if (index >> height) & 1 == 1 { hash_pair(sibling, &node) } else { hash_pair(&node, sibling) };
    }
    node == *root
}

/// Verifies a branch against a generalized index and allows leading zero hashes. This is
/// `is_valid_normalized_merkle_branch` of the Altair light-client sync protocol.
///
/// A branch longer than the depth of the index is accepted only when the extra leading entries are zero.
pub fn is_valid_normalized_merkle_branch(leaf: &B256, branch: &[B256], gindex: u64, root: &B256) -> bool {
    let depth = gindex_depth(gindex) as usize;
    if branch.len() < depth {
        return false;
    }
    let extra = branch.len() - depth;
    if branch[..extra].iter().any(|entry| *entry != B256::ZERO) {
        return false;
    }
    is_valid_merkle_branch(leaf, &branch[extra..], depth as u32, gindex_subtree_index(gindex), root)
}

/// Verifies a branch against a generalized index. The branch must have exactly `floorlog2(gindex)` entries.
/// This is the check the bridge runs: no padding is accepted.
pub fn is_valid_exact_branch(leaf: &B256, branch: &[B256], gindex: u64, root: &B256) -> bool {
    let depth = gindex_depth(gindex);
    if branch.len() != depth as usize {
        return false;
    }
    is_valid_merkle_branch(leaf, branch, depth, gindex_subtree_index(gindex), root)
}

/// Builds the branch and the root for leaf `index` of a tree over `leaves`, padded with zero chunks to a power of two.
/// Used to build test fixtures and by callers that need a proof from known leaves.
///
/// # Panics
/// Panics when `index` is outside `leaves`.
pub fn branch_for_leaf(leaves: &[B256], index: usize) -> (B256, Vec<B256>) {
    assert!(index < leaves.len(), "leaf index out of range");
    let depth = ceil_log2(leaves.len() as u64);
    let mut layer = leaves.to_vec();
    let mut position = index;
    let mut branch = Vec::new();
    for level in 0..depth {
        if layer.len() % 2 == 1 {
            layer.push(zero_hash(level));
        }
        branch.push(layer[position ^ 1]);
        layer = layer.chunks_exact(2).map(|pair| hash_pair(&pair[0], &pair[1])).collect();
        position /= 2;
    }
    (layer[0], branch)
}

/// Builds the branch and the root for leaf `index` of a list-shaped tree with `depth` levels over `leaves`.
/// Missing leaves count as zero chunks, so the tree can be far larger than `leaves` (a list limit of `2^depth`).
/// The root is the data root of the list, before the length mix-in. It equals `merkleize_with_limit(leaves, 1 << depth)`.
///
/// # Panics
/// Panics when `index` is outside `leaves` or when `leaves` does not fit in `2^depth` leaves.
pub fn branch_for_leaf_with_limit(leaves: &[B256], index: usize, depth: u32) -> (B256, Vec<B256>) {
    assert!(index < leaves.len(), "leaf index out of range");
    assert!((leaves.len() as u64) <= (1u64 << depth), "more leaves than the limit");
    let mut layer = leaves.to_vec();
    let mut position = index;
    let mut branch = Vec::with_capacity(depth as usize);
    for level in 0..depth {
        if layer.len() % 2 == 1 {
            layer.push(zero_hash(level));
        }
        branch.push(layer[position ^ 1]);
        layer = layer.chunks_exact(2).map(|pair| hash_pair(&pair[0], &pair[1])).collect();
        position /= 2;
    }
    (layer[0], branch)
}

#[cfg(test)]
mod tests {
    use super::*;
    use alloy_primitives::b256;

    /// Claim: the zero hashes match the published SSZ zero-hash table. If this were wrong, every list root would be wrong.
    #[test]
    fn zero_hashes_match_the_published_table() {
        assert_eq!(zero_hash(0), B256::ZERO);
        assert_eq!(zero_hash(1), b256!("f5a5fd42d16a20302798ef6ed309979b43003d2320d9f0e8ea9831a92759fb4b"));
        assert_eq!(zero_hash(2), b256!("db56114e00fdd4c1f85c892bf35ac9a89289aaecb1ebd0a96cde606a748b5d71"));
    }

    /// Claim: limit-based merkleization with a large limit equals merkleization of the explicit zero padding.
    #[test]
    fn limit_merkleization_equals_explicit_padding() {
        let chunks: Vec<B256> = (1..=3u64).map(u64_chunk).collect();
        let mut padded = chunks.clone();
        padded.resize(16, B256::ZERO);
        assert_eq!(merkleize_with_limit(&chunks, 16), merkleize(&padded));
        assert_ne!(merkleize_with_limit(&chunks, 16), merkleize_with_limit(&chunks, 32));
    }

    /// Claim: a branch built for each leaf verifies, and fails for another index. The failing case shows the check can fail.
    #[test]
    fn branch_roundtrip_for_every_leaf() {
        let leaves: Vec<B256> = (0..7u64).map(u64_chunk).collect();
        for index in 0..leaves.len() {
            let (root, branch) = branch_for_leaf(&leaves, index);
            assert_eq!(root, merkleize(&leaves));
            assert!(is_valid_merkle_branch(&leaves[index], &branch, 3, index as u64, &root));
            assert!(!is_valid_merkle_branch(&leaves[index], &branch, 3, (index as u64 + 1) % 8, &root));
        }
    }

    /// Claim: a branch through a tree much larger than its leaves (a list with a limit) ends at the same root as
    /// `merkleize_with_limit`, and every leaf verifies against that root at depth 24. Zero padding is part of the tree.
    #[test]
    fn limit_branch_matches_limit_merkleization() {
        let leaves: Vec<B256> = (1..=5u64).map(u64_chunk).collect();
        for index in 0..leaves.len() {
            let (root, branch) = branch_for_leaf_with_limit(&leaves, index, 24);
            assert_eq!(branch.len(), 24);
            assert_eq!(root, merkleize_with_limit(&leaves, 1 << 24));
            assert!(is_valid_merkle_branch(&leaves[index], &branch, 24, index as u64, &root));
            assert!(!is_valid_merkle_branch(&leaves[index], &branch, 24, index as u64 + 1, &root));
        }
    }

    /// Claim: a normalized branch accepts leading zero padding and rejects non-zero padding.
    #[test]
    fn normalized_branch_pads_with_zero_only() {
        let leaves: Vec<B256> = (0..8u64).map(u64_chunk).collect();
        let (root, branch) = branch_for_leaf(&leaves, 5);
        let gindex = 8 + 5;
        assert!(is_valid_normalized_merkle_branch(&leaves[5], &branch, gindex, &root));
        let mut padded = vec![B256::ZERO];
        padded.extend(&branch);
        assert!(is_valid_normalized_merkle_branch(&leaves[5], &padded, gindex, &root));
        padded[0] = u64_chunk(1);
        assert!(!is_valid_normalized_merkle_branch(&leaves[5], &padded, gindex, &root));
    }

    /// Claim: `gindex_depth` and `gindex_subtree_index` agree with the spec for gindex 105 (depth 6, index 41).
    #[test]
    fn gindex_helpers() {
        assert_eq!(gindex_depth(105), 6);
        assert_eq!(gindex_subtree_index(105), 41);
        assert_eq!(gindex_depth(1), 0);
    }

    /// Claim: a byte list root mixes in the length, so two lists with the same chunks and different lengths differ.
    #[test]
    fn byte_list_root_mixes_length() {
        assert_ne!(byte_list_root(&[1, 0], 32), byte_list_root(&[1], 32));
        assert_eq!(byte_list_root(&[], 32), mix_in_length(&zero_hash(0), 0));
    }
}
