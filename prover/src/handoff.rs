//! The proof package and its handoff.
//!
//! The `prove` command makes one [`ProofPackage`] and gives it to the stateful servers of the operator, which store it and
//! send it to the chain. The package is one JSON object with camel case keys. The handoff has two targets:
//!
//! - standard output: the object on one line, and nothing else on standard output;
//! - a webhook: one `POST` of the same object with `Content-Type: application/json`. The request carries the neutral
//!   User-Agent `zk-bridge-prover`, and an `Authorization: Bearer` header when the configuration names a variable that
//!   holds a token. The token is read from the environment when the command starts. It never enters a file or a log line.
//!
//! With both targets, standard output comes first, so a failed webhook does not lose the proof.

use crate::config::{HandoffConfig, HandoffTarget};
use crate::error::{Error, Result};
use crate::logging::Logger;
use crate::rpc::build_agent;
use serde::{Deserialize, Serialize};
use std::fmt;
use std::time::Duration;

/// The version of the package shape. A change that removes or renames a key raises it.
pub const SCHEMA_VERSION: u32 = 1;

/// The destination light client that a package is for. A package made from an explicit head has none.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PackageDestination {
    /// The chain identifier of the chain with the light client.
    pub chain_id: u64,
    /// The `BeaconLightClient` address, as `0x` and 40 hex digits.
    pub light_client: String,
}

/// One proof of a light-client update, with everything a server needs to store it and to send it.
///
/// Every hash and every byte string is `0x` hex. Every slot is a JSON number.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ProofPackage {
    /// The version of this shape ([`SCHEMA_VERSION`]).
    pub schema_version: u32,
    /// The name of the route, or `explicit-head` when the command line gave the starting head.
    pub route: String,
    /// The program key that the proof is for. The light client contract stores the same key as `programVKey`.
    pub program_key: String,
    /// The slot of the head where the update starts. The light client must still store it as its head.
    pub start_head_slot: u64,
    /// The header root of the starting head.
    pub start_head_root: String,
    /// The slot of the head after the update.
    pub new_head_slot: u64,
    /// The header root of the new head.
    pub new_head_root: String,
    /// The slot of the newest final header that the beacon node reported. When it is above `newHeadSlot`, the head lagged
    /// by more than one fold covers, and the next run continues from the new head.
    pub latest_finalized_slot: u64,
    /// The public values the proof commits to: the ABI encoding of `LightClientOutput`.
    pub public_values: String,
    /// The proof bytes that the verifier contract reads.
    pub proof: String,
    /// The calldata of `BeaconLightClient.update(proof, publicValues)`. A server sends it to `destination.lightClient`.
    pub update_calldata: String,
    /// The backend that made the proof: `sp1`, `remote` or `oracle`.
    pub backend: String,
    /// The destination light client, when the route names it.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub destination: Option<PackageDestination>,
    /// When the proof was made, as a time in UTC, such as `2026-10-24T09:30:00Z`.
    pub created_at: String,
}

impl ProofPackage {
    /// The package as one line of JSON.
    pub fn to_json_line(&self) -> Result<String> {
        serde_json::to_string(self)
            .map_err(|error| Error::Handoff(format!("cannot encode the package: {error}")))
    }
}

/// A time in UTC (`2026-10-24T09:30:00Z`) for a count of seconds since 1970-01-01.
///
/// The conversion is the civil-from-days algorithm, so the crate needs no calendar library.
pub fn utc_time_text(unix_seconds: u64) -> String {
    let days = (unix_seconds / 86_400) as i64;
    let seconds_of_day = unix_seconds % 86_400;
    let shifted = days + 719_468;
    let era = shifted.div_euclid(146_097);
    let day_of_era = shifted.rem_euclid(146_097);
    let year_of_era =
        (day_of_era - day_of_era / 1_460 + day_of_era / 36_524 - day_of_era / 146_096) / 365;
    let day_of_year = day_of_era - (365 * year_of_era + year_of_era / 4 - year_of_era / 100);
    let month_index = (5 * day_of_year + 2) / 153;
    let day = day_of_year - (153 * month_index + 2) / 5 + 1;
    let month = if month_index < 10 {
        month_index + 3
    } else {
        month_index - 9
    };
    let year = year_of_era + era * 400 + i64::from(month <= 2);
    format!(
        "{year:04}-{month:02}-{day:02}T{:02}:{:02}:{:02}Z",
        seconds_of_day / 3_600,
        seconds_of_day % 3_600 / 60,
        seconds_of_day % 60
    )
}

/// The settings of the webhook target.
#[derive(Clone)]
pub struct WebhookSettings {
    /// The URL that receives the POST.
    pub url: String,
    /// The bearer token, read from the environment. `None` sends no `Authorization` header.
    pub bearer_token: Option<String>,
    /// The time one request may take.
    pub timeout: Duration,
    /// How often the command sends the request before it gives up.
    pub attempts: u32,
    /// The wait before the second attempt. The wait grows by this much for each further attempt.
    pub retry_delay: Duration,
}

impl fmt::Debug for WebhookSettings {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("WebhookSettings")
            .field("url", &self.url)
            .field("bearer_token", &self.bearer_token.as_ref().map(|_| "<set>"))
            .field("timeout", &self.timeout)
            .field("attempts", &self.attempts)
            .field("retry_delay", &self.retry_delay)
            .finish()
    }
}

/// Where one run puts its package.
#[derive(Clone, Debug)]
pub struct Handoff {
    /// Whether to print the package on standard output.
    pub to_stdout: bool,
    /// The webhook, when it is a target.
    pub webhook: Option<WebhookSettings>,
}

impl Handoff {
    /// Resolves the targets. `targets` replaces the ones of the file when it is not empty. `lookup` reads the environment.
    ///
    /// # Errors
    /// `Error::Config` when the webhook is a target but the file sets no URL, or when the variable that
    /// `webhook_bearer_env` names is not set or is empty.
    pub fn resolve(
        config: &HandoffConfig,
        targets: &[HandoffTarget],
        lookup: &dyn Fn(&str) -> Option<String>,
    ) -> Result<Self> {
        let targets = if targets.is_empty() {
            config.targets.as_slice()
        } else {
            targets
        };
        let to_stdout = targets.contains(&HandoffTarget::Stdout);
        if !targets.contains(&HandoffTarget::Webhook) {
            return Ok(Self {
                to_stdout,
                webhook: None,
            });
        }
        let url = config.webhook_url.clone().ok_or_else(|| {
            Error::Config("the webhook is a target, but handoff.webhook_url is not set".into())
        })?;
        Ok(Self {
            to_stdout,
            webhook: Some(WebhookSettings {
                url,
                bearer_token: read_bearer_token(config, lookup)?,
                timeout: Duration::from_secs(config.webhook_timeout_seconds),
                attempts: config.webhook_attempts,
                retry_delay: Duration::from_secs(config.webhook_retry_delay_seconds),
            }),
        })
    }

    /// Gives the package to every target. Standard output comes first.
    ///
    /// # Errors
    /// `Error::Handoff` when the package cannot be written, or when the webhook refuses it after all attempts.
    pub fn deliver(
        &self,
        package: &ProofPackage,
        out: &mut dyn std::io::Write,
        logger: &Logger,
    ) -> Result<()> {
        let line = package.to_json_line()?;
        if self.to_stdout {
            writeln!(out, "{line}")
                .and_then(|()| out.flush())
                .map_err(|error| {
                    Error::Handoff(format!("cannot write standard output: {error}"))
                })?;
        }
        let Some(webhook) = &self.webhook else {
            return Ok(());
        };
        post_with_retries(webhook, &line, logger)
    }
}

fn read_bearer_token(
    config: &HandoffConfig,
    lookup: &dyn Fn(&str) -> Option<String>,
) -> Result<Option<String>> {
    let Some(variable) = config.webhook_bearer_env.as_deref() else {
        return Ok(None);
    };
    lookup(variable)
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty())
        .map(Some)
        .ok_or_else(|| {
            Error::Config(format!(
                "the environment variable {variable} (handoff.webhook_bearer_env) is not set"
            ))
        })
}

/// What one POST gave.
enum Attempt {
    Delivered,
    /// The receiver refused the package for good (a 4xx status other than 408 and 429).
    Refused(String),
    /// A transport error or a status that can pass.
    Retry(String),
}

fn post_with_retries(webhook: &WebhookSettings, body: &str, logger: &Logger) -> Result<()> {
    let agent = build_agent(webhook.timeout);
    let mut last_reason = String::new();
    for attempt in 1..=webhook.attempts {
        match post_once(&agent, webhook, body) {
            Attempt::Delivered => return Ok(()),
            Attempt::Refused(reason) => {
                return Err(Error::Handoff(format!(
                    "the webhook refused the proof: {reason}"
                )))
            }
            Attempt::Retry(reason) => last_reason = reason,
        }
        if attempt == webhook.attempts {
            break;
        }
        let wait = webhook.retry_delay * attempt;
        logger.warn(
            "webhook_retry",
            &[
                ("attempt", attempt.to_string()),
                ("wait_seconds", wait.as_secs().to_string()),
                ("reason", last_reason.clone()),
            ],
        );
        std::thread::sleep(wait);
    }
    Err(Error::Handoff(format!(
        "the webhook took no proof after {} attempts; last reason: {last_reason}",
        webhook.attempts
    )))
}

fn post_once(agent: &ureq::Agent, webhook: &WebhookSettings, body: &str) -> Attempt {
    let mut request = agent
        .post(&webhook.url)
        .header("Content-Type", "application/json");
    if let Some(token) = &webhook.bearer_token {
        request = request.header("Authorization", &format!("Bearer {token}"));
    }
    let mut response = match request.send(body) {
        Ok(response) => response,
        Err(error) => return Attempt::Retry(format!("no answer: {error}")),
    };
    let status = response.status().as_u16();
    if (200..300).contains(&status) {
        return Attempt::Delivered;
    }
    let text = response
        .body_mut()
        .read_to_string()
        .unwrap_or_default()
        .chars()
        .take(300)
        .collect::<String>();
    let reason = format!("status {status}: {text}");
    match status {
        408 | 429 | 500..=599 => Attempt::Retry(reason),
        _ => Attempt::Refused(reason),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::{Arc, Mutex};

    fn sample_package() -> ProofPackage {
        ProofPackage {
            schema_version: SCHEMA_VERSION,
            route: "ethereum_to_pulsechain".into(),
            program_key: format!("0x{}", "42".repeat(32)),
            start_head_slot: 100,
            start_head_root: format!("0x{}", "11".repeat(32)),
            new_head_slot: 200,
            new_head_root: format!("0x{}", "22".repeat(32)),
            latest_finalized_slot: 200,
            public_values: "0x0102".into(),
            proof: "0x0304".into(),
            update_calldata: "0x0506".into(),
            backend: "oracle".into(),
            destination: Some(PackageDestination {
                chain_id: 369,
                light_client: format!("0x{}", "44".repeat(20)),
            }),
            created_at: utc_time_text(1_800_000_000),
        }
    }

    /// Claim: the conversion of seconds to a calendar time is right at the epoch, at a known later instant, and on a leap day.
    /// Why it matters: consumers sort and expire packages by `createdAt`. A wrong date would hide a stale proof.
    #[test]
    fn utc_time_text_matches_known_instants() {
        assert_eq!(utc_time_text(0), "1970-01-01T00:00:00Z");
        assert_eq!(utc_time_text(1_800_000_000), "2027-01-15T08:00:00Z");
        assert_eq!(utc_time_text(1_709_164_800), "2024-02-29T00:00:00Z");
        assert_eq!(utc_time_text(951_782_399), "2000-02-28T23:59:59Z");
    }

    /// Claim: the JSON has the documented keys in camel case, the required ones always, and no destination when there is none.
    /// Why it matters: consumers are other programs. A renamed key breaks them silently.
    #[test]
    fn the_package_has_the_documented_keys() {
        let value: serde_json::Value =
            serde_json::from_str(&sample_package().to_json_line().unwrap()).unwrap();
        let mut keys: Vec<&str> = value
            .as_object()
            .unwrap()
            .keys()
            .map(String::as_str)
            .collect();
        keys.sort_unstable();
        assert_eq!(
            keys,
            [
                "backend",
                "createdAt",
                "destination",
                "latestFinalizedSlot",
                "newHeadRoot",
                "newHeadSlot",
                "programKey",
                "proof",
                "publicValues",
                "route",
                "schemaVersion",
                "startHeadRoot",
                "startHeadSlot",
                "updateCalldata"
            ]
        );
        assert_eq!(value["destination"]["chainId"], 369);
        let without = ProofPackage {
            destination: None,
            ..sample_package()
        };
        let value: serde_json::Value =
            serde_json::from_str(&without.to_json_line().unwrap()).unwrap();
        assert!(value.get("destination").is_none());
        assert!(!without.to_json_line().unwrap().contains('\n'));
    }

    /// A one-request webhook receiver. It answers each request with the next status of `statuses`, and records the
    /// request.
    struct Receiver {
        url: String,
        seen: Arc<Mutex<Vec<Seen>>>,
    }

    #[derive(Clone, Debug)]
    struct Seen {
        authorization: Option<String>,
        user_agent: Option<String>,
        content_type: Option<String>,
        body: String,
    }

    fn header_of(request: &tiny_http::Request, name: &'static str) -> Option<String> {
        request
            .headers()
            .iter()
            .find(|header| header.field.equiv(name))
            .map(|header| header.value.to_string())
    }

    fn read_body(request: &mut tiny_http::Request) -> String {
        let mut body = String::new();
        std::io::Read::read_to_string(request.as_reader(), &mut body).unwrap();
        body
    }

    fn receiver(statuses: Vec<u16>) -> Receiver {
        let server = tiny_http::Server::http("127.0.0.1:0").expect("a free port");
        let port = server.server_addr().to_ip().expect("an ip address").port();
        let seen = Arc::new(Mutex::new(Vec::new()));
        let recorded = seen.clone();
        std::thread::spawn(move || {
            for status in statuses {
                let Ok(mut request) = server.recv() else {
                    return;
                };
                let seen = Seen {
                    authorization: header_of(&request, "Authorization"),
                    user_agent: header_of(&request, "User-Agent"),
                    content_type: header_of(&request, "Content-Type"),
                    body: read_body(&mut request),
                };
                recorded.lock().unwrap().push(seen);
                let _ = request.respond(tiny_http::Response::empty(status));
            }
        });
        Receiver {
            url: format!("http://127.0.0.1:{port}/proofs"),
            seen,
        }
    }

    fn webhook(url: &str, token: Option<&str>, attempts: u32) -> WebhookSettings {
        WebhookSettings {
            url: url.to_string(),
            bearer_token: token.map(str::to_string),
            timeout: Duration::from_secs(5),
            attempts,
            retry_delay: Duration::from_millis(10),
        }
    }

    /// Claim: the webhook gets the package as JSON, with the bearer token, the neutral User-Agent and the JSON content type.
    /// Why it matters: the receiver authenticates the sender by the token, and the User-Agent must not name a person or a machine.
    #[test]
    fn the_webhook_gets_the_package_with_the_token() {
        let receiver = receiver(vec![200]);
        let handoff = Handoff {
            to_stdout: false,
            webhook: Some(webhook(&receiver.url, Some("example-token"), 1)),
        };
        let mut out = Vec::new();
        handoff
            .deliver(&sample_package(), &mut out, &Logger::in_memory().0)
            .unwrap();
        assert!(out.is_empty(), "the webhook target alone prints nothing");
        let seen = receiver.seen.lock().unwrap();
        assert_eq!(seen.len(), 1);
        assert_eq!(
            seen[0].authorization.as_deref(),
            Some("Bearer example-token")
        );
        assert_eq!(seen[0].user_agent.as_deref(), Some("zk-bridge-prover"));
        assert_eq!(seen[0].content_type.as_deref(), Some("application/json"));
        let sent: ProofPackage = serde_json::from_str(&seen[0].body).unwrap();
        assert_eq!(sent, sample_package());
    }

    /// Claim: without a token variable the request has no `Authorization` header, and standard output still gets the
    /// package when both targets are selected.
    #[test]
    fn no_token_means_no_header_and_both_targets_both_receive() {
        let receiver = receiver(vec![204]);
        let handoff = Handoff {
            to_stdout: true,
            webhook: Some(webhook(&receiver.url, None, 1)),
        };
        let mut out = Vec::new();
        handoff
            .deliver(&sample_package(), &mut out, &Logger::in_memory().0)
            .unwrap();
        assert_eq!(receiver.seen.lock().unwrap()[0].authorization, None);
        let printed: ProofPackage =
            serde_json::from_str(String::from_utf8(out).unwrap().trim()).unwrap();
        assert_eq!(printed, sample_package());
    }

    /// Claim: a server error is retried and a later success delivers; a refusal (403) is final after one request; and
    /// attempts that run out give an error. In every failure the package already went to standard output.
    /// Why it matters: a proof is costly. A short outage of the receiver must not lose it, a wrong token must not loop, and
    /// the printed copy is the last resort.
    #[test]
    fn retries_cover_outages_but_not_refusals() {
        let flaky = receiver(vec![503, 200]);
        let handoff = Handoff {
            to_stdout: true,
            webhook: Some(webhook(&flaky.url, None, 3)),
        };
        handoff
            .deliver(&sample_package(), &mut Vec::new(), &Logger::in_memory().0)
            .unwrap();
        assert_eq!(flaky.seen.lock().unwrap().len(), 2);

        let refusing = receiver(vec![403, 200]);
        let handoff = Handoff {
            to_stdout: true,
            webhook: Some(webhook(&refusing.url, None, 3)),
        };
        let mut out = Vec::new();
        let error = handoff
            .deliver(&sample_package(), &mut out, &Logger::in_memory().0)
            .unwrap_err();
        assert!(matches!(error, Error::Handoff(_)), "{error}");
        assert!(error.to_string().contains("refused"), "{error}");
        assert_eq!(refusing.seen.lock().unwrap().len(), 1);
        assert!(!out.is_empty(), "standard output came first");

        let down = receiver(vec![500, 500]);
        let handoff = Handoff {
            to_stdout: false,
            webhook: Some(webhook(&down.url, None, 2)),
        };
        let error = handoff
            .deliver(&sample_package(), &mut Vec::new(), &Logger::in_memory().0)
            .unwrap_err();
        assert!(error.to_string().contains("after 2 attempts"), "{error}");
    }

    /// Claim: the targets of the file apply unless the command line names some; the webhook needs a URL; a token variable
    /// that is unset or empty is an error; and the token never shows in the `Debug` text.
    #[test]
    fn targets_resolve_from_the_file_and_the_command_line() {
        let file = HandoffConfig {
            webhook_url: Some("https://hooks.example.org/x".into()),
            webhook_bearer_env: Some("HOOK_TOKEN".into()),
            ..HandoffConfig::default()
        };
        let with_token = |name: &str| (name == "HOOK_TOKEN").then(|| "example-token".to_string());
        let none = |_: &str| None;

        let default = Handoff::resolve(&file, &[], &none).unwrap();
        assert!(default.to_stdout && default.webhook.is_none());

        let hook_only = Handoff::resolve(&file, &[HandoffTarget::Webhook], &with_token).unwrap();
        assert!(!hook_only.to_stdout);
        let webhook = hook_only.webhook.expect("webhook");
        assert_eq!(webhook.bearer_token.as_deref(), Some("example-token"));
        assert!(!format!("{webhook:?}").contains("example-token"));

        let error = Handoff::resolve(&file, &[HandoffTarget::Webhook], &none).unwrap_err();
        assert!(error.to_string().contains("HOOK_TOKEN"), "{error}");
        let empty = |_: &str| Some("  ".to_string());
        assert!(Handoff::resolve(&file, &[HandoffTarget::Webhook], &empty).is_err());

        let no_url = HandoffConfig::default();
        let error = Handoff::resolve(&no_url, &[HandoffTarget::Webhook], &none).unwrap_err();
        assert!(error.to_string().contains("webhook_url"), "{error}");
    }
}
