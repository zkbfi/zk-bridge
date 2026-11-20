// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";

/// @title FaucetToken
/// @notice An ERC-20 for the testnets only, `zkb Faucet Token` (`tFAU`, 18 decimals), that anyone may mint. It has no
/// value and exists only on testnets. People who test the bridge mint some here and send it through the mediator.
/// @dev There is no owner and no other privilege: every account may mint, at most `MAX_MINT` in one call. tUSD and tTKN
/// (`TestToken`) keep one minter because an unbounded public mint would let anyone print an amount near the 256 bit
/// limit in one call and send it through the mediator. The cap per call closes that path: 1,000 tokens are 10^21, about
/// 2^70, base units, so reaching an amount near 2^256 takes about 2^186 calls. A token sent through the mediator registers on
/// its first relay, and the flow limiter of the mediator applies to it as to any other token.
contract FaucetToken is ERC20 {
    /// @notice The most one call mints, in base units: 1,000 tokens.
    uint256 public constant MAX_MINT = 1_000e18;

    /// @notice The amount asked for is above `cap`, the most one call mints.
    error AboveMaxMint(uint256 amount, uint256 cap);

    constructor() ERC20("zkb Faucet Token", "tFAU") {}

    /// @notice Mints tokens to the caller.
    /// @param amount The amount in base units, at most `MAX_MINT`.
    function mint(uint256 amount) external {
        _mintCapped(msg.sender, amount);
    }

    /// @notice Mints tokens to any address.
    /// @param to The receiver.
    /// @param amount The amount in base units, at most `MAX_MINT`.
    function mint(address to, uint256 amount) external {
        _mintCapped(to, amount);
    }

    function _mintCapped(address to, uint256 amount) private {
        if (amount > MAX_MINT) revert AboveMaxMint(amount, MAX_MINT);
        _mint(to, amount);
    }
}
