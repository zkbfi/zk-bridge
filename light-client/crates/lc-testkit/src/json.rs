//! Fixture loaders, and the JSON parsers of `lc_core::json` under the old path.
//!
//! The parsers panic with a clear message on malformed input: a malformed fixture is a bug.

use alloy_primitives::hex;
use lc_core::types::{
    BeaconBlockHeader, ExecutionPayloadHeader, HeaderForm, LightClientHeader, LightClientUpdate, SyncCommittee,
};
use serde_json::{json, Value};
use std::path::PathBuf;

/// Directory that holds the fixtures: `light-client/tests/fixtures`.
pub fn fixtures_dir() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../tests/fixtures")
}

/// Loads a fixture file and returns the whole wrapper object `{source_url, fetched_on, response}`.
pub fn load_fixture(relative_path: &str) -> Value {
    let path = fixtures_dir().join(relative_path);
    let text = std::fs::read_to_string(&path).unwrap_or_else(|error| panic!("cannot read {}: {error}", path.display()));
    serde_json::from_str(&text).unwrap_or_else(|error| panic!("cannot parse {}: {error}", path.display()))
}

/// Loads a fixture and returns its `response` field. It checks that the source URL and the fetch date are recorded.
pub fn load_response(relative_path: &str) -> Value {
    let wrapper = load_fixture(relative_path);
    assert!(
        wrapper["source_url"]
            .as_str()
            .is_some_and(|url| url.starts_with("http") || url.starts_with("POST") || url.starts_with("derived")),
        "{relative_path} lacks source_url"
    );
    assert!(wrapper["fetched_on"].as_str().is_some_and(|date| date.len() == 10), "{relative_path} lacks fetched_on");
    wrapper["response"].clone()
}

fn hex_text(bytes: &[u8]) -> String {
    hex::encode_prefixed(bytes)
}

/// A beacon block header as the beacon API writes it.
pub fn beacon_header_json(header: &BeaconBlockHeader) -> Value {
    json!({
        "slot": header.slot.to_string(),
        "proposer_index": header.proposer_index.to_string(),
        "parent_root": hex_text(header.parent_root.as_slice()),
        "state_root": hex_text(header.state_root.as_slice()),
        "body_root": hex_text(header.body_root.as_slice()),
    })
}

fn execution_payload_header_json(header: &ExecutionPayloadHeader) -> Value {
    let mut value = json!({
        "parent_hash": hex_text(header.parent_hash.as_slice()),
        "fee_recipient": hex_text(header.fee_recipient.as_slice()),
        "state_root": hex_text(header.state_root.as_slice()),
        "receipts_root": hex_text(header.receipts_root.as_slice()),
        "logs_bloom": hex_text(&header.logs_bloom),
        "prev_randao": hex_text(header.prev_randao.as_slice()),
        "block_number": header.block_number.to_string(),
        "gas_limit": header.gas_limit.to_string(),
        "gas_used": header.gas_used.to_string(),
        "timestamp": header.timestamp.to_string(),
        "extra_data": hex_text(&header.extra_data),
        "base_fee_per_gas": header.base_fee_per_gas.to_string(),
        "block_hash": hex_text(header.block_hash.as_slice()),
        "transactions_root": hex_text(header.transactions_root.as_slice()),
        "withdrawals_root": hex_text(header.withdrawals_root.as_slice()),
    });
    if let Some(blob) = header.blob_gas {
        value["blob_gas_used"] = json!(blob.blob_gas_used.to_string());
        value["excess_blob_gas"] = json!(blob.excess_blob_gas.to_string());
    }
    value
}

/// A light-client header as the beacon API writes it: the full form has `execution`, the compact (Gloas) form has
/// `execution_block_hash`.
pub fn light_client_header_json(header: &LightClientHeader) -> Value {
    match header.form {
        HeaderForm::Full => json!({
            "beacon": beacon_header_json(&header.beacon),
            "execution": execution_payload_header_json(&header.execution),
            "execution_branch": branch_json(&header.execution_branch),
        }),
        HeaderForm::Compact => json!({
            "beacon": beacon_header_json(&header.beacon),
            "execution_block_hash": hex_text(header.execution_block_hash().as_slice()),
            "execution_branch": branch_json(&header.execution_branch),
        }),
    }
}

pub fn branch_json(branch: &[alloy_primitives::B256]) -> Vec<String> {
    branch.iter().map(|node| hex_text(node.as_slice())).collect()
}

/// A sync committee as the beacon API writes it.
pub fn sync_committee_json(committee: &SyncCommittee) -> Value {
    json!({
        "pubkeys": committee.pubkeys.iter().map(|key| hex_text(key.as_slice())).collect::<Vec<_>>(),
        "aggregate_pubkey": hex_text(committee.aggregate_pubkey.as_slice()),
    })
}

/// The `data` object of a light-client update, in the shape a beacon node serves it. The parser
/// `lc_core::json::light_client_update` reads it back to the same update.
pub fn light_client_update_json(update: &LightClientUpdate) -> Value {
    let mut data = json!({
        "attested_header": light_client_header_json(&update.attested_header),
        "finalized_header": light_client_header_json(&update.finalized_header),
        "finality_branch": branch_json(&update.finality_branch),
        "sync_aggregate": {
            "sync_committee_bits": hex_text(&update.sync_aggregate.sync_committee_bits),
            "sync_committee_signature": hex_text(&update.sync_aggregate.sync_committee_signature),
        },
        "signature_slot": update.signature_slot.to_string(),
    });
    if let Some(next) = &update.next_sync_committee {
        data["next_sync_committee"] = sync_committee_json(&next.committee);
        data["next_sync_committee_branch"] = json!(branch_json(&next.branch));
    }
    data
}

pub use lc_core::json::*;
