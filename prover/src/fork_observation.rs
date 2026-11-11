//! The fork observation producer: one run makes at most one proof of the fork observation program, for the
//! `ForkRegistry` of a chain (HB-02 on PulseChain; `docs/hardened-build-contract.md`, "Fork observation registry").
//!
//! The registry checks an observation against its own light client: a light client of the observed beacon chain, on the
//! same chain. A run reads that light client (its head, its committees, its genesis validators root), and then:
//!
//! 1. It asks the beacon node for the fold from that head toward the newest final header (the same fold as a light-client
//!    update), and for the newest signed update. The observation is the attested header of that update, its sync
//!    aggregate, its signature slot and the fork version of its signing domain, with the fork proof of the attested state
//!    (the branches of `fork.current_version` and `genesis_validators_root`, from which the program proves the shape).
//! 2. It runs the program natively with the longest prefix of the fold that the program accepts: the whole fold first,
//!    and fewer steps when a step is of a state that the light-client program refuses (after a fork of another layout)
//!    or when the signature needs the committee of an earlier period.
//! 3. It checks that the native run starts exactly where the light client stands, as the registry will (rule 1).
//! 4. It asks the backend for the proof and checks the answer against the native run.
//!
//! The run sends no transaction. Its result is one JSON line on standard output; a stateful server simulates and sends
//! `ForkRegistry.observe(proof, publicValues)` from it.

use crate::beacon::http::HttpBeaconSource;
use crate::config::ProverBackend;
use crate::contracts::observe_calldata;
use crate::error::{Error, Result};
use crate::handoff::utc_time_text;
use crate::light_client::{
    decode_fork_observation, observation_guest_input_bytes, verify_observation_natively, ChainKind,
    ForkObservation, LightClientStore, Observation,
};
use crate::logging::Logger;
use crate::produce::check_backend_proof;
use crate::prover::{ProgramKind, ProofStatement, Prover};
use crate::stored::StoredState;
use crate::timing::{millis, summary_fields, ProducerTimings};
use alloy_primitives::{hex, Address, B256};
use lc_core::update::FoldStep;
use lc_message::abi::ForkProof;
use serde::{Deserialize, Serialize};
use std::time::Instant;

/// The version of the package shape.
pub const OBSERVATION_SCHEMA_VERSION: u32 = 1;

/// How many refusals an error message lists before it summarizes the rest.
const REASONS_SHOWN: usize = 3;

/// One proof of a fork observation, with everything a server needs to post it. Every hash and byte string is `0x` hex.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ObservationPackage {
    /// The version of this shape ([`OBSERVATION_SCHEMA_VERSION`]).
    pub schema_version: u32,
    /// The name of the route whose source beacon chain was observed.
    pub route: String,
    /// The chain that holds the registry (the observed chain itself).
    pub chain_id: u64,
    /// The `ForkRegistry` to send `observe` to.
    pub registry: String,
    /// The light client of the observed chain that the registry reads.
    pub light_client: String,
    /// The key of the observation program (`ForkRegistry.observationProgramVKey`).
    pub program_key: String,
    /// The head of the light client the observation starts from. The registry refuses it once that head moves.
    pub start_head_slot: u64,
    /// The fork version the committee signed under, as `0x` and 8 hex digits.
    pub observed_version: String,
    /// The proven shape of the attested state: 5, 6, 7, 255 (progressive), or a plain depth from 8 to 31.
    pub shape: u8,
    /// The attested slot. The registry needs it above its light client head.
    pub observed_attested_slot: u64,
    /// How many fold steps the proof carries (0 to 64).
    pub fold_steps: usize,
    /// The public values (256 bytes, the ABI encoding of `ForkObservation`).
    pub public_values: String,
    /// The proof bytes that the verifier contract reads.
    pub proof: String,
    /// The calldata of `ForkRegistry.observe(proof, publicValues)`.
    pub observe_calldata: String,
    /// The backend that made the proof: `sp1`, `remote` or `oracle`.
    pub backend: String,
    /// When the proof was made, in UTC.
    pub created_at: String,
}

impl ObservationPackage {
    /// The package as one line of JSON.
    ///
    /// # Errors
    /// `Error::Handoff` when it cannot be encoded.
    pub fn to_json_line(&self) -> Result<String> {
        serde_json::to_string(self).map_err(|error| {
            Error::Handoff(format!("cannot encode the observation package: {error}"))
        })
    }
}

/// What one run needs besides the beacon source and the backend.
#[derive(Clone, Debug)]
pub struct ObservationRequest {
    /// The name of the route, for the package.
    pub route: String,
    /// The backend, which decides how the proof is checked.
    pub backend: ProverBackend,
    /// The key of the observation program, read from the registry.
    pub program_key: B256,
    /// The chain of the registry.
    pub chain_id: u64,
    /// The registry.
    pub registry: Address,
    /// The light client the registry reads.
    pub light_client: Address,
    /// What that light client stores.
    pub stored: StoredState,
    /// The time of the run, in seconds since 1970-01-01.
    pub now_unix_seconds: u64,
}

/// The parts of the guest input before the fold is chosen.
#[derive(Clone, Debug)]
pub struct ObservationParts {
    /// The chain of the beacon data.
    pub chain: ChainKind,
    /// The store at the light client head.
    pub store: LightClientStore,
    /// The fold from the head, 0 to 64 steps. A prefix of it is used.
    pub steps: Vec<FoldStep>,
    /// The observation.
    pub observation: Observation,
}

/// The guest input that the program accepted, and its public values.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ChosenFold {
    /// The bytes the guest reads.
    pub guest_input: Vec<u8>,
    /// The public values of the native run.
    pub public_values: Vec<u8>,
    /// How many fold steps it carries.
    pub steps: usize,
}

/// The observation of the newest signed update: its attested header, signature slot and aggregate, the version of its
/// signing domain, and the fork proof of the attested state.
///
/// # Errors
/// `Error::Beacon` when the attested state holds another version than the one the committee signed under (the update
/// straddles a fork boundary; the next epoch gives an update inside one fork).
pub fn observation_of(latest: &FoldStep, fork: &ForkProof) -> Result<Observation> {
    let state_version: [u8; 4] = fork.version.0;
    if state_version != latest.fork_version {
        return Err(Error::Beacon(format!(
            "the attested state at slot {} holds fork version 0x{}, but the committee signed under 0x{}; the update straddles a fork, ask again in the next epoch",
            latest.update.attested_header.beacon.slot,
            hex::encode(state_version),
            hex::encode(latest.fork_version)
        )));
    }
    Ok(Observation {
        attested_header: latest.update.attested_header.beacon,
        signature_slot: latest.update.signature_slot,
        sync_aggregate: latest.update.sync_aggregate.clone(),
        fork_version: latest.fork_version,
        current_version_branch: fork.versionBranch.clone(),
        genesis_validators_root_branch: fork.genesisValidatorsRootBranch.clone(),
    })
}

/// Runs the program natively with the longest prefix of the fold that it accepts: all steps first, then one fewer, down
/// to none.
///
/// # Errors
/// `Error::VerificationRefused` naming the first refusals when no prefix is accepted.
pub fn choose_fold(parts: &ObservationParts) -> Result<ChosenFold> {
    let mut reasons = Vec::new();
    for count in (0..=parts.steps.len()).rev() {
        let guest_input = observation_guest_input_bytes(
            parts.chain,
            &parts.store,
            &parts.steps[..count],
            &parts.observation,
        );
        match verify_observation_natively(&guest_input) {
            Ok(public_values) => {
                return Ok(ChosenFold {
                    guest_input,
                    public_values,
                    steps: count,
                })
            }
            Err(error) => reasons.push(format!("{count} steps: {error}")),
        }
    }
    let total = reasons.len();
    let mut shown: Vec<String> = reasons.into_iter().take(REASONS_SHOWN).collect();
    if total > REASONS_SHOWN {
        shown.push(format!("and {} more", total - REASONS_SHOWN));
    }
    Err(Error::VerificationRefused(format!(
        "the observation program refuses every fold from the light client head: {}",
        shown.join("; ")
    )))
}

/// Fails unless the observation starts where the light client stands: the five start fields that the registry compares
/// (rule 1). A proof that starts elsewhere would revert on chain.
fn require_start_at_stored(output: &ForkObservation, stored: &StoredState) -> Result<()> {
    let checks: [(&str, String, String); 5] = [
        (
            "genesis validators root",
            format!("{:#x}", stored.genesis_validators_root),
            format!("{:#x}", output.genesisValidatorsRoot),
        ),
        (
            "head slot",
            stored.head.slot.to_string(),
            output.previousHeadSlot.to_string(),
        ),
        (
            "header root",
            format!("{:#x}", stored.head.root),
            format!("{:#x}", output.previousHeaderRoot),
        ),
        (
            "committee hash",
            format!("{:#x}", stored.head_committee_hash),
            format!("{:#x}", output.previousSyncCommitteeHash),
        ),
        (
            "next committee hash",
            format!("{:#x}", stored.head.next_committee_hash),
            format!("{:#x}", output.startNextSyncCommitteeHash),
        ),
    ];
    for (what, expected, actual) in checks {
        if expected != actual {
            return Err(Error::Beacon(format!(
                "the observation starts with {what} {actual}, but the registry's light client holds {expected}; the beacon URL may name another chain"
            )));
        }
    }
    Ok(())
}

/// Proves an observation from its parts: chooses the fold, checks the start, proves, checks the proof, and packages it.
/// `build_ms` is the time the caller spent on the beacon reads. Writes `prove_step` lines and one `prove_timing` line.
///
/// # Errors
/// `Error::VerificationRefused` when no fold is accepted. `Error::Beacon` when the start differs from the light client.
/// `Error::Prover` when the backend fails or its answer fails a check.
pub fn prove_observation(
    prover: &dyn Prover,
    request: &ObservationRequest,
    parts: &ObservationParts,
    build_ms: u64,
    logger: &Logger,
) -> Result<ObservationPackage> {
    let run_started = Instant::now();
    let native_started = Instant::now();
    let chosen = choose_fold(parts)?;
    let output = decode_fork_observation(&chosen.public_values)?;
    require_start_at_stored(&output, &request.stored)?;
    let native_ms = millis(native_started.elapsed());
    step_line(logger, "native", native_ms);
    let prove_started = Instant::now();
    let proof = prover.prove(
        request.program_key,
        &ProofStatement::Observation(chosen.guest_input.clone()),
    )?;
    let prove_ms = millis(prove_started.elapsed());
    let check_started = Instant::now();
    check_backend_proof(
        request.backend,
        request.program_key,
        &proof,
        &chosen.public_values,
    )?;
    let check_ms = millis(check_started.elapsed());
    step_line(logger, "check", check_ms);
    let producer = ProducerTimings {
        build_ms,
        native_ms,
        prove_ms,
        check_ms,
        total_ms: build_ms + millis(run_started.elapsed()),
    };
    logger.info(
        "prove_timing",
        &summary_fields(&producer, prover.take_timings().as_ref()),
    );
    Ok(ObservationPackage {
        schema_version: OBSERVATION_SCHEMA_VERSION,
        route: request.route.clone(),
        chain_id: request.chain_id,
        registry: format!("{:#x}", request.registry),
        light_client: format!("{:#x}", request.light_client),
        program_key: format!("{:#x}", request.program_key),
        start_head_slot: output.previousHeadSlot,
        observed_version: hex::encode_prefixed(output.observedVersion.0),
        shape: output.shape,
        observed_attested_slot: output.observedAttestedSlot,
        fold_steps: chosen.steps,
        public_values: hex::encode_prefixed(&proof.public_values),
        proof: hex::encode_prefixed(&proof.proof_bytes),
        observe_calldata: hex::encode_prefixed(observe_calldata(
            &proof.proof_bytes,
            &proof.public_values,
        )),
        backend: request.backend.as_str().to_string(),
        created_at: utc_time_text(request.now_unix_seconds),
    })
}

/// One run: reads the beacon node, then [`prove_observation`].
///
/// # Errors
/// The errors of [`HttpBeaconSource::plan_observation`] and [`HttpBeaconSource::source_fork`], `Error::Config` when the
/// backend runs another observation program than the registry's key, and the errors of [`prove_observation`].
pub fn produce_observation(
    source: &HttpBeaconSource,
    prover: &dyn Prover,
    request: &ObservationRequest,
    logger: &Logger,
) -> Result<ObservationPackage> {
    prover.require_program_key(ProgramKind::ForkObservation, request.program_key)?;
    let build_started = Instant::now();
    let plan = source.plan_observation(&request.stored.head)?;
    if let Some(reason) = &plan.fold_error {
        logger.warn(
            "observation_fold_unavailable",
            &[("reason", reason.clone())],
        );
    }
    let state_root = plan.latest.update.attested_header.beacon.state_root;
    let fork = source.source_fork(state_root)?;
    let observation = observation_of(&plan.latest, &fork)?;
    let build_ms = millis(build_started.elapsed());
    step_line(logger, "build", build_ms);
    let parts = ObservationParts {
        chain: plan.chain,
        store: plan.store,
        steps: plan.steps,
        observation,
    };
    prove_observation(prover, request, &parts, build_ms, logger)
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

#[cfg(test)]
mod tests {
    use super::*;
    use crate::beacon::StoredHead;
    use crate::contracts::ForkRegistryContract;
    use crate::prover::OracleProver;
    use crate::signer::Signer;
    use alloy_sol_types::SolCall;
    use lc_core::chain::PULSECHAIN;
    use lc_testkit::fork_observation_scenarios::{
        fold_steps, observation_signed_by, stale_three_period_scenario, version_outside_table,
        PeriodStart,
    };
    use lc_testkit::synthetic::committee_for;

    const PERIOD: u64 = 1326;
    const KEY: B256 = B256::repeat_byte(0x33);
    const ANVIL_SECRET: &str = "ac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80";

    fn oracle() -> OracleProver {
        OracleProver::new(Signer::from_secret_bytes(&hex::decode(ANVIL_SECRET).unwrap()).unwrap())
    }

    /// The stale PulseChain scenario: a store in period P and three updates to P+2, with an observation of a version
    /// outside the table, signed by the committee of `signer_period` at `attested_slot`.
    fn parts(signer_period: u64, attested_slot: u64) -> ObservationParts {
        let scenario = stale_three_period_scenario(&PULSECHAIN, PERIOD);
        let signer = committee_for(&PULSECHAIN, signer_period);
        let observation = observation_signed_by(
            &PULSECHAIN,
            &signer,
            version_outside_table(&PULSECHAIN),
            342,
            attested_slot,
        );
        ObservationParts {
            chain: ChainKind::Pulsechain,
            store: scenario.store.clone(),
            steps: fold_steps(&PULSECHAIN, &scenario.updates),
            observation,
        }
    }

    fn stored_of(store: &LightClientStore) -> StoredState {
        StoredState {
            head: StoredHead {
                slot: store.header_slot,
                root: store.header_root,
                next_committee_hash: B256::ZERO,
            },
            genesis_validators_root: PULSECHAIN.genesis_validators_root,
            head_committee_hash: store.current_sync_committee.hash_tree_root().unwrap(),
            program_key: B256::repeat_byte(0x11),
        }
    }

    fn request(store: &LightClientStore) -> ObservationRequest {
        ObservationRequest {
            route: "pulsechain_to_ethereum".into(),
            backend: ProverBackend::Oracle,
            program_key: KEY,
            chain_id: 369,
            registry: Address::repeat_byte(0x44),
            light_client: Address::repeat_byte(0x55),
            stored: stored_of(store),
            now_unix_seconds: 1_794_000_000,
        }
    }

    /// Claim: an observation signed after the final head of the whole fold uses every step.
    /// Why it matters: the whole fold is the normal case; a shorter one would be refused by the period rule.
    #[test]
    fn the_whole_fold_is_used_when_the_program_accepts_it() {
        let scenario = stale_three_period_scenario(&PULSECHAIN, PERIOD);
        let attested = scenario.final_head_slot() + 100;
        let chosen = choose_fold(&parts(PERIOD + 2, attested)).unwrap();
        assert_eq!(chosen.steps, 3);
        let output = decode_fork_observation(&chosen.public_values).unwrap();
        assert_eq!(output.previousHeadSlot, scenario.store.header_slot);
        assert_eq!(output.observedVersion.0, version_outside_table(&PULSECHAIN));
        assert_eq!(output.observedAttestedSlot, attested);
    }

    /// Claim: when the whole fold is refused, a shorter prefix that the program accepts is chosen.
    /// Why it matters: after a fork of another layout the last steps are refused, and the observation must still be
    /// provable from the steps before it.
    #[test]
    fn a_shorter_fold_is_chosen_when_the_whole_fold_is_refused() {
        let start = PeriodStart::of(&PULSECHAIN, PERIOD);
        // Signed in period P+1 by its committee, after the head of two steps and before the head of three.
        let attested = start.slot_in_period(1, 4000);
        let chosen = choose_fold(&parts(PERIOD + 1, attested)).unwrap();
        assert_eq!(chosen.steps, 2);
    }

    /// Claim: when no prefix is accepted, the error names the refusals and summarizes the rest.
    /// Why it matters: the backend logs it, and a person must see why no proof was asked for.
    #[test]
    fn no_accepted_fold_is_refused_with_reasons() {
        let scenario = stale_three_period_scenario(&PULSECHAIN, PERIOD);
        // A committee of another period never verifies.
        let error = choose_fold(&parts(PERIOD + 9, scenario.final_head_slot() + 100)).unwrap_err();
        let Error::VerificationRefused(text) = error else {
            panic!("{error}")
        };
        assert!(text.contains("3 steps:"), "{text}");
        assert!(text.contains("and 1 more"), "{text}");
    }

    /// Claim: the observation copies the attested header, the aggregate, the slot and the branches of the newest update,
    /// and is refused when the state's version differs from the signing version.
    /// Why it matters: a mismatch proves nothing (the leaf must be the signed version) and would waste a native run.
    #[test]
    fn the_observation_is_the_newest_update_with_its_fork_proof() {
        let scenario = stale_three_period_scenario(&PULSECHAIN, PERIOD);
        let latest = fold_steps(&PULSECHAIN, &scenario.updates).pop().unwrap();
        let fork = ForkProof {
            version: latest.fork_version.into(),
            versionBranch: vec![B256::repeat_byte(1); 7],
            genesisValidatorsRootBranch: vec![B256::repeat_byte(2); 5],
        };
        let observation = observation_of(&latest, &fork).unwrap();
        assert_eq!(
            observation.attested_header,
            latest.update.attested_header.beacon
        );
        assert_eq!(observation.signature_slot, latest.update.signature_slot);
        assert_eq!(observation.fork_version, latest.fork_version);
        assert_eq!(observation.current_version_branch.len(), 7);
        assert_eq!(observation.genesis_validators_root_branch.len(), 5);
        let other = ForkProof {
            version: [9, 9, 9, 9].into(),
            ..fork
        };
        let error = observation_of(&latest, &other).unwrap_err();
        assert!(error.to_string().contains("straddles a fork"), "{error}");
    }

    /// Claim: a proof from the oracle becomes a package whose calldata is `observe(proof, publicValues)` with the native
    /// public values, and whose fields name the version, the slot, the fold and the start.
    /// Why it matters: the backend sends the calldata as it is; a byte that differs fails the verifier.
    #[test]
    fn a_proof_becomes_an_observe_package() {
        let scenario = stale_three_period_scenario(&PULSECHAIN, PERIOD);
        let attested = scenario.final_head_slot() + 100;
        let parts = parts(PERIOD + 2, attested);
        let (logger, lines) = Logger::in_memory();
        let package =
            prove_observation(&oracle(), &request(&scenario.store), &parts, 7, &logger).unwrap();
        assert_eq!(package.schema_version, OBSERVATION_SCHEMA_VERSION);
        assert_eq!(package.observed_version, "0x0000036d");
        assert_eq!(package.observed_attested_slot, attested);
        assert_eq!(package.start_head_slot, scenario.store.header_slot);
        assert_eq!(package.fold_steps, 3);
        assert_eq!(package.backend, "oracle");
        assert_eq!(
            package.registry,
            format!("{:#x}", Address::repeat_byte(0x44))
        );
        let calldata = hex::decode(&package.observe_calldata).unwrap();
        let call = ForkRegistryContract::observeCall::abi_decode(&calldata).unwrap();
        assert_eq!(
            hex::encode_prefixed(&call.publicValues),
            package.public_values
        );
        assert_eq!(hex::encode_prefixed(&call.proof), package.proof);
        let line = package.to_json_line().unwrap();
        let back: ObservationPackage = serde_json::from_str(&line).unwrap();
        assert_eq!(back, package);
        let logged = lines.lock().unwrap().join("\n");
        assert!(logged.contains("prove_timing"), "{logged}");
    }

    /// Claim: an observation that does not start at the stored head is refused before any proof is asked for.
    /// Why it matters: the registry would revert it, and a GPU proof costs money.
    #[test]
    fn a_start_that_differs_from_the_light_client_is_refused() {
        let scenario = stale_three_period_scenario(&PULSECHAIN, PERIOD);
        let parts = parts(PERIOD + 2, scenario.final_head_slot() + 100);
        let mut moved = request(&scenario.store);
        moved.stored.head.slot += 1;
        let error =
            prove_observation(&oracle(), &moved, &parts, 0, &Logger::in_memory().0).unwrap_err();
        assert!(error.to_string().contains("head slot"), "{error}");
        let mut foreign = request(&scenario.store);
        foreign.stored.genesis_validators_root = B256::repeat_byte(9);
        let error =
            prove_observation(&oracle(), &foreign, &parts, 0, &Logger::in_memory().0).unwrap_err();
        assert!(
            error.to_string().contains("genesis validators root"),
            "{error}"
        );
    }
}
