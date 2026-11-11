//! The producer and the `prove` command against the synthetic signed beacon chain, with the oracle backend.
//!
//! The beacon chain signs for real, so the light-client program accepts its updates. The oracle backend runs that program
//! natively and signs the public values. So these tests show the whole path of a run (starting head, fold, native check,
//! backend, answer check, package, handoff) without a GPU and without a chain. They do not show a zero-knowledge proof:
//! `tests/sp1_execute.rs` and `tests/remote_prover.rs` cover the real proof and its checks.

mod common;

use alloy_primitives::{hex, B256};
use alloy_sol_types::{SolCall, SolValue};
use common::*;
use std::path::PathBuf;
use std::sync::{Arc, Mutex};
use zk_bridge_prover::beacon::StoredHead;
use zk_bridge_prover::cli::{self, EXIT_PROOF_PRODUCED, EXIT_UP_TO_DATE};
use zk_bridge_prover::config::ProverBackend;
use zk_bridge_prover::contracts::LightClientContract;
use zk_bridge_prover::error::Error;
use zk_bridge_prover::handoff::ProofPackage;
use zk_bridge_prover::light_client::{ChainKind, LightClientOutput};
use zk_bridge_prover::local_network::signed_beacon::checkpoint::{read_checkpoint, Checkpoint};
use zk_bridge_prover::logging::Logger;
use zk_bridge_prover::produce::{produce, produce_logged, ProduceRequest, Production};
use zk_bridge_prover::prover::{oracle_digest, OracleProver, ProofStatement, Prover};
use zk_bridge_prover::signer::{recover_address, RecoverableSignature, Signer};
use zk_bridge_prover::timing::{ProverTimings, RemoteTimings, WorkerTimings};

/// A dummy key for the oracle. It has no value anywhere.
const ORACLE_SECRET: [u8; 32] = [0x42; 32];
const PROGRAM_KEY: B256 = B256::repeat_byte(0x99);

fn oracle_signer() -> Signer {
    Signer::from_secret_bytes(&ORACLE_SECRET).expect("a valid secret")
}

fn request(head: StoredHead) -> ProduceRequest {
    ProduceRequest {
        route: "explicit-head".into(),
        backend: ProverBackend::Oracle,
        program_key: PROGRAM_KEY,
        head,
        stored: None,
        destination: None,
        now_unix_seconds: 1_800_000_000,
    }
}

fn lagging_chain() -> (Chain, Checkpoint) {
    let chain = Chain::new(ChainKind::Pulsechain, BLOCKS_BEFORE_CHECKPOINT);
    let checkpoint = read_checkpoint(&chain.node, ChainKind::Pulsechain).expect("checkpoint");
    chain.mine(6);
    (chain, checkpoint)
}

/// Claim: a head that already is the newest final header gives "up to date" and no proof; a head that lags gives a package
/// whose keys follow the native run, whose public values decode to the update, whose proof is the oracle signature over
/// the digest of the program key and the public values, and whose calldata is the `update` call for those same bytes.
/// Why it matters: the stateful servers store the package and send the calldata. Every field must name the same update.
#[test]
fn a_lagging_head_gives_a_package_that_names_one_update() {
    let (chain, checkpoint) = lagging_chain();
    let source = chain.source();
    let prover = OracleProver::new(oracle_signer());

    let Production::Proof(package) =
        produce(&source, &prover, &request(head_at(&checkpoint))).expect("a run")
    else {
        panic!("the head lags by six slots, so a proof is due");
    };
    assert_eq!(package.start_head_slot, checkpoint.slot);
    assert_eq!(
        package.start_head_root,
        format!("{:#x}", checkpoint.header_root)
    );
    assert_eq!(package.new_head_slot, checkpoint.slot + 6);
    assert_eq!(package.latest_finalized_slot, package.new_head_slot);
    assert_eq!(package.program_key, format!("{PROGRAM_KEY:#x}"));
    assert_eq!(package.backend, "oracle");
    assert_eq!(package.created_at, "2027-01-15T08:00:00Z");

    let public_values = hex::decode(&package.public_values).unwrap();
    let output = LightClientOutput::abi_decode(&public_values).expect("public values decode");
    assert_eq!(output.newHeadSlot, package.new_head_slot);
    assert_eq!(
        format!("{:#x}", output.newHeaderRoot),
        package.new_head_root
    );

    let proof = hex::decode(&package.proof).unwrap();
    let signature = RecoverableSignature {
        r: B256::from_slice(&proof[..32]),
        s: B256::from_slice(&proof[32..64]),
        recovery_id: proof[64] - 27,
    };
    let digest = oracle_digest(PROGRAM_KEY, &public_values);
    assert_eq!(
        recover_address(&digest, &signature).unwrap(),
        oracle_signer().address()
    );

    let calldata = hex::decode(&package.update_calldata).unwrap();
    let call = LightClientContract::updateCall::abi_decode(&calldata).expect("an update call");
    assert_eq!(call.proof.as_ref(), proof.as_slice());
    assert_eq!(call.publicValues.as_ref(), public_values.as_slice());

    let after = StoredHead {
        slot: output.newHeadSlot,
        root: output.newHeaderRoot,
        next_committee_hash: output.nextSyncCommitteeHash,
    };
    let again = produce(&source, &prover, &request(after)).expect("a second run");
    assert!(
        matches!(again, Production::UpToDate { head_slot } if head_slot == output.newHeadSlot),
        "control: the new head is the newest final header, so nothing is left to prove"
    );
}

/// Claim: a stored next-committee hash that the beacon state does not match stops the run before any proof, with an error
/// that names the hash.
/// Why it matters: the light client compares that hash. An update with another store would revert after the proof cost.
#[test]
fn a_stored_hash_that_the_beacon_state_does_not_match_is_refused() {
    let (chain, checkpoint) = lagging_chain();
    let wrong = StoredHead {
        next_committee_hash: B256::repeat_byte(0xdd),
        ..head_at(&checkpoint)
    };
    let error = produce(
        &chain.source(),
        &OracleProver::new(oracle_signer()),
        &request(wrong),
    )
    .unwrap_err();
    assert!(matches!(error, Error::Beacon(_)), "{error}");
    assert!(
        error.to_string().contains("does not match the stored hash"),
        "{error}"
    );
}

/// A scratch directory that holds a configuration file. Removed when dropped.
struct Scratch(PathBuf);

impl Scratch {
    fn new(label: &str) -> Self {
        let path =
            std::env::temp_dir().join(format!("zk-bridge-prover-{label}-{}", std::process::id()));
        std::fs::create_dir_all(&path).expect("a scratch directory");
        Self(path)
    }

    fn write(&self, name: &str, text: &str) -> PathBuf {
        let path = self.0.join(name);
        std::fs::write(&path, text).expect("write the file");
        path
    }
}

impl Drop for Scratch {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.0);
    }
}

fn head_arguments(head: &StoredHead) -> Vec<String> {
    vec![
        "--head-slot".into(),
        head.slot.to_string(),
        "--head-root".into(),
        format!("{:#x}", head.root),
        "--next-committee-hash".into(),
        format!("{:#x}", head.next_committee_hash),
    ]
}

fn run_command(
    config: &std::path::Path,
    arguments: &[String],
    lookup: &dyn Fn(&str) -> Option<String>,
) -> (zk_bridge_prover::error::Result<i32>, Vec<u8>) {
    let mut all = vec![
        "zk-bridge-prover".to_string(),
        "--config".to_string(),
        config.display().to_string(),
        "prove".to_string(),
    ];
    all.extend_from_slice(arguments);
    let mut out = Vec::new();
    let outcome = cli::run(all, lookup, &mut out);
    (outcome, out)
}

/// Claim: `prove` with an explicit head prints exactly one JSON object and exits 0 when the head lags; it prints nothing
/// and exits 3 when the head is current. With both targets, the webhook gets the same object, with the bearer token from
/// the environment, and the token is nowhere in the output.
/// Why it matters: this is the contract with the stateful servers. They tell "proof", "nothing to do" and "failure" apart
/// by the exit code, and they read one object from standard output.
#[test]
fn the_prove_command_prints_one_object_and_signals_up_to_date_by_its_exit_code() {
    let (chain, checkpoint) = lagging_chain();
    let url = serve_beacon(&chain);
    let received = receive_one_post();
    let scratch = Scratch::new("prove");
    let config = scratch.write(
        "prover.toml",
        &format!(
            r#"
[prover]
backend = "oracle"
oracle_key_env = "ORACLE_KEY"
program_vkey = "{PROGRAM_KEY:#x}"

[handoff]
targets = ["stdout", "webhook"]
webhook_url = "{}"
webhook_bearer_env = "HOOK_TOKEN"
"#,
            received.url
        ),
    );
    const TOKEN: &str = "example-bearer-token";
    let lookup = |name: &str| match name {
        "ORACLE_KEY" => Some(hex::encode_prefixed(ORACLE_SECRET)),
        "HOOK_TOKEN" => Some(TOKEN.to_string()),
        _ => None,
    };
    let mut arguments = vec![
        "--beacon-url".to_string(),
        url.clone(),
        "--chain".to_string(),
        "pulsechain".to_string(),
    ];
    arguments.extend(head_arguments(&head_at(&checkpoint)));

    let (outcome, out) = run_command(&config, &arguments, &lookup);
    assert_eq!(outcome.expect("a proof"), EXIT_PROOF_PRODUCED);
    let text = String::from_utf8(out).unwrap();
    assert_eq!(text.lines().count(), 1, "one object, one line: {text}");
    assert!(!text.contains(TOKEN), "the token never reaches the output");
    let package: ProofPackage = serde_json::from_str(text.trim()).expect("a package");
    assert_eq!(package.route, "explicit-head");
    assert_eq!(package.start_head_slot, checkpoint.slot);
    assert_eq!(package.new_head_slot, checkpoint.slot + 6);
    assert!(package.destination.is_none());

    let (authorization, body) = received.wait();
    assert_eq!(
        authorization.as_deref(),
        Some(format!("Bearer {TOKEN}").as_str())
    );
    assert_eq!(
        serde_json::from_str::<ProofPackage>(&body).unwrap(),
        package
    );

    let current = StoredHead {
        slot: package.new_head_slot,
        root: package.new_head_root.parse().unwrap(),
        next_committee_hash: B256::ZERO,
    };
    let mut arguments = vec![
        "--beacon-url".to_string(),
        url,
        "--chain".to_string(),
        "pulsechain".to_string(),
        "--to".to_string(),
        "stdout".to_string(),
    ];
    arguments.extend(head_arguments(&current));
    let (outcome, out) = run_command(&config, &arguments, &lookup);
    assert_eq!(outcome.expect("up to date"), EXIT_UP_TO_DATE);
    assert!(out.is_empty(), "nothing to hand off, so nothing printed");
}

/// The `Authorization` header and the body of one request.
type Seen = (Option<String>, String);

/// A receiver for one POST: its URL, and a way to wait for the request.
struct OnePost {
    url: String,
    seen: Arc<Mutex<Option<Seen>>>,
}

impl OnePost {
    fn wait(&self) -> Seen {
        for _ in 0..200 {
            if let Some(seen) = self.seen.lock().unwrap().clone() {
                return seen;
            }
            std::thread::sleep(std::time::Duration::from_millis(20));
        }
        panic!("the webhook got no request");
    }
}

fn receive_one_post() -> OnePost {
    let server = tiny_http::Server::http("127.0.0.1:0").expect("a free port");
    let port = server.server_addr().to_ip().expect("an ip address").port();
    let seen = Arc::new(Mutex::new(None));
    let recorded = seen.clone();
    std::thread::spawn(move || {
        let Ok(mut request) = server.recv() else {
            return;
        };
        let authorization = request
            .headers()
            .iter()
            .find(|header| header.field.equiv("Authorization"))
            .map(|header| header.value.to_string());
        let mut body = String::new();
        std::io::Read::read_to_string(request.as_reader(), &mut body).unwrap();
        *recorded.lock().unwrap() = Some((authorization, body));
        let _ = request.respond(tiny_http::Response::empty(204));
    });
    OnePost {
        url: format!("http://127.0.0.1:{port}/proofs"),
        seen,
    }
}

/// Serves the views of a light client that stands at `checkpoint`, as a JSON-RPC node for chain 369. It answers
/// `eth_chainId` and `eth_call` only. The committee of the head period and of the next period differ, so a swap of the two
/// shows.
fn serve_light_client(checkpoint: &Checkpoint) -> String {
    let checkpoint = *checkpoint;
    serve_rpc(move |call| answer_call(&checkpoint, call))
}

fn answer_call(checkpoint: &Checkpoint, call: &serde_json::Value) -> serde_json::Value {
    const SLOTS_PER_PERIOD: u64 = 8192;
    if call["method"] == "eth_chainId" {
        return serde_json::json!("0x171");
    }
    assert_eq!(call["method"], "eth_call");
    let data = hex::decode(call["params"][0]["data"].as_str().unwrap()).unwrap();
    let selector: [u8; 4] = data[..4].try_into().unwrap();
    let period = checkpoint.slot / SLOTS_PER_PERIOD;
    let word = |value: B256| serde_json::json!(hex::encode_prefixed(value));
    let number = |value: u64| word(B256::from(alloy_primitives::U256::from(value)));
    match selector {
        LightClientContract::headCall::SELECTOR => number(checkpoint.slot),
        LightClientContract::slotsPerPeriodCall::SELECTOR => number(SLOTS_PER_PERIOD),
        LightClientContract::headersCall::SELECTOR => word(checkpoint.header_root),
        LightClientContract::genesisValidatorsRootCall::SELECTOR => {
            word(checkpoint.genesis_validators_root)
        }
        LightClientContract::programVKeyCall::SELECTOR => word(PROGRAM_KEY),
        LightClientContract::syncCommitteesCall::SELECTOR => {
            let asked = LightClientContract::syncCommitteesCall::abi_decode(&data).unwrap();
            if asked.period == period {
                return word(checkpoint.committee_hash);
            }
            assert_eq!(asked.period, period + 1, "only the two periods are read");
            word(checkpoint.next_committee_hash)
        }
        other => panic!("unexpected call {other:?}"),
    }
}

fn route_config(beacon_url: &str, rpc_url: &str, extra_prover: &str) -> String {
    format!(
        r#"
[prover]
backend = "oracle"
oracle_key_env = "ORACLE_KEY"
{extra_prover}

[routes.ethereum_to_pulsechain.source]
chain_id = 1
chain = "pulsechain"
beacon_url = "{beacon_url}"

[routes.ethereum_to_pulsechain.destination]
chain_id = 369
rpc_url = "{rpc_url}"
light_client = "0x4444444444444444444444444444444444444444"
"#
    )
}

/// Claim: with a route and no head flag, `prove` reads the head, the committee hashes and the program key from the light
/// client contract, proves from that head, and names the destination in the package. A configured program key that differs
/// from the contract key stops the run before any proof.
/// Why it matters: the contract is the authority for where an update starts and which program it needs. A name in the file
/// is a hypothesis, so the command reads the relation from the contract and compares.
#[test]
fn a_route_reads_the_light_client_and_names_the_destination() {
    let (chain, checkpoint) = lagging_chain();
    let beacon_url = serve_beacon(&chain);
    let rpc_url = serve_light_client(&checkpoint);
    let scratch = Scratch::new("route");
    let lookup = |name: &str| (name == "ORACLE_KEY").then(|| hex::encode_prefixed(ORACLE_SECRET));

    let config = scratch.write("prover.toml", &route_config(&beacon_url, &rpc_url, ""));
    let (outcome, out) = run_command(&config, &[], &lookup);
    assert_eq!(outcome.expect("a proof"), EXIT_PROOF_PRODUCED);
    let package: ProofPackage = serde_json::from_slice(&out).expect("a package");
    assert_eq!(package.route, "ethereum_to_pulsechain");
    assert_eq!(package.program_key, format!("{PROGRAM_KEY:#x}"));
    assert_eq!(package.start_head_slot, checkpoint.slot);
    let destination = package
        .destination
        .expect("the route names the destination");
    assert_eq!(destination.chain_id, 369);
    assert_eq!(
        destination.light_client,
        "0x4444444444444444444444444444444444444444"
    );

    let other_key = format!("program_vkey = \"{:#x}\"", B256::repeat_byte(0x11));
    let config = scratch.write(
        "other.toml",
        &route_config(&beacon_url, &rpc_url, &other_key),
    );
    let (outcome, out) = run_command(&config, &[], &lookup);
    let error = outcome.unwrap_err().to_string();
    assert!(error.contains("the light client stores"), "{error}");
    assert!(out.is_empty());
}

/// A beacon node whose old states are gone: it answers 404 for every state except the one of the head of the light client,
/// like a node that pruned the states of the attested headers of the updates. Every other path goes to the real node.
struct PrunedStates {
    node: Arc<zk_bridge_prover::local_network::signed_beacon::node::BeaconNode>,
    kept_state_path: String,
}

impl PrunedStates {
    /// A pruned view of `chain` that still serves the state of the header at the slot of `checkpoint`.
    fn keeping_head_of(chain: &Chain, checkpoint: &Checkpoint) -> Box<Self> {
        let answer = chain.node.answer(
            &format!("/eth/v1/beacon/headers/{}", checkpoint.slot),
            "application/json",
        );
        let header: serde_json::Value = serde_json::from_slice(&answer.body).unwrap();
        let state_root = header["data"]["header"]["message"]["state_root"]
            .as_str()
            .unwrap();
        Box::new(Self {
            node: chain.node.clone(),
            kept_state_path: format!("/eth/v2/debug/beacon/states/{state_root}"),
        })
    }
}

impl zk_bridge_prover::rpc::HttpGet for PrunedStates {
    fn get(
        &self,
        path_and_query: &str,
        accept: &str,
    ) -> zk_bridge_prover::error::Result<zk_bridge_prover::rpc::HttpResponse> {
        if path_and_query.contains("/eth/v2/debug/beacon/states/")
            && path_and_query != self.kept_state_path
        {
            return Ok(zk_bridge_prover::rpc::HttpResponse {
                status: 404,
                body: b"{}".to_vec(),
            });
        }
        self.node.get(path_and_query, accept)
    }
}

/// Flips one bit of the first entry of the stored branch for `state_root`.
fn corrupt_entry(
    store: &dyn zk_bridge_prover::beacon::branch_store::GenesisValidatorsRootBranchStore,
    state_root: B256,
) {
    let mut branch = store.get(&state_root).expect("the store holds the entry");
    branch[0].0[0] ^= 0x01;
    store
        .put(state_root, branch)
        .expect("the store keeps the entry");
}

/// Claim: a catch-up uses the stored branch of `genesis_validators_root` when the node no longer serves the attested state.
/// A first run, while the state is fresh, computes the branch and stores it. A second source with the same store and a node
/// that answers 404 for every state then plans the same fold, and the program accepts it. A second source with an empty
/// store stops with `Error::Beacon` that names the missing state.
/// Why it matters: this is T23. The branch needs the siblings of field 1 in the attested state, and a node prunes old states.
/// Without the store a stale light client could not catch up on a normal node. The store is the only reason the control
/// (an empty store) fails, so a catch-up that refetched the state would pass the first case only against a full node.
#[test]
fn catch_up_uses_the_stored_genesis_validators_root_branch_when_the_old_state_is_gone() {
    use zk_bridge_prover::beacon::branch_store::MemoryBranchStore;
    use zk_bridge_prover::beacon::http::HttpBeaconSource;
    use zk_bridge_prover::light_client::verify_update_natively;
    let (chain, checkpoint) = lagging_chain();
    let store = Arc::new(MemoryBranchStore::new());
    let fresh = chain.source().with_branch_store(store.clone());
    let plan = fresh
        .plan_update(&head_at(&checkpoint))
        .expect("plan with fresh states")
        .expect("a fold is due");
    let expected = verify_update_natively(&plan.input).expect("the fresh fold verifies");

    let pruned_node = || PrunedStates::keeping_head_of(&chain, &checkpoint);
    let pruned = HttpBeaconSource::new(chain.kind, pruned_node()).with_branch_store(store);
    let replay = pruned
        .plan_update(&head_at(&checkpoint))
        .expect("plan from the stored branches")
        .expect("a fold is due");
    assert_eq!(verify_update_natively(&replay.input).unwrap(), expected);

    let empty = HttpBeaconSource::new(chain.kind, pruned_node())
        .with_branch_store(Arc::new(MemoryBranchStore::new()));
    let error = empty.plan_update(&head_at(&checkpoint)).unwrap_err();
    assert!(
        matches!(&error, Error::Beacon(text) if text.contains("state 0x")),
        "{error}"
    );
}

/// Claim: a corrupt stored branch of `genesis_validators_root` is dropped and rebuilt from the attested state when the node
/// still serves the state. The plan then verifies natively with the same output as a plan from a clean store, and the
/// store holds the good entry again.
/// Why it matters: the store is untrusted public data, and a damaged entry used to stall a catch-up for good, because the
/// store came first and nothing rebuilt it. The prover now checks the entry and falls back to the state.
#[test]
fn a_corrupt_stored_branch_falls_back_to_the_state_and_the_update_verifies() {
    use zk_bridge_prover::beacon::branch_store::{
        GenesisValidatorsRootBranchStore, MemoryBranchStore,
    };
    use zk_bridge_prover::light_client::verify_update_natively;
    let (chain, checkpoint) = lagging_chain();
    let honest = Arc::new(MemoryBranchStore::new());
    let clean_plan = chain
        .source()
        .with_branch_store(honest.clone())
        .plan_update(&head_at(&checkpoint))
        .expect("plan with fresh states")
        .expect("a fold is due");
    let expected = verify_update_natively(&clean_plan.input).expect("the clean fold verifies");
    let state_root = clean_plan.input.steps[0]
        .update
        .attested_header
        .beacon
        .state_root;
    let good_branch = honest
        .get(&state_root)
        .expect("the first run stored the branch");

    corrupt_entry(honest.as_ref(), state_root);
    assert_ne!(honest.get(&state_root), Some(good_branch.clone()));
    let plan = chain
        .source()
        .with_branch_store(honest.clone())
        .plan_update(&head_at(&checkpoint))
        .expect("the plan falls back to the state")
        .expect("a fold is due");
    assert_eq!(verify_update_natively(&plan.input).unwrap(), expected);
    assert_eq!(honest.get(&state_root), Some(good_branch));
}

/// Claim: a corrupt stored branch with the attested state gone stops the plan with a clear error that names the state root,
/// and the prover drops the entry. The plan does not build, so no proof starts.
/// Why it matters: before this check the plan built and the program refused it only after the proof run began. A catch-up
/// must say what is wrong. It must also never turn a bad entry into a false head.
#[test]
fn a_corrupt_stored_branch_with_the_state_gone_gives_a_clear_error() {
    use zk_bridge_prover::beacon::branch_store::{
        GenesisValidatorsRootBranchStore, MemoryBranchStore,
    };
    use zk_bridge_prover::beacon::http::HttpBeaconSource;
    let (chain, checkpoint) = lagging_chain();
    let honest = Arc::new(MemoryBranchStore::new());
    let clean_plan = chain
        .source()
        .with_branch_store(honest.clone())
        .plan_update(&head_at(&checkpoint))
        .expect("plan with fresh states")
        .expect("a fold is due");
    let state_root = clean_plan.input.steps[0]
        .update
        .attested_header
        .beacon
        .state_root;
    corrupt_entry(honest.as_ref(), state_root);

    let pruned = HttpBeaconSource::new(
        chain.kind,
        PrunedStates::keeping_head_of(&chain, &checkpoint),
    )
    .with_branch_store(honest.clone());
    let error = pruned.plan_update(&head_at(&checkpoint)).unwrap_err();
    assert!(
        matches!(&error, Error::Beacon(text)
            if text.contains(&format!("{state_root:#x}")) && text.contains("failed its check")),
        "{error}"
    );
    assert_eq!(honest.get(&state_root), None);
}

/// Claim: a file cut short by a crash counts as corrupt. A cut inside a line does not parse, so the store gives nothing. A
/// cut at the end of a line parses but is short, so the check drops it. In both cases the plan falls back to the state,
/// verifies, and the store file is whole again.
/// Why it matters: this is the failure that the atomic write prevents, and the check must still handle a file that an
/// older run or another tool left short.
#[test]
fn a_truncated_branch_file_is_treated_as_corrupt_and_rebuilt() {
    use zk_bridge_prover::beacon::branch_store::{
        DirectoryBranchStore, GenesisValidatorsRootBranchStore,
    };
    use zk_bridge_prover::light_client::verify_update_natively;
    let (chain, checkpoint) = lagging_chain();
    let directory = std::env::temp_dir().join(format!(
        "zk-bridge-produce-truncated-{}",
        std::process::id()
    ));
    let _ = std::fs::remove_dir_all(&directory);
    let store = Arc::new(DirectoryBranchStore::new(&directory));
    let clean_plan = chain
        .source()
        .with_branch_store(store.clone())
        .plan_update(&head_at(&checkpoint))
        .expect("plan with fresh states")
        .expect("a fold is due");
    let expected = verify_update_natively(&clean_plan.input).expect("the clean fold verifies");
    let state_root = clean_plan.input.steps[0]
        .update
        .attested_header
        .beacon
        .state_root;
    let good_branch = store
        .get(&state_root)
        .expect("the first run stored the branch");
    let path = directory.join(format!("{state_root:#x}.branch"));
    let whole = std::fs::read_to_string(&path).unwrap();
    let line_length = "0x".len() + 64 + 1;
    let cuts = [whole.len() - 10, whole.len() - line_length, 0];
    for cut in cuts {
        std::fs::write(&path, &whole[..cut]).unwrap();
        let plan = chain
            .source()
            .with_branch_store(store.clone())
            .plan_update(&head_at(&checkpoint))
            .unwrap_or_else(|error| panic!("cut at {cut}: {error}"))
            .expect("a fold is due");
        assert_eq!(verify_update_natively(&plan.input).unwrap(), expected);
        assert_eq!(store.get(&state_root), Some(good_branch.clone()));
        assert_eq!(std::fs::read_to_string(&path).unwrap(), whole);
    }
    let _ = std::fs::remove_dir_all(&directory);
}

/// Claim: the program still refuses a plan whose branch is wrong, with the exact error. A plan with a wrong branch is built here by hand, because the prover no longer lets a wrong stored
/// entry reach the plan.
/// Why it matters: the check of the prover is a convenience. The program is the guard. It must keep refusing a wrong branch.
#[test]
fn the_program_still_refuses_a_wrong_branch_in_a_plan() {
    use zk_bridge_prover::light_client::verify_update_natively;
    let (chain, checkpoint) = lagging_chain();
    let mut plan = chain
        .source()
        .plan_update(&head_at(&checkpoint))
        .expect("plan with fresh states")
        .expect("a fold is due");
    plan.input.steps[0].update.genesis_validators_root_branch[0].0[0] ^= 0x01;
    let refused =
        Error::VerificationRefused(lc_core::Error::InvalidGenesisValidatorsRootBranch.to_string());
    assert_eq!(verify_update_natively(&plan.input).unwrap_err(), refused);
}

/// An oracle that reports the timings of a remote run, as the remote backend does.
struct ReportingOracle {
    inner: OracleProver,
    timings: Mutex<Option<ProverTimings>>,
}

impl Prover for ReportingOracle {
    fn name(&self) -> &'static str {
        "reporting-oracle"
    }

    fn prove(
        &self,
        program_vkey: B256,
        statement: &ProofStatement,
    ) -> zk_bridge_prover::error::Result<zk_bridge_prover::prover::Proof> {
        self.inner.prove(program_vkey, statement)
    }

    fn take_timings(&self) -> Option<ProverTimings> {
        self.timings.lock().unwrap().take()
    }
}

fn field(line: &str, key: &str) -> Option<String> {
    line.split(' ')
        .find_map(|part| part.strip_prefix(&format!("{key}=")))
        .map(str::to_string)
}

/// Claim: a run logs one step line each for the build, the native run and the check, and ends with one `prove_timing`
/// line that carries the producer's steps and, for a backend that reports them, the remote steps and the worker's
/// numbers. A backend that reports nothing (the oracle) gives the producer's steps only. No line holds a URL.
/// Why it matters: this is the data that answers how long a proof takes and where the time goes.
#[test]
fn a_run_ends_with_one_timing_summary() {
    let (chain, checkpoint) = lagging_chain();
    let source = chain.source();

    let (logger, lines) = Logger::in_memory();
    let oracle = OracleProver::new(oracle_signer());
    produce_logged(&source, &oracle, &request(head_at(&checkpoint)), &logger).expect("a run");
    let lines = lines.lock().unwrap().clone();
    let steps: Vec<String> = lines
        .iter()
        .filter(|line| line.contains("event=prove_step"))
        .filter_map(|line| field(line, "step"))
        .collect();
    assert_eq!(steps, ["build", "native", "check"], "{lines:?}");
    let summaries: Vec<&String> = lines
        .iter()
        .filter(|l| l.contains("event=prove_timing"))
        .collect();
    assert_eq!(summaries.len(), 1, "{lines:?}");
    for key in ["build_ms", "native_ms", "verify_ms", "prove_ms", "total_ms"] {
        assert!(
            field(summaries[0], key).is_some(),
            "{key} in {}",
            summaries[0]
        );
    }
    assert!(
        field(summaries[0], "remote_ms").is_none()
            && field(summaries[0], "worker_timings").is_none()
    );

    let reporting = ReportingOracle {
        inner: OracleProver::new(oracle_signer()),
        timings: Mutex::new(Some(ProverTimings {
            native_ms: 11,
            verify_ms: 3,
            remote: Some(RemoteTimings {
                wait_worker_ms: 90_000,
                not_ready_count: 4,
                retry_count: 0,
                endpoint: "dedicated".into(),
                failover_count: 0,
                remote_ms: 50_000,
                worker: Some(WorkerTimings {
                    queue_ms: 0,
                    native_ms: 300,
                    prove_ms: 48_000,
                    verify_ms: 25,
                    total_ms: 49_000,
                    gpu: Some("NVIDIA L40S".into()),
                    cpu_model: None,
                    cpu_count: Some(16),
                }),
            }),
        })),
    };
    let (logger, lines) = Logger::in_memory();
    produce_logged(&source, &reporting, &request(head_at(&checkpoint)), &logger).expect("a run");
    let lines = lines.lock().unwrap().clone();
    let summary = lines
        .iter()
        .find(|l| l.contains("event=prove_timing"))
        .expect("summary");
    for (key, value) in [
        ("wait_worker_ms", "90000"),
        ("not_ready_count", "4"),
        ("endpoint", "dedicated"),
        ("failover_count", "0"),
        ("remote_ms", "50000"),
        ("worker_timings", "reported"),
        ("worker_prove_ms", "48000"),
        ("worker_total_ms", "49000"),
        ("remote_overhead_ms", "1000"),
        ("worker_cpu_count", "16"),
    ] {
        assert_eq!(
            field(summary, key).as_deref(),
            Some(value),
            "{key} in {summary}"
        );
    }
    assert!(summary.contains("worker_gpu=\"NVIDIA L40S\""), "{summary}");
    let all = lines.join("\n");
    assert!(
        !all.contains("http://") && !all.contains("https://"),
        "{all}"
    );

    // `produce` itself stays quiet and gives the same result.
    assert!(matches!(
        produce(&source, &oracle, &request(head_at(&checkpoint))).unwrap(),
        Production::Proof(_)
    ));
}

/// Claim: a fork observation from the stored head of a lagging light client folds to the newest final header and observes
/// the newest signed update: the package names the chain's fork version, a shape the gate allows, an attested slot past the
/// newest final header, the stored head as its start, and carries the `observe` calldata of the oracle's proof. A head
/// that the beacon chain does not hold stops the run before any proof.
/// Why it matters: this is the whole path the backend runs for a PulseChain registry, without a GPU and without a chain.
#[test]
fn a_fork_observation_folds_from_the_stored_head_and_observes_the_newest_update() {
    use zk_bridge_prover::contracts::ForkRegistryContract;
    use zk_bridge_prover::fork_observation::{produce_observation, ObservationRequest};
    use zk_bridge_prover::light_client::decode_fork_observation;
    use zk_bridge_prover::stored::StoredState;
    let (chain, checkpoint) = lagging_chain();
    let source = chain.source();
    let prover = OracleProver::new(oracle_signer());
    let stored = StoredState {
        head: head_at(&checkpoint),
        genesis_validators_root: checkpoint.genesis_validators_root,
        head_committee_hash: checkpoint.committee_hash,
        program_key: B256::repeat_byte(0x11),
    };
    let request = ObservationRequest {
        route: "pulsechain_to_ethereum".into(),
        backend: ProverBackend::Oracle,
        program_key: PROGRAM_KEY,
        chain_id: 369,
        registry: alloy_primitives::Address::repeat_byte(0x44),
        light_client: alloy_primitives::Address::repeat_byte(0x55),
        stored,
        now_unix_seconds: 1_800_000_000,
    };
    let (logger, _) = Logger::in_memory();
    let package = produce_observation(&source, &prover, &request, &logger).expect("an observation");
    assert_eq!(package.start_head_slot, checkpoint.slot);
    assert!(
        package.fold_steps >= 1,
        "the head lags, so the fold carries steps"
    );
    assert!(
        [5u8, 6, 7].contains(&package.shape),
        "shape {}",
        package.shape
    );
    assert!(package.observed_attested_slot > checkpoint.slot);
    let values = hex::decode(&package.public_values).unwrap();
    let output = decode_fork_observation(&values).unwrap();
    assert_eq!(output.previousHeaderRoot, checkpoint.header_root);
    assert_eq!(
        format!("{:#x}", output.observedVersion),
        package.observed_version
    );
    let call = ForkRegistryContract::observeCall::abi_decode(
        &hex::decode(&package.observe_calldata).unwrap(),
    )
    .unwrap();
    assert_eq!(call.publicValues.as_ref(), values.as_slice());

    let mut elsewhere = request.clone();
    elsewhere.stored.head.root = B256::repeat_byte(0x77);
    let error = produce_observation(&source, &prover, &elsewhere, &logger).unwrap_err();
    assert!(matches!(error, Error::Beacon(_)), "{error}");
}
