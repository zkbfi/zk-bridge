//! Chain configuration: fork schedule, slot timing and the genesis validators root.
//!
//! Values for Ethereum mainnet come from a live beacon API (see `tests/fixtures/ethereum/chain_spec.json`
//! and `scripts/fetch-fixtures.sh`). Values for PulseChain come from the build contract and from
//! `https://rpc-pulsechain.g4mm4.io/beacon-api` (see `tests/fixtures/pulsechain/chain_spec.json`).
//! A test compares each constant with its fixture, so a typing error cannot hide.

use crate::error::{Error, Result};
use crate::layout::SLOTS_PER_HISTORICAL_ROOT;
use alloy_primitives::{b256, B256};

/// The epoch value that the beacon configuration uses for a fork that is never scheduled.
pub const FAR_FUTURE_EPOCH: u64 = u64::MAX;

/// Number of public keys in a sync committee. Both chains use 512.
///
/// Source: `SYNC_COMMITTEE_SIZE` from `/eth/v1/config/spec` on both chains.
pub const SYNC_COMMITTEE_SIZE: usize = 512;

/// Smallest participant count that passes the two-thirds rule: `participants * 3 >= 512 * 2`.
pub const MIN_PARTICIPANTS: usize = (SYNC_COMMITTEE_SIZE * 2).div_ceil(3);

/// The domain type of sync committee signatures.
///
/// Source: `DOMAIN_SYNC_COMMITTEE` = `0x07000000` from `/eth/v1/config/spec` on both chains
/// (consensus-specs `specs/altair/beacon-chain.md`, section "Domain types").
pub const DOMAIN_SYNC_COMMITTEE: [u8; 4] = [0x07, 0x00, 0x00, 0x00];

/// The genesis slot. A finalized checkpoint at the genesis slot is represented as a zero hash and is rejected here.
pub const GENESIS_SLOT: u64 = 0;

/// Names of the beacon chain forks.
///
/// The order is the order of activation, so the derived ordering compares forks by age.
#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub enum ForkName {
    /// The launch fork.
    Phase0,
    /// First fork with sync committees.
    Altair,
    /// The merge fork on the consensus layer.
    Bellatrix,
    /// First fork with withdrawals. PulseChain stopped here.
    Capella,
    /// First fork with blob fields in the execution payload header.
    Deneb,
    /// Changes the beacon state layout, so the light-client generalized indices change.
    Electra,
    /// Keeps the Electra light-client layout.
    Fulu,
    /// Not scheduled on Ethereum mainnet. Its layout is unknown here and is rejected.
    Gloas,
}

/// One entry of a fork schedule.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct ForkEntry {
    /// First epoch of the fork. `FAR_FUTURE_EPOCH` when the fork is never scheduled.
    pub epoch: u64,
    /// The fork version that enters the signing domain.
    pub fork_version: [u8; 4],
    /// The name of the fork.
    pub fork_name: ForkName,
}

/// The configuration of one beacon chain.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct ChainSpec {
    /// Human readable name.
    pub name: &'static str,
    /// Hash tree root of the genesis validator registry. It binds every signature to one chain.
    pub genesis_validators_root: B256,
    /// Fork schedule sorted by epoch, oldest first. The first entry must start at epoch 0.
    pub fork_schedule: &'static [ForkEntry],
    /// Seconds per slot.
    pub seconds_per_slot: u64,
    /// Slots per epoch.
    pub slots_per_epoch: u64,
    /// Epochs per sync committee period.
    pub epochs_per_sync_committee_period: u64,
}

impl ChainSpec {
    /// Epoch that contains `slot`.
    pub const fn epoch_at_slot(&self, slot: u64) -> u64 {
        slot / self.slots_per_epoch
    }

    /// Sync committee period that contains `slot`.
    pub const fn period_at_slot(&self, slot: u64) -> u64 {
        self.epoch_at_slot(slot) / self.epochs_per_sync_committee_period
    }

    /// The schedule entry that is active at `epoch`: the newest entry that starts at or before `epoch`.
    pub fn fork_entry_at_epoch(&self, epoch: u64) -> ForkEntry {
        let mut active = self.fork_schedule[0];
        for entry in self.fork_schedule {
            if entry.epoch <= epoch {
                active = *entry;
            }
        }
        active
    }

    /// The fork that is active at `slot`.
    pub fn fork_at_slot(&self, slot: u64) -> ForkName {
        self.fork_entry_at_epoch(self.epoch_at_slot(slot)).fork_name
    }

    /// The fork version that is active at `epoch`. This is `compute_fork_version` of the consensus specs.
    pub fn fork_version_at(&self, epoch: u64) -> [u8; 4] {
        self.fork_entry_at_epoch(epoch).fork_version
    }

    /// The first slot of the Capella fork, from the fork schedule. `None` when the schedule has no Capella entry.
    pub fn capella_fork_slot(&self) -> Option<u64> {
        let entry = self.fork_schedule.iter().find(|entry| entry.fork_name == ForkName::Capella)?;
        Some(entry.epoch.saturating_mul(self.slots_per_epoch))
    }

    /// `capellaEra`: `floor(capellaForkSlot / 8192)`. The era of the first entry of `state.historical_summaries`.
    ///
    /// `BeaconState.historical_summaries` starts empty at the Capella upgrade, and the first summary is appended at the
    /// first epoch transition with `next_epoch % 256 == 0` (`process_historical_summaries_update`,
    /// `specs/capella/beacon-chain.md`). That summary covers the era that holds the Capella fork slot. So the entry at
    /// index `i` covers era `capellaEra + i`. Ethereum gives 758 (Capella slot 6209536); PulseChain gives 0 (slot 96).
    /// The value comes from the fork schedule, so it is never typed in by hand outside the chain configuration.
    ///
    /// # Errors
    /// `UnsupportedFork` when the schedule has no Capella entry.
    pub fn capella_era(&self) -> Result<u64> {
        let slot = self.capella_fork_slot().ok_or(Error::UnsupportedFork { fork: ForkName::Capella })?;
        Ok(slot / SLOTS_PER_HISTORICAL_ROOT)
    }
}

/// The fork schedule of Ethereum mainnet.
///
/// Source: `GET https://ethereum-beacon-api.publicnode.com/eth/v1/config/spec`, fetched 2026-10-20.
/// The Gloas fork has no epoch yet (`18446744073709551615`).
const ETHEREUM_FORKS: [ForkEntry; 8] = [
    ForkEntry { epoch: 0, fork_version: [0x00, 0x00, 0x00, 0x00], fork_name: ForkName::Phase0 },
    ForkEntry { epoch: 74_240, fork_version: [0x01, 0x00, 0x00, 0x00], fork_name: ForkName::Altair },
    ForkEntry { epoch: 144_896, fork_version: [0x02, 0x00, 0x00, 0x00], fork_name: ForkName::Bellatrix },
    ForkEntry { epoch: 194_048, fork_version: [0x03, 0x00, 0x00, 0x00], fork_name: ForkName::Capella },
    ForkEntry { epoch: 269_568, fork_version: [0x04, 0x00, 0x00, 0x00], fork_name: ForkName::Deneb },
    ForkEntry { epoch: 364_032, fork_version: [0x05, 0x00, 0x00, 0x00], fork_name: ForkName::Electra },
    ForkEntry { epoch: 411_392, fork_version: [0x06, 0x00, 0x00, 0x00], fork_name: ForkName::Fulu },
    ForkEntry { epoch: FAR_FUTURE_EPOCH, fork_version: [0x07, 0x00, 0x00, 0x00], fork_name: ForkName::Gloas },
];

/// Ethereum mainnet.
///
/// Source: `/eth/v1/beacon/genesis` and `/eth/v1/config/spec` of `https://ethereum-beacon-api.publicnode.com`,
/// fetched 2026-10-20. The same genesis validators root came from `lodestar-mainnet.chainsafe.io`,
/// `mainnet.checkpoint.sigp.io`, `sync-mainnet.beaconcha.in` and `beaconstate-mainnet.chainsafe.io`.
pub const ETHEREUM_MAINNET: ChainSpec = ChainSpec {
    name: "ethereum-mainnet",
    genesis_validators_root: b256!("4b363db94e286120d76eb905340fdd4e54bfe9f06bf33ff6cf5ad27f511bfe95"),
    fork_schedule: &ETHEREUM_FORKS,
    seconds_per_slot: 12,
    slots_per_epoch: 32,
    epochs_per_sync_committee_period: 256,
};

/// The fork schedule of PulseChain.
///
/// Source: `GET https://rpc-pulsechain.g4mm4.io/beacon-api/eth/v1/config/spec`, fetched 2026-10-20.
/// PulseChain never scheduled Deneb (`DENEB_FORK_EPOCH` is `18446744073709551615`, version `0xffffffff`).
/// The build contract lists the Bellatrix version too: the spec call returns `0x0000036b` at epoch 2.
const PULSECHAIN_FORKS: [ForkEntry; 5] = [
    ForkEntry { epoch: 0, fork_version: [0x00, 0x00, 0x03, 0x69], fork_name: ForkName::Phase0 },
    ForkEntry { epoch: 1, fork_version: [0x00, 0x00, 0x03, 0x6a], fork_name: ForkName::Altair },
    ForkEntry { epoch: 2, fork_version: [0x00, 0x00, 0x03, 0x6b], fork_name: ForkName::Bellatrix },
    ForkEntry { epoch: 3, fork_version: [0x00, 0x00, 0x03, 0x6c], fork_name: ForkName::Capella },
    ForkEntry { epoch: FAR_FUTURE_EPOCH, fork_version: [0xff, 0xff, 0xff, 0xff], fork_name: ForkName::Deneb },
];

/// PulseChain (chain identifier 369).
///
/// Source: `/eth/v1/beacon/genesis` and `/eth/v1/config/spec` of `https://rpc-pulsechain.g4mm4.io/beacon-api`,
/// fetched 2026-10-20, and the build contract table.
pub const PULSECHAIN: ChainSpec = ChainSpec {
    name: "pulsechain",
    genesis_validators_root: b256!("3357ba0018a2582aeabe4ae847aa17d50a3a99aaeb66293c01f80a83aecd0c90"),
    fork_schedule: &PULSECHAIN_FORKS,
    seconds_per_slot: 10,
    slots_per_epoch: 32,
    epochs_per_sync_committee_period: 256,
};

#[cfg(test)]
mod tests {
    use super::*;

    /// Claim: `MIN_PARTICIPANTS` is 342 and 341 fails the two-thirds rule `participants * 3 >= 512 * 2`.
    /// This matters because the Solidity side and the circuit must agree on the threshold.
    #[test]
    fn minimum_participants_is_342() {
        let minimum = std::hint::black_box(MIN_PARTICIPANTS);
        assert_eq!(minimum, 342);
        assert!(minimum * 3 >= SYNC_COMMITTEE_SIZE * 2);
        assert!((minimum - 1) * 3 < SYNC_COMMITTEE_SIZE * 2);
    }

    /// Claim: PulseChain never reaches Deneb, whatever the epoch. Using the Deneb layout there would be a bug.
    #[test]
    fn pulsechain_never_activates_deneb() {
        for epoch in [0, 1, 2, 3, 339_864, 1 << 40, u64::MAX - 1] {
            assert!(PULSECHAIN.fork_entry_at_epoch(epoch).fork_name <= ForkName::Capella);
        }
    }

    /// Claim: the fork version switches exactly at the fork epoch, not before.
    #[test]
    fn fork_version_switches_on_the_fork_epoch() {
        assert_eq!(ETHEREUM_MAINNET.fork_version_at(194_047), [3 - 1, 0, 0, 0]);
        assert_eq!(ETHEREUM_MAINNET.fork_version_at(194_048), [3, 0, 0, 0]);
        assert_eq!(ETHEREUM_MAINNET.fork_version_at(364_031), [4, 0, 0, 0]);
        assert_eq!(ETHEREUM_MAINNET.fork_version_at(364_032), [5, 0, 0, 0]);
        assert_eq!(PULSECHAIN.fork_version_at(2), [0, 0, 0x03, 0x6b]);
        assert_eq!(PULSECHAIN.fork_version_at(3), [0, 0, 0x03, 0x6c]);
    }

    /// Claim: `capellaEra` comes out of the fork schedule as 758 on Ethereum (Capella slot 6209536 = 758 * 8192
    /// exactly) and 0 on PulseChain (Capella epoch 3, slot 96). The expected numbers are written by hand from the
    /// build contract, not from the code. A wrong value would make a whole era unreachable or wrongly reachable.
    #[test]
    fn capella_era_comes_from_the_fork_schedule() {
        assert_eq!(ETHEREUM_MAINNET.capella_fork_slot(), Some(6_209_536));
        assert_eq!(ETHEREUM_MAINNET.capella_era(), Ok(758));
        assert_eq!(758 * 8192, 6_209_536);
        assert_eq!(PULSECHAIN.capella_fork_slot(), Some(96));
        assert_eq!(PULSECHAIN.capella_era(), Ok(0));
    }

    /// Claim: a schedule without Capella has no `capellaEra`. The control shows the function can fail.
    #[test]
    fn capella_era_needs_a_capella_entry() {
        const FORKS: [ForkEntry; 1] = [ForkEntry { epoch: 0, fork_version: [0; 4], fork_name: ForkName::Phase0 }];
        let spec = ChainSpec { fork_schedule: &FORKS, ..PULSECHAIN };
        assert_eq!(spec.capella_era(), Err(Error::UnsupportedFork { fork: ForkName::Capella }));
    }

    /// Claim: a sync committee period is 8192 slots on both chains, so period boundaries sit at multiples of 8192.
    #[test]
    fn period_is_8192_slots() {
        assert_eq!(ETHEREUM_MAINNET.period_at_slot(8191), 0);
        assert_eq!(ETHEREUM_MAINNET.period_at_slot(8192), 1);
        assert_eq!(PULSECHAIN.period_at_slot(10_870_784), 1327);
        assert_eq!(PULSECHAIN.period_at_slot(10_870_783), 1326);
    }
}
