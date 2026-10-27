//! Real data still verifies after the layout moved from the fork table to the evidence, and the public values keep
//! their exact bytes.
//!
//! The golden values in `golden_public_values.txt` were produced by the program BEFORE the change (the commit that precedes
//! "choose layouts from the branch evidence"), from the same fixtures. A test that recomputes them with the new rules
//! and compares byte for byte shows that no layout rule changed an honest result. The 224 byte values of the fork
//! observation fixtures need no golden file: each `fork-observation/*.json` file carries its own `publicValues`, and
//! `fork_observation_fixtures_are_current` compares the regenerated files with the files on disk.
//!
//! Set `PRINT_GOLDEN=1` to print the current values in the format of the golden file.

use alloy_primitives::{hex, B256};
use alloy_sol_types::SolValue;
use lc_core::chain::ForkName;
use lc_core::chain::{ChainSpec, ETHEREUM_MAINNET, PULSECHAIN, SEPOLIA};
use lc_core::json::light_client_update;
use lc_core::layout::{
    state_layout_for_finality_branch_length, CAPELLA_DENEB_STATE_LAYOUT, ELECTRA_STATE_LAYOUT, GLOAS_STATE_LAYOUT,
};
use lc_core::ssz::is_valid_exact_branch;
use lc_core::ssz_state::{try_parse_state_for_fork, ParsedState};
use lc_core::types::{LightClientHeader, LightClientStore, LightClientUpdate};
use lc_core::update::{
    table_fork_version, verify_light_client_fold_with_fork_versions, verify_light_client_update, FoldStep,
};
use lc_testkit::json::{bootstrap, fixtures_dir, load_fixture, load_response, store_from_bootstrap};
use lc_testkit::pulsechain::real_update_and_store;

fn step(update: &LightClientUpdate, spec: &ChainSpec) -> FoldStep {
    FoldStep { update: update.clone(), fork_version: table_fork_version(spec, update.signature_slot) }
}

fn ethereum_finality_update() -> LightClientUpdate {
    light_client_update(&load_response("ethereum/finality_update.json")["data"])
}

fn ethereum_two_period_updates() -> Vec<LightClientUpdate> {
    load_response("ethereum/updates_two_periods.json")
        .as_array()
        .expect("array of updates")
        .iter()
        .map(|entry| light_client_update(&entry["data"]))
        .collect()
}

fn sepolia_state() -> ParsedState {
    let bytes = std::fs::read(fixtures_dir().join("sepolia/gloas_head_state.ssz")).expect("the state fixture");
    try_parse_state_for_fork(&bytes, ForkName::Gloas).expect("the real Gloas state parses")
}

/// The real Sepolia Gloas fold of `gloas_real.rs`: the real update with its finalized header anchored in the real state.
fn sepolia_gloas_fold_bytes() -> Vec<u8> {
    let response = load_response("sepolia/gloas_head_finality_update.json");
    let mut update = light_client_update(&response["data"]);
    let state = sepolia_state();
    let wrapper = load_fixture("sepolia/gloas_head_execution_header.json");
    let rlp = hex::decode(wrapper["raw_header"].as_str().expect("raw header")).expect("hex");
    let hash = state.latest_block_hash().expect("a Gloas state has latest_block_hash");
    update.finalized_header =
        LightClientHeader::compact(update.finalized_header.beacon, hash, state.field_branch(24), rlp);
    let store = LightClientStore {
        header_root: B256::repeat_byte(0x51),
        header_slot: update.finalized_header.beacon.slot - 1_000,
        current_sync_committee: state.current_sync_committee.clone(),
        next_sync_committee: None,
    };
    verify_light_client_fold_with_fork_versions(&store, &[step(&update, &SEPOLIA)], &SEPOLIA)
        .expect("the real Gloas fold verifies")
        .abi_encode()
}

/// Every golden case: a name and the 352 bytes that the program commits.
fn current_values() -> Vec<(&'static str, Vec<u8>)> {
    let finality_store =
        store_from_bootstrap(&bootstrap(&load_response("ethereum/bootstrap_same_period.json")["data"]), None);
    let ethereum_single = verify_light_client_update(&finality_store, &ethereum_finality_update(), &ETHEREUM_MAINNET)
        .expect("the real Ethereum finality update verifies")
        .abi_encode();

    let previous = bootstrap(&load_response("ethereum/bootstrap_previous_period.json")["data"]);
    let two_periods = ethereum_two_period_updates();
    let next = two_periods[0].next_sync_committee.as_ref().expect("the best update carries the next committee");
    let crossing_store = store_from_bootstrap(&previous, Some(next.committee.clone()));
    let fold_steps = [step(&two_periods[1], &ETHEREUM_MAINNET), step(&ethereum_finality_update(), &ETHEREUM_MAINNET)];
    let ethereum_fold = verify_light_client_fold_with_fork_versions(&crossing_store, &fold_steps, &ETHEREUM_MAINNET)
        .expect("the real two period fold verifies")
        .abi_encode();

    let (pulsechain_store, pulsechain_update) = real_update_and_store();
    let pulsechain = verify_light_client_update(&pulsechain_store, &pulsechain_update, &PULSECHAIN)
        .expect("the real PulseChain update verifies")
        .abi_encode();

    vec![
        ("ethereum_finality_update", ethereum_single),
        ("ethereum_updates_two_periods_fold", ethereum_fold),
        ("pulsechain_light_client_update", pulsechain),
        ("sepolia_gloas_head_fold", sepolia_gloas_fold_bytes()),
    ]
}

fn golden() -> Vec<(String, String)> {
    include_str!("golden_public_values.txt")
        .lines()
        .filter(|line| !line.is_empty())
        .map(|line| {
            let (name, value) = line.split_once(' ').expect("name and hex");
            (name.to_string(), value.to_string())
        })
        .collect()
}

/// Claim: the program commits byte-identical public values for every real fixture, before and after the change. The
/// expected bytes come from the OLD program, not from this code. Each value has 352 bytes (11 words).
/// Why it matters: the contract and the verification key bind these bytes, and an honest update must give the same bytes
/// whichever way the layout was chosen.
#[test]
fn real_data_keeps_the_public_values_byte_for_byte() {
    let current = current_values();
    if std::env::var("PRINT_GOLDEN").is_ok() {
        for (name, bytes) in &current {
            println!("{name} {}", hex::encode(bytes));
        }
        return;
    }
    let golden = golden();
    assert_eq!(golden.len(), current.len(), "one golden line for every case");
    for ((name, bytes), (golden_name, golden_hex)) in current.iter().zip(&golden) {
        assert_eq!(name, golden_name);
        assert_eq!(bytes.len(), 352, "{name}: 11 words");
        assert_eq!(&hex::encode(bytes), golden_hex, "{name}: public values changed");
    }
}

/// Claim: each real update names its layout by the finality branch length alone, and the exact branch check accepts the
/// real branches without stripping anything: Ethereum finality update (Fulu, length 7, indices 169 and 86), the two period
/// Ethereum updates (length 7, next committee branch of 6), PulseChain (Capella, length 6, next committee branch of 5)
/// and the two Sepolia Gloas updates (length 9, committee branch of 11).
/// Why it is safe: the length is the depth of the index, and each layout lands on the field that the specification names,
/// so the honest branch is the only branch that verifies there.
#[test]
fn real_updates_name_their_layout_by_branch_length_and_verify_exactly() {
    let (_, pulsechain) = real_update_and_store();
    let sepolia_head = light_client_update(&load_response("sepolia/gloas_head_finality_update.json")["data"]);
    let sepolia_second = light_client_update(&load_response("sepolia/gloas_finality_update.json")["data"]);
    let mut updates: Vec<(&str, LightClientUpdate, usize, usize)> = vec![
        ("ethereum finality update", ethereum_finality_update(), 7, 6),
        ("pulsechain update", pulsechain, 6, 5),
        ("sepolia gloas head update", sepolia_head, 9, 11),
        ("sepolia gloas update", sepolia_second, 9, 11),
    ];
    for (position, update) in ethereum_two_period_updates().into_iter().enumerate() {
        let name = if position == 0 { "ethereum two period, first" } else { "ethereum two period, second" };
        updates.push((name, update, 7, 6));
    }
    for (name, update, finality_length, committee_length) in updates {
        assert_eq!(update.finality_branch.len(), finality_length, "{name}: finality branch length");
        let layout = state_layout_for_finality_branch_length(update.finality_branch.len()).expect(name);
        let expected = match finality_length {
            6 => CAPELLA_DENEB_STATE_LAYOUT,
            7 => ELECTRA_STATE_LAYOUT,
            _ => GLOAS_STATE_LAYOUT,
        };
        assert_eq!(layout, expected, "{name}");
        assert!(
            is_valid_exact_branch(
                &update.finalized_header.beacon.hash_tree_root(),
                &update.finality_branch,
                layout.finalized_root_gindex,
                &update.attested_header.beacon.state_root,
            ),
            "{name}: the real finality branch verifies exactly at {}",
            layout.finalized_root_gindex
        );
        let Some(next) = &update.next_sync_committee else { continue };
        assert_eq!(next.branch.len(), committee_length, "{name}: committee branch length");
        assert!(
            is_valid_exact_branch(
                &next.committee.hash_tree_root().expect("a committee of 512"),
                &next.branch,
                layout.next_sync_committee_gindex,
                &update.attested_header.beacon.state_root,
            ),
            "{name}: the real committee branch verifies exactly at {}",
            layout.next_sync_committee_gindex
        );
    }
}
