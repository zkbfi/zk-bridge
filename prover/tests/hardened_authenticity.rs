//! Hardened two-chain tests of authenticity: who may emit a deposit (H-02) and which tokens may cross (H-03).
//!
//! Both defenses live in the destination vault. The service also filters (it scans only logs of the configured source
//! vault, and it registers no token), so these tests send the attack to the vault directly with a withdrawal that the
//! service would refuse to build. The contract is then the only defense that stands.

mod common;

use alloy_primitives::{keccak256, Address, B256, U256};
use alloy_sol_types::{sol, SolCall};
use common::bridge::*;
use common::*;
use zk_bridge_prover::contracts::{deposit_calldata, TokenContract, VaultContract};
use zk_bridge_prover::error::Error;

sol! {
    interface FakeEmitter {
        function fakeDeposit(address token, address recipient, uint256 amount, bytes32 nonce, uint64 targetChainId) external;
    }
}

/// Claim: a contract that is not the source vault, emitting a log with the exact topics and data of a real
/// `DepositInitiated`, cannot make the destination vault pay.
/// Shows: the fake log sits in the same block as an honest deposit, so the light client, the layout rows and the receipt
/// proof are all genuine for it. Only the emitter differs. The destination vault reverts with `WrongEmitter(expected,
/// actual)`, the recipient gets nothing from it, and the service refuses to take the log by hand. The control is the
/// honest deposit of the same block: it is paid.
/// Why it matters: H-02. A log has no signature. Anyone can emit any event, so a vault that trusted the event shape
/// alone would pay out the whole balance against a deposit that never happened.
#[test]
fn h02_hardened_fake_emitter_is_refused() {
    if !tools_available() {
        return;
    }
    let bridge = deploy_bridge("h02-fake-emitter");
    fund_destination_vault(&bridge, Direction::AToB, 1_000 * ONE_TOKEN);
    let chain = &bridge.chain_a;
    let emitter = chain.deploy("FakeDepositEmitter", Default::default());

    // Prepare the honest deposit, then mine the honest deposit and the fake emission into ONE block.
    chain.send(Some(bridge.token_a), &TokenContract::mintCall { to: DEPLOYER, amount: U256::from(ONE_TOKEN) }.abi_encode());
    chain.send(Some(bridge.token_a), &TokenContract::approveCall { spender: bridge.vault_a, amount: U256::from(ONE_TOKEN) }.abi_encode());
    let evidence = gate_evidence(chain, bridge.gate_a);
    let stolen = 500 * ONE_TOKEN;
    let fake_call = FakeEmitter::fakeDepositCall {
        token: bridge.token_a,
        recipient: RECIPIENT,
        amount: U256::from(stolen),
        nonce: keccak256(b"fake nonce"),
        targetChainId: 369,
    }
    .abi_encode();
    let honest_call = deposit_calldata(bridge.token_a, RECIPIENT, U256::from(ONE_TOKEN), &evidence).to_vec();
    let receipts = chain.send_in_one_block(&[(bridge.vault_a, honest_call), (emitter, fake_call)]);
    let honest = made_deposit(receipts[0].clone());
    let fake_receipt = receipts[1].clone();
    assert_eq!(honest.receipt["blockHash"], fake_receipt["blockHash"], "one block holds both logs");
    let fake_transaction: B256 = fake_receipt["transactionHash"].as_str().unwrap().parse().unwrap();
    assert_eq!(
        fake_receipt["logs"][0]["topics"][0].as_str().unwrap(),
        format!("{:#x}", zk_bridge_prover::light_client::DEPOSIT_EVENT_TOPIC),
        "the fake log has the real deposit topic"
    );

    chain.mine(2);
    run(&bridge, &["once"]).expect("once");
    // Control: the honest deposit of the same block is paid.
    assert!(claimed(&bridge.chain_b, bridge.vault_b, honest.nonce));
    assert_eq!(balance(&bridge.chain_b, bridge.token_b, RECIPIENT), U256::from(ONE_TOKEN));

    // The attack: a withdrawal for the fake log, with genuine proofs, built without the service's own check.
    let calldata = unchecked_withdrawal_calldata(&bridge, Direction::AToB, fake_transaction, 0);
    let selector = revert_selector(&bridge.chain_b, bridge.vault_b, &calldata).expect("the vault must refuse the fake log");
    assert_eq!(selector, error_selector("WrongEmitter(address,address)"), "refused for the emitter, not for another reason");
    assert!(!claimed(&bridge.chain_b, bridge.vault_b, keccak256(b"fake nonce")));
    assert_eq!(balance(&bridge.chain_b, bridge.token_b, RECIPIENT), U256::from(ONE_TOKEN), "nothing from the fake log was paid");

    // The same builder on the honest log passes the vault's check (it reverts only because it is already claimed),
    // which shows the builder is sound and only the emitter made the difference.
    let honest_calldata = unchecked_withdrawal_calldata(&bridge, Direction::AToB, honest.transaction_hash, honest.log_index as u64);
    assert_eq!(
        revert_selector(&bridge.chain_b, bridge.vault_b, &honest_calldata),
        Some(error_selector("AlreadyClaimed(bytes32)")),
        "the honest log gets past the emitter check and stops only at the claim"
    );

    // The service also refuses the log by hand: it is not a log of the configured source vault.
    let manual = run(&bridge, &["withdraw", "--tx", &format!("{fake_transaction:#x}"), "--log-index", "0"]);
    assert!(matches!(manual, Err(Error::Usage(_))), "the service takes no log of another emitter: {manual:?}");
}

/// Claim: a token that has the same address on both chains, with no registered pair on the destination vault, cannot be
/// withdrawn.
/// Shows: the rogue token has one address on chains 1 and 369, and the vault of chain 1 accepts it (a misconfigured or
/// hostile source vault would). The vault of chain 369 does not list it, and it holds 1,000 rogue tokens that a trusting
/// vault would pay. The vault reverts with `UnsupportedRemoteToken`, the service marks the deposit failed after its
/// attempts, and the rogue balance of the recipient stays zero. The control is a registered token in the same service
/// run: it is paid.
/// Why it matters: H-03. "Same address on both chains" is a coincidence of deployer nonces, not a relationship. Only
/// the explicit registry says which token stands for which, so the destination must pay from the registry and from
/// nothing else.
#[test]
fn h03_hardened_same_address_token_without_a_registered_pair_is_refused() {
    if !tools_available() {
        return;
    }
    let bridge = deploy_bridge_with("h03-rogue-token", BridgeOptions { rogue_token: true, ..Default::default() });
    let rogue: Address = bridge.rogue_token.expect("rogue token");
    fund_destination_vault(&bridge, Direction::AToB, 1_000 * ONE_TOKEN);
    // The destination vault holds rogue tokens: a vault that paid without a registry entry would pay these.
    bridge.chain_b.send(Some(rogue), &TokenContract::mintCall { to: bridge.vault_b, amount: U256::from(1_000 * ONE_TOKEN) }.abi_encode());

    // Read the relationship from the contracts and not from the names (a name is a hypothesis).
    let read = |chain: &TestChain, vault: Address, call: Vec<u8>| Address::from_slice(&chain.call(vault, &call).unwrap()[12..]);
    assert_eq!(read(&bridge.chain_a, bridge.vault_a, VaultContract::remoteTokenOfCall { localToken: rogue }.abi_encode()), rogue, "chain 1 maps the rogue token to itself");
    assert_eq!(read(&bridge.chain_b, bridge.vault_b, VaultContract::localTokenOfCall { remoteToken: rogue }.abi_encode()), Address::ZERO, "chain 369 has no entry for it");
    assert_eq!(read(&bridge.chain_b, bridge.vault_b, VaultContract::localTokenOfCall { remoteToken: bridge.token_a }.abi_encode()), bridge.token_b, "control: the registered pair maps");

    let rogue_deposit = deposit_token(&bridge.chain_a, bridge.vault_a, bridge.gate_a, rogue, 10 * ONE_TOKEN);
    let honest_deposit = deposit_on(&bridge, Direction::AToB, 3 * ONE_TOKEN);
    bridge.chain_a.mine(2);
    for _ in 0..3 {
        run(&bridge, &["once"]).expect("once");
    }

    // Control: the registered token is delivered.
    assert!(claimed(&bridge.chain_b, bridge.vault_b, honest_deposit.nonce));
    assert_eq!(balance(&bridge.chain_b, bridge.token_b, RECIPIENT), U256::from(3 * ONE_TOKEN));
    // The attack: nothing of the rogue token moved, and the vault still holds all of it.
    assert!(!claimed(&bridge.chain_b, bridge.vault_b, rogue_deposit.nonce));
    assert_eq!(balance(&bridge.chain_b, rogue, RECIPIENT), U256::ZERO);
    assert_eq!(balance(&bridge.chain_b, rogue, bridge.vault_b), U256::from(1_000 * ONE_TOKEN));
    assert_eq!(state_of(&bridge, rogue_deposit.nonce), "failed", "the service gives up after its attempts");

    let calldata = unchecked_withdrawal_calldata(&bridge, Direction::AToB, rogue_deposit.transaction_hash, rogue_deposit.log_index as u64);
    assert_eq!(
        revert_selector(&bridge.chain_b, bridge.vault_b, &calldata),
        Some(error_selector("UnsupportedRemoteToken(address)")),
        "the vault, not the service, refuses it"
    );
}
