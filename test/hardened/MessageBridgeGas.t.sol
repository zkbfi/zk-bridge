// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {MessageBridge} from "../../src/hardened/MessageBridge.sol";
import {MessageScenes} from "./utils/MessageScenes.sol";
import {MessageFixtures} from "./utils/MessageFixtures.sol";
import {MessageNoop} from "./utils/MessageTargets.sol";

/// @notice The gas of `executeMessage`, with a target that does nothing, so that the number is the cost of the bridge:
/// the proof, the bookkeeping and the context. The first delivery of a fresh bridge is measured (every slot cold).
contract MessageBridgeGasTest is MessageScenes {
    function setUp() public override {
        super.setUp();
        vm.etch(MessageFixtures.TARGET_RECORDER, address(new MessageNoop()).code);
    }

    function _measure(MessageBridge.MessageProof memory proof) internal returns (uint256 used) {
        uint256 before = gasleft();
        bridge.executeMessage(proof);
        used = before - gasleft();
    }

    /// Gas of a delivery through the recent path (the anchor is 2000 slots above the block), for a type 2 receipt
    /// with one log and a transaction trie of 40 entries.
    function test_gas_executeMessage_recentPath() public {
        Scene memory scene = _messageScene(bridge);
        uint256 used = _measure(_messageProof(scene, MessageFixtures.deliver()));
        emit log_named_uint("executeMessage, recent path, successful call to a target that does nothing", used);
        assertLt(used, 400_000);
    }

    /// Gas of a delivery through the historical path (more than 8192 slots), where the ancestry branch is 45 siblings long.
    function test_gas_executeMessage_historicalPath() public {
        (, MessageBridge.MessageProof memory proof) = _historicalMessage();
        uint256 used = _measure(proof);
        emit log_named_uint("executeMessage, historical path, successful call to a target that does nothing", used);
        assertLt(used, 450_000);
    }

    /// Gas of a delivery whose call fails. The delivery reverts with the error of the target, so the executor pays the
    /// proof and the call and nothing is stored. Measured with a low-level call, which returns false.
    function test_gas_executeMessage_failedCall() public {
        // PUSH1 0, PUSH1 0, REVERT: a target that always reverts, as cheap as it can be.
        vm.etch(MessageFixtures.TARGET_REVERTER, hex"60006000fd");
        Scene memory scene = _messageScene(bridge);
        MessageBridge.MessageProof memory proof = _messageProof(scene, MessageFixtures.reverting());
        uint256 before = gasleft();
        (bool ok,) = address(bridge).call(abi.encodeCall(MessageBridge.executeMessage, (proof)));
        uint256 used = before - gasleft();
        assertFalse(ok, "the delivery reverts");
        emit log_named_uint("executeMessage, recent path, call that reverts (the delivery reverts)", used);
        assertLt(used, 450_000);
    }
}
