// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @title IForkRegistry
/// @notice The part of the fork observation registry that the deposit gate reads. The gate judges the shape with `ForkShape`.
interface IForkRegistry {
    /// @notice The fork version seen under the highest attested slot, the shape of the attested state that carried it,
    /// and that slot.
    /// @return version The version. It is meaningful only when `slot` is not zero.
    /// @return shape The proven shape of the state: a plain depth (5, 6 or 7), or 255 for the progressive form.
    /// Meaningful only when `slot` is not zero.
    /// @return slot The highest observed attested slot, or zero when nothing was observed.
    function latestObserved() external view returns (bytes4 version, uint8 shape, uint64 slot);
}
