//! A store for the branches of `genesis_validators_root`, kept as untrusted public data.
//!
//! An update must carry the branch of `genesis_validators_root` under the state root of its attested header. A beacon
//! node does not serve this branch. The prover computes it from the attested state while the state is fresh. A long
//! catch-up needs the attested states of old updates, and a node prunes them (the PulseChain node also served stale old
//! states). So the prover keeps each branch here, keyed by the state root, and a later catch-up reads it back when the
//! node no longer has the state.
//!
//! The store is not trusted. A branch is public data. If an entry is wrong, the light-client program refuses the update
//! (`InvalidGenesisValidatorsRootBranch`), and the native run of the prover refuses it before any proof starts. A wrong entry can
//! stall a catch-up. It cannot cause a false head.

use crate::error::{Error, Result};
use alloy_primitives::{hex, B256};
use std::collections::BTreeMap;
use std::path::PathBuf;
use std::sync::Mutex;

/// Keeps the branch of `genesis_validators_root` for each attested state root.
pub trait GenesisValidatorsRootBranchStore: Send + Sync {
    /// The branch stored for `state_root`, or `None` when the store holds none.
    fn get(&self, state_root: &B256) -> Option<Vec<B256>>;

    /// Stores the branch for `state_root`. A later call for the same root replaces the entry.
    ///
    /// # Errors
    /// `Error::Config` when the store cannot write.
    fn put(&self, state_root: B256, branch: Vec<B256>) -> Result<()>;
}

/// A store in memory. It lives as long as the process.
#[derive(Default)]
pub struct MemoryBranchStore {
    branches: Mutex<BTreeMap<B256, Vec<B256>>>,
}

impl MemoryBranchStore {
    /// An empty store.
    pub fn new() -> Self {
        Self::default()
    }

    /// Replaces the entry for `state_root` with a branch whose first entry is flipped. A test uses this to model a corrupt
    /// store. It does nothing when the store holds no entry for the root.
    #[cfg(test)]
    pub fn corrupt(&self, state_root: &B256) {
        let mut branches = self.branches.lock().expect("lock");
        if let Some(first) = branches
            .get_mut(state_root)
            .and_then(|branch| branch.first_mut())
        {
            first.0[0] ^= 0x01;
        }
    }
}

impl GenesisValidatorsRootBranchStore for MemoryBranchStore {
    fn get(&self, state_root: &B256) -> Option<Vec<B256>> {
        self.branches.lock().expect("lock").get(state_root).cloned()
    }

    fn put(&self, state_root: B256, branch: Vec<B256>) -> Result<()> {
        self.branches
            .lock()
            .expect("lock")
            .insert(state_root, branch);
        Ok(())
    }
}

/// A store in a directory: one file per state root, named by the root, holding the entries as hex lines. It survives
/// between runs, which a catch-up after weeks needs.
pub struct DirectoryBranchStore {
    directory: PathBuf,
}

impl DirectoryBranchStore {
    /// A store in `directory`. The directory is created on the first `put`.
    pub fn new(directory: impl Into<PathBuf>) -> Self {
        Self {
            directory: directory.into(),
        }
    }

    fn path_of(&self, state_root: &B256) -> PathBuf {
        self.directory.join(format!("{state_root:#x}.branch"))
    }
}

impl GenesisValidatorsRootBranchStore for DirectoryBranchStore {
    /// A file that cannot be read or does not parse counts as no entry, so the prover then asks the node for the state.
    fn get(&self, state_root: &B256) -> Option<Vec<B256>> {
        let text = std::fs::read_to_string(self.path_of(state_root)).ok()?;
        text.lines()
            .map(|line| line.trim().parse::<B256>().ok())
            .collect()
    }

    fn put(&self, state_root: B256, branch: Vec<B256>) -> Result<()> {
        let describe = |error: std::io::Error| {
            Error::Config(format!(
                "the branch store {}: {error}",
                self.directory.display()
            ))
        };
        std::fs::create_dir_all(&self.directory).map_err(describe)?;
        let text: String = branch
            .iter()
            .map(|entry| format!("0x{}\n", hex::encode(entry)))
            .collect();
        std::fs::write(self.path_of(&state_root), text).map_err(describe)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn branch() -> Vec<B256> {
        (1..=5).map(B256::repeat_byte).collect()
    }

    /// Claim: both stores give back exactly what was put, give nothing for another root, and replace an entry on a second
    /// put.
    /// Why it matters: a catch-up trusts the key. An entry returned for the wrong root would be refused by the program, but
    /// only after the prover spent time on it, and a lost entry would force a fetch of a state the node may have pruned.
    #[test]
    fn both_stores_round_trip_by_state_root() {
        let directory =
            std::env::temp_dir().join(format!("zk-bridge-branch-store-{}", std::process::id()));
        let stores: [Box<dyn GenesisValidatorsRootBranchStore>; 2] = [
            Box::new(MemoryBranchStore::new()),
            Box::new(DirectoryBranchStore::new(&directory)),
        ];
        for store in stores {
            let root = B256::repeat_byte(0xaa);
            assert_eq!(store.get(&root), None);
            store.put(root, branch()).unwrap();
            assert_eq!(store.get(&root), Some(branch()));
            assert_eq!(store.get(&B256::repeat_byte(0xbb)), None);
            let replacement: Vec<B256> = vec![B256::repeat_byte(9)];
            store.put(root, replacement.clone()).unwrap();
            assert_eq!(store.get(&root), Some(replacement));
        }
        let _ = std::fs::remove_dir_all(&directory);
    }

    /// Claim: a file that does not parse counts as no entry.
    /// Why it matters: the store is untrusted. A damaged file must not become a made-up branch.
    #[test]
    fn a_damaged_file_counts_as_no_entry() {
        let directory = std::env::temp_dir().join(format!(
            "zk-bridge-branch-store-damaged-{}",
            std::process::id()
        ));
        let store = DirectoryBranchStore::new(&directory);
        let root = B256::repeat_byte(0xcc);
        store.put(root, branch()).unwrap();
        std::fs::write(store.path_of(&root), "0xnot-hex\n").unwrap();
        assert_eq!(store.get(&root), None);
        let _ = std::fs::remove_dir_all(&directory);
    }
}
