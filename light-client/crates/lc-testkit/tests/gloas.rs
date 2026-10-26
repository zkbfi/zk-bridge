//! Gloas (Sepolia from epoch 353024): the compact light-client header, the progressive state and body layouts.
//!
//! The update and body here are SYNTHETIC: the committee is generated and signs for real, and the body and state are
//! built by `lc_testkit::synthetic` with zero chunks or filler for every field the light client does not read. The test
//! `a_real_sepolia_finality_update_verifies_its_branches` uses a real response of a Sepolia beacon node, with no
//! synthetic part, but it holds no committee, so it cannot check the signature.

use alloy_primitives::B256;
use lc_core::abi::LightClientOutput;
use lc_core::chain::{ChainSpec, ForkName, SEPOLIA};
use lc_core::json::light_client_update;
use lc_core::layout::{state_layout_for_fork, BLOCK_HASH_GINDEX_GLOAS, FINALIZED_ROOT_GINDEX_GLOAS};
use lc_core::ssz::is_valid_normalized_merkle_branch;
use lc_core::types::{HeaderForm, LightClientHeader, LightClientUpdate};
use lc_core::update::{
    table_fork_version, verify_execution_branch, verify_light_client_fold_with_fork_versions, FoldStep,
};
use lc_core::wire::{decode_guest_input, encode_guest_input, run_light_client_guest, ChainSelector, GuestInput};
use lc_core::Error;
use lc_testkit::json::{light_client_header_json, load_response};
use lc_testkit::synthetic::{
    build_gloas_update, build_update, gloas_body, synthetic_compact_header, GloasUpdateScenario, UpdateRecipe,
};

const GLOAS_FORK_VERSION: [u8; 4] = [0x90, 0x00, 0x00, 0x76];
/// The first slot of Gloas on Sepolia: epoch 353024 * 32. It is also the first slot of sync committee period 1379.
const GLOAS_FIRST_SLOT: u64 = 353_024 * 32;

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
        // The pure branch is real and valid, but the update path refuses it (see `gloas_refusal` below).
        let valid = |branch: &[B256]| {
            is_valid_normalized_merkle_branch(
                &header.execution_block_hash(),
                branch,
                BLOCK_HASH_GINDEX_GLOAS,
                &header.beacon.body_root,
            )
        };
        assert!(valid(&header.execution_branch), "{which}");
        let mut flipped = header.execution_branch.clone();
        flip(&mut flipped[4]);
        assert!(!valid(&flipped), "{which}");
        assert_eq!(verify_execution_branch(&SEPOLIA, header, which), Err(Error::GloasPayloadNotFinalized));
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

/// Claim: every Gloas input is refused with `GloasPayloadNotFinalized` and produces no output. Why: under Gloas the
/// execution payload is revealed apart from the beacon block and may be withheld. The `execution_block_hash` of a compact
/// header is the bid's `parent_block_hash`, not the execution block of that slot, and the header has no block number. A
/// message proof anchored to it would not be sound. The refusal covers the synthetic update, the real update, the
/// fold, the guest entry point and the wire decoder. Controls: a Fulu update on the same chain still verifies, so the
/// refusal is not a blanket failure.
#[test]
fn gloas_refusal() {
    let scenario = gloas_scenario();
    assert_eq!(fold(&scenario, &scenario.update), Err(Error::GloasPayloadNotFinalized));

    let real = light_client_update(&load_response("sepolia/gloas_finality_update.json")["data"]);
    assert_eq!(
        verify_execution_branch(&SEPOLIA, &real.attested_header, "attested"),
        Err(Error::GloasPayloadNotFinalized)
    );
    assert_eq!(state_layout_for_fork(ForkName::Gloas), Err(Error::GloasPayloadNotFinalized));

    // A compact header is refused wherever it sits, also in a pre-Gloas slot.
    let fulu = fulu_scenario();
    let mut compact = fulu.update.clone();
    compact.finalized_header.form = HeaderForm::Compact;
    assert_eq!(
        verify_light_client_fold_with_fork_versions(&fulu.store, &[step(&compact, fulu.spec)], fulu.spec),
        Err(Error::GloasPayloadNotFinalized)
    );
    let header = synthetic_compact_header(&SEPOLIA, 8_801_000, B256::repeat_byte(6), B256::repeat_byte(7));
    assert_eq!(verify_execution_branch(&SEPOLIA, &header, "finalized"), Err(Error::GloasPayloadNotFinalized));

    // The wire decoder rejects the compact form, so the guest cannot receive one.
    let input = GuestInput {
        chain: ChainSelector::Sepolia,
        store: scenario.store.clone(),
        steps: vec![step(&scenario.update, &SEPOLIA)],
    };
    assert_eq!(decode_guest_input(&encode_guest_input(&input)), Err(Error::GloasPayloadNotFinalized));
    assert_eq!(run_light_client_guest(&encode_guest_input(&input)), Err(Error::GloasPayloadNotFinalized));

    // Control: the same fold with a full-form Fulu update verifies.
    assert!(
        verify_light_client_fold_with_fork_versions(&fulu.store, &[step(&fulu.update, fulu.spec)], fulu.spec).is_ok(),
        "control"
    );
}
