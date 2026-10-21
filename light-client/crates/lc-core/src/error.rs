//! Error type for every verification failure in this crate.
//!
//! Each failure mode has its own variant. A guest program that fails an assertion cannot produce a proof,
//! so the variants matter mostly to tests: a test must show that it fails for the intended reason.

use crate::chain::ForkName;
use core::fmt;

/// A verification failure.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Error {
    /// Fewer than two thirds of the sync committee signed.
    InsufficientParticipation {
        /// Number of set bits in the participation bit vector.
        participants: usize,
    },
    /// A sync committee does not hold exactly 512 public keys.
    InvalidSyncCommitteeSize {
        /// Number of public keys found.
        actual: usize,
    },
    /// The slots of the update are not in the required order.
    InvalidSlotOrder(&'static str),
    /// The fork at a slot has no supported light-client layout.
    UnsupportedFork {
        /// The fork that is not supported.
        fork: ForkName,
    },
    /// The execution payload header fields do not match the fork of the header slot.
    ExecutionHeaderForkMismatch {
        /// The fork at the beacon header slot.
        fork: ForkName,
    },
    /// The update does not move the finalized head forward, or finalizes the genesis slot.
    NotFinalizedProgress(&'static str),
    /// The signature period or the new head period lies outside the allowed window.
    PeriodOutOfRange(&'static str),
    /// The signature period is the period after the stored head, but the finalized header stays in the stored period.
    /// The signing committee would be the private next committee of the store, which no output field binds.
    SignatureInNextPeriodWithoutCrossing,
    /// The store has no next sync committee but the update needs it.
    NextSyncCommitteeUnknown,
    /// The next sync committee in the update differs from the one in the store.
    NextSyncCommitteeMismatch,
    /// The finality branch does not lead from the finalized header root to the attested state root.
    InvalidFinalityBranch,
    /// The next sync committee branch does not lead to the attested state root.
    InvalidNextSyncCommitteeBranch,
    /// The current sync committee branch does not lead to the state root of the bootstrap header.
    InvalidCurrentSyncCommitteeBranch,
    /// The deposit block is not before the anchor block. Both ancestry paths need `deposit slot < anchor slot`.
    DepositNotBeforeAnchor {
        /// Slot of the anchor header.
        anchor_slot: u64,
        /// Slot of the deposit header.
        deposit_slot: u64,
    },
    /// The deposit era is before `capellaEra`, so no `historical_summaries` entry covers it.
    DepositBeforeCapella {
        /// `deposit slot / 8192`.
        deposit_era: u64,
        /// `capellaEra` of the chain.
        capella_era: u64,
    },
    /// The index into `historical_summaries` does not fit under `HISTORICAL_ROOTS_LIMIT` (2^24).
    HistoricalIndexOutOfRange {
        /// `deposit era - capellaEra`.
        index: u64,
    },
    /// The ancestry branch does not lead from the deposit header root to the anchor state root. The branch is the
    /// `block_roots` branch on the recent path and the `historical_summaries` branch on the historical path.
    InvalidAncestryBranch,
    /// The anchor state has no `historical_summaries` entry for the era of the deposit: the era is not complete at the
    /// anchor state.
    HistoricalSummaryMissing {
        /// The era of the deposit.
        era: u64,
        /// The number of entries in `historical_summaries` of the anchor state.
        summaries: u64,
    },
    /// The 8192 block roots built for an era do not hash to the `block_summary_root` of the anchor state.
    EraRootsMismatch {
        /// The era.
        era: u64,
    },
    /// No canonical block at or before the first slot of the era is known, so the roots of the empty first slots
    /// cannot be filled.
    NoBlockBeforeEra {
        /// The era.
        era: u64,
    },
    /// A fold must hold 1 to 64 updates.
    FoldLengthOutOfRange {
        /// Number of updates given.
        count: usize,
    },
    /// The execution payload branch does not lead to the body root of the named header.
    InvalidExecutionBranch(&'static str),
    /// A public key is not a valid, non-identity point in the right subgroup.
    InvalidPublicKey {
        /// Position of the key in the participant list.
        index: usize,
    },
    /// The signature bytes are not a valid point in the right subgroup.
    InvalidSignatureEncoding,
    /// The aggregate signature does not match the signing root.
    SignatureVerificationFailed,
    /// The anchor header is not the finalized header the light client stores for its slot.
    AnchorNotStored,
    /// The block hash branch does not lead from the keccak256 of the header to the deposit body root.
    InvalidBlockHashBranch,
    /// The deposit targets another chain than the one that verifies the withdrawal.
    TargetChainMismatch {
        /// The target chain in the log.
        target_chain_id: u64,
    },
    /// The execution block header could not be decoded.
    HeaderDecode(String),
    /// The receipt proof does not lead to the receipts root.
    ReceiptProofInvalid(String),
    /// The receipt bytes could not be decoded.
    ReceiptDecode(String),
    /// The receipt reports a failed transaction.
    ReceiptFailed,
    /// The log index is past the end of the receipt log list.
    LogIndexOutOfRange {
        /// The requested index.
        index: u64,
        /// The number of logs in the receipt.
        logs: usize,
    },
    /// The log was not emitted by the expected vault.
    LogEmitterMismatch,
    /// The first topic of the log is not the deposit event topic.
    LogTopicMismatch,
    /// The log has the right topic but its fields do not decode as a deposit.
    LogDecode(String),
}

impl fmt::Display for Error {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::InsufficientParticipation { participants } => {
                write!(formatter, "only {participants} of 512 sync committee members signed; at least 342 are required")
            }
            Self::InvalidSyncCommitteeSize { actual } => {
                write!(formatter, "sync committee has {actual} public keys, expected 512")
            }
            Self::InvalidSlotOrder(reason) => write!(formatter, "invalid slot order: {reason}"),
            Self::UnsupportedFork { fork } => write!(formatter, "unsupported fork for light-client proofs: {fork:?}"),
            Self::ExecutionHeaderForkMismatch { fork } => {
                write!(formatter, "execution payload header fields do not match fork {fork:?}")
            }
            Self::NotFinalizedProgress(reason) => {
                write!(formatter, "update does not advance the finalized head: {reason}")
            }
            Self::PeriodOutOfRange(reason) => write!(formatter, "sync committee period out of range: {reason}"),
            Self::SignatureInNextPeriodWithoutCrossing => write!(
                formatter,
                "the signature period is after the stored head period but the finalized header does not cross into it"
            ),
            Self::NextSyncCommitteeUnknown => write!(formatter, "the store does not know the next sync committee"),
            Self::NextSyncCommitteeMismatch => write!(formatter, "update next sync committee differs from the store"),
            Self::InvalidFinalityBranch => write!(formatter, "finality branch does not match the attested state root"),
            Self::InvalidNextSyncCommitteeBranch => {
                write!(formatter, "next sync committee branch does not match the attested state root")
            }
            Self::InvalidCurrentSyncCommitteeBranch => {
                write!(formatter, "current sync committee branch does not match the header state root")
            }
            Self::DepositNotBeforeAnchor { anchor_slot, deposit_slot } => {
                write!(formatter, "deposit slot {deposit_slot} is not before anchor slot {anchor_slot}")
            }
            Self::DepositBeforeCapella { deposit_era, capella_era } => {
                write!(
                    formatter,
                    "deposit era {deposit_era} is before capellaEra {capella_era}; no historical summary covers it"
                )
            }
            Self::HistoricalIndexOutOfRange { index } => {
                write!(formatter, "historical summary index {index} is not below 2^24")
            }
            Self::InvalidAncestryBranch => write!(formatter, "ancestry branch does not match the anchor state root"),
            Self::HistoricalSummaryMissing { era, summaries } => write!(
                formatter,
                "the anchor state has {summaries} historical summaries, none for era {era}: the era is not complete"
            ),
            Self::EraRootsMismatch { era } => write!(
                formatter,
                "the block roots built for era {era} do not hash to the block summary root of the anchor state"
            ),
            Self::NoBlockBeforeEra { era } => {
                write!(formatter, "no canonical block at or before the first slot of era {era} is known")
            }
            Self::FoldLengthOutOfRange { count } => {
                write!(formatter, "a fold holds 1 to 64 updates, got {count}")
            }
            Self::InvalidExecutionBranch(which) => {
                write!(formatter, "execution branch of the {which} header is invalid")
            }
            Self::InvalidPublicKey { index } => write!(formatter, "public key {index} is not a valid point"),
            Self::InvalidSignatureEncoding => write!(formatter, "signature is not a valid point"),
            Self::SignatureVerificationFailed => write!(formatter, "aggregate signature verification failed"),
            Self::AnchorNotStored => {
                write!(formatter, "the anchor header is not the stored finalized header of its slot")
            }
            Self::InvalidBlockHashBranch => write!(formatter, "block hash branch does not match the deposit body root"),
            Self::TargetChainMismatch { target_chain_id } => {
                write!(formatter, "the deposit targets chain {target_chain_id}, not this chain")
            }
            Self::HeaderDecode(reason) => write!(formatter, "cannot decode execution header: {reason}"),
            Self::ReceiptProofInvalid(reason) => write!(formatter, "receipt proof invalid: {reason}"),
            Self::ReceiptDecode(reason) => write!(formatter, "cannot decode receipt: {reason}"),
            Self::ReceiptFailed => write!(formatter, "the receipt reports a failed transaction"),
            Self::LogIndexOutOfRange { index, logs } => {
                write!(formatter, "log index {index} is out of range, the receipt has {logs} logs")
            }
            Self::LogEmitterMismatch => write!(formatter, "the log was not emitted by the expected vault"),
            Self::LogTopicMismatch => write!(formatter, "the log topic is not the deposit event topic"),
            Self::LogDecode(reason) => write!(formatter, "cannot decode deposit log: {reason}"),
        }
    }
}

impl Error {
    /// A stable code for the failure, used as the expected rejection reason in the withdrawal fixtures.
    pub fn reason_code(&self) -> &'static str {
        match self {
            Self::AnchorNotStored => "AnchorNotStored",
            Self::DepositNotBeforeAnchor { .. } => "DepositNotBeforeAnchor",
            Self::DepositBeforeCapella { .. } => "DepositBeforeCapella",
            Self::HistoricalIndexOutOfRange { .. } => "HistoricalIndexOutOfRange",
            Self::InvalidAncestryBranch => "InvalidAncestryBranch",
            Self::InvalidBlockHashBranch => "InvalidBlockHashBranch",
            Self::UnsupportedFork { .. } => "UnsupportedFork",
            Self::HeaderDecode(_) => "HeaderDecode",
            Self::ReceiptProofInvalid(_) => "ReceiptProofInvalid",
            Self::ReceiptDecode(_) => "ReceiptDecode",
            Self::ReceiptFailed => "ReceiptFailed",
            Self::LogIndexOutOfRange { .. } => "LogIndexOutOfRange",
            Self::LogEmitterMismatch => "LogEmitterMismatch",
            Self::LogTopicMismatch => "LogTopicMismatch",
            Self::LogDecode(_) => "LogDecode",
            Self::TargetChainMismatch { .. } => "TargetChainMismatch",
            Self::SignatureInNextPeriodWithoutCrossing => "SignatureInNextPeriodWithoutCrossing",
            _ => "LightClientUpdateRejected",
        }
    }
}

impl std::error::Error for Error {}

/// Result alias for this crate.
pub type Result<T> = core::result::Result<T, Error>;
