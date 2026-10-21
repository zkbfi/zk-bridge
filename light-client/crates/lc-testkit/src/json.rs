//! Fixture loaders, and the JSON parsers of `lc_core::json` under the old path.
//!
//! The parsers panic with a clear message on malformed input: a malformed fixture is a bug.

use serde_json::Value;
use std::path::PathBuf;

/// Directory that holds the fixtures: `light-client/tests/fixtures`.
pub fn fixtures_dir() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../tests/fixtures")
}

/// Loads a fixture file and returns the whole wrapper object `{source_url, fetched_on, response}`.
pub fn load_fixture(relative_path: &str) -> Value {
    let path = fixtures_dir().join(relative_path);
    let text = std::fs::read_to_string(&path).unwrap_or_else(|error| panic!("cannot read {}: {error}", path.display()));
    serde_json::from_str(&text).unwrap_or_else(|error| panic!("cannot parse {}: {error}", path.display()))
}

/// Loads a fixture and returns its `response` field. It checks that the source URL and the fetch date are recorded.
pub fn load_response(relative_path: &str) -> Value {
    let wrapper = load_fixture(relative_path);
    assert!(
        wrapper["source_url"]
            .as_str()
            .is_some_and(|url| url.starts_with("http") || url.starts_with("POST") || url.starts_with("derived")),
        "{relative_path} lacks source_url"
    );
    assert!(wrapper["fetched_on"].as_str().is_some_and(|date| date.len() == 10), "{relative_path} lacks fetched_on");
    wrapper["response"].clone()
}

pub use lc_core::json::*;
