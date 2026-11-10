//! The `deployment-file` command: the file that `explorer/shared/src/pairs.ts` reads.
//!
//! `check_like_the_explorer` repeats the rules of `deploymentChainSchema` and `loadPair` in Rust, with the field list
//! written out here. The explorer matches a section to a chain by `chain_id` and needs exactly one valid section per chain.

use alloy_primitives::Address;
use serde_json::{json, Value};
use std::os::unix::fs::PermissionsExt;
use std::path::{Path, PathBuf};
use zk_bridge_prover::cli;
use zk_bridge_prover::deployment::SECTION_KEYS;
use zk_bridge_prover::error::Result;

/// The fields of `deploymentChainSchema`: required addresses, optional addresses, numbers and the optional string.
const REQUIRED_ADDRESSES: [&str; 6] = [
    "bridge",
    "mediator",
    "token_factory",
    "wrapped_native",
    "gate",
    "light_client",
];
const OPTIONAL_ADDRESSES: [&str; 2] = ["delivery_router", "fork_registry"];

struct Scratch(PathBuf);

impl Scratch {
    fn new(label: &str) -> Self {
        let path =
            std::env::temp_dir().join(format!("deployment-file-{label}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&path);
        std::fs::create_dir_all(&path).unwrap();
        Self(path)
    }

    fn path(&self, name: &str) -> PathBuf {
        self.0.join(name)
    }
}

impl Drop for Scratch {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.0);
    }
}

fn is_address(value: &Value) -> bool {
    value.as_str().is_some_and(|text| {
        text.len() == 42
            && text.starts_with("0x")
            && text[2..]
                .chars()
                .all(|character| character.is_ascii_hexdigit())
    })
}

/// The explorer rules: one object of sections, each valid section has the required fields, and each chain has exactly one.
fn check_like_the_explorer(file: &Value, chain_id: u64) {
    let sections = file.as_object().expect("an object of sections");
    let valid: Vec<&Value> = sections
        .values()
        .filter(|section| {
            section["chain_id"].as_u64().is_some_and(|id| id > 0)
                && REQUIRED_ADDRESSES
                    .iter()
                    .all(|key| is_address(&section[*key]))
                && OPTIONAL_ADDRESSES.iter().all(|key| {
                    section
                        .get(*key)
                        .is_none_or(|value| value.is_null() || is_address(value))
                })
                && section["start_block"].is_u64()
                && section
                    .get("light_client_start_block")
                    .is_none_or(Value::is_u64)
                && section.get("rpc_url").is_none_or(Value::is_string)
        })
        .filter(|section| section["chain_id"] == chain_id)
        .collect();
    assert_eq!(
        valid.len(),
        1,
        "exactly one valid section for chain {chain_id}"
    );
}

fn address(byte: u8) -> String {
    format!("{:#x}", Address::repeat_byte(byte))
}

fn pairs(chain_id: u64, base: u8) -> Vec<String> {
    let mut all = vec![
        format!("chain_id={chain_id}"),
        format!("start_block={}", base as u64 * 100),
    ];
    for (offset, key) in REQUIRED_ADDRESSES.iter().enumerate() {
        all.push(format!("{key}={}", address(base + offset as u8)));
    }
    all
}

fn run(arguments: &[String]) -> (Result<i32>, String) {
    let mut all = vec![
        "zk-bridge-prover".to_string(),
        "deployment-file".to_string(),
    ];
    all.extend_from_slice(arguments);
    let mut out = Vec::new();
    let outcome = cli::run(all, &|_| None, &mut out);
    (outcome, String::from_utf8(out).unwrap())
}

fn arguments(output: &Path, a: &[String], b: &[String]) -> Vec<String> {
    let mut all = vec!["--output".to_string(), output.display().to_string()];
    for pair in a {
        all.extend(["--chain-a".to_string(), pair.clone()]);
    }
    for pair in b {
        all.extend(["--chain-b".to_string(), pair.clone()]);
    }
    all
}

fn read(path: &Path) -> Value {
    serde_json::from_str(&std::fs::read_to_string(path).unwrap()).unwrap()
}

/// Claim: the field list of the command is the field list of the TypeScript schema, and a file that the command writes from
/// flags passes the explorer rules for both chains, holds lowercase addresses and no `rpc_url`, and has mode 0600.
/// Why it matters: a missing or renamed field makes the explorer drop the whole section, and a key in the file leaks.
#[test]
fn a_file_from_flags_passes_the_explorer_rules() {
    let mut expected: Vec<&str> = [
        "chain_id",
        "rpc_url",
        "start_block",
        "light_client_start_block",
    ]
    .to_vec();
    expected.extend(REQUIRED_ADDRESSES);
    expected.extend(OPTIONAL_ADDRESSES);
    let mut keys = SECTION_KEYS.to_vec();
    keys.sort_unstable();
    expected.sort_unstable();
    assert_eq!(keys, expected);

    let scratch = Scratch::new("flags");
    let output = scratch.path("deployment.json");
    let (outcome, summary) = run(&arguments(
        &output,
        &pairs(11155111, 0x10),
        &pairs(943, 0x40),
    ));
    assert_eq!(outcome.unwrap(), 0);
    let summary: Value = serde_json::from_str(&summary).unwrap();
    assert_eq!(summary["chains"], json!([11155111, 943]));
    let file = read(&output);
    check_like_the_explorer(&file, 11155111);
    check_like_the_explorer(&file, 943);
    assert_eq!(file["chain_a"]["bridge"], address(0x10));
    assert_eq!(file["chain_b"]["light_client"], address(0x45));
    assert_eq!(file["chain_b"]["start_block"], 0x40 * 100);
    for section in ["chain_a", "chain_b"] {
        assert!(
            file[section].get("rpc_url").is_none(),
            "no rpc_url by default"
        );
        assert!(file[section].get("delivery_router").is_none());
        for key in file[section].as_object().unwrap().keys() {
            assert!(SECTION_KEYS.contains(&key.as_str()), "{key}");
        }
    }
    assert_eq!(
        std::fs::metadata(&output).unwrap().permissions().mode() & 0o777,
        0o600
    );
}

/// Claim: the command refuses to replace a file without `--force`, keeps the old content then, and replaces it with
/// `--force` while the mode stays 0600. Why it matters: the file feeds the indexer, and a silent overwrite loses a deployment.
#[test]
fn an_existing_file_needs_force() {
    let scratch = Scratch::new("force");
    let output = scratch.path("deployment.json");
    let first = arguments(&output, &pairs(1, 0x10), &pairs(369, 0x40));
    assert_eq!(run(&first).0.unwrap(), 0);
    let before = std::fs::read_to_string(&output).unwrap();
    let second = arguments(&output, &pairs(1, 0x20), &pairs(369, 0x50));
    let error = run(&second).0.unwrap_err().to_string();
    assert!(error.contains("--force"), "{error}");
    assert_eq!(std::fs::read_to_string(&output).unwrap(), before);
    let mut forced = second;
    forced.push("--force".into());
    assert_eq!(run(&forced).0.unwrap(), 0);
    assert_eq!(read(&output)["chain_a"]["bridge"], address(0x20));
    assert_eq!(
        std::fs::metadata(&output).unwrap().permissions().mode() & 0o777,
        0o600
    );
    let leftovers: Vec<_> = std::fs::read_dir(&scratch.0).unwrap().collect();
    assert_eq!(leftovers.len(), 1, "no temporary file stays");
}

/// Claim: every wrong value is refused and nothing is written: a zero required address, a short address, an address without
/// the prefix, a missing field, a zero chain identifier, two sections of one chain, and an RPC URL that can hold a key.
#[test]
fn wrong_values_are_refused_and_no_file_appears() {
    let scratch = Scratch::new("wrong");
    let output = scratch.path("deployment.json");
    let good_b = pairs(943, 0x40);
    let zero = format!("bridge={}", address(0));
    let with = |extra: &str| {
        let mut all = pairs(11155111, 0x10);
        all.push(extra.to_string());
        all
    };
    let cases: Vec<(Vec<String>, &str)> = vec![
        (with(&zero), "zero address"),
        (with("gate=0x1234"), "40 hex digits"),
        (
            with(&format!("gate={}", &address(0x22)[2..])),
            "40 hex digits",
        ),
        (with("chain_id=0"), "chain_id is zero"),
        (with("colour=red"), "unknown key"),
        (
            with("rpc_url=https://one.example/rpc/SECRETKEY/943"),
            "may hold a key",
        ),
        (
            with("rpc_url=https://user:SECRETKEY@one.example"),
            "may hold a key",
        ),
        (
            with("rpc_url=https://node.example?key=SECRETKEY"),
            "may hold a key",
        ),
        (pairs(943, 0x10), "both sections are for chain 943"),
        (
            pairs(11155111, 0x10)
                .into_iter()
                .filter(|pair| !pair.starts_with("mediator"))
                .collect(),
            "mediator is missing",
        ),
        (
            with("native_router=0x0000000000000000000000000000000000000000"),
            "unknown key `native_router`",
        ),
    ];
    for (a, expected) in cases {
        let (outcome, out) = run(&arguments(&output, &a, &good_b));
        let error = outcome.expect_err(expected).to_string();
        assert!(
            error.contains(expected),
            "expected `{expected}` in `{error}`"
        );
        assert!(!error.contains("SECRETKEY") || expected == "may hold a key");
        assert!(out.is_empty());
        assert!(!output.exists(), "{expected}: no file");
    }
}

/// Claim: a chain without a wrapped native token may give the wrapped native token as zero, and the file still passes the explorer
/// rules, which need the fields to be present. An RPC URL without path or query is written when the user gives it.
#[test]
fn a_chain_without_wrapped_native_and_a_plain_rpc_url_are_accepted() {
    let scratch = Scratch::new("plain");
    let output = scratch.path("deployment.json");
    let zero = address(0);
    let mut a = pairs(11155111, 0x10);
    a.push(format!("wrapped_native={zero}"));
    a.push("rpc_url=https://node.example".into());
    a.push(format!("delivery_router={zero}"));
    a.push(format!("fork_registry={}", address(0x77)));
    assert_eq!(
        run(&arguments(&output, &a, &pairs(943, 0x40))).0.unwrap(),
        0
    );
    let file = read(&output);
    check_like_the_explorer(&file, 11155111);
    assert_eq!(file["chain_a"]["wrapped_native"], zero);
    assert!(file["chain_a"].get("native_router").is_none());
    assert_eq!(file["chain_a"]["rpc_url"], "https://node.example");
    assert!(
        file["chain_a"].get("delivery_router").is_none(),
        "a zero optional address is left out"
    );
    assert_eq!(file["chain_a"]["fork_registry"], address(0x77));
}

fn transaction(name: &str, address: &str, arguments: Value, extra: Vec<&str>) -> Value {
    json!({
        "hash": "0x01",
        "transactionType": "CREATE",
        "contractName": name,
        "contractAddress": address,
        "arguments": arguments,
        "additionalContracts": extra.iter().map(|created| json!({"transactionType": "CREATE", "address": created})).collect::<Vec<_>>(),
    })
}

/// A deployment as `forge script --broadcast` writes it for one chain. The addresses of chain 1 are those of a real run
/// of `DeployBridge.s.sol` on a local node, where the mediator is 0x0165... and its factory is 0x3b02....
fn deployment(chain: u64, blocks: [&str; 3], with_observed_light_client: bool) -> Value {
    let mediator = "0x0165878a594ca255338adfa4d48449f69242eb8f";
    let mut transactions = vec![transaction(
        "BeaconLightClient",
        "0xcf7ed3acca5a467e9e704c703e8d87f634fb0fc9",
        json!(["0x01"]),
        vec![],
    )];
    if with_observed_light_client {
        transactions.push(transaction(
            "BeaconLightClient",
            "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
            json!([]),
            vec![],
        ));
        transactions.push(transaction(
            "ForkRegistry",
            "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
            json!([]),
            vec![],
        ));
    }
    transactions.extend([
        transaction(
            "BeaconForkGate",
            "0xdc64a140aa3e981100a9beca4e685f962f0cf6c9",
            json!([]),
            vec![],
        ),
        transaction(
            "MessageBridge",
            "0x5fc8d32690cc91d4c39d9d3abcbd16989f875707",
            json!([]),
            vec![],
        ),
        transaction(
            "TokenMediator",
            mediator,
            json!([]),
            vec!["0x3b02ff1e626ed7a8fd6ec5299e2c54e1421b626b"],
        ),
        transaction(
            "DeliveryRouter",
            "0xa513e6e4b8f2a923d98304ec87f64353c4d5c853",
            json!([
                mediator,
                "0x5FbDB2315678afecb367f032d93F642f64180aa3",
                "0x01",
                "0x02"
            ]),
            vec![],
        ),
    ]);
    json!({
        "chain": chain,
        "transactions": transactions,
        "receipts": blocks.iter().map(|block| json!({"blockNumber": block})).collect::<Vec<_>>(),
    })
}

/// Claim: the names come from the `contractName` fields. The factory is the first contract of the mediator, the wrapped
/// token is the second argument of the `DeliveryRouter`, the start block is the block before the first transaction, and the first
/// `BeaconLightClient` is the light client when a second one (the own-chain light client) follows. A flag overrides the file.
/// Why it matters: the explorer indexes from `start_block`, and a wrong contract address indexes the wrong events.
#[test]
fn a_broadcast_file_gives_the_addresses_by_contract_name() {
    let scratch = Scratch::new("broadcast");
    let file = scratch.path("run.json");
    std::fs::write(
        &file,
        json!({"deployments": [deployment(1, ["0xf", "0x10", "0x11"], false), deployment(369, ["0x14", "0x15", "0x16"], true)]}).to_string(),
    )
    .unwrap();
    let output = scratch.path("deployment.json");
    let mut all = arguments(
        &output,
        &[],
        &["delivery_router=0x9999999999999999999999999999999999999999".to_string()],
    );
    all.extend(["--broadcast".to_string(), file.display().to_string()]);
    assert_eq!(run(&all).0.unwrap(), 0);
    let written = read(&output);
    check_like_the_explorer(&written, 1);
    check_like_the_explorer(&written, 369);
    let a = &written["chain_a"];
    assert_eq!(
        a["light_client"],
        "0xcf7ed3acca5a467e9e704c703e8d87f634fb0fc9"
    );
    assert_eq!(a["bridge"], "0x5fc8d32690cc91d4c39d9d3abcbd16989f875707");
    assert_eq!(a["mediator"], "0x0165878a594ca255338adfa4d48449f69242eb8f");
    assert_eq!(
        a["token_factory"],
        "0x3b02ff1e626ed7a8fd6ec5299e2c54e1421b626b"
    );
    assert_eq!(
        a["delivery_router"],
        "0xa513e6e4b8f2a923d98304ec87f64353c4d5c853"
    );
    assert!(a.get("native_router").is_none());
    assert_eq!(
        a["wrapped_native"],
        "0x5fbdb2315678afecb367f032d93f642f64180aa3"
    );
    assert_eq!(a["gate"], "0xdc64a140aa3e981100a9beca4e685f962f0cf6c9");
    assert_eq!(a["start_block"], 14);
    let b = &written["chain_b"];
    assert_eq!(b["chain_id"], 369);
    assert_eq!(
        b["light_client"], "0xcf7ed3acca5a467e9e704c703e8d87f634fb0fc9",
        "the first light client"
    );
    assert_eq!(
        b["fork_registry"],
        "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"
    );
    assert_eq!(
        b["delivery_router"], "0x9999999999999999999999999999999999999999",
        "the flag adds it"
    );
    assert_eq!(b["start_block"], 19);
    // A chain identifier in the flags picks the deployment of that chain, whatever the order of the file.
    let swapped = scratch.path("swapped.json");
    let mut again = arguments(
        &swapped,
        &["chain_id=369".to_string()],
        &["chain_id=1".to_string()],
    );
    again.extend(["--broadcast".to_string(), file.display().to_string()]);
    assert_eq!(run(&again).0.unwrap(), 0);
    assert_eq!(read(&swapped)["chain_a"]["start_block"], 19);
    assert_eq!(read(&swapped)["chain_b"]["start_block"], 14);
}

/// Claim: a broadcast file with two contracts of one name that the command cannot tell apart is refused with the name, and
/// a file of another shape is refused. Why it matters: a guess here would index a wrong contract.
#[test]
fn an_ambiguous_or_foreign_broadcast_file_is_refused() {
    let scratch = Scratch::new("ambiguous");
    let mut doubled = deployment(1, ["0xf", "0x10", "0x11"], false);
    let copy = doubled["transactions"][2].clone();
    doubled["transactions"].as_array_mut().unwrap().push(copy);
    let file = scratch.path("run.json");
    std::fs::write(&file, doubled.to_string()).unwrap();
    let mut all = arguments(&scratch.path("out.json"), &[], &pairs(943, 0x40));
    all.extend(["--broadcast".to_string(), file.display().to_string()]);
    let error = run(&all).0.unwrap_err().to_string();
    assert!(error.contains("several MessageBridge"), "{error}");

    std::fs::write(&file, "{\"hello\": 1}").unwrap();
    let error = run(&all).0.unwrap_err().to_string();
    assert!(
        error.contains("neither `deployments` nor `transactions`"),
        "{error}"
    );
    assert!(!scratch.path("out.json").exists());
}

/// Claim: `light_client_start_block` from a flag is written when it is before `start_block`, left out when it equals it,
/// and refused when it is after it.
/// Why it matters: the prover scans the stored heads of the light client from this block. After a bridge redeploy that
/// kept the light client, a scan from `start_block` misses the heads stored before it, and a message sent just after the
/// redeploy can never get a block hash row (message ...0000, 943 to Sepolia, 2026-11-08).
#[test]
fn the_light_client_start_block_is_written_only_when_it_is_earlier() {
    let scratch = Scratch::new("light-client-start");
    let output = scratch.path("deployment.json");
    let mut a = pairs(11155111, 0x10);
    a.push("light_client_start_block=1000".into());
    let mut b = pairs(943, 0x40);
    b.push(format!("light_client_start_block={}", 0x40 * 100));
    let (outcome, _) = run(&arguments(&output, &a, &b));
    assert_eq!(outcome.unwrap(), 0);
    let file = read(&output);
    check_like_the_explorer(&file, 11155111);
    assert_eq!(file["chain_a"]["light_client_start_block"], 1000);
    assert!(
        file["chain_b"].get("light_client_start_block").is_none(),
        "equal to start_block: left out"
    );

    let late = scratch.path("late.json");
    let mut a = pairs(11155111, 0x10);
    a.push(format!("light_client_start_block={}", 0x10 * 100 + 1));
    let error = run(&arguments(&late, &a, &pairs(943, 0x40)))
        .0
        .unwrap_err()
        .to_string();
    assert!(
        error.contains("light_client_start_block is after start_block"),
        "{error}"
    );
    assert!(!late.exists());
}
