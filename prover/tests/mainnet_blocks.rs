//! Real Ethereum mainnet blocks of Deneb, Electra and Fulu go through the block parser.
//!
//! Each fixture is a `SignedBeaconBlock` in SSZ that a public beacon node served, with the header root that the same
//! node reported. A parser that hashes a layout wrongly cannot produce the header root of the node, so the root is the
//! proof that the layout is right. See `tests/fixtures/ethereum-mainnet-blocks/*.json` for the slots and the source host.

use alloy_primitives::B256;
use lc_core::chain::ForkName;
use lc_core::layout::block_hash_gindex_for_fork;
use lc_core::ssz::is_valid_exact_branch;
use serde_json::Value;
use std::path::PathBuf;
use zk_bridge_prover::error::Error;
use zk_bridge_prover::light_client::{BlockView, ChainKind};

fn fixture_path(name: &str) -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("tests/fixtures/ethereum-mainnet-blocks")
        .join(name)
}

fn fixture(fork: &str) -> (Vec<u8>, Value) {
    let bytes = std::fs::read(fixture_path(&format!("{fork}.ssz"))).expect("block bytes");
    let json = std::fs::read(fixture_path(&format!("{fork}.json"))).expect("fixture json");
    (
        bytes,
        serde_json::from_slice(&json).expect("fixture json parses"),
    )
}

fn root_of(json: &Value, key: &str) -> B256 {
    json[key].as_str().expect("text").parse().expect("32 bytes")
}

/// Claim: the parser reproduces the header root, the body root and the execution block hash that the node reported, and
/// the block hash branch leads from the block hash to the body root. Why it matters: a message proof from this chain
/// stands on exactly these values.
fn assert_block_matches_node(fork: &str, fork_name: ForkName) {
    let (bytes, json) = fixture(fork);
    let view = BlockView::parse_for_chain(&bytes, ChainKind::Ethereum).expect("the block parses");
    assert_eq!(view.header.slot, json["slot"].as_u64().unwrap());
    assert_eq!(view.header.hash_tree_root(), root_of(&json, "header_root"));
    assert_eq!(view.header.body_root, root_of(&json, "body_root"));
    assert_eq!(
        view.payload.block_hash,
        root_of(&json, "execution_block_hash")
    );
    let gindex = block_hash_gindex_for_fork(fork_name).expect("gindex");
    assert!(is_valid_exact_branch(
        &view.payload.block_hash,
        &view.block_hash_branch,
        gindex,
        &view.header.body_root
    ));
}

#[test]
fn deneb_block_parses_to_the_node_header_root() {
    assert_block_matches_node("deneb", ForkName::Deneb);
}

#[test]
fn electra_block_parses_to_the_node_header_root() {
    assert_block_matches_node("electra", ForkName::Electra);
}

#[test]
fn fulu_block_parses_to_the_node_header_root() {
    assert_block_matches_node("fulu", ForkName::Fulu);
}

/// Claim: a Gloas block is still refused on this path, with the message that names Gloas. Why it matters: a Gloas block
/// has no payload in its body and goes through `GloasBlockView`.
#[test]
fn gloas_block_is_still_refused_on_this_path() {
    let gloas_slot = lc_core::chain::SEPOLIA.fork_schedule.last().unwrap().epoch * 32;
    let mut bytes = vec![0u8; 4 + 96 + 8 + 4];
    bytes[0..4].copy_from_slice(&100u32.to_le_bytes());
    bytes[100..108].copy_from_slice(&(gloas_slot + 5).to_le_bytes());
    let refusal = BlockView::parse_for_chain(&bytes, ChainKind::Sepolia)
        .err()
        .expect("refused");
    assert!(
        matches!(&refusal, Error::Malformed(text) if text.contains("Gloas")),
        "{refusal}"
    );
}

/// Claim: a cut block is `Malformed`, never a panic. Why it matters: a node can serve a cut answer.
#[test]
fn a_truncated_fulu_block_is_malformed() {
    let (bytes, _) = fixture("fulu");
    let refusal = BlockView::parse_for_chain(&bytes[..1000], ChainKind::Ethereum)
        .err()
        .expect("refused");
    assert!(matches!(refusal, Error::Malformed(_)), "{refusal}");
}
