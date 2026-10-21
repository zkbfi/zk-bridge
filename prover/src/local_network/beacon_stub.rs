//! A stand-in for the beacon API on the local network, for `route-health` only.
//!
//! `route-health` asks the source beacon API three questions: the genesis time, the fork schedule and the head slot.
//! The local chains are Anvil chains and have no beacon node, so this server answers from the chain. The head slot is
//! the slot that the development beacon source gives to the latest block, so the light client head and the source head
//! lie on one scale. The fork schedule has one entry, the Capella version of PulseChain, the only version that the local gates support. The
//! server does not serve light-client updates (it answers 404, which `route-health` reads as "no update").
//!
//! The prover itself never calls this server: its `run` path uses `beacon.kind = "dev"`.

use crate::beacon::dev::{DevBeaconSource, DEFAULT_SLOT_OFFSET};
use crate::error::{Error, Result};
use crate::light_client::ChainKind;
use crate::rpc::{parse_quantity, HttpRpc, JsonRpc};
use serde_json::{json, Value};
use std::io::{BufRead, BufReader, Write};
use std::net::{TcpListener, TcpStream};
use std::sync::Arc;

/// One chain that the server answers for, under the path prefix `/<prefix>`.
#[derive(Clone, Debug)]
pub struct StubChain {
    /// The first path segment, for example `a`.
    pub prefix: String,
    /// The RPC URL of the Anvil chain.
    pub rpc_url: String,
    /// The genesis time to report.
    pub genesis_time: u64,
}

/// The slot of the latest block on the scale of the development beacon source.
fn head_slot(rpc_url: &str) -> Result<u64> {
    let rpc = HttpRpc::new(rpc_url);
    let number = parse_quantity(&rpc.call("eth_blockNumber", json!([]))?)?;
    Ok(DevBeaconSource::new(ChainKind::Pulsechain, 1, DEFAULT_SLOT_OFFSET).slot_of(number, 0))
}

/// The answer to one request path (without the chain prefix): the status code and the JSON body.
///
/// `head_slot` is called only for the head request.
pub fn respond(
    path: &str,
    genesis_time: u64,
    head_slot: impl FnOnce() -> Result<u64>,
) -> (u16, Value) {
    let path = path.split('?').next().unwrap_or_default();
    match path {
        "/eth/v1/beacon/genesis" => (
            200,
            json!({ "data": {
                "genesis_time": genesis_time.to_string(),
                "genesis_validators_root": format!("{:#x}", alloy_primitives::B256::ZERO),
                "genesis_fork_version": "0x00000000",
            }}),
        ),
        "/eth/v1/config/fork_schedule" => (
            200,
            json!({ "data": [{
                "previous_version": "0x0000036b",
                "current_version": "0x0000036c",
                "epoch": "3",
            }]}),
        ),
        "/eth/v1/beacon/headers/head" => match head_slot() {
            Ok(slot) => (
                200,
                json!({ "data": {
                    "root": format!("{:#x}", alloy_primitives::B256::ZERO),
                    "canonical": true,
                    "header": { "message": { "slot": slot.to_string() }, "signature": "0x" },
                }}),
            ),
            Err(error) => (502, json!({ "message": format!("{error}") })),
        },
        _ => (
            404,
            json!({ "message": "the local beacon stub does not serve this path" }),
        ),
    }
}

/// Splits `/a/eth/v1/...` into the chain that owns the prefix and the rest of the path.
fn route<'a>(chains: &'a [StubChain], target: &'a str) -> Option<(&'a StubChain, &'a str)> {
    let rest = target.strip_prefix('/')?;
    let (prefix, tail) = rest.split_once('/')?;
    let chain = chains.iter().find(|chain| chain.prefix == prefix)?;
    // The rest of the path starts at the slash that follows the prefix.
    let start = target.len() - tail.len() - 1;
    Some((chain, &target[start..]))
}

fn write_answer(mut stream: TcpStream, status: u16, body: &Value) -> std::io::Result<()> {
    let text = body.to_string();
    let reason = match status {
        200 => "OK",
        404 => "Not Found",
        _ => "Bad Gateway",
    };
    write!(
        stream,
        "HTTP/1.1 {status} {reason}\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{text}",
        text.len()
    )
}

fn handle(stream: TcpStream, chains: &[StubChain]) -> std::io::Result<()> {
    let mut reader = BufReader::new(stream.try_clone()?);
    let mut request_line = String::new();
    reader.read_line(&mut request_line)?;
    // Read and drop the headers.
    loop {
        let mut header = String::new();
        if reader.read_line(&mut header)? == 0 || header == "\r\n" || header == "\n" {
            break;
        }
    }
    let mut parts = request_line.split_whitespace();
    let (method, target) = (
        parts.next().unwrap_or_default(),
        parts.next().unwrap_or_default(),
    );
    if method != "GET" {
        return write_answer(stream, 404, &json!({ "message": "GET only" }));
    }
    let Some((chain, path)) = route(chains, target) else {
        return write_answer(stream, 404, &json!({ "message": "unknown chain prefix" }));
    };
    let (status, body) = respond(path, chain.genesis_time, || head_slot(&chain.rpc_url));
    write_answer(stream, status, &body)
}

/// Serves until the process stops. Each connection gets its own thread.
///
/// # Errors
/// `Error::Config` when the address cannot be bound.
pub fn serve(listen: &str, chains: Vec<StubChain>) -> Result<()> {
    let listener = TcpListener::bind(listen).map_err(|error| {
        Error::Config(format!("beacon stub: cannot listen on {listen}: {error}"))
    })?;
    let chains = Arc::new(chains);
    for stream in listener.incoming().flatten() {
        let chains = Arc::clone(&chains);
        std::thread::spawn(move || {
            let _ = handle(stream, &chains);
        });
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::local_network::synthetic_fork::CAPELLA_VERSION;

    fn chains() -> Vec<StubChain> {
        ["a", "b"]
            .iter()
            .map(|prefix| StubChain {
                prefix: (*prefix).to_string(),
                rpc_url: format!("http://{prefix}"),
                genesis_time: 1,
            })
            .collect()
    }

    /// Claim: the three answers parse with the parsers that `route-health` uses.
    /// Why it matters: the stub is only useful if the real command reads it; a changed field name must fail here.
    #[test]
    fn the_answers_parse_with_the_route_health_parsers() {
        use crate::route_health::{parse_fork_schedule, parse_genesis_time, parse_head_slot};
        let (status, genesis) = respond("/eth/v1/beacon/genesis", 1_600_000_000, || Ok(0));
        assert_eq!(
            (status, parse_genesis_time(&genesis).unwrap()),
            (200, 1_600_000_000)
        );
        let (_, schedule) = respond("/eth/v1/config/fork_schedule", 0, || Ok(0));
        let entries = parse_fork_schedule(&schedule).unwrap();
        assert_eq!(entries.len(), 1);
        assert_eq!(entries[0].version, CAPELLA_VERSION);
        let (_, head) = respond("/eth/v1/beacon/headers/head", 0, || Ok(4_321));
        assert_eq!(parse_head_slot(&head).unwrap(), 4_321);
    }

    /// Claim: light-client updates and unknown paths give 404, a failed chain read gives 502, and a query string is ignored.
    /// Why it matters: `route-health` reads 404 as "no update" and must never read a failure as an open route.
    #[test]
    fn other_paths_and_failures_are_refused() {
        let updates = "/eth/v1/beacon/light_client/updates?start_period=1&count=2";
        assert_eq!(respond(updates, 0, || Ok(0)).0, 404);
        assert_eq!(respond("/nothing", 0, || Ok(0)).0, 404);
        let failed = respond("/eth/v1/beacon/headers/head", 0, || {
            Err(Error::Http("down".into()))
        });
        assert_eq!(failed.0, 502);
        assert_eq!(respond("/eth/v1/beacon/genesis?x=1", 5, || Ok(0)).0, 200);
    }

    /// Claim: the first path segment picks the chain and the rest of the path stays whole, query string included.
    /// Why it matters: chain A and chain B share one server; a wrong pick would report the other chain's head.
    #[test]
    fn the_prefix_picks_the_chain() {
        let chains = chains();
        let (chain, path) = route(&chains, "/b/eth/v1/beacon/genesis").unwrap();
        assert_eq!(
            (chain.prefix.as_str(), path),
            ("b", "/eth/v1/beacon/genesis")
        );
        let (chain, path) = route(&chains, "/a/eth/v1/x?start_period=1&count=2").unwrap();
        assert_eq!(
            (chain.prefix.as_str(), path),
            ("a", "/eth/v1/x?start_period=1&count=2")
        );
        assert!(route(&chains, "/c/eth/v1/beacon/genesis").is_none());
        assert!(route(&chains, "/eth").is_none());
    }
}
