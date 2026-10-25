// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {BeaconProofVerifier} from "../../src/hardened/BeaconProofVerifier.sol";
import {MessageBridge} from "../../src/hardened/MessageBridge.sol";
import {AmbMessageCodec} from "../../src/hardened/AmbMessageCodec.sol";
import {BeaconBlockHeader, SSZ} from "../../src/hardened/SSZ.sol";
import {MessageScenes} from "./utils/MessageScenes.sol";
import {MessageFixtures} from "./utils/MessageFixtures.sol";

/// @notice Refusals of the message bridge: every way that a proof or a log can be wrong. Each test shows the exact
/// error and then shows that the honest message still executes, so a refusal is never a side effect of a broken scene.
contract MessageBridgeProofTest is MessageScenes {
    function _expectRefusal(MessageBridge.MessageProof memory proof, bytes memory revertData) internal {
        vm.expectRevert(revertData);
        bridge.executeMessage(proof);
    }

    function _assertDeliverable(Scene memory scene, MessageFixtures.Named memory named) internal {
        assertFalse(bridge.messageCallStatus(named.messageId), "a refusal delivers nothing");
        bridge.executeMessage(_messageProof(scene, named));
        assertTrue(bridge.messageCallStatus(named.messageId), "the honest proof delivers");
    }

    // ================================================================ the log

    /// Claim: a message log of another contract than the remote bridge is refused. Shows: the exact error with both
    /// addresses. Matters: anyone can emit a log of this shape; only the remote bridge speaks for the other chain.
    function test_log_wrongEmitterIsRefused() public {
        Scene memory scene = _messageScene(bridge);
        _expectRefusal(
            _messageProof(scene, MessageFixtures.other_emitter()),
            abi.encodeWithSelector(BeaconProofVerifier.WrongEmitter.selector, MessageFixtures.REMOTE_BRIDGE, MessageFixtures.OTHER_EMITTER)
        );
        _assertDeliverable(scene, MessageFixtures.deliver());
    }

    /// Claim: a message for another destination chain is refused. Shows: the exact error. Matters: a message for chain
    /// 56 must not run on chain 369, even from the true remote bridge.
    function test_log_wrongDestinationChainIsRefused() public {
        Scene memory scene = _messageScene(bridge);
        _expectRefusal(
            _messageProof(scene, MessageFixtures.wrong_destination()),
            abi.encodeWithSelector(MessageBridge.WrongDestinationChain.selector, CHAIN_B, 56)
        );
        _assertDeliverable(scene, MessageFixtures.deliver());
    }

    /// Claim: a message that names another source chain than the remote chain is refused. Shows: the exact error.
    /// Matters: the context hands the source chain to the target, so it must be the chain that the proof came from.
    function test_log_wrongSourceChainIsRefused() public {
        Scene memory scene = _messageScene(bridge);
        _expectRefusal(
            _messageProof(scene, MessageFixtures.wrong_source()),
            abi.encodeWithSelector(MessageBridge.WrongSourceChain.selector, CHAIN_A, 56)
        );
        _assertDeliverable(scene, MessageFixtures.deliver());
    }

    /// Claim: a log of the remote bridge with another topic 0 is refused, and so is the first log of a receipt that
    /// holds the message in its second log. Shows: the exact error with the topic. Matters: only a
    /// `UserRequestForAffirmation` log carries a message.
    function test_log_wrongTopicIsRefused() public {
        Scene memory scene = _messageScene(bridge);
        bytes32 otherTopic = keccak256("Unrelated(uint256)");
        _expectRefusal(
            _messageProof(scene, MessageFixtures.other_topic()),
            abi.encodeWithSelector(BeaconProofVerifier.WrongEventTopic.selector, otherTopic)
        );
        MessageFixtures.Named memory first = MessageFixtures.two_a();
        first.logIndex = 0;
        _expectRefusal(
            _messageProof(scene, first), abi.encodeWithSelector(BeaconProofVerifier.WrongEventTopic.selector, otherTopic)
        );
        _assertDeliverable(scene, MessageFixtures.deliver());
    }

    /// Claim: a log index past the end of the receipt is refused with the count of logs. Shows: the exact error.
    function test_log_indexPastTheEndIsRefused() public {
        Scene memory scene = _messageScene(bridge);
        MessageFixtures.Named memory named = MessageFixtures.deliver();
        named.logIndex = 3;
        _expectRefusal(
            _messageProof(scene, named), abi.encodeWithSelector(BeaconProofVerifier.LogIndexOutOfRange.selector, 3, 1)
        );
        _assertDeliverable(scene, MessageFixtures.deliver());
    }

    /// Claim: a receipt that records a failed transaction is refused, although it holds a message log. Shows: the exact
    /// error. Matters: a reverted transaction sent nothing, and its logs do not exist on a real chain.
    function test_log_failedReceiptIsRefused() public {
        Scene memory scene = _messageScene(bridge);
        _expectRefusal(
            _messageProof(scene, MessageFixtures.failed()), abi.encodeWithSelector(BeaconProofVerifier.ReceiptFailed.selector)
        );
        _assertDeliverable(scene, MessageFixtures.deliver());
    }

    /// Claim: the identifier in the topic must equal the identifier in the message. Shows: the exact error with both.
    /// Matters: the replay key is the identifier, and two copies that disagree would leave a choice to the sender.
    function test_log_identifierOfTheTopicMustMatchTheMessage() public {
        Scene memory scene = _messageScene(bridge);
        MessageFixtures.Named memory named = MessageFixtures.id_mismatch();
        // The fixture topic holds the identifier of nonce 99, which the Python generator wrote.
        bytes32 topicId = AmbMessageCodec.messageIdPrefix(CHAIN_A, MessageFixtures.REMOTE_BRIDGE) | bytes32(uint256(99));
        _expectRefusal(
            _messageProof(scene, named),
            abi.encodeWithSelector(MessageBridge.MessageIdMismatch.selector, topicId, named.messageId)
        );
        _assertDeliverable(scene, MessageFixtures.deliver());
    }

    /// Claim: a message identifier with another format version is refused. Shows: the exact error. Matters: another
    /// version means another layout, and the bridge reads only its own.
    function test_log_otherVersionIsRefused() public {
        Scene memory scene = _messageScene(bridge);
        MessageFixtures.Named memory named = MessageFixtures.bad_version();
        _expectRefusal(
            _messageProof(scene, named), abi.encodeWithSelector(MessageBridge.MessageVersionInvalid.selector, named.messageId)
        );
        _assertDeliverable(scene, MessageFixtures.deliver());
    }

    /// Claim: a data type that the bridge never sends is refused. Shows: the exact error.
    function test_log_unknownDataTypeIsRefused() public {
        Scene memory scene = _messageScene(bridge);
        _expectRefusal(
            _messageProof(scene, MessageFixtures.bad_data_type()),
            abi.encodeWithSelector(MessageBridge.UnknownDataType.selector, 7)
        );
        _assertDeliverable(scene, MessageFixtures.deliver());
    }

    /// Claim: event data shorter than a message header is refused, and so is event data that is not the canonical
    /// encoding of one `bytes` value. Shows: the exact errors. Matters: one message must have one encoding.
    function test_log_malformedEventDataIsRefused() public {
        Scene memory scene = _messageScene(bridge);
        _expectRefusal(
            _messageProof(scene, MessageFixtures.short_message()),
            abi.encodeWithSelector(AmbMessageCodec.MalformedMessage.selector)
        );
        _expectRefusal(
            _messageProof(scene, MessageFixtures.non_canonical_data()),
            abi.encodeWithSelector(MessageBridge.MalformedEventData.selector)
        );
        _assertDeliverable(scene, MessageFixtures.deliver());
    }

    // ================================================================ the receipt and the transaction

    /// Claim: the receipt must be in the receipts trie. Shows: a tampered node, a proof cut short and a header with
    /// another receipts root each revert with the exact error of the trie check. Matters: the receipt is the only
    /// evidence that the message was sent.
    function test_receipt_tamperedProofIsRefused() public {
        Scene memory scene = _messageScene(bridge);
        MessageFixtures.Named memory named = MessageFixtures.deliver();

        MessageBridge.MessageProof memory node = _messageProof(scene, named);
        uint256 last = node.receiptProof.length - 1;
        node.receiptProof[last][node.receiptProof[last].length - 1] ^= 0x01;
        _expectRefusal(node, "MerkleTrie: invalid large internal hash");

        MessageBridge.MessageProof memory cut = _messageProof(scene, named);
        bytes[] memory shortProof = new bytes[](cut.receiptProof.length - 1);
        for (uint256 i = 0; i < shortProof.length; i++) {
            shortProof[i] = cut.receiptProof[i];
        }
        cut.receiptProof = shortProof;
        _expectRefusal(cut, "MerkleTrie: ran out of proof elements");

        SceneParams memory params = _defaultParams();
        Scene memory other = _sceneWithOtherRoots(params, keccak256("another receipts root"), MessageFixtures.TRANSACTIONS_ROOT);
        _expectRefusal(_messageProof(other, named), "MerkleTrie: invalid root hash");
        _assertDeliverable(scene, named);
    }

    /// Claim: the transaction must be in the transactions trie, which fixes the hash that the target sees. Shows: a
    /// tampered node, a proof cut short, a header with another transactions root and the proof of another
    /// transaction each revert with the exact error of the trie check. Matters: the executor cannot name the hash of a
    /// transaction that did not send the message.
    function test_transaction_tamperedBranchIsRefused() public {
        Scene memory scene = _messageScene(bridge);
        MessageFixtures.Named memory named = MessageFixtures.deliver();

        MessageBridge.MessageProof memory node = _messageProof(scene, named);
        uint256 last = node.transactionProof.length - 1;
        node.transactionProof[last][node.transactionProof[last].length - 1] ^= 0x01;
        _expectRefusal(node, "MerkleTrie: invalid large internal hash");

        MessageBridge.MessageProof memory cut = _messageProof(scene, named);
        bytes[] memory shortProof = new bytes[](cut.transactionProof.length - 1);
        for (uint256 i = 0; i < shortProof.length; i++) {
            shortProof[i] = cut.transactionProof[i];
        }
        cut.transactionProof = shortProof;
        _expectRefusal(cut, "MerkleTrie: ran out of proof elements");

        SceneParams memory params = _defaultParams();
        Scene memory other = _sceneWithOtherRoots(params, MessageFixtures.RECEIPTS_ROOT, keccak256("another transactions root"));
        _expectRefusal(_messageProof(other, named), "MerkleTrie: invalid root hash");

        MessageBridge.MessageProof memory wrongTransaction = _messageProof(scene, named);
        wrongTransaction.transactionProof = MessageFixtures.transactionProofFor(MessageFixtures.order_a().transactionIndex);
        _expectRefusal(wrongTransaction, "MerkleTrie: invalid large internal hash");
        _assertDeliverable(scene, named);
    }

    /// Claim: the receipt index and the transaction index must be equal. Shows: a proof with two indices that differ
    /// is refused with both values, whichever one is changed. Matters: the transaction that is hashed must be the
    /// transaction that produced the receipt that holds the log.
    function test_transaction_mismatchedIndicesAreRefused() public {
        Scene memory scene = _messageScene(bridge);
        MessageFixtures.Named memory named = MessageFixtures.deliver();
        uint256 other = MessageFixtures.order_a().transactionIndex;

        MessageBridge.MessageProof memory transactionSide = _messageProof(scene, named);
        transactionSide.transactionIndex = other;
        transactionSide.transactionProof = MessageFixtures.transactionProofFor(other);
        _expectRefusal(
            transactionSide, abi.encodeWithSelector(MessageBridge.IndexMismatch.selector, named.transactionIndex, other)
        );

        MessageBridge.MessageProof memory receiptSide = _messageProof(scene, named);
        receiptSide.receiptIndex = other;
        receiptSide.receiptProof = MessageFixtures.receiptProofFor(other);
        _expectRefusal(
            receiptSide, abi.encodeWithSelector(MessageBridge.IndexMismatch.selector, other, named.transactionIndex)
        );
        _assertDeliverable(scene, named);
    }

    // ================================================================ the beacon part

    /// Claim: an anchor header that the light client did not store is refused. Shows: the exact error with the slot and
    /// the root of the forged header. Matters: the anchor is the root of trust.
    function test_anchor_unstoredAnchorIsRefused() public {
        Scene memory scene = _messageScene(bridge);
        MessageFixtures.Named memory named = MessageFixtures.deliver();
        MessageBridge.MessageProof memory forged = _messageProof(scene, named);
        forged.anchorHeader.proposerIndex += 1;
        _expectRefusal(
            forged,
            abi.encodeWithSelector(
                BeaconProofVerifier.AnchorNotStored.selector, forged.anchorHeader.slot, SSZ.hashTreeRootMemory(forged.anchorHeader)
            )
        );
        _assertDeliverable(scene, named);
    }

    /// Claim: a source block that is not strictly before the anchor is refused. Shows: the exact error. Matters: the
    /// ancestry paths read only blocks below the anchor.
    function test_anchor_sourceNotBeforeTheAnchorIsRefused() public {
        Scene memory scene = _messageScene(bridge);
        MessageFixtures.Named memory named = MessageFixtures.deliver();
        MessageBridge.MessageProof memory same = _messageProof(scene, named);
        same.sourceHeader.slot = same.anchorHeader.slot;
        _expectRefusal(
            same,
            abi.encodeWithSelector(BeaconProofVerifier.DepositNotBeforeAnchor.selector, same.anchorHeader.slot, same.anchorHeader.slot)
        );
        _assertDeliverable(scene, named);
    }

    /// Claim: a tampered ancestry branch and a tampered block hash branch are refused with their own errors. Shows:
    /// one flipped sibling in each. Matters: the beacon part links the execution block to the anchor.
    function test_anchor_tamperedBranchesAreRefused() public {
        Scene memory scene = _messageScene(bridge);
        MessageFixtures.Named memory named = MessageFixtures.deliver();
        MessageBridge.MessageProof memory ancestry = _messageProof(scene, named);
        ancestry.ancestryBranch[3] ^= bytes32(uint256(1));
        _expectRefusal(ancestry, abi.encodeWithSelector(BeaconProofVerifier.AncestryBranchInvalid.selector));
        MessageBridge.MessageProof memory blockHash = _messageProof(scene, named);
        blockHash.blockHashBranch[2] ^= bytes32(uint256(1));
        _expectRefusal(blockHash, abi.encodeWithSelector(BeaconProofVerifier.BlockHashBranchInvalid.selector));
        _assertDeliverable(scene, named);
    }

    /// Claim: a bridge with no validated layout for the anchor slot refuses with `LayoutNotValidated`, and a header with
    /// fewer than six items is refused as malformed. Shows: the exact errors. Matters: the layout rows are shared with
    /// the vault, and a message needs them as much as a deposit does.
    function test_anchor_missingLayoutAndShortHeaderAreRefused() public {
        MessageBridge bare = _newDestinationBridge(lightClientForB, 0, DEFAULT_CAPELLA_ERA);
        SceneParams memory params = _defaultParams();
        Scene memory scene = _buildScene(MessageFixtures.deliver(), params, _messageHeaderRlp());
        _storeScene(params, scene);
        MessageFixtures.Named memory named = MessageFixtures.deliver();
        vm.expectRevert(abi.encodeWithSelector(BeaconProofVerifier.LayoutNotValidated.selector, params.anchorSlot));
        bare.executeMessage(_messageProof(scene, named));

        _addLayouts(bare, params, scene);
        SceneParams memory truncatedParams = _defaultParams();
        Scene memory truncated = _buildScene(MessageFixtures.deliver(), truncatedParams, _executionHeaderRlp(MessageFixtures.RECEIPTS_ROOT, MessageFixtures.TRANSACTIONS_ROOT, 5));
        _storeScene(truncatedParams, truncated);
        _addLayouts(bare, truncatedParams, truncated);
        MessageBridge.MessageProof memory proof = _messageProof(truncated, named);
        vm.expectRevert(abi.encodeWithSelector(BeaconProofVerifier.MalformedExecutionHeader.selector));
        bare.executeMessage(proof);

        bare.executeMessage(_messageProof(scene, named));
        assertTrue(bare.messageCallStatus(named.messageId));
    }

    /// @dev A scene whose execution header holds the given roots. The block hash branch proves that header.
    function _sceneWithOtherRoots(SceneParams memory params, bytes32 receiptsRoot, bytes32 transactionsRoot)
        internal
        returns (Scene memory scene)
    {
        scene = _buildScene(MessageFixtures.deliver(), params, _executionHeaderRlp(receiptsRoot, transactionsRoot, 17));
        _storeScene(params, scene);
        _addLayouts(bridge, params, scene);
    }
}
