// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @title ISP1Verifier
/// @notice The shape of the Succinct SP1 verifier gateway.
/// @dev The call reverts when the proof is invalid and returns nothing when it is valid.
interface ISP1Verifier {
    /// @notice Verifies an SP1 proof.
    /// @param programVKey The verification key of the program that produced the proof.
    /// @param publicValues The public values that the program committed.
    /// @param proofBytes The encoded proof.
    function verifyProof(bytes32 programVKey, bytes calldata publicValues, bytes calldata proofBytes) external view;
}
