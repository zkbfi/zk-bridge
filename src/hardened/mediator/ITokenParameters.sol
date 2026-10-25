// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @title ITokenParameters
/// @notice The factory exposes the parameters of the token that it is deploying. The token reads them in its
/// constructor. So the creation code of a bridged token has no arguments, and its address depends on the factory and
/// the salt only.
interface ITokenParameters {
    /// @return name The token name.
    /// @return symbol The token symbol.
    /// @return decimals The token decimals.
    /// @return mediator The mediator that may mint and burn the token.
    function parameters()
        external
        view
        returns (string memory name, string memory symbol, uint8 decimals, address mediator);
}
