//! Receipts trie builder and execution header encoder, for real and synthetic blocks.
//!
//! The builders live in `lc_core::receipts` and `lc_core::json` (the prover service uses them). This module re-exports
//! them under the old paths and adds the synthetic execution headers.

use alloy_primitives::{Address, Bloom, Bytes, B256, B64, U256};
use lc_core::execution::ExecutionHeader;

pub use lc_core::json::{execution_header_from_json, logs_from_json, receipts_from_json};
pub use lc_core::receipts::{
    build_receipts_trie, encode_execution_header, encode_log, encode_receipt, header_hash, ReceiptsTrie,
};

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
