//! A store for beacon states the prover has downloaded and verified, kept so a later run never depends on a node that
//! still serves an old state.
//!
//! A light-client update starts from the state of the stored head. Public nodes keep old states badly: Lodestar answers
//! 500 for a state that is no longer recent, and Lighthouse-Pulse serves frozen states one summary short. So the prover
//! keeps each state it verified here, keyed by its root, and reads it back before it asks a node.
//!
//! The store is not trusted. The caller parses every state read from it and accepts it only when it hashes to the root
//! that the header names. A file that fails is removed. A state that was repaired (see `missing_summary_index`) is kept
//! as the bytes the node served plus the appended summary entry in a sidecar file, and the caller repeats the repair.

use crate::error::{Error, Result};
use alloy_primitives::B256;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::{Duration, SystemTime};

/// Counts the temporary files of this process, so two writes never share a temporary name.
static TEMPORARY_FILE_COUNTER: AtomicU64 = AtomicU64::new(0);

/// How many of the newest states of a chain the store keeps whatever their age.
pub const DEFAULT_KEEP_NEWEST: usize = 16;

/// States younger than this stay, however many there are.
pub const DEFAULT_MAX_AGE: Duration = Duration::from_secs(3 * 24 * 3600);

/// A state as the store keeps it: the SSZ bytes a node served, and the summary entry the prover appended to repair it.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct StoredState {
    /// The SSZ bytes of `GET /eth/v2/debug/beacon/states/<root>`.
    pub bytes: Vec<u8>,
    /// The `historical_summaries` entry appended to the served bytes, when the state was repaired.
    pub appended_summary: Option<(B256, B256)>,
}

/// Keeps verified states by state root.
pub trait StateStore: Send + Sync {
    /// The state stored for `state_root`, or `None`.
    fn get(&self, state_root: &B256) -> Option<StoredState>;

    /// Stores a state, then drops old ones (see [`DirectoryStateStore`]).
    ///
    /// # Errors
    /// `Error::Config` when the store cannot write.
    fn put(&self, state_root: B256, slot: u64, state: &StoredState) -> Result<()>;

    /// Drops the state of `state_root`. It does nothing when the store holds none.
    ///
    /// # Errors
    /// `Error::Config` when the store cannot remove the entry.
    fn remove(&self, state_root: &B256) -> Result<()>;
}

/// A store in a directory, one subdirectory per chain. A state is `<slot>-<root>.ssz`, mode 0600, with
/// `<slot>-<root>.summary` next to it for a repaired state. A write goes to a temporary file and a rename puts it in place.
/// After each write the store keeps the [`DEFAULT_KEEP_NEWEST`] newest states of the chain and every state younger than
/// [`DEFAULT_MAX_AGE`], and removes the rest.
pub struct DirectoryStateStore {
    directory: PathBuf,
    keep_newest: usize,
    max_age: Duration,
}

impl DirectoryStateStore {
    /// A store for the states of `chain_id` in `directory/<chain_id>`. The directory is created on the first `put`.
    pub fn new(directory: impl Into<PathBuf>, chain_id: u64) -> Self {
        Self {
            directory: directory.into().join(chain_id.to_string()),
            keep_newest: DEFAULT_KEEP_NEWEST,
            max_age: DEFAULT_MAX_AGE,
        }
    }

    /// The same store with another retention: the `keep_newest` newest states, and every state younger than `max_age`.
    pub fn with_retention(mut self, keep_newest: usize, max_age: Duration) -> Self {
        self.keep_newest = keep_newest;
        self.max_age = max_age;
        self
    }

    fn describe(&self, error: std::io::Error) -> Error {
        Error::Config(format!(
            "the state store {}: {error}",
            self.directory.display()
        ))
    }

    fn base_name(slot: u64, state_root: &B256) -> String {
        format!("{slot:012}-{state_root:#x}")
    }

    /// The stored files as `(slot, base path)`, newest slot first. Unknown names are skipped.
    fn entries(&self) -> Vec<(u64, PathBuf)> {
        let Ok(listing) = std::fs::read_dir(&self.directory) else {
            return Vec::new();
        };
        let mut entries: Vec<(u64, PathBuf)> = listing
            .filter_map(|entry| entry.ok())
            .filter_map(|entry| {
                let name = entry.file_name().into_string().ok()?;
                let base = name.strip_suffix(".ssz")?;
                let (slot, _) = base.split_once('-')?;
                Some((slot.parse().ok()?, self.directory.join(base)))
            })
            .collect();
        entries.sort_by_key(|(slot, _)| std::cmp::Reverse(*slot));
        entries
    }

    fn find(&self, state_root: &B256) -> Option<PathBuf> {
        let suffix = format!("-{state_root:#x}");
        self.entries()
            .into_iter()
            .map(|(_, base)| base)
            .find(|base| base.to_string_lossy().ends_with(&suffix))
    }

    fn with_extension(base: &Path, extension: &str) -> PathBuf {
        let mut name = base.as_os_str().to_owned();
        name.push(format!(".{extension}"));
        PathBuf::from(name)
    }

    fn write_private(&self, path: &Path, bytes: &[u8]) -> std::io::Result<()> {
        use std::io::Write as _;
        let count = TEMPORARY_FILE_COUNTER.fetch_add(1, Ordering::Relaxed);
        let temporary = Self::with_extension(path, &format!("{}.{count}.tmp", std::process::id()));
        let mut options = std::fs::OpenOptions::new();
        options.write(true).create_new(true);
        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt as _;
            options.mode(0o600);
        }
        let written = options.open(&temporary).and_then(|mut file| {
            file.write_all(bytes)?;
            file.sync_all()
        });
        let placed = written.and_then(|()| std::fs::rename(&temporary, path));
        if placed.is_err() {
            let _ = std::fs::remove_file(&temporary);
        }
        placed
    }

    fn remove_base(base: &Path) {
        let _ = std::fs::remove_file(Self::with_extension(base, "ssz"));
        let _ = std::fs::remove_file(Self::with_extension(base, "summary"));
    }

    /// Keeps the newest states and the young ones; removes the rest.
    fn prune(&self) {
        let now = SystemTime::now();
        for (_, base) in self.entries().into_iter().skip(self.keep_newest) {
            let young = std::fs::metadata(Self::with_extension(&base, "ssz"))
                .and_then(|metadata| metadata.modified())
                .ok()
                .and_then(|modified| now.duration_since(modified).ok())
                .is_some_and(|age| age < self.max_age);
            if !young {
                Self::remove_base(&base);
            }
        }
    }
}

fn parse_summary(text: &str) -> Option<(B256, B256)> {
    let mut lines = text.lines().map(|line| line.trim().parse::<B256>());
    match (lines.next(), lines.next(), lines.next()) {
        (Some(Ok(block)), Some(Ok(state)), None) => Some((block, state)),
        _ => None,
    }
}

impl StateStore for DirectoryStateStore {
    /// A file that cannot be read counts as no entry. A sidecar that does not parse drops the entry.
    fn get(&self, state_root: &B256) -> Option<StoredState> {
        let base = self.find(state_root)?;
        let bytes = std::fs::read(Self::with_extension(&base, "ssz")).ok()?;
        let appended_summary = match std::fs::read_to_string(Self::with_extension(&base, "summary"))
        {
            Ok(text) => Some(parse_summary(&text)?),
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => None,
            Err(_) => return None,
        };
        Some(StoredState {
            bytes,
            appended_summary,
        })
    }

    fn put(&self, state_root: B256, slot: u64, state: &StoredState) -> Result<()> {
        std::fs::create_dir_all(&self.directory).map_err(|error| self.describe(error))?;
        if let Some(old) = self.find(&state_root) {
            Self::remove_base(&old);
        }
        let base = self.directory.join(Self::base_name(slot, &state_root));
        if let Some((block, summary)) = state.appended_summary {
            self.write_private(
                &Self::with_extension(&base, "summary"),
                format!("{block:#x}\n{summary:#x}\n").as_bytes(),
            )
            .map_err(|error| self.describe(error))?;
        }
        self.write_private(&Self::with_extension(&base, "ssz"), &state.bytes)
            .map_err(|error| self.describe(error))?;
        self.prune();
        Ok(())
    }

    fn remove(&self, state_root: &B256) -> Result<()> {
        if let Some(base) = self.find(state_root) {
            Self::remove_base(&base);
        }
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn directory(name: &str) -> PathBuf {
        let path = std::env::temp_dir().join(format!(
            "zk-bridge-state-store-{name}-{}",
            std::process::id()
        ));
        let _ = std::fs::remove_dir_all(&path);
        path
    }

    fn state(byte: u8) -> StoredState {
        StoredState {
            bytes: vec![byte; 64],
            appended_summary: None,
        }
    }

    /// Claim: a stored state comes back by its root, with its appended summary, and a missing root gives `None`.
    /// Why it matters: the prover reads the state of an old head from here when no node serves it any more.
    #[test]
    fn a_state_comes_back_by_its_root_with_its_appended_summary() {
        let path = directory("roundtrip");
        let store = DirectoryStateStore::new(&path, 943);
        let root = B256::repeat_byte(1);
        let repaired = StoredState {
            bytes: vec![7; 100],
            appended_summary: Some((B256::repeat_byte(2), B256::repeat_byte(3))),
        };
        store.put(root, 11, &repaired).unwrap();
        assert_eq!(store.get(&root), Some(repaired));
        assert_eq!(store.get(&B256::repeat_byte(9)), None);
        store.remove(&root).unwrap();
        assert_eq!(store.get(&root), None);
        let _ = std::fs::remove_dir_all(path);
    }

    /// Claim: states of two chains live apart, and a state file is readable by its owner only.
    /// Why it matters: one directory serves both routes of a bot, and the states are kept next to its secrets.
    #[test]
    fn chains_live_apart_and_files_are_private() {
        let path = directory("chains");
        let root = B256::repeat_byte(4);
        DirectoryStateStore::new(&path, 1)
            .put(root, 5, &state(1))
            .unwrap();
        assert_eq!(DirectoryStateStore::new(&path, 369).get(&root), None);
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt as _;
            let file = path.join("1").join(format!("{:012}-{root:#x}.ssz", 5));
            let mode = std::fs::metadata(file).unwrap().permissions().mode();
            assert_eq!(mode & 0o777, 0o600);
        }
        let _ = std::fs::remove_dir_all(path);
    }

    /// Claim: after a write the store keeps the newest states and the young ones, and removes old states beyond that.
    /// Why it matters: a state of a large chain is big; the store must not grow without end.
    #[test]
    fn old_states_beyond_the_newest_are_pruned_and_young_ones_stay() {
        let path = directory("prune");
        let old = DirectoryStateStore::new(&path, 1).with_retention(2, Duration::ZERO);
        for slot in 1..=4u64 {
            old.put(B256::repeat_byte(slot as u8), slot, &state(slot as u8))
                .unwrap();
        }
        let kept: Vec<u64> = old.entries().into_iter().map(|(slot, _)| slot).collect();
        assert_eq!(
            kept,
            vec![4, 3],
            "only the two newest stay when nothing is young"
        );

        let young = DirectoryStateStore::new(&path, 1).with_retention(1, DEFAULT_MAX_AGE);
        young.put(B256::repeat_byte(9), 9, &state(9)).unwrap();
        assert_eq!(
            young.entries().len(),
            3,
            "young states stay beyond the newest"
        );
        let _ = std::fs::remove_dir_all(path);
    }

    /// Claim: a sidecar that does not parse makes the entry absent, so the prover asks a node instead.
    /// Why it matters: the store is not trusted; a damaged file must never stop a run.
    #[test]
    fn a_damaged_summary_makes_the_entry_absent() {
        let path = directory("damaged");
        let store = DirectoryStateStore::new(&path, 943);
        let root = B256::repeat_byte(5);
        let repaired = StoredState {
            bytes: vec![1; 8],
            appended_summary: Some((B256::repeat_byte(6), B256::repeat_byte(7))),
        };
        store.put(root, 3, &repaired).unwrap();
        let sidecar = path
            .join("943")
            .join(format!("{:012}-{root:#x}.summary", 3));
        std::fs::write(sidecar, "not a root\n").unwrap();
        assert_eq!(store.get(&root), None);
        let _ = std::fs::remove_dir_all(path);
    }
}
