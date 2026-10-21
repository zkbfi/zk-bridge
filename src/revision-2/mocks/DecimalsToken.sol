// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";

/// @title DecimalsToken
/// @notice Plain ERC-20 with a configurable number of decimals and a public mint (R2-07).
contract DecimalsToken is ERC20 {
    uint8 private immutable _decimals;

    constructor(string memory name_, string memory symbol_, uint8 decimals_) ERC20(name_, symbol_) {
        _decimals = decimals_;
    }

    /// @notice Returns the configured decimals.
    function decimals() public view override returns (uint8) {
        return _decimals;
    }

    /// @notice Mints `amount` to `to`.
    function mint(address to, uint256 amount) external {
        _mint(to, amount);
    }
}
