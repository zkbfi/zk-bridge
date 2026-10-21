//! The command line: `run`, `once`, `status` and `withdraw`.
//!
//! The command line never carries a key. [`reject_secret_arguments`] runs before any parsing and refuses a flag
//! that names a secret, and any argument that looks like a 32-byte key. The only way to give a key is
//! `--private-key-env NAME`, which names an environment variable, and only when every RPC URL is local.

use crate::config::{Config, KeystoreConfig};
use crate::error::{Error, Result};
use crate::logging::Logger;
use crate::route::build_routes;
use crate::service::{Service, ServiceSettings};
use crate::signer::Signer;
use crate::store::Store;
use alloy_primitives::B256;
use clap::{Parser, Subcommand};
use std::path::PathBuf;
use std::time::Duration;

/// The prover service of the hardened bridge.
#[derive(Debug, Parser)]
#[command(name = "zk-bridge-prover", version, about)]
pub struct Cli {
    /// The TOML configuration file.
    #[arg(long, global = true, default_value = "prover.toml")]
    pub config: PathBuf,
    /// The name of an environment variable that holds the signing key. For local Anvil only.
    /// The command line never takes the key itself.
    #[arg(long, global = true, value_name = "NAME")]
    pub private_key_env: Option<String>,
    /// What to do.
    #[command(subcommand)]
    pub command: Command,
}

/// The subcommands.
#[derive(Debug, Subcommand)]
pub enum Command {
    /// Loop forever: one pass, a sleep, one pass.
    Run,
    /// One pass, then exit.
    Once,
    /// Print the state of every deposit.
    Status,
    /// Withdraw one deposit by hand. No proof is involved: the vault checks the evidence.
    Withdraw {
        /// The hash of the deposit transaction on the source chain.
        #[arg(long)]
        tx: String,
        /// The index of the `DepositInitiated` log inside the receipt of that transaction.
        #[arg(long)]
        log_index: u64,
    },
}

/// Flag names (without dashes, lower case) that name a secret.
const SECRET_FLAGS: [&str; 9] =
    ["private-key", "privatekey", "private_key", "key", "secret", "mnemonic", "password", "seed", "keystore-password"];

fn looks_like_key(value: &str) -> bool {
    let digits = value.strip_prefix("0x").unwrap_or(value);
    digits.len() == 64 && digits.chars().all(|character| character.is_ascii_hexdigit())
}

fn is_environment_name(value: &str) -> bool {
    let mut characters = value.chars();
    characters.next().is_some_and(|first| first.is_ascii_alphabetic() || first == '_')
        && characters.all(|character| character.is_ascii_alphanumeric() || character == '_')
}

fn refusal(reason: &str) -> Error {
    Error::SecretHandling(format!(
        "{reason}. The command line never takes a key. Use a Foundry keystore with a password file in the configuration, or --private-key-env NAME on local Anvil."
    ))
}

fn is_secret_flag(name: &str) -> bool {
    SECRET_FLAGS.contains(&name) || (name.contains("private-key") && name != "private-key-env")
}

fn check_flag(flag: &str) -> Result<()> {
    let (name, value) = match flag.split_once('=') {
        Some((name, value)) => (name.to_ascii_lowercase(), Some(value)),
        None => (flag.to_ascii_lowercase(), None),
    };
    if is_secret_flag(&name) {
        return Err(refusal(&format!("the flag --{name} is not accepted")));
    }
    let Some(value) = value else { return Ok(()) };
    if name == "private-key-env" {
        return check_environment_name(value);
    }
    if name != "tx" && looks_like_key(value) {
        return Err(refusal("an argument looks like a 32-byte key"));
    }
    Ok(())
}

fn check_value(argument: &str, previous: Option<&str>) -> Result<()> {
    if previous == Some("--private-key-env") {
        return check_environment_name(argument);
    }
    if previous == Some("--tx") {
        return Ok(());
    }
    if looks_like_key(argument) {
        return Err(refusal("an argument looks like a 32-byte key"));
    }
    Ok(())
}

fn check_environment_name(value: &str) -> Result<()> {
    if looks_like_key(value) || !is_environment_name(value) {
        return Err(refusal("--private-key-env takes the NAME of an environment variable, not a value"));
    }
    Ok(())
}

/// Refuses any argument that carries a secret. `arguments` includes the program name.
///
/// The value of `--tx` may be a 32-byte hash, so it is exempt from the key-shape rule.
///
/// # Errors
/// `Error::SecretHandling` for a secret flag or a key-shaped argument.
pub fn reject_secret_arguments(arguments: &[String]) -> Result<()> {
    let mut previous: Option<&str> = None;
    for argument in arguments.iter().skip(1) {
        match argument.strip_prefix("--") {
            Some(flag) => check_flag(flag)?,
            None => check_value(argument, previous)?,
        }
        previous = Some(argument.as_str());
    }
    Ok(())
}

/// Chooses the signer: the environment variable for local Anvil, else the keystore of the configuration.
///
/// # Errors
/// `Error::SecretHandling` when `--private-key-env` is used with a remote RPC URL. `Error::Config` when no signer
/// is configured. `Error::Signer` when the key cannot be read.
pub fn resolve_signer(
    config: &Config,
    private_key_env: Option<&str>,
    lookup: &dyn Fn(&str) -> Option<String>,
) -> Result<Signer> {
    if let Some(name) = private_key_env {
        if !config.is_local_only() {
            return Err(Error::SecretHandling(
                "--private-key-env is for local Anvil only: every rpc_url must be a loopback address".into(),
            ));
        }
        return Signer::from_environment(name, lookup);
    }
    let keystore = config
        .signer
        .as_ref()
        .ok_or_else(|| Error::Config("no [signer] section and no --private-key-env: the service has no key".into()))?;
    load_keystore(keystore)
}

/// The oracle signer: the `[oracle]` keystore when present, else the transaction signer.
///
/// # Errors
/// `Error::Signer` when the keystore cannot be read.
pub fn resolve_oracle(config: &Config, signer: &Signer) -> Result<Signer> {
    match &config.oracle {
        Some(keystore) => load_keystore(keystore),
        None => Ok(signer.clone()),
    }
}

fn load_keystore(keystore: &KeystoreConfig) -> Result<Signer> {
    Signer::from_keystore(&keystore.keystore, &keystore.password_file)
}

fn build_service(config: &Config, cli: &Cli, lookup: &dyn Fn(&str) -> Option<String>) -> Result<Service> {
    let signer = resolve_signer(config, cli.private_key_env.as_deref(), lookup)?;
    let oracle = resolve_oracle(config, &signer)?;
    let routes = build_routes(config, &signer, &oracle)?;
    let store = Store::open(&config.database_path)?;
    Ok(Service::new(store, Logger::standard(), ServiceSettings { max_attempts: config.max_attempts }, routes))
}

fn parse_hash(text: &str) -> Result<B256> {
    text.parse().map_err(|error| Error::Usage(format!("--tx: {error}")))
}

/// Runs the program. `arguments` includes the program name. Output goes to `out`.
///
/// # Errors
/// Any error of the subcommand.
pub fn execute(
    arguments: Vec<String>,
    lookup: &dyn Fn(&str) -> Option<String>,
    out: &mut dyn std::io::Write,
) -> Result<()> {
    reject_secret_arguments(&arguments)?;
    let cli = Cli::try_parse_from(&arguments).map_err(|error| Error::Usage(error.to_string()))?;
    let config = Config::load_file(&cli.config, lookup)?;
    match &cli.command {
        Command::Status => print_status(&config, out),
        Command::Once => build_service(&config, &cli, lookup)?.run_once(),
        Command::Run => {
            let mut service = build_service(&config, &cli, lookup)?;
            loop {
                service.run_once()?;
                std::thread::sleep(Duration::from_secs(config.poll_interval_seconds));
            }
        }
        Command::Withdraw { tx, log_index } => {
            let hash = parse_hash(tx)?;
            let nonce = build_service(&config, &cli, lookup)?.withdraw_one(hash, *log_index)?;
            writeln!(out, "deposit {nonce:#x} processed; run `status` to see its state").map_err(|e| Error::Usage(e.to_string()))
        }
    }
}

fn print_status(config: &Config, out: &mut dyn std::io::Write) -> Result<()> {
    let store = Store::open(&config.database_path)?;
    let deposits = store.list(None)?;
    for record in &deposits {
        let deposit = &record.deposit;
        let line = format!(
            "nonce={:#x} route={} state={} block={} amount={} recipient={:#x} attempts={} withdrawal_transaction={} note={}",
            deposit.nonce,
            deposit.route,
            record.state.as_str(),
            deposit.block_number,
            deposit.amount,
            deposit.recipient,
            record.attempts,
            record.withdrawal_transaction.map_or("none".to_string(), |hash| format!("{hash:#x}")),
            record.note.as_deref().unwrap_or("none").replace(' ', "_"),
        );
        writeln!(out, "{line}").map_err(|error| Error::Usage(error.to_string()))?;
    }
    writeln!(out, "deposits={}", deposits.len()).map_err(|error| Error::Usage(error.to_string()))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn args(parts: &[&str]) -> Vec<String> {
        parts.iter().map(|part| part.to_string()).collect()
    }

    const KEY: &str = "ac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80";

    /// Claim: a key on the command line is refused, in every form: a flag that names a secret, a flag with the
    /// value after `=`, and a bare 32-byte value, with or without `0x`.
    /// Why it matters: command lines land in shell history and process listings.
    #[test]
    fn a_key_on_the_command_line_is_refused() {
        let refused = [
            args(&["p", "once", "--private-key", KEY]),
            args(&["p", "once", &format!("--private-key={KEY}")]),
            args(&["p", "once", "--private-key-hex", "x"]),
            args(&["p", "once", "--mnemonic", "a b c"]),
            args(&["p", "once", "--password", "hunter2"]),
            args(&["p", "once", "--key", "x"]),
            args(&["p", "once", &format!("0x{KEY}")]),
            args(&["p", "once", KEY]),
            args(&["p", "--config", "c.toml", "once", "--config-secret", &format!("0x{KEY}")]),
            args(&["p", "once", "--private-key-env", KEY]),
            args(&["p", "once", &format!("--private-key-env=0x{KEY}")]),
            args(&["p", "once", "--private-key-env", "not a name"]),
        ];
        for arguments in refused {
            let error = reject_secret_arguments(&arguments).unwrap_err();
            assert!(matches!(error, Error::SecretHandling(_)), "{arguments:?} gave {error}");
            assert!(!error.to_string().contains(KEY), "the error must not echo the key");
        }
    }

    /// Claim: the allowed forms pass, including a transaction hash (32 bytes of hex) as the value of `--tx`.
    /// Why it matters: the guard must not block normal use.
    #[test]
    fn normal_arguments_pass() {
        let tx = format!("0x{KEY}");
        for arguments in [
            args(&["p", "--config", "c.toml", "once"]),
            args(&["p", "--config", "c.toml", "--private-key-env", "ANVIL_KEY", "once"]),
            args(&["p", "--config", "c.toml", "--private-key-env=ANVIL_KEY", "once"]),
            args(&["p", "--config", "c.toml", "withdraw", "--tx", &tx, "--log-index", "0"]),
            args(&["p", "--config", "c.toml", "withdraw", &format!("--tx={tx}"), "--log-index", "0"]),
        ] {
            reject_secret_arguments(&arguments).unwrap_or_else(|error| panic!("{arguments:?}: {error}"));
            Cli::try_parse_from(&arguments).unwrap_or_else(|error| panic!("{arguments:?}: {error}"));
        }
    }

    /// Claim: the old name `prove-withdrawal` is gone; the subcommand is `withdraw`.
    #[test]
    fn subcommands_are_run_once_status_withdraw() {
        for name in ["run", "once", "status"] {
            assert!(Cli::try_parse_from(["p", "--config", "c", name]).is_ok(), "{name}");
        }
        assert!(Cli::try_parse_from(["p", "--config", "c", "prove-withdrawal", "--tx", "0x1", "--log-index", "0"]).is_err());
    }

    /// Claim: `--private-key-env` is refused when any RPC URL is remote.
    /// Why it matters: an environment key must never sign for a real chain.
    #[test]
    fn environment_key_is_for_local_chains_only() {
        let remote = Config::load(crate::config::SAMPLE_FOR_TESTS, &|_: &str| None).unwrap();
        let lookup = |_: &str| Some(KEY.to_string());
        let error = resolve_signer(&remote, Some("ANVIL_KEY"), &lookup).unwrap_err();
        assert!(matches!(error, Error::SecretHandling(_)));

        let local_text = crate::config::SAMPLE_FOR_TESTS
            .replace("https://rpc.example.org", "http://127.0.0.1:8545")
            .replace("https://rpc.example.net", "http://localhost:8546");
        let local = Config::load(&local_text, &|_: &str| None).unwrap();
        let signer = resolve_signer(&local, Some("ANVIL_KEY"), &lookup).unwrap();
        assert_eq!(format!("{:#x}", signer.address()), "0xf39fd6e51aad88f6f4ce6ab8827279cfffb92266");
    }
}
