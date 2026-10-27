//! State proofs with a wrong depth claim: the layout comes from the length of the finality branch, so an attacker can
//! name any allowed layout for any state. Every pair of claimed layout and true layout must land on a node that no honest
//! leaf can fill: a basic leaf, a padding chunk, a hash-only node or a fixed-shape container (the soundness table of
//! `docs/hardened-build-contract.md`).
//!
//! The tests compute the landing node by walking the claimed generalized index through the TRUE tree, and then run the
//! real checks (`is_valid_exact_branch`, `verify_light_client_update`) on the best branch an attacker can build.
//!
//! - Part A: the real Sepolia Gloas state (progressive form) against the claimed plain layouts.
//! - Part B: synthetic plain states of depth 5 and depth 6 against the other allowed layouts.
//! - Part C: real honest data, cut or padded to the wrong length.
//! - Part D: the length rules as unit tests, and mixed lengths in one step.
//! - Part E: the control with a state of 70 fields (depth 7).
//!
//! Every attack test has a control: the honest case passes.

use alloy_primitives::B256;
use lc_core::chain::{ChainSpec, ForkName, ETHEREUM_MAINNET, PULSECHAIN, SEPOLIA};
use lc_core::layout::{
    path_gindex, plain_state_layout, state_layout_for_finality_branch_length, StateLayout,
    ALLOWED_FINALITY_BRANCH_LENGTHS, BEACON_STATE_GLOAS, BLOCK_ROOTS_FIELD_INDEX, FORK, FORK_VERSION_GINDEX_GLOAS,
    HISTORICAL_SUMMARIES_FIELD_INDEX,
};
use lc_core::ssz::{
    active_fields_chunk, branch_for_leaf, gindex_depth, hash_pair, is_valid_exact_branch,
    is_valid_normalized_merkle_branch, merkleize, sha256, u64_chunk, zero_hash,
};
use lc_core::ssz_state::{state_slot, try_parse_state_for_fork, ParsedState};
use lc_core::types::{LightClientHeader, LightClientStore, LightClientUpdate, NextSyncCommittee};
use lc_core::update::{table_fork_version, verify_light_client_update, verify_light_client_update_with_fork_version};
use lc_core::Error;
use lc_testkit::json::{
    bootstrap, fixtures_dir, light_client_update, load_fixture, load_response, store_from_bootstrap,
};
use lc_testkit::pulsechain::real_update_and_store;
use lc_testkit::synthetic::{build_update, committee_for, StateBuilder, UpdateRecipe, UpdateScenario};

// ---------------------------------------------------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------------------------------------------------

/// A deterministic filler hash: the "arbitrary" entries of an attacker branch and the leaves of the wide state.
fn filler(label: &str, index: u64) -> B256 {
    sha256(format!("{label}/{index}").as_bytes())
}

/// The recipe of the synthetic PulseChain update (Capella layout, true depth 5).
fn pulsechain_recipe() -> UpdateRecipe {
    UpdateRecipe {
        store_slot: 10_871_000,
        finalized_slot: 10_872_000,
        attested_slot: 10_872_070,
        signature_slot: 10_872_071,
        participants: 400,
        include_next_committee: true,
        store_knows_next_committee: false,
    }
}

/// The recipe of the synthetic Ethereum update (Fulu, Electra layout, true depth 6).
fn ethereum_recipe() -> UpdateRecipe {
    UpdateRecipe {
        store_slot: 15_475_000,
        finalized_slot: 15_476_000,
        attested_slot: 15_476_070,
        signature_slot: 15_476_071,
        participants: 400,
        include_next_committee: true,
        store_knows_next_committee: false,
    }
}

/// Runs `verify_light_client_update` on a scenario with a replaced update.
fn verify(scenario: &UpdateScenario, update: &LightClientUpdate) -> Result<lc_core::abi::LightClientOutput, Error> {
    verify_light_client_update(&scenario.store, update, scenario.spec)
}

/// A copy of `update` with another finality branch.
fn with_finality_branch(update: &LightClientUpdate, branch: Vec<B256>) -> LightClientUpdate {
    LightClientUpdate { finality_branch: branch, ..update.clone() }
}

/// A copy of `update` with another next committee branch. The update must carry a next committee.
fn with_next_committee_branch(update: &LightClientUpdate, branch: Vec<B256>) -> LightClientUpdate {
    let next = update.next_sync_committee.as_ref().expect("the update proves the next committee");
    LightClientUpdate {
        next_sync_committee: Some(NextSyncCommittee { committee: next.committee.clone(), branch }),
        ..update.clone()
    }
}

/// `entries` copies of the zero hash: the padding that the old rule stripped.
fn zero_entries(entries: usize) -> Vec<B256> {
    vec![B256::ZERO; entries]
}

/// The branches of `length` entries that an attacker builds from the honest branch of another length.
///
/// A longer length: filler at the bottom, filler at the top, and zeros at the bottom (the padding of the old rule). A
/// shorter length: the bottom entries cut, and the top entries cut. The honest entries stay in order, so the branch is the
/// best honest-looking branch for a claim of that length.
fn attacker_branches(honest: &[B256], length: usize) -> Vec<Vec<B256>> {
    let extra = length.saturating_sub(honest.len());
    let filler_entries: Vec<B256> = (0..extra as u64).map(|index| filler("attacker-entry", index)).collect();
    match length.cmp(&honest.len()) {
        std::cmp::Ordering::Less => {
            let cut = honest.len() - length;
            vec![honest[cut..].to_vec(), honest[..length].to_vec()]
        }
        std::cmp::Ordering::Equal => vec![honest.to_vec()],
        std::cmp::Ordering::Greater => vec![
            [filler_entries.clone(), honest.to_vec()].concat(),
            [honest.to_vec(), filler_entries].concat(),
            [zero_entries(extra), honest.to_vec()].concat(),
        ],
    }
}

/// Which node of the layout a claim names.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum LayoutIndex {
    /// `finalized_checkpoint.root`.
    Finality,
    /// `current_sync_committee`.
    CurrentCommittee,
    /// `next_sync_committee`.
    NextCommittee,
}

impl LayoutIndex {
    /// The generalized index that `layout` holds for this node.
    fn gindex_in(self, layout: &StateLayout) -> u64 {
        match self {
            Self::Finality => layout.finalized_root_gindex,
            Self::CurrentCommittee => layout.current_sync_committee_gindex,
            Self::NextCommittee => layout.next_sync_committee_gindex,
        }
    }
}

/// One step down a tree: to the left child or to the right child.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum Step {
    /// The left child. For an SSZ list root this is the data root.
    Left,
    /// The right child. For an SSZ list root this is the length.
    Right,
}

/// The first step below a node, for a generalized index that lies `levels_below` levels under that node.
fn first_step_below(gindex: u64, levels_below: u32) -> Step {
    assert!(levels_below > 0, "the index must lie below the node");
    match (gindex >> (levels_below - 1)) & 1 {
        0 => Step::Left,
        _ => Step::Right,
    }
}

// ---------------------------------------------------------------------------------------------------------------------
// The landing walker for plain states (parts B, C and E)
// ---------------------------------------------------------------------------------------------------------------------

/// The field names of a plain `BeaconState`, in specification order. Phase0 and Altair give fields 0 to 23 (the same names
/// as the first 24 fields of the Gloas list), Capella adds 24 to 27, Electra adds 28 to 36 and Fulu adds 37.
fn plain_state_fields(fork: ForkName) -> Vec<&'static str> {
    let capella = [
        "latest_execution_payload_header",
        "next_withdrawal_index",
        "next_withdrawal_validator_index",
        "historical_summaries",
    ];
    let electra = [
        "deposit_requests_start_index",
        "deposit_balance_to_consume",
        "exit_balance_to_consume",
        "earliest_exit_epoch",
        "consolidation_balance_to_consume",
        "earliest_consolidation_epoch",
        "pending_deposits",
        "pending_partial_withdrawals",
        "pending_consolidations",
    ];
    let mut fields: Vec<&'static str> = BEACON_STATE_GLOAS.fields[..24].to_vec();
    fields.extend(capella);
    match fork {
        ForkName::Capella | ForkName::Deneb => fields,
        ForkName::Electra => [fields, electra.to_vec()].concat(),
        ForkName::Fulu => [fields, electra.to_vec(), vec!["proposer_lookahead"]].concat(),
        other => panic!("no plain field list for {other:?}"),
    }
}

/// Where a generalized index lands in a plain state tree.
#[derive(Clone, Debug, PartialEq, Eq)]
enum PlainLanding {
    /// At the root of a field (`levels_below` is 0) or inside it.
    Field {
        /// The field name.
        name: &'static str,
        /// How many levels the index lies below the root of the field.
        levels_below: u32,
    },
    /// On a padding chunk (a leaf position without a field), or below one.
    Padding {
        /// How many levels the index lies below the padding leaf.
        levels_below: u32,
    },
    /// On a node above padding leaves only. Its value is the zero hash of that level, a hash that nothing can open.
    HashOnly {
        /// The levels between the node and the leaves.
        level: u32,
    },
    /// On a node above at least one real field. Its value is a hash of field roots.
    Fields {
        /// The levels between the node and the leaves.
        level: u32,
    },
}

/// Walks `gindex` through a plain state tree of `depth` over `fields`, and reports the node it lands on.
fn plain_landing(gindex: u64, depth: u32, fields: &[&'static str]) -> PlainLanding {
    let claim_depth = gindex_depth(gindex);
    match claim_depth.cmp(&depth) {
        std::cmp::Ordering::Less => {
            let level = depth - claim_depth;
            let first_leaf = (gindex << level) - (1u64 << depth);
            match first_leaf < fields.len() as u64 {
                true => PlainLanding::Fields { level },
                false => PlainLanding::HashOnly { level },
            }
        }
        _ => {
            let levels_below = claim_depth - depth;
            let position = (gindex >> levels_below) - (1u64 << depth);
            match fields.get(position as usize) {
                Some(name) => PlainLanding::Field { name, levels_below },
                None => PlainLanding::Padding { levels_below },
            }
        }
    }
}

/// A claim of a layout on a state of another depth: the layout the attacker names, the node, the index that the program
/// tests, and the landing node that the soundness table gives.
struct WrongDepthClaim {
    /// The length of the finality branch that names the claimed layout.
    finality_length: usize,
    /// The node of the claimed layout.
    which: LayoutIndex,
    /// The claimed generalized index, written as the literal of the specification.
    gindex: u64,
    /// The landing node in the true tree.
    landing: PlainLanding,
    /// For a list field: the first step below the field root (left is the data root, right is the length).
    first_step: Option<Step>,
}

/// A claim that lands inside or on a field.
fn claim_on_field(
    finality_length: usize,
    which: LayoutIndex,
    gindex: u64,
    name: &'static str,
    levels_below: u32,
) -> WrongDepthClaim {
    WrongDepthClaim {
        finality_length,
        which,
        gindex,
        landing: PlainLanding::Field { name, levels_below },
        first_step: None,
    }
}

impl WrongDepthClaim {
    /// The same claim, with the first step below the field root named.
    fn first_step(self, step: Step) -> Self {
        Self { first_step: Some(step), ..self }
    }
}

/// The honest facts of a plain state built by `StateBuilder`: the leaf and the branch for each node of the layout.
struct HonestPlainState {
    /// The state builder.
    builder: StateBuilder,
    /// The root of the finalized header (the leaf of the finality branch).
    finalized_root: B256,
    /// The epoch of the finalized checkpoint.
    epoch: u64,
    /// The root of the current committee.
    current_root: B256,
    /// The root of the next committee.
    next_root: B256,
}

impl HonestPlainState {
    /// A state of `fork` that holds a finalized checkpoint and both committees.
    fn new(fork: ForkName) -> Self {
        let current = committee_for(&PULSECHAIN, 1);
        let next = committee_for(&PULSECHAIN, 2);
        let finalized_root = filler("finalized-header", 0);
        let epoch = 330_000;
        let mut builder = StateBuilder::new(fork);
        builder.set_finalized_checkpoint(epoch, finalized_root);
        builder.set_current_committee(&current.committee);
        builder.set_next_committee(&next.committee);
        Self {
            builder,
            finalized_root,
            epoch,
            current_root: current.committee.hash_tree_root().expect("committee root"),
            next_root: next.committee.hash_tree_root().expect("committee root"),
        }
    }

    /// The honest leaf and branch for a node.
    fn leaf_and_branch(&self, which: LayoutIndex) -> (B256, Vec<B256>) {
        match which {
            LayoutIndex::Finality => (self.finalized_root, self.builder.finality_branch(self.epoch)),
            LayoutIndex::CurrentCommittee => (self.current_root, self.builder.current_committee_branch()),
            LayoutIndex::NextCommittee => (self.next_root, self.builder.next_committee_branch()),
        }
    }
}

/// Asserts, on the state builder, that the honest branch passes at the true index and that every attacker branch of the
/// claimed length is refused at the claimed index against the state root.
fn assert_claim_refused_on_state(state: &HonestPlainState, true_depth: u32, claim: &WrongDepthClaim) {
    let (leaf, honest) = state.leaf_and_branch(claim.which);
    let root = state.builder.root();
    let true_gindex = claim.which.gindex_in(&plain_state_layout(true_depth));
    assert!(is_valid_exact_branch(&leaf, &honest, true_gindex, &root), "control: the honest branch at {true_gindex}");
    let length = gindex_depth(claim.gindex) as usize;
    for branch in attacker_branches(&honest, length) {
        assert_eq!(branch.len(), length);
        assert!(
            !is_valid_exact_branch(&leaf, &branch, claim.gindex, &root),
            "{:?} claimed at {}: an attacker branch verified",
            claim.which,
            claim.gindex
        );
    }
}

/// Asserts, on a synthetic update, that every attacker branch of the claimed length is refused by
/// `verify_light_client_update` with `expected`. A finality claim replaces the finality branch. A next committee claim
/// keeps the honest finality branch and replaces the committee branch (the layout is then the true one, and the length of
/// the committee branch no longer matches it). The current committee is no part of an update: nothing to run.
fn assert_claim_refused_in_update(scenario: &UpdateScenario, claim: &WrongDepthClaim) {
    let length = gindex_depth(claim.gindex) as usize;
    let updates: Vec<LightClientUpdate> = match claim.which {
        LayoutIndex::CurrentCommittee => return,
        LayoutIndex::Finality => attacker_branches(&scenario.update.finality_branch, length)
            .into_iter()
            .map(|branch| with_finality_branch(&scenario.update, branch))
            .collect(),
        LayoutIndex::NextCommittee => {
            let honest = &scenario.update.next_sync_committee.as_ref().expect("a next committee").branch;
            attacker_branches(honest, length)
                .into_iter()
                .map(|branch| with_next_committee_branch(&scenario.update, branch))
                .collect()
        }
    };
    let expected = match claim.which {
        LayoutIndex::NextCommittee => Error::InvalidNextSyncCommitteeBranch,
        _ => Error::InvalidFinalityBranch,
    };
    for update in updates {
        assert_eq!(verify(scenario, &update), Err(expected.clone()), "{:?} claimed at {}", claim.which, claim.gindex);
    }
}

/// Runs the whole check of one true depth: the claimed pair is the one the program tests, the landing node equals the
/// table row, and the attacker branches are refused on the state builder and in a full update.
fn check_wrong_depth_claims(
    spec: &'static ChainSpec,
    recipe: UpdateRecipe,
    fork: ForkName,
    true_depth: u32,
    claims: &[WrongDepthClaim],
) {
    let fields = plain_state_fields(fork);
    let scenario = build_update(spec, recipe);
    assert!(verify(&scenario, &scenario.update).is_ok(), "control: the honest update verifies");
    assert_eq!(
        scenario.update.finality_branch.len(),
        true_depth as usize + 1,
        "the true layout names length depth + 1"
    );
    let state = HonestPlainState::new(fork);
    for claim in claims {
        let layout = state_layout_for_finality_branch_length(claim.finality_length).expect("an allowed length");
        assert_eq!(
            claim.which.gindex_in(&layout),
            claim.gindex,
            "the program tests index {} for a finality branch of {} entries",
            claim.gindex,
            claim.finality_length
        );
        let landing = plain_landing(claim.gindex, true_depth, &fields);
        assert_eq!(landing, claim.landing, "index {} on a true depth {true_depth} state", claim.gindex);
        if let (PlainLanding::Field { levels_below, .. }, Some(step)) = (&landing, claim.first_step) {
            assert_eq!(first_step_below(claim.gindex, *levels_below), step, "index {}: side of the list", claim.gindex);
        }
        assert_claim_refused_on_state(&state, true_depth, claim);
        assert_claim_refused_in_update(&scenario, claim);
    }
}

// ---------------------------------------------------------------------------------------------------------------------
// Part A: the real Sepolia Gloas state against claimed plain layouts
// ---------------------------------------------------------------------------------------------------------------------

/// A Merkle tree with a known shape. A leaf is a chunk that has no known structure below it: the `active_fields` chunk, a
/// padding chunk, or the root of a field.
enum Tree {
    /// A leaf with its value.
    Leaf(B256),
    /// A node with a left child and a right child.
    Pair(Box<Tree>, Box<Tree>),
}

impl Tree {
    /// The value of the node.
    fn root(&self) -> B256 {
        match self {
            Self::Leaf(value) => *value,
            Self::Pair(left, right) => hash_pair(&left.root(), &right.root()),
        }
    }
}

/// A balanced tree over `nodes`, whose count is a power of two.
fn balanced(mut nodes: Vec<Tree>) -> Tree {
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
fn progressive_tree(chunks: &[B256], leaves: usize) -> Tree {
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
fn gloas_state_tree(state: &ParsedState) -> Tree {
    Tree::Pair(
        Box::new(progressive_tree(&state.field_roots, 1)),
        Box::new(Tree::Leaf(active_fields_chunk(state.field_roots.len()))),
    )
}

/// The result of a walk of a generalized index through a tree.
struct Walk {
    /// The generalized index of the leaf at which the walk stopped.
    leaf_gindex: u64,
    /// The value of that leaf.
    leaf_value: B256,
    /// How many levels the claimed index lies below that leaf. Zero when the walk ended on the node itself.
    levels_below: u32,
    /// The siblings along the path while a node existed, from the top down.
    real_siblings: Vec<B256>,
}

/// Walks `gindex` from the root of `tree`, and stops at the first leaf.
fn walk(tree: &Tree, gindex: u64) -> Walk {
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
fn honest_looking_branch(walk: &Walk) -> Vec<B256> {
    let fillers = (0..u64::from(walk.levels_below)).map(|index| filler("below-the-leaf", index));
    let mut top_down = walk.real_siblings.clone();
    top_down.extend(fillers);
    top_down.reverse();
    top_down
}

/// The real Sepolia Gloas state (progressive form, 46 fields).
fn real_gloas_state() -> ParsedState {
    let bytes = std::fs::read(fixtures_dir().join("sepolia/gloas_head_state.ssz")).expect("the state fixture");
    let slot = state_slot(&bytes).expect("a slot");
    assert_eq!(SEPOLIA.fork_at_slot(slot), ForkName::Gloas, "the fixture is a Gloas state");
    try_parse_state_for_fork(&bytes, ForkName::Gloas).expect("the real Gloas state parses")
}

/// The real finality update of the Sepolia head.
fn real_gloas_head_update() -> LightClientUpdate {
    let response = load_response("sepolia/gloas_head_finality_update.json");
    assert_eq!(response["version"].as_str(), Some("gloas"));
    light_client_update(&response["data"])
}

/// Where a claim lands in the real Gloas state.
enum GloasLanding {
    /// Node 3: the `active_fields` chunk, a leaf that is no hash.
    ActiveFieldsChunk,
    /// Inside a field, or on its root: the field name and the levels below the field root.
    StateField {
        /// The field name in `BEACON_STATE_GLOAS`.
        field: &'static str,
        /// The levels between the field root and the claimed index.
        levels_below: u32,
    },
}

/// A plain layout claimed on the real Gloas state.
struct GloasClaim {
    /// The length of the finality branch that names the claimed layout.
    finality_length: usize,
    /// The node of the claimed layout.
    which: LayoutIndex,
    /// The claimed generalized index, written as the literal of the specification.
    gindex: u64,
    /// The landing node of the soundness table.
    landing: GloasLanding,
}

/// The leaf that an attacker puts at a node: the real finalized header root, or the real committee root.
fn attacker_leaf(state: &ParsedState, update: &LightClientUpdate, which: LayoutIndex) -> B256 {
    match which {
        LayoutIndex::Finality => update.finalized_header.beacon.hash_tree_root(),
        LayoutIndex::CurrentCommittee => state.current_sync_committee.hash_tree_root().expect("a committee of 512"),
        LayoutIndex::NextCommittee => state.next_sync_committee.hash_tree_root().expect("a committee of 512"),
    }
}

/// Checks one claim on the real Gloas state: the pair is what the program tests, the walk lands where the table says, and
/// the best honest-looking branch is refused at the claimed index against the real state root.
fn assert_gloas_claim_refused(state: &ParsedState, tree: &Tree, claim: &GloasClaim) {
    let layout = state_layout_for_finality_branch_length(claim.finality_length).expect("an allowed length");
    assert_eq!(claim.which.gindex_in(&layout), claim.gindex, "the program tests this index for this length");

    let walked = walk(tree, claim.gindex);
    match &claim.landing {
        GloasLanding::ActiveFieldsChunk => {
            assert_eq!(walked.leaf_gindex, 3, "index {} lands on node 3, the active_fields chunk", claim.gindex);
            assert_eq!(walked.leaf_value, active_fields_chunk(46));
            assert_eq!(walked.levels_below, gindex_depth(claim.gindex) - 1);
            assert!(
                walked.leaf_value.0[6..].iter().all(|byte| *byte == 0),
                "the chunk is 46 set bits and zeros: 26 zero bytes, so no hash"
            );
        }
        GloasLanding::StateField { field, levels_below } => {
            let field_gindex = path_gindex(&[(&BEACON_STATE_GLOAS, field)]).expect("a field of the Gloas state");
            assert_eq!(walked.leaf_gindex, field_gindex, "index {} lands in field {field}", claim.gindex);
            assert_eq!(walked.levels_below, *levels_below, "index {} lies below the root of {field}", claim.gindex);
            let position = BEACON_STATE_GLOAS.field_position(field).expect("a field");
            assert_eq!(walked.leaf_value, state.field_roots[position], "the leaf is the real field root");
        }
    }

    let update = real_gloas_head_update();
    let leaf = attacker_leaf(state, &update, claim.which);
    let branch = honest_looking_branch(&walked);
    assert_eq!(branch.len(), gindex_depth(claim.gindex) as usize, "a branch of the claimed length");
    assert!(
        !is_valid_exact_branch(&leaf, &branch, claim.gindex, &state.root()),
        "{:?} claimed at {} on the real Gloas state",
        claim.which,
        claim.gindex
    );
}

/// Claim: the model of the real state in this file (the tree with node 2 and node 3) reproduces the real state root, and
/// the honest Gloas branches verify at 735, 2945 and 2946 against it. The walker below is only evidence if the model is right.
/// Why it matters: every landing node of part A is computed on this tree. A model that did not hash to the real root
/// would prove nothing. The honest branches are the control of the attacks.
#[test]
fn real_gloas_state_model_matches_the_root_and_honest_branches_verify() {
    let state = real_gloas_state();
    let tree = gloas_state_tree(&state);
    assert_eq!(tree.root(), state.root(), "the tree model hashes to the real state root");
    let Tree::Pair(progressive, active) = &tree else { panic!("the state is a pair") };
    assert_eq!(progressive.root(), lc_core::ssz::merkleize_progressive(&state.field_roots), "node 2");
    assert_eq!(active.root(), active_fields_chunk(46), "node 3");

    let layout = state_layout_for_finality_branch_length(9).expect("length 9");
    let (epoch, finalized_root) = state.finalized_checkpoint;
    let finality_branch = [vec![u64_chunk(epoch)], state.field_branch(20)].concat();
    assert_eq!(finality_branch.len(), 9);
    assert!(is_valid_exact_branch(&finalized_root, &finality_branch, layout.finalized_root_gindex, &state.root()));
    assert_eq!(
        layout.finalized_root_gindex,
        state.field_gindex(20) * 2 + 1,
        "the root of the checkpoint, below field 20"
    );

    let current = state.current_sync_committee.hash_tree_root().expect("committee");
    assert_eq!(current, state.field_roots[22]);
    assert!(is_valid_exact_branch(
        &current,
        &state.field_branch(22),
        layout.current_sync_committee_gindex,
        &state.root()
    ));
    assert_eq!(layout.current_sync_committee_gindex, state.field_gindex(22));
    let next = state.next_sync_committee.hash_tree_root().expect("committee");
    assert_eq!(next, state.field_roots[23]);
    assert!(is_valid_exact_branch(&next, &state.field_branch(23), layout.next_sync_committee_gindex, &state.root()));
    assert_eq!(layout.next_sync_committee_gindex, state.field_gindex(23));
}

/// Claim: the plain depth 5 claims (finality 105, committees 54 and 55, finality branch of 6 entries) land on node 3 of the
/// real Gloas state, and the best honest-looking branch is refused.
/// Why it is safe: the Gloas state is progressive. Node 2 is the progressive tree and node 3 is the `active_fields` chunk,
/// a leaf (46 set bits, 26 zero bytes) that is no hash. Index 105, 54 and 55 all go through node 3, so the verifier would
/// need a header root or a committee root whose hash chain ends on that chunk.
#[test]
fn real_gloas_state_plain_depth_five_claims_land_on_the_active_fields_chunk() {
    let state = real_gloas_state();
    let tree = gloas_state_tree(&state);
    let claims = [(LayoutIndex::Finality, 105), (LayoutIndex::CurrentCommittee, 54), (LayoutIndex::NextCommittee, 55)];
    for (which, gindex) in claims {
        assert_gloas_claim_refused(
            &state,
            &tree,
            &GloasClaim { finality_length: 6, which, gindex, landing: GloasLanding::ActiveFieldsChunk },
        );
    }
}

/// Claim: the plain depth 6 claims land on `fork.current_version` (finality 169, finality branch of 7 entries) and on the
/// two children of `latest_block_header` (committees 86 and 87), and the best honest-looking branch is refused.
/// Why it is safe: 169 is a four byte version padded to 32 bytes with zeros, no header root can equal it. The children of
/// `latest_block_header` at 86 and 87 are hash-only nodes inside a fixed-shape container (five fields, three levels deep):
/// they hash slot and proposer, or parent root and state root, so a committee root would have to be one of them.
/// Control: the real fork version branch (7 entries) verifies at 169 for the real current version, so the computed landing
/// is the real node. The indices are derived with `path_gindex` from the container definitions.
#[test]
fn real_gloas_state_plain_depth_six_claims_land_on_the_fork_version_and_the_block_header_children() {
    use lc_core::gate::{progressive_fork_version_branch, version_leaf};
    let state = real_gloas_state();
    let tree = gloas_state_tree(&state);

    let version = path_gindex(&[(&BEACON_STATE_GLOAS, "fork"), (&FORK, "current_version")]).expect("a path");
    assert_eq!(version, 169);
    assert_eq!(version, FORK_VERSION_GINDEX_GLOAS);
    let header = path_gindex(&[(&BEACON_STATE_GLOAS, "latest_block_header")]).expect("a path");
    assert_eq!(86, header * 2, "86 is the left child of latest_block_header");
    assert_eq!(87, header * 2 + 1, "87 is the right child of latest_block_header");
    // BeaconBlockHeader has five fields (slot, proposer_index, parent_root, state_root, body_root): a tree of depth 3.
    // So its children are internal nodes, and the leaves are three levels below the header root.
    assert!(gindex_depth(86) - gindex_depth(header) < lc_core::ssz::ceil_log2(5));

    let claims = [
        GloasClaim {
            finality_length: 7,
            which: LayoutIndex::Finality,
            gindex: 169,
            landing: GloasLanding::StateField { field: "fork", levels_below: 2 },
        },
        GloasClaim {
            finality_length: 7,
            which: LayoutIndex::CurrentCommittee,
            gindex: 86,
            landing: GloasLanding::StateField { field: "latest_block_header", levels_below: 1 },
        },
        GloasClaim {
            finality_length: 7,
            which: LayoutIndex::NextCommittee,
            gindex: 87,
            landing: GloasLanding::StateField { field: "latest_block_header", levels_below: 1 },
        },
    ];
    for claim in &claims {
        assert_gloas_claim_refused(&state, &tree, claim);
    }

    let branch = progressive_fork_version_branch(&state.field_roots, &state.fork);
    assert!(is_valid_exact_branch(&version_leaf(state.fork.current_version), &branch, 169, &state.root()));
}

// ---------------------------------------------------------------------------------------------------------------------
// Part B: synthetic plain states, wrong depth
// ---------------------------------------------------------------------------------------------------------------------

/// Claim: the landing walker reports the honest node for the honest indices of both plain layouts. The finality index
/// (105 and 169) lands one level below `finalized_checkpoint` (its `root`), and the committee indices land on the roots of
/// `current_sync_committee` and `next_sync_committee`. The field lists agree with the layout constants (fields 5, 20, 22,
/// 23 and 27), and have 28, 37 and 38 entries.
/// Why it matters: the table rows of the next two tests are only evidence if the walker is right on the known cases.
#[test]
fn plain_landing_walker_finds_the_honest_fields() {
    for (fork, depth) in [(ForkName::Capella, 5), (ForkName::Electra, 6), (ForkName::Fulu, 6)] {
        let fields = plain_state_fields(fork);
        let layout = plain_state_layout(depth);
        assert_eq!(
            plain_landing(layout.finalized_root_gindex, depth, &fields),
            PlainLanding::Field { name: "finalized_checkpoint", levels_below: 1 }
        );
        assert_eq!(
            plain_landing(layout.current_sync_committee_gindex, depth, &fields),
            PlainLanding::Field { name: "current_sync_committee", levels_below: 0 }
        );
        assert_eq!(
            plain_landing(layout.next_sync_committee_gindex, depth, &fields),
            PlainLanding::Field { name: "next_sync_committee", levels_below: 0 }
        );
        assert_eq!(fields[BLOCK_ROOTS_FIELD_INDEX as usize], "block_roots");
        assert_eq!(fields[HISTORICAL_SUMMARIES_FIELD_INDEX as usize], "historical_summaries");
    }
    assert_eq!(plain_state_fields(ForkName::Capella).len(), 28);
    assert_eq!(plain_state_fields(ForkName::Electra).len(), 37);
    assert_eq!(plain_state_fields(ForkName::Fulu).len(), 38);
}

/// Claim: on a TRUE depth 5 state (Capella, 28 fields on 32 leaves) the claimed Electra layout (169, 86, 87) and the claimed
/// Gloas layout (735, 2945, 2946) land on the nodes of the soundness table, and every attacker branch is refused: on the
/// state builder and in a full update (`InvalidFinalityBranch`, and `InvalidNextSyncCommitteeBranch` for the next committee).
/// - 169 lands two levels below `eth1_deposit_index`, a uint64 leaf.
/// - 86 lands on the data root of the `validators` list and 87 on its length (the length is a uint64 chunk).
/// - 735 lands four levels inside `randao_mixes`. 2945 and 2946 land six levels inside `slashings`.
/// Why it is safe: the attacker needs a header root or a committee root that equals one of these values.
#[test]
fn synthetic_true_depth_five_state_refuses_the_claimed_electra_and_gloas_layouts() {
    use LayoutIndex::{CurrentCommittee, Finality, NextCommittee};
    let claims = [
        claim_on_field(7, Finality, 169, "eth1_deposit_index", 2),
        claim_on_field(7, CurrentCommittee, 86, "validators", 1).first_step(Step::Left),
        claim_on_field(7, NextCommittee, 87, "validators", 1).first_step(Step::Right),
        claim_on_field(9, Finality, 735, "randao_mixes", 4),
        claim_on_field(9, CurrentCommittee, 2945, "slashings", 6),
        claim_on_field(9, NextCommittee, 2946, "slashings", 6),
    ];
    check_wrong_depth_claims(&PULSECHAIN, pulsechain_recipe(), ForkName::Capella, 5, &claims);
}

/// Claim: on a TRUE depth 6 state (Electra, 37 fields on 64 leaves; the update is Fulu with 38) the claimed Capella layout
/// (105, 54, 55) and the claimed Gloas layout (735, 2945, 2946) land on the nodes of the soundness table, and every
/// attacker branch is refused on the state builder and in a full update.
/// - 105 lands on leaf 41, a padding zero chunk (the state has no field 41).
/// - 54 and 55 land on the nodes above leaves 44 and 45, and 46 and 47: padding only, the zero hash of level 1.
/// - 735 lands three levels below the root of `historical_summaries`, on the right side: below the list length.
/// - 2945 and 2946 land five levels below field 28, `deposit_requests_start_index`, a uint64 leaf.
/// Why it is safe: a zero chunk, a zero hash and a uint64 leaf are not values that a header root or a committee root takes.
#[test]
fn synthetic_true_depth_six_state_refuses_the_claimed_capella_and_gloas_layouts() {
    use LayoutIndex::{CurrentCommittee, Finality, NextCommittee};
    let padding = |finality_length, which, gindex, landing| WrongDepthClaim {
        finality_length,
        which,
        gindex,
        landing,
        first_step: None,
    };
    let claims = [
        padding(6, Finality, 105, PlainLanding::Padding { levels_below: 0 }),
        padding(6, CurrentCommittee, 54, PlainLanding::HashOnly { level: 1 }),
        padding(6, NextCommittee, 55, PlainLanding::HashOnly { level: 1 }),
        claim_on_field(9, Finality, 735, "historical_summaries", 3).first_step(Step::Right),
        claim_on_field(9, CurrentCommittee, 2945, "deposit_requests_start_index", 5),
        claim_on_field(9, NextCommittee, 2946, "deposit_requests_start_index", 5),
    ];
    check_wrong_depth_claims(&ETHEREUM_MAINNET, ethereum_recipe(), ForkName::Electra, 6, &claims);
    // The value of a hash-only node of level 1 is the zero hash: hash of two zero chunks.
    assert_eq!(hash_pair(&B256::ZERO, &B256::ZERO), zero_hash(1));
    // The Fulu field list has one more field (37). It changes no landing of the table.
    let fulu_fields = plain_state_fields(ForkName::Fulu);
    for claim in &claims {
        assert_eq!(
            plain_landing(claim.gindex, 6, &fulu_fields),
            claim.landing,
            "index {} on a Fulu state",
            claim.gindex
        );
    }
}

// ---------------------------------------------------------------------------------------------------------------------
// Part C: honest data cut or padded to the wrong length
// ---------------------------------------------------------------------------------------------------------------------

/// The real Ethereum finality update and the store of its bootstrap.
fn real_ethereum() -> (LightClientStore, LightClientUpdate) {
    let update = light_client_update(&load_response("ethereum/finality_update.json")["data"]);
    let store = store_from_bootstrap(&bootstrap(&load_response("ethereum/bootstrap_same_period.json")["data"]), None);
    (store, update)
}

/// The real Sepolia Gloas head update with its finalized header anchored in the real state (see `tests/gloas_real.rs`), and
/// the store that holds the real current committee.
fn real_gloas_with_store() -> (LightClientStore, LightClientUpdate) {
    let mut update = real_gloas_head_update();
    let state = real_gloas_state();
    let wrapper = load_fixture("sepolia/gloas_head_execution_header.json");
    let rlp = alloy_primitives::hex::decode(wrapper["raw_header"].as_str().expect("raw header")).expect("hex");
    let hash = state.latest_block_hash().expect("a Gloas state has latest_block_hash");
    update.finalized_header =
        LightClientHeader::compact(update.finalized_header.beacon, hash, state.field_branch(24), rlp);
    let store = LightClientStore {
        header_root: B256::repeat_byte(0x51),
        header_slot: update.finalized_header.beacon.slot - 1_000,
        current_sync_committee: state.current_sync_committee.clone(),
        next_sync_committee: None,
    };
    (store, update)
}

/// The honest finality branch with one leading zero entry: the padding that the old rule stripped.
fn zero_padded(branch: &[B256]) -> Vec<B256> {
    [zero_entries(1), branch.to_vec()].concat()
}

/// Asserts that the old rule (`is_valid_normalized_merkle_branch`, which skips leading zeros) accepted the zero-padded
/// finality branch at the honest index, and that the exact rule refuses it.
fn assert_old_rule_accepted_and_exact_rule_refuses(update: &LightClientUpdate, honest_gindex: u64) {
    let padded = zero_padded(&update.finality_branch);
    let leaf = update.finalized_header.beacon.hash_tree_root();
    let root = &update.attested_header.beacon.state_root;
    assert!(is_valid_normalized_merkle_branch(&leaf, &padded, honest_gindex, root), "the old rule stripped the zero");
    assert!(!is_valid_exact_branch(&leaf, &padded, honest_gindex, root), "the exact rule counts the zero");
}

/// Claim: the real PulseChain update with a leading zero added to its finality branch (length 7) fails with
/// `InvalidFinalityBranch`. The control: the honest update verifies, and the old normalizing rule accepted the padded
/// branch at 105.
/// Why it matters: the length is the depth now. A branch of 7 entries asks for index 169, which on a true depth 5 state
/// lands two levels below `eth1_deposit_index` (computed below), so no padding can reach the honest node.
#[test]
fn real_pulsechain_zero_padded_finality_branch_is_refused() {
    let (store, update) = real_update_and_store();
    assert!(verify_light_client_update(&store, &update, &PULSECHAIN).is_ok(), "control: the real update verifies");
    assert_eq!(update.finality_branch.len(), 6);
    assert_old_rule_accepted_and_exact_rule_refuses(&update, 105);

    let padded = with_finality_branch(&update, zero_padded(&update.finality_branch));
    assert_eq!(verify_light_client_update(&store, &padded, &PULSECHAIN), Err(Error::InvalidFinalityBranch));
    assert_eq!(
        plain_landing(169, 5, &plain_state_fields(ForkName::Capella)),
        PlainLanding::Field { name: "eth1_deposit_index", levels_below: 2 }
    );
}

/// Claim: the real Ethereum finality update (Fulu, finality branch of 7 entries) with its leading entry cut (length 6) fails
/// with `InvalidFinalityBranch`, and padded with a leading zero to length 8 fails with `UnsupportedStateBranchLength {
/// length: 8 }`. The control: the honest update verifies, and the old rule accepted the zero-padded branch at 169.
/// Why it matters: a branch of 6 entries asks for index 105, which on a true depth 6 state is the padding zero chunk at
/// leaf 41. A branch of 8 entries names depth 7, which no layout has.
#[test]
fn real_ethereum_cut_and_padded_finality_branches_are_refused() {
    let (store, update) = real_ethereum();
    assert!(
        verify_light_client_update(&store, &update, &ETHEREUM_MAINNET).is_ok(),
        "control: the real update verifies"
    );
    assert_eq!(update.finality_branch.len(), 7);
    assert_old_rule_accepted_and_exact_rule_refuses(&update, 169);

    let cut = with_finality_branch(&update, update.finality_branch[1..].to_vec());
    assert_eq!(cut.finality_branch.len(), 6);
    assert_eq!(verify_light_client_update(&store, &cut, &ETHEREUM_MAINNET), Err(Error::InvalidFinalityBranch));
    assert_eq!(
        plain_landing(105, 6, &plain_state_fields(ForkName::Fulu)),
        PlainLanding::Padding { levels_below: 0 },
        "index 105 on a depth 6 state is a padding chunk"
    );

    let padded = with_finality_branch(&update, zero_padded(&update.finality_branch));
    assert_eq!(padded.finality_branch.len(), 8);
    assert_eq!(
        verify_light_client_update(&store, &padded, &ETHEREUM_MAINNET),
        Err(Error::UnsupportedStateBranchLength { length: 8 })
    );
}

/// Claim: the real Sepolia Gloas update (finality branch of 9 entries, anchored in the real state) with a leading zero
/// (length 10) or with its leading entry cut (length 8) fails with `UnsupportedStateBranchLength`. At the branch level,
/// for the two real Gloas updates (`gloas_head_finality_update.json` and `gloas_finality_update.json`), the honest branch
/// verifies at 735, and the cut and the padded branch do not. The control: the honest update verifies.
/// Why it matters: lengths 8 and 10 name no layout, so the program stops before it tests any index. The exact check also
/// refuses both branches at 735, so the refusal does not rest on the length rule alone. The old rule accepted the
/// zero-padded branch at 735.
#[test]
fn real_sepolia_gloas_cut_and_padded_finality_branches_are_refused() {
    let (store, update) = real_gloas_with_store();
    let fork_version = table_fork_version(&SEPOLIA, update.signature_slot);
    let run = |candidate: &LightClientUpdate| {
        verify_light_client_update_with_fork_version(&store, candidate, &SEPOLIA, fork_version)
    };
    assert!(run(&update).is_ok(), "control: the real Gloas update verifies");
    assert_eq!(update.finality_branch.len(), 9);

    let padded = with_finality_branch(&update, zero_padded(&update.finality_branch));
    assert_eq!(padded.finality_branch.len(), 10);
    assert_eq!(run(&padded), Err(Error::UnsupportedStateBranchLength { length: 10 }));
    let cut = with_finality_branch(&update, update.finality_branch[1..].to_vec());
    assert_eq!(cut.finality_branch.len(), 8);
    assert_eq!(run(&cut), Err(Error::UnsupportedStateBranchLength { length: 8 }));

    let second = light_client_update(&load_response("sepolia/gloas_finality_update.json")["data"]);
    for (name, real) in [("head update", update), ("second update", second)] {
        assert_eq!(real.finality_branch.len(), 9, "{name}");
        let leaf = real.finalized_header.beacon.hash_tree_root();
        let root = &real.attested_header.beacon.state_root;
        assert!(is_valid_exact_branch(&leaf, &real.finality_branch, 735, root), "{name}: control at 735");
        let cut_branch = real.finality_branch[1..].to_vec();
        let padded_branch = zero_padded(&real.finality_branch);
        assert!(!is_valid_exact_branch(&leaf, &cut_branch, 735, root), "{name}: cut");
        assert!(!is_valid_exact_branch(&leaf, &padded_branch, 735, root), "{name}: padded");
        assert!(is_valid_normalized_merkle_branch(&leaf, &padded_branch, 735, root), "{name}: the old rule took it");
    }
}

// ---------------------------------------------------------------------------------------------------------------------
// Part D: the length rules
// ---------------------------------------------------------------------------------------------------------------------

/// Claim: the finality branch lengths 6, 7 and 9 name the layouts whose indices equal the constants of the specifications:
/// 105, 54, 55 (Altair and Capella), 169, 86, 87 (Electra) and 735, 2945, 2946 (Gloas), written here as literals.
/// Why it matters: these literals come from the specifications, not from this crate. A typo in `plain_state_layout` or in
/// the Gloas field list shows here.
#[test]
fn finality_branch_lengths_name_the_layouts_of_the_specifications() {
    let expected = [(6, 105, 54, 55), (7, 169, 86, 87), (9, 735, 2945, 2946)];
    for (length, finality, current, next) in expected {
        let layout = state_layout_for_finality_branch_length(length).expect("an allowed length");
        assert_eq!(layout.finalized_root_gindex, finality, "finality index for length {length}");
        assert_eq!(layout.current_sync_committee_gindex, current, "current committee index for length {length}");
        assert_eq!(layout.next_sync_committee_gindex, next, "next committee index for length {length}");
        assert_eq!(gindex_depth(finality) as usize, length, "the length of the finality branch is the depth");
    }
}

/// Claim: every length from 0 to 12 other than 6, 7 and 9, and also 64 and `usize::MAX`, is refused with
/// `UnsupportedStateBranchLength { length }`.
/// Why it matters: the program must stop on a length that names no layout, and must not guess the nearest one.
#[test]
fn every_other_finality_branch_length_is_refused() {
    let lengths = (0..=12usize).chain([64, usize::MAX]).filter(|length| ![6, 7, 9].contains(length));
    for length in lengths {
        assert_eq!(
            state_layout_for_finality_branch_length(length),
            Err(Error::UnsupportedStateBranchLength { length }),
            "length {length}"
        );
    }
}

/// Claim: length 8 is refused, though it is the length of a depth 7 state (finality branch of 8 entries, index 297, and
/// committee branch of 7 entries, indices 150 and 151). The program never reads a depth 7 layout.
/// Why it matters: on a chain that is truly depth 7 (65 or more fields) a wrong claim would land on fields that no
/// specification defines yet (for example field 41). Refusing depth 7 means that such a chain stops the bridge, and a
/// later program version names the layout once a specification exists. Part E shows what depth 7 would allow.
#[test]
fn finality_branch_length_eight_is_refused_because_it_is_depth_seven() {
    let depth_seven = plain_state_layout(7);
    assert_eq!(depth_seven.finalized_root_gindex, 297);
    assert_eq!(gindex_depth(depth_seven.finalized_root_gindex), 8, "finality branch of 8 entries");
    assert_eq!((depth_seven.current_sync_committee_gindex, depth_seven.next_sync_committee_gindex), (150, 151));
    assert_eq!(gindex_depth(depth_seven.next_sync_committee_gindex), 7, "committee branch of 7 entries");
    assert_eq!(state_layout_for_finality_branch_length(8), Err(Error::UnsupportedStateBranchLength { length: 8 }));
}

/// Claim: the allowed finality branch lengths are exactly 6, 7 and 9.
#[test]
fn allowed_finality_branch_lengths_are_six_seven_and_nine() {
    assert_eq!(ALLOWED_FINALITY_BRANCH_LENGTHS, [6, 7, 9]);
    for length in ALLOWED_FINALITY_BRANCH_LENGTHS {
        assert!(state_layout_for_finality_branch_length(length).is_ok(), "length {length}");
    }
}

/// Claim: a next committee branch whose length is not the depth of the layout of the finality branch is refused with
/// `InvalidNextSyncCommitteeBranch`. Ethereum (finality 7, so committee 6) refuses 5 and 11 (and 7, 9). PulseChain
/// (finality 6, so committee 5) refuses 6 and 11 (and 7, 9). The control: the honest committee branch verifies.
/// Why it matters: a step must not take its finality proof from one layout and its committee proof from another. The two
/// proofs bind to the same state root, and mixed lengths would let each proof pick its own claim.
#[test]
fn mixed_branch_lengths_in_one_step_are_refused() {
    let cases = [
        (&ETHEREUM_MAINNET, ethereum_recipe(), 7usize, 6usize, [5usize, 11, 7, 9]),
        (&PULSECHAIN, pulsechain_recipe(), 6, 5, [6, 11, 7, 9]),
    ];
    for (spec, recipe, finality_length, committee_length, refused) in cases {
        let scenario = build_update(spec, recipe);
        let honest = scenario.update.next_sync_committee.as_ref().expect("a next committee").branch.clone();
        assert_eq!(scenario.update.finality_branch.len(), finality_length, "{}", spec.name);
        assert_eq!(honest.len(), committee_length, "{}", spec.name);
        assert!(verify(&scenario, &scenario.update).is_ok(), "{}: control", spec.name);
        for length in refused {
            for branch in attacker_branches(&honest, length) {
                let update = with_next_committee_branch(&scenario.update, branch);
                assert_eq!(
                    verify(&scenario, &update),
                    Err(Error::InvalidNextSyncCommitteeBranch),
                    "{}: committee branch of {length}",
                    spec.name
                );
            }
        }
    }
}

// ---------------------------------------------------------------------------------------------------------------------
// Part E: the 65 field control
// ---------------------------------------------------------------------------------------------------------------------

/// The number of fields of the wide state: 70, so the tree has 128 leaves (depth 7).
const WIDE_STATE_FIELDS: usize = 70;

/// A plain state of 70 fields with an honest finalized checkpoint at field 20 and a forged header root at field 41.
struct WideState {
    /// The 70 field roots.
    leaves: Vec<B256>,
    /// The root of the state.
    root: B256,
    /// The epoch of the honest checkpoint.
    epoch: u64,
    /// The honest finalized header root (the `root` of the checkpoint).
    honest_header_root: B256,
    /// The forged header root: it sits at field 41, which is the node at generalized index 128 + 41 = 169.
    forged_header_root: B256,
}

impl WideState {
    /// Builds the state.
    fn new() -> Self {
        let epoch = 400_000;
        let honest_header_root = filler("honest-header", 0);
        let forged_header_root = filler("forged-header", 0);
        let mut leaves: Vec<B256> = (0..WIDE_STATE_FIELDS as u64).map(|index| filler("wide-field", index)).collect();
        leaves[20] = hash_pair(&u64_chunk(epoch), &honest_header_root);
        leaves[41] = forged_header_root;
        let root = merkleize(&leaves);
        Self { leaves, root, epoch, honest_header_root, forged_header_root }
    }

    /// The honest finality branch: the epoch chunk, then the 7 siblings of field 20. 8 entries.
    fn honest_finality_branch(&self) -> Vec<B256> {
        [vec![u64_chunk(self.epoch)], branch_for_leaf(&self.leaves, 20).1].concat()
    }

    /// The branch of field 41 to the root. 7 entries.
    fn forged_branch(&self) -> Vec<B256> {
        branch_for_leaf(&self.leaves, 41).1
    }
}

/// A selector that allows any depth: a finality branch of `length` entries between 6 and 8 names the plain layout of depth
/// `length - 1`.
fn permissive_layout(length: usize) -> Option<StateLayout> {
    (6..=8).contains(&length).then(|| plain_state_layout(length as u32 - 1))
}

/// Claim: a selector that allows depth 7 accepts a forged length 7 branch on a state of 70 fields, and the real rule
/// refuses the honest depth 7 update. The permissive selector reads the 7 entries of field 41 at index 169 and accepts the
/// forged header root. The real rule gives `UnsupportedStateBranchLength { length: 8 }` for the honest update (8 entries,
/// index 297), and the permissive selector accepts that honest update at 297.
///
/// What this shows, and what it does not: the control shows why the program must not read depth 7 on its own. Without a
/// specification of field 41 a state of that depth is not under the rules that the soundness table covers: field 41 and
/// the index 169 of the Electra layout name the same node. It does not show that the forgery is impossible. With the REAL
/// rule, a length 7 branch on a TRUE depth 7 state still verifies at 169 (the last assertion), because 169 is then field
/// 41. The guard is therefore that no specification defines field 41 yet, and that honest depth 7 updates are refused. When
/// a chain has such a state, the bridge stops. It does not accept a wrong claim silently, and a later program version has
/// to name the layout from a specification.
#[test]
fn wide_state_control_permissive_selector_accepts_a_forgery_and_the_real_rule_stops_the_bridge() {
    let state = WideState::new();
    assert_eq!(state.leaves.len(), WIDE_STATE_FIELDS);
    assert_eq!(gindex_depth(128 + 41), 7, "field 41 of a depth 7 tree is a node at depth 7");
    assert_eq!(128 + 41, 169);
    assert!(plain_state_fields(ForkName::Fulu).len() <= 41, "no specification defines a field 41 (Fulu has 38 fields)");

    // The permissive selector reads the forged branch at index 169, and accepts the forgery.
    let forged_branch = state.forged_branch();
    assert_eq!(forged_branch.len(), 7);
    let permissive = permissive_layout(forged_branch.len()).expect("length 7 is allowed by the permissive selector");
    assert_eq!(permissive.finalized_root_gindex, 169);
    assert!(
        is_valid_exact_branch(&state.forged_header_root, &forged_branch, permissive.finalized_root_gindex, &state.root),
        "the permissive selector accepts the forged header root at 169"
    );

    // The honest depth 7 update: 8 entries and index 297. The permissive selector accepts it, the real rule refuses it.
    let honest_branch = state.honest_finality_branch();
    assert_eq!(honest_branch.len(), 8);
    let wide = permissive_layout(honest_branch.len()).expect("length 8 is allowed by the permissive selector");
    assert_eq!(wide.finalized_root_gindex, 297);
    assert!(
        is_valid_exact_branch(&state.honest_header_root, &honest_branch, wide.finalized_root_gindex, &state.root),
        "control: the honest depth 7 branch verifies at 297"
    );
    assert_eq!(
        state_layout_for_finality_branch_length(honest_branch.len()),
        Err(Error::UnsupportedStateBranchLength { length: 8 }),
        "the real rule refuses the honest depth 7 update"
    );

    // The caveat: with the real rule, a length 7 forgery on a TRUE depth 7 state still verifies at 169.
    let real_rule = state_layout_for_finality_branch_length(forged_branch.len()).expect("length 7");
    assert_eq!(real_rule.finalized_root_gindex, 169);
    assert!(
        is_valid_exact_branch(&state.forged_header_root, &forged_branch, real_rule.finalized_root_gindex, &state.root),
        "caveat: on a true depth 7 state the real rule still verifies the length 7 forgery at 169"
    );
    // The honest 8 entry branch does not verify at 169: the honest header cannot take the place of the forgery.
    assert!(!is_valid_exact_branch(&state.honest_header_root, &honest_branch, 169, &state.root));
}
