//! Synthetic fixtures: generated BLS keys, a test-only beacon state and block body builder, and a message builder.
//!
//! These builders fill every field the verifier does not read with deterministic filler, and place the values the
//! verifier does read at the field positions of the consensus specs. Field positions here are written as FIELD
//! INDICES (for example `finalized_checkpoint` is field 20), not as generalized indices, so a mistake in
//! `lc_core::layout` is not copied into the builder. The real-data tests are the independent check of both.

use crate::receipts::{
    amsterdam_header_rlp, build_indexed_trie, encode_execution_header, encode_receipt, header_hash, prague_header,
    shanghai_header,
};
use alloy_primitives::{keccak256, Address, Bytes, B256, U256};
use bls12_381::hash_to_curve::{ExpandMsgXmd, HashToCurve};
use bls12_381::{G1Affine, G1Projective, G2Affine, G2Projective, Scalar};
use lc_core::abi::{MessageProof, USER_REQUEST_TOPIC};
use lc_core::bls::BLS_DST;
use lc_core::chain::{ChainSpec, ForkName, SYNC_COMMITTEE_SIZE};
use lc_core::execution::Log;
use lc_core::message::{encode_event_data, encode_message, MessageHeader};
use lc_core::ssz::{
    branch_for_leaf, branch_for_leaf_with_limit, hash_pair, merkleize, merkleize_with_limit, mix_in_length,
    progressive_container_branch, progressive_container_root, sha256, u64_chunk,
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
/// Field index of `latest_block_hash` in the Gloas `BeaconState` (it takes the place of the payload header of field 24).
const GLOAS_STATE_FIELD_LATEST_BLOCK_HASH: usize = 24;
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
    LightClientHeader::full(
        BeaconBlockHeader {
            slot,
            proposer_index: slot % 1000,
            parent_root: filler("parent-root", slot),
            state_root,
            body_root,
        },
        execution,
        execution_branch,
    )
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

// ---------------------------------------------------------------------------------------------------------------------
// Gloas (SYNTHETIC)
// ---------------------------------------------------------------------------------------------------------------------
//
// These builders make a Gloas body and a Gloas state that commit to the values the light client reads. Every other
// field is a zero chunk (body, bid) or a filler hash (state). They are synthetic: the roots are not roots of real
// blocks. Field positions are written as FIELD INDICES from the field lists of `specs/gloas/beacon-chain.md`, not as
// generalized indices, so a mistake in `lc_core::layout` is not copied into the builder. The progressive hashing comes
// from `lc_core::ssz` (`progressive_container_root`), which a real Sepolia branch also checks.

/// Field index of `signed_execution_payload_bid` in the Gloas `BeaconBlockBody`.
const GLOAS_BODY_FIELD_SIGNED_BID: usize = 10;
/// Number of fields of the Gloas `BeaconBlockBody`.
const GLOAS_BODY_FIELDS: usize = 13;
/// Number of fields of `ExecutionPayloadBid`.
const GLOAS_BID_FIELDS: usize = 12;
/// Number of fields of the Gloas `BeaconState`.
const GLOAS_STATE_FIELDS: usize = 46;

/// A synthetic Gloas block body: all fields are zero chunks except `signed_execution_payload_bid`, whose bid commits to
/// `parent_block_hash`. The bid signature is a zero chunk.
#[derive(Clone, Debug)]
pub struct GloasBody {
    bid_chunks: Vec<B256>,
    body_chunks: Vec<B256>,
}

/// Builds the synthetic Gloas body for a bid with the given `parent_block_hash` (bid field 0). Every other field is a zero
/// chunk, so two bodies with different hashes have the same branch. Use [`gloas_body_salted`] for a body whose branch
/// differs.
pub fn gloas_body(parent_block_hash: B256) -> GloasBody {
    gloas_body_with_others(parent_block_hash, |_, _| B256::ZERO)
}

/// Like [`gloas_body`], but every other field of the body and of the bid is a filler hash derived from `salt`. Two
/// bodies with different salts have different siblings, so a branch of one does not verify against the other.
pub fn gloas_body_salted(parent_block_hash: B256, salt: &str) -> GloasBody {
    gloas_body_with_others(parent_block_hash, |label, index| filler(&format!("{salt}/{label}"), index))
}

fn gloas_body_with_others(parent_block_hash: B256, other: impl Fn(&str, u64) -> B256) -> GloasBody {
    let mut bid_chunks: Vec<B256> = (0..GLOAS_BID_FIELDS as u64).map(|index| other("bid", index)).collect();
    bid_chunks[0] = parent_block_hash;
    let signed_bid_root = hash_pair(&progressive_container_root(&bid_chunks), &B256::ZERO);
    let mut body_chunks: Vec<B256> = (0..GLOAS_BODY_FIELDS as u64).map(|index| other("body", index)).collect();
    body_chunks[GLOAS_BODY_FIELD_SIGNED_BID] = signed_bid_root;
    GloasBody { bid_chunks, body_chunks }
}

impl GloasBody {
    /// The body root.
    pub fn root(&self) -> B256 {
        progressive_container_root(&self.body_chunks)
    }

    /// The branch from `parent_block_hash` to the body root, bottom to top: 2 entries inside the bid (the rest of the
    /// progressive tree and `active_fields`), the bid signature, then 8 entries inside the body. 11 entries in all.
    pub fn block_hash_branch(&self) -> Vec<B256> {
        let mut branch = progressive_container_branch(&self.bid_chunks, 0).1;
        branch.push(B256::ZERO);
        branch.extend(progressive_container_branch(&self.body_chunks, GLOAS_BODY_FIELD_SIGNED_BID).1);
        branch
    }
}

/// A synthetic Gloas `BeaconState`: filler field roots, and the fields the light client reads.
#[derive(Clone, Debug)]
pub struct GloasStateBuilder {
    chunks: Vec<B256>,
}

impl Default for GloasStateBuilder {
    fn default() -> Self {
        Self { chunks: (0..GLOAS_STATE_FIELDS as u64).map(|index| filler("gloas-state-field", index)).collect() }
    }
}

impl GloasStateBuilder {
    /// Sets `finalized_checkpoint` (field 20) to `Checkpoint { epoch, root }`.
    pub fn set_finalized_checkpoint(&mut self, epoch: u64, root: B256) {
        self.chunks[STATE_FIELD_FINALIZED_CHECKPOINT] = hash_pair(&u64_chunk(epoch), &root);
    }

    /// Sets `current_sync_committee` (field 22).
    pub fn set_current_committee(&mut self, committee: &SyncCommittee) {
        self.chunks[STATE_FIELD_CURRENT_SYNC_COMMITTEE] = committee.hash_tree_root().expect("committee root");
    }

    /// Sets `next_sync_committee` (field 23).
    pub fn set_next_committee(&mut self, committee: &SyncCommittee) {
        self.chunks[STATE_FIELD_NEXT_SYNC_COMMITTEE] = committee.hash_tree_root().expect("committee root");
    }

    /// Sets `latest_block_hash` (field 24).
    pub fn set_latest_block_hash(&mut self, hash: B256) {
        self.chunks[GLOAS_STATE_FIELD_LATEST_BLOCK_HASH] = hash;
    }

    /// The state root.
    pub fn root(&self) -> B256 {
        progressive_container_root(&self.chunks)
    }

    /// Branch for `latest_block_hash`. 11 entries.
    pub fn latest_block_hash_branch(&self) -> Vec<B256> {
        progressive_container_branch(&self.chunks, GLOAS_STATE_FIELD_LATEST_BLOCK_HASH).1
    }

    /// Branch for `finalized_checkpoint.root`: the epoch chunk, then 8 entries of the progressive state. 9 in all.
    pub fn finality_branch(&self, epoch: u64) -> Vec<B256> {
        let mut branch = vec![u64_chunk(epoch)];
        branch.extend(progressive_container_branch(&self.chunks, STATE_FIELD_FINALIZED_CHECKPOINT).1);
        branch
    }

    /// Branch for `current_sync_committee`. 11 entries.
    pub fn current_committee_branch(&self) -> Vec<B256> {
        progressive_container_branch(&self.chunks, STATE_FIELD_CURRENT_SYNC_COMMITTEE).1
    }

    /// Branch for `next_sync_committee`. 11 entries.
    pub fn next_committee_branch(&self) -> Vec<B256> {
        progressive_container_branch(&self.chunks, STATE_FIELD_NEXT_SYNC_COMMITTEE).1
    }
}

/// A compact light-client header for `slot`, whose body commits to `execution_block_hash`. The body follows the fork at the
/// slot of the header: a progressive Gloas body (bid parent block hash, index 2856) in a Gloas epoch, and the
/// Capella to Fulu body (payload block hash, index 412 or 812) before. Both are synthetic.
pub fn synthetic_compact_header(
    spec: &ChainSpec,
    slot: u64,
    state_root: B256,
    execution_block_hash: B256,
) -> LightClientHeader {
    let (body_root, branch) = if spec.fork_at_slot(slot) >= ForkName::Gloas {
        let body = gloas_body(execution_block_hash);
        (body.root(), body.block_hash_branch())
    } else {
        let payload = synthetic_payload_header(spec, slot, slot * 2, execution_block_hash, filler("receipts", slot));
        let proofs = build_body_proofs(spec, slot, &payload);
        (proofs.body_root, proofs.block_hash_branch)
    };
    let beacon = BeaconBlockHeader {
        slot,
        proposer_index: slot % 1000,
        parent_root: filler("parent-root", slot),
        state_root,
        body_root,
    };
    LightClientHeader::compact(beacon, execution_block_hash, branch, Vec::new())
}

/// A compact FINALIZED header for a Gloas-typed update, with the execution block of number `block_number`.
///
/// The execution block is an Amsterdam-shaped header (23 items). Its hash is the proven execution block hash. In a Gloas slot
/// the hash is `latest_block_hash` of a synthetic Gloas state that the header's `state_root` commits to, with the branch at
/// index 2947. In a slot before Gloas the hash is the payload block hash of a synthetic Capella to Fulu body, with the
/// branch at 812 or 412. The RLP is attached in both cases.
pub fn synthetic_compact_finalized_header(spec: &ChainSpec, slot: u64, block_number: u64) -> LightClientHeader {
    let rlp = amsterdam_header_rlp(block_number, filler("receipts", slot), filler("transactions", slot));
    let block_hash = keccak256(&rlp);
    let beacon = BeaconBlockHeader {
        slot,
        proposer_index: slot % 1000,
        parent_root: filler("parent-root", slot),
        state_root: filler("finalized-state-root", slot),
        body_root: filler("finalized-body-root", slot),
    };
    if spec.fork_at_slot(slot) >= ForkName::Gloas {
        let mut state = GloasStateBuilder::default();
        state.set_latest_block_hash(block_hash);
        let beacon = BeaconBlockHeader { state_root: state.root(), ..beacon };
        return LightClientHeader::compact(beacon, block_hash, state.latest_block_hash_branch(), rlp.to_vec());
    }
    let payload = synthetic_payload_header(spec, slot, block_number, block_hash, filler("receipts", slot));
    let proofs = build_body_proofs(spec, slot, &payload);
    let beacon = BeaconBlockHeader { body_root: proofs.body_root, ..beacon };
    LightClientHeader::compact(beacon, block_hash, proofs.block_hash_branch, rlp.to_vec())
}

/// A store and a Gloas-typed update (every header compact) that verify together, unless the test breaks them.
pub struct GloasUpdateScenario {
    /// The chain.
    pub spec: &'static ChainSpec,
    /// The store before the update.
    pub store: LightClientStore,
    /// The update.
    pub update: LightClientUpdate,
    /// The synthetic Gloas state of the attested header, for tests that need more branches from it.
    pub attested_state: GloasStateBuilder,
    /// The block number inside the execution header RLP of the finalized header.
    pub finalized_block_number: u64,
}

/// Builds a Gloas-typed update on `spec` with the same recipe as [`build_update`]. The attested slot must be in a Gloas
/// epoch. The finalized slot may be before the fork: its header is then a compact header over a pre-Gloas body. The
/// committee signs for real.
pub fn build_gloas_update(spec: &'static ChainSpec, recipe: UpdateRecipe) -> GloasUpdateScenario {
    assert!(spec.fork_at_slot(recipe.attested_slot) >= ForkName::Gloas, "the attested slot must be in a Gloas epoch");
    let store_period = spec.period_at_slot(recipe.store_slot);
    let attested_period = spec.period_at_slot(recipe.attested_slot);
    let signature_period = spec.period_at_slot(recipe.signature_slot);

    let finalized_block_number = recipe.finalized_slot / 2 + 12_000_000;
    let finalized_header = synthetic_compact_finalized_header(spec, recipe.finalized_slot, finalized_block_number);
    let mut state = GloasStateBuilder::default();
    state.set_finalized_checkpoint(spec.epoch_at_slot(recipe.finalized_slot), finalized_header.beacon.hash_tree_root());
    let attested_current = committee_for(spec, attested_period);
    let attested_next = committee_for(spec, attested_period + 1);
    state.set_current_committee(&attested_current.committee);
    state.set_next_committee(&attested_next.committee);
    let attested_header = synthetic_compact_header(
        spec,
        recipe.attested_slot,
        state.root(),
        filler("exec-block-hash", recipe.attested_slot),
    );

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
        finalized_header,
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
    GloasUpdateScenario { spec, store, update, attested_state: state, finalized_block_number }
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

/// The fields of a message that a bridge sends.
#[derive(Clone, Debug)]
pub struct MessageFields {
    /// The identifier. The honest value is `message_id_for(source chain, bridge, nonce)`.
    pub message_id: B256,
    /// The contract that sent the message.
    pub sender: Address,
    /// The target contract on the destination chain.
    pub executor: Address,
    /// The gas that the target gets.
    pub gas_limit: u32,
    /// `DATA_TYPE_PASS` or `DATA_TYPE_CONFIRM`.
    pub data_type: u8,
    /// The source chain identifier.
    pub source_chain_id: u64,
    /// The destination chain identifier.
    pub destination_chain_id: u64,
    /// The call data for the target.
    pub data: Bytes,
}

impl MessageFields {
    /// The message header of these fields.
    pub fn header(&self) -> MessageHeader {
        MessageHeader {
            message_id: self.message_id,
            sender: self.sender,
            executor: self.executor,
            gas_limit: self.gas_limit,
            data_type: self.data_type,
            source_chain_id: U256::from(self.source_chain_id),
            destination_chain_id: U256::from(self.destination_chain_id),
        }
    }
}

/// A log of the `UserRequestForAffirmation` event, emitted by `emitter`. The topic holds the identifier of the message.
pub fn message_log(emitter: Address, fields: &MessageFields) -> Log {
    raw_message_log(emitter, fields.message_id, &encode_message(&fields.header(), &fields.data))
}

/// A log of the `UserRequestForAffirmation` event with the given identifier in its topic and the given bytes as the
/// message. Tests use it to write a message that no honest bridge writes.
pub fn raw_message_log(emitter: Address, topic_message_id: B256, encoded_message: &[u8]) -> Log {
    Log {
        address: emitter,
        topics: vec![USER_REQUEST_TOPIC, topic_message_id],
        data: encode_event_data(encoded_message),
    }
}

/// The bytes of the transaction at `index` in a synthetic block: a type 2 envelope byte and 128 bytes of filler. Only the
/// hash of the bytes and their place in the transactions trie matter to the verifier. The bytes are longer than 32, as every
/// real transaction is, so no trie node is embedded in its parent and each proof node is used.
pub fn synthetic_transaction(index: u64) -> Bytes {
    let mut bytes = vec![0x02];
    for round in 0u64..4 {
        bytes.extend_from_slice(keccak256([index.to_be_bytes(), round.to_be_bytes()].concat()).as_slice());
    }
    Bytes::from(bytes)
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

/// Builds a body whose payload is `payload`, and the proofs the bridge and the light client read from it.
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

/// A synthetic message proof: receipts and transactions in a block, a beacon chain that contains the block, and the
/// calldata struct.
pub struct MessageScenario {
    /// The chain.
    pub spec: &'static ChainSpec,
    /// The calldata struct.
    pub proof: MessageProof,
    /// What the light client stores for the anchor slot.
    pub stored_anchor_root: B256,
    /// The state of the anchor, for tests that rebuild the branch.
    pub anchor_state: StateBuilder,
    /// The execution block hash of the source block.
    pub source_block_hash: B256,
    /// The hash of the source transaction.
    pub source_transaction_hash: B256,
}

impl MessageScenario {
    /// The branch through `state.block_roots`. It is a valid Merkle path of the anchor state at any distance, because the
    /// builder always stores the source header root there. The bridge accepts it only when the distance is at most 8192.
    pub fn recent_ancestry_branch(&self) -> Vec<B256> {
        self.anchor_state.block_roots_branch(self.proof.sourceHeader.slot)
    }

    /// The branch through `state.historical_summaries` for the era of the source block, or `None` when the anchor state has
    /// no entry for it (the era is not complete at the anchor, or it is before Capella). The builder fills the entry of
    /// the source era whenever it exists, whatever the distance. The bridge accepts it only when the distance is above 8192.
    pub fn historical_ancestry_branch(&self) -> Option<Vec<B256>> {
        let slot = self.proof.sourceHeader.slot;
        self.historical_ancestry_branch_for_era(slot / SLOTS_PER_ERA)
    }

    /// The same branch built for the list position of `era`. For a neighbouring era it is the "wrong era index" attack: the
    /// builder stores the source header root at the same offset in the eras next to the source era, so this branch is a
    /// valid Merkle path of the anchor state and only the index of the bridge rejects it.
    pub fn historical_ancestry_branch_for_era(&self, era: u64) -> Option<Vec<B256>> {
        let capella_era = self.spec.capella_era().expect("a Capella schedule");
        let index = usize::try_from(era.checked_sub(capella_era)?).ok()?;
        self.anchor_state
            .has_historical_era(index)
            .then(|| self.anchor_state.historical_ancestry_branch(index, self.proof.sourceHeader.slot))
    }
}

/// Builds a message scenario whose source transaction and receipt sit at `transaction_index`, and whose message is log
/// `log_index` of that receipt. The block holds one transaction per receipt.
pub fn build_message(
    spec: &'static ChainSpec,
    receipts: &[ReceiptSpec],
    transaction_index: u64,
    log_index: u64,
    source_slot: u64,
    anchor_slot: u64,
) -> MessageScenario {
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
    let receipts_trie = build_indexed_trie(&encoded);
    let transactions: Vec<Bytes> = (0..receipts.len() as u64).map(synthetic_transaction).collect();
    let transactions_trie = build_indexed_trie(&transactions);

    let block_number = source_slot * 2;
    let header = if spec.fork_at_slot(source_slot) >= ForkName::Deneb {
        prague_header(block_number, receipts_trie.root, transactions_trie.root)
    } else {
        shanghai_header(block_number, receipts_trie.root, transactions_trie.root)
    };
    let header_rlp = encode_execution_header(&header);
    let position = transaction_index as usize;
    assemble_message(
        spec,
        &ExecutionBlockEvidence {
            header_rlp,
            block_number,
            receipts_root: receipts_trie.root,
            receipt_proof: receipts_trie.proofs[position].clone(),
            transaction_proof: transactions_trie.proofs[position].clone(),
            transaction: transactions[position].clone(),
        },
        transaction_index,
        log_index,
        source_slot,
        anchor_slot,
    )
}

/// The execution block part of a message proof: a header and the proofs of one receipt and one transaction.
pub struct ExecutionBlockEvidence {
    /// RLP of the execution header.
    pub header_rlp: Bytes,
    /// Block number inside the header.
    pub block_number: u64,
    /// Receipts root inside the header.
    pub receipts_root: B256,
    /// Proof nodes of the receipt at the transaction index.
    pub receipt_proof: Vec<Bytes>,
    /// Proof nodes of the transaction at the transaction index.
    pub transaction_proof: Vec<Bytes>,
    /// The bytes of that transaction.
    pub transaction: Bytes,
}

/// Wraps execution evidence in a synthetic beacon chain: a source beacon block whose payload names the block hash, and an
/// anchor whose state holds the source header in `block_roots`.
pub fn assemble_message(
    spec: &'static ChainSpec,
    evidence: &ExecutionBlockEvidence,
    transaction_index: u64,
    log_index: u64,
    source_slot: u64,
    anchor_slot: u64,
) -> MessageScenario {
    let block_hash = header_hash(&evidence.header_rlp);
    let block_number = evidence.block_number;
    let trie_root = evidence.receipts_root;
    let payload = synthetic_payload_header(spec, source_slot, block_number, block_hash, trie_root);
    let body = build_body_proofs(spec, source_slot, &payload);
    let source_header = BeaconBlockHeader {
        slot: source_slot,
        proposer_index: 7,
        parent_root: filler("source-parent", source_slot),
        state_root: filler("source-state-root", source_slot),
        body_root: body.body_root,
    };

    let mut anchor_state = StateBuilder::new(spec.fork_at_slot(anchor_slot));
    let source_root = source_header.hash_tree_root();
    anchor_state.set_block_root(source_slot, source_root);
    // The anchor state holds the source header root in EVERY place a mixed-up proof could point at: block_roots, the era of
    // the source block, and the two neighbouring eras (same offset). So each wrong branch is a valid Merkle path and only the
    // bridge's choice of index can refuse it. An era has an entry only when it is complete at the anchor and not before Capella.
    let capella_era = spec.capella_era().expect("a Capella schedule");
    let summary_count = (anchor_slot / SLOTS_PER_ERA).saturating_sub(capella_era) as usize;
    let source_era = source_slot / SLOTS_PER_ERA;
    for era in [source_era.wrapping_sub(1), source_era, source_era + 1] {
        let Some(index) = era.checked_sub(capella_era).map(|index| index as usize) else { continue };
        if index < summary_count {
            anchor_state.set_historical_block_root(summary_count, index, source_slot, source_root);
        }
    }
    let anchor_header = BeaconBlockHeader {
        slot: anchor_slot,
        proposer_index: 9,
        parent_root: filler("anchor-parent", anchor_slot),
        state_root: anchor_state.root(),
        body_root: filler("anchor-body", anchor_slot),
    };

    // The honest prover builds the branch of the path that the distance selects (the bridge makes the same choice).
    let ancestry_branch = if anchor_slot.saturating_sub(source_slot) > SLOTS_PER_ERA {
        let index = (source_era - capella_era) as usize;
        anchor_state.historical_ancestry_branch(index, source_slot)
    } else {
        anchor_state.block_roots_branch(source_slot)
    };

    let proof = MessageProof {
        anchorHeader: (&anchor_header).into(),
        sourceHeader: (&source_header).into(),
        ancestryBranch: ancestry_branch,
        blockHashBranch: body.block_hash_branch,
        executionHeaderRlp: evidence.header_rlp.clone(),
        receiptProof: evidence.receipt_proof.clone(),
        receiptIndex: U256::from(transaction_index),
        transactionProof: evidence.transaction_proof.clone(),
        transactionIndex: U256::from(transaction_index),
        logIndex: U256::from(log_index),
    };
    MessageScenario {
        spec,
        proof,
        stored_anchor_root: anchor_header.hash_tree_root(),
        anchor_state,
        source_block_hash: block_hash,
        source_transaction_hash: keccak256(&evidence.transaction),
    }
}
