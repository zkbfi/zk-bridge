//! Gloas (Sepolia from epoch 353024): the head of the light client is anchored in the finalized state.
//!
//! The updates here are SYNTHETIC: the committee is generated and signs for real, and the states and bodies are built by
//! `lc_testkit::synthetic` with filler for every field the light client does not read. The data of a real Sepolia node
//! is in `gloas_real.rs`. These tests are the negative tests: each one breaks one rule and expects its own error.
//!
//! The rule under test. A Gloas finalized header is a COMPACT header. Its `execution_block_hash` is
//! `state.latest_block_hash` of the post-state of the header, proven by a branch of 11 entries at index 2947 to
//! `beacon.state_root`. The guest hashes the RLP of the execution header and requires the hash to equal the proven
//! block hash. It reads the block number from the RLP. The bid in the body is never read.

use alloy_primitives::{keccak256, B256};
use lc_core::chain::{ChainSpec, ForkEntry, ForkName, SEPOLIA};
use lc_core::execution::decode_execution_anchor_fields;
use lc_core::json::light_client_update;
use lc_core::layout::{BLOCK_HASH_GINDEX_GLOAS, LATEST_BLOCK_HASH_GINDEX_GLOAS};
use lc_core::ssz::is_valid_normalized_merkle_branch;
use lc_core::types::{HeaderForm, LightClientHeader, LightClientUpdate};
use lc_core::update::{table_fork_version, verify_light_client_fold_with_fork_versions, FoldStep};
use lc_core::wire::{decode_guest_input, encode_guest_input, run_light_client_guest, ChainSelector, GuestInput};
use lc_core::Error;
use lc_testkit::json::{light_client_header_json, light_client_update_json};
use lc_testkit::receipts::amsterdam_header_rlp;
use lc_testkit::synthetic::{
    build_gloas_update, build_update, gloas_body, synthetic_compact_finalized_header, GloasStateBuilder,
    GloasUpdateScenario, UpdateRecipe,
};

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

fn fulu_recipe() -> UpdateRecipe {
    UpdateRecipe {
        store_slot: 8_800_000,
        finalized_slot: 8_801_000,
        attested_slot: 8_801_070,
        signature_slot: 8_801_071,
        participants: 342,
        include_next_committee: false,
        store_knows_next_committee: false,
    }
}

fn gloas_scenario() -> GloasUpdateScenario {
    build_gloas_update(&SEPOLIA, recipe(342))
}

fn step(update: &LightClientUpdate, spec: &ChainSpec) -> FoldStep {
    FoldStep { update: update.clone(), fork_version: table_fork_version(spec, update.signature_slot) }
}

fn fold(
    scenario: &GloasUpdateScenario,
    update: &LightClientUpdate,
) -> lc_core::Result<lc_core::abi::LightClientOutput> {
    verify_light_client_fold_with_fork_versions(&scenario.store, &[step(update, scenario.spec)], scenario.spec)
}

fn flip(node: &mut B256) {
    node.0[0] ^= 1;
}

/// A copy of the Sepolia schedule with Gloas 100 epochs later, so that a Gloas-typed update can finalize a header BEFORE the
/// fork inside the same sync committee period (on the real chain the fork starts a period, so this cannot happen there).
static LATE_GLOAS_FORKS: [ForkEntry; 8] = [
    ForkEntry { epoch: 0, fork_version: [0x90, 0x00, 0x00, 0x69], fork_name: ForkName::Phase0 },
    ForkEntry { epoch: 50, fork_version: [0x90, 0x00, 0x00, 0x70], fork_name: ForkName::Altair },
    ForkEntry { epoch: 100, fork_version: [0x90, 0x00, 0x00, 0x71], fork_name: ForkName::Bellatrix },
    ForkEntry { epoch: 56_832, fork_version: [0x90, 0x00, 0x00, 0x72], fork_name: ForkName::Capella },
    ForkEntry { epoch: 132_608, fork_version: [0x90, 0x00, 0x00, 0x73], fork_name: ForkName::Deneb },
    ForkEntry { epoch: 222_464, fork_version: [0x90, 0x00, 0x00, 0x74], fork_name: ForkName::Electra },
    ForkEntry { epoch: 272_640, fork_version: [0x90, 0x00, 0x00, 0x75], fork_name: ForkName::Fulu },
    ForkEntry { epoch: 353_124, fork_version: [0x90, 0x00, 0x00, 0x76], fork_name: ForkName::Gloas },
];
static LATE_GLOAS_SPEC: ChainSpec =
    ChainSpec { name: "sepolia-late-gloas", fork_schedule: &LATE_GLOAS_FORKS, ..SEPOLIA };

/// Claim: the synthetic body commits to its bid `parent_block_hash` at index 2856 and at no other index of the same depth.
/// The verifier does not read this value. The test keeps the derivation of the specification constant checked.
#[test]
fn the_synthetic_body_commits_at_index_2856() {
    let hash = B256::repeat_byte(0x42);
    let body = gloas_body(hash);
    let branch = body.block_hash_branch();
    assert_eq!(branch.len(), 11);
    assert!(is_valid_normalized_merkle_branch(&hash, &branch, BLOCK_HASH_GINDEX_GLOAS, &body.root()), "control");
    assert!(!is_valid_normalized_merkle_branch(&hash, &branch, 2857, &body.root()));
    assert!(!is_valid_normalized_merkle_branch(&hash, &branch, 812, &body.root()));
    assert_ne!(body.root(), gloas_body(B256::repeat_byte(0x43)).root());
}

/// Claim: the synthetic state commits to `latest_block_hash` at index 2947 with a branch of 11 entries, and at no neighbour.
#[test]
fn the_synthetic_state_commits_to_latest_block_hash_at_index_2947() {
    let hash = B256::repeat_byte(0x61);
    let mut state = GloasStateBuilder::default();
    state.set_latest_block_hash(hash);
    let branch = state.latest_block_hash_branch();
    assert_eq!(branch.len(), 11);
    assert!(is_valid_normalized_merkle_branch(&hash, &branch, LATEST_BLOCK_HASH_GINDEX_GLOAS, &state.root()));
    for wrong in [2946u64, 2948, 2856] {
        assert!(!is_valid_normalized_merkle_branch(&hash, &branch, wrong, &state.root()), "index {wrong}");
    }
}

/// Claim: a Gloas fold gives an output with the block hash that the state names and the block number that the RLP holds.
/// The number is not zero. The hash is the keccak256 of the RLP. The RLP has 23 items (Amsterdam). The control is the
/// Fulu fold on the same chain, which still verifies and gives the number of its payload header.
#[test]
fn a_gloas_fold_reports_the_block_number_of_the_rlp() {
    let scenario = gloas_scenario();
    let output = fold(&scenario, &scenario.update).expect("the synthetic Gloas update verifies");
    let rlp = &scenario.update.finalized_header.execution_header_rlp;
    assert_eq!(output.executionBlockHash, keccak256(rlp));
    assert_eq!(output.executionBlockNumber, scenario.finalized_block_number);
    assert_ne!(output.executionBlockNumber, 0, "no zero number");
    assert_eq!(decode_execution_anchor_fields(rlp).unwrap().number, scenario.finalized_block_number);
    assert_eq!(output.newHeadSlot, scenario.update.finalized_header.beacon.slot);

    let fulu = build_update(&SEPOLIA, fulu_recipe());
    let control = verify_light_client_fold_with_fork_versions(&fulu.store, &[step(&fulu.update, fulu.spec)], fulu.spec)
        .expect("a Fulu update still verifies");
    assert_ne!(control.executionBlockNumber, 0);
}

/// Claim: the RLP is bound to the proven hash. An RLP with one changed byte, the RLP of another block and an empty RLP each
/// give `ExecutionHeaderHashMismatch`. A list of 3 items whose hash is put in the state, so that the branch and the hash
/// agree, is refused by the decoder alone.
#[test]
fn a_wrong_execution_header_rlp_is_refused() {
    let scenario = gloas_scenario();
    let with_rlp = |rlp: Vec<u8>| {
        let mut update = scenario.update.clone();
        update.finalized_header.execution_header_rlp = rlp;
        update
    };
    let honest = scenario.update.finalized_header.execution_header_rlp.clone();

    let mut changed = honest.clone();
    *changed.last_mut().unwrap() ^= 1;
    assert_eq!(fold(&scenario, &with_rlp(changed)), Err(Error::ExecutionHeaderHashMismatch));

    let other_block =
        amsterdam_header_rlp(scenario.finalized_block_number + 1, B256::repeat_byte(1), B256::repeat_byte(2));
    assert_ne!(keccak256(&other_block), keccak256(&honest));
    assert_eq!(fold(&scenario, &with_rlp(other_block.to_vec())), Err(Error::ExecutionHeaderHashMismatch));

    assert_eq!(fold(&scenario, &with_rlp(Vec::new())), Err(Error::ExecutionHeaderHashMismatch));

    let short = alloy_rlp::encode(vec![1u8, 2, 3]);
    let mut state = GloasStateBuilder::default();
    state.set_latest_block_hash(keccak256(&short));
    let mut header = scenario.update.finalized_header.clone();
    header.beacon.state_root = state.root();
    header.execution.block_hash = keccak256(&short);
    header.execution_branch = state.latest_block_hash_branch();
    header.execution_header_rlp = short;
    assert!(matches!(lc_core::update::verify_finalized_execution(&header), Err(Error::HeaderDecode(_))));
}

/// Claim: the branch must lead from `latest_block_hash` to the STATE root. A flipped entry, a shorter and a longer branch,
/// a branch of the neighbouring field and a branch from a body (the path to the bid) each fail with
/// `InvalidExecutionBranch`. The bid is never the anchor: a body branch to the bid `parent_block_hash` gives no output
/// even when the hash and the RLP match. A zero hash is refused by name.
#[test]
fn the_anchor_branch_must_lead_to_the_state_root() {
    let scenario = gloas_scenario();
    let header = scenario.update.finalized_header.clone();
    let tamper = |change: &dyn Fn(&mut LightClientHeader)| {
        let mut update = scenario.update.clone();
        change(&mut update.finalized_header);
        fold(&scenario, &update)
    };
    for position in 0..header.execution_branch.len() {
        assert_eq!(
            tamper(&|h| flip(&mut h.execution_branch[position])),
            Err(Error::InvalidExecutionBranch("finalized")),
            "entry {position}"
        );
    }
    assert_eq!(
        tamper(&|h| {
            h.execution_branch.pop();
        }),
        Err(Error::InvalidExecutionBranch("finalized"))
    );
    assert_eq!(
        tamper(&|h| h.execution_branch.insert(0, B256::repeat_byte(9))),
        Err(Error::InvalidExecutionBranch("finalized"))
    );

    let hash = header.execution_block_hash();
    let neighbour = lc_core::ssz::progressive_container_branch(&vec![hash; 46], 25).1;
    assert_eq!(tamper(&|h| h.execution_branch = neighbour.clone()), Err(Error::InvalidExecutionBranch("finalized")));

    let body = gloas_body(hash);
    assert_eq!(
        tamper(&|h| {
            h.beacon.body_root = body.root();
            h.execution_branch = body.block_hash_branch();
        }),
        Err(Error::InvalidExecutionBranch("finalized"))
    );
    assert_eq!(tamper(&|h| h.execution.block_hash = B256::ZERO), Err(Error::ZeroExecutionBlockHash("finalized")));
}

/// Claim: the attested header of a Gloas update is not read for execution data. A garbled hash, branch and RLP in the
/// attested header change nothing, because the committee signs the beacon header and the output reads the finalized header
/// only. The control: the same garbling of the FINALIZED header is refused.
#[test]
fn the_attested_execution_data_of_a_gloas_update_is_not_read() {
    let scenario = gloas_scenario();
    let baseline = fold(&scenario, &scenario.update).unwrap();
    let mut update = scenario.update.clone();
    update.attested_header.execution.block_hash = B256::repeat_byte(0x99);
    update.attested_header.execution_branch = vec![B256::repeat_byte(0x98); 11];
    update.attested_header.execution_header_rlp = vec![1, 2, 3];
    assert_eq!(fold(&scenario, &update), Ok(baseline));

    let mut garbled = scenario.update.clone();
    garbled.finalized_header.execution_branch = vec![B256::repeat_byte(0x98); 3];
    assert_eq!(fold(&scenario, &garbled), Err(Error::InvalidExecutionBranch("finalized")));
}

/// Claim: the form byte names the header shape, and the evidence must fit it. A compact header forced to the full form on a
/// Gloas update, and a Fulu full header forced to the compact form, are refused with `InvalidExecutionBranch`.
/// Why it is safe: the full form checks index 25 with exactly 4 entries, and the Gloas branch has 11. On a true Gloas body
/// index 25 lies below the `active_fields` chunk (node 3), a leaf that is no hash, so no full header verifies there. The
/// compact form needs a branch of 8, 9 or 11 entries, and the Fulu payload branch has 4.
#[test]
fn the_header_form_byte_must_fit_the_evidence() {
    let scenario = gloas_scenario();
    let fulu = build_update(&SEPOLIA, fulu_recipe());
    let mut full_in_gloas = scenario.update.clone();
    full_in_gloas.finalized_header.form = HeaderForm::Full;
    full_in_gloas.finalized_header.execution.logs_bloom = vec![0; 256];
    assert_eq!(fold(&scenario, &full_in_gloas), Err(Error::InvalidExecutionBranch("finalized")));

    let mut compact_in_fulu = fulu.update.clone();
    compact_in_fulu.finalized_header.form = HeaderForm::Compact;
    assert_eq!(
        verify_light_client_fold_with_fork_versions(&fulu.store, &[step(&compact_in_fulu, fulu.spec)], fulu.spec),
        Err(Error::InvalidExecutionBranch("finalized"))
    );
}

/// Claim: a Gloas-typed update whose finalized header lies BEFORE the fork is anchored in the body (index 812) and gets its
/// block number from the RLP too. The spec gives such an update a compact header for every header. The state of that
/// header is a Fulu state, so the state anchor does not apply. The control: a wrong RLP is refused there too.
#[test]
fn a_gloas_typed_update_with_a_pre_gloas_finalized_header_reads_the_number_from_the_rlp() {
    let recipe = UpdateRecipe {
        store_slot: 353_124 * 32 - 3_000,
        finalized_slot: 353_124 * 32 - 100,
        attested_slot: 353_124 * 32 + 10,
        signature_slot: 353_124 * 32 + 11,
        participants: 342,
        include_next_committee: false,
        store_knows_next_committee: false,
    };
    assert_eq!(
        LATE_GLOAS_SPEC.period_at_slot(recipe.store_slot),
        LATE_GLOAS_SPEC.period_at_slot(recipe.signature_slot)
    );
    let scenario = build_gloas_update(&LATE_GLOAS_SPEC, recipe);
    assert_eq!(LATE_GLOAS_SPEC.fork_at_slot(scenario.update.finalized_header.beacon.slot), ForkName::Fulu);
    let output = fold(&scenario, &scenario.update).expect("the cross-fork update verifies");
    assert_eq!(output.executionBlockNumber, scenario.finalized_block_number);
    assert_eq!(scenario.update.finalized_header.execution_branch.len(), 9, "a body branch at 812");

    let mut wrong_rlp = scenario.update.clone();
    wrong_rlp.finalized_header.execution_header_rlp =
        amsterdam_header_rlp(1, B256::repeat_byte(1), B256::repeat_byte(2)).to_vec();
    assert_eq!(fold(&scenario, &wrong_rlp), Err(Error::ExecutionHeaderHashMismatch));
}

/// Claim: the synthetic finalized header builder gives the finalized block of the number that was asked for, in a Gloas
/// slot and before the fork.
#[test]
fn the_compact_finalized_header_builder_names_the_block_number() {
    for slot in [GLOAS_FIRST_SLOT + 5_000, GLOAS_FIRST_SLOT - 5_000] {
        let header = synthetic_compact_finalized_header(&SEPOLIA, slot, 12_345_678);
        let verified = lc_core::update::verify_finalized_execution(&header).expect("verifies");
        assert_eq!(verified.block_number, 12_345_678);
        assert_eq!(verified.block_hash, keccak256(&header.execution_header_rlp));
    }
}

/// Claim: the wire format carries the execution header RLP of a compact header, a decoded input gives the same update,
/// and the guest entry point gives the same output as the library fold. A truncated input and trailing bytes are refused.
#[test]
fn the_wire_format_carries_the_rlp_and_the_guest_runs() {
    let scenario = gloas_scenario();
    let input = GuestInput {
        chain: ChainSelector::Sepolia,
        store: scenario.store.clone(),
        steps: vec![step(&scenario.update, &SEPOLIA)],
    };
    let bytes = encode_guest_input(&input);
    assert_eq!(bytes[0], 0x80 | 3, "the extended format flag and the Sepolia tag");
    assert_eq!(decode_guest_input(&bytes), Ok(input.clone()));

    use alloy_sol_types::SolValue;
    let expected = fold(&scenario, &scenario.update).unwrap().abi_encode();
    assert_eq!(run_light_client_guest(&bytes), Ok(expected));

    assert!(decode_guest_input(&bytes[..bytes.len() - 1]).is_err());
    let mut longer = bytes.clone();
    longer.push(0);
    assert!(decode_guest_input(&longer).is_err());
}

/// Claim: a JSON update keeps one form for all its headers, and a header with both keys or neither is malformed. The
/// light-client JSON of a node holds no RLP, so a parsed compact header has an empty RLP that the prover fills.
#[test]
fn the_json_parser_keeps_one_form_per_update() {
    let scenario = gloas_scenario();
    let fulu = build_update(&SEPOLIA, fulu_recipe());
    let parsed = light_client_update(&light_client_update_json(&scenario.update));
    let mut expected = scenario.update.clone();
    expected.attested_header.execution_header_rlp.clear();
    expected.finalized_header.execution_header_rlp.clear();
    assert_eq!(parsed, expected);

    let mut mixed = light_client_update_json(&scenario.update);
    mixed["finalized_header"] = light_client_header_json(&fulu.update.finalized_header);
    assert!(std::panic::catch_unwind(|| light_client_update(&mixed)).is_err(), "mixed forms are refused");

    let mut both = light_client_header_json(&scenario.update.finalized_header);
    both["execution"] = light_client_header_json(&fulu.update.finalized_header)["execution"].clone();
    assert!(std::panic::catch_unwind(|| lc_core::json::light_client_header(&both)).is_err());
    let mut neither = light_client_header_json(&scenario.update.finalized_header);
    neither.as_object_mut().unwrap().remove("execution_block_hash");
    assert!(std::panic::catch_unwind(|| lc_core::json::light_client_header(&neither)).is_err());
}
