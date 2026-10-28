//! Loaders for the real PulseChain fixtures derived by `derive-pulsechain-fixtures`.

use crate::json::{beacon_header, branch, hex_b256, light_client_update, load_response, sync_committee};
use crate::receipts::{
    build_indexed_trie, encode_execution_header, execution_header_from_json, header_hash, receipts_from_json,
};
use alloy_primitives::{Bytes, B256, U256};
use lc_core::abi::MessageProof;
use lc_core::types::{LightClientStore, LightClientUpdate};

/// The branches of the real attested state that a beacon node does not serve. The derive tool reads them from the state.
pub struct RealStateProofs {
    /// The branch of `genesis_validators_root` (state field 1): 5 entries.
    pub genesis_validators_root_branch: Vec<B256>,
    /// The version in the `fork` of the state, `0x0000036c`.
    pub current_version: [u8; 4],
    /// The branch of `fork.current_version`: 7 entries.
    pub current_version_branch: Vec<B256>,
}

/// The state proofs of the real attested state, from `pulsechain/light_client_update.json`.
pub fn real_state_proofs() -> RealStateProofs {
    let response = load_response("pulsechain/light_client_update.json");
    let proofs = &response["state_proofs"];
    assert_eq!(
        hex_b256(&proofs["genesis_validators_root"]),
        lc_core::chain::PULSECHAIN.genesis_validators_root,
        "the state holds the genesis validators root of the chain specification"
    );
    let version = alloy_primitives::hex::decode(proofs["current_version"].as_str().expect("version")).expect("hex");
    RealStateProofs {
        genesis_validators_root_branch: branch(&proofs["genesis_validators_root_branch"]),
        current_version: version.try_into().expect("four bytes"),
        current_version_branch: branch(&proofs["current_version_branch"]),
    }
}

/// The real update, with its genesis validators root branch, and the store that precedes it.
pub fn real_update_and_store() -> (LightClientStore, LightClientUpdate) {
    let response = load_response("pulsechain/light_client_update.json");
    let update = light_client_update(&response["update"])
        .with_genesis_validators_root_branch(real_state_proofs().genesis_validators_root_branch);
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
    let trie = build_indexed_trie(&receipts);
    RealBlock { header_rlp, block_hash, receipts, receipts_json, proofs: trie.proofs, rebuilt_root: trie.root }
}

/// A real beacon path entry: the message proof for one receipt log of a real PulseChain block.
/// The fixtures hold the transaction hashes of the block and not the transactions, so the transaction proof is empty and
/// `verify_message` stops at the transaction stage. The log is not a message event (no bridge exists on PulseChain).
/// The tests walk the stages before and after the transaction stage one by one.
pub fn real_message_proof(entry_name: &str, transaction_index: u64, log_index: u64) -> (MessageProof, B256, RealBlock) {
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
    let proof = MessageProof {
        anchorHeader: (&anchor).into(),
        sourceHeader: (&beacon_header(&entry["deposit_header"])).into(),
        ancestryBranch: branch(&entry["ancestry_branch"]),
        blockHashBranch: branch(&entry["block_hash_branch"]),
        executionHeaderRlp: block.header_rlp.clone(),
        receiptProof: block.proofs[transaction_index as usize].clone(),
        receiptIndex: U256::from(transaction_index),
        transactionProof: Vec::new(),
        transactionIndex: U256::from(transaction_index),
        logIndex: U256::from(log_index),
    };
    (proof, anchor.hash_tree_root(), block)
}

/// The anchor and the entries of `pulsechain/historical_paths.json`: real historical-path ancestry from a real anchor state.
pub struct RealHistoricalPaths {
    /// The anchor header (a real finalized-or-recent PulseChain header).
    pub anchor: lc_core::types::BeaconBlockHeader,
    /// The response object of the fixture (checks and entries).
    pub response: serde_json::Value,
}

/// Loads `pulsechain/historical_paths.json` and checks that the anchor header hashes to the root the node reported.
pub fn real_historical_paths() -> RealHistoricalPaths {
    let response = load_response("pulsechain/historical_paths.json");
    let anchor = beacon_header(&response["anchor_header"]);
    assert_eq!(anchor.hash_tree_root(), hex_b256(&response["anchor_header_root"]), "anchor header root");
    RealHistoricalPaths { anchor, response }
}

impl RealHistoricalPaths {
    /// The entry with this name.
    ///
    /// # Panics
    /// Panics when the fixture has no such entry.
    pub fn entry(&self, name: &str) -> &serde_json::Value {
        self.response["entries"]
            .as_array()
            .expect("entries")
            .iter()
            .find(|candidate| candidate["name"] == name)
            .unwrap_or_else(|| panic!("no historical entry {name}"))
    }

    /// The source header of an entry.
    pub fn source_header(&self, name: &str) -> lc_core::types::BeaconBlockHeader {
        beacon_header(&self.entry(name)["deposit_header"])
    }

    /// The ancestry branch of an entry (44 entries, bottom to top).
    pub fn ancestry_branch(&self, name: &str) -> Vec<B256> {
        branch(&self.entry(name)["ancestry_branch"])
    }
}

/// The message proof for the middle block of the historical fixture, with its real execution block and receipts.
/// The transaction proof is empty, as in [`real_message_proof`].
pub fn real_historical_message_proof(transaction_index: u64, log_index: u64) -> (MessageProof, B256, RealBlock) {
    let paths = real_historical_paths();
    let entry = paths.entry("era_middle_block");
    let block = rebuild_block("pulsechain/path_historical_block.json", "pulsechain/path_historical_receipts.json");
    assert_eq!(
        hex_b256(&entry["execution_block_hash"]),
        block.block_hash,
        "the beacon payload and the execution RPC agree"
    );
    let proof = MessageProof {
        anchorHeader: (&paths.anchor).into(),
        sourceHeader: (&beacon_header(&entry["deposit_header"])).into(),
        ancestryBranch: branch(&entry["ancestry_branch"]),
        blockHashBranch: branch(&entry["block_hash_branch"]),
        executionHeaderRlp: block.header_rlp.clone(),
        receiptProof: block.proofs[transaction_index as usize].clone(),
        receiptIndex: U256::from(transaction_index),
        transactionProof: Vec::new(),
        transactionIndex: U256::from(transaction_index),
        logIndex: U256::from(log_index),
    };
    (proof, paths.anchor.hash_tree_root(), block)
}
