//! A small JSON-RPC client over HTTP, and a plain HTTP client for beacon nodes.
//!
//! Both send the User-Agent `zk-bridge-prover` and nothing else that names a person or a machine.
//! The service is synchronous: one loop, one request at a time. So it needs no async runtime, and the crate
//! list stays short (`ureq` is blocking and small). See `Cargo.toml`.

use crate::error::{Error, Result};
use alloy_primitives::{hex, Bytes};
use serde_json::{json, Value};
use std::time::Duration;

/// The User-Agent of every request.
pub const USER_AGENT: &str = "zk-bridge-prover";

/// The largest body the service reads: a beacon state is about 20 megabytes on PulseChain.
const MAX_BODY_BYTES: u64 = 512 * 1024 * 1024;

/// Anything that answers JSON-RPC calls. Tests replace it with a fake.
pub trait JsonRpc: Send + Sync {
    /// Calls `method` and returns its `result`.
    ///
    /// # Errors
    /// `Error::Rpc` when the node returns an error object, `Error::Http` when no answer arrives.
    fn call(&self, method: &str, params: Value) -> Result<Value>;
}

pub(crate) fn build_agent(timeout: Duration) -> ureq::Agent {
    let config = ureq::Agent::config_builder()
        .timeout_global(Some(timeout))
        .http_status_as_error(false)
        .user_agent(USER_AGENT)
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
            agent: build_agent(Duration::from_secs(60)),
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
            .map_err(|error| Error::Http(format!("{method}: {error}")))?;
        let status = response.status().as_u16();
        let text = response
            .body_mut()
            .read_to_string()
            .map_err(|error| Error::Http(format!("{method}: reading the answer: {error}")))?;
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

/// An [`HttpGet`] over `ureq`.
pub struct HttpClient {
    base_url: String,
    agent: ureq::Agent,
}

impl HttpClient {
    /// A client with a 120 second timeout per request. `base_url` has no trailing slash after the call.
    pub fn new(base_url: &str) -> Self {
        Self {
            base_url: base_url.trim_end_matches('/').to_string(),
            agent: build_agent(Duration::from_secs(120)),
        }
    }
}

impl HttpGet for HttpClient {
    fn get(&self, path_and_query: &str, accept: &str) -> Result<HttpResponse> {
        let url = format!("{}{}", self.base_url, path_and_query);
        let mut response = self
            .agent
            .get(&url)
            .header("Accept", accept)
            .call()
            .map_err(|error| Error::Http(format!("GET {path_and_query}: {error}")))?;
        let status = response.status().as_u16();
        let body = response
            .body_mut()
            .with_config()
            .limit(MAX_BODY_BYTES)
            .read_to_vec()
            .map_err(|error| {
                Error::Http(format!("GET {path_and_query}: reading the body: {error}"))
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

    /// Claim: the revert data of a node error object survives parsing, so the service can read the selector.
    /// Why it matters: "already claimed" is recognised by the first four bytes of that data.
    #[test]
    fn error_object_keeps_revert_data() {
        let error = rpc_error_from(
            &json!({"code": 3, "message": "execution reverted", "data": "0x1234567800"}),
        );
        assert_eq!(error.revert_selector(), Some([0x12, 0x34, 0x56, 0x78]));
    }

    /// Claim: quantities round-trip and a non-hex value is refused.
    #[test]
    fn quantities_parse() {
        assert_eq!(parse_quantity(&json!("0x1f")).expect("parse"), 31);
        assert_eq!(quantity(31), "0x1f");
        assert!(parse_quantity(&json!("zz")).is_err());
    }
}
