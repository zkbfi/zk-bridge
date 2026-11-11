//! `verify_message` on SYNTHETIC beacon chains, receipts and transactions for both layouts (Capella for PulseChain, Electra
//! for Ethereum). The receipts trie, the transactions trie, the header RLP and the SSZ branches are built by the test-only
//! builders in `lc_testkit::synthetic`. Real-data coverage of the stages before the transaction proof is in
//! `pulsechain_real.rs` and `receipts_real.rs`: the real fixtures hold no transaction bodies.
//!
//! Each rejection test also shows the honest path passes (control).

use alloy_primitives::{keccak256, Bytes, B256, U256};
use alloy_sol_types::SolCall;
use lc_core::abi::{executeMessageCall, MessageProof, USER_REQUEST_TOPIC};
use lc_core::chain::{ChainSpec, ETHEREUM_MAINNET, PULSECHAIN};
use lc_core::execution::Log;
use lc_core::message::{
    encode_message, message_id_for, verify_message, MessageContext, VerifiedMessage, DATA_TYPE_CONFIRM,
};
use lc_core::Error;
use lc_testkit::message_blocks::{honest_fields, remote_chain_id, standard_receipts, ATTACKER, BRIDGE};
use lc_testkit::synthetic::{
    build_message, message_log, raw_message_log, synthetic_transaction, MessageScenario, ReceiptSpec,
};

/// (spec, source slot, anchor slot, local chain identifier of the verifier)
fn layouts() -> Vec<(&'static ChainSpec, u64, u64, u64)> {
    vec![(&PULSECHAIN, 10_872_000, 10_872_500, 1), (&ETHEREUM_MAINNET, 15_476_000, 15_476_500, 369)]
}

fn context(scenario: &MessageScenario, local_chain_id: u64) -> MessageContext {
    MessageContext {
        remote_bridge: BRIDGE,
        local_chain_id,
        remote_chain_id: remote_chain_id(scenario.spec),
        stored_anchor_root: scenario.stored_anchor_root,
    }
}

fn scenario_for(
    spec: &'static ChainSpec,
    source_slot: u64,
    anchor_slot: u64,
    local: u64,
    tx: u64,
    log: u64,
) -> MessageScenario {
    build_message(spec, &standard_receipts(spec, local), tx, log, source_slot, anchor_slot)
}

/// Verifies the message at receipt `tx`, log `log`, on every layout, and calls `check` with each outcome.
fn on_both_layouts(tx: u64, log: u64, check: impl Fn(Result<VerifiedMessage, Error>, &MessageScenario)) {
    for (spec, source_slot, anchor_slot, local) in layouts() {
        let scenario = scenario_for(spec, source_slot, anchor_slot, local, tx, log);
        check(verify_message(&scenario.proof, &context(&scenario, local), spec), &scenario);
    }
}

/// Claim: an honest message verifies on both layouts, for a legacy (type 0) receipt, and the result holds the exact message
/// fields, the call data, the source block hash and the hash of the transaction at the index of the receipt.
/// Why it matters: the bridge hands the transaction hash to the target as `transactionHash()`, so it must be the hash of
/// the transaction that emitted the log and not of any other transaction of the block.
#[test]
fn honest_message_verifies_on_both_layouts() {
    for (spec, source_slot, anchor_slot, local) in layouts() {
        let scenario = scenario_for(spec, source_slot, anchor_slot, local, 1, 0);
        let verified = verify_message(&scenario.proof, &context(&scenario, local), spec).expect("honest");
        let expected = honest_fields(spec, local, 1);
        assert_eq!(verified.header, expected.header());
        assert_eq!(verified.data, expected.data);
        assert_eq!(verified.source_block_hash, scenario.source_block_hash);
        assert_eq!(verified.source_transaction_hash, keccak256(synthetic_transaction(1)));
        assert_ne!(verified.source_transaction_hash, keccak256(synthetic_transaction(0)), "not the first transaction");
        assert_eq!(verified.source_transaction_hash, scenario.source_transaction_hash);
    }
}

/// Claim: a second message in the same receipt is proven by its own log index, a type 2 receipt works, and the data type
/// of `requireToConfirmMessage` is accepted like the one of `requireToPassMessage`.
#[test]
fn log_index_picks_the_message_and_both_data_types_pass() {
    on_both_layouts(1, 2, |outcome, scenario| {
        let message = outcome.expect("second message");
        assert_eq!(message.header.message_id, message_id_for(remote_chain_id(scenario.spec), BRIDGE, 2));
    });
    on_both_layouts(3, 0, |outcome, scenario| {
        let message = outcome.expect("type 2 receipt");
        assert_eq!(message.source_transaction_hash, keccak256(synthetic_transaction(3)));
        assert_eq!(message.source_block_hash, scenario.source_block_hash);
    });
    on_both_layouts(1, 12, |outcome, _| {
        assert_eq!(outcome.expect("confirm lane").header.data_type, DATA_TYPE_CONFIRM);
    });
}

/// Claim: a log that another contract emitted is refused, even when it is a perfect message (an attacker can emit any log).
/// Control: the same log from the bridge passes. The context with another remote bridge refuses the honest log too.
#[test]
fn wrong_emitter_is_refused() {
    on_both_layouts(1, 3, |outcome, _| assert_eq!(outcome, Err(Error::LogEmitterMismatch)));
    on_both_layouts(1, 1, |outcome, _| assert_eq!(outcome, Err(Error::LogEmitterMismatch), "unrelated contract"));
    for (spec, source_slot, anchor_slot, local) in layouts() {
        let scenario = scenario_for(spec, source_slot, anchor_slot, local, 1, 0);
        assert!(verify_message(&scenario.proof, &context(&scenario, local), spec).is_ok(), "control");
        let other_bridge = MessageContext { remote_bridge: ATTACKER, ..context(&scenario, local) };
        assert_eq!(verify_message(&scenario.proof, &other_bridge, spec), Err(Error::LogEmitterMismatch));
    }
}

/// Claim: a log of the bridge with another topic 0 is refused with `LogTopicMismatch`, and so is a log with no topic.
/// Why it matters: the topic 0 is `keccak256("UserRequestForAffirmation(bytes32,bytes)")` and nothing else.
#[test]
fn wrong_topic_is_refused() {
    on_both_layouts(1, 4, |outcome, _| assert_eq!(outcome, Err(Error::LogTopicMismatch)));
    assert_eq!(
        lc_core::message::message_of_log(
            &Log { topics: vec![], ..message_log(BRIDGE, &honest_fields(&PULSECHAIN, 1, 1)) },
            BRIDGE
        ),
        Err(Error::LogTopicMismatch),
        "no topic at all"
    );
    assert_eq!(
        USER_REQUEST_TOPIC,
        alloy_primitives::b256!("482515ce3d9494a37ce83f18b72b363449458435fafdd7a53ddea7460fe01b58"),
        "the topic of `cast keccak`"
    );
}

/// Claim: exactly two topics are accepted. A log with three topics is refused although topic 0 and the data are right.
#[test]
fn a_log_with_another_topic_count_is_refused() {
    on_both_layouts(1, 11, |outcome, _| assert!(matches!(outcome, Err(Error::LogMalformed(_))), "{outcome:?}"));
    let one_topic = Log { topics: vec![USER_REQUEST_TOPIC], ..message_log(BRIDGE, &honest_fields(&PULSECHAIN, 1, 1)) };
    assert!(matches!(lc_core::message::message_of_log(&one_topic, BRIDGE), Err(Error::LogMalformed(_))));
}

/// Claim: a message from another source chain is refused, and a message for another destination chain is refused.
/// The context with another remote chain or another local chain refuses the honest message the same way.
#[test]
fn wrong_source_chain_and_wrong_destination_chain_are_refused() {
    on_both_layouts(1, 5, |outcome, scenario| {
        let remote = remote_chain_id(scenario.spec);
        assert_eq!(outcome, Err(Error::WrongSourceChain { expected: remote, actual: U256::from(remote + 1) }));
    });
    on_both_layouts(1, 6, |outcome, scenario| {
        let local = if scenario.spec.name == "pulsechain" { 1 } else { 369 };
        assert_eq!(outcome, Err(Error::WrongDestinationChain { expected: local, actual: U256::from(local + 1) }));
    });
    for (spec, source_slot, anchor_slot, local) in layouts() {
        let scenario = scenario_for(spec, source_slot, anchor_slot, local, 1, 0);
        let remote = remote_chain_id(spec);
        let other_remote = MessageContext { remote_chain_id: 31337, ..context(&scenario, local) };
        assert_eq!(
            verify_message(&scenario.proof, &other_remote, spec),
            Err(Error::WrongSourceChain { expected: 31337, actual: U256::from(remote) })
        );
        let other_local = MessageContext { local_chain_id: 31337, ..context(&scenario, local) };
        assert_eq!(
            verify_message(&scenario.proof, &other_local, spec),
            Err(Error::WrongDestinationChain { expected: 31337, actual: U256::from(local) })
        );
    }
}

/// Claim: the source chain is checked before the destination chain, so a message that fails both reports the source.
/// Why it matters: the order is part of the contract that the Solidity bridge and its fixtures share.
#[test]
fn source_chain_is_checked_before_destination_chain() {
    for (spec, source_slot, anchor_slot, local) in layouts() {
        let scenario = scenario_for(spec, source_slot, anchor_slot, local, 1, 0);
        let both_wrong = MessageContext { remote_chain_id: 31337, local_chain_id: 31338, ..context(&scenario, local) };
        assert!(matches!(
            verify_message(&scenario.proof, &both_wrong, spec),
            Err(Error::WrongSourceChain { expected: 31337, .. })
        ));
    }
}

/// Claim: a failed-status receipt is refused even when it holds a perfect message log (the call never took effect).
#[test]
fn failed_receipt_is_refused() {
    on_both_layouts(2, 0, |outcome, _| assert_eq!(outcome, Err(Error::ReceiptFailed)));
}

/// Claim: the log index is bounded. An index past the last log, and an index that does not fit in 64 bits, are refused.
#[test]
fn log_index_out_of_range_is_refused() {
    on_both_layouts(1, 13, |outcome, _| assert_eq!(outcome, Err(Error::LogIndexOutOfRange { index: 13, logs: 13 })));
    for (spec, source_slot, anchor_slot, local) in layouts() {
        let scenario = scenario_for(spec, source_slot, anchor_slot, local, 1, 0);
        let mut proof = scenario.proof.clone();
        proof.logIndex = U256::MAX;
        assert_eq!(
            verify_message(&proof, &context(&scenario, local), spec),
            Err(Error::LogIndexOutOfRange { index: u64::MAX, logs: 13 })
        );
    }
}

/// Claim: the receipt index and the transaction index must be equal. Both proofs are honest for their own index (1 and 0),
/// so only the equality rule refuses the pair. The rule runs first, before the anchor is read.
/// Why it matters: without it, a receipt of one transaction could pair with the hash of another transaction.
#[test]
fn index_mismatch_is_refused() {
    for (spec, source_slot, anchor_slot, local) in layouts() {
        let scenario = scenario_for(spec, source_slot, anchor_slot, local, 1, 0);
        let other = scenario_for(spec, source_slot, anchor_slot, local, 0, 0);
        let mut proof = scenario.proof.clone();
        proof.transactionProof = other.proof.transactionProof.clone();
        proof.transactionIndex = U256::ZERO;
        let expected = Err(Error::IndexMismatch { receipt_index: U256::from(1u64), transaction_index: U256::ZERO });
        assert_eq!(verify_message(&proof, &context(&scenario, local), spec), expected);

        let unstored = MessageContext { stored_anchor_root: B256::ZERO, ..context(&scenario, local) };
        assert_eq!(verify_message(&proof, &unstored, spec), expected, "the equality rule runs before the anchor check");
    }
}

/// Claim: receipt branch tampering is refused: a damaged node, the proof of another receipt, an index that names another
/// transaction, and an index that does not fit in 64 bits.
#[test]
fn tampered_receipt_branch_is_refused() {
    for (spec, source_slot, anchor_slot, local) in layouts() {
        let scenario = scenario_for(spec, source_slot, anchor_slot, local, 1, 0);
        let ctx = context(&scenario, local);
        let mut proof = scenario.proof.clone();
        let last = proof.receiptProof.len() - 1;
        let mut node = proof.receiptProof[last].to_vec();
        let middle = node.len() / 2;
        node[middle] ^= 1;
        proof.receiptProof[last] = node.into();
        assert!(matches!(verify_message(&proof, &ctx, spec), Err(Error::ReceiptProofInvalid(_))));

        let other = scenario_for(spec, source_slot, anchor_slot, local, 0, 0);
        let mut proof = scenario.proof.clone();
        proof.receiptProof = other.proof.receiptProof.clone();
        assert!(
            matches!(verify_message(&proof, &ctx, spec), Err(Error::ReceiptProofInvalid(_))),
            "proof of receipt 0 for index 1"
        );

        let mut proof = scenario.proof.clone();
        proof.receiptIndex = U256::from(2u64);
        proof.transactionIndex = U256::from(2u64);
        assert!(matches!(verify_message(&proof, &ctx, spec), Err(Error::ReceiptProofInvalid(_))), "wrong index");
        proof.receiptIndex = U256::MAX;
        proof.transactionIndex = U256::MAX;
        assert!(
            matches!(verify_message(&proof, &ctx, spec), Err(Error::ReceiptProofInvalid(_))),
            "index does not fit in 64 bits"
        );
    }
}

/// Claim: transaction branch tampering is refused: a damaged node, the proof of another transaction, a missing node and an
/// extra node. The receipt branch is honest in each case, so only the transaction rules refuse the proof.
/// Why it matters: the transaction hash comes from this branch. A forged branch would let a message report any hash.
#[test]
fn tampered_transaction_branch_is_refused() {
    for (spec, source_slot, anchor_slot, local) in layouts() {
        let scenario = scenario_for(spec, source_slot, anchor_slot, local, 1, 0);
        let ctx = context(&scenario, local);
        assert!(verify_message(&scenario.proof, &ctx, spec).is_ok(), "control");

        let mut proof = scenario.proof.clone();
        let last = proof.transactionProof.len() - 1;
        let mut node = proof.transactionProof[last].to_vec();
        let middle = node.len() / 2;
        node[middle] ^= 1;
        proof.transactionProof[last] = node.into();
        assert!(matches!(verify_message(&proof, &ctx, spec), Err(Error::TransactionProofInvalid(_))), "damaged node");

        let other = scenario_for(spec, source_slot, anchor_slot, local, 0, 0);
        let mut proof = scenario.proof.clone();
        proof.transactionProof = other.proof.transactionProof.clone();
        assert!(
            matches!(verify_message(&proof, &ctx, spec), Err(Error::TransactionProofInvalid(_))),
            "proof of transaction 0 for index 1"
        );

        let mut proof = scenario.proof.clone();
        proof.transactionProof.pop();
        assert!(matches!(verify_message(&proof, &ctx, spec), Err(Error::TransactionProofInvalid(_))), "missing node");
        let mut proof = scenario.proof.clone();
        proof.transactionProof.push(Bytes::from_static(&[0xc0]));
        assert!(matches!(verify_message(&proof, &ctx, spec), Err(Error::TransactionProofInvalid(_))), "extra node");
        let mut proof = scenario.proof.clone();
        proof.transactionProof.clear();
        assert!(matches!(verify_message(&proof, &ctx, spec), Err(Error::TransactionProofInvalid(_))), "empty proof");
    }
}

/// Claim: the receipt branch is checked before the transaction branch, and the transaction branch before the receipt
/// status. A failed receipt with a damaged transaction branch reports the branch.
/// Why it matters: the order is part of the contract that the Solidity bridge and its fixtures share.
#[test]
fn transaction_branch_is_checked_before_the_receipt_status() {
    for (spec, source_slot, anchor_slot, local) in layouts() {
        let scenario = scenario_for(spec, source_slot, anchor_slot, local, 2, 0);
        let ctx = context(&scenario, local);
        assert_eq!(verify_message(&scenario.proof, &ctx, spec), Err(Error::ReceiptFailed), "control");
        let mut proof = scenario.proof.clone();
        proof.transactionProof.clear();
        assert!(matches!(verify_message(&proof, &ctx, spec), Err(Error::TransactionProofInvalid(_))));
    }
}

/// Claim: event data that is not `abi.encode(bytes)` is refused. The log in the test holds 40 zero bytes. Variants of the
/// honest data (another offset, a short length word, trailing words) are covered in the unit tests of `lc_core::message`.
#[test]
fn malformed_event_data_is_refused() {
    on_both_layouts(1, 7, |outcome, _| assert_eq!(outcome, Err(Error::MalformedEventData)));
    let honest = message_log(BRIDGE, &honest_fields(&PULSECHAIN, 1, 1));
    let mut shifted = honest.data.to_vec();
    shifted.extend_from_slice(&[0u8; 32]);
    let log = Log { data: shifted.into(), ..honest };
    assert_eq!(lc_core::message::message_of_log(&log, BRIDGE), Err(Error::MalformedEventData), "trailing word");
}

/// Claim: a message with another format version in its identifier is refused. The version is the top 4 bytes `0x00050000`.
#[test]
fn bad_version_is_refused() {
    on_both_layouts(1, 8, |outcome, scenario| {
        let mut id = message_id_for(remote_chain_id(scenario.spec), BRIDGE, 8);
        id.0[1] = 0x06;
        assert_eq!(outcome, Err(Error::MessageVersionInvalid { message_id: id }));
    });
}

/// Claim: a data type other than `0x00` and `0x80` is refused.
#[test]
fn bad_data_type_is_refused() {
    on_both_layouts(1, 9, |outcome, _| assert_eq!(outcome, Err(Error::UnknownDataType { data_type: 0x40 })));
}

/// Claim: the identifier in the topic and the one in the message are the same value. A log whose topic holds another
/// identifier is refused.
#[test]
fn identifier_in_topic_must_equal_identifier_in_message() {
    on_both_layouts(1, 10, |outcome, scenario| {
        assert_eq!(
            outcome,
            Err(Error::MessageIdMismatch {
                topic_message_id: B256::repeat_byte(0x55),
                encoded_message_id: message_id_for(remote_chain_id(scenario.spec), BRIDGE, 10),
            })
        );
    });
}

/// Claim: a message that is shorter than its header says is refused with `MalformedMessage`, and a raw log carries any
/// bytes that the builder gives it (the control for the malformed cases above).
#[test]
fn malformed_message_is_refused() {
    let spec = &PULSECHAIN;
    let honest = encode_message(&honest_fields(spec, 1, 1).header(), &[1, 2, 3]);
    let log = raw_message_log(BRIDGE, honest_fields(spec, 1, 1).message_id, &honest[..60]);
    let receipts = vec![ReceiptSpec { transaction_type: 2, success: true, logs: vec![log] }];
    let scenario = build_message(spec, &receipts, 0, 0, 10_872_000, 10_872_500);
    assert_eq!(verify_message(&scenario.proof, &context(&scenario, 1), spec), Err(Error::MalformedMessage));
    let control = vec![ReceiptSpec {
        transaction_type: 2,
        success: true,
        logs: vec![raw_message_log(BRIDGE, honest_fields(spec, 1, 1).message_id, &honest)],
    }];
    let scenario = build_message(spec, &control, 0, 0, 10_872_000, 10_872_500);
    assert!(verify_message(&scenario.proof, &context(&scenario, 1), spec).is_ok(), "control");
}

/// Claim: the struct survives ABI encoding as calldata of `executeMessage(MessageProof)`, the selector is the one that
/// `cast sig` computes, and the decoded calldata verifies the same way.
#[test]
fn calldata_roundtrip_and_selector() {
    assert_eq!(
        executeMessageCall::SELECTOR,
        [0x63, 0xf0, 0x8d, 0x5e],
        "selector from `cast sig` of the full signature"
    );
    for (spec, source_slot, anchor_slot, local) in layouts() {
        let scenario = scenario_for(spec, source_slot, anchor_slot, local, 1, 2);
        let calldata = executeMessageCall { proof: scenario.proof.clone() }.abi_encode();
        assert_eq!(&calldata[..4], &executeMessageCall::SELECTOR);
        let decoded: MessageProof = executeMessageCall::abi_decode(&calldata).expect("decode").proof;
        assert_eq!(decoded, scenario.proof);
        assert!(verify_message(&decoded, &context(&scenario, local), spec).is_ok());
    }
}

/// Claim: the path follows the distance, and the edge is exact. A source block 8192 slots before the anchor takes the recent
/// path, 8193 takes the historical path, and both verify. The anchor slot itself and a later slot fail.
/// Why it matters: the bridge picks the path, never the prover, so the edge must sit on one side only.
#[test]
fn synthetic_path_follows_the_distance_at_the_edge() {
    use lc_core::ancestry::{ancestry_path_for_slots, AncestryPath};
    for (spec, _, _, local) in layouts() {
        let anchor_slot = if spec.name == "pulsechain" { 10_900_000 } else { 15_500_000 };
        let recent = scenario_for(spec, anchor_slot - 8192, anchor_slot, local, 1, 0);
        assert_eq!(ancestry_path_for_slots(anchor_slot, anchor_slot - 8192), Ok(AncestryPath::Recent));
        assert!(verify_message(&recent.proof, &context(&recent, local), spec).is_ok(), "exactly 8192 slots back");
        let historical = scenario_for(spec, anchor_slot - 8193, anchor_slot, local, 1, 0);
        assert_eq!(ancestry_path_for_slots(anchor_slot, anchor_slot - 8193), Ok(AncestryPath::Historical));
        assert!(verify_message(&historical.proof, &context(&historical, local), spec).is_ok(), "8193 slots back");
        // The two honest branches differ in length: 18 or 19 on the recent path, 44 or 45 on the historical path.
        let (recent_length, historical_length) = if spec.name == "pulsechain" { (18, 44) } else { (19, 45) };
        assert_eq!(recent.proof.ancestryBranch.len(), recent_length);
        assert_eq!(historical.proof.ancestryBranch.len(), historical_length);
        for source_slot in [anchor_slot, anchor_slot + 1] {
            let scenario = scenario_for(spec, source_slot, anchor_slot, local, 1, 0);
            assert_eq!(
                verify_message(&scenario.proof, &context(&scenario, local), spec),
                Err(Error::DepositNotBeforeAnchor { anchor_slot, source_slot }),
                "source block slot {source_slot}"
            );
        }
    }
}

/// Claim: at an era edge each side uses its own list position. The last slot of era E uses index E - capellaEra, the first
/// slot of era E + 1 uses the next index, both verify, and swapping the two branches fails.
/// Why it matters: the synthetic anchor state holds each source header root in the neighbouring eras too, so the swap is a
/// valid Merkle path and only an off-by-one in the index would let it through.
#[test]
fn synthetic_historical_era_edges_use_their_own_index() {
    for (spec, _, _, local) in layouts() {
        let anchor_slot = if spec.name == "pulsechain" { 10_900_000 } else { 15_500_000 };
        let era = anchor_slot / 8192 - 4;
        let last = scenario_for(spec, (era + 1) * 8192 - 1, anchor_slot, local, 1, 0);
        let first = scenario_for(spec, (era + 1) * 8192, anchor_slot, local, 1, 0);
        for scenario in [&last, &first] {
            assert!(verify_message(&scenario.proof, &context(scenario, local), spec).is_ok(), "control");
        }
        let capella_era = spec.capella_era().unwrap();
        let last_index = (era - capella_era) as usize;
        assert!(
            last.anchor_state.has_historical_era(last_index) && last.anchor_state.has_historical_era(last_index + 1)
        );
        let wrong_for_last = last.historical_ancestry_branch_for_era(era + 1).expect("neighbour exists");
        let mut swapped = last.proof.clone();
        swapped.ancestryBranch = wrong_for_last;
        assert_eq!(verify_message(&swapped, &context(&last, local), spec), Err(Error::InvalidAncestryBranch));
        let wrong_for_first = first.historical_ancestry_branch_for_era(era).expect("neighbour exists");
        let mut swapped = first.proof.clone();
        swapped.ancestryBranch = wrong_for_first;
        assert_eq!(verify_message(&swapped, &context(&first, local), spec), Err(Error::InvalidAncestryBranch));
    }
}

/// Claim: the historical branch has an exact length. Padding, a missing entry and an extra entry are refused, and so is
/// every single flipped entry (44 or 45 positions), with the honest proof as control.
#[test]
fn synthetic_historical_branch_length_and_entries_are_exact() {
    for (spec, _, _, local) in layouts() {
        let anchor_slot = if spec.name == "pulsechain" { 10_900_000 } else { 15_500_000 };
        let scenario = scenario_for(spec, anchor_slot - 20_000, anchor_slot, local, 1, 0);
        let ctx = context(&scenario, local);
        assert!(verify_message(&scenario.proof, &ctx, spec).is_ok(), "control");
        let mut proof = scenario.proof.clone();
        proof.ancestryBranch.insert(0, B256::ZERO);
        assert_eq!(verify_message(&proof, &ctx, spec), Err(Error::InvalidAncestryBranch), "padded at the front");
        let mut proof = scenario.proof.clone();
        proof.ancestryBranch.push(B256::ZERO);
        assert_eq!(verify_message(&proof, &ctx, spec), Err(Error::InvalidAncestryBranch), "padded at the back");
        let mut proof = scenario.proof.clone();
        proof.ancestryBranch.pop();
        assert_eq!(verify_message(&proof, &ctx, spec), Err(Error::InvalidAncestryBranch), "short");
        for position in 0..scenario.proof.ancestryBranch.len() {
            let mut proof = scenario.proof.clone();
            proof.ancestryBranch[position].0[5] ^= 1;
            assert_eq!(verify_message(&proof, &ctx, spec), Err(Error::InvalidAncestryBranch), "entry {position}");
        }
    }
}

/// Claim: a branch built for the other path is refused in both directions. The anchor state holds the source header root at
/// both places, so each branch is a valid path of the state. Historical distance with the block_roots branch fails, and
/// recent distance with the historical branch fails.
#[test]
fn synthetic_path_mixups_are_refused_in_both_directions() {
    for (spec, _, _, local) in layouts() {
        let anchor_slot = if spec.name == "pulsechain" { 10_900_000 } else { 15_500_000 };
        let far = scenario_for(spec, anchor_slot - 20_000, anchor_slot, local, 1, 0);
        let mut proof = far.proof.clone();
        proof.ancestryBranch = far.recent_ancestry_branch();
        assert_eq!(verify_message(&proof, &context(&far, local), spec), Err(Error::InvalidAncestryBranch));
        // Control: the recent branch is a real path of that state, it proves the same header root at the block_roots index.
        let state_root = far.proof.anchorHeader.stateRoot;
        let source: lc_core::types::BeaconBlockHeader = (&far.proof.sourceHeader).into();
        let layout = lc_core::layout::state_layout_for_fork(spec.fork_at_slot(anchor_slot)).unwrap();
        let recent_gindex = lc_core::ancestry::block_roots_leaf_gindex(layout.block_roots_gindex, source.slot).unwrap();
        assert!(lc_core::ssz::is_valid_exact_branch(
            &source.hash_tree_root(),
            &proof.ancestryBranch,
            recent_gindex,
            &state_root
        ));

        let near_slot = (anchor_slot / 8192) * 8192 - 300;
        let near = scenario_for(spec, near_slot, anchor_slot, local, 1, 0);
        assert!(verify_message(&near.proof, &context(&near, local), spec).is_ok(), "control");
        let mut proof = near.proof.clone();
        proof.ancestryBranch = near.historical_ancestry_branch().expect("source block era is complete");
        assert_eq!(verify_message(&proof, &context(&near, local), spec), Err(Error::InvalidAncestryBranch));
    }
}

/// Claim: the era formula uses the chain's `capellaEra`. The first era of the chain (list position 0) verifies, and on
/// Ethereum the era before it is refused with `DepositBeforeCapella`, never with a branch error.
/// Why it matters: an off-by-one here makes a whole era unreachable or wrongly reachable.
#[test]
fn synthetic_historical_first_capella_era_and_the_era_before() {
    for (spec, _, _, local) in layouts() {
        let anchor_slot = if spec.name == "pulsechain" { 10_900_000 } else { 15_500_000 };
        let capella_era = spec.capella_era().unwrap();
        let first_slot = spec.capella_fork_slot().unwrap().max(capella_era * 8192);
        let first = scenario_for(spec, first_slot, anchor_slot, local, 1, 0);
        assert!(first.anchor_state.has_historical_era(0));
        assert!(verify_message(&first.proof, &context(&first, local), spec).is_ok(), "list position 0");
        assert_eq!(first.proof.ancestryBranch.len(), if spec.name == "pulsechain" { 44 } else { 45 });
        if capella_era == 0 {
            continue;
        }
        let mut before = first.proof.clone();
        before.sourceHeader.slot = capella_era * 8192 - 1;
        assert_eq!(
            verify_message(&before, &context(&first, local), spec),
            Err(Error::DepositBeforeCapella { source_era: capella_era - 1, capella_era })
        );
    }
}

/// Claim: every entry of both branches matters, a wrong slot fails, an anchor that the light client does not store fails,
/// a branch with padding fails (exact length), and a swapped header fails.
#[test]
fn synthetic_beacon_path_tampering() {
    for (spec, source_slot, anchor_slot, local) in layouts() {
        let scenario = scenario_for(spec, source_slot, anchor_slot, local, 1, 0);
        let ctx = context(&scenario, local);
        assert!(verify_message(&scenario.proof, &ctx, spec).is_ok(), "control");

        for position in 0..scenario.proof.ancestryBranch.len() {
            let mut proof = scenario.proof.clone();
            proof.ancestryBranch[position].0[5] ^= 1;
            assert_eq!(verify_message(&proof, &ctx, spec), Err(Error::InvalidAncestryBranch), "ancestry {position}");
        }
        for position in 0..scenario.proof.blockHashBranch.len() {
            let mut proof = scenario.proof.clone();
            proof.blockHashBranch[position].0[5] ^= 1;
            assert_eq!(verify_message(&proof, &ctx, spec), Err(Error::InvalidBlockHashBranch), "hash {position}");
        }
        let mut proof = scenario.proof.clone();
        proof.sourceHeader.slot += 1;
        assert_eq!(verify_message(&proof, &ctx, spec), Err(Error::InvalidAncestryBranch), "wrong slot");

        let mut proof = scenario.proof.clone();
        proof.ancestryBranch.insert(0, B256::ZERO);
        assert_eq!(verify_message(&proof, &ctx, spec), Err(Error::InvalidAncestryBranch), "padded branch");
        let mut proof = scenario.proof.clone();
        proof.blockHashBranch.pop();
        assert_eq!(verify_message(&proof, &ctx, spec), Err(Error::InvalidBlockHashBranch), "short branch");

        for stored in [B256::ZERO, B256::repeat_byte(3)] {
            let unknown = MessageContext { stored_anchor_root: stored, ..ctx };
            assert_eq!(verify_message(&scenario.proof, &unknown, spec), Err(Error::AnchorNotStored));
        }
        let mut proof = scenario.proof.clone();
        proof.anchorHeader.proposerIndex += 1;
        assert_eq!(verify_message(&proof, &ctx, spec), Err(Error::AnchorNotStored), "changed anchor header");

        let mut proof = scenario.proof.clone();
        let mut rlp = proof.executionHeaderRlp.to_vec();
        rlp[40] ^= 1;
        proof.executionHeaderRlp = rlp.into();
        assert_eq!(
            verify_message(&proof, &ctx, spec),
            Err(Error::InvalidBlockHashBranch),
            "header RLP no longer hashes to the proven block hash"
        );
    }
}
