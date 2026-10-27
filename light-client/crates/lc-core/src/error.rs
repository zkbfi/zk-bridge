//! Error type for every verification failure in this crate.
//!
//! Each failure mode has its own variant. A guest program that fails an assertion cannot produce a proof,
//! so the variants matter mostly to tests: a test must show that it fails for the intended reason.

use crate::chain::ForkName;
use alloy_primitives::B256;
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
    /// The source block is not before the anchor block. Both ancestry paths need `source slot < anchor slot`.
    DepositNotBeforeAnchor {
        /// Slot of the anchor header.
        anchor_slot: u64,
        /// Slot of the source header.
        source_slot: u64,
    },
    /// The source era is before `capellaEra`, so no `historical_summaries` entry covers it.
    DepositBeforeCapella {
        /// `source slot / 8192`.
        source_era: u64,
        /// `capellaEra` of the chain.
        capella_era: u64,
    },
    /// A candidate position is not the position of the named field in any accepted tree shape. The bridge refuses it with
    /// `LayoutPositionInvalid`.
    LayoutPositionInvalid {
        /// The candidate generalized index.
        gindex: u64,
    },
    /// The index into `historical_summaries` does not fit under `HISTORICAL_ROOTS_LIMIT` (2^24).
    HistoricalIndexOutOfRange {
        /// `source era - capellaEra`.
        index: u64,
    },
    /// The ancestry branch does not lead from the source header root to the anchor state root. The branch is the
    /// `block_roots` branch on the recent path and the `historical_summaries` branch on the historical path.
    InvalidAncestryBranch,
    /// The anchor state has no `historical_summaries` entry for the era of the source block: the era is not complete at the
    /// anchor state.
    HistoricalSummaryMissing {
        /// The era of the source block.
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
    /// A compact (Gloas) header names the zero execution block hash in an epoch that has a block hash. The bridge reports
    /// this hash, and the contract refuses zero.
    ZeroExecutionBlockHash(&'static str),
    /// A block hash LAYOUT position was asked for a Gloas block. A Gloas body holds a bid and no payload, so it has no
    /// `execution_payload.block_hash` position. A message proof from a Gloas source reads the fixed index of the bid
    /// `parent_block_hash` instead (`layout::message_block_hash_gindex_for_fork`).
    GloasPayloadNotFinalized,
    /// The finality branch of an update has a length that names no layout. Only 6 (plain depth 5), 7 (plain depth 6)
    /// and 9 (Gloas progressive) are accepted. The length is the depth, so it also decides the layout.
    UnsupportedStateBranchLength {
        /// The number of entries in the finality branch.
        length: usize,
    },
    /// The execution branch of the named header is invalid. Full and pre-Gloas compact header: the branch does not lead to
    /// the body root. Gloas compact header: the branch does not lead from `latest_block_hash` to the state root.
    InvalidExecutionBranch(&'static str),
    /// The execution header RLP of a compact finalized header does not hash to the execution block hash that the header
    /// names. The block number comes from this RLP, so a mismatch gives no block number.
    ExecutionHeaderHashMismatch,
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
    /// The block hash branch does not lead from the keccak256 of the header to the source body root.
    InvalidBlockHashBranch,
    /// The receipt index and the transaction index of the proof differ.
    IndexMismatch {
        /// The index of the receipt.
        receipt_index: alloy_primitives::U256,
        /// The index of the transaction.
        transaction_index: alloy_primitives::U256,
    },
    /// The message names another source chain than the remote chain.
    WrongSourceChain {
        /// The remote chain of the bridge.
        expected: u64,
        /// The source chain in the message.
        actual: alloy_primitives::U256,
    },
    /// The message names another destination chain than the chain of the verifying bridge.
    WrongDestinationChain {
        /// The chain of the verifying bridge.
        expected: u64,
        /// The destination chain in the message.
        actual: alloy_primitives::U256,
    },
    /// The topic holds another message identifier than the message.
    MessageIdMismatch {
        /// The identifier in the second topic of the log.
        topic_message_id: B256,
        /// The identifier at the start of the message.
        encoded_message_id: B256,
    },
    /// The message identifier has another format version than the bridge reads.
    MessageVersionInvalid {
        /// The identifier.
        message_id: B256,
    },
    /// The message has a data type that the bridge does not send.
    UnknownDataType {
        /// The data type byte.
        data_type: u8,
    },
    /// Bytes served as SSZ break a rule of the encoding: an offset or a length is out of bounds, an offset order is wrong,
    /// or a list is longer than its limit. The text names the rule.
    MalformedSsz(String),
    /// The execution block header could not be decoded.
    HeaderDecode(String),
    /// The receipt proof does not lead to the receipts root.
    ReceiptProofInvalid(String),
    /// The transaction proof does not lead to the transactions root.
    TransactionProofInvalid(String),
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
    /// The log was not emitted by the remote bridge.
    LogEmitterMismatch,
    /// The first topic of the log is not the message event topic.
    LogTopicMismatch,
    /// The log has the message topic but not the layout of the event: its fields, its emitter or its topic count.
    LogMalformed(&'static str),
    /// The log event data is not the encoding of one `bytes` value: offset 32, the length, the bytes padded to a word.
    MalformedEventData,
    /// The message is shorter than its header says, or a chain identifier length is not 1 to 32.
    MalformedMessage,
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
            Self::GloasPayloadNotFinalized => write!(
                formatter,
                "a Gloas block body has no execution payload block hash position (a message source reads the bid parent block hash)"
            ),
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
            Self::DepositNotBeforeAnchor { anchor_slot, source_slot } => {
                write!(formatter, "source slot {source_slot} is not before anchor slot {anchor_slot}")
            }
            Self::DepositBeforeCapella { source_era, capella_era } => {
                write!(
                    formatter,
                    "source era {source_era} is before capellaEra {capella_era}; no historical summary covers it"
                )
            }
            Self::HistoricalIndexOutOfRange { index } => {
                write!(formatter, "historical summary index {index} is not below 2^24")
            }
            Self::LayoutPositionInvalid { gindex } => {
                write!(formatter, "generalized index {gindex} is not the position of the named field")
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
            Self::ExecutionHeaderHashMismatch => {
                write!(formatter, "the execution header RLP does not hash to the execution block hash of the finalized header")
            }
            Self::ZeroExecutionBlockHash(which) => {
                write!(formatter, "the {which} header names a zero execution block hash")
            }
            Self::UnsupportedStateBranchLength { length } => {
                write!(formatter, "a finality branch of {length} entries names no layout; only 6, 7 and 9 are accepted")
            }
            Self::InvalidPublicKey { index } => write!(formatter, "public key {index} is not a valid point"),
            Self::InvalidSignatureEncoding => write!(formatter, "signature is not a valid point"),
            Self::SignatureVerificationFailed => write!(formatter, "aggregate signature verification failed"),
            Self::AnchorNotStored => {
                write!(formatter, "the anchor header is not the stored finalized header of its slot")
            }
            Self::InvalidBlockHashBranch => write!(formatter, "block hash branch does not match the source body root"),
            Self::IndexMismatch { receipt_index, transaction_index } => {
                write!(formatter, "receipt index {receipt_index} differs from transaction index {transaction_index}")
            }
            Self::WrongSourceChain { expected, actual } => {
                write!(formatter, "the message names source chain {actual}, the remote chain is {expected}")
            }
            Self::WrongDestinationChain { expected, actual } => {
                write!(formatter, "the message names destination chain {actual}, this chain is {expected}")
            }
            Self::MessageIdMismatch { topic_message_id, encoded_message_id } => {
                write!(
                    formatter,
                    "the topic holds message identifier {topic_message_id}, the message {encoded_message_id}"
                )
            }
            Self::MessageVersionInvalid { message_id } => {
                write!(formatter, "message identifier {message_id} has another format version than 0x00050000")
            }
            Self::UnknownDataType { data_type } => write!(formatter, "unknown message data type 0x{data_type:02x}"),
            Self::MalformedSsz(reason) => write!(formatter, "malformed SSZ: {reason}"),
            Self::HeaderDecode(reason) => write!(formatter, "cannot decode execution header: {reason}"),
            Self::ReceiptProofInvalid(reason) => write!(formatter, "receipt proof invalid: {reason}"),
            Self::TransactionProofInvalid(reason) => write!(formatter, "transaction proof invalid: {reason}"),
            Self::ReceiptDecode(reason) => write!(formatter, "cannot decode receipt: {reason}"),
            Self::ReceiptFailed => write!(formatter, "the receipt reports a failed transaction"),
            Self::LogIndexOutOfRange { index, logs } => {
                write!(formatter, "log index {index} is out of range, the receipt has {logs} logs")
            }
            Self::LogEmitterMismatch => write!(formatter, "the log was not emitted by the remote bridge"),
            Self::LogTopicMismatch => write!(formatter, "the log topic is not the message event topic"),
            Self::LogMalformed(reason) => write!(formatter, "malformed message log: {reason}"),
            Self::MalformedEventData => write!(formatter, "the log event data is not the encoding of one bytes value"),
            Self::MalformedMessage => write!(formatter, "the message is shorter than its header says"),
        }
    }
}

impl Error {
    /// A stable code for the failure, used as the expected rejection reason in the message fixtures.
    pub fn reason_code(&self) -> &'static str {
        match self {
            Self::AnchorNotStored => "AnchorNotStored",
            Self::DepositNotBeforeAnchor { .. } => "DepositNotBeforeAnchor",
            Self::DepositBeforeCapella { .. } => "DepositBeforeCapella",
            Self::HistoricalIndexOutOfRange { .. } => "HistoricalIndexOutOfRange",
            Self::LayoutPositionInvalid { .. } => "LayoutPositionInvalid",
            Self::InvalidAncestryBranch => "InvalidAncestryBranch",
            Self::InvalidBlockHashBranch => "InvalidBlockHashBranch",
            Self::UnsupportedFork { .. } => "UnsupportedFork",
            Self::GloasPayloadNotFinalized => "GloasPayloadNotFinalized",
            Self::MalformedSsz(_) => "MalformedSsz",
            Self::HeaderDecode(_) => "HeaderDecode",
            Self::ReceiptProofInvalid(_) => "ReceiptProofInvalid",
            Self::TransactionProofInvalid(_) => "TransactionProofInvalid",
            Self::ReceiptDecode(_) => "ReceiptDecode",
            Self::ReceiptFailed => "ReceiptFailed",
            Self::LogIndexOutOfRange { .. } => "LogIndexOutOfRange",
            Self::LogEmitterMismatch => "LogEmitterMismatch",
            Self::LogTopicMismatch => "LogTopicMismatch",
            Self::LogMalformed(_) => "LogMalformed",
            Self::MalformedEventData => "MalformedEventData",
            Self::MalformedMessage => "MalformedMessage",
            Self::IndexMismatch { .. } => "IndexMismatch",
            Self::WrongSourceChain { .. } => "WrongSourceChain",
            Self::WrongDestinationChain { .. } => "WrongDestinationChain",
            Self::MessageIdMismatch { .. } => "MessageIdMismatch",
            Self::MessageVersionInvalid { .. } => "MessageVersionInvalid",
            Self::UnknownDataType { .. } => "UnknownDataType",
            Self::SignatureInNextPeriodWithoutCrossing => "SignatureInNextPeriodWithoutCrossing",
            _ => "LightClientUpdateRejected",
        }
    }
}

impl std::error::Error for Error {}

/// Result alias for this crate.
pub type Result<T> = core::result::Result<T, Error>;
