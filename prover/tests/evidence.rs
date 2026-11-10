//! The `evidence` command against a synthetic world: a signed beacon chain, a source chain with one message, and a
//! destination chain with a light client and a message bridge. The chains are JSON-RPC servers in this process.
//!
//! The execution block of the message is real in the way that matters: its header hashes to the block hash that the beacon
//! block commits to, its receipts root and its transactions root are the roots of real tries, and the receipt holds a real
//! `UserRequestForAffirmation` log. So the evidence that the command builds passes the native bridge check of `lc-core`,
//! which the builder runs itself. The tests then read the calldata back, run the check again with their own context, and
//! compare the result with what they put in.

mod common;

use alloy_primitives::{hex, keccak256, Address, Bytes, B256, U256};
use alloy_sol_types::SolCall;
use common::*;
use lc_core::abi::executeMessageCall;
use lc_core::json::{execution_header_from_json, receipts_from_json};
use lc_core::message::{message_id_for, verify_message, MessageContext};
use lc_core::receipts::{build_indexed_trie, encode_execution_header, header_hash};
use lc_testkit::synthetic::{message_log, synthetic_transaction, MessageFields};
use serde_json::{json, Value};
use std::path::PathBuf;
use zk_bridge_prover::cli;
use zk_bridge_prover::contracts::{
    BlockHashEvidence, BodyLayoutRow, HistoricalLayoutRow, LightClientContract,
    MessageBridgeContract, StateLayoutRow,
};
use zk_bridge_prover::error::{Error, Result};
use zk_bridge_prover::evidence::{DeliveryStatus, MessageEvidence};
use zk_bridge_prover::light_client::{verify_update_natively, ChainKind};
use zk_bridge_prover::local_network::signed_beacon::checkpoint::{read_checkpoint, Checkpoint};

const SOURCE_BRIDGE: Address = Address::repeat_byte(0xb1);
const DESTINATION_BRIDGE: Address = Address::repeat_byte(0xb2);
const LIGHT_CLIENT: Address = Address::repeat_byte(0xb3);
const OTHER_EMITTER: Address = Address::repeat_byte(0xc1);
const SOURCE_CHAIN_ID: u64 = 1;
const DESTINATION_CHAIN_ID: u64 = 369;
const SLOTS_PER_PERIOD: u64 = 8192;
/// The transaction that sends the message. It is the second transaction of its block, so the index of the receipt and the
/// index of the transaction are 1 and not 0.
const MESSAGE_TRANSACTION_INDEX: u64 = 1;
/// The log that holds the message. Log 0 of the same receipt belongs to another contract.
const MESSAGE_LOG_INDEX: u64 = 1;

fn quantity(value: u64) -> String {
    format!("{value:#x}")
}

fn zero_bloom() -> String {
    format!("0x{}", "00".repeat(256))
}

/// The honest fields of the message of the world, sent by the source bridge for the destination chain.
fn message_fields() -> MessageFields {
    MessageFields {
        message_id: message_id_for(SOURCE_CHAIN_ID, SOURCE_BRIDGE, 5),
        sender: Address::repeat_byte(0x72),
        executor: Address::repeat_byte(0x73),
        gas_limit: 250_000,
        data_type: 0,
        source_chain_id: SOURCE_CHAIN_ID,
        destination_chain_id: DESTINATION_CHAIN_ID,
        data: Bytes::from_static(&[0xab, 0xcd, 0xef]),
    }
}

/// The execution block that holds the message, with its receipts and its raw transactions.
struct SourceBlock {
    number: u64,
    block: Value,
    receipts: Vec<Value>,
    /// The raw bytes of each transaction, in block order.
    raw_transactions: Vec<Bytes>,
    transaction: B256,
}

fn source_block(number: u64, timestamp: u64, fields: &MessageFields) -> SourceBlock {
    let raw_transactions: Vec<Bytes> = (0..2).map(synthetic_transaction).collect();
    let transaction_hashes: Vec<B256> = raw_transactions.iter().map(keccak256).collect();
    let transaction = transaction_hashes[MESSAGE_TRANSACTION_INDEX as usize];
    let block_hash_placeholder = format!("{:#x}", B256::ZERO);
    let log = |index: u64, address: Address, topics: Vec<B256>, data: Vec<u8>| {
        json!({
            "address": format!("{address:#x}"),
            "topics": topics.iter().map(|topic| format!("{topic:#x}")).collect::<Vec<_>>(),
            "data": hex::encode_prefixed(data),
            "blockNumber": quantity(number),
            "blockHash": block_hash_placeholder,
            "transactionHash": format!("{transaction:#x}"),
            "transactionIndex": quantity(MESSAGE_TRANSACTION_INDEX),
            "logIndex": quantity(index),
        })
    };
    let event = message_log(SOURCE_BRIDGE, fields);
    let receipt = |index: u64, logs: Vec<Value>| {
        json!({
            "type": "0x2",
            "status": "0x1",
            "cumulativeGasUsed": quantity(21_000 * (index + 1)),
            "logsBloom": zero_bloom(),
            "transactionHash": format!("{:#x}", transaction_hashes[index as usize]),
            "transactionIndex": quantity(index),
            "blockNumber": quantity(number),
            "logs": logs,
        })
    };
    let mut receipts = vec![
        receipt(0, vec![]),
        receipt(
            1,
            vec![
                log(0, OTHER_EMITTER, vec![B256::repeat_byte(0x01)], vec![0x01]),
                log(1, SOURCE_BRIDGE, event.topics, event.data.to_vec()),
            ],
        ),
    ];
    let receipts_root =
        build_indexed_trie(&receipts_from_json(&Value::Array(receipts.clone()))).root;
    let transactions_root = build_indexed_trie(&raw_transactions).root;
    let mut block = json!({
        "parentHash": format!("{:#x}", B256::repeat_byte(0x10)),
        "sha3Uncles": format!("{:#x}", B256::repeat_byte(0x11)),
        "miner": format!("{:#x}", Address::repeat_byte(0x0f)),
        "stateRoot": format!("{:#x}", B256::repeat_byte(0x12)),
        "transactionsRoot": format!("{transactions_root:#x}"),
        "receiptsRoot": format!("{receipts_root:#x}"),
        "logsBloom": zero_bloom(),
        "difficulty": "0x0",
        "number": quantity(number),
        "gasLimit": quantity(30_000_000),
        "gasUsed": "0xa410",
        "timestamp": quantity(timestamp),
        "extraData": "0x",
        "mixHash": format!("{:#x}", B256::repeat_byte(0x14)),
        "nonce": "0x0000000000000000",
        "baseFeePerGas": "0x7",
        "transactions": transaction_hashes.iter().map(|hash| format!("{hash:#x}")).collect::<Vec<_>>(),
    });
    let hash = header_hash(&encode_execution_header(&execution_header_from_json(
        &block,
    )));
    block["hash"] = json!(format!("{hash:#x}"));
    // The logs of the receipts name the block hash that they sit in.
    for receipt in &mut receipts {
        receipt["blockHash"] = json!(format!("{hash:#x}"));
        for entry in receipt["logs"].as_array_mut().unwrap() {
            entry["blockHash"] = json!(format!("{hash:#x}"));
        }
    }
    SourceBlock {
        number,
        block,
        receipts,
        raw_transactions,
        transaction,
    }
}

/// The world: a beacon chain that finalized past the message, a light client that stores a head after the message, and the
/// source chain that holds the message.
struct World {
    checkpoint: Checkpoint,
    anchor_slot: u64,
    anchor_root: B256,
    source_slot: u64,
    source: SourceBlock,
    beacon_url: String,
    source_url: String,
    // The chain must outlive the server threads that answer for it.
    _chain: Chain,
}

fn world() -> World {
    world_for(&message_fields())
}

fn world_for(fields: &MessageFields) -> World {
    let kind = ChainKind::Pulsechain;
    let chain = Chain::new(kind, BLOCKS_BEFORE_CHECKPOINT);
    let checkpoint = read_checkpoint(&chain.node, kind).expect("checkpoint");
    let number = BLOCKS_BEFORE_CHECKPOINT + 3;
    let timestamp = payload(number, kind.seconds_per_slot()).timestamp;
    let source = source_block(number, timestamp, fields);
    let hash: B256 = source.block["hash"].as_str().unwrap().parse().unwrap();
    let receipts_root: B256 = source.block["receiptsRoot"]
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
    let source_slot = chain.first_slot() + number - 1;
    assert!(
        output.newHeadSlot > source_slot,
        "the new head covers the source block"
    );

    let beacon_url = serve_beacon(&chain);
    let source_url = serve_source(&source, SourceNode::Complete);
    World {
        checkpoint,
        anchor_slot: output.newHeadSlot,
        anchor_root: output.newHeaderRoot,
        source_slot,
        source,
        beacon_url,
        source_url,
        _chain: chain,
    }
}

/// How the source node answers for the raw bytes of transactions.
#[derive(Clone, Copy, PartialEq, Eq)]
enum SourceNode {
    /// It serves the right bytes.
    Complete,
    /// It serves the bytes of the first transaction for every hash.
    WrongBytes,
    /// It lacks `eth_getRawTransactionByHash`.
    NoRawTransactions,
}

fn serve_source(source: &SourceBlock, node: SourceNode) -> String {
    let number = source.number;
    let (block, receipts, transaction) = (
        source.block.clone(),
        source.receipts.clone(),
        source.transaction,
    );
    let raw_by_hash: Vec<(String, Bytes)> = source
        .raw_transactions
        .iter()
        .map(|raw| (format!("{:#x}", keccak256(raw)), raw.clone()))
        .collect();
    serve_rpc(move |call| match call["method"].as_str().unwrap() {
        "eth_chainId" => json!(quantity(SOURCE_CHAIN_ID)),
        "eth_getTransactionReceipt" if call["params"][0] == json!(format!("{transaction:#x}")) => {
            receipts[MESSAGE_TRANSACTION_INDEX as usize].clone()
        }
        "eth_getBlockByNumber" if call["params"][0] == json!(quantity(number)) => block.clone(),
        "eth_getBlockReceipts" => json!(receipts.clone()),
        "eth_getRawTransactionByHash" if node == SourceNode::WrongBytes => {
            json!(hex::encode_prefixed(&raw_by_hash[0].1))
        }
        "eth_getRawTransactionByHash" if node == SourceNode::Complete => raw_by_hash
            .iter()
            .find(|(hash, _)| call["params"][0] == json!(hash))
            .map_or(Value::Null, |(_, raw)| json!(hex::encode_prefixed(raw))),
        _ => Value::Null,
    })
}

/// What the destination chain answers about its bridge.
#[derive(Clone)]
struct DestinationState {
    state_rows: Vec<StateLayoutRow>,
    body_rows: Vec<BodyLayoutRow>,
    historical_rows: Vec<HistoricalLayoutRow>,
    delivery: DeliveryStatus,
    remote_bridge: Address,
}

impl DestinationState {
    /// A bridge that has every layout row it needs and has delivered nothing.
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
            delivery: DeliveryStatus::NotDelivered,
            remote_bridge: SOURCE_BRIDGE,
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
            MessageBridgeContract::remoteBridgeCall::SELECTOR => {
                MessageBridgeContract::remoteBridgeCall::abi_encode_returns(&state.remote_bridge)
            }
            MessageBridgeContract::remoteChainIdCall::SELECTOR => {
                MessageBridgeContract::remoteChainIdCall::abi_encode_returns(&SOURCE_CHAIN_ID)
            }
            MessageBridgeContract::localChainIdCall::SELECTOR => {
                MessageBridgeContract::localChainIdCall::abi_encode_returns(&DESTINATION_CHAIN_ID)
            }
            MessageBridgeContract::lightClientCall::SELECTOR => {
                MessageBridgeContract::lightClientCall::abi_encode_returns(&LIGHT_CLIENT)
            }
            MessageBridgeContract::messageCallStatusCall::SELECTOR => {
                MessageBridgeContract::messageCallStatusCall::abi_encode_returns(
                    &(state.delivery == DeliveryStatus::Succeeded),
                )
            }
            MessageBridgeContract::failedMessageDataHashCall::SELECTOR => {
                // The bridge keeps no failure record: a failed delivery reverts. The view always answers zero.
                MessageBridgeContract::failedMessageDataHashCall::abi_encode_returns(&B256::ZERO)
            }
            MessageBridgeContract::stateLayoutsCall::SELECTOR => {
                MessageBridgeContract::stateLayoutsCall::abi_encode_returns(&state.state_rows)
            }
            MessageBridgeContract::bodyLayoutsCall::SELECTOR => {
                MessageBridgeContract::bodyLayoutsCall::abi_encode_returns(&state.body_rows)
            }
            MessageBridgeContract::historicalLayoutsCall::SELECTOR => {
                MessageBridgeContract::historicalLayoutsCall::abi_encode_returns(
                    &state.historical_rows,
                )
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
    source_url: &str,
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
rpc_url = "{source_url}"
bridge = "{SOURCE_BRIDGE:#x}"

[routes.ethereum_to_pulsechain.destination]
chain_id = {DESTINATION_CHAIN_ID}
rpc_url = "{destination_url}"
light_client = "{LIGHT_CLIENT:#x}"
bridge = "{DESTINATION_BRIDGE:#x}"
"#,
            world.beacon_url
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

/// Runs `evidence` against the complete source node of the world.
fn run(world: &World, destination_url: &str, arguments: &[String]) -> (Result<i32>, Vec<u8>) {
    run_evidence(world, &world.source_url, destination_url, arguments)
}

fn message_arguments(world: &World, log_index: u64) -> Vec<String> {
    vec![
        "--tx".into(),
        format!("{:#x}", world.source.transaction),
        "--log-index".into(),
        log_index.to_string(),
    ]
}

fn build(world: &World, state: DestinationState, log_index: u64) -> Result<MessageEvidence> {
    let destination = serve_destination(world, state);
    let (outcome, out) = run(world, &destination, &message_arguments(world, log_index));
    assert_eq!(outcome?, 0);
    assert_eq!(
        out.iter().filter(|byte| **byte == b'\n').count(),
        1,
        "one line"
    );
    Ok(serde_json::from_slice(&out).expect("evidence JSON"))
}

/// Claim: for a message that the stored anchor covers, the command prints evidence that names the message, the anchor and
/// the destination exactly, with `executeMessage` calldata that carries the log index and the index of the transaction (the
/// receipt and the transaction share index 1) and the two headers of the beacon path. The calldata passes the reference
/// check of `lc-core` under a context that the test builds on its own, and the check returns the hash of the transaction
/// that was asked for. A bridge that has every row needs no prerequisite. The evidence needs no `[prover]` section and no key.
/// Why it matters: a stateful server sends this calldata as it is. Every field it reads must describe the message that the
/// bridge will execute, and the transaction hash that the target reads must be the hash of the sending transaction.
#[test]
fn the_evidence_names_the_message_and_carries_the_execute_calldata() {
    let world = world();
    let evidence =
        build(&world, DestinationState::complete(), MESSAGE_LOG_INDEX).expect("evidence");
    let fields = message_fields();

    assert_eq!(evidence.route, "ethereum_to_pulsechain");
    assert_eq!(
        evidence.source_transaction_hash,
        format!("{:#x}", world.source.transaction)
    );
    assert_eq!(evidence.log_index, MESSAGE_LOG_INDEX);
    assert_eq!(
        evidence.message.message_id,
        format!("{:#x}", fields.message_id)
    );
    assert_eq!(evidence.message.sender, format!("{:#x}", fields.sender));
    assert_eq!(evidence.message.executor, format!("{:#x}", fields.executor));
    assert_eq!(evidence.message.gas_limit, 250_000);
    assert_eq!(evidence.message.data_type, 0);
    assert_eq!(evidence.message.data, "0xabcdef");
    assert_eq!(evidence.message.source_block_number, world.source.number);
    assert_eq!(
        evidence.message.source_block_hash,
        world.source.block["hash"].as_str().unwrap()
    );
    assert_eq!(evidence.message.source_slot, world.source_slot);
    assert_eq!(evidence.destination.chain_id, DESTINATION_CHAIN_ID);
    assert_eq!(
        evidence.destination.bridge,
        format!("{DESTINATION_BRIDGE:#x}")
    );
    assert_eq!(
        evidence.destination.light_client,
        format!("{LIGHT_CLIENT:#x}")
    );
    assert_eq!(evidence.anchor.slot, world.anchor_slot);
    assert_eq!(evidence.anchor.root, format!("{:#x}", world.anchor_root));
    assert_eq!(evidence.delivery_status, DeliveryStatus::NotDelivered);
    assert!(!evidence.already_delivered);
    assert!(evidence.prerequisites.is_empty());

    assert_eq!(evidence.execute.to, format!("{DESTINATION_BRIDGE:#x}"));
    let calldata = hex::decode(&evidence.execute.data).unwrap();
    let call = executeMessageCall::abi_decode(&calldata).expect("an executeMessage call");
    assert_eq!(call.proof.logIndex, U256::from(MESSAGE_LOG_INDEX));
    assert_eq!(
        call.proof.receiptIndex,
        U256::from(MESSAGE_TRANSACTION_INDEX)
    );
    assert_eq!(
        call.proof.transactionIndex,
        U256::from(MESSAGE_TRANSACTION_INDEX)
    );
    assert!(!call.proof.transactionProof.is_empty());
    assert_eq!(call.proof.anchorHeader.slot, world.anchor_slot);
    assert_eq!(call.proof.sourceHeader.slot, world.source_slot);

    let context = MessageContext {
        remote_bridge: SOURCE_BRIDGE,
        local_chain_id: DESTINATION_CHAIN_ID,
        remote_chain_id: SOURCE_CHAIN_ID,
        stored_anchor_root: world.anchor_root,
    };
    let verified = verify_message(&call.proof, &context, ChainKind::Pulsechain.spec())
        .expect("the calldata passes the reference check");
    assert_eq!(verified.header, fields.header());
    assert_eq!(verified.source_transaction_hash, world.source.transaction);
    assert_eq!(
        verified.source_transaction_hash,
        keccak256(&world.source.raw_transactions[MESSAGE_TRANSACTION_INDEX as usize]),
        "the hash of the transaction at the index of the receipt, not of the first transaction"
    );
}

/// Claim: a message that the bridge executed is reported with its status, and the rest of the evidence is unchanged. The
/// status reads from `messageCallStatus`: a delivery whose call failed reverted, so there is no failed status.
/// Why it matters: a server that sends the proof of an executed message wastes gas on a revert.
#[test]
fn an_executed_message_is_reported_with_its_status() {
    let world = world();
    for (delivery, word) in [(DeliveryStatus::Succeeded, "succeeded")] {
        let state = DestinationState {
            delivery,
            ..DestinationState::complete()
        };
        let evidence = build(&world, state, MESSAGE_LOG_INDEX).unwrap();
        assert_eq!(evidence.delivery_status, delivery);
        assert!(evidence.already_delivered, "{word}");
        assert_eq!(
            serde_json::to_value(&evidence).unwrap()["deliveryStatus"],
            word
        );
    }
}

/// Claim: when the bridge lacks a block hash row, the evidence lists a call for each stored header that can supply it, and
/// each call carries a branch that fits the body root of its header. The first call uses the stored header at or below the
/// source slot, the second the stored header at or below the anchor.
/// Why it matters: the bridge validates the row against the branch. A wrong generalized index or branch reverts the call and
/// leaves the message stuck.
#[test]
fn missing_block_hash_rows_become_layout_calls_that_fit_their_headers() {
    let world = world();
    let state = DestinationState {
        body_rows: vec![],
        ..DestinationState::complete()
    };
    let evidence = build(&world, state, MESSAGE_LOG_INDEX).expect("evidence");
    assert_eq!(evidence.prerequisites.len(), 2);
    let mut header_slots = Vec::new();
    for prerequisite in &evidence.prerequisites {
        assert_eq!(prerequisite.function, "addBlockHashLayout");
        assert_eq!(prerequisite.call.to, format!("{DESTINATION_BRIDGE:#x}"));
        let calldata = hex::decode(&prerequisite.call.data).unwrap();
        let call = MessageBridgeContract::addBlockHashLayoutCall::abi_decode(&calldata)
            .expect("a layout call");
        let BlockHashEvidence {
            header,
            branch,
            fork,
        } = call.evidence;
        assert!(lc_core::ssz::is_valid_exact_branch(
            &block_hash_at_slot(header.slot),
            &branch,
            u64::try_from(call.blockHashGindex).unwrap(),
            &header.bodyRoot,
        ));
        // The bridge takes the row only with a fork proof of a plain state under the state root of the header.
        let fork = lc_core::abi::ForkProof {
            version: fork.version,
            versionBranch: fork.versionBranch,
            genesisValidatorsRootBranch: fork.genesisValidatorsRootBranch,
        };
        let shape = lc_core::ancestry::source_shape(
            &fork,
            &header.stateRoot,
            &ChainKind::Pulsechain.spec().genesis_validators_root,
        );
        assert!(matches!(shape, Ok(5..=7)), "a plain shape: {shape:?}");
        header_slots.push(header.slot);
    }
    assert_eq!(header_slots, vec![world.checkpoint.slot, world.anchor_slot]);
}

/// The execution block hash that the synthetic chain holds at a beacon slot. Neither the checkpoint slot nor the anchor
/// slot is the source block, so the hash is the default one.
fn block_hash_at_slot(slot: u64) -> B256 {
    let first_slot = zk_bridge_prover::local_network::signed_beacon::node::default_first_slot(
        ChainKind::Pulsechain,
    );
    execution_hash(slot - first_slot + 1)
}

/// Claim: when the bridge lacks a row and the light client stored too few heads to validate it, the command fails with the
/// reason, and prints nothing.
/// Why it matters: a partial answer would send the server into a delivery that cannot succeed.
#[test]
fn rows_that_cannot_be_validated_yet_stop_the_command() {
    let world = world();
    let state = DestinationState {
        state_rows: vec![],
        ..DestinationState::complete()
    };
    let destination = serve_destination(&world, state);
    let (outcome, out) = run(
        &world,
        &destination,
        &message_arguments(&world, MESSAGE_LOG_INDEX),
    );
    let error = outcome.unwrap_err().to_string();
    assert!(error.contains("not enough stored headers"), "{error}");
    assert!(out.is_empty());
}

/// Claim: each wrong input stops the command with an error that names the cause: a log of another contract, a log index
/// beyond the receipt, a bridge that points at another source bridge, a header that the light client does not store, and an
/// anchor that does not lie after the source block.
/// Why it matters: a name is a hypothesis. Each of these would otherwise build evidence for the wrong message, or evidence
/// that the bridge must refuse.
#[test]
fn wrong_inputs_are_refused_with_their_cause() {
    let world = world();
    let complete = serve_destination(&world, DestinationState::complete());

    let (outcome, out) = run(&world, &complete, &message_arguments(&world, 0));
    let error = outcome.unwrap_err();
    assert!(matches!(error, Error::Usage(_)), "{error}");
    assert!(
        error.to_string().contains("not from the source bridge"),
        "{error}"
    );
    assert!(out.is_empty());

    let (outcome, _) = run(&world, &complete, &message_arguments(&world, 9));
    assert!(outcome
        .unwrap_err()
        .to_string()
        .contains("no log at index 9"));

    let foreign = serve_destination(
        &world,
        DestinationState {
            remote_bridge: Address::repeat_byte(0xee),
            ..DestinationState::complete()
        },
    );
    let (outcome, _) = run(
        &world,
        &foreign,
        &message_arguments(&world, MESSAGE_LOG_INDEX),
    );
    let error = outcome.unwrap_err();
    assert!(matches!(error, Error::Config(_)), "{error}");
    assert!(error.to_string().contains("remoteBridge"), "{error}");

    let mut unknown_anchor = message_arguments(&world, MESSAGE_LOG_INDEX);
    unknown_anchor.extend(["--anchor-slot".to_string(), "5".to_string()]);
    let (outcome, _) = run(&world, &complete, &unknown_anchor);
    assert!(outcome
        .unwrap_err()
        .to_string()
        .contains("stores no header at slot 5"));

    let mut early_anchor = message_arguments(&world, MESSAGE_LOG_INDEX);
    early_anchor.extend([
        "--anchor-slot".to_string(),
        world.checkpoint.slot.to_string(),
    ]);
    let (outcome, _) = run(&world, &complete, &early_anchor);
    assert!(
        outcome
            .unwrap_err()
            .to_string()
            .contains("is not before the anchor slot"),
        "an anchor below the source block cannot cover it"
    );
}

/// Claim: a message for another destination chain, and a message from another source chain, are refused before any proof,
/// with the two chains named.
/// Why it matters: the destination bridge refuses such a message. Evidence for it would be a wasted delivery.
#[test]
fn a_message_for_another_chain_is_refused() {
    for (fields, expected) in [
        (
            MessageFields {
                destination_chain_id: 31337,
                ..message_fields()
            },
            "is for chain 31337",
        ),
        (
            MessageFields {
                source_chain_id: 31337,
                ..message_fields()
            },
            "is from chain 31337",
        ),
    ] {
        let world = world_for(&fields);
        let destination = serve_destination(&world, DestinationState::complete());
        let (outcome, out) = run(
            &world,
            &destination,
            &message_arguments(&world, MESSAGE_LOG_INDEX),
        );
        let error = outcome.unwrap_err();
        assert!(matches!(error, Error::Usage(_)), "{error}");
        assert!(error.to_string().contains(expected), "{error}");
        assert!(out.is_empty());
    }
}

/// Claim: a source node that serves wrong transaction bytes, or none, stops the command with the cause. The proof of the
/// transaction needs the real bytes, because the bridge hashes them into the source transaction hash.
/// Why it matters: with wrong bytes the rebuilt transactions root differs from the header, and no proof can verify.
#[test]
fn a_source_node_without_the_transaction_bytes_stops_the_command() {
    let world = world();
    let destination = serve_destination(&world, DestinationState::complete());
    for (node, expected) in [
        (SourceNode::WrongBytes, "hash to"),
        (SourceNode::NoRawTransactions, "eth_getRawTransactionByHash"),
    ] {
        let source_url = serve_source(&world.source, node);
        let (outcome, out) = run_evidence(
            &world,
            &source_url,
            &destination,
            &message_arguments(&world, MESSAGE_LOG_INDEX),
        );
        let error = outcome.unwrap_err().to_string();
        assert!(error.contains(expected), "{error}");
        assert!(out.is_empty());
    }
}
