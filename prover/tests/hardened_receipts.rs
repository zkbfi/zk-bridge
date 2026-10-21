//! Hardened two-chain tests of receipts: typed transactions (R2-05) and several deposits in one transaction (R2-06).

mod common;

use alloy_primitives::{B256, U256};
use alloy_sol_types::SolCall;
use common::bridge::*;
use common::multicall::{batch_calldata, creation_code};
use common::*;
use zk_bridge_prover::contracts::{deposit_calldata, TokenContract};

/// Claim: the receipt of a typed transaction (EIP-1559, type 2) withdraws, as do the receipts of a type 1 and a legacy
/// transaction.
/// Shows: three deposits are sent as type 2, type 1 and type 0 transactions, and the receipts report those types. The
/// receipt trie stores a typed receipt as `type byte ‖ rlp(receipt)`. The service builds the proof, the vault decodes the
/// envelope, and all three recipients are paid. The legacy deposit is the control: it works with or without envelope
/// support, so a failure of only the typed ones would point at the envelope.
/// Why it matters: R2-05. Revision 2 read every receipt as a bare list. Nearly all deposits on Ethereum are type 2
/// transactions, so a vault with that defect could not pay almost any of them.
#[test]
fn r2_05_hardened_typed_transaction_receipts_withdraw() {
    if !tools_available() {
        return;
    }
    let bridge = deploy_bridge("r2-05-typed");
    fund_destination_vault(&bridge, Direction::AToB, 1_000 * ONE_TOKEN);
    let chain = &bridge.chain_a;
    chain.send(
        Some(bridge.token_a),
        &TokenContract::mintCall {
            to: DEPLOYER,
            amount: U256::from(30 * ONE_TOKEN),
        }
        .abi_encode(),
    );
    chain.send(
        Some(bridge.token_a),
        &TokenContract::approveCall {
            spender: bridge.vault_a,
            amount: U256::from(30 * ONE_TOKEN),
        }
        .abi_encode(),
    );

    let mut made = Vec::new();
    for (transaction_type, amount) in [(2u8, ONE_TOKEN), (1, 2 * ONE_TOKEN), (0, 4 * ONE_TOKEN)] {
        let evidence = gate_evidence(chain, bridge.gate_a);
        let calldata =
            deposit_calldata(bridge.token_a, RECIPIENT, U256::from(amount), 0, &evidence);
        let receipt = chain.send_typed(bridge.vault_a, &calldata, transaction_type);
        assert_eq!(
            receipt["type"].as_str().unwrap(),
            format!("{transaction_type:#x}"),
            "the chain mined a type {transaction_type} transaction"
        );
        made.push((transaction_type, amount, made_deposit(receipt)));
    }

    chain.mine(2);
    run(&bridge, &["once"]).expect("once");

    let mut expected = U256::ZERO;
    for (transaction_type, amount, deposit) in &made {
        assert!(
            claimed(&bridge.chain_b, bridge.vault_b, deposit.nonce),
            "type {transaction_type}: the nonce is claimed"
        );
        assert_eq!(
            state_of(&bridge, deposit.nonce),
            "confirmed",
            "type {transaction_type}"
        );
        expected += U256::from(*amount);
    }
    assert_eq!(
        balance(&bridge.chain_b, bridge.token_b, RECIPIENT),
        expected,
        "every typed deposit paid its own amount"
    );
}

/// Claim: two deposits in one transaction both withdraw, each by its own log index, and a second claim of either
/// reverts as already claimed.
/// Shows: a batch contract (assembled from opcodes) mints, approves and deposits twice with different amounts in ONE
/// transaction, so the receipt has two deposit logs after other logs. The two nonces differ. The manual `withdraw` with
/// each log index pays that log's amount and no other. A second withdrawal of either log reverts with
/// `AlreadyClaimed(nonce)` for the nonce of that log. A log index of an ordinary token transfer reverts with
/// `WrongEmitter` (the token is not the vault), which shows that the index, and not the first matching log, chooses
/// the deposit.
/// Why it matters: R2-06. Revision 2 proved only the first matching log of a receipt and panicked on others, so a second
/// deposit in the same transaction could never be paid, and its tokens stayed locked.
#[test]
fn r2_06_hardened_two_deposits_in_one_transaction_both_withdraw_by_log_index() {
    if !tools_available() {
        return;
    }
    let bridge = deploy_bridge("r2-06-two-deposits");
    fund_destination_vault(&bridge, Direction::AToB, 1_000 * ONE_TOKEN);
    let chain = &bridge.chain_a;
    settle_in_epoch(chain, bridge.gate_a);
    let batch = chain.send(None, &creation_code())["contractAddress"]
        .as_str()
        .unwrap()
        .parse()
        .unwrap();
    let (first_amount, second_amount) = (4 * ONE_TOKEN, 6 * ONE_TOKEN);

    // The batch contract is the depositor. The first deposit carries the fork proof of the epoch, the second needs none.
    let evidence = gate_evidence(chain, bridge.gate_a);
    let total = U256::from(first_amount + second_amount);
    let calls = vec![
        (
            bridge.token_a,
            TokenContract::mintCall {
                to: batch,
                amount: total,
            }
            .abi_encode(),
        ),
        (
            bridge.token_a,
            TokenContract::approveCall {
                spender: bridge.vault_a,
                amount: total,
            }
            .abi_encode(),
        ),
        (
            bridge.vault_a,
            deposit_calldata(
                bridge.token_a,
                RECIPIENT,
                U256::from(first_amount),
                0,
                &evidence,
            )
            .to_vec(),
        ),
        (
            bridge.vault_a,
            deposit_calldata(bridge.token_a, RECIPIENT, U256::from(second_amount), 0, &[]).to_vec(),
        ),
    ];
    let receipt = chain.send(Some(batch), &batch_calldata(&calls));
    let indices = deposit_log_indices(&receipt);
    assert_eq!(indices.len(), 2, "two deposit logs in one receipt");
    assert!(indices[0] > 0, "the first deposit log is not the first log");
    let transaction: B256 = receipt["transactionHash"]
        .as_str()
        .unwrap()
        .parse()
        .unwrap();
    let nonces = [
        deposit_nonce_at(&receipt, indices[0]),
        deposit_nonce_at(&receipt, indices[1]),
    ];
    assert_ne!(nonces[0], nonces[1]);
    chain.mine(2);

    // Both withdraw, each by its own log index, and each pays its own amount.
    let recipient_balance = || balance(&bridge.chain_b, bridge.token_b, RECIPIENT);
    run(
        &bridge,
        &[
            "withdraw",
            "--tx",
            &format!("{transaction:#x}"),
            "--log-index",
            &indices[0].to_string(),
        ],
    )
    .expect("first log");
    assert_eq!(
        recipient_balance(),
        U256::from(first_amount),
        "the first log paid the first amount"
    );
    assert!(
        claimed(&bridge.chain_b, bridge.vault_b, nonces[0])
            && !claimed(&bridge.chain_b, bridge.vault_b, nonces[1])
    );
    run(
        &bridge,
        &[
            "withdraw",
            "--tx",
            &format!("{transaction:#x}"),
            "--log-index",
            &indices[1].to_string(),
        ],
    )
    .expect("second log");
    assert_eq!(
        recipient_balance(),
        U256::from(first_amount + second_amount),
        "the second log paid the second amount"
    );
    assert!(claimed(&bridge.chain_b, bridge.vault_b, nonces[1]));

    // A second claim of either log reverts as already claimed, with the nonce of that log.
    for (position, index) in indices.iter().enumerate() {
        let calldata =
            unchecked_withdrawal_calldata(&bridge, Direction::AToB, transaction, *index as u64);
        let error = bridge
            .chain_b
            .call(bridge.vault_b, &calldata)
            .expect_err("a second claim must revert");
        let data = error.revert_data().expect("revert data");
        assert_eq!(
            data[..4],
            error_selector("AlreadyClaimed(bytes32)"),
            "log {index}"
        );
        assert_eq!(
            data[4..36],
            nonces[position].0,
            "the revert names the nonce of log {index}"
        );
    }
    // The service treats a repeated claim as success and sends nothing.
    let sent_before = bridge.chain_b.nonce(DEPLOYER);
    run(
        &bridge,
        &[
            "withdraw",
            "--tx",
            &format!("{transaction:#x}"),
            "--log-index",
            &indices[0].to_string(),
        ],
    )
    .expect("repeat");
    assert_eq!(
        bridge.chain_b.nonce(DEPLOYER),
        sent_before,
        "no transaction for a deposit that is already paid"
    );
    assert_eq!(
        recipient_balance(),
        U256::from(first_amount + second_amount),
        "nothing paid twice"
    );

    // The index chooses the log: log 0 is the token transfer of the mint, which the vault did not emit.
    let not_a_deposit = unchecked_withdrawal_calldata(&bridge, Direction::AToB, transaction, 0);
    assert_eq!(
        revert_selector(&bridge.chain_b, bridge.vault_b, &not_a_deposit),
        Some(error_selector("WrongEmitter(address,address)"))
    );
    // A log index past the end of the receipt is refused too.
    let past_the_end = unchecked_withdrawal_calldata(&bridge, Direction::AToB, transaction, 99);
    assert_eq!(
        revert_selector(&bridge.chain_b, bridge.vault_b, &past_the_end),
        Some(error_selector("LogIndexOutOfRange(uint256,uint256)"))
    );
}
