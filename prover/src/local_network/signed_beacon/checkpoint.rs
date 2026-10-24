//! The checkpoint of a light client, read from a beacon API.
//!
//! A light client contract starts from a checkpoint: a finalized header and the hashes of the sync committees of its
//! period. The deploy step reads them from the beacon node of the tracked chain with this module. It uses the standard
//! endpoints only: the genesis, the finality update (its finalized header is the checkpoint) and the state of that header.

use crate::error::{Error, Result};
use crate::light_client::{committee_hash, header_root, update_from_json, ChainKind, StateView};
use crate::rpc::HttpGet;
use alloy_primitives::B256;
use serde_json::Value;

/// The values that a light client contract takes at deployment.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Checkpoint {
    /// The genesis time of the beacon chain.
    pub genesis_time: u64,
    /// The genesis validators root.
    pub genesis_validators_root: B256,
    /// The slot of the checkpoint header.
    pub slot: u64,
    /// The root of the checkpoint header.
    pub header_root: B256,
    /// The hash of the sync committee of the period of the header.
    pub committee_hash: B256,
    /// The hash of the sync committee of the next period.
    pub next_committee_hash: B256,
}

impl Checkpoint {
    /// One `name=value` line for each value, in the names of the deploy script.
    pub fn lines(&self) -> String {
        format!(
            "genesis_time={}\ngenesis_validators_root={:#x}\nslot={}\nheader_root={:#x}\ncommittee_hash={:#x}\nnext_committee_hash={:#x}\n",
            self.genesis_time,
            self.genesis_validators_root,
            self.slot,
            self.header_root,
            self.committee_hash,
            self.next_committee_hash,
        )
    }
}

fn json_of(client: &dyn HttpGet, path: &str) -> Result<Value> {
    let response = client.get(path, "application/json")?;
    if response.status != 200 {
        return Err(Error::Beacon(format!(
            "GET {path}: status {}",
            response.status
        )));
    }
    serde_json::from_slice(&response.body)
        .map_err(|error| Error::Malformed(format!("GET {path}: {error}")))
}

fn number_of(value: &Value, what: &str) -> Result<u64> {
    value
        .as_str()
        .and_then(|text| text.parse().ok())
        .ok_or_else(|| Error::Malformed(what.to_string()))
}

/// Reads the checkpoint at the newest finalized header of the node.
///
/// # Errors
/// `Error::Beacon` when the node lacks an endpoint or the state does not hash to the state root of the header.
/// `Error::Malformed` for an answer of the wrong shape.
pub fn read_checkpoint(client: &dyn HttpGet, chain: ChainKind) -> Result<Checkpoint> {
    let genesis = json_of(client, "/eth/v1/beacon/genesis")?;
    let root_text = genesis["data"]["genesis_validators_root"]
        .as_str()
        .ok_or_else(|| Error::Malformed("genesis_validators_root".into()))?;
    let genesis_validators_root: B256 = root_text
        .parse()
        .map_err(|_| Error::Malformed("genesis_validators_root".into()))?;
    if genesis_validators_root != chain.spec().genesis_validators_root {
        return Err(Error::Beacon(format!(
            "the node reports genesis validators root {genesis_validators_root:#x}, but the chain specification has {:#x}",
            chain.spec().genesis_validators_root
        )));
    }
    let update =
        update_from_json(&json_of(client, "/eth/v1/beacon/light_client/finality_update")?["data"])?;
    let header = update.finalized_header.beacon;
    let path = format!("/eth/v2/debug/beacon/states/{:#x}", header.state_root);
    let response = client.get(&path, "application/octet-stream")?;
    if response.status != 200 {
        return Err(Error::Beacon(format!(
            "GET {path}: status {}",
            response.status
        )));
    }
    let state = StateView::parse(&response.body, chain)?;
    if state.root() != header.state_root {
        return Err(Error::Beacon(format!(
            "the state of the checkpoint header hashes to {:#x}, not {:#x}",
            state.root(),
            header.state_root
        )));
    }
    Ok(Checkpoint {
        genesis_time: number_of(&genesis["data"]["genesis_time"], "genesis_time")?,
        genesis_validators_root,
        slot: header.slot,
        header_root: header_root(&header),
        committee_hash: committee_hash(state.current_committee())?,
        next_committee_hash: committee_hash(state.next_committee())?,
    })
}
