//! The `local-network` binary: bots and a beacon stub for the local two-chain network in `docker/`.
//!
//! It is for development only and is built with the cargo feature `dev-source`. The production service
//! (`zk-bridge-prover`) does not use it.

use clap::{Parser, Subcommand};
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::Duration;
use zk_bridge_prover::light_client::ChainKind;
use zk_bridge_prover::local_network::beacon_stub::{serve, StubChain};
use zk_bridge_prover::local_network::deployment::{self, Deployment};
use zk_bridge_prover::local_network::signed_beacon::checkpoint::read_checkpoint;
use zk_bridge_prover::local_network::signed_beacon::node::{
    default_first_slot, serve as serve_signed_beacon, BeaconNode, Mount, NodeSettings, RpcBlockFeed,
};
use zk_bridge_prover::local_network::traffic::{Traffic, TrafficSettings};
use zk_bridge_prover::rpc::{HttpClient, HttpRpc};

/// Tools for the local network.
#[derive(Debug, Parser)]
#[command(name = "local-network", version, about)]
struct Cli {
    /// The JSON file that the deploy step writes. The commands `traffic` and `beacon-stub` wait until it exists.
    #[arg(long, global = true, default_value = "/state/deployment.json")]
    deployment: PathBuf,
    #[command(subcommand)]
    command: Command,
}

#[derive(Debug, Subcommand)]
enum Command {
    /// Deposit small random amounts in both directions for ever, and log each completed withdrawal.
    Traffic {
        /// The fewest seconds between two deposits.
        #[arg(long, default_value_t = 4)]
        minimum_wait_seconds: u64,
        /// The most seconds between two deposits.
        #[arg(long, default_value_t = 12)]
        maximum_wait_seconds: u64,
        /// The number of depositor accounts (Anvil accounts 2 and up).
        #[arg(long, default_value_t = 3)]
        bots: usize,
    },
    /// Answer the beacon requests of `route-health` from the local chains.
    BeaconStub {
        /// The address to listen on.
        #[arg(long, default_value = "0.0.0.0:9000")]
        listen: String,
    },
    /// Serve a beacon chain over the blocks of local chains, with real sync committee signatures (docs/end-to-end-real-proofs.md).
    /// It needs no deployment file: the deploy step reads its checkpoint.
    SignedBeacon {
        /// The address to listen on.
        #[arg(long, default_value = "127.0.0.1:29000")]
        listen: String,
        /// One chain: `PREFIX,KIND,RPC_URL` or `PREFIX,KIND,RPC_URL,FIRST_SLOT`. The beacon API of the chain answers under
        /// `/PREFIX`. KIND is `ethereum` or `pulsechain`. The execution chain must mine one block per slot, on the slot
        /// grid (Anvil with `anvil_setBlockTimestampInterval`).
        #[arg(long = "chain", required = true, value_name = "PREFIX,KIND,RPC_URL")]
        chains: Vec<String>,
        /// How many slots the finalized header lies behind the attested header.
        #[arg(long, default_value_t = 2)]
        finality_slots: u64,
        /// How many of the 512 committee members sign each block (342 to 512).
        #[arg(long, default_value_t = 400)]
        participants: usize,
    },
    /// Print the checkpoint of a light client (finalized header and committee hashes) that a beacon API serves, as
    /// `name=value` lines for the deploy script.
    Checkpoint {
        /// The base URL of the beacon API, including the chain prefix.
        #[arg(long)]
        beacon_url: String,
        /// `ethereum` or `pulsechain`.
        #[arg(long)]
        chain: String,
    },
}

fn parse_chain_kind(text: &str) -> Result<ChainKind, String> {
    ChainKind::from_name(text)
        .ok_or_else(|| format!("unknown chain {text}: use ethereum or pulsechain"))
}

/// Reads `PREFIX,KIND,RPC_URL[,FIRST_SLOT]` into a mount of the server.
fn mount_of(text: &str, finality_slots: u64, participants: usize) -> Result<Mount, String> {
    let parts: Vec<&str> = text.split(',').collect();
    let [prefix, kind, rpc_url, rest @ ..] = parts.as_slice() else {
        return Err(format!(
            "--chain {text}: use PREFIX,KIND,RPC_URL[,FIRST_SLOT]"
        ));
    };
    let kind = parse_chain_kind(kind)?;
    let first_slot = match rest {
        [] => default_first_slot(kind),
        [slot] => slot
            .parse()
            .map_err(|error| format!("--chain {text}: first slot: {error}"))?,
        _ => return Err(format!("--chain {text}: too many parts")),
    };
    let settings = NodeSettings {
        kind,
        first_slot,
        finality_slots,
        participants,
    };
    let feed = RpcBlockFeed::new(Box::new(HttpRpc::new(rpc_url)));
    Ok(Mount {
        prefix: (*prefix).to_string(),
        node: Arc::new(BeaconNode::new(Box::new(feed), settings)),
    })
}

fn wait_for_deployment(path: &Path) -> Result<Deployment, String> {
    let mut told = false;
    while !path.exists() {
        if !told {
            eprintln!("waiting for {}: run the deploy step", path.display());
            told = true;
        }
        std::thread::sleep(Duration::from_secs(2));
    }
    deployment::load(path).map_err(|error| error.to_string())
}

fn run_traffic(deployment_path: &Path, settings: TrafficSettings) -> Result<(), String> {
    let deployment = wait_for_deployment(deployment_path)?;
    // The chains may still start. Try for a while before giving up.
    let mut attempts = 0;
    let mut traffic = loop {
        match Traffic::connect(&deployment, settings) {
            Ok(traffic) => break traffic,
            Err(error) if attempts < 30 => {
                attempts += 1;
                eprintln!("waiting for the chains: {error}");
                std::thread::sleep(Duration::from_secs(2));
            }
            Err(error) => return Err(error.to_string()),
        }
    };
    traffic.run_forever()
}

fn run_beacon_stub(deployment_path: &Path, listen: &str) -> Result<(), String> {
    let deployment = wait_for_deployment(deployment_path)?;
    let chains = vec![
        StubChain {
            prefix: "a".into(),
            rpc_url: deployment.chain_a.rpc_url.clone(),
            genesis_time: deployment.chain_a.gate_genesis_time,
        },
        StubChain {
            prefix: "b".into(),
            rpc_url: deployment.chain_b.rpc_url.clone(),
            genesis_time: deployment.chain_b.gate_genesis_time,
        },
    ];
    serve(listen, chains).map_err(|error| error.to_string())
}

fn run_signed_beacon(
    listen: &str,
    chains: &[String],
    finality_slots: u64,
    participants: usize,
) -> Result<(), String> {
    let mounts = chains
        .iter()
        .map(|text| mount_of(text, finality_slots, participants))
        .collect::<Result<Vec<_>, _>>()?;
    serve_signed_beacon(listen, mounts).map_err(|error| error.to_string())
}

fn run_checkpoint(beacon_url: &str, chain: &str) -> Result<(), String> {
    let checkpoint = read_checkpoint(&HttpClient::new(beacon_url), parse_chain_kind(chain)?)
        .map_err(|error| error.to_string())?;
    print!("{}", checkpoint.lines());
    Ok(())
}

fn run(cli: Cli) -> Result<(), String> {
    match cli.command {
        Command::Traffic {
            minimum_wait_seconds,
            maximum_wait_seconds,
            bots,
        } => run_traffic(
            &cli.deployment,
            TrafficSettings {
                minimum_wait_seconds,
                maximum_wait_seconds,
                bot_count: bots,
            },
        ),
        Command::BeaconStub { listen } => run_beacon_stub(&cli.deployment, &listen),
        Command::SignedBeacon {
            listen,
            chains,
            finality_slots,
            participants,
        } => run_signed_beacon(&listen, &chains, finality_slots, participants),
        Command::Checkpoint { beacon_url, chain } => run_checkpoint(&beacon_url, &chain),
    }
}

fn main() {
    if let Err(message) = run(Cli::parse()) {
        eprintln!("error: {message}");
        std::process::exit(1);
    }
}
