//! The command line: `prove` and `evidence`.
//!
//! Both commands are stateless. They read configuration, chains and a beacon node, print or post one JSON object, and exit.
//! Neither one takes a key, sends a transaction or opens a file for writing. The only secrets they use are named by
//! environment variables in the configuration file (see `config.rs`).
//!
//! Exit codes of `prove`: [`EXIT_PROOF_PRODUCED`] when it made a proof and handed it off, [`EXIT_UP_TO_DATE`] when the
//! starting head already is the newest final header and there is nothing to prove, and 1 for an error. `evidence` returns
//! 0 or 1.

use crate::beacon::http::HttpBeaconSource;
use crate::beacon::StoredHead;
use crate::chain::ChainClient;
use crate::config::{
    Config, DestinationConfig, HandoffTarget, ProverBackend, ProverConfig, RouteConfig,
};
use crate::error::{Error, Result};
use crate::evidence::{build_evidence, EvidenceRequest};
use crate::handoff::{Handoff, PackageDestination};
use crate::light_client::ChainKind;
use crate::logging::Logger;
use crate::produce::{produce, ProduceRequest, Production, EXPLICIT_HEAD_ROUTE};
use crate::prover::{OracleProver, Prover};
use crate::rpc::{HttpClient, HttpRpc};
use crate::signer::Signer;
use crate::stored::{read_stored_state, StoredState};
use alloy_primitives::B256;
use clap::{Args, Parser, Subcommand};
use std::path::PathBuf;
use std::str::FromStr;
use std::time::{SystemTime, UNIX_EPOCH};

/// The exit code of `prove` when it made a proof and handed it off.
pub const EXIT_PROOF_PRODUCED: i32 = 0;

/// The exit code of `prove` when the starting head already is the newest final header. Nothing was proven or handed off.
pub const EXIT_UP_TO_DATE: i32 = 3;

/// The stateless proof producer of the hardened bridge.
#[derive(Debug, Parser)]
#[command(name = "zk-bridge-prover", version, about)]
pub struct Cli {
    /// The TOML configuration file.
    #[arg(long, global = true, default_value = "prover.toml")]
    pub config: PathBuf,
    /// What to do.
    #[command(subcommand)]
    pub command: Command,
}

/// The subcommands.
#[derive(Debug, Subcommand)]
pub enum Command {
    /// Make one proof of a light-client update and hand it off.
    ///
    /// The update runs from the starting head to the newest final header of the source beacon chain (a fold of up to 64
    /// updates). The starting head is the head that the destination light client stores, or the head that --head-slot and
    /// --head-root give. The result is one JSON object (see docs/server-prover.md) on standard output, at the webhook of
    /// the configuration, or both.
    ///
    /// Exit code 0: a proof was made and handed off. Exit code 3: the starting head already is the newest final header, so
    /// there is nothing to prove. Exit code 1: an error.
    Prove(ProveArguments),
    /// Print the evidence that delivers one message, as one JSON object.
    ///
    /// The message is named by the hash of its source transaction and the index of its log inside the receipt. The object
    /// holds the calldata of `executeMessage`, and the layout calls that must go first when the bridge lacks a row. The
    /// command sends nothing: a stateful server sends the calls.
    Evidence(EvidenceArguments),
}

/// The arguments of `prove`.
#[derive(Debug, Args)]
pub struct ProveArguments {
    /// The route of the configuration. It may be left out when the file has exactly one route and no other source is given.
    #[arg(long)]
    pub route: Option<String>,
    /// The beacon API of the source chain, when no route is given.
    #[arg(long, conflicts_with = "route", requires_all = ["chain", "head_slot"])]
    pub beacon_url: Option<String>,
    /// The chain kind of the source beacon chain (`ethereum` or `pulsechain`), when no route is given.
    #[arg(long, conflicts_with = "route")]
    pub chain: Option<String>,
    /// The slot of the starting head. With it, the command reads nothing from the destination chain.
    #[arg(long, requires = "head_root")]
    pub head_slot: Option<u64>,
    /// The header root of the starting head.
    #[arg(long, requires = "head_slot")]
    pub head_root: Option<String>,
    /// The committee hash that the light client stores for the period after the starting head. Default: zero, which means
    /// that the light client holds no next committee.
    #[arg(long, requires = "head_slot")]
    pub next_committee_hash: Option<String>,
    /// The program key to prove for, when the starting head is explicit. Default: `prover.program_vkey` of the file.
    #[arg(long, requires = "head_slot")]
    pub program_vkey: Option<String>,
    /// Where to put the result. Repeat the flag for several targets. Default: the targets of the file.
    #[arg(long = "to", value_enum)]
    pub targets: Vec<HandoffTarget>,
}

/// The arguments of `evidence`.
#[derive(Debug, Args)]
pub struct EvidenceArguments {
    /// The route of the configuration. It may be left out when the file has exactly one route.
    #[arg(long)]
    pub route: Option<String>,
    /// The hash of the transaction on the source chain that sent the message.
    #[arg(long)]
    pub tx: String,
    /// The index of the `UserRequestForAffirmation` log inside the receipt of that transaction.
    #[arg(long)]
    pub log_index: u64,
    /// The slot of the stored header to anchor at. Default: the head of the light client.
    #[arg(long)]
    pub anchor_slot: Option<u64>,
}

/// Where the starting head of a `prove` run comes from.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum StartingPoint {
    /// The destination light client stores it. The run reads it with view calls.
    OnChain,
    /// The command line gave it.
    Explicit { head: StoredHead, program_key: B256 },
}

/// Everything `prove` needs from the arguments and the file, before any network call.
#[derive(Clone, Debug)]
struct ProvePlan {
    route_name: String,
    beacon_url: String,
    chain: ChainKind,
    destination: Option<DestinationConfig>,
    starting_point: StartingPoint,
}

fn parse_hash(text: &str, flag: &str) -> Result<B256> {
    B256::from_str(text).map_err(|error| Error::Usage(format!("{flag}: {error}")))
}

/// Chooses the source, the destination and the starting point of a `prove` run.
///
/// # Errors
/// `Error::Usage` for flags that do not fit together or a route that cannot be chosen. `Error::Config` when an explicit
/// head has no program key.
fn plan_prove(config: &Config, arguments: &ProveArguments) -> Result<ProvePlan> {
    let (route_name, source_url, chain, destination) = match &arguments.beacon_url {
        Some(url) => {
            let name = arguments.chain.as_deref().unwrap_or_default();
            let chain = ChainKind::from_name(name).ok_or_else(|| {
                Error::Usage(format!(
                    "--chain: unknown chain `{name}`; use ethereum or pulsechain"
                ))
            })?;
            (EXPLICIT_HEAD_ROUTE.to_string(), url.clone(), chain, None)
        }
        None => {
            let (name, route) = config.route(arguments.route.as_deref())?;
            (
                name.to_string(),
                route.source.beacon_url.clone(),
                route.source.chain_kind()?,
                Some(route.destination.clone()),
            )
        }
    };
    let starting_point = match (arguments.head_slot, &arguments.head_root) {
        (Some(slot), Some(root)) => StartingPoint::Explicit {
            head: StoredHead {
                slot,
                root: parse_hash(root, "--head-root")?,
                next_committee_hash: arguments
                    .next_committee_hash
                    .as_deref()
                    .map_or(Ok(B256::ZERO), |text| {
                        parse_hash(text, "--next-committee-hash")
                    })?,
            },
            program_key: explicit_program_key(config, arguments)?,
        },
        _ if destination.is_none() => {
            return Err(Error::Usage(
                "without a route, --beacon-url needs --head-slot and --head-root".into(),
            ))
        }
        _ => StartingPoint::OnChain,
    };
    if starting_point == StartingPoint::OnChain && arguments.program_vkey.is_some() {
        return Err(Error::Usage(
            "--program-vkey is for an explicit head; with a route the key comes from the light client".into(),
        ));
    }
    Ok(ProvePlan {
        route_name,
        beacon_url: source_url,
        chain,
        destination,
        starting_point,
    })
}

fn explicit_program_key(config: &Config, arguments: &ProveArguments) -> Result<B256> {
    if let Some(text) = &arguments.program_vkey {
        return parse_hash(text, "--program-vkey");
    }
    config
        .prover_config()?
        .program_vkey_value()?
        .ok_or_else(|| {
            Error::Config(
                "an explicit head needs a program key: pass --program-vkey or set prover.program_vkey".into(),
            )
        })
}

/// Builds the backend of the `[prover]` section. A secret comes from the environment through `lookup`.
///
/// # Errors
/// `Error::Config` for a missing ELF path, a missing variable, or a backend that this build lacks.
pub fn build_prover(
    config: &ProverConfig,
    lookup: &dyn Fn(&str) -> Option<String>,
) -> Result<Box<dyn Prover>> {
    match config.backend {
        ProverBackend::Oracle => {
            let variable = config.oracle_key_env.as_deref().ok_or_else(|| {
                Error::Config("prover.oracle_key_env is required for the oracle backend".into())
            })?;
            Ok(Box::new(OracleProver::new(Signer::from_environment(
                variable, lookup,
            )?)))
        }
        ProverBackend::Remote => Ok(Box::new(crate::remote::RemoteProver::from_config(
            config,
            lookup,
            Logger::standard(),
        )?)),
        #[cfg(feature = "sp1")]
        ProverBackend::Sp1 => {
            let light_client = config.sp1_elf_path.clone().ok_or_else(|| {
                Error::Config("prover.sp1_elf_path is required for the sp1 backend".into())
            })?;
            Ok(Box::new(crate::prover::Sp1Prover::load(
                &crate::prover::Sp1ProgramPaths {
                    light_client,
                    fork_observation: config.sp1_observation_elf_path.clone(),
                },
            )?))
        }
        #[cfg(not(feature = "sp1"))]
        ProverBackend::Sp1 => Err(Error::Config(
            "prover.backend = \"sp1\" needs a build with the cargo feature `sp1` (see the documentation in src/prover.rs)".into(),
        )),
    }
}

fn beacon_source(chain: ChainKind, url: &str) -> HttpBeaconSource {
    HttpBeaconSource::new(chain, Box::new(HttpClient::new(url)))
}

fn connect(name: &str, chain_id: u64, rpc_url: &str) -> Result<ChainClient> {
    ChainClient::connect(name, chain_id, Box::new(HttpRpc::new(rpc_url)))
}

fn now_unix_seconds() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|elapsed| elapsed.as_secs())
        .unwrap_or(0)
}

/// The starting head, the program key to prove for, and, when the run read the light client, its full state.
struct ResolvedStart {
    head: StoredHead,
    program_key: B256,
    stored: Option<StoredState>,
}

/// Fails when the file sets a program key and the light client stores another one.
fn require_same_key(configured: Option<B256>, onchain: B256) -> Result<()> {
    match configured {
        Some(key) if key != onchain => Err(Error::Config(format!(
            "prover.program_vkey is {key:#x}, but the light client stores {onchain:#x}"
        ))),
        _ => Ok(()),
    }
}

/// Reads the starting head and the program key. An on-chain start reads the light client.
fn resolve_start(plan: &ProvePlan, config: &Config) -> Result<ResolvedStart> {
    let StartingPoint::Explicit { head, program_key } = plan.starting_point else {
        return resolve_start_on_chain(plan, config);
    };
    Ok(ResolvedStart {
        head,
        program_key,
        stored: None,
    })
}

fn resolve_start_on_chain(plan: &ProvePlan, config: &Config) -> Result<ResolvedStart> {
    let destination = plan
        .destination
        .as_ref()
        .ok_or_else(|| Error::Usage("an on-chain start needs a route".into()))?;
    let client = connect("destination", destination.chain_id, &destination.rpc_url)?;
    let stored = read_stored_state(&client, destination.light_client_address()?)?;
    require_same_key(
        config.prover_config()?.program_vkey_value()?,
        stored.program_key,
    )?;
    Ok(ResolvedStart {
        head: stored.head,
        program_key: stored.program_key,
        stored: Some(stored),
    })
}

fn package_destination(destination: &DestinationConfig) -> Result<PackageDestination> {
    Ok(PackageDestination {
        chain_id: destination.chain_id,
        light_client: format!("{:#x}", destination.light_client_address()?),
    })
}

fn run_prove(
    config: &Config,
    arguments: &ProveArguments,
    lookup: &dyn Fn(&str) -> Option<String>,
    out: &mut dyn std::io::Write,
) -> Result<i32> {
    let logger = Logger::standard();
    let plan = plan_prove(config, arguments)?;
    // Resolve the targets first: a missing token variable should fail before a proof costs anything.
    let handoff = Handoff::resolve(&config.handoff, &arguments.targets, lookup)?;
    let prover_config = config.prover_config()?;
    let start = resolve_start(&plan, config)?;
    let prover = build_prover(prover_config, lookup)?;
    let request = ProduceRequest {
        route: plan.route_name.clone(),
        backend: prover_config.backend,
        program_key: start.program_key,
        head: start.head,
        stored: start.stored,
        destination: plan
            .destination
            .as_ref()
            .map(package_destination)
            .transpose()?,
        now_unix_seconds: now_unix_seconds(),
    };
    logger.info(
        "prove_started",
        &[
            ("route", plan.route_name.clone()),
            ("backend", prover.name().to_string()),
            ("start_head_slot", start.head.slot.to_string()),
        ],
    );
    let source = beacon_source(plan.chain, &plan.beacon_url);
    match produce(&source, prover.as_ref(), &request)? {
        Production::UpToDate { head_slot } => {
            logger.info("up_to_date", &[("head_slot", head_slot.to_string())]);
            Ok(EXIT_UP_TO_DATE)
        }
        Production::Proof(package) => {
            handoff.deliver(&package, out, &logger)?;
            logger.info(
                "proof_handed_off",
                &[("new_head_slot", package.new_head_slot.to_string())],
            );
            Ok(EXIT_PROOF_PRODUCED)
        }
    }
}

fn run_evidence(
    config: &Config,
    arguments: &EvidenceArguments,
    out: &mut dyn std::io::Write,
) -> Result<i32> {
    let (name, route) = config.route(arguments.route.as_deref())?;
    let transaction = parse_hash(&arguments.tx, "--tx")?;
    let source = connect(
        "source",
        route.source.chain_id,
        route.source.execution_url()?,
    )?;
    let destination = connect(
        "destination",
        route.destination.chain_id,
        &route.destination.rpc_url,
    )?;
    let beacon = beacon_source(route.source.chain_kind()?, &route.source.beacon_url);
    let evidence = build_evidence(&evidence_request(
        name,
        route,
        &EvidenceClients {
            source: &source,
            destination: &destination,
            beacon: &beacon,
        },
        arguments,
        transaction,
    )?)?;
    let line = serde_json::to_string(&evidence)
        .map_err(|error| Error::Usage(format!("cannot encode the evidence: {error}")))?;
    writeln!(out, "{line}")
        .map_err(|error| Error::Usage(format!("cannot write the evidence: {error}")))?;
    Ok(0)
}

/// The three clients that the evidence builder reads.
struct EvidenceClients<'a> {
    source: &'a ChainClient,
    destination: &'a ChainClient,
    beacon: &'a HttpBeaconSource,
}

fn evidence_request<'a>(
    name: &'a str,
    route: &RouteConfig,
    clients: &EvidenceClients<'a>,
    arguments: &EvidenceArguments,
    transaction: B256,
) -> Result<EvidenceRequest<'a>> {
    Ok(EvidenceRequest {
        route: name,
        source: clients.source,
        destination: clients.destination,
        beacon: clients.beacon,
        source_bridge: route.source.bridge_address()?,
        destination_bridge: route.destination.bridge_address()?,
        light_client: route.destination.light_client_address()?,
        transaction,
        log_index: arguments.log_index,
        anchor_slot: arguments.anchor_slot,
        destination_start_block: route.destination.start_block,
        log_block_range: route.destination.log_block_range,
        now_unix_seconds: now_unix_seconds(),
    })
}

/// Help and version requests are no errors: their text goes to `out` and the exit code is 0. Any other parse failure is a
/// usage error.
fn report_parse_error(error: &clap::Error, out: &mut dyn std::io::Write) -> Result<i32> {
    use clap::error::ErrorKind;
    if !matches!(
        error.kind(),
        ErrorKind::DisplayHelp | ErrorKind::DisplayVersion
    ) {
        return Err(Error::Usage(error.to_string()));
    }
    write!(out, "{error}").map_err(|failure| Error::Usage(failure.to_string()))?;
    Ok(0)
}

/// Runs the program and returns the process exit code. `arguments` includes the program name. Output goes to `out`.
///
/// # Errors
/// Any error of the subcommand, and `Error::Usage` for arguments that clap refuses.
pub fn run(
    arguments: Vec<String>,
    lookup: &dyn Fn(&str) -> Option<String>,
    out: &mut dyn std::io::Write,
) -> Result<i32> {
    let cli = match Cli::try_parse_from(&arguments) {
        Ok(cli) => cli,
        Err(error) => return report_parse_error(&error, out),
    };
    let config = Config::load_file(&cli.config, lookup)?;
    match &cli.command {
        Command::Prove(prove) => run_prove(&config, prove, lookup, out),
        Command::Evidence(evidence) => run_evidence(&config, evidence, out),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::config::SAMPLE_FOR_TESTS;

    fn arguments(parts: &[&str]) -> Vec<String> {
        std::iter::once("zk-bridge-prover")
            .chain(parts.iter().copied())
            .map(str::to_string)
            .collect()
    }

    fn prove_arguments(parts: &[&str]) -> Result<ProveArguments> {
        let mut all = vec!["prove"];
        all.extend_from_slice(parts);
        match Cli::try_parse_from(arguments(&all)) {
            Ok(Cli {
                command: Command::Prove(prove),
                ..
            }) => Ok(prove),
            Ok(_) => unreachable!("prove parses to prove"),
            Err(error) => Err(Error::Usage(error.to_string())),
        }
    }

    fn config() -> Config {
        Config::load(SAMPLE_FOR_TESTS, &|_| None).unwrap()
    }

    const ROOT: &str = "0x2222222222222222222222222222222222222222222222222222222222222222";

    /// Claim: the command set is `prove` and `evidence`. The commands of the old relayer, and every flag that names a key,
    /// are gone.
    /// Why it matters: the crate holds no wallet. A command or flag that came back would reopen that door.
    #[test]
    fn only_the_two_commands_exist_and_no_flag_takes_a_key() {
        for name in ["prove", "evidence"] {
            let extra: &[&str] = if name == "evidence" {
                &["--tx", ROOT, "--log-index", "0"]
            } else {
                &[]
            };
            let mut all = vec![name];
            all.extend_from_slice(extra);
            assert!(Cli::try_parse_from(arguments(&all)).is_ok(), "{name}");
        }
        for old in [
            "run",
            "once",
            "follow",
            "status",
            "withdraw",
            "retry",
            "route-health",
        ] {
            assert!(Cli::try_parse_from(arguments(&[old])).is_err(), "{old}");
        }
        for flag in [
            "--private-key",
            "--private-key-env",
            "--keystore",
            "--password",
        ] {
            assert!(
                Cli::try_parse_from(arguments(&["prove", flag, "x"])).is_err(),
                "{flag}"
            );
        }
    }

    /// Claim: a request for help or for the version prints its text and gives exit code 0, and a wrong flag is a usage error.
    /// Why it matters: a script that asks for `--help` must not see a failure, and a typo must not pass for success.
    #[test]
    fn help_is_not_an_error() {
        for flag in ["--help", "--version"] {
            let mut out = Vec::new();
            let code = run(arguments(&[flag]), &|_| None, &mut out).unwrap();
            assert_eq!(code, 0, "{flag}");
            assert!(!out.is_empty(), "{flag}");
        }
        let mut out = Vec::new();
        let error = run(arguments(&["prove", "--nonsense"]), &|_| None, &mut out).unwrap_err();
        assert!(matches!(error, Error::Usage(_)), "{error}");
    }

    /// Claim: with one route in the file and no other flag, `prove` reads the starting head from the chain; with
    /// `--head-slot` and `--head-root` it starts from the head on the command line and keeps the route for the package.
    #[test]
    fn a_route_reads_the_chain_and_a_head_flag_overrides_it() {
        let on_chain = plan_prove(&config(), &prove_arguments(&[]).unwrap()).unwrap();
        assert_eq!(on_chain.starting_point, StartingPoint::OnChain);
        assert_eq!(on_chain.route_name, "ethereum_to_pulsechain");
        assert_eq!(on_chain.chain, ChainKind::Ethereum);

        let key = format!("0x{}", "42".repeat(32));
        let explicit = plan_prove(
            &config(),
            &prove_arguments(&[
                "--head-slot",
                "9",
                "--head-root",
                ROOT,
                "--program-vkey",
                &key,
            ])
            .unwrap(),
        )
        .unwrap();
        assert_eq!(explicit.route_name, "ethereum_to_pulsechain");
        assert!(explicit.destination.is_some());
        let StartingPoint::Explicit { head, program_key } = explicit.starting_point else {
            panic!("an explicit head");
        };
        assert_eq!((head.slot, head.root), (9, B256::repeat_byte(0x22)));
        assert_eq!(head.next_committee_hash, B256::ZERO);
        assert_eq!(program_key, B256::repeat_byte(0x42));
    }

    /// Claim: without a route, `--beacon-url` with `--chain` and an explicit head describes the whole run; the program key
    /// then falls back to the file; and flags that do not fit together are usage errors.
    /// Why it matters: a guess would prove for the wrong chain or the wrong key.
    #[test]
    fn an_explicit_head_without_a_route_needs_its_parts() {
        let plan = plan_prove(
            &config(),
            &prove_arguments(&[
                "--beacon-url",
                "https://beacon.example.org",
                "--chain",
                "pulsechain",
                "--head-slot",
                "5",
                "--head-root",
                ROOT,
            ])
            .unwrap(),
        )
        .unwrap();
        assert_eq!(plan.route_name, EXPLICIT_HEAD_ROUTE);
        assert!(plan.destination.is_none());
        assert_eq!(plan.chain, ChainKind::Pulsechain);
        let StartingPoint::Explicit { program_key, .. } = plan.starting_point else {
            panic!("an explicit head");
        };
        assert_eq!(
            program_key,
            B256::from(alloy_primitives::U256::from(0x1234u64))
        );

        for bad in [
            vec!["--head-slot", "5"],
            vec!["--head-root", ROOT],
            vec![
                "--beacon-url",
                "https://b.example.org",
                "--chain",
                "ethereum",
            ],
            vec!["--route", "x", "--beacon-url", "https://b.example.org"],
            vec!["--program-vkey", ROOT],
        ] {
            let outcome = prove_arguments(&bad).and_then(|parsed| plan_prove(&config(), &parsed));
            assert!(outcome.is_err(), "{bad:?}");
        }
        let unknown_chain = prove_arguments(&[
            "--beacon-url",
            "https://beacon.example.org",
            "--chain",
            "solana",
            "--head-slot",
            "5",
            "--head-root",
            ROOT,
        ])
        .unwrap();
        assert!(plan_prove(&config(), &unknown_chain).is_err());
    }

    /// Claim: an explicit head with no key anywhere is refused, and a configured key that differs from the contract key is
    /// refused.
    /// Why it matters: a proof for another key is rejected by the light client after the whole proving cost.
    #[test]
    fn the_program_key_must_come_from_somewhere_and_agree_with_the_contract() {
        let without_key = Config::load(
            &SAMPLE_FOR_TESTS.replace(
                "program_vkey = \"0x0000000000000000000000000000000000000000000000000000000000001234\"\n",
                "",
            ),
            &|_| None,
        )
        .unwrap();
        let explicit = prove_arguments(&["--head-slot", "9", "--head-root", ROOT]).unwrap();
        let error = plan_prove(&without_key, &explicit).unwrap_err();
        assert!(error.to_string().contains("program key"), "{error}");

        assert!(require_same_key(None, B256::repeat_byte(1)).is_ok());
        assert!(require_same_key(Some(B256::repeat_byte(1)), B256::repeat_byte(1)).is_ok());
        let error = require_same_key(Some(B256::repeat_byte(2)), B256::repeat_byte(1)).unwrap_err();
        assert!(matches!(error, Error::Config(_)), "{error}");
    }

    /// Claim: the oracle backend reads its key from the variable that the file names, and fails when the variable is
    /// missing. A backend that this build lacks gives a configuration error, not a panic.
    #[test]
    fn the_backend_reads_its_secret_from_the_named_variable() {
        let oracle = config();
        let prover = oracle.prover_config().unwrap();
        assert!(build_prover(prover, &|_| None).is_err());
        let key = "0x".to_string() + &"42".repeat(32);
        let built = build_prover(prover, &|name| (name == "ORACLE_KEY").then(|| key.clone()));
        assert_eq!(built.unwrap().name(), "oracle");
    }
}
