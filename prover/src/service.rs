//! The loop that moves a deposit from its first sight to its withdrawal.
//!
//! A [`Route`] holds one direction. The [`RoutePorts`] trait is everything the loop needs from the outside: the
//! source chain, the beacon source, the prover and the destination chain. `route.rs` implements it for real
//! chains. The unit tests implement it with a script.
//!
//! One pass (`once`) does, for each route: scan finalized source blocks for new deposits, then advance every
//! deposit that is not confirmed or failed as far as it goes. A restart repeats nothing that the file records.

use crate::error::{Error, Result};
use crate::logging::Logger;
use crate::state::{DepositState, Event};
use crate::store::{DepositRecord, NewDeposit, Store};
use alloy_primitives::B256;

/// The most steps one deposit takes in one pass. It stops a loop that cannot make progress.
const MAX_STEPS_PER_PASS: usize = 16;

/// What the light client says about a deposit block.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Coverage {
    /// The destination light client holds a final header after the deposit block.
    Covered,
    /// The source has no such header yet.
    NotYetFinal,
}

/// The result of sending a withdrawal.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum SendOutcome {
    /// The transaction was sent. Its hash follows.
    Sent(B256),
    /// The vault reverted with `AlreadyClaimed`. That is success.
    AlreadyClaimed,
}

/// Everything one route needs from the outside world.
pub trait RoutePorts {
    /// The highest source block that is final, or `None`.
    fn finalized_source_block(&self) -> Result<Option<u64>>;
    /// The deposits in the source blocks `from..=to`. Every block is final.
    fn scan(&self, from: u64, to: u64) -> Result<Vec<NewDeposit>>;
    /// The deposit at log `log_index` of the receipt of `transaction`, or `None` when this route's source chain has
    /// no such deposit. Fails when the block is not final.
    fn deposit_from_receipt(&self, transaction: B256, log_index: u64) -> Result<Option<NewDeposit>>;
    /// Whether the destination vault already paid the nonce.
    fn claimed(&self, nonce: B256) -> Result<bool>;
    /// Advances the destination light client until it covers the deposit block, or says it cannot yet.
    fn advance_light_client(&self, deposit: &NewDeposit) -> Result<Coverage>;
    /// Builds the withdrawal calldata and runs native verification. It never returns calldata that native
    /// verification refused. It also makes sure the vault layout rows cover the withdrawal.
    fn build_withdrawal(&self, deposit: &NewDeposit) -> Result<Vec<u8>>;
    /// Sends the withdrawal.
    fn send_withdrawal(&self, calldata: &[u8]) -> Result<SendOutcome>;
    /// The status of a sent transaction: `None` while pending, else whether it succeeded.
    fn transaction_succeeded(&self, transaction: B256) -> Result<Option<bool>>;
}

/// One direction of the bridge.
pub struct Route {
    /// The route name, for example `a_to_b`.
    pub name: String,
    /// The first block to scan when the file has no cursor.
    pub start_block: u64,
    /// The largest block range of one scan call.
    pub log_block_range: u64,
    /// The outside world.
    pub ports: Box<dyn RoutePorts>,
}

/// Settings of the loop.
#[derive(Clone, Copy, Debug)]
pub struct ServiceSettings {
    /// Failed attempts before a deposit is marked failed.
    pub max_attempts: u32,
}

/// The loop.
pub struct Service {
    store: Store,
    logger: Logger,
    settings: ServiceSettings,
    routes: Vec<Route>,
}

/// A failure that a later pass may fix: the node is down or slow. It does not count as an attempt.
pub fn is_transient(error: &Error) -> bool {
    match error {
        Error::Http(_) | Error::Database(_) => true,
        Error::Rpc { data, .. } => data.is_none(),
        _ => false,
    }
}

impl Service {
    /// A service over a store and routes.
    pub fn new(store: Store, logger: Logger, settings: ServiceSettings, routes: Vec<Route>) -> Self {
        Self { store, logger, settings, routes }
    }

    /// The store, for `status`.
    pub fn store(&self) -> &Store {
        &self.store
    }

    /// One pass over every route.
    ///
    /// # Errors
    /// Only a failure of the store. A failure of one route or one deposit is logged and the pass goes on.
    pub fn run_once(&mut self) -> Result<()> {
        self.logger.info("pass_started", None, &[]);
        for index in 0..self.routes.len() {
            let name = self.routes[index].name.clone();
            if let Err(error) = self.scan_route(index) {
                self.logger.warn("scan_failed", None, &[("route", name.clone()), ("error", error.to_string())]);
            }
            for record in self.store.active(&name)? {
                self.advance(index, &record.deposit.nonce)?;
            }
        }
        self.logger.info("pass_finished", None, &[]);
        Ok(())
    }

    fn scan_route(&mut self, index: usize) -> Result<()> {
        let route = &self.routes[index];
        let Some(finalized) = route.ports.finalized_source_block()? else {
            self.logger.info("no_finalized_block", None, &[("route", route.name.clone())]);
            return Ok(());
        };
        let mut from = match self.store.cursor(&route.name)? {
            Some(cursor) => cursor + 1,
            None => route.start_block,
        };
        while from <= finalized {
            let to = finalized.min(from.saturating_add(route.log_block_range - 1));
            let deposits = route.ports.scan(from, to)?;
            let mut fresh = Vec::new();
            for deposit in &deposits {
                if self.store.get(deposit.nonce)?.is_none() {
                    fresh.push(deposit.clone());
                }
            }
            self.store.record_scan(&route.name, &deposits, to)?;
            for deposit in fresh {
                self.log_new(&deposit);
            }
            from = to + 1;
        }
        Ok(())
    }

    fn log_new(&self, deposit: &NewDeposit) {
        self.logger.info(
            "deposit_state",
            Some(deposit.nonce),
            &[
                ("route", deposit.route.clone()),
                ("from", "none".into()),
                ("to", DepositState::Seen.as_str().into()),
                ("block", deposit.block_number.to_string()),
                ("amount", deposit.amount.to_string()),
            ],
        );
    }

    fn apply(&self, record: &DepositRecord, event: Event, note: Option<&str>) -> Result<DepositState> {
        let nonce = record.deposit.nonce;
        let (from, to) = self.store.apply(nonce, event, note)?;
        let mut fields = vec![
            ("route", record.deposit.route.clone()),
            ("from", from.as_str().to_string()),
            ("to", to.as_str().to_string()),
        ];
        if let Some(note) = note {
            fields.push(("reason", note.to_string()));
        }
        self.logger.info("deposit_state", Some(nonce), &fields);
        Ok(to)
    }

    fn count_attempt(&self, record: &DepositRecord, note: &str) -> Result<()> {
        let nonce = record.deposit.nonce;
        let attempts = self.store.record_attempt(nonce, note)?;
        self.logger.warn(
            "attempt_failed",
            Some(nonce),
            &[("attempts", attempts.to_string()), ("reason", note.to_string())],
        );
        if attempts >= self.settings.max_attempts {
            self.apply(record, Event::Rejected, Some(&format!("gave up after {attempts} attempts: {note}")))?;
        }
        Ok(())
    }

    fn log_transient(&self, nonce: B256, error: &Error) {
        self.logger.warn("step_failed_will_retry", Some(nonce), &[("error", error.to_string())]);
    }

    /// Moves one deposit as far as it goes in this pass.
    fn advance(&self, index: usize, nonce: &B256) -> Result<()> {
        let ports = &self.routes[index].ports;
        for _ in 0..MAX_STEPS_PER_PASS {
            let Some(record) = self.store.get(*nonce)? else { return Ok(()) };
            if record.state.is_terminal() {
                return Ok(());
            }
            match self.step(ports.as_ref(), &record) {
                Ok(Progress::Moved) => continue,
                Ok(Progress::Blocked) => return Ok(()),
                Err(error) if is_transient(&error) => {
                    self.log_transient(*nonce, &error);
                    return Ok(());
                }
                Err(error) => {
                    self.count_attempt(&record, &error.to_string())?;
                    return Ok(());
                }
            }
        }
        Ok(())
    }

    fn step(&self, ports: &dyn RoutePorts, record: &DepositRecord) -> Result<Progress> {
        let deposit = &record.deposit;
        if record.state != DepositState::Submitted && ports.claimed(deposit.nonce)? {
            self.apply(record, Event::AlreadyClaimed, Some("the vault reports the nonce as claimed"))?;
            return Ok(Progress::Moved);
        }
        match record.state {
            DepositState::Seen | DepositState::AwaitingFinality => self.step_cover(ports, record),
            DepositState::LightClientUpdated => {
                let calldata = ports.build_withdrawal(deposit)?;
                self.store.set_calldata(deposit.nonce, &calldata)?;
                self.apply(record, Event::WithdrawalBuilt, None)?;
                Ok(Progress::Moved)
            }
            DepositState::Proven => self.step_send(ports, record),
            DepositState::Submitted => self.step_confirm(ports, record),
            DepositState::Confirmed | DepositState::Failed => Ok(Progress::Blocked),
        }
    }

    fn step_cover(&self, ports: &dyn RoutePorts, record: &DepositRecord) -> Result<Progress> {
        match ports.advance_light_client(&record.deposit)? {
            Coverage::Covered => {
                self.apply(record, Event::LightClientCovers, None)?;
                Ok(Progress::Moved)
            }
            Coverage::NotYetFinal => {
                if record.state == DepositState::Seen {
                    self.apply(record, Event::BeaconNotReady, Some("no final header covers the deposit block yet"))?;
                }
                Ok(Progress::Blocked)
            }
        }
    }

    fn step_send(&self, ports: &dyn RoutePorts, record: &DepositRecord) -> Result<Progress> {
        let calldata = record
            .calldata
            .as_ref()
            .ok_or_else(|| Error::Transaction("the deposit is proven but has no stored calldata".into()))?;
        match ports.send_withdrawal(calldata)? {
            SendOutcome::AlreadyClaimed => {
                self.apply(record, Event::AlreadyClaimed, Some("the vault reverted with AlreadyClaimed"))?;
            }
            SendOutcome::Sent(hash) => {
                self.store.set_withdrawal_transaction(record.deposit.nonce, hash)?;
                self.apply(record, Event::WithdrawalSent, Some(&format!("transaction {hash:#x}")))?;
            }
        }
        Ok(Progress::Moved)
    }

    fn step_confirm(&self, ports: &dyn RoutePorts, record: &DepositRecord) -> Result<Progress> {
        let hash = record
            .withdrawal_transaction
            .ok_or_else(|| Error::Transaction("the deposit is submitted but has no stored transaction".into()))?;
        match ports.transaction_succeeded(hash)? {
            None => Ok(Progress::Blocked),
            Some(true) => {
                self.apply(record, Event::WithdrawalMined, Some(&format!("transaction {hash:#x}")))?;
                Ok(Progress::Moved)
            }
            Some(false) if ports.claimed(record.deposit.nonce)? => {
                self.apply(record, Event::AlreadyClaimed, Some("another transaction paid the deposit first"))?;
                Ok(Progress::Moved)
            }
            Some(false) => {
                self.apply(record, Event::WithdrawalReverted, Some(&format!("transaction {hash:#x} reverted")))?;
                self.count_attempt(record, "the withdrawal transaction reverted")?;
                Ok(Progress::Blocked)
            }
        }
    }

    /// The manual path: reads one deposit from a receipt, stores it, and advances it. Used by `withdraw`.
    ///
    /// # Errors
    /// `Error::Usage` when no route has such a deposit.
    pub fn withdraw_one(&mut self, transaction: B256, log_index: u64) -> Result<B256> {
        for index in 0..self.routes.len() {
            let Some(deposit) = self.routes[index].ports.deposit_from_receipt(transaction, log_index)? else {
                continue;
            };
            if self.store.insert_deposit(&deposit)? {
                self.log_new(&deposit);
            }
            self.advance(index, &deposit.nonce)?;
            return Ok(deposit.nonce);
        }
        Err(Error::Usage(format!("no route has a deposit at log {log_index} of transaction {transaction:#x}")))
    }
}

enum Progress {
    Moved,
    Blocked,
}

#[cfg(test)]
pub(crate) mod tests {
    use super::*;
    use crate::store::sample_deposit;
    use std::cell::{Cell, RefCell};

    /// A scripted route. Each field says what the port answers and counts what the service asks.
    pub struct Script {
        pub finalized: Cell<Option<u64>>,
        pub deposits: RefCell<Vec<NewDeposit>>,
        pub claimed: Cell<bool>,
        pub coverage: Cell<Coverage>,
        pub build: RefCell<Box<dyn Fn() -> Result<Vec<u8>>>>,
        pub send: RefCell<Box<dyn Fn() -> Result<SendOutcome>>>,
        pub status: Cell<Option<bool>>,
        pub builds: Cell<u32>,
        pub sends: Cell<u32>,
        pub scans: Cell<u32>,
    }

    impl Script {
        pub fn new() -> std::rc::Rc<Self> {
            std::rc::Rc::new(Self {
                finalized: Cell::new(Some(100)),
                deposits: RefCell::new(vec![sample_deposit(0x11, 10)]),
                claimed: Cell::new(false),
                coverage: Cell::new(Coverage::Covered),
                build: RefCell::new(Box::new(|| Ok(vec![1, 2, 3]))),
                send: RefCell::new(Box::new(|| Ok(SendOutcome::Sent(B256::repeat_byte(0xee))))),
                status: Cell::new(Some(true)),
                builds: Cell::new(0),
                sends: Cell::new(0),
                scans: Cell::new(0),
            })
        }
    }

    pub struct ScriptPorts(pub std::rc::Rc<Script>);

    // The service is single threaded; the trait object needs no `Send`.
    impl RoutePorts for ScriptPorts {
        fn finalized_source_block(&self) -> Result<Option<u64>> {
            Ok(self.0.finalized.get())
        }
        fn scan(&self, from: u64, to: u64) -> Result<Vec<NewDeposit>> {
            self.0.scans.set(self.0.scans.get() + 1);
            Ok(self.0.deposits.borrow().iter().filter(|d| d.block_number >= from && d.block_number <= to).cloned().collect())
        }
        fn deposit_from_receipt(&self, _transaction: B256, _log_index: u64) -> Result<Option<NewDeposit>> {
            Ok(self.0.deposits.borrow().first().cloned())
        }
        fn claimed(&self, _nonce: B256) -> Result<bool> {
            Ok(self.0.claimed.get())
        }
        fn advance_light_client(&self, _deposit: &NewDeposit) -> Result<Coverage> {
            Ok(self.0.coverage.get())
        }
        fn build_withdrawal(&self, _deposit: &NewDeposit) -> Result<Vec<u8>> {
            self.0.builds.set(self.0.builds.get() + 1);
            (self.0.build.borrow())()
        }
        fn send_withdrawal(&self, _calldata: &[u8]) -> Result<SendOutcome> {
            self.0.sends.set(self.0.sends.get() + 1);
            (self.0.send.borrow())()
        }
        fn transaction_succeeded(&self, _transaction: B256) -> Result<Option<bool>> {
            Ok(self.0.status.get())
        }
    }

    pub fn service_with(script: &std::rc::Rc<Script>, store: Store) -> (Service, std::sync::Arc<std::sync::Mutex<Vec<String>>>) {
        let (logger, lines) = Logger::in_memory();
        let route = Route {
            name: "a_to_b".into(),
            start_block: 0,
            log_block_range: 50,
            ports: Box::new(ScriptPorts(script.clone())),
        };
        (Service::new(store, logger, ServiceSettings { max_attempts: 3 }, vec![route]), lines)
    }

    fn state_of(service: &Service, seed: u8) -> DepositState {
        service.store().get(B256::repeat_byte(seed)).unwrap().unwrap().state
    }

    /// Claim: with everything working, one pass takes a deposit from its first sight to `confirmed`, and every log
    /// line about it carries its nonce.
    /// Why it matters: this is the path every deposit takes. The nonce in each line lets an operator follow it.
    #[test]
    fn one_pass_completes_a_deposit_and_logs_its_nonce() {
        let script = Script::new();
        let (mut service, lines) = service_with(&script, Store::open_in_memory().unwrap());
        service.run_once().unwrap();
        assert_eq!(state_of(&service, 0x11), DepositState::Confirmed);
        let nonce = format!("nonce={:#x}", B256::repeat_byte(0x11));
        let deposit_lines: Vec<String> =
            lines.lock().unwrap().iter().filter(|line| line.contains("event=deposit_state")).cloned().collect();
        assert_eq!(deposit_lines.len(), 5, "seen, covered, proven, submitted, confirmed: {deposit_lines:?}");
        assert!(deposit_lines.iter().all(|line| line.contains(&nonce)));
        assert!(lines.lock().unwrap().iter().all(|line| line.contains("nonce=")), "every line has the key");
    }

    /// Claim: the scan reads only up to the finalized block. A deposit above it is not read, not stored.
    /// Why it matters: an unfinalized deposit can vanish in a reorganization. Withdrawing it would be a loss.
    #[test]
    fn only_finalized_blocks_are_scanned() {
        let script = Script::new();
        script.finalized.set(Some(9));
        let (mut service, _) = service_with(&script, Store::open_in_memory().unwrap());
        service.run_once().unwrap();
        assert!(service.store().list(None).unwrap().is_empty());
        assert_eq!(service.store().cursor("a_to_b").unwrap(), Some(9));
        script.finalized.set(Some(10));
        service.run_once().unwrap();
        assert_eq!(service.store().list(None).unwrap().len(), 1);
    }

    /// Claim: after a restart in the middle of a deposit, the service resumes: it does not build or send again what
    /// the file records, and it rescans nothing below the stored cursor.
    /// Why it matters: a second withdrawal transaction wastes gas, and a second build repeats the work.
    #[test]
    fn restart_resumes_without_repeating_work() {
        let path = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join(format!("target/test-scratch/service-restart-{}.sqlite", std::process::id()));
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        let _ = std::fs::remove_file(&path);
        let script = Script::new();
        script.status.set(None); // the transaction stays pending: the first run ends in `submitted`
        {
            let (mut service, _) = service_with(&script, Store::open(&path).unwrap());
            service.run_once().unwrap();
            assert_eq!(state_of(&service, 0x11), DepositState::Submitted);
        }
        assert_eq!((script.builds.get(), script.sends.get(), script.scans.get()), (1, 1, 3), "blocks 0..=100 in chunks of 50");
        script.status.set(Some(true));
        let (mut service, _) = service_with(&script, Store::open(&path).unwrap());
        service.run_once().unwrap();
        assert_eq!(state_of(&service, 0x11), DepositState::Confirmed);
        assert_eq!((script.builds.get(), script.sends.get()), (1, 1), "nothing repeated");
        assert_eq!(script.scans.get(), 3, "the cursor kept the scanner above block 100");
    }

    /// Claim: when the vault reverts with AlreadyClaimed, the deposit ends `confirmed`, not `failed`, with no retry.
    /// Why it matters: another relayer may pay first. The deposit is delivered either way.
    #[test]
    fn already_claimed_revert_is_success() {
        let script = Script::new();
        *script.send.borrow_mut() = Box::new(|| Ok(SendOutcome::AlreadyClaimed));
        let (mut service, _) = service_with(&script, Store::open_in_memory().unwrap());
        service.run_once().unwrap();
        assert_eq!(state_of(&service, 0x11), DepositState::Confirmed);
        assert_eq!(script.sends.get(), 1);
    }

    /// Claim: a nonce that the vault already marks as claimed is confirmed before any work is done.
    #[test]
    fn claimed_nonce_skips_all_work() {
        let script = Script::new();
        script.claimed.set(true);
        let (mut service, _) = service_with(&script, Store::open_in_memory().unwrap());
        service.run_once().unwrap();
        assert_eq!(state_of(&service, 0x11), DepositState::Confirmed);
        assert_eq!((script.builds.get(), script.sends.get()), (0, 0));
    }

    /// Claim: when native verification refuses, the service sends nothing, keeps the deposit in
    /// `light_client_updated`, and marks it `failed` only after `max_attempts` refusals.
    /// Why it matters: the service must never send a withdrawal that its own reference check rejects.
    #[test]
    fn refused_verification_sends_nothing_and_fails_after_the_limit() {
        let script = Script::new();
        *script.build.borrow_mut() = Box::new(|| Err(Error::VerificationRefused("InvalidAncestryBranch".into())));
        let (mut service, _) = service_with(&script, Store::open_in_memory().unwrap());
        service.run_once().unwrap();
        assert_eq!(state_of(&service, 0x11), DepositState::LightClientUpdated);
        service.run_once().unwrap();
        assert_eq!(state_of(&service, 0x11), DepositState::LightClientUpdated);
        service.run_once().unwrap();
        assert_eq!(state_of(&service, 0x11), DepositState::Failed);
        assert_eq!(script.sends.get(), 0, "nothing was ever sent");
        let record = service.store().get(B256::repeat_byte(0x11)).unwrap().unwrap();
        assert!(record.note.unwrap().contains("InvalidAncestryBranch"));
    }

    /// Claim: a node outage (a transient error) does not count as an attempt and does not fail the deposit.
    #[test]
    fn transient_errors_do_not_count() {
        let script = Script::new();
        *script.send.borrow_mut() = Box::new(|| Err(Error::Http("connection refused".into())));
        let (mut service, _) = service_with(&script, Store::open_in_memory().unwrap());
        for _ in 0..5 {
            service.run_once().unwrap();
        }
        let record = service.store().get(B256::repeat_byte(0x11)).unwrap().unwrap();
        assert_eq!((record.state, record.attempts), (DepositState::Proven, 0));
    }

    /// Claim: while no final header covers the block, the deposit waits in `awaiting_finality` and nothing is built.
    #[test]
    fn deposit_waits_for_finality() {
        let script = Script::new();
        script.coverage.set(Coverage::NotYetFinal);
        let (mut service, _) = service_with(&script, Store::open_in_memory().unwrap());
        service.run_once().unwrap();
        assert_eq!(state_of(&service, 0x11), DepositState::AwaitingFinality);
        assert_eq!(script.builds.get(), 0);
        script.coverage.set(Coverage::Covered);
        service.run_once().unwrap();
        assert_eq!(state_of(&service, 0x11), DepositState::Confirmed);
    }
}
