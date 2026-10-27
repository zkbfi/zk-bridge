// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";

/// @title BlockableToken
/// @notice A plain ERC-20 with a public mint and a block list, for the end-to-end run. A transfer to a blocked account
/// reverts, as a stablecoin with a block list does. It stands in for a token that refuses a payout.
contract BlockableToken is ERC20 {
    /// @notice The account is blocked.
    error Blocked(address account);

    /// @notice Whether an account refuses incoming transfers.
    mapping(address account => bool) public blocked;

    constructor(string memory name_, string memory symbol_) ERC20(name_, symbol_) {}

    /// @notice Mints tokens to an account. Anyone may call it.
    function mint(address to, uint256 amount) external {
        _mint(to, amount);
    }

    /// @notice Blocks or unblocks an account. Anyone may call it.
    function setBlocked(address account, bool isBlocked) external {
        blocked[account] = isBlocked;
    }

    function _update(address from, address to, uint256 value) internal override {
        if (blocked[to]) revert Blocked(to);
        super._update(from, to, value);
    }
}
