//! Rejection tests for `verify_light_client_update`, on SYNTHETIC updates (generated keys, test-only state builder) for
//! both layouts, and on REAL Ethereum and PulseChain updates where the attack applies to real data.
//!
//! Synthetic tests are marked `synthetic_` in the name. Real-data tests are marked `real_`.
//! Every attack test has a control: the same scenario without the attack passes.

use alloy_primitives::B256;
use lc_core::chain::{ChainSpec, ETHEREUM_MAINNET, PULSECHAIN, SEPOLIA};
use lc_core::ssz::is_valid_exact_branch;
use lc_core::types::{compute_signing_root, sync_committee_domain};
use lc_core::types::{LightClientStore, LightClientUpdate};
use lc_core::update::{
    advance_light_client_store, table_fork_version, verify_light_client_update,
    verify_light_client_update_with_fork_version, verify_sync_aggregate,
};
use lc_core::Error;
use lc_testkit::json::{bootstrap, light_client_update, load_response, store_from_bootstrap};
use lc_testkit::pulsechain::real_update_and_store;
use lc_testkit::real_proofs::{assert_stops_at_the_missing_branch, has_branch, with_known_branch};
use lc_testkit::synthetic::{
    build_gloas_update, build_update, build_update_over_tree_with_finalized_state, committee_for, make_committee,
    sign_with_first_members, synthetic_compact_header, CraftedPlacement, CraftedStateTree, TestCommittee, UpdateRecipe,
    UpdateScenario, SEPOLIA_GLOAS_RECIPE,
};

fn flip(node: &mut B256) {
    node.0[0] ^= 0x01;
}

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

/// Both layouts: PulseChain (Capella layout) and Ethereum (Fulu, Electra layout).
fn scenarios() -> Vec<UpdateScenario> {
    vec![build_update(&PULSECHAIN, pulsechain_recipe()), build_update(&ETHEREUM_MAINNET, ethereum_recipe())]
}

fn verify(scenario: &UpdateScenario, update: &LightClientUpdate) -> Result<lc_core::abi::LightClientOutput, Error> {
    verify_light_client_update(&scenario.store, update, scenario.spec)
}

/// Claim: honest synthetic updates verify on both layouts, with the expected output (control for every attack below).
#[test]
fn synthetic_honest_updates_verify_on_both_layouts() {
    for scenario in scenarios() {
        let output = verify(&scenario, &scenario.update).expect("honest update");
        assert_eq!(output.genesisValidatorsRoot, scenario.spec.genesis_validators_root);
        assert_eq!(output.newHeadSlot, scenario.update.finalized_header.beacon.slot);
        assert_eq!(output.executionBlockNumber, scenario.update.finalized_header.execution.block_number);
        assert_eq!(output.executionBlockHash, scenario.update.finalized_header.execution.block_hash);
        let next = scenario.update.next_sync_committee.as_ref().unwrap().committee.hash_tree_root().unwrap();
        assert_eq!(output.nextSyncCommitteeHash, next);
    }
}

/// Claim: 342 of 512 signers pass and 341 fail, with a valid signature in both cases.
/// Why it matters: the contract and the program must agree on the two-thirds boundary; an off-by-one lets a minority finalize.
#[test]
fn synthetic_participation_boundary_is_342() {
    for (spec, recipe) in [(&PULSECHAIN, pulsechain_recipe()), (&ETHEREUM_MAINNET, ethereum_recipe())] {
        let accept = build_update(spec, UpdateRecipe { participants: 342, ..recipe });
        assert!(verify(&accept, &accept.update).is_ok(), "342 signers with a valid signature");
        let reject = build_update(spec, UpdateRecipe { participants: 341, ..recipe });
        assert_eq!(verify(&reject, &reject.update), Err(Error::InsufficientParticipation { participants: 341 }));
    }
}

/// Claim: flipping one bit of the signature makes the update fail, flipping any participation bit makes it fail, and
/// setting an extra participation bit (a signer that did not sign) makes it fail.
#[test]
fn synthetic_signature_and_participation_tampering() {
    for scenario in scenarios() {
        assert!(verify(&scenario, &scenario.update).is_ok(), "control");
        for byte in [0usize, 47, 95] {
            let mut update = scenario.update.clone();
            update.sync_aggregate.sync_committee_signature[byte] ^= 0x01;
            let result = verify(&scenario, &update);
            assert!(
                matches!(result, Err(Error::InvalidSignatureEncoding | Error::SignatureVerificationFailed)),
                "signature byte {byte}: {result:?}"
            );
        }
        let mut cleared = scenario.update.clone();
        cleared.sync_aggregate.sync_committee_bits[0] ^= 0x01; // bit 0 was set
        assert_eq!(verify(&scenario, &cleared), Err(Error::SignatureVerificationFailed));
        let mut added = scenario.update.clone();
        added.sync_aggregate.sync_committee_bits[63] |= 0x80; // member 511 did not sign
        assert_eq!(verify(&scenario, &added), Err(Error::SignatureVerificationFailed));
    }
}

/// Claim: cross-chain replay fails in all three ways. The other chain's fork version, the other chain's genesis validators
/// root, and both together are refused on synthetic updates (H-01 and R2-09).
/// - The fork version is bound by the signature: `SignatureVerificationFailed`.
/// - The genesis validators root is bound twice. The state holds the root of the home chain in field 1, so a program that
///   runs with the foreign root fails the branch of `genesis_validators_root` first: `InvalidGenesisValidatorsRootBranch`.
///   The signature binds the same root, and the aggregate check alone (no state) shows that: `SignatureVerificationFailed`.
///
/// Why it matters: a signature made for one chain must not move to the other chain, and a state of one chain must not
/// pass as the state of the other.
#[test]
fn synthetic_other_chains_domain_is_refused() {
    let pairs: [(&UpdateScenario, &ChainSpec); 2] = [
        (&build_update(&PULSECHAIN, pulsechain_recipe()), &ETHEREUM_MAINNET),
        (&build_update(&ETHEREUM_MAINNET, ethereum_recipe()), &PULSECHAIN),
    ];
    for (scenario, other) in pairs {
        let own_version = table_fork_version(scenario.spec, scenario.update.signature_slot);
        let other_version = table_fork_version(other, scenario.update.signature_slot);
        assert_ne!(own_version, other_version);
        let with = |spec: &ChainSpec, version: [u8; 4]| {
            verify_light_client_update_with_fork_version(&scenario.store, &scenario.update, spec, version)
        };
        assert!(with(scenario.spec, own_version).is_ok(), "control");
        assert_eq!(with(scenario.spec, other_version), Err(Error::SignatureVerificationFailed), "other fork version");
        let foreign_root = ChainSpec { genesis_validators_root: other.genesis_validators_root, ..*scenario.spec };
        assert_eq!(
            with(&foreign_root, own_version),
            Err(Error::InvalidGenesisValidatorsRootBranch),
            "other genesis validators root: the state holds the home root"
        );
        assert_eq!(
            with(&foreign_root, other_version),
            Err(Error::InvalidGenesisValidatorsRootBranch),
            "both: the state check runs before the signature check"
        );

        // The signature alone binds the root too.
        let attested_root = scenario.update.attested_header.beacon.hash_tree_root();
        let signature_under = |spec: &ChainSpec, version: [u8; 4]| {
            verify_sync_aggregate(
                spec,
                &scenario.store.current_sync_committee,
                &scenario.update.sync_aggregate,
                &attested_root,
                version,
            )
        };
        assert_eq!(signature_under(scenario.spec, own_version), Ok(()), "control");
        assert_eq!(signature_under(&foreign_root, own_version), Err(Error::SignatureVerificationFailed));
        assert_eq!(signature_under(&foreign_root, other_version), Err(Error::SignatureVerificationFailed));
    }
}

/// Claim: corrupting any single entry of any branch (finality, next committee, attested execution, finalized execution)
/// is refused with the error of that branch. Every entry position is tried, not only the first.
#[test]
fn synthetic_every_branch_entry_matters() {
    for scenario in scenarios() {
        for position in 0..scenario.update.finality_branch.len() {
            let mut update = scenario.update.clone();
            flip(&mut update.finality_branch[position]);
            assert_eq!(verify(&scenario, &update), Err(Error::InvalidFinalityBranch), "finality {position}");
        }
        for position in 0..scenario.update.next_sync_committee.as_ref().unwrap().branch.len() {
            let mut update = scenario.update.clone();
            flip(&mut update.next_sync_committee.as_mut().unwrap().branch[position]);
            assert_eq!(
                verify(&scenario, &update),
                Err(Error::InvalidNextSyncCommitteeBranch),
                "next committee {position}"
            );
        }
        for position in 0..scenario.update.attested_header.execution_branch.len() {
            let mut update = scenario.update.clone();
            flip(&mut update.attested_header.execution_branch[position]);
            assert_eq!(
                verify(&scenario, &update),
                Err(Error::InvalidExecutionBranch("attested")),
                "attested execution {position}"
            );
        }
        for position in 0..scenario.update.finalized_header.execution_branch.len() {
            let mut update = scenario.update.clone();
            flip(&mut update.finalized_header.execution_branch[position]);
            assert_eq!(
                verify(&scenario, &update),
                Err(Error::InvalidExecutionBranch("finalized")),
                "finalized execution {position}"
            );
        }
        // A changed execution block hash (the value the bridge uses) breaks the execution branch.
        let mut update = scenario.update.clone();
        flip(&mut update.finalized_header.execution.block_hash);
        assert_eq!(verify(&scenario, &update), Err(Error::InvalidExecutionBranch("finalized")));
    }
}

/// Claim: a finality branch that claims the other plain layout is refused, in both directions. A branch cut by one entry
/// (PulseChain, true depth 5, length 6 becomes 5) and a branch padded with a leading zero (length 6 becomes 7, which
/// names the Electra layout) both fail, and so does the Electra branch (length 7) cut to 6.
/// Why it is safe: the length IS the layout. A padded length 7 on a true depth 5 state asks for index 169, which lands on
/// the node below `eth1_deposit_index` (a basic leaf), so the honest branch cannot reach the state root. A cut length 6 on
/// a true depth 6 state asks for index 105, which lands on a padding zero chunk. Control: the unchanged update verifies.
#[test]
fn synthetic_wrong_layout_claim_by_branch_length_is_refused() {
    for scenario in scenarios() {
        assert!(verify(&scenario, &scenario.update).is_ok(), "control");
        let honest = scenario.update.finality_branch.clone();
        let claimed_other = match honest.len() {
            6 => std::iter::once(B256::ZERO).chain(honest.iter().copied()).collect::<Vec<_>>(),
            _ => honest[1..].to_vec(),
        };
        let mut update = scenario.update.clone();
        update.finality_branch = claimed_other;
        assert_eq!(verify(&scenario, &update), Err(Error::InvalidFinalityBranch), "{}", scenario.spec.name);
    }
}

/// Claim: a header that is attested but not finalized is refused. The update names the attested header as the finalized one;
/// the finality branch proves another header, so the check fails.
#[test]
fn synthetic_attested_header_is_not_the_finalized_header() {
    for scenario in scenarios() {
        let mut update = scenario.update.clone();
        update.finalized_header = update.attested_header.clone();
        assert_eq!(verify(&scenario, &update), Err(Error::InvalidFinalityBranch));
    }
}

/// Claim: slot order and head progress are enforced: signature not after attested, attested before finalized, a head that
/// does not advance, and a genesis finalized slot are each refused.
#[test]
fn synthetic_slot_rules() {
    let scenario = build_update(&PULSECHAIN, pulsechain_recipe());
    let mut update = scenario.update.clone();
    update.signature_slot = update.attested_header.beacon.slot;
    assert!(matches!(verify(&scenario, &update), Err(Error::InvalidSlotOrder(_))));
    let mut store = scenario.store.clone();
    store.header_slot = scenario.update.finalized_header.beacon.slot;
    assert!(matches!(
        verify_light_client_update(&store, &scenario.update, scenario.spec),
        Err(Error::NotFinalizedProgress(_))
    ));
}

/// Claim: a period crossing works. The finalized header is in the next period and the signature uses the NEXT committee,
/// which the store must know. Without it the update is refused; with it the output carries the new committee hashes.
#[test]
fn synthetic_period_crossing_needs_and_uses_the_next_committee() {
    for (spec, base) in [(&PULSECHAIN, pulsechain_recipe()), (&ETHEREUM_MAINNET, ethereum_recipe())] {
        let period_start = (spec.period_at_slot(base.store_slot) + 1) * 8192;
        let recipe = UpdateRecipe {
            finalized_slot: period_start + 64,
            attested_slot: period_start + 130,
            signature_slot: period_start + 131,
            store_knows_next_committee: true,
            ..base
        };
        let scenario = build_update(spec, recipe);
        let (output, advanced) =
            advance_light_client_store(&scenario.store, &scenario.update, spec).expect("crossing verifies");
        assert_eq!(
            output.syncCommitteeHash,
            scenario.store.next_sync_committee.as_ref().unwrap().hash_tree_root().unwrap()
        );
        assert_ne!(output.syncCommitteeHash, output.previousSyncCommitteeHash);
        assert_eq!(
            output.nextSyncCommitteeHash,
            scenario.update.next_sync_committee.as_ref().unwrap().committee.hash_tree_root().unwrap()
        );
        assert_eq!(advanced.current_sync_committee, *scenario.store.next_sync_committee.as_ref().unwrap());

        let mut unaware = scenario.store.clone();
        unaware.next_sync_committee = None;
        assert_eq!(verify_light_client_update(&unaware, &scenario.update, spec), Err(Error::NextSyncCommitteeUnknown));

        // A store that knows a different next committee does not accept this update's next committee when the
        // attested period equals the store period. Here the attested period is later, so only the signature check applies.
        let mut impostor = scenario.store.clone();
        impostor.next_sync_committee = Some(scenario.store.current_sync_committee.clone());
        assert_eq!(
            verify_light_client_update(&impostor, &scenario.update, spec),
            Err(Error::SignatureVerificationFailed)
        );
    }
}

/// Claim: an update that jumps two periods ahead is refused (the committee would be unknown).
#[test]
fn synthetic_two_period_jump_is_refused() {
    let base = pulsechain_recipe();
    let period_start = (PULSECHAIN.period_at_slot(base.store_slot) + 2) * 8192;
    let scenario = build_update(
        &PULSECHAIN,
        UpdateRecipe {
            finalized_slot: period_start + 64,
            attested_slot: period_start + 130,
            signature_slot: period_start + 131,
            store_knows_next_committee: true,
            ..base
        },
    );
    assert!(matches!(verify(&scenario, &scenario.update), Err(Error::PeriodOutOfRange(_))));
}

/// Claim: an update whose next committee contradicts the store's known next committee is refused (same period).
#[test]
fn synthetic_next_committee_must_match_the_store() {
    let scenario = build_update(&PULSECHAIN, UpdateRecipe { store_knows_next_committee: true, ..pulsechain_recipe() });
    assert!(verify(&scenario, &scenario.update).is_ok(), "control: the committees agree");
    let mut store = scenario.store.clone();
    store.next_sync_committee = Some(scenario.store.current_sync_committee.clone());
    assert_eq!(
        verify_light_client_update(&store, &scenario.update, scenario.spec),
        Err(Error::NextSyncCommitteeMismatch)
    );
}

/// Claim: a committee with a wrong key count or an identity key is refused. A shorter committee cannot hash; an identity
/// public key would let an attacker cancel keys, so it is rejected as an invalid key.
#[test]
fn synthetic_malformed_committee_is_refused() {
    let scenario = build_update(&PULSECHAIN, pulsechain_recipe());
    let mut store = scenario.store.clone();
    store.current_sync_committee.pubkeys.pop();
    assert!(matches!(
        verify_light_client_update(&store, &scenario.update, scenario.spec),
        Err(Error::InvalidSyncCommitteeSize { actual: 511 })
    ));

    let mut store = scenario.store.clone();
    let mut identity = [0u8; 48];
    identity[0] = 0xc0; // compressed point at infinity
    store.current_sync_committee.pubkeys[0] = identity.into();
    assert_eq!(
        verify_light_client_update(&store, &scenario.update, scenario.spec),
        Err(Error::InvalidPublicKey { index: 0 })
    );
}

// ---- real data ----

fn real_ethereum() -> (LightClientStore, LightClientUpdate) {
    let update = with_known_branch(light_client_update(&load_response("ethereum/finality_update.json")["data"]));
    let store = store_from_bootstrap(&bootstrap(&load_response("ethereum/bootstrap_same_period.json")["data"]), None);
    (store, update)
}

/// Claim: the attacks of this file also fail on REAL updates from both chains: a flipped signature bit, 341 participants,
/// every branch corrupted, the other layout's branch length, and an attested header presented as finalized. Control: the untouched
/// real update verifies. The real Ethereum update has no branch of `genesis_validators_root` on file (see
/// `lc_testkit::real_proofs`): its control and its signature check then run on the aggregate and on the point where the
/// program stops. Every other attack stops before the genesis validators root branch and runs in full.
#[test]
fn real_updates_reject_every_attack() {
    let cases: Vec<(&str, LightClientStore, LightClientUpdate, &ChainSpec)> = {
        let (eth_store, eth_update) = real_ethereum();
        let (pls_store, pls_update) = real_update_and_store();
        vec![("ethereum", eth_store, eth_update, &ETHEREUM_MAINNET), ("pulsechain", pls_store, pls_update, &PULSECHAIN)]
    };
    for (name, store, update, spec) in cases {
        let run = |update: &LightClientUpdate| verify_light_client_update(&store, update, spec);
        let version = table_fork_version(spec, update.signature_slot);
        let signature_result = |update: &LightClientUpdate| match has_branch(update) {
            true => run(update).map(|_| ()),
            false => verify_sync_aggregate(
                spec,
                &store.current_sync_committee,
                &update.sync_aggregate,
                &update.attested_header.beacon.hash_tree_root(),
                version,
            ),
        };
        match has_branch(&update) {
            true => assert!(run(&update).is_ok(), "{name}: control"),
            false => {
                assert_eq!(signature_result(&update), Ok(()), "{name}: control, the real signature");
                assert_stops_at_the_missing_branch(&store, &update, spec, version);
            }
        }

        let mut tampered = update.clone();
        tampered.sync_aggregate.sync_committee_signature[95] ^= 0x01;
        assert!(
            matches!(
                signature_result(&tampered),
                Err(Error::InvalidSignatureEncoding | Error::SignatureVerificationFailed)
            ),
            "{name}: signature bit"
        );

        let mut tampered = update.clone();
        let mut remaining = 341;
        for byte in tampered.sync_aggregate.sync_committee_bits.iter_mut() {
            let mut kept = 0u8;
            for bit in 0..8 {
                if *byte >> bit & 1 == 1 && remaining > 0 {
                    kept |= 1 << bit;
                    remaining -= 1;
                }
            }
            *byte = kept;
        }
        assert_eq!(
            run(&tampered),
            Err(Error::InsufficientParticipation { participants: 341 }),
            "{name}: 341 participants"
        );

        let mut tampered = update.clone();
        flip(&mut tampered.finality_branch[0]);
        assert_eq!(run(&tampered), Err(Error::InvalidFinalityBranch), "{name}: finality branch");

        let mut tampered = update.clone();
        let last = tampered.finalized_header.execution_branch.len() - 1;
        flip(&mut tampered.finalized_header.execution_branch[last]);
        assert_eq!(run(&tampered), Err(Error::InvalidExecutionBranch("finalized")), "{name}: execution branch");

        if let Some(next) = update.next_sync_committee.as_ref() {
            let mut tampered = update.clone();
            let mut corrupted = next.clone();
            flip(&mut corrupted.branch[1]);
            tampered.next_sync_committee = Some(corrupted);
            assert_eq!(run(&tampered), Err(Error::InvalidNextSyncCommitteeBranch), "{name}: next committee branch");
        }

        let mut tampered = update.clone();
        tampered.finality_branch = match update.finality_branch.len() {
            6 => std::iter::once(B256::ZERO).chain(update.finality_branch.iter().copied()).collect(),
            _ => update.finality_branch[1..].to_vec(),
        };
        assert_eq!(run(&tampered), Err(Error::InvalidFinalityBranch), "{name}: the other plain layout's length");

        let mut tampered = update.clone();
        tampered.finalized_header = tampered.attested_header.clone();
        assert_eq!(run(&tampered), Err(Error::InvalidFinalityBranch), "{name}: attested is not finalized");
    }
}

// ---- guest wire format ----

/// Claim: the guest entry point (`run_light_client_guest`) decodes the wire format, verifies a fold of one update, and
/// returns the exact ABI bytes of the output (352 bytes), for a REAL Ethereum update and a REAL PulseChain update.
/// Truncated input, trailing bytes and a flipped fork version are refused. Why it matters: this is the function the SP1
/// guest calls.
#[test]
fn real_updates_run_through_the_guest_entry_point() {
    use alloy_sol_types::SolValue;
    use lc_core::update::FoldStep;
    use lc_core::wire::{decode_guest_input, encode_guest_input, run_light_client_guest, ChainSelector, GuestInput};
    let (eth_store, eth_update) = real_ethereum();
    let (pls_store, pls_update) = real_update_and_store();
    for (chain, spec, store, update) in [
        (ChainSelector::EthereumMainnet, &ETHEREUM_MAINNET, eth_store, eth_update),
        (ChainSelector::Pulsechain, &PULSECHAIN, pls_store, pls_update),
    ] {
        let fork_version = table_fork_version(spec, update.signature_slot);
        let input =
            GuestInput { chain, store: store.clone(), steps: vec![FoldStep { update: update.clone(), fork_version }] };
        let bytes = encode_guest_input(&input);
        assert_eq!(decode_guest_input(&bytes), Ok(input.clone()), "roundtrip");
        let truncated_and_trailing = |bytes: &Vec<u8>| {
            assert!(run_light_client_guest(&bytes[..bytes.len() - 1]).is_err(), "truncated");
            let mut trailing = bytes.clone();
            trailing.push(0);
            assert!(run_light_client_guest(&trailing).is_err(), "trailing byte");
        };
        if !has_branch(&update) {
            // No branch of genesis_validators_root on file: the guest stops there, and the format checks still run.
            assert_eq!(run_light_client_guest(&bytes), Err(Error::InvalidGenesisValidatorsRootBranch));
            truncated_and_trailing(&bytes);
            continue;
        }
        let expected = verify_light_client_update(&store, &update, spec).unwrap().abi_encode();
        assert_eq!(expected.len(), 352);
        assert_eq!(run_light_client_guest(&bytes), Ok(expected));

        truncated_and_trailing(&bytes);
        let mut wrong_version = input.clone();
        wrong_version.steps[0].fork_version[0] ^= 0x01;
        assert_eq!(
            run_light_client_guest(&encode_guest_input(&wrong_version)),
            Err(Error::SignatureVerificationFailed)
        );
        let mut wrong_chain = bytes.clone();
        wrong_chain[0] = if chain == ChainSelector::Pulsechain { 1 } else { 2 };
        assert!(run_light_client_guest(&wrong_chain).is_err(), "the other chain's configuration");
    }
}

/// Signs the update of a scenario with `signer` instead of the committee the builder chose.
fn resign(scenario: &mut UpdateScenario, signer: &TestCommittee) {
    let domain = sync_committee_domain(scenario.spec, scenario.update.signature_slot);
    let signing_root = compute_signing_root(&scenario.update.attested_header.beacon.hash_tree_root(), &domain);
    scenario.update.sync_aggregate = sign_with_first_members(signer, 400, &signing_root);
}

/// A scenario whose store holds an invented next committee and whose update is signed by that committee in the next period.
/// `finalized_in_next_period` chooses whether the finalized header crosses into the next period.
fn attacker_next_committee_scenario(
    spec: &'static ChainSpec,
    base: UpdateRecipe,
    attacker: &TestCommittee,
    finalized_in_next_period: bool,
) -> UpdateScenario {
    let period_start = (spec.period_at_slot(base.store_slot) + 1) * 8192;
    let (finalized_slot, attested_slot) = if finalized_in_next_period {
        (period_start + 64, period_start + 130)
    } else {
        (base.store_slot + 1000, period_start - 6)
    };
    let recipe = UpdateRecipe {
        finalized_slot,
        attested_slot,
        signature_slot: attested_slot.max(period_start) + 1,
        include_next_committee: false,
        store_knows_next_committee: true,
        ..base
    };
    let mut scenario = build_update(spec, recipe);
    scenario.store.next_sync_committee = Some(attacker.committee.clone());
    resign(&mut scenario, attacker);
    scenario
}

/// Claim: a signature by the store's private next committee is refused unless the finalized header crosses into the
/// next period. Why it matters: the output binds only the current committee, so an invented next committee would
/// otherwise sign an update and nothing public would name it. With the crossing, `syncCommitteeHash` is the attacker
/// committee hash, which the contract checks against `syncCommittees[headPeriod + 1]`.
#[test]
fn synthetic_signature_by_unbound_next_committee_needs_a_crossing() {
    let attacker = make_committee("attacker-next-committee");
    for (spec, base) in [(&PULSECHAIN, pulsechain_recipe()), (&ETHEREUM_MAINNET, ethereum_recipe())] {
        let attack = attacker_next_committee_scenario(spec, base, &attacker, false);
        assert_eq!(verify(&attack, &attack.update), Err(Error::SignatureInNextPeriodWithoutCrossing));
        assert_eq!(Error::SignatureInNextPeriodWithoutCrossing.reason_code(), "SignatureInNextPeriodWithoutCrossing");

        let control = attacker_next_committee_scenario(spec, base, &attacker, true);
        let output = verify(&control, &control.update).expect("crossing update verifies");
        assert_eq!(output.syncCommitteeHash, attacker.committee.hash_tree_root().unwrap());
        assert_ne!(output.syncCommitteeHash, output.previousSyncCommitteeHash);
    }
}

/// Claim: `nextSyncCommitteeHash` is zero when the update does not prove a next committee, even if the private store
/// knows one. Why it matters: the contract fills an empty next slot from a non-zero value, so an unproven value would
/// let the prover choose the next committee of the contract.
#[test]
fn synthetic_next_committee_hash_is_zero_unless_this_update_proves_it() {
    for (spec, base) in [(&PULSECHAIN, pulsechain_recipe()), (&ETHEREUM_MAINNET, ethereum_recipe())] {
        let proven =
            build_update(spec, UpdateRecipe { store_knows_next_committee: true, include_next_committee: true, ..base });
        let output = verify(&proven, &proven.update).expect("control verifies");
        let committee_root = proven.update.next_sync_committee.as_ref().unwrap().committee.hash_tree_root().unwrap();
        assert_ne!(committee_root, B256::ZERO);
        assert_eq!(output.nextSyncCommitteeHash, committee_root);

        let unproven = build_update(
            spec,
            UpdateRecipe { store_knows_next_committee: true, include_next_committee: false, ..base },
        );
        assert!(unproven.store.next_sync_committee.is_some());
        let output = verify(&unproven, &unproven.update).expect("update without next committee verifies");
        assert_eq!(output.nextSyncCommitteeHash, B256::ZERO);
    }
}

// ---- the attested header (gap 2) ----

/// The scenario with its attested header replaced by a COMPACT header over the same slot and state root, signed again by the
/// committee of the signature period. The execution branch of the compact header has 8 entries on a Capella body (PulseChain)
/// and 9 entries on a Deneb or later body (Ethereum).
fn with_compact_attested_header(mut scenario: UpdateScenario) -> UpdateScenario {
    let attested = scenario.update.attested_header.clone();
    scenario.update.attested_header = synthetic_compact_header(
        scenario.spec,
        attested.beacon.slot,
        attested.beacon.state_root,
        attested.execution_block_hash(),
    );
    let signer = committee_for(scenario.spec, scenario.spec.period_at_slot(scenario.update.signature_slot));
    resign(&mut scenario, &signer);
    scenario
}

/// Claim: a compact attested header of 8 or 9 entries is checked. One flipped entry, at any position, gives exactly
/// `InvalidExecutionBranch("attested")` through the whole step. Control: the unflipped header verifies. PulseChain gives
/// 8 entries (Capella payload, index 412) and Ethereum gives 9 (Deneb or later payload, index 812).
/// Why it matters: the state-anchored skip covers only the branch of 11 entries. No other test sends a compact attested
/// header of 8 or 9 entries through a step, so a skip that grew to every compact header would pass unseen.
#[test]
fn a_compact_attested_header_of_eight_or_nine_entries_is_checked() {
    for (spec, recipe, length) in
        [(&PULSECHAIN, pulsechain_recipe(), 8usize), (&ETHEREUM_MAINNET, ethereum_recipe(), 9)]
    {
        let scenario = with_compact_attested_header(build_update(spec, recipe));
        assert_eq!(scenario.update.attested_header.execution_branch.len(), length, "{}", spec.name);
        assert!(verify(&scenario, &scenario.update).is_ok(), "{}: control", spec.name);
        for position in 0..length {
            let mut update = scenario.update.clone();
            flip(&mut update.attested_header.execution_branch[position]);
            assert_eq!(
                verify(&scenario, &update),
                Err(Error::InvalidExecutionBranch("attested")),
                "{} entry {position}",
                spec.name
            );
        }
    }
}

/// Claim: a compact attested header with a zero block hash is refused with `ZeroExecutionBlockHash("attested")` when its
/// branch has 8 or 9 entries. The same zero hash with the 11 entry state-anchored branch of a Gloas update is accepted: that
/// is the documented skip, because the execution data of the attested header never reaches the output. Control: the honest
/// headers verify.
/// Why it matters: this pins the edge of the skip. The zero-hash rule applies to every header that the program reads, and
/// not to the one header form that it never reads.
#[test]
fn a_compact_attested_header_with_a_zero_hash_is_refused_unless_state_anchored() {
    for (spec, recipe) in [(&PULSECHAIN, pulsechain_recipe()), (&ETHEREUM_MAINNET, ethereum_recipe())] {
        let scenario = with_compact_attested_header(build_update(spec, recipe));
        let mut update = scenario.update.clone();
        update.attested_header.execution.block_hash = B256::ZERO;
        assert_eq!(verify(&scenario, &update), Err(Error::ZeroExecutionBlockHash("attested")), "{}", spec.name);
    }
    let gloas = build_gloas_update(&SEPOLIA, SEPOLIA_GLOAS_RECIPE);
    let run = |update: &LightClientUpdate| verify_light_client_update(&gloas.store, update, gloas.spec).map(|_| ());
    assert_eq!(gloas.update.attested_header.execution_branch.len(), 11);
    assert_eq!(run(&gloas.update), Ok(()), "control");
    let mut zero_hash = gloas.update.clone();
    zero_hash.attested_header.execution.block_hash = B256::ZERO;
    assert_eq!(run(&zero_hash), Ok(()), "the state-anchored attested header is not read: a deliberate skip");
}

/// Claim: a compact attested header whose branch has a length that names no anchor (0, 1, 7, 10, 12 and 64 entries) is
/// refused with exactly `InvalidExecutionBranch("attested")`. Length 11 is the one skipped length and 8 and 9 are the
/// checked ones. Control: the honest 8 or 9 entry header verifies.
/// Why it matters: the skip must not grow to "any length that is not 8 or 9". Only the length that names the state anchor
/// is exempt.
#[test]
fn a_compact_attested_header_of_a_length_that_names_no_anchor_is_refused() {
    for (spec, recipe) in [(&PULSECHAIN, pulsechain_recipe()), (&ETHEREUM_MAINNET, ethereum_recipe())] {
        let scenario = with_compact_attested_header(build_update(spec, recipe));
        assert!(verify(&scenario, &scenario.update).is_ok(), "{}: control", spec.name);
        let honest = scenario.update.attested_header.execution_branch.clone();
        for length in [0usize, 1, 7, 10, 12, 64] {
            let mut update = scenario.update.clone();
            update.attested_header.execution_branch = honest.iter().copied().cycle().take(length).collect();
            assert_eq!(
                verify(&scenario, &update),
                Err(Error::InvalidExecutionBranch("attested")),
                "{} length {length}",
                spec.name
            );
        }
    }
}

/// Claim: the state proofs bind the ATTESTED state root and not the finalized one. The finalized header commits to a crafted
/// state that holds the next committee at 55 and the root of the chain at 33. The attested state holds the finality leaf
/// and neither of those. The update carries the branches of the FINALIZED state. They are real branches, they verify
/// against the finalized state root, and the program refuses them: `InvalidNextSyncCommitteeBranch` for the next committee,
/// and, for an update without a next committee, `InvalidGenesisValidatorsRootBranch` for the root. Control: the branches of
/// the attested state verify.
/// Why it matters: no other test moves the root that the state proofs bind. A program that checked them against the
/// finalized state root would accept a state the committee never signed.
#[test]
fn state_proofs_bind_the_attested_state_root_not_the_finalized_one() {
    let spec = &PULSECHAIN;
    let placement = CraftedPlacement { finality: 105, next_committee: 55, genesis_validators_root: 33 };
    let next_committee_root = committee_for(spec, spec.period_at_slot(pulsechain_recipe().attested_slot) + 1)
        .committee
        .hash_tree_root()
        .expect("committee root");
    let finalized_tree = CraftedStateTree::new().place(55, next_committee_root).place(33, spec.genesis_validators_root);
    let finalized_state_root = finalized_tree.root();
    let build = |recipe: UpdateRecipe, attested_holds_proofs: bool| {
        build_update_over_tree_with_finalized_state(spec, recipe, finalized_state_root, placement, |facts| {
            let tree = CraftedStateTree::new().with_honest_values(spec, facts, placement);
            match attested_holds_proofs {
                true => tree,
                false => tree.without(55).without(33),
            }
        })
    };

    // The branches of the finalized state are real branches of that state.
    assert!(is_valid_exact_branch(&next_committee_root, &finalized_tree.branch(55), 55, &finalized_state_root));
    assert!(is_valid_exact_branch(
        &spec.genesis_validators_root,
        &finalized_tree.branch(33),
        33,
        &finalized_state_root
    ));

    let with_next = build(pulsechain_recipe(), false);
    let mut next_attack = with_next.update.clone();
    next_attack.next_sync_committee.as_mut().expect("a next committee").branch = finalized_tree.branch(55);
    next_attack.genesis_validators_root_branch = finalized_tree.branch(33);
    assert_eq!(
        verify_light_client_update(&with_next.store, &next_attack, spec),
        Err(Error::InvalidNextSyncCommitteeBranch)
    );

    let recipe = UpdateRecipe { include_next_committee: false, ..pulsechain_recipe() };
    let without_next = build(recipe, false);
    let mut root_attack = without_next.update.clone();
    root_attack.genesis_validators_root_branch = finalized_tree.branch(33);
    assert_eq!(
        verify_light_client_update(&without_next.store, &root_attack, spec),
        Err(Error::InvalidGenesisValidatorsRootBranch)
    );

    let control = build(pulsechain_recipe(), true);
    assert!(verify_light_client_update(&control.store, &control.update, spec).is_ok(), "control");
}

/// Claim: a changed attested state root breaks the state proofs first. Replacing `attested_header.beacon.state_root` of a
/// valid update gives exactly `InvalidFinalityBranch`, although the signature would fail too (the header root changed).
/// Control: the untouched update verifies.
/// Why it matters: this pins the order of the checks and the root they use. The state proofs run before the signature
/// check, against the attested state root.
#[test]
fn a_changed_attested_state_root_breaks_the_state_proofs_first() {
    for scenario in scenarios() {
        assert!(verify(&scenario, &scenario.update).is_ok(), "control");
        let mut update = scenario.update.clone();
        update.attested_header.beacon.state_root = B256::repeat_byte(0x42);
        assert_eq!(verify(&scenario, &update), Err(Error::InvalidFinalityBranch), "{}", scenario.spec.name);
    }
}
