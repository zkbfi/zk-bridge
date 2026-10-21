//! TOML configuration with environment overrides and validation.
//!
//! The file holds no secret. A key named `private_key`, `mnemonic`, `password`, `secret` or `seed` anywhere in the
//! file is refused. The signing key comes from a Foundry keystore plus a password file (both named by path), or from
//! the environment variable that `--private-key-env` names, for local Anvil only.
//!
//! Environment overrides: `ZK_BRIDGE_PROVER_<PATH>` where `<PATH>` is the key path in capitals, with `_` for `.`.
//! For example `ZK_BRIDGE_PROVER_CHAIN_A_RPC_URL` or `ZK_BRIDGE_PROVER_POLL_INTERVAL_SECONDS`.

use crate::error::{Error, Result};
use crate::light_client::ChainKind;
use alloy_primitives::{Address, B256};
use serde::Deserialize;
use std::path::PathBuf;
use std::str::FromStr;

/// The prefix of every override variable.
pub const ENVIRONMENT_PREFIX: &str = "ZK_BRIDGE_PROVER_";

/// Key names that may never appear in the file.
const FORBIDDEN_KEYS: [&str; 6] = ["private_key", "privatekey", "mnemonic", "password", "secret", "seed"];

/// What an override sets.
#[derive(Clone, Copy)]
enum Kind {
    Text,
    Integer,
}

/// Every key that an environment variable may override.
const OVERRIDES: [(&str, Kind); 19] = [
    ("database_path", Kind::Text),
    ("poll_interval_seconds", Kind::Integer),
    ("receipt_timeout_seconds", Kind::Integer),
    ("prover.program_vkey", Kind::Text),
    ("chain_a.rpc_url", Kind::Text),
    ("chain_a.chain_id", Kind::Integer),
    ("chain_a.vault", Kind::Text),
    ("chain_a.light_client", Kind::Text),
    ("chain_a.own_light_client", Kind::Text),
    ("chain_a.beacon.url", Kind::Text),
    ("chain_a.beacon.finality_depth", Kind::Integer),
    ("chain_b.rpc_url", Kind::Text),
    ("chain_b.chain_id", Kind::Integer),
    ("chain_b.vault", Kind::Text),
    ("chain_b.light_client", Kind::Text),
    ("chain_b.own_light_client", Kind::Text),
    ("chain_b.beacon.url", Kind::Text),
    ("chain_b.beacon.finality_depth", Kind::Integer),
    ("max_attempts", Kind::Integer),
];

/// A route is one direction: deposits on the source chain, withdrawals on the destination chain.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Deserialize)]
pub enum RouteName {
    /// Deposits on chain A, withdrawals on chain B.
    #[serde(rename = "a_to_b")]
    AToB,
    /// Deposits on chain B, withdrawals on chain A.
    #[serde(rename = "b_to_a")]
    BToA,
}

impl RouteName {
    /// The stored and logged name.
    pub fn as_str(self) -> &'static str {
        match self {
            Self::AToB => "a_to_b",
            Self::BToA => "b_to_a",
        }
    }
}

/// A keystore and the file that holds its password.
#[derive(Clone, Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct KeystoreConfig {
    /// The path of the Foundry keystore file.
    pub keystore: PathBuf,
    /// The path of a file that holds the password.
    pub password_file: PathBuf,
}

/// The proving backend.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Deserialize)]
pub enum ProverBackend {
    /// The development backend that signs with the oracle key.
    #[serde(rename = "oracle")]
    Oracle,
    /// The production backend (cargo feature `sp1`).
    #[serde(rename = "sp1")]
    Sp1,
}

/// The `[prover]` section.
#[derive(Clone, Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ProverConfig {
    /// The backend.
    pub backend: ProverBackend,
    /// The verification key of the light-client program. The service checks it against `programVKey()` of the light
    /// client contract before it proves anything.
    pub program_vkey: String,
    /// The compiled guest program, for the `sp1` backend.
    #[serde(default)]
    pub sp1_elf_path: Option<PathBuf>,
}

/// Where beacon data comes from.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Deserialize)]
pub enum BeaconKind {
    /// A standard beacon API.
    #[serde(rename = "http")]
    Http,
    /// A depth rule on an Anvil chain, which has no beacon chain.
    #[serde(rename = "dev")]
    Dev,
}

/// The `[chain_x.beacon]` section. It describes the beacon chain of the chain it sits in.
#[derive(Clone, Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct BeaconConfig {
    /// `http` or `dev`.
    pub kind: BeaconKind,
    /// The base URL of the beacon API (kind `http`).
    #[serde(default)]
    pub url: Option<String>,
    /// `pulsechain` or `ethereum`: which `lc-core` chain specification applies.
    pub chain: String,
    /// The number of blocks below the latest that count as final (kind `dev`).
    #[serde(default)]
    pub finality_depth: Option<u64>,
    /// The beacon slot of execution block 0 in the synthetic chain (kind `dev`). It must lie above the checkpoint
    /// slot of the light client and after the Capella fork. Default 1024.
    #[serde(default)]
    pub slot_offset: Option<u64>,
}

/// One chain.
#[derive(Clone, Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ChainConfig {
    /// A short name for logs.
    pub name: String,
    /// The execution RPC URL.
    pub rpc_url: String,
    /// The block where the contracts were deployed. Scans start here. Default 0.
    #[serde(default)]
    pub start_block: u64,
    /// The chain identifier. The service checks it against `eth_chainId`.
    pub chain_id: u64,
    /// The `BridgeVault` on this chain.
    pub vault: String,
    /// The `BeaconLightClient` on this chain. It tracks the OTHER chain's beacon chain.
    pub light_client: String,
    /// The `BeaconLightClient` of THIS chain's own beacon chain, deployed on this chain. Optional. The fork registry
    /// of a gate in registry mode reads it for freshness and for the start of an observation. When it is set, every
    /// route that reads deposits from this chain also keeps it current, with the beacon updates that the route fetches
    /// for the other direction.
    #[serde(default)]
    pub own_light_client: Option<String>,
    /// The beacon chain of this chain (the source of deposits made here).
    pub beacon: BeaconConfig,
}

fn default_poll() -> u64 {
    12
}
fn default_receipt_timeout() -> u64 {
    60
}
fn default_attempts() -> u32 {
    5
}
fn default_log_range() -> u64 {
    2_000
}
fn default_routes() -> Vec<RouteName> {
    vec![RouteName::AToB, RouteName::BToA]
}

/// The whole configuration.
#[derive(Clone, Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Config {
    /// The SQLite file.
    pub database_path: PathBuf,
    /// Seconds between two passes of `run`.
    #[serde(default = "default_poll")]
    pub poll_interval_seconds: u64,
    /// Seconds to wait for a receipt inside one pass.
    #[serde(default = "default_receipt_timeout")]
    pub receipt_timeout_seconds: u64,
    /// How many failed attempts a deposit gets before it is marked failed.
    #[serde(default = "default_attempts")]
    pub max_attempts: u32,
    /// The largest block range of one `eth_getLogs` call.
    #[serde(default = "default_log_range")]
    pub log_block_range: u64,
    /// The transaction signer (not needed with `--private-key-env`).
    #[serde(default)]
    pub signer: Option<KeystoreConfig>,
    /// The oracle signer. Defaults to the transaction signer.
    #[serde(default)]
    pub oracle: Option<KeystoreConfig>,
    /// The proving backend.
    pub prover: ProverConfig,
    /// Chain A.
    pub chain_a: ChainConfig,
    /// Chain B.
    pub chain_b: ChainConfig,
    /// The routes to serve. Default both.
    #[serde(default = "default_routes")]
    pub routes: Vec<RouteName>,
}

impl ChainConfig {
    /// The vault address.
    pub fn vault_address(&self) -> Result<Address> {
        parse_address(&self.vault, &format!("{}.vault", self.name))
    }

    /// The light client address.
    pub fn light_client_address(&self) -> Result<Address> {
        parse_address(&self.light_client, &format!("{}.light_client", self.name))
    }

    /// The own-chain light client address, or `None` when the chain has none configured.
    pub fn own_light_client_address(&self) -> Result<Option<Address>> {
        let Some(text) = &self.own_light_client else {
            return Ok(None);
        };
        parse_address(text, &format!("{}.own_light_client", self.name)).map(Some)
    }

    /// The `lc-core` chain kind of this chain's beacon chain.
    pub fn chain_kind(&self) -> Result<ChainKind> {
        match self.beacon.chain.as_str() {
            "pulsechain" => Ok(ChainKind::Pulsechain),
            "ethereum" => Ok(ChainKind::Ethereum),
            other => Err(Error::Config(format!("{}.beacon.chain: unknown chain {other}", self.name))),
        }
    }
}

impl ProverConfig {
    /// The program verification key.
    pub fn program_vkey_value(&self) -> Result<B256> {
        B256::from_str(&self.program_vkey).map_err(|error| Error::Config(format!("prover.program_vkey: {error}")))
    }
}

fn parse_address(text: &str, key: &str) -> Result<Address> {
    let address = Address::from_str(text).map_err(|error| Error::Config(format!("{key}: {error}")))?;
    if address == Address::ZERO {
        return Err(Error::Config(format!("{key}: the zero address")));
    }
    Ok(address)
}

/// Whether a URL points at the local machine.
pub fn is_loopback_url(url: &str) -> bool {
    let rest = url.split_once("://").map_or(url, |(_, rest)| rest);
    let authority = rest.split(['/', '?']).next().unwrap_or("");
    let host = authority.rsplit_once('@').map_or(authority, |(_, host)| host);
    let host = match host.strip_prefix('[') {
        Some(inner) => inner.split(']').next().unwrap_or(""),
        None => host.split(':').next().unwrap_or(""),
    };
    host == "localhost"
        || host.parse::<std::net::Ipv4Addr>().is_ok_and(|address| address.is_loopback())
        || host.parse::<std::net::Ipv6Addr>().is_ok_and(|address| address.is_loopback())
}

fn refuse_secret_keys(value: &toml::Value, path: &str) -> Result<()> {
    let Some(table) = value.as_table() else {
        return Ok(());
    };
    for (key, child) in table {
        let lowered = key.to_ascii_lowercase();
        if FORBIDDEN_KEYS.contains(&lowered.as_str()) {
            return Err(Error::SecretHandling(format!(
                "the key `{path}{key}` is not allowed: put a keystore and a password file path in the configuration, never a secret"
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
        let mut table: toml::Table = text.parse().map_err(|error| Error::Config(format!("not valid TOML: {error}")))?;
        refuse_secret_keys(&toml::Value::Table(table.clone()), "")?;
        for (path, kind) in OVERRIDES {
            let name = format!("{ENVIRONMENT_PREFIX}{}", path.to_ascii_uppercase().replace('.', "_"));
            let Some(raw) = lookup(&name) else { continue };
            let value = match kind {
                Kind::Text => toml::Value::String(raw),
                Kind::Integer => toml::Value::Integer(
                    raw.trim().parse().map_err(|_| Error::Config(format!("{name}: expected an integer")))?,
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
    pub fn load_file(path: &std::path::Path, lookup: &dyn Fn(&str) -> Option<String>) -> Result<Self> {
        let text = std::fs::read_to_string(path)
            .map_err(|error| Error::Config(format!("cannot read {}: {error}", path.display())))?;
        Self::load(&text, lookup)
    }

    /// Checks every value that can be checked without a network.
    ///
    /// # Errors
    /// `Error::Config` naming the key.
    pub fn validate(&self) -> Result<()> {
        if self.poll_interval_seconds == 0 {
            return Err(Error::Config("poll_interval_seconds must be at least 1".into()));
        }
        if self.max_attempts == 0 {
            return Err(Error::Config("max_attempts must be at least 1".into()));
        }
        if self.log_block_range == 0 {
            return Err(Error::Config("log_block_range must be at least 1".into()));
        }
        if self.routes.is_empty() {
            return Err(Error::Config("routes must name at least one route".into()));
        }
        if self.chain_a.chain_id == 0 || self.chain_b.chain_id == 0 {
            return Err(Error::Config("chain_id must not be zero".into()));
        }
        if self.chain_a.chain_id == self.chain_b.chain_id {
            return Err(Error::Config(format!("both chains have chain_id {}", self.chain_a.chain_id)));
        }
        if self.chain_a.name == self.chain_b.name {
            return Err(Error::Config("the two chains need different names".into()));
        }
        let vkey = self.prover.program_vkey_value()?;
        if vkey == B256::ZERO {
            return Err(Error::Config("prover.program_vkey is zero".into()));
        }
        if self.prover.backend == ProverBackend::Sp1 && self.prover.sp1_elf_path.is_none() {
            return Err(Error::Config("prover.sp1_elf_path is required for the sp1 backend".into()));
        }
        for chain in [&self.chain_a, &self.chain_b] {
            Self::validate_chain(chain)?;
        }
        Ok(())
    }

    fn validate_chain(chain: &ChainConfig) -> Result<()> {
        let name = &chain.name;
        if !(chain.rpc_url.starts_with("http://") || chain.rpc_url.starts_with("https://")) {
            return Err(Error::Config(format!("{name}.rpc_url must start with http:// or https://")));
        }
        let vault = chain.vault_address()?;
        let light_client = chain.light_client_address()?;
        if vault == light_client {
            return Err(Error::Config(format!("{name}: vault and light_client are the same address")));
        }
        if chain.own_light_client_address()?.is_some_and(|own| own == vault || own == light_client) {
            return Err(Error::Config(format!("{name}: own_light_client is the same address as the vault or the light_client")));
        }
        chain.chain_kind()?;
        match chain.beacon.kind {
            BeaconKind::Http => {
                let url = chain.beacon.url.as_deref().unwrap_or("");
                if !(url.starts_with("http://") || url.starts_with("https://")) {
                    return Err(Error::Config(format!("{name}.beacon.url is required for kind http")));
                }
            }
            BeaconKind::Dev => {
                if chain.beacon.finality_depth.is_none() {
                    return Err(Error::Config(format!("{name}.beacon.finality_depth is required for kind dev")));
                }
                if !is_loopback_url(&chain.rpc_url) {
                    return Err(Error::Config(format!("{name}: the dev beacon source works only on a local chain")));
                }
            }
        }
        Ok(())
    }

    /// The chain that a route reads deposits from.
    pub fn source_of(&self, route: RouteName) -> &ChainConfig {
        match route {
            RouteName::AToB => &self.chain_a,
            RouteName::BToA => &self.chain_b,
        }
    }

    /// The chain that a route withdraws on.
    pub fn destination_of(&self, route: RouteName) -> &ChainConfig {
        match route {
            RouteName::AToB => &self.chain_b,
            RouteName::BToA => &self.chain_a,
        }
    }

    /// Whether every RPC URL is local. Only then may `--private-key-env` be used.
    pub fn is_local_only(&self) -> bool {
        is_loopback_url(&self.chain_a.rpc_url) && is_loopback_url(&self.chain_b.rpc_url)
    }
}

/// A complete configuration for tests.
#[cfg(test)]
pub(crate) const SAMPLE_FOR_TESTS: &str = r#"
database_path = "prover.sqlite"

[prover]
backend = "oracle"
program_vkey = "0x0000000000000000000000000000000000000000000000000000000000001234"

[signer]
keystore = "keys/prover.json"
password_file = "keys/prover.password"

[chain_a]
name = "ethereum"
rpc_url = "https://rpc.example.org"
chain_id = 1
vault = "0x1111111111111111111111111111111111111111"
light_client = "0x2222222222222222222222222222222222222222"
[chain_a.beacon]
kind = "http"
url = "https://beacon.example.org"
chain = "ethereum"

[chain_b]
name = "pulsechain"
rpc_url = "https://rpc.example.net"
chain_id = 369
vault = "0x3333333333333333333333333333333333333333"
light_client = "0x4444444444444444444444444444444444444444"
[chain_b.beacon]
kind = "http"
url = "https://beacon.example.net"
chain = "pulsechain"
"#;

#[cfg(test)]
mod tests {
    use super::*;

    const SAMPLE: &str = SAMPLE_FOR_TESTS;

    fn no_environment(_: &str) -> Option<String> {
        None
    }

    /// Claim: a complete file loads, and unset keys take their defaults.
    #[test]
    fn sample_loads_with_defaults() {
        let config = Config::load(SAMPLE, &no_environment).unwrap();
        assert_eq!(config.poll_interval_seconds, 12);
        assert_eq!(config.routes, vec![RouteName::AToB, RouteName::BToA]);
        assert_eq!(config.destination_of(RouteName::AToB).chain_id, 369);
        assert!(!config.is_local_only());
    }

    /// Claim: environment variables override file values, with the right type.
    /// Why it matters: operators change URLs and ids without editing the file.
    #[test]
    fn environment_overrides_the_file() {
        let lookup = |name: &str| match name {
            "ZK_BRIDGE_PROVER_CHAIN_B_RPC_URL" => Some("http://127.0.0.1:8546".to_string()),
            "ZK_BRIDGE_PROVER_POLL_INTERVAL_SECONDS" => Some("3".to_string()),
            "ZK_BRIDGE_PROVER_CHAIN_A_BEACON_FINALITY_DEPTH" => Some("4".to_string()),
            _ => None,
        };
        let config = Config::load(SAMPLE, &lookup).unwrap();
        assert_eq!(config.chain_b.rpc_url, "http://127.0.0.1:8546");
        assert_eq!(config.poll_interval_seconds, 3);
        assert_eq!(config.chain_a.beacon.finality_depth, Some(4));
        let bad = |name: &str| (name == "ZK_BRIDGE_PROVER_POLL_INTERVAL_SECONDS").then(|| "soon".to_string());
        assert!(Config::load(SAMPLE, &bad).unwrap_err().to_string().contains("expected an integer"));
    }

    /// Claim: a secret in the file is refused, at any depth, whatever the letter case.
    /// Why it matters: a configuration file is often committed or copied. It must never hold a key.
    #[test]
    fn secrets_in_the_file_are_refused() {
        for line in ["private_key = \"0xabc\"", "Mnemonic = \"a b c\"", "[signer.extra]\npassword = \"x\""] {
            let text = SAMPLE.replace("[prover]", &format!("{line}\n[prover]"));
            let text = if line.starts_with('[') { format!("{SAMPLE}\n{line}") } else { text };
            let error = Config::load(&text, &no_environment).unwrap_err();
            assert!(matches!(error, Error::SecretHandling(_)), "{line}: {error}");
        }
    }

    /// Claim: bad values are refused with the key named: equal chain ids, a zero address, a missing beacon URL,
    /// a vault that equals the light client, an unknown key, and a dev beacon on a remote chain.
    #[test]
    fn invalid_values_are_refused() {
        let cases = [
            ("chain_id = 369", "chain_id = 1", "both chains have chain_id"),
            ("vault = \"0x3333333333333333333333333333333333333333\"", "vault = \"0x0000000000000000000000000000000000000000\"", "zero address"),
            ("url = \"https://beacon.example.net\"", "", "beacon.url is required"),
            ("light_client = \"0x4444444444444444444444444444444444444444\"", "light_client = \"0x3333333333333333333333333333333333333333\"", "same address"),
            ("backend = \"oracle\"", "backend = \"oracle\"\nunknown_key = 1", "unknown field"),
        ];
        for (from, to, expected) in cases {
            let text = SAMPLE.replace(from, to);
            let error = Config::load(&text, &no_environment).unwrap_err().to_string();
            assert!(error.contains(expected), "expected `{expected}` in `{error}`");
        }
        let dev = SAMPLE.replace("kind = \"http\"\nurl = \"https://beacon.example.net\"", "kind = \"dev\"\nfinality_depth = 2");
        assert!(Config::load(&dev, &no_environment).unwrap_err().to_string().contains("only on a local chain"));
    }

    /// Claim: the own-chain light client is optional, parses when set, and may not repeat the vault or the light
    /// client. An environment variable can set it.
    /// Why it matters: a repeated address would send light-client updates to the wrong contract.
    #[test]
    fn own_light_client_is_optional_and_checked() {
        let config = Config::load(SAMPLE, &no_environment).unwrap();
        assert_eq!(config.chain_a.own_light_client_address().unwrap(), None);
        let with_own = SAMPLE.replace(
            "light_client = \"0x4444444444444444444444444444444444444444\"",
            "light_client = \"0x4444444444444444444444444444444444444444\"\nown_light_client = \"0x5555555555555555555555555555555555555555\"",
        );
        let config = Config::load(&with_own, &no_environment).unwrap();
        assert_eq!(config.chain_b.own_light_client_address().unwrap(), Some(Address::repeat_byte(0x55)));
        assert_eq!(config.chain_a.own_light_client_address().unwrap(), None);
        let lookup = |name: &str| (name == "ZK_BRIDGE_PROVER_CHAIN_A_OWN_LIGHT_CLIENT").then(|| "0x6666666666666666666666666666666666666666".to_string());
        let config = Config::load(SAMPLE, &lookup).unwrap();
        assert_eq!(config.chain_a.own_light_client_address().unwrap(), Some(Address::repeat_byte(0x66)));
        for repeated in ["0x3333333333333333333333333333333333333333", "0x4444444444444444444444444444444444444444"] {
            let text = with_own.replace("0x5555555555555555555555555555555555555555", repeated);
            let error = Config::load(&text, &no_environment).unwrap_err().to_string();
            assert!(error.contains("own_light_client is the same address"), "{error}");
        }
        let zero = with_own.replace("0x5555555555555555555555555555555555555555", "0x0000000000000000000000000000000000000000");
        assert!(Config::load(&zero, &no_environment).unwrap_err().to_string().contains("zero address"));
    }

    /// Claim: only loopback hosts count as local.
    /// Why it matters: `--private-key-env` is allowed only when every endpoint is local.
    #[test]
    fn loopback_detection() {
        for url in ["http://127.0.0.1:8545", "http://localhost:8545/path", "http://[::1]:8545", "http://user@localhost"] {
            assert!(is_loopback_url(url), "{url}");
        }
        for url in ["https://rpc.example.org", "http://127.0.0.1.example.org", "http://10.0.0.5:8545", "https://localhost.example.org"] {
            assert!(!is_loopback_url(url), "{url}");
        }
    }
}
