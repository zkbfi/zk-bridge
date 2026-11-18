// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Vm} from "forge-std/Vm.sol";
import {BeaconProofVerifier} from "../../src/hardened/BeaconProofVerifier.sol";
import {MessageBridge} from "../../src/hardened/MessageBridge.sol";
import {AmbMessageCodec} from "../../src/hardened/AmbMessageCodec.sol";
import {MessageScenes} from "./utils/MessageScenes.sol";
import {MessageFixtures} from "./utils/MessageFixtures.sol";
import {MessageNoop, MessageRecorder} from "./utils/MessageTargets.sol";

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
    /// hash. Shows: each value equals the independent fixture
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
    }

    /// Claim: the context is cleared after a delivery, and after a delivery that reverted. Shows: all four views are
    /// zero after a success, after a target that reverts and after a target that burns its gas (both deliveries
    /// revert). Matters: a stale context would let a later caller pass as the sender of an old message.
    function test_deliver_contextIsClearedAfterTheCall() public {
        Scene memory scene = _messageScene(bridge);
        bridge.executeMessage(_messageProof(scene, MessageFixtures.deliver()));
        _assertContextClear();
        (bool reverted,) = address(bridge).call(
            abi.encodeCall(MessageBridge.executeMessage, (_messageProof(scene, MessageFixtures.reverting())))
        );
        assertFalse(reverted);
        _assertContextClear();
        (bool burned,) = address(bridge).call{gas: 2_000_000}(
            abi.encodeCall(MessageBridge.executeMessage, (_messageProof(scene, MessageFixtures.burning())))
        );
        assertFalse(burned);
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

    /// Claim: a target that reverts makes the delivery revert with the error of the target, and the message stays
    /// undelivered. Shows: `executeMessage` reverts with `Error("target failed")`; the status is `NotDelivered`; no
    /// failure data exists; after the target changes its mind (its code is replaced), the same proof delivers.
    /// Matters: the owner's rule, "if anyone can call them and they run out of gas, does it not just revert up the
    /// chain?": a failed call is never final, so nobody can burn a message by making its call fail.
    function test_revertUp_revertingTargetRevertsTheDeliveryAndTheMessageWaits() public {
        Scene memory scene = _messageScene(bridge);
        MessageFixtures.Named memory named = MessageFixtures.reverting();
        MessageBridge.MessageProof memory proof = _messageProof(scene, named);

        vm.expectRevert(bytes("target failed"));
        bridge.executeMessage(proof);
        assertEq(uint8(bridge.deliveryStatus(named.messageId)), uint8(MessageBridge.DeliveryStatus.NotDelivered));
        assertFalse(bridge.messageCallStatus(named.messageId), "not delivered");
        assertEq(bridge.failedMessageDataHash(named.messageId), bytes32(0), "no failure data");
        assertEq(bridge.failedMessageReceiver(named.messageId), address(0), "no failed receiver");
        assertEq(bridge.failedMessageSender(named.messageId), address(0), "no failed sender");
        _assertContextClear();

        vm.etch(address(reverter), address(new MessageNoop()).code);
        _expectCompleted(named, address(reverter), true);
        bridge.executeMessage(proof);
        assertEq(uint8(bridge.deliveryStatus(named.messageId)), uint8(MessageBridge.DeliveryStatus.Succeeded));
        vm.expectRevert(abi.encodeWithSelector(MessageBridge.AlreadyDelivered.selector, named.messageId));
        bridge.executeMessage(proof);
    }

    /// Claim: a target that fails with no error data (it burns all its gas) makes the delivery revert with
    /// `TargetCallFailed`, and the message stays undelivered. Shows: the error names the message; the status is
    /// `NotDelivered`. Matters: the executor sees why the delivery failed even when the target says nothing.
    function test_revertUp_targetThatBurnsItsGasRevertsWithTargetCallFailed() public {
        Scene memory scene = _messageScene(bridge);
        MessageFixtures.Named memory named = MessageFixtures.burning();
        vm.expectRevert(abi.encodeWithSelector(MessageBridge.TargetCallFailed.selector, named.messageId));
        bridge.executeMessage{gas: 2_000_000}(_messageProof(scene, named));
        assertEq(uint8(bridge.deliveryStatus(named.messageId)), uint8(MessageBridge.DeliveryStatus.NotDelivered));
    }

    /// Claim: a message whose target has no code completes as an empty call and is final. Shows: with the code of the
    /// recorder removed, the delivery emits `AffirmationCompleted(..., true)` and the status is `Succeeded`; after code
    /// is put back at that address the same proof is refused with `AlreadyDelivered`. Matters: this is the behaviour of
    /// the bridge that this one mimics, kept by the owner's decision (code review, 2026-11-18, third round): "the
    /// mistake is on the sender, not on us".
    function test_revertUp_aTargetWithNoCodeCompletesAsAnEmptyCall() public {
        Scene memory scene = _messageScene(bridge);
        MessageFixtures.Named memory named = MessageFixtures.deliver();
        MessageBridge.MessageProof memory proof = _messageProof(scene, named);
        bytes memory code = address(recorder).code;
        vm.etch(address(recorder), "");

        _expectCompleted(named, address(recorder), true);
        bridge.executeMessage(proof);
        assertEq(uint8(bridge.deliveryStatus(named.messageId)), uint8(MessageBridge.DeliveryStatus.Succeeded));

        vm.etch(address(recorder), code);
        vm.expectRevert(abi.encodeWithSelector(MessageBridge.AlreadyDelivered.selector, named.messageId));
        bridge.executeMessage(proof);
    }

    // ================================================================ gas

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

    /// Claim: an executor that gives too little gas only loses its own transaction. Shows: at the least gas that
    /// delivers, one unit less reverts and leaves the message `NotDelivered`, with the target not called; the least
    /// gas then delivers. Matters: there is no gas guard and no gas number in the bridge any more, so starvation must
    /// revert, never record.
    function test_gas_starvedExecutionRevertsAndTheMessageSurvives() public {
        Scene memory scene = _messageScene(bridge);
        MessageFixtures.Named memory named = MessageFixtures.deliver();
        MessageBridge.MessageProof memory proof = _messageProof(scene, named);

        uint256 least = _leastGas(proof);
        (bool starved,) = address(bridge).call{gas: least - 1}(abi.encodeCall(MessageBridge.executeMessage, (proof)));
        assertFalse(starved, "one unit less reverts");
        assertEq(recorder.callCount(), 0, "the target was not called");
        assertEq(uint8(bridge.deliveryStatus(named.messageId)), uint8(MessageBridge.DeliveryStatus.NotDelivered));

        (bool done,) = address(bridge).call{gas: least}(abi.encodeCall(MessageBridge.executeMessage, (proof)));
        assertTrue(done, "the least gas delivers");
        assertTrue(bridge.messageCallStatus(named.messageId));
    }

    /// Claim: the target gets all the gas that is left, whatever the gas field of the message says. Shows: the fixture
    /// carries 500,000 in its gas field; with 3,000,000 supplied, the target sees more than 2,000,000 at its entry.
    /// Matters: the gas field is kept for the OmniBridge layout only; no number in the message caps the call.
    function test_gas_theTargetGetsAllTheGasNotTheGasField() public {
        Scene memory scene = _messageScene(bridge);
        bridge.executeMessage{gas: 3_000_000}(_messageProof(scene, MessageFixtures.deliver()));
        assertGt(_lastCall().gasAtEntry, 2_000_000, "the target got more than the gas field");
    }

    /// Claim: `deliveryStatus` reads `NotDelivered` before a delivery and `Succeeded` after it. Shows: both values for
    /// one message. Matters: it is the one place that tells a waiting message from a delivered one.
    function test_status_movesFromNotDeliveredToSucceeded() public {
        Scene memory scene = _messageScene(bridge);
        MessageFixtures.Named memory named = MessageFixtures.deliver();
        assertEq(uint8(bridge.deliveryStatus(named.messageId)), uint8(MessageBridge.DeliveryStatus.NotDelivered));
        bridge.executeMessage(_messageProof(scene, named));
        assertEq(uint8(bridge.deliveryStatus(named.messageId)), uint8(MessageBridge.DeliveryStatus.Succeeded));
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

    /// Claim: a message whose delivery fails does not stop the messages after it. Shows: after a reverting delivery,
    /// another message executes. Matters: the same independence, for a failure.
    function test_independence_aFailedMessageBlocksNothing() public {
        Scene memory scene = _messageScene(bridge);
        vm.expectRevert(bytes("target failed"));
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
