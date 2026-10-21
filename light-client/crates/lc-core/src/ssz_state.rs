//! Parser and hasher for real Capella-layout SSZ data: `BeaconState` and `SignedBeaconBlock`.
//!
//! The prover service uses it to compute REAL Merkle branches from a beacon state and a block
//! body that a PulseChain node served as SSZ. The hasher is written from the consensus-specs container definitions
//! (`specs/phase0`, `altair`, `bellatrix`, `capella` `beacon-chain.md`). Its correctness is checked by the node itself:
//! the computed state root must equal the `state_root` of the block header, and the body root must equal `body_root`.
//! The Capella layout is the layout of PulseChain.
//!
//! Limits are mainnet preset values (`SLOTS_PER_HISTORICAL_ROOT` 8192, validator registry limit 2^40, and so on).
//! If a root does not match, the preset differs and the caller must stop.

use crate::error::{Error, Result};
use crate::layout::ExecutionHeaderForm;
use crate::ssz::{
    byte_list_root, byte_vector_root, hash_pair, merkleize, merkleize_with_limit, mix_in_length, pack_bytes, u64_chunk,
};
use crate::types::{BeaconBlockHeader, ExecutionPayloadHeader, SyncCommittee};
use alloy_primitives::{Address, B256, U256};

fn le_u64(bytes: &[u8]) -> u64 {
    u64::from_le_bytes(bytes[..8].try_into().expect("8 bytes"))
}

fn chunk32(bytes: &[u8]) -> B256 {
    B256::from_slice(bytes)
}

/// Whether a container field has a fixed size (in bytes) or is variable (a 4-byte offset in the fixed part).
#[derive(Clone, Copy)]
enum Kind {
    Fixed(usize),
    Variable,
}

/// The error for bytes that break an SSZ rule.
fn malformed<T>(reason: impl Into<String>) -> Result<T> {
    Err(Error::MalformedSsz(reason.into()))
}

/// Reads a 4-byte offset at `position` and checks the rules every offset must keep: it does not fall below
/// `minimum` (the offset before it, or the end of the fixed part) and does not pass `bytes.len()`.
fn checked_offset(bytes: &[u8], position: usize, minimum: usize) -> Result<usize> {
    let Some(raw) = bytes.get(position..position + 4) else {
        return malformed(format!("offset at byte {position} runs past the {} bytes of input", bytes.len()));
    };
    let offset = u32::from_le_bytes(raw.try_into().expect("4 bytes")) as usize;
    if offset < minimum {
        return malformed(format!("offset {offset} at byte {position} is below the previous offset {minimum}"));
    }
    if offset > bytes.len() {
        return malformed(format!("offset {offset} at byte {position} is past the {} bytes of input", bytes.len()));
    }
    Ok(offset)
}

/// Splits an SSZ container into one slice per field.
///
/// The first variable offset must equal the size of the fixed part, offsets must not decrease, and none may pass the end
/// of the input (`simple-serialize.md` of consensus-specs, "Deserialization"). A container with no variable field must
/// have exactly the fixed size.
fn split_container<'a>(bytes: &'a [u8], kinds: &[Kind]) -> Result<Vec<&'a [u8]>> {
    let fixed_length: usize = kinds.iter().map(|kind| if let Kind::Fixed(size) = kind { *size } else { 4 }).sum();
    let has_variable = kinds.iter().any(|kind| matches!(kind, Kind::Variable));
    if bytes.len() < fixed_length || (!has_variable && bytes.len() != fixed_length) {
        return malformed(format!(
            "container of {} bytes does not fit its fixed part of {fixed_length} bytes",
            bytes.len()
        ));
    }
    let mut cursor = 0;
    let mut starts: Vec<Option<usize>> = Vec::with_capacity(kinds.len());
    let mut fixed_parts: Vec<&[u8]> = Vec::with_capacity(kinds.len());
    let mut previous = 0;
    for kind in kinds {
        match kind {
            Kind::Fixed(size) => {
                fixed_parts.push(&bytes[cursor..cursor + size]);
                starts.push(None);
                cursor += size;
            }
            Kind::Variable => {
                let offset = checked_offset(bytes, cursor, previous)?;
                if starts.iter().all(Option::is_none) && offset != fixed_length {
                    return malformed(format!("first offset {offset} is not the fixed part size {fixed_length}"));
                }
                previous = offset;
                fixed_parts.push(&[]);
                starts.push(Some(offset));
                cursor += 4;
            }
        }
    }
    let offsets: Vec<usize> = starts.iter().flatten().copied().collect();
    let mut variable_index = 0;
    Ok(kinds
        .iter()
        .enumerate()
        .map(|(position, _)| match starts[position] {
            None => fixed_parts[position],
            Some(start) => {
                let end = offsets.get(variable_index + 1).copied().unwrap_or(bytes.len());
                variable_index += 1;
                &bytes[start..end]
            }
        })
        .collect())
}

/// Splits a list of variable-size elements into its elements.
///
/// `limit` is the SSZ limit of the list type. All checks run before anything is allocated: the first offset is a
/// multiple of 4, at least 4 and at most `bytes.len()`; the count it implies is at most `limit`; offsets never decrease
/// and none passes the end of the input.
fn split_variable_list(bytes: &[u8], limit: u64) -> Result<Vec<&[u8]>> {
    if bytes.is_empty() {
        return Ok(Vec::new());
    }
    let first = checked_offset(bytes, 0, 4)?;
    if !first.is_multiple_of(4) {
        return malformed(format!("first offset {first} of a list is not a multiple of 4"));
    }
    let count = first / 4;
    if count as u64 > limit {
        return malformed(format!("list holds {count} elements, above its limit of {limit}"));
    }
    let mut offsets = Vec::with_capacity(count + 1);
    let mut previous = first;
    for index in 0..count {
        previous = checked_offset(bytes, index * 4, previous)?;
        offsets.push(previous);
    }
    offsets.push(bytes.len());
    Ok(offsets.windows(2).map(|pair| &bytes[pair[0]..pair[1]]).collect())
}

fn list_root(element_roots: &[B256], limit: u64) -> B256 {
    mix_in_length(&merkleize_with_limit(element_roots, limit), element_roots.len() as u64)
}

/// The roots of a list of fixed-size elements. The input must be a whole number of elements, at most `limit`.
fn fixed_list_roots(bytes: &[u8], element_size: usize, limit: u64, hash: impl Fn(&[u8]) -> B256) -> Result<Vec<B256>> {
    if !bytes.len().is_multiple_of(element_size) {
        return malformed(format!("{} bytes are not a whole number of {element_size}-byte elements", bytes.len()));
    }
    let count = bytes.len() / element_size;
    if count as u64 > limit {
        return malformed(format!("list holds {count} elements, above its limit of {limit}"));
    }
    Ok(bytes.chunks_exact(element_size).map(hash).collect())
}

fn checkpoint_root(bytes: &[u8]) -> B256 {
    hash_pair(&u64_chunk(le_u64(bytes)), &chunk32(&bytes[8..40]))
}

fn eth1_data_root(bytes: &[u8]) -> B256 {
    merkleize(&[chunk32(&bytes[0..32]), u64_chunk(le_u64(&bytes[32..40])), chunk32(&bytes[40..72])])
}

fn validator_root(bytes: &[u8]) -> B256 {
    let mut slashed = [0u8; 32];
    slashed[0] = bytes[88];
    merkleize(&[
        byte_vector_root(&bytes[0..48]),
        chunk32(&bytes[48..80]),
        u64_chunk(le_u64(&bytes[80..88])),
        B256::from(slashed),
        u64_chunk(le_u64(&bytes[89..97])),
        u64_chunk(le_u64(&bytes[97..105])),
        u64_chunk(le_u64(&bytes[105..113])),
        u64_chunk(le_u64(&bytes[113..121])),
    ])
}

fn packed_list_root(bytes: &[u8], limit_bytes: u64, length: u64) -> B256 {
    let limit_chunks = limit_bytes.div_ceil(32);
    mix_in_length(&merkleize_with_limit(&pack_bytes(bytes), limit_chunks), length)
}

/// Parses a Capella `SyncCommittee` (512 public keys and the aggregate).
///
/// # Errors
/// `MalformedSsz` when `bytes` is not exactly 512 keys and the aggregate.
pub fn try_parse_sync_committee(bytes: &[u8]) -> Result<SyncCommittee> {
    if bytes.len() != 512 * 48 + 48 {
        return malformed(format!("sync committee has {} bytes, not {}", bytes.len(), 512 * 48 + 48));
    }
    let key = |slice: &[u8]| crate::types::BlsPublicKey::from_slice(slice);
    Ok(SyncCommittee {
        pubkeys: bytes[..512 * 48].chunks_exact(48).map(key).collect(),
        aggregate_pubkey: key(&bytes[512 * 48..]),
    })
}

/// Parses a Capella `SyncCommittee`.
///
/// # Panics
/// Panics when [`try_parse_sync_committee`] fails.
pub fn parse_sync_committee(bytes: &[u8]) -> SyncCommittee {
    try_parse_sync_committee(bytes).unwrap_or_else(|error| panic!("{error}"))
}

/// Parses a Capella execution payload header (the form stored in the state).
///
/// # Panics
/// Panics when [`try_parse_payload_header`] fails.
pub fn parse_payload_header(bytes: &[u8]) -> ExecutionPayloadHeader {
    try_parse_payload_header(bytes).unwrap_or_else(|error| panic!("{error}"))
}

/// Parses a Capella execution payload header (the form stored in the state).
///
/// # Errors
/// `MalformedSsz` when the bytes break an SSZ rule.
pub fn try_parse_payload_header(bytes: &[u8]) -> Result<ExecutionPayloadHeader> {
    let kinds = [
        Kind::Fixed(32),
        Kind::Fixed(20),
        Kind::Fixed(32),
        Kind::Fixed(32),
        Kind::Fixed(256),
        Kind::Fixed(32),
        Kind::Fixed(8),
        Kind::Fixed(8),
        Kind::Fixed(8),
        Kind::Fixed(8),
        Kind::Variable,
        Kind::Fixed(32),
        Kind::Fixed(32),
        Kind::Fixed(32),
        Kind::Fixed(32),
    ];
    let f = split_container(bytes, &kinds)?;
    Ok(payload_header_from_fields(&f, chunk32(f[13]), chunk32(f[14])))
}

fn payload_header_from_fields(f: &[&[u8]], transactions_root: B256, withdrawals_root: B256) -> ExecutionPayloadHeader {
    ExecutionPayloadHeader {
        parent_hash: chunk32(f[0]),
        fee_recipient: Address::from_slice(f[1]),
        state_root: chunk32(f[2]),
        receipts_root: chunk32(f[3]),
        logs_bloom: f[4].to_vec(),
        prev_randao: chunk32(f[5]),
        block_number: le_u64(f[6]),
        gas_limit: le_u64(f[7]),
        gas_used: le_u64(f[8]),
        timestamp: le_u64(f[9]),
        extra_data: f[10].to_vec(),
        base_fee_per_gas: U256::from_le_slice(f[11]),
        block_hash: chunk32(f[12]),
        transactions_root,
        withdrawals_root,
        blob_gas: None,
    }
}

/// The `Fork` container of the beacon state (`previous_version`, `current_version`, `epoch`).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct ForkData {
    /// `Fork.previous_version`.
    pub previous_version: [u8; 4],
    /// `Fork.current_version`.
    pub current_version: [u8; 4],
    /// `Fork.epoch`: the epoch at which the current version began.
    pub epoch: u64,
}

impl ForkData {
    /// Reads the 16 SSZ bytes of a `Fork`.
    ///
    /// # Panics
    /// Panics when `bytes` is shorter than 16 bytes.
    pub fn from_ssz(bytes: &[u8]) -> Self {
        Self {
            previous_version: bytes[0..4].try_into().expect("4 bytes"),
            current_version: bytes[4..8].try_into().expect("4 bytes"),
            epoch: le_u64(&bytes[8..16]),
        }
    }

    /// The three leaves of the container: previous version, current version, epoch. Each is a 32-byte chunk.
    pub fn leaves(&self) -> [B256; 3] {
        [byte_vector_root(&self.previous_version), byte_vector_root(&self.current_version), u64_chunk(self.epoch)]
    }

    /// The SSZ hash tree root.
    pub fn hash_tree_root(&self) -> B256 {
        merkleize(&self.leaves())
    }
}

/// A parsed Capella `BeaconState`: the root of every field, plus the parts the tool reads.
pub struct ParsedState {
    /// The hash tree root of each of the 28 fields, in field order.
    pub field_roots: Vec<B256>,
    /// `state_roots` are not needed; `block_roots` as 8192 chunks.
    pub block_roots: Vec<B256>,
    /// `current_sync_committee`.
    pub current_sync_committee: SyncCommittee,
    /// `next_sync_committee`.
    pub next_sync_committee: SyncCommittee,
    /// `slot`.
    pub slot: u64,
    /// `fork`.
    pub fork: ForkData,
    /// `finalized_checkpoint.epoch` and `.root`.
    pub finalized_checkpoint: (u64, B256),
    /// `historical_summaries` as `(block_summary_root, state_summary_root)` pairs, in list order.
    pub historical_summaries: Vec<(B256, B256)>,
}

impl ParsedState {
    /// The state root.
    pub fn root(&self) -> B256 {
        merkleize(&self.field_roots)
    }
}

/// Parses and hashes a Capella `BeaconState`.
///
/// # Panics
/// Panics when [`try_parse_state`] fails.
pub fn parse_state(bytes: &[u8]) -> ParsedState {
    try_parse_state(bytes).unwrap_or_else(|error| panic!("{error}"))
}

/// Parses and hashes a Capella `BeaconState`, for bytes that a remote node served.
///
/// # Errors
/// `MalformedSsz` when the bytes break an SSZ rule. Nothing is allocated before the offsets are checked.
pub fn try_parse_state(bytes: &[u8]) -> Result<ParsedState> {
    use Kind::{Fixed, Variable};
    let kinds = [
        Fixed(8),
        Fixed(32),
        Fixed(8),
        Fixed(16),
        Fixed(112),
        Fixed(8192 * 32),
        Fixed(8192 * 32),
        Variable,
        Fixed(72),
        Variable,
        Fixed(8),
        Variable,
        Variable,
        Fixed(65536 * 32),
        Fixed(8192 * 8),
        Variable,
        Variable,
        Fixed(1),
        Fixed(40),
        Fixed(40),
        Fixed(40),
        Variable,
        Fixed(24624),
        Fixed(24624),
        Variable,
        Fixed(8),
        Fixed(8),
        Variable,
    ];
    let f = split_container(bytes, &kinds)?;
    let header = |slice: &[u8]| {
        BeaconBlockHeader {
            slot: le_u64(&slice[0..8]),
            proposer_index: le_u64(&slice[8..16]),
            parent_root: chunk32(&slice[16..48]),
            state_root: chunk32(&slice[48..80]),
            body_root: chunk32(&slice[80..112]),
        }
        .hash_tree_root()
    };
    let fork = ForkData::from_ssz(f[3]);
    let root_chunks = |slice: &[u8]| -> Vec<B256> { slice.chunks_exact(32).map(chunk32).collect() };
    // Limits are the mainnet preset: EPOCHS_PER_ETH1_VOTING_PERIOD * SLOTS_PER_EPOCH = 2048 (phase0 beacon-chain.md),
    // VALIDATOR_REGISTRY_LIMIT = 2^40 and HISTORICAL_ROOTS_LIMIT = 2^24 (phase0 and capella beacon-chain.md).
    let eth1_votes = fixed_list_roots(f[9], 72, 2048, eth1_data_root)?;
    let validators = fixed_list_roots(f[11], 121, 1 << 40, validator_root)?;
    if !f[7].len().is_multiple_of(32) || (f[7].len() / 32) as u64 > 1 << 24 {
        return malformed("historical_roots is not a whole list of at most 2^24 roots");
    }
    let historical_roots = root_chunks(f[7]);
    let summaries =
        fixed_list_roots(f[27], 64, 1 << 24, |item| hash_pair(&chunk32(&item[0..32]), &chunk32(&item[32..64])))?;
    let mut justification = [0u8; 32];
    justification[0] = f[17][0];
    let payload = try_parse_payload_header(f[24])?;
    let committee_roots = (try_parse_sync_committee(f[22])?, try_parse_sync_committee(f[23])?);
    let field_roots = vec![
        u64_chunk(le_u64(f[0])),
        chunk32(f[1]),
        u64_chunk(le_u64(f[2])),
        fork.hash_tree_root(),
        header(f[4]),
        merkleize(&root_chunks(f[5])),
        merkleize(&root_chunks(f[6])),
        list_root(&historical_roots, 1 << 24),
        eth1_data_root(f[8]),
        list_root(&eth1_votes, 2048),
        u64_chunk(le_u64(f[10])),
        list_root(&validators, 1 << 40),
        packed_list_root(f[12], (1u64 << 40) * 8, (f[12].len() / 8) as u64),
        merkleize(&root_chunks(f[13])),
        merkleize(&pack_bytes(f[14])),
        packed_list_root(f[15], 1u64 << 40, f[15].len() as u64),
        packed_list_root(f[16], 1u64 << 40, f[16].len() as u64),
        B256::from(justification),
        checkpoint_root(f[18]),
        checkpoint_root(f[19]),
        checkpoint_root(f[20]),
        packed_list_root(f[21], (1u64 << 40) * 8, (f[21].len() / 8) as u64),
        committee_roots.0.hash_tree_root()?,
        committee_roots.1.hash_tree_root()?,
        payload.hash_tree_root(ExecutionHeaderForm::Capella)?,
        u64_chunk(le_u64(f[25])),
        u64_chunk(le_u64(f[26])),
        list_root(&summaries, 1 << 24),
    ];
    Ok(ParsedState {
        field_roots,
        block_roots: root_chunks(f[5]),
        current_sync_committee: committee_roots.0,
        next_sync_committee: committee_roots.1,
        slot: le_u64(f[2]),
        fork,
        finalized_checkpoint: (le_u64(f[20]), chunk32(&f[20][8..40])),
        historical_summaries: f[27]
            .chunks_exact(64)
            .map(|item| (chunk32(&item[0..32]), chunk32(&item[32..64])))
            .collect(),
    })
}

/// A parsed Capella `BeaconBlock`: its header and the execution payload header derived from the body.
pub struct ParsedBlock {
    /// The beacon block header (the body root is computed here, `state_root` comes from the block).
    pub header: BeaconBlockHeader,
    /// The execution payload as a header (transactions and withdrawals replaced by their roots).
    pub payload: ExecutionPayloadHeader,
    /// The root of each of the 11 body fields.
    pub body_field_roots: Vec<B256>,
}

fn signed_header_root(bytes: &[u8]) -> B256 {
    let header = BeaconBlockHeader {
        slot: le_u64(&bytes[0..8]),
        proposer_index: le_u64(&bytes[8..16]),
        parent_root: chunk32(&bytes[16..48]),
        state_root: chunk32(&bytes[48..80]),
        body_root: chunk32(&bytes[80..112]),
    };
    hash_pair(&header.hash_tree_root(), &byte_vector_root(&bytes[112..208]))
}

fn attestation_data_root(bytes: &[u8]) -> B256 {
    merkleize(&[
        u64_chunk(le_u64(&bytes[0..8])),
        u64_chunk(le_u64(&bytes[8..16])),
        chunk32(&bytes[16..48]),
        checkpoint_root(&bytes[48..88]),
        checkpoint_root(&bytes[88..128]),
    ])
}

fn bitlist_root(bytes: &[u8], max_bits: u64) -> Result<B256> {
    let Some(&last) = bytes.last().filter(|last| **last != 0) else {
        return malformed("a bitlist needs a last byte that holds the delimiter bit");
    };
    let delimiter = 7 - last.leading_zeros() as usize;
    let bit_length = (bytes.len() - 1) * 8 + delimiter;
    if bit_length as u64 > max_bits {
        return malformed(format!("bitlist holds {bit_length} bits, above its limit of {max_bits}"));
    }
    let mut data = bytes.to_vec();
    *data.last_mut().expect("last") &= !(1u8 << delimiter);
    if delimiter == 0 {
        data.pop();
    }
    Ok(mix_in_length(&merkleize_with_limit(&pack_bytes(&data), max_bits.div_ceil(256)), bit_length as u64))
}

fn attestation_root(bytes: &[u8]) -> Result<B256> {
    let parts = split_container(bytes, &[Kind::Variable, Kind::Fixed(128), Kind::Fixed(96)])?;
    // MAX_VALIDATORS_PER_COMMITTEE = 2048 (phase0 preset).
    Ok(merkleize(&[bitlist_root(parts[0], 2048)?, attestation_data_root(parts[1]), byte_vector_root(parts[2])]))
}

fn deposit_root(bytes: &[u8]) -> B256 {
    let proof_chunks: Vec<B256> = bytes[..33 * 32].chunks_exact(32).map(chunk32).collect();
    let data = &bytes[33 * 32..];
    let data_root = merkleize(&[
        byte_vector_root(&data[0..48]),
        chunk32(&data[48..80]),
        u64_chunk(le_u64(&data[80..88])),
        byte_vector_root(&data[88..184]),
    ]);
    hash_pair(&merkleize(&proof_chunks), &data_root)
}

/// Parses and hashes a Capella `SignedBeaconBlock`.
///
/// # Panics
/// Panics when [`try_parse_signed_block`] fails.
pub fn parse_signed_block(bytes: &[u8]) -> ParsedBlock {
    try_parse_signed_block(bytes).unwrap_or_else(|error| panic!("{error}"))
}

/// Parses and hashes a Capella `SignedBeaconBlock`, for bytes that a remote node served.
///
/// # Errors
/// `MalformedSsz` when the bytes break an SSZ rule, or when the block carries attester slashings (not supported here).
pub fn try_parse_signed_block(bytes: &[u8]) -> Result<ParsedBlock> {
    use Kind::{Fixed, Variable};
    // `SignedBeaconBlock` is the message (variable) followed by the 96-byte signature.
    let outer = split_container(bytes, &[Variable, Fixed(96)])?;
    let message = outer[0];
    let block = split_container(message, &[Fixed(8), Fixed(8), Fixed(32), Fixed(32), Variable])?;
    let body = split_container(
        block[4],
        &[
            Fixed(96),
            Fixed(72),
            Fixed(32),
            Variable,
            Variable,
            Variable,
            Variable,
            Variable,
            Fixed(160),
            Variable,
            Variable,
        ],
    )?;
    if !body[4].is_empty() {
        return malformed("blocks with attester slashings are not supported by this tool");
    }

    let payload_fields = split_container(
        body[9],
        &[
            Fixed(32),
            Fixed(20),
            Fixed(32),
            Fixed(32),
            Fixed(256),
            Fixed(32),
            Fixed(8),
            Fixed(8),
            Fixed(8),
            Fixed(8),
            Variable,
            Fixed(32),
            Fixed(32),
            Variable,
            Variable,
        ],
    )?;
    // Limits are the mainnet preset: MAX_TRANSACTIONS_PER_PAYLOAD = 2^20 and MAX_BYTES_PER_TRANSACTION = 2^30
    // (bellatrix beacon-chain.md), MAX_WITHDRAWALS_PER_PAYLOAD = 16 (capella beacon-chain.md), MAX_PROPOSER_SLASHINGS,
    // MAX_DEPOSITS, MAX_VOLUNTARY_EXITS = 16, MAX_ATTESTATIONS = 128 (phase0 beacon-chain.md),
    // MAX_BLS_TO_EXECUTION_CHANGES = 16 (capella beacon-chain.md).
    let transaction_roots: Vec<B256> = split_variable_list(payload_fields[13], 1 << 20)?
        .iter()
        .map(|transaction| byte_list_root(transaction, 1 << 30))
        .collect();
    let withdrawal_roots = fixed_list_roots(payload_fields[14], 44, 16, |item| {
        merkleize(&[
            u64_chunk(le_u64(&item[0..8])),
            u64_chunk(le_u64(&item[8..16])),
            B256::right_padding_from(&item[16..36]),
            u64_chunk(le_u64(&item[36..44])),
        ])
    })?;
    let payload = payload_header_from_fields(
        &payload_fields,
        list_root(&transaction_roots, 1 << 20),
        list_root(&withdrawal_roots, 16),
    );

    let proposer_slashings = fixed_list_roots(body[3], 416, 16, |item| {
        hash_pair(&signed_header_root(&item[0..208]), &signed_header_root(&item[208..416]))
    })?;
    let attestations: Vec<B256> =
        split_variable_list(body[5], 128)?.iter().map(|item| attestation_root(item)).collect::<Result<_>>()?;
    let deposits = fixed_list_roots(body[6], 1240, 16, deposit_root)?;
    let exits = fixed_list_roots(body[7], 112, 16, |item| {
        hash_pair(
            &hash_pair(&u64_chunk(le_u64(&item[0..8])), &u64_chunk(le_u64(&item[8..16]))),
            &byte_vector_root(&item[16..112]),
        )
    })?;
    let sync_aggregate = hash_pair(&byte_vector_root(&body[8][0..64]), &byte_vector_root(&body[8][64..160]));
    let changes = fixed_list_roots(body[10], 172, 16, |item| {
        let message = merkleize(&[
            u64_chunk(le_u64(&item[0..8])),
            byte_vector_root(&item[8..56]),
            B256::right_padding_from(&item[56..76]),
        ]);
        hash_pair(&message, &byte_vector_root(&item[76..172]))
    })?;

    let body_field_roots: Vec<B256> = vec![
        byte_vector_root(body[0]),
        eth1_data_root(body[1]),
        chunk32(body[2]),
        list_root(&proposer_slashings, 16),
        list_root(&[], 2),
        list_root(&attestations, 128),
        list_root(&deposits, 16),
        list_root(&exits, 16),
        sync_aggregate,
        payload.hash_tree_root(ExecutionHeaderForm::Capella)?,
        list_root(&changes, 16),
    ];
    // The Capella body has 11 fields (randao_reveal ... bls_to_execution_changes). Field 9 is execution_payload.
    let body_leaves = body_field_roots;
    let header = BeaconBlockHeader {
        slot: le_u64(block[0]),
        proposer_index: le_u64(block[1]),
        parent_root: chunk32(block[2]),
        state_root: chunk32(block[3]),
        body_root: merkleize(&body_leaves),
    };
    Ok(ParsedBlock { header, payload, body_field_roots: body_leaves })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn offsets_list(offsets: &[u32], body: &[u8]) -> Vec<u8> {
        let mut bytes: Vec<u8> = offsets.iter().flat_map(|offset| offset.to_le_bytes()).collect();
        bytes.extend_from_slice(body);
        bytes
    }

    fn is_malformed<T>(result: Result<T>, needle: &str) {
        match result.map(|_| ()) {
            Err(Error::MalformedSsz(reason)) => assert!(reason.contains(needle), "reason {reason:?} lacks {needle:?}"),
            other => panic!("expected MalformedSsz containing {needle:?}, got {other:?}"),
        }
    }

    /// Claim: a valid list splits into its elements.
    /// Why it matters: the checks must not reject what an honest node serves.
    #[test]
    fn variable_list_valid_control() {
        let bytes = offsets_list(&[12, 14, 14], b"abcde");
        let parts = split_variable_list(&bytes, 3).unwrap();
        assert_eq!(parts, vec![&b"ab"[..], &b""[..], &b"cde"[..]]);
        assert!(split_variable_list(&[], 3).unwrap().is_empty());
    }

    /// Claim: a first offset of 4 GiB minus one is refused before any allocation.
    /// Why it matters: the count came from this offset, so a hostile node could abort the process on allocation.
    #[test]
    fn variable_list_huge_first_offset() {
        is_malformed(split_variable_list(&offsets_list(&[u32::MAX], b""), u64::MAX), "past");
    }

    /// Claim: a first offset that is not a multiple of 4, or is below 4, is refused.
    #[test]
    fn variable_list_first_offset_misaligned() {
        is_malformed(split_variable_list(&offsets_list(&[6, 6], b"xxxx"), 10), "multiple of 4");
        is_malformed(split_variable_list(&offsets_list(&[0], b"xxxx"), 10), "below");
    }

    /// Claim: offsets that decrease are refused.
    #[test]
    fn variable_list_decreasing_offsets() {
        is_malformed(split_variable_list(&offsets_list(&[12, 16, 14], b"abcdef"), 3), "below");
    }

    /// Claim: an offset past the end of the input is refused.
    #[test]
    fn variable_list_offset_past_end() {
        is_malformed(split_variable_list(&offsets_list(&[8, 99], b"abc"), 2), "past");
    }

    /// Claim: a count above the list limit is refused, one element at the limit is accepted.
    #[test]
    fn variable_list_count_above_limit() {
        let bytes = offsets_list(&[12, 12, 12], b"");
        is_malformed(split_variable_list(&bytes, 2), "above its limit");
        assert_eq!(split_variable_list(&bytes, 3).unwrap().len(), 3);
    }

    const KINDS: [Kind; 3] = [Kind::Fixed(2), Kind::Variable, Kind::Variable];

    /// Claim: a valid container splits into its fields.
    #[test]
    fn container_valid_control() {
        let mut bytes = vec![7, 8];
        bytes.extend(offsets_list(&[10, 12], b"abcd"));
        let fields = split_container(&bytes, &KINDS).unwrap();
        assert_eq!(fields, vec![&[7u8, 8][..], &b"ab"[..], &b"cd"[..]]);
    }

    /// Claim: the container refuses input shorter than the fixed part, a first offset that is not the fixed size,
    /// decreasing offsets and offsets past the end.
    #[test]
    fn container_bad_offsets() {
        is_malformed(split_container(&[1, 2, 3], &KINDS), "fixed part");
        let with = |offsets: &[u32], body: &[u8]| [vec![7u8, 8], offsets_list(offsets, body)].concat();
        is_malformed(split_container(&with(&[u32::MAX, 12], b"ab"), &KINDS), "past");
        is_malformed(split_container(&with(&[9, 10], b"ab"), &KINDS), "first offset");
        let three = [Kind::Variable, Kind::Variable, Kind::Variable];
        let decreasing = offsets_list(&[12, 15, 13], b"abcdef");
        is_malformed(split_container(&decreasing, &three), "below");
        is_malformed(split_container(&with(&[10, 99], b"abcd"), &KINDS), "past");
    }

    /// Claim: a container with no variable field must have exactly its fixed size.
    #[test]
    fn container_fixed_only_needs_exact_size() {
        assert!(split_container(&[0; 4], &[Kind::Fixed(4)]).is_ok());
        is_malformed(split_container(&[0; 5], &[Kind::Fixed(4)]), "fixed part");
    }

    /// Claim: lists of fixed-size elements and bitlists refuse bad lengths instead of truncating or panicking.
    #[test]
    fn fixed_list_and_bitlist_bounds() {
        is_malformed(fixed_list_roots(&[0; 5], 2, 10, |_| B256::ZERO), "whole number");
        is_malformed(fixed_list_roots(&[0; 6], 2, 2, |_| B256::ZERO), "above its limit");
        is_malformed(bitlist_root(&[], 8), "delimiter");
        is_malformed(bitlist_root(&[0], 8), "delimiter");
        is_malformed(bitlist_root(&[0xff, 0x03], 8), "above its limit");
        assert!(bitlist_root(&[0b101], 8).is_ok());
    }

    /// Claim: parsing hostile whole objects returns an error and does not panic.
    #[test]
    fn hostile_objects_do_not_panic() {
        is_malformed(try_parse_state(&[]), "fixed part");
        is_malformed(try_parse_signed_block(&[0xff; 100]), "");
        is_malformed(try_parse_sync_committee(&[0; 3]), "sync committee");
    }

    /// Claim: a payload header with `extra_data` longer than 32 bytes fails to hash with an error, not a panic.
    /// Why it matters: `try_parse_state` and `try_parse_signed_block` hash the payload header with `?`, so a hostile
    /// beacon node that serves 33 bytes of `extra_data` gets an error back and cannot crash the prover.
    #[test]
    fn oversized_extra_data_is_an_error() {
        // Fixed part of a Capella payload header: 404 + 4 × 8 + 4 (offset) + 4 × 32 = 568 bytes.
        let fixed_size = 568u32;
        let mut bytes = vec![0u8; fixed_size as usize];
        bytes[436..440].copy_from_slice(&fixed_size.to_le_bytes());
        let control = try_parse_payload_header(&[bytes.clone(), vec![7; 32]].concat()).expect("32 bytes parse");
        assert!(control.hash_tree_root(ExecutionHeaderForm::Capella).is_ok());
        let header = try_parse_payload_header(&[bytes, vec![7; 33]].concat()).expect("the layout parses");
        assert!(header.hash_tree_root(ExecutionHeaderForm::Capella).is_err());
    }
}
