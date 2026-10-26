//! Receipts and transactions trie builder and execution header encoder, for real and synthetic blocks.
//!
//! The builders live in `lc_core::receipts` and `lc_core::json` (the prover service uses them). This module re-exports
//! them under the old paths and adds the synthetic execution headers.

use alloy_primitives::{Address, Bloom, Bytes, B256, B64, U256};
use lc_core::execution::ExecutionHeader;

pub use lc_core::json::{execution_header_from_json, logs_from_json, receipts_from_json};
pub use lc_core::receipts::{
    build_indexed_trie, encode_execution_header, encode_log, encode_receipt, header_hash, IndexedTrie,
};

/// A Shanghai-style execution header (PulseChain rules) with the given roots and number.
pub fn shanghai_header(number: u64, receipts_root: B256, transactions_root: B256) -> ExecutionHeader {
    ExecutionHeader {
        parent_hash: B256::repeat_byte(0x01),
        ommers_hash: B256::repeat_byte(0x02),
        beneficiary: Address::repeat_byte(0x03),
        state_root: B256::repeat_byte(0x04),
        transactions_root,
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

/// A Prague-style execution header (Ethereum rules) with the given roots and number.
pub fn prague_header(number: u64, receipts_root: B256, transactions_root: B256) -> ExecutionHeader {
    ExecutionHeader {
        blob_gas_used: Some(0),
        excess_blob_gas: Some(0),
        parent_beacon_block_root: Some(B256::repeat_byte(0x08)),
        requests_hash: Some(B256::repeat_byte(0x09)),
        ..shanghai_header(number, receipts_root, transactions_root)
    }
}

/// An Amsterdam-style execution header as RLP: the Prague header with `blockAccessListHash` (EIP-7928) and `slotNumber`
/// (EIP-7843) after `requestsHash`, 23 items in all. The strict `ExecutionHeader` of `lc-core` holds 21 items at most, so
/// the two items are appended to the encoding. Sepolia headers have this shape since Gloas.
pub fn amsterdam_header_rlp(number: u64, receipts_root: B256, transactions_root: B256) -> Bytes {
    use alloy_rlp::{Encodable, Header};
    let prague = encode_execution_header(&prague_header(number, receipts_root, transactions_root));
    let mut outer = prague.as_ref();
    let list = Header::decode(&mut outer).expect("a list header");
    let mut payload = outer[..list.payload_length].to_vec();
    B256::repeat_byte(0x0a).encode(&mut payload);
    (number * 2).encode(&mut payload);
    let mut out = Vec::new();
    Header { list: true, payload_length: payload.len() }.encode(&mut out);
    out.extend_from_slice(&payload);
    Bytes::from(out)
}
