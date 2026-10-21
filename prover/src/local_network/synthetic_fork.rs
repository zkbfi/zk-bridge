//! Gate evidence for a local chain that has no beacon node.
//!
//! The Anvil tests do the same: they build a synthetic Capella state, take a header over it, and write the header
//! root into the ring buffer of the beacon roots contract (EIP-4788) under the time of the latest block. The gate then
//! accepts the fork proof for the current epoch.

use crate::error::{Error, Result};
use crate::gate::{ForkEvidenceSource, ForkRequest};
use crate::light_client::{fork_evidence_bytes, synthetic_fork_header, ForkData};
use crate::rpc::{parse_quantity, HttpRpc, JsonRpc};
use alloy_primitives::{B256, U256};
use serde_json::json;

/// The Capella fork version of PulseChain, which the development beacon source imitates (chain `pulsechain`). The
/// deploy step lists it as the only version that the gates support, so `route-health` finds the fork supported.
pub const CAPELLA_VERSION: [u8; 4] = [0, 0, 0x03, 0x6c];
/// The Bellatrix fork version of PulseChain, the version before Capella.
pub const BELLATRIX_VERSION: [u8; 4] = [0, 0, 0x03, 0x6b];

/// The length of the ring buffer of the beacon roots contract: `timestamp % 8191` is the slot of an entry.
const RING_LENGTH: u64 = 8191;

/// Builds fork evidence from a synthetic chain and writes the beacon root with `anvil_setStorageAt`.
pub struct SyntheticForkSource {
    rpc: HttpRpc,
}

impl SyntheticForkSource {
    /// A source for the Anvil chain at `rpc_url`.
    pub fn new(rpc_url: &str) -> Self {
        Self {
            rpc: HttpRpc::new(rpc_url),
        }
    }

    fn latest_timestamp(&self) -> Result<u64> {
        let block = self
            .rpc
            .call("eth_getBlockByNumber", json!(["latest", false]))?;
        parse_quantity(&block["timestamp"])
    }

    fn write_beacon_root(
        &self,
        beacon_roots: alloy_primitives::Address,
        timestamp: u64,
        root: B256,
    ) -> Result<()> {
        let position = timestamp % RING_LENGTH;
        let word = |value: u64| B256::from(U256::from(value).to_be_bytes::<32>());
        for (slot, value) in [
            (word(position), word(timestamp)),
            (word(position + RING_LENGTH), root),
        ] {
            self.rpc.call(
                "anvil_setStorageAt",
                json!([
                    format!("{beacon_roots:#x}"),
                    format!("{slot:#x}"),
                    format!("{value:#x}")
                ]),
            )?;
        }
        Ok(())
    }
}

impl ForkEvidenceSource for SyntheticForkSource {
    fn fork_evidence(&self, request: &ForkRequest<'_>) -> Result<Vec<u8>> {
        let timestamp = self.latest_timestamp()?;
        let slot = timestamp
            .checked_sub(request.genesis_time)
            .ok_or_else(|| Error::Beacon("the latest block lies before the gate genesis".into()))?
            / request.seconds_per_slot;
        let fork = ForkData {
            previous_version: BELLATRIX_VERSION,
            current_version: CAPELLA_VERSION,
            epoch: 3,
        };
        let (header, field_roots) = synthetic_fork_header(slot, fork);
        let header_epoch = header.slot / request.slots_per_epoch;
        if header_epoch != request.epoch {
            return Err(Error::Beacon(format!(
                "the latest block lies in epoch {header_epoch} and the gate wants epoch {}; try again in the next epoch",
                request.epoch
            )));
        }
        self.write_beacon_root(request.beacon_roots, timestamp, header.hash_tree_root())?;
        Ok(fork_evidence_bytes(timestamp, &header, fork, &field_roots))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use alloy_primitives::hex;

    /// Claim: the deploy configuration lists the fork version that the evidence carries, for both gates.
    /// Why it matters: a gate refuses evidence of a version it does not support, and the bots would then fail
    /// on the first deposit of every epoch. The two files are far apart, so a test must tie them.
    #[test]
    fn the_deploy_template_supports_the_evidence_version() {
        let template = include_str!("../../../docker/bridge.config.template.json");
        let wanted = format!("\"version\": \"0x{}\"", hex::encode(CAPELLA_VERSION));
        assert_eq!(
            template.matches(&wanted).count(),
            2,
            "both gates list {wanted}"
        );
    }
}
