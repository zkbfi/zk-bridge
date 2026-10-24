//! The server of the synthetic beacon chain: it follows an execution chain, extends the chain with each new block, and
//! answers the beacon API over HTTP.
//!
//! The node reads the execution chain through [`BlockFeed`]. It does no background work. Before it answers a request, it
//! asks the feed for the latest block number and adds the blocks it has not seen. So an answer always covers the newest
//! block, and a request cannot see a half-built chain (one lock guards the chain).
//!
//! The first block fixes the genesis time: block 1 sits in `first_slot`, so genesis is `timestamp - first_slot * seconds
//! per slot`. A restart reads the same block and gets the same genesis time.

use super::api::{answer, Answer};
use super::chain::{ChainSettings, SyntheticBeaconChain};
use crate::error::{Error, Result};
use crate::light_client::ChainKind;
use crate::rpc::{parse_quantity, quantity, HttpGet, HttpResponse, JsonRpc};
use alloy_primitives::{hex, Address, B256, U256};
use lc_testkit::block_bytes::PayloadFields;
use serde_json::{json, Value};
use std::str::FromStr;
use std::sync::{Arc, Mutex};

/// Where the node reads execution blocks from.
pub trait BlockFeed: Send + Sync {
    /// The number of the newest block.
    ///
    /// # Errors
    /// Any transport error.
    fn latest_number(&self) -> Result<u64>;

    /// The fields of block `number` that the beacon payload carries.
    ///
    /// # Errors
    /// `Error::Malformed` when the block is unknown or lacks a field.
    fn payload(&self, number: u64) -> Result<PayloadFields>;
}

fn text_of<'a>(block: &'a Value, field: &str) -> Result<&'a str> {
    block[field]
        .as_str()
        .ok_or_else(|| Error::Malformed(format!("block field {field}")))
}

fn hash_of(block: &Value, field: &str) -> Result<B256> {
    B256::from_str(text_of(block, field)?)
        .map_err(|error| Error::Malformed(format!("block field {field}: {error}")))
}

fn bytes_of(block: &Value, field: &str) -> Result<Vec<u8>> {
    hex::decode(text_of(block, field)?)
        .map_err(|error| Error::Malformed(format!("block field {field}: {error}")))
}

/// The payload fields of an `eth_getBlockByNumber` answer.
///
/// # Errors
/// `Error::Malformed` for a missing or malformed field.
pub fn payload_from_json(block: &Value) -> Result<PayloadFields> {
    let base_fee = match block["baseFeePerGas"].as_str() {
        None => U256::ZERO,
        Some(text) => U256::from_str_radix(text.trim_start_matches("0x"), 16)
            .map_err(|error| Error::Malformed(format!("block field baseFeePerGas: {error}")))?,
    };
    Ok(PayloadFields {
        parent_hash: hash_of(block, "parentHash")?,
        fee_recipient: Address::from_str(text_of(block, "miner")?)
            .map_err(|error| Error::Malformed(format!("block field miner: {error}")))?,
        state_root: hash_of(block, "stateRoot")?,
        receipts_root: hash_of(block, "receiptsRoot")?,
        logs_bloom: bytes_of(block, "logsBloom")?,
        prev_randao: hash_of(block, "mixHash")?,
        block_number: parse_quantity(&block["number"])?,
        gas_limit: parse_quantity(&block["gasLimit"])?,
        gas_used: parse_quantity(&block["gasUsed"])?,
        timestamp: parse_quantity(&block["timestamp"])?,
        extra_data: bytes_of(block, "extraData")?,
        base_fee_per_gas: base_fee,
        block_hash: hash_of(block, "hash")?,
    })
}

/// A [`BlockFeed`] over the JSON-RPC of an execution node.
pub struct RpcBlockFeed {
    rpc: Box<dyn JsonRpc>,
}

impl RpcBlockFeed {
    /// A feed over a JSON-RPC client.
    pub fn new(rpc: Box<dyn JsonRpc>) -> Self {
        Self { rpc }
    }
}

impl BlockFeed for RpcBlockFeed {
    fn latest_number(&self) -> Result<u64> {
        parse_quantity(&self.rpc.call("eth_blockNumber", json!([]))?)
    }

    fn payload(&self, number: u64) -> Result<PayloadFields> {
        let block = self
            .rpc
            .call("eth_getBlockByNumber", json!([quantity(number), false]))?;
        if block.is_null() {
            return Err(Error::Malformed(format!("block {number} is unknown")));
        }
        payload_from_json(&block)
    }
}

/// The slot of execution block 1 when the command line gives none: 64 slots into a sync committee period that lies deep in
/// the Capella fork of the chain (Ethereum period 760, PulseChain period 1326). The run then stays far from the period border
/// for about 8,000 blocks.
pub fn default_first_slot(kind: ChainKind) -> u64 {
    let period = match kind {
        ChainKind::Ethereum => 760,
        ChainKind::Pulsechain => 1326,
    };
    period * kind.spec().epochs_per_sync_committee_period * kind.spec().slots_per_epoch + 64
}

/// What a node needs to know about the chain it builds. The genesis time comes from the first block.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct NodeSettings {
    /// The chain specification.
    pub kind: ChainKind,
    /// The slot of execution block 1.
    pub first_slot: u64,
    /// The distance between the attested and the finalized header, in slots.
    pub finality_slots: u64,
    /// How many committee members sign each block.
    pub participants: usize,
}

/// One synthetic beacon node.
pub struct BeaconNode {
    feed: Box<dyn BlockFeed>,
    settings: NodeSettings,
    chain: Mutex<Option<SyntheticBeaconChain>>,
}

impl BeaconNode {
    /// A node that has read no block yet.
    pub fn new(feed: Box<dyn BlockFeed>, settings: NodeSettings) -> Self {
        Self {
            feed,
            settings,
            chain: Mutex::new(None),
        }
    }

    /// Creates the chain from block 1 when it does not exist yet.
    fn create_chain(&self) -> Result<SyntheticBeaconChain> {
        let first = self.feed.payload(1)?;
        let seconds = self.settings.kind.seconds_per_slot();
        let genesis_time = first
            .timestamp
            .checked_sub(self.settings.first_slot * seconds)
            .ok_or_else(|| {
                Error::Config(format!(
                    "block 1 has timestamp {}, before the start of slot {}",
                    first.timestamp, self.settings.first_slot
                ))
            })?;
        SyntheticBeaconChain::new(ChainSettings {
            kind: self.settings.kind,
            genesis_time,
            first_slot: self.settings.first_slot,
            finality_slots: self.settings.finality_slots,
            participants: self.settings.participants,
        })
    }

    /// Adds the blocks that the chain has not seen. With nothing new, it checks that the newest known block is still the
    /// block of the feed.
    fn catch_up(&self, chain: &mut SyntheticBeaconChain) -> Result<()> {
        let latest = self.feed.latest_number()?;
        let next = chain.next_block_number();
        for number in next..=latest {
            chain.extend(self.feed.payload(number)?)?;
        }
        if next <= latest {
            return Ok(());
        }
        let Some((number, hash)) = chain.tip_execution_block() else {
            return Ok(());
        };
        let current = self.feed.payload(number)?;
        if current.block_hash != hash {
            return Err(Error::Beacon(format!(
                "block {number} of the execution chain changed: the chain was reset or reorganized, so the synthetic beacon chain is stale. Restart the beacon node."
            )));
        }
        Ok(())
    }

    /// Runs `work` on the chain after it has caught up with the execution chain.
    ///
    /// # Errors
    /// The errors of the feed and of the chain, and `Error::Beacon` while the execution chain has no block.
    pub fn with_chain<T>(
        &self,
        work: impl FnOnce(&SyntheticBeaconChain) -> Result<T>,
    ) -> Result<T> {
        let mut guard = self
            .chain
            .lock()
            .map_err(|_| Error::Beacon("the chain lock is poisoned".into()))?;
        if guard.is_none() {
            if self.feed.latest_number()? == 0 {
                return Err(Error::Beacon("the execution chain has no block yet".into()));
            }
            *guard = Some(self.create_chain()?);
        }
        let Some(chain) = guard.as_mut() else {
            return Err(Error::Beacon("the chain is missing".into()));
        };
        self.catch_up(chain)?;
        work(chain)
    }

    /// Answers one request.
    pub fn answer(&self, target: &str, accept: &str) -> Answer {
        self.with_chain(|chain| Ok(answer(chain, target, accept)))
            .unwrap_or_else(|error| Answer::unavailable(&error))
    }
}

/// The adapter that lets `HttpBeaconSource` and the checkpoint tool read a node in memory, without a socket.
impl HttpGet for Arc<BeaconNode> {
    fn get(&self, path_and_query: &str, accept: &str) -> Result<HttpResponse> {
        let answer = self.answer(path_and_query, accept);
        Ok(HttpResponse {
            status: answer.status,
            body: answer.body,
        })
    }
}

/// One chain that the server answers for, under the path prefix `/<prefix>`.
pub struct Mount {
    /// The first path segment, for example `a`.
    pub prefix: String,
    /// The node.
    pub node: Arc<BeaconNode>,
}

/// Splits `/a/eth/v1/...` into the node that owns the prefix and the rest of the path.
fn route<'a>(mounts: &'a [Mount], target: &'a str) -> Option<(&'a Arc<BeaconNode>, &'a str)> {
    let rest = target.strip_prefix('/')?;
    let (prefix, _) = rest.split_once('/')?;
    let mount = mounts.iter().find(|mount| mount.prefix == prefix)?;
    let tail = &target[prefix.len() + 1..];
    Some((&mount.node, tail))
}

fn accept_of(request: &tiny_http::Request) -> String {
    request
        .headers()
        .iter()
        .find(|header| header.field.equiv("Accept"))
        .map(|header| header.value.as_str().to_string())
        .unwrap_or_default()
}

fn respond(mounts: &[Mount], request: tiny_http::Request) {
    let target = request.url().to_string();
    let accept = accept_of(&request);
    let answer = match route(mounts, &target) {
        Some((node, tail)) => node.answer(tail, &accept),
        None => Answer::missing("unknown chain prefix"),
    };
    let mut response = tiny_http::Response::from_data(answer.body).with_status_code(answer.status);
    if let Ok(header) = tiny_http::Header::from_bytes("Content-Type", answer.content_type) {
        response = response.with_header(header);
    }
    let _ = request.respond(response);
}

/// Serves until the process stops. Each request gets its own thread.
///
/// # Errors
/// `Error::Config` when the address cannot be bound.
pub fn serve(listen: &str, mounts: Vec<Mount>) -> Result<()> {
    let server = tiny_http::Server::http(listen).map_err(|error| {
        Error::Config(format!("signed beacon: cannot listen on {listen}: {error}"))
    })?;
    let mounts = Arc::new(mounts);
    for request in server.incoming_requests() {
        let mounts = Arc::clone(&mounts);
        std::thread::spawn(move || respond(&mounts, request));
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::super::chain::test_support::{first_slot_of, payload, settings};
    use super::*;
    use crate::light_client::ChainKind;

    /// A feed over a list of payloads that a test can extend, shrink or change.
    struct ListFeed(Mutex<Vec<PayloadFields>>);

    impl ListFeed {
        fn shared() -> Arc<Self> {
            Arc::new(Self(Mutex::new(Vec::new())))
        }
    }

    impl BlockFeed for Arc<ListFeed> {
        fn latest_number(&self) -> Result<u64> {
            Ok(self.0.lock().unwrap().len() as u64)
        }

        fn payload(&self, number: u64) -> Result<PayloadFields> {
            let list = self.0.lock().unwrap();
            list.get(number as usize - 1)
                .cloned()
                .ok_or_else(|| Error::Malformed(format!("block {number} is unknown")))
        }
    }

    fn node_settings(kind: ChainKind) -> NodeSettings {
        let chain = settings(kind, first_slot_of(kind));
        NodeSettings {
            kind,
            first_slot: chain.first_slot,
            finality_slots: chain.finality_slots,
            participants: chain.participants,
        }
    }

    /// Adds the next block, on the slot grid of a genesis time that block 1 fixes.
    fn mine(feed: &ListFeed, node: NodeSettings, genesis_time: u64) {
        let mut list = feed.0.lock().unwrap();
        let reference = SyntheticBeaconChain::new(ChainSettings {
            kind: node.kind,
            genesis_time,
            first_slot: node.first_slot,
            finality_slots: node.finality_slots,
            participants: node.participants,
        })
        .unwrap();
        let number = list.len() as u64 + 1;
        let mut next = payload(&reference);
        next.block_number = number;
        next.block_hash = alloy_primitives::keccak256(format!("anvil block {number}"));
        next.timestamp = reference.slot_start_time(node.first_slot + number - 1);
        list.push(next);
    }

    const GENESIS_TIME: u64 = 1_700_000_000;

    /// Claim: the node answers 503 while the execution chain has no block, builds the chain from block 1 on the first
    /// request, takes its genesis time from that block, and adds each new block before it answers the next request.
    /// Why it matters: the deploy step starts the node before the chains hold many blocks, and the prover asks at once.
    #[test]
    fn the_node_follows_the_execution_chain() {
        let kind = ChainKind::Pulsechain;
        let settings = node_settings(kind);
        let feed = ListFeed::shared();
        let node = BeaconNode::new(Box::new(feed.clone()), settings);
        assert_eq!(
            node.answer("/eth/v1/beacon/genesis", "application/json")
                .status,
            503
        );

        for _ in 0..4 {
            mine(&feed, settings, GENESIS_TIME);
        }
        let genesis = node.answer("/eth/v1/beacon/genesis", "application/json");
        assert_eq!(genesis.status, 200);
        let genesis: Value = serde_json::from_slice(&genesis.body).unwrap();
        assert_eq!(genesis["data"]["genesis_time"], GENESIS_TIME.to_string());
        let head = |node: &BeaconNode| -> Value {
            serde_json::from_slice(
                &node
                    .answer("/eth/v1/beacon/headers/head", "application/json")
                    .body,
            )
            .unwrap()
        };
        assert_eq!(
            head(&node)["data"]["header"]["message"]["slot"],
            (settings.first_slot + 3).to_string()
        );

        mine(&feed, settings, GENESIS_TIME);
        mine(&feed, settings, GENESIS_TIME);
        assert_eq!(
            head(&node)["data"]["header"]["message"]["slot"],
            (settings.first_slot + 5).to_string()
        );
    }

    /// Claim: a restarted node on the same blocks builds the same headers, and a node that sees another block 1 hash
    /// answers 503 with the reason instead of serving a chain that the light client has not stored.
    #[test]
    fn a_restart_gives_the_same_chain_and_a_changed_chain_is_refused() {
        let kind = ChainKind::Ethereum;
        let settings = node_settings(kind);
        let feed = ListFeed::shared();
        for _ in 0..5 {
            mine(&feed, settings, GENESIS_TIME);
        }
        let first = BeaconNode::new(Box::new(feed.clone()), settings);
        let second = BeaconNode::new(Box::new(feed.clone()), settings);
        let target = format!("/eth/v1/beacon/headers/{}", settings.first_slot + 3);
        let one = first.answer(&target, "application/json");
        assert_eq!(one.status, 200);
        assert_eq!(one, second.answer(&target, "application/json"));

        feed.0.lock().unwrap()[4].block_hash = B256::repeat_byte(0xee);
        let refused = first.answer(&target, "application/json");
        assert_eq!(refused.status, 503);
        assert!(
            String::from_utf8_lossy(&refused.body).contains("changed"),
            "{}",
            String::from_utf8_lossy(&refused.body)
        );
    }

    /// Claim: the payload fields come from the keys of an Anvil block, each into its own field.
    /// Why it matters: a swapped hash and parent hash would put the wrong block hash in every beacon payload.
    #[test]
    fn the_payload_comes_from_the_keys_of_the_block() {
        let block = json!({
            "number": "0x2a", "hash": format!("{:#x}", B256::repeat_byte(1)), "parentHash": format!("{:#x}", B256::repeat_byte(2)),
            "miner": format!("{:#x}", Address::repeat_byte(3)), "stateRoot": format!("{:#x}", B256::repeat_byte(4)),
            "receiptsRoot": format!("{:#x}", B256::repeat_byte(5)), "logsBloom": format!("0x{}", "06".repeat(256)),
            "mixHash": format!("{:#x}", B256::repeat_byte(7)), "gasLimit": "0x1c9c380", "gasUsed": "0x5208",
            "timestamp": "0x6b49d20c", "extraData": "0x1234", "baseFeePerGas": "0x3b9aca00",
        });
        let payload = payload_from_json(&block).unwrap();
        assert_eq!(payload.block_number, 42);
        assert_eq!(payload.block_hash, B256::repeat_byte(1));
        assert_eq!(payload.parent_hash, B256::repeat_byte(2));
        assert_eq!(payload.fee_recipient, Address::repeat_byte(3));
        assert_eq!(payload.state_root, B256::repeat_byte(4));
        assert_eq!(payload.receipts_root, B256::repeat_byte(5));
        assert_eq!(payload.logs_bloom, vec![6u8; 256]);
        assert_eq!(payload.prev_randao, B256::repeat_byte(7));
        assert_eq!(
            (payload.gas_limit, payload.gas_used, payload.timestamp),
            (30_000_000, 21_000, 0x6b49d20c)
        );
        assert_eq!(payload.extra_data, vec![0x12, 0x34]);
        assert_eq!(payload.base_fee_per_gas, U256::from(1_000_000_000u64));
        assert!(
            payload_from_json(&json!({ "number": "0x1" })).is_err(),
            "a block without keys is refused"
        );
    }

    /// Claim: the first path segment picks the node and the rest of the path stays whole, query string included.
    #[test]
    fn the_prefix_picks_the_node() {
        let feed = ListFeed::shared();
        let mounts: Vec<Mount> = ["a", "b"]
            .iter()
            .map(|prefix| Mount {
                prefix: (*prefix).to_string(),
                node: Arc::new(BeaconNode::new(
                    Box::new(feed.clone()),
                    node_settings(ChainKind::Ethereum),
                )),
            })
            .collect();
        let (node, path) = route(&mounts, "/b/eth/v1/beacon/genesis").unwrap();
        assert!(Arc::ptr_eq(node, &mounts[1].node));
        assert_eq!(path, "/eth/v1/beacon/genesis");
        let (_, path) = route(&mounts, "/a/eth/v1/x?start_period=1&count=2").unwrap();
        assert_eq!(path, "/eth/v1/x?start_period=1&count=2");
        assert!(route(&mounts, "/c/eth/v1/beacon/genesis").is_none());
        assert!(route(&mounts, "/eth").is_none());
    }
}
