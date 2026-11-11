//! The command line: `prove`, `evidence`, `verify` and the helpers `checkpoint`, `opening-proof` and `deployment-file`.
//!
//! All three commands are stateless. They read configuration, chains and a beacon node, print or post one JSON object, and exit.
//! Neither one takes a key, sends a transaction or opens a file for writing. The only secrets they use are named by
//! environment variables in the configuration file (see `config.rs`).
//!
//! Exit codes of `prove`: [`EXIT_PROOF_PRODUCED`] when it made a proof and handed it off, [`EXIT_UP_TO_DATE`] when the
//! starting head already is the newest final header and there is nothing to prove, and 1 for an error. `evidence` returns
//! 0 or 1.

use crate::beacon::branch_store::DirectoryBranchStore;
use crate::beacon::handoff_archive::{host_of, record_json, ArchiveClient};
use crate::beacon::http::{HttpBeaconSource, RpcExecutionHeaders};
use crate::beacon::state_store::DirectoryStateStore;
use crate::beacon::StoredHead;
use crate::chain::ChainClient;
use crate::checkpoint::build_checkpoint_with_state_urls;
use crate::config::{
    Config, DestinationConfig, HandoffTarget, ProverBackend, ProverConfig, RouteConfig,
};
use crate::deployment::{
    build_sections, deployment_json, drafts_from_broadcast, write_private_file, Existing,
};
use crate::error::{Error, Result};
use crate::evidence::{build_evidence, EvidenceRequest};
use crate::handoff::{Handoff, PackageDestination};
use crate::light_client::ChainKind;
use crate::logging::Logger;
use crate::opening::{build_opening_proof, OpeningRequest};
use crate::produce::{produce_logged, ProduceRequest, Production, EXPLICIT_HEAD_ROUTE};
use crate::prover::{require_groth16_shape, OracleProver, Prover};
use crate::remote::verify_groth16;
use crate::rpc::{HttpClient, HttpRpc};
use crate::signer::Signer;
use crate::stored::{read_stored_state, StoredState};
use alloy_primitives::{hex, Address, B256};
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
    /// Check one Groth16 proof against a program key and public values, as the light client verifier does.
    ///
    /// It needs no configuration file, no network and no key. A server that reads a proof from a message board runs it
    /// before it spends gas on `update`. It prints one JSON object and exits with code 0 when the proof verifies. It
    /// exits with code 1 and an error message when the proof does not verify, or when an argument is not valid.
    Verify(VerifyArguments),
    /// Print the checkpoint values that a new light client needs, as one JSON object.
    ///
    /// The values are the slot and the root of one finalized header, the hashes of its current and next sync committee,
    /// and the chain facts of the deploy configuration. All come from the same finalized root. The command reads the
    /// beacon API only: first the light-client bootstrap route, and the finalized state when the node answers 404 there.
    Checkpoint(CheckpointArguments),
    /// Print the evidence of `MessageBridge.openDeposits` for the source bridge of a route, as one JSON object.
    ///
    /// The object holds the calldata and its decoded parts. The command reads the source chain (the bridge and its own
    /// light client) and the destination chain (the block and the storage of the remote light client), checks the proof
    /// natively as the contract does, and prints it only when it verifies. It sends nothing.
    OpeningProof(OpeningProofArguments),
    /// Print the complete committee handoff update of one sync committee period, as one JSON record.
    ///
    /// The record is what the handoff archive keeps (docs/proof-archive.md): the update that is attested and signed in the
    /// period and proves the committee of the next one, with the branch of `genesis_validators_root` and the execution
    /// header of a compact finalized header attached. The update comes from `light_client/updates` of `source.beacon_url`,
    /// else it is assembled from blocks and states (the main node, `source.state_urls`, `source.handoff_urls`), else
    /// from `light_client/updates` of each `source.handoff_urls` entry. The archive itself is never asked. Run it once the
    /// period has ended. Exit code 1 names every source tried.
    HandoffUpdate(HandoffUpdateArguments),
    /// Print the fork proof record of the source block of one transaction, as one JSON record.
    ///
    /// The record is what the fork proof archive keeps (docs/proof-archive.md): `fork.current_version` and
    /// `genesis_validators_root` proven under the state root of the source header that a message proof of that block takes
    /// (`MessageProof.sourceFork`), checked against the genesis validators root of the chain. The proof comes from the
    /// compact multiproof route of the node or of `source.state_urls`, else from the whole state. The archive itself is
    /// never asked. Run it once the block is final, while the nodes still keep its state. Exit code 1 when the block is not
    /// final yet ("not final yet") or no source gives the proof.
    ForkProof(ForkProofArguments),
    /// Write the deployment file that the explorer reads (`chain_a` and `chain_b` sections), and print a summary.
    ///
    /// The addresses come from `--chain-a` and `--chain-b` pairs, from Foundry broadcast files, or from both (a pair
    /// overrides the file). The command checks every address, writes the file with mode 0600, refuses to replace a file
    /// without `--force`, and writes no `rpc_url` unless a pair gives a URL without a path or query.
    DeploymentFile(DeploymentFileArguments),
}

/// The arguments of `deployment-file`.
#[derive(Debug, Args)]
pub struct DeploymentFileArguments {
    /// The file to write.
    #[arg(long)]
    pub output: PathBuf,
    /// Replace the file when it exists.
    #[arg(long)]
    pub force: bool,
    /// A Foundry broadcast file (`broadcast/.../run-latest.json`). Repeat for one file for each chain. The names come
    /// from the `contractName` fields.
    #[arg(long)]
    pub broadcast: Vec<PathBuf>,
    /// A `key=value` pair for the section `chain_a`. Repeat it. Keys: chain_id, rpc_url, bridge, mediator, token_factory,
    /// wrapped_native, gate, light_client, delivery_router, fork_registry, start_block, light_client_start_block (the block
    /// before the light client deployment, when it is earlier than start_block).
    #[arg(long)]
    pub chain_a: Vec<String>,
    /// A `key=value` pair for the section `chain_b`. The keys are those of `--chain-a`.
    #[arg(long)]
    pub chain_b: Vec<String>,
}

/// The arguments of `handoff-update`.
#[derive(Debug, Args)]
pub struct HandoffUpdateArguments {
    /// The route of the configuration whose source chain the period belongs to. It may be left out when the file has
    /// exactly one route.
    #[arg(long)]
    pub route: Option<String>,
    /// The sync committee period.
    #[arg(long)]
    pub period: u64,
}

/// The arguments of `fork-proof`.
#[derive(Debug, Args)]
pub struct ForkProofArguments {
    /// The route of the configuration whose source chain the transaction is on. It may be left out when the file has
    /// exactly one route.
    #[arg(long)]
    pub route: Option<String>,
    /// The hash of a transaction on the source chain. Every message in its block shares the record.
    #[arg(long)]
    pub tx: String,
}

/// The arguments of `opening-proof`.
#[derive(Debug, Args)]
pub struct OpeningProofArguments {
    /// The route of the configuration. It may be left out when the file has exactly one route.
    #[arg(long)]
    pub route: Option<String>,
    /// The bridge to open, on the source chain. Default: `source.bridge` of the route.
    #[arg(long)]
    pub bridge_source: Option<String>,
    /// The slot of the own light client whose stored block hash anchors the proof. Default: the head of the own light client.
    #[arg(long)]
    pub remote_slot: Option<u64>,
    /// The slot of the remote light client to prove. Default: its head in the remote block.
    #[arg(long)]
    pub stored_slot: Option<u64>,
}

/// The arguments of `checkpoint`.
#[derive(Debug, Args)]
pub struct CheckpointArguments {
    /// The route of the configuration: its source beacon API and chain are used. It may be left out when the file has
    /// exactly one route and no `--beacon-url` is given.
    #[arg(long, conflicts_with_all = ["beacon_url", "chain"])]
    pub route: Option<String>,
    /// The beacon API of the chain, when no route is given. It may have a path prefix.
    #[arg(long, requires = "chain")]
    pub beacon_url: Option<String>,
    /// The chain kind (`ethereum`, `pulsechain`, `sepolia` or `pulsechain-testnet-v4`), when no route is given.
    #[arg(long, requires = "beacon_url")]
    pub chain: Option<String>,
    /// The root of the finalized header to use. Default: the newest finalized header of the node.
    #[arg(long)]
    pub finalized_root: Option<String>,
    /// Another beacon API to ask for the state of the header, when the main one does not serve it. Repeat the flag for
    /// several; they are asked in order, after the `state_urls` of the route.
    #[arg(long = "state-url")]
    pub state_urls: Vec<String>,
}

/// The arguments of `verify`.
#[derive(Debug, Args)]
pub struct VerifyArguments {
    /// The program key that the proof is for, as `0x` and 64 hex digits. The light client stores it as `programVKey`.
    #[arg(long)]
    pub program_vkey: String,
    /// The public values that the proof commits to, as `0x` hex.
    #[arg(long)]
    pub public_values: String,
    /// The proof bytes that the verifier contract reads, as `0x` hex.
    #[arg(long)]
    pub proof: String,
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
    /// The chain kind of the source beacon chain (`ethereum`, `pulsechain`, `sepolia` or `pulsechain-testnet-v4`), when no
    /// route is given.
    #[arg(long, conflicts_with = "route")]
    pub chain: Option<String>,
    /// The execution RPC of the source chain, when no route is given. A Gloas source needs it for the execution header of
    /// `state.latest_block_hash`. With a route, `source.rpc_url` of the file is used.
    #[arg(long, conflicts_with = "route", requires = "beacon_url")]
    pub source_rpc_url: Option<String>,
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
    source_rpc_url: Option<String>,
    branch_store_dir: Option<String>,
    state_urls: Vec<String>,
    /// The state cache directory and the chain id of the source.
    state_cache: Option<(String, u64)>,
    /// `source.handoff_urls` and `source.handoff_archive_urls` of the route.
    handoff_urls: Vec<String>,
    handoff_archive_urls: Vec<String>,
    /// The chain id of the source, which the paths of the handoff archive name (0 without a route).
    source_chain_id: u64,
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
    let (route_name, source_url, source_rpc_url, branch_store_dir, chain, destination) =
        match &arguments.beacon_url {
            Some(url) => {
                let name = arguments.chain.as_deref().unwrap_or_default();
                let chain = parse_chain(name)?;
                (
                    EXPLICIT_HEAD_ROUTE.to_string(),
                    url.clone(),
                    arguments.source_rpc_url.clone(),
                    None,
                    chain,
                    None,
                )
            }
            None => {
                let (name, route) = config.route(arguments.route.as_deref())?;
                (
                    name.to_string(),
                    route.source.beacon_url.clone(),
                    route.source.rpc_url.clone(),
                    route.source.branch_store_dir.clone(),
                    route.source.chain_kind()?,
                    Some(route.destination.clone()),
                )
            }
        };
    let (state_urls, state_cache, handoff_urls, handoff_archive_urls, source_chain_id) =
        match &arguments.beacon_url {
            Some(_) => (Vec::new(), None, Vec::new(), Vec::new(), 0),
            None => {
                let (_, route) = config.route(arguments.route.as_deref())?;
                (
                    route.source.state_urls.clone(),
                    route
                        .source
                        .state_cache_dir
                        .clone()
                        .map(|directory| (directory, route.source.chain_id)),
                    route.source.handoff_urls.clone(),
                    route.source.handoff_archive_urls.clone(),
                    route.source.chain_id,
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
        source_rpc_url,
        branch_store_dir,
        state_urls,
        state_cache,
        handoff_urls,
        handoff_archive_urls,
        source_chain_id,
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
    HttpBeaconSource::new(chain, Box::new(HttpClient::new(url))).with_host(host_of(url))
}

/// Clients on URLs, each named by its host for messages.
fn named_clients(urls: &[String]) -> Vec<ArchiveClient> {
    urls.iter()
        .map(|url| ArchiveClient {
            host: host_of(url),
            client: Box::new(HttpClient::new(url)),
        })
        .collect()
}

/// The beacon source of a route with every source it names: the execution headers, the branch store, the state URLs
/// (then the handoff URLs) for states, the state cache, the handoff URLs for handoff updates and, when `with_archive`,
/// the handoff archive.
#[allow(clippy::too_many_arguments)]
fn full_beacon_source(
    chain: ChainKind,
    beacon_url: &str,
    rpc_url: Option<&str>,
    branch_store_dir: Option<&str>,
    state_urls: &[String],
    state_cache: Option<&(String, u64)>,
    handoff_urls: &[String],
    archive: Option<(u64, &[String])>,
) -> HttpBeaconSource {
    let state_sources: Vec<String> = state_urls.iter().chain(handoff_urls).cloned().collect();
    let source = with_state_sources(
        with_branch_store(
            with_execution_headers(beacon_source(chain, beacon_url), rpc_url),
            branch_store_dir,
        ),
        &state_sources,
        state_cache,
    )
    .with_handoff_clients(named_clients(handoff_urls));
    match archive {
        Some((chain_id, urls)) => source.with_handoff_archive(chain_id, named_clients(urls)),
        None => source,
    }
}

/// Gives the source an execution header source when the run has a source RPC URL.
fn with_execution_headers(source: HttpBeaconSource, rpc_url: Option<&str>) -> HttpBeaconSource {
    match rpc_url {
        Some(url) => source.with_execution_headers(Box::new(RpcExecutionHeaders::new(Box::new(
            HttpRpc::new(url),
        )))),
        None => source,
    }
}

/// Gives the source a store in a directory for the branches of `genesis_validators_root`, when the configuration names one.
fn with_branch_store(source: HttpBeaconSource, directory: Option<&str>) -> HttpBeaconSource {
    match directory {
        Some(path) => {
            source.with_branch_store(std::sync::Arc::new(DirectoryBranchStore::new(path)))
        }
        None => source,
    }
}

/// Gives the source the state URLs of the route and, when it names one, a directory for verified states.
fn with_state_sources(
    source: HttpBeaconSource,
    state_urls: &[String],
    state_cache: Option<&(String, u64)>,
) -> HttpBeaconSource {
    let clients: Vec<Box<dyn crate::rpc::HttpGet>> = state_urls
        .iter()
        .map(|url| Box::new(HttpClient::new(url)) as Box<dyn crate::rpc::HttpGet>)
        .collect();
    let source = source.with_state_clients(clients);
    match state_cache {
        Some((directory, chain_id)) => source.with_state_store(std::sync::Arc::new(
            DirectoryStateStore::new(directory, *chain_id),
        )),
        None => source,
    }
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
    let source = full_beacon_source(
        plan.chain,
        &plan.beacon_url,
        plan.source_rpc_url.as_deref(),
        plan.branch_store_dir.as_deref(),
        &plan.state_urls,
        plan.state_cache.as_ref(),
        &plan.handoff_urls,
        Some((plan.source_chain_id, &plan.handoff_archive_urls)),
    );
    match produce_logged(&source, prover.as_ref(), &request, &logger)? {
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
    let state_cache = route
        .source
        .state_cache_dir
        .clone()
        .map(|directory| (directory, route.source.chain_id));
    let beacon = with_state_sources(
        beacon_source(route.source.chain_kind()?, &route.source.beacon_url),
        &route.source.state_urls,
        state_cache.as_ref(),
    )
    .with_fork_proof_archive(
        route.source.chain_id,
        named_clients(&route.source.fork_proof_archive_urls),
    );
    let source_header_sources = header_clients(
        "source",
        route.source.chain_id,
        &route.source.header_rpc_urls,
    );
    let evidence = build_evidence(&evidence_request(
        name,
        route,
        &EvidenceClients {
            source: &source,
            source_header_sources: &source_header_sources,
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

/// The clients that the evidence builder reads.
struct EvidenceClients<'a> {
    source: &'a ChainClient,
    source_header_sources: &'a [ChainClient],
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
        source_header_sources: clients.source_header_sources,
        transaction,
        log_index: arguments.log_index,
        anchor_slot: arguments.anchor_slot,
        stored_heads_start_block: route.destination.stored_heads_start_block(),
        log_block_range: route.destination.log_block_range,
        now_unix_seconds: now_unix_seconds(),
    })
}

fn parse_bytes(text: &str, flag: &str) -> Result<Vec<u8>> {
    hex::decode(text).map_err(|error| Error::Usage(format!("{flag}: not hex: {error}")))
}

/// Verifies a Groth16 proof with the crate `sp1-verifier`, after the shape check that stops a proof of another circuit.
///
/// # Errors
/// `Error::Usage` for a value that is not hex. `Error::Prover` when the proof has the wrong shape or does not verify.
fn run_verify(arguments: &VerifyArguments, out: &mut dyn std::io::Write) -> Result<i32> {
    let program_key = parse_hash(&arguments.program_vkey, "--program-vkey")?;
    let public_values = parse_bytes(&arguments.public_values, "--public-values")?;
    let proof_bytes = parse_bytes(&arguments.proof, "--proof")?;
    require_groth16_shape(&proof_bytes)?;
    verify_groth16(program_key, &public_values, &proof_bytes)?;
    writeln!(
        out,
        "{{\"valid\":true,\"programKey\":\"{program_key:#x}\"}}"
    )
    .map_err(|error| Error::Usage(format!("cannot write the result: {error}")))?;
    Ok(0)
}

/// Prints the checkpoint of a beacon API as one JSON object.
///
/// # Errors
/// `Error::Usage` for flags that do not fit. The errors of [`crate::checkpoint::build_checkpoint`] otherwise.
fn run_checkpoint(
    config: Option<&Config>,
    arguments: &CheckpointArguments,
    out: &mut dyn std::io::Write,
) -> Result<i32> {
    let (url, chain, mut state_urls) = match (&arguments.beacon_url, config) {
        (Some(url), _) => (
            url.clone(),
            parse_chain(arguments.chain.as_deref().unwrap_or_default())?,
            Vec::new(),
        ),
        (None, Some(config)) => {
            let (_, route) = config.route(arguments.route.as_deref())?;
            (
                route.source.beacon_url.clone(),
                route.source.chain_kind()?,
                route.source.state_urls.clone(),
            )
        }
        (None, None) => {
            return Err(Error::Usage(
                "checkpoint needs a route or --beacon-url".into(),
            ))
        }
    };
    let finalized_root = arguments
        .finalized_root
        .as_deref()
        .map(|text| parse_hash(text, "--finalized-root"))
        .transpose()?;
    state_urls.extend(arguments.state_urls.iter().cloned());
    if let Some(url) = state_urls
        .iter()
        .find(|url| !url.starts_with("http://") && !url.starts_with("https://"))
    {
        return Err(Error::Usage(format!(
            "--state-url {url} must start with http:// or https://"
        )));
    }
    let client = HttpClient::new(&url);
    let state_clients: Vec<HttpClient> =
        state_urls.iter().map(|url| HttpClient::new(url)).collect();
    let state_client_refs: Vec<&dyn crate::rpc::HttpGet> = state_clients
        .iter()
        .map(|client| client as &dyn crate::rpc::HttpGet)
        .collect();
    let report =
        build_checkpoint_with_state_urls(&client, &state_client_refs, chain, finalized_root)?;
    write_json(out, &report.to_json())?;
    Ok(0)
}

/// The header-only clients of `<side>.header_rpc_urls`, in order, each named `<side>.header_rpc_urls[i]` so that an error
/// names the entry and not its URL.
fn header_clients(side: &str, chain_id: u64, urls: &[String]) -> Vec<ChainClient> {
    urls.iter()
        .enumerate()
        .map(|(index, url)| {
            ChainClient::header_only(
                &format!("{side}.header_rpc_urls[{index}]"),
                chain_id,
                Box::new(HttpRpc::new(url)),
            )
        })
        .collect()
}

/// Prints the opening proof of the source bridge of a route as one JSON object.
///
/// # Errors
/// The errors of [`build_opening_proof`], and `Error::Usage` for a bad address.
fn run_opening_proof(
    config: &Config,
    arguments: &OpeningProofArguments,
    out: &mut dyn std::io::Write,
) -> Result<i32> {
    let (name, route) = config.route(arguments.route.as_deref())?;
    let bridge = match &arguments.bridge_source {
        Some(text) => Address::from_str(text)
            .map_err(|error| Error::Usage(format!("--bridge-source: {error}")))?,
        None => route.source.bridge_address()?,
    };
    let own = connect(
        "source",
        route.source.chain_id,
        route.source.execution_url()?,
    )?;
    let remote = connect(
        "destination",
        route.destination.chain_id,
        &route.destination.rpc_url,
    )?;
    let header_sources = header_clients(
        "destination",
        route.destination.chain_id,
        &route.destination.header_rpc_urls,
    );
    let package = build_opening_proof(&OpeningRequest {
        route: name,
        own_chain: &own,
        remote_chain: &remote,
        remote_header_sources: &header_sources,
        bridge,
        remote_light_client: route.destination.light_client_address()?,
        remote_slot: arguments.remote_slot,
        stored_slot: arguments.stored_slot,
        proof_cache_dir: route
            .destination
            .proof_cache_dir
            .as_deref()
            .map(std::path::Path::new),
    })?;
    write_json(out, &package.to_json())?;
    Ok(0)
}

/// Prints the record of the handoff update of one period (see [`crate::beacon::handoff_archive`]).
///
/// # Errors
/// `Error::Beacon` naming every source tried, the errors of [`HttpBeaconSource::complete_handoff`], and the route errors.
fn run_handoff_update(
    config: &Config,
    arguments: &HandoffUpdateArguments,
    out: &mut dyn std::io::Write,
) -> Result<i32> {
    let (_, route) = config.route(arguments.route.as_deref())?;
    let source = &route.source;
    let chain = source.chain_kind()?;
    let state_cache = source
        .state_cache_dir
        .clone()
        .map(|directory| (directory, source.chain_id));
    let beacon = full_beacon_source(
        chain,
        &source.beacon_url,
        source.rpc_url.as_deref(),
        source.branch_store_dir.as_deref(),
        &source.state_urls,
        state_cache.as_ref(),
        &source.handoff_urls,
        None,
    );
    let update = beacon.complete_handoff(arguments.period)?;
    let record = record_json(chain, source.chain_id, arguments.period, &update)?;
    Logger::standard().info(
        "handoff_update_built",
        &[
            ("period", arguments.period.to_string()),
            (
                "attested_slot",
                update.attested_header.beacon.slot.to_string(),
            ),
            (
                "finalized_slot",
                update.finalized_header.beacon.slot.to_string(),
            ),
        ],
    );
    write_json(out, &record)?;
    Ok(0)
}

/// Prints the fork proof record of the source block of one transaction (see [`crate::beacon::fork_archive`]).
///
/// # Errors
/// The errors of [`ChainClient::source_block_of_transaction`] and [`HttpBeaconSource::fork_proof_record`], and the route
/// errors.
fn run_fork_proof(
    config: &Config,
    arguments: &ForkProofArguments,
    out: &mut dyn std::io::Write,
) -> Result<i32> {
    let (_, route) = config.route(arguments.route.as_deref())?;
    let source = &route.source;
    let transaction = parse_hash(&arguments.tx, "--tx")?;
    let chain = connect("source", source.chain_id, source.execution_url()?)?;
    let block = chain.source_block_of_transaction(transaction)?;
    let state_cache = source
        .state_cache_dir
        .clone()
        .map(|directory| (directory, source.chain_id));
    let beacon = with_state_sources(
        beacon_source(source.chain_kind()?, &source.beacon_url),
        &source.state_urls,
        state_cache.as_ref(),
    );
    let record = beacon.fork_proof_record(&block, source.chain_id)?;
    Logger::standard().info(
        "fork_proof_built",
        &[
            ("execution_block", block.number.to_string()),
            ("slot", record["slot"].to_string()),
            ("shape", record["shape"].to_string()),
        ],
    );
    write_json(out, &record)?;
    Ok(0)
}

/// Writes the deployment file and prints a summary of it.
///
/// # Errors
/// `Error::Usage` for a missing or wrong value, an unreadable broadcast file or an existing output file.
fn run_deployment_file(
    arguments: &DeploymentFileArguments,
    out: &mut dyn std::io::Write,
) -> Result<i32> {
    let mut drafts = Vec::new();
    for path in &arguments.broadcast {
        let text = std::fs::read_to_string(path)
            .map_err(|error| Error::Usage(format!("{}: {error}", path.display())))?;
        let file: serde_json::Value = serde_json::from_str(&text)
            .map_err(|error| Error::Usage(format!("{}: {error}", path.display())))?;
        drafts.extend(drafts_from_broadcast(&file)?);
    }
    let sections = build_sections(drafts, &arguments.chain_a, &arguments.chain_b)?;
    let content = format!("{:#}\n", deployment_json(&sections));
    let existing = if arguments.force {
        Existing::Replace
    } else {
        Existing::Refuse
    };
    write_private_file(&arguments.output, &content, existing)?;
    write_json(
        out,
        &serde_json::json!({
            "written": arguments.output.display().to_string(),
            "mode": "0600",
            "chains": [sections[0].chain_id, sections[1].chain_id],
        }),
    )?;
    Ok(0)
}

/// Writes one JSON object and a newline.
fn write_json(out: &mut dyn std::io::Write, value: &serde_json::Value) -> Result<()> {
    writeln!(out, "{value}")
        .map_err(|error| Error::Usage(format!("cannot write the result: {error}")))
}

/// The chain kind named by a flag, or a usage error that lists the known names.
fn parse_chain(name: &str) -> Result<ChainKind> {
    ChainKind::from_name(name).ok_or_else(|| {
        Error::Usage(format!(
            "--chain: unknown chain `{name}`; the known chains are {}",
            ChainKind::known_names()
        ))
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
    // `verify` reads no file, so a missing configuration must not stop it.
    if let Command::Verify(verify) = &cli.command {
        return run_verify(verify, out);
    }
    // `deployment-file` reads no configuration either.
    if let Command::DeploymentFile(deployment) = &cli.command {
        return run_deployment_file(deployment, out);
    }
    // `checkpoint` with a beacon URL needs no file either.
    if let Command::Checkpoint(checkpoint) = &cli.command {
        if checkpoint.beacon_url.is_some() {
            return run_checkpoint(None, checkpoint, out);
        }
    }
    let config = Config::load_file(&cli.config, lookup)?;
    match &cli.command {
        Command::Prove(prove) => run_prove(&config, prove, lookup, out),
        Command::Evidence(evidence) => run_evidence(&config, evidence, out),
        Command::Checkpoint(checkpoint) => run_checkpoint(Some(&config), checkpoint, out),
        Command::OpeningProof(opening) => run_opening_proof(&config, opening, out),
        Command::HandoffUpdate(handoff) => run_handoff_update(&config, handoff, out),
        Command::ForkProof(fork) => run_fork_proof(&config, fork, out),
        Command::DeploymentFile(_) => unreachable!("deployment-file returned above"),
        Command::Verify(_) => unreachable!("verify returned above"),
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

    /// Claim: the command set is `prove`, `evidence` and `verify`. The commands of the old relayer, and every flag that
    /// names a key, are gone.
    /// Why it matters: the crate holds no wallet. A command or flag that came back would reopen that door.
    #[test]
    fn only_the_two_commands_exist_and_no_flag_takes_a_key() {
        for name in ["prove", "evidence", "verify"] {
            let extra: &[&str] = match name {
                "evidence" => &["--tx", ROOT, "--log-index", "0"],
                "verify" => &[
                    "--program-vkey",
                    ROOT,
                    "--public-values",
                    "0x",
                    "--proof",
                    "0x",
                ],
                _ => &[],
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

    /// A real Groth16 proof of a real Ethereum update, with its program key and public values.
    fn real_proof() -> (String, String, String) {
        let path = format!(
            "{}/../test/hardened/fixtures/sp1-proof-ethereum-update.json",
            env!("CARGO_MANIFEST_DIR")
        );
        let text = std::fs::read_to_string(&path).unwrap_or_else(|error| panic!("{path}: {error}"));
        let value: serde_json::Value = serde_json::from_str(&text).unwrap();
        let field = |name: &str| value[name].as_str().unwrap().to_string();
        (field("programVKey"), field("publicValues"), field("proof"))
    }

    fn verify_outcome(key: &str, values: &str, proof: &str) -> (Result<i32>, String) {
        let mut out = Vec::new();
        let outcome = run(
            arguments(&[
                "--config",
                "/nonexistent/prover.toml",
                "verify",
                "--program-vkey",
                key,
                "--public-values",
                values,
                "--proof",
                proof,
            ]),
            &|_| None,
            &mut out,
        );
        (outcome, String::from_utf8(out).unwrap())
    }

    /// Claim: `verify` accepts a real proof for its own key and values, needs no configuration file, and prints one JSON
    /// line with the key.
    /// Why it matters: the delivery runner trusts this answer before it spends gas on `update`.
    #[test]
    fn verify_accepts_a_real_proof_without_a_configuration_file() {
        let (key, values, proof) = real_proof();
        let (outcome, printed) = verify_outcome(&key, &values, &proof);
        assert_eq!(outcome.unwrap(), 0);
        assert_eq!(
            printed,
            format!("{{\"valid\":true,\"programKey\":\"{key}\"}}\n")
        );
    }

    /// Claim: `verify` refuses a proof when one input changes: the public values, the program key, the length or the
    /// selector. It prints nothing on standard output for a refusal.
    /// Why it matters: each change is a forged proof, and a runner that accepted one would post a transaction that
    /// reverts, or trust a head that the chain never stored.
    #[test]
    fn verify_refuses_every_changed_input() {
        let (key, values, proof) = real_proof();
        let flipped_values = format!(
            "{}{:02x}",
            &values[..values.len() - 2],
            u8::from_str_radix(&values[values.len() - 2..], 16).unwrap() ^ 1
        );
        let other_key = format!("0x{}", "42".repeat(32));
        let shorter = proof[..proof.len() - 2].to_string();
        let other_selector = format!("0x00000000{}", &proof[10..]);
        for (case, key, values, proof) in [
            ("public values", &key, &flipped_values, &proof),
            ("program key", &other_key, &values, &proof),
            ("length", &key, &values, &shorter),
            ("selector", &key, &values, &other_selector),
        ] {
            let (outcome, printed) = verify_outcome(key, values, proof);
            assert!(
                matches!(outcome, Err(Error::Prover(_))),
                "{case}: {outcome:?}"
            );
            assert_eq!(printed, "", "{case}");
        }
    }

    /// Claim: text that is not hex is a usage error that names the flag, not a verification failure.
    #[test]
    fn verify_names_the_flag_that_is_not_hex() {
        let (key, values, _) = real_proof();
        let (outcome, _) = verify_outcome(&key, &values, "0xzz");
        let message = outcome.unwrap_err().to_string();
        assert!(message.contains("--proof"), "{message}");
    }

    /// Claim: `checkpoint` takes a route or a beacon URL with a chain, never both. An unknown chain is refused with the list of
    /// known names, and a bad root is refused before any request. Why it matters: a wrong chain would check the genesis
    /// of another chain and print values that fit no contract.
    #[test]
    fn checkpoint_flags_fit_together() {
        let parse = |parts: &[&str]| {
            let mut all = vec!["checkpoint"];
            all.extend_from_slice(parts);
            Cli::try_parse_from(arguments(&all))
        };
        assert!(parse(&[
            "--route",
            "a",
            "--beacon-url",
            "http://x",
            "--chain",
            "sepolia"
        ])
        .is_err());
        assert!(parse(&["--beacon-url", "http://x"]).is_err());
        assert!(parse(&["--chain", "sepolia"]).is_err());
        assert!(parse(&["--beacon-url", "http://x", "--chain", "sepolia"]).is_ok());
        let mut out = Vec::new();
        let error = run(
            arguments(&[
                "checkpoint",
                "--beacon-url",
                "http://127.0.0.1:1",
                "--chain",
                "goerli",
            ]),
            &|_| None,
            &mut out,
        )
        .unwrap_err()
        .to_string();
        assert!(
            error.contains("goerli") && error.contains("pulsechain-testnet-v4"),
            "{error}"
        );
        let error = run(
            arguments(&[
                "checkpoint",
                "--beacon-url",
                "http://127.0.0.1:1",
                "--chain",
                "sepolia",
                "--finalized-root",
                "0x12",
            ]),
            &|_| None,
            &mut out,
        )
        .unwrap_err()
        .to_string();
        assert!(error.contains("--finalized-root"), "{error}");
        assert!(out.is_empty());
    }
}
