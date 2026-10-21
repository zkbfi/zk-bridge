//! A deployed two-chain bridge for the hardened tests: two Anvil chains, the hardened contracts built by forge, and a
//! prover configuration file. Every hardened test file starts from [`deploy_bridge`] or [`deploy_bridge_with`].
//!
//! Chain A (id 1) runs `cancun` with the genuine EIP-4788 code installed and an `Enforcing` deposit gate. Chain B
//! (id 369) runs `shanghai`, has no beacon roots contract, and its gate is in detection mode.
//!
//! Why two Anvil processes and not one: `BridgeVault` requires `localChainId == block.chainid` and a remote chain
//! identifier that differs from it. One chain has one identifier, so no pair of vaults can satisfy both on one Anvil.

use super::*;
use alloy_sol_types::{sol, SolCall};
use zk_bridge_prover::beacon::dev::{DevBeaconSource, DEFAULT_SLOT_OFFSET};
use zk_bridge_prover::beacon::{BeaconSource, DepositBlock, LightClientState};
use zk_bridge_prover::chain::ChainClient;
use zk_bridge_prover::cli;
use zk_bridge_prover::contracts::{deposit_calldata, head_updated_topic, LightClientContract, TokenContract, VaultContract};
use zk_bridge_prover::error::Error;
use zk_bridge_prover::gate::{gate_evidence_for_deposit, ForkEvidenceSource, ForkRequest, GateContract};
use zk_bridge_prover::light_client::{
    assemble_withdrawal_proof, build_execution_evidence, decode_deposit, fork_evidence_bytes, withdrawal_calldata, BeaconHeader, ChainKind,
    ForkData, DEPOSIT_EVENT_TOPIC,
};
use zk_bridge_prover::prover::OracleProver;
use zk_bridge_prover::rpc::{parse_quantity, HttpRpc};
use zk_bridge_prover::signer::Signer;

sol! {
    /// The write surface of `BeaconForkGate` that the tests call.
    interface GateWrites {
        function seal(bytes calldata evidence) external;
    }
}

/// One token in the smallest unit (18 decimals).
pub const ONE_TOKEN: u128 = 1_000_000_000_000_000_000;

/// The beacon roots contract of EIP-4788.
pub const BEACON_ROOTS: Address = alloy_primitives::address!("000F3df6D732807Ef1319fB7B8bB8522d0Beac02");

/// The genuine runtime code of the EIP-4788 contract (the code in the specification, with `PUSH0`). The Solidity gate
/// tests install the same bytes (`test/hardened/utils/GateMocks.sol`). The contract keeps a ring buffer of 8191
/// entries: `timestamp` at slot `timestamp % 8191`, and the root at that slot plus 8191.
pub const BEACON_ROOTS_CODE: &str = "3373fffffffffffffffffffffffffffffffffffffffe14604d57602036146024575f5ffd5b5f35801560495762001fff810690815414603c575f5ffd5b62001fff01545f5260205ff35b5f5ffd5b62001fff42064281555f359062001fff015500";
/// The length of the ring buffer of the beacon roots contract.
pub const RING_LENGTH: u64 = 8191;
/// The Capella fork version of the synthetic beacon chain, with the depth of the state tree (28 fields: depth 5).
pub const CAPELLA_VERSION: [u8; 4] = [3, 0, 0, 0];
/// A fork version that no gate supports.
pub const UNKNOWN_VERSION: [u8; 4] = [9, 9, 9, 9];
/// Seconds per slot of the gate's beacon chain.
pub const SECONDS_PER_SLOT: u64 = 12;
/// Slots per epoch of the gate's beacon chain.
pub const SLOTS_PER_EPOCH: u64 = 32;
/// The seconds of a gate epoch.
pub const EPOCH_SECONDS: u64 = SECONDS_PER_SLOT * SLOTS_PER_EPOCH;

/// The signer of the first Anvil account, which is also the oracle of the verifier contracts.
pub fn deployer_signer() -> Signer {
    Signer::from_secret_bytes(&hex::decode(DEPLOYER_SECRET.trim_start_matches("0x")).unwrap()).unwrap()
}

/// A genesis time that puts the present about 100 seconds into an epoch, so no epoch border falls inside a test.
fn gate_genesis_time() -> u64 {
    let now = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).expect("clock").as_secs();
    now - 100 - EPOCH_SECONDS * 1_000
}

/// Installs the genuine EIP-4788 code on a chain.
pub fn install_beacon_roots(chain: &TestChain) {
    chain.set_code(BEACON_ROOTS, &hex::decode(BEACON_ROOTS_CODE).unwrap());
}

/// Writes one entry of the ring buffer of the beacon roots contract.
pub fn write_beacon_root(chain: &TestChain, timestamp: u64, root: B256) {
    let position = timestamp % RING_LENGTH;
    chain.set_storage(BEACON_ROOTS, B256::from(U256::from(position).to_be_bytes::<32>()), B256::from(U256::from(timestamp).to_be_bytes::<32>()));
    chain.set_storage(BEACON_ROOTS, B256::from(U256::from(position + RING_LENGTH).to_be_bytes::<32>()), root);
}

/// A fork evidence source with no beacon node: a synthetic state whose `fork.current_version` is `version`, a header
/// over it, and the header root written into the ring buffer of the beacon roots contract under the latest block time.
pub struct SyntheticForkSource<'a> {
    pub chain: &'a TestChain,
    pub version: [u8; 4],
    /// How many evidence requests the source served.
    pub requests: std::sync::atomic::AtomicUsize,
}

impl<'a> SyntheticForkSource<'a> {
    pub fn new(chain: &'a TestChain, version: [u8; 4]) -> Self {
        Self { chain, version, requests: Default::default() }
    }
}

impl ForkEvidenceSource for SyntheticForkSource<'_> {
    fn fork_evidence(&self, request: &ForkRequest<'_>) -> Result<Vec<u8>, Error> {
        self.requests.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
        let timestamp = self.chain.latest_timestamp();
        let fork = ForkData { previous_version: [2, 0, 0, 0], current_version: self.version, epoch: 3 };
        let mut field_roots: Vec<B256> = (0..28u64).map(|field| keccak256(format!("synthetic-state-field/{field}"))).collect();
        field_roots[3] = fork.hash_tree_root();
        let header = BeaconHeader {
            slot: (timestamp - request.genesis_time) / request.seconds_per_slot,
            proposer_index: 1,
            parent_root: keccak256(b"synthetic-parent"),
            state_root: lc_core::ssz::merkleize(&field_roots),
            body_root: keccak256(b"synthetic-body"),
        };
        assert_eq!(header.slot / request.slots_per_epoch, request.epoch, "the synthetic header lies in the epoch the gate wants");
        write_beacon_root(self.chain, timestamp, header.hash_tree_root());
        Ok(fork_evidence_bytes(timestamp, &header, fork, &field_roots))
    }
}

use alloy_primitives::keccak256;

fn word_address_raw(value: Address) -> [u8; 32] {
    let mut word = [0u8; 32];
    word[12..].copy_from_slice(value.as_slice());
    word
}

fn word_u64_raw(value: u64) -> [u8; 32] {
    U256::from(value).to_be_bytes()
}

/// The constructor argument for token pairs: `(local token, remote token)` with 18 decimals each.
fn pairs_argument(pairs: &[(Address, Address)]) -> Argument {
    Argument::Tuples(pairs.iter().map(|(local, remote)| vec![word_address_raw(*local), word_address_raw(*remote), word_u64_raw(18)]).collect())
}

/// What `deploy_side` returns.
pub struct Side {
    pub token: Address,
    pub verifier: Address,
    pub light_client: Address,
    pub gate: Address,
    pub vault: Address,
}

/// The gate mode numbers of the `BeaconForkGate` constructor.
pub const GATE_MODE_ENFORCING: u64 = 0;
pub const GATE_MODE_DETECT: u64 = 1;

/// Deploys oracle verifier, light client, deposit gate and vault on one chain, in this order, after the token. The
/// vault follows the token by 4 nonces.
#[allow(clippy::too_many_arguments)]
fn deploy_side(
    chain: &TestChain,
    local_id: u64,
    remote_id: u64,
    local_token_name: &str,
    pairs: &[(Address, Address)],
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
            ("pairs", pairs_argument(pairs)),
            ("depositCutoffTimestamp", word_u64(0)),
            ("capellaEra", word_u64(0)),
            ("depositGate", word_address(gate)),
        ]),
    );
    Side { token, verifier, light_client, gate, vault }
}

/// The two directions of the bridge.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Direction {
    /// Deposit on chain A (id 1), withdraw on chain B (id 369).
    AToB,
    /// Deposit on chain B (id 369), withdraw on chain A (id 1).
    BToA,
}

/// What differs between bridges of the tests.
#[derive(Clone, Copy, Debug)]
pub struct BridgeOptions {
    /// Deploy a second token at the SAME address on both chains and register it on the vault of chain A only (H-03).
    pub rogue_token: bool,
    /// The finality depth of the development beacon source, in blocks.
    pub finality_depth: u64,
}

impl Default for BridgeOptions {
    fn default() -> Self {
        Self { rogue_token: false, finality_depth: 1 }
    }
}

/// Two chains with the hardened contracts deployed, and the configuration file of the prover.
pub struct Bridge {
    pub chain_a: TestChain,
    pub chain_b: TestChain,
    pub token_a: Address,
    pub token_b: Address,
    pub vault_a: Address,
    pub vault_b: Address,
    pub gate_a: Address,
    pub gate_b: Address,
    pub light_client_a: Address,
    pub light_client_b: Address,
    pub verifier_a: Address,
    pub verifier_b: Address,
    /// The token that has one address on both chains and is registered on chain A only. `None` without the option.
    pub rogue_token: Option<Address>,
    pub config_path: PathBuf,
}

impl Drop for Bridge {
    /// Removes the scratch directory (configuration and SQLite file). The Anvil processes stop with their own drop.
    fn drop(&mut self) {
        if let Some(directory) = self.config_path.parent() {
            let _ = std::fs::remove_dir_all(directory);
        }
    }
}

impl Bridge {
    /// The chain where a deposit of this direction is made.
    pub fn source(&self, direction: Direction) -> &TestChain {
        match direction {
            Direction::AToB => &self.chain_a,
            Direction::BToA => &self.chain_b,
        }
    }

    /// The chain where the withdrawal of this direction happens.
    pub fn destination(&self, direction: Direction) -> &TestChain {
        self.source(match direction {
            Direction::AToB => Direction::BToA,
            Direction::BToA => Direction::AToB,
        })
    }

    pub fn source_token(&self, direction: Direction) -> Address {
        match direction {
            Direction::AToB => self.token_a,
            Direction::BToA => self.token_b,
        }
    }

    pub fn destination_token(&self, direction: Direction) -> Address {
        match direction {
            Direction::AToB => self.token_b,
            Direction::BToA => self.token_a,
        }
    }

    pub fn source_vault(&self, direction: Direction) -> Address {
        match direction {
            Direction::AToB => self.vault_a,
            Direction::BToA => self.vault_b,
        }
    }

    pub fn destination_vault(&self, direction: Direction) -> Address {
        match direction {
            Direction::AToB => self.vault_b,
            Direction::BToA => self.vault_a,
        }
    }

    pub fn source_gate(&self, direction: Direction) -> Address {
        match direction {
            Direction::AToB => self.gate_a,
            Direction::BToA => self.gate_b,
        }
    }

    /// The light client on the destination chain, which tracks the source chain.
    pub fn destination_light_client(&self, direction: Direction) -> Address {
        match direction {
            Direction::AToB => self.light_client_b,
            Direction::BToA => self.light_client_a,
        }
    }
}

/// Deploys the standard bridge: no rogue token, finality depth 1.
pub fn deploy_bridge(name: &str) -> Bridge {
    deploy_bridge_with(name, BridgeOptions::default())
}

/// Deploys a bridge. The scratch directory is named after `name`.
pub fn deploy_bridge_with(name: &str, options: BridgeOptions) -> Bridge {
    let chain_a = TestChain::start(1, Hardfork::Cancun);
    let chain_b = TestChain::start(369, Hardfork::Shanghai);
    install_beacon_roots(&chain_a);

    // The rogue token goes first, at nonce 0 on both chains, so it has one address on both.
    let rogue_token = options.rogue_token.then(|| {
        let deploy_rogue = |chain: &TestChain| {
            chain.deploy("MockERC20", HashMap::from([("name", Argument::Text("Rogue".into())), ("symbol", Argument::Text("RGE".into()))]))
        };
        let (on_a, on_b) = (deploy_rogue(&chain_a), deploy_rogue(&chain_b));
        assert_eq!(on_a, on_b, "the rogue token has the same address on both chains");
        on_a
    });

    // Chain B sends one dummy transaction first, so the two chains give different contract addresses.
    chain_b.send(Some(DEPLOYER), &[]);
    // Addresses follow from the deployer nonce: token, verifier, light client, gate, vault.
    let (nonce_a, nonce_b) = (chain_a.nonce(DEPLOYER), chain_b.nonce(DEPLOYER));
    let (token_a, vault_a) = (DEPLOYER.create(nonce_a), DEPLOYER.create(nonce_a + 4));
    let (token_b, vault_b) = (DEPLOYER.create(nonce_b), DEPLOYER.create(nonce_b + 4));
    assert_ne!(token_a, token_b, "the real pair has different addresses on the two chains");

    let mut pairs_a = vec![(token_a, token_b)];
    if let Some(rogue) = rogue_token {
        pairs_a.push((rogue, rogue));
    }
    let side_a = deploy_side(&chain_a, 1, 369, "Token A", &pairs_a, vault_b, "genesis-of-chain-b", GATE_MODE_ENFORCING);
    let side_b = deploy_side(&chain_b, 369, 1, "Token B", &[(token_b, token_a)], vault_a, "genesis-of-chain-a", GATE_MODE_DETECT);
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
finality_depth = {depth}

[chain_b]
name = "chain-b"
rpc_url = "{url_b}"
chain_id = 369
vault = "{vault_b:#x}"
light_client = "{lc_b:#x}"
[chain_b.beacon]
kind = "dev"
chain = "pulsechain"
finality_depth = {depth}
"#,
        database = directory.join("prover.sqlite").display(),
        vkey = keccak256(b"light-client-program"),
        url_a = chain_a.anvil.url,
        url_b = chain_b.anvil.url,
        lc_a = side_a.light_client,
        lc_b = side_b.light_client,
        depth = options.finality_depth,
    );
    let config_path = directory.join("prover.toml");
    std::fs::write(&config_path, config).unwrap();
    Bridge {
        chain_a,
        chain_b,
        token_a,
        token_b,
        vault_a,
        vault_b,
        gate_a: side_a.gate,
        gate_b: side_b.gate,
        light_client_a: side_a.light_client,
        light_client_b: side_b.light_client,
        verifier_a: side_a.verifier,
        verifier_b: side_b.verifier,
        rogue_token,
        config_path,
    }
}

/// Runs the prover command line against the configuration of the bridge, as `once`, `status` or `withdraw` would.
pub fn run(bridge: &Bridge, command: &[&str]) -> Result<String, Error> {
    let mut arguments = vec!["zk-bridge-prover".to_string(), "--config".into(), bridge.config_path.display().to_string()];
    arguments.extend(["--private-key-env".to_string(), "ANVIL_DEPLOYER".into()]);
    arguments.extend(command.iter().map(|part| part.to_string()));
    let lookup = |name: &str| (name == "ANVIL_DEPLOYER").then(|| DEPLOYER_SECRET.to_string());
    let mut output = Vec::new();
    cli::execute(arguments, &lookup, &mut output)?;
    Ok(String::from_utf8(output).unwrap())
}

/// The token balance of an account.
pub fn balance(chain: &TestChain, token: Address, account: Address) -> U256 {
    let raw = chain.call(token, &TokenContract::balanceOfCall { account }.abi_encode()).unwrap();
    U256::from_be_slice(&raw)
}

/// Whether the vault paid the deposit nonce.
pub fn claimed(chain: &TestChain, vault: Address, nonce: B256) -> bool {
    let raw = chain.call(vault, &VaultContract::claimedCall { depositNonce: nonce }.abi_encode()).unwrap();
    raw.last() == Some(&1)
}

/// Mints tokens to the vault of the destination, which pays withdrawals from its own balance.
pub fn fund_destination_vault(bridge: &Bridge, direction: Direction, amount: u128) {
    bridge.destination(direction).send(
        Some(bridge.destination_token(direction)),
        &TokenContract::mintCall { to: bridge.destination_vault(direction), amount: U256::from(amount) }.abi_encode(),
    );
}

/// A client for a test chain, without a signer.
pub fn client_of(chain: &TestChain) -> ChainClient {
    ChainClient::connect("test", chain.anvil.chain_id, Box::new(HttpRpc::new(&chain.anvil.url)), None).expect("client")
}

/// The gate evidence that `gate_evidence_for_deposit` builds for a deposit now, from a synthetic Capella chain.
pub fn gate_evidence(chain: &TestChain, gate: Address) -> Vec<u8> {
    let source = SyntheticForkSource::new(chain, CAPELLA_VERSION);
    gate_evidence_for_deposit(&client_of(chain), gate, &source).expect("gate evidence")
}

/// The first four bytes of the revert data of a call, or `None` when the call succeeds.
pub fn revert_selector(chain: &TestChain, to: Address, data: &[u8]) -> Option<[u8; 4]> {
    let error = chain.call(to, data).err()?;
    let revert = error.revert_data().expect("a revert carries data");
    Some(revert[..4].try_into().unwrap())
}

/// The four-byte selector of a Solidity error signature.
pub fn error_selector(signature: &str) -> [u8; 4] {
    keccak256(signature)[..4].try_into().unwrap()
}

/// A deposit that the tests made on a source chain.
#[derive(Clone, Debug)]
pub struct MadeDeposit {
    pub receipt: serde_json::Value,
    /// The index of the deposit log inside the receipt.
    pub log_index: usize,
    pub nonce: B256,
    pub transaction_hash: B256,
    pub block_hash: B256,
    pub gas_used: u64,
}

/// The gas a receipt reports.
pub fn gas_used(receipt: &serde_json::Value) -> u64 {
    parse_quantity(&receipt["gasUsed"]).expect("gasUsed")
}

/// The indices (inside the receipt) of every deposit log of a receipt.
pub fn deposit_log_indices(receipt: &serde_json::Value) -> Vec<usize> {
    let topic = format!("{DEPOSIT_EVENT_TOPIC:#x}");
    receipt["logs"]
        .as_array()
        .unwrap()
        .iter()
        .enumerate()
        .filter(|(_, log)| log["topics"][0].as_str() == Some(topic.as_str()))
        .map(|(index, _)| index)
        .collect()
}

/// The nonce of the deposit log at `index` of a receipt.
pub fn deposit_nonce_at(receipt: &serde_json::Value, index: usize) -> B256 {
    let log = &receipt["logs"][index];
    let topics: Vec<B256> = log["topics"].as_array().unwrap().iter().map(|topic| topic.as_str().unwrap().parse().unwrap()).collect();
    let data = hex::decode(log["data"].as_str().unwrap()).unwrap();
    decode_deposit(&topics, &data).unwrap().nonce
}

/// Turns a receipt of a deposit transaction into a [`MadeDeposit`] for its first deposit log.
pub fn made_deposit(receipt: serde_json::Value) -> MadeDeposit {
    let log_index = deposit_log_indices(&receipt)[0];
    MadeDeposit {
        nonce: deposit_nonce_at(&receipt, log_index),
        transaction_hash: receipt["transactionHash"].as_str().unwrap().parse().unwrap(),
        block_hash: receipt["blockHash"].as_str().unwrap().parse().unwrap(),
        gas_used: gas_used(&receipt),
        log_index,
        receipt,
    }
}

/// Mints, approves and deposits a token on `chain` through `vault`, with gate evidence built for `gate`.
pub fn deposit_token(chain: &TestChain, vault: Address, gate: Address, token: Address, amount: u128) -> MadeDeposit {
    chain.send(Some(token), &TokenContract::mintCall { to: DEPLOYER, amount: U256::from(amount) }.abi_encode());
    chain.send(Some(token), &TokenContract::approveCall { spender: vault, amount: U256::from(amount) }.abi_encode());
    let evidence = gate_evidence(chain, gate);
    made_deposit(chain.send(Some(vault), &deposit_calldata(token, RECIPIENT, U256::from(amount), &evidence)))
}

/// Mints, approves and deposits on the source chain of a direction.
pub fn deposit_on(bridge: &Bridge, direction: Direction, amount: u128) -> MadeDeposit {
    deposit_token(bridge.source(direction), bridge.source_vault(direction), bridge.source_gate(direction), bridge.source_token(direction), amount)
}

/// Mints, approves and deposits on chain A. Returns the receipt and the index of the deposit log inside it.
pub fn deposit(bridge: &Bridge, amount: u128) -> (serde_json::Value, usize, B256) {
    let made = deposit_on(bridge, Direction::AToB, amount);
    (made.receipt, made.log_index, made.nonce)
}

/// The slots of every head that a light client stored, from its `HeadUpdated` events.
pub fn stored_head_slots(chain: &TestChain, light_client: Address) -> Vec<u64> {
    let client = client_of(chain);
    let latest = zk_bridge_prover::chain::ExecutionReader::latest_block_number(&client).unwrap();
    client
        .logs(light_client, head_updated_topic(), 0, latest)
        .unwrap()
        .iter()
        .map(|log| u64::from_be_bytes(log.topics[1][24..].try_into().unwrap()))
        .collect()
}

/// The gas of every light-client update on a chain, in order.
pub fn update_gas(chain: &TestChain, light_client: Address) -> Vec<u64> {
    let client = client_of(chain);
    let latest = zk_bridge_prover::chain::ExecutionReader::latest_block_number(&client).unwrap();
    client
        .logs(light_client, head_updated_topic(), 0, latest)
        .unwrap()
        .iter()
        .map(|log| gas_used(&client.transaction_receipt(log.transaction_hash).unwrap().unwrap()))
        .collect()
}

/// The calldata of `BridgeVault.withdraw` for the deposit log at `log_index` of `transaction`, built the way the
/// service builds it, but WITHOUT the native check that the service runs. A test uses it to send a withdrawal that the
/// service itself would refuse, so that the contract is the only defense that stands.
///
/// The light client of the destination must already cover the block (run `once` after a real deposit in the same
/// block), and the vault must hold the layout rows (the same `once` adds them).
pub fn unchecked_withdrawal_calldata(bridge: &Bridge, direction: Direction, transaction: B256, log_index: u64) -> Vec<u8> {
    let source = client_of(bridge.source(direction));
    let light_client = bridge.destination_light_client(direction);
    let receipt = source.transaction_receipt(transaction).unwrap().expect("receipt");
    let number = parse_quantity(&receipt["blockNumber"]).unwrap();
    let transaction_index = parse_quantity(&receipt["transactionIndex"]).unwrap();
    let block = source.block(number).unwrap().expect("block");
    let receipts = zk_bridge_prover::chain::ChainClient::block_receipts(&source, number, &block).unwrap();
    let execution = build_execution_evidence(&block, &receipts, transaction_index).expect("execution evidence");

    let state = read_light_client_state(bridge, direction);
    let stored = stored_head_slots(bridge.destination(direction), light_client);
    let beacon = DevBeaconSource::new(ChainKind::Pulsechain, 1, DEFAULT_SLOT_OFFSET);
    let deposit_block = DepositBlock { number, hash: execution.block_hash, timestamp: parse_quantity(&block["timestamp"]).unwrap() };
    let path = beacon.withdrawal_path(&deposit_block, &state, &stored, &source).expect("beacon path");
    withdrawal_calldata(&assemble_withdrawal_proof(&path, &execution, transaction_index, log_index))
}

/// Moves the clock of the chain so that the next block lies about 100 seconds into a gate epoch. A test that mines many
/// blocks calls it, so no epoch border falls between the evidence and the deposit.
pub fn settle_in_epoch(chain: &TestChain, gate: Address) {
    let genesis = GateContract::genesisTimeCall::abi_decode_returns(&chain.call(gate, &GateContract::genesisTimeCall {}.abi_encode()).unwrap()).unwrap();
    let offset = (chain.latest_timestamp() - genesis) % EPOCH_SECONDS;
    if !(20..=300).contains(&offset) {
        chain.advance_time((100 + EPOCH_SECONDS - offset) % EPOCH_SECONDS);
    }
}

/// `(epoch, exists)` of `confirmedEpoch()` of a gate.
pub fn confirmed_epoch(chain: &TestChain, gate: Address) -> (u64, bool) {
    let raw = chain.call(gate, &GateContract::confirmedEpochCall {}.abi_encode()).unwrap();
    let decoded = GateContract::confirmedEpochCall::abi_decode_returns(&raw).unwrap();
    (decoded.epoch, decoded.exists)
}

/// Whether a boolean view of a gate is true.
pub fn gate_flag(chain: &TestChain, gate: Address, call: &[u8]) -> bool {
    chain.call(gate, call).unwrap().last() == Some(&1)
}

/// `BeaconForkGate.enforcing()`.
pub fn gate_enforcing(chain: &TestChain, gate: Address) -> bool {
    gate_flag(chain, gate, &GateContract::enforcingCall {}.abi_encode())
}

/// `BeaconForkGate.isSealed()`.
pub fn gate_sealed(chain: &TestChain, gate: Address) -> bool {
    gate_flag(chain, gate, &GateContract::isSealedCall {}.abi_encode())
}

/// The calldata of `BeaconForkGate.seal(evidence)`.
pub fn seal_calldata(evidence: &[u8]) -> Vec<u8> {
    GateWrites::sealCall { evidence: evidence.to_vec().into() }.abi_encode()
}

/// Prints one measured number in a form that `cargo test -- --nocapture` shows and a reader can grep.
pub fn report_gas(label: &str, gas: u64) {
    println!("GAS {label}: {gas}");
}

/// Builds an [`OracleProver`] with the oracle key of the tests.
pub fn oracle_prover() -> OracleProver {
    OracleProver::new(deployer_signer())
}

/// The hash of the withdrawal transaction that `status` records for a deposit nonce.
pub fn withdrawal_transaction_of(bridge: &Bridge, nonce: B256) -> B256 {
    let status = run(bridge, &["status"]).unwrap();
    let prefix = format!("nonce={nonce:#x} ");
    let line = status.lines().find(|line| line.starts_with(&prefix)).unwrap_or_else(|| panic!("no status line for {nonce:#x}: {status}"));
    let hash = line.split("withdrawal_transaction=").nth(1).and_then(|rest| rest.split(' ').next()).expect("withdrawal_transaction field");
    hash.parse().unwrap_or_else(|_| panic!("the deposit has no withdrawal transaction yet: {line}"))
}

/// The state word of the `status` line of a deposit nonce, for example `confirmed`.
pub fn state_of(bridge: &Bridge, nonce: B256) -> String {
    let status = run(bridge, &["status"]).unwrap();
    let prefix = format!("nonce={nonce:#x} ");
    let line = status.lines().find(|line| line.starts_with(&prefix));
    line.and_then(|line| line.split("state=").nth(1)).and_then(|rest| rest.split(' ').next()).unwrap_or("absent").to_string()
}

/// The gas used by the withdrawal transaction of a deposit, read from the destination chain.
pub fn withdrawal_gas(bridge: &Bridge, direction: Direction, nonce: B256) -> u64 {
    let hash = withdrawal_transaction_of(bridge, nonce);
    let receipt = client_of(bridge.destination(direction)).transaction_receipt(hash).unwrap().expect("withdrawal receipt");
    assert_eq!(receipt["status"], "0x1");
    gas_used(&receipt)
}

/// What the destination light client of a direction stores, as the service reads it.
pub fn read_light_client_state(bridge: &Bridge, direction: Direction) -> LightClientState {
    let destination = client_of(bridge.destination(direction));
    let light_client = bridge.destination_light_client(direction);
    let head_slot = destination.view(light_client, LightClientContract::headCall {}).unwrap();
    let slots_per_period = destination.view(light_client, LightClientContract::slotsPerPeriodCall {}).unwrap();
    let period = head_slot / slots_per_period;
    LightClientState {
        head_slot,
        head_root: destination.view(light_client, LightClientContract::headersCall { slot: head_slot }).unwrap(),
        head_execution_hash: destination.view(light_client, LightClientContract::executionBlockHashesCall { slot: head_slot }).unwrap(),
        genesis_validators_root: destination.view(light_client, LightClientContract::genesisValidatorsRootCall {}).unwrap(),
        slots_per_period,
        head_committee_hash: destination.view(light_client, LightClientContract::syncCommitteesCall { period }).unwrap(),
        next_committee_hash: destination.view(light_client, LightClientContract::syncCommitteesCall { period: period + 1 }).unwrap(),
    }
}

/// The calldata of `BeaconLightClient.update` that the development source asserts for the first step toward a source
/// block, signed by the oracle. `tamper` may change the asserted output before it is signed, as a faulty or hostile
/// prover would. The oracle signature is valid for whatever the output says, so only the contract's own checks can
/// refuse a tampered output.
pub fn update_calldata_for_block(
    bridge: &Bridge,
    direction: Direction,
    block_number: u64,
    tamper: impl FnOnce(&mut zk_bridge_prover::light_client::LightClientOutput),
) -> Vec<u8> {
    use zk_bridge_prover::contracts::update_calldata;
    use zk_bridge_prover::beacon::UpdatePlan;
    use zk_bridge_prover::prover::{ProofStatement, Prover};
    let source = client_of(bridge.source(direction));
    let state = read_light_client_state(bridge, direction);
    let stored = stored_head_slots(bridge.destination(direction), bridge.destination_light_client(direction));
    let block = source.block(block_number).unwrap().expect("block");
    let deposit_block = DepositBlock {
        number: block_number,
        hash: block["hash"].as_str().unwrap().parse().unwrap(),
        timestamp: parse_quantity(&block["timestamp"]).unwrap(),
    };
    let beacon = DevBeaconSource::new(ChainKind::Pulsechain, 1, DEFAULT_SLOT_OFFSET);
    let UpdatePlan::Update(statement) = beacon.next_update(&deposit_block, &state, &stored, &source).expect("plan") else {
        panic!("the light client needs an update for block {block_number}");
    };
    let ProofStatement::DevAsserted(mut output) = *statement else { panic!("the development source asserts outputs") };
    tamper(&mut output);
    let vkey = keccak256(b"light-client-program");
    let proof = oracle_prover().prove(vkey, &ProofStatement::DevAsserted(output)).expect("oracle proof");
    update_calldata(&proof.proof_bytes, &proof.public_values).to_vec()
}
