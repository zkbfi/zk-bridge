//! A small JSON-RPC client over HTTP, and a plain HTTP client for beacon nodes.
//!
//! Both send the neutral User-Agent [`NEUTRAL_USER_AGENT`], which public nodes accept, and nothing else that names a person
//! or a machine.
//! The crate is synchronous: one request at a time. So it needs no async runtime, and the crate
//! list stays short (`ureq` is blocking and small). See `Cargo.toml`.

use crate::error::{Error, Result};
use crate::logging::redact_urls;
use alloy_primitives::{hex, Bytes};
use serde_json::{json, Value};
use std::time::Duration;

/// The User-Agent of requests to servers of the operator: the webhook and the remote prover.
pub const USER_AGENT: &str = "zk-bridge-prover";

/// The User-Agent of requests to public nodes (beacon API and JSON-RPC). Some public nodes refuse an unknown client name,
/// so this one looks like a common client and names no person and no machine.
pub const NEUTRAL_USER_AGENT: &str = "Mozilla/5.0 (compatible; zk-bridge/1.0)";

/// The largest body the crate reads: a beacon state is about 20 megabytes on PulseChain.
const MAX_BODY_BYTES: u64 = 512 * 1024 * 1024;

/// Anything that answers JSON-RPC calls. Tests replace it with a fake.
pub trait JsonRpc: Send + Sync {
    /// Calls `method` and returns its `result`.
    ///
    /// # Errors
    /// `Error::Rpc` when the node returns an error object, `Error::Http` when no answer arrives.
    fn call(&self, method: &str, params: Value) -> Result<Value>;
}

pub(crate) fn build_agent(timeout: Duration, user_agent: &str) -> ureq::Agent {
    let config = ureq::Agent::config_builder()
        .timeout_global(Some(timeout))
        .http_status_as_error(false)
        .user_agent(user_agent)
        .build();
    ureq::Agent::new_with_config(config)
}

/// A JSON-RPC client for one URL.
pub struct HttpRpc {
    url: String,
    agent: ureq::Agent,
}

impl HttpRpc {
    /// A client with a 60 second timeout per request.
    pub fn new(url: &str) -> Self {
        Self {
            url: url.to_string(),
            agent: build_agent(Duration::from_secs(60), NEUTRAL_USER_AGENT),
        }
    }
}

/// Reads the `error` object of a JSON-RPC answer.
pub fn rpc_error_from(error: &Value) -> Error {
    let code = error["code"].as_i64().unwrap_or(0);
    let message = error["message"]
        .as_str()
        .unwrap_or("no message")
        .to_string();
    let data = error["data"]
        .as_str()
        .and_then(|text| hex::decode(text).ok())
        .map(Bytes::from);
    Error::Rpc {
        code,
        message,
        data,
    }
}

impl JsonRpc for HttpRpc {
    fn call(&self, method: &str, params: Value) -> Result<Value> {
        let body =
            json!({ "jsonrpc": "2.0", "id": 1, "method": method, "params": params }).to_string();
        let mut response = self
            .agent
            .post(&self.url)
            .header("Content-Type", "application/json")
            .send(body.as_str())
            .map_err(|error| Error::Http(redact_urls(&format!("{method}: {error}"))))?;
        let status = response.status().as_u16();
        let text = response.body_mut().read_to_string().map_err(|error| {
            Error::Http(redact_urls(&format!(
                "{method}: reading the answer: {error}"
            )))
        })?;
        let answer: Value = match serde_json::from_str(&text) {
            Ok(answer) => answer,
            Err(_) if status != 200 => {
                return Err(Error::Http(format!("{method}: status {status}")))
            }
            Err(error) => return Err(Error::Malformed(format!("{method}: {error}"))),
        };
        if let Some(error) = answer.get("error").filter(|error| !error.is_null()) {
            return Err(rpc_error_from(error));
        }
        answer
            .get("result")
            .cloned()
            .ok_or_else(|| Error::Malformed(format!("{method}: no result field")))
    }
}

/// The answer of a plain HTTP request.
#[derive(Debug, Clone)]
pub struct HttpResponse {
    /// The status code.
    pub status: u16,
    /// The body.
    pub body: Vec<u8>,
}

/// A plain HTTP client for beacon nodes. It does not treat a 404 as an error: the caller decides.
pub trait HttpGet: Send + Sync {
    /// GET `path_and_query` on the configured base URL. `accept` sets the `Accept` header.
    ///
    /// # Errors
    /// `Error::Http` when no answer arrives.
    fn get(&self, path_and_query: &str, accept: &str) -> Result<HttpResponse>;
}

/// Joins a base URL and a route. The base may have a path prefix (`https://host/beacon-api`), a key segment
/// (`https://host/beacon/KEY/943`) and a trailing slash. The route starts with `/` and may hold a query string. The
/// result has exactly one slash between the two.
pub fn join_url(base_url: &str, path_and_query: &str) -> String {
    format!(
        "{}/{}",
        base_url.trim_end_matches('/'),
        path_and_query.trim_start_matches('/')
    )
}

/// An [`HttpGet`] over `ureq`.
pub struct HttpClient {
    base_url: String,
    agent: ureq::Agent,
}

impl HttpClient {
    /// A client with a 120 second timeout per request. `base_url` may end with a slash and may hold a path prefix.
    pub fn new(base_url: &str) -> Self {
        Self {
            base_url: base_url.to_string(),
            agent: build_agent(Duration::from_secs(120), NEUTRAL_USER_AGENT),
        }
    }
}

impl HttpGet for HttpClient {
    fn get(&self, path_and_query: &str, accept: &str) -> Result<HttpResponse> {
        let url = join_url(&self.base_url, path_and_query);
        let mut response = self
            .agent
            .get(&url)
            .header("Accept", accept)
            .call()
            .map_err(|error| Error::Http(redact_urls(&format!("GET {path_and_query}: {error}"))))?;
        let status = response.status().as_u16();
        let body = response
            .body_mut()
            .with_config()
            .limit(MAX_BODY_BYTES)
            .read_to_vec()
            .map_err(|error| {
                Error::Http(redact_urls(&format!(
                    "GET {path_and_query}: reading the body: {error}"
                )))
            })?;
        Ok(HttpResponse { status, body })
    }
}

/// Parses a `0x` quantity such as `0x1f` into a `u64`.
///
/// # Errors
/// `Error::Malformed` when the text is not a hex quantity.
pub fn parse_quantity(value: &Value) -> Result<u64> {
    let text = value
        .as_str()
        .ok_or_else(|| Error::Malformed(format!("expected a quantity, got {value}")))?;
    u64::from_str_radix(text.trim_start_matches("0x"), 16)
        .map_err(|error| Error::Malformed(format!("bad quantity {text}: {error}")))
}

/// Formats a `u64` as a `0x` quantity.
pub fn quantity(value: u64) -> String {
    format!("{value:#x}")
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Claim: the revert data of a node error object survives parsing.
    /// Why it matters: the revert data names the reason of a failed call. Dropping it would leave only "execution reverted".
    #[test]
    fn error_object_keeps_revert_data() {
        let error = rpc_error_from(
            &json!({"code": 3, "message": "execution reverted", "data": "0x1234567800"}),
        );
        let Error::Rpc { code, data, .. } = error else {
            panic!("an RPC error");
        };
        assert_eq!(code, 3);
        assert_eq!(
            data.expect("revert data").as_ref(),
            [0x12, 0x34, 0x56, 0x78, 0x00]
        );
    }

    /// Claim: a path prefix of the base URL is kept, a trailing slash is tolerated, the query string stays intact, and a base
    /// with a key segment still works. Why it matters: public beacon nodes sit behind a prefix such as `/beacon-api`.
    /// Dropping the prefix sends the request to the wrong route.
    #[test]
    fn a_base_url_with_a_path_prefix_joins_cleanly() {
        let route = "/eth/v1/beacon/light_client/updates?start_period=3&count=2";
        let expected = |base: &str| format!("{base}{route}");
        for base in [
            "https://host.example/beacon-api",
            "https://host.example/beacon/KEY/943",
            "https://host.example",
            "http://127.0.0.1:5052",
        ] {
            assert_eq!(join_url(base, route), expected(base), "plain {base}");
            assert_eq!(
                join_url(&format!("{base}/"), route),
                expected(base),
                "slash {base}"
            );
            assert_eq!(
                join_url(&format!("{base}//"), route),
                expected(base),
                "slashes {base}"
            );
        }
        assert_eq!(
            join_url("https://h.example/p", "eth/v1/x"),
            "https://h.example/p/eth/v1/x"
        );
    }

    /// Claim: the clients of public nodes send the neutral User-Agent and the operator clients send their own name.
    #[test]
    fn user_agents_are_fixed() {
        assert_eq!(
            NEUTRAL_USER_AGENT,
            "Mozilla/5.0 (compatible; zk-bridge/1.0)"
        );
        assert_eq!(USER_AGENT, "zk-bridge-prover");
    }

    /// Claim: the real client sends the request to the prefixed route with its query, and sends the neutral User-Agent.
    /// Why it matters: this is the check on the wire, not only on the join function.
    #[test]
    fn the_client_reaches_a_prefixed_route_with_the_neutral_agent() {
        let server = tiny_http::Server::http("127.0.0.1:0").expect("bind");
        let port = server.server_addr().to_ip().expect("ip").port();
        let handle = std::thread::spawn(move || {
            let request = server.recv().expect("request");
            let seen = (
                request.url().to_string(),
                request
                    .headers()
                    .iter()
                    .find(|header| header.field.equiv("User-Agent"))
                    .map(|header| header.value.to_string()),
            );
            request
                .respond(tiny_http::Response::from_string("ok"))
                .expect("respond");
            seen
        });
        let client = HttpClient::new(&format!("http://127.0.0.1:{port}/beacon/KEY/943/"));
        let answer = client
            .get("/eth/v1/beacon/headers/finalized?x=1", "application/json")
            .expect("answer");
        assert_eq!(answer.status, 200);
        let (url, agent) = handle.join().expect("server thread");
        assert_eq!(url, "/beacon/KEY/943/eth/v1/beacon/headers/finalized?x=1");
        assert_eq!(agent.as_deref(), Some(NEUTRAL_USER_AGENT));
    }

    /// Claim: quantities round-trip and a non-hex value is refused.
    #[test]
    fn quantities_parse() {
        assert_eq!(parse_quantity(&json!("0x1f")).expect("parse"), 31);
        assert_eq!(quantity(31), "0x1f");
        assert!(parse_quantity(&json!("zz")).is_err());
    }
}
