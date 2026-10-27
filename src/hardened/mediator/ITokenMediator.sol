// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IOmnibridge} from "./IOmnibridge.sol";
import {IAMB} from "../IAMB.sol";

/// @title ITokenMediator
/// @notice The functions of `TokenMediator` that the routers call. `relayTokensAndCall` is the OmniBridge function.
/// `relayTokensWithFallback` is new.
interface ITokenMediator is IOmnibridge {
    /// @notice What a sender chooses for one relay, in `relayTokensWithOptions`.
    /// @param receiver The account that receives the tokens on the other chain.
    /// @param data The data of the call to `onTokenBridged` on the receiver. Empty data means no call. The mediator
    /// never reads the data: a router that reads a fee schedule from it owns its meaning.
    /// @param fallbackRecipient The account that receives the tokens when the receiver cannot. It cannot be zero.
    /// @param gasLimit The gas that the call on the other chain gets, or zero for the default of the message. The
    /// mediator uses the larger of this value and the default, and refuses a value above the maximum of the message
    /// bridge.
    struct RelayOptions {
        address receiver;
        bytes data;
        address fallbackRecipient;
        uint256 gasLimit;
    }

    function relayTokensAndCall(address token, address receiver, uint256 value, bytes calldata data) external;

    function relayTokensWithFallback(
        address token,
        address receiver,
        uint256 value,
        bytes calldata data,
        address fallbackRecipient
    ) external;

    /// @notice Relays tokens of the caller with every choice of the sender in one struct. New: OmniBridge has no such
    /// function.
    /// @param token The token to relay.
    /// @param value The amount to pull from the caller.
    /// @param options The receiver, the data, the fallback address and the gas limit.
    function relayTokensWithOptions(address token, uint256 value, RelayOptions calldata options) external;

    function bridgeContract() external view returns (IAMB);
}
