//! Builds the light-client update of a live beacon node and runs the guest program in the SP1 executor. It makes no proof.
//!
//! Usage:
//! `cargo run --release --features sp1 --example live_update -- --beacon-url <url> --chain <name> --head-slot <n>
//! --head-root <hash> --elf <path> [--source-rpc-url <url>] [--wait-seconds <n>]`
//!
//! The head is a finalized header of the node. Some nodes serve the state of a finalized header only while it is the newest
//! one (chain 943 serves an older state without its last historical summary, so it does not hash to the header). So the
//! example reads the state of the head at the start and serves it from memory. The prover still hashes it in full and
//! compares the root with the header. With `--wait-seconds <n>` the example asks again every 15 seconds until the node
//! has a newer final header than the head, or until `n` seconds pass.
//!
//! The example builds the update
//! with the same code as the `prove` command, runs `lc-core` natively, runs the ELF in the executor, and prints one JSON
//! object: the instruction count, the exit code, whether the public values equal the native ones, and the decoded fields.
//! An URL never appears in the output in full.

use alloy_primitives::{hex, B256};
use alloy_sol_types::SolValue;
use std::time::{Duration, Instant};
use zk_bridge_prover::beacon::http::{HttpBeaconSource, RpcExecutionHeaders};
use zk_bridge_prover::beacon::StoredHead;
use zk_bridge_prover::error::{Error, Result};
use zk_bridge_prover::light_client::{
    guest_input_bytes, public_values, verify_update_natively, ChainKind, LightClientOutput,
};
use zk_bridge_prover::prover::execute_program;
use zk_bridge_prover::rpc::{HttpClient, HttpGet, HttpResponse, HttpRpc};

/// A beacon client that serves one path from memory and asks the node for every other path.
struct HoldingClient {
    inner: HttpClient,
    held_path: String,
    held_body: Vec<u8>,
}

impl HoldingClient {
    /// Reads the state of the header with `head_root` now, and holds it.
    fn hold_state_of(inner: HttpClient, head_root: B256) -> Result<Self> {
        let header = inner.get(
            &format!("/eth/v1/beacon/headers/{head_root:#x}"),
            "application/json",
        )?;
        let header: serde_json::Value = serde_json::from_slice(&header.body)
            .map_err(|error| Error::Malformed(format!("header: {error}")))?;
        let state_root = header["data"]["header"]["message"]["state_root"]
            .as_str()
            .ok_or_else(|| Error::Beacon(format!("the node has no header {head_root:#x}")))?
            .to_string();
        let held_path = format!("/eth/v2/debug/beacon/states/{state_root}");
        let state = inner.get(&held_path, "application/octet-stream")?;
        if state.status != 200 {
            return Err(Error::Beacon(format!(
                "the node answers status {} for the state of the head",
                state.status
            )));
        }
        Ok(Self {
            inner,
            held_path,
            held_body: state.body,
        })
    }
}

impl HttpGet for HoldingClient {
    fn get(&self, path_and_query: &str, accept: &str) -> Result<HttpResponse> {
        if path_and_query == self.held_path {
            return Ok(HttpResponse {
                status: 200,
                body: self.held_body.clone(),
            });
        }
        self.inner.get(path_and_query, accept)
    }
}

/// The value after `--name` in the arguments.
fn option(arguments: &[String], name: &str) -> Option<String> {
    arguments
        .iter()
        .position(|argument| argument == name)
        .and_then(|index| arguments.get(index + 1))
        .cloned()
}

fn required(arguments: &[String], name: &str) -> Result<String> {
    option(arguments, name).ok_or_else(|| Error::Config(format!("the argument {name} is missing")))
}

fn run(arguments: &[String]) -> Result<serde_json::Value> {
    let chain = ChainKind::parse(&required(arguments, "--chain")?)?;
    let head_root: B256 = required(arguments, "--head-root")?
        .parse()
        .map_err(|error| Error::Config(format!("--head-root: {error}")))?;
    let client = HoldingClient::hold_state_of(
        HttpClient::new(&required(arguments, "--beacon-url")?),
        head_root,
    )?;
    let mut source = HttpBeaconSource::new(chain, Box::new(client));
    if let Some(url) = option(arguments, "--source-rpc-url") {
        source = source.with_execution_headers(Box::new(RpcExecutionHeaders::new(Box::new(
            HttpRpc::new(&url),
        ))));
    }
    let head = StoredHead {
        slot: required(arguments, "--head-slot")?
            .parse()
            .map_err(|error| Error::Config(format!("--head-slot: {error}")))?,
        root: head_root,
        next_committee_hash: match option(arguments, "--next-committee-hash") {
            Some(text) => text
                .parse()
                .map_err(|error| Error::Config(format!("--next-committee-hash: {error}")))?,
            None => B256::ZERO,
        },
    };
    let wait: u64 = match option(arguments, "--wait-seconds") {
        Some(text) => text
            .parse()
            .map_err(|error| Error::Config(format!("--wait-seconds: {error}")))?,
        None => 0,
    };
    let deadline = Instant::now() + Duration::from_secs(wait);
    let plan = loop {
        if let Some(plan) = source.plan_update(&head)? {
            break plan;
        }
        if Instant::now() >= deadline {
            return Err(Error::Beacon(
                "the head already is the newest final header of the node".into(),
            ));
        }
        std::thread::sleep(Duration::from_secs(15));
    };
    let native = public_values(&verify_update_natively(&plan.input)?);
    let elf = std::fs::read(required(arguments, "--elf")?)
        .map_err(|error| Error::Config(format!("--elf: {error}")))?;
    let run = execute_program(&elf, &guest_input_bytes(&plan.input))?;
    let decoded = LightClientOutput::abi_decode(&run.public_values)
        .map_err(|error| Error::Malformed(format!("public values: {error}")))?;
    Ok(serde_json::json!({
        "chain": chain.name(),
        "updates": plan.input.steps.len(),
        "latestFinalizedSlot": plan.latest_finalized_slot,
        "exitCode": run.exit_code,
        "instructions": run.instruction_count,
        "publicValuesBytes": run.public_values.len(),
        "publicValuesEqualNative": run.public_values == native,
        "previousHeadSlot": decoded.previousHeadSlot,
        "newHeadSlot": decoded.newHeadSlot,
        "newHeaderRoot": format!("{:#x}", decoded.newHeaderRoot),
        "executionBlockNumber": decoded.executionBlockNumber,
        "executionBlockHash": format!("{:#x}", decoded.executionBlockHash),
        "publicValues": hex::encode_prefixed(&run.public_values),
    }))
}

fn main() {
    let arguments: Vec<String> = std::env::args().collect();
    match run(&arguments) {
        Ok(value) => println!("{value}"),
        Err(error) => {
            eprintln!("error: {error}");
            std::process::exit(1);
        }
    }
}
