//! Structured logs: one line per event, `key=value` pairs, written to standard error.
//!
//! Standard output belongs to the proof package of the `prove` command, so logs never go there. Values with spaces
//! are quoted. The crate never logs a key, a token or a full request body.

use std::fmt::Write as _;
use std::sync::{Arc, Mutex};
use std::time::{SystemTime, UNIX_EPOCH};

/// The severity of a line.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Level {
    /// Normal progress.
    Info,
    /// Something went wrong and the caller tries again.
    Warn,
    /// Something went wrong and the caller gives up.
    Error,
}

impl Level {
    fn name(self) -> &'static str {
        match self {
            Self::Info => "info",
            Self::Warn => "warn",
            Self::Error => "error",
        }
    }
}

#[derive(Clone)]
enum Sink {
    Standard,
    Memory(Arc<Mutex<Vec<String>>>),
}

/// Writes structured lines to standard error, or to memory in tests.
#[derive(Clone)]
pub struct Logger {
    sink: Sink,
}

impl Logger {
    /// A logger that writes every line to standard error.
    pub fn standard() -> Self {
        Self {
            sink: Sink::Standard,
        }
    }

    /// A logger that keeps lines in memory. The second value gives the lines written so far.
    pub fn in_memory() -> (Self, Arc<Mutex<Vec<String>>>) {
        let lines = Arc::new(Mutex::new(Vec::new()));
        (
            Self {
                sink: Sink::Memory(lines.clone()),
            },
            lines,
        )
    }

    /// Writes one line. Every URL in a value loses its path and query, because a path can hold a key.
    pub fn log(&self, level: Level, event: &str, fields: &[(&str, String)]) {
        let line = format_line(unix_seconds(), level, event, fields);
        match &self.sink {
            Sink::Standard => eprintln!("{line}"),
            Sink::Memory(lines) => lines.lock().expect("log lock").push(line),
        }
    }

    /// Writes an `info` line.
    pub fn info(&self, event: &str, fields: &[(&str, String)]) {
        self.log(Level::Info, event, fields);
    }

    /// Writes a `warn` line.
    pub fn warn(&self, event: &str, fields: &[(&str, String)]) {
        self.log(Level::Warn, event, fields);
    }

    /// Writes an `error` line.
    pub fn error(&self, event: &str, fields: &[(&str, String)]) {
        self.log(Level::Error, event, fields);
    }
}

fn unix_seconds() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|elapsed| elapsed.as_secs())
        .unwrap_or(0)
}

fn quote_if_needed(value: &str) -> String {
    let needs_quotes = value.is_empty()
        || value
            .chars()
            .any(|character| character.is_whitespace() || character == '"');
    if !needs_quotes {
        return value.to_string();
    }
    format!(
        "\"{}\"",
        value
            .replace('\\', "\\\\")
            .replace('"', "\\\"")
            .replace('\n', " ")
    )
}

/// Replaces every URL in `text` by its scheme and host. The path, the query, the fragment and any user information go,
/// because a node URL often carries a key in its path (`https://host/beacon/KEY/943`) or in its query.
///
/// A URL ends at the first space, quote, bracket, comma or closing parenthesis.
pub fn redact_urls(text: &str) -> String {
    let mut result = String::with_capacity(text.len());
    let mut rest = text;
    while let Some(start) = ["https://", "http://"]
        .iter()
        .filter_map(|scheme| rest.find(scheme))
        .min()
    {
        result.push_str(&rest[..start]);
        let url_and_after = &rest[start..];
        let end = url_and_after
            .find(|character: char| character.is_whitespace() || "\"'<>()[]{},".contains(character))
            .unwrap_or(url_and_after.len());
        let (url, after) = url_and_after.split_at(end);
        result.push_str(&origin_of(url));
        rest = after;
    }
    result.push_str(rest);
    result
}

/// The scheme and host (with a port) of a URL, without user information, path, query or fragment.
fn origin_of(url: &str) -> String {
    let (scheme, remainder) = url.split_once("://").unwrap_or(("https", url));
    let authority = remainder.split(['/', '?', '#']).next().unwrap_or_default();
    let host = authority.rsplit('@').next().unwrap_or_default();
    format!("{scheme}://{host}/...")
}

/// Builds one line. Separate from [`Logger::log`] so a test can fix the time.
pub fn format_line(timestamp: u64, level: Level, event: &str, fields: &[(&str, String)]) -> String {
    let mut line = format!("ts={timestamp} level={} event={event}", level.name());
    for (key, value) in fields {
        write!(line, " {key}={}", quote_if_needed(&redact_urls(value))).expect("write to string");
    }
    line
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Claim: a line holds the time, the level and the event, and quotes values with spaces.
    /// Why it matters: a log reader splits lines on spaces. An unquoted value with a space would shift every key after it.
    #[test]
    fn a_line_quotes_values_with_spaces() {
        let line = format_line(
            7,
            Level::Info,
            "proof_started",
            &[("reason", "no cover".into()), ("bytes", "12".into())],
        );
        assert_eq!(
            line,
            "ts=7 level=info event=proof_started reason=\"no cover\" bytes=12"
        );
        assert_eq!(
            format_line(7, Level::Warn, "retry", &[]),
            "ts=7 level=warn event=retry"
        );
    }

    /// Claim: a URL loses its path, query and user information in a log line and in the error text, for a base with a path
    /// prefix and for a base with a key segment. Why it matters: node URLs carry keys in the path, and a log is shared.
    #[test]
    fn urls_with_a_key_are_cut_to_their_host() {
        for url in [
            "https://one.example/beacon/SECRETKEY/943",
            "https://rpc.example/beacon-api/eth/v1/x?key=SECRETKEY",
            "https://user:SECRETKEY@rpc.example:8545/path",
            "http://127.0.0.1:5052/SECRETKEY",
        ] {
            let text = format!("GET {url}: status 500 (see {url}), retry");
            let redacted = redact_urls(&text);
            assert!(!redacted.contains("SECRETKEY"), "{redacted}");
            assert!(
                redacted.contains("status 500") && redacted.contains(", retry"),
                "{redacted}"
            );
            let line = format_line(1, Level::Warn, "failed", &[("url", url.to_string())]);
            assert!(!line.contains("SECRETKEY"), "{line}");
        }
        assert_eq!(
            redact_urls("a https://h.example/p/KEY b"),
            "a https://h.example/... b"
        );
        assert_eq!(redact_urls("no url here"), "no url here");
    }
}
