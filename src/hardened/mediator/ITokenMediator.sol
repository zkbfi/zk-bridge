// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IOmnibridge} from "./IOmnibridge.sol";
import {IAMB} from "../IAMB.sol";

/// @title ITokenMediator
/// @notice The functions of `TokenMediator` that the routers call. `relayTokens` is the OmniBridge function.
/// `relayTokensAndCall` takes one more argument than in OmniBridge: the gas of the callback, which the sender states
/// because there is no default.
interface ITokenMediator is IOmnibridge {
    /// @notice Relays tokens of the caller to `receiver` and calls `onTokenBridged` on it on the other chain with exactly
    /// `callbackGas`. Zero reverts.
    /// @param callbackGas The gas of the callback on the other chain. The delivery reverts when it cannot give that
    /// gas, and records `CallbackFailed` when the callback fails with it.
    function relayTokensAndCall(address token, address receiver, uint256 value, bytes calldata data, uint256 callbackGas)
        external;

    function bridgeContract() external view returns (IAMB);
}
