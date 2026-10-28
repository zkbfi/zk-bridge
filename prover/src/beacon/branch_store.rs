//! A store for the branches of `genesis_validators_root`, kept as untrusted public data.
//!
//! An update must carry the branch of `genesis_validators_root` under the state root of its attested header. A beacon
//! node does not serve this branch. The prover computes it from the attested state while the state is fresh. A long
//! catch-up needs the attested states of old updates, and a node prunes them (the PulseChain node also served stale old
//! states). So the prover keeps each branch here, keyed by the state root, and a later catch-up reads it back when the
//! node no longer has the state.
//!
//! The store is not trusted. A branch is public data. The prover checks each stored entry natively against the attested
//! state root (see [`stored_branch_proves_genesis_validators_root`]) before it uses the entry. An entry that fails the
//! check is dropped, and the prover builds the branch again from the state. If the node no longer serves the state, the
//! prover stops with a clear error that names the state root. As a last guard, the light-client program refuses a wrong
//! branch (`InvalidGenesisValidatorsRootBranch`). A wrong entry can stall a catch-up. It cannot cause a false head.

use crate::error::{Error, Result};
use alloy_primitives::{hex, B256};
use lc_core::chain::ChainSpec;
use lc_core::layout::state_layout_for_finality_branch_length;
use lc_core::ssz::is_valid_exact_branch;
use std::collections::BTreeMap;
use std::path::PathBuf;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Mutex;

/// Counts the temporary files of this process, so two writes never share a temporary name.
static TEMPORARY_FILE_COUNTER: AtomicU64 = AtomicU64::new(0);

/// Tells whether `branch` proves the `genesis_validators_root` of `spec` under `state_root`.
///
/// The check is the one the light-client program runs: the layout comes from the length of the finality branch of the
/// update (`finality_branch_length`), the position is the generalized index of `genesis_validators_root` in that layout,
/// and the leaf is `spec.genesis_validators_root`. The branch needs exactly the depth of that position.
///
/// # Errors
/// `Error::Malformed` when `finality_branch_length` names no layout.
pub fn stored_branch_proves_genesis_validators_root(
    spec: &ChainSpec,
    finality_branch_length: usize,
    branch: &[B256],
    state_root: &B256,
) -> Result<bool> {
    let layout = state_layout_for_finality_branch_length(finality_branch_length)
        .map_err(|error| Error::Malformed(format!("the finality branch: {error}")))?;
    Ok(is_valid_exact_branch(
        &spec.genesis_validators_root,
        branch,
        layout.genesis_validators_root_gindex,
        state_root,
    ))
}

/// Keeps the branch of `genesis_validators_root` for each attested state root.
pub trait GenesisValidatorsRootBranchStore: Send + Sync {
    /// The branch stored for `state_root`, or `None` when the store holds none.
    fn get(&self, state_root: &B256) -> Option<Vec<B256>>;

    /// Stores the branch for `state_root`. A later call for the same root replaces the entry.
    ///
    /// # Errors
    /// `Error::Config` when the store cannot write.
    fn put(&self, state_root: B256, branch: Vec<B256>) -> Result<()>;

    /// Drops the entry for `state_root`. It does nothing when the store holds none.
    ///
    /// # Errors
    /// `Error::Config` when the store cannot remove the entry.
    fn remove(&self, state_root: &B256) -> Result<()>;
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

    fn remove(&self, state_root: &B256) -> Result<()> {
        self.branches.lock().expect("lock").remove(state_root);
        Ok(())
    }
}

/// A store in a directory: one file per state root, named by the root, holding the entries as hex lines. It survives
/// between runs, which a catch-up after weeks needs. A write goes to a temporary file in the same directory, and a
/// rename then puts it in place, so a crash never leaves a short entry under the real name.
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

    /// A name for a temporary file next to the entry of `state_root`. It ends in `.tmp`, so `get` never reads it.
    fn temporary_path_of(&self, state_root: &B256) -> PathBuf {
        let count = TEMPORARY_FILE_COUNTER.fetch_add(1, Ordering::Relaxed);
        self.directory.join(format!(
            "{state_root:#x}.branch.{}.{count}.tmp",
            std::process::id()
        ))
    }

    /// Writes `text` to `temporary` and flushes it to disk. The caller renames the file.
    fn write_durably(temporary: &std::path::Path, text: &str) -> std::io::Result<()> {
        use std::io::Write as _;
        let mut file = std::fs::File::create(temporary)?;
        file.write_all(text.as_bytes())?;
        file.sync_all()
    }
}

impl GenesisValidatorsRootBranchStore for DirectoryBranchStore {
    /// A file that cannot be read or does not parse counts as no entry, so the prover then asks the node for the state.
    /// A file that parses but is short or wrong is the business of the caller, who checks the branch.
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
        let temporary = self.temporary_path_of(&state_root);
        let written = Self::write_durably(&temporary, &text)
            .and_then(|()| std::fs::rename(&temporary, self.path_of(&state_root)));
        if written.is_err() {
            let _ = std::fs::remove_file(&temporary);
        }
        written.map_err(describe)
    }

    fn remove(&self, state_root: &B256) -> Result<()> {
        match std::fs::remove_file(self.path_of(state_root)) {
            Err(error) if error.kind() != std::io::ErrorKind::NotFound => Err(Error::Config(
                format!("the branch store {}: {error}", self.directory.display()),
            )),
            _ => Ok(()),
        }
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

    /// Claim: a put leaves no temporary file behind, and a second put replaces the entry whole.
    /// Why it matters: the write goes to a temporary file first. A leftover file would show that the rename step did not
    /// run, and a short file under the real name would show that the write was not atomic.
    #[test]
    fn a_put_leaves_only_the_finished_entry() {
        let directory = std::env::temp_dir().join(format!(
            "zk-bridge-branch-store-atomic-{}",
            std::process::id()
        ));
        let store = DirectoryBranchStore::new(&directory);
        let root = B256::repeat_byte(0xdd);
        store.put(root, branch()).unwrap();
        store.put(root, vec![B256::repeat_byte(7)]).unwrap();
        let names: Vec<String> = std::fs::read_dir(&directory)
            .unwrap()
            .map(|entry| entry.unwrap().file_name().to_string_lossy().into_owned())
            .collect();
        assert_eq!(names, vec![format!("{root:#x}.branch")]);
        assert_eq!(store.get(&root), Some(vec![B256::repeat_byte(7)]));
        let _ = std::fs::remove_dir_all(&directory);
    }

    /// Claim: a remove drops the entry in both stores, and a remove of a missing entry is not an error.
    /// Why it matters: the prover drops an entry that fails the check. If the drop failed on a missing file, one
    /// repeated drop would stop a catch-up.
    #[test]
    fn a_remove_drops_the_entry_and_forgives_a_missing_one() {
        let directory = std::env::temp_dir().join(format!(
            "zk-bridge-branch-store-remove-{}",
            std::process::id()
        ));
        let stores: [Box<dyn GenesisValidatorsRootBranchStore>; 2] = [
            Box::new(MemoryBranchStore::new()),
            Box::new(DirectoryBranchStore::new(&directory)),
        ];
        for store in stores {
            let root = B256::repeat_byte(0xee);
            store.remove(&root).unwrap();
            store.put(root, branch()).unwrap();
            store.remove(&root).unwrap();
            assert_eq!(store.get(&root), None);
        }
        let _ = std::fs::remove_dir_all(&directory);
    }

    /// Claim: the check accepts a branch built over the genesis validators root of the chain at the position of the
    /// layout, and refuses a flipped entry, a short branch, a wrong state root, and a finality length that names no layout.
    /// Why it matters: this check decides whether a stored entry is used. It must fail for each way an entry goes bad.
    #[test]
    fn the_check_accepts_only_the_real_branch_at_the_layout_position() {
        use lc_core::ssz::branch_for_leaf;
        let spec = crate::light_client::ChainKind::Sepolia.spec();
        // A plain state of 32 leaves: the finality branch has 6 entries, and genesis_validators_root is leaf 1.
        let mut leaves = vec![B256::ZERO; 32];
        leaves[1] = spec.genesis_validators_root;
        let (root, branch) = branch_for_leaf(&leaves, 1);
        assert!(stored_branch_proves_genesis_validators_root(spec, 6, &branch, &root).unwrap());
        let mut flipped = branch.clone();
        flipped[0].0[0] ^= 1;
        assert!(!stored_branch_proves_genesis_validators_root(spec, 6, &flipped, &root).unwrap());
        assert!(
            !stored_branch_proves_genesis_validators_root(spec, 6, &branch[..4], &root).unwrap()
        );
        assert!(!stored_branch_proves_genesis_validators_root(
            spec,
            6,
            &branch,
            &B256::repeat_byte(1)
        )
        .unwrap());
        assert!(stored_branch_proves_genesis_validators_root(spec, 3, &branch, &root).is_err());
    }
}
