//! `verify_light_client_update`: the body of the light-client guest program.
//!
//! It follows `validate_light_client_update` of `specs/altair/light-client/sync-protocol.md` and the Capella,
//! Deneb and Electra extensions, with the bridge rules on top:
//! - at least 342 of 512 members sign (the specification only asks for one in `validate`, and asks for two thirds in
//!   `process_light_client_update`; the bridge always needs two thirds);
//! - the update must carry a finalized header and the head must strictly advance;
//! - the signature binds to the chain through the genesis validators root and the fork version;
//! - the signing committee is always public: the stored current committee (`previousSyncCommitteeHash`), or the
//!   committee named by `syncCommitteeHash` when the finalized header crosses into the next period. An update signed in
//!   the next period but finalized in the stored period is refused (`SignatureInNextPeriodWithoutCrossing`);
//! - `nextSyncCommitteeHash` is the root of a next committee that this update proved, else zero. The private store
//!   may know a next committee, but the output never reports it.
//!
//! The contract rule behind this: when the new period is `headPeriod + 1`, the contract requires
//! `syncCommittees[headPeriod + 1]` to be non-zero and equal to `syncCommitteeHash`. It fills an empty next slot only
//! from a non-zero `nextSyncCommitteeHash`.
//!
//! The wall clock check `current_slot >= signature_slot` of the specification cannot run inside a proof (no clock).
//! It adds nothing: a real signature cannot come from the future.

use crate::abi::LightClientOutput;
use crate::bls::fast_aggregate_verify;
use crate::chain::DOMAIN_SYNC_COMMITTEE;
use crate::chain::{ChainSpec, GENESIS_SLOT, MIN_PARTICIPANTS, SYNC_COMMITTEE_SIZE};
use crate::error::{Error, Result};
use crate::layout::{execution_header_form_for_fork, state_layout_for_fork, StateLayout, EXECUTION_PAYLOAD_GINDEX};
use crate::ssz::is_valid_normalized_merkle_branch;
use crate::types::{
    compute_domain, compute_signing_root, LightClientHeader, LightClientStore, LightClientUpdate, SyncAggregate,
    SyncCommittee,
};
use alloy_primitives::B256;

/// Chooses the beacon state layout for the fork of the attested header. Tests replace it to model the "wrong fork" attack.
pub type StateLayoutSelector = fn(crate::chain::ForkName) -> Result<StateLayout>;

/// Checks the execution payload branch of one light-client header (`is_valid_light_client_header`, Capella and later).
///
/// # Errors
/// `UnsupportedFork`, `HeaderDecode` for a malformed header, `InvalidExecutionBranch(which)` for a bad branch.
pub fn verify_execution_branch(spec: &ChainSpec, header: &LightClientHeader, which: &'static str) -> Result<()> {
    execution_header_form_for_fork(spec.fork_at_slot(header.beacon.slot))?;
    let leaf = header.execution.hash_tree_root_for_slot(spec, header.beacon.slot)?;
    let valid = is_valid_normalized_merkle_branch(
        &leaf,
        &header.execution_branch,
        EXECUTION_PAYLOAD_GINDEX,
        &header.beacon.body_root,
    );
    if valid {
        return Ok(());
    }
    Err(Error::InvalidExecutionBranch(which))
}

/// Verifies a sync aggregate over `signed_root` (a beacon block root) with an explicit fork version.
///
/// The committee signs the root of the block that precedes the signing block. The domain is built from
/// `fork_version` and the genesis validators root of `spec`. The fork version is an input, not a table lookup.
/// This is safe: the domain is part of what the committee signed, so a wrong version gives no valid signature.
/// It does not check the participation threshold.
///
/// # Errors
/// Any [`Error`] from the BLS check.
pub fn verify_sync_aggregate(
    spec: &ChainSpec,
    committee: &SyncCommittee,
    aggregate: &SyncAggregate,
    signed_root: &B256,
    fork_version: [u8; 4],
) -> Result<()> {
    if committee.pubkeys.len() != SYNC_COMMITTEE_SIZE {
        return Err(Error::InvalidSyncCommitteeSize { actual: committee.pubkeys.len() });
    }
    let participants: Vec<_> = committee
        .pubkeys
        .iter()
        .enumerate()
        .filter(|(index, _)| aggregate.is_set(*index))
        .map(|(_, key)| *key)
        .collect();
    let domain = compute_domain(DOMAIN_SYNC_COMMITTEE, fork_version, &spec.genesis_validators_root);
    let signing_root = compute_signing_root(signed_root, &domain);
    fast_aggregate_verify(&participants, &signing_root, &aggregate.sync_committee_signature)
}

/// The fork version from the fork table of `spec`, for the slot before `signature_slot`.
pub fn table_fork_version(spec: &ChainSpec, signature_slot: u64) -> [u8; 4] {
    spec.fork_version_at(spec.epoch_at_slot(signature_slot.saturating_sub(1)))
}

/// Verifies an update against the store and returns the public output. The fork version comes from the table in `spec`.
///
/// # Errors
/// An [`Error`] naming the first failed rule.
pub fn verify_light_client_update(
    store: &LightClientStore,
    update: &LightClientUpdate,
    spec: &ChainSpec,
) -> Result<LightClientOutput> {
    advance_light_client_store(store, update, spec).map(|(output, _)| output)
}

/// Verifies an update with the fork version supplied by the caller (a private input of the guest program).
/// The per-fork table still selects the generalized indices.
///
/// # Errors
/// An [`Error`] naming the first failed rule. A wrong version gives `SignatureVerificationFailed`.
pub fn verify_light_client_update_with_fork_version(
    store: &LightClientStore,
    update: &LightClientUpdate,
    spec: &ChainSpec,
    fork_version: [u8; 4],
) -> Result<LightClientOutput> {
    verify_with_layout(store, update, spec, state_layout_for_fork, fork_version).map(|(output, _)| output)
}

/// Like [`verify_light_client_update`], and also returns the store after the update.
///
/// # Errors
/// An [`Error`] naming the first failed rule.
pub fn advance_light_client_store(
    store: &LightClientStore,
    update: &LightClientUpdate,
    spec: &ChainSpec,
) -> Result<(LightClientOutput, LightClientStore)> {
    verify_with_layout(store, update, spec, state_layout_for_fork, table_fork_version(spec, update.signature_slot))
}

/// Same as [`advance_light_client_store`] with a caller supplied layout selector and fork version. Used by the wrong-fork tests.
///
/// # Errors
/// An [`Error`] naming the first failed rule.
pub fn verify_with_layout(
    store: &LightClientStore,
    update: &LightClientUpdate,
    spec: &ChainSpec,
    select_layout: StateLayoutSelector,
    fork_version: [u8; 4],
) -> Result<(LightClientOutput, LightClientStore)> {
    let attested = &update.attested_header;
    let finalized = &update.finalized_header;

    // Participation: two thirds of 512.
    let participants = update.sync_aggregate.participant_count();
    if participants < MIN_PARTICIPANTS {
        return Err(Error::InsufficientParticipation { participants });
    }

    // Slot order: signature_slot > attested >= finalized, and the head strictly advances.
    if update.signature_slot <= attested.beacon.slot {
        return Err(Error::InvalidSlotOrder("signature slot must be after the attested slot"));
    }
    if attested.beacon.slot < finalized.beacon.slot {
        return Err(Error::InvalidSlotOrder("attested slot must not be before the finalized slot"));
    }
    if finalized.beacon.slot == GENESIS_SLOT {
        return Err(Error::NotFinalizedProgress("the finalized header is the genesis header"));
    }
    if finalized.beacon.slot <= store.header_slot {
        return Err(Error::NotFinalizedProgress("the finalized slot is not after the stored head"));
    }

    // Both headers must be valid light-client headers of a supported fork.
    verify_execution_branch(spec, attested, "attested")?;
    verify_execution_branch(spec, finalized, "finalized")?;

    // Periods: store period sp, finalized period np, attested period ap, signature period sig.
    let store_period = spec.period_at_slot(store.header_slot);
    let new_period = spec.period_at_slot(finalized.beacon.slot);
    let attested_period = spec.period_at_slot(attested.beacon.slot);
    let signature_period = spec.period_at_slot(update.signature_slot);
    if new_period != store_period && new_period != store_period + 1 {
        return Err(Error::PeriodOutOfRange("the finalized header is more than one period past the stored head"));
    }
    if signature_period != store_period && signature_period != store_period + 1 {
        return Err(Error::PeriodOutOfRange("the signature is more than one period past the stored head"));
    }
    // The store is private input. The output binds only its current committee (previousSyncCommitteeHash). A signature
    // by the stored NEXT committee is safe only when the output exposes that committee as syncCommitteeHash, and that
    // happens only when the finalized header crosses into the next period. Otherwise an attacker could sign with an
    // invented next committee that nothing public names.
    if signature_period == store_period + 1 && new_period == store_period {
        return Err(Error::SignatureInNextPeriodWithoutCrossing);
    }
    if (new_period == store_period + 1 || signature_period == store_period + 1) && store.next_sync_committee.is_none() {
        return Err(Error::NextSyncCommitteeUnknown);
    }

    // State proofs from the attested state root. The layout follows the fork of the attested slot.
    let layout = select_layout(spec.fork_at_slot(attested.beacon.slot))?;
    let finalized_root = finalized.beacon.hash_tree_root();
    if !is_valid_normalized_merkle_branch(
        &finalized_root,
        &update.finality_branch,
        layout.finalized_root_gindex,
        &attested.beacon.state_root,
    ) {
        return Err(Error::InvalidFinalityBranch);
    }

    let mut proven_next_hash = None;
    if let Some(next) = &update.next_sync_committee {
        let committee_root = next.committee.hash_tree_root()?;
        if !is_valid_normalized_merkle_branch(
            &committee_root,
            &next.branch,
            layout.next_sync_committee_gindex,
            &attested.beacon.state_root,
        ) {
            return Err(Error::InvalidNextSyncCommitteeBranch);
        }
        if attested_period == store_period {
            if let Some(known) = &store.next_sync_committee {
                if known != &next.committee {
                    return Err(Error::NextSyncCommitteeMismatch);
                }
            }
        }
        if attested_period == new_period {
            proven_next_hash = Some(committee_root);
        }
    }

    // The signing committee: the stored current one (bound by previousSyncCommitteeHash), or, after a period crossing,
    // the stored next one (exposed as syncCommitteeHash). The check above rules out any other case.
    let signing_committee = if signature_period == store_period {
        &store.current_sync_committee
    } else {
        store.next_sync_committee.as_ref().ok_or(Error::NextSyncCommitteeUnknown)?
    };
    verify_sync_aggregate(
        spec,
        signing_committee,
        &update.sync_aggregate,
        &attested.beacon.hash_tree_root(),
        fork_version,
    )?;

    // Output.
    let previous_committee_hash = store.current_sync_committee.hash_tree_root()?;
    let new_committee = if new_period == store_period {
        &store.current_sync_committee
    } else {
        store.next_sync_committee.as_ref().ok_or(Error::NextSyncCommitteeUnknown)?
    };
    let new_committee_hash =
        if new_period == store_period { previous_committee_hash } else { new_committee.hash_tree_root()? };
    // nextSyncCommitteeHash is non-zero only when THIS update proves the next committee against the attested state.
    // The stored next committee is private and unbound, so it must never reach this field. The contract relies on:
    // when the new period is headPeriod + 1 it requires syncCommittees[headPeriod + 1] to be non-zero and equal to
    // syncCommitteeHash, and it fills an empty next slot only from a non-zero nextSyncCommitteeHash.
    let next_hash = proven_next_hash.unwrap_or(B256::ZERO);

    let output = LightClientOutput {
        genesisValidatorsRoot: spec.genesis_validators_root,
        previousHeaderRoot: store.header_root,
        previousHeadSlot: store.header_slot,
        previousSyncCommitteeHash: previous_committee_hash,
        newHeaderRoot: finalized_root,
        newHeadSlot: finalized.beacon.slot,
        executionBlockHash: finalized.execution.block_hash,
        executionBlockNumber: finalized.execution.block_number,
        syncCommitteeHash: new_committee_hash,
        nextSyncCommitteeHash: next_hash,
    };

    // The store after the update.
    let proven_next = update
        .next_sync_committee
        .as_ref()
        .filter(|_| attested_period == new_period)
        .map(|next| next.committee.clone());
    let advanced = if new_period == store_period {
        LightClientStore {
            header_root: finalized_root,
            header_slot: finalized.beacon.slot,
            current_sync_committee: store.current_sync_committee.clone(),
            next_sync_committee: proven_next.or_else(|| store.next_sync_committee.clone()),
        }
    } else {
        LightClientStore {
            header_root: finalized_root,
            header_slot: finalized.beacon.slot,
            current_sync_committee: new_committee.clone(),
            next_sync_committee: proven_next,
        }
    };
    Ok((output, advanced))
}

/// Verifies the bootstrap of a store: the committee branch of the header state root.
///
/// The bridge starts from a checkpoint that people check by hand (the contract constructor). This helper lets a
/// tool confirm that a bootstrap served by a beacon API is internally consistent before the tool builds a store.
///
/// # Errors
/// `InvalidCurrentSyncCommitteeBranch` when the branch fails.
pub fn verify_current_sync_committee_branch(
    spec: &ChainSpec,
    header: &crate::types::BeaconBlockHeader,
    committee: &SyncCommittee,
    branch: &[B256],
) -> Result<()> {
    let layout = state_layout_for_fork(spec.fork_at_slot(header.slot))?;
    let leaf = committee.hash_tree_root()?;
    if is_valid_normalized_merkle_branch(&leaf, branch, layout.current_sync_committee_gindex, &header.state_root) {
        return Ok(());
    }
    Err(Error::InvalidCurrentSyncCommitteeBranch)
}
