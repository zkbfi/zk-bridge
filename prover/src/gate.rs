//! Evidence for the deposit gate (`BeaconForkGate`) of a vault.
//!
//! The vault calls the gate first in `deposit`. An enforcing gate wants a proof of the fork version once per epoch.
//! The first deposit of an epoch carries the proof. Later deposits of the epoch carry empty evidence.
//!
//! [`gate_evidence_for_deposit`] reads the gate, decides, and asks a [`ForkEvidenceSource`] for the proof only when
//! the confirmed epoch is stale. The proof builder itself is in `lc-core` (`lc_core::gate`), reached through
//! `light_client.rs`. The service sends no deposit. A wallet, a keeper or a test uses this module.
//!
//! One race remains. The epoch is read at the latest block. A deposit that lands in the first block of the next
//! epoch finds the evidence stale and reverts with `ForkNotConfirmed`. The caller asks again.

use crate::chain::{ChainClient, ExecutionReader};
use crate::error::{Error, Result};
use alloy_primitives::{Address, B256};
use alloy_sol_types::sol;

sol! {
    /// The read surface of `BeaconForkGate` that the service uses.
    interface GateContract {
        function enforcing() external view returns (bool);
        function isSealed() external view returns (bool);
        function confirmedEpoch() external view returns (uint64 epoch, bool exists);
        function currentEpoch() external view returns (uint256);
        function beaconRoots() external view returns (address);
        function genesisTime() external view returns (uint64);
        function secondsPerSlot() external view returns (uint64);
        function slotsPerEpoch() external view returns (uint64);
        function confirm(bytes calldata evidence) external;
    }
}

/// What the gate says now.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct GateStatus {
    /// Whether the gate applies its rules (an enforcing gate, or a detection gate that saw a beacon root).
    pub enforcing: bool,
    /// Whether a seal proof closed the gate for good.
    pub sealed: bool,
    /// The last epoch confirmed by a proof, if any.
    pub confirmed_epoch: Option<u64>,
    /// The epoch of the latest block.
    pub current_epoch: u64,
}

impl GateStatus {
    /// Whether a deposit in the current epoch must carry a proof.
    ///
    /// # Errors
    /// `Error::Usage` when the gate is sealed: every deposit reverts and no evidence helps.
    pub fn evidence_needed(&self) -> Result<bool> {
        if self.sealed {
            return Err(Error::Usage("the deposit gate is sealed: a fork that the route does not support was proven".into()));
        }
        Ok(self.enforcing && self.confirmed_epoch != Some(self.current_epoch))
    }
}

/// The fixed parameters of the gate and the epoch that needs a proof.
#[derive(Clone, Copy)]
pub struct ForkRequest<'a> {
    /// The chain of the gate.
    pub chain: &'a ChainClient,
    /// The address of the beacon roots contract that the gate reads.
    pub beacon_roots: Address,
    /// The epoch that the gate wants a proof for.
    pub epoch: u64,
    /// The genesis time of the beacon chain.
    pub genesis_time: u64,
    /// Seconds per slot.
    pub seconds_per_slot: u64,
    /// Slots per epoch.
    pub slots_per_epoch: u64,
}

/// Where the proof comes from: a beacon node (production) or a synthetic chain (tests).
pub trait ForkEvidenceSource {
    /// `abi.encode(ForkEvidence)` for a header of `request.epoch` whose root the beacon roots contract holds.
    ///
    /// # Errors
    /// Any error of the source, for example `Error::Beacon` when no header of the epoch exists yet. The first slot of
    /// an epoch has none.
    fn fork_evidence(&self, request: &ForkRequest<'_>) -> Result<Vec<u8>>;
}

/// Reads the gate at the latest block.
///
/// A gate in detection mode that has not yet seen a beacon root counts as enforcing when the beacon roots contract
/// answers now: the next `admit` call switches it.
///
/// # Errors
/// Any read error.
pub fn read_gate_status(client: &ChainClient, gate: Address) -> Result<GateStatus> {
    let mut enforcing = client.view(gate, GateContract::enforcingCall {})?;
    if !enforcing {
        let roots = client.view(gate, GateContract::beaconRootsCall {})?;
        enforcing = beacon_root_at(client, roots, latest_timestamp(client)?)?.is_some();
    }
    let confirmed = client.view(gate, GateContract::confirmedEpochCall {})?;
    let current_epoch = client.view(gate, GateContract::currentEpochCall {})?;
    Ok(GateStatus {
        enforcing,
        sealed: client.view(gate, GateContract::isSealedCall {})?,
        confirmed_epoch: confirmed.exists.then_some(confirmed.epoch),
        current_epoch: u64::try_from(current_epoch).map_err(|_| Error::Malformed("currentEpoch".into()))?,
    })
}

/// The timestamp of the latest block.
fn latest_timestamp(client: &ChainClient) -> Result<u64> {
    let number = client.latest_block_number()?;
    let block = client.block(number)?.ok_or_else(|| Error::Malformed(format!("block {number} is unknown")))?;
    crate::rpc::parse_quantity(&block["timestamp"])
}

/// What the beacon roots contract answers for a timestamp: a non-zero root, or `None` when it has none (the call
/// fails, answers short, or answers zero). This is the probe of the gate.
///
/// # Errors
/// `Error::Rpc` for a transport failure.
pub fn beacon_root_at(client: &ChainClient, roots: Address, timestamp: u64) -> Result<Option<B256>> {
    let key = alloy_primitives::U256::from(timestamp).to_be_bytes::<32>();
    match client.eth_call(roots, &key, false) {
        Ok(answer) if answer.len() == 32 && answer.iter().any(|byte| *byte != 0) => Ok(Some(B256::from_slice(&answer))),
        Ok(_) => Ok(None),
        Err(Error::Rpc { .. }) => Ok(None),
        Err(other) => Err(other),
    }
}

/// The `gateEvidence` argument for a deposit: empty when the gate needs none, a fork proof when the confirmed epoch
/// is stale.
///
/// # Errors
/// `Error::Usage` for a sealed gate. Any read error, and any error of the source.
pub fn gate_evidence_for_deposit(client: &ChainClient, gate: Address, source: &dyn ForkEvidenceSource) -> Result<Vec<u8>> {
    let status = read_gate_status(client, gate)?;
    if !status.evidence_needed()? {
        return Ok(Vec::new());
    }
    let request = ForkRequest {
        chain: client,
        beacon_roots: client.view(gate, GateContract::beaconRootsCall {})?,
        epoch: status.current_epoch,
        genesis_time: client.view(gate, GateContract::genesisTimeCall {})?,
        seconds_per_slot: client.view(gate, GateContract::secondsPerSlotCall {})?,
        slots_per_epoch: client.view(gate, GateContract::slotsPerEpochCall {})?,
    };
    source.fork_evidence(&request)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn status(enforcing: bool, sealed: bool, confirmed: Option<u64>, current: u64) -> GateStatus {
        GateStatus { enforcing, sealed, confirmed_epoch: confirmed, current_epoch: current }
    }

    /// Claim: evidence is needed only for an enforcing gate whose confirmed epoch is not the current epoch.
    /// A gate that is not enforcing, or that confirmed this epoch, needs none. A sealed gate is an error.
    /// Why it matters: empty evidence in a stale epoch reverts, and a needless proof wastes gas on every deposit.
    #[test]
    fn evidence_is_needed_only_when_the_confirmed_epoch_is_stale() {
        assert_eq!(status(true, false, None, 5).evidence_needed(), Ok(true), "never confirmed");
        assert_eq!(status(true, false, Some(4), 5).evidence_needed(), Ok(true), "confirmed in an older epoch");
        assert_eq!(status(true, false, Some(5), 5).evidence_needed(), Ok(false), "confirmed this epoch");
        assert_eq!(status(false, false, None, 5).evidence_needed(), Ok(false), "detection mode, no beacon roots yet");
        assert!(status(true, true, Some(5), 5).evidence_needed().is_err(), "sealed");
        assert!(status(false, true, None, 5).evidence_needed().is_err(), "sealed");
    }
}
