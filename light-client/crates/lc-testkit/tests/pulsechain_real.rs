//! Real PulseChain data. PulseChain serves no light-client endpoints (they return 404), so the update is ASSEMBLED
//! from real data: a real 12 MB `BeaconState` (SSZ) and real blocks, hashed in full by `derive-pulsechain-fixtures`.
//! Every root it computed equals the root the node reports, so the branches are real, not synthetic.
//! The sync aggregate is the real aggregate of the block after the attested block. The committee is the real committee
//! of the state. Nothing in this file is synthetic.

use alloy_primitives::{Address, B256};
use lc_core::chain::{ChainSpec, ETHEREUM_MAINNET, PULSECHAIN};
use lc_core::update::{
    advance_light_client_store, table_fork_version, verify_light_client_update,
    verify_light_client_update_with_fork_version, verify_sync_aggregate,
};
use lc_core::withdrawal::{verify_withdrawal, WithdrawalContext};
use lc_core::Error;
use lc_testkit::json::{hex_b256, load_response};
use lc_testkit::pulsechain::{real_update_and_store, real_withdrawal_proof};

/// Claim: the PulseChain constants equal the live configuration (including the Bellatrix version `0x0000036b` that the
/// build contract table leaves out), the Deneb fork is never scheduled and the genesis validators root matches.
#[test]
fn real_pulsechain_constants_match_the_fetched_configuration() {
    let spec = load_response("pulsechain/chain_spec.json");
    let genesis = load_response("pulsechain/genesis.json");
    let data = &spec["data"];
    assert_eq!(hex_b256(&genesis["data"]["genesis_validators_root"]), PULSECHAIN.genesis_validators_root);
    for entry in PULSECHAIN.fork_schedule {
        let name = format!("{:?}", entry.fork_name).to_uppercase();
        let (version_key, epoch_key) = if name == "PHASE0" {
            ("GENESIS_FORK_VERSION".to_string(), String::new())
        } else {
            (format!("{name}_FORK_VERSION"), format!("{name}_FORK_EPOCH"))
        };
        assert_eq!(
            data[&version_key].as_str().unwrap(),
            format!("0x{}", alloy_primitives::hex::encode(entry.fork_version)),
            "{name}"
        );
        if !epoch_key.is_empty() {
            assert_eq!(data[&epoch_key].as_str().unwrap().parse::<u64>().unwrap(), entry.epoch, "{name} epoch");
        }
    }
    let number = |key: &str| -> u64 { data[key].as_str().unwrap().parse().unwrap() };
    assert_eq!(number("SECONDS_PER_SLOT"), 10);
    assert_eq!(number("SLOTS_PER_EPOCH"), PULSECHAIN.slots_per_epoch);
    assert_eq!(number("EPOCHS_PER_SYNC_COMMITTEE_PERIOD"), PULSECHAIN.epochs_per_sync_committee_period);
    assert_eq!(number("SYNC_COMMITTEE_SIZE"), 512);
    assert_eq!(data["DOMAIN_SYNC_COMMITTEE"].as_str().unwrap(), "0x07000000");
    assert_eq!(data["DENEB_FORK_EPOCH"].as_str().unwrap(), "18446744073709551615");
    assert_eq!(
        data["SLOTS_PER_HISTORICAL_ROOT"].as_str().map(|text| text.parse::<u64>().unwrap()),
        Some(lc_core::layout::SLOTS_PER_HISTORICAL_ROOT)
    );
}

/// Claim: the committee in the state equals the committee that the state endpoints report (validator indices, then public
/// keys by index). Two independent sources agree, so the committee in the fixture is the real PulseChain committee.
#[test]
fn real_committee_matches_the_state_endpoints() {
    let (store, _) = real_update_and_store();
    let indices = load_response("pulsechain/sync_committee_indices.json");
    let keys = load_response("pulsechain/sync_committee_pubkeys.json");
    let by_index: std::collections::HashMap<String, String> = keys["data"]
        .as_array()
        .unwrap()
        .iter()
        .map(|entry| (entry["index"].as_str().unwrap().to_string(), entry["pubkey"].as_str().unwrap().to_string()))
        .collect();
    let committee_indices = indices["data"]["validators"].as_array().unwrap();
    assert_eq!(committee_indices.len(), 512);
    for (position, index) in committee_indices.iter().enumerate() {
        let expected = &by_index[index.as_str().unwrap()];
        assert_eq!(
            format!("0x{}", alloy_primitives::hex::encode(store.current_sync_committee.pubkeys[position])),
            *expected,
            "member {position}"
        );
    }
}

/// Claim: the real sync aggregate of a PulseChain block verifies against the real committee with PulseChain's domain
/// (genesis validators root, fork version 0x0000036c, domain type 0x07000000). The aggregate signs the parent block root.
#[test]
fn real_pulsechain_sync_aggregate_verifies() {
    let (store, update) = real_update_and_store();
    let attested_root = update.attested_header.beacon.hash_tree_root();
    let version = table_fork_version(&PULSECHAIN, update.signature_slot);
    assert_eq!(version, [0, 0, 0x03, 0x6c]);
    assert!(update.sync_aggregate.participant_count() >= 342);
    verify_sync_aggregate(&PULSECHAIN, &store.current_sync_committee, &update.sync_aggregate, &attested_root, version)
        .expect("the real PulseChain signature verifies");
}

/// Claim: the full update verifies on PulseChain with REAL finality, next-committee and execution branches (Capella layout:
/// finality branch 6, committee branch 5, execution branch 4), and the output matches the execution RPC.
#[test]
fn real_pulsechain_update_verifies_end_to_end() {
    let (store, update) = real_update_and_store();
    assert_eq!(update.finality_branch.len(), 6);
    assert_eq!(update.next_sync_committee.as_ref().unwrap().branch.len(), 5);
    let (output, advanced) =
        advance_light_client_store(&store, &update, &PULSECHAIN).expect("real PulseChain update verifies");
    assert_eq!(output.genesisValidatorsRoot, PULSECHAIN.genesis_validators_root);
    assert_eq!(output.newHeaderRoot, update.finalized_header.beacon.hash_tree_root());
    let execution = load_response("pulsechain/finalized_execution_block.json");
    assert_eq!(output.executionBlockHash, hex_b256(&execution["hash"]), "block hash from the PulseChain execution RPC");
    assert_eq!(
        output.executionBlockNumber,
        u64::from_str_radix(execution["number"].as_str().unwrap().trim_start_matches("0x"), 16).unwrap()
    );
    assert_ne!(output.nextSyncCommitteeHash, B256::ZERO, "the real state proves the next committee");
    assert_eq!(advanced.header_slot, output.newHeadSlot);
    assert_eq!(PULSECHAIN.period_at_slot(output.newHeadSlot), PULSECHAIN.period_at_slot(output.previousHeadSlot));
}

/// Claim: the real PulseChain update verifies only with PulseChain's fork version as the input.
/// Ethereum's versions, PulseChain's older versions and arbitrary values all fail.
#[test]
fn real_pulsechain_update_verifies_only_with_the_correct_fork_version() {
    let (store, update) = real_update_and_store();
    let correct = [0, 0, 0x03, 0x6c];
    assert!(verify_light_client_update_with_fork_version(&store, &update, &PULSECHAIN, correct).is_ok());
    let mut wrong: Vec<[u8; 4]> = ETHEREUM_MAINNET.fork_schedule.iter().map(|entry| entry.fork_version).collect();
    wrong.extend(PULSECHAIN.fork_schedule.iter().map(|entry| entry.fork_version));
    wrong.retain(|version| *version != correct);
    for version in wrong {
        assert_eq!(
            verify_light_client_update_with_fork_version(&store, &update, &PULSECHAIN, version),
            Err(Error::SignatureVerificationFailed),
            "version {version:?}"
        );
    }
}

/// Claim: cross-chain replay fails. The same real PulseChain update, checked as if the chain had Ethereum's genesis
/// validators root, is refused. This is the H-01 / R2-09 defense on real data.
#[test]
fn real_pulsechain_update_does_not_verify_under_ethereums_genesis_validators_root() {
    let (store, update) = real_update_and_store();
    let foreign = ChainSpec { genesis_validators_root: ETHEREUM_MAINNET.genesis_validators_root, ..PULSECHAIN };
    assert!(verify_light_client_update(&store, &update, &PULSECHAIN).is_ok(), "control");
    assert_eq!(verify_light_client_update(&store, &update, &foreign), Err(Error::SignatureVerificationFailed));
}

fn context(anchor_root: B256, vault: Address) -> WithdrawalContext {
    WithdrawalContext { remote_vault: vault, local_chain_id: 1, stored_anchor_root: anchor_root }
}

/// Claim: the real beacon path works for a real PulseChain block (anchor state -> block_roots -> beacon header -> block hash
/// branch -> keccak256(header) -> receipts root -> receipt proof -> receipt -> log). A real block has no deposit event,
/// so the vault check must reach the log stage and stop there: first on the emitter, then (with the real emitter) on the topic.
/// Why it matters: this proves the generalized indices, the SSZ roots, the trie walker and the receipt decoder on real data.
#[test]
fn real_beacon_path_reaches_the_log_checks() {
    for name in ["finalized", "ancestor"] {
        // Find a receipt with a log.
        let (_, _, block) = real_withdrawal_proof(name, 0, 0);
        let (transaction_index, receipt) = block
            .receipts_json
            .as_array()
            .unwrap()
            .iter()
            .enumerate()
            .find(|(_, receipt)| !receipt["logs"].as_array().unwrap().is_empty())
            .expect("a receipt with logs");
        let emitter = Address::from_slice(&lc_testkit::json::hex_bytes(&receipt["logs"][0]["address"]));
        let (proof, anchor_root, _) = real_withdrawal_proof(name, transaction_index as u64, 0);

        let wrong_emitter = verify_withdrawal(&proof, &context(anchor_root, Address::repeat_byte(0xee)), &PULSECHAIN);
        assert_eq!(
            wrong_emitter,
            Err(Error::LogEmitterMismatch),
            "{name}: all earlier checks pass, the emitter is wrong"
        );
        let wrong_topic = verify_withdrawal(&proof, &context(anchor_root, emitter), &PULSECHAIN);
        assert_eq!(
            wrong_topic,
            Err(Error::LogTopicMismatch),
            "{name}: the emitter matches, the topic is not a deposit"
        );

        // The light client does not store this anchor: refused before anything else.
        let unknown = verify_withdrawal(&proof, &context(B256::repeat_byte(9), emitter), &PULSECHAIN);
        assert_eq!(unknown, Err(Error::AnchorNotStored));
    }
}

/// Claim: on the real path, a corrupted block_roots branch, a corrupted block hash branch, a wrong deposit slot and a
/// header RLP with one flipped byte are each refused by their own check (the real-data version of the rejection tests).
#[test]
fn real_beacon_path_rejects_tampering() {
    let (proof, anchor_root, _) = real_withdrawal_proof("finalized", 0, 0);
    let ctx = context(anchor_root, Address::repeat_byte(0xee));
    assert_eq!(
        verify_withdrawal(&proof, &ctx, &PULSECHAIN),
        Err(Error::LogEmitterMismatch),
        "control reaches the log stage"
    );

    let mut broken = proof.clone();
    broken.blockRootsBranch[3] = B256::repeat_byte(0x55);
    assert_eq!(verify_withdrawal(&broken, &ctx, &PULSECHAIN), Err(Error::InvalidBlockRootsBranch));

    let mut broken = proof.clone();
    broken.blockHashBranch[2] = B256::repeat_byte(0x55);
    assert_eq!(verify_withdrawal(&broken, &ctx, &PULSECHAIN), Err(Error::InvalidBlockHashBranch));

    let mut broken = proof.clone();
    broken.depositHeader.slot -= 1;
    assert_eq!(verify_withdrawal(&broken, &ctx, &PULSECHAIN), Err(Error::InvalidBlockRootsBranch));

    let mut rlp = proof.executionHeaderRlp.to_vec();
    let last = rlp.len() - 1;
    rlp[last] ^= 1;
    let mut broken = proof.clone();
    broken.executionHeaderRlp = rlp.into();
    assert_eq!(verify_withdrawal(&broken, &ctx, &PULSECHAIN), Err(Error::InvalidBlockHashBranch));
}
