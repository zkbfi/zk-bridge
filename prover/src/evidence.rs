//! The withdrawal evidence builder: a deposit in, the calldata of `BridgeVault.withdraw` out.
//!
//! A withdrawal needs no zero-knowledge proof. The destination vault checks the evidence itself: the receipt of the
//! deposit in a source block, the path from that block to a beacon header, and the path from that header up to an anchor
//! header that the destination light client stored. This module builds that evidence for one deposit, which the caller
//! names by the hash of the source transaction and the index of the log inside its receipt.
//!
//! The builder reads two execution chains, one beacon node and the destination light client. It sends nothing and holds no
//! key. It checks its own work before it returns:
//!
//! - the contracts point at each other the way the configuration says (a name is a hypothesis, so the builder reads
//!   `remoteVault`, `remoteChainId`, `localChainId` and `lightClient` from the destination vault);
//! - the log is a `DepositInitiated` event of the configured source vault, for the configured destination vault and chain;
//! - the evidence passes the vault checks, run natively with `lc-core` against the anchor root that the light client stores;
//! - the deposit that the evidence proves equals the deposit that the log shows.
//!
//! The vault also needs a validated layout row for each generalized index that the evidence uses. Anyone may add a row, and
//! the chain validates it. When rows are missing, the result lists the calls that add them, in the order to send them.

use crate::beacon::http::HttpBeaconSource;
use crate::beacon::{DepositBlock, StoredHead};
use crate::chain::{ChainClient, RawLog};
use crate::contracts::{
    BlockHashEvidence, BlockRootsEvidence, BodyLayoutRow, HistoricalSummariesEvidence,
    StateLayoutRow, VaultContract,
};
use crate::error::{Error, Result};
use crate::handoff::utc_time_text;
use crate::light_client::{
    ancestry_path, assemble_withdrawal_proof, build_execution_evidence, decode_deposit,
    to_layout_header, verify_withdrawal_natively, withdrawal_calldata, AncestryPath, BeaconHeader,
    VaultContext, DEPOSIT_EVENT_TOPIC,
};
use crate::rpc::parse_quantity;
use crate::stored::{read_stored_header, read_stored_slots, read_stored_state};
use alloy_primitives::{hex, Address, B256, U256};
use alloy_sol_types::SolCall;
use serde::{Deserialize, Serialize};

/// The version of the evidence shape. A change that removes or renames a key raises it.
pub const SCHEMA_VERSION: u32 = 1;

/// One call that a server sends: a contract and calldata.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Call {
    /// The contract that receives the call.
    pub to: String,
    /// The calldata, `0x` hex.
    pub data: String,
}

/// A call that must succeed before the withdrawal can.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Prerequisite {
    /// The function of the vault: `addBlockRootsLayout`, `addHistoricalSummariesLayout` or `addBlockHashLayout`.
    pub function: String,
    /// Why the call is needed.
    pub reason: String,
    /// The call.
    #[serde(flatten)]
    pub call: Call,
}

/// The deposit that the log shows.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct DepositSummary {
    /// The nonce, which the destination vault marks as claimed.
    pub nonce: String,
    /// The token on the source chain.
    pub token: String,
    /// The sender on the source chain.
    pub sender: String,
    /// The recipient on the destination chain.
    pub recipient: String,
    /// The amount in base units, as a decimal string.
    pub amount: String,
    /// The number of the source block that holds the deposit.
    pub source_block_number: u64,
    /// The hash of that block.
    pub source_block_hash: String,
    /// The beacon slot of that block.
    pub deposit_slot: u64,
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

/// The destination vault and chain.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct EvidenceDestination {
    /// The chain identifier.
    pub chain_id: u64,
    /// The vault that pays the deposit.
    pub vault: String,
    /// The light client that stores the anchor.
    pub light_client: String,
}

/// The evidence for one withdrawal, with everything a server needs to send it.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct WithdrawalEvidence {
    /// The version of this shape ([`SCHEMA_VERSION`]).
    pub schema_version: u32,
    /// The name of the route.
    pub route: String,
    /// The hash of the source transaction that holds the deposit.
    pub source_transaction_hash: String,
    /// The index of the `DepositInitiated` log inside the receipt of that transaction.
    pub log_index: u64,
    /// The deposit.
    pub deposit: DepositSummary,
    /// The destination.
    pub destination: EvidenceDestination,
    /// The anchor.
    pub anchor: AnchorSummary,
    /// Whether the destination vault already paid this deposit. When it did, the withdrawal would revert.
    pub already_claimed: bool,
    /// The withdrawal call.
    pub withdraw: Call,
    /// The layout calls to send first, in order. Empty when the vault has every row it needs. After each call, read the
    /// layout views of the vault again: the calls for one function are alternatives, and the rest can be skipped as soon as
    /// a row covers the slot.
    pub prerequisites: Vec<Prerequisite>,
    /// When the evidence was built, as a time in UTC, such as `2026-10-24T09:30:00Z`.
    pub created_at: String,
}

/// Everything that names one withdrawal.
pub struct EvidenceRequest<'a> {
    /// The name of the route, for the result.
    pub route: &'a str,
    /// The source chain, which holds the deposit.
    pub source: &'a ChainClient,
    /// The destination chain, which holds the vault and the light client.
    pub destination: &'a ChainClient,
    /// The beacon node of the source chain.
    pub beacon: &'a HttpBeaconSource,
    /// The vault on the source chain.
    pub source_vault: Address,
    /// The vault on the destination chain.
    pub destination_vault: Address,
    /// The light client on the destination chain.
    pub light_client: Address,
    /// The hash of the source transaction that holds the deposit.
    pub transaction: B256,
    /// The index of the `DepositInitiated` log inside the receipt of that transaction.
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

/// Builds the evidence for one deposit. See the module documentation for the checks.
///
/// # Errors
/// `Error::Config` when the contracts do not point at each other as the configuration says. `Error::Usage` when the
/// transaction has no such log, when the log is not a deposit for this route, or when the light client stores no header at
/// the requested anchor slot. `Error::Beacon` when the anchor does not yet cover the deposit, when the beacon node lacks
/// data, or when the stored headers do not yet allow a layout row. `Error::VerificationRefused` when the evidence fails the
/// native vault check.
pub fn build_evidence(request: &EvidenceRequest<'_>) -> Result<WithdrawalEvidence> {
    check_wiring(request)?;
    let (log, deposit) = locate_deposit(request)?;
    let anchor = choose_anchor(request)?;

    let block_json = request
        .source
        .block(log.block_number)?
        .ok_or_else(|| Error::Malformed(format!("source block {} is unknown", log.block_number)))?;
    let receipts = request
        .source
        .block_receipts(log.block_number, &block_json)?;
    let execution = build_execution_evidence(&block_json, &receipts, log.transaction_index)?;
    if execution.block_hash != log.block_hash {
        return Err(Error::Malformed(
            "the source block hash differs from the block hash of the log".into(),
        ));
    }
    let deposit_block = DepositBlock {
        number: log.block_number,
        hash: log.block_hash,
        timestamp: parse_quantity(&block_json["timestamp"])?,
    };
    let path = request.beacon.withdrawal_path(&deposit_block, &anchor)?;
    let proof =
        assemble_withdrawal_proof(&path, &execution, log.transaction_index, request.log_index);
    let context = VaultContext {
        remote_vault: request.source_vault,
        local_vault: request.destination_vault,
        local_chain_id: request.destination.chain_id(),
        stored_anchor_root: anchor.root,
    };
    let verified = verify_withdrawal_natively(&proof, &context, request.beacon.chain_kind())?;
    if verified.nonce != deposit.nonce
        || verified.recipient != deposit.recipient
        || verified.amount != deposit.amount
        || verified.token != deposit.token
    {
        return Err(Error::VerificationRefused(
            "the proven deposit differs from the deposit in the log".into(),
        ));
    }
    let stored_slots = read_stored_slots(
        request.destination,
        request.light_client,
        request.destination_start_block,
        request.log_block_range,
    )?;
    let prerequisites = layout_prerequisites(
        request,
        &path.anchor_header,
        path.deposit_header.slot,
        &stored_slots,
    )?;
    let already_claimed = request.destination.view(
        request.destination_vault,
        VaultContract::claimedCall {
            depositNonce: deposit.nonce,
        },
    )?;
    Ok(WithdrawalEvidence {
        schema_version: SCHEMA_VERSION,
        route: request.route.to_string(),
        source_transaction_hash: format!("{:#x}", request.transaction),
        log_index: request.log_index,
        deposit: DepositSummary {
            nonce: format!("{:#x}", deposit.nonce),
            token: format!("{:#x}", deposit.token),
            sender: format!("{:#x}", deposit.sender),
            recipient: format!("{:#x}", deposit.recipient),
            amount: deposit.amount.to_string(),
            source_block_number: log.block_number,
            source_block_hash: format!("{:#x}", log.block_hash),
            deposit_slot: path.deposit_header.slot,
        },
        destination: EvidenceDestination {
            chain_id: request.destination.chain_id(),
            vault: format!("{:#x}", request.destination_vault),
            light_client: format!("{:#x}", request.light_client),
        },
        anchor: AnchorSummary {
            slot: anchor.slot,
            root: format!("{:#x}", anchor.root),
        },
        already_claimed,
        withdraw: Call {
            to: format!("{:#x}", request.destination_vault),
            data: hex::encode_prefixed(withdrawal_calldata(&proof)),
        },
        prerequisites,
        created_at: utc_time_text(request.now_unix_seconds),
    })
}

/// Reads the four relations between the destination vault and the rest from the vault itself, and compares them with the
/// configuration. A vault that points at other contracts would pay or refuse for the wrong reasons.
fn check_wiring(request: &EvidenceRequest<'_>) -> Result<()> {
    let vault = request.destination_vault;
    let mismatch = |what: &str, expected: String, actual: String| {
        Error::Config(format!(
            "route {}: {what} is {actual}, the configuration says {expected}",
            request.route
        ))
    };
    let remote_vault = request
        .destination
        .view(vault, VaultContract::remoteVaultCall {})?;
    if remote_vault != request.source_vault {
        return Err(mismatch(
            "destination vault remoteVault",
            request.source_vault.to_string(),
            remote_vault.to_string(),
        ));
    }
    let remote_chain = request
        .destination
        .view(vault, VaultContract::remoteChainIdCall {})?;
    if remote_chain != request.source.chain_id() {
        return Err(mismatch(
            "destination vault remoteChainId",
            request.source.chain_id().to_string(),
            remote_chain.to_string(),
        ));
    }
    let local_chain = request
        .destination
        .view(vault, VaultContract::localChainIdCall {})?;
    if local_chain != request.destination.chain_id() {
        return Err(mismatch(
            "destination vault localChainId",
            request.destination.chain_id().to_string(),
            local_chain.to_string(),
        ));
    }
    let light_client = request
        .destination
        .view(vault, VaultContract::lightClientCall {})?;
    if light_client != request.light_client {
        return Err(mismatch(
            "destination vault lightClient",
            request.light_client.to_string(),
            light_client.to_string(),
        ));
    }
    Ok(())
}

/// Finds the log in the receipt, and decodes it. The log must be a deposit of the source vault for the destination vault.
fn locate_deposit(
    request: &EvidenceRequest<'_>,
) -> Result<(RawLog, crate::light_client::DepositEvent)> {
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
    require_route_deposit(request, &log)?;
    let deposit = decode_deposit(&log.topics, &log.data)?;
    if deposit.target_chain_id != request.destination.chain_id() {
        return Err(Error::Usage(format!(
            "the deposit is for chain {}, not for the destination chain {}",
            deposit.target_chain_id,
            request.destination.chain_id()
        )));
    }
    if deposit.destination_vault != request.destination_vault {
        return Err(Error::Usage(format!(
            "the deposit is for vault {:#x}, not for the destination vault {:#x}",
            deposit.destination_vault, request.destination_vault
        )));
    }
    Ok((log, deposit))
}

fn require_route_deposit(request: &EvidenceRequest<'_>, log: &RawLog) -> Result<()> {
    if log.address != request.source_vault {
        return Err(Error::Usage(format!(
            "log {} of {:#x} comes from {:#x}, not from the source vault {:#x}",
            request.log_index, request.transaction, log.address, request.source_vault
        )));
    }
    if log.topics.first() != Some(&DEPOSIT_EVENT_TOPIC) {
        return Err(Error::Usage(format!(
            "log {} of {:#x} is not a DepositInitiated event",
            request.log_index, request.transaction
        )));
    }
    Ok(())
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
            to: format!("{:#x}", request.destination_vault),
            data: hex::encode_prefixed(calldata),
        },
    }
}

/// The calls that add the layout rows this withdrawal needs and the vault lacks.
///
/// The vault takes the ancestry path from the distance between the anchor and the deposit, so the row that it needs depends
/// on the distance too: `block_roots` for the recent path, `historical_summaries` for the historical path. The block hash
/// row must cover the deposit slot. Two stored headers can supply the block hash row: the highest one at or below the
/// deposit slot, and the highest one at or below the anchor. Both calls are listed when both exist and differ.
fn layout_prerequisites(
    request: &EvidenceRequest<'_>,
    anchor: &BeaconHeader,
    deposit_slot: u64,
    stored_slots: &[u64],
) -> Result<Vec<Prerequisite>> {
    let vault = request.destination_vault;
    let mut calls = Vec::new();
    match ancestry_path(anchor.slot, deposit_slot)? {
        AncestryPath::Recent => {
            let rows = request
                .destination
                .view(vault, VaultContract::stateLayoutsCall {})?;
            if !state_rows_cover(&rows, anchor.slot) {
                calls.push(roots_prerequisite(request, anchor, stored_slots)?);
            }
        }
        AncestryPath::Historical => {
            let rows = request
                .destination
                .view(vault, VaultContract::historicalLayoutsCall {})?;
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
        .view(vault, VaultContract::bodyLayoutsCall {})?;
    if !body_rows_cover(&rows, deposit_slot) {
        calls.extend(hash_prerequisites(
            request,
            anchor.slot,
            deposit_slot,
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
    let call = VaultContract::addBlockRootsLayoutCall {
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
    let call = VaultContract::addHistoricalSummariesLayoutCall {
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
    deposit_slot: u64,
    stored_slots: &[u64],
) -> Result<Vec<Prerequisite>> {
    let mut calls: Vec<(u64, Prerequisite)> = Vec::new();
    for wanted in [deposit_slot, anchor_slot] {
        let Some(evidence) = request.beacon.hash_layout_evidence(wanted, stored_slots)? else {
            continue;
        };
        if calls.iter().any(|(slot, _)| *slot == evidence.header.slot) {
            continue;
        }
        let slot = evidence.header.slot;
        let call = VaultContract::addBlockHashLayoutCall {
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
                    "no validated block hash row covers the deposit slot {deposit_slot}; this call uses the stored header at slot {slot}"
                ),
                call.abi_encode(),
            ),
        ));
    }
    if calls.is_empty() {
        return Err(Error::Beacon(format!(
            "no stored header lies at or below slot {deposit_slot} or {anchor_slot}, so no block hash layout row can be validated for slot {deposit_slot} yet"
        )));
    }
    Ok(calls.into_iter().map(|(_, call)| call).collect())
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Claim: a row covers both of its end slots and nothing outside them.
    /// Why it matters: an off-by-one at an edge sends a layout call that the vault already has, or skips one that it needs.
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
    /// and reads back to the same value.
    /// Why it matters: the consumer is a program. A renamed key breaks it silently.
    #[test]
    fn the_evidence_has_the_documented_keys() {
        let evidence = WithdrawalEvidence {
            schema_version: SCHEMA_VERSION,
            route: "ethereum_to_pulsechain".into(),
            source_transaction_hash: format!("0x{}", "ab".repeat(32)),
            log_index: 2,
            deposit: DepositSummary {
                nonce: format!("0x{}", "01".repeat(32)),
                token: format!("0x{}", "02".repeat(20)),
                sender: format!("0x{}", "03".repeat(20)),
                recipient: format!("0x{}", "04".repeat(20)),
                amount: "1000000000000000000".into(),
                source_block_number: 77,
                source_block_hash: format!("0x{}", "05".repeat(32)),
                deposit_slot: 900,
            },
            destination: EvidenceDestination {
                chain_id: 369,
                vault: format!("0x{}", "06".repeat(20)),
                light_client: format!("0x{}", "07".repeat(20)),
            },
            anchor: AnchorSummary {
                slot: 1000,
                root: format!("0x{}", "08".repeat(32)),
            },
            already_claimed: false,
            withdraw: Call {
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
                "alreadyClaimed",
                "anchor",
                "createdAt",
                "deposit",
                "destination",
                "logIndex",
                "prerequisites",
                "route",
                "schemaVersion",
                "sourceTransactionHash",
                "withdraw"
            ]
        );
        let mut prerequisite_keys: Vec<&str> = value["prerequisites"][0]
            .as_object()
            .unwrap()
            .keys()
            .map(String::as_str)
            .collect();
        prerequisite_keys.sort_unstable();
        assert_eq!(prerequisite_keys, ["data", "function", "reason", "to"]);
        assert_eq!(
            serde_json::from_str::<WithdrawalEvidence>(&text).unwrap(),
            evidence
        );
    }
}
