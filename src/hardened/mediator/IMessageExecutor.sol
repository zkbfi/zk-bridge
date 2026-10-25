// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @title IMessageExecutor
/// @notice The execution entry of the message bridge, as the fee router sees it. The router forwards the encoded proof
/// and does not read it, so the router does not depend on the layout of the proof.
interface IMessageExecutor {
    /// @param encodedProof The proof that the message bridge verifies, in its own encoding.
    function executeMessage(bytes calldata encodedProof) external;
}
