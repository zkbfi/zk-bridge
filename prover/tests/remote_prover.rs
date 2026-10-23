//! The remote backend against a fake worker: an HTTP server in this process.
//!
//! The good answer is a real Groth16 proof of the real Ethereum update that `tests/sp1_execute.rs` proves
//! (`test/hardened/fixtures/sp1-proof-ethereum-update.json`). So the accept test runs the real local verification
//! of `sp1-verifier`, and the refusal tests change one thing in a proof that is known to verify.
//!
//! Each test names what the backend must refuse and why that refusal protects a withdrawal.

use alloy_primitives::{hex, B256};
use lc_testkit::json::{bootstrap, light_client_update, load_response, store_from_bootstrap};
use lc_testkit::synthetic::{build_update, UpdateRecipe};
use std::str::FromStr;
use std::sync::{Arc, Mutex};
use std::time::Duration;
use zk_bridge_prover::error::Error;
use zk_bridge_prover::light_client::{guest_input_bytes, ChainKind, UpdateInput};
use zk_bridge_prover::logging::Logger;
use zk_bridge_prover::prover::{ProgramKind, ProofStatement, Prover};
use zk_bridge_prover::remote::{ProveRequestBody, ProveResponseBody, RemoteProver, RemoteSettings};

const API_KEY: &str = "test-key-0123456789";

/// A real proof: the program key, the public values and the proof bytes.
struct Fixture {
    program_key: B256,
    public_values: Vec<u8>,
    proof: Vec<u8>,
}

fn fixture() -> Fixture {
    let path = format!(
        "{}/../test/hardened/fixtures/sp1-proof-ethereum-update.json",
        env!("CARGO_MANIFEST_DIR")
    );
    let text = std::fs::read_to_string(&path).unwrap_or_else(|error| panic!("{path}: {error}"));
    let value: serde_json::Value = serde_json::from_str(&text).unwrap();
    let field = |name: &str| value[name].as_str().unwrap().to_string();
    Fixture {
        program_key: B256::from_str(&field("programVKey")).unwrap(),
        public_values: hex::decode(field("publicValues")).unwrap(),
        proof: hex::decode(field("proof")).unwrap(),
    }
}

fn real_ethereum_input() -> UpdateInput {
    let update = light_client_update(&load_response("ethereum/finality_update.json")["data"]);
    let store = store_from_bootstrap(
        &bootstrap(&load_response("ethereum/bootstrap_same_period.json")["data"]),
        None,
    );
    UpdateInput {
        chain: ChainKind::Ethereum,
        store,
        updates: vec![update],
    }
}

/// What the fake worker saw.
#[derive(Clone, Debug)]
struct Seen {
    method: String,
    path: String,
    authorization: Option<String>,
    user_agent: Option<String>,
    body: String,
}

/// What the fake worker answers.
#[derive(Clone)]
struct Reply {
    status: u16,
    body: String,
    delay: Duration,
}

impl Reply {
    fn ok(proof: &[u8], public_values: &[u8]) -> Self {
        let body = ProveResponseBody {
            proof: hex::encode_prefixed(proof),
            public_values: hex::encode_prefixed(public_values),
        };
        Self::with(200, serde_json::to_string(&body).unwrap())
    }

    fn with(status: u16, body: impl Into<String>) -> Self {
        Self {
            status,
            body: body.into(),
            delay: Duration::ZERO,
        }
    }

    fn after(mut self, delay: Duration) -> Self {
        self.delay = delay;
        self
    }
}

struct FakeWorker {
    url: String,
    seen: Arc<Mutex<Vec<Seen>>>,
    server: Arc<tiny_http::Server>,
}

impl FakeWorker {
    /// Starts a server. `script` gets the index of the request (from 0) and answers it.
    fn start(script: impl Fn(usize) -> Reply + Send + Sync + 'static) -> Self {
        let server = Arc::new(tiny_http::Server::http("127.0.0.1:0").unwrap());
        let url = format!("http://{}", server.server_addr().to_ip().unwrap());
        let seen = Arc::new(Mutex::new(Vec::new()));
        let script = Arc::new(script);
        let (loop_server, loop_seen) = (Arc::clone(&server), Arc::clone(&seen));
        std::thread::spawn(move || {
            for mut request in loop_server.incoming_requests() {
                let header = |request: &tiny_http::Request, name: &'static str| {
                    request
                        .headers()
                        .iter()
                        .find(|header| header.field.equiv(name))
                        .map(|header| header.value.to_string())
                };
                let authorization = header(&request, "Authorization");
                let user_agent = header(&request, "User-Agent");
                let mut body = String::new();
                std::io::Read::read_to_string(request.as_reader(), &mut body).unwrap();
                let record = Seen {
                    method: request.method().as_str().to_string(),
                    path: request.url().to_string(),
                    authorization,
                    user_agent,
                    body,
                };
                let index = {
                    let mut seen = loop_seen.lock().unwrap();
                    seen.push(record);
                    seen.len() - 1
                };
                let script = Arc::clone(&script);
                std::thread::spawn(move || {
                    let reply = script(index);
                    std::thread::sleep(reply.delay);
                    let response =
                        tiny_http::Response::from_string(reply.body).with_status_code(reply.status);
                    // The client may have given up on a delayed request.
                    let _ = request.respond(response);
                });
            }
        });
        Self { url, seen, server }
    }

    fn requests(&self) -> Vec<Seen> {
        self.seen.lock().unwrap().clone()
    }

    fn prover(&self, attempts: u32, timeout: Duration) -> RemoteProver {
        RemoteProver::new(
            RemoteSettings {
                endpoint_url: self.url.clone(),
                api_key: API_KEY.into(),
                timeout,
                attempts,
                retry_delay: Duration::from_millis(20),
            },
            Logger::in_memory().0,
        )
    }
}

impl Drop for FakeWorker {
    fn drop(&mut self) {
        self.server.unblock();
    }
}

fn real_statement() -> ProofStatement {
    ProofStatement::Verified(real_ethereum_input())
}

fn long() -> Duration {
    Duration::from_secs(30)
}

fn good_worker() -> (FakeWorker, Fixture) {
    let fixture = fixture();
    let reply = Reply::ok(&fixture.proof, &fixture.public_values);
    (FakeWorker::start(move |_| reply.clone()), fixture)
}

/// Claim: the real fixture proof is the proof of the statement. Without this, every accept test below would prove
/// nothing.
#[test]
fn the_fixture_belongs_to_the_real_ethereum_update() {
    let fixture = fixture();
    let native = zk_bridge_prover::light_client::public_values(
        &zk_bridge_prover::light_client::verify_update_natively(&real_ethereum_input()).unwrap(),
    );
    assert_eq!(fixture.public_values, native);
}

/// Claim: a good answer is accepted and returned unchanged, and the request has the documented shape: a POST to
/// `/prove` with the API key as a bearer token, the program key, the statement kind and the guest input as hex.
/// Why it matters: this is the whole contract between the prover and a RunPod endpoint.
#[test]
fn a_good_proof_is_accepted() {
    let (worker, fixture) = good_worker();
    let proof = worker
        .prover(1, long())
        .prove(fixture.program_key, &real_statement())
        .expect("accepted");
    assert_eq!(proof.proof_bytes, fixture.proof);
    assert_eq!(proof.public_values, fixture.public_values);
    let requests = worker.requests();
    assert_eq!(requests.len(), 1);
    let seen = &requests[0];
    assert_eq!(
        (seen.method.as_str(), seen.path.as_str()),
        ("POST", "/prove")
    );
    assert_eq!(
        seen.authorization.as_deref(),
        Some(format!("Bearer {API_KEY}").as_str())
    );
    assert_eq!(seen.user_agent.as_deref(), Some("zk-bridge-prover"));
    let body: ProveRequestBody = serde_json::from_str(&seen.body).unwrap();
    assert_eq!(body.program_key, format!("{:#x}", fixture.program_key));
    assert_eq!(body.statement_kind, ProgramKind::LightClient);
    assert_eq!(
        body.guest_input,
        hex::encode_prefixed(guest_input_bytes(&real_ethereum_input()))
    );
}

/// Claim: public values that differ from the native run in one byte are refused, and the job is not sent again.
/// Why it matters: a worker that proves another statement would move a light client to a header that the program did
/// not check. The proof may even verify; only the native comparison catches the swap.
#[test]
fn wrong_public_values_are_refused() {
    let fixture = fixture();
    let mut values = fixture.public_values.clone();
    *values.last_mut().unwrap() ^= 1;
    let reply = Reply::ok(&fixture.proof, &values);
    let worker = FakeWorker::start(move |_| reply.clone());
    let error = worker
        .prover(3, long())
        .prove(fixture.program_key, &real_statement())
        .unwrap_err();
    assert!(
        error.to_string().contains("differ from the native run"),
        "got {error}"
    );
    assert_eq!(worker.requests().len(), 1);
}

/// Claim: a proof one byte short or one byte long is refused before verification, with the lengths in the message.
#[test]
fn a_wrong_proof_length_is_refused() {
    let fixture = fixture();
    let mut longer = fixture.proof.clone();
    longer.push(0);
    for proof in [fixture.proof[..fixture.proof.len() - 1].to_vec(), longer] {
        let reply = Reply::ok(&proof, &fixture.public_values);
        let worker = FakeWorker::start(move |_| reply.clone());
        let error = worker
            .prover(1, long())
            .prove(fixture.program_key, &real_statement())
            .unwrap_err();
        let text = error.to_string();
        assert!(
            text.contains(&format!("{} bytes", proof.len())) && text.contains("356"),
            "got {text}"
        );
    }
}

/// Claim: a proof with another selector than the pinned verifier's `0x4388a21c` is refused, and the message names both.
/// Why it matters: the verifier contract rejects such a proof. The local check saves the transaction.
#[test]
fn a_wrong_selector_is_refused() {
    let fixture = fixture();
    let mut proof = fixture.proof.clone();
    proof[0] ^= 0xff;
    let reply = Reply::ok(&proof, &fixture.public_values);
    let worker = FakeWorker::start(move |_| reply.clone());
    let error = worker
        .prover(1, long())
        .prove(fixture.program_key, &real_statement())
        .unwrap_err();
    let text = error.to_string();
    assert!(
        text.contains("0xbc88a21c") && text.contains("0x4388a21c"),
        "got {text}"
    );
}

/// Claim: a proof that is good for one program key is refused when the caller asks for another key.
/// Why it matters: the contract stores one key. A proof of any other program must never reach it, and the key
/// is bound by the Groth16 verification, not by what the worker says.
#[test]
fn a_proof_for_another_program_key_is_refused() {
    let (worker, fixture) = good_worker();
    let mut other_key = fixture.program_key;
    other_key.0[31] ^= 1;
    let error = worker
        .prover(1, long())
        .prove(other_key, &real_statement())
        .unwrap_err();
    assert!(error.to_string().contains("does not verify"), "got {error}");
}

/// Claim: one flipped bit inside the Groth16 part makes the proof fail verification.
/// Why it matters: shape checks alone accept this. The local verification is what shows that the bytes are a proof.
#[test]
fn a_tampered_groth16_proof_is_refused() {
    let fixture = fixture();
    let mut proof = fixture.proof.clone();
    proof[200] ^= 1;
    let reply = Reply::ok(&proof, &fixture.public_values);
    let worker = FakeWorker::start(move |_| reply.clone());
    let error = worker
        .prover(1, long())
        .prove(fixture.program_key, &real_statement())
        .unwrap_err();
    assert!(error.to_string().contains("does not verify"), "got {error}");
}

/// Claim: when the worker says it does not hold the key (400), the refusal is final: one request, no retries.
#[test]
fn a_refusal_by_the_worker_is_not_retried() {
    for status in [400, 401, 422] {
        let worker = FakeWorker::start(move |_| {
            Reply::with(
                status,
                r#"{"error":"this worker holds no program with key 0x01"}"#,
            )
        });
        let error = worker
            .prover(4, long())
            .prove(fixture().program_key, &real_statement())
            .unwrap_err();
        assert!(error.to_string().contains("refused the job"), "got {error}");
        assert_eq!(worker.requests().len(), 1, "status {status}");
    }
}

/// Claim: a statement that the program rejects never leaves the machine.
/// Why it matters: a rejected input has no proof. Sending it would cost a cold start and a GPU run for nothing.
#[test]
fn a_statement_the_program_rejects_is_not_sent() {
    let (worker, fixture) = good_worker();
    let chain = ChainKind::Pulsechain;
    let built = build_update(
        chain.spec(),
        UpdateRecipe {
            store_slot: 8_300,
            finalized_slot: 8_400,
            attested_slot: 8_500,
            signature_slot: 8_501,
            participants: 341,
            include_next_committee: true,
            store_knows_next_committee: true,
        },
    );
    let statement = ProofStatement::Verified(UpdateInput {
        chain,
        store: built.store,
        updates: vec![built.update],
    });
    let error = worker
        .prover(1, long())
        .prove(fixture.program_key, &statement)
        .unwrap_err();
    assert!(
        matches!(error, Error::VerificationRefused(_)),
        "got {error}"
    );
    assert!(worker.requests().is_empty());
}

/// Claim: a request that outlives the timeout is sent again, and the second answer is accepted.
/// Why it matters: a cold RunPod worker can take minutes. The client must not give up on the first silence.
#[test]
fn a_timeout_is_retried() {
    let fixture = fixture();
    let good = Reply::ok(&fixture.proof, &fixture.public_values);
    let worker = FakeWorker::start(move |index| {
        if index == 0 {
            return good.clone().after(Duration::from_millis(1500));
        }
        good.clone()
    });
    let proof = worker
        .prover(2, Duration::from_millis(300))
        .prove(fixture.program_key, &real_statement())
        .expect("the second attempt is accepted");
    assert_eq!(proof.proof_bytes, fixture.proof);
    assert_eq!(worker.requests().len(), 2);
}

/// Claim: cold-start answers are retried until the worker is ready: a 503, a 502 and the "no workers available"
/// answer, then success.
#[test]
fn cold_start_answers_are_retried() {
    let fixture = fixture();
    let good = Reply::ok(&fixture.proof, &fixture.public_values);
    let worker = FakeWorker::start(move |index| match index {
        0 => Reply::with(503, r#"{"error":"the worker is still starting"}"#),
        1 => Reply::with(502, "Bad Gateway"),
        2 => Reply::with(400, r#"{"error":"no workers available"}"#),
        _ => good.clone(),
    });
    worker
        .prover(4, long())
        .prove(fixture.program_key, &real_statement())
        .expect("the fourth attempt is accepted");
    assert_eq!(worker.requests().len(), 4);
}

/// Claim: when every attempt fails, the backend stops after exactly the configured attempts, says how many it made
/// and why the last one failed, and never prints the API key.
#[test]
fn the_attempts_run_out() {
    let worker =
        FakeWorker::start(|_| Reply::with(503, r#"{"error":"the worker is still starting"}"#));
    let error = worker
        .prover(3, long())
        .prove(fixture().program_key, &real_statement())
        .unwrap_err();
    let text = error.to_string();
    assert!(
        text.contains("after 3 attempts") && text.contains("still starting"),
        "got {text}"
    );
    assert!(!text.contains(API_KEY));
    assert_eq!(worker.requests().len(), 3);
}

/// Claim: an answer with status 200 that is not a proof is refused, and so is hex that is not hex.
#[test]
fn a_malformed_success_is_refused() {
    let worker = FakeWorker::start(|_| Reply::with(200, "<html>hello</html>"));
    let error = worker
        .prover(1, long())
        .prove(fixture().program_key, &real_statement())
        .unwrap_err();
    assert!(matches!(error, Error::Malformed(_)), "got {error}");
    let worker =
        FakeWorker::start(|_| Reply::with(200, r#"{"proof":"0xzz","publicValues":"0x00"}"#));
    let error = worker
        .prover(1, long())
        .prove(fixture().program_key, &real_statement())
        .unwrap_err();
    assert!(matches!(error, Error::Malformed(_)), "got {error}");
}

/// Claim: the backend and the real worker request handling work together over a socket, with a stub in place of the
/// GPU client that returns the real proof.
/// Why it matters: it catches a mismatch between the two ends of the JSON contract, which separate unit tests miss.
#[test]
fn the_backend_and_the_worker_agree_over_http() {
    use zk_bridge_prover::prover::{GuestJob, Proof};
    use zk_bridge_prover::worker::{serve, GuestProver, Worker};

    struct ProofFromFixture(Fixture);
    impl GuestProver for ProofFromFixture {
        fn holds(&self, program_key: B256) -> Option<ProgramKind> {
            (program_key == self.0.program_key).then_some(ProgramKind::LightClient)
        }
        fn prove_guest(
            &self,
            _program_key: B256,
            job: &GuestJob,
        ) -> zk_bridge_prover::error::Result<Proof> {
            Ok(Proof {
                public_values: job.expected_values.clone(),
                proof_bytes: self.0.proof.clone(),
            })
        }
    }

    let fixture = fixture();
    let program_key = fixture.program_key;
    let worker = Arc::new(Worker::new(Logger::in_memory().0));
    worker.set_ready(Box::new(ProofFromFixture(fixture)));
    let server = Arc::new(tiny_http::Server::http("127.0.0.1:0").unwrap());
    let url = format!("http://{}", server.server_addr().to_ip().unwrap());
    let serving = Arc::clone(&server);
    let handle = std::thread::spawn(move || serve(worker, &serving));

    let backend = RemoteProver::new(
        RemoteSettings {
            endpoint_url: url.clone(),
            api_key: API_KEY.into(),
            timeout: long(),
            attempts: 1,
            retry_delay: Duration::ZERO,
        },
        Logger::in_memory().0,
    );
    let proof = backend
        .prove(program_key, &real_statement())
        .expect("accepted");
    assert_eq!(proof.proof_bytes.len(), 356);
    // The health route answers on the same server.
    let ping = ureq::get(format!("{url}/ping")).call().unwrap();
    assert_eq!(ping.status().as_u16(), 200);
    // A key that the worker does not hold is refused by the worker and the backend reports it.
    let mut other = program_key;
    other.0[0] ^= 1;
    let error = backend.prove(other, &real_statement()).unwrap_err();
    assert!(
        error.to_string().contains("holds no program"),
        "got {error}"
    );

    server.unblock();
    handle.join().unwrap();
}
