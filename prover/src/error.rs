//! One error type for the whole crate.

use alloy_primitives::{hex, Bytes};
use std::fmt;

/// A failure anywhere in the crate.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Error {
    /// The configuration is invalid. The text names the key.
    Config(String),
    /// A secret was supplied in a way the crate refuses (for example in the configuration file).
    SecretHandling(String),
    /// The oracle key could not be read.
    Signer(String),
    /// An HTTP request failed before a JSON-RPC answer arrived.
    Http(String),
    /// A JSON-RPC node answered with an error object.
    Rpc {
        /// The JSON-RPC error code.
        code: i64,
        /// The message of the node.
        message: String,
        /// The revert data of a failed call, when the node returns it.
        data: Option<Bytes>,
    },
    /// A node answer has an unexpected shape.
    Malformed(String),
    /// A beacon data source could not give what the caller asked for.
    Beacon(String),
    /// Native verification refused the statement. No signature or transaction follows.
    VerificationRefused(String),
    /// The proving backend cannot prove this statement.
    Prover(String),
    /// The webhook refused the result, or no answer arrived.
    Handoff(String),
    /// An input of a command line subcommand is wrong.
    Usage(String),
}

/// The result type of the crate.
pub type Result<T> = std::result::Result<T, Error>;

impl fmt::Display for Error {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Config(reason) => write!(formatter, "configuration: {reason}"),
            Self::SecretHandling(reason) => write!(formatter, "secret handling: {reason}"),
            Self::Signer(reason) => write!(formatter, "signer: {reason}"),
            Self::Http(reason) => write!(formatter, "http: {reason}"),
            Self::Rpc {
                code,
                message,
                data,
            } => match data {
                Some(data) => write!(
                    formatter,
                    "rpc error {code}: {message} (data 0x{})",
                    hex::encode(data)
                ),
                None => write!(formatter, "rpc error {code}: {message}"),
            },
            Self::Malformed(reason) => write!(formatter, "malformed answer: {reason}"),
            Self::Beacon(reason) => write!(formatter, "beacon: {reason}"),
            Self::VerificationRefused(reason) => {
                write!(formatter, "verification refused: {reason}")
            }
            Self::Prover(reason) => write!(formatter, "prover: {reason}"),
            Self::Handoff(reason) => write!(formatter, "handoff: {reason}"),
            Self::Usage(reason) => write!(formatter, "usage: {reason}"),
        }
    }
}

impl std::error::Error for Error {}
