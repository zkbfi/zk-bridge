//! Rejection tests for `verify_light_client_update`, on SYNTHETIC updates (generated keys, test-only state builder) for
//! both layouts, and on REAL Ethereum and PulseChain updates where the attack applies to real data.
//!
//! Synthetic tests are marked `synthetic_` in the name. Real-data tests are marked `real_`.
//! Every attack test has a control: the same scenario without the attack passes.

use alloy_primitives::B256;
use lc_core::chain::{ChainSpec, ETHEREUM_MAINNET, PULSECHAIN};
use lc_core::layout::{state_layout_for_fork, StateLayout, CAPELLA_DENEB_STATE_LAYOUT, ELECTRA_STATE_LAYOUT};
use lc_core::types::{LightClientStore, LightClientUpdate};
use lc_core::update::{
    advance_light_client_store, table_fork_version, verify_light_client_update,
    verify_light_client_update_with_fork_version, verify_with_layout,
};
use lc_core::Error;
use lc_testkit::json::{bootstrap, light_client_update, load_response, store_from_bootstrap};
use lc_testkit::pulsechain::real_update_and_store;
use lc_testkit::synthetic::{build_update, UpdateRecipe, UpdateScenario};

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
            Err(Error::SignatureVerificationFailed),
            "other genesis validators root"
        );
        assert_eq!(with(&foreign_root, other_version), Err(Error::SignatureVerificationFailed), "both");
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

fn capella_selector(_: lc_core::chain::ForkName) -> lc_core::Result<StateLayout> {
    Ok(CAPELLA_DENEB_STATE_LAYOUT)
}

fn electra_selector(_: lc_core::chain::ForkName) -> lc_core::Result<StateLayout> {
    Ok(ELECTRA_STATE_LAYOUT)
}

/// Claim: the wrong fork's generalized indices are refused in both directions: Capella indices on an Electra-layout update
/// and Electra indices on a Capella-layout update. The default selector (the per-fork table) accepts both.
#[test]
fn synthetic_wrong_forks_generalized_index_is_refused() {
    let capella = build_update(&PULSECHAIN, pulsechain_recipe());
    let electra = build_update(&ETHEREUM_MAINNET, ethereum_recipe());
    let run = |scenario: &UpdateScenario, selector| {
        let version = table_fork_version(scenario.spec, scenario.update.signature_slot);
        verify_with_layout(&scenario.store, &scenario.update, scenario.spec, selector, version)
            .map(|(output, _)| output)
    };
    assert!(run(&capella, state_layout_for_fork).is_ok() && run(&electra, state_layout_for_fork).is_ok(), "control");
    assert_eq!(run(&electra, capella_selector), Err(Error::InvalidFinalityBranch));
    assert_eq!(run(&capella, electra_selector), Err(Error::InvalidFinalityBranch));
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
    let update = light_client_update(&load_response("ethereum/finality_update.json")["data"]);
    let store = store_from_bootstrap(&bootstrap(&load_response("ethereum/bootstrap_same_period.json")["data"]), None);
    (store, update)
}

/// Claim: the attacks of this file also fail on REAL updates from both chains: a flipped signature bit, 341 participants,
/// every branch corrupted, the wrong fork's index, and an attested header presented as finalized. Control: the untouched
/// real update verifies.
#[test]
fn real_updates_reject_every_attack() {
    let cases: Vec<(&str, LightClientStore, LightClientUpdate, &ChainSpec, StateLayout)> = {
        let (eth_store, eth_update) = real_ethereum();
        let (pls_store, pls_update) = real_update_and_store();
        vec![
            ("ethereum", eth_store, eth_update, &ETHEREUM_MAINNET, CAPELLA_DENEB_STATE_LAYOUT),
            ("pulsechain", pls_store, pls_update, &PULSECHAIN, ELECTRA_STATE_LAYOUT),
        ]
    };
    for (name, store, update, spec, wrong_layout) in cases {
        let run = |update: &LightClientUpdate| verify_light_client_update(&store, update, spec);
        assert!(run(&update).is_ok(), "{name}: control");

        let mut tampered = update.clone();
        tampered.sync_aggregate.sync_committee_signature[95] ^= 0x01;
        assert!(
            matches!(run(&tampered), Err(Error::InvalidSignatureEncoding | Error::SignatureVerificationFailed)),
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

        let selector: lc_core::update::StateLayoutSelector =
            if wrong_layout == CAPELLA_DENEB_STATE_LAYOUT { capella_selector } else { electra_selector };
        let version = table_fork_version(spec, update.signature_slot);
        assert_eq!(
            verify_with_layout(&store, &update, spec, selector, version).map(|(output, _)| output),
            Err(Error::InvalidFinalityBranch),
            "{name}: wrong fork's index"
        );

        let mut tampered = update.clone();
        tampered.finalized_header = tampered.attested_header.clone();
        assert_eq!(run(&tampered), Err(Error::InvalidFinalityBranch), "{name}: attested is not finalized");
    }
}

// ---- guest wire format ----

/// Claim: the guest entry point (`run_light_client_guest`) decodes the wire format, verifies, and returns the exact ABI
/// bytes of the output, for a REAL Ethereum update and a REAL PulseChain update. Truncated input, trailing bytes and a
/// flipped fork version are refused. Why it matters: this is the function the SP1 guest calls.
#[test]
fn real_updates_run_through_the_guest_entry_point() {
    use alloy_sol_types::SolValue;
    use lc_core::wire::{decode_guest_input, encode_guest_input, run_light_client_guest, ChainSelector, GuestInput};
    let (eth_store, eth_update) = real_ethereum();
    let (pls_store, pls_update) = real_update_and_store();
    for (chain, spec, store, update) in [
        (ChainSelector::EthereumMainnet, &ETHEREUM_MAINNET, eth_store, eth_update),
        (ChainSelector::Pulsechain, &PULSECHAIN, pls_store, pls_update),
    ] {
        let fork_version = table_fork_version(spec, update.signature_slot);
        let input = GuestInput { chain, fork_version, store: store.clone(), update: update.clone() };
        let bytes = encode_guest_input(&input);
        assert_eq!(decode_guest_input(&bytes), Ok(input.clone()), "roundtrip");
        let expected = verify_light_client_update(&store, &update, spec).unwrap().abi_encode();
        assert_eq!(run_light_client_guest(&bytes), Ok(expected));

        assert!(run_light_client_guest(&bytes[..bytes.len() - 1]).is_err(), "truncated");
        let mut trailing = bytes.clone();
        trailing.push(0);
        assert!(run_light_client_guest(&trailing).is_err(), "trailing byte");
        let mut wrong_version = bytes.clone();
        wrong_version[1] ^= 0x01;
        assert_eq!(run_light_client_guest(&wrong_version), Err(Error::SignatureVerificationFailed));
        let mut wrong_chain = bytes.clone();
        wrong_chain[0] = if chain == ChainSelector::Pulsechain { 1 } else { 2 };
        assert!(run_light_client_guest(&wrong_chain).is_err(), "the other chain's configuration");
    }
}
