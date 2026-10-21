// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @title IFlowLimiter
/// @notice A rule set that the vault asks before it books a deposit or pays a withdrawal. A limiter that reverts
/// refuses the call, and the whole transaction is undone. A limiter holds no tokens and no approval, so it cannot move
/// funds. It may change its own state, for example to record usage.
interface IFlowLimiter {
    /// @notice Checks a deposit, or reverts. The vault calls it after it measures the received amount and takes the fee.
    /// @param token The local token.
    /// @param depositor The sender of the deposit.
    /// @param amount The net amount that the vault bridges, after the fee.
    function checkDeposit(address token, address depositor, uint256 amount) external;

    /// @notice Checks a withdrawal, or reverts. The vault calls it after every proof check and before it marks the
    /// nonce claimed, so a refused withdrawal stays claimable.
    /// @param token The local token that the vault would pay.
    /// @param recipient The recipient of the payout.
    /// @param amount The amount that the vault would pay.
    /// @param nonce The nonce of the deposit on the other chain.
    function checkWithdrawal(address token, address recipient, uint256 amount, bytes32 nonce) external;
}
