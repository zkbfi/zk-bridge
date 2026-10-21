//! Signing keys: a Foundry keystore with a password file, or an environment variable for local Anvil.
//!
//! The service never accepts a key on the command line, in the configuration file, or in a log line.
//! A key lives in a [`Signer`], whose `Debug` output shows the address only.

use crate::error::{Error, Result};
use aes::cipher::{KeyIvInit, StreamCipher};
use alloy_primitives::{keccak256, Address, B256};
use k256::ecdsa::SigningKey;
use serde_json::Value;
use std::fmt;
use std::path::Path;

type Aes128Ctr = ctr::Ctr128BE<aes::Aes128>;

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
        let key = SigningKey::from_slice(bytes).map_err(|_| Error::Signer("not a valid secp256k1 secret".into()))?;
        let address = address_of(key.verifying_key());
        Ok(Self { key, address })
    }

    /// Reads a hex secret (with or without `0x`) from the environment variable `name`.
    ///
    /// Only for local Anvil: the caller checks that every RPC URL is a loopback address (see `config.rs`).
    ///
    /// # Errors
    /// `Error::Signer` when the variable is missing or is not 32 bytes of hex. The message never holds the value.
    pub fn from_environment(name: &str, lookup: &dyn Fn(&str) -> Option<String>) -> Result<Self> {
        let value = lookup(name).ok_or_else(|| Error::Signer(format!("environment variable {name} is not set")))?;
        let bytes = alloy_primitives::hex::decode(value.trim())
            .map_err(|_| Error::Signer(format!("environment variable {name} is not hex")))?;
        Self::from_secret_bytes(&bytes).map_err(|_| Error::Signer(format!("environment variable {name} is not a key")))
    }

    /// Decrypts a Web3 Secret Storage version 3 keystore (the Foundry format: scrypt and AES-128-CTR).
    ///
    /// # Errors
    /// `Error::Signer` for a wrong password, an unsupported key derivation, or a malformed file.
    pub fn from_keystore(keystore_path: &Path, password_path: &Path) -> Result<Self> {
        let text = std::fs::read_to_string(keystore_path)
            .map_err(|error| Error::Signer(format!("cannot read the keystore {}: {error}", keystore_path.display())))?;
        let password = std::fs::read_to_string(password_path).map_err(|error| {
            Error::Signer(format!("cannot read the password file {}: {error}", password_path.display()))
        })?;
        Self::from_keystore_text(&text, password.trim_end_matches(['\n', '\r']))
    }

    /// Decrypts keystore text with a password. See [`Signer::from_keystore`].
    ///
    /// # Errors
    /// `Error::Signer` for a wrong password, an unsupported key derivation, or a malformed document.
    pub fn from_keystore_text(text: &str, password: &str) -> Result<Self> {
        let document: Value =
            serde_json::from_str(text).map_err(|error| Error::Signer(format!("keystore is not JSON: {error}")))?;
        let crypto = document.get("crypto").or_else(|| document.get("Crypto")).ok_or_else(|| missing("crypto"))?;
        if crypto["kdf"].as_str() != Some("scrypt") {
            return Err(Error::Signer("only scrypt keystores are supported".into()));
        }
        if crypto["cipher"].as_str() != Some("aes-128-ctr") {
            return Err(Error::Signer("only aes-128-ctr keystores are supported".into()));
        }
        let params = &crypto["kdfparams"];
        let number = |name: &str| params[name].as_u64().ok_or_else(|| missing(name));
        let (n, r, p, derived_length) = (number("n")?, number("r")?, number("p")?, number("dklen")?);
        if !n.is_power_of_two() || derived_length != 32 {
            return Err(Error::Signer("unsupported scrypt parameters".into()));
        }
        let salt = hex_field(&params["salt"], "salt")?;
        let iv = hex_field(&crypto["cipherparams"]["iv"], "iv")?;
        let ciphertext = hex_field(&crypto["ciphertext"], "ciphertext")?;
        let mac = hex_field(&crypto["mac"], "mac")?;

        let scrypt_params = scrypt::Params::new(n.trailing_zeros() as u8, r as u32, p as u32, 32)
            .map_err(|error| Error::Signer(format!("scrypt parameters: {error}")))?;
        let mut derived = [0u8; 32];
        scrypt::scrypt(password.as_bytes(), &salt, &scrypt_params, &mut derived)
            .map_err(|error| Error::Signer(format!("scrypt: {error}")))?;

        let mut mac_input = derived[16..32].to_vec();
        mac_input.extend_from_slice(&ciphertext);
        if keccak256(&mac_input).as_slice() != mac.as_slice() {
            return Err(Error::Signer("wrong password or damaged keystore".into()));
        }
        let mut secret = ciphertext;
        let mut cipher = Aes128Ctr::new_from_slices(&derived[..16], &iv)
            .map_err(|_| Error::Signer("bad cipher key or iv length".into()))?;
        cipher.apply_keystream(&mut secret);
        Self::from_secret_bytes(&secret)
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

fn missing(name: &str) -> Error {
    Error::Signer(format!("keystore field {name} is missing or has the wrong type"))
}

fn hex_field(value: &Value, name: &str) -> Result<Vec<u8>> {
    let text = value.as_str().ok_or_else(|| missing(name))?;
    alloy_primitives::hex::decode(text).map_err(|_| Error::Signer(format!("keystore field {name} is not hex")))
}

/// Recovers the address that signed `digest`. Used by tests and by the transaction checks.
///
/// # Errors
/// `Error::Signer` when the signature does not recover.
pub fn recover_address(digest: &B256, signature: &RecoverableSignature) -> Result<Address> {
    let mut bytes = [0u8; 64];
    bytes[..32].copy_from_slice(signature.r.as_slice());
    bytes[32..].copy_from_slice(signature.s.as_slice());
    let parsed = k256::ecdsa::Signature::from_slice(&bytes).map_err(|error| Error::Signer(error.to_string()))?;
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
        assert_eq!(signer.address(), address!("f39Fd6e51aad88F6F4ce6aB8827279cffFb92266"));
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
            assert_eq!(recover_address(&digest, &signature).unwrap(), signer.address());
            let parsed =
                k256::ecdsa::Signature::from_slice(&[signature.r.as_slice(), signature.s.as_slice()].concat()).unwrap();
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

    /// Claim: a keystore made with the Web3 Secret Storage recipe decrypts with the right password and fails with
    /// a wrong one. The test builds the keystore with the same primitives in the opposite direction.
    /// Why it matters: a wrong password must never produce a different valid key.
    #[test]
    fn keystore_roundtrip_and_wrong_password() {
        let secret = alloy_primitives::hex::decode(ANVIL_SECRET).unwrap();
        let text = test_keystore(&secret, "correct horse", 1 << 10);
        let signer = Signer::from_keystore_text(&text, "correct horse").unwrap();
        assert_eq!(signer.address(), anvil_signer().address());
        let error = Signer::from_keystore_text(&text, "wrong").unwrap_err();
        assert!(error.to_string().contains("wrong password"));
    }

    /// Claim: a keystore that Foundry `cast wallet new` wrote (with a password file that ends in a newline) decrypts
    /// to the address that `cast` printed when it made the file.
    /// Why it matters: the roundtrip test uses our own encryption. This one uses an independent implementation, so a
    /// shared mistake in our encrypt and decrypt code cannot hide.
    #[test]
    fn foundry_keystore_decrypts_to_the_address_cast_printed() {
        let directory = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures");
        let signer = Signer::from_keystore(
            &directory.join("foundry-keystore.json"),
            &directory.join("foundry-keystore.password"),
        )
        .unwrap();
        assert_eq!(signer.address(), address!("1e01c40fA71113192e0AA8FEEc936c0Dda4b9c21"));
    }

    /// Builds a version 3 keystore for tests.
    pub(crate) fn test_keystore(secret: &[u8], password: &str, n: u64) -> String {
        let salt = [7u8; 32];
        let iv = [9u8; 16];
        let params = scrypt::Params::new(n.trailing_zeros() as u8, 8, 1, 32).unwrap();
        let mut derived = [0u8; 32];
        scrypt::scrypt(password.as_bytes(), &salt, &params, &mut derived).unwrap();
        let mut ciphertext = secret.to_vec();
        Aes128Ctr::new_from_slices(&derived[..16], &iv).unwrap().apply_keystream(&mut ciphertext);
        let mut mac_input = derived[16..].to_vec();
        mac_input.extend_from_slice(&ciphertext);
        let mac = keccak256(&mac_input);
        serde_json::json!({
            "version": 3,
            "crypto": {
                "cipher": "aes-128-ctr",
                "cipherparams": {"iv": alloy_primitives::hex::encode(iv)},
                "ciphertext": alloy_primitives::hex::encode(&ciphertext),
                "kdf": "scrypt",
                "kdfparams": {"dklen": 32, "n": n, "p": 1, "r": 8, "salt": alloy_primitives::hex::encode(salt)},
                "mac": alloy_primitives::hex::encode(mac),
            }
        })
        .to_string()
    }
}
