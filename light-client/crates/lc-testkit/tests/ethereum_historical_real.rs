//! Real Ethereum mainnet data for the historical ancestry path: a real Fulu anchor state and real blocks in older eras.
//!
//! `ethereum/historical_paths.json` was derived on 2026-11-20 by `derive-historical-fixtures --chain ethereum` from a real
//! anchor state (the finalized state at slot 15698784, era 1916, about 340 MB, not on file) and the canonical block root of
//! every slot of eras 1910, 1913, 1914 and 1915, all from one.valve.city (Ethereum mainnet beacon API). Every branch was
//! computed from the real state and checked against the state root that the node reported. `ethereum/historical_execution_blocks.json`
//! holds the execution blocks of the same entries, from the Ethereum mainnet execution RPC of the same host: an
//! independent source for the block hash at the end of each block hash branch.
//!
//! The PulseChain version of these tests is in `pulsechain_real.rs` (Capella layout, capellaEra 0, 44 entry branch). Here
//! the anchor is in the Electra layout (Fulu), `historical_summaries` is field gindex 91, the branch has 45 entries, and
//! capellaEra is 758, so the list index is `era - 758`, not the era.

use alloy_primitives::B256;
use lc_core::ancestry::{
    ancestry_leaf_gindex, ancestry_path_for_slots, block_roots_leaf_gindex, historical_leaf_gindex, AncestryPath,
};
use lc_core::chain::{ForkName, ETHEREUM_MAINNET};
use lc_core::layout::{block_hash_gindex_for_fork, ELECTRA_STATE_LAYOUT};
use lc_core::ssz::{hash_pair, is_valid_exact_branch};
use lc_core::types::BeaconBlockHeader;
use lc_testkit::json::{beacon_header, branch, hex_b256, load_response};
use serde_json::Value;

const CAPELLA_ERA: u64 = 758;

/// The historical entries: both sides of the era edge 1913/1914, a middle block of era 1914, the last block of era 1914,
/// and a middle block six eras before the anchor.
const HISTORICAL_ENTRIES: [&str; 5] =
    ["era_previous_last_block", "era_first_block", "era_middle_block", "era_last_block", "older_era_block"];

/// The last block of the era before the anchor's era: fewer than 8192 slots before the anchor, so the bridge takes the
/// recent path for it.
const RECENT_ENTRY: &str = "recent_era_last_block";

struct Paths {
    anchor: BeaconBlockHeader,
    response: Value,
}

impl Paths {
    fn load() -> Self {
        let response = load_response("ethereum/historical_paths.json");
        let anchor = beacon_header(&response["anchor_header"]);
        assert_eq!(anchor.hash_tree_root(), hex_b256(&response["anchor_header_root"]), "anchor header root");
        Self { anchor, response }
    }

    fn entry(&self, name: &str) -> &Value {
        self.response["entries"]
            .as_array()
            .expect("entries")
            .iter()
            .find(|candidate| candidate["name"] == name)
            .unwrap_or_else(|| panic!("no historical entry {name}"))
    }

    fn source_header(&self, name: &str) -> BeaconBlockHeader {
        beacon_header(&self.entry(name)["deposit_header"])
    }

    fn ancestry_branch(&self, name: &str) -> Vec<B256> {
        branch(&self.entry(name)["ancestry_branch"])
    }
}

/// Claim: the anchor is a real Fulu state (Electra layout), and the chain configuration gives capellaEra 758.
#[test]
fn the_anchor_is_a_real_fulu_header_and_capella_era_is_758() {
    let paths = Paths::load();
    assert_eq!(ETHEREUM_MAINNET.capella_era().unwrap(), CAPELLA_ERA);
    assert_eq!(ETHEREUM_MAINNET.fork_at_slot(paths.anchor.slot), ForkName::Fulu);
    assert_eq!(ELECTRA_STATE_LAYOUT.historical_summaries_gindex, 91);
}

/// Claim: the era formula holds on real Ethereum data. For each source era, the entry at list position `era - capellaEra`
/// of the anchor's `historical_summaries` has a `block_summary_root` equal to the hash tree root of the 8192 block roots
/// of that era, rebuilt from the canonical block roots of the node. The list holds one entry for every complete era
/// from capellaEra on. The climb from each real header through 13 levels reaches the same root.
/// Why it matters: an off-by-one in `era - capellaEra` would make every Ethereum era unreachable or point at its neighbour.
#[test]
fn real_ethereum_era_formula_matches_the_node() {
    let paths = Paths::load();
    let anchor_era = paths.anchor.slot / 8192;
    let checks = paths.response["era_formula_checks"].as_array().expect("checks");
    assert!(checks.len() >= 4, "eras 1910, 1913, 1914 and 1915");
    for check in checks {
        let era = check["era"].as_u64().unwrap();
        assert_eq!(check["capella_era"].as_u64().unwrap(), CAPELLA_ERA);
        assert_eq!(check["index"].as_u64().unwrap(), era - CAPELLA_ERA, "index = era - capellaEra");
        assert_eq!(check["anchor_state_summaries_length"].as_u64().unwrap(), anchor_era - CAPELLA_ERA);
        assert_eq!(check["equal"], true);
        assert_eq!(check["block_summary_root_in_anchor_state"], check["hash_tree_root_of_era_block_roots"]);
        assert_ne!(check["block_summary_root_in_anchor_state"], format!("{:#x}", B256::ZERO));
    }
    // The era before the anchor's era overlaps the anchor's own block_roots: the rebuild agreed with the state there.
    assert!(checks.iter().any(|check| check["slots_compared_with_anchor_block_roots"].as_u64().unwrap() > 1000));

    for name in HISTORICAL_ENTRIES.iter().chain([&RECENT_ENTRY]) {
        let source = paths.source_header(name);
        let branch = paths.ancestry_branch(name);
        let era = source.slot / 8192;
        let check = checks.iter().find(|check| check["era"] == era).expect("a check for the era");
        let mut node = source.hash_tree_root();
        for (height, sibling) in branch[..13].iter().enumerate() {
            node = if (source.slot % 8192) >> height & 1 == 1 {
                hash_pair(sibling, &node)
            } else {
                hash_pair(&node, sibling)
            };
        }
        assert_eq!(format!("{node:#x}"), check["block_summary_root_in_anchor_state"].as_str().unwrap(), "{name}");
    }
}

/// Claim: a real Ethereum header in an older era is proven under a real Fulu anchor state through
/// `historical_summaries`, with an exact 45 entry branch, at the generalized index that the bridge picks: both sides of
/// an era edge, a middle block, the last block of an era, and a block six eras back. The last block of the era before
/// the anchor's era is fewer than 8192 slots back: the bridge takes the recent path for it, and its historical branch (a
/// valid path of the real state) fails at the `block_roots` index.
#[test]
fn real_ethereum_historical_ancestry_verifies() {
    let paths = Paths::load();
    let field = ELECTRA_STATE_LAYOUT.historical_summaries_gindex;
    for name in HISTORICAL_ENTRIES.iter().chain([&RECENT_ENTRY]) {
        let source = paths.source_header(name);
        let leaf = source.hash_tree_root();
        let branch = paths.ancestry_branch(name);
        assert_eq!(branch.len(), 45, "{name}");
        let index = source.slot / 8192 - CAPELLA_ERA;
        let historical_gindex = historical_leaf_gindex(field, index, source.slot).unwrap();
        assert!(
            is_valid_exact_branch(&leaf, &branch, historical_gindex, &paths.anchor.state_root),
            "{name}: slot {} at generalized index {historical_gindex}",
            source.slot
        );
        let bridge_gindex = ancestry_leaf_gindex(&ETHEREUM_MAINNET, paths.anchor.slot, source.slot).unwrap();
        let path = ancestry_path_for_slots(paths.anchor.slot, source.slot).unwrap();
        if *name == RECENT_ENTRY {
            assert_eq!(path, AncestryPath::Recent, "fewer than 8192 slots before the anchor");
            assert_ne!(bridge_gindex, historical_gindex);
            assert!(!is_valid_exact_branch(&leaf, &branch, bridge_gindex, &paths.anchor.state_root), "reverse mix-up");
            continue;
        }
        assert_eq!(path, AncestryPath::Historical, "{name}");
        assert_eq!(bridge_gindex, historical_gindex, "{name}: the bridge picks the same index");
    }
    let first = paths.source_header("era_first_block").slot;
    assert_eq!(first % 8192, 0);
    assert_eq!(paths.source_header("era_previous_last_block").slot, first - 1);
    assert_eq!(paths.source_header("era_last_block").slot % 8192, 8191);
    assert_eq!(paths.source_header(RECENT_ENTRY).slot % 8192, 8191);
    assert!(paths.anchor.slot / 8192 - paths.source_header("older_era_block").slot / 8192 >= 3, "several eras back");
}

/// Claim: on real Ethereum data every wrong version of the proof fails: the neighbouring list index on either side, the
/// era itself used as the index (capellaEra forgotten), the `block_roots` index, a padded branch, a short branch and each
/// flipped entry. The honest branch passes (control).
#[test]
fn real_ethereum_historical_ancestry_rejects_wrong_index_length_and_entries() {
    let paths = Paths::load();
    let field = ELECTRA_STATE_LAYOUT.historical_summaries_gindex;
    for name in HISTORICAL_ENTRIES {
        let source = paths.source_header(name);
        let (leaf, root) = (source.hash_tree_root(), paths.anchor.state_root);
        let branch = paths.ancestry_branch(name);
        let era = source.slot / 8192;
        let index = era - CAPELLA_ERA;
        let check = |branch: &[B256], gindex: u64| is_valid_exact_branch(&leaf, branch, gindex, &root);
        let gindex = historical_leaf_gindex(field, index, source.slot).unwrap();
        assert!(check(&branch, gindex), "{name}: control");
        for wrong in [index + 1, index - 1] {
            assert!(
                !check(&branch, historical_leaf_gindex(field, wrong, source.slot).unwrap()),
                "{name}: index {wrong}"
            );
        }
        assert!(
            !check(&branch, historical_leaf_gindex(field, era, source.slot).unwrap()),
            "{name}: the era as the index"
        );
        let recent = block_roots_leaf_gindex(ELECTRA_STATE_LAYOUT.block_roots_gindex, source.slot).unwrap();
        assert!(!check(&branch, recent), "{name}: block_roots index");
        let mut padded = branch.clone();
        padded.insert(0, B256::ZERO);
        assert!(!check(&padded, gindex), "{name}: padded");
        assert!(!check(&branch[..44], gindex), "{name}: short");
        for position in 0..branch.len() {
            let mut flipped = branch.clone();
            flipped[position].0[7] ^= 1;
            assert!(!check(&flipped, gindex), "{name}: entry {position}");
        }
    }
}

/// Claim: the block hash branch of each real source block leads from the execution block hash to the body root of its
/// header at the Deneb-and-later index 812 (9 entries), and the block hash and number equal what the execution RPC
/// returned for that block.
/// Why it matters: the historical path ends at the beacon header; this step ties it to the execution block whose receipts a
/// message proof opens.
#[test]
fn real_ethereum_block_hash_branches_match_the_execution_rpc() {
    let paths = Paths::load();
    let blocks = load_response("ethereum/historical_execution_blocks.json");
    let gindex = block_hash_gindex_for_fork(ForkName::Fulu).unwrap();
    assert_eq!(gindex, 812);
    for name in HISTORICAL_ENTRIES.iter().chain([&RECENT_ENTRY]) {
        let entry = paths.entry(name);
        let source = paths.source_header(name);
        assert_eq!(ETHEREUM_MAINNET.fork_at_slot(source.slot), ForkName::Fulu, "{name}");
        let hash = hex_b256(&entry["execution_block_hash"]);
        let block_hash_branch = branch(&entry["block_hash_branch"]);
        assert_eq!(block_hash_branch.len(), 9, "{name}");
        assert!(is_valid_exact_branch(&hash, &block_hash_branch, gindex, &source.body_root), "{name}");
        let number = entry["execution_block_number"].as_u64().unwrap();
        let rpc = blocks
            .as_array()
            .expect("blocks")
            .iter()
            .find(|block| {
                u64::from_str_radix(block["number"].as_str().unwrap().trim_start_matches("0x"), 16).unwrap() == number
            })
            .unwrap_or_else(|| panic!("{name}: the RPC block {number}"));
        assert_eq!(hex_b256(&rpc["hash"]), hash, "{name}: the execution RPC agrees");
    }
}
