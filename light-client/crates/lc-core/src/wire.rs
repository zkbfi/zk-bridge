//! A plain binary format for the input of the light-client guest program.
//!
//! The SP1 guest reads one byte vector from the prover and decodes it here. The format has no schema evolution:
//! the guest and the host must use the same version of this crate. All integers are little endian. A list is a `u32` count
//! followed by its items. Bytes are a `u32` length followed by the bytes. The decoder rejects truncated input,
//! trailing bytes and wrong fixed sizes.
//!
//! Field order follows the struct order in [`crate::types`].
//!
//! Layout of the guest input: chain selector (1 byte), the store, then a list of 1 to 64 steps. Each step is a fork
//! version (4 bytes) followed by one update. A fold applies the steps in order (`update::verify_fold_with_layout`).
//! The decoder refuses a count above 64. A count of 0 decodes, and the fold then refuses it.

use crate::chain::{ChainSpec, ETHEREUM_MAINNET, PULSECHAIN};
use crate::error::{Error, Result};
use crate::types::{
    BeaconBlockHeader, BlobGasFields, BlsPublicKey, ExecutionPayloadHeader, LightClientHeader, LightClientStore,
    LightClientUpdate, NextSyncCommittee, SyncAggregate, SyncCommittee,
};
use crate::observation::{verify_fork_observation, Observation};
use crate::update::{verify_light_client_fold_with_fork_versions, FoldStep, MAX_FOLD_UPDATES};
use alloy_primitives::{Address, B256, U256};

/// Which chain configuration the guest applies.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ChainSelector {
    /// Ethereum mainnet.
    EthereumMainnet,
    /// PulseChain.
    Pulsechain,
}

impl ChainSelector {
    /// The chain configuration.
    pub fn spec(self) -> &'static ChainSpec {
        match self {
            Self::EthereumMainnet => &ETHEREUM_MAINNET,
            Self::Pulsechain => &PULSECHAIN,
        }
    }
}

/// Everything the light-client guest reads.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct GuestInput {
    /// The chain.
    pub chain: ChainSelector,
    /// The store before the first update.
    pub store: LightClientStore,
    /// The updates to apply in order, 1 to 64. Each carries the fork version of its signing domain, which is a private
    /// input (see `verify_light_client_update_with_fork_version`).
    pub steps: Vec<FoldStep>,
}

fn wire_error(reason: &str) -> Error {
    Error::HeaderDecode(format!("wire format: {reason}"))
}

struct Writer(Vec<u8>);

impl Writer {
    fn u64(&mut self, value: u64) {
        self.0.extend_from_slice(&value.to_le_bytes());
    }
    fn u32(&mut self, value: usize) {
        self.0.extend_from_slice(&(value as u32).to_le_bytes());
    }
    fn bytes(&mut self, value: &[u8]) {
        self.u32(value.len());
        self.0.extend_from_slice(value);
    }
    fn fixed(&mut self, value: &[u8]) {
        self.0.extend_from_slice(value);
    }
    fn branch(&mut self, branch: &[B256]) {
        self.u32(branch.len());
        for node in branch {
            self.fixed(node.as_slice());
        }
    }
    fn beacon(&mut self, header: &BeaconBlockHeader) {
        self.u64(header.slot);
        self.u64(header.proposer_index);
        self.fixed(header.parent_root.as_slice());
        self.fixed(header.state_root.as_slice());
        self.fixed(header.body_root.as_slice());
    }
    fn payload(&mut self, payload: &ExecutionPayloadHeader) {
        self.fixed(payload.parent_hash.as_slice());
        self.fixed(payload.fee_recipient.as_slice());
        self.fixed(payload.state_root.as_slice());
        self.fixed(payload.receipts_root.as_slice());
        self.bytes(&payload.logs_bloom);
        self.fixed(payload.prev_randao.as_slice());
        self.u64(payload.block_number);
        self.u64(payload.gas_limit);
        self.u64(payload.gas_used);
        self.u64(payload.timestamp);
        self.bytes(&payload.extra_data);
        self.fixed(&payload.base_fee_per_gas.to_le_bytes::<32>());
        self.fixed(payload.block_hash.as_slice());
        self.fixed(payload.transactions_root.as_slice());
        self.fixed(payload.withdrawals_root.as_slice());
        match payload.blob_gas {
            None => self.fixed(&[0]),
            Some(blob) => {
                self.fixed(&[1]);
                self.u64(blob.blob_gas_used);
                self.u64(blob.excess_blob_gas);
            }
        }
    }
    fn header(&mut self, header: &LightClientHeader) {
        self.beacon(&header.beacon);
        self.payload(&header.execution);
        self.branch(&header.execution_branch);
    }
    fn committee(&mut self, committee: &SyncCommittee) {
        self.u32(committee.pubkeys.len());
        for key in &committee.pubkeys {
            self.fixed(key.as_slice());
        }
        self.fixed(committee.aggregate_pubkey.as_slice());
    }
    fn update(&mut self, update: &LightClientUpdate) {
        self.header(&update.attested_header);
        match &update.next_sync_committee {
            None => self.fixed(&[0]),
            Some(next) => {
                self.fixed(&[1]);
                self.committee(&next.committee);
                self.branch(&next.branch);
            }
        }
        self.header(&update.finalized_header);
        self.branch(&update.finality_branch);
        self.aggregate(&update.sync_aggregate);
        self.u64(update.signature_slot);
    }
    fn aggregate(&mut self, aggregate: &SyncAggregate) {
        self.fixed(&aggregate.sync_committee_bits);
        self.fixed(&aggregate.sync_committee_signature);
    }
    fn store(&mut self, store: &LightClientStore) {
        self.fixed(store.header_root.as_slice());
        self.u64(store.header_slot);
        self.committee(&store.current_sync_committee);
        match &store.next_sync_committee {
            None => self.fixed(&[0]),
            Some(committee) => {
                self.fixed(&[1]);
                self.committee(committee);
            }
        }
    }
    fn chain(&mut self, chain: ChainSelector) {
        self.fixed(&[match chain {
            ChainSelector::EthereumMainnet => 1,
            ChainSelector::Pulsechain => 2,
        }]);
    }
    fn steps(&mut self, steps: &[FoldStep]) {
        self.u32(steps.len());
        for step in steps {
            self.fixed(&step.fork_version);
            self.update(&step.update);
        }
    }
}

/// Encodes the guest input.
pub fn encode_guest_input(input: &GuestInput) -> Vec<u8> {
    let mut writer = Writer(Vec::new());
    writer.chain(input.chain);
    writer.store(&input.store);
    writer.steps(&input.steps);
    writer.0
}

struct Reader<'a>(&'a [u8]);

impl<'a> Reader<'a> {
    fn take(&mut self, length: usize) -> Result<&'a [u8]> {
        if self.0.len() < length {
            return Err(wire_error("input ends early"));
        }
        let (head, rest) = self.0.split_at(length);
        self.0 = rest;
        Ok(head)
    }
    fn finish(&self) -> Result<()> {
        if self.0.is_empty() {
            return Ok(());
        }
        Err(wire_error("trailing bytes"))
    }
    fn u64(&mut self) -> Result<u64> {
        Ok(u64::from_le_bytes(self.take(8)?.try_into().expect("8 bytes")))
    }
    fn count(&mut self, limit: usize) -> Result<usize> {
        let count = u32::from_le_bytes(self.take(4)?.try_into().expect("4 bytes")) as usize;
        if count > limit {
            return Err(wire_error("a count is larger than its limit"));
        }
        Ok(count)
    }
    fn b256(&mut self) -> Result<B256> {
        Ok(B256::from_slice(self.take(32)?))
    }
    fn bytes(&mut self, limit: usize) -> Result<Vec<u8>> {
        let length = self.count(limit)?;
        Ok(self.take(length)?.to_vec())
    }
    fn flag(&mut self) -> Result<bool> {
        match self.take(1)?[0] {
            0 => Ok(false),
            1 => Ok(true),
            _ => Err(wire_error("a flag is neither 0 nor 1")),
        }
    }
    fn branch(&mut self) -> Result<Vec<B256>> {
        let count = self.count(64)?;
        (0..count).map(|_| self.b256()).collect()
    }
    fn beacon(&mut self) -> Result<BeaconBlockHeader> {
        Ok(BeaconBlockHeader {
            slot: self.u64()?,
            proposer_index: self.u64()?,
            parent_root: self.b256()?,
            state_root: self.b256()?,
            body_root: self.b256()?,
        })
    }
    fn payload(&mut self) -> Result<ExecutionPayloadHeader> {
        let parent_hash = self.b256()?;
        let fee_recipient = Address::from_slice(self.take(20)?);
        let state_root = self.b256()?;
        let receipts_root = self.b256()?;
        let logs_bloom = self.bytes(256)?;
        let prev_randao = self.b256()?;
        let block_number = self.u64()?;
        let gas_limit = self.u64()?;
        let gas_used = self.u64()?;
        let timestamp = self.u64()?;
        let extra_data = self.bytes(32)?;
        let base_fee_per_gas = U256::from_le_slice(self.take(32)?);
        let block_hash = self.b256()?;
        let transactions_root = self.b256()?;
        let withdrawals_root = self.b256()?;
        let blob_gas = if self.flag()? {
            Some(BlobGasFields { blob_gas_used: self.u64()?, excess_blob_gas: self.u64()? })
        } else {
            None
        };
        Ok(ExecutionPayloadHeader {
            parent_hash,
            fee_recipient,
            state_root,
            receipts_root,
            logs_bloom,
            prev_randao,
            block_number,
            gas_limit,
            gas_used,
            timestamp,
            extra_data,
            base_fee_per_gas,
            block_hash,
            transactions_root,
            withdrawals_root,
            blob_gas,
        })
    }
    fn header(&mut self) -> Result<LightClientHeader> {
        Ok(LightClientHeader { beacon: self.beacon()?, execution: self.payload()?, execution_branch: self.branch()? })
    }
    fn update(&mut self) -> Result<LightClientUpdate> {
        let attested_header = self.header()?;
        let next_sync_committee = if self.flag()? {
            Some(NextSyncCommittee { committee: self.committee()?, branch: self.branch()? })
        } else {
            None
        };
        let finalized_header = self.header()?;
        let finality_branch = self.branch()?;
        let sync_aggregate = self.aggregate()?;
        let signature_slot = self.u64()?;
        Ok(LightClientUpdate {
            attested_header,
            next_sync_committee,
            finalized_header,
            finality_branch,
            sync_aggregate,
            signature_slot,
        })
    }
    fn aggregate(&mut self) -> Result<SyncAggregate> {
        let sync_committee_bits: [u8; 64] = self.take(64)?.try_into().expect("64 bytes");
        let sync_committee_signature: [u8; 96] = self.take(96)?.try_into().expect("96 bytes");
        Ok(SyncAggregate { sync_committee_bits, sync_committee_signature })
    }
    fn chain(&mut self) -> Result<ChainSelector> {
        match self.take(1)?[0] {
            1 => Ok(ChainSelector::EthereumMainnet),
            2 => Ok(ChainSelector::Pulsechain),
            _ => Err(wire_error("unknown chain selector")),
        }
    }
    fn store(&mut self) -> Result<LightClientStore> {
        let header_root = self.b256()?;
        let header_slot = self.u64()?;
        let current_sync_committee = self.committee()?;
        let next_sync_committee = if self.flag()? { Some(self.committee()?) } else { None };
        Ok(LightClientStore { header_root, header_slot, current_sync_committee, next_sync_committee })
    }
    fn steps(&mut self) -> Result<Vec<FoldStep>> {
        let count = self.count(MAX_FOLD_UPDATES)?;
        (0..count)
            .map(|_| {
                let fork_version: [u8; 4] = self.take(4)?.try_into().expect("4 bytes");
                Ok(FoldStep { update: self.update()?, fork_version })
            })
            .collect()
    }
    fn committee(&mut self) -> Result<SyncCommittee> {
        let count = self.count(512)?;
        let pubkeys = (0..count).map(|_| self.take(48).map(BlsPublicKey::from_slice)).collect::<Result<Vec<_>>>()?;
        Ok(SyncCommittee { pubkeys, aggregate_pubkey: BlsPublicKey::from_slice(self.take(48)?) })
    }
}

/// Decodes the guest input.
///
/// # Errors
/// `HeaderDecode` with a wire-format reason for truncated, oversized or trailing input.
pub fn decode_guest_input(bytes: &[u8]) -> Result<GuestInput> {
    let mut reader = Reader(bytes);
    let chain = reader.chain()?;
    let store = reader.store()?;
    let steps = reader.steps()?;
    reader.finish()?;
    Ok(GuestInput { chain, store, steps })
}

/// The whole guest program in one function: decode the input, apply the fold of 1 to 64 updates, return the
/// ABI-encoded public values (11 words, 352 bytes).
/// The SP1 wrapper in `light-client/guests/light-client` calls exactly this.
///
/// # Errors
/// Any decode or verification error. The guest panics on error, so no proof exists.
pub fn run_light_client_guest(input_bytes: &[u8]) -> Result<Vec<u8>> {
    use alloy_sol_types::SolValue;
    let input = decode_guest_input(input_bytes)?;
    let output = verify_light_client_fold_with_fork_versions(&input.store, &input.steps, input.chain.spec())?;
    Ok(output.abi_encode())
}

/// Everything the fork-observation guest reads.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ObservationGuestInput {
    /// The chain.
    pub chain: ChainSelector,
    /// The store before the first step.
    pub store: LightClientStore,
    /// Zero to 64 fold steps, each with the fork version of its signing domain.
    pub steps: Vec<FoldStep>,
    /// The observation.
    pub observation: Observation,
}

/// Encodes the fork-observation guest input: chain selector, store, a list of 0 to 64 steps (the same encoding as
/// the light-client guest), then the observation: attested beacon header (112 bytes: slot, proposer index, parent, state and body roots), signature slot (`u64`),
/// participation bits (64 bytes), signature (96 bytes), fork version (4 bytes).
pub fn encode_observation_input(input: &ObservationGuestInput) -> Vec<u8> {
    let mut writer = Writer(Vec::new());
    writer.chain(input.chain);
    writer.store(&input.store);
    writer.steps(&input.steps);
    writer.beacon(&input.observation.attested_header);
    writer.u64(input.observation.signature_slot);
    writer.aggregate(&input.observation.sync_aggregate);
    writer.fixed(&input.observation.fork_version);
    writer.0
}

/// Decodes the fork-observation guest input.
///
/// # Errors
/// `HeaderDecode` with a wire-format reason for truncated, oversized (more than 64 steps) or trailing input.
pub fn decode_observation_input(bytes: &[u8]) -> Result<ObservationGuestInput> {
    let mut reader = Reader(bytes);
    let chain = reader.chain()?;
    let store = reader.store()?;
    let steps = reader.steps()?;
    let attested_header = reader.beacon()?;
    let signature_slot = reader.u64()?;
    let sync_aggregate = reader.aggregate()?;
    let fork_version: [u8; 4] = reader.take(4)?.try_into().expect("4 bytes");
    reader.finish()?;
    let observation = Observation { attested_header, signature_slot, sync_aggregate, fork_version };
    Ok(ObservationGuestInput { chain, store, steps, observation })
}

/// The whole fork-observation guest program in one function: decode the input, verify the fold and the observation,
/// return the ABI-encoded public values (`ForkObservation`: 7 words, 224 bytes).
/// The SP1 wrapper in `light-client/guests/fork-observation` calls exactly this.
///
/// # Errors
/// Any decode or verification error. The guest panics on error, so no proof exists.
pub fn run_fork_observation_guest(input_bytes: &[u8]) -> Result<Vec<u8>> {
    use alloy_sol_types::SolValue;
    let input = decode_observation_input(input_bytes)?;
    let output = verify_fork_observation(&input.store, &input.steps, &input.observation, input.chain.spec())?;
    Ok(output.abi_encode())
}
