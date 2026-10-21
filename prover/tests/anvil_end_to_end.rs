//! Integration tests on local Anvil chains. They deploy the hardened contracts built by forge.
//!
//! Chain 1 (the Ethereum role) runs Anvil on `cancun`. Anvil does not deploy the EIP-4788 beacon roots contract, so
//! the tests install the genuine runtime code at its address and write the beacon roots by hand. The deposit gate
//! of chain 1 is `Enforcing`. Chain 369 (the PulseChain role) runs on `shanghai`, which has no EIP-4788. Its gate is
//! `DetectBeaconRoots`, so it admits every deposit and never needs evidence.
//!
//! Why two Anvil processes and not one: `BridgeVault` requires `localChainId == block.chainid` and a remote chain
//! identifier that differs from it, and a withdrawal needs the deposit's target chain to equal the withdrawing
//! vault's local chain. One chain has one identifier, so no pair of vaults can satisfy both on one Anvil.
//! The chains here are chain 1 (the Ethereum role) and chain 369 (the PulseChain role).
//!
//! Every test skips with a message when `anvil` or `forge` is missing.

mod common;

use alloy_primitives::{hex, keccak256, Bytes, B256, U256};
use alloy_sol_types::{sol, SolCall};
use common::bridge::*;
use common::*;
use std::collections::HashMap;
use zk_bridge_prover::contracts::{deposit_calldata, TokenContract};
use zk_bridge_prover::gate::{gate_evidence_for_deposit, GateContract};
use zk_bridge_prover::prover::{oracle_digest, OracleProver, ProofStatement, Prover};

sol! {
    interface OracleVerifier {
        function verifyProof(bytes32 programVKey, bytes publicValues, bytes proofBytes) external view;
    }
}

/// Claim: a proof made by `OracleProver` is accepted by the Solidity `OracleSP1Verifier`, byte for byte, and
/// every change to the digest inputs or the signature is rejected.
/// Why it matters: the Rust digest `keccak256(programVKey ‖ sha256(publicValues))` must equal the Solidity one.
/// A mismatch would make every light-client update revert on chain. The controls show the test can fail.
#[test]
fn oracle_signature_is_accepted_by_the_solidity_mock() {
    if !tools_available() {
        return;
    }
    let chain = TestChain::start(1, Hardfork::Shanghai);
    let verifier = chain.deploy("OracleSP1Verifier", HashMap::from([("oracle", word_address(DEPLOYER))]));

    let output = zk_bridge_prover::light_client::dev_output(
        B256::repeat_byte(1), 7, B256::repeat_byte(2), B256::repeat_byte(3), B256::repeat_byte(4),
        B256::repeat_byte(5), 9, B256::repeat_byte(6), 11,
    );
    let vkey = keccak256(b"program");
    let proof = OracleProver::new(deployer_signer()).prove(vkey, &ProofStatement::DevAsserted(output)).unwrap();
    assert_eq!(proof.public_values.len(), 352);

    let verify = |vkey: B256, values: &[u8], signature: &[u8]| {
        let call = OracleVerifier::verifyProofCall { programVKey: vkey, publicValues: Bytes::copy_from_slice(values), proofBytes: Bytes::copy_from_slice(signature) };
        chain.call(verifier, &call.abi_encode())
    };
    assert!(verify(vkey, &proof.public_values, &proof.proof_bytes).is_ok(), "the Solidity mock must accept the Rust proof");
    assert_eq!(oracle_digest(vkey, &proof.public_values), {
        // The digest the mock builds, spelled out from its source: keccak256(abi.encodePacked(vkey, sha256(values))).
        let mut packed = vkey.to_vec();
        packed.extend_from_slice(alloy_primitives::hex::decode(sha256_hex(&proof.public_values)).unwrap().as_slice());
        keccak256(packed)
    });

    // Controls: each change must be refused with a revert.
    let mut other_values = proof.public_values.clone();
    other_values[40] ^= 1;
    assert!(verify(vkey, &other_values, &proof.proof_bytes).is_err(), "changed public values");
    assert!(verify(keccak256(b"other"), &proof.public_values, &proof.proof_bytes).is_err(), "changed key");
    let mut flipped = proof.proof_bytes.clone();
    flipped[3] ^= 1;
    assert!(verify(vkey, &proof.public_values, &flipped).is_err(), "changed signature");
    assert!(verify(vkey, &proof.public_values, &proof.proof_bytes[..64]).is_err(), "short signature");
}

fn sha256_hex(data: &[u8]) -> String {
    hex::encode(zk_bridge_prover::light_client::sha256(data))
}

/// Claim: `once` takes a deposit on chain A to a paid withdrawal on chain B through `DevBeaconSource`: it advances
/// the light client with oracle-signed updates, adds the vault layout rows, verifies natively, and calls `withdraw`.
/// A second `once` changes nothing. `withdraw --tx --log-index` delivers a second deposit by hand.
/// Why it matters: this is the whole service against the real hardened contracts. Any mismatch between the Rust
/// builders and the Solidity checks (branches, gindices, receipt proof, signature) makes a transaction revert here.
#[test]
fn a_deposit_completes_end_to_end_through_the_dev_source() {
    if !tools_available() {
        return;
    }
    let bridge = deploy_bridge("end-to-end");
    // The destination vault needs liquidity: the vault pays from its own balance.
    bridge.chain_b.send(Some(bridge.token_b), &TokenContract::mintCall { to: bridge.vault_b, amount: U256::from(1_000 * ONE_TOKEN) }.abi_encode());

    let amount = 5 * ONE_TOKEN;
    let (_, _, nonce) = deposit(&bridge, amount);
    // Depth 1: the deposit block is final once one more block exists. Mine two to be sure.
    bridge.chain_a.mine(2);
    assert!(!claimed(&bridge.chain_b, bridge.vault_b, nonce));

    run(&bridge, &["once"]).expect("once");
    assert_eq!(balance(&bridge.chain_b, bridge.token_b, RECIPIENT), U256::from(amount), "the recipient was paid on chain B");
    assert!(claimed(&bridge.chain_b, bridge.vault_b, nonce));
    let status = run(&bridge, &["status"]).unwrap();
    assert!(status.contains(&format!("nonce={nonce:#x} route=a_to_b state=confirmed")), "{status}");

    // A second pass is a no-op: no new transaction on chain B.
    let nonce_before = bridge.chain_b.nonce(DEPLOYER);
    run(&bridge, &["once"]).expect("second once");
    assert_eq!(bridge.chain_b.nonce(DEPLOYER), nonce_before, "an idempotent pass sends nothing");
    assert_eq!(balance(&bridge.chain_b, bridge.token_b, RECIPIENT), U256::from(amount));

    // A second deposit, delivered by the manual command. The log index is the index inside the receipt.
    let (receipt, log_index, second_nonce) = deposit(&bridge, 3 * ONE_TOKEN);
    assert!(log_index > 0, "the token transfer log comes before the deposit log, so the receipt index is not 0");
    bridge.chain_a.mine(2);
    let transaction = receipt["transactionHash"].as_str().unwrap().to_string();
    run(&bridge, &["withdraw", "--tx", &transaction, "--log-index", &log_index.to_string()]).expect("withdraw");
    assert!(claimed(&bridge.chain_b, bridge.vault_b, second_nonce));
    assert_eq!(balance(&bridge.chain_b, bridge.token_b, RECIPIENT), U256::from(8 * ONE_TOKEN));
    let status = run(&bridge, &["status"]).unwrap();
    assert!(status.contains("deposits=2"), "{status}");
    assert_eq!(status.matches("state=confirmed").count(), 2, "{status}");
}

/// Claim: a deposit whose block is not yet final is not read, so nothing is withdrawn; once the block is final the
/// same `once` pass delivers it.
/// Why it matters: the service must read only final source blocks (the depth rule on Anvil).
#[test]
fn an_unfinalized_deposit_is_not_withdrawn() {
    if !tools_available() {
        return;
    }
    let bridge = deploy_bridge("unfinalized");
    bridge.chain_b.send(Some(bridge.token_b), &TokenContract::mintCall { to: bridge.vault_b, amount: U256::from(100 * ONE_TOKEN) }.abi_encode());
    let (_, _, nonce) = deposit(&bridge, ONE_TOKEN);
    // The deposit block is the latest block: with depth 1 it is not final.
    run(&bridge, &["once"]).expect("once");
    assert!(!claimed(&bridge.chain_b, bridge.vault_b, nonce));
    assert!(run(&bridge, &["status"]).unwrap().contains("deposits=0"));
    bridge.chain_a.mine(2);
    run(&bridge, &["once"]).expect("once");
    assert!(claimed(&bridge.chain_b, bridge.vault_b, nonce));
}

/// Claim: the Enforcing gate of chain A wants a fork proof in a stale epoch, and the proof from the builder admits
/// the deposit. A deposit with empty evidence reverts with `ForkNotConfirmed`. The builder sends empty evidence when
/// the epoch is confirmed, and builds a proof again after the clock moves into the next epoch.
/// Why it matters: this checks the evidence builder against the real `BeaconForkGate` code: the decoder, the
/// beacon roots lookup, the header root, the epoch rule and the generalized index of the version leaf.
/// The controls show the test can fail: empty evidence reverts, and evidence for another version reverts too.
#[test]
fn an_enforcing_gate_takes_the_built_evidence_once_per_epoch() {
    if !tools_available() {
        return;
    }
    let bridge = deploy_bridge("enforcing-gate");
    let chain = &bridge.chain_a;
    let amount = ONE_TOKEN;
    chain.send(Some(bridge.token_a), &TokenContract::mintCall { to: DEPLOYER, amount: U256::from(10 * amount) }.abi_encode());
    chain.send(Some(bridge.token_a), &TokenContract::approveCall { spender: bridge.vault_a, amount: U256::from(10 * amount) }.abi_encode());
    let call = |evidence: &[u8]| deposit_calldata(bridge.token_a, RECIPIENT, U256::from(amount), 0, evidence);

    let enforcing = chain.call(bridge.gate_a, &GateContract::enforcingCall {}.abi_encode()).unwrap();
    assert_eq!(enforcing.last(), Some(&1), "chain A starts enforcing");
    assert!(!confirmed_epoch(chain, bridge.gate_a).1);

    // Control 1: empty evidence in an unconfirmed epoch reverts with ForkNotConfirmed(epoch).
    let selector = &keccak256("ForkNotConfirmed(uint256)")[..4];
    assert_eq!(revert_selector(chain, bridge.vault_a, &call(&[])).as_ref().map(|s| &s[..]), Some(selector));

    // Control 2: a proof of another version (not in the supported list) reverts with UnsupportedVersion.
    let wrong = SyntheticForkSource { chain, version: [9, 9, 9, 9], requests: Default::default() };
    let wrong_evidence = gate_evidence_for_deposit(&client_of(chain), bridge.gate_a, &wrong).unwrap();
    let selector = &keccak256("UnsupportedVersion(bytes4)")[..4];
    assert_eq!(revert_selector(chain, bridge.vault_a, &call(&wrong_evidence)).as_ref().map(|s| &s[..]), Some(selector));

    // The built evidence admits the deposit and confirms the epoch.
    let source = SyntheticForkSource { chain, version: CAPELLA_VERSION, requests: Default::default() };
    let client = client_of(chain);
    let evidence = gate_evidence_for_deposit(&client, bridge.gate_a, &source).unwrap();
    assert!(!evidence.is_empty());
    chain.send(Some(bridge.vault_a), &call(&evidence));
    let (epoch, exists) = confirmed_epoch(chain, bridge.gate_a);
    assert!(exists);
    let current = GateContract::currentEpochCall::abi_decode_returns(&chain.call(bridge.gate_a, &GateContract::currentEpochCall {}.abi_encode()).unwrap()).unwrap();
    assert_eq!(U256::from(epoch), current);

    // Same epoch: the builder sends empty evidence, and the deposit passes. The source is not asked.
    let before = source.requests.load(std::sync::atomic::Ordering::SeqCst);
    let again = gate_evidence_for_deposit(&client, bridge.gate_a, &source).unwrap();
    assert!(again.is_empty());
    assert_eq!(source.requests.load(std::sync::atomic::Ordering::SeqCst), before);
    chain.send(Some(bridge.vault_a), &call(&again));

    // The next epoch: the confirmation is stale, empty evidence reverts, and the builder asks the source again.
    chain.advance_time(EPOCH_SECONDS + 10);
    assert!(revert_selector(chain, bridge.vault_a, &call(&[])).is_some(), "stale epoch, empty evidence");
    let fresh = gate_evidence_for_deposit(&client, bridge.gate_a, &source).unwrap();
    assert!(!fresh.is_empty());
    chain.send(Some(bridge.vault_a), &call(&fresh));
    assert!(confirmed_epoch(chain, bridge.gate_a).0 > epoch);
}

/// Claim: the gate on chain B (shanghai, no beacon roots contract, DetectBeaconRoots) admits a deposit with empty
/// evidence, stays in detection mode, and the builder asks for no evidence.
/// Why it matters: the PulseChain vault must keep working while the chain has no EIP-4788.
#[test]
fn a_detecting_gate_admits_deposits_without_evidence() {
    if !tools_available() {
        return;
    }
    let bridge = deploy_bridge("detecting-gate");
    let chain = &bridge.chain_b;
    let amount = ONE_TOKEN;
    chain.send(Some(bridge.token_b), &TokenContract::mintCall { to: DEPLOYER, amount: U256::from(amount) }.abi_encode());
    chain.send(Some(bridge.token_b), &TokenContract::approveCall { spender: bridge.vault_b, amount: U256::from(amount) }.abi_encode());
    let source = SyntheticForkSource { chain, version: CAPELLA_VERSION, requests: Default::default() };
    let evidence = gate_evidence_for_deposit(&client_of(chain), bridge.gate_b, &source).unwrap();
    assert!(evidence.is_empty());
    assert_eq!(source.requests.load(std::sync::atomic::Ordering::SeqCst), 0);
    chain.send(Some(bridge.vault_b), &deposit_calldata(bridge.token_b, RECIPIENT, U256::from(amount), 0, &evidence));
    let enforcing = chain.call(bridge.gate_b, &GateContract::enforcingCall {}.abi_encode()).unwrap();
    assert_eq!(enforcing.last(), Some(&0), "the gate is still detecting");
    assert_eq!(confirmed_epoch(chain, bridge.gate_b), (0, false));
}

/// Claim: a deposit made after more than 2048 blocks (more than 8192 beacon slots in the dev chain) is delivered. The
/// first light-client update jumps from the checkpoint at slot 1 to slot 1024 + 4 * 2200, past the old 8192-slot cap.
/// Why it matters: the contract lost its head-jump cap in the same change that added the historical path. If the
/// contract or the dev source kept a cap, a chain with a long history could not be served at all.
#[test]
fn a_head_jump_of_more_than_8192_slots_is_accepted() {
    if !tools_available() {
        return;
    }
    let bridge = deploy_bridge("long-jump");
    bridge.chain_b.send(Some(bridge.token_b), &TokenContract::mintCall { to: bridge.vault_b, amount: U256::from(100 * ONE_TOKEN) }.abi_encode());
    bridge.chain_a.mine(2_200);
    settle_in_epoch(&bridge.chain_a, bridge.gate_a);
    let (_, _, nonce) = deposit(&bridge, ONE_TOKEN);
    bridge.chain_a.mine(2);
    run(&bridge, &["once"]).expect("once");
    assert!(claimed(&bridge.chain_b, bridge.vault_b, nonce));
    let head = zk_bridge_prover::contracts::LightClientContract::headCall::abi_decode_returns(
        &bridge
            .chain_b
            .call(
                // The light client of chain B is the contract deployed third on that chain (nonce 3 after the dummy transaction).
                DEPLOYER.create(3),
                &zk_bridge_prover::contracts::LightClientContract::headCall {}.abi_encode(),
            )
            .unwrap(),
    )
    .unwrap();
    assert!(head > 1 + 8192, "the head moved by {} slots in the first step", head - 1);
}
