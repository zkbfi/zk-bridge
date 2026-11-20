//! A real Ethereum mainnet update whose ATTESTED state was fetched, so the whole check runs on real data.
//!
//! The update, the bootstrap and the execution block were fetched on 2026-11-20 from one.valve.city (Ethereum mainnet beacon
//! API and execution RPC). The attested state (slot 15698818, about 340 MB, not on file) was fetched from the same beacon
//! node with `GET /eth/v2/debug/beacon/states/15698818` while the node still kept it, and `derive-attested-state-proofs`
//! wrote the branch of `genesis_validators_root` under its root into `ethereum/state_proofs.json`. The node keeps no states
//! older than its finalized checkpoint, so the attested states of the older updates in `ethereum/` (fetched 2026-10-20)
//! could not be fetched; their tests keep their reduced check (see `ethereum_real.rs`).
//!
//! Fixture files: `ethereum/attested_state_finality_update.json`, `ethereum/attested_state_bootstrap.json`,
//! `ethereum/attested_state_finalized_execution_block.json`, `ethereum/state_proofs.json`.

use alloy_primitives::B256;
use lc_core::chain::ETHEREUM_MAINNET;
use lc_core::ssz::is_valid_exact_branch;
use lc_core::types::LightClientUpdate;
use lc_core::update::{table_fork_version, verify_light_client_update, verify_light_client_update_with_fork_version};
use lc_testkit::json::{bootstrap, hex_b256, light_client_update, load_response, store_from_bootstrap};
use lc_testkit::real_proofs::{has_branch, known_genesis_validators_root_branch, with_known_branch};

/// The attested state root of the update: the root that `derive-attested-state-proofs` printed for the fetched state.
const ATTESTED_STATE_ROOT: &str = "0x93c2742c7b3910a8efc0eba7c78c6d469b7e8c79caf6f3f228ead44159afa6eb";

/// Generalized index of `genesis_validators_root` (state field 1) in a state of 64 field slots (Electra and Fulu).
const GENESIS_VALIDATORS_ROOT_GINDEX_ELECTRA: u64 = 64 + 1;

fn update() -> LightClientUpdate {
    with_known_branch(light_client_update(&load_response("ethereum/attested_state_finality_update.json")["data"]))
}

fn store() -> lc_core::types::LightClientStore {
    store_from_bootstrap(&bootstrap(&load_response("ethereum/attested_state_bootstrap.json")["data"]), None)
}

/// Claim: the fixture holds the branch for exactly the attested state of the update, and the branch proves the Ethereum
/// genesis validators root at state field 1 of the Electra layout (6 entries).
/// Why it matters: the program checks this branch before it trusts the signing domain. A branch under another state root,
/// or at another field, would let an update of another chain pass.
#[test]
fn the_branch_on_file_proves_the_genesis_validators_root_under_the_attested_state() {
    let update = update();
    let state_root: B256 = ATTESTED_STATE_ROOT.parse().unwrap();
    assert_eq!(update.attested_header.beacon.state_root, state_root);
    let branch =
        known_genesis_validators_root_branch(&state_root).expect("ethereum/state_proofs.json holds the branch");
    assert_eq!(branch.len(), 6);
    assert!(is_valid_exact_branch(
        &ETHEREUM_MAINNET.genesis_validators_root,
        &branch,
        GENESIS_VALIDATORS_ROOT_GINDEX_ELECTRA,
        &state_root
    ));
    assert!(has_branch(&update));
}

/// Claim: the real update verifies in full against a store from a real bootstrap of the same period: real signature under
/// the Fulu version, real finality and execution branches, and the real branch of `genesis_validators_root`. The output
/// matches the execution block that the execution RPC returned for the same number.
/// Why it matters: this is the first real Ethereum mainnet update that passes every check of the program, the branch of
/// `genesis_validators_root` included.
#[test]
fn a_real_mainnet_update_with_its_attested_state_verifies_in_full() {
    let update = update();
    let store = store();
    assert_eq!(table_fork_version(&ETHEREUM_MAINNET, update.signature_slot), [6, 0, 0, 0], "Fulu");
    let output = verify_light_client_update(&store, &update, &ETHEREUM_MAINNET).expect("the real update verifies");
    assert_eq!(output.genesisValidatorsRoot, ETHEREUM_MAINNET.genesis_validators_root);
    assert_eq!(output.previousHeaderRoot, store.header_root);
    assert_eq!(output.previousHeadSlot, store.header_slot);
    assert_eq!(output.newHeadSlot, update.finalized_header.beacon.slot);
    assert_eq!(output.newHeaderRoot, update.finalized_header.beacon.hash_tree_root());
    assert_eq!(output.syncCommitteeHash, output.previousSyncCommitteeHash);
    assert_eq!(output.nextSyncCommitteeHash, B256::ZERO, "a finality update proves no next committee");

    let execution = load_response("ethereum/attested_state_finalized_execution_block.json");
    assert_eq!(output.executionBlockHash, hex_b256(&execution["hash"]), "block hash from the execution RPC");
    let number = u64::from_str_radix(execution["number"].as_str().unwrap().trim_start_matches("0x"), 16).unwrap();
    assert_eq!(output.executionBlockNumber, number);
    assert!(update.sync_aggregate.participant_count() >= 342);
}

/// Claim: one changed bit in any entry of the real branch, a branch one entry short, or no branch at all makes the program
/// refuse the update with `InvalidGenesisValidatorsRootBranch`.
#[test]
fn a_changed_real_branch_is_refused() {
    let update = update();
    let store = store();
    let version = table_fork_version(&ETHEREUM_MAINNET, update.signature_slot);
    let check = |candidate: &LightClientUpdate| {
        verify_light_client_update_with_fork_version(&store, candidate, &ETHEREUM_MAINNET, version)
    };
    assert!(check(&update).is_ok(), "control");
    for index in 0..update.genesis_validators_root_branch.len() {
        let mut tampered = update.clone();
        tampered.genesis_validators_root_branch[index].0[31] ^= 1;
        assert_eq!(check(&tampered), Err(lc_core::Error::InvalidGenesisValidatorsRootBranch), "entry {index}");
    }
    let mut short = update.clone();
    short.genesis_validators_root_branch.pop();
    assert_eq!(check(&short), Err(lc_core::Error::InvalidGenesisValidatorsRootBranch), "short");
    let none = update.clone().with_genesis_validators_root_branch(Vec::new());
    assert_eq!(check(&none), Err(lc_core::Error::InvalidGenesisValidatorsRootBranch), "none");
}
