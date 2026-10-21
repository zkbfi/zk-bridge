//! Hardened two-chain tests: the honest path, in both directions, with balances checked on both sides, and the
//! measured gas of the pieces (light-client update, withdrawal, gated deposits).
//!
//! These tests are the control for every other hardened test file: each defense test claims "the attack is refused, and
//! the honest path still works", and this file shows the honest path on its own.

mod common;

use alloy_primitives::{Address, U256};
use alloy_sol_types::SolCall;
use common::bridge::*;
use common::*;
use zk_bridge_prover::contracts::{deposit_calldata, TokenContract, VaultContract};

/// Claim: a deposit on chain 1 reaches chain 369, and a deposit on chain 369 reaches chain 1, with every balance on
/// both sides moving by exactly the amount.
/// Shows: the depositor loses the amount and the source vault holds it; the recipient gains the amount and the
/// destination vault pays it; the vault of the destination marks the nonce as claimed; the service reports `confirmed`.
/// Why it matters: this is the whole product. Every defense in the other files is worthless if the honest path is
/// broken, and a test of balances on both sides catches a bridge that moves one side only.
#[test]
fn happy_path_both_directions_move_balances_on_both_sides() {
    if !tools_available() {
        return;
    }
    let bridge = deploy_bridge("happy-both-ways");
    for direction in [Direction::AToB, Direction::BToA] {
        fund_destination_vault(&bridge, direction, 1_000 * ONE_TOKEN);
    }
    let amount = 7 * ONE_TOKEN;

    for direction in [Direction::AToB, Direction::BToA] {
        let (source, destination) = (bridge.source(direction), bridge.destination(direction));
        let (source_token, destination_token) = (
            bridge.source_token(direction),
            bridge.destination_token(direction),
        );
        let (source_vault, destination_vault) = (
            bridge.source_vault(direction),
            bridge.destination_vault(direction),
        );

        let recipient_before = balance(destination, destination_token, RECIPIENT);
        let destination_vault_before = balance(destination, destination_token, destination_vault);
        let source_vault_before = balance(source, source_token, source_vault);

        let made = deposit_on(&bridge, direction, amount);
        // The depositor minted `amount` and deposited all of it, so the depositor ends with nothing.
        assert_eq!(
            balance(source, source_token, DEPLOYER),
            U256::ZERO,
            "{direction:?}: the depositor gave the amount"
        );
        assert_eq!(
            balance(source, source_token, source_vault),
            source_vault_before + U256::from(amount),
            "{direction:?}: the source vault locks it"
        );
        // Before the service runs, nothing has moved on the destination.
        assert_eq!(
            balance(destination, destination_token, RECIPIENT),
            recipient_before
        );
        assert!(!claimed(destination, destination_vault, made.nonce));

        source.mine(2);
        run(&bridge, &["once"]).expect("once");

        assert_eq!(
            balance(destination, destination_token, RECIPIENT),
            recipient_before + U256::from(amount),
            "{direction:?}: the recipient is paid"
        );
        assert_eq!(
            balance(destination, destination_token, destination_vault),
            destination_vault_before - U256::from(amount),
            "{direction:?}: the destination vault pays from its own balance"
        );
        assert!(
            claimed(destination, destination_vault, made.nonce),
            "{direction:?}: the nonce is claimed"
        );
        assert_eq!(state_of(&bridge, made.nonce), "confirmed");
        // The source vault keeps the locked tokens: the bridge moves liquidity, not supply.
        assert_eq!(
            balance(source, source_token, source_vault),
            source_vault_before + U256::from(amount)
        );
    }
}

/// Claim: with a deposit fee, the source vault keeps the fee, the destination pays the net amount, and the fee reaches
/// the recipient by collection.
/// Shows: a vault pair with a fee of 50 basis points. A deposit whose fee limit is 49 reverts and moves nothing. The
/// same deposit with a limit of 50 locks the whole amount on the source. The service then proves it, and the
/// destination pays the amount less the fee, through the real receipt proof. Anyone can collect, and the recipient of
/// fees gets exactly the fee. After collection the source vault holds the net amount that the destination paid.
/// Why it matters: the fee changes the amount in the event, and the destination pays what the event says. A vault that
/// paid the gross amount would be insolvent by the fee, and a vault that lost the fee would pay for nothing.
#[test]
fn happy_path_deposit_fee_is_kept_on_the_source_and_the_destination_pays_the_net_amount() {
    if !tools_available() {
        return;
    }
    let bridge = deploy_bridge_with(
        "happy-fee",
        BridgeOptions {
            deposit_fee_basis_points: 50,
            ..Default::default()
        },
    );
    fund_destination_vault(&bridge, Direction::AToB, 1_000 * ONE_TOKEN);
    let (source, destination) = (
        bridge.source(Direction::AToB),
        bridge.destination(Direction::AToB),
    );
    let (source_token, destination_token) = (
        bridge.source_token(Direction::AToB),
        bridge.destination_token(Direction::AToB),
    );
    let (source_vault, destination_vault) = (
        bridge.source_vault(Direction::AToB),
        bridge.destination_vault(Direction::AToB),
    );
    let amount = 100 * ONE_TOKEN;
    let fee = amount * 50 / 10_000;
    let net = amount - fee;

    // A limit below the fee refuses the deposit, and the tokens stay with the depositor.
    source.send(
        Some(source_token),
        &TokenContract::mintCall {
            to: DEPLOYER,
            amount: U256::from(amount),
        }
        .abi_encode(),
    );
    source.send(
        Some(source_token),
        &TokenContract::approveCall {
            spender: source_vault,
            amount: U256::from(amount),
        }
        .abi_encode(),
    );
    let evidence = gate_evidence(source, bridge.source_gate(Direction::AToB));
    let refused = source.send_allowing_failure(
        Some(source_vault),
        &deposit_calldata(source_token, RECIPIENT, U256::from(amount), 49, &evidence),
    );
    assert_eq!(
        refused["status"], "0x0",
        "a limit of 49 refuses a fee of 50"
    );
    assert_eq!(
        balance(source, source_token, DEPLOYER),
        U256::from(amount),
        "the depositor keeps the tokens"
    );
    assert_eq!(balance(source, source_token, source_vault), U256::ZERO);

    let made = deposit_on_with_fee_limit(&bridge, Direction::AToB, amount, 50);
    assert_eq!(
        balance(source, source_token, source_vault),
        U256::from(amount),
        "the source vault locks the gross amount"
    );
    let accrued = |vault: Address| {
        U256::from_be_slice(
            &source
                .call(
                    vault,
                    &VaultContract::accruedFeesCall {
                        localToken: source_token,
                    }
                    .abi_encode(),
                )
                .unwrap(),
        )
    };
    assert_eq!(accrued(source_vault), U256::from(fee), "the fee is booked");

    source.mine(2);
    run(&bridge, &["once"]).expect("once");
    assert_eq!(
        balance(destination, destination_token, RECIPIENT),
        U256::from(net),
        "the recipient gets the amount less the fee"
    );
    assert_eq!(
        balance(destination, destination_token, destination_vault),
        U256::from(1_000 * ONE_TOKEN - net)
    );
    assert!(claimed(destination, destination_vault, made.nonce));

    // The deployer is the fee authority and the fee recipient. Anyone may collect. Here the deployer sends the call.
    let before = balance(source, source_token, DEPLOYER);
    source.send(
        Some(source_vault),
        &VaultContract::collectFeesCall {
            token: source_token,
        }
        .abi_encode(),
    );
    assert_eq!(
        balance(source, source_token, DEPLOYER) - before,
        U256::from(fee),
        "the recipient gets exactly the fee"
    );
    assert_eq!(accrued(source_vault), U256::ZERO);
    assert_eq!(
        balance(source, source_token, source_vault),
        U256::from(net),
        "the source vault holds what the destination paid"
    );
}

/// Claim: the cost of each piece, measured on the hardened contracts, is printed (and bounded).
/// Shows: gas of a light-client update, of a recent withdrawal, and of a deposit through each gate state: the first
/// deposit of an epoch on the enforcing gate of chain 1 (it carries a fork proof), a later deposit of that epoch (empty
/// evidence), and a deposit on the detecting gate of chain 369.
/// Why it matters: the hardening must stay affordable. A gate that costs more than the proof it replaces, or an update
/// whose cost grows with the committee, would price users out. Run with `-- --nocapture` to read the numbers; the
/// bounds make a large regression fail the test.
#[test]
fn happy_path_gas_of_updates_withdrawals_and_gated_deposits() {
    if !tools_available() {
        return;
    }
    let bridge = deploy_bridge("happy-gas");
    fund_destination_vault(&bridge, Direction::AToB, 1_000 * ONE_TOKEN);
    fund_destination_vault(&bridge, Direction::BToA, 1_000 * ONE_TOKEN);
    settle_in_epoch(&bridge.chain_a, bridge.gate_a);

    let first_in_epoch = deposit_on(&bridge, Direction::AToB, ONE_TOKEN);
    let later_in_epoch = deposit_on(&bridge, Direction::AToB, ONE_TOKEN);
    let detecting = deposit_on(&bridge, Direction::BToA, ONE_TOKEN);
    report_gas(
        "deposit, enforcing gate, first of the epoch (carries the fork proof)",
        first_in_epoch.gas_used,
    );
    report_gas(
        "deposit, enforcing gate, later in the same epoch (empty evidence)",
        later_in_epoch.gas_used,
    );
    report_gas(
        "deposit, detecting gate (no beacon roots contract)",
        detecting.gas_used,
    );
    assert!(
        first_in_epoch.gas_used > later_in_epoch.gas_used + 20_000,
        "the proof is paid once per epoch, by the first depositor"
    );

    bridge.chain_a.mine(2);
    bridge.chain_b.mine(2);
    run(&bridge, &["once"]).expect("once");

    let updates = update_gas(&bridge.chain_b, bridge.light_client_b);
    assert!(
        !updates.is_empty(),
        "the light client on chain 369 was updated"
    );
    for (index, gas) in updates.iter().enumerate() {
        report_gas(&format!("light-client update {index} (oracle verifier, so the proof check is a signature recovery)"), *gas);
    }
    let withdrawal_a_to_b = withdrawal_gas(&bridge, Direction::AToB, first_in_epoch.nonce);
    let withdrawal_b_to_a = withdrawal_gas(&bridge, Direction::BToA, detecting.nonce);
    report_gas("withdrawal on chain 369 (recent path)", withdrawal_a_to_b);
    report_gas("withdrawal on chain 1 (recent path)", withdrawal_b_to_a);

    // The numbers are measured on 2026-10-20; the bounds sit well above them and well below a broken design.
    assert!(
        updates.iter().all(|gas| *gas < 150_000),
        "an update stays cheap: one proof check, no loop over the committee: {updates:?}"
    );
    assert!(
        withdrawal_a_to_b < 600_000 && withdrawal_b_to_a < 600_000,
        "a recent withdrawal: {withdrawal_a_to_b}, {withdrawal_b_to_a}"
    );
    assert!(
        later_in_epoch.gas_used < 150_000,
        "a gated deposit that needs no proof stays cheap"
    );
    for nonce in [first_in_epoch.nonce, later_in_epoch.nonce] {
        assert_eq!(state_of(&bridge, nonce), "confirmed");
    }
}

/// Claim: a flow limiter that refuses a withdrawal makes the prover wait, however long, without sending, without
/// counting an attempt, and without failing the deposit. After the limiter allows, the next pass pays it.
/// Shows: both vaults have a test limiter. A deposit on chain 1 is proven. The limiter of chain 369 refuses
/// withdrawals for more passes than `max_attempts`. Every pass leaves the state `proven` with zero attempts and a note
/// that names the flow limiter and carries its `FlowRefused` error, pays nothing, leaves the nonce unclaimed, and sends
/// no withdrawal transaction (the nonce of the prover account does not move). After the limiter allows, the next
/// pass pays the amount to the recipient and the state is `confirmed`.
/// Why it matters: a refusal reverts the whole transaction, so the claim stays open on chain. A rate limit works as
/// wait and retry only if the prover never gives the deposit up while the limit lasts.
#[test]
fn happy_path_withdrawal_refused_by_the_flow_limiter_is_reported_and_paid_after_it_allows() {
    use zk_bridge_prover::contracts::VaultContract;

    if !tools_available() {
        return;
    }
    let bridge = deploy_bridge_with(
        "happy-flow-limiter",
        BridgeOptions {
            scripted_flow_limiter: true,
            ..Default::default()
        },
    );
    fund_destination_vault(&bridge, Direction::AToB, 1_000 * ONE_TOKEN);
    let (source, destination) = (
        bridge.source(Direction::AToB),
        bridge.destination(Direction::AToB),
    );
    let destination_token = bridge.destination_token(Direction::AToB);
    let destination_vault = bridge.destination_vault(Direction::AToB);
    let limiter = bridge
        .destination_flow_limiter(Direction::AToB)
        .expect("the option deploys a limiter");
    let attached = U256::from_be_slice(
        &destination
            .call(
                destination_vault,
                &VaultContract::flowLimiterCall {}.abi_encode(),
            )
            .unwrap(),
    );
    assert_eq!(
        attached,
        U256::from_be_slice(limiter.as_slice()),
        "control: the vault has the limiter attached"
    );
    let amount = 5 * ONE_TOKEN;

    destination.send(
        Some(limiter),
        &ScriptedFlowLimiter::setRefusalsCall {
            deposits: false,
            withdrawals: true,
        }
        .abi_encode(),
    );
    let made = deposit_on(&bridge, Direction::AToB, amount);
    source.mine(2);
    // The prover signs with the deployer key, so the nonce of that account on the destination counts every transaction
    // it sent. The first pass may send light-client updates, so the nonce is read after it.
    run(&bridge, &["once"]).expect("a refused withdrawal does not stop the pass");
    let sent_before = destination.nonce(DEPLOYER);

    // Many more passes than the default `max_attempts` (3).
    for _ in 0..6 {
        run(&bridge, &["once"]).expect("a refused withdrawal does not stop the pass");
    }

    assert_eq!(
        balance(destination, destination_token, RECIPIENT),
        U256::ZERO,
        "nothing was paid"
    );
    assert!(
        !claimed(destination, destination_vault, made.nonce),
        "the nonce stays unclaimed"
    );
    assert_eq!(
        destination.nonce(DEPLOYER),
        sent_before,
        "no withdrawal was sent while the limiter refused"
    );
    let status = run(&bridge, &["status"]).unwrap();
    let line = status
        .lines()
        .find(|line| line.starts_with(&format!("nonce={:#x} ", made.nonce)))
        .expect("status line");
    assert!(
        line.contains("state=proven"),
        "the deposit waits with its proof: {line}"
    );
    assert!(
        line.contains("attempts=0"),
        "a wait is not an attempt: {line}"
    );
    assert!(
        line.contains(&format!("flow_limiter_{limiter:#x}")),
        "the note names the limiter: {line}"
    );
    let refusal = alloy_primitives::hex::encode(error_selector("FlowRefused()"));
    assert!(
        line.contains(&format!("0x{refusal}")),
        "the note carries the error of the limiter: {line}"
    );

    destination.send(
        Some(limiter),
        &ScriptedFlowLimiter::setRefusalsCall {
            deposits: false,
            withdrawals: false,
        }
        .abi_encode(),
    );
    run(&bridge, &["once"]).expect("once");
    assert_eq!(
        balance(destination, destination_token, RECIPIENT),
        U256::from(amount),
        "the recipient is paid after the allow"
    );
    assert!(claimed(destination, destination_vault, made.nonce));
    assert_eq!(state_of(&bridge, made.nonce), "confirmed");
}
