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
    table_fork_version, verify_finalized_execution, verify_light_client_fold_with_fork_versions, verify_sync_aggregate,
    FoldStep,
};
use lc_core::Error;
use lc_testkit::json::{fixtures_dir, load_fixture, load_response};
use lc_testkit::real_proofs::{has_branch, with_known_branch};

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
    let proven = verify_finalized_execution(&header).expect("the real anchor verifies");
    assert_eq!(proven.block_hash, keccak256(real_header_rlp()));
    assert_eq!(proven.block_number, decode_execution_anchor_fields(&real_header_rlp()).unwrap().number);

    let mut flipped = header.clone();
    flipped.execution_branch[3].0[1] ^= 1;
    assert_eq!(verify_finalized_execution(&flipped), Err(Error::InvalidExecutionBranch("finalized")));

    let mut changed = header.clone();
    let last = changed.execution_header_rlp.len() - 1;
    changed.execution_header_rlp[last] ^= 1;
    assert_eq!(verify_finalized_execution(&changed), Err(Error::ExecutionHeaderHashMismatch));

    // The RLP of the parent block: a real header, but not the one the state names.
    let mut parent = header.clone();
    let wrapper = load_fixture("sepolia/gloas_head_execution_header.json");
    parent.execution_header_rlp = hex::decode(wrapper["parent_raw_header"].as_str().unwrap()).unwrap();
    assert_ne!(parent.execution_header_rlp, real_header_rlp());
    assert!(decode_execution_anchor_fields(&parent.execution_header_rlp).is_ok(), "a real header that decodes");
    assert_eq!(verify_finalized_execution(&parent), Err(Error::ExecutionHeaderHashMismatch));

    // The bid hash is not the anchor: the same branch with the bid `block_hash` of the finalized block gives no match.
    let mut bid = header.clone();
    bid.execution.block_hash = B256::repeat_byte(0x24);
    assert_eq!(verify_finalized_execution(&bid), Err(Error::InvalidExecutionBranch("finalized")));
}

/// Claim: the branch of `genesis_validators_root` for the real Sepolia head update is on file.
/// Why it matters: without it, `a_real_gloas_fold_gives_a_real_execution_block` would fall back to its reduced part and the
/// real Sepolia fold would no longer run end to end.
#[test]
fn sepolia_attested_state_proofs_are_on_file() {
    assert!(has_branch(&with_known_branch(real_update())));
}

/// Claim: a REAL Gloas fold verifies end to end. The store holds the real current committee of the finalized state. The
/// update is the real finality update, with its finalized header anchored in the real state. The aggregate signature is
/// real (BLS). The output has the real execution block hash and number, and no zero. The control: one flipped
/// participation bit that is set (a signer removed) breaks the signature, so the signature check ran on real data.
///
/// The branch of `genesis_validators_root` lies under the ATTESTED state, and only the finalized state is on file (see
/// `lc_testkit::real_proofs`). Without that branch the test checks what does not need it: the real signature and the
/// removed signer on the aggregate, the real execution block of the anchor, and the point where the fold stops. With the
/// branch on file it runs the whole fold.
#[test]
fn a_real_gloas_fold_gives_a_real_execution_block() {
    let mut update = with_known_branch(real_update());
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
    let mut unsigned = update.clone();
    let set_bit = (0..512).find(|index| unsigned.sync_aggregate.is_set(*index)).unwrap();
    unsigned.sync_aggregate.sync_committee_bits[set_bit / 8] &= !(1 << (set_bit % 8));

    // The finality branch (index 735) is real, in the Gloas layout.
    assert!(is_valid_normalized_merkle_branch(
        &update.finalized_header.beacon.hash_tree_root(),
        &update.finality_branch,
        FINALIZED_ROOT_GINDEX_GLOAS,
        &update.attested_header.beacon.state_root,
    ));

    if !has_branch(&update) {
        // The signature check does not need the branch: run it on the aggregate.
        let signature_under_the_table_version = |candidate: &LightClientUpdate| {
            verify_sync_aggregate(
                &SEPOLIA,
                &store.current_sync_committee,
                &candidate.sync_aggregate,
                &candidate.attested_header.beacon.hash_tree_root(),
                table_fork_version(&SEPOLIA, candidate.signature_slot),
            )
        };
        assert_eq!(signature_under_the_table_version(&update), Ok(()), "the real aggregate verifies");
        assert_eq!(signature_under_the_table_version(&unsigned), Err(Error::SignatureVerificationFailed));
        let proven = verify_finalized_execution(&update.finalized_header).expect("the real anchor");
        assert_eq!(proven.block_hash, keccak256(real_header_rlp()));
        assert_eq!(proven.block_number, decode_execution_anchor_fields(&real_header_rlp()).unwrap().number);
        assert_ne!(proven.block_number, 0);
        assert_eq!(
            verify_light_client_fold_with_fork_versions(&store, &[step(&update)], &SEPOLIA),
            Err(Error::InvalidGenesisValidatorsRootBranch),
            "every earlier check passes, and the fold stops at the missing branch"
        );
        return;
    }
    let output = verify_light_client_fold_with_fork_versions(&store, &[step(&update)], &SEPOLIA).expect("a real fold");
    assert_eq!(output.executionBlockHash, keccak256(real_header_rlp()));
    assert_ne!(output.executionBlockNumber, 0);
    assert_eq!(output.executionBlockNumber, decode_execution_anchor_fields(&real_header_rlp()).unwrap().number);
    assert_eq!(output.newHeaderRoot, update.finalized_header.beacon.hash_tree_root());
    assert_eq!(output.newHeadSlot, update.finalized_header.beacon.slot);
    assert_eq!(
        verify_light_client_fold_with_fork_versions(&store, &[step(&unsigned)], &SEPOLIA),
        Err(Error::SignatureVerificationFailed)
    );
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

/// The real message source: the real execution block X of the fixtures, the real beacon block B (the finalized header of the
/// real update) whose bid names X as `parent_block_hash`, and a real later anchor A. The log is a REAL log of X (a transfer
/// log of Sepolia, not a bridge message), so the proof reaches the log checks and stops there.
fn real_message_proof() -> (lc_testkit::lc_message::abi::MessageProof, B256, alloy_primitives::Address) {
    use alloy_primitives::{Address, Bytes};
    use lc_core::json::{beacon_header, hex_b256, hex_to_bytes};
    let fixture = load_response("sepolia/gloas_message_source.json");
    let nodes = |key: &str| -> Vec<Bytes> { fixture[key].as_array().unwrap().iter().map(hex_to_bytes).collect() };
    let branch = |key: &str| -> Vec<B256> { fixture[key].as_array().unwrap().iter().map(hex_b256).collect() };
    let anchor = beacon_header(&fixture["anchor_header"]);
    let source = beacon_header(&fixture["source_header"]);
    let index = alloy_primitives::U256::from(fixture["transaction_index"].as_u64().unwrap());
    let proof = lc_testkit::lc_message::abi::MessageProof {
        anchorHeader: (&anchor).into(),
        sourceHeader: (&source).into(),
        ancestryBranch: branch("ancestry_branch"),
        blockHashBranch: branch("block_hash_branch"),
        // The state of B is the real state of `gloas_head_state.ssz` (its root is the `state_root` of B).
        sourceFork: lc_testkit::lc_message::ancestry::fork_proof_of_state(&real_state()),
        executionHeaderRlp: Bytes::from(real_header_rlp()),
        receiptProof: nodes("receipt_proof"),
        receiptIndex: index,
        transactionProof: nodes("transaction_proof"),
        transactionIndex: index,
        logIndex: alloy_primitives::U256::ZERO,
    };
    let emitter: Address = fixture["log"]["address"].as_str().unwrap().parse().unwrap();
    (proof, anchor.hash_tree_root(), emitter)
}

/// Claim: the fork proof that the prover builds from the REAL state of B (`fork_proof_of_state`) proves the progressive
/// shape under the real `state_root` of B with the real Sepolia genesis validators root; its version branch is the one of
/// `gloas_fork_version.json` (derived from the same state) and its genesis validators root branch has 5 entries (index
/// 40). The same proof checked against Ethereum's root, or against the root of the anchor state, fails. Why it matters:
/// this is the proof that a message of a Gloas chain carries, built from a real state, so the rule does not rest on
/// synthetic trees alone.
#[test]
fn the_real_source_state_proves_the_progressive_shape() {
    use lc_core::chain::ETHEREUM_MAINNET;
    use lc_core::layout::SHAPE_PROGRESSIVE;
    use lc_testkit::lc_message::ancestry::{fork_proof_of_state, source_shape};
    let state = real_state();
    let proof = fork_proof_of_state(&state);
    let served = load_response("sepolia/gloas_fork_version.json");
    let served_branch: Vec<B256> = served["branch"].as_array().unwrap().iter().map(lc_core::json::hex_b256).collect();
    assert_eq!(proof.versionBranch, served_branch, "the version branch of the fixture");
    assert_eq!(proof.version.as_slice(), &[0x90, 0x00, 0x00, 0x76], "Sepolia's Gloas version");
    assert_eq!(proof.genesisValidatorsRootBranch.len(), 5);
    let source_root = lc_core::json::hex_b256(&served["state_root"]);
    assert_eq!(state.root(), source_root);
    assert_eq!(source_shape(&proof, &source_root, &SEPOLIA.genesis_validators_root), Ok(SHAPE_PROGRESSIVE));
    assert_eq!(
        source_shape(&proof, &source_root, &ETHEREUM_MAINNET.genesis_validators_root),
        Err(Error::InvalidForkShapeProof)
    );
    let fixture = load_response("sepolia/gloas_message_source.json");
    let anchor_state_root = lc_core::json::hex_b256(&fixture["anchor_header"]["state_root"]);
    assert_eq!(
        source_shape(&proof, &anchor_state_root, &SEPOLIA.genesis_validators_root),
        Err(Error::InvalidForkShapeProof)
    );
}

/// Claim: a REAL Gloas message source verifies up to the log. The source block B is the real beacon block whose bid names
/// the real execution block X as `parent_block_hash` (node-served branch of 11 entries at index 2856), its real state
/// proves the progressive shape (`fork_proof_of_state`), the anchor is a real later header whose real state holds B in
/// `block_roots` (index 352), the RLP is the real 23 item header, and the receipt and transaction proofs are real (the
/// tries rebuilt from the node answers have the roots of the header). The beacon path returns the hash of X. The log is
/// not a bridge message, so `verify_message` ends at the log check with `LogTopicMismatch`, which shows that every
/// earlier check passed on real data. (A source of a fork that the schedule does not know yet is the fixture
/// `electra_accept_unscheduled_gloas_source`.)
/// Controls: a flipped branch entry, the RLP of the parent block, a flipped ancestry entry, and a flipped entry of the
/// fork proof each fail with their own error.
#[test]
fn a_real_gloas_message_source_verifies_up_to_the_log() {
    use lc_core::message::MessageContext;
    use lc_testkit::lc_message::ancestry::verify_beacon_path;
    use lc_testkit::lc_message::message::verify_message;
    let (proof, anchor_root, emitter) = real_message_proof();
    let x_hash = keccak256(real_header_rlp());
    assert_eq!(proof.blockHashBranch.len(), 11);
    assert_eq!(verify_beacon_path(&SEPOLIA, &proof, &anchor_root), Ok(x_hash));
    let mut flipped_fork = proof.clone();
    flipped_fork.sourceFork.genesisValidatorsRootBranch[2].0[0] ^= 1;
    assert_eq!(verify_beacon_path(&SEPOLIA, &flipped_fork, &anchor_root), Err(Error::InvalidForkShapeProof));

    let context = MessageContext {
        remote_bridge: emitter,
        local_chain_id: 943,
        remote_chain_id: 11_155_111,
        stored_anchor_root: anchor_root,
    };
    assert_eq!(verify_message(&proof, &context, &SEPOLIA).err(), Some(Error::LogTopicMismatch));

    let mut flipped = proof.clone();
    flipped.blockHashBranch[4].0[0] ^= 1;
    assert_eq!(verify_beacon_path(&SEPOLIA, &flipped, &anchor_root), Err(Error::InvalidBlockHashBranch));
    let wrapper = load_fixture("sepolia/gloas_head_execution_header.json");
    let mut parent = proof.clone();
    parent.executionHeaderRlp = hex::decode(wrapper["parent_raw_header"].as_str().unwrap()).unwrap().into();
    assert_eq!(verify_beacon_path(&SEPOLIA, &parent, &anchor_root), Err(Error::InvalidBlockHashBranch));
    let mut not_ancestor = proof.clone();
    not_ancestor.ancestryBranch[3].0[0] ^= 1;
    assert_eq!(verify_beacon_path(&SEPOLIA, &not_ancestor, &anchor_root), Err(Error::InvalidAncestryBranch));
    // The strict decoder of the earlier forks does not read this header: the Gloas rule uses the tolerant one.
    assert!(decode_execution_header(&proof.executionHeaderRlp).is_err());
}

/// Claim: the Gloas block parser reproduces the body root of the REAL block B, and its bid branch equals the branch that the
/// beacon node served (11 entries at index 2856, `execution_branch` of the light-client header), for the bid
/// `parent_block_hash` that equals `state.latest_block_hash` of the state of B. A second real block with an attestation, a
/// payload attestation and execution requests also hashes to the root of its header (`BUSY_BODY_ROOT`, read from the node).
/// Controls: a flipped byte of the block changes the root; the branch fails at the neighbouring index 2857.
#[test]
fn the_real_gloas_block_hashes_to_its_body_root_and_gives_the_served_branch() {
    use lc_core::ssz_block_gloas::try_parse_gloas_signed_block;
    let bytes = std::fs::read(fixtures_dir().join("sepolia/gloas_head_block.ssz")).unwrap();
    let block = try_parse_gloas_signed_block(&bytes).expect("the real block parses");
    let update = real_update();
    assert_eq!(block.header, update.finalized_header.beacon, "the body root equals the one in the real header");
    assert_eq!(block.bid_parent_block_hash(), update.finalized_header.execution_block_hash());
    assert_eq!(block.bid_parent_block_hash(), real_state().latest_block_hash().unwrap());
    let branch = block.bid_parent_block_hash_branch();
    assert_eq!(branch, update.finalized_header.execution_branch, "the branch that the node served");
    assert!(is_valid_exact_branch(
        &block.bid_parent_block_hash(),
        &branch,
        BLOCK_HASH_GINDEX_GLOAS,
        &block.header.body_root
    ));
    assert!(!is_valid_exact_branch(&block.bid_parent_block_hash(), &branch, 2857, &block.header.body_root));

    let mut changed = bytes.clone();
    let middle = changed.len() / 2;
    changed[middle] ^= 1;
    let other = try_parse_gloas_signed_block(&changed);
    assert!(other.map_or(true, |other| other.header.body_root != block.header.body_root));

    let busy = std::fs::read(fixtures_dir().join("sepolia/gloas_busy_block.ssz")).unwrap();
    let busy = try_parse_gloas_signed_block(&busy).expect("the busy block parses");
    assert_eq!(format!("{:#x}", busy.header.body_root), BUSY_BODY_ROOT);
}

/// The `body_root` that the beacon node reported for the header of `gloas_busy_block.ssz` (slot 11441187).
const BUSY_BODY_ROOT: &str = "0xcce11969f38eca9cb18151ffe7e288f6ba46949c8164c161dc1720fc83b151f4";
