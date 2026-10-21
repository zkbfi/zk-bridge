//! Real Ethereum mainnet data: light-client updates fetched from public beacon nodes, verified end to end.
//!
//! Every test here uses REAL data from `tests/fixtures/ethereum/` (fetched 2026-10-20, source URLs inside each file).
//! The data is from the Fulu fork, so it exercises the Electra layout (branch lengths 7, 6, 6 and 4).

use alloy_primitives::B256;
use lc_core::abi::LightClientOutput;
use lc_core::chain::ETHEREUM_MAINNET;
use lc_core::layout::{state_layout_for_fork, ELECTRA_STATE_LAYOUT};
use lc_core::ssz::is_valid_normalized_merkle_branch;
use lc_core::types::LightClientStore;
use lc_core::update::{
    advance_light_client_store, verify_current_sync_committee_branch, verify_light_client_update, verify_sync_aggregate,
};
use lc_testkit::json::{bootstrap, hex_b256, light_client_update, load_response, store_from_bootstrap, Bootstrap};

fn finality_update() -> lc_core::types::LightClientUpdate {
    light_client_update(&load_response("ethereum/finality_update.json")["data"])
}

fn same_period_bootstrap() -> Bootstrap {
    bootstrap(&load_response("ethereum/bootstrap_same_period.json")["data"])
}

fn two_period_updates() -> Vec<lc_core::types::LightClientUpdate> {
    load_response("ethereum/updates_two_periods.json")
        .as_array()
        .expect("array of updates")
        .iter()
        .map(|entry| light_client_update(&entry["data"]))
        .collect()
}

/// Claim: the Ethereum constants equal what the live beacon API returned (fork versions, fork epochs, timing, genesis
/// validators root). Why it matters: a typo in a fork version changes the signing domain and breaks every proof.
#[test]
fn real_ethereum_constants_match_the_fetched_configuration() {
    let spec = load_response("ethereum/chain_spec.json");
    let genesis = load_response("ethereum/genesis.json");
    let data = &spec["data"];
    assert_eq!(hex_b256(&genesis["data"]["genesis_validators_root"]), ETHEREUM_MAINNET.genesis_validators_root);
    let mut matched = 0;
    for entry in ETHEREUM_MAINNET.fork_schedule {
        let (name, _) = (format!("{:?}", entry.fork_name).to_uppercase(), 0);
        if name == "PHASE0" {
            assert_eq!(
                data["GENESIS_FORK_VERSION"].as_str().unwrap(),
                format!("0x{}", alloy_primitives::hex::encode(entry.fork_version))
            );
            matched += 1;
            continue;
        }
        let version = data[format!("{name}_FORK_VERSION")].as_str().expect("fork version");
        let epoch: u64 = data[format!("{name}_FORK_EPOCH")].as_str().expect("fork epoch").parse().unwrap();
        assert_eq!(version, format!("0x{}", alloy_primitives::hex::encode(entry.fork_version)), "{name} version");
        assert_eq!(epoch, entry.epoch, "{name} epoch");
        matched += 1;
    }
    assert_eq!(matched, 8);
    let number = |key: &str| -> u64 { data[key].as_str().unwrap().parse().unwrap() };
    assert_eq!(number("SECONDS_PER_SLOT"), ETHEREUM_MAINNET.seconds_per_slot);
    assert_eq!(number("SLOTS_PER_EPOCH"), ETHEREUM_MAINNET.slots_per_epoch);
    assert_eq!(number("EPOCHS_PER_SYNC_COMMITTEE_PERIOD"), ETHEREUM_MAINNET.epochs_per_sync_committee_period);
    assert_eq!(number("SYNC_COMMITTEE_SIZE"), 512);
    assert_eq!(number("SLOTS_PER_HISTORICAL_ROOT"), lc_core::layout::SLOTS_PER_HISTORICAL_ROOT);
    assert_eq!(data["DOMAIN_SYNC_COMMITTEE"].as_str().unwrap(), "0x07000000");
}

/// Claim: a real bootstrap is internally consistent: its committee hashes into the header state root through the
/// Electra current-committee index. This checks the committee root (SSZ) and the index 86 against real data.
#[test]
fn real_bootstrap_committee_branch_verifies() {
    let bootstrap = same_period_bootstrap();
    verify_current_sync_committee_branch(
        &ETHEREUM_MAINNET,
        &bootstrap.header.beacon,
        &bootstrap.committee,
        &bootstrap.branch,
    )
    .expect("real bootstrap branch");
    assert_eq!(bootstrap.branch.len(), 6);
}

/// Claim: a real finality update verifies against a store built from a real bootstrap of the same period: 460+ real
/// signers, the real finality branch, both real execution branches. The output matches an independent source:
/// the execution block hash and number come from the Ethereum execution RPC, fetched separately.
#[test]
fn real_ethereum_finality_update_verifies_end_to_end() {
    let update = finality_update();
    let store = store_from_bootstrap(&same_period_bootstrap(), None);
    let output = verify_light_client_update(&store, &update, &ETHEREUM_MAINNET).expect("real update verifies");

    assert_eq!(output.genesisValidatorsRoot, ETHEREUM_MAINNET.genesis_validators_root);
    assert_eq!(output.previousHeaderRoot, store.header_root);
    assert_eq!(output.previousHeadSlot, store.header_slot);
    assert_eq!(output.newHeadSlot, update.finalized_header.beacon.slot);
    assert_eq!(output.newHeaderRoot, update.finalized_header.beacon.hash_tree_root());
    assert_eq!(output.syncCommitteeHash, output.previousSyncCommitteeHash);
    assert_eq!(output.nextSyncCommitteeHash, B256::ZERO, "a finality update proves no next committee");

    let execution = load_response("ethereum/finalized_execution_block.json");
    assert_eq!(output.executionBlockHash, hex_b256(&execution["hash"]), "block hash from the execution RPC");
    let number = u64::from_str_radix(execution["number"].as_str().unwrap().trim_start_matches("0x"), 16).unwrap();
    assert_eq!(output.executionBlockNumber, number);
    assert!(update.sync_aggregate.participant_count() >= 342);
}

/// Claim: the real finality branch has the Electra shape (7 entries) and fails under the Capella index.
/// It is the real-data version of "the wrong fork's generalized index".
#[test]
fn real_update_uses_the_electra_layout() {
    let update = finality_update();
    assert_eq!(update.finality_branch.len(), 7);
    let root = update.finalized_header.beacon.hash_tree_root();
    let state_root = update.attested_header.beacon.state_root;
    assert!(is_valid_normalized_merkle_branch(
        &root,
        &update.finality_branch,
        ELECTRA_STATE_LAYOUT.finalized_root_gindex,
        &state_root
    ));
    assert!(!is_valid_normalized_merkle_branch(&root, &update.finality_branch, 105, &state_root));
    assert_eq!(
        state_layout_for_fork(ETHEREUM_MAINNET.fork_at_slot(update.attested_header.beacon.slot)),
        Ok(ELECTRA_STATE_LAYOUT)
    );
}

/// Claim: two consecutive real updates cross a sync committee period boundary and then a real finality update
/// verifies on top: bootstrap in period N-1, best update of N-1 (reveals committee N), best update of N (signed by the
/// committee of N, the stored NEXT committee), then the current finality update.
/// The store's next committee is taken from the real update of period N-1 after its branch and signature are checked
/// (see the comments inside), which models the contract learning the committee from an earlier update.
#[test]
fn real_updates_cross_a_period_boundary_and_chain() {
    let bootstrap = bootstrap(&load_response("ethereum/bootstrap_previous_period.json")["data"]);
    let updates = two_period_updates();
    let (first, second) = (&updates[0], &updates[1]);
    let spec = &ETHEREUM_MAINNET;

    // Step 1: the first update names the next committee. It is signed by the committee of the bootstrap period.
    let attested_root = first.attested_header.beacon.hash_tree_root();
    verify_sync_aggregate(
        spec,
        &bootstrap.committee,
        &first.sync_aggregate,
        &attested_root,
        lc_core::update::table_fork_version(spec, first.signature_slot),
    )
    .expect("period N-1 committee signed the first update");
    let next = first.next_sync_committee.as_ref().expect("the best update of a period carries the next committee");
    assert!(is_valid_normalized_merkle_branch(
        &next.committee.hash_tree_root().unwrap(),
        &next.branch,
        ELECTRA_STATE_LAYOUT.next_sync_committee_gindex,
        &first.attested_header.beacon.state_root
    ));

    // Step 2: the second update finalizes a header in the next period. It needs the next committee in the store.
    let store = store_from_bootstrap(&bootstrap, Some(next.committee.clone()));
    let without_next = store_from_bootstrap(&bootstrap, None);
    assert_eq!(
        verify_light_client_update(&without_next, second, spec),
        Err(lc_core::Error::NextSyncCommitteeUnknown),
        "control: without the next committee the same update must fail"
    );
    let (output, store_after) = advance_light_client_store(&store, second, spec).expect("period crossing verifies");
    assert_eq!(spec.period_at_slot(output.newHeadSlot), spec.period_at_slot(output.previousHeadSlot) + 1);
    assert_eq!(output.syncCommitteeHash, store.next_sync_committee.as_ref().unwrap().hash_tree_root().unwrap());
    assert_ne!(output.syncCommitteeHash, output.previousSyncCommitteeHash);
    let second_next = second.next_sync_committee.as_ref().expect("second update carries committee N+1");
    assert_eq!(output.nextSyncCommitteeHash, second_next.committee.hash_tree_root().unwrap());
    assert_eq!(store_after.current_sync_committee, store.next_sync_committee.clone().unwrap());

    // Step 3: the newest finality update verifies on top of the advanced store.
    let latest = finality_update();
    let (final_output, _): (LightClientOutput, LightClientStore) =
        advance_light_client_store(&store_after, &latest, spec).expect("chained finality update verifies");
    assert_eq!(final_output.previousHeaderRoot, output.newHeaderRoot);
    assert_eq!(final_output.previousSyncCommitteeHash, output.syncCommitteeHash);
    assert_eq!(final_output.newHeadSlot, latest.finalized_header.beacon.slot);
    assert!(final_output.newHeadSlot > output.newHeadSlot);
}

/// Claim: the real update does not verify against a store whose head is not before the finalized header.
/// A store that already holds the update's finalized header must refuse it (the head must strictly advance).
#[test]
fn real_update_is_refused_when_the_head_does_not_advance() {
    let update = finality_update();
    let mut store = store_from_bootstrap(&same_period_bootstrap(), None);
    store.header_slot = update.finalized_header.beacon.slot;
    assert!(matches!(
        verify_light_client_update(&store, &update, &ETHEREUM_MAINNET),
        Err(lc_core::Error::NotFinalizedProgress(_))
    ));
}

/// Claim: a real update verifies with the correct fork version supplied as an input, and fails with any other version.
/// Why it matters: the guest takes the version as input. The committee signed the domain that contains the version,
/// so a wrong version cannot produce a valid signature. The test tries the whole Ethereum table, PulseChain's
/// versions and a few arbitrary values: exactly one version (the real one) passes.
#[test]
fn real_update_verifies_only_with_the_correct_fork_version() {
    let update = finality_update();
    let store = store_from_bootstrap(&same_period_bootstrap(), None);
    let correct = lc_core::update::table_fork_version(&ETHEREUM_MAINNET, update.signature_slot);
    assert_eq!(correct, [6, 0, 0, 0], "the live update is signed under the Fulu version");
    let with_version = |version: [u8; 4]| {
        lc_core::update::verify_light_client_update_with_fork_version(&store, &update, &ETHEREUM_MAINNET, version)
    };
    assert_eq!(with_version(correct), verify_light_client_update(&store, &update, &ETHEREUM_MAINNET));
    assert!(with_version(correct).is_ok());

    let mut wrong: Vec<[u8; 4]> = ETHEREUM_MAINNET.fork_schedule.iter().map(|entry| entry.fork_version).collect();
    wrong.extend(lc_core::chain::PULSECHAIN.fork_schedule.iter().map(|entry| entry.fork_version));
    wrong.extend([[0xff; 4], [6, 0, 0, 1], [0, 0, 0, 6]]);
    wrong.retain(|version| *version != correct);
    for version in wrong {
        assert_eq!(with_version(version), Err(lc_core::Error::SignatureVerificationFailed), "version {version:?}");
    }
}
