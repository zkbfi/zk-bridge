// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

/// @title BeaconClock
/// @notice The slot that a timestamp falls in, on one beacon chain. The deposit gate and the light client share it,
/// so both read the clock with the same formula.
library BeaconClock {
    /// @notice The slot at `timestamp`, or zero when the timestamp is before genesis.
    /// @param timestamp The time in seconds.
    /// @param genesisTime The genesis time of the beacon chain, in seconds. It must not be zero.
    /// @param secondsPerSlot The seconds per slot of the beacon chain. It must not be zero.
    function slotAt(uint256 timestamp, uint64 genesisTime, uint64 secondsPerSlot) internal pure returns (uint64) {
        if (timestamp < genesisTime) return 0;
        return uint64((timestamp - genesisTime) / secondsPerSlot);
    }
}
