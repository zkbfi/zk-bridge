//! Parsers from beacon API JSON (as served by beacon nodes) to `lc-core` types.
//!
//! All parsers panic with a clear message on malformed input: they are test support, and a malformed fixture is a bug.

use alloy_primitives::{hex, Address, Bytes, FixedBytes, B256, U256};
use lc_core::types::{
    BeaconBlockHeader, BlobGasFields, BlsPublicKey, ExecutionPayloadHeader, LightClientHeader, LightClientUpdate,
    NextSyncCommittee, SyncAggregate, SyncCommittee,
};
use serde_json::Value;
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

/// Decodes a `0x` hex string into bytes.
pub fn hex_bytes(value: &Value) -> Vec<u8> {
    let text = value.as_str().unwrap_or_else(|| panic!("expected a hex string, got {value}"));
    hex::decode(text).unwrap_or_else(|error| panic!("bad hex {text}: {error}"))
}

/// Decodes a `0x` hex string of exactly 32 bytes.
pub fn hex_b256(value: &Value) -> B256 {
    B256::try_from(hex_bytes(value).as_slice()).unwrap_or_else(|_| panic!("expected 32 bytes, got {value}"))
}

/// Parses a decimal string as `u64`.
pub fn decimal_u64(value: &Value) -> u64 {
    let text = value.as_str().unwrap_or_else(|| panic!("expected a decimal string, got {value}"));
    text.parse().unwrap_or_else(|error| panic!("bad number {text}: {error}"))
}

/// Parses a branch (list of 32-byte hex strings).
pub fn branch(value: &Value) -> Vec<B256> {
    value.as_array().unwrap_or_else(|| panic!("expected a branch, got {value}")).iter().map(hex_b256).collect()
}

/// Parses a beacon block header object (`slot`, `proposer_index`, `parent_root`, `state_root`, `body_root`).
pub fn beacon_header(value: &Value) -> BeaconBlockHeader {
    BeaconBlockHeader {
        slot: decimal_u64(&value["slot"]),
        proposer_index: decimal_u64(&value["proposer_index"]),
        parent_root: hex_b256(&value["parent_root"]),
        state_root: hex_b256(&value["state_root"]),
        body_root: hex_b256(&value["body_root"]),
    }
}

/// Parses an execution payload header object. Blob gas fields are optional (Deneb and later).
pub fn execution_payload_header(value: &Value) -> ExecutionPayloadHeader {
    let blob_gas = value.get("blob_gas_used").map(|used| BlobGasFields {
        blob_gas_used: decimal_u64(used),
        excess_blob_gas: decimal_u64(&value["excess_blob_gas"]),
    });
    ExecutionPayloadHeader {
        parent_hash: hex_b256(&value["parent_hash"]),
        fee_recipient: Address::try_from(hex_bytes(&value["fee_recipient"]).as_slice()).expect("fee recipient"),
        state_root: hex_b256(&value["state_root"]),
        receipts_root: hex_b256(&value["receipts_root"]),
        logs_bloom: hex_bytes(&value["logs_bloom"]),
        prev_randao: hex_b256(&value["prev_randao"]),
        block_number: decimal_u64(&value["block_number"]),
        gas_limit: decimal_u64(&value["gas_limit"]),
        gas_used: decimal_u64(&value["gas_used"]),
        timestamp: decimal_u64(&value["timestamp"]),
        extra_data: hex_bytes(&value["extra_data"]),
        base_fee_per_gas: U256::from_str_radix(value["base_fee_per_gas"].as_str().expect("base fee"), 10)
            .expect("base fee"),
        block_hash: hex_b256(&value["block_hash"]),
        transactions_root: hex_b256(&value["transactions_root"]),
        withdrawals_root: hex_b256(&value["withdrawals_root"]),
        blob_gas,
    }
}

/// Parses a light-client header (`beacon`, `execution`, `execution_branch`).
pub fn light_client_header(value: &Value) -> LightClientHeader {
    LightClientHeader {
        beacon: beacon_header(&value["beacon"]),
        execution: execution_payload_header(&value["execution"]),
        execution_branch: branch(&value["execution_branch"]),
    }
}

/// Parses a sync committee object (`pubkeys`, `aggregate_pubkey`).
pub fn sync_committee(value: &Value) -> SyncCommittee {
    let key = |item: &Value| BlsPublicKey::try_from(hex_bytes(item).as_slice()).expect("48 byte public key");
    SyncCommittee {
        pubkeys: value["pubkeys"].as_array().expect("pubkeys").iter().map(key).collect(),
        aggregate_pubkey: key(&value["aggregate_pubkey"]),
    }
}

/// Parses a sync aggregate object (`sync_committee_bits`, `sync_committee_signature`).
pub fn sync_aggregate(value: &Value) -> SyncAggregate {
    SyncAggregate {
        sync_committee_bits: hex_bytes(&value["sync_committee_bits"]).try_into().expect("64 byte bit vector"),
        sync_committee_signature: hex_bytes(&value["sync_committee_signature"]).try_into().expect("96 byte signature"),
    }
}

/// Parses the `data` object of a light-client update or finality update.
///
/// A finality update has no `next_sync_committee` field, so the field is optional.
pub fn light_client_update(data: &Value) -> LightClientUpdate {
    let next_sync_committee = data.get("next_sync_committee").map(|committee| NextSyncCommittee {
        committee: sync_committee(committee),
        branch: branch(&data["next_sync_committee_branch"]),
    });
    LightClientUpdate {
        attested_header: light_client_header(&data["attested_header"]),
        next_sync_committee,
        finalized_header: light_client_header(&data["finalized_header"]),
        finality_branch: branch(&data["finality_branch"]),
        sync_aggregate: sync_aggregate(&data["sync_aggregate"]),
        signature_slot: decimal_u64(&data["signature_slot"]),
    }
}

/// A parsed bootstrap: the header, the current committee and the branch.
pub struct Bootstrap {
    /// The bootstrap header.
    pub header: LightClientHeader,
    /// The current sync committee.
    pub committee: SyncCommittee,
    /// Branch from the committee to the header state root.
    pub branch: Vec<B256>,
}

/// Parses the `data` object of a bootstrap response.
pub fn bootstrap(data: &Value) -> Bootstrap {
    Bootstrap {
        header: light_client_header(&data["header"]),
        committee: sync_committee(&data["current_sync_committee"]),
        branch: branch(&data["current_sync_committee_branch"]),
    }
}

/// Parses raw bytes from a hex string into `Bytes`.
pub fn hex_to_bytes(value: &Value) -> Bytes {
    Bytes::from(hex_bytes(value))
}

/// Parses a hex string into any fixed-size byte array type.
pub fn hex_fixed<const N: usize>(value: &Value) -> FixedBytes<N> {
    FixedBytes::<N>::try_from(hex_bytes(value).as_slice()).unwrap_or_else(|_| panic!("expected {N} bytes, got {value}"))
}

/// Builds a store from a bootstrap. The header root and slot are those of the bootstrap header.
pub fn store_from_bootstrap(
    bootstrap: &Bootstrap,
    next_sync_committee: Option<SyncCommittee>,
) -> lc_core::types::LightClientStore {
    lc_core::types::LightClientStore {
        header_root: bootstrap.header.beacon.hash_tree_root(),
        header_slot: bootstrap.header.beacon.slot,
        current_sync_committee: bootstrap.committee.clone(),
        next_sync_committee,
    }
}
