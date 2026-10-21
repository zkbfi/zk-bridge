//! Parser and hasher for real Capella-layout SSZ data: `BeaconState` and `SignedBeaconBlock`.
//!
//! This is test support. It exists so the derive tool can compute REAL Merkle branches from a beacon state and a block
//! body that a PulseChain node served as SSZ. The hasher is written from the consensus-specs container definitions
//! (`specs/phase0`, `altair`, `bellatrix`, `capella` `beacon-chain.md`). Its correctness is checked by the node itself:
//! the computed state root must equal the `state_root` of the block header, and the body root must equal `body_root`.
//! The Capella layout is the layout of PulseChain.
//!
//! Limits are mainnet preset values (`SLOTS_PER_HISTORICAL_ROOT` 8192, validator registry limit 2^40, and so on).
//! If a root does not match, the preset differs and the caller must stop.

use alloy_primitives::{Address, B256, U256};
use lc_core::layout::ExecutionHeaderForm;
use lc_core::ssz::{
    byte_list_root, byte_vector_root, hash_pair, merkleize, merkleize_with_limit, mix_in_length, pack_bytes, u64_chunk,
};
use lc_core::types::{BeaconBlockHeader, ExecutionPayloadHeader, SyncCommittee};

fn le_u64(bytes: &[u8]) -> u64 {
    u64::from_le_bytes(bytes[..8].try_into().expect("8 bytes"))
}

fn le_u32(bytes: &[u8]) -> usize {
    u32::from_le_bytes(bytes[..4].try_into().expect("4 bytes")) as usize
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

/// Splits an SSZ container into one slice per field.
fn split_container<'a>(bytes: &'a [u8], kinds: &[Kind]) -> Vec<&'a [u8]> {
    let fixed_length: usize = kinds.iter().map(|kind| if let Kind::Fixed(size) = kind { *size } else { 4 }).sum();
    let mut cursor = 0;
    let mut starts: Vec<Option<usize>> = Vec::new();
    let mut fixed_parts: Vec<&[u8]> = Vec::new();
    for kind in kinds {
        match kind {
            Kind::Fixed(size) => {
                fixed_parts.push(&bytes[cursor..cursor + size]);
                starts.push(None);
                cursor += size;
            }
            Kind::Variable => {
                fixed_parts.push(&[]);
                starts.push(Some(le_u32(&bytes[cursor..])));
                cursor += 4;
            }
        }
    }
    assert_eq!(cursor, fixed_length);
    let offsets: Vec<usize> = starts.iter().flatten().copied().collect();
    let mut variable_index = 0;
    kinds
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
        .collect()
}

/// Splits a list of variable-size elements into its elements.
fn split_variable_list(bytes: &[u8]) -> Vec<&[u8]> {
    if bytes.is_empty() {
        return Vec::new();
    }
    let count = le_u32(bytes) / 4;
    let offsets: Vec<usize> = (0..count).map(|index| le_u32(&bytes[index * 4..])).collect();
    (0..count)
        .map(|index| {
            let end = offsets.get(index + 1).copied().unwrap_or(bytes.len());
            &bytes[offsets[index]..end]
        })
        .collect()
}

fn list_root(element_roots: &[B256], limit: u64) -> B256 {
    mix_in_length(&merkleize_with_limit(element_roots, limit), element_roots.len() as u64)
}

fn fixed_list_roots(bytes: &[u8], element_size: usize, hash: impl Fn(&[u8]) -> B256) -> Vec<B256> {
    bytes.chunks_exact(element_size).map(hash).collect()
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
pub fn parse_sync_committee(bytes: &[u8]) -> SyncCommittee {
    assert_eq!(bytes.len(), 512 * 48 + 48);
    let key = |slice: &[u8]| lc_core::types::BlsPublicKey::from_slice(slice);
    SyncCommittee {
        pubkeys: bytes[..512 * 48].chunks_exact(48).map(key).collect(),
        aggregate_pubkey: key(&bytes[512 * 48..]),
    }
}

/// Parses a Capella execution payload header (the form stored in the state).
pub fn parse_payload_header(bytes: &[u8]) -> ExecutionPayloadHeader {
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
    let f = split_container(bytes, &kinds);
    payload_header_from_fields(&f, chunk32(f[13]), chunk32(f[14]))
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
    /// `finalized_checkpoint.epoch` and `.root`.
    pub finalized_checkpoint: (u64, B256),
}

impl ParsedState {
    /// The state root.
    pub fn root(&self) -> B256 {
        merkleize(&self.field_roots)
    }
}

/// Parses and hashes a Capella `BeaconState`.
pub fn parse_state(bytes: &[u8]) -> ParsedState {
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
    let f = split_container(bytes, &kinds);
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
    let fork_root =
        merkleize(&[byte_vector_root(&f[3][0..4]), byte_vector_root(&f[3][4..8]), u64_chunk(le_u64(&f[3][8..16]))]);
    let root_chunks = |slice: &[u8]| -> Vec<B256> { slice.chunks_exact(32).map(chunk32).collect() };
    let eth1_votes = fixed_list_roots(f[9], 72, eth1_data_root);
    let validators = fixed_list_roots(f[11], 121, validator_root);
    let historical_roots = root_chunks(f[7]);
    let summaries = fixed_list_roots(f[27], 64, |item| hash_pair(&chunk32(&item[0..32]), &chunk32(&item[32..64])));
    let mut justification = [0u8; 32];
    justification[0] = f[17][0];
    let payload = parse_payload_header(f[24]);
    let field_roots = vec![
        u64_chunk(le_u64(f[0])),
        chunk32(f[1]),
        u64_chunk(le_u64(f[2])),
        fork_root,
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
        parse_sync_committee(f[22]).hash_tree_root().expect("committee root"),
        parse_sync_committee(f[23]).hash_tree_root().expect("committee root"),
        payload.hash_tree_root(ExecutionHeaderForm::Capella).expect("payload header root"),
        u64_chunk(le_u64(f[25])),
        u64_chunk(le_u64(f[26])),
        list_root(&summaries, 1 << 24),
    ];
    ParsedState {
        field_roots,
        block_roots: root_chunks(f[5]),
        current_sync_committee: parse_sync_committee(f[22]),
        next_sync_committee: parse_sync_committee(f[23]),
        slot: le_u64(f[2]),
        finalized_checkpoint: (le_u64(f[20]), chunk32(&f[20][8..40])),
    }
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

fn bitlist_root(bytes: &[u8], max_bits: u64) -> B256 {
    let last = *bytes.last().expect("bitlist has a delimiter");
    let delimiter = 7 - last.leading_zeros() as usize;
    let bit_length = (bytes.len() - 1) * 8 + delimiter;
    let mut data = bytes.to_vec();
    *data.last_mut().expect("last") &= !(1u8 << delimiter);
    if delimiter == 0 {
        data.pop();
    }
    mix_in_length(&merkleize_with_limit(&pack_bytes(&data), max_bits.div_ceil(256)), bit_length as u64)
}

fn attestation_root(bytes: &[u8]) -> B256 {
    let parts = split_container(bytes, &[Kind::Variable, Kind::Fixed(128), Kind::Fixed(96)]);
    merkleize(&[bitlist_root(parts[0], 2048), attestation_data_root(parts[1]), byte_vector_root(parts[2])])
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
/// Panics when the block carries attester slashings (not supported here) or when sizes are off.
pub fn parse_signed_block(bytes: &[u8]) -> ParsedBlock {
    use Kind::{Fixed, Variable};
    let message = &bytes[le_u32(bytes)..];
    let block = split_container(message, &[Fixed(8), Fixed(8), Fixed(32), Fixed(32), Variable]);
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
    );
    assert!(body[4].is_empty(), "blocks with attester slashings are not supported by this tool");

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
    );
    let transaction_roots: Vec<B256> = split_variable_list(payload_fields[13])
        .iter()
        .map(|transaction| byte_list_root(transaction, 1 << 30))
        .collect();
    let withdrawal_roots = fixed_list_roots(payload_fields[14], 44, |item| {
        merkleize(&[
            u64_chunk(le_u64(&item[0..8])),
            u64_chunk(le_u64(&item[8..16])),
            B256::right_padding_from(&item[16..36]),
            u64_chunk(le_u64(&item[36..44])),
        ])
    });
    let payload = payload_header_from_fields(
        &payload_fields,
        list_root(&transaction_roots, 1 << 20),
        list_root(&withdrawal_roots, 16),
    );

    let proposer_slashings = fixed_list_roots(body[3], 416, |item| {
        hash_pair(&signed_header_root(&item[0..208]), &signed_header_root(&item[208..416]))
    });
    let attestations: Vec<B256> = split_variable_list(body[5]).iter().map(|item| attestation_root(item)).collect();
    let deposits = fixed_list_roots(body[6], 1240, deposit_root);
    let exits = fixed_list_roots(body[7], 112, |item| {
        hash_pair(
            &hash_pair(&u64_chunk(le_u64(&item[0..8])), &u64_chunk(le_u64(&item[8..16]))),
            &byte_vector_root(&item[16..112]),
        )
    });
    let sync_aggregate = hash_pair(&byte_vector_root(&body[8][0..64]), &byte_vector_root(&body[8][64..160]));
    let changes = fixed_list_roots(body[10], 172, |item| {
        let message = merkleize(&[
            u64_chunk(le_u64(&item[0..8])),
            byte_vector_root(&item[8..56]),
            B256::right_padding_from(&item[56..76]),
        ]);
        hash_pair(&message, &byte_vector_root(&item[76..172]))
    });

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
        payload.hash_tree_root(ExecutionHeaderForm::Capella).expect("payload root"),
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
    ParsedBlock { header, payload, body_field_roots: body_leaves }
}
