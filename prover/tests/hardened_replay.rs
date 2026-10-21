//! Hardened two-chain tests of the light client: cross-chain replay (H-01, R2-09) and an invented next committee (HB-01).
//!
//! The oracle verifier signs whatever output the development source asserts. These tests tamper with or replay an output
//! that carries a VALID oracle signature. So the only thing that can refuse it is the light-client contract itself, which
//! is the defense under test. A real proof system would refuse some of these earlier (the program would not produce
//! the output), and the contract must still refuse them if a faulty proof system let one through.

mod common;

use alloy_primitives::{keccak256, B256};
use common::bridge::*;
use common::*;

fn head_of(chain: &TestChain, light_client: alloy_primitives::Address) -> u64 {
    use alloy_sol_types::SolCall;
    let call = zk_bridge_prover::contracts::LightClientContract::headCall {};
    u64::from_be_bytes(
        chain.call(light_client, &call.abi_encode()).unwrap()[24..]
            .try_into()
            .unwrap(),
    )
}

/// Claim: a light-client update that is valid for one chain's light client is refused by the other chain's light
/// client, in both directions, although both share the same checkpoint, the same committee hash, and the same signing
/// oracle.
/// Shows: the update for the light client of chain 369 (it tracks chain 1) is replayed into the light client of chain 1
/// (it tracks chain 369). It reverts with `GenesisValidatorsRootMismatch`. The reverse replay reverts the same way. The
/// controls are the same two updates sent to their own light clients: both succeed and move the head.
/// Why it matters: H-01 and R2-09. A committee signature without a domain is valid wherever its signers are trusted. The
/// light client binds itself to one chain by its genesis validators root, so an update for one chain cannot move the
/// head of the other. On a real chain the signed domain carries the same root, so a signature fails there as well.
#[test]
fn h01_r2_09_hardened_light_client_output_of_the_other_chain_is_refused() {
    if !tools_available() {
        return;
    }
    let bridge = deploy_bridge("h01-replay");
    for direction in [Direction::AToB, Direction::BToA] {
        let made = deposit_on(&bridge, direction, ONE_TOKEN);
        bridge.source(direction).mine(2);
        let block_number =
            zk_bridge_prover::rpc::parse_quantity(&made.receipt["blockNumber"]).unwrap();
        let update = update_calldata_for_block(&bridge, direction, block_number, |_| {});

        let own_destination = bridge.destination(direction);
        let own_light_client = bridge.destination_light_client(direction);
        let other_destination = bridge.source(direction);
        let other_light_client = bridge.destination_light_client(match direction {
            Direction::AToB => Direction::BToA,
            Direction::BToA => Direction::AToB,
        });
        assert_ne!(own_light_client, other_light_client);

        // The replay: the other light client refuses it for its genesis validators root.
        let head_before = head_of(other_destination, other_light_client);
        assert_eq!(
            revert_selector(other_destination, other_light_client, &update),
            Some(error_selector(
                "GenesisValidatorsRootMismatch(bytes32,bytes32)"
            )),
            "{direction:?}: refused for the chain it belongs to, not for another reason"
        );
        assert_eq!(
            head_of(other_destination, other_light_client),
            head_before,
            "{direction:?}: the other head did not move"
        );

        // The control: the same bytes move the head of their own light client.
        assert_eq!(
            revert_selector(own_destination, own_light_client, &update),
            None,
            "{direction:?}: the honest light client accepts it"
        );
        let own_before = head_of(own_destination, own_light_client);
        own_destination.send(Some(own_light_client), &update);
        assert!(
            head_of(own_destination, own_light_client) > own_before,
            "{direction:?}: the honest head moved"
        );
    }
}

/// Claim: an update whose starting store carries an invented next committee is refused by the light-client contract.
/// Shows: the asserted output names a start next committee that the contract does not store, so it reverts with
/// `StartNextSyncCommitteeMismatch(expected, actual)`. An invented current committee reverts with
/// `PreviousSyncCommitteeMismatch`. The control is the untouched output for the same block: it is accepted.
/// Why it matters: HB-01. The program starts from a private store. A caller could invent the next committee in that
/// store, have a later period signed by keys the caller chose, and so forge the head. The output therefore names the starting
/// next committee, and the contract compares it with what it stored (zero equals zero), so the private start is bound to
/// public state.
#[test]
fn hb01_hardened_update_from_a_store_with_an_invented_next_committee_is_refused() {
    if !tools_available() {
        return;
    }
    let bridge = deploy_bridge("hb01-invented-committee");
    let direction = Direction::AToB;
    let made = deposit_on(&bridge, direction, ONE_TOKEN);
    bridge.source(direction).mine(2);
    let block_number = zk_bridge_prover::rpc::parse_quantity(&made.receipt["blockNumber"]).unwrap();
    let (chain, light_client) = (
        bridge.destination(direction),
        bridge.destination_light_client(direction),
    );

    let invented: B256 = keccak256(b"a next committee that the attacker chose");
    let state = read_light_client_state(&bridge, direction);
    assert_eq!(
        state.next_committee_hash,
        B256::ZERO,
        "the checkpoint stores no next committee"
    );

    let forged_next = update_calldata_for_block(&bridge, direction, block_number, |output| {
        output.startNextSyncCommitteeHash = invented
    });
    assert_eq!(
        revert_selector(chain, light_client, &forged_next),
        Some(error_selector(
            "StartNextSyncCommitteeMismatch(bytes32,bytes32)"
        ))
    );

    let forged_current = update_calldata_for_block(&bridge, direction, block_number, |output| {
        output.previousSyncCommitteeHash = invented
    });
    assert_eq!(
        revert_selector(chain, light_client, &forged_current),
        Some(error_selector(
            "PreviousSyncCommitteeMismatch(bytes32,bytes32)"
        ))
    );

    // The head did not move for any forged output.
    assert_eq!(head_of(chain, light_client), state.head_slot);

    // Control: the honest output for the same block is accepted.
    let honest = update_calldata_for_block(&bridge, direction, block_number, |_| {});
    assert_eq!(revert_selector(chain, light_client, &honest), None);
    chain.send(Some(light_client), &honest);
    assert!(head_of(chain, light_client) > state.head_slot);
}
