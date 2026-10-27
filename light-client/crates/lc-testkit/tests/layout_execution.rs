//! Execution proofs when the evidence chooses the layout: the header form, the payload form and the anchor of a compact
//! header by branch length.
//!
//! The body of every layout has depth 4, so the only positions of the execution block hash under the body root are 25 (full
//! form, the payload root), 412 (Capella payload, depth 4) and 812 (Deneb payload, depth 5). A compact header names its
//! anchor by the length of its branch: 8, 9 or 11. Every claim that a layout does not own lands on a basic leaf, on
//! padding, on a node that only a hash can fill, or on a node that no layout has. The tests COMPUTE that landing node, and
//! each attack has a control.

use alloy_primitives::{keccak256, B256};
use lc_core::chain::{ChainSpec, ETHEREUM_MAINNET, PULSECHAIN};
use lc_core::execution::decode_execution_anchor_fields;
use lc_core::json::light_client_update;
use lc_core::layout::{
    compact_anchor_for_branch_length, CompactAnchor, CompactAnchorRoot, ExecutionHeaderForm, BLOCK_HASH_GINDEX_GLOAS,
    LATEST_BLOCK_HASH_GINDEX_GLOAS,
};
use lc_core::ssz::{
    active_fields_chunk, branch_for_leaf, gindex_depth, hash_pair, is_valid_exact_branch, merkleize, sha256, u64_chunk,
    zero_hash,
};
use lc_core::ssz_state::{try_parse_state_for_fork, ParsedState};
use lc_core::types::{BeaconBlockHeader, BlobGasFields, ExecutionPayloadHeader, LightClientHeader};
use lc_core::update::{verify_execution_branch, verify_finalized_execution};
use lc_core::Error;
use lc_testkit::json::{fixtures_dir, load_fixture, load_response};
use lc_testkit::receipts::{encode_execution_header, header_hash, prague_header};
use lc_testkit::synthetic::{build_body_proofs, gloas_body, synthetic_payload_header, BodyProofs};

/// A PulseChain slot in the Capella era: the payload has 15 fields.
const CAPELLA_SLOT: u64 = 10_875_663;
/// An Ethereum mainnet slot in the Deneb era (epoch 281250): the payload has 17 fields.
const DENEB_SLOT: u64 = 9_000_000;
/// An Ethereum mainnet slot in the Fulu era: the payload keeps the 17 field list.
const FULU_SLOT: u64 = 15_476_000;
/// The number of leaves of a body that would need depth 5. No layout has such a body.
const DEEP_BODY_LEAVES: usize = 20;

/// A deterministic filler chunk.
fn filler(label: &str, index: u64) -> B256 {
    sha256(format!("{label}/{index}").as_bytes())
}

/// A beacon header with the given roots and filler elsewhere.
fn beacon_header(state_root: B256, body_root: B256) -> BeaconBlockHeader {
    BeaconBlockHeader { slot: 1_000, proposer_index: 1, parent_root: filler("parent", 0), state_root, body_root }
}

/// A compact header under the body root, with no RLP.
fn compact_under_body(body_root: B256, hash: B256, branch: Vec<B256>) -> LightClientHeader {
    LightClientHeader::compact(beacon_header(filler("state", 0), body_root), hash, branch, Vec::new())
}

/// A compact header under the state root, with no RLP.
fn compact_under_state(state_root: B256, hash: B256, branch: Vec<B256>) -> LightClientHeader {
    LightClientHeader::compact(beacon_header(state_root, filler("body", 0)), hash, branch, Vec::new())
}

/// The RLP of a Prague execution header and the block hash that it names.
fn sample_rlp(number: u64) -> (Vec<u8>, B256) {
    let rlp = encode_execution_header(&prague_header(number, filler("receipts", number), filler("txs", number)));
    let hash = header_hash(&rlp);
    (rlp.to_vec(), hash)
}

/// A synthetic payload header and the proofs of its body, for `spec` at `slot`.
fn honest(spec: &ChainSpec, slot: u64, block_hash: B256) -> (ExecutionPayloadHeader, BodyProofs) {
    let payload = synthetic_payload_header(spec, slot, 4_242, block_hash, filler("receipts", 0));
    let proofs = build_body_proofs(spec, slot, &payload);
    (payload, proofs)
}

/// The Capella payload of PulseChain (no blob fields) and its proofs.
fn capella(block_hash: B256) -> (ExecutionPayloadHeader, BodyProofs) {
    let (payload, proofs) = honest(&PULSECHAIN, CAPELLA_SLOT, block_hash);
    assert_eq!(payload.blob_gas, None);
    (payload, proofs)
}

/// The Deneb payload of Ethereum mainnet (blob fields) and its proofs.
fn deneb(block_hash: B256) -> (ExecutionPayloadHeader, BodyProofs) {
    let (payload, proofs) = honest(&ETHEREUM_MAINNET, DENEB_SLOT, block_hash);
    assert!(payload.blob_gas.is_some());
    (payload, proofs)
}

/// The branch from `block_hash` (payload field 12) to the payload root, in the field list that the payload names.
fn payload_block_hash_branch(payload: &ExecutionPayloadHeader) -> Vec<B256> {
    branch_for_leaf(&payload.field_roots(payload.named_form()).unwrap(), 12).1
}

/// A body of [`DEEP_BODY_LEAVES`] leaves (depth 5) with `payload_root` at field 9: the body root and the branch of field 9
/// (5 entries, index 41). It is a body that no layout has.
fn deep_body(payload_root: B256) -> (B256, Vec<B256>) {
    let mut leaves: Vec<B256> = (0..DEEP_BODY_LEAVES as u64).map(|index| filler("deep-body", index)).collect();
    leaves[9] = payload_root;
    branch_for_leaf(&leaves, 9)
}

/// The path of `gindex` below the root: one bit per level, the first bit first.
fn path_bits(gindex: u64) -> Vec<u8> {
    (0..gindex_depth(gindex)).rev().map(|level| ((gindex >> level) & 1) as u8).collect()
}

/// Where the generalized index lands when each container in `depths` is entered in turn: the field that each one selects,
/// and the bits that are left below the last field.
struct Landing {
    fields: Vec<u64>,
    remaining_levels: usize,
}

/// Walks `gindex` through containers whose trees have the given depths.
fn walk(gindex: u64, depths: &[u32]) -> Landing {
    let bits = path_bits(gindex);
    let mut offset = 0;
    let mut fields = Vec::new();
    for depth in depths {
        let end = (offset + *depth as usize).min(bits.len());
        fields.push(bits[offset..end].iter().fold(0u64, |value, bit| value * 2 + u64::from(*bit)));
        offset = end;
    }
    Landing { fields, remaining_levels: bits.len() - offset }
}

/// Asserts that both entry points refuse the header with `InvalidExecutionBranch("finalized")`.
fn assert_refused(header: &LightClientHeader, why: &str) {
    let expected = Err(Error::InvalidExecutionBranch("finalized"));
    assert_eq!(verify_execution_branch(header, "finalized"), expected, "{why}: branch check");
    assert_eq!(verify_finalized_execution(header).map(|_| ()), expected, "{why}: finalized check");
}

/// Claim: `compact_anchor_for_branch_length` maps 8 to 412 and 9 to 812, both under the body root, 11 to 2947 under the
/// state root, and every other length from 0 to 16 to `None`. The positions are written as literals on purpose, so a wrong
/// constant in `lc-core` cannot be copied here.
/// Why it matters: the body has depth 4 in every layout, so the only positions of the execution hash under the body are 25
/// (full form), 412 and 812. The indices 41 (length 5), 668 (length 9, the same as 812) and 1324 (length 10) belong to a
/// body of depth 5 that no layout has, so they have no length here (668 shares the length of 812 and fails the exact check
/// there, see `a_branch_built_for_668_fails_at_812`).
#[test]
fn only_three_branch_lengths_name_an_anchor() {
    let anchor = |gindex, root| Some(CompactAnchor { gindex, root });
    assert_eq!(compact_anchor_for_branch_length(8), anchor(412, CompactAnchorRoot::Body));
    assert_eq!(compact_anchor_for_branch_length(9), anchor(812, CompactAnchorRoot::Body));
    assert_eq!(compact_anchor_for_branch_length(11), anchor(2947, CompactAnchorRoot::State));
    for length in (0..=16).filter(|length| ![8, 9, 11].contains(length)) {
        assert_eq!(compact_anchor_for_branch_length(length), None, "length {length}");
    }
    for (gindex, length) in [(25u64, 4u32), (412, 8), (812, 9), (2947, 11), (41, 5), (668, 9), (1324, 10)] {
        assert_eq!(gindex_depth(gindex), length, "the length of a branch is the depth of its index {gindex}");
    }
}

/// Claim: a compact header whose branch has any length from 0 to 16 other than 8, 9 and 11 is refused with
/// `InvalidExecutionBranch(which)`, and `which` passes through. A full header with a branch of 3 entries (the honest branch
/// cut) or of 5 entries (a leading zero added) is refused, and the honest branch of 4 entries passes. The controls: the
/// honest compact headers of 8 and 9 entries pass.
/// Why it is safe: the check is exact. The length is the depth, so no padding or cut can reach a position that the length
/// does not name.
#[test]
fn a_branch_of_a_length_that_names_no_anchor_is_refused() {
    let (_, capella_proofs) = capella(filler("hash", 1));
    let (_, deneb_proofs) = deneb(filler("hash", 2));
    let capella_header =
        compact_under_body(capella_proofs.body_root, filler("hash", 1), capella_proofs.block_hash_branch);
    let deneb_header = compact_under_body(deneb_proofs.body_root, filler("hash", 2), deneb_proofs.block_hash_branch);
    assert_eq!(capella_header.execution_branch.len(), 8);
    assert_eq!(deneb_header.execution_branch.len(), 9);
    assert_eq!(verify_execution_branch(&capella_header, "attested"), Ok(()), "control: length 8");
    assert_eq!(verify_execution_branch(&deneb_header, "attested"), Ok(()), "control: length 9");

    for length in (0..=16).filter(|length| ![8, 9, 11].contains(length)) {
        let header = compact_under_body(filler("body", 1), filler("hash", 3), vec![filler("entry", 1); length]);
        assert_eq!(
            verify_execution_branch(&header, "attested"),
            Err(Error::InvalidExecutionBranch("attested")),
            "length {length}"
        );
    }

    let (fulu_payload, fulu_proofs) = honest(&ETHEREUM_MAINNET, FULU_SLOT, filler("hash", 4));
    let full = |branch: Vec<B256>| {
        LightClientHeader::full(beacon_header(filler("state", 0), fulu_proofs.body_root), fulu_payload.clone(), branch)
    };
    let honest_branch = fulu_proofs.execution_branch.clone();
    assert_eq!(honest_branch.len(), 4);
    assert_eq!(verify_execution_branch(&full(honest_branch.clone()), "finalized"), Ok(()), "control: 4 entries");
    let cut = honest_branch[1..].to_vec();
    let padded: Vec<B256> = std::iter::once(B256::ZERO).chain(honest_branch.iter().copied()).collect();
    assert_eq!((cut.len(), padded.len()), (3, 5));
    assert_refused(&full(cut), "the honest branch cut to 3 entries");
    assert_refused(&full(padded), "the honest branch with a leading zero, 5 entries");
}

/// Claim: a branch that is honest for index 668 (body field 9 of a depth 5 body, payload field 12) is refused as a compact
/// header, and a branch honest for 1324 (the same on a Deneb payload) is refused too. The 668 branch has 9 entries, the
/// length of 812, so the check at 812 runs and fails. The 1324 branch has 10 entries and names no anchor.
/// Why it is safe: control, each branch verifies at its own index (668 and 1324) against the deep body root, so the branch
/// is honest and only the position is wrong. At 812 the path bits differ from 668 (the body field is read from 4 bits, not 5),
/// so the check hashes the siblings in another order and misses the root.
#[test]
fn a_branch_built_for_668_fails_at_812() {
    let block_hash = filler("hash", 5);
    let (capella_payload, _) = capella(block_hash);
    let capella_payload_root_branch = payload_block_hash_branch(&capella_payload);
    let capella_root = capella_payload.hash_tree_root(ExecutionHeaderForm::Capella).unwrap();
    let (body_root, body_branch) = deep_body(capella_root);
    let branch_668: Vec<B256> = capella_payload_root_branch.iter().chain(&body_branch).copied().collect();
    assert_eq!(branch_668.len(), 9);
    assert!(is_valid_exact_branch(&block_hash, &branch_668, 668, &body_root), "control: honest at 668");
    assert!(!is_valid_exact_branch(&block_hash, &branch_668, 812, &body_root), "wrong at 812");
    assert_eq!(compact_anchor_for_branch_length(9).unwrap().gindex, 812);
    assert_refused(&compact_under_body(body_root, block_hash, branch_668), "668 as a compact header");

    let (deneb_payload, _) = deneb(block_hash);
    let deneb_root = deneb_payload.hash_tree_root(ExecutionHeaderForm::Deneb).unwrap();
    let (deneb_body_root, deneb_body_branch) = deep_body(deneb_root);
    let branch_1324: Vec<B256> =
        payload_block_hash_branch(&deneb_payload).into_iter().chain(deneb_body_branch).collect();
    assert_eq!(branch_1324.len(), 10);
    assert!(is_valid_exact_branch(&block_hash, &branch_1324, 1324, &deneb_body_root), "control: honest at 1324");
    assert_refused(&compact_under_body(deneb_body_root, block_hash, branch_1324), "1324 as a compact header");
}

/// Claim: a compact header with a branch of 5 entries, honest for index 41 (field 9 of a body of depth 5), is refused with
/// `InvalidExecutionBranch`.
/// Why it is safe: no layout has a body of depth 5. Capella has 11 body fields, Deneb 12, Electra and Fulu 13, so the
/// tree has 16 leaves and depth 4. A length of 5 therefore names no anchor. The control: the branch verifies at 41
/// against the deep body root, so only its length is wrong.
#[test]
fn a_depth_five_body_claim_at_41_is_refused() {
    let (payload, _) = deneb(filler("hash", 6));
    let payload_root = payload.hash_tree_root(ExecutionHeaderForm::Deneb).unwrap();
    let (body_root, branch) = deep_body(payload_root);
    assert_eq!(branch.len(), 5);
    assert!(is_valid_exact_branch(&payload_root, &branch, 41, &body_root), "control: honest at 41");
    assert_eq!(compact_anchor_for_branch_length(5), None);
    assert_refused(&compact_under_body(body_root, payload_root, branch), "index 41");
}

/// Claim: index 412 on a Deneb payload passes the BRANCH check and is refused by the keccak check with
/// `ExecutionHeaderHashMismatch`. The control: the honest Deneb compact header (leaf `block_hash`, 9 entries, index 812) with
/// the real RLP verifies and gives the number of the RLP.
/// Why it matters: the Deneb payload has 17 fields, padded to 32 leaves. The node at 412 is the node over payload fields 24
/// and 25 (index 25 * 16 + 12), both padding, so its value is `zero_hash(1)`. A prover can build a valid branch to it,
/// and it is not the zero hash, so the zero check does not stop it. Only keccak stops it: no execution header hashes to
/// `zero_hash(1)`. The keccak check of `verify_finalized_execution` is the only guard here.
#[test]
fn index_412_on_a_deneb_payload_is_caught_only_by_keccak() {
    let (payload, proofs) = deneb(filler("hash", 7));
    let mut leaves = payload.field_roots(ExecutionHeaderForm::Deneb).unwrap();
    assert_eq!(leaves.len(), 17);
    leaves.resize(32, B256::ZERO);
    let (payload_root, payload_branch) = branch_for_leaf(&leaves, 24);
    assert_eq!(payload_root, payload.hash_tree_root(ExecutionHeaderForm::Deneb).unwrap());
    let node = hash_pair(&leaves[24], &leaves[25]);
    assert_eq!(node, zero_hash(1), "fields 24 and 25 are padding");
    assert_ne!(node, B256::ZERO, "the zero check does not refuse it");

    let branch: Vec<B256> = payload_branch[1..].iter().chain(&proofs.execution_branch).copied().collect();
    assert_eq!(branch.len(), 8);
    assert!(is_valid_exact_branch(&node, &branch, 412, &proofs.body_root), "the attacker branch is valid at 412");
    let (rlp, _) = sample_rlp(77);
    let attack = LightClientHeader::compact(beacon_header(filler("state", 0), proofs.body_root), node, branch, rlp);
    assert_eq!(verify_execution_branch(&attack, "finalized"), Ok(()), "the branch check passes");
    assert_eq!(verify_finalized_execution(&attack), Err(Error::ExecutionHeaderHashMismatch));

    let (rlp, hash) = sample_rlp(78);
    let (_, honest_proofs) = deneb(hash);
    assert_eq!(honest_proofs.block_hash_branch.len(), 9);
    let control = LightClientHeader::compact(
        beacon_header(filler("state", 0), honest_proofs.body_root),
        hash,
        honest_proofs.block_hash_branch,
        rlp.clone(),
    );
    let proven = verify_finalized_execution(&control).expect("the honest Deneb compact header verifies");
    assert_eq!(proven.block_hash, keccak256(&rlp));
    assert_eq!(proven.block_number, decode_execution_anchor_fields(&rlp).unwrap().number);
}

/// Claim: a compact header that claims 9 entries (index 812) against a Capella body is refused with
/// `InvalidExecutionBranch("finalized")`, for a branch extended with filler at the front, at the back, and for a leaf that
/// is the `block_number` chunk. The control: the honest Capella branch of 8 entries verifies at 412.
/// Why it is safe: 812 is 25 * 32 + 12. Four bits select body field 9 (`execution_payload`), four bits select payload field 6
/// (`block_number`, a uint64 leaf), and one bit is left below that leaf. The Capella payload tree has depth 4, so the node
/// does not exist: it would be a child of a basic leaf, and no hash can equal a leaf that has no children.
#[test]
fn index_812_on_a_capella_payload_lands_below_block_number() {
    let landing = walk(812, &[4, 4]);
    assert_eq!(landing.fields, vec![9, 6], "body field 9 (execution_payload), payload field 6 (block_number)");
    assert_eq!(landing.remaining_levels, 1, "one level below a uint64 leaf");

    let block_hash = filler("hash", 8);
    let (payload, proofs) = capella(block_hash);
    assert_eq!(proofs.block_hash_branch.len(), 8);
    assert_eq!(
        verify_execution_branch(
            &compact_under_body(proofs.body_root, block_hash, proofs.block_hash_branch.clone()),
            "finalized"
        ),
        Ok(()),
        "control: honest at 412"
    );
    let extend_front: Vec<B256> =
        std::iter::once(filler("extra", 1)).chain(proofs.block_hash_branch.iter().copied()).collect();
    let extend_back: Vec<B256> = proofs.block_hash_branch.iter().copied().chain([filler("extra", 2)]).collect();
    assert_refused(&compact_under_body(proofs.body_root, block_hash, extend_front), "filler at the front");
    assert_refused(&compact_under_body(proofs.body_root, block_hash, extend_back), "filler at the back");

    let leaves = payload.field_roots(ExecutionHeaderForm::Capella).unwrap();
    let (_, number_branch) = branch_for_leaf(&leaves, 6);
    let number_chunk = u64_chunk(payload.block_number);
    let number_proof: Vec<B256> = std::iter::once(filler("extra", 3))
        .chain(number_branch)
        .chain(proofs.execution_branch.iter().copied())
        .collect();
    assert_eq!(number_proof.len(), 9);
    assert_refused(&compact_under_body(proofs.body_root, number_chunk, number_proof), "the block_number chunk as leaf");
}

/// Claim: a full header whose payload names the wrong field list is refused with `InvalidExecutionBranch("finalized")`. The
/// honest Deneb header with `blob_gas` cleared names the Capella list of 15 fields. The honest Capella header with
/// `blob_gas: Some` names the Deneb list of 17. The two roots of the same fields differ. The controls: both honest headers
/// verify.
/// Why it is safe: the body commits to one root. The other field list gives another root, because the Deneb tree is one
/// level deeper. The two forms could collide only if a uint64 leaf (`block_number`, the gas fields) or the padding leaf
/// equalled a hash, because the Capella leaves at depth 4 would have to equal the Deneb nodes at depth 4, and those are
/// hashes.
#[test]
fn a_wrong_payload_form_named_by_the_prover_fails() {
    let (deneb_payload, _) = deneb(filler("hash", 9));
    let (capella_payload, _) = capella(filler("hash", 10));
    let deneb_header = |payload: ExecutionPayloadHeader| {
        let proofs = build_body_proofs(&ETHEREUM_MAINNET, DENEB_SLOT, &deneb_payload);
        LightClientHeader::full(beacon_header(filler("state", 0), proofs.body_root), payload, proofs.execution_branch)
    };
    let capella_header = |payload: ExecutionPayloadHeader| {
        let proofs = build_body_proofs(&PULSECHAIN, CAPELLA_SLOT, &capella_payload);
        LightClientHeader::full(beacon_header(filler("state", 0), proofs.body_root), payload, proofs.execution_branch)
    };
    assert_eq!(verify_execution_branch(&deneb_header(deneb_payload.clone()), "finalized"), Ok(()), "control: Deneb");
    assert_eq!(
        verify_execution_branch(&capella_header(capella_payload.clone()), "finalized"),
        Ok(()),
        "control: Capella"
    );

    let cleared = ExecutionPayloadHeader { blob_gas: None, ..deneb_payload.clone() };
    let set = ExecutionPayloadHeader { blob_gas: Some(BlobGasFields::default()), ..capella_payload.clone() };
    assert_refused(&deneb_header(cleared.clone()), "Deneb payload that names the Capella list");
    assert_refused(&capella_header(set.clone()), "Capella payload that names the Deneb list");

    let deneb_root = deneb_payload.hash_tree_root(ExecutionHeaderForm::Deneb).unwrap();
    let capella_root_of_same_fields = cleared.hash_tree_root(ExecutionHeaderForm::Capella).unwrap();
    assert_ne!(deneb_root, capella_root_of_same_fields);
    let capella_root = capella_payload.hash_tree_root(ExecutionHeaderForm::Capella).unwrap();
    let deneb_root_of_same_fields = set.hash_tree_root(ExecutionHeaderForm::Deneb).unwrap();
    assert_ne!(capella_root, deneb_root_of_same_fields);
    assert_eq!(cleared.named_form(), ExecutionHeaderForm::Capella);
    assert_eq!(set.named_form(), ExecutionHeaderForm::Deneb);
}

/// The real Sepolia state, the finalized header of the real head update and the real execution header RLP.
struct RealSepolia {
    state: ParsedState,
    beacon: BeaconBlockHeader,
    rlp: Vec<u8>,
}

/// Loads the real Sepolia data that `tests/gloas_real.rs` uses.
fn real_sepolia() -> RealSepolia {
    let bytes = std::fs::read(fixtures_dir().join("sepolia/gloas_head_state.ssz")).expect("the state fixture");
    let state = try_parse_state_for_fork(&bytes, lc_core::chain::ForkName::Gloas).expect("the real Gloas state parses");
    let update = light_client_update(&load_response("sepolia/gloas_head_finality_update.json")["data"]);
    let wrapper = load_fixture("sepolia/gloas_head_execution_header.json");
    let rlp = alloy_primitives::hex::decode(wrapper["raw_header"].as_str().expect("raw header")).expect("hex");
    RealSepolia { state, beacon: update.finalized_header.beacon, rlp }
}

/// Claim: on the real Sepolia data, the compact header with 11 entries verifies at 2947 under the state root and
/// `verify_finalized_execution` gives the real hash and number. A flipped RLP byte and the RLP of another block give
/// `ExecutionHeaderHashMismatch`.
/// Why it matters: the branch length alone chose the state anchor. The keccak check binds the RLP to the proven hash, so the
/// number cannot be made up.
#[test]
fn the_real_length_eleven_anchor_verifies_and_needs_the_right_rlp() {
    let real = real_sepolia();
    let hash = real.state.latest_block_hash().expect("a Gloas state has latest_block_hash");
    let branch = real.state.field_branch(24);
    assert_eq!(branch.len(), 11);
    assert_eq!(real.state.root(), real.beacon.state_root);
    assert!(is_valid_exact_branch(&hash, &branch, LATEST_BLOCK_HASH_GINDEX_GLOAS, &real.beacon.state_root));
    let header = LightClientHeader::compact(real.beacon, hash, branch, real.rlp.clone());
    let proven = verify_finalized_execution(&header).expect("control: the real anchor verifies");
    assert_eq!(proven.block_hash, keccak256(&real.rlp));
    assert_eq!(proven.block_number, decode_execution_anchor_fields(&real.rlp).unwrap().number);

    let mut flipped = header.clone();
    let last = flipped.execution_header_rlp.len() - 1;
    flipped.execution_header_rlp[last] ^= 1;
    assert_eq!(verify_finalized_execution(&flipped), Err(Error::ExecutionHeaderHashMismatch));
    let other = LightClientHeader { execution_header_rlp: sample_rlp(5).0, ..header };
    assert_eq!(verify_finalized_execution(&other), Err(Error::ExecutionHeaderHashMismatch));
}

/// Claim: index 2947 on a Capella or Deneb state (plain, depth 5) passes the branch check and is refused by the keccak check
/// with `ExecutionHeaderHashMismatch`.
/// Why it matters: 2947 has 11 bits. Five bits select field 14 (`slashings`, a vector of 8192 uint64, which is 2048 chunks,
/// depth 11), and the six bits below select node 3 of depth 6 in the chunk tree, which is the root of chunks 96 to 127 (an
/// internal node, a hash that is not zero). A prover can build a valid branch to it from the chunk tree and the state tree.
/// Only keccak stops it: no execution header hashes to that node. The keccak check is the only guard here.
#[test]
fn index_2947_on_a_depth_five_state_is_caught_only_by_keccak() {
    let landing = walk(2947, &[5, 6]);
    assert_eq!(landing.fields, vec![14, 3], "state field 14 (slashings), then node 3 at depth 6 of the chunk tree");
    assert_eq!(landing.remaining_levels, 0);

    let chunks: Vec<B256> = (0..2048u64).map(|index| u64_chunk(index + 1)).collect();
    let (slashings_root, chunk_branch) = branch_for_leaf(&chunks, 3 * 32);
    assert_eq!(chunk_branch.len(), 11);
    let node = merkleize(&chunks[96..128]);
    assert_ne!(node, B256::ZERO);
    let mut state_leaves: Vec<B256> = (0..28u64).map(|index| filler("depth-five-state", index)).collect();
    state_leaves[14] = slashings_root;
    let (state_root, state_branch) = branch_for_leaf(&state_leaves, 14);
    assert_eq!(state_branch.len(), 5);

    let branch: Vec<B256> = chunk_branch[5..].iter().chain(&state_branch).copied().collect();
    assert_eq!(branch.len(), 11);
    assert!(is_valid_exact_branch(&node, &branch, LATEST_BLOCK_HASH_GINDEX_GLOAS, &state_root), "valid at 2947");
    let (rlp, _) = sample_rlp(9);
    let attack = LightClientHeader::compact(beacon_header(state_root, filler("body", 0)), node, branch, rlp);
    assert_eq!(verify_execution_branch(&attack, "finalized"), Ok(()), "the branch check passes");
    assert_eq!(verify_finalized_execution(&attack), Err(Error::ExecutionHeaderHashMismatch));
}

/// Claim: index 2947 on an Electra or Fulu state (plain, depth 6) lands below a uint64, and a filler branch is refused with
/// `InvalidExecutionBranch`.
/// Why it is safe: the first six bits of 2947 after the leading one select field 28 (`deposit_requests_start_index`, a uint64
/// leaf), and five levels are left below it, so the node does not exist. The control: the honest branch of field 28
/// verifies at index 64 + 28 = 92, so the state is honest and only the claim is wrong.
#[test]
fn index_2947_on_a_depth_six_state_lands_below_a_uint64() {
    let landing = walk(2947, &[6]);
    assert_eq!(landing.fields, vec![28], "state field 28 (deposit_requests_start_index)");
    assert_eq!(landing.remaining_levels, 5, "five levels below a uint64 leaf");

    let mut leaves: Vec<B256> = (0..37u64).map(|index| filler("depth-six-state", index)).collect();
    let start_index = u64_chunk(7);
    leaves[28] = start_index;
    let (state_root, field_branch) = branch_for_leaf(&leaves, 28);
    assert_eq!(field_branch.len(), 6);
    assert!(is_valid_exact_branch(&start_index, &field_branch, 92, &state_root), "control: honest at 92");

    let attacker_branch: Vec<B256> = (0..5u64).map(|index| filler("attacker", index)).chain(field_branch).collect();
    for leaf in [start_index, filler("claimed-hash", 0)] {
        assert_refused(&compact_under_state(state_root, leaf, attacker_branch.clone()), "2947 on a depth 6 state");
    }
}

/// Claim: indices 25, 412 and 812 on a true Gloas body land below `active_fields` (node 3), and the headers are refused with
/// `InvalidExecutionBranch`. Both the real Sepolia compact update and a synthetic Gloas body are used: the honest branch of
/// 11 entries is cut or extended to 8 and 9 entries (compact), and 4 entries are cut from it (full form).
/// Why it is safe: the Gloas body is a progressive container. Node 2 holds the fields and node 3 is the `active_fields`
/// chunk, a basic leaf. Every index that starts with the bits 1, 1 lies below node 3: 25 is 11001, 412 is 110011100 and 812
/// is 1100101100. The control: the honest branch verifies at 2856 against the body root.
#[test]
fn indices_25_412_and_812_on_a_gloas_body_land_below_active_fields() {
    for gindex in [25u64, 412, 812] {
        let bits = path_bits(gindex);
        assert_eq!(gindex >> (gindex_depth(gindex) - 1), 3, "index {gindex} starts below node 3");
        assert_eq!(bits[0], 1, "the first step goes to the right child, node 3");
    }

    let real = light_client_update(&load_response("sepolia/gloas_finality_update.json")["data"]).finalized_header;
    assert_eq!(real.execution_branch.len(), 11);
    assert!(
        is_valid_exact_branch(
            &real.execution_block_hash(),
            &real.execution_branch,
            BLOCK_HASH_GINDEX_GLOAS,
            &real.beacon.body_root
        ),
        "control: the real branch is honest at 2856"
    );
    let synthetic = gloas_body(filler("gloas-parent", 0));
    let synthetic_branch = synthetic.block_hash_branch();
    assert_eq!(synthetic_branch.last(), Some(&active_fields_chunk(13)), "the top entry is the active_fields chunk");
    assert!(is_valid_exact_branch(
        &filler("gloas-parent", 0),
        &synthetic_branch,
        BLOCK_HASH_GINDEX_GLOAS,
        &synthetic.root()
    ));

    let cases = [
        (real.beacon.body_root, real.execution_block_hash(), real.execution_branch.clone(), "real"),
        (synthetic.root(), filler("gloas-parent", 0), synthetic_branch, "synthetic"),
    ];
    for (body_root, hash, branch, name) in cases {
        for (length, attempt) in
            [(8, branch[..8].to_vec()), (8, branch[3..].to_vec()), (9, branch[..9].to_vec()), (9, branch[2..].to_vec())]
        {
            assert_eq!(attempt.len(), length);
            assert_refused(&compact_under_body(body_root, hash, attempt), &format!("{name}, length {length}"));
        }
        let (payload, _) = deneb(hash);
        let full = LightClientHeader::full(beacon_header(filler("state", 0), body_root), payload, branch[7..].to_vec());
        assert_eq!(full.execution_branch.len(), 4);
        assert_refused(&full, &format!("{name}, full form at 25"));
    }
}
