// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IAMB} from "../../../src/hardened/mediator/IAMB.sol";

/// @notice A target that records everything the bridge shows it during a call: who called, the whole context, a hash of
/// the call data and the gas it got at its first instruction.
contract MessageRecorder {
    struct Call {
        address caller;
        address messageSender;
        bytes32 messageId;
        bytes32 sourceChainId;
        bytes32 transactionHash;
        bytes32 dataHash;
        uint256 gasAtEntry;
    }

    Call[] private _calls;

    function callCount() external view returns (uint256) {
        return _calls.length;
    }

    function callAt(uint256 index) external view returns (Call memory) {
        return _calls[index];
    }

    fallback() external {
        uint256 gasAtEntry = gasleft();
        IAMB bridge = IAMB(msg.sender);
        _calls.push(
            Call({
                caller: msg.sender,
                messageSender: bridge.messageSender(),
                messageId: bridge.messageId(),
                sourceChainId: bridge.messageSourceChainId(),
                transactionHash: bridge.transactionHash(),
                dataHash: keccak256(msg.data),
                gasAtEntry: gasAtEntry
            })
        );
    }
}

/// @notice A target that does nothing. It stands in for a target of no cost when a test measures the bridge.
contract MessageNoop {
    fallback() external {}
}

/// @notice A target that always reverts.
contract MessageReverter {
    fallback() external {
        revert("target failed");
    }
}

/// @notice A target that burns all the gas that it gets.
contract MessageBurner {
    fallback() external {
        while (true) {}
    }
}

/// @notice A target that calls the bridge with stored call data during its delivery and keeps the answer.
contract MessageReentrant {
    bytes public callData;
    bool public lastOk;
    bytes public lastReturn;

    function arm(bytes calldata callData_) external {
        callData = callData_;
    }

    fallback() external {
        (lastOk, lastReturn) = msg.sender.call(callData);
    }
}

/// @notice A target that sends a message through the bridge during its own delivery and keeps what the bridge shows
/// afterwards.
contract MessageSending {
    bytes32 public sentId;
    bytes32 public contextIdAfterSend;

    fallback() external {
        sentId = IAMB(msg.sender).requireToPassMessage(address(0x1234), hex"deadbeef", 100_000);
        contextIdAfterSend = IAMB(msg.sender).messageId();
    }
}

/// @notice A gate that records the calls and refuses on demand.
contract MessageGate {
    error GateRefused(bytes evidence);

    uint256 public calls;
    bool public refusing;

    function setRefusing(bool value) external {
        refusing = value;
    }

    function admit(bytes calldata evidence) external {
        if (refusing) revert GateRefused(evidence);
        calls++;
    }
}
