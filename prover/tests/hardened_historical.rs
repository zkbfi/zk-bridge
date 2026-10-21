//! Hardened two-chain test of the historical ancestry path: a deposit whose proof anchor lies more than 8192 slots after it.
//!
//! `DevBeaconSource` (a test-only support, see `prover/src/beacon/dev.rs`) builds the historical layout of the anchor state:
//! one `historical_summaries` entry per completed era, holding the header roots of the first blocks of the era.

mod common;

use alloy_primitives::{keccak256, U256};
use alloy_sol_types::SolCall;
use common::bridge::*;
use common::*;
use zk_bridge_prover::contracts::{LightClientContract, VaultContract};
use zk_bridge_prover::rpc::parse_quantity;

fn historical_row_count(bridge: &Bridge) -> usize {
    let raw = bridge.chain_b.call(bridge.vault_b, &VaultContract::historicalLayoutsCall {}.abi_encode()).unwrap();
    VaultContract::historicalLayoutsCall::abi_decode_returns(&raw).unwrap().len()
}

fn head_slot(bridge: &Bridge) -> u64 {
    let raw = bridge.chain_b.call(bridge.light_client_b, &LightClientContract::headCall {}.abi_encode()).unwrap();
    LightClientContract::headCall::abi_decode_returns(&raw).unwrap()
}

/// The gas of every transaction that added a `historical_summaries` row to the vault.
fn historical_row_gas(bridge: &Bridge) -> Vec<u64> {
    let topic = keccak256("HistoricalSummariesLayoutValidated(uint256,uint64,uint64)");
    let client = client_of(&bridge.chain_b);
    let latest = bridge.chain_b.block_number();
    client
        .logs(bridge.vault_b, topic, 0, latest)
        .unwrap()
        .iter()
        .map(|log| gas_used(&client.transaction_receipt(log.transaction_hash).unwrap().unwrap()))
        .collect()
}

/// Claim: a deposit whose proof anchor lies more than 8192 slots after it is withdrawn through `historical_summaries`,
/// end to end through the service, and paid exactly once.
/// Shows: deposit D0 is paid first, so the light client stores early headers. Deposit D1 is made, and then more than 2,200
/// blocks (8,800 slots) pass. Deposit D2 is made and paid first by hand, which moves the light client head from the early
/// headers to D2 in one step, more than 8192 slots past D1. The service then pays D1. Its anchor is the head after
/// D2, so the vault takes the historical path: before the withdrawal the vault has no historical layout row, afterwards it
/// has one (anyone may add it, and the service did), and D1's recipient holds the amount. The controls are D0 and D2,
/// which use the recent path and are paid before, so a failure of D1 alone would point at the historical path.
/// Why it matters: before this change a light client had to be updated in every 8192-slot window or its old deposits
/// could never be proven. The historical path removes that duty. If it were broken, every deposit that waits more than
/// about 22 hours (on PulseChain) behind a later update would be stuck, and the vault has no refund.
#[test]
fn historical_path_pays_a_deposit_more_than_8192_slots_before_its_anchor() {
    if !tools_available() {
        return;
    }
    let bridge = deploy_bridge("historical-path");
    fund_destination_vault(&bridge, Direction::AToB, 1_000 * ONE_TOKEN);
    let chain = &bridge.chain_a;
    let amounts = [ONE_TOKEN, 2 * ONE_TOKEN, 4 * ONE_TOKEN];

    // D0: paid on the recent path. The light client now stores the headers of an early block.
    let early = deposit_on(&bridge, Direction::AToB, amounts[0]);
    chain.mine(2);
    run(&bridge, &["once"]).expect("once for the first deposit");
    assert_eq!(state_of(&bridge, early.nonce), "confirmed");
    assert_eq!(historical_row_count(&bridge), 0, "the recent path adds no historical row");

    // D1: made now and not yet read by the service (no `once` runs until D2 exists).
    let old = deposit_on(&bridge, Direction::AToB, amounts[1]);
    let old_block = parse_quantity(&old.receipt["blockNumber"]).unwrap();

    // More than 2,048 blocks pass (8,192 slots at four slots per block of the development chain).
    chain.mine(2_200);
    settle_in_epoch(chain, bridge.gate_a);
    let late = deposit_on(&bridge, Direction::AToB, amounts[2]);
    let late_block = parse_quantity(&late.receipt["blockNumber"]).unwrap();
    assert!(late_block - old_block >= 2_048, "the two deposits lie {} blocks apart", late_block - old_block);
    chain.mine(2);

    // D2 first, by hand: the head jumps past D1.
    run(&bridge, &["withdraw", "--tx", &format!("{:#x}", late.transaction_hash), "--log-index", &late.log_index.to_string()]).expect("late deposit");
    assert!(claimed(&bridge.chain_b, bridge.vault_b, late.nonce));
    assert!(!claimed(&bridge.chain_b, bridge.vault_b, old.nonce), "D1 is still unpaid");
    let old_slot = 1_024 + 4 * old_block + 2; // the development chain's deposit slot of the block
    assert!(head_slot(&bridge) - old_slot > 8_192, "the head is {} slots past D1", head_slot(&bridge) - old_slot);
    assert_eq!(historical_row_count(&bridge), 0, "no historical row yet");

    // The service pays D1 on the historical path.
    run(&bridge, &["once"]).expect("once for the old deposit");
    assert_eq!(state_of(&bridge, old.nonce), "confirmed", "D1 is paid");
    assert!(claimed(&bridge.chain_b, bridge.vault_b, old.nonce));
    assert_eq!(historical_row_count(&bridge), 1, "the historical path needed, and got, one validated layout row");
    let total: u128 = amounts.iter().sum();
    assert_eq!(balance(&bridge.chain_b, bridge.token_b, RECIPIENT), U256::from(total), "all three deposits paid, each once");

    // Gas of the three withdrawals and of the historical row.
    report_gas("withdrawal, recent path (first deposit)", withdrawal_gas(&bridge, Direction::AToB, early.nonce));
    report_gas("withdrawal, recent path (after a head jump of more than 8192 slots)", withdrawal_gas(&bridge, Direction::AToB, late.nonce));
    report_gas("withdrawal, historical path", withdrawal_gas(&bridge, Direction::AToB, old.nonce));
    for gas in historical_row_gas(&bridge) {
        report_gas("addHistoricalSummariesLayout (once per route, by anyone)", gas);
    }
}
