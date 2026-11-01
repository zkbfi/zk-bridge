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
//!   A worker that refused its host (see [`decide_host`]) answers 503 from the start and never loads the proving client.
//! - `POST /prove`: the body is a [`ProveRequestBody`]. The answer is a [`ProveResponseBody`] with status 200, or
//!   `{"error": "..."}` with the status that [`Worker::handle`] documents.
//!
//! A worker that starts on a MIG slice, or on a host with too little memory, refuses to work: see [`HostReadings`].
//! It answers `/ping` and `/prove` with 503 for good, so RunPod replaces it and the client retries elsewhere.
//!
//! The worker holds no secret and does no authentication: the platform proxy checks the API key before it forwards a
//! request. It proves one statement at a time, because one GPU runs one proof. A second request waits for the first.

use crate::error::{Error, Result};
use crate::logging::Logger;
use crate::prover::{native_job_from_guest_input, GuestJob, ProgramKind, Proof};
use crate::remote::{ProveRequestBody, ProveResponseBody};
use crate::timing::{millis, HostInfo, WorkerTimings};
use alloy_primitives::{hex, B256};
use std::io::Read as _;
use std::path::PathBuf;
use std::str::FromStr;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex, OnceLock};
use std::time::Instant;

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

    /// Like [`Self::prove_guest`], and tells how the time split inside the proving client. The default knows no split:
    /// the worker then counts the whole call as the proof.
    ///
    /// # Errors
    /// The errors of [`Self::prove_guest`].
    fn prove_guest_staged(
        &self,
        program_key: B256,
        job: &GuestJob,
    ) -> Result<(Proof, Option<ProveStages>)> {
        self.prove_guest(program_key, job)
            .map(|proof| (proof, None))
    }
}

/// How the time of one proof split inside the proving client.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct ProveStages {
    /// The SP1 Groth16 proof: core, compress and wrap in one call.
    pub prove_ms: u64,
    /// The client's verification of the new proof, and the checks after it.
    pub verify_ms: u64,
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

    fn prove_guest_staged(
        &self,
        program_key: B256,
        job: &GuestJob,
    ) -> Result<(Proof, Option<ProveStages>)> {
        Self::prove_guest_staged(self, program_key, job)
            .map(|(proof, stages)| (proof, Some(stages)))
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
    /// Set when the worker refused its host at the start (MIG slice, too little memory). It never resets.
    refusal: OnceLock<HostRefusal>,
    /// The host description for the timings, detected when the worker becomes ready.
    host: OnceLock<HostInfo>,
    logger: Logger,
}

impl Worker {
    /// A worker that is not ready yet: `/ping` answers 204 until [`Worker::set_ready`].
    pub fn new(logger: Logger) -> Self {
        Self {
            prover: OnceLock::new(),
            one_proof_at_a_time: Mutex::new(()),
            proving_client_failed: AtomicBool::new(false),
            refusal: OnceLock::new(),
            host: OnceLock::new(),
            logger,
        }
    }

    /// Marks the worker as one that refuses its host: `/ping` and `/prove` answer 503 from now on.
    pub fn refuse_host(&self, refusal: HostRefusal) {
        let _ = self.refusal.set(refusal);
    }

    /// Gives the worker its proving client. From now on `/ping` answers 200 and `/prove` proves.
    pub fn set_ready(&self, prover: Box<dyn GuestProver>) {
        // A second call keeps the first client. The binary calls this once.
        let _ = self.prover.set(prover);
        let _ = self.host.get_or_init(HostInfo::detect);
    }

    /// Answers one request.
    ///
    /// | Request | Answer |
    /// |---|---|
    /// | `GET /ping` | 204 while starting, 200 when ready, 503 after the proving client failed a proof or when the host was refused |
    /// | `POST /prove`, host refused | 503 |
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
        if let Some(refusal) = self.refusal.get() {
            return Answer::error(503, refusal.message());
        }
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
        let received = Instant::now();
        if let Some(refusal) = self.refusal.get() {
            return Answer::error(503, refusal.message());
        }
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
        let native_started = Instant::now();
        let job = match native_job_from_guest_input(request.statement_kind, guest_input) {
            Ok(job) => job,
            Err(Error::VerificationRefused(reason)) => {
                return Answer::error(422, format!("the program rejects the input: {reason}"))
            }
            Err(error) => return Answer::error(500, error),
        };
        let native_ms = millis(native_started.elapsed());
        let queue_started = Instant::now();
        let _turn = self
            .one_proof_at_a_time
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        let queue_ms = millis(queue_started.elapsed());
        let started = Instant::now();
        let (proof, stages) = match prover.prove_guest_staged(program_key, &job) {
            Ok(done) => done,
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
        let proving_ms = millis(started.elapsed());
        let (prove_ms, verify_ms) = stages.map_or((proving_ms, 0), |stages| {
            (stages.prove_ms, stages.verify_ms)
        });
        let host = self.host.get().cloned().unwrap_or_default();
        let timings = WorkerTimings {
            queue_ms,
            native_ms,
            prove_ms,
            verify_ms,
            total_ms: millis(received.elapsed()),
            gpu: host.gpu,
            cpu_model: host.cpu_model,
            cpu_count: host.cpu_count,
        };
        let response = ProveResponseBody {
            proof: hex::encode_prefixed(&proof.proof_bytes),
            public_values: hex::encode_prefixed(&proof.public_values),
            timings: serde_json::to_value(&timings).ok(),
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

/// The default floor for the host memory, in GiB. The CPU run of the Groth16 step peaked near 56 GiB, the RTX 4090 and
/// 5090 hosts had 128 GiB or more, and a MIG 1g.24gb slice had 28.87 GiB, which ended in an out-of-memory kill.
pub const DEFAULT_MIN_HOST_MEMORY_GIB: u64 = 48;

const GIB: u64 = 1024 * 1024 * 1024;

/// What the worker could read about its host at the start. Every part may be missing; a missing part never refuses.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct HostReadings {
    /// The GPU name from `nvidia-smi`.
    pub gpu_name: Option<String>,
    /// The device UUID. A MIG slice has one that starts with `MIG-`.
    pub gpu_uuid: Option<String>,
    /// `mig.mode.current` of the first GPU (`Enabled` or `Disabled`).
    pub mig_mode: Option<String>,
    /// The host memory available to the container in bytes: the smaller of the cgroup limit and `MemTotal`.
    pub host_memory_bytes: Option<u64>,
}

impl HostReadings {
    /// Asks the machine (`nvidia-smi`, cgroup files, `/proc/meminfo`).
    pub fn detect() -> Self {
        let (gpu_uuid, mig_mode) = crate::timing::query_gpu_mig();
        let read = |path: &str| std::fs::read_to_string(path).ok();
        let cgroup_limit = read("/sys/fs/cgroup/memory.max")
            .or_else(|| read("/sys/fs/cgroup/memory/memory.limit_in_bytes"))
            .and_then(|text| parse_cgroup_limit(&text));
        let total = read("/proc/meminfo").and_then(|text| parse_mem_total(&text));
        Self {
            gpu_name: HostInfo::detect().gpu,
            gpu_uuid,
            mig_mode,
            host_memory_bytes: match (cgroup_limit, total) {
                (Some(limit), Some(total)) => Some(limit.min(total)),
                (limit, total) => limit.or(total),
            },
        }
    }

    /// Whether the GPU is a MIG slice: "MIG" as a word in its name, a UUID that starts with `MIG-`, or MIG mode on.
    pub fn is_mig(&self) -> bool {
        let named = self.gpu_name.as_deref().is_some_and(|name| {
            name.split(|character: char| !character.is_ascii_alphanumeric())
                .any(|word| word.eq_ignore_ascii_case("mig"))
        });
        let uuid = self
            .gpu_uuid
            .as_deref()
            .is_some_and(|uuid| uuid.starts_with("MIG-"));
        let mode = self
            .mig_mode
            .as_deref()
            .is_some_and(|mode| mode.eq_ignore_ascii_case("enabled"));
        named || uuid || mode
    }

    /// The memory in GiB with two decimals for the log, or `unknown`.
    pub fn memory_text(&self) -> String {
        #[allow(clippy::cast_precision_loss)]
        self.host_memory_bytes.map_or_else(
            || "unknown".to_string(),
            |bytes| format!("{:.2}", bytes as f64 / GIB as f64),
        )
    }
}

/// Why a worker refuses its host.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum RefusalReason {
    /// The GPU is a MIG slice.
    Mig,
    /// The host memory is below the floor.
    HostMemory,
}

impl RefusalReason {
    /// The word in the log line.
    pub fn label(self) -> &'static str {
        match self {
            Self::Mig => "mig",
            Self::HostMemory => "host_memory",
        }
    }
}

/// The decision to refuse, with what the answers say.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct HostRefusal {
    /// Why.
    pub reason: RefusalReason,
    message: String,
}

impl HostRefusal {
    /// The text for the `error` field of a 503 answer.
    pub fn message(&self) -> &str {
        &self.message
    }
}

/// Decides whether the host is fit for a proof. `None` means go on. A MIG slice is refused first, then low memory.
/// A reading that is missing never refuses: a host without `nvidia-smi` or cgroup files is not known to be bad.
pub fn decide_host(readings: &HostReadings, min_host_memory_gib: u64) -> Option<HostRefusal> {
    let gpu = readings.gpu_name.as_deref().unwrap_or("unknown");
    if readings.is_mig() {
        return Some(HostRefusal {
            reason: RefusalReason::Mig,
            message: format!(
                "this worker runs on a MIG GPU slice ({gpu}); its host memory share is too small for the Groth16 step, so it refuses to prove"
            ),
        });
    }
    let bytes = readings.host_memory_bytes?;
    if min_host_memory_gib > 0 && bytes < min_host_memory_gib.saturating_mul(GIB) {
        return Some(HostRefusal {
            reason: RefusalReason::HostMemory,
            message: format!(
                "this worker has {} GiB of host memory, below the floor of {min_host_memory_gib} GiB, so it refuses to prove",
                readings.memory_text()
            ),
        });
    }
    None
}

/// The memory limit in a cgroup file: a number of bytes. `max` (cgroup v2) and values of 2^60 or more (cgroup v1
/// writes a huge number for "no limit") mean no limit, so `None`.
pub fn parse_cgroup_limit(text: &str) -> Option<u64> {
    let value: u64 = text.trim().parse().ok()?;
    (value < (1 << 60)).then_some(value)
}

/// `MemTotal` of `/proc/meminfo` in bytes.
pub fn parse_mem_total(text: &str) -> Option<u64> {
    let rest = text
        .lines()
        .find_map(|line| line.strip_prefix("MemTotal:"))?;
    let kib: u64 = rest.trim().trim_end_matches("kB").trim().parse().ok()?;
    kib.checked_mul(1024)
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
    /// The least host memory in GiB that the worker accepts (`ZK_BRIDGE_WORKER_MIN_HOST_MEMORY_GIB`, default
    /// [`DEFAULT_MIN_HOST_MEMORY_GIB`]). 0 switches the memory check off.
    pub min_host_memory_gib: u64,
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
            min_host_memory_gib: match lookup("ZK_BRIDGE_WORKER_MIN_HOST_MEMORY_GIB") {
                Some(text) => text.trim().parse().map_err(|_| {
                    Error::Config(
                        "ZK_BRIDGE_WORKER_MIN_HOST_MEMORY_GIB: expected a whole number of GiB"
                            .into(),
                    )
                })?,
                None => DEFAULT_MIN_HOST_MEMORY_GIB,
            },
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
    let readings = HostReadings::detect();
    if let Some(refusal) = decide_host(&readings, settings.min_host_memory_gib) {
        logger.error(
            "worker_refused",
            &[
                ("reason", refusal.reason.label().to_string()),
                (
                    "gpu",
                    format!("\"{}\"", readings.gpu_name.as_deref().unwrap_or("unknown")),
                ),
                ("host_memory_gib", readings.memory_text()),
            ],
        );
        worker.refuse_host(refusal);
        logger.info("worker_listening", &[("port", settings.port.to_string())]);
        serve(worker, &server);
        return Ok(());
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
        /// A proof from a client that reports how its time split.
        Staged,
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

        fn prove_guest_staged(
            &self,
            program_key: B256,
            job: &GuestJob,
        ) -> Result<(Proof, Option<ProveStages>)> {
            let proof = self.prove_guest(program_key, job)?;
            let stages = matches!(self.outcome, Outcome::Staged).then_some(ProveStages {
                prove_ms: 1234,
                verify_ms: 56,
            });
            Ok((proof, stages))
        }

        fn prove_guest(&self, _program_key: B256, job: &GuestJob) -> Result<Proof> {
            let now_running = self.running.fetch_add(1, Ordering::SeqCst) + 1;
            self.most_running.fetch_max(now_running, Ordering::SeqCst);
            std::thread::sleep(std::time::Duration::from_millis(30));
            self.running.fetch_sub(1, Ordering::SeqCst);
            match self.outcome {
                Outcome::Proof | Outcome::Staged => Ok(Proof {
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

    fn readings(name: &str, uuid: &str, mode: &str, gib: f64) -> HostReadings {
        let text = |value: &str| (!value.is_empty()).then(|| value.to_string());
        #[allow(clippy::cast_possible_truncation, clippy::cast_sign_loss)]
        HostReadings {
            gpu_name: text(name),
            gpu_uuid: text(uuid),
            mig_mode: text(mode),
            host_memory_bytes: Some((gib * GIB as f64) as u64),
        }
    }

    /// Claim: a MIG slice is refused by its name, its UUID or its MIG mode; low memory is refused; a whole GPU with
    /// enough memory and a host without readings are accepted.
    /// Why it matters: a MIG 1g.24gb slice (28.87 GiB) ran out of memory in the Groth16 step and the worker kept
    /// answering `/ping` with 200 while it failed every job.
    #[test]
    fn host_decision_follows_the_readings() {
        let by_name = readings(
            "NVIDIA RTX PRO 6000 Blackwell Server Edition MIG 1g.24gb",
            "",
            "",
            200.0,
        );
        assert_eq!(
            decide_host(&by_name, 48).map(|r| r.reason),
            Some(RefusalReason::Mig)
        );
        let by_uuid = readings("NVIDIA RTX PRO 6000", "MIG-1b2c3d4e", "[N/A]", 200.0);
        assert_eq!(
            decide_host(&by_uuid, 48).map(|r| r.reason),
            Some(RefusalReason::Mig)
        );
        let by_mode = readings("NVIDIA RTX PRO 6000", "GPU-abc", "Enabled", 200.0);
        assert_eq!(
            decide_host(&by_mode, 48).map(|r| r.reason),
            Some(RefusalReason::Mig)
        );
        let low = readings("NVIDIA GeForce RTX 4090", "GPU-abc", "Disabled", 28.87);
        let refusal = decide_host(&low, 48).expect("refused");
        assert_eq!(refusal.reason, RefusalReason::HostMemory);
        assert!(refusal.message().contains("28.87"));
        let good = readings("NVIDIA GeForce RTX 4090", "GPU-abc", "Disabled", 128.0);
        assert_eq!(decide_host(&good, 48), None);
        assert_eq!(decide_host(&low, 0), None, "floor 0 switches the check off");
        assert_eq!(decide_host(&low, 16), None, "the floor is configurable");
        assert_eq!(decide_host(&HostReadings::default(), 48), None);
        let gigabyte = readings("NVIDIA GeForce RTX 4090", "", "", 128.0);
        assert!(!gigabyte.is_mig(), "no word MIG in the name");
        let migraine = readings("Acme MIGHTY 9000", "", "", 128.0);
        assert!(!migraine.is_mig(), "MIG must be a whole word");
    }

    /// Claim: the memory files are read as the container sees them.
    #[test]
    fn memory_readings_are_parsed() {
        assert_eq!(parse_cgroup_limit("max\n"), None);
        assert_eq!(parse_cgroup_limit("9223372036854771712\n"), None);
        assert_eq!(parse_cgroup_limit("31002828800\n"), Some(31_002_828_800));
        assert_eq!(
            parse_mem_total("MemTotal:       32768 kB\nMemFree: 1 kB\n"),
            Some(32_768 * 1024)
        );
        assert_eq!(parse_mem_total("nothing"), None);
        assert_eq!(
            crate::timing::parse_gpu_uuid_and_mig("MIG-abc-123, [N/A]\n"),
            (Some("MIG-abc-123".into()), None)
        );
        assert_eq!(
            crate::timing::parse_gpu_uuid_and_mig("GPU-abc, Disabled\n"),
            (Some("GPU-abc".into()), Some("Disabled".into()))
        );
    }

    /// Claim: a worker that refused its host answers 503 on `/ping` and on `/prove`, with a JSON error, even when a
    /// proving client is set, and the log line carries no secret.
    /// Why it matters: RunPod removes a worker that answers `/ping` with anything but 200 or 204, and the client
    /// retries a 503 on another worker.
    #[test]
    fn a_refused_worker_answers_503() {
        let (logger, _lines) = Logger::in_memory();
        let worker = Worker::new(logger);
        let refusal = decide_host(
            &readings("NVIDIA A MIG 1g.24gb", "MIG-x", "Enabled", 28.0),
            48,
        )
        .expect("refused");
        worker.refuse_host(refusal);
        worker.set_ready(Box::new(Arc::new(StubProver::new(Outcome::Proof))));
        let ping = worker.handle("GET", "/ping", b"");
        assert_eq!(ping.status, 503);
        assert!(error_of(&ping).contains("MIG"));
        let input = light_client_input(400);
        let prove = worker.handle(
            "POST",
            "/prove",
            &request_body(LIGHT_CLIENT_KEY, "lightClient", &input),
        );
        assert_eq!(prove.status, 503);
        assert!(error_of(&prove).contains("refuses to prove"));
        assert_eq!(worker.handle("GET", "/ping", b"").status, 503);
    }

    /// Claim: the memory floor comes from the environment, and a bad value is an error.
    #[test]
    fn the_memory_floor_is_a_setting() {
        let with = |floor: Option<&'static str>| {
            WorkerSettings::from_lookup(&move |name: &str| match name {
                "ZK_BRIDGE_WORKER_LIGHT_CLIENT_ELF" | "ZK_BRIDGE_WORKER_OBSERVATION_ELF" => {
                    Some("/x.elf".to_string())
                }
                "ZK_BRIDGE_WORKER_MIN_HOST_MEMORY_GIB" => floor.map(str::to_string),
                _ => None,
            })
        };
        assert_eq!(with(None).unwrap().min_host_memory_gib, 48);
        assert_eq!(with(Some("64")).unwrap().min_host_memory_gib, 64);
        assert!(with(Some("lots")).is_err());
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

    /// Claim: the answer carries the worker's timings: the wait for the GPU, the native run, the proof (the whole call,
    /// for a client that reports no split) and the total, which is at least the proof. A client that reports a split
    /// gives its own numbers.
    /// Why it matters: the producer logs these numbers to tell a wait for a GPU from the proof itself.
    #[test]
    fn the_answer_carries_the_timings() {
        let (worker, _) = ready_worker(Outcome::Proof);
        let input = light_client_input(400);
        let answer = worker.handle(
            "POST",
            "/prove",
            &request_body(LIGHT_CLIENT_KEY, "lightClient", &input),
        );
        let body: ProveResponseBody = serde_json::from_slice(&answer.body).unwrap();
        let timings = WorkerTimings::from_value(&body.timings.expect("timings")).expect("fit");
        assert!(timings.prove_ms >= 30, "the stub sleeps 30 ms: {timings:?}");
        assert_eq!(timings.verify_ms, 0);
        assert!(timings.total_ms >= timings.prove_ms + timings.native_ms);
        assert!(timings.cpu_count.is_some());
        let raw: serde_json::Value = serde_json::from_slice(&answer.body).unwrap();
        assert!(raw["timings"]["totalMs"].is_u64(), "camelCase keys: {raw}");

        let (staged, _) = ready_worker(Outcome::Staged);
        let answer = staged.handle(
            "POST",
            "/prove",
            &request_body(LIGHT_CLIENT_KEY, "lightClient", &input),
        );
        let body: ProveResponseBody = serde_json::from_slice(&answer.body).unwrap();
        let timings = WorkerTimings::from_value(&body.timings.unwrap()).unwrap();
        assert_eq!((timings.prove_ms, timings.verify_ms), (1234, 56));
    }

    /// Claim: a second request that waits for the first shows its wait as `queueMs`.
    /// Why it matters: the wait for a GPU must not be counted as proving.
    #[test]
    fn a_waiting_request_reports_its_queue_time() {
        let (worker, _) = ready_worker(Outcome::Proof);
        let worker = Arc::new(worker);
        let input = light_client_input(400);
        let bodies: Vec<Vec<u8>> = (0..2)
            .map(|_| request_body(LIGHT_CLIENT_KEY, "lightClient", &input))
            .collect();
        let handles: Vec<_> = bodies
            .into_iter()
            .map(|body| {
                let worker = Arc::clone(&worker);
                std::thread::spawn(move || worker.handle("POST", "/prove", &body))
            })
            .collect();
        let mut queues: Vec<u64> = handles
            .into_iter()
            .map(|handle| {
                let answer = handle.join().unwrap();
                let body: ProveResponseBody = serde_json::from_slice(&answer.body).unwrap();
                WorkerTimings::from_value(&body.timings.unwrap())
                    .unwrap()
                    .queue_ms
            })
            .collect();
        queues.sort_unstable();
        assert!(queues[0] < 20, "the first request did not wait: {queues:?}");
        assert!(
            queues[1] >= 20,
            "the second waited for the first: {queues:?}"
        );
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
