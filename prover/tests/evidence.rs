//! The `evidence` command against a synthetic world: a signed beacon chain, a source chain with one deposit, and a
//! destination chain with a light client and a vault. The chains are JSON-RPC servers in this process.
//!
//! The execution block of the deposit is real in the way that matters: its header hashes to the block hash that the beacon
//! block commits to, its receipts root is the root of a real receipts trie, and the receipt holds a real `DepositInitiated`
//! log. So the withdrawal evidence that the command builds passes the native vault check of `lc-core`, which the builder
//! runs itself. The tests then read the calldata back and compare it with what they put in.

mod common;

use alloy_primitives::{hex, Address, B256, U256};
use alloy_sol_types::{SolCall, SolEvent};
use common::*;
use lc_core::abi::{withdrawCall, DepositInitiated};
use lc_core::json::{execution_header_from_json, receipts_from_json};
use lc_core::receipts::{build_receipts_trie, encode_execution_header, header_hash};
use serde_json::{json, Value};
use std::path::PathBuf;
use zk_bridge_prover::cli;
use zk_bridge_prover::contracts::{
    BlockHashEvidence, BodyLayoutRow, HistoricalLayoutRow, LightClientContract, StateLayoutRow,
    VaultContract,
};
use zk_bridge_prover::error::{Error, Result};
use zk_bridge_prover::evidence::WithdrawalEvidence;
use zk_bridge_prover::light_client::{verify_update_natively, ChainKind};
use zk_bridge_prover::local_network::signed_beacon::checkpoint::{read_checkpoint, Checkpoint};

const SOURCE_VAULT: Address = Address::repeat_byte(0xb1);
const DESTINATION_VAULT: Address = Address::repeat_byte(0xb2);
const LIGHT_CLIENT: Address = Address::repeat_byte(0xb3);
const OTHER_EMITTER: Address = Address::repeat_byte(0xc1);
const SOURCE_CHAIN_ID: u64 = 1;
const DESTINATION_CHAIN_ID: u64 = 369;
const SLOTS_PER_PERIOD: u64 = 8192;
/// The log that holds the deposit. Log 0 of the same receipt belongs to another contract.
const DEPOSIT_LOG_INDEX: u64 = 1;

fn quantity(value: u64) -> String {
    format!("{value:#x}")
}

fn zero_bloom() -> String {
    format!("0x{}", "00".repeat(256))
}

fn deposit_event() -> DepositInitiated {
    DepositInitiated {
        token: Address::repeat_byte(0x71),
        sender: Address::repeat_byte(0x72),
        recipient: Address::repeat_byte(0x73),
        amount: U256::from(1_500_000_000_000_000_000u64),
        nonce: B256::repeat_byte(0x74),
        targetChainId: DESTINATION_CHAIN_ID,
        destinationVault: DESTINATION_VAULT,
        destinationToken: Address::repeat_byte(0x75),
    }
}

/// The execution block that holds the deposit, with its receipt and its transaction hash.
struct DepositBlock {
    number: u64,
    block: Value,
    receipt: Value,
    transaction: B256,
}

fn deposit_block(number: u64, timestamp: u64) -> DepositBlock {
    let transaction = B256::repeat_byte(0xab);
    let block_hash_placeholder = format!("{:#x}", B256::ZERO);
    let log = |index: u64, address: Address, topics: Vec<B256>, data: Vec<u8>| {
        json!({
            "address": format!("{address:#x}"),
            "topics": topics.iter().map(|topic| format!("{topic:#x}")).collect::<Vec<_>>(),
            "data": hex::encode_prefixed(data),
            "blockNumber": quantity(number),
            "blockHash": block_hash_placeholder,
            "transactionHash": format!("{transaction:#x}"),
            "transactionIndex": "0x0",
            "logIndex": quantity(index),
        })
    };
    let event = deposit_event().encode_log_data();
    let mut receipt = json!({
        "type": "0x2",
        "status": "0x1",
        "cumulativeGasUsed": "0x5208",
        "logsBloom": zero_bloom(),
        "transactionHash": format!("{transaction:#x}"),
        "transactionIndex": "0x0",
        "blockNumber": quantity(number),
        "logs": [
            log(0, OTHER_EMITTER, vec![B256::repeat_byte(0x01)], vec![0x01]),
            log(1, SOURCE_VAULT, event.topics().to_vec(), event.data.to_vec()),
        ],
    });
    let receipts_root = build_receipts_trie(&receipts_from_json(&json!([receipt.clone()]))).root;
    let mut block = json!({
        "parentHash": format!("{:#x}", B256::repeat_byte(0x10)),
        "sha3Uncles": format!("{:#x}", B256::repeat_byte(0x11)),
        "miner": format!("{:#x}", Address::repeat_byte(0x0f)),
        "stateRoot": format!("{:#x}", B256::repeat_byte(0x12)),
        "transactionsRoot": format!("{:#x}", B256::repeat_byte(0x13)),
        "receiptsRoot": format!("{receipts_root:#x}"),
        "logsBloom": zero_bloom(),
        "difficulty": "0x0",
        "number": quantity(number),
        "gasLimit": quantity(30_000_000),
        "gasUsed": "0x5208",
        "timestamp": quantity(timestamp),
        "extraData": "0x",
        "mixHash": format!("{:#x}", B256::repeat_byte(0x14)),
        "nonce": "0x0000000000000000",
        "baseFeePerGas": "0x7",
        "transactions": [format!("{transaction:#x}")],
    });
    let hash = header_hash(&encode_execution_header(&execution_header_from_json(
        &block,
    )));
    block["hash"] = json!(format!("{hash:#x}"));
    // The logs of the receipt name the block hash that they sit in.
    for entry in receipt["logs"].as_array_mut().unwrap() {
        entry["blockHash"] = json!(format!("{hash:#x}"));
    }
    receipt["blockHash"] = json!(format!("{hash:#x}"));
    DepositBlock {
        number,
        block,
        receipt,
        transaction,
    }
}

/// The world: a beacon chain that finalized past the deposit, a light client that stores a head after the deposit, and the
/// source chain that holds the deposit.
struct World {
    checkpoint: Checkpoint,
    anchor_slot: u64,
    anchor_root: B256,
    deposit_slot: u64,
    deposit: DepositBlock,
    beacon_url: String,
    source_url: String,
    // The chain must outlive the server threads that answer for it.
    _chain: Chain,
}

fn world() -> World {
    let kind = ChainKind::Pulsechain;
    let chain = Chain::new(kind, BLOCKS_BEFORE_CHECKPOINT);
    let checkpoint = read_checkpoint(&chain.node, kind).expect("checkpoint");
    let number = BLOCKS_BEFORE_CHECKPOINT + 3;
    let timestamp = payload(number, kind.seconds_per_slot()).timestamp;
    let deposit = deposit_block(number, timestamp);
    let hash: B256 = deposit.block["hash"].as_str().unwrap().parse().unwrap();
    let receipts_root: B256 = deposit.block["receiptsRoot"]
        .as_str()
        .unwrap()
        .parse()
        .unwrap();
    chain.mine(2);
    chain.mine_custom(|payload| {
        payload.block_hash = hash;
        payload.receipts_root = receipts_root;
    });
    chain.mine(12);

    let plan = chain
        .source()
        .plan_update(&head_at(&checkpoint))
        .unwrap()
        .expect("the light client lags");
    let output = verify_update_natively(&plan.input).unwrap();
    let deposit_slot = chain.first_slot() + number - 1;
    assert!(
        output.newHeadSlot > deposit_slot,
        "the new head covers the deposit"
    );

    let beacon_url = serve_beacon(&chain);
    let source_url = serve_source(&deposit);
    World {
        checkpoint,
        anchor_slot: output.newHeadSlot,
        anchor_root: output.newHeaderRoot,
        deposit_slot,
        deposit,
        beacon_url,
        source_url,
        _chain: chain,
    }
}

fn serve_source(deposit: &DepositBlock) -> String {
    let number = deposit.number;
    let (block, receipt, transaction) = (
        deposit.block.clone(),
        deposit.receipt.clone(),
        deposit.transaction,
    );
    serve_rpc(move |call| match call["method"].as_str().unwrap() {
        "eth_chainId" => json!(quantity(SOURCE_CHAIN_ID)),
        "eth_getTransactionReceipt" if call["params"][0] == json!(format!("{transaction:#x}")) => {
            receipt.clone()
        }
        "eth_getBlockByNumber" if call["params"][0] == json!(quantity(number)) => block.clone(),
        "eth_getBlockReceipts" => json!([receipt.clone()]),
        _ => Value::Null,
    })
}

/// What the destination chain answers about its vault.
#[derive(Clone)]
struct DestinationState {
    state_rows: Vec<StateLayoutRow>,
    body_rows: Vec<BodyLayoutRow>,
    historical_rows: Vec<HistoricalLayoutRow>,
    claimed: bool,
    remote_vault: Address,
}

impl DestinationState {
    /// A vault that has every layout row it needs and has paid nothing.
    fn complete() -> Self {
        Self {
            state_rows: vec![StateLayoutRow {
                blockRootsGindex: U256::from(1),
                firstSlot: 0,
                lastSlot: u64::MAX,
            }],
            body_rows: vec![BodyLayoutRow {
                blockHashGindex: U256::from(1),
                firstSlot: 0,
                lastSlot: u64::MAX,
            }],
            historical_rows: vec![],
            claimed: false,
            remote_vault: SOURCE_VAULT,
        }
    }
}

fn serve_destination(world: &World, state: DestinationState) -> String {
    let stored = [
        (world.checkpoint.slot, world.checkpoint.header_root),
        (world.anchor_slot, world.anchor_root),
    ];
    let anchor_slot = world.anchor_slot;
    let genesis = world.checkpoint.genesis_validators_root;
    serve_rpc(move |call| {
        let method = call["method"].as_str().unwrap();
        if method == "eth_chainId" {
            return json!(quantity(DESTINATION_CHAIN_ID));
        }
        if method == "eth_blockNumber" {
            return json!("0x64");
        }
        if method == "eth_getLogs" {
            return head_updated_logs(call, &stored);
        }
        assert_eq!(method, "eth_call");
        let data = hex::decode(call["params"][0]["data"].as_str().unwrap()).unwrap();
        let selector: [u8; 4] = data[..4].try_into().unwrap();
        let encoded = match selector {
            LightClientContract::headCall::SELECTOR => {
                LightClientContract::headCall::abi_encode_returns(&anchor_slot)
            }
            LightClientContract::slotsPerPeriodCall::SELECTOR => {
                LightClientContract::slotsPerPeriodCall::abi_encode_returns(&SLOTS_PER_PERIOD)
            }
            LightClientContract::headersCall::SELECTOR => {
                let asked = LightClientContract::headersCall::abi_decode(&data).unwrap();
                let root = stored
                    .iter()
                    .find(|(slot, _)| *slot == asked.slot)
                    .map_or(B256::ZERO, |(_, root)| *root);
                LightClientContract::headersCall::abi_encode_returns(&root)
            }
            LightClientContract::syncCommitteesCall::SELECTOR => {
                LightClientContract::syncCommitteesCall::abi_encode_returns(&B256::repeat_byte(
                    0x05,
                ))
            }
            LightClientContract::genesisValidatorsRootCall::SELECTOR => {
                LightClientContract::genesisValidatorsRootCall::abi_encode_returns(&genesis)
            }
            LightClientContract::programVKeyCall::SELECTOR => {
                LightClientContract::programVKeyCall::abi_encode_returns(&B256::repeat_byte(0x99))
            }
            VaultContract::remoteVaultCall::SELECTOR => {
                VaultContract::remoteVaultCall::abi_encode_returns(&state.remote_vault)
            }
            VaultContract::remoteChainIdCall::SELECTOR => {
                VaultContract::remoteChainIdCall::abi_encode_returns(&SOURCE_CHAIN_ID)
            }
            VaultContract::localChainIdCall::SELECTOR => {
                VaultContract::localChainIdCall::abi_encode_returns(&DESTINATION_CHAIN_ID)
            }
            VaultContract::lightClientCall::SELECTOR => {
                VaultContract::lightClientCall::abi_encode_returns(&LIGHT_CLIENT)
            }
            VaultContract::claimedCall::SELECTOR => {
                VaultContract::claimedCall::abi_encode_returns(&state.claimed)
            }
            VaultContract::stateLayoutsCall::SELECTOR => {
                VaultContract::stateLayoutsCall::abi_encode_returns(&state.state_rows)
            }
            VaultContract::bodyLayoutsCall::SELECTOR => {
                VaultContract::bodyLayoutsCall::abi_encode_returns(&state.body_rows)
            }
            VaultContract::historicalLayoutsCall::SELECTOR => {
                VaultContract::historicalLayoutsCall::abi_encode_returns(&state.historical_rows)
            }
            other => panic!("unexpected call {other:?}"),
        };
        json!(hex::encode_prefixed(encoded))
    })
}

/// The `HeadUpdated` events of the light client, all in the first page of the scan.
fn head_updated_logs(call: &Value, stored: &[(u64, B256)]) -> Value {
    if call["params"][0]["fromBlock"] != json!("0x0") {
        return json!([]);
    }
    let logs: Vec<Value> = stored
        .iter()
        .map(|(slot, root)| {
            json!({
                "address": format!("{LIGHT_CLIENT:#x}"),
                "topics": [
                    format!("{:#x}", zk_bridge_prover::contracts::head_updated_topic()),
                    format!("{:#x}", B256::from(U256::from(*slot))),
                    format!("{root:#x}"),
                    format!("{:#x}", B256::repeat_byte(0x06)),
                ],
                "data": "0x",
                "blockNumber": "0x3",
                "blockHash": format!("{:#x}", B256::repeat_byte(0x07)),
                "transactionHash": format!("{:#x}", B256::repeat_byte(0x08)),
                "transactionIndex": "0x0",
                "logIndex": "0x0",
            })
        })
        .collect();
    json!(logs)
}

struct Scratch(PathBuf);

impl Drop for Scratch {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.0);
    }
}

/// Runs `evidence` with a configuration for this world. `arguments` follow `evidence`.
fn run_evidence(
    world: &World,
    destination_url: &str,
    arguments: &[String],
) -> (Result<i32>, Vec<u8>) {
    let label = format!(
        "evidence-{}-{}",
        std::process::id(),
        destination_url.rsplit(':').next().unwrap()
    );
    let scratch = Scratch(std::env::temp_dir().join(label));
    std::fs::create_dir_all(&scratch.0).unwrap();
    let config = scratch.0.join("prover.toml");
    std::fs::write(
        &config,
        format!(
            r#"
[routes.ethereum_to_pulsechain.source]
chain_id = {SOURCE_CHAIN_ID}
chain = "pulsechain"
beacon_url = "{}"
rpc_url = "{}"
vault = "{SOURCE_VAULT:#x}"

[routes.ethereum_to_pulsechain.destination]
chain_id = {DESTINATION_CHAIN_ID}
rpc_url = "{destination_url}"
light_client = "{LIGHT_CLIENT:#x}"
vault = "{DESTINATION_VAULT:#x}"
"#,
            world.beacon_url, world.source_url
        ),
    )
    .unwrap();
    let mut all: Vec<String> = [
        "zk-bridge-prover".to_string(),
        "--config".to_string(),
        config.display().to_string(),
        "evidence".to_string(),
    ]
    .into();
    all.extend_from_slice(arguments);
    let mut out = Vec::new();
    let outcome = cli::run(all, &|_| None, &mut out);
    (outcome, out)
}

fn deposit_arguments(world: &World, log_index: u64) -> Vec<String> {
    vec![
        "--tx".into(),
        format!("{:#x}", world.deposit.transaction),
        "--log-index".into(),
        log_index.to_string(),
    ]
}

fn build(world: &World, state: DestinationState, log_index: u64) -> Result<WithdrawalEvidence> {
    let destination = serve_destination(world, state);
    let (outcome, out) = run_evidence(world, &destination, &deposit_arguments(world, log_index));
    assert_eq!(outcome?, 0);
    assert_eq!(
        out.iter().filter(|byte| **byte == b'\n').count(),
        1,
        "one line"
    );
    Ok(serde_json::from_slice(&out).expect("evidence JSON"))
}

/// Claim: for a deposit that the stored anchor covers, the command prints evidence that names the deposit, the anchor and
/// the destination exactly, with withdraw calldata that carries the log index and the transaction index of the deposit and
/// the two headers of the beacon path. A vault that has every row needs no prerequisite. The evidence needs no `[prover]`
/// section and no key.
/// Why it matters: a stateful server sends this calldata as it is. Every field it reads must describe the deposit that the
/// vault will pay.
#[test]
fn the_evidence_names_the_deposit_and_carries_the_withdraw_calldata() {
    let world = world();
    let evidence =
        build(&world, DestinationState::complete(), DEPOSIT_LOG_INDEX).expect("evidence");
    let event = deposit_event();

    assert_eq!(evidence.route, "ethereum_to_pulsechain");
    assert_eq!(
        evidence.source_transaction_hash,
        format!("{:#x}", world.deposit.transaction)
    );
    assert_eq!(evidence.log_index, DEPOSIT_LOG_INDEX);
    assert_eq!(evidence.deposit.nonce, format!("{:#x}", event.nonce));
    assert_eq!(evidence.deposit.token, format!("{:#x}", event.token));
    assert_eq!(evidence.deposit.sender, format!("{:#x}", event.sender));
    assert_eq!(
        evidence.deposit.recipient,
        format!("{:#x}", event.recipient)
    );
    assert_eq!(evidence.deposit.amount, "1500000000000000000");
    assert_eq!(evidence.deposit.source_block_number, world.deposit.number);
    assert_eq!(
        evidence.deposit.source_block_hash,
        world.deposit.block["hash"].as_str().unwrap()
    );
    assert_eq!(evidence.deposit.deposit_slot, world.deposit_slot);
    assert_eq!(evidence.destination.chain_id, DESTINATION_CHAIN_ID);
    assert_eq!(
        evidence.destination.vault,
        format!("{DESTINATION_VAULT:#x}")
    );
    assert_eq!(
        evidence.destination.light_client,
        format!("{LIGHT_CLIENT:#x}")
    );
    assert_eq!(evidence.anchor.slot, world.anchor_slot);
    assert_eq!(evidence.anchor.root, format!("{:#x}", world.anchor_root));
    assert!(!evidence.already_claimed);
    assert!(evidence.prerequisites.is_empty());

    assert_eq!(evidence.withdraw.to, format!("{DESTINATION_VAULT:#x}"));
    let calldata = hex::decode(&evidence.withdraw.data).unwrap();
    let call = withdrawCall::abi_decode(&calldata).expect("a withdraw call");
    assert_eq!(call.proof.logIndex, U256::from(DEPOSIT_LOG_INDEX));
    assert_eq!(call.proof.transactionIndex, U256::ZERO);
    assert_eq!(call.proof.anchorHeader.slot, world.anchor_slot);
    assert_eq!(call.proof.depositHeader.slot, world.deposit_slot);
}

/// Claim: a deposit that the vault already paid is reported as claimed, and the rest of the evidence is unchanged.
/// Why it matters: a server that sends the withdrawal of a paid deposit wastes gas on a revert.
#[test]
fn a_paid_deposit_is_reported_as_claimed() {
    let world = world();
    let state = DestinationState {
        claimed: true,
        ..DestinationState::complete()
    };
    assert!(
        build(&world, state, DEPOSIT_LOG_INDEX)
            .unwrap()
            .already_claimed
    );
}

/// Claim: when the vault lacks a block hash row, the evidence lists a call for each stored header that can supply it, and
/// each call carries a branch that fits the body root of its header. The first call uses the stored header at or below the
/// deposit slot, the second the stored header at or below the anchor.
/// Why it matters: the vault validates the row against the branch. A wrong generalized index or branch reverts the call and
/// leaves the withdrawal stuck.
#[test]
fn missing_block_hash_rows_become_layout_calls_that_fit_their_headers() {
    let world = world();
    let state = DestinationState {
        body_rows: vec![],
        ..DestinationState::complete()
    };
    let evidence = build(&world, state, DEPOSIT_LOG_INDEX).expect("evidence");
    assert_eq!(evidence.prerequisites.len(), 2);
    let mut header_slots = Vec::new();
    for prerequisite in &evidence.prerequisites {
        assert_eq!(prerequisite.function, "addBlockHashLayout");
        assert_eq!(prerequisite.call.to, format!("{DESTINATION_VAULT:#x}"));
        let calldata = hex::decode(&prerequisite.call.data).unwrap();
        let call =
            VaultContract::addBlockHashLayoutCall::abi_decode(&calldata).expect("a layout call");
        let BlockHashEvidence { header, branch } = call.evidence;
        assert!(lc_core::ssz::is_valid_exact_branch(
            &block_hash_at_slot(header.slot),
            &branch,
            u64::try_from(call.blockHashGindex).unwrap(),
            &header.bodyRoot,
        ));
        header_slots.push(header.slot);
    }
    assert_eq!(header_slots, vec![world.checkpoint.slot, world.anchor_slot]);
}

/// The execution block hash that the synthetic chain holds at a beacon slot. Neither the checkpoint slot nor the anchor
/// slot is the deposit block, so the hash is the default one.
fn block_hash_at_slot(slot: u64) -> B256 {
    let first_slot = zk_bridge_prover::local_network::signed_beacon::node::default_first_slot(
        ChainKind::Pulsechain,
    );
    execution_hash(slot - first_slot + 1)
}

/// Claim: when the vault lacks a row and the light client stored too few heads to validate it, the command fails with the
/// reason, and prints nothing.
/// Why it matters: a partial answer would send the server into a withdrawal that cannot succeed.
#[test]
fn rows_that_cannot_be_validated_yet_stop_the_command() {
    let world = world();
    let state = DestinationState {
        state_rows: vec![],
        ..DestinationState::complete()
    };
    let destination = serve_destination(&world, state);
    let (outcome, out) = run_evidence(
        &world,
        &destination,
        &deposit_arguments(&world, DEPOSIT_LOG_INDEX),
    );
    let error = outcome.unwrap_err().to_string();
    assert!(error.contains("not enough stored headers"), "{error}");
    assert!(out.is_empty());
}

/// Claim: each wrong input stops the command with an error that names the cause: a log of another contract, a log index
/// beyond the receipt, a vault that points at another source vault, a header that the light client does not store, and an
/// anchor that does not lie after the deposit.
/// Why it matters: a name is a hypothesis. Each of these would otherwise build evidence for the wrong deposit, or evidence
/// that the vault must refuse.
#[test]
fn wrong_inputs_are_refused_with_their_cause() {
    let world = world();
    let complete = serve_destination(&world, DestinationState::complete());

    let (outcome, out) = run_evidence(&world, &complete, &deposit_arguments(&world, 0));
    let error = outcome.unwrap_err();
    assert!(matches!(error, Error::Usage(_)), "{error}");
    assert!(
        error.to_string().contains("not from the source vault"),
        "{error}"
    );
    assert!(out.is_empty());

    let (outcome, _) = run_evidence(&world, &complete, &deposit_arguments(&world, 9));
    assert!(outcome
        .unwrap_err()
        .to_string()
        .contains("no log at index 9"));

    let foreign = serve_destination(
        &world,
        DestinationState {
            remote_vault: Address::repeat_byte(0xee),
            ..DestinationState::complete()
        },
    );
    let (outcome, _) = run_evidence(
        &world,
        &foreign,
        &deposit_arguments(&world, DEPOSIT_LOG_INDEX),
    );
    let error = outcome.unwrap_err();
    assert!(matches!(error, Error::Config(_)), "{error}");
    assert!(error.to_string().contains("remoteVault"), "{error}");

    let mut unknown_anchor = deposit_arguments(&world, DEPOSIT_LOG_INDEX);
    unknown_anchor.extend(["--anchor-slot".to_string(), "5".to_string()]);
    let (outcome, _) = run_evidence(&world, &complete, &unknown_anchor);
    assert!(outcome
        .unwrap_err()
        .to_string()
        .contains("stores no header at slot 5"));

    let mut early_anchor = deposit_arguments(&world, DEPOSIT_LOG_INDEX);
    early_anchor.extend([
        "--anchor-slot".to_string(),
        world.checkpoint.slot.to_string(),
    ]);
    let (outcome, _) = run_evidence(&world, &complete, &early_anchor);
    assert!(
        outcome
            .unwrap_err()
            .to_string()
            .contains("is not before the anchor slot"),
        "an anchor below the deposit cannot cover it"
    );
}
