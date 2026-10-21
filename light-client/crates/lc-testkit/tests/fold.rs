//! Folded updates: the light-client program applies a list of 1 to 64 updates and outputs one tuple.
//!
//! Every update here is SYNTHETIC (generated committees, test-only state builder), on both layouts: PulseChain (Capella)
//! and Ethereum (Fulu, Electra layout). Every attack test has a control that shows the same fold passes without the attack.
//! The rules come from `docs/hardened-build-contract.md`, section "Change: historical ancestry and folded updates".

use alloy_primitives::B256;
use alloy_sol_types::SolValue;
use lc_core::abi::LightClientOutput;
use lc_core::chain::{ChainSpec, ETHEREUM_MAINNET, PULSECHAIN};
use lc_core::types::{compute_signing_root, sync_committee_domain, LightClientStore, LightClientUpdate};
use lc_core::update::{
    table_fork_version, verify_light_client_fold, verify_light_client_update, FoldStep, MAX_FOLD_UPDATES,
};
use lc_core::wire::{decode_guest_input, encode_guest_input, run_light_client_guest, ChainSelector, GuestInput};
use lc_core::Error;
use lc_testkit::synthetic::{
    build_update, committee_for, make_committee, sign_with_first_members, TestCommittee, UpdateRecipe,
};

/// (chain, period of the initial store). Both periods are far from every fork boundary.
fn chains() -> [(&'static ChainSpec, u64); 2] {
    [(&PULSECHAIN, 1326), (&ETHEREUM_MAINNET, 1889)]
}

fn committee_hash(spec: &ChainSpec, period: u64) -> B256 {
    committee_for(spec, period).committee.hash_tree_root().expect("committee root")
}

/// One recipe that stays inside the period that starts at `period_start`. It proves the next committee when asked.
fn inside_period(period_start: u64, store_offset: u64, finalized_offset: u64, include_next: bool) -> UpdateRecipe {
    UpdateRecipe {
        store_slot: period_start + store_offset,
        finalized_slot: period_start + finalized_offset,
        attested_slot: period_start + finalized_offset + 70,
        signature_slot: period_start + finalized_offset + 71,
        participants: 342,
        include_next_committee: include_next,
        store_knows_next_committee: false,
    }
}

/// One recipe that finalizes `finalized_offset` slots into the period at `finalized_period_start`, signed in that period
/// by the committee of that period. The store head is `store_slot`, in the period before.
fn crossing_into(
    finalized_period_start: u64,
    store_slot: u64,
    finalized_offset: u64,
    include_next: bool,
) -> UpdateRecipe {
    UpdateRecipe {
        store_slot,
        finalized_slot: finalized_period_start + finalized_offset,
        attested_slot: finalized_period_start + finalized_offset + 66,
        signature_slot: finalized_period_start + finalized_offset + 67,
        participants: 342,
        include_next_committee: include_next,
        store_knows_next_committee: false,
    }
}

/// A fold across three periods. Step 1 stays in period P and proves committee P+1. Step 2 crosses into P+1 and proves P+2.
/// Step 3 crosses into P+2 and proves P+3. The store has no next committee at the start.
fn three_period_fold(spec: &'static ChainSpec, period: u64) -> (LightClientStore, Vec<LightClientUpdate>) {
    let start = period * 8192;
    let first = build_update(spec, inside_period(start, 400, 1000, true));
    let second = build_update(spec, crossing_into(start + 8192, first.update.finalized_header.beacon.slot, 64, true));
    let third =
        build_update(spec, crossing_into(start + 2 * 8192, second.update.finalized_header.beacon.slot, 64, true));
    (first.store.clone(), vec![first.update, second.update, third.update])
}

fn assert_same_apart_from_the_new_field(fold: &LightClientOutput, single: &LightClientOutput) {
    assert_eq!(fold.genesisValidatorsRoot, single.genesisValidatorsRoot);
    assert_eq!(fold.previousHeaderRoot, single.previousHeaderRoot);
    assert_eq!(fold.previousHeadSlot, single.previousHeadSlot);
    assert_eq!(fold.previousSyncCommitteeHash, single.previousSyncCommitteeHash);
    assert_eq!(fold.newHeaderRoot, single.newHeaderRoot);
    assert_eq!(fold.newHeadSlot, single.newHeadSlot);
    assert_eq!(fold.executionBlockHash, single.executionBlockHash);
    assert_eq!(fold.executionBlockNumber, single.executionBlockNumber);
    assert_eq!(fold.syncCommitteeHash, single.syncCommitteeHash);
    assert_eq!(fold.nextSyncCommitteeHash, single.nextSyncCommitteeHash);
}

/// What rule 1 of the contract does with the start of a proof: `previousSyncCommitteeHash == syncCommittees[headPeriod]`
/// and `startNextSyncCommitteeHash == syncCommittees[headPeriod + 1]`, where zero equals zero.
fn contract_accepts_start(stored_current: B256, stored_next: B256, output: &LightClientOutput) -> bool {
    output.previousSyncCommitteeHash == stored_current && output.startNextSyncCommitteeHash == stored_next
}

/// Signs the attested header of `update` with `signer` instead of the committee the builder chose.
fn resign(spec: &ChainSpec, update: &mut LightClientUpdate, signer: &TestCommittee) {
    let domain = sync_committee_domain(spec, update.signature_slot);
    let signing_root = compute_signing_root(&update.attested_header.beacon.hash_tree_root(), &domain);
    update.sync_aggregate = sign_with_first_members(signer, 400, &signing_root);
}

/// Claim: a fold across three periods is accepted, and its single output describes the whole fold. `previous*` are the
/// initial store (period P, no next committee, so the start next hash is zero). `new*` and `syncCommitteeHash` are the
/// last step (period P+2). `nextSyncCommitteeHash` is committee P+3, which the last step proved. The returned store has
/// the same head as the output.
/// Why it matters: this is the catch-up proof. One Groth16 check replaces three, and the contract learns only the end.
#[test]
fn synthetic_fold_across_three_periods_is_accepted() {
    for (spec, period) in chains() {
        let (store, updates) = three_period_fold(spec, period);
        let (output, final_store) = verify_light_client_fold(&store, &updates, spec).expect("honest fold");
        assert_eq!(output.genesisValidatorsRoot, spec.genesis_validators_root);
        assert_eq!(output.previousHeaderRoot, store.header_root);
        assert_eq!(output.previousHeadSlot, store.header_slot);
        assert_eq!(output.previousSyncCommitteeHash, committee_hash(spec, period));
        assert_eq!(output.startNextSyncCommitteeHash, B256::ZERO, "the store had no next committee");
        let last = &updates[2].finalized_header;
        assert_eq!(output.newHeaderRoot, last.beacon.hash_tree_root());
        assert_eq!(output.newHeadSlot, last.beacon.slot);
        assert_eq!(output.executionBlockHash, last.execution.block_hash);
        assert_eq!(output.executionBlockNumber, last.execution.block_number);
        assert_eq!(spec.period_at_slot(output.newHeadSlot), period + 2);
        assert_eq!(output.syncCommitteeHash, committee_hash(spec, period + 2));
        assert_eq!(output.nextSyncCommitteeHash, committee_hash(spec, period + 3));
        assert_eq!(final_store.header_slot, output.newHeadSlot);
        assert_eq!(final_store.current_sync_committee, committee_for(spec, period + 2).committee);
        assert_eq!(output.abi_encode().len(), 352);
    }
}

/// Claim: a broken link anywhere in the middle rejects the whole fold, each time for its own reason. A skipped period
/// (the third update finalizes two periods past the head), a middle update signed by a committee that is not the
/// stored one, and a middle update that does not advance the head.
/// Control: the unbroken fold passes, and so does the fold of the first update alone.
#[test]
fn synthetic_fold_with_a_broken_link_in_the_middle_is_rejected() {
    let attacker = make_committee("fold-attacker-committee");
    for (spec, period) in chains() {
        let (store, updates) = three_period_fold(spec, period);
        assert!(verify_light_client_fold(&store, &updates, spec).is_ok(), "control: unbroken fold");
        assert!(verify_light_client_fold(&store, &updates[..1], spec).is_ok(), "control: first step alone");

        // A gap: step 3 finalizes in period P+3, while the head after step 2 is in P+1.
        let gap =
            build_update(spec, crossing_into((period + 3) * 8192, updates[1].finalized_header.beacon.slot, 64, true));
        let broken = vec![updates[0].clone(), updates[1].clone(), gap.update];
        assert!(
            matches!(verify_light_client_fold(&store, &broken, spec), Err(Error::PeriodOutOfRange(_))),
            "a skipped period"
        );

        // Step 2 is signed by a committee that is not the stored next committee.
        let mut forged = updates.clone();
        resign(spec, &mut forged[1], &attacker);
        assert_eq!(
            verify_light_client_fold(&store, &forged, spec),
            Err(Error::SignatureVerificationFailed),
            "a link signed by another committee"
        );

        // Step 2 repeats step 1: the head does not advance.
        let repeated = vec![updates[0].clone(), updates[0].clone(), updates[2].clone()];
        assert!(
            matches!(verify_light_client_fold(&store, &repeated, spec), Err(Error::NotFinalizedProgress(_))),
            "a link that does not advance the head"
        );
    }
}

/// Claim: a fold holds 1 to 64 updates. An empty list and 65 updates are rejected, in the fold function and in the guest
/// entry point (the wire decoder refuses a count above 64 before it verifies anything). 64 updates are accepted.
/// Why it matters: the bound caps the proving cost, and an empty fold would prove nothing yet output a tuple.
#[test]
fn synthetic_fold_length_is_one_to_sixty_four() {
    assert_eq!(MAX_FOLD_UPDATES, 64);
    for (spec, period) in chains() {
        let start = period * 8192;
        let first = build_update(spec, inside_period(start, 400, 1000, true));
        let mut updates = vec![first.update.clone()];
        for step in 1..64u64 {
            let previous = updates.last().expect("one update").finalized_header.beacon.slot;
            let recipe = UpdateRecipe { store_slot: previous, ..inside_period(start, 0, 1000 + 32 * step, false) };
            updates.push(build_update(spec, recipe).update);
        }
        assert_eq!(updates.len(), 64);
        let (output, _) = verify_light_client_fold(&first.store, &updates, spec).expect("64 updates");
        assert_eq!(output.newHeadSlot, start + 1000 + 32 * 63);

        assert_eq!(verify_light_client_fold(&first.store, &[], spec), Err(Error::FoldLengthOutOfRange { count: 0 }));
        let mut sixty_five = updates.clone();
        sixty_five.push(updates[63].clone());
        assert_eq!(
            verify_light_client_fold(&first.store, &sixty_five, spec),
            Err(Error::FoldLengthOutOfRange { count: 65 })
        );

        // The same limits at the guest entry point.
        let chain = if spec.name == "pulsechain" { ChainSelector::Pulsechain } else { ChainSelector::EthereumMainnet };
        let steps = |list: &[LightClientUpdate]| -> Vec<FoldStep> {
            list.iter()
                .map(|update| FoldStep {
                    update: update.clone(),
                    fork_version: table_fork_version(spec, update.signature_slot),
                })
                .collect()
        };
        let guest = |list: &[LightClientUpdate]| {
            run_light_client_guest(&encode_guest_input(&GuestInput {
                chain,
                store: first.store.clone(),
                steps: steps(list),
            }))
        };
        assert_eq!(guest(&updates[..1]).map(|bytes| bytes.len()), Ok(352), "control: one update");
        assert_eq!(guest(&[]), Err(Error::FoldLengthOutOfRange { count: 0 }));
        assert!(guest(&sixty_five).is_err(), "65 updates never reach the verifier");
        let encoded = encode_guest_input(&GuestInput { chain, store: first.store.clone(), steps: steps(&sixty_five) });
        assert!(decode_guest_input(&encoded).is_err(), "the decoder refuses a count above 64");
    }
}

/// Claim: an initial store that holds an INVENTED next committee cannot hide it. The program accepts the fold (it cannot
/// know the committee is invented), but `startNextSyncCommitteeHash` names it, so rule 1 of the contract fails: the stored
/// committee for the next period differs. With the honest store the same check passes (control).
/// Why it matters: without this field, an invented committee could sign the crossing and the contract would store its hash.
#[test]
fn synthetic_invented_next_committee_in_the_initial_store_is_exposed() {
    let attacker = make_committee("fold-invented-next-committee");
    for (spec, period) in chains() {
        let start = period * 8192;
        let recipe =
            UpdateRecipe { store_knows_next_committee: true, ..crossing_into(start + 8192, start + 1000, 64, false) };
        let honest = build_update(spec, recipe);
        let stored_current = committee_hash(spec, period);
        let stored_next = committee_hash(spec, period + 1);

        let honest_output =
            verify_light_client_fold(&honest.store, std::slice::from_ref(&honest.update), spec).expect("honest").0;
        assert_eq!(honest_output.startNextSyncCommitteeHash, stored_next);
        assert!(contract_accepts_start(stored_current, stored_next, &honest_output), "control");

        let mut store = honest.store.clone();
        store.next_sync_committee = Some(attacker.committee.clone());
        let mut update = honest.update.clone();
        resign(spec, &mut update, &attacker);
        let (output, _) = verify_light_client_fold(&store, &[update], spec).expect("the program cannot tell");
        let invented = attacker.committee.hash_tree_root().unwrap();
        assert_eq!(output.startNextSyncCommitteeHash, invented);
        assert_ne!(invented, stored_next);
        assert_eq!(output.syncCommitteeHash, invented, "the crossing makes the invented committee current");
        assert!(!contract_accepts_start(stored_current, stored_next, &output), "the contract refuses the start");
        // The contract that stored no next committee yet sees a non-zero start hash and refuses it too.
        assert!(!contract_accepts_start(stored_current, B256::ZERO, &output));
    }
}

/// Claim: when the initial store has no next committee, a first step that tries to cross is rejected. A fold that first
/// proves the next committee and then crosses is accepted (control).
/// Why it matters: a crossing with an unknown next committee would need a committee that no public value binds.
#[test]
fn synthetic_first_step_cannot_cross_without_a_known_next_committee() {
    for (spec, period) in chains() {
        let start = period * 8192;
        let proving = build_update(spec, inside_period(start, 400, 1000, true));
        let crossing_without_proof = build_update(spec, crossing_into(start + 8192, start + 400, 64, false));
        assert!(crossing_without_proof.store.next_sync_committee.is_none());

        assert_eq!(
            verify_light_client_fold(
                &crossing_without_proof.store,
                std::slice::from_ref(&crossing_without_proof.update),
                spec
            ),
            Err(Error::NextSyncCommitteeUnknown),
            "the first step tries to cross"
        );

        // Control: prove first, then cross.
        let crossing_after_proof = build_update(spec, crossing_into(start + 8192, start + 1000, 64, false));
        let (output, _) =
            verify_light_client_fold(&proving.store, &[proving.update.clone(), crossing_after_proof.update], spec)
                .expect("prove, then cross");
        assert_eq!(output.startNextSyncCommitteeHash, B256::ZERO);
        assert_eq!(output.syncCommitteeHash, committee_hash(spec, period + 1));
    }
}

/// Claim: a fold of one update gives the output of the single update, field by field, and its start next hash is the same
/// too. With a store that knows its next committee the field is that committee's hash; without, it is zero.
#[test]
fn synthetic_fold_of_one_update_equals_the_single_update_output() {
    for (spec, period) in chains() {
        let start = period * 8192;
        for knows_next in [false, true] {
            let scenario = build_update(
                spec,
                UpdateRecipe { store_knows_next_committee: knows_next, ..inside_period(start, 400, 1000, true) },
            );
            let single = verify_light_client_update(&scenario.store, &scenario.update, spec).expect("single");
            let (fold, _) = verify_light_client_fold(&scenario.store, std::slice::from_ref(&scenario.update), spec)
                .expect("fold of one");
            assert_same_apart_from_the_new_field(&fold, &single);
            assert_eq!(fold.startNextSyncCommitteeHash, single.startNextSyncCommitteeHash);
            let expected_start = if knows_next { committee_hash(spec, period + 1) } else { B256::ZERO };
            assert_eq!(fold.startNextSyncCommitteeHash, expected_start, "knows_next = {knows_next}");
            assert_eq!(fold.abi_encode(), single.abi_encode());
        }
    }
}

/// Claim: `nextSyncCommitteeHash` is non-zero only when a step in the fold proved the final store's next committee.
/// (a) A step that proves it and a later step that stays in the period and proves nothing: the proof still counts.
/// (b) A proof followed by a crossing that proves nothing: the committee became current, the final next committee is
///     unknown, so the output is zero.
/// (c) A store that already knew its next committee, and a fold that proves nothing: zero, while the start hash is not.
/// Why it matters: the contract fills an empty next slot from this field, so a committee the fold did not prove must
/// never reach it.
#[test]
fn synthetic_next_committee_hash_counts_only_what_this_fold_proved() {
    for (spec, period) in chains() {
        let start = period * 8192;
        let proving = build_update(spec, inside_period(start, 400, 1000, true));
        let after_proof = proving.update.finalized_header.beacon.slot;

        // (a)
        let quiet_recipe = UpdateRecipe { store_slot: after_proof, ..inside_period(start, 0, 1500, false) };
        let quiet = build_update(spec, quiet_recipe).update;
        let (output, store) =
            verify_light_client_fold(&proving.store, &[proving.update.clone(), quiet], spec).expect("fold (a)");
        assert_eq!(output.nextSyncCommitteeHash, committee_hash(spec, period + 1), "(a) proved earlier in this fold");
        assert_eq!(
            store.next_sync_committee.as_ref().map(|c| c.hash_tree_root().unwrap()),
            Some(output.nextSyncCommitteeHash)
        );

        // (b)
        let crossing = build_update(spec, crossing_into(start + 8192, after_proof, 64, false)).update;
        let (output, store) =
            verify_light_client_fold(&proving.store, &[proving.update.clone(), crossing], spec).expect("fold (b)");
        assert_eq!(output.syncCommitteeHash, committee_hash(spec, period + 1));
        assert_eq!(output.nextSyncCommitteeHash, B256::ZERO, "(b) the earlier proof became the current committee");
        assert!(store.next_sync_committee.is_none());

        // (c)
        let knowing = build_update(
            spec,
            UpdateRecipe { store_knows_next_committee: true, ..inside_period(start, 400, 1000, false) },
        );
        let (output, _) =
            verify_light_client_fold(&knowing.store, std::slice::from_ref(&knowing.update), spec).expect("fold (c)");
        assert_eq!(output.startNextSyncCommitteeHash, committee_hash(spec, period + 1));
        assert_eq!(output.nextSyncCommitteeHash, B256::ZERO, "(c) the store knew it, this fold did not prove it");
    }
}

/// Claim: the guest entry point runs the fold from the wire format and returns the ABI bytes of the fold output:
/// 352 bytes that decode back to the same struct. A wrong fork version in a middle step is refused.
#[test]
fn synthetic_guest_entry_point_runs_a_fold() {
    for (spec, period) in chains() {
        let (store, updates) = three_period_fold(spec, period);
        let chain = if spec.name == "pulsechain" { ChainSelector::Pulsechain } else { ChainSelector::EthereumMainnet };
        let steps: Vec<FoldStep> = updates
            .iter()
            .map(|update| FoldStep {
                update: update.clone(),
                fork_version: table_fork_version(spec, update.signature_slot),
            })
            .collect();
        let input = GuestInput { chain, store: store.clone(), steps };
        let bytes = encode_guest_input(&input);
        assert_eq!(decode_guest_input(&bytes), Ok(input.clone()));
        let public_values = run_light_client_guest(&bytes).expect("fold through the guest");
        assert_eq!(public_values.len(), 352);
        let expected = verify_light_client_fold(&store, &updates, spec).expect("fold").0;
        assert_eq!(LightClientOutput::abi_decode(&public_values), Ok(expected));

        let mut wrong = input.clone();
        wrong.steps[1].fork_version[3] ^= 1;
        assert_eq!(run_light_client_guest(&encode_guest_input(&wrong)), Err(Error::SignatureVerificationFailed));
    }
}
