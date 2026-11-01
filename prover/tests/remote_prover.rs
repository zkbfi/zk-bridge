//! The remote backend against a fake worker: an HTTP server in this process.
//!
//! The good answer is a real Groth16 proof of the real Ethereum update that `tests/sp1_execute.rs` proves
//! (`test/hardened/fixtures/sp1-proof-ethereum-update.json`). So the accept test runs the real local verification
//! of `sp1-verifier`, and the refusal tests change one thing in a proof that is known to verify.
//!
//! Each test names what the backend must refuse and why that refusal protects a message delivery.
//!
//! These tests are ignored since the programs began to prove the branch of `genesis_validators_root`. The real Ethereum
//! update of the fixtures has no such branch (a beacon node does not serve it, and the attested state is not on file), so
//! the program refuses it, and the stored proof belongs to the old program. Run them again after the fixture is made anew
//! from a real update with its attested state and a real proof of the rebuilt program.

use alloy_primitives::{hex, B256};
use lc_testkit::json::{bootstrap, light_client_update, load_response, store_from_bootstrap};
use lc_testkit::synthetic::{build_update, UpdateRecipe};
use std::str::FromStr;
use std::sync::{Arc, Mutex};
use std::time::Duration;
use zk_bridge_prover::error::Error;
use zk_bridge_prover::light_client::{
    guest_input_bytes, steps_with_table_versions, ChainKind, UpdateInput,
};
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
        steps: steps_with_table_versions(ChainKind::Ethereum, vec![update]),
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
            timings: None,
        };
        Self::with(200, serde_json::to_string(&body).unwrap())
    }

    /// A good answer that carries the worker's timings.
    fn ok_with_timings(proof: &[u8], public_values: &[u8], timings: serde_json::Value) -> Self {
        let body = ProveResponseBody {
            proof: hex::encode_prefixed(proof),
            public_values: hex::encode_prefixed(public_values),
            timings: Some(timings),
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
                label: "remote".into(),
                endpoint_url: self.url.clone(),
                api_key: Some(API_KEY.into()),
                timeout,
                attempts,
                retry_delay: Duration::from_millis(20),
                cold_start_wait: Duration::from_secs(30),
            },
            Logger::in_memory().0,
        )
    }

    /// A backend with one attempt for ordinary failures and `cold_start_wait` for a worker that is not ready. The
    /// second value gives the log lines.
    fn waiting_prover(&self, cold_start_wait: Duration) -> (RemoteProver, Arc<Mutex<Vec<String>>>) {
        let (logger, lines) = Logger::in_memory();
        let prover = RemoteProver::new(
            RemoteSettings {
                label: "remote".into(),
                endpoint_url: self.url.clone(),
                api_key: Some(API_KEY.into()),
                timeout: long(),
                attempts: 1,
                retry_delay: Duration::from_millis(20),
                cold_start_wait,
            },
            logger,
        );
        (prover, lines)
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
#[ignore = "needs a real Ethereum update with the branch of genesis_validators_root and a real proof of the rebuilt light-client program (fixture regeneration)"]
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
#[ignore = "needs a real Ethereum update with the branch of genesis_validators_root and a real proof of the rebuilt light-client program (fixture regeneration)"]
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
#[ignore = "needs a real Ethereum update with the branch of genesis_validators_root and a real proof of the rebuilt light-client program (fixture regeneration)"]
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
#[ignore = "needs a real Ethereum update with the branch of genesis_validators_root and a real proof of the rebuilt light-client program (fixture regeneration)"]
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
#[ignore = "needs a real Ethereum update with the branch of genesis_validators_root and a real proof of the rebuilt light-client program (fixture regeneration)"]
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
#[ignore = "needs a real Ethereum update with the branch of genesis_validators_root and a real proof of the rebuilt light-client program (fixture regeneration)"]
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
#[ignore = "needs a real Ethereum update with the branch of genesis_validators_root and a real proof of the rebuilt light-client program (fixture regeneration)"]
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
#[ignore = "needs a real Ethereum update with the branch of genesis_validators_root and a real proof of the rebuilt light-client program (fixture regeneration)"]
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
        steps: steps_with_table_versions(chain, vec![built.update]),
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
#[ignore = "needs a real Ethereum update with the branch of genesis_validators_root and a real proof of the rebuilt light-client program (fixture regeneration)"]
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
#[ignore = "needs a real Ethereum update with the branch of genesis_validators_root and a real proof of the rebuilt light-client program (fixture regeneration)"]
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

/// Claim: when every attempt fails with an error that is not a cold start (here a 500), the backend stops after exactly the configured attempts, says how many it made
/// and why the last one failed, and never prints the API key.
#[test]
#[ignore = "needs a real Ethereum update with the branch of genesis_validators_root and a real proof of the rebuilt light-client program (fixture regeneration)"]
fn the_attempts_run_out() {
    let worker = FakeWorker::start(|_| Reply::with(500, r#"{"error":"the proof failed"}"#));
    let error = worker
        .prover(3, long())
        .prove(fixture().program_key, &real_statement())
        .unwrap_err();
    let text = error.to_string();
    assert!(
        text.contains("after 3 attempts") && text.contains("the proof failed"),
        "got {text}"
    );
    assert!(!text.contains(API_KEY));
    assert_eq!(worker.requests().len(), 3);
}

/// Claim: an answer with status 200 that is not a proof is refused, and so is hex that is not hex.
#[test]
#[ignore = "needs a real Ethereum update with the branch of genesis_validators_root and a real proof of the rebuilt light-client program (fixture regeneration)"]
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
#[ignore = "needs a real Ethereum update with the branch of genesis_validators_root and a real proof of the rebuilt light-client program (fixture regeneration)"]
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
            label: "remote".into(),
            endpoint_url: url.clone(),
            api_key: Some(API_KEY.into()),
            timeout: long(),
            attempts: 1,
            retry_delay: Duration::ZERO,
            cold_start_wait: Duration::ZERO,
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

/// The answer of the RunPod load balancer when no worker became ready within its own wait (seen on 2026-10-31 after
/// about 5 minutes, while the hosts pulled the 20 GB image).
const RUNPOD_COLD: &str =
    r#"{"status":400,"title":"Bad Request","detail":"timed out waiting for worker"}"#;

/// Any request body: these tests drive the transport only, so they need no statement that the program accepts.
const BODY: &str = r#"{"programKey":"0x01","statementKind":"lightClient","guestInput":"0x"}"#;

fn transport_answer() -> Reply {
    Reply::ok(&[0xaa; 4], &[0xbb; 2])
}

/// Claim: a cold worker is awaited. The RunPod 400 "timed out waiting for worker", the worker's 503 and a 204 are
/// "not ready yet": the backend waits and sends the job again, and accepts the answer once the worker is up. These
/// waits do not spend the attempts for ordinary failures (here 1). Each wait writes one log line without the key.
/// Why it matters: on 2026-10-31 a cold endpoint answered this 400 after about 5 minutes and the prover gave up at
/// once, while the worker became ready minutes later.
#[test]
fn a_cold_worker_is_awaited_until_it_is_ready() {
    let good = transport_answer();
    let worker = FakeWorker::start(move |index| match index {
        0 | 1 => Reply::with(400, RUNPOD_COLD),
        2 => Reply::with(503, r#"{"error":"the worker is still starting"}"#),
        3 => Reply::with(204, ""),
        _ => good.clone(),
    });
    let (prover, lines) = worker.waiting_prover(Duration::from_secs(30));
    let answer = prover
        .request_proof(BODY)
        .expect("the answer after the cold start");
    assert_eq!(answer.proof, "0xaaaaaaaa");
    assert_eq!(worker.requests().len(), 5);
    let lines = lines.lock().unwrap().clone();
    let waits: Vec<&String> = lines
        .iter()
        .filter(|line| line.contains("remote_worker_not_ready"))
        .collect();
    assert_eq!(waits.len(), 4, "{lines:?}");
    assert!(
        waits[0].contains("timed out waiting for worker"),
        "{}",
        waits[0]
    );
    assert!(lines.iter().all(|line| !line.contains(API_KEY)));
}

/// Claim: when the worker is still not ready at the end of the configured wait, the backend stops with a message
/// that says it waited, names the setting and gives the last answer. It never prints the key.
/// Why it matters: the backend's job limit must hold, and the operator must see why the proof failed.
#[test]
fn a_cold_start_beyond_the_limit_fails_clearly() {
    let worker = FakeWorker::start(|_| Reply::with(400, RUNPOD_COLD));
    let (prover, _lines) = worker.waiting_prover(Duration::from_millis(400));
    let started = std::time::Instant::now();
    let error = prover.request_proof(BODY).unwrap_err();
    let elapsed = started.elapsed();
    let text = error.to_string();
    assert!(
        text.contains("not ready")
            && text.contains("remote_cold_start_wait_seconds")
            && text.contains("timed out waiting for worker"),
        "got {text}"
    );
    assert!(!text.contains(API_KEY));
    assert!(worker.requests().len() > 1, "it waited and sent again");
    assert!(
        elapsed < Duration::from_secs(5),
        "it stopped near the limit: {elapsed:?}"
    );
}

/// Claim: every other 400 stops at once, also after a cold start answer: a refusal by the worker, another RunPod
/// detail, and a worker error that only mentions the cold start text in its own field.
/// Why it matters: a rejected input is never retried, and a paid proof is never run twice.
#[test]
fn another_400_is_not_retried() {
    let worker = FakeWorker::start(|index| match index {
        0 => Reply::with(400, RUNPOD_COLD),
        _ => Reply::with(
            400,
            r#"{"error":"this worker holds no program with key 0x01"}"#,
        ),
    });
    let (prover, _lines) = worker.waiting_prover(Duration::from_secs(30));
    let error = prover.request_proof(BODY).unwrap_err();
    assert!(error.to_string().contains("refused the job"), "got {error}");
    assert_eq!(worker.requests().len(), 2);

    for body in [
        r#"{"status":400,"title":"Bad Request","detail":"invalid request body"}"#,
        r#"{"error":"the request is not valid: timed out waiting for worker"}"#,
        "Bad Request",
    ] {
        let worker = FakeWorker::start(move |_| Reply::with(400, body));
        let (prover, _lines) = worker.waiting_prover(Duration::from_secs(30));
        let error = prover.request_proof(BODY).unwrap_err();
        assert!(
            error.to_string().contains("refused the job"),
            "{body}: got {error}"
        );
        assert_eq!(worker.requests().len(), 1, "{body}");
    }
}

fn worker_timings_json() -> serde_json::Value {
    serde_json::json!({
        "queueMs": 3, "nativeMs": 400, "proveMs": 41000, "verifyMs": 20, "totalMs": 41500,
        "gpu": "NVIDIA L40S", "cpuModel": "AMD EPYC 9354", "cpuCount": 32
    })
}

/// Claim: the cold-start answers are counted, the wait for the worker covers every pause before the request that was
/// accepted, and the accepted request is timed apart. The worker's timings come back with the answer.
/// Why it matters: this is the data that separates "waiting for a GPU" from "proving".
#[test]
fn waits_and_the_accepted_request_are_timed_apart() {
    let good = Reply::ok_with_timings(&[0xaa; 4], &[0xbb; 2], worker_timings_json())
        .after(Duration::from_millis(150));
    let worker = FakeWorker::start(move |index| match index {
        0 | 1 => Reply::with(400, RUNPOD_COLD),
        _ => good.clone(),
    });
    let (prover, _lines) = worker.waiting_prover(Duration::from_secs(30));
    let (answer, timings) = prover.request_proof_timed(BODY).expect("accepted");
    assert_eq!(answer.proof, "0xaaaaaaaa");
    assert_eq!(timings.not_ready_count, 2);
    assert_eq!(timings.retry_count, 0);
    // The pauses are 20 ms and 40 ms (the retry delay doubles).
    assert!(timings.wait_worker_ms >= 60, "{timings:?}");
    assert!(timings.wait_worker_ms < 5_000, "{timings:?}");
    assert!(timings.remote_ms >= 150, "{timings:?}");
    let worker_side = timings.worker.expect("the worker's timings");
    assert_eq!(worker_side.prove_ms, 41_000);
    assert_eq!(worker_side.gpu.as_deref(), Some("NVIDIA L40S"));
    assert_eq!(worker_side.cpu_count, Some(32));
}

/// Claim: a worker without the `timings` field still works. The result has no worker timings, and the step lines say
/// that the worker sent none.
/// Why it matters: the GPU image is rebuilt later than the producer. Both orders must work.
#[test]
fn a_worker_without_timings_still_works() {
    let good = transport_answer();
    let worker = FakeWorker::start(move |_| good.clone());
    let (prover, lines) = worker.waiting_prover(Duration::from_secs(30));
    let (_, timings) = prover.request_proof_timed(BODY).expect("accepted");
    assert_eq!(timings.not_ready_count, 0);
    assert!(timings.worker.is_none());
    let prover_timings = zk_bridge_prover::timing::ProverTimings {
        native_ms: 7,
        verify_ms: 2,
        remote: Some(timings),
    };
    prover.log_steps(&prover_timings);
    let lines = lines.lock().unwrap().clone();
    assert!(
        lines
            .iter()
            .any(|line| line.contains("event=prove_step step=worker worker_timings=none")),
        "{lines:?}"
    );
}

/// Claim: a `timings` value that does not fit is ignored: the proof still comes back.
/// Why it matters: the timings are for the logs. A worker bug there must never cost a proof.
#[test]
fn timings_that_do_not_fit_are_ignored() {
    for timings in [
        serde_json::json!("fast"),
        serde_json::json!({"totalMs": "x"}),
    ] {
        let good = Reply::ok_with_timings(&[0xaa; 4], &[0xbb; 2], timings);
        let worker = FakeWorker::start(move |_| good.clone());
        let (prover, _lines) = worker.waiting_prover(Duration::from_secs(30));
        let (answer, timings) = prover.request_proof_timed(BODY).expect("accepted");
        assert_eq!(answer.proof, "0xaaaaaaaa");
        assert!(timings.worker.is_none());
    }
}

/// Claim: an ordinary failure that is retried is counted apart from the not-ready answers, and its time is part of the
/// wait for the worker, not of the accepted request.
#[test]
fn a_retry_is_counted_and_waited_for() {
    let good = transport_answer();
    let worker = FakeWorker::start(move |index| match index {
        0 => Reply::with(500, r#"{"error":"the GPU ran out of memory"}"#),
        _ => good.clone(),
    });
    let prover = worker.prover(2, long());
    let (_, timings) = prover.request_proof_timed(BODY).expect("accepted");
    assert_eq!((timings.retry_count, timings.not_ready_count), (1, 0));
    assert!(timings.wait_worker_ms >= 20, "{timings:?}");
}

/// Claim: the step lines show the worker's numbers and hardware with the documented keys, and no line holds the API key
/// or a URL.
#[test]
fn the_step_lines_name_the_worker_and_hold_no_secret() {
    let good = Reply::ok_with_timings(&[0xaa; 4], &[0xbb; 2], worker_timings_json());
    let worker = FakeWorker::start(move |_| good.clone());
    let (prover, lines) = worker.waiting_prover(Duration::from_secs(30));
    let (_, remote) = prover.request_proof_timed(BODY).expect("accepted");
    prover.log_steps(&zk_bridge_prover::timing::ProverTimings {
        native_ms: 7,
        verify_ms: 2,
        remote: Some(remote),
    });
    let lines = lines.lock().unwrap().clone();
    let all = lines.join("\n");
    for expected in [
        "step=prover_native elapsed_ms=7",
        "step=wait_worker elapsed_ms=",
        "not_ready_count=0",
        "step=remote elapsed_ms=",
        "step=verify elapsed_ms=2",
        "worker_timings=reported",
        "worker_prove_ms=41000",
        "worker_gpu=\"NVIDIA L40S\"",
        "worker_cpu_count=32",
    ] {
        assert!(all.contains(expected), "{expected} missing in {all}");
    }
    assert!(
        !all.contains(API_KEY) && !all.contains("http://") && !all.contains("https://"),
        "{all}"
    );
}

/// A URL where nothing listens: a port that was bound and let go.
fn closed_url() -> String {
    let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
    let address = listener.local_addr().unwrap();
    drop(listener);
    format!("http://{address}")
}

/// The settings of one endpoint for the failover tests: short pauses, one attempt per endpoint unless changed.
fn endpoint(label: &str, url: &str, api_key: Option<&str>, ready_wait: Duration) -> RemoteSettings {
    RemoteSettings {
        label: label.into(),
        endpoint_url: url.into(),
        api_key: api_key.map(str::to_string),
        timeout: Duration::from_secs(5),
        attempts: 1,
        retry_delay: Duration::from_millis(20),
        cold_start_wait: ready_wait,
    }
}

/// A dedicated worker without a key, then a serverless endpoint with one. The second value gives the log lines.
fn two_endpoints(
    dedicated_url: &str,
    serverless_url: &str,
) -> (RemoteProver, Arc<Mutex<Vec<String>>>) {
    let (logger, lines) = Logger::in_memory();
    let prover = RemoteProver::with_endpoints(
        vec![
            endpoint("dedicated", dedicated_url, None, Duration::from_millis(300)),
            endpoint(
                "serverless",
                serverless_url,
                Some(API_KEY),
                Duration::from_secs(30),
            ),
        ],
        logger,
    );
    (prover, lines)
}

/// Asserts that no log line names an address of an endpoint or the key.
fn assert_no_address(lines: &Arc<Mutex<Vec<String>>>, addresses: &[&str]) {
    for line in lines.lock().unwrap().iter() {
        assert!(!line.contains(API_KEY), "{line}");
        for address in addresses {
            let host = address.trim_start_matches("http://");
            assert!(!line.contains(host), "{line}");
        }
    }
}

/// Claim: when the dedicated worker is unreachable, the job goes to the serverless endpoint, which gives the proof.
/// The timings name the serverless endpoint and one failover. The failover line names both endpoints by position and
/// label, never by address, and never shows the key.
/// Why it matters: a dedicated worker that is down (restarted, out of capacity) must not stop the delivery.
#[test]
fn an_unreachable_dedicated_worker_falls_over_to_serverless() {
    let serverless = FakeWorker::start(|_| transport_answer());
    let dedicated_url = closed_url();
    let (prover, lines) = two_endpoints(&dedicated_url, &serverless.url);
    let (answer, timings) = prover
        .request_proof_timed(BODY)
        .expect("serverless answers");
    assert_eq!(answer.proof, "0xaaaaaaaa");
    assert_eq!(timings.endpoint, "serverless");
    assert_eq!(timings.failover_count, 1);
    assert_eq!(serverless.requests().len(), 1);
    assert_eq!(
        serverless.requests()[0].authorization.as_deref(),
        Some(format!("Bearer {API_KEY}").as_str())
    );
    let all = lines.lock().unwrap().join("\n");
    let failover = lines
        .lock()
        .unwrap()
        .iter()
        .find(|line| line.contains("event=remote_endpoint_failover"))
        .cloned()
        .expect("a failover line");
    for part in [
        "endpoint_index=1",
        "endpoint=dedicated",
        "next_endpoint_index=2",
        "next_endpoint=serverless",
    ] {
        assert!(failover.contains(part), "{part} in {failover}");
    }
    assert!(!all.contains("remote_job_refused"), "{all}");
    assert_no_address(&lines, &[&dedicated_url, &serverless.url]);
}

/// Claim: a dedicated worker that stays not ready past its own short wait is left for the serverless endpoint. The
/// short wait holds: the job does not sit out the serverless endpoint's long wait on the dedicated worker.
#[test]
fn a_dedicated_worker_not_ready_past_its_wait_falls_over() {
    let dedicated =
        FakeWorker::start(|_| Reply::with(503, r#"{"error":"the worker is still starting"}"#));
    let serverless = FakeWorker::start(|_| transport_answer());
    let (prover, lines) = two_endpoints(&dedicated.url, &serverless.url);
    let started = std::time::Instant::now();
    let (_, timings) = prover
        .request_proof_timed(BODY)
        .expect("serverless answers");
    assert!(
        started.elapsed() < Duration::from_secs(5),
        "{:?}",
        started.elapsed()
    );
    assert!(!dedicated.requests().is_empty());
    assert_eq!(serverless.requests().len(), 1);
    assert_eq!(timings.endpoint, "serverless");
    assert_eq!(timings.failover_count, 1);
    assert!(timings.not_ready_count >= 1);
    let all = lines.lock().unwrap().join("\n");
    assert!(
        all.contains("event=remote_worker_not_ready") && all.contains("endpoint=dedicated"),
        "{all}"
    );
    assert!(all.contains("not ready after"), "{all}");
    assert_no_address(&lines, &[&dedicated.url, &serverless.url]);
}

/// Claim: when the dedicated worker refuses the job (a 400 that rejects the input, a 422), the job fails at once and
/// the serverless endpoint is never asked.
/// Why it matters: the same input fails the same way everywhere. Sending it on would pay for a cold start and a GPU
/// run that cannot give a proof.
#[test]
fn a_refusal_of_the_job_does_not_fall_over() {
    for (status, body) in [
        (
            400,
            r#"{"error":"this worker holds no program with key 0x01"}"#,
        ),
        (
            422,
            r#"{"error":"the program rejects the input: too few signers"}"#,
        ),
    ] {
        let dedicated = FakeWorker::start(move |_| Reply::with(status, body));
        let serverless = FakeWorker::start(|_| transport_answer());
        let (prover, lines) = two_endpoints(&dedicated.url, &serverless.url);
        let error = prover.request_proof(BODY).unwrap_err();
        assert!(
            error.to_string().contains("refused the job"),
            "{status}: {error}"
        );
        assert_eq!(dedicated.requests().len(), 1, "{status}");
        assert!(serverless.requests().is_empty(), "{status}");
        let all = lines.lock().unwrap().join("\n");
        assert!(
            all.contains("event=remote_job_refused") && all.contains("endpoint=dedicated"),
            "{all}"
        );
        assert!(!all.contains("remote_endpoint_failover"), "{all}");
    }
}

/// Claim: a 200 that is not a proof ends the job at the endpoint that sent it; the serverless endpoint is not asked.
#[test]
fn a_malformed_answer_does_not_fall_over() {
    let dedicated = FakeWorker::start(|_| Reply::with(200, "<html>hello</html>"));
    let serverless = FakeWorker::start(|_| transport_answer());
    let (prover, _lines) = two_endpoints(&dedicated.url, &serverless.url);
    let error = prover.request_proof(BODY).unwrap_err();
    assert!(matches!(error, Error::Malformed(_)), "{error}");
    assert!(serverless.requests().is_empty());
}

/// Claim: when the dedicated worker gives the proof, the serverless endpoint is never called. The dedicated worker
/// gets no `Authorization` header, because it has no key.
/// Why it matters: cost. The serverless endpoint is a fallback, and it bills each worker that starts.
#[test]
fn a_proof_from_the_dedicated_worker_never_reaches_serverless() {
    let dedicated = FakeWorker::start(|_| transport_answer());
    let serverless = FakeWorker::start(|_| transport_answer());
    let (prover, _lines) = two_endpoints(&dedicated.url, &serverless.url);
    let (_, timings) = prover.request_proof_timed(BODY).expect("dedicated answers");
    assert_eq!(timings.endpoint, "dedicated");
    assert_eq!(timings.failover_count, 0);
    assert_eq!(dedicated.requests().len(), 1);
    assert_eq!(dedicated.requests()[0].authorization, None);
    assert!(serverless.requests().is_empty());
}

/// Claim: an endpoint that turns the request away itself (401, 403: a key it does not take; 404: a wrong path) is
/// left for the next one after one request.
#[test]
fn an_endpoint_that_turns_the_request_away_falls_over() {
    for status in [401, 403, 404] {
        let dedicated = FakeWorker::start(move |_| Reply::with(status, "Unauthorized"));
        let serverless = FakeWorker::start(|_| transport_answer());
        let (prover, _lines) = two_endpoints(&dedicated.url, &serverless.url);
        let (_, timings) = prover
            .request_proof_timed(BODY)
            .expect("serverless answers");
        assert_eq!(timings.endpoint, "serverless", "{status}");
        assert_eq!(dedicated.requests().len(), 1, "{status}");
    }
}

/// Claim: a dedicated worker that fails with a server error is retried up to its own attempts, then left for the next
/// endpoint. The retries add up in the timings.
#[test]
fn server_errors_use_the_endpoint_attempts_then_fall_over() {
    let dedicated = FakeWorker::start(|_| Reply::with(500, r#"{"error":"the proof failed"}"#));
    let serverless = FakeWorker::start(|_| transport_answer());
    let mut first = endpoint("dedicated", &dedicated.url, None, Duration::ZERO);
    first.attempts = 2;
    let second = endpoint("serverless", &serverless.url, Some(API_KEY), Duration::ZERO);
    let prover = RemoteProver::with_endpoints(vec![first, second], Logger::in_memory().0);
    let (_, timings) = prover
        .request_proof_timed(BODY)
        .expect("serverless answers");
    assert_eq!(dedicated.requests().len(), 2);
    assert_eq!(timings.retry_count, 1);
    assert_eq!(timings.failover_count, 1);
}

/// Claim: when every endpoint fails, the error names each one by position and label with its last reason, and holds
/// no address and no key.
#[test]
fn every_endpoint_down_fails_clearly() {
    let dedicated_url = closed_url();
    let serverless = FakeWorker::start(|_| Reply::with(400, RUNPOD_COLD));
    let (logger, lines) = Logger::in_memory();
    let prover = RemoteProver::with_endpoints(
        vec![
            endpoint("dedicated", &dedicated_url, None, Duration::ZERO),
            endpoint(
                "serverless",
                &serverless.url,
                Some(API_KEY),
                Duration::from_millis(200),
            ),
        ],
        logger,
    );
    let text = prover.request_proof(BODY).unwrap_err().to_string();
    assert!(
        text.contains("no remote endpoint gave a proof (2 tried)"),
        "{text}"
    );
    assert!(
        text.contains("endpoint 1 (dedicated): ") && text.contains("no answer"),
        "{text}"
    );
    assert!(
        text.contains("endpoint 2 (serverless): ") && text.contains("timed out waiting for worker"),
        "{text}"
    );
    let dedicated_host = dedicated_url.trim_start_matches("http://");
    let serverless_host = serverless.url.trim_start_matches("http://");
    assert!(
        !text.contains(dedicated_host) && !text.contains(serverless_host),
        "{text}"
    );
    assert!(!text.contains(API_KEY));
    assert!(lines
        .lock()
        .unwrap()
        .iter()
        .any(|line| line.contains("event=remote_endpoints_exhausted")));
    assert_no_address(&lines, &[&dedicated_url, &serverless.url]);
}

/// Claim: a proof from the dedicated worker that fails the local checks fails the job. The serverless endpoint is not
/// asked to prove it again, and an error line names the endpoint that sent the bad proof.
/// Why it matters: a bad proof points at a broken or hostile worker. Proving again elsewhere would hide it.
#[test]
fn a_bad_proof_is_an_error_and_is_not_proved_again() {
    let chain = ChainKind::Pulsechain;
    let built = build_update(
        chain.spec(),
        UpdateRecipe {
            store_slot: 8_300,
            finalized_slot: 8_400,
            attested_slot: 8_500,
            signature_slot: 8_501,
            participants: 400,
            include_next_committee: true,
            store_knows_next_committee: true,
        },
    );
    let statement = ProofStatement::Verified(UpdateInput {
        chain,
        store: built.store,
        steps: steps_with_table_versions(chain, vec![built.update]),
    });
    let dedicated = FakeWorker::start(|_| transport_answer());
    let serverless = FakeWorker::start(|_| transport_answer());
    let (prover, lines) = two_endpoints(&dedicated.url, &serverless.url);
    let error = prover
        .prove(B256::repeat_byte(0x11), &statement)
        .unwrap_err();
    assert!(
        error.to_string().contains("differ from the native run"),
        "{error}"
    );
    assert_eq!(dedicated.requests().len(), 1);
    assert!(serverless.requests().is_empty());
    let refused = lines
        .lock()
        .unwrap()
        .iter()
        .find(|line| line.contains("event=remote_proof_refused"))
        .cloned()
        .expect("an error line");
    assert!(
        refused.contains("endpoint=dedicated") && refused.contains("level=error"),
        "{refused}"
    );
}
