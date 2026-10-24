//! Synthetic Capella `SignedBeaconBlock` bytes: a builder that writes the SSZ (Simple Serialize) serialization of a block with an execution
//! payload that a test controls.
//!
//! `lc_core::ssz_state::try_parse_signed_block` parses these bytes, so a test can run the whole block parser on a block it
//! controls. The builder takes the values that the bridge reads: the header fields, the sync aggregate and the execution
//! payload. Every other field is empty or zero (no transactions, no withdrawals, no attestations). The layout is written
//! here from the field order of the Capella `BeaconBlockBody` and `ExecutionPayload` in consensus-specs, and it shares no
//! constant with the parser.

use crate::state_bytes::{container, fixed, number, Part};
use alloy_primitives::{Address, B256, U256};
use lc_core::types::SyncAggregate;

/// The execution payload fields of a block that the bridge reads. The transaction list and the withdrawal list are empty.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct PayloadFields {
    /// Hash of the parent execution block.
    pub parent_hash: B256,
    /// Fee recipient.
    pub fee_recipient: Address,
    /// Execution state root.
    pub state_root: B256,
    /// Execution receipts root.
    pub receipts_root: B256,
    /// The 256-byte logs bloom.
    pub logs_bloom: Vec<u8>,
    /// The randomness mix of the execution block (`prev_randao`).
    pub prev_randao: B256,
    /// Execution block number.
    pub block_number: u64,
    /// Gas limit.
    pub gas_limit: u64,
    /// Gas used.
    pub gas_used: u64,
    /// Timestamp.
    pub timestamp: u64,
    /// Extra data, at most 32 bytes.
    pub extra_data: Vec<u8>,
    /// Base fee per gas.
    pub base_fee_per_gas: U256,
    /// Hash of the execution block.
    pub block_hash: B256,
}

/// The parts of a block that a test sets.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct BlockBytes {
    /// `slot`.
    pub slot: u64,
    /// `proposer_index`.
    pub proposer_index: u64,
    /// `parent_root`.
    pub parent_root: B256,
    /// `state_root`.
    pub state_root: B256,
    /// `body.sync_aggregate`.
    pub sync_aggregate: SyncAggregate,
    /// `body.execution_payload`.
    pub payload: PayloadFields,
}

/// The SSZ bytes of an execution payload with empty transaction and withdrawal lists.
fn payload_bytes(payload: &PayloadFields) -> Vec<u8> {
    container(vec![
        fixed(payload.parent_hash.to_vec()),
        fixed(payload.fee_recipient.to_vec()),
        fixed(payload.state_root.to_vec()),
        fixed(payload.receipts_root.to_vec()),
        fixed(payload.logs_bloom.clone()),
        fixed(payload.prev_randao.to_vec()),
        number(payload.block_number),
        number(payload.gas_limit),
        number(payload.gas_used),
        number(payload.timestamp),
        Part::Variable(payload.extra_data.clone()),
        fixed(payload.base_fee_per_gas.to_le_bytes::<32>().to_vec()),
        fixed(payload.block_hash.to_vec()),
        Part::Variable(Vec::new()),
        Part::Variable(Vec::new()),
    ])
}

/// The SSZ bytes of the 160-byte `SyncAggregate`: the participation bits, then the signature.
fn sync_aggregate_bytes(aggregate: &SyncAggregate) -> Vec<u8> {
    [aggregate.sync_committee_bits.as_slice(), aggregate.sync_committee_signature.as_slice()].concat()
}

impl BlockBytes {
    /// The SSZ bytes of the `SignedBeaconBlock`. The block signature is 96 zero bytes.
    pub fn to_ssz(&self) -> Vec<u8> {
        let body = container(vec![
            fixed(vec![0u8; 96]),
            fixed(vec![0u8; 72]),
            fixed(vec![0u8; 32]),
            Part::Variable(Vec::new()),
            Part::Variable(Vec::new()),
            Part::Variable(Vec::new()),
            Part::Variable(Vec::new()),
            Part::Variable(Vec::new()),
            fixed(sync_aggregate_bytes(&self.sync_aggregate)),
            Part::Variable(payload_bytes(&self.payload)),
            Part::Variable(Vec::new()),
        ]);
        let message = container(vec![
            number(self.slot),
            number(self.proposer_index),
            fixed(self.parent_root.to_vec()),
            fixed(self.state_root.to_vec()),
            Part::Variable(body),
        ]);
        container(vec![Part::Variable(message), fixed(vec![0u8; 96])])
    }
}
