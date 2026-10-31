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
//! The API key comes from an environment variable that the configuration names. It never appears in a file, in a log
//! line or in an error text.

use crate::config::{is_permitted_secret_url, require_environment_name, ProverConfig};
use crate::error::{Error, Result};
use crate::logging::Logger;
use crate::prover::{
    native_job, require_groth16_shape, require_native_values, GuestJob, ProgramKind, Proof,
    ProofStatement, Prover,
};
use crate::rpc::{build_agent, USER_AGENT};
use alloy_primitives::{hex, B256};
use serde::{Deserialize, Serialize};
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
}

/// How the remote backend reaches its worker.
#[derive(Clone)]
pub struct RemoteSettings {
    /// The base URL of the endpoint, without the path.
    pub endpoint_url: String,
    /// The API key that goes in the `Authorization` header. Read from the environment, never from a file.
    pub api_key: String,
    /// The time one request may take, from the first byte sent to the last byte read. It must cover a cold start
    /// and a proof.
    pub timeout: Duration,
    /// How often a job is sent before the backend gives up on ordinary failures (no answer, a server error, a rate
    /// limit). At least 1. Answers of a worker that is not ready yet do not count; `cold_start_wait` bounds them.
    pub attempts: u32,
    /// The wait before the second attempt. The wait before attempt `n + 1` is `n` times this value.
    pub retry_delay: Duration,
    /// The longest time the backend waits for a worker that is not ready yet, counted from the first request. No new
    /// request starts after it. Zero turns the wait off: the first such answer fails the job.
    pub cold_start_wait: Duration,
}

impl std::fmt::Debug for RemoteSettings {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter
            .debug_struct("RemoteSettings")
            .field("endpoint_url", &self.endpoint_url)
            .field("api_key", &"<hidden>")
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
    Refuse(Error),
}

/// The remote proving backend. See the module documentation.
pub struct RemoteProver {
    settings: RemoteSettings,
    agent: ureq::Agent,
    logger: Logger,
}

impl RemoteProver {
    /// A backend for `settings`. It sends nothing until the first proof.
    pub fn new(settings: RemoteSettings, logger: Logger) -> Self {
        let agent = build_agent(settings.timeout, USER_AGENT);
        Self {
            settings,
            agent,
            logger,
        }
    }

    /// Builds the backend from the `[prover]` section. The API key comes from the environment variable that
    /// `remote_api_key_env` names, read through `lookup`.
    ///
    /// # Errors
    /// `Error::Config` when a key of the section is missing or the variable is not set.
    pub fn from_config(
        config: &ProverConfig,
        lookup: &dyn Fn(&str) -> Option<String>,
        logger: Logger,
    ) -> Result<Self> {
        let endpoint_url = config.remote_url.clone().ok_or_else(|| {
            Error::Config("prover.remote_url is required for the remote backend".into())
        })?;
        let variable = config.remote_api_key_env.as_deref().ok_or_else(|| {
            Error::Config("prover.remote_api_key_env is required for the remote backend".into())
        })?;
        let api_key = lookup(variable)
            .map(|value| value.trim().to_string())
            .filter(|value| !value.is_empty())
            .ok_or_else(|| {
                Error::Config(format!(
                    "the environment variable {variable} (prover.remote_api_key_env) is not set"
                ))
            })?;
        Ok(Self::new(
            RemoteSettings {
                endpoint_url,
                api_key,
                timeout: Duration::from_secs(config.remote_timeout_seconds),
                attempts: config.remote_attempts,
                retry_delay: Duration::from_secs(config.remote_retry_delay_seconds),
                cold_start_wait: Duration::from_secs(config.remote_cold_start_wait_seconds),
            },
            logger,
        ))
    }

    /// Sends the job until an attempt gives an answer or a refusal. A worker that is not ready yet is awaited with a
    /// growing pause until `cold_start_wait` has passed since the first request. Other failures are retried until
    /// `attempts` requests have failed.
    ///
    /// The caller is `Prover::prove`. It is public so that the tests drive the transport with a fake worker.
    ///
    /// # Errors
    /// `Error::Prover` when the worker refuses the job, stays not ready past `cold_start_wait`, or the attempts run
    /// out. `Error::Malformed` when a 200 answer is not a proof.
    pub fn request_proof(&self, request_body: &str) -> Result<ProveResponseBody> {
        let started = Instant::now();
        let mut failures = 0;
        let mut not_ready = 0;
        loop {
            match self.send_once(request_body) {
                Attempt::Done(answer) => return Ok(answer),
                Attempt::Refuse(error) => return Err(error),
                Attempt::NotReady(reason) => {
                    not_ready += 1;
                    let waited = started.elapsed();
                    let limit = self.settings.cold_start_wait;
                    let remaining = limit.saturating_sub(waited);
                    if remaining.is_zero() {
                        return Err(Error::Prover(format!(
                            "the remote worker was not ready after {} s of waiting, the limit of prover.remote_cold_start_wait_seconds ({} s); last answer: {reason}",
                            waited.as_secs(),
                            limit.as_secs()
                        )));
                    }
                    let wait = cold_start_step(self.settings.retry_delay, not_ready).min(remaining);
                    self.logger.warn(
                        "remote_worker_not_ready",
                        &[
                            ("waited_seconds", waited.as_secs().to_string()),
                            ("wait_seconds", wait.as_secs().to_string()),
                            ("limit_seconds", limit.as_secs().to_string()),
                            ("reason", reason),
                        ],
                    );
                    std::thread::sleep(wait);
                }
                Attempt::Retry(reason) => {
                    failures += 1;
                    if failures >= self.settings.attempts {
                        return Err(Error::Prover(format!(
                            "the remote worker gave no proof after {} attempts; last reason: {reason}",
                            self.settings.attempts
                        )));
                    }
                    let wait = self.settings.retry_delay * failures;
                    self.logger.warn(
                        "remote_prove_retry",
                        &[
                            ("attempt", failures.to_string()),
                            ("wait_seconds", wait.as_secs().to_string()),
                            ("reason", reason),
                        ],
                    );
                    std::thread::sleep(wait);
                }
            }
        }
    }

    fn send_once(&self, request_body: &str) -> Attempt {
        let url = format!("{}/prove", self.settings.endpoint_url.trim_end_matches('/'));
        let sent = self
            .agent
            .post(&url)
            .header("Content-Type", "application/json")
            .header(
                "Authorization",
                &format!("Bearer {}", self.settings.api_key),
            )
            .send(request_body);
        let mut response = match sent {
            Ok(response) => response,
            Err(error) => return Attempt::Retry(format!("no answer: {error}")),
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
                return Attempt::Retry(format!("status {status}: cannot read the answer: {error}"))
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
        let reason = format!("status {status}: {}", error_text(&text));
        if is_not_ready(status, &text) {
            return Attempt::NotReady(reason);
        }
        if is_retryable(status) {
            return Attempt::Retry(reason);
        }
        Attempt::Refuse(Error::Prover(format!(
            "the remote worker refused the job: {reason}"
        )))
    }
}

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
        let job = native_job(statement)?;
        let request = ProveRequestBody {
            program_key: format!("{program_vkey:#x}"),
            statement_kind: job.kind,
            guest_input: hex::encode_prefixed(&job.guest_input),
        };
        let body = serde_json::to_string(&request)
            .map_err(|error| Error::Prover(format!("cannot encode the request: {error}")))?;
        let answer = self.request_proof(&body)?;
        accept_answer(program_vkey, &job, &answer)
    }
}

/// Checks the remote keys of a `[prover]` section. The section holds a URL and the name of a variable, never a key.
///
/// # Errors
/// `Error::Config` naming the key.
pub fn validate_remote_config(config: &ProverConfig) -> Result<()> {
    let url = config.remote_url.as_deref().ok_or_else(|| {
        Error::Config("prover.remote_url is required for the remote backend".into())
    })?;
    if !is_permitted_secret_url(url) {
        return Err(Error::Config(
            "prover.remote_url must start with https:// (http:// only for the local machine): the API key travels in the request".into(),
        ));
    }
    let variable = config.remote_api_key_env.as_deref().ok_or_else(|| {
        Error::Config("prover.remote_api_key_env is required for the remote backend".into())
    })?;
    require_environment_name(variable, "prover.remote_api_key_env")?;
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
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::config::{Config, SAMPLE_FOR_TESTS};

    fn remote_config(extra: &str) -> std::result::Result<Config, Error> {
        let text = SAMPLE_FOR_TESTS
            .replace("oracle_key_env = \"ORACLE_KEY\"\n", "")
            .replace(
                "backend = \"oracle\"",
                &format!("backend = \"remote\"\n{extra}"),
            );
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
        assert_eq!(prover.settings.api_key, "secret-value");
        assert!(!format!("{:?}", prover.settings).contains("secret-value"));
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
