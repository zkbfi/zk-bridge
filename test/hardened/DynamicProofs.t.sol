// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Vm} from "forge-std/Vm.sol";
import {BeaconProofVerifier} from "../../src/hardened/BeaconProofVerifier.sol";
import {MessageBridge} from "../../src/hardened/MessageBridge.sol";
import {MessageScenes} from "./utils/MessageScenes.sol";
import {MessageFixtures} from "./utils/MessageFixtures.sol";
import {MessageRecorder} from "./utils/MessageTargets.sol";
import {DynamicProofs} from "./utils/DynamicProofs.sol";
import {WithdrawalScenes} from "./utils/WithdrawalScenes.sol";

/// @notice Tests of the proof builder that the integration tests rely on: a message that a real `MessageBridge` sends is
/// delivered by another real `MessageBridge` through a proof built from the logs of the send.
contract DynamicProofsTest is MessageScenes, DynamicProofs {
    /// @dev Both bases build on `WithdrawalScenes.setUp`, and `MessageScenes` extends it, so the combination must say so.
    function setUp() public override(MessageScenes, WithdrawalScenes) {
        super.setUp();
    }

    function _sendOnSource(bytes memory data) internal returns (Vm.Log[] memory recorded, bytes32 id) {
        vm.chainId(CHAIN_A);
        vm.recordLogs();
        vm.prank(MessageFixtures.SENDER);
        id = sourceBridge.requireToPassMessage(MessageFixtures.TARGET_RECORDER, data, 300_000);
        recorded = vm.getRecordedLogs();
    }

    /// Claim: a proof built from the logs of a real send makes the destination bridge call the target with the real
    /// identifier, sender, source chain and transaction hash. Shows: the recorder sees the identifier that the send
    /// returned, the sender of the send, chain 1, and the hash of the transaction that the builder put in the block.
    /// Matters: every integration test trusts this builder, so it must prove a real log and not a made-up one.
    function test_aRealSendIsDeliveredThroughABuiltProof() public {
        (Vm.Log[] memory recorded, bytes32 id) = _sendOnSource(hex"c0ffee");
        SourceTransaction memory source = _sourceTransactionOf(recorded);
        uint256 logIndex = _logIndexOf(recorded, address(sourceBridge), sourceBridge.USER_REQUEST_TOPIC());
        (MessageBridge.MessageProof memory proof, bytes32 transactionHash) =
            _proveMessage(bridge, lightClientForB, GENESIS_ROOT_A, source, logIndex);
        assertEq(transactionHash, _transactionHashOf(source), "the builder reports the hash of its transaction");

        vm.chainId(CHAIN_B);
        bridge.executeMessage(proof);

        assertTrue(bridge.messageCallStatus(id), "the message was delivered");
        MessageRecorder.Call memory call = recorder.callAt(recorder.callCount() - 1);
        assertEq(call.messageId, id, "the identifier of the send");
        assertEq(call.messageSender, MessageFixtures.SENDER, "the sender of the send");
        assertEq(call.sourceChainId, bytes32(uint256(CHAIN_A)), "the source chain");
        assertEq(call.transactionHash, transactionHash, "the hash of the transaction that held the log");
        assertEq(call.dataHash, keccak256(hex"c0ffee"), "the data of the send");
    }

    /// Claim: two sends in two blocks are both delivered, in the reverse order. Shows: the proof of the second send
    /// delivers first, then the proof of the first. Matters: each build adds its own scene (a new anchor and new rows), so
    /// proofs of different blocks must not disturb each other.
    function test_twoSendsAreBothDeliveredInAnyOrder() public {
        (Vm.Log[] memory first, bytes32 firstId) = _sendOnSource("one");
        (Vm.Log[] memory second, bytes32 secondId) = _sendOnSource("two");
        address emitter = address(sourceBridge);
        bytes32 topic = sourceBridge.USER_REQUEST_TOPIC();

        (MessageBridge.MessageProof memory firstProof,) = _proveMessage(
            bridge, lightClientForB, GENESIS_ROOT_A, _sourceTransactionOf(first), _logIndexOf(first, emitter, topic)
        );
        (MessageBridge.MessageProof memory secondProof,) = _proveMessage(
            bridge, lightClientForB, GENESIS_ROOT_A, _sourceTransactionOf(second), _logIndexOf(second, emitter, topic)
        );
        vm.chainId(CHAIN_B);
        bridge.executeMessage(secondProof);
        bridge.executeMessage(firstProof);
        assertTrue(bridge.messageCallStatus(firstId));
        assertTrue(bridge.messageCallStatus(secondId));
    }

    /// Claim: a proof that names a log past the end of the receipt is refused. Shows: the receipt of a send holds one
    /// log, so log index 1 reverts with `LogIndexOutOfRange(1, 1)`, and log index 0 still delivers. Matters: the log index
    /// of a built proof means something, so the tests that move it can fail.
    function test_aLogIndexPastTheEndIsRefused() public {
        (Vm.Log[] memory recorded, bytes32 id) = _sendOnSource("one");
        (MessageBridge.MessageProof memory proof,) = _proveMessage(
            bridge, lightClientForB, GENESIS_ROOT_A, _sourceTransactionOf(recorded), 1
        );
        vm.chainId(CHAIN_B);
        vm.expectRevert(abi.encodeWithSelector(BeaconProofVerifier.LogIndexOutOfRange.selector, 1, 1));
        bridge.executeMessage(proof);

        proof.logIndex = 0;
        bridge.executeMessage(proof);
        assertTrue(bridge.messageCallStatus(id));
    }
}
