//! The key of the oracle backend, which signs proofs for the development verifier (`OracleSP1Verifier`).
//!
//! The crate sends no transaction, so it holds no wallet and no keystore. The one key it can hold is the oracle key,
//! and it reads that key from an environment variable that the configuration names. The command line, the
//! configuration file and the logs never carry it. A key lives in a [`Signer`], whose `Debug` output shows the
//! address only.

use crate::error::{Error, Result};
use alloy_primitives::{keccak256, Address, B256};
use k256::ecdsa::SigningKey;
use std::fmt;

/// A secp256k1 key and its address.
#[derive(Clone)]
pub struct Signer {
    key: SigningKey,
    address: Address,
}

impl fmt::Debug for Signer {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(formatter, "Signer({})", self.address)
    }
}

/// A signature with the recovery identifier.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct RecoverableSignature {
    /// The `r` value.
    pub r: B256,
    /// The `s` value. It is in the lower half of the curve order.
    pub s: B256,
    /// The recovery identifier, 0 or 1.
    pub recovery_id: u8,
}

impl RecoverableSignature {
    /// The 65 bytes `r ‖ s ‖ v` with `v` equal to 27 or 28, the layout that `ecrecover` and OpenZeppelin `ECDSA` read.
    pub fn to_65_bytes(&self) -> [u8; 65] {
        let mut bytes = [0u8; 65];
        bytes[..32].copy_from_slice(self.r.as_slice());
        bytes[32..64].copy_from_slice(self.s.as_slice());
        bytes[64] = 27 + self.recovery_id;
        bytes
    }
}

/// The address of a verifying key: the last 20 bytes of the keccak256 of its uncompressed point without the prefix.
fn address_of(key: &k256::ecdsa::VerifyingKey) -> Address {
    let point = key.to_encoded_point(false);
    Address::from_slice(&keccak256(&point.as_bytes()[1..])[12..])
}

impl Signer {
    /// Builds a signer from 32 secret bytes.
    ///
    /// # Errors
    /// `Error::Signer` when the bytes are not a valid secp256k1 secret.
    pub fn from_secret_bytes(bytes: &[u8]) -> Result<Self> {
        let key = SigningKey::from_slice(bytes)
            .map_err(|_| Error::Signer("not a valid secp256k1 secret".into()))?;
        let address = address_of(key.verifying_key());
        Ok(Self { key, address })
    }

    /// Reads a hex secret (with or without `0x`) from the environment variable `name`.
    ///
    /// Only for the oracle backend, which only a development verifier accepts: the configuration refuses that backend
    /// for a destination that is not a local chain (see `config.rs`).
    ///
    /// # Errors
    /// `Error::Signer` when the variable is missing or is not 32 bytes of hex. The message never holds the value.
    pub fn from_environment(name: &str, lookup: &dyn Fn(&str) -> Option<String>) -> Result<Self> {
        let value = lookup(name)
            .ok_or_else(|| Error::Signer(format!("environment variable {name} is not set")))?;
        let bytes = alloy_primitives::hex::decode(value.trim())
            .map_err(|_| Error::Signer(format!("environment variable {name} is not hex")))?;
        Self::from_secret_bytes(&bytes)
            .map_err(|_| Error::Signer(format!("environment variable {name} is not a key")))
    }

    /// The address that the key controls.
    pub fn address(&self) -> Address {
        self.address
    }

    /// Signs a 32-byte digest (no prefix, no extra hashing). The signature has a low `s` value.
    ///
    /// # Errors
    /// `Error::Signer` when the signing library fails.
    pub fn sign_digest(&self, digest: &B256) -> Result<RecoverableSignature> {
        let (signature, recovery) = self
            .key
            .sign_prehash_recoverable(digest.as_slice())
            .map_err(|error| Error::Signer(format!("signing failed: {error}")))?;
        let (signature, recovery_id) = match signature.normalize_s() {
            Some(normalized) => (normalized, recovery.to_byte() ^ 1),
            None => (signature, recovery.to_byte()),
        };
        let bytes = signature.to_bytes();
        Ok(RecoverableSignature {
            r: B256::from_slice(&bytes[..32]),
            s: B256::from_slice(&bytes[32..]),
            recovery_id,
        })
    }
}

/// Recovers the address that signed `digest`. Tests use it to check the oracle signature.
///
/// # Errors
/// `Error::Signer` when the signature does not recover.
pub fn recover_address(digest: &B256, signature: &RecoverableSignature) -> Result<Address> {
    let mut bytes = [0u8; 64];
    bytes[..32].copy_from_slice(signature.r.as_slice());
    bytes[32..].copy_from_slice(signature.s.as_slice());
    let parsed = k256::ecdsa::Signature::from_slice(&bytes)
        .map_err(|error| Error::Signer(error.to_string()))?;
    let recovery = k256::ecdsa::RecoveryId::from_byte(signature.recovery_id)
        .ok_or_else(|| Error::Signer("bad recovery id".into()))?;
    let key = k256::ecdsa::VerifyingKey::recover_from_prehash(digest.as_slice(), &parsed, recovery)
        .map_err(|error| Error::Signer(error.to_string()))?;
    Ok(address_of(&key))
}

#[cfg(test)]
mod tests {
    use super::*;
    use alloy_primitives::address;

    /// The first Anvil development secret. It is public and holds no value outside local test chains.
    const ANVIL_SECRET: &str = "ac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80";

    fn anvil_signer() -> Signer {
        Signer::from_secret_bytes(&alloy_primitives::hex::decode(ANVIL_SECRET).unwrap()).unwrap()
    }

    /// Claim: the well-known Anvil secret gives the well-known Anvil address, and `Debug` hides the secret.
    /// Why it matters: the address derivation feeds the transaction sender and the oracle address.
    #[test]
    fn anvil_secret_gives_anvil_address() {
        let signer = anvil_signer();
        assert_eq!(
            signer.address(),
            address!("f39Fd6e51aad88F6F4ce6aB8827279cffFb92266")
        );
        assert!(!format!("{signer:?}").contains(ANVIL_SECRET));
    }

    /// Claim: a signature recovers to the signer, its `s` is low and its `v` is 27 or 28.
    /// Why it matters: OpenZeppelin `ECDSA` rejects high `s`, and `ecrecover` needs `v` of 27 or 28.
    #[test]
    fn signature_recovers_with_low_s() {
        let signer = anvil_signer();
        for seed in 0u8..20 {
            let digest = keccak256([seed]);
            let signature = signer.sign_digest(&digest).unwrap();
            assert_eq!(
                recover_address(&digest, &signature).unwrap(),
                signer.address()
            );
            let parsed = k256::ecdsa::Signature::from_slice(
                &[signature.r.as_slice(), signature.s.as_slice()].concat(),
            )
            .unwrap();
            assert!(parsed.normalize_s().is_none(), "s must already be low");
            assert!(matches!(signature.to_65_bytes()[64], 27 | 28));
        }
    }

    /// Claim: a variable that is missing or malformed gives an error that does not echo the value.
    /// Why it matters: error text reaches logs.
    #[test]
    fn environment_errors_never_echo_the_value() {
        let secret = "not-a-key-but-secret-looking";
        let lookup = |_: &str| Some(secret.to_string());
        let error = Signer::from_environment("SOME_NAME", &lookup).unwrap_err();
        assert!(!error.to_string().contains(secret));
        assert!(Signer::from_environment("SOME_NAME", &|_: &str| None).is_err());
    }
}
