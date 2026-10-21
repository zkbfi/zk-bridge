//! The shared fixtures for the Rust and Solidity withdrawal tests: `gindices.json` and `withdrawal/*.json`.
//!
//! The format is documented in `tests/fixtures/README.md`. `write-withdrawal-fixtures` writes the files. A Rust test
//! regenerates them in memory and compares with the files on disk, so a stale file fails the test. While it builds each
//! case it runs `verify_withdrawal` and asserts that the outcome equals the outcome the file declares.

use crate::json::{hex_bytes, load_response};
use crate::pulsechain::{real_historical_withdrawal_proof, real_withdrawal_proof, rebuild_block};
use crate::synthetic::{
    assemble_withdrawal, build_withdrawal, deposit_log, DepositFields, ExecutionBlockEvidence, ReceiptSpec,
    WithdrawalScenario,
};
use alloy_primitives::{address, hex, Address, Bytes, B256, U256};
use alloy_sol_types::SolCall;
use lc_core::abi::{withdrawCall, WithdrawalProof};
use lc_core::ancestry::{ancestry_path_for_slots, historical_leaf_gindex, AncestryPath};
use lc_core::chain::{ChainSpec, ForkName, ETHEREUM_MAINNET, FAR_FUTURE_EPOCH, PULSECHAIN};
use lc_core::execution::Log;
use lc_core::layout::{
    block_hash_gindex_for_fork, state_layout_for_fork, BLOCK_ROOTS_VECTOR_DEPTH, EXECUTION_PAYLOAD_GINDEX,
    HISTORICAL_SUMMARIES_LIST_DEPTH, SLOTS_PER_HISTORICAL_ROOT,
};
use lc_core::ssz::gindex_depth;
use lc_core::withdrawal::{verify_withdrawal, VerifiedDeposit, WithdrawalContext};
use serde_json::{json, Value};

const VAULT: Address = address!("00000000000000000000000000000000000000a1");
const ATTACKER: Address = address!("00000000000000000000000000000000000000ee");

fn text(value: impl core::fmt::LowerHex) -> String {
    format!("{value:#x}")
}

/// The fork schedule rows the vault takes as a constructor argument, for one source chain.
/// Row: `(activationEpoch, blockRootsGindexBase, blockHashGindex, historicalSummariesGindex)`.
/// `historicalSummariesGindex` is the generalized index of the `historical_summaries` field in the `BeaconState` of the
/// fork (the anchor's layout). Forks without a supported layout are left out.
fn schedule_rows(spec: &ChainSpec) -> Vec<Value> {
    spec.fork_schedule
        .iter()
        .filter(|entry| entry.epoch != FAR_FUTURE_EPOCH)
        .filter_map(|entry| {
            let layout = state_layout_for_fork(entry.fork_name).ok()?;
            let block_hash_gindex = block_hash_gindex_for_fork(entry.fork_name).ok()?;
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

/// `tests/fixtures/gindices.json`: every generalized index the vault and the light client need, per fork, with sources.
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
        "generatedBy": "cargo run -p lc-testkit --bin write-withdrawal-fixtures",
        "notes": [
            "blockRootsGindexBase = blockRootsFieldGindex * 8192. The generalized index of block_roots[slot % 8192] is blockRootsGindexBase + (slot % 8192).",
            "blockHashGindex is the combined index of BeaconBlockBody.execution_payload.block_hash: executionPayloadGindex * 2^payloadDepth + 12. block_hash is field 12 of ExecutionPayload.",
            "The vault picks the block roots row by the epoch of the ANCHOR header slot and the block hash row by the epoch of the DEPOSIT header slot.",
            "A branch has exactly floorlog2(gindex) entries. A branch with padding is refused.",
            "The vault picks the ancestry path from the slots: recent when 0 < anchorSlot - depositSlot <= 8192 (leaf block_roots[depositSlot % 8192]), historical when the distance is above 8192.",
            "Historical generalized index, in this order: g = historicalSummariesFieldGindex; g = g * 2 (list data root); g = g * 2^24 + index (HISTORICAL_ROOTS_LIMIT = 2^24); g = g * 2 + 0 (block_summary_root); g = g * 2^13 + depositSlot % 8192. index = depositSlot / 8192 - capellaEra, and the deposit era must be at least capellaEra.",
            "historicalAncestryBranchLength is the exact length of the historical ancestry branch: 44 in the Capella and Deneb layouts, 45 in the Electra and Fulu layouts.",
            "capellaEra = floor(capellaForkSlot / 8192): Ethereum 758 (Capella slot 6209536), PulseChain 0 (Capella epoch 3, slot 96). It is an immutable vault argument."
        ],
        "historicalRootsLimit": (1u64 << HISTORICAL_SUMMARIES_LIST_DEPTH).to_string(),
        "historicalSummariesListDepth": HISTORICAL_SUMMARIES_LIST_DEPTH,
        "slotsPerHistoricalRoot": SLOTS_PER_HISTORICAL_ROOT.to_string(),
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
    beacon_data: &'static str,
    receipt_data: &'static str,
    spec: &'static ChainSpec,
    proof: WithdrawalProof,
    stored_anchor_root: B256,
    remote_vault: Address,
    local_chain_id: u64,
    expected: Expected,
}

fn deposit_json(deposit: &VerifiedDeposit) -> Value {
    json!({
        "token": text(deposit.token),
        "sender": text(deposit.sender),
        "recipient": text(deposit.recipient),
        "amount": deposit.amount.to_string(),
        "nonce": text(deposit.nonce),
        "targetChainId": deposit.target_chain_id.to_string(),
        "depositBlockHash": text(deposit.deposit_block_hash),
    })
}

fn render(case: Case) -> (String, Value) {
    let context = WithdrawalContext {
        remote_vault: case.remote_vault,
        local_chain_id: case.local_chain_id,
        stored_anchor_root: case.stored_anchor_root,
    };
    let outcome = verify_withdrawal(&case.proof, &context, case.spec);
    let expected = match (&case.expected, &outcome) {
        (Expected::Accept, Ok(deposit)) => json!({ "result": "accept", "deposit": deposit_json(deposit) }),
        (Expected::Reject(reason), Err(error)) if error.reason_code() == *reason => {
            json!({ "result": "reject", "reason": reason })
        }
        (_, other) => panic!("case {} did not give the declared outcome: {other:?}", case.name),
    };
    let calldata = withdrawCall { proof: case.proof.clone() }.abi_encode();
    let layout = if case.spec.name == "pulsechain" { "capella" } else { "electra" };
    let ancestry_path = match ancestry_path_for_slots(case.proof.anchorHeader.slot, case.proof.depositHeader.slot) {
        Ok(AncestryPath::Recent) => "recent",
        Ok(AncestryPath::Historical) => "historical",
        Err(_) => "none",
    };
    let value = json!({
        "name": case.name,
        "description": case.description,
        "beaconData": case.beacon_data,
        "receiptData": case.receipt_data,
        "chain": case.spec.name,
        "layout": layout,
        "calldata": format!("0x{}", hex::encode(calldata)),
        "anchorSlot": case.proof.anchorHeader.slot.to_string(),
        "ancestryPath": ancestry_path,
        "capellaEra": case.spec.capella_era().expect("Capella").to_string(),
        "storedAnchorHeaderRoot": text(case.stored_anchor_root),
        "remoteVault": text(case.remote_vault),
        "localChainId": case.local_chain_id.to_string(),
        "sourceForkSchedule": schedule_rows(case.spec),
        "expected": expected,
    });
    (case.name, value)
}

fn fields(nonce_byte: u8, amount: u64, target_chain_id: u64) -> DepositFields {
    DepositFields {
        token: address!("00000000000000000000000000000000000000b2"),
        sender: address!("00000000000000000000000000000000000000c3"),
        recipient: address!("00000000000000000000000000000000000000d4"),
        amount,
        nonce: B256::repeat_byte(nonce_byte),
        target_chain_id,
    }
}

fn unrelated_log() -> Log {
    Log {
        address: address!("0000000000000000000000000000000000000fff"),
        topics: vec![B256::repeat_byte(0x77)],
        data: Bytes::from_static(&[1, 2, 3]),
    }
}

/// Receipts of the synthetic block:
/// 0: type 2, success, unrelated log. 1: type 0, success: deposit A, unrelated, deposit B.
/// 2: type 2, FAILED, deposit. 3: type 2, success, deposit C.
/// 4: type 0, success: deposit-shaped log from an attacker, revision 2 topic log from the vault.
fn synthetic_receipts(target: u64) -> Vec<ReceiptSpec> {
    let revision_two = Log {
        address: VAULT,
        topics: vec![alloy_primitives::b256!("2df93605658e38812f86230cb85b0d0c35583b27b9c9769f36b6fbfda3d8c1ee")],
        data: Bytes::new(),
    };
    vec![
        ReceiptSpec { transaction_type: 2, success: true, logs: vec![unrelated_log()] },
        ReceiptSpec {
            transaction_type: 0,
            success: true,
            logs: vec![
                deposit_log(VAULT, &fields(0xa1, 1_000, target)),
                unrelated_log(),
                deposit_log(VAULT, &fields(0xb2, 2_000, target)),
            ],
        },
        ReceiptSpec {
            transaction_type: 2,
            success: false,
            logs: vec![deposit_log(VAULT, &fields(0xd4, 4_000, target))],
        },
        ReceiptSpec {
            transaction_type: 2,
            success: true,
            logs: vec![deposit_log(VAULT, &fields(0xc3, 3_000, target))],
        },
        ReceiptSpec {
            transaction_type: 0,
            success: true,
            logs: vec![deposit_log(ATTACKER, &fields(0xee, 9_000, target)), revision_two],
        },
    ]
}

fn flip_node(node: &mut B256) {
    node.0[5] ^= 1;
}

fn synthetic_cases(spec: &'static ChainSpec, prefix: &str, local_chain_id: u64, window_anchor: u64) -> Vec<Case> {
    let (deposit_slot, anchor_slot) =
        if spec.name == "pulsechain" { (10_872_000, 10_872_500) } else { (15_476_000, 15_476_500) };
    let receipts = synthetic_receipts(local_chain_id);
    let base = |name: &str, description: &str, tx: u64, log: u64, expected: Expected| {
        let scenario = build_withdrawal(spec, &receipts, tx, log, deposit_slot, anchor_slot);
        Case {
            name: format!("{prefix}_{name}"),
            description: description.to_string(),
            beacon_data: "synthetic",
            receipt_data: "synthetic",
            spec,
            proof: scenario.proof,
            stored_anchor_root: scenario.stored_anchor_root,
            remote_vault: VAULT,
            local_chain_id,
            expected,
        }
    };
    let mut cases = vec![
        base("accept_legacy_receipt_first_deposit", "Type 0 receipt, deposit at log 0.", 1, 0, Expected::Accept),
        base(
            "accept_second_deposit_in_same_receipt",
            "Type 0 receipt with two deposits; the proof names log 2 (defect R2-06).",
            1,
            2,
            Expected::Accept,
        ),
        base("accept_dynamic_fee_receipt", "Type 2 receipt, deposit at log 0 (defect R2-05).", 3, 0, Expected::Accept),
        base(
            "reject_failed_status_receipt",
            "The receipt has failed status and a perfect deposit log.",
            2,
            0,
            Expected::Reject("ReceiptFailed"),
        ),
        base(
            "reject_log_from_another_emitter",
            "A deposit-shaped log emitted by an attacker contract (H-02).",
            4,
            0,
            Expected::Reject("LogEmitterMismatch"),
        ),
        base(
            "reject_revision_two_topic",
            "A log from the vault with the revision 2 topic 0x2df9...c1ee.",
            4,
            1,
            Expected::Reject("LogTopicMismatch"),
        ),
        base(
            "reject_log_index_out_of_range",
            "Log index 3 in a receipt with 3 logs.",
            1,
            3,
            Expected::Reject("LogIndexOutOfRange"),
        ),
        base(
            "reject_unrelated_log_index",
            "Log 1 is an unrelated log from another contract.",
            1,
            1,
            Expected::Reject("LogEmitterMismatch"),
        ),
    ];

    let mut target_mismatch = base(
        "reject_target_chain_mismatch",
        "The deposit targets another chain than localChainId.",
        1,
        0,
        Expected::Reject("TargetChainMismatch"),
    );
    target_mismatch.local_chain_id = 31337;
    cases.push(target_mismatch);

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
        "ancestryBranch has one extra zero entry (recent path); the vault wants the exact length.",
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
        "reject_wrong_deposit_slot",
        "depositHeader.slot is one more than the slot the branch proves.",
        1,
        0,
        Expected::Reject("InvalidAncestryBranch"),
    );
    wrong_slot.proof.depositHeader.slot += 1;
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
    let last = receipt_node.proof.receiptProof.len() - 1;
    let mut node = receipt_node.proof.receiptProof[last].to_vec();
    let middle = node.len() / 2;
    node[middle] ^= 1;
    receipt_node.proof.receiptProof[last] = node.into();
    cases.push(receipt_node);
    let mut wrong_index = base(
        "reject_wrong_transaction_index",
        "transactionIndex names another transaction than the proof.",
        1,
        0,
        Expected::Reject("ReceiptProofInvalid"),
    );
    wrong_index.proof.transactionIndex = U256::from(2u64);
    cases.push(wrong_index);

    let window = |name: &str, description: &str, deposit: u64, expected: Expected| {
        let scenario = build_withdrawal(spec, &receipts, 1, 0, deposit, window_anchor);
        Case {
            name: format!("{prefix}_{name}"),
            description: description.to_string(),
            beacon_data: "synthetic",
            receipt_data: "synthetic",
            spec,
            proof: scenario.proof,
            stored_anchor_root: scenario.stored_anchor_root,
            remote_vault: VAULT,
            local_chain_id,
            expected,
        }
    };
    cases.push(window(
        "accept_deposit_exactly_8192_slots_before_anchor",
        "The oldest deposit the window allows.",
        window_anchor - 8192,
        Expected::Accept,
    ));
    cases.push(window(
        "accept_deposit_8193_slots_before_anchor_historical_path",
        "One slot past the recent window: the vault takes the historical path, and the branch goes through historical_summaries.",
        window_anchor - 8193,
        Expected::Accept,
    ));
    cases.push(window(
        "reject_deposit_in_anchor_slot",
        "The deposit slot equals the anchor slot.",
        window_anchor,
        Expected::Reject("DepositNotBeforeAnchor"),
    ));
    cases.extend(historical_cases(spec, prefix, local_chain_id, window_anchor));
    cases
}

/// Cases for the historical ancestry path. The anchor state always holds the deposit header root in every place a mixed-up
/// proof could point at (see `assemble_withdrawal`), so each rejection below comes from the vault's choice of path, index
/// and length, not from a broken Merkle path.
fn historical_cases(spec: &'static ChainSpec, prefix: &str, local_chain_id: u64, anchor: u64) -> Vec<Case> {
    let receipts = synthetic_receipts(local_chain_id);
    let scenario_at = |deposit_slot: u64| build_withdrawal(spec, &receipts, 1, 0, deposit_slot, anchor);
    let case = |name: &str, description: &str, scenario: WithdrawalScenario, expected: Expected| Case {
        name: format!("{prefix}_{name}"),
        description: description.to_string(),
        beacon_data: "synthetic",
        receipt_data: "synthetic",
        spec,
        proof: scenario.proof,
        stored_anchor_root: scenario.stored_anchor_root,
        remote_vault: VAULT,
        local_chain_id,
        expected,
    };
    // The era edge: the last slot of one era and the first slot of the next, both far from the anchor.
    let edge_era = anchor / SLOTS_PER_HISTORICAL_ROOT - 4;
    let last_slot_of_era = (edge_era + 1) * SLOTS_PER_HISTORICAL_ROOT - 1;
    let first_slot_of_next_era = last_slot_of_era + 1;
    let mut cases = vec![
        case(
            "accept_historical_era_last_slot",
            "Historical path. The deposit sits in the last slot of an era; the index is that era minus capellaEra.",
            scenario_at(last_slot_of_era),
            Expected::Accept,
        ),
        case(
            "accept_historical_era_first_slot",
            "Historical path. The deposit sits in the first slot of the next era; the index is one higher.",
            scenario_at(first_slot_of_next_era),
            Expected::Accept,
        ),
    ];

    let mut wrong_era = scenario_at(last_slot_of_era);
    wrong_era.proof.ancestryBranch =
        wrong_era.historical_ancestry_branch_for_era(edge_era + 1).expect("the next era is complete at the anchor");
    cases.push(case(
        "reject_historical_wrong_era_index",
        "The deposit is in the last slot of era E. The branch is a valid path of the anchor state, but for the list position of era E+1 (the state holds the deposit root there too).",
        wrong_era,
        Expected::Reject("InvalidAncestryBranch"),
    ));
    let mut padded = scenario_at(last_slot_of_era);
    padded.proof.ancestryBranch.insert(0, B256::ZERO);
    cases.push(case(
        "reject_historical_padded_branch",
        "The historical ancestryBranch has one extra zero entry; the vault wants the exact length.",
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
    let recent_deposit_slot = (anchor / SLOTS_PER_HISTORICAL_ROOT) * SLOTS_PER_HISTORICAL_ROOT - 300;
    let mut historical_gindex = scenario_at(recent_deposit_slot);
    historical_gindex.proof.ancestryBranch =
        historical_gindex.historical_ancestry_branch().expect("the deposit era is complete at the anchor");
    cases.push(case(
        "reject_recent_distance_with_historical_branch",
        "The distance is at most 8192 and the deposit era is complete, but the branch was built with the historical_summaries index (a valid path of the anchor state).",
        historical_gindex,
        Expected::Reject("InvalidAncestryBranch"),
    ));
    cases.push(case(
        "accept_recent_distance_in_a_complete_era",
        "Control for the reverse attack: the same deposit with the recent branch verifies.",
        scenario_at(recent_deposit_slot),
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
        before.proof.depositHeader.slot = first_capella_era_slot - 1;
        cases.push(case(
            "reject_historical_deposit_before_capella_era",
            "The deposit slot is the last slot of era capellaEra - 1. No summary covers it. (The branch is a copy of the honest one; the era check comes first.)",
            before,
            Expected::Reject("DepositBeforeCapella"),
        ));
    }
    cases
}

fn real_receipt_cases() -> Vec<Case> {
    let mut cases = Vec::new();

    // REAL PulseChain beacon path and receipts. No vault exists, so the deposit log checks must reject.
    for name in ["finalized", "ancestor"] {
        let (_, _, block) = real_withdrawal_proof(name, 0, 0);
        let (transaction_index, receipt) = block
            .receipts_json
            .as_array()
            .expect("receipts")
            .iter()
            .enumerate()
            .find(|(_, receipt)| !receipt["logs"].as_array().expect("logs").is_empty())
            .expect("a receipt with logs");
        let emitter = Address::from_slice(&hex_bytes(&receipt["logs"][0]["address"]));
        let (proof, anchor_root, _) = real_withdrawal_proof(name, transaction_index as u64, 0);
        for (suffix, vault, reason, description) in [
            (
                "wrong_emitter",
                Address::repeat_byte(0xee),
                "LogEmitterMismatch",
                "Every beacon, header and receipt check passes on real data; the log is not from the vault.",
            ),
            (
                "not_a_deposit",
                emitter,
                "LogTopicMismatch",
                "The vault address is the real emitter of the log, whose topic is not the deposit topic.",
            ),
        ] {
            cases.push(Case {
                name: format!("real_pulsechain_{name}_block_{suffix}"),
                description: format!("{description} Receipt {transaction_index}, log 0, of a real PulseChain block under a real beacon path."),
                beacon_data: "real",
                receipt_data: "real",
                spec: &PULSECHAIN,
                proof: proof.clone(),
                stored_anchor_root: anchor_root,
                remote_vault: vault,
                local_chain_id: 1,
                expected: Expected::Reject(reason),
            });
        }
    }

    // REAL PulseChain historical path: a block in an older era under a real anchor, through historical_summaries.
    let (_, _, block) = real_historical_withdrawal_proof(0, 0);
    let (transaction_index, receipt) = block
        .receipts_json
        .as_array()
        .expect("receipts")
        .iter()
        .enumerate()
        .find(|(_, receipt)| !receipt["logs"].as_array().expect("logs").is_empty())
        .expect("a receipt with logs");
    let emitter = Address::from_slice(&hex_bytes(&receipt["logs"][0]["address"]));
    let (proof, anchor_root, _) = real_historical_withdrawal_proof(transaction_index as u64, 0);
    for (suffix, vault, reason, description) in [
        (
            "wrong_emitter",
            Address::repeat_byte(0xee),
            "LogEmitterMismatch",
            "Every beacon, header and receipt check passes on real data; the log is not from the vault.",
        ),
        (
            "not_a_deposit",
            emitter,
            "LogTopicMismatch",
            "The vault address is the real emitter of the log, whose topic is not the deposit topic.",
        ),
    ] {
        cases.push(Case {
            name: format!("real_pulsechain_historical_block_{suffix}"),
            description: format!("{description} Receipt {transaction_index}, log 0, of a real PulseChain block in an older era (historical path, 44 entry ancestry branch, the era before the era of the anchor) under a real anchor state."),
            beacon_data: "real",
            receipt_data: "real",
            spec: &PULSECHAIN,
            proof: proof.clone(),
            stored_anchor_root: anchor_root,
            remote_vault: vault,
            local_chain_id: 1,
            expected: Expected::Reject(reason),
        });
    }

    // REAL Ethereum block and receipts under a SYNTHETIC Electra-layout beacon path.
    let block = rebuild_block("ethereum/execution_block.json", "ethereum/block_receipts.json");
    let header_json = load_response("ethereum/execution_block.json");
    let block_number =
        u64::from_str_radix(header_json["number"].as_str().expect("number").trim_start_matches("0x"), 16)
            .expect("number");
    let (transaction_index, receipt) = block
        .receipts_json
        .as_array()
        .expect("receipts")
        .iter()
        .enumerate()
        .find(|(_, receipt)| !receipt["logs"].as_array().expect("logs").is_empty() && receipt["type"] == "0x2")
        .expect("a type 2 receipt with logs");
    let emitter = Address::from_slice(&hex_bytes(&receipt["logs"][0]["address"]));
    let evidence = ExecutionBlockEvidence {
        header_rlp: block.header_rlp.clone(),
        block_number,
        receipts_root: block.rebuilt_root,
        receipt_proof: block.proofs[transaction_index].clone(),
    };
    let scenario =
        assemble_withdrawal(&ETHEREUM_MAINNET, &evidence, transaction_index as u64, 0, 15_476_000, 15_476_500);
    for (suffix, vault, reason, description) in [
        (
            "wrong_emitter",
            Address::repeat_byte(0xee),
            "LogEmitterMismatch",
            "The real type 2 receipt is proven and decoded; the log is not from the vault.",
        ),
        (
            "not_a_deposit",
            emitter,
            "LogTopicMismatch",
            "The vault address is the real emitter of the log, whose topic is not the deposit topic.",
        ),
    ] {
        cases.push(Case {
            name: format!("real_ethereum_receipt_{suffix}"),
            description: format!("{description} Receipt {transaction_index}, log 0, of a real Ethereum block (Prague header) under a synthetic Electra-layout beacon path."),
            beacon_data: "synthetic",
            receipt_data: "real",
            spec: &ETHEREUM_MAINNET,
            proof: scenario.proof.clone(),
            stored_anchor_root: scenario.stored_anchor_root,
            remote_vault: vault,
            local_chain_id: 369,
            expected: Expected::Reject(reason),
        });
    }
    cases
}

/// All withdrawal fixtures as `(file stem, JSON)`.
pub fn withdrawal_fixtures() -> Vec<(String, Value)> {
    let mut cases = synthetic_cases(&PULSECHAIN, "capella", 1, 10_900_000);
    cases.extend(synthetic_cases(&ETHEREUM_MAINNET, "electra", 369, 15_500_000));
    cases.extend(real_receipt_cases());
    cases.into_iter().map(render).collect()
}

/// Checks one fixture value (read from disk) with the Rust verifier: it decodes the calldata and compares the outcome.
///
/// # Panics
/// Panics with the fixture name when the Rust outcome differs from the declared outcome.
pub fn check_fixture_with_verifier(fixture: &Value) {
    let name = fixture["name"].as_str().expect("name");
    let spec: &ChainSpec = if fixture["chain"] == "pulsechain" { &PULSECHAIN } else { &ETHEREUM_MAINNET };
    let calldata = hex_bytes(&fixture["calldata"]);
    let proof = withdrawCall::abi_decode(&calldata).unwrap_or_else(|error| panic!("{name}: {error}")).proof;
    let context = WithdrawalContext {
        remote_vault: Address::from_slice(&hex_bytes(&fixture["remoteVault"])),
        local_chain_id: fixture["localChainId"].as_str().expect("chain").parse().expect("chain"),
        stored_anchor_root: crate::json::hex_b256(&fixture["storedAnchorHeaderRoot"]),
    };
    let outcome = verify_withdrawal(&proof, &context, spec);
    let expected = &fixture["expected"];
    match (expected["result"].as_str(), outcome) {
        (Some("accept"), Ok(deposit)) => assert_eq!(deposit_json(&deposit), expected["deposit"], "{name}"),
        (Some("reject"), Err(error)) => {
            assert_eq!(error.reason_code(), expected["reason"].as_str().expect("reason"), "{name}: {error}")
        }
        (declared, other) => panic!("{name}: declared {declared:?} but the verifier returned {other:?}"),
    }
}
