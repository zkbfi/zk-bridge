//! The SQLite file. A restart reads it and resumes where the service stopped.
//!
//! Idempotence rests on three rules. A deposit row is inserted once (`INSERT OR IGNORE` on the nonce), so a rescan
//! never resets a state. The scan cursor moves in the same transaction as the inserts. Every state change checks the
//! old state, so two writers cannot both move a row.

use crate::error::{Error, Result};
use crate::state::{transition, DepositState, Event};
use alloy_primitives::{Address, B256, U256};
use rusqlite::{params, Connection, OptionalExtension};
use std::path::Path;
use std::str::FromStr;
use std::time::{SystemTime, UNIX_EPOCH};

const SCHEMA_VERSION: i64 = 1;

/// A deposit as the scanner first sees it.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct NewDeposit {
    /// The route name, for example `a_to_b`.
    pub route: String,
    /// The unique deposit nonce.
    pub nonce: B256,
    /// Token on the source chain.
    pub token: Address,
    /// Depositor.
    pub sender: Address,
    /// Recipient on the destination chain.
    pub recipient: Address,
    /// Amount.
    pub amount: U256,
    /// Source block number.
    pub block_number: u64,
    /// Source block hash.
    pub block_hash: B256,
    /// Source transaction hash.
    pub transaction_hash: B256,
    /// Index of the transaction in the block (the receipts trie key).
    pub transaction_index: u64,
    /// Index of the log inside the receipt (not inside the block).
    pub log_index: u64,
}

/// A stored deposit.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct DepositRecord {
    /// The deposit as first seen.
    pub deposit: NewDeposit,
    /// The state.
    pub state: DepositState,
    /// The withdrawal calldata, once built.
    pub calldata: Option<Vec<u8>>,
    /// The hash of the withdrawal transaction, once sent.
    pub withdrawal_transaction: Option<B256>,
    /// The reason for the last refusal, retry or failure.
    pub note: Option<String>,
    /// How many times a step failed and was tried again.
    pub attempts: u32,
}

/// A row as SQLite returns it, before the texts are parsed.
struct RawRecord {
    /// nonce, route, token, sender, recipient, amount, block hash, transaction hash, state.
    texts: [String; 9],
    block_number: u64,
    transaction_index: u64,
    log_index: u64,
    calldata: Option<Vec<u8>>,
    withdrawal_transaction: Option<String>,
    note: Option<String>,
    attempts: u32,
}

impl RawRecord {
    fn into_record(self) -> Result<DepositRecord> {
        let [nonce, route, token, sender, recipient, amount, block_hash, transaction_hash, state] =
            self.texts;
        Ok(DepositRecord {
            deposit: NewDeposit {
                route,
                nonce: parse(&nonce, "nonce")?,
                token: parse(&token, "token")?,
                sender: parse(&sender, "sender")?,
                recipient: parse(&recipient, "recipient")?,
                amount: parse(&amount, "amount")?,
                block_number: self.block_number,
                block_hash: parse(&block_hash, "block hash")?,
                transaction_hash: parse(&transaction_hash, "transaction hash")?,
                transaction_index: self.transaction_index,
                log_index: self.log_index,
            },
            state: DepositState::parse(&state)?,
            calldata: self.calldata,
            withdrawal_transaction: self
                .withdrawal_transaction
                .as_deref()
                .map(|hash| parse(hash, "withdrawal transaction"))
                .transpose()?,
            note: self.note,
            attempts: self.attempts,
        })
    }
}

/// The SQLite file.
pub struct Store {
    connection: Connection,
}

fn now() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|elapsed| elapsed.as_secs() as i64)
        .unwrap_or(0)
}

fn parse<T: FromStr>(text: &str, what: &str) -> Result<T>
where
    T::Err: std::fmt::Display,
{
    text.parse()
        .map_err(|error| Error::Database(format!("stored {what} {text}: {error}")))
}

impl Store {
    /// Opens (and creates) the file, and applies the schema.
    ///
    /// # Errors
    /// `Error::Database` when the file cannot be opened or has a newer schema.
    pub fn open(path: &Path) -> Result<Self> {
        Self::from_connection(Connection::open(path)?)
    }

    /// An in-memory store for tests.
    pub fn open_in_memory() -> Result<Self> {
        Self::from_connection(Connection::open_in_memory()?)
    }

    fn from_connection(connection: Connection) -> Result<Self> {
        connection
            .execute_batch("PRAGMA journal_mode = WAL; PRAGMA synchronous = FULL;")
            .or_else(|_| {
                // An in-memory database has no WAL. That is fine.
                connection.execute_batch("PRAGMA synchronous = FULL;")
            })?;
        let version: i64 = connection.query_row("PRAGMA user_version", [], |row| row.get(0))?;
        if version > SCHEMA_VERSION {
            return Err(Error::Database(format!(
                "the file has schema {version}, this program knows {SCHEMA_VERSION}"
            )));
        }
        connection.execute_batch(
            "CREATE TABLE IF NOT EXISTS deposits (
                nonce TEXT PRIMARY KEY,
                route TEXT NOT NULL,
                token TEXT NOT NULL,
                sender TEXT NOT NULL,
                recipient TEXT NOT NULL,
                amount TEXT NOT NULL,
                block_number INTEGER NOT NULL,
                block_hash TEXT NOT NULL,
                transaction_hash TEXT NOT NULL,
                transaction_index INTEGER NOT NULL,
                log_index INTEGER NOT NULL,
                state TEXT NOT NULL,
                calldata BLOB,
                withdrawal_transaction TEXT,
                note TEXT,
                attempts INTEGER NOT NULL DEFAULT 0,
                created_at INTEGER NOT NULL,
                updated_at INTEGER NOT NULL
            );
            CREATE TABLE IF NOT EXISTS cursors (
                route TEXT PRIMARY KEY,
                last_scanned_block INTEGER NOT NULL
            );",
        )?;
        connection.pragma_update(None, "user_version", SCHEMA_VERSION)?;
        Ok(Self { connection })
    }

    /// The last source block that the scanner covered for a route.
    pub fn cursor(&self, route: &str) -> Result<Option<u64>> {
        let value: Option<i64> = self
            .connection
            .query_row(
                "SELECT last_scanned_block FROM cursors WHERE route = ?1",
                [route],
                |row| row.get(0),
            )
            .optional()?;
        Ok(value.map(|block| block as u64))
    }

    /// Stores the new deposits and moves the cursor in one transaction. Returns how many deposits were new.
    ///
    /// A deposit that already exists keeps its state: a rescan never resets progress.
    pub fn record_scan(
        &mut self,
        route: &str,
        deposits: &[NewDeposit],
        new_cursor: u64,
    ) -> Result<usize> {
        let transaction = self.connection.transaction()?;
        let mut inserted = 0;
        for deposit in deposits {
            inserted += transaction.execute(
                "INSERT OR IGNORE INTO deposits (nonce, route, token, sender, recipient, amount, block_number, block_hash,
                    transaction_hash, transaction_index, log_index, state, created_at, updated_at)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, 'seen', ?12, ?12)",
                params![
                    format!("{:#x}", deposit.nonce),
                    deposit.route,
                    format!("{:#x}", deposit.token),
                    format!("{:#x}", deposit.sender),
                    format!("{:#x}", deposit.recipient),
                    deposit.amount.to_string(),
                    deposit.block_number as i64,
                    format!("{:#x}", deposit.block_hash),
                    format!("{:#x}", deposit.transaction_hash),
                    deposit.transaction_index as i64,
                    deposit.log_index as i64,
                    now(),
                ],
            )?;
        }
        transaction.execute(
            "INSERT INTO cursors (route, last_scanned_block) VALUES (?1, ?2)
             ON CONFLICT(route) DO UPDATE SET last_scanned_block = MAX(last_scanned_block, excluded.last_scanned_block)",
            params![route, new_cursor as i64],
        )?;
        transaction.commit()?;
        Ok(inserted)
    }

    const COLUMNS: &'static str = "nonce, route, token, sender, recipient, amount, block_number, block_hash,
        transaction_hash, transaction_index, log_index, state, calldata, withdrawal_transaction, note, attempts";

    fn read_record(row: &rusqlite::Row<'_>) -> rusqlite::Result<RawRecord> {
        Ok(RawRecord {
            texts: [
                row.get(0)?,
                row.get(1)?,
                row.get(2)?,
                row.get(3)?,
                row.get(4)?,
                row.get(5)?,
                row.get(7)?,
                row.get(8)?,
                row.get(11)?,
            ],
            block_number: row.get::<_, i64>(6)? as u64,
            transaction_index: row.get::<_, i64>(9)? as u64,
            log_index: row.get::<_, i64>(10)? as u64,
            calldata: row.get(12)?,
            withdrawal_transaction: row.get(13)?,
            note: row.get(14)?,
            attempts: row.get::<_, i64>(15)? as u32,
        })
    }

    /// One deposit by nonce.
    pub fn get(&self, nonce: B256) -> Result<Option<DepositRecord>> {
        let sql = format!("SELECT {} FROM deposits WHERE nonce = ?1", Self::COLUMNS);
        let raw = self
            .connection
            .query_row(&sql, [format!("{nonce:#x}")], Self::read_record)
            .optional()?;
        raw.map(RawRecord::into_record).transpose()
    }

    /// Every deposit, oldest block first. With `route`, only that route.
    pub fn list(&self, route: Option<&str>) -> Result<Vec<DepositRecord>> {
        let sql = format!(
            "SELECT {} FROM deposits WHERE (?1 IS NULL OR route = ?1) ORDER BY block_number, transaction_index, log_index",
            Self::COLUMNS
        );
        let mut statement = self.connection.prepare(&sql)?;
        let rows = statement
            .query_map([route], Self::read_record)?
            .collect::<rusqlite::Result<Vec<_>>>()?;
        rows.into_iter().map(RawRecord::into_record).collect()
    }

    /// Stores one deposit without moving a cursor. Returns whether it was new. Used by the manual `withdraw` command.
    pub fn insert_deposit(&mut self, deposit: &NewDeposit) -> Result<bool> {
        let before = self.get(deposit.nonce)?.is_some();
        let cursor = self.cursor(&deposit.route)?.unwrap_or(0);
        self.record_scan(&deposit.route, std::slice::from_ref(deposit), cursor)?;
        Ok(!before)
    }

    /// The deposits of a route that no terminal state ends, oldest block first.
    pub fn active(&self, route: &str) -> Result<Vec<DepositRecord>> {
        Ok(self
            .list(Some(route))?
            .into_iter()
            .filter(|record| !record.state.is_terminal())
            .collect())
    }

    /// Applies an event to a deposit: checks the table, then writes the new state with a note.
    ///
    /// Returns the old and the new state. The write only happens when the stored state still equals the old state.
    ///
    /// # Errors
    /// `Error::Usage` when the event is not allowed. `Error::Database` when the row changed meanwhile.
    pub fn apply(
        &self,
        nonce: B256,
        event: Event,
        note: Option<&str>,
    ) -> Result<(DepositState, DepositState)> {
        let record = self
            .get(nonce)?
            .ok_or_else(|| Error::Database(format!("no deposit {nonce:#x}")))?;
        let next = transition(record.state, event)?;
        let changed = self.connection.execute(
            "UPDATE deposits SET state = ?1, note = COALESCE(?2, note), updated_at = ?3 WHERE nonce = ?4 AND state = ?5",
            params![next.as_str(), note, now(), format!("{nonce:#x}"), record.state.as_str()],
        )?;
        if changed != 1 {
            return Err(Error::Database(format!(
                "deposit {nonce:#x} changed state while it was being updated"
            )));
        }
        Ok((record.state, next))
    }

    /// Stores the withdrawal calldata.
    pub fn set_calldata(&self, nonce: B256, calldata: &[u8]) -> Result<()> {
        self.connection.execute(
            "UPDATE deposits SET calldata = ?1, updated_at = ?2 WHERE nonce = ?3",
            params![calldata, now(), format!("{nonce:#x}")],
        )?;
        Ok(())
    }

    /// Stores the hash of the withdrawal transaction.
    pub fn set_withdrawal_transaction(&self, nonce: B256, hash: B256) -> Result<()> {
        self.connection.execute(
            "UPDATE deposits SET withdrawal_transaction = ?1, updated_at = ?2 WHERE nonce = ?3",
            params![format!("{hash:#x}"), now(), format!("{nonce:#x}")],
        )?;
        Ok(())
    }

    /// Stores a note and counts no attempt. The service uses it for a deposit that waits.
    pub fn set_note(&self, nonce: B256, note: &str) -> Result<()> {
        self.connection.execute(
            "UPDATE deposits SET note = ?1, updated_at = ?2 WHERE nonce = ?3",
            params![note, now(), format!("{nonce:#x}")],
        )?;
        Ok(())
    }

    /// Counts one failed attempt, stores the note, and returns the new count.
    pub fn record_attempt(&self, nonce: B256, note: &str) -> Result<u32> {
        self.connection.execute(
            "UPDATE deposits SET attempts = attempts + 1, note = ?1, updated_at = ?2 WHERE nonce = ?3",
            params![note, now(), format!("{nonce:#x}")],
        )?;
        Ok(self.get(nonce)?.map(|record| record.attempts).unwrap_or(0))
    }
}

#[cfg(test)]
pub(crate) fn sample_deposit(seed: u8, block_number: u64) -> NewDeposit {
    NewDeposit {
        route: "a_to_b".into(),
        nonce: B256::repeat_byte(seed),
        token: Address::repeat_byte(0x01),
        sender: Address::repeat_byte(0x02),
        recipient: Address::repeat_byte(0x03),
        amount: U256::from(1_000u64),
        block_number,
        block_hash: B256::repeat_byte(0xbb),
        transaction_hash: B256::repeat_byte(0xcc),
        transaction_index: 1,
        log_index: 0,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn scratch_file(name: &str) -> std::path::PathBuf {
        let directory =
            std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("target/test-scratch");
        std::fs::create_dir_all(&directory).unwrap();
        let path = directory.join(format!("{name}-{}.sqlite", std::process::id()));
        let _ = std::fs::remove_file(&path);
        path
    }

    /// Claim: after a restart (the file is closed and opened again), a rescan of the same logs adds no row and
    /// keeps the advanced state, calldata and cursor.
    /// Why it matters: this is the idempotent restart. A reset to `seen` would repeat finished work.
    #[test]
    fn restart_keeps_state_and_rescan_adds_nothing() {
        let path = scratch_file("restart");
        let nonce = B256::repeat_byte(0x11);
        {
            let mut store = Store::open(&path).unwrap();
            assert_eq!(
                store
                    .record_scan("a_to_b", &[sample_deposit(0x11, 10)], 12)
                    .unwrap(),
                1
            );
            store.apply(nonce, Event::LightClientCovers, None).unwrap();
            store.apply(nonce, Event::WithdrawalBuilt, None).unwrap();
            store.set_calldata(nonce, &[1, 2, 3]).unwrap();
        }
        let mut store = Store::open(&path).unwrap();
        assert_eq!(store.cursor("a_to_b").unwrap(), Some(12));
        assert_eq!(
            store
                .record_scan("a_to_b", &[sample_deposit(0x11, 10)], 12)
                .unwrap(),
            0,
            "no new row"
        );
        let record = store.get(nonce).unwrap().unwrap();
        assert_eq!(record.state, DepositState::Proven);
        assert_eq!(record.calldata, Some(vec![1, 2, 3]));
        assert_eq!(store.list(None).unwrap().len(), 1);
    }

    /// Claim: the cursor never moves backwards.
    /// Why it matters: a stale scan result must not make the scanner read old blocks again forever.
    #[test]
    fn cursor_only_moves_forward() {
        let mut store = Store::open_in_memory().unwrap();
        store.record_scan("a_to_b", &[], 50).unwrap();
        store.record_scan("a_to_b", &[], 40).unwrap();
        assert_eq!(store.cursor("a_to_b").unwrap(), Some(50));
        assert_eq!(store.cursor("b_to_a").unwrap(), None);
    }

    /// Claim: the store refuses an event that the state table forbids, and leaves the row alone.
    #[test]
    fn forbidden_event_changes_nothing() {
        let mut store = Store::open_in_memory().unwrap();
        store
            .record_scan("a_to_b", &[sample_deposit(0x22, 3)], 3)
            .unwrap();
        let nonce = B256::repeat_byte(0x22);
        assert!(store.apply(nonce, Event::WithdrawalSent, None).is_err());
        assert_eq!(store.get(nonce).unwrap().unwrap().state, DepositState::Seen);
        store
            .apply(
                nonce,
                Event::AlreadyClaimed,
                Some("claimed by someone else"),
            )
            .unwrap();
        assert!(store.active("a_to_b").unwrap().is_empty());
        assert_eq!(
            store.get(nonce).unwrap().unwrap().note.as_deref(),
            Some("claimed by someone else")
        );
    }
}
