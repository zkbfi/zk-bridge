//! Receipts trie builder and execution header encoder, for real and synthetic blocks.

use alloy_primitives::{keccak256, Address, Bloom, Bytes, B256, B64, U256};
use alloy_rlp::{BufMut, Encodable, Header as RlpHeader};
use alloy_trie::proof::ProofRetainer;
use alloy_trie::{HashBuilder, Nibbles};
use lc_core::execution::{ExecutionHeader, Log};
use lc_core::withdrawal::receipt_trie_key;

/// A receipts trie with the proof of every receipt.
pub struct ReceiptsTrie {
    /// The trie root, which goes into the block header as `receiptsRoot`.
    pub root: B256,
    /// For each transaction index, the proof nodes from the root down to the receipt.
    pub proofs: Vec<Vec<Bytes>>,
}

/// Builds the receipts trie for EIP-2718 encoded receipts and retains a proof for each of them.
pub fn build_receipts_trie(receipts: &[Bytes]) -> ReceiptsTrie {
    let targets: Vec<Nibbles> = (0..receipts.len() as u64).map(receipt_trie_key).collect();
    let mut entries: Vec<(Nibbles, usize)> = targets.iter().copied().zip(0..).collect();
    entries.sort_by(|left, right| left.0.cmp(&right.0));
    let mut builder = HashBuilder::default().with_proof_retainer(ProofRetainer::new(targets.clone()));
    for (key, index) in &entries {
        builder.add_leaf(*key, &receipts[*index]);
    }
    let root = builder.root();
    let nodes = builder.take_proof_nodes();
    let proofs = targets
        .iter()
        .map(|target| nodes.matching_nodes_sorted(target).into_iter().map(|(_, node)| node).collect())
        .collect();
    ReceiptsTrie { root, proofs }
}

/// Encodes a log as RLP.
pub fn encode_log(log: &Log, out: &mut dyn BufMut) {
    let payload_length = log.address.length() + log.topics.length() + log.data.length();
    RlpHeader { list: true, payload_length }.encode(out);
    log.address.encode(out);
    log.topics.encode(out);
    log.data.encode(out);
}

/// Encodes a receipt as the EIP-2718 bytes the trie stores. `transaction_type` 0 gives a bare RLP list.
pub fn encode_receipt(
    transaction_type: u8,
    success: bool,
    cumulative_gas_used: u64,
    bloom: Bloom,
    logs: &[Log],
) -> Bytes {
    let mut logs_payload = Vec::new();
    for log in logs {
        encode_log(log, &mut logs_payload);
    }
    let logs_length = RlpHeader { list: true, payload_length: logs_payload.len() }.length() + logs_payload.len();
    let status = u8::from(success);
    let payload_length = status.length() + cumulative_gas_used.length() + bloom.length() + logs_length;
    let mut out = Vec::new();
    if transaction_type != 0 {
        out.push(transaction_type);
    }
    RlpHeader { list: true, payload_length }.encode(&mut out);
    status.encode(&mut out);
    cumulative_gas_used.encode(&mut out);
    bloom.encode(&mut out);
    RlpHeader { list: true, payload_length: logs_payload.len() }.encode(&mut out);
    out.extend_from_slice(&logs_payload);
    Bytes::from(out)
}

/// Encodes an execution header as RLP, writing only the fields that are `Some` (in fork order).
pub fn encode_execution_header(header: &ExecutionHeader) -> Bytes {
    let mut payload = Vec::new();
    header.parent_hash.encode(&mut payload);
    header.ommers_hash.encode(&mut payload);
    header.beneficiary.encode(&mut payload);
    header.state_root.encode(&mut payload);
    header.transactions_root.encode(&mut payload);
    header.receipts_root.encode(&mut payload);
    header.logs_bloom.encode(&mut payload);
    header.difficulty.encode(&mut payload);
    header.number.encode(&mut payload);
    header.gas_limit.encode(&mut payload);
    header.gas_used.encode(&mut payload);
    header.timestamp.encode(&mut payload);
    header.extra_data.encode(&mut payload);
    header.mix_hash.encode(&mut payload);
    header.nonce.encode(&mut payload);
    if let Some(value) = header.base_fee_per_gas {
        value.encode(&mut payload);
    }
    if let Some(value) = header.withdrawals_root {
        value.encode(&mut payload);
    }
    if let Some(value) = header.blob_gas_used {
        value.encode(&mut payload);
    }
    if let Some(value) = header.excess_blob_gas {
        value.encode(&mut payload);
    }
    if let Some(value) = header.parent_beacon_block_root {
        value.encode(&mut payload);
    }
    if let Some(value) = header.requests_hash {
        value.encode(&mut payload);
    }
    let mut out = Vec::new();
    RlpHeader { list: true, payload_length: payload.len() }.encode(&mut out);
    out.extend_from_slice(&payload);
    Bytes::from(out)
}

/// Hash of an encoded header: the execution block hash.
pub fn header_hash(header_rlp: &[u8]) -> B256 {
    keccak256(header_rlp)
}

/// A Shanghai-style execution header (PulseChain rules) with the given receipts root and number.
pub fn shanghai_header(number: u64, receipts_root: B256) -> ExecutionHeader {
    ExecutionHeader {
        parent_hash: B256::repeat_byte(0x01),
        ommers_hash: B256::repeat_byte(0x02),
        beneficiary: Address::repeat_byte(0x03),
        state_root: B256::repeat_byte(0x04),
        transactions_root: B256::repeat_byte(0x05),
        receipts_root,
        logs_bloom: Bloom::ZERO,
        difficulty: U256::ZERO,
        number,
        gas_limit: 30_000_000,
        gas_used: 21_000,
        timestamp: 1_700_000_000,
        extra_data: Bytes::from_static(b"synthetic"),
        mix_hash: B256::repeat_byte(0x06),
        nonce: B64::ZERO,
        base_fee_per_gas: Some(7),
        withdrawals_root: Some(B256::repeat_byte(0x07)),
        blob_gas_used: None,
        excess_blob_gas: None,
        parent_beacon_block_root: None,
        requests_hash: None,
    }
}

/// A Prague-style execution header (Ethereum rules) with the given receipts root and number.
pub fn prague_header(number: u64, receipts_root: B256) -> ExecutionHeader {
    ExecutionHeader {
        blob_gas_used: Some(0),
        excess_blob_gas: Some(0),
        parent_beacon_block_root: Some(B256::repeat_byte(0x08)),
        requests_hash: Some(B256::repeat_byte(0x09)),
        ..shanghai_header(number, receipts_root)
    }
}

fn quantity(value: &serde_json::Value) -> u64 {
    let text = value.as_str().unwrap_or_else(|| panic!("expected a quantity, got {value}"));
    u64::from_str_radix(text.trim_start_matches("0x"), 16)
        .unwrap_or_else(|error| panic!("bad quantity {text}: {error}"))
}

fn optional_hash(value: &serde_json::Value) -> Option<B256> {
    value.as_str().map(|_| crate::json::hex_b256(value))
}

fn optional_quantity(value: &serde_json::Value) -> Option<u64> {
    value.as_str().map(|_| quantity(value))
}

/// Rebuilds an execution header from the JSON of `eth_getBlockByNumber`. The caller checks `keccak256(rlp)` against the
/// `hash` field: that check proves the rebuild is exact.
pub fn execution_header_from_json(block: &serde_json::Value) -> ExecutionHeader {
    use crate::json::{hex_b256, hex_bytes, hex_fixed};
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
pub fn logs_from_json(receipt: &serde_json::Value) -> Vec<Log> {
    use crate::json::{hex_b256, hex_bytes};
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
pub fn receipts_from_json(receipts: &serde_json::Value) -> Vec<Bytes> {
    use crate::json::hex_fixed;
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
