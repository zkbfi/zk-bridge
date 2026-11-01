//! The remote proving backend: it sends a proof job to a worker over HTTP and checks what comes back.
//!
//! [`RemoteProver`] needs no `sp1-sdk` and no GPU. It runs the program natively first, as every backend does, so a bad
//! statement never leaves the machine. Then it posts the guest input to the worker (`src/worker.rs`, for example a
//! RunPod Serverless endpoint) and accepts the answer only when all of these hold:
//!
//! 1. The public values equal the public values of the native run of `lc-core`.
//! 2. The proof has the length and the selector of the pinned verifier (`0x4388a21c`, `docs/sp1-version-policy.md`).
//! 3. The Groth16 proof verifies for the program key that the caller asked for. The crate `sp1-verifier` 6.8.1 does
//!    this on the CPU in a few milliseconds. This check also fixes the program key: a proof of another program does
//!    not verify under the key that the contract stores.
//!
//! The chain stays the final check: the verifier contract refuses any proof that fails. The local checks save a
//! transaction and a retry cycle when a worker is wrong or hostile.
//!
//! The backend can hold several endpoints in priority order (`prover.remote_endpoints`), for example a dedicated worker
//! first and a RunPod Serverless endpoint as the fallback. It tries one endpoint at a time and moves on only when an
//! endpoint is unreachable, stays not ready past its own wait, or runs out of attempts. A refusal of the job, a 200 that
//! is not a proof, and a proof that fails the checks above end the job: no other endpoint proves it again. The logs name
//! an endpoint by its position and label, never by its URL.
//!
//! An API key comes from an environment variable that the configuration names. It never appears in a file, in a log
//! line or in an error text. An endpoint without a key (a worker reached directly) gets no `Authorization` header.

use crate::config::{
    is_http_url, is_permitted_secret_url, require_environment_name, ProverConfig,
    MAX_REMOTE_ENDPOINTS,
};
use crate::error::{Error, Result};
use crate::logging::Logger;
use crate::prover::{
    native_job, require_groth16_shape, require_native_values, GuestJob, ProgramKind, Proof,
    ProofStatement, Prover,
};
use crate::rpc::{build_agent, USER_AGENT};
use crate::timing::{
    millis, prover_step_lines, worker_fields, ProverTimings, RemoteTimings, WorkerTimings,
};
use alloy_primitives::{hex, B256};
use serde::{Deserialize, Serialize};
use std::sync::Mutex;
use std::time::{Duration, Instant};

/// The largest answer that the client reads. A proof is 356 bytes, so this only bounds a hostile worker.
const MAX_ANSWER_BYTES: u64 = 1024 * 1024;

/// The longest single wait between two requests to a worker that is not ready yet.
const MAX_COLD_START_STEP: Duration = Duration::from_secs(60);

/// The `detail` of the RunPod load balancer's 400 when no worker became ready within its own wait for one request.
const RUNPOD_NO_READY_WORKER: &str = "timed out waiting for worker";

/// The body of `POST /prove`.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ProveRequestBody {
    /// The program key that the caller wants a proof for, as `0x` and 64 hex digits.
    pub program_key: String,
    /// Which program runs: `lightClient` or `forkObservation`.
    pub statement_kind: ProgramKind,
    /// The bytes that the guest reads, as `0x` hex.
    pub guest_input: String,
}

/// The body of a successful answer to `POST /prove`.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ProveResponseBody {
    /// The proof bytes that the verifier contract reads, as `0x` hex.
    pub proof: String,
    /// The public values that the proof commits to, as `0x` hex.
    pub public_values: String,
    /// What the worker measured (`crate::timing::WorkerTimings`). Optional: an older worker leaves it out, and the
    /// producer then logs that the worker sent no timings. It is a plain JSON value here so that a field the producer
    /// does not understand never fails a proof.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub timings: Option<serde_json::Value>,
}

/// How the remote backend reaches one endpoint.
#[derive(Clone)]
pub struct RemoteSettings {
    /// The name of the endpoint in the logs (`dedicated`, `serverless`; `remote` for the single `prover.remote_url`).
    pub label: String,
    /// The base URL of the endpoint, without the path.
    pub endpoint_url: String,
    /// The API key that goes in the `Authorization` header. Read from the environment, never from a file. `None` for a
    /// worker that is reached directly and checks no key: then the request carries no `Authorization` header.
    pub api_key: Option<String>,
    /// The time one request may take, from the first byte sent to the last byte read. For a serverless endpoint it
    /// must cover a cold start and a proof.
    pub timeout: Duration,
    /// How often a job is sent before the backend gives up on this endpoint after ordinary failures (no answer, a
    /// server error, a rate limit). At least 1. Answers of a worker that is not ready yet do not count;
    /// `cold_start_wait` bounds them.
    pub attempts: u32,
    /// The wait before the second attempt. The wait before attempt `n + 1` is `n` times this value.
    pub retry_delay: Duration,
    /// The longest time the backend waits for a worker of this endpoint that is not ready yet, counted from the first
    /// request to it. No new request starts after it. Zero turns the wait off: the first such answer ends the
    /// endpoint.
    pub cold_start_wait: Duration,
}

impl std::fmt::Debug for RemoteSettings {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter
            .debug_struct("RemoteSettings")
            .field("label", &self.label)
            .field("endpoint_url", &self.endpoint_url)
            .field("api_key", &self.api_key.as_ref().map(|_| "<hidden>"))
            .field("timeout", &self.timeout)
            .field("attempts", &self.attempts)
            .field("retry_delay", &self.retry_delay)
            .field("cold_start_wait", &self.cold_start_wait)
            .finish()
    }
}

/// What one attempt gave: an answer to use, or a failure with a verdict on whether another attempt can help.
enum Attempt {
    Done(ProveResponseBody),
    /// No worker took the job: the endpoint is cold or the worker still starts. No proof ran, so sending again cannot
    /// run a paid proof twice.
    NotReady(String),
    Retry(String),
    /// The endpoint itself turned the request away (a key it does not take, a path it does not serve). Sending the
    /// same request to it again cannot help, but another endpoint can.
    Unusable(String),
    /// The worker refused the job itself (an input it rejects) or answered 200 with something that is not a proof.
    /// No endpoint can do better with the same job.
    Refuse(Error),
}

/// How the work on one endpoint ended.
enum EndpointResult {
    Proof {
        answer: ProveResponseBody,
        /// When the accepted request started.
        accepted_at: Instant,
    },
    /// The endpoint gave no proof, and another endpoint may: it was unreachable, not ready past its wait, out of
    /// attempts, or it turned the request away.
    Failed(Error),
    /// A refusal that ends the job: no other endpoint is asked.
    Final(Error),
}

/// The counters that add up over every endpoint of one job.
#[derive(Default)]
struct Counters {
    not_ready: u32,
    retries: u32,
}

/// One endpoint with the HTTP agent that carries its timeout.
struct Endpoint {
    settings: RemoteSettings,
    agent: ureq::Agent,
}

/// The remote proving backend. See the module documentation.
pub struct RemoteProver {
    endpoints: Vec<Endpoint>,
    logger: Logger,
    /// The timings of the last `prove`, for `Prover::take_timings`.
    last_timings: Mutex<Option<ProverTimings>>,
}

impl RemoteProver {
    /// A backend for one endpoint. It sends nothing until the first proof.
    pub fn new(settings: RemoteSettings, logger: Logger) -> Self {
        Self::with_endpoints(vec![settings], logger)
    }

    /// A backend for endpoints in priority order. It sends nothing until the first proof. The list must not be empty
    /// (`validate_remote_config` makes sure of it for a configuration file).
    pub fn with_endpoints(endpoints: Vec<RemoteSettings>, logger: Logger) -> Self {
        let endpoints = endpoints
            .into_iter()
            .map(|settings| Endpoint {
                agent: build_agent(settings.timeout, USER_AGENT),
                settings,
            })
            .collect();
        Self {
            endpoints,
            logger,
            last_timings: Mutex::new(None),
        }
    }

    /// The settings of each endpoint, in the order they are tried.
    pub fn endpoint_settings(&self) -> Vec<&RemoteSettings> {
        self.endpoints
            .iter()
            .map(|endpoint| &endpoint.settings)
            .collect()
    }

    /// Builds the backend from the `[prover]` section: the list `remote_endpoints`, or the single `remote_url` as a
    /// list of one endpoint labelled `remote`. Each API key comes from the environment variable that the section
    /// names, read through `lookup`.
    ///
    /// # Errors
    /// `Error::Config` when a key of the section is missing or a named variable is not set.
    pub fn from_config(
        config: &ProverConfig,
        lookup: &dyn Fn(&str) -> Option<String>,
        logger: Logger,
    ) -> Result<Self> {
        Ok(Self::with_endpoints(
            remote_settings(config, lookup)?,
            logger,
        ))
    }

    /// Sends the job to the endpoints in order until one gives an answer or a refusal ends the job. See
    /// [`Self::request_proof_timed`].
    ///
    /// The caller is `Prover::prove`. It is public so that the tests drive the transport with a fake worker.
    ///
    /// # Errors
    /// `Error::Prover` when a worker refuses the job, or when no endpoint gave an answer. `Error::Malformed` when a 200
    /// answer is not a proof.
    pub fn request_proof(&self, request_body: &str) -> Result<ProveResponseBody> {
        self.request_proof_timed(request_body)
            .map(|(answer, _)| answer)
    }

    /// Like [`Self::request_proof`], and tells how long the job waited for a worker, how long the accepted request
    /// took, which endpoint answered and how many were given up before it. The worker's own timings, when its answer
    /// carries them, are in the result too.
    ///
    /// Per endpoint: a worker that is not ready yet is awaited with a growing pause until that endpoint's
    /// `cold_start_wait` has passed since its first request. Other failures are retried until its `attempts` requests
    /// have failed. Then the next endpoint gets the job. A refusal of the job (a 400 or 422 of the worker) or a 200
    /// that is not a proof ends the job at once: no other endpoint is asked. The job never goes to two endpoints at
    /// the same time.
    ///
    /// # Errors
    /// The errors of [`Self::request_proof`].
    pub fn request_proof_timed(
        &self,
        request_body: &str,
    ) -> Result<(ProveResponseBody, RemoteTimings)> {
        let started = Instant::now();
        let mut counters = Counters::default();
        let mut failures: Vec<String> = Vec::new();
        let count = self.endpoints.len();
        for (index, endpoint) in self.endpoints.iter().enumerate() {
            let position = index + 1;
            let label = &endpoint.settings.label;
            match self.try_endpoint(position, endpoint, request_body, &mut counters) {
                EndpointResult::Proof {
                    answer,
                    accepted_at,
                } => {
                    let timings = RemoteTimings {
                        wait_worker_ms: millis(accepted_at.duration_since(started)),
                        not_ready_count: counters.not_ready,
                        retry_count: counters.retries,
                        endpoint: label.clone(),
                        failover_count: u32::try_from(index).unwrap_or(u32::MAX),
                        remote_ms: millis(accepted_at.elapsed()),
                        worker: answer.timings.as_ref().and_then(WorkerTimings::from_value),
                    };
                    return Ok((answer, timings));
                }
                EndpointResult::Final(error) => {
                    self.logger.error(
                        "remote_job_refused",
                        &[
                            ("endpoint_index", position.to_string()),
                            ("endpoint", label.clone()),
                            ("reason", error.to_string()),
                        ],
                    );
                    return Err(error);
                }
                EndpointResult::Failed(error) => {
                    if count == 1 {
                        return Err(error);
                    }
                    let reason = error.to_string();
                    if let Some(next) = self.endpoints.get(position) {
                        self.logger.warn(
                            "remote_endpoint_failover",
                            &[
                                ("endpoint_index", position.to_string()),
                                ("endpoint", label.clone()),
                                ("next_endpoint_index", (position + 1).to_string()),
                                ("next_endpoint", next.settings.label.clone()),
                                ("reason", reason.clone()),
                            ],
                        );
                    }
                    failures.push(format!("endpoint {position} ({label}): {reason}"));
                }
            }
        }
        self.logger.error(
            "remote_endpoints_exhausted",
            &[("endpoint_count", count.to_string())],
        );
        Err(Error::Prover(format!(
            "no remote endpoint gave a proof ({count} tried); {}",
            failures.join("; ")
        )))
    }

    /// Works on one endpoint until it gives an answer, a refusal, or no more hope.
    fn try_endpoint(
        &self,
        position: usize,
        endpoint: &Endpoint,
        request_body: &str,
        counters: &mut Counters,
    ) -> EndpointResult {
        let settings = &endpoint.settings;
        let started = Instant::now();
        let mut failures = 0;
        let mut not_ready = 0;
        let place = || {
            [
                ("endpoint_index", position.to_string()),
                ("endpoint", settings.label.clone()),
            ]
        };
        loop {
            let attempt_started = Instant::now();
            match send_once(endpoint, request_body) {
                Attempt::Done(answer) => {
                    return EndpointResult::Proof {
                        answer,
                        accepted_at: attempt_started,
                    }
                }
                Attempt::Refuse(error) => return EndpointResult::Final(error),
                Attempt::Unusable(reason) => {
                    return EndpointResult::Failed(Error::Prover(format!(
                        "the remote worker refused the job: {reason}"
                    )))
                }
                Attempt::NotReady(reason) => {
                    not_ready += 1;
                    counters.not_ready += 1;
                    let waited = started.elapsed();
                    let limit = settings.cold_start_wait;
                    let remaining = limit.saturating_sub(waited);
                    if remaining.is_zero() {
                        return EndpointResult::Failed(Error::Prover(format!(
                            "the remote worker was not ready after {} s of waiting, the limit of the endpoint's wait ({} s, prover.remote_cold_start_wait_seconds or its ready_wait_seconds); last answer: {reason}",
                            waited.as_secs(),
                            limit.as_secs()
                        )));
                    }
                    let wait = cold_start_step(settings.retry_delay, not_ready).min(remaining);
                    let mut fields = place().to_vec();
                    fields.extend([
                        ("waited_seconds", waited.as_secs().to_string()),
                        ("wait_seconds", wait.as_secs().to_string()),
                        ("limit_seconds", limit.as_secs().to_string()),
                        ("reason", reason),
                    ]);
                    self.logger.warn("remote_worker_not_ready", &fields);
                    std::thread::sleep(wait);
                }
                Attempt::Retry(reason) => {
                    failures += 1;
                    if failures >= settings.attempts {
                        return EndpointResult::Failed(Error::Prover(format!(
                            "the remote worker gave no proof after {} attempts; last reason: {reason}",
                            settings.attempts
                        )));
                    }
                    counters.retries += 1;
                    let wait = settings.retry_delay * failures;
                    let mut fields = place().to_vec();
                    fields.extend([
                        ("attempt", failures.to_string()),
                        ("wait_seconds", wait.as_secs().to_string()),
                        ("reason", reason),
                    ]);
                    self.logger.warn("remote_prove_retry", &fields);
                    std::thread::sleep(wait);
                }
            }
        }
    }
}

/// Sends one request to one endpoint and sorts the answer.
fn send_once(endpoint: &Endpoint, request_body: &str) -> Attempt {
    let settings = &endpoint.settings;
    let url = format!("{}/prove", settings.endpoint_url.trim_end_matches('/'));
    let mut request = endpoint
        .agent
        .post(&url)
        .header("Content-Type", "application/json");
    if let Some(key) = &settings.api_key {
        request = request.header("Authorization", &format!("Bearer {key}"));
    }
    let scrub = |text: String| scrub_endpoint(&text, &settings.endpoint_url);
    let mut response = match request.send(request_body) {
        Ok(response) => response,
        Err(error) => return Attempt::Retry(scrub(format!("no answer: {error}"))),
    };
    let status = response.status().as_u16();
    let text = match response
        .body_mut()
        .with_config()
        .limit(MAX_ANSWER_BYTES)
        .read_to_string()
    {
        Ok(text) => text,
        Err(error) => {
            return Attempt::Retry(scrub(format!(
                "status {status}: cannot read the answer: {error}"
            )))
        }
    };
    if status == 200 {
        return match serde_json::from_str(&text) {
            Ok(answer) => Attempt::Done(answer),
            Err(error) => Attempt::Refuse(Error::Malformed(format!(
                "the worker answered 200 with a body that is not a proof: {error}"
            ))),
        };
    }
    let reason = scrub(format!("status {status}: {}", error_text(&text)));
    if is_not_ready(status, &text) {
        return Attempt::NotReady(reason);
    }
    if is_retryable(status) {
        return Attempt::Retry(reason);
    }
    if is_endpoint_refusal(status) {
        return Attempt::Unusable(reason);
    }
    Attempt::Refuse(Error::Prover(format!(
        "the remote worker refused the job: {reason}"
    )))
}

/// Removes the endpoint's URL and its host from a reason, so that a log line or an error names the endpoint only by
/// its label. The logger removes the path of any URL too; this also catches a bare `host:port` in an error text.
fn scrub_endpoint(text: &str, endpoint_url: &str) -> String {
    let trimmed = endpoint_url.trim_end_matches('/');
    let authority = trimmed
        .split_once("://")
        .map_or(trimmed, |(_, rest)| rest)
        .split(['/', '?', '#'])
        .next()
        .unwrap_or_default();
    let host = authority.rsplit('@').next().unwrap_or_default();
    let mut scrubbed = text.to_string();
    for piece in [trimmed, authority, host] {
        if !piece.is_empty() {
            scrubbed = scrubbed.replace(piece, "<endpoint>");
        }
    }
    scrubbed
}

/// The settings of each endpoint of a `[prover]` section, in priority order. See [`RemoteProver::from_config`].
///
/// # Errors
/// `Error::Config` when the section names no endpoint or a named variable is not set.
pub fn remote_settings(
    config: &ProverConfig,
    lookup: &dyn Fn(&str) -> Option<String>,
) -> Result<Vec<RemoteSettings>> {
    let retry_delay = Duration::from_secs(config.remote_retry_delay_seconds);
    let read_key = |variable: &str, key: &str| -> Result<String> {
        lookup(variable)
            .map(|value| value.trim().to_string())
            .filter(|value| !value.is_empty())
            .ok_or_else(|| {
                Error::Config(format!(
                    "the environment variable {variable} ({key}) is not set"
                ))
            })
    };
    if config.remote_endpoints.is_empty() {
        let endpoint_url = config.remote_url.clone().ok_or_else(|| {
            Error::Config("prover.remote_url is required for the remote backend".into())
        })?;
        let variable = config.remote_api_key_env.as_deref().ok_or_else(|| {
            Error::Config("prover.remote_api_key_env is required for the remote backend".into())
        })?;
        return Ok(vec![RemoteSettings {
            label: SINGLE_ENDPOINT_LABEL.into(),
            endpoint_url,
            api_key: Some(read_key(variable, "prover.remote_api_key_env")?),
            timeout: Duration::from_secs(config.remote_timeout_seconds),
            attempts: config.remote_attempts,
            retry_delay,
            cold_start_wait: Duration::from_secs(config.remote_cold_start_wait_seconds),
        }]);
    }
    config
        .remote_endpoints
        .iter()
        .enumerate()
        .map(|(index, entry)| {
            let api_key = entry
                .api_key_env
                .as_deref()
                .map(|variable| {
                    read_key(
                        variable,
                        &format!("prover.remote_endpoints[{index}].api_key_env"),
                    )
                })
                .transpose()?;
            Ok(RemoteSettings {
                label: entry.label.clone(),
                endpoint_url: entry.url.clone(),
                api_key,
                timeout: Duration::from_secs(
                    entry
                        .timeout_seconds
                        .unwrap_or(config.remote_timeout_seconds),
                ),
                attempts: entry.attempts.unwrap_or(config.remote_attempts),
                retry_delay,
                cold_start_wait: Duration::from_secs(
                    entry
                        .ready_wait_seconds
                        .unwrap_or(config.remote_cold_start_wait_seconds),
                ),
            })
        })
        .collect()
}

/// The label of the single endpoint of `prover.remote_url`.
pub const SINGLE_ENDPOINT_LABEL: &str = "remote";

/// The `error` field of a worker answer, the `detail` field of a RunPod answer, or the first part of the text. A cap
/// keeps a hostile body out of the logs.
fn error_text(text: &str) -> String {
    let message = serde_json::from_str::<serde_json::Value>(text)
        .ok()
        .and_then(|value| {
            value["error"]
                .as_str()
                .or_else(|| value["detail"].as_str())
                .map(str::to_string)
        })
        .unwrap_or_else(|| text.to_string());
    message.chars().take(300).collect()
}

/// Whether the answer says that no worker took the job yet, so that no proof ran:
///
/// - 400 with the RunPod `detail` "timed out waiting for worker": the load balancer held the request for its own
///   wait and no worker became ready (seen after about 5 minutes while the hosts pulled the image).
/// - 503: the worker is still starting (`/prove` before the SP1 setup ends), or the proxy has no healthy worker.
/// - 204: the start answer of `/ping`, passed on by the proxy.
/// - The text "no workers available", with any status.
///
/// Only the `detail` field of the RunPod body counts, so a 400 of the worker (whose text is in `error`) stays final.
fn is_not_ready(status: u16, text: &str) -> bool {
    let runpod_detail = || {
        serde_json::from_str::<serde_json::Value>(text)
            .ok()
            .and_then(|value| value["detail"].as_str().map(str::to_string))
            .is_some_and(|detail| detail.trim().eq_ignore_ascii_case(RUNPOD_NO_READY_WORKER))
    };
    status == 503
        || status == 204
        || text.contains("no workers available")
        || (status == 400 && runpod_detail())
}

/// Whether another attempt can help after an ordinary failure: a server error or a rate limit. A 4xx from the worker
/// (a bad request, a key it does not hold, an input that the program rejects) is final.
fn is_retryable(status: u16) -> bool {
    status == 429 || status >= 500
}

/// Whether the endpoint itself turned the request away, before any worker looked at the job: 401 and 403 (a key it
/// does not take), 404 and 405 (a path or method it does not serve: a wrong URL). Another endpoint can still prove the
/// job. The worker (`src/worker.rs`) answers 404 and 405 only for a wrong path or method and never answers 401 or 403,
/// so none of them stands for a refusal of the input.
fn is_endpoint_refusal(status: u16) -> bool {
    matches!(status, 401 | 403 | 404 | 405)
}

/// The pause before request `n + 1` to a worker that is not ready: `retry_delay` doubled for each earlier pause, at
/// most a minute.
fn cold_start_step(retry_delay: Duration, n: u32) -> Duration {
    retry_delay
        .saturating_mul(1 << n.saturating_sub(1).min(16))
        .min(MAX_COLD_START_STEP)
}

/// Checks the answer of a worker against the job. Nothing here trusts the worker.
///
/// # Errors
/// `Error::Malformed` when a field is not hex. `Error::Prover` when the public values differ from the native run,
/// the proof has another length or selector, or the Groth16 proof does not verify for `program_vkey`.
pub fn accept_answer(
    program_vkey: B256,
    job: &GuestJob,
    answer: &ProveResponseBody,
) -> Result<Proof> {
    let public_values = hex::decode(&answer.public_values)
        .map_err(|error| Error::Malformed(format!("publicValues is not hex: {error}")))?;
    let proof_bytes = hex::decode(&answer.proof)
        .map_err(|error| Error::Malformed(format!("proof is not hex: {error}")))?;
    require_native_values(&public_values, &job.expected_values)?;
    require_groth16_shape(&proof_bytes)?;
    verify_groth16(program_vkey, &public_values, &proof_bytes)?;
    Ok(Proof {
        public_values,
        proof_bytes,
    })
}

/// Verifies an SP1 Groth16 proof of the pinned circuit with the crate `sp1-verifier`. The check fixes the program key
/// and the public values: both are inputs of the proof.
///
/// # Errors
/// `Error::Prover` when the proof does not verify.
pub fn verify_groth16(program_vkey: B256, public_values: &[u8], proof_bytes: &[u8]) -> Result<()> {
    sp1_verifier::Groth16Verifier::verify(
        proof_bytes,
        public_values,
        &format!("{program_vkey:#x}"),
        &sp1_verifier::GROTH16_VK_BYTES,
    )
    .map_err(|error| {
        Error::Prover(format!(
            "the Groth16 proof does not verify for program key {program_vkey:#x}: {error}"
        ))
    })
}

impl Prover for RemoteProver {
    fn name(&self) -> &'static str {
        "remote"
    }

    fn prove(&self, program_vkey: B256, statement: &ProofStatement) -> Result<Proof> {
        // The native run comes first: it refuses a bad statement before anything is sent.
        let native_started = Instant::now();
        let job = native_job(statement)?;
        let native_ms = millis(native_started.elapsed());
        let request = ProveRequestBody {
            program_key: format!("{program_vkey:#x}"),
            statement_kind: job.kind,
            guest_input: hex::encode_prefixed(&job.guest_input),
        };
        let body = serde_json::to_string(&request)
            .map_err(|error| Error::Prover(format!("cannot encode the request: {error}")))?;
        let (answer, remote) = self.request_proof_timed(&body)?;
        let verify_started = Instant::now();
        // A worker that returned a bad proof is an error of that worker. The job is not sent to another endpoint: a
        // proof that fails here points at a broken or hostile worker, and the operator must see it, not a silent
        // second proof.
        let proof = accept_answer(program_vkey, &job, &answer).inspect_err(|error| {
            self.logger.error(
                "remote_proof_refused",
                &[
                    ("endpoint", remote.endpoint.clone()),
                    ("failover_count", remote.failover_count.to_string()),
                    ("reason", error.to_string()),
                ],
            );
        })?;
        let timings = ProverTimings {
            native_ms,
            verify_ms: millis(verify_started.elapsed()),
            remote: Some(remote),
        };
        self.log_steps(&timings);
        *self
            .last_timings
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner) = Some(timings);
        Ok(proof)
    }

    fn take_timings(&self) -> Option<ProverTimings> {
        self.last_timings
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .take()
    }
}

impl RemoteProver {
    /// Writes one `prove_step` line per step of the backend, and one for the worker's own numbers (or the note that the
    /// worker sent none).
    pub fn log_steps(&self, timings: &ProverTimings) {
        for (step, mut fields) in prover_step_lines(timings) {
            fields.insert(0, ("step", step.to_string()));
            self.logger.info("prove_step", &fields);
        }
        if let Some(remote) = &timings.remote {
            let mut fields = vec![("step", "worker".to_string())];
            fields.extend(worker_fields(remote));
            self.logger.info("prove_step", &fields);
        }
    }
}

/// Checks the remote keys of a `[prover]` section: the single `remote_url` with its key variable, or the list
/// `remote_endpoints`. The section holds URLs and the names of variables, never a key.
///
/// # Errors
/// `Error::Config` naming the key.
pub fn validate_remote_config(config: &ProverConfig) -> Result<()> {
    if config.remote_attempts == 0 {
        return Err(Error::Config(
            "prover.remote_attempts must be at least 1".into(),
        ));
    }
    if config.remote_timeout_seconds == 0 {
        return Err(Error::Config(
            "prover.remote_timeout_seconds must be at least 1".into(),
        ));
    }
    if !config.remote_endpoints.is_empty() {
        return validate_endpoint_list(config);
    }
    let url = config.remote_url.as_deref().ok_or_else(|| {
        Error::Config(
            "prover.remote_url or prover.remote_endpoints is required for the remote backend"
                .into(),
        )
    })?;
    if !is_permitted_secret_url(url) {
        return Err(Error::Config(
            "prover.remote_url must start with https:// (http:// only for the local machine): the API key travels in the request".into(),
        ));
    }
    let variable = config.remote_api_key_env.as_deref().ok_or_else(|| {
        Error::Config("prover.remote_api_key_env is required for the remote backend".into())
    })?;
    require_environment_name(variable, "prover.remote_api_key_env")
}

/// Whether a label is short, lower case and safe in a log line.
fn is_label(text: &str) -> bool {
    (1..=32).contains(&text.len())
        && text.starts_with(|character: char| {
            character.is_ascii_lowercase() || character.is_ascii_digit()
        })
        && text.chars().all(|character| {
            character.is_ascii_lowercase()
                || character.is_ascii_digit()
                || character == '-'
                || character == '_'
        })
}

fn validate_endpoint_list(config: &ProverConfig) -> Result<()> {
    if config.remote_url.is_some() || config.remote_api_key_env.is_some() {
        return Err(Error::Config(
            "use prover.remote_endpoints or prover.remote_url with prover.remote_api_key_env, not both".into(),
        ));
    }
    if config.remote_endpoints.len() > MAX_REMOTE_ENDPOINTS {
        return Err(Error::Config(format!(
            "prover.remote_endpoints may list at most {MAX_REMOTE_ENDPOINTS} endpoints"
        )));
    }
    let mut labels = std::collections::BTreeSet::new();
    for (index, entry) in config.remote_endpoints.iter().enumerate() {
        let key = |name: &str| format!("prover.remote_endpoints[{index}].{name}");
        if !is_label(&entry.label) {
            return Err(Error::Config(format!(
                "{} must be 1 to 32 lower case letters, digits, '-' or '_', starting with a letter or a digit",
                key("label")
            )));
        }
        if !labels.insert(entry.label.as_str()) {
            return Err(Error::Config(format!(
                "{}: the label {} is used twice",
                key("label"),
                entry.label
            )));
        }
        match entry.api_key_env.as_deref() {
            Some(variable) => {
                require_environment_name(variable, &key("api_key_env"))?;
                if !is_permitted_secret_url(&entry.url) {
                    return Err(Error::Config(format!(
                        "{} must start with https:// (http:// only for the local machine) when the endpoint has an API key: the key travels in the request",
                        key("url")
                    )));
                }
            }
            None if !is_http_url(&entry.url) => {
                return Err(Error::Config(format!(
                    "{} must start with http:// or https://",
                    key("url")
                )));
            }
            None => {}
        }
        if entry.attempts == Some(0) {
            return Err(Error::Config(format!(
                "{} must be at least 1",
                key("attempts")
            )));
        }
        if entry.timeout_seconds == Some(0) {
            return Err(Error::Config(format!(
                "{} must be at least 1",
                key("timeout_seconds")
            )));
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::config::{Config, SAMPLE_FOR_TESTS};

    /// The sample with the remote backend. `extra` goes at the end of the `[prover]` section, so that it may open
    /// `[[prover.remote_endpoints]]` tables.
    fn remote_config(extra: &str) -> std::result::Result<Config, Error> {
        let vkey_line = SAMPLE_FOR_TESTS
            .lines()
            .find(|line| line.starts_with("program_vkey"))
            .unwrap();
        let text = SAMPLE_FOR_TESTS
            .replace("oracle_key_env = \"ORACLE_KEY\"\n", "")
            .replace("backend = \"oracle\"", "backend = \"remote\"")
            .replace(vkey_line, &format!("{vkey_line}\n{extra}"));
        Config::load(&text, &|_| None)
    }

    const GOOD: &str =
        "remote_url = \"https://worker.example.org\"\nremote_api_key_env = \"RUNPOD_API_KEY\"";

    /// Claim: a remote section with an https URL and the name of a variable loads, with the documented defaults.
    #[test]
    fn a_remote_section_loads_with_defaults() {
        let config = remote_config(GOOD).unwrap();
        assert_eq!(config.prover_config().unwrap().remote_timeout_seconds, 900);
        assert_eq!(config.prover_config().unwrap().remote_attempts, 4);
        assert_eq!(
            config.prover_config().unwrap().remote_retry_delay_seconds,
            10
        );
        assert_eq!(
            config
                .prover_config()
                .unwrap()
                .remote_cold_start_wait_seconds,
            900
        );
    }

    /// Claim: the file cannot hold the API key: a key named `api_key` is refused, and so is a value in the place of the
    /// variable name.
    /// Why it matters: the configuration file is copied and committed. The key lives in the environment only.
    #[test]
    fn the_api_key_cannot_be_written_in_the_file() {
        let error = remote_config(&format!("{GOOD}\napi_key = \"rpa_0123456789\"")).unwrap_err();
        assert!(matches!(error, Error::SecretHandling(_)), "got {error}");
        let pasted = GOOD.replace("RUNPOD_API_KEY", "rpa_0123456789abcdef");
        let error = remote_config(&pasted).unwrap_err();
        assert!(
            error
                .to_string()
                .contains("NAME of an environment variable"),
            "got {error}"
        );
    }

    /// Claim: a plain http URL is refused unless it points at the local machine.
    /// Why it matters: the API key travels in the request header.
    #[test]
    fn the_url_must_be_https_unless_it_is_local() {
        let plain = GOOD.replace("https://worker.example.org", "http://worker.example.org");
        assert!(remote_config(&plain).is_err());
        let local = GOOD.replace("https://worker.example.org", "http://127.0.0.1:8000");
        assert!(remote_config(&local).is_ok());
        assert!(remote_config("remote_api_key_env = \"RUNPOD_API_KEY\"").is_err());
        assert!(remote_config(&format!("{GOOD}\nremote_attempts = 0")).is_err());
    }

    /// Claim: the backend reads the key from the variable that the file names, and fails when it is unset or empty.
    /// The key does not show in the `Debug` text of the settings.
    #[test]
    fn the_key_comes_from_the_named_variable() {
        let config = remote_config(GOOD).unwrap();
        let unset = RemoteProver::from_config(
            config.prover_config().unwrap(),
            &|_| None,
            Logger::in_memory().0,
        );
        assert!(unset.err().unwrap().to_string().contains("RUNPOD_API_KEY"));
        let empty = RemoteProver::from_config(
            config.prover_config().unwrap(),
            &|_| Some("  ".into()),
            Logger::in_memory().0,
        );
        assert!(empty.is_err());
        let prover = RemoteProver::from_config(
            config.prover_config().unwrap(),
            &|name| (name == "RUNPOD_API_KEY").then(|| "secret-value".to_string()),
            Logger::in_memory().0,
        )
        .unwrap();
        let settings = prover.endpoint_settings();
        assert_eq!(settings.len(), 1);
        assert_eq!(settings[0].label, SINGLE_ENDPOINT_LABEL);
        assert_eq!(settings[0].api_key.as_deref(), Some("secret-value"));
        assert!(!format!("{:?}", settings[0]).contains("secret-value"));
    }

    const LIST: &str = r#"remote_cold_start_wait_seconds = 600

[[prover.remote_endpoints]]
label = "dedicated"
url = "http://203.0.113.7:40123"
ready_wait_seconds = 20
timeout_seconds = 120
attempts = 2

[[prover.remote_endpoints]]
label = "serverless"
url = "https://worker.example.org"
api_key_env = "RUNPOD_API_KEY"
"#;

    fn keys(name: &str) -> Option<String> {
        (name == "RUNPOD_API_KEY").then(|| "secret-value".to_string())
    }

    /// Claim: a list of endpoints loads in its order. An endpoint takes its own wait, timeout and attempts, and the
    /// section's values where it sets none. An endpoint without a key variable gets no key; the other reads its key from
    /// the variable it names.
    /// Why it matters: the dedicated worker needs a short wait and a short timeout, the serverless endpoint the long
    /// ones that cover a cold start.
    #[test]
    fn an_endpoint_list_loads_in_order_with_its_own_limits() {
        let config = remote_config(LIST).unwrap();
        let settings = remote_settings(config.prover_config().unwrap(), &keys).unwrap();
        let labels: Vec<&str> = settings.iter().map(|entry| entry.label.as_str()).collect();
        assert_eq!(labels, ["dedicated", "serverless"]);
        let (dedicated, serverless) = (&settings[0], &settings[1]);
        assert_eq!(dedicated.endpoint_url, "http://203.0.113.7:40123");
        assert_eq!(dedicated.api_key, None);
        assert_eq!(dedicated.cold_start_wait, Duration::from_secs(20));
        assert_eq!(dedicated.timeout, Duration::from_secs(120));
        assert_eq!(dedicated.attempts, 2);
        assert_eq!(serverless.api_key.as_deref(), Some("secret-value"));
        assert_eq!(serverless.cold_start_wait, Duration::from_secs(600));
        assert_eq!(serverless.timeout, Duration::from_secs(900));
        assert_eq!(serverless.attempts, 4);
        assert_eq!(serverless.retry_delay, Duration::from_secs(10));
        let missing = remote_settings(config.prover_config().unwrap(), &|_| None).unwrap_err();
        let text = missing.to_string();
        assert!(
            text.contains("RUNPOD_API_KEY") && text.contains("remote_endpoints[1].api_key_env"),
            "{text}"
        );
    }

    /// Claim: the single `remote_url` still loads, as a list of one endpoint labelled `remote` with the section's
    /// limits.
    /// Why it matters: every configuration written before the list keeps working.
    #[test]
    fn the_single_url_is_a_list_of_one() {
        let config = remote_config(GOOD).unwrap();
        let settings = remote_settings(config.prover_config().unwrap(), &keys).unwrap();
        assert_eq!(settings.len(), 1);
        assert_eq!(settings[0].label, "remote");
        assert_eq!(settings[0].endpoint_url, "https://worker.example.org");
        assert_eq!(settings[0].cold_start_wait, Duration::from_secs(900));
        assert_eq!(settings[0].attempts, 4);
    }

    /// Claim: a list is refused when it is mixed with `remote_url`, has a label that is empty, too long, in capitals or
    /// used twice, sends a key over plain http to another machine, names a secret where a variable name belongs, has a
    /// URL that is not http, sets zero attempts or a zero timeout, or lists too many endpoints. A list without a key
    /// may use plain http: a dedicated worker on a TCP port has no TLS and checks no key.
    #[test]
    fn a_bad_list_is_refused() {
        let error = |extra: &str| remote_config(extra).unwrap_err().to_string();
        let mixed = format!(
            "{GOOD}\n{}",
            LIST.replace("remote_cold_start_wait_seconds = 600\n", "")
        );
        assert!(error(&mixed).contains("not both"), "{}", error(&mixed));
        for label in ["", "Dedicated", "-x", "a b", &"x".repeat(33)] {
            let text = error(&LIST.replace("\"dedicated\"", &format!("\"{label}\"")));
            assert!(
                text.contains("remote_endpoints[0].label"),
                "{label}: {text}"
            );
        }
        let twice = LIST.replace("\"serverless\"", "\"dedicated\"");
        assert!(error(&twice).contains("used twice"), "{}", error(&twice));
        let key_over_http = LIST.replace("https://worker.example.org", "http://worker.example.org");
        assert!(error(&key_over_http).contains("remote_endpoints[1].url"));
        let pasted = LIST.replace("\"RUNPOD_API_KEY\"", "\"rpa_0123456789abcdef\"");
        assert!(error(&pasted).contains("NAME of an environment variable"));
        let not_http = LIST.replace("http://203.0.113.7:40123", "ftp://203.0.113.7");
        assert!(error(&not_http).contains("remote_endpoints[0].url"));
        assert!(error(&LIST.replace("attempts = 2", "attempts = 0"))
            .contains("attempts must be at least 1"));
        assert!(
            error(&LIST.replace("timeout_seconds = 120", "timeout_seconds = 0"))
                .contains("timeout_seconds must be at least 1")
        );
        let entry =
            "[[prover.remote_endpoints]]\nlabel = \"e{n}\"\nurl = \"https://e.example.org\"\n";
        let many: String = (0..=MAX_REMOTE_ENDPOINTS)
            .map(|n| entry.replace("{n}", &n.to_string()))
            .collect();
        assert!(error(&many).contains("at most 8"), "{}", error(&many));
        let unknown = LIST.replace("attempts = 2", "attempts = 2\nweight = 3");
        assert!(error(&unknown).contains("weight"), "{}", error(&unknown));
        assert!(error("").contains("remote_endpoints"), "{}", error(""));
        assert!(remote_config(&format!("{GOOD}\nremote_timeout_seconds = 0")).is_err());
        let plain_local_key = LIST.replace("https://worker.example.org", "http://127.0.0.1:8000");
        assert!(remote_config(&plain_local_key).is_ok());
    }

    /// Claim: the endpoint's URL and host are taken out of a reason, and other text stays.
    #[test]
    fn a_reason_never_names_the_endpoint_address() {
        let reason =
            "no answer: io: connect to 203.0.113.7:40123 failed (http://203.0.113.7:40123/prove)";
        let scrubbed = scrub_endpoint(reason, "http://203.0.113.7:40123/");
        assert!(!scrubbed.contains("203.0.113.7"), "{scrubbed}");
        assert!(
            scrubbed.starts_with("no answer: io: connect to <endpoint>"),
            "{scrubbed}"
        );
        assert_eq!(
            scrub_endpoint("status 500", "https://user@h.example.org"),
            "status 500"
        );
    }

    /// Claim: only the answers of the endpoint itself (key refused, wrong path) count as "this endpoint cannot
    /// help". A 400 or 422 of the worker is a refusal of the job.
    #[test]
    fn endpoint_refusals_are_told_apart_from_job_refusals() {
        for status in [401, 403, 404, 405] {
            assert!(is_endpoint_refusal(status), "{status}");
        }
        for status in [400, 409, 413, 422, 500] {
            assert!(!is_endpoint_refusal(status), "{status}");
        }
    }

    /// Claim: only server errors and rate limits are retried as ordinary failures. A 4xx from the worker is final.
    #[test]
    fn only_transient_statuses_are_retried() {
        assert!(is_retryable(500));
        assert!(is_retryable(502));
        assert!(is_retryable(429));
        assert!(!is_retryable(400));
        assert!(!is_retryable(401));
        assert!(!is_retryable(422));
    }

    /// Claim: the cold-start answers are recognised, and no other 400 is.
    #[test]
    fn cold_start_answers_are_recognised() {
        let runpod =
            r#"{"status":400,"title":"Bad Request","detail":"timed out waiting for worker"}"#;
        assert!(is_not_ready(400, runpod));
        assert!(is_not_ready(
            503,
            r#"{"error":"the worker is still starting"}"#
        ));
        assert!(is_not_ready(204, ""));
        assert!(is_not_ready(400, r#"{"error":"no workers available"}"#));
        assert!(!is_not_ready(400, r#"{"error":"bad"}"#));
        assert!(!is_not_ready(
            400,
            r#"{"status":400,"detail":"invalid body"}"#
        ));
        assert!(!is_not_ready(
            400,
            r#"{"error":"timed out waiting for worker"}"#
        ));
        assert!(!is_not_ready(422, runpod));
        assert!(!is_not_ready(500, ""));
        assert_eq!(error_text(runpod), "timed out waiting for worker");
    }

    /// Claim: the pause doubles from the retry delay and stops growing at a minute.
    #[test]
    fn the_cold_start_pause_doubles_up_to_a_minute() {
        let ten = Duration::from_secs(10);
        let steps: Vec<u64> = (1..=5).map(|n| cold_start_step(ten, n).as_secs()).collect();
        assert_eq!(steps, [10, 20, 40, 60, 60]);
        assert_eq!(cold_start_step(ten, u32::MAX), MAX_COLD_START_STEP);
        assert_eq!(cold_start_step(Duration::ZERO, 3), Duration::ZERO);
    }
}
