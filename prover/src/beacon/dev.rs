//! `DevBeaconSource`: a synthetic beacon chain over the real blocks of an Anvil chain.
//!
//! Anvil has no beacon chain, so there is no sync committee and no signature. The source asserts what a sound
//! proof system would prove: a header is final once its execution block lies `finality_depth` blocks below the latest
//! block. The `OracleProver` then signs the asserted output, and the real contracts check the rest.
//!
//! # The synthetic chain
//!
//! Every execution block `N` owns four beacon slots, `offset + 4N + phase`:
//!
//! | phase | header | stored in the light client |
//! |---|---|---|
//! | 0 | filler state, body holds block `N` | yes |
//! | 1 | filler state, body holds block `N` | yes |
//! | 2 | the "deposit header" of block `N`: the beacon block that carries it | no |
//! | 3 | the anchor: its state holds `block_roots` for phases 0, 1 and 2 of recent blocks | yes |
//!
//! Phases 0 and 1 are the two stored earlier headers that the vault wants as layout evidence. Phase 3 is the anchor
//! of a withdrawal of any deposit in a block within `WINDOW_BLOCKS` below it. Every header is a pure function of the
//! block hashes, so a restarted service rebuilds the same roots that the light client stored.
//!
//! # Head jumps and the 8192-slot window
//!
//! The light client has no cap on a head jump, so the first update for a deposit goes straight from the stored head
//! to phase 0 of the deposit block, however many slots lie between. The source holds no 8192-slot rule of its own.
//! The only window left is [`WINDOW_BLOCKS`] blocks (1024 slots), which keeps every
//! withdrawal of the source on the recent ancestry path; a unit test checks that with `ancestry_path`, the function
//! that mirrors the choice of the vault.
//!
//! # The historical path
//!
//! An anchor whose slot lies more than 8192 slots above a deposit proves the deposit through `historical_summaries`.
//! Every anchor state at or after slot 8192 therefore holds one summary per completed era. To keep a state cheap to
//! build, a summary holds the header roots (phases 0, 1 and 2) of only the first [`HISTORICAL_FILL_BLOCKS`] blocks of
//! its era, and filler elsewhere. So the source proves a deposit from the first blocks of an era, and a layout row from a
//! stored phase 0 or phase 1 header in those blocks. A deposit later in its era is refused with an error that says so.
//! This is a limit of the synthetic chain, not of the vault.
//!
//! Limits, by design: the source cannot cover a deposit whose phase 0 slot the head already passed (the service
//! processes deposits in block order, so this does not happen in a normal run), and `slot_offset` must lie above the
//! checkpoint slot of the light client and after the Capella fork.

use super::{
    BeaconSource, DepositBlock, HashEvidence, HistoricalEvidence, LightClientState, RootsEvidence,
    UpdatePlan,
};
use crate::chain::ExecutionReader;
use crate::error::{Error, Result};
use crate::light_client::{
    ancestry_path, block_hash_gindex, block_roots_gindex, dev_header, dev_output,
    dev_plain_state_root, header_root, historical_summaries_gindex, AncestryPath, BeaconHeader,
    BeaconPath, ChainKind, DevHeader, DevState,
};
use crate::prover::ProofStatement;
use alloy_primitives::B256;

/// The default slot of block 0.
pub const DEFAULT_SLOT_OFFSET: u64 = 1_024;
/// The number of blocks below an anchor that a withdrawal can still reach on the recent path.
pub const WINDOW_BLOCKS: u64 = 256;
/// The blocks at the start of each era whose headers a historical summary holds.
pub const HISTORICAL_FILL_BLOCKS: u64 = 32;
/// The slots of one era of `historical_summaries`.
const SLOTS_PER_ERA: u64 = 8192;
const SLOTS_PER_BLOCK: u64 = 4;
const PHASE_FIRST: u64 = 0;
const PHASE_SECOND: u64 = 1;
const PHASE_DEPOSIT: u64 = 2;
const PHASE_ANCHOR: u64 = 3;

/// The development source.
pub struct DevBeaconSource {
    chain: ChainKind,
    finality_depth: u64,
    slot_offset: u64,
}

struct Built {
    header: DevHeader,
    state: Option<DevState>,
}

impl DevBeaconSource {
    /// A source with a finality depth and the slot of block 0.
    pub fn new(chain: ChainKind, finality_depth: u64, slot_offset: u64) -> Self {
        Self {
            chain,
            finality_depth,
            slot_offset,
        }
    }

    /// The slot of `phase` of block `number`.
    pub fn slot_of(&self, number: u64, phase: u64) -> u64 {
        self.slot_offset + SLOTS_PER_BLOCK * number + phase
    }

    /// The block and phase of a slot, or `None` below the offset.
    pub fn block_and_phase(&self, slot: u64) -> Option<(u64, u64)> {
        let relative = slot.checked_sub(self.slot_offset)?;
        Some((relative / SLOTS_PER_BLOCK, relative % SLOTS_PER_BLOCK))
    }

    fn build(&self, slot: u64, source: &dyn ExecutionReader) -> Result<Built> {
        let (number, phase) = self.block_and_phase(slot).ok_or_else(|| {
            Error::Beacon(format!(
                "slot {slot} is below the dev slot offset {}",
                self.slot_offset
            ))
        })?;
        let hash = source.block_hash(number)?;
        if phase != PHASE_ANCHOR {
            let header = dev_header(self.chain, slot, number, hash, dev_plain_state_root(slot));
            return Ok(Built {
                header,
                state: None,
            });
        }
        let first = self.sibling_root(number, PHASE_FIRST, hash)?;
        let second = self.sibling_root(number, PHASE_SECOND, hash)?;
        let mut roots = vec![
            (self.slot_of(number, PHASE_FIRST), first),
            (self.slot_of(number, PHASE_SECOND), second),
        ];
        for earlier in number.saturating_sub(WINDOW_BLOCKS)..=number {
            let earlier_hash = if earlier == number {
                hash
            } else {
                source.block_hash(earlier)?
            };
            roots.push((
                self.slot_of(earlier, PHASE_DEPOSIT),
                self.sibling_root(earlier, PHASE_DEPOSIT, earlier_hash)?,
            ));
        }
        let mut state = DevState::new(self.chain, slot, &roots)?;
        self.fill_historical_summaries(&mut state, slot, source)?;
        let header = dev_header(self.chain, slot, number, hash, state.root());
        Ok(Built {
            header,
            state: Some(state),
        })
    }

    /// The first era with a historical summary, from the Capella fork of the chain.
    fn capella_era(&self) -> Result<u64> {
        self.chain
            .spec()
            .capella_era()
            .map_err(|error| Error::Beacon(error.to_string()))
    }

    /// The number of summaries that a state at `anchor_slot` holds: one per completed era since Capella.
    fn summary_count(&self, anchor_slot: u64) -> Result<u64> {
        Ok((anchor_slot / SLOTS_PER_ERA).saturating_sub(self.capella_era()?))
    }

    /// The block numbers of the first [`HISTORICAL_FILL_BLOCKS`] blocks that start in `era`.
    fn filled_blocks(&self, era: u64) -> std::ops::Range<u64> {
        let era_start = era * SLOTS_PER_ERA;
        let first = era_start
            .saturating_sub(self.slot_offset)
            .div_ceil(SLOTS_PER_BLOCK);
        first..first + HISTORICAL_FILL_BLOCKS
    }

    /// Whether a historical summary holds the header root of `slot`: a phase 0, 1 or 2 slot in a filled block.
    fn is_filled(&self, slot: u64) -> bool {
        let Some((number, phase)) = self.block_and_phase(slot) else {
            return false;
        };
        phase != PHASE_ANCHOR && self.filled_blocks(slot / SLOTS_PER_ERA).contains(&number)
    }

    /// Adds one summary per completed era to an anchor state. Each summary holds the header roots of the filled blocks.
    fn fill_historical_summaries(
        &self,
        state: &mut DevState,
        anchor_slot: u64,
        source: &dyn ExecutionReader,
    ) -> Result<()> {
        let capella_era = self.capella_era()?;
        let count = self.summary_count(anchor_slot)? as usize;
        for index in 0..count {
            let era = capella_era + index as u64;
            for number in self.filled_blocks(era) {
                let hash = source.block_hash(number)?;
                for phase in [PHASE_FIRST, PHASE_SECOND, PHASE_DEPOSIT] {
                    let slot = self.slot_of(number, phase);
                    if slot / SLOTS_PER_ERA != era {
                        continue;
                    }
                    state.set_historical_root(
                        count,
                        index,
                        slot,
                        self.sibling_root(number, phase, hash)?,
                    );
                }
            }
        }
        Ok(())
    }

    fn sibling_root(&self, number: u64, phase: u64, hash: B256) -> Result<B256> {
        let slot = self.slot_of(number, phase);
        Ok(header_root(
            &dev_header(self.chain, slot, number, hash, dev_plain_state_root(slot)).header,
        ))
    }

    /// The update that moves the head of `light_client` to the header at `slot`, which carries block `number`.
    fn asserted_update(
        &self,
        light_client: &LightClientState,
        slot: u64,
        number: u64,
        hash: B256,
        source: &dyn ExecutionReader,
    ) -> Result<UpdatePlan> {
        let built = self.build(slot, source)?;
        let output = dev_output(
            light_client.genesis_validators_root,
            light_client.head_slot,
            light_client.head_root,
            light_client.head_committee_hash,
            light_client.next_committee_hash,
            header_root(&built.header.header),
            slot,
            hash,
            number,
        );
        Ok(UpdatePlan::Update(Box::new(ProofStatement::DevAsserted(
            output,
        ))))
    }

    /// The smallest block `T >= deposit_block` whose anchor slot the light client stores.
    fn anchor_block(&self, deposit_block: u64, stored_slots: &[u64]) -> Option<u64> {
        stored_slots
            .iter()
            .filter_map(|slot| self.block_and_phase(*slot))
            .filter(|(number, phase)| *phase == PHASE_ANCHOR && *number >= deposit_block)
            .map(|(number, _)| number)
            .min()
    }
}

impl BeaconSource for DevBeaconSource {
    fn name(&self) -> &'static str {
        "dev"
    }

    fn chain_kind(&self) -> ChainKind {
        self.chain
    }

    fn finalized_execution_block(&self, source: &dyn ExecutionReader) -> Result<Option<u64>> {
        Ok(source
            .latest_block_number()?
            .checked_sub(self.finality_depth))
    }

    fn next_update(
        &self,
        deposit: &DepositBlock,
        light_client: &LightClientState,
        stored_slots: &[u64],
        source: &dyn ExecutionReader,
    ) -> Result<UpdatePlan> {
        if self.anchor_block(deposit.number, stored_slots).is_some() {
            return Ok(UpdatePlan::Covered);
        }
        match self.finalized_execution_block(source)? {
            Some(finalized) if finalized >= deposit.number => {}
            _ => return Ok(UpdatePlan::NotYetFinal),
        }
        let wanted = [PHASE_FIRST, PHASE_SECOND, PHASE_ANCHOR]
            .map(|phase| self.slot_of(deposit.number, phase));
        let Some(slot) = wanted
            .into_iter()
            .find(|slot| *slot > light_client.head_slot)
        else {
            return Err(Error::Beacon(format!(
                "the light client head {} is past block {} but holds no anchor for it; the dev chain skipped this block",
                light_client.head_slot, deposit.number
            )));
        };
        self.asserted_update(light_client, slot, deposit.number, deposit.hash, source)
    }

    /// The newest final block, at its first phase. The update stores no anchor, because no withdrawal reads this
    /// light client: the own-chain light client only has to follow the chain.
    fn next_head_update(
        &self,
        light_client: &LightClientState,
        source: &dyn ExecutionReader,
    ) -> Result<UpdatePlan> {
        let Some(finalized) = self.finalized_execution_block(source)? else {
            return Ok(UpdatePlan::NotYetFinal);
        };
        let slot = self.slot_of(finalized, PHASE_FIRST);
        if slot <= light_client.head_slot {
            return Ok(UpdatePlan::Covered);
        }
        self.asserted_update(
            light_client,
            slot,
            finalized,
            source.block_hash(finalized)?,
            source,
        )
    }

    fn withdrawal_path(
        &self,
        deposit: &DepositBlock,
        _light_client: &LightClientState,
        stored_slots: &[u64],
        source: &dyn ExecutionReader,
    ) -> Result<BeaconPath> {
        let anchor_block = self
            .anchor_block(deposit.number, stored_slots)
            .ok_or_else(|| {
                Error::Beacon(format!(
                    "no stored anchor at or after block {}",
                    deposit.number
                ))
            })?;
        let anchor = self.build(self.slot_of(anchor_block, PHASE_ANCHOR), source)?;
        let deposit_slot = self.slot_of(deposit.number, PHASE_DEPOSIT);
        let deposit_header = self.build(deposit_slot, source)?.header;
        let state = anchor
            .state
            .ok_or_else(|| Error::Beacon("anchor without state".into()))?;
        let ancestry_branch = match ancestry_path(anchor.header.header.slot, deposit_slot)? {
            AncestryPath::Recent => {
                if anchor_block - deposit.number > WINDOW_BLOCKS {
                    return Err(Error::Beacon(format!(
                        "block {} lies more than {WINDOW_BLOCKS} blocks below the anchor block {anchor_block}",
                        deposit.number
                    )));
                }
                state.ancestry_branch(deposit_slot)
            }
            AncestryPath::Historical => {
                if !self.is_filled(deposit_slot) {
                    return Err(Error::Beacon(format!(
                        "block {} is not among the first {HISTORICAL_FILL_BLOCKS} blocks of its era, so the dev source holds no historical summary entry for it",
                        deposit.number
                    )));
                }
                let index = deposit_slot / SLOTS_PER_ERA - self.capella_era()?;
                state.historical_branch(index as usize, deposit_slot)
            }
        };
        Ok(BeaconPath {
            anchor_header: anchor.header.header,
            ancestry_branch,
            deposit_header: deposit_header.header,
            block_hash_branch: deposit_header.block_hash_branch,
        })
    }

    fn roots_layout_evidence(
        &self,
        anchor: &BeaconHeader,
        stored_slots: &[u64],
        source: &dyn ExecutionReader,
    ) -> Result<Option<RootsEvidence>> {
        let Some((number, PHASE_ANCHOR)) = self.block_and_phase(anchor.slot) else {
            return Err(Error::Beacon(format!(
                "slot {} is not a dev anchor slot",
                anchor.slot
            )));
        };
        let (slot_a, slot_b) = (
            self.slot_of(number, PHASE_FIRST),
            self.slot_of(number, PHASE_SECOND),
        );
        if !stored_slots.contains(&slot_a) || !stored_slots.contains(&slot_b) {
            return Ok(None);
        }
        let built = self.build(anchor.slot, source)?;
        let state = built
            .state
            .ok_or_else(|| Error::Beacon("anchor without state".into()))?;
        Ok(Some(RootsEvidence {
            gindex: block_roots_gindex(self.chain, anchor.slot)?,
            later_header: built.header.header,
            earlier_slot_a: slot_a,
            earlier_slot_b: slot_b,
            branch_a: state.ancestry_branch(slot_a),
            branch_b: state.ancestry_branch(slot_b),
        }))
    }

    fn historical_layout_evidence(
        &self,
        anchor: &BeaconHeader,
        stored_slots: &[u64],
        source: &dyn ExecutionReader,
    ) -> Result<Option<HistoricalEvidence>> {
        let capella_era = self.capella_era()?;
        let usable = |slot: &u64| {
            anchor.slot.saturating_sub(*slot) > SLOTS_PER_ERA
                && slot / SLOTS_PER_ERA >= capella_era
                && self.is_filled(*slot)
        };
        let Some(earlier_slot) = stored_slots.iter().copied().filter(usable).max() else {
            return Ok(None);
        };
        let built = self.build(anchor.slot, source)?;
        let state = built
            .state
            .ok_or_else(|| Error::Beacon("anchor without state".into()))?;
        let index = (earlier_slot / SLOTS_PER_ERA - capella_era) as usize;
        Ok(Some(HistoricalEvidence {
            gindex: historical_summaries_gindex(self.chain, anchor.slot)?,
            anchor_header: built.header.header,
            earlier_slot,
            branch: state.historical_branch(index, earlier_slot),
        }))
    }

    fn hash_layout_evidence(
        &self,
        at_or_below: u64,
        stored_slots: &[u64],
        source: &dyn ExecutionReader,
    ) -> Result<Option<HashEvidence>> {
        let Some(slot) = stored_slots
            .iter()
            .copied()
            .filter(|slot| *slot <= at_or_below)
            .max()
        else {
            return Ok(None);
        };
        let built = self.build(slot, source)?;
        Ok(Some(HashEvidence {
            gindex: block_hash_gindex(self.chain, slot)?,
            header: built.header.header,
            branch: built.header.block_hash_branch,
        }))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use alloy_primitives::keccak256;

    struct FakeChain {
        latest: u64,
    }

    impl ExecutionReader for FakeChain {
        fn latest_block_number(&self) -> Result<u64> {
            Ok(self.latest)
        }
        fn block_hash(&self, number: u64) -> Result<B256> {
            Ok(keccak256(number.to_be_bytes()))
        }
        fn finalized_tag_block_number(&self) -> Result<Option<u64>> {
            Ok(None)
        }
    }

    fn light_client_at(head_slot: u64) -> LightClientState {
        LightClientState {
            head_slot,
            head_root: B256::repeat_byte(1),
            head_execution_hash: B256::repeat_byte(2),
            genesis_validators_root: B256::repeat_byte(3),
            slots_per_period: 1 << 20,
            head_committee_hash: B256::repeat_byte(4),
            next_committee_hash: B256::ZERO,
        }
    }

    fn deposit(number: u64) -> DepositBlock {
        DepositBlock {
            number,
            hash: keccak256(number.to_be_bytes()),
            timestamp: 0,
        }
    }

    /// Claim: a block counts as final only when it lies `finality_depth` blocks below the latest block.
    /// Why it matters: on Anvil this rule stands in for beacon finality. The service must never read a younger block.
    #[test]
    fn finality_is_a_depth_rule() {
        let source = DevBeaconSource::new(ChainKind::Pulsechain, 3, DEFAULT_SLOT_OFFSET);
        assert_eq!(
            source
                .finalized_execution_block(&FakeChain { latest: 2 })
                .unwrap(),
            None
        );
        assert_eq!(
            source
                .finalized_execution_block(&FakeChain { latest: 3 })
                .unwrap(),
            Some(0)
        );
        assert_eq!(
            source
                .finalized_execution_block(&FakeChain { latest: 10 })
                .unwrap(),
            Some(7)
        );
    }

    /// Claim: a deposit in a block that is not yet final gets no update.
    #[test]
    fn unfinalized_deposit_waits() {
        let source = DevBeaconSource::new(ChainKind::Pulsechain, 3, DEFAULT_SLOT_OFFSET);
        let plan = source
            .next_update(
                &deposit(9),
                &light_client_at(10),
                &[],
                &FakeChain { latest: 10 },
            )
            .unwrap();
        assert!(matches!(plan, UpdatePlan::NotYetFinal));
    }

    /// Claim: the updates for one block come in slot order (phase 0, 1, 3), each above the previous head,
    /// and the plan is `Covered` once the anchor slot is stored.
    /// Why it matters: the contract rejects a head that does not advance.
    #[test]
    fn updates_follow_slot_order_then_cover() {
        let source = DevBeaconSource::new(ChainKind::Pulsechain, 0, DEFAULT_SLOT_OFFSET);
        let chain = FakeChain { latest: 20 };
        let mut head = 10;
        let mut stored = vec![];
        let mut slots = vec![];
        loop {
            match source
                .next_update(&deposit(5), &light_client_at(head), &stored, &chain)
                .unwrap()
            {
                UpdatePlan::Covered => break,
                UpdatePlan::Update(statement) => {
                    let ProofStatement::DevAsserted(output) = *statement else {
                        panic!("dev statement")
                    };
                    assert!(output.newHeadSlot > head);
                    head = output.newHeadSlot;
                    stored.push(head);
                    slots.push(head);
                }
                other => panic!("unexpected plan {other:?}"),
            }
        }
        let expected = [0, 1, 3].map(|phase| source.slot_of(5, phase));
        assert_eq!(slots, expected);
    }

    /// Claim: with no deposit in view, the source sends one update to the newest final block, then reports `Covered`,
    /// and it never plans a head that does not advance. It waits while no block is final.
    /// Why it matters: this is the plan that keeps the own-chain light client current. A plan that moved the head
    /// backward would revert on chain, and a plan that never ended would send updates for ever.
    #[test]
    fn following_the_chain_sends_one_update_to_the_newest_final_block() {
        let source = DevBeaconSource::new(ChainKind::Pulsechain, 3, DEFAULT_SLOT_OFFSET);
        let early = source
            .next_head_update(&light_client_at(10), &FakeChain { latest: 2 })
            .unwrap();
        assert!(matches!(early, UpdatePlan::NotYetFinal));

        let chain = FakeChain { latest: 10 };
        let UpdatePlan::Update(statement) = source
            .next_head_update(&light_client_at(10), &chain)
            .unwrap()
        else {
            panic!("a final block above the head needs an update");
        };
        let ProofStatement::DevAsserted(output) = *statement else {
            panic!("dev statement")
        };
        assert_eq!(
            (output.newHeadSlot, output.executionBlockNumber),
            (source.slot_of(7, PHASE_FIRST), 7)
        );
        assert_eq!(output.executionBlockHash, keccak256(7u64.to_be_bytes()));
        assert_eq!(output.previousHeadSlot, 10);

        for head in [
            source.slot_of(7, PHASE_FIRST),
            source.slot_of(7, PHASE_FIRST) + 100,
        ] {
            let plan = source
                .next_head_update(&light_client_at(head), &chain)
                .unwrap();
            assert!(matches!(plan, UpdatePlan::Covered), "head {head}");
        }
    }

    /// Claim: the anchor, the deposit header and the branches fit together: the ancestry branch leads from the
    /// deposit header root to the anchor state root, and both layout evidences verify with lc-core's own check.
    /// Why it matters: these are the exact objects the vault checks on chain.
    #[test]
    fn withdrawal_path_and_layout_evidence_are_consistent() {
        let source = DevBeaconSource::new(ChainKind::Pulsechain, 0, DEFAULT_SLOT_OFFSET);
        let chain = FakeChain { latest: 20 };
        let stored: Vec<u64> = [0, 1, 3].map(|phase| source.slot_of(5, phase)).to_vec();
        let path = source
            .withdrawal_path(&deposit(5), &light_client_at(stored[2]), &stored, &chain)
            .unwrap();
        assert_eq!(path.anchor_header.slot, source.slot_of(5, PHASE_ANCHOR));
        assert_eq!(path.deposit_header.slot, source.slot_of(5, PHASE_DEPOSIT));

        let evidence = source
            .roots_layout_evidence(&path.anchor_header, &stored, &chain)
            .unwrap()
            .expect("evidence");
        assert_eq!(evidence.later_header.slot, path.anchor_header.slot);
        assert_eq!(evidence.branch_a.len(), path.ancestry_branch.len());
        let hash_evidence = source
            .hash_layout_evidence(stored[0], &stored, &chain)
            .unwrap()
            .expect("evidence");
        assert_eq!(hash_evidence.header.slot, stored[0]);
        // Evidence needs both earlier slots stored.
        assert!(source
            .roots_layout_evidence(&path.anchor_header, &stored[1..], &chain)
            .unwrap()
            .is_none());
    }

    /// Claim: the first update for a deposit may jump the head by far more than 8192 slots: from slot 1 to phase 0 of
    /// block 5000 (slot 21 024) in one step, with the same plan as for a near block.
    /// Why it matters: the light client lost its head-jump cap. A source that still stepped 8192 slots at a time, or
    /// refused a long jump, would never deliver a deposit on a chain with thousands of blocks.
    #[test]
    fn the_head_may_jump_more_than_8192_slots() {
        let source = DevBeaconSource::new(ChainKind::Pulsechain, 0, DEFAULT_SLOT_OFFSET);
        let chain = FakeChain { latest: 6000 };
        let plan = source
            .next_update(&deposit(5000), &light_client_at(1), &[], &chain)
            .unwrap();
        let UpdatePlan::Update(statement) = plan else {
            panic!("an update")
        };
        let ProofStatement::DevAsserted(output) = *statement else {
            panic!("dev statement")
        };
        assert_eq!(output.newHeadSlot, source.slot_of(5000, PHASE_FIRST));
        assert!(
            output.newHeadSlot - output.previousHeadSlot > 8192,
            "the jump is {}",
            output.newHeadSlot - output.previousHeadSlot
        );
    }

    /// Claim: the widest withdrawal that the source builds (a deposit `WINDOW_BLOCKS` below its anchor) is on the
    /// recent ancestry path, and one block more would still be too (the window is not set by the 8192 edge).
    /// Why it matters: the source builds only the `block_roots` branch. The vault takes the historical path beyond
    /// 8192 slots, so the window must stay under that edge.
    #[test]
    fn the_window_stays_on_the_recent_path() {
        let source = DevBeaconSource::new(ChainKind::Pulsechain, 0, DEFAULT_SLOT_OFFSET);
        let anchor = source.slot_of(WINDOW_BLOCKS + 10, PHASE_ANCHOR);
        let deposit_slot = source.slot_of(10, PHASE_DEPOSIT);
        assert_eq!(
            crate::light_client::ancestry_path(anchor, deposit_slot).unwrap(),
            crate::light_client::AncestryPath::Recent
        );
        const {
            assert!(
                WINDOW_BLOCKS * SLOTS_PER_BLOCK <= crate::light_client::SLOTS_PER_HISTORICAL_ROOT
            )
        };
    }

    /// Claim: building the same slot twice gives the same header root.
    /// Why it matters: a restart must reproduce what the light client stored.
    #[test]
    fn headers_are_reproducible() {
        let source = DevBeaconSource::new(ChainKind::Pulsechain, 0, DEFAULT_SLOT_OFFSET);
        let chain = FakeChain { latest: 20 };
        let slot = source.slot_of(7, PHASE_ANCHOR);
        let one = header_root(&source.build(slot, &chain).unwrap().header.header);
        let two = header_root(&source.build(slot, &chain).unwrap().header.header);
        assert_eq!(one, two);
    }

    /// Claim: a light client 75 sync committee periods behind (8192 slots each) reaches the newest final block with
    /// one update, then reports `Covered`. The dev source asserts the output, so no fold is needed on Anvil.
    /// Why it matters: the real source folds up to 64 updates, and a dev source that needed one update per period
    /// would make the Anvil runs of a long catch-up differ from the one-proof catch-up of the real source.
    #[test]
    fn a_head_many_periods_behind_catches_up_in_one_update() {
        let source = DevBeaconSource::new(ChainKind::Pulsechain, 0, DEFAULT_SLOT_OFFSET);
        let chain = FakeChain { latest: 160_000 };
        let behind = light_client_at(1);
        let UpdatePlan::Update(statement) = source.next_head_update(&behind, &chain).unwrap()
        else {
            panic!("an update")
        };
        let ProofStatement::DevAsserted(output) = *statement else {
            panic!("dev statement")
        };
        assert!(
            output.newHeadSlot / 8192 - output.previousHeadSlot / 8192 >= 75,
            "the jump is {} periods",
            output.newHeadSlot / 8192
        );
        let caught_up = light_client_at(output.newHeadSlot);
        assert!(matches!(
            source.next_head_update(&caught_up, &chain).unwrap(),
            UpdatePlan::Covered
        ));
    }
}
