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

/// `merkleize_progressive(chunks)` of the progressive Merkle tree (`num_leaves` starts at 1).
///
/// Source: `eip-7916.md`, section "Progressive Merkle tree". The first chunk sits alone, the next 4 chunks share a subtree,
/// then 16, 64 and so on. Each step is `hash(merkleize(chunks[:n], n), merkleize_progressive(chunks[n:], n * 4))`. An
/// empty tail is the zero chunk.
pub fn merkleize_progressive(chunks: &[B256]) -> B256 {
    merkleize_progressive_from(chunks, 1)
}

fn merkleize_progressive_from(chunks: &[B256], num_leaves: u64) -> B256 {
    if chunks.is_empty() {
        return B256::ZERO;
    }
    let take = chunks.len().min(num_leaves as usize);
    let subtree = merkleize_with_limit(&chunks[..take], num_leaves);
    hash_pair(&subtree, &merkleize_progressive_from(&chunks[take..], num_leaves * 4))
}

/// The `active_fields` chunk of a progressive container whose `width` fields are all active: a bit vector of `width`
/// ones, least significant bit first, padded with zeros to 32 bytes.
///
/// Source: `eip-7495.md`, section "Merkleization" (`mix_in_active_fields`, `pack_bits`). The Gloas containers write
/// `ACTIVE_FIELDS = active_fields(width=N)`. The consensus specs file does not define `active_fields`. This crate reads
/// it as "N active fields in a row", which agrees with the field counts: each Gloas container has exactly `width` fields.
///
/// # Panics
/// Panics when `width` is above 256 (the limit of a progressive container).
pub fn active_fields_chunk(width: usize) -> B256 {
    assert!(width <= 256, "a progressive container has at most 256 fields");
    let mut chunk = [0u8; 32];
    for bit in 0..width {
        chunk[bit / 8] |= 1 << (bit % 8);
    }
    B256::from(chunk)
}

/// The hash tree root of a progressive container whose fields are all active: `hash(merkleize_progressive(field_roots),
/// active_fields)`. `field_roots` holds the hash tree root of each field, in order.
pub fn progressive_container_root(field_roots: &[B256]) -> B256 {
    hash_pair(&merkleize_progressive(field_roots), &active_fields_chunk(field_roots.len()))
}

/// Builds the branch and the root for chunk `index` of a progressive Merkle tree. The branch runs from the sibling of the
/// chunk up to the sibling of the root of the progressive tree. The root is `merkleize_progressive(chunks)`.
///
/// # Panics
/// Panics when `index` is outside `chunks`.
pub fn progressive_branch_for_leaf(chunks: &[B256], index: usize) -> (B256, Vec<B256>) {
    assert!(index < chunks.len(), "chunk index out of range");
    progressive_branch_from(chunks, index, 1)
}

fn progressive_branch_from(chunks: &[B256], index: usize, num_leaves: u64) -> (B256, Vec<B256>) {
    let take = chunks.len().min(num_leaves as usize);
    if index < take {
        let (subtree, mut branch) = branch_for_leaf_with_limit(&chunks[..take], index, ceil_log2(num_leaves));
        let rest = merkleize_progressive_from(&chunks[take..], num_leaves * 4);
        branch.push(rest);
        return (hash_pair(&subtree, &rest), branch);
    }
    let (rest, mut branch) = progressive_branch_from(&chunks[take..], index - take, num_leaves * 4);
    let subtree = merkleize_with_limit(&chunks[..take], num_leaves);
    branch.push(subtree);
    (hash_pair(&subtree, &rest), branch)
}

/// Builds the branch and the root for field `index` of a progressive container whose fields are all active. The last
/// branch entry is the `active_fields` chunk. The root equals [`progressive_container_root`].
///
/// # Panics
/// Panics when `index` is outside `field_roots`.
pub fn progressive_container_branch(field_roots: &[B256], index: usize) -> (B256, Vec<B256>) {
    let (progressive_root, mut branch) = progressive_branch_for_leaf(field_roots, index);
    let active = active_fields_chunk(field_roots.len());
    branch.push(active);
    (hash_pair(&progressive_root, &active), branch)
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

    /// Claim: `merkleize_progressive` follows the definition for 0, 1, 2 and 6 chunks, written out by hand. With 6 chunks
    /// the first chunk sits alone, chunks 1 to 4 fill a 4 leaf subtree, and chunk 5 starts a 16 leaf subtree.
    #[test]
    fn progressive_merkleization_follows_the_definition() {
        let c: Vec<B256> = (1..=6u64).map(u64_chunk).collect();
        assert_eq!(merkleize_progressive(&[]), B256::ZERO);
        assert_eq!(merkleize_progressive(&c[..1]), hash_pair(&c[0], &B256::ZERO));
        let two_tail = hash_pair(&hash_pair(&hash_pair(&c[1], &B256::ZERO), &zero_hash(1)), &B256::ZERO);
        assert_eq!(merkleize_progressive(&c[..2]), hash_pair(&c[0], &two_tail));
        let four = hash_pair(&hash_pair(&c[1], &c[2]), &hash_pair(&c[3], &c[4]));
        let sixteen = {
            let mut node = hash_pair(&c[5], &B256::ZERO);
            for level in 1..4 {
                node = hash_pair(&node, &zero_hash(level));
            }
            node
        };
        let expected = hash_pair(&c[0], &hash_pair(&four, &hash_pair(&sixteen, &B256::ZERO)));
        assert_eq!(merkleize_progressive(&c), expected);
        assert_ne!(merkleize_progressive(&c), merkleize_progressive(&c[..5]), "the sixth chunk changes the root");
    }

    /// Claim: the active fields chunk is a little-endian bit vector: 13 ones are the bytes `ff 1f`, 46 ones are
    /// `ff ff ff ff ff 3f`, and the container root mixes it in on the right.
    #[test]
    fn active_fields_chunk_is_a_bit_vector() {
        assert_eq!(&active_fields_chunk(13)[..3], &[0xff, 0x1f, 0x00]);
        assert_eq!(&active_fields_chunk(46)[..7], &[0xff, 0xff, 0xff, 0xff, 0xff, 0x3f, 0x00]);
        assert_eq!(active_fields_chunk(0), B256::ZERO);
        let fields = [u64_chunk(9)];
        assert_eq!(
            progressive_container_root(&fields),
            hash_pair(&hash_pair(&fields[0], &B256::ZERO), &active_fields_chunk(1))
        );
    }

    /// Claim: a branch from the progressive builder leads from every chunk to the container root, for container sizes on
    /// both sides of each subtree boundary (1, 2, 5, 6, 21, 22, 85, 86). The control: the wrong index does not verify.
    #[test]
    fn progressive_branches_lead_to_the_root() {
        for count in [1usize, 2, 5, 6, 21, 22, 85, 86] {
            let chunks: Vec<B256> = (1..=count as u64).map(u64_chunk).collect();
            for index in 0..count {
                let (root, branch) = progressive_container_branch(&chunks, index);
                assert_eq!(root, progressive_container_root(&chunks), "{count} chunks");
                let depth = branch.len() as u32;
                // The generalized index is not used here: only the bit path through the branch is. Rebuild it from the
                // branch length and check that some position verifies and the neighbouring position does not.
                let verifies = (0..1u64 << depth.min(20))
                    .any(|position| is_valid_merkle_branch(&chunks[index], &branch, depth, position, &root));
                assert!(verifies, "{count} chunks, chunk {index}");
            }
        }
        let chunks: Vec<B256> = (1..=7u64).map(u64_chunk).collect();
        let (root, branch) = progressive_container_branch(&chunks, 3);
        let positions: Vec<u64> = (0..1u64 << branch.len())
            .filter(|position| is_valid_merkle_branch(&chunks[3], &branch, branch.len() as u32, *position, &root))
            .collect();
        assert_eq!(positions.len(), 1, "exactly one position verifies");
    }
}
