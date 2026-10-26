//! Exercises the live data path of `opening-proof` on one chain, without a deployed bridge.
//!
//! The command reads a block of the remote chain, rebuilds its header, asks `eth_getProof` for the account of the remote
//! light client and one storage slot, and walks header, account proof and storage proof. No bridge exists yet, so this
//! example uses any contract and any storage slot in place of the light client and its mapping, and says so in its output.
//!
//! Usage: `cargo run --release --example live_opening_path -- --rpc-url <url> --chain-id <n> --contract <address>
//! --storage-slot <hex> [--blocks-behind <n>]`
//!
//! It prints one JSON object. A URL never appears in it.

use alloy_primitives::{keccak256, Address, B256};
use lc_core::mpt::extract_proven_value;
use serde_json::{json, Value};
use zk_bridge_prover::chain::ChainClient;
use zk_bridge_prover::error::{Error, Result};
use zk_bridge_prover::light_client::rebuild_execution_header;
use zk_bridge_prover::rpc::{parse_quantity, HttpRpc, JsonRpc};

/// The index of `stateRoot` in the list of an execution block header.
const STATE_ROOT_FIELD: usize = 3;
/// The index of `storageRoot` in the list of an account.
const ACCOUNT_STORAGE_ROOT_FIELD: usize = 2;

fn option(arguments: &[String], name: &str) -> Result<String> {
    arguments
        .iter()
        .position(|argument| argument == name)
        .and_then(|index| arguments.get(index + 1))
        .cloned()
        .ok_or_else(|| Error::Config(format!("the argument {name} is missing")))
}

/// The nibbles of `keccak256(preimage)`, the key of a trie walk.
fn nibbles(preimage: &[u8]) -> Vec<u8> {
    keccak256(preimage)
        .iter()
        .flat_map(|byte| [byte >> 4, byte & 0x0f])
        .collect()
}

/// The string items of one RLP list.
fn items(encoded: &[u8]) -> Result<Vec<Vec<u8>>> {
    let mut buffer = encoded;
    let list = alloy_rlp::Header::decode(&mut buffer)
        .map_err(|error| Error::Malformed(format!("rlp: {error}")))?;
    if !list.list {
        return Err(Error::Malformed("rlp: not a list".into()));
    }
    let mut found = Vec::new();
    while !buffer.is_empty() {
        let header = alloy_rlp::Header::decode(&mut buffer)
            .map_err(|error| Error::Malformed(format!("rlp: {error}")))?;
        if header.list || buffer.len() < header.payload_length {
            return Err(Error::Malformed("rlp: a field is not a string".into()));
        }
        let (payload, rest) = buffer.split_at(header.payload_length);
        found.push(payload.to_vec());
        buffer = rest;
    }
    Ok(found)
}

fn field(encoded: &[u8], index: usize) -> Result<B256> {
    let all = items(encoded)?;
    let item = all
        .get(index)
        .ok_or_else(|| Error::Malformed(format!("rlp: no field {index}")))?;
    B256::try_from(item.as_slice())
        .map_err(|_| Error::Malformed(format!("rlp: field {index} is not 32 bytes")))
}

fn hex_list(value: &Value) -> Result<Vec<alloy_primitives::Bytes>> {
    value
        .as_array()
        .ok_or_else(|| Error::Malformed("a proof is not a list".into()))?
        .iter()
        .map(|node| {
            node.as_str()
                .and_then(|text| text.parse().ok())
                .ok_or_else(|| Error::Malformed("a proof node is not hex".into()))
        })
        .collect()
}

fn run(arguments: &[String]) -> Result<Value> {
    let url = option(arguments, "--rpc-url")?;
    let chain_id: u64 = option(arguments, "--chain-id")?
        .parse()
        .map_err(|error| Error::Config(format!("--chain-id: {error}")))?;
    let contract: Address = option(arguments, "--contract")?
        .parse()
        .map_err(|error| Error::Config(format!("--contract: {error}")))?;
    let slot: B256 = option(arguments, "--storage-slot")?
        .parse()
        .map_err(|error| Error::Config(format!("--storage-slot: {error}")))?;
    let client = ChainClient::connect("live", chain_id, Box::new(HttpRpc::new(&url)))?;
    let rpc = HttpRpc::new(&url);
    // Many nodes keep the proof window at zero blocks: `--blocks-behind` (default 0) names the distance from the head.
    let behind: u64 = match option(arguments, "--blocks-behind") {
        Ok(text) => text
            .parse()
            .map_err(|error| Error::Config(format!("--blocks-behind: {error}")))?,
        Err(_) => 0,
    };
    let number = client.latest_block_number()?.saturating_sub(behind);
    let block = rpc.call(
        "eth_getBlockByNumber",
        json!([format!("{number:#x}"), false]),
    )?;
    let hash: B256 = block["hash"]
        .as_str()
        .and_then(|text| text.parse().ok())
        .ok_or_else(|| Error::Malformed("block hash".into()))?;
    // The path of `opening-proof`: rebuild the header from the JSON of the block.
    let rebuilt = rebuild_execution_header(&block);
    let rebuilt_matches = rebuilt.is_ok();
    let rebuilt_error = rebuilt.as_ref().err().map(ToString::to_string);
    // The exact source: the raw header of the node.
    let raw = client.raw_header(hash);
    let raw_ok = raw.is_ok();
    let raw_error = raw.as_ref().err().map(ToString::to_string);
    let header_rlp = match (&rebuilt, &raw) {
        (Ok(built), _) => built.header_rlp.to_vec(),
        (_, Ok(bytes)) => bytes.clone(),
        (Err(error), Err(_)) => return Err(Error::Malformed(error.to_string())),
    };
    let state_root = field(&header_rlp, STATE_ROOT_FIELD)?;
    let answer = client.account_proof(contract, &[slot], parse_quantity(&block["number"])?)?;
    let account = extract_proven_value(
        state_root,
        &nibbles(contract.as_slice()),
        &hex_list(&answer["accountProof"])?,
    )
    .map_err(|error| Error::Malformed(format!("account proof: {error}")))?;
    let storage_root = field(&account, ACCOUNT_STORAGE_ROOT_FIELD)?;
    let entry = &answer["storageProof"][0];
    let value = extract_proven_value(
        storage_root,
        &nibbles(slot.as_slice()),
        &hex_list(&entry["proof"])?,
    )
    .map_err(|error| Error::Malformed(format!("storage proof: {error}")))?;
    Ok(json!({
        "chainId": chain_id,
        "blockNumber": number,
        "blockHash": format!("{hash:#x}"),
        "headerFromJsonMatchesHash": rebuilt_matches,
        "headerFromJsonError": rebuilt_error,
        "rawHeaderMatchesHash": raw_ok,
        "rawHeaderError": raw_error,
        "headerRlpBytes": header_rlp.len(),
        "stateRoot": format!("{state_root:#x}"),
        "storageRoot": format!("{storage_root:#x}"),
        "storageSlot": format!("{slot:#x}"),
        "provenStorageValueRlp": alloy_primitives::hex::encode_prefixed(&value),
        "note": "any contract and any slot stand in for the light client; no bridge exists yet",
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
