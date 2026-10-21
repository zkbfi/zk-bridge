//! Beacon chain containers and their SSZ hash tree roots.
//!
//! Field lists come from `ethereum/consensus-specs` (master, fetched 2026-10-20):
//! - `BeaconBlockHeader`: `specs/phase0/beacon-chain.md`, section "BeaconBlockHeader".
//! - `SyncCommittee`: `specs/altair/beacon-chain.md`, section "SyncCommittee".
//! - `ExecutionPayloadHeader` (Capella): `specs/capella/beacon-chain.md`, section "ExecutionPayloadHeader".
//! - `ExecutionPayloadHeader` (Deneb): `specs/deneb/beacon-chain.md`, section "ExecutionPayloadHeader".
//!   Electra and Fulu keep the Deneb header (execution requests live in the body, not in the header).
//! - `ForkData` and `SigningData`: `specs/phase0/beacon-chain.md`, section "Misc dependencies".

use crate::chain::{ChainSpec, DOMAIN_SYNC_COMMITTEE, SYNC_COMMITTEE_SIZE};
use crate::error::{Error, Result};
use crate::layout::{execution_header_form_for_fork, ExecutionHeaderForm};
use crate::ssz::{byte_list_root, byte_vector_root, hash_pair, merkleize, u64_chunk};
use alloy_primitives::{Address, FixedBytes, B256, U256};

/// A compressed BLS12-381 public key (48 bytes).
pub type BlsPublicKey = FixedBytes<48>;

/// Maximum length of `extra_data` in an execution payload header: `MAX_EXTRA_DATA_BYTES`.
pub const MAX_EXTRA_DATA_BYTES: u64 = 32;

/// A beacon block header.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Default)]
pub struct BeaconBlockHeader {
    /// Slot of the block.
    pub slot: u64,
    /// Index of the proposer.
    pub proposer_index: u64,
    /// Root of the parent header.
    pub parent_root: B256,
    /// Root of the post-state.
    pub state_root: B256,
    /// Root of the block body.
    pub body_root: B256,
}

impl BeaconBlockHeader {
    /// The SSZ hash tree root. It is the beacon block root.
    pub fn hash_tree_root(&self) -> B256 {
        merkleize(&[
            u64_chunk(self.slot),
            u64_chunk(self.proposer_index),
            self.parent_root,
            self.state_root,
            self.body_root,
        ])
    }
}

/// A sync committee: 512 public keys and their aggregate.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct SyncCommittee {
    /// Compressed BLS public keys.
    pub pubkeys: Vec<BlsPublicKey>,
    /// Compressed aggregate public key.
    pub aggregate_pubkey: BlsPublicKey,
}

impl SyncCommittee {
    /// The SSZ hash tree root.
    ///
    /// # Errors
    /// `InvalidSyncCommitteeSize` unless there are exactly 512 keys.
    pub fn hash_tree_root(&self) -> Result<B256> {
        if self.pubkeys.len() != SYNC_COMMITTEE_SIZE {
            return Err(Error::InvalidSyncCommitteeSize { actual: self.pubkeys.len() });
        }
        let key_roots: Vec<B256> = self.pubkeys.iter().map(|key| byte_vector_root(key.as_slice())).collect();
        Ok(hash_pair(&merkleize(&key_roots), &byte_vector_root(self.aggregate_pubkey.as_slice())))
    }
}

/// The two blob gas fields that Deneb adds to the execution payload header.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Default)]
pub struct BlobGasFields {
    /// `blob_gas_used`.
    pub blob_gas_used: u64,
    /// `excess_blob_gas`.
    pub excess_blob_gas: u64,
}

/// An execution payload header as the beacon chain stores it.
#[derive(Clone, Debug, PartialEq, Eq, Default)]
pub struct ExecutionPayloadHeader {
    /// Hash of the parent execution block.
    pub parent_hash: B256,
    /// Fee recipient.
    pub fee_recipient: Address,
    /// Execution state root.
    pub state_root: B256,
    /// Execution receipts root.
    pub receipts_root: B256,
    /// 256-byte logs bloom.
    pub logs_bloom: Vec<u8>,
    /// RANDAO mix.
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
    /// Hash of the execution block. This is the value the bridge cares about.
    pub block_hash: B256,
    /// SSZ root of the transaction list.
    pub transactions_root: B256,
    /// SSZ root of the withdrawal list.
    pub withdrawals_root: B256,
    /// Present from Deneb on, absent before.
    pub blob_gas: Option<BlobGasFields>,
}

impl ExecutionPayloadHeader {
    /// The SSZ hash tree root for the given header form.
    ///
    /// # Errors
    /// `ExecutionHeaderForkMismatch` is not raised here: use [`Self::hash_tree_root_for_slot`] for the fork check.
    /// This function returns `HeaderDecode` when the sizes of `logs_bloom` or `extra_data` are wrong.
    pub fn hash_tree_root(&self, form: ExecutionHeaderForm) -> Result<B256> {
        Ok(merkleize(&self.field_roots(form)?))
    }

    /// The SSZ field roots (the leaves of the container tree) for the given header form.
    ///
    /// The `ExecutionPayload` of the block body has the same leaves, because the header replaces the two lists by
    /// their roots. Branches inside the payload (for example to `block_hash`, field 12) are built from these leaves.
    ///
    /// # Errors
    /// `HeaderDecode` when a size or the blob fields are wrong for the form.
    pub fn field_roots(&self, form: ExecutionHeaderForm) -> Result<Vec<B256>> {
        if self.logs_bloom.len() != 256 {
            return Err(Error::HeaderDecode("logs_bloom must have 256 bytes".into()));
        }
        if self.extra_data.len() as u64 > MAX_EXTRA_DATA_BYTES {
            return Err(Error::HeaderDecode("extra_data longer than 32 bytes".into()));
        }
        let mut fields = vec![
            self.parent_hash,
            B256::right_padding_from(self.fee_recipient.as_slice()),
            self.state_root,
            self.receipts_root,
            byte_vector_root(&self.logs_bloom),
            self.prev_randao,
            u64_chunk(self.block_number),
            u64_chunk(self.gas_limit),
            u64_chunk(self.gas_used),
            u64_chunk(self.timestamp),
            byte_list_root(&self.extra_data, MAX_EXTRA_DATA_BYTES),
            B256::from(self.base_fee_per_gas.to_le_bytes::<32>()),
            self.block_hash,
            self.transactions_root,
            self.withdrawals_root,
        ];
        match (form, self.blob_gas) {
            (ExecutionHeaderForm::Capella, None) => {}
            (ExecutionHeaderForm::Deneb, Some(blob)) => {
                fields.push(u64_chunk(blob.blob_gas_used));
                fields.push(u64_chunk(blob.excess_blob_gas));
            }
            _ => return Err(Error::HeaderDecode("blob gas fields do not match the header form".into())),
        }
        Ok(fields)
    }

    /// The hash tree root, with the header form chosen by the fork at `beacon_slot`.
    ///
    /// # Errors
    /// `UnsupportedFork` before Capella, `HeaderDecode` when the blob gas fields do not match the fork.
    pub fn hash_tree_root_for_slot(&self, spec: &ChainSpec, beacon_slot: u64) -> Result<B256> {
        let form = execution_header_form_for_fork(spec.fork_at_slot(beacon_slot))?;
        self.hash_tree_root(form)
    }
}

/// A light-client header: the beacon header plus the execution payload header and its branch.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct LightClientHeader {
    /// The beacon block header.
    pub beacon: BeaconBlockHeader,
    /// The execution payload header from the block body.
    pub execution: ExecutionPayloadHeader,
    /// Branch from the execution payload root to `beacon.body_root`.
    pub execution_branch: Vec<B256>,
}

/// The aggregate of one block: who signed and the signature.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct SyncAggregate {
    /// Participation bit vector. Bit `i` is bit `i % 8` of byte `i / 8`, least significant bit first.
    pub sync_committee_bits: [u8; SYNC_COMMITTEE_SIZE / 8],
    /// Compressed BLS aggregate signature.
    pub sync_committee_signature: [u8; 96],
}

impl SyncAggregate {
    /// Number of set participation bits.
    pub fn participant_count(&self) -> usize {
        self.sync_committee_bits.iter().map(|byte| byte.count_ones() as usize).sum()
    }

    /// Whether committee member `index` signed.
    pub fn is_set(&self, index: usize) -> bool {
        self.sync_committee_bits[index / 8] >> (index % 8) & 1 == 1
    }
}

/// A proven next sync committee.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct NextSyncCommittee {
    /// The committee for the period after the attested period.
    pub committee: SyncCommittee,
    /// Branch from the committee root to the attested state root.
    pub branch: Vec<B256>,
}

/// A light-client update. It always carries a finalized header: the bridge accepts no other kind.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct LightClientUpdate {
    /// The header the committee signed.
    pub attested_header: LightClientHeader,
    /// The next sync committee, when the update proves it.
    pub next_sync_committee: Option<NextSyncCommittee>,
    /// The finalized header named by the attested state.
    pub finalized_header: LightClientHeader,
    /// Branch from the finalized header root to the attested state root.
    pub finality_branch: Vec<B256>,
    /// The committee signature over the attested header.
    pub sync_aggregate: SyncAggregate,
    /// The slot of the block that carries the aggregate.
    pub signature_slot: u64,
}

/// What the program trusts about the chain before an update.
///
/// `header_root`, `header_slot` and the hash of `current_sync_committee` are the values the Solidity contract
/// compares with its storage. `next_sync_committee` is private input: see the report on how the contract must bind it.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct LightClientStore {
    /// Root of the last finalized beacon header.
    pub header_root: B256,
    /// Slot of the last finalized beacon header.
    pub header_slot: u64,
    /// The sync committee of the period of `header_slot`.
    pub current_sync_committee: SyncCommittee,
    /// The committee of the following period, when known.
    pub next_sync_committee: Option<SyncCommittee>,
}

/// `compute_fork_data_root` then `compute_domain` of the consensus specs.
///
/// Source: `specs/phase0/beacon-chain.md`, section "Misc dependencies".
pub fn compute_domain(domain_type: [u8; 4], fork_version: [u8; 4], genesis_validators_root: &B256) -> B256 {
    let mut version_chunk = [0u8; 32];
    version_chunk[..4].copy_from_slice(&fork_version);
    let fork_data_root = hash_pair(&B256::from(version_chunk), genesis_validators_root);
    let mut domain = [0u8; 32];
    domain[..4].copy_from_slice(&domain_type);
    domain[4..].copy_from_slice(&fork_data_root[..28]);
    B256::from(domain)
}

/// `compute_signing_root`: the hash tree root of `SigningData { object_root, domain }`.
pub fn compute_signing_root(object_root: &B256, domain: &B256) -> B256 {
    hash_pair(object_root, domain)
}

/// The sync committee domain for a signature in `signature_slot`.
///
/// The fork version is the one active at `max(signature_slot, 1) - 1`, as in `validate_light_client_update`.
pub fn sync_committee_domain(spec: &ChainSpec, signature_slot: u64) -> B256 {
    let fork_version_slot = signature_slot.saturating_sub(1);
    let fork_version = spec.fork_version_at(spec.epoch_at_slot(fork_version_slot));
    compute_domain(DOMAIN_SYNC_COMMITTEE, fork_version, &spec.genesis_validators_root)
}

#[cfg(test)]
mod tests {
    use super::*;
    use alloy_primitives::b256;

    /// Claim: the header root of an all-zero header equals the published value for five zero fields.
    /// Independent check: merkleize 8 leaves with 5 zero chunks and 3 zero pads equals `zero_hash(3)`.
    #[test]
    fn zero_header_root_is_the_depth_three_zero_hash() {
        assert_eq!(BeaconBlockHeader::default().hash_tree_root(), crate::ssz::zero_hash(3));
    }

    /// Claim: the participation bit order is least significant bit first, so bit 0 is `0x01` of byte 0.
    /// This matters because a reversed order would select the wrong public keys.
    #[test]
    fn participation_bits_are_least_significant_first() {
        let mut aggregate = SyncAggregate { sync_committee_bits: [0; 64], sync_committee_signature: [0; 96] };
        aggregate.sync_committee_bits[0] = 0b0000_0001;
        aggregate.sync_committee_bits[1] = 0b1000_0000;
        assert!(aggregate.is_set(0));
        assert!(!aggregate.is_set(1));
        assert!(aggregate.is_set(15));
        assert_eq!(aggregate.participant_count(), 2);
    }

    /// Claim: a domain starts with the domain type and then holds the first 28 bytes of the fork data root.
    /// The two chains must give different domains, which is what stops cross-chain replay.
    #[test]
    fn domains_differ_between_chains() {
        let ethereum = sync_committee_domain(&crate::chain::ETHEREUM_MAINNET, 15_476_529);
        let pulsechain = sync_committee_domain(&crate::chain::PULSECHAIN, 10_875_663);
        assert_eq!(&ethereum[..4], &[7, 0, 0, 0]);
        assert_eq!(&pulsechain[..4], &[7, 0, 0, 0]);
        assert_ne!(ethereum, pulsechain);
    }

    /// Claim: `compute_domain` for a zero fork version and zero root has the known layout:
    /// `07000000 || sha256(zero32 || zero32)[..28]`.
    #[test]
    fn domain_layout() {
        let domain = compute_domain([7, 0, 0, 0], [0; 4], &B256::ZERO);
        let expected_tail = crate::ssz::zero_hash(1);
        assert_eq!(&domain[4..], &expected_tail[..28]);
        assert_eq!(expected_tail, b256!("f5a5fd42d16a20302798ef6ed309979b43003d2320d9f0e8ea9831a92759fb4b"));
    }
}
