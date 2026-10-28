//! The signing fork version is an input of every fold step, and the evidence names the layout of every step.
//!
//! Why the version needs no table. The sync committee signs a domain that contains the fork version. A committee that a
//! public value binds, with two thirds of its members signing under version V, shows that the chain ran V when it
//! signed. So the program takes the version as an input, and the signature checks it. A wrong version gives another
//! domain, another signing root, and `SignatureVerificationFailed`.
//!
//! Real data (Ethereum and PulseChain) checks that rule on signatures that nobody here made. Synthetic data checks the
//! fork boundary (the version belongs to the epoch of `signature_slot - 1`), a fold that changes layout between steps
//! (Fulu to Gloas, finality branch 7 then 9), and the refusal of altered step lengths in the fork-observation folds.

use alloy_primitives::B256;
use alloy_sol_types::SolValue;
use lc_core::abi::LightClientOutput;
use lc_core::chain::{ChainSpec, ForkEntry, ForkName, ETHEREUM_MAINNET, FAR_FUTURE_EPOCH, PULSECHAIN, SEPOLIA};
use lc_core::layout::{state_layout_for_finality_branch_length, ELECTRA_STATE_LAYOUT, GLOAS_STATE_LAYOUT};
use lc_core::observation::verify_fork_observation;
use lc_core::types::{HeaderForm, LightClientStore, LightClientUpdate};
use lc_core::update::{
    table_fork_version, verify_fold, verify_light_client_update_with_fork_version, verify_step, verify_sync_aggregate,
    FoldStep,
};
use lc_core::wire::{
    decode_guest_input, encode_guest_input, encode_observation_input, run_fork_observation_guest,
    run_light_client_guest, ChainSelector, GuestInput, ObservationGuestInput,
};
use lc_core::Error;
use lc_testkit::fork_observation_scenarios::{
    chains, fold_steps, observation_signed_by, stale_three_period_scenario, version_outside_table, StaleScenario,
};
use lc_testkit::json::{bootstrap, fixtures_dir, light_client_update, load_response, store_from_bootstrap};
use lc_testkit::pulsechain::real_update_and_store;
use lc_testkit::real_proofs::{assert_stops_at_the_missing_branch, has_branch, with_known_branch};
use lc_testkit::synthetic::{
    build_gloas_update, build_update, committee_for, fork_start_slot, fulu_to_gloas_fold, MixedFold, UpdateRecipe,
};

// ---------------------------------------------------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------------------------------------------------

/// The fork version of the Fulu fork of Ethereum mainnet: the version of the real finality update.
const ETHEREUM_REAL_VERSION: [u8; 4] = [0x06, 0, 0, 0];

/// The fork version of the Capella fork of PulseChain: the version of the real update.
const PULSECHAIN_REAL_VERSION: [u8; 4] = [0, 0, 0x03, 0x6c];

/// Every wrong version that the tests try: each of the four bytes flipped, the version of the other chain, all zero and
/// `0xffffffff`. The real version itself is removed from the list.
fn wrong_versions(real: [u8; 4], foreign: [u8; 4]) -> Vec<[u8; 4]> {
    let mut versions: Vec<[u8; 4]> = (0..4)
        .map(|position| {
            let mut flipped = real;
            flipped[position] ^= 0xff;
            flipped
        })
        .collect();
    versions.extend([foreign, [0; 4], [0xff; 4]]);
    versions.retain(|version| *version != real);
    versions
}

/// Asserts that `real` verifies the update and every version of `wrong` is refused with `SignatureVerificationFailed`.
///
/// An update with a branch of `genesis_validators_root` runs through the whole program. A real update without one (the
/// Ethereum update, see `lc_testkit::real_proofs`) runs the real aggregate under each version, which is the same signature
/// check, and the program is pinned to stop at the missing branch.
fn assert_only_the_real_version_verifies(
    spec: &ChainSpec,
    store: &LightClientStore,
    update: &LightClientUpdate,
    real: [u8; 4],
    wrong: &[[u8; 4]],
) {
    assert!(!wrong.is_empty());
    let verdict = |version: [u8; 4]| match has_branch(update) {
        true => verify_light_client_update_with_fork_version(store, update, spec, version).map(|_| ()),
        false => verify_sync_aggregate(
            spec,
            &store.current_sync_committee,
            &update.sync_aggregate,
            &update.attested_header.beacon.hash_tree_root(),
            version,
        ),
    };
    assert_eq!(verdict(real), Ok(()), "control: the real version {real:?} verifies");
    for version in wrong {
        assert_eq!(verdict(*version), Err(Error::SignatureVerificationFailed), "version {version:?}");
    }
    if !has_branch(update) {
        assert_stops_at_the_missing_branch(store, update, spec, real);
    }
}

/// The wire selector of a chain of the tests.
fn selector(spec: &ChainSpec) -> ChainSelector {
    match spec.name {
        "pulsechain" => ChainSelector::Pulsechain,
        "sepolia" => ChainSelector::Sepolia,
        _ => ChainSelector::EthereumMainnet,
    }
}

// ---------------------------------------------------------------------------------------------------------------------
// 1. Real data
// ---------------------------------------------------------------------------------------------------------------------

/// Claim: on REAL data, the real fork version verifies and every other version fails with `SignatureVerificationFailed`.
/// The real update is the Ethereum finality update (Fulu, store from the bootstrap of the same period) and the PulseChain
/// update (Capella). The wrong versions are each of the four bytes flipped, the version of the other chain, all zero and
/// `0xffffffff`. The real version is `table_fork_version(spec, signature_slot)`.
/// Why it is safe: the committee signs a domain that contains the fork version, so two thirds of a bound committee
/// signing under version V show that the chain ran V. The program takes the version as an input and needs no table: a
/// prover that names another version changes the signing root, and the real signature does not verify under it.
#[test]
fn real_updates_verify_only_under_the_real_fork_version() {
    let ethereum_update =
        with_known_branch(light_client_update(&load_response("ethereum/finality_update.json")["data"]));
    let ethereum_store =
        store_from_bootstrap(&bootstrap(&load_response("ethereum/bootstrap_same_period.json")["data"]), None);
    let (pulsechain_store, pulsechain_update) = real_update_and_store();
    let cases = [
        (&ETHEREUM_MAINNET, &ethereum_store, &ethereum_update, ETHEREUM_REAL_VERSION, PULSECHAIN_REAL_VERSION),
        (&PULSECHAIN, &pulsechain_store, &pulsechain_update, PULSECHAIN_REAL_VERSION, ETHEREUM_REAL_VERSION),
    ];
    for (spec, store, update, real, foreign) in cases {
        assert_eq!(table_fork_version(spec, update.signature_slot), real, "{}: the table agrees", spec.name);
        assert_only_the_real_version_verifies(spec, store, update, real, &wrong_versions(real, foreign));
    }
}

// ---------------------------------------------------------------------------------------------------------------------
// 2. The fork boundary
// ---------------------------------------------------------------------------------------------------------------------

/// A copy of the Ethereum schedule with Electra and Fulu 100 epochs later. On the real chain every fork starts a sync
/// committee period, so a signature in the first slot of a fork epoch (case b) cannot have a crossing. Here the fork
/// starts in the middle of a period and all three cases are valid updates.
static ETHEREUM_SHIFTED_FORKS: [ForkEntry; 8] = [
    ForkEntry { epoch: 0, fork_version: [0x00, 0x00, 0x00, 0x00], fork_name: ForkName::Phase0 },
    ForkEntry { epoch: 74_240, fork_version: [0x01, 0x00, 0x00, 0x00], fork_name: ForkName::Altair },
    ForkEntry { epoch: 144_896, fork_version: [0x02, 0x00, 0x00, 0x00], fork_name: ForkName::Bellatrix },
    ForkEntry { epoch: 194_048, fork_version: [0x03, 0x00, 0x00, 0x00], fork_name: ForkName::Capella },
    ForkEntry { epoch: 269_568, fork_version: [0x04, 0x00, 0x00, 0x00], fork_name: ForkName::Deneb },
    ForkEntry { epoch: 364_132, fork_version: [0x05, 0x00, 0x00, 0x00], fork_name: ForkName::Electra },
    ForkEntry { epoch: 411_492, fork_version: [0x06, 0x00, 0x00, 0x00], fork_name: ForkName::Fulu },
    ForkEntry { epoch: FAR_FUTURE_EPOCH, fork_version: [0x07, 0x00, 0x00, 0x00], fork_name: ForkName::Gloas },
];
static ETHEREUM_SHIFTED: ChainSpec =
    ChainSpec { name: "ethereum-shifted-forks", fork_schedule: &ETHEREUM_SHIFTED_FORKS, ..ETHEREUM_MAINNET };

/// A copy of the Sepolia schedule with Fulu and Gloas 100 epochs later (same reason as [`ETHEREUM_SHIFTED_FORKS`]).
static SEPOLIA_SHIFTED_FORKS: [ForkEntry; 8] = [
    ForkEntry { epoch: 0, fork_version: [0x90, 0x00, 0x00, 0x69], fork_name: ForkName::Phase0 },
    ForkEntry { epoch: 50, fork_version: [0x90, 0x00, 0x00, 0x70], fork_name: ForkName::Altair },
    ForkEntry { epoch: 100, fork_version: [0x90, 0x00, 0x00, 0x71], fork_name: ForkName::Bellatrix },
    ForkEntry { epoch: 56_832, fork_version: [0x90, 0x00, 0x00, 0x72], fork_name: ForkName::Capella },
    ForkEntry { epoch: 132_608, fork_version: [0x90, 0x00, 0x00, 0x73], fork_name: ForkName::Deneb },
    ForkEntry { epoch: 222_464, fork_version: [0x90, 0x00, 0x00, 0x74], fork_name: ForkName::Electra },
    ForkEntry { epoch: 272_740, fork_version: [0x90, 0x00, 0x00, 0x75], fork_name: ForkName::Fulu },
    ForkEntry { epoch: 353_124, fork_version: [0x90, 0x00, 0x00, 0x76], fork_name: ForkName::Gloas },
];
static SEPOLIA_SHIFTED: ChainSpec =
    ChainSpec { name: "sepolia-shifted-forks", fork_schedule: &SEPOLIA_SHIFTED_FORKS, ..SEPOLIA };

/// The version before and after the fork that starts at `fork_slot`: the versions of the epochs on either side.
fn versions_around(spec: &ChainSpec, fork_slot: u64) -> (/* old */ [u8; 4], /* new */ [u8; 4]) {
    let epoch = spec.epoch_at_slot(fork_slot);
    (spec.fork_version_at(epoch - 1), spec.fork_version_at(epoch))
}

/// Builds the update of `recipe` with the builder that fits the fork of its attested slot: a Gloas-typed update (compact
/// headers, finality branch 9) from the Gloas epoch on, a full-header update before.
fn build_pair(spec: &'static ChainSpec, recipe: UpdateRecipe) -> (LightClientStore, LightClientUpdate) {
    if spec.fork_at_slot(recipe.attested_slot) >= ForkName::Gloas {
        let scenario = build_gloas_update(spec, recipe);
        return (scenario.store, scenario.update);
    }
    let scenario = build_update(spec, recipe);
    (scenario.store, scenario.update)
}

/// A recipe that signs at `signature_slot` and stays inside one period: store 1500 slots, finalized 100 slots before the
/// signature slot, attested one slot before it. The period must hold all of them.
fn inside_one_period(signature_slot: u64) -> UpdateRecipe {
    UpdateRecipe {
        store_slot: signature_slot - 1500,
        finalized_slot: signature_slot - 100,
        attested_slot: signature_slot - 1,
        signature_slot,
        participants: 342,
        include_next_committee: false,
        store_knows_next_committee: false,
    }
}

/// Checks the three slots around the fork that starts at `fork_slot`. `recipe_at` makes the update for a signature slot.
/// (a) The last slot of the epoch before the fork and (b) the first slot of the fork epoch both sign under the OLD
/// version, because `signature_slot - 1` is still in the epoch before. (c) The second slot of the fork epoch signs under the
/// NEW version. For each, the table names the expected version, that version verifies, and the neighbouring fork's version fails.
fn assert_boundary_versions(
    spec: &'static ChainSpec,
    fork_slot: u64,
    recipe_at: impl Fn(u64) -> UpdateRecipe,
    slots: &[(u64, bool)],
) {
    let (old, new) = versions_around(spec, fork_slot);
    assert_ne!(old, new);
    for (signature_slot, expects_new) in slots {
        let (expected, neighbour) = if *expects_new { (new, old) } else { (old, new) };
        let (store, update) = build_pair(spec, recipe_at(*signature_slot));
        assert_eq!(table_fork_version(spec, *signature_slot), expected, "table, slot {signature_slot}");
        assert_only_the_real_version_verifies(spec, &store, &update, expected, &[neighbour]);
    }
}

/// Claim: the version of an update is the version of the epoch of `signature_slot - 1`. At the start of a fork, the last
/// slot before the fork epoch (a) and the FIRST slot of the fork epoch (b) sign under the old version, and the second slot of
/// the fork epoch (c) signs under the new version. The version of the table verifies and the version of the neighbouring fork
/// fails with `SignatureVerificationFailed`. The forks are Electra and Fulu of Ethereum mainnet and Fulu and Gloas of Sepolia,
/// on schedules shifted 100 epochs into a period (see the statics above). Gloas is built with `build_gloas_update` when the
/// attested slot is in the Gloas epoch (case c), and with `build_update` before.
/// Why it is safe: the domain of the signature holds the version of the slot before the signature slot (the slot of the
/// block that the aggregate signs is `signature_slot - 1`). A prover that picks the version of the fork it likes gets a
/// different signing root, and the committee did not sign it.
#[test]
fn the_version_is_the_one_at_the_epoch_of_the_slot_before_the_signature_slot() {
    let cases: [(&'static ChainSpec, ForkName); 4] = [
        (&ETHEREUM_SHIFTED, ForkName::Electra),
        (&ETHEREUM_SHIFTED, ForkName::Fulu),
        (&SEPOLIA_SHIFTED, ForkName::Fulu),
        (&SEPOLIA_SHIFTED, ForkName::Gloas),
    ];
    for (spec, fork) in cases {
        let fork_slot = fork_start_slot(spec, fork);
        assert_ne!(fork_slot % 8192, 0, "the fork starts inside a period");
        let slots = [(fork_slot - 1, false), (fork_slot, false), (fork_slot + 1, true)];
        assert_boundary_versions(spec, fork_slot, inside_one_period, &slots);
    }
}

/// Claim: on the REAL schedules, where every fork starts a period, (a) the last slot before the fork signs under the old
/// version and (c) the second slot of the fork epoch signs under the new one, with a crossing into the new period. Case (b),
/// a signature in the first slot of the fork epoch, is refused with `SignatureInNextPeriodWithoutCrossing`, whatever the
/// version: the attested slot is before the fork, so the finalized slot is too, and the head stays in the old period.
/// Why it matters: this documents why case (b) is only testable on the shifted schedules, and shows the boundary rule on
/// the schedules that the programs know.
#[test]
fn the_version_rule_holds_on_the_real_schedules_at_a_period_start() {
    let cases: [(&'static ChainSpec, ForkName); 4] = [
        (&ETHEREUM_MAINNET, ForkName::Electra),
        (&ETHEREUM_MAINNET, ForkName::Fulu),
        (&SEPOLIA, ForkName::Fulu),
        (&SEPOLIA, ForkName::Gloas),
    ];
    for (spec, fork) in cases {
        let fork_slot = fork_start_slot(spec, fork);
        assert_eq!(fork_slot % 8192, 0, "the real fork starts a period");
        let (old, new) = versions_around(spec, fork_slot);
        // (c): the finalized and the attested header are in the first slot of the fork. The store knows its next committee.
        let crossing = |signature_slot: u64| UpdateRecipe {
            store_slot: fork_slot - 1000,
            finalized_slot: fork_slot,
            attested_slot: signature_slot - 1,
            signature_slot,
            participants: 342,
            include_next_committee: false,
            store_knows_next_committee: true,
        };
        assert_boundary_versions(spec, fork_slot, crossing, &[(fork_slot + 1, true)]);
        assert_boundary_versions(spec, fork_slot, inside_one_period, &[(fork_slot - 1, false)]);

        // (b): the signature slot starts the new period, and nothing finalizes in it.
        let (store, update) =
            build_pair(spec, UpdateRecipe { store_knows_next_committee: true, ..inside_one_period(fork_slot) });
        for version in [old, new] {
            assert_eq!(
                verify_light_client_update_with_fork_version(&store, &update, spec, version),
                Err(Error::SignatureInNextPeriodWithoutCrossing),
                "{} {fork:?} version {version:?}",
                spec.name
            );
        }
    }
}

// ---------------------------------------------------------------------------------------------------------------------
// 3 and 5. A fold from Fulu to Gloas
// ---------------------------------------------------------------------------------------------------------------------

/// Claim: a fold from Fulu to Gloas verifies although the finality branch changes from 7 entries to 9 between steps. Each
/// step alone has its layout: step 1 the Electra layout (finality branch 7, next committee branch 6, full headers), step 2
/// the Gloas layout (finality branch 9, next committee branch 11, compact headers). The signing committee of step 2 is
/// the committee that step 1 leaves as the next committee of the store. The fold output equals the output of applying
/// the steps one by one (first step for the `previous*` and start fields, last for the new head and committee). The wire
/// format (extended, because a header is compact) runs through `run_light_client_guest` and gives the same 352 bytes.
/// Why it is safe: every step is checked on its own against the store that the step before it leaves. The layout of a
/// step comes from its own branch lengths, so a fold may change layout, and the version of a step is its own input.
#[test]
fn a_fold_from_fulu_to_gloas_verifies_and_matches_the_steps_one_by_one() {
    let spec = &SEPOLIA;
    let MixedFold { store, steps } = fulu_to_gloas_fold();
    let (first, second) = (&steps[0], &steps[1]);

    let lengths = |update: &LightClientUpdate| {
        (update.finality_branch.len(), update.next_sync_committee.as_ref().expect("next committee").branch.len())
    };
    assert_eq!(lengths(&first.update), (7, 6));
    assert_eq!(lengths(&second.update), (9, 11));
    assert_eq!(state_layout_for_finality_branch_length(first.update.finality_branch.len()), Ok(ELECTRA_STATE_LAYOUT));
    assert_eq!(state_layout_for_finality_branch_length(second.update.finality_branch.len()), Ok(GLOAS_STATE_LAYOUT));
    assert_eq!(first.update.finalized_header.form, HeaderForm::Full);
    assert_eq!(second.update.finalized_header.form, HeaderForm::Compact);

    // One by one.
    let (first_output, after_first) = verify_step(&store, &first.update, spec, first.fork_version).expect("step 1");
    let signing_period = spec.period_at_slot(second.update.signature_slot);
    assert_eq!(
        after_first.next_sync_committee.as_ref(),
        Some(&committee_for(spec, signing_period).committee),
        "step 2 is signed by the committee that step 1 leaves"
    );
    let (second_output, after_second) =
        verify_step(&after_first, &second.update, spec, second.fork_version).expect("step 2");
    assert_eq!(second_output.syncCommitteeHash, first_output.nextSyncCommitteeHash, "the crossing makes it current");

    // The fold.
    let (output, final_store) = verify_fold(&store, &steps, spec).expect("the fold");
    let expected = LightClientOutput {
        genesisValidatorsRoot: first_output.genesisValidatorsRoot,
        previousHeaderRoot: first_output.previousHeaderRoot,
        previousHeadSlot: first_output.previousHeadSlot,
        previousSyncCommitteeHash: first_output.previousSyncCommitteeHash,
        startNextSyncCommitteeHash: first_output.startNextSyncCommitteeHash,
        newHeaderRoot: second_output.newHeaderRoot,
        newHeadSlot: second_output.newHeadSlot,
        executionBlockHash: second_output.executionBlockHash,
        executionBlockNumber: second_output.executionBlockNumber,
        syncCommitteeHash: second_output.syncCommitteeHash,
        nextSyncCommitteeHash: second_output.nextSyncCommitteeHash,
    };
    assert_eq!(output, expected);
    assert_eq!(final_store, after_second);
    assert_ne!(output.nextSyncCommitteeHash, B256::ZERO, "step 2 proved the committee of period 1380");

    // The wire format.
    let input = GuestInput { chain: selector(spec), store, steps };
    let bytes = encode_guest_input(&input);
    assert_ne!(bytes[0] & 0x80, 0, "a compact header selects the extended format");
    assert_eq!(decode_guest_input(&bytes), Ok(input));
    let public_values = run_light_client_guest(&bytes).expect("the guest runs the fold");
    assert_eq!(public_values.len(), 352);
    assert_eq!(public_values, output.abi_encode());
}

/// Claim: in the Fulu to Gloas fold the version is per step. The Gloas version in step 1, and the Fulu version in step 2,
/// each give `SignatureVerificationFailed`. With the versions back in place the fold passes (control).
/// Why it is safe: a step signs under the version of its own slot, so the version of the other step is the version of
/// another domain. A prover cannot name one version for the whole fold.
#[test]
fn in_a_mixed_fold_the_version_belongs_to_its_own_step() {
    let spec = &SEPOLIA;
    let MixedFold { store, steps } = fulu_to_gloas_fold();
    let (fulu_version, gloas_version) = (steps[0].fork_version, steps[1].fork_version);
    assert_eq!(fulu_version, [0x90, 0, 0, 0x75]);
    assert_eq!(gloas_version, [0x90, 0, 0, 0x76]);
    assert!(verify_fold(&store, &steps, spec).is_ok(), "control");

    for (step_index, other_version) in [(0, gloas_version), (1, fulu_version)] {
        let mut swapped = steps.clone();
        swapped[step_index].fork_version = other_version;
        assert_eq!(verify_fold(&store, &swapped, spec), Err(Error::SignatureVerificationFailed), "step {step_index}");
        swapped[step_index].fork_version = steps[step_index].fork_version;
        assert!(verify_fold(&store, &swapped, spec).is_ok(), "swapped back, step {step_index}");
    }
}

// ---------------------------------------------------------------------------------------------------------------------
// 4. Altered step lengths in the fork-observation folds
// ---------------------------------------------------------------------------------------------------------------------

/// How a branch is altered: a zero entry in front (the branch is one longer), or the first entry cut (one shorter).
#[derive(Clone, Copy, Debug)]
enum BranchEdit {
    Pad,
    Cut,
}

impl BranchEdit {
    fn apply(self, branch: &mut Vec<B256>) {
        match self {
            Self::Pad => branch.insert(0, B256::ZERO),
            Self::Cut => {
                branch.remove(0);
            }
        }
    }
}

/// The honest fold-then-observe case of the fixtures `*_accept_after_folding_a_stale_store.json`, as the fixture builder
/// makes it: the observation names a version outside the table, signed by the committee of period P+2.
fn stale_case(
    spec: &'static ChainSpec,
    period: u64,
) -> (StaleScenario, Vec<FoldStep>, lc_core::observation::Observation) {
    let stale = stale_three_period_scenario(spec, period);
    let steps = fold_steps(spec, &stale.updates);
    let slot = stale.final_head_slot() + 100;
    let observation = observation_signed_by(spec, &stale.final_committee(), version_outside_table(spec), 400, slot);
    (stale, steps, observation)
}

/// Verifies the observation after `steps` through the library and through the guest (wire format), and returns the error
/// of both. The two must agree.
fn observation_error(
    spec: &'static ChainSpec,
    stale: &StaleScenario,
    steps: &[FoldStep],
    observation: &lc_core::observation::Observation,
) -> Error {
    let direct = verify_fork_observation(&stale.store, steps, observation, spec).expect_err("refused");
    let input = ObservationGuestInput {
        chain: selector(spec),
        store: stale.store.clone(),
        steps: steps.to_vec(),
        observation: observation.clone(),
    };
    let through_guest = run_fork_observation_guest(&encode_observation_input(&input)).expect_err("refused");
    assert_eq!(direct, through_guest, "the guest gives the same error");
    direct
}

/// The error of an altered finality branch, by the true length and the edit. Length 6 padded gives 7 and length 7 cut gives
/// 6: both name the OTHER plain layout (index 169 on a depth 5 state, index 105 on a depth 6 state), the branch check
/// lands on another node, and the check fails: `InvalidFinalityBranch`. Length 7 padded gives 8, which names plain depth 7
/// (index 297): the finality check comes first in `verify_step` and fails there, also `InvalidFinalityBranch`. Length 6 cut
/// gives 5, which no layout has, so `UnsupportedStateBranchLength`, and no node is read at all.
fn expected_finality_error(true_length: usize, edit: BranchEdit) -> Error {
    match (true_length, edit) {
        (6, BranchEdit::Pad) | (7, BranchEdit::Cut) | (7, BranchEdit::Pad) => Error::InvalidFinalityBranch,
        (6, BranchEdit::Cut) => Error::UnsupportedStateBranchLength { length: 5 },
        other => panic!("no case for {other:?}"),
    }
}

/// Claim: in the fold behind `*_accept_after_folding_a_stale_store.json`, the honest case is accepted and its 256 byte
/// public values equal the `publicValues` of the fixture on disk. Then, for EVERY step in turn, a finality branch with a
/// zero entry in front, and a finality branch with its first entry cut, are refused: `InvalidFinalityBranch` when the
/// new length names a layout (6 padded to 7, 7 cut to 6, 7 padded to 8) and `UnsupportedStateBranchLength` when it names
/// none (6 cut to 5). The library and the guest (wire format) agree.
/// Why it is safe: the length of a branch is its depth, checked exactly, and it chooses the layout. A length that names no
/// layout is refused. A length that names the other plain layout makes the branch check read another node (169 on a true
/// depth 5 state lands below `eth1_deposit_index`, a uint64 leaf, and 105 on a true depth 6 state is a padding chunk), so
/// no honest branch reaches it.
#[test]
fn altered_finality_branches_in_the_observation_fold_are_refused() {
    for (spec, period) in chains() {
        let (stale, steps, observation) = stale_case(spec, period);
        let honest = verify_fork_observation(&stale.store, &steps, &observation, spec).expect("control: accepted");
        let public_values = honest.abi_encode();
        assert_eq!(public_values.len(), 256);

        let fixture_name = format!(
            "{}_accept_after_folding_a_stale_store.json",
            match spec.name {
                "pulsechain" => "pulsechain",
                _ => "ethereum",
            }
        );
        let text =
            std::fs::read_to_string(fixtures_dir().join("fork-observation").join(&fixture_name)).expect("fixture");
        let fixture: serde_json::Value = serde_json::from_str(&text).expect("fixture json");
        assert_eq!(
            fixture["publicValues"].as_str().expect("publicValues"),
            format!("0x{}", alloy_primitives::hex::encode(&public_values)),
            "{fixture_name}"
        );

        for index in 0..steps.len() {
            let true_length = steps[index].update.finality_branch.len();
            for edit in [BranchEdit::Pad, BranchEdit::Cut] {
                let mut altered = steps.clone();
                edit.apply(&mut altered[index].update.finality_branch);
                assert_eq!(
                    observation_error(spec, &stale, &altered, &observation),
                    expected_finality_error(true_length, edit),
                    "{} step {index} {edit:?}",
                    spec.name
                );
            }
        }
    }
}

/// Claim: in the same fold, for EVERY step, a next committee branch with a zero entry in front, and one with its first entry
/// cut, are refused with `InvalidNextSyncCommitteeBranch` (the finality branch of the step stays honest).
/// Why it is safe: the next committee branch must have the depth of the layout that the finality branch names (5 on
/// PulseChain, 6 on Ethereum here), checked exactly. A branch one longer or one shorter is not the branch of that node,
/// and no leading zero is stripped to make it fit.
#[test]
fn altered_next_committee_branches_in_the_observation_fold_are_refused() {
    for (spec, period) in chains() {
        let (stale, steps, observation) = stale_case(spec, period);
        assert!(verify_fork_observation(&stale.store, &steps, &observation, spec).is_ok(), "control");
        for index in 0..steps.len() {
            for edit in [BranchEdit::Pad, BranchEdit::Cut] {
                let mut altered = steps.clone();
                let next = altered[index].update.next_sync_committee.as_mut().expect("every step proves one");
                edit.apply(&mut next.branch);
                assert_eq!(
                    observation_error(spec, &stale, &altered, &observation),
                    Error::InvalidNextSyncCommitteeBranch,
                    "{} step {index} {edit:?}",
                    spec.name
                );
            }
        }
    }
}
