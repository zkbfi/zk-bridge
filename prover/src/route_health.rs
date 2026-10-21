//! `route-health`: can this route still deliver a deposit made now? (Finding HB-02, window 2.)
//!
//! A route is a light client and a pair of vaults. The program of the light client knows a fixed set of
//! source-chain fork versions. When the source chain activates another fork, the light client cannot advance, and
//! every deposit it never anchored is stuck for good. A deposit made in roughly the last three epochs before the
//! activation is already stuck, because finality trails the head by about two epochs and the old program rejects
//! the update that would finalize those epochs.
//!
//! The fork schedule is not on chain. Only an off-chain tool can see a fork coming. This module is that tool.
//!
//! - [`route_status`] is a pure function. It takes data that is already fetched and decides one [`Level`]. All
//!   decision logic is there. An interface that offers deposits should copy it rule for rule.
//! - [`fetch_beacon_facts`] reads the genesis time, the fork schedule and the head slot from a beacon API.
//! - [`read_gate_observation`] reads the deposit gate of a vault. Every hardened vault has one.
//! - [`run`] does the work for every route of a configuration and renders the answer.
//!
//! The rules, from the most severe level down:
//!
//! 1. `SEALED`: the deposit gate of the source vault is sealed. Every deposit reverts, for good.
//! 2. `STOP`: a fork the route does not support is already active, or activates within the margin.
//!    The margin is the larger of the configured seconds and three epochs. It is never below three epochs.
//! 3. `STALE`: the light client head lags the source chain head by more than the configured number of epochs.
//! 4. `WARN`: a fork the route does not support is scheduled, and it lies beyond the margin.
//! 5. `OPEN`: none of the above.
//!
//! A schedule entry whose epoch is [`NEVER_EPOCH`] is not scheduled. The beacon API uses that value for "never".
//! PulseChain lists Deneb with version `0xffffffff` and this epoch. Only the epoch decides: an entry with a real
//! epoch counts as scheduled, whatever its version.

use crate::chain::ChainClient;
use crate::config::{BeaconKind, ChainConfig, Config, RouteName};
use crate::contracts::{GateVersionsContract, LightClientContract, VaultContract};
use crate::error::{Error, Result};
use crate::gate::read_gate_status;
use crate::light_client::ChainKind;
use crate::rpc::{HttpClient, HttpGet, HttpRpc};
use alloy_primitives::{hex, Address};
use serde_json::{json, Value};

/// The epoch that the beacon API reports for a fork that is not scheduled.
pub const NEVER_EPOCH: u64 = u64::MAX;
/// The smallest margin, in epochs. A configured margin below this value is raised to it.
pub const MINIMUM_MARGIN_EPOCHS: u64 = 3;
/// The default margin in seconds: one hour.
pub const DEFAULT_MARGIN_SECONDS: u64 = 3_600;
/// The default number of epochs the light client head may lag the source chain head.
pub const DEFAULT_STALE_EPOCHS: u64 = 64;
/// A scheduled unsupported fork farther away than this is only a warning. The reason text says so.
pub const FAR_AHEAD_SECONDS: u64 = 86_400;

/// The status of a route. The order of the variants is the order of severity, least severe first.
#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord)]
pub enum Level {
    /// Deposits are safe to offer.
    Open,
    /// An unsupported fork is scheduled, but it lies beyond the margin.
    Warn,
    /// The light client head lags too far.
    Stale,
    /// An unsupported fork is active or inside the margin.
    Stop,
    /// The gate is sealed.
    Sealed,
}

impl Level {
    /// The upper-case name that the output shows.
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Open => "OPEN",
            Self::Warn => "WARN",
            Self::Stale => "STALE",
            Self::Stop => "STOP",
            Self::Sealed => "SEALED",
        }
    }

    /// Whether a script must refuse to deposit. This is every level except `OPEN` and `WARN`.
    pub fn refuses_deposits(self) -> bool {
        self > Self::Warn
    }
}

/// One entry of the fork schedule of the beacon API.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct ScheduleEntry {
    /// `current_version` of the entry.
    pub version: [u8; 4],
    /// The activation epoch. [`NEVER_EPOCH`] means not scheduled.
    pub epoch: u64,
}

/// What the deposit gate of the source vault says.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct GateObservation {
    /// The address of the gate.
    pub gate: Address,
    /// `Enforcing`, `DetectBeaconRoots`, or `Unknown(n)`.
    pub mode: String,
    /// Whether the gate applies its rules now.
    pub enforcing: bool,
    /// Whether the gate is sealed.
    pub sealed: bool,
    /// The last epoch confirmed by a proof.
    pub confirmed_epoch: Option<u64>,
    /// The versions the gate supports.
    pub supported_versions: Vec<[u8; 4]>,
}

/// The limits of the decision.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct HealthSettings {
    /// The configured margin in seconds. [`route_status`] raises it to three epochs when it is lower.
    pub margin_seconds: u64,
    /// The most epochs the light client head may lag.
    pub stale_epochs: u64,
}

impl Default for HealthSettings {
    fn default() -> Self {
        Self { margin_seconds: DEFAULT_MARGIN_SECONDS, stale_epochs: DEFAULT_STALE_EPOCHS }
    }
}

/// Everything [`route_status`] needs. The caller fetches it. The function does no input or output.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct RouteInputs {
    /// The wall clock, in seconds since the Unix epoch.
    pub now: u64,
    /// The genesis time of the source beacon chain.
    pub genesis_time: u64,
    /// Seconds per slot of the source beacon chain.
    pub seconds_per_slot: u64,
    /// Slots per epoch of the source beacon chain.
    pub slots_per_epoch: u64,
    /// The fork schedule of the source beacon chain, in any order.
    pub schedule: Vec<ScheduleEntry>,
    /// The versions the light-client program knows. It lists only forks the program can verify.
    pub program_versions: Vec<[u8; 4]>,
    /// The deposit gate of the source vault, when the vault has one.
    pub gate: Option<GateObservation>,
    /// The head slot of the destination light client for this source chain.
    pub light_client_head_slot: u64,
    /// The head slot of the source beacon chain.
    pub source_head_slot: u64,
    /// The limits.
    pub settings: HealthSettings,
}

/// The first fork that the route does not support.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct ForkFinding {
    /// The fork version.
    pub version: [u8; 4],
    /// The activation epoch.
    pub activation_epoch: u64,
    /// The activation time, in seconds since the Unix epoch.
    pub activation_time: u64,
    /// Seconds until activation. It is zero or negative for an active fork.
    pub seconds_remaining: i64,
}

/// The decision, with the numbers behind it.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct RouteStatus {
    /// The level.
    pub level: Level,
    /// Why the level is what it is. It names the most severe finding.
    pub reason: String,
    /// The other findings, most severe first.
    pub other_findings: Vec<String>,
    /// The first unsupported fork that is active or scheduled, if any.
    pub fork: Option<ForkFinding>,
    /// The current epoch from the wall clock.
    pub current_epoch: u64,
    /// The margin used, in seconds, after the raise to three epochs.
    pub margin_seconds: u64,
    /// How many whole epochs the light client head lags the source chain head.
    pub head_lag_epochs: u64,
}

/// Formats a fork version as `0x` and eight hex digits.
pub fn format_version(version: [u8; 4]) -> String {
    format!("0x{}", hex::encode(version))
}

fn is_supported(version: [u8; 4], inputs: &RouteInputs) -> bool {
    let known_to_program = inputs.program_versions.contains(&version);
    let known_to_gate = inputs.gate.as_ref().is_none_or(|gate| gate.supported_versions.contains(&version));
    known_to_program && known_to_gate
}

fn clamp_to_i64(value: i128) -> i64 {
    i64::try_from(value).unwrap_or(if value < 0 { i64::MIN } else { i64::MAX })
}

/// The unsupported fork that comes first: the active one, or else the next scheduled one.
///
/// Only the newest active entry counts among the entries that are already active. The older ones are history.
/// Where two entries share an epoch, the later one in the schedule wins.
fn first_unsupported_fork(inputs: &RouteInputs, current_epoch: u64, epoch_seconds: u64) -> Option<ForkFinding> {
    let mut scheduled: Vec<ScheduleEntry> = inputs.schedule.iter().copied().filter(|entry| entry.epoch != NEVER_EPOCH).collect();
    scheduled.sort_by_key(|entry| entry.epoch);
    let newest_active = scheduled.iter().rposition(|entry| entry.epoch <= current_epoch);
    let relevant = scheduled.iter().enumerate().filter(|(index, entry)| {
        let is_future = entry.epoch > current_epoch;
        is_future || Some(*index) == newest_active
    });
    let (_, entry) = relevant.map(|(index, entry)| (index, *entry)).find(|(_, entry)| !is_supported(entry.version, inputs))?;
    let activation_time = inputs.genesis_time.saturating_add(entry.epoch.saturating_mul(epoch_seconds));
    Some(ForkFinding {
        version: entry.version,
        activation_epoch: entry.epoch,
        activation_time,
        seconds_remaining: clamp_to_i64(i128::from(activation_time) - i128::from(inputs.now)),
    })
}

fn describe_duration(seconds: u64) -> String {
    let (hours, minutes) = (seconds / 3_600, seconds % 3_600 / 60);
    match (seconds / 86_400, hours) {
        (0, 0) => format!("{minutes} minutes"),
        (0, _) => format!("{hours} hours {minutes} minutes"),
        (days, _) => format!("{days} days {} hours", hours % 24),
    }
}

fn fork_finding_message(fork: &ForkFinding, margin_seconds: u64) -> (Level, String) {
    let version = format_version(fork.version);
    if fork.seconds_remaining <= 0 {
        let reason = format!("the source chain fork {version} is active (epoch {}) and the route does not support it", fork.activation_epoch);
        return (Level::Stop, reason);
    }
    let remaining = fork.seconds_remaining.unsigned_abs();
    let timing = format!("activates at epoch {} in {}", fork.activation_epoch, describe_duration(remaining));
    if remaining <= margin_seconds {
        let reason = format!("the source chain fork {version} {timing}, inside the margin of {}, and the route does not support it", describe_duration(margin_seconds));
        return (Level::Stop, reason);
    }
    let horizon = if remaining > FAR_AHEAD_SECONDS { "more than 24 hours ahead" } else { "within 24 hours, beyond the margin" };
    (Level::Warn, format!("the source chain fork {version} {timing} ({horizon}), and the route does not support it"))
}

/// Decides the status of a route from fetched data. It reads no clock and no network.
///
/// The most severe finding wins: sealed, then stop, then stale, then warn, then open. The other findings stay in
/// [`RouteStatus::other_findings`]. See the module documentation for each rule.
pub fn route_status(inputs: &RouteInputs) -> RouteStatus {
    let slots_per_epoch = inputs.slots_per_epoch.max(1);
    let epoch_seconds = inputs.seconds_per_slot.max(1).saturating_mul(slots_per_epoch);
    let current_epoch = inputs.now.saturating_sub(inputs.genesis_time) / epoch_seconds;
    let margin_seconds = inputs.settings.margin_seconds.max(MINIMUM_MARGIN_EPOCHS.saturating_mul(epoch_seconds));
    let lag_slots = inputs.source_head_slot.saturating_sub(inputs.light_client_head_slot);
    let head_lag_epochs = lag_slots / slots_per_epoch;
    let fork = first_unsupported_fork(inputs, current_epoch, epoch_seconds);

    let mut findings: Vec<(Level, String)> = Vec::new();
    if inputs.gate.as_ref().is_some_and(|gate| gate.sealed) {
        findings.push((Level::Sealed, "the deposit gate of the source vault is sealed: every deposit reverts".to_string()));
    }
    if let Some(fork) = &fork {
        findings.push(fork_finding_message(fork, margin_seconds));
    }
    if lag_slots > inputs.settings.stale_epochs.saturating_mul(slots_per_epoch) {
        findings.push((
            Level::Stale,
            format!(
                "the light client head lags the source chain head by {head_lag_epochs} epochs, and the limit is {}",
                inputs.settings.stale_epochs
            ),
        ));
    }
    findings.sort_by(|left, right| right.0.cmp(&left.0));
    let mut ordered = findings.into_iter();
    let (level, reason) = ordered.next().unwrap_or((Level::Open, "no unsupported fork is scheduled, the gate is not sealed and the light client head is fresh".to_string()));
    let other_findings = ordered.map(|(_, text)| text).collect();
    RouteStatus { level, reason, other_findings, fork, current_epoch, margin_seconds, head_lag_epochs }
}

// ---------------------------------------------------------------------------------------------------------------
// Reading the beacon API
// ---------------------------------------------------------------------------------------------------------------

/// What the beacon API of the source chain says.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct BeaconFacts {
    /// `genesis_time`.
    pub genesis_time: u64,
    /// The fork schedule.
    pub schedule: Vec<ScheduleEntry>,
    /// The slot of the head block.
    pub head_slot: u64,
}

fn get_json(client: &dyn HttpGet, path: &str) -> Result<Value> {
    let response = client.get(path, "application/json")?;
    if response.status != 200 {
        return Err(Error::Beacon(format!("GET {path}: status {}", response.status)));
    }
    serde_json::from_slice(&response.body).map_err(|error| Error::Malformed(format!("GET {path}: {error}")))
}

fn parse_number(value: &Value, what: &str) -> Result<u64> {
    let parsed = match value {
        Value::String(text) => text.parse().ok(),
        Value::Number(number) => number.as_u64(),
        _ => None,
    };
    parsed.ok_or_else(|| Error::Malformed(format!("{what}: expected an unsigned number, got {value}")))
}

fn parse_version(value: &Value) -> Result<[u8; 4]> {
    let text = value.as_str().ok_or_else(|| Error::Malformed(format!("fork version: expected text, got {value}")))?;
    let bytes = hex::decode(text).map_err(|error| Error::Malformed(format!("fork version {text}: {error}")))?;
    bytes.try_into().map_err(|_| Error::Malformed(format!("fork version {text}: expected 4 bytes")))
}

/// Parses the answer of `GET /eth/v1/config/fork_schedule`.
///
/// # Errors
/// `Error::Malformed` when the answer lacks `data`, or an entry has no valid `current_version` or `epoch`.
pub fn parse_fork_schedule(answer: &Value) -> Result<Vec<ScheduleEntry>> {
    let entries = answer["data"].as_array().ok_or_else(|| Error::Malformed("fork_schedule: no data array".into()))?;
    entries
        .iter()
        .map(|entry| {
            Ok(ScheduleEntry { version: parse_version(&entry["current_version"])?, epoch: parse_number(&entry["epoch"], "fork epoch")? })
        })
        .collect()
}

/// Parses the answer of `GET /eth/v1/beacon/genesis`.
///
/// # Errors
/// `Error::Malformed` when `data.genesis_time` is missing or not a number.
pub fn parse_genesis_time(answer: &Value) -> Result<u64> {
    parse_number(&answer["data"]["genesis_time"], "genesis_time")
}

/// Parses the answer of `GET /eth/v1/beacon/headers/head`.
///
/// # Errors
/// `Error::Malformed` when `data.header.message.slot` is missing or not a number.
pub fn parse_head_slot(answer: &Value) -> Result<u64> {
    parse_number(&answer["data"]["header"]["message"]["slot"], "head slot")
}

/// Reads the genesis time, the fork schedule and the head slot.
///
/// # Errors
/// `Error::Beacon` for a status other than 200, `Error::Http` without an answer, `Error::Malformed` for a bad body.
pub fn fetch_beacon_facts(client: &dyn HttpGet) -> Result<BeaconFacts> {
    Ok(BeaconFacts {
        genesis_time: parse_genesis_time(&get_json(client, "/eth/v1/beacon/genesis")?)?,
        schedule: parse_fork_schedule(&get_json(client, "/eth/v1/config/fork_schedule")?)?,
        head_slot: parse_head_slot(&get_json(client, "/eth/v1/beacon/headers/head")?)?,
    })
}

// ---------------------------------------------------------------------------------------------------------------
// Reading the chains
// ---------------------------------------------------------------------------------------------------------------

/// The versions the light-client program verifies: the entries of its fork table that are scheduled.
/// An entry at the never epoch (Gloas on Ethereum) is a placeholder, not a supported fork.
pub fn program_versions(kind: ChainKind) -> Vec<[u8; 4]> {
    kind.spec().fork_schedule.iter().filter(|entry| entry.epoch != NEVER_EPOCH).map(|entry| entry.fork_version).collect()
}

fn mode_name(mode: u8) -> String {
    match mode {
        0 => "Enforcing".to_string(),
        1 => "DetectBeaconRoots".to_string(),
        other => format!("Unknown({other})"),
    }
}

/// Reads the deposit gate of a vault.
///
/// The hardened vault's constructor refuses a zero gate, so a revert of `depositGate()` or a zero address means the
/// node or the configured address is wrong. Both are errors: a route that cannot be read is never reported as open.
/// The gate reads are `enforcing`, `isSealed`, `confirmedEpoch` and `currentEpoch` (through `gate.rs`), and
/// `supportedVersions` and `mode` (added to `contracts.rs` for this command).
///
/// # Errors
/// Any read error, including a revert of `depositGate()` and a zero gate address.
pub fn read_gate_observation(client: &ChainClient, vault: Address) -> Result<GateObservation> {
    let gate = client.view(vault, VaultContract::depositGateCall {})?;
    if gate == Address::ZERO {
        return Err(Error::Config(format!("vault {vault:#x} reports a zero deposit gate; a hardened vault always has one")));
    }
    let status = read_gate_status(client, gate)?;
    let versions = client.view(gate, GateVersionsContract::supportedVersionsCall {})?;
    Ok(GateObservation {
        gate,
        mode: mode_name(client.view(gate, GateVersionsContract::modeCall {})?),
        enforcing: status.enforcing,
        sealed: status.sealed,
        confirmed_epoch: status.confirmed_epoch,
        supported_versions: versions.iter().map(|entry| entry.version.0).collect(),
    })
}

// ---------------------------------------------------------------------------------------------------------------
// The report
// ---------------------------------------------------------------------------------------------------------------

/// The decision for one route, with the inputs that matter to a reader.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct RouteReport {
    /// `a_to_b` or `b_to_a`.
    pub route: String,
    /// The name of the source chain.
    pub source_chain: String,
    /// The decision.
    pub status: RouteStatus,
    /// The head slot of the destination light client.
    pub light_client_head_slot: u64,
    /// The head slot of the source beacon chain.
    pub source_head_slot: u64,
    /// The gate, when the source vault has one.
    pub gate: Option<GateObservation>,
}

/// Converts days since 1970-01-01 to a civil date (proleptic Gregorian). Howard Hinnant's algorithm.
fn civil_from_days(days: i64) -> (i64, i64, i64) {
    let shifted = days + 719_468;
    let era = shifted.div_euclid(146_097);
    let day_of_era = shifted.rem_euclid(146_097);
    let year_of_era = (day_of_era - day_of_era / 1_460 + day_of_era / 36_524 - day_of_era / 146_096) / 365;
    let day_of_year = day_of_era - (365 * year_of_era + year_of_era / 4 - year_of_era / 100);
    let month_index = (5 * day_of_year + 2) / 153;
    let day = day_of_year - (153 * month_index + 2) / 5 + 1;
    let month = if month_index < 10 { month_index + 3 } else { month_index - 9 };
    let year = year_of_era + era * 400 + i64::from(month <= 2);
    (year, month, day)
}

/// Formats Unix seconds as `YYYY-MM-DDTHH:MM:SSZ` (UTC).
pub fn format_utc(unix_seconds: u64) -> String {
    let seconds = i64::try_from(unix_seconds).unwrap_or(i64::MAX / 2).min(253_402_300_799);
    let (year, month, day) = civil_from_days(seconds.div_euclid(86_400));
    let in_day = seconds.rem_euclid(86_400);
    format!("{year:04}-{month:02}-{day:02}T{:02}:{:02}:{:02}Z", in_day / 3_600, in_day % 3_600 / 60, in_day % 60)
}

impl RouteReport {
    /// One line of `key=value` pairs for a person or a log.
    pub fn human_line(&self) -> String {
        let status = &self.status;
        let mut line = format!(
            "route={} source_chain={} status={} reason=\"{}\"",
            self.route,
            self.source_chain,
            status.level.as_str(),
            status.reason.replace('"', "'")
        );
        if let Some(fork) = &status.fork {
            line.push_str(&format!(
                " fork_version={} activation_epoch={} activation_time={} seconds_remaining={}",
                format_version(fork.version),
                fork.activation_epoch,
                format_utc(fork.activation_time),
                fork.seconds_remaining
            ));
        }
        line.push_str(&format!(
            " current_epoch={} margin_seconds={} light_client_head_slot={} source_head_slot={} head_lag_epochs={}",
            status.current_epoch, status.margin_seconds, self.light_client_head_slot, self.source_head_slot, status.head_lag_epochs
        ));
        match &self.gate {
            Some(gate) => line.push_str(&format!(
                " gate={:#x} gate_mode={} gate_enforcing={} gate_sealed={} gate_confirmed_epoch={}",
                gate.gate,
                gate.mode,
                gate.enforcing,
                gate.sealed,
                gate.confirmed_epoch.map_or("none".to_string(), |epoch| epoch.to_string())
            )),
            None => line.push_str(" gate=none"),
        }
        line
    }

    /// The JSON object for scripts. Epochs and slots are numbers. A fork that is not found is `null`.
    pub fn to_json(&self) -> Value {
        let status = &self.status;
        let fork = status.fork.as_ref().map(|fork| {
            json!({
                "version": format_version(fork.version),
                "activation_epoch": fork.activation_epoch,
                "activation_time": fork.activation_time,
                "activation_time_utc": format_utc(fork.activation_time),
                "seconds_remaining": fork.seconds_remaining,
            })
        });
        let gate = self.gate.as_ref().map(|gate| {
            json!({
                "address": format!("{:#x}", gate.gate),
                "mode": gate.mode,
                "enforcing": gate.enforcing,
                "sealed": gate.sealed,
                "confirmed_epoch": gate.confirmed_epoch,
                "supported_versions": gate.supported_versions.iter().copied().map(format_version).collect::<Vec<_>>(),
            })
        });
        json!({
            "route": self.route,
            "source_chain": self.source_chain,
            "status": status.level.as_str(),
            "refuses_deposits": status.level.refuses_deposits(),
            "reason": status.reason,
            "other_findings": status.other_findings,
            "fork": fork,
            "current_epoch": status.current_epoch,
            "margin_seconds": status.margin_seconds,
            "light_client_head_slot": self.light_client_head_slot,
            "source_head_slot": self.source_head_slot,
            "head_lag_epochs": status.head_lag_epochs,
            "gate": gate,
        })
    }
}

/// How `route-health` prints.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum OutputFormat {
    /// One line per route.
    Human,
    /// One JSON array with one object per route.
    Json,
}

/// Renders the reports. In JSON the output is one array, so a script parses it once.
pub fn render(reports: &[RouteReport], format: OutputFormat) -> String {
    match format {
        OutputFormat::Human => reports.iter().map(|report| format!("{}\n", report.human_line())).collect(),
        OutputFormat::Json => {
            let objects: Vec<Value> = reports.iter().map(RouteReport::to_json).collect();
            format!("{}\n", serde_json::to_string_pretty(&objects).unwrap_or_else(|_| "[]".to_string()))
        }
    }
}

/// The process exit code for a set of reports: 0 when no route refuses deposits, else 2.
/// (An error of the command itself exits with 1.)
pub fn exit_code(reports: &[RouteReport]) -> i32 {
    if reports.iter().any(|report| report.status.level.refuses_deposits()) {
        return 2;
    }
    0
}

/// Builds the inputs of one route from data that is already read.
pub fn assemble_inputs(
    kind: ChainKind,
    beacon: &BeaconFacts,
    gate: Option<GateObservation>,
    light_client_head_slot: u64,
    now: u64,
    settings: HealthSettings,
) -> RouteInputs {
    let spec = kind.spec();
    RouteInputs {
        now,
        genesis_time: beacon.genesis_time,
        seconds_per_slot: spec.seconds_per_slot,
        slots_per_epoch: spec.slots_per_epoch,
        schedule: beacon.schedule.clone(),
        program_versions: program_versions(kind),
        gate,
        light_client_head_slot,
        source_head_slot: beacon.head_slot,
        settings,
    }
}

fn connect(chain: &ChainConfig) -> Result<ChainClient> {
    ChainClient::connect(&chain.name, chain.chain_id, Box::new(HttpRpc::new(&chain.rpc_url)), None)
}

/// Reads and decides one route. Deposits are made on the source chain. The light client sits on the destination.
fn check_route(config: &Config, route: RouteName, now: u64, settings: HealthSettings) -> Result<RouteReport> {
    let source = config.source_of(route);
    let destination = config.destination_of(route);
    if source.beacon.kind != BeaconKind::Http {
        return Err(Error::Config(format!("{}.beacon.kind: route-health needs a beacon API (kind = \"http\")", source.name)));
    }
    let url = source.beacon.url.as_deref().filter(|url| !url.is_empty());
    let url = url.ok_or_else(|| Error::Config(format!("{}.beacon.url: missing", source.name)))?;
    let kind = source.chain_kind()?;
    let beacon = fetch_beacon_facts(&HttpClient::new(url))?;
    let gate = Some(read_gate_observation(&connect(source)?, source.vault_address()?)?);
    let head = connect(destination)?.view(destination.light_client_address()?, LightClientContract::headCall {})?;
    let inputs = assemble_inputs(kind, &beacon, gate, head, now, settings);
    Ok(RouteReport {
        route: route.as_str().to_string(),
        source_chain: source.name.clone(),
        status: route_status(&inputs),
        light_client_head_slot: head,
        source_head_slot: beacon.head_slot,
        gate: inputs.gate,
    })
}

fn unix_now() -> Result<u64> {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|elapsed| elapsed.as_secs())
        .map_err(|error| Error::Usage(format!("the clock is before 1970: {error}")))
}

/// Runs `route-health` for every route of the configuration and writes the answer to `out`.
/// Returns the exit code: 0 when every route is `OPEN` or `WARN`, else 2.
///
/// # Errors
/// Any read error. A route that cannot be read is never reported as open.
pub fn run(config: &Config, settings: HealthSettings, format: OutputFormat, out: &mut dyn std::io::Write) -> Result<i32> {
    let now = unix_now()?;
    let reports = config.routes.iter().map(|route| check_route(config, *route, now, settings)).collect::<Result<Vec<_>>>()?;
    out.write_all(render(&reports, format).as_bytes()).map_err(|error| Error::Usage(error.to_string()))?;
    Ok(exit_code(&reports))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::rpc::HttpResponse;
    use std::collections::HashMap;

    const GENESIS: u64 = 1_000_000;
    const SECONDS_PER_SLOT: u64 = 12;
    const SLOTS_PER_EPOCH: u64 = 32;
    const EPOCH_SECONDS: u64 = 384;
    const HOUR: u64 = 3_600;
    const KNOWN: [u8; 4] = [4, 0, 0, 0];
    const UNKNOWN: [u8; 4] = [9, 0, 0, 0];
    /// The epoch the clock shows in most tests.
    const NOW_EPOCH: u64 = 1_000;

    fn now_at_epoch(epoch: u64) -> u64 {
        GENESIS + epoch * EPOCH_SECONDS
    }

    fn inputs() -> RouteInputs {
        RouteInputs {
            now: now_at_epoch(NOW_EPOCH),
            genesis_time: GENESIS,
            seconds_per_slot: SECONDS_PER_SLOT,
            slots_per_epoch: SLOTS_PER_EPOCH,
            schedule: vec![ScheduleEntry { version: KNOWN, epoch: 10 }],
            program_versions: vec![KNOWN],
            gate: None,
            light_client_head_slot: NOW_EPOCH * 32,
            source_head_slot: NOW_EPOCH * 32,
            settings: HealthSettings { margin_seconds: HOUR, stale_epochs: 64 },
        }
    }

    fn with_fork_in(seconds: u64) -> RouteInputs {
        let mut value = inputs();
        value.schedule.push(ScheduleEntry { version: UNKNOWN, epoch: NOW_EPOCH + seconds / EPOCH_SECONDS });
        value
    }

    fn gate(sealed: bool) -> GateObservation {
        GateObservation {
            gate: Address::ZERO,
            mode: "Enforcing".into(),
            enforcing: true,
            sealed,
            confirmed_epoch: Some(NOW_EPOCH),
            supported_versions: vec![KNOWN],
        }
    }

    /// Claim: with no unsupported fork, a fresh head and an unsealed gate, the route is OPEN.
    /// Why it matters: this is the only state in which an interface may offer deposits without a caveat.
    #[test]
    fn no_unsupported_fork_is_open() {
        let mut value = inputs();
        value.gate = Some(gate(false));
        let status = route_status(&value);
        assert_eq!(status.level, Level::Open);
        assert!(status.fork.is_none());
        assert!(!status.level.refuses_deposits());
        assert_eq!(status.current_epoch, NOW_EPOCH);
    }

    /// Claim: an unsupported fork more than 24 hours ahead gives WARN, with the version, epoch, time and remaining time.
    /// Why it matters: the interface shows the date long before the deposit window closes.
    #[test]
    fn a_fork_beyond_24_hours_warns() {
        let status = route_status(&with_fork_in(48 * HOUR));
        assert_eq!(status.level, Level::Warn);
        assert!(status.reason.contains("more than 24 hours ahead"), "{}", status.reason);
        let fork = status.fork.expect("fork");
        assert_eq!(fork.version, UNKNOWN);
        assert_eq!(fork.activation_epoch, NOW_EPOCH + 48 * HOUR / EPOCH_SECONDS);
        assert_eq!(fork.activation_time, GENESIS + fork.activation_epoch * EPOCH_SECONDS);
        assert_eq!(fork.seconds_remaining, (fork.activation_time - inputs().now) as i64);
        assert!(!status.level.refuses_deposits(), "a warning does not block");
    }

    /// Claim: a fork between the margin and 24 hours away is WARN too, and the reason says it is within 24 hours.
    /// Why it matters: the rule is "stop inside the margin", not "stop inside a day".
    #[test]
    fn a_fork_between_the_margin_and_24_hours_warns() {
        let status = route_status(&with_fork_in(6 * HOUR));
        assert_eq!(status.level, Level::Warn);
        assert!(status.reason.contains("within 24 hours, beyond the margin"), "{}", status.reason);
    }

    /// Claim: a fork inside the margin is STOP.
    /// Why it matters: deposits in the last epochs before the fork are stranded.
    #[test]
    fn a_fork_inside_the_margin_stops() {
        let status = route_status(&with_fork_in(HOUR / 2));
        assert_eq!(status.level, Level::Stop);
        assert!(status.level.refuses_deposits());
    }

    /// Claim: a fork exactly one margin away is STOP, and one epoch farther is WARN.
    /// Why it matters: the boundary is "within the margin", inclusive. An off-by-one here opens the stranding window.
    #[test]
    fn the_margin_boundary_is_inclusive() {
        let margin_epochs = 10;
        let mut value = inputs();
        value.settings.margin_seconds = margin_epochs * EPOCH_SECONDS;
        value.schedule.push(ScheduleEntry { version: UNKNOWN, epoch: NOW_EPOCH + margin_epochs });
        assert_eq!(route_status(&value).level, Level::Stop, "exactly at the margin");
        value.schedule[1].epoch += 1;
        assert_eq!(route_status(&value).level, Level::Warn, "one epoch beyond the margin");
    }

    /// Claim: a fork that is already active and unsupported is STOP, and its time remaining is not positive.
    /// Why it matters: after activation the light client can no longer advance.
    #[test]
    fn an_active_unsupported_fork_stops() {
        let mut value = inputs();
        value.schedule.push(ScheduleEntry { version: UNKNOWN, epoch: NOW_EPOCH - 5 });
        let status = route_status(&value);
        assert_eq!(status.level, Level::Stop);
        assert!(status.reason.contains("is active"), "{}", status.reason);
        assert!(status.fork.expect("fork").seconds_remaining <= 0);
    }

    /// Claim: a gate that is sealed gives SEALED, whatever the schedule says.
    /// Why it matters: a sealed gate reverts every deposit for good.
    #[test]
    fn a_sealed_gate_is_sealed() {
        let mut value = inputs();
        value.gate = Some(gate(true));
        let status = route_status(&value);
        assert_eq!(status.level, Level::Sealed);
        assert!(status.level.refuses_deposits());
    }

    /// Claim: a head that lags more than the limit gives STALE, and a lag of exactly the limit does not.
    /// Why it matters: the boundary decides whether a slow light client blocks deposits.
    #[test]
    fn a_stale_head_is_stale() {
        let mut value = inputs();
        value.light_client_head_slot = value.source_head_slot - 64 * SLOTS_PER_EPOCH;
        assert_eq!(route_status(&value).level, Level::Open, "exactly the limit");
        value.light_client_head_slot -= 1;
        let status = route_status(&value);
        assert_eq!(status.level, Level::Stale);
        assert!(status.level.refuses_deposits());
        assert_eq!(status.head_lag_epochs, 64);
    }

    /// Claim: a head slot ahead of the source head (clock skew between nodes) counts as no lag.
    /// Why it matters: an unsigned subtraction here would wrap and report a huge lag.
    #[test]
    fn a_head_ahead_of_the_source_is_not_stale() {
        let mut value = inputs();
        value.light_client_head_slot = value.source_head_slot + 500;
        let status = route_status(&value);
        assert_eq!(status.level, Level::Open);
        assert_eq!(status.head_lag_epochs, 0);
    }

    /// Claim: a margin configured below three epochs is raised to three epochs, and the result is STOP just inside them.
    /// Why it matters: the contract says the margin is never below three epochs. A zero margin would offer deposits
    /// in the stranding window.
    #[test]
    fn a_small_margin_is_raised_to_three_epochs() {
        let mut value = inputs();
        value.settings.margin_seconds = 0;
        value.schedule.push(ScheduleEntry { version: UNKNOWN, epoch: NOW_EPOCH + 3 });
        let status = route_status(&value);
        assert_eq!(status.margin_seconds, 3 * EPOCH_SECONDS);
        assert_eq!(status.level, Level::Stop, "three epochs ahead is inside the minimum margin");
        value.schedule[1].epoch = NOW_EPOCH + 4;
        assert_eq!(route_status(&value).level, Level::Warn, "four epochs ahead is outside it");
    }

    /// Claim: the default margin of one hour is used when it is larger than three epochs.
    /// Why it matters: three epochs is 19 minutes on Ethereum. The hour is the stricter rule.
    #[test]
    fn the_hour_wins_over_three_epochs() {
        assert_eq!(route_status(&inputs()).margin_seconds, HOUR);
    }

    /// Claim: an entry at the never epoch is not a scheduled fork, whatever its version.
    /// Why it matters: PulseChain lists Deneb with version 0xffffffff and the never epoch. Treating it as
    /// scheduled would stop a healthy route for good.
    #[test]
    fn the_never_epoch_is_ignored() {
        let mut value = inputs();
        value.schedule.push(ScheduleEntry { version: [0xff; 4], epoch: NEVER_EPOCH });
        value.schedule.push(ScheduleEntry { version: UNKNOWN, epoch: 18_446_744_073_709_551_615 });
        let status = route_status(&value);
        assert_eq!(status.level, Level::Open);
        assert!(status.fork.is_none());
    }

    /// Claim: an entry with version 0xffffffff and a real epoch is still a scheduled fork, because only the epoch decides.
    /// Why it matters: ignoring it by version would hide a real fork. The control for the test above.
    #[test]
    fn a_real_epoch_counts_whatever_the_version() {
        let mut value = inputs();
        value.schedule.push(ScheduleEntry { version: [0xff; 4], epoch: NOW_EPOCH + 1 });
        assert_eq!(route_status(&value).level, Level::Stop);
    }

    /// Claim: an old unsupported fork that a supported fork has replaced is history, not a finding.
    /// Why it matters: Phase0 and Altair are not in every gate list, and they are long gone.
    #[test]
    fn replaced_forks_are_history() {
        let mut value = inputs();
        value.schedule.insert(0, ScheduleEntry { version: UNKNOWN, epoch: 0 });
        assert_eq!(route_status(&value).level, Level::Open);
    }

    /// Claim: a version that the gate does not list is unsupported even when the program lists it.
    /// Why it matters: after that fork the vault gate refuses every deposit.
    #[test]
    fn the_gate_list_narrows_the_supported_set() {
        let mut value = inputs();
        let mut narrow = gate(false);
        narrow.supported_versions = vec![KNOWN];
        value.gate = Some(narrow);
        value.program_versions.push([5, 0, 0, 0]);
        value.schedule.push(ScheduleEntry { version: [5, 0, 0, 0], epoch: NOW_EPOCH + 100 });
        assert_eq!(route_status(&value).level, Level::Warn);
    }

    /// Claim: with several findings at once the most severe wins and the others stay listed.
    /// Why it matters: a script reads one status. SEALED must not hide behind a warning.
    #[test]
    fn the_most_severe_finding_wins() {
        let mut value = with_fork_in(48 * HOUR);
        value.light_client_head_slot = 0;
        assert_eq!(route_status(&value).level, Level::Stale, "stale beats warn");
        value.schedule.push(ScheduleEntry { version: UNKNOWN, epoch: NOW_EPOCH + 1 });
        assert_eq!(route_status(&value).level, Level::Stop, "stop beats stale");
        value.gate = Some(gate(true));
        let status = route_status(&value);
        assert_eq!(status.level, Level::Sealed, "sealed beats stop");
        assert_eq!(status.other_findings.len(), 2, "{:?}", status.other_findings);
    }

    /// Claim: the exit code is 0 for OPEN and WARN and 2 for STOP, SEALED and STALE.
    /// Why it matters: scripts rely on it to refuse a deposit.
    #[test]
    fn exit_code_follows_the_level() {
        let report = |level| {
            let mut status = route_status(&inputs());
            status.level = level;
            RouteReport {
                route: "a_to_b".into(),
                source_chain: "ethereum".into(),
                status,
                light_client_head_slot: 1,
                source_head_slot: 1,
                gate: None,
            }
        };
        assert_eq!(exit_code(&[report(Level::Open), report(Level::Warn)]), 0);
        for level in [Level::Stop, Level::Sealed, Level::Stale] {
            assert_eq!(exit_code(&[report(Level::Open), report(level)]), 2, "{level:?}");
        }
    }

    /// Claim: the times print as UTC dates that match known values.
    /// Why it matters: a wrong date in an announcement sends people to the wrong day.
    #[test]
    fn utc_formatting_matches_known_dates() {
        assert_eq!(format_utc(0), "1970-01-01T00:00:00Z");
        assert_eq!(format_utc(1_606_824_023), "2020-12-01T12:00:23Z");
        assert_eq!(format_utc(951_782_400), "2000-02-29T00:00:00Z");
    }

    /// An in-memory beacon node: a map from path to body. An unknown path answers 404.
    struct Node(HashMap<&'static str, String>);

    impl HttpGet for Node {
        fn get(&self, path: &str, _accept: &str) -> Result<HttpResponse> {
            Ok(match self.0.get(path) {
                Some(body) => HttpResponse { status: 200, body: body.clone().into_bytes() },
                None => HttpResponse { status: 404, body: b"{}".to_vec() },
            })
        }
    }

    fn fake_node() -> Node {
        Node(HashMap::from([
            ("/eth/v1/beacon/genesis", r#"{"data":{"genesis_time":"1606824023","genesis_validators_root":"0x00","genesis_fork_version":"0x00000000"}}"#.to_string()),
            (
                "/eth/v1/config/fork_schedule",
                r#"{"data":[
                    {"previous_version":"0x00000000","current_version":"0x00000000","epoch":"0"},
                    {"previous_version":"0x00000000","current_version":"0x01000000","epoch":"74240"},
                    {"previous_version":"0x01000000","current_version":"0x02000000","epoch":"144896"},
                    {"previous_version":"0x02000000","current_version":"0xffffffff","epoch":"18446744073709551615"}
                ]}"#
                    .to_string(),
            ),
            ("/eth/v1/beacon/headers/head", r#"{"data":{"root":"0x00","header":{"message":{"slot":"12345"}}}}"#.to_string()),
        ]))
    }

    /// Claim: the fetch reads genesis time, head slot and every schedule entry, and keeps the never epoch as a number.
    /// Why it matters: the decision function depends on exact parsing. The never value does not fit a signed integer.
    #[test]
    fn a_fake_beacon_node_is_parsed() {
        let facts = fetch_beacon_facts(&fake_node()).expect("fetch");
        assert_eq!(facts.genesis_time, 1_606_824_023);
        assert_eq!(facts.head_slot, 12_345);
        assert_eq!(facts.schedule.len(), 4);
        assert_eq!(facts.schedule[1], ScheduleEntry { version: [1, 0, 0, 0], epoch: 74_240 });
        assert_eq!(facts.schedule[3], ScheduleEntry { version: [0xff; 4], epoch: NEVER_EPOCH });
    }

    /// Claim: a missing endpoint, a bad version and a bad epoch each give an error, never a default.
    /// Why it matters: a default schedule would report OPEN for a route that was never checked.
    #[test]
    fn bad_beacon_answers_are_errors() {
        let missing = Node(HashMap::new());
        assert!(matches!(fetch_beacon_facts(&missing), Err(Error::Beacon(_))));
        let bad_version = json!({"data":[{"current_version":"0x0100","epoch":"1"}]});
        assert!(matches!(parse_fork_schedule(&bad_version), Err(Error::Malformed(_))));
        let bad_epoch = json!({"data":[{"current_version":"0x01000000","epoch":"soon"}]});
        assert!(matches!(parse_fork_schedule(&bad_epoch), Err(Error::Malformed(_))));
        assert!(matches!(parse_fork_schedule(&json!({})), Err(Error::Malformed(_))));
        assert!(matches!(parse_genesis_time(&json!({"data":{}})), Err(Error::Malformed(_))));
        assert!(matches!(parse_head_slot(&json!({"data":{"header":{}}})), Err(Error::Malformed(_))));
    }

    /// Claim: from a fake node, with the real program table, the pieces together give OPEN on a quiet Ethereum
    /// schedule, and STOP when the node announces a fork the program lacks inside the margin.
    /// Why it matters: this is the whole path of the command without a network, including the program table.
    #[test]
    fn fetched_data_and_the_program_table_decide_the_route() {
        let facts = fetch_beacon_facts(&fake_node()).expect("fetch");
        let now = facts.genesis_time + 200_000 * 384;
        let open = assemble_inputs(ChainKind::Ethereum, &facts, None, facts.head_slot, now, HealthSettings::default());
        assert_eq!(route_status(&open).level, Level::Open);

        let mut announced = facts.clone();
        announced.schedule.push(ScheduleEntry { version: [0x42, 0, 0, 0], epoch: 200_000 + 5 });
        let soon = assemble_inputs(ChainKind::Ethereum, &announced, None, facts.head_slot, now, HealthSettings::default());
        assert_eq!(route_status(&soon).level, Level::Stop);
    }

    /// Claim: the program versions of Ethereum are Phase0 through Fulu, without the Gloas placeholder at the never
    /// epoch; PulseChain stops at Capella and has no Deneb.
    /// Why it matters: counting Gloas as supported would hide the real Gloas fork when it is scheduled. The expected
    /// versions are written by hand from the build contract (Capella 3, Deneb 4, Electra 5, Fulu 6).
    #[test]
    fn program_versions_leave_out_the_placeholder() {
        let ethereum = program_versions(ChainKind::Ethereum);
        for version in 0u8..=6 {
            assert!(ethereum.contains(&[version, 0, 0, 0]), "version {version}");
        }
        assert!(!ethereum.contains(&[7, 0, 0, 0]));
        let pulsechain = program_versions(ChainKind::Pulsechain);
        assert!(!pulsechain.contains(&[0xff; 4]));
        assert_eq!(pulsechain.len(), 4);
    }

    /// Claim: the JSON has the status, the fork fields, the numbers, and a null for an absent fork or gate.
    /// Why it matters: scripts and interfaces read these names.
    #[test]
    fn json_output_has_the_documented_fields() {
        let status = route_status(&with_fork_in(HOUR / 2));
        let report = RouteReport {
            route: "a_to_b".into(),
            source_chain: "ethereum".into(),
            status,
            light_client_head_slot: 5,
            source_head_slot: 9,
            gate: None,
        };
        let value = report.to_json();
        assert_eq!(value["status"], "STOP");
        assert_eq!(value["refuses_deposits"], true);
        assert_eq!(value["fork"]["version"], "0x09000000");
        assert!(value["fork"]["activation_epoch"].is_u64());
        assert!(value["gate"].is_null());
        let line = report.human_line();
        assert!(line.contains("status=STOP") && line.contains("fork_version=0x09000000") && line.contains("gate=none"), "{line}");
        assert!(render(&[report], OutputFormat::Json).trim_start().starts_with('['));
    }

    /// Claim: the gate reader reads the mode, the supported versions and the sealed flag through the contract
    /// bindings, and treats a reverting `depositGate` as a read error, not as a vault without a gate.
    /// Why it matters: a wrong selector or decode would report an unsealed gate for a sealed one.
    #[test]
    fn the_gate_is_read_through_the_bindings() {
        use crate::chain::fake::ScriptedRpc;
        use crate::gate::GateContract;
        use alloy_primitives::{address, U256};
        use alloy_sol_types::SolCall;
        use std::sync::Mutex;

        let gate_address = address!("00000000000000000000000000000000000000aa");
        let vault = address!("00000000000000000000000000000000000000bb");
        let answer = |data: Vec<u8>| Ok(json!(format!("0x{}", hex::encode(data))));
        let handler = move |method: &str, params: &Value| -> Result<Value> {
            match method {
                "eth_chainId" => return Ok(json!("0x1")),
                "eth_call" => {}
                other => panic!("unexpected {other}"),
            }
            let to = params[0]["to"].as_str().unwrap().to_string();
            let data = hex::decode(params[0]["data"].as_str().unwrap()).unwrap();
            let selector: [u8; 4] = data[..4].try_into().unwrap();
            if to == format!("{vault:#x}") {
                assert_eq!(selector, VaultContract::depositGateCall::SELECTOR);
                return answer(VaultContract::depositGateCall::abi_encode_returns(&gate_address));
            }
            match selector {
                s if s == GateContract::enforcingCall::SELECTOR => answer(GateContract::enforcingCall::abi_encode_returns(&true)),
                s if s == GateContract::isSealedCall::SELECTOR => answer(GateContract::isSealedCall::abi_encode_returns(&true)),
                s if s == GateContract::confirmedEpochCall::SELECTOR => {
                    answer(GateContract::confirmedEpochCall::abi_encode_returns(&GateContract::confirmedEpochReturn { epoch: 77, exists: true }))
                }
                s if s == GateContract::currentEpochCall::SELECTOR => answer(GateContract::currentEpochCall::abi_encode_returns(&U256::from(78))),
                s if s == GateVersionsContract::modeCall::SELECTOR => answer(GateVersionsContract::modeCall::abi_encode_returns(&1u8)),
                s if s == GateVersionsContract::supportedVersionsCall::SELECTOR => {
                    let versions = vec![crate::contracts::GateSupportedVersion { version: [3, 0, 0, 0].into(), stateDepth: 5 }];
                    answer(GateVersionsContract::supportedVersionsCall::abi_encode_returns(&versions))
                }
                other => panic!("unexpected selector {other:?}"),
            }
        };
        let rpc = ScriptedRpc { calls: Mutex::new(vec![]), handler: Box::new(handler) };
        let client = ChainClient::connect("test", 1, Box::new(rpc), None).unwrap();
        let observed = read_gate_observation(&client, vault).unwrap();
        assert_eq!(observed.gate, gate_address);
        assert_eq!(observed.mode, "DetectBeaconRoots");
        assert!(observed.sealed && observed.enforcing);
        assert_eq!(observed.confirmed_epoch, Some(77));
        assert_eq!(observed.supported_versions, vec![[3, 0, 0, 0]]);

        let bare = ScriptedRpc {
            calls: Mutex::new(vec![]),
            handler: Box::new(|method, _| match method {
                "eth_chainId" => Ok(json!("0x1")),
                _ => Err(Error::Rpc { code: 3, message: "execution reverted".into(), data: None }),
            }),
        };
        let client = ChainClient::connect("test", 1, Box::new(bare), None).unwrap();
        assert!(read_gate_observation(&client, vault).is_err(), "a reverting depositGate is a read error, never an open route");
    }
}
