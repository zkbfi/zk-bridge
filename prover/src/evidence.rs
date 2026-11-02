//! The message evidence builder: a message in, the calldata of `MessageBridge.executeMessage` out.
//!
//! Delivering a message needs no zero-knowledge proof. The destination bridge checks the evidence itself: the receipt and
//! the transaction of the message in a source block, the path from that block to a beacon header, and the path from that
//! header up to an anchor header that the destination light client stored. This module builds that evidence for one
//! message, which the caller names by the hash of the source transaction and the index of the log inside its receipt.
//!
//! The builder reads two execution chains, one beacon node and the destination light client. It sends nothing and holds no
//! key. It checks its own work before it returns:
//!
//! - the contracts point at each other the way the configuration says (a name is a hypothesis, so the builder reads
//!   `remoteBridge`, `remoteChainId`, `localChainId` and `lightClient` from the destination bridge);
//! - the log is a `UserRequestForAffirmation` event of the configured source bridge, for the chains of the route;
//! - the evidence passes the bridge checks, run natively with `lc-core` against the anchor root that the light client
//!   stores. The native check proves the transaction hash too, so the evidence names the transaction that was asked for;
//! - the message that the evidence proves equals the message that the log shows.
//!
//! The bridge also needs a validated layout row for each generalized index that the evidence uses. Anyone may add a row,
//! and the chain validates it. When rows are missing, the result lists the calls that add them, in the order to send them.

use crate::beacon::http::HttpBeaconSource;
use crate::beacon::{SourceBlock, StoredHead};
use crate::chain::{raw_header_from_sources, ChainClient, RawLog};
use crate::contracts::{
    BlockHashEvidence, BlockRootsEvidence, BodyLayoutRow, HistoricalSummariesEvidence,
    MessageBridgeContract, StateLayoutRow,
};
use crate::error::{Error, Result};
use crate::handoff::utc_time_text;
use crate::light_client::{
    ancestry_path, assemble_message_proof, build_execution_evidence,
    build_execution_evidence_from_raw_header, decode_message_log, message_calldata,
    to_layout_header, verify_message_natively, AncestryPath, BeaconHeader, BridgeContext,
    SourceMessage, USER_REQUEST_TOPIC,
};
use crate::logging::redact_urls;
use crate::rpc::parse_quantity;
use crate::stored::{read_stored_header, read_stored_slots, read_stored_state};
use alloy_primitives::{hex, Address, B256, U256};
use alloy_sol_types::SolCall;
use lc_core::chain::ForkName;
use lc_core::message::VerifiedMessage;
use serde::{Deserialize, Serialize};

/// The version of the evidence shape. A change that removes or renames a key raises it.
pub const SCHEMA_VERSION: u32 = 2;

/// One call that a server sends: a contract and calldata.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Call {
    /// The contract that receives the call.
    pub to: String,
    /// The calldata, `0x` hex.
    pub data: String,
}

/// A call that must succeed before the message can be delivered.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Prerequisite {
    /// The function of the bridge: `addBlockRootsLayout`, `addHistoricalSummariesLayout` or `addBlockHashLayout`.
    pub function: String,
    /// Why the call is needed.
    pub reason: String,
    /// The call.
    #[serde(flatten)]
    pub call: Call,
}

/// The message that the log shows.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct MessageSummary {
    /// The message identifier, which the destination bridge marks as delivered.
    pub message_id: String,
    /// The contract that sent the message on the source chain.
    pub sender: String,
    /// The target contract on the destination chain.
    pub executor: String,
    /// The gas that the target gets.
    pub gas_limit: u32,
    /// The data type byte of the message: 0 for `requireToPassMessage`, 128 for `requireToConfirmMessage`.
    pub data_type: u8,
    /// The call data for the target, `0x` hex.
    pub data: String,
    /// The number of the source block that holds the message.
    pub source_block_number: u64,
    /// The hash of that block.
    pub source_block_hash: String,
    /// The beacon slot of that block.
    pub source_slot: u64,
}

/// The anchor header that the destination light client stores.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct AnchorSummary {
    /// The slot of the anchor.
    pub slot: u64,
    /// The header root that the light client stores for the slot.
    pub root: String,
}

/// The destination bridge and chain.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct EvidenceDestination {
    /// The chain identifier.
    pub chain_id: u64,
    /// The bridge that delivers the message.
    pub bridge: String,
    /// The light client that stores the anchor.
    pub light_client: String,
}

/// What the destination bridge records about a message. Delivery is final: the bridge marks the message before it calls
/// the target, and the mark stays whether the call succeeds or reverts.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum DeliveryStatus {
    /// The bridge never executed the message. A delivery can still happen.
    NotDelivered,
    /// The bridge executed the message and the call to the target succeeded.
    Succeeded,
    /// The bridge executed the message and the call to the target failed. The delivery cannot repeat.
    Failed,
}

/// The evidence for one message, with everything a server needs to send it.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct MessageEvidence {
    /// The version of this shape ([`SCHEMA_VERSION`]).
    pub schema_version: u32,
    /// The name of the route.
    pub route: String,
    /// The hash of the source transaction that sent the message.
    pub source_transaction_hash: String,
    /// The index of the `UserRequestForAffirmation` log inside the receipt of that transaction.
    pub log_index: u64,
    /// The message.
    pub message: MessageSummary,
    /// The destination.
    pub destination: EvidenceDestination,
    /// The anchor.
    pub anchor: AnchorSummary,
    /// What the destination bridge records about the message now.
    pub delivery_status: DeliveryStatus,
    /// Whether the destination bridge already executed this message, with success or with failure. When it did, the
    /// call to `executeMessage` would revert.
    pub already_delivered: bool,
    /// The `executeMessage` call.
    pub execute: Call,
    /// The layout calls to send first, in order. Empty when the bridge has every row it needs. After each call, read the
    /// layout views of the bridge again: the calls for one function are alternatives, and the rest can be skipped as soon
    /// as a row covers the slot.
    pub prerequisites: Vec<Prerequisite>,
    /// When the evidence was built, as a time in UTC, such as `2026-10-24T09:30:00Z`.
    pub created_at: String,
}

/// Everything that names one message.
pub struct EvidenceRequest<'a> {
    /// The name of the route, for the result.
    pub route: &'a str,
    /// The source chain, which holds the message.
    pub source: &'a ChainClient,
    /// The destination chain, which holds the bridge and the light client.
    pub destination: &'a ChainClient,
    /// The beacon node of the source chain.
    pub beacon: &'a HttpBeaconSource,
    /// The bridge on the source chain.
    pub source_bridge: Address,
    /// The bridge on the destination chain.
    pub destination_bridge: Address,
    /// The light client on the destination chain.
    pub light_client: Address,
    /// More nodes of the source chain, asked in order for the raw header of a Gloas source block when `source` does not give
    /// it. Each is named `source.header_rpc_urls[i]`.
    pub source_header_sources: &'a [ChainClient],
    /// The hash of the source transaction that sent the message.
    pub transaction: B256,
    /// The index of the `UserRequestForAffirmation` log inside the receipt of that transaction.
    pub log_index: u64,
    /// The stored header to anchor at. `None` anchors at the head of the light client.
    pub anchor_slot: Option<u64>,
    /// The block where the light client was deployed. The scan for stored heads starts here.
    pub destination_start_block: u64,
    /// The largest block range of one log call.
    pub log_block_range: u64,
    /// The time of the run, in seconds since 1970-01-01.
    pub now_unix_seconds: u64,
}

/// Builds the evidence for one message. See the module documentation for the checks.
///
/// # Errors
/// `Error::Config` when the contracts do not point at each other as the configuration says. `Error::Usage` when the
/// transaction has no such log, when the log is not a message for this route, or when the light client stores no header at
/// the requested anchor slot. `Error::Beacon` when the anchor does not yet cover the source block, when the beacon node
/// lacks data, or when the stored headers do not yet allow a layout row. `Error::VerificationRefused` when the evidence
/// fails the native bridge check.
pub fn build_evidence(request: &EvidenceRequest<'_>) -> Result<MessageEvidence> {
    check_wiring(request)?;
    let (log, message) = locate_message(request)?;
    let anchor = choose_anchor(request)?;

    let block_json = request
        .source
        .block(log.block_number)?
        .ok_or_else(|| Error::Malformed(format!("source block {} is unknown", log.block_number)))?;
    let receipts = request
        .source
        .block_receipts(log.block_number, &block_json)?;
    let transactions = request.source.block_raw_transactions(&block_json)?;
    let timestamp = parse_quantity(&block_json["timestamp"])?;
    let execution = match request.beacon.is_gloas_source(timestamp)? {
        // A Gloas header has more items than the JSON rebuilder knows: read it raw.
        true => build_execution_evidence_from_raw_header(
            source_raw_header(request, log.block_hash)?,
            &receipts,
            &transactions,
            log.transaction_index,
        )?,
        false => {
            build_execution_evidence(&block_json, &receipts, &transactions, log.transaction_index)?
        }
    };
    if execution.block_hash != log.block_hash {
        return Err(Error::Malformed(
            "the source block hash differs from the block hash of the log".into(),
        ));
    }
    let source_block = SourceBlock {
        number: log.block_number,
        hash: log.block_hash,
        timestamp,
    };
    let path = request.beacon.message_path(&source_block, &anchor)?;
    require_gloas_fork_slot(request, path.source_header.slot)?;
    let proof = assemble_message_proof(&path, &execution, log.transaction_index, request.log_index);
    let context = BridgeContext {
        remote_bridge: request.source_bridge,
        remote_chain_id: request.source.chain_id(),
        local_chain_id: request.destination.chain_id(),
        stored_anchor_root: anchor.root,
    };
    let verified = verify_message_natively(&proof, &context, request.beacon.chain_kind())?;
    require_proven_message(&verified, &message, request.transaction)?;

    let stored_slots = read_stored_slots(
        request.destination,
        request.light_client,
        request.destination_start_block,
        request.log_block_range,
    )?;
    let prerequisites = layout_prerequisites(
        request,
        &path.anchor_header,
        path.source_header.slot,
        &stored_slots,
    )?;
    let delivery_status = read_delivery_status(request, message.header.message_id)?;
    Ok(MessageEvidence {
        schema_version: SCHEMA_VERSION,
        route: request.route.to_string(),
        source_transaction_hash: format!("{:#x}", request.transaction),
        log_index: request.log_index,
        message: MessageSummary {
            message_id: format!("{:#x}", message.header.message_id),
            sender: format!("{:#x}", message.header.sender),
            executor: format!("{:#x}", message.header.executor),
            gas_limit: message.header.gas_limit,
            data_type: message.header.data_type,
            data: hex::encode_prefixed(&message.data),
            source_block_number: log.block_number,
            source_block_hash: format!("{:#x}", log.block_hash),
            source_slot: path.source_header.slot,
        },
        destination: EvidenceDestination {
            chain_id: request.destination.chain_id(),
            bridge: format!("{:#x}", request.destination_bridge),
            light_client: format!("{:#x}", request.light_client),
        },
        anchor: AnchorSummary {
            slot: anchor.slot,
            root: format!("{:#x}", anchor.root),
        },
        delivery_status,
        already_delivered: delivery_status != DeliveryStatus::NotDelivered,
        execute: Call {
            to: format!("{:#x}", request.destination_bridge),
            data: hex::encode_prefixed(message_calldata(&proof)),
        },
        prerequisites,
        created_at: utc_time_text(request.now_unix_seconds),
    })
}

/// The raw header of a Gloas source block: from the main source RPC, then from each `source.header_rpc_urls` entry in order
/// ([`raw_header_from_sources`]). A Gloas header has fields that the JSON of the block does not show, so a rebuild from that
/// JSON cannot stand in for it; a block before Gloas never comes here, it is rebuilt from its JSON.
///
/// # Errors
/// `Error::Malformed` when no source gives a header with the block hash. The message names each source (`source.rpc_url`,
/// `source.header_rpc_urls[i]`) with its cause, and no URL.
fn source_raw_header(request: &EvidenceRequest<'_>, block_hash: B256) -> Result<Vec<u8>> {
    raw_header_from_sources(request.source, request.source_header_sources, block_hash).map_err(
        |failures| {
            Error::Malformed(redact_urls(&format!(
                "the source header: no source gave a header with the block hash {block_hash:#x} ({}); a Gloas header needs a node with debug_getRawHeader in source.rpc_url or source.header_rpc_urls",
                failures.join("; ")
            )))
        },
    )
}

/// A source header at or after the Gloas fork is proven through the bid, and the bridge applies that rule only from its
/// immutable `gloasForkSlot` on. A bridge with a later fork slot would take the layout path and refuse the proof.
fn require_gloas_fork_slot(request: &EvidenceRequest<'_>, source_slot: u64) -> Result<()> {
    if request.beacon.chain_kind().spec().fork_at_slot(source_slot) < ForkName::Gloas {
        return Ok(());
    }
    let fork_slot = request.destination.view(
        request.destination_bridge,
        MessageBridgeContract::gloasForkSlotCall {},
    )?;
    if fork_slot <= source_slot {
        return Ok(());
    }
    Err(Error::Config(format!(
        "route {}: the source block is in slot {source_slot}, a Gloas slot, but the destination bridge has gloasForkSlot {fork_slot}; it would take the layout path and refuse the proof",
        request.route
    )))
}

/// Reads the four relations between the destination bridge and the rest from the bridge itself, and compares them with
/// the configuration. A bridge that points at other contracts would deliver or refuse for the wrong reasons.
fn check_wiring(request: &EvidenceRequest<'_>) -> Result<()> {
    let bridge = request.destination_bridge;
    let mismatch = |what: &str, expected: String, actual: String| {
        Error::Config(format!(
            "route {}: {what} is {actual}, the configuration says {expected}",
            request.route
        ))
    };
    let remote_bridge = request
        .destination
        .view(bridge, MessageBridgeContract::remoteBridgeCall {})?;
    if remote_bridge != request.source_bridge {
        return Err(mismatch(
            "destination bridge remoteBridge",
            request.source_bridge.to_string(),
            remote_bridge.to_string(),
        ));
    }
    let remote_chain = request
        .destination
        .view(bridge, MessageBridgeContract::remoteChainIdCall {})?;
    if remote_chain != request.source.chain_id() {
        return Err(mismatch(
            "destination bridge remoteChainId",
            request.source.chain_id().to_string(),
            remote_chain.to_string(),
        ));
    }
    let local_chain = request
        .destination
        .view(bridge, MessageBridgeContract::localChainIdCall {})?;
    if local_chain != request.destination.chain_id() {
        return Err(mismatch(
            "destination bridge localChainId",
            request.destination.chain_id().to_string(),
            local_chain.to_string(),
        ));
    }
    let light_client = request
        .destination
        .view(bridge, MessageBridgeContract::lightClientCall {})?;
    if light_client != request.light_client {
        return Err(mismatch(
            "destination bridge lightClient",
            request.light_client.to_string(),
            light_client.to_string(),
        ));
    }
    Ok(())
}

/// Finds the log in the receipt, and decodes it. The log must be a message of the source bridge from the source chain to
/// the destination chain of the route.
fn locate_message(request: &EvidenceRequest<'_>) -> Result<(RawLog, SourceMessage)> {
    let receipt = request
        .source
        .transaction_receipt(request.transaction)?
        .ok_or_else(|| {
            Error::Usage(format!(
                "the source chain has no receipt for transaction {:#x}",
                request.transaction
            ))
        })?;
    let entry = receipt["logs"]
        .as_array()
        .and_then(|logs| logs.get(request.log_index as usize))
        .ok_or_else(|| {
            Error::Usage(format!(
                "the receipt of {:#x} has no log at index {}",
                request.transaction, request.log_index
            ))
        })?;
    let log = RawLog::from_json(entry)?;
    require_route_message(request, &log)?;
    let message = decode_message_log(log.address, &log.topics, &log.data, request.source_bridge)?;
    let source_chain = U256::from(request.source.chain_id());
    if message.header.source_chain_id != source_chain {
        return Err(Error::Usage(format!(
            "the message is from chain {}, not from the source chain {source_chain}",
            message.header.source_chain_id
        )));
    }
    let destination_chain = U256::from(request.destination.chain_id());
    if message.header.destination_chain_id != destination_chain {
        return Err(Error::Usage(format!(
            "the message is for chain {}, not for the destination chain {destination_chain}",
            message.header.destination_chain_id
        )));
    }
    Ok((log, message))
}

fn require_route_message(request: &EvidenceRequest<'_>, log: &RawLog) -> Result<()> {
    if log.address != request.source_bridge {
        return Err(Error::Usage(format!(
            "log {} of {:#x} comes from {:#x}, not from the source bridge {:#x}",
            request.log_index, request.transaction, log.address, request.source_bridge
        )));
    }
    if log.topics.first() != Some(&USER_REQUEST_TOPIC) {
        return Err(Error::Usage(format!(
            "log {} of {:#x} is not a UserRequestForAffirmation event",
            request.log_index, request.transaction
        )));
    }
    Ok(())
}

/// Checks that the message that the native check proved is the message of the log, and that the proven transaction is the
/// transaction that the caller named. A proof for another message or another transaction would be wrong evidence.
fn require_proven_message(
    verified: &VerifiedMessage,
    message: &SourceMessage,
    transaction: B256,
) -> Result<()> {
    if verified.header != message.header || verified.data != message.data {
        return Err(Error::VerificationRefused(
            "the proven message differs from the message in the log".into(),
        ));
    }
    if verified.source_transaction_hash != transaction {
        return Err(Error::VerificationRefused(format!(
            "the proof names transaction {:#x}, not the transaction {transaction:#x} that was asked for",
            verified.source_transaction_hash
        )));
    }
    Ok(())
}

/// Reads what the destination bridge records about a message.
///
/// The bridge has no public view of its delivery state, so this reads two views that together give it.
/// `messageCallStatus` is true only after a call that succeeded. A call that failed leaves `failedMessageDataHash`, the
/// keccak256 of the call data, which is never zero. Neither view tells a message in progress from one that was never
/// delivered. That state lasts only inside the call to the target, so an `eth_call` at the latest block never sees it.
fn read_delivery_status(request: &EvidenceRequest<'_>, message_id: B256) -> Result<DeliveryStatus> {
    let bridge = request.destination_bridge;
    let succeeded = request.destination.view(
        bridge,
        MessageBridgeContract::messageCallStatusCall {
            messageId: message_id,
        },
    )?;
    if succeeded {
        return Ok(DeliveryStatus::Succeeded);
    }
    let failed_data_hash = request.destination.view(
        bridge,
        MessageBridgeContract::failedMessageDataHashCall {
            messageId: message_id,
        },
    )?;
    if failed_data_hash != B256::ZERO {
        return Ok(DeliveryStatus::Failed);
    }
    Ok(DeliveryStatus::NotDelivered)
}

/// The anchor: the requested stored header, or else the head of the light client.
fn choose_anchor(request: &EvidenceRequest<'_>) -> Result<StoredHead> {
    let state = read_stored_state(request.destination, request.light_client)?;
    let Some(slot) = request.anchor_slot else {
        return Ok(state.head);
    };
    let root =
        read_stored_header(request.destination, request.light_client, slot)?.ok_or_else(|| {
            Error::Usage(format!(
                "the light client {:#x} stores no header at slot {slot}",
                request.light_client
            ))
        })?;
    Ok(StoredHead {
        slot,
        root,
        next_committee_hash: B256::ZERO,
    })
}

/// Whether a validated row covers the slot.
fn covers(first_slot: u64, last_slot: u64, slot: u64) -> bool {
    first_slot <= slot && slot <= last_slot
}

fn state_rows_cover(rows: &[StateLayoutRow], slot: u64) -> bool {
    rows.iter()
        .any(|row| covers(row.firstSlot, row.lastSlot, slot))
}

fn body_rows_cover(rows: &[BodyLayoutRow], slot: u64) -> bool {
    rows.iter()
        .any(|row| covers(row.firstSlot, row.lastSlot, slot))
}

fn prerequisite(
    request: &EvidenceRequest<'_>,
    function: &str,
    reason: String,
    calldata: Vec<u8>,
) -> Prerequisite {
    Prerequisite {
        function: function.to_string(),
        reason,
        call: Call {
            to: format!("{:#x}", request.destination_bridge),
            data: hex::encode_prefixed(calldata),
        },
    }
}

/// The calls that add the layout rows this message proof needs and the bridge lacks.
///
/// The bridge takes the ancestry path from the distance between the anchor and the source block, so the row that it needs depends
/// on the distance too: `block_roots` for the recent path, `historical_summaries` for the historical path. The block hash
/// row must cover the source slot. Two stored headers can supply the block hash row: the highest one at or below the
/// source slot, and the highest one at or below the anchor. Both calls are listed when both exist and differ.
fn layout_prerequisites(
    request: &EvidenceRequest<'_>,
    anchor: &BeaconHeader,
    source_slot: u64,
    stored_slots: &[u64],
) -> Result<Vec<Prerequisite>> {
    let bridge = request.destination_bridge;
    let mut calls = Vec::new();
    // From the Gloas fork on the block hash comes from the bid at a fixed index: no body layout row exists or is needed.
    let gloas_source =
        request.beacon.chain_kind().spec().fork_at_slot(source_slot) >= ForkName::Gloas;
    match ancestry_path(anchor.slot, source_slot)? {
        AncestryPath::Recent => {
            let rows = request
                .destination
                .view(bridge, MessageBridgeContract::stateLayoutsCall {})?;
            if !state_rows_cover(&rows, anchor.slot) {
                calls.push(roots_prerequisite(request, anchor, stored_slots)?);
            }
        }
        AncestryPath::Historical => {
            let rows = request
                .destination
                .view(bridge, MessageBridgeContract::historicalLayoutsCall {})?;
            if !rows
                .iter()
                .any(|row| covers(row.firstSlot, row.lastSlot, anchor.slot))
            {
                calls.push(historical_prerequisite(request, anchor, stored_slots)?);
            }
        }
    }
    let rows = request
        .destination
        .view(bridge, MessageBridgeContract::bodyLayoutsCall {})?;
    if !gloas_source && !body_rows_cover(&rows, source_slot) {
        calls.extend(hash_prerequisites(
            request,
            anchor.slot,
            source_slot,
            stored_slots,
        )?);
    }
    Ok(calls)
}

fn roots_prerequisite(
    request: &EvidenceRequest<'_>,
    anchor: &BeaconHeader,
    stored_slots: &[u64],
) -> Result<Prerequisite> {
    let evidence = request
        .beacon
        .roots_layout_evidence(anchor, stored_slots)?
        .ok_or_else(|| {
            Error::Beacon(
                "not enough stored headers yet to validate the block roots layout: the light client needs two stored heads below the anchor, within 8192 slots".into(),
            )
        })?;
    let call = MessageBridgeContract::addBlockRootsLayoutCall {
        blockRootsGindex: U256::from(evidence.gindex),
        evidence: BlockRootsEvidence {
            laterHeader: to_layout_header(&evidence.later_header),
            earlierSlotA: evidence.earlier_slot_a,
            earlierSlotB: evidence.earlier_slot_b,
            branchA: evidence.branch_a,
            branchB: evidence.branch_b,
        },
    };
    Ok(prerequisite(
        request,
        "addBlockRootsLayout",
        format!(
            "no validated block_roots row covers the anchor slot {}",
            anchor.slot
        ),
        call.abi_encode(),
    ))
}

fn historical_prerequisite(
    request: &EvidenceRequest<'_>,
    anchor: &BeaconHeader,
    stored_slots: &[u64],
) -> Result<Prerequisite> {
    let evidence = request
        .beacon
        .historical_layout_evidence(anchor, stored_slots)?
        .ok_or_else(|| {
            Error::Beacon(
                "no stored header lies in a completed era more than 8192 slots below the anchor, so the historical summaries layout cannot be validated yet".into(),
            )
        })?;
    let call = MessageBridgeContract::addHistoricalSummariesLayoutCall {
        historicalSummariesGindex: U256::from(evidence.gindex),
        evidence: HistoricalSummariesEvidence {
            anchorHeader: to_layout_header(&evidence.anchor_header),
            earlierSlot: evidence.earlier_slot,
            branch: evidence.branch,
        },
    };
    Ok(prerequisite(
        request,
        "addHistoricalSummariesLayout",
        format!(
            "no validated historical_summaries row covers the anchor slot {}",
            anchor.slot
        ),
        call.abi_encode(),
    ))
}

fn hash_prerequisites(
    request: &EvidenceRequest<'_>,
    anchor_slot: u64,
    source_slot: u64,
    stored_slots: &[u64],
) -> Result<Vec<Prerequisite>> {
    let mut calls: Vec<(u64, Prerequisite)> = Vec::new();
    for wanted in [source_slot, anchor_slot] {
        let Some(evidence) = request.beacon.hash_layout_evidence(wanted, stored_slots)? else {
            continue;
        };
        if calls.iter().any(|(slot, _)| *slot == evidence.header.slot) {
            continue;
        }
        let slot = evidence.header.slot;
        let call = MessageBridgeContract::addBlockHashLayoutCall {
            blockHashGindex: U256::from(evidence.gindex),
            evidence: BlockHashEvidence {
                header: to_layout_header(&evidence.header),
                branch: evidence.branch,
            },
        };
        calls.push((
            slot,
            prerequisite(
                request,
                "addBlockHashLayout",
                format!(
                    "no validated block hash row covers the source slot {source_slot}; this call uses the stored header at slot {slot}"
                ),
                call.abi_encode(),
            ),
        ));
    }
    if calls.is_empty() {
        return Err(Error::Beacon(format!(
            "no stored header lies at or below slot {source_slot} or {anchor_slot}, so no block hash layout row can be validated for slot {source_slot} yet"
        )));
    }
    Ok(calls.into_iter().map(|(_, call)| call).collect())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::light_client::ChainKind;
    use crate::rpc::{HttpGet, HttpResponse, JsonRpc};
    use serde_json::{json, Value};

    /// A chain node that reports chain 943 and answers every `eth_call` with one 32 byte word.
    struct WordNode(u64);

    impl JsonRpc for WordNode {
        fn call(&self, method: &str, _params: Value) -> Result<Value> {
            match method {
                "eth_chainId" => Ok(json!("0x3af")),
                "eth_call" => Ok(json!(format!("0x{:064x}", self.0))),
                other => panic!("unexpected method {other}"),
            }
        }
    }

    struct NoBeaconData;

    impl HttpGet for NoBeaconData {
        fn get(&self, _path: &str, _accept: &str) -> Result<HttpResponse> {
            Ok(HttpResponse {
                status: 404,
                body: Vec::new(),
            })
        }
    }

    /// Claim: the evidence builder checks `gloasForkSlot` of the destination bridge for a Gloas source block, and only then.
    /// A Fulu slot needs no call (the node would panic on an unexpected method only for the wrong method), a Gloas slot at or
    /// after the bridge fork slot passes, and a bridge with a later fork slot gives a configuration error that names both
    /// slots. Why it matters: such a bridge would take the layout path and refuse the proof on chain.
    #[test]
    fn a_gloas_source_needs_a_bridge_that_knows_the_fork() {
        let gloas_slot = 353_024 * 32;
        let check = |fork_slot_of_bridge: u64, source_slot: u64| {
            let destination =
                ChainClient::connect("destination", 943, Box::new(WordNode(fork_slot_of_bridge)))
                    .unwrap();
            let source = ChainClient::connect("source", 943, Box::new(WordNode(0))).unwrap();
            let beacon = HttpBeaconSource::new(ChainKind::Sepolia, Box::new(NoBeaconData));
            let request = EvidenceRequest {
                route: "test",
                source: &source,
                destination: &destination,
                beacon: &beacon,
                source_bridge: Address::ZERO,
                destination_bridge: Address::repeat_byte(2),
                light_client: Address::ZERO,
                source_header_sources: &[],
                transaction: B256::ZERO,
                log_index: 0,
                anchor_slot: None,
                destination_start_block: 0,
                log_block_range: 1,
                now_unix_seconds: 0,
            };
            require_gloas_fork_slot(&request, source_slot)
        };
        assert!(
            check(u64::MAX, gloas_slot - 1).is_ok(),
            "a Fulu slot needs no fork slot"
        );
        assert!(check(gloas_slot, gloas_slot + 10).is_ok());
        assert!(check(gloas_slot + 10, gloas_slot + 10).is_ok());
        let error = check(gloas_slot + 11, gloas_slot + 10).unwrap_err();
        assert!(
            matches!(&error, Error::Config(text) if text.contains("gloasForkSlot")),
            "{error}"
        );
    }

    /// A header node: it answers `debug_getRawHeader` with a fixed answer, or with the error of a node without the method.
    struct HeaderNode(std::result::Result<String, Error>);

    impl JsonRpc for HeaderNode {
        fn call(&self, method: &str, _params: Value) -> Result<Value> {
            match method {
                "eth_chainId" => Ok(json!("0x1")),
                "debug_getRawHeader" => match &self.0 {
                    Ok(text) => Ok(json!(text)),
                    Err(Error::Http(text)) => Err(Error::Http(text.clone())),
                    Err(_) => Err(Error::Rpc {
                        code: -32601,
                        message: "the method debug_getRawHeader does not exist/is not available"
                            .into(),
                        data: None,
                    }),
                },
                other => panic!("unexpected method {other}"),
            }
        }
    }

    fn without_method() -> HeaderNode {
        HeaderNode(Err(Error::Usage(String::new())))
    }

    /// Claim: the evidence builder reads the raw header of a Gloas source block from the main source RPC first, then from
    /// each `source.header_rpc_urls` entry in order. A main RPC without `debug_getRawHeader` (-32601, as publicnode answers
    /// for Sepolia) and a header source that answers a header of another hash are skipped; the first right header wins.
    /// When no source gives it, the error names every source with its cause, and no URL path.
    /// Why it matters: a Gloas header cannot be rebuilt from the block JSON, so without a header source a public source
    /// RPC stops every delivery of the route.
    #[test]
    fn a_gloas_source_header_comes_from_the_header_sources() {
        let header = vec![0xc3u8, 0x0a, 0x0b, 0x0c];
        let hash = alloy_primitives::keccak256(&header);
        let source = ChainClient::connect("source", 1, Box::new(without_method())).unwrap();
        let destination = ChainClient::connect("destination", 943, Box::new(WordNode(0))).unwrap();
        let beacon = HttpBeaconSource::new(ChainKind::Sepolia, Box::new(NoBeaconData));
        let header_source = |index: usize, node: HeaderNode| {
            ChainClient::header_only(
                &format!("source.header_rpc_urls[{index}]"),
                1,
                Box::new(node),
            )
        };
        let read = |sources: &[ChainClient]| {
            let request = EvidenceRequest {
                route: "test",
                source: &source,
                destination: &destination,
                beacon: &beacon,
                source_bridge: Address::ZERO,
                destination_bridge: Address::repeat_byte(2),
                light_client: Address::ZERO,
                source_header_sources: sources,
                transaction: B256::ZERO,
                log_index: 0,
                anchor_slot: None,
                destination_start_block: 0,
                log_block_range: 1,
                now_unix_seconds: 0,
            };
            source_raw_header(&request, hash)
        };

        let good = [
            header_source(0, HeaderNode(Ok("0xc0".into()))),
            header_source(1, HeaderNode(Ok(hex::encode_prefixed(&header)))),
        ];
        assert_eq!(read(&good).unwrap(), header);

        let bad = [
            header_source(0, HeaderNode(Ok("0xc0".into()))),
            header_source(
                1,
                HeaderNode(Err(Error::Http(
                    "debug_getRawHeader: https://sepolia.example.org/v3/SECRETKEY timed out".into(),
                ))),
            ),
        ];
        let error = read(&bad).unwrap_err();
        let text = error.to_string();
        assert!(matches!(error, Error::Malformed(_)), "{text}");
        for part in [
            "source.rpc_url",
            "-32601",
            "source.header_rpc_urls[0]",
            "does not hash to",
            "source.header_rpc_urls[1]",
        ] {
            assert!(text.contains(part), "`{part}` in `{text}`");
        }
        assert!(!text.contains("SECRETKEY"), "{text}");

        let error = read(&[]).unwrap_err().to_string();
        assert!(error.contains("source.rpc_url"), "{error}");
        assert!(
            error.contains("source.header_rpc_urls"),
            "the error points at the setting: {error}"
        );
    }

    /// Claim: a row covers both of its end slots and nothing outside them.
    /// Why it matters: an off-by-one at an edge sends a layout call that the bridge already has, or skips one that it needs.
    #[test]
    fn a_row_covers_its_ends_and_nothing_outside() {
        assert!(covers(10, 20, 10));
        assert!(covers(10, 20, 20));
        assert!(!covers(10, 20, 9));
        assert!(!covers(10, 20, 21));
        let rows = [BodyLayoutRow {
            blockHashGindex: U256::from(1),
            firstSlot: 10,
            lastSlot: 20,
        }];
        assert!(body_rows_cover(&rows, 15));
        assert!(!body_rows_cover(&rows, 25));
        assert!(!body_rows_cover(&[], 15));
    }

    /// Claim: the evidence JSON has the documented keys, flattens a prerequisite into `function`, `reason`, `to` and `data`,
    /// writes the delivery status as a word, and reads back to the same value.
    /// Why it matters: the consumer is a program. A renamed key breaks it silently.
    #[test]
    fn the_evidence_has_the_documented_keys() {
        let evidence = MessageEvidence {
            schema_version: SCHEMA_VERSION,
            route: "ethereum_to_pulsechain".into(),
            source_transaction_hash: format!("0x{}", "ab".repeat(32)),
            log_index: 2,
            message: MessageSummary {
                message_id: format!("0x{}", "01".repeat(32)),
                sender: format!("0x{}", "03".repeat(20)),
                executor: format!("0x{}", "04".repeat(20)),
                gas_limit: 300_000,
                data_type: 0,
                data: "0xabcd".into(),
                source_block_number: 77,
                source_block_hash: format!("0x{}", "05".repeat(32)),
                source_slot: 900,
            },
            destination: EvidenceDestination {
                chain_id: 369,
                bridge: format!("0x{}", "06".repeat(20)),
                light_client: format!("0x{}", "07".repeat(20)),
            },
            anchor: AnchorSummary {
                slot: 1000,
                root: format!("0x{}", "08".repeat(32)),
            },
            delivery_status: DeliveryStatus::NotDelivered,
            already_delivered: false,
            execute: Call {
                to: format!("0x{}", "06".repeat(20)),
                data: "0x01".into(),
            },
            prerequisites: vec![Prerequisite {
                function: "addBlockHashLayout".into(),
                reason: "no row".into(),
                call: Call {
                    to: format!("0x{}", "06".repeat(20)),
                    data: "0x02".into(),
                },
            }],
            created_at: utc_time_text(1_800_000_000),
        };
        let text = serde_json::to_string(&evidence).unwrap();
        let value: serde_json::Value = serde_json::from_str(&text).unwrap();
        let mut keys: Vec<&str> = value
            .as_object()
            .unwrap()
            .keys()
            .map(String::as_str)
            .collect();
        keys.sort_unstable();
        assert_eq!(
            keys,
            [
                "alreadyDelivered",
                "anchor",
                "createdAt",
                "deliveryStatus",
                "destination",
                "execute",
                "logIndex",
                "message",
                "prerequisites",
                "route",
                "schemaVersion",
                "sourceTransactionHash"
            ]
        );
        assert_eq!(value["deliveryStatus"], "notDelivered");
        let mut prerequisite_keys: Vec<&str> = value["prerequisites"][0]
            .as_object()
            .unwrap()
            .keys()
            .map(String::as_str)
            .collect();
        prerequisite_keys.sort_unstable();
        assert_eq!(prerequisite_keys, ["data", "function", "reason", "to"]);
        assert_eq!(
            serde_json::from_str::<MessageEvidence>(&text).unwrap(),
            evidence
        );
    }
}
