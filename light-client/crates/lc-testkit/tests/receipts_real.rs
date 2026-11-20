//! Real receipts from both chains: rebuild the block header and the receipts trie, then prove and decode every receipt.
//!
//! All blocks here are REAL data fetched on 2026-10-20 (`tests/fixtures/*/execution_block.json`, `block_receipts.json`,
//! `path_*_block.json`, `path_*_receipts.json`). Each test shows the header decodes in the chain's own format. The
//! transaction bytes of the same blocks (`*_transactions.json`) were fetched on 2026-11-20.

use alloy_primitives::{Bytes, B256};
use alloy_trie::root::ordered_trie_root_encoded;
use lc_core::execution::{decode_execution_header, decode_receipt};
use lc_core::message::extract_receipt;
use lc_testkit::json::{hex_b256, load_response};
use lc_testkit::pulsechain::{rebuild_block, RealBlock};

fn quantity(value: &serde_json::Value) -> u64 {
    u64::from_str_radix(value.as_str().expect("quantity").trim_start_matches("0x"), 16).expect("hex")
}

/// Proves every receipt of a real block and checks the decoded fields against the node's JSON.
fn prove_every_receipt(block: &RealBlock, block_fixture: &str) -> (usize, Vec<u8>) {
    let header_json = load_response(block_fixture);
    let receipts_root = hex_b256(&header_json["receiptsRoot"]);
    assert_eq!(block.rebuilt_root, receipts_root, "the rebuilt trie must reproduce the node's receiptsRoot");
    assert_eq!(ordered_trie_root_encoded(&block.receipts), receipts_root, "alloy-trie reference root agrees");

    let mut types = Vec::new();
    for (index, receipt_json) in block.receipts_json.as_array().expect("receipts").iter().enumerate() {
        let proven = extract_receipt(receipts_root, index as u64, &block.proofs[index]).expect("proof verifies");
        assert_eq!(proven, block.receipts[index].to_vec(), "the proof returns the receipt bytes");
        let decoded = decode_receipt(&proven).expect("receipt decodes");
        assert_eq!(decoded.transaction_type as u64, quantity(&receipt_json["type"]));
        assert_eq!(decoded.success, quantity(&receipt_json["status"]) == 1);
        assert_eq!(decoded.cumulative_gas_used, quantity(&receipt_json["cumulativeGasUsed"]));
        let logs = receipt_json["logs"].as_array().expect("logs");
        assert_eq!(decoded.logs.len(), logs.len());
        for (log, log_json) in decoded.logs.iter().zip(logs) {
            assert_eq!(log.address.as_slice(), lc_testkit::json::hex_bytes(&log_json["address"]).as_slice());
            let topics: Vec<B256> = log_json["topics"].as_array().expect("topics").iter().map(hex_b256).collect();
            assert_eq!(log.topics, topics);
        }
        types.push(decoded.transaction_type);
    }
    types.sort_unstable();
    types.dedup();
    (block.receipts.len(), types)
}

/// Claim: a real Ethereum block (Prague header, 21 fields, type 0 and type 2 and type 3 receipts) rebuilds exactly,
/// every receipt proves and decodes. This covers defect R2-05 (typed receipts) with real data.
#[test]
fn real_ethereum_block_receipts_prove_and_decode() {
    let block = rebuild_block("ethereum/execution_block.json", "ethereum/block_receipts.json");
    let (count, types) = prove_every_receipt(&block, "ethereum/execution_block.json");
    assert!(count > 10);
    assert!(types.contains(&0) && types.contains(&2), "the block must hold type 0 and type 2 receipts, got {types:?}");

    let header = decode_execution_header(&block.header_rlp).expect("Ethereum header decodes");
    assert!(header.base_fee_per_gas.is_some() && header.withdrawals_root.is_some());
    assert!(
        header.blob_gas_used.is_some() && header.excess_blob_gas.is_some() && header.parent_beacon_block_root.is_some()
    );
    assert!(header.requests_hash.is_some(), "a Prague header has the requests hash");
    assert_eq!(lc_core::execution::execution_block_hash(&block.header_rlp), block.block_hash);
}

/// Claim: a real PulseChain block (Shanghai header, 17 fields) decodes with no blob fields and no requests hash,
/// and its type 0 and type 2 receipts all prove and decode.
#[test]
fn real_pulsechain_block_receipts_prove_and_decode() {
    let block = rebuild_block("pulsechain/execution_block.json", "pulsechain/block_receipts.json");
    let (_, types) = prove_every_receipt(&block, "pulsechain/execution_block.json");
    assert!(types.contains(&0) && types.contains(&2), "got {types:?}");
    let header = decode_execution_header(&block.header_rlp).expect("PulseChain header decodes");
    assert!(header.withdrawals_root.is_some(), "Shanghai fields are present");
    assert!(header.blob_gas_used.is_none() && header.excess_blob_gas.is_none());
    assert!(header.parent_beacon_block_root.is_none() && header.requests_hash.is_none());
}

/// Claim: the two larger PulseChain blocks tied to real beacon blocks also rebuild and prove (more receipts, many logs).
#[test]
fn real_pulsechain_path_blocks_prove_and_decode() {
    for name in ["finalized", "ancestor"] {
        let block_fixture = format!("pulsechain/path_{name}_block.json");
        let block = rebuild_block(&block_fixture, &format!("pulsechain/path_{name}_receipts.json"));
        let (count, _) = prove_every_receipt(&block, &block_fixture);
        assert!(count >= 20, "{name}");
    }
}

/// Claim: damaged proofs are refused: a flipped byte in any node, a wrong transaction index, a missing last node and an
/// extra node. Each case is applied to a real proof that verifies first (control).
#[test]
fn real_receipt_proof_rejects_tampering() {
    let block = rebuild_block("pulsechain/execution_block.json", "pulsechain/block_receipts.json");
    let root = block.rebuilt_root;
    let index = 3u64;
    let proof = block.proofs[index as usize].clone();
    assert!(extract_receipt(root, index, &proof).is_ok(), "control: the untouched proof verifies");

    for node in 0..proof.len() {
        let mut broken = proof.clone();
        let mut bytes = broken[node].to_vec();
        let middle = bytes.len() / 2;
        bytes[middle] ^= 0x01;
        broken[node] = Bytes::from(bytes);
        assert!(extract_receipt(root, index, &broken).is_err(), "flipped byte in node {node}");
    }
    assert!(extract_receipt(root, index + 1, &proof).is_err(), "proof of another index");
    assert!(extract_receipt(root, index, &proof[..proof.len() - 1]).is_err(), "missing leaf");
    let mut extra = proof.clone();
    extra.push(proof[0].clone());
    assert!(extract_receipt(root, index, &extra).is_err(), "unused extra node");
    assert!(extract_receipt(B256::repeat_byte(1), index, &proof).is_err(), "wrong root");
}

/// The real blocks whose transactions are on file: the block fixture and the receipts fixture.
const BLOCKS_WITH_TRANSACTIONS: [(&str, &str); 5] = [
    ("ethereum/execution_block.json", "ethereum/block_receipts.json"),
    ("pulsechain/execution_block.json", "pulsechain/block_receipts.json"),
    ("pulsechain/path_finalized_block.json", "pulsechain/path_finalized_receipts.json"),
    ("pulsechain/path_ancestor_block.json", "pulsechain/path_ancestor_receipts.json"),
    ("pulsechain/path_historical_block.json", "pulsechain/path_historical_receipts.json"),
];

/// Claim: the real transaction bytes of each block (fetched with `eth_getRawTransactionByHash`) rebuild the trie whose root
/// is the `transactionsRoot` of the real header, every transaction proof walks to the bytes, and the keccak256 of the bytes
/// at each index is the transaction hash that the node listed at that index.
/// Why it matters: the bridge takes the hash of the proven transaction as the source transaction hash of a message. This is
/// the transaction stage of a message proof on real data, for both chains and every transaction type on file.
#[test]
fn real_transactions_rebuild_the_transactions_root_and_prove() {
    use lc_core::message::extract_transaction;
    let mut types = Vec::new();
    for (block_fixture, receipts_fixture) in BLOCKS_WITH_TRANSACTIONS {
        let block = rebuild_block(block_fixture, receipts_fixture);
        let header_json = load_response(block_fixture);
        let root = hex_b256(&header_json["transactionsRoot"]);
        let hashes: Vec<B256> = header_json["transactions"].as_array().expect("hashes").iter().map(hex_b256).collect();
        assert_eq!(block.transactions.len(), hashes.len(), "{block_fixture}: one transaction for each hash");
        assert_eq!(block.transactions_rebuilt_root, root, "{block_fixture}: the rebuilt trie has the transactionsRoot");
        assert_eq!(ordered_trie_root_encoded(&block.transactions), root, "{block_fixture}: alloy-trie reference root");
        let header = decode_execution_header(&block.header_rlp).expect("header");
        assert_eq!(header.transactions_root, root, "{block_fixture}: the header that the message proof carries");
        for (index, hash) in hashes.iter().enumerate() {
            let proven =
                extract_transaction(root, index as u64, &block.transaction_proofs[index]).expect("proof verifies");
            assert_eq!(proven, block.transactions[index].to_vec(), "{block_fixture}: transaction {index}");
            assert_eq!(alloy_primitives::keccak256(&proven), *hash, "{block_fixture}: hash of transaction {index}");
            let first = proven[0];
            types.push(if first >= 0xc0 { 0 } else { first });
        }
    }
    types.sort_unstable();
    types.dedup();
    assert!(types.contains(&0) && types.contains(&2), "legacy and type 2 transactions, got {types:?}");
}

/// Claim: damaged transaction proofs of a real block are refused with `TransactionProofInvalid`: a flipped byte in any
/// node, the proof of the neighbouring transaction, a proof under another index, a missing leaf, an extra node and another
/// root. The untouched proof verifies first (control).
#[test]
fn real_transaction_proof_rejects_tampering() {
    use lc_core::message::extract_transaction;
    use lc_core::Error;
    let block = rebuild_block("pulsechain/path_finalized_block.json", "pulsechain/path_finalized_receipts.json");
    let root = block.transactions_rebuilt_root;
    let index = 3u64;
    let proof = block.transaction_proofs[index as usize].clone();
    assert!(extract_transaction(root, index, &proof).is_ok(), "control: the untouched proof verifies");
    let refused = |result: Result<Vec<u8>, Error>| matches!(result, Err(Error::TransactionProofInvalid(_)));
    for node in 0..proof.len() {
        let mut broken = proof.clone();
        let mut bytes = broken[node].to_vec();
        let middle = bytes.len() / 2;
        bytes[middle] ^= 0x01;
        broken[node] = Bytes::from(bytes);
        assert!(refused(extract_transaction(root, index, &broken)), "flipped byte in node {node}");
    }
    let neighbour = &block.transaction_proofs[index as usize + 1];
    assert!(refused(extract_transaction(root, index, neighbour)), "the proof of another transaction");
    assert!(refused(extract_transaction(root, index + 1, &proof)), "proof of another index");
    assert!(refused(extract_transaction(root, index, &proof[..proof.len() - 1])), "missing leaf");
    let mut extra = proof.clone();
    extra.push(proof[0].clone());
    assert!(refused(extract_transaction(root, index, &extra)), "unused extra node");
    assert!(refused(extract_transaction(B256::repeat_byte(1), index, &proof)), "wrong root");
}
