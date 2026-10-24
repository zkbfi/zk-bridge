//! Synthetic `BeaconState` bytes: a builder that writes the SSZ serialization of a Capella, Deneb, Electra or Fulu state.
//!
//! `lc_core::ssz_state` parses these bytes, so a test can run the whole parser and hasher on a state it controls.
//! The builder takes the values the light client reads (committees, slot, fork, finalized checkpoint, block roots,
//! historical summaries, the Electra counters and queues, the Fulu lookahead). Every other field is empty or zero. The layout is written
//! here from the field order of each fork's `BeaconState` in consensus-specs, and it shares no constant with the
//! parser, so a mistake in the parser's field list shows as a parse failure and not as a copied error.

use alloy_primitives::B256;
use lc_core::chain::ForkName;
use lc_core::ssz::sha256;
use lc_core::ssz_state::ForkData;
use lc_core::types::SyncCommittee;

/// The parts of a state that a test sets. Everything else is zero or empty.
pub struct StateBytes {
    /// The fork of the layout: Capella, Deneb, Electra or Fulu.
    pub fork: ForkName,
    /// `slot`.
    pub slot: u64,
    /// `fork`.
    pub fork_data: ForkData,
    /// `current_sync_committee`.
    pub current_committee: SyncCommittee,
    /// `next_sync_committee`.
    pub next_committee: SyncCommittee,
    /// `finalized_checkpoint` as epoch and root.
    pub finalized_checkpoint: (u64, B256),
    /// `block_roots`: 8192 roots.
    pub block_roots: Vec<B256>,
    /// `historical_summaries` as `(block_summary_root, state_summary_root)`.
    pub historical_summaries: Vec<(B256, B256)>,
    /// Electra only: `deposit_requests_start_index`, `deposit_balance_to_consume`, `exit_balance_to_consume`,
    /// `earliest_exit_epoch`, `consolidation_balance_to_consume`, `earliest_consolidation_epoch`.
    pub electra_counters: [u64; 6],
    /// Electra only: the SSZ bytes of each `PendingDeposit`.
    pub pending_deposits: Vec<[u8; 192]>,
    /// Electra only: the SSZ bytes of each `PendingPartialWithdrawal`.
    pub pending_partial_withdrawals: Vec<[u8; 24]>,
    /// Electra only: the SSZ bytes of each `PendingConsolidation`.
    pub pending_consolidations: Vec<[u8; 16]>,
    /// Fulu only: `proposer_lookahead`, 64 validator indices.
    pub proposer_lookahead: [u64; 64],
}

/// One field of an SSZ container: fixed bytes in place, or variable bytes behind a 4-byte offset.
pub enum Part {
    /// A field of fixed size. Its bytes sit in the fixed part of the container.
    Fixed(Vec<u8>),
    /// A field of variable size. Its bytes follow the fixed part, and a 4-byte offset points at them.
    Variable(Vec<u8>),
}

/// The SSZ serialization of a container.
pub fn container(parts: Vec<Part>) -> Vec<u8> {
    let fixed_length: usize = parts
        .iter()
        .map(|part| match part {
            Part::Fixed(bytes) => bytes.len(),
            Part::Variable(_) => 4,
        })
        .sum();
    let mut head = Vec::with_capacity(fixed_length);
    let mut tail = Vec::new();
    for part in parts {
        match part {
            Part::Fixed(bytes) => head.extend(bytes),
            Part::Variable(bytes) => {
                head.extend(((fixed_length + tail.len()) as u32).to_le_bytes());
                tail.extend(bytes);
            }
        }
    }
    head.extend(tail);
    head
}

/// A fixed-size field.
pub fn fixed(bytes: impl Into<Vec<u8>>) -> Part {
    Part::Fixed(bytes.into())
}

/// A `uint64` field.
pub fn number(value: u64) -> Part {
    fixed(value.to_le_bytes())
}

/// The 512 keys and the aggregate key of a committee, as SSZ.
fn committee_bytes(committee: &SyncCommittee) -> Vec<u8> {
    let mut bytes: Vec<u8> = committee.pubkeys.iter().flat_map(|key| key.as_slice().to_vec()).collect();
    bytes.extend_from_slice(committee.aggregate_pubkey.as_slice());
    bytes
}

/// An execution payload header with filler values: 15 fields for Capella, 17 from Deneb on.
fn payload_header_bytes(fork: ForkName) -> Vec<u8> {
    let mut parts = vec![
        fixed(sha256(b"payload/parent").to_vec()),
        fixed([0x0f; 20]),
        fixed(sha256(b"payload/state").to_vec()),
        fixed(sha256(b"payload/receipts").to_vec()),
        fixed(vec![0u8; 256]),
        fixed(sha256(b"payload/randao").to_vec()),
        number(77),
        number(30_000_000),
        number(1_000_000),
        number(1_700_000_000),
        Part::Variable(b"synthetic".to_vec()),
        fixed(U256_SEVEN),
        fixed(sha256(b"payload/block-hash").to_vec()),
        fixed(sha256(b"payload/transactions").to_vec()),
        fixed(sha256(b"payload/withdrawals").to_vec()),
    ];
    if fork >= ForkName::Deneb {
        parts.extend([number(131_072), number(262_144)]);
    }
    container(parts)
}

/// `base_fee_per_gas` of 7 as a little-endian 256-bit integer.
const U256_SEVEN: [u8; 32] = {
    let mut bytes = [0u8; 32];
    bytes[0] = 7;
    bytes
};

impl StateBytes {
    /// A state of `fork` at `slot` with the two committees. Block roots are filler, the finalized checkpoint is the
    /// zero checkpoint, and every list and counter is empty or zero.
    ///
    /// # Panics
    /// Panics for a fork other than Capella, Deneb, Electra and Fulu.
    pub fn new(fork: ForkName, slot: u64, current: SyncCommittee, next: SyncCommittee) -> Self {
        assert!(
            matches!(fork, ForkName::Capella | ForkName::Deneb | ForkName::Electra | ForkName::Fulu),
            "no synthetic state bytes for {fork:?}"
        );
        Self {
            fork,
            slot,
            fork_data: ForkData { previous_version: [0; 4], current_version: [1, 0, 0, 0], epoch: 0 },
            current_committee: current,
            next_committee: next,
            finalized_checkpoint: (0, B256::ZERO),
            block_roots: (0..8192u64)
                .map(|index| sha256(format!("state-bytes/block-root/{index}").as_bytes()))
                .collect(),
            historical_summaries: Vec::new(),
            electra_counters: [0; 6],
            pending_deposits: Vec::new(),
            pending_partial_withdrawals: Vec::new(),
            pending_consolidations: Vec::new(),
            proposer_lookahead: [0; 64],
        }
    }

    /// The SSZ bytes of the state.
    ///
    /// # Panics
    /// Panics when `block_roots` does not hold 8192 roots.
    pub fn to_ssz(&self) -> Vec<u8> {
        assert_eq!(self.block_roots.len(), 8192, "block_roots is a vector of 8192 roots");
        let mut fork_bytes = Vec::with_capacity(16);
        fork_bytes.extend(self.fork_data.previous_version);
        fork_bytes.extend(self.fork_data.current_version);
        fork_bytes.extend(self.fork_data.epoch.to_le_bytes());
        let mut finalized = self.finalized_checkpoint.0.to_le_bytes().to_vec();
        finalized.extend_from_slice(self.finalized_checkpoint.1.as_slice());
        let summaries: Vec<u8> = self
            .historical_summaries
            .iter()
            .flat_map(|(blocks, states)| [blocks.as_slice(), states.as_slice()].concat())
            .collect();
        let mut parts = vec![
            number(0),
            fixed(sha256(b"state-bytes/genesis-validators-root").to_vec()),
            number(self.slot),
            fixed(fork_bytes),
            fixed(vec![0u8; 112]),
            fixed(self.block_roots.iter().flat_map(|root| root.as_slice().to_vec()).collect::<Vec<u8>>()),
            fixed(vec![0u8; 8192 * 32]),
            Part::Variable(Vec::new()),
            fixed(vec![0u8; 72]),
            Part::Variable(Vec::new()),
            number(0),
            Part::Variable(Vec::new()),
            Part::Variable(Vec::new()),
            fixed(vec![0u8; 65536 * 32]),
            fixed(vec![0u8; 8192 * 8]),
            Part::Variable(Vec::new()),
            Part::Variable(Vec::new()),
            fixed([0u8]),
            fixed(vec![0u8; 40]),
            fixed(vec![0u8; 40]),
            fixed(finalized),
            Part::Variable(Vec::new()),
            fixed(committee_bytes(&self.current_committee)),
            fixed(committee_bytes(&self.next_committee)),
            Part::Variable(payload_header_bytes(self.fork)),
            number(0),
            number(0),
            Part::Variable(summaries),
        ];
        if self.fork >= ForkName::Electra {
            parts.extend(self.electra_counters.map(number));
            parts.push(Part::Variable(self.pending_deposits.concat()));
            parts.push(Part::Variable(self.pending_partial_withdrawals.concat()));
            parts.push(Part::Variable(self.pending_consolidations.concat()));
        }
        if self.fork == ForkName::Fulu {
            parts
                .push(fixed(self.proposer_lookahead.iter().flat_map(|index| index.to_le_bytes()).collect::<Vec<u8>>()));
        }
        container(parts)
    }
}
