//! The only module of the library that calls `lc-core`.
//!
//! Everything a light-client update or a message proof needs comes from `lc-core`: the JSON parsers, the receipts trie,
//! the execution header encoder, the SSZ state parser, and the ancestry builders for both paths.

use crate::error::{Error, Result};
use alloy_primitives::{Address, Bytes, B256, U256};
use alloy_sol_types::{SolCall, SolValue};
use lc_core::abi::{executeMessageCall, BeaconBlockHeader as AbiHeader, MessageProof};
use lc_core::chain::{
    ChainSpec, ForkName, ETHEREUM_MAINNET, PULSECHAIN, PULSECHAIN_TESTNET_V4, SEPOLIA,
};
use lc_core::execution::Log;
use lc_core::json::{execution_header_from_json, receipts_from_json};
use lc_core::message::{
    decode_message, message_of_log, verify_message, MessageContext, MessageHeader, VerifiedMessage,
};
use lc_core::receipts::{build_indexed_trie, encode_execution_header, header_hash};
use lc_core::ssz::{branch_for_leaf, u64_chunk};
use lc_core::ssz_state::{
    state_slot, try_parse_signed_block, try_parse_state_for_fork, ParsedState, StateForm,
};
use lc_core::types::{
    BeaconBlockHeader, ExecutionPayloadHeader, LightClientHeader, NextSyncCommittee, SyncCommittee,
};
use lc_core::update::FoldStep;
use lc_core::wire::{encode_guest_input, ChainSelector, GuestInput};
use serde_json::Value;
use std::collections::BTreeMap;
use std::panic::{catch_unwind, AssertUnwindSafe};

pub use lc_core::abi::LightClientOutput;
pub use lc_core::ancestry::AncestryPath;
pub use lc_core::layout::SLOTS_PER_HISTORICAL_ROOT;
pub use lc_core::ssz_state::ForkData;
pub use lc_core::types::BeaconBlockHeader as BeaconHeader;
pub use lc_core::types::{LightClientStore, LightClientUpdate, SyncAggregate};

/// The topic 0 of `UserRequestForAffirmation`, derived from the event declaration in `lc-core`.
pub const USER_REQUEST_TOPIC: B256 = lc_core::abi::USER_REQUEST_TOPIC;

/// Which chain configuration of `lc-core` applies.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ChainKind {
    /// Ethereum mainnet.
    Ethereum,
    /// PulseChain.
    Pulsechain,
    /// Sepolia (chain identifier 11155111). It runs the Gloas fork from epoch 353024. A Gloas finalized header needs the
    /// state and the execution header RLP of `state.latest_block_hash`: see [`anchor_gloas_header`]. A message proof from
    /// a Gloas source block is refused.
    Sepolia,
    /// PulseChain testnet v4 (chain identifier 943). It stopped at Capella, like PulseChain.
    PulsechainTestnetV4,
}

impl ChainKind {
    /// Every chain kind, in the order of the documentation.
    pub const ALL: [ChainKind; 4] = [
        Self::Ethereum,
        Self::Pulsechain,
        Self::Sepolia,
        Self::PulsechainTestnetV4,
    ];

    /// The `lc-core` chain specification.
    pub fn spec(self) -> &'static ChainSpec {
        match self {
            Self::Ethereum => &ETHEREUM_MAINNET,
            Self::Pulsechain => &PULSECHAIN,
            Self::Sepolia => &SEPOLIA,
            Self::PulsechainTestnetV4 => &PULSECHAIN_TESTNET_V4,
        }
    }

    fn selector(self) -> ChainSelector {
        match self {
            Self::Ethereum => ChainSelector::EthereumMainnet,
            Self::Pulsechain => ChainSelector::Pulsechain,
            Self::Sepolia => ChainSelector::Sepolia,
            Self::PulsechainTestnetV4 => ChainSelector::PulsechainTestnetV4,
        }
    }

    /// The seconds between two slots.
    pub fn seconds_per_slot(self) -> u64 {
        self.spec().seconds_per_slot
    }

    /// The name of the chain in the configuration file and on the command line.
    pub fn name(self) -> &'static str {
        match self {
            Self::Ethereum => "ethereum",
            Self::Pulsechain => "pulsechain",
            Self::Sepolia => "sepolia",
            Self::PulsechainTestnetV4 => "pulsechain-testnet-v4",
        }
    }

    /// The chain with this name in the configuration (see [`ChainKind::name`]), or `None`.
    pub fn from_name(name: &str) -> Option<Self> {
        Self::ALL.into_iter().find(|kind| kind.name() == name)
    }

    /// The names of all chains, as one text for an error message: `ethereum, pulsechain, ...`.
    pub fn known_names() -> String {
        Self::ALL
            .iter()
            .map(|kind| kind.name())
            .collect::<Vec<_>>()
            .join(", ")
    }

    /// Like [`ChainKind::from_name`], but an unknown name is an error that lists the known names.
    ///
    /// # Errors
    /// `Error::Config` with the unknown name and the list of known names.
    pub fn parse(name: &str) -> Result<Self> {
        Self::from_name(name).ok_or_else(|| {
            Error::Config(format!(
                "unknown chain `{name}`; the known chains are {}",
                Self::known_names()
            ))
        })
    }
}

/// Runs a builder that panics on malformed input and turns a panic into an error.
fn guarded<T>(what: &str, work: impl FnOnce() -> T) -> Result<T> {
    catch_unwind(AssertUnwindSafe(work)).map_err(|panic| {
        let reason = panic
            .downcast_ref::<String>()
            .cloned()
            .or_else(|| panic.downcast_ref::<&str>().map(|text| (*text).to_string()))
            .unwrap_or_else(|| "unknown".into());
        Error::Malformed(format!("{what}: {reason}"))
    })
}

// ------------------------------------------------------------------ light-client updates

/// Everything the light-client program reads: a store and a list of 1 to 64 updates.
#[derive(Clone, Debug)]
pub struct UpdateInput {
    /// The chain of the beacon data.
    pub chain: ChainKind,
    /// The store before the first update (a private input of the program).
    pub store: LightClientStore,
    /// The updates, applied in order.
    pub updates: Vec<LightClientUpdate>,
}

/// Runs the light-client program natively and returns its public output.
///
/// Calls `lc_core::update::verify_light_client_fold`. It checks, for each update, the participation threshold, the
/// aggregate signature, the committee, the finality branch and the execution branch.
///
/// # Errors
/// `Error::VerificationRefused` with the rule that failed.
pub fn verify_update_natively(input: &UpdateInput) -> Result<LightClientOutput> {
    lc_core::update::verify_light_client_fold(&input.store, &input.updates, input.chain.spec())
        .map(|(output, _)| output)
        .map_err(|error| Error::VerificationRefused(error.to_string()))
}

/// Runs the light-client program natively on its guest input bytes and returns its public values.
///
/// Calls `lc_core::wire::run_light_client_guest`, the same function the SP1 guest wraps. A worker uses it, because it
/// receives the input bytes and not an [`UpdateInput`].
///
/// # Errors
/// `Error::VerificationRefused` with the rule that failed. No proof exists for such an input.
pub fn verify_light_client_natively(guest_input: &[u8]) -> Result<Vec<u8>> {
    lc_core::wire::run_light_client_guest(guest_input)
        .map_err(|error| Error::VerificationRefused(error.to_string()))
}

/// Runs the fork observation program natively on its guest input bytes and returns its public values.
///
/// Calls `lc_core::wire::run_fork_observation_guest`, the same function the SP1 guest wraps. It checks the fold
/// steps, the participation threshold and the committee signature under the fork version that the input names.
///
/// # Errors
/// `Error::VerificationRefused` with the rule that failed. No proof exists for such an input.
pub fn verify_observation_natively(guest_input: &[u8]) -> Result<Vec<u8>> {
    lc_core::wire::run_fork_observation_guest(guest_input)
        .map_err(|error| Error::VerificationRefused(error.to_string()))
}

/// The public values of the program: the ABI encoding of the output. The contract decodes these bytes.
pub fn public_values(output: &LightClientOutput) -> Vec<u8> {
    output.abi_encode()
}

/// The input bytes that an SP1 guest reads (used by the `sp1` backend).
///
/// Calls `lc_core::wire::encode_guest_input` with the fork version of each step from the fork schedule of the chain.
///
/// The schedule is read only to BUILD the input. The program takes the version as a private input and trusts nothing
/// about it: the committee signs a domain that contains the version, so a wrong value fails the signature check. The
/// program reads no fork table, so a fork that keeps an accepted layout needs no new program.
pub fn guest_input_bytes(input: &UpdateInput) -> Vec<u8> {
    let spec = input.chain.spec();
    let steps = input
        .updates
        .iter()
        .map(|update| FoldStep {
            update: update.clone(),
            fork_version: lc_core::update::table_fork_version(spec, update.signature_slot),
        })
        .collect();
    encode_guest_input(&GuestInput {
        chain: input.chain.selector(),
        store: input.store.clone(),
        steps,
    })
}

/// Parses the `data` object of a beacon API light-client update or finality update.
///
/// # Errors
/// `Error::Malformed` when the object lacks a field.
pub fn update_from_json(data: &Value) -> Result<LightClientUpdate> {
    guarded("light-client update", || {
        lc_core::json::light_client_update(data)
    })
}

/// The hash tree root of a sync committee, as the contract stores it.
///
/// # Errors
/// `Error::Malformed` when the committee does not hold 512 keys.
pub fn committee_hash(committee: &SyncCommittee) -> Result<B256> {
    committee
        .hash_tree_root()
        .map_err(|error| Error::Malformed(error.to_string()))
}

/// The hash tree root of a beacon header.
pub fn header_root(header: &BeaconBlockHeader) -> B256 {
    header.hash_tree_root()
}

/// A header from the JSON object of the beacon API (`slot`, `proposer_index`, `parent_root`, ...).
///
/// # Errors
/// `Error::Malformed` when a field is missing.
pub fn beacon_header_from_json(value: &Value) -> Result<BeaconBlockHeader> {
    guarded("beacon header", || lc_core::json::beacon_header(value))
}

/// Converts a header into the struct that the layout calls take.
pub fn to_layout_header(header: &BeaconBlockHeader) -> crate::contracts::LayoutHeader {
    crate::contracts::LayoutHeader {
        slot: header.slot,
        proposerIndex: header.proposer_index,
        parentRoot: header.parent_root,
        stateRoot: header.state_root,
        bodyRoot: header.body_root,
    }
}

// ------------------------------------------------------------------ messages

/// The source message that a log carries: the fields of the message and its call data.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct SourceMessage {
    /// The fields of the message: identifier, sender, target, gas, data type and chains.
    pub header: MessageHeader,
    /// The call data for the target.
    pub data: Bytes,
}

/// Decodes a `UserRequestForAffirmation` log of the source bridge into its message.
///
/// Calls the log checks of `lc-core`, the same ones that the destination bridge runs: the emitter, the topic 0, the two
/// topics, the event data, the message decoding and the identifier in the topic.
///
/// # Errors
/// `Error::Malformed` when the log is not a well formed message log of `remote_bridge`.
pub fn decode_message_log(
    address: Address,
    topics: &[B256],
    data: &[u8],
    remote_bridge: Address,
) -> Result<SourceMessage> {
    let log = Log {
        address,
        topics: topics.to_vec(),
        data: Bytes::copy_from_slice(data),
    };
    let malformed = |error: lc_core::Error| Error::Malformed(format!("message log: {error}"));
    let (topic_message_id, encoded) = message_of_log(&log, remote_bridge).map_err(malformed)?;
    let (header, data) = decode_message(&encoded).map_err(malformed)?;
    if header.message_id != topic_message_id {
        return Err(Error::Malformed(
            "message log: the identifier in the topic differs from the identifier in the message"
                .into(),
        ));
    }
    Ok(SourceMessage { header, data })
}

/// The beacon part of a message proof.
#[derive(Clone, Debug)]
pub struct BeaconPath {
    /// A finalized header that the destination light client stores.
    pub anchor_header: BeaconBlockHeader,
    /// The beacon block that carries the source block.
    pub source_header: BeaconBlockHeader,
    /// Branch from the source header root to the anchor state root.
    pub ancestry_branch: Vec<B256>,
    /// Branch from the execution block hash to the source body root.
    pub block_hash_branch: Vec<B256>,
}

/// The execution part of a message proof.
#[derive(Clone, Debug)]
pub struct ExecutionEvidence {
    /// RLP of the execution block header.
    pub header_rlp: Bytes,
    /// Its keccak256: the execution block hash.
    pub block_hash: B256,
    /// Merkle-Patricia nodes from the receipts root to the receipt.
    pub receipt_proof: Vec<Bytes>,
    /// Merkle-Patricia nodes from the transactions root to the transaction at the index of the receipt.
    pub transaction_proof: Vec<Bytes>,
}

/// An execution header that the crate rebuilt from a node answer and checked against the hash that the node reports.
#[derive(Clone, Debug)]
pub struct RebuiltHeader {
    /// RLP of the execution block header.
    pub header_rlp: Bytes,
    /// Its keccak256: the execution block hash.
    pub block_hash: B256,
    /// The root of the receipts trie of the block.
    pub receipts_root: B256,
    /// The root of the transactions trie of the block.
    pub transactions_root: B256,
}

/// Rebuilds the execution header from the JSON of a block and checks that it hashes to the `hash` field.
///
/// # Errors
/// `Error::Malformed` for a mismatch or a missing field.
pub fn rebuild_execution_header(block: &Value) -> Result<RebuiltHeader> {
    guarded("execution header", || {
        let header = execution_header_from_json(block);
        let header_rlp = encode_execution_header(&header);
        let block_hash = header_hash(&header_rlp);
        let reported = lc_core::json::hex_b256(&block["hash"]);
        if block_hash != reported {
            return Err(Error::Malformed(format!(
                "the rebuilt header hashes to {block_hash:#x}, the node reports {reported:#x}"
            )));
        }
        Ok(RebuiltHeader {
            header_rlp,
            block_hash,
            receipts_root: header.receipts_root,
            transactions_root: header.transactions_root,
        })
    })?
}

/// Builds the proof of the receipt at `transaction_index`, and checks the rebuilt trie against the receipts root of the
/// header.
///
/// `receipts` is the JSON array of the block receipts, in order.
///
/// # Errors
/// `Error::Malformed` for a mismatch, a missing receipt or a missing field.
pub fn build_receipt_proof(
    header: &RebuiltHeader,
    receipts: &Value,
    transaction_index: u64,
) -> Result<Vec<Bytes>> {
    guarded("receipt proof", || {
        let trie = build_indexed_trie(&receipts_from_json(receipts));
        if trie.root != header.receipts_root {
            return Err(Error::Malformed(format!(
                "the rebuilt receipts root {:#x} differs from the header root {:#x}",
                trie.root, header.receipts_root
            )));
        }
        trie.proofs
            .get(transaction_index as usize)
            .cloned()
            .ok_or_else(|| {
                Error::Malformed(format!(
                    "no receipt at transaction index {transaction_index}"
                ))
            })
    })?
}

/// Builds the proof of the transaction at `transaction_index`, and checks the rebuilt trie against the transactions root
/// of the header.
///
/// `transactions` holds the raw EIP-2718 bytes of every transaction of the block, in order.
///
/// # Errors
/// `Error::Malformed` for a mismatch or a missing transaction.
pub fn build_transaction_proof(
    header: &RebuiltHeader,
    transactions: &[Bytes],
    transaction_index: u64,
) -> Result<Vec<Bytes>> {
    let trie = build_indexed_trie(transactions);
    if trie.root != header.transactions_root {
        return Err(Error::Malformed(format!(
            "the rebuilt transactions root {:#x} differs from the header root {:#x}",
            trie.root, header.transactions_root
        )));
    }
    trie.proofs
        .get(transaction_index as usize)
        .cloned()
        .ok_or_else(|| {
            Error::Malformed(format!(
                "no transaction at transaction index {transaction_index}"
            ))
        })
}

/// Rebuilds the execution header, the receipt proof and the transaction proof from node answers.
///
/// `block` is the JSON of `eth_getBlockByNumber`, `receipts` the JSON array of the block receipts, and `transactions` the
/// raw bytes of the block transactions, all in order. The function checks the rebuilt header against the node's block
/// hash and each rebuilt trie against the root in the header. A mismatch means the node answer has a shape the builder
/// does not know.
///
/// # Errors
/// `Error::Malformed` for a mismatch or a missing field.
pub fn build_execution_evidence(
    block: &Value,
    receipts: &Value,
    transactions: &[Bytes],
    transaction_index: u64,
) -> Result<ExecutionEvidence> {
    let header = rebuild_execution_header(block)?;
    Ok(ExecutionEvidence {
        receipt_proof: build_receipt_proof(&header, receipts, transaction_index)?,
        transaction_proof: build_transaction_proof(&header, transactions, transaction_index)?,
        header_rlp: header.header_rlp,
        block_hash: header.block_hash,
    })
}

/// The execution evidence of a block whose header is held as raw RLP (Gloas: the header has more items than the JSON
/// rebuilder knows). The roots come from the RLP with the tolerant decoder of `lc-core`, and each rebuilt trie must have the
/// root of the header.
///
/// # Errors
/// `Error::Malformed` for an RLP that does not decode, a root mismatch or a missing entry.
pub fn build_execution_evidence_from_raw_header(
    header_rlp: Vec<u8>,
    receipts: &Value,
    transactions: &[Bytes],
    transaction_index: u64,
) -> Result<ExecutionEvidence> {
    let fields = lc_core::execution::decode_execution_anchor_fields(&header_rlp)
        .map_err(|error| Error::Malformed(format!("execution header: {error}")))?;
    let header = RebuiltHeader {
        block_hash: lc_core::execution::execution_block_hash(&header_rlp),
        header_rlp: Bytes::from(header_rlp),
        receipts_root: fields.receipts_root,
        transactions_root: fields.transactions_root,
    };
    Ok(ExecutionEvidence {
        receipt_proof: build_receipt_proof(&header, receipts, transaction_index)?,
        transaction_proof: build_transaction_proof(&header, transactions, transaction_index)?,
        header_rlp: header.header_rlp,
        block_hash: header.block_hash,
    })
}

/// A Gloas block read from SSZ bytes: its header and the branch of its bid `parent_block_hash`.
pub struct GloasBlockView {
    parsed: lc_core::ssz_block_gloas::ParsedGloasBlock,
}

impl GloasBlockView {
    /// Parses and hashes a Gloas `SignedBeaconBlock` (SSZ bytes of `GET /eth/v2/beacon/blocks/<id>`).
    ///
    /// # Errors
    /// `Error::Malformed` when the bytes are not a Gloas block.
    pub fn parse(bytes: &[u8]) -> Result<Self> {
        lc_core::ssz_block_gloas::try_parse_gloas_signed_block(bytes)
            .map(|parsed| Self { parsed })
            .map_err(|error| Error::Malformed(format!("Gloas beacon block: {error}")))
    }

    /// The header of the block, with the body root computed from the body.
    pub fn header(&self) -> BeaconBlockHeader {
        self.parsed.header
    }

    /// The `parent_block_hash` of the bid: the execution block that the block builds on.
    pub fn bid_parent_block_hash(&self) -> B256 {
        self.parsed.bid_parent_block_hash()
    }

    /// The branch from the bid `parent_block_hash` to the body root (11 entries, index 2856).
    pub fn bid_parent_block_hash_branch(&self) -> Vec<B256> {
        self.parsed.bid_parent_block_hash_branch()
    }
}

/// Joins the beacon path and the execution evidence into the calldata struct of `MessageBridge.executeMessage`. The
/// receipt and the transaction sit at the same index, as the contract requires.
pub fn assemble_message_proof(
    path: &BeaconPath,
    execution: &ExecutionEvidence,
    transaction_index: u64,
    log_index: u64,
) -> MessageProof {
    MessageProof {
        anchorHeader: AbiHeader::from(&path.anchor_header),
        sourceHeader: AbiHeader::from(&path.source_header),
        ancestryBranch: path.ancestry_branch.clone(),
        blockHashBranch: path.block_hash_branch.clone(),
        executionHeaderRlp: execution.header_rlp.clone(),
        receiptProof: execution.receipt_proof.clone(),
        receiptIndex: U256::from(transaction_index),
        transactionProof: execution.transaction_proof.clone(),
        transactionIndex: U256::from(transaction_index),
        logIndex: U256::from(log_index),
    }
}

/// The calldata of `MessageBridge.executeMessage(MessageProof)`.
pub fn message_calldata(proof: &MessageProof) -> Vec<u8> {
    executeMessageCall {
        proof: proof.clone(),
    }
    .abi_encode()
}

/// What the destination bridge knows when it checks a message proof.
#[derive(Clone, Copy, Debug)]
pub struct BridgeContext {
    /// The bridge on the source chain (`remoteBridge` of the destination bridge).
    pub remote_bridge: Address,
    /// The source chain identifier (`remoteChainId` of the destination bridge).
    pub remote_chain_id: u64,
    /// The destination chain identifier (`localChainId` of the destination bridge).
    pub local_chain_id: u64,
    /// What the destination light client stores for the anchor slot.
    pub stored_anchor_root: B256,
}

/// Runs the bridge check natively, in the bridge's order.
///
/// Calls `lc_core::message::verify_message`. The evidence builder returns no evidence that this call refuses.
///
/// # Errors
/// `Error::VerificationRefused` with the reason code of the first failed rule.
pub fn verify_message_natively(
    proof: &MessageProof,
    context: &BridgeContext,
    chain: ChainKind,
) -> Result<VerifiedMessage> {
    let context = MessageContext {
        remote_bridge: context.remote_bridge,
        local_chain_id: context.local_chain_id,
        remote_chain_id: context.remote_chain_id,
        stored_anchor_root: context.stored_anchor_root,
    };
    verify_message(proof, &context, chain.spec())
        .map_err(|error| Error::VerificationRefused(format!("{} ({})", error, error.reason_code())))
}

/// The generalized index of `BeaconState.block_roots` for the fork at `slot`.
///
/// # Errors
/// `Error::Beacon` when the fork has no supported layout.
pub fn block_roots_gindex(chain: ChainKind, slot: u64) -> Result<u64> {
    lc_core::layout::state_layout_for_fork(chain.spec().fork_at_slot(slot))
        .map(|layout| layout.block_roots_gindex)
        .map_err(|error| Error::Beacon(error.to_string()))
}

/// The generalized index of `execution_payload.block_hash` for the fork at `slot`.
///
/// # Errors
/// `Error::Beacon` when the fork has no supported layout.
pub fn block_hash_gindex(chain: ChainKind, slot: u64) -> Result<u64> {
    lc_core::layout::block_hash_gindex_for_fork(chain.spec().fork_at_slot(slot))
        .map_err(|error| Error::Beacon(error.to_string()))
}

// ------------------------------------------------------------------ real beacon data (Capella, Deneb, Electra layouts)

/// Field positions in the `BeaconState`. Taken from `ethereum/consensus-specs`. Every fork keeps these positions; Electra
/// and Fulu only append fields, so their tree is deeper (depth 6) and the branches get one entry more.
const STATE_FIELD_FINALIZED_CHECKPOINT: usize = 20;
const STATE_FIELD_CURRENT_SYNC_COMMITTEE: usize = 22;
const STATE_FIELD_NEXT_SYNC_COMMITTEE: usize = 23;
const BODY_FIELD_EXECUTION_PAYLOAD: usize = 9;
const PAYLOAD_FIELD_BLOCK_HASH: usize = 12;
/// The field counts of the layouts that the parser supports: Capella and Deneb (28), Electra (37), Fulu (38), Gloas (46).
const SUPPORTED_STATE_FIELD_COUNTS: [usize; 4] = [
    StateForm::Capella.field_count(),
    StateForm::Electra.field_count(),
    StateForm::Fulu.field_count(),
    StateForm::Gloas.field_count(),
];

/// The error for a state whose field count no supported layout has.
fn unsupported_field_count(count: usize) -> Error {
    Error::Beacon(format!(
        "the state has {count} fields; only the Capella and Deneb (28 fields), Electra (37 fields), Fulu (38 fields) and Gloas (46 fields) layouts are supported"
    ))
}

/// A beacon state read from SSZ bytes, with the branches the crate needs.
pub struct StateView {
    state: ParsedState,
}

impl StateView {
    /// Parses and hashes a state (SSZ bytes of `GET /eth/v2/debug/beacon/states/<id>`). The layout comes from the fork
    /// that the chain schedule has at the slot of the state: Capella, Deneb, Electra, Fulu or Gloas.
    ///
    /// # Errors
    /// `Error::Malformed` when the bytes are not a state of that fork, or when the fork has no parser.
    pub fn parse(bytes: &[u8], chain: ChainKind) -> Result<Self> {
        let malformed = |error: lc_core::Error| Error::Malformed(format!("beacon state: {error}"));
        let slot = state_slot(bytes).map_err(malformed)?;
        let fork = chain.spec().fork_at_slot(slot);
        let state =
            // The parser returns errors for malformed input; `guarded` stays as a second line of defence.
            guarded("beacon state", || try_parse_state_for_fork(bytes, fork))?
                .map_err(malformed)?;
        Self::from_parsed(state)
    }

    /// The state root. It must equal the `state_root` of the header that names this state.
    pub fn root(&self) -> B256 {
        self.state.root()
    }

    /// The slot of the state.
    pub fn slot(&self) -> u64 {
        self.state.slot
    }

    /// The finalized checkpoint: epoch and block root.
    pub fn finalized_checkpoint(&self) -> (u64, B256) {
        self.state.finalized_checkpoint
    }

    /// The current sync committee.
    pub fn current_committee(&self) -> &SyncCommittee {
        &self.state.current_sync_committee
    }

    /// The next sync committee.
    pub fn next_committee(&self) -> &SyncCommittee {
        &self.state.next_sync_committee
    }

    /// Wraps an already parsed state (tests build synthetic ones). The layout check is the one of [`StateView::parse`].
    ///
    /// # Errors
    /// `Error::Beacon` when the field count is that of no supported layout.
    pub fn from_parsed(state: ParsedState) -> Result<Self> {
        if !SUPPORTED_STATE_FIELD_COUNTS.contains(&state.field_roots.len()) {
            return Err(unsupported_field_count(state.field_roots.len()));
        }
        Ok(Self { state })
    }

    /// The root stored in `block_roots` for a slot.
    pub fn block_root_at(&self, slot: u64) -> B256 {
        self.state.block_roots[(slot % 8192) as usize]
    }

    /// Branch for `block_roots[slot % 8192]` (the recent path): the vector branch, then the field branch.
    pub fn recent_ancestry_branch(&self, slot: u64) -> Vec<B256> {
        lc_core::era::recent_ancestry_branch(&self.state, slot)
    }

    /// Branch for the historical path of `slot`, from the 8192 block roots of its era (see [`era_block_roots`]).
    /// `lc-core` checks the roots against the `block_summary_root` of this state and the finished branch against the
    /// state root.
    ///
    /// # Errors
    /// `Error::Beacon` for a rule of `lc-core` that fails: an era not complete in this state, roots that do not
    /// match, or an era before `capellaEra`.
    pub fn historical_ancestry_branch(
        &self,
        chain: ChainKind,
        slot: u64,
        era_roots: &[B256],
    ) -> Result<Vec<B256>> {
        let capella_era = chain
            .spec()
            .capella_era()
            .map_err(|error| Error::Beacon(error.to_string()))?;
        lc_core::era::historical_ancestry_branch(&self.state, capella_era, slot, era_roots)
            .map_err(|error| Error::Beacon(error.to_string()))
    }

    /// Branch for `finalized_checkpoint.root`: the epoch chunk, then the field branch.
    pub fn finality_branch(&self) -> Vec<B256> {
        let mut branch = vec![u64_chunk(self.state.finalized_checkpoint.0)];
        branch.extend(self.state.field_branch(STATE_FIELD_FINALIZED_CHECKPOINT));
        branch
    }

    /// Branch for `next_sync_committee`.
    pub fn next_committee_branch(&self) -> Vec<B256> {
        self.state.field_branch(STATE_FIELD_NEXT_SYNC_COMMITTEE)
    }

    /// Branch for `current_sync_committee`.
    pub fn current_committee_branch(&self) -> Vec<B256> {
        self.state.field_branch(STATE_FIELD_CURRENT_SYNC_COMMITTEE)
    }

    /// `state.latest_block_hash`, for a Gloas state. `None` for an earlier fork.
    pub fn latest_block_hash(&self) -> Option<B256> {
        self.state.latest_block_hash()
    }
}

/// The finalized header of a Gloas update with its execution anchor: the beacon header, `state.latest_block_hash` of its
/// state, the 11 entry branch from that field to the state root (generalized index 2947), and the RLP of the execution
/// header with that hash. The program checks all of it and reads the block number from the RLP.
///
/// The function repeats the checks of the program before it builds the header, so a wrong state or RLP stops the
/// prover and not the proof run: the state must hash to the state root of the header, and the RLP must hash to
/// `latest_block_hash`. Nothing here trusts the node: the state root is proven against the beacon header, and the RLP
/// against the hash that the state names.
///
/// # Errors
/// `Error::Beacon` when the state is not the post-state of the header, is not a Gloas state, or when the RLP is not the
/// header of `latest_block_hash`. `Error::VerificationRefused` when the result fails the check of `lc-core`.
pub fn anchor_gloas_header(
    header: &BeaconBlockHeader,
    state: &StateView,
    execution_header_rlp: Vec<u8>,
) -> Result<LightClientHeader> {
    if state.root() != header.state_root {
        return Err(Error::Beacon(format!(
            "the state {:#x} is not the post-state of the finalized header at slot {} (state root {:#x})",
            state.root(),
            header.slot,
            header.state_root
        )));
    }
    let hash = state.latest_block_hash().ok_or_else(|| {
        Error::Beacon(
            "the finalized state is not a Gloas state: it has no latest_block_hash".into(),
        )
    })?;
    let rlp_hash = lc_core::execution::execution_block_hash(&execution_header_rlp);
    if rlp_hash != hash {
        return Err(Error::Beacon(format!(
            "the execution header hashes to {rlp_hash:#x}, but state.latest_block_hash is {hash:#x}"
        )));
    }
    let anchored = LightClientHeader::compact(
        *header,
        hash,
        state
            .state
            .field_branch(lc_core::ssz_state_gloas::GLOAS_FIELD_LATEST_BLOCK_HASH),
        execution_header_rlp,
    );
    lc_core::update::verify_finalized_execution(&anchored)
        .map_err(|error| Error::VerificationRefused(error.to_string()))?;
    Ok(anchored)
}

/// A beacon block read from SSZ bytes, with the execution branches.
pub struct BlockView {
    /// The beacon header of the block.
    pub header: BeaconBlockHeader,
    /// The execution payload as a header.
    pub payload: ExecutionPayloadHeader,
    /// Branch from the payload to the body root (the light-client execution branch).
    pub execution_branch: Vec<B256>,
    /// Branch from `execution_payload.block_hash` to the body root.
    pub block_hash_branch: Vec<B256>,
}

impl BlockView {
    /// Parses a Capella-layout `SignedBeaconBlock` (SSZ bytes of `GET /eth/v2/beacon/blocks/<id>`).
    ///
    /// # Errors
    /// `Error::Malformed` when the bytes are not a supported block.
    pub fn parse(bytes: &[u8]) -> Result<Self> {
        let block = guarded("beacon block", || try_parse_signed_block(bytes))?
            .map_err(|error| Error::Malformed(format!("beacon block: {error}")))?;
        guarded("beacon block", || {
            let (_, execution_branch) =
                branch_for_leaf(&block.body_field_roots, BODY_FIELD_EXECUTION_PAYLOAD);
            let leaves = block
                .payload
                .field_roots(lc_core::layout::ExecutionHeaderForm::Capella)
                .expect("payload leaves");
            let (_, mut block_hash_branch) = branch_for_leaf(&leaves, PAYLOAD_FIELD_BLOCK_HASH);
            block_hash_branch.extend(&execution_branch);
            Self {
                header: block.header,
                payload: block.payload,
                execution_branch,
                block_hash_branch,
            }
        })
    }

    /// Parses a block of `chain` after a check of its fork. The slot of the block comes from its first bytes, and the chain
    /// schedule gives the fork. Only Capella blocks go to the parser. A Gloas block is refused here: this path is the Capella block path, and a Gloas block goes through [`GloasBlockView`]. Any other fork is refused by name. The parser never reads a block of another fork as Capella.
    ///
    /// # Errors
    /// `Error::Malformed` for a Gloas block, for another fork than Capella, or for bytes
    /// that are not a block.
    pub fn parse_for_chain(bytes: &[u8], chain: ChainKind) -> Result<Self> {
        let slot = signed_block_slot(bytes)?;
        match chain.spec().fork_at_slot(slot) {
            ForkName::Capella => Self::parse(bytes),
            ForkName::Gloas => Err(Error::Malformed(format!(
                "beacon block at slot {slot} is a Gloas block: this path reads Capella blocks; a Gloas block goes through GloasBlockView"
            ))),
            fork => Err(Error::Malformed(format!(
                "beacon block at slot {slot} is of the fork {fork:?}; the block path reads Capella blocks only"
            ))),
        }
    }

    /// The block as a light-client header.
    pub fn as_light_client_header(&self) -> LightClientHeader {
        LightClientHeader::full(
            self.header,
            self.payload.clone(),
            self.execution_branch.clone(),
        )
    }
}

/// The slot of an SSZ `SignedBeaconBlock`: the first 8 bytes of the message that the first offset points to.
fn signed_block_slot(bytes: &[u8]) -> Result<u64> {
    let truncated = || Error::Malformed("beacon block: the bytes end before the slot".into());
    let offset = bytes
        .get(0..4)
        .and_then(|head| <[u8; 4]>::try_from(head).ok())
        .map(|head| u32::from_le_bytes(head) as usize)
        .ok_or_else(truncated)?;
    let slot = offset
        .checked_add(8)
        .and_then(|end| bytes.get(offset..end))
        .and_then(|head| <[u8; 8]>::try_from(head).ok())
        .ok_or_else(truncated)?;
    Ok(u64::from_le_bytes(slot))
}

/// The signature part of an update, from the child block JSON (`sync_aggregate`) and its slot.
///
/// # Errors
/// `Error::Malformed` when the aggregate is malformed.
pub fn sync_aggregate_from_json(value: &Value) -> Result<SyncAggregate> {
    guarded("sync aggregate", || lc_core::json::sync_aggregate(value))
}

/// Assembles an update from an attested block and its state, the finalized block, and the signing aggregate.
///
/// This is the path for nodes that do not serve the light-client endpoints (PulseChain). The caller has already
/// checked that `state.root()` equals `attested.header.state_root` and that the finalized block root equals the
/// state's finalized checkpoint root.
pub fn assemble_update(
    attested: &BlockView,
    state: &StateView,
    finalized: &BlockView,
    sync_aggregate: SyncAggregate,
    signature_slot: u64,
) -> LightClientUpdate {
    LightClientUpdate {
        attested_header: attested.as_light_client_header(),
        next_sync_committee: Some(NextSyncCommittee {
            committee: state.next_committee().clone(),
            branch: state.next_committee_branch(),
        }),
        finalized_header: finalized.as_light_client_header(),
        finality_branch: state.finality_branch(),
        sync_aggregate,
        signature_slot,
    }
}

/// A store at a header: the header root and slot, the current committee, and optionally the next one.
pub fn store_at(
    header: &BeaconBlockHeader,
    state: &StateView,
    include_next: bool,
) -> LightClientStore {
    LightClientStore {
        header_root: header.hash_tree_root(),
        header_slot: header.slot,
        current_sync_committee: state.current_committee().clone(),
        next_sync_committee: include_next.then(|| state.next_committee().clone()),
    }
}

// ------------------------------------------------------------------ ancestry and gate helpers

/// Which ancestry path the bridge takes for two slots. The prover never chooses; it builds what the bridge expects.
///
/// # Errors
/// `Error::Beacon` when the source slot is not before the anchor slot.
pub fn ancestry_path(anchor_slot: u64, source_slot: u64) -> Result<AncestryPath> {
    lc_core::ancestry::ancestry_path_for_slots(anchor_slot, source_slot)
        .map_err(|error| Error::Beacon(error.to_string()))
}

/// Rebuilds the 8192 block roots of an era from canonical block roots (slot to root, empty slots absent).
///
/// # Errors
/// `Error::Beacon` when no block at or before the first slot of the era is known.
pub fn era_block_roots(era: u64, canonical: &BTreeMap<u64, B256>) -> Result<Vec<B256>> {
    lc_core::era::era_block_roots(era, canonical).map_err(|error| Error::Beacon(error.to_string()))
}

/// The era of a slot.
pub fn era_of(slot: u64) -> u64 {
    slot / lc_core::layout::SLOTS_PER_HISTORICAL_ROOT
}

/// The generalized index of `BeaconState.historical_summaries` for the fork at `slot`.
///
/// # Errors
/// `Error::Beacon` when the fork has no supported layout.
pub fn historical_summaries_gindex(chain: ChainKind, slot: u64) -> Result<u64> {
    lc_core::layout::state_layout_for_fork(chain.spec().fork_at_slot(slot))
        .map(|layout| layout.historical_summaries_gindex)
        .map_err(|error| Error::Beacon(error.to_string()))
}

/// SHA-256 of `data`, from `lc-core`. The oracle digest and the SSZ hashes use it.
pub fn sha256(data: &[u8]) -> B256 {
    lc_core::ssz::sha256(data)
}

/// Builds a store from the JSON `data` of a `light_client/bootstrap` answer (header and current committee).
///
/// # Errors
/// `Error::Malformed` when the object lacks a field.
pub fn store_from_bootstrap_json(data: &Value) -> Result<LightClientStore> {
    guarded("bootstrap", || {
        let bootstrap = lc_core::json::bootstrap(data);
        lc_core::json::store_from_bootstrap(&bootstrap, None)
    })
}

/// A parsed `light_client/bootstrap` answer: the beacon header, the current committee and the branch that ties the
/// committee to the state root of the header.
#[derive(Clone, Debug)]
pub struct BootstrapView {
    /// The beacon header of the bootstrap.
    pub header: BeaconBlockHeader,
    /// The current sync committee of the header.
    pub committee: SyncCommittee,
    /// The branch from the committee to `header.state_root`.
    pub branch: Vec<B256>,
}

/// Parses the `data` object of a `light_client/bootstrap` answer. It checks nothing else: see
/// [`BootstrapView::verify_committee`].
///
/// # Errors
/// `Error::Malformed` when the object lacks a field.
pub fn bootstrap_from_json(data: &Value) -> Result<BootstrapView> {
    guarded("bootstrap", || {
        let bootstrap = lc_core::json::bootstrap(data);
        BootstrapView {
            header: bootstrap.header.beacon,
            committee: bootstrap.committee,
            branch: bootstrap.branch,
        }
    })
}

impl BootstrapView {
    /// Checks that the committee belongs to the state root of the header, with the committee position of the fork at the
    /// slot of the header. Returns the committee hash.
    ///
    /// # Errors
    /// `Error::VerificationRefused` for a Gloas slot (the refusal of `lc-core`) or when the branch does not verify.
    pub fn verify_committee(&self, chain: ChainKind) -> Result<B256> {
        let layout = state_layout_at(chain, self.header.slot)?;
        let hash = committee_hash(&self.committee)?;
        if !lc_core::ssz::is_valid_exact_branch(
            &hash,
            &self.branch,
            layout.current_sync_committee_gindex,
            &self.header.state_root,
        ) {
            return Err(Error::VerificationRefused(
                "the bootstrap committee does not belong to the state root of its header".into(),
            ));
        }
        Ok(hash)
    }
}

/// The state layout of the fork that `chain` has at `slot`.
///
/// # Errors
/// `Error::VerificationRefused` with the text of `lc-core` when the fork has no light-client layout (before Capella).
pub fn state_layout_at(chain: ChainKind, slot: u64) -> Result<lc_core::layout::StateLayout> {
    lc_core::layout::state_layout_for_fork(chain.spec().fork_at_slot(slot))
        .map_err(|error| Error::VerificationRefused(error.to_string()))
}

/// The `slot` of a beacon header JSON-free pair, used by the beacon sources for readable errors.
pub fn describe_header(header: &BeaconBlockHeader) -> String {
    format!("slot {} root {:#x}", header.slot, header.hash_tree_root())
}

/// Synthetic beacon states for unit tests of this crate.
#[cfg(test)]
pub(crate) mod test_support {
    use super::*;
    use alloy_primitives::keccak256;
    use lc_core::ssz::{hash_pair, merkleize, merkleize_with_limit, mix_in_length};

    /// A Capella-layout state whose `block_roots`, `fork` and `historical_summaries` the test controls. `eras` holds
    /// the 8192 block roots of each complete era, in list order. All other fields hold filler.
    pub fn synthetic_state(anchor_slot: u64, fork: ForkData, eras: &[Vec<B256>]) -> StateView {
        let block_roots: Vec<B256> = (0..8192u64)
            .map(|slot| keccak256(format!("recent/{slot}")))
            .collect();
        let historical_summaries: Vec<(B256, B256)> = eras
            .iter()
            .enumerate()
            .map(|(index, roots)| {
                (
                    merkleize(roots),
                    keccak256(format!("state-summary/{index}")),
                )
            })
            .collect();
        let summary_roots: Vec<B256> = historical_summaries
            .iter()
            .map(|(b, s)| hash_pair(b, s))
            .collect();
        let mut field_roots: Vec<B256> = (0..28u64)
            .map(|field| keccak256(format!("field/{field}")))
            .collect();
        field_roots[3] = fork.hash_tree_root();
        field_roots[5] = merkleize(&block_roots);
        field_roots[27] = mix_in_length(
            &merkleize_with_limit(&summary_roots, 1 << 24),
            historical_summaries.len() as u64,
        );
        let committee = SyncCommittee {
            pubkeys: Vec::new(),
            aggregate_pubkey: Default::default(),
        };
        StateView::from_parsed(ParsedState {
            field_roots,
            block_roots,
            current_sync_committee: committee.clone(),
            next_sync_committee: committee,
            slot: anchor_slot,
            fork,
            finalized_checkpoint: (0, B256::ZERO),
            historical_summaries,
            shape: lc_core::layout::ContainerShape::Plain,
        })
        .expect("a Capella layout")
    }
}

#[cfg(test)]
mod tests {

    /// Claim: a block of a Gloas slot is refused with the `lc-core` refusal and a block of a non-Capella fork is refused
    /// by name, while the slot is read from the bytes. Why it matters: the parser reads the Capella layout only, so a
    /// block of another fork must never reach it. Sepolia must fail closed, never parse as Capella.
    #[test]
    fn a_block_of_another_fork_never_reaches_the_capella_parser() {
        let block_at = |slot: u64| {
            let mut bytes = vec![0u8; 4 + 96 + 8 + 4];
            bytes[0..4].copy_from_slice(&100u32.to_le_bytes());
            bytes[100..108].copy_from_slice(&slot.to_le_bytes());
            bytes
        };
        let gloas_slot = lc_core::chain::SEPOLIA.fork_schedule.last().unwrap().epoch * 32;
        let refusal = BlockView::parse_for_chain(&block_at(gloas_slot + 5), ChainKind::Sepolia)
            .err()
            .expect("refused");
        assert!(matches!(&refusal, Error::Malformed(text) if text.contains("Gloas")));
        let deneb = BlockView::parse_for_chain(&block_at(132_608 * 32), ChainKind::Sepolia)
            .err()
            .expect("refused");
        assert!(matches!(&deneb, Error::Malformed(text) if text.contains("Deneb")));
        let capella =
            BlockView::parse_for_chain(&block_at(4_200 * 32), ChainKind::PulsechainTestnetV4)
                .err()
                .expect("garbage bytes fail in the parser");
        assert!(
            matches!(&capella, Error::Malformed(text) if !text.contains("fork")),
            "a Capella slot reaches the parser: {capella}"
        );
        assert!(BlockView::parse_for_chain(&[1, 2], ChainKind::Sepolia).is_err());
    }

    /// Claim: each chain kind names its own chain. The genesis validators root is the one that the chain serves, and
    /// the name round-trips. Why it matters: a wrong root makes every sync committee signature fail on that chain.
    #[test]
    fn each_chain_kind_has_its_own_genesis_and_name() {
        let expected = [
            (
                ChainKind::Ethereum,
                "ethereum",
                "4b363db94e286120d76eb905340fdd4e54bfe9f06bf33ff6cf5ad27f511bfe95",
            ),
            (
                ChainKind::Pulsechain,
                "pulsechain",
                "3357ba0018a2582aeabe4ae847aa17d50a3a99aaeb66293c01f80a83aecd0c90",
            ),
            (
                ChainKind::Sepolia,
                "sepolia",
                "d8ea171f3c94aea21ebc42a1ed61052acf3f9209c00e4efbaaddac09ed9b8078",
            ),
            (
                ChainKind::PulsechainTestnetV4,
                "pulsechain-testnet-v4",
                "d81664ba97279a6fa0832041b4aee6009172b4750a99467ff670a9faf3a34e64",
            ),
        ];
        assert_eq!(expected.len(), ChainKind::ALL.len());
        for (kind, name, root) in expected {
            assert_eq!(kind.name(), name);
            assert_eq!(ChainKind::from_name(name), Some(kind));
            assert_eq!(
                format!("{:x}", kind.spec().genesis_validators_root),
                root,
                "{name}"
            );
        }
        assert_eq!(ChainKind::Sepolia.seconds_per_slot(), 12);
        assert_eq!(ChainKind::PulsechainTestnetV4.seconds_per_slot(), 10);
    }

    /// Claim: an unknown name is refused, and the message lists every known name. Why it matters: a typo in the file
    /// must not select a chain, and the reader must see the valid choices.
    #[test]
    fn an_unknown_chain_name_is_refused_with_the_known_names() {
        assert_eq!(ChainKind::from_name("Sepolia"), None);
        assert_eq!(ChainKind::from_name("goerli"), None);
        let message = ChainKind::parse("goerli").unwrap_err().to_string();
        for kind in ChainKind::ALL {
            assert!(message.contains(kind.name()), "{message}");
        }
        assert!(message.contains("goerli"));
    }
    use super::*;
    use alloy_primitives::keccak256;
    use lc_core::message::message_id_for;
    use lc_testkit::synthetic::{message_log, MessageFields};

    /// Claim: the message topic equals the real signature hash, not a hardcoded constant.
    /// Why it matters: the destination bridge matches logs on this topic; a wrong one proves no message.
    #[test]
    fn message_topic_is_the_signature_hash() {
        assert_eq!(
            USER_REQUEST_TOPIC,
            keccak256("UserRequestForAffirmation(bytes32,bytes)")
        );
    }

    fn sample_fields(nonce: u64) -> MessageFields {
        let remote = 369;
        MessageFields {
            message_id: message_id_for(remote, BRIDGE, nonce),
            sender: Address::repeat_byte(0xc3),
            executor: Address::repeat_byte(0xd4),
            gas_limit: 300_000,
            data_type: 0,
            source_chain_id: remote,
            destination_chain_id: 1,
            data: Bytes::from_static(&[0xab, 0xcd]),
        }
    }

    const BRIDGE: Address = Address::repeat_byte(0xa1);

    /// Claim: a message log of the source bridge decodes to the fields and the call data that the sender wrote, and the
    /// decoder refuses a log of another emitter, a log whose topic holds another identifier, and event data that is not
    /// `abi.encode(bytes)`.
    /// Why it matters: the evidence command builds a proof for the message that the log shows. A decoder that took a
    /// foreign log, or read the data in another layout, would name the wrong message.
    #[test]
    fn decode_message_log_reads_the_message_and_refuses_other_logs() {
        let fields = sample_fields(7);
        let log = message_log(BRIDGE, &fields);
        let decoded = decode_message_log(log.address, &log.topics, &log.data, BRIDGE)
            .expect("control: an honest log decodes");
        assert_eq!(decoded.header, fields.header());
        assert_eq!(decoded.data, fields.data);

        assert!(decode_message_log(
            log.address,
            &log.topics,
            &log.data,
            Address::repeat_byte(0xee)
        )
        .is_err());

        let mut other_identifier = log.topics.clone();
        other_identifier[1] = B256::repeat_byte(0x55);
        let error = decode_message_log(log.address, &other_identifier, &log.data, BRIDGE)
            .unwrap_err()
            .to_string();
        assert!(error.contains("identifier in the topic"), "{error}");

        assert!(decode_message_log(log.address, &log.topics, &log.data[..40], BRIDGE).is_err());
        assert!(decode_message_log(log.address, &log.topics[..1], &log.data, BRIDGE).is_err());
    }

    // ---------------------------------------------------------------- real historical paths

    const ANCHOR_AND_ERA_FIXTURE: &str = "../light-client/tests/fixtures/pulsechain";

    fn fixture(name: &str) -> Value {
        let path = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
            .join(ANCHOR_AND_ERA_FIXTURE)
            .join(name);
        let text = std::fs::read_to_string(&path)
            .unwrap_or_else(|error| panic!("{}: {error}", path.display()));
        let wrapper: Value = serde_json::from_str(&text).expect("fixture json");
        wrapper["response"].clone()
    }

    fn hex_branch(value: &Value) -> Vec<B256> {
        value
            .as_array()
            .expect("branch")
            .iter()
            .map(|item| item.as_str().expect("hex").parse().expect("b256"))
            .collect()
    }

    struct RealHistorical {
        anchor: BeaconBlockHeader,
        paths: Value,
    }

    impl RealHistorical {
        fn load() -> Self {
            let paths = fixture("historical_paths.json");
            let anchor = beacon_header_from_json(&paths["anchor_header"]).expect("anchor");
            assert_eq!(
                header_root(&anchor),
                paths["anchor_header_root"]
                    .as_str()
                    .unwrap()
                    .parse::<B256>()
                    .unwrap()
            );
            Self { anchor, paths }
        }

        fn entry(&self, name: &str) -> &Value {
            self.paths["entries"]
                .as_array()
                .unwrap()
                .iter()
                .find(|entry| entry["name"] == name)
                .expect("entry")
        }

        fn path(&self, name: &str) -> BeaconPath {
            let entry = self.entry(name);
            BeaconPath {
                anchor_header: self.anchor,
                source_header: beacon_header_from_json(&entry["deposit_header"])
                    .expect("source header"),
                ancestry_branch: hex_branch(&entry["ancestry_branch"]),
                block_hash_branch: hex_branch(&entry["block_hash_branch"]),
            }
        }
    }

    /// The execution evidence of the real middle block. The fixture holds the transaction hashes and not the
    /// transactions, so the transaction proof is empty and the native check stops at the transaction stage.
    fn middle_block_evidence() -> ExecutionEvidence {
        let block = fixture("path_historical_block.json");
        let receipts = fixture("path_historical_receipts.json");
        let header = rebuild_execution_header(&block).expect("the real header rebuilds");
        ExecutionEvidence {
            receipt_proof: build_receipt_proof(&header, &receipts, 0)
                .expect("the real receipts root matches"),
            transaction_proof: Vec::new(),
            header_rlp: header.header_rlp,
            block_hash: header.block_hash,
        }
    }

    /// Claim: for the real PulseChain anchor, the crate classifies each fixture block by distance: five of them
    /// lie more than 8192 slots below the anchor (historical path), and `era_last_block` lies 5117 slots below it
    /// (recent path), although the fixture also holds a historical branch for it.
    /// Why it matters: the bridge, not the crate, chooses the path. A builder that built the historical branch for a
    /// recent distance would send a message proof that reverts.
    #[test]
    fn real_fixture_blocks_are_classified_by_distance() {
        let real = RealHistorical::load();
        for (name, expected) in [
            ("capella_fork_block", AncestryPath::Historical),
            ("era_zero_last_block", AncestryPath::Historical),
            ("era_previous_last_block", AncestryPath::Historical),
            ("era_first_block", AncestryPath::Historical),
            ("era_middle_block", AncestryPath::Historical),
            ("era_last_block", AncestryPath::Recent),
        ] {
            let path = real.path(name);
            let found = ancestry_path(path.anchor_header.slot, path.source_header.slot).unwrap();
            assert_eq!(
                found,
                expected,
                "{name}: distance {}",
                path.anchor_header.slot - path.source_header.slot
            );
        }
        assert!(
            ancestry_path(100, 100).is_err(),
            "a source block at the anchor slot has no path"
        );
    }

    /// Claim: the real historical branches pass the bridge check of `lc-core` through the crate functions: the
    /// crate rebuilds the real execution block and its receipt proof, assembles the calldata struct, and native
    /// verification passes the anchor, the 44-entry historical ancestry branch, the block hash branch, the header
    /// hash and the receipt proof. It stops at the transaction stage, because the fixture holds no transaction bytes.
    /// Why it matters: this is the proof that a server sends for a message older than 8192 slots. The controls
    /// show each earlier check can fail: a branch of another era, a padded branch and an unknown anchor all stop earlier.
    #[test]
    fn real_historical_message_proof_passes_native_verification_up_to_the_transaction() {
        let real = RealHistorical::load();
        let path = real.path("era_middle_block");
        assert_eq!(path.ancestry_branch.len(), 44);
        let execution = middle_block_evidence();
        let proof = assemble_message_proof(&path, &execution, 0, 0);
        let context = BridgeContext {
            remote_bridge: Address::repeat_byte(0xee),
            remote_chain_id: 369,
            local_chain_id: 1,
            stored_anchor_root: header_root(&real.anchor),
        };
        let reason = |proof: &MessageProof, context: &BridgeContext| match verify_message_natively(
            proof,
            context,
            ChainKind::Pulsechain,
        ) {
            Ok(_) => "accepted".to_string(),
            Err(Error::VerificationRefused(text)) => text,
            Err(other) => panic!("unexpected error {other}"),
        };
        let at_transaction = reason(&proof, &context);
        assert!(
            at_transaction.contains("TransactionProofInvalid"),
            "the check passes the ancestry and the receipt proof and stops at the transaction: {at_transaction}"
        );

        let mut other_era = proof.clone();
        other_era.ancestryBranch = hex_branch(&real.entry("era_first_block")["ancestry_branch"]);
        assert!(
            reason(&other_era, &context).contains("InvalidAncestryBranch"),
            "a branch of another entry"
        );
        let mut padded = proof.clone();
        padded.ancestryBranch.insert(0, B256::ZERO);
        assert!(
            reason(&padded, &context).contains("InvalidAncestryBranch"),
            "a padded branch"
        );
        let unknown = BridgeContext {
            stored_anchor_root: B256::repeat_byte(9),
            ..context
        };
        assert!(reason(&proof, &unknown).contains("AnchorNotStored"));
        let mut wrong_block = proof.clone();
        wrong_block.blockHashBranch =
            hex_branch(&real.entry("era_first_block")["block_hash_branch"]);
        assert!(reason(&wrong_block, &context).contains("InvalidBlockHashBranch"));
    }

    /// Claim: the real fixture agrees with the gindex helpers of the crate: the historical summaries field of the
    /// Capella layout is gindex 59, and the era of the middle block is 1326, with `capellaEra` 0 on PulseChain.
    #[test]
    fn real_fixture_matches_the_layout_constants() {
        let real = RealHistorical::load();
        assert_eq!(
            historical_summaries_gindex(ChainKind::Pulsechain, real.anchor.slot).unwrap(),
            59
        );
        let middle = real.path("era_middle_block");
        assert_eq!(era_of(middle.source_header.slot), 1326);
        assert_eq!(real.entry("era_middle_block")["index"], 1326);
        assert_eq!(ChainKind::Pulsechain.spec().capella_era().unwrap(), 0);
        let leaf = lc_core::ancestry::ancestry_leaf_gindex(
            ChainKind::Pulsechain.spec(),
            real.anchor.slot,
            middle.source_header.slot,
        )
        .unwrap();
        assert!(lc_core::ssz::is_valid_exact_branch(
            &header_root(&middle.source_header),
            &middle.ancestry_branch,
            leaf,
            &real.anchor.state_root
        ));
    }
}
