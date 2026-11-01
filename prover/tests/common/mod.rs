//! A synthetic signed beacon chain over fake execution blocks, shared by the integration tests.
//!
//! The chain follows a list of blocks that a test extends with [`Chain::mine`]. No execution node is involved: the beacon
//! side stands alone, and its committee signs for real (BLS), so the light-client program accepts its updates.
#![allow(dead_code)]

use alloy_primitives::{keccak256, Address, B256, U256};
use lc_testkit::block_bytes::PayloadFields;
use std::net::TcpListener;
use std::sync::{Arc, Mutex};
use zk_bridge_prover::beacon::http::HttpBeaconSource;
use zk_bridge_prover::beacon::{SourceBlock, StoredHead};
use zk_bridge_prover::error::{Error, Result};
use zk_bridge_prover::light_client::{ChainKind, LightClientOutput};
use zk_bridge_prover::local_network::signed_beacon::checkpoint::Checkpoint;
use zk_bridge_prover::local_network::signed_beacon::node::{
    default_first_slot, serve, BeaconNode, BlockFeed, Mount, NodeSettings,
};

/// The two chains whose specifications the tests cover.
pub const KINDS: [ChainKind; 4] = ChainKind::ALL;

/// The timestamp of execution block 1. Genesis follows from it and from the first slot.
pub const FIRST_TIMESTAMP: u64 = 1_800_000_000;

/// Blocks before the checkpoint, and blocks after it.
pub const BLOCKS_BEFORE_CHECKPOINT: u64 = 12;

pub struct Feed(Mutex<Vec<PayloadFields>>);

/// The node owns its feed, and the test keeps a second handle to mine blocks.
pub struct SharedFeed(Arc<Feed>);

impl BlockFeed for SharedFeed {
    fn latest_number(&self) -> Result<u64> {
        Ok(self.0 .0.lock().unwrap().len() as u64)
    }

    fn payload(&self, number: u64) -> Result<PayloadFields> {
        let blocks = self.0 .0.lock().unwrap();
        blocks
            .get(number as usize - 1)
            .cloned()
            .ok_or_else(|| Error::Malformed(format!("block {number} is unknown")))
    }
}

pub fn execution_hash(number: u64) -> B256 {
    keccak256(format!("anvil block {number}"))
}

pub fn payload(number: u64, seconds_per_slot: u64) -> PayloadFields {
    PayloadFields {
        parent_hash: execution_hash(number - 1),
        fee_recipient: Address::repeat_byte(0x0f),
        state_root: keccak256(b"state"),
        receipts_root: keccak256(format!("receipts {number}")),
        logs_bloom: vec![0u8; 256],
        prev_randao: keccak256(b"randao"),
        block_number: number,
        gas_limit: 30_000_000,
        gas_used: 21_000,
        timestamp: FIRST_TIMESTAMP + (number - 1) * seconds_per_slot,
        extra_data: Vec::new(),
        base_fee_per_gas: U256::from(7u64),
        block_hash: execution_hash(number),
    }
}

/// A node over a chain that the test mines forward.
pub struct Chain {
    pub kind: ChainKind,
    feed: Arc<Feed>,
    pub node: Arc<BeaconNode>,
}

impl Chain {
    pub fn new(kind: ChainKind, blocks: u64) -> Self {
        let feed = Arc::new(Feed(Mutex::new(Vec::new())));
        let node = Arc::new(BeaconNode::new(
            Box::new(SharedFeed(feed.clone())),
            NodeSettings {
                kind,
                first_slot: default_first_slot(kind),
                finality_slots: 2,
                participants: 400,
            },
        ));
        let chain = Self { kind, feed, node };
        chain.mine(blocks);
        chain
    }

    pub fn mine(&self, count: u64) {
        let mut blocks = self.feed.0.lock().unwrap();
        for _ in 0..count {
            let number = blocks.len() as u64 + 1;
            blocks.push(payload(number, self.kind.seconds_per_slot()));
        }
    }

    /// Mines the next block with a payload that the test changes. The timestamp and the number must stay as they are:
    /// they fix the slot of the block.
    pub fn mine_custom(&self, change: impl FnOnce(&mut PayloadFields)) {
        let mut blocks = self.feed.0.lock().unwrap();
        let number = blocks.len() as u64 + 1;
        let mut next = payload(number, self.kind.seconds_per_slot());
        change(&mut next);
        blocks.push(next);
    }

    pub fn source(&self) -> HttpBeaconSource {
        HttpBeaconSource::new(self.kind, Box::new(self.node.clone()))
    }

    pub fn first_slot(&self) -> u64 {
        default_first_slot(self.kind)
    }

    pub fn source_block(&self, number: u64) -> SourceBlock {
        SourceBlock {
            number,
            hash: execution_hash(number),
            timestamp: payload(number, self.kind.seconds_per_slot()).timestamp,
        }
    }
}

/// The head that a light client holds when it starts at a checkpoint.
pub fn head_at(checkpoint: &Checkpoint) -> StoredHead {
    StoredHead {
        slot: checkpoint.slot,
        root: checkpoint.header_root,
        next_committee_hash: checkpoint.next_committee_hash,
    }
}

/// The head that a light client holds after an update that the program accepted.
pub fn head_after(output: &LightClientOutput) -> StoredHead {
    StoredHead {
        slot: output.newHeadSlot,
        root: output.newHeaderRoot,
        next_committee_hash: output.nextSyncCommitteeHash,
    }
}

/// A free local port.
fn free_port() -> u16 {
    TcpListener::bind("127.0.0.1:0")
        .expect("a free port")
        .local_addr()
        .unwrap()
        .port()
}

/// Serves the beacon node of `chain` on a free local port, and returns its base URL.
pub fn serve_beacon(chain: &Chain) -> String {
    let port = free_port();
    let node = chain.node.clone();
    std::thread::spawn(move || {
        let _ = serve(
            &format!("127.0.0.1:{port}"),
            vec![Mount {
                prefix: "a".into(),
                node,
            }],
        );
    });
    let url = format!("http://127.0.0.1:{port}/a");
    // The server needs a moment to bind. A connection that succeeds shows it is up.
    for _ in 0..100 {
        if std::net::TcpStream::connect(format!("127.0.0.1:{port}")).is_ok() {
            return url;
        }
        std::thread::sleep(std::time::Duration::from_millis(20));
    }
    panic!("the beacon server did not start");
}

/// Serves a JSON-RPC node on a free local port and returns its URL. `answer` gets each call object and returns its
/// `result`. The server runs until the test process ends.
pub fn serve_rpc(
    answer: impl Fn(&serde_json::Value) -> serde_json::Value + Send + 'static,
) -> String {
    serve_rpc_replies(move |call| Ok(answer(call)))
}

/// Like [`serve_rpc`], but `answer` returns `Err(error object)` for a JSON-RPC error such as a missing method.
pub fn serve_rpc_replies(
    answer: impl Fn(&serde_json::Value) -> std::result::Result<serde_json::Value, serde_json::Value>
        + Send
        + 'static,
) -> String {
    let server = tiny_http::Server::http("127.0.0.1:0").expect("a free port");
    let port = server.server_addr().to_ip().expect("an ip address").port();
    std::thread::spawn(move || {
        for mut request in server.incoming_requests() {
            let mut body = String::new();
            std::io::Read::read_to_string(request.as_reader(), &mut body).unwrap();
            let call: serde_json::Value = serde_json::from_str(&body).expect("a JSON-RPC call");
            let reply = match answer(&call) {
                Ok(result) => {
                    serde_json::json!({ "jsonrpc": "2.0", "id": call["id"], "result": result })
                }
                Err(error) => {
                    serde_json::json!({ "jsonrpc": "2.0", "id": call["id"], "error": error })
                }
            };
            let _ = request.respond(tiny_http::Response::from_string(reply.to_string()));
        }
    });
    format!("http://127.0.0.1:{port}")
}
