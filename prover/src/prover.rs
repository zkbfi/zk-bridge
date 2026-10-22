//! The proving backends. Only light-client updates are proven: a withdrawal needs no proof, because the vault
//! checks the evidence directly.
//!
//! - [`OracleProver`] is for development and tests. It runs the program natively first and refuses to sign when
//!   that fails. Then it signs `keccak256(programVKey ‖ sha256(publicValues))`, which `OracleSP1Verifier` accepts.
//!   It models a sound proof system: a proof exists only when the reference program accepts the statement.
//! - `Sp1Prover` is for production. It is behind the cargo feature `sp1`, which is off by default.
//!
//! # The `sp1` feature
//!
//! `Sp1Prover` proves on the local CPU with the `sp1-sdk` crate (exact version 6.8.1, no network prover, no API
//! keys). Build with `cargo build --release --features sp1` (see `docs/server-prover.md`). The steps:
//!
//! 1. Build both guests reproducibly with `light-client/scripts/program-keys.sh`. Its keys are in
//!    `light-client/program-keys.json`.
//! 2. Set `[prover] sp1_elf_path` (light client) and `sp1_observation_elf_path` (fork observation).
//! 3. At startup the service compares the key of each ELF with the key that the contract stores, and it refuses to
//!    run when they differ (`Prover::require_program_key`, called from `route.rs`).
//! 4. Each proof runs the program natively first, proves in Groth16 mode, and checks that the proven public values
//!    equal the native ones. The proof bytes are `selector ‖ proof`, which `SP1VerifierGroth16.verifyProof` reads.

use crate::error::{Error, Result};
use crate::light_client::{
    public_values, sha256, verify_observation_natively, verify_update_natively, LightClientOutput,
    UpdateInput,
};
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
    /// A fork observation: the bytes that the fork observation guest reads. The program runs natively on it first.
    Observation(Vec<u8>),
    /// Public values of a fork observation that a test asserts. The fixtures of the light client hold public values
    /// and no committee data, so there is nothing to run the program on. Like `DevAsserted`, this is for Anvil only.
    ObservationAsserted(Vec<u8>),
}

/// A proof and the public values it commits to.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Proof {
    /// The ABI-encoded public values: a `LightClientOutput`, or a `ForkObservation` for an observation statement.
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

    /// Checks the program a backend would run against the key that the destination contract stores.
    /// The service calls it at startup with the key it read from the contract. A backend without a program of its own
    /// (the oracle) accepts every key.
    ///
    /// # Errors
    /// `Error::Config` when the backend runs a program whose key differs from `onchain_key`.
    fn require_program_key(&self, _program: ProgramKind, _onchain_key: B256) -> Result<()> {
        Ok(())
    }
}

/// Which guest program a key belongs to.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ProgramKind {
    /// The light-client program. The light client stores its key as `programVKey`.
    LightClient,
    /// The fork observation program. The fork registry stores its key as `observationProgramVKey`.
    ForkObservation,
}

impl ProgramKind {
    /// The name of the program in messages.
    pub fn label(self) -> &'static str {
        match self {
            Self::LightClient => "light client",
            Self::ForkObservation => "fork observation",
        }
    }
}

/// A prover that several routes share. The routes then load a backend only once.
impl Prover for std::sync::Arc<dyn Prover> {
    fn name(&self) -> &'static str {
        (**self).name()
    }

    fn prove(&self, program_vkey: B256, statement: &ProofStatement) -> Result<Proof> {
        (**self).prove(program_vkey, statement)
    }

    fn require_program_key(&self, program: ProgramKind, onchain_key: B256) -> Result<()> {
        (**self).require_program_key(program, onchain_key)
    }
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
        let public_values = match statement {
            ProofStatement::Verified(input) => public_values(&verify_update_natively(input)?),
            ProofStatement::DevAsserted(output) => public_values(output),
            ProofStatement::Observation(guest_input) => verify_observation_natively(guest_input)?,
            ProofStatement::ObservationAsserted(values) => values.clone(),
        };
        let signature = self
            .oracle
            .sign_digest(&oracle_digest(program_vkey, &public_values))?;
        Ok(Proof {
            public_values,
            proof_bytes: signature.to_65_bytes().to_vec(),
        })
    }
}

/// Fails unless the program key computed from an ELF equals the key that the destination contract stores.
///
/// `program` names the program in the message (`light client` or `fork observation`). The check compares the two
/// values only. The caller reads `onchain_key` from the contract (`programVKey()` on the light client,
/// `observationProgramVKey()` on the fork registry), never from its own configuration.
///
/// # Errors
/// `Error::Config` that shows both keys when they differ.
pub fn require_matching_key(program: &str, local_key: B256, onchain_key: B256) -> Result<()> {
    if local_key == onchain_key {
        return Ok(());
    }
    Err(Error::Config(format!(
        "the {program} ELF has program key {local_key:#x}, but the contract stores {onchain_key:#x}; \
         the prover refuses to run with an ELF the contract does not know"
    )))
}

/// The production backend: the SP1 prover on the local CPU, with Groth16 proofs. See the module documentation.
///
/// It loads two ELFs and computes their program keys once. A statement runs on the program that matches its kind.
#[cfg(feature = "sp1")]
pub struct Sp1Prover {
    client: sp1_sdk::blocking::CpuProver,
    light_client: Sp1Program,
    fork_observation: Option<Sp1Program>,
}

/// The paths of the compiled guest programs.
#[cfg(feature = "sp1")]
#[derive(Clone, Debug)]
pub struct Sp1ProgramPaths {
    /// The light-client guest ELF (`light-client/guests/light-client`).
    pub light_client: std::path::PathBuf,
    /// The fork observation guest ELF. Without it, the prover refuses observation statements.
    pub fork_observation: Option<std::path::PathBuf>,
}

/// One loaded guest: its proving key and the program key that the contracts store.
#[cfg(feature = "sp1")]
struct Sp1Program {
    proving_key: <sp1_sdk::blocking::CpuProver as sp1_sdk::blocking::Prover>::ProvingKey,
    program_key: B256,
}

/// What the SP1 executor reports for one run of a guest. No proof exists for it.
#[cfg(feature = "sp1")]
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Sp1Execution {
    /// The exit code of the guest. A guest that panics (a rejected input) exits with a code other than 0.
    pub exit_code: u64,
    /// The bytes the guest committed. Empty when the guest panicked before it committed.
    pub public_values: Vec<u8>,
    /// The number of instructions that the guest ran.
    pub instruction_count: u64,
}

/// The one CPU client of the process. Building a client starts its worker pools, so the process builds it once.
#[cfg(feature = "sp1")]
fn shared_client() -> &'static sp1_sdk::blocking::CpuProver {
    static CLIENT: std::sync::OnceLock<sp1_sdk::blocking::CpuProver> = std::sync::OnceLock::new();
    CLIENT.get_or_init(|| sp1_sdk::blocking::ProverClient::builder().cpu().build())
}

#[cfg(feature = "sp1")]
fn read_elf(path: &std::path::Path) -> Result<Vec<u8>> {
    std::fs::read(path)
        .map_err(|error| Error::Config(format!("cannot read the ELF {}: {error}", path.display())))
}

/// Runs a guest ELF in the SP1 executor on guest input bytes. It does not prove and does not compute a program key.
///
/// The input goes to the guest the way `sp1_zkvm::io::read_vec` reads it: one raw byte vector.
///
/// # Errors
/// `Error::Prover` when the executor itself fails (a corrupt ELF, for example). A guest that rejects its input is not
/// an error here: it returns an [`Sp1Execution`] with a non-zero `exit_code`.
#[cfg(feature = "sp1")]
pub fn execute_program(elf: &[u8], guest_input: &[u8]) -> Result<Sp1Execution> {
    use sp1_sdk::blocking::Prover as _;
    let mut stdin = sp1_sdk::SP1Stdin::new();
    stdin.write_vec(guest_input.to_vec());
    let (values, report) = shared_client()
        .execute(sp1_sdk::Elf::from(elf), stdin)
        .run()
        .map_err(|error| Error::Prover(format!("the SP1 executor failed: {error}")))?;
    Ok(Sp1Execution {
        exit_code: report.exit_code,
        public_values: values.to_vec(),
        instruction_count: report.total_instruction_count(),
    })
}

#[cfg(feature = "sp1")]
impl Sp1Prover {
    /// Reads the ELFs, runs the SP1 setup for each and computes the program keys.
    ///
    /// The setup takes time and memory, so a service builds one prover and shares it (`Arc<dyn Prover>`).
    ///
    /// # Errors
    /// `Error::Config` when a file cannot be read. `Error::Prover` when the setup fails.
    pub fn load(paths: &Sp1ProgramPaths) -> Result<Self> {
        use sp1_sdk::blocking::Prover as _;
        let client = shared_client().clone();
        let load_one = |path: &std::path::Path| -> Result<Sp1Program> {
            let proving_key =
                client
                    .setup(sp1_sdk::Elf::from(read_elf(path)?))
                    .map_err(|error| {
                        Error::Prover(format!("SP1 setup of {}: {error}", path.display()))
                    })?;
            let program_key = B256::from(sp1_sdk::HashableKey::bytes32_raw(
                sp1_sdk::ProvingKey::verifying_key(&proving_key),
            ));
            Ok(Sp1Program {
                proving_key,
                program_key,
            })
        };
        let light_client = load_one(&paths.light_client)?;
        let fork_observation = paths
            .fork_observation
            .as_deref()
            .map(load_one)
            .transpose()?;
        if fork_observation.as_ref().map(|program| program.program_key)
            == Some(light_client.program_key)
        {
            return Err(Error::Config(
                "the light client ELF and the fork observation ELF have the same program key"
                    .into(),
            ));
        }
        Ok(Self {
            client,
            light_client,
            fork_observation,
        })
    }

    /// The program key of the light-client ELF.
    pub fn light_client_key(&self) -> B256 {
        self.light_client.program_key
    }

    /// The program key of the fork observation ELF, when one is loaded.
    pub fn fork_observation_key(&self) -> Option<B256> {
        self.fork_observation
            .as_ref()
            .map(|program| program.program_key)
    }

    fn program(&self, kind: ProgramKind) -> Result<&Sp1Program> {
        match kind {
            ProgramKind::LightClient => Ok(&self.light_client),
            ProgramKind::ForkObservation => self.fork_observation.as_ref().ok_or_else(|| {
                Error::Config(
                    "no fork observation ELF is loaded; set prover.sp1_observation_elf_path".into(),
                )
            }),
        }
    }
}

#[cfg(feature = "sp1")]
impl Prover for Sp1Prover {
    fn name(&self) -> &'static str {
        "sp1"
    }

    fn require_program_key(&self, program: ProgramKind, onchain_key: B256) -> Result<()> {
        require_matching_key(
            program.label(),
            self.program(program)?.program_key,
            onchain_key,
        )
    }

    fn prove(&self, program_vkey: B256, statement: &ProofStatement) -> Result<Proof> {
        use sp1_sdk::blocking::{ProveRequest as _, Prover as _};
        // The native run comes first: it refuses a bad statement cheaply, and its output is the check on the proof.
        let (kind, guest_input, expected_values) = match statement {
            ProofStatement::DevAsserted(_) | ProofStatement::ObservationAsserted(_) => {
                return Err(Error::Prover(
                    "a development statement has no real proof; use the oracle backend on Anvil"
                        .into(),
                ))
            }
            ProofStatement::Observation(guest_input) => (
                ProgramKind::ForkObservation,
                guest_input.clone(),
                verify_observation_natively(guest_input)?,
            ),
            ProofStatement::Verified(input) => (
                ProgramKind::LightClient,
                crate::light_client::guest_input_bytes(input),
                public_values(&verify_update_natively(input)?),
            ),
        };
        let program = self.program(kind)?;
        require_matching_key(kind.label(), program.program_key, program_vkey)?;
        let mut stdin = sp1_sdk::SP1Stdin::new();
        stdin.write_vec(guest_input);
        let proof = self
            .client
            .prove(&program.proving_key, stdin)
            .groth16()
            .run()
            .map_err(|error| Error::Prover(format!("the SP1 Groth16 proof failed: {error}")))?;
        let proven_values = proof.public_values.to_vec();
        if proven_values != expected_values {
            return Err(Error::Prover(
                "the public values of the proof differ from the native run of lc-core; the ELF and lc-core disagree".into(),
            ));
        }
        self.client
            .verify(
                &proof,
                sp1_sdk::ProvingKey::verifying_key(&program.proving_key),
                None,
            )
            .map_err(|error| Error::Prover(format!("the new proof does not verify: {error}")))?;
        Ok(Proof {
            public_values: proven_values,
            proof_bytes: proof.bytes(),
        })
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
        UpdateInput {
            chain,
            store: built.store,
            updates: vec![built.update],
        }
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
        assert_eq!(
            oracle_digest(B256::repeat_byte(0x11), &values),
            keccak256(&packed)
        );
    }

    /// Claim: a valid update gives public values of 352 bytes and a 65-byte signature that recovers to the oracle.
    /// Why it matters: this is the byte layout that the contract and the verifier check.
    #[test]
    fn valid_update_is_signed_by_the_oracle() {
        let prover = OracleProver::new(oracle());
        let vkey = B256::repeat_byte(0x42);
        let proof = prover
            .prove(vkey, &ProofStatement::Verified(scenario(400)))
            .expect("proof");
        assert_eq!(proof.public_values.len(), 352);
        assert_eq!(proof.proof_bytes.len(), 65);
        let signature = crate::signer::RecoverableSignature {
            r: B256::from_slice(&proof.proof_bytes[..32]),
            s: B256::from_slice(&proof.proof_bytes[32..64]),
            recovery_id: proof.proof_bytes[64] - 27,
        };
        let recovered =
            crate::signer::recover_address(&oracle_digest(vkey, &proof.public_values), &signature)
                .unwrap();
        assert_eq!(recovered, oracle().address());
    }

    /// Claim: with 341 of 512 signers (one below two thirds) the prover refuses and returns no signature.
    /// Why it matters: the oracle models a sound proof system. It must never sign a statement the program rejects.
    #[test]
    fn prover_refuses_to_sign_when_native_verification_fails() {
        let prover = OracleProver::new(oracle());
        let error = prover
            .prove(
                B256::repeat_byte(0x42),
                &ProofStatement::Verified(scenario(341)),
            )
            .unwrap_err();
        assert!(
            matches!(error, Error::VerificationRefused(_)),
            "got {error}"
        );
    }

    /// Claim: a program key that differs in one bit from the stored key is refused, and the error shows both keys.
    /// Why it matters: this is the check that keeps the prover from running an ELF the contract does not know.
    #[test]
    fn a_program_key_that_differs_from_the_stored_key_is_refused() {
        let stored = B256::repeat_byte(0x42);
        assert!(require_matching_key("light client", stored, stored).is_ok());
        let mut other = stored;
        other.0[31] ^= 0x01;
        let error = require_matching_key("light client", other, stored).unwrap_err();
        assert!(matches!(error, Error::Config(_)), "got {error}");
        let text = error.to_string();
        assert!(text.contains(&format!("{other:#x}")) && text.contains(&format!("{stored:#x}")));
    }

    /// A tiny wrapper so the digest test does not call the module under test for the SHA-256 value.
    mod sha2_digest {
        pub struct Sha;
        impl Sha {
            pub fn of(data: &[u8]) -> [u8; 32] {
                // SHA-256 of [1, 2, 3], computed with `shasum -a 256` for the fixed input below.
                assert_eq!(data, [1u8, 2, 3]);
                alloy_primitives::hex::decode(
                    "039058c6f2c0cb492c533b0a4d14ef77cc0f78abccced5287d84a1a2011cfb81",
                )
                .unwrap()
                .try_into()
                .unwrap()
            }
        }
    }
}
