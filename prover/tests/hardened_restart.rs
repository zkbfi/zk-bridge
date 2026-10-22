//! Hardened two-chain tests of the service's restart behavior: a process that dies between two steps of one deposit
//! must, after a restart, finish that deposit exactly once.
//!
//! The tests do not kill an operating system process, which would be a race. They build the service from the same pieces
//! as `once` does (configuration, signer, routes, SQLite file), and wrap each route in a decorator that fails at one
//! named step with a transient error, as a crash does: the step's effect stays where it happened, and the file keeps the
//! state of the step before. Then the service is dropped, a new one opens the same file, and the next pass runs.

mod common;

use alloy_primitives::{B256, U256};
use common::bridge::*;
use common::*;
use zk_bridge_prover::cli::{resolve_oracle, resolve_signer};
use zk_bridge_prover::config::Config;
use zk_bridge_prover::error::{Error, Result};
use zk_bridge_prover::logging::Logger;
use zk_bridge_prover::route::build_routes;
use zk_bridge_prover::service::{
    Coverage, Route, RoutePorts, SendOutcome, Service, ServiceSettings,
};
use zk_bridge_prover::store::{NewDeposit, Store};

/// The step at which the decorated route "crashes".
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum CrashAt {
    /// Never: the route behaves as it is.
    Nowhere,
    /// Before building the withdrawal: the light client is updated, nothing else.
    BeforeBuild,
    /// Before sending the withdrawal: the calldata is built and stored.
    BeforeSend,
    /// After the withdrawal is mined, before the service writes the transaction hash to its file.
    AfterSendBeforeRecord,
    /// After the service wrote the transaction hash, before it learns that the transaction succeeded.
    BeforeConfirm,
}

/// A route that delegates to another and fails at one step.
struct Crashing {
    inner: Box<dyn RoutePorts>,
    crash_at: CrashAt,
}

fn crash() -> Error {
    Error::Http("simulated crash".into())
}

impl RoutePorts for Crashing {
    fn finalized_source_block(&self) -> Result<Option<u64>> {
        self.inner.finalized_source_block()
    }
    fn scan(&self, from: u64, to: u64) -> Result<Vec<NewDeposit>> {
        self.inner.scan(from, to)
    }
    fn deposit_from_receipt(
        &self,
        transaction: B256,
        log_index: u64,
    ) -> Result<Option<NewDeposit>> {
        self.inner.deposit_from_receipt(transaction, log_index)
    }
    fn claimed(&self, nonce: B256) -> Result<bool> {
        self.inner.claimed(nonce)
    }
    fn advance_light_client(&self, deposit: &NewDeposit) -> Result<Coverage> {
        self.inner.advance_light_client(deposit)
    }
    fn build_withdrawal(&self, deposit: &NewDeposit) -> Result<Vec<u8>> {
        if self.crash_at == CrashAt::BeforeBuild {
            return Err(crash());
        }
        self.inner.build_withdrawal(deposit)
    }
    fn send_withdrawal(&self, calldata: &[u8]) -> Result<SendOutcome> {
        if self.crash_at == CrashAt::BeforeSend {
            return Err(crash());
        }
        let outcome = self.inner.send_withdrawal(calldata)?;
        if self.crash_at == CrashAt::AfterSendBeforeRecord {
            return Err(crash());
        }
        Ok(outcome)
    }
    fn transaction_succeeded(&self, transaction: B256) -> Result<Option<bool>> {
        if self.crash_at == CrashAt::BeforeConfirm {
            return Err(crash());
        }
        self.inner.transaction_succeeded(transaction)
    }
}

/// Opens the configuration, the signer and the file as `once` does, and runs ONE pass with the given crash. The service
/// is dropped when the pass ends, which closes the file: the next call is a restart.
fn one_pass(bridge: &Bridge, crash_at: CrashAt) {
    let lookup = |name: &str| (name == "ANVIL_DEPLOYER").then(|| DEPLOYER_SECRET.to_string());
    let config = Config::load_file(&bridge.config_path, &lookup).expect("configuration");
    let signer = resolve_signer(&config, Some("ANVIL_DEPLOYER"), &lookup).expect("signer");
    let oracle = resolve_oracle(&config, &signer).expect("oracle");
    let routes: Vec<Route> = build_routes(&config, &signer, &oracle)
        .expect("routes")
        .into_iter()
        .map(|route| Route {
            name: route.name,
            start_block: route.start_block,
            log_block_range: route.log_block_range,
            ports: Box::new(Crashing {
                inner: route.ports,
                crash_at,
            }),
        })
        .collect();
    let store = Store::open(&config.database_path).expect("file");
    let (logger, _lines) = Logger::in_memory();
    Service::new(
        store,
        logger,
        ServiceSettings {
            max_attempts: config.max_attempts,
            max_withdrawals_per_pass: config.max_withdrawals_per_pass,
        },
        routes,
    )
    .run_once()
    .expect("pass");
}

/// How many withdrawals the vault of chain 369 paid, from its `WithdrawalCompleted` events.
fn payouts(bridge: &Bridge) -> usize {
    let topic =
        alloy_primitives::keccak256("WithdrawalCompleted(address,address,bytes32,uint256,bytes32)");
    let client = client_of(&bridge.chain_b);
    let latest = bridge.chain_b.block_number();
    client.logs(bridge.vault_b, topic, 0, latest).unwrap().len()
}

/// The payouts, after waiting up to ten seconds for `expected` of them. The service returns when its transaction is
/// accepted, and Anvil may mine it a moment later.
fn payouts_after_waiting(bridge: &Bridge, expected: usize) -> usize {
    let start = std::time::Instant::now();
    while payouts(bridge) < expected && start.elapsed() < std::time::Duration::from_secs(10) {
        std::thread::sleep(std::time::Duration::from_millis(100));
    }
    payouts(bridge)
}

fn setup(name: &str) -> (Bridge, MadeDeposit, u128) {
    let bridge = deploy_bridge(name);
    fund_destination_vault(&bridge, Direction::AToB, 100 * ONE_TOKEN);
    let amount = 5 * ONE_TOKEN;
    let made = deposit_on(&bridge, Direction::AToB, amount);
    bridge.chain_a.mine(2);
    (bridge, made, amount)
}

/// Claim: a service that stops after it updated the light client, again before it sent the withdrawal, and again after
/// the withdrawal was mined but before it recorded the transaction, still delivers the deposit exactly once after a
/// restart.
/// Shows: after each crash the file holds the state of the last finished step (`light_client_updated`, then `proven` with
/// stored calldata, then `proven` although the chain already paid). Nothing is paid before the withdrawal step. After
/// the third crash the vault has paid once, and the file does not know. The next healthy pass sees that the vault marks
/// the nonce as claimed, ends the deposit as `confirmed` and sends nothing. The number of payouts is one, the recipient
/// holds the amount once, the light client got no second update, and the destination account sent no extra transaction.
/// The control is the same deposit in the healthy pass: it ends `confirmed`.
/// Why it matters: a prover that dies and restarts is normal operation. A second withdrawal transaction wastes gas, and a
/// service that cannot tell "paid" from "not paid" after a crash would either lose a deposit or pay it twice.
#[test]
fn restart_after_crashes_between_steps_delivers_the_deposit_exactly_once() {
    if !tools_available() {
        return;
    }
    let (bridge, made, amount) = setup("restart-steps");
    let state = || state_of(&bridge, made.nonce);
    let recipient = || balance(&bridge.chain_b, bridge.token_b, RECIPIENT);
    let sent_by_deployer = || bridge.chain_b.nonce(DEPLOYER);

    // Crash 1: after the light client update, before the withdrawal is built.
    one_pass(&bridge, CrashAt::BeforeBuild);
    assert_eq!(state(), "light_client_updated");
    let updates_after_first_crash = stored_head_slots(&bridge.chain_b, bridge.light_client_b).len();
    assert!(
        updates_after_first_crash > 0,
        "the light client was updated before the crash"
    );
    assert_eq!(
        (recipient(), payouts(&bridge)),
        (U256::ZERO, 0),
        "nothing paid yet"
    );

    // Crash 2: the withdrawal is built and stored, and the crash comes before the send.
    one_pass(&bridge, CrashAt::BeforeSend);
    assert_eq!(state(), "proven");
    assert_eq!(
        (recipient(), payouts(&bridge)),
        (U256::ZERO, 0),
        "nothing paid yet"
    );
    let nonce_before_send = sent_by_deployer();

    // Crash 3: the withdrawal is mined, and the crash comes before the file records it.
    one_pass(&bridge, CrashAt::AfterSendBeforeRecord);
    assert_eq!(
        state(),
        "proven",
        "the file does not know about the payment"
    );
    assert_eq!(payouts_after_waiting(&bridge, 1), 1, "the chain paid once");
    assert_eq!(recipient(), U256::from(amount));
    assert_eq!(
        sent_by_deployer(),
        nonce_before_send + 1,
        "one withdrawal transaction so far"
    );

    // The restart: a healthy pass finishes the deposit and sends nothing.
    one_pass(&bridge, CrashAt::Nowhere);
    assert_eq!(state(), "confirmed");
    assert_eq!(
        (recipient(), payouts(&bridge)),
        (U256::from(amount), 1),
        "exactly one payout"
    );
    assert_eq!(
        sent_by_deployer(),
        nonce_before_send + 1,
        "the restart sent no second withdrawal"
    );
    assert_eq!(
        stored_head_slots(&bridge.chain_b, bridge.light_client_b).len(),
        updates_after_first_crash,
        "the light client got no second update"
    );
    assert!(claimed(&bridge.chain_b, bridge.vault_b, made.nonce));

    // A further pass changes nothing.
    one_pass(&bridge, CrashAt::Nowhere);
    assert_eq!(
        (recipient(), payouts(&bridge), sent_by_deployer()),
        (U256::from(amount), 1, nonce_before_send + 1)
    );
}

/// Claim: a service that stops after it recorded its withdrawal transaction, before it learned the result, ends the deposit
/// as `confirmed` after a restart and sends nothing again.
/// Shows: after the crash the file says `submitted` and the chain has paid once. The healthy pass reads the receipt of the
/// recorded transaction, ends `confirmed`, and the vault has paid once, with no new transaction from the service.
/// Why it matters: this is the other half of the crash window. The first test covers a crash before the file records the
/// transaction. This one covers a crash after it. In both, the deposit completes exactly once.
#[test]
fn restart_after_the_withdrawal_was_recorded_confirms_without_resending() {
    if !tools_available() {
        return;
    }
    let (bridge, made, amount) = setup("restart-submitted");
    one_pass(&bridge, CrashAt::BeforeConfirm);
    assert_eq!(state_of(&bridge, made.nonce), "submitted");
    assert_eq!(payouts_after_waiting(&bridge, 1), 1, "the chain paid once");
    let nonce_after_send = bridge.chain_b.nonce(DEPLOYER);

    one_pass(&bridge, CrashAt::Nowhere);
    assert_eq!(state_of(&bridge, made.nonce), "confirmed");
    assert_eq!(payouts(&bridge), 1);
    assert_eq!(
        bridge.chain_b.nonce(DEPLOYER),
        nonce_after_send,
        "no second transaction"
    );
    assert_eq!(
        balance(&bridge.chain_b, bridge.token_b, RECIPIENT),
        U256::from(amount)
    );
}
