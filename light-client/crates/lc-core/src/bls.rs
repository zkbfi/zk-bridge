//! BLS12-381 `FastAggregateVerify` for sync committee signatures, with the signer key taken from the committee aggregate.
//!
//! Ciphersuite: `BLS_SIG_BLS12381G2_XMD:SHA-256_SSWU_RO_POP_` (consensus-specs `specs/phase0/beacon-chain.md`,
//! section "BLS signatures"). Public keys live in G1 (48 bytes compressed), signatures in G2 (96 bytes compressed).
//!
//! Crate choice: `bls12_381` 0.8.0 (zkcrypto). Succinct patches this exact version for SP1
//! (tag `patch-bls12_381-0.8.0-sp1-6.0.0`, the crates.io line), so the same source runs with precompiles in a guest.
//! The `experimental` feature supplies hash-to-curve. The crates.io release needs `digest` 0.9, hence `sha2` 0.9.9.
//! The SP1 patch needs `digest` 0.10, so inside the zkVM the hash-to-curve hash is `sha2` 0.10.9 (also patched).

use crate::chain::SYNC_COMMITTEE_SIZE;
use crate::error::{Error, Result};
use crate::profile::tracked;
use crate::types::BlsPublicKey;
use alloy_primitives::B256;
use bls12_381::hash_to_curve::{ExpandMsgXmd, HashToCurve};
use bls12_381::{multi_miller_loop, G1Affine, G1Projective, G2Affine, G2Prepared, G2Projective, Gt};
#[cfg(not(target_os = "zkvm"))]
use sha2::Sha256;
#[cfg(target_os = "zkvm")]
use sha2_digest10::Sha256;

/// The domain separation tag of the proof-of-possession ciphersuite.
pub const BLS_DST: &[u8] = b"BLS_SIG_BLS12381G2_XMD:SHA-256_SSWU_RO_POP_";

/// The index that `InvalidPublicKey` reports for the aggregate public key of a committee: one past the last member.
pub const AGGREGATE_KEY_INDEX: usize = SYNC_COMMITTEE_SIZE;

/// The compressed encoding of the point at infinity: the compression and infinity flags, then zeros.
const COMPRESSED_IDENTITY: [u8; 48] = {
    let mut bytes = [0u8; 48];
    bytes[0] = 0xc0;
    bytes
};

/// Decompresses a public key. It rejects invalid encodings, points outside the subgroup and the identity.
fn decode_public_key(bytes: &BlsPublicKey, index: usize) -> Result<G1Projective> {
    let point =
        Option::<G1Affine>::from(G1Affine::from_compressed(&bytes.0)).ok_or(Error::InvalidPublicKey { index })?;
    if bool::from(point.is_identity()) {
        return Err(Error::InvalidPublicKey { index });
    }
    Ok(G1Projective::from(point))
}

/// Hashes the signing root to a point of G2. The crates.io release takes one byte string.
#[cfg(not(target_os = "zkvm"))]
fn hash_message_to_curve(message: &B256) -> G2Projective {
    <G2Projective as HashToCurve<ExpandMsgXmd<Sha256>>>::hash_to_curve(message.as_slice(), BLS_DST)
}

/// Hashes the signing root to a point of G2. The SP1 patch takes a list of byte chunks, so the message is one chunk.
#[cfg(target_os = "zkvm")]
fn hash_message_to_curve(message: &B256) -> G2Projective {
    <G2Projective as HashToCurve<ExpandMsgXmd<Sha256>>>::hash_to_curve([message.as_slice()], BLS_DST)
}

/// Verifies an aggregate signature over `message` by every member of a committee except the members at `absent_indices`.
///
/// The public key of the signers is `aggregate_pubkey` minus the keys of the absent members. A committee has 512
/// members and at least 342 sign, so this decompresses at most 170 keys where a sum over the signers needs 342 or more.
///
/// Why `aggregate_pubkey` can be trusted: it is a field of `SyncCommittee`, and the committee hash covers it. The
/// contract binds that hash (`previousSyncCommitteeHash`, `syncCommitteeHash`), so a committee with a made-up
/// `aggregate_pubkey` has a hash that the contract refuses. An honest chain always sets `aggregate_pubkey` to the sum
/// of the 512 keys. This function does not check that equality, so the claim rests on the committee root.
/// The keys of the signers are not decompressed. A signer key is refused only when it is the encoding of the point at
/// infinity, which needs no decompression. A signer key that is otherwise not a valid point goes unnoticed.
///
/// The check is one product of two pairings with one final exponentiation:
/// `e(signers, message_point) * e(-generator, signature) == 1`, which is `e(signers, message_point) == e(generator, signature)`.
///
/// # Errors
/// `InvalidPublicKey` for an identity key, and for an absent key or the aggregate key that is not a valid point (the
/// aggregate key has index [`AGGREGATE_KEY_INDEX`]). `InvalidSignatureEncoding` for a malformed signature.
/// `SignatureVerificationFailed` when the pairing equation does not hold, when nobody signs, and when the keys of the
/// signers add up to the point at infinity.
///
/// # Panics
/// When an index of `absent_indices` is not an index of `public_keys`.
pub fn verify_aggregate_by_subtraction(
    aggregate_pubkey: &BlsPublicKey,
    public_keys: &[BlsPublicKey],
    absent_indices: &[usize],
    message: &B256,
    signature: &[u8; 96],
) -> Result<()> {
    if absent_indices.len() >= public_keys.len() {
        return Err(Error::SignatureVerificationFailed);
    }
    let (committee_key, absent) = tracked("decompress_pubkeys", || {
        if let Some(index) = public_keys.iter().position(|key| key.0 == COMPRESSED_IDENTITY) {
            return Err(Error::InvalidPublicKey { index });
        }
        let committee_key = decode_public_key(aggregate_pubkey, AGGREGATE_KEY_INDEX)?;
        let absent = absent_indices
            .iter()
            .map(|index| decode_public_key(&public_keys[*index], *index))
            .collect::<Result<Vec<_>>>()?;
        Ok((committee_key, absent))
    })?;
    let signer_key =
        tracked("aggregate_pubkeys", || absent.iter().fold(committee_key, |remaining, key| remaining - key));
    if bool::from(signer_key.is_identity()) {
        return Err(Error::SignatureVerificationFailed);
    }
    let signature_point = tracked("decompress_signature", || {
        Option::<G2Affine>::from(G2Affine::from_compressed(signature)).ok_or(Error::InvalidSignatureEncoding)
    })?;
    let message_point = tracked("hash_to_curve", || G2Affine::from(hash_message_to_curve(message)));
    let signer_affine = G1Affine::from(signer_key);
    let negated_generator = -G1Affine::generator();
    let verified = tracked("pairing", || {
        let message_prepared = G2Prepared::from(message_point);
        let signature_prepared = G2Prepared::from(signature_point);
        let product =
            multi_miller_loop(&[(&signer_affine, &message_prepared), (&negated_generator, &signature_prepared)]);
        product.final_exponentiation() == Gt::identity()
    });
    if verified {
        return Ok(());
    }
    Err(Error::SignatureVerificationFailed)
}
