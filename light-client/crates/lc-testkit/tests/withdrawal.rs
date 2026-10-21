//! `verify_withdrawal` on SYNTHETIC beacon chains and receipts for both layouts (Capella for PulseChain, Electra for
//! Ethereum). The receipts trie, the header RLP and the SSZ branches are built by the test-only builders in
//! `lc_testkit::synthetic`. Real-data coverage of the same function is in `pulsechain_real.rs` and `receipts_real.rs`.
//!
//! Each rejection test also shows the honest path passes (control).

use alloy_primitives::{address, b256, Address, Bytes, B256, U256};
use alloy_sol_types::SolCall;
use lc_core::abi::{withdrawCall, WithdrawalProof};
use lc_core::chain::{ChainSpec, ETHEREUM_MAINNET, PULSECHAIN};
use lc_core::execution::Log;
use lc_core::withdrawal::{verify_withdrawal, VerifiedDeposit, WithdrawalContext};
use lc_core::Error;
use lc_testkit::synthetic::{build_withdrawal, deposit_log, DepositFields, ReceiptSpec, WithdrawalScenario};

const VAULT: Address = address!("00000000000000000000000000000000000000a1");
/// The verifying vault on the destination chain.
const LOCAL_VAULT: Address = address!("00000000000000000000000000000000000000b1");
const ATTACKER: Address = address!("00000000000000000000000000000000000000ee");

fn fields(nonce_byte: u8, amount: u64) -> DepositFields {
    DepositFields {
        token: address!("00000000000000000000000000000000000000b2"),
        sender: address!("00000000000000000000000000000000000000c3"),
        recipient: address!("00000000000000000000000000000000000000d4"),
        amount,
        nonce: B256::repeat_byte(nonce_byte),
        target_chain_id: 369,
        destination_vault: LOCAL_VAULT,
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
/// 0: type 2, success, one unrelated log.
/// 1: type 0 (legacy), success: log 0 deposit A, log 1 unrelated, log 2 deposit B, log 3 deposit emitted by an attacker,
///    log 4 a log with the revision 2 topic from the vault.
/// 2: type 2, FAILED, with a deposit log.
fn receipts(target_chain_id: u64) -> Vec<ReceiptSpec> {
    let with_target =
        |nonce: u8, amount: u64| deposit_log(VAULT, &DepositFields { target_chain_id, ..fields(nonce, amount) });
    let revision_two_topic = Log {
        address: VAULT,
        topics: vec![b256!("2df93605658e38812f86230cb85b0d0c35583b27b9c9769f36b6fbfda3d8c1ee")],
        data: Bytes::new(),
    };
    vec![
        ReceiptSpec { transaction_type: 2, success: true, logs: vec![unrelated_log()] },
        ReceiptSpec {
            transaction_type: 0,
            success: true,
            logs: vec![
                with_target(0xa1, 1_000),
                unrelated_log(),
                with_target(0xb2, 2_000),
                deposit_log(ATTACKER, &DepositFields { target_chain_id, ..fields(0xc3, 3_000) }),
                revision_two_topic,
            ],
        },
        ReceiptSpec { transaction_type: 2, success: false, logs: vec![with_target(0xd4, 4_000)] },
    ]
}

/// (spec, deposit slot, anchor slot, local chain identifier of the verifier)
fn layouts() -> Vec<(&'static ChainSpec, u64, u64, u64)> {
    vec![(&PULSECHAIN, 10_872_000, 10_872_500, 1), (&ETHEREUM_MAINNET, 15_476_000, 15_476_500, 369)]
}

fn context(scenario: &WithdrawalScenario, local_chain_id: u64) -> WithdrawalContext {
    WithdrawalContext {
        remote_vault: VAULT,
        local_vault: LOCAL_VAULT,
        local_chain_id,
        stored_anchor_root: scenario.stored_anchor_root,
    }
}

fn scenario_for(
    spec: &'static ChainSpec,
    deposit_slot: u64,
    anchor_slot: u64,
    local: u64,
    tx: u64,
    log: u64,
) -> WithdrawalScenario {
    // The deposit log names the verifying chain as its target.
    build_withdrawal(spec, &receipts(local), tx, log, deposit_slot, anchor_slot)
}

/// Claim: an honest withdrawal verifies on both layouts, for a legacy (type 0) and a dynamic fee (type 2) receipt, and
/// returns the exact deposit fields and the deposit block hash.
#[test]
fn synthetic_honest_withdrawal_verifies_on_both_layouts() {
    for (spec, deposit_slot, anchor_slot, local) in layouts() {
        let scenario = scenario_for(spec, deposit_slot, anchor_slot, local, 1, 0);
        let deposit = verify_withdrawal(&scenario.proof, &context(&scenario, local), spec).expect("honest");
        let expected = fields(0xa1, 1_000);
        assert_eq!(
            deposit,
            VerifiedDeposit {
                token: expected.token,
                sender: expected.sender,
                recipient: expected.recipient,
                amount: U256::from(1_000u64),
                nonce: expected.nonce,
                target_chain_id: local,
                destination_vault: LOCAL_VAULT,
                deposit_block_hash: scenario.deposit_block_hash,
            }
        );
    }
}

/// Claim: a second deposit in the same receipt is proven by its own log index (defect R2-06: revision 2 could only prove the
/// first matching log and panicked otherwise). Log 2 returns deposit B, not deposit A.
#[test]
fn synthetic_second_deposit_in_the_same_receipt_is_picked_by_log_index() {
    for (spec, deposit_slot, anchor_slot, local) in layouts() {
        let first = scenario_for(spec, deposit_slot, anchor_slot, local, 1, 0);
        let second = scenario_for(spec, deposit_slot, anchor_slot, local, 1, 2);
        let a = verify_withdrawal(&first.proof, &context(&first, local), spec).unwrap();
        let b = verify_withdrawal(&second.proof, &context(&second, local), spec).expect("second deposit must succeed");
        assert_eq!(a.nonce, B256::repeat_byte(0xa1));
        assert_eq!(b.nonce, B256::repeat_byte(0xb2));
        assert_eq!(b.amount, U256::from(2_000u64));
        assert_eq!(a.deposit_block_hash, b.deposit_block_hash, "same block");
    }
}

/// Claim: a failed-status receipt is refused even when it holds a perfect deposit log (the vault never saw the tokens).
#[test]
fn synthetic_failed_receipt_is_refused() {
    for (spec, deposit_slot, anchor_slot, local) in layouts() {
        let scenario = scenario_for(spec, deposit_slot, anchor_slot, local, 2, 0);
        assert_eq!(verify_withdrawal(&scenario.proof, &context(&scenario, local), spec), Err(Error::ReceiptFailed));
    }
}

/// Claim: log checks. A log from another emitter (H-02), a wrong log index, a log that is not a deposit, a log with the
/// revision 2 topic, a deposit aimed at another chain, and a deposit addressed to another vault are each refused for the right reason.
#[test]
fn synthetic_log_rules() {
    for (spec, deposit_slot, anchor_slot, local) in layouts() {
        let check = |tx: u64, log: u64| {
            let scenario = scenario_for(spec, deposit_slot, anchor_slot, local, tx, log);
            verify_withdrawal(&scenario.proof, &context(&scenario, local), spec)
        };
        assert!(check(1, 0).is_ok(), "control");
        assert_eq!(check(1, 3), Err(Error::LogEmitterMismatch), "deposit-shaped log from another emitter");
        assert_eq!(check(1, 1), Err(Error::LogEmitterMismatch), "unrelated contract");
        assert_eq!(check(1, 4), Err(Error::LogTopicMismatch), "revision 2 topic from the vault");
        assert_eq!(check(1, 5), Err(Error::LogIndexOutOfRange { index: 5, logs: 5 }));
        assert_eq!(check(1, u64::MAX), Err(Error::LogIndexOutOfRange { index: u64::MAX, logs: 5 }));

        let scenario = scenario_for(spec, deposit_slot, anchor_slot, local, 1, 0);
        let other_chain = WithdrawalContext { local_chain_id: 31337, ..context(&scenario, local) };
        assert_eq!(
            verify_withdrawal(&scenario.proof, &other_chain, spec),
            Err(Error::TargetChainMismatch { target_chain_id: local })
        );
        // The same deposit, checked by a vault it is not addressed to: the chain matches, the vault does not.
        let other_local_vault = WithdrawalContext { local_vault: ATTACKER, ..context(&scenario, local) };
        assert_eq!(
            verify_withdrawal(&scenario.proof, &other_local_vault, spec),
            Err(Error::DestinationVaultMismatch { destination_vault: LOCAL_VAULT })
        );
        let other_vault = WithdrawalContext { remote_vault: ATTACKER, ..context(&scenario, local) };
        assert_eq!(verify_withdrawal(&scenario.proof, &other_vault, spec), Err(Error::LogEmitterMismatch));
    }
}

/// Claim: the path follows the distance, and the edge is exact. A deposit 8192 slots before the anchor takes the recent
/// path, 8193 takes the historical path, and both verify. The anchor slot itself and a later slot fail.
/// Why it matters: the vault picks the path, never the prover, so the edge must sit on one side only.
#[test]
fn synthetic_path_follows_the_distance_at_the_edge() {
    use lc_core::ancestry::{ancestry_path_for_slots, AncestryPath};
    for (spec, _, _, local) in layouts() {
        let anchor_slot = if spec.name == "pulsechain" { 10_900_000 } else { 15_500_000 };
        let recent = scenario_for(spec, anchor_slot - 8192, anchor_slot, local, 1, 0);
        assert_eq!(ancestry_path_for_slots(anchor_slot, anchor_slot - 8192), Ok(AncestryPath::Recent));
        assert!(verify_withdrawal(&recent.proof, &context(&recent, local), spec).is_ok(), "exactly 8192 slots back");
        let historical = scenario_for(spec, anchor_slot - 8193, anchor_slot, local, 1, 0);
        assert_eq!(ancestry_path_for_slots(anchor_slot, anchor_slot - 8193), Ok(AncestryPath::Historical));
        assert!(verify_withdrawal(&historical.proof, &context(&historical, local), spec).is_ok(), "8193 slots back");
        // The two honest branches differ in length: 18 or 19 on the recent path, 44 or 45 on the historical path.
        let (recent_length, historical_length) = if spec.name == "pulsechain" { (18, 44) } else { (19, 45) };
        assert_eq!(recent.proof.ancestryBranch.len(), recent_length);
        assert_eq!(historical.proof.ancestryBranch.len(), historical_length);
        for deposit_slot in [anchor_slot, anchor_slot + 1] {
            let scenario = scenario_for(spec, deposit_slot, anchor_slot, local, 1, 0);
            assert_eq!(
                verify_withdrawal(&scenario.proof, &context(&scenario, local), spec),
                Err(Error::DepositNotBeforeAnchor { anchor_slot, deposit_slot }),
                "deposit slot {deposit_slot}"
            );
        }
    }
}

/// Claim: at an era edge each side uses its own list position. The last slot of era E uses index E - capellaEra, the first
/// slot of era E + 1 uses the next index, both verify, and swapping the two branches fails.
/// Why it matters: the synthetic anchor state holds each deposit root in the neighbouring eras too, so the swap is a
/// valid Merkle path and only an off-by-one in the index would let it through.
#[test]
fn synthetic_historical_era_edges_use_their_own_index() {
    for (spec, _, _, local) in layouts() {
        let anchor_slot = if spec.name == "pulsechain" { 10_900_000 } else { 15_500_000 };
        let era = anchor_slot / 8192 - 4;
        let last = scenario_for(spec, (era + 1) * 8192 - 1, anchor_slot, local, 1, 0);
        let first = scenario_for(spec, (era + 1) * 8192, anchor_slot, local, 1, 0);
        for scenario in [&last, &first] {
            assert!(verify_withdrawal(&scenario.proof, &context(scenario, local), spec).is_ok(), "control");
        }
        let capella_era = spec.capella_era().unwrap();
        let last_index = (era - capella_era) as usize;
        assert!(
            last.anchor_state.has_historical_era(last_index) && last.anchor_state.has_historical_era(last_index + 1)
        );
        let wrong_for_last = last.historical_ancestry_branch_for_era(era + 1).expect("neighbour exists");
        let mut swapped = last.proof.clone();
        swapped.ancestryBranch = wrong_for_last;
        assert_eq!(verify_withdrawal(&swapped, &context(&last, local), spec), Err(Error::InvalidAncestryBranch));
        let wrong_for_first = first.historical_ancestry_branch_for_era(era).expect("neighbour exists");
        let mut swapped = first.proof.clone();
        swapped.ancestryBranch = wrong_for_first;
        assert_eq!(verify_withdrawal(&swapped, &context(&first, local), spec), Err(Error::InvalidAncestryBranch));
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
        assert!(verify_withdrawal(&scenario.proof, &ctx, spec).is_ok(), "control");
        let mut proof = scenario.proof.clone();
        proof.ancestryBranch.insert(0, B256::ZERO);
        assert_eq!(verify_withdrawal(&proof, &ctx, spec), Err(Error::InvalidAncestryBranch), "padded at the front");
        let mut proof = scenario.proof.clone();
        proof.ancestryBranch.push(B256::ZERO);
        assert_eq!(verify_withdrawal(&proof, &ctx, spec), Err(Error::InvalidAncestryBranch), "padded at the back");
        let mut proof = scenario.proof.clone();
        proof.ancestryBranch.pop();
        assert_eq!(verify_withdrawal(&proof, &ctx, spec), Err(Error::InvalidAncestryBranch), "short");
        for position in 0..scenario.proof.ancestryBranch.len() {
            let mut proof = scenario.proof.clone();
            proof.ancestryBranch[position].0[5] ^= 1;
            assert_eq!(verify_withdrawal(&proof, &ctx, spec), Err(Error::InvalidAncestryBranch), "entry {position}");
        }
    }
}

/// Claim: a branch built for the other path is refused in both directions. The anchor state holds the deposit root at
/// both places, so each branch is a valid path of the state. Historical distance with the block_roots branch fails, and
/// recent distance with the historical branch fails.
#[test]
fn synthetic_path_mixups_are_refused_in_both_directions() {
    for (spec, _, _, local) in layouts() {
        let anchor_slot = if spec.name == "pulsechain" { 10_900_000 } else { 15_500_000 };
        let far = scenario_for(spec, anchor_slot - 20_000, anchor_slot, local, 1, 0);
        let mut proof = far.proof.clone();
        proof.ancestryBranch = far.recent_ancestry_branch();
        assert_eq!(verify_withdrawal(&proof, &context(&far, local), spec), Err(Error::InvalidAncestryBranch));
        // Control: the recent branch is a real path of that state, it proves the same header root at the block_roots index.
        let state_root = far.proof.anchorHeader.stateRoot;
        let deposit: lc_core::types::BeaconBlockHeader = (&far.proof.depositHeader).into();
        let layout = lc_core::layout::state_layout_for_fork(spec.fork_at_slot(anchor_slot)).unwrap();
        let recent_gindex = lc_core::ancestry::block_roots_leaf_gindex(layout.block_roots_gindex, deposit.slot);
        assert!(lc_core::ssz::is_valid_exact_branch(
            &deposit.hash_tree_root(),
            &proof.ancestryBranch,
            recent_gindex,
            &state_root
        ));

        let near_slot = (anchor_slot / 8192) * 8192 - 300;
        let near = scenario_for(spec, near_slot, anchor_slot, local, 1, 0);
        assert!(verify_withdrawal(&near.proof, &context(&near, local), spec).is_ok(), "control");
        let mut proof = near.proof.clone();
        proof.ancestryBranch = near.historical_ancestry_branch().expect("deposit era is complete");
        assert_eq!(verify_withdrawal(&proof, &context(&near, local), spec), Err(Error::InvalidAncestryBranch));
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
        assert!(verify_withdrawal(&first.proof, &context(&first, local), spec).is_ok(), "list position 0");
        assert_eq!(first.proof.ancestryBranch.len(), if spec.name == "pulsechain" { 44 } else { 45 });
        if capella_era == 0 {
            continue;
        }
        let mut before = first.proof.clone();
        before.depositHeader.slot = capella_era * 8192 - 1;
        assert_eq!(
            verify_withdrawal(&before, &context(&first, local), spec),
            Err(Error::DepositBeforeCapella { deposit_era: capella_era - 1, capella_era })
        );
    }
}

/// Claim: every entry of both branches matters, a wrong slot fails, an anchor that the light client does not store fails,
/// a branch with padding fails (exact length), and a swapped header fails.
#[test]
fn synthetic_beacon_path_tampering() {
    for (spec, deposit_slot, anchor_slot, local) in layouts() {
        let scenario = scenario_for(spec, deposit_slot, anchor_slot, local, 1, 0);
        let ctx = context(&scenario, local);
        assert!(verify_withdrawal(&scenario.proof, &ctx, spec).is_ok(), "control");

        for position in 0..scenario.proof.ancestryBranch.len() {
            let mut proof = scenario.proof.clone();
            proof.ancestryBranch[position].0[5] ^= 1;
            assert_eq!(verify_withdrawal(&proof, &ctx, spec), Err(Error::InvalidAncestryBranch), "ancestry {position}");
        }
        for position in 0..scenario.proof.blockHashBranch.len() {
            let mut proof = scenario.proof.clone();
            proof.blockHashBranch[position].0[5] ^= 1;
            assert_eq!(verify_withdrawal(&proof, &ctx, spec), Err(Error::InvalidBlockHashBranch), "hash {position}");
        }
        let mut proof = scenario.proof.clone();
        proof.depositHeader.slot += 1;
        assert_eq!(verify_withdrawal(&proof, &ctx, spec), Err(Error::InvalidAncestryBranch), "wrong slot");

        let mut proof = scenario.proof.clone();
        proof.ancestryBranch.insert(0, B256::ZERO);
        assert_eq!(verify_withdrawal(&proof, &ctx, spec), Err(Error::InvalidAncestryBranch), "padded branch");
        let mut proof = scenario.proof.clone();
        proof.blockHashBranch.pop();
        assert_eq!(verify_withdrawal(&proof, &ctx, spec), Err(Error::InvalidBlockHashBranch), "short branch");

        for stored in [B256::ZERO, B256::repeat_byte(3)] {
            let unknown = WithdrawalContext { stored_anchor_root: stored, ..ctx };
            assert_eq!(verify_withdrawal(&scenario.proof, &unknown, spec), Err(Error::AnchorNotStored));
        }
        let mut proof = scenario.proof.clone();
        proof.anchorHeader.proposerIndex += 1;
        assert_eq!(verify_withdrawal(&proof, &ctx, spec), Err(Error::AnchorNotStored), "changed anchor header");

        let mut proof = scenario.proof.clone();
        let mut rlp = proof.executionHeaderRlp.to_vec();
        rlp[40] ^= 1;
        proof.executionHeaderRlp = rlp.into();
        assert_eq!(
            verify_withdrawal(&proof, &ctx, spec),
            Err(Error::InvalidBlockHashBranch),
            "header RLP no longer hashes to the proven block hash"
        );
    }
}

/// Claim: receipt proof tampering is refused: a damaged node, the proof of another receipt, a wrong transaction index.
#[test]
fn synthetic_receipt_proof_tampering() {
    for (spec, deposit_slot, anchor_slot, local) in layouts() {
        let scenario = scenario_for(spec, deposit_slot, anchor_slot, local, 1, 0);
        let ctx = context(&scenario, local);
        let mut proof = scenario.proof.clone();
        let last = proof.receiptProof.len() - 1;
        let mut node = proof.receiptProof[last].to_vec();
        let middle = node.len() / 2;
        node[middle] ^= 1;
        proof.receiptProof[last] = node.into();
        assert!(matches!(verify_withdrawal(&proof, &ctx, spec), Err(Error::ReceiptProofInvalid(_))));

        let other = scenario_for(spec, deposit_slot, anchor_slot, local, 0, 0);
        let mut proof = scenario.proof.clone();
        proof.receiptProof = other.proof.receiptProof.clone();
        assert!(
            matches!(verify_withdrawal(&proof, &ctx, spec), Err(Error::ReceiptProofInvalid(_))),
            "proof of receipt 0 for index 1"
        );

        let mut proof = scenario.proof.clone();
        proof.transactionIndex = U256::from(2u64);
        assert!(matches!(verify_withdrawal(&proof, &ctx, spec), Err(Error::ReceiptProofInvalid(_))), "wrong index");
        proof.transactionIndex = U256::MAX;
        assert!(
            matches!(verify_withdrawal(&proof, &ctx, spec), Err(Error::ReceiptProofInvalid(_))),
            "index does not fit in 64 bits"
        );
    }
}

/// Claim: the struct survives ABI encoding as calldata of `withdraw(WithdrawalProof)`, the selector is the one
/// that `cast sig` computes, and the decoded calldata verifies the same way.
#[test]
fn synthetic_calldata_roundtrip_and_selector() {
    assert_eq!(withdrawCall::SELECTOR, [0x30, 0x56, 0x8d, 0x83], "selector from `cast sig` of the full signature");
    for (spec, deposit_slot, anchor_slot, local) in layouts() {
        let scenario = scenario_for(spec, deposit_slot, anchor_slot, local, 1, 2);
        let calldata = withdrawCall { proof: scenario.proof.clone() }.abi_encode();
        assert_eq!(&calldata[..4], &withdrawCall::SELECTOR);
        let decoded: WithdrawalProof = withdrawCall::abi_decode(&calldata).expect("decode").proof;
        assert_eq!(decoded, scenario.proof);
        assert!(verify_withdrawal(&decoded, &context(&scenario, local), spec).is_ok());
    }
}

/// Claim: a deposit addressed to another vault is refused, and the same deposit passes at the vault it names.
/// Why it matters: the source vault stamps the intended destination vault into the event. Without this check, a deposit
/// meant for one destination vault could be replayed against any other vault that trusts the same source vault.
#[test]
fn synthetic_deposit_addressed_to_another_vault_is_refused() {
    let other_destination_vault = address!("00000000000000000000000000000000000000b9");
    for (spec, deposit_slot, anchor_slot, local) in layouts() {
        let addressed_elsewhere = vec![ReceiptSpec {
            transaction_type: 2,
            success: true,
            logs: vec![deposit_log(
                VAULT,
                &DepositFields {
                    target_chain_id: local,
                    destination_vault: other_destination_vault,
                    ..fields(0xa1, 1_000)
                },
            )],
        }];
        let scenario = build_withdrawal(spec, &addressed_elsewhere, 0, 0, deposit_slot, anchor_slot);
        let at_named_vault = WithdrawalContext { local_vault: other_destination_vault, ..context(&scenario, local) };
        let deposit =
            verify_withdrawal(&scenario.proof, &at_named_vault, spec).expect("control: the named vault accepts");
        assert_eq!(deposit.destination_vault, other_destination_vault);
        assert_eq!(
            verify_withdrawal(&scenario.proof, &context(&scenario, local), spec),
            Err(Error::DestinationVaultMismatch { destination_vault: other_destination_vault })
        );
    }
}

/// Claim: the chain check runs before the vault check, so a deposit that fails both reports the chain.
/// Why it matters: the order is part of the contract that the Solidity vault and its fixtures share.
#[test]
fn synthetic_target_chain_is_checked_before_destination_vault() {
    for (spec, deposit_slot, anchor_slot, local) in layouts() {
        let scenario = scenario_for(spec, deposit_slot, anchor_slot, local, 1, 0);
        let both_wrong =
            WithdrawalContext { local_chain_id: 31337, local_vault: ATTACKER, ..context(&scenario, local) };
        assert_eq!(
            verify_withdrawal(&scenario.proof, &both_wrong, spec),
            Err(Error::TargetChainMismatch { target_chain_id: local })
        );
    }
}
