//! Hardened two-chain tests of the deposit gate (HB-02, window 1): what a vault does when the source chain's fork
//! version is one that the route does not support.
//!
//! Anvil has no beacon chain. The tests install the genuine EIP-4788 contract code and write the beacon roots by hand, as
//! `SyntheticForkSource` does. The gate checks a header root against the beacon roots contract and a Merkle branch to
//! `fork.current_version`, so a synthetic state whose version is chosen by the test is checked exactly as a real one.

mod common;

use alloy_primitives::{keccak256, U256};
use alloy_sol_types::SolCall;
use common::bridge::*;
use common::*;
use zk_bridge_prover::contracts::{deposit_calldata, TokenContract};
use zk_bridge_prover::gate::gate_evidence_for_deposit;

/// Claim: on chain 1, after the beacon roots contract starts to report a state whose `fork.current_version` is not
/// supported, deposits revert, anyone can seal the gate, and withdrawals still work after the seal.
/// Shows: (1) a healthy epoch confirms and a deposit passes, and a seal with a SUPPORTED version is refused with
/// `VersionIsSupported`, so a healthy chain cannot be sealed. (2) In a later epoch the chain reports version 9.9.9.9. A
/// deposit with that evidence reverts with `UnsupportedVersion`, and a deposit with empty evidence reverts with
/// `ForkNotConfirmed`. (3) An account that is not the deployer seals the gate with that evidence. (4) Every later
/// deposit reverts with `GateSealed`, even with evidence of a supported version. (5) A deposit that was made on chain 369
/// before the seal is still paid on chain 1 by the service: the seal stops deposits, not withdrawals.
/// Why it matters: HB-02. After an unsupported fork the light client of the route cannot follow the source chain, so a
/// deposit made then can never be proven, and the vault has no refund. The gate closes the route to new deposits at
/// that fork, and it must not trap the deposits that were already proven.
#[test]
fn hb02_window1_enforcing_gate_refuses_an_unsupported_fork_and_anyone_can_seal_while_withdrawals_work(
) {
    if !tools_available() {
        return;
    }
    let bridge = deploy_bridge("hb02-seal");
    let chain = &bridge.chain_a;
    fund_destination_vault(&bridge, Direction::BToA, 100 * ONE_TOKEN);
    settle_in_epoch(chain, bridge.gate_a);

    // A deposit on chain 369 before the seal. It is paid on chain 1 after the seal.
    let before_seal = deposit_on(&bridge, Direction::BToA, 3 * ONE_TOKEN);
    bridge.chain_b.mine(2);

    // (1) The healthy epoch: a deposit passes and the epoch is confirmed.
    let healthy = deposit_on(&bridge, Direction::AToB, ONE_TOKEN);
    assert_eq!(healthy.receipt["status"], "0x1");
    assert!(
        confirmed_epoch(chain, bridge.gate_a).1,
        "the healthy epoch is confirmed"
    );
    assert!(!gate_sealed(chain, bridge.gate_a));

    // Move into the next epoch. The chain now reports an unsupported version.
    chain.advance_time(EPOCH_SECONDS + 10);
    let client = client_of(chain);

    // A seal with a SUPPORTED version is refused: the control that a healthy chain cannot be sealed.
    let supported = SyntheticForkSource::new(chain, CAPELLA_VERSION);
    let supported_evidence = gate_evidence_for_deposit(&client, bridge.gate_a, &supported).unwrap();
    assert_eq!(
        revert_selector(chain, bridge.gate_a, &seal_calldata(&supported_evidence)),
        Some(error_selector("VersionIsSupported(bytes4)")),
        "a supported version cannot seal the gate"
    );

    // (2) The unsupported version: deposits revert.
    chain.send(
        Some(bridge.token_a),
        &TokenContract::mintCall {
            to: DEPLOYER,
            amount: U256::from(10 * ONE_TOKEN),
        }
        .abi_encode(),
    );
    chain.send(
        Some(bridge.token_a),
        &TokenContract::approveCall {
            spender: bridge.vault_a,
            amount: U256::from(10 * ONE_TOKEN),
        }
        .abi_encode(),
    );
    let unsupported = SyntheticForkSource::new(chain, UNKNOWN_VERSION);
    let unsupported_evidence =
        gate_evidence_for_deposit(&client, bridge.gate_a, &unsupported).unwrap();
    let deposit_with = |evidence: &[u8]| {
        deposit_calldata(
            bridge.token_a,
            RECIPIENT,
            U256::from(ONE_TOKEN),
            0,
            evidence,
        )
        .to_vec()
    };
    assert_eq!(
        revert_selector(chain, bridge.vault_a, &deposit_with(&unsupported_evidence)),
        Some(error_selector("UnsupportedVersion(bytes4)")),
        "evidence of an unsupported version does not admit a deposit"
    );
    assert_eq!(
        revert_selector(chain, bridge.vault_a, &deposit_with(&[])),
        Some(error_selector("ForkNotConfirmed(uint256)")),
        "the epoch has no confirmation, so empty evidence does not admit it either"
    );

    // (3) Anyone seals it. The sender is the second Anvil account, not the deployer.
    let unsupported_evidence =
        gate_evidence_for_deposit(&client, bridge.gate_a, &unsupported).unwrap();
    let sealed = chain.send_from(
        RECIPIENT,
        bridge.gate_a,
        &seal_calldata(&unsupported_evidence),
    );
    assert_eq!(sealed["status"], "0x1");
    assert!(gate_sealed(chain, bridge.gate_a), "the gate is sealed");

    // (4) Every later deposit reverts with GateSealed, even with evidence of a supported version.
    let supported_after = {
        // A fresh evidence of the supported version cannot be built through the builder (a sealed gate is an error),
        // so the evidence of step (1) stands in: the seal check runs before any evidence is read.
        supported_evidence
    };
    for evidence in [Vec::new(), supported_after] {
        assert_eq!(
            revert_selector(chain, bridge.vault_a, &deposit_with(&evidence)),
            Some(error_selector("GateSealed()"))
        );
    }
    assert!(
        gate_evidence_for_deposit(&client, bridge.gate_a, &supported).is_err(),
        "the builder refuses a sealed gate"
    );

    // (5) Withdrawals still work: the deposit of chain 369 is paid on chain 1, and the healthy deposit on chain 369.
    let recipient_before = balance(chain, bridge.token_a, RECIPIENT);
    run(&bridge, &["once"]).expect("once");
    assert!(
        claimed(chain, bridge.vault_a, before_seal.nonce),
        "the withdrawal on the sealed chain works"
    );
    assert_eq!(
        balance(chain, bridge.token_a, RECIPIENT),
        recipient_before + U256::from(3 * ONE_TOKEN)
    );
    assert!(
        claimed(&bridge.chain_b, bridge.vault_b, healthy.nonce),
        "the deposit made before the seal is paid on chain 369"
    );
    assert_eq!(state_of(&bridge, before_seal.nonce), "confirmed");
}

/// Claim: on chain 369 (a detecting gate), a deposit succeeds while the chain has no beacon roots contract, and once
/// working beacon-root code is installed the gate enforces, for good.
/// Shows: (1) a deposit with empty evidence succeeds and the gate stays in detection mode. (2) Working EIP-4788 code is
/// installed, and the ring buffer holds a root for the block of the next deposit. A deposit with empty evidence now
/// fails and leaves the gate in detection mode: the switch is undone with the failed call. (3) A deposit with a fork proof
/// succeeds, and the gate is enforcing with a confirmed epoch. (4) In a later epoch, with the beacon roots code removed
/// again, empty evidence still reverts with `ForkNotConfirmed`, so the switch cannot be reversed by taking the contract away.
/// Why it matters: HB-02 and the PulseChain case. PulseChain has no EIP-4788 today, so its gate must admit deposits. If
/// PulseChain adopts the contract, the gate must start to protect the route without a key, and a failure of the probe
/// afterwards must not reopen the route to a version that it cannot follow.
#[test]
fn hb02_window1_detecting_gate_admits_then_enforces_once_beacon_roots_exist() {
    if !tools_available() {
        return;
    }
    let bridge = deploy_bridge("hb02-detect");
    let chain = &bridge.chain_b;
    settle_in_epoch(chain, bridge.gate_b);
    chain.send(
        Some(bridge.token_b),
        &TokenContract::mintCall {
            to: DEPLOYER,
            amount: U256::from(10 * ONE_TOKEN),
        }
        .abi_encode(),
    );
    chain.send(
        Some(bridge.token_b),
        &TokenContract::approveCall {
            spender: bridge.vault_b,
            amount: U256::from(10 * ONE_TOKEN),
        }
        .abi_encode(),
    );
    let deposit_with = |evidence: &[u8]| {
        deposit_calldata(
            bridge.token_b,
            RECIPIENT,
            U256::from(ONE_TOKEN),
            0,
            evidence,
        )
        .to_vec()
    };
    let vault_balance = || balance(chain, bridge.token_b, bridge.vault_b);

    // (1) Detection: no beacon roots contract, so the deposit passes with empty evidence.
    assert!(
        chain.code_of(BEACON_ROOTS).is_empty(),
        "chain 369 has no beacon roots contract"
    );
    assert_eq!(
        chain.send(Some(bridge.vault_b), &deposit_with(&[]))["status"],
        "0x1"
    );
    assert!(!gate_enforcing(chain, bridge.gate_b));
    assert_eq!(vault_balance(), U256::from(ONE_TOKEN));

    // (2) The contract appears, and holds a root for the timestamp of the next block. A deposit with empty evidence fails.
    install_beacon_roots(chain);
    let next_timestamp = chain.latest_timestamp() + 2;
    write_beacon_root(chain, next_timestamp, keccak256(b"a beacon root"));
    chain.set_next_block_timestamp(next_timestamp);
    let failed = chain.send_allowing_failure(Some(bridge.vault_b), &deposit_with(&[]));
    assert_eq!(
        failed["status"], "0x0",
        "the gate now enforces and empty evidence is refused"
    );
    assert_eq!(
        chain.revert_data_of(&failed["transactionHash"])[..4],
        error_selector("ForkNotConfirmed(uint256)"),
        "refused by the gate: the probe found the root, the gate enforced, and no epoch is confirmed"
    );
    assert!(
        !gate_enforcing(chain, bridge.gate_b),
        "a failed deposit undoes the switch: the next deposit detects again"
    );
    assert_eq!(
        vault_balance(),
        U256::from(ONE_TOKEN),
        "the failed deposit moved no tokens"
    );

    // (3) A deposit with a fork proof succeeds, and the gate enforces for good.
    let latest = chain.latest_timestamp();
    write_beacon_root(
        chain,
        latest,
        keccak256(b"a beacon root for the latest block"),
    );
    let evidence = gate_evidence(chain, bridge.gate_b);
    assert!(
        !evidence.is_empty(),
        "the builder sees a working beacon roots contract and builds a proof"
    );
    let next_timestamp = chain.latest_timestamp() + 2;
    write_beacon_root(
        chain,
        next_timestamp,
        keccak256(b"the root of the deposit block"),
    );
    chain.set_next_block_timestamp(next_timestamp);
    assert_eq!(
        chain.send(Some(bridge.vault_b), &deposit_with(&evidence))["status"],
        "0x1"
    );
    assert!(gate_enforcing(chain, bridge.gate_b), "the gate enforces");
    assert!(
        confirmed_epoch(chain, bridge.gate_b).1,
        "and has confirmed the epoch"
    );
    assert_eq!(vault_balance(), U256::from(2 * ONE_TOKEN));

    // (4) Enforcement is permanent: remove the contract, move to the next epoch, and empty evidence still reverts.
    chain.set_code(BEACON_ROOTS, &[]);
    chain.advance_time(EPOCH_SECONDS + 10);
    assert_eq!(
        revert_selector(chain, bridge.vault_b, &deposit_with(&[])),
        Some(error_selector("ForkNotConfirmed(uint256)"))
    );
}
