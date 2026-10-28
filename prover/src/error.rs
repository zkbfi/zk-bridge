//! One error type for the whole crate.

use alloy_primitives::{hex, Bytes};
use lc_core::chain::ForkName;
use lc_core::types::HeaderForm;
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
    /// The fork schedule and the chain specification of the beacon node disagree about one fork. The prover does not
    /// guess which answer is right.
    ///
    /// `fork` names the fork, or the version when the specification has no fork with it. An epoch of `u64::MAX` means
    /// that the answer does not list the fork.
    ForkScheduleMismatch {
        /// The fork, or the version, that the two answers disagree about.
        fork: String,
        /// The epoch that the fork schedule gives.
        schedule_epoch: u64,
        /// The epoch that the chain specification gives.
        spec_epoch: u64,
    },
    /// The fork that is active at an epoch is not one the prover knows (for example a fork newer than Gloas). The prover
    /// cannot choose an anchor for it, so it stops.
    UnknownActiveFork {
        /// The version of the active fork.
        version: [u8; 4],
        /// The first epoch of the active fork.
        epoch: u64,
    },
    /// The form of a light-client header that the beacon node served does not match the fork of its slot, or the padding
    /// of a pre-Gloas header inside a Gloas update is not the padding that the specification writes.
    HeaderFormMismatch {
        /// The slot of the header.
        slot: u64,
        /// The fork of that slot.
        fork: ForkName,
        /// The form that the node served.
        form: HeaderForm,
        /// The length of the execution branch that the node served.
        branch_length: usize,
    },
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
            Self::ForkScheduleMismatch {
                fork,
                schedule_epoch,
                spec_epoch,
            } => write!(
                formatter,
                "the fork schedule and the chain specification of the beacon node disagree about {fork}: the schedule says epoch {schedule_epoch}, the specification says epoch {spec_epoch}"
            ),
            Self::UnknownActiveFork { version, epoch } => write!(
                formatter,
                "the active fork with version 0x{} from epoch {epoch} is not known to this prover; update the prover",
                hex::encode(version)
            ),
            Self::HeaderFormMismatch {
                slot,
                fork,
                form,
                branch_length,
            } => write!(
                formatter,
                "the {form:?} header at slot {slot} ({fork:?}) has an execution branch of {branch_length} entries that does not fit the form that the fork needs"
            ),
        }
    }
}

impl std::error::Error for Error {}
