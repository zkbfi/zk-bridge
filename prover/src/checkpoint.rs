//! The `checkpoint` command: the values that the deploy step writes into a new light client.
//!
//! A light client starts at one finalized header. The deploy configuration needs the slot and the root of that header and
//! the hashes of the current and the next sync committee. All four values must come from the same finalized root, so this
//! module fixes the root first and then reads everything for that root.
//!
//! Two sources answer. The `light_client/bootstrap` route gives the header and the current committee, and the committee
//! branch proves that the committee belongs to the header. A node that does not run the light-client server answers 404.
//! Then the finalized state gives the same values, and the state root must equal the `state_root` of the header.
//!
//! A Gloas header is read like any other: the state is hashed with the Gloas layout (progressive containers) and compared with the header.

use crate::beacon::http::{bootstrap_unavailable, log_repaired_state};
use crate::error::{Error, Result};
use crate::light_client::{
    beacon_header_from_json, bootstrap_from_json, committee_hash, complete_frozen_state,
    header_root, missing_summary_index, state_layout_at, BeaconHeader, ChainKind, StateView,
};
use crate::rpc::{HttpGet, HttpResponse};
use alloy_primitives::B256;
use serde_json::{json, Value};

/// Where the committee values came from.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum CheckpointSource {
    /// The `light_client/bootstrap` route, with its committee branch checked.
    Bootstrap,
    /// The finalized state, with its root checked against the header.
    DebugState,
}

impl CheckpointSource {
    /// The name in the JSON object.
    pub fn name(self) -> &'static str {
        match self {
            Self::Bootstrap => "bootstrap",
            Self::DebugState => "debugState",
        }
    }
}

/// The checkpoint values and the chain facts that the deploy configuration needs.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct CheckpointReport {
    /// The chain.
    pub chain: ChainKind,
    /// Where the committee values came from.
    pub source: CheckpointSource,
    /// The slot of the finalized header.
    pub initial_slot: u64,
    /// The hash tree root of the finalized header.
    pub initial_header_root: B256,
    /// The hash of the sync committee of the period of the header.
    pub initial_sync_committee_hash: B256,
    /// The hash of the next sync committee. Zero when [`CheckpointReport::next_committee_known`] is false.
    pub initial_next_sync_committee_hash: B256,
    /// Whether a next committee was read. When false, the next hash is zero, as the light client stores it.
    pub next_committee_known: bool,
    /// The genesis time of the beacon chain.
    pub genesis_time: u64,
}

impl CheckpointReport {
    /// The JSON object that the command prints. Slots and times are numbers, hashes are `0x` hex.
    pub fn to_json(&self) -> Value {
        let spec = self.chain.spec();
        json!({
            "schemaVersion": 1,
            "chain": self.chain.name(),
            "source": self.source.name(),
            "initialSlot": self.initial_slot,
            "initialHeaderRoot": format!("{:#x}", self.initial_header_root),
            "initialSyncCommitteeHash": format!("{:#x}", self.initial_sync_committee_hash),
            "initialNextSyncCommitteeHash": format!("{:#x}", self.initial_next_sync_committee_hash),
            "nextCommitteeKnown": self.next_committee_known,
            "genesisValidatorsRoot": format!("{:#x}", spec.genesis_validators_root),
            "genesisTime": self.genesis_time,
            "secondsPerSlot": spec.seconds_per_slot,
            "capellaForkEpoch": spec.capella_fork_slot().map(|slot| slot / spec.slots_per_epoch),
            "capellaEra": spec.capella_era().ok(),
        })
    }
}

fn get(client: &dyn HttpGet, path: &str, accept: &str) -> Result<HttpResponse> {
    client.get(path, accept)
}

fn json_body(client: &dyn HttpGet, path: &str) -> Result<Value> {
    let response = get(client, path, "application/json")?;
    if response.status != 200 {
        return Err(Error::Beacon(format!(
            "GET {path}: status {}",
            response.status
        )));
    }
    serde_json::from_slice(&response.body)
        .map_err(|error| Error::Malformed(format!("GET {path}: {error}")))
}

fn number_field(value: &Value, what: &str) -> Result<u64> {
    value
        .as_str()
        .and_then(|text| text.parse().ok())
        .ok_or_else(|| Error::Malformed(format!("{what} is not a number")))
}

/// Reads the genesis and checks the genesis validators root against the chain specification of `lc-core`.
fn read_genesis_time(client: &dyn HttpGet, chain: ChainKind) -> Result<u64> {
    let genesis = json_body(client, "/eth/v1/beacon/genesis")?;
    let root: B256 = genesis["data"]["genesis_validators_root"]
        .as_str()
        .and_then(|text| text.parse().ok())
        .ok_or_else(|| Error::Malformed("genesis_validators_root".into()))?;
    let expected = chain.spec().genesis_validators_root;
    if root != expected {
        return Err(Error::Beacon(format!(
            "the node reports genesis validators root {root:#x}, but {} has {expected:#x}",
            chain.name()
        )));
    }
    number_field(&genesis["data"]["genesis_time"], "genesis_time")
}

/// Checks the beacon configuration of the node against the chain specification of `lc-core`: the slot time, the slots per
/// epoch and the epoch of the Capella fork.
fn check_spec(client: &dyn HttpGet, chain: ChainKind) -> Result<()> {
    let answer = json_body(client, "/eth/v1/config/spec")?;
    let data = &answer["data"];
    let spec = chain.spec();
    let capella_epoch = spec
        .capella_fork_slot()
        .map(|slot| slot / spec.slots_per_epoch);
    let checks = [
        ("SECONDS_PER_SLOT", Some(spec.seconds_per_slot)),
        ("SLOTS_PER_EPOCH", Some(spec.slots_per_epoch)),
        ("CAPELLA_FORK_EPOCH", capella_epoch),
    ];
    for (key, expected) in checks {
        let reported = number_field(&data[key], key)?;
        if Some(reported) != expected {
            return Err(Error::Beacon(format!(
                "the node reports {key} {reported}, but {} has {expected:?}",
                chain.name()
            )));
        }
    }
    Ok(())
}

/// Reads the header of the checkpoint. With no root, it is the newest finalized header. The header must hash to the root.
fn read_header(client: &dyn HttpGet, finalized_root: Option<B256>) -> Result<(BeaconHeader, B256)> {
    let id = finalized_root.map_or_else(|| "finalized".to_string(), |root| format!("{root:#x}"));
    let answer = json_body(client, &format!("/eth/v1/beacon/headers/{id}"))?;
    if answer["finalized"] == Value::Bool(false) {
        return Err(Error::Beacon(format!(
            "the node says that the header {id} is not finalized"
        )));
    }
    let header = beacon_header_from_json(&answer["data"]["header"]["message"])?;
    let root = header_root(&header);
    if let Some(wanted) = finalized_root.filter(|wanted| *wanted != root) {
        return Err(Error::Beacon(format!(
            "the header that the node served for {wanted:#x} hashes to {root:#x}"
        )));
    }
    Ok((header, root))
}

/// Reads the state of the header from the node, then from each state URL in order. `None` when every one of them
/// answers 404. Each state must hash to `header.state_root`, after the PulseChain repair where it applies; one that does
/// not moves on to the next URL. With no state URL an error of the node comes back unchanged.
fn read_state(
    client: &dyn HttpGet,
    state_clients: &[&dyn HttpGet],
    chain: ChainKind,
    header: &BeaconHeader,
) -> Result<Option<StateView>> {
    let mut failures: Vec<Error> = Vec::new();
    let mut unserved = 0;
    for source in std::iter::once(client).chain(state_clients.iter().copied()) {
        match read_state_from(client, source, chain, header) {
            Ok(Some(state)) => return Ok(Some(state)),
            Ok(None) => unserved += 1,
            Err(error) => failures.push(error),
        }
    }
    match failures.len() {
        0 => Ok(None),
        1 if unserved == 0 => Err(failures.remove(0)),
        _ => {
            let reasons: Vec<String> = failures.iter().map(ToString::to_string).collect();
            Err(Error::Beacon(format!(
                "no beacon API served the state {:#x} ({unserved} did not have it): {}",
                header.state_root,
                reasons.join("; ")
            )))
        }
    }
}

/// Reads the state of the header from `source`. `None` for 404. A repair reads the newest finalized state through the
/// main node `client`.
fn read_state_from(
    client: &dyn HttpGet,
    source: &dyn HttpGet,
    chain: ChainKind,
    header: &BeaconHeader,
) -> Result<Option<StateView>> {
    let path = format!("/eth/v2/debug/beacon/states/{:#x}", header.state_root);
    let response = get(source, &path, "application/octet-stream")?;
    match response.status {
        200 => {}
        404 => return Ok(None),
        status => return Err(Error::Beacon(format!("GET {path}: status {status}"))),
    }
    let mut state = StateView::parse(&response.body, chain)?;
    if state.root() != header.state_root {
        state = repair_frozen_state(client, chain, state, header.state_root)?;
    }
    if state.slot() != header.slot {
        return Err(Error::Beacon(format!(
            "the state is at slot {}, the header at slot {}",
            state.slot(),
            header.slot
        )));
    }
    Ok(Some(state))
}

/// A state that does not hash to `state_root`, completed when it is a PulseChain state served one summary short. The
/// missing entry comes from the newest finalized state, which must itself hash to the root its header names. Any other
/// mismatch is an error. See `missing_summary_index`.
fn repair_frozen_state(
    client: &dyn HttpGet,
    chain: ChainKind,
    state: StateView,
    state_root: B256,
) -> Result<StateView> {
    let served_root = state.root();
    let mismatch = || {
        Error::Beacon(format!(
            "the state of the checkpoint header hashes to {served_root:#x}, not {state_root:#x}"
        ))
    };
    let Some(index) = missing_summary_index(chain, &state) else {
        return Err(mismatch());
    };
    let (finalized, _) = read_header(client, None)?;
    if finalized.state_root == state_root {
        return Err(mismatch());
    }
    let path = format!("/eth/v2/debug/beacon/states/{:#x}", finalized.state_root);
    let response = get(client, &path, "application/octet-stream")?;
    if response.status != 200 {
        return Err(Error::Beacon(format!(
            "GET {path}: status {}",
            response.status
        )));
    }
    let newest = StateView::parse(&response.body, chain)?;
    if newest.root() != finalized.state_root {
        return Err(mismatch());
    }
    let slot = state.slot();
    let repaired =
        complete_frozen_state(chain, state, &newest, state_root)?.ok_or_else(mismatch)?;
    log_repaired_state(slot, index, state_root);
    Ok(repaired)
}

fn from_bootstrap(
    client: &dyn HttpGet,
    state_clients: &[&dyn HttpGet],
    chain: ChainKind,
    header: &BeaconHeader,
    root: B256,
    answer: &HttpResponse,
) -> Result<CheckpointReport> {
    let data: Value = serde_json::from_slice(&answer.body)
        .map_err(|error| Error::Malformed(format!("bootstrap: {error}")))?;
    let bootstrap = bootstrap_from_json(&data["data"])?;
    if header_root(&bootstrap.header) != root {
        return Err(Error::Beacon(
            "the bootstrap header is not the header of the checkpoint".into(),
        ));
    }
    let current = bootstrap.verify_committee(chain)?;
    let next = match read_state(client, state_clients, chain, header)? {
        Some(state) => {
            if committee_hash(state.current_committee())? != current {
                return Err(Error::Beacon(
                    "the state and the bootstrap name different current committees".into(),
                ));
            }
            Some(committee_hash(state.next_committee())?)
        }
        None => None,
    };
    Ok(report(
        chain,
        CheckpointSource::Bootstrap,
        header,
        root,
        current,
        next,
    ))
}

fn report(
    chain: ChainKind,
    source: CheckpointSource,
    header: &BeaconHeader,
    root: B256,
    current: B256,
    next: Option<B256>,
) -> CheckpointReport {
    CheckpointReport {
        chain,
        source,
        initial_slot: header.slot,
        initial_header_root: root,
        initial_sync_committee_hash: current,
        initial_next_sync_committee_hash: next.unwrap_or(B256::ZERO),
        next_committee_known: next.is_some(),
        genesis_time: 0,
    }
}

/// Builds the checkpoint of `finalized_root`, or of the newest finalized header when it is `None`.
///
/// # Errors
/// `Error::Beacon` when the node lacks a route or its answers disagree. `Error::Malformed` for a wrong shape.
pub fn build_checkpoint(
    client: &dyn HttpGet,
    chain: ChainKind,
    finalized_root: Option<B256>,
) -> Result<CheckpointReport> {
    build_checkpoint_with_state_urls(client, &[], chain, finalized_root)
}

/// [`build_checkpoint`] with more beacon APIs for the state of the header (`source.state_urls`, `--state-url`). They are
/// asked in order when `client` does not serve the state or serves one with another root.
///
/// # Errors
/// As [`build_checkpoint`].
pub fn build_checkpoint_with_state_urls(
    client: &dyn HttpGet,
    state_clients: &[&dyn HttpGet],
    chain: ChainKind,
    finalized_root: Option<B256>,
) -> Result<CheckpointReport> {
    let genesis_time = read_genesis_time(client, chain)?;
    check_spec(client, chain)?;
    let (header, root) = read_header(client, finalized_root)?;
    state_layout_at(chain, header.slot)?;
    let path = format!("/eth/v1/beacon/light_client/bootstrap/{root:#x}");
    let answer = get(client, &path, "application/json")?;
    let mut checkpoint = match answer.status {
        200 => from_bootstrap(client, state_clients, chain, &header, root, &answer)?,
        status if bootstrap_unavailable(status) => {
            let state = read_state(client, state_clients, chain, &header)?.ok_or_else(|| {
                Error::Beacon(
                    "the node serves neither the light-client bootstrap nor the state of the header".into(),
                )
            })?;
            report(
                chain,
                CheckpointSource::DebugState,
                &header,
                root,
                committee_hash(state.current_committee())?,
                Some(committee_hash(state.next_committee())?),
            )
        }
        status => return Err(Error::Beacon(format!("GET {path}: status {status}"))),
    };
    checkpoint.genesis_time = genesis_time;
    Ok(checkpoint)
}
