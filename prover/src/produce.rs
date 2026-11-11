//! The stateless proof producer: one run makes at most one proof of one light-client update.
//!
//! The producer holds no state between runs. A run gets a starting head (read from the destination light client, or given
//! by the caller), and then:
//!
//! 1. It checks that the backend runs the program that the key names.
//! 2. It fetches the updates from the starting head to the newest final header of the source beacon chain (a fold of up to
//!    64 updates) and runs the light-client program natively on them with `lc-core`. A fold that the program refuses ends
//!    the run with `Error::VerificationRefused`.
//! 3. It checks that the native run starts exactly at the starting head: slot, header root, next committee, and, when the
//!    caller read the light client, the genesis validators root and the committee of the head period.
//! 4. It asks the backend for the proof.
//! 5. It checks the answer against the native run: the same public values, the shape of the proof, and, for a real proof,
//!    the Groth16 verification under the program key.
//!
//! The run sends no transaction and writes no file. Its result goes to the handoff (`handoff.rs`).

use crate::beacon::http::HttpBeaconSource;
use crate::beacon::StoredHead;
use crate::config::ProverBackend;
use crate::contracts::update_calldata;
use crate::error::{Error, Result};
use crate::handoff::{utc_time_text, PackageDestination, ProofPackage, SCHEMA_VERSION};
use crate::light_client::{public_values, verify_update_natively, LightClientOutput};
use crate::logging::Logger;
use crate::prover::{
    require_groth16_shape, require_native_values, ProgramKind, Proof, ProofStatement, Prover,
};
use crate::remote::verify_groth16;
use crate::stored::StoredState;
use crate::timing::{millis, summary_fields, ProducerTimings};
use alloy_primitives::{hex, B256};
use std::time::Instant;

/// The length of the signature that the oracle backend returns: `r ‖ s ‖ v`.
const ORACLE_PROOF_LENGTH: usize = 65;

/// The name that a package carries when the command line gave the starting head and no route.
pub const EXPLICIT_HEAD_ROUTE: &str = "explicit-head";

/// What one run needs besides the beacon source and the backend.
#[derive(Clone, Debug)]
pub struct ProduceRequest {
    /// The name of the route, for the package.
    pub route: String,
    /// The backend, which decides how the proof is checked.
    pub backend: ProverBackend,
    /// The program key that the proof must be for.
    pub program_key: B256,
    /// The head where the update starts.
    pub head: StoredHead,
    /// The full state that the producer read from the light client. A run that starts from an explicit head has none, and
    /// then the native run is checked against the head only.
    pub stored: Option<StoredState>,
    /// The light client that the proof is for, when the route names it.
    pub destination: Option<PackageDestination>,
    /// The time of the run, in seconds since 1970-01-01.
    pub now_unix_seconds: u64,
}

/// The result of one run.
#[derive(Clone, Debug)]
pub enum Production {
    /// A proof, with the package for the handoff.
    Proof(Box<ProofPackage>),
    /// The starting head already is the newest final header. There is nothing to prove.
    UpToDate {
        /// The slot of the starting head.
        head_slot: u64,
    },
}

/// Runs the producer once. See the module documentation for the steps.
///
/// # Errors
/// `Error::Config` when the backend runs another program than the key names. `Error::Beacon` when the beacon node lacks
/// data, or when the native run does not start at the starting head (the beacon URL may name another chain).
/// `Error::VerificationRefused` when the program refuses the fold. `Error::Prover` when the backend fails or its answer
/// fails a check.
pub fn produce(
    source: &HttpBeaconSource,
    prover: &dyn Prover,
    request: &ProduceRequest,
) -> Result<Production> {
    produce_logged(source, prover, request, &Logger::in_memory().0)
}

/// Like [`produce`], and writes the step timings to `logger`: one `prove_step` line for each step of the producer
/// (`build`, `native`, `check`), the lines of the backend, and at the end one `prove_timing` line with all of them
/// (`docs/gpu-prover.md`, "Timing logs"). A run that has nothing to prove writes no timing lines.
///
/// # Errors
/// The errors of [`produce`].
pub fn produce_logged(
    source: &HttpBeaconSource,
    prover: &dyn Prover,
    request: &ProduceRequest,
    logger: &Logger,
) -> Result<Production> {
    let run_started = Instant::now();
    prover.require_program_key(ProgramKind::LightClient, request.program_key)?;
    let build_started = Instant::now();
    let Some(plan) = source.plan_update(&request.head)? else {
        return Ok(Production::UpToDate {
            head_slot: request.head.slot,
        });
    };
    let build_ms = millis(build_started.elapsed());
    step_line(logger, "build", build_ms);
    let native_started = Instant::now();
    let output = verify_update_natively(&plan.input)?;
    require_start_at_head(&output, request)?;
    let expected_values = public_values(&output);
    let native_ms = millis(native_started.elapsed());
    step_line(logger, "native", native_ms);
    let prove_started = Instant::now();
    let proof = prover.prove(request.program_key, &ProofStatement::Verified(plan.input))?;
    let prove_ms = millis(prove_started.elapsed());
    let check_started = Instant::now();
    check_proof(request, &proof, &expected_values)?;
    let check_ms = millis(check_started.elapsed());
    step_line(logger, "check", check_ms);
    let producer = ProducerTimings {
        build_ms,
        native_ms,
        prove_ms,
        check_ms,
        total_ms: millis(run_started.elapsed()),
    };
    logger.info(
        "prove_timing",
        &summary_fields(&producer, prover.take_timings().as_ref()),
    );
    Ok(Production::Proof(Box::new(package(
        request,
        &output,
        plan.latest_finalized_slot,
        proof,
    ))))
}

fn step_line(logger: &Logger, step: &str, elapsed_ms: u64) {
    logger.info(
        "prove_step",
        &[
            ("step", step.to_string()),
            ("elapsed_ms", elapsed_ms.to_string()),
        ],
    );
}

/// Fails unless the native run starts where the light client holds its head. A fold that starts elsewhere would revert on
/// the chain, and a proof for it would be wasted.
fn require_start_at_head(output: &LightClientOutput, request: &ProduceRequest) -> Result<()> {
    let head = &request.head;
    let mismatch = |what: &str, expected: String, actual: String| {
        Error::Beacon(format!(
            "the native run starts with {what} {actual}, but the light client holds {expected}; the beacon URL may name another chain"
        ))
    };
    if output.previousHeadSlot != head.slot {
        return Err(mismatch(
            "head slot",
            head.slot.to_string(),
            output.previousHeadSlot.to_string(),
        ));
    }
    if output.previousHeaderRoot != head.root {
        return Err(mismatch(
            "header root",
            format!("{:#x}", head.root),
            format!("{:#x}", output.previousHeaderRoot),
        ));
    }
    if output.startNextSyncCommitteeHash != head.next_committee_hash {
        return Err(mismatch(
            "next committee hash",
            format!("{:#x}", head.next_committee_hash),
            format!("{:#x}", output.startNextSyncCommitteeHash),
        ));
    }
    let Some(stored) = &request.stored else {
        return Ok(());
    };
    if output.genesisValidatorsRoot != stored.genesis_validators_root {
        return Err(mismatch(
            "genesis validators root",
            format!("{:#x}", stored.genesis_validators_root),
            format!("{:#x}", output.genesisValidatorsRoot),
        ));
    }
    if output.previousSyncCommitteeHash != stored.head_committee_hash {
        return Err(mismatch(
            "committee hash",
            format!("{:#x}", stored.head_committee_hash),
            format!("{:#x}", output.previousSyncCommitteeHash),
        ));
    }
    Ok(())
}

/// Checks the answer of the backend against the native run. Nothing here trusts the backend.
///
/// The public values must equal the native ones. The proof must have the shape of its backend. A real proof must verify
/// under the program key with the crate `sp1-verifier`, whatever backend made it.
fn check_proof(request: &ProduceRequest, proof: &Proof, expected_values: &[u8]) -> Result<()> {
    check_backend_proof(request.backend, request.program_key, proof, expected_values)
}

/// The checks of [`check_proof`] for any program: the native public values, the shape of the backend's proof, and for a
/// real proof the Groth16 verification under `program_key`. The fork observation producer uses it too.
///
/// # Errors
/// `Error::Prover` when a check fails.
pub(crate) fn check_backend_proof(
    backend: ProverBackend,
    program_key: B256,
    proof: &Proof,
    expected_values: &[u8],
) -> Result<()> {
    require_native_values(&proof.public_values, expected_values)?;
    if backend == ProverBackend::Oracle {
        return require_oracle_shape(&proof.proof_bytes);
    }
    require_groth16_shape(&proof.proof_bytes)?;
    verify_groth16(program_key, &proof.public_values, &proof.proof_bytes)
}

fn require_oracle_shape(proof_bytes: &[u8]) -> Result<()> {
    if proof_bytes.len() == ORACLE_PROOF_LENGTH {
        return Ok(());
    }
    Err(Error::Prover(format!(
        "the oracle proof has {} bytes, but a signature has {ORACLE_PROOF_LENGTH}",
        proof_bytes.len()
    )))
}

fn package(
    request: &ProduceRequest,
    output: &LightClientOutput,
    latest_finalized_slot: u64,
    proof: Proof,
) -> ProofPackage {
    ProofPackage {
        schema_version: SCHEMA_VERSION,
        route: request.route.clone(),
        program_key: format!("{:#x}", request.program_key),
        start_head_slot: output.previousHeadSlot,
        start_head_root: format!("{:#x}", output.previousHeaderRoot),
        new_head_slot: output.newHeadSlot,
        new_head_root: format!("{:#x}", output.newHeaderRoot),
        latest_finalized_slot,
        public_values: hex::encode_prefixed(&proof.public_values),
        proof: hex::encode_prefixed(&proof.proof_bytes),
        update_calldata: hex::encode_prefixed(update_calldata(
            &proof.proof_bytes,
            &proof.public_values,
        )),
        backend: request.backend.as_str().to_string(),
        destination: request.destination.clone(),
        created_at: utc_time_text(request.now_unix_seconds),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn output() -> LightClientOutput {
        LightClientOutput {
            genesisValidatorsRoot: B256::repeat_byte(0x11),
            previousHeaderRoot: B256::repeat_byte(0x22),
            previousHeadSlot: 100,
            previousSyncCommitteeHash: B256::repeat_byte(0x33),
            startNextSyncCommitteeHash: B256::repeat_byte(0x44),
            newHeaderRoot: B256::repeat_byte(0x55),
            newHeadSlot: 200,
            executionBlockHash: B256::repeat_byte(0x66),
            executionBlockNumber: 300,
            syncCommitteeHash: B256::repeat_byte(0x77),
            nextSyncCommitteeHash: B256::repeat_byte(0x88),
        }
    }

    fn request(backend: ProverBackend) -> ProduceRequest {
        ProduceRequest {
            route: "ethereum_to_pulsechain".into(),
            backend,
            program_key: B256::repeat_byte(0x99),
            head: StoredHead {
                slot: 100,
                root: B256::repeat_byte(0x22),
                next_committee_hash: B256::repeat_byte(0x44),
            },
            stored: Some(StoredState {
                head: StoredHead {
                    slot: 100,
                    root: B256::repeat_byte(0x22),
                    next_committee_hash: B256::repeat_byte(0x44),
                },
                genesis_validators_root: B256::repeat_byte(0x11),
                head_committee_hash: B256::repeat_byte(0x33),
                program_key: B256::repeat_byte(0x99),
            }),
            destination: None,
            now_unix_seconds: 1_800_000_000,
        }
    }

    /// Claim: a native run that starts at the stored head passes, and each field that differs makes the run fail with a
    /// message that names the field: slot, root, next committee, genesis validators root, committee of the head period.
    /// Why it matters: a proof of a fold that starts elsewhere reverts on the chain after hours of proving. The check costs
    /// nothing, and it also catches a beacon URL that names the wrong chain.
    #[test]
    fn the_native_run_must_start_at_the_stored_head() {
        assert!(require_start_at_head(&output(), &request(ProverBackend::Oracle)).is_ok());
        type Change = fn(&mut LightClientOutput);
        let cases: [(Change, &str); 5] = [
            (|o| o.previousHeadSlot = 101, "head slot"),
            (
                |o| o.previousHeaderRoot = B256::repeat_byte(1),
                "header root",
            ),
            (
                |o| o.startNextSyncCommitteeHash = B256::ZERO,
                "next committee hash",
            ),
            (
                |o| o.genesisValidatorsRoot = B256::repeat_byte(2),
                "genesis validators root",
            ),
            (
                |o| o.previousSyncCommitteeHash = B256::repeat_byte(3),
                "committee hash",
            ),
        ];
        for (change, name) in cases {
            let mut changed = output();
            change(&mut changed);
            let error = require_start_at_head(&changed, &request(ProverBackend::Oracle))
                .unwrap_err()
                .to_string();
            assert!(error.contains(name), "{name}: {error}");
        }
    }

    /// Claim: an explicit head has no stored state, so only the head itself is checked.
    #[test]
    fn an_explicit_head_checks_the_head_only() {
        let mut explicit = request(ProverBackend::Oracle);
        explicit.stored = None;
        let mut changed = output();
        changed.genesisValidatorsRoot = B256::repeat_byte(2);
        assert!(require_start_at_head(&changed, &explicit).is_ok());
        changed.previousHeadSlot = 7;
        assert!(require_start_at_head(&changed, &explicit).is_err());
    }

    /// Claim: the check of an answer refuses public values that differ from the native run, an oracle proof of the wrong
    /// length, and, for a real backend, a proof of the wrong shape or one that does not verify.
    /// Why it matters: this is the last line before the handoff. A server that stores a bad proof loses the update slot.
    #[test]
    fn a_wrong_answer_is_refused() {
        let expected = public_values(&output());
        let good_oracle = Proof {
            public_values: expected.clone(),
            proof_bytes: vec![0u8; 65],
        };
        assert!(check_proof(&request(ProverBackend::Oracle), &good_oracle, &expected).is_ok());

        let other_values = Proof {
            public_values: vec![1, 2, 3],
            ..good_oracle.clone()
        };
        let error = check_proof(&request(ProverBackend::Oracle), &other_values, &expected)
            .unwrap_err()
            .to_string();
        assert!(error.contains("differ from the native run"), "{error}");

        let short = Proof {
            proof_bytes: vec![0u8; 64],
            ..good_oracle.clone()
        };
        assert!(check_proof(&request(ProverBackend::Oracle), &short, &expected).is_err());

        for backend in [ProverBackend::Remote, ProverBackend::Sp1] {
            let error = check_proof(&request(backend), &good_oracle, &expected)
                .unwrap_err()
                .to_string();
            assert!(
                error.contains("the pinned verifier reads"),
                "{backend:?}: {error}"
            );
        }
    }

    /// Claim: the package takes its keys from the native run and its bytes from the proof, and the update calldata is the
    /// `update(proof, publicValues)` call for the same bytes.
    #[test]
    fn the_package_matches_the_run() {
        let proof = Proof {
            public_values: public_values(&output()),
            proof_bytes: vec![7u8; 65],
        };
        let mut request = request(ProverBackend::Oracle);
        request.destination = Some(PackageDestination {
            chain_id: 369,
            light_client: format!("{:#x}", alloy_primitives::Address::repeat_byte(0x44)),
        });
        let package = package(&request, &output(), 250, proof.clone());
        assert_eq!(package.start_head_slot, 100);
        assert_eq!(package.new_head_slot, 200);
        assert_eq!(package.latest_finalized_slot, 250);
        assert_eq!(
            package.new_head_root,
            format!("{:#x}", B256::repeat_byte(0x55))
        );
        assert_eq!(package.backend, "oracle");
        assert_eq!(package.created_at, "2027-01-15T08:00:00Z");
        assert_eq!(
            package.public_values,
            hex::encode_prefixed(&proof.public_values)
        );
        assert_eq!(
            package.update_calldata,
            hex::encode_prefixed(update_calldata(&proof.proof_bytes, &proof.public_values))
        );
    }
}
