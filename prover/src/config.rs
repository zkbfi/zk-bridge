//! TOML configuration with environment overrides and validation.
//!
//! The file holds no secret. A key named `private_key`, `mnemonic`, `password`, `secret`, `seed`, `api_key` or `token`
//! anywhere in the file is refused. Where a command needs a secret (the API key of the remote worker, the bearer token
//! of the webhook, the oracle key), the file names the environment variable that holds it. The value never enters the file.
//!
//! The sections:
//!
//! - `[prover]`: the proving backend. The `prove` command needs it.
//! - `[handoff]`: where the `prove` command puts its result. Standard output is the default.
//! - `[routes.<name>]`: one direction between two chains. A route names the source beacon API and the destination light
//!   client. The `evidence` command also reads the execution endpoints and the two bridges of the route.
//!
//! Environment overrides: `ZK_BRIDGE_PROVER_<PATH>` where `<PATH>` is the key path in capitals, with `_` for `.`.
//! For example `ZK_BRIDGE_PROVER_PROVER_REMOTE_URL`. Only the keys of `[prover]` and `[handoff]` can be overridden,
//! because the names of routes are free text.

use crate::error::{Error, Result};
use crate::light_client::ChainKind;
use alloy_primitives::{Address, B256};
use serde::Deserialize;
use std::collections::BTreeMap;
use std::path::PathBuf;
use std::str::FromStr;

/// The prefix of every override variable.
pub const ENVIRONMENT_PREFIX: &str = "ZK_BRIDGE_PROVER_";

/// Key names that may never appear in the file.
const FORBIDDEN_KEYS: [&str; 9] = [
    "private_key",
    "privatekey",
    "mnemonic",
    "password",
    "secret",
    "seed",
    "api_key",
    "apikey",
    "token",
];

/// What an override sets.
#[derive(Clone, Copy)]
enum Kind {
    Text,
    Integer,
}

/// Every key that an environment variable may override.
const OVERRIDES: [(&str, Kind); 8] = [
    ("prover.program_vkey", Kind::Text),
    ("prover.sp1_elf_path", Kind::Text),
    ("prover.sp1_observation_elf_path", Kind::Text),
    ("prover.remote_url", Kind::Text),
    ("prover.remote_api_key_env", Kind::Text),
    ("handoff.webhook_url", Kind::Text),
    ("handoff.webhook_bearer_env", Kind::Text),
    ("handoff.webhook_timeout_seconds", Kind::Integer),
];

/// The proving backend.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Deserialize)]
pub enum ProverBackend {
    /// The development backend that signs with the oracle key.
    #[serde(rename = "oracle")]
    Oracle,
    /// The production backend on the local CPU (cargo feature `sp1`).
    #[serde(rename = "sp1")]
    Sp1,
    /// A worker on a GPU host, reached over HTTP (`src/remote.rs`). It is in the default build.
    #[serde(rename = "remote")]
    Remote,
}

impl ProverBackend {
    /// The name in the configuration file.
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Oracle => "oracle",
            Self::Sp1 => "sp1",
            Self::Remote => "remote",
        }
    }
}

/// The `[prover]` section.
#[derive(Clone, Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ProverConfig {
    /// The backend.
    pub backend: ProverBackend,
    /// The verification key of the light-client program. A route command reads the key from the light client contract.
    /// When this key is set too, the two must be equal. A command that starts from an explicit head needs it, unless the
    /// command line gives the key.
    #[serde(default)]
    pub program_vkey: Option<String>,
    /// The compiled light-client guest, for the `sp1` backend.
    #[serde(default)]
    pub sp1_elf_path: Option<PathBuf>,
    /// The compiled fork observation guest, for the `sp1` backend. Without it the prover refuses observations.
    #[serde(default)]
    pub sp1_observation_elf_path: Option<PathBuf>,
    /// The NAME of the environment variable that holds the oracle key, for the `oracle` backend. The key itself never
    /// goes in the file.
    #[serde(default)]
    pub oracle_key_env: Option<String>,
    /// The base URL of the worker endpoint, for the `remote` backend.
    #[serde(default)]
    pub remote_url: Option<String>,
    /// The NAME of the environment variable that holds the API key of the endpoint, for the `remote` backend. The key
    /// itself never goes in the file.
    #[serde(default)]
    pub remote_api_key_env: Option<String>,
    /// The time one request to the worker may take. It must cover a cold start and a proof.
    #[serde(default = "default_remote_timeout_seconds")]
    pub remote_timeout_seconds: u64,
    /// How often the backend sends a job before it gives up.
    #[serde(default = "default_remote_attempts")]
    pub remote_attempts: u32,
    /// The wait before the second attempt. The wait grows by this much for each further attempt.
    #[serde(default = "default_remote_retry_delay_seconds")]
    pub remote_retry_delay_seconds: u64,
    /// The longest wait for a worker that is not ready yet (a cold endpoint), counted from the first request. Zero
    /// turns the wait off. The backend's job limit must exceed it plus one proof (`docs/gpu-prover.md`).
    #[serde(default = "default_remote_cold_start_wait_seconds")]
    pub remote_cold_start_wait_seconds: u64,
}

fn default_remote_timeout_seconds() -> u64 {
    900
}

fn default_remote_attempts() -> u32 {
    4
}

fn default_remote_retry_delay_seconds() -> u64 {
    10
}

fn default_remote_cold_start_wait_seconds() -> u64 {
    900
}

/// Where the `prove` command puts its result.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Deserialize, clap::ValueEnum)]
pub enum HandoffTarget {
    /// One JSON object on standard output.
    #[serde(rename = "stdout")]
    Stdout,
    /// One POST of the same object to `handoff.webhook_url`.
    #[serde(rename = "webhook")]
    Webhook,
}

/// The `[handoff]` section.
#[derive(Clone, Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct HandoffConfig {
    /// The targets. The command line can replace them. Default: standard output only.
    #[serde(default = "default_targets")]
    pub targets: Vec<HandoffTarget>,
    /// The URL that receives the POST, for the `webhook` target. It must use https, or http on the local machine.
    #[serde(default)]
    pub webhook_url: Option<String>,
    /// The NAME of the environment variable that holds the bearer token of the webhook. Optional: without it the request
    /// carries no `Authorization` header. The token itself never goes in the file.
    #[serde(default)]
    pub webhook_bearer_env: Option<String>,
    /// The time one request to the webhook may take.
    #[serde(default = "default_webhook_timeout_seconds")]
    pub webhook_timeout_seconds: u64,
    /// How often the command sends the POST before it gives up. A proof is costly, so a short outage of the receiver
    /// should not lose it.
    #[serde(default = "default_webhook_attempts")]
    pub webhook_attempts: u32,
    /// The wait before the second attempt. The wait grows by this much for each further attempt.
    #[serde(default = "default_webhook_retry_delay_seconds")]
    pub webhook_retry_delay_seconds: u64,
}

impl Default for HandoffConfig {
    fn default() -> Self {
        Self {
            targets: default_targets(),
            webhook_url: None,
            webhook_bearer_env: None,
            webhook_timeout_seconds: default_webhook_timeout_seconds(),
            webhook_attempts: default_webhook_attempts(),
            webhook_retry_delay_seconds: default_webhook_retry_delay_seconds(),
        }
    }
}

fn default_targets() -> Vec<HandoffTarget> {
    vec![HandoffTarget::Stdout]
}

fn default_webhook_timeout_seconds() -> u64 {
    30
}

fn default_webhook_attempts() -> u32 {
    3
}

fn default_webhook_retry_delay_seconds() -> u64 {
    5
}

/// The source side of a route: the chain where messages are sent and whose beacon chain the light client tracks.
#[derive(Clone, Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct SourceConfig {
    /// The chain identifier of the source chain.
    pub chain_id: u64,
    /// `ethereum`, `pulsechain`, `sepolia` or `pulsechain-testnet-v4`: which `lc-core` chain specification applies to the beacon chain of the source.
    pub chain: String,
    /// The base URL of the beacon API of the source chain.
    pub beacon_url: String,
    /// The execution RPC URL of the source chain. The `evidence` command needs it.
    #[serde(default)]
    pub rpc_url: Option<String>,
    /// The `MessageBridge` on the source chain. The `evidence` command needs it.
    #[serde(default)]
    pub bridge: Option<String>,
    /// A directory where the `prove` command keeps the branch of `genesis_validators_root` of each attested state, as public
    /// data. A later run that must catch up after the beacon node pruned the old states reads the branches back. Without it,
    /// the branches live in memory for one run only. The only file the `prove` command writes is in this directory.
    #[serde(default)]
    pub branch_store_dir: Option<String>,
    /// More beacon APIs of the source chain, asked in order only for states (`/eth/v2/debug/beacon/states/<root>`), when
    /// `beacon_url` does not serve a state or serves one with another root. A public node often keeps only recent states;
    /// an archive such as Checkpointz keeps older ones. Every state is still checked against the root of its header.
    #[serde(default)]
    pub state_urls: Vec<String>,
    /// A directory where the prover keeps the states it fetched and verified, so a later run never depends on a node that
    /// still serves an old state. It keeps the 16 newest states of each chain and every state younger than 3 days.
    #[serde(default)]
    pub state_cache_dir: Option<String>,
}

/// The destination side of a route: the chain with the light client that the proofs update.
#[derive(Clone, Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct DestinationConfig {
    /// The chain identifier of the destination chain. The commands check it against `eth_chainId`.
    pub chain_id: u64,
    /// The execution RPC URL of the destination chain. The commands read the light client and the bridge with it.
    pub rpc_url: String,
    /// The `BeaconLightClient` on the destination chain. It tracks the beacon chain of the source.
    pub light_client: String,
    /// The `MessageBridge` on the destination chain. The `evidence` command needs it.
    #[serde(default)]
    pub bridge: Option<String>,
    /// The block where the light client was deployed. The scan for stored heads starts here. Default 0.
    #[serde(default)]
    pub start_block: u64,
    /// The largest block range of one `eth_getLogs` call.
    #[serde(default = "default_log_range")]
    pub log_block_range: u64,
}

fn default_log_range() -> u64 {
    2_000
}

/// One direction: messages are sent on the source chain and delivered on the destination chain.
#[derive(Clone, Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct RouteConfig {
    /// The source chain.
    pub source: SourceConfig,
    /// The destination chain.
    pub destination: DestinationConfig,
}

/// The whole configuration.
#[derive(Clone, Debug, Default, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Config {
    /// The proving backend. The `prove` command needs it. The `evidence` command does not.
    #[serde(default)]
    pub prover: Option<ProverConfig>,
    /// Where `prove` puts its result.
    #[serde(default)]
    pub handoff: HandoffConfig,
    /// The routes, by name.
    #[serde(default)]
    pub routes: BTreeMap<String, RouteConfig>,
}

fn parse_address(text: &str, key: &str) -> Result<Address> {
    let address =
        Address::from_str(text).map_err(|error| Error::Config(format!("{key}: {error}")))?;
    if address == Address::ZERO {
        return Err(Error::Config(format!("{key}: the zero address")));
    }
    Ok(address)
}

fn require_present<'a>(value: &'a Option<String>, key: &str) -> Result<&'a str> {
    value
        .as_deref()
        .ok_or_else(|| Error::Config(format!("{key} is required for this command")))
}

impl SourceConfig {
    /// The `lc-core` chain kind of the beacon chain of the source.
    pub fn chain_kind(&self) -> Result<ChainKind> {
        ChainKind::parse(&self.chain).map_err(|error| match error {
            Error::Config(message) => Error::Config(format!("source.chain: {message}")),
            other => other,
        })
    }

    /// The execution RPC URL, for a command that reads the source chain.
    pub fn execution_url(&self) -> Result<&str> {
        require_present(&self.rpc_url, "source.rpc_url")
    }

    /// The bridge address, for a command that reads the message.
    pub fn bridge_address(&self) -> Result<Address> {
        parse_address(
            require_present(&self.bridge, "source.bridge")?,
            "source.bridge",
        )
    }
}

impl DestinationConfig {
    /// The light client address.
    pub fn light_client_address(&self) -> Result<Address> {
        parse_address(&self.light_client, "destination.light_client")
    }

    /// The bridge address, for a command that builds a message proof.
    pub fn bridge_address(&self) -> Result<Address> {
        parse_address(
            require_present(&self.bridge, "destination.bridge")?,
            "destination.bridge",
        )
    }
}

impl ProverConfig {
    /// The configured program verification key, or `None` when the file sets none.
    pub fn program_vkey_value(&self) -> Result<Option<B256>> {
        let Some(text) = &self.program_vkey else {
            return Ok(None);
        };
        let key = B256::from_str(text)
            .map_err(|error| Error::Config(format!("prover.program_vkey: {error}")))?;
        if key == B256::ZERO {
            return Err(Error::Config("prover.program_vkey is zero".into()));
        }
        Ok(Some(key))
    }
}

/// Whether a URL points at the local machine.
pub fn is_loopback_url(url: &str) -> bool {
    let rest = url.split_once("://").map_or(url, |(_, rest)| rest);
    let authority = rest.split(['/', '?']).next().unwrap_or("");
    let host = authority
        .rsplit_once('@')
        .map_or(authority, |(_, host)| host);
    let host = match host.strip_prefix('[') {
        Some(inner) => inner.split(']').next().unwrap_or(""),
        None => host.split(':').next().unwrap_or(""),
    };
    host == "localhost"
        || host
            .parse::<std::net::Ipv4Addr>()
            .is_ok_and(|address| address.is_loopback())
        || host
            .parse::<std::net::Ipv6Addr>()
            .is_ok_and(|address| address.is_loopback())
}

/// Whether a secret may travel to this URL: https, or http on the local machine (for tests and tunnels).
pub fn is_permitted_secret_url(url: &str) -> bool {
    url.starts_with("https://") || (url.starts_with("http://") && is_loopback_url(url))
}

/// Whether text has the shape of an environment variable name: capitals, digits and `_`, starting with a capital.
/// This also stops someone from pasting a secret where the file wants a name.
pub fn is_environment_name(text: &str) -> bool {
    !text.is_empty()
        && text.len() <= 64
        && text.starts_with(|character: char| character.is_ascii_uppercase())
        && text.chars().all(|character| {
            character.is_ascii_uppercase() || character.is_ascii_digit() || character == '_'
        })
}

/// Fails unless `value` is the name of an environment variable.
///
/// # Errors
/// `Error::Config` that names `key`.
pub fn require_environment_name(value: &str, key: &str) -> Result<()> {
    if is_environment_name(value) {
        return Ok(());
    }
    Err(Error::Config(format!(
        "{key} must be the NAME of an environment variable in capitals, not the secret"
    )))
}

fn refuse_secret_keys(value: &toml::Value, path: &str) -> Result<()> {
    let Some(table) = value.as_table() else {
        return Ok(());
    };
    for (key, child) in table {
        let lowered = key.to_ascii_lowercase();
        if FORBIDDEN_KEYS.contains(&lowered.as_str()) {
            return Err(Error::SecretHandling(format!(
                "the key `{path}{key}` is not allowed: name an environment variable in the configuration, never a secret"
            )));
        }
        refuse_secret_keys(child, &format!("{path}{key}."))?;
    }
    Ok(())
}

fn set_path(table: &mut toml::Table, path: &str, value: toml::Value) -> Result<()> {
    let mut parts = path.split('.').peekable();
    let mut current = table;
    while let Some(part) = parts.next() {
        if parts.peek().is_none() {
            current.insert(part.to_string(), value);
            return Ok(());
        }
        current = current
            .entry(part.to_string())
            .or_insert_with(|| toml::Value::Table(toml::Table::new()))
            .as_table_mut()
            .ok_or_else(|| Error::Config(format!("{path}: `{part}` is not a table")))?;
    }
    Ok(())
}

impl Config {
    /// Parses the text, applies environment overrides through `lookup`, and validates.
    ///
    /// # Errors
    /// `Error::Config` for a syntax or value problem. `Error::SecretHandling` for a secret in the file.
    pub fn load(text: &str, lookup: &dyn Fn(&str) -> Option<String>) -> Result<Self> {
        let mut table: toml::Table = text
            .parse()
            .map_err(|error| Error::Config(format!("not valid TOML: {error}")))?;
        refuse_secret_keys(&toml::Value::Table(table.clone()), "")?;
        for (path, kind) in OVERRIDES {
            let name = format!(
                "{ENVIRONMENT_PREFIX}{}",
                path.to_ascii_uppercase().replace('.', "_")
            );
            let Some(raw) = lookup(&name) else { continue };
            let value = match kind {
                Kind::Text => toml::Value::String(raw),
                Kind::Integer => toml::Value::Integer(
                    raw.trim()
                        .parse()
                        .map_err(|_| Error::Config(format!("{name}: expected an integer")))?,
                ),
            };
            set_path(&mut table, path, value)?;
        }
        let config: Config = toml::Value::Table(table)
            .try_into()
            .map_err(|error| Error::Config(error.to_string()))?;
        config.validate()?;
        Ok(config)
    }

    /// Reads a file and loads it. See [`Config::load`].
    pub fn load_file(
        path: &std::path::Path,
        lookup: &dyn Fn(&str) -> Option<String>,
    ) -> Result<Self> {
        let text = std::fs::read_to_string(path)
            .map_err(|error| Error::Config(format!("cannot read {}: {error}", path.display())))?;
        Self::load(&text, lookup)
    }

    /// The `[prover]` section.
    ///
    /// # Errors
    /// `Error::Config` when the file has none.
    pub fn prover_config(&self) -> Result<&ProverConfig> {
        self.prover
            .as_ref()
            .ok_or_else(|| Error::Config("the file has no [prover] section".into()))
    }

    /// The route with this name, or the only route when `name` is `None` and the file has exactly one.
    ///
    /// # Errors
    /// `Error::Usage` when the name is unknown, or when no name is given and the file does not have exactly one route.
    pub fn route(&self, name: Option<&str>) -> Result<(&str, &RouteConfig)> {
        let known = || self.routes.keys().cloned().collect::<Vec<_>>().join(", ");
        if let Some(name) = name {
            return self
                .routes
                .get_key_value(name)
                .map(|(name, route)| (name.as_str(), route))
                .ok_or_else(|| {
                    Error::Usage(format!("no route named {name}; the file has: {}", known()))
                });
        }
        let mut routes = self.routes.iter();
        match (routes.next(), routes.next()) {
            (Some((name, route)), None) => Ok((name.as_str(), route)),
            _ => Err(Error::Usage(format!(
                "name the route with --route; the file has: {}",
                known()
            ))),
        }
    }

    /// Checks every value that can be checked without a network.
    ///
    /// # Errors
    /// `Error::Config` naming the key.
    pub fn validate(&self) -> Result<()> {
        if let Some(prover) = &self.prover {
            self.validate_prover(prover)?;
        }
        self.validate_handoff()?;
        for (name, route) in &self.routes {
            validate_route(name, route)?;
        }
        Ok(())
    }

    fn validate_prover(&self, prover: &ProverConfig) -> Result<()> {
        prover.program_vkey_value()?;
        match prover.backend {
            ProverBackend::Sp1 if prover.sp1_elf_path.is_none() => Err(Error::Config(
                "prover.sp1_elf_path is required for the sp1 backend".into(),
            )),
            ProverBackend::Sp1 => Ok(()),
            ProverBackend::Remote => crate::remote::validate_remote_config(prover),
            ProverBackend::Oracle => self.validate_oracle(prover),
        }
    }

    /// The oracle backend signs for a development verifier. The file must name the variable that holds the key, and no
    /// route may point at a chain that is not local: a real chain has a real verifier.
    fn validate_oracle(&self, prover: &ProverConfig) -> Result<()> {
        let variable = prover.oracle_key_env.as_deref().ok_or_else(|| {
            Error::Config("prover.oracle_key_env is required for the oracle backend".into())
        })?;
        require_environment_name(variable, "prover.oracle_key_env")?;
        let remote = self
            .routes
            .iter()
            .find(|(_, route)| !is_loopback_url(&route.destination.rpc_url));
        match remote {
            Some((name, _)) => Err(Error::Config(format!(
                "routes.{name}: the oracle backend works only for a destination on the local machine"
            ))),
            None => Ok(()),
        }
    }

    fn validate_handoff(&self) -> Result<()> {
        let handoff = &self.handoff;
        if handoff.targets.is_empty() {
            return Err(Error::Config(
                "handoff.targets must name at least one target".into(),
            ));
        }
        if handoff.webhook_timeout_seconds == 0 || handoff.webhook_attempts == 0 {
            return Err(Error::Config(
                "handoff.webhook_timeout_seconds and handoff.webhook_attempts must be at least 1"
                    .into(),
            ));
        }
        if let Some(variable) = &handoff.webhook_bearer_env {
            require_environment_name(variable, "handoff.webhook_bearer_env")?;
        }
        let Some(url) = &handoff.webhook_url else {
            return Ok(());
        };
        if is_permitted_secret_url(url) {
            return Ok(());
        }
        Err(Error::Config(
            "handoff.webhook_url must start with https:// (http:// only for the local machine): the bearer token travels in the request".into(),
        ))
    }
}

fn validate_route(name: &str, route: &RouteConfig) -> Result<()> {
    let (source, destination) = (&route.source, &route.destination);
    let context = |message: String| Error::Config(format!("routes.{name}: {message}"));
    if source.chain_id == 0 || destination.chain_id == 0 {
        return Err(context("chain_id must not be zero".into()));
    }
    source
        .chain_kind()
        .map_err(|error| context(error.to_string()))?;
    if !is_http_url(&source.beacon_url) {
        return Err(context(
            "source.beacon_url must start with http:// or https://".into(),
        ));
    }
    if source.state_urls.iter().any(|url| !is_http_url(url)) {
        return Err(context(
            "every source.state_urls entry must start with http:// or https://".into(),
        ));
    }
    if !is_http_url(&destination.rpc_url) {
        return Err(context(
            "destination.rpc_url must start with http:// or https://".into(),
        ));
    }
    if source
        .rpc_url
        .as_deref()
        .is_some_and(|url| !is_http_url(url))
    {
        return Err(context(
            "source.rpc_url must start with http:// or https://".into(),
        ));
    }
    if destination.log_block_range == 0 {
        return Err(context(
            "destination.log_block_range must be at least 1".into(),
        ));
    }
    let light_client = destination
        .light_client_address()
        .map_err(|error| context(error.to_string()))?;
    let bridges = [
        source
            .bridge
            .as_deref()
            .map(|text| parse_address(text, "source.bridge")),
        destination
            .bridge
            .as_deref()
            .map(|text| parse_address(text, "destination.bridge")),
    ];
    for bridge in bridges.into_iter().flatten() {
        let bridge = bridge.map_err(|error| context(error.to_string()))?;
        if bridge == light_client {
            return Err(context(
                "a bridge and the destination light client are the same address".into(),
            ));
        }
    }
    Ok(())
}

fn is_http_url(url: &str) -> bool {
    url.starts_with("http://") || url.starts_with("https://")
}

/// A complete configuration for tests.
#[cfg(test)]
pub(crate) const SAMPLE_FOR_TESTS: &str = r#"
[prover]
backend = "oracle"
oracle_key_env = "ORACLE_KEY"
program_vkey = "0x0000000000000000000000000000000000000000000000000000000000001234"

[routes.ethereum_to_pulsechain.source]
chain_id = 1
chain = "ethereum"
beacon_url = "https://beacon.example.org"
rpc_url = "https://rpc.example.org"
bridge = "0x1111111111111111111111111111111111111111"

[routes.ethereum_to_pulsechain.destination]
chain_id = 369
rpc_url = "http://127.0.0.1:8546"
light_client = "0x4444444444444444444444444444444444444444"
bridge = "0x3333333333333333333333333333333333333333"
"#;

#[cfg(test)]
mod tests {
    use super::*;

    const SAMPLE: &str = SAMPLE_FOR_TESTS;

    fn no_environment(_: &str) -> Option<String> {
        None
    }

    /// Claim: a complete file loads, unset keys take their defaults, and the only route is found without a name.
    #[test]
    fn sample_loads_with_defaults() {
        let config = Config::load(SAMPLE, &no_environment).unwrap();
        assert_eq!(config.handoff.targets, vec![HandoffTarget::Stdout]);
        let (name, route) = config.route(None).unwrap();
        assert_eq!(name, "ethereum_to_pulsechain");
        assert_eq!(route.destination.log_block_range, 2_000);
        assert_eq!(route.destination.start_block, 0);
        assert_eq!(route.source.chain_kind().unwrap(), ChainKind::Ethereum);
    }

    /// Claim: every chain name loads as the source chain of a route, and a misspelled name stops the load with the list of
    /// the known names. Why it matters: a wrong chain selects wrong fork versions and every signature then fails.
    #[test]
    fn every_chain_name_loads_and_a_wrong_one_lists_the_choices() {
        for kind in ChainKind::ALL {
            let text = SAMPLE.replace(
                "chain = \"ethereum\"",
                &format!("chain = \"{}\"", kind.name()),
            );
            let config = Config::load(&text, &no_environment).unwrap();
            assert_eq!(
                config.route(None).unwrap().1.source.chain_kind().unwrap(),
                kind
            );
        }
        let wrong = SAMPLE.replace("chain = \"ethereum\"", "chain = \"sepolia-gloas\"");
        let error = Config::load(&wrong, &no_environment)
            .unwrap_err()
            .to_string();
        assert!(
            error.contains("source.chain") && error.contains("sepolia-gloas"),
            "{error}"
        );
        for kind in ChainKind::ALL {
            assert!(error.contains(kind.name()), "{error}");
        }
    }

    /// Claim: the example file of the repository loads, and it has the route that the documentation names.
    /// Why it matters: an example that does not load teaches the wrong keys.
    #[test]
    fn the_example_file_loads() {
        let config = Config::load(include_str!("../prover.example.toml"), &no_environment).unwrap();
        assert_eq!(
            config.prover_config().unwrap().backend,
            ProverBackend::Remote
        );
        let (name, route) = config.route(None).unwrap();
        assert_eq!(name, "ethereum_to_pulsechain");
        assert!(route.source.bridge_address().is_ok());
        assert!(route.destination.bridge_address().is_ok());
    }

    /// Claim: with two routes, a missing or unknown name is a usage error that lists the names.
    /// Why it matters: a guess would prove for the wrong light client.
    #[test]
    fn several_routes_need_a_name() {
        let text = format!(
            "{SAMPLE}
[routes.pulsechain_to_ethereum.source]
chain_id = 369
chain = \"pulsechain\"
beacon_url = \"https://beacon.example.net\"
[routes.pulsechain_to_ethereum.destination]
chain_id = 1
rpc_url = \"http://127.0.0.1:8545\"
light_client = \"0x2222222222222222222222222222222222222222\"
"
        );
        let config = Config::load(&text, &no_environment).unwrap();
        for name in [None, Some("missing")] {
            let error = config.route(name).unwrap_err();
            assert!(matches!(error, Error::Usage(_)), "{error}");
            assert!(
                error.to_string().contains("pulsechain_to_ethereum"),
                "{error}"
            );
        }
        assert!(config.route(Some("pulsechain_to_ethereum")).is_ok());
    }

    /// Claim: environment variables override file values, with the right type.
    /// Why it matters: operators change URLs and limits without editing the file.
    #[test]
    fn environment_overrides_the_file() {
        let lookup = |name: &str| match name {
            "ZK_BRIDGE_PROVER_HANDOFF_WEBHOOK_URL" => {
                Some("http://127.0.0.1:9000/proofs".to_string())
            }
            "ZK_BRIDGE_PROVER_HANDOFF_WEBHOOK_TIMEOUT_SECONDS" => Some("5".to_string()),
            _ => None,
        };
        let config = Config::load(SAMPLE, &lookup).unwrap();
        assert_eq!(
            config.handoff.webhook_url.as_deref(),
            Some("http://127.0.0.1:9000/proofs")
        );
        assert_eq!(config.handoff.webhook_timeout_seconds, 5);
        let bad = |name: &str| {
            (name == "ZK_BRIDGE_PROVER_HANDOFF_WEBHOOK_TIMEOUT_SECONDS").then(|| "soon".to_string())
        };
        assert!(Config::load(SAMPLE, &bad)
            .unwrap_err()
            .to_string()
            .contains("expected an integer"));
    }

    /// Claim: a secret in the file is refused, at any depth, whatever the letter case.
    /// Why it matters: a configuration file is often committed or copied. It must never hold a key or a token.
    #[test]
    fn secrets_in_the_file_are_refused() {
        for line in [
            "private_key = \"0xabc\"",
            "Mnemonic = \"a b c\"",
            "[handoff]\ntoken = \"x\"",
            "[routes.ethereum_to_pulsechain.extra]\npassword = \"x\"",
        ] {
            let text = if line.starts_with('[') {
                format!("{SAMPLE}\n{line}")
            } else {
                format!("{line}\n{SAMPLE}")
            };
            let error = Config::load(&text, &no_environment).unwrap_err();
            assert!(matches!(error, Error::SecretHandling(_)), "{line}: {error}");
        }
    }

    /// Claim: a variable name is checked, so a pasted secret in its place is refused and the error does not echo it.
    #[test]
    fn a_secret_cannot_stand_in_for_a_variable_name() {
        let pasted = "rpa_0123456789abcdef";
        for (from, to) in [
            ("oracle_key_env = \"ORACLE_KEY\"", format!("oracle_key_env = \"{pasted}\"")),
            (
                "[routes.ethereum_to_pulsechain.source]",
                format!("[handoff]\nwebhook_bearer_env = \"{pasted}\"\n[routes.ethereum_to_pulsechain.source]"),
            ),
        ] {
            let error = Config::load(&SAMPLE.replace(from, &to), &no_environment).unwrap_err();
            assert!(
                error.to_string().contains("NAME of an environment variable"),
                "{error}"
            );
            assert!(!error.to_string().contains(pasted), "{error}");
        }
    }

    /// Claim: bad route values are refused with the route and the key named: a zero address, a bridge
    /// that equals the light client, an unknown chain, a URL without a scheme, and an unknown key.
    #[test]
    fn invalid_route_values_are_refused() {
        let cases = [
            (
                "bridge = \"0x3333333333333333333333333333333333333333\"",
                "bridge = \"0x0000000000000000000000000000000000000000\"",
                "zero address",
            ),
            (
                "bridge = \"0x3333333333333333333333333333333333333333\"",
                "bridge = \"0x4444444444444444444444444444444444444444\"",
                "same address",
            ),
            (
                "chain = \"ethereum\"",
                "chain = \"solana\"",
                "unknown chain",
            ),
            (
                "beacon_url = \"https://beacon.example.org\"",
                "beacon_url = \"beacon.example.org\"",
                "beacon_url must start with",
            ),
            (
                "chain_id = 369",
                "chain_id = 369\nunknown_key = 1",
                "unknown field",
            ),
            (
                "beacon_url = \"https://beacon.example.org\"",
                "beacon_url = \"https://beacon.example.org\"\nstate_urls = [\"https://states.example.org\", \"states.example.net\"]",
                "every source.state_urls entry must start with",
            ),
        ];
        for (from, to, expected) in cases {
            let error = Config::load(&SAMPLE.replace(from, to), &no_environment)
                .unwrap_err()
                .to_string();
            assert!(
                error.contains(expected),
                "expected `{expected}` in `{error}`"
            );
        }
    }

    /// Claim: a source may name state URLs and a state cache directory; both are optional and empty by default.
    /// Why it matters: a proof must not depend on a node that still serves an old state.
    #[test]
    fn a_source_may_name_state_urls_and_a_state_cache() {
        let plain = Config::load(SAMPLE, &no_environment).unwrap();
        let (_, route) = plain.route(None).unwrap();
        assert!(route.source.state_urls.is_empty());
        assert_eq!(route.source.state_cache_dir, None);
        let with = SAMPLE.replace(
            "beacon_url = \"https://beacon.example.org\"",
            "beacon_url = \"https://beacon.example.org\"\nstate_urls = [\"https://states.example.org\"]\nstate_cache_dir = \"/var/lib/states\"",
        );
        let loaded = Config::load(&with, &no_environment).unwrap();
        let (_, route) = loaded.route(None).unwrap();
        assert_eq!(
            route.source.state_urls,
            vec!["https://states.example.org".to_string()]
        );
        assert_eq!(
            route.source.state_cache_dir.as_deref(),
            Some("/var/lib/states")
        );
    }

    /// Claim: a route whose source and destination are the same chain loads. That is the route of an own-chain light client,
    /// which tracks the beacon chain of the chain that holds it.
    #[test]
    fn a_route_may_stay_on_one_chain() {
        let same = SAMPLE.replace("chain_id = 369", "chain_id = 1");
        assert!(Config::load(&same, &no_environment).is_ok());
    }

    /// Claim: the oracle backend is refused when a route points at a destination that is not local, and it needs the name
    /// of its key variable.
    /// Why it matters: the oracle key signs proofs that only a development verifier accepts. A real chain must never trust it.
    #[test]
    fn the_oracle_backend_is_for_local_destinations_only() {
        let remote = SAMPLE.replace("http://127.0.0.1:8546", "https://rpc.example.net");
        let error = Config::load(&remote, &no_environment)
            .unwrap_err()
            .to_string();
        assert!(
            error.contains("only for a destination on the local machine"),
            "{error}"
        );
        let unnamed = SAMPLE.replace("oracle_key_env = \"ORACLE_KEY\"\n", "");
        let error = Config::load(&unnamed, &no_environment)
            .unwrap_err()
            .to_string();
        assert!(error.contains("oracle_key_env is required"), "{error}");
    }

    /// Claim: the webhook URL must use https, except on the local machine, and the targets cannot be empty.
    /// Why it matters: the bearer token travels in the request header.
    #[test]
    fn the_webhook_url_must_be_https_unless_it_is_local() {
        let with = |extra: &str| format!("{extra}\n{SAMPLE}");
        let plain = with("[handoff]\nwebhook_url = \"http://hooks.example.org/x\"");
        assert!(Config::load(&plain, &no_environment).is_err());
        let secure = with("[handoff]\nwebhook_url = \"https://hooks.example.org/x\"");
        assert!(Config::load(&secure, &no_environment).is_ok());
        let local = with("[handoff]\nwebhook_url = \"http://localhost:9000/x\"");
        assert!(Config::load(&local, &no_environment).is_ok());
        let empty = with("[handoff]\ntargets = []");
        assert!(Config::load(&empty, &no_environment).is_err());
    }

    /// Claim: only loopback hosts count as local.
    /// Why it matters: the oracle backend and plain http webhooks are allowed only when every endpoint is local.
    #[test]
    fn loopback_detection() {
        for url in [
            "http://127.0.0.1:8545",
            "http://localhost:8545/path",
            "http://[::1]:8545",
            "http://user@localhost",
        ] {
            assert!(is_loopback_url(url), "{url}");
        }
        for url in [
            "https://rpc.example.org",
            "http://127.0.0.1.example.org",
            "http://10.0.0.5:8545",
            "https://localhost.example.org",
        ] {
            assert!(!is_loopback_url(url), "{url}");
        }
    }
}
