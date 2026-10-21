//! Derives `pulsechain/historical_paths.json`: real historical-path ancestry proofs, and the check of the era formula.
//!
//! Usage: `derive-historical-fixtures <era-dir> <anchor-dir> <fixture-dir> <beacon-url> <fetched-on> <name=slot>...`
//!
//! Input (written by `scripts/fetch-fixtures.sh historical` into the two cache directories):
//! - `<anchor-dir>`: `attested_state.ssz` and `attested_header.json`, the anchor state (about 18 MB) and its header.
//! - `<era-dir>`: for every deposit slot `S`: `block_<S>.ssz` and `header_<S>.json`. For every era `E = S / 8192`:
//!   `era_roots_<E>.txt`, the canonical block roots of the slots of the era (`<slot> <root>` per line, empty slots are
//!   absent) and the root of the last block before the era. The era's `block_roots` vector is rebuilt from it: an empty
//!   slot repeats the root of the block before it (`process_slot` stores the root of `latest_block_header`).
//!   The tool does not use a state of the era: on 2026-10-20 the node served every state older than a few hundred slots
//!   with its newest historical summary missing, so those states do not hash to the root in their header.
//!
//! The tool checks the era formula on real data: `historical_summaries[E - capellaEra].block_summary_root` of the anchor state
//! must equal the hash tree root of the 8192 block roots of era `E`. It stops with a message when it does not. Every branch
//! is computed from the real anchor state and then verified with the generalized index of `lc_core::ancestry`, against the
//! state root that the node reports. Only branches and roots are written, never states.

use alloy_primitives::B256;
use lc_core::ancestry::historical_leaf_gindex;
use lc_core::chain::PULSECHAIN;
use lc_core::era::{era_block_roots, historical_ancestry_branch};
use lc_core::layout::CAPELLA_DENEB_STATE_LAYOUT;
use lc_core::ssz::{hash_pair, is_valid_exact_branch, merkleize};
use lc_testkit::derive_support::{header_json, hex_list, read_block, read_json, write_fixture};
use lc_testkit::json::{beacon_header, hex_b256};
use lc_testkit::ssz_state::parse_state;
use serde_json::{json, Value};
use std::collections::BTreeMap;
use std::path::Path;

const SLOTS_PER_ERA: u64 = 8192;

/// Reads the canonical block roots of an era and rebuilds its `block_roots` vector with `lc_core::era`.
///
/// # Panics
/// Panics when the file lacks a block at or before the first slot of the era.
fn read_era_roots(era_dir: &Path, era: u64) -> Vec<B256> {
    let path = era_dir.join(format!("era_roots_{era}.txt"));
    let text = std::fs::read_to_string(&path).unwrap_or_else(|e| panic!("{}: {e}", path.display()));
    let known: BTreeMap<u64, B256> = text
        .lines()
        .map(|line| {
            let (slot, root) = line.split_once(' ').expect("slot root");
            (slot.parse().expect("slot"), root.parse().expect("root"))
        })
        .collect();
    era_block_roots(era, &known).unwrap_or_else(|e| panic!("{}: {e}", path.display()))
}

fn main() {
    let arguments: Vec<String> = std::env::args().collect();
    assert!(
        arguments.len() >= 7,
        "usage: derive-historical-fixtures <era-dir> <anchor-dir> <fixture-dir> <beacon-url> <fetched-on> <name=slot>..."
    );
    let (era_dir, anchor_dir, out) = (Path::new(&arguments[1]), Path::new(&arguments[2]), Path::new(&arguments[3]));
    let (beacon, fetched_on) = (&arguments[4], &arguments[5]);
    let wanted: Vec<(String, u64)> = arguments[6..]
        .iter()
        .map(|pair| {
            let (name, slot) = pair.split_once('=').expect("name=slot");
            (name.to_string(), slot.parse().expect("slot"))
        })
        .collect();

    // The anchor: header and state, hashed in full and compared with the node.
    let anchor_json = read_json(&anchor_dir.join("attested_header.json"));
    let anchor_header = beacon_header(&anchor_json["data"]["header"]["message"]);
    assert_eq!(anchor_header.hash_tree_root(), hex_b256(&anchor_json["data"]["root"]), "anchor header root");
    let anchor = parse_state(&std::fs::read(anchor_dir.join("attested_state.ssz")).expect("anchor state"));
    assert_eq!(anchor.root(), anchor_header.state_root, "the SSZ state hasher disagrees with the node at the anchor");
    let capella_era = PULSECHAIN.capella_era().expect("PulseChain has a Capella entry");
    let anchor_era = anchor_header.slot / SLOTS_PER_ERA;
    assert_eq!(
        anchor.historical_summaries.len() as u64,
        anchor_era - capella_era,
        "the anchor holds one summary for every complete era from capellaEra on"
    );
    let summary_roots: Vec<_> =
        anchor.historical_summaries.iter().map(|(blocks, states)| hash_pair(blocks, states)).collect();
    println!(
        "anchor slot {} state root {:#x} matches the node; {} summaries",
        anchor.slot,
        anchor.root(),
        summary_roots.len()
    );

    let mut era_vectors: BTreeMap<u64, Vec<B256>> = BTreeMap::new();
    let mut checks = BTreeMap::new();
    let mut entries = Vec::new();
    for (name, slot) in &wanted {
        let era = slot / SLOTS_PER_ERA;
        let index = (era - capella_era) as usize;
        let era_roots = era_vectors.entry(era).or_insert_with(|| read_era_roots(era_dir, era)).clone();
        let era_root = merkleize(&era_roots);
        let (summary_blocks, summary_states) = anchor.historical_summaries[index];

        // The rebuild method, checked against the anchor state: where the era overlaps the anchor's own `block_roots`
        // (slots anchor - 8192 .. anchor - 1), both must agree.
        let era_start = era * SLOTS_PER_ERA;
        let overlap_start = era_start.max(anchor_header.slot - SLOTS_PER_ERA);
        let overlap_end = (era_start + SLOTS_PER_ERA).min(anchor_header.slot);
        for overlap_slot in overlap_start..overlap_end {
            assert_eq!(
                era_roots[(overlap_slot % SLOTS_PER_ERA) as usize],
                anchor.block_roots[(overlap_slot % SLOTS_PER_ERA) as usize],
                "the rebuilt root of slot {overlap_slot} differs from the anchor state"
            );
        }
        let overlap = overlap_end.saturating_sub(overlap_start);

        // The era formula, on real data.
        assert_eq!(
            summary_blocks, era_root,
            "ERA FORMULA FAILED: historical_summaries[{index}] of the anchor is not the root of the block_roots of era {era}"
        );
        checks.entry(era).or_insert_with(|| {
            json!({
                "era": era,
                "index": index,
                "capella_era": capella_era,
                "anchor_state_summaries_length": anchor.historical_summaries.len(),
                "block_summary_root_in_anchor_state": format!("{summary_blocks:#x}"),
                "hash_tree_root_of_era_block_roots": format!("{era_root:#x}"),
                "equal": summary_blocks == era_root,
                "state_summary_root_in_anchor_state": format!("{summary_states:#x}"),
                "slots_compared_with_anchor_block_roots": overlap,
            })
        });

        // The deposit block: real header and body, checked against the node.
        let block =
            read_block(&era_dir.join(format!("block_{slot}.ssz")), &era_dir.join(format!("header_{slot}.json")));
        let deposit = &block.block.header;
        assert_eq!(deposit.slot, *slot);
        let leaf = deposit.hash_tree_root();
        assert_eq!(era_roots[(slot % SLOTS_PER_ERA) as usize], leaf, "block_roots of the era names this block");

        // The ancestry branch, built and checked against the anchor state root by lc-core.
        let branch = historical_ancestry_branch(&anchor, capella_era, *slot, &era_roots)
            .unwrap_or_else(|e| panic!("the ancestry branch of slot {slot}: {e}"));
        let gindex =
            historical_leaf_gindex(CAPELLA_DENEB_STATE_LAYOUT.historical_summaries_gindex, index as u64, *slot)
                .expect("index in range");
        assert!(
            is_valid_exact_branch(&leaf, &branch, gindex, &anchor_header.state_root),
            "the ancestry branch of slot {slot} does not verify at generalized index {gindex}"
        );
        assert_eq!(branch.len(), 44);
        println!("{name}: slot {slot} era {era} index {index} verifies at generalized index {gindex}");
        entries.push(json!({
            "name": name,
            "era": era,
            "index": index,
            "deposit_header": header_json(deposit),
            "ancestry_branch": hex_list(&branch),
            "block_hash_branch": hex_list(&block.block_hash_branch),
            "execution_block_number": block.block.payload.block_number,
            "execution_block_hash": format!("{:#x}", block.block.payload.block_hash),
        }));
    }

    let source = format!(
        "derived from {beacon}: SSZ anchor state {:#x} (GET /eth/v2/debug/beacon/states/<root>), the canonical block root of every slot of eras {:?} (GET /eth/v1/beacon/blocks/<slot>/root), SSZ blocks (GET /eth/v2/beacon/blocks/<slot>) and headers (GET /eth/v1/beacon/headers/<slot>)",
        anchor_header.state_root,
        era_vectors.keys().collect::<Vec<_>>()
    );
    let response: Value = json!({
        "anchor_header": header_json(&anchor_header),
        "anchor_header_root": format!("{:#x}", anchor_header.hash_tree_root()),
        "era_formula_checks": checks.into_values().collect::<Vec<_>>(),
        "entries": entries,
    });
    write_fixture(out, "historical_paths.json", &source, fetched_on, response);
}
