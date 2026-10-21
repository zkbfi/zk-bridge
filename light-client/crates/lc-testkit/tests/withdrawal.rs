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
const ATTACKER: Address = address!("00000000000000000000000000000000000000ee");

fn fields(nonce_byte: u8, amount: u64) -> DepositFields {
    DepositFields {
        token: address!("00000000000000000000000000000000000000b2"),
        sender: address!("00000000000000000000000000000000000000c3"),
        recipient: address!("00000000000000000000000000000000000000d4"),
        amount,
        nonce: B256::repeat_byte(nonce_byte),
        target_chain_id: 369,
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
    WithdrawalContext { remote_vault: VAULT, local_chain_id, stored_anchor_root: scenario.stored_anchor_root }
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
/// revision 2 topic, and a deposit aimed at another chain are each refused for the right reason.
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
        let other_vault = WithdrawalContext { remote_vault: ATTACKER, ..context(&scenario, local) };
        assert_eq!(verify_withdrawal(&scenario.proof, &other_vault, spec), Err(Error::LogEmitterMismatch));
    }
}

/// Claim: the 8192-slot window is exact. A deposit 8192 slots before the anchor passes, 8193 fails with the documented
/// error, and the anchor slot itself or a later slot fails.
#[test]
fn synthetic_historical_window_is_exact() {
    for (spec, _, _, local) in layouts() {
        let anchor_slot = if spec.name == "pulsechain" { 10_900_000 } else { 15_500_000 };
        let ok = scenario_for(spec, anchor_slot - 8192, anchor_slot, local, 1, 0);
        assert!(verify_withdrawal(&ok.proof, &context(&ok, local), spec).is_ok(), "exactly 8192 slots back");
        for deposit_slot in [anchor_slot - 8193, anchor_slot, anchor_slot + 1] {
            let scenario = scenario_for(spec, deposit_slot, anchor_slot, local, 1, 0);
            assert_eq!(
                verify_withdrawal(&scenario.proof, &context(&scenario, local), spec),
                Err(Error::DepositOutsideHistoricalWindow { anchor_slot, deposit_slot }),
                "deposit slot {deposit_slot}"
            );
        }
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

        for position in 0..scenario.proof.blockRootsBranch.len() {
            let mut proof = scenario.proof.clone();
            proof.blockRootsBranch[position].0[5] ^= 1;
            assert_eq!(verify_withdrawal(&proof, &ctx, spec), Err(Error::InvalidBlockRootsBranch), "roots {position}");
        }
        for position in 0..scenario.proof.blockHashBranch.len() {
            let mut proof = scenario.proof.clone();
            proof.blockHashBranch[position].0[5] ^= 1;
            assert_eq!(verify_withdrawal(&proof, &ctx, spec), Err(Error::InvalidBlockHashBranch), "hash {position}");
        }
        let mut proof = scenario.proof.clone();
        proof.depositHeader.slot += 1;
        assert_eq!(verify_withdrawal(&proof, &ctx, spec), Err(Error::InvalidBlockRootsBranch), "wrong slot");

        let mut proof = scenario.proof.clone();
        proof.blockRootsBranch.insert(0, B256::ZERO);
        assert_eq!(verify_withdrawal(&proof, &ctx, spec), Err(Error::InvalidBlockRootsBranch), "padded branch");
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
