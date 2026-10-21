//! The deployment record: the addresses that the deploy step of `docker/` writes to the shared volume.

use crate::error::{Error, Result};
use alloy_primitives::Address;
use serde::Deserialize;
use std::path::Path;
use std::str::FromStr;

/// One chain as the JSON file describes it. Addresses are text here and become [`Address`] in [`ChainRecord`].
#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct RawChain {
    name: String,
    rpc_url: String,
    chain_id: u64,
    token: String,
    vault: String,
    gate: String,
    light_client: String,
    gate_genesis_time: u64,
}

/// The whole file.
#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct RawDeployment {
    chain_a: RawChain,
    chain_b: RawChain,
}

/// One deployed chain.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ChainRecord {
    /// A short name for logs.
    pub name: String,
    /// The execution RPC URL, as the other containers reach it.
    pub rpc_url: String,
    /// The chain identifier.
    pub chain_id: u64,
    /// The test token on this chain.
    pub token: Address,
    /// The bridge vault on this chain.
    pub vault: Address,
    /// The deposit gate that the vault reads.
    pub gate: Address,
    /// The light client of this chain. It tracks the other chain.
    pub light_client: Address,
    /// The genesis time of the beacon clock of the gate of this chain.
    pub gate_genesis_time: u64,
}

/// Both chains.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Deployment {
    /// Chain A (identifier 1).
    pub chain_a: ChainRecord,
    /// Chain B (identifier 369).
    pub chain_b: ChainRecord,
}

fn address_of(text: &str, field: &str, chain: &str) -> Result<Address> {
    Address::from_str(text)
        .map_err(|error| Error::Config(format!("deployment {chain}.{field}: {error}")))
}

fn record_of(raw: RawChain, label: &str) -> Result<ChainRecord> {
    Ok(ChainRecord {
        token: address_of(&raw.token, "token", label)?,
        vault: address_of(&raw.vault, "vault", label)?,
        gate: address_of(&raw.gate, "gate", label)?,
        light_client: address_of(&raw.light_client, "light_client", label)?,
        name: raw.name,
        rpc_url: raw.rpc_url,
        chain_id: raw.chain_id,
        gate_genesis_time: raw.gate_genesis_time,
    })
}

/// Reads a deployment record from JSON text.
///
/// # Errors
/// `Error::Config` for a missing field, an unknown field or an address that does not parse.
pub fn parse(text: &str) -> Result<Deployment> {
    let raw: RawDeployment = serde_json::from_str(text)
        .map_err(|error| Error::Config(format!("deployment file: {error}")))?;
    Ok(Deployment {
        chain_a: record_of(raw.chain_a, "chain_a")?,
        chain_b: record_of(raw.chain_b, "chain_b")?,
    })
}

/// Reads a deployment record from a file.
///
/// # Errors
/// `Error::Config` when the file cannot be read, and the errors of [`parse`].
pub fn load(path: &Path) -> Result<Deployment> {
    let text = std::fs::read_to_string(path)
        .map_err(|error| Error::Config(format!("{}: {error}", path.display())))?;
    parse(&text)
}

#[cfg(test)]
mod tests {
    use super::*;

    const CHAIN: &str = r#"{ "name": "chain-a", "rpc_url": "http://chain-a:8545", "chain_id": 1,
        "token": "0x5FbDB2315678afecb367f032d93F642f64180aa3", "vault": "0xe7f1725E7734CE288F8367e1Bb143E90bb3F0512",
        "gate": "0x9fE46736679d2D9a65F0992F2272dE9f3c7fa6e0", "light_client": "0xCf7Ed3AccA5a467e9e704C703E8D87F634fB0Fc9",
        "gate_genesis_time": 1600000000 }"#;

    fn file(chain_a: &str, chain_b: &str) -> String {
        format!(r#"{{ "chain_a": {chain_a}, "chain_b": {chain_b} }}"#)
    }

    /// Claim: the file the deploy step writes parses, and each address lands in the field of its name.
    /// Why it matters: a swapped vault and gate would send deposits to the wrong contract, and the types would not warn.
    #[test]
    fn a_record_keeps_every_address_in_its_own_field() {
        let chain_b = CHAIN
            .replace("chain-a", "chain-b")
            .replace("\"chain_id\": 1", "\"chain_id\": 369");
        let deployment = parse(&file(CHAIN, &chain_b)).unwrap();
        assert_eq!(deployment.chain_a.chain_id, 1);
        assert_eq!(deployment.chain_b.chain_id, 369);
        assert_eq!(
            format!("{:#x}", deployment.chain_a.vault),
            "0xe7f1725e7734ce288f8367e1bb143e90bb3f0512"
        );
        assert_eq!(
            format!("{:#x}", deployment.chain_a.gate),
            "0x9fe46736679d2d9a65f0992f2272de9f3c7fa6e0"
        );
        assert_eq!(deployment.chain_a.gate_genesis_time, 1_600_000_000);
    }

    /// Claim: a bad address, a missing field and an unknown field are all refused.
    /// Why it matters: the bots must stop at a damaged file and not run with a zero address.
    #[test]
    fn a_damaged_record_is_refused() {
        let bad_address = CHAIN.replace("0xe7f1725E7734CE288F8367e1Bb143E90bb3F0512", "0x1234");
        assert!(parse(&file(&bad_address, CHAIN)).is_err());
        let missing = CHAIN.replace("\"chain_id\": 1,", "");
        assert!(parse(&file(&missing, CHAIN)).is_err());
        let extra = CHAIN.replace("\"chain_id\": 1,", "\"chain_id\": 1, \"colour\": \"red\",");
        assert!(parse(&file(&extra, CHAIN)).is_err());
    }
}
