// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {TokenMediator} from "../../../../src/hardened/mediator/TokenMediator.sol";

/// @title MessageReading
/// @notice Reads the payload of a message that a `TokenMediator` sends. The invariant handlers use it to learn what a
/// message delivers without the help of the mediator, so the check does not repeat the code that it checks.
library MessageReading {
    /// @notice What a mediator message asks the other mediator to do.
    /// @param nativeToken The token that the message names. It is the native token on its home chain, in all six forms.
    /// @param releasesNative True when the message releases the native token on its home chain, and false when it mints
    /// or deploys the bridged copy.
    /// @param recipient The account that should receive the tokens.
    /// @param value The value of the release.
    /// @param hasCall True when the delivery calls `onTokenBridged` on the account that received the tokens.
    /// @param callData The data of that call. Empty when `hasCall` is false.
    struct Reading {
        address nativeToken;
        bool releasesNative;
        address recipient;
        uint256 value;
        bool hasCall;
        bytes callData;
    }

    /// @notice Reads one message. It reverts for a selector that the mediator does not send.
    function read(bytes memory data) internal pure returns (Reading memory reading) {
        bytes4 selector = bytes4(data);
        bytes memory arguments = new bytes(data.length - 4);
        for (uint256 i = 0; i < arguments.length; i++) {
            arguments[i] = data[i + 4];
        }
        if (selector == TokenMediator.handleNativeTokens.selector) return _release(arguments, true, false);
        if (selector == TokenMediator.handleNativeTokensAndCall.selector) return _release(arguments, true, true);
        if (selector == TokenMediator.handleBridgedTokens.selector) return _release(arguments, false, false);
        if (selector == TokenMediator.handleBridgedTokensAndCall.selector) return _release(arguments, false, true);
        if (selector == TokenMediator.deployAndHandleBridgedTokens.selector) return _deploy(arguments, false);
        if (selector == TokenMediator.deployAndHandleBridgedTokensAndCall.selector) return _deploy(arguments, true);
        revert("MessageReading: not a mediator message");
    }

    function _release(bytes memory arguments, bool releasesNative, bool hasCall)
        private
        pure
        returns (Reading memory reading)
    {
        reading.releasesNative = releasesNative;
        reading.hasCall = hasCall;
        (reading.nativeToken, reading.recipient, reading.value) = abi.decode(arguments, (address, address, uint256));
        if (!hasCall) return reading;
        (,,, reading.callData) = abi.decode(arguments, (address, address, uint256, bytes));
    }

    function _deploy(bytes memory arguments, bool hasCall) private pure returns (Reading memory reading) {
        reading.hasCall = hasCall;
        (reading.nativeToken,,,, reading.recipient, reading.value) =
            abi.decode(arguments, (address, string, string, uint8, address, uint256));
        if (!hasCall) return reading;
        (,,,,,, reading.callData) = abi.decode(arguments, (address, string, string, uint8, address, uint256, bytes));
    }
}
