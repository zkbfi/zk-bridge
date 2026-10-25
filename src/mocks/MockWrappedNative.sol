// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";

/// @title MockWrappedNative
/// @notice The wrapped native token of a test chain (a stand-in for WETH or WPLS). Anyone wraps the native coin with
/// `deposit`, and unwraps it with `withdraw`.
contract MockWrappedNative is ERC20 {
    /// @notice The coin could not be sent back on `withdraw`.
    error NativeTransferFailed();

    constructor() ERC20("Wrapped Native", "WNAT") {}

    function deposit() external payable {
        _mint(msg.sender, msg.value);
    }

    function withdraw(uint256 amount) external {
        _burn(msg.sender, amount);
        (bool sent,) = msg.sender.call{value: amount}("");
        if (!sent) revert NativeTransferFailed();
    }
}
