// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

/// @title IERC677
/// @notice A token that calls the receiver after a transfer (`transferAndCall`), with the allowance helpers of
/// OmniBridge (`omni/omnibridge`, `contracts/interfaces/IERC677.sol`).
interface IERC677 is IERC20 {
    /// @notice Emitted by `transferAndCall` in addition to the standard `Transfer`.
    event Transfer(address indexed from, address indexed to, uint256 value, bytes data);

    /// @notice Moves tokens, then calls `onTokenTransfer(msg.sender, value, data)` on `to` when `to` is a contract.
    function transferAndCall(address to, uint256 value, bytes calldata data) external returns (bool);

    /// @notice Raises the allowance of `spender`.
    function increaseAllowance(address spender, uint256 addedValue) external returns (bool);

    /// @notice Lowers the allowance of `spender`.
    function decreaseAllowance(address spender, uint256 subtractedValue) external returns (bool);
}
