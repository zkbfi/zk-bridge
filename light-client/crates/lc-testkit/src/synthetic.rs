//! Synthetic fixtures: generated BLS keys, a test-only beacon state and block body builder, and a withdrawal builder.
//!
//! These builders fill every field the verifier does not read with deterministic filler, and place the values the
//! verifier does read at the field positions of the consensus specs. Field positions here are written as FIELD
//! INDICES (for example `finalized_checkpoint` is field 20), not as generalized indices, so a mistake in
//! `lc_core::layout` is not copied into the builder. The real-data tests are the independent check of both.

use crate::receipts::{
    build_receipts_trie, encode_execution_header, encode_receipt, header_hash, prague_header, shanghai_header,
};
use alloy_primitives::{Address, Bytes, B256, U256};
use alloy_sol_types::SolEvent;
use bls12_381::hash_to_curve::{ExpandMsgXmd, HashToCurve};
use bls12_381::{G1Affine, G1Projective, G2Affine, G2Projective, Scalar};
use lc_core::abi::DepositInitiated;
use lc_core::abi::WithdrawalProof;
use lc_core::bls::BLS_DST;
use lc_core::chain::{ChainSpec, ForkName, SYNC_COMMITTEE_SIZE};
use lc_core::execution::Log;
use lc_core::ssz::{
    branch_for_leaf, branch_for_leaf_with_limit, hash_pair, merkleize, merkleize_with_limit, mix_in_length, sha256,
    u64_chunk,
};
use lc_core::types::{
    compute_signing_root, sync_committee_domain, BeaconBlockHeader, BlobGasFields, BlsPublicKey,
    ExecutionPayloadHeader, LightClientHeader, LightClientStore, LightClientUpdate, NextSyncCommittee, SyncAggregate,
    SyncCommittee,
};
use sha2::Sha256;
use std::collections::HashMap;
use std::sync::{Arc, Mutex, OnceLock};

/// Field index of `block_roots` in `BeaconState` (phase0 order, unchanged in every later fork).
const STATE_FIELD_BLOCK_ROOTS: usize = 5;
/// Field index of `historical_summaries` (the last Capella field; Electra and Fulu append after it).
const STATE_FIELD_HISTORICAL_SUMMARIES: usize = 27;
/// `HISTORICAL_ROOTS_LIMIT = 2^24`: depth of the `historical_summaries` list.
const HISTORICAL_LIST_DEPTH: u32 = 24;
/// Slots per era, written here on purpose instead of imported (the builder does not share constants with the code under test).
const SLOTS_PER_ERA: u64 = 8192;
/// Field index of `finalized_checkpoint`.
const STATE_FIELD_FINALIZED_CHECKPOINT: usize = 20;
/// Field index of `current_sync_committee`.
const STATE_FIELD_CURRENT_SYNC_COMMITTEE: usize = 22;
/// Field index of `next_sync_committee`.
const STATE_FIELD_NEXT_SYNC_COMMITTEE: usize = 23;
/// Field index of `execution_payload` in `BeaconBlockBody`.
const BODY_FIELD_EXECUTION_PAYLOAD: usize = 9;

/// Number of `BeaconState` fields per fork: Capella and Deneb 28, Electra 37, Fulu 38.
fn state_field_count(fork: ForkName) -> usize {
    match fork {
        ForkName::Capella | ForkName::Deneb => 28,
        ForkName::Electra => 37,
        ForkName::Fulu => 38,
        other => panic!("no synthetic state for {other:?}"),
    }
}

/// Number of `BeaconBlockBody` fields per fork: Capella 11, Deneb 12, Electra and Fulu 13.
fn body_field_count(fork: ForkName) -> usize {
    match fork {
        ForkName::Capella => 11,
        ForkName::Deneb => 12,
        ForkName::Electra | ForkName::Fulu => 13,
        other => panic!("no synthetic body for {other:?}"),
    }
}

fn filler(label: &str, index: u64) -> B256 {
    sha256(format!("{label}/{index}").as_bytes())
}

/// A sync committee with its secret keys.
pub struct TestCommittee {
    /// One secret per public key.
    pub secrets: Vec<Scalar>,
    /// The committee (512 keys and their aggregate).
    pub committee: SyncCommittee,
}

fn scalar_from_label(label: &str) -> Scalar {
    let mut wide = [0u8; 64];
    wide[..32].copy_from_slice(sha256(format!("{label}/low").as_bytes()).as_slice());
    wide[32..].copy_from_slice(sha256(format!("{label}/high").as_bytes()).as_slice());
    Scalar::from_bytes_wide(&wide)
}

/// Builds a committee of 512 keys with secrets `base + i` for a seed label.
pub fn make_committee(label: &str) -> TestCommittee {
    let base = scalar_from_label(label);
    let generator = G1Projective::generator();
    let mut point = generator * base;
    let mut aggregate = G1Projective::identity();
    let mut secrets = Vec::new();
    let mut pubkeys = Vec::new();
    for index in 0..SYNC_COMMITTEE_SIZE as u64 {
        secrets.push(base + Scalar::from(index));
        pubkeys.push(BlsPublicKey::from(G1Affine::from(point).to_compressed()));
        aggregate += point;
        point += generator;
    }
    let aggregate_pubkey = BlsPublicKey::from(G1Affine::from(aggregate).to_compressed());
    TestCommittee { secrets, committee: SyncCommittee { pubkeys, aggregate_pubkey } }
}

/// The committee for a chain and period. It is cached because key generation is slow.
pub fn committee_for(spec: &ChainSpec, period: u64) -> Arc<TestCommittee> {
    static CACHE: OnceLock<Mutex<HashMap<String, Arc<TestCommittee>>>> = OnceLock::new();
    let label = format!("{}-period-{period}", spec.name);
    let cache = CACHE.get_or_init(|| Mutex::new(HashMap::new()));
    let mut guard = cache.lock().expect("committee cache");
    guard.entry(label.clone()).or_insert_with(|| Arc::new(make_committee(&label))).clone()
}

/// Signs `signing_root` with the sum of the given secrets: the aggregate signature of those members.
pub fn aggregate_sign(secrets: &[Scalar], signing_root: &B256) -> [u8; 96] {
    let total = secrets.iter().fold(Scalar::zero(), |sum, secret| sum + secret);
    let message = <G2Projective as HashToCurve<ExpandMsgXmd<Sha256>>>::hash_to_curve(signing_root.as_slice(), BLS_DST);
    G2Affine::from(message * total).to_compressed()
}

/// A participation vector with the first `count` bits set, and the matching aggregate signature.
pub fn sign_with_first_members(committee: &TestCommittee, count: usize, signing_root: &B256) -> SyncAggregate {
    let mut bits = [0u8; SYNC_COMMITTEE_SIZE / 8];
    for index in 0..count {
        bits[index / 8] |= 1 << (index % 8);
    }
    SyncAggregate {
        sync_committee_bits: bits,
        sync_committee_signature: aggregate_sign(&committee.secrets[..count], signing_root),
    }
}

/// A test-only `BeaconState`: field roots with filler, and the fields the light client reads.
pub struct StateBuilder {
    leaves: Vec<B256>,
    block_roots: Vec<B256>,
    /// Hash tree root of each `HistoricalSummary`, in list order.
    summaries: Vec<B256>,
    /// For list positions that the test fills: the era's `block_roots` and its `state_summary_root`.
    eras: HashMap<usize, EraRecord>,
}

/// One `HistoricalSummary` that the test controls.
struct EraRecord {
    block_roots: Vec<B256>,
    state_summary_root: B256,
}

impl StateBuilder {
    /// A state for the given fork with filler values.
    pub fn new(fork: ForkName) -> Self {
        let leaves = (0..state_field_count(fork) as u64).map(|index| filler("state-field", index)).collect();
        let block_roots = (0..8192u64).map(|index| filler("block-root", index)).collect();
        Self { leaves, block_roots, summaries: Vec::new(), eras: HashMap::new() }
    }

    /// Sets `finalized_checkpoint` to `Checkpoint { epoch, root }`.
    pub fn set_finalized_checkpoint(&mut self, epoch: u64, root: B256) {
        self.leaves[STATE_FIELD_FINALIZED_CHECKPOINT] = hash_pair(&u64_chunk(epoch), &root);
    }

    /// Sets `current_sync_committee`.
    pub fn set_current_committee(&mut self, committee: &SyncCommittee) {
        self.leaves[STATE_FIELD_CURRENT_SYNC_COMMITTEE] = committee.hash_tree_root().expect("committee root");
    }

    /// Sets `next_sync_committee`.
    pub fn set_next_committee(&mut self, committee: &SyncCommittee) {
        self.leaves[STATE_FIELD_NEXT_SYNC_COMMITTEE] = committee.hash_tree_root().expect("committee root");
    }

    /// Sets `block_roots[slot % 8192]`.
    pub fn set_block_root(&mut self, slot: u64, root: B256) {
        self.block_roots[(slot % 8192) as usize] = root;
    }

    /// Makes `historical_summaries` hold `count` entries and sets `block_roots[slot % 8192]` of the era at list
    /// position `index` to `root`. Other positions hold filler summaries. The era vector of `index` is created on the
    /// first call with filler roots, so several calls for the same position build one vector.
    ///
    /// # Panics
    /// Panics when `index >= count`.
    pub fn set_historical_block_root(&mut self, count: usize, index: usize, slot: u64, root: B256) {
        assert!(index < count, "the summary position must be inside the list");
        if self.summaries.len() < count {
            let start = self.summaries.len();
            self.summaries.extend((start..count).map(|position| filler("historical-summary", position as u64)));
        }
        let record = self.eras.entry(index).or_insert_with(|| EraRecord {
            block_roots: (0..SLOTS_PER_ERA).map(|offset| filler(&format!("era-block-root/{index}"), offset)).collect(),
            state_summary_root: filler("era-state-summary", index as u64),
        });
        record.block_roots[(slot % SLOTS_PER_ERA) as usize] = root;
        self.summaries[index] = hash_pair(&merkleize(&record.block_roots), &record.state_summary_root);
    }

    /// Whether the test filled the era at list position `index`.
    pub fn has_historical_era(&self, index: usize) -> bool {
        self.eras.contains_key(&index)
    }

    /// The `historical_summaries` field root: the list data root mixed with the length.
    fn historical_summaries_root(&self) -> B256 {
        let data_root = merkleize_with_limit(&self.summaries, 1 << HISTORICAL_LIST_DEPTH);
        mix_in_length(&data_root, self.summaries.len() as u64)
    }

    fn field_leaves(&self) -> Vec<B256> {
        let mut leaves = self.leaves.clone();
        leaves[STATE_FIELD_BLOCK_ROOTS] = merkleize(&self.block_roots);
        leaves[STATE_FIELD_HISTORICAL_SUMMARIES] = self.historical_summaries_root();
        leaves
    }

    /// The state root.
    pub fn root(&self) -> B256 {
        merkleize(&self.field_leaves())
    }

    /// Branch for `finalized_checkpoint.root`: the epoch chunk, then the field branch.
    pub fn finality_branch(&self, epoch: u64) -> Vec<B256> {
        let mut branch = vec![u64_chunk(epoch)];
        branch.extend(branch_for_leaf(&self.field_leaves(), STATE_FIELD_FINALIZED_CHECKPOINT).1);
        branch
    }

    /// Branch for `current_sync_committee`.
    pub fn current_committee_branch(&self) -> Vec<B256> {
        branch_for_leaf(&self.field_leaves(), STATE_FIELD_CURRENT_SYNC_COMMITTEE).1
    }

    /// Branch for `next_sync_committee`.
    pub fn next_committee_branch(&self) -> Vec<B256> {
        branch_for_leaf(&self.field_leaves(), STATE_FIELD_NEXT_SYNC_COMMITTEE).1
    }

    /// Branch for `block_roots[slot % 8192]`: the vector branch, then the field branch.
    pub fn block_roots_branch(&self, slot: u64) -> Vec<B256> {
        let mut branch = branch_for_leaf(&self.block_roots, (slot % 8192) as usize).1;
        branch.extend(branch_for_leaf(&self.field_leaves(), STATE_FIELD_BLOCK_ROOTS).1);
        branch
    }
}

impl StateBuilder {
    /// Branch for `historical_summaries[index].block_summary_root.block_roots[slot % 8192]`, bottom to top:
    /// 13 entries inside the era vector, the `state_summary_root` sibling, 24 list levels, the list length, then the
    /// field branch of the state.
    ///
    /// # Panics
    /// Panics when the test did not fill the era at `index` (see [`StateBuilder::set_historical_block_root`]).
    pub fn historical_ancestry_branch(&self, index: usize, slot: u64) -> Vec<B256> {
        let record = self.eras.get(&index).expect("the era at this list position was not filled");
        let mut branch = branch_for_leaf(&record.block_roots, (slot % SLOTS_PER_ERA) as usize).1;
        branch.push(record.state_summary_root);
        branch.extend(branch_for_leaf_with_limit(&self.summaries, index, HISTORICAL_LIST_DEPTH).1);
        branch.push(u64_chunk(self.summaries.len() as u64));
        branch.extend(branch_for_leaf(&self.field_leaves(), STATE_FIELD_HISTORICAL_SUMMARIES).1);
        branch
    }
}

/// An execution payload header for the fork at a slot, with blob fields from Deneb on.
pub fn synthetic_payload_header(
    spec: &ChainSpec,
    beacon_slot: u64,
    block_number: u64,
    block_hash: B256,
    receipts_root: B256,
) -> ExecutionPayloadHeader {
    let blob_gas = (spec.fork_at_slot(beacon_slot) >= ForkName::Deneb).then_some(BlobGasFields::default());
    ExecutionPayloadHeader {
        parent_hash: filler("parent", block_number),
        fee_recipient: Address::repeat_byte(0x0f),
        state_root: filler("exec-state", block_number),
        receipts_root,
        logs_bloom: vec![0u8; 256],
        prev_randao: filler("randao", block_number),
        block_number,
        gas_limit: 30_000_000,
        gas_used: 1_000_000,
        timestamp: 1_700_000_000 + block_number,
        extra_data: b"synthetic".to_vec(),
        base_fee_per_gas: U256::from(7u64),
        block_hash,
        transactions_root: filler("txs", block_number),
        withdrawals_root: filler("withdrawals", block_number),
        blob_gas,
    }
}

/// Builds a light-client header: a body with the payload header at field 9, and the matching branch.
pub fn synthetic_light_client_header(
    spec: &ChainSpec,
    slot: u64,
    state_root: B256,
    execution: ExecutionPayloadHeader,
) -> LightClientHeader {
    let BodyProofs { body_root, execution_branch, .. } = build_body_proofs(spec, slot, &execution);
    LightClientHeader {
        beacon: BeaconBlockHeader {
            slot,
            proposer_index: slot % 1000,
            parent_root: filler("parent-root", slot),
            state_root,
            body_root,
        },
        execution,
        execution_branch,
    }
}

/// Parameters of a synthetic update.
#[derive(Clone, Copy, Debug)]
pub struct UpdateRecipe {
    /// Slot of the stored head.
    pub store_slot: u64,
    /// Slot of the finalized header the update names.
    pub finalized_slot: u64,
    /// Slot of the attested header.
    pub attested_slot: u64,
    /// Slot of the block that carries the aggregate.
    pub signature_slot: u64,
    /// Number of committee members that sign.
    pub participants: usize,
    /// Whether the update proves the next sync committee.
    pub include_next_committee: bool,
    /// Whether the store already knows the next sync committee.
    pub store_knows_next_committee: bool,
}

/// A store and an update that verify together (unless the test breaks them).
pub struct UpdateScenario {
    /// The chain.
    pub spec: &'static ChainSpec,
    /// The store before the update.
    pub store: LightClientStore,
    /// The update.
    pub update: LightClientUpdate,
    /// The state of the attested header, for tests that need more branches from it.
    pub attested_state: StateBuilder,
}

/// Builds a scenario. Committees are deterministic per chain and period.
pub fn build_update(spec: &'static ChainSpec, recipe: UpdateRecipe) -> UpdateScenario {
    let store_period = spec.period_at_slot(recipe.store_slot);
    let attested_period = spec.period_at_slot(recipe.attested_slot);
    let signature_period = spec.period_at_slot(recipe.signature_slot);

    let finalized_exec = synthetic_payload_header(
        spec,
        recipe.finalized_slot,
        recipe.finalized_slot * 2,
        filler("exec-block-hash", recipe.finalized_slot),
        filler("receipts", recipe.finalized_slot),
    );
    let finalized_header = synthetic_light_client_header(
        spec,
        recipe.finalized_slot,
        filler("finalized-state-root", recipe.finalized_slot),
        finalized_exec,
    );

    let attested_fork = spec.fork_at_slot(recipe.attested_slot);
    let mut state = StateBuilder::new(attested_fork);
    state.set_finalized_checkpoint(spec.epoch_at_slot(recipe.finalized_slot), finalized_header.beacon.hash_tree_root());
    let attested_current = committee_for(spec, attested_period);
    let attested_next = committee_for(spec, attested_period + 1);
    state.set_current_committee(&attested_current.committee);
    state.set_next_committee(&attested_next.committee);

    let attested_exec = synthetic_payload_header(
        spec,
        recipe.attested_slot,
        recipe.attested_slot * 2,
        filler("exec-block-hash", recipe.attested_slot),
        filler("receipts", recipe.attested_slot),
    );
    let attested_header = synthetic_light_client_header(spec, recipe.attested_slot, state.root(), attested_exec);

    let signing_committee = committee_for(spec, signature_period);
    let domain = sync_committee_domain(spec, recipe.signature_slot);
    let signing_root = compute_signing_root(&attested_header.beacon.hash_tree_root(), &domain);
    let sync_aggregate = sign_with_first_members(&signing_committee, recipe.participants, &signing_root);

    let next_sync_committee = recipe.include_next_committee.then(|| NextSyncCommittee {
        committee: attested_next.committee.clone(),
        branch: state.next_committee_branch(),
    });
    let update = LightClientUpdate {
        attested_header,
        next_sync_committee,
        finalized_header: finalized_header.clone(),
        finality_branch: state.finality_branch(spec.epoch_at_slot(recipe.finalized_slot)),
        sync_aggregate,
        signature_slot: recipe.signature_slot,
    };

    let store = LightClientStore {
        header_root: filler("store-header-root", recipe.store_slot),
        header_slot: recipe.store_slot,
        current_sync_committee: committee_for(spec, store_period).committee.clone(),
        next_sync_committee: recipe
            .store_knows_next_committee
            .then(|| committee_for(spec, store_period + 1).committee.clone()),
    };
    UpdateScenario { spec, store, update, attested_state: state }
}

/// A chain of updates that walks across sync committee periods, as the updates of a lagging light client are.
///
/// Update 0 finalizes inside `first_period` and proves the next committee. Update `k` finalizes 64 slots into period
/// `first_period + k`, is signed by the committee of that period, and proves the next committee, except the last, which
/// has none (a finality update proves no next committee). Every update finalizes after the one before it, so the list
/// is a valid fold from a store in `first_period` that knows no next committee.
pub fn period_chain(spec: &'static ChainSpec, first_period: u64, crossings: u64) -> Vec<LightClientUpdate> {
    let slots_per_period = spec.epochs_per_sync_committee_period * spec.slots_per_epoch;
    let start = first_period * slots_per_period;
    let recipe = |store_slot: u64, finalized_slot: u64, include_next_committee: bool| UpdateRecipe {
        store_slot,
        finalized_slot,
        attested_slot: finalized_slot + 66,
        signature_slot: finalized_slot + 67,
        participants: 342,
        include_next_committee,
        store_knows_next_committee: false,
    };
    let mut updates = vec![build_update(spec, recipe(start + 400, start + 1000, crossings > 0)).update];
    for crossing in 1..=crossings {
        let previous = updates.last().expect("one update").finalized_header.beacon.slot;
        let finalized = start + crossing * slots_per_period + 64;
        updates.push(build_update(spec, recipe(previous, finalized, crossing < crossings)).update);
    }
    updates
}

/// Parameters of one receipt in a synthetic block.
#[derive(Clone, Debug)]
pub struct ReceiptSpec {
    /// EIP-2718 type: 0 legacy, 2 dynamic fee.
    pub transaction_type: u8,
    /// Whether the transaction succeeded.
    pub success: bool,
    /// Logs of the receipt.
    pub logs: Vec<Log>,
}

/// The fields of a deposit event.
#[derive(Clone, Copy, Debug)]
pub struct DepositFields {
    /// Token.
    pub token: Address,
    /// Depositor.
    pub sender: Address,
    /// Recipient on the target chain.
    pub recipient: Address,
    /// Amount.
    pub amount: u64,
    /// Nonce.
    pub nonce: B256,
    /// Target chain.
    pub target_chain_id: u64,
    /// The vault on the target chain that the deposit is addressed to.
    pub destination_vault: Address,
    /// The token that the destination vault must pay for this deposit.
    pub destination_token: Address,
}

/// A log of the `DepositInitiated` event, emitted by `emitter`.
pub fn deposit_log(emitter: Address, fields: &DepositFields) -> Log {
    let event = DepositInitiated {
        token: fields.token,
        sender: fields.sender,
        recipient: fields.recipient,
        amount: U256::from(fields.amount),
        nonce: fields.nonce,
        targetChainId: fields.target_chain_id,
        destinationVault: fields.destination_vault,
        destinationToken: fields.destination_token,
    };
    let data = event.encode_log_data();
    Log { address: emitter, topics: data.topics().to_vec(), data: data.data.clone() }
}

/// Proofs from a block body to the fields of its execution payload.
pub struct BodyProofs {
    /// The body root.
    pub body_root: B256,
    /// Branch from the payload root to the body root (the light-client execution branch).
    pub execution_branch: Vec<B256>,
    /// Branch from `execution_payload.block_hash` to the body root (payload branch, then body branch).
    pub block_hash_branch: Vec<B256>,
}

/// Builds a body whose payload is `payload`, and the proofs the vault and the light client read from it.
/// The payload leaves use the field positions of `ExecutionPayload`: `block_hash` is field 12.
pub fn build_body_proofs(spec: &ChainSpec, slot: u64, payload: &ExecutionPayloadHeader) -> BodyProofs {
    const PAYLOAD_FIELD_BLOCK_HASH: usize = 12;
    let fork = spec.fork_at_slot(slot);
    let form = lc_core::layout::execution_header_form_for_fork(fork).expect("supported fork");
    let mut leaves: Vec<B256> = (0..body_field_count(fork) as u64).map(|index| filler("body-field", index)).collect();
    leaves[BODY_FIELD_EXECUTION_PAYLOAD] = payload.hash_tree_root(form).expect("payload root");
    let (body_root, body_branch) = branch_for_leaf(&leaves, BODY_FIELD_EXECUTION_PAYLOAD);
    let (_, mut payload_branch) =
        branch_for_leaf(&payload.field_roots(form).expect("payload leaves"), PAYLOAD_FIELD_BLOCK_HASH);
    payload_branch.extend(&body_branch);
    BodyProofs { body_root, execution_branch: body_branch, block_hash_branch: payload_branch }
}

/// A synthetic withdrawal: receipts in a block, a beacon chain that contains the block, and the calldata struct.
pub struct WithdrawalScenario {
    /// The chain.
    pub spec: &'static ChainSpec,
    /// The calldata struct.
    pub proof: WithdrawalProof,
    /// What the light client stores for the anchor slot.
    pub stored_anchor_root: B256,
    /// The state of the anchor, for tests that rebuild the branch.
    pub anchor_state: StateBuilder,
    /// The execution block hash of the deposit block.
    pub deposit_block_hash: B256,
}

impl WithdrawalScenario {
    /// The branch through `state.block_roots`. It is a valid Merkle path of the anchor state at any distance, because the
    /// builder always stores the deposit header root there. The vault accepts it only when the distance is at most 8192.
    pub fn recent_ancestry_branch(&self) -> Vec<B256> {
        self.anchor_state.block_roots_branch(self.proof.depositHeader.slot)
    }

    /// The branch through `state.historical_summaries` for the era of the deposit, or `None` when the anchor state has
    /// no entry for it (the era is not complete at the anchor, or it is before Capella). The builder fills the entry of
    /// the deposit era whenever it exists, whatever the distance. The vault accepts it only when the distance is above 8192.
    pub fn historical_ancestry_branch(&self) -> Option<Vec<B256>> {
        let slot = self.proof.depositHeader.slot;
        self.historical_ancestry_branch_for_era(slot / SLOTS_PER_ERA)
    }

    /// The same branch built for the list position of `era`. For a neighbouring era it is the "wrong era index" attack: the
    /// builder stores the deposit header root at the same offset in the eras next to the deposit era, so this branch is a
    /// valid Merkle path of the anchor state and only the index of the vault rejects it.
    pub fn historical_ancestry_branch_for_era(&self, era: u64) -> Option<Vec<B256>> {
        let capella_era = self.spec.capella_era().expect("a Capella schedule");
        let index = usize::try_from(era.checked_sub(capella_era)?).ok()?;
        self.anchor_state
            .has_historical_era(index)
            .then(|| self.anchor_state.historical_ancestry_branch(index, self.proof.depositHeader.slot))
    }
}

/// Builds a withdrawal scenario whose deposit receipt is receipt `transaction_index` and log `log_index`.
pub fn build_withdrawal(
    spec: &'static ChainSpec,
    receipts: &[ReceiptSpec],
    transaction_index: u64,
    log_index: u64,
    deposit_slot: u64,
    anchor_slot: u64,
) -> WithdrawalScenario {
    let encoded: Vec<Bytes> = receipts
        .iter()
        .enumerate()
        .map(|(index, receipt)| {
            encode_receipt(
                receipt.transaction_type,
                receipt.success,
                21_000 * (index as u64 + 1),
                alloy_primitives::Bloom::ZERO,
                &receipt.logs,
            )
        })
        .collect();
    let trie = build_receipts_trie(&encoded);

    let block_number = deposit_slot * 2;
    let header = if spec.fork_at_slot(deposit_slot) >= ForkName::Deneb {
        prague_header(block_number, trie.root)
    } else {
        shanghai_header(block_number, trie.root)
    };
    let header_rlp = encode_execution_header(&header);
    assemble_withdrawal(
        spec,
        &ExecutionBlockEvidence {
            header_rlp,
            block_number,
            receipts_root: trie.root,
            receipt_proof: trie.proofs[transaction_index as usize].clone(),
        },
        transaction_index,
        log_index,
        deposit_slot,
        anchor_slot,
    )
}

/// The execution block part of a withdrawal: a header and the proof of one receipt.
pub struct ExecutionBlockEvidence {
    /// RLP of the execution header.
    pub header_rlp: Bytes,
    /// Block number inside the header.
    pub block_number: u64,
    /// Receipts root inside the header.
    pub receipts_root: B256,
    /// Proof nodes of the receipt at the transaction index.
    pub receipt_proof: Vec<Bytes>,
}

/// Wraps execution evidence (synthetic or REAL) in a synthetic beacon chain: a deposit beacon block whose payload names
/// the block hash, and an anchor whose state holds the deposit header in `block_roots`.
pub fn assemble_withdrawal(
    spec: &'static ChainSpec,
    evidence: &ExecutionBlockEvidence,
    transaction_index: u64,
    log_index: u64,
    deposit_slot: u64,
    anchor_slot: u64,
) -> WithdrawalScenario {
    let block_hash = header_hash(&evidence.header_rlp);
    let block_number = evidence.block_number;
    let trie_root = evidence.receipts_root;
    let payload = synthetic_payload_header(spec, deposit_slot, block_number, block_hash, trie_root);
    let body = build_body_proofs(spec, deposit_slot, &payload);
    let deposit_header = BeaconBlockHeader {
        slot: deposit_slot,
        proposer_index: 7,
        parent_root: filler("deposit-parent", deposit_slot),
        state_root: filler("deposit-state-root", deposit_slot),
        body_root: body.body_root,
    };

    let mut anchor_state = StateBuilder::new(spec.fork_at_slot(anchor_slot));
    let deposit_root = deposit_header.hash_tree_root();
    anchor_state.set_block_root(deposit_slot, deposit_root);
    // The anchor state holds the deposit header root in EVERY place a mixed-up proof could point at: block_roots, the era of
    // the deposit, and the two neighbouring eras (same offset). So each wrong branch is a valid Merkle path and only the
    // vault's choice of index can refuse it. An era has an entry only when it is complete at the anchor and not before Capella.
    let capella_era = spec.capella_era().expect("a Capella schedule");
    let summary_count = (anchor_slot / SLOTS_PER_ERA).saturating_sub(capella_era) as usize;
    let deposit_era = deposit_slot / SLOTS_PER_ERA;
    for era in [deposit_era.wrapping_sub(1), deposit_era, deposit_era + 1] {
        let Some(index) = era.checked_sub(capella_era).map(|index| index as usize) else { continue };
        if index < summary_count {
            anchor_state.set_historical_block_root(summary_count, index, deposit_slot, deposit_root);
        }
    }
    let anchor_header = BeaconBlockHeader {
        slot: anchor_slot,
        proposer_index: 9,
        parent_root: filler("anchor-parent", anchor_slot),
        state_root: anchor_state.root(),
        body_root: filler("anchor-body", anchor_slot),
    };

    // The honest prover builds the branch of the path that the distance selects (the vault makes the same choice).
    let ancestry_branch = if anchor_slot.saturating_sub(deposit_slot) > SLOTS_PER_ERA {
        let index = (deposit_era - capella_era) as usize;
        anchor_state.historical_ancestry_branch(index, deposit_slot)
    } else {
        anchor_state.block_roots_branch(deposit_slot)
    };

    let proof = WithdrawalProof {
        anchorHeader: (&anchor_header).into(),
        depositHeader: (&deposit_header).into(),
        ancestryBranch: ancestry_branch,
        blockHashBranch: body.block_hash_branch,
        executionHeaderRlp: evidence.header_rlp.clone(),
        receiptProof: evidence.receipt_proof.clone(),
        transactionIndex: U256::from(transaction_index),
        logIndex: U256::from(log_index),
    };
    WithdrawalScenario {
        spec,
        proof,
        stored_anchor_root: anchor_header.hash_tree_root(),
        anchor_state,
        deposit_block_hash: block_hash,
    }
}
