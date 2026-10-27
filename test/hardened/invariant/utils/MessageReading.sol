// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {TokenMediator} from "../../../../src/hardened/mediator/TokenMediator.sol";

/// @title MessageReading
/// @notice Reads the payload of a message that a `TokenMediator` sends. The invariant handlers use it to learn what a
/// message delivers without the help of the mediator, so the check does not repeat the code that it checks.
library MessageReading {
    /// @notice What a mediator message asks the other mediator to do.
    /// @param nativeToken The token that the message names. It is the native token on its home chain, in all 12 forms.
    /// @param releasesNative True when the message releases the native token on its home chain, and false when it mints
    /// or deploys the bridged copy.
    /// @param recipient The account that should receive the tokens.
    /// @param value The value of the release.
    /// @param hasCall True when the delivery calls `onTokenBridged` on the account that received the tokens.
    /// @param callData The data of that call. Empty when `hasCall` is false.
    /// @param fallbackRecipient The account that receives the tokens when the recipient cannot.
    struct Reading {
        address nativeToken;
        bool releasesNative;
        address recipient;
        uint256 value;
        bool hasCall;
        bytes callData;
        address fallbackRecipient;
    }

    /// @notice Reads one message. It reverts for a selector that the mediator does not send.
    function read(bytes memory data) internal pure returns (Reading memory reading) {
        bytes4 selector = bytes4(data);
        bytes memory arguments = new bytes(data.length - 4);
        for (uint256 i = 0; i < arguments.length; i++) {
            arguments[i] = data[i + 4];
        }
        if (selector == TokenMediator.handleNativeTokens.selector) return _release(arguments, true, false, false);
        if (selector == TokenMediator.handleNativeTokensAndCall.selector) return _release(arguments, true, true, false);
        if (selector == TokenMediator.handleNativeTokensWithFallback.selector) {
            return _release(arguments, true, false, true);
        }
        if (selector == TokenMediator.handleNativeTokensAndCallWithFallback.selector) {
            return _release(arguments, true, true, true);
        }
        if (selector == TokenMediator.handleBridgedTokens.selector) return _release(arguments, false, false, false);
        if (selector == TokenMediator.handleBridgedTokensAndCall.selector) {
            return _release(arguments, false, true, false);
        }
        if (selector == TokenMediator.handleBridgedTokensWithFallback.selector) {
            return _release(arguments, false, false, true);
        }
        if (selector == TokenMediator.handleBridgedTokensAndCallWithFallback.selector) {
            return _release(arguments, false, true, true);
        }
        if (selector == TokenMediator.deployAndHandleBridgedTokens.selector) return _deploy(arguments, false, false);
        if (selector == TokenMediator.deployAndHandleBridgedTokensAndCall.selector) {
            return _deploy(arguments, true, false);
        }
        if (selector == TokenMediator.deployAndHandleBridgedTokensWithFallback.selector) {
            return _deploy(arguments, false, true);
        }
        if (selector == TokenMediator.deployAndHandleBridgedTokensAndCallWithFallback.selector) {
            return _deploy(arguments, true, true);
        }
        revert("MessageReading: not a mediator message");
    }

    function _release(bytes memory arguments, bool releasesNative, bool hasCall, bool hasFallback)
        private
        pure
        returns (Reading memory reading)
    {
        reading.releasesNative = releasesNative;
        reading.hasCall = hasCall;
        (reading.nativeToken, reading.recipient, reading.value) = abi.decode(arguments, (address, address, uint256));
        reading.fallbackRecipient = reading.recipient;
        if (hasCall && !hasFallback) {
            (,,, reading.callData) = abi.decode(arguments, (address, address, uint256, bytes));
        }
        if (!hasCall && hasFallback) {
            (,,, reading.fallbackRecipient) = abi.decode(arguments, (address, address, uint256, address));
        }
        if (hasCall && hasFallback) {
            (,,, reading.callData, reading.fallbackRecipient) =
                abi.decode(arguments, (address, address, uint256, bytes, address));
        }
    }

    function _deploy(bytes memory arguments, bool hasCall, bool hasFallback)
        private
        pure
        returns (Reading memory reading)
    {
        reading.hasCall = hasCall;
        (reading.nativeToken,,,, reading.recipient, reading.value) =
            abi.decode(arguments, (address, string, string, uint8, address, uint256));
        reading.fallbackRecipient = reading.recipient;
        if (hasCall && !hasFallback) {
            (,,,,,, reading.callData) = abi.decode(arguments, (address, string, string, uint8, address, uint256, bytes));
        }
        if (!hasCall && hasFallback) {
            (,,,,,, reading.fallbackRecipient) =
                abi.decode(arguments, (address, string, string, uint8, address, uint256, address));
        }
        if (hasCall && hasFallback) {
            (,,,,,, reading.callData, reading.fallbackRecipient) =
                abi.decode(arguments, (address, string, string, uint8, address, uint256, bytes, address));
        }
    }
}
