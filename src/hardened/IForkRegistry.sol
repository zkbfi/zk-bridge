// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @title IForkRegistry
/// @notice The part of the fork observation registry that the deposit gate reads.
interface IForkRegistry {
    /// @notice The fork version seen under the highest attested slot, and that slot.
    /// @return version The version. It is meaningful only when `slot` is not zero.
    /// @return slot The highest observed attested slot, or zero when nothing was observed.
    function latestObserved() external view returns (bytes4 version, uint64 slot);
}
