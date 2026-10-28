//! The proving worker: an HTTP server that proves one statement per request.
//!
//! It is the other end of [`crate::remote::RemoteProver`]. It runs in a container on a GPU host, for example as a
//! RunPod Serverless "load balancing" endpoint (`docs/gpu-prover.md`). The module is in the default build so that its
//! request handling has tests on any machine. Only the proving client needs a GPU: the binary `prove-worker` (cargo
//! feature `sp1-cuda`) plugs in the CUDA prover.
//!
//! The contract with RunPod (https://docs.runpod.io/serverless/load-balancing/overview, read on 2026-10-23):
//!
//! - The platform sends HTTP to the port in `PORT` (default 80) and checks health on `PORT_HEALTH` (default `PORT`).
//! - `GET /ping` answers 204 while the worker starts and 200 when it is ready. Another status marks it unhealthy.
//!
//! The routes:
//!
//! - `GET /ping`: 204 while the SP1 setup runs, then 200 with `{"status":"ready"}`. After a proof has failed inside the
//!   proving client it answers 503, because the GPU server child process may be dead and does not restart. RunPod then
//!   removes the worker and starts a new one.
//! - `POST /prove`: the body is a [`ProveRequestBody`]. The answer is a [`ProveResponseBody`] with status 200, or
//!   `{"error": "..."}` with the status that [`Worker::handle`] documents.
//!
//! The worker holds no secret and does no authentication: the platform proxy checks the API key before it forwards a
//! request. It proves one statement at a time, because one GPU runs one proof. A second request waits for the first.

use crate::error::{Error, Result};
use crate::logging::Logger;
use crate::prover::{native_job_from_guest_input, GuestJob, ProgramKind, Proof};
use crate::remote::{ProveRequestBody, ProveResponseBody};
use alloy_primitives::{hex, B256};
use std::io::Read as _;
use std::path::PathBuf;
use std::str::FromStr;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex, OnceLock};

/// The largest request body that the worker reads. RunPod limits a request to 30 MB.
pub const MAX_REQUEST_BYTES: u64 = 32 * 1024 * 1024;

/// What the worker needs from a proving client. [`crate::prover::Sp1ClientProver`] implements it.
pub trait GuestProver: Send + Sync {
    /// The program that has this key, or `None` when the worker does not hold a program with it.
    fn holds(&self, program_key: B256) -> Option<ProgramKind>;

    /// Proves a job that the native run accepted. `program_key` is the key that the caller asked for.
    ///
    /// # Errors
    /// `Error::Config` when the key is not the key of the program for `job.kind`. `Error::Prover` when the proof fails.
    fn prove_guest(&self, program_key: B256, job: &GuestJob) -> Result<Proof>;
}

#[cfg(feature = "sp1")]
impl<Client> GuestProver for crate::prover::Sp1ClientProver<Client>
where
    Client: sp1_sdk::blocking::Prover,
    Client::ProvingKey: Send + Sync,
{
    fn holds(&self, program_key: B256) -> Option<ProgramKind> {
        if program_key == self.light_client_key() {
            return Some(ProgramKind::LightClient);
        }
        (Some(program_key) == self.fork_observation_key()).then_some(ProgramKind::ForkObservation)
    }

    fn prove_guest(&self, program_key: B256, job: &GuestJob) -> Result<Proof> {
        Self::prove_guest(self, program_key, job)
    }
}

/// An HTTP answer: a status and a body. An empty body is for status 204.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Answer {
    /// The status code.
    pub status: u16,
    /// The body, JSON or empty.
    pub body: Vec<u8>,
}

impl Answer {
    fn empty(status: u16) -> Self {
        Self {
            status,
            body: Vec::new(),
        }
    }

    fn json(status: u16, value: &serde_json::Value) -> Self {
        Self {
            status,
            body: value.to_string().into_bytes(),
        }
    }

    fn error(status: u16, message: impl std::fmt::Display) -> Self {
        Self::json(status, &serde_json::json!({ "error": message.to_string() }))
    }
}

/// The state of one worker: a proving client that arrives after the SP1 setup, and the lock that serializes proofs.
pub struct Worker {
    prover: OnceLock<Box<dyn GuestProver>>,
    one_proof_at_a_time: Mutex<()>,
    /// Set when the proving client failed a proof. It never resets: only a new worker is known to be sound.
    proving_client_failed: AtomicBool,
    logger: Logger,
}

impl Worker {
    /// A worker that is not ready yet: `/ping` answers 204 until [`Worker::set_ready`].
    pub fn new(logger: Logger) -> Self {
        Self {
            prover: OnceLock::new(),
            one_proof_at_a_time: Mutex::new(()),
            proving_client_failed: AtomicBool::new(false),
            logger,
        }
    }

    /// Gives the worker its proving client. From now on `/ping` answers 200 and `/prove` proves.
    pub fn set_ready(&self, prover: Box<dyn GuestProver>) {
        // A second call keeps the first client. The binary calls this once.
        let _ = self.prover.set(prover);
    }

    /// Answers one request.
    ///
    /// | Request | Answer |
    /// |---|---|
    /// | `GET /ping` | 204 while starting, 200 when ready, 503 after the proving client failed a proof |
    /// | `POST /prove`, worker not ready | 503 |
    /// | `POST /prove`, body is not a valid request | 400 |
    /// | `POST /prove`, key not held, or held for the other statement kind | 400 |
    /// | `POST /prove`, the program rejects the input | 422 |
    /// | `POST /prove`, the proof fails | 500 |
    /// | `POST /prove`, success | 200 |
    /// | any other path | 404 |
    /// | a known path with another method | 405 |
    pub fn handle(&self, method: &str, path: &str, body: &[u8]) -> Answer {
        let route_path = path.split('?').next().unwrap_or("");
        match (method, route_path) {
            ("GET", "/ping") => self.ping(),
            ("POST", "/prove") => self.prove(body),
            (_, "/ping" | "/prove") => Answer::error(405, "method not allowed"),
            _ => Answer::error(404, "not found"),
        }
    }

    fn ping(&self) -> Answer {
        if self.proving_client_failed.load(Ordering::SeqCst) {
            return Answer::error(
                503,
                "the proving client failed a proof; the worker needs a restart",
            );
        }
        if self.prover.get().is_none() {
            return Answer::empty(204);
        }
        Answer::json(200, &serde_json::json!({ "status": "ready" }))
    }

    fn prove(&self, body: &[u8]) -> Answer {
        let Some(prover) = self.prover.get() else {
            return Answer::error(503, "the worker is still starting");
        };
        let request: ProveRequestBody = match serde_json::from_slice(body) {
            Ok(request) => request,
            Err(error) => return Answer::error(400, format!("the request is not valid: {error}")),
        };
        let (program_key, guest_input) = match decode_request(&request) {
            Ok(decoded) => decoded,
            Err(error) => return Answer::error(400, error),
        };
        match prover.holds(program_key) {
            None => {
                return Answer::error(
                    400,
                    format!("this worker holds no program with key {program_key:#x}"),
                )
            }
            Some(held) if held != request.statement_kind => {
                return Answer::error(
                    400,
                    format!(
                        "key {program_key:#x} belongs to the {} program, not the {} program",
                        held.label(),
                        request.statement_kind.label()
                    ),
                )
            }
            Some(_) => {}
        }
        let job = match native_job_from_guest_input(request.statement_kind, guest_input) {
            Ok(job) => job,
            Err(Error::VerificationRefused(reason)) => {
                return Answer::error(422, format!("the program rejects the input: {reason}"))
            }
            Err(error) => return Answer::error(500, error),
        };
        let _turn = self
            .one_proof_at_a_time
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        let started = std::time::Instant::now();
        let proof = match prover.prove_guest(program_key, &job) {
            Ok(proof) => proof,
            Err(error @ Error::Config(_)) => return Answer::error(400, error),
            Err(error) => {
                // The GPU server is a child process. When it dies, every later proof fails at once ("Broken pipe"),
                // and nothing restarts it. So a failed proof marks the whole worker as unhealthy.
                self.proving_client_failed.store(true, Ordering::SeqCst);
                self.logger
                    .error("prove_failed", &[("reason", error.to_string())]);
                return Answer::error(500, error);
            }
        };
        self.logger.info(
            "proved",
            &[
                ("program", job.kind.label().to_string()),
                ("seconds", started.elapsed().as_secs().to_string()),
            ],
        );
        let response = ProveResponseBody {
            proof: hex::encode_prefixed(&proof.proof_bytes),
            public_values: hex::encode_prefixed(&proof.public_values),
        };
        match serde_json::to_value(&response) {
            Ok(value) => Answer::json(200, &value),
            Err(error) => Answer::error(500, error),
        }
    }
}

fn decode_request(request: &ProveRequestBody) -> std::result::Result<(B256, Vec<u8>), String> {
    let program_key = B256::from_str(&request.program_key)
        .map_err(|error| format!("programKey is not a 32-byte hex value: {error}"))?;
    let guest_input = hex::decode(&request.guest_input)
        .map_err(|error| format!("guestInput is not hex: {error}"))?;
    if guest_input.is_empty() {
        return Err("guestInput is empty".into());
    }
    Ok((program_key, guest_input))
}

/// Reads one request from `tiny_http`, answers it through the worker and sends the answer.
fn respond(worker: &Worker, mut request: tiny_http::Request) {
    let method = request.method().as_str().to_string();
    let path = request.url().to_string();
    let mut body = Vec::new();
    let read = request
        .as_reader()
        .take(MAX_REQUEST_BYTES + 1)
        .read_to_end(&mut body);
    let answer = match read {
        Err(error) => Answer::error(400, format!("cannot read the body: {error}")),
        Ok(_) if body.len() as u64 > MAX_REQUEST_BYTES => {
            Answer::error(413, "the body is too large")
        }
        Ok(_) => worker.handle(&method, &path, &body),
    };
    let mut response = tiny_http::Response::from_data(answer.body).with_status_code(answer.status);
    if let Ok(header) = tiny_http::Header::from_bytes("Content-Type", "application/json") {
        response = response.with_header(header);
    }
    // The caller may have gone away (a timeout on its side). There is nobody to tell.
    let _ = request.respond(response);
}

/// Serves requests until `server.unblock()` is called. Each request runs on its own thread, so `/ping` still answers
/// while a proof runs.
pub fn serve(worker: Arc<Worker>, server: &tiny_http::Server) {
    for request in server.incoming_requests() {
        let worker = Arc::clone(&worker);
        std::thread::spawn(move || respond(&worker, request));
    }
}

/// The settings of the binary, read from the environment.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct WorkerSettings {
    /// The port of the API (`PORT`, default 80).
    pub port: u16,
    /// The port of the health check (`PORT_HEALTH`, default `PORT`).
    pub health_port: u16,
    /// The light-client ELF (`ZK_BRIDGE_WORKER_LIGHT_CLIENT_ELF`).
    pub light_client_elf: PathBuf,
    /// The fork observation ELF (`ZK_BRIDGE_WORKER_OBSERVATION_ELF`).
    pub observation_elf: PathBuf,
}

impl WorkerSettings {
    /// Reads the settings through `lookup`.
    ///
    /// # Errors
    /// `Error::Config` naming the variable that is missing or wrong.
    pub fn from_lookup(lookup: &dyn Fn(&str) -> Option<String>) -> Result<Self> {
        let port_of = |name: &str, default: Option<u16>| -> Result<u16> {
            match lookup(name) {
                Some(text) => text
                    .trim()
                    .parse()
                    .map_err(|_| Error::Config(format!("{name}: expected a port number"))),
                None => default.ok_or_else(|| Error::Config(format!("{name} is not set"))),
            }
        };
        let required_path = |name: &str| -> Result<PathBuf> {
            lookup(name)
                .filter(|value| !value.is_empty())
                .map(PathBuf::from)
                .ok_or_else(|| Error::Config(format!("{name} is not set")))
        };
        let port = port_of("PORT", Some(80))?;
        Ok(Self {
            port,
            health_port: port_of("PORT_HEALTH", Some(port))?,
            light_client_elf: required_path("ZK_BRIDGE_WORKER_LIGHT_CLIENT_ELF")?,
            observation_elf: required_path("ZK_BRIDGE_WORKER_OBSERVATION_ELF")?,
        })
    }
}

/// Runs the worker: binds the ports first (so the platform sees a worker that starts), loads the proving client on a
/// second thread, then serves until the process ends.
///
/// `load` builds the proving client. It runs once, on its own thread, so `/ping` answers 204 while it works. When
/// `load` fails, the process exits with code 1, so the platform replaces the worker.
///
/// # Errors
/// `Error::Config` when a port cannot be bound.
pub fn run(
    settings: &WorkerSettings,
    load: impl FnOnce(&WorkerSettings) -> Result<Box<dyn GuestProver>> + Send + 'static,
) -> Result<()> {
    let logger = Logger::standard();
    let bind = |port: u16| {
        tiny_http::Server::http(("0.0.0.0", port))
            .map_err(|error| Error::Config(format!("cannot listen on port {port}: {error}")))
    };
    let server = bind(settings.port)?;
    let worker = Arc::new(Worker::new(logger.clone()));
    if settings.health_port != settings.port {
        let health_server = bind(settings.health_port)?;
        let health_worker = Arc::clone(&worker);
        std::thread::spawn(move || serve(health_worker, &health_server));
    }
    let loading_worker = Arc::clone(&worker);
    let loading_settings = settings.clone();
    let loading_logger = logger.clone();
    std::thread::spawn(move || {
        let started = std::time::Instant::now();
        match load(&loading_settings) {
            Ok(prover) => {
                loading_worker.set_ready(prover);
                loading_logger.info(
                    "worker_ready",
                    &[("setup_seconds", started.elapsed().as_secs().to_string())],
                );
            }
            Err(error) => {
                loading_logger.error("worker_load_failed", &[("reason", error.to_string())]);
                std::process::exit(1);
            }
        }
    });
    logger.info("worker_listening", &[("port", settings.port.to_string())]);
    serve(worker, &server);
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::light_client::{guest_input_bytes, ChainKind, UpdateInput};
    use lc_testkit::synthetic::{build_update, UpdateRecipe};
    use std::sync::atomic::{AtomicUsize, Ordering};

    const LIGHT_CLIENT_KEY: B256 = B256::repeat_byte(0x11);
    const OBSERVATION_KEY: B256 = B256::repeat_byte(0x22);

    /// A guest input that the light-client program accepts (400 of 512 signers) or rejects (341 of 512).
    fn light_client_input(participants: usize) -> Vec<u8> {
        let chain = ChainKind::Pulsechain;
        let built = build_update(
            chain.spec(),
            UpdateRecipe {
                store_slot: 8_300,
                finalized_slot: 8_400,
                attested_slot: 8_500,
                signature_slot: 8_501,
                participants,
                include_next_committee: true,
                store_knows_next_committee: true,
            },
        );
        guest_input_bytes(&UpdateInput {
            chain,
            store: built.store,
            steps: crate::light_client::steps_with_table_versions(chain, vec![built.update]),
        })
    }

    /// How a stub proving client ends.
    #[derive(Clone, Copy)]
    enum Outcome {
        Proof,
        WrongKey,
        Failure,
    }

    /// Holds two keys, answers like a client, and counts how many proofs run at the same moment.
    struct StubProver {
        outcome: Outcome,
        running: AtomicUsize,
        most_running: AtomicUsize,
    }

    impl StubProver {
        fn new(outcome: Outcome) -> Self {
            Self {
                outcome,
                running: AtomicUsize::new(0),
                most_running: AtomicUsize::new(0),
            }
        }
    }

    impl GuestProver for Arc<StubProver> {
        fn holds(&self, program_key: B256) -> Option<ProgramKind> {
            match program_key {
                LIGHT_CLIENT_KEY => Some(ProgramKind::LightClient),
                OBSERVATION_KEY => Some(ProgramKind::ForkObservation),
                _ => None,
            }
        }

        fn prove_guest(&self, _program_key: B256, job: &GuestJob) -> Result<Proof> {
            let now_running = self.running.fetch_add(1, Ordering::SeqCst) + 1;
            self.most_running.fetch_max(now_running, Ordering::SeqCst);
            std::thread::sleep(std::time::Duration::from_millis(30));
            self.running.fetch_sub(1, Ordering::SeqCst);
            match self.outcome {
                Outcome::Proof => Ok(Proof {
                    public_values: job.expected_values.clone(),
                    proof_bytes: vec![0xab; 5],
                }),
                Outcome::WrongKey => Err(Error::Config("the key differs".into())),
                Outcome::Failure => Err(Error::Prover("the GPU ran out of memory".into())),
            }
        }
    }

    fn ready_worker(outcome: Outcome) -> (Worker, Arc<StubProver>) {
        let stub = Arc::new(StubProver::new(outcome));
        let worker = Worker::new(Logger::in_memory().0);
        worker.set_ready(Box::new(Arc::clone(&stub)));
        (worker, stub)
    }

    fn request_body(program_key: B256, kind: &str, guest_input: &[u8]) -> Vec<u8> {
        serde_json::json!({
            "programKey": format!("{program_key:#x}"),
            "statementKind": kind,
            "guestInput": hex::encode_prefixed(guest_input),
        })
        .to_string()
        .into_bytes()
    }

    fn error_of(answer: &Answer) -> String {
        let value: serde_json::Value = serde_json::from_slice(&answer.body).expect("json body");
        value["error"].as_str().expect("error field").to_string()
    }

    /// Claim: `/ping` answers 204 until the proving client is set, then 200.
    /// Why it matters: RunPod routes traffic to a worker only after the first 200. A 200 too early sends a proof job to
    /// a worker that still runs the SP1 setup.
    #[test]
    fn ping_is_204_while_starting_and_200_when_ready() {
        let worker = Worker::new(Logger::in_memory().0);
        assert_eq!(worker.handle("GET", "/ping", b""), Answer::empty(204));
        worker.set_ready(Box::new(Arc::new(StubProver::new(Outcome::Proof))));
        let answer = worker.handle("GET", "/ping", b"");
        assert_eq!(answer.status, 200);
        assert_eq!(answer.body, br#"{"status":"ready"}"#);
    }

    /// Claim: after the proving client fails a proof, `/ping` answers 503 and stays 503.
    /// Why it matters: on 2026-10-26 a worker lost its GPU server to a memory limit. It kept answering `/ping` with 200
    /// and failed every later job at once, so RunPod never replaced it and the client ran out of attempts.
    #[test]
    fn ping_is_503_for_good_after_a_failed_proof() {
        let (worker, _stub) = ready_worker(Outcome::Failure);
        assert_eq!(worker.handle("GET", "/ping", b"").status, 200);
        let input = light_client_input(400);
        let answer = worker.handle(
            "POST",
            "/prove",
            &request_body(LIGHT_CLIENT_KEY, "lightClient", &input),
        );
        assert_eq!(answer.status, 500);
        let ping = worker.handle("GET", "/ping", b"");
        assert_eq!(ping.status, 503);
        assert!(error_of(&ping).contains("restart"));
        assert_eq!(worker.handle("GET", "/ping", b"").status, 503);
    }

    /// Claim: a refused key does not mark the worker as unhealthy.
    /// Why it matters: a wrong key is the caller's mistake. Replacing the worker would not help and would cost a cold start.
    #[test]
    fn a_refused_key_keeps_ping_at_200() {
        let (worker, _stub) = ready_worker(Outcome::WrongKey);
        let input = light_client_input(400);
        let answer = worker.handle(
            "POST",
            "/prove",
            &request_body(LIGHT_CLIENT_KEY, "lightClient", &input),
        );
        assert_eq!(answer.status, 400);
        assert_eq!(worker.handle("GET", "/ping", b"").status, 200);
    }

    /// Claim: a proof job before the setup ends gets 503, which the client retries.
    #[test]
    fn prove_before_ready_is_503() {
        let worker = Worker::new(Logger::in_memory().0);
        let answer = worker.handle(
            "POST",
            "/prove",
            &request_body(LIGHT_CLIENT_KEY, "lightClient", &[1]),
        );
        assert_eq!(answer.status, 503);
    }

    /// Claim: a valid job gives 200 with the proof and the public values of the native run, both as `0x` hex.
    /// Why it matters: the client compares these public values with its own native run.
    #[test]
    fn a_valid_job_is_proved() {
        let (worker, _) = ready_worker(Outcome::Proof);
        let input = light_client_input(400);
        let expected = crate::light_client::verify_light_client_natively(&input).unwrap();
        let answer = worker.handle(
            "POST",
            "/prove",
            &request_body(LIGHT_CLIENT_KEY, "lightClient", &input),
        );
        assert_eq!(
            answer.status,
            200,
            "{}",
            String::from_utf8_lossy(&answer.body)
        );
        let body: ProveResponseBody = serde_json::from_slice(&answer.body).unwrap();
        assert_eq!(body.public_values, hex::encode_prefixed(&expected));
        assert_eq!(body.proof, "0xababababab");
    }

    /// Claim: a key the worker does not hold is refused with 400 before any native run or proof.
    /// Why it matters: the worker must not prove for a program the caller cannot check.
    #[test]
    fn a_key_the_worker_does_not_hold_is_refused() {
        let (worker, stub) = ready_worker(Outcome::Proof);
        let input = light_client_input(400);
        let answer = worker.handle(
            "POST",
            "/prove",
            &request_body(B256::repeat_byte(0x33), "lightClient", &input),
        );
        assert_eq!(answer.status, 400);
        assert!(error_of(&answer).contains("holds no program"));
        assert_eq!(stub.most_running.load(Ordering::SeqCst), 0);
    }

    /// Claim: a key that is held for the other program is refused. The light-client key with the statement kind
    /// `forkObservation` must not reach the proof.
    #[test]
    fn a_key_for_the_other_statement_kind_is_refused() {
        let (worker, stub) = ready_worker(Outcome::Proof);
        let input = light_client_input(400);
        let answer = worker.handle(
            "POST",
            "/prove",
            &request_body(LIGHT_CLIENT_KEY, "forkObservation", &input),
        );
        assert_eq!(answer.status, 400);
        assert!(error_of(&answer).contains("belongs to the light client program"));
        assert_eq!(stub.most_running.load(Ordering::SeqCst), 0);
    }

    /// Claim: an input that the program rejects (341 of 512 signers) gives 422 and no proof.
    /// Why it matters: a proof of a rejected input does not exist. The worker must not spend a GPU run on it.
    #[test]
    fn an_input_the_program_rejects_is_422() {
        let (worker, stub) = ready_worker(Outcome::Proof);
        let rejected = light_client_input(341);
        let answer = worker.handle(
            "POST",
            "/prove",
            &request_body(LIGHT_CLIENT_KEY, "lightClient", &rejected),
        );
        assert_eq!(answer.status, 422);
        assert!(error_of(&answer).contains("rejects the input"));
        assert_eq!(stub.most_running.load(Ordering::SeqCst), 0);
    }

    /// Claim: malformed bodies give 400: not JSON, an unknown field, a key that is not 32 bytes, input that is not hex
    /// and empty input.
    #[test]
    fn malformed_requests_are_400() {
        let (worker, _) = ready_worker(Outcome::Proof);
        let good = request_body(LIGHT_CLIENT_KEY, "lightClient", &[1, 2]);
        let mut with_extra: serde_json::Value = serde_json::from_slice(&good).unwrap();
        with_extra["extra"] = serde_json::json!(1);
        let cases: Vec<Vec<u8>> = vec![
            b"not json".to_vec(),
            with_extra.to_string().into_bytes(),
            br#"{"programKey":"0x12","statementKind":"lightClient","guestInput":"0x01"}"#.to_vec(),
            br#"{"programKey":"0x1111111111111111111111111111111111111111111111111111111111111111","statementKind":"lightClient","guestInput":"0xzz"}"#.to_vec(),
            request_body(LIGHT_CLIENT_KEY, "lightClient", &[]),
            request_body(LIGHT_CLIENT_KEY, "somethingElse", &[1]),
        ];
        for body in cases {
            let answer = worker.handle("POST", "/prove", &body);
            assert_eq!(answer.status, 400, "{}", String::from_utf8_lossy(&body));
        }
    }

    /// Claim: a proving failure is 500 (the client may retry) and a key mismatch inside the prover is 400 (final).
    #[test]
    fn prover_errors_map_to_500_and_400() {
        let input = light_client_input(400);
        let body = request_body(LIGHT_CLIENT_KEY, "lightClient", &input);
        let (failing, _) = ready_worker(Outcome::Failure);
        assert_eq!(failing.handle("POST", "/prove", &body).status, 500);
        let (mismatched, _) = ready_worker(Outcome::WrongKey);
        assert_eq!(mismatched.handle("POST", "/prove", &body).status, 400);
    }

    /// Claim: unknown paths are 404 and a wrong method on a known path is 405.
    #[test]
    fn unknown_routes_and_methods_are_refused() {
        let (worker, _) = ready_worker(Outcome::Proof);
        assert_eq!(worker.handle("GET", "/", b"").status, 404);
        assert_eq!(worker.handle("GET", "/prove", b"").status, 405);
        assert_eq!(worker.handle("POST", "/ping", b"").status, 405);
        assert_eq!(worker.handle("GET", "/ping?probe=1", b"").status, 200);
    }

    /// Claim: three jobs at once run one after the other.
    /// Why it matters: one GPU runs one proof. Two at once would share its 24 GB of memory and both could fail.
    #[test]
    fn proofs_run_one_at_a_time() {
        let (worker, stub) = ready_worker(Outcome::Proof);
        let worker = Arc::new(worker);
        let body = Arc::new(request_body(
            LIGHT_CLIENT_KEY,
            "lightClient",
            &light_client_input(400),
        ));
        let handles: Vec<_> = (0..3)
            .map(|_| {
                let (worker, body) = (Arc::clone(&worker), Arc::clone(&body));
                std::thread::spawn(move || worker.handle("POST", "/prove", &body).status)
            })
            .collect();
        for handle in handles {
            assert_eq!(handle.join().unwrap(), 200);
        }
        assert_eq!(stub.most_running.load(Ordering::SeqCst), 1);
    }

    /// Claim: the settings read the RunPod variables, default the health port to the API port, and refuse a missing ELF.
    #[test]
    fn settings_follow_the_runpod_variables() {
        let environment = |pairs: Vec<(&'static str, &'static str)>| {
            move |name: &str| {
                pairs
                    .iter()
                    .find(|(key, _)| *key == name)
                    .map(|(_, value)| value.to_string())
            }
        };
        let elfs = [
            ("ZK_BRIDGE_WORKER_LIGHT_CLIENT_ELF", "/elf/light-client.elf"),
            (
                "ZK_BRIDGE_WORKER_OBSERVATION_ELF",
                "/elf/fork-observation.elf",
            ),
        ];
        let defaults = WorkerSettings::from_lookup(&environment(elfs.to_vec())).unwrap();
        assert_eq!((defaults.port, defaults.health_port), (80, 80));
        let mut with_ports = vec![("PORT", "8000"), ("PORT_HEALTH", "8001")];
        with_ports.extend(elfs);
        let settings = WorkerSettings::from_lookup(&environment(with_ports)).unwrap();
        assert_eq!((settings.port, settings.health_port), (8000, 8001));
        let error = WorkerSettings::from_lookup(&environment(vec![elfs[0]])).unwrap_err();
        assert!(error
            .to_string()
            .contains("ZK_BRIDGE_WORKER_OBSERVATION_ELF"));
    }
}
