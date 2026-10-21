//! Helpers shared by the tools in `src/bin/` that derive fixtures from raw beacon data (SSZ states and blocks).

use crate::json::beacon_header;
use crate::ssz_state::{parse_signed_block, ParsedBlock};
use alloy_primitives::{hex, B256};
use lc_core::layout::ExecutionHeaderForm;
use lc_core::ssz::branch_for_leaf;
use lc_core::types::BeaconBlockHeader;
use serde_json::{json, Value};
use std::path::Path;

/// Field index of `execution_payload` in `BeaconBlockBody`.
const BODY_FIELD_EXECUTION_PAYLOAD: usize = 9;
/// Field index of `block_hash` in `ExecutionPayload`.
const PAYLOAD_FIELD_BLOCK_HASH: usize = 12;

/// Reads a JSON file.
///
/// # Panics
/// Panics with the path when the file is missing or is not JSON.
pub fn read_json(path: &Path) -> Value {
    serde_json::from_slice(&std::fs::read(path).unwrap_or_else(|e| panic!("{}: {e}", path.display()))).expect("json")
}

/// A branch as a JSON list of `0x` hex strings.
pub fn hex_list(branch: &[B256]) -> Value {
    Value::Array(branch.iter().map(|node| json!(format!("0x{}", hex::encode(node)))).collect())
}

/// A beacon block header as the beacon API writes it.
pub fn header_json(header: &BeaconBlockHeader) -> Value {
    json!({
        "slot": header.slot.to_string(),
        "proposer_index": header.proposer_index.to_string(),
        "parent_root": format!("{:#x}", header.parent_root),
        "state_root": format!("{:#x}", header.state_root),
        "body_root": format!("{:#x}", header.body_root),
    })
}

/// A block read from SSZ, checked against its header, with the two execution branches.
pub struct CheckedBlock {
    /// The parsed block.
    pub block: ParsedBlock,
    /// Branch from the execution payload root to the body root (the light-client execution branch).
    pub execution_branch: Vec<B256>,
    /// Branch from `execution_payload.block_hash` to the body root (payload branch, then body branch).
    pub block_hash_branch: Vec<B256>,
}

/// Parses a Capella `SignedBeaconBlock` and checks it against the header JSON that the node served for it.
///
/// # Panics
/// Panics when the slot, the body root or the state root differs from the node's header (the SSZ hasher would be wrong).
pub fn read_block(path: &Path, header_file: &Path) -> CheckedBlock {
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

/// Writes a fixture wrapper `{source_url, fetched_on, response}`.
pub fn write_fixture(directory: &Path, name: &str, source_url: &str, fetched_on: &str, response: Value) {
    let wrapper = json!({ "source_url": source_url, "fetched_on": fetched_on, "response": response });
    let path = directory.join(name);
    std::fs::write(&path, serde_json::to_string_pretty(&wrapper).expect("json")).expect("write");
    println!("wrote {}", path.display());
}
