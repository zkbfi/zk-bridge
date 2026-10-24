//! A synthetic beacon chain that follows the blocks of an execution chain, with sync committee signatures that are real.
//!
//! Every execution block `N` owns one beacon slot, in order, and the beacon block of that slot carries the execution
//! block as its payload (the block hash and the number are those of the Anvil block). The chain is a pure function of the
//! execution blocks: a restarted server rebuilds the same headers, so a light client that stored a header root before the
//! restart still finds it.
//!
//! What is real, as the light-client program checks it:
//!
//! - Each header names its parent by root, and its state by the hash tree root of a full `BeaconState`. The state holds the
//!   `block_roots` ring of the last 8192 headers, the finalized checkpoint, the fork, and the two sync committees of the
//!   period.
//! - Each block carries a sync aggregate: a BLS (Boneh-Lynn-Shacham) signature of the sync committee of its period over the root of the parent
//!   header, in the signing domain of the chain (fork version and genesis validators root of `lc-core`).
//! - A light-client update is assembled from those pieces the way a beacon node assembles it: the attested header is the
//!   block before the tip, the finalized header is `finality_slots` blocks before the attested one, and the aggregate is the
//!   one that the tip block carries.
//!
//! What is synthetic: the committees (512 keys made from a label, so the secrets are known), the validator registry (empty),
//! and the finality rule (a fixed number of slots, not epochs and votes). The fork stays Capella, because the block parser
//! of the prover reads Capella blocks only.
//!
//! The state root is computed from the field roots (SSZ means Simple Serialize, the byte format of the beacon chain), with the 28 field roots of an empty state as the template and the five
//! fields that change replaced. The served state bytes (`state_bytes`) are checked against that root in the tests.

use crate::error::{Error, Result};
use crate::light_client::{BlockView, ChainKind};
use alloy_primitives::B256;
use lc_core::chain::{ChainSpec, ForkName, MIN_PARTICIPANTS, SYNC_COMMITTEE_SIZE};
use lc_core::ssz::{branch_for_leaf, hash_pair, merkleize, sha256, u64_chunk};
use lc_core::ssz_state::{try_parse_state_form, ForkData, StateForm};
use lc_core::types::{
    compute_signing_root, sync_committee_domain, BeaconBlockHeader, LightClientUpdate,
    NextSyncCommittee, SyncAggregate,
};
use lc_testkit::block_bytes::{BlockBytes, PayloadFields};
use lc_testkit::json::{branch_json, light_client_header_json, sync_committee_json};
use lc_testkit::state_bytes::StateBytes;
use lc_testkit::synthetic::{committee_for, sign_with_first_members};
use serde_json::{json, Value};
use std::collections::HashMap;

/// The length of the `block_roots` ring, in slots.
const RING_SLOTS: u64 = 8192;
/// The field index of `slot` in a Capella `BeaconState`.
const FIELD_SLOT: usize = 2;
/// The field index of `fork`.
const FIELD_FORK: usize = 3;
/// The field index of `block_roots`.
const FIELD_BLOCK_ROOTS: usize = 5;
/// The field index of `finalized_checkpoint`.
const FIELD_FINALIZED_CHECKPOINT: usize = 20;
/// The field index of `current_sync_committee`.
const FIELD_CURRENT_SYNC_COMMITTEE: usize = 22;
/// The field index of `next_sync_committee`.
const FIELD_NEXT_SYNC_COMMITTEE: usize = 23;

/// The settings of a synthetic chain.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct ChainSettings {
    /// The chain specification: fork versions, genesis validators root, slot time. The slots must lie in its Capella fork.
    pub kind: ChainKind,
    /// The Unix time of slot 0. The timestamp of every execution block is `genesis_time + slot * seconds_per_slot`.
    pub genesis_time: u64,
    /// The slot of execution block 1.
    pub first_slot: u64,
    /// How many slots the finalized header lies behind the attested header.
    pub finality_slots: u64,
    /// How many of the 512 committee members sign each block.
    pub participants: usize,
}

impl ChainSettings {
    /// Checks the settings.
    ///
    /// # Errors
    /// `Error::Config` for a first slot below the length of the ring, a first slot outside the Capella fork, a finality
    /// distance of zero, or a participant count that the light-client program would refuse.
    pub fn validate(&self) -> Result<()> {
        let spec = self.kind.spec();
        if self.first_slot < RING_SLOTS {
            return Err(Error::Config(format!(
                "the first slot {} lies below {RING_SLOTS}, the length of the block roots ring",
                self.first_slot
            )));
        }
        let fork = spec.fork_at_slot(self.first_slot);
        if fork != ForkName::Capella {
            return Err(Error::Config(format!(
                "the first slot {} lies in the {fork:?} fork; the block parser of the prover reads Capella blocks only",
                self.first_slot
            )));
        }
        if self.finality_slots == 0 {
            return Err(Error::Config(
                "the finalized header must lie before the attested header".into(),
            ));
        }
        if !(MIN_PARTICIPANTS..=SYNC_COMMITTEE_SIZE).contains(&self.participants) {
            return Err(Error::Config(format!(
                "{} participants: the program needs {MIN_PARTICIPANTS} to {SYNC_COMMITTEE_SIZE}",
                self.participants
            )));
        }
        Ok(())
    }
}

/// One slot of the chain.
struct SlotRecord {
    /// The block, parsed from its own SSZ bytes.
    block: BlockView,
    /// The hash tree root of the header.
    root: B256,
    /// The SSZ bytes of the signed block.
    ssz: Vec<u8>,
    /// The sync aggregate that the block carries. It signs the parent header.
    aggregate: SyncAggregate,
}

/// The synthetic beacon chain. See the module documentation.
pub struct SyntheticBeaconChain {
    settings: ChainSettings,
    /// The 28 field roots of an empty Capella state. `state_fields` replaces five of them.
    template: Vec<B256>,
    slots: Vec<SlotRecord>,
    by_header_root: HashMap<B256, u64>,
    by_state_root: HashMap<B256, u64>,
}

/// The root that the ring holds for a slot before the first block. Nothing refers to it except the ring of the first
/// 8192 states.
fn root_before_first_block(slot: u64) -> B256 {
    sha256(format!("before the first block/{slot}").as_bytes())
}

/// The `fork` field of a state at `slot`: the entry of the fork schedule that is active, and the one before it.
fn fork_data_at(spec: &ChainSpec, slot: u64) -> ForkData {
    let epoch = spec.epoch_at_slot(slot);
    let active = spec
        .fork_schedule
        .iter()
        .rposition(|entry| entry.epoch <= epoch)
        .unwrap_or(0);
    let current = spec.fork_schedule[active];
    let previous = spec.fork_schedule[active.saturating_sub(1)];
    ForkData {
        previous_version: previous.fork_version,
        current_version: current.fork_version,
        epoch: current.epoch,
    }
}

fn slots_per_period(spec: &ChainSpec) -> u64 {
    spec.epochs_per_sync_committee_period * spec.slots_per_epoch
}

fn malformed(error: impl std::fmt::Display) -> Error {
    Error::Malformed(format!("synthetic beacon chain: {error}"))
}

impl SyntheticBeaconChain {
    /// An empty chain.
    ///
    /// # Errors
    /// `Error::Config` for settings that `ChainSettings::validate` refuses. `Error::Malformed` when the template state does
    /// not parse.
    pub fn new(settings: ChainSettings) -> Result<Self> {
        settings.validate()?;
        let spec = settings.kind.spec();
        let committee = committee_for(spec, spec.period_at_slot(settings.first_slot));
        let empty_state = StateBytes::new(
            ForkName::Capella,
            settings.first_slot,
            committee.committee.clone(),
            committee.committee.clone(),
        )
        .to_ssz();
        let template = try_parse_state_form(&empty_state, StateForm::Capella)
            .map_err(malformed)?
            .field_roots;
        Ok(Self {
            settings,
            template,
            slots: Vec::new(),
            by_header_root: HashMap::new(),
            by_state_root: HashMap::new(),
        })
    }

    /// The settings.
    pub fn settings(&self) -> &ChainSettings {
        &self.settings
    }

    fn spec(&self) -> &'static ChainSpec {
        self.settings.kind.spec()
    }

    /// The slot of the newest block, or `None` for an empty chain.
    pub fn tip_slot(&self) -> Option<u64> {
        (self.slots.len() as u64)
            .checked_sub(1)
            .map(|offset| self.settings.first_slot + offset)
    }

    /// The slot that the next execution block takes.
    pub fn next_slot(&self) -> u64 {
        self.settings.first_slot + self.slots.len() as u64
    }

    /// The number of the next execution block. Block 1 takes the first slot, and blocks follow without a gap.
    pub fn next_block_number(&self) -> u64 {
        self.slots.len() as u64 + 1
    }

    /// The execution block hash that the newest block carries, with its number.
    pub fn tip_execution_block(&self) -> Option<(u64, B256)> {
        let record = self.slots.last()?;
        Some((
            record.block.payload.block_number,
            record.block.payload.block_hash,
        ))
    }

    /// The Unix time at which `slot` starts.
    pub fn slot_start_time(&self, slot: u64) -> u64 {
        self.settings.genesis_time + slot * self.spec().seconds_per_slot
    }

    fn record(&self, slot: u64) -> Option<&SlotRecord> {
        let offset = slot.checked_sub(self.settings.first_slot)?;
        self.slots.get(usize::try_from(offset).ok()?)
    }

    fn required_record(&self, slot: u64) -> Result<&SlotRecord> {
        self.record(slot)
            .ok_or_else(|| Error::Beacon(format!("the chain holds no block at slot {slot}")))
    }

    /// The root that the ring holds for `slot`, which lies before the next slot.
    fn root_at(&self, slot: u64) -> B256 {
        self.record(slot)
            .map_or_else(|| root_before_first_block(slot), |record| record.root)
    }

    /// The header at `slot`.
    pub fn header_at(&self, slot: u64) -> Option<BeaconBlockHeader> {
        self.record(slot).map(|record| record.block.header)
    }

    /// The slot of the header with this root.
    pub fn slot_of_header_root(&self, root: &B256) -> Option<u64> {
        self.by_header_root.get(root).copied()
    }

    /// The slot of the state with this root.
    pub fn slot_of_state_root(&self, root: &B256) -> Option<u64> {
        self.by_state_root.get(root).copied()
    }

    /// The root of the header at `slot`.
    pub fn header_root_at(&self, slot: u64) -> Option<B256> {
        self.record(slot).map(|record| record.root)
    }

    /// The SSZ bytes of the signed block at `slot`.
    pub fn block_bytes(&self, slot: u64) -> Option<&[u8]> {
        self.record(slot).map(|record| record.ssz.as_slice())
    }

    /// The `block_roots` ring of the state at `slot`: entry `i` holds the root of the newest slot below `slot` that is
    /// `i` modulo 8192.
    fn block_roots_at(&self, slot: u64) -> Vec<B256> {
        (0..RING_SLOTS)
            .map(|index| {
                let offset = (index + RING_SLOTS - slot % RING_SLOTS) % RING_SLOTS;
                self.root_at(slot - RING_SLOTS + offset)
            })
            .collect()
    }

    /// The finalized checkpoint of the state at `slot`: the epoch and the root of the header `finality_slots` before it.
    fn finalized_checkpoint_at(&self, slot: u64) -> (u64, B256) {
        let finalized_slot = slot - self.settings.finality_slots;
        (
            self.spec().epoch_at_slot(finalized_slot),
            self.root_at(finalized_slot),
        )
    }

    fn committee_root(&self, period: u64) -> Result<B256> {
        committee_for(self.spec(), period)
            .committee
            .hash_tree_root()
            .map_err(malformed)
    }

    /// The 28 field roots of the state at `slot`, from the template and the five fields that change.
    fn state_fields(&self, slot: u64) -> Result<Vec<B256>> {
        let spec = self.spec();
        let period = spec.period_at_slot(slot);
        let (epoch, finalized_root) = self.finalized_checkpoint_at(slot);
        let mut fields = self.template.clone();
        fields[FIELD_SLOT] = u64_chunk(slot);
        fields[FIELD_FORK] = fork_data_at(spec, slot).hash_tree_root();
        fields[FIELD_BLOCK_ROOTS] = merkleize(&self.block_roots_at(slot));
        fields[FIELD_FINALIZED_CHECKPOINT] = hash_pair(&u64_chunk(epoch), &finalized_root);
        fields[FIELD_CURRENT_SYNC_COMMITTEE] = self.committee_root(period)?;
        fields[FIELD_NEXT_SYNC_COMMITTEE] = self.committee_root(period + 1)?;
        Ok(fields)
    }

    /// The sync aggregate of the block at `slot`: the first `participants` members of the committee of the period sign
    /// the root of the parent header.
    fn aggregate_for(&self, slot: u64, parent_root: B256) -> SyncAggregate {
        let spec = self.spec();
        let committee = committee_for(spec, spec.period_at_slot(slot));
        let signing_root = compute_signing_root(&parent_root, &sync_committee_domain(spec, slot));
        sign_with_first_members(&committee, self.settings.participants, &signing_root)
    }

    /// Adds the beacon block of the next execution block.
    ///
    /// # Errors
    /// `Error::Beacon` when the block number is not the next one, when the timestamp is not the start of the next slot, or
    /// when the slot leaves the Capella fork. `Error::Malformed` when the block does not parse back.
    pub fn extend(&mut self, payload: PayloadFields) -> Result<()> {
        let slot = self.next_slot();
        if payload.block_number != self.next_block_number() {
            return Err(Error::Beacon(format!(
                "the next block must be number {}, not {}",
                self.next_block_number(),
                payload.block_number
            )));
        }
        if payload.timestamp != self.slot_start_time(slot) {
            return Err(Error::Beacon(format!(
                "block {} has timestamp {}, but slot {slot} starts at {}: the execution chain must mine one block per slot, on the slot grid",
                payload.block_number,
                payload.timestamp,
                self.slot_start_time(slot)
            )));
        }
        let fork = self.spec().fork_at_slot(slot);
        if fork != ForkName::Capella {
            return Err(Error::Beacon(format!(
                "slot {slot} leaves the Capella fork ({fork:?}); the chain has run out of its fork"
            )));
        }
        let parent_root = self.root_at(slot - 1);
        let state_root = merkleize(&self.state_fields(slot)?);
        let aggregate = self.aggregate_for(slot, parent_root);
        let ssz = BlockBytes {
            slot,
            proposer_index: slot % 1000,
            parent_root,
            state_root,
            sync_aggregate: aggregate.clone(),
            payload,
        }
        .to_ssz();
        let block = BlockView::parse(&ssz)?;
        let root = block.header.hash_tree_root();
        self.by_header_root.insert(root, slot);
        self.by_state_root.insert(state_root, slot);
        self.slots.push(SlotRecord {
            block,
            root,
            ssz,
            aggregate,
        });
        Ok(())
    }

    /// The SSZ bytes of the state at `slot`. They hash to the `state_root` of the header at `slot`.
    ///
    /// # Errors
    /// `Error::Beacon` when the chain holds no block at `slot`.
    pub fn state_bytes(&self, slot: u64) -> Result<Vec<u8>> {
        self.required_record(slot)?;
        let spec = self.spec();
        let period = spec.period_at_slot(slot);
        let mut state = StateBytes::new(
            ForkName::Capella,
            slot,
            committee_for(spec, period).committee.clone(),
            committee_for(spec, period + 1).committee.clone(),
        );
        state.fork_data = fork_data_at(spec, slot);
        state.block_roots = self.block_roots_at(slot);
        state.finalized_checkpoint = self.finalized_checkpoint_at(slot);
        Ok(state.to_ssz())
    }

    /// The update that the block at `signature_slot` makes possible: the block before it is attested, and the aggregate of
    /// the block itself signs the attested header. A handoff update also proves the next sync committee.
    fn update_signed_at(
        &self,
        signature_slot: u64,
        prove_next_committee: NextCommittee,
    ) -> Result<LightClientUpdate> {
        let attested_slot = signature_slot - 1;
        let finalized_slot = attested_slot
            .checked_sub(self.settings.finality_slots)
            .ok_or_else(|| Error::Beacon("the chain is too young for a finality update".into()))?;
        let signature = self.required_record(signature_slot)?;
        let attested = self.required_record(attested_slot)?;
        let finalized = self.required_record(finalized_slot).map_err(|_| {
            Error::Beacon(format!(
                "the chain holds no block at the finalized slot {finalized_slot}: too few blocks"
            ))
        })?;
        let fields = self.state_fields(attested_slot)?;
        let (epoch, _) = self.finalized_checkpoint_at(attested_slot);
        let mut finality_branch = vec![u64_chunk(epoch)];
        finality_branch.extend(branch_for_leaf(&fields, FIELD_FINALIZED_CHECKPOINT).1);
        let next_sync_committee = match prove_next_committee {
            NextCommittee::Omitted => None,
            NextCommittee::Proven => {
                let period = self.spec().period_at_slot(attested_slot);
                Some(NextSyncCommittee {
                    committee: committee_for(self.spec(), period + 1).committee.clone(),
                    branch: branch_for_leaf(&fields, FIELD_NEXT_SYNC_COMMITTEE).1,
                })
            }
        };
        Ok(LightClientUpdate {
            attested_header: attested.block.as_light_client_header(),
            next_sync_committee,
            finalized_header: finalized.block.as_light_client_header(),
            finality_branch,
            sync_aggregate: signature.aggregate.clone(),
            signature_slot,
        })
    }

    /// The finality update at the tip: what `/eth/v1/beacon/light_client/finality_update` serves. It proves no next committee.
    ///
    /// # Errors
    /// `Error::Beacon` when the chain is too young.
    pub fn finality_update(&self) -> Result<LightClientUpdate> {
        let tip = self
            .tip_slot()
            .ok_or_else(|| Error::Beacon("the chain holds no block".into()))?;
        self.update_signed_at(tip, NextCommittee::Omitted)
    }

    /// The handoff update of `period`: the update at the last slot of the period, which proves the next committee. It is
    /// what `/eth/v1/beacon/light_client/updates` serves for the period. `None` while the chain has not reached the end of
    /// the period.
    ///
    /// # Errors
    /// `Error::Beacon` when the chain starts too close to the end of the period for an update.
    pub fn period_update(&self, period: u64) -> Result<Option<LightClientUpdate>> {
        let last_slot = (period + 1) * slots_per_period(self.spec()) - 1;
        if self.tip_slot().is_none_or(|tip| tip < last_slot) {
            return Ok(None);
        }
        self.update_signed_at(last_slot, NextCommittee::Proven)
            .map(Some)
    }

    /// The `data` object of `/eth/v1/beacon/light_client/bootstrap/<root>` for the header at `slot`.
    ///
    /// # Errors
    /// `Error::Beacon` when the chain holds no block at `slot`.
    pub fn bootstrap_json(&self, slot: u64) -> Result<Value> {
        let record = self.required_record(slot)?;
        let spec = self.spec();
        let fields = self.state_fields(slot)?;
        Ok(json!({
            "header": light_client_header_json(&record.block.as_light_client_header()),
            "current_sync_committee": sync_committee_json(&committee_for(spec, spec.period_at_slot(slot)).committee),
            "current_sync_committee_branch": branch_json(&branch_for_leaf(&fields, FIELD_CURRENT_SYNC_COMMITTEE).1),
        }))
    }
}

/// Whether an update carries a proof of the next sync committee.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum NextCommittee {
    /// A finality update carries none.
    Omitted,
    /// A handoff update carries it, with its branch.
    Proven,
}

/// Helpers that the tests of this module and of `api` and `node` share.
#[cfg(test)]
pub(crate) mod test_support {
    use super::*;
    use alloy_primitives::{Address, U256};

    pub const FINALITY_SLOTS: u64 = 2;

    pub fn settings(kind: ChainKind, first_slot: u64) -> ChainSettings {
        ChainSettings {
            kind,
            genesis_time: 1_700_000_000,
            first_slot,
            finality_slots: FINALITY_SLOTS,
            participants: 400,
        }
    }

    /// The first slot of a chain that crosses the end of its period after `blocks_before_the_end` blocks.
    pub fn first_slot_before_period_end(
        kind: ChainKind,
        period: u64,
        blocks_before_the_end: u64,
    ) -> u64 {
        (period + 1) * slots_per_period(kind.spec()) - blocks_before_the_end
    }

    pub fn payload(chain: &SyntheticBeaconChain) -> PayloadFields {
        let number = chain.next_block_number();
        PayloadFields {
            parent_hash: sha256(format!("execution block {}", number - 1).as_bytes()),
            fee_recipient: Address::repeat_byte(0x0f),
            state_root: sha256(b"execution state"),
            receipts_root: sha256(format!("receipts {number}").as_bytes()),
            logs_bloom: vec![0u8; 256],
            prev_randao: sha256(b"randao"),
            block_number: number,
            gas_limit: 30_000_000,
            gas_used: 21_000,
            timestamp: chain.slot_start_time(chain.next_slot()),
            extra_data: Vec::new(),
            base_fee_per_gas: U256::from(7u64),
            block_hash: sha256(format!("execution block {number}").as_bytes()),
        }
    }

    pub fn chain_of(settings: ChainSettings, blocks: u64) -> SyntheticBeaconChain {
        let mut chain = SyntheticBeaconChain::new(settings).expect("chain");
        for _ in 0..blocks {
            let next = payload(&chain);
            chain.extend(next).expect("extend");
        }
        chain
    }

    pub fn first_slot_of(kind: ChainKind) -> u64 {
        crate::local_network::signed_beacon::node::default_first_slot(kind)
    }

    /// A sync committee period inside the Capella fork of the chain, far from every fork border.
    pub fn capella_period_of(kind: ChainKind) -> u64 {
        match kind {
            ChainKind::Ethereum => 800,
            ChainKind::Pulsechain => 1330,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::test_support::*;
    use super::*;
    use crate::light_client::{
        store_at, store_from_bootstrap_json, verify_update_natively, StateView, UpdateInput,
    };

    const KINDS: [ChainKind; 2] = [ChainKind::Ethereum, ChainKind::Pulsechain];

    /// The store of a light client whose head is the header at `slot`, from the state that the chain serves for it.
    fn store_at_slot(
        chain: &SyntheticBeaconChain,
        slot: u64,
    ) -> crate::light_client::LightClientStore {
        let state = StateView::parse(&chain.state_bytes(slot).unwrap(), chain.settings().kind)
            .expect("the served state parses");
        store_at(&chain.header_at(slot).unwrap(), &state, true)
    }

    /// Claim: the state that the chain serves for a slot hashes, parsed in full, to the `state_root` of the header at that
    /// slot, and it holds the root of every earlier header in the ring, the parent included.
    /// Why it matters: the light client stores header roots; a withdrawal proves a deposit header against the state root of
    /// the head. If the fast root and the served bytes disagreed, no state would match any header.
    #[test]
    fn the_served_state_hashes_to_the_state_root_of_its_header() {
        for kind in KINDS {
            let first_slot = first_slot_of(kind);
            let chain = chain_of(settings(kind, first_slot), 12);
            for slot in [first_slot, first_slot + 5, first_slot + 11] {
                let state = StateView::parse(&chain.state_bytes(slot).unwrap(), kind).unwrap();
                let header = chain.header_at(slot).unwrap();
                assert_eq!(state.root(), header.state_root, "{kind:?} slot {slot}");
                assert_eq!(state.slot(), slot);
                assert_eq!(
                    state.block_root_at(slot - 1),
                    header.parent_root,
                    "{kind:?}: the parent sits in the ring"
                );
                let finalized = chain.finalized_checkpoint_at(slot);
                assert_eq!(state.finalized_checkpoint(), finalized);
            }
            let wrong = chain.header_at(first_slot + 4).unwrap().state_root;
            let other =
                StateView::parse(&chain.state_bytes(first_slot + 5).unwrap(), kind).unwrap();
            assert_ne!(
                other.root(),
                wrong,
                "control: two slots have two state roots"
            );
        }
    }

    /// Claim: each header names the root of the header before it as parent, the first slot's parent is the filler root, and
    /// the block bytes served for a slot parse back to the header and to the execution block that went in.
    #[test]
    fn blocks_form_a_chain_and_carry_their_execution_block() {
        let kind = ChainKind::Ethereum;
        let first_slot = first_slot_of(kind);
        let chain = chain_of(settings(kind, first_slot), 6);
        for offset in 1..6 {
            let slot = first_slot + offset;
            let parent = chain.header_root_at(slot - 1).unwrap();
            assert_eq!(chain.header_at(slot).unwrap().parent_root, parent);
            let view = BlockView::parse(chain.block_bytes(slot).unwrap()).unwrap();
            assert_eq!(view.header, chain.header_at(slot).unwrap());
            assert_eq!(view.payload.block_number, offset + 1);
            assert_eq!(
                view.payload.block_hash,
                sha256(format!("execution block {}", offset + 1).as_bytes())
            );
            assert_eq!(
                chain.slot_of_header_root(&view.header.hash_tree_root()),
                Some(slot)
            );
        }
        assert_eq!(
            chain.header_at(first_slot).unwrap().parent_root,
            root_before_first_block(first_slot - 1)
        );
    }

    /// Claim: the finality update at the tip passes the light-client program, natively, for both chains: the BLS signature of
    /// the tip block over the attested header, the finality branch, both execution branches, and the committee. The new head
    /// is the block `finality_slots + 1` below the tip.
    /// Why it matters: the real proof proves the same program on the same update. A wrong domain, a wrong branch or a wrong
    /// committee would make the proof fail after ten minutes of proving.
    #[test]
    fn the_finality_update_passes_the_light_client_program() {
        for kind in KINDS {
            let first_slot = first_slot_of(kind);
            let chain = chain_of(settings(kind, first_slot), 12);
            let store = store_at_slot(&chain, first_slot + 2);
            let update = chain.finality_update().unwrap();
            let tip = chain.tip_slot().unwrap();
            let output = verify_update_natively(&UpdateInput {
                chain: kind,
                store,
                updates: vec![update],
            })
            .unwrap_or_else(|error| panic!("{kind:?}: {error}"));
            assert_eq!(output.newHeadSlot, tip - 1 - FINALITY_SLOTS, "{kind:?}");
            assert_eq!(
                output.newHeaderRoot,
                chain.header_root_at(tip - 1 - FINALITY_SLOTS).unwrap()
            );
            assert_eq!(output.previousHeadSlot, first_slot + 2);
            assert_eq!(
                output.genesisValidatorsRoot,
                kind.spec().genesis_validators_root
            );
            let execution_hash = chain.tip_execution_block().unwrap().1;
            assert_ne!(
                output.executionBlockHash, execution_hash,
                "control: the head is not the tip block"
            );
        }
    }

    /// Claim: the program refuses the update when the aggregate signs another header, when 341 of 512 members sign, and when
    /// the committee is not the stored one.
    /// Why it matters: these are the controls of the test above. An update that the program accepted whatever the signature
    /// would pass it too.
    #[test]
    fn the_program_refuses_a_forged_update() {
        let kind = ChainKind::Pulsechain;
        let first_slot = first_slot_of(kind);
        let chain = chain_of(settings(kind, first_slot), 12);
        let store = store_at_slot(&chain, first_slot + 2);
        let run = |update: LightClientUpdate, store: crate::light_client::LightClientStore| {
            verify_update_natively(&UpdateInput {
                chain: kind,
                store,
                updates: vec![update],
            })
        };
        assert!(run(chain.finality_update().unwrap(), store.clone()).is_ok());

        let mut other_header = chain.finality_update().unwrap();
        other_header.attested_header = chain
            .required_record(first_slot + 3)
            .unwrap()
            .block
            .as_light_client_header();
        assert!(
            run(other_header, store.clone()).is_err(),
            "a signature of another header"
        );

        let mut thin = chain.finality_update().unwrap();
        thin.sync_aggregate.sync_committee_bits[0] = 0;
        thin.sync_aggregate.sync_committee_bits[1] = 0;
        assert!(
            run(thin, store.clone()).is_err(),
            "fewer members than the bits claim"
        );

        let mut wrong_store = store;
        wrong_store.current_sync_committee = committee_for(kind.spec(), 1).committee.clone();
        assert!(
            run(chain.finality_update().unwrap(), wrong_store).is_err(),
            "another committee"
        );
    }

    /// Claim: a chain that crosses the end of its sync committee period serves the handoff update of the old period, and
    /// the fold of that update and the finality update passes the program and ends in the new period, for both chains. A
    /// finality update alone also crosses, when the store knows the next committee.
    /// Why it matters: the real chain does not stop at a period border, and the prover builds exactly this fold.
    #[test]
    fn a_fold_across_a_period_border_passes_the_light_client_program() {
        for kind in KINDS {
            let spec = kind.spec();
            let period = capella_period_of(kind);
            let first_slot = first_slot_before_period_end(kind, period, 30);
            let chain = chain_of(settings(kind, first_slot), 80);
            let store = store_at_slot(&chain, first_slot + 2);
            let handoff = chain
                .period_update(period)
                .unwrap()
                .expect("the chain reached the end of the period");
            assert!(handoff.next_sync_committee.is_some());
            let finality = chain.finality_update().unwrap();
            let head = finality.finalized_header.beacon.slot;
            assert_eq!(spec.period_at_slot(head), period + 1, "{kind:?}");
            let fold = verify_update_natively(&UpdateInput {
                chain: kind,
                store: store.clone(),
                updates: vec![handoff, finality.clone()],
            })
            .unwrap_or_else(|error| panic!("{kind:?}: {error}"));
            assert_eq!(fold.newHeadSlot, head);
            assert_ne!(
                fold.syncCommitteeHash, fold.previousSyncCommitteeHash,
                "{kind:?}: the committee changed"
            );
            let single = verify_update_natively(&UpdateInput {
                chain: kind,
                store,
                updates: vec![finality],
            })
            .unwrap_or_else(|error| panic!("{kind:?}: {error}"));
            assert_eq!(single.newHeadSlot, head);
            assert!(
                chain.period_update(period + 1).unwrap().is_none(),
                "the next period has not ended"
            );
        }
    }

    /// Claim: the bootstrap of a header gives a store with the header root, the slot and the committee of its period.
    #[test]
    fn the_bootstrap_gives_the_store_of_its_header() {
        let kind = ChainKind::Ethereum;
        let first_slot = first_slot_of(kind);
        let chain = chain_of(settings(kind, first_slot), 5);
        let slot = first_slot + 3;
        let store = store_from_bootstrap_json(&chain.bootstrap_json(slot).unwrap()).unwrap();
        assert_eq!(store.header_slot, slot);
        assert_eq!(store.header_root, chain.header_root_at(slot).unwrap());
        assert_eq!(
            store.current_sync_committee,
            store_at_slot(&chain, slot).current_sync_committee
        );
        assert!(store.next_sync_committee.is_none());
    }

    /// Claim: the chain refuses a block that is not the next number, a timestamp off the slot grid, and settings that the
    /// program or the parser would refuse.
    #[test]
    fn the_chain_refuses_blocks_and_settings_that_do_not_fit() {
        let kind = ChainKind::Ethereum;
        let first_slot = first_slot_of(kind);
        let mut chain = chain_of(settings(kind, first_slot), 2);
        let mut skipped = payload(&chain);
        skipped.block_number += 1;
        assert!(chain.extend(skipped).is_err(), "a gap in the block numbers");
        let mut late = payload(&chain);
        late.timestamp += 1;
        assert!(chain.extend(late).is_err(), "a timestamp off the grid");
        assert_eq!(chain.next_block_number(), 3, "nothing was added");
        let good = payload(&chain);
        assert!(chain.extend(good).is_ok(), "control: a good block fits");

        let bad = |change: fn(&mut ChainSettings)| {
            let mut changed = settings(kind, first_slot);
            change(&mut changed);
            SyntheticBeaconChain::new(changed).is_err()
        };
        assert!(
            bad(|s| s.participants = 341),
            "341 of 512 fail the two thirds rule"
        );
        assert!(bad(|s| s.finality_slots = 0));
        assert!(bad(|s| s.first_slot = 100), "below the ring");
        assert!(
            bad(|s| s.first_slot = 8_700_000),
            "after the Capella fork of Ethereum"
        );
        assert!(SyntheticBeaconChain::new(settings(kind, first_slot)).is_ok());
    }
}
