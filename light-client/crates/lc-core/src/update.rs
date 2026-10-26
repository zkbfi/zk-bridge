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
//! - `startNextSyncCommitteeHash` is the hash of the store's next committee, or zero when the store has none. It binds the
//!   private starting next committee, so a contract can refuse an invented one.
//!
//! The contract rules behind this are in `docs/hardened-build-contract.md`, section "Change: historical ancestry and
//! folded updates". A fold ([`verify_fold_with_layout`]) applies 1 to 64 updates in order and carries the store from
//! step to step. Its output describes the whole fold: `previous*` and `startNextSyncCommitteeHash` the initial store,
//! `new*`, `executionBlock*` and `syncCommitteeHash` the final store, and `nextSyncCommitteeHash` the final next committee
//! only if a step of the fold proved it.
//!
//! The wall clock check `current_slot >= signature_slot` of the specification cannot run inside a proof (no clock).
//! The contract enforces it instead: `BeaconLightClient.update` refuses a new head slot later than the current slot
//! (`HeadInFuture`), computed from the immutable genesis time and seconds per slot. A dishonest committee can sign a
//! header from the future, so the program alone cannot exclude it.

use crate::abi::LightClientOutput;
use crate::bls::verify_aggregate_by_subtraction;
use crate::chain::DOMAIN_SYNC_COMMITTEE;
use crate::chain::{ChainSpec, ForkName, GENESIS_SLOT, MIN_PARTICIPANTS, SYNC_COMMITTEE_SIZE};
use crate::error::{Error, Result};
use crate::layout::{execution_header_form_for_fork, state_layout_for_fork, StateLayout, EXECUTION_PAYLOAD_GINDEX};
use crate::profile::tracked;
use crate::ssz::is_valid_normalized_merkle_branch;
use crate::types::{
    compute_domain, compute_signing_root, HeaderForm, LightClientHeader, LightClientStore, LightClientUpdate,
    SyncAggregate, SyncCommittee,
};
use alloy_primitives::B256;

/// The most updates one fold holds. Each update costs one BLS check, so the cost grows linearly with the count.
pub const MAX_FOLD_UPDATES: usize = 64;

/// One step of a fold: an update and the fork version of its signing domain (a private input, see
/// [`verify_light_client_update_with_fork_version`]).
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct FoldStep {
    /// The update.
    pub update: LightClientUpdate,
    /// The fork version of the signing domain of this update.
    pub fork_version: [u8; 4],
}

/// Chooses the beacon state layout for the fork of the attested header. Tests replace it to model the "wrong fork" attack.
pub type StateLayoutSelector = fn(crate::chain::ForkName) -> Result<StateLayout>;

/// [`is_valid_normalized_merkle_branch`] under the profile label `merkle_branch`.
fn branch_is_valid(leaf: &B256, branch: &[B256], gindex: u64, root: &B256) -> bool {
    tracked("merkle_branch", || is_valid_normalized_merkle_branch(leaf, branch, gindex, root))
}

/// Checks the execution branch of one light-client header (`is_valid_light_client_header`, Capella and later).
///
/// Full form: the payload header is hashed and the branch is checked at generalized index 25 (`EXECUTION_PAYLOAD_GINDEX`).
/// A full header in a Gloas epoch is refused, because Gloas has no payload header.
///
/// Compact form (Gloas light-client objects): `execution_block_hash` is the leaf, and the index follows the epoch of the
/// header's OWN slot: 2856 in a Gloas epoch, 812 from Deneb to Fulu, 412 in Capella
/// ([`compact_block_hash_gindex_for_fork`]). A header before Capella is refused, and so is a zero block hash.
///
/// # Errors
/// `UnsupportedFork`, `HeaderDecode` for a malformed header, `ZeroExecutionBlockHash(which)`,
/// `InvalidExecutionBranch(which)` for a bad branch.
pub fn verify_execution_branch(spec: &ChainSpec, header: &LightClientHeader, which: &'static str) -> Result<()> {
    let fork = spec.fork_at_slot(header.beacon.slot);
    if fork >= ForkName::Gloas {
        return Err(Error::GloasPayloadNotFinalized);
    }
    let (leaf, gindex) = match header.form {
        HeaderForm::Full => {
            execution_header_form_for_fork(fork)?;
            (header.execution.hash_tree_root_for_slot(spec, header.beacon.slot)?, EXECUTION_PAYLOAD_GINDEX)
        }
        HeaderForm::Compact => return Err(Error::GloasPayloadNotFinalized),
    };
    if branch_is_valid(&leaf, &header.execution_branch, gindex, &header.beacon.body_root) {
        return Ok(());
    }
    Err(Error::InvalidExecutionBranch(which))
}

/// Refuses every Gloas input and every compact header.
///
/// Fail closed. Under Gloas the execution payload is revealed apart from the beacon block and may be withheld. The compact
/// header carries the bid's `parent_block_hash`, which is not the execution block of the slot, and no block number. A
/// message proof anchored to it would not be sound. The refusal covers the attested slot, the finalized slot, the
/// signature slot and the form of both headers, so no Gloas data reaches an output.
///
/// # Errors
/// `GloasPayloadNotFinalized`.
fn refuse_gloas(spec: &ChainSpec, update: &LightClientUpdate) -> Result<()> {
    let slots = [update.attested_header.beacon.slot, update.finalized_header.beacon.slot, update.signature_slot];
    let in_gloas_epoch = slots.iter().any(|slot| spec.fork_at_slot(*slot) >= ForkName::Gloas);
    let compact =
        update.attested_header.form == HeaderForm::Compact || update.finalized_header.form == HeaderForm::Compact;
    if in_gloas_epoch || compact {
        return Err(Error::GloasPayloadNotFinalized);
    }
    Ok(())
}

/// Verifies a sync aggregate over `signed_root` (a beacon block root) with an explicit fork version.
///
/// The committee signs the root of the block that precedes the signing block. The domain is built from
/// `fork_version` and the genesis validators root of `spec`. The fork version is an input, not a table lookup.
/// This is safe: the domain is part of what the committee signed, so a wrong version gives no valid signature.
/// It does not check the participation threshold. The signer key comes from `committee.aggregate_pubkey`, which the
/// committee hash binds (see [`verify_aggregate_by_subtraction`]), so the caller must use a committee that the output binds.
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
    let absent: Vec<usize> = (0..SYNC_COMMITTEE_SIZE).filter(|index| !aggregate.is_set(*index)).collect();
    let domain = compute_domain(DOMAIN_SYNC_COMMITTEE, fork_version, &spec.genesis_validators_root);
    let signing_root = compute_signing_root(signed_root, &domain);
    verify_aggregate_by_subtraction(
        &committee.aggregate_pubkey,
        &committee.pubkeys,
        &absent,
        &signing_root,
        &aggregate.sync_committee_signature,
    )
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

    // Both headers must be valid light-client headers of a supported fork, in the shape the attested fork dictates.
    refuse_gloas(spec, update)?;
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
    if !branch_is_valid(
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
        if !branch_is_valid(
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
    let start_next_hash = match &store.next_sync_committee {
        Some(committee) => committee.hash_tree_root()?,
        None => B256::ZERO,
    };
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
        startNextSyncCommitteeHash: start_next_hash,
        newHeaderRoot: finalized_root,
        newHeadSlot: finalized.beacon.slot,
        executionBlockHash: finalized.execution_block_hash(),
        // 0 for a compact (Gloas) header, which has no block number. The contract stores the number only in a view.
        executionBlockNumber: finalized.execution_block_number(),
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

/// Applies 1 to 64 updates in order, carrying the store from step to step, and returns one output for the whole fold
/// with the store after the last step. Every step keeps every rule of [`verify_with_layout`], including "a next-period
/// signature needs a crossing" and "a crossing needs a known next committee". When the initial store has no next
/// committee, the first crossing must come after a step that proves it.
///
/// Output: `previous*`, `startNextSyncCommitteeHash` and `genesisValidatorsRoot` from the initial store; `new*`,
/// `executionBlock*` and `syncCommitteeHash` from the final store; `nextSyncCommitteeHash` is the final store's next
/// committee if a step in this fold proved it, else zero. A proof of the next committee in an earlier period does not
/// count after a crossing: the crossing makes that committee the current one.
///
/// # Errors
/// `FoldLengthOutOfRange` for an empty list or more than [`MAX_FOLD_UPDATES`]. Otherwise the first failed rule of a step.
pub fn verify_fold_with_layout(
    store: &LightClientStore,
    steps: &[FoldStep],
    spec: &ChainSpec,
    select_layout: StateLayoutSelector,
) -> Result<(LightClientOutput, LightClientStore)> {
    if steps.is_empty() || steps.len() > MAX_FOLD_UPDATES {
        return Err(Error::FoldLengthOutOfRange { count: steps.len() });
    }
    let mut current = store.clone();
    let mut first: Option<LightClientOutput> = None;
    let mut proven_next = B256::ZERO;
    let mut last_output = None;
    for step in steps {
        let store_period = spec.period_at_slot(current.header_slot);
        let (output, advanced) = verify_with_layout(&current, &step.update, spec, select_layout, step.fork_version)?;
        let crossed = spec.period_at_slot(output.newHeadSlot) != store_period;
        // A step that proves the next committee sets it. A crossing without a proof empties it. Otherwise it stays.
        if output.nextSyncCommitteeHash != B256::ZERO {
            proven_next = output.nextSyncCommitteeHash;
        } else if crossed {
            proven_next = B256::ZERO;
        }
        first.get_or_insert_with(|| output.clone());
        last_output = Some(output);
        current = advanced;
    }
    let (Some(first), Some(last)) = (first, last_output) else {
        return Err(Error::FoldLengthOutOfRange { count: 0 });
    };
    let output = LightClientOutput {
        genesisValidatorsRoot: first.genesisValidatorsRoot,
        previousHeaderRoot: first.previousHeaderRoot,
        previousHeadSlot: first.previousHeadSlot,
        previousSyncCommitteeHash: first.previousSyncCommitteeHash,
        startNextSyncCommitteeHash: first.startNextSyncCommitteeHash,
        newHeaderRoot: last.newHeaderRoot,
        newHeadSlot: last.newHeadSlot,
        executionBlockHash: last.executionBlockHash,
        executionBlockNumber: last.executionBlockNumber,
        syncCommitteeHash: last.syncCommitteeHash,
        nextSyncCommitteeHash: proven_next,
    };
    Ok((output, current))
}

/// A fold with the fork version of each step from the table in `spec`, and the per-fork layouts.
///
/// # Errors
/// See [`verify_fold_with_layout`].
pub fn verify_light_client_fold(
    store: &LightClientStore,
    updates: &[LightClientUpdate],
    spec: &ChainSpec,
) -> Result<(LightClientOutput, LightClientStore)> {
    let steps: Vec<FoldStep> = updates
        .iter()
        .map(|update| FoldStep {
            update: update.clone(),
            fork_version: table_fork_version(spec, update.signature_slot),
        })
        .collect();
    verify_fold_with_layout(store, &steps, spec, state_layout_for_fork)
}

/// A fold with the fork version of each step supplied by the caller (private inputs of the guest program).
///
/// # Errors
/// See [`verify_fold_with_layout`].
pub fn verify_light_client_fold_with_fork_versions(
    store: &LightClientStore,
    steps: &[FoldStep],
    spec: &ChainSpec,
) -> Result<LightClientOutput> {
    verify_fold_with_layout(store, steps, spec, state_layout_for_fork).map(|(output, _)| output)
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
