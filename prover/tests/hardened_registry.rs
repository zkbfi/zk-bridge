//! Hardened two-chain tests of the fork registry (finding HB-02): a gate in registry mode on chain 369, its own-chain
//! light client, and the registry that the keeper feeds with fork observations.
//!
//! The observation fixtures come from `light-client/tests/fixtures/fork-observation/`. The registry reads the stored
//! start of its own-chain light client, so the test deploys that light client with the start store of the fixture.
//! The oracle verifier stands in for the proof system: it accepts a signature over the public values and the key.

mod common;

use alloy_primitives::{Address, B256};
use alloy_sol_types::SolCall;
use common::bridge::*;
use common::*;
use zk_bridge_prover::chain::ChainClient;
use zk_bridge_prover::contracts::{deposit_calldata, ForkRegistryContract, TokenContract};
use zk_bridge_prover::fork_observation::submit_fork_observation;
use zk_bridge_prover::prover::ProofStatement;
use zk_bridge_prover::route_health::{read_gate_observation, route_status, HealthSettings, Level, RouteInputs, REGISTRY_MODE};
use zk_bridge_prover::rpc::HttpRpc;

/// The observation of a version that the gate does not support (`0x0000036d`; the gate lists only Capella).
const UNSUPPORTED_FIXTURE: &str = "pulsechain_accept_version_outside_the_table";
/// An observation that belongs to the other chain (Ethereum genesis validators root).
const OTHER_CHAIN_FIXTURE: &str = "ethereum_accept_version_outside_the_table";
const TIMEOUT: std::time::Duration = std::time::Duration::from_secs(20);

fn registry_bridge(name: &str) -> Bridge {
    deploy_bridge_with(name, BridgeOptions { registry_fixture: Some(UNSUPPORTED_FIXTURE), ..Default::default() })
}

/// A client of chain B that signs with the deployer key, as a keeper would.
fn keeper_client(bridge: &Bridge) -> ChainClient {
    ChainClient::connect("chain-b", 369, Box::new(HttpRpc::new(&bridge.chain_b.anvil.url)), Some(deployer_signer())).expect("keeper client")
}

/// `latestObserved()` of the registry as `(version, slot)`.
fn latest_observed(bridge: &Bridge) -> ([u8; 4], u64) {
    let registry = bridge.registry_b.expect("registry");
    let raw = bridge.chain_b.call(registry, &ForkRegistryContract::latestObservedCall {}.abi_encode()).unwrap();
    let decoded = ForkRegistryContract::latestObservedCall::abi_decode_returns(&raw).unwrap();
    (decoded.version.0, decoded.slot)
}

/// The deposit call data on chain B with empty gate evidence (the gate in registry mode needs none on Shanghai).
fn deposit_call(bridge: &Bridge) -> Vec<u8> {
    deposit_calldata(bridge.token_b, RECIPIENT, alloy_primitives::U256::from(ONE_TOKEN), &[]).to_vec()
}

/// The selector of the revert of a deposit call made by the deployer, or `None` when the call would succeed. The
/// deposit needs the deployer as sender (the allowance is the deployer's), so a plain `eth_call` is not enough.
fn deposit_revert_selector(bridge: &Bridge) -> Option<[u8; 4]> {
    use zk_bridge_prover::rpc::JsonRpc;
    let request = serde_json::json!({
        "from": format!("{DEPLOYER:#x}"),
        "to": format!("{:#x}", bridge.vault_b),
        "data": format!("0x{}", alloy_primitives::hex::encode(deposit_call(bridge))),
    });
    let error = bridge.chain_b.rpc.call("eth_call", serde_json::json!([request, "latest"])).err()?;
    let revert = error.revert_data().expect("a revert carries data");
    Some(revert[..4].try_into().unwrap())
}

fn fund_and_approve(bridge: &Bridge) {
    let chain = &bridge.chain_b;
    chain.send(Some(bridge.token_b), &TokenContract::mintCall { to: DEPLOYER, amount: alloy_primitives::U256::from(10 * ONE_TOKEN) }.abi_encode());
    chain.send(
        Some(bridge.token_b),
        &TokenContract::approveCall { spender: bridge.vault_b, amount: alloy_primitives::U256::from(10 * ONE_TOKEN) }.abi_encode(),
    );
}

fn submit(bridge: &Bridge, vkey: B256, public_values: Vec<u8>) -> Result<(), zk_bridge_prover::error::Error> {
    let registry = bridge.registry_b.expect("registry");
    submit_fork_observation(
        &keeper_client(bridge),
        registry,
        &oracle_prover(),
        vkey,
        &ProofStatement::ObservationAsserted(public_values),
        TIMEOUT,
    )
    .map(|_| ())
}

/// Route inputs for the source chain B at the clock of the chain, with no scheduled fork, so only the gate decides.
fn inputs_for(bridge: &Bridge, gate: zk_bridge_prover::route_health::GateObservation) -> RouteInputs {
    RouteInputs {
        now: bridge.chain_b.latest_timestamp(),
        genesis_time: 0,
        seconds_per_slot: SECONDS_PER_SLOT,
        slots_per_epoch: SLOTS_PER_EPOCH,
        schedule: vec![],
        program_versions: vec![CAPELLA_VERSION],
        gate: Some(gate),
        light_client_head_slot: 100,
        source_head_slot: 100,
        settings: HealthSettings::default(),
    }
}

/// Claim: a gate in registry mode admits deposits while the registry holds nothing, an observation of an unsupported
/// version makes the next deposit revert with `UnsupportedObservedVersion` (the tokens stay in the wallet), route
/// health reports STOP, and the gate then seals with empty evidence for good.
/// Shows: the deployed mode number is 2, and the gate names the registry that the test deployed. The gate refuses
/// `seal` with empty evidence while nothing unsupported is observed (the control that the seal needs the observation).
/// A wrong program key, and an observation of the other chain, are refused and change nothing (the controls that the
/// registry checks the proof key and the start store). The honest observation is mined, the registry reports the
/// version and slot of the fixture, and the deposit reverts with the version and the slot in the error. After the
/// seal every deposit reverts with `GateSealed`.
/// Why it matters: this is the only protection on PulseChain after a consensus fork that brings no EIP-4788 and no
/// new opcode. Without the registry the gate keeps admitting deposits that the light client program can no longer
/// verify, and those deposits are stuck for good.
#[test]
fn hb02_registry_observation_of_an_unsupported_version_stops_deposits_and_allows_the_seal() {
    if !tools_available() {
        return;
    }
    let bridge = registry_bridge("hb02-registry");
    let fixture = bridge.observation_fixture.clone().expect("fixture");
    let chain = &bridge.chain_b;
    let (registry, gate) = (bridge.registry_b.expect("registry"), bridge.gate_b);

    // The deployment is what the test thinks it is (a name is a hypothesis).
    let observed = read_gate_observation(&client_of(chain), bridge.vault_b).expect("gate observation");
    assert_eq!(observed.mode, "DetectBeaconRootsAndRegistry");
    let seen = observed.registry.expect("the gate names a registry");
    assert_eq!(seen.registry, registry, "the registry comes from the gate");
    assert!(!seen.has_observation(), "the registry starts empty");
    let registry_light_client = chain.call(registry, &ForkRegistryContract::lightClientCall {}.abi_encode()).unwrap();
    assert_eq!(Address::from_slice(&registry_light_client[12..]), bridge.own_light_client_b.expect("own light client"));
    assert_ne!(bridge.own_light_client_b, Some(bridge.light_client_b), "the registry reads the own-chain light client, not the foreign one");
    assert_eq!(REGISTRY_MODE, 2);
    assert_eq!(route_status(&inputs_for(&bridge, observed)).level, Level::Open);

    // An empty registry admits a deposit.
    let first = deposit_on(&bridge, Direction::BToA, ONE_TOKEN);
    assert_eq!(first.receipt["status"], "0x1");
    fund_and_approve(&bridge);
    assert_eq!(deposit_revert_selector(&bridge), None, "an empty registry admits");

    // Control: with nothing observed, the registry seal has no ground.
    assert_eq!(revert_selector(chain, gate, &seal_calldata(&[])), Some(error_selector("NoUnsupportedObservation()")));
    assert!(!gate_sealed(chain, gate));

    // Controls: a proof under the light client key, and an observation of the other chain, are refused.
    let wrong_key = submit(&bridge, keccak_of(b"light-client-program"), fixture.public_values.clone());
    assert!(wrong_key.is_err(), "the verifier binds the program key");
    let foreign = ObservationFixture::load(OTHER_CHAIN_FIXTURE);
    let wrong_chain = submit(&bridge, observation_program_vkey(), foreign.public_values.clone()).unwrap_err();
    let revert = wrong_chain.revert_data().expect("the registry reverts with data");
    assert_eq!(revert[..4], error_selector("GenesisValidatorsRootMismatch(bytes32,bytes32)"), "the registry names the chain mismatch: {wrong_chain}");
    assert_eq!(latest_observed(&bridge), ([0; 4], 0), "refused observations record nothing");

    // The honest observation of an unsupported version.
    submit(&bridge, observation_program_vkey(), fixture.public_values.clone()).expect("the observation is accepted");
    assert_eq!(latest_observed(&bridge), (fixture.observed_version, fixture.observed_attested_slot));
    assert_ne!(fixture.observed_version, CAPELLA_VERSION);

    // Route health sees it.
    let observed = read_gate_observation(&client_of(chain), bridge.vault_b).expect("gate observation");
    assert_eq!(observed.registry.expect("registry").latest_version, fixture.observed_version);
    let status = route_status(&inputs_for(&bridge, observed));
    assert_eq!(status.level, Level::Stop, "{}", status.reason);

    // The next deposit reverts, with the version and the slot in the error, and the wallet keeps its tokens.
    let before = balance(chain, bridge.token_b, DEPLOYER);
    let revert = deposit_revert_selector(&bridge);
    assert_eq!(revert, Some(error_selector("UnsupportedObservedVersion(bytes4,uint64)")));
    let failed = chain.send_allowing_failure(Some(bridge.vault_b), &deposit_call(&bridge));
    assert_eq!(failed["status"], "0x0", "the deposit transaction fails");
    assert_eq!(balance(chain, bridge.token_b, DEPLOYER), before, "no tokens left the wallet");

    // Anyone seals the gate with empty evidence.
    chain.send(Some(gate), &seal_calldata(&[]));
    assert!(gate_sealed(chain, gate));
    assert_eq!(deposit_revert_selector(&bridge), Some(error_selector("GateSealed()")));
    let sealed = read_gate_observation(&client_of(chain), bridge.vault_b).expect("gate observation");
    assert_eq!(route_status(&inputs_for(&bridge, sealed)).level, Level::Sealed);
}

fn keccak_of(data: &[u8]) -> B256 {
    alloy_primitives::keccak256(data)
}
