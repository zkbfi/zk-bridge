//! Bots for the local network: they deposit small amounts of the test tokens in both directions and report each
//! completed withdrawal.
//!
//! The bots send from the unlocked Anvil accounts, as the Anvil tests do, so they hold no key. Each deposit follows the
//! steps of the tests: mint, approve, gate evidence, deposit. The evidence comes from [`SyntheticForkSource`], so the
//! Ethereum-side gate (mode `Enforcing`) accepts the first deposit of every epoch. The bots never touch the prover:
//! they only read the destination vault (`claimed(nonce)`) to see that a withdrawal happened.

use super::deployment::{ChainRecord, Deployment};
use super::synthetic_fork::SyntheticForkSource;
use crate::chain::ChainClient;
use crate::contracts::{deposit_calldata, TokenContract, VaultContract};
use crate::error::{Error, Result};
use crate::gate::gate_evidence_for_deposit;
use crate::light_client::{decode_deposit, DEPOSIT_EVENT_TOPIC};
use crate::rpc::{parse_quantity, HttpRpc, JsonRpc};
use alloy_primitives::{hex, Address, B256, U256};
use alloy_sol_types::SolCall;
use serde_json::{json, Value};
use std::str::FromStr;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

/// One hundredth of a token with 18 decimals.
const CENTI_TOKEN: u128 = 10_000_000_000_000_000;
/// The gas limit of every bot transaction. A deposit with a fork proof stays far below it.
const GAS_LIMIT: &str = "0x7a1200";
/// The Anvil account that the bots use first. Account 0 deploys and account 1 is the prover.
pub const FIRST_BOT_ACCOUNT: usize = 2;
/// The largest deposit in hundredths of a token. The smallest is 1.
const LARGEST_DEPOSIT_CENTI_TOKENS: u64 = 100;
/// A withdrawal that takes longer than this is reported as slow, once.
const SLOW_WITHDRAWAL: Duration = Duration::from_secs(300);

/// What the bots do.
#[derive(Clone, Copy, Debug)]
pub struct TrafficSettings {
    /// The fewest seconds between two deposits.
    pub minimum_wait_seconds: u64,
    /// The most seconds between two deposits.
    pub maximum_wait_seconds: u64,
    /// The number of Anvil accounts that act as depositors.
    pub bot_count: usize,
}

/// The direction of a deposit.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Direction {
    /// Deposit on chain A, withdraw on chain B.
    AToB,
    /// Deposit on chain B, withdraw on chain A.
    BToA,
}

impl Direction {
    /// The name in logs. It matches the route names of the prover.
    pub fn as_str(self) -> &'static str {
        match self {
            Self::AToB => "a_to_b",
            Self::BToA => "b_to_a",
        }
    }

    fn other(self) -> Self {
        match self {
            Self::AToB => Self::BToA,
            Self::BToA => Self::AToB,
        }
    }
}

/// A small, fast, seedable random number generator (xorshift64*). The bots need variety, not secrecy.
#[derive(Clone, Debug)]
pub struct Random(u64);

impl Random {
    /// A generator with a fixed seed. A zero seed becomes one.
    pub fn seeded(seed: u64) -> Self {
        Self(if seed == 0 { 1 } else { seed })
    }

    /// A generator seeded from the clock and the process identifier.
    pub fn from_clock() -> Self {
        let nanoseconds = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map_or(1, |elapsed| elapsed.as_nanos() as u64);
        Self::seeded(nanoseconds ^ (u64::from(std::process::id()) << 32))
    }

    fn next(&mut self) -> u64 {
        self.0 ^= self.0 >> 12;
        self.0 ^= self.0 << 25;
        self.0 ^= self.0 >> 27;
        self.0.wrapping_mul(0x2545_F491_4F6C_DD1D)
    }

    /// A number from `low` to `high`, both included. `high` below `low` gives `low`.
    pub fn between(&mut self, low: u64, high: u64) -> u64 {
        if high <= low {
            return low;
        }
        low + self.next() % (high - low + 1)
    }
}

/// A token amount in hundredths of a token as text, for example `37` gives `0.37`.
pub fn tokens_text(centi_tokens: u64) -> String {
    format!("{}.{:02}", centi_tokens / 100, centi_tokens % 100)
}

/// The same for an amount in the smallest unit. The text rounds down to hundredths.
pub fn base_units_text(amount: U256) -> String {
    let centi = amount / U256::from(CENTI_TOKEN);
    u64::try_from(centi).map_or_else(|_| "huge".to_string(), tokens_text)
}

/// The nonce of the first deposit log of a receipt.
///
/// # Errors
/// `Error::Malformed` when the receipt has no deposit log or the log does not decode.
pub fn deposit_nonce_of(receipt: &Value) -> Result<B256> {
    let topic = format!("{DEPOSIT_EVENT_TOPIC:#x}");
    let logs = receipt["logs"].as_array().map_or(&[][..], Vec::as_slice);
    let log = logs
        .iter()
        .find(|log| log["topics"][0].as_str() == Some(topic.as_str()))
        .ok_or_else(|| Error::Malformed("the receipt has no deposit log".into()))?;
    let topics = log["topics"]
        .as_array()
        .map_or(&[][..], Vec::as_slice)
        .iter()
        .map(|topic| {
            topic
                .as_str()
                .and_then(|text| B256::from_str(text).ok())
                .ok_or_else(|| Error::Malformed("a log topic is not a hash".into()))
        })
        .collect::<Result<Vec<_>>>()?;
    let data = hex::decode(log["data"].as_str().unwrap_or_default())
        .map_err(|error| Error::Malformed(format!("deposit log data: {error}")))?;
    Ok(decode_deposit(&topics, &data)?.nonce)
}

/// A chain as the bots use it: reads through the library client, sends from unlocked accounts.
struct Side {
    record: ChainRecord,
    client: ChainClient,
    rpc: HttpRpc,
    fork_source: SyntheticForkSource,
}

impl Side {
    fn connect(record: &ChainRecord) -> Result<Self> {
        Ok(Self {
            client: ChainClient::connect(
                &record.name,
                record.chain_id,
                Box::new(HttpRpc::new(&record.rpc_url)),
                None,
            )?,
            rpc: HttpRpc::new(&record.rpc_url),
            fork_source: SyntheticForkSource::new(&record.rpc_url),
            record: record.clone(),
        })
    }

    /// Sends a transaction from an unlocked account and waits for a successful receipt.
    fn send(&self, from: Address, to: Address, data: &[u8], what: &str) -> Result<Value> {
        let hash = self.rpc.call(
            "eth_sendTransaction",
            json!([{
                "from": format!("{from:#x}"),
                "to": format!("{to:#x}"),
                "data": format!("0x{}", hex::encode(data)),
                "gas": GAS_LIMIT,
            }]),
        )?;
        let started = Instant::now();
        loop {
            let receipt = self.rpc.call("eth_getTransactionReceipt", json!([hash]))?;
            if !receipt.is_null() {
                if receipt["status"] != "0x1" {
                    return Err(Error::Transaction(format!(
                        "{what} reverted on {} (transaction {hash})",
                        self.record.name
                    )));
                }
                return Ok(receipt);
            }
            if started.elapsed() > Duration::from_secs(60) {
                return Err(Error::Http(format!(
                    "{what} was not mined on {} within 60 seconds",
                    self.record.name
                )));
            }
            std::thread::sleep(Duration::from_millis(250));
        }
    }

    fn accounts(&self) -> Result<Vec<Address>> {
        let answer = self.rpc.call("eth_accounts", json!([]))?;
        answer
            .as_array()
            .map_or(&[][..], Vec::as_slice)
            .iter()
            .map(|entry| {
                entry
                    .as_str()
                    .and_then(|text| Address::from_str(text).ok())
                    .ok_or_else(|| Error::Malformed("eth_accounts: not an address".into()))
            })
            .collect()
    }

    fn token_balance(&self, account: Address) -> Result<U256> {
        self.client
            .view(self.record.token, TokenContract::balanceOfCall { account })
    }

    fn claimed(&self, nonce: B256) -> Result<bool> {
        self.client.view(
            self.record.vault,
            VaultContract::claimedCall {
                depositNonce: nonce,
            },
        )
    }
}

/// A deposit that the bots wait to see paid on the other chain.
#[derive(Debug)]
struct PendingWithdrawal {
    direction: Direction,
    nonce: B256,
    recipient: Address,
    amount: U256,
    deposited_at: Instant,
    reported_slow: bool,
}

/// The bots: two chains, a list of depositors, and the withdrawals that they still wait for.
pub struct Traffic {
    chain_a: Side,
    chain_b: Side,
    depositors: Vec<Address>,
    settings: TrafficSettings,
    random: Random,
    pending: Vec<PendingWithdrawal>,
    deposits: [u64; 2],
    completed: [u64; 2],
}

fn log(level: &str, event: &str, fields: &str) {
    let seconds = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_or(0, |elapsed| elapsed.as_secs());
    println!("ts={seconds} level={level} event={event} {fields}");
}

fn index_of(direction: Direction) -> usize {
    match direction {
        Direction::AToB => 0,
        Direction::BToA => 1,
    }
}

impl Traffic {
    /// Connects to both chains and picks the depositors from the Anvil accounts.
    ///
    /// # Errors
    /// Any connection error, and `Error::Config` when the chains have too few accounts or give different accounts.
    pub fn connect(deployment: &Deployment, settings: TrafficSettings) -> Result<Self> {
        let chain_a = Side::connect(&deployment.chain_a)?;
        let chain_b = Side::connect(&deployment.chain_b)?;
        let (accounts_a, accounts_b) = (chain_a.accounts()?, chain_b.accounts()?);
        let wanted = FIRST_BOT_ACCOUNT + settings.bot_count;
        if accounts_a.len() < wanted || accounts_a != accounts_b {
            return Err(Error::Config(format!(
                "the bots need {wanted} unlocked accounts that are the same on both chains"
            )));
        }
        Ok(Self {
            depositors: accounts_a[FIRST_BOT_ACCOUNT..wanted].to_vec(),
            chain_a,
            chain_b,
            settings,
            random: Random::from_clock(),
            pending: Vec::new(),
            deposits: [0; 2],
            completed: [0; 2],
        })
    }

    fn source(&self, direction: Direction) -> &Side {
        match direction {
            Direction::AToB => &self.chain_a,
            Direction::BToA => &self.chain_b,
        }
    }

    fn destination(&self, direction: Direction) -> &Side {
        self.source(direction.other())
    }

    /// Mints, approves and deposits once on the source chain of `direction`, then remembers the withdrawal.
    ///
    /// # Errors
    /// Any error of a transaction, a read or the evidence builder. The caller logs it and goes on.
    pub fn deposit_once(&mut self, direction: Direction) -> Result<()> {
        let depositor_index = self.random.between(0, self.depositors.len() as u64 - 1) as usize;
        let depositor = self.depositors[depositor_index];
        let centi_tokens = self.random.between(1, LARGEST_DEPOSIT_CENTI_TOKENS);
        let amount = U256::from(u128::from(centi_tokens) * CENTI_TOKEN);
        let source = self.source(direction);
        let record = &source.record;

        source.send(
            depositor,
            record.token,
            &TokenContract::mintCall {
                to: depositor,
                amount,
            }
            .abi_encode(),
            "mint",
        )?;
        source.send(
            depositor,
            record.token,
            &TokenContract::approveCall {
                spender: record.vault,
                amount,
            }
            .abi_encode(),
            "approve",
        )?;
        let evidence = gate_evidence_for_deposit(&source.client, record.gate, &source.fork_source)?;
        let receipt = source.send(
            depositor,
            record.vault,
            &deposit_calldata(record.token, depositor, amount, 0, &evidence),
            "deposit",
        )?;
        let nonce = deposit_nonce_of(&receipt)?;
        log(
            "info",
            "deposit",
            &format!(
                "direction={} source_chain={} destination_chain={} sender={depositor:#x} amount_tokens={} nonce={nonce:#x} transaction={} block={} fork_proof={}",
                direction.as_str(),
                record.chain_id,
                self.destination(direction).record.chain_id,
                tokens_text(centi_tokens),
                receipt["transactionHash"].as_str().unwrap_or("unknown"),
                parse_quantity(&receipt["blockNumber"]).unwrap_or(0),
                !evidence.is_empty(),
            ),
        );
        self.deposits[index_of(direction)] += 1;
        self.pending.push(PendingWithdrawal {
            direction,
            nonce,
            recipient: depositor,
            amount,
            deposited_at: Instant::now(),
            reported_slow: false,
        });
        Ok(())
    }

    /// Reads the destination vaults and logs each deposit that they paid since the last call.
    pub fn check_withdrawals(&mut self) {
        let mut still_pending = Vec::new();
        for mut entry in std::mem::take(&mut self.pending) {
            let destination = self.destination(entry.direction);
            let destination_chain_id = destination.record.chain_id;
            match destination.claimed(entry.nonce) {
                Ok(true) => {
                    let balance = destination
                        .token_balance(entry.recipient)
                        .map_or_else(|_| "unknown".to_string(), base_units_text);
                    self.completed[index_of(entry.direction)] += 1;
                    log(
                        "info",
                        "withdrawal_completed",
                        &format!(
                            "direction={} destination_chain={} recipient={:#x} amount_tokens={} nonce={:#x} seconds={} recipient_balance_tokens={balance} completed_a_to_b={} completed_b_to_a={}",
                            entry.direction.as_str(),
                            destination_chain_id,
                            entry.recipient,
                            base_units_text(entry.amount),
                            entry.nonce,
                            entry.deposited_at.elapsed().as_secs(),
                            self.completed[0],
                            self.completed[1],
                        ),
                    );
                }
                Ok(false) => {
                    if !entry.reported_slow && entry.deposited_at.elapsed() > SLOW_WITHDRAWAL {
                        entry.reported_slow = true;
                        log(
                            "warn",
                            "withdrawal_slow",
                            &format!(
                                "direction={} nonce={:#x} seconds={}",
                                entry.direction.as_str(),
                                entry.nonce,
                                entry.deposited_at.elapsed().as_secs()
                            ),
                        );
                    }
                    still_pending.push(entry);
                }
                Err(error) => {
                    log(
                        "warn",
                        "withdrawal_check_failed",
                        &format!("nonce={:#x} error={error:?}", entry.nonce),
                    );
                    still_pending.push(entry);
                }
            }
        }
        self.pending = still_pending;
    }

    /// Loops forever: one deposit, alternating the direction, then a random wait in which it watches the vaults.
    pub fn run_forever(&mut self) -> ! {
        let mut direction = Direction::AToB;
        loop {
            if let Err(error) = self.deposit_once(direction) {
                log(
                    "warn",
                    "deposit_failed",
                    &format!("direction={} error={error:?}", direction.as_str()),
                );
            }
            direction = direction.other();
            let wait = self.random.between(
                self.settings.minimum_wait_seconds,
                self.settings.maximum_wait_seconds,
            );
            for _ in 0..wait.max(1) {
                self.check_withdrawals();
                std::thread::sleep(Duration::from_secs(1));
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Claim: the random generator stays inside its bounds, reaches both ends, and a fixed seed repeats.
    /// Why it matters: a deposit of zero tokens reverts, and a wait that leaves its bounds hides a bug in the loop.
    #[test]
    fn random_numbers_stay_in_bounds_and_repeat_for_one_seed() {
        let mut first = Random::seeded(7);
        let mut second = Random::seeded(7);
        let mut seen = std::collections::BTreeSet::new();
        for _ in 0..2_000 {
            let value = first.between(1, 5);
            assert!((1..=5).contains(&value));
            assert_eq!(value, second.between(1, 5));
            seen.insert(value);
        }
        assert_eq!(seen.len(), 5, "every value from 1 to 5 appears");
        assert_eq!(Random::seeded(0).between(3, 3), 3);
        assert_eq!(
            Random::seeded(9).between(8, 2),
            8,
            "a bad range gives the low end"
        );
    }

    /// Claim: amounts print as tokens with two decimals, from hundredths and from the smallest unit.
    /// Why it matters: the log is the evidence that a reader checks by eye; 0.05 must not print as 0.5.
    #[test]
    fn amounts_print_with_two_decimals() {
        assert_eq!(tokens_text(5), "0.05");
        assert_eq!(tokens_text(37), "0.37");
        assert_eq!(tokens_text(100), "1.00");
        assert_eq!(base_units_text(U256::from(37u128 * CENTI_TOKEN)), "0.37");
        assert_eq!(base_units_text(U256::from(10u128.pow(18) * 12)), "12.00");
    }

    /// Claim: the nonce comes from the deposit log and not from another log of the receipt.
    /// Why it matters: a receipt also holds token transfer logs; reading the wrong one gives a nonce that never pays.
    #[test]
    fn the_nonce_comes_from_the_deposit_log() {
        use alloy_sol_types::SolEvent;
        use lc_core::abi::DepositInitiated;
        let nonce = B256::repeat_byte(0x42);
        let event = DepositInitiated {
            token: Address::repeat_byte(1),
            sender: Address::repeat_byte(2),
            recipient: Address::repeat_byte(3),
            amount: U256::from(5u8),
            nonce,
            targetChainId: 369,
            destinationVault: Address::repeat_byte(4),
            destinationToken: Address::repeat_byte(5),
        };
        let encoded = event.encode_log_data();
        let topics: Vec<String> = encoded.topics().iter().map(|t| format!("{t:#x}")).collect();
        let receipt = json!({ "logs": [
            { "topics": [format!("{:#x}", B256::repeat_byte(9))], "data": "0x" },
            { "topics": topics, "data": format!("0x{}", hex::encode(encoded.data.as_ref())) },
        ]});
        assert_eq!(deposit_nonce_of(&receipt).unwrap(), nonce);
        assert!(deposit_nonce_of(&json!({ "logs": [] })).is_err());
    }
}
