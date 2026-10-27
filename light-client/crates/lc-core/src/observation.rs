//! `verify_fork_observation`: the body of the fork-observation guest program.
//!
//! Contract: `docs/hardened-build-contract.md`, section "Fork observation registry". The sync committee signs
//! `compute_signing_root(attested_header_root, domain)`, and the domain holds the fork version. So a bound committee
//! that signs under version V proves that the chain runs V. The program needs no state layout for V: the fork version is
//! a signed input, not a table lookup. A version outside the fork table is therefore accepted, and that is the purpose.
//!
//! Rules:
//! - The fold steps (zero to 64) follow every rule of [`crate::update::verify_fold`], with the fork
//!   versions the steps carry.
//! - The signing committee is the current committee of the final store. It is the next committee of the final store only
//!   when the fold crossed into a new period and proved that next committee itself. A next-period signature without a
//!   crossing is refused (`SignatureInNextPeriodWithoutCrossing`), as for an update.
//! - At least 342 of 512 members sign.
//! - The attested header is carried in full. Its slot is strictly greater than the slot of the final head, and
//!   `signature_slot` is strictly greater than the attested slot. The signed root is the hash of the header, so the
//!   attested slot is authenticated by the signature, and the output reports it as `observedAttestedSlot`.
//! - The output binds the starting store exactly like `LightClientOutput`. No head moves.
//!
//! `signature_slot` itself is not signed. It only selects the committee period, and a wrong choice fails the
//! signature check. It is not reported in the output. Reporting the unsigned slot would let a prover pair an old
//! signature with a fake high slot (see `observation_forged_attested_slot_is_rejected` in `lc-testkit`).

use crate::abi::ForkObservation;
use crate::chain::{ChainSpec, MIN_PARTICIPANTS};
use crate::error::{Error, Result};
use crate::types::{BeaconBlockHeader, LightClientStore, SyncAggregate};
use crate::update::{verify_fold, verify_sync_aggregate, FoldStep, MAX_FOLD_UPDATES};
use alloy_primitives::{FixedBytes, B256};

/// The signed claim of an observation: a sync aggregate over a header root, under a fork version the prover names.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Observation {
    /// The header the committee signed. The program hashes it to get the signed root, so its slot is authenticated.
    pub attested_header: BeaconBlockHeader,
    /// The slot of the block that carries the aggregate. It selects the committee period. It is not signed.
    pub signature_slot: u64,
    /// The participation bits and the aggregate signature.
    pub sync_aggregate: SyncAggregate,
    /// The fork version of the signing domain. The signature proves it.
    pub fork_version: [u8; 4],
}

/// Verifies an observation after an optional fold, and returns the public output.
///
/// # Errors
/// `FoldLengthOutOfRange` for more than 64 steps. The first failed rule of a step. `InsufficientParticipation`,
/// `InvalidSlotOrder`, `PeriodOutOfRange`, `SignatureInNextPeriodWithoutCrossing`, `NextSyncCommitteeUnknown`, or a
/// signature error from the BLS check.
pub fn verify_fork_observation(
    store: &LightClientStore,
    steps: &[FoldStep],
    observation: &Observation,
    spec: &ChainSpec,
) -> Result<ForkObservation> {
    if steps.len() > MAX_FOLD_UPDATES {
        return Err(Error::FoldLengthOutOfRange { count: steps.len() });
    }
    let (final_store, proven_next_hash) = fold_if_any(store, steps, spec)?;

    let participants = observation.sync_aggregate.participant_count();
    if participants < MIN_PARTICIPANTS {
        return Err(Error::InsufficientParticipation { participants });
    }
    let attested_slot = observation.attested_header.slot;
    if attested_slot <= final_store.header_slot {
        return Err(Error::InvalidSlotOrder("the observation attested slot must be after the final head"));
    }
    if observation.signature_slot <= attested_slot {
        return Err(Error::InvalidSlotOrder("the observation signature slot must be after the attested slot"));
    }

    let start_period = spec.period_at_slot(store.header_slot);
    let final_period = spec.period_at_slot(final_store.header_slot);
    let signature_period = spec.period_at_slot(observation.signature_slot);
    let crossed = final_period != start_period;
    if signature_period != final_period && signature_period != final_period + 1 {
        return Err(Error::PeriodOutOfRange("the observation signature is more than one period past the final head"));
    }
    if signature_period == final_period + 1 && !crossed {
        return Err(Error::SignatureInNextPeriodWithoutCrossing);
    }
    // After a crossing the next committee is public only if this fold proved it (proven_next_hash is non-zero).
    // The stored next committee of the start is bound too, but the crossing made it the current one.
    if signature_period == final_period + 1 && proven_next_hash == B256::ZERO {
        return Err(Error::NextSyncCommitteeUnknown);
    }
    let signing_committee = if signature_period == final_period {
        &final_store.current_sync_committee
    } else {
        final_store.next_sync_committee.as_ref().ok_or(Error::NextSyncCommitteeUnknown)?
    };
    verify_sync_aggregate(
        spec,
        signing_committee,
        &observation.sync_aggregate,
        &observation.attested_header.hash_tree_root(),
        observation.fork_version,
    )?;

    let start_next_hash = match &store.next_sync_committee {
        Some(committee) => committee.hash_tree_root()?,
        None => B256::ZERO,
    };
    Ok(ForkObservation {
        genesisValidatorsRoot: spec.genesis_validators_root,
        previousHeaderRoot: store.header_root,
        previousHeadSlot: store.header_slot,
        previousSyncCommitteeHash: store.current_sync_committee.hash_tree_root()?,
        startNextSyncCommitteeHash: start_next_hash,
        observedVersion: FixedBytes::from(observation.fork_version),
        observedAttestedSlot: attested_slot,
    })
}

/// Applies the steps when there are any. Returns the final store and the next committee hash the fold proved (or zero).
fn fold_if_any(store: &LightClientStore, steps: &[FoldStep], spec: &ChainSpec) -> Result<(LightClientStore, B256)> {
    if steps.is_empty() {
        return Ok((store.clone(), B256::ZERO));
    }
    let (output, final_store) = verify_fold(store, steps, spec)?;
    Ok((final_store, output.nextSyncCommitteeHash))
}
