//! Execution layer block header and receipt decoding.
//!
//! Header: Ethereum headers after Prague have 21 fields. PulseChain headers (Shanghai rules) have 17.
//! The decoder accepts the field counts that real chains produce: 15 (before London), 16 (London),
//! 17 (Shanghai), 20 (Cancun) and 21 (Prague and later), and nothing else.
//!
//! Receipt: EIP-2718 envelope. Type 0 is a bare RLP list. Types 1 to 4 are `type_byte || rlp(list)`.

use crate::error::{Error, Result};
use alloy_primitives::{keccak256, Address, Bloom, Bytes, B256, B64, U256};
use alloy_rlp::{Decodable, Header as RlpHeader};

/// A decoded execution block header.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ExecutionHeader {
    /// Parent hash.
    pub parent_hash: B256,
    /// Ommers hash.
    pub ommers_hash: B256,
    /// Beneficiary.
    pub beneficiary: Address,
    /// State root.
    pub state_root: B256,
    /// Transactions root.
    pub transactions_root: B256,
    /// Receipts root: the root the receipt proof must reach.
    pub receipts_root: B256,
    /// Logs bloom.
    pub logs_bloom: Bloom,
    /// Difficulty.
    pub difficulty: U256,
    /// Block number.
    pub number: u64,
    /// Gas limit.
    pub gas_limit: u64,
    /// Gas used.
    pub gas_used: u64,
    /// Timestamp.
    pub timestamp: u64,
    /// Extra data.
    pub extra_data: Bytes,
    /// Mix hash.
    pub mix_hash: B256,
    /// Nonce.
    pub nonce: B64,
    /// Base fee (London).
    pub base_fee_per_gas: Option<u64>,
    /// Withdrawals root (Shanghai).
    pub withdrawals_root: Option<B256>,
    /// Blob gas used (Cancun).
    pub blob_gas_used: Option<u64>,
    /// Excess blob gas (Cancun).
    pub excess_blob_gas: Option<u64>,
    /// Parent beacon block root (Cancun).
    pub parent_beacon_block_root: Option<B256>,
    /// Requests hash (Prague).
    pub requests_hash: Option<B256>,
}

fn header_error(reason: impl core::fmt::Display) -> Error {
    Error::HeaderDecode(reason.to_string())
}

/// Decodes a header from its RLP bytes. The input must be exactly one header with no trailing bytes.
///
/// # Errors
/// `HeaderDecode` for malformed RLP, a wrong field count or trailing bytes.
pub fn decode_execution_header(rlp: &[u8]) -> Result<ExecutionHeader> {
    let mut outer = rlp;
    let list = RlpHeader::decode(&mut outer).map_err(header_error)?;
    if !list.list {
        return Err(header_error("header is not an RLP list"));
    }
    if list.payload_length != outer.len() {
        return Err(header_error("trailing bytes after the header list"));
    }
    let buf = &mut outer;
    let parent_hash = B256::decode(buf).map_err(header_error)?;
    let ommers_hash = B256::decode(buf).map_err(header_error)?;
    let beneficiary = Address::decode(buf).map_err(header_error)?;
    let state_root = B256::decode(buf).map_err(header_error)?;
    let transactions_root = B256::decode(buf).map_err(header_error)?;
    let receipts_root = B256::decode(buf).map_err(header_error)?;
    let logs_bloom = Bloom::decode(buf).map_err(header_error)?;
    let difficulty = U256::decode(buf).map_err(header_error)?;
    let number = u64::decode(buf).map_err(header_error)?;
    let gas_limit = u64::decode(buf).map_err(header_error)?;
    let gas_used = u64::decode(buf).map_err(header_error)?;
    let timestamp = u64::decode(buf).map_err(header_error)?;
    let extra_data = Bytes::decode(buf).map_err(header_error)?;
    let mix_hash = B256::decode(buf).map_err(header_error)?;
    let nonce = B64::decode(buf).map_err(header_error)?;
    let mut header = ExecutionHeader {
        parent_hash,
        ommers_hash,
        beneficiary,
        state_root,
        transactions_root,
        receipts_root,
        logs_bloom,
        difficulty,
        number,
        gas_limit,
        gas_used,
        timestamp,
        extra_data,
        mix_hash,
        nonce,
        base_fee_per_gas: None,
        withdrawals_root: None,
        blob_gas_used: None,
        excess_blob_gas: None,
        parent_beacon_block_root: None,
        requests_hash: None,
    };
    if buf.is_empty() {
        return Ok(header);
    }
    header.base_fee_per_gas = Some(u64::decode(buf).map_err(header_error)?);
    if buf.is_empty() {
        return Ok(header);
    }
    header.withdrawals_root = Some(B256::decode(buf).map_err(header_error)?);
    if buf.is_empty() {
        return Ok(header);
    }
    header.blob_gas_used = Some(u64::decode(buf).map_err(header_error)?);
    header.excess_blob_gas = Some(u64::decode(buf).map_err(header_error)?);
    header.parent_beacon_block_root = Some(B256::decode(buf).map_err(header_error)?);
    if buf.is_empty() {
        return Ok(header);
    }
    header.requests_hash = Some(B256::decode(buf).map_err(header_error)?);
    if buf.is_empty() {
        return Ok(header);
    }
    Err(header_error("more fields than the Prague header has"))
}

/// The most items a header list may hold for the tolerant decoder. A header has 15 items at its start and gains one
/// with each fork (Amsterdam has 23). The limit only bounds the walk over untrusted bytes.
const MAX_HEADER_ITEMS: usize = 64;

/// Position of `receiptsRoot` in the execution header list. It has not moved since Frontier.
const HEADER_ITEM_RECEIPTS_ROOT: usize = 5;
/// Position of `number` in the execution header list.
const HEADER_ITEM_NUMBER: usize = 8;
/// Position of `timestamp` in the execution header list.
const HEADER_ITEM_TIMESTAMP: usize = 11;
/// The items every header has from Frontier on: `parentHash` up to `nonce`. Later forks append after them.
const HEADER_ITEMS_FROM_FRONTIER: usize = 15;

/// The fields of an execution header that the light client reads.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct ExecutionAnchorFields {
    /// Block number: item 8 of the header list.
    pub number: u64,
    /// Receipts root: item 5.
    pub receipts_root: B256,
    /// Timestamp: item 11.
    pub timestamp: u64,
}

/// Reads `number`, `receiptsRoot` and `timestamp` from the RLP of an execution header of ANY field count.
///
/// Execution headers grow with each fork (Amsterdam adds `blockAccessListHash` and `slotNumber`, 23 items), but the first
/// 15 items have kept their positions since Frontier. This decoder pins the three positions it reads, checks their
/// types (a 32 byte string and two canonical integers), and walks the other items by their RLP length prefix without
/// reading them. It needs at least 15 items, and the items must fill the list exactly. It does not decide whether the
/// header is valid for a fork: the caller binds the bytes by their keccak256 hash, so the positions are those of the
/// header that the chain hashed.
///
/// # Errors
/// `HeaderDecode` for malformed RLP, fewer than 15 items, more than 64 items, a field of the wrong type or trailing bytes.
pub fn decode_execution_anchor_fields(rlp: &[u8]) -> Result<ExecutionAnchorFields> {
    let mut outer = rlp;
    let list = RlpHeader::decode(&mut outer).map_err(header_error)?;
    if !list.list {
        return Err(header_error("header is not an RLP list"));
    }
    if list.payload_length != outer.len() {
        return Err(header_error("trailing bytes after the header list"));
    }
    let mut receipts_root = None;
    let mut number = None;
    let mut timestamp = None;
    let mut count = 0usize;
    let mut rest = outer;
    while !rest.is_empty() {
        if count == MAX_HEADER_ITEMS {
            return Err(header_error("more than 64 items in the header list"));
        }
        let mut item = rest;
        let item_header = RlpHeader::decode(&mut item).map_err(header_error)?;
        let item_length = rest.len() - item.len() + item_header.payload_length;
        if item_length > rest.len() {
            return Err(header_error("an item runs past the end of the header list"));
        }
        let mut whole = &rest[..item_length];
        match count {
            HEADER_ITEM_RECEIPTS_ROOT => receipts_root = Some(B256::decode(&mut whole).map_err(header_error)?),
            HEADER_ITEM_NUMBER => number = Some(u64::decode(&mut whole).map_err(header_error)?),
            HEADER_ITEM_TIMESTAMP => timestamp = Some(u64::decode(&mut whole).map_err(header_error)?),
            _ => {}
        }
        rest = &rest[item_length..];
        count += 1;
    }
    if count < HEADER_ITEMS_FROM_FRONTIER {
        return Err(header_error("fewer than 15 items in the header list"));
    }
    match (receipts_root, number, timestamp) {
        (Some(receipts_root), Some(number), Some(timestamp)) => {
            Ok(ExecutionAnchorFields { number, receipts_root, timestamp })
        }
        _ => Err(header_error("the header list lacks receipts root, number or timestamp")),
    }
}

/// The keccak256 hash of raw header bytes: the execution block hash.
pub fn execution_block_hash(header_rlp: &[u8]) -> B256 {
    keccak256(header_rlp)
}

/// One event log.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Log {
    /// Emitting contract.
    pub address: Address,
    /// Topics.
    pub topics: Vec<B256>,
    /// Data.
    pub data: Bytes,
}

/// A decoded receipt.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Receipt {
    /// EIP-2718 transaction type: 0 for legacy.
    pub transaction_type: u8,
    /// True when the status field says success.
    pub success: bool,
    /// Cumulative gas used.
    pub cumulative_gas_used: u64,
    /// Logs bloom.
    pub logs_bloom: Bloom,
    /// Logs.
    pub logs: Vec<Log>,
}

fn receipt_error(reason: impl core::fmt::Display) -> Error {
    Error::ReceiptDecode(reason.to_string())
}

fn decode_log(buf: &mut &[u8]) -> Result<Log> {
    let list = RlpHeader::decode(buf).map_err(receipt_error)?;
    if !list.list || buf.len() < list.payload_length {
        return Err(receipt_error("log is not a list"));
    }
    let (payload, rest) = buf.split_at(list.payload_length);
    let mut fields = payload;
    let address = Address::decode(&mut fields).map_err(receipt_error)?;
    let topics = Vec::<B256>::decode(&mut fields).map_err(receipt_error)?;
    let data = Bytes::decode(&mut fields).map_err(receipt_error)?;
    if !fields.is_empty() {
        return Err(receipt_error("trailing bytes inside a log"));
    }
    *buf = rest;
    Ok(Log { address, topics, data })
}

/// Decodes the EIP-2718 bytes that the receipts trie stores.
///
/// # Errors
/// `ReceiptDecode` for an unknown type byte, a pre-Byzantium receipt (no status), malformed RLP or trailing bytes.
pub fn decode_receipt(bytes: &[u8]) -> Result<Receipt> {
    let first = *bytes.first().ok_or_else(|| receipt_error("empty receipt"))?;
    let (transaction_type, body) = match first {
        0xc0..=0xff => (0u8, bytes),
        1..=4 => (first, &bytes[1..]),
        other => return Err(receipt_error(format!("unsupported receipt type byte 0x{other:02x}"))),
    };
    let mut outer = body;
    let list = RlpHeader::decode(&mut outer).map_err(receipt_error)?;
    if !list.list || list.payload_length != outer.len() {
        return Err(receipt_error("receipt is not one RLP list"));
    }
    let buf = &mut outer;
    let status = u8::decode(buf)
        .map_err(|_| receipt_error("status is not 0 or 1 (a pre-Byzantium receipt has a state root)"))?;
    if status > 1 {
        return Err(receipt_error("status is not 0 or 1"));
    }
    let cumulative_gas_used = u64::decode(buf).map_err(receipt_error)?;
    let logs_bloom = Bloom::decode(buf).map_err(receipt_error)?;
    let logs_list = RlpHeader::decode(buf).map_err(receipt_error)?;
    if !logs_list.list || logs_list.payload_length != buf.len() {
        return Err(receipt_error("logs are not the last list of the receipt"));
    }
    let mut logs = Vec::new();
    while !buf.is_empty() {
        logs.push(decode_log(buf)?);
    }
    Ok(Receipt { transaction_type, success: status == 1, cumulative_gas_used, logs_bloom, logs })
}
