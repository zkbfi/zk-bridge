// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {ERC20Pausable} from "@openzeppelin/contracts/token/ERC20/extensions/ERC20Pausable.sol";

/// @title PausableToken
/// @notice The OpenZeppelin `ERC20Pausable` pattern, with a public mint, pause and unpause for tests. While the token is
/// paused, every transfer, mint and burn reverts, so a release to any account fails. It stands for a stablecoin that an
/// issuer can freeze.
contract PausableToken is ERC20Pausable {
    constructor(string memory name_, string memory symbol_) ERC20(name_, symbol_) {}

    /// @notice Mints tokens to an account. Anyone may call it.
    function mint(address to, uint256 amount) external {
        _mint(to, amount);
    }

    /// @notice Pauses every transfer. Anyone may call it.
    function pause() external {
        _pause();
    }

    /// @notice Lifts the pause. Anyone may call it.
    function unpause() external {
        _unpause();
    }
}
