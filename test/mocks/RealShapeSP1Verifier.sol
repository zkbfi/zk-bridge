// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @title RealShapeSP1Verifier
/// @notice A test double, never deployed. Has only the real SP1 gateway function shape. It has no `verify` function.
contract RealShapeSP1Verifier {
    error InvalidProof();

    /// @notice Reverts on an invalid proof and returns nothing. Accepts the single proof 0x01.
    function verifyProof(bytes32, bytes calldata, bytes calldata proofBytes) external pure {
        if (proofBytes.length != 1 || proofBytes[0] != 0x01) revert InvalidProof();
    }
}
