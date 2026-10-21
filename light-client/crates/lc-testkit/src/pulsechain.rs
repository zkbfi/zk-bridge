//! Loaders for the real PulseChain fixtures derived by `derive-pulsechain-fixtures`.

use crate::json::{beacon_header, branch, hex_b256, light_client_update, load_response, sync_committee};
use crate::receipts::{
    build_receipts_trie, encode_execution_header, execution_header_from_json, header_hash, receipts_from_json,
};
use alloy_primitives::{Bytes, B256, U256};
use lc_core::abi::WithdrawalProof;
use lc_core::types::{LightClientStore, LightClientUpdate};

/// The real update and the store that precedes it.
pub fn real_update_and_store() -> (LightClientStore, LightClientUpdate) {
    let response = load_response("pulsechain/light_client_update.json");
    let update = light_client_update(&response["update"]);
    let store_json = &response["store"];
    let store = LightClientStore {
        header_root: hex_b256(&store_json["header_root"]),
        header_slot: store_json["header_slot"].as_str().expect("slot").parse().expect("slot"),
        current_sync_committee: sync_committee(&store_json["current_sync_committee"]),
        next_sync_committee: None,
    };
    (store, update)
}

/// A real execution block with its receipts, rebuilt into a trie.
pub struct RealBlock {
    /// RLP of the rebuilt header (its keccak256 was checked against the node's `hash`).
    pub header_rlp: Bytes,
    /// Execution block hash.
    pub block_hash: B256,
    /// EIP-2718 receipt bytes by transaction index.
    pub receipts: Vec<Bytes>,
    /// The receipts JSON as the node returned it.
    pub receipts_json: serde_json::Value,
    /// Proof nodes by transaction index.
    pub proofs: Vec<Vec<Bytes>>,
    /// The trie root rebuilt from the receipts.
    pub rebuilt_root: B256,
}

/// Rebuilds a real block: the header from JSON and the receipts trie from the receipts JSON.
pub fn rebuild_block(block_fixture: &str, receipts_fixture: &str) -> RealBlock {
    let block = load_response(block_fixture);
    let receipts_json = load_response(receipts_fixture);
    let header = execution_header_from_json(&block);
    let header_rlp = encode_execution_header(&header);
    let block_hash = header_hash(&header_rlp);
    assert_eq!(block_hash, hex_b256(&block["hash"]), "the rebuilt header must hash to the node's block hash");
    let receipts = receipts_from_json(&receipts_json);
    let trie = build_receipts_trie(&receipts);
    RealBlock { header_rlp, block_hash, receipts, receipts_json, proofs: trie.proofs, rebuilt_root: trie.root }
}

/// A real beacon path entry: the withdrawal proof for one receipt log of a real PulseChain block.
/// The log is not a deposit event (no vault exists on PulseChain), so the vault checks must reject it at the log stage.
pub fn real_withdrawal_proof(
    entry_name: &str,
    transaction_index: u64,
    log_index: u64,
) -> (WithdrawalProof, B256, RealBlock) {
    let paths = load_response("pulsechain/beacon_paths.json");
    let anchor = beacon_header(&paths["anchor_header"]);
    let entry = paths["entries"]
        .as_array()
        .expect("entries")
        .iter()
        .find(|candidate| candidate["name"] == entry_name)
        .unwrap_or_else(|| panic!("no entry {entry_name}"));
    let block = rebuild_block(
        &format!("pulsechain/path_{entry_name}_block.json"),
        &format!("pulsechain/path_{entry_name}_receipts.json"),
    );
    assert_eq!(
        hex_b256(&entry["execution_block_hash"]),
        block.block_hash,
        "the beacon payload and the execution RPC agree"
    );
    let proof = WithdrawalProof {
        anchorHeader: (&anchor).into(),
        depositHeader: (&beacon_header(&entry["deposit_header"])).into(),
        blockRootsBranch: branch(&entry["block_roots_branch"]),
        blockHashBranch: branch(&entry["block_hash_branch"]),
        executionHeaderRlp: block.header_rlp.clone(),
        receiptProof: block.proofs[transaction_index as usize].clone(),
        transactionIndex: U256::from(transaction_index),
        logIndex: U256::from(log_index),
    };
    (proof, anchor.hash_tree_root(), block)
}
