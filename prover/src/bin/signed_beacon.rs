//! The `signed-beacon` binary: a beacon chain with real sync committee signatures over the blocks of local Anvil chains.
//!
//! It is for development only (cargo feature `signed-beacon`). The end-to-end run in `docs/end-to-end-real-proofs.md` starts
//! it next to two Anvil chains. The production commands do not use it.

use clap::{Parser, Subcommand};
use std::sync::Arc;
use zk_bridge_prover::light_client::ChainKind;
use zk_bridge_prover::local_network::signed_beacon::node::{
    default_first_slot, serve, BeaconNode, Mount, NodeSettings, RpcBlockFeed,
};
use zk_bridge_prover::local_network::signed_beacon::checkpoint::read_checkpoint;
use zk_bridge_prover::rpc::{HttpClient, HttpRpc};

/// Serves a signed beacon chain over local execution chains.
#[derive(Debug, Parser)]
#[command(name = "signed-beacon", version, about)]
struct Cli {
    #[command(subcommand)]
    command: Command,
}

#[derive(Debug, Subcommand)]
enum Command {
    /// Serve the beacon chains.
    Serve(ServeArguments),
    /// Print the checkpoint of a light client (finalized header and committee hashes) that a node serves, as `name=value`
    /// lines for the deploy script.
    Checkpoint {
        /// The base URL of the beacon API, including the chain prefix.
        #[arg(long)]
        beacon_url: String,
        /// `ethereum`, `pulsechain`, `sepolia` or `pulsechain-testnet-v4`.
        #[arg(long)]
        chain: String,
    },
}

#[derive(Debug, clap::Args)]
struct ServeArguments {
    /// The address to listen on.
    #[arg(long, default_value = "127.0.0.1:29000")]
    listen: String,
    /// One chain: `PREFIX,KIND,RPC_URL` or `PREFIX,KIND,RPC_URL,FIRST_SLOT`. The beacon API of the chain answers under
    /// `/PREFIX`. KIND is `ethereum`, `pulsechain`, `sepolia` or `pulsechain-testnet-v4`. The execution chain must mine
    /// one block per slot, on the slot grid (Anvil with `anvil_setBlockTimestampInterval`).
    #[arg(long = "chain", required = true, value_name = "PREFIX,KIND,RPC_URL")]
    chains: Vec<String>,
    /// How many slots the finalized header lies behind the attested header.
    #[arg(long, default_value_t = 2)]
    finality_slots: u64,
    /// How many of the 512 committee members sign each block (342 to 512).
    #[arg(long, default_value_t = 400)]
    participants: usize,
}

/// Reads `PREFIX,KIND,RPC_URL[,FIRST_SLOT]` into a mount of the server.
fn mount_of(text: &str, finality_slots: u64, participants: usize) -> Result<Mount, String> {
    let parts: Vec<&str> = text.split(',').collect();
    let [prefix, kind, rpc_url, rest @ ..] = parts.as_slice() else {
        return Err(format!("--chain {text}: use PREFIX,KIND,RPC_URL[,FIRST_SLOT]"));
    };
    let kind = ChainKind::from_name(kind)
        .ok_or_else(|| format!("unknown chain {kind}: use ethereum, pulsechain, sepolia or pulsechain-testnet-v4"))?;
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

fn run_serve(arguments: &ServeArguments) -> Result<(), String> {
    let mounts = arguments
        .chains
        .iter()
        .map(|text| mount_of(text, arguments.finality_slots, arguments.participants))
        .collect::<Result<Vec<_>, _>>()?;
    serve(&arguments.listen, mounts).map_err(|error| error.to_string())
}

fn run_checkpoint(beacon_url: &str, chain: &str) -> Result<(), String> {
    let kind = ChainKind::from_name(chain).ok_or_else(|| format!("unknown chain {chain}"))?;
    let checkpoint =
        read_checkpoint(&HttpClient::new(beacon_url), kind).map_err(|error| error.to_string())?;
    print!("{}", checkpoint.lines());
    Ok(())
}

fn run(cli: Cli) -> Result<(), String> {
    match cli.command {
        Command::Serve(arguments) => run_serve(&arguments),
        Command::Checkpoint { beacon_url, chain } => run_checkpoint(&beacon_url, &chain),
    }
}

fn main() {
    if let Err(message) = run(Cli::parse()) {
        eprintln!("error: {message}");
        std::process::exit(1);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A chain argument with three parts mounts the chain under its prefix at the default first slot of the kind.
    #[test]
    fn a_chain_argument_mounts_the_chain_under_its_prefix() {
        let mount = mount_of("a,ethereum,http://127.0.0.1:1", 2, 400).expect("a valid chain argument");
        assert_eq!(mount.prefix, "a");
    }

    /// The fourth part sets the first slot. A text that is no number is refused with the argument in the message.
    #[test]
    fn a_first_slot_that_is_no_number_is_refused() {
        assert!(mount_of("a,ethereum,http://127.0.0.1:1,64", 2, 400).is_ok());
        let error = mount_of("a,ethereum,http://127.0.0.1:1,soon", 2, 400).err().expect("a refusal");
        assert!(error.contains("a,ethereum,http://127.0.0.1:1,soon"), "{error}");
    }

    /// A name that is no chain kind is refused, and the message lists the four known names.
    #[test]
    fn an_unknown_chain_kind_is_refused_with_the_known_names() {
        let error = mount_of("a,dogecoin,http://127.0.0.1:1", 2, 400).err().expect("a refusal");
        assert!(error.contains("pulsechain-testnet-v4"), "{error}");
    }

    /// Fewer than three parts, and more than four, are refused.
    #[test]
    fn a_chain_argument_needs_three_or_four_parts() {
        assert!(mount_of("a,ethereum", 2, 400).is_err());
        assert!(mount_of("a,ethereum,http://x,1,extra", 2, 400).is_err());
    }
}
