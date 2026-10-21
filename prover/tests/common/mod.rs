//! Helpers for the Anvil integration tests: start chains, build the contracts with forge, deploy them.
//!
//! Every test skips with a clear message when `anvil` or `forge` is missing.

#![allow(dead_code)]

use alloy_primitives::{hex, Address, Bytes, B256, U256};
use serde_json::{json, Value};
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::OnceLock;
use std::time::{Duration, Instant};
use zk_bridge_prover::rpc::{HttpRpc, JsonRpc};

/// The first and second Anvil development accounts. Their keys are public and worthless outside local test chains.
pub const DEPLOYER: Address = alloy_primitives::address!("f39Fd6e51aad88F6F4ce6aB8827279cffFb92266");
pub const RECIPIENT: Address = alloy_primitives::address!("70997970C51812dc3A010C7d01b50e0d17dc79C8");
pub const DEPLOYER_SECRET: &str = "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80";

/// The root of the repository (the parent of `prover/`).
pub fn repository_root() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR")).parent().expect("repository root").to_path_buf()
}

/// A scratch directory under `target/`, unique for a name and this process.
pub fn scratch(name: &str) -> PathBuf {
    let path = Path::new(env!("CARGO_MANIFEST_DIR")).join("target/test-scratch").join(format!("{name}-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&path);
    std::fs::create_dir_all(&path).expect("scratch directory");
    path
}

fn tool_exists(name: &str) -> bool {
    Command::new(name).arg("--version").stdout(Stdio::null()).stderr(Stdio::null()).status().is_ok_and(|status| status.success())
}

/// Returns false and prints why when anvil or forge is missing.
pub fn tools_available() -> bool {
    for tool in ["anvil", "forge"] {
        if !tool_exists(tool) {
            eprintln!("SKIPPED: `{tool}` is not installed or not on PATH, so the Anvil integration test cannot run");
            return false;
        }
    }
    true
}

/// A running Anvil process. It stops when dropped.
pub struct Anvil {
    child: Child,
    pub url: String,
    pub chain_id: u64,
}

impl Drop for Anvil {
    fn drop(&mut self) {
        let _ = self.child.kill();
        let _ = self.child.wait();
    }
}

fn free_port() -> u16 {
    std::net::TcpListener::bind("127.0.0.1:0").expect("bind").local_addr().expect("address").port()
}

/// The Anvil hardforks the tests use. `Shanghai` is the PulseChain role: no EIP-4788 (beacon roots) and no
/// `MCOPY`. `Cancun` is the Ethereum role: the tests install the genuine EIP-4788 contract code by hand, because
/// Anvil does not deploy it.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Hardfork {
    Shanghai,
    Cancun,
}

impl Hardfork {
    fn name(self) -> &'static str {
        match self {
            Self::Shanghai => "shanghai",
            Self::Cancun => "cancun",
        }
    }
}

/// Starts `anvil --hardfork <name>` with a chain identifier and waits until it answers.
pub fn start_anvil(chain_id: u64, hardfork: Hardfork) -> Anvil {
    let port = free_port();
    let child = Command::new("anvil")
        .args(["--port", &port.to_string(), "--chain-id", &chain_id.to_string(), "--hardfork", hardfork.name(), "--silent"])
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn()
        .expect("start anvil");
    let anvil = Anvil { child, url: format!("http://127.0.0.1:{port}"), chain_id };
    let rpc = HttpRpc::new(&anvil.url);
    let start = Instant::now();
    while rpc.call("eth_chainId", json!([])).is_err() {
        assert!(start.elapsed() < Duration::from_secs(20), "anvil did not start");
        std::thread::sleep(Duration::from_millis(100));
    }
    anvil
}

/// The root that forge builds. By default the repository. The variable `PROVER_TEST_CONTRACTS_ROOT` names another
/// root (a copy of the contracts), for a check against contracts that differ from the repository.
fn contracts_root() -> PathBuf {
    std::env::var("PROVER_TEST_CONTRACTS_ROOT").map(PathBuf::from).unwrap_or_else(|_| repository_root())
}

/// Builds the contracts with forge into a directory of this crate and returns it. It builds once per process.
pub fn forge_output() -> &'static PathBuf {
    static OUTPUT: OnceLock<PathBuf> = OnceLock::new();
    OUTPUT.get_or_init(|| {
        let base = Path::new(env!("CARGO_MANIFEST_DIR")).join("target/forge");
        let out = base.join("out");
        let status = Command::new("forge")
            .current_dir(contracts_root())
            .args(["build", "--root", "."])
            .arg("--out")
            .arg(&out)
            .arg("--cache-path")
            .arg(base.join("cache"))
            .args(["--skip", "test", "--skip", "script"])
            .output()
            .expect("run forge build");
        assert!(status.status.success(), "forge build failed: {}", String::from_utf8_lossy(&status.stderr));
        out
    })
}

/// A constructor argument: one static word, a string, or an array of static tuples (the token pairs).
pub enum Argument {
    Word([u8; 32]),
    /// A dynamic array of static words (for example `uint8[]`).
    Words(Vec<[u8; 32]>),
    Tuples(Vec<Vec<[u8; 32]>>),
    Text(String),
}

pub fn word_u64(value: u64) -> Argument {
    Argument::Word(U256::from(value).to_be_bytes())
}

pub fn word_address(value: Address) -> Argument {
    let mut word = [0u8; 32];
    word[12..].copy_from_slice(value.as_slice());
    Argument::Word(word)
}

/// A `bytes4` word: left-aligned.
pub fn raw_bytes4(value: [u8; 4]) -> [u8; 32] {
    let mut word = [0u8; 32];
    word[..4].copy_from_slice(&value);
    word
}

pub fn word_hash(value: B256) -> Argument {
    Argument::Word(value.0)
}

/// Encodes constructor arguments in the order of the artifact ABI, matching by parameter name
/// (a trailing underscore is ignored). A parameter without a value stops the test with its name.
fn encode_constructor(abi: &Value, values: &HashMap<&str, Argument>) -> Vec<u8> {
    let Some(constructor) = abi.as_array().and_then(|items| items.iter().find(|item| item["type"] == "constructor")) else {
        return Vec::new();
    };
    let inputs = constructor["inputs"].as_array().expect("inputs");
    let mut head: Vec<u8> = Vec::new();
    let mut tail: Vec<u8> = Vec::new();
    let head_size = inputs.len() * 32;
    for input in inputs {
        let name = input["name"].as_str().expect("name").trim_end_matches('_');
        let argument = values
            .get(name)
            .unwrap_or_else(|| panic!("the constructor takes `{name}` ({}), and the test has no value for it", input["type"]));
        match argument {
            Argument::Word(word) => head.extend_from_slice(word),
            Argument::Words(words) => {
                head.extend_from_slice(&U256::from(head_size + tail.len()).to_be_bytes::<32>());
                tail.extend_from_slice(&U256::from(words.len()).to_be_bytes::<32>());
                for word in words {
                    tail.extend_from_slice(word);
                }
            }
            Argument::Text(text) => {
                head.extend_from_slice(&U256::from(head_size + tail.len()).to_be_bytes::<32>());
                tail.extend_from_slice(&U256::from(text.len()).to_be_bytes::<32>());
                tail.extend_from_slice(text.as_bytes());
                tail.resize(tail.len().div_ceil(32) * 32, 0);
            }
            Argument::Tuples(tuples) => {
                head.extend_from_slice(&U256::from(head_size + tail.len()).to_be_bytes::<32>());
                tail.extend_from_slice(&U256::from(tuples.len()).to_be_bytes::<32>());
                for tuple in tuples {
                    for word in tuple {
                        tail.extend_from_slice(word);
                    }
                }
            }
        }
    }
    head.extend(tail);
    head
}

/// One chain with its RPC client.
pub struct TestChain {
    pub anvil: Anvil,
    pub rpc: HttpRpc,
}

impl TestChain {
    pub fn start(chain_id: u64, hardfork: Hardfork) -> Self {
        let anvil = start_anvil(chain_id, hardfork);
        let rpc = HttpRpc::new(&anvil.url);
        Self { anvil, rpc }
    }

    /// Sends a transaction from the unlocked deployer account and waits for the receipt.
    pub fn send(&self, to: Option<Address>, data: &[u8]) -> Value {
        let mut request = json!({ "from": format!("{DEPLOYER:#x}"), "data": format!("0x{}", hex::encode(data)), "gas": "0x7a1200" });
        if let Some(to) = to {
            request["to"] = json!(format!("{to:#x}"));
        }
        let hash = self.rpc.call("eth_sendTransaction", json!([request])).expect("send transaction");
        let start = Instant::now();
        loop {
            let receipt = self.rpc.call("eth_getTransactionReceipt", json!([hash])).expect("receipt");
            if !receipt.is_null() {
                assert_eq!(receipt["status"], "0x1", "transaction failed: {receipt}");
                return receipt;
            }
            assert!(start.elapsed() < Duration::from_secs(20), "no receipt for {hash}");
            std::thread::sleep(Duration::from_millis(50));
        }
    }

    /// Deploys a contract from `forge build` output and returns its address.
    pub fn deploy(&self, contract: &str, values: HashMap<&str, Argument>) -> Address {
        let path = forge_output().join(format!("{contract}.sol/{contract}.json"));
        let artifact: Value = serde_json::from_slice(&std::fs::read(&path).unwrap_or_else(|e| panic!("{}: {e}", path.display()))).expect("artifact");
        let mut data = hex::decode(artifact["bytecode"]["object"].as_str().expect("bytecode")).expect("hex");
        data.extend(encode_constructor(&artifact["abi"], &values));
        let receipt = self.send(None, &data);
        receipt["contractAddress"].as_str().expect("contract address").parse().expect("address")
    }

    /// Calls a view function and returns the raw return data.
    pub fn call(&self, to: Address, data: &[u8]) -> Result<Bytes, zk_bridge_prover::error::Error> {
        let answer = self.rpc.call("eth_call", json!([{ "to": format!("{to:#x}"), "data": format!("0x{}", hex::encode(data)) }, "latest"]))?;
        Ok(Bytes::from(hex::decode(answer.as_str().expect("hex")).expect("hex")))
    }

    /// Moves the clock of the chain forward and mines one block, so the next block lies `seconds` later.
    pub fn advance_time(&self, seconds: u64) {
        self.rpc.call("evm_increaseTime", json!([seconds])).expect("increase time");
        self.rpc.call("evm_mine", json!([])).expect("mine");
    }

    /// Writes one storage word of a contract.
    pub fn set_storage(&self, contract: Address, slot: B256, value: B256) {
        self.rpc
            .call("anvil_setStorageAt", json!([format!("{contract:#x}"), format!("{slot:#x}"), format!("{value:#x}")]))
            .expect("set storage");
    }

    /// Replaces the code of an account.
    pub fn set_code(&self, account: Address, code: &[u8]) {
        self.rpc.call("anvil_setCode", json!([format!("{account:#x}"), format!("0x{}", hex::encode(code))])).expect("set code");
    }

    pub fn latest_timestamp(&self) -> u64 {
        let block = self.rpc.call("eth_getBlockByNumber", json!(["latest", false])).expect("block");
        zk_bridge_prover::rpc::parse_quantity(&block["timestamp"]).expect("timestamp")
    }

    pub fn mine(&self, blocks: u64) {
        self.rpc.call("anvil_mine", json!([format!("{blocks:#x}")])).expect("mine");
    }

    pub fn nonce(&self, account: Address) -> u64 {
        zk_bridge_prover::rpc::parse_quantity(&self.rpc.call("eth_getTransactionCount", json!([format!("{account:#x}"), "latest"])).expect("nonce")).expect("quantity")
    }
}
