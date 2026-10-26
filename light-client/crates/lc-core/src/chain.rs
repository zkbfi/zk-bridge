//! Chain configuration: fork schedule, slot timing and the genesis validators root.
//!
//! Values for Ethereum mainnet come from a live beacon API (see `tests/fixtures/ethereum/chain_spec.json`
//! and `scripts/fetch-fixtures.sh`). Values for PulseChain come from the build contract and from
//! `https://rpc-pulsechain.g4mm4.io/beacon-api` (see `tests/fixtures/pulsechain/chain_spec.json`).
//! Values for Sepolia and PulseChain testnet v4 come from the beacon API of a node of each chain (see
//! `tests/fixtures/sepolia/` and `tests/fixtures/pulsechain-testnet-v4/`).
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
    /// Not scheduled on Ethereum mainnet. Active on Sepolia from epoch 353024. It replaces the execution payload in the
    /// block body by a signed bid, and it makes `BeaconState` and `BeaconBlockBody` progressive containers. See
    /// [`crate::layout::GLOAS_STATE_LAYOUT`].
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

/// The fork schedule of Sepolia (chain identifier 11155111).
///
/// Source: `GET /eth/v1/config/spec` and `GET /eth/v1/config/fork_schedule` of a Sepolia beacon node, fetched
/// 2026-10-26 (`tests/fixtures/sepolia/`). The specification also lists a Heze fork (version `0x90000077`, epoch
/// `18446744073709551615`). `ForkName` has no Heze, so the table leaves it out, as the mainnet table leaves out forks
/// that this crate does not know.
const SEPOLIA_FORKS: [ForkEntry; 8] = [
    ForkEntry { epoch: 0, fork_version: [0x90, 0x00, 0x00, 0x69], fork_name: ForkName::Phase0 },
    ForkEntry { epoch: 50, fork_version: [0x90, 0x00, 0x00, 0x70], fork_name: ForkName::Altair },
    ForkEntry { epoch: 100, fork_version: [0x90, 0x00, 0x00, 0x71], fork_name: ForkName::Bellatrix },
    ForkEntry { epoch: 56_832, fork_version: [0x90, 0x00, 0x00, 0x72], fork_name: ForkName::Capella },
    ForkEntry { epoch: 132_608, fork_version: [0x90, 0x00, 0x00, 0x73], fork_name: ForkName::Deneb },
    ForkEntry { epoch: 222_464, fork_version: [0x90, 0x00, 0x00, 0x74], fork_name: ForkName::Electra },
    ForkEntry { epoch: 272_640, fork_version: [0x90, 0x00, 0x00, 0x75], fork_name: ForkName::Fulu },
    ForkEntry { epoch: 353_024, fork_version: [0x90, 0x00, 0x00, 0x76], fork_name: ForkName::Gloas },
];

/// Sepolia (chain identifier 11155111). Genesis time 1655733600, 12 seconds per slot.
///
/// Source: `/eth/v1/beacon/genesis` and `/eth/v1/config/spec` of a Sepolia beacon node, fetched 2026-10-26.
pub const SEPOLIA: ChainSpec = ChainSpec {
    name: "sepolia",
    genesis_validators_root: b256!("d8ea171f3c94aea21ebc42a1ed61052acf3f9209c00e4efbaaddac09ed9b8078"),
    fork_schedule: &SEPOLIA_FORKS,
    seconds_per_slot: 12,
    slots_per_epoch: 32,
    epochs_per_sync_committee_period: 256,
};

/// The fork schedule of PulseChain testnet v4 (`CONFIG_NAME` `pulsechain-testnet-v4`).
///
/// Source: `GET /eth/v1/config/spec` and `GET /eth/v1/config/fork_schedule` of a node of the chain, fetched 2026-10-26
/// (`tests/fixtures/pulsechain-testnet-v4/`). Like PulseChain mainnet, it stopped at Capella: Deneb is never scheduled
/// (`DENEB_FORK_EPOCH` is `18446744073709551615`, version `0xffffffff`).
const PULSECHAIN_TESTNET_V4_FORKS: [ForkEntry; 5] = [
    ForkEntry { epoch: 0, fork_version: [0x00, 0x00, 0x09, 0x43], fork_name: ForkName::Phase0 },
    ForkEntry { epoch: 1, fork_version: [0x00, 0x00, 0x09, 0x44], fork_name: ForkName::Altair },
    ForkEntry { epoch: 2, fork_version: [0x00, 0x00, 0x09, 0x45], fork_name: ForkName::Bellatrix },
    ForkEntry { epoch: 4_200, fork_version: [0x00, 0x00, 0x09, 0x46], fork_name: ForkName::Capella },
    ForkEntry { epoch: FAR_FUTURE_EPOCH, fork_version: [0xff, 0xff, 0xff, 0xff], fork_name: ForkName::Deneb },
];

/// PulseChain testnet v4 (chain identifier 943). Genesis time 1681356369, 10 seconds per slot.
///
/// Source: `/eth/v1/beacon/genesis` and `/eth/v1/config/spec` of a node of the chain, fetched 2026-10-26.
pub const PULSECHAIN_TESTNET_V4: ChainSpec = ChainSpec {
    name: "pulsechain-testnet-v4",
    genesis_validators_root: b256!("d81664ba97279a6fa0832041b4aee6009172b4750a99467ff670a9faf3a34e64"),
    fork_schedule: &PULSECHAIN_TESTNET_V4_FORKS,
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

    /// Claim: on Sepolia the fork version switches exactly at each fork epoch, never one epoch early. The epochs and
    /// versions are written by hand from the fork schedule of the beacon node.
    #[test]
    fn sepolia_fork_version_switches_exactly_at_each_epoch() {
        let schedule: [(u64, [u8; 4]); 8] = [
            (0, [0x90, 0, 0, 0x69]),
            (50, [0x90, 0, 0, 0x70]),
            (100, [0x90, 0, 0, 0x71]),
            (56_832, [0x90, 0, 0, 0x72]),
            (132_608, [0x90, 0, 0, 0x73]),
            (222_464, [0x90, 0, 0, 0x74]),
            (272_640, [0x90, 0, 0, 0x75]),
            (353_024, [0x90, 0, 0, 0x76]),
        ];
        for (position, (epoch, version)) in schedule.iter().enumerate() {
            assert_eq!(SEPOLIA.fork_version_at(*epoch), *version, "at epoch {epoch}");
            if position > 0 {
                assert_eq!(SEPOLIA.fork_version_at(epoch - 1), schedule[position - 1].1, "one epoch before {epoch}");
            }
        }
        assert_eq!(SEPOLIA.fork_version_at(u64::MAX - 1), [0x90, 0, 0, 0x76], "no later fork is known");
        assert_eq!(SEPOLIA.fork_at_slot(353_024 * 32 - 1), ForkName::Fulu);
        assert_eq!(SEPOLIA.fork_at_slot(353_024 * 32), ForkName::Gloas);
    }

    /// Claim: on PulseChain testnet v4 the fork version switches exactly at epochs 1, 2 and 4200, and Deneb never starts.
    #[test]
    fn pulsechain_testnet_v4_fork_version_switches_exactly_at_each_epoch() {
        assert_eq!(PULSECHAIN_TESTNET_V4.fork_version_at(0), [0, 0, 0x09, 0x43]);
        assert_eq!(PULSECHAIN_TESTNET_V4.fork_version_at(1), [0, 0, 0x09, 0x44]);
        assert_eq!(PULSECHAIN_TESTNET_V4.fork_version_at(2), [0, 0, 0x09, 0x45]);
        assert_eq!(PULSECHAIN_TESTNET_V4.fork_version_at(4_199), [0, 0, 0x09, 0x45]);
        assert_eq!(PULSECHAIN_TESTNET_V4.fork_version_at(4_200), [0, 0, 0x09, 0x46]);
        for epoch in [4_201, 1 << 40, u64::MAX - 1] {
            assert_eq!(PULSECHAIN_TESTNET_V4.fork_entry_at_epoch(epoch).fork_name, ForkName::Capella);
        }
    }

    /// Claim: `capellaEra` is written out by hand. Sepolia: Capella epoch 56832, slot 56832 * 32 = 1818624, and
    /// 1818624 / 8192 = 222 exactly (222 * 8192 = 1818624). Chain 943: Capella epoch 4200, slot 4200 * 32 = 134400, and
    /// 134400 / 8192 = 16 with integer division (16 * 8192 = 131072, the rest is 3328).
    #[test]
    fn capella_era_of_the_testnets_is_written_by_hand() {
        assert_eq!(56_832 * 32, 1_818_624);
        assert_eq!(222 * 8_192, 1_818_624);
        assert_eq!(SEPOLIA.capella_fork_slot(), Some(1_818_624));
        assert_eq!(SEPOLIA.capella_era(), Ok(222));
        assert_eq!(4_200 * 32, 134_400);
        assert_eq!(16 * 8_192, 131_072);
        assert_eq!(134_400 - 131_072, 3_328);
        assert_eq!(PULSECHAIN_TESTNET_V4.capella_fork_slot(), Some(134_400));
        assert_eq!(PULSECHAIN_TESTNET_V4.capella_era(), Ok(16));
    }
}
