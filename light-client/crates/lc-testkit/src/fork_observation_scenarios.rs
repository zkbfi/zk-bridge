//! Scenarios and fixtures for the fork-observation program. Everything here is SYNTHETIC (generated committees).
//! The tests are in `tests/fork_observation.rs`. The fixtures for the Solidity side are built by [`fork_observation_fixtures`].

use crate::synthetic::{build_update, committee_for, sign_with_first_members, TestCommittee, UpdateRecipe};
use alloy_primitives::B256;
use alloy_sol_types::SolValue;
use lc_core::chain::{ChainSpec, DOMAIN_SYNC_COMMITTEE, ETHEREUM_MAINNET, PULSECHAIN};
use lc_core::layout::{FIRST_DISALLOWED_DEPTH, MAX_SEAL_DEPTH};
use lc_core::layout::{SHAPE_PLAIN_DEPTH_FIVE, SHAPE_PLAIN_DEPTH_SEVEN, SHAPE_PLAIN_DEPTH_SIX, SHAPE_PROGRESSIVE};
use lc_core::observation::fork_version_leaf;
use lc_core::observation::{verify_fork_observation, Observation};
use lc_core::ssz::{branch_for_leaf, branch_for_leaf_with_limit, progressive_container_branch, sha256};
use lc_core::types::{compute_domain, compute_signing_root, BeaconBlockHeader, LightClientStore, LightClientUpdate};
use lc_core::update::{table_fork_version, verify_light_client_update, FoldStep};
use serde_json::{json, Value};

/// (chain, period of the initial store). Both periods are far from every fork boundary.
pub fn chains() -> [(&'static ChainSpec, u64); 2] {
    [(&PULSECHAIN, 1326), (&ETHEREUM_MAINNET, 1889)]
}

/// A fork version that is in no fork table: `0x0000036d` on PulseChain, `0x08000000` on Ethereum (`0x07000000` is already a table row: Gloas, never scheduled).
pub fn version_outside_table(spec: &ChainSpec) -> [u8; 4] {
    if spec.name == "pulsechain" {
        [0, 0, 0x03, 0x6d]
    } else {
        [0x08, 0, 0, 0]
    }
}

/// The hash tree root of the synthetic committee of a period.
pub fn committee_hash(spec: &ChainSpec, period: u64) -> B256 {
    committee_for(spec, period).committee.hash_tree_root().expect("committee root")
}

/// The first slot of a sync committee period.
#[derive(Clone, Copy, Debug)]
pub struct PeriodStart(pub u64);

impl PeriodStart {
    /// The first slot of `period` on `spec`.
    pub fn of(spec: &ChainSpec, period: u64) -> Self {
        Self(period * spec.epochs_per_sync_committee_period * spec.slots_per_epoch)
    }

    /// A slot `offset` slots into the period that is `periods_after` periods after this one.
    pub fn slot_in_period(self, periods_after: u64, offset: u64) -> u64 {
        // All synthetic scenarios use 8192-slot periods on both chains.
        self.0 + periods_after * 8192 + offset
    }
}

/// A store, one update that stays inside the store's period, and the facts needed to observe after it.
pub struct OneStepScenario {
    /// The chain.
    pub spec: &'static ChainSpec,
    /// The store before the update. Its head is `start + 400`. It has no next committee.
    pub store: LightClientStore,
    /// An update that finalizes `start + 1000` and proves the next committee.
    pub update: LightClientUpdate,
    period: u64,
}

impl OneStepScenario {
    /// A slot after the head, in the store's period: `start + 2000`.
    pub fn attested_slot(&self) -> u64 {
        PeriodStart::of(self.spec, self.period).slot_in_period(0, 2000)
    }

    /// The committee of the store's period (the bound current committee).
    pub fn committee_for_signature(&self) -> std::sync::Arc<TestCommittee> {
        committee_for(self.spec, self.period)
    }
}

/// Builds the [`OneStepScenario`] for a chain and period.
pub fn one_step_scenario(spec: &'static ChainSpec, period: u64) -> OneStepScenario {
    let start = PeriodStart::of(spec, period).0;
    let scenario = build_update(spec, inside_period(start, 400, 1000, true));
    OneStepScenario { spec, store: scenario.store, update: scenario.update, period }
}

/// A store three periods behind and three updates that bring it forward (period P, P+1, P+2). The last update proves P+3.
pub struct StaleScenario {
    /// The chain.
    pub spec: &'static ChainSpec,
    /// The stale store (period P, no next committee).
    pub store: LightClientStore,
    /// Three updates.
    pub updates: Vec<LightClientUpdate>,
    period: u64,
}

impl StaleScenario {
    /// The slot of the head after the last update.
    pub fn final_head_slot(&self) -> u64 {
        self.updates[2].finalized_header.beacon.slot
    }

    /// The committee of the final head's period (P+2).
    pub fn final_committee(&self) -> std::sync::Arc<TestCommittee> {
        committee_for(self.spec, self.period + 2)
    }
}

/// Builds the [`StaleScenario`].
pub fn stale_three_period_scenario(spec: &'static ChainSpec, period: u64) -> StaleScenario {
    let start = PeriodStart::of(spec, period).0;
    let first = build_update(spec, inside_period(start, 400, 1000, true));
    let second = build_update(spec, crossing_into(start + 8192, first.update.finalized_header.beacon.slot, 64));
    let third = build_update(spec, crossing_into(start + 2 * 8192, second.update.finalized_header.beacon.slot, 64));
    StaleScenario { spec, store: first.store, updates: vec![first.update, second.update, third.update], period }
}

fn inside_period(period_start: u64, store_offset: u64, finalized_offset: u64, include_next: bool) -> UpdateRecipe {
    UpdateRecipe {
        store_slot: period_start + store_offset,
        finalized_slot: period_start + finalized_offset,
        attested_slot: period_start + finalized_offset + 70,
        signature_slot: period_start + finalized_offset + 71,
        participants: 342,
        include_next_committee: include_next,
        store_knows_next_committee: false,
    }
}

fn crossing_into(finalized_period_start: u64, store_slot: u64, finalized_offset: u64) -> UpdateRecipe {
    UpdateRecipe {
        store_slot,
        finalized_slot: finalized_period_start + finalized_offset,
        attested_slot: finalized_period_start + finalized_offset + 66,
        signature_slot: finalized_period_start + finalized_offset + 67,
        participants: 342,
        include_next_committee: true,
        store_knows_next_committee: false,
    }
}

/// Fold steps with the table fork version of each update.
pub fn fold_steps(spec: &ChainSpec, updates: &[LightClientUpdate]) -> Vec<FoldStep> {
    updates
        .iter()
        .map(|update| FoldStep {
            update: update.clone(),
            fork_version: table_fork_version(spec, update.signature_slot),
        })
        .collect()
}

/// The synthetic header at `slot` that the observations sign, over the state root `state_root`.
pub fn observed_header(slot: u64, state_root: B256) -> BeaconBlockHeader {
    BeaconBlockHeader {
        slot,
        proposer_index: 7,
        parent_root: B256::repeat_byte(0x5a),
        state_root,
        body_root: B256::repeat_byte(0x5c),
    }
}

/// Field index of `genesis_validators_root` in a `BeaconState`. It is written here, not imported, so a mistake in
/// `lc_core::layout` is not copied into the builder.
const STATE_FIELD_GENESIS_VALIDATORS_ROOT: usize = 1;
/// Field index of `fork` in a `BeaconState`.
const STATE_FIELD_FORK: usize = 3;
/// Position of `current_version` among the three fields of `Fork`.
const FORK_FIELD_CURRENT_VERSION: usize = 1;

/// The shape of the attested state of an honest observation on `spec`: plain depth 5 on PulseChain (Capella state), plain
/// depth 6 on Ethereum (Electra and Fulu state).
pub fn honest_shape(spec: &ChainSpec) -> u8 {
    if spec.name == "pulsechain" {
        SHAPE_PLAIN_DEPTH_FIVE
    } else {
        SHAPE_PLAIN_DEPTH_SIX
    }
}

/// How many leaves the state tree of `shape` has: 28, 37 and 70 fields for plain depths 5, 6 and 7, 46 chunks for
/// the progressive Gloas state, and 130 fields for every disallowed plain depth (8 to 31; more than 128 fields need depth 8).
///
/// # Panics
/// Panics for a value that is no shape.
pub fn state_field_count_for_shape(shape: u8) -> usize {
    match shape {
        SHAPE_PLAIN_DEPTH_FIVE => 28,
        SHAPE_PLAIN_DEPTH_SIX => 37,
        SHAPE_PLAIN_DEPTH_SEVEN => 70,
        SHAPE_PROGRESSIVE => 46,
        deeper if is_disallowed_plain_depth(deeper) => DISALLOWED_DEPTH_FIELD_COUNT,
        other => panic!("{other} is no state shape"),
    }
}

/// The field count of a state of a disallowed plain depth. It is above 128, so a depth 8 tree is the smallest that holds it.
const DISALLOWED_DEPTH_FIELD_COUNT: usize = 130;

/// Whether `shape` is a plain depth from 8 to 31: a depth that the light client refuses and the observation proves.
pub fn is_disallowed_plain_depth(shape: u8) -> bool {
    (FIRST_DISALLOWED_DEPTH..=MAX_SEAL_DEPTH).contains(&u32::from(shape))
}

/// The branch of leaf `index` of the state tree of `shape`: progressive, plain of depth 5 to 7 (padded to a power of two),
/// or plain of a disallowed depth (a zero padded tree of `2^shape` leaves).
fn state_branch(shape: u8, leaves: &[B256], index: usize) -> (B256, Vec<B256>) {
    match shape {
        SHAPE_PROGRESSIVE => progressive_container_branch(leaves, index),
        deeper if is_disallowed_plain_depth(deeper) => branch_for_leaf_with_limit(leaves, index, u32::from(deeper)),
        _ => branch_for_leaf(leaves, index),
    }
}

/// A state of an honest observation: its root and the two branches that the observation carries.
#[derive(Clone, Debug)]
pub struct ObservedState {
    /// The state root. The attested header carries it.
    pub root: B256,
    /// The branch of `fork.current_version` (the leaf is the version, left-aligned): 7 to 33 entries.
    pub current_version_branch: Vec<B256>,
    /// The branch of `genesis_validators_root`: 5, 6, 7 or 5 entries, or 8 to 31 for a disallowed plain depth.
    pub genesis_validators_root_branch: Vec<B256>,
}

/// Builds the state of `shape` that holds `spec.genesis_validators_root` in field 1 and a `Fork` with `version` as its
/// current version in field 3. Every other field is a distinct filler hash.
///
/// # Panics
/// Panics for a value that is no state shape.
pub fn observed_state(spec: &ChainSpec, shape: u8, version: [u8; 4]) -> ObservedState {
    let mut leaves: Vec<B256> = (0..state_field_count_for_shape(shape))
        .map(|index| sha256(format!("observed-state-field/{index}").as_bytes()))
        .collect();
    leaves[STATE_FIELD_GENESIS_VALIDATORS_ROOT] = spec.genesis_validators_root;
    let fork_leaves = [sha256(b"previous-version"), fork_version_leaf(version), sha256(b"fork-epoch")];
    let (fork_root, fork_branch) = branch_for_leaf(&fork_leaves, FORK_FIELD_CURRENT_VERSION);
    leaves[STATE_FIELD_FORK] = fork_root;
    let branch_in_state = |index: usize| state_branch(shape, &leaves, index);
    let (root, state_branch) = branch_in_state(STATE_FIELD_FORK);
    let (_, genesis_validators_root_branch) = branch_in_state(STATE_FIELD_GENESIS_VALIDATORS_ROOT);
    ObservedState { root, current_version_branch: [fork_branch, state_branch].concat(), genesis_validators_root_branch }
}

/// An observation that the first `count` members of `signer` sign under `version`, over an attested state of the honest
/// shape of `spec` ([`honest_shape`]). The attested header is at `attested_slot` and the aggregate rides in the block of
/// the next slot.
pub fn observation_signed_by(
    spec: &ChainSpec,
    signer: &TestCommittee,
    version: [u8; 4],
    count: usize,
    attested_slot: u64,
) -> Observation {
    observation_on_shape(spec, honest_shape(spec), signer, version, count, attested_slot)
}

/// Like [`observation_signed_by`], over an attested state of the given `shape` (5, 6, 7, 255, or a plain depth from 8 to 31).
pub fn observation_on_shape(
    spec: &ChainSpec,
    shape: u8,
    signer: &TestCommittee,
    version: [u8; 4],
    count: usize,
    attested_slot: u64,
) -> Observation {
    let state = observed_state(spec, shape, version);
    observation_over_state(spec, state, signer, version, version, count, attested_slot)
}

/// An observation over a state chosen by the caller. The first `count` members of `signer` sign the attested header under
/// `signed_version`, and the observation names `named_version`. An honest observation has both equal, and a state that holds
/// that version. A test sets them apart to build an attack: a state that holds another version than the one signed, or a
/// name that differs from the signature.
pub fn observation_over_state(
    spec: &ChainSpec,
    state: ObservedState,
    signer: &TestCommittee,
    signed_version: [u8; 4],
    named_version: [u8; 4],
    count: usize,
    attested_slot: u64,
) -> Observation {
    let domain = compute_domain(DOMAIN_SYNC_COMMITTEE, signed_version, &spec.genesis_validators_root);
    let attested_header = observed_header(attested_slot, state.root);
    let signing_root = compute_signing_root(&attested_header.hash_tree_root(), &domain);
    Observation {
        attested_header,
        signature_slot: attested_slot + 1,
        sync_aggregate: sign_with_first_members(signer, count, &signing_root),
        fork_version: named_version,
        current_version_branch: state.current_version_branch,
        genesis_validators_root_branch: state.genesis_validators_root_branch,
    }
}

fn hex_word(value: &B256) -> String {
    format!("0x{}", alloy_primitives::hex::encode(value))
}

fn start_store_json(store: &LightClientStore) -> Value {
    let next = store.next_sync_committee.as_ref().map(|committee| committee.hash_tree_root().expect("root"));
    json!({
        "headerRoot": hex_word(&store.header_root),
        "headSlot": store.header_slot.to_string(),
        "currentSyncCommitteeHash": hex_word(&store.current_sync_committee.hash_tree_root().expect("root")),
        "nextSyncCommitteeHash": hex_word(&next.unwrap_or(B256::ZERO)),
    })
}

fn chain_name(spec: &ChainSpec) -> &'static str {
    if spec.name == "pulsechain" {
        "pulsechain"
    } else {
        "ethereum"
    }
}

/// What the registry contract holds, as the fixture states it. `lightClient*` fields are what `lightClient.headers`,
/// `syncCommittees` and `headSlot()` return for the case.
fn accept_case(
    name: &str,
    description: &str,
    spec: &ChainSpec,
    store: &LightClientStore,
    observation: &Observation,
    steps: &[FoldStep],
) -> Value {
    let output = verify_fork_observation(store, steps, observation, spec).expect("accepted");
    let start = start_store_json(store);
    json!({
        "name": name,
        "description": description,
        "chain": chain_name(spec),
        "publicValues": format!("0x{}", alloy_primitives::hex::encode(output.abi_encode())),
        "observedVersion": format!("0x{}", alloy_primitives::hex::encode(output.observedVersion.0)),
        "observedAttestedSlot": output.observedAttestedSlot.to_string(),
        "observedShape": output.shape,
        "versionInProgramTable": spec.fork_schedule.iter().any(|entry| entry.fork_version == observation.fork_version),
        "startStore": start,
        "lightClient": {
            "headSlot": store.header_slot.to_string(),
            "headerRoot": start["headerRoot"],
            "currentSyncCommitteeHash": start["currentSyncCommitteeHash"],
            "nextSyncCommitteeHash": start["nextSyncCommitteeHash"],
        },
        "expected": { "result": "accept" },
    })
}

fn program_reject_case(name: &str, description: &str, spec: &ChainSpec, reason: &str) -> Value {
    json!({
        "name": name,
        "description": description,
        "chain": chain_name(spec),
        "publicValues": null,
        "expected": { "result": "no-proof-exists", "reason": reason },
    })
}

fn contract_reject_case(
    base: &Value,
    name: &str,
    description: &str,
    reason: &str,
    edit: impl FnOnce(&mut Value),
) -> Value {
    let mut case = base.clone();
    case["name"] = json!(name);
    case["description"] = json!(description);
    case["expected"] = json!({ "result": "reject", "reason": reason });
    edit(&mut case);
    case
}

/// The fixtures the Solidity registry tests read, one `(file stem, json)` per case.
pub fn fork_observation_fixtures() -> Vec<(String, Value)> {
    let mut cases = Vec::new();
    for (spec, period) in chains() {
        let chain = chain_name(spec);
        let scenario = one_step_scenario(spec, period);
        let signer = scenario.committee_for_signature();
        let slot = scenario.attested_slot();
        let unknown = version_outside_table(spec);
        let observation = observation_signed_by(spec, &signer, unknown, 400, slot);
        let base = accept_case(
            &format!("{chain}_accept_version_outside_the_table"),
            "An observation under a fork version that the program table does not hold. The output names that version.",
            spec,
            &scenario.store,
            &observation,
            &[],
        );
        cases.push(base.clone());
        let known = table_fork_version(spec, slot);
        let known_observation = observation_signed_by(spec, &signer, known, 400, slot);
        cases.push(accept_case(
            &format!("{chain}_accept_version_in_the_table"),
            "An observation under the current table version. The registry records it like any other.",
            spec,
            &scenario.store,
            &known_observation,
            &[],
        ));
        let stale = stale_three_period_scenario(spec, period);
        let stale_slot = stale.final_head_slot() + 100;
        let stale_observation = observation_signed_by(spec, &stale.final_committee(), unknown, 400, stale_slot);
        cases.push(accept_case(
            &format!("{chain}_accept_after_folding_a_stale_store"),
            "The start store is three periods stale. Three fold steps bring it forward, then the observation. The output binds the START store.",
            spec,
            &stale.store,
            &stale_observation,
            &fold_steps(spec, &stale.updates),
        ));
        let deeper_observation = observation_on_shape(
            spec,
            FIRST_DISALLOWED_DEPTH as u8,
            &stale.final_committee(),
            unknown,
            400,
            stale_slot,
        );
        cases.push(accept_case(
            &format!("{chain}_accept_plain_depth_eight_after_folding_a_stale_store"),
            "The attested state is a plain tree of depth 8 (more than 128 fields), a shape the light client refuses. Every fold step is before the fork, in a layout the light client accepts. The observation proves the shape 8 and the output reports it.",
            spec,
            &stale.store,
            &deeper_observation,
            &fold_steps(spec, &stale.updates),
        ));

        cases.push(contract_reject_case(
            &base,
            &format!("{chain}_reject_start_committee_differs"),
            "The proof starts from a current committee that the light client does not store.",
            "StartMismatch",
            |case| {
                case["lightClient"]["currentSyncCommitteeHash"] = json!(hex_word(&B256::repeat_byte(0xee)));
            },
        ));
        cases.push(contract_reject_case(
            &base,
            &format!("{chain}_reject_start_next_committee_differs"),
            "The proof starts from no next committee (zero) but the light client stores one.",
            "StartMismatch",
            |case| {
                case["lightClient"]["nextSyncCommitteeHash"] = json!(hex_word(&B256::repeat_byte(0xdd)));
            },
        ));
        cases.push(contract_reject_case(
            &base,
            &format!("{chain}_reject_start_header_differs"),
            "The proof starts from a header root that the light client does not store for that head slot.",
            "StartMismatch",
            |case| {
                case["lightClient"]["headerRoot"] = json!(hex_word(&B256::repeat_byte(0xcc)));
            },
        ));
        let observed_slot = slot;
        cases.push(contract_reject_case(
            &base,
            &format!("{chain}_reject_not_fresh"),
            "The light client head is at or after the observed attested slot, so the signature may be old (a replay).",
            "NotFresh",
            move |case| {
                case["lightClient"]["headSlot"] = json!(observed_slot.to_string());
            },
        ));
        let updated = verify_light_client_update(&scenario.store, &scenario.update, spec).expect("update").abi_encode();
        let light_client_output_length = updated.len();
        cases.push(contract_reject_case(
            &base,
            &format!("{chain}_reject_light_client_output_as_public_values"),
            "The public values are a LightClientOutput (352 bytes). An observation is exactly 256 bytes.",
            "WrongLength",
            move |case| {
                case["publicValues"] = json!(format!("0x{}", alloy_primitives::hex::encode(&updated)));
            },
        ));
        assert_eq!(light_client_output_length, 352);

        // Rejections the program itself makes: no proof exists, so the contract never sees them.
        cases.push(program_reject_case(
            &format!("{chain}_no_proof_341_signers"),
            "Only 341 of 512 members sign.",
            spec,
            "InsufficientParticipation",
        ));
        cases.push(program_reject_case(
            &format!("{chain}_no_proof_unbound_committee"),
            "An invented committee signs. No public value binds it.",
            spec,
            "SignatureVerificationFailed",
        ));
        cases.push(program_reject_case(
            &format!("{chain}_no_proof_signature_not_after_the_head"),
            "The attested slot is at or before the final head.",
            spec,
            "InvalidSlotOrder",
        ));
        cases.push(program_reject_case(
            &format!("{chain}_no_proof_next_period_without_crossing"),
            "A next-period signature with no crossing in the fold.",
            spec,
            "SignatureInNextPeriodWithoutCrossing",
        ));
        cases.push(program_reject_case(
            &format!("{chain}_no_proof_other_chain_genesis_validators_root"),
            "The signature was made for the other chain.",
            spec,
            "SignatureVerificationFailed",
        ));
    }
    cases.into_iter().map(|case| (case["name"].as_str().expect("name").to_string(), case)).collect()
}
