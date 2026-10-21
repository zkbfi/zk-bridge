//! The only module that calls `lc-core` (and, for the development source only, the test crate `lc-testkit`).
//!
//! Everything a withdrawal needs comes from `lc-core`: the JSON parsers, the receipts trie, the execution header
//! encoder, the SSZ state parser, the ancestry builders for both paths, and the gate evidence builder.
//! The cargo feature `dev-source` adds the synthetic beacon data for Anvil from `lc-testkit`.
//! A production build leaves that feature out and does not link the test crate.

use crate::error::{Error, Result};
#[cfg(feature = "dev-source")]
use alloy_primitives::keccak256;
use alloy_primitives::{Address, Bytes, B256, U256};
use alloy_sol_types::{SolCall, SolEvent, SolValue};
use lc_core::abi::{withdrawCall, BeaconBlockHeader as AbiHeader, DepositInitiated, WithdrawalProof};
use lc_core::chain::{ChainSpec, ETHEREUM_MAINNET, PULSECHAIN};
use std::collections::BTreeMap;
use lc_core::ssz::{branch_for_leaf, u64_chunk};
use lc_core::types::{
    BeaconBlockHeader, ExecutionPayloadHeader, LightClientHeader, NextSyncCommittee, SyncCommittee,
};
use lc_core::update::FoldStep;
use lc_core::wire::{encode_guest_input, ChainSelector, GuestInput};
use lc_core::json::{execution_header_from_json, receipts_from_json};
use lc_core::receipts::{build_receipts_trie, encode_execution_header, header_hash};
use lc_core::ssz_state::{try_parse_signed_block, try_parse_state, ParsedState};
#[cfg(feature = "dev-source")]
use lc_testkit::synthetic::{build_body_proofs, synthetic_payload_header, StateBuilder};
use serde_json::Value;
use std::panic::{catch_unwind, AssertUnwindSafe};

pub use lc_core::ancestry::AncestryPath;
pub use lc_core::abi::LightClientOutput;
pub use lc_core::layout::SLOTS_PER_HISTORICAL_ROOT;
pub use lc_core::ssz_state::ForkData;
pub use lc_core::types::BeaconBlockHeader as BeaconHeader;
pub use lc_core::types::{LightClientStore, LightClientUpdate, SyncAggregate};

/// The deposit event topic 0, derived from the event declaration in `lc-core`.
pub const DEPOSIT_EVENT_TOPIC: B256 = lc_core::abi::DEPOSIT_EVENT_TOPIC;

/// Which chain configuration of `lc-core` applies.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ChainKind {
    /// Ethereum mainnet.
    Ethereum,
    /// PulseChain. Anvil chains use it too, with synthetic beacon data.
    Pulsechain,
}

impl ChainKind {
    /// The `lc-core` chain specification.
    pub fn spec(self) -> &'static ChainSpec {
        match self {
            Self::Ethereum => &ETHEREUM_MAINNET,
            Self::Pulsechain => &PULSECHAIN,
        }
    }

    fn selector(self) -> ChainSelector {
        match self {
            Self::Ethereum => ChainSelector::EthereumMainnet,
            Self::Pulsechain => ChainSelector::Pulsechain,
        }
    }

    /// The seconds between two slots.
    pub fn seconds_per_slot(self) -> u64 {
        self.spec().seconds_per_slot
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

/// The public values of the program: the ABI encoding of the output. The contract decodes these bytes.
pub fn public_values(output: &LightClientOutput) -> Vec<u8> {
    output.abi_encode()
}

/// The input bytes that an SP1 guest reads (used by the `sp1` backend).
///
/// Calls `lc_core::wire::encode_guest_input` with the fork version of each step from the fork table.
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
    encode_guest_input(&GuestInput { chain: input.chain.selector(), store: input.store.clone(), steps })
}

/// Parses the `data` object of a beacon API light-client update or finality update.
///
/// # Errors
/// `Error::Malformed` when the object lacks a field.
pub fn update_from_json(data: &Value) -> Result<LightClientUpdate> {
    guarded("light-client update", || lc_core::json::light_client_update(data))
}

/// The hash tree root of a sync committee, as the contract stores it.
///
/// # Errors
/// `Error::Malformed` when the committee does not hold 512 keys.
pub fn committee_hash(committee: &SyncCommittee) -> Result<B256> {
    committee.hash_tree_root().map_err(|error| Error::Malformed(error.to_string()))
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

// ------------------------------------------------------------------ deposits and withdrawals

/// A decoded `DepositInitiated` log.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct DepositEvent {
    /// Token on the source chain.
    pub token: Address,
    /// Depositor.
    pub sender: Address,
    /// Recipient on the destination chain.
    pub recipient: Address,
    /// Amount the vault received.
    pub amount: U256,
    /// The unique deposit nonce.
    pub nonce: B256,
    /// The destination chain.
    pub target_chain_id: u64,
}

/// Decodes a `DepositInitiated` log from its topics and data.
///
/// # Errors
/// `Error::Malformed` when the log is not a deposit event.
pub fn decode_deposit(topics: &[B256], data: &[u8]) -> Result<DepositEvent> {
    if topics.first() != Some(&DEPOSIT_EVENT_TOPIC) {
        return Err(Error::Malformed("log topic 0 is not the deposit event".into()));
    }
    let event = DepositInitiated::decode_raw_log(topics.iter().copied(), data)
        .map_err(|error| Error::Malformed(format!("deposit log: {error}")))?;
    Ok(DepositEvent {
        token: event.token,
        sender: event.sender,
        recipient: event.recipient,
        amount: event.amount,
        nonce: event.nonce,
        target_chain_id: event.targetChainId,
    })
}

/// The beacon part of a withdrawal.
#[derive(Clone, Debug)]
pub struct BeaconPath {
    /// A finalized header that the destination light client stores.
    pub anchor_header: BeaconBlockHeader,
    /// The beacon block that carries the deposit block.
    pub deposit_header: BeaconBlockHeader,
    /// Branch from the deposit header root to the anchor state root.
    pub ancestry_branch: Vec<B256>,
    /// Branch from the execution block hash to the deposit body root.
    pub block_hash_branch: Vec<B256>,
}

/// The execution part of a withdrawal.
#[derive(Clone, Debug)]
pub struct ExecutionEvidence {
    /// RLP of the execution block header.
    pub header_rlp: Bytes,
    /// Its keccak256: the execution block hash.
    pub block_hash: B256,
    /// Merkle-Patricia nodes from the receipts root to the receipt.
    pub receipt_proof: Vec<Bytes>,
}

/// Rebuilds the execution header and the receipt proof from node answers.
///
/// `block` is the JSON of `eth_getBlockByNumber` and `receipts` the JSON array of the block receipts, in order.
/// The function checks the rebuilt header against the node's block hash and the rebuilt trie against the
/// header's receipts root. A mismatch means the node answer has a shape the builder does not know.
///
/// # Errors
/// `Error::Malformed` for a mismatch or a missing field.
pub fn build_execution_evidence(block: &Value, receipts: &Value, transaction_index: u64) -> Result<ExecutionEvidence> {
    guarded("execution evidence", || {
        let header = execution_header_from_json(block);
        let header_rlp = encode_execution_header(&header);
        let block_hash = header_hash(&header_rlp);
        let reported = lc_core::json::hex_b256(&block["hash"]);
        if block_hash != reported {
            return Err(Error::Malformed(format!(
                "the rebuilt header hashes to {block_hash:#x}, the node reports {reported:#x}"
            )));
        }
        let trie = build_receipts_trie(&receipts_from_json(receipts));
        if trie.root != header.receipts_root {
            return Err(Error::Malformed(format!(
                "the rebuilt receipts root {:#x} differs from the header root {:#x}",
                trie.root, header.receipts_root
            )));
        }
        let proof = trie
            .proofs
            .get(transaction_index as usize)
            .ok_or_else(|| Error::Malformed(format!("no receipt at transaction index {transaction_index}")))?
            .clone();
        Ok(ExecutionEvidence { header_rlp, block_hash, receipt_proof: proof })
    })?
}

/// Joins the beacon path and the execution evidence into the calldata struct of `BridgeVault.withdraw`.
pub fn assemble_withdrawal_proof(
    path: &BeaconPath,
    execution: &ExecutionEvidence,
    transaction_index: u64,
    log_index: u64,
) -> WithdrawalProof {
    WithdrawalProof {
        anchorHeader: AbiHeader::from(&path.anchor_header),
        depositHeader: AbiHeader::from(&path.deposit_header),
        ancestryBranch: path.ancestry_branch.clone(),
        blockHashBranch: path.block_hash_branch.clone(),
        executionHeaderRlp: execution.header_rlp.clone(),
        receiptProof: execution.receipt_proof.clone(),
        transactionIndex: U256::from(transaction_index),
        logIndex: U256::from(log_index),
    }
}

/// The calldata of `BridgeVault.withdraw(WithdrawalProof)`.
pub fn withdrawal_calldata(proof: &WithdrawalProof) -> Vec<u8> {
    withdrawCall { proof: proof.clone() }.abi_encode()
}

/// What the vault knows when it checks a withdrawal.
#[derive(Clone, Copy, Debug)]
pub struct VaultContext {
    /// The vault on the source chain (`remoteVault` of the destination vault).
    pub remote_vault: Address,
    /// The destination chain identifier.
    pub local_chain_id: u64,
    /// What the destination light client stores for the anchor slot.
    pub stored_anchor_root: B256,
}

/// The deposit that native verification proved.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct VerifiedDeposit {
    /// Token on the source chain.
    pub token: Address,
    /// Recipient.
    pub recipient: Address,
    /// Amount.
    pub amount: U256,
    /// Nonce.
    pub nonce: B256,
    /// The execution block hash of the deposit block.
    pub deposit_block_hash: B256,
}

/// Runs the vault check natively, in the vault's order.
///
/// Calls `lc_core::withdrawal::verify_withdrawal`. The service sends no withdrawal that this call refuses.
///
/// # Errors
/// `Error::VerificationRefused` with the reason code of the first failed rule.
pub fn verify_withdrawal_natively(
    proof: &WithdrawalProof,
    context: &VaultContext,
    chain: ChainKind,
) -> Result<VerifiedDeposit> {
    let context = lc_core::withdrawal::WithdrawalContext {
        remote_vault: context.remote_vault,
        local_chain_id: context.local_chain_id,
        stored_anchor_root: context.stored_anchor_root,
    };
    let verified = lc_core::withdrawal::verify_withdrawal(proof, &context, chain.spec())
        .map_err(|error| Error::VerificationRefused(format!("{} ({})", error, error.reason_code())))?;
    Ok(VerifiedDeposit {
        token: verified.token,
        recipient: verified.recipient,
        amount: verified.amount,
        nonce: verified.nonce,
        deposit_block_hash: verified.deposit_block_hash,
    })
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

// ------------------------------------------------------------------ real beacon data (Capella layout)

/// Field positions in the Capella `BeaconState` (PulseChain). Taken from `ethereum/consensus-specs`.
const STATE_FIELD_FINALIZED_CHECKPOINT: usize = 20;
const STATE_FIELD_CURRENT_SYNC_COMMITTEE: usize = 22;
const STATE_FIELD_NEXT_SYNC_COMMITTEE: usize = 23;
const BODY_FIELD_EXECUTION_PAYLOAD: usize = 9;
const PAYLOAD_FIELD_BLOCK_HASH: usize = 12;
/// The number of fields of the Capella state. The parser supports this layout only.
const CAPELLA_STATE_FIELDS: usize = 28;

/// A beacon state read from SSZ bytes, with the branches the service needs.
pub struct StateView {
    state: ParsedState,
}

impl StateView {
    /// Parses and hashes a Capella-layout state (SSZ bytes of `GET /eth/v2/debug/beacon/states/<id>`).
    ///
    /// # Errors
    /// `Error::Malformed` when the bytes are not a state. `Error::Beacon` when the layout is not Capella.
    pub fn parse(bytes: &[u8]) -> Result<Self> {
        let state =
            // The parser returns errors for malformed input; `guarded` stays as a second line of defence.
            guarded("beacon state", || try_parse_state(bytes))?
                .map_err(|error| Error::Malformed(format!("beacon state: {error}")))?;
        if state.field_roots.len() != CAPELLA_STATE_FIELDS {
            return Err(Error::Beacon(format!(
                "the state has {} fields; only the Capella layout (28 fields) is supported",
                state.field_roots.len()
            )));
        }
        Ok(Self { state })
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
    /// `Error::Beacon` when the layout is not Capella.
    pub fn from_parsed(state: ParsedState) -> Result<Self> {
        if state.field_roots.len() != CAPELLA_STATE_FIELDS {
            return Err(Error::Beacon(format!(
                "the state has {} fields; only the Capella layout (28 fields) is supported",
                state.field_roots.len()
            )));
        }
        Ok(Self { state })
    }

    /// The root stored in `block_roots` for a slot.
    pub fn block_root_at(&self, slot: u64) -> B256 {
        self.state.block_roots[(slot % 8192) as usize]
    }

    /// The `fork` of the state.
    pub fn fork(&self) -> ForkData {
        self.state.fork
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
    pub fn historical_ancestry_branch(&self, chain: ChainKind, slot: u64, era_roots: &[B256]) -> Result<Vec<B256>> {
        let capella_era = chain.spec().capella_era().map_err(|error| Error::Beacon(error.to_string()))?;
        lc_core::era::historical_ancestry_branch(&self.state, capella_era, slot, era_roots)
            .map_err(|error| Error::Beacon(error.to_string()))
    }

    /// The gate evidence for this state: `abi.encode(ForkEvidence)` for the header whose state this is.
    ///
    /// `timestamp` is the key of the beacon roots contract that holds the root of `header`. The caller has checked
    /// that `self.root()` equals `header.state_root`.
    ///
    /// # Errors
    /// `Error::Beacon` when the state root differs from the header.
    pub fn fork_evidence(&self, timestamp: u64, header: &BeaconBlockHeader) -> Result<Vec<u8>> {
        if self.root() != header.state_root {
            return Err(Error::Beacon("the state does not belong to the header".into()));
        }
        Ok(fork_evidence_bytes(timestamp, header, self.state.fork, &self.state.field_roots))
    }

    /// Branch for `finalized_checkpoint.root`: the epoch chunk, then the field branch.
    pub fn finality_branch(&self) -> Vec<B256> {
        let mut branch = vec![u64_chunk(self.state.finalized_checkpoint.0)];
        branch.extend(branch_for_leaf(&self.state.field_roots, STATE_FIELD_FINALIZED_CHECKPOINT).1);
        branch
    }

    /// Branch for `next_sync_committee`.
    pub fn next_committee_branch(&self) -> Vec<B256> {
        branch_for_leaf(&self.state.field_roots, STATE_FIELD_NEXT_SYNC_COMMITTEE).1
    }

    /// Branch for `current_sync_committee`.
    pub fn current_committee_branch(&self) -> Vec<B256> {
        branch_for_leaf(&self.state.field_roots, STATE_FIELD_CURRENT_SYNC_COMMITTEE).1
    }
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
        let block =
            guarded("beacon block", || try_parse_signed_block(bytes))?
                .map_err(|error| Error::Malformed(format!("beacon block: {error}")))?;
        guarded("beacon block", || {
            let (_, execution_branch) = branch_for_leaf(&block.body_field_roots, BODY_FIELD_EXECUTION_PAYLOAD);
            let leaves = block
                .payload
                .field_roots(lc_core::layout::ExecutionHeaderForm::Capella)
                .expect("payload leaves");
            let (_, mut block_hash_branch) = branch_for_leaf(&leaves, PAYLOAD_FIELD_BLOCK_HASH);
            block_hash_branch.extend(&execution_branch);
            Self { header: block.header, payload: block.payload, execution_branch, block_hash_branch }
        })
    }

    /// The block as a light-client header.
    pub fn as_light_client_header(&self) -> LightClientHeader {
        LightClientHeader {
            beacon: self.header,
            execution: self.payload.clone(),
            execution_branch: self.execution_branch.clone(),
        }
    }
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
pub fn store_at(header: &BeaconBlockHeader, state: &StateView, include_next: bool) -> LightClientStore {
    LightClientStore {
        header_root: header.hash_tree_root(),
        header_slot: header.slot,
        current_sync_committee: state.current_committee().clone(),
        next_sync_committee: include_next.then(|| state.next_committee().clone()),
    }
}

// ------------------------------------------------------------------ ancestry and gate helpers

/// Which ancestry path the vault takes for two slots. The prover never chooses; it builds what the vault expects.
///
/// # Errors
/// `Error::Beacon` when the deposit slot is not before the anchor slot.
pub fn ancestry_path(anchor_slot: u64, deposit_slot: u64) -> Result<AncestryPath> {
    lc_core::ancestry::ancestry_path_for_slots(anchor_slot, deposit_slot).map_err(|error| Error::Beacon(error.to_string()))
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

/// `abi.encode(ForkEvidence)` for the gate, from the fields of a state. The version is `fork.current_version`.
///
/// The branch is built by `lc_core::gate::fork_version_branch`, and its index is the one that `BeaconForkGate`
/// computes for itself. `field_roots` are the roots of all state fields; entry 3 must be the root of `fork`.
///
/// # Panics
/// Panics when entry 3 of `field_roots` is not the root of `fork`.
pub fn fork_evidence_bytes(timestamp: u64, header: &BeaconBlockHeader, fork: ForkData, field_roots: &[B256]) -> Vec<u8> {
    let branch = lc_core::gate::fork_version_branch(field_roots, &fork);
    lc_core::gate::encode_fork_evidence(timestamp, header, fork.current_version, branch)
}

// ------------------------------------------------------------------ synthetic beacon data for Anvil

/// A synthetic beacon header over a real execution block, with the branch to its block hash.
#[cfg(feature = "dev-source")]
#[derive(Clone, Debug)]
pub struct DevHeader {
    /// The header.
    pub header: BeaconBlockHeader,
    /// Branch from the execution block hash to `header.body_root`.
    pub block_hash_branch: Vec<B256>,
}

/// Builds a synthetic header at `slot` whose body holds the execution block `block_hash`.
///
/// The body, the parent root and the proposer are fixed functions of the arguments, so the same arguments always
/// give the same header root. The caller passes the state root.
#[cfg(feature = "dev-source")]
pub fn dev_header(
    chain: ChainKind,
    slot: u64,
    block_number: u64,
    block_hash: B256,
    state_root: B256,
) -> DevHeader {
    let spec = chain.spec();
    let payload = synthetic_payload_header(spec, slot, block_number, block_hash, keccak256(b"dev-receipts"));
    let body = build_body_proofs(spec, slot, &payload);
    DevHeader {
        header: BeaconBlockHeader {
            slot,
            proposer_index: 0,
            parent_root: keccak256(format!("dev-parent/{slot}")),
            state_root,
            body_root: body.body_root,
        },
        block_hash_branch: body.block_hash_branch,
    }
}

/// The root of a synthetic header whose state is not interesting (a filler state root).
#[cfg(feature = "dev-source")]
pub fn dev_plain_state_root(slot: u64) -> B256 {
    keccak256(format!("dev-state/{slot}"))
}

/// A synthetic state for an anchor: `block_roots` holds the given `(slot, header root)` pairs.
#[cfg(feature = "dev-source")]
pub struct DevState {
    builder: StateBuilder,
}

#[cfg(feature = "dev-source")]
impl DevState {
    /// Builds a state for the fork at `slot`.
    ///
    /// # Errors
    /// `Error::Beacon` when the fork at `slot` is not supported by the synthetic builder.
    pub fn new(chain: ChainKind, slot: u64, roots: &[(u64, B256)]) -> Result<Self> {
        let fork = chain.spec().fork_at_slot(slot);
        if lc_core::layout::state_layout_for_fork(fork).is_err() || fork < lc_core::chain::ForkName::Capella {
            return Err(Error::Beacon(format!("slot {slot} is in fork {fork:?}; use a slot after the Capella fork")));
        }
        let mut builder = guarded("synthetic state", || StateBuilder::new(fork))?;
        for (root_slot, root) in roots {
            builder.set_block_root(*root_slot, *root);
        }
        Ok(Self { builder })
    }

    /// The state root.
    pub fn root(&self) -> B256 {
        self.builder.root()
    }

    /// Branch for `block_roots[slot % 8192]`.
    pub fn ancestry_branch(&self, slot: u64) -> Vec<B256> {
        self.builder.block_roots_branch(slot)
    }

    /// Makes `historical_summaries` hold `count` entries and sets `block_roots[slot % 8192]` of the era at list position
    /// `index` to `root`. The tests use it to build the historical ancestry path. Other slots of that era hold filler.
    ///
    /// # Panics
    /// Panics when `index >= count`.
    pub fn set_historical_root(&mut self, count: usize, index: usize, slot: u64, root: B256) {
        self.builder.set_historical_block_root(count, index, slot, root);
    }

    /// Branch for the historical path of `slot`, in the era at list position `index`.
    ///
    /// # Panics
    /// Panics when no root was set in that era (see [`DevState::set_historical_root`]).
    pub fn historical_branch(&self, index: usize, slot: u64) -> Vec<B256> {
        self.builder.historical_ancestry_branch(index, slot)
    }
}

/// The output that `DevBeaconSource` asserts for a synthetic head. No signature exists on Anvil.
///
/// The fields `previous*` and the committee hashes come from the contract (`start_next_committee_hash` is
/// `syncCommittees(period + 1)` of the head period).
#[cfg(feature = "dev-source")]
#[allow(clippy::too_many_arguments)]
pub fn dev_output(
    genesis_validators_root: B256,
    previous_head_slot: u64,
    previous_header_root: B256,
    previous_committee_hash: B256,
    start_next_committee_hash: B256,
    new_header_root: B256,
    new_head_slot: u64,
    execution_block_hash: B256,
    execution_block_number: u64,
) -> LightClientOutput {
    LightClientOutput {
        genesisValidatorsRoot: genesis_validators_root,
        previousHeaderRoot: previous_header_root,
        previousHeadSlot: previous_head_slot,
        previousSyncCommitteeHash: previous_committee_hash,
        startNextSyncCommitteeHash: start_next_committee_hash,
        newHeaderRoot: new_header_root,
        newHeadSlot: new_head_slot,
        executionBlockHash: execution_block_hash,
        executionBlockNumber: execution_block_number,
        syncCommitteeHash: previous_committee_hash,
        nextSyncCommitteeHash: B256::ZERO,
    }
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

/// The `slot` of a beacon header JSON-free pair, used by the beacon sources for readable errors.
pub fn describe_header(header: &BeaconBlockHeader) -> String {
    format!("slot {} root {:#x}", header.slot, header.hash_tree_root())
}

/// Synthetic beacon states for unit tests of this crate.
#[cfg(test)]
pub(crate) mod test_support {
    use super::*;
    use lc_core::ssz::{hash_pair, merkleize, merkleize_with_limit, mix_in_length};

    /// A Capella-layout state whose `block_roots`, `fork` and `historical_summaries` the test controls. `eras` holds
    /// the 8192 block roots of each complete era, in list order. All other fields hold filler.
    pub fn synthetic_state(anchor_slot: u64, fork: ForkData, eras: &[Vec<B256>]) -> StateView {
        let block_roots: Vec<B256> = (0..8192u64).map(|slot| keccak256(format!("recent/{slot}"))).collect();
        let historical_summaries: Vec<(B256, B256)> = eras
            .iter()
            .enumerate()
            .map(|(index, roots)| (merkleize(roots), keccak256(format!("state-summary/{index}"))))
            .collect();
        let summary_roots: Vec<B256> = historical_summaries.iter().map(|(b, s)| hash_pair(b, s)).collect();
        let mut field_roots: Vec<B256> = (0..28u64).map(|field| keccak256(format!("field/{field}"))).collect();
        field_roots[3] = fork.hash_tree_root();
        field_roots[5] = merkleize(&block_roots);
        field_roots[27] =
            mix_in_length(&merkleize_with_limit(&summary_roots, 1 << 24), historical_summaries.len() as u64);
        let committee = SyncCommittee { pubkeys: Vec::new(), aggregate_pubkey: Default::default() };
        StateView::from_parsed(ParsedState {
            field_roots,
            block_roots,
            current_sync_committee: committee.clone(),
            next_sync_committee: committee,
            slot: anchor_slot,
            fork,
            finalized_checkpoint: (0, B256::ZERO),
            historical_summaries,
        })
        .expect("a Capella layout")
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Claim: the deposit topic equals the real signature hash `0x9bab...eaf5`, not a hardcoded wrong constant.
    /// Why it matters: the scanner filters logs on this topic; a wrong one finds no deposit.
    #[test]
    fn deposit_topic_is_the_signature_hash() {
        assert_eq!(DEPOSIT_EVENT_TOPIC, keccak256("DepositInitiated(address,address,address,uint256,bytes32,uint64)"));
    }

    /// Claim: a synthetic header is a pure function of its arguments.
    /// Why it matters: a restarted service must rebuild the same header root that the light client stored.
    #[cfg(feature = "dev-source")]
    #[test]
    fn dev_header_is_deterministic() {
        let chain = ChainKind::Pulsechain;
        let one = dev_header(chain, 2000, 5, B256::repeat_byte(1), dev_plain_state_root(2000));
        let two = dev_header(chain, 2000, 5, B256::repeat_byte(1), dev_plain_state_root(2000));
        assert_eq!(one.header.hash_tree_root(), two.header.hash_tree_root());
        let other = dev_header(chain, 2000, 5, B256::repeat_byte(2), dev_plain_state_root(2000));
        assert_ne!(one.header.hash_tree_root(), other.header.hash_tree_root());
    }

    /// Claim: the gate evidence built from a synthetic state decodes as `ForkEvidence`, carries the current version
    /// (not the previous one), and its branch verifies at the generalized index that `BeaconForkGate` computes for
    /// depth 5, under the state root of the header. A header of another state is refused.
    /// Why it matters: the gate decodes these bytes and computes the index itself. A byte or an index off by one
    /// reverts every first deposit of an epoch.
    #[test]
    fn gate_evidence_decodes_and_verifies_like_the_gate() {
        use alloy_sol_types::SolValue;
        let fork = ForkData { previous_version: [2, 0, 0, 0], current_version: [3, 0, 0, 0], epoch: 3 };
        let state = test_support::synthetic_state(100_000, fork, &[]);
        let header = BeaconBlockHeader {
            slot: 4242,
            proposer_index: 7,
            parent_root: keccak256(b"parent"),
            state_root: state.root(),
            body_root: keccak256(b"body"),
        };
        let bytes = state.fork_evidence(1_700_000_123, &header).unwrap();
        let decoded = lc_core::gate::ForkEvidence::abi_decode(&bytes).unwrap();
        assert_eq!(decoded.timestamp, U256::from(1_700_000_123u64));
        assert_eq!(decoded.header.slot, 4242);
        assert_eq!(decoded.header.stateRoot, state.root());
        assert_eq!(decoded.version.0, [3, 0, 0, 0]);
        assert_eq!(decoded.branch.len(), 2 + 5);
        let gindex = (32 + 3) * 4 + 1;
        let leaf = lc_core::gate::version_leaf(decoded.version.0);
        assert!(lc_core::ssz::is_valid_exact_branch(&leaf, &decoded.branch, gindex, &state.root()));
        let previous = lc_core::gate::version_leaf(fork.previous_version);
        assert!(!lc_core::ssz::is_valid_exact_branch(&previous, &decoded.branch, gindex, &state.root()));

        let other = BeaconBlockHeader { state_root: B256::repeat_byte(1), ..header };
        assert!(state.fork_evidence(1, &other).is_err());
    }

    // ---------------------------------------------------------------- real historical paths

    const ANCHOR_AND_ERA_FIXTURE: &str = "../light-client/tests/fixtures/pulsechain";

    fn fixture(name: &str) -> Value {
        let path = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join(ANCHOR_AND_ERA_FIXTURE).join(name);
        let text = std::fs::read_to_string(&path).unwrap_or_else(|error| panic!("{}: {error}", path.display()));
        let wrapper: Value = serde_json::from_str(&text).expect("fixture json");
        wrapper["response"].clone()
    }

    fn hex_branch(value: &Value) -> Vec<B256> {
        value.as_array().expect("branch").iter().map(|item| item.as_str().expect("hex").parse().expect("b256")).collect()
    }

    struct RealHistorical {
        anchor: BeaconBlockHeader,
        paths: Value,
    }

    impl RealHistorical {
        fn load() -> Self {
            let paths = fixture("historical_paths.json");
            let anchor = beacon_header_from_json(&paths["anchor_header"]).expect("anchor");
            assert_eq!(header_root(&anchor), paths["anchor_header_root"].as_str().unwrap().parse::<B256>().unwrap());
            Self { anchor, paths }
        }

        fn entry(&self, name: &str) -> &Value {
            self.paths["entries"].as_array().unwrap().iter().find(|entry| entry["name"] == name).expect("entry")
        }

        fn path(&self, name: &str) -> BeaconPath {
            let entry = self.entry(name);
            BeaconPath {
                anchor_header: self.anchor,
                deposit_header: beacon_header_from_json(&entry["deposit_header"]).expect("deposit header"),
                ancestry_branch: hex_branch(&entry["ancestry_branch"]),
                block_hash_branch: hex_branch(&entry["block_hash_branch"]),
            }
        }
    }

    fn middle_block_evidence() -> ExecutionEvidence {
        let block = fixture("path_historical_block.json");
        let receipts = fixture("path_historical_receipts.json");
        build_execution_evidence(&block, &receipts, 0).expect("the real block rebuilds and its receipts root matches")
    }

    /// Claim: for the real PulseChain anchor, the service classifies each fixture deposit by distance: five of them
    /// lie more than 8192 slots below the anchor (historical path), and `era_last_block` lies 5117 slots below it
    /// (recent path), although the fixture also holds a historical branch for it.
    /// Why it matters: the vault, not the service, chooses the path. A service that built the historical branch for a
    /// recent distance would send a withdrawal that reverts.
    #[test]
    fn real_fixture_deposits_are_classified_by_distance() {
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
            let found = ancestry_path(path.anchor_header.slot, path.deposit_header.slot).unwrap();
            assert_eq!(found, expected, "{name}: distance {}", path.anchor_header.slot - path.deposit_header.slot);
        }
        assert!(ancestry_path(100, 100).is_err(), "a deposit at the anchor slot has no path");
    }

    /// Claim: the real historical branches pass the vault check of `lc-core` through the service functions: the
    /// service rebuilds the real execution block and its receipts proof, assembles the calldata struct, and native
    /// verification passes the anchor, the 44-entry historical ancestry branch, the block hash branch, the header
    /// hash and the receipt proof. It stops at the log stage, because a real block holds no deposit event of a bridge.
    /// Why it matters: this is the withdrawal that the service sends for a deposit older than 8192 slots. The controls
    /// show each earlier check can fail: a branch of another era, a padded branch and an unknown anchor all stop earlier.
    #[test]
    fn real_historical_withdrawal_passes_native_verification_up_to_the_log() {
        let real = RealHistorical::load();
        let path = real.path("era_middle_block");
        assert_eq!(path.ancestry_branch.len(), 44);
        let execution = middle_block_evidence();
        let proof = assemble_withdrawal_proof(&path, &execution, 0, 0);
        let context = VaultContext {
            remote_vault: Address::repeat_byte(0xee),
            local_chain_id: 1,
            stored_anchor_root: header_root(&real.anchor),
        };
        let reason = |proof: &WithdrawalProof, context: &VaultContext| match verify_withdrawal_natively(proof, context, ChainKind::Pulsechain) {
            Ok(_) => "accepted".to_string(),
            Err(Error::VerificationRefused(text)) => text,
            Err(other) => panic!("unexpected error {other}"),
        };
        let at_log = reason(&proof, &context);
        assert!(
            at_log.contains("LogEmitterMismatch") || at_log.contains("LogIndexOutOfRange"),
            "the check passes the ancestry and the receipt proof and stops at the log: {at_log}"
        );

        let mut other_era = proof.clone();
        other_era.ancestryBranch = hex_branch(&real.entry("era_first_block")["ancestry_branch"]);
        assert!(reason(&other_era, &context).contains("InvalidAncestryBranch"), "a branch of another entry");
        let mut padded = proof.clone();
        padded.ancestryBranch.insert(0, B256::ZERO);
        assert!(reason(&padded, &context).contains("InvalidAncestryBranch"), "a padded branch");
        let unknown = VaultContext { stored_anchor_root: B256::repeat_byte(9), ..context };
        assert!(reason(&proof, &unknown).contains("AnchorNotStored"));
        let mut wrong_block = proof.clone();
        wrong_block.blockHashBranch = hex_branch(&real.entry("era_first_block")["block_hash_branch"]);
        assert!(reason(&wrong_block, &context).contains("InvalidBlockHashBranch"));
    }

    /// Claim: the real fixture agrees with the gindex helpers of the service: the historical summaries field of the
    /// Capella layout is gindex 59, and the era of the middle block is 1326, with `capellaEra` 0 on PulseChain.
    #[test]
    fn real_fixture_matches_the_layout_constants() {
        let real = RealHistorical::load();
        assert_eq!(historical_summaries_gindex(ChainKind::Pulsechain, real.anchor.slot).unwrap(), 59);
        let middle = real.path("era_middle_block");
        assert_eq!(era_of(middle.deposit_header.slot), 1326);
        assert_eq!(real.entry("era_middle_block")["index"], 1326);
        assert_eq!(ChainKind::Pulsechain.spec().capella_era().unwrap(), 0);
        let leaf = lc_core::ancestry::ancestry_leaf_gindex(ChainKind::Pulsechain.spec(), real.anchor.slot, middle.deposit_header.slot).unwrap();
        assert!(lc_core::ssz::is_valid_exact_branch(
            &header_root(&middle.deposit_header),
            &middle.ancestry_branch,
            leaf,
            &real.anchor.state_root
        ));
    }
}
