//! The prover reads the synthetic signed beacon chain with `HttpBeaconSource`, the code that reads a live node.
//!
//! The node follows a list of execution blocks that the test extends. No Anvil is involved, so the test checks the beacon
//! side alone: the checkpoint tool, the light-client plan for a deposit, the update that the light-client program accepts,
//! and the beacon path of the withdrawal (the ancestry branch and the block hash branch) against the generalized indices
//! of `lc-core`. The Anvil run with real contracts is described in `docs/end-to-end-real-proofs.md`.

use alloy_primitives::{keccak256, Address, B256, U256};
use lc_core::ancestry::ancestry_leaf_gindex;
use lc_core::layout::BLOCK_HASH_GINDEX_CAPELLA;
use lc_core::ssz::is_valid_exact_branch;
use lc_testkit::block_bytes::PayloadFields;
use std::sync::{Arc, Mutex};
use zk_bridge_prover::beacon::http::HttpBeaconSource;
use zk_bridge_prover::beacon::{BeaconSource, DepositBlock, LightClientState, UpdatePlan};
use zk_bridge_prover::chain::ExecutionReader;
use zk_bridge_prover::error::{Error, Result};
use zk_bridge_prover::light_client::{verify_update_natively, ChainKind, LightClientOutput};
use zk_bridge_prover::local_network::signed_beacon::checkpoint::{read_checkpoint, Checkpoint};
use zk_bridge_prover::local_network::signed_beacon::node::{
    default_first_slot, BeaconNode, BlockFeed, NodeSettings,
};
use zk_bridge_prover::prover::ProofStatement;

/// The timestamp of execution block 1. Genesis follows from it and from the first slot.
const FIRST_TIMESTAMP: u64 = 1_800_000_000;
/// Blocks before the checkpoint, and blocks after it.
const BLOCKS_BEFORE_CHECKPOINT: u64 = 12;

struct Feed(Mutex<Vec<PayloadFields>>);

/// The node owns its feed, and the test keeps a second handle to mine blocks.
struct SharedFeed(Arc<Feed>);

impl BlockFeed for SharedFeed {
    fn latest_number(&self) -> Result<u64> {
        Ok(self.0 .0.lock().unwrap().len() as u64)
    }

    fn payload(&self, number: u64) -> Result<PayloadFields> {
        let blocks = self.0 .0.lock().unwrap();
        blocks
            .get(number as usize - 1)
            .cloned()
            .ok_or_else(|| Error::Malformed(format!("block {number} is unknown")))
    }
}

/// Answers the three questions that the beacon sources ask of the execution chain. The HTTP source asks none of them.
struct NoExecution;

impl ExecutionReader for NoExecution {
    fn latest_block_number(&self) -> Result<u64> {
        Err(Error::Usage(
            "the HTTP source does not read the execution chain".into(),
        ))
    }

    fn block_hash(&self, _number: u64) -> Result<B256> {
        Err(Error::Usage(
            "the HTTP source does not read the execution chain".into(),
        ))
    }

    fn finalized_tag_block_number(&self) -> Result<Option<u64>> {
        Err(Error::Usage(
            "the HTTP source does not read the execution chain".into(),
        ))
    }
}

fn execution_hash(number: u64) -> B256 {
    keccak256(format!("anvil block {number}"))
}

fn payload(number: u64, seconds_per_slot: u64) -> PayloadFields {
    PayloadFields {
        parent_hash: execution_hash(number - 1),
        fee_recipient: Address::repeat_byte(0x0f),
        state_root: keccak256(b"state"),
        receipts_root: keccak256(format!("receipts {number}")),
        logs_bloom: vec![0u8; 256],
        prev_randao: keccak256(b"randao"),
        block_number: number,
        gas_limit: 30_000_000,
        gas_used: 21_000,
        timestamp: FIRST_TIMESTAMP + (number - 1) * seconds_per_slot,
        extra_data: Vec::new(),
        base_fee_per_gas: U256::from(7u64),
        block_hash: execution_hash(number),
    }
}

/// A node over a chain that the test mines forward.
struct Chain {
    kind: ChainKind,
    feed: Arc<Feed>,
    node: Arc<BeaconNode>,
}

impl Chain {
    fn new(kind: ChainKind, blocks: u64) -> Self {
        let feed = Arc::new(Feed(Mutex::new(Vec::new())));
        let node = Arc::new(BeaconNode::new(
            Box::new(SharedFeed(feed.clone())),
            NodeSettings {
                kind,
                first_slot: default_first_slot(kind),
                finality_slots: 2,
                participants: 400,
            },
        ));
        let chain = Self { kind, feed, node };
        chain.mine(blocks);
        chain
    }

    fn mine(&self, count: u64) {
        let mut blocks = self.feed.0.lock().unwrap();
        for _ in 0..count {
            let number = blocks.len() as u64 + 1;
            blocks.push(payload(number, self.kind.seconds_per_slot()));
        }
    }

    fn source(&self) -> HttpBeaconSource {
        HttpBeaconSource::new(self.kind, Box::new(self.node.clone()))
    }

    fn first_slot(&self) -> u64 {
        default_first_slot(self.kind)
    }

    fn deposit(&self, number: u64) -> DepositBlock {
        DepositBlock {
            number,
            hash: execution_hash(number),
            timestamp: payload(number, self.kind.seconds_per_slot()).timestamp,
        }
    }
}

/// What a light client that starts at a checkpoint holds.
fn state_at(chain: &Chain, checkpoint: &Checkpoint) -> LightClientState {
    LightClientState {
        head_slot: checkpoint.slot,
        head_root: checkpoint.header_root,
        head_execution_hash: execution_hash(checkpoint.slot - chain.first_slot() + 1),
        genesis_validators_root: checkpoint.genesis_validators_root,
        slots_per_period: 8192,
        head_committee_hash: checkpoint.committee_hash,
        next_committee_hash: checkpoint.next_committee_hash,
    }
}

/// What a light client holds after an update that the program accepted.
fn state_after(output: &LightClientOutput) -> LightClientState {
    LightClientState {
        head_slot: output.newHeadSlot,
        head_root: output.newHeaderRoot,
        head_execution_hash: output.executionBlockHash,
        genesis_validators_root: output.genesisValidatorsRoot,
        slots_per_period: 8192,
        head_committee_hash: output.syncCommitteeHash,
        next_committee_hash: output.startNextSyncCommitteeHash,
    }
}

fn planned_input(plan: UpdatePlan) -> zk_bridge_prover::light_client::UpdateInput {
    let UpdatePlan::Update(statement) = plan else {
        panic!("the light client lags, so the source must plan an update, not {plan:?}");
    };
    let ProofStatement::Verified(input) = *statement else {
        panic!("a real beacon source plans a statement that the program verifies");
    };
    input
}

const KINDS: [ChainKind; 2] = [ChainKind::Ethereum, ChainKind::Pulsechain];

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

/// Claim: for a deposit after the checkpoint, the source waits while no final header covers it, then plans a fold that the
/// light-client program accepts and that ends after the deposit. With the light client at the new head, the source plans
/// nothing more, and the beacon path of the withdrawal verifies: the ancestry branch from the anchor state to the deposit
/// header, and the block hash branch from the deposit header body to the execution block hash of the deposit.
/// Why it matters: this is the beacon half of a payout. The real proof proves the update, and the vault checks the path
/// against the generalized indices that `lc-core` names.
#[test]
fn a_deposit_is_covered_by_an_update_and_its_path_verifies() {
    for kind in KINDS {
        let chain = Chain::new(kind, BLOCKS_BEFORE_CHECKPOINT);
        let checkpoint = read_checkpoint(&chain.node, kind).expect("checkpoint");
        let light_client = state_at(&chain, &checkpoint);
        let source = chain.source();

        let deposit_number = BLOCKS_BEFORE_CHECKPOINT + 8;
        let deposit = chain.deposit(deposit_number);
        let deposit_slot = chain.first_slot() + deposit_number - 1;
        chain.mine(8);
        let plan = source
            .next_update(&deposit, &light_client, &[], &NoExecution)
            .expect("plan");
        assert!(
            matches!(plan, UpdatePlan::NotYetFinal),
            "{kind:?}: the deposit is at the tip"
        );

        chain.mine(10);
        let plan = source
            .next_update(&deposit, &light_client, &[], &NoExecution)
            .expect("plan");
        let input = planned_input(plan);
        assert!(
            input.store.next_sync_committee.is_some(),
            "{kind:?}: the checkpoint holds the next committee"
        );
        let output =
            verify_update_natively(&input).unwrap_or_else(|error| panic!("{kind:?}: {error}"));
        assert!(output.newHeadSlot > deposit_slot, "{kind:?}");
        assert_eq!(output.previousHeadSlot, checkpoint.slot);

        let after = state_after(&output);
        assert!(
            matches!(
                source
                    .next_update(&deposit, &after, &[], &NoExecution)
                    .unwrap(),
                UpdatePlan::Covered
            ),
            "{kind:?}: the new head covers the deposit"
        );

        let path = source
            .withdrawal_path(&deposit, &after, &[], &NoExecution)
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

/// Claim: a light client that lags the chain, with no deposit in view, gets a plan that follows the newest final header,
/// and the update is accepted by the program. With the head at the newest final header, the plan is "covered".
#[test]
fn the_head_update_follows_the_newest_final_header() {
    for kind in KINDS {
        let chain = Chain::new(kind, BLOCKS_BEFORE_CHECKPOINT);
        let checkpoint = read_checkpoint(&chain.node, kind).expect("checkpoint");
        let light_client = state_at(&chain, &checkpoint);
        let source = chain.source();
        assert!(
            matches!(
                source
                    .next_head_update(&light_client, &NoExecution)
                    .unwrap(),
                UpdatePlan::Covered
            ),
            "{kind:?}: the checkpoint is the newest final header"
        );
        chain.mine(6);
        let input = planned_input(
            source
                .next_head_update(&light_client, &NoExecution)
                .unwrap(),
        );
        let output =
            verify_update_natively(&input).unwrap_or_else(|error| panic!("{kind:?}: {error}"));
        assert_eq!(output.newHeadSlot, checkpoint.slot + 6, "{kind:?}");
        assert!(matches!(
            source
                .next_head_update(&state_after(&output), &NoExecution)
                .unwrap(),
            UpdatePlan::Covered
        ));
    }
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
            .hash_layout_evidence(checkpoint.slot, &[checkpoint.slot], &NoExecution)
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
