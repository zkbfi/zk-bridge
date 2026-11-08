//! The `opening-proof` command against two mock JSON-RPC chains.
//!
//! The remote chain holds a real account trie and a real storage trie of one leaf each. The header of the remote block
//! hashes to the block hash that the own light client stores, and its state root is the root of the account trie. So the
//! proof that the command builds passes the same walk as `BeaconProofVerifier._verifyOpening`, which the tests run again
//! on the decoded calldata. A flipped proof node must stop the command.

mod common;

use alloy_primitives::{hex, keccak256, Address, Bytes, B256, U256};
use alloy_sol_types::{SolCall, SolValue};
use common::{serve_rpc, serve_rpc_replies};
use lc_core::json::execution_header_from_json;
use lc_core::receipts::{encode_execution_header, header_hash};
use serde_json::{json, Value};
use std::path::PathBuf;
use zk_bridge_prover::cli;
use zk_bridge_prover::contracts::{LightClientContract, MessageBridgeContract, OpeningProof};
use zk_bridge_prover::error::{Error, Result};
use zk_bridge_prover::opening::{
    execution_block_hashes_slot, verify_opening, ACCOUNT_STORAGE_ROOT_FIELD,
    EXECUTION_BLOCK_HASHES_MAPPING_SLOT, STATE_ROOT_FIELD,
};

const OWN_CHAIN_ID: u64 = 1;
const REMOTE_CHAIN_ID: u64 = 369;
const BRIDGE: Address = Address::repeat_byte(0xb1);
const OWN_LIGHT_CLIENT: Address = Address::repeat_byte(0xb3);
const REMOTE_LIGHT_CLIENT: Address = Address::repeat_byte(0xc3);
const REMOTE_SLOT: u64 = 10_000;
const STORED_SLOT: u64 = 9_000;
const REMOTE_BLOCK_NUMBER: u64 = 777;

fn rlp_length(base: u8, length: usize) -> Vec<u8> {
    if length < 56 {
        return vec![base + length as u8];
    }
    let bytes: Vec<u8> = length
        .to_be_bytes()
        .into_iter()
        .skip_while(|byte| *byte == 0)
        .collect();
    let mut header = vec![base + 55 + bytes.len() as u8];
    header.extend(bytes);
    header
}

fn rlp_string(bytes: &[u8]) -> Vec<u8> {
    if bytes.len() == 1 && bytes[0] < 0x80 {
        return bytes.to_vec();
    }
    [rlp_length(0x80, bytes.len()), bytes.to_vec()].concat()
}

fn rlp_list(items: &[Vec<u8>]) -> Vec<u8> {
    let payload = items.concat();
    [rlp_length(0xc0, payload.len()), payload].concat()
}

/// The node of a trie with one leaf: the whole key as path, the value as the leaf value.
fn single_leaf(key_hash: B256, value: &[u8]) -> Bytes {
    let path = [vec![0x20u8], key_hash.to_vec()].concat();
    Bytes::from(rlp_list(&[rlp_string(&path), rlp_string(value)]))
}

/// The block hash that the remote light client stores at `STORED_SLOT`. It has no leading zero byte.
fn stored_hash() -> B256 {
    B256::repeat_byte(0x5a)
}

/// Which header the remote block has.
#[derive(Clone, Copy, PartialEq)]
enum HeaderMode {
    /// The fields that the JSON rebuilder knows. The node does not serve `debug_getRawHeader`.
    Plain,
    /// One more field than the JSON of the block shows (a Gloas header has `slotNumber`). Only `debug_getRawHeader` gives
    /// the exact bytes, and the block hash is the hash of those bytes.
    ExtraField,
}

/// The remote world: tries, block and answers.
struct Remote {
    account_proof: Vec<Bytes>,
    storage_proof: Vec<Bytes>,
    block: Value,
    block_hash: B256,
    /// What `debug_getRawHeader` answers, or `None` for a node without the method.
    raw_header: Option<Vec<u8>>,
}

/// The RLP list of `header_rlp` with one more string item at the end.
fn with_extra_item(header_rlp: &[u8]) -> Vec<u8> {
    let mut buffer = header_rlp;
    let list = alloy_rlp::Header::decode(&mut buffer).unwrap();
    assert!(list.list && list.payload_length == buffer.len());
    rlp_list(&[buffer.to_vec(), rlp_string(&[0x2a])])
}

fn remote() -> Remote {
    remote_in(HeaderMode::Plain)
}

fn remote_in(mode: HeaderMode) -> Remote {
    let entry = rlp_string(stored_hash().as_slice());
    let storage_node = single_leaf(keccak256(execution_block_hashes_slot(STORED_SLOT)), &entry);
    let storage_root = keccak256(&storage_node);
    let account = rlp_list(&[
        rlp_string(&[1]),
        rlp_string(&[]),
        rlp_string(storage_root.as_slice()),
        rlp_string(keccak256(b"code").as_slice()),
    ]);
    let account_node = single_leaf(keccak256(REMOTE_LIGHT_CLIENT), &account);
    let state_root = keccak256(&account_node);
    let mut block = json!({
        "parentHash": format!("{:#x}", B256::repeat_byte(0x10)),
        "sha3Uncles": format!("{:#x}", B256::repeat_byte(0x11)),
        "miner": format!("{:#x}", Address::repeat_byte(0x0f)),
        "stateRoot": format!("{state_root:#x}"),
        "transactionsRoot": format!("{:#x}", B256::repeat_byte(0x13)),
        "receiptsRoot": format!("{:#x}", B256::repeat_byte(0x15)),
        "logsBloom": format!("0x{}", "00".repeat(256)),
        "difficulty": "0x0",
        "number": format!("{REMOTE_BLOCK_NUMBER:#x}"),
        "gasLimit": "0x1c9c380",
        "gasUsed": "0x0",
        "timestamp": "0x6553f100",
        "extraData": "0x",
        "mixHash": format!("{:#x}", B256::repeat_byte(0x14)),
        "nonce": "0x0000000000000000",
        "baseFeePerGas": "0x7",
        "transactions": [],
    });
    let rebuilt = encode_execution_header(&execution_header_from_json(&block));
    let (block_hash, raw_header) = match mode {
        HeaderMode::Plain => (header_hash(&rebuilt), None),
        HeaderMode::ExtraField => {
            let raw = with_extra_item(&rebuilt);
            (keccak256(&raw), Some(raw))
        }
    };
    block["hash"] = json!(format!("{block_hash:#x}"));
    Remote {
        account_proof: vec![account_node],
        storage_proof: vec![storage_node],
        block,
        block_hash,
        raw_header,
    }
}

fn hex_nodes(nodes: &[Bytes]) -> Vec<String> {
    nodes.iter().map(|node| format!("{node}")).collect()
}

/// Which byte the remote node flips in what it serves.
#[derive(Clone, Copy, PartialEq)]
enum Tamper {
    Nothing,
    AccountNode,
    StorageNode,
    /// The node keeps too little history: `eth_getProof` and `eth_call` at the remote block fail as a proof window does.
    OutOfWindow,
}

fn flipped(nodes: &[Bytes]) -> Vec<Bytes> {
    let mut copy = nodes.to_vec();
    let mut node = copy[0].to_vec();
    let last = node.len() - 1;
    node[last] ^= 0x01;
    copy[0] = Bytes::from(node);
    copy
}

fn input_of(call: &Value) -> (Address, Vec<u8>) {
    let request = &call["params"][0];
    let to: Address = request["to"].as_str().unwrap().parse().unwrap();
    (to, hex::decode(request["data"].as_str().unwrap()).unwrap())
}

fn own_chain_url(mode: HeaderMode) -> String {
    serve_rpc(move |call| {
        if call["method"] == "eth_chainId" {
            return json!(format!("{OWN_CHAIN_ID:#x}"));
        }
        let (to, data) = input_of(call);
        let selector: [u8; 4] = data[..4].try_into().unwrap();
        let encoded = |bytes: Vec<u8>| json!(hex::encode_prefixed(bytes));
        if to == BRIDGE {
            return match selector {
                MessageBridgeContract::localChainIdCall::SELECTOR => encoded(
                    MessageBridgeContract::localChainIdCall::abi_encode_returns(&OWN_CHAIN_ID),
                ),
                MessageBridgeContract::remoteChainIdCall::SELECTOR => encoded(
                    MessageBridgeContract::remoteChainIdCall::abi_encode_returns(&REMOTE_CHAIN_ID),
                ),
                MessageBridgeContract::remoteLightClientCall::SELECTOR => encoded(
                    MessageBridgeContract::remoteLightClientCall::abi_encode_returns(
                        &REMOTE_LIGHT_CLIENT,
                    ),
                ),
                MessageBridgeContract::lightClientCall::SELECTOR => encoded(
                    MessageBridgeContract::lightClientCall::abi_encode_returns(&OWN_LIGHT_CLIENT),
                ),
                MessageBridgeContract::depositsOpenCall::SELECTOR => encoded(
                    MessageBridgeContract::depositsOpenCall::abi_encode_returns(&false),
                ),
                other => panic!("unexpected bridge call {other:?}"),
            };
        }
        assert_eq!(to, OWN_LIGHT_CLIENT);
        match selector {
            LightClientContract::headCall::SELECTOR => encoded(
                LightClientContract::headCall::abi_encode_returns(&REMOTE_SLOT),
            ),
            LightClientContract::executionBlockHashesCall::SELECTOR => {
                let call =
                    LightClientContract::executionBlockHashesCall::abi_decode(&data).unwrap();
                let hash = if call.slot == REMOTE_SLOT {
                    remote_in(mode).block_hash
                } else {
                    B256::ZERO
                };
                encoded(LightClientContract::executionBlockHashesCall::abi_encode_returns(&hash))
            }
            other => panic!("unexpected light client call {other:?}"),
        }
    })
}

fn remote_chain_url(tamper: Tamper, mode: HeaderMode) -> String {
    remote_chain_url_with(tamper, mode, true)
}

/// The JSON-RPC error of a node without `debug_getRawHeader`, as the keyless Sepolia node answers.
fn method_missing() -> Value {
    json!({ "code": -32601, "message": "the method debug_getRawHeader does not exist/is not available" })
}

/// The JSON-RPC error of a node asked for a block older than its proof window, as publicnode answers.
fn out_of_window() -> Value {
    json!({ "code": -32000, "message": "distance to target block exceeds maximum proof window" })
}

/// The remote chain. `serves_raw_header: false` makes it answer `debug_getRawHeader` with the error of a missing method.
fn remote_chain_url_with(tamper: Tamper, mode: HeaderMode, serves_raw_header: bool) -> String {
    serve_rpc_replies(move |call| {
        let world = remote_in(mode);
        if call["method"] == "debug_getRawHeader" && !serves_raw_header {
            return Err(method_missing());
        }
        if tamper == Tamper::OutOfWindow
            && (call["method"] == "eth_getProof" || call["method"] == "eth_call")
        {
            return Err(out_of_window());
        }
        Ok(match call["method"].as_str().unwrap() {
            "eth_chainId" => json!(format!("{REMOTE_CHAIN_ID:#x}")),
            "debug_getRawHeader" => {
                assert_eq!(call["params"][0], format!("{:#x}", world.block_hash));
                world
                    .raw_header
                    .map_or(Value::Null, |raw| json!(hex::encode_prefixed(raw)))
            }
            "eth_getBlockByHash" => {
                assert_eq!(call["params"][0], format!("{:#x}", world.block_hash));
                world.block
            }
            "eth_call" => {
                let (to, data) = input_of(call);
                assert_eq!(to, REMOTE_LIGHT_CLIENT);
                assert_eq!(&data[..4], &LightClientContract::headCall::SELECTOR[..]);
                assert_eq!(
                    call["params"][1],
                    format!("{REMOTE_BLOCK_NUMBER:#x}"),
                    "the head is read in the block of the proof"
                );
                json!(hex::encode_prefixed(
                    LightClientContract::headCall::abi_encode_returns(&STORED_SLOT)
                ))
            }
            "eth_getProof" => {
                assert_eq!(call["params"][0], format!("{REMOTE_LIGHT_CLIENT:#x}"));
                assert_eq!(call["params"][2], format!("{REMOTE_BLOCK_NUMBER:#x}"));
                let key = execution_block_hashes_slot(STORED_SLOT);
                assert_eq!(call["params"][1][0], format!("{key:#x}"));
                let account = if tamper == Tamper::AccountNode {
                    flipped(&world.account_proof)
                } else {
                    world.account_proof.clone()
                };
                let storage = if tamper == Tamper::StorageNode {
                    flipped(&world.storage_proof)
                } else {
                    world.storage_proof.clone()
                };
                json!({
                    "accountProof": hex_nodes(&account),
                    "storageProof": [{
                        "key": format!("{:#x}", U256::from_be_bytes(key.0)),
                        "value": format!("{:#x}", U256::from_be_bytes(stored_hash().0)),
                        "proof": hex_nodes(&storage),
                    }],
                })
            }
            other => panic!("unexpected remote method {other}"),
        })
    })
}

/// What a header endpoint answers to `debug_getRawHeader`.
#[derive(Clone, Copy)]
enum HeaderAnswer {
    /// The exact bytes of the remote header.
    Right,
    /// Bytes that do not hash to the block hash.
    WrongHash,
    /// The error of a missing method.
    Missing,
}

/// A header endpoint: it answers `debug_getRawHeader` and nothing else, so a test fails if the command asks it for more.
fn header_url(answer: HeaderAnswer, mode: HeaderMode) -> String {
    serve_rpc_replies(move |call| {
        assert_eq!(call["method"], "debug_getRawHeader", "only the raw header");
        let world = remote_in(mode);
        assert_eq!(call["params"][0], format!("{:#x}", world.block_hash));
        let raw = world.raw_header.expect("the extra-field header");
        match answer {
            HeaderAnswer::Right => Ok(json!(hex::encode_prefixed(raw))),
            HeaderAnswer::WrongHash => Ok(json!(hex::encode_prefixed(with_extra_item(&raw)))),
            HeaderAnswer::Missing => Err(method_missing()),
        }
    })
}

struct Scratch(PathBuf);

impl Drop for Scratch {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.0);
    }
}

fn run_command(tamper: Tamper, extra: &[&str]) -> (Result<i32>, Vec<u8>) {
    run_command_in(tamper, HeaderMode::Plain, extra)
}

fn run_command_in(tamper: Tamper, mode: HeaderMode, extra: &[&str]) -> (Result<i32>, Vec<u8>) {
    run_with_remote(mode, remote_chain_url(tamper, mode), &[], extra)
}

/// Runs the command with a remote chain at `remote` and `header_urls` as `destination.header_rpc_urls`.
fn run_with_remote(
    mode: HeaderMode,
    remote: String,
    header_urls: &[String],
    extra: &[&str],
) -> (Result<i32>, Vec<u8>) {
    let header_rpc_urls = if header_urls.is_empty() {
        String::new()
    } else {
        format!("header_rpc_urls = {header_urls:?}\n")
    };
    run_with_destination_lines(mode, remote, &header_rpc_urls, extra)
}

/// Runs the command with a remote chain at `remote` and `destination_lines` added to the destination section.
fn run_with_destination_lines(
    mode: HeaderMode,
    remote: String,
    header_rpc_urls: &str,
    extra: &[&str],
) -> (Result<i32>, Vec<u8>) {
    let own = own_chain_url(mode);
    let scratch = Scratch(std::env::temp_dir().join(format!(
        "opening-proof-{}-{}",
        std::process::id(),
        remote.rsplit(':').next().unwrap()
    )));
    std::fs::create_dir_all(&scratch.0).unwrap();
    let config = scratch.0.join("prover.toml");
    std::fs::write(
        &config,
        format!(
            r#"
[routes.one.source]
chain_id = {OWN_CHAIN_ID}
chain = "pulsechain"
beacon_url = "http://127.0.0.1:1"
rpc_url = "{own}"
bridge = "{BRIDGE:#x}"

[routes.one.destination]
chain_id = {REMOTE_CHAIN_ID}
rpc_url = "{remote}"
light_client = "{REMOTE_LIGHT_CLIENT:#x}"
bridge = "{:#x}"
{header_rpc_urls}"#,
            Address::repeat_byte(0xd1)
        ),
    )
    .unwrap();
    let mut arguments: Vec<String> = ["zk-bridge-prover", "--config"]
        .into_iter()
        .map(String::from)
        .chain([config.display().to_string(), "opening-proof".into()])
        .collect();
    arguments.extend(extra.iter().map(|text| text.to_string()));
    let mut out = Vec::new();
    let outcome = cli::run(arguments, &|_| None, &mut out);
    (outcome, out)
}

/// Claim: the command prints one JSON object whose calldata is `openDeposits` with the proof of the world: the remote slot
/// that the own light client stored, the RLP of the remote header (it hashes to the stored hash and holds the state root
/// at field 3), the account proof and the storage proof of `executionBlockHashes[storedSlot]` at the slot that the Solidity
/// rule gives. The stored slot is the head of the remote light client in the remote block. The decoded parts equal the
/// printed parts. Why it matters: a server sends this calldata as it is, and a wrong slot or key makes the bridge revert.
#[test]
fn the_command_prints_the_calldata_of_open_deposits_with_the_proof_of_the_world() {
    let (outcome, out) = run_command(Tamper::Nothing, &[]);
    assert_eq!(outcome.unwrap(), 0);
    assert_eq!(
        out.iter().filter(|byte| **byte == b'\n').count(),
        1,
        "one line"
    );
    let printed: Value = serde_json::from_slice(&out).unwrap();
    let world = remote();

    let calldata = hex::decode(printed["calldata"].as_str().unwrap()).unwrap();
    assert_eq!(
        &calldata[..4],
        &keccak256("openDeposits((uint64,bytes,bytes[],uint64,bytes[]))")[..4]
    );
    let proof = MessageBridgeContract::openDepositsCall::abi_decode(&calldata)
        .unwrap()
        .proof;
    assert_eq!(proof.remoteSlot, REMOTE_SLOT);
    assert_eq!(proof.storedSlot, STORED_SLOT);
    assert_eq!(keccak256(&proof.remoteHeaderRlp), world.block_hash);
    assert_eq!(proof.accountProof, world.account_proof);
    assert_eq!(proof.storageProof, world.storage_proof);
    assert_eq!(printed["proof"]["remoteSlot"], REMOTE_SLOT);
    assert_eq!(printed["proof"]["storedSlot"], STORED_SLOT);
    assert_eq!(
        printed["proof"]["accountProof"],
        json!(hex_nodes(&world.account_proof))
    );
    assert_eq!(
        printed["proof"]["storageProof"],
        json!(hex_nodes(&world.storage_proof))
    );
    assert_eq!(
        printed["proof"]["remoteHeaderRlp"],
        format!("{}", proof.remoteHeaderRlp)
    );
    assert_eq!(printed["to"], format!("{BRIDGE:#x}"));
    assert_eq!(
        printed["remoteBlockHash"],
        format!("{:#x}", world.block_hash)
    );
    assert_eq!(printed["remoteBlockNumber"], REMOTE_BLOCK_NUMBER);
    assert_eq!(printed["storedBlockHash"], format!("{:#x}", stored_hash()));
    assert_eq!(printed["ownLightClient"], format!("{OWN_LIGHT_CLIENT:#x}"));
    assert_eq!(
        printed["remoteLightClient"],
        format!("{REMOTE_LIGHT_CLIENT:#x}")
    );
    assert_eq!(printed["depositsOpen"], false);
    assert_eq!(printed["verifiedNatively"], true);
    // The slot rule of the Solidity helper, written out here: keccak256(abi.encode(uint256(storedSlot), 3)).
    let expected_slot = keccak256((U256::from(STORED_SLOT), U256::from(3u64)).abi_encode());
    assert_eq!(printed["storageSlot"], format!("{expected_slot:#x}"));
}

/// Claim: when the remote header has a field that the JSON of the block does not show, the command takes the exact bytes
/// from `debug_getRawHeader`, so the header in the proof hashes to the block hash that the own light client stored.
/// Why it matters: a live Sepolia block (Gloas) failed the JSON rebuild with "the rebuilt header hashes to X, the node
/// reports Y", so the command could not open a bridge whose remote chain is Sepolia.
#[test]
fn a_header_with_an_extra_field_comes_from_the_raw_header() {
    let (outcome, out) = run_command_in(Tamper::Nothing, HeaderMode::ExtraField, &[]);
    assert_eq!(outcome.unwrap(), 0);
    let printed: Value = serde_json::from_slice(&out).unwrap();
    let world = remote_in(HeaderMode::ExtraField);
    let raw = world.raw_header.unwrap();
    assert_eq!(
        printed["proof"]["remoteHeaderRlp"],
        hex::encode_prefixed(&raw)
    );
    assert_eq!(keccak256(&raw), world.block_hash);
    assert_eq!(printed["verifiedNatively"], true);
}

/// Claim: when the main RPC of the remote chain lacks `debug_getRawHeader` and the JSON rebuild cannot give the header,
/// the command asks `destination.header_rpc_urls` for the raw header and builds the proof with it. Why it matters: the
/// keyless Sepolia node with enough `eth_getProof` history answers -32601, so PulseChain testnet v4's bridge could not open.
#[test]
fn the_raw_header_comes_from_a_header_rpc_when_the_main_rpc_lacks_the_method() {
    let mode = HeaderMode::ExtraField;
    let remote = remote_chain_url_with(Tamper::Nothing, mode, false);
    let (outcome, out) =
        run_with_remote(mode, remote, &[header_url(HeaderAnswer::Right, mode)], &[]);
    assert_eq!(outcome.unwrap(), 0);
    let printed: Value = serde_json::from_slice(&out).unwrap();
    let raw = remote_in(mode).raw_header.unwrap();
    assert_eq!(
        printed["proof"]["remoteHeaderRlp"],
        hex::encode_prefixed(&raw)
    );
    assert_eq!(printed["verifiedNatively"], true);
}

/// Claim: a header endpoint that answers bytes with another hash is refused, and the next endpoint is asked. Why it
/// matters: no header endpoint is trusted; each answer is checked against the block hash the own light client stored.
#[test]
fn a_header_rpc_with_a_wrong_hash_is_refused_and_the_next_one_is_asked() {
    let mode = HeaderMode::ExtraField;
    let remote = remote_chain_url_with(Tamper::Nothing, mode, false);
    let urls = [
        header_url(HeaderAnswer::WrongHash, mode),
        header_url(HeaderAnswer::Missing, mode),
        header_url(HeaderAnswer::Right, mode),
    ];
    let (outcome, out) = run_with_remote(mode, remote, &urls, &[]);
    assert_eq!(outcome.unwrap(), 0);
    let printed: Value = serde_json::from_slice(&out).unwrap();
    let world = remote_in(mode);
    assert_eq!(
        printed["proof"]["remoteHeaderRlp"],
        hex::encode_prefixed(world.raw_header.unwrap())
    );
}

/// Claim: when every source fails, the error names each one (the main RPC, each header endpoint by its index, the JSON
/// rebuild) with its cause, and holds no URL. Why it matters: an operator sees which endpoint to fix, and a URL with a key
/// never reaches a log.
#[test]
fn every_header_source_failing_gives_an_error_that_names_each_without_urls() {
    let mode = HeaderMode::ExtraField;
    let remote = remote_chain_url_with(Tamper::Nothing, mode, false);
    let urls = [
        header_url(HeaderAnswer::WrongHash, mode),
        header_url(HeaderAnswer::Missing, mode),
    ];
    let (outcome, out) = run_with_remote(mode, remote, &urls, &[]);
    let error = outcome.expect_err("no source gives the header");
    assert!(out.is_empty());
    let Error::Malformed(text) = &error else {
        panic!("{error}");
    };
    for part in [
        "destination.rpc_url",
        "-32601",
        "destination.header_rpc_urls[0]",
        "does not hash to",
        "destination.header_rpc_urls[1]",
        "the rebuild from JSON",
    ] {
        assert!(text.contains(part), "{part}: {text}");
    }
    assert!(
        !text.contains("http") && !text.contains("127.0.0.1"),
        "{text}"
    );
}

/// Claim: an entry of `destination.header_rpc_urls` that is not an http(s) URL is refused when the configuration loads.
#[test]
fn a_header_rpc_url_without_http_is_refused() {
    let remote = remote_chain_url(Tamper::Nothing, HeaderMode::Plain);
    let (outcome, _) = run_with_remote(
        HeaderMode::Plain,
        remote,
        &["ftp://header.example".to_string()],
        &[],
    );
    assert!(
        matches!(&outcome, Err(Error::Config(text)) if text.contains("destination.header_rpc_urls")),
        "{outcome:?}"
    );
}

/// Claim: one flipped byte in a node of the account proof, or of the storage proof, stops the command with a refusal, and
/// nothing reaches standard output. Why it matters: the contract refuses such a proof, and a server must not spend gas on it.
#[test]
fn a_flipped_proof_node_stops_the_command() {
    for (tamper, part) in [
        (Tamper::AccountNode, "account"),
        (Tamper::StorageNode, "storage"),
    ] {
        let (outcome, out) = run_command(tamper, &[]);
        let error = outcome.expect_err(part);
        assert!(
            matches!(&error, Error::VerificationRefused(text) if text.contains(part)),
            "{part}: {error}"
        );
        assert!(out.is_empty(), "{part}: no half answer");
    }
}

/// Claim: a bridge address that the user names but that reports other wiring is refused, and a stored slot that holds no
/// entry stops the command. Why it matters: the bridge is the authority for its remote light client.
#[test]
fn wiring_and_slots_are_checked() {
    let other_bridge = format!("{:#x}", Address::repeat_byte(0xee));
    let (outcome, out) = run_command(Tamper::Nothing, &["--bridge-source", &other_bridge]);
    assert!(outcome.is_err(), "a bridge that the mock does not know");
    assert!(out.is_empty());
    let (outcome, _) = run_command(Tamper::Nothing, &["--remote-slot", "5"]);
    assert!(matches!(outcome, Err(Error::Beacon(text)) if text.contains("stored no block hash")));
}

fn the_proof_of_the_world() -> OpeningProof {
    let world = remote();
    OpeningProof {
        remoteSlot: REMOTE_SLOT,
        remoteHeaderRlp: encode_execution_header(&execution_header_from_json(&world.block)),
        accountProof: world.account_proof,
        storedSlot: STORED_SLOT,
        storageProof: world.storage_proof,
    }
}

/// Claim: the native walk accepts the proof of the world and refuses each wrong link: a header that does not hash to the
/// stored hash, a remote light client at another address, a storage proof for another slot, and a stored hash of zero.
/// Why it matters: each refusal is one revert of `_verifyOpening`. A walk that accepts too much sends a doomed call.
#[test]
fn the_native_walk_refuses_each_wrong_link() {
    let world = remote();
    let good = the_proof_of_the_world();
    let verified = verify_opening(&good, REMOTE_LIGHT_CLIENT, world.block_hash).unwrap();
    assert_eq!(verified.stored_block_hash, stored_hash());
    assert_eq!(
        verified.state_root.0,
        hex_to_array(world.block["stateRoot"].as_str().unwrap())
    );

    let refused = |proof: &OpeningProof, light_client: Address, stored: B256| {
        let error = verify_opening(proof, light_client, stored).expect_err("refused");
        assert!(matches!(error, Error::VerificationRefused(_)), "{error}");
    };
    refused(&good, REMOTE_LIGHT_CLIENT, B256::repeat_byte(0x99));
    refused(&good, REMOTE_LIGHT_CLIENT, B256::ZERO);
    refused(&good, Address::repeat_byte(0xc4), world.block_hash);
    let mut other_slot = good.clone();
    other_slot.storedSlot += 1;
    refused(&other_slot, REMOTE_LIGHT_CLIENT, world.block_hash);
    let mut extra_node = good.clone();
    extra_node.storageProof.push(Bytes::from_static(&[0xc0]));
    refused(&extra_node, REMOTE_LIGHT_CLIENT, world.block_hash);
    let mut no_proof = good.clone();
    no_proof.accountProof.clear();
    refused(&no_proof, REMOTE_LIGHT_CLIENT, world.block_hash);
}

fn hex_to_array(text: &str) -> [u8; 32] {
    hex::decode(text).unwrap().try_into().unwrap()
}

/// Claim: the constants of the Rust walk are the constants of the Solidity contract, and the Solidity slot rule has the
/// shape that the Rust copy implements. Why it matters: two copies of one rule drift. A drift gives a storage key that the
/// real light client never wrote, and the bridge reverts with `OpeningEntryEmpty`.
#[test]
fn the_constants_equal_the_solidity_constants() {
    // The opening proof runs in the linked library `OpeningProofLib` (the split for the gas cap).
    let source = include_str!("../../src/hardened/OpeningProofLib.sol");
    for (name, value) in [
        (
            "EXECUTION_BLOCK_HASHES_MAPPING_SLOT",
            EXECUTION_BLOCK_HASHES_MAPPING_SLOT as usize,
        ),
        ("STATE_ROOT_FIELD", STATE_ROOT_FIELD),
        ("ACCOUNT_STORAGE_ROOT_FIELD", ACCOUNT_STORAGE_ROOT_FIELD),
    ] {
        let line = format!("uint256 internal constant {name} = {value};");
        assert!(source.contains(&line), "{line}");
    }
    assert!(source.contains(
        "keccak256(abi.encode(uint256(storedSlot), EXECUTION_BLOCK_HASHES_MAPPING_SLOT))"
    ));
    assert!(source.contains("keccak256(abi.encode(executionBlockHashesSlot(storedSlot)))"));
}

/// The `eth_getProof` answer of the world for `stored_slot`, as a runner stores it, with `tamper` applied to a node.
fn cache_entry(tamper: Tamper, stored_slot: u64) -> Value {
    let world = remote();
    let key = execution_block_hashes_slot(stored_slot);
    let account = if tamper == Tamper::AccountNode {
        flipped(&world.account_proof)
    } else {
        world.account_proof.clone()
    };
    let storage = if tamper == Tamper::StorageNode {
        flipped(&world.storage_proof)
    } else {
        world.storage_proof.clone()
    };
    json!({
        "schemaVersion": 1,
        "chainId": REMOTE_CHAIN_ID,
        "blockNumber": REMOTE_BLOCK_NUMBER,
        "blockHash": format!("{:#x}", world.block_hash),
        "address": format!("{REMOTE_LIGHT_CLIENT:#x}"),
        "storedSlot": stored_slot,
        "storageKeys": [format!("{key:#x}")],
        "fetchedAt": "2026-11-01T00:00:00.000Z",
        "proof": {
            "accountProof": hex_nodes(&account),
            "storageProof": [{
                "key": format!("{key:#x}"),
                "value": format!("{:#x}", U256::from_be_bytes(stored_hash().0)),
                "proof": hex_nodes(&storage),
            }],
        },
    })
}

/// A fresh proof cache directory, removed when the value drops.
fn proof_cache(name: &str) -> Scratch {
    let directory =
        std::env::temp_dir().join(format!("opening-proof-cache-{}-{name}", std::process::id()));
    let _ = std::fs::remove_dir_all(&directory);
    std::fs::create_dir_all(&directory).unwrap();
    Scratch(directory)
}

/// Writes `entry` where the runner writes it: `<dir>/<chain id>/<address>/<block number>-<block hash>.json`.
fn write_cache_entry(cache: &Scratch, block_hash: B256, entry: &Value) {
    let directory = cache
        .0
        .join(REMOTE_CHAIN_ID.to_string())
        .join(format!("{REMOTE_LIGHT_CLIENT:#x}"));
    std::fs::create_dir_all(&directory).unwrap();
    std::fs::write(
        directory.join(format!("{REMOTE_BLOCK_NUMBER}-{block_hash:#x}.json")),
        entry.to_string(),
    )
    .unwrap();
}

fn run_with_cache(tamper: Tamper, cache: &Scratch, extra: &[&str]) -> (Result<i32>, Vec<u8>) {
    let mode = HeaderMode::Plain;
    let line = format!("proof_cache_dir = {:?}\n", cache.0.display().to_string());
    run_with_destination_lines(mode, remote_chain_url(tamper, mode), &line, extra)
}

fn assert_the_proof_of_the_world(out: &[u8]) {
    let printed: Value = serde_json::from_slice(out).unwrap();
    let world = remote();
    assert_eq!(printed["proof"]["storedSlot"], STORED_SLOT);
    assert_eq!(
        printed["proof"]["accountProof"],
        json!(hex_nodes(&world.account_proof))
    );
    assert_eq!(
        printed["proof"]["storageProof"],
        json!(hex_nodes(&world.storage_proof))
    );
    assert_eq!(printed["storedBlockHash"], format!("{:#x}", stored_hash()));
    assert_eq!(printed["verifiedNatively"], true);
}

/// Claim: with a cached answer for the block of the stored head, the command builds and verifies the proof from the cache,
/// even when the node refuses `eth_getProof` and `eth_call` at that block. The stored slot comes from the entry.
/// Why it matters: the node's proof window is shorter than the age of a stored head, so without the cache the bridge of
/// PulseChain testnet v4 could not open.
#[test]
fn a_cached_answer_is_used_when_the_node_is_out_of_its_proof_window() {
    let cache = proof_cache("hit");
    write_cache_entry(
        &cache,
        remote().block_hash,
        &cache_entry(Tamper::Nothing, STORED_SLOT),
    );
    let (outcome, out) = run_with_cache(Tamper::OutOfWindow, &cache, &[]);
    assert_eq!(outcome.unwrap(), 0);
    assert_the_proof_of_the_world(&out);
}

/// Claim: without a cache, the same node out of its window stops the command with the node's error. Why it matters: it
/// shows that the previous test passed because of the cache.
#[test]
fn without_the_cache_the_node_out_of_window_stops_the_command() {
    let cache = proof_cache("empty-out-of-window");
    let (outcome, out) = run_with_cache(Tamper::OutOfWindow, &cache, &[]);
    let error = outcome.expect_err("no answer");
    assert!(error.to_string().contains("proof window"), "{error}");
    assert!(out.is_empty());
}

/// Claim: a cached answer with a flipped node in the account proof or the storage proof is refused, and the command asks
/// the node, whose answer verifies. With a node out of its window, the tampered entry still never passes.
/// Why it matters: the cache is a file on disk and is not trusted; only a proof that verifies against the state root of
/// the header (which hashes to the hash the light client stored) is sent.
#[test]
fn a_tampered_cache_entry_is_refused_and_the_node_is_asked() {
    for (tamper, part) in [
        (Tamper::AccountNode, "account"),
        (Tamper::StorageNode, "storage"),
    ] {
        let cache = proof_cache(&format!("tampered-{part}"));
        write_cache_entry(
            &cache,
            remote().block_hash,
            &cache_entry(tamper, STORED_SLOT),
        );
        let (outcome, out) = run_with_cache(Tamper::Nothing, &cache, &[]);
        assert_eq!(outcome.unwrap(), 0, "{part}");
        assert_the_proof_of_the_world(&out);

        let (outcome, out) = run_with_cache(Tamper::OutOfWindow, &cache, &[]);
        assert!(outcome.is_err(), "{part}: a tampered entry must not pass");
        assert!(out.is_empty(), "{part}");
    }
}

/// Claim: a cache entry that is not for the request is a miss and the node is asked: an empty directory, an entry with
/// another block hash in its body, an entry for another stored slot than `--stored-slot` names, an entry whose storage
/// key is not the key of its stored slot, and a file that is not an entry.
/// Why it matters: the entry names what it proves; only the entry for this chain, block, address and key is read.
#[test]
fn a_cache_miss_falls_back_to_the_node() {
    let block_hash = remote().block_hash;
    let mut other_hash = cache_entry(Tamper::Nothing, STORED_SLOT);
    other_hash["blockHash"] = json!(format!("{:#x}", B256::repeat_byte(0x77)));
    let mut other_key = cache_entry(Tamper::Nothing, STORED_SLOT);
    other_key["storageKeys"] = json!([format!("{:#x}", B256::repeat_byte(0x01))]);
    let cases: Vec<(&str, Option<Value>, Vec<&str>)> = vec![
        ("empty", None, vec![]),
        ("other-hash", Some(other_hash), vec![]),
        ("other-key", Some(other_key), vec![]),
        (
            "other-slot",
            Some(cache_entry(Tamper::Nothing, STORED_SLOT + 1)),
            vec!["--stored-slot", "9000"],
        ),
        ("not-an-entry", Some(json!("not an entry")), vec![]),
    ];
    for (name, entry, extra) in cases {
        let cache = proof_cache(&format!("miss-{name}"));
        if let Some(entry) = entry {
            write_cache_entry(&cache, block_hash, &entry);
        }
        let (outcome, out) = run_with_cache(Tamper::Nothing, &cache, &extra);
        assert_eq!(outcome.unwrap(), 0, "{name}");
        assert_the_proof_of_the_world(&out);
        let (outcome, _) = run_with_cache(Tamper::OutOfWindow, &cache, &extra);
        assert!(
            outcome.is_err(),
            "{name}: the node was asked, so the miss fails out of window"
        );
    }
}
