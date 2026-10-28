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
use zk_bridge_prover::produce::{produce, ProduceRequest, Production};
use zk_bridge_prover::prover::{oracle_digest, OracleProver};
use zk_bridge_prover::signer::{recover_address, RecoverableSignature, Signer};

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

/// A store that holds the same entries as another, but flips one bit of the first entry of every branch it gives back.
struct FlippingStore(
    Arc<dyn zk_bridge_prover::beacon::branch_store::GenesisValidatorsRootBranchStore>,
);

impl zk_bridge_prover::beacon::branch_store::GenesisValidatorsRootBranchStore for FlippingStore {
    fn get(&self, state_root: &B256) -> Option<Vec<B256>> {
        let mut branch = self.0.get(state_root)?;
        branch[0].0[0] ^= 0x01;
        Some(branch)
    }

    fn put(&self, state_root: B256, branch: Vec<B256>) -> zk_bridge_prover::error::Result<()> {
        self.0.put(state_root, branch)
    }
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

/// Claim: a corrupt stored branch is refused before proving. The plan builds, because the prover does not trust the store
/// and does not recheck it, and the native run of the program then refuses it with the exact error. `produce` returns that
/// refusal and calls no backend.
/// Why it matters: the store is untrusted public data. A wrong entry can only stall a catch-up, never cause a false head.
#[test]
fn a_corrupt_stored_genesis_validators_root_branch_is_refused_before_proving() {
    use zk_bridge_prover::beacon::branch_store::MemoryBranchStore;
    use zk_bridge_prover::beacon::http::HttpBeaconSource;
    use zk_bridge_prover::light_client::verify_update_natively;
    let (chain, checkpoint) = lagging_chain();
    let honest = Arc::new(MemoryBranchStore::new());
    chain
        .source()
        .with_branch_store(honest.clone())
        .plan_update(&head_at(&checkpoint))
        .expect("plan with fresh states");

    let corrupt = HttpBeaconSource::new(
        chain.kind,
        PrunedStates::keeping_head_of(&chain, &checkpoint),
    )
    .with_branch_store(Arc::new(FlippingStore(honest)));
    let plan = corrupt
        .plan_update(&head_at(&checkpoint))
        .expect("the plan builds")
        .expect("a fold is due");
    let refused =
        Error::VerificationRefused(lc_core::Error::InvalidGenesisValidatorsRootBranch.to_string());
    assert_eq!(verify_update_natively(&plan.input).unwrap_err(), refused);

    let prover = OracleProver::new(oracle_signer());
    assert_eq!(
        produce(&corrupt, &prover, &request(head_at(&checkpoint))).unwrap_err(),
        refused
    );
}
