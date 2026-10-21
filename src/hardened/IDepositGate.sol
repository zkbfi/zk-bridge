// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @title IDepositGate
/// @notice A check that the vault runs first in `deposit`. A gate that reverts refuses the deposit.
interface IDepositGate {
    /// @notice Admits a deposit, or reverts.
    /// @param evidence Gate-specific evidence. The vault passes the `gateEvidence` of the deposit unchanged.
    function admit(bytes calldata evidence) external;
}
