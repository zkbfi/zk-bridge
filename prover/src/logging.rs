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

    /// Writes one line.
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

/// Builds one line. Separate from [`Logger::log`] so a test can fix the time.
pub fn format_line(timestamp: u64, level: Level, event: &str, fields: &[(&str, String)]) -> String {
    let mut line = format!("ts={timestamp} level={} event={event}", level.name());
    for (key, value) in fields {
        write!(line, " {key}={}", quote_if_needed(value)).expect("write to string");
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
}
