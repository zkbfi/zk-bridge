//! Structured logs: one line per event, `key=value` pairs, and the deposit nonce in every line.
//!
//! A line that has no deposit (for example the start of a pass) carries `nonce=none`, so a reader can filter on
//! the key without a special case. Values with spaces are quoted. The service never logs a key, a password or a
//! full request body.

use alloy_primitives::B256;
use std::fmt::Write as _;
use std::sync::{Arc, Mutex};
use std::time::{SystemTime, UNIX_EPOCH};

/// The severity of a line.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Level {
    /// Normal progress.
    Info,
    /// Something went wrong and the service retries later.
    Warn,
    /// Something went wrong and the service gives up on a deposit.
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
        Self { sink: Sink::Standard }
    }

    /// A logger that keeps lines in memory. The second value gives the lines written so far.
    pub fn in_memory() -> (Self, Arc<Mutex<Vec<String>>>) {
        let lines = Arc::new(Mutex::new(Vec::new()));
        (Self { sink: Sink::Memory(lines.clone()) }, lines)
    }

    /// Writes one line.
    ///
    /// `nonce` is the deposit nonce, or `None` for a line that belongs to no deposit.
    pub fn log(&self, level: Level, event: &str, nonce: Option<B256>, fields: &[(&str, String)]) {
        let line = format_line(unix_seconds(), level, event, nonce, fields);
        match &self.sink {
            Sink::Standard => eprintln!("{line}"),
            Sink::Memory(lines) => lines.lock().expect("log lock").push(line),
        }
    }

    /// Writes an `info` line.
    pub fn info(&self, event: &str, nonce: Option<B256>, fields: &[(&str, String)]) {
        self.log(Level::Info, event, nonce, fields);
    }

    /// Writes a `warn` line.
    pub fn warn(&self, event: &str, nonce: Option<B256>, fields: &[(&str, String)]) {
        self.log(Level::Warn, event, nonce, fields);
    }

    /// Writes an `error` line.
    pub fn error(&self, event: &str, nonce: Option<B256>, fields: &[(&str, String)]) {
        self.log(Level::Error, event, nonce, fields);
    }
}

fn unix_seconds() -> u64 {
    SystemTime::now().duration_since(UNIX_EPOCH).map(|elapsed| elapsed.as_secs()).unwrap_or(0)
}

fn quote_if_needed(value: &str) -> String {
    let needs_quotes = value.is_empty() || value.chars().any(|character| character.is_whitespace() || character == '"');
    if !needs_quotes {
        return value.to_string();
    }
    format!("\"{}\"", value.replace('\\', "\\\\").replace('"', "\\\"").replace('\n', " "))
}

/// Builds one line. Separate from [`Logger::log`] so a test can fix the time.
pub fn format_line(
    timestamp: u64,
    level: Level,
    event: &str,
    nonce: Option<B256>,
    fields: &[(&str, String)],
) -> String {
    let mut line = format!("ts={timestamp} level={} event={event}", level.name());
    match nonce {
        Some(nonce) => write!(line, " nonce={nonce:#x}").expect("write to string"),
        None => line.push_str(" nonce=none"),
    }
    for (key, value) in fields {
        write!(line, " {key}={}", quote_if_needed(value)).expect("write to string");
    }
    line
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Claim: a line holds the nonce key whether or not a deposit exists, and quotes values with spaces.
    /// Why it matters: a log reader filters on `nonce=` and must not meet a line without the key.
    #[test]
    fn every_line_has_a_nonce_key_and_quotes_spaces() {
        let with = format_line(7, Level::Info, "deposit_state", Some(B256::repeat_byte(0xab)), &[("reason", "no cover".into())]);
        assert_eq!(with, format!("ts=7 level=info event=deposit_state nonce={:#x} reason=\"no cover\"", B256::repeat_byte(0xab)));
        let without = format_line(7, Level::Warn, "pass_started", None, &[]);
        assert_eq!(without, "ts=7 level=warn event=pass_started nonce=none");
    }
}
