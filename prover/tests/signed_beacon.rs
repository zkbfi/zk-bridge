//! The producer reads the synthetic signed beacon chain with `HttpBeaconSource`, the code that reads a live node.
//!
//! The node follows a list of execution blocks that the test extends. No Anvil is involved, so the test checks the beacon
//! side alone: the checkpoint tool, the update from a stored head to the newest final header, the update that the
//! light-client program accepts, and the beacon path of the withdrawal (the ancestry branch and the block hash branch)
//! against the generalized indices of `lc-core`. The Anvil run with real contracts is described in
//! `docs/end-to-end-real-proofs.md`.

mod common;

use alloy_primitives::B256;
use common::*;
use lc_core::ancestry::ancestry_leaf_gindex;
use lc_core::layout::BLOCK_HASH_GINDEX_CAPELLA;
use lc_core::ssz::is_valid_exact_branch;
use zk_bridge_prover::beacon::UpdatePlan;
use zk_bridge_prover::light_client::{verify_update_natively, ChainKind};
use zk_bridge_prover::local_network::signed_beacon::checkpoint::read_checkpoint;

/// The plan of an update, which the light client needs because it lags.
fn planned(plan: Option<UpdatePlan>) -> UpdatePlan {
    plan.expect("the light client lags, so the source must plan an update")
}

/// Claim: the checkpoint tool reads a header that the chain holds, the committee hashes of its state, and the genesis time
/// that the first block fixes, using the standard endpoints only. The checkpoint lies `finality_slots + 1` below the tip.
/// Why it matters: the deploy step writes these values into the light client contract. A checkpoint that the chain does
/// not hold would make the prover stop at its first pass.
#[test]
fn the_checkpoint_names_a_finalized_header_of_the_chain() {
    for kind in KINDS {
        let chain = Chain::new(kind, BLOCKS_BEFORE_CHECKPOINT);
        let checkpoint = read_checkpoint(&chain.node, kind).expect("checkpoint");
        let tip_slot = chain.first_slot() + BLOCKS_BEFORE_CHECKPOINT - 1;
        assert_eq!(checkpoint.slot, tip_slot - 3, "{kind:?}");
        assert_eq!(
            checkpoint.genesis_time,
            FIRST_TIMESTAMP - chain.first_slot() * kind.seconds_per_slot(),
            "{kind:?}"
        );
        assert_eq!(
            checkpoint.genesis_validators_root,
            kind.spec().genesis_validators_root
        );
        assert_ne!(
            checkpoint.committee_hash, checkpoint.next_committee_hash,
            "{kind:?}: two periods, two committees"
        );
        assert!(checkpoint
            .lines()
            .contains(&format!("slot={}", checkpoint.slot)));
    }
}

/// Claim: with the light client at the checkpoint and no newer final header, the source plans nothing. Once the chain
/// finalizes more, it plans a fold that the light-client program accepts, that starts at the checkpoint and ends after the
/// deposit. With the light client at the new head, the source plans nothing more, and the beacon path of the withdrawal
/// verifies: the ancestry branch from the anchor state to the deposit header, and the block hash branch from the deposit
/// header body to the execution block hash of the deposit.
/// Why it matters: this is the beacon half of a payout. The real proof proves the update, and the vault checks the path
/// against the generalized indices that `lc-core` names.
#[test]
fn a_deposit_is_covered_by_an_update_and_its_path_verifies() {
    for kind in KINDS {
        let chain = Chain::new(kind, BLOCKS_BEFORE_CHECKPOINT);
        let checkpoint = read_checkpoint(&chain.node, kind).expect("checkpoint");
        let head = head_at(&checkpoint);
        let source = chain.source();
        assert!(
            source.plan_update(&head).unwrap().is_none(),
            "{kind:?}: the checkpoint is the newest final header"
        );

        let deposit_number = BLOCKS_BEFORE_CHECKPOINT + 8;
        let deposit = chain.deposit(deposit_number);
        let deposit_slot = chain.first_slot() + deposit_number - 1;
        chain.mine(8);
        let plan = planned(source.plan_update(&head).unwrap());
        let output = verify_update_natively(&plan.input).unwrap();
        assert!(
            output.newHeadSlot < deposit_slot,
            "{kind:?}: the deposit is at the tip, so no final header covers it yet"
        );

        chain.mine(10);
        let plan = planned(source.plan_update(&head).unwrap());
        assert!(
            plan.input.store.next_sync_committee.is_some(),
            "{kind:?}: the checkpoint holds the next committee"
        );
        let output =
            verify_update_natively(&plan.input).unwrap_or_else(|error| panic!("{kind:?}: {error}"));
        assert!(output.newHeadSlot > deposit_slot, "{kind:?}");
        assert_eq!(output.previousHeadSlot, checkpoint.slot);
        assert_eq!(output.newHeadSlot, plan.latest_finalized_slot, "{kind:?}");

        let after = head_after(&output);
        assert!(
            source.plan_update(&after).unwrap().is_none(),
            "{kind:?}: the new head is the newest final header"
        );

        let path = source
            .withdrawal_path(&deposit, &after)
            .unwrap_or_else(|error| panic!("{kind:?}: {error}"));
        assert_eq!(path.anchor_header.hash_tree_root(), output.newHeaderRoot);
        assert_eq!(path.deposit_header.slot, deposit_slot);
        let gindex =
            ancestry_leaf_gindex(kind.spec(), path.anchor_header.slot, deposit_slot).unwrap();
        assert!(
            is_valid_exact_branch(
                &path.deposit_header.hash_tree_root(),
                &path.ancestry_branch,
                gindex,
                &path.anchor_header.state_root
            ),
            "{kind:?}: the deposit header is in the block roots of the anchor state"
        );
        assert!(
            is_valid_exact_branch(
                &deposit.hash,
                &path.block_hash_branch,
                BLOCK_HASH_GINDEX_CAPELLA,
                &path.deposit_header.body_root
            ),
            "{kind:?}: the deposit header holds the execution block hash"
        );
        assert!(
            !is_valid_exact_branch(
                &execution_hash(deposit_number + 1),
                &path.block_hash_branch,
                BLOCK_HASH_GINDEX_CAPELLA,
                &path.deposit_header.body_root
            ),
            "control: another block hash does not fit the branch"
        );
    }
}

/// Claim: a light client that lags the chain gets a fold that follows the newest final header, and the program accepts it.
/// With the head at the newest final header, the plan is empty.
#[test]
fn the_update_follows_the_newest_final_header() {
    for kind in KINDS {
        let chain = Chain::new(kind, BLOCKS_BEFORE_CHECKPOINT);
        let checkpoint = read_checkpoint(&chain.node, kind).expect("checkpoint");
        let head = head_at(&checkpoint);
        let source = chain.source();
        assert!(source.plan_update(&head).unwrap().is_none(), "{kind:?}");
        chain.mine(6);
        let plan = planned(source.plan_update(&head).unwrap());
        let output =
            verify_update_natively(&plan.input).unwrap_or_else(|error| panic!("{kind:?}: {error}"));
        assert_eq!(output.newHeadSlot, checkpoint.slot + 6, "{kind:?}");
        assert!(source.plan_update(&head_after(&output)).unwrap().is_none());
    }
}

/// Claim: a starting head that is not on the beacon chain of the node is refused, with the slot named.
/// Why it matters: a beacon URL for another chain would otherwise start a proof of a fold that the light client rejects.
#[test]
fn a_head_that_is_not_on_this_chain_is_refused() {
    let chain = Chain::new(ChainKind::Pulsechain, BLOCKS_BEFORE_CHECKPOINT);
    let checkpoint = read_checkpoint(&chain.node, ChainKind::Pulsechain).expect("checkpoint");
    let foreign = zk_bridge_prover::beacon::StoredHead {
        root: B256::repeat_byte(0xee),
        ..head_at(&checkpoint)
    };
    let error = chain
        .source()
        .plan_update(&foreign)
        .unwrap_err()
        .to_string();
    assert!(error.contains("is not on this beacon chain"), "{error}");
    assert!(
        error.contains(&format!("slot {}", checkpoint.slot)),
        "{error}"
    );
}

/// Claim: the layout evidence for the block hash row verifies against the body root of a stored header.
/// Why it matters: the vault accepts a layout row only when the branch of the execution block hash of a stored header fits
/// the candidate position.
#[test]
fn the_block_hash_layout_evidence_fits_the_stored_header() {
    for kind in KINDS {
        let chain = Chain::new(kind, BLOCKS_BEFORE_CHECKPOINT);
        let checkpoint = read_checkpoint(&chain.node, kind).expect("checkpoint");
        let source = chain.source();
        let evidence = source
            .hash_layout_evidence(checkpoint.slot, &[checkpoint.slot])
            .expect("evidence")
            .expect("the stored slot qualifies");
        let block_hash = execution_hash(checkpoint.slot - chain.first_slot() + 1);
        assert_eq!(evidence.gindex, BLOCK_HASH_GINDEX_CAPELLA);
        assert!(is_valid_exact_branch(
            &block_hash,
            &evidence.branch,
            evidence.gindex,
            &evidence.header.body_root
        ));
        assert_eq!(evidence.header.hash_tree_root(), checkpoint.header_root);
    }
}
