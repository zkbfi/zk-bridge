//! Gloas (Sepolia from epoch 353024): the compact light-client header, the progressive state and body layouts.
//!
//! The update and body here are SYNTHETIC: the committee is generated and signs for real, and the body and state are
//! built by `lc_testkit::synthetic` with zero chunks or filler for every field the light client does not read. The test
//! `a_real_sepolia_finality_update_verifies_its_branches` uses a real response of a Sepolia beacon node, with no
//! synthetic part, but it holds no committee, so it cannot check the signature.

use alloy_primitives::B256;
use lc_core::abi::LightClientOutput;
use lc_core::chain::{ChainSpec, ForkEntry, ForkName, SEPOLIA};
use lc_core::json::light_client_update;
use lc_core::layout::{
    state_layout_for_fork, BLOCK_HASH_GINDEX_GLOAS, ELECTRA_STATE_LAYOUT, FINALIZED_ROOT_GINDEX_GLOAS,
    NEXT_SYNC_COMMITTEE_GINDEX_GLOAS,
};
use lc_core::ssz::is_valid_normalized_merkle_branch;
use lc_core::types::{HeaderForm, LightClientHeader, LightClientUpdate};
use lc_core::update::{
    table_fork_version, verify_execution_branch, verify_light_client_fold_with_fork_versions, verify_with_layout,
    FoldStep,
};
use lc_core::wire::{decode_guest_input, encode_guest_input, run_light_client_guest, ChainSelector, GuestInput};
use lc_core::Error;
use lc_testkit::json::{light_client_header_json, load_response};
use lc_testkit::synthetic::{
    build_gloas_update, build_update, gloas_body, gloas_body_salted, synthetic_compact_header, GloasUpdateScenario,
    StateBuilder, UpdateRecipe,
};

const GLOAS_FORK_VERSION: [u8; 4] = [0x90, 0x00, 0x00, 0x76];
/// The first slot of Gloas on Sepolia: epoch 353024 * 32. It is also the first slot of sync committee period 1379.
const GLOAS_FIRST_SLOT: u64 = 353_024 * 32;

/// Sepolia with the Gloas fork moved 8 epochs later, so that the fork falls INSIDE a sync committee period. On the real
/// Sepolia the fork sits exactly on a period boundary (epoch 353024 = 1379 * 256), which makes an update with a Fulu
/// finalized header and a Gloas attested header impossible: the signature period would be one past the stored period
/// without a crossing. Only this shifted table can test that mix.
static SHIFTED_FORKS: [ForkEntry; 8] = [
    ForkEntry { epoch: 0, fork_version: [0x90, 0, 0, 0x69], fork_name: ForkName::Phase0 },
    ForkEntry { epoch: 50, fork_version: [0x90, 0, 0, 0x70], fork_name: ForkName::Altair },
    ForkEntry { epoch: 100, fork_version: [0x90, 0, 0, 0x71], fork_name: ForkName::Bellatrix },
    ForkEntry { epoch: 56_832, fork_version: [0x90, 0, 0, 0x72], fork_name: ForkName::Capella },
    ForkEntry { epoch: 132_608, fork_version: [0x90, 0, 0, 0x73], fork_name: ForkName::Deneb },
    ForkEntry { epoch: 222_464, fork_version: [0x90, 0, 0, 0x74], fork_name: ForkName::Electra },
    ForkEntry { epoch: 272_640, fork_version: [0x90, 0, 0, 0x75], fork_name: ForkName::Fulu },
    ForkEntry { epoch: 353_032, fork_version: [0x90, 0, 0, 0x76], fork_name: ForkName::Gloas },
];
static SHIFTED_SEPOLIA: ChainSpec =
    ChainSpec { name: "sepolia-shifted-gloas", fork_schedule: &SHIFTED_FORKS, ..SEPOLIA };

fn recipe(participants: usize) -> UpdateRecipe {
    UpdateRecipe {
        store_slot: GLOAS_FIRST_SLOT + 1_000,
        finalized_slot: GLOAS_FIRST_SLOT + 2_000,
        attested_slot: GLOAS_FIRST_SLOT + 2_070,
        signature_slot: GLOAS_FIRST_SLOT + 2_071,
        participants,
        include_next_committee: true,
        store_knows_next_committee: false,
    }
}

fn gloas_scenario() -> GloasUpdateScenario {
    build_gloas_update(&SEPOLIA, recipe(342))
}

/// A synthetic Fulu update on Sepolia, in the full header form.
fn fulu_scenario() -> lc_testkit::synthetic::UpdateScenario {
    build_update(
        &SEPOLIA,
        UpdateRecipe {
            store_slot: 8_800_000,
            finalized_slot: 8_801_000,
            attested_slot: 8_801_070,
            signature_slot: 8_801_071,
            participants: 342,
            include_next_committee: false,
            store_knows_next_committee: false,
        },
    )
}

fn step(update: &LightClientUpdate, spec: &ChainSpec) -> FoldStep {
    FoldStep { update: update.clone(), fork_version: table_fork_version(spec, update.signature_slot) }
}

fn fold(scenario: &GloasUpdateScenario, update: &LightClientUpdate) -> lc_core::Result<LightClientOutput> {
    verify_light_client_fold_with_fork_versions(&scenario.store, &[step(update, scenario.spec)], scenario.spec)
}

fn flip(node: &mut B256) {
    node.0[0] ^= 1;
}

/// Claim: a synthetic Gloas update verifies through the fold with the Sepolia specification and the fork version
/// 0x90000076. The output names the Sepolia chain and the finalized header, reports the compact execution block hash, and
/// reports block number 0 because a compact header has none. The branches have the lengths of the real data: 9 for the
/// finality branch, 11 for the committee and the execution branch.
#[test]
fn a_synthetic_gloas_update_verifies_through_the_fold() {
    let scenario = gloas_scenario();
    let update = &scenario.update;
    assert_eq!(SEPOLIA.fork_at_slot(update.attested_header.beacon.slot), ForkName::Gloas);
    assert_eq!(table_fork_version(&SEPOLIA, update.signature_slot), GLOAS_FORK_VERSION);
    assert_eq!(update.finality_branch.len(), 9);
    assert_eq!(update.next_sync_committee.as_ref().unwrap().branch.len(), 11);
    assert_eq!(update.attested_header.execution_branch.len(), 11);
    assert_eq!(update.finalized_header.form, HeaderForm::Compact);

    let output = fold(&scenario, update).expect("the Gloas update verifies");
    assert_eq!(output.genesisValidatorsRoot, SEPOLIA.genesis_validators_root);
    assert_eq!(output.newHeadSlot, update.finalized_header.beacon.slot);
    assert_eq!(output.newHeaderRoot, update.finalized_header.beacon.hash_tree_root());
    assert_eq!(output.executionBlockHash, update.finalized_header.execution_block_hash());
    assert_ne!(output.executionBlockHash, B256::ZERO);
    assert_eq!(output.executionBlockNumber, 0, "a compact header has no block number");
    assert_ne!(output.nextSyncCommitteeHash, B256::ZERO);
}

/// Claim: the synthetic Gloas body proves its block hash at index 2856 and at no other index of the same depth. A branch
/// for 2856 does not verify at 2857 or at the Deneb index 812. The control is the honest branch.
#[test]
fn the_synthetic_body_commits_at_index_2856() {
    let hash = B256::repeat_byte(0x42);
    let body = gloas_body(hash);
    let branch = body.block_hash_branch();
    assert_eq!(branch.len(), 11);
    assert!(is_valid_normalized_merkle_branch(&hash, &branch, BLOCK_HASH_GINDEX_GLOAS, &body.root()), "control");
    assert!(!is_valid_normalized_merkle_branch(&hash, &branch, 2857, &body.root()));
    assert!(!is_valid_normalized_merkle_branch(&hash, &branch, 812, &body.root()));
    assert!(!is_valid_normalized_merkle_branch(&B256::repeat_byte(0x43), &branch, 2856, &body.root()));
    assert_ne!(body.root(), gloas_body(B256::repeat_byte(0x43)).root());
}

/// Claim: flipping one byte of any branch entry, or of the signature, of the honest update is refused for the right
/// reason. The first assertion is the control: the honest update passes.
#[test]
fn one_flipped_byte_breaks_the_gloas_update() {
    let scenario = gloas_scenario();
    assert!(fold(&scenario, &scenario.update).is_ok(), "control");
    for position in 0..scenario.update.finalized_header.execution_branch.len() {
        let mut update = scenario.update.clone();
        flip(&mut update.finalized_header.execution_branch[position]);
        assert_eq!(fold(&scenario, &update).err(), Some(Error::InvalidExecutionBranch("finalized")), "{position}");
    }
    for position in 0..scenario.update.attested_header.execution_branch.len() {
        let mut update = scenario.update.clone();
        flip(&mut update.attested_header.execution_branch[position]);
        assert_eq!(fold(&scenario, &update).err(), Some(Error::InvalidExecutionBranch("attested")), "{position}");
    }
    for position in 0..scenario.update.finality_branch.len() {
        let mut update = scenario.update.clone();
        flip(&mut update.finality_branch[position]);
        assert_eq!(fold(&scenario, &update).err(), Some(Error::InvalidFinalityBranch), "{position}");
    }
    for position in 0..11 {
        let mut update = scenario.update.clone();
        flip(&mut update.next_sync_committee.as_mut().unwrap().branch[position]);
        assert_eq!(fold(&scenario, &update).err(), Some(Error::InvalidNextSyncCommitteeBranch), "{position}");
    }
    let mut update = scenario.update.clone();
    update.sync_aggregate.sync_committee_signature[7] ^= 1;
    assert!(fold(&scenario, &update).is_err());
    let wrong_version = verify_light_client_fold_with_fork_versions(
        &scenario.store,
        &[FoldStep { update: scenario.update.clone(), fork_version: [0x90, 0, 0, 0x75] }],
        &SEPOLIA,
    );
    assert_eq!(wrong_version.err(), Some(Error::SignatureVerificationFailed), "the Fulu version signs another domain");
    let few = build_gloas_update(&SEPOLIA, recipe(341));
    assert_eq!(fold(&few, &few.update).err(), Some(Error::InsufficientParticipation { participants: 341 }));
}

/// Claim: a branch for the wrong index is refused. A Gloas header that carries the Deneb style branch (a payload block
/// hash at index 812, 9 entries), a header whose branch comes from another body, and a branch that proves the neighbour
/// field `block_hash` of the bid (index 2858) all fail. Why it matters: the index is chosen by the epoch of the header slot,
/// so a prover must not pick it.
#[test]
fn a_wrong_execution_index_is_refused() {
    let scenario = gloas_scenario();
    let honest = &scenario.update.finalized_header;
    assert_eq!(verify_execution_branch(&SEPOLIA, honest, "finalized"), Ok(()), "control");

    // The Deneb style body: payload hash at 812, branch of 9 entries, body root of that body.
    let fulu_slot = GLOAS_FIRST_SLOT - 100;
    let deneb_style = synthetic_compact_header(&SEPOLIA, fulu_slot, B256::ZERO, honest.execution_block_hash());
    assert_eq!(deneb_style.execution_branch.len(), 9);
    let mut at_gloas_slot = deneb_style.clone();
    at_gloas_slot.beacon.slot = honest.beacon.slot;
    assert_eq!(
        verify_execution_branch(&SEPOLIA, &at_gloas_slot, "finalized"),
        Err(Error::InvalidExecutionBranch("finalized"))
    );
    assert_eq!(
        verify_execution_branch(&SEPOLIA, &deneb_style, "finalized"),
        Ok(()),
        "the same header is valid in Fulu"
    );

    // A branch from another body with the same hash length.
    let other = gloas_body_salted(honest.execution_block_hash(), "another-block");
    assert_ne!(other.block_hash_branch(), gloas_body(honest.execution_block_hash()).block_hash_branch());
    let mut wrong_body = honest.clone();
    wrong_body.execution_branch = other.block_hash_branch();
    assert_eq!(
        verify_execution_branch(&SEPOLIA, &wrong_body, "finalized"),
        Err(Error::InvalidExecutionBranch("finalized"))
    );
    // The hash of another body: the leaf changes, the branch stays.
    let mut wrong_leaf = honest.clone();
    wrong_leaf.execution = lc_core::types::ExecutionPayloadHeader {
        block_hash: B256::repeat_byte(9),
        ..lc_core::types::ExecutionPayloadHeader::default()
    };
    assert_eq!(
        verify_execution_branch(&SEPOLIA, &wrong_leaf, "finalized"),
        Err(Error::InvalidExecutionBranch("finalized"))
    );
}

/// Claim: a Deneb layout finality branch (7 entries, index 169, valid under a Fulu state root) is refused for a Gloas
/// attested header, and so is the wrong-fork attack that selects the Electra layout. The control shows the same Fulu
/// branch verifies under its own state root.
#[test]
fn a_deneb_style_finality_branch_is_refused_at_a_gloas_slot() {
    let scenario = gloas_scenario();
    let finalized_root = scenario.update.finalized_header.beacon.hash_tree_root();
    let mut fulu_state = StateBuilder::new(ForkName::Fulu);
    fulu_state
        .set_finalized_checkpoint(SEPOLIA.epoch_at_slot(scenario.update.finalized_header.beacon.slot), finalized_root);
    let fulu_branch = fulu_state.finality_branch(SEPOLIA.epoch_at_slot(scenario.update.finalized_header.beacon.slot));
    assert_eq!(fulu_branch.len(), 7);
    assert!(is_valid_normalized_merkle_branch(&finalized_root, &fulu_branch, 169, &fulu_state.root()), "control");

    let mut update = scenario.update.clone();
    update.finality_branch = fulu_branch;
    assert_eq!(fold(&scenario, &update).err(), Some(Error::InvalidFinalityBranch));

    fn electra_selector(_: ForkName) -> lc_core::Result<lc_core::layout::StateLayout> {
        Ok(ELECTRA_STATE_LAYOUT)
    }
    let attack = verify_with_layout(
        &scenario.store,
        &scenario.update,
        &SEPOLIA,
        electra_selector,
        table_fork_version(&SEPOLIA, scenario.update.signature_slot),
    );
    assert_eq!(attack.err(), Some(Error::InvalidFinalityBranch));
    assert_eq!(state_layout_for_fork(ForkName::Gloas).unwrap().finalized_root_gindex, FINALIZED_ROOT_GINDEX_GLOAS);
    assert_eq!(
        state_layout_for_fork(ForkName::Gloas).unwrap().next_sync_committee_gindex,
        NEXT_SYNC_COMMITTEE_GINDEX_GLOAS
    );
}

/// Claim: a compact header with the zero block hash is refused in every epoch from Capella on, even when its branch is
/// valid for the zero leaf. The contract reverts on a zero block hash, so the program must not prove it. Before Capella
/// the header is refused as an unsupported fork. The control is the same header with a non-zero hash.
#[test]
fn a_zero_block_hash_is_refused() {
    for slot in [GLOAS_FIRST_SLOT + 5, GLOAS_FIRST_SLOT - 5, 132_608 * 32 + 5, 56_832 * 32 + 5] {
        let good = synthetic_compact_header(&SEPOLIA, slot, B256::ZERO, B256::repeat_byte(3));
        assert_eq!(verify_execution_branch(&SEPOLIA, &good, "finalized"), Ok(()), "control at slot {slot}");
        let zero = synthetic_compact_header(&SEPOLIA, slot, B256::ZERO, B256::ZERO);
        assert_eq!(
            verify_execution_branch(&SEPOLIA, &zero, "finalized"),
            Err(Error::ZeroExecutionBlockHash("finalized")),
            "slot {slot}"
        );
    }
    // Through the update: the zero header is the finalized header.
    let scenario = gloas_scenario();
    let mut update = scenario.update.clone();
    update.finalized_header =
        synthetic_compact_header(&SEPOLIA, update.finalized_header.beacon.slot, B256::ZERO, B256::ZERO);
    assert_eq!(fold(&scenario, &update).err(), Some(Error::ZeroExecutionBlockHash("finalized")));
    // Bellatrix: the specification accepts a zero hash with an empty branch, the bridge cannot use it.
    let early = LightClientHeader::compact(
        lc_core::types::BeaconBlockHeader { slot: 101 * 32, ..Default::default() },
        B256::ZERO,
        vec![],
    );
    assert_eq!(
        verify_execution_branch(&SEPOLIA, &early, "attested"),
        Err(Error::UnsupportedFork { fork: ForkName::Bellatrix })
    );
}

/// Claim: a compact header whose slot is BEFORE Gloas verifies at the index of its own epoch: 412 in Capella, 812 in
/// Deneb, Electra and Fulu. Inside one Gloas update, a Fulu finalized header and a Gloas attested header both verify. The
/// update needs the shifted table, see `SHIFTED_SEPOLIA`. The control flips a byte.
#[test]
fn a_pre_gloas_compact_header_verifies_at_its_own_index() {
    for (slot, depth) in
        [(56_832 * 32 + 9, 8usize), (132_608 * 32 + 9, 9), (222_464 * 32 + 9, 9), (272_640 * 32 + 9, 9)]
    {
        let header = synthetic_compact_header(&SEPOLIA, slot, B256::ZERO, B256::repeat_byte(5));
        assert_eq!(header.execution_branch.len(), depth, "slot {slot}");
        assert_eq!(verify_execution_branch(&SEPOLIA, &header, "finalized"), Ok(()), "slot {slot}");
        let mut flipped = header.clone();
        flip(&mut flipped.execution_branch[0]);
        assert_eq!(
            verify_execution_branch(&SEPOLIA, &flipped, "finalized"),
            Err(Error::InvalidExecutionBranch("finalized"))
        );
    }

    let fork_slot = 353_032 * 32;
    let mixed = UpdateRecipe {
        store_slot: GLOAS_FIRST_SLOT + 10,
        finalized_slot: fork_slot - 100,
        attested_slot: fork_slot + 60,
        signature_slot: fork_slot + 61,
        participants: 342,
        include_next_committee: false,
        store_knows_next_committee: false,
    };
    assert_eq!(SHIFTED_SEPOLIA.period_at_slot(mixed.store_slot), SHIFTED_SEPOLIA.period_at_slot(mixed.signature_slot));
    let scenario = build_gloas_update(&SHIFTED_SEPOLIA, mixed);
    assert_eq!(SHIFTED_SEPOLIA.fork_at_slot(scenario.update.finalized_header.beacon.slot), ForkName::Fulu);
    assert_eq!(scenario.update.finalized_header.execution_branch.len(), 9);
    assert_eq!(scenario.update.attested_header.execution_branch.len(), 11);
    let output = fold(&scenario, &scenario.update).expect("a Fulu finalized header inside a Gloas update");
    assert_eq!(output.executionBlockHash, scenario.update.finalized_header.execution_block_hash());
    let mut tampered = scenario.update.clone();
    flip(&mut tampered.finalized_header.execution_branch[3]);
    assert_eq!(fold(&scenario, &tampered).err(), Some(Error::InvalidExecutionBranch("finalized")));
}

/// Claim: the header shape follows the attested fork. A full header inside a Gloas update is refused, a compact header
/// inside a Fulu update is refused, and a full header at a Gloas slot is an unsupported fork on its own.
#[test]
fn the_header_shape_follows_the_attested_fork() {
    let scenario = gloas_scenario();
    let full_in_gloas = {
        // A full header placed at the slot of the Gloas finalized header: only its shape is wrong.
        let mut full = fulu_scenario().update.finalized_header;
        full.beacon.slot = scenario.update.finalized_header.beacon.slot;
        let mut update = scenario.update.clone();
        update.finalized_header = full;
        update
    };
    assert_eq!(fold(&scenario, &full_in_gloas).err(), Some(Error::HeaderFormMismatch("finalized")));

    let fulu = fulu_scenario();
    let compact = synthetic_compact_header(
        &SEPOLIA,
        8_801_070,
        fulu.update.attested_header.beacon.state_root,
        B256::repeat_byte(1),
    );
    let mut update = fulu.update.clone();
    update.attested_header = compact;
    let result = verify_light_client_fold_with_fork_versions(&fulu.store, &[step(&update, &SEPOLIA)], &SEPOLIA);
    assert_eq!(result.err(), Some(Error::HeaderFormMismatch("attested")));
    assert!(
        verify_light_client_fold_with_fork_versions(&fulu.store, &[step(&fulu.update, &SEPOLIA)], &SEPOLIA).is_ok(),
        "control: the full form passes in Fulu"
    );
    assert_eq!(
        verify_execution_branch(&SEPOLIA, &fulu.update.finalized_header, "finalized"),
        Ok(()),
        "a Fulu slot header in the full form is fine by itself"
    );
    let mut full_at_gloas_slot = fulu.update.finalized_header.clone();
    full_at_gloas_slot.beacon.slot = GLOAS_FIRST_SLOT + 1;
    assert_eq!(
        verify_execution_branch(&SEPOLIA, &full_at_gloas_slot, "finalized"),
        Err(Error::UnsupportedFork { fork: ForkName::Gloas })
    );
}

/// Claim: the compact header survives the guest wire format and the JSON form. A compact input uses the extended
/// format (selector byte 0x83 for Sepolia), a full input keeps the original single byte, and a fold that mixes a Fulu
/// full step and a Gloas compact step round trips. The guest body gives the same output as the library. A bad form byte is
/// refused.
#[test]
fn the_compact_header_round_trips_through_the_wire_and_json() {
    let scenario = gloas_scenario();
    let step = step(&scenario.update, &SEPOLIA);
    let input = GuestInput { chain: ChainSelector::Sepolia, store: scenario.store.clone(), steps: vec![step.clone()] };
    let bytes = encode_guest_input(&input);
    assert_eq!(bytes[0], 0x83);
    assert_eq!(decode_guest_input(&bytes), Ok(input.clone()));
    let public_values = run_light_client_guest(&bytes).expect("guest");
    let expected = fold(&scenario, &scenario.update).unwrap();
    assert_eq!(<LightClientOutput as alloy_sol_types::SolValue>::abi_decode(&public_values), Ok(expected));

    // The compact encoding is shorter than the full one: no payload header.
    let fulu = fulu_scenario();
    let full_input = GuestInput {
        chain: ChainSelector::Sepolia,
        store: fulu.store.clone(),
        steps: vec![self::step(&fulu.update, &SEPOLIA)],
    };
    let full_bytes = encode_guest_input(&full_input);
    assert_eq!(full_bytes[0], 0x03, "all headers full: the original format, no flag");
    assert_eq!(decode_guest_input(&full_bytes), Ok(full_input.clone()));

    // One input with a full step and a compact step: the extended format, one form byte per header.
    let mixed = GuestInput {
        chain: ChainSelector::Sepolia,
        store: fulu.store.clone(),
        steps: vec![full_input.steps[0].clone(), step.clone()],
    };
    let mixed_bytes = encode_guest_input(&mixed);
    assert_eq!(mixed_bytes[0], 0x83);
    assert_eq!(decode_guest_input(&mixed_bytes), Ok(mixed));

    // The form byte of the first header sits right after the store: 1 + 32 + 8 + (4 + 512 * 48) + 48 + 1 + 4 + 4.
    let offset = 1 + 32 + 8 + 4 + 512 * 48 + 48 + 1 + 4 + 4;
    assert_eq!(bytes[offset], 1);
    let mut bad = bytes.clone();
    bad[offset] = 7;
    assert!(
        matches!(decode_guest_input(&bad), Err(Error::HeaderDecode(reason)) if reason.contains("unknown header form"))
    );
    let mut unknown_tag = bytes.clone();
    unknown_tag[0] = 0x80 | 9;
    assert!(decode_guest_input(&unknown_tag).is_err());

    // JSON: the compact header has the three keys of the Gloas specification, and parses back to the same header.
    let header_json = light_client_header_json(&scenario.update.finalized_header);
    let keys: Vec<&str> = header_json.as_object().unwrap().keys().map(String::as_str).collect();
    assert_eq!(keys, ["beacon", "execution_block_hash", "execution_branch"]);
    assert_eq!(lc_core::json::light_client_header(&header_json), scenario.update.finalized_header);
}

/// Claim: an update JSON must use one form for all its headers, and a header with both or neither key is malformed.
#[test]
fn the_json_parser_keeps_one_form_per_update() {
    let scenario = gloas_scenario();
    let fulu = fulu_scenario();
    let json_of = |attested: &LightClientHeader, finalized: &LightClientHeader| {
        serde_json::json!({
            "attested_header": light_client_header_json(attested),
            "finalized_header": light_client_header_json(finalized),
            "finality_branch": lc_testkit::json::branch_json(&scenario.update.finality_branch),
            "sync_aggregate": {
                "sync_committee_bits": format!("0x{}", alloy_primitives::hex::encode(scenario.update.sync_aggregate.sync_committee_bits)),
                "sync_committee_signature": format!("0x{}", alloy_primitives::hex::encode(scenario.update.sync_aggregate.sync_committee_signature)),
            },
            "signature_slot": scenario.update.signature_slot.to_string(),
        })
    };
    let same = json_of(&scenario.update.attested_header, &scenario.update.finalized_header);
    let parsed = light_client_update(&same);
    assert_eq!(parsed.attested_header, scenario.update.attested_header);
    assert_eq!(parsed.finalized_header, scenario.update.finalized_header);

    let mixed = json_of(&scenario.update.attested_header, &fulu.update.finalized_header);
    assert!(std::panic::catch_unwind(|| light_client_update(&mixed)).is_err(), "mixed forms are refused");

    let mut both = light_client_header_json(&scenario.update.finalized_header);
    both["execution"] = light_client_header_json(&fulu.update.finalized_header)["execution"].clone();
    assert!(std::panic::catch_unwind(|| lc_core::json::light_client_header(&both)).is_err());
    let mut neither = light_client_header_json(&scenario.update.finalized_header);
    neither.as_object_mut().unwrap().remove("execution_block_hash");
    assert!(std::panic::catch_unwind(|| lc_core::json::light_client_header(&neither)).is_err());
}

/// Claim: a REAL Gloas finality update of Sepolia (no synthetic part) has the shape the code expects, and its branches
/// verify: the finality branch of 9 entries at index 735 against the attested state root, and the execution branch of 11
/// entries at index 2856 against the body root of both headers. The real execution branch ends with the `active_fields`
/// chunk of 13 fields (0xff1f...), which confirms the reading of `active_fields(width=13)`. The data holds no
/// committee, so the signature is not checked here. Controls: a flipped byte in each branch fails.
#[test]
fn a_real_sepolia_finality_update_verifies_its_branches() {
    let response = load_response("sepolia/gloas_finality_update.json");
    assert_eq!(response["version"].as_str(), Some("gloas"));
    let update = light_client_update(&response["data"]);
    assert_eq!(update.attested_header.form, HeaderForm::Compact);
    assert_eq!(update.finalized_header.form, HeaderForm::Compact);
    assert_eq!(SEPOLIA.fork_at_slot(update.attested_header.beacon.slot), ForkName::Gloas);
    assert_eq!(SEPOLIA.fork_at_slot(update.finalized_header.beacon.slot), ForkName::Gloas);
    assert_eq!(update.finality_branch.len(), 9);
    assert_eq!(update.attested_header.execution_branch.len(), 11);
    assert_eq!(update.attested_header.execution_branch[10].0[..2], [0xff, 0x1f]);

    assert!(is_valid_normalized_merkle_branch(
        &update.finalized_header.beacon.hash_tree_root(),
        &update.finality_branch,
        FINALIZED_ROOT_GINDEX_GLOAS,
        &update.attested_header.beacon.state_root,
    ));
    for (which, header) in [("attested", &update.attested_header), ("finalized", &update.finalized_header)] {
        assert_eq!(verify_execution_branch(&SEPOLIA, header, which), Ok(()), "{which}");
        let mut flipped = header.clone();
        flip(&mut flipped.execution_branch[4]);
        assert_eq!(verify_execution_branch(&SEPOLIA, &flipped, which), Err(Error::InvalidExecutionBranch(which)));
    }
    let mut flipped = update.finality_branch.clone();
    flip(&mut flipped[2]);
    assert!(!is_valid_normalized_merkle_branch(
        &update.finalized_header.beacon.hash_tree_root(),
        &flipped,
        FINALIZED_ROOT_GINDEX_GLOAS,
        &update.attested_header.beacon.state_root,
    ));
    assert!(!is_valid_normalized_merkle_branch(
        &update.finalized_header.beacon.hash_tree_root(),
        &update.finality_branch,
        169,
        &update.attested_header.beacon.state_root,
    ));
    assert_eq!(table_fork_version(&SEPOLIA, update.signature_slot), GLOAS_FORK_VERSION);
}
