//! The proof cache: `eth_getProof` answers that a runner fetched near the tip of a chain, read back by `opening-proof`.
//!
//! A node answers `eth_getProof` only for recent blocks (its proof window: about 64 blocks on a public Sepolia node, 128 on
//! a public PulseChain testnet node). The block of a stored light-client head is a finalized checkpoint, already about two
//! epochs old when it is stored, so a node often refuses its proof by the time an opening is attempted. A runner therefore
//! fetches the answer at each epoch boundary while the block is new, and stores it as one JSON file:
//!
//! ```text
//! <dir>/<chain id>/<address, 0x and lower case>/<block number>-<block hash, 0x and lower case>.json
//! {
//!   "schemaVersion": 1, "chainId": 11155111, "blockNumber": 123, "blockHash": "0x…", "address": "0x…",
//!   "storedSlot": 456, "storageKeys": ["0x…"], "fetchedAt": "…", "proof": <the eth_getProof result, as the node sent it>
//! }
//! ```
//!
//! The cache is not trusted. This module only finds the entry that names the right chain, block, address and storage key;
//! the caller verifies the answer against the state root of the header exactly as it verifies a live answer.

use crate::error::{Error, Result};
use crate::opening::execution_block_hashes_slot;
use alloy_primitives::{Address, B256};
use serde_json::Value;
use std::path::{Path, PathBuf};
use std::str::FromStr;

/// The schema version of an entry that this module reads.
pub const PROOF_CACHE_SCHEMA_VERSION: u64 = 1;

/// A cached answer for one block and one stored slot of the light client at `address`.
#[derive(Clone, Debug, PartialEq)]
pub struct CachedProof {
    /// The slot whose `executionBlockHashes` entry the storage proof opens.
    pub stored_slot: u64,
    /// The `eth_getProof` result, as the node sent it.
    pub answer: Value,
}

/// The file of the entry for one chain, address and block.
pub fn proof_cache_path(
    directory: &Path,
    chain_id: u64,
    address: Address,
    block_number: u64,
    block_hash: B256,
) -> PathBuf {
    directory
        .join(chain_id.to_string())
        .join(format!("{address:#x}"))
        .join(format!("{block_number}-{block_hash:#x}.json"))
}

fn mismatch(what: &str) -> Error {
    Error::Malformed(format!("the proof cache entry: {what}"))
}

/// Reads the entry for `(chain_id, address, block_number, block_hash)`. `stored_slot`, when given, must be the slot of
/// the entry.
///
/// # Errors
/// `Error::Malformed` when the file exists but cannot be read, is not an entry, or names another chain, block, address,
/// stored slot or storage key than the request. `Ok(None)` when there is no file.
pub fn read_cached_proof(
    directory: &Path,
    chain_id: u64,
    address: Address,
    block_number: u64,
    block_hash: B256,
    stored_slot: Option<u64>,
) -> Result<Option<CachedProof>> {
    let path = proof_cache_path(directory, chain_id, address, block_number, block_hash);
    let text = match std::fs::read_to_string(&path) {
        Ok(text) => text,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(error) => return Err(mismatch(&format!("cannot be read: {error}"))),
    };
    let entry: Value =
        serde_json::from_str(&text).map_err(|error| mismatch(&format!("not JSON: {error}")))?;
    if entry["schemaVersion"].as_u64() != Some(PROOF_CACHE_SCHEMA_VERSION) {
        return Err(mismatch("not schema version 1"));
    }
    if entry["chainId"].as_u64() != Some(chain_id) {
        return Err(mismatch("another chain"));
    }
    if entry["blockNumber"].as_u64() != Some(block_number) {
        return Err(mismatch("another block number"));
    }
    let named_hash = entry["blockHash"]
        .as_str()
        .and_then(|text| B256::from_str(text).ok());
    if named_hash != Some(block_hash) {
        return Err(mismatch("another block hash"));
    }
    let named_address = entry["address"]
        .as_str()
        .and_then(|text| Address::from_str(text).ok());
    if named_address != Some(address) {
        return Err(mismatch("another address"));
    }
    let entry_slot = entry["storedSlot"]
        .as_u64()
        .ok_or_else(|| mismatch("no stored slot"))?;
    if stored_slot.is_some_and(|slot| slot != entry_slot) {
        return Err(mismatch("another stored slot"));
    }
    let keys: Option<Vec<B256>> = entry["storageKeys"].as_array().and_then(|keys| {
        keys.iter()
            .map(|key| key.as_str().and_then(|text| B256::from_str(text).ok()))
            .collect()
    });
    if keys != Some(vec![execution_block_hashes_slot(entry_slot)]) {
        return Err(mismatch(
            "the storage key is not the key of its stored slot",
        ));
    }
    let answer = entry
        .get("proof")
        .filter(|proof| proof.is_object())
        .ok_or_else(|| mismatch("no proof"))?
        .clone();
    Ok(Some(CachedProof {
        stored_slot: entry_slot,
        answer,
    }))
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    const CHAIN: u64 = 11_155_111;
    const BLOCK: u64 = 123;
    const SLOT: u64 = 456;
    const ADDRESS: Address = Address::repeat_byte(0xc3);
    const HASH: B256 = B256::repeat_byte(0x5a);

    fn entry() -> Value {
        json!({
            "schemaVersion": 1,
            "chainId": CHAIN,
            "blockNumber": BLOCK,
            "blockHash": format!("{HASH:#x}"),
            "address": format!("{ADDRESS:#x}"),
            "storedSlot": SLOT,
            "storageKeys": [format!("{:#x}", execution_block_hashes_slot(SLOT))],
            "fetchedAt": "2026-11-01T00:00:00.000Z",
            "proof": { "accountProof": [], "storageProof": [] },
        })
    }

    struct Directory(PathBuf);

    impl Drop for Directory {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.0);
        }
    }

    fn directory_with(name: &str, entry: Option<&str>) -> Directory {
        let directory =
            std::env::temp_dir().join(format!("proof-cache-unit-{}-{name}", std::process::id()));
        let _ = std::fs::remove_dir_all(&directory);
        if let Some(text) = entry {
            let path = proof_cache_path(&directory, CHAIN, ADDRESS, BLOCK, HASH);
            std::fs::create_dir_all(path.parent().unwrap()).unwrap();
            std::fs::write(path, text).unwrap();
        }
        Directory(directory)
    }

    fn read(directory: &Directory, stored_slot: Option<u64>) -> Result<Option<CachedProof>> {
        read_cached_proof(&directory.0, CHAIN, ADDRESS, BLOCK, HASH, stored_slot)
    }

    /// Claim: the path names the chain, the address and the block in lower-case hex, as the runner writes it.
    #[test]
    fn the_path_names_chain_address_and_block() {
        let path = proof_cache_path(Path::new("/cache"), CHAIN, ADDRESS, BLOCK, HASH);
        assert_eq!(
            path,
            PathBuf::from(format!(
                "/cache/11155111/0x{}/123-0x{}.json",
                "c3".repeat(20),
                "5a".repeat(32)
            ))
        );
    }

    /// Claim: a matching entry is read with its stored slot and its answer; a request that names the same slot also reads it,
    /// and a missing file is `None`.
    #[test]
    fn a_matching_entry_is_read_and_a_missing_one_is_none() {
        let directory = directory_with("hit", Some(&entry().to_string()));
        let expected = CachedProof {
            stored_slot: SLOT,
            answer: json!({ "accountProof": [], "storageProof": [] }),
        };
        assert_eq!(read(&directory, None).unwrap(), Some(expected.clone()));
        assert_eq!(read(&directory, Some(SLOT)).unwrap(), Some(expected));
        let empty = directory_with("none", None);
        assert_eq!(read(&empty, None).unwrap(), None);
    }

    /// Claim: an entry that names anything other than the request is refused with the reason, and so is a file that is not
    /// an entry. Why it matters: the file name is only a hint; the entry must say what it proves.
    #[test]
    fn an_entry_that_names_something_else_is_refused() {
        let changed = |field: &str, value: Value| {
            let mut changed = entry();
            changed[field] = value;
            changed.to_string()
        };
        let cases = [
            ("{".to_string(), "not JSON"),
            (changed("schemaVersion", json!(2)), "schema version"),
            (changed("chainId", json!(1)), "another chain"),
            (changed("blockNumber", json!(124)), "another block number"),
            (changed("blockHash", json!("0x01")), "another block hash"),
            (
                changed("address", json!(format!("{:#x}", Address::ZERO))),
                "another address",
            ),
            (changed("storedSlot", json!("456")), "no stored slot"),
            (
                changed("storageKeys", json!([format!("{:#x}", B256::ZERO)])),
                "storage key",
            ),
            (changed("storageKeys", json!("0x")), "storage key"),
            (changed("proof", json!(null)), "no proof"),
        ];
        for (index, (text, reason)) in cases.into_iter().enumerate() {
            let directory = directory_with(&format!("refused-{index}"), Some(&text));
            let error = read(&directory, None).expect_err(reason).to_string();
            assert!(error.contains(reason), "{reason}: {error}");
        }
        let directory = directory_with("other-slot", Some(&entry().to_string()));
        let error = read(&directory, Some(SLOT + 1)).unwrap_err().to_string();
        assert!(error.contains("another stored slot"), "{error}");
    }

    /// Claim: a path that exists but cannot be read as a file is refused, not treated as a miss.
    #[test]
    fn an_unreadable_entry_is_refused() {
        let directory = directory_with("unreadable", None);
        let path = proof_cache_path(&directory.0, CHAIN, ADDRESS, BLOCK, HASH);
        std::fs::create_dir_all(&path).unwrap();
        let error = read(&directory, None).unwrap_err().to_string();
        assert!(error.contains("cannot be read"), "{error}");
    }
}
