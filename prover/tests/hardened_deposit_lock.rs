//! Hardened two-chain tests of the deposit lock: a vault refuses deposits until it can prove that the light client on the
//! other chain stored a head.
//!
//! Finding of the end to end run (`docs/end-to-end-real-proofs.md`): a deposit on chain X before the destination light
//! client on chain Y stored its first update can never be paid. So a new vault is locked, and `openDeposits` opens it
//! with a REAL `eth_getProof` proof of the storage of the remote light client. These tests use the production code of
//! `follow` and `opening.rs`. Nothing is faked: Anvil serves the state proofs.

mod common;

use alloy_primitives::{Bytes, U256};
use alloy_sol_types::SolCall;
use common::bridge::*;
use common::*;
use std::time::Duration;
use zk_bridge_prover::chain::ChainClient;
use zk_bridge_prover::contracts::{
    deposit_calldata, open_deposits_calldata, LightClientContract, TokenContract, VaultContract,
};
use zk_bridge_prover::light_client::rebuild_execution_header;
use zk_bridge_prover::opening::{
    assemble_opening_proof, decode_entry_proof, execution_block_hash_slot, open_source_vault,
    OpeningOutcome, OpeningTarget,
};
use zk_bridge_prover::rpc::HttpRpc;

fn locked_bridge(name: &str) -> Bridge {
    deploy_bridge_with(
        name,
        BridgeOptions {
            open_vaults: false,
            ..Default::default()
        },
    )
}

fn deposits_open(chain: &TestChain, vault: alloy_primitives::Address) -> bool {
    gate_flag(
        chain,
        vault,
        &VaultContract::depositsOpenCall {}.abi_encode(),
    )
}

/// A client of a test chain that signs as the deployer, as the prover does.
fn signing_client(chain: &TestChain) -> ChainClient {
    ChainClient::connect(
        "test",
        chain.anvil.chain_id,
        Box::new(HttpRpc::new(&chain.anvil.url)),
        Some(deployer_signer()),
    )
    .expect("client")
}

/// The target of the opening of the vault that a direction deposits into.
fn target_of(bridge: &Bridge, direction: Direction) -> OpeningTarget {
    OpeningTarget {
        vault: bridge.source_vault(direction),
        destination_light_client: bridge.destination_light_client(direction),
        receipt_timeout: Duration::from_secs(20),
    }
}

fn try_to_open(bridge: &Bridge, direction: Direction) -> OpeningOutcome {
    open_source_vault(
        &signing_client(bridge.source(direction)),
        &signing_client(bridge.destination(direction)),
        &target_of(bridge, direction),
    )
    .expect("the opening attempt")
}

/// Mints and approves, then sends a deposit that the vault refuses, and returns the revert data.
fn refused_deposit(bridge: &Bridge, direction: Direction, amount: u128) -> Vec<u8> {
    let (chain, vault, token) = (
        bridge.source(direction),
        bridge.source_vault(direction),
        bridge.source_token(direction),
    );
    chain.send(
        Some(token),
        &TokenContract::mintCall {
            to: DEPLOYER,
            amount: U256::from(amount),
        }
        .abi_encode(),
    );
    chain.send(
        Some(token),
        &TokenContract::approveCall {
            spender: vault,
            amount: U256::from(amount),
        }
        .abi_encode(),
    );
    let evidence = gate_evidence(chain, bridge.source_gate(direction));
    let receipt = chain.send_allowing_failure(
        Some(vault),
        &deposit_calldata(token, RECIPIENT, U256::from(amount), 0, &evidence),
    );
    assert_eq!(receipt["status"], "0x0", "the vault refuses the deposit");
    chain.revert_data_of(&receipt["transactionHash"])
}

/// Claim: on a fresh deployment, a deposit on either chain reverts with `DepositsNotOpen`, and the tokens stay in the
/// wallet of the depositor.
/// Why it matters: this is the lock itself. Before it, such a deposit was accepted and could never be paid.
#[test]
fn a_deposit_on_a_fresh_deployment_reverts_with_deposits_not_open() {
    if !tools_available() {
        return;
    }
    let bridge = locked_bridge("lock-fresh");
    for direction in [Direction::AToB, Direction::BToA] {
        let chain = bridge.source(direction);
        assert!(!deposits_open(chain, bridge.source_vault(direction)));
        let revert = refused_deposit(&bridge, direction, ONE_TOKEN);
        assert_eq!(
            revert[..4],
            error_selector("DepositsNotOpen()"),
            "{direction:?}"
        );
        assert_eq!(
            balance(chain, bridge.source_token(direction), DEPLOYER),
            U256::from(ONE_TOKEN),
            "{direction:?}: the tokens are still in the wallet"
        );
        assert_eq!(
            balance(
                chain,
                bridge.source_token(direction),
                bridge.source_vault(direction)
            ),
            U256::ZERO,
            "{direction:?}: the vault took nothing"
        );
    }
}

/// Claim: the first run of `follow` leaves both vaults locked and exits with code 2, naming why. After the blocks that
/// finalize the first updates, the second run opens both vaults, and a third run finds them open. A deposit then works.
/// Shows: the opening transactions carry the `DepositsOpened` event, the exit codes are 2, 0 and 0, and the lines of the
/// output are the documented ones.
/// Why it matters: this is the operator sequence of the documentation. The reverse route needs a block that finalized
/// after the first update, so the second run follows the first.
#[test]
fn follow_opens_both_vaults_on_the_second_run() {
    if !tools_available() {
        return;
    }
    let bridge = locked_bridge("lock-follow");

    let first = follow(&bridge);
    assert_eq!(first.code, 2, "{}", first.output);
    assert_eq!(
        first.output.matches("deposits locked: ").count(),
        2,
        "{}",
        first.output
    );
    assert!(!deposits_open(&bridge.chain_a, bridge.vault_a));
    assert!(!deposits_open(&bridge.chain_b, bridge.vault_b));

    bridge.chain_a.mine(bridge.finality_depth);
    bridge.chain_b.mine(bridge.finality_depth);
    let second = follow(&bridge);
    assert_eq!(second.code, 0, "{}", second.output);
    assert_eq!(
        second
            .output
            .matches("deposits opened (transaction ")
            .count(),
        2,
        "{}",
        second.output
    );
    assert!(deposits_open(&bridge.chain_a, bridge.vault_a));
    assert!(deposits_open(&bridge.chain_b, bridge.vault_b));
    for (chain, vault) in [
        (&bridge.chain_a, bridge.vault_a),
        (&bridge.chain_b, bridge.vault_b),
    ] {
        let topic = alloy_primitives::keccak256("DepositsOpened(uint64,bytes32,uint64)");
        let logs = client_of(chain)
            .logs(vault, topic, 0, chain.block_number())
            .unwrap();
        assert_eq!(logs.len(), 1, "one DepositsOpened event");
    }

    let third = follow(&bridge);
    assert_eq!(third.code, 0, "{}", third.output);
    assert_eq!(
        third.output.matches("deposits open").count(),
        2,
        "{}",
        third.output
    );
    assert!(
        !third.output.contains("opened (transaction"),
        "{}",
        third.output
    );
}

/// Claim: the harness opens both vaults in two runs of `follow` with the default finality depth, and in two runs with a
/// deeper one too, because it mines as many blocks as the depth between the runs.
/// Why it matters: the number of runs and blocks is what the scripts and the documentation tell an operator. A change of
/// the finality rule must change this test and those texts together.
#[test]
fn the_harness_opens_both_vaults_in_two_runs() {
    if !tools_available() {
        return;
    }
    for depth in [1, 3] {
        let bridge = deploy_bridge_with(
            "lock-run-count",
            BridgeOptions {
                open_vaults: false,
                finality_depth: depth,
                ..Default::default()
            },
        );
        assert_eq!(open_both_vaults(&bridge), 2, "finality depth {depth}");
        assert!(deposits_open(&bridge.chain_a, bridge.vault_a));
        assert!(deposits_open(&bridge.chain_b, bridge.vault_b));
    }
}

/// Claim: the first deposit after the opening is paid end to end by the prover, in both directions, with real state
/// proofs behind the opening.
/// Shows: the bridge opens through `follow`, a first deposit is made on each chain, `once` pays each of them, and the
/// recipient holds exactly the amounts.
/// Why it matters: this is the point of the lock. Without it the first deposit waits for a head that no update can
/// provide in time.
#[test]
fn the_first_deposit_after_the_opening_is_paid() {
    if !tools_available() {
        return;
    }
    let bridge = deploy_bridge("lock-first-deposit");
    for direction in [Direction::AToB, Direction::BToA] {
        fund_destination_vault(&bridge, direction, 1_000 * ONE_TOKEN);
    }
    for direction in [Direction::AToB, Direction::BToA] {
        let destination = bridge.destination(direction);
        let token = bridge.destination_token(direction);
        let before = balance(destination, token, RECIPIENT);
        let made = deposit_on(&bridge, direction, 3 * ONE_TOKEN);
        bridge.source(direction).mine(2);
        run(&bridge, &["once"]).expect("once");
        assert_eq!(
            balance(destination, token, RECIPIENT),
            before + U256::from(3 * ONE_TOKEN),
            "{direction:?}: the first deposit is paid"
        );
        assert!(claimed(
            destination,
            bridge.destination_vault(direction),
            made.nonce
        ));
        assert_eq!(state_of(&bridge, made.nonce), "confirmed");
    }
}

/// Claim: a vault whose destination light client has no update cannot be opened, and the attempt sends nothing. The
/// contract refuses even a REAL proof of an empty entry.
/// Shows, in order: (1) with no update on either chain the attempt says that the source light client stored no update.
/// (2) With the light client of chain A updated with a block of chain B, but the light client of chain B still empty, the
/// attempt says that the destination light client had stored no update in that block, and the vault stays locked.
/// (3) The proof of the empty entry, built from `eth_getProof` as the prover builds it, makes `openDeposits` revert (the
/// trie library refuses a key that is not in the trie). Anvil serves proofs at past block numbers: the proof is read at the block that the light client
/// of chain A stored, not at the latest block.
/// Why it matters: an opening without an update behind it would put back the lost deposits that the lock prevents.
#[test]
fn a_vault_whose_destination_light_client_has_no_update_cannot_be_opened() {
    if !tools_available() {
        return;
    }
    let bridge = locked_bridge("lock-not-ready");
    let nonce_before = bridge.chain_a.nonce(DEPLOYER);

    // (1) No update on either chain.
    assert_eq!(
        try_to_open(&bridge, Direction::AToB),
        OpeningOutcome::NotReady {
            reason: "the light client on the source chain stored no update yet".into()
        }
    );

    // (2) The light client of chain A stores a block of chain B, and the light client of chain B stays empty.
    bridge.chain_b.mine(3);
    let stored_block = bridge.chain_b.block_number() - 1;
    bridge.chain_a.send(
        Some(bridge.light_client_a),
        &update_calldata_for_block(&bridge, Direction::BToA, stored_block, |_| {}),
    );
    let outcome = try_to_open(&bridge, Direction::AToB);
    let OpeningOutcome::NotReady { reason } = outcome else {
        panic!("the vault must not open: {outcome:?}");
    };
    assert_eq!(
        reason,
        format!("the destination light client had stored no update in block {stored_block}")
    );
    assert!(!deposits_open(&bridge.chain_a, bridge.vault_a));
    assert_eq!(
        bridge.chain_a.nonce(DEPLOYER),
        nonce_before + 1,
        "only the light client update was sent on chain A, and no openDeposits"
    );

    // (3) The real proof of the empty entry is refused by the contract.
    let chain_a = client_of(&bridge.chain_a);
    let chain_b = client_of(&bridge.chain_b);
    let remote_slot = chain_a
        .view(bridge.light_client_a, LightClientContract::headCall {})
        .unwrap();
    let stored_hash = chain_a
        .view(
            bridge.light_client_a,
            LightClientContract::executionBlockHashesCall { slot: remote_slot },
        )
        .unwrap();
    let block = chain_b.block_by_hash(stored_hash).unwrap().expect("block");
    let header = rebuild_execution_header(&block).expect("header");
    let stored_slot = chain_b
        .view_at(
            bridge.light_client_b,
            LightClientContract::headCall {},
            stored_block,
        )
        .unwrap();
    let slot = execution_block_hash_slot(stored_slot);
    let entry = decode_entry_proof(
        &chain_b
            .account_proof(bridge.light_client_b, &[slot], stored_block)
            .unwrap(),
        slot,
    )
    .unwrap();
    assert_eq!(entry.value, U256::ZERO, "the entry is empty");
    let calldata = open_deposits_calldata(assemble_opening_proof(
        remote_slot,
        header.header_rlp,
        stored_slot,
        entry,
    ));
    let refusal = bridge
        .chain_a
        .call(bridge.vault_a, &calldata)
        .expect_err("the contract refuses the proof of an empty entry");
    let revert = refusal.revert_data().expect("revert data");
    // The trie library reverts with a message, because a key that is not in the trie has no value to return. The contract
    // error `OpeningEntryEmpty` covers a present but empty value, which a state trie never holds.
    assert_eq!(revert[..4], error_selector("Error(string)"));
    println!(
        "REFUSAL of a proof of an empty entry: {}",
        String::from_utf8_lossy(&revert[4..])
            .chars()
            .filter(|character| character.is_ascii_graphic() || *character == ' ')
            .collect::<String>()
    );

    // A proof that names another header than the stored one is refused too.
    let wrong = open_deposits_calldata(assemble_opening_proof(
        remote_slot,
        Bytes::from(vec![0xc0]),
        stored_slot,
        decode_entry_proof(
            &chain_b
                .account_proof(bridge.light_client_b, &[slot], stored_block)
                .unwrap(),
            slot,
        )
        .unwrap(),
    ));
    assert_eq!(
        revert_selector(&bridge.chain_a, bridge.vault_a, &wrong),
        Some(error_selector("OpeningHeaderMismatch(bytes32,bytes32)")),
        "a header that hashes to another value than the stored hash is refused"
    );
}
