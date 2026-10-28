//! Fork observation of a plain state deeper than the light client accepts (depth 8 to 31).
//!
//! The light client refuses a state of more than 128 fields: its layouts stop at plain depth 7. The observation program
//! still proves such a shape, so the registry can record it and the gate can refuse deposits and seal. Without that, a
//! consensus-only fork to depth 8 would leave the gate open to deposits that the light client can never deliver.
//!
//! The fold steps of an observation keep every rule of the light client. The store reaches the fork and stops. The
//! committee that the store already knows signs the observation of the new header. The wire limits are wider for the
//! observation branches only (33 and 31 entries); the genesis validators root branch of a fold step keeps its limit of 7.
//!
//! Every test has a control and asserts the exact result.

use alloy_primitives::B256;
use lc_core::chain::{ChainSpec, PULSECHAIN};
use lc_core::layout::{FIRST_DISALLOWED_DEPTH, MAX_SEAL_DEPTH, STATE_DEPTHS};
use lc_core::observation::{fork_version_leaf, prove_observed_shape, verify_fork_observation, Observation};
use lc_core::ssz::{gindex_depth, sha256};
use lc_core::wire::{
    decode_observation_input, encode_observation_input, run_fork_observation_guest, ChainSelector,
    ObservationGuestInput,
};
use lc_core::Error;
use lc_testkit::fork_observation_scenarios::{
    chains, fold_steps, observation_on_shape, observed_header, stale_three_period_scenario, version_outside_table,
};
use lc_testkit::tree_model::{balanced, honest_looking_branch, progressive_state_tree, walk, Tree};

const VERSION: [u8; 4] = [0, 0, 0x03, 0x6d];

fn chain_selector(spec: &ChainSpec) -> ChainSelector {
    if spec.name == "pulsechain" {
        ChainSelector::Pulsechain
    } else {
        ChainSelector::EthereumMainnet
    }
}

/// Claim: a store whose fold steps are all before the fork (plain depth 5 on PulseChain, depth 6 on Ethereum) can observe
/// an attested state of plain depth 8, and the output reports shape 8. The same input through the guest entry point gives
/// 256 bytes that decode to the same value. Control: the same fold with an observation of the honest shape of the chain
/// reports 5 or 6.
/// Why it matters: this is the case of a real fork. The light client stops at the fork, and the committee it knows signs
/// the first header of the deeper state.
#[test]
fn a_store_that_folded_before_the_fork_observes_a_depth_eight_state() {
    for (spec, period) in chains() {
        let stale = stale_three_period_scenario(spec, period);
        let steps = fold_steps(spec, &stale.updates);
        let slot = stale.final_head_slot() + 100;
        let signer = stale.final_committee();
        let unknown = version_outside_table(spec);

        let honest_shape = lc_testkit::fork_observation_scenarios::honest_shape(spec);
        let control = observation_on_shape(spec, honest_shape, &signer, unknown, 400, slot);
        let control_output = verify_fork_observation(&stale.store, &steps, &control, spec).expect("control");
        assert_eq!(control_output.shape, honest_shape);

        let deeper = observation_on_shape(spec, 8, &signer, unknown, 400, slot);
        assert_eq!(deeper.current_version_branch.len(), 10);
        assert_eq!(deeper.genesis_validators_root_branch.len(), 8);
        let output = verify_fork_observation(&stale.store, &steps, &deeper, spec).expect("depth eight");
        assert_eq!(output.shape, 8, "{}", spec.name);
        assert_eq!(output.observedVersion.0, unknown);
        assert_eq!(output.previousHeaderRoot, stale.store.header_root, "the output still binds the starting store");

        let input = ObservationGuestInput {
            chain: chain_selector(spec),
            store: stale.store.clone(),
            steps,
            observation: deeper,
        };
        let bytes = encode_observation_input(&input);
        assert_eq!(decode_observation_input(&bytes), Ok(input));
        let public_values = run_fork_observation_guest(&bytes).expect("guest");
        assert_eq!(public_values.len(), 256);
        assert_eq!(public_values[255], 8, "the shape is the last byte of the last word");
    }
}

/// Claim: the wire decoder reads an observation with a version branch of 33 entries and a genesis validators root branch
/// of 31 entries (depth 31), and refuses 34 and 32. A fold step keeps its limit of 7: a step with 8 entries is refused,
/// and one with 7 is read. Control: the depth 8 input round-trips.
/// Why it matters: the wider limit belongs to the observation branches only. The light client itself still refuses
/// depth 8, so no fold step may carry a branch that deep.
#[test]
fn the_wide_wire_limits_apply_to_the_observation_branches_only() {
    let (spec, period) = chains()[0];
    let stale = stale_three_period_scenario(spec, period);
    let slot = stale.final_head_slot() + 100;
    let signer = stale.final_committee();
    let observation = |shape: u8| observation_on_shape(spec, shape, &signer, VERSION, 400, slot);
    let input_of = |observation: Observation, steps| ObservationGuestInput {
        chain: ChainSelector::Pulsechain,
        store: stale.store.clone(),
        steps,
        observation,
    };
    let round_trips =
        |input: &ObservationGuestInput| decode_observation_input(&encode_observation_input(input)) == Ok(input.clone());

    assert!(round_trips(&input_of(observation(8), Vec::new())), "control: depth 8");
    let deepest = observation(MAX_SEAL_DEPTH as u8);
    assert_eq!((deepest.current_version_branch.len(), deepest.genesis_validators_root_branch.len()), (33, 31));
    assert!(round_trips(&input_of(deepest.clone(), Vec::new())), "depth 31");

    let version_too_long = Observation {
        current_version_branch: [deepest.current_version_branch.clone(), vec![B256::ZERO]].concat(),
        ..deepest.clone()
    };
    assert!(!round_trips(&input_of(version_too_long, Vec::new())), "34 version entries");
    let genesis_too_long = Observation {
        genesis_validators_root_branch: [deepest.genesis_validators_root_branch.clone(), vec![B256::ZERO]].concat(),
        ..deepest
    };
    assert!(!round_trips(&input_of(genesis_too_long, Vec::new())), "32 genesis validators root entries");

    let step_with_branch = |entries: usize| {
        let mut steps = fold_steps(spec, &stale.updates[..1]);
        steps[0].update.genesis_validators_root_branch = vec![B256::ZERO; entries];
        input_of(observation(8), steps)
    };
    assert!(round_trips(&step_with_branch(7)), "a fold step may carry 7 entries");
    assert!(!round_trips(&step_with_branch(8)), "a fold step may not carry 8 entries");
}

/// The true tree of a state with the fork of `VERSION` and `spec`'s root: a plain tree of `depth` with the `Fork` container
/// as a real subtree (so the true position of the version is a node of the tree), or the Gloas progressive tree.
enum TrueState {
    Plain { depth: u32 },
    Progressive,
}

impl TrueState {
    fn name(&self) -> String {
        match self {
            Self::Plain { depth } => format!("plain depth {depth}"),
            Self::Progressive => "progressive".to_string(),
        }
    }

    fn tree(&self, genesis_validators_root: B256) -> Tree {
        let filler = |index: usize| sha256(format!("true-state-field/{index}").as_bytes());
        match self {
            Self::Progressive => {
                let mut fields: Vec<B256> = (0..46).map(filler).collect();
                fields[1] = genesis_validators_root;
                progressive_state_tree(&fields)
            }
            Self::Plain { depth } => {
                let fork = balanced(vec![
                    Tree::Leaf(sha256(b"previous")),
                    Tree::Leaf(fork_version_leaf(VERSION)),
                    Tree::Leaf(sha256(b"epoch")),
                    Tree::Leaf(B256::ZERO),
                ]);
                let mut nodes: Vec<Tree> = (0..(1usize << depth)).map(|_| Tree::Leaf(B256::ZERO)).collect();
                for (index, node) in nodes.iter_mut().enumerate().take(28) {
                    *node = Tree::Leaf(filler(index));
                }
                nodes[1] = Tree::Leaf(genesis_validators_root);
                nodes[3] = fork;
                balanced(nodes)
            }
        }
    }
}

/// Claim: no deeper candidate confirms an allowed shape. For each true state of plain depth 5, 6, 7 and the Gloas
/// progressive state, and for each claimed depth from 8 to 31, the test walks the claimed version position and the claimed root
/// position through the true tree. Every claim lands on a node that cannot hold the version leaf (a hash of zero
/// padding, a leaf of another field, or a place below a leaf) and cannot hold the root of the chain. The best
/// honest-looking branches are refused with `InvalidForkShapeProof`. Control: the true position of each plain state
/// holds the version leaf, and the true root position holds the root of the chain on every state.
/// Why it matters: a deeper candidate runs for any branch length of 10 to 33. If it could verify on a state of an
/// allowed shape, a stranger could pass a good fork off as a disallowed one and seal the gate.
#[test]
fn no_deeper_candidate_confirms_a_state_of_an_allowed_shape() {
    let root = PULSECHAIN.genesis_validators_root;
    let version_leaf = fork_version_leaf(VERSION);
    let states = [
        TrueState::Plain { depth: 5 },
        TrueState::Plain { depth: 6 },
        TrueState::Plain { depth: 7 },
        TrueState::Progressive,
    ];
    for state in states {
        let tree = state.tree(root);
        let name = state.name();
        let true_root_gindex = match state {
            TrueState::Plain { depth } => (1u64 << depth) + 1,
            TrueState::Progressive => 40,
        };
        let control = walk(&tree, true_root_gindex);
        assert_eq!((control.levels_below, control.leaf_value), (0, root), "{name}: control, the root");
        if let TrueState::Plain { depth } = state {
            let version_control = walk(&tree, ((1u64 << depth) + 3) * 4 + 1);
            assert_eq!(
                (version_control.levels_below, version_control.leaf_value),
                (0, version_leaf),
                "{name}: control"
            );
        }
        for depth in FIRST_DISALLOWED_DEPTH..=MAX_SEAL_DEPTH {
            let version_gindex = ((1u64 << depth) + 3) * 4 + 1;
            let root_gindex = (1u64 << depth) + 1;
            let version_walk = walk(&tree, version_gindex);
            let root_walk = walk(&tree, root_gindex);
            let version_lands_on_it = version_walk.levels_below == 0 && version_walk.leaf_value == version_leaf;
            let root_lands_on_it = root_walk.levels_below == 0 && root_walk.leaf_value == root;
            assert!(
                !version_lands_on_it,
                "{name}: depth {depth}: the version position holds a node that is not the version"
            );
            assert!(!root_lands_on_it, "{name}: depth {depth}: the root position holds a node that is not the root");
            let observation = Observation {
                attested_header: observed_header(100, tree.root()),
                signature_slot: 101,
                sync_aggregate: lc_core::types::SyncAggregate {
                    sync_committee_bits: [0; 64],
                    sync_committee_signature: [0; 96],
                },
                fork_version: VERSION,
                current_version_branch: honest_looking_branch(&version_walk),
                genesis_validators_root_branch: honest_looking_branch(&root_walk),
            };
            assert_eq!(observation.current_version_branch.len(), gindex_depth(version_gindex) as usize);
            assert_eq!(
                prove_observed_shape(&observation, &PULSECHAIN),
                Err(Error::InvalidForkShapeProof),
                "{name}: claimed depth {depth}"
            );
        }
    }
    assert_eq!(FIRST_DISALLOWED_DEPTH, STATE_DEPTHS.end() + 1);
}
