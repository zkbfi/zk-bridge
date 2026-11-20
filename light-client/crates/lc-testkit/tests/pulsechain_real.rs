//! Real PulseChain data. PulseChain serves no light-client endpoints (they return 404), so the update is ASSEMBLED
//! from real data: a real 12 MB `BeaconState` (SSZ) and real blocks, hashed in full by `derive-pulsechain-fixtures`.
//! Every root it computed equals the root the node reports, so the branches are real, not synthetic.
//! The sync aggregate is the real aggregate of the block after the attested block. The committee is the real committee
//! of the state. Nothing in this file is synthetic.

use alloy_primitives::{keccak256, Address, B256};
use lc_core::ancestry::ancestry_leaf_gindex;
use lc_core::chain::{ChainSpec, ETHEREUM_MAINNET, PULSECHAIN};
use lc_core::execution::{decode_execution_header, decode_receipt, Log};
use lc_core::message::{extract_receipt, extract_transaction, message_of_log, MessageContext};
use lc_core::ssz::is_valid_exact_branch;
use lc_core::update::{
    advance_light_client_store, table_fork_version, verify_light_client_update,
    verify_light_client_update_with_fork_version, verify_sync_aggregate,
};
use lc_core::Error;
use lc_testkit::json::{hex_b256, load_response};
use lc_testkit::lc_message::abi::MessageProof;
use lc_testkit::lc_message::ancestry::{message_block_hash_gindex_for_shape, verify_beacon_path};
use lc_testkit::lc_message::message::verify_message;
use lc_testkit::pulsechain::{
    real_historical_message_proof, real_historical_paths, real_message_proof, real_update_and_store,
};

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
/// validators root, is refused twice over. The real state holds the PulseChain root in field 1, so the branch of
/// `genesis_validators_root` fails first: `InvalidGenesisValidatorsRootBranch`. The real signature binds the same root, and
/// the aggregate check alone shows it: `SignatureVerificationFailed`. This is the H-01 / R2-09 defense on real data.
/// Control: the update verifies under its own root.
#[test]
fn real_pulsechain_update_does_not_verify_under_ethereums_genesis_validators_root() {
    let (store, update) = real_update_and_store();
    let foreign = ChainSpec { genesis_validators_root: ETHEREUM_MAINNET.genesis_validators_root, ..PULSECHAIN };
    assert!(verify_light_client_update(&store, &update, &PULSECHAIN).is_ok(), "control");
    assert_eq!(verify_light_client_update(&store, &update, &foreign), Err(Error::InvalidGenesisValidatorsRootBranch));
    let signature_under = |spec: &ChainSpec| {
        lc_core::update::verify_sync_aggregate(
            spec,
            &store.current_sync_committee,
            &update.sync_aggregate,
            &update.attested_header.beacon.hash_tree_root(),
            [0, 0, 0x03, 0x6c],
        )
    };
    assert_eq!(signature_under(&PULSECHAIN), Ok(()), "control: the real signature");
    assert_eq!(signature_under(&foreign), Err(Error::SignatureVerificationFailed));
}

fn context(anchor_root: B256, bridge: Address) -> MessageContext {
    MessageContext { remote_bridge: bridge, local_chain_id: 1, remote_chain_id: 369, stored_anchor_root: anchor_root }
}

/// The beacon path of a real proof, checked by its parts: the anchor, the ancestry branch, and the block hash branch at the
/// payload position of the plain shape. The fixtures hold no state of these source blocks, so the proof carries no fork
/// proof (`missing_fork_proof`) and `verify_beacon_path` stops at the fork proof, the stage after the ancestry. PulseChain
/// runs Capella, a plain state of depth 5, so the block hash takes the plain rule, as the bridge does after a valid fork
/// proof of that shape. The errors are the ones of `verify_beacon_path`.
fn beacon_path_by_parts(proof: &MessageProof, anchor_root: B256) -> Result<B256, Error> {
    let anchor = lc_core::types::BeaconBlockHeader::from(&proof.anchorHeader);
    let source = lc_core::types::BeaconBlockHeader::from(&proof.sourceHeader);
    if anchor.hash_tree_root() != anchor_root {
        return Err(Error::AnchorNotStored);
    }
    let ancestry = ancestry_leaf_gindex(&PULSECHAIN, anchor.slot, source.slot)?;
    if !is_valid_exact_branch(&source.hash_tree_root(), &proof.ancestryBranch, ancestry, &anchor.state_root) {
        return Err(Error::InvalidAncestryBranch);
    }
    let block_hash = lc_core::receipts::header_hash(&proof.executionHeaderRlp);
    let position = message_block_hash_gindex_for_shape(&PULSECHAIN, 5, source.slot)?;
    if !is_valid_exact_branch(&block_hash, &proof.blockHashBranch, position, &source.body_root) {
        return Err(Error::InvalidBlockHashBranch);
    }
    Ok(block_hash)
}

/// The real log that a message proof names. It walks the stages of `verify_message` that real data can reach: the beacon
/// path (by its parts, see `beacon_path_by_parts`), the header, the receipt proof, the transaction proof (real transaction
/// bytes, `path_*_transactions.json`) and the receipt, in the order of `verify_message`.
fn real_log(proof: &MessageProof, anchor_root: B256) -> Log {
    assert_eq!(
        verify_beacon_path(&PULSECHAIN, proof, &anchor_root),
        Err(Error::InvalidForkShapeProof),
        "the fixtures hold no fork proof: the full path stops at the fork stage"
    );
    let block_hash = beacon_path_by_parts(proof, anchor_root).expect("the real beacon path verifies");
    assert_eq!(block_hash, lc_core::receipts::header_hash(&proof.executionHeaderRlp));
    let header = decode_execution_header(&proof.executionHeaderRlp).expect("header");
    let index = u64::try_from(proof.receiptIndex).unwrap();
    let receipt = extract_receipt(header.receipts_root, index, &proof.receiptProof).expect("receipt proof");
    extract_transaction(header.transactions_root, index, &proof.transactionProof).expect("transaction proof");
    let receipt = decode_receipt(&receipt).expect("receipt");
    receipt.logs[usize::try_from(proof.logIndex).unwrap()].clone()
}

/// The source transaction hash that the transaction stage of `verify_message` yields for a real proof: keccak256 of the
/// transaction bytes that the proof walks to under the `transactionsRoot` of the real header.
fn real_source_transaction_hash(proof: &MessageProof) -> Result<B256, Error> {
    let header = decode_execution_header(&proof.executionHeaderRlp).expect("header");
    let index = u64::try_from(proof.transactionIndex).unwrap();
    extract_transaction(header.transactions_root, index, &proof.transactionProof).map(keccak256)
}

/// Claim: the real message proofs carry real transaction proofs, so the transaction stage runs on real data. For each real
/// beacon path entry (the finalized block, its ancestor and the historical-path block) and every transaction of the block,
/// the stage yields the hash that the node listed at that index. The proof of the neighbouring transaction, a proof with
/// one flipped byte and an empty proof are refused with `TransactionProofInvalid`.
/// Why it matters: the bridge records this hash as the source transaction of the message. Until 2026-11-20 the fixtures
/// held the hashes and not the transactions, and real data stopped before this stage.
#[test]
fn real_message_proofs_pass_the_transaction_stage() {
    let blocks: Vec<(&str, Box<dyn Fn(u64) -> (MessageProof, B256, lc_testkit::pulsechain::RealBlock)>)> = vec![
        ("finalized", Box::new(|index| real_message_proof("finalized", index, 0))),
        ("ancestor", Box::new(|index| real_message_proof("ancestor", index, 0))),
        ("historical", Box::new(|index| real_historical_message_proof(index, 0))),
    ];
    for (name, proof_at) in blocks {
        let (_, _, block) = proof_at(0);
        let hashes: Vec<B256> = load_response(&format!("pulsechain/path_{name}_block.json"))["transactions"]
            .as_array()
            .unwrap()
            .iter()
            .map(hex_b256)
            .collect();
        assert_eq!(block.transactions.len(), hashes.len(), "{name}");
        for (index, hash) in hashes.iter().enumerate() {
            let (proof, _, _) = proof_at(index as u64);
            assert_eq!(real_source_transaction_hash(&proof), Ok(*hash), "{name}: transaction {index}");
        }
        let (proof, anchor_root, _) = proof_at(0);
        let _ = real_log_if_any(&proof, anchor_root, &block);
        let refused = |proof: &MessageProof| {
            matches!(real_source_transaction_hash(proof), Err(Error::TransactionProofInvalid(_)))
        };
        let mut empty = proof.clone();
        empty.transactionProof = Vec::new();
        assert!(refused(&empty), "{name}: empty proof");
        let mut flipped = proof.clone();
        let last = flipped.transactionProof.len() - 1;
        let mut bytes = flipped.transactionProof[last].to_vec();
        let middle = bytes.len() / 2;
        bytes[middle] ^= 1;
        flipped.transactionProof[last] = bytes.into();
        assert!(refused(&flipped), "{name}: flipped byte");
        if hashes.len() > 1 {
            let mut other = proof.clone();
            other.transactionProof = block.transaction_proofs[1].clone();
            assert!(refused(&other), "{name}: the proof of another transaction");
        }
    }
}

/// Walks `real_log` when the first receipt of the block has a log (the historical block may have none).
fn real_log_if_any(proof: &MessageProof, anchor_root: B256, block: &lc_testkit::pulsechain::RealBlock) -> Option<Log> {
    let has_log = !block.receipts_json[0]["logs"].as_array().unwrap().is_empty();
    has_log.then(|| real_log(proof, anchor_root))
}

/// Claim: the real beacon path works for a real PulseChain block (anchor state -> block_roots -> beacon header -> block hash
/// branch -> keccak256(header) -> receipts root -> receipt proof -> receipt -> log). A real block has no message event,
/// so the log check must stop on the emitter, and with the real emitter on the topic. The fixtures hold no state of the
/// source block, so `verify_message` itself stops at the fork proof, after the ancestry passed; the later beacon stage is
/// checked by its parts. Why it matters: this proves the generalized indices, the SSZ roots, the trie walker and the
/// receipt decoder on real data.
#[test]
fn real_beacon_path_reaches_the_log_checks() {
    for name in ["finalized", "ancestor"] {
        // Find a receipt with a log.
        let (_, _, block) = real_message_proof(name, 0, 0);
        let (transaction_index, receipt) = block
            .receipts_json
            .as_array()
            .unwrap()
            .iter()
            .enumerate()
            .find(|(_, receipt)| !receipt["logs"].as_array().unwrap().is_empty())
            .expect("a receipt with logs");
        let emitter = Address::from_slice(&lc_testkit::json::hex_bytes(&receipt["logs"][0]["address"]));
        let (proof, anchor_root, _) = real_message_proof(name, transaction_index as u64, 0);

        let outcome = verify_message(&proof, &context(anchor_root, emitter), &PULSECHAIN);
        assert_eq!(outcome, Err(Error::InvalidForkShapeProof), "{name}: the ancestry passes, the fork proof is empty");

        let log = real_log(&proof, anchor_root);
        assert_eq!(message_of_log(&log, Address::repeat_byte(0xee)), Err(Error::LogEmitterMismatch), "{name}");
        assert_eq!(message_of_log(&log, emitter), Err(Error::LogTopicMismatch), "{name}: the emitter matches");

        // The light client does not store this anchor: refused before anything else.
        let unknown = verify_message(&proof, &context(B256::repeat_byte(9), emitter), &PULSECHAIN);
        assert_eq!(unknown, Err(Error::AnchorNotStored));
    }
}

/// Claim: on the real path, a corrupted block_roots branch, a corrupted block hash branch, a wrong source slot and a
/// header RLP with one flipped byte are each refused by their own check (the real-data version of the rejection tests).
/// The ancestry checks run before the fork proof, so `verify_message` reports them; the block hash checks run after it, so
/// they are checked by their parts (`beacon_path_by_parts`).
#[test]
fn real_beacon_path_rejects_tampering() {
    let (proof, anchor_root, _) = real_message_proof("finalized", 0, 0);
    let ctx = context(anchor_root, Address::repeat_byte(0xee));
    assert_eq!(verify_message(&proof, &ctx, &PULSECHAIN), Err(Error::InvalidForkShapeProof), "control: fork stage");
    assert!(beacon_path_by_parts(&proof, anchor_root).is_ok(), "control: the parts pass");

    let mut broken = proof.clone();
    broken.ancestryBranch[3] = B256::repeat_byte(0x55);
    assert_eq!(verify_message(&broken, &ctx, &PULSECHAIN), Err(Error::InvalidAncestryBranch));

    let mut broken = proof.clone();
    broken.blockHashBranch[2] = B256::repeat_byte(0x55);
    assert_eq!(beacon_path_by_parts(&broken, anchor_root), Err(Error::InvalidBlockHashBranch));

    let mut broken = proof.clone();
    broken.sourceHeader.slot -= 1;
    assert_eq!(verify_message(&broken, &ctx, &PULSECHAIN), Err(Error::InvalidAncestryBranch));

    let mut rlp = proof.executionHeaderRlp.to_vec();
    let last = rlp.len() - 1;
    rlp[last] ^= 1;
    let mut broken = proof.clone();
    broken.executionHeaderRlp = rlp.into();
    assert_eq!(beacon_path_by_parts(&broken, anchor_root), Err(Error::InvalidBlockHashBranch));
}

// ---- historical ancestry on real PulseChain data ----

const HISTORICAL_ENTRIES: [&str; 6] = [
    "capella_fork_block",
    "era_zero_last_block",
    "era_previous_last_block",
    "era_first_block",
    "era_middle_block",
    "era_last_block",
];

/// Claim: the era formula holds on real PulseChain data, for three eras: era 0 (the Capella era: Capella starts at slot 96,
/// in the middle of the era), the era before an era edge and the era after it. In each, the entry at list position
/// `era - capellaEra` of the anchor's `historical_summaries` has a `block_summary_root` equal to the hash tree root of the
/// 8192 block roots of that era. The tool rebuilt each era from the canonical block roots of the node, checked the method
/// against the anchor state where they overlap, and stopped on any mismatch.
/// Here the test checks the stored evidence again with `capellaEra` from the chain configuration: the position, the length of the
/// list, and the climb from a real header leaf through 13 levels to the same `block_summary_root`.
/// Why it matters: an off-by-one here would make a whole era unreachable or wrongly reachable.
#[test]
fn real_era_formula_matches_the_node() {
    let paths = real_historical_paths();
    let capella_era = PULSECHAIN.capella_era().unwrap();
    assert_eq!(capella_era, 0, "PulseChain: Capella epoch 3 is slot 96, inside era 0");
    let anchor_era = paths.anchor.slot / 8192;
    let checks = paths.response["era_formula_checks"].as_array().expect("checks");
    assert!(checks.len() >= 3, "era 0 and two later eras");
    for check in checks {
        let era = check["era"].as_u64().unwrap();
        assert_eq!(check["index"].as_u64().unwrap(), era - capella_era, "index = era - capellaEra");
        assert_eq!(check["anchor_state_summaries_length"].as_u64().unwrap(), anchor_era - capella_era);
        assert_eq!(check["equal"], true);
        assert_eq!(check["block_summary_root_in_anchor_state"], check["hash_tree_root_of_era_block_roots"]);
        assert_ne!(check["block_summary_root_in_anchor_state"], format!("{:#x}", B256::ZERO));
    }
    assert!(checks.iter().any(|check| check["era"] == 0), "the Capella era itself");
    // The overlap with the anchor's own block_roots validated the rebuild method for the newest complete era.
    assert!(checks.iter().any(|check| check["slots_compared_with_anchor_block_roots"].as_u64().unwrap() > 1000));

    // Climb again from the stored data: leaf -> 13 levels -> block_summary_root of the matching check.
    for name in HISTORICAL_ENTRIES {
        let source = paths.source_header(name);
        let branch = paths.ancestry_branch(name);
        let era = source.slot / 8192;
        let check = checks.iter().find(|check| check["era"] == era).expect("a check for the era");
        let mut node = source.hash_tree_root();
        for (height, sibling) in branch[..13].iter().enumerate() {
            node = if (source.slot % 8192) >> height & 1 == 1 {
                lc_core::ssz::hash_pair(sibling, &node)
            } else {
                lc_core::ssz::hash_pair(&node, sibling)
            };
        }
        assert_eq!(format!("{node:#x}"), check["block_summary_root_in_anchor_state"].as_str().unwrap(), "{name}");
    }
}

/// Claim: a real header in an older era is proven under a real anchor state through `historical_summaries`, at the
/// generalized index built in the stated order, with an exact 44 entry branch: the first Capella block, both sides of an
/// era edge (last slot of one era, first slot of the next) and a middle block. All of them are more than 8192 slots before
/// the anchor, so the bridge takes the historical path.
/// The last block of the newest complete era is only 5117 slots before this anchor. The bridge takes the RECENT path for it,
/// so its historical branch is the reverse mix-up: a valid path of the real anchor state at the historical index that the
/// bridge refuses at the `block_roots` index.
#[test]
fn real_historical_ancestry_verifies() {
    use lc_core::ancestry::{ancestry_leaf_gindex, ancestry_path_for_slots, historical_leaf_gindex, AncestryPath};
    use lc_core::layout::CAPELLA_DENEB_STATE_LAYOUT;
    use lc_core::ssz::is_valid_exact_branch;
    let paths = real_historical_paths();
    let field = CAPELLA_DENEB_STATE_LAYOUT.historical_summaries_gindex;
    for name in HISTORICAL_ENTRIES {
        let source = paths.source_header(name);
        let leaf = source.hash_tree_root();
        let branch = paths.ancestry_branch(name);
        assert_eq!(branch.len(), 44, "{name}");
        let historical_gindex = historical_leaf_gindex(field, source.slot / 8192, source.slot).unwrap();
        assert!(
            is_valid_exact_branch(&leaf, &branch, historical_gindex, &paths.anchor.state_root),
            "{name}: slot {} at generalized index {historical_gindex}",
            source.slot
        );
        let bridge_gindex = ancestry_leaf_gindex(&PULSECHAIN, paths.anchor.slot, source.slot).unwrap();
        let path = ancestry_path_for_slots(paths.anchor.slot, source.slot).unwrap();
        if name == "era_last_block" {
            assert_eq!(path, AncestryPath::Recent, "5117 slots before the anchor");
            assert_ne!(bridge_gindex, historical_gindex);
            assert!(!is_valid_exact_branch(&leaf, &branch, bridge_gindex, &paths.anchor.state_root), "reverse mix-up");
            continue;
        }
        assert_eq!(path, AncestryPath::Historical, "{name}");
        assert_eq!(bridge_gindex, historical_gindex, "{name}: the bridge picks the same index");
    }
    // The edge slots are the real edge: one era ends at slot 8191 and one at era_first_block - 1.
    let first = paths.source_header("era_first_block").slot;
    assert_eq!(paths.source_header("era_previous_last_block").slot, first - 1);
    assert_eq!(first % 8192, 0);
    assert_eq!(paths.source_header("era_last_block").slot % 8192, 8191);
    assert_eq!(paths.source_header("era_zero_last_block").slot, 8191);
    assert!(paths.source_header("capella_fork_block").slot >= PULSECHAIN.capella_fork_slot().unwrap());
}

/// Claim: on real data every wrong version of the proof fails. The neighbouring era index on either side, the block_roots
/// index, a padded branch, a short branch and each flipped entry are refused. The honest branch passes (control).
#[test]
fn real_historical_ancestry_rejects_wrong_index_length_and_entries() {
    use lc_core::ancestry::{block_roots_leaf_gindex, historical_leaf_gindex};
    use lc_core::layout::CAPELLA_DENEB_STATE_LAYOUT;
    use lc_core::ssz::is_valid_exact_branch;
    let paths = real_historical_paths();
    let field = CAPELLA_DENEB_STATE_LAYOUT.historical_summaries_gindex;
    for name in HISTORICAL_ENTRIES {
        let source = paths.source_header(name);
        let (leaf, root) = (source.hash_tree_root(), paths.anchor.state_root);
        let branch = paths.ancestry_branch(name);
        let index = source.slot / 8192;
        let check = |branch: &[B256], gindex: u64| is_valid_exact_branch(&leaf, branch, gindex, &root);
        assert!(check(&branch, historical_leaf_gindex(field, index, source.slot).unwrap()), "{name}: control");
        for wrong in [index + 1, index.wrapping_sub(1)] {
            let gindex = historical_leaf_gindex(field, wrong, source.slot).unwrap_or(0).max(1);
            assert!(!check(&branch, gindex), "{name}: wrong era index {wrong}");
        }
        let recent = block_roots_leaf_gindex(CAPELLA_DENEB_STATE_LAYOUT.block_roots_gindex, source.slot).unwrap();
        assert!(!check(&branch, recent), "{name}: block_roots index");
        let gindex = historical_leaf_gindex(field, index, source.slot).unwrap();
        let mut padded = branch.clone();
        padded.insert(0, B256::ZERO);
        assert!(!check(&padded, gindex), "{name}: padded");
        assert!(!check(&branch[..43], gindex), "{name}: short");
        for position in 0..branch.len() {
            let mut flipped = branch.clone();
            flipped[position].0[7] ^= 1;
            assert!(!check(&flipped, gindex), "{name}: entry {position}");
        }
    }
}

/// Claim: a full message proof over the real historical path passes the anchor and the historical ancestry branch and
/// stops at the fork proof, which the fixtures do not hold; by its parts it passes the block hash branch, the keccak256 of
/// the header and the receipt proof, and the log of a real block is no message. With the wrong index (a branch of the
/// neighbouring entry) it stops earlier, at the ancestry branch.
#[test]
fn real_historical_message_reaches_the_fork_stage() {
    let (proof, anchor_root, block) = real_historical_message_proof(0, 0);
    assert_eq!(proof.ancestryBranch.len(), 44);
    assert!(proof.anchorHeader.slot - proof.sourceHeader.slot > 8192, "the historical path");
    let has_log = !block.receipts_json[0]["logs"].as_array().unwrap().is_empty();
    let ctx = context(anchor_root, Address::repeat_byte(0xee));
    assert_eq!(verify_message(&proof, &ctx, &PULSECHAIN), Err(Error::InvalidForkShapeProof), "control: fork stage");
    assert!(beacon_path_by_parts(&proof, anchor_root).is_ok(), "control: the parts pass");
    if has_log {
        let log = real_log(&proof, anchor_root);
        assert_eq!(message_of_log(&log, ctx.remote_bridge), Err(Error::LogEmitterMismatch));
    }

    let mut padded = proof.clone();
    padded.ancestryBranch.insert(0, B256::ZERO);
    assert_eq!(verify_message(&padded, &ctx, &PULSECHAIN), Err(Error::InvalidAncestryBranch));
    let mut other_entry = proof.clone();
    other_entry.ancestryBranch = real_historical_paths().ancestry_branch("era_first_block");
    assert_eq!(verify_message(&other_entry, &ctx, &PULSECHAIN), Err(Error::InvalidAncestryBranch));
    let unknown = MessageContext { stored_anchor_root: B256::repeat_byte(9), ..ctx };
    assert_eq!(verify_message(&proof, &unknown, &PULSECHAIN), Err(Error::AnchorNotStored));
}
