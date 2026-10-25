// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IOmnibridge} from "./IOmnibridge.sol";
import {IAMB} from "./IAMB.sol";

/// @title ITokenMediator
/// @notice The functions of `TokenMediator` that the routers call. `relayTokensAndCall` is the OmniBridge function.
/// `relayTokensWithFallback` is new.
interface ITokenMediator is IOmnibridge {
    function relayTokensAndCall(address token, address receiver, uint256 value, bytes calldata data) external;

    function relayTokensWithFallback(
        address token,
        address receiver,
        uint256 value,
        bytes calldata data,
        address fallbackRecipient
    ) external;

    function bridgeContract() external view returns (IAMB);
}
