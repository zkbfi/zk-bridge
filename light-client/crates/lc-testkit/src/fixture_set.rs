//! The shared fixtures for the Rust and Solidity message tests: `gindices.json` and `message/*.json`.
//!
//! The format is documented in `tests/fixtures/README.md`. `write-message-fixtures` writes the files. A Rust test
//! regenerates them in memory and compares with the files on disk, so a stale file fails the test. While it builds each
//! case it runs `verify_message` and asserts that the outcome equals the outcome the file declares.

use crate::json::{hex_b256, hex_bytes};
use crate::lc_message::abi::{executeMessageCall, MessageProof};
use crate::lc_message::message::{reason_code, verify_message};
use crate::message_blocks::{remote_chain_id, standard_receipts, ATTACKER, BRIDGE};
use crate::synthetic::{build_message, MessageScenario};
use alloy_primitives::{hex, Address, B256, U256};
use alloy_sol_types::SolCall;
use lc_core::ancestry::{ancestry_path_for_slots, historical_leaf_gindex, AncestryPath};
use lc_core::chain::{ChainSpec, ForkName, ETHEREUM_MAINNET, FAR_FUTURE_EPOCH, PULSECHAIN, SEPOLIA};
use lc_core::layout::{
    block_hash_gindex_for_fork, state_layout_for_finality_branch_length, state_layout_for_fork,
    ALLOWED_FINALITY_BRANCH_LENGTHS, BLOCK_ROOTS_VECTOR_DEPTH, EXECUTION_PAYLOAD_GINDEX, GLOAS_STATE_LAYOUT,
    HISTORICAL_SUMMARIES_LIST_DEPTH, SLOTS_PER_HISTORICAL_ROOT,
};
use lc_core::message::{MessageContext, VerifiedMessage};
use lc_core::ssz::gindex_depth;
use serde_json::{json, Value};

fn text(value: impl core::fmt::LowerHex) -> String {
    format!("{value:#x}")
}

/// The fork schedule rows the bridge takes as a constructor argument, for one source chain.
/// Row: `(activationEpoch, blockRootsGindexBase, blockHashGindex, historicalSummariesGindex)`.
/// `historicalSummariesGindex` is the generalized index of the `historical_summaries` field in the `BeaconState` of the
/// fork (the anchor's layout). Forks without a supported layout are left out.
fn schedule_rows(spec: &ChainSpec) -> Vec<Value> {
    spec.fork_schedule
        .iter()
        .filter(|entry| entry.epoch != FAR_FUTURE_EPOCH)
        .filter_map(|entry| {
            let layout = state_layout_for_fork(entry.fork_name).ok()?;
            // A Gloas row has no body layout position: its block hash index is the fixed rule of a message source (index
            // 2856), so the row names 0 and the harness seeds no body layout for it.
            let block_hash_gindex = match entry.fork_name >= ForkName::Gloas {
                true => 0,
                false => block_hash_gindex_for_fork(entry.fork_name).ok()?,
            };
            Some(json!({
                "activationEpoch": entry.epoch.to_string(),
                "fork": format!("{:?}", entry.fork_name).to_lowercase(),
                "blockRootsGindexBase": (layout.block_roots_gindex << BLOCK_ROOTS_VECTOR_DEPTH).to_string(),
                "blockHashGindex": block_hash_gindex.to_string(),
                "historicalSummariesGindex": layout.historical_summaries_gindex.to_string(),
            }))
        })
        .collect()
}

/// The Gloas positions, derived from the field lists of `lc_core::layout` (not copied from its constants), and checked
/// against the constants. The state is a progressive container, so these are fixed numbers and not `2^depth + index`.
fn gloas_json() -> Value {
    use lc_core::layout::{
        path_gindex, BEACON_STATE_GLOAS, BLOCK_ROOTS_GINDEX_GLOAS, FORK, FORK_VERSION_GINDEX_GLOAS,
        HISTORICAL_SUMMARIES_GINDEX_GLOAS, LATEST_BLOCK_HASH_GINDEX_GLOAS,
    };
    let state = &BEACON_STATE_GLOAS;
    let derived = |path: &[(&lc_core::layout::ContainerDefinition, &str)]| path_gindex(path).expect("a known field");
    let block_roots = derived(&[(state, "block_roots")]);
    let summaries = derived(&[(state, "historical_summaries")]);
    let latest = derived(&[(state, "latest_block_hash")]);
    let fork_version = derived(&[(state, "fork"), (&FORK, "current_version")]);
    assert_eq!(block_roots, BLOCK_ROOTS_GINDEX_GLOAS);
    assert_eq!(summaries, HISTORICAL_SUMMARIES_GINDEX_GLOAS);
    assert_eq!(latest, LATEST_BLOCK_HASH_GINDEX_GLOAS);
    assert_eq!(fork_version, FORK_VERSION_GINDEX_GLOAS);
    json!({
        "source": "specs/gloas/beacon-chain.md (BeaconState, 46 fields, ProgressiveContainer) with eip-7495 and eip-7916, and specs/gloas/light-client/sync-protocol.md. Derived by lc_core::layout::path_gindex from the field list.",
        "forkVersionGindex": fork_version,
        "forkVersionBranchLength": gindex_depth(fork_version),
        "blockRootsFieldGindex": block_roots,
        "blockRootsBranchLength": gindex_depth(block_roots << BLOCK_ROOTS_VECTOR_DEPTH),
        "historicalSummariesFieldGindex": summaries,
        "historicalAncestryBranchLength": gindex_depth(
            historical_leaf_gindex(summaries, 0, 0).expect("index 0 is in range")
        ),
        "latestBlockHashGindex": latest,
        "latestBlockHashBranchLength": gindex_depth(latest),
        "note": "latestBlockHashGindex anchors the execution block of a finalized Gloas head. No block hash position of the body is used: the body holds a bid, and a message proof from a Gloas source block is refused.",
    })
}

/// The state layouts that the light-client program accepts, derived from `ALLOWED_FINALITY_BRANCH_LENGTHS`: the plain
/// depths (a finality branch of `depth + 1` entries) and the one progressive length. The Solidity tests compare their
/// allowed shapes with this set.
fn program_json() -> Value {
    let mut plain_depths = Vec::new();
    let mut progressive_lengths = Vec::new();
    for length in ALLOWED_FINALITY_BRANCH_LENGTHS {
        let layout = state_layout_for_finality_branch_length(length).expect("an allowed length names a layout");
        match layout == GLOAS_STATE_LAYOUT {
            true => progressive_lengths.push(length),
            false => {
                let depth = gindex_depth(layout.current_sync_committee_gindex);
                assert_eq!(
                    depth as usize + 1,
                    length,
                    "a plain finality branch has one entry more than the state depth"
                );
                plain_depths.push(depth);
            }
        }
    }
    json!({
        "source": "lc_core::layout::ALLOWED_FINALITY_BRANCH_LENGTHS. The finality branch length names the layout; every other length is refused. Plain depth 7 (length 8) is allowed because the genesis validators root branch proves the shape.",
        "finalityBranchLengths": ALLOWED_FINALITY_BRANCH_LENGTHS,
        "plainStateDepths": plain_depths,
        "progressiveFinalityBranchLengths": progressive_lengths,
    })
}

/// `tests/fixtures/gindices.json`: every generalized index the bridge and the light client need, per fork, with sources.
pub fn gindices_json() -> Value {
    let fork_entry = |fork: ForkName| {
        let layout = state_layout_for_fork(fork).expect("supported fork");
        let block_hash = block_hash_gindex_for_fork(fork).expect("supported fork");
        let base = layout.block_roots_gindex << BLOCK_ROOTS_VECTOR_DEPTH;
        json!({
            "finalizedRootGindex": layout.finalized_root_gindex.to_string(),
            "finalityBranchLength": gindex_depth(layout.finalized_root_gindex),
            "currentSyncCommitteeGindex": layout.current_sync_committee_gindex.to_string(),
            "nextSyncCommitteeGindex": layout.next_sync_committee_gindex.to_string(),
            "syncCommitteeBranchLength": gindex_depth(layout.next_sync_committee_gindex),
            "blockRootsFieldGindex": layout.block_roots_gindex.to_string(),
            "blockRootsGindexBase": base.to_string(),
            "blockRootsBranchLength": gindex_depth(base),
            "historicalSummariesFieldGindex": layout.historical_summaries_gindex.to_string(),
            "historicalAncestryBranchLength": gindex_depth(
                historical_leaf_gindex(layout.historical_summaries_gindex, 0, 0).expect("index 0 is in range")
            ),
            "executionPayloadGindex": EXECUTION_PAYLOAD_GINDEX.to_string(),
            "executionBranchLength": gindex_depth(EXECUTION_PAYLOAD_GINDEX),
            "blockHashGindex": block_hash.to_string(),
            "blockHashBranchLength": gindex_depth(block_hash),
        })
    };
    json!({
        "source": "ethereum/consensus-specs master, fetched 2026-10-20. BeaconState.block_roots: specs/phase0/beacon-chain.md (field 5). BeaconState sync committee and finality indices: specs/altair/light-client/sync-protocol.md and specs/electra/light-client/sync-protocol.md. execution_payload: specs/capella/light-client/sync-protocol.md (25). ExecutionPayload field lists: specs/capella/beacon-chain.md (15 fields) and specs/deneb/beacon-chain.md (17 fields, unchanged in Electra and Fulu). BeaconState.historical_summaries: container BeaconState in specs/capella/beacon-chain.md (28 fields, historical_summaries is field 27, new in Capella; HistoricalSummary and HistoricalSummaries.LIMIT = HISTORICAL_ROOTS_LIMIT = 2^24 in the same file); specs/deneb, specs/electra and specs/fulu beacon-chain.md only append fields after it (Electra 37, Fulu 38), so it stays field 27. process_historical_summaries_update (specs/capella/beacon-chain.md) appends one summary per era.",
        "generatedBy": "cargo run -p lc-testkit --bin write-message-fixtures",
        "notes": [
            "blockRootsGindexBase = blockRootsFieldGindex * 8192. The generalized index of block_roots[slot % 8192] is blockRootsGindexBase + (slot % 8192).",
            "blockHashGindex is the combined index of BeaconBlockBody.execution_payload.block_hash: executionPayloadGindex * 2^payloadDepth + 12. block_hash is field 12 of ExecutionPayload.",
            "The bridge picks the block roots row by the epoch of the ANCHOR header slot and the block hash row by the epoch of the SOURCE header slot.",
            "A branch has exactly floorlog2(gindex) entries. A branch with padding is refused.",
            "The bridge picks the ancestry path from the slots: recent when 0 < anchorSlot - sourceSlot <= 8192 (leaf block_roots[sourceSlot % 8192]), historical when the distance is above 8192.",
            "Historical generalized index, in this order: g = historicalSummariesFieldGindex; g = g * 2 (list data root); g = g * 2^24 + index (HISTORICAL_ROOTS_LIMIT = 2^24); g = g * 2 + 0 (block_summary_root); g = g * 2^13 + sourceSlot % 8192. index = sourceSlot / 8192 - capellaEra, and the source era must be at least capellaEra.",
            "historicalAncestryBranchLength is the exact length of the historical ancestry branch: 44 in the Capella and Deneb layouts, 45 in the Electra and Fulu layouts.",
            "capellaEra = floor(capellaForkSlot / 8192): Ethereum 758 (Capella slot 6209536), PulseChain 0 (Capella epoch 3, slot 96). It is an immutable bridge argument."
        ],
        "historicalRootsLimit": (1u64 << HISTORICAL_SUMMARIES_LIST_DEPTH).to_string(),
        "historicalSummariesListDepth": HISTORICAL_SUMMARIES_LIST_DEPTH,
        "slotsPerHistoricalRoot": SLOTS_PER_HISTORICAL_ROOT.to_string(),
        "gloas": gloas_json(),
        "program": program_json(),
        "forks": {
            "capella": fork_entry(ForkName::Capella),
            "deneb": fork_entry(ForkName::Deneb),
            "electra": fork_entry(ForkName::Electra),
            "fulu": fork_entry(ForkName::Fulu),
        },
        "chains": {
            "ethereum": {
                "chainId": "1",
                "capellaEra": ETHEREUM_MAINNET.capella_era().expect("Capella").to_string(),
                "forkSchedule": schedule_rows(&ETHEREUM_MAINNET),
            },
            "pulsechain": {
                "chainId": "369",
                "capellaEra": PULSECHAIN.capella_era().expect("Capella").to_string(),
                "forkSchedule": schedule_rows(&PULSECHAIN),
            },
        },
    })
}

/// The outcome a case declares.
enum Expected {
    Accept,
    Reject(&'static str),
}

struct Case {
    name: String,
    description: String,
    spec: &'static ChainSpec,
    proof: MessageProof,
    stored_anchor_root: B256,
    remote_bridge: Address,
    local_chain_id: u64,
    remote_chain_id: u64,
    expected: Expected,
}

fn message_json(message: &VerifiedMessage) -> Value {
    json!({
        "messageId": text(message.header.message_id),
        "sender": text(message.header.sender),
        "executor": text(message.header.executor),
        "gasLimit": message.header.gas_limit.to_string(),
        "dataType": message.header.data_type.to_string(),
        "sourceChainId": message.header.source_chain_id.to_string(),
        "destinationChainId": message.header.destination_chain_id.to_string(),
        "data": format!("0x{}", hex::encode(&message.data)),
        "sourceBlockHash": text(message.source_block_hash),
        "sourceTransactionHash": text(message.source_transaction_hash),
    })
}

fn render(case: Case) -> (String, Value) {
    let context = MessageContext {
        remote_bridge: case.remote_bridge,
        local_chain_id: case.local_chain_id,
        remote_chain_id: case.remote_chain_id,
        stored_anchor_root: case.stored_anchor_root,
    };
    let outcome = verify_message(&case.proof, &context, case.spec);
    let expected = match (&case.expected, &outcome) {
        (Expected::Accept, Ok(message)) => json!({ "result": "accept", "message": message_json(message) }),
        (Expected::Reject(reason), Err(error)) if reason_code(error) == *reason => {
            json!({ "result": "reject", "reason": reason })
        }
        (_, other) => panic!("case {} did not give the declared outcome: {other:?}", case.name),
    };
    let calldata = executeMessageCall { proof: case.proof.clone() }.abi_encode();
    let layout = match case.spec.name {
        "pulsechain" => "capella",
        "sepolia" => "gloas",
        _ => "electra",
    };
    let ancestry_path = match ancestry_path_for_slots(case.proof.anchorHeader.slot, case.proof.sourceHeader.slot) {
        Ok(AncestryPath::Recent) => "recent",
        Ok(AncestryPath::Historical) => "historical",
        Err(_) => "none",
    };
    let value = json!({
        "name": case.name,
        "description": case.description,
        "beaconData": "synthetic",
        "receiptData": "synthetic",
        "chain": case.spec.name,
        "layout": layout,
        "calldata": format!("0x{}", hex::encode(calldata)),
        "anchorSlot": case.proof.anchorHeader.slot.to_string(),
        "ancestryPath": ancestry_path,
        "capellaEra": case.spec.capella_era().expect("Capella").to_string(),
        "storedAnchorHeaderRoot": text(case.stored_anchor_root),
        "remoteBridge": text(case.remote_bridge),
        "localChainId": case.local_chain_id.to_string(),
        "remoteChainId": case.remote_chain_id.to_string(),
        "genesisValidatorsRoot": text(case.spec.genesis_validators_root),
        "sourceForkSchedule": schedule_rows(case.spec),
        "expected": expected,
    });
    (case.name, value)
}

fn flip_node(node: &mut B256) {
    node.0[5] ^= 1;
}

/// Flips one byte in the middle of the last node of a trie proof.
fn damage_last_node(proof: &mut [alloy_primitives::Bytes]) {
    let last = proof.len() - 1;
    let mut node = proof[last].to_vec();
    let middle = node.len() / 2;
    node[middle] ^= 1;
    proof[last] = node.into();
}

/// Builds the cases of one source chain. `window_anchor` is the anchor of the window and historical cases.
fn synthetic_cases(spec: &'static ChainSpec, prefix: &str, local_chain_id: u64, window_anchor: u64) -> Vec<Case> {
    let (source_slot, anchor_slot) =
        if spec.name == "pulsechain" { (10_872_000, 10_872_500) } else { (15_476_000, 15_476_500) };
    let receipts = standard_receipts(spec, local_chain_id);
    let remote = remote_chain_id(spec);
    let case_at = |name: &str, description: &str, scenario: MessageScenario, expected: Expected| Case {
        name: format!("{prefix}_{name}"),
        description: description.to_string(),
        spec,
        proof: scenario.proof,
        stored_anchor_root: scenario.stored_anchor_root,
        remote_bridge: BRIDGE,
        local_chain_id,
        remote_chain_id: remote,
        expected,
    };
    let base = |name: &str, description: &str, tx: u64, log: u64, expected: Expected| {
        let scenario = build_message(spec, &receipts, tx, log, source_slot, anchor_slot);
        case_at(name, description, scenario, expected)
    };
    let mut cases = vec![
        base("accept_legacy_receipt_first_message", "Type 0 receipt, message at log 0.", 1, 0, Expected::Accept),
        base(
            "accept_second_message_in_same_receipt",
            "Type 0 receipt with two messages; the proof names log 2.",
            1,
            2,
            Expected::Accept,
        ),
        base("accept_dynamic_fee_receipt", "Type 2 receipt, message at log 0.", 3, 0, Expected::Accept),
        base(
            "accept_confirm_data_type",
            "The message has the data type 0x80 of requireToConfirmMessage; the bridge accepts both data types.",
            1,
            12,
            Expected::Accept,
        ),
        base(
            "reject_failed_status_receipt",
            "The receipt has failed status and a perfect message log.",
            2,
            0,
            Expected::Reject("ReceiptFailed"),
        ),
        base(
            "reject_log_from_another_emitter",
            "A message-shaped log emitted by an attacker contract.",
            1,
            3,
            Expected::Reject("LogEmitterMismatch"),
        ),
        base(
            "reject_wrong_topic",
            "A log from the bridge with another topic 0 than UserRequestForAffirmation.",
            1,
            4,
            Expected::Reject("LogTopicMismatch"),
        ),
        base(
            "reject_wrong_topic_count",
            "A message log with three topics instead of two.",
            1,
            11,
            Expected::Reject("LogMalformed"),
        ),
        base(
            "reject_log_index_out_of_range",
            "Log index 13 in a receipt with 13 logs.",
            1,
            13,
            Expected::Reject("LogIndexOutOfRange"),
        ),
        base(
            "reject_unrelated_log_index",
            "Log 1 is an unrelated log from another contract.",
            1,
            1,
            Expected::Reject("LogEmitterMismatch"),
        ),
        base(
            "reject_wrong_source_chain",
            "The message names another source chain than the remote chain.",
            1,
            5,
            Expected::Reject("WrongSourceChain"),
        ),
        base(
            "reject_wrong_destination_chain",
            "The message names another destination chain than the chain of the verifying bridge.",
            1,
            6,
            Expected::Reject("WrongDestinationChain"),
        ),
        base(
            "reject_malformed_event_data",
            "The log event data is 40 zero bytes, not the encoding of one bytes value.",
            1,
            7,
            Expected::Reject("MalformedEventData"),
        ),
        base(
            "reject_bad_version",
            "The message identifier has the format version 0x00060000 instead of 0x00050000.",
            1,
            8,
            Expected::Reject("MessageVersionInvalid"),
        ),
        base(
            "reject_bad_data_type",
            "The message has the data type 0x40, which no bridge sends.",
            1,
            9,
            Expected::Reject("UnknownDataType"),
        ),
        base(
            "reject_message_id_mismatch",
            "The identifier in the topic differs from the identifier in the message.",
            1,
            10,
            Expected::Reject("MessageIdMismatch"),
        ),
    ];

    let mut other_local = base(
        "reject_context_with_another_local_chain",
        "The verifying bridge sits on another chain than the message names as its destination.",
        1,
        0,
        Expected::Reject("WrongDestinationChain"),
    );
    other_local.local_chain_id = 31337;
    cases.push(other_local);
    let mut other_remote = base(
        "reject_context_with_another_remote_chain",
        "The verifying bridge has another remote chain than the message names as its source.",
        1,
        0,
        Expected::Reject("WrongSourceChain"),
    );
    other_remote.remote_chain_id = 31337;
    cases.push(other_remote);
    let mut other_bridge = base(
        "reject_context_with_another_remote_bridge",
        "The verifying bridge has another remote bridge than the emitter of the log.",
        1,
        0,
        Expected::Reject("LogEmitterMismatch"),
    );
    other_bridge.remote_bridge = ATTACKER;
    cases.push(other_bridge);

    let mut not_stored = base(
        "reject_anchor_not_stored",
        "The light client returns zero for the anchor slot.",
        1,
        0,
        Expected::Reject("AnchorNotStored"),
    );
    not_stored.stored_anchor_root = B256::ZERO;
    cases.push(not_stored);
    let mut other_root = base(
        "reject_anchor_root_differs",
        "The light client stores another root for the anchor slot.",
        1,
        0,
        Expected::Reject("AnchorNotStored"),
    );
    other_root.stored_anchor_root = B256::repeat_byte(3);
    cases.push(other_root);

    let mut roots = base(
        "reject_corrupted_recent_ancestry_branch",
        "One entry of ancestryBranch is flipped (recent path).",
        1,
        0,
        Expected::Reject("InvalidAncestryBranch"),
    );
    flip_node(&mut roots.proof.ancestryBranch[4]);
    cases.push(roots);
    let mut padded = base(
        "reject_padded_recent_ancestry_branch",
        "ancestryBranch has one extra zero entry (recent path); the bridge wants the exact length.",
        1,
        0,
        Expected::Reject("InvalidAncestryBranch"),
    );
    padded.proof.ancestryBranch.insert(0, B256::ZERO);
    cases.push(padded);
    let mut hash_branch = base(
        "reject_corrupted_block_hash_branch",
        "One entry of blockHashBranch is flipped.",
        1,
        0,
        Expected::Reject("InvalidBlockHashBranch"),
    );
    flip_node(&mut hash_branch.proof.blockHashBranch[1]);
    cases.push(hash_branch);
    let mut short = base(
        "reject_short_block_hash_branch",
        "blockHashBranch lacks its last entry.",
        1,
        0,
        Expected::Reject("InvalidBlockHashBranch"),
    );
    short.proof.blockHashBranch.pop();
    cases.push(short);
    let mut wrong_slot = base(
        "reject_wrong_source_slot",
        "sourceHeader.slot is one more than the slot the branch proves.",
        1,
        0,
        Expected::Reject("InvalidAncestryBranch"),
    );
    wrong_slot.proof.sourceHeader.slot += 1;
    cases.push(wrong_slot);
    let mut tampered_rlp = base(
        "reject_tampered_header_rlp",
        "One byte of executionHeaderRlp is flipped, so its hash is not the proven block hash.",
        1,
        0,
        Expected::Reject("InvalidBlockHashBranch"),
    );
    let mut rlp = tampered_rlp.proof.executionHeaderRlp.to_vec();
    rlp[40] ^= 1;
    tampered_rlp.proof.executionHeaderRlp = rlp.into();
    cases.push(tampered_rlp);

    let mut receipt_node = base(
        "reject_corrupted_receipt_proof",
        "A byte of the last receipt proof node is flipped.",
        1,
        0,
        Expected::Reject("ReceiptProofInvalid"),
    );
    damage_last_node(&mut receipt_node.proof.receiptProof);
    cases.push(receipt_node);
    let mut wrong_index = base(
        "reject_wrong_receipt_index",
        "receiptIndex and transactionIndex both name another transaction than the proofs.",
        1,
        0,
        Expected::Reject("ReceiptProofInvalid"),
    );
    wrong_index.proof.receiptIndex = U256::from(2u64);
    wrong_index.proof.transactionIndex = U256::from(2u64);
    cases.push(wrong_index);
    let mut transaction_node = base(
        "reject_corrupted_transaction_proof",
        "A byte of the last transaction proof node is flipped.",
        1,
        0,
        Expected::Reject("TransactionProofInvalid"),
    );
    damage_last_node(&mut transaction_node.proof.transactionProof);
    cases.push(transaction_node);
    let other_transaction = build_message(spec, &receipts, 0, 0, source_slot, anchor_slot);
    let mut swapped_transaction = base(
        "reject_transaction_proof_of_another_transaction",
        "The transaction proof is the honest proof of transaction 0, but the index is 1.",
        1,
        0,
        Expected::Reject("TransactionProofInvalid"),
    );
    swapped_transaction.proof.transactionProof = other_transaction.proof.transactionProof;
    cases.push(swapped_transaction);
    let mut mismatch = base(
        "reject_index_mismatch",
        "The receipt proof is honest for index 1 and the transaction proof for index 0; the two indices differ.",
        1,
        0,
        Expected::Reject("IndexMismatch"),
    );
    mismatch.proof.transactionProof =
        build_message(spec, &receipts, 0, 0, source_slot, anchor_slot).proof.transactionProof;
    mismatch.proof.transactionIndex = U256::ZERO;
    cases.push(mismatch);

    let window = |name: &str, description: &str, source: u64, expected: Expected| {
        let scenario = build_message(spec, &receipts, 1, 0, source, window_anchor);
        case_at(name, description, scenario, expected)
    };
    cases.push(window(
        "accept_source_exactly_8192_slots_before_anchor",
        "The oldest source block the recent path allows.",
        window_anchor - 8192,
        Expected::Accept,
    ));
    cases.push(window(
        "accept_source_8193_slots_before_anchor_historical_path",
        "One slot past the recent window: the bridge takes the historical path, and the branch goes through historical_summaries.",
        window_anchor - 8193,
        Expected::Accept,
    ));
    cases.push(window(
        "reject_source_in_anchor_slot",
        "The source slot equals the anchor slot.",
        window_anchor,
        Expected::Reject("DepositNotBeforeAnchor"),
    ));
    cases.extend(historical_cases(spec, prefix, local_chain_id, window_anchor));
    cases
}

/// Cases for the historical ancestry path. The anchor state always holds the source header root in every place a mixed-up
/// proof could point at (see `assemble_message`), so each rejection below comes from the bridge's choice of path, index
/// and length, not from a broken Merkle path.
fn historical_cases(spec: &'static ChainSpec, prefix: &str, local_chain_id: u64, anchor: u64) -> Vec<Case> {
    let receipts = standard_receipts(spec, local_chain_id);
    let scenario_at = |source_slot: u64| build_message(spec, &receipts, 1, 0, source_slot, anchor);
    let case = |name: &str, description: &str, scenario: MessageScenario, expected: Expected| Case {
        name: format!("{prefix}_{name}"),
        description: description.to_string(),
        spec,
        proof: scenario.proof,
        stored_anchor_root: scenario.stored_anchor_root,
        remote_bridge: BRIDGE,
        local_chain_id,
        remote_chain_id: remote_chain_id(spec),
        expected,
    };
    // The era edge: the last slot of one era and the first slot of the next, both far from the anchor.
    let edge_era = anchor / SLOTS_PER_HISTORICAL_ROOT - 4;
    let last_slot_of_era = (edge_era + 1) * SLOTS_PER_HISTORICAL_ROOT - 1;
    let first_slot_of_next_era = last_slot_of_era + 1;
    let mut cases = vec![
        case(
            "accept_historical_era_last_slot",
            "Historical path. The source block sits in the last slot of an era; the index is that era minus capellaEra.",
            scenario_at(last_slot_of_era),
            Expected::Accept,
        ),
        case(
            "accept_historical_era_first_slot",
            "Historical path. The source block sits in the first slot of the next era; the index is one higher.",
            scenario_at(first_slot_of_next_era),
            Expected::Accept,
        ),
    ];

    let mut wrong_era = scenario_at(last_slot_of_era);
    wrong_era.proof.ancestryBranch =
        wrong_era.historical_ancestry_branch_for_era(edge_era + 1).expect("the next era is complete at the anchor");
    cases.push(case(
        "reject_historical_wrong_era_index",
        "The source block is in the last slot of era E. The branch is a valid path of the anchor state, but for the list position of era E+1 (the state holds the source header root there too).",
        wrong_era,
        Expected::Reject("InvalidAncestryBranch"),
    ));
    let mut padded = scenario_at(last_slot_of_era);
    padded.proof.ancestryBranch.insert(0, B256::ZERO);
    cases.push(case(
        "reject_historical_padded_branch",
        "The historical ancestryBranch has one extra zero entry; the bridge wants the exact length.",
        padded,
        Expected::Reject("InvalidAncestryBranch"),
    ));
    let mut short = scenario_at(last_slot_of_era);
    short.proof.ancestryBranch.pop();
    cases.push(case(
        "reject_historical_short_branch",
        "The historical ancestryBranch lacks its last entry.",
        short,
        Expected::Reject("InvalidAncestryBranch"),
    ));
    let mut corrupted = scenario_at(last_slot_of_era);
    flip_node(&mut corrupted.proof.ancestryBranch[20]);
    cases.push(case(
        "reject_historical_corrupted_branch",
        "One entry inside the 24 list levels of the historical ancestryBranch is flipped.",
        corrupted,
        Expected::Reject("InvalidAncestryBranch"),
    ));
    let mut recent_gindex = scenario_at(last_slot_of_era);
    recent_gindex.proof.ancestryBranch = recent_gindex.recent_ancestry_branch();
    cases.push(case(
        "reject_historical_distance_with_block_roots_branch",
        "The distance is above 8192, but the branch was built with the block_roots index (a valid path of the anchor state).",
        recent_gindex,
        Expected::Reject("InvalidAncestryBranch"),
    ));
    let recent_source_slot = (anchor / SLOTS_PER_HISTORICAL_ROOT) * SLOTS_PER_HISTORICAL_ROOT - 300;
    let mut historical_gindex = scenario_at(recent_source_slot);
    historical_gindex.proof.ancestryBranch =
        historical_gindex.historical_ancestry_branch().expect("the source era is complete at the anchor");
    cases.push(case(
        "reject_recent_distance_with_historical_branch",
        "The distance is at most 8192 and the source era is complete, but the branch was built with the historical_summaries index (a valid path of the anchor state).",
        historical_gindex,
        Expected::Reject("InvalidAncestryBranch"),
    ));
    cases.push(case(
        "accept_recent_distance_in_a_complete_era",
        "Control for the reverse attack: the same message with the recent branch verifies.",
        scenario_at(recent_source_slot),
        Expected::Accept,
    ));

    // capellaEra: the first era of the chain is reachable, and an older era is not.
    let capella_era = spec.capella_era().expect("Capella");
    let first_capella_era_slot = capella_era * SLOTS_PER_HISTORICAL_ROOT;
    cases.push(case(
        "accept_historical_first_capella_era",
        "The first slot of era capellaEra (list position 0). Ethereum: slot 6209536, the Capella slot. PulseChain: slot 0 is before Capella, but the era is capellaEra 0.",
        scenario_at(first_capella_era_slot.max(spec.capella_fork_slot().expect("Capella"))),
        Expected::Accept,
    ));
    if capella_era > 0 {
        let mut before = scenario_at(first_capella_era_slot);
        before.proof.sourceHeader.slot = first_capella_era_slot - 1;
        cases.push(case(
            "reject_historical_source_before_capella_era",
            "The source slot is the last slot of era capellaEra - 1. No summary covers it. (The branch is a copy of the honest one; the era check comes first.)",
            before,
            Expected::Reject("DepositBeforeCapella"),
        ));
    }
    cases
}

/// The cases of a Gloas SOURCE chain (Sepolia): the source block of the proof is a beacon block B at or after the Gloas fork
/// whose bid names the execution block X as its `parent_block_hash` (index 2856). B comes after the block of X. The anchor
/// is a Gloas state (progressive, `block_roots` at 352, `historical_summaries` at 2950).
fn gloas_cases() -> Vec<Case> {
    use crate::synthetic::{assemble_message_with_body, gloas_body_with_hash_in, message_evidence, BodyProofs};
    let spec: &'static ChainSpec = &SEPOLIA;
    let local = 943;
    let gloas_slot = 353_024 * 32;
    let (source_slot, anchor_slot) = (gloas_slot + 3_000, gloas_slot + 3_500);
    let receipts = standard_receipts(spec, local);
    let case = |name: &str, description: &str, scenario: MessageScenario, expected: Expected| Case {
        name: format!("gloas_{name}"),
        description: description.to_string(),
        spec,
        proof: scenario.proof,
        stored_anchor_root: scenario.stored_anchor_root,
        remote_bridge: BRIDGE,
        local_chain_id: local,
        remote_chain_id: remote_chain_id(spec),
        expected,
    };
    let base = |name: &str, description: &str, tx: u64, log: u64, expected: Expected| {
        case(name, description, build_message(spec, &receipts, tx, log, source_slot, anchor_slot), expected)
    };
    let with_body = |field: usize, source: u64, anchor: u64| {
        let evidence = message_evidence(spec, &receipts, 1, source);
        let block_hash = alloy_primitives::keccak256(&evidence.header_rlp);
        let gloas = gloas_body_with_hash_in(field, block_hash);
        let body = BodyProofs {
            body_root: gloas.root(),
            execution_branch: Vec::new(),
            block_hash_branch: gloas.bid_field_branch(field),
        };
        assemble_message_with_body(spec, &evidence, &body, 1, 0, source, anchor)
    };
    let mut cases = vec![
        base(
            "accept_recent_bid_parent_hash",
            "The source block is a Gloas beacon block B. Its bid names the execution block as parent_block_hash (index 2856). Recent path.",
            1,
            0,
            Expected::Accept,
        ),
        base(
            "accept_second_message_in_same_receipt",
            "Type 0 receipt with two messages in a Gloas execution block; the proof names log 2.",
            1,
            2,
            Expected::Accept,
        ),
        base(
            "reject_failed_status_receipt",
            "A Gloas execution block with a failed receipt: the receipt proof is read from the RLP header and the status is refused.",
            2,
            0,
            Expected::Reject("ReceiptFailed"),
        ),
    ];
    // Historical path: the anchor is more than 8192 slots after B.
    cases.push(case(
        "accept_historical_bid_parent_hash",
        "The anchor is more than 8192 slots after B: the historical path through index 2950, with the bid parent hash of B.",
        build_message(spec, &receipts, 1, 0, source_slot, source_slot + 20_000),
        Expected::Accept,
    ));
    // The bid's own `block_hash` is never the anchor of a message: a body that holds X only in bid field 2.
    let mut bid_block_hash = with_body(2, source_slot, anchor_slot);
    bid_block_hash.proof.blockHashBranch = {
        let evidence = message_evidence(spec, &receipts, 1, source_slot);
        gloas_body_with_hash_in(2, alloy_primitives::keccak256(&evidence.header_rlp)).bid_field_branch(2)
    };
    cases.push(case(
        "reject_bid_block_hash_instead_of_parent_block_hash",
        "The bid of B holds X in block_hash (bid field 2, index 22857) and the proof carries that branch: 14 entries, not the 11 of index 2856.",
        bid_block_hash,
        Expected::Reject("InvalidBlockHashBranch"),
    ));
    cases.push(case(
        "reject_hash_in_the_neighbouring_bid_field",
        "The bid of B holds X in parent_block_root (bid field 1, index 2857) and the proof carries that branch: same length, wrong position.",
        with_body(1, source_slot, anchor_slot),
        Expected::Reject("InvalidBlockHashBranch"),
    ));
    let mut wrong_rlp = base("x", "x", 1, 0, Expected::Accept);
    wrong_rlp.proof.executionHeaderRlp = message_evidence(spec, &receipts, 1, source_slot + 1).header_rlp;
    wrong_rlp.name = "gloas_reject_rlp_of_another_block".into();
    wrong_rlp.description =
        "The RLP is the header of another execution block: it does not hash to the parent_block_hash of the bid."
            .into();
    wrong_rlp.expected = Expected::Reject("InvalidBlockHashBranch");
    cases.push(wrong_rlp);
    let mut not_ancestor = base("x", "x", 1, 0, Expected::Accept);
    flip_node(&mut not_ancestor.proof.ancestryBranch[6]);
    not_ancestor.name = "gloas_reject_source_block_is_not_an_ancestor".into();
    not_ancestor.description =
        "One entry of the ancestry branch is flipped: B is not proven to be an ancestor of the stored head.".into();
    not_ancestor.expected = Expected::Reject("InvalidAncestryBranch");
    cases.push(not_ancestor);
    // B before the fork: a Fulu block with the Gloas branch (11 entries) in place of its own 9.
    let mut before_fork = build_message(spec, &receipts, 1, 0, gloas_slot - 3_000, anchor_slot);
    let evidence = message_evidence(spec, &receipts, 1, gloas_slot - 3_000);
    before_fork.proof.blockHashBranch =
        gloas_body_with_hash_in(0, alloy_primitives::keccak256(&evidence.header_rlp)).block_hash_branch();
    cases.push(case(
        "reject_source_before_the_gloas_fork_with_the_bid_branch",
        "B is a Fulu block (before the fork) and the proof carries the Gloas branch of 11 entries instead of the 9 of the payload block hash.",
        before_fork,
        Expected::Reject("InvalidBlockHashBranch"),
    ));
    cases
}

/// The cases of the fork proof of the source state (`MessageProof.sourceFork`). The proven shape picks the block hash rule,
/// so the rule follows the state of the source block and never the fork schedule. The first case is the one of
/// `docs/superpowers/specs/2026-11-10-mainnet-readiness.md` A6: on the Ethereum mainnet schedule, which has no Gloas epoch,
/// a source block whose state is progressive and whose bid names X is proven through the bid, as on a chain that runs
/// Gloas. The anchor is a Fulu state, as the schedule has it.
fn fork_proof_cases() -> Vec<Case> {
    use crate::synthetic::{assemble_message_with_source_fork, gloas_body, message_evidence, source_state, BodyProofs};
    let case =
        |name: &str, spec: &'static ChainSpec, local: u64, scenario: MessageScenario, description: &str, expected| {
            Case {
                name: name.to_string(),
                description: description.to_string(),
                spec,
                proof: scenario.proof,
                stored_anchor_root: scenario.stored_anchor_root,
                remote_bridge: BRIDGE,
                local_chain_id: local,
                remote_chain_id: remote_chain_id(spec),
                expected,
            }
        };
    let ethereum: &'static ChainSpec = &ETHEREUM_MAINNET;
    let (source_slot, anchor_slot) = (15_476_000, 15_476_500);
    assert_eq!(ethereum.fork_at_slot(source_slot), ForkName::Fulu, "the schedule counts the source slot as Fulu");
    let receipts = standard_receipts(ethereum, 369);
    let evidence = message_evidence(ethereum, &receipts, 1, source_slot);
    let gloas = gloas_body(alloy_primitives::keccak256(&evidence.header_rlp));
    let body = BodyProofs {
        body_root: gloas.root(),
        execution_branch: Vec::new(),
        block_hash_branch: gloas.block_hash_branch(),
    };
    let unscheduled = || {
        assemble_message_with_source_fork(ethereum, &evidence, &body, 1, 0, source_slot, anchor_slot, ForkName::Gloas)
    };
    let mut cases = vec![case(
        "electra_accept_unscheduled_gloas_source",
        ethereum,
        369,
        unscheduled(),
        "Ethereum mainnet schedule (no Gloas epoch). The source state is progressive (fork proof of 7 and 5 entries) and the bid of B names X as parent_block_hash (index 2856): the bid rule applies with no fork slot in the bridge.",
        Expected::Accept,
    )];
    let mut plain_claim = unscheduled();
    plain_claim.proof.sourceFork = source_state(ethereum, ForkName::Fulu).1;
    cases.push(case(
        "electra_reject_unscheduled_gloas_source_with_a_plain_fork_proof",
        ethereum,
        369,
        plain_claim,
        "The same Gloas source with the fork proof of a plain Fulu state: the proof is valid for another root, so no shape is proven under the state root of B.",
        Expected::Reject("InvalidForkShapeProof"),
    ));

    let sepolia: &'static ChainSpec = &SEPOLIA;
    let gloas_slot = 353_024 * 32;
    let mut swapped =
        build_message(sepolia, &standard_receipts(sepolia, 943), 1, 0, gloas_slot + 3_000, gloas_slot + 3_500);
    swapped.proof.sourceFork = source_state(sepolia, ForkName::Fulu).1;
    cases.push(case(
        "gloas_reject_fork_proof_of_a_plain_state",
        sepolia,
        943,
        swapped,
        "A Gloas source whose proof carries the fork proof of a plain Fulu state instead of its own: refused before the block hash.",
        Expected::Reject("InvalidForkShapeProof"),
    ));

    let pulsechain: &'static ChainSpec = &PULSECHAIN;
    let receipts = standard_receipts(pulsechain, 1);
    let mut empty = build_message(pulsechain, &receipts, 1, 0, 10_872_000, 10_872_500);
    empty.proof.sourceFork.versionBranch.clear();
    empty.proof.sourceFork.genesisValidatorsRootBranch.clear();
    cases.push(case(
        "capella_reject_empty_fork_proof",
        pulsechain,
        1,
        empty,
        "The fork proof of the source state is empty: no shape has a version branch of length 0.",
        Expected::Reject("InvalidForkShapeProof"),
    ));
    let mut corrupted = build_message(pulsechain, &receipts, 1, 0, 10_872_000, 10_872_500);
    flip_node(&mut corrupted.proof.sourceFork.genesisValidatorsRootBranch[2]);
    cases.push(case(
        "capella_reject_corrupted_genesis_validators_root_branch",
        pulsechain,
        1,
        corrupted,
        "One entry of the genesis validators root branch of the fork proof is flipped: the version branch holds, the root does not.",
        Expected::Reject("InvalidForkShapeProof"),
    ));
    cases
}

/// All message fixtures as `(file stem, JSON)`.
pub fn message_fixtures() -> Vec<(String, Value)> {
    let mut cases = synthetic_cases(&PULSECHAIN, "capella", 1, 10_900_000);
    cases.extend(synthetic_cases(&ETHEREUM_MAINNET, "electra", 369, 15_500_000));
    cases.extend(gloas_cases());
    cases.extend(fork_proof_cases());
    cases.into_iter().map(render).collect()
}

/// Checks one fixture value (read from disk) with the Rust verifier: it decodes the calldata and compares the outcome.
///
/// # Panics
/// Panics with the fixture name when the Rust outcome differs from the declared outcome.
pub fn check_fixture_with_verifier(fixture: &Value) {
    let name = fixture["name"].as_str().expect("name");
    let spec: &ChainSpec = match fixture["chain"].as_str() {
        Some("pulsechain") => &PULSECHAIN,
        Some("sepolia") => &SEPOLIA,
        _ => &ETHEREUM_MAINNET,
    };
    let calldata = hex_bytes(&fixture["calldata"]);
    let proof = executeMessageCall::abi_decode(&calldata).unwrap_or_else(|error| panic!("{name}: {error}")).proof;
    let number = |key: &str| -> u64 { fixture[key].as_str().expect(key).parse().expect(key) };
    let context = MessageContext {
        remote_bridge: Address::from_slice(&hex_bytes(&fixture["remoteBridge"])),
        local_chain_id: number("localChainId"),
        remote_chain_id: number("remoteChainId"),
        stored_anchor_root: hex_b256(&fixture["storedAnchorHeaderRoot"]),
    };
    let outcome = verify_message(&proof, &context, spec);
    let expected = &fixture["expected"];
    match (expected["result"].as_str(), outcome) {
        (Some("accept"), Ok(message)) => assert_eq!(message_json(&message), expected["message"], "{name}"),
        (Some("reject"), Err(error)) => {
            assert_eq!(reason_code(&error), expected["reason"].as_str().expect("reason"), "{name}: {error}")
        }
        (declared, other) => panic!("{name}: declared {declared:?} but the verifier returned {other:?}"),
    }
}
