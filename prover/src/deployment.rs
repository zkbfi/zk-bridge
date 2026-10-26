//! The `deployment-file` command: the deployment file that the explorer reads.
//!
//! The explorer (`explorer/shared/src/pairs.ts`, `deploymentChainSchema`) reads one object with a section for each chain.
//! `docker/deploy.sh` names the sections `chain_a` and `chain_b`, and the explorer matches a section to a chain by its
//! `chain_id`. This module builds the same file from addresses on the command line, from the JSON of a Foundry broadcast
//! file, or from both. A flag overrides the broadcast file.
//!
//! The file never holds a key. It has no `rpc_url` unless the user passes one, and a URL with a path, a query or user
//! information is refused, because those parts hold keys. The explorer reads the RPC URL from the environment instead.

use crate::error::{Error, Result};
use alloy_primitives::Address;
use serde_json::{json, Map, Value};
use std::io::Write;
use std::path::Path;
use std::str::FromStr;

/// The keys that a chain section holds, in the order of the file. A test compares them with the TypeScript schema.
pub const SECTION_KEYS: [&str; 12] = [
    "chain_id",
    "rpc_url",
    "bridge",
    "mediator",
    "token_factory",
    "native_router",
    "wrapped_native",
    "gate",
    "light_client",
    "fee_router",
    "fork_registry",
    "start_block",
];

/// The section names of the file.
pub const SECTION_NAMES: [&str; 2] = ["chain_a", "chain_b"];

/// What is known about one chain section before the check.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct SectionDraft {
    /// The chain identifier.
    pub chain_id: Option<u64>,
    /// The RPC URL, only when the user passed one.
    pub rpc_url: Option<String>,
    /// The `MessageBridge`.
    pub bridge: Option<Address>,
    /// The `TokenMediator`.
    pub mediator: Option<Address>,
    /// The `TokenFactory`, which the mediator creates.
    pub token_factory: Option<Address>,
    /// The `WETHOmnibridgeRouter`.
    pub native_router: Option<Address>,
    /// The wrapped native token of the router.
    pub wrapped_native: Option<Address>,
    /// The `BeaconForkGate`.
    pub gate: Option<Address>,
    /// The `BeaconLightClient` that tracks the other chain.
    pub light_client: Option<Address>,
    /// The `FeeRouter`, when the chain has one.
    pub fee_router: Option<Address>,
    /// The `ForkRegistry`, when the chain has one.
    pub fork_registry: Option<Address>,
    /// The first block to index: the block before the first deployment transaction.
    pub start_block: Option<u64>,
}

/// A checked chain section.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ChainSection {
    /// The chain identifier. It is positive.
    pub chain_id: u64,
    /// The RPC URL, when the user passed one.
    pub rpc_url: Option<String>,
    /// The `MessageBridge`. It is not zero.
    pub bridge: Address,
    /// The `TokenMediator`. It is not zero.
    pub mediator: Address,
    /// The `TokenFactory`. It is not zero.
    pub token_factory: Address,
    /// The router of the native coin. Zero, together with `wrapped_native`, on a chain that has none.
    pub native_router: Address,
    /// The wrapped native token. Zero, together with `native_router`, on a chain that has none.
    pub wrapped_native: Address,
    /// The `BeaconForkGate`. It is not zero.
    pub gate: Address,
    /// The `BeaconLightClient`. It is not zero.
    pub light_client: Address,
    /// The `FeeRouter`, or `None`.
    pub fee_router: Option<Address>,
    /// The `ForkRegistry`, or `None`.
    pub fork_registry: Option<Address>,
    /// The first block to index.
    pub start_block: u64,
}

fn usage(reason: impl Into<String>) -> Error {
    Error::Usage(reason.into())
}

/// Parses `0x` and 40 hex digits.
///
/// # Errors
/// `Error::Usage` when the text is not an address of 20 bytes with a `0x` prefix.
pub fn parse_address(text: &str, what: &str) -> Result<Address> {
    if !text.starts_with("0x") || text.len() != 42 {
        return Err(usage(format!(
            "{what}: `{text}` is not 0x and 40 hex digits"
        )));
    }
    Address::from_str(text).map_err(|error| usage(format!("{what}: {error}")))
}

fn parse_number(text: &str, what: &str) -> Result<u64> {
    text.parse()
        .map_err(|_| usage(format!("{what}: `{text}` is not a whole number")))
}

/// Refuses an RPC URL that can hold a key: user information, a path, a query or a fragment.
///
/// # Errors
/// `Error::Usage` for such a URL or for a scheme other than http and https.
pub fn check_rpc_url(url: &str) -> Result<()> {
    let rest = url
        .strip_prefix("https://")
        .or_else(|| url.strip_prefix("http://"))
        .ok_or_else(|| usage("rpc_url must start with https:// or http://"))?;
    let hostless = rest.trim_end_matches('/');
    if hostless.is_empty() || hostless.contains(['/', '?', '#', '@']) {
        return Err(usage(
            "rpc_url may hold a key in its path, query or user information; leave it out and set EXPLORER_RPC_URL_<chain id> instead",
        ));
    }
    Ok(())
}

impl SectionDraft {
    /// Applies `key=value` pairs. A key is one of [`SECTION_KEYS`].
    ///
    /// # Errors
    /// `Error::Usage` for a pair without `=`, an unknown key, a bad address or a bad number.
    pub fn with_pairs(mut self, pairs: &[String]) -> Result<Self> {
        for pair in pairs {
            let (key, value) = pair
                .split_once('=')
                .ok_or_else(|| usage(format!("`{pair}` is not key=value")))?;
            let address = || parse_address(value, key);
            match key {
                "chain_id" => self.chain_id = Some(parse_number(value, key)?),
                "start_block" => self.start_block = Some(parse_number(value, key)?),
                "rpc_url" => {
                    check_rpc_url(value)?;
                    self.rpc_url = Some(value.to_string());
                }
                "bridge" => self.bridge = Some(address()?),
                "mediator" => self.mediator = Some(address()?),
                "token_factory" => self.token_factory = Some(address()?),
                "native_router" => self.native_router = Some(address()?),
                "wrapped_native" => self.wrapped_native = Some(address()?),
                "gate" => self.gate = Some(address()?),
                "light_client" => self.light_client = Some(address()?),
                "fee_router" => self.fee_router = Some(address()?),
                "fork_registry" => self.fork_registry = Some(address()?),
                other => {
                    return Err(usage(format!(
                        "unknown key `{other}`; the keys are {}",
                        SECTION_KEYS.join(", ")
                    )))
                }
            }
        }
        Ok(self)
    }

    /// Checks the draft: every required value is present, and the addresses that must not be zero are not zero.
    ///
    /// # Errors
    /// `Error::Usage` naming the missing or wrong value.
    pub fn finish(self, section: &str) -> Result<ChainSection> {
        let missing = |key: &str| {
            usage(format!("{section}: {key} is missing; pass it with --{section_flag} {key}=<value> or a broadcast file", section_flag = section.replace('_', "-")))
        };
        let required = |value: Option<Address>, key: &str| -> Result<Address> {
            let address = value.ok_or_else(|| missing(key))?;
            if address == Address::ZERO {
                return Err(usage(format!("{section}: {key} is the zero address")));
            }
            Ok(address)
        };
        let native_router = self.native_router.ok_or_else(|| missing("native_router"))?;
        let wrapped_native = self
            .wrapped_native
            .ok_or_else(|| missing("wrapped_native"))?;
        if (native_router == Address::ZERO) != (wrapped_native == Address::ZERO) {
            return Err(usage(format!(
                "{section}: native_router and wrapped_native are both zero (a chain without a wrapped native token) or both set"
            )));
        }
        let chain_id = self.chain_id.ok_or_else(|| missing("chain_id"))?;
        if chain_id == 0 {
            return Err(usage(format!("{section}: chain_id is zero")));
        }
        Ok(ChainSection {
            chain_id,
            rpc_url: self.rpc_url,
            bridge: required(self.bridge, "bridge")?,
            mediator: required(self.mediator, "mediator")?,
            token_factory: required(self.token_factory, "token_factory")?,
            native_router,
            wrapped_native,
            gate: required(self.gate, "gate")?,
            light_client: required(self.light_client, "light_client")?,
            fee_router: self.fee_router.filter(|address| *address != Address::ZERO),
            fork_registry: self
                .fork_registry
                .filter(|address| *address != Address::ZERO),
            start_block: self.start_block.ok_or_else(|| missing("start_block"))?,
        })
    }
}

fn contract_address(transaction: &Value, name: &str) -> Result<Address> {
    let text = transaction["contractAddress"].as_str().ok_or_else(|| {
        usage(format!(
            "broadcast: the transaction of {name} has no contractAddress"
        ))
    })?;
    parse_address(text, &format!("broadcast {name}"))
}

fn quantity_of(value: &Value) -> Option<u64> {
    let text = value.as_str()?;
    u64::from_str_radix(text.strip_prefix("0x")?, 16).ok()
}

/// The draft of one deployment (one chain) of a broadcast file. The names come from the `contractName` fields.
fn draft_of_deployment(deployment: &Value) -> Result<SectionDraft> {
    let transactions = deployment["transactions"]
        .as_array()
        .ok_or_else(|| usage("broadcast: a deployment has no transactions list"))?;
    let creations: Vec<&Value> = transactions
        .iter()
        .filter(|transaction| transaction["transactionType"] == "CREATE")
        .collect();
    let named = |name: &str| -> Vec<&Value> {
        creations
            .iter()
            .copied()
            .filter(|transaction| transaction["contractName"] == name)
            .collect()
    };
    // The script deploys the light client first. A chain with a fork registry deploys a second `BeaconLightClient` after
    // it, for the own-chain light client, so the first one is the light client of the pair.
    let single = |name: &str| -> Result<Option<Address>> {
        match named(name).as_slice() {
            [] => Ok(None),
            [only] => contract_address(only, name).map(Some),
            _ => Err(usage(format!(
                "broadcast: several {name} contracts; pass the one you mean by flag"
            ))),
        }
    };
    let light_client = named("BeaconLightClient")
        .first()
        .map(|transaction| contract_address(transaction, "BeaconLightClient"))
        .transpose()?;
    let mediator = single("TokenMediator")?;
    // The mediator creates its factory in its constructor, as its first contract: the address follows from the
    // mediator address and the creation nonce 1.
    let token_factory = mediator.map(|address| address.create(1));
    let router = named("WETHOmnibridgeRouter");
    let wrapped_native = match router.as_slice() {
        [only] => only["arguments"][1]
            .as_str()
            .map(|text| parse_address(text, "broadcast wrapped native token"))
            .transpose()?,
        _ => None,
    };
    let first_block = deployment["receipts"]
        .as_array()
        .into_iter()
        .flatten()
        .filter_map(|receipt| quantity_of(&receipt["blockNumber"]))
        .min();
    Ok(SectionDraft {
        chain_id: deployment["chain"].as_u64(),
        rpc_url: None,
        bridge: single("MessageBridge")?,
        mediator,
        token_factory,
        native_router: single("WETHOmnibridgeRouter")?,
        wrapped_native,
        gate: single("BeaconForkGate")?,
        light_client,
        fee_router: single("FeeRouter")?,
        fork_registry: single("ForkRegistry")?,
        start_block: first_block.map(|block| block.saturating_sub(1)),
    })
}

/// The drafts of a Foundry broadcast file: one for each deployment of a multi-chain file, or one for a single-chain file.
///
/// # Errors
/// `Error::Usage` for a file of another shape, or for a name that occurs twice where one is needed.
pub fn drafts_from_broadcast(file: &Value) -> Result<Vec<SectionDraft>> {
    if let Some(deployments) = file["deployments"].as_array() {
        return deployments.iter().map(draft_of_deployment).collect();
    }
    if file["transactions"].is_array() {
        return Ok(vec![draft_of_deployment(file)?]);
    }
    Err(usage(
        "the broadcast file has neither `deployments` nor `transactions`",
    ))
}

/// The options of one section: the flags, and the draft chosen from the broadcast file.
fn section_from(
    drafts: &mut Vec<Option<SectionDraft>>,
    position: usize,
    pairs: &[String],
    section: &str,
) -> Result<ChainSection> {
    let flags = SectionDraft::default().with_pairs(pairs)?;
    let chosen = match flags.chain_id {
        Some(chain_id) => drafts
            .iter_mut()
            .find(|draft| {
                draft
                    .as_ref()
                    .is_some_and(|draft| draft.chain_id == Some(chain_id))
            })
            .and_then(Option::take),
        None => drafts.get_mut(position).and_then(Option::take),
    };
    let base = chosen.unwrap_or_default();
    let merged = SectionDraft {
        chain_id: flags.chain_id.or(base.chain_id),
        rpc_url: flags.rpc_url,
        bridge: flags.bridge.or(base.bridge),
        mediator: flags.mediator.or(base.mediator),
        token_factory: flags.token_factory.or(base.token_factory),
        native_router: flags.native_router.or(base.native_router),
        wrapped_native: flags.wrapped_native.or(base.wrapped_native),
        gate: flags.gate.or(base.gate),
        light_client: flags.light_client.or(base.light_client),
        fee_router: flags.fee_router.or(base.fee_router),
        fork_registry: flags.fork_registry.or(base.fork_registry),
        start_block: flags.start_block.or(base.start_block),
    };
    merged.finish(section)
}

/// Builds both sections. `drafts` come from broadcast files in order. A section whose flags name a `chain_id` takes the
/// draft of that chain. A section with no `chain_id` flag takes the draft at its position. Flags override the draft.
///
/// # Errors
/// `Error::Usage` for a missing or wrong value, and for two sections of one chain.
pub fn build_sections(
    drafts: Vec<SectionDraft>,
    chain_a: &[String],
    chain_b: &[String],
) -> Result<[ChainSection; 2]> {
    let mut pool: Vec<Option<SectionDraft>> = drafts.into_iter().map(Some).collect();
    let first = section_from(&mut pool, 0, chain_a, "chain_a")?;
    let second = section_from(&mut pool, 1, chain_b, "chain_b")?;
    if first.chain_id == second.chain_id {
        return Err(usage(format!(
            "both sections are for chain {}; a pair joins two chains",
            first.chain_id
        )));
    }
    Ok([first, second])
}

fn lowercase(address: Address) -> String {
    format!("{address:#x}")
}

impl ChainSection {
    /// The JSON object of the section, with the keys of [`SECTION_KEYS`]. `rpc_url`, `fee_router` and `fork_registry` are
    /// left out when absent.
    pub fn to_json(&self) -> Value {
        let mut section = Map::new();
        section.insert("chain_id".into(), json!(self.chain_id));
        if let Some(url) = &self.rpc_url {
            section.insert("rpc_url".into(), json!(url));
        }
        for (key, address) in [
            ("bridge", self.bridge),
            ("mediator", self.mediator),
            ("token_factory", self.token_factory),
            ("native_router", self.native_router),
            ("wrapped_native", self.wrapped_native),
            ("gate", self.gate),
            ("light_client", self.light_client),
        ] {
            section.insert(key.into(), json!(lowercase(address)));
        }
        for (key, address) in [
            ("fee_router", self.fee_router),
            ("fork_registry", self.fork_registry),
        ] {
            if let Some(address) = address {
                section.insert(key.into(), json!(lowercase(address)));
            }
        }
        section.insert("start_block".into(), json!(self.start_block));
        Value::Object(section)
    }
}

/// The deployment file for two sections.
pub fn deployment_json(sections: &[ChainSection; 2]) -> Value {
    json!({
        SECTION_NAMES[0]: sections[0].to_json(),
        SECTION_NAMES[1]: sections[1].to_json(),
    })
}

/// What to do when the output file exists.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Existing {
    /// Stop with an error.
    Refuse,
    /// Replace the file.
    Replace,
}

/// Writes the file with mode 0600. With [`Existing::Refuse`] an existing file stops the call. With [`Existing::Replace`]
/// the new content goes to a new file in the same directory, which then takes the place of the old one.
///
/// # Errors
/// `Error::Usage` when the file exists and may not be replaced, or when a write fails.
pub fn write_private_file(path: &Path, content: &str, existing: Existing) -> Result<()> {
    use std::os::unix::fs::OpenOptionsExt;
    let failure = |error: std::io::Error| usage(format!("{}: {error}", path.display()));
    let target = match existing {
        Existing::Refuse => path.to_path_buf(),
        Existing::Replace => path.with_extension(format!("tmp-{}", std::process::id())),
    };
    let mut file = std::fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .mode(0o600)
        .open(&target)
        .map_err(|error| match error.kind() {
            std::io::ErrorKind::AlreadyExists if existing == Existing::Refuse => usage(format!(
                "{} exists; pass --force to replace it",
                path.display()
            )),
            _ => failure(error),
        })?;
    file.write_all(content.as_bytes()).map_err(failure)?;
    file.sync_all().map_err(failure)?;
    if existing == Existing::Replace {
        std::fs::rename(&target, path).map_err(failure)?;
    }
    Ok(())
}
