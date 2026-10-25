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
import {ReceiptBuilder} from "./utils/ReceiptBuilder.sol";
import {TrieBuilder} from "./utils/TrieBuilder.sol";

/// @notice The shapes that a receipt and its block can take. Each test sends a message through the real source bridge,
/// puts the logs of the send into a receipt of the chosen shape, builds real tries around it, and delivers the message
/// through the destination bridge. Where a send cannot make the shape (a legacy receipt, a type that does not exist, 64
/// logs), the test builds the log list by hand around the log of a real send.
contract MessageBridgeShapesTest is MessageScenes, DynamicProofs {
    /// @dev The emitter of the filler logs. It is not the remote bridge.
    address internal constant NOISE_EMITTER = 0x00000000000000000000000000000000f1117e40;

    /// @dev Both bases build on `WithdrawalScenes.setUp`, and `MessageScenes` extends it, so the combination must say so.
    function setUp() public override(MessageScenes, WithdrawalScenes) {
        super.setUp();
    }

    // ================================================================ helpers

    function _sendOnSource(bytes memory data) internal returns (Vm.Log[] memory recorded, bytes32 id) {
        vm.chainId(CHAIN_A);
        vm.recordLogs();
        vm.prank(MessageFixtures.SENDER);
        id = sourceBridge.requireToPassMessage(MessageFixtures.TARGET_RECORDER, data, 300_000);
        recorded = vm.getRecordedLogs();
    }

    function _messageLogIndex(Vm.Log[] memory recorded) internal view returns (uint256) {
        return _logIndexOf(recorded, address(sourceBridge), sourceBridge.USER_REQUEST_TOPIC());
    }

    function _lastCall() internal view returns (MessageRecorder.Call memory) {
        return recorder.callAt(recorder.callCount() - 1);
    }

    function _prove(SourceTransaction memory source, uint256 logIndex)
        internal
        returns (MessageBridge.MessageProof memory proof)
    {
        (proof,) = _proveMessage(bridge, lightClientForB, GENESIS_ROOT_A, source, logIndex);
    }

    /// @dev Delivers a proof on the destination chain and checks what the target saw: the identifier, the sender and
    /// the hash of the transaction that held the log.
    function _deliverAndCheck(MessageBridge.MessageProof memory proof, SourceTransaction memory source, bytes32 id)
        internal
    {
        vm.chainId(CHAIN_B);
        bridge.executeMessage(proof);
        assertTrue(bridge.messageCallStatus(id), "the message was delivered");
        MessageRecorder.Call memory call = _lastCall();
        assertEq(call.messageId, id, "the identifier of the send");
        assertEq(call.messageSender, MessageFixtures.SENDER, "the sender of the send");
        assertEq(call.transactionHash, _transactionHashOf(source), "the hash of the transaction at the proven index");
    }

    function _expectRefusal(MessageBridge.MessageProof memory proof, bytes memory revertData) internal {
        vm.chainId(CHAIN_B);
        vm.expectRevert(revertData);
        bridge.executeMessage(proof);
    }

    /// @dev A source transaction of the shape that the test wants, built around the log of a real send.
    function _sourceOf(Vm.Log[] memory recorded, uint8 receiptType, uint256 index)
        internal
        returns (SourceTransaction memory source)
    {
        source = _sourceTransactionOf(recorded);
        source.receiptType = receiptType;
        source.transactionType = receiptType;
        source.index = index;
        source.blockSize = index + 1 < 8 ? 8 : index + 1;
    }

    function _noiseLog(uint256 seed) internal pure returns (ReceiptBuilder.LogEntry memory entry) {
        bytes32[] memory topics = new bytes32[](2);
        topics[0] = keccak256("Noise(uint256)");
        topics[1] = bytes32(seed);
        entry = ReceiptBuilder.LogEntry({emitter: NOISE_EMITTER, topics: topics, data: abi.encode(seed)});
    }

    /// @dev `count` logs where the one at `position` is the log of the real send and the others are filler.
    function _logsWithMessageAt(Vm.Log[] memory recorded, uint256 count, uint256 position)
        internal
        view
        returns (ReceiptBuilder.LogEntry[] memory logs)
    {
        ReceiptBuilder.LogEntry memory message = ReceiptBuilder.fromRecorded(recorded[_messageLogIndex(recorded)]);
        logs = new ReceiptBuilder.LogEntry[](count);
        for (uint256 i = 0; i < count; i++) {
            logs[i] = i == position ? message : _noiseLog(i);
        }
    }

    /// @dev Like `_proveMessage`, but the caller gives the bytes of the receipt. A test that needs a receipt that
    /// `ReceiptBuilder.receipt` cannot encode (a type byte of zero in front) uses this.
    function _proveReceiptBytes(SourceTransaction memory source, bytes memory receiptBytes, uint256 logIndex)
        internal
        returns (MessageBridge.MessageProof memory proof)
    {
        bytes memory transaction = ReceiptBuilder.transaction(source.transactionType, source.transactionPayload);
        ReceiptBuilder.Block memory assembled =
            ReceiptBuilder.assemble(source.blockSize, source.index, receiptBytes, transaction);
        SceneParams memory params = _defaultParams();
        Scene memory scene = _buildScene(
            MessageFixtures.deliver(),
            params,
            _executionHeaderRlp(assembled.receiptsRoot, assembled.transactionsRoot, 17)
        );
        _storeScene(lightClientForB, GENESIS_ROOT_A, params, scene);
        _addLayouts(bridge, lightClientForB, params, scene);
        proof = _clone(scene.proof);
        proof.receiptProof = ReceiptBuilder.receiptProofOf(assembled, source.index);
        proof.receiptIndex = source.index;
        proof.transactionProof = ReceiptBuilder.transactionProofOf(assembled, source.index);
        proof.transactionIndex = source.index;
        proof.logIndex = logIndex;
    }

    /// @dev The block of a source transaction, built again so that a test can take the proof of another position.
    function _blockOf(SourceTransaction memory source) internal pure returns (ReceiptBuilder.Block memory) {
        return ReceiptBuilder.assemble(
            source.blockSize,
            source.index,
            ReceiptBuilder.receipt(source.receiptType, source.status, source.logs),
            ReceiptBuilder.transaction(source.transactionType, source.transactionPayload)
        );
    }

    // ================================================================ receipt types

    /// Claim: a message in a receipt of type 0 (legacy, no type byte), 1, 2, 3 and 4 is delivered, and the target sees the
    /// hash of the transaction of the same type. Shows: five sends, five proofs, five deliveries, with the first byte of
    /// each receipt as the type (a legacy receipt starts with a list prefix). Matters: real blocks hold all five types,
    /// and a decoder that knows only some of them strands every message that sits in the others.
    function test_receiptType_zeroToFourAreDelivered() public {
        for (uint8 receiptType = 0; receiptType <= 4; receiptType++) {
            (Vm.Log[] memory recorded, bytes32 id) = _sendOnSource(abi.encodePacked("receipt type ", receiptType));
            SourceTransaction memory source = _sourceOf(recorded, receiptType, 3);
            bytes memory encoded = ReceiptBuilder.receipt(receiptType, source.status, source.logs);
            if (receiptType == 0) assertGe(uint8(encoded[0]), 0xc0, "a legacy receipt starts with a list prefix");
            if (receiptType != 0) assertEq(uint8(encoded[0]), receiptType, "a typed receipt starts with its type");

            _deliverAndCheck(_prove(source, _messageLogIndex(recorded)), source, id);
        }
        assertEq(recorder.callCount(), 5, "one call for each type");
    }

    /// Claim: a receipt with a type byte that the bridge does not support is refused with `MalformedReceipt`, for 5 and
    /// for 7, and so is a bare list with an explicit zero type byte in front. Shows: the exact error for each, and no
    /// delivery. Matters: the decoder reads only layouts that it knows. The first byte of a receipt is a type or a list
    /// prefix, and a byte of zero is neither.
    function test_receiptType_unsupportedTypesAreRefused() public {
        uint8[2] memory unsupported = [5, 7];
        for (uint256 i = 0; i < unsupported.length; i++) {
            (Vm.Log[] memory recorded, bytes32 id) = _sendOnSource(abi.encodePacked("unsupported ", unsupported[i]));
            SourceTransaction memory source = _sourceOf(recorded, unsupported[i], 3);
            assertEq(uint8(ReceiptBuilder.receipt(unsupported[i], source.status, source.logs)[0]), unsupported[i]);
            _expectRefusal(_prove(source, _messageLogIndex(recorded)), abi.encodeWithSelector(BeaconProofVerifier.MalformedReceipt.selector));
            assertFalse(bridge.messageCallStatus(id), "nothing was delivered");
        }

        (Vm.Log[] memory zeroRecorded, bytes32 zeroId) = _sendOnSource("explicit zero type");
        SourceTransaction memory zeroSource = _sourceOf(zeroRecorded, 0, 3);
        bytes memory prefixed = bytes.concat(bytes1(0x00), ReceiptBuilder.receipt(0, zeroSource.status, zeroSource.logs));
        _expectRefusal(
            _proveReceiptBytes(zeroSource, prefixed, _messageLogIndex(zeroRecorded)),
            abi.encodeWithSelector(BeaconProofVerifier.MalformedReceipt.selector)
        );

        SourceTransaction memory supported = _sourceOf(zeroRecorded, 2, 3);
        _deliverAndCheck(_prove(supported, _messageLogIndex(zeroRecorded)), supported, zeroId);
    }

    // ================================================================ transaction index

    /// @dev Sends, builds a block that ends at `index` and delivers. The key of the index is checked first.
    function _deliverAtIndex(uint256 index, uint256 expectedKeyLength) internal {
        assertEq(TrieBuilder.indexKey(index).length, expectedKeyLength, "the length of the key");
        (Vm.Log[] memory recorded, bytes32 id) = _sendOnSource(abi.encodePacked("index ", index));
        SourceTransaction memory source = _sourceOf(recorded, 2, index);
        assertEq(source.blockSize, index + 1, "the block ends at the message");
        _deliverAndCheck(_prove(source, _messageLogIndex(recorded)), source, id);
    }

    // Claim of the five tests below: a message at a high transaction index is delivered, where the trie key grows from
    // one byte to two and to three. Shows: the key of 127, 128, 255, 256 and 1000 has 1, 2, 2, 3 and 3 bytes, and the
    // message at that index is delivered from a block that ends at it. Matters: a wrong key encoding fails every message
    // in a busy block, and a low index never shows it. Each index has its own test because the block of 1001
    // transactions needs a lot of memory.

    /// Claim: index 127, the last one byte key, delivers. Shows and matters: see above.
    function test_transactionIndex_127_oneByteKey() public {
        _deliverAtIndex(127, 1);
    }

    /// Claim: index 128, the first two byte key, delivers. Shows and matters: see above.
    function test_transactionIndex_128_firstTwoByteKey() public {
        _deliverAtIndex(128, 2);
    }

    /// Claim: index 255, the last two byte key, delivers. Shows and matters: see above.
    function test_transactionIndex_255_lastTwoByteKey() public {
        _deliverAtIndex(255, 2);
    }

    /// Claim: index 256, the first three byte key, delivers. Shows and matters: see above.
    function test_transactionIndex_256_firstThreeByteKey() public {
        _deliverAtIndex(256, 3);
    }

    /// Claim: index 1000 delivers. Shows and matters: see above.
    function test_transactionIndex_1000_threeByteKey() public {
        _deliverAtIndex(1000, 3);
    }

    /// Claim: the index of the proof is the trie key, so a proof for one index does not pass under the key of another,
    /// not even across a change in the key length. Shows: the proof of index 128 under the indices 127, 129 and 255 is
    /// refused by the trie check, and under 128 it delivers. Matters: the key is the only link between the index that
    /// the executor names and the position that the proof shows.
    function test_transactionIndex_proofOfOneIndexFailsUnderAnother() public {
        (Vm.Log[] memory recorded, bytes32 id) = _sendOnSource("key");
        SourceTransaction memory source = _sourceOf(recorded, 2, 128);
        source.blockSize = 300;
        MessageBridge.MessageProof memory honest = _prove(source, _messageLogIndex(recorded));

        uint256[3] memory wrongKeys = [uint256(127), 129, 255];
        for (uint256 i = 0; i < wrongKeys.length; i++) {
            MessageBridge.MessageProof memory wrong = _clone(honest);
            wrong.receiptIndex = wrongKeys[i];
            wrong.transactionIndex = wrongKeys[i];
            _expectRefusal(wrong, "MerkleTrie: invalid large internal hash");
        }
        _deliverAndCheck(honest, source, id);
    }

    // ================================================================ many logs

    /// Claim: a message at log 0, 31, 32, 33, 40 and 63 of a receipt with 64 logs is delivered. Shows: each position
    /// delivers its own message, with the identifier of its own send. Matters: the vendored list reader copies at most
    /// 32 items and panics on the 33rd. Any sender can put more than 32 logs in one transaction, so a bridge that
    /// reads only 32 would strand that message for ever.
    function test_manyLogs_messageAtAnyPositionIsDelivered() public {
        uint256[6] memory positions = [uint256(0), 31, 32, 33, 40, 63];
        for (uint256 i = 0; i < positions.length; i++) {
            (Vm.Log[] memory recorded, bytes32 id) = _sendOnSource(abi.encodePacked("log ", positions[i]));
            SourceTransaction memory source = _sourceOf(recorded, 2, 3);
            source.logs = _logsWithMessageAt(recorded, 64, positions[i]);
            _deliverAndCheck(_prove(source, positions[i]), source, id);
        }
    }

    /// Claim: a log index past the end of a long list reverts with the number of logs, and the last log is reachable.
    /// Shows: index 64 and index 1000 in a list of 64 revert with `LogIndexOutOfRange` and the count 64. Index 63, a log
    /// of another emitter, reverts with `WrongEmitter`, which shows that the walk reached the last item. Matters: the
    /// walker must count every item and not stop at 32.
    function test_manyLogs_indexPastTheEndOfALongListIsRefused() public {
        (Vm.Log[] memory recorded, bytes32 id) = _sendOnSource("long list");
        SourceTransaction memory source = _sourceOf(recorded, 2, 3);
        source.logs = _logsWithMessageAt(recorded, 64, 40);
        MessageBridge.MessageProof memory honest = _prove(source, 40);

        MessageBridge.MessageProof memory past = _clone(honest);
        past.logIndex = 64;
        _expectRefusal(past, abi.encodeWithSelector(BeaconProofVerifier.LogIndexOutOfRange.selector, 64, 64));
        past.logIndex = 1000;
        _expectRefusal(past, abi.encodeWithSelector(BeaconProofVerifier.LogIndexOutOfRange.selector, 1000, 64));

        MessageBridge.MessageProof memory last = _clone(honest);
        last.logIndex = 63;
        _expectRefusal(last, abi.encodeWithSelector(BeaconProofVerifier.WrongEmitter.selector, MessageFixtures.REMOTE_BRIDGE, NOISE_EMITTER));

        _deliverAndCheck(honest, source, id);
    }

    // ================================================================ two messages in one receipt

    /// Claim: two messages that one transaction sent are both delivered, each by its own log index, in either order.
    /// Shows: two real sends in one recorded call, one receipt with two logs, and two proofs of the same block; the
    /// second message delivers first, then the first, and the target sees one transaction hash for both. Matters: the
    /// log index must pick the message, and delivering one must not use up the other.
    function test_twoMessages_inOneReceiptAreBothDelivered() public {
        vm.chainId(CHAIN_A);
        vm.recordLogs();
        vm.startPrank(MessageFixtures.SENDER);
        bytes32 firstId = sourceBridge.requireToPassMessage(MessageFixtures.TARGET_RECORDER, "first", 300_000);
        bytes32 secondId = sourceBridge.requireToPassMessage(MessageFixtures.TARGET_RECORDER, "second", 300_000);
        vm.stopPrank();
        Vm.Log[] memory recorded = vm.getRecordedLogs();
        assertEq(recorded.length, 2, "two sends, two logs");
        SourceTransaction memory source = _sourceTransactionOf(recorded);

        MessageBridge.MessageProof memory firstProof = _prove(source, 0);
        MessageBridge.MessageProof memory secondProof = _prove(source, 1);
        _deliverAndCheck(secondProof, source, secondId);
        assertFalse(bridge.messageCallStatus(firstId), "the other message stays open");
        _deliverAndCheck(firstProof, source, firstId);
        assertEq(recorder.callAt(0).transactionHash, recorder.callAt(1).transactionHash, "one transaction");
        assertTrue(firstId != secondId);
    }

    /// Claim: two messages of one receipt are delivered when other logs sit between them, and a proof that names a
    /// filler log between them is refused. Shows: logs 1 and 3 of four deliver; log 2 reverts with `WrongEmitter`.
    /// Matters: the position of a message in the receipt is its address, with other contracts' logs around it.
    function test_twoMessages_amongOtherLogsAreBothDelivered() public {
        (Vm.Log[] memory firstRecorded, bytes32 firstId) = _sendOnSource("first among noise");
        (Vm.Log[] memory secondRecorded, bytes32 secondId) = _sendOnSource("second among noise");
        SourceTransaction memory source = _sourceOf(firstRecorded, 2, 3);
        source.logs = new ReceiptBuilder.LogEntry[](4);
        source.logs[0] = _noiseLog(0);
        source.logs[1] = ReceiptBuilder.fromRecorded(firstRecorded[_messageLogIndex(firstRecorded)]);
        source.logs[2] = _noiseLog(2);
        source.logs[3] = ReceiptBuilder.fromRecorded(secondRecorded[_messageLogIndex(secondRecorded)]);

        MessageBridge.MessageProof memory firstProof = _prove(source, 1);
        MessageBridge.MessageProof memory secondProof = _prove(source, 3);
        MessageBridge.MessageProof memory between = _clone(firstProof);
        between.logIndex = 2;
        _expectRefusal(between, abi.encodeWithSelector(BeaconProofVerifier.WrongEmitter.selector, MessageFixtures.REMOTE_BRIDGE, NOISE_EMITTER));
        _deliverAndCheck(firstProof, source, firstId);
        _deliverAndCheck(secondProof, source, secondId);
    }

    // ================================================================ failed receipt

    /// Claim: a receipt that records a failed transaction is refused, although it holds the log of a real send. Shows:
    /// the exact error, no delivery, and the same send with a receipt of status success delivers. Matters: a reverted
    /// transaction sent nothing, and the log of such a receipt does not exist on a real chain.
    function test_failedReceipt_isRefusedAndTheSameLogDeliversWithSuccess() public {
        (Vm.Log[] memory recorded, bytes32 id) = _sendOnSource("failed");
        SourceTransaction memory source = _sourceOf(recorded, 2, 3);
        source.status = ReceiptBuilder.ReceiptStatus.Failure;
        _expectRefusal(_prove(source, _messageLogIndex(recorded)), abi.encodeWithSelector(BeaconProofVerifier.ReceiptFailed.selector));
        assertFalse(bridge.messageCallStatus(id), "a failed receipt delivers nothing");

        source.status = ReceiptBuilder.ReceiptStatus.Success;
        _deliverAndCheck(_prove(source, _messageLogIndex(recorded)), source, id);
    }

    // ================================================================ the two branches

    /// Claim: the transaction branch matters on its own. Shows: with the receipt branch of the message, a transaction
    /// branch of another position, a transaction branch of another block, and a transaction branch cut short each
    /// revert with the error of the trie check. Matters: the transaction hash that the target sees comes only from this
    /// branch, so an executor that could swap it could name any hash.
    function test_branches_transactionBranchOfAnotherIndexIsRefused() public {
        (Vm.Log[] memory recorded, bytes32 id) = _sendOnSource("transaction branch");
        SourceTransaction memory source = _sourceOf(recorded, 2, 3);
        MessageBridge.MessageProof memory honest = _prove(source, _messageLogIndex(recorded));
        ReceiptBuilder.Block memory block_ = _blockOf(source);

        MessageBridge.MessageProof memory otherIndex = _clone(honest);
        otherIndex.transactionProof = ReceiptBuilder.transactionProofOf(block_, 4);
        _expectRefusal(otherIndex, "MerkleTrie: invalid large internal hash");

        SourceTransaction memory elsewhere = _clone(source);
        elsewhere.transactionPayload = abi.encode("a transaction of another block");
        MessageBridge.MessageProof memory otherBlock = _clone(honest);
        otherBlock.transactionProof = ReceiptBuilder.transactionProofOf(_blockOf(elsewhere), source.index);
        _expectRefusal(otherBlock, "MerkleTrie: invalid root hash");

        MessageBridge.MessageProof memory cut = _clone(honest);
        cut.transactionProof = new bytes[](cut.transactionProof.length - 1);
        for (uint256 i = 0; i < cut.transactionProof.length; i++) {
            cut.transactionProof[i] = honest.transactionProof[i];
        }
        _expectRefusal(cut, "MerkleTrie: ran out of proof elements");

        _deliverAndCheck(honest, source, id);
    }

    /// Claim: the receipt branch matters on its own. Shows: with the transaction branch of the message, a receipt branch
    /// of another position is refused by the trie check; and when both indices move to the other position with its two
    /// honest branches, the receipt is a filler receipt without logs and the proof reverts with `LogIndexOutOfRange`.
    /// Matters: the log is bound to the position that the transaction proves, not to a position that the executor picks.
    function test_branches_receiptBranchOfAnotherIndexIsRefused() public {
        (Vm.Log[] memory recorded, bytes32 id) = _sendOnSource("receipt branch");
        SourceTransaction memory source = _sourceOf(recorded, 2, 3);
        MessageBridge.MessageProof memory honest = _prove(source, _messageLogIndex(recorded));
        ReceiptBuilder.Block memory block_ = _blockOf(source);

        MessageBridge.MessageProof memory otherReceipt = _clone(honest);
        otherReceipt.receiptProof = ReceiptBuilder.receiptProofOf(block_, 4);
        _expectRefusal(otherReceipt, "MerkleTrie: invalid large internal hash");

        MessageBridge.MessageProof memory moved = _clone(honest);
        moved.receiptIndex = 4;
        moved.transactionIndex = 4;
        moved.receiptProof = ReceiptBuilder.receiptProofOf(block_, 4);
        moved.transactionProof = ReceiptBuilder.transactionProofOf(block_, 4);
        _expectRefusal(moved, abi.encodeWithSelector(BeaconProofVerifier.LogIndexOutOfRange.selector, moved.logIndex, 0));

        _deliverAndCheck(honest, source, id);
    }

    // ================================================================ helpers for memory copies

    function _clone(SourceTransaction memory source) internal pure returns (SourceTransaction memory copy) {
        copy.receiptType = source.receiptType;
        copy.status = source.status;
        copy.logs = source.logs;
        copy.transactionType = source.transactionType;
        copy.transactionPayload = source.transactionPayload;
        copy.blockSize = source.blockSize;
        copy.index = source.index;
    }
}
