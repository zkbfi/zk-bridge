//! Integration tests on local Anvil chains. They deploy the hardened contracts built by forge.
//!
//! Chain 1 (the Ethereum role) runs Anvil on `cancun`. Anvil does not deploy the EIP-4788 beacon roots contract, so
//! the tests install the genuine runtime code at its address and write the beacon roots by hand. The deposit gate
//! of chain 1 is `Enforcing`. Chain 369 (the PulseChain role) runs on `shanghai`, which has no EIP-4788. Its gate is
//! `DetectBeaconRoots`, so it admits every deposit and never needs evidence.
//!
//! Why two Anvil processes and not one: `BridgeVault` requires `localChainId == block.chainid` and a remote chain
//! identifier that differs from it, and a withdrawal needs the deposit's target chain to equal the withdrawing
//! vault's local chain. One chain has one identifier, so no pair of vaults can satisfy both on one Anvil.
//! The chains here are chain 1 (the Ethereum role) and chain 369 (the PulseChain role).
//!
//! Every test skips with a message when `anvil` or `forge` is missing.

mod common;

use alloy_primitives::{hex, keccak256, Address, Bytes, B256, U256};
use alloy_sol_types::{sol, SolCall};
use common::*;
use std::collections::HashMap;
use zk_bridge_prover::cli;
use zk_bridge_prover::chain::ChainClient;
use zk_bridge_prover::contracts::{deposit_calldata, TokenContract, VaultContract};
use zk_bridge_prover::error::Error;
use zk_bridge_prover::gate::{gate_evidence_for_deposit, ForkEvidenceSource, ForkRequest, GateContract};
use zk_bridge_prover::light_client::{fork_evidence_bytes, ForkData};
use zk_bridge_prover::rpc::HttpRpc;
use zk_bridge_prover::light_client::{decode_deposit, DEPOSIT_EVENT_TOPIC};
use zk_bridge_prover::prover::{oracle_digest, OracleProver, ProofStatement, Prover};
use zk_bridge_prover::signer::Signer;

sol! {
    interface OracleVerifier {
        function verifyProof(bytes32 programVKey, bytes publicValues, bytes proofBytes) external view;
    }
}

const ONE_TOKEN: u128 = 1_000_000_000_000_000_000;

fn deployer_signer() -> Signer {
    Signer::from_secret_bytes(&hex::decode(DEPLOYER_SECRET.trim_start_matches("0x")).unwrap()).unwrap()
}

/// Claim: a proof made by `OracleProver` is accepted by the Solidity `OracleSP1Verifier`, byte for byte, and
/// every change to the digest inputs or the signature is rejected.
/// Why it matters: the Rust digest `keccak256(programVKey ‖ sha256(publicValues))` must equal the Solidity one.
/// A mismatch would make every light-client update revert on chain. The controls show the test can fail.
#[test]
fn oracle_signature_is_accepted_by_the_solidity_mock() {
    if !tools_available() {
        return;
    }
    let chain = TestChain::start(1, Hardfork::Shanghai);
    let verifier = chain.deploy("OracleSP1Verifier", HashMap::from([("oracle", word_address(DEPLOYER))]));

    let output = zk_bridge_prover::light_client::dev_output(
        B256::repeat_byte(1), 7, B256::repeat_byte(2), B256::repeat_byte(3), B256::repeat_byte(4),
        B256::repeat_byte(5), 9, B256::repeat_byte(6), 11,
    );
    let vkey = keccak256(b"program");
    let proof = OracleProver::new(deployer_signer()).prove(vkey, &ProofStatement::DevAsserted(output)).unwrap();
    assert_eq!(proof.public_values.len(), 352);

    let verify = |vkey: B256, values: &[u8], signature: &[u8]| {
        let call = OracleVerifier::verifyProofCall { programVKey: vkey, publicValues: Bytes::copy_from_slice(values), proofBytes: Bytes::copy_from_slice(signature) };
        chain.call(verifier, &call.abi_encode())
    };
    assert!(verify(vkey, &proof.public_values, &proof.proof_bytes).is_ok(), "the Solidity mock must accept the Rust proof");
    assert_eq!(oracle_digest(vkey, &proof.public_values), {
        // The digest the mock builds, spelled out from its source: keccak256(abi.encodePacked(vkey, sha256(values))).
        let mut packed = vkey.to_vec();
        packed.extend_from_slice(alloy_primitives::hex::decode(sha256_hex(&proof.public_values)).unwrap().as_slice());
        keccak256(packed)
    });

    // Controls: each change must be refused with a revert.
    let mut other_values = proof.public_values.clone();
    other_values[40] ^= 1;
    assert!(verify(vkey, &other_values, &proof.proof_bytes).is_err(), "changed public values");
    assert!(verify(keccak256(b"other"), &proof.public_values, &proof.proof_bytes).is_err(), "changed key");
    let mut flipped = proof.proof_bytes.clone();
    flipped[3] ^= 1;
    assert!(verify(vkey, &proof.public_values, &flipped).is_err(), "changed signature");
    assert!(verify(vkey, &proof.public_values, &proof.proof_bytes[..64]).is_err(), "short signature");
}

fn sha256_hex(data: &[u8]) -> String {
    hex::encode(zk_bridge_prover::light_client::sha256(data))
}

struct Bridge {
    chain_a: TestChain,
    chain_b: TestChain,
    token_a: Address,
    token_b: Address,
    vault_a: Address,
    vault_b: Address,
    gate_a: Address,
    gate_b: Address,
    config_path: std::path::PathBuf,
}

/// The beacon roots contract of EIP-4788.
const BEACON_ROOTS: Address = alloy_primitives::address!("000F3df6D732807Ef1319fB7B8bB8522d0Beac02");

/// The genuine runtime code of the EIP-4788 contract (the code in the specification, with `PUSH0`). The Solidity gate
/// tests install the same bytes (`test/hardened/utils/GateMocks.sol`). The contract keeps a ring buffer of 8191
/// entries: `timestamp` at slot `timestamp % 8191`, and the root at that slot plus 8191.
const BEACON_ROOTS_CODE: &str = "3373fffffffffffffffffffffffffffffffffffffffe14604d57602036146024575f5ffd5b5f35801560495762001fff810690815414603c575f5ffd5b62001fff01545f5260205ff35b5f5ffd5b62001fff42064281555f359062001fff015500";
const RING_LENGTH: u64 = 8191;
/// The Capella fork version of the synthetic beacon chain, with the depth of the state tree (28 fields: depth 5).
const CAPELLA_VERSION: [u8; 4] = [3, 0, 0, 0];
const SECONDS_PER_SLOT: u64 = 12;
const SLOTS_PER_EPOCH: u64 = 32;

/// The seconds of a gate epoch.
const EPOCH_SECONDS: u64 = SECONDS_PER_SLOT * SLOTS_PER_EPOCH;

/// A genesis time that puts the present about 100 seconds into an epoch, so no epoch border falls inside a test.
fn gate_genesis_time() -> u64 {
    let now = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).expect("clock").as_secs();
    now - 100 - EPOCH_SECONDS * 1_000
}

/// Installs the genuine EIP-4788 code on a chain.
fn install_beacon_roots(chain: &TestChain) {
    chain.set_code(BEACON_ROOTS, &hex::decode(BEACON_ROOTS_CODE).unwrap());
}

/// A fork evidence source with no beacon node: a synthetic state whose `fork.current_version` is Capella, a header over
/// it, and the header root written into the ring buffer of the beacon roots contract under the latest block time.
struct SyntheticForkSource<'a> {
    chain: &'a TestChain,
    version: [u8; 4],
    /// How many evidence requests the source served.
    requests: std::sync::atomic::AtomicUsize,
}

impl ForkEvidenceSource for SyntheticForkSource<'_> {
    fn fork_evidence(&self, request: &ForkRequest<'_>) -> Result<Vec<u8>, Error> {
        self.requests.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
        let timestamp = self.chain.latest_timestamp();
        let fork = ForkData { previous_version: [2, 0, 0, 0], current_version: self.version, epoch: 3 };
        let mut field_roots: Vec<B256> = (0..28u64).map(|field| keccak256(format!("synthetic-state-field/{field}"))).collect();
        field_roots[3] = fork.hash_tree_root();
        let header = zk_bridge_prover::light_client::BeaconHeader {
            slot: (timestamp - request.genesis_time) / request.seconds_per_slot,
            proposer_index: 1,
            parent_root: keccak256(b"synthetic-parent"),
            state_root: lc_core::ssz::merkleize(&field_roots),
            body_root: keccak256(b"synthetic-body"),
        };
        assert_eq!(header.slot / request.slots_per_epoch, request.epoch, "the synthetic header lies in the epoch the gate wants");
        let position = timestamp % RING_LENGTH;
        self.chain.set_storage(request.beacon_roots, B256::from(U256::from(position).to_be_bytes::<32>()), B256::from(U256::from(timestamp).to_be_bytes::<32>()));
        self.chain.set_storage(
            request.beacon_roots,
            B256::from(U256::from(position + RING_LENGTH).to_be_bytes::<32>()),
            header.hash_tree_root(),
        );
        Ok(fork_evidence_bytes(timestamp, &header, fork, &field_roots))
    }
}

fn pairs(local: Address, remote: Address) -> Argument {
    Argument::Tuples(vec![vec![word_address_raw(local), word_address_raw(remote), word_u64_raw(18)]])
}

fn word_address_raw(value: Address) -> [u8; 32] {
    let mut word = [0u8; 32];
    word[12..].copy_from_slice(value.as_slice());
    word
}

fn word_u64_raw(value: u64) -> [u8; 32] {
    U256::from(value).to_be_bytes()
}

/// What `deploy_side` returns.
struct Side {
    token: Address,
    light_client: Address,
    gate: Address,
    vault: Address,
}

/// Deploys token, oracle verifier, light client, deposit gate and vault on one chain, in this order. The deployer
/// nonce of the token is 0 (1 on a chain that sent a dummy transaction), the vault follows 4 nonces later.
#[allow(clippy::too_many_arguments)]
fn deploy_side(
    chain: &TestChain,
    local_id: u64,
    remote_id: u64,
    local_token_name: &str,
    remote_token: Address,
    remote_vault: Address,
    genesis_label: &str,
    gate_mode: u64,
) -> Side {
    let token = chain.deploy("MockERC20", HashMap::from([("name", Argument::Text(local_token_name.into())), ("symbol", Argument::Text("TKN".into()))]));
    let verifier = chain.deploy("OracleSP1Verifier", HashMap::from([("oracle", word_address(DEPLOYER))]));
    let light_client = chain.deploy(
        "BeaconLightClient",
        HashMap::from([
            ("verifier", word_address(verifier)),
            ("programVKey", word_hash(keccak256(b"light-client-program"))),
            ("genesisValidatorsRoot", word_hash(keccak256(genesis_label))),
            ("slotsPerPeriod", word_u64(1 << 20)),
            ("initialSlot", word_u64(1)),
            ("initialHeaderRoot", word_hash(keccak256(b"checkpoint"))),
            ("initialSyncCommitteeHash", word_hash(keccak256(b"committee"))),
            ("initialNextSyncCommitteeHash", word_hash(B256::ZERO)),
        ]),
    );
    let gate = chain.deploy(
        "BeaconForkGate",
        HashMap::from([
            ("beaconRoots", word_address(BEACON_ROOTS)),
            ("mode", word_u64(gate_mode)),
            ("genesisTime", word_u64(gate_genesis_time())),
            ("secondsPerSlot", word_u64(SECONDS_PER_SLOT)),
            ("slotsPerEpoch", word_u64(SLOTS_PER_EPOCH)),
            ("supportedVersions", Argument::Tuples(vec![vec![raw_bytes4(CAPELLA_VERSION), word_u64_raw(5)]])),
            ("sealDepths", Argument::Words(vec![word_u64_raw(5), word_u64_raw(6), word_u64_raw(7)])),
        ]),
    );
    let vault = chain.deploy(
        "BridgeVault",
        HashMap::from([
            ("lightClient", word_address(light_client)),
            ("localChainId", word_u64(local_id)),
            ("remoteChainId", word_u64(remote_id)),
            ("remoteVault", word_address(remote_vault)),
            ("pairs", pairs(token, remote_token)),
            ("depositCutoffTimestamp", word_u64(0)),
            ("capellaEra", word_u64(0)),
            ("depositGate", word_address(gate)),
        ]),
    );
    Side { token, light_client, gate, vault }
}

fn deploy_bridge(name: &str) -> Bridge {
    // Chain A: Ethereum role, cancun, with the beacon roots contract and an Enforcing gate (mode 0).
    // Chain B: PulseChain role, shanghai, which has no beacon roots contract, and a DetectBeaconRoots gate (mode 1).
    let chain_a = TestChain::start(1, Hardfork::Cancun);
    let chain_b = TestChain::start(369, Hardfork::Shanghai);
    install_beacon_roots(&chain_a);
    // Chain B sends one dummy transaction first, so the two chains give different contract addresses.
    chain_b.send(Some(DEPLOYER), &[]);
    // Addresses follow from the deployer nonce: token, verifier, light client, gate, vault.
    let (token_a, vault_a) = (DEPLOYER.create(0), DEPLOYER.create(4));
    let (token_b, vault_b) = (DEPLOYER.create(1), DEPLOYER.create(5));
    let side_a = deploy_side(&chain_a, 1, 369, "Token A", token_b, vault_b, "genesis-of-chain-b", 0);
    let side_b = deploy_side(&chain_b, 369, 1, "Token B", token_a, vault_a, "genesis-of-chain-a", 1);
    assert_eq!((side_a.token, side_a.vault), (token_a, vault_a));
    assert_eq!((side_b.token, side_b.vault), (token_b, vault_b));

    let directory = scratch(name);
    let config = format!(
        r#"
database_path = "{database}"
poll_interval_seconds = 1
receipt_timeout_seconds = 20
max_attempts = 3

[prover]
backend = "oracle"
program_vkey = "{vkey:#x}"

[chain_a]
name = "chain-a"
rpc_url = "{url_a}"
chain_id = 1
vault = "{vault_a:#x}"
light_client = "{lc_a:#x}"
[chain_a.beacon]
kind = "dev"
chain = "pulsechain"
finality_depth = 1

[chain_b]
name = "chain-b"
rpc_url = "{url_b}"
chain_id = 369
vault = "{vault_b:#x}"
light_client = "{lc_b:#x}"
[chain_b.beacon]
kind = "dev"
chain = "pulsechain"
finality_depth = 1
"#,
        database = directory.join("prover.sqlite").display(),
        vkey = keccak256(b"light-client-program"),
        url_a = chain_a.anvil.url,
        url_b = chain_b.anvil.url,
        lc_a = side_a.light_client,
        lc_b = side_b.light_client,
    );
    let config_path = directory.join("prover.toml");
    std::fs::write(&config_path, config).unwrap();
    Bridge { chain_a, chain_b, token_a, token_b, vault_a, vault_b, gate_a: side_a.gate, gate_b: side_b.gate, config_path }
}

fn run(bridge: &Bridge, command: &[&str]) -> Result<String, Error> {
    let mut arguments = vec!["zk-bridge-prover".to_string(), "--config".into(), bridge.config_path.display().to_string()];
    arguments.extend(["--private-key-env".to_string(), "ANVIL_DEPLOYER".into()]);
    arguments.extend(command.iter().map(|part| part.to_string()));
    let lookup = |name: &str| (name == "ANVIL_DEPLOYER").then(|| DEPLOYER_SECRET.to_string());
    let mut output = Vec::new();
    cli::execute(arguments, &lookup, &mut output)?;
    Ok(String::from_utf8(output).unwrap())
}

fn balance(chain: &TestChain, token: Address, account: Address) -> U256 {
    let raw = chain.call(token, &TokenContract::balanceOfCall { account }.abi_encode()).unwrap();
    U256::from_be_slice(&raw)
}

fn claimed(chain: &TestChain, vault: Address, nonce: B256) -> bool {
    let raw = chain.call(vault, &VaultContract::claimedCall { depositNonce: nonce }.abi_encode()).unwrap();
    raw.last() == Some(&1)
}

/// Mints, approves and deposits on chain A. Returns the receipt and the index of the deposit log inside it.
fn deposit(bridge: &Bridge, amount: u128) -> (serde_json::Value, usize, B256) {
    let chain = &bridge.chain_a;
    chain.send(Some(bridge.token_a), &TokenContract::mintCall { to: DEPLOYER, amount: U256::from(amount) }.abi_encode());
    chain.send(Some(bridge.token_a), &TokenContract::approveCall { spender: bridge.vault_a, amount: U256::from(amount) }.abi_encode());
    let evidence = gate_evidence(chain, bridge.gate_a);
    let receipt = chain.send(Some(bridge.vault_a), &deposit_calldata(bridge.token_a, RECIPIENT, U256::from(amount), &evidence));
    let logs = receipt["logs"].as_array().unwrap();
    let index = logs.iter().position(|log| log["topics"][0].as_str() == Some(&format!("{DEPOSIT_EVENT_TOPIC:#x}"))).expect("deposit log");
    let topics: Vec<B256> = logs[index]["topics"].as_array().unwrap().iter().map(|topic| topic.as_str().unwrap().parse().unwrap()).collect();
    let data = hex::decode(logs[index]["data"].as_str().unwrap()).unwrap();
    let nonce = decode_deposit(&topics, &data).unwrap().nonce;
    (receipt, index, nonce)
}

/// A client for a test chain, without a signer.
fn client_of(chain: &TestChain) -> ChainClient {
    ChainClient::connect("test", chain.anvil.chain_id, Box::new(HttpRpc::new(&chain.anvil.url)), None).expect("client")
}

/// The gate evidence that `gate_evidence_for_deposit` builds for a deposit now.
fn gate_evidence(chain: &TestChain, gate: Address) -> Vec<u8> {
    let source = SyntheticForkSource { chain, version: CAPELLA_VERSION, requests: Default::default() };
    gate_evidence_for_deposit(&client_of(chain), gate, &source).expect("gate evidence")
}

/// Claim: `once` takes a deposit on chain A to a paid withdrawal on chain B through `DevBeaconSource`: it advances
/// the light client with oracle-signed updates, adds the vault layout rows, verifies natively, and calls `withdraw`.
/// A second `once` changes nothing. `withdraw --tx --log-index` delivers a second deposit by hand.
/// Why it matters: this is the whole service against the real hardened contracts. Any mismatch between the Rust
/// builders and the Solidity checks (branches, gindices, receipt proof, signature) makes a transaction revert here.
#[test]
fn a_deposit_completes_end_to_end_through_the_dev_source() {
    if !tools_available() {
        return;
    }
    let bridge = deploy_bridge("end-to-end");
    // The destination vault needs liquidity: the vault pays from its own balance.
    bridge.chain_b.send(Some(bridge.token_b), &TokenContract::mintCall { to: bridge.vault_b, amount: U256::from(1_000 * ONE_TOKEN) }.abi_encode());

    let amount = 5 * ONE_TOKEN;
    let (_, _, nonce) = deposit(&bridge, amount);
    // Depth 1: the deposit block is final once one more block exists. Mine two to be sure.
    bridge.chain_a.mine(2);
    assert!(!claimed(&bridge.chain_b, bridge.vault_b, nonce));

    run(&bridge, &["once"]).expect("once");
    assert_eq!(balance(&bridge.chain_b, bridge.token_b, RECIPIENT), U256::from(amount), "the recipient was paid on chain B");
    assert!(claimed(&bridge.chain_b, bridge.vault_b, nonce));
    let status = run(&bridge, &["status"]).unwrap();
    assert!(status.contains(&format!("nonce={nonce:#x} route=a_to_b state=confirmed")), "{status}");

    // A second pass is a no-op: no new transaction on chain B.
    let nonce_before = bridge.chain_b.nonce(DEPLOYER);
    run(&bridge, &["once"]).expect("second once");
    assert_eq!(bridge.chain_b.nonce(DEPLOYER), nonce_before, "an idempotent pass sends nothing");
    assert_eq!(balance(&bridge.chain_b, bridge.token_b, RECIPIENT), U256::from(amount));

    // A second deposit, delivered by the manual command. The log index is the index inside the receipt.
    let (receipt, log_index, second_nonce) = deposit(&bridge, 3 * ONE_TOKEN);
    assert!(log_index > 0, "the token transfer log comes before the deposit log, so the receipt index is not 0");
    bridge.chain_a.mine(2);
    let transaction = receipt["transactionHash"].as_str().unwrap().to_string();
    run(&bridge, &["withdraw", "--tx", &transaction, "--log-index", &log_index.to_string()]).expect("withdraw");
    assert!(claimed(&bridge.chain_b, bridge.vault_b, second_nonce));
    assert_eq!(balance(&bridge.chain_b, bridge.token_b, RECIPIENT), U256::from(8 * ONE_TOKEN));
    let status = run(&bridge, &["status"]).unwrap();
    assert!(status.contains("deposits=2"), "{status}");
    assert_eq!(status.matches("state=confirmed").count(), 2, "{status}");
}

/// Claim: a deposit whose block is not yet final is not read, so nothing is withdrawn; once the block is final the
/// same `once` pass delivers it.
/// Why it matters: the service must read only final source blocks (the depth rule on Anvil).
#[test]
fn an_unfinalized_deposit_is_not_withdrawn() {
    if !tools_available() {
        return;
    }
    let bridge = deploy_bridge("unfinalized");
    bridge.chain_b.send(Some(bridge.token_b), &TokenContract::mintCall { to: bridge.vault_b, amount: U256::from(100 * ONE_TOKEN) }.abi_encode());
    let (_, _, nonce) = deposit(&bridge, ONE_TOKEN);
    // The deposit block is the latest block: with depth 1 it is not final.
    run(&bridge, &["once"]).expect("once");
    assert!(!claimed(&bridge.chain_b, bridge.vault_b, nonce));
    assert!(run(&bridge, &["status"]).unwrap().contains("deposits=0"));
    bridge.chain_a.mine(2);
    run(&bridge, &["once"]).expect("once");
    assert!(claimed(&bridge.chain_b, bridge.vault_b, nonce));
}

fn confirmed_epoch(chain: &TestChain, gate: Address) -> (u64, bool) {
    let raw = chain.call(gate, &GateContract::confirmedEpochCall {}.abi_encode()).unwrap();
    let decoded = GateContract::confirmedEpochCall::abi_decode_returns(&raw).unwrap();
    (decoded.epoch, decoded.exists)
}

/// The first four bytes of the revert data of a call, or `None` when the call succeeds.
fn revert_selector(chain: &TestChain, to: Address, data: &[u8]) -> Option<[u8; 4]> {
    let error = chain.call(to, data).err()?;
    let revert = error.revert_data().expect("a revert carries data");
    Some(revert[..4].try_into().unwrap())
}

/// Claim: the Enforcing gate of chain A wants a fork proof in a stale epoch, and the proof from the builder admits
/// the deposit. A deposit with empty evidence reverts with `ForkNotConfirmed`. The builder sends empty evidence when
/// the epoch is confirmed, and builds a proof again after the clock moves into the next epoch.
/// Why it matters: this checks the evidence builder against the real `BeaconForkGate` code: the decoder, the
/// beacon roots lookup, the header root, the epoch rule and the generalized index of the version leaf.
/// The controls show the test can fail: empty evidence reverts, and evidence for another version reverts too.
#[test]
fn an_enforcing_gate_takes_the_built_evidence_once_per_epoch() {
    if !tools_available() {
        return;
    }
    let bridge = deploy_bridge("enforcing-gate");
    let chain = &bridge.chain_a;
    let amount = ONE_TOKEN;
    chain.send(Some(bridge.token_a), &TokenContract::mintCall { to: DEPLOYER, amount: U256::from(10 * amount) }.abi_encode());
    chain.send(Some(bridge.token_a), &TokenContract::approveCall { spender: bridge.vault_a, amount: U256::from(10 * amount) }.abi_encode());
    let call = |evidence: &[u8]| deposit_calldata(bridge.token_a, RECIPIENT, U256::from(amount), evidence);

    let enforcing = chain.call(bridge.gate_a, &GateContract::enforcingCall {}.abi_encode()).unwrap();
    assert_eq!(enforcing.last(), Some(&1), "chain A starts enforcing");
    assert!(!confirmed_epoch(chain, bridge.gate_a).1);

    // Control 1: empty evidence in an unconfirmed epoch reverts with ForkNotConfirmed(epoch).
    let selector = &keccak256("ForkNotConfirmed(uint256)")[..4];
    assert_eq!(revert_selector(chain, bridge.vault_a, &call(&[])).as_ref().map(|s| &s[..]), Some(selector));

    // Control 2: a proof of another version (not in the supported list) reverts with UnsupportedVersion.
    let wrong = SyntheticForkSource { chain, version: [9, 9, 9, 9], requests: Default::default() };
    let wrong_evidence = gate_evidence_for_deposit(&client_of(chain), bridge.gate_a, &wrong).unwrap();
    let selector = &keccak256("UnsupportedVersion(bytes4)")[..4];
    assert_eq!(revert_selector(chain, bridge.vault_a, &call(&wrong_evidence)).as_ref().map(|s| &s[..]), Some(selector));

    // The built evidence admits the deposit and confirms the epoch.
    let source = SyntheticForkSource { chain, version: CAPELLA_VERSION, requests: Default::default() };
    let client = client_of(chain);
    let evidence = gate_evidence_for_deposit(&client, bridge.gate_a, &source).unwrap();
    assert!(!evidence.is_empty());
    chain.send(Some(bridge.vault_a), &call(&evidence));
    let (epoch, exists) = confirmed_epoch(chain, bridge.gate_a);
    assert!(exists);
    let current = GateContract::currentEpochCall::abi_decode_returns(&chain.call(bridge.gate_a, &GateContract::currentEpochCall {}.abi_encode()).unwrap()).unwrap();
    assert_eq!(U256::from(epoch), current);

    // Same epoch: the builder sends empty evidence, and the deposit passes. The source is not asked.
    let before = source.requests.load(std::sync::atomic::Ordering::SeqCst);
    let again = gate_evidence_for_deposit(&client, bridge.gate_a, &source).unwrap();
    assert!(again.is_empty());
    assert_eq!(source.requests.load(std::sync::atomic::Ordering::SeqCst), before);
    chain.send(Some(bridge.vault_a), &call(&again));

    // The next epoch: the confirmation is stale, empty evidence reverts, and the builder asks the source again.
    chain.advance_time(EPOCH_SECONDS + 10);
    assert!(revert_selector(chain, bridge.vault_a, &call(&[])).is_some(), "stale epoch, empty evidence");
    let fresh = gate_evidence_for_deposit(&client, bridge.gate_a, &source).unwrap();
    assert!(!fresh.is_empty());
    chain.send(Some(bridge.vault_a), &call(&fresh));
    assert!(confirmed_epoch(chain, bridge.gate_a).0 > epoch);
}

/// Claim: the gate on chain B (shanghai, no beacon roots contract, DetectBeaconRoots) admits a deposit with empty
/// evidence, stays in detection mode, and the builder asks for no evidence.
/// Why it matters: the PulseChain vault must keep working while the chain has no EIP-4788.
#[test]
fn a_detecting_gate_admits_deposits_without_evidence() {
    if !tools_available() {
        return;
    }
    let bridge = deploy_bridge("detecting-gate");
    let chain = &bridge.chain_b;
    let amount = ONE_TOKEN;
    chain.send(Some(bridge.token_b), &TokenContract::mintCall { to: DEPLOYER, amount: U256::from(amount) }.abi_encode());
    chain.send(Some(bridge.token_b), &TokenContract::approveCall { spender: bridge.vault_b, amount: U256::from(amount) }.abi_encode());
    let source = SyntheticForkSource { chain, version: CAPELLA_VERSION, requests: Default::default() };
    let evidence = gate_evidence_for_deposit(&client_of(chain), bridge.gate_b, &source).unwrap();
    assert!(evidence.is_empty());
    assert_eq!(source.requests.load(std::sync::atomic::Ordering::SeqCst), 0);
    chain.send(Some(bridge.vault_b), &deposit_calldata(bridge.token_b, RECIPIENT, U256::from(amount), &evidence));
    let enforcing = chain.call(bridge.gate_b, &GateContract::enforcingCall {}.abi_encode()).unwrap();
    assert_eq!(enforcing.last(), Some(&0), "the gate is still detecting");
    assert_eq!(confirmed_epoch(chain, bridge.gate_b), (0, false));
}

/// Moves the clock of the chain so that the next block lies about 100 seconds into a gate epoch. A test that mines many
/// blocks calls it, so no epoch border falls between the evidence and the deposit.
fn settle_in_epoch(chain: &TestChain, gate: Address) {
    let genesis = GateContract::genesisTimeCall::abi_decode_returns(&chain.call(gate, &GateContract::genesisTimeCall {}.abi_encode()).unwrap()).unwrap();
    let offset = (chain.latest_timestamp() - genesis) % EPOCH_SECONDS;
    if !(20..=300).contains(&offset) {
        chain.advance_time((100 + EPOCH_SECONDS - offset) % EPOCH_SECONDS);
    }
}

/// Claim: a deposit made after more than 2048 blocks (more than 8192 beacon slots in the dev chain) is delivered. The
/// first light-client update jumps from the checkpoint at slot 1 to slot 1024 + 4 * 2200, past the old 8192-slot cap.
/// Why it matters: the contract lost its head-jump cap in the same change that added the historical path. If the
/// contract or the dev source kept a cap, a chain with a long history could not be served at all.
#[test]
fn a_head_jump_of_more_than_8192_slots_is_accepted() {
    if !tools_available() {
        return;
    }
    let bridge = deploy_bridge("long-jump");
    bridge.chain_b.send(Some(bridge.token_b), &TokenContract::mintCall { to: bridge.vault_b, amount: U256::from(100 * ONE_TOKEN) }.abi_encode());
    bridge.chain_a.mine(2_200);
    settle_in_epoch(&bridge.chain_a, bridge.gate_a);
    let (_, _, nonce) = deposit(&bridge, ONE_TOKEN);
    bridge.chain_a.mine(2);
    run(&bridge, &["once"]).expect("once");
    assert!(claimed(&bridge.chain_b, bridge.vault_b, nonce));
    let head = zk_bridge_prover::contracts::LightClientContract::headCall::abi_decode_returns(
        &bridge
            .chain_b
            .call(
                // The light client of chain B is the contract deployed third on that chain (nonce 3 after the dummy transaction).
                DEPLOYER.create(3),
                &zk_bridge_prover::contracts::LightClientContract::headCall {}.abi_encode(),
            )
            .unwrap(),
    )
    .unwrap();
    assert!(head > 1 + 8192, "the head moved by {} slots in the first step", head - 1);
}
