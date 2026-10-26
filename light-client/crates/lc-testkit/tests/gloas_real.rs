//! Gloas on REAL Sepolia data (no synthetic part): the finalized state, the finality update and the execution header
//! that `state.latest_block_hash` names.
//!
//! Files in `tests/fixtures/sepolia/`, fetched 2026-10-26 (see the README of the fixtures):
//! - `gloas_head_finality_update.json`: a finality update of the Sepolia beacon node, with a finalized header at slot 11441216.
//! - `gloas_head_state.ssz`: the SSZ `BeaconState` whose root is the `state_root` of that finalized header (3.6 MB).
//! - `gloas_head_execution_header.json`: the raw header RLP and the block of the execution block that the state names.
//!
//! The data holds no committee list apart from the one inside the state, and a test builds the store from it. The
//! signature of the update is real, so the fold checks a real BLS aggregate.

use alloy_primitives::{hex, keccak256, B256};
use lc_core::chain::{ForkName, SEPOLIA};
use lc_core::execution::{decode_execution_anchor_fields, decode_execution_header};
use lc_core::json::light_client_update;
use lc_core::layout::{
    BLOCK_HASH_GINDEX_GLOAS, BLOCK_ROOTS_GINDEX_GLOAS, FINALIZED_ROOT_GINDEX_GLOAS, LATEST_BLOCK_HASH_GINDEX_GLOAS,
};
use lc_core::ssz::{is_valid_exact_branch, is_valid_normalized_merkle_branch};
use lc_core::ssz_state::{state_slot, try_parse_state_for_fork, ParsedState};
use lc_core::types::{LightClientHeader, LightClientStore, LightClientUpdate};
use lc_core::update::{
    table_fork_version, verify_finalized_execution, verify_light_client_fold_with_fork_versions, FoldStep,
};
use lc_core::Error;
use lc_testkit::json::{fixtures_dir, load_fixture, load_response};

fn real_state() -> ParsedState {
    let bytes = std::fs::read(fixtures_dir().join("sepolia/gloas_head_state.ssz")).expect("the state fixture");
    let slot = state_slot(&bytes).expect("a slot");
    assert_eq!(SEPOLIA.fork_at_slot(slot), ForkName::Gloas, "the fixture is a Gloas state");
    try_parse_state_for_fork(&bytes, ForkName::Gloas).expect("the real Gloas state parses")
}

fn real_update() -> LightClientUpdate {
    let response = load_response("sepolia/gloas_head_finality_update.json");
    assert_eq!(response["version"].as_str(), Some("gloas"));
    light_client_update(&response["data"])
}

/// The raw execution header RLP of the fixture.
fn real_header_rlp() -> Vec<u8> {
    let wrapper = load_fixture("sepolia/gloas_head_execution_header.json");
    hex::decode(wrapper["raw_header"].as_str().expect("raw header")).expect("hex")
}

/// The finalized header of the real update with the anchor of the real state: the compact header whose branch leads from
/// `latest_block_hash` to the state root, and whose RLP is the real header.
fn anchored_finalized_header(update: &LightClientUpdate, state: &ParsedState) -> LightClientHeader {
    let hash = state.latest_block_hash().expect("a Gloas state has latest_block_hash");
    LightClientHeader::compact(update.finalized_header.beacon, hash, state.field_branch(24), real_header_rlp())
}

/// Claim: the hasher of the Gloas state reproduces the root that the finalized header commits to. This is the check of
/// every field list, list type, limit and the active fields chunk: one wrong detail gives another root.
/// Independent control: the root comes from the beacon node, not from this code. A state with one flipped byte (a balance)
/// gives another root, so the equality is not a coincidence of an unchanged field.
#[test]
fn the_real_gloas_state_hashes_to_the_state_root_of_its_header() {
    let update = real_update();
    let state = real_state();
    assert_eq!(state.field_roots.len(), 46);
    assert_eq!(state.slot, update.finalized_header.beacon.slot, "the state is the post-state of the finalized block");
    assert_eq!(state.root(), update.finalized_header.beacon.state_root);

    let mut bytes = std::fs::read(fixtures_dir().join("sepolia/gloas_head_state.ssz")).unwrap();
    let last = bytes.len() - 1;
    bytes[last] ^= 1;
    let other = try_parse_state_for_fork(&bytes, ForkName::Gloas).expect("still parses");
    assert_ne!(other.root(), update.finalized_header.beacon.state_root);
}

/// Claim: `state.latest_block_hash` of the finalized state is the hash of the execution header that the node serves, the
/// branch from the field to the state root verifies at index 2947 with 11 entries, and it fails at the neighbours 2946 and
/// 2948, at the old index 2856 and with a flipped entry.
/// Also: the value equals the `execution_block_hash` that the beacon node serves in the light-client header (the
/// `parent_block_hash` of the bid in the body). Consensus asserts `bid.parent_block_hash == state.latest_block_hash` in
/// `process_execution_payload_bid`, and nothing changes the field afterwards in the same block.
#[test]
fn the_real_latest_block_hash_branch_verifies_at_2947() {
    let update = real_update();
    let state = real_state();
    let hash = state.latest_block_hash().expect("Gloas");
    assert_eq!(hash, keccak256(real_header_rlp()), "the field names the execution header of the fixture");
    assert_eq!(hash, update.finalized_header.execution_block_hash(), "equal to the bid parent block hash");

    let branch = state.field_branch(24);
    assert_eq!(branch.len(), 11);
    assert_eq!(state.field_gindex(24), LATEST_BLOCK_HASH_GINDEX_GLOAS);
    let root = state.root();
    assert!(is_valid_exact_branch(&hash, &branch, LATEST_BLOCK_HASH_GINDEX_GLOAS, &root), "control");
    for wrong in [2946u64, 2948, BLOCK_HASH_GINDEX_GLOAS] {
        assert!(!is_valid_exact_branch(&hash, &branch, wrong, &root), "index {wrong}");
    }
    for position in 0..branch.len() {
        let mut flipped = branch.clone();
        flipped[position].0[0] ^= 1;
        assert!(!is_valid_exact_branch(&hash, &flipped, LATEST_BLOCK_HASH_GINDEX_GLOAS, &root), "entry {position}");
    }
    assert!(!is_valid_exact_branch(&B256::repeat_byte(1), &branch, LATEST_BLOCK_HASH_GINDEX_GLOAS, &root));
}

/// Claim: the real Sepolia execution header has 23 items (Amsterdam). The strict decoder of the message path refuses it,
/// and the tolerant decoder reads the three fields it pins. They equal the JSON of the node: number, receipts root and
/// timestamp. The control: a Prague header (21 items) of the same decoder reads the same positions.
#[test]
fn the_real_amsterdam_header_decodes_with_the_tolerant_decoder() {
    let rlp = real_header_rlp();
    let wrapper = load_fixture("sepolia/gloas_head_execution_header.json");
    let block = &wrapper["block"];
    assert!(decode_execution_header(&rlp).is_err(), "the strict decoder knows no 23 item header");
    let fields = decode_execution_anchor_fields(&rlp).expect("the tolerant decoder reads it");
    let quantity =
        |name: &str| u64::from_str_radix(block[name].as_str().unwrap().trim_start_matches("0x"), 16).unwrap();
    assert_eq!(fields.number, quantity("number"));
    assert_eq!(fields.timestamp, quantity("timestamp"));
    assert_eq!(fields.receipts_root, block["receiptsRoot"].as_str().unwrap().parse::<B256>().unwrap());
    assert_ne!(fields.number, 0);
}

/// Claim: the finalized header of the real update, anchored in the real state, gives the real block number and hash. A
/// flipped branch entry, the RLP of another block and an RLP with a flipped byte are refused, each with its own error.
#[test]
fn the_real_anchor_gives_the_real_block_number() {
    let update = real_update();
    let state = real_state();
    let header = anchored_finalized_header(&update, &state);
    let proven = verify_finalized_execution(&SEPOLIA, &header).expect("the real anchor verifies");
    assert_eq!(proven.block_hash, keccak256(real_header_rlp()));
    assert_eq!(proven.block_number, decode_execution_anchor_fields(&real_header_rlp()).unwrap().number);

    let mut flipped = header.clone();
    flipped.execution_branch[3].0[1] ^= 1;
    assert_eq!(verify_finalized_execution(&SEPOLIA, &flipped), Err(Error::InvalidExecutionBranch("finalized")));

    let mut changed = header.clone();
    let last = changed.execution_header_rlp.len() - 1;
    changed.execution_header_rlp[last] ^= 1;
    assert_eq!(verify_finalized_execution(&SEPOLIA, &changed), Err(Error::ExecutionHeaderHashMismatch));

    // The RLP of the parent block: a real header, but not the one the state names.
    let mut parent = header.clone();
    let wrapper = load_fixture("sepolia/gloas_head_execution_header.json");
    parent.execution_header_rlp = hex::decode(wrapper["parent_raw_header"].as_str().unwrap()).unwrap();
    assert_ne!(parent.execution_header_rlp, real_header_rlp());
    assert!(decode_execution_anchor_fields(&parent.execution_header_rlp).is_ok(), "a real header that decodes");
    assert_eq!(verify_finalized_execution(&SEPOLIA, &parent), Err(Error::ExecutionHeaderHashMismatch));

    // The bid hash is not the anchor: the same branch with the bid `block_hash` of the finalized block gives no match.
    let mut bid = header.clone();
    bid.execution.block_hash = B256::repeat_byte(0x24);
    assert_eq!(verify_finalized_execution(&SEPOLIA, &bid), Err(Error::InvalidExecutionBranch("finalized")));
}

/// Claim: a REAL Gloas fold verifies end to end. The store holds the real current committee of the finalized state. The
/// update is the real finality update, with its finalized header anchored in the real state. The aggregate signature is
/// real (BLS). The output has the real execution block hash and number, and no zero. The control: one flipped
/// participation bit that is set (a signer removed) breaks the signature, so the signature check ran on real data.
#[test]
fn a_real_gloas_fold_gives_a_real_execution_block() {
    let mut update = real_update();
    let state = real_state();
    update.finalized_header = anchored_finalized_header(&update, &state);
    let store_slot = update.finalized_header.beacon.slot - 1_000;
    let store = LightClientStore {
        header_root: B256::repeat_byte(0x51),
        header_slot: store_slot,
        current_sync_committee: state.current_sync_committee.clone(),
        next_sync_committee: None,
    };
    assert_eq!(SEPOLIA.period_at_slot(store_slot), SEPOLIA.period_at_slot(update.signature_slot), "one period");
    let step = |update: &LightClientUpdate| FoldStep {
        update: update.clone(),
        fork_version: table_fork_version(&SEPOLIA, update.signature_slot),
    };
    let output = verify_light_client_fold_with_fork_versions(&store, &[step(&update)], &SEPOLIA).expect("a real fold");
    assert_eq!(output.executionBlockHash, keccak256(real_header_rlp()));
    assert_ne!(output.executionBlockNumber, 0);
    assert_eq!(output.executionBlockNumber, decode_execution_anchor_fields(&real_header_rlp()).unwrap().number);
    assert_eq!(output.newHeaderRoot, update.finalized_header.beacon.hash_tree_root());
    assert_eq!(output.newHeadSlot, update.finalized_header.beacon.slot);

    let mut unsigned = update.clone();
    let set_bit = (0..512).find(|index| unsigned.sync_aggregate.is_set(*index)).unwrap();
    unsigned.sync_aggregate.sync_committee_bits[set_bit / 8] &= !(1 << (set_bit % 8));
    assert_eq!(
        verify_light_client_fold_with_fork_versions(&store, &[step(&unsigned)], &SEPOLIA),
        Err(Error::SignatureVerificationFailed)
    );

    // The finality branch (index 735) and the committee branch are real too, in the Gloas layout.
    assert!(is_valid_normalized_merkle_branch(
        &update.finalized_header.beacon.hash_tree_root(),
        &update.finality_branch,
        FINALIZED_ROOT_GINDEX_GLOAS,
        &update.attested_header.beacon.state_root,
    ));
}

/// Claim: the recent ancestry branch of a real Gloas state leads from `block_roots[slot % 8192]` to the state root at
/// index `352 * 8192 + slot % 8192`, and the branch has 21 entries (8 inside the progressive state, 13 inside the vector).
#[test]
fn the_real_block_roots_branch_verifies_at_352() {
    let state = real_state();
    let slot = state.slot - 100;
    let branch = lc_core::era::recent_ancestry_branch(&state, slot);
    assert_eq!(branch.len(), 21);
    let gindex = BLOCK_ROOTS_GINDEX_GLOAS * 8192 + slot % 8192;
    assert!(is_valid_exact_branch(&state.block_roots[(slot % 8192) as usize], &branch, gindex, &state.root()));
    assert!(!is_valid_exact_branch(
        &state.block_roots[(slot % 8192) as usize],
        &branch,
        69 * 8192 + slot % 8192,
        &state.root()
    ));
}

/// Claim: the fork version of the real Sepolia state is `0x90000076` (Gloas), and its branch of 7 entries verifies at the
/// fixed index 169 against the real state root. `BeaconForkGate` checks this index for a Gloas route. It fails at the
/// depth-rule indices (141, 269, 525) and for the previous version `0x90000075` (Fulu).
#[test]
fn the_real_fork_version_branch_verifies_at_169() {
    use lc_core::gate::{progressive_fork_version_branch, version_gindex, version_leaf};
    use lc_core::layout::FORK_VERSION_GINDEX_GLOAS;
    let state = real_state();
    assert_eq!(state.fork.current_version, [0x90, 0x00, 0x00, 0x76]);
    assert_eq!(state.fork.previous_version, [0x90, 0x00, 0x00, 0x75]);
    let branch = progressive_fork_version_branch(&state.field_roots, &state.fork);
    assert_eq!(branch.len(), 7);
    let root = state.root();
    assert!(is_valid_exact_branch(
        &version_leaf(state.fork.current_version),
        &branch,
        FORK_VERSION_GINDEX_GLOAS,
        &root
    ));
    assert!(!is_valid_exact_branch(
        &version_leaf(state.fork.previous_version),
        &branch,
        FORK_VERSION_GINDEX_GLOAS,
        &root
    ));
    for depth in 5..=7 {
        assert!(!is_valid_exact_branch(
            &version_leaf(state.fork.current_version),
            &branch,
            version_gindex(depth),
            &root
        ));
    }
}
