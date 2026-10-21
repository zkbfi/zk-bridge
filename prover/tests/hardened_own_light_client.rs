//! The prover keeps the own-chain light client of chain B (the one the fork registry reads) current.
//!
//! Chain B runs its gate in registry mode, so it has a light client of its OWN beacon chain and a fork registry that
//! reads it. Nothing else updates that light client. These tests run the prover loop against two Anvil chains and show
//! that the head moves, that the registry then judges observations against the new head, and that a wrong wiring is
//! refused at startup. The oracle verifier stands in for the proof system, as in `hardened_registry.rs`.

mod common;

use alloy_primitives::{Address, B256};
use common::bridge::*;
use common::*;
use std::collections::HashMap;
use zk_bridge_prover::beacon::dev::DevBeaconSource;
use zk_bridge_prover::beacon::{BeaconSource, UpdatePlan};
use zk_bridge_prover::chain::{ChainClient, ExecutionReader};
use zk_bridge_prover::contracts::{observe_calldata, LightClientContract};
use zk_bridge_prover::fork_observation::submit_fork_observation;
use zk_bridge_prover::light_client::ChainKind;
use zk_bridge_prover::prover::{ProofStatement, Prover};
use zk_bridge_prover::route::read_light_client_state_of;
use zk_bridge_prover::rpc::HttpRpc;

/// The observation of a version that the gate does not support. Its start store is the checkpoint of the fixture.
const FIXTURE: &str = "pulsechain_accept_version_outside_the_table";
/// The finality depth of the bridge of these tests (the default of `BridgeOptions`).
const FINALITY_DEPTH: u64 = 1;
const TIMEOUT: std::time::Duration = std::time::Duration::from_secs(20);

fn registry_bridge(name: &str) -> Bridge {
    deploy_bridge_with(
        name,
        BridgeOptions {
            registry_fixture: Some(FIXTURE),
            ..Default::default()
        },
    )
}

fn own_light_client(bridge: &Bridge) -> Address {
    bridge
        .own_light_client_b
        .expect("registry mode deploys an own-chain light client")
}

fn own_head(bridge: &Bridge) -> u64 {
    client_of(&bridge.chain_b)
        .view(own_light_client(bridge), LightClientContract::headCall {})
        .unwrap()
}

/// The dev source as the prover config builds it for chain B.
fn dev_source() -> DevBeaconSource {
    DevBeaconSource::new(ChainKind::Pulsechain, FINALITY_DEPTH, OWN_CHAIN_SLOT_OFFSET)
}

/// The slot that the prover moves the own-chain light client to, given the blocks of chain B now.
fn expected_head(bridge: &Bridge) -> u64 {
    let latest = client_of(&bridge.chain_b).latest_block_number().unwrap();
    dev_source().slot_of(latest - FINALITY_DEPTH, 0)
}

/// The public values of an observation that starts from the stored head of the own-chain light client after the
/// update `output`, and observes the version of the fixture 100 slots later.
fn observation_after(
    fixture: &ObservationFixture,
    output: &zk_bridge_prover::light_client::LightClientOutput,
) -> Vec<u8> {
    let word = |value: u64| {
        let mut bytes = [0u8; 32];
        bytes[24..].copy_from_slice(&value.to_be_bytes());
        bytes
    };
    let mut version_word = [0u8; 32];
    version_word[..4].copy_from_slice(&fixture.observed_version);
    let mut values = Vec::new();
    values.extend_from_slice(fixture.genesis_validators_root().as_slice());
    values.extend_from_slice(output.newHeaderRoot.as_slice());
    values.extend_from_slice(&word(output.newHeadSlot));
    values.extend_from_slice(output.syncCommitteeHash.as_slice());
    values.extend_from_slice(B256::ZERO.as_slice());
    values.extend_from_slice(&version_word);
    values.extend_from_slice(&word(output.newHeadSlot + 100));
    values
}

/// The selector of the revert that `observe` gives for these public values now, or `None` when it would accept them.
/// A call, not a transaction: nothing is recorded.
fn observe_revert(bridge: &Bridge, public_values: &[u8]) -> Option<[u8; 4]> {
    let statement = ProofStatement::ObservationAsserted(public_values.to_vec());
    let proof = oracle_prover()
        .prove(observation_program_vkey(), &statement)
        .expect("oracle proof");
    let data = observe_calldata(&proof.proof_bytes, &proof.public_values);
    revert_selector(&bridge.chain_b, bridge.registry_b.expect("registry"), &data)
}

fn keeper_client(bridge: &Bridge) -> ChainClient {
    ChainClient::connect(
        "chain-b",
        369,
        Box::new(HttpRpc::new(&bridge.chain_b.anvil.url)),
        Some(deployer_signer()),
    )
    .expect("keeper client")
}

/// Claim: each pass of the prover moves the own-chain light client to the newest final block of chain B, and sends
/// one update per pass.
/// Shows: the head is the fixture checkpoint before the first pass. After it, the head is the first slot of block
/// `latest - depth`, and the light client holds the execution block hash of that block. Each later pass, after the
/// chain grew, moves the head to the block that was then the newest final one. The events list every head in order.
/// (On Anvil the update itself mines a block, so the finalized block moves between two passes.)
/// Why it matters: nothing else updates this light client. Without the loop its head stays at the deployment checkpoint
/// for good, and the registry judges every observation against a checkpoint that grows older each day.
#[test]
fn the_prover_loop_moves_the_own_chain_light_client_forward() {
    if !tools_available() {
        return;
    }
    let bridge = registry_bridge("own-light-client-advance");
    let fixture = bridge.observation_fixture.clone().expect("fixture");
    assert_eq!(
        own_head(&bridge),
        fixture.head_slot,
        "the head starts at the checkpoint"
    );
    assert!(stored_head_slots(&bridge.chain_b, own_light_client(&bridge)).is_empty());

    let wanted = expected_head(&bridge);
    assert!(
        wanted > fixture.observed_attested_slot,
        "the dev slots lie above the fixture, or the test shows nothing"
    );
    run(&bridge, &["once"]).expect("once");
    assert_eq!(
        own_head(&bridge),
        wanted,
        "the loop moved the head to the newest final block"
    );
    let latest_block = wanted_block(&bridge, wanted);
    let stored_hash = client_of(&bridge.chain_b)
        .view(
            own_light_client(&bridge),
            LightClientContract::executionBlockHashesCall { slot: wanted },
        )
        .unwrap();
    let block = client_of(&bridge.chain_b)
        .block(latest_block)
        .unwrap()
        .expect("block");
    assert_eq!(
        format!("{stored_hash:#x}"),
        block["hash"].as_str().unwrap(),
        "the head carries the hash of its block"
    );
    assert_eq!(
        stored_head_slots(&bridge.chain_b, own_light_client(&bridge)),
        vec![wanted]
    );

    let mut expected = vec![wanted];
    for _ in 0..2 {
        bridge.chain_b.mine(3);
        let newer = expected_head(&bridge);
        assert!(newer > *expected.last().unwrap());
        run(&bridge, &["once"]).expect("once after growth");
        assert_eq!(own_head(&bridge), newer, "the head follows the chain");
        expected.push(newer);
    }
    assert_eq!(
        stored_head_slots(&bridge.chain_b, own_light_client(&bridge)),
        expected
    );
}

/// The block number that a head slot of the dev source belongs to.
fn wanted_block(_bridge: &Bridge, slot: u64) -> u64 {
    dev_source().block_and_phase(slot).expect("a dev slot").0
}

/// Claim: after the loop moved the own-chain light client, the registry judges against the new head. An observation
/// that starts from the new head is refused while the head is stale (`PreviousHeadSlotMismatch`) and accepted after.
/// The old observation of the fixture, which the stale head took as fresh, is refused after
/// (`ObservationNotFresh`).
/// Shows: before the pass, the fixture observation passes a dry run (the stale head cannot tell it is old) and the
/// current observation fails. After the pass the two swap. The current observation is then mined, and the registry
/// records the version and the slot.
/// Why it matters: this is the failure that the loop prevents. A stale head lets a replay of an old signature pass as
/// fresh, and it refuses every observation that is built from the real chain head.
#[test]
fn the_registry_judges_observations_against_the_moved_head() {
    if !tools_available() {
        return;
    }
    let bridge = registry_bridge("own-light-client-registry");
    let fixture = bridge.observation_fixture.clone().expect("fixture");
    let source = client_of(&bridge.chain_b);

    // What the loop will do, planned the same way, without sending it.
    let state = read_light_client_state_of(&source, own_light_client(&bridge))
        .expect("own light client state");
    let UpdatePlan::Update(statement) = dev_source()
        .next_head_update(&state, &source)
        .expect("plan")
    else {
        panic!("the checkpoint lies below the newest final block");
    };
    let ProofStatement::DevAsserted(planned) = *statement else {
        panic!("the dev source asserts outputs")
    };
    let current = observation_after(&fixture, &planned);

    // Before: the stale head takes the old observation as fresh, and refuses the current one.
    assert_eq!(
        observe_revert(&bridge, &fixture.public_values),
        None,
        "the stale head cannot tell that the observation is old"
    );
    assert_eq!(
        observe_revert(&bridge, &current),
        Some(error_selector("PreviousHeadSlotMismatch(uint64,uint64)")),
        "the stale head refuses an observation built from the real head"
    );

    run(&bridge, &["once"]).expect("once");
    assert_eq!(
        own_head(&bridge),
        planned.newHeadSlot,
        "the loop did what the plan said"
    );

    // After: the two swap.
    assert_eq!(
        observe_revert(&bridge, &fixture.public_values),
        Some(error_selector("ObservationNotFresh(uint64,uint64)")),
        "the moved head knows the old observation is a replay"
    );
    assert_eq!(
        observe_revert(&bridge, &current),
        None,
        "the moved head accepts the current observation"
    );

    let submitted = submit_fork_observation(
        &keeper_client(&bridge),
        bridge.registry_b.expect("registry"),
        &oracle_prover(),
        observation_program_vkey(),
        &ProofStatement::ObservationAsserted(current),
        TIMEOUT,
    )
    .expect("the registry accepts the current observation");
    assert_eq!(
        (submitted.version, submitted.attested_slot),
        (fixture.observed_version, planned.newHeadSlot + 100)
    );
}

/// Claim: the prover refuses to start when the own-chain light client follows another beacon chain than the light client
/// on the other chain, and the message names the field. The refusal comes before any update.
/// Shows: an own-chain light client with another genesis validators root makes `once` fail, and its head stays put.
/// Why it matters: a name is a hypothesis. A configured address that is a light client of the wrong chain would take
/// every update (the program binds the start store, not the chain name) or none, and the operator would think it works.
#[test]
fn a_light_client_of_another_chain_is_refused_as_the_own_chain_light_client() {
    if !tools_available() {
        return;
    }
    let bridge = registry_bridge("own-light-client-wiring");
    let fixture = bridge.observation_fixture.clone().expect("fixture");
    let other_chain = bridge.chain_b.deploy(
        "BeaconLightClient",
        HashMap::from([
            ("verifier", word_address(bridge.verifier_b)),
            (
                "programVKey",
                word_hash(alloy_primitives::keccak256(b"light-client-program")),
            ),
            (
                "genesisValidatorsRoot",
                word_hash(alloy_primitives::keccak256(b"another beacon chain")),
            ),
            ("slotsPerPeriod", word_u64(OBSERVATION_SLOTS_PER_PERIOD)),
            ("genesisTime", word_u64(LIGHT_CLIENT_GENESIS_TIME)),
            ("secondsPerSlot", word_u64(LIGHT_CLIENT_SECONDS_PER_SLOT)),
            ("initialSlot", word_u64(fixture.head_slot)),
            ("initialHeaderRoot", word_hash(fixture.header_root)),
            (
                "initialSyncCommitteeHash",
                word_hash(fixture.committee_hash),
            ),
            (
                "initialNextSyncCommitteeHash",
                word_hash(fixture.next_committee_hash),
            ),
        ]),
    );
    // Replace the whole line: an address can repeat on the two chains (equal nonces), so a plain text replace is unsafe.
    let text = std::fs::read_to_string(&bridge.config_path).unwrap();
    let own_line = format!("own_light_client = \"{:#x}\"", own_light_client(&bridge));
    assert_eq!(
        text.matches(&own_line).count(),
        1,
        "the configuration names the own-chain light client once"
    );
    std::fs::write(
        &bridge.config_path,
        text.replace(
            &own_line,
            &format!("own_light_client = \"{other_chain:#x}\""),
        ),
    )
    .unwrap();

    let error = run(&bridge, &["once"]).expect_err("the wiring is wrong");
    assert!(
        error
            .to_string()
            .contains("own light client genesisValidatorsRoot"),
        "{error}"
    );
    let head = client_of(&bridge.chain_b)
        .view(other_chain, LightClientContract::headCall {})
        .unwrap();
    assert_eq!(head, fixture.head_slot, "nothing was sent");
}
