// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {BeaconLightClient} from "../../src/hardened/BeaconLightClient.sol";
import {AmbMessageCodec} from "../../src/hardened/AmbMessageCodec.sol";
import {MessageBridge} from "../../src/hardened/MessageBridge.sol";
import {MessageScenes} from "./utils/MessageScenes.sol";
import {MessageFixtures} from "./utils/MessageFixtures.sol";

/// @notice Fuzz tests: message identifiers, flipped proof bits, proof indices, public-value decoding, jump sequences,
/// callers. The fuzz tests of the token mediator are in `mediator/TokenMediatorFuzz.t.sol`.
contract HardenedFuzzTest is MessageScenes {
    bytes32 internal constant ANCHOR = keccak256("fuzz anchor");

    // ================================================================ light client

    /// @dev Builds an honest output for `slot`. When the next committee slot is empty, the output proves a
    /// deterministic one, as the program does. The committee of the new period is always the stored one.
    function _stepOutput(BeaconLightClient client, uint64 slot, bytes32 blockHash)
        internal
        view
        returns (BeaconLightClient.LightClientOutput memory output)
    {
        output = _outputAt(client, GENESIS_ROOT_A, slot, blockHash);
        uint64 period = client.periodOf(slot);
        if (output.nextSyncCommitteeHash == bytes32(0)) {
            output.nextSyncCommitteeHash = keccak256(abi.encode("committee", period + 1));
        }
    }

    /// Claim: after any sequence of forward jumps of any size, every jump is accepted and the stored state matches
    /// the output. Shows: 12 random jumps (1 to 5 million slots) with matching committees each move the head and
    /// store the header root and the block hash. Matters: HB-01 and rule 2. There is no jump cap, and a head that moves
    /// far leaves earlier heads stored, because withdrawals use them as anchors.
    function testFuzz_HB01_everyForwardJumpIsAcceptedAndStored(uint32[12] memory rawJumps) public {
        BeaconLightClient client = lightClientForB;
        uint64[] memory slots = new uint64[](12);
        bytes32[] memory roots = new bytes32[](12);
        for (uint256 i = 0; i < 12; i++) {
            uint64 jump = uint64(bound(rawJumps[i], 1, 5_000_000));
            uint64 slot = client.head() + jump;
            BeaconLightClient.LightClientOutput memory output = _stepOutput(client, slot, keccak256(abi.encode("block", i)));
            _submit(client, output);
            slots[i] = slot;
            roots[i] = output.newHeaderRoot;
            assertEq(client.head(), slot);
        }
        for (uint256 i = 0; i < 12; i++) {
            assertEq(client.headers(slots[i]), roots[i], "every past head stays stored");
            assertTrue(client.isFinalizedExecutionBlock(keccak256(abi.encode("block", i))));
        }
    }

    /// Claim: the acceptance rule for a new slot is exactly "advances". Shows: for a random slot (from zero up to
    /// 100 million) with matching committees, a slot at or before the head reverts with `HeadNotAdvancing` and any
    /// later slot is accepted. Matters: rule 2, the only slot rule left. The control is the other branch of the model.
    function testFuzz_HB01_updateAcceptsExactlyTheAdvancingSlots(uint64 rawSlot) public {
        BeaconLightClient client = lightClientForB;
        uint64 head = client.head();
        uint64 slot = uint64(bound(rawSlot, 0, 100_000_000));
        BeaconLightClient.LightClientOutput memory output = _outputAt(client, GENESIS_ROOT_A, slot, keccak256("model"));
        if (slot <= head) {
            _submitExpectingRevert(client, output, abi.encodeWithSelector(BeaconLightClient.HeadNotAdvancing.selector, head, slot));
            assertEq(client.head(), head);
            return;
        }
        _submit(client, output);
        assertEq(client.head(), slot);
        assertEq(client.headers(slot), output.newHeaderRoot);
    }

    /// Claim: `update` is permissionless. Shows: any caller can move the head with a valid proof; the proof, not
    /// the caller, authorizes the move. Matters: H-15 (anyone can relay) and no owner.
    function testFuzz_H15_updateCanBeCalledByAnyAddress(address caller) public {
        BeaconLightClient client = lightClientForB;
        BeaconLightClient.LightClientOutput memory output = _nextOutput(client, GENESIS_ROOT_A, keccak256("by anyone"));
        bytes memory proof = _lightClientProof(output);
        bytes memory values = abi.encode(output);
        vm.prank(caller);
        client.update(proof, values);
        assertEq(client.head(), output.newHeadSlot);
    }

    /// Claim: the decoder of the light-client output takes exactly the eleven-word layout. Shows: fuzzed words in
    /// every field reach the first failing check in order. Matters: R2-09 and H-01 (a field in the wrong place
    /// would be a different statement).
    function testFuzz_R2_09_decodingChecksFieldsInOrder(
        bytes32 genesisRoot,
        bytes32 previousHeaderRoot,
        uint64 previousSlot,
        bytes32 previousCommittee,
        bytes32 startNextCommittee
    ) public {
        BeaconLightClient client = lightClientForB;
        BeaconLightClient.LightClientOutput memory output = _nextOutput(client, genesisRoot, keccak256("b"));
        output.previousHeaderRoot = previousHeaderRoot;
        output.previousHeadSlot = previousSlot;
        output.previousSyncCommitteeHash = previousCommittee;
        output.startNextSyncCommitteeHash = startNextCommittee;
        bytes memory expected;
        if (genesisRoot != GENESIS_ROOT_A) {
            expected = abi.encodeWithSelector(BeaconLightClient.GenesisValidatorsRootMismatch.selector, GENESIS_ROOT_A, genesisRoot);
        } else if (previousSlot != INITIAL_SLOT) {
            expected = abi.encodeWithSelector(BeaconLightClient.PreviousHeadSlotMismatch.selector, INITIAL_SLOT, previousSlot);
        } else if (previousHeaderRoot != INITIAL_HEADER_ROOT) {
            expected = abi.encodeWithSelector(BeaconLightClient.PreviousHeaderRootMismatch.selector, INITIAL_HEADER_ROOT, previousHeaderRoot);
        } else if (previousCommittee != COMMITTEE_100) {
            expected = abi.encodeWithSelector(BeaconLightClient.PreviousSyncCommitteeMismatch.selector, COMMITTEE_100, previousCommittee);
        } else if (startNextCommittee != COMMITTEE_101) {
            expected = abi.encodeWithSelector(BeaconLightClient.StartNextSyncCommitteeMismatch.selector, COMMITTEE_101, startNextCommittee);
        }
        if (expected.length > 0) {
            _submitExpectingRevert(client, output, expected);
            return;
        }
        _submit(client, output);
        assertEq(client.head(), output.newHeadSlot);
    }

    // ================================================================ message bridge: sends

    /// Claim: message identifiers are unique and carry the nonce, for any number of sends and any senders. Shows: 1..40
    /// sends from the source bridge and as many from the destination bridge, spread over three senders, give pairwise
    /// different identifiers. Each identifier is the prefix of its bridge with the count of earlier sends in the low
    /// bytes. Matters: H-12 and H-16. The identifier is the replay key of delivery, so a repeat would lose a message.
    function testFuzz_H12_noncesAreUnique(uint8 rawCount, address[3] memory senders) public {
        uint256 count = bound(rawCount, 1, 40);
        for (uint256 i = 0; i < senders.length; i++) {
            vm.assume(senders[i] != address(0) && senders[i].code.length == 0);
            vm.assume(senders[i] != address(sourceBridge) && senders[i] != address(bridge));
        }
        bytes32 prefixA = AmbMessageCodec.messageIdPrefix(CHAIN_A, address(sourceBridge));
        bytes32 prefixB = AmbMessageCodec.messageIdPrefix(CHAIN_B, address(bridge));
        bytes32[] memory seen = new bytes32[](count * 2);
        for (uint256 i = 0; i < count; i++) {
            seen[2 * i] = _sendFrom(sourceBridge, senders[i % 3]);
            seen[2 * i + 1] = _sendFrom(bridge, senders[i % 3]);
            assertEq(seen[2 * i], prefixA | bytes32(i), "the source identifier carries the nonce");
            assertEq(seen[2 * i + 1], prefixB | bytes32(i), "the destination identifier carries the nonce");
        }
        for (uint256 i = 0; i < seen.length; i++) {
            for (uint256 j = i + 1; j < seen.length; j++) {
                assertTrue(seen[i] != seen[j]);
            }
        }
    }

    function _sendFrom(MessageBridge from, address sender) internal returns (bytes32) {
        vm.prank(sender);
        return from.requireToPassMessage(MessageFixtures.TARGET_RECORDER, "x", 100_000);
    }

    // ================================================================ message bridge: delivery

    /// Claim: no single flipped bit in the evidence delivers. Shows: for a random bit in a random part of the proof (an
    /// anchor field, a branch sibling, the execution header, a receipt proof node, a transaction proof node, the
    /// source header), `executeMessage` reverts, the target does not run and the message is not marked; the
    /// untouched evidence then delivers (so the refused call left no delivery mark). Matters: R2-04 and H-08 (every byte of the evidence is bound by some check).
    function testFuzz_H08_withdrawRejectsAnyFlippedBit(uint8 part, uint256 position, uint8 bit) public {
        MessageFixtures.Named memory named = MessageFixtures.deliver();
        Scene memory scene = _scene(named, _defaultParams());
        MessageBridge.MessageProof memory tampered = _clone(scene.proof);
        uint256 mask = uint256(1) << (bit % 8);

        uint256 choice = part % 8;
        if (choice == 0) tampered.anchorHeader.stateRoot ^= bytes32(uint256(1) << (position % 256));
        if (choice == 1) tampered.anchorHeader.parentRoot ^= bytes32(uint256(1) << (position % 256));
        if (choice == 2) tampered.sourceHeader.bodyRoot ^= bytes32(uint256(1) << (position % 256));
        if (choice == 3) {
            tampered.ancestryBranch[position % tampered.ancestryBranch.length] ^= bytes32(uint256(1) << (position % 256));
        }
        if (choice == 4) {
            tampered.blockHashBranch[position % tampered.blockHashBranch.length] ^= bytes32(uint256(1) << (position % 256));
        }
        if (choice == 5) tampered.executionHeaderRlp[position % tampered.executionHeaderRlp.length] ^= bytes1(uint8(mask));
        if (choice == 6) {
            bytes memory node = tampered.receiptProof[position % tampered.receiptProof.length];
            node[(position / 8) % node.length] ^= bytes1(uint8(mask));
        }
        if (choice == 7) {
            bytes memory node = tampered.transactionProof[position % tampered.transactionProof.length];
            node[(position / 8) % node.length] ^= bytes1(uint8(mask));
        }

        vm.expectRevert();
        bridge.executeMessage(tampered);
        assertEq(recorder.callCount(), 0, "the target did not run");
        assertFalse(bridge.messageCallStatus(named.messageId));

        bridge.executeMessage(scene.proof); // honest path
        assertEq(recorder.callCount(), 1, "the untouched evidence delivers");
        assertTrue(bridge.messageCallStatus(named.messageId));
    }

    /// Claim: the receipt index, the transaction index and the log index are bound by the evidence. Shows: for a random
    /// receipt index, transaction index or log index, `executeMessage` refuses unless the indices name the proven
    /// transaction and a log that holds a message. The one other log that holds a message (the second message of the
    /// same transaction) delivers as a message of its own and leaves the first message undelivered. Matters: R2-06.
    function testFuzz_R2_06_withdrawRejectsOtherIndices(uint16 receiptIndex, uint16 transactionIndex, uint8 logIndex)
        public
    {
        MessageFixtures.Named memory first = MessageFixtures.two_a();
        MessageFixtures.Named memory second = MessageFixtures.two_b();
        Scene memory scene = _scene(first, _defaultParams());
        vm.assume(receiptIndex != first.transactionIndex || transactionIndex != first.transactionIndex || logIndex != first.logIndex);
        MessageBridge.MessageProof memory other = _clone(scene.proof);
        other.receiptIndex = receiptIndex;
        other.transactionIndex = transactionIndex;
        other.logIndex = logIndex;
        // A different log of the same transaction may be the other message, which is a legitimate delivery of its own.
        bool sameTransactionOtherMessage =
            receiptIndex == first.transactionIndex && transactionIndex == first.transactionIndex && logIndex == second.logIndex;
        if (sameTransactionOtherMessage) {
            bridge.executeMessage(other);
            assertTrue(bridge.messageCallStatus(second.messageId));
            assertFalse(bridge.messageCallStatus(first.messageId));
            return;
        }
        vm.expectRevert();
        bridge.executeMessage(other);
        assertEq(recorder.callCount(), 0, "the target did not run");
        assertFalse(bridge.messageCallStatus(first.messageId));
    }
}
