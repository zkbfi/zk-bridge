//! `HttpBeaconSource`: a standard beacon API.
//!
//! For a light-client update it uses `/eth/v1/beacon/light_client/finality_update` when the node serves it. When the
//! node answers 404 or 501 (the public PulseChain node does), it assembles the update from the block, state and
//! committee data that the node does serve:
//!
//! 1. the newest block `A` that has a child block (the child carries the sync aggregate that signs `A`);
//! 2. the state of `A` as SSZ (`/eth/v2/debug/beacon/states/<state root>`), hashed in full and compared with the
//!    state root of `A`: this gives the finality branch and the next committee with their branches;
//! 3. the finalized block that the state names, as SSZ.
//!
//! The store (the committee of the head period) comes from the `light_client/bootstrap` endpoint when served, and
//! from the state of the head otherwise. When the light client already holds a next committee, the store must carry
//! it (the contract compares the hash), so the store then comes from the state of the head.
//!
//! # Catching up
//!
//! One update moves the head across at most one sync committee period. A light client that lags by more periods needs
//! the committee handoff update of each period it passed. The source fetches them from
//! `/eth/v1/beacon/light_client/updates?start_period=&count=` (paged, because a node returns at most a count of its
//! own choice), puts the latest finality update last, and sends the whole list as one fold. The program takes at most
//! 64 updates in a fold. A longer catch-up goes in successive folds on successive runs, each one starting at the head
//! that the light client stored after the run before. A node that has no update
//! for a needed period (pruned history) gives an error that names the period.
//!
//! # Old messages
//!
//! The bridge picks the ancestry path from the distance between the anchor and the source slot. Up to 8192 slots it
//! takes `state.block_roots` of the anchor. Beyond that it takes `state.historical_summaries`, and this source builds
//! that branch with `lc-core`:
//!
//! 1. It rebuilds the 8192 block roots of the source era from the canonical block roots of the node
//!    (`/eth/v1/beacon/blocks/<slot>/root`, 404 for an empty slot). It never reads them from an old state: a node can
//!    serve an old state one summary short, and that state does not hash to its own root.
//! 2. It reads the anchor state, which the node must still serve whole. A node serves recent states only, so the
//!    anchor should be the newest head that the light client stores.
//! 3. `lc-core` checks the rebuilt roots against the `block_summary_root` of the anchor state.
//!
//! # Gloas
//!
//! A Gloas finalized header proves `state.latest_block_hash`, and the program reads the block number from the RLP of
//! that execution block. So after a fold is chosen, [`HttpBeaconSource::plan_update`] reads the state of each Gloas
//! finalized header (hashed in full and compared with the state root), asks an [`ExecutionHeaders`] source for the
//! raw header of `latest_block_hash`, and attaches both through `anchor_gloas_header`. Without an execution source the
//! run stops with an error that names `source.rpc_url`. A message proof from a Gloas source block is refused.
//!
//! Limits: the SSZ parser in `lc-core` reads states of the Capella, Deneb, Electra, Fulu and Gloas layouts. It picks the layout
//! from the fork that the chain schedule has at the slot of the state. The block parser reads the Capella block layout
//! only, so the assembled update path needs a Capella chain. Ethereum uses the light-client endpoints for the update.

use super::{HashEvidence, HistoricalEvidence, RootsEvidence, SourceBlock, StoredHead, UpdatePlan};
use crate::error::{Error, Result};
use crate::light_client::{
    ancestry_path, anchor_gloas_header, assemble_update, beacon_header_from_json,
    block_hash_gindex, block_roots_gindex, committee_hash, describe_header, era_block_roots,
    era_of, header_root, historical_summaries_gindex, store_at, store_from_bootstrap_json,
    sync_aggregate_from_json, update_from_json, AncestryPath, BeaconHeader, BeaconPath, BlockView,
    ChainKind, GloasBlockView, LightClientStore, LightClientUpdate, StateView, SyncAggregate,
    UpdateInput, SLOTS_PER_HISTORICAL_ROOT,
};
use crate::rpc::{HttpGet, JsonRpc};
use alloy_primitives::{hex, keccak256, B256};
use lc_core::chain::ForkName;
use lc_core::update::MAX_FOLD_UPDATES;
use serde_json::Value;
use std::collections::BTreeMap;
use std::ops::Range;
use std::sync::{Arc, Mutex};

const JSON: &str = "application/json";
const SSZ: &str = "application/octet-stream";
/// The number of slots that `state.block_roots` reaches back: the edge between the two ancestry paths.
const WINDOW_SLOTS: u64 = SLOTS_PER_HISTORICAL_ROOT;
/// How many requests for canonical block roots run at once.
const ROOT_FETCH_THREADS: usize = 8;
/// How far back the search for the last block before an era goes, when the first slots of the era are empty.
const MAX_EMPTY_SLOTS_BEFORE_ERA: u64 = 1_024;
/// How many parsed states stay in memory (each one is about 18 MB of bytes on PulseChain).
const STATE_CACHE_SIZE: usize = 2;
/// How many eras of block roots stay in memory (each one is 8192 roots, 256 KiB). The oldest era leaves first.
const ERA_CACHE_SIZE: usize = 64;
/// How many slots after the slot of a Gloas execution block the search for a block that names it goes.
const MAX_SLOTS_AFTER_PAYLOAD: u64 = 64;
/// How many empty slots the search for an attested block skips.
const MAX_EMPTY_SLOTS: u64 = 16;
/// The most periods that one request of `light_client/updates` asks for (`MAX_REQUEST_LIGHT_CLIENT_UPDATES`). A node
/// may answer with fewer.
const UPDATES_PER_REQUEST: u64 = 128;

/// Puts `value` first in a cache of at most `capacity` entries. The entry of the same key is replaced, and the entries
/// beyond the capacity, the oldest, are dropped.
fn insert_bounded<V>(cache: &mut Vec<(u64, V)>, key: u64, value: V, capacity: usize) {
    cache.retain(|(cached_key, _)| *cached_key != key);
    cache.insert(0, (key, value));
    cache.truncate(capacity);
}

/// GET and parse JSON. `None` when the node says 404 or 501 (the endpoint is not served or the object is unknown).
fn get_json_from(client: &dyn HttpGet, path: &str) -> Result<Option<Value>> {
    let response = client.get(path, JSON)?;
    match response.status {
        200 => serde_json::from_slice(&response.body)
            .map(Some)
            .map_err(|error| Error::Malformed(format!("GET {path}: {error}"))),
        404 | 501 => Ok(None),
        status => Err(Error::Beacon(format!("GET {path}: status {status}"))),
    }
}

/// Collects the items for the periods `first..end` from a source that answers a request for `count` periods from
/// `start` with the items it chooses to give. The source may give fewer than `count`, and it may skip a period.
///
/// Each request starts after the highest period received. A request that brings nothing new ends the search, so a
/// node that has pruned old periods does not cause a loop. The result holds the periods that arrived. The caller
/// finds the periods that did not.
fn page_through_periods<T>(
    first: u64,
    end: u64,
    mut request: impl FnMut(u64, u64) -> Result<Vec<(u64, T)>>,
) -> Result<BTreeMap<u64, T>> {
    let mut received = BTreeMap::new();
    let mut start = first;
    while start < end {
        let items = request(start, (end - start).min(UPDATES_PER_REQUEST))?;
        let highest = items
            .iter()
            .map(|(period, _)| *period)
            .filter(|period| (start..end).contains(period))
            .max();
        for (period, item) in items
            .into_iter()
            .filter(|(period, _)| (start..end).contains(period))
        {
            received.entry(period).or_insert(item);
        }
        let Some(highest) = highest else { break };
        start = highest + 1;
    }
    Ok(received)
}

/// The committee handoff updates of the periods `first_period..end_period`, by period, from
/// `/eth/v1/beacon/light_client/updates`. A period is the period of the attested header of the update.
///
/// The map lacks every period that the node did not give, and it is empty when the node does not serve the endpoint.
///
/// # Errors
/// `Error::Beacon` for a status other than 200, 404 and 501. `Error::Malformed` for a body that is not a list of updates.
pub fn fetch_period_updates(
    client: &dyn HttpGet,
    chain: ChainKind,
    first_period: u64,
    end_period: u64,
) -> Result<BTreeMap<u64, LightClientUpdate>> {
    page_through_periods(first_period, end_period, |start, count| {
        let path =
            format!("/eth/v1/beacon/light_client/updates?start_period={start}&count={count}");
        let Some(answer) = get_json_from(client, &path)? else {
            return Ok(Vec::new());
        };
        let entries = answer
            .as_array()
            .ok_or_else(|| Error::Malformed(format!("GET {path}: not a list")))?;
        entries
            .iter()
            .map(|entry| {
                let update = update_from_json(&entry["data"])?;
                Ok((
                    chain
                        .spec()
                        .period_at_slot(update.attested_header.beacon.slot),
                    update,
                ))
            })
            .collect()
    })
}

/// The first period of `first_period..end_period` that `received` lacks, or `None` when it holds them all.
pub fn first_missing_period<T>(
    received: &BTreeMap<u64, T>,
    first_period: u64,
    end_period: u64,
) -> Option<u64> {
    (first_period..end_period).find(|period| !received.contains_key(period))
}

/// The error for a period that the node has no update for. It names the period and what to do.
fn missing_period_error(period: u64, head_period: u64, latest_period: u64) -> Error {
    Error::Beacon(format!(
        "the beacon node has no light-client update for sync committee period {period}; the light client head is in period {head_period} and the catch-up to period {latest_period} needs every period in between; use a beacon node with a longer history of light-client updates"
    ))
}

/// The periods whose handoff updates a fold from `head_slot` needs: from the period of the head up to, and not
/// including, the period of the latest update. The range stops after 64 periods, the size of one fold.
pub fn handoff_periods(chain: ChainKind, head_slot: u64, latest: &LightClientUpdate) -> Range<u64> {
    let spec = chain.spec();
    let first = spec.period_at_slot(head_slot);
    let last = spec.period_at_slot(latest.finalized_header.beacon.slot);
    first..last.min(first + MAX_FOLD_UPDATES as u64).max(first)
}

/// The updates of one fold from the head at `head_slot`: the handoff update of each period, then the latest update when
/// the fold has room for it. An update that does not move the head forward is left out (the handoff of the head
/// period often finalizes the head itself).
///
/// # Errors
/// `Error::Beacon` naming the first period that `handoffs` lacks.
pub fn assemble_fold(
    chain: ChainKind,
    head_slot: u64,
    handoffs: &BTreeMap<u64, LightClientUpdate>,
    latest: LightClientUpdate,
) -> Result<Vec<LightClientUpdate>> {
    let periods = handoff_periods(chain, head_slot, &latest);
    let latest_period = chain
        .spec()
        .period_at_slot(latest.finalized_header.beacon.slot);
    if let Some(period) = first_missing_period(handoffs, periods.start, periods.end) {
        return Err(missing_period_error(period, periods.start, latest_period));
    }
    let room_for_latest = (periods.end - periods.start) < MAX_FOLD_UPDATES as u64;
    let candidates = periods
        .filter_map(|period| handoffs.get(&period).cloned())
        .chain(room_for_latest.then_some(latest));
    let mut head = head_slot;
    let mut fold = Vec::new();
    for update in candidates {
        let finalized = update.finalized_header.beacon.slot;
        if finalized <= head {
            continue;
        }
        head = finalized;
        fold.push(update);
    }
    Ok(fold)
}

/// Where the raw execution block headers come from (a Gloas finalized header needs one).
pub trait ExecutionHeaders: Send + Sync {
    /// The RLP of the execution block header with this hash. The caller checks that it hashes to `hash`.
    ///
    /// # Errors
    /// `Error::Rpc` or `Error::Http` when the node does not answer, `Error::Malformed` for a wrong shape.
    fn raw_header(&self, hash: B256) -> Result<Vec<u8>>;
}

/// Raw headers from an execution node with `debug_getRawHeader` (geth, erigon and reth serve it).
pub struct RpcExecutionHeaders {
    rpc: Box<dyn JsonRpc>,
}

impl RpcExecutionHeaders {
    /// Reads headers through `rpc`.
    pub fn new(rpc: Box<dyn JsonRpc>) -> Self {
        Self { rpc }
    }
}

impl ExecutionHeaders for RpcExecutionHeaders {
    fn raw_header(&self, hash: B256) -> Result<Vec<u8>> {
        let answer = self.rpc.call(
            "debug_getRawHeader",
            serde_json::json!([format!("{hash:#x}")]),
        )?;
        let text = answer.as_str().ok_or_else(|| {
            Error::Malformed("debug_getRawHeader: the result is not a string".into())
        })?;
        let bytes = hex::decode(text)
            .map_err(|error| Error::Malformed(format!("debug_getRawHeader: {error}")))?;
        if keccak256(&bytes) != hash {
            return Err(Error::Beacon(format!(
                "the execution node answered a header that does not hash to {hash:#x}"
            )));
        }
        Ok(bytes)
    }
}

/// A beacon node.
pub struct HttpBeaconSource {
    chain: ChainKind,
    client: Box<dyn HttpGet>,
    execution_headers: Option<Box<dyn ExecutionHeaders>>,
    genesis_time: Mutex<Option<u64>>,
    state_cache: Mutex<Vec<(B256, Arc<StateView>)>>,
    era_cache: Mutex<Vec<(u64, Arc<Vec<B256>>)>>,
}

impl HttpBeaconSource {
    /// A source over an HTTP client.
    pub fn new(chain: ChainKind, client: Box<dyn HttpGet>) -> Self {
        Self {
            chain,
            client,
            execution_headers: None,
            genesis_time: Mutex::new(None),
            state_cache: Mutex::new(Vec::new()),
            era_cache: Mutex::new(Vec::new()),
        }
    }

    /// The same source with an execution header source. A fold with a Gloas finalized header needs it.
    pub fn with_execution_headers(mut self, headers: Box<dyn ExecutionHeaders>) -> Self {
        self.execution_headers = Some(headers);
        self
    }

    /// Attaches the execution anchor to every Gloas finalized header of `updates` (see the module documentation, "Gloas").
    ///
    /// # Errors
    /// `Error::Config` when a header needs the anchor and the source has no execution source. The errors of
    /// `anchor_gloas_header` and of the reads.
    fn anchor_gloas_updates(&self, updates: &mut [LightClientUpdate]) -> Result<()> {
        for update in updates {
            let finalized = &update.finalized_header;
            if self.chain.spec().fork_at_slot(finalized.beacon.slot) < ForkName::Gloas {
                continue;
            }
            let headers = self.execution_headers.as_ref().ok_or_else(|| {
                Error::Config(
                    "a Gloas finalized header needs the execution header of state.latest_block_hash: set source.rpc_url (or --source-rpc-url)"
                        .into(),
                )
            })?;
            let state = self.state_for(finalized.beacon.state_root)?;
            let hash = state
                .latest_block_hash()
                .ok_or_else(|| Error::Beacon("the finalized state is not a Gloas state".into()))?;
            let rlp = headers.raw_header(hash)?;
            update.finalized_header =
                anchor_gloas_header(self.chain, &finalized.beacon, &state, rlp)?;
        }
        Ok(())
    }

    /// GET and parse JSON. `None` when the node says 404 or 501 (the endpoint is not served or the object is unknown).
    fn get_json(&self, path: &str) -> Result<Option<Value>> {
        get_json_from(self.client.as_ref(), path)
    }

    /// GET raw SSZ bytes. `None` for 404 and 501.
    fn get_ssz(&self, path: &str) -> Result<Option<Vec<u8>>> {
        let response = self.client.get(path, SSZ)?;
        match response.status {
            200 => Ok(Some(response.body)),
            404 | 501 => Ok(None),
            status => Err(Error::Beacon(format!("GET {path}: status {status}"))),
        }
    }

    fn require<T>(value: Option<T>, what: &str) -> Result<T> {
        value.ok_or_else(|| Error::Beacon(format!("the node does not have {what}")))
    }

    fn genesis_time(&self) -> Result<u64> {
        if let Some(cached) = *self.genesis_time.lock().expect("lock") {
            return Ok(cached);
        }
        let answer = Self::require(self.get_json("/eth/v1/beacon/genesis")?, "the genesis")?;
        let time: u64 = answer["data"]["genesis_time"]
            .as_str()
            .and_then(|text| text.parse().ok())
            .ok_or_else(|| Error::Malformed("genesis_time".into()))?;
        *self.genesis_time.lock().expect("lock") = Some(time);
        Ok(time)
    }

    /// The beacon slot of an execution timestamp. The payload timestamp is `genesis_time + slot * seconds_per_slot`.
    ///
    /// # Errors
    /// `Error::Beacon` when the timestamp is not on a slot boundary or lies before genesis.
    pub fn slot_for_timestamp(&self, timestamp: u64) -> Result<u64> {
        let genesis = self.genesis_time()?;
        let seconds = self.chain.seconds_per_slot();
        let elapsed = timestamp.checked_sub(genesis).ok_or_else(|| {
            Error::Beacon(format!(
                "timestamp {timestamp} is before the genesis time {genesis}"
            ))
        })?;
        if elapsed % seconds != 0 {
            return Err(Error::Beacon(format!(
                "timestamp {timestamp} is not on a slot boundary"
            )));
        }
        Ok(elapsed / seconds)
    }

    fn header_by_id(&self, id: &str) -> Result<Option<BeaconHeader>> {
        let Some(answer) = self.get_json(&format!("/eth/v1/beacon/headers/{id}"))? else {
            return Ok(None);
        };
        beacon_header_from_json(&answer["data"]["header"]["message"]).map(Some)
    }

    fn block_by_id(&self, id: &str) -> Result<Option<BlockView>> {
        self.get_ssz(&format!("/eth/v2/beacon/blocks/{id}"))?
            .map(|bytes| BlockView::parse_for_chain(&bytes, self.chain))
            .transpose()
    }

    /// The state with `state_root`, hashed in full and compared with the root. The two newest states stay cached.
    fn state_for(&self, state_root: B256) -> Result<Arc<StateView>> {
        if let Some((_, state)) = self
            .state_cache
            .lock()
            .expect("lock")
            .iter()
            .find(|(root, _)| *root == state_root)
        {
            return Ok(state.clone());
        }
        let bytes = Self::require(
            self.get_ssz(&format!("/eth/v2/debug/beacon/states/{state_root:#x}"))?,
            &format!("state {state_root:#x}"),
        )?;
        let state = Arc::new(StateView::parse(&bytes, self.chain)?);
        if state.root() != state_root {
            return Err(Error::Beacon(format!(
                "the state hashes to {:#x}, not {state_root:#x} (the node preset may differ from the mainnet preset)",
                state.root()
            )));
        }
        let mut cache = self.state_cache.lock().expect("lock");
        cache.insert(0, (state_root, state.clone()));
        cache.truncate(STATE_CACHE_SIZE);
        Ok(state)
    }

    /// The canonical block root of a slot, or `None` for an empty slot.
    fn canonical_root(&self, slot: u64) -> Result<Option<B256>> {
        let Some(answer) = self.get_json(&format!("/eth/v1/beacon/blocks/{slot}/root"))? else {
            return Ok(None);
        };
        answer["data"]["root"]
            .as_str()
            .and_then(|text| text.parse().ok())
            .map(Some)
            .ok_or_else(|| Error::Malformed(format!("block root of slot {slot}")))
    }

    /// The canonical block roots of the given slots, fetched by several threads. Order follows `slots`.
    fn canonical_roots(&self, slots: &[u64]) -> Result<Vec<Option<B256>>> {
        let chunk = slots.len().div_ceil(ROOT_FETCH_THREADS).max(1);
        std::thread::scope(|scope| {
            let workers: Vec<_> = slots
                .chunks(chunk)
                .map(|part| {
                    scope.spawn(move || {
                        part.iter()
                            .map(|slot| self.canonical_root(*slot))
                            .collect::<Result<Vec<_>>>()
                    })
                })
                .collect();
            let mut roots = Vec::with_capacity(slots.len());
            for worker in workers {
                roots.extend(
                    worker
                        .join()
                        .map_err(|_| Error::Beacon("a root fetch thread panicked".into()))??,
                );
            }
            Ok(roots)
        })
    }

    /// The 8192 block roots of an era, rebuilt from the canonical block roots of the node, verified, and cached.
    ///
    /// An empty slot repeats the root of the block before it (`process_slot` stores the root of the latest block
    /// header). When the first slot of the era is empty, the search for the last block before the era goes back.
    ///
    /// The roots enter the cache only after they hash to `historical_summaries[era - capella_era].block_summary_root`
    /// of `anchor` (checked by `lc-core`). A wrong answer from the node returns an error and leaves the cache as it was.
    fn era_roots(&self, era: u64, anchor: &StateView) -> Result<Arc<Vec<B256>>> {
        if let Some((_, cached)) = self
            .era_cache
            .lock()
            .expect("lock")
            .iter()
            .find(|(cached_era, _)| *cached_era == era)
        {
            return Ok(cached.clone());
        }
        let start = era * SLOTS_PER_HISTORICAL_ROOT;
        let slots: Vec<u64> = (start..start + SLOTS_PER_HISTORICAL_ROOT).collect();
        let mut canonical: BTreeMap<u64, B256> = slots
            .iter()
            .copied()
            .zip(self.canonical_roots(&slots)?)
            .filter_map(|(slot, root)| Some((slot, root?)))
            .collect();
        if !canonical.contains_key(&start) {
            for slot in (start.saturating_sub(MAX_EMPTY_SLOTS_BEFORE_ERA)..start).rev() {
                if let Some(root) = self.canonical_root(slot)? {
                    canonical.insert(slot, root);
                    break;
                }
            }
        }
        let roots = Arc::new(era_block_roots(era, &canonical)?);
        // Verification builds a throwaway branch for the first slot of the era. It fails with the `lc-core` mismatch
        // when the roots do not hash to the summary of the anchor, and nothing has been cached yet.
        anchor.historical_ancestry_branch(self.chain, era * SLOTS_PER_HISTORICAL_ROOT, &roots)?;
        insert_bounded(
            &mut self.era_cache.lock().expect("lock"),
            era,
            roots.clone(),
            ERA_CACHE_SIZE,
        );
        Ok(roots)
    }

    /// The ancestry branch for a source header under the anchor, on the path that the bridge takes for the two slots.
    fn ancestry_branch_for(
        &self,
        anchor: &BeaconHeader,
        source_slot: u64,
        source_root: B256,
    ) -> Result<Vec<B256>> {
        let state = self.state_for(anchor.state_root)?;
        match ancestry_path(anchor.slot, source_slot)? {
            AncestryPath::Recent => {
                if state.block_root_at(source_slot) != source_root {
                    return Err(Error::Beacon(
                        "the anchor state does not hold the source header in block_roots".into(),
                    ));
                }
                Ok(state.recent_ancestry_branch(source_slot))
            }
            AncestryPath::Historical => {
                let roots = self.era_roots(era_of(source_slot), &state)?;
                if roots[(source_slot % SLOTS_PER_HISTORICAL_ROOT) as usize] != source_root {
                    return Err(Error::Beacon(format!(
                        "the canonical block roots of era {} do not name the source header at slot {source_slot}",
                        era_of(source_slot)
                    )));
                }
                state.historical_ancestry_branch(self.chain, source_slot, &roots)
            }
        }
    }

    fn head_header(&self, head: &StoredHead) -> Result<BeaconHeader> {
        let header = Self::require(
            self.header_by_id(&head.slot.to_string())?,
            &format!("a header at the light client head slot {}", head.slot),
        )?;
        if header_root(&header) != head.root {
            return Err(Error::Beacon(format!(
                "the light client head ({}) is not on this beacon chain",
                describe_header(&header)
            )));
        }
        Ok(header)
    }

    /// The store at the light client head. The contract compares the next committee of the store with its own, so the
    /// store carries the next committee exactly when the light client holds one (`next_committee_hash` is not zero).
    ///
    /// Without a next committee the bootstrap endpoint comes first and the state of the head second. With one, the state
    /// of the head gives it (the bootstrap holds the current committee only), and its hash must equal the stored hash.
    fn store_at_head(
        &self,
        head: &BeaconHeader,
        next_committee_hash: B256,
    ) -> Result<LightClientStore> {
        if next_committee_hash == B256::ZERO {
            return self.store_without_next_committee(head);
        }
        let state = self.state_for(head.state_root)?;
        let store = store_at(head, &state, true);
        let held = store
            .next_sync_committee
            .as_ref()
            .map(committee_hash)
            .transpose()?;
        if held != Some(next_committee_hash) {
            return Err(Error::Beacon(format!(
                "the next committee in the state of the light client head ({}) does not match the stored hash {next_committee_hash:#x}",
                describe_header(head)
            )));
        }
        Ok(store)
    }

    /// The store at the head with no next committee: the bootstrap endpoint first, the state of the head second.
    fn store_without_next_committee(&self, head: &BeaconHeader) -> Result<LightClientStore> {
        let root = header_root(head);
        if let Some(answer) =
            self.get_json(&format!("/eth/v1/beacon/light_client/bootstrap/{root:#x}"))?
        {
            return store_from_bootstrap_json(&answer["data"]);
        }
        let state = self.state_for(head.state_root)?;
        Ok(store_at(head, &state, false))
    }

    /// The update from the light-client endpoint, or `None` when the node does not serve it.
    fn served_update(&self) -> Result<Option<LightClientUpdate>> {
        let Some(answer) = self.get_json("/eth/v1/beacon/light_client/finality_update")? else {
            return Ok(None);
        };
        update_from_json(&answer["data"]).map(Some)
    }

    /// The newest finality update: the served one, or else the one assembled from block and state data.
    fn latest_update(&self) -> Result<LightClientUpdate> {
        match self.served_update()? {
            Some(update) => Ok(update),
            None => self.assembled_update(),
        }
    }

    /// The fold that moves the light client from `head` as far toward `latest` as one proof can: the handoff updates of
    /// the periods in between, then `latest` (see the module documentation, "Catching up").
    fn catch_up(
        &self,
        head: &BeaconHeader,
        next_committee_hash: B256,
        latest: LightClientUpdate,
    ) -> Result<UpdateInput> {
        let periods = handoff_periods(self.chain, head.slot, &latest);
        let handoffs =
            fetch_period_updates(self.client.as_ref(), self.chain, periods.start, periods.end)?;
        let updates = assemble_fold(self.chain, head.slot, &handoffs, latest)?;
        let store = self.store_at_head(head, next_committee_hash)?;
        Ok(UpdateInput {
            chain: self.chain,
            store,
            updates,
        })
    }

    /// The update assembled from block and state data (the path for nodes without light-client endpoints).
    fn assembled_update(&self) -> Result<LightClientUpdate> {
        let head = Self::require(self.header_by_id("head")?, "a head header")?;
        let mut slot = head.slot.saturating_sub(1);
        for _ in 0..MAX_EMPTY_SLOTS {
            let Some(attested) = self.block_by_id(&slot.to_string())? else {
                slot = slot.saturating_sub(1);
                continue;
            };
            let Some((child_slot, aggregate)) = self.child_aggregate(&attested, slot, head.slot)?
            else {
                slot = slot.saturating_sub(1);
                continue;
            };
            let state = self.state_for(attested.header.state_root)?;
            let (_, finalized_root) = state.finalized_checkpoint();
            let finalized = Self::require(
                self.block_by_id(&format!("{finalized_root:#x}"))?,
                &format!("the finalized block {finalized_root:#x}"),
            )?;
            if header_root(&finalized.header) != finalized_root {
                return Err(Error::Beacon(
                    "the finalized block does not hash to the checkpoint root".into(),
                ));
            }
            return Ok(assemble_update(
                &attested, &state, &finalized, aggregate, child_slot,
            ));
        }
        Err(Error::Beacon(format!(
            "no block with a child found within {MAX_EMPTY_SLOTS} slots of the head"
        )))
    }

    /// The first block after `attested` and its sync aggregate. The child's parent root must be the attested root.
    fn child_aggregate(
        &self,
        attested: &BlockView,
        attested_slot: u64,
        head_slot: u64,
    ) -> Result<Option<(u64, SyncAggregate)>> {
        let attested_root = header_root(&attested.header);
        for slot in attested_slot + 1..=head_slot {
            let Some(answer) = self.get_json(&format!("/eth/v2/beacon/blocks/{slot}"))? else {
                continue;
            };
            let message = &answer["data"]["message"];
            let parent: B256 = message["parent_root"]
                .as_str()
                .and_then(|text| text.parse().ok())
                .ok_or_else(|| Error::Malformed("child parent_root".into()))?;
            if parent != attested_root {
                return Ok(None);
            }
            let aggregate = sync_aggregate_from_json(&message["body"]["sync_aggregate"])?;
            return Ok(Some((slot, aggregate)));
        }
        Ok(None)
    }
}

impl HttpBeaconSource {
    /// The chain whose beacon API this source reads.
    pub fn chain_kind(&self) -> ChainKind {
        self.chain
    }

    /// The fold that moves a light client from `head` to the newest final header of the beacon node, or `None` when the
    /// head already is that header.
    ///
    /// One fold holds up to 64 updates. A head that lags by more periods gets a fold that ends below the newest header,
    /// and the caller asks again from the new head.
    ///
    /// # Errors
    /// `Error::Beacon` when the node lacks data for the head, for a period in between, or when the head is not on this
    /// beacon chain.
    pub fn plan_update(&self, head: &StoredHead) -> Result<Option<UpdatePlan>> {
        let header = self.head_header(head)?;
        let latest = self.latest_update()?;
        let latest_finalized_slot = latest.finalized_header.beacon.slot;
        if latest_finalized_slot <= header.slot {
            return Ok(None);
        }
        let mut input = self.catch_up(&header, head.next_committee_hash, latest)?;
        self.anchor_gloas_updates(&mut input.updates)?;
        Ok(Some(UpdatePlan {
            input,
            latest_finalized_slot,
        }))
    }

    /// The beacon part of the message proof for a source block, anchored at a header that the light client stores.
    ///
    /// # Errors
    /// `Error::Beacon` when the anchor is not on this beacon chain, the source slot is not before the anchor, or the
    /// node lacks a block or a state.
    pub fn message_path(&self, source: &SourceBlock, anchor: &StoredHead) -> Result<BeaconPath> {
        let source_slot = self.slot_for_timestamp(source.timestamp)?;
        let anchor = self.head_header(anchor)?;
        if self.chain.spec().fork_at_slot(source_slot) >= ForkName::Gloas {
            return self.gloas_message_path(source, source_slot, anchor);
        }
        if source_slot >= anchor.slot {
            return Err(Error::Beacon(format!(
                "source slot {source_slot} is not before the anchor slot {}",
                anchor.slot
            )));
        }
        let block = Self::require(
            self.block_by_id(&source_slot.to_string())?,
            &format!("the block at slot {source_slot}"),
        )?;
        if block.payload.block_hash != source.hash {
            return Err(Error::Beacon(format!(
                "the beacon block at slot {source_slot} carries execution block {:#x}, not {:#x}",
                block.payload.block_hash, source.hash
            )));
        }
        let ancestry_branch =
            self.ancestry_branch_for(&anchor, source_slot, header_root(&block.header))?;
        Ok(BeaconPath {
            anchor_header: anchor,
            source_header: block.header,
            ancestry_branch,
            block_hash_branch: block.block_hash_branch,
        })
    }

    /// Whether the execution block with this timestamp belongs to a beacon slot at or after the Gloas fork. Such a block is
    /// proven through the bid of a later beacon block, and its header is read raw.
    ///
    /// # Errors
    /// `Error::Beacon` when the timestamp is not on a slot boundary or lies before genesis.
    pub fn is_gloas_source(&self, timestamp: u64) -> Result<bool> {
        let slot = self.slot_for_timestamp(timestamp)?;
        Ok(self.chain.spec().fork_at_slot(slot) >= ForkName::Gloas)
    }

    /// The beacon part of a message proof for an execution block X of a Gloas chain.
    ///
    /// The proof needs a beacon block B that comes after the block of X, is an ancestor of the anchor, and whose bid names X
    /// as `parent_block_hash` (index 2856). The block of X needs no slot in the proof. So the source scans the canonical blocks
    /// after the slot of X for the first one whose bid names X. The bid `block_hash` of the block of X itself is never used.
    ///
    /// # Errors
    /// `Error::Beacon` when no block within [`MAX_SLOTS_AFTER_PAYLOAD`] slots names X, when B is not before the anchor, or when
    /// the node lacks a block or a state.
    fn gloas_message_path(
        &self,
        source: &SourceBlock,
        source_slot: u64,
        anchor: BeaconHeader,
    ) -> Result<BeaconPath> {
        let last = anchor
            .slot
            .saturating_sub(1)
            .min(source_slot + MAX_SLOTS_AFTER_PAYLOAD);
        for slot in source_slot + 1..=last {
            let Some(bytes) = self.get_ssz(&format!("/eth/v2/beacon/blocks/{slot}"))? else {
                continue;
            };
            let block = GloasBlockView::parse(&bytes)?;
            if block.bid_parent_block_hash() != source.hash {
                continue;
            }
            let header = block.header();
            let ancestry_branch =
                self.ancestry_branch_for(&anchor, header.slot, header_root(&header))?;
            return Ok(BeaconPath {
                anchor_header: anchor,
                source_header: header,
                ancestry_branch,
                block_hash_branch: block.bid_parent_block_hash_branch(),
            });
        }
        Err(Error::Beacon(format!(
            "no canonical block between slot {} and slot {last} has a bid that names the execution block {:#x} as its parent_block_hash; the anchor at slot {} may be too early, or the payload was never confirmed",
            source_slot + 1,
            source.hash,
            anchor.slot
        )))
    }

    /// Evidence for a `block_roots` layout row that covers `anchor`, or `None` when the stored headers do not yet allow it.
    ///
    /// # Errors
    /// `Error::Beacon` when the node lacks the state of the anchor.
    pub fn roots_layout_evidence(
        &self,
        anchor: &BeaconHeader,
        stored_slots: &[u64],
    ) -> Result<Option<RootsEvidence>> {
        let mut earlier: Vec<u64> = stored_slots
            .iter()
            .copied()
            .filter(|slot| *slot < anchor.slot && anchor.slot - *slot <= WINDOW_SLOTS)
            .collect();
        earlier.sort_unstable();
        earlier.dedup();
        let [.., slot_a, slot_b] = earlier[..] else {
            return Ok(None);
        };
        let state = self.state_for(anchor.state_root)?;
        Ok(Some(RootsEvidence {
            gindex: block_roots_gindex(self.chain, anchor.slot)?,
            later_header: *anchor,
            earlier_slot_a: slot_a,
            earlier_slot_b: slot_b,
            branch_a: state.recent_ancestry_branch(slot_a),
            branch_b: state.recent_ancestry_branch(slot_b),
        }))
    }

    /// Evidence for a `historical_summaries` layout row that covers `anchor`, or `None` when the stored headers do not
    /// yet allow it (no stored slot lies in a completed era more than 8192 slots below the anchor).
    ///
    /// # Errors
    /// `Error::Beacon` when the node lacks the state of the anchor or the block roots of the era.
    pub fn historical_layout_evidence(
        &self,
        anchor: &BeaconHeader,
        stored_slots: &[u64],
    ) -> Result<Option<HistoricalEvidence>> {
        let capella_era = self
            .chain
            .spec()
            .capella_era()
            .map_err(|error| Error::Beacon(error.to_string()))?;
        // The nearest stored slot in a completed era that lies more than 8192 slots below the anchor.
        let candidate = stored_slots
            .iter()
            .copied()
            .filter(|slot| *slot < anchor.slot && anchor.slot - *slot > WINDOW_SLOTS)
            .filter(|slot| {
                era_of(*slot) >= capella_era
                    && (era_of(*slot) + 1) * SLOTS_PER_HISTORICAL_ROOT <= anchor.slot
            })
            .max();
        let Some(earlier_slot) = candidate else {
            return Ok(None);
        };
        let state = self.state_for(anchor.state_root)?;
        let roots = self.era_roots(era_of(earlier_slot), &state)?;
        Ok(Some(HistoricalEvidence {
            gindex: historical_summaries_gindex(self.chain, anchor.slot)?,
            anchor_header: *anchor,
            earlier_slot,
            branch: state.historical_ancestry_branch(self.chain, earlier_slot, &roots)?,
        }))
    }

    /// Evidence for a block hash layout row from the stored header with the highest slot at or below `at_or_below`, or
    /// `None` when no stored header qualifies.
    ///
    /// # Errors
    /// `Error::Beacon` when the node lacks the block of that header.
    pub fn hash_layout_evidence(
        &self,
        at_or_below: u64,
        stored_slots: &[u64],
    ) -> Result<Option<HashEvidence>> {
        let Some(slot) = stored_slots
            .iter()
            .copied()
            .filter(|slot| *slot <= at_or_below)
            .max()
        else {
            return Ok(None);
        };
        let block = Self::require(
            self.block_by_id(&slot.to_string())?,
            &format!("the block at slot {slot}"),
        )?;
        Ok(Some(HashEvidence {
            gindex: block_hash_gindex(self.chain, slot)?,
            header: block.header,
            branch: block.block_hash_branch,
        }))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::beacon::SourceBlock;
    use crate::light_client::verify_update_natively;
    use crate::prover::ProofStatement;
    use crate::rpc::HttpResponse;
    use std::collections::HashMap;
    use std::path::{Path, PathBuf};

    /// An in-memory beacon node: a map from path to body. An unknown path answers 404.
    struct Node(HashMap<String, Vec<u8>>);

    impl HttpGet for Node {
        fn get(&self, path_and_query: &str, _accept: &str) -> Result<HttpResponse> {
            Ok(match self.0.get(path_and_query) {
                Some(body) => HttpResponse {
                    status: 200,
                    body: body.clone(),
                },
                None => HttpResponse {
                    status: 404,
                    body: b"{}".to_vec(),
                },
            })
        }
    }

    fn light_client_fixtures() -> PathBuf {
        Path::new(env!("CARGO_MANIFEST_DIR")).join("../light-client/tests/fixtures/pulsechain")
    }

    fn pulsechain_source(pages: Vec<(String, Vec<u8>)>) -> HttpBeaconSource {
        HttpBeaconSource::new(
            ChainKind::Pulsechain,
            Box::new(Node(pages.into_iter().collect())),
        )
    }

    /// Serves the raw header of one hash and refuses every other.
    struct OneHeader {
        hash: B256,
        rlp: Vec<u8>,
    }

    impl ExecutionHeaders for OneHeader {
        fn raw_header(&self, hash: B256) -> Result<Vec<u8>> {
            assert_eq!(
                hash, self.hash,
                "the source asked for the header of state.latest_block_hash"
            );
            Ok(self.rlp.clone())
        }
    }

    fn sepolia_fixtures() -> PathBuf {
        Path::new(env!("CARGO_MANIFEST_DIR")).join("../light-client/tests/fixtures/sepolia")
    }

    /// A Sepolia source over REAL Gloas data: the finality update of a Sepolia node, its finalized state, and the raw
    /// execution header of `state.latest_block_hash`. The head of the light client is a header that shares the real state
    /// root and lies 1000 slots earlier, so the store (the current committee) comes from the real state. Returns the
    /// source, the head, and the hash of the execution header.
    fn real_gloas_source(with_headers: bool) -> (HttpBeaconSource, StoredHead, B256) {
        let update: serde_json::Value = serde_json::from_slice(
            &std::fs::read(sepolia_fixtures().join("gloas_head_finality_update.json")).unwrap(),
        )
        .unwrap();
        let wrapper: serde_json::Value = serde_json::from_slice(
            &std::fs::read(sepolia_fixtures().join("gloas_head_execution_header.json")).unwrap(),
        )
        .unwrap();
        let state = std::fs::read(sepolia_fixtures().join("gloas_head_state.ssz")).unwrap();
        let rlp = hex::decode(wrapper["raw_header"].as_str().unwrap()).unwrap();
        let finalized = &update["response"]["data"]["finalized_header"]["beacon"];
        let mut head = finalized.clone();
        let head_slot = finalized["slot"].as_str().unwrap().parse::<u64>().unwrap() - 1_000;
        head["slot"] = serde_json::json!(head_slot.to_string());
        let head_root = header_root(&beacon_header_from_json(&head).unwrap());
        let state_root = finalized["state_root"].as_str().unwrap().to_string();
        let pages: HashMap<String, Vec<u8>> = HashMap::from([
            (
                format!("/eth/v1/beacon/headers/{head_slot}"),
                serde_json::json!({"data": {"header": {"message": head}}})
                    .to_string()
                    .into_bytes(),
            ),
            (
                "/eth/v1/beacon/light_client/finality_update".to_string(),
                update["response"].to_string().into_bytes(),
            ),
            (format!("/eth/v2/debug/beacon/states/{state_root}"), state),
        ]);
        let hash = lc_core::execution::execution_block_hash(&rlp);
        let mut source = HttpBeaconSource::new(ChainKind::Sepolia, Box::new(Node(pages)));
        if with_headers {
            source = source.with_execution_headers(Box::new(OneHeader { hash, rlp }));
        }
        let stored = StoredHead {
            slot: head_slot,
            root: head_root,
            next_committee_hash: B256::ZERO,
        };
        (source, stored, hash)
    }

    /// Claim: the plan for a REAL Sepolia Gloas head carries a finalized header anchored in its real state, with the real
    /// execution header RLP. The program accepts the plan natively (real BLS signature) and reports the block that
    /// `state.latest_block_hash` names, with its number from the RLP. Why it matters: this is what the prover sends to the
    /// guest on Sepolia.
    #[test]
    fn a_gloas_plan_anchors_the_finalized_header_in_the_real_state() {
        let (source, stored, hash) = real_gloas_source(true);
        let plan = source.plan_update(&stored).unwrap().expect("a plan");
        let finalized = &plan.input.updates[0].finalized_header;
        assert_eq!(finalized.execution_block_hash(), hash);
        assert_eq!(finalized.execution_branch.len(), 11);
        assert!(!finalized.execution_header_rlp.is_empty());
        let output = verify_update_natively(&plan.input).expect("the real Gloas fold verifies");
        assert_eq!(output.executionBlockHash, hash);
        assert_ne!(output.executionBlockNumber, 0);
    }

    /// Claim: without an execution source the plan for a Gloas head stops with a clear configuration error that names
    /// `source.rpc_url`, and builds no update. Why it matters: the program needs the RLP, and an update without it
    /// would be refused later at the cost of a proof run.
    #[test]
    fn a_gloas_plan_without_an_execution_source_names_the_missing_setting() {
        let (source, stored, _) = real_gloas_source(false);
        let Err(error) = source.plan_update(&stored) else {
            panic!("the plan must fail");
        };
        assert!(
            matches!(&error, Error::Config(text) if text.contains("source.rpc_url")),
            "{error}"
        );
    }

    /// Claim: an execution node that answers the header of another block is refused, so a node cannot choose the block
    /// number. The header must hash to `state.latest_block_hash`.
    #[test]
    fn a_wrong_execution_header_is_refused_before_a_proof_run() {
        let (source, stored, hash) = real_gloas_source(false);
        let wrapper: serde_json::Value = serde_json::from_slice(
            &std::fs::read(sepolia_fixtures().join("gloas_head_execution_header.json")).unwrap(),
        )
        .unwrap();
        let parent = hex::decode(wrapper["parent_raw_header"].as_str().unwrap()).unwrap();
        let source = source.with_execution_headers(Box::new(OneHeader { hash, rlp: parent }));
        let Err(error) = source.plan_update(&stored) else {
            panic!("the plan must fail");
        };
        assert!(
            error.to_string().contains("state.latest_block_hash"),
            "{error}"
        );
    }

    /// Claim: the RPC header source refuses an answer that does not hash to the requested hash, and reads the raw header
    /// from `debug_getRawHeader`.
    #[test]
    fn the_rpc_header_source_checks_the_hash() {
        struct Fixed(String);
        impl JsonRpc for Fixed {
            fn call(&self, method: &str, _params: serde_json::Value) -> Result<serde_json::Value> {
                assert_eq!(method, "debug_getRawHeader");
                Ok(serde_json::json!(self.0))
            }
        }
        let wrapper: serde_json::Value = serde_json::from_slice(
            &std::fs::read(sepolia_fixtures().join("gloas_head_execution_header.json")).unwrap(),
        )
        .unwrap();
        let raw = wrapper["raw_header"].as_str().unwrap().to_string();
        let bytes = hex::decode(&raw).unwrap();
        let hash = keccak256(&bytes);
        let good = RpcExecutionHeaders::new(Box::new(Fixed(raw)));
        assert_eq!(good.raw_header(hash).unwrap(), bytes);
        assert!(good.raw_header(B256::repeat_byte(1)).is_err());
        let not_text = RpcExecutionHeaders::new(Box::new(Fixed2));
        assert!(not_text.raw_header(hash).is_err());
    }

    struct Fixed2;
    impl JsonRpc for Fixed2 {
        fn call(&self, _method: &str, _params: serde_json::Value) -> Result<serde_json::Value> {
            Ok(serde_json::json!(7))
        }
    }

    /// The real Sepolia world of a Gloas message source: the execution block X of the fixtures (slot 11441215), the real
    /// beacon block B after it (slot 11441216) whose bid names X, and a real later anchor with its state. `skipped` blocks
    /// that name another execution block stand before B.
    fn real_gloas_message_world(
        skipped: usize,
    ) -> (
        HttpBeaconSource,
        SourceBlock,
        StoredHead,
        Vec<serde_json::Value>,
    ) {
        let read = |name: &str| std::fs::read(sepolia_fixtures().join(name)).unwrap();
        let json =
            |name: &str| -> serde_json::Value { serde_json::from_slice(&read(name)).unwrap() };
        let source_fixture = json("gloas_message_source.json");
        let block_fixture = json("gloas_message_block.json");
        let head_fixture = json("gloas_head_execution_header.json");
        let anchor = beacon_header_from_json(&source_fixture["response"]["anchor_header"]).unwrap();
        let hash = keccak256(hex::decode(head_fixture["raw_header"].as_str().unwrap()).unwrap());
        let timestamp = block_fixture["response"]["timestamp"].as_u64().unwrap();
        let x_slot = (timestamp - 1_655_733_600) / 12;
        let mut pages: HashMap<String, Vec<u8>> = HashMap::from([
            ("/eth/v1/beacon/genesis".to_string(), br#"{"data":{"genesis_time":"1655733600"}}"#.to_vec()),
            (
                format!("/eth/v1/beacon/headers/{}", anchor.slot),
                serde_json::json!({"data": {"header": {"message": source_fixture["response"]["anchor_header"]}}})
                    .to_string()
                    .into_bytes(),
            ),
            (format!("/eth/v2/debug/beacon/states/{:#x}", anchor.state_root), read("gloas_anchor_state.ssz")),
        ]);
        for offset in 1..=skipped as u64 {
            pages.insert(
                format!("/eth/v2/beacon/blocks/{}", x_slot + offset),
                read("gloas_busy_block.ssz"),
            );
        }
        pages.insert(
            format!("/eth/v2/beacon/blocks/{}", x_slot + 1 + skipped as u64),
            read("gloas_head_block.ssz"),
        );
        let source = HttpBeaconSource::new(ChainKind::Sepolia, Box::new(Node(pages)));
        let number = block_fixture["response"]["block_number"].as_u64().unwrap();
        let stored = StoredHead {
            slot: anchor.slot,
            root: header_root(&anchor),
            next_committee_hash: B256::ZERO,
        };
        let receipts = block_fixture["response"]["receipts"]
            .as_array()
            .unwrap()
            .clone();
        (
            source,
            SourceBlock {
                number,
                hash,
                timestamp,
            },
            stored,
            receipts,
        )
    }

    fn real_gloas_evidence(
        path: &BeaconPath,
        receipts: &[serde_json::Value],
    ) -> lc_core::abi::MessageProof {
        let block_fixture: serde_json::Value = serde_json::from_slice(
            &std::fs::read(sepolia_fixtures().join("gloas_message_block.json")).unwrap(),
        )
        .unwrap();
        let head_fixture: serde_json::Value = serde_json::from_slice(
            &std::fs::read(sepolia_fixtures().join("gloas_head_execution_header.json")).unwrap(),
        )
        .unwrap();
        let transactions: Vec<alloy_primitives::Bytes> = block_fixture["response"]
            ["raw_transactions"]
            .as_array()
            .unwrap()
            .iter()
            .map(|raw| hex::decode(raw.as_str().unwrap()).unwrap().into())
            .collect();
        let execution = crate::light_client::build_execution_evidence_from_raw_header(
            hex::decode(head_fixture["raw_header"].as_str().unwrap()).unwrap(),
            &serde_json::Value::Array(receipts.to_vec()),
            &transactions,
            2,
        )
        .unwrap();
        crate::light_client::assemble_message_proof(path, &execution, 2, 0)
    }

    /// Claim: for a Gloas execution block the source finds the first later canonical block whose bid names it, builds the
    /// 11 entry branch of the bid `parent_block_hash` (index 2856) and the ancestry to a real later anchor, and the evidence
    /// (with the raw header, the receipt proof and the transaction proof) passes the native bridge check up to the log. The log
    /// is a real transfer log and not a bridge message, so the check ends with `LogTopicMismatch`: every earlier rule passed on
    /// real data. A block that names another execution block is skipped. Controls: a flipped branch entry, the RLP of another
    /// block and a flipped ancestry entry each fail with their own rule, and a world without the block fails with a clear error.
    #[test]
    fn a_gloas_message_source_is_found_through_the_next_blocks_bid() {
        use crate::light_client::{verify_message_natively, BridgeContext};
        for skipped in [0, 2] {
            let (source, x, stored, receipts) = real_gloas_message_world(skipped);
            assert!(source.is_gloas_source(x.timestamp).unwrap());
            let path = source.message_path(&x, &stored).unwrap();
            assert_eq!(
                path.source_header.slot, 11_441_216,
                "the real block B, found after {skipped} skipped blocks"
            );
            assert_eq!(path.block_hash_branch.len(), 11);
            let proof = real_gloas_evidence(&path, &receipts);
            let emitter = receipts[2]["logs"][0]["address"]
                .as_str()
                .unwrap()
                .parse()
                .unwrap();
            let context = BridgeContext {
                remote_bridge: emitter,
                remote_chain_id: 11_155_111,
                local_chain_id: 943,
                stored_anchor_root: stored.root,
            };
            let reached_the_log = |proof: &lc_core::abi::MessageProof| {
                verify_message_natively(proof, &context, ChainKind::Sepolia)
                    .err()
                    .map(|error| error.to_string())
            };
            let text = reached_the_log(&proof).expect("the transfer log is not a bridge message");
            assert!(text.contains("LogTopicMismatch"), "{text}");

            let mut flipped = proof.clone();
            flipped.blockHashBranch[4].0[0] ^= 1;
            assert!(reached_the_log(&flipped)
                .unwrap()
                .contains("InvalidBlockHashBranch"));
            let mut other_block = proof.clone();
            other_block.executionHeaderRlp = hex::decode(
                serde_json::from_slice::<serde_json::Value>(
                    &std::fs::read(sepolia_fixtures().join("gloas_head_execution_header.json"))
                        .unwrap(),
                )
                .unwrap()["parent_raw_header"]
                    .as_str()
                    .unwrap(),
            )
            .unwrap()
            .into();
            assert!(reached_the_log(&other_block)
                .unwrap()
                .contains("InvalidBlockHashBranch"));
            let mut not_ancestor = proof.clone();
            not_ancestor.ancestryBranch[2].0[0] ^= 1;
            assert!(reached_the_log(&not_ancestor)
                .unwrap()
                .contains("InvalidAncestryBranch"));
        }
        let (source, mut x, stored, _) = real_gloas_message_world(0);
        x.hash = B256::repeat_byte(7);
        let Err(error) = source.message_path(&x, &stored) else {
            panic!("no block names this hash")
        };
        assert!(error.to_string().contains("parent_block_hash"), "{error}");
    }

    /// Claim: the slot of an execution timestamp is `(timestamp - genesis) / 10` on PulseChain, and a timestamp
    /// off the slot grid or before genesis is refused.
    /// Why it matters: the source slot picks the beacon block that holds the source block.
    #[test]
    fn slot_follows_from_the_timestamp() {
        let genesis = br#"{"data":{"genesis_time":"1000"}}"#.to_vec();
        let source = pulsechain_source(vec![("/eth/v1/beacon/genesis".into(), genesis)]);
        assert_eq!(source.slot_for_timestamp(1000).unwrap(), 0);
        assert_eq!(source.slot_for_timestamp(1000 + 10 * 77).unwrap(), 77);
        assert!(source.slot_for_timestamp(1005).is_err());
        assert!(source.slot_for_timestamp(999).is_err());
    }

    /// Claim: the source uses the light-client endpoint when the node serves it, parses a real PulseChain update
    /// from it, and reports "not served" on a 404, which sends it to the assembly path.
    /// Why it matters: PulseChain's public node answers 404 for these endpoints. Other nodes serve them.
    #[test]
    fn served_endpoint_is_used_and_404_means_not_served() {
        let path = light_client_fixtures().join("light_client_update.json");
        let wrapper: serde_json::Value =
            serde_json::from_slice(&std::fs::read(&path).unwrap()).unwrap();
        let body = serde_json::json!({ "data": wrapper["response"]["update"] })
            .to_string()
            .into_bytes();
        let served = pulsechain_source(vec![(
            "/eth/v1/beacon/light_client/finality_update".into(),
            body,
        )]);
        let update = served.served_update().unwrap().expect("served");
        assert!(update.finalized_header.beacon.slot > 0);
        let missing = pulsechain_source(vec![]);
        assert!(missing.served_update().unwrap().is_none());
    }

    /// Claim: with only block and state data (no light-client endpoints), the source assembles an update from
    /// real PulseChain data that `lc-core` accepts natively, against a store built from the same state.
    /// Why it matters: this is the only path that works on PulseChain's public node.
    /// The data is the raw input of the fixture derivation tool, kept by the light-client agent in
    /// `light-client/fetch-cache/pulsechain` (not tracked by git). The test skips when it is absent.
    #[test]
    fn assembled_update_from_real_pulsechain_data_verifies() {
        let directory =
            Path::new(env!("CARGO_MANIFEST_DIR")).join("../light-client/fetch-cache/pulsechain");
        let read = |name: &str| std::fs::read(directory.join(name));
        let (Ok(state), Ok(attested), Ok(finalized), Ok(child), Ok(attested_header), Ok(previous)) = (
            read("attested_state.ssz"),
            read("attested_block.ssz"),
            read("finalized_block.ssz"),
            read("child_block.json"),
            read("attested_header.json"),
            read("previous_header.json"),
        ) else {
            eprintln!("SKIPPED: the real PulseChain input files are not in light-client/fetch-cache/pulsechain");
            return;
        };
        let header_json: serde_json::Value = serde_json::from_slice(&attested_header).unwrap();
        let message = &header_json["data"]["header"]["message"];
        let attested_slot: u64 = message["slot"].as_str().unwrap().parse().unwrap();
        let state_root = message["state_root"].as_str().unwrap().to_string();
        let mut head = header_json.clone();
        head["data"]["header"]["message"]["slot"] =
            serde_json::json!((attested_slot + 1).to_string());
        let checkpoints: serde_json::Value = serde_json::from_slice(
            &std::fs::read(directory.join("finality_checkpoints.json")).unwrap(),
        )
        .unwrap();
        let finalized_root = checkpoints["data"]["finalized"]["root"]
            .as_str()
            .unwrap()
            .to_string();

        let source = pulsechain_source(vec![
            (
                "/eth/v1/beacon/headers/head".into(),
                head.to_string().into_bytes(),
            ),
            (format!("/eth/v2/beacon/blocks/{attested_slot}"), attested),
            (
                format!("/eth/v2/beacon/blocks/{}", attested_slot + 1),
                child,
            ),
            (format!("/eth/v2/beacon/blocks/{finalized_root}"), finalized),
            (format!("/eth/v2/debug/beacon/states/{state_root}"), state),
        ]);
        let update = source.assembled_update().expect("assembled update");

        let previous_json: serde_json::Value = serde_json::from_slice(&previous).unwrap();
        let previous_header =
            beacon_header_from_json(&previous_json["data"]["header"]["message"]).unwrap();
        let state = source.state_for(state_root.parse().unwrap()).unwrap();
        let store = store_at(&previous_header, &state, false);
        let output = verify_update_natively(&UpdateInput {
            chain: ChainKind::Pulsechain,
            store,
            updates: vec![update],
        })
        .expect("the assembled update must verify natively");
        assert_eq!(output.previousHeadSlot, previous_header.slot);
        assert!(output.newHeadSlot > previous_header.slot);
    }

    // ---------------------------------------------------------------- old messages

    use crate::light_client::test_support::synthetic_state;
    use crate::light_client::ForkData;
    use alloy_primitives::keccak256;
    use lc_core::ancestry::{ancestry_leaf_gindex, historical_leaf_gindex};
    use lc_core::ssz::is_valid_exact_branch;
    use std::sync::atomic::{AtomicUsize, Ordering};

    /// The block roots a fake node serves, shared so a test can change them.
    type SharedAnswers = Arc<Mutex<HashMap<u64, B256>>>;

    /// A node that serves `/eth/v1/beacon/blocks/<slot>/root` for the slots of a map and counts the requests.
    struct RootNode {
        roots: SharedAnswers,
        requests: Arc<AtomicUsize>,
    }

    impl HttpGet for RootNode {
        fn get(&self, path_and_query: &str, _accept: &str) -> Result<crate::rpc::HttpResponse> {
            self.requests.fetch_add(1, Ordering::SeqCst);
            let slot: u64 = path_and_query
                .strip_prefix("/eth/v1/beacon/blocks/")
                .and_then(|rest| rest.strip_suffix("/root"))
                .and_then(|text| text.parse().ok())
                .expect("only block root requests");
            Ok(match self.roots.lock().unwrap().get(&slot) {
                Some(root) => crate::rpc::HttpResponse {
                    status: 200,
                    body: serde_json::json!({ "data": { "root": format!("{root:#x}") } })
                        .to_string()
                        .into_bytes(),
                },
                None => crate::rpc::HttpResponse {
                    status: 404,
                    body: b"{}".to_vec(),
                },
            })
        }
    }

    /// The canonical roots of eras 3 and 4 with empty slots, and the 8192 roots that `block_roots` holds for them.
    /// The first slot of era 3 and every seventh slot are empty. The block before era 3 sits three slots below it.
    fn chain_with_gaps() -> (HashMap<u64, B256>, Vec<Vec<B256>>) {
        let mut canonical = HashMap::new();
        let mut eras = Vec::new();
        let mut current = keccak256(b"block before era 3");
        canonical.insert(3 * 8192 - 3, current);
        for era in [3u64, 4] {
            let mut roots = Vec::new();
            for slot in era * 8192..(era + 1) * 8192 {
                if slot % 7 != 0 && slot != 3 * 8192 {
                    current = keccak256(format!("block/{slot}"));
                    canonical.insert(slot, current);
                }
                roots.push(current);
            }
            eras.push(roots);
        }
        (canonical, eras)
    }

    fn source_over(roots: HashMap<u64, B256>) -> (HttpBeaconSource, Arc<AtomicUsize>) {
        let (source, requests, _) = changeable_source_over(roots);
        (source, requests)
    }

    /// Like [`source_over`], and also returns the answers of the node, so a test can change them between calls.
    fn changeable_source_over(
        roots: HashMap<u64, B256>,
    ) -> (HttpBeaconSource, Arc<AtomicUsize>, SharedAnswers) {
        let requests = Arc::new(AtomicUsize::new(0));
        let answers = Arc::new(Mutex::new(roots));
        let node = RootNode {
            roots: answers.clone(),
            requests: requests.clone(),
        };
        (
            HttpBeaconSource::new(ChainKind::Pulsechain, Box::new(node)),
            requests,
            answers,
        )
    }

    fn fork() -> ForkData {
        ForkData {
            previous_version: [2, 0, 0, 0],
            current_version: [3, 0, 0, 0],
            epoch: 3,
        }
    }

    /// A source that holds a synthetic anchor state in its cache, so no state is fetched.
    fn primed(source: &HttpBeaconSource, anchor_slot: u64, eras: &[Vec<B256>]) -> BeaconHeader {
        let state = synthetic_state(anchor_slot, fork(), eras);
        let anchor = BeaconHeader {
            slot: anchor_slot,
            proposer_index: 1,
            parent_root: keccak256(b"anchor parent"),
            state_root: state.root(),
            body_root: keccak256(b"anchor body"),
        };
        source
            .state_cache
            .lock()
            .unwrap()
            .insert(0, (state.root(), Arc::new(state)));
        anchor
    }

    /// An anchor state whose summaries hold the eras 3 and 4 of `chain_with_gaps` (after three filler eras).
    fn anchored(source: &HttpBeaconSource, eras: &[Vec<B256>]) -> Arc<StateView> {
        let all_eras: Vec<Vec<B256>> = (0..3)
            .map(|era| {
                (0..8192u64)
                    .map(|slot| keccak256(format!("old/{era}/{slot}")))
                    .collect()
            })
            .chain(eras.iter().cloned())
            .collect();
        let anchor = primed(source, 5 * 8192 + 40, &all_eras);
        source.state_for(anchor.state_root).unwrap()
    }

    /// Claim: roots that do not hash to the anchor's `block_summary_root` are refused and not cached, so one bad answer
    /// does not poison the era, and a later good answer succeeds.
    /// Why it matters: before the fix the unverified roots stayed in memory for the life of the process, and every
    /// historical message proof of the era failed until a restart.
    #[test]
    fn bad_era_roots_are_not_cached_and_a_good_answer_follows() {
        let (canonical, eras) = chain_with_gaps();
        let mut wrong = canonical.clone();
        wrong.insert(3 * 8192 + 5, keccak256(b"a root from another fork"));
        let (source, _, answers) = changeable_source_over(wrong);
        let anchor = anchored(&source, &eras);
        let error = source.era_roots(3, &anchor).unwrap_err();
        assert!(
            error
                .to_string()
                .contains("do not hash to the block summary root"),
            "{error}"
        );
        assert!(
            source.era_cache.lock().unwrap().is_empty(),
            "nothing stays cached after a mismatch"
        );

        // The same source, now over a node that answers correctly: the earlier failure left nothing behind.
        *answers.lock().unwrap() = canonical;
        assert_eq!(*source.era_roots(3, &anchor).unwrap(), eras[0]);
        assert_eq!(source.era_cache.lock().unwrap().len(), 1);
    }

    /// Claim: a failed era leaves earlier verified eras in place, and a retry on the same source verifies afresh.
    #[test]
    fn a_failed_era_does_not_disturb_the_cache() {
        let (canonical, eras) = chain_with_gaps();
        let (source, requests) = source_over(canonical);
        let anchor = anchored(&source, &eras);
        source.era_roots(3, &anchor).unwrap();
        // Era 4 is served truthfully, but the anchor below holds a different summary for it.
        let mut changed = eras.clone();
        changed[1][17] = keccak256(b"different");
        let other_anchor = anchored(&source, &changed);
        let before = requests.load(Ordering::SeqCst);
        assert!(source.era_roots(4, &other_anchor).is_err());
        assert!(
            requests.load(Ordering::SeqCst) > before,
            "the node was asked"
        );
        let cached: Vec<u64> = source
            .era_cache
            .lock()
            .unwrap()
            .iter()
            .map(|(era, _)| *era)
            .collect();
        assert_eq!(cached, vec![3]);
    }

    /// Claim: the era cache holds at most the capacity, the newest first, and drops the oldest.
    /// Why it matters: untrusted answers must not grow memory without bound.
    #[test]
    fn era_cache_is_bounded_and_evicts_the_oldest() {
        let mut cache: Vec<(u64, u32)> = Vec::new();
        for era in 0..ERA_CACHE_SIZE as u64 + 5 {
            insert_bounded(&mut cache, era, era as u32, ERA_CACHE_SIZE);
        }
        assert_eq!(cache.len(), ERA_CACHE_SIZE);
        assert_eq!(cache[0].0, ERA_CACHE_SIZE as u64 + 4, "newest first");
        assert!(
            cache.iter().all(|(era, _)| *era >= 5),
            "eras 0 to 4 are evicted"
        );
        insert_bounded(&mut cache, 10, 99, ERA_CACHE_SIZE);
        assert_eq!(
            cache.len(),
            ERA_CACHE_SIZE,
            "re-inserting a key does not duplicate it"
        );
        assert_eq!(cache.iter().filter(|(era, _)| *era == 10).count(), 1);
    }

    /// Claim: the era roots come from the canonical block roots of the node, one request per slot of the era, plus the
    /// search for the block before the era when its first slot is empty. An empty slot repeats the root before it. A
    /// second call for the same era makes no request.
    /// Why it matters: the bridge's `block_summary_root` is the root of exactly this vector. A wrong carry at one
    /// slot makes every historical message proof of the era revert.
    #[test]
    fn era_roots_are_rebuilt_from_canonical_block_roots() {
        let (canonical, eras) = chain_with_gaps();
        let (source, requests) = source_over(canonical);
        let anchor = anchored(&source, &eras);
        let roots = source.era_roots(3, &anchor).unwrap();
        assert_eq!(*roots, eras[0]);
        // 8192 slots, then the backward search: slot 3 * 8192 - 1 and - 2 are empty, - 3 holds the block.
        assert_eq!(requests.load(Ordering::SeqCst), 8192 + 3);
        assert_eq!(
            roots[0],
            keccak256(b"block before era 3"),
            "the empty first slot repeats the block before the era"
        );
        let empty = (3 * 8192 + 1..).find(|slot| slot % 7 == 0).unwrap();
        let offset = (empty - 3 * 8192) as usize;
        assert_eq!(
            roots[offset],
            roots[offset - 1],
            "slot {empty} is empty (a multiple of seven) and repeats the root before it"
        );
        assert_ne!(
            roots[offset + 1],
            roots[offset],
            "the next slot holds a block"
        );
        source.era_roots(3, &anchor).unwrap();
        assert_eq!(
            requests.load(Ordering::SeqCst),
            8192 + 3,
            "the second call reads the cache"
        );
    }

    /// Claim: for a message more than 8192 slots below the anchor, the source builds the historical branch, and it
    /// verifies at the generalized index that the bridge builds (`lc-core`), under the anchor state root. For a message
    /// within 8192 slots it builds the recent branch at the recent index. A source header that the canonical roots do
    /// not name is refused, and a node that serves one wrong root is caught by the era formula.
    /// Why it matters: the bridge picks the path from the distance and checks the exact branch length and index.
    #[test]
    fn ancestry_follows_the_distance_and_refuses_wrong_roots() {
        let (canonical, eras) = chain_with_gaps();
        let (source, _) = source_over(canonical.clone());
        let anchor_slot = 5 * 8192 + 40;
        let all_eras: Vec<Vec<B256>> = (0..3)
            .map(|era| {
                (0..8192u64)
                    .map(|slot| keccak256(format!("old/{era}/{slot}")))
                    .collect()
            })
            .chain(eras.iter().cloned())
            .collect();
        let anchor = primed(&source, anchor_slot, &all_eras);
        let state_root = anchor.state_root;

        let source_slot = 3 * 8192 + 1234;
        let source_root = eras[0][1234];
        let branch = source
            .ancestry_branch_for(&anchor, source_slot, source_root)
            .unwrap();
        assert_eq!(branch.len(), 44);
        let gindex =
            ancestry_leaf_gindex(ChainKind::Pulsechain.spec(), anchor_slot, source_slot).unwrap();
        assert_eq!(gindex, historical_leaf_gindex(59, 3, source_slot).unwrap());
        assert!(is_valid_exact_branch(
            &source_root,
            &branch,
            gindex,
            &state_root
        ));
        assert!(!is_valid_exact_branch(
            &source_root,
            &branch,
            historical_leaf_gindex(59, 4, source_slot).unwrap(),
            &state_root
        ));

        // The recent path: the anchor's own `block_roots` hold the header.
        let recent_slot = anchor_slot - 100;
        let state = source.state_for(state_root).unwrap();
        let recent_root = state.block_root_at(recent_slot);
        let recent = source
            .ancestry_branch_for(&anchor, recent_slot, recent_root)
            .unwrap();
        assert_eq!(recent.len(), 18);
        assert!(is_valid_exact_branch(
            &recent_root,
            &recent,
            lc_core::ancestry::block_roots_leaf_gindex(37, recent_slot).unwrap(),
            &state_root
        ));

        // A header that the canonical roots do not name.
        let error = source
            .ancestry_branch_for(&anchor, source_slot, keccak256(b"other"))
            .unwrap_err();
        assert!(
            error.to_string().contains("do not name the source header"),
            "{error}"
        );

        // One wrong root in era 4: the era formula fails and no branch is built.
        let mut wrong = canonical;
        wrong.insert(4 * 8192 + 5, keccak256(b"a root from another fork"));
        let (bad_source, _) = source_over(wrong);
        let bad_anchor = primed(&bad_source, anchor_slot, &all_eras);
        let bad_slot = 4 * 8192 + 5;
        let error = bad_source
            .ancestry_branch_for(
                &bad_anchor,
                bad_slot,
                keccak256(b"a root from another fork"),
            )
            .unwrap_err();
        assert!(
            error
                .to_string()
                .contains("do not hash to the block summary root"),
            "{error}"
        );
    }

    /// Claim: the historical layout evidence picks a stored slot in a completed era more than 8192 slots below the
    /// anchor, and its branch verifies at the bridge's index. With no such stored slot there is no evidence yet. An era
    /// that is still open at the anchor (no summary) is not a candidate.
    /// Why it matters: the bridge refuses a historical message proof until this row exists.
    #[test]
    fn historical_layout_evidence_uses_a_stored_slot_in_a_completed_era() {
        let (canonical, eras) = chain_with_gaps();
        let (source, _) = source_over(canonical);
        let anchor_slot = 5 * 8192 + 40;
        let all_eras: Vec<Vec<B256>> = (0..3)
            .map(|era| {
                (0..8192u64)
                    .map(|slot| keccak256(format!("old/{era}/{slot}")))
                    .collect()
            })
            .chain(eras.iter().cloned())
            .collect();
        let anchor = primed(&source, anchor_slot, &all_eras);

        // The stored slot 3 * 8192 + 1234 holds a header whose root the era vector names.
        let earlier = 3 * 8192 + 1234;
        let stored = [earlier, anchor_slot - 100, anchor_slot];
        let evidence = source
            .historical_layout_evidence(&anchor, &stored)
            .unwrap()
            .expect("evidence");
        assert_eq!(evidence.earlier_slot, earlier);
        assert_eq!(evidence.gindex, 59);
        let leaf = eras[0][1234];
        let index = historical_leaf_gindex(evidence.gindex, 3, earlier).unwrap();
        assert!(is_valid_exact_branch(
            &leaf,
            &evidence.branch,
            index,
            &anchor.state_root
        ));

        assert!(source
            .historical_layout_evidence(&anchor, &[anchor_slot - 100, anchor_slot])
            .unwrap()
            .is_none());
        // A slot within 8192 slots of the anchor is not a candidate, whatever its era.
        assert!(source
            .historical_layout_evidence(&anchor, &[5 * 8192 + 2])
            .unwrap()
            .is_none());
    }

    // ---------------------------------------------------------------- catching up with a fold

    use lc_testkit::synthetic::{build_update, committee_for, UpdateRecipe};

    const PERIOD_SLOTS: u64 = 8192;

    /// The handoff update of `period`: attested and finalized inside the period, signed by its committee, and proving
    /// the committee of the next period. The store is the one that the same recipe gives (head early in the period).
    fn period_scenario(period: u64) -> lc_testkit::synthetic::UpdateScenario {
        let base = period * PERIOD_SLOTS;
        build_update(
            ChainKind::Pulsechain.spec(),
            UpdateRecipe {
                store_slot: base + 10,
                finalized_slot: base + 4_000,
                attested_slot: base + 4_100,
                signature_slot: base + 4_101,
                participants: 400,
                include_next_committee: true,
                store_knows_next_committee: false,
            },
        )
    }

    fn handoffs_of(periods: std::ops::Range<u64>) -> BTreeMap<u64, LightClientUpdate> {
        periods
            .map(|period| (period, period_scenario(period).update))
            .collect()
    }

    fn committee_hash_of(period: u64) -> B256 {
        committee_hash(&committee_for(ChainKind::Pulsechain.spec(), period).committee).unwrap()
    }

    /// Claim: a light client four periods behind catches up in one fold: the handoff update of each period it passed,
    /// then the latest update. The program accepts the fold, the output spans all of it, and the oracle backend signs it.
    /// Why it matters: one update crosses at most one period. Before the fold the source sent the latest update alone,
    /// and the program refused it ("more than one period past the stored head"), so the light client never caught up.
    #[test]
    fn a_light_client_four_periods_behind_catches_up_in_one_fold() {
        let first = period_scenario(100);
        let handoffs = handoffs_of(100..104);
        let latest = period_scenario(104).update;
        let latest_slot = latest.finalized_header.beacon.slot;

        let fold = assemble_fold(
            ChainKind::Pulsechain,
            first.store.header_slot,
            &handoffs,
            latest.clone(),
        )
        .unwrap();
        assert_eq!(fold.len(), 5, "four handoffs and the latest update");

        // The control: the latest update alone, as the source sent it before, is refused.
        let alone = UpdateInput {
            chain: ChainKind::Pulsechain,
            store: first.store.clone(),
            updates: vec![latest],
        };
        let refused = verify_update_natively(&alone).unwrap_err();
        assert!(
            refused.to_string().contains("more than one period"),
            "{refused}"
        );

        let input = UpdateInput {
            chain: ChainKind::Pulsechain,
            store: first.store.clone(),
            updates: fold,
        };
        let output = verify_update_natively(&input).expect("the fold verifies natively");
        assert_eq!(output.previousHeadSlot, first.store.header_slot);
        assert_eq!(output.newHeadSlot, latest_slot);
        assert_eq!(output.previousSyncCommitteeHash, committee_hash_of(100));
        assert_eq!(output.syncCommitteeHash, committee_hash_of(104));
        assert_eq!(output.nextSyncCommitteeHash, committee_hash_of(105));

        let oracle = crate::signer::Signer::from_secret_bytes(&[0x42; 32]).unwrap();
        let proof = crate::prover::OracleProver::new(oracle)
            .prove(B256::repeat_byte(0x42), &ProofStatement::Verified(input))
            .expect("the oracle signs the fold");
        assert_eq!(
            proof.public_values,
            crate::light_client::public_values(&output)
        );
    }

    use crate::prover::Prover;

    /// Claim: a light client 66 periods behind needs two folds. The first holds the 64 handoffs that the program takes
    /// and ends in period 163. The second starts there, leaves out the handoff of the head period (it finalizes the head
    /// itself), and ends at the latest update.
    /// Why it matters: the program refuses a fold of 65 updates. The source must cut the catch-up at 64 and continue
    /// on the next pass, from the store that the first fold left, which carries the next committee that it proved.
    #[test]
    fn a_light_client_more_than_sixty_four_periods_behind_needs_two_folds() {
        let first = period_scenario(100);
        let handoffs = handoffs_of(100..166);
        let latest = period_scenario(166).update;
        let latest_slot = latest.finalized_header.beacon.slot;
        let spec = ChainKind::Pulsechain.spec();

        let fold_one = assemble_fold(
            ChainKind::Pulsechain,
            first.store.header_slot,
            &handoffs,
            latest.clone(),
        )
        .unwrap();
        assert_eq!(fold_one.len(), MAX_FOLD_UPDATES);
        let (output_one, store_one) =
            lc_core::update::verify_light_client_fold(&first.store, &fold_one, spec)
                .expect("the first fold verifies");
        assert_eq!(spec.period_at_slot(output_one.newHeadSlot), 163);
        assert!(output_one.newHeadSlot < latest_slot);

        let fold_two = assemble_fold(
            ChainKind::Pulsechain,
            store_one.header_slot,
            &handoffs,
            latest,
        )
        .unwrap();
        assert_eq!(
            fold_two.len(),
            3,
            "handoffs of periods 164 and 165, then the latest update"
        );
        let (output_two, _) =
            lc_core::update::verify_light_client_fold(&store_one, &fold_two, spec)
                .expect("the second fold verifies");
        assert_eq!(
            output_two.previousHeadSlot, output_one.newHeadSlot,
            "the second fold starts where the first ended"
        );
        assert_eq!(output_two.newHeadSlot, latest_slot);
    }

    /// Claim: a period that the node does not give is an error that names the period, says what is needed, and asks
    /// for a node with a longer history. No fold is built from the periods that exist.
    /// Why it matters: pruned history cannot be fetched again. The operator must change the node, and the log line must
    /// say so. A fold with a hole would fail inside the program with an error that names no period.
    #[test]
    fn a_missing_period_is_an_error_that_names_it() {
        let mut handoffs = handoffs_of(100..104);
        handoffs.remove(&102);
        let latest = period_scenario(104).update;
        let error = assemble_fold(
            ChainKind::Pulsechain,
            100 * PERIOD_SLOTS + 10,
            &handoffs,
            latest,
        )
        .unwrap_err();
        let text = error.to_string();
        assert!(text.contains("sync committee period 102"), "{text}");
        assert!(
            text.contains("period 100") && text.contains("period 104"),
            "{text}"
        );
        assert!(text.contains("longer history"), "{text}");
        assert_eq!(first_missing_period(&handoffs, 100, 104), Some(102));
        assert_eq!(first_missing_period(&handoffs, 100, 102), None);
    }

    /// Claim: a head in the period of the latest update needs no handoff, and the fold is the latest update alone.
    /// Why it matters: this is the common case. It must not ask the node for periods, and it must keep the old behavior.
    #[test]
    fn a_head_in_the_latest_period_needs_the_latest_update_alone() {
        let first = period_scenario(100);
        let latest = period_scenario(100).update;
        let fold = assemble_fold(
            ChainKind::Pulsechain,
            first.store.header_slot,
            &BTreeMap::new(),
            latest,
        )
        .unwrap();
        assert_eq!(fold.len(), 1);
    }

    /// Claim: the paging asks for the count that is left (never more than 128), starts each request after the highest
    /// period received, takes what a node that gives only three periods per request returns, and stops when a request
    /// brings nothing new.
    /// Why it matters: a node chooses how many updates it returns. A pager that assumed the full count would leave
    /// holes, and one that did not stop would loop on a node that pruned the start of the range.
    #[test]
    fn paging_follows_what_the_node_returns() {
        let node_has = |from: u64| {
            let calls = Arc::new(Mutex::new(Vec::new()));
            let log = calls.clone();
            let request = move |start: u64, count: u64| -> Result<Vec<(u64, u64)>> {
                log.lock().unwrap().push((start, count));
                Ok((start.max(from)..start.max(from) + count.min(3))
                    .map(|period| (period, period))
                    .collect())
            };
            (calls, request)
        };

        let (calls, request) = node_has(0);
        let received = page_through_periods(10, 20, request).unwrap();
        assert_eq!(
            received.keys().copied().collect::<Vec<_>>(),
            (10..20).collect::<Vec<_>>()
        );
        assert_eq!(
            *calls.lock().unwrap(),
            vec![(10, 10), (13, 7), (16, 4), (19, 1)]
        );

        let (calls, request) = node_has(0);
        page_through_periods(0, 300, request).unwrap();
        assert_eq!(
            calls.lock().unwrap()[0],
            (0, UPDATES_PER_REQUEST),
            "the first request is capped"
        );

        // A node that pruned periods below 15 gives 15, 16, 17 for a request from 10. The pager takes them and goes on.
        let (calls, request) = node_has(15);
        let received = page_through_periods(10, 20, request).unwrap();
        assert_eq!(
            received.keys().copied().collect::<Vec<_>>(),
            (15..20).collect::<Vec<_>>()
        );
        assert_eq!(first_missing_period(&received, 10, 20), Some(10));
        assert_eq!(calls.lock().unwrap().len(), 2);

        // A node that gives nothing ends the search at once.
        let empty = page_through_periods::<u64>(10, 20, |_, _| Ok(Vec::new())).unwrap();
        assert!(empty.is_empty());
    }

    /// Claim: the request names `start_period` and `count`, the answer is a list of `{version, data}` objects, and the
    /// period of an update is the period of its attested header. A node that does not serve the endpoint gives no
    /// updates and no error.
    /// Why it matters: this is the wire shape of the standard beacon API. A wrong query name or period rule would
    /// pass the paging tests and fail on every real node.
    #[test]
    fn the_updates_endpoint_is_read_in_the_standard_shape() {
        let path = light_client_fixtures().join("light_client_update.json");
        let wrapper: serde_json::Value =
            serde_json::from_slice(&std::fs::read(&path).unwrap()).unwrap();
        let data = wrapper["response"]["update"].clone();
        let update = update_from_json(&data).unwrap();
        let period = ChainKind::Pulsechain
            .spec()
            .period_at_slot(update.attested_header.beacon.slot);

        let body = serde_json::json!([{ "version": "capella", "data": data }])
            .to_string()
            .into_bytes();
        let query = format!("/eth/v1/beacon/light_client/updates?start_period={period}&count=1");
        let node = Node([(query, body)].into_iter().collect());
        let received =
            fetch_period_updates(&node, ChainKind::Pulsechain, period, period + 1).unwrap();
        assert_eq!(received.keys().copied().collect::<Vec<_>>(), vec![period]);

        let silent = Node(HashMap::new());
        assert!(
            fetch_period_updates(&silent, ChainKind::Pulsechain, period, period + 1)
                .unwrap()
                .is_empty()
        );
    }

    // ---------------------------------------------------------------- the store at the head

    use lc_core::chain::{ForkName, ETHEREUM_MAINNET};
    use lc_testkit::state_bytes::StateBytes;
    /// A slot in the middle of the first epoch of `fork` on Ethereum mainnet.
    fn ethereum_slot_in(fork: ForkName) -> u64 {
        let entry = ETHEREUM_MAINNET
            .fork_schedule
            .iter()
            .find(|entry| entry.fork_name == fork)
            .expect("the fork is scheduled");
        entry.epoch * ETHEREUM_MAINNET.slots_per_epoch + 7
    }

    /// An Ethereum source whose node serves one synthetic state of `fork`, the header that names it, and the state.
    /// The current and the next committee are two different real committees.
    fn head_with_state(fork: ForkName) -> (HttpBeaconSource, BeaconHeader, StateView) {
        let slot = ethereum_slot_in(fork);
        let period = ETHEREUM_MAINNET.period_at_slot(slot);
        let current = committee_for(&ETHEREUM_MAINNET, period).committee.clone();
        let next = committee_for(&ETHEREUM_MAINNET, period + 1)
            .committee
            .clone();
        let bytes = StateBytes::new(fork, slot, current, next).to_ssz();
        let state =
            StateView::parse(&bytes, ChainKind::Ethereum).expect("a synthetic state parses");
        let head = BeaconHeader {
            slot,
            proposer_index: 5,
            parent_root: keccak256(b"head parent"),
            state_root: state.root(),
            body_root: keccak256(b"head body"),
        };
        let path = format!("/eth/v2/debug/beacon/states/{:#x}", head.state_root);
        let node = Node([(path, bytes)].into_iter().collect());
        (
            HttpBeaconSource::new(ChainKind::Ethereum, Box::new(node)),
            head,
            state,
        )
    }

    const FORKS_WITH_STATES: [ForkName; 4] = [
        ForkName::Capella,
        ForkName::Deneb,
        ForkName::Electra,
        ForkName::Fulu,
    ];

    /// Claim: when the light client holds a next committee, `store_at_head` reads both committees from the state of the
    /// head, in every layout (Capella, Deneb, Electra, Fulu), and the store names the head.
    /// Why it matters: the contract compares the next committee hash of the store with its own. A parser that gave a
    /// shifted field would hand the program the wrong committee, and the fold would revert on chain.
    #[test]
    fn store_at_head_reads_both_committees_from_the_state() {
        for fork in FORKS_WITH_STATES {
            let (source, head, state) = head_with_state(fork);
            let next_hash = committee_hash(state.next_committee()).unwrap();
            let store = source
                .store_at_head(&head, next_hash)
                .unwrap_or_else(|error| panic!("{fork:?}: {error}"));
            assert_eq!(store.header_root, header_root(&head), "{fork:?}");
            assert_eq!(store.header_slot, head.slot, "{fork:?}");
            assert_eq!(
                &store.current_sync_committee,
                state.current_committee(),
                "{fork:?}"
            );
            assert_eq!(
                store.next_sync_committee.as_ref(),
                Some(state.next_committee()),
                "{fork:?}"
            );
            assert_ne!(
                state.current_committee(),
                state.next_committee(),
                "{fork:?}: the two committees must differ"
            );
        }
    }

    /// Claim: when the contract holds no next committee (the stored hash is zero) and the node serves no bootstrap,
    /// the store comes from the state of the head and carries the current committee only.
    /// Why it matters: a store with a next committee that the contract does not hold would not match its record.
    #[test]
    fn store_at_head_without_a_next_committee_carries_the_current_committee_only() {
        for fork in FORKS_WITH_STATES {
            let (source, head, state) = head_with_state(fork);
            let store = source
                .store_at_head(&head, B256::ZERO)
                .unwrap_or_else(|error| panic!("{fork:?}: {error}"));
            assert_eq!(
                &store.current_sync_committee,
                state.current_committee(),
                "{fork:?}"
            );
            assert!(store.next_sync_committee.is_none(), "{fork:?}");
        }
    }

    /// Claim: when the stored hash is not the hash of the next committee in the state, `store_at_head` fails with an
    /// error that names the stored hash. A hash of the current committee, of another committee and of one flipped bit
    /// all fail, in every layout.
    /// Why it matters: the state may belong to another fork of the beacon chain than the one the light client followed.
    /// The prover must stop and not send a proof that the contract rejects.
    #[test]
    fn store_at_head_refuses_a_stored_hash_that_differs() {
        for fork in FORKS_WITH_STATES {
            let (source, head, state) = head_with_state(fork);
            let next_hash = committee_hash(state.next_committee()).unwrap();
            let mut flipped = next_hash;
            flipped.0[0] ^= 1;
            let stranger = committee_hash(&committee_for(&ETHEREUM_MAINNET, 7).committee).unwrap();
            let wrong_hashes = [
                committee_hash(state.current_committee()).unwrap(),
                stranger,
                flipped,
            ];
            for wrong in wrong_hashes {
                match source.store_at_head(&head, wrong) {
                    Err(Error::Beacon(message)) => {
                        assert!(
                            message.contains(&format!("{wrong:#x}")),
                            "{fork:?}: {message}"
                        )
                    }
                    other => panic!(
                        "{fork:?}: expected a mismatch error, got {:?}",
                        other.map(|_| ())
                    ),
                }
            }
            assert!(
                source.store_at_head(&head, next_hash).is_ok(),
                "{fork:?}: the control must pass"
            );
        }
    }

    /// Claim: a node that serves a state which does not hash to the `state_root` of the head gets an error, and no
    /// store comes out.
    /// Why it matters: the head state is the only authority for the next committee. Its hash must tie to the header.
    #[test]
    fn store_at_head_refuses_a_state_that_does_not_belong_to_the_head() {
        let (source, head, state) = head_with_state(ForkName::Electra);
        let next_hash = committee_hash(state.next_committee()).unwrap();
        let other = BeaconHeader {
            state_root: keccak256(b"another state"),
            ..head
        };
        let bytes = StateBytes::new(
            ForkName::Electra,
            head.slot,
            state.current_committee().clone(),
            state.next_committee().clone(),
        )
        .to_ssz();
        let path = format!("/eth/v2/debug/beacon/states/{:#x}", other.state_root);
        let node = Node([(path, bytes)].into_iter().collect());
        let liar = HttpBeaconSource::new(ChainKind::Ethereum, Box::new(node));
        assert!(matches!(
            liar.store_at_head(&other, next_hash),
            Err(Error::Beacon(message)) if message.contains("hashes to")
        ));
        assert!(
            source.store_at_head(&head, next_hash).is_ok(),
            "the control must pass"
        );
    }
}
