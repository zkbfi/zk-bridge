//! The loop that moves a deposit from its first sight to its withdrawal.
//!
//! A [`Route`] holds one direction. The [`RoutePorts`] trait is everything the loop needs from the outside: the
//! source chain, the beacon source, the prover and the destination chain. `route.rs` implements it for real
//! chains. The unit tests implement it with a script.
//!
//! One pass (`once`) does, for each route: scan finalized source blocks for new deposits, then work on all deposits
//! that are not confirmed or failed in four stages, then move the own-chain light client of the source chain to the
//! newest final header (when the chain has one). A restart repeats nothing that the file records.
//!
//! The four stages make a burst of deposits cheap. One light-client update covers every deposit at or below its head,
//! so stage one asks for the update for the oldest deposit, then for the newest, and the update of one covers the rest. Stage two builds the withdrawals. Stage three sends
//! them back to back, without a wait for any receipt. Stage four waits for the receipts. A failure of one deposit
//! costs that deposit an attempt and stops no other deposit.

use crate::error::{Error, Result};
use crate::logging::Logger;
use crate::opening::OpeningOutcome;
use crate::state::{DepositState, Event};
use crate::store::{DepositRecord, NewDeposit, Store};
use alloy_primitives::B256;
use std::cell::Cell;

/// The most steps one deposit takes in one pass. It stops a loop that cannot make progress.
const MAX_STEPS_PER_PASS: usize = 16;

/// How far one call of [`Service::advance`] takes a deposit.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum Reach {
    /// The destination light client covers the deposit block.
    LightClientUpdated,
    /// The withdrawal is built and verified natively.
    Proven,
    /// The withdrawal transaction is sent.
    Submitted,
    /// The deposit ends in a terminal state.
    Confirmed,
}

impl Reach {
    /// Whether a deposit in `state` is at least this far.
    fn is_met_by(self, state: DepositState) -> bool {
        let rank = |state: DepositState| match state {
            DepositState::Seen | DepositState::AwaitingFinality => 0,
            DepositState::LightClientUpdated => 1,
            DepositState::Proven => 2,
            DepositState::Submitted => 3,
            DepositState::Confirmed | DepositState::Failed => 4,
        };
        let goal = match self {
            Self::LightClientUpdated => 1,
            Self::Proven => 2,
            Self::Submitted => 3,
            Self::Confirmed => 4,
        };
        rank(state) >= goal
    }
}

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
    fn deposit_from_receipt(&self, transaction: B256, log_index: u64)
        -> Result<Option<NewDeposit>>;
    /// Whether the destination vault already paid the nonce.
    fn claimed(&self, nonce: B256) -> Result<bool>;
    /// Advances the destination light client until it covers the deposit block, or says it cannot yet.
    fn advance_light_client(&self, deposit: &NewDeposit) -> Result<Coverage>;
    /// Sends the next update that moves the own-chain light client of the source chain toward the newest final header
    /// of that chain, and returns how many updates it sent (zero or one per call). It uses the beacon updates that the
    /// route fetches for the other direction. A route whose source chain has no own-chain light client sends none.
    fn advance_own_light_client(&self) -> Result<usize> {
        Ok(0)
    }
    /// Sends the next update that moves the destination light client of this route toward the newest final header of
    /// the source chain, with no deposit in view, and returns how many updates it sent (zero or one per call). Zero means
    /// the head already is the newest final header, or the source has none yet.
    fn follow_light_client(&self) -> Result<usize> {
        Ok(0)
    }
    /// Tries to open the deposits of the source vault of this route (see `opening.rs`). It sends a transaction only when a
    /// proof exists. A vault that cannot be opened yet is an outcome, not an error.
    fn open_source_vault(&self) -> Result<OpeningOutcome>;
    /// Builds the withdrawal calldata and runs native verification. It never returns calldata that native
    /// verification refused. It also makes sure the vault layout rows cover the withdrawal.
    fn build_withdrawal(&self, deposit: &NewDeposit) -> Result<Vec<u8>>;
    /// The note for a deposit that the flow limiter of the destination vault would refuse now, or `None` when there is
    /// no limiter or it allows the withdrawal. A refusal is a wait, not a failed attempt: the deposit stays claimable.
    fn flow_limiter_refusal(&self, _deposit: &NewDeposit) -> Result<Option<String>> {
        Ok(None)
    }
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

/// The opening of the source vault of one route, as [`Service::follow`] found it.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct RouteOpening {
    /// The route name.
    pub route: String,
    /// What the attempt to open the source vault of the route did.
    pub outcome: OpeningOutcome,
}

impl RouteOpening {
    /// The line that the command line prints for the route.
    pub fn summary(&self) -> String {
        match &self.outcome {
            OpeningOutcome::AlreadyOpen => format!("route {}: deposits open", self.route),
            OpeningOutcome::Opened { transaction } => format!(
                "route {}: deposits opened (transaction {transaction:#x})",
                self.route
            ),
            OpeningOutcome::NotReady { reason } => {
                format!("route {}: deposits locked: {reason}", self.route)
            }
        }
    }
}

/// What [`Service::follow`] did.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct FollowReport {
    /// How many light client updates it sent in all.
    pub updates_sent: usize,
    /// The source vault of each route, in route order.
    pub openings: Vec<RouteOpening>,
}

impl FollowReport {
    /// The routes whose source vault still refuses deposits.
    pub fn locked_routes(&self) -> Vec<&str> {
        self.openings
            .iter()
            .filter(|opening| matches!(opening.outcome, OpeningOutcome::NotReady { .. }))
            .map(|opening| opening.route.as_str())
            .collect()
    }
}

/// Settings of the loop.
#[derive(Clone, Copy, Debug)]
pub struct ServiceSettings {
    /// Failed attempts before a deposit is marked failed.
    pub max_attempts: u32,
    /// The most withdrawals that one route builds, and the most that it sends, in one pass.
    pub max_withdrawals_per_pass: usize,
}

/// What [`Service::retry`] did with a failed deposit.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum RetryOutcome {
    /// The deposit is back in `seen` with no attempts. The next pass works on it.
    Restarted,
    /// The vault already paid the nonce, so the deposit is now `confirmed`.
    AlreadyPaid,
}

/// The loop.
pub struct Service {
    store: Store,
    logger: Logger,
    settings: ServiceSettings,
    routes: Vec<Route>,
    /// The highest deposit block that a light-client update covered in this pass of the current route.
    covered_through: Cell<Option<u64>>,
}

/// A failure that a later pass may fix: the node is down or slow. It does not count as an attempt.
pub fn is_transient(error: &Error) -> bool {
    match error {
        Error::Http(_) | Error::Database(_) | Error::ProofBudget(_) => true,
        Error::Rpc { data, .. } => data.is_none(),
        _ => false,
    }
}

impl Service {
    /// A service over a store and routes.
    pub fn new(
        store: Store,
        logger: Logger,
        settings: ServiceSettings,
        routes: Vec<Route>,
    ) -> Self {
        Self {
            store,
            logger,
            settings,
            routes,
            covered_through: Cell::new(None),
        }
    }

    /// The store, for `status`.
    pub fn store(&self) -> &Store {
        &self.store
    }

    /// Moves the destination light client of every route toward the newest final header of its source chain, with no
    /// deposit in view, for up to `rounds` updates per route. A route stops early when its head already is the newest
    /// final header. When every route was followed, it tries to open the source vault of each route (see `opening.rs`),
    /// and logs one line for each route.
    ///
    /// Why it exists: a vault pays a deposit only after the light client on the other chain stored a header at or below
    /// the slot of the deposit, and the vault cannot read that light client. So the vault refuses every deposit (it is
    /// locked) until `openDeposits` proves, through its own light client, that the other light client stored a head. The
    /// proof needs a block of the other chain that finalized AFTER the first update of that light client. An operator runs
    /// this on both routes after the deployment, again and again until every route is open, and only then starts deposits.
    ///
    /// A vault that stays locked is no failure of this call: the report lists it. The command line turns it into an exit code.
    ///
    /// # Errors
    /// The first failure of an update: it stops the call. A failure to open a vault is logged and reported as locked.
    pub fn follow(&self, rounds: usize) -> Result<FollowReport> {
        let mut updates_sent = 0;
        for route in &self.routes {
            for _ in 0..rounds {
                let updates = route.ports.follow_light_client()?;
                self.logger.info(
                    "light_client_followed",
                    None,
                    &[
                        ("route", route.name.clone()),
                        ("updates", updates.to_string()),
                    ],
                );
                updates_sent += updates;
                if updates == 0 {
                    break;
                }
            }
        }
        let openings = self
            .routes
            .iter()
            .map(|route| RouteOpening {
                route: route.name.clone(),
                outcome: self.try_to_open(route),
            })
            .collect();
        Ok(FollowReport {
            updates_sent,
            openings,
        })
    }

    /// Tries to open the source vault of a route and logs the outcome. A failure is a locked vault with the error as its
    /// reason, so the other routes still get their turn.
    fn try_to_open(&self, route: &Route) -> OpeningOutcome {
        let outcome =
            route
                .ports
                .open_source_vault()
                .unwrap_or_else(|error| OpeningOutcome::NotReady {
                    reason: format!("the opening failed: {error}"),
                });
        let route_field = ("route", route.name.clone());
        match &outcome {
            OpeningOutcome::AlreadyOpen => self.logger.info("deposits_open", None, &[route_field]),
            OpeningOutcome::Opened { transaction } => self.logger.info(
                "deposits_opened",
                None,
                &[route_field, ("transaction", format!("{transaction:#x}"))],
            ),
            OpeningOutcome::NotReady { reason } => self.logger.warn(
                "deposits_locked",
                None,
                &[route_field, ("reason", reason.clone())],
            ),
        }
        outcome
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
                self.logger.warn(
                    "scan_failed",
                    None,
                    &[("route", name.clone()), ("error", error.to_string())],
                );
            }
            self.work_on_deposits(index, &name)?;
            self.keep_own_light_client_current(index);
        }
        self.logger.info("pass_finished", None, &[]);
        Ok(())
    }

    /// Works on every live deposit of a route in four stages (see the module documentation).
    fn work_on_deposits(&self, index: usize, route: &str) -> Result<()> {
        self.covered_through.set(None);
        // The oldest deposit first, so the light client stores a header close to the oldest deposit (the vault layout
        // rows need a stored header at or below the slot of a deposit). Then the newest: when its block is covered,
        // the update covers every deposit between them, and the others need no call.
        let records = self.store.active(route)?;
        let (oldest, newer) = records.split_at(records.len().min(1));
        for record in oldest.iter().chain(newer.iter().rev()) {
            self.advance(index, &record.deposit.nonce, Reach::LightClientUpdated)?;
        }
        let limit = self.settings.max_withdrawals_per_pass;
        self.advance_batch(index, route, Batch::build(limit))?;
        self.advance_batch(index, route, Batch::send(limit))?;
        self.advance_batch(index, route, Batch::confirm())
    }

    /// Advances each deposit of a route that waits in `batch.from`, oldest first, until `batch.limit` of them reach
    /// `batch.reach`. A deposit that stays behind (a failure, a wait) does not count toward the limit.
    fn advance_batch(&self, index: usize, route: &str, batch: Batch) -> Result<()> {
        let mut reached = 0;
        for record in self.store.active(route)? {
            if reached >= batch.limit {
                return Ok(());
            }
            if record.state != batch.from {
                continue;
            }
            let nonce = record.deposit.nonce;
            self.advance(index, &nonce, batch.reach)?;
            let after = self.store.get(nonce)?.map(|record| record.state);
            if after.is_some_and(|state| state != batch.from) {
                reached += 1;
            }
        }
        Ok(())
    }

    /// Updates the own-chain light client of the source chain. A failure is logged and never stops the pass: it
    /// has no bearing on the deposits, and the next pass tries again.
    fn keep_own_light_client_current(&self, index: usize) {
        let route = &self.routes[index];
        match route.ports.advance_own_light_client() {
            Ok(0) => {}
            Ok(sent) => self.logger.info(
                "own_light_client_updated",
                None,
                &[("route", route.name.clone()), ("updates", sent.to_string())],
            ),
            Err(error) => self.logger.warn(
                "own_light_client_update_failed",
                None,
                &[("route", route.name.clone()), ("error", error.to_string())],
            ),
        }
    }

    fn scan_route(&mut self, index: usize) -> Result<()> {
        let route = &self.routes[index];
        let Some(finalized) = route.ports.finalized_source_block()? else {
            self.logger
                .info("no_finalized_block", None, &[("route", route.name.clone())]);
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

    fn apply(
        &self,
        record: &DepositRecord,
        event: Event,
        note: Option<&str>,
    ) -> Result<DepositState> {
        let (from, to) = self.store.apply(record.deposit.nonce, event, note)?;
        self.log_change(record, (from, to), note);
        Ok(to)
    }

    fn log_change(
        &self,
        record: &DepositRecord,
        change: (DepositState, DepositState),
        note: Option<&str>,
    ) {
        let mut fields = vec![
            ("route", record.deposit.route.clone()),
            ("from", change.0.as_str().to_string()),
            ("to", change.1.as_str().to_string()),
        ];
        if let Some(note) = note {
            fields.push(("reason", note.to_string()));
        }
        self.logger
            .info("deposit_state", Some(record.deposit.nonce), &fields);
    }

    fn count_attempt(&self, record: &DepositRecord, note: &str) -> Result<()> {
        let nonce = record.deposit.nonce;
        let attempts = self.store.record_attempt(nonce, note)?;
        self.logger.warn(
            "attempt_failed",
            Some(nonce),
            &[
                ("attempts", attempts.to_string()),
                ("reason", note.to_string()),
            ],
        );
        if attempts >= self.settings.max_attempts {
            self.apply(
                record,
                Event::Rejected,
                Some(&format!("gave up after {attempts} attempts: {note}")),
            )?;
        }
        Ok(())
    }

    fn log_transient(&self, nonce: B256, error: &Error) {
        self.logger.warn(
            "step_failed_will_retry",
            Some(nonce),
            &[("error", error.to_string())],
        );
    }

    /// Moves one deposit toward `reach`, as far as it goes in this pass.
    fn advance(&self, index: usize, nonce: &B256, reach: Reach) -> Result<()> {
        let ports = &self.routes[index].ports;
        for _ in 0..MAX_STEPS_PER_PASS {
            let Some(record) = self.store.get(*nonce)? else {
                return Ok(());
            };
            if record.state.is_terminal() || reach.is_met_by(record.state) {
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
            self.apply(
                record,
                Event::AlreadyClaimed,
                Some("the vault reports the nonce as claimed"),
            )?;
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
        let block = record.deposit.block_number;
        if self
            .covered_through
            .get()
            .is_some_and(|through| block <= through)
        {
            self.apply(record, Event::LightClientCovers, None)?;
            return Ok(Progress::Moved);
        }
        match ports.advance_light_client(&record.deposit)? {
            Coverage::Covered => {
                self.covered_through
                    .set(self.covered_through.get().max(Some(block)));
                self.apply(record, Event::LightClientCovers, None)?;
                Ok(Progress::Moved)
            }
            Coverage::NotYetFinal => {
                if record.state == DepositState::Seen {
                    self.apply(
                        record,
                        Event::BeaconNotReady,
                        Some("no final header covers the deposit block yet"),
                    )?;
                }
                Ok(Progress::Blocked)
            }
        }
    }

    fn step_send(&self, ports: &dyn RoutePorts, record: &DepositRecord) -> Result<Progress> {
        let calldata = record.calldata.as_ref().ok_or_else(|| {
            Error::Transaction("the deposit is proven but has no stored calldata".into())
        })?;
        if let Some(note) = ports.flow_limiter_refusal(&record.deposit)? {
            self.store.set_note(record.deposit.nonce, &note)?;
            self.logger.info(
                "waiting_on_flow_limiter",
                Some(record.deposit.nonce),
                &[("reason", note)],
            );
            return Ok(Progress::Blocked);
        }
        match ports.send_withdrawal(calldata)? {
            SendOutcome::AlreadyClaimed => {
                self.apply(
                    record,
                    Event::AlreadyClaimed,
                    Some("the vault reverted with AlreadyClaimed"),
                )?;
            }
            SendOutcome::Sent(hash) => {
                self.store
                    .set_withdrawal_transaction(record.deposit.nonce, hash)?;
                self.apply(
                    record,
                    Event::WithdrawalSent,
                    Some(&format!("transaction {hash:#x}")),
                )?;
            }
        }
        Ok(Progress::Moved)
    }

    fn step_confirm(&self, ports: &dyn RoutePorts, record: &DepositRecord) -> Result<Progress> {
        let hash = record.withdrawal_transaction.ok_or_else(|| {
            Error::Transaction("the deposit is submitted but has no stored transaction".into())
        })?;
        match ports.transaction_succeeded(hash)? {
            None => Ok(Progress::Blocked),
            Some(true) => {
                self.apply(
                    record,
                    Event::WithdrawalMined,
                    Some(&format!("transaction {hash:#x}")),
                )?;
                Ok(Progress::Moved)
            }
            Some(false) if ports.claimed(record.deposit.nonce)? => {
                self.apply(
                    record,
                    Event::AlreadyClaimed,
                    Some("another transaction paid the deposit first"),
                )?;
                Ok(Progress::Moved)
            }
            Some(false) => {
                self.apply(
                    record,
                    Event::WithdrawalReverted,
                    Some(&format!("transaction {hash:#x} reverted")),
                )?;
                self.count_attempt(record, "the withdrawal transaction reverted")?;
                Ok(Progress::Blocked)
            }
        }
    }

    /// The manual path for a failed deposit: finds it by its source transaction and log index, and sends it back to
    /// `seen` with no attempts, no calldata and a note. When the vault already paid the nonce, the deposit becomes
    /// `confirmed` instead.
    ///
    /// # Errors
    /// `Error::Usage` when the store has no such deposit, or the deposit is not `failed`.
    pub fn retry(&self, transaction: B256, log_index: u64) -> Result<(B256, RetryOutcome)> {
        let record = self
            .store
            .find_by_source(transaction, log_index)?
            .ok_or_else(|| {
                Error::Usage(format!(
                    "the store has no deposit at log {log_index} of transaction {transaction:#x}"
                ))
            })?;
        let nonce = record.deposit.nonce;
        if record.state != DepositState::Failed {
            return Err(Error::Usage(format!(
                "deposit {nonce:#x} is {}, not failed: only a failed deposit can be retried",
                record.state.as_str()
            )));
        }
        let route = self
            .routes
            .iter()
            .find(|route| route.name == record.deposit.route)
            .ok_or_else(|| {
                Error::Usage(format!(
                    "deposit {nonce:#x} belongs to route {}, which this configuration does not run",
                    record.deposit.route
                ))
            })?;
        if route.ports.claimed(nonce)? {
            let note = "retry found the nonce claimed on the destination chain";
            let change = self
                .store
                .apply(nonce, Event::ClaimedAfterFailure, Some(note))?;
            self.log_change(&record, change, Some(note));
            return Ok((nonce, RetryOutcome::AlreadyPaid));
        }
        let note = format!(
            "retried by an operator; the failure was: {}",
            record.note.as_deref().unwrap_or("no note")
        );
        let change = self.store.retry_failed(nonce, &note)?;
        self.log_change(&record, change, Some(&note));
        Ok((nonce, RetryOutcome::Restarted))
    }

    /// The manual path: reads one deposit from a receipt, stores it, and advances it. Used by `withdraw`.
    ///
    /// # Errors
    /// `Error::Usage` when no route has such a deposit.
    pub fn withdraw_one(&mut self, transaction: B256, log_index: u64) -> Result<B256> {
        for index in 0..self.routes.len() {
            let Some(deposit) = self.routes[index]
                .ports
                .deposit_from_receipt(transaction, log_index)?
            else {
                continue;
            };
            if self.store.insert_deposit(&deposit)? {
                self.log_new(&deposit);
            }
            self.covered_through.set(None);
            self.advance(index, &deposit.nonce, Reach::Confirmed)?;
            return Ok(deposit.nonce);
        }
        Err(Error::Usage(format!(
            "no route has a deposit at log {log_index} of transaction {transaction:#x}"
        )))
    }
}

enum Progress {
    Moved,
    Blocked,
}

/// One stage of the work on a route: the deposits that wait in `from` are taken to `reach`.
struct Batch {
    from: DepositState,
    reach: Reach,
    /// The most deposits that leave `from` in one pass.
    limit: usize,
}

impl Batch {
    /// Builds the withdrawal of each covered deposit.
    fn build(limit: usize) -> Self {
        Self {
            from: DepositState::LightClientUpdated,
            reach: Reach::Proven,
            limit,
        }
    }

    /// Sends the withdrawal of each built deposit, without a wait for its receipt.
    fn send(limit: usize) -> Self {
        Self {
            from: DepositState::Proven,
            reach: Reach::Submitted,
            limit,
        }
    }

    /// Waits for the receipt of each sent withdrawal. Every sent withdrawal is checked, whatever the limit.
    fn confirm() -> Self {
        Self {
            from: DepositState::Submitted,
            reach: Reach::Confirmed,
            limit: usize::MAX,
        }
    }
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
        /// What `flow_limiter_refusal` answers: a note while the limiter refuses, else `None`.
        pub refusal: RefCell<Option<String>>,
        pub scans: Cell<u32>,
        /// What `advance_own_light_client` answers: the number of updates sent, or a failure.
        pub own_answer: RefCell<Box<dyn Fn() -> Result<usize>>>,
        pub own_calls: Cell<u32>,
        /// What `follow_light_client` answers: the number of updates sent, or a failure.
        pub follow_answer: RefCell<Box<dyn Fn() -> Result<usize>>>,
        pub follow_calls: Cell<u32>,
        /// What `open_source_vault` answers: the outcome of the opening, or a failure.
        pub open_answer: RefCell<Box<dyn Fn() -> Result<OpeningOutcome>>>,
        pub open_calls: Cell<u32>,
        /// The head of a modelled destination light client, or `None` to answer from `coverage`. With a head, a
        /// deposit above it costs one update that moves the head to the finalized block.
        pub head: Cell<Option<u64>>,
        /// How many updates the modelled light client received.
        pub updates: Cell<u32>,
        /// How many times the service asked the light client to advance.
        pub advance_calls: Cell<u32>,
        /// The order of `send` and `confirm` calls, to show that every send comes before the first receipt wait.
        pub order: RefCell<Vec<&'static str>>,
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
                refusal: RefCell::new(None),
                scans: Cell::new(0),
                own_answer: RefCell::new(Box::new(|| Ok(0))),
                own_calls: Cell::new(0),
                follow_answer: RefCell::new(Box::new(|| Ok(0))),
                follow_calls: Cell::new(0),
                open_answer: RefCell::new(Box::new(|| Ok(OpeningOutcome::AlreadyOpen))),
                open_calls: Cell::new(0),
                head: Cell::new(None),
                updates: Cell::new(0),
                advance_calls: Cell::new(0),
                order: RefCell::new(Vec::new()),
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
            Ok(self
                .0
                .deposits
                .borrow()
                .iter()
                .filter(|d| d.block_number >= from && d.block_number <= to)
                .cloned()
                .collect())
        }
        fn deposit_from_receipt(
            &self,
            _transaction: B256,
            _log_index: u64,
        ) -> Result<Option<NewDeposit>> {
            Ok(self.0.deposits.borrow().first().cloned())
        }
        fn claimed(&self, _nonce: B256) -> Result<bool> {
            Ok(self.0.claimed.get())
        }
        fn advance_light_client(&self, deposit: &NewDeposit) -> Result<Coverage> {
            self.0.advance_calls.set(self.0.advance_calls.get() + 1);
            let Some(head) = self.0.head.get() else {
                return Ok(self.0.coverage.get());
            };
            if deposit.block_number <= head {
                return Ok(Coverage::Covered);
            }
            self.0.updates.set(self.0.updates.get() + 1);
            self.0.head.set(self.0.finalized.get());
            Ok(Coverage::Covered)
        }
        fn advance_own_light_client(&self) -> Result<usize> {
            self.0.own_calls.set(self.0.own_calls.get() + 1);
            (self.0.own_answer.borrow())()
        }
        fn follow_light_client(&self) -> Result<usize> {
            self.0.follow_calls.set(self.0.follow_calls.get() + 1);
            (self.0.follow_answer.borrow())()
        }
        fn open_source_vault(&self) -> Result<OpeningOutcome> {
            self.0.open_calls.set(self.0.open_calls.get() + 1);
            (self.0.open_answer.borrow())()
        }
        fn build_withdrawal(&self, _deposit: &NewDeposit) -> Result<Vec<u8>> {
            self.0.builds.set(self.0.builds.get() + 1);
            (self.0.build.borrow())()
        }
        fn flow_limiter_refusal(&self, _deposit: &NewDeposit) -> Result<Option<String>> {
            Ok(self.0.refusal.borrow().clone())
        }
        fn send_withdrawal(&self, _calldata: &[u8]) -> Result<SendOutcome> {
            self.0.sends.set(self.0.sends.get() + 1);
            self.0.order.borrow_mut().push("send");
            (self.0.send.borrow())()
        }
        fn transaction_succeeded(&self, _transaction: B256) -> Result<Option<bool>> {
            self.0.order.borrow_mut().push("confirm");
            Ok(self.0.status.get())
        }
    }

    pub fn service_with(
        script: &std::rc::Rc<Script>,
        store: Store,
    ) -> (Service, std::sync::Arc<std::sync::Mutex<Vec<String>>>) {
        service_with_limit(script, store, 32)
    }

    pub fn service_with_limit(
        script: &std::rc::Rc<Script>,
        store: Store,
        max_withdrawals_per_pass: usize,
    ) -> (Service, std::sync::Arc<std::sync::Mutex<Vec<String>>>) {
        let (logger, lines) = Logger::in_memory();
        let route = Route {
            name: "a_to_b".into(),
            start_block: 0,
            log_block_range: 50,
            ports: Box::new(ScriptPorts(script.clone())),
        };
        (
            Service::new(
                store,
                logger,
                ServiceSettings {
                    max_attempts: 3,
                    max_withdrawals_per_pass,
                },
                vec![route],
            ),
            lines,
        )
    }

    fn state_of(service: &Service, seed: u8) -> DepositState {
        service
            .store()
            .get(B256::repeat_byte(seed))
            .unwrap()
            .unwrap()
            .state
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
        let deposit_lines: Vec<String> = lines
            .lock()
            .unwrap()
            .iter()
            .filter(|line| line.contains("event=deposit_state"))
            .cloned()
            .collect();
        assert_eq!(
            deposit_lines.len(),
            5,
            "seen, covered, proven, submitted, confirmed: {deposit_lines:?}"
        );
        assert!(deposit_lines.iter().all(|line| line.contains(&nonce)));
        assert!(
            lines
                .lock()
                .unwrap()
                .iter()
                .all(|line| line.contains("nonce=")),
            "every line has the key"
        );
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
        let path = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join(format!(
            "target/test-scratch/service-restart-{}.sqlite",
            std::process::id()
        ));
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        let _ = std::fs::remove_file(&path);
        let script = Script::new();
        script.status.set(None); // the transaction stays pending: the first run ends in `submitted`
        {
            let (mut service, _) = service_with(&script, Store::open(&path).unwrap());
            service.run_once().unwrap();
            assert_eq!(state_of(&service, 0x11), DepositState::Submitted);
        }
        assert_eq!(
            (script.builds.get(), script.sends.get(), script.scans.get()),
            (1, 1, 3),
            "blocks 0..=100 in chunks of 50"
        );
        script.status.set(Some(true));
        let (mut service, _) = service_with(&script, Store::open(&path).unwrap());
        service.run_once().unwrap();
        assert_eq!(state_of(&service, 0x11), DepositState::Confirmed);
        assert_eq!(
            (script.builds.get(), script.sends.get()),
            (1, 1),
            "nothing repeated"
        );
        assert_eq!(
            script.scans.get(),
            3,
            "the cursor kept the scanner above block 100"
        );
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
        *script.build.borrow_mut() =
            Box::new(|| Err(Error::VerificationRefused("InvalidAncestryBranch".into())));
        let (mut service, _) = service_with(&script, Store::open_in_memory().unwrap());
        service.run_once().unwrap();
        assert_eq!(state_of(&service, 0x11), DepositState::LightClientUpdated);
        service.run_once().unwrap();
        assert_eq!(state_of(&service, 0x11), DepositState::LightClientUpdated);
        service.run_once().unwrap();
        assert_eq!(state_of(&service, 0x11), DepositState::Failed);
        assert_eq!(script.sends.get(), 0, "nothing was ever sent");
        let record = service
            .store()
            .get(B256::repeat_byte(0x11))
            .unwrap()
            .unwrap();
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
        let record = service
            .store()
            .get(B256::repeat_byte(0x11))
            .unwrap()
            .unwrap();
        assert_eq!((record.state, record.attempts), (DepositState::Proven, 0));
    }

    /// Claim: while the flow limiter refuses, the deposit waits in `proven` with the note, nothing is sent, and no
    /// attempt counts, however many passes go by. When the limiter allows, the deposit is paid.
    /// Why it matters: a rate limit may last longer than `max_attempts` passes, and the deposit stays claimable on chain.
    /// Marking it `failed` would strand it in the service.
    #[test]
    fn a_flow_limiter_refusal_waits_without_counting_attempts() {
        let script = Script::new();
        *script.refusal.borrow_mut() = Some("waiting on the flow limiter".into());
        let (mut service, _) = service_with(&script, Store::open_in_memory().unwrap());
        for _ in 0..10 {
            service.run_once().unwrap();
        }
        let record = service
            .store()
            .get(B256::repeat_byte(0x11))
            .unwrap()
            .unwrap();
        assert_eq!((record.state, record.attempts), (DepositState::Proven, 0));
        assert_eq!(record.note.as_deref(), Some("waiting on the flow limiter"));
        assert_eq!(
            script.sends.get(),
            0,
            "nothing was sent while the limiter refused"
        );

        *script.refusal.borrow_mut() = None;
        service.run_once().unwrap();
        assert_eq!(state_of(&service, 0x11), DepositState::Confirmed);
    }

    /// Claim: each pass asks every route once to move its own-chain light client, even when no deposit is waiting, and
    /// a pass that sent updates says how many.
    /// Why it matters: the own-chain light client goes stale unless the loop updates it. A pass with no deposit is the
    /// common case, so the update must not hang on one.
    #[test]
    fn every_pass_keeps_the_own_chain_light_client_current() {
        let script = Script::new();
        script.deposits.borrow_mut().clear();
        *script.own_answer.borrow_mut() = Box::new(|| Ok(2));
        let (mut service, lines) = service_with(&script, Store::open_in_memory().unwrap());
        service.run_once().unwrap();
        service.run_once().unwrap();
        assert_eq!(script.own_calls.get(), 2, "once per pass");
        let updated: Vec<String> = lines
            .lock()
            .unwrap()
            .iter()
            .filter(|line| line.contains("event=own_light_client_updated"))
            .cloned()
            .collect();
        assert_eq!(updated.len(), 2);
        assert!(
            updated[0].contains("updates=2") && updated[0].contains("route=a_to_b"),
            "{}",
            updated[0]
        );
    }

    /// Claim: a failed own-chain update is logged as a warning, and the pass still finishes the deposits.
    /// Why it matters: the own-chain light client has no bearing on a deposit in flight. A beacon outage that blocks it
    /// must not block a withdrawal.
    #[test]
    fn a_failed_own_chain_update_does_not_stop_the_deposits() {
        let script = Script::new();
        *script.own_answer.borrow_mut() =
            Box::new(|| Err(Error::Beacon("no finality update".into())));
        let (mut service, lines) = service_with(&script, Store::open_in_memory().unwrap());
        service.run_once().unwrap();
        assert_eq!(state_of(&service, 0x11), DepositState::Confirmed);
        let failed: Vec<String> = lines
            .lock()
            .unwrap()
            .iter()
            .filter(|line| line.contains("event=own_light_client_update_failed"))
            .cloned()
            .collect();
        assert_eq!(failed.len(), 1);
        assert!(failed[0].contains("no finality update"), "{}", failed[0]);
    }

    /// Claim: a route with no own-chain light client sends no update and logs nothing about it.
    /// Why it matters: the setting is optional. An operator without it must see no noise.
    #[test]
    fn a_route_without_an_own_chain_light_client_logs_nothing_about_it() {
        let script = Script::new();
        let (mut service, lines) = service_with(&script, Store::open_in_memory().unwrap());
        service.run_once().unwrap();
        assert!(lines
            .lock()
            .unwrap()
            .iter()
            .all(|line| !line.contains("own_light_client")));
    }

    /// Claim: `follow` asks each route for updates until the route says zero or the rounds run out, adds up the updates, and
    /// logs one line for each call. A failing route stops the call with its error.
    /// Why it matters: an operator runs it before the first deposit to store the headers that the first withdrawals need.
    /// A route that never says zero must still stop after the rounds.
    #[test]
    fn follow_sends_updates_until_the_head_is_current_or_the_rounds_run_out() {
        let script = Script::new();
        let (service, lines) = service_with(&script, Store::open_in_memory().unwrap());
        let remaining = std::rc::Rc::new(Cell::new(2usize));
        let counter = remaining.clone();
        *script.follow_answer.borrow_mut() = Box::new(move || {
            let left = counter.get();
            counter.set(left.saturating_sub(1));
            Ok(usize::from(left > 0))
        });
        assert_eq!(
            service.follow(5).unwrap().updates_sent,
            2,
            "two updates, then zero ends the route"
        );
        assert_eq!(script.follow_calls.get(), 3);
        let followed = lines
            .lock()
            .unwrap()
            .iter()
            .filter(|line| line.contains("event=light_client_followed"))
            .count();
        assert_eq!(followed, 3);

        script.follow_calls.set(0);
        *script.follow_answer.borrow_mut() = Box::new(|| Ok(1));
        assert_eq!(
            service.follow(3).unwrap().updates_sent,
            3,
            "the rounds end a route that always has an update"
        );
        assert_eq!(script.follow_calls.get(), 3);

        *script.follow_answer.borrow_mut() = Box::new(|| Err(Error::Beacon("down".into())));
        assert!(service.follow(3).is_err());
    }

    /// Claim: after the rounds, `follow` tries to open the source vault of every route, logs one line for each outcome,
    /// and reports a vault that stays locked without failing. A failure of the opening is a locked vault with the error as
    /// its reason.
    /// Why it matters: a locked vault refuses every deposit. The operator reads the lines and the report to know when to
    /// start deposits, and one stuck route must not hide the state of the others or fail the update work that succeeded.
    #[test]
    fn follow_opens_the_source_vault_and_reports_a_locked_one() {
        let script = Script::new();
        let (service, lines) = service_with(&script, Store::open_in_memory().unwrap());
        let report = service.follow(1).unwrap();
        assert_eq!(script.open_calls.get(), 1);
        assert!(report.locked_routes().is_empty());
        assert_eq!(report.openings[0].summary(), "route a_to_b: deposits open");

        let transaction = B256::repeat_byte(0xab);
        *script.open_answer.borrow_mut() =
            Box::new(move || Ok(OpeningOutcome::Opened { transaction }));
        let report = service.follow(1).unwrap();
        assert!(report.locked_routes().is_empty());
        assert!(report.openings[0]
            .summary()
            .contains("deposits opened (transaction 0xabab"));

        *script.open_answer.borrow_mut() = Box::new(|| {
            Ok(OpeningOutcome::NotReady {
                reason: "the light client on the source chain stored no update yet".into(),
            })
        });
        let report = service.follow(1).unwrap();
        assert_eq!(report.locked_routes(), vec!["a_to_b"]);
        assert_eq!(
            report.openings[0].summary(),
            "route a_to_b: deposits locked: the light client on the source chain stored no update yet"
        );

        *script.open_answer.borrow_mut() = Box::new(|| Err(Error::Http("down".into())));
        let report = service.follow(1).unwrap();
        assert_eq!(report.locked_routes(), vec!["a_to_b"]);
        assert!(report.openings[0]
            .summary()
            .contains("the opening failed: http: down"));

        let lines = lines.lock().unwrap();
        for event in ["deposits_open", "deposits_opened", "deposits_locked"] {
            let wanted = format!("event={event} ");
            assert!(lines.iter().any(|line| line.contains(&wanted)), "{event}");
        }
        assert!(lines
            .iter()
            .any(|line| line.contains("event=deposits_opened")
                && line.contains("transaction=0xabab")));
    }

    /// Claim: an update that fails stops `follow` before any vault is opened.
    /// Why it matters: the opening proof needs the updates. A half followed route must not look opened.
    #[test]
    fn a_failed_update_stops_follow_before_the_opening() {
        let script = Script::new();
        let (service, _) = service_with(&script, Store::open_in_memory().unwrap());
        *script.follow_answer.borrow_mut() = Box::new(|| Err(Error::Beacon("down".into())));
        assert!(service.follow(1).is_err());
        assert_eq!(script.open_calls.get(), 0);
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

    /// A script with `count` deposits, one per block from block 10, all final, with a modelled light client that
    /// starts below every deposit.
    fn burst_script(count: u8) -> std::rc::Rc<Script> {
        let script = Script::new();
        *script.deposits.borrow_mut() = (0..count)
            .map(|offset| sample_deposit(0x40 + offset, 10 + u64::from(offset)))
            .collect();
        script.head.set(Some(0));
        script
    }

    fn confirmed_count(service: &Service) -> usize {
        service
            .store()
            .list(None)
            .unwrap()
            .iter()
            .filter(|record| record.state == DepositState::Confirmed)
            .count()
    }

    /// Claim: a burst of 25 deposits costs one light-client update and two requests to advance it (for the oldest
    /// deposit and for the newest), and one pass pays them all. The service sends every withdrawal before it waits
    /// for the first receipt.
    /// Why it matters: before the change each deposit cost its own update check and its own receipt wait, about 14
    /// seconds each on the local network, so a burst of 25 delayed honest deposits from 18 to 104 seconds.
    #[test]
    fn a_burst_costs_one_update_and_one_pass() {
        let script = burst_script(25);
        let (mut service, _) = service_with(&script, Store::open_in_memory().unwrap());
        service.run_once().unwrap();
        assert_eq!(confirmed_count(&service), 25);
        assert_eq!(script.updates.get(), 1, "one update for the whole burst");
        assert_eq!(
            script.advance_calls.get(),
            2,
            "asked for the oldest and for the newest deposit, not once per deposit"
        );
        assert_eq!(script.sends.get(), 25);
        let order = script.order.borrow();
        let first_confirm = order.iter().position(|step| *step == "confirm").unwrap();
        assert_eq!(
            first_confirm, 25,
            "all sends come before the first receipt wait: {order:?}"
        );
    }

    /// Claim: the limit per pass holds, and the update is still sent once. A burst of 25 with a limit of 10 is paid in
    /// three passes.
    /// Why it matters: the limit bounds the work and the gas of one pass, and it must not make the update repeat.
    #[test]
    fn the_limit_per_pass_spreads_a_burst_over_passes() {
        let script = burst_script(25);
        let (mut service, _) = service_with_limit(&script, Store::open_in_memory().unwrap(), 10);
        let mut paid_after_each_pass = Vec::new();
        for _ in 0..3 {
            service.run_once().unwrap();
            paid_after_each_pass.push(confirmed_count(&service));
        }
        assert_eq!(paid_after_each_pass, [10, 20, 25]);
        assert_eq!(script.updates.get(), 1);
    }

    /// Claim: when one withdrawal of the batch fails, the others are still sent and paid in the same pass. The failed
    /// deposit counts one attempt, stays `proven`, and is paid in the next pass.
    /// Why it matters: one bad deposit must not hold back the 24 around it.
    #[test]
    fn a_failed_withdrawal_in_the_middle_does_not_block_the_batch() {
        let script = burst_script(25);
        let calls = std::rc::Rc::new(Cell::new(0u32));
        let counter = calls.clone();
        *script.send.borrow_mut() = Box::new(move || {
            counter.set(counter.get() + 1);
            if counter.get() == 13 {
                return Err(Error::Transaction("the vault refused this one".into()));
            }
            Ok(SendOutcome::Sent(B256::repeat_byte(0xee)))
        });
        let (mut service, _) = service_with(&script, Store::open_in_memory().unwrap());
        service.run_once().unwrap();
        assert_eq!(confirmed_count(&service), 24);
        let stuck: Vec<DepositRecord> = service
            .store()
            .list(None)
            .unwrap()
            .into_iter()
            .filter(|record| record.state != DepositState::Confirmed)
            .collect();
        assert_eq!(stuck.len(), 1);
        assert_eq!(
            (stuck[0].state, stuck[0].attempts),
            (DepositState::Proven, 1)
        );
        service.run_once().unwrap();
        assert_eq!(confirmed_count(&service), 25);
        assert_eq!(script.updates.get(), 1);
    }

    /// Claim: a deposit that the flow limiter refuses waits with a note, and the others of the batch are paid.
    #[test]
    fn a_flow_limiter_wait_does_not_block_the_batch() {
        let script = burst_script(5);
        let (mut service, _) = service_with(&script, Store::open_in_memory().unwrap());
        *script.refusal.borrow_mut() = Some("waiting on the flow limiter".into());
        service.run_once().unwrap();
        assert_eq!(
            confirmed_count(&service),
            0,
            "the limiter refuses every deposit"
        );
        *script.refusal.borrow_mut() = None;
        service.run_once().unwrap();
        assert_eq!(confirmed_count(&service), 5);
    }

    fn fail_deposit(script: &std::rc::Rc<Script>, service: &mut Service) {
        *script.build.borrow_mut() = Box::new(|| {
            Err(Error::VerificationRefused(
                "the light client lost an update".into(),
            ))
        });
        for _ in 0..3 {
            service.run_once().unwrap();
        }
        assert_eq!(state_of(service, 0x11), DepositState::Failed);
    }

    fn sample_transaction() -> B256 {
        sample_deposit(0x11, 10).transaction_hash
    }

    /// Claim: `retry` sends a failed deposit back to the start with no attempts and a note, and the next pass pays it.
    /// Why it matters: the cause of a failure (a reverted chain removed a light-client update) can go away, and a
    /// terminal state had no way back.
    #[test]
    fn retry_of_a_failed_deposit_ends_paid() {
        let script = Script::new();
        let (mut service, _) = service_with(&script, Store::open_in_memory().unwrap());
        fail_deposit(&script, &mut service);
        *script.build.borrow_mut() = Box::new(|| Ok(vec![1, 2, 3]));

        let (nonce, outcome) = service.retry(sample_transaction(), 0).unwrap();
        assert_eq!(
            (nonce, outcome),
            (B256::repeat_byte(0x11), RetryOutcome::Restarted)
        );
        let record = service.store().get(nonce).unwrap().unwrap();
        assert_eq!((record.state, record.attempts), (DepositState::Seen, 0));
        assert!(record
            .note
            .unwrap()
            .contains("the light client lost an update"));

        service.run_once().unwrap();
        assert_eq!(state_of(&service, 0x11), DepositState::Confirmed);
    }

    /// Claim: `retry` refuses a deposit that is not failed and leaves it alone.
    /// Why it matters: a retry of a live deposit would run two copies of its work.
    #[test]
    fn retry_refuses_a_deposit_that_is_not_failed() {
        let script = Script::new();
        script.status.set(None);
        let (mut service, _) = service_with(&script, Store::open_in_memory().unwrap());
        service.run_once().unwrap();
        assert_eq!(state_of(&service, 0x11), DepositState::Submitted);
        let error = service.retry(sample_transaction(), 0).unwrap_err();
        assert!(matches!(error, Error::Usage(_)));
        assert!(error.to_string().contains("not failed"), "{error}");
        assert_eq!(state_of(&service, 0x11), DepositState::Submitted);
        let error = service.retry(sample_transaction(), 7).unwrap_err();
        assert!(error.to_string().contains("no deposit"), "{error}");
    }

    /// Claim: `retry` of a failed deposit whose nonce the vault already paid marks it `confirmed`, not `seen`.
    /// Why it matters: a second withdrawal of a paid nonce can only revert, and the deposit is delivered.
    #[test]
    fn retry_confirms_a_deposit_whose_nonce_is_claimed() {
        let script = Script::new();
        let (mut service, _) = service_with(&script, Store::open_in_memory().unwrap());
        fail_deposit(&script, &mut service);
        script.claimed.set(true);
        let (_, outcome) = service.retry(sample_transaction(), 0).unwrap();
        assert_eq!(outcome, RetryOutcome::AlreadyPaid);
        assert_eq!(state_of(&service, 0x11), DepositState::Confirmed);
        assert_eq!(script.sends.get(), 0);
    }
}
