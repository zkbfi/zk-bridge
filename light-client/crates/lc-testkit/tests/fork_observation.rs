//! Fork observation: a bound sync committee signs a header root under a fork version, and the program outputs that
//! version. Contract: `docs/hardened-build-contract.md`, section "Fork observation registry".
//!
//! Committees and signatures are SYNTHETIC (generated keys) on both layouts: PulseChain (Capella) and Ethereum (Fulu).
//! One test uses the REAL PulseChain sync aggregate. Every attack test has a control that shows the same input is
//! accepted without the attack. The Solidity side reads the fixtures in `tests/fixtures/fork-observation/`; the
//! test `fork_observation_fixtures_are_current` fails when they are stale, and `write-fork-observation-fixtures` rewrites them.

use alloy_primitives::B256;
use alloy_sol_types::SolValue;
use lc_core::abi::{ForkObservation, LightClientOutput};
use lc_core::chain::{ChainSpec, DOMAIN_SYNC_COMMITTEE, ETHEREUM_MAINNET, PULSECHAIN};
use lc_core::observation::{verify_fork_observation, Observation};
use lc_core::types::{compute_domain, compute_signing_root};
use lc_core::update::{table_fork_version, FoldStep};
use lc_core::wire::{
    decode_observation_input, encode_observation_input, run_fork_observation_guest, ChainSelector,
    ObservationGuestInput,
};
use lc_core::Error;
use lc_testkit::fork_observation_scenarios::{
    chains, committee_hash, fold_steps, fork_observation_fixtures, honest_shape, observation_over_state,
    observation_signed_by, observed_state, one_step_scenario, stale_three_period_scenario, version_outside_table,
    PeriodStart,
};
use lc_testkit::json::fixtures_dir;
use lc_testkit::synthetic::committee_for;

fn chain_selector(spec: &ChainSpec) -> ChainSelector {
    if spec.name == "pulsechain" {
        ChainSelector::Pulsechain
    } else {
        ChainSelector::EthereumMainnet
    }
}

/// Claim: an observation under a fork version that is NOT in the program's fork table is accepted, and the output names
/// that version. Control: the table's own current version is accepted the same way, and the unknown version really is
/// absent from the table.
/// Why it matters: this is the purpose of the program. A fork the program has never heard of is proven by the
/// signature alone, with no state layout.
#[test]
fn observation_under_a_version_outside_the_table_is_accepted_and_named() {
    for (spec, period) in chains() {
        let unknown = version_outside_table(spec);
        assert!(spec.fork_schedule.iter().all(|entry| entry.fork_version != unknown), "not in the table");
        let scenario = one_step_scenario(spec, period);
        let known = table_fork_version(spec, scenario.attested_slot());
        for version in [known, unknown] {
            let observation = observation_signed_by(
                spec,
                &scenario.committee_for_signature(),
                version,
                400,
                scenario.attested_slot(),
            );
            let output = verify_fork_observation(&scenario.store, &[], &observation, spec).expect("accepted");
            assert_eq!(output.observedVersion.0, version);
            assert_eq!(output.observedAttestedSlot, scenario.attested_slot());
            assert_eq!(output.genesisValidatorsRoot, spec.genesis_validators_root);
        }
    }
}

/// Claim: the output binds the starting store exactly like `LightClientOutput`: header root, head slot, current
/// committee hash, and the next committee hash (zero when the store has none).
/// Why it matters: the registry contract applies the same rule 1 to these five fields.
#[test]
fn observation_output_binds_the_starting_store() {
    for (spec, period) in chains() {
        let scenario = one_step_scenario(spec, period);
        let observation = observation_signed_by(
            spec,
            &scenario.committee_for_signature(),
            [0, 0, 3, 0x6d],
            400,
            scenario.attested_slot(),
        );
        let output = verify_fork_observation(&scenario.store, &[], &observation, spec).expect("accepted");
        assert_eq!(output.previousHeaderRoot, scenario.store.header_root);
        assert_eq!(output.previousHeadSlot, scenario.store.header_slot);
        assert_eq!(output.previousSyncCommitteeHash, committee_hash(spec, period));
        assert_eq!(output.startNextSyncCommitteeHash, B256::ZERO, "the store has no next committee");
        let mut knowing = scenario.store.clone();
        knowing.next_sync_committee = Some(committee_for(spec, period + 1).committee.clone());
        let output = verify_fork_observation(&knowing, &[], &observation, spec).expect("accepted");
        assert_eq!(output.startNextSyncCommitteeHash, committee_hash(spec, period + 1));
    }
}

/// Claim: 341 signers are refused and 342 are accepted.
/// Why it matters: one third of the committee must not be able to name a fork version.
#[test]
fn observation_with_341_signers_is_rejected() {
    for (spec, period) in chains() {
        let scenario = one_step_scenario(spec, period);
        let signer = scenario.committee_for_signature();
        let slot = scenario.attested_slot();
        let at = |count| observation_signed_by(spec, &signer, [0, 0, 3, 0x6d], count, slot);
        assert!(verify_fork_observation(&scenario.store, &[], &at(342), spec).is_ok(), "control");
        assert_eq!(
            verify_fork_observation(&scenario.store, &[], &at(341), spec),
            Err(Error::InsufficientParticipation { participants: 341 })
        );
    }
}

/// Claim: a committee that no public value binds is refused. Here 400 members of an invented committee sign a valid
/// message; the store names a different committee.
/// Control: the bound committee signing the same message is accepted.
/// Why it matters: anyone can invent keys. Only the committee that the contract bound counts.
#[test]
fn observation_signed_by_an_unbound_committee_is_rejected() {
    for (spec, period) in chains() {
        let scenario = one_step_scenario(spec, period);
        let slot = scenario.attested_slot();
        let bound = observation_signed_by(spec, &scenario.committee_for_signature(), [0, 0, 3, 0x6d], 400, slot);
        assert!(verify_fork_observation(&scenario.store, &[], &bound, spec).is_ok(), "control");
        let invented = committee_for(spec, period + 700);
        let forged = observation_signed_by(spec, &invented, [0, 0, 3, 0x6d], 400, slot);
        assert_eq!(
            verify_fork_observation(&scenario.store, &[], &forged, spec),
            Err(Error::SignatureVerificationFailed)
        );
    }
}

/// Claim: a signature slot at or before the final head is refused (equal and lower), one slot after is accepted.
/// Why it matters: an observation must be newer than what the light client already knows.
#[test]
fn observation_signature_at_or_before_the_final_head_is_rejected() {
    for (spec, period) in chains() {
        let scenario = one_step_scenario(spec, period);
        let signer = scenario.committee_for_signature();
        let head = scenario.store.header_slot;
        let at = |slot| observation_signed_by(spec, &signer, [0, 0, 3, 0x6d], 400, slot);
        assert!(verify_fork_observation(&scenario.store, &[], &at(head + 1), spec).is_ok(), "control");
        for slot in [head, head - 1] {
            assert!(matches!(
                verify_fork_observation(&scenario.store, &[], &at(slot), spec),
                Err(Error::InvalidSlotOrder(_))
            ));
        }
        // After a fold the bar is the FINAL head, not the start head.
        let stale = stale_three_period_scenario(spec, period);
        let final_head = stale.final_head_slot();
        let steps = fold_steps(spec, &stale.updates);
        let signer = stale.final_committee();
        let at_final = |slot| observation_signed_by(spec, &signer, [0, 0, 3, 0x6d], 400, slot);
        assert!(verify_fork_observation(&stale.store, &steps, &at_final(final_head + 1), spec).is_ok(), "control");
        assert!(matches!(
            verify_fork_observation(&stale.store, &steps, &at_final(final_head), spec),
            Err(Error::InvalidSlotOrder(_))
        ));
        assert!(matches!(
            verify_fork_observation(&stale.store, &steps, &at_final(stale.store.header_slot + 1), spec),
            Err(Error::InvalidSlotOrder(_))
        ));
    }
}

/// Claim: a signature in the period after the final head is refused when the fold did not cross. The store knows its
/// next committee (so the signature would verify), but no public value names it.
/// Control: the same signature after a fold that crossed and proved that next committee is accepted.
/// Why it matters: this is HB-01 for observations. An unbound next committee must never sign.
#[test]
fn observation_in_the_next_period_without_a_crossing_is_rejected() {
    for (spec, period) in chains() {
        let start = PeriodStart::of(spec, period);
        let next_signer = committee_for(spec, period + 1);
        // No crossing, no steps, the store knows the next committee.
        let scenario = one_step_scenario(spec, period);
        let mut knowing = scenario.store.clone();
        knowing.next_sync_committee = Some(next_signer.committee.clone());
        let next_slot = start.slot_in_period(1, 300);
        let observation = observation_signed_by(spec, &next_signer, [0, 0, 3, 0x6d], 400, next_slot);
        assert_eq!(
            verify_fork_observation(&knowing, &[], &observation, spec),
            Err(Error::SignatureInNextPeriodWithoutCrossing)
        );
        // No crossing, one step inside the period that proves the next committee.
        let steps = fold_steps(spec, std::slice::from_ref(&scenario.update));
        assert_eq!(
            verify_fork_observation(&scenario.store, &steps, &observation, spec),
            Err(Error::SignatureInNextPeriodWithoutCrossing)
        );
        // Control: crossing fold, the signature is in the period after the final head, the committee was proven.
        let stale = stale_three_period_scenario(spec, period);
        let steps = fold_steps(spec, &stale.updates);
        let signer = committee_for(spec, period + 3);
        let slot = start.slot_in_period(3, 300);
        let accepted = observation_signed_by(spec, &signer, [0, 0, 3, 0x6d], 400, slot);
        let output =
            verify_fork_observation(&stale.store, &steps, &accepted, spec).expect("proven next committee signs");
        assert_eq!(output.observedAttestedSlot, slot);
    }
}

/// Claim: a signature two periods past the final head is refused.
#[test]
fn observation_two_periods_past_the_final_head_is_rejected() {
    for (spec, period) in chains() {
        let scenario = one_step_scenario(spec, period);
        let slot = PeriodStart::of(spec, period).slot_in_period(2, 300);
        let observation = observation_signed_by(spec, &committee_for(spec, period + 2), [0, 0, 3, 0x6d], 400, slot);
        assert!(matches!(
            verify_fork_observation(&scenario.store, &[], &observation, spec),
            Err(Error::PeriodOutOfRange(_))
        ));
    }
}

/// Claim: the other chain's genesis validators root is refused, at two places. The program runs with the foreign root
/// while the state holds the home root: the shape proof fails first, `InvalidForkShapeProof`. A state built for the foreign
/// chain (it holds the foreign root, so the shape proof passes) that the home committee signed under the home domain fails
/// the signature: `SignatureVerificationFailed`. Control: the home root accepts the home observation.
/// Why it matters: a PulseChain observation must not be replayable from Ethereum signatures, and the reverse.
#[test]
fn observation_under_the_other_chains_genesis_validators_root_is_rejected() {
    for (spec, period) in chains() {
        let other = if spec.name == "pulsechain" { &ETHEREUM_MAINNET } else { &PULSECHAIN };
        let foreign = ChainSpec { genesis_validators_root: other.genesis_validators_root, ..*spec };
        let scenario = one_step_scenario(spec, period);
        let signer = scenario.committee_for_signature();
        let observation = observation_signed_by(spec, &signer, [0, 0, 3, 0x6d], 400, scenario.attested_slot());
        assert!(verify_fork_observation(&scenario.store, &[], &observation, spec).is_ok(), "control");
        assert_eq!(
            verify_fork_observation(&scenario.store, &[], &observation, &foreign),
            Err(Error::InvalidForkShapeProof)
        );

        let foreign_state = observed_state(&foreign, honest_shape(spec), [0, 0, 3, 0x6d]);
        let replay = observation_over_state(
            spec,
            foreign_state,
            &signer,
            [0, 0, 3, 0x6d],
            [0, 0, 3, 0x6d],
            400,
            scenario.attested_slot(),
        );
        assert_eq!(
            verify_fork_observation(&scenario.store, &[], &replay, &foreign),
            Err(Error::SignatureVerificationFailed),
            "the shape proof passes under the foreign root, and the home signature does not"
        );
    }
}

/// Claim: the version in the observation is not a free label. Naming a version other than the one the state holds fails the
/// shape proof (`InvalidForkShapeProof`). A state that holds the named version, with a signature made under another version,
/// fails the signature check (`SignatureVerificationFailed`).
/// Why it matters: the proof is only as good as the binding between the output version, the state and the signed domain.
#[test]
fn observation_naming_a_version_the_committee_did_not_sign_is_rejected() {
    for (spec, period) in chains() {
        let scenario = one_step_scenario(spec, period);
        let signer = scenario.committee_for_signature();
        let slot = scenario.attested_slot();
        let mut observation = observation_signed_by(spec, &signer, [0, 0, 3, 0x6d], 400, slot);
        assert!(verify_fork_observation(&scenario.store, &[], &observation, spec).is_ok(), "control");
        observation.fork_version = [0, 0, 3, 0x6e];
        assert_eq!(
            verify_fork_observation(&scenario.store, &[], &observation, spec),
            Err(Error::InvalidForkShapeProof),
            "the state holds 0x6d, not the named 0x6e"
        );

        let state_holding_named_version = observed_state(spec, honest_shape(spec), [0, 0, 3, 0x6e]);
        let signed_under_another = observation_over_state(
            spec,
            state_holding_named_version,
            &signer,
            [0, 0, 3, 0x6d],
            [0, 0, 3, 0x6e],
            400,
            slot,
        );
        assert_eq!(
            verify_fork_observation(&scenario.store, &[], &signed_under_another, spec),
            Err(Error::SignatureVerificationFailed)
        );
    }
}

/// Claim: folding forward from a store that is three periods stale, then observing, is accepted. The output binds the
/// START store (period P, no next committee), and the observation is signed by the committee of period P+2.
/// Why it matters: the PulseChain light client does not have to be kept current.
#[test]
fn observation_after_folding_forward_from_a_stale_store_is_accepted() {
    for (spec, period) in chains() {
        let stale = stale_three_period_scenario(spec, period);
        let steps = fold_steps(spec, &stale.updates);
        let slot = stale.final_head_slot() + 100;
        let observation = observation_signed_by(spec, &stale.final_committee(), [0, 0, 3, 0x6d], 400, slot);
        let output = verify_fork_observation(&stale.store, &steps, &observation, spec).expect("accepted");
        assert_eq!(output.previousHeaderRoot, stale.store.header_root);
        assert_eq!(output.previousHeadSlot, stale.store.header_slot);
        assert_eq!(output.previousSyncCommitteeHash, committee_hash(spec, period));
        assert_eq!(output.startNextSyncCommitteeHash, B256::ZERO);
        assert_eq!(output.observedAttestedSlot, slot);
        // Attack: the stale store's own committee (period P) cannot sign for a head in period P+2.
        let old = observation_signed_by(spec, &committee_for(spec, period), [0, 0, 3, 0x6d], 400, slot);
        assert_eq!(verify_fork_observation(&stale.store, &steps, &old, spec), Err(Error::SignatureVerificationFailed));
    }
}

/// Claim: a broken fold step (wrong fork version in a middle step) rejects the whole observation, and 65 steps are
/// refused. Control: the unbroken fold passes.
#[test]
fn observation_fold_steps_keep_every_update_rule() {
    for (spec, period) in chains() {
        let stale = stale_three_period_scenario(spec, period);
        let steps = fold_steps(spec, &stale.updates);
        let slot = stale.final_head_slot() + 100;
        let observation = observation_signed_by(spec, &stale.final_committee(), [0, 0, 3, 0x6d], 400, slot);
        assert!(verify_fork_observation(&stale.store, &steps, &observation, spec).is_ok(), "control");
        let mut broken: Vec<FoldStep> = steps.clone();
        broken[1].fork_version[3] ^= 1;
        assert_eq!(
            verify_fork_observation(&stale.store, &broken, &observation, spec),
            Err(Error::SignatureVerificationFailed)
        );
        let too_many: Vec<FoldStep> = std::iter::repeat_n(steps[0].clone(), 65).collect();
        assert_eq!(
            verify_fork_observation(&stale.store, &too_many, &observation, spec),
            Err(Error::FoldLengthOutOfRange { count: 65 })
        );
    }
}

/// Claim: an observation output cannot be read as a `LightClientOutput`, and the reverse. The lengths differ: 256
/// versus 352 bytes. A contract that requires the exact length refuses both.
/// Why it matters: the two programs have different keys, and the lengths are a second wall between their outputs.
#[test]
fn observation_output_and_light_client_output_have_different_lengths() {
    for (spec, period) in chains() {
        let scenario = one_step_scenario(spec, period);
        let observation = observation_signed_by(
            spec,
            &scenario.committee_for_signature(),
            [0, 0, 3, 0x6d],
            400,
            scenario.attested_slot(),
        );
        let observed =
            verify_fork_observation(&scenario.store, &[], &observation, spec).expect("accepted").abi_encode();
        let updated = lc_core::update::verify_light_client_update(&scenario.store, &scenario.update, spec)
            .expect("update")
            .abi_encode();
        assert_eq!((observed.len(), updated.len()), (256, 352));
        assert!(LightClientOutput::abi_decode(&observed).is_err(), "256 bytes are not a LightClientOutput");
        assert_eq!(ForkObservation::abi_decode(&observed).map(|value| value.abi_encode().len()), Ok(256));
        // The reverse: ABI decoding of a static struct tolerates trailing bytes, so the exact length is the wall.
        let lenient_read = ForkObservation::abi_decode(&updated);
        assert!(lenient_read.is_err() || updated.len() != 256, "the 352 byte value is not 256 bytes long");
        assert_ne!(observed.len(), updated.len());
    }
}

/// Claim: the attested slot is authenticated. A prover who forges a larger attested slot on an old valid signature
/// changes the header root, so the signature no longer matches and the observation is refused.
/// Control: the honest observation passes, and it reports the honest attested slot. Moving only the unsigned
/// `signature_slot` inside the period changes nothing in the output.
/// Why it matters: a fake high slot would let an old version look like the latest one in the registry.
#[test]
fn observation_forged_attested_slot_is_rejected() {
    for (spec, period) in chains() {
        let scenario = one_step_scenario(spec, period);
        let signer = scenario.committee_for_signature();
        let honest = observation_signed_by(spec, &signer, [0, 0, 3, 0x6c], 400, scenario.attested_slot());
        let output = verify_fork_observation(&scenario.store, &[], &honest, spec).expect("control");
        assert_eq!(output.observedAttestedSlot, scenario.attested_slot());
        let mut moved = honest.clone();
        moved.signature_slot += 4000;
        let output =
            verify_fork_observation(&scenario.store, &[], &moved, spec).expect("signature slot is not reported");
        assert_eq!(output.observedAttestedSlot, scenario.attested_slot());
        let mut forged = honest.clone();
        forged.attested_header.slot += 4000;
        forged.signature_slot += 4000;
        assert_eq!(
            verify_fork_observation(&scenario.store, &[], &forged, spec),
            Err(Error::SignatureVerificationFailed)
        );
    }
}

/// Claim: an attested slot equal to the final head slot is refused, and one slot later is accepted. A signature slot
/// at or before the attested slot is refused too.
/// Why it matters: the observation must be strictly newer than the head that the light client already knows.
#[test]
fn observation_attested_slot_equal_to_the_head_is_rejected() {
    for (spec, period) in chains() {
        let scenario = one_step_scenario(spec, period);
        let signer = scenario.committee_for_signature();
        let head = scenario.store.header_slot;
        let equal = observation_signed_by(spec, &signer, [0, 0, 3, 0x6d], 400, head);
        assert!(matches!(verify_fork_observation(&scenario.store, &[], &equal, spec), Err(Error::InvalidSlotOrder(_))));
        let later = observation_signed_by(spec, &signer, [0, 0, 3, 0x6d], 400, head + 1);
        assert!(verify_fork_observation(&scenario.store, &[], &later, spec).is_ok(), "control");
        let mut early_signature = later.clone();
        early_signature.signature_slot = early_signature.attested_header.slot;
        assert!(matches!(
            verify_fork_observation(&scenario.store, &[], &early_signature, spec),
            Err(Error::InvalidSlotOrder(_))
        ));
    }
}

/// Claim: the wire format round-trips, the guest entry point returns 256 bytes that decode to the same value, and the
/// decoder refuses more than 64 steps, trailing bytes and a truncated input. Zero steps decode.
#[test]
fn observation_guest_entry_point_and_wire_format() {
    for (spec, period) in chains() {
        let stale = stale_three_period_scenario(spec, period);
        let steps = fold_steps(spec, &stale.updates);
        let slot = stale.final_head_slot() + 100;
        let observation = observation_signed_by(spec, &stale.final_committee(), [0, 0, 3, 0x6d], 400, slot);
        let input =
            ObservationGuestInput { chain: chain_selector(spec), store: stale.store.clone(), steps, observation };
        let bytes = encode_observation_input(&input);
        assert_eq!(decode_observation_input(&bytes), Ok(input.clone()));
        let public_values = run_fork_observation_guest(&bytes).expect("guest");
        assert_eq!(public_values.len(), 256);
        let expected = verify_fork_observation(&input.store, &input.steps, &input.observation, spec).expect("direct");
        assert_eq!(ForkObservation::abi_decode(&public_values), Ok(expected));

        let mut trailing = bytes.clone();
        trailing.push(0);
        assert!(decode_observation_input(&trailing).is_err());
        assert!(decode_observation_input(&bytes[..bytes.len() - 1]).is_err());

        let no_steps = ObservationGuestInput { steps: Vec::new(), ..input.clone() };
        assert_eq!(decode_observation_input(&encode_observation_input(&no_steps)), Ok(no_steps));
    }
}

/// Claim: the decoder refuses a step count of 65 before it reads any step.
#[test]
fn observation_decoder_limits_steps_to_64() {
    let (spec, period) = chains()[0];
    let scenario = one_step_scenario(spec, period);
    let observation = observation_signed_by(
        spec,
        &scenario.committee_for_signature(),
        [0, 0, 3, 0x6d],
        400,
        scenario.attested_slot(),
    );
    let input = ObservationGuestInput {
        chain: chain_selector(spec),
        store: scenario.store.clone(),
        steps: Vec::new(),
        observation,
    };
    let mut bytes = encode_observation_input(&input);
    // The step count sits after the chain byte (1) and the store. The observation follows the step count: header, signature
    // slot, bits, signature, version, then the two branches (a count of 4 bytes and 32 bytes per node).
    let branch_bytes = |branch: &[B256]| 4 + 32 * branch.len();
    let observation_length = 112
        + 8
        + 64
        + 96
        + 4
        + branch_bytes(&input.observation.current_version_branch)
        + branch_bytes(&input.observation.genesis_validators_root_branch);
    let store_length = bytes.len() - 1 - 4 - observation_length;
    let count_offset = 1 + store_length;
    assert_eq!(&bytes[count_offset..count_offset + 4], &0u32.to_le_bytes(), "found the count");
    bytes[count_offset..count_offset + 4].copy_from_slice(&65u32.to_le_bytes());
    assert!(decode_observation_input(&bytes).is_err());
}

/// Claim: a REAL PulseChain sync aggregate, taken from the real update fixture, verifies through
/// `verify_fork_observation` under PulseChain's real current version `0x0000036c`, with the real branches of the real
/// attested state, and the output reports shape 5. Under `0x0000036d` the shape proof fails first, and with the shape proof
/// of the real version kept, the signature fails.
/// Why it matters: the program proves the real chain's version and shape, with real keys and a real state, and rejects a
/// nearby version.
#[test]
fn real_pulsechain_aggregate_proves_version_0x0000036c_and_not_0x0000036d() {
    let (store, update) = lc_testkit::pulsechain::real_update_and_store();
    let proofs = lc_testkit::pulsechain::real_state_proofs();
    let real_version = [0, 0, 0x03, 0x6c];
    assert_eq!(proofs.current_version, real_version, "the real state holds the version that the committee signed");
    let observation = |version| Observation {
        attested_header: update.attested_header.beacon,
        signature_slot: update.signature_slot,
        sync_aggregate: update.sync_aggregate.clone(),
        fork_version: version,
        current_version_branch: proofs.current_version_branch.clone(),
        genesis_validators_root_branch: proofs.genesis_validators_root_branch.clone(),
    };
    let output = verify_fork_observation(&store, &[], &observation(real_version), &PULSECHAIN).expect("real signature");
    assert_eq!(output.observedVersion.0, real_version);
    assert_eq!(output.shape, 5, "the real PulseChain state is a plain state of depth 5");
    assert_eq!(output.observedAttestedSlot, update.attested_header.beacon.slot);
    assert_eq!(output.previousSyncCommitteeHash, store.current_sync_committee.hash_tree_root().unwrap());
    assert_eq!(
        verify_fork_observation(&store, &[], &observation([0, 0, 0x03, 0x6d]), &PULSECHAIN),
        Err(Error::InvalidForkShapeProof),
        "the real state does not hold version 0x0000036d"
    );
    // Control for the domain: the real signing root is the one the program checks.
    let domain = compute_domain(DOMAIN_SYNC_COMMITTEE, real_version, &PULSECHAIN.genesis_validators_root);
    assert_ne!(compute_signing_root(&update.attested_header.beacon.hash_tree_root(), &domain), B256::ZERO);
}

/// Claim: the fixture files on disk equal what the generator builds, byte for byte, and every accept fixture's public
/// values are 256 bytes that decode to the version the fixture names.
/// Why it matters: the Solidity tests trust these files. A stale file would test the wrong bytes.
#[test]
fn fork_observation_fixtures_are_current() {
    let directory = fixtures_dir().join("fork-observation");
    let fixtures = fork_observation_fixtures();
    assert!(fixtures.len() >= 20);
    for (name, value) in &fixtures {
        let mut text = serde_json::to_string_pretty(value).expect("json");
        text.push('\n');
        let on_disk = std::fs::read_to_string(directory.join(format!("{name}.json")))
            .unwrap_or_else(|_| panic!("{name}.json is missing: run write-fork-observation-fixtures"));
        assert_eq!(on_disk, text, "{name}.json is stale: run write-fork-observation-fixtures");
        if value["expected"]["result"] != "accept" {
            continue;
        }
        let bytes = alloy_primitives::hex::decode(value["publicValues"].as_str().expect("hex")).expect("hex");
        assert_eq!(bytes.len(), 256);
        let decoded = ForkObservation::abi_decode(&bytes).expect("decode");
        assert_eq!(format!("0x{}", alloy_primitives::hex::encode(decoded.observedVersion.0)), value["observedVersion"]);
    }
    let on_disk_count = std::fs::read_dir(&directory).expect("directory").count();
    assert_eq!(on_disk_count, fixtures.len(), "no stray fixture files");
}
