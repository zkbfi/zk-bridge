//! The SP1 guests against `lc-core`, without proving.
//!
//! Each test runs a compiled guest program (an ELF file, Executable and Linkable Format) in the SP1 executor on real or synthetic inputs and compares the public values
//! with what `lc-core` computes natively. These tests show that the guest programs and the native reference agree.
//! A proof only shows that the ELF ran. It does not show that the ELF is the program we meant, so this agreement is
//! the evidence that matters.
//!
//! The tests need the two ELFs. Build them natively (the executor does not care about the build machine):
//! `cargo prove build --locked` in `light-client/guests/light-client` and in `light-client/guests/fork-observation`.
//! `SP1_LIGHT_CLIENT_ELF` and `SP1_FORK_OBSERVATION_ELF` name other files. Without an ELF a test prints a message and
//! passes, unless `SP1_REQUIRE_ELFS` is set, which turns the missing file into a failure.
//!
//! Run the tests one at a time: `cargo test --features sp1 --test sp1_execute -- --test-threads=1`. Each run of the
//! executor uses a lot of memory, and a parallel run was killed on a 16 GB laptop. The whole file takes about 4.5 minutes.
//!
//! The full Groth16 proof test is `#[ignore]`: it needs the server (see its comment).
#![cfg(feature = "sp1")]

use alloy_primitives::B256;
use lc_core::chain::ChainSpec;
use lc_core::update::{table_fork_version, FoldStep};
use lc_core::wire::{
    encode_guest_input, encode_observation_input, ChainSelector, GuestInput, ObservationGuestInput,
};
use lc_testkit::fork_observation_scenarios::{
    chains, fold_steps, observation_signed_by, stale_three_period_scenario,
};
use lc_testkit::json::{bootstrap, light_client_update, load_response, store_from_bootstrap};
use lc_testkit::pulsechain::real_update_and_store;
use std::path::PathBuf;
use zk_bridge_prover::error::Error;
use zk_bridge_prover::light_client::{
    guest_input_bytes, public_values, verify_observation_natively, verify_update_natively,
    ChainKind, UpdateInput,
};
use zk_bridge_prover::prover::{
    execute_program, require_matching_key, ProgramKind, ProofStatement, Prover, Sp1ProgramPaths,
    Sp1Prover,
};

fn guest_elf_path(guest: &str, variable: &str) -> PathBuf {
    if let Ok(path) = std::env::var(variable) {
        return PathBuf::from(path);
    }
    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("../light-client/guests")
        .join(guest)
        .join("target/elf-compilation/riscv64im-succinct-zkvm-elf/release")
        .join(format!("{guest}-guest"))
}

fn light_client_elf_path() -> PathBuf {
    guest_elf_path("light-client", "SP1_LIGHT_CLIENT_ELF")
}

fn fork_observation_elf_path() -> PathBuf {
    guest_elf_path("fork-observation", "SP1_FORK_OBSERVATION_ELF")
}

/// The bytes of an ELF, or `None` (with a message) when the file is missing and no one requires it.
fn elf_bytes(path: &PathBuf) -> Option<Vec<u8>> {
    match std::fs::read(path) {
        Ok(bytes) => Some(bytes),
        Err(error) => {
            assert!(
                std::env::var("SP1_REQUIRE_ELFS").is_err(),
                "SP1_REQUIRE_ELFS is set, but the ELF {} cannot be read: {error}",
                path.display()
            );
            eprintln!(
                "skipped: no ELF at {} ({error}); see the header of this file",
                path.display()
            );
            None
        }
    }
}

fn chain_kind(spec: &ChainSpec) -> ChainKind {
    if spec.name == "pulsechain" {
        ChainKind::Pulsechain
    } else {
        ChainKind::Ethereum
    }
}

fn selector(kind: ChainKind) -> ChainSelector {
    match kind {
        ChainKind::Ethereum => ChainSelector::EthereumMainnet,
        ChainKind::Pulsechain => ChainSelector::Pulsechain,
    }
}

fn real_ethereum_input() -> UpdateInput {
    let update = light_client_update(&load_response("ethereum/finality_update.json")["data"]);
    let store = store_from_bootstrap(
        &bootstrap(&load_response("ethereum/bootstrap_same_period.json")["data"]),
        None,
    );
    UpdateInput {
        chain: ChainKind::Ethereum,
        store,
        updates: vec![update],
    }
}

fn real_pulsechain_input() -> UpdateInput {
    let (store, update) = real_update_and_store();
    UpdateInput {
        chain: ChainKind::Pulsechain,
        store,
        updates: vec![update],
    }
}

fn synthetic_fold_input(spec: &'static ChainSpec, period: u64) -> UpdateInput {
    let scenario = stale_three_period_scenario(spec, period);
    UpdateInput {
        chain: chain_kind(spec),
        store: scenario.store,
        updates: scenario.updates,
    }
}

/// Claim: on each input, the light-client ELF commits exactly the 352 bytes that `lc-core` computes natively, and exits
/// with code 0.
/// Why it matters: the contract decodes these bytes. If the ELF and `lc-core` disagree, the prover would send a proof
/// that its own native check never accepted, or the native check would accept what the ELF cannot prove.
fn assert_light_client_agrees(label: &str, elf: &[u8], input: &UpdateInput) {
    let expected = public_values(&verify_update_natively(input).expect("native run accepts"));
    assert_eq!(expected.len(), 352, "{label}: native length");
    let run = execute_program(elf, &guest_input_bytes(input)).expect("executor runs");
    assert_eq!(run.exit_code, 0, "{label}: the guest accepts");
    assert_eq!(run.public_values, expected, "{label}: public values");
    eprintln!("{label}: {} instructions", run.instruction_count);
}

#[test]
fn light_client_guest_agrees_with_lc_core_on_real_ethereum_data() {
    let Some(elf) = elf_bytes(&light_client_elf_path()) else {
        return;
    };
    assert_light_client_agrees("real ethereum update", &elf, &real_ethereum_input());
}

#[test]
fn light_client_guest_agrees_with_lc_core_on_real_pulsechain_data() {
    let Some(elf) = elf_bytes(&light_client_elf_path()) else {
        return;
    };
    assert_light_client_agrees("real pulsechain update", &elf, &real_pulsechain_input());
}

/// A fold of three updates across three sync committee periods, on both chain layouts (synthetic committees).
#[test]
fn light_client_guest_agrees_with_lc_core_on_a_fold() {
    let Some(elf) = elf_bytes(&light_client_elf_path()) else {
        return;
    };
    for (spec, period) in chains() {
        let input = synthetic_fold_input(spec, period);
        assert_eq!(input.updates.len(), 3, "the fold has three steps");
        assert_light_client_agrees(&format!("fold on {}", spec.name), &elf, &input);
    }
}

/// Claim: the executor refuses a real update that the guest must reject (a wrong fork version in the signing domain),
/// and `lc-core` refuses the same input. The control, with the right version, is accepted.
/// Why it matters: a rejecting guest is what makes a false update unprovable.
#[test]
fn light_client_guest_rejects_a_wrong_fork_version() {
    let Some(elf) = elf_bytes(&light_client_elf_path()) else {
        return;
    };
    let input = real_ethereum_input();
    let spec = input.chain.spec();
    let update = input.updates[0].clone();
    let right_version = table_fork_version(spec, update.signature_slot);
    let guest_input = |fork_version: [u8; 4]| {
        encode_guest_input(&GuestInput {
            chain: selector(input.chain),
            store: input.store.clone(),
            steps: vec![FoldStep {
                update: update.clone(),
                fork_version,
            }],
        })
    };
    let control = execute_program(&elf, &guest_input(right_version)).expect("executor runs");
    assert_eq!(
        control.exit_code, 0,
        "control: the right version is accepted"
    );

    let mut wrong_version = right_version;
    wrong_version[0] ^= 0x01;
    let wrong_bytes = guest_input(wrong_version);
    assert!(
        lc_core::wire::run_light_client_guest(&wrong_bytes).is_err(),
        "lc-core rejects the wrong version"
    );
    let run = execute_program(&elf, &wrong_bytes).expect("executor runs");
    assert_ne!(run.exit_code, 0, "the guest rejects the wrong version");
    assert!(
        run.public_values.is_empty(),
        "a rejected input commits nothing"
    );
}

fn observation_input(spec: &'static ChainSpec, period: u64, count: usize) -> Vec<u8> {
    let stale = stale_three_period_scenario(spec, period);
    let steps = fold_steps(spec, &stale.updates);
    let slot = stale.final_head_slot() + 100;
    let observation =
        observation_signed_by(spec, &stale.final_committee(), [0, 0, 3, 0x6d], count, slot);
    encode_observation_input(&ObservationGuestInput {
        chain: selector(chain_kind(spec)),
        store: stale.store.clone(),
        steps,
        observation,
    })
}

/// Claim: the fork observation ELF commits exactly the 224 bytes that `lc-core` computes natively, after it folds three
/// updates and verifies the observation, on both chain layouts. The fixtures hold no committee data, so the input
/// comes from the synthetic builders of `lc-testkit`.
#[test]
fn fork_observation_guest_agrees_with_lc_core() {
    let Some(elf) = elf_bytes(&fork_observation_elf_path()) else {
        return;
    };
    for (spec, period) in chains() {
        let bytes = observation_input(spec, period, 400);
        let expected = verify_observation_natively(&bytes).expect("native run accepts");
        assert_eq!(expected.len(), 224);
        let run = execute_program(&elf, &bytes).expect("executor runs");
        assert_eq!(run.exit_code, 0, "{}: the guest accepts", spec.name);
        assert_eq!(run.public_values, expected, "{}: public values", spec.name);
        eprintln!(
            "observation on {}: {} instructions",
            spec.name, run.instruction_count
        );
    }
}

/// Claim: the fork observation ELF rejects an observation that 341 of 512 members sign (one below two thirds), and
/// rejects an input with a missing last byte. `lc-core` rejects both. The control with 400 signers is accepted above.
#[test]
fn fork_observation_guest_rejects_a_weak_signature_and_a_truncated_input() {
    let Some(elf) = elf_bytes(&fork_observation_elf_path()) else {
        return;
    };
    let (spec, period) = chains()[0];
    let weak = observation_input(spec, period, 341);
    let mut truncated = observation_input(spec, period, 400);
    truncated.pop();
    for (label, bytes) in [("341 signers", weak), ("truncated", truncated)] {
        assert!(
            verify_observation_natively(&bytes).is_err(),
            "{label}: lc-core rejects"
        );
        let run = execute_program(&elf, &bytes).expect("executor runs");
        assert_ne!(run.exit_code, 0, "{label}: the guest rejects");
    }
}

/// Claim: the check refuses a key that differs from the stored key in one bit, and accepts the equal key.
/// Why it matters: this check is what stops the prover from proving with a program the contract does not know.
#[test]
fn a_wrong_program_key_is_refused() {
    let stored = B256::repeat_byte(0x42);
    assert!(require_matching_key("light client", stored, stored).is_ok());
    let mut off_by_one_bit = stored;
    off_by_one_bit.0[31] ^= 0x01;
    let error = require_matching_key("light client", stored, off_by_one_bit).unwrap_err();
    assert!(matches!(error, Error::Config(_)), "got {error}");
    assert!(error.to_string().contains("refuses to run"), "got {error}");
}

fn load_prover() -> Option<Sp1Prover> {
    let light_client = light_client_elf_path();
    let fork_observation = fork_observation_elf_path();
    elf_bytes(&light_client)?;
    elf_bytes(&fork_observation)?;
    Some(
        Sp1Prover::load(&Sp1ProgramPaths {
            light_client,
            fork_observation: Some(fork_observation),
        })
        .expect("the prover loads both ELFs"),
    )
}

/// Claim: the loaded prover accepts the program key of its own ELF, refuses any other key at startup
/// (`require_program_key`), and refuses to prove under a wrong key before it starts the (slow) proof.
/// Also: the two programs have different keys, so a proof of one cannot pass for the other.
#[test]
fn the_loaded_prover_refuses_a_key_the_contract_does_not_store() {
    let Some(prover) = load_prover() else {
        return;
    };
    let light_client_key = prover.light_client_key();
    let observation_key = prover.fork_observation_key().expect("loaded");
    assert_ne!(light_client_key, observation_key);
    assert_ne!(light_client_key, B256::ZERO);
    prover
        .require_program_key(ProgramKind::LightClient, light_client_key)
        .expect("own key");
    prover
        .require_program_key(ProgramKind::ForkObservation, observation_key)
        .expect("own key");
    // Each program refuses the key of the other one.
    assert!(prover
        .require_program_key(ProgramKind::LightClient, observation_key)
        .is_err());
    assert!(prover
        .require_program_key(ProgramKind::ForkObservation, light_client_key)
        .is_err());

    let statement = ProofStatement::Verified(real_ethereum_input());
    let error = prover.prove(observation_key, &statement).unwrap_err();
    assert!(matches!(error, Error::Config(_)), "got {error}");
}

/// A development statement has no real proof.
#[test]
fn development_statements_are_refused_by_the_sp1_backend() {
    let Some(prover) = load_prover() else {
        return;
    };
    let error = prover
        .prove(
            prover.light_client_key(),
            &ProofStatement::ObservationAsserted(vec![0; 224]),
        )
        .unwrap_err();
    assert!(matches!(error, Error::Prover(_)), "got {error}");
}

/// The full Groth16 proof of a real update, on this machine's CPU.
///
/// Ignored on a laptop. It needs the server. The SP1 documentation page "Hardware Requirements"
/// (docs.succinct.xyz/docs/sp1/getting-started/hardware-requirements) lists, for local Groth16 proofs, 16 or more
/// processor cores and 16 GB or more of memory. The final wrapping step needs about 14 GB. With the feature
/// `sp1-native-gnark` the wrapping runs in the process. Without it, the SDK starts a Docker container.
/// Run it with `cargo test --release --features sp1-native-gnark -- --ignored full_groth16`.
#[test]
#[ignore = "needs the server: Groth16 proving needs at least 16 GB of memory"]
fn full_groth16_proof_of_a_real_update() {
    let Some(prover) = load_prover() else {
        return;
    };
    let input = real_ethereum_input();
    let expected = public_values(&verify_update_natively(&input).expect("native"));
    let proof = prover
        .prove(prover.light_client_key(), &ProofStatement::Verified(input))
        .expect("Groth16 proof");
    assert_eq!(proof.public_values, expected);
    // The proof bytes are a 4-byte verifier selector and 256 bytes of Groth16 proof.
    assert_eq!(proof.proof_bytes.len(), 4 + 256);
}
