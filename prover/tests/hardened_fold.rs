//! A light client several sync committee periods behind catches up with ONE fold, on Anvil.
//!
//! The beacon data is synthetic but complete: the chain has real BLS committees that sign every update (`lc-testkit`),
//! and a fake beacon node serves them over the standard endpoints. The prover reads that node with `HttpBeaconSource`,
//! the same code that reads a live node. The oracle backend then runs the light-client program natively on the fold
//! (it refuses to sign when the program refuses) and signs the public values. The `BeaconLightClient` contract on Anvil
//! accepts the proof, and the test reads back its head and its committee hashes.
//!
//! What stays simulated: the proof system. The oracle verifier stands in for the SP1 verifier, so the test shows that
//! the program accepts the fold and that the contract accepts the program's output. It does not show a zero-knowledge
//! proof.

mod common;

use alloy_primitives::{keccak256, Address, B256};
use common::bridge::*;
use common::*;
use lc_core::chain::ForkName;
use lc_testkit::json::{beacon_header_json, light_client_update_json};
use lc_testkit::state_bytes::StateBytes;
use lc_testkit::synthetic::{committee_for, period_chain};
use serde_json::json;
use std::collections::HashMap;
use zk_bridge_prover::beacon::http::HttpBeaconSource;
use zk_bridge_prover::beacon::{BeaconSource, UpdatePlan};
use zk_bridge_prover::chain::ChainClient;
use zk_bridge_prover::contracts::{update_calldata, LightClientContract};
use zk_bridge_prover::error::{Error, Result};
use zk_bridge_prover::light_client::{
    committee_hash, header_root, verify_update_natively, BeaconHeader, ChainKind,
    LightClientOutput, LightClientUpdate, StateView, UpdateInput,
};
use zk_bridge_prover::prover::{ProofStatement, Prover};
use zk_bridge_prover::route::read_light_client_state_of;
use zk_bridge_prover::rpc::{HttpGet, HttpResponse};

/// Slots per sync committee period on both chains.
const PERIOD_SLOTS: u64 = 8192;
/// How many period borders the fold crosses: the light client starts in period P and ends in period P + 3.
const CROSSINGS: u64 = 3;

/// A beacon node held in memory: a map from path to body. An unknown path answers 404, as a node without the endpoint does.
struct SyntheticNode(HashMap<String, Vec<u8>>);

impl HttpGet for SyntheticNode {
    fn get(&self, path_and_query: &str, _accept: &str) -> Result<HttpResponse> {
        Ok(match self.0.get(path_and_query) {
            Some(body) => HttpResponse {
                status: 200,
                body: body.clone(),
            },
            None => HttpResponse {
                status: 404,
                body: b"{}".to_vec(),
            },
        })
    }
}

/// Whether the contract holds the committee of the period after the checkpoint when it is deployed.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum StoredNext {
    /// It holds none. The program starts from a store with no next committee.
    Unknown,
    /// It holds the committee of the next period. The program starts from a store that carries it, which the prover
    /// reads from the state of the head.
    Known,
}

/// A chain and the first period of the light client. The period lies far from every fork border of the chain.
#[derive(Clone, Copy, Debug)]
struct Scenario {
    chain: ChainKind,
    period: u64,
}

/// An Ethereum chain in its newest layout, and a PulseChain chain in the Capella layout.
const SCENARIOS: [Scenario; 2] = [
    Scenario {
        chain: ChainKind::Ethereum,
        period: 1889,
    },
    Scenario {
        chain: ChainKind::Pulsechain,
        period: 1326,
    },
];

/// A light client that lags `CROSSINGS` periods, and the beacon node that serves the chain it must follow.
struct LaggingLightClient {
    chain: TestChain,
    light_client: Address,
    source: HttpBeaconSource,
    updates: Vec<LightClientUpdate>,
    scenario: Scenario,
}

fn committee_hash_of(scenario: Scenario, period: u64) -> B256 {
    committee_hash(&committee_for(scenario.chain.spec(), period).committee).expect("committee hash")
}

fn json_body(value: serde_json::Value) -> Vec<u8> {
    value.to_string().into_bytes()
}

/// The answer of `/eth/v1/beacon/headers/<slot>` for a header.
fn header_page(header: &BeaconHeader) -> (String, Vec<u8>) {
    (
        format!("/eth/v1/beacon/headers/{}", header.slot),
        json_body(
            json!({ "data": { "root": format!("{:#x}", header_root(header)), "header": { "message": beacon_header_json(header) } } }),
        ),
    )
}

/// The pages of the fake node: the header of the checkpoint, the state of the checkpoint, the handoff update of each
/// period the fold crosses, the finality update that ends the chain, and the header that the fold finalizes (the
/// prover asks for the header of the new head on its next pass).
fn node_pages(
    scenario: Scenario,
    head: &BeaconHeader,
    head_state: Vec<u8>,
    updates: &[LightClientUpdate],
) -> HashMap<String, Vec<u8>> {
    let (latest, handoffs) = updates.split_last().expect("updates");
    let handoff_bodies: Vec<_> = handoffs
        .iter()
        .map(|update| json!({ "data": light_client_update_json(update) }))
        .collect();
    HashMap::from([
        header_page(head),
        header_page(&latest.finalized_header.beacon),
        (
            format!("/eth/v2/debug/beacon/states/{:#x}", head.state_root),
            head_state,
        ),
        (
            "/eth/v1/beacon/light_client/finality_update".to_string(),
            json_body(json!({ "data": light_client_update_json(latest) })),
        ),
        (
            format!(
                "/eth/v1/beacon/light_client/updates?start_period={}&count={}",
                scenario.period,
                handoffs.len()
            ),
            json_body(json!(handoff_bodies)),
        ),
    ])
}

/// Deploys a light client at a synthetic checkpoint in `scenario.period`, with the real committee hash of that period.
/// The beacon chain ahead of it holds three more periods.
fn lagging_light_client(scenario: Scenario, stored_next: StoredNext) -> LaggingLightClient {
    let spec = scenario.chain.spec();
    let head_slot = scenario.period * PERIOD_SLOTS + 500;
    let fork = spec.fork_at_slot(head_slot);
    assert!(
        fork >= ForkName::Capella,
        "the checkpoint needs a state with a sync committee"
    );
    let state_bytes = StateBytes::new(
        fork,
        head_slot,
        committee_for(spec, scenario.period).committee.clone(),
        committee_for(spec, scenario.period + 1).committee.clone(),
    )
    .to_ssz();
    let state = StateView::parse(&state_bytes, scenario.chain).expect("the synthetic state parses");
    let head = BeaconHeader {
        slot: head_slot,
        proposer_index: 3,
        parent_root: keccak256(b"fold head parent"),
        state_root: state.root(),
        body_root: keccak256(b"fold head body"),
    };
    let updates = period_chain(spec, scenario.period, CROSSINGS);

    let chain = TestChain::start(1, Hardfork::Cancun);
    let verifier = chain.deploy(
        "OracleSP1Verifier",
        HashMap::from([("oracle", word_address(DEPLOYER))]),
    );
    let initial_next = match stored_next {
        StoredNext::Unknown => B256::ZERO,
        StoredNext::Known => committee_hash_of(scenario, scenario.period + 1),
    };
    let light_client = chain.deploy(
        "BeaconLightClient",
        HashMap::from([
            ("verifier", word_address(verifier)),
            ("programVKey", word_hash(program_vkey())),
            (
                "genesisValidatorsRoot",
                word_hash(spec.genesis_validators_root),
            ),
            ("slotsPerPeriod", word_u64(PERIOD_SLOTS)),
            ("genesisTime", word_u64(LIGHT_CLIENT_GENESIS_TIME)),
            ("secondsPerSlot", word_u64(LIGHT_CLIENT_SECONDS_PER_SLOT)),
            ("initialSlot", word_u64(head.slot)),
            ("initialHeaderRoot", word_hash(header_root(&head))),
            (
                "initialSyncCommitteeHash",
                word_hash(committee_hash_of(scenario, scenario.period)),
            ),
            ("initialNextSyncCommitteeHash", word_hash(initial_next)),
        ]),
    );
    let node = SyntheticNode(node_pages(scenario, &head, state_bytes, &updates));
    LaggingLightClient {
        chain,
        light_client,
        source: HttpBeaconSource::new(scenario.chain, Box::new(node)),
        updates,
        scenario,
    }
}

fn program_vkey() -> B256 {
    keccak256(b"light-client-program")
}

impl LaggingLightClient {
    fn client(&self) -> ChainClient {
        client_of(&self.chain)
    }

    fn view<Call: alloy_sol_types::SolCall>(&self, call: Call) -> Call::Return
    where
        Call::Return: Clone,
    {
        self.client().view(self.light_client, call).expect("view")
    }

    fn head(&self) -> u64 {
        self.view(LightClientContract::headCall {})
    }

    fn committee_at(&self, period: u64) -> B256 {
        self.view(LightClientContract::syncCommitteesCall { period })
    }

    /// What the prover plans for the light client now, as the route asks for it.
    fn plan(&self) -> UpdatePlan {
        let client = self.client();
        let state =
            read_light_client_state_of(&client, self.light_client).expect("light client state");
        self.source.next_head_update(&state, &client).expect("plan")
    }

    /// The statement the prover plans now. The test stops when the prover plans nothing.
    fn planned_input(&self) -> UpdateInput {
        let UpdatePlan::Update(statement) = self.plan() else {
            panic!("the light client lags, so the prover must plan an update");
        };
        let ProofStatement::Verified(input) = *statement else {
            panic!("a real beacon source plans a statement that the program verifies");
        };
        input
    }

    /// Proves the input with the oracle backend and sends the update. The backend runs the program on the input first.
    fn submit(&self, input: UpdateInput) -> Result<()> {
        let proof = oracle_prover().prove(program_vkey(), &ProofStatement::Verified(input))?;
        self.chain.send(
            Some(self.light_client),
            &update_calldata(&proof.proof_bytes, &proof.public_values),
        );
        Ok(())
    }
}

/// Claim: a light client three periods behind catches up with one fold of four updates. The prover reads the chain from
/// a beacon node, the oracle backend runs the program on the whole fold, and the contract accepts the result. Afterwards
/// the head is the finalized header of the last update, the contract stores the committee of the new head period, and a
/// second plan says "covered".
///
/// The committee hashes follow the contract rules. The contract writes the committee of the NEW period only. The periods
/// that the fold passed through (P + 1 and P + 2) stay as they were: empty, or, when the contract held the next
/// committee at the start, the committee that it held. The last update is a finality update with no next committee, so
/// the slot after the new head stays empty.
///
/// Controls: the same fold with one update signed by the wrong committee makes the oracle refuse before any signature,
/// so no transaction exists. A proof of a fold cannot be sent twice (the contract moved on).
/// Why it matters: no other Anvil test sends a multi-period fold, because the Anvil light clients carry no real
/// committees. This one reaches the contract rules 1 to 5 for the folded output, from real data in the prover.
fn assert_catch_up(scenario: Scenario, stored_next: StoredNext) {
    if !tools_available() {
        return;
    }
    let label = format!("{:?} {stored_next:?}", scenario.chain);
    let lagging = lagging_light_client(scenario, stored_next);
    let period = scenario.period;
    let first_head = lagging.head();
    let latest = lagging
        .updates
        .last()
        .expect("updates")
        .finalized_header
        .clone();
    assert_eq!(
        scenario.chain.spec().period_at_slot(latest.beacon.slot),
        period + CROSSINGS,
        "{label}"
    );
    assert_eq!(
        lagging.committee_at(period),
        committee_hash_of(scenario, period),
        "{label}: the checkpoint committee"
    );
    let held_next = lagging.committee_at(period + 1);
    assert_eq!(
        held_next == B256::ZERO,
        stored_next == StoredNext::Unknown,
        "{label}"
    );

    let input = lagging.planned_input();
    assert_eq!(
        input.updates.len(),
        4,
        "{label}: one fold holds the three handoffs and the finality update"
    );
    assert_eq!(input.store.header_slot, first_head, "{label}");
    assert_eq!(
        input.store.next_sync_committee.is_some(),
        stored_next == StoredNext::Known,
        "{label}"
    );

    // Control: a fold with one update signed by a committee that is not the stored one is refused by the program.
    let mut forged = input.clone();
    forged.updates[1].sync_aggregate.sync_committee_signature =
        input.updates[2].sync_aggregate.sync_committee_signature;
    assert!(
        matches!(lagging.submit(forged), Err(Error::VerificationRefused(_))),
        "{label}: a forged link must be refused before signing"
    );
    assert_eq!(
        lagging.head(),
        first_head,
        "{label}: the refused fold sent nothing"
    );

    // What the program says about the honest fold.
    let output = verify_update_natively(&input).expect("the program accepts the fold");
    assert_eq!(output.previousHeadSlot, first_head, "{label}");
    assert_eq!(
        output.previousSyncCommitteeHash,
        committee_hash_of(scenario, period),
        "{label}"
    );
    assert_eq!(
        output.startNextSyncCommitteeHash, held_next,
        "{label}: the program starts from the stored next committee"
    );
    assert_eq!(output.newHeadSlot, latest.beacon.slot, "{label}");
    assert_eq!(output.newHeaderRoot, header_root(&latest.beacon), "{label}");
    assert_eq!(
        output.syncCommitteeHash,
        committee_hash_of(scenario, period + CROSSINGS),
        "{label}"
    );
    assert_eq!(
        output.nextSyncCommitteeHash,
        B256::ZERO,
        "{label}: a finality update proves no next committee"
    );

    lagging
        .submit(input.clone())
        .expect("the honest fold is accepted");
    assert_fold_applied(&lagging, &output, &label);

    // The fold is spent, and the prover plans nothing more.
    assert!(
        matches!(lagging.plan(), UpdatePlan::Covered),
        "{label}: the head is the newest final header"
    );
    let replay = oracle_prover()
        .prove(program_vkey(), &ProofStatement::Verified(input))
        .expect("the program still accepts the fold");
    let data = update_calldata(&replay.proof_bytes, &replay.public_values);
    assert!(
        lagging.chain.call(lagging.light_client, &data).is_err(),
        "{label}: the contract refuses a replayed fold"
    );
}

/// What the contract holds after the fold: the head and its roots, the committee hashes, and one `HeadUpdated` event.
fn assert_fold_applied(lagging: &LaggingLightClient, output: &LightClientOutput, label: &str) {
    let scenario = lagging.scenario;
    let period = scenario.period;
    let latest = &lagging.updates.last().expect("updates").finalized_header;
    assert_eq!(lagging.head(), output.newHeadSlot, "{label}: head");
    assert_eq!(
        lagging.head(),
        latest.beacon.slot,
        "{label}: head is the finalized slot of the last update"
    );
    assert_eq!(
        lagging.view(LightClientContract::headersCall {
            slot: output.newHeadSlot
        }),
        header_root(&latest.beacon),
        "{label}: header root"
    );
    assert_eq!(
        lagging.view(LightClientContract::executionBlockHashesCall {
            slot: output.newHeadSlot
        }),
        latest.execution.block_hash,
        "{label}: execution block hash"
    );
    assert_eq!(
        lagging.committee_at(period),
        committee_hash_of(scenario, period),
        "{label}: the old period is untouched"
    );
    assert_eq!(
        lagging.committee_at(period + CROSSINGS),
        committee_hash_of(scenario, period + CROSSINGS),
        "{label}: the committee of the new head period"
    );
    assert_eq!(
        lagging.committee_at(period + CROSSINGS + 1),
        B256::ZERO,
        "{label}: no next committee was proven"
    );
    assert_eq!(
        lagging.committee_at(period + 2),
        B256::ZERO,
        "{label}: a period the fold passed through is not written"
    );
    assert_eq!(
        lagging.committee_at(period + 1),
        output.startNextSyncCommitteeHash,
        "{label}: the next committee of the start is what it was"
    );
    assert_eq!(
        stored_head_slots(&lagging.chain, lagging.light_client),
        vec![output.newHeadSlot],
        "{label}: one proof, one head event"
    );
}

/// Claim: see [`assert_catch_up`]. The contract holds no next committee at the start, so the prover takes the store from
/// the state of the head (the fake node serves no bootstrap) and the program starts with no next committee.
#[test]
fn a_lagging_light_client_with_no_next_committee_catches_up_in_one_fold() {
    for scenario in SCENARIOS {
        assert_catch_up(scenario, StoredNext::Unknown);
    }
}

/// Claim: see [`assert_catch_up`]. The contract holds the next committee at the start, so the store must carry it, and
/// the prover reads it from the state of the head (Electra or Fulu layout on Ethereum). The contract compares it with the
/// start of the output, and the fold passes only if the committee that the parser read is the committee that the
/// contract stored.
#[test]
fn a_lagging_light_client_with_a_next_committee_catches_up_in_one_fold() {
    for scenario in SCENARIOS {
        assert_catch_up(scenario, StoredNext::Known);
    }
}
