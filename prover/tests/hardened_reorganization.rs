//! Hardened two-chain test of finality (H-08): a deposit in a block that a reorganization removes is never paid.

mod common;

use alloy_primitives::{B256, U256};
use alloy_sol_types::SolCall;
use common::bridge::*;
use common::*;
use zk_bridge_prover::contracts::LightClientContract;
use zk_bridge_prover::error::Error;

/// Claim: a deposit that a reorganization of the source chain removes before the block is final is never delivered, and
/// the light client of the destination never stores the removed block as final.
/// Shows: with a finality depth of 3, a deposit one block deep is not read by the service. Anvil then reverts to a
/// snapshot, which removes that block as a reorganization would. After new blocks pass the old height the service has
/// never seen the deposit, the destination light client does not hold the removed block hash as finalized, nothing is
/// claimed, and taking the vanished transaction by hand fails. The control is a replacement deposit with another amount
/// in the new chain. It reuses the nonce of the removed deposit (the nonce counts deposits, and the reorganization
/// undid the count), and the recipient receives the replacement amount, never the removed amount.
/// Why it matters: H-08. A sync committee signs the newest head, which a reorganization can still replace. A
/// destination that honored an unfinalized block would pay for a deposit that no longer exists on the source chain.
#[test]
fn h08_hardened_deposit_in_a_reorganized_block_is_never_withdrawn() {
    if !tools_available() {
        return;
    }
    let bridge = deploy_bridge_with(
        "h08-reorganization",
        BridgeOptions {
            finality_depth: 3,
            ..Default::default()
        },
    );
    fund_destination_vault(&bridge, Direction::AToB, 1_000 * ONE_TOKEN);
    let chain = &bridge.chain_a;
    let removed_amount = 9 * ONE_TOKEN;
    let replacement_amount = 2 * ONE_TOKEN;

    // Settle the epoch first, so the snapshot and the deposits do not straddle an epoch border.
    settle_in_epoch(chain, bridge.gate_a);
    let snapshot = chain.snapshot();
    let removed = deposit_on(&bridge, Direction::AToB, removed_amount);
    chain.mine(1);
    let removed_height = parse_height(&removed.receipt);
    assert!(
        chain.block_number() < removed_height + 3,
        "the deposit block is not three blocks deep"
    );

    run(&bridge, &["once"]).expect("once");
    assert_eq!(
        state_of(&bridge, removed.nonce),
        "absent",
        "the service does not read a block that is not final"
    );
    assert!(!claimed(&bridge.chain_b, bridge.vault_b, removed.nonce));

    // The reorganization: the chain forgets the deposit block and grows past its old height with empty blocks.
    assert!(chain.revert_to(&snapshot), "anvil knows the snapshot");
    chain.mine(8);
    assert!(chain.block_number() > removed_height + 3);
    let client = client_of(chain);
    assert_ne!(
        zk_bridge_prover::chain::ExecutionReader::block_hash(&client, removed_height).unwrap(),
        removed.block_hash,
        "the block at that height is another block now"
    );
    run(&bridge, &["once"]).expect("once after the reorganization");

    assert_eq!(
        state_of(&bridge, removed.nonce),
        "absent",
        "the service never saw the removed deposit"
    );
    assert!(!claimed(&bridge.chain_b, bridge.vault_b, removed.nonce));
    assert_eq!(
        balance(&bridge.chain_b, bridge.token_b, RECIPIENT),
        U256::ZERO,
        "nothing was paid for the removed deposit"
    );
    assert!(
        !is_finalized_on_destination(&bridge, removed.block_hash),
        "the light client never stored the removed block as final"
    );
    let by_hand = run(
        &bridge,
        &[
            "withdraw",
            "--tx",
            &format!("{:#x}", removed.transaction_hash),
            "--log-index",
            &removed.log_index.to_string(),
        ],
    );
    assert!(
        matches!(by_hand, Err(Error::Usage(_))),
        "the removed transaction cannot be taken by hand: {by_hand:?}"
    );

    // Control: a replacement deposit in the new chain is delivered once it is final. It carries the removed deposit's
    // nonce, and it pays its own amount.
    let replacement = deposit_on(&bridge, Direction::AToB, replacement_amount);
    assert_eq!(
        replacement.nonce, removed.nonce,
        "the reorganization undid the deposit count, so the nonce repeats"
    );
    assert_ne!(replacement.block_hash, removed.block_hash);
    chain.mine(4);
    run(&bridge, &["once"]).expect("once for the replacement");
    assert_eq!(state_of(&bridge, replacement.nonce), "confirmed");
    assert_eq!(
        balance(&bridge.chain_b, bridge.token_b, RECIPIENT),
        U256::from(replacement_amount),
        "the replacement amount, not the removed amount"
    );
    assert!(is_finalized_on_destination(&bridge, replacement.block_hash));
    assert!(
        !is_finalized_on_destination(&bridge, removed.block_hash),
        "the removed block is still not final anywhere"
    );
}

fn parse_height(receipt: &serde_json::Value) -> u64 {
    zk_bridge_prover::rpc::parse_quantity(&receipt["blockNumber"]).unwrap()
}

/// Whether the light client of chain 369 holds a source block hash as a finalized execution block.
fn is_finalized_on_destination(bridge: &Bridge, block_hash: B256) -> bool {
    let call = LightClientContract::isFinalizedExecutionBlockCall {
        blockHash: block_hash,
    };
    bridge
        .chain_b
        .call(bridge.light_client_b, &call.abi_encode())
        .unwrap()
        .last()
        == Some(&1)
}
