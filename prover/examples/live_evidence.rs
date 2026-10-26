//! Exercises the live data path of `evidence` on a Gloas source chain, without a destination bridge.
//!
//! The command reads the block, the receipts and the raw transactions of the source block, reads the raw header, builds the
//! beacon path through the bid of a later block (for a Gloas block), assembles the message proof, and runs the native
//! bridge check. No bridge exists yet, so this example takes any transaction and any log. The check is expected to stop at
//! the topic of the log, because a transfer log is no `UserRequestForAffirmation`: every link before it (the receipt trie,
//! the transaction trie, the header, the bid, the ancestry) has then passed.
//!
//! Usage: `cargo run --release --example live_evidence -- --rpc-url <url> --chain-id <n> --beacon-url <url> --chain <name>
//! --tx <hash> --log-index <n>`
//!
//! The anchor is the newest finalized header of the beacon node. It prints one JSON object. A URL never appears in it.

use alloy_primitives::B256;
use serde_json::{json, Value};
use zk_bridge_prover::beacon::http::HttpBeaconSource;
use zk_bridge_prover::beacon::{SourceBlock, StoredHead};
use zk_bridge_prover::chain::ChainClient;
use zk_bridge_prover::error::{Error, Result};
use zk_bridge_prover::light_client::{
    assemble_message_proof, beacon_header_from_json, build_execution_evidence,
    build_execution_evidence_from_raw_header, header_root, verify_message_natively, BridgeContext,
    ChainKind,
};
use zk_bridge_prover::rpc::{parse_quantity, HttpClient, HttpGet, HttpRpc, JsonRpc};

fn option(arguments: &[String], name: &str) -> Result<String> {
    arguments
        .iter()
        .position(|argument| argument == name)
        .and_then(|index| arguments.get(index + 1))
        .cloned()
        .ok_or_else(|| Error::Config(format!("the argument {name} is missing")))
}

fn parse<T: std::str::FromStr>(arguments: &[String], name: &str) -> Result<T>
where
    T::Err: std::fmt::Display,
{
    option(arguments, name)?
        .parse()
        .map_err(|error| Error::Config(format!("{name}: {error}")))
}

/// The newest finalized header of the beacon node, as a stored head.
fn finalized_head(beacon_url: &str) -> Result<StoredHead> {
    let answer =
        HttpClient::new(beacon_url).get("/eth/v1/beacon/headers/finalized", "application/json")?;
    let answer: Value = serde_json::from_slice(&answer.body)
        .map_err(|error| Error::Malformed(format!("header: {error}")))?;
    let header = beacon_header_from_json(&answer["data"]["header"]["message"])?;
    Ok(StoredHead {
        slot: header.slot,
        root: header_root(&header),
        next_committee_hash: B256::ZERO,
    })
}

fn run(arguments: &[String]) -> Result<Value> {
    let url = option(arguments, "--rpc-url")?;
    let chain_id: u64 = parse(arguments, "--chain-id")?;
    let kind = ChainKind::parse(&option(arguments, "--chain")?)?;
    let transaction: B256 = parse(arguments, "--tx")?;
    let log_index: u64 = parse(arguments, "--log-index")?;
    let source = ChainClient::connect("source", chain_id, Box::new(HttpRpc::new(&url)))?;
    let beacon_url = option(arguments, "--beacon-url")?;
    let beacon = HttpBeaconSource::new(kind, Box::new(HttpClient::new(&beacon_url)));

    let receipt = HttpRpc::new(&url).call(
        "eth_getTransactionReceipt",
        json!([format!("{transaction:#x}")]),
    )?;
    let number = parse_quantity(&receipt["blockNumber"])?;
    let block_hash: B256 = receipt["blockHash"]
        .as_str()
        .and_then(|text| text.parse().ok())
        .ok_or_else(|| Error::Malformed("blockHash".into()))?;
    let transaction_index = parse_quantity(&receipt["transactionIndex"])?;
    let block = source
        .block(number)?
        .ok_or_else(|| Error::Malformed(format!("block {number} is unknown")))?;
    let receipts = source.block_receipts(number, &block)?;
    let transactions = source.block_raw_transactions(&block)?;
    let timestamp = parse_quantity(&block["timestamp"])?;
    let is_gloas = beacon.is_gloas_source(timestamp)?;
    let execution = if is_gloas {
        build_execution_evidence_from_raw_header(
            source.raw_header(block_hash)?,
            &receipts,
            &transactions,
            transaction_index,
        )?
    } else {
        build_execution_evidence(&block, &receipts, &transactions, transaction_index)?
    };
    if execution.block_hash != block_hash {
        return Err(Error::Malformed(
            "the block hash differs from the receipt".into(),
        ));
    }
    let anchor = finalized_head(&beacon_url)?;
    let path = beacon.message_path(
        &SourceBlock {
            number,
            hash: block_hash,
            timestamp,
        },
        &anchor,
    )?;
    let proof = assemble_message_proof(&path, &execution, transaction_index, log_index);
    let log_address = receipt["logs"][log_index as usize]["address"]
        .as_str()
        .and_then(|text| text.parse().ok())
        .ok_or_else(|| Error::Usage(format!("the receipt has no log {log_index}")))?;
    let context = BridgeContext {
        remote_bridge: log_address,
        remote_chain_id: chain_id,
        local_chain_id: 943,
        stored_anchor_root: anchor.root,
    };
    let verdict = match verify_message_natively(&proof, &context, kind) {
        Ok(_) => "accepted".to_string(),
        Err(error) => error.to_string(),
    };
    Ok(json!({
        "chain": kind.name(),
        "gloasSource": is_gloas,
        "transaction": format!("{transaction:#x}"),
        "blockNumber": number,
        "blockHash": format!("{block_hash:#x}"),
        "transactionsInBlock": transactions.len(),
        "sourceSlotOfProof": path.source_header.slot,
        "anchorSlot": anchor.slot,
        "ancestryBranchLength": path.ancestry_branch.len(),
        "blockHashBranchLength": path.block_hash_branch.len(),
        "executionHeaderRlpBytes": proof.executionHeaderRlp.len(),
        "nativeVerdict": verdict,
    }))
}

fn main() {
    let arguments: Vec<String> = std::env::args().collect();
    match run(&arguments) {
        Ok(value) => println!("{value}"),
        Err(error) => {
            eprintln!("error: {error}");
            std::process::exit(1);
        }
    }
}
