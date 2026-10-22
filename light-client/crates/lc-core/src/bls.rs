//! BLS12-381 `FastAggregateVerify` for sync committee signatures.
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
use crate::types::BlsPublicKey;
use alloy_primitives::B256;
use bls12_381::hash_to_curve::{ExpandMsgXmd, HashToCurve};
use bls12_381::{pairing, G1Affine, G1Projective, G2Affine, G2Projective};
#[cfg(not(target_os = "zkvm"))]
use sha2::Sha256;
#[cfg(target_os = "zkvm")]
use sha2_digest10::Sha256;

/// The domain separation tag of the proof-of-possession ciphersuite.
pub const BLS_DST: &[u8] = b"BLS_SIG_BLS12381G2_XMD:SHA-256_SSWU_RO_POP_";

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

/// Verifies an aggregate signature over `message` by all `public_keys`.
///
/// # Errors
/// `InvalidPublicKey`, `InvalidSignatureEncoding` for malformed inputs and `SignatureVerificationFailed`
/// when the pairing equation does not hold. An empty key list is rejected as `SignatureVerificationFailed`.
pub fn fast_aggregate_verify(public_keys: &[BlsPublicKey], message: &B256, signature: &[u8; 96]) -> Result<()> {
    if public_keys.is_empty() || public_keys.len() > SYNC_COMMITTEE_SIZE {
        return Err(Error::SignatureVerificationFailed);
    }
    let mut aggregate = G1Projective::identity();
    for (index, key) in public_keys.iter().enumerate() {
        aggregate += decode_public_key(key, index)?;
    }
    let signature_point =
        Option::<G2Affine>::from(G2Affine::from_compressed(signature)).ok_or(Error::InvalidSignatureEncoding)?;
    let message_point = G2Affine::from(hash_message_to_curve(message));
    let left = pairing(&G1Affine::from(aggregate), &message_point);
    let right = pairing(&G1Affine::generator(), &signature_point);
    if left == right {
        return Ok(());
    }
    Err(Error::SignatureVerificationFailed)
}
