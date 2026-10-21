// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @title IBeaconLightClient
/// @notice The part of the light client that the vault reads.
interface IBeaconLightClient {
    /// @notice The finalized beacon header root stored for a slot, or zero.
    /// @param slot The beacon slot.
    function headers(uint64 slot) external view returns (bytes32);

    /// @notice The execution block hash stored for the head at a slot, or zero.
    /// @param slot The beacon slot.
    function executionBlockHashes(uint64 slot) external view returns (bytes32);

    /// @notice Whether the execution block hash sits in a finalized beacon header.
    /// @param blockHash The execution block hash.
    function isFinalizedExecutionBlock(bytes32 blockHash) external view returns (bool);
}
