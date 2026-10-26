//! Parsers from beacon API and execution API JSON to `lc-core` types.
//!
//! The parsers panic with a clear message on malformed input. A caller that reads a live node wraps them in
//! `std::panic::catch_unwind`. The module exists only with the cargo feature `json`, so the light-client guest does
//! not link `serde_json`.

use crate::execution::{ExecutionHeader, Log};
use crate::receipts::encode_receipt;
use crate::types::{
    BeaconBlockHeader, BlobGasFields, BlsPublicKey, ExecutionPayloadHeader, LightClientHeader, LightClientUpdate,
    NextSyncCommittee, SyncAggregate, SyncCommittee,
};
use alloy_primitives::{hex, Address, Bloom, Bytes, FixedBytes, B256, B64, U256};
use serde_json::Value;

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

/// Parses a light-client header in either form. The keys decide: `execution` means the full form (Capella to Fulu),
/// `execution_block_hash` means the compact form (Gloas). A header with both or neither is malformed.
pub fn light_client_header(value: &Value) -> LightClientHeader {
    let beacon = beacon_header(&value["beacon"]);
    let execution_branch = branch(&value["execution_branch"]);
    match (value.get("execution"), value.get("execution_block_hash")) {
        (Some(execution), None) => {
            LightClientHeader::full(beacon, execution_payload_header(execution), execution_branch)
        }
        (None, Some(hash)) => LightClientHeader::compact(beacon, hex_b256(hash), execution_branch, Vec::new()),
        _ => panic!("a light-client header has exactly one of `execution` and `execution_block_hash`"),
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
    let attested_header = light_client_header(&data["attested_header"]);
    let finalized_header = light_client_header(&data["finalized_header"]);
    assert_eq!(
        attested_header.form, finalized_header.form,
        "all headers of one light-client update use one form (Gloas objects use the compact form for every header)"
    );
    LightClientUpdate {
        attested_header,
        next_sync_committee,
        finalized_header,
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
) -> crate::types::LightClientStore {
    crate::types::LightClientStore {
        header_root: bootstrap.header.beacon.hash_tree_root(),
        header_slot: bootstrap.header.beacon.slot,
        current_sync_committee: bootstrap.committee.clone(),
        next_sync_committee,
    }
}

/// Parses a `0x` quantity.
pub fn quantity(value: &Value) -> u64 {
    let text = value.as_str().unwrap_or_else(|| panic!("expected a quantity, got {value}"));
    u64::from_str_radix(text.trim_start_matches("0x"), 16)
        .unwrap_or_else(|error| panic!("bad quantity {text}: {error}"))
}

fn optional_hash(value: &Value) -> Option<B256> {
    value.as_str().map(|_| hex_b256(value))
}

fn optional_quantity(value: &Value) -> Option<u64> {
    value.as_str().map(|_| quantity(value))
}

/// Rebuilds an execution header from the JSON of `eth_getBlockByNumber`. The caller checks `keccak256(rlp)` against the
/// `hash` field: that check proves the rebuild is exact.
pub fn execution_header_from_json(block: &Value) -> ExecutionHeader {
    ExecutionHeader {
        parent_hash: hex_b256(&block["parentHash"]),
        ommers_hash: hex_b256(&block["sha3Uncles"]),
        beneficiary: Address::from_slice(&hex_bytes(&block["miner"])),
        state_root: hex_b256(&block["stateRoot"]),
        transactions_root: hex_b256(&block["transactionsRoot"]),
        receipts_root: hex_b256(&block["receiptsRoot"]),
        logs_bloom: Bloom::from(hex_fixed::<256>(&block["logsBloom"])),
        difficulty: U256::from_str_radix(
            block["difficulty"].as_str().expect("difficulty").trim_start_matches("0x"),
            16,
        )
        .expect("difficulty"),
        number: quantity(&block["number"]),
        gas_limit: quantity(&block["gasLimit"]),
        gas_used: quantity(&block["gasUsed"]),
        timestamp: quantity(&block["timestamp"]),
        extra_data: Bytes::from(hex_bytes(&block["extraData"])),
        mix_hash: hex_b256(&block["mixHash"]),
        nonce: B64::from(hex_fixed::<8>(&block["nonce"])),
        base_fee_per_gas: optional_quantity(&block["baseFeePerGas"]),
        withdrawals_root: optional_hash(&block["withdrawalsRoot"]),
        blob_gas_used: optional_quantity(&block["blobGasUsed"]),
        excess_blob_gas: optional_quantity(&block["excessBlobGas"]),
        parent_beacon_block_root: optional_hash(&block["parentBeaconBlockRoot"]),
        requests_hash: optional_hash(&block["requestsHash"]),
    }
}

/// The logs of one JSON receipt.
pub fn logs_from_json(receipt: &Value) -> Vec<Log> {
    receipt["logs"]
        .as_array()
        .expect("logs")
        .iter()
        .map(|log| Log {
            address: Address::from_slice(&hex_bytes(&log["address"])),
            topics: log["topics"].as_array().expect("topics").iter().map(hex_b256).collect(),
            data: Bytes::from(hex_bytes(&log["data"])),
        })
        .collect()
}

/// Encodes every receipt of an `eth_getBlockReceipts` result as the EIP-2718 bytes the trie stores.
pub fn receipts_from_json(receipts: &Value) -> Vec<Bytes> {
    receipts
        .as_array()
        .expect("receipts")
        .iter()
        .map(|receipt| {
            encode_receipt(
                quantity(&receipt["type"]) as u8,
                quantity(&receipt["status"]) == 1,
                quantity(&receipt["cumulativeGasUsed"]),
                Bloom::from(hex_fixed::<256>(&receipt["logsBloom"])),
                &logs_from_json(receipt),
            )
        })
        .collect()
}
