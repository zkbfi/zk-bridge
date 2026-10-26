//! Parser and hasher for the Gloas `SignedBeaconBlock` (`specs/gloas/beacon-chain.md`, `BeaconBlockBody`).
//!
//! The prover needs one branch of the body: from the bid `parent_block_hash` (index 2856) to the body root. That branch holds
//! the roots of the other body fields, so the whole body is hashed. The body is a progressive container of 13 fields
//! (`eip-7495.md`), and its big lists are progressive lists (`eip-7916.md`). The check is the root: the computed body root
//! must equal the `body_root` of the header that names the block. The tests of `lc-testkit` hash a real Sepolia block.

use crate::error::Result;
use crate::layout::BLOCK_HASH_GINDEX_GLOAS;
use crate::ssz::{
    byte_vector_root, hash_pair, merkleize, merkleize_progressive, mix_in_length, pack_bytes,
    progressive_container_branch, progressive_container_root, u64_chunk,
};
use crate::ssz_state::{
    attestation_data_root, chunk32, deposit_root, eth1_data_root, fixed_list_roots, le_u64, malformed,
    signed_header_root, split_container, split_variable_list, Kind,
};
use crate::ssz_state_gloas::{address_chunk, execution_payload_bid_chunks, progressive_list_root};
use crate::types::BeaconBlockHeader;
use alloy_primitives::B256;

/// The position of `signed_execution_payload_bid` among the 13 body fields.
const BODY_FIELD_SIGNED_BID: usize = 10;

/// The limit of a progressive list of the body. A progressive list has no SSZ limit. The bytes of the input bound it.
const LIST_LIMIT: u64 = 1 << 40;

/// A parsed Gloas block: its header with the computed body root, and the parts of the body that the prover reads.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ParsedGloasBlock {
    /// The beacon header (the body root is computed here, `state_root` comes from the block).
    pub header: BeaconBlockHeader,
    /// The root of each of the 13 body fields.
    pub body_field_roots: Vec<B256>,
    /// The 12 chunks of the bid of the block.
    pub bid_chunks: Vec<B256>,
    /// The root of the signature of the bid: the sibling of the bid message in `SignedExecutionPayloadBid`.
    pub bid_signature_root: B256,
}

impl ParsedGloasBlock {
    /// `signed_execution_payload_bid.message.parent_block_hash`: the execution block that the block builds on.
    pub fn bid_parent_block_hash(&self) -> B256 {
        self.bid_chunks[0]
    }

    /// The branch from the bid `parent_block_hash` to the body root, 11 entries, for index [`BLOCK_HASH_GINDEX_GLOAS`]:
    /// the rest of the bid tree and its `active_fields` (2), the root of the bid signature (1), then the body (8).
    pub fn bid_parent_block_hash_branch(&self) -> Vec<B256> {
        let mut branch = progressive_container_branch(&self.bid_chunks, 0).1;
        branch.push(self.bid_signature_root);
        branch.extend(progressive_container_branch(&self.body_field_roots, BODY_FIELD_SIGNED_BID).1);
        debug_assert_eq!(branch.len(), crate::ssz::gindex_depth(BLOCK_HASH_GINDEX_GLOAS) as usize);
        branch
    }
}

/// A progressive list of fixed-size elements.
fn fixed_progressive_list(bytes: &[u8], size: usize, hash: impl Fn(&[u8]) -> B256) -> Result<B256> {
    Ok(progressive_list_root(&fixed_list_roots(bytes, size, LIST_LIMIT, hash)?))
}

/// A progressive list of variable-size elements.
fn variable_progressive_list(bytes: &[u8], hash: impl Fn(&[u8]) -> Result<B256>) -> Result<B256> {
    let roots = split_variable_list(bytes, LIST_LIMIT)?.into_iter().map(hash).collect::<Result<Vec<_>>>()?;
    Ok(progressive_list_root(&roots))
}

/// `ProgressiveBitList`: `hash(merkleize_progressive(pack_bits(bits)), length)`. The last byte holds the delimiter bit.
fn progressive_bitlist_root(bytes: &[u8]) -> Result<B256> {
    let Some(&last) = bytes.last().filter(|last| **last != 0) else {
        return malformed("a bitlist needs a last byte that holds the delimiter bit");
    };
    let delimiter = 7 - last.leading_zeros() as usize;
    let bit_length = (bytes.len() - 1) * 8 + delimiter;
    let mut data = bytes.to_vec();
    *data.last_mut().expect("last") &= !(1u8 << delimiter);
    if delimiter == 0 {
        data.pop();
    }
    Ok(mix_in_length(&merkleize_progressive(&pack_bytes(&data)), bit_length as u64))
}

/// `IndexedAttestation` (progressive, 3 fields): `attesting_indices`, `data`, `signature`.
fn indexed_attestation_root(bytes: &[u8]) -> Result<B256> {
    let f = split_container(bytes, &[Kind::Variable, Kind::Fixed(128), Kind::Fixed(96)])?;
    if !f[0].len().is_multiple_of(8) {
        return malformed("attesting_indices is not a whole number of 8 byte indices");
    }
    let indices = mix_in_length(&merkleize_progressive(&pack_bytes(f[0])), (f[0].len() / 8) as u64);
    Ok(progressive_container_root(&[indices, attestation_data_root(f[1]), byte_vector_root(f[2])]))
}

/// `AttesterSlashing` (plain): two indexed attestations.
fn attester_slashing_root(bytes: &[u8]) -> Result<B256> {
    let f = split_container(bytes, &[Kind::Variable, Kind::Variable])?;
    Ok(hash_pair(&indexed_attestation_root(f[0])?, &indexed_attestation_root(f[1])?))
}

/// `Attestation` (progressive, 4 fields): `aggregation_bits`, `data`, `signature`, `committee_bits`.
fn attestation_root(bytes: &[u8]) -> Result<B256> {
    let f = split_container(bytes, &[Kind::Variable, Kind::Fixed(128), Kind::Fixed(96), Kind::Fixed(8)])?;
    Ok(progressive_container_root(&[
        progressive_bitlist_root(f[0])?,
        attestation_data_root(f[1]),
        byte_vector_root(f[2]),
        merkleize(&pack_bytes(f[3])),
    ]))
}

/// `SignedVoluntaryExit`: the exit (`epoch`, `validator_index`) and the signature.
fn signed_voluntary_exit_root(bytes: &[u8]) -> B256 {
    let message = hash_pair(&u64_chunk(le_u64(&bytes[0..8])), &u64_chunk(le_u64(&bytes[8..16])));
    hash_pair(&message, &byte_vector_root(&bytes[16..112]))
}

/// `SignedBLSToExecutionChange`: the change (`validator_index`, `from_bls_pubkey`, `to_execution_address`) and the signature.
fn signed_bls_change_root(bytes: &[u8]) -> B256 {
    let message =
        merkleize(&[u64_chunk(le_u64(&bytes[0..8])), byte_vector_root(&bytes[8..56]), address_chunk(&bytes[56..76])]);
    hash_pair(&message, &byte_vector_root(&bytes[76..172]))
}

/// `PayloadAttestation` (progressive, 3 fields): `aggregation_bits` (512 bits), `data`, `signature`.
fn payload_attestation_root(bytes: &[u8]) -> B256 {
    let flag = |byte: u8| {
        let mut chunk = [0u8; 32];
        chunk[0] = byte;
        B256::from(chunk)
    };
    let data =
        merkleize(&[chunk32(&bytes[64..96]), u64_chunk(le_u64(&bytes[96..104])), flag(bytes[104]), flag(bytes[105])]);
    progressive_container_root(&[merkleize(&pack_bytes(&bytes[0..64])), data, byte_vector_root(&bytes[106..202])])
}

/// `ExecutionRequests` (progressive, 5 fields): five progressive lists of fixed-size requests.
fn execution_requests_root(bytes: &[u8]) -> Result<B256> {
    use Kind::Variable;
    let f = split_container(bytes, &[Variable, Variable, Variable, Variable, Variable])?;
    let deposit = |item: &[u8]| {
        merkleize(&[
            byte_vector_root(&item[0..48]),
            chunk32(&item[48..80]),
            u64_chunk(le_u64(&item[80..88])),
            byte_vector_root(&item[88..184]),
            u64_chunk(le_u64(&item[184..192])),
        ])
    };
    let withdrawal = |item: &[u8]| {
        merkleize(&[address_chunk(&item[0..20]), byte_vector_root(&item[20..68]), u64_chunk(le_u64(&item[68..76]))])
    };
    let consolidation = |item: &[u8]| {
        merkleize(&[address_chunk(&item[0..20]), byte_vector_root(&item[20..68]), byte_vector_root(&item[68..116])])
    };
    let builder_deposit = |item: &[u8]| {
        merkleize(&[
            byte_vector_root(&item[0..48]),
            chunk32(&item[48..80]),
            u64_chunk(le_u64(&item[80..88])),
            byte_vector_root(&item[88..184]),
        ])
    };
    let builder_exit = |item: &[u8]| merkleize(&[address_chunk(&item[0..20]), byte_vector_root(&item[20..68])]);
    Ok(progressive_container_root(&[
        fixed_progressive_list(f[0], 192, deposit)?,
        fixed_progressive_list(f[1], 76, withdrawal)?,
        fixed_progressive_list(f[2], 116, consolidation)?,
        fixed_progressive_list(f[3], 184, builder_deposit)?,
        fixed_progressive_list(f[4], 68, builder_exit)?,
    ]))
}

/// The 13 field roots of the Gloas `BeaconBlockBody` and the chunks of its bid.
fn body_roots(body: &[u8]) -> Result<(Vec<B256>, Vec<B256>, B256)> {
    use Kind::{Fixed, Variable};
    let f = split_container(
        body,
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
            Variable,
            Variable,
        ],
    )?;
    let signed_bid = split_container(f[10], &[Variable, Fixed(96)])?;
    let bid_chunks = execution_payload_bid_chunks(signed_bid[0])?;
    let bid_signature_root = byte_vector_root(signed_bid[1]);
    let roots = vec![
        byte_vector_root(f[0]),
        eth1_data_root(f[1]),
        chunk32(f[2]),
        fixed_progressive_list(f[3], 416, |item| {
            hash_pair(&signed_header_root(&item[0..208]), &signed_header_root(&item[208..416]))
        })?,
        variable_progressive_list(f[4], attester_slashing_root)?,
        variable_progressive_list(f[5], attestation_root)?,
        fixed_progressive_list(f[6], 1240, deposit_root)?,
        fixed_progressive_list(f[7], 112, signed_voluntary_exit_root)?,
        hash_pair(&merkleize(&pack_bytes(&f[8][0..64])), &byte_vector_root(&f[8][64..160])),
        fixed_progressive_list(f[9], 172, signed_bls_change_root)?,
        hash_pair(&progressive_container_root(&bid_chunks), &bid_signature_root),
        fixed_progressive_list(f[11], 202, payload_attestation_root)?,
        execution_requests_root(f[12])?,
    ];
    Ok((roots, bid_chunks, bid_signature_root))
}

/// Parses and hashes a Gloas `SignedBeaconBlock`, for bytes that a remote node served.
///
/// # Errors
/// `MalformedSsz` when the bytes break an SSZ rule.
pub fn try_parse_gloas_signed_block(bytes: &[u8]) -> Result<ParsedGloasBlock> {
    use Kind::{Fixed, Variable};
    let outer = split_container(bytes, &[Variable, Fixed(96)])?;
    let block = split_container(outer[0], &[Fixed(8), Fixed(8), Fixed(32), Fixed(32), Variable])?;
    let (body_field_roots, bid_chunks, bid_signature_root) = body_roots(block[4])?;
    let header = BeaconBlockHeader {
        slot: le_u64(block[0]),
        proposer_index: le_u64(block[1]),
        parent_root: chunk32(block[2]),
        state_root: chunk32(block[3]),
        body_root: progressive_container_root(&body_field_roots),
    };
    Ok(ParsedGloasBlock { header, body_field_roots, bid_chunks, bid_signature_root })
}
