//! Hardened two-chain tests: the honest path, in both directions, with balances checked on both sides, and the
//! measured gas of the pieces (light-client update, withdrawal, gated deposits).
//!
//! These tests are the control for every other hardened test file: each defense test claims "the attack is refused, and
//! the honest path still works", and this file shows the honest path on its own.

mod common;

use alloy_primitives::U256;
use common::bridge::*;
use common::*;

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
        let (source_token, destination_token) = (bridge.source_token(direction), bridge.destination_token(direction));
        let (source_vault, destination_vault) = (bridge.source_vault(direction), bridge.destination_vault(direction));

        let recipient_before = balance(destination, destination_token, RECIPIENT);
        let destination_vault_before = balance(destination, destination_token, destination_vault);
        let source_vault_before = balance(source, source_token, source_vault);

        let made = deposit_on(&bridge, direction, amount);
        // The depositor minted `amount` and deposited all of it, so the depositor ends with nothing.
        assert_eq!(balance(source, source_token, DEPLOYER), U256::ZERO, "{direction:?}: the depositor gave the amount");
        assert_eq!(balance(source, source_token, source_vault), source_vault_before + U256::from(amount), "{direction:?}: the source vault locks it");
        // Before the service runs, nothing has moved on the destination.
        assert_eq!(balance(destination, destination_token, RECIPIENT), recipient_before);
        assert!(!claimed(destination, destination_vault, made.nonce));

        source.mine(2);
        run(&bridge, &["once"]).expect("once");

        assert_eq!(balance(destination, destination_token, RECIPIENT), recipient_before + U256::from(amount), "{direction:?}: the recipient is paid");
        assert_eq!(
            balance(destination, destination_token, destination_vault),
            destination_vault_before - U256::from(amount),
            "{direction:?}: the destination vault pays from its own balance"
        );
        assert!(claimed(destination, destination_vault, made.nonce), "{direction:?}: the nonce is claimed");
        assert_eq!(state_of(&bridge, made.nonce), "confirmed");
        // The source vault keeps the locked tokens: the bridge moves liquidity, not supply.
        assert_eq!(balance(source, source_token, source_vault), source_vault_before + U256::from(amount));
    }
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
    report_gas("deposit, enforcing gate, first of the epoch (carries the fork proof)", first_in_epoch.gas_used);
    report_gas("deposit, enforcing gate, later in the same epoch (empty evidence)", later_in_epoch.gas_used);
    report_gas("deposit, detecting gate (no beacon roots contract)", detecting.gas_used);
    assert!(first_in_epoch.gas_used > later_in_epoch.gas_used + 20_000, "the proof is paid once per epoch, by the first depositor");

    bridge.chain_a.mine(2);
    bridge.chain_b.mine(2);
    run(&bridge, &["once"]).expect("once");

    let updates = update_gas(&bridge.chain_b, bridge.light_client_b);
    assert!(!updates.is_empty(), "the light client on chain 369 was updated");
    for (index, gas) in updates.iter().enumerate() {
        report_gas(&format!("light-client update {index} (oracle verifier, so the proof check is a signature recovery)"), *gas);
    }
    let withdrawal_a_to_b = withdrawal_gas(&bridge, Direction::AToB, first_in_epoch.nonce);
    let withdrawal_b_to_a = withdrawal_gas(&bridge, Direction::BToA, detecting.nonce);
    report_gas("withdrawal on chain 369 (recent path)", withdrawal_a_to_b);
    report_gas("withdrawal on chain 1 (recent path)", withdrawal_b_to_a);

    // The numbers are measured on 2026-10-20; the bounds sit well above them and well below a broken design.
    assert!(updates.iter().all(|gas| *gas < 150_000), "an update stays cheap: one proof check, no loop over the committee: {updates:?}");
    assert!(withdrawal_a_to_b < 600_000 && withdrawal_b_to_a < 600_000, "a recent withdrawal: {withdrawal_a_to_b}, {withdrawal_b_to_a}");
    assert!(later_in_epoch.gas_used < 150_000, "a gated deposit that needs no proof stays cheap");
    for nonce in [first_in_epoch.nonce, later_in_epoch.nonce] {
        assert_eq!(state_of(&bridge, nonce), "confirmed");
    }
}
