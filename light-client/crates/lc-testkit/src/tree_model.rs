//! A model of a Merkle tree with a known shape, for tests that walk a generalized index through the TRUE tree of a state and
//! report the node it lands on.
//!
//! A leaf of the model is a chunk that has no known structure below it: the `active_fields` chunk of a progressive state, a
//! padding chunk, or the root of a field. A claim that lies below a leaf cannot be honest, because no hash chain ends on a
//! value that is no hash.

use alloy_primitives::B256;
use lc_core::ssz::{active_fields_chunk, gindex_depth, hash_pair, sha256};

/// A Merkle tree with a known shape.
pub enum Tree {
    /// A leaf with its value.
    Leaf(B256),
    /// A node with a left child and a right child.
    Pair(Box<Tree>, Box<Tree>),
}

impl Tree {
    /// The value of the node.
    pub fn root(&self) -> B256 {
        match self {
            Self::Leaf(value) => *value,
            Self::Pair(left, right) => hash_pair(&left.root(), &right.root()),
        }
    }
}

/// A balanced tree over `nodes`, whose count is a power of two.
pub fn balanced(mut nodes: Vec<Tree>) -> Tree {
    assert!(nodes.len().is_power_of_two(), "a balanced tree needs a power of two nodes");
    while nodes.len() > 1 {
        let mut parents = Vec::with_capacity(nodes.len() / 2);
        let mut children = nodes.into_iter();
        while let (Some(left), Some(right)) = (children.next(), children.next()) {
            parents.push(Tree::Pair(Box::new(left), Box::new(right)));
        }
        nodes = parents;
    }
    nodes.pop().expect("one node is left")
}

/// The progressive tree of `chunks` (`eip-7916`): a subtree of `leaves` chunks on the left, the rest (with four times the
/// leaves) on the right, and the zero chunk for an empty rest.
pub fn progressive_tree(chunks: &[B256], leaves: usize) -> Tree {
    if chunks.is_empty() {
        return Tree::Leaf(B256::ZERO);
    }
    let take = chunks.len().min(leaves);
    let mut nodes: Vec<Tree> = chunks[..take].iter().map(|chunk| Tree::Leaf(*chunk)).collect();
    nodes.resize_with(leaves, || Tree::Leaf(B256::ZERO));
    Tree::Pair(Box::new(balanced(nodes)), Box::new(progressive_tree(&chunks[take..], leaves * 4)))
}

/// The tree of a progressive state: the progressive tree on the left (node 2) and the `active_fields` chunk on the right
/// (node 3). The fields are the leaves.
pub fn progressive_state_tree(field_roots: &[B256]) -> Tree {
    Tree::Pair(Box::new(progressive_tree(field_roots, 1)), Box::new(Tree::Leaf(active_fields_chunk(field_roots.len()))))
}

/// The tree of a plain state of `depth`: the field roots, then zero chunks up to `2^depth` leaves.
///
/// # Panics
/// Panics when the fields do not fit in `2^depth` leaves.
pub fn plain_state_tree(field_roots: &[B256], depth: u32) -> Tree {
    assert!(field_roots.len() <= 1usize << depth, "the fields must fit in the leaves of the tree");
    let mut nodes: Vec<Tree> = field_roots.iter().map(|root| Tree::Leaf(*root)).collect();
    nodes.resize_with(1usize << depth, || Tree::Leaf(B256::ZERO));
    balanced(nodes)
}

/// The result of a walk of a generalized index through a tree.
pub struct Walk {
    /// The generalized index of the node at which the walk stopped: a leaf, or the claimed node itself.
    pub leaf_gindex: u64,
    /// The value of that node.
    pub leaf_value: B256,
    /// How many levels the claimed index lies below that leaf. Zero when the walk ended on the node itself.
    pub levels_below: u32,
    /// The siblings along the path while a node existed, from the top down.
    pub real_siblings: Vec<B256>,
}

/// Walks `gindex` from the root of `tree`, and stops at the first leaf.
pub fn walk(tree: &Tree, gindex: u64) -> Walk {
    let depth = gindex_depth(gindex);
    let mut node = tree;
    let mut position = 1u64;
    let mut real_siblings = Vec::new();
    for level in 0..depth {
        let Tree::Pair(left, right) = node else {
            return Walk { leaf_gindex: position, leaf_value: node.root(), levels_below: depth - level, real_siblings };
        };
        let went_right = (gindex >> (depth - 1 - level)) & 1 == 1;
        let (next, sibling) = if went_right { (right, left) } else { (left, right) };
        real_siblings.push(sibling.root());
        position = position * 2 + u64::from(went_right);
        node = next;
    }
    Walk { leaf_gindex: position, leaf_value: node.root(), levels_below: 0, real_siblings }
}

/// The best honest-looking branch: the real siblings while a node exists, then filler below the leaf where the walk
/// stopped. The order is bottom up, as the verifier reads it.
pub fn honest_looking_branch(walk: &Walk) -> Vec<B256> {
    let fillers = (0..u64::from(walk.levels_below)).map(|index| sha256(format!("below-the-leaf/{index}").as_bytes()));
    let mut top_down = walk.real_siblings.clone();
    top_down.extend(fillers);
    top_down.reverse();
    top_down
}
