// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";

/// @title TestToken
/// @notice A plain ERC-20 for the testnets, with its own decimals and one minter. It has no value. The traffic bot moves
/// it across the bridge, and people who test the bridge ask the minter for some.
/// @dev Only the minter mints, so the supply on each chain stays what the operator chose: a public mint would let anyone
/// print an amount near the 256 bit limit and send it through the mediator. The minter is fixed at deployment and
/// cannot change. There is no burn beyond what the mediator does with bridged copies (it locks a native token).
contract TestToken is ERC20 {
    /// @notice The only account that may mint.
    address public immutable minter;

    uint8 private immutable _decimals;

    /// @notice The caller is not the minter.
    error NotMinter(address caller);
    /// @notice The minter is the zero address.
    error ZeroMinter();

    /// @param name_ The name, such as `zkb Test Dollar`.
    /// @param symbol_ The symbol, such as `tUSD`. A bridged copy carries it with the prefix `z`.
    /// @param decimals_ The decimals, such as 6 for a dollar token.
    /// @param minter_ The account that may mint. Not zero.
    constructor(string memory name_, string memory symbol_, uint8 decimals_, address minter_) ERC20(name_, symbol_) {
        if (minter_ == address(0)) revert ZeroMinter();
        minter = minter_;
        _decimals = decimals_;
    }

    /// @inheritdoc ERC20
    function decimals() public view override returns (uint8) {
        return _decimals;
    }

    /// @notice Mints new tokens.
    /// @param to The receiver.
    /// @param amount The amount in base units.
    function mint(address to, uint256 amount) external {
        if (msg.sender != minter) revert NotMinter(msg.sender);
        _mint(to, amount);
    }
}
