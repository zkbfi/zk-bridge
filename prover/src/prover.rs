//! The proving backends. Only light-client updates are proven: a withdrawal needs no proof, because the vault
//! checks the evidence directly.
//!
//! - [`OracleProver`] is for development and tests. It runs the program natively first and refuses to sign when
//!   that fails. Then it signs `keccak256(programVKey ‖ sha256(publicValues))`, which `OracleSP1Verifier` accepts.
//!   It models a sound proof system: a proof exists only when the reference program accepts the statement.
//! - `Sp1Prover` is for production. It is behind the cargo feature `sp1`, which is off by default.
//!
//! # Enabling the `sp1` feature
//!
//! The feature compiles a stub that names what is missing. To make it real, on a machine that has the SP1
//! toolchain (installed by the operator from Succinct's signed releases, never with a pipe to a shell):
//!
//! 1. Add `sp1-sdk = { version = "=<exact version>", optional = true }` to `Cargo.toml`, with a version published
//!    at least 28 days ago, and change the feature to `sp1 = ["dep:sp1-sdk"]`. Run
//!    `scripts/check-crate-ages.sh` until it reports no crate that is too new.
//! 2. Build the guest in `light-client/guests/light-client` and point `[prover] sp1_elf_path` at the ELF.
//! 3. Implement `Sp1Prover::prove`: write [`crate::light_client::guest_input_bytes`] to the SP1 stdin, call
//!    `prove(...).groth16()` (locally, or with `SP1_PROVER=network` and a network key from the environment of the
//!    process), and return the proof bytes and the public values of the proof.
//! 4. Deploy the light client with the real SP1 verifier of that program version, not the oracle verifier, and
//!    set `[prover] program_vkey` to the key of the ELF.
//!
//! `cargo check --features sp1` compiles the stub on any machine.

#[cfg(feature = "sp1")]
use crate::error::Error;
use crate::error::Result;
use crate::light_client::{public_values, sha256, verify_update_natively, LightClientOutput, UpdateInput};
use crate::signer::Signer;
use alloy_primitives::{keccak256, B256};

/// What a backend is asked to prove.
#[derive(Clone, Debug)]
pub enum ProofStatement {
    /// A real update: the program runs natively on it first.
    Verified(UpdateInput),
    /// An output that `DevBeaconSource` asserts on Anvil. No sync committee exists there, so there is nothing to
    /// run the program on. The source's depth rule stands in for finality.
    DevAsserted(LightClientOutput),
}

/// A proof and the public values it commits to.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Proof {
    /// The ABI-encoded `LightClientOutput`.
    pub public_values: Vec<u8>,
    /// The bytes the verifier contract reads.
    pub proof_bytes: Vec<u8>,
}

/// One proving backend.
pub trait Prover: Send + Sync {
    /// The name that logs show.
    fn name(&self) -> &'static str;

    /// Proves a statement for the program with key `program_vkey`.
    ///
    /// # Errors
    /// `Error::VerificationRefused` when the program rejects the statement. `Error::Prover` when the backend cannot
    /// prove this kind of statement.
    fn prove(&self, program_vkey: B256, statement: &ProofStatement) -> Result<Proof>;
}

/// The digest that `OracleSP1Verifier.verifyProof` recovers a signer from:
/// `keccak256(abi.encodePacked(programVKey, sha256(publicValues)))`, with no message prefix.
pub fn oracle_digest(program_vkey: B256, public_values: &[u8]) -> B256 {
    let mut packed = Vec::with_capacity(64);
    packed.extend_from_slice(program_vkey.as_slice());
    packed.extend_from_slice(sha256(public_values).as_slice());
    keccak256(packed)
}

/// The development backend. It signs with the oracle key.
pub struct OracleProver {
    oracle: Signer,
}

impl OracleProver {
    /// A prover that signs with `oracle`. The verifier contract must be deployed with this address.
    pub fn new(oracle: Signer) -> Self {
        Self { oracle }
    }
}

impl Prover for OracleProver {
    fn name(&self) -> &'static str {
        "oracle"
    }

    fn prove(&self, program_vkey: B256, statement: &ProofStatement) -> Result<Proof> {
        let output = match statement {
            ProofStatement::Verified(input) => verify_update_natively(input)?,
            ProofStatement::DevAsserted(output) => output.clone(),
        };
        let public_values = public_values(&output);
        let signature = self.oracle.sign_digest(&oracle_digest(program_vkey, &public_values))?;
        Ok(Proof { public_values, proof_bytes: signature.to_65_bytes().to_vec() })
    }
}

/// The production backend. See the module documentation for how to enable it.
#[cfg(feature = "sp1")]
pub struct Sp1Prover {
    /// The path of the compiled guest program.
    pub elf_path: std::path::PathBuf,
}

#[cfg(feature = "sp1")]
impl Prover for Sp1Prover {
    fn name(&self) -> &'static str {
        "sp1"
    }

    fn prove(&self, _program_vkey: B256, statement: &ProofStatement) -> Result<Proof> {
        match statement {
            ProofStatement::DevAsserted(_) => {
                Err(Error::Prover("a development statement has no real proof; use the oracle backend on Anvil".into()))
            }
            ProofStatement::Verified(input) => {
                verify_update_natively(input)?;
                // TODO(sp1): write `guest_input_bytes(input)` to the SP1 stdin and prove. See the module docs.
                Err(Error::Prover(format!(
                    "the sp1 backend is a stub: the sp1-sdk crate is not linked (elf {})",
                    self.elf_path.display()
                )))
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::error::Error;
    use crate::light_client::ChainKind;
    use alloy_primitives::hex;
    use lc_testkit::synthetic::{build_update, UpdateRecipe};

    const ANVIL_SECRET: &str = "ac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80";

    fn oracle() -> Signer {
        Signer::from_secret_bytes(&hex::decode(ANVIL_SECRET).unwrap()).unwrap()
    }

    fn scenario(participants: usize) -> UpdateInput {
        let chain = ChainKind::Pulsechain;
        let built = build_update(
            chain.spec(),
            UpdateRecipe {
                store_slot: 8_300,
                finalized_slot: 8_400,
                attested_slot: 8_500,
                signature_slot: 8_501,
                participants,
                include_next_committee: true,
                store_knows_next_committee: true,
            },
        );
        UpdateInput { chain, store: built.store, updates: vec![built.update] }
    }

    /// Claim: the digest is `keccak256(vkey ‖ sha256(publicValues))`, built from independent pieces.
    /// Why it matters: `OracleSP1Verifier` recomputes exactly this digest. The integration test
    /// `oracle_signature_is_accepted_by_the_solidity_mock` runs the Solidity side.
    #[test]
    fn oracle_digest_is_keccak_of_key_and_sha256() {
        let values = vec![1u8, 2, 3];
        let sha = <sha2_digest::Sha>::of(&values);
        let mut packed = vec![0x11u8; 32];
        packed.extend_from_slice(&sha);
        assert_eq!(oracle_digest(B256::repeat_byte(0x11), &values), keccak256(&packed));
    }

    /// Claim: a valid update gives public values of 352 bytes and a 65-byte signature that recovers to the oracle.
    /// Why it matters: this is the byte layout that the contract and the verifier check.
    #[test]
    fn valid_update_is_signed_by_the_oracle() {
        let prover = OracleProver::new(oracle());
        let vkey = B256::repeat_byte(0x42);
        let proof = prover.prove(vkey, &ProofStatement::Verified(scenario(400))).expect("proof");
        assert_eq!(proof.public_values.len(), 352);
        assert_eq!(proof.proof_bytes.len(), 65);
        let signature = crate::signer::RecoverableSignature {
            r: B256::from_slice(&proof.proof_bytes[..32]),
            s: B256::from_slice(&proof.proof_bytes[32..64]),
            recovery_id: proof.proof_bytes[64] - 27,
        };
        let recovered =
            crate::signer::recover_address(&oracle_digest(vkey, &proof.public_values), &signature).unwrap();
        assert_eq!(recovered, oracle().address());
    }

    /// Claim: with 341 of 512 signers (one below two thirds) the prover refuses and returns no signature.
    /// Why it matters: the oracle models a sound proof system. It must never sign a statement the program rejects.
    #[test]
    fn prover_refuses_to_sign_when_native_verification_fails() {
        let prover = OracleProver::new(oracle());
        let error = prover.prove(B256::repeat_byte(0x42), &ProofStatement::Verified(scenario(341))).unwrap_err();
        assert!(matches!(error, Error::VerificationRefused(_)), "got {error}");
    }

    /// A tiny wrapper so the digest test does not call the module under test for the SHA-256 value.
    mod sha2_digest {
        pub struct Sha;
        impl Sha {
            pub fn of(data: &[u8]) -> [u8; 32] {
                // SHA-256 of [1, 2, 3], computed with `shasum -a 256` for the fixed input below.
                assert_eq!(data, [1u8, 2, 3]);
                alloy_primitives::hex::decode("039058c6f2c0cb492c533b0a4d14ef77cc0f78abccced5287d84a1a2011cfb81")
                    .unwrap()
                    .try_into()
                    .unwrap()
            }
        }
    }
}
