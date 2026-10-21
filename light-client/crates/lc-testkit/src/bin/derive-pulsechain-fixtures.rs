//! Derives the PulseChain light-client and withdrawal-path fixtures from raw beacon data.
//!
//! Usage: `derive-pulsechain-fixtures <work-dir> <fixture-dir> <beacon-url> <fetched-on>`
//!
//! Input (written by `scripts/fetch-fixtures.sh pulsechain` into `<work-dir>`): the attested state as SSZ (about 12-18 MB),
//! the attested, finalized and ancestor blocks as SSZ, the child block as JSON (it carries the sync aggregate that
//! signs the attested header), and headers as JSON.
//!
//! Every branch is computed from the real state and real block bodies and checked against the roots that the node
//! reports: the computed state root must equal the attested header `state_root`, and each computed body root must
//! equal the header `body_root`. The tool stops with a message when a root differs.

use alloy_primitives::{hex, B256};
use lc_core::layout::ExecutionHeaderForm;
use lc_core::ssz::{branch_for_leaf, u64_chunk};
use lc_core::types::{BeaconBlockHeader, ExecutionPayloadHeader};
use lc_testkit::json::{beacon_header, hex_b256};
use lc_testkit::ssz_state::{parse_signed_block, parse_state, ParsedBlock};
use serde_json::{json, Value};
use std::path::Path;

const FIELD_BLOCK_ROOTS: usize = 5;
const FIELD_FINALIZED_CHECKPOINT: usize = 20;
const FIELD_CURRENT_SYNC_COMMITTEE: usize = 22;
const FIELD_NEXT_SYNC_COMMITTEE: usize = 23;
const BODY_FIELD_EXECUTION_PAYLOAD: usize = 9;
const PAYLOAD_FIELD_BLOCK_HASH: usize = 12;

fn read_json(path: &Path) -> Value {
    serde_json::from_slice(&std::fs::read(path).unwrap_or_else(|e| panic!("{}: {e}", path.display()))).expect("json")
}

fn hex_list(branch: &[B256]) -> Value {
    Value::Array(branch.iter().map(|node| json!(format!("0x{}", hex::encode(node)))).collect())
}

fn header_json(header: &BeaconBlockHeader) -> Value {
    json!({
        "slot": header.slot.to_string(),
        "proposer_index": header.proposer_index.to_string(),
        "parent_root": format!("{:#x}", header.parent_root),
        "state_root": format!("{:#x}", header.state_root),
        "body_root": format!("{:#x}", header.body_root),
    })
}

fn payload_json(payload: &ExecutionPayloadHeader) -> Value {
    json!({
        "parent_hash": format!("{:#x}", payload.parent_hash),
        "fee_recipient": format!("{:#x}", payload.fee_recipient),
        "state_root": format!("{:#x}", payload.state_root),
        "receipts_root": format!("{:#x}", payload.receipts_root),
        "logs_bloom": format!("0x{}", hex::encode(&payload.logs_bloom)),
        "prev_randao": format!("{:#x}", payload.prev_randao),
        "block_number": payload.block_number.to_string(),
        "gas_limit": payload.gas_limit.to_string(),
        "gas_used": payload.gas_used.to_string(),
        "timestamp": payload.timestamp.to_string(),
        "extra_data": format!("0x{}", hex::encode(&payload.extra_data)),
        "base_fee_per_gas": payload.base_fee_per_gas.to_string(),
        "block_hash": format!("{:#x}", payload.block_hash),
        "transactions_root": format!("{:#x}", payload.transactions_root),
        "withdrawals_root": format!("{:#x}", payload.withdrawals_root),
    })
}

/// A block read from SSZ, checked against its header, with the two execution branches.
struct CheckedBlock {
    block: ParsedBlock,
    execution_branch: Vec<B256>,
    block_hash_branch: Vec<B256>,
}

fn read_block(path: &Path, header_file: &Path) -> CheckedBlock {
    let block = parse_signed_block(&std::fs::read(path).unwrap_or_else(|e| panic!("{}: {e}", path.display())));
    let expected = beacon_header(&read_json(header_file)["data"]["header"]["message"]);
    assert_eq!(block.header.slot, expected.slot, "slot of {}", path.display());
    assert_eq!(
        block.header.body_root,
        expected.body_root,
        "body root of {} (the SSZ hasher disagrees with the node)",
        path.display()
    );
    assert_eq!(block.header.state_root, expected.state_root);
    let (_, execution_branch) = branch_for_leaf(&block.body_field_roots, BODY_FIELD_EXECUTION_PAYLOAD);
    let leaves = block.payload.field_roots(ExecutionHeaderForm::Capella).expect("payload leaves");
    let (_, mut block_hash_branch) = branch_for_leaf(&leaves, PAYLOAD_FIELD_BLOCK_HASH);
    block_hash_branch.extend(&execution_branch);
    CheckedBlock { block, execution_branch, block_hash_branch }
}

fn light_client_header_json(block: &CheckedBlock) -> Value {
    json!({
        "beacon": header_json(&block.block.header),
        "execution": payload_json(&block.block.payload),
        "execution_branch": hex_list(&block.execution_branch),
    })
}

fn committee_json(committee: &lc_core::types::SyncCommittee) -> Value {
    json!({
        "pubkeys": committee.pubkeys.iter().map(|key| format!("0x{}", hex::encode(key))).collect::<Vec<_>>(),
        "aggregate_pubkey": format!("0x{}", hex::encode(committee.aggregate_pubkey)),
    })
}

fn write_fixture(directory: &Path, name: &str, source_url: &str, fetched_on: &str, response: Value) {
    let wrapper = json!({ "source_url": source_url, "fetched_on": fetched_on, "response": response });
    let path = directory.join(name);
    std::fs::write(&path, serde_json::to_string_pretty(&wrapper).expect("json")).expect("write");
    println!("wrote {}", path.display());
}

fn main() {
    let arguments: Vec<String> = std::env::args().collect();
    assert_eq!(
        arguments.len(),
        5,
        "usage: derive-pulsechain-fixtures <work-dir> <fixture-dir> <beacon-url> <fetched-on>"
    );
    let (work, out, beacon, fetched_on) =
        (Path::new(&arguments[1]), Path::new(&arguments[2]), &arguments[3], &arguments[4]);

    // The attested state, hashed in full and compared with the node.
    let attested_header = beacon_header(&read_json(&work.join("attested_header.json"))["data"]["header"]["message"]);
    let state = parse_state(&std::fs::read(work.join("attested_state.ssz")).expect("state"));
    assert_eq!(state.slot, attested_header.slot);
    assert_eq!(
        state.root(),
        attested_header.state_root,
        "the SSZ state hasher disagrees with the node: the PulseChain preset may differ from the mainnet preset"
    );
    println!("state root {:#x} matches the node", state.root());

    let attested = read_block(&work.join("attested_block.ssz"), &work.join("attested_header.json"));
    let finalized = read_block(&work.join("finalized_block.ssz"), &work.join("finalized_header.json"));
    let ancestor = read_block(&work.join("ancestor_block.ssz"), &work.join("ancestor_header.json"));

    // Finality: the state names the finalized block.
    let checkpoints = read_json(&work.join("finality_checkpoints.json"));
    let finalized_root = hex_b256(&checkpoints["data"]["finalized"]["root"]);
    assert_eq!(state.finalized_checkpoint.1, finalized_root);
    assert_eq!(finalized.block.header.hash_tree_root(), finalized_root, "finalized block root");
    let mut finality_branch = vec![u64_chunk(state.finalized_checkpoint.0)];
    finality_branch.extend(branch_for_leaf(&state.field_roots, FIELD_FINALIZED_CHECKPOINT).1);
    let next_branch = branch_for_leaf(&state.field_roots, FIELD_NEXT_SYNC_COMMITTEE).1;
    let current_branch = branch_for_leaf(&state.field_roots, FIELD_CURRENT_SYNC_COMMITTEE).1;

    // The child block carries the sync aggregate that signs the attested header.
    let child = read_json(&work.join("child_block.json"));
    let message = &child["data"]["message"];
    assert_eq!(hex_b256(&message["parent_root"]), attested.block.header.hash_tree_root());
    let sync_aggregate = &message["body"]["sync_aggregate"];
    let signature_slot: u64 = message["slot"].as_str().expect("slot").parse().expect("slot");

    // The older head for the store.
    let previous = beacon_header(&read_json(&work.join("previous_header.json"))["data"]["header"]["message"]);

    let update = json!({
        "attested_header": light_client_header_json(&attested),
        "next_sync_committee": committee_json(&state.next_sync_committee),
        "next_sync_committee_branch": hex_list(&next_branch),
        "finalized_header": light_client_header_json(&finalized),
        "finality_branch": hex_list(&finality_branch),
        "sync_aggregate": sync_aggregate,
        "signature_slot": signature_slot.to_string(),
    });
    let store = json!({
        "header_root": format!("{:#x}", previous.hash_tree_root()),
        "header_slot": previous.slot.to_string(),
        "current_sync_committee": committee_json(&state.current_sync_committee),
        "current_sync_committee_branch": hex_list(&current_branch),
        "state_root_of_committee": format!("{:#x}", attested_header.state_root),
    });
    let source = format!(
        "derived from {beacon}: SSZ state {:#x} (GET /eth/v2/debug/beacon/states/<root>), SSZ blocks (GET /eth/v2/beacon/blocks/<root>), block {} (GET /eth/v2/beacon/blocks/<slot>)",
        attested_header.state_root, signature_slot
    );
    write_fixture(out, "light_client_update.json", &source, fetched_on, json!({ "update": update, "store": store }));

    // Beacon paths for withdrawal proofs: anchor = attested header; deposit candidates = finalized block and the ancestor.
    let path_entry = |name: &str, block: &CheckedBlock| {
        let slot = block.block.header.slot;
        let mut roots_branch = branch_for_leaf(&state.block_roots, (slot % 8192) as usize).1;
        roots_branch.extend(branch_for_leaf(&state.field_roots, FIELD_BLOCK_ROOTS).1);
        json!({
            "name": name,
            "deposit_header": header_json(&block.block.header),
            "block_roots_branch": hex_list(&roots_branch),
            "block_hash_branch": hex_list(&block.block_hash_branch),
            "execution_block_number": block.block.payload.block_number,
            "execution_block_hash": format!("{:#x}", block.block.payload.block_hash),
        })
    };
    let paths = json!({
        "anchor_header": header_json(&attested.block.header),
        "entries": [path_entry("finalized", &finalized), path_entry("ancestor", &ancestor)],
    });
    write_fixture(out, "beacon_paths.json", &source, fetched_on, paths);
}
