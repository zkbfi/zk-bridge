// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Vm} from "forge-std/Vm.sol";
import {BeaconProofVerifier} from "../../src/hardened/BeaconProofVerifier.sol";
import {MessageBridge} from "../../src/hardened/MessageBridge.sol";
import {AmbMessageCodec} from "../../src/hardened/AmbMessageCodec.sol";
import {MessageScenes} from "./utils/MessageScenes.sol";
import {MessageFixtures} from "./utils/MessageFixtures.sol";
import {MessageRecorder} from "./utils/MessageTargets.sol";

/// @notice Delivery tests of the message bridge: what `executeMessage` does with an honest proof. The refusals of bad
/// proofs are in `MessageBridgeProof.t.sol`.
contract MessageBridgeDeliveryTest is MessageScenes {
    event AffirmationCompleted(address indexed sender, address indexed executor, bytes32 indexed messageId, bool status);

    function _payload() internal pure returns (bytes memory payload) {
        payload = new bytes(70);
        for (uint256 i = 0; i < payload.length; i++) {
            payload[i] = bytes1(uint8(i));
        }
    }

    function _expectCompleted(MessageFixtures.Named memory named, address executor, bool status) internal {
        vm.expectEmit(true, true, true, true, address(bridge));
        emit AffirmationCompleted(MessageFixtures.SENDER, executor, named.messageId, status);
    }

    function _lastCall() internal view returns (MessageRecorder.Call memory) {
        return recorder.callAt(recorder.callCount() - 1);
    }

    function _assertContextClear() internal view {
        assertEq(bridge.messageSender(), address(0), "the sender is cleared");
        assertEq(bridge.messageId(), bytes32(0), "the identifier is cleared");
        assertEq(bridge.messageSourceChainId(), bytes32(0), "the source chain is cleared");
        assertEq(bridge.transactionHash(), bytes32(0), "the transaction hash is cleared");
    }

    // ================================================================ honest delivery

    /// Claim: a valid message is delivered to its target with its data, and the bridge emits `AffirmationCompleted`.
    /// Shows: the target ran once, called by the bridge, with the 70 bytes of the fixture; the status is true and no
    /// failure data exists. Matters: this is the one thing that the bridge is for.
    function test_deliver_validMessageCallsTheTarget() public {
        Scene memory scene = _messageScene(bridge);
        MessageFixtures.Named memory named = MessageFixtures.deliver();
        _expectCompleted(named, address(recorder), true);
        bridge.executeMessage(_messageProof(scene, named));

        assertEq(recorder.callCount(), 1, "the target ran once");
        MessageRecorder.Call memory call = _lastCall();
        assertEq(call.caller, address(bridge), "the bridge is the caller");
        assertEq(call.dataHash, keccak256(_payload()), "the target got the data of the message, byte for byte");
        assertTrue(bridge.messageCallStatus(named.messageId), "the status records success");
        assertEq(bridge.failedMessageDataHash(named.messageId), bytes32(0), "a success leaves no failure data");
        assertEq(bridge.failedMessageReceiver(named.messageId), address(0));
        assertEq(bridge.failedMessageSender(named.messageId), address(0));
    }

    /// Claim: during the call the target sees the sender, the identifier, the source chain and the proven transaction
    /// hash, and the target gets exactly the gas of the message. Shows: each value equals the independent fixture
    /// value (the identifier and the hash come from the Python generator). Matters: a target trusts a message by this
    /// context. The transaction hash is the hash of the transaction that the proof reaches, not a value that the executor names.
    function test_deliver_contextShowsTheProvenValuesDuringTheCall() public {
        Scene memory scene = _messageScene(bridge);
        MessageFixtures.Named memory named = MessageFixtures.deliver();
        bridge.executeMessage(_messageProof(scene, named));

        MessageRecorder.Call memory call = _lastCall();
        assertEq(call.messageSender, MessageFixtures.SENDER, "the sender of the source chain");
        assertEq(call.messageId, named.messageId, "the identifier of the message");
        assertEq(call.sourceChainId, bytes32(uint256(MessageFixtures.SOURCE_CHAIN_ID)), "the source chain, as a word");
        assertEq(call.transactionHash, named.transactionHash, "the proven hash of the source transaction");
        assertGe(call.gasAtEntry, 500_000 - 200, "the target got the gas that the message asked for");
        assertLe(call.gasAtEntry, 500_000, "and not more");
    }

    /// Claim: the context is cleared after a delivery, whether the call succeeded or reverted. Shows: all four views are
    /// zero after a success and after a revert of the target. Matters: a stale context would let a later caller pass as
    /// the sender of an old message.
    function test_deliver_contextIsClearedAfterTheCall() public {
        Scene memory scene = _messageScene(bridge);
        bridge.executeMessage(_messageProof(scene, MessageFixtures.deliver()));
        _assertContextClear();
        bridge.executeMessage(_messageProof(scene, MessageFixtures.reverting()));
        _assertContextClear();
        bridge.executeMessage(_messageProof(scene, MessageFixtures.burning()));
        _assertContextClear();
    }

    /// Claim: a message sent with `requireToConfirmMessage` (data type 0x80) is delivered like any other. Shows: the
    /// target runs and the status is true. Matters: OmniBridge senders may use either call.
    function test_deliver_confirmMessageIsDelivered() public {
        Scene memory scene = _messageScene(bridge);
        MessageFixtures.Named memory named = MessageFixtures.confirm();
        bridge.executeMessage(_messageProof(scene, named));
        assertTrue(bridge.messageCallStatus(named.messageId));
        assertEq(_lastCall().dataHash, keccak256("confirm"));
    }

    /// Claim: a message with no call data in a legacy receipt and a legacy transaction is delivered. Shows: the target
    /// is called with empty data, and the transaction hash is the hash of the bare RLP list. Matters: a transaction
    /// without a type byte hashes differently from a typed one, and both must give the true hash.
    function test_deliver_emptyDataInALegacyTransaction() public {
        Scene memory scene = _messageScene(bridge);
        MessageFixtures.Named memory named = MessageFixtures.empty_data();
        bridge.executeMessage(_messageProof(scene, named));
        MessageRecorder.Call memory call = _lastCall();
        assertEq(call.dataHash, keccak256(""), "an empty call");
        assertEq(call.transactionHash, named.transactionHash);
        assertTrue(bridge.messageCallStatus(named.messageId));
    }

    /// Claim: anyone may execute a message, and the executor gets no fee from the bridge. Shows: a stranger delivers it
    /// and the balance of the bridge stays zero. Matters: front-running an execution does no harm, because the message
    /// fixes its target, data and gas.
    function test_deliver_anyoneMayExecute() public {
        Scene memory scene = _messageScene(bridge);
        vm.deal(attacker, 1 ether);
        vm.prank(attacker);
        bridge.executeMessage(_messageProof(scene, MessageFixtures.deliver()));
        assertEq(recorder.callCount(), 1);
        assertEq(address(bridge).balance, 0);
        assertEq(attacker.balance, 1 ether);
    }

    /// Claim: a message older than 8192 slots is delivered through the historical path. Shows: the same fixture message
    /// proven from an anchor more than 8192 slots above its block, through `historical_summaries`. Matters: the bridge
    /// must deliver messages that the light client did not follow slot by slot.
    function test_deliver_historicalPathDelivers() public {
        (MessageFixtures.Named memory named, MessageBridge.MessageProof memory proof) = _historicalMessage();
        bridge.executeMessage(proof);
        assertTrue(bridge.messageCallStatus(named.messageId));
        assertEq(_lastCall().transactionHash, named.transactionHash);
    }

    // ================================================================ replay and finality

    /// Claim: a message executes once. Shows: the second execution of a delivered message reverts with the identifier,
    /// and the target is not called again. Matters: a replay would repeat a transfer.
    function test_replay_secondExecutionRefused() public {
        Scene memory scene = _messageScene(bridge);
        MessageFixtures.Named memory named = MessageFixtures.deliver();
        bridge.executeMessage(_messageProof(scene, named));
        vm.expectRevert(abi.encodeWithSelector(MessageBridge.AlreadyDelivered.selector, named.messageId));
        bridge.executeMessage(_messageProof(scene, named));
        assertEq(recorder.callCount(), 1);
    }

    /// Claim: delivery is final when the target reverts. Shows: the execution does not revert, the status is false, the
    /// failure data names the data hash, the target and the sender, `AffirmationCompleted` carries false, and the same
    /// message cannot execute again. Matters: a failed call must not become a second chance for the executor, and the
    /// failure data lets a downstream contract decide what to do.
    function test_final_revertingTargetIsDeliveredAsAFailure() public {
        Scene memory scene = _messageScene(bridge);
        MessageFixtures.Named memory named = MessageFixtures.reverting();
        _expectCompleted(named, address(reverter), false);
        bridge.executeMessage(_messageProof(scene, named));

        assertFalse(bridge.messageCallStatus(named.messageId), "the status records the failure");
        assertEq(bridge.failedMessageDataHash(named.messageId), keccak256("fail"), "the hash of the data of the call");
        assertEq(bridge.failedMessageReceiver(named.messageId), address(reverter), "the target");
        assertEq(bridge.failedMessageSender(named.messageId), MessageFixtures.SENDER, "the sender on the source chain");

        vm.expectRevert(abi.encodeWithSelector(MessageBridge.AlreadyDelivered.selector, named.messageId));
        bridge.executeMessage(_messageProof(scene, named));
    }

    /// Claim: a target that burns all of its own gas is a final failure, and the executor is not blamed. Shows: with
    /// enough gas for the message, the call fails, the failure data is recorded, and the message is final. Matters:
    /// the executor gave what the sender asked for, so the outcome is the sender's.
    function test_final_targetThatBurnsItsGasIsAFinalFailure() public {
        Scene memory scene = _messageScene(bridge);
        MessageFixtures.Named memory named = MessageFixtures.burning();
        _expectCompleted(named, address(burner), false);
        bridge.executeMessage(_messageProof(scene, named));

        assertFalse(bridge.messageCallStatus(named.messageId));
        assertEq(bridge.failedMessageDataHash(named.messageId), keccak256("burn"));
        assertEq(bridge.failedMessageReceiver(named.messageId), address(burner));
        assertEq(bridge.failedMessageSender(named.messageId), MessageFixtures.SENDER);
        vm.expectRevert(abi.encodeWithSelector(MessageBridge.AlreadyDelivered.selector, named.messageId));
        bridge.executeMessage(_messageProof(scene, named));
    }

    // ================================================================ the gas guard

    function _tryExecute(MessageBridge.MessageProof memory proof, uint256 gas) internal returns (bool ok, bytes memory data) {
        uint256 snapshot = vm.snapshotState();
        (ok, data) = address(bridge).call{gas: gas}(abi.encodeCall(MessageBridge.executeMessage, (proof)));
        vm.revertToState(snapshot);
    }

    /// @dev The least gas for the whole call at which `executeMessage` does not revert. Found by bisection.
    function _leastGas(MessageBridge.MessageProof memory proof) internal returns (uint256) {
        uint256 low = 100_000;
        uint256 high = 3_000_000;
        while (low < high) {
            uint256 middle = (low + high) / 2;
            (bool ok,) = _tryExecute(proof, middle);
            if (ok) high = middle;
            else low = middle + 1;
        }
        return low;
    }

    /// Claim: an executor that gives too little gas is refused, and nothing is burnt. Shows: with gas that covers the proof
    /// but not the gas of the message, `executeMessage` reverts with `InsufficientGas`; the message is still undelivered
    /// and executes with enough gas. Matters: without the guard the target would get less than the sender asked for,
    /// fail, and the failure would be final.
    function test_gasGuard_starvedExecutionIsRefusedAndTheMessageSurvives() public {
        Scene memory scene = _messageScene(bridge);
        MessageFixtures.Named memory named = MessageFixtures.deliver();
        MessageBridge.MessageProof memory proof = _messageProof(scene, named);

        (bool ok, bytes memory data) = _tryExecute(proof, 650_000);
        assertFalse(ok, "a starved execution reverts");
        assertEq(bytes4(data), MessageBridge.InsufficientGas.selector, "and the guard is what refuses it");

        assertEq(recorder.callCount(), 0, "the target was not called");
        assertFalse(bridge.messageCallStatus(named.messageId));
        assertEq(bridge.failedMessageReceiver(named.messageId), address(0), "no failure was recorded");
        bridge.executeMessage(proof);
        assertTrue(bridge.messageCallStatus(named.messageId), "the message executes with enough gas");
    }

    /// Claim: the guard asks for exactly what the call needs. Shows, for a success, a revert and a target that burns all
    /// its gas: at the least gas that does not revert, the target gets the whole gas of the message and the bookkeeping
    /// completes (the worst case is a failure, which writes the failure data); one unit of gas less, and the guard
    /// refuses with `InsufficientGas`, not an out-of-gas in the bookkeeping. Matters: a guard that asked for too
    /// little could leave the bookkeeping short after a target that burned its gas, and a guard that asked for too
    /// much would refuse honest executors.
    function test_gasGuard_leastGasGivesTheTargetAllItsGasAndFinishesTheBookkeeping() public {
        Scene memory scene = _messageScene(bridge);
        MessageFixtures.Named[3] memory messages =
            [MessageFixtures.deliver(), MessageFixtures.reverting(), MessageFixtures.burning()];
        uint256[3] memory gasOfMessage = [uint256(500_000), 300_000, 100_000];
        for (uint256 i = 0; i < messages.length; i++) {
            MessageBridge.MessageProof memory proof = _messageProof(scene, messages[i]);
            uint256 least = _leastGas(proof);
            (bool ok,) = _tryExecute(proof, least);
            assertTrue(ok, "the least gas succeeds");
            (bool starved, bytes memory data) = _tryExecute(proof, least - 1);
            assertFalse(starved, "one unit less reverts");
            assertEq(bytes4(data), MessageBridge.InsufficientGas.selector, "because of the guard");

            uint256 snapshot = vm.snapshotState();
            (bool done,) = address(bridge).call{gas: least}(abi.encodeCall(MessageBridge.executeMessage, (proof)));
            assertTrue(done);
            if (i == 0) assertGe(_lastCall().gasAtEntry, gasOfMessage[i] - 200, "the target got the whole gas");
            assertEq(bridge.failedMessageReceiver(messages[i].messageId) != address(0), i != 0, "the outcome is recorded");
            vm.revertToState(snapshot);
        }
    }

    // ================================================================ independence

    /// Claim: messages are independent: they execute in any order. Shows: the three order messages execute in the
    /// order C, A, B and then, from the same start, in the order B, C, A; each time all three succeed, and the
    /// target saw them in the order of execution. Matters: no sender sequence exists, so a stuck message never blocks
    /// another.
    function test_independence_messagesExecuteInAnyOrder() public {
        Scene memory scene = _messageScene(bridge);
        MessageFixtures.Named memory a = MessageFixtures.order_a();
        MessageFixtures.Named memory b = MessageFixtures.order_b();
        MessageFixtures.Named memory c = MessageFixtures.order_c();
        uint256 snapshot = vm.snapshotState();

        bridge.executeMessage(_messageProof(scene, c));
        bridge.executeMessage(_messageProof(scene, a));
        bridge.executeMessage(_messageProof(scene, b));
        assertEq(recorder.callAt(0).messageId, c.messageId);
        assertEq(recorder.callAt(1).messageId, a.messageId);
        assertEq(recorder.callAt(2).messageId, b.messageId);
        assertTrue(bridge.messageCallStatus(a.messageId) && bridge.messageCallStatus(b.messageId) && bridge.messageCallStatus(c.messageId));

        vm.revertToState(snapshot);
        assertEq(recorder.callCount(), 0, "the snapshot restored the start");
        bridge.executeMessage(_messageProof(scene, b));
        bridge.executeMessage(_messageProof(scene, c));
        bridge.executeMessage(_messageProof(scene, a));
        assertEq(recorder.callAt(0).messageId, b.messageId);
        assertEq(recorder.callAt(1).messageId, c.messageId);
        assertEq(recorder.callAt(2).messageId, a.messageId);
    }

    /// Claim: a failed message does not stop the messages after it. Shows: after a reverting message, another one
    /// executes. Matters: the same independence, for a failure.
    function test_independence_aFailedMessageBlocksNothing() public {
        Scene memory scene = _messageScene(bridge);
        bridge.executeMessage(_messageProof(scene, MessageFixtures.reverting()));
        bridge.executeMessage(_messageProof(scene, MessageFixtures.order_a()));
        assertTrue(bridge.messageCallStatus(MessageFixtures.order_a().messageId));
    }

    /// Claim: two messages of one transaction both deliver, with the same transaction hash and different identifiers,
    /// each addressed by its log index. Shows: log 1 and log 2 of the same receipt deliver in turn. Matters: a
    /// transaction may send several messages, and the log index must pick the right one.
    function test_independence_twoMessagesOfOneTransaction() public {
        Scene memory scene = _messageScene(bridge);
        MessageFixtures.Named memory first = MessageFixtures.two_a();
        MessageFixtures.Named memory second = MessageFixtures.two_b();
        bridge.executeMessage(_messageProof(scene, second));
        bridge.executeMessage(_messageProof(scene, first));
        assertEq(recorder.callAt(0).messageId, second.messageId);
        assertEq(recorder.callAt(1).messageId, first.messageId);
        assertEq(recorder.callAt(0).transactionHash, recorder.callAt(1).transactionHash, "one transaction");
        assertEq(first.transactionHash, second.transactionHash);
        assertTrue(first.messageId != second.messageId);
    }

    // ================================================================ calls during a delivery

    /// Claim: while a message executes, another `executeMessage` is refused, for the same message and for another one.
    /// Shows: the target tries both through the bridge; each call fails with `MessageInProgress` and the identifier of
    /// the message that executes; the outer delivery succeeds. Matters: a nested execution would overwrite the context
    /// and clear it while the outer target still runs.
    function test_context_nestedExecutionIsRefused() public {
        Scene memory scene = _messageScene(bridge);
        MessageFixtures.Named memory outer = MessageFixtures.reentrant();
        bytes memory expected = abi.encodeWithSelector(MessageBridge.MessageInProgress.selector, outer.messageId);

        reentrant.arm(abi.encodeCall(MessageBridge.executeMessage, (_messageProof(scene, MessageFixtures.order_a()))));
        bridge.executeMessage(_messageProof(scene, outer));
        assertFalse(reentrant.lastOk(), "the nested call failed");
        assertEq(reentrant.lastReturn(), expected, "with MessageInProgress");
        assertTrue(bridge.messageCallStatus(outer.messageId), "the outer message was delivered");
        assertFalse(bridge.messageCallStatus(MessageFixtures.order_a().messageId), "the nested one was not");
        _assertContextClear();
    }

    /// Claim: a target may send a message while it executes, and the send does not disturb the context. Shows: the
    /// message sent from the target has the first identifier of the destination bridge, and `messageId()` is still the
    /// identifier of the executing message after the send. Matters: replies from a target (for example a token
    /// mediator that answers) must work.
    function test_context_aTargetMaySendDuringItsDelivery() public {
        Scene memory scene = _messageScene(bridge);
        MessageFixtures.Named memory named = MessageFixtures.sending();
        vm.recordLogs();
        bridge.executeMessage(_messageProof(scene, named));
        Vm.Log[] memory logs = vm.getRecordedLogs();

        assertTrue(bridge.messageCallStatus(named.messageId), "the delivery succeeded");
        assertEq(sending.contextIdAfterSend(), named.messageId, "the context survived the send");
        bytes32 sent = sending.sentId();
        assertEq(sent, AmbMessageCodec.messageIdPrefix(CHAIN_B, address(bridge)), "the first identifier of this bridge");
        uint256 requests;
        for (uint256 i = 0; i < logs.length; i++) {
            if (logs[i].emitter == address(bridge) && logs[i].topics[0] == bridge.USER_REQUEST_TOPIC()) {
                requests++;
                assertEq(logs[i].topics[1], sent);
            }
        }
        assertEq(requests, 1, "one request was logged");
    }
}
