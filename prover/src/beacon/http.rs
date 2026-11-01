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
//! The handoff of the head period is asked for only when the light client does not store the next committee yet: when
//! it does, an update signed in the next period is verified by that committee. A node without the updates route (chain
//! 943) can therefore move a light client across one period border, as long as a proof runs before the source signs in
//! the period after the stored next committee. After that the light client is stranded on such a node.
//!
//! When the light client does not store the next committee, the first step of a crossing must prove it: it must finalize
//! a header after the head, inside the head period, be signed there, and carry the next committee. The best update that a
//! node serves for the period often finalizes a header before the head (in-period updates moved the head past it), and a
//! node without the updates route serves none. The source then assembles that step from the blocks and the state at the
//! end of the head period (`head_period_handoff`). An update that stays inside the head period also gets the next
//! committee from its attested state when it carries none (a finality update never does), so the contract stores the
//! next committee before the border is reached.
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
//! 2. It reads the anchor state. A PulseChain node serves an older state without its last summary; the source
//!    completes it from the newest finalized state (see `repair_frozen_state`). A node serves recent states only, so
//!    the anchor should be the newest head that the light client stores.
//! 3. `lc-core` checks the rebuilt roots against the `block_summary_root` of the anchor state.
//!
//! # Gloas
//!
//! A Gloas finalized header proves `state.latest_block_hash`, and the program reads the block number from the RLP of
//! that execution block. So after a fold is chosen, [`HttpBeaconSource::plan_update`] reads the state of each Gloas
//! finalized header (hashed in full and compared with the state root), asks an [`ExecutionHeaders`] source for the
//! raw header of `latest_block_hash`, and attaches both through `anchor_gloas_header`. Without an execution source the
//! run stops with an error that names `source.rpc_url`. A message proof from a Gloas source block is built through `gloas_message_path`
//! (the first later block whose bid names the source block as `parent_block_hash`), not refused.
//!
//! Limits: the SSZ parser in `lc-core` reads states of the Capella, Deneb, Electra, Fulu and Gloas layouts. It picks the layout
//! from the fork that the chain schedule has at the slot of the state. The block parser reads the Capella block layout
//! only, so the assembled update path needs a Capella chain. Ethereum uses the light-client endpoints for the update.

use super::branch_store::{
    stored_branch_proves_genesis_validators_root, GenesisValidatorsRootBranchStore,
    MemoryBranchStore,
};
use super::state_store::{StateStore, StoredState};
use super::{HashEvidence, HistoricalEvidence, RootsEvidence, SourceBlock, StoredHead, UpdatePlan};
use crate::chain::checked_raw_header;
use crate::error::{Error, Result};
use crate::fork_schedule::{ForkSchedule, CHAIN_SPEC_PATH, FORK_SCHEDULE_PATH};
use crate::light_client::{
    ancestry_path, anchor_gloas_header, assemble_update, beacon_header_from_json,
    block_hash_gindex, block_roots_gindex, committee_hash, complete_frozen_state, describe_header,
    era_block_roots, era_of, header_root, historical_summaries_gindex, missing_summary_index,
    plan_header_repair, rebuild_execution_header, store_at, store_from_bootstrap_json,
    strip_transition_padding, sync_aggregate_from_json, update_from_json, AncestryPath,
    BeaconHeader, BeaconPath, BlockView, ChainKind, GloasBlockView, HeaderRepair, LightClientStore,
    LightClientUpdate, StateView, SyncAggregate, UpdateInput, SLOTS_PER_HISTORICAL_ROOT,
};
use crate::logging::Logger;
use crate::rpc::{HttpGet, JsonRpc};
use alloy_primitives::B256;
use lc_core::chain::ForkName;
use lc_core::types::NextSyncCommittee;
use lc_core::update::{FoldStep, MAX_FOLD_UPDATES};
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

/// Logs that a state served one summary short was completed (see `repair_frozen_state`).
pub fn log_repaired_state(slot: u64, missing_index: u64, state_root: B256) {
    Logger::standard().info(
        "state_repaired",
        &[
            ("slot", slot.to_string()),
            ("missing_index", missing_index.to_string()),
            ("state_root", format!("{state_root:#x}")),
        ],
    );
}

/// Whether a status of the `light_client/bootstrap` route means "no bootstrap for this root", so the caller reads the state
/// of the header instead. A node answers 404 or 501 when it serves no light-client routes. Lodestar answers 500
/// (`syncCommitteeWitness not available`) for a root that it no longer holds. The state is hashed in full and compared with
/// the header, so a fallback after any of these statuses trusts nothing new.
pub fn bootstrap_unavailable(status: u16) -> bool {
    matches!(status, 404 | 500 | 501)
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
///
/// When the light client already stores the committee of the period after the head (`next_committee_known`), the
/// handoff of the head period is left out: its only use is to prove that committee. The fold then starts with an update
/// signed in the next period, which the stored next committee verifies. This is what lets a light client whose source
/// node serves no `light_client/updates` (chain 943) cross a period border at all: an update signed in the next period
/// moves it there, and the next committee it proves keeps it one period ahead.
pub fn handoff_periods(
    chain: ChainKind,
    head_slot: u64,
    next_committee_known: bool,
    latest: &LightClientUpdate,
) -> Range<u64> {
    let spec = chain.spec();
    let first = spec.period_at_slot(head_slot) + u64::from(next_committee_known);
    let last = spec.period_at_slot(latest.finalized_header.beacon.slot);
    first..last.min(first + MAX_FOLD_UPDATES as u64).max(first)
}

/// Whether `update` can be the first step from a head at `head_slot` that does not store the next committee: it moves
/// the head, it is attested, finalized and signed in the period of the head, and it proves the next committee. The program
/// refuses any other first step of a fold that crosses the period border: an update that does not move the head is
/// refused ("the finalized slot is not after the stored head"), an update without the next committee leaves the next
/// step with no committee to verify it, and an update signed in the next period needs a crossing.
pub fn proves_next_committee_from_head(
    chain: ChainKind,
    head_slot: u64,
    update: &LightClientUpdate,
) -> bool {
    let spec = chain.spec();
    let period = spec.period_at_slot(head_slot);
    update.finalized_header.beacon.slot > head_slot
        && update.next_sync_committee.is_some()
        && spec.period_at_slot(update.finalized_header.beacon.slot) == period
        && spec.period_at_slot(update.attested_header.beacon.slot) == period
        && spec.period_at_slot(update.signature_slot) == period
}

/// The period of the head when the source must build the handoff update of that period itself, from block and state data,
/// or `None` when it need not.
///
/// It must when the light client does not store the next committee, the fold crosses the period border of the head, and
/// the node gave no handoff for the head period that can be the first step ([`proves_next_committee_from_head`]). A node
/// gives the best update of a period, chosen by participation, so its pick often finalizes a header before a head that
/// in-period updates have already moved late into the period; a node without the `light_client/updates` route (chain 943
/// on the g4mm4 node) gives none.
pub fn head_period_handoff_to_build(
    chain: ChainKind,
    head_slot: u64,
    next_committee_known: bool,
    handoffs: &BTreeMap<u64, LightClientUpdate>,
    latest: &LightClientUpdate,
) -> Option<u64> {
    if next_committee_known {
        return None;
    }
    let periods = handoff_periods(chain, head_slot, next_committee_known, latest);
    if periods.is_empty() {
        return None;
    }
    let usable = handoffs
        .get(&periods.start)
        .is_some_and(|update| proves_next_committee_from_head(chain, head_slot, update));
    (!usable).then_some(periods.start)
}

/// The updates of one fold from the head at `head_slot`: the handoff update of each period, then the latest update when
/// the fold has room for it. An update that does not move the head forward is left out (the handoff of the head
/// period often finalizes the head itself), except when the light client does not store the next committee: then the
/// handoff of the head period is the only step that can prove it, and one that cannot is an error.
///
/// # Errors
/// `Error::Beacon` naming the first period that `handoffs` lacks, or the head period when its handoff cannot be the first
/// step of a crossing from a head without the next committee.
pub fn assemble_fold(
    chain: ChainKind,
    head_slot: u64,
    next_committee_known: bool,
    handoffs: &BTreeMap<u64, LightClientUpdate>,
    latest: LightClientUpdate,
) -> Result<Vec<LightClientUpdate>> {
    let periods = handoff_periods(chain, head_slot, next_committee_known, &latest);
    let latest_period = chain
        .spec()
        .period_at_slot(latest.finalized_header.beacon.slot);
    if let Some(period) = first_missing_period(handoffs, periods.start, periods.end) {
        return Err(missing_period_error(period, periods.start, latest_period));
    }
    if head_period_handoff_to_build(chain, head_slot, next_committee_known, handoffs, &latest)
        .is_some()
    {
        return Err(Error::Beacon(format!(
            "the handoff update of sync committee period {} cannot hand off the light client head at slot {head_slot}: \
             the light client stores no committee for period {}, and the update must finalize a header after the head, \
             inside period {}, be signed in that period and prove the next committee",
            periods.start,
            periods.start + 1,
            periods.start
        )));
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

impl RpcExecutionHeaders {
    /// The header from `debug_getRawHeader`, checked against `hash`.
    fn raw_from_method(&self, hash: B256) -> Result<Vec<u8>> {
        let answer = self.rpc.call(
            "debug_getRawHeader",
            serde_json::json!([format!("{hash:#x}")]),
        )?;
        checked_raw_header(&answer, hash)
    }

    /// The header rebuilt from `eth_getBlockByHash`. The rebuilt encoding must hash to the block hash that the node
    /// reports, and that hash must be the one asked for. A header with a field that the rebuilder does not know (a Gloas
    /// header) fails the first check, and the call then stops with an error and does not guess.
    fn rebuilt_from_block(&self, hash: B256) -> Result<Vec<u8>> {
        let block = self.rpc.call(
            "eth_getBlockByHash",
            serde_json::json!([format!("{hash:#x}"), false]),
        )?;
        if block.is_null() {
            return Err(Error::Malformed(format!(
                "the execution node does not know the block {hash:#x}"
            )));
        }
        let rebuilt = rebuild_execution_header(&block)?;
        if rebuilt.block_hash != hash {
            return Err(Error::Malformed(format!(
                "the execution node answered block {:#x}, not {hash:#x}",
                rebuilt.block_hash
            )));
        }
        Ok(rebuilt.header_rlp.to_vec())
    }
}

impl ExecutionHeaders for RpcExecutionHeaders {
    /// Asks `debug_getRawHeader` first. When the node answers with an error object (for example "method not found"), the
    /// header is rebuilt from `eth_getBlockByHash`. A wrong answer is not an error object, and it never takes the fallback:
    /// a node that sent a header of another block stops the call.
    fn raw_header(&self, hash: B256) -> Result<Vec<u8>> {
        match self.raw_from_method(hash) {
            Err(Error::Rpc { .. }) => self.rebuilt_from_block(hash),
            result => result,
        }
    }
}

/// A beacon node.
pub struct HttpBeaconSource {
    chain: ChainKind,
    client: Box<dyn HttpGet>,
    /// More beacon APIs, asked in order for a state that `client` does not serve or serves wrong.
    state_clients: Vec<Box<dyn HttpGet>>,
    /// Verified states from earlier runs, asked before any node.
    state_store: Option<Arc<dyn StateStore>>,
    execution_headers: Option<Box<dyn ExecutionHeaders>>,
    branch_store: Arc<dyn GenesisValidatorsRootBranchStore>,
    schedule: Mutex<Option<Arc<ForkSchedule>>>,
    genesis_time: Mutex<Option<u64>>,
    state_cache: Mutex<Vec<(B256, Arc<StateView>)>>,
    era_cache: Mutex<Vec<(u64, Arc<Vec<B256>>)>>,
}

/// What the branch store held for a state root, after the check.
enum StoredBranch {
    /// The store held no entry.
    Absent,
    /// The store held an entry and it proves `genesis_validators_root` under the state root.
    Verified(Vec<B256>),
    /// The store held an entry that failed the check. The prover dropped it.
    Dropped,
}

impl HttpBeaconSource {
    /// A source over an HTTP client.
    pub fn new(chain: ChainKind, client: Box<dyn HttpGet>) -> Self {
        Self {
            chain,
            client,
            state_clients: Vec::new(),
            state_store: None,
            execution_headers: None,
            branch_store: Arc::new(MemoryBranchStore::new()),
            schedule: Mutex::new(None),
            genesis_time: Mutex::new(None),
            state_cache: Mutex::new(Vec::new()),
            era_cache: Mutex::new(Vec::new()),
        }
    }

    /// The same source with more beacon APIs for states (`source.state_urls`). They are asked in order, only for
    /// `/eth/v2/debug/beacon/states/<root>`, when the main node does not serve a state or serves one with another root.
    /// Every state is still checked against the root its header names.
    pub fn with_state_clients(mut self, clients: Vec<Box<dyn HttpGet>>) -> Self {
        self.state_clients = clients;
        self
    }

    /// The same source with a store of verified states (`source.state_cache_dir`). A state is read from it before any
    /// node is asked, and each state fetched and verified goes into it.
    pub fn with_state_store(mut self, store: Arc<dyn StateStore>) -> Self {
        self.state_store = Some(store);
        self
    }

    /// The same source with an execution header source. A fold with a Gloas finalized header needs it.
    pub fn with_execution_headers(mut self, headers: Box<dyn ExecutionHeaders>) -> Self {
        self.execution_headers = Some(headers);
        self
    }

    /// The same source with a store for the branches of `genesis_validators_root`. The default store lives in memory and
    /// ends with the process. A directory store (see [`super::branch_store::DirectoryBranchStore`]) lets a later run catch
    /// up after the node has pruned the old states.
    pub fn with_branch_store(mut self, store: Arc<dyn GenesisValidatorsRootBranchStore>) -> Self {
        self.branch_store = store;
        self
    }

    /// The fork schedule of the beacon node, read once. It joins `/eth/v1/config/fork_schedule` and
    /// `/eth/v1/config/spec` (see [`crate::fork_schedule`]). There is no fallback to the table of `lc-core`.
    ///
    /// # Errors
    /// `Error::Beacon` naming the path when the node does not serve one of the two answers. `Error::Malformed` and
    /// `Error::ForkScheduleMismatch` from the join.
    pub fn fork_schedule(&self) -> Result<Arc<ForkSchedule>> {
        if let Some(cached) = self.schedule.lock().expect("lock").as_ref() {
            return Ok(cached.clone());
        }
        let schedule_answer = Self::require(
            self.get_json(FORK_SCHEDULE_PATH)?,
            &format!("the answer {FORK_SCHEDULE_PATH}"),
        )?;
        let specification = Self::require(
            self.get_json(CHAIN_SPEC_PATH)?,
            &format!("the answer {CHAIN_SPEC_PATH}"),
        )?;
        let schedule = Arc::new(ForkSchedule::from_answers(
            &schedule_answer,
            &specification,
            self.chain.spec().slots_per_epoch,
        )?);
        *self.schedule.lock().expect("lock") = Some(schedule.clone());
        Ok(schedule)
    }

    /// The execution header source, or the error that tells the operator to set `source.rpc_url`.
    fn require_execution_headers(&self, reason: &str) -> Result<&dyn ExecutionHeaders> {
        self.execution_headers.as_deref().ok_or_else(|| {
            Error::Config(format!(
                "{reason} needs the execution header of a block: set source.rpc_url (or --source-rpc-url)"
            ))
        })
    }

    /// Repairs the finalized header of every update, as the fork of its slot requires (see
    /// [`crate::light_client::plan_header_repair`]):
    ///
    /// - A Gloas header gets the anchor through its state and the raw header of `state.latest_block_hash`.
    /// - A header from before Gloas, served padded inside a Gloas update, loses its padding and gets the raw header of its
    ///   execution block.
    /// - A header in the form of its fork is left alone.
    ///
    /// Only the finalized header changes. The attested header stays as served: the program does not read its execution data.
    ///
    /// # Errors
    /// `Error::Config` when a repair needs an execution source and the source has none. `Error::UnknownActiveFork` and
    /// `Error::HeaderFormMismatch` from the plan. The errors of `anchor_gloas_header`, `strip_transition_padding` and the
    /// reads.
    fn repair_finalized_headers(
        &self,
        schedule: &ForkSchedule,
        updates: &mut [LightClientUpdate],
    ) -> Result<()> {
        for update in updates {
            let finalized = &update.finalized_header;
            let fork = schedule.fork_at_slot(finalized.beacon.slot)?;
            match plan_header_repair(finalized, fork)? {
                HeaderRepair::Untouched => {}
                HeaderRepair::GloasAnchor => {
                    let headers = self.require_execution_headers("a Gloas finalized header")?;
                    let state = self.state_for(finalized.beacon.state_root)?;
                    let hash = state.latest_block_hash().ok_or_else(|| {
                        Error::Beacon("the finalized state is not a Gloas state".into())
                    })?;
                    let rlp = headers.raw_header(hash)?;
                    update.finalized_header = anchor_gloas_header(&finalized.beacon, &state, rlp)?;
                }
                HeaderRepair::StripPadding { keep } => {
                    let headers =
                        self.require_execution_headers("a padded pre-Gloas finalized header")?;
                    let rlp = headers.raw_header(finalized.execution_block_hash())?;
                    update.finalized_header = strip_transition_padding(finalized, keep, rlp)?;
                }
            }
        }
        Ok(())
    }

    /// The branch of `genesis_validators_root` under `state_root`, for an update whose finality branch has
    /// `finality_branch_length` entries (that length names the layout of the state).
    ///
    /// The store comes first, because the node may have pruned the state. The prover checks a stored entry natively
    /// against `state_root` before it uses the entry. An entry that fails the check is dropped, with a warning that names
    /// the state root, and the branch comes from the state instead. If the store has none, the state gives it as well, and
    /// the store keeps it.
    ///
    /// # Errors
    /// `Error::Beacon` naming the state when the node no longer serves the state and the store has no entry that passes
    /// the check. The text says when the store held an entry that failed. `Error::Malformed` when the finality branch
    /// length names no layout. `Error::Config` when the store cannot drop or keep an entry.
    fn genesis_validators_root_branch_under(
        &self,
        state_root: B256,
        finality_branch_length: usize,
    ) -> Result<Vec<B256>> {
        match self.checked_stored_branch(state_root, finality_branch_length)? {
            StoredBranch::Verified(branch) => Ok(branch),
            StoredBranch::Absent => self.branch_from_state(state_root),
            StoredBranch::Dropped => self.branch_from_state(state_root).map_err(|error| {
                Error::Beacon(format!(
                    "the stored branch of genesis_validators_root under state root {state_root:#x} failed its check and \
                     was dropped, and the branch cannot be built again: {error}"
                ))
            }),
        }
    }

    /// Reads the entry for `state_root` and checks it. A failed entry leaves the store.
    fn checked_stored_branch(
        &self,
        state_root: B256,
        finality_branch_length: usize,
    ) -> Result<StoredBranch> {
        let Some(stored) = self.branch_store.get(&state_root) else {
            return Ok(StoredBranch::Absent);
        };
        let proves = stored_branch_proves_genesis_validators_root(
            self.chain.spec(),
            finality_branch_length,
            &stored,
            &state_root,
        )?;
        if proves {
            return Ok(StoredBranch::Verified(stored));
        }
        Logger::standard().warn(
            "stored_branch_dropped",
            &[
                ("state_root", format!("{state_root:#x}")),
                (
                    "reason",
                    "the branch does not prove genesis_validators_root".to_string(),
                ),
            ],
        );
        self.branch_store.remove(&state_root)?;
        Ok(StoredBranch::Dropped)
    }

    /// Builds the branch from the state of `state_root` and keeps it in the store.
    fn branch_from_state(&self, state_root: B256) -> Result<Vec<B256>> {
        let branch = self.state_for(state_root)?.genesis_validators_root_branch();
        self.branch_store.put(state_root, branch.clone())?;
        Ok(branch)
    }

    /// Gives every update the branch of `genesis_validators_root` under the state root of its attested header. An update
    /// that already carries one (the assembled update) is kept and its branch is stored.
    ///
    /// The branch is public data. The store is not trusted: the prover checks a stored entry before it uses it (see
    /// [`Self::genesis_validators_root_branch_under`]).
    fn attach_genesis_validators_root_branches(
        &self,
        updates: Vec<LightClientUpdate>,
    ) -> Result<Vec<LightClientUpdate>> {
        updates
            .into_iter()
            .map(|update| {
                let state_root = update.attested_header.beacon.state_root;
                if !update.genesis_validators_root_branch.is_empty() {
                    self.branch_store
                        .put(state_root, update.genesis_validators_root_branch.clone())?;
                    return Ok(update);
                }
                let branch = self.genesis_validators_root_branch_under(
                    state_root,
                    update.finality_branch.len(),
                )?;
                Ok(update.with_genesis_validators_root_branch(branch))
            })
            .collect()
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

    /// The state with `state_root`, hashed in full and compared with the root. The two newest states stay cached in
    /// memory. A state comes from the state store first, then from the node, then from each state URL in order.
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
        let state = match self.stored_state(state_root) {
            Some(state) => state,
            None => self.fetch_state(state_root)?,
        };
        let state = Arc::new(state);
        let mut cache = self.state_cache.lock().expect("lock");
        cache.insert(0, (state_root, state.clone()));
        cache.truncate(STATE_CACHE_SIZE);
        Ok(state)
    }

    /// Parses SSZ state bytes with the fork that the schedule of the node has at their slot.
    fn parse_state(&self, bytes: &[u8]) -> Result<StateView> {
        let fork = self
            .fork_schedule()?
            .fork_at_slot(StateView::slot_of_bytes(bytes)?)?;
        StateView::parse_with_fork(bytes, fork)
    }

    /// The state from the state store, verified again. A stored state that fails is removed, and `None` sends the
    /// caller to the nodes.
    fn stored_state(&self, state_root: B256) -> Option<StateView> {
        let store = self.state_store.as_ref()?;
        let stored = store.get(&state_root)?;
        let checked =
            self.parse_state(&stored.bytes)
                .and_then(|state| match stored.appended_summary {
                    Some(entry) => state.with_appended_summary(entry),
                    None => Ok(state),
                });
        match checked {
            Ok(state) if state.root() == state_root => Some(state),
            _ => {
                let _ = store.remove(&state_root);
                None
            }
        }
    }

    /// The state from the node, then from each state URL in order. Each answer must hash to `state_root`, after the
    /// PulseChain repair where it applies; an answer that does not moves on to the next URL. The verified state goes
    /// into the state store. With no state URL the error of the node comes back unchanged.
    fn fetch_state(&self, state_root: B256) -> Result<StateView> {
        let path = format!("/eth/v2/debug/beacon/states/{state_root:#x}");
        let clients = std::iter::once(self.client.as_ref())
            .chain(self.state_clients.iter().map(|client| client.as_ref()));
        let mut failures: Vec<Error> = Vec::new();
        for client in clients {
            match self.state_from(client, &path, state_root) {
                Ok(Some((state, stored))) => {
                    self.keep_state(state_root, &state, &stored);
                    return Ok(state);
                }
                Ok(None) => failures.push(Error::Beacon(format!(
                    "the node does not have state {state_root:#x}"
                ))),
                Err(error) => failures.push(error),
            }
        }
        if failures.len() == 1 {
            return Err(failures.remove(0));
        }
        let reasons: Vec<String> = failures
            .iter()
            .enumerate()
            .map(|(index, error)| {
                let text = error.to_string();
                let reason = if text.contains("does not have state") {
                    "not served".to_string()
                } else {
                    text
                };
                let name = match index {
                    0 => "beacon_url".to_string(),
                    _ => format!("state_urls[{}]", index - 1),
                };
                format!("{name}: {reason}")
            })
            .collect();
        Err(Error::Beacon(format!(
            "no beacon API served state {state_root:#x}: {}",
            reasons.join("; ")
        )))
    }

    /// One node's answer for a state: `None` for 404 and 501, the verified state and what to store otherwise.
    fn state_from(
        &self,
        client: &dyn HttpGet,
        path: &str,
        state_root: B256,
    ) -> Result<Option<(StateView, StoredState)>> {
        let response = client.get(path, SSZ)?;
        let bytes = match response.status {
            200 => response.body,
            404 | 501 => return Ok(None),
            status => return Err(Error::Beacon(format!("GET {path}: status {status}"))),
        };
        let state = self.parse_state(&bytes)?;
        if state.root() == state_root {
            return Ok(Some((
                state,
                StoredState {
                    bytes,
                    appended_summary: None,
                },
            )));
        }
        let repaired = self.repair_frozen_state(state, state_root)?;
        let appended_summary = repaired.historical_summaries().last().copied();
        Ok(Some((
            repaired,
            StoredState {
                bytes,
                appended_summary,
            },
        )))
    }

    /// Puts a verified state into the state store. A store that cannot write is logged, not fatal.
    fn keep_state(&self, state_root: B256, state: &StateView, stored: &StoredState) {
        if let Some(store) = &self.state_store {
            if let Err(error) = store.put(state_root, state.slot(), stored) {
                Logger::standard().warn(
                    "state_store_failed",
                    &[
                        ("state_root", format!("{state_root:#x}")),
                        ("error", error.to_string()),
                    ],
                );
            }
        }
    }

    /// A state that does not hash to `state_root`, repaired when it is a PulseChain state that the node served one
    /// `historical_summaries` entry short (see [`missing_summary_index`]). The missing entry comes from the newest
    /// finalized state, which the node still serves whole, and summaries are only ever appended, so the entry is the
    /// same in both. The repaired state is accepted only when it then hashes to `state_root`. Any other mismatch is an
    /// error.
    fn repair_frozen_state(&self, state: StateView, state_root: B256) -> Result<StateView> {
        let served_root = state.root();
        let mismatch = || {
            Error::Beacon(format!(
                "the state hashes to {served_root:#x}, not {state_root:#x} (the node preset may differ from the mainnet preset)"
            ))
        };
        let Some(index) = missing_summary_index(self.chain, &state) else {
            return Err(mismatch());
        };
        let finalized = Self::require(self.header_by_id("finalized")?, "a finalized header")?;
        if finalized.state_root == state_root {
            return Err(mismatch());
        }
        // Through the cache: a run reads the newest finalized state anyway, so this costs no second download.
        let newest = self.state_for(finalized.state_root)?;
        let slot = state.slot();
        let repaired =
            complete_frozen_state(self.chain, state, &newest, state_root)?.ok_or_else(mismatch)?;
        log_repaired_state(slot, index, state_root);
        Ok(repaired)
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
        let path = format!("/eth/v1/beacon/light_client/bootstrap/{root:#x}");
        let response = self.client.get(&path, JSON)?;
        if response.status == 200 {
            let answer: Value = serde_json::from_slice(&response.body)
                .map_err(|error| Error::Malformed(format!("GET {path}: {error}")))?;
            return store_from_bootstrap_json(&answer["data"]);
        }
        if !bootstrap_unavailable(response.status) {
            return Err(Error::Beacon(format!(
                "GET {path}: status {}",
                response.status
            )));
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
    /// the periods in between, then `latest` (see the module documentation, "Catching up"). The updates are complete:
    /// each carries its branch of `genesis_validators_root`, and each finalized header is in the form that the program
    /// reads. Each step carries the fork version from the fork schedule of the node.
    fn catch_up(
        &self,
        head: &BeaconHeader,
        next_committee_hash: B256,
        latest: LightClientUpdate,
    ) -> Result<UpdateInput> {
        let next_committee_known = next_committee_hash != B256::ZERO;
        let periods = handoff_periods(self.chain, head.slot, next_committee_known, &latest);
        let mut handoffs =
            fetch_period_updates(self.client.as_ref(), self.chain, periods.start, periods.end)?;
        if let Some(period) = head_period_handoff_to_build(
            self.chain,
            head.slot,
            next_committee_known,
            &handoffs,
            &latest,
        ) {
            handoffs.insert(period, self.head_period_handoff(period, head.slot)?);
        }
        let mut folded = assemble_fold(
            self.chain,
            head.slot,
            next_committee_known,
            &handoffs,
            latest,
        )?;
        if !next_committee_known {
            if let Some(last) = folded.last_mut() {
                self.prove_next_committee_in_period(head.slot, last);
            }
        }
        let schedule = self.fork_schedule()?;
        let mut updates = self.attach_genesis_validators_root_branches(folded)?;
        self.repair_finalized_headers(&schedule, &mut updates)?;
        let store = self.store_at_head(head, next_committee_hash)?;
        let steps = updates
            .into_iter()
            .map(|update| FoldStep {
                fork_version: schedule.signing_version(update.signature_slot),
                update,
            })
            .collect();
        Ok(UpdateInput {
            chain: self.chain,
            store,
            steps,
        })
    }

    /// The update assembled from block and state data (the path for nodes without light-client endpoints).
    fn assembled_update(&self) -> Result<LightClientUpdate> {
        let head = Self::require(self.header_by_id("head")?, "a head header")?;
        self.assembled_update_until(head.slot)
    }

    /// The handoff update of `period`, the period of the light client head at `head_slot`, assembled from block and state
    /// data: the newest block whose child, inside `period`, signs it. The update proves the committee of `period + 1` from
    /// the attested state, and it finalizes the header that the attested state names as finalized.
    ///
    /// # Errors
    /// `Error::Beacon` when the node lacks a block or a state, or when that finalized header is not after the head (the
    /// head is so close to the end of the period that no update signed in the period finalizes a later header; the light
    /// client then cannot be handed off by an update of this period).
    fn head_period_handoff(&self, period: u64, head_slot: u64) -> Result<LightClientUpdate> {
        let spec = self.chain.spec();
        let last_slot_of_period =
            (period + 1) * spec.epochs_per_sync_committee_period * spec.slots_per_epoch - 1;
        let chain_head = Self::require(self.header_by_id("head")?, "a head header")?;
        let update = self
            .assembled_update_until(last_slot_of_period.min(chain_head.slot))
            .map_err(|error| {
                Error::Beacon(format!(
                    "the handoff update of sync committee period {period} (the period of the light client head at slot \
                     {head_slot}, which stores no committee for period {}) must be assembled from blocks and states at the \
                     end of the period, and that failed: {error}",
                    period + 1
                ))
            })?;
        if !proves_next_committee_from_head(self.chain, head_slot, &update) {
            return Err(Error::Beacon(format!(
                "the last update signed in sync committee period {period} (attested at slot {}, signed at slot {}) finalizes \
                 slot {}, which does not move the light client head at slot {head_slot}; the light client stores no \
                 committee for period {} and cannot be handed off by an update of period {period}",
                update.attested_header.beacon.slot,
                update.signature_slot,
                update.finalized_header.beacon.slot,
                period + 1
            )));
        }
        Logger::standard().info(
            "handoff_assembled",
            &[
                ("period", period.to_string()),
                ("head_slot", head_slot.to_string()),
                (
                    "attested_slot",
                    update.attested_header.beacon.slot.to_string(),
                ),
                (
                    "finalized_slot",
                    update.finalized_header.beacon.slot.to_string(),
                ),
                ("signature_slot", update.signature_slot.to_string()),
            ],
        );
        Ok(update)
    }

    /// Gives `update` the next committee from its attested state when it stays in the period of the head at `head_slot`
    /// and carries none (a served finality update never does). The output then names the next committee, and the contract
    /// stores it, so the light client reaches the period border with the committee that signs after it.
    ///
    /// When the node does not serve the attested state, the update stays as it is and a warning names the state: the
    /// proof still moves the head, and the handoff at the border builds the missing proof itself
    /// ([`Self::head_period_handoff`]).
    fn prove_next_committee_in_period(&self, head_slot: u64, update: &mut LightClientUpdate) {
        let spec = self.chain.spec();
        let period = spec.period_at_slot(head_slot);
        let in_period = spec.period_at_slot(update.attested_header.beacon.slot) == period
            && spec.period_at_slot(update.finalized_header.beacon.slot) == period;
        if update.next_sync_committee.is_some() || !in_period {
            return;
        }
        let state_root = update.attested_header.beacon.state_root;
        match self.state_for(state_root) {
            Ok(state) => {
                update.next_sync_committee = Some(NextSyncCommittee {
                    committee: state.next_committee().clone(),
                    branch: state.next_committee_branch(),
                });
            }
            Err(error) => Logger::standard().warn(
                "next_committee_not_proven",
                &[
                    ("period", period.to_string()),
                    ("state_root", format!("{state_root:#x}")),
                    ("reason", error.to_string()),
                ],
            ),
        }
    }

    /// The update whose attested block is the newest one with a child at or before `limit_slot`. The child carries the
    /// aggregate, so the update is signed at or before `limit_slot`.
    fn assembled_update_until(&self, limit_slot: u64) -> Result<LightClientUpdate> {
        let mut slot = limit_slot.saturating_sub(1);
        for _ in 0..MAX_EMPTY_SLOTS {
            let Some(attested) = self.block_by_id(&slot.to_string())? else {
                slot = slot.saturating_sub(1);
                continue;
            };
            let Some((child_slot, aggregate)) =
                self.child_aggregate(&attested, slot, limit_slot)?
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
            "no block with a child found within {MAX_EMPTY_SLOTS} slots before slot {limit_slot}"
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
        let input = self.catch_up(&header, head.next_committee_hash, latest)?;
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
    use crate::beacon::state_store::DirectoryStateStore;
    use crate::beacon::SourceBlock;
    use crate::light_client::steps_with_table_versions;
    use crate::light_client::verify_update_natively;
    use crate::prover::ProofStatement;
    use crate::rpc::HttpResponse;
    use alloy_primitives::{hex, keccak256};
    use std::collections::HashMap;
    use std::path::{Path, PathBuf};

    /// An in-memory beacon node: a map from path to body. An unknown path answers 404.
    pub(super) struct Node(pub(super) HashMap<String, Vec<u8>>);

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

    /// A node that answers the two configuration paths like a node that follows the table compiled into `lc-core` for
    /// `chain`, and gives every other path to `inner`.
    struct WithTableConfiguration {
        chain: ChainKind,
        inner: Box<dyn HttpGet>,
    }

    impl HttpGet for WithTableConfiguration {
        fn get(&self, path_and_query: &str, accept: &str) -> Result<HttpResponse> {
            let (schedule, specification) =
                crate::fork_schedule::answers_from_table(self.chain.spec());
            let answer = match path_and_query {
                FORK_SCHEDULE_PATH => schedule,
                CHAIN_SPEC_PATH => specification,
                _ => return self.inner.get(path_and_query, accept),
            };
            Ok(HttpResponse {
                status: 200,
                body: answer.to_string().into_bytes(),
            })
        }
    }

    /// A source over `node` whose configuration answers follow the compiled table of `chain`.
    pub(super) fn source_over_node(
        chain: ChainKind,
        node: impl HttpGet + 'static,
    ) -> HttpBeaconSource {
        HttpBeaconSource::new(
            chain,
            Box::new(WithTableConfiguration {
                chain,
                inner: Box::new(node),
            }),
        )
    }

    fn light_client_fixtures() -> PathBuf {
        Path::new(env!("CARGO_MANIFEST_DIR")).join("../light-client/tests/fixtures/pulsechain")
    }

    fn pulsechain_source(pages: Vec<(String, Vec<u8>)>) -> HttpBeaconSource {
        source_over_node(ChainKind::Pulsechain, Node(pages.into_iter().collect()))
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

    pub(super) fn sepolia_fixtures() -> PathBuf {
        Path::new(env!("CARGO_MANIFEST_DIR")).join("../light-client/tests/fixtures/sepolia")
    }

    /// A Sepolia source over REAL Gloas data: the finality update of a Sepolia node, its finalized state, and the raw
    /// execution header of `state.latest_block_hash`. The head of the light client is a header that shares the real state
    /// root and lies 1000 slots earlier, so the store (the current committee) comes from the real state. Returns the
    /// source, the head, and the hash of the execution header.
    fn real_gloas_source(with_headers: bool) -> (HttpBeaconSource, StoredHead, B256) {
        let (source, stored, hash, _) = real_gloas_source_with_store(with_headers);
        (source, stored, hash)
    }

    /// Like [`real_gloas_source`], and also returns the memory store that holds the real branch of
    /// `genesis_validators_root`, so a test can corrupt the stored entry.
    fn real_gloas_source_with_store(
        with_headers: bool,
    ) -> (HttpBeaconSource, StoredHead, B256, Arc<MemoryBranchStore>) {
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
        // The fixtures hold the finalized state only, so the prover cannot compute the branch of `genesis_validators_root`
        // under the attested state. The fixture file `sepolia/state_proofs.json` holds the real branch for that root. The
        // store gets it, as the prover keeps it in production, and the plan reads it from there.
        let attested_state_root: B256 = update["response"]["data"]["attested_header"]["beacon"]
            ["state_root"]
            .as_str()
            .unwrap()
            .parse()
            .unwrap();
        let real_branch =
            lc_testkit::real_proofs::known_genesis_validators_root_branch(&attested_state_root)
                .expect("the fixture holds the real branch for the attested state root");
        let branches = Arc::new(MemoryBranchStore::new());
        branches.put(attested_state_root, real_branch).unwrap();
        let mut source =
            source_over_node(ChainKind::Sepolia, Node(pages)).with_branch_store(branches.clone());
        if with_headers {
            source = source.with_execution_headers(Box::new(OneHeader { hash, rlp }));
        }
        let stored = StoredHead {
            slot: head_slot,
            root: head_root,
            next_committee_hash: B256::ZERO,
        };
        (source, stored, hash, branches)
    }

    /// Claim: the plan for a REAL Sepolia Gloas head carries a finalized header anchored in its real state, with the real
    /// execution header RLP. The native check of the program ACCEPTS the update, and reports the block that
    /// `state.latest_block_hash` names, with a non-zero number from the RLP. The prover reads the real branch of
    /// `genesis_validators_root` from its store. Two controls follow. First, one flipped entry in the branch of the plan
    /// gives exactly `InvalidGenesisValidatorsRootBranch` from the program. Second, one flipped entry in the STORED branch,
    /// with the attested state unavailable (the fixtures hold the finalized state only), stops the plan with the clear
    /// error that names the state root, and the prover drops the entry.
    /// Why it matters: this is what the prover sends to the guest on Sepolia. The accept shows that the finality, committee,
    /// root branch and signature checks all pass on real data. The first control shows that the accept depends on the
    /// branch. The second shows that the prover checks the stored entry itself, so a bad entry stalls the update with a
    /// clear message instead of a refusal at the cost of a proof run, and never gives a false head.
    #[test]
    fn a_gloas_plan_anchors_the_finalized_header_in_the_real_state() {
        let (source, stored, hash, _) = real_gloas_source_with_store(true);
        let plan = source.plan_update(&stored).unwrap().expect("a plan");
        let finalized = &plan.input.steps[0].update.finalized_header;
        assert_eq!(finalized.execution_block_hash(), hash);
        assert_eq!(finalized.execution_branch.len(), 11);
        assert!(!finalized.execution_header_rlp.is_empty());
        let anchored = lc_core::update::verify_finalized_execution(finalized)
            .expect("the anchored header passes the check of the program");
        assert_eq!(anchored.block_hash, hash);
        assert_ne!(anchored.block_number, 0);
        let output = verify_update_natively(&plan.input)
            .expect("the program accepts the update with the real branch");
        assert_eq!(output.executionBlockHash, hash);
        assert_ne!(output.executionBlockNumber, 0);

        // Control one: the program refuses a plan whose branch has one flipped entry, with the exact error.
        let mut tampered = plan.input.clone();
        tampered.steps[0].update.genesis_validators_root_branch[0].0[0] ^= 0x01;
        assert_eq!(
            verify_update_natively(&tampered).unwrap_err(),
            Error::VerificationRefused(
                lc_core::Error::InvalidGenesisValidatorsRootBranch.to_string()
            )
        );

        // Control two: a corrupt stored entry and no attested state. The prover checks the entry, drops it, cannot build
        // the branch again, and says so.
        let (corrupt_source, corrupt_stored, _, corrupt_branches) =
            real_gloas_source_with_store(true);
        let attested_state_root = plan.input.steps[0].update.attested_header.beacon.state_root;
        corrupt_branches.corrupt(&attested_state_root);
        let Err(error) = corrupt_source.plan_update(&corrupt_stored) else {
            panic!("the plan must fail");
        };
        let text = error.to_string();
        assert!(
            matches!(&error, Error::Beacon(_))
                && text.contains(&format!("{attested_state_root:#x}"))
                && text.contains("failed its check")
                && text.contains("cannot be built again"),
            "{text}"
        );
        assert_eq!(corrupt_branches.get(&attested_state_root), None);
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
        let source = source_over_node(ChainKind::Sepolia, Node(pages));
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
            steps: steps_with_table_versions(ChainKind::Pulsechain, vec![update]),
        })
        .expect("the assembled update must verify natively");
        assert_eq!(output.previousHeadSlot, previous_header.slot);
        assert!(output.newHeadSlot > previous_header.slot);
    }

    // ---------------------------------------------------------------- old messages

    use crate::light_client::test_support::synthetic_state;
    use crate::light_client::ForkData;
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
            source_over_node(ChainKind::Pulsechain, node),
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
            false,
            &handoffs,
            latest.clone(),
        )
        .unwrap();
        assert_eq!(fold.len(), 5, "four handoffs and the latest update");

        // The control: the latest update alone, as the source sent it before, is refused.
        let alone = UpdateInput {
            chain: ChainKind::Pulsechain,
            store: first.store.clone(),
            steps: steps_with_table_versions(ChainKind::Pulsechain, vec![latest]),
        };
        let refused = verify_update_natively(&alone).unwrap_err();
        assert!(
            refused.to_string().contains("more than one period"),
            "{refused}"
        );

        let input = UpdateInput {
            chain: ChainKind::Pulsechain,
            store: first.store.clone(),
            steps: steps_with_table_versions(ChainKind::Pulsechain, fold),
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
            false,
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
            store_one.next_sync_committee.is_some(),
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
            false,
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
            false,
            &BTreeMap::new(),
            latest,
        )
        .unwrap();
        assert_eq!(fold.len(), 1);
    }

    /// The finality update of period `period + 1` from a store early in `period`: attested, finalized and signed in the
    /// next period, proving the committee after it. `store_knows_next` says whether the store holds the next committee.
    fn crossing_scenario(
        period: u64,
        store_knows_next: bool,
    ) -> lc_testkit::synthetic::UpdateScenario {
        let base = period * PERIOD_SLOTS;
        build_update(
            ChainKind::Pulsechain.spec(),
            UpdateRecipe {
                store_slot: base + 10,
                finalized_slot: base + PERIOD_SLOTS + 100,
                attested_slot: base + PERIOD_SLOTS + 200,
                signature_slot: base + PERIOD_SLOTS + 201,
                participants: 400,
                include_next_committee: true,
                store_knows_next_committee: store_knows_next,
            },
        )
    }

    /// Claim: a light client that stores the next committee crosses into the next period with the latest update alone,
    /// with no handoff update from the node, and the program accepts that fold and proves the committee after it. A light
    /// client that does not store the next committee still needs the handoff of its head period.
    /// Why it matters: the beacon node of chain 943 serves no `light_client/updates`. Before this rule the source asked
    /// for the handoff of the head period even when the light client held the committee it proves, found none, and
    /// refused every update after a period border: the light client on Sepolia could never leave its first period.
    #[test]
    fn a_stored_next_committee_crosses_one_period_without_a_handoff() {
        let known = crossing_scenario(100, true);
        let head = known.store.header_slot;
        assert_eq!(
            handoff_periods(ChainKind::Pulsechain, head, true, &known.update),
            101..101
        );
        let fold = assemble_fold(
            ChainKind::Pulsechain,
            head,
            true,
            &BTreeMap::new(),
            known.update.clone(),
        )
        .expect("no handoff is needed");
        assert_eq!(fold.len(), 1);
        let output = verify_update_natively(&UpdateInput {
            chain: ChainKind::Pulsechain,
            store: known.store.clone(),
            steps: steps_with_table_versions(ChainKind::Pulsechain, fold),
        })
        .expect("the stored next committee verifies the crossing");
        assert_eq!(
            ChainKind::Pulsechain
                .spec()
                .period_at_slot(output.newHeadSlot),
            101
        );
        assert_eq!(output.syncCommitteeHash, committee_hash_of(101));
        assert_eq!(output.nextSyncCommitteeHash, committee_hash_of(102));

        let unknown = crossing_scenario(100, false);
        let error = assemble_fold(
            ChainKind::Pulsechain,
            unknown.store.header_slot,
            false,
            &BTreeMap::new(),
            unknown.update,
        )
        .unwrap_err();
        assert!(
            error.to_string().contains("sync committee period 100"),
            "{error}"
        );
    }

    /// Claim: the live case of 2026-10-31. The light client on Sepolia has its head in period 1366 and stores the
    /// committees of 1366 and 1367; the node gives no update for 1366 but gives 1367; the newest update is in 1368. The
    /// fold asks only for 1367, holds that handoff and the newest update, and the program accepts it from the store.
    /// Why it matters: the proof failed with "no light-client update for sync committee period 1366" although the
    /// update of 1366 could only prove the committee of 1367, which the light client already held.
    #[test]
    fn a_catch_up_starts_at_the_first_period_whose_next_committee_is_unknown() {
        let store = crossing_scenario(1366, true).store;
        assert_eq!(
            ChainKind::Pulsechain
                .spec()
                .period_at_slot(store.header_slot),
            1366
        );
        let handoffs = handoffs_of(1367..1368);
        let latest = period_scenario(1368).update;
        let latest_slot = latest.finalized_header.beacon.slot;
        assert_eq!(
            handoff_periods(ChainKind::Pulsechain, store.header_slot, true, &latest),
            1367..1368
        );
        let fold = assemble_fold(
            ChainKind::Pulsechain,
            store.header_slot,
            true,
            &handoffs,
            latest,
        )
        .expect("period 1366 is not needed");
        assert_eq!(fold.len(), 2, "the handoff of 1367, then the newest update");
        let output = verify_update_natively(&UpdateInput {
            chain: ChainKind::Pulsechain,
            store,
            steps: steps_with_table_versions(ChainKind::Pulsechain, fold),
        })
        .expect("the stored committee of 1367 signs the first step");
        assert_eq!(output.newHeadSlot, latest_slot);
        assert_eq!(output.previousSyncCommitteeHash, committee_hash_of(1366));
        assert_eq!(output.startNextSyncCommitteeHash, committee_hash_of(1367));
        assert_eq!(output.syncCommitteeHash, committee_hash_of(1368));
    }

    /// Claim: from a head late in period 1368 without the next committee, a served handoff of 1368 that finalizes a header
    /// before the head is not dropped in silence: the source is told to build the handoff of 1368 itself, and the fold
    /// refuses to go on without it. A served handoff that moves the head, inside 1368, with the next committee, is used.
    /// Why it matters: the dropped handoff left the newest update alone, which the program refused with "the store does
    /// not know the next sync committee" (2026-11-01), an error that named neither the period nor the cause.
    #[test]
    fn a_stale_handoff_of_the_head_period_is_never_dropped_in_silence() {
        let spec = ChainKind::Pulsechain.spec();
        let head_slot = 1368 * PERIOD_SLOTS + 7_648;
        let stale = period_scenario(1368).update;
        assert!(stale.finalized_header.beacon.slot < head_slot);
        let latest = crossing_scenario(1368, false).update;
        let handoffs: BTreeMap<u64, LightClientUpdate> = [(1368, stale)].into_iter().collect();
        assert_eq!(
            head_period_handoff_to_build(
                ChainKind::Pulsechain,
                head_slot,
                false,
                &handoffs,
                &latest
            ),
            Some(1368)
        );
        assert_eq!(
            head_period_handoff_to_build(
                ChainKind::Pulsechain,
                head_slot,
                false,
                &BTreeMap::new(),
                &latest
            ),
            Some(1368),
            "a node without the updates route gives no handoff"
        );
        assert_eq!(
            head_period_handoff_to_build(
                ChainKind::Pulsechain,
                head_slot,
                true,
                &handoffs,
                &latest
            ),
            None,
            "a stored next committee needs no handoff of the head period"
        );
        let in_period = period_scenario(1368).update;
        assert_eq!(
            head_period_handoff_to_build(
                ChainKind::Pulsechain,
                1368 * PERIOD_SLOTS + 10,
                false,
                &BTreeMap::new(),
                &in_period
            ),
            None,
            "an update inside the head period crosses nothing"
        );
        let error = assemble_fold(
            ChainKind::Pulsechain,
            head_slot,
            false,
            &handoffs,
            latest.clone(),
        )
        .unwrap_err()
        .to_string();
        assert!(
            error.contains("period 1368") && error.contains("period 1369"),
            "{error}"
        );

        // A late handoff of 1368: finalized after the head, signed in 1368, proving 1369.
        let base = 1368 * PERIOD_SLOTS;
        let late = build_update(
            spec,
            UpdateRecipe {
                store_slot: head_slot,
                finalized_slot: base + 8_100,
                attested_slot: base + 8_180,
                signature_slot: base + 8_181,
                participants: 400,
                include_next_committee: true,
                store_knows_next_committee: false,
            },
        );
        assert!(proves_next_committee_from_head(
            ChainKind::Pulsechain,
            head_slot,
            &late.update
        ));
        let handoffs: BTreeMap<u64, LightClientUpdate> =
            [(1368, late.update.clone())].into_iter().collect();
        assert_eq!(
            head_period_handoff_to_build(
                ChainKind::Pulsechain,
                head_slot,
                false,
                &handoffs,
                &latest
            ),
            None
        );
        let fold = assemble_fold(
            ChainKind::Pulsechain,
            head_slot,
            false,
            &handoffs,
            latest.clone(),
        )
        .unwrap();
        assert_eq!(fold.len(), 2);
        let output = verify_update_natively(&UpdateInput {
            chain: ChainKind::Pulsechain,
            store: late.store.clone(),
            steps: steps_with_table_versions(ChainKind::Pulsechain, fold),
        })
        .expect("the late handoff proves the committee that signs the newest update");
        assert_eq!(output.startNextSyncCommitteeHash, B256::ZERO);
        assert_eq!(output.syncCommitteeHash, committee_hash_of(1369));
        assert_eq!(output.newHeadSlot, latest.finalized_header.beacon.slot);

        // A late update signed in the next period cannot be the first step.
        let mut signed_late = late.update;
        signed_late.signature_slot = base + PERIOD_SLOTS;
        assert!(!proves_next_committee_from_head(
            ChainKind::Pulsechain,
            head_slot,
            &signed_late
        ));
    }

    /// Claim: with the next committee stored, a light client two periods behind still needs the handoff of the period
    /// after its head, and only that one; the handoff of the head period is not asked for.
    /// Why it matters: an update signed two periods past the head cannot be verified by any stored committee. The error
    /// must name the period a node has to supply, so the operator knows the light client is stranded there.
    #[test]
    fn a_stored_next_committee_still_needs_the_handoffs_after_it() {
        let first = period_scenario(100);
        let latest = period_scenario(102).update;
        assert_eq!(
            handoff_periods(
                ChainKind::Pulsechain,
                first.store.header_slot,
                true,
                &latest
            ),
            101..102
        );
        let error = assemble_fold(
            ChainKind::Pulsechain,
            first.store.header_slot,
            true,
            &handoffs_of(100..101),
            latest,
        )
        .unwrap_err();
        assert!(
            error.to_string().contains("sync committee period 101"),
            "{error}"
        );
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
        (source_over_node(ChainKind::Ethereum, node), head, state)
    }

    // ---------------------------------------------------------------- frozen PulseChain states one summary short

    use lc_core::chain::PULSECHAIN_TESTNET_V4;

    /// Summary pair `index`, different for each index.
    fn summary(index: u64) -> (B256, B256) {
        (
            keccak256(format!("block summary {index}")),
            keccak256(format!("state summary {index}")),
        )
    }

    /// A Capella state at `slot` with the summaries `0..count`, as SSZ.
    fn state_with_summaries(slot: u64, summaries: Vec<(B256, B256)>) -> Vec<u8> {
        let current = committee_for(&PULSECHAIN_TESTNET_V4, 1).committee.clone();
        let next = committee_for(&PULSECHAIN_TESTNET_V4, 2).committee.clone();
        let mut state = StateBytes::new(ForkName::Capella, slot, current, next);
        state.historical_summaries = summaries;
        state.to_ssz()
    }

    fn summaries(count: u64) -> Vec<(B256, B256)> {
        (0..count).map(summary).collect()
    }

    fn root_of(chain: ChainKind, bytes: &[u8]) -> B256 {
        StateView::parse(bytes, chain).unwrap().root()
    }

    /// The page of `/eth/v1/beacon/headers/<id>` for a header that names `state_root`.
    fn header_page(slot: u64, state_root: B256) -> Vec<u8> {
        serde_json::json!({"data": {"header": {"message": {
            "slot": slot.to_string(),
            "proposer_index": "1",
            "parent_root": format!("{:#x}", keccak256(b"parent")),
            "state_root": format!("{state_root:#x}"),
            "body_root": format!("{:#x}", keccak256(b"body")),
        }}}})
        .to_string()
        .into_bytes()
    }

    /// A node that counts the requests of each path.
    struct CountingNode {
        node: Node,
        requests: Arc<Mutex<HashMap<String, usize>>>,
    }

    impl HttpGet for CountingNode {
        fn get(&self, path_and_query: &str, accept: &str) -> Result<HttpResponse> {
            *self
                .requests
                .lock()
                .unwrap()
                .entry(path_and_query.to_string())
                .or_default() += 1;
            self.node.get(path_and_query, accept)
        }
    }

    /// Slot 2848 of era 1366 on PulseChain testnet v4: the slot of the real case. Capella forked in era 16, so a whole
    /// state there holds 1366 - 16 = 1350 summaries.
    const OLD_SLOT: u64 = 1366 * 8192 + 2848;
    const WHOLE: u64 = 1350;

    /// A testnet node that serves the state of `OLD_SLOT` as `served`, and a newer finalized state with `newest`.
    /// Returns the source, the root that the header of the old state names, and the request counts.
    fn frozen_state_node(
        chain: ChainKind,
        served: Vec<u8>,
        old_root: B256,
        newest: Vec<(B256, B256)>,
    ) -> (HttpBeaconSource, Arc<Mutex<HashMap<String, usize>>>, String) {
        let newest_bytes = state_with_summaries(OLD_SLOT + 64, newest);
        let newest_root = root_of(chain, &newest_bytes);
        let newest_path = format!("/eth/v2/debug/beacon/states/{newest_root:#x}");
        let node = Node(
            [
                (format!("/eth/v2/debug/beacon/states/{old_root:#x}"), served),
                (newest_path.clone(), newest_bytes),
                (
                    "/eth/v1/beacon/headers/finalized".to_string(),
                    header_page(OLD_SLOT + 64, newest_root),
                ),
            ]
            .into_iter()
            .collect(),
        );
        let requests = Arc::new(Mutex::new(HashMap::new()));
        let source = source_over_node(
            chain,
            CountingNode {
                node,
                requests: requests.clone(),
            },
        );
        (source, requests, newest_path)
    }

    /// Claim: a PulseChain state that the node serves without its last summary is completed from the newest finalized
    /// state and accepted, because it then hashes to the root its header names. The newest state is downloaded once.
    /// Why it matters: Lighthouse-Pulse v2.5.1 serves every frozen state that way. Without the repair a light client on
    /// PulseChain can only prove from the newest finalized head, and stalls for good after one missed finalization.
    #[test]
    fn a_pulsechain_state_one_summary_short_is_completed_from_the_newest_finalized_state() {
        let chain = ChainKind::PulsechainTestnetV4;
        let old_root = root_of(chain, &state_with_summaries(OLD_SLOT, summaries(WHOLE)));
        let short = state_with_summaries(OLD_SLOT, summaries(WHOLE - 1));
        assert_ne!(
            root_of(chain, &short),
            old_root,
            "the cut state must not hash to its root"
        );

        let (source, requests, newest_path) =
            frozen_state_node(chain, short, old_root, summaries(WHOLE));
        let state = source
            .state_for(old_root)
            .expect("the repaired state is accepted");
        assert_eq!(state.root(), old_root);
        assert_eq!(state.historical_summaries().len() as u64, WHOLE);

        let newest_root: B256 = newest_path.rsplit('/').next().unwrap().parse().unwrap();
        source.state_for(newest_root).unwrap();
        assert_eq!(
            requests.lock().unwrap()[&newest_path],
            1,
            "the newest state comes from the cache the second time"
        );
    }

    /// Claim: the repair happens on PulseChain only. An Ethereum state one summary short is refused as before.
    /// Why it matters: Ethereum networks fork on an era boundary, so a short list there is a different fault, and a
    /// repair would hide it.
    #[test]
    fn an_ethereum_state_one_summary_short_is_refused() {
        let chain = ChainKind::Ethereum;
        // A Capella slot of Ethereum in era 760. Capella forked at the start of era 758, so two summaries are whole.
        let slot = 760 * 8192 + 7;
        let whole = 2;
        let old_root = {
            let current = committee_for(&ETHEREUM_MAINNET, 1).committee.clone();
            let next = committee_for(&ETHEREUM_MAINNET, 2).committee.clone();
            let mut state = StateBytes::new(ForkName::Capella, slot, current.clone(), next.clone());
            state.historical_summaries = summaries(whole);
            root_of(chain, &state.to_ssz())
        };
        let short = {
            let current = committee_for(&ETHEREUM_MAINNET, 1).committee.clone();
            let next = committee_for(&ETHEREUM_MAINNET, 2).committee.clone();
            let mut state = StateBytes::new(ForkName::Capella, slot, current, next);
            state.historical_summaries = summaries(whole - 1);
            state.to_ssz()
        };
        let node = Node(
            [(format!("/eth/v2/debug/beacon/states/{old_root:#x}"), short)]
                .into_iter()
                .collect(),
        );
        let error = source_over_node(chain, node)
            .state_for(old_root)
            .err()
            .expect("refused");
        assert!(error.to_string().contains("the state hashes to"), "{error}");
    }

    /// Claim: on PulseChain, every mismatch other than exactly one missing last summary is refused: two missing, a
    /// changed field, and a newest state whose entry differs.
    /// Why it matters: the repair trusts nothing. It adds one entry and still demands the root from the header.
    #[test]
    fn any_other_pulsechain_mismatch_is_refused() {
        let chain = ChainKind::PulsechainTestnetV4;
        let old_root = root_of(chain, &state_with_summaries(OLD_SLOT, summaries(WHOLE)));
        let refused = |served: Vec<u8>, newest: Vec<(B256, B256)>| {
            let (source, _, _) = frozen_state_node(chain, served, old_root, newest);
            let error = source.state_for(old_root).err().expect("refused");
            assert!(error.to_string().contains("the state hashes to"), "{error}");
        };

        refused(
            state_with_summaries(OLD_SLOT, summaries(WHOLE - 2)),
            summaries(WHOLE),
        );

        let mut tampered = summaries(WHOLE - 1);
        tampered[3] = summary(9_999);
        refused(state_with_summaries(OLD_SLOT, tampered), summaries(WHOLE));

        let mut other_newest = summaries(WHOLE);
        other_newest[(WHOLE - 1) as usize] = summary(9_999);
        refused(
            state_with_summaries(OLD_SLOT, summaries(WHOLE - 1)),
            other_newest,
        );

        // The newest state is too short to hold the entry.
        refused(
            state_with_summaries(OLD_SLOT, summaries(WHOLE - 1)),
            summaries(WHOLE - 1),
        );
    }

    /// Claim: the missing index follows `slot / 8192 - capellaForkSlot / 8192` on both PulseChain networks, and is
    /// `None` when the list is whole or for Ethereum.
    #[test]
    fn the_missing_index_follows_the_capella_era_of_the_chain() {
        let view = |chain: ChainKind, slot: u64, count: u64| {
            StateView::parse(&state_with_summaries(slot, summaries(count)), chain).unwrap()
        };
        let testnet = ChainKind::PulsechainTestnetV4;
        assert_eq!(
            missing_summary_index(testnet, &view(testnet, OLD_SLOT, WHOLE - 1)),
            Some(WHOLE - 1)
        );
        assert_eq!(
            missing_summary_index(testnet, &view(testnet, OLD_SLOT, WHOLE)),
            None
        );
        assert_eq!(
            missing_summary_index(testnet, &view(testnet, OLD_SLOT, WHOLE - 2)),
            None
        );
        // PulseChain mainnet forked Capella at slot 96, era 0: a state in era 5 holds 5 summaries.
        let mainnet = ChainKind::Pulsechain;
        assert_eq!(
            missing_summary_index(mainnet, &view(mainnet, 5 * 8192 + 7, 4)),
            Some(4)
        );
        assert_eq!(
            missing_summary_index(mainnet, &view(mainnet, 5 * 8192 + 7, 5)),
            None
        );
    }

    /// Claim: the real state that the node of chain 943 served after the next finalization (64 bytes short) hashes to the
    /// root of its header once the last summary of the state served while it was the newest is appended.
    /// Why it matters: it shows on real data that the fault is exactly the missing last entry.
    /// The files are kept in `light-client/fetch-cache/pulsechain-testnet-v4-frozen-state` (not tracked by git). The test
    /// skips when they are absent.
    #[test]
    fn the_real_short_testnet_state_hashes_to_its_root_once_completed() {
        let directory = Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("../light-client/fetch-cache/pulsechain-testnet-v4-frozen-state");
        let read = |name: &str| std::fs::read(directory.join(name));
        let (Ok(header), Ok(whole), Ok(short)) = (
            read("finalized_header.json"),
            read("state_while_newest.ssz"),
            read("state_after_next_finalization.ssz"),
        ) else {
            eprintln!("SKIPPED: the real testnet states are not in light-client/fetch-cache/pulsechain-testnet-v4-frozen-state");
            return;
        };
        let chain = ChainKind::PulsechainTestnetV4;
        let header: Value = serde_json::from_slice(&header).unwrap();
        let header = beacon_header_from_json(&header["data"]["header"]["message"]).unwrap();
        let whole = StateView::parse(&whole, chain).unwrap();
        let short = StateView::parse(&short, chain).unwrap();
        assert_eq!(whole.root(), header.state_root);
        assert_ne!(short.root(), header.state_root);
        let index = missing_summary_index(chain, &short).expect("one entry is missing");
        let entry = whole.historical_summaries()[index as usize];
        let repaired = short.with_appended_summary(entry).unwrap();
        assert_eq!(repaired.root(), header.state_root);
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

    /// A node that answers every path with a fixed status, except the paths that it serves.
    struct StatusNode {
        status: u16,
        pages: HashMap<String, Vec<u8>>,
    }

    impl HttpGet for StatusNode {
        fn get(&self, path_and_query: &str, _accept: &str) -> Result<HttpResponse> {
            Ok(match self.pages.get(path_and_query) {
                Some(body) => HttpResponse {
                    status: 200,
                    body: body.clone(),
                },
                None => HttpResponse {
                    status: self.status,
                    body: br#"{"code":500,"message":"syncCommitteeWitness not available"}"#
                        .to_vec(),
                },
            })
        }
    }

    /// Claim: when the node answers the bootstrap route with 500 (Lodestar, for a root that it no longer holds) or 404, and
    /// serves the state of the head, the store comes from the state. Any other status stops the run.
    /// Why it matters: a live Sepolia run from a head that is not the newest finalized header failed on this answer.
    #[test]
    fn store_at_head_reads_the_state_when_the_bootstrap_is_unavailable() {
        let (_, head, state) = head_with_state(ForkName::Electra);
        let bytes = StateBytes::new(
            ForkName::Electra,
            head.slot,
            state.current_committee().clone(),
            state.next_committee().clone(),
        )
        .to_ssz();
        let path = format!("/eth/v2/debug/beacon/states/{:#x}", head.state_root);
        for status in [404, 500, 501] {
            let node = StatusNode {
                status,
                pages: HashMap::from([(path.clone(), bytes.clone())]),
            };
            let source = source_over_node(ChainKind::Ethereum, node);
            let store = source
                .store_at_head(&head, B256::ZERO)
                .unwrap_or_else(|error| panic!("status {status}: {error}"));
            assert_eq!(&store.current_sync_committee, state.current_committee());
        }
        let node = StatusNode {
            status: 503,
            pages: HashMap::from([(path, bytes)]),
        };
        let refused = source_over_node(ChainKind::Ethereum, node);
        assert!(matches!(
            refused.store_at_head(&head, B256::ZERO),
            Err(Error::Beacon(message)) if message.contains("status 503")
        ));
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
        let liar = source_over_node(ChainKind::Ethereum, node);
        assert!(matches!(
            liar.store_at_head(&other, next_hash),
            Err(Error::Beacon(message)) if message.contains("hashes to")
        ));
        assert!(
            source.store_at_head(&head, next_hash).is_ok(),
            "the control must pass"
        );
    }

    // ---------------------------------------------------------------- state fallbacks and the state store

    /// A node that answers every path with one status and an empty body.
    struct Failing(u16);

    impl HttpGet for Failing {
        fn get(&self, _path_and_query: &str, _accept: &str) -> Result<HttpResponse> {
            Ok(HttpResponse {
                status: self.0,
                body: b"{}".to_vec(),
            })
        }
    }

    fn state_store_directory(name: &str) -> PathBuf {
        let path = std::env::temp_dir().join(format!(
            "zk-bridge-http-state-store-{name}-{}",
            std::process::id()
        ));
        let _ = std::fs::remove_dir_all(&path);
        path
    }

    /// An Ethereum state and its root, without a node.
    fn ethereum_state() -> (B256, Vec<u8>) {
        let slot = ethereum_slot_in(ForkName::Capella);
        let period = ETHEREUM_MAINNET.period_at_slot(slot);
        let current = committee_for(&ETHEREUM_MAINNET, period).committee.clone();
        let next = committee_for(&ETHEREUM_MAINNET, period + 1)
            .committee
            .clone();
        let bytes = StateBytes::new(ForkName::Capella, slot, current, next).to_ssz();
        (root_of(ChainKind::Ethereum, &bytes), bytes)
    }

    /// Claim: when the beacon node answers 500 for an old state, the prover reads it from the next state URL, and still
    /// demands the root from the header. A state URL that serves a wrong state is passed over for the next one.
    /// Why it matters: Lodestar keeps only recent states, so a proof from a head 30 minutes old failed on Sepolia.
    #[test]
    fn a_state_the_node_no_longer_serves_comes_from_the_next_state_url() {
        let (root, bytes) = ethereum_state();
        let path = format!("/eth/v2/debug/beacon/states/{root:#x}");
        let garbage = Node([(path.clone(), vec![1, 2, 3])].into_iter().collect());
        let (_, _, other) = head_with_state(ForkName::Deneb);
        assert_ne!(other.root(), root);
        let other_bytes = {
            let slot = ethereum_slot_in(ForkName::Capella) + 1;
            let period = ETHEREUM_MAINNET.period_at_slot(slot);
            let current = committee_for(&ETHEREUM_MAINNET, period).committee.clone();
            let next = committee_for(&ETHEREUM_MAINNET, period + 1)
                .committee
                .clone();
            StateBytes::new(ForkName::Capella, slot, current, next).to_ssz()
        };
        let wrong = Node([(path.clone(), other_bytes)].into_iter().collect());
        let right = Node([(path, bytes)].into_iter().collect());
        let source = source_over_node(ChainKind::Ethereum, Failing(500)).with_state_clients(vec![
            Box::new(garbage),
            Box::new(wrong),
            Box::new(right),
        ]);
        let state = source
            .state_for(root)
            .expect("the third state URL serves it");
        assert_eq!(state.root(), root);
    }

    /// Claim: with no state URL a failure is reported as before; with state URLs that all fail, the error names each.
    /// Why it matters: an operator must see which node failed and how.
    #[test]
    fn when_every_state_url_fails_the_error_names_each_failure() {
        let (root, _) = ethereum_state();
        let alone = source_over_node(ChainKind::Ethereum, Failing(500));
        let error = alone.state_for(root).err().expect("refused").to_string();
        assert!(error.contains("status 500"), "{error}");
        let with_urls = source_over_node(ChainKind::Ethereum, Failing(500))
            .with_state_clients(vec![Box::new(Failing(404)), Box::new(Failing(503))]);
        let error = with_urls
            .state_for(root)
            .err()
            .expect("refused")
            .to_string();
        assert!(
            error.contains("status 500")
                && error.contains("not served")
                && error.contains("status 503"),
            "{error}"
        );
    }

    /// Claim: a state the prover verified goes to the state store, and a later source reads it from there when no node
    /// serves it. A stored file that no longer verifies is removed and the node is asked instead.
    /// Why it matters: the next run proves from the head this run stored, whatever the public nodes still keep.
    #[test]
    fn a_verified_state_is_stored_and_read_back_when_no_node_serves_it() {
        let directory = state_store_directory("read-back");
        let store: Arc<dyn StateStore> = Arc::new(DirectoryStateStore::new(&directory, 1));
        let (root, bytes) = ethereum_state();
        let path = format!("/eth/v2/debug/beacon/states/{root:#x}");
        source_over_node(
            ChainKind::Ethereum,
            Node([(path.clone(), bytes.clone())].into_iter().collect()),
        )
        .with_state_store(store.clone())
        .state_for(root)
        .unwrap();

        let later =
            source_over_node(ChainKind::Ethereum, Failing(500)).with_state_store(store.clone());
        assert_eq!(later.state_for(root).unwrap().root(), root);

        store
            .put(
                root,
                1,
                &StoredState {
                    bytes: state_with_summaries(OLD_SLOT, summaries(2)),
                    appended_summary: None,
                },
            )
            .unwrap();
        let healed = source_over_node(
            ChainKind::Ethereum,
            Node([(path, bytes)].into_iter().collect()),
        )
        .with_state_store(store.clone());
        assert_eq!(healed.state_for(root).unwrap().root(), root);
        let stored = store
            .get(&root)
            .expect("the node's state replaced the bad file");
        assert_eq!(root_of(ChainKind::Ethereum, &stored.bytes), root);
        let _ = std::fs::remove_dir_all(directory);
    }

    /// Claim: a repaired PulseChain state is stored with its appended summary, and read back and repaired again without
    /// any node.
    /// Why it matters: the frozen states of PulseChain are served short forever; the store must keep the repair.
    #[test]
    fn a_repaired_state_is_stored_with_its_summary_and_read_back_without_a_node() {
        let directory = state_store_directory("repaired");
        let store: Arc<dyn StateStore> = Arc::new(DirectoryStateStore::new(&directory, 943));
        let chain = ChainKind::PulsechainTestnetV4;
        let old_root = root_of(chain, &state_with_summaries(OLD_SLOT, summaries(WHOLE)));
        let short = state_with_summaries(OLD_SLOT, summaries(WHOLE - 1));
        let (source, _, _) = frozen_state_node(chain, short, old_root, summaries(WHOLE));
        source
            .with_state_store(store.clone())
            .state_for(old_root)
            .unwrap();
        let stored = store.get(&old_root).expect("stored");
        assert_eq!(stored.appended_summary, summaries(WHOLE).last().copied());

        let later = source_over_node(chain, Failing(500)).with_state_store(store);
        assert_eq!(later.state_for(old_root).unwrap().root(), old_root);
        let _ = std::fs::remove_dir_all(directory);
    }
}

#[cfg(test)]
mod header_repair_tests {
    //! Tests of the repair of the finalized header (item 3), of the fork schedule over HTTP (item 2) and of the branch of
    //! `genesis_validators_root` (item 1). They use synthetic Sepolia updates from `lc-testkit`, because no served
    //! transition update is on file.

    use super::tests::{sepolia_fixtures, source_over_node, Node};
    use super::*;
    use crate::light_client::PADDED_EXECUTION_BRANCH_LENGTH;
    use alloy_primitives::{hex, keccak256};
    use lc_core::chain::{ChainSpec, ForkEntry, SEPOLIA};
    use lc_core::types::{HeaderForm, LightClientHeader};
    use lc_testkit::synthetic::{
        build_gloas_update, synthetic_compact_finalized_header, GloasUpdateScenario, UpdateRecipe,
    };
    use std::collections::HashMap;
    use std::sync::atomic::{AtomicUsize, Ordering};

    /// A Sepolia slot in the last Fulu epoch but one, and so before the Gloas fork (slot 11296768).
    const FULU_SLOT: u64 = 11_296_700;
    /// A Sepolia slot in the Capella era (epochs 56832 to 132607).
    const CAPELLA_SLOT: u64 = 2_000_000;

    /// A source over a Sepolia node that serves only the two configuration answers, with a counting execution source.
    fn repair_source(headers: Vec<Vec<u8>>) -> (HttpBeaconSource, Arc<AtomicUsize>) {
        let calls = Arc::new(AtomicUsize::new(0));
        let by_hash = headers
            .into_iter()
            .map(|rlp| (keccak256(&rlp), rlp))
            .collect();
        let source = source_over_node(ChainKind::Sepolia, Node(HashMap::new()))
            .with_execution_headers(Box::new(CountingHeaders {
                by_hash,
                calls: calls.clone(),
            }));
        (source, calls)
    }

    /// An execution source that gives the header of a known hash and counts every call.
    struct CountingHeaders {
        by_hash: HashMap<B256, Vec<u8>>,
        calls: Arc<AtomicUsize>,
    }

    impl ExecutionHeaders for CountingHeaders {
        fn raw_header(&self, hash: B256) -> Result<Vec<u8>> {
            self.calls.fetch_add(1, Ordering::SeqCst);
            self.by_hash
                .get(&hash)
                .cloned()
                .ok_or_else(|| Error::Malformed(format!("no header for {hash:#x}")))
        }
    }

    /// The form that a node serves for a header from before Gloas inside a Gloas update (`upgrade_lc_header_to_gloas`):
    /// the original branch padded at the front with zeros up to 11 entries, and no encoded execution header.
    fn served_padded_form(header: &LightClientHeader) -> LightClientHeader {
        let missing = PADDED_EXECUTION_BRANCH_LENGTH - header.execution_branch.len();
        let branch = [vec![B256::ZERO; missing], header.execution_branch.clone()].concat();
        LightClientHeader::compact(
            header.beacon,
            header.execution_block_hash(),
            branch,
            Vec::new(),
        )
    }

    /// An update whose finalized header is the given one, over a state that commits to the finalized beacon header root of
    /// the scenario. Only the branch, the encoding and the form of the header change, and none of them is part of the beacon
    /// header root, so the finality branch still holds.
    fn update_with_finalized(
        scenario: &GloasUpdateScenario,
        finalized: LightClientHeader,
    ) -> LightClientUpdate {
        LightClientUpdate {
            finalized_header: finalized,
            ..scenario.update.clone()
        }
    }

    fn schedule_of(source: &HttpBeaconSource) -> Arc<crate::fork_schedule::ForkSchedule> {
        source.fork_schedule().expect("the compiled table joins")
    }

    /// A Gloas-typed scenario on Sepolia whose finalized header is from before Gloas. The attested header is in the first
    /// Gloas epoch. (On Sepolia the fork falls on a period boundary, so such an update is not usable by any store; the tests
    /// below that need a usable fold use the split chain.)
    fn sepolia_transition_scenario() -> GloasUpdateScenario {
        build_gloas_update(
            &SEPOLIA,
            UpdateRecipe {
                store_slot: FULU_SLOT - 100,
                finalized_slot: FULU_SLOT,
                attested_slot: 11_296_800,
                signature_slot: 11_296_801,
                participants: 400,
                include_next_committee: false,
                store_knows_next_committee: false,
            },
        )
    }

    /// Claim: a Fulu header served padded (11 entries, 2 leading zeros) is repaired to the 9 entries of the original branch
    /// (4 body entries and 5 payload entries) with the encoded header attached, and the check of the program then reports
    /// the same block as the unpadded header does.
    /// Why it matters: the program reads a length of 11 as the state anchor (index 2947), so the padded form is refused. The
    /// repair is what makes a transition update usable. The data is synthetic, because no served transition update is on
    /// file. The index of the block hash in a Deneb to Fulu payload header is 812, which is a branch of 9 entries.
    #[test]
    fn the_specification_padded_header_is_stripped_to_the_deneb_anchor() {
        let original = synthetic_compact_finalized_header(&SEPOLIA, FULU_SLOT, 12_345_678);
        assert_eq!(
            original.execution_branch.len(),
            9,
            "the Fulu original has 9 entries"
        );
        let padded = served_padded_form(&original);
        assert_eq!(padded.execution_branch.len(), 11);
        assert_eq!(&padded.execution_branch[..2], &[B256::ZERO; 2]);
        assert_eq!(
            lc_core::update::verify_finalized_execution(&padded).unwrap_err(),
            lc_core::Error::InvalidExecutionBranch("finalized"),
            "control: the program refuses the padded form"
        );
        let (source, calls) = repair_source(vec![original.execution_header_rlp.clone()]);
        let scenario = sepolia_transition_scenario();
        let mut updates = [update_with_finalized(&scenario, padded)];
        source
            .repair_finalized_headers(&schedule_of(&source), &mut updates)
            .unwrap();
        let repaired = &updates[0].finalized_header;
        assert_eq!(repaired.execution_branch, original.execution_branch);
        assert_eq!(repaired.execution_header_rlp, original.execution_header_rlp);
        assert_eq!(
            lc_core::update::verify_finalized_execution(repaired).unwrap(),
            lc_core::update::verify_finalized_execution(&original).unwrap()
        );
        assert_eq!(calls.load(Ordering::SeqCst), 1);
    }

    /// Claim: a Capella header served padded (3 leading zeros) is repaired to 8 entries. Keeping 9 entries instead gives
    /// the exact refusal of the native check, `InvalidExecutionBranch("finalized")`.
    /// Why it matters: the number of entries to keep follows the fork name of the header slot. The Capella payload header has
    /// 15 fields, so its block hash is at index 412 (depth 4 in the payload, 8 entries). A prover that always kept 9 entries
    /// would break every transition update from a Capella chain.
    #[test]
    fn a_capella_padded_header_is_stripped_to_eight() {
        let original = synthetic_compact_finalized_header(&SEPOLIA, CAPELLA_SLOT, 777);
        assert_eq!(original.execution_branch.len(), 8);
        let padded = served_padded_form(&original);
        assert_eq!(&padded.execution_branch[..3], &[B256::ZERO; 3]);
        let (source, _) = repair_source(vec![original.execution_header_rlp.clone()]);
        let scenario = sepolia_transition_scenario();
        let mut updates = [update_with_finalized(&scenario, padded.clone())];
        source
            .repair_finalized_headers(&schedule_of(&source), &mut updates)
            .unwrap();
        assert_eq!(updates[0].finalized_header.execution_branch.len(), 8);
        lc_core::update::verify_finalized_execution(&updates[0].finalized_header).unwrap();
        assert_eq!(
            strip_transition_padding(&padded, 9, original.execution_header_rlp.clone())
                .unwrap_err(),
            Error::VerificationRefused(
                lc_core::Error::InvalidExecutionBranch("finalized").to_string()
            )
        );
    }

    /// Claim: a padding entry that is not zero (entry 0 or entry 1 of the Fulu padding), and a padded branch of 10 or 12
    /// entries, stop the prover with `HeaderFormMismatch` before any call to the execution source.
    /// Why it matters: the prover must not strip real data, and the rule is exactly 11 entries. A shorter or longer branch is
    /// not the form that the specification writes. The exact program check would also refuse a wrong branch, but the prover
    /// must stop first and spend no call on a header that cannot work.
    #[test]
    fn a_non_zero_padding_entry_or_another_length_stops_the_prover() {
        let original = synthetic_compact_finalized_header(&SEPOLIA, FULU_SLOT, 5);
        let padded = served_padded_form(&original);
        let mut cases = Vec::new();
        for index in [0, 1] {
            let mut branch = padded.execution_branch.clone();
            branch[index] = B256::repeat_byte(1);
            cases.push(branch);
        }
        cases.push([vec![B256::ZERO; 1], padded.execution_branch.clone()].concat());
        cases.push(padded.execution_branch[1..].to_vec());
        let (source, calls) = repair_source(vec![original.execution_header_rlp.clone()]);
        let scenario = sepolia_transition_scenario();
        for branch in cases {
            let length = branch.len();
            let header = LightClientHeader::compact(
                padded.beacon,
                padded.execution_block_hash(),
                branch,
                Vec::new(),
            );
            let mut updates = [update_with_finalized(&scenario, header)];
            let error = source
                .repair_finalized_headers(&schedule_of(&source), &mut updates)
                .unwrap_err();
            assert_eq!(
                error,
                Error::HeaderFormMismatch {
                    slot: FULU_SLOT,
                    fork: ForkName::Fulu,
                    form: HeaderForm::Compact,
                    branch_length: length,
                }
            );
        }
        assert_eq!(calls.load(Ordering::SeqCst), 0, "no call for the encoding");
    }

    /// Claim: a Gloas finalized header is never stripped, even when its first branch entry is zero in a copy. The program
    /// then refuses that copy. The strip is chosen by the fork name of the slot, not by the zeros.
    /// Why it matters: the 11 entry branch of a Gloas header is the real state anchor (index 2947). A prover that stripped
    /// leading zeros would damage a real branch whose first sibling is a zero hash.
    #[test]
    fn a_gloas_header_is_never_stripped() {
        let scenario = build_gloas_update(
            &SEPOLIA,
            UpdateRecipe {
                store_slot: 11_296_770,
                finalized_slot: 11_296_800,
                attested_slot: 11_296_900,
                signature_slot: 11_296_901,
                participants: 400,
                include_next_committee: false,
                store_knows_next_committee: false,
            },
        );
        let genuine = scenario.update.finalized_header.clone();
        assert_eq!(genuine.execution_branch.len(), 11);
        let hash = genuine.execution_block_hash();
        let rlp = genuine.execution_header_rlp.clone();
        let mut zeroed = genuine.clone();
        zeroed.execution_branch[0] = B256::ZERO;
        // The Gloas path needs the state of the finalized header, which the synthetic scenario does not serve. The plan
        // alone decides here: both copies are `GloasAnchor` and neither is a strip.
        for header in [&genuine, &zeroed] {
            assert_eq!(
                plan_header_repair(header, ForkName::Gloas).unwrap(),
                HeaderRepair::GloasAnchor
            );
        }
        // The control that the zero matters to the program: the zeroed copy fails the check.
        assert_eq!(hash, zeroed.execution_block_hash());
        assert_eq!(
            lc_core::update::verify_finalized_execution(&zeroed).unwrap_err(),
            lc_core::Error::InvalidExecutionBranch("finalized")
        );
        lc_core::update::verify_finalized_execution(&genuine).unwrap();
        assert_eq!(
            genuine.execution_header_rlp, rlp,
            "nothing touched the original"
        );
    }

    /// A Sepolia-like chain whose Gloas fork falls in the middle of a sync committee period, so that a transition update can
    /// be applied by a store. On real Sepolia the fork falls on the first slot of period 1379, which no store can use.
    static SPLIT_FORKS: [ForkEntry; 8] = [
        ForkEntry {
            epoch: 0,
            fork_version: [0x90, 0, 0, 0x69],
            fork_name: ForkName::Phase0,
        },
        ForkEntry {
            epoch: 50,
            fork_version: [0x90, 0, 0, 0x70],
            fork_name: ForkName::Altair,
        },
        ForkEntry {
            epoch: 100,
            fork_version: [0x90, 0, 0, 0x71],
            fork_name: ForkName::Bellatrix,
        },
        ForkEntry {
            epoch: 56_832,
            fork_version: [0x90, 0, 0, 0x72],
            fork_name: ForkName::Capella,
        },
        ForkEntry {
            epoch: 132_608,
            fork_version: [0x90, 0, 0, 0x73],
            fork_name: ForkName::Deneb,
        },
        ForkEntry {
            epoch: 222_464,
            fork_version: [0x90, 0, 0, 0x74],
            fork_name: ForkName::Electra,
        },
        ForkEntry {
            epoch: 272_640,
            fork_version: [0x90, 0, 0, 0x75],
            fork_name: ForkName::Fulu,
        },
        ForkEntry {
            epoch: 353_040,
            fork_version: [0x90, 0, 0, 0x76],
            fork_name: ForkName::Gloas,
        },
    ];
    static SPLIT_SPEC: ChainSpec = ChainSpec {
        name: "sepolia-split",
        fork_schedule: &SPLIT_FORKS,
        ..SEPOLIA
    };

    /// Claim: a transition fold on a chain whose Gloas fork is mid period verifies end to end. A store in the last Fulu
    /// epochs folds an update whose attested header is in the first Gloas epoch and whose finalized header is a Fulu header,
    /// served padded. The repair makes it pass; without the repair the program refuses it.
    /// Why it matters: this is the whole repair in one run, with a real BLS signature of the synthetic committee and the
    /// signing version from the fork schedule of the node. The fork schedule here is the split chain, not the table of Sepolia.
    #[test]
    fn a_transition_fold_from_fulu_to_gloas_verifies_end_to_end() {
        let scenario = build_gloas_update(
            &SPLIT_SPEC,
            UpdateRecipe {
                store_slot: 11_297_000,
                finalized_slot: 11_297_200,
                attested_slot: 11_297_300,
                signature_slot: 11_297_301,
                participants: 400,
                include_next_committee: false,
                store_knows_next_committee: false,
            },
        );
        let original = scenario.update.finalized_header.clone();
        assert_eq!(
            original.execution_branch.len(),
            9,
            "a Fulu header before the repair"
        );
        let padded = served_padded_form(&original);
        let (schedule_answer, specification) =
            crate::fork_schedule::answers_from_table(&SPLIT_SPEC);
        let schedule = crate::fork_schedule::ForkSchedule::from_answers(
            &schedule_answer,
            &specification,
            SPLIT_SPEC.slots_per_epoch,
        )
        .unwrap();
        let (source, _) = repair_source(vec![original.execution_header_rlp.clone()]);
        let fold = |update: LightClientUpdate| {
            lc_core::update::verify_light_client_fold_with_fork_versions(
                &scenario.store,
                &[lc_core::update::FoldStep {
                    fork_version: schedule.signing_version(update.signature_slot),
                    update,
                }],
                &SPLIT_SPEC,
            )
        };
        assert_eq!(
            fold(update_with_finalized(&scenario, padded.clone())).unwrap_err(),
            lc_core::Error::InvalidExecutionBranch("finalized"),
            "control: the served form is refused"
        );
        let mut updates = [update_with_finalized(&scenario, padded)];
        source
            .repair_finalized_headers(&schedule, &mut updates)
            .unwrap();
        let [repaired] = updates;
        let output = fold(repaired).expect("the repaired transition fold verifies");
        assert_eq!(output.executionBlockHash, original.execution_block_hash());
        assert_eq!(output.newHeadSlot, 11_297_200);
    }

    /// Claim: the attested header of a transition update stays as served. Only the finalized header is repaired.
    /// Why it matters: the program does not read the execution data of the attested header, and a repair there would be
    /// work with no use and a new place for a mistake.
    #[test]
    fn the_attested_header_of_a_transition_update_is_left_alone() {
        let scenario = sepolia_transition_scenario();
        let original = synthetic_compact_finalized_header(&SEPOLIA, FULU_SLOT, 99);
        let padded_attested = served_padded_form(&original);
        let (source, _) = repair_source(vec![original.execution_header_rlp.clone()]);
        let mut updates = [LightClientUpdate {
            attested_header: padded_attested.clone(),
            finalized_header: served_padded_form(&original),
            ..scenario.update.clone()
        }];
        source
            .repair_finalized_headers(&schedule_of(&source), &mut updates)
            .unwrap();
        assert_eq!(updates[0].attested_header, padded_attested);
        assert_eq!(updates[0].attested_header.execution_branch.len(), 11);
        assert_eq!(updates[0].finalized_header.execution_branch.len(), 9);
    }

    /// A scripted execution node: `debug_getRawHeader` answers with `raw` (or an error object), and `eth_getBlockByHash`
    /// answers with `block`.
    struct ScriptedExecutionNode {
        raw: std::result::Result<serde_json::Value, ()>,
        block: serde_json::Value,
    }

    impl JsonRpc for ScriptedExecutionNode {
        fn call(&self, method: &str, _params: serde_json::Value) -> Result<serde_json::Value> {
            match method {
                "debug_getRawHeader" => self.raw.clone().map_err(|()| Error::Rpc {
                    code: -32601,
                    message: "the method debug_getRawHeader does not exist".into(),
                    data: None,
                }),
                "eth_getBlockByHash" => Ok(self.block.clone()),
                other => panic!("unexpected call {other}"),
            }
        }
    }

    /// A real execution block of the fixtures: its JSON, and the encoding that the rebuilder makes of it.
    fn fixture_block() -> (serde_json::Value, B256, Vec<u8>) {
        let path = sepolia_fixtures().join("../ethereum/execution_block.json");
        let wrapper: serde_json::Value =
            serde_json::from_slice(&std::fs::read(path).unwrap()).unwrap();
        let block = wrapper["response"].clone();
        let rebuilt = rebuild_execution_header(&block).expect("the fixture block rebuilds");
        (block, rebuilt.block_hash, rebuilt.header_rlp.to_vec())
    }

    /// Claim: the raw header answer is checked by keccak. A node that answers the encoding of another block gives
    /// `Error::Malformed`, and does not take the fallback. A node that answers the right encoding is believed.
    /// Why it matters: this is the only guard in the prover against a lying execution node on the update path. The program
    /// would refuse such a header later, but at the cost of a proof run, so only this test sees a missing check in the prover.
    /// The error is `Malformed` on every path that reads a raw header (see `checked_raw_header`).
    #[test]
    fn the_raw_header_answer_is_checked_by_keccak() {
        let (block, hash, rlp) = fixture_block();
        let honest = RpcExecutionHeaders::new(Box::new(ScriptedExecutionNode {
            raw: Ok(serde_json::json!(format!("0x{}", hex::encode(&rlp)))),
            block: block.clone(),
        }));
        assert_eq!(honest.raw_header(hash).unwrap(), rlp);
        let mut other = rlp.clone();
        *other.last_mut().unwrap() ^= 1;
        let liar = RpcExecutionHeaders::new(Box::new(ScriptedExecutionNode {
            raw: Ok(serde_json::json!(format!("0x{}", hex::encode(&other)))),
            block,
        }));
        let error = liar.raw_header(hash).unwrap_err();
        assert!(
            matches!(&error, Error::Malformed(text) if text.contains("does not hash to")),
            "{error}"
        );
    }

    /// Claim: when `debug_getRawHeader` answers with an error object ("method not found"), the encoding is rebuilt from
    /// `eth_getBlockByHash`, hashes to the block hash and is returned. A block answer with one changed field gives
    /// `Error::Malformed` (the rebuilt encoding does not hash to the reported hash).
    /// Why it matters: many execution nodes do not serve the debug method. Without the fallback the update path would stop
    /// on them, although the opening path already works there.
    #[test]
    fn the_rebuild_fallback_is_used_when_the_raw_header_call_fails() {
        let (block, hash, rlp) = fixture_block();
        let rebuilt = RpcExecutionHeaders::new(Box::new(ScriptedExecutionNode {
            raw: Err(()),
            block: block.clone(),
        }));
        assert_eq!(rebuilt.raw_header(hash).unwrap(), rlp);
        let mut changed = block;
        changed["gasUsed"] = serde_json::json!("0x1234567");
        let tampered = RpcExecutionHeaders::new(Box::new(ScriptedExecutionNode {
            raw: Err(()),
            block: changed,
        }));
        assert!(matches!(
            tampered.raw_header(hash),
            Err(Error::Malformed(_))
        ));
    }

    /// Claim: the repair of a finalized header follows the fork name of its slot, and the form of the answer must agree with
    /// it. A real Gloas answer (compact, 11 entries) under the Gloas name needs the anchor. A real Fulu answer (full form)
    /// under the Fulu name needs nothing. A full answer under the Gloas name, and a compact answer without padding under the
    /// Fulu name, give `HeaderFormMismatch`.
    /// Why it matters: a repair that looked at the form alone would anchor a header through the wrong state, or strip a
    /// header that is not padded. The fork name is the authority, and the form is the cross check.
    #[test]
    fn the_gloas_anchor_follows_the_fork_name_and_the_answer_form_must_agree() {
        let read = |path: std::path::PathBuf| -> LightClientUpdate {
            let wrapper: serde_json::Value =
                serde_json::from_slice(&std::fs::read(path).unwrap()).unwrap();
            update_from_json(&wrapper["response"]["data"]).unwrap()
        };
        let gloas = read(sepolia_fixtures().join("gloas_head_finality_update.json"));
        let fulu = read(sepolia_fixtures().join("../ethereum/finality_update.json"));
        assert_eq!(gloas.finalized_header.form, HeaderForm::Compact);
        assert_eq!(fulu.finalized_header.form, HeaderForm::Full);
        assert_eq!(
            plan_header_repair(&gloas.finalized_header, ForkName::Gloas).unwrap(),
            HeaderRepair::GloasAnchor
        );
        assert_eq!(
            plan_header_repair(&fulu.finalized_header, ForkName::Fulu).unwrap(),
            HeaderRepair::Untouched
        );
        assert_eq!(
            plan_header_repair(&fulu.finalized_header, ForkName::Gloas).unwrap_err(),
            Error::HeaderFormMismatch {
                slot: fulu.finalized_header.beacon.slot,
                fork: ForkName::Gloas,
                form: HeaderForm::Full,
                branch_length: fulu.finalized_header.execution_branch.len(),
            }
        );
        let unpadded = synthetic_compact_finalized_header(&SEPOLIA, FULU_SLOT, 4);
        assert_eq!(
            plan_header_repair(&unpadded, ForkName::Fulu).unwrap_err(),
            Error::HeaderFormMismatch {
                slot: FULU_SLOT,
                fork: ForkName::Fulu,
                form: HeaderForm::Compact,
                branch_length: 9,
            }
        );
    }

    /// Claim: a node without the two configuration answers stops the prover with `Error::Beacon` that names the missing
    /// path. There is no fallback to the compiled table.
    /// Why it matters: a silent fallback would bring the fork table back into the decision, and a wrong table would pass for
    /// a right one.
    #[test]
    fn missing_config_endpoints_stop_the_prover() {
        let silent = HttpBeaconSource::new(ChainKind::Sepolia, Box::new(Node(HashMap::new())));
        assert!(matches!(
            silent.fork_schedule(),
            Err(Error::Beacon(text)) if text.contains(FORK_SCHEDULE_PATH)
        ));
        let (schedule, _) = crate::fork_schedule::answers_from_table(&SEPOLIA);
        let half = HttpBeaconSource::new(
            ChainKind::Sepolia,
            Box::new(Node(HashMap::from([(
                FORK_SCHEDULE_PATH.to_string(),
                schedule.to_string().into_bytes(),
            )]))),
        );
        assert!(matches!(
            half.fork_schedule(),
            Err(Error::Beacon(text)) if text.contains(CHAIN_SPEC_PATH)
        ));
        assert!(source_over_node(ChainKind::Sepolia, Node(HashMap::new()))
            .fork_schedule()
            .is_ok());
    }

    /// Claim: the branch of `genesis_validators_root` that the prover builds from a REAL Gloas state (the Sepolia head state
    /// of the fixtures) has 5 entries and proves the genesis validators root of Sepolia at generalized index 40.
    /// Why it matters: the prover and the program must agree on the position. A wrong position would make every update
    /// fail the check of the program. The PulseChain half of the claim (the assembled update verifies natively) is the test
    /// `assembled_update_from_real_pulsechain_data_verifies`.
    #[test]
    fn the_prover_builds_the_genesis_validators_root_branch_from_the_attested_state() {
        let bytes = std::fs::read(sepolia_fixtures().join("gloas_head_state.ssz")).unwrap();
        let state = StateView::parse(&bytes, ChainKind::Sepolia).unwrap();
        let branch = state.genesis_validators_root_branch();
        assert_eq!(branch.len(), 5);
        assert!(lc_core::ssz::is_valid_exact_branch(
            &SEPOLIA.genesis_validators_root,
            &branch,
            40,
            &state.root()
        ));
        let wrong_leaf = B256::repeat_byte(7);
        assert!(!lc_core::ssz::is_valid_exact_branch(
            &wrong_leaf,
            &branch,
            40,
            &state.root()
        ));
        assert!(!lc_core::ssz::is_valid_exact_branch(
            &SEPOLIA.genesis_validators_root,
            &branch,
            33,
            &state.root()
        ));
    }

    /// Claim: over HTTP, the version of a PulseChain step comes from Capella and never from the placeholder of the unscheduled
    /// Deneb fork.
    /// Why it matters: the placeholder version is `0xffffffff`. If it ever reached a step, the signature check would fail.
    #[test]
    fn the_version_of_a_pulsechain_step_is_capella_not_the_placeholder() {
        let source = source_over_node(ChainKind::Pulsechain, Node(HashMap::new()));
        let schedule = source.fork_schedule().unwrap();
        let slot = 50_000_000;
        assert_eq!(schedule.signing_version(slot), [0, 0, 0x03, 0x6c]);
        assert_ne!(schedule.signing_version(slot), [0xff; 4]);
    }

    // ---------------------------------------------------------------- a handoff from a head without the next committee

    /// A light client whose head sits late in period P and which does not store the committee of P + 1, read over the
    /// standard beacon API of a signed synthetic chain (real BLS signatures, real states). The node can serve a stale best
    /// update of P (one that finalizes a header before the head), serve none, and serve or not serve the finality update.
    #[cfg(feature = "signed-beacon")]
    mod handoff_without_next_committee {
        use super::*;
        use crate::light_client::verify_update_natively;
        use crate::local_network::signed_beacon::api::answer;
        use crate::local_network::signed_beacon::chain::test_support::{
            chain_of, first_slot_before_period_end, settings,
        };
        use crate::local_network::signed_beacon::chain::SyntheticBeaconChain;
        use crate::rpc::HttpResponse;
        use lc_testkit::json::light_client_update_json;
        use lc_testkit::synthetic::committee_for;

        const KIND: ChainKind = ChainKind::PulsechainTestnetV4;
        /// The period of the live case: the head of the light client on Sepolia is in 1368.
        const PERIOD: u64 = 1368;
        /// The chain starts this many blocks before the end of PERIOD.
        const BEFORE_END: u64 = 40;

        /// What the node answers for `light_client/updates`.
        enum UpdatesRoute {
            /// 404, as the PulseChain g4mm4 node answers.
            NotServed,
            /// The update signed at this slot, for PERIOD: a best update that the node chose earlier in the period.
            BestSignedAt(u64),
        }

        struct ScriptedNode {
            chain: SyntheticBeaconChain,
            updates: UpdatesRoute,
            finality_update_served: bool,
        }

        impl HttpGet for ScriptedNode {
            fn get(&self, path_and_query: &str, accept: &str) -> Result<HttpResponse> {
                let missing = || HttpResponse {
                    status: 404,
                    body: b"{}".to_vec(),
                };
                if path_and_query.starts_with("/eth/v1/beacon/light_client/updates") {
                    return Ok(match self.updates {
                        UpdatesRoute::NotServed => missing(),
                        UpdatesRoute::BestSignedAt(slot) => {
                            let update = self.chain.handoff_update_signed_at(slot)?;
                            HttpResponse {
                                status: 200,
                                body: serde_json::json!([{ "data": light_client_update_json(&update) }])
                                    .to_string()
                                    .into_bytes(),
                            }
                        }
                    });
                }
                if path_and_query == "/eth/v1/beacon/light_client/finality_update"
                    && !self.finality_update_served
                {
                    return Ok(missing());
                }
                let served = answer(&self.chain, path_and_query, accept);
                Ok(HttpResponse {
                    status: served.status,
                    body: served.body,
                })
            }
        }

        fn first_slot() -> u64 {
            first_slot_before_period_end(KIND, PERIOD, BEFORE_END)
        }

        /// The first slot of PERIOD + 1.
        fn border() -> u64 {
            first_slot() + BEFORE_END
        }

        /// A source over a chain of `blocks` blocks, and the stored head at `head_slot` with no next committee.
        fn world(
            blocks: u64,
            head_slot: u64,
            updates: UpdatesRoute,
            finality_update_served: bool,
        ) -> (HttpBeaconSource, StoredHead) {
            let chain = chain_of(settings(KIND, first_slot()), blocks);
            let head = StoredHead {
                slot: head_slot,
                root: chain
                    .header_root_at(head_slot)
                    .expect("the head is on the chain"),
                next_committee_hash: B256::ZERO,
            };
            let node = ScriptedNode {
                chain,
                updates,
                finality_update_served,
            };
            (source_over_node(KIND, node), head)
        }

        fn kind_committee_hash(period: u64) -> B256 {
            committee_hash(&committee_for(KIND.spec(), period).committee).unwrap()
        }

        /// Claim: the live case of 2026-11-01. The head is late in period 1368 and the light client stores no committee
        /// for 1369; the node serves, for 1368, a best update that finalizes a header before the head; finality has crossed
        /// into 1369. The plan holds a step that finalizes a header after the head, inside 1368, signed in 1368, and proves
        /// the committee of 1369; then the newest update. The program accepts it and the head lands in 1369.
        /// Why it matters: the source dropped the stale best update (it does not move the head) and sent the newest update
        /// alone. The program refused it with "the store does not know the next sync committee", and the light client was
        /// stranded at its period border.
        #[test]
        fn a_head_late_in_the_period_is_handed_off_when_the_best_update_is_stale() {
            let head_slot = first_slot() + 10;
            let (source, head) = world(
                BEFORE_END + 20,
                head_slot,
                UpdatesRoute::BestSignedAt(head_slot + 2),
                true,
            );
            let plan = source
                .plan_update(&head)
                .unwrap()
                .expect("finality moved past the head");
            // The control: the newest update alone, as the source sent it on 2026-11-01, is refused as it was then.
            let alone = UpdateInput {
                chain: KIND,
                store: plan.input.store.clone(),
                steps: plan.input.steps.last().cloned().into_iter().collect(),
            };
            let refused = verify_update_natively(&alone).unwrap_err().to_string();
            assert!(
                refused.contains("does not know the next sync committee"),
                "{refused}"
            );
            let steps = &plan.input.steps;
            assert_eq!(
                steps.len(),
                2,
                "a step inside {PERIOD}, then the newest update"
            );
            let first = &steps[0].update;
            assert!(
                first.finalized_header.beacon.slot > head_slot,
                "the first step moves the head"
            );
            assert!(
                first.signature_slot < border(),
                "the first step is signed in {PERIOD}"
            );
            assert!(
                first.next_sync_committee.is_some(),
                "the first step proves the next committee"
            );
            let output = verify_update_natively(&plan.input).expect("the fold verifies natively");
            assert_eq!(output.previousHeadSlot, head_slot);
            assert_eq!(output.startNextSyncCommitteeHash, B256::ZERO);
            assert_eq!(output.newHeadSlot, plan.latest_finalized_slot);
            assert_eq!(KIND.spec().period_at_slot(output.newHeadSlot), PERIOD + 1);
            assert_eq!(output.syncCommitteeHash, kind_committee_hash(PERIOD + 1));
        }

        /// Claim: the same handoff on a node that serves no light-client routes (the PulseChain g4mm4 node): the source
        /// builds the step inside the head period from blocks and states, and the program accepts the fold.
        /// Why it matters: without it, such a node strands every light client that reaches a period border without the next
        /// committee ("no light-client update for sync committee period 1368").
        #[test]
        fn a_head_late_in_the_period_is_handed_off_by_a_node_without_light_client_routes() {
            let head_slot = first_slot() + 10;
            let (source, head) = world(BEFORE_END + 20, head_slot, UpdatesRoute::NotServed, false);
            let plan = source
                .plan_update(&head)
                .unwrap()
                .expect("finality moved past the head");
            assert_eq!(plan.input.steps.len(), 2);
            let output = verify_update_natively(&plan.input).expect("the fold verifies natively");
            assert_eq!(KIND.spec().period_at_slot(output.newHeadSlot), PERIOD + 1);
            assert_eq!(output.syncCommitteeHash, kind_committee_hash(PERIOD + 1));
        }

        /// Claim: a head so close to the end of its period that no update signed in the period finalizes a later header
        /// gives an error that names the period, the slots and the cause, before any proof runs.
        /// Why it matters: the program would refuse such a fold; the operator must learn that this light client cannot be
        /// handed off by the source, not see a verifier error.
        #[test]
        fn a_head_at_the_very_end_of_the_period_is_refused_with_the_cause() {
            let head_slot = first_slot() + BEFORE_END - 2;
            let (source, head) = world(BEFORE_END + 20, head_slot, UpdatesRoute::NotServed, false);
            let error = source.plan_update(&head).unwrap_err().to_string();
            assert!(error.contains(&format!("period {PERIOD}")), "{error}");
            assert!(
                error.contains("does not move the light client head"),
                "{error}"
            );
        }

        /// Claim: an update inside the head period, from a node whose finality update carries no next committee, gets the
        /// next committee from its attested state, so the output names it and the contract stores it.
        /// Why it matters: the 47 keep-alive proofs of 2026-10-31 each moved the head inside 1368 with a finality update,
        /// which never carries a next committee. Each output had a zero nextSyncCommitteeHash, the contract stored nothing,
        /// and the light client reached the border of 1369 without the committee that signs there.
        #[test]
        fn an_update_inside_the_head_period_proves_the_next_committee() {
            let head_slot = first_slot() + 10;
            let (source, head) = world(BEFORE_END - 5, head_slot, UpdatesRoute::NotServed, true);
            let plan = source
                .plan_update(&head)
                .unwrap()
                .expect("finality moved past the head");
            assert_eq!(plan.input.steps.len(), 1);
            let output = verify_update_natively(&plan.input).expect("the update verifies natively");
            assert_eq!(KIND.spec().period_at_slot(output.newHeadSlot), PERIOD);
            assert_eq!(
                output.nextSyncCommitteeHash,
                kind_committee_hash(PERIOD + 1)
            );
        }
    }
}
