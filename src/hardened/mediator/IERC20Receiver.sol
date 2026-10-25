// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @title IERC20Receiver
/// @notice The callback that a `...AndCall` delivery makes on the recipient (OmniBridge `IERC20Receiver`).
interface IERC20Receiver {
    /// @param token The token that the recipient received on this chain.
    /// @param value The amount that the recipient received.
    /// @param data The data that the sender passed through the bridge.
    function onTokenBridged(address token, uint256 value, bytes calldata data) external;
}
