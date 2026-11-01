//! Real data of PulseChain testnet v4 (chain identifier 943): the parsers of the prover against a finalized block and a
//! finalized state that a public node served.
//!
//! The committed fixture holds one finalized header and its block (about 2.5 kilobytes). The state is 4.8 megabytes, so
//! it is never committed. The ignored test downloads it into a new directory under the system temporary directory.

use alloy_primitives::B256;
use serde_json::Value;
use std::path::PathBuf;
use zk_bridge_prover::light_client::{
    beacon_header_from_json, header_root, BlockView, ChainKind, StateView,
};
use zk_bridge_prover::rpc::{HttpClient, HttpGet};

const CHAIN: ChainKind = ChainKind::PulsechainTestnetV4;
const NODE: &str = "https://rpc-testnet-pulsechain.g4mm4.io/beacon-api";

fn fixture(name: &str) -> Vec<u8> {
    let path = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("tests/fixtures/pulsechain-testnet-v4")
        .join(name);
    std::fs::read(&path).unwrap_or_else(|error| panic!("{}: {error}", path.display()))
}

fn header_message(answer: &Value) -> &Value {
    &answer["data"]["header"]["message"]
}

fn root_of(value: &Value) -> B256 {
    value.as_str().expect("a hash").parse().expect("32 bytes")
}

/// Claim: the block parser reads a real Capella block of the testnet, and the header that it builds has the root that
/// the node reports: the body root equals `body_root`, the state root equals `state_root`, and the hash of the header
/// equals the `root` of the answer. Why it matters: a preset or field difference of this chain would make every update
/// assembled from its blocks fail, and only a real block shows it.
#[test]
fn a_real_block_of_testnet_v4_parses_to_the_header_of_the_node() {
    let answer: Value = serde_json::from_slice(&fixture("finalized_header.json")).expect("json");
    let expected = beacon_header_from_json(header_message(&answer)).expect("header");
    let view = BlockView::parse_for_chain(&fixture("finalized_block.ssz"), CHAIN).expect("block");
    assert_eq!(view.header.body_root, expected.body_root, "body root");
    assert_eq!(view.header.state_root, expected.state_root, "state root");
    assert_eq!(view.header, expected);
    assert_eq!(header_root(&view.header), root_of(&answer["data"]["root"]));
    assert_eq!(
        view.execution_branch.len(),
        4,
        "the Capella execution branch"
    );
}

/// Claim: the same real data against the live node. The finalized state parses, its root equals the `state_root` of the
/// header, the finalized block hashes to the header, and the committees have 512 keys.
/// Needs network: run with `cargo test --test real_pulsechain_testnet -- --ignored`.
#[test]
#[ignore = "needs network"]
fn the_live_finalized_state_and_block_of_testnet_v4_match_their_header() {
    let directory = std::env::temp_dir().join(format!(
        "zk-bridge-testnet-v4-{}-{}",
        std::process::id(),
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .expect("time")
            .as_nanos()
    ));
    std::fs::create_dir(&directory).expect("a new empty directory");
    let client = HttpClient::new(NODE);
    let get = |route: &str, accept: &str| {
        let answer = client.get(route, accept).expect("answer");
        assert_eq!(answer.status, 200, "{route}");
        answer.body
    };
    let header_bytes = get("/eth/v1/beacon/headers/finalized", "application/json");
    let answer: Value = serde_json::from_slice(&header_bytes).expect("json");
    let header = beacon_header_from_json(header_message(&answer)).expect("header");
    let state_bytes = get(
        &format!("/eth/v2/debug/beacon/states/{:#x}", header.state_root),
        "application/octet-stream",
    );
    let block_bytes = get(
        &format!("/eth/v2/beacon/blocks/{}", header.slot),
        "application/octet-stream",
    );
    std::fs::write(directory.join("state.ssz"), &state_bytes).expect("write");
    std::fs::write(directory.join("block.ssz"), &block_bytes).expect("write");

    let state = StateView::parse(&state_bytes, CHAIN).expect("state");
    assert_eq!(state.slot(), header.slot);
    assert_eq!(state.root(), header.state_root, "state root");
    let block = BlockView::parse_for_chain(&block_bytes, CHAIN).expect("block");
    assert_eq!(block.header.body_root, header.body_root, "body root");
    assert_eq!(header_root(&block.header), header_root(&header));
    assert_eq!(state.current_committee().pubkeys.len(), 512);
    std::fs::remove_dir_all(&directory).expect("clean up");
}

/// Claim: the live handoff of 2026-11-01 against the public node, which serves no light-client routes. The light client
/// on Sepolia has its head at slot 11214304 (period 1368) and stores no committee for 1369; finality has crossed into
/// 1369. The plan from that head holds a step inside 1368 that moves the head and proves the committee of 1369, then the
/// newest update, and the fold verifies natively against the store that the node gives for the head.
/// Needs network, and a head in the period before the finalized one: run with
/// `cargo test --test real_pulsechain_testnet -- --ignored`, with `ZKB_LIVE_HEAD_SLOT` for another head.
#[test]
#[ignore = "needs network"]
fn the_live_head_without_the_next_committee_is_handed_off() {
    use zk_bridge_prover::beacon::http::HttpBeaconSource;
    use zk_bridge_prover::beacon::StoredHead;
    use zk_bridge_prover::light_client::verify_update_natively;

    let head_slot: u64 = std::env::var("ZKB_LIVE_HEAD_SLOT")
        .ok()
        .map(|text| text.parse().expect("a slot"))
        .unwrap_or(11_214_304);
    let client = HttpClient::new(NODE);
    let answer = client
        .get(
            &format!("/eth/v1/beacon/headers/{head_slot}"),
            "application/json",
        )
        .expect("answer");
    assert_eq!(answer.status, 200);
    let answer: Value = serde_json::from_slice(&answer.body).expect("json");
    let head = StoredHead {
        slot: head_slot,
        root: root_of(&answer["data"]["root"]),
        next_committee_hash: B256::ZERO,
    };
    let source = HttpBeaconSource::new(CHAIN, Box::new(HttpClient::new(NODE)));
    let plan = source
        .plan_update(&head)
        .expect("a plan")
        .expect("finality moved past the head");
    let spec = CHAIN.spec();
    let first = &plan.input.steps[0].update;
    eprintln!(
        "steps {}; first: attested {} finalized {} signed {}; newest finalized {}",
        plan.input.steps.len(),
        first.attested_header.beacon.slot,
        first.finalized_header.beacon.slot,
        first.signature_slot,
        plan.latest_finalized_slot
    );
    assert!(first.finalized_header.beacon.slot > head_slot);
    assert_eq!(
        spec.period_at_slot(first.signature_slot),
        spec.period_at_slot(head_slot)
    );
    let output = verify_update_natively(&plan.input).expect("the fold verifies natively");
    assert_eq!(output.previousHeadSlot, head_slot);
    assert_eq!(
        spec.period_at_slot(output.newHeadSlot),
        spec.period_at_slot(head_slot) + 1
    );
    eprintln!(
        "new head {} (period {})",
        output.newHeadSlot,
        spec.period_at_slot(output.newHeadSlot)
    );
}
