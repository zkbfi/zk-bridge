//! Receipts trie builder and execution header encoder, for real and synthetic blocks.
//!
//! The prover service builds the execution part of a withdrawal with these functions.

use crate::execution::{ExecutionHeader, Log};
use crate::withdrawal::receipt_trie_key;
use alloy_primitives::{keccak256, Bloom, Bytes, B256};
use alloy_rlp::{BufMut, Encodable, Header as RlpHeader};
use alloy_trie::proof::ProofRetainer;
use alloy_trie::{HashBuilder, Nibbles};

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
