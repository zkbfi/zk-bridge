//! The `local-network` binary: bots and a beacon stub for the local two-chain network in `docker/`.
//!
//! It is for development only and is built with the cargo feature `dev-source`. The production service
//! (`zk-bridge-prover`) does not use it.

use clap::{Parser, Subcommand};
use std::path::{Path, PathBuf};
use std::time::Duration;
use zk_bridge_prover::local_network::beacon_stub::{serve, StubChain};
use zk_bridge_prover::local_network::deployment::{self, Deployment};
use zk_bridge_prover::local_network::traffic::{Traffic, TrafficSettings};

/// Tools for the local network.
#[derive(Debug, Parser)]
#[command(name = "local-network", version, about)]
struct Cli {
    /// The JSON file that the deploy step writes. The program waits until it exists.
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

fn run(cli: Cli) -> Result<(), String> {
    let deployment = wait_for_deployment(&cli.deployment)?;
    match cli.command {
        Command::Traffic {
            minimum_wait_seconds,
            maximum_wait_seconds,
            bots,
        } => {
            let settings = TrafficSettings {
                minimum_wait_seconds,
                maximum_wait_seconds,
                bot_count: bots,
            };
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
        Command::BeaconStub { listen } => {
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
            serve(&listen, chains).map_err(|error| error.to_string())
        }
    }
}

fn main() {
    if let Err(message) = run(Cli::parse()) {
        eprintln!("error: {message}");
        std::process::exit(1);
    }
}
