// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IERC677} from "./IERC677.sol";

/// @title IBurnableMintableERC677Token
/// @notice The bridged token interface of OmniBridge without `claimTokens`, which is an owner function.
interface IBurnableMintableERC677Token is IERC677 {
    /// @notice Mints tokens. Only the mediator may call it.
    function mint(address to, uint256 amount) external returns (bool);

    /// @notice Burns tokens of the caller. Only the mediator may call it.
    function burn(uint256 value) external;
}
