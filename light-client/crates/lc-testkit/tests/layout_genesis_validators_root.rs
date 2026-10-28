//! The branch of `genesis_validators_root` (state field 1) under the attested state root.
//!
//! Every step of a fold carries `genesis_validators_root_branch`. The layout that the finality branch length names also names
//! the position of the root: generalized index 33, 65 and 129 for plain states of depth 5, 6 and 7, and 40 for the Gloas
//! progressive state. The leaf is `spec.genesis_validators_root`. It is never part of the input. The check comes after the
//! finality branch and the next committee branch, and it runs even when the update has no next committee.
//!
//! Why the branch exists. The length of the finality branch is a claim of the prover. A wrong claim lands on another node of
//! the true tree. Without this branch, a claim could land on a field that no specification defines yet (depth 7 allows such
//! fields), and the attacker could fill it. The root of the chain sits at one position only. A node at any other position
//! cannot hold it, so a claim of the wrong layout cannot also prove the root.
//!
//! The fork observation program runs the same fold (`update::verify_fold`), so every test of a step runs against both programs
//! through [`run_both_programs`]. The observation itself proves the shape of its own state, and the tests of that proof are in
//! `fork_observation.rs` and in `lc-core/src/observation.rs`.
//!
//! Every attack test has a control (the honest case passes) and asserts the exact error variant.

use alloy_primitives::B256;
use alloy_sol_types::SolValue;
use lc_core::abi::ForkObservation;
use lc_core::chain::{ChainSpec, ForkName, ETHEREUM_MAINNET, PULSECHAIN, SEPOLIA};
use lc_core::layout::{state_layout_for_finality_branch_length, STATE_FIELD_GENESIS_VALIDATORS_ROOT};
use lc_core::observation::{verify_fork_observation, Observation};
use lc_core::ssz::{gindex_depth, hash_pair, is_valid_exact_branch};
use lc_core::ssz_state::try_parse_state_for_fork;
use lc_core::types::{LightClientStore, LightClientUpdate};
use lc_core::update::{verify_fold, FoldStep};
use lc_core::wire::{
    decode_guest_input, decode_observation_input, encode_guest_input, encode_observation_input,
    run_fork_observation_guest, run_light_client_guest, ChainSelector, GuestInput, ObservationGuestInput,
};
use lc_core::Error;
use lc_testkit::fork_observation_scenarios::{
    fold_steps, honest_shape, observation_over_state, observation_signed_by, observed_state,
    stale_three_period_scenario,
};
use lc_testkit::json::fixtures_dir;
use lc_testkit::pulsechain::real_update_and_store;
use lc_testkit::synthetic::{
    build_gloas_update, build_update, build_update_on, build_update_over_tree,
    build_update_over_tree_with_finalized_state, committee_for, fork_start_slot, fulu_to_gloas_fold, CraftedPlacement,
    CraftedStateTree, GloasStateBuilder, MixedFold, StateBuilder, UpdateRecipe, ETHEREUM_RECIPE, PULSECHAIN_RECIPE,
    SEPOLIA_GLOAS_RECIPE,
};
use lc_testkit::tree_model::{honest_looking_branch, plain_state_tree, progressive_state_tree, walk, Tree};

// ---------------------------------------------------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------------------------------------------------

/// The fork version of the signing domain of a step, from the table (the step is honest in these tests).
fn version_of(spec: &ChainSpec, update: &LightClientUpdate) -> [u8; 4] {
    lc_core::update::table_fork_version(spec, update.signature_slot)
}

/// A fold step with the table fork version.
fn step_of(spec: &ChainSpec, update: &LightClientUpdate) -> FoldStep {
    FoldStep { update: update.clone(), fork_version: version_of(spec, update) }
}

/// An honest observation after the fold `steps` (or the start store when there is none): signed by the committee of the
/// period of the final head, 100 slots after it.
fn observation_after(spec: &ChainSpec, store: &LightClientStore, steps: &[FoldStep]) -> Observation {
    let head_slot = steps.last().map_or(store.header_slot, |last| last.update.finalized_header.beacon.slot);
    let slot = head_slot + 100;
    let signer = committee_for(spec, spec.period_at_slot(slot));
    observation_signed_by(spec, &signer, [0, 0, 3, 0x6d], 400, slot)
}

/// What the two programs say about a fold: the light-client program (`update::verify_fold`) and the fork-observation program
/// (`observation::verify_fork_observation` after the same fold).
struct ProgramResults {
    light_client: Result<(), Error>,
    fork_observation: Result<(), Error>,
}

/// Runs `steps` through both programs.
fn run_both_programs(spec: &ChainSpec, store: &LightClientStore, steps: &[FoldStep]) -> ProgramResults {
    let observation = observation_after(spec, store, steps);
    ProgramResults {
        light_client: verify_fold(store, steps, spec).map(|_| ()),
        fork_observation: verify_fork_observation(store, steps, &observation, spec).map(|_| ()),
    }
}

/// Asserts that both programs give `expected` for the fold.
fn assert_both_programs(
    spec: &ChainSpec,
    store: &LightClientStore,
    steps: &[FoldStep],
    expected: Result<(), Error>,
    context: &str,
) {
    let results = run_both_programs(spec, store, steps);
    assert_eq!(results.light_client, expected, "{context}: light-client program");
    assert_eq!(results.fork_observation, expected, "{context}: fork-observation program");
}

/// Asserts that both programs give `expected` for one update.
fn assert_both_programs_on_update(
    spec: &ChainSpec,
    store: &LightClientStore,
    update: &LightClientUpdate,
    expected: Result<(), Error>,
    context: &str,
) {
    assert_both_programs(spec, store, &[step_of(spec, update)], expected, context);
}

/// Asserts that the branch of `genesis_validators_root` of `update` is a branch of the root of `spec` at `gindex`, under the
/// attested state root, with `length` entries.
fn assert_honest_root_branch(spec: &ChainSpec, update: &LightClientUpdate, gindex: u64, length: usize) {
    let branch = &update.genesis_validators_root_branch;
    assert_eq!(branch.len(), length);
    assert_eq!(gindex_depth(gindex) as usize, length, "the length of the branch is the depth of its node");
    assert!(
        is_valid_exact_branch(&spec.genesis_validators_root, branch, gindex, &update.attested_header.beacon.state_root),
        "the root of {} sits at {gindex}",
        spec.name
    );
}

/// The four layouts, each with an honest update: name, chain, store, update, generalized index and length of the branch of
/// `genesis_validators_root`.
struct LayoutCase {
    name: &'static str,
    spec: &'static ChainSpec,
    store: LightClientStore,
    update: LightClientUpdate,
    gindex: u64,
    length: usize,
}

/// A state of 70 fields (depth 7) with honest branches.
fn wide_update() -> (LightClientStore, LightClientUpdate) {
    let scenario = build_update_on(&ETHEREUM_MAINNET, ETHEREUM_RECIPE, StateBuilder::with_field_count(70));
    (scenario.store, scenario.update)
}

fn layout_cases() -> Vec<LayoutCase> {
    let capella = build_update(&PULSECHAIN, PULSECHAIN_RECIPE);
    let electra = build_update(&ETHEREUM_MAINNET, ETHEREUM_RECIPE);
    let (wide_store, wide) = wide_update();
    let gloas = build_gloas_update(&SEPOLIA, SEPOLIA_GLOAS_RECIPE);
    vec![
        LayoutCase {
            name: "plain depth 5",
            spec: &PULSECHAIN,
            store: capella.store,
            update: capella.update,
            gindex: 33,
            length: 5,
        },
        LayoutCase {
            name: "plain depth 6",
            spec: &ETHEREUM_MAINNET,
            store: electra.store,
            update: electra.update,
            gindex: 65,
            length: 6,
        },
        LayoutCase {
            name: "plain depth 7",
            spec: &ETHEREUM_MAINNET,
            store: wide_store,
            update: wide,
            gindex: 129,
            length: 7,
        },
        LayoutCase { name: "gloas", spec: &SEPOLIA, store: gloas.store, update: gloas.update, gindex: 40, length: 5 },
    ]
}

// ---------------------------------------------------------------------------------------------------------------------
// W-1, W-2, W-3: the position table
// ---------------------------------------------------------------------------------------------------------------------

/// Claim: an honest update verifies on every layout, in both programs, and its branch of `genesis_validators_root` has the
/// length and the position of the layout: 5 entries at 33 (plain depth 5), 6 at 65 (depth 6), 7 at 129 (depth 7) and 5 at
/// 40 (Gloas). The position is also the one that `state_layout_for_finality_branch_length` names for the finality length.
/// The state builders are the four builders of the test kit: the Capella and the Electra `StateBuilder`, the wide
/// `StateBuilder` of 70 fields, and the `GloasStateBuilder`.
/// Why it matters: this is the control of every other test of this file, one per layout.
#[test]
fn honest_genesis_validators_root_branches_verify_on_every_layout() {
    for case in layout_cases() {
        assert_honest_root_branch(case.spec, &case.update, case.gindex, case.length);
        let layout = state_layout_for_finality_branch_length(case.update.finality_branch.len()).expect(case.name);
        assert_eq!(layout.genesis_validators_root_gindex, case.gindex, "{}", case.name);
        assert_both_programs_on_update(case.spec, &case.store, &case.update, Ok(()), case.name);
    }
}

/// Claim: the real PulseChain state holds the root of the chain at index 33 under the attested state root, with 5 entries,
/// and the real update verifies in full. The real Sepolia Gloas state holds the root of Sepolia at index 40 under its own
/// state root, with 5 entries.
/// Why it matters: real data agrees with the position table. The PulseChain branch comes from the attested state of the
/// real update (`pulsechain/light_client_update.json`, derived from the cached state). Only the finalized Sepolia state is
/// on file, so the Sepolia branch is checked against that state's own root and not against an update.
#[test]
fn the_real_genesis_validators_root_branches_verify_against_the_real_states() {
    let (store, update) = real_update_and_store();
    assert_honest_root_branch(&PULSECHAIN, &update, 33, 5);
    assert_eq!(
        lc_core::update::verify_light_client_update(&store, &update, &PULSECHAIN).map(|_| ()),
        Ok(()),
        "the real update verifies in full, with the real branch"
    );

    let bytes = std::fs::read(fixtures_dir().join("sepolia/gloas_head_state.ssz")).expect("the state fixture");
    let state = try_parse_state_for_fork(&bytes, ForkName::Gloas).expect("the real Gloas state parses");
    let field = STATE_FIELD_GENESIS_VALIDATORS_ROOT as usize;
    assert_eq!(state.field_roots[field], SEPOLIA.genesis_validators_root, "field 1 of the real state");
    let branch = state.field_branch(field);
    assert_eq!(branch.len(), 5);
    assert_eq!(state.field_gindex(field), 40);
    let layout = state_layout_for_finality_branch_length(9).expect("length 9 names the Gloas layout");
    assert_eq!(layout.genesis_validators_root_gindex, 40, "the program reads the position that the real state has");
    assert!(is_valid_exact_branch(
        &SEPOLIA.genesis_validators_root,
        &branch,
        layout.genesis_validators_root_gindex,
        &state.root()
    ));
}

/// Where a claimed index lands in the true tree.
#[derive(Debug, PartialEq, Eq)]
enum Landing {
    /// On the root of field `field`: the claimed index is the leaf itself.
    Field { field: u64 },
    /// On a node that hashes `2^level` fields from `first_field` on.
    NodeAbove { level: u32, first_field: u64 },
    /// `levels_below` levels under the leaf of field `field`: the claimed index asks for a hash inside a value.
    BelowField { field: u64, levels_below: u32 },
}

/// Walks `claimed` through a plain tree of `depth` and names the node it lands on.
fn plain_landing(tree: &Tree, depth: u32, claimed: u64) -> Landing {
    let walked = walk(tree, claimed);
    let first_leaf = 1u64 << depth;
    if walked.levels_below > 0 {
        return Landing::BelowField { field: walked.leaf_gindex - first_leaf, levels_below: walked.levels_below };
    }
    let level = depth - gindex_depth(claimed);
    match level {
        0 => Landing::Field { field: claimed - first_leaf },
        _ => Landing::NodeAbove { level, first_field: (claimed << level) - first_leaf },
    }
}

/// Claim: every wrong position of the root lands on a node that cannot hold the root. For each claimed position of
/// {33, 65, 129, 40} on each true state of {depth 5, 6, 7, 8, Gloas} with the claimed position different from the true one,
/// the test walks the claimed index through the true tree and asserts the landing exactly, asserts that the node differs
/// from the root of the chain, and asserts that the best honest-looking branch is refused.
/// Examples: 65 on depth 5 lies one level below `genesis_time`, a uint64 leaf. 33 on depth 6 is the node over `slot` and
/// `fork` (fields 2 and 3). 40 on depth 5 is the root of `eth1_data` (field 8). 40 on depth 7 is the node over fields 32 to
/// 35, which no specification defines. Every plain position (33, 65, 129) goes through node 4 of a Gloas state, which is
/// `genesis_time`, a uint64 leaf.
/// Why it matters: this pins the reason for safety and not only the refusal. The control is the true position of each state:
/// the walk ends on field 1 and holds the root.
#[test]
fn every_wrong_genesis_validators_root_position_lands_on_a_node_that_cannot_equal_the_root() {
    use Landing::{BelowField, Field, NodeAbove};
    let root = ETHEREUM_MAINNET.genesis_validators_root;
    // The claimed positions are the ones that the program names for the finality lengths 6, 7, 8 and 9.
    let claimed_positions: [u64; 4] = [6usize, 7, 8, 9].map(|length| {
        state_layout_for_finality_branch_length(length).expect("an allowed length").genesis_validators_root_gindex
    });
    assert_eq!(claimed_positions, [33, 65, 129, 40]);
    // The true trees: plain states of depth 5, 6, 7 and 8 (a depth 8 tree has 129 to 256 fields), and the Gloas state.
    let plain: [(&str, u32, usize, u64); 4] =
        [("depth 5", 5, 28, 33), ("depth 6", 6, 37, 65), ("depth 7", 7, 70, 129), ("depth 8", 8, 140, 257)];
    #[rustfmt::skip]
    let expected: [(&str, [Option<Landing>; 4]); 4] = [
        // claimed:           33                                           65                                           129                                          40
        ("depth 5", [None, Some(BelowField { field: 0, levels_below: 1 }), Some(BelowField { field: 0, levels_below: 2 }), Some(Field { field: 8 })]),
        ("depth 6", [Some(NodeAbove { level: 1, first_field: 2 }), None, Some(BelowField { field: 0, levels_below: 1 }), Some(NodeAbove { level: 1, first_field: 16 })]),
        ("depth 7", [Some(NodeAbove { level: 2, first_field: 4 }), Some(NodeAbove { level: 1, first_field: 2 }), None, Some(NodeAbove { level: 2, first_field: 32 })]),
        ("depth 8", [Some(NodeAbove { level: 3, first_field: 8 }), Some(NodeAbove { level: 2, first_field: 4 }), Some(NodeAbove { level: 1, first_field: 2 }), Some(NodeAbove { level: 3, first_field: 64 })]),
    ];
    for ((name, depth, fields, true_gindex), (expected_name, landings)) in plain.into_iter().zip(expected) {
        assert_eq!(name, expected_name);
        let mut builder = StateBuilder::with_field_count(fields);
        builder.set_genesis_validators_root(root);
        let field_roots = builder.field_roots();
        let tree = plain_state_tree(&field_roots, depth);
        assert_eq!(tree.root(), builder.root(), "{name}: the model hashes to the state root");
        assert_eq!(true_gindex - (1u64 << depth), STATE_FIELD_GENESIS_VALIDATORS_ROOT, "{name}: field 1");
        // The control: the true position is field 1 and holds the root. (Depth 8 has no position in the allowed set.)
        let control = walk(&tree, (1u64 << depth) + 1);
        assert_eq!((control.levels_below, control.leaf_value), (0, root), "{name}: control");
        for (claimed, landing) in claimed_positions.iter().zip(landings) {
            let Some(landing) = landing else { continue };
            assert_eq!(plain_landing(&tree, depth, *claimed), landing, "{name}: index {claimed}");
            let walked = walk(&tree, *claimed);
            assert_ne!(walked.leaf_value, root, "{name}: index {claimed} holds a node that is not the root");
            let branch = honest_looking_branch(&walked);
            assert_eq!(branch.len(), gindex_depth(*claimed) as usize);
            assert!(!is_valid_exact_branch(&root, &branch, *claimed, &builder.root()), "{name}: index {claimed}");
        }
    }

    // The Gloas state: the plain positions all pass through node 4, the first chunk (`genesis_time`).
    let mut gloas = GloasStateBuilder::default();
    gloas.set_genesis_validators_root(root);
    let tree = progressive_state_tree(gloas.field_roots());
    assert_eq!(tree.root(), gloas.root(), "gloas: the model hashes to the state root");
    let control = walk(&tree, 40);
    assert_eq!((control.levels_below, control.leaf_value), (0, root), "gloas: control, index 40 holds the root");
    for (claimed, levels_below) in [(33u64, 3u32), (65, 4), (129, 5)] {
        let walked = walk(&tree, claimed);
        assert_eq!(walked.leaf_gindex, 4, "index {claimed} goes through node 4");
        assert_eq!(walked.levels_below, levels_below, "index {claimed}");
        assert_eq!(walked.leaf_value, gloas.field_roots()[0], "node 4 is the root of genesis_time");
        assert_ne!(walked.leaf_value, root);
        let branch = honest_looking_branch(&walked);
        assert!(!is_valid_exact_branch(&root, &branch, claimed, &gloas.root()), "gloas: index {claimed}");
    }
}

// ---------------------------------------------------------------------------------------------------------------------
// W-4 to W-8: one rule at a time
// ---------------------------------------------------------------------------------------------------------------------

/// The honest tree of an update at `placement`, as a crafted tree: the finalized root and its epoch chunk, the next committee
/// root, and the root of the chain.
fn honest_crafted_tree(
    spec: &ChainSpec,
    facts: &lc_testkit::synthetic::StateFacts,
    placement: CraftedPlacement,
) -> CraftedStateTree {
    CraftedStateTree::new().with_honest_values(spec, facts, placement)
}

/// Claim: a wrong layout claim fails on the branch of `genesis_validators_root` alone. The crafted tree holds the finalized
/// root at 105, the next committee at 55 (both honest at depth 5), and the root of the chain NOT at 33. The finality branch
/// and the next committee branch verify, so only the root can stop the update: `InvalidGenesisValidatorsRootBranch`, in both
/// programs. Control: with the root placed at 33, both programs accept.
/// Why it matters: this isolates the check. If the program dropped it, only this test (with W-6 to W-8) would see the
/// difference, because the other two branches are honest.
#[test]
fn a_wrong_layout_claim_fails_on_the_genesis_validators_root() {
    let spec = &PULSECHAIN;
    let placement = CraftedPlacement { finality: 105, next_committee: 55, genesis_validators_root: 33 };
    let attack = build_update_over_tree(spec, PULSECHAIN_RECIPE, placement, |facts| {
        honest_crafted_tree(spec, facts, placement).without(33)
    });
    let root = attack.tree.root();
    let next = attack.update.next_sync_committee.as_ref().expect("a next committee");
    assert!(is_valid_exact_branch(
        &attack.update.finalized_header.beacon.hash_tree_root(),
        &attack.update.finality_branch,
        105,
        &root
    ));
    assert!(is_valid_exact_branch(&next.committee.hash_tree_root().unwrap(), &next.branch, 55, &root));
    assert_ne!(attack.tree.node(33), spec.genesis_validators_root);
    assert_both_programs_on_update(
        spec,
        &attack.store,
        &attack.update,
        Err(Error::InvalidGenesisValidatorsRootBranch),
        "root missing",
    );

    let control =
        build_update_over_tree(spec, PULSECHAIN_RECIPE, placement, |facts| honest_crafted_tree(spec, facts, placement));
    assert_both_programs_on_update(spec, &control.store, &control.update, Ok(()), "control");
}

/// Claim: the leaf of the branch is the root of the chain in the chain specification. The crafted tree holds the finalized
/// root at 105 and the next committee at 55 (honest at depth 5), and node 33 is the hash of two fields (`slot` and `fork`
/// positions 66 and 67). The prover supplies a REAL branch of node 33 for its own value, which is the hash of those two
/// fields. The branch verifies for that value, and the program refuses it with `InvalidGenesisValidatorsRootBranch`.
/// Why it matters: if the program read the leaf from the input, this attack would pass. The input has no leaf field. The
/// program takes the leaf from `spec`, so the only value that can verify at 33 is the root of the chain.
#[test]
fn the_genesis_validators_root_leaf_comes_from_the_chain_specification() {
    let spec = &ETHEREUM_MAINNET;
    let placement = CraftedPlacement { finality: 105, next_committee: 55, genesis_validators_root: 33 };
    let attack = build_update_over_tree(spec, ETHEREUM_RECIPE, placement, |facts| {
        honest_crafted_tree(spec, facts, placement)
            .without(33)
            .place(66, lc_core::ssz::sha256(b"slot"))
            .place(67, lc_core::ssz::sha256(b"fork"))
    });
    let node_33 = attack.tree.node(33);
    assert_eq!(node_33, hash_pair(&attack.tree.node(66), &attack.tree.node(67)), "33 is the node over slot and fork");
    assert_ne!(node_33, spec.genesis_validators_root);
    assert!(
        is_valid_exact_branch(&node_33, &attack.update.genesis_validators_root_branch, 33, &attack.tree.root()),
        "the supplied branch is a real branch of node 33, for the value of node 33"
    );
    assert_both_programs_on_update(
        spec,
        &attack.store,
        &attack.update,
        Err(Error::InvalidGenesisValidatorsRootBranch),
        "leaf from the specification",
    );
}

/// Claim: a depth 7 claim (finality 297, next committee 151, root at 129) on a state that is truly shallower fails with
/// `InvalidGenesisValidatorsRootBranch`, even when the attacker fills the state so that the finality branch and the next
/// committee branch both verify. The crafted tree stands for a depth 5 state (root at 33) and for a depth 6 state (root at 65).
/// The test computes the landing: index 129 lies two levels below `genesis_time` on a depth 5 state and one level below it on a
/// depth 6 state, a uint64 leaf that no root can fill. Control: the honest depth 7 placement is accepted.
/// Why it matters: depth 7 is the layout that the program allows only because of this branch. A depth 7 claim must not pass
/// on the word of the finality branch alone.
#[test]
fn a_depth_seven_claim_on_a_true_shallower_state_fails_the_genesis_validators_root() {
    let spec = &ETHEREUM_MAINNET;
    let claim = CraftedPlacement { finality: 297, next_committee: 151, genesis_validators_root: 129 };
    for (true_gindex, levels_below_genesis_time) in [(33u64, 2u32), (65, 1)] {
        assert_eq!(129 >> levels_below_genesis_time, 1u64 << gindex_depth(true_gindex), "129 lies below field 0");
        let attack = build_update_over_tree(spec, ETHEREUM_RECIPE, claim, |facts| {
            honest_crafted_tree(spec, facts, claim).without(129).place(true_gindex, spec.genesis_validators_root)
        });
        assert_eq!(attack.update.finality_branch.len(), 8);
        assert_ne!(attack.tree.node(129), spec.genesis_validators_root);
        assert_both_programs_on_update(
            spec,
            &attack.store,
            &attack.update,
            Err(Error::InvalidGenesisValidatorsRootBranch),
            &format!("root at {true_gindex}"),
        );
    }
    let control = build_update_over_tree(spec, ETHEREUM_RECIPE, claim, |facts| honest_crafted_tree(spec, facts, claim));
    assert_both_programs_on_update(spec, &control.store, &control.update, Ok(()), "control");
}

/// Claim: the position of the root follows the layout that the finality branch names, and not the length of the branch of
/// the root. Plain depth 5 and Gloas both have 5 entries. Case 1: Gloas finality (735) and committee (2946) with the root at 33
/// (5 entries): refused. Case 2: plain depth 5 finality (105) and committee (55) with the root at 40 (5 entries): refused.
/// Controls: the root at 40 for Gloas, and at 33 for depth 5, are accepted.
/// Why it matters: a program that chose the position from the length would take 33 for both and accept case 1.
#[test]
fn the_genesis_validators_root_position_follows_the_finality_layout_not_the_branch_length() {
    let spec = &ETHEREUM_MAINNET;
    let cases = [(735u64, 2946u64, 40u64, 33u64, "gloas"), (105, 55, 33, 40, "plain depth 5")];
    for (finality, next_committee, right, wrong, name) in cases {
        let build = |genesis_validators_root| {
            let placement = CraftedPlacement { finality, next_committee, genesis_validators_root };
            build_update_over_tree(spec, ETHEREUM_RECIPE, placement, |facts| {
                honest_crafted_tree(spec, facts, placement)
            })
        };
        let attack = build(wrong);
        assert_eq!(attack.update.genesis_validators_root_branch.len(), 5, "{name}: both positions have depth 5");
        assert!(is_valid_exact_branch(
            &spec.genesis_validators_root,
            &attack.update.genesis_validators_root_branch,
            wrong,
            &attack.tree.root()
        ));
        assert_both_programs_on_update(
            spec,
            &attack.store,
            &attack.update,
            Err(Error::InvalidGenesisValidatorsRootBranch),
            &format!("{name}: root at {wrong}"),
        );
        let control = build(right);
        assert_both_programs_on_update(
            spec,
            &control.store,
            &control.update,
            Ok(()),
            &format!("{name}: root at {right}"),
        );
    }
}

/// Claim: the branch of `genesis_validators_root` is checked against the ATTESTED state root, not the finalized one. The
/// finalized header commits to a crafted state that holds the root of the chain at 33. The attested state holds the finality
/// leaf but not the root. The branch of the update is the real branch of the FINALIZED state. It verifies against the
/// finalized state root and not against the attested one: `InvalidGenesisValidatorsRootBranch`. Control: the branch of the
/// attested state (the root placed there) is accepted.
/// Why it matters: the branch must bind the same tree as the finality branch. The attested state is the one the committee
/// signed.
#[test]
fn the_genesis_validators_root_is_checked_against_the_attested_state_root() {
    let spec = &PULSECHAIN;
    let placement = CraftedPlacement { finality: 105, next_committee: 55, genesis_validators_root: 33 };
    let finalized_tree = CraftedStateTree::new().place(33, spec.genesis_validators_root);
    let finalized_state_root = finalized_tree.root();
    let build = |attested_holds_root: bool| {
        build_update_over_tree_with_finalized_state(spec, PULSECHAIN_RECIPE, finalized_state_root, placement, |facts| {
            let tree = honest_crafted_tree(spec, facts, placement);
            match attested_holds_root {
                true => tree,
                false => tree.without(33),
            }
        })
    };
    let attack = build(false);
    assert_eq!(attack.update.finalized_header.beacon.state_root, finalized_state_root);
    let finalized_branch = finalized_tree.branch(33);
    assert!(
        is_valid_exact_branch(&spec.genesis_validators_root, &finalized_branch, 33, &finalized_state_root),
        "the branch is real, for the finalized state"
    );
    let update = LightClientUpdate { genesis_validators_root_branch: finalized_branch, ..attack.update.clone() };
    assert_both_programs_on_update(
        spec,
        &attack.store,
        &update,
        Err(Error::InvalidGenesisValidatorsRootBranch),
        "branch of the finalized state",
    );
    let control = build(true);
    assert_both_programs_on_update(spec, &control.store, &control.update, Ok(()), "control: the attested branch");
}

/// Claim: an update without a next committee still needs the branch of `genesis_validators_root`. An empty branch and a
/// damaged branch give `InvalidGenesisValidatorsRootBranch`. Control: the honest branch is accepted.
/// Why it matters: the check must not hide inside the next committee block. A step that proves no committee (a finality
/// update) is the common case on the wire.
#[test]
fn a_step_without_a_next_committee_still_needs_the_genesis_validators_root() {
    for (spec, recipe) in [(&PULSECHAIN, PULSECHAIN_RECIPE), (&ETHEREUM_MAINNET, ETHEREUM_RECIPE)] {
        let scenario = build_update(spec, UpdateRecipe { include_next_committee: false, ..recipe });
        assert!(scenario.update.next_sync_committee.is_none());
        assert_both_programs_on_update(spec, &scenario.store, &scenario.update, Ok(()), "control");
        let mut damaged = scenario.update.genesis_validators_root_branch.clone();
        damaged[0].0[0] ^= 1;
        for branch in [Vec::new(), damaged] {
            let update = LightClientUpdate { genesis_validators_root_branch: branch, ..scenario.update.clone() };
            assert_both_programs_on_update(
                spec,
                &scenario.store,
                &update,
                Err(Error::InvalidGenesisValidatorsRootBranch),
                spec.name,
            );
        }
    }
}

/// Claim: every entry of the branch matters. Flipping one bit of any single entry, on every layout, gives
/// `InvalidGenesisValidatorsRootBranch` in both programs.
/// Why it matters: a branch whose entries are only partly checked would let an attacker choose the unchecked part.
#[test]
fn every_entry_of_the_genesis_validators_root_branch_matters() {
    for case in layout_cases() {
        for position in 0..case.update.genesis_validators_root_branch.len() {
            let mut branch = case.update.genesis_validators_root_branch.clone();
            branch[position].0[0] ^= 1;
            let update = LightClientUpdate { genesis_validators_root_branch: branch, ..case.update.clone() };
            assert_both_programs_on_update(
                case.spec,
                &case.store,
                &update,
                Err(Error::InvalidGenesisValidatorsRootBranch),
                &format!("{} entry {position}", case.name),
            );
        }
    }
}

// ---------------------------------------------------------------------------------------------------------------------
// W-9, W-10: folds
// ---------------------------------------------------------------------------------------------------------------------

/// Claim: every step of a fold that changes layout checks its own branch of `genesis_validators_root`. In the Fulu to Gloas
/// fold (step 1 depth 6, 6 entries at 65; step 2 Gloas, 5 entries at 40), swapping the two branches gives
/// `InvalidGenesisValidatorsRootBranch` at step 1. A fold where only the last step is damaged also gives
/// `InvalidGenesisValidatorsRootBranch`. Control: the fold is accepted. Both programs agree.
/// Why it matters: the steps of one fold have different layouts, so each needs its own branch.
#[test]
fn every_step_of_a_mixed_fold_checks_its_own_genesis_validators_root() {
    let spec = &SEPOLIA;
    let MixedFold { store, steps } = fulu_to_gloas_fold();
    assert_eq!(steps[0].update.genesis_validators_root_branch.len(), 6);
    assert_eq!(steps[1].update.genesis_validators_root_branch.len(), 5);
    assert_both_programs(spec, &store, &steps, Ok(()), "control");

    let mut swapped = steps.clone();
    swapped[0].update.genesis_validators_root_branch = steps[1].update.genesis_validators_root_branch.clone();
    swapped[1].update.genesis_validators_root_branch = steps[0].update.genesis_validators_root_branch.clone();
    assert_both_programs(spec, &store, &swapped, Err(Error::InvalidGenesisValidatorsRootBranch), "swapped");

    for damaged_step in [0usize, 1] {
        let mut damaged = steps.clone();
        damaged[damaged_step].update.genesis_validators_root_branch[2].0[0] ^= 1;
        assert_both_programs(
            spec,
            &store,
            &damaged,
            Err(Error::InvalidGenesisValidatorsRootBranch),
            &format!("only step {damaged_step} damaged"),
        );
    }
    let start = fork_start_slot(spec, ForkName::Gloas);
    assert!(steps[1].update.finalized_header.beacon.slot > start, "step 2 is a Gloas step");
}

/// Claim: the fold in front of a fork observation checks the branch of `genesis_validators_root` of every step. In the
/// three step stale scenario, damaging the branch of any one step gives `InvalidGenesisValidatorsRootBranch` from
/// `verify_fork_observation`, and the honest fold is accepted. The observation has no state of its own to hide behind: the
/// error comes from the fold.
/// Why it matters: the rule applies to both programs. A fold that skipped the check in the observation program would let a
/// prover advance the store through a wrong layout and then observe a version.
#[test]
fn the_observation_fold_checks_the_genesis_validators_root() {
    for (spec, period) in lc_testkit::fork_observation_scenarios::chains() {
        let stale = stale_three_period_scenario(spec, period);
        let steps = fold_steps(spec, &stale.updates);
        let slot = stale.final_head_slot() + 100;
        let observation = observation_signed_by(spec, &stale.final_committee(), [0, 0, 3, 0x6d], 400, slot);
        assert!(verify_fork_observation(&stale.store, &steps, &observation, spec).is_ok(), "{}: control", spec.name);
        for damaged_step in 0..steps.len() {
            let mut damaged = steps.clone();
            damaged[damaged_step].update.genesis_validators_root_branch[0].0[0] ^= 1;
            assert_eq!(
                verify_fork_observation(&stale.store, &damaged, &observation, spec),
                Err(Error::InvalidGenesisValidatorsRootBranch),
                "{} step {damaged_step}",
                spec.name
            );
        }
    }
}

// ---------------------------------------------------------------------------------------------------------------------
// W-11: the wire format
// ---------------------------------------------------------------------------------------------------------------------

/// Claim: the wire format carries the branch of `genesis_validators_root` of every step. A guest input round-trips through
/// encode and decode with the branches intact. A truncated input, trailing bytes and a branch of 8 entries (above the limit
/// of 7) are refused. The guest entry point returns 352 bytes for a light-client fold.
/// Why it matters: the format change must not open a gap in the parser. The decoder limits the count before it reads nodes.
#[test]
fn the_wire_format_carries_the_genesis_validators_root_branch() {
    let MixedFold { store, steps } = fulu_to_gloas_fold();
    let input = GuestInput { chain: ChainSelector::Sepolia, store, steps };
    let bytes = encode_guest_input(&input);
    let decoded = decode_guest_input(&bytes).expect("the input decodes");
    assert_eq!(decoded, input);
    for (position, step) in decoded.steps.iter().enumerate() {
        assert_eq!(
            step.update.genesis_validators_root_branch, input.steps[position].update.genesis_validators_root_branch,
            "step {position}"
        );
        assert!(!step.update.genesis_validators_root_branch.is_empty());
    }
    assert_eq!(run_light_client_guest(&bytes).expect("the guest runs").len(), 352);

    assert!(decode_guest_input(&bytes[..bytes.len() - 1]).is_err(), "truncated");
    let mut trailing = bytes.clone();
    trailing.push(0);
    assert!(decode_guest_input(&trailing).is_err(), "trailing byte");

    let mut too_long = input.clone();
    too_long.steps[0].update.genesis_validators_root_branch = vec![B256::repeat_byte(1); 8];
    assert!(decode_guest_input(&encode_guest_input(&too_long)).is_err(), "a branch of 8 entries");
    let mut at_the_limit = input.clone();
    at_the_limit.steps[0].update.genesis_validators_root_branch = vec![B256::repeat_byte(1); 7];
    assert_eq!(decode_guest_input(&encode_guest_input(&at_the_limit)), Ok(at_the_limit), "7 entries decode");
}

/// Claim: the observation input carries both branches. It round-trips, a version branch of 10 entries (limit 9) and a branch
/// of `genesis_validators_root` of 8 entries (limit 7) are refused, a truncated input and trailing bytes are refused, and the
/// guest entry point returns 256 bytes that decode to a `ForkObservation` with the shape word.
/// Why it matters: same as for the update. The output grew by one word, and the input by two branches.
#[test]
fn the_observation_wire_format_carries_both_branches() {
    let (spec, period) = lc_testkit::fork_observation_scenarios::chains()[0];
    let scenario = lc_testkit::fork_observation_scenarios::one_step_scenario(spec, period);
    let observation = observation_signed_by(
        spec,
        &scenario.committee_for_signature(),
        [0, 0, 3, 0x6d],
        400,
        scenario.attested_slot(),
    );
    let input = ObservationGuestInput {
        chain: ChainSelector::Pulsechain,
        store: scenario.store.clone(),
        steps: Vec::new(),
        observation,
    };
    let bytes = encode_observation_input(&input);
    assert_eq!(decode_observation_input(&bytes), Ok(input.clone()));
    let public_values = run_fork_observation_guest(&bytes).expect("the guest runs");
    assert_eq!(public_values.len(), 256);
    let decoded = ForkObservation::abi_decode(&public_values).expect("a ForkObservation");
    assert_eq!(decoded.shape, honest_shape(spec));

    assert!(decode_observation_input(&bytes[..bytes.len() - 1]).is_err(), "truncated");
    let mut trailing = bytes.clone();
    trailing.push(0);
    assert!(decode_observation_input(&trailing).is_err(), "trailing byte");

    let mut long_version = input.clone();
    long_version.observation.current_version_branch = vec![B256::repeat_byte(2); 10];
    assert!(decode_observation_input(&encode_observation_input(&long_version)).is_err(), "version branch of 10");
    let mut long_root = input.clone();
    long_root.observation.genesis_validators_root_branch = vec![B256::repeat_byte(2); 8];
    assert!(decode_observation_input(&encode_observation_input(&long_root)).is_err(), "root branch of 8");
}

// ---------------------------------------------------------------------------------------------------------------------
// The observation proves the shape of its state
// ---------------------------------------------------------------------------------------------------------------------

/// Claim: the fork observation accepts an honest state of each shape (plain depth 5, 6, 7 and the progressive form) and
/// reports 5, 6, 7 and 255 in the `shape` word. A plain depth 8 state is refused with `InvalidForkShapeProof`, and so is a
/// state that holds a root other than the root of the chain in field 1. Control: the honest observations.
/// Why it matters: PulseChain has no beacon roots contract, so the observation proves the shape itself. The gate judges the `shape` word.
#[test]
fn the_fork_observation_reports_the_shape_of_its_state() {
    let (spec, period) = lc_testkit::fork_observation_scenarios::chains()[1];
    let scenario = lc_testkit::fork_observation_scenarios::one_step_scenario(spec, period);
    let signer = scenario.committee_for_signature();
    let slot = scenario.attested_slot();
    let version = [0, 0, 3, 0x6d];
    for shape in [5u8, 6, 7, 255] {
        let observation =
            lc_testkit::fork_observation_scenarios::observation_on_shape(spec, shape, &signer, version, 400, slot);
        let output = verify_fork_observation(&scenario.store, &[], &observation, spec).expect("an allowed shape");
        assert_eq!(output.shape, shape);
    }

    // A depth 8 state has a version branch of 10 entries, which no shape has.
    let mut wide = observed_state(spec, 7, version);
    let deep = {
        let mut leaves: Vec<B256> =
            (0..140).map(|index| lc_core::ssz::sha256(format!("deep/{index}").as_bytes())).collect();
        leaves[STATE_FIELD_GENESIS_VALIDATORS_ROOT as usize] = spec.genesis_validators_root;
        leaves
    };
    let fork_leaves = [
        lc_core::ssz::sha256(b"previous"),
        lc_core::observation::fork_version_leaf(version),
        lc_core::ssz::sha256(b"epoch"),
    ];
    let (fork_root, fork_branch) = lc_core::ssz::branch_for_leaf(&fork_leaves, 1);
    let mut leaves = deep;
    leaves[3] = fork_root;
    let (root, state_branch) = lc_core::ssz::branch_for_leaf(&leaves, 3);
    wide.root = root;
    wide.current_version_branch = [fork_branch, state_branch].concat();
    wide.genesis_validators_root_branch = lc_core::ssz::branch_for_leaf(&leaves, 1).1;
    assert_eq!(wide.current_version_branch.len(), 10);
    let observation = observation_over_state(spec, wide, &signer, version, version, 400, slot);
    assert_eq!(verify_fork_observation(&scenario.store, &[], &observation, spec), Err(Error::InvalidForkShapeProof));
}
