// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {MediatorBuild} from "./utils/MediatorBuild.sol";
import {Vm} from "forge-std/Vm.sol";
import {BeaconProofVerifier} from "../../src/hardened/BeaconProofVerifier.sol";
import {MessageBridge} from "../../src/hardened/MessageBridge.sol";
import {AmbMessageCodec} from "../../src/hardened/AmbMessageCodec.sol";
import {BeaconBlockHeader, SSZ} from "../../src/hardened/SSZ.sol";
import {TokenMediator} from "../../src/hardened/mediator/TokenMediator.sol";
import {UnexpectedString} from "../../src/hardened/vendor/optimism/rlp/RLPErrors.sol";
import {ReceiptBuilder} from "./utils/ReceiptBuilder.sol";
import {MockERC20} from "../../src/mocks/MockERC20.sol";
import {MessageScenes} from "./utils/MessageScenes.sol";
import {MessageFixtures} from "./utils/MessageFixtures.sol";
import {MessageRecorder, MessageGate} from "./utils/MessageTargets.sol";
import {GapsRecordingGate} from "./utils/GapsGates.sol";
import {DynamicProofs} from "./utils/DynamicProofs.sol";
import {WithdrawalScenes} from "./utils/WithdrawalScenes.sol";

/// @notice The checks that the retired vault tests made and that no other message bridge test makes: the beacon part of
/// a proof, the send cutoff for delivery, the order of the checks of a send, what the gate receives, and a second
/// bridge on the destination chain.
contract MessageBridgeGapsTest is MessageScenes, DynamicProofs {
    /// @dev Both bases build on `WithdrawalScenes.setUp`, and `MessageScenes` extends it, so the combination must say so.
    function setUp() public override(MessageScenes, WithdrawalScenes) {
        super.setUp();
    }

    function _expectRefusal(MessageBridge.MessageProof memory proof, bytes memory revertData) internal {
        vm.expectRevert(revertData);
        bridge.executeMessage(proof);
    }

    function _assertDeliverable(Scene memory scene, MessageFixtures.Named memory named) internal {
        assertFalse(bridge.messageCallStatus(named.messageId), "a refusal delivers nothing");
        bridge.executeMessage(_messageProof(scene, named));
        assertTrue(bridge.messageCallStatus(named.messageId), "the honest proof delivers");
    }

    function _send(MessageBridge from, bytes memory data, uint256 gas) internal returns (bytes32) {
        vm.prank(MessageFixtures.SENDER);
        return from.requireToPassMessage(MessageFixtures.TARGET_RECORDER, data, gas);
    }

    // ================================================================ the anchor

    /// Claim: an anchor header at a slot where the light client stored nothing is refused. Shows: the same header one
    /// slot higher reverts with the slot and the root of the header that the executor sent; the stored one delivers.
    /// Matters: only a header that the light client finalized may anchor a proof.
    function test_anchor_headerAtAnUnstoredSlotIsRefused() public {
        Scene memory scene = _messageScene(bridge);
        MessageFixtures.Named memory named = MessageFixtures.deliver();
        MessageBridge.MessageProof memory unstored = _messageProof(scene, named);
        unstored.anchorHeader.slot += 1;
        _expectRefusal(
            unstored,
            abi.encodeWithSelector(
                BeaconProofVerifier.AnchorNotStored.selector,
                unstored.anchorHeader.slot,
                SSZ.hashTreeRootMemory(unstored.anchorHeader)
            )
        );
        _assertDeliverable(scene, named);
    }

    /// Claim: the anchor header must equal the stored root in every field. Shows: a forged state root (the field that an
    /// attacker would choose), a forged body root, a forged parent root and a forged proposer index each revert with
    /// the root of the forged header. Matters: the state root of the anchor is the root of trust of the whole proof.
    function test_anchor_everyForgedFieldIsRefused() public {
        Scene memory scene = _messageScene(bridge);
        MessageFixtures.Named memory named = MessageFixtures.deliver();
        bytes32 attacker = keccak256("a state root of the attacker");

        MessageBridge.MessageProof memory stateRoot = _messageProof(scene, named);
        stateRoot.anchorHeader.stateRoot = attacker;
        _expectRefusal(stateRoot, _notStored(stateRoot));

        MessageBridge.MessageProof memory bodyRoot = _messageProof(scene, named);
        bodyRoot.anchorHeader.bodyRoot = attacker;
        _expectRefusal(bodyRoot, _notStored(bodyRoot));

        MessageBridge.MessageProof memory parentRoot = _messageProof(scene, named);
        parentRoot.anchorHeader.parentRoot = attacker;
        _expectRefusal(parentRoot, _notStored(parentRoot));

        MessageBridge.MessageProof memory proposer = _messageProof(scene, named);
        proposer.anchorHeader.proposerIndex += 1;
        _expectRefusal(proposer, _notStored(proposer));
        _assertDeliverable(scene, named);
    }

    function _notStored(MessageBridge.MessageProof memory proof) internal pure returns (bytes memory) {
        return abi.encodeWithSelector(
            BeaconProofVerifier.AnchorNotStored.selector, proof.anchorHeader.slot, SSZ.hashTreeRootMemory(proof.anchorHeader)
        );
    }

    /// Claim: a header of all zeros is refused, at a slot that holds nothing and at slot zero. Shows: the exact error
    /// with the root of the zero header, which is not zero. Matters: an empty proof must never match an empty slot of the
    /// light client, because zero is not a stored root.
    function test_anchor_zeroHeaderIsRefused() public {
        Scene memory scene = _messageScene(bridge);
        MessageBridge.MessageProof memory empty;
        empty.anchorHeader.slot = 5;
        empty.sourceHeader.slot = 4;
        _expectRefusal(empty, _notStored(empty));

        MessageBridge.MessageProof memory allZero;
        _expectRefusal(allZero, _notStored(allZero));
        assertTrue(SSZ.hashTreeRootMemory(allZero.anchorHeader) != bytes32(0), "the root of a zero header is not zero");
        _assertDeliverable(scene, MessageFixtures.deliver());
    }

    // ================================================================ the ancestry

    /// Claim: an ancestry branch of the wrong length is an error of its own and not a silent pass. Shows: one sibling too
    /// many and one too few revert with the expected depth and the actual length, where the expected depth is the length
    /// of the honest branch. Matters: a wrong fork row shows up as a clear failure.
    function test_ancestry_branchOfTheWrongLengthIsRefused() public {
        Scene memory scene = _messageScene(bridge);
        MessageFixtures.Named memory named = MessageFixtures.deliver();
        MessageBridge.MessageProof memory honest = _messageProof(scene, named);
        uint256 depth = honest.ancestryBranch.length;
        assertGt(depth, 0);

        MessageBridge.MessageProof memory longer = _messageProof(scene, named);
        longer.ancestryBranch = new bytes32[](depth + 1);
        for (uint256 i = 0; i < depth; i++) {
            longer.ancestryBranch[i] = honest.ancestryBranch[i];
        }
        _expectRefusal(longer, abi.encodeWithSelector(SSZ.BranchLengthMismatch.selector, depth, depth + 1));

        MessageBridge.MessageProof memory shorter = _messageProof(scene, named);
        shorter.ancestryBranch = new bytes32[](depth - 1);
        for (uint256 i = 0; i < depth - 1; i++) {
            shorter.ancestryBranch[i] = honest.ancestryBranch[i];
        }
        _expectRefusal(shorter, abi.encodeWithSelector(SSZ.BranchLengthMismatch.selector, depth, depth - 1));
        _assertDeliverable(scene, named);
    }

    /// Claim: the source header must be the one that the branch shows. Shows: a changed proposer index and a changed slot
    /// of the source header each revert with `AncestryBranchInvalid`. Matters: the source block is tied to the finalized
    /// chain by its whole header and its position.
    function test_ancestry_changedSourceHeaderIsRefused() public {
        Scene memory scene = _messageScene(bridge);
        MessageFixtures.Named memory named = MessageFixtures.deliver();

        MessageBridge.MessageProof memory header = _messageProof(scene, named);
        header.sourceHeader.proposerIndex += 1;
        _expectRefusal(header, abi.encodeWithSelector(BeaconProofVerifier.AncestryBranchInvalid.selector));

        MessageBridge.MessageProof memory slot = _messageProof(scene, named);
        slot.sourceHeader.slot -= 1; // another vector index, so another path
        _expectRefusal(slot, abi.encodeWithSelector(BeaconProofVerifier.AncestryBranchInvalid.selector));
        _assertDeliverable(scene, named);
    }

    /// Claim: a source block later than the anchor is refused as well as one at the same slot. Shows: the exact error with
    /// both slots for a source slot five above the anchor. Matters: the anchor state holds roots only up to the slot before it.
    function test_ancestry_sourceAfterTheAnchorIsRefused() public {
        Scene memory scene = _messageScene(bridge);
        MessageFixtures.Named memory named = MessageFixtures.deliver();
        MessageBridge.MessageProof memory later = _messageProof(scene, named);
        later.sourceHeader.slot = later.anchorHeader.slot + 5;
        _expectRefusal(
            later,
            abi.encodeWithSelector(BeaconProofVerifier.DepositNotBeforeAnchor.selector, later.anchorHeader.slot + 5, later.anchorHeader.slot)
        );
        _assertDeliverable(scene, named);
    }

    // ================================================================ the block hash and the header

    /// Claim: the execution block hash must sit in the body of the source header. Shows: a different execution header
    /// (so a different hash, with the honest branch) reverts with `BlockHashBranchInvalid`; so do a block hash branch
    /// one sibling too long and one too short, with the length error. Matters: the receipts root is trusted only through
    /// this link.
    function test_blockHash_otherExecutionHeaderAndWrongLengthAreRefused() public {
        Scene memory scene = _messageScene(bridge);
        MessageFixtures.Named memory named = MessageFixtures.deliver();

        MessageBridge.MessageProof memory otherHeader = _messageProof(scene, named);
        otherHeader.executionHeaderRlp = _executionHeaderRlp(MessageFixtures.RECEIPTS_ROOT, MessageFixtures.TRANSACTIONS_ROOT, 16);
        _expectRefusal(otherHeader, abi.encodeWithSelector(BeaconProofVerifier.BlockHashBranchInvalid.selector));

        MessageBridge.MessageProof memory honest = _messageProof(scene, named);
        uint256 depth = honest.blockHashBranch.length;
        MessageBridge.MessageProof memory longer = _messageProof(scene, named);
        longer.blockHashBranch = new bytes32[](depth + 1);
        for (uint256 i = 0; i < depth; i++) {
            longer.blockHashBranch[i] = honest.blockHashBranch[i];
        }
        _expectRefusal(longer, abi.encodeWithSelector(SSZ.BranchLengthMismatch.selector, depth, depth + 1));

        MessageBridge.MessageProof memory shorter = _messageProof(scene, named);
        shorter.blockHashBranch = new bytes32[](depth - 1);
        for (uint256 i = 0; i < depth - 1; i++) {
            shorter.blockHashBranch[i] = honest.blockHashBranch[i];
        }
        _expectRefusal(shorter, abi.encodeWithSelector(SSZ.BranchLengthMismatch.selector, depth, depth - 1));
        _assertDeliverable(scene, named);
    }

    /// Claim: an execution header that is not a Recursive Length Prefix list is refused. Shows: a byte string as the header, with a valid
    /// branch for its own hash, reverts with `UnexpectedString` of the list reader, and the honest header delivers. Matters: the
    /// bridge never decodes arbitrary bytes as a header.
    function test_header_nonListIsRefused() public {
        MessageFixtures.Named memory named = MessageFixtures.deliver();
        SceneParams memory params = _defaultParams();
        Scene memory bad = _sceneWithHeader(named, params, _rlpBytes("this is a string, not a list of fields"));
        vm.expectRevert(UnexpectedString.selector);
        bridge.executeMessage(_messageProof(bad, named));

        Scene memory honest = _scene(named, _defaultParams());
        _assertDeliverable(honest, named);
    }

    // ================================================================ the fork layouts

    /// Claim: a layout is usable only inside the slot range where it was validated. Shows: a bridge that knows the state
    /// position and the body position of the anchor slot only refuses a message whose source slot lies below the
    /// validated body range, with `LayoutNotValidated` and the source slot; after anyone validates the body position at
    /// the evidence header before the source slot, the same proof delivers. Matters: a position validated in one fork
    /// must not be used for slots of an earlier fork, where it could point at another field.
    function test_layout_sourceSlotOutsideTheValidatedRangeIsRefused() public {
        MessageFixtures.Named memory named = MessageFixtures.deliver();
        SceneParams memory params = _defaultParams();
        Scene memory scene = _buildScene(named, params, _messageHeaderRlp());
        _storeScene(params, scene);
        bridge.addBlockRootsLayout(params.blockRootsGindex, scene.rootsEvidence);
        bridge.addBlockHashLayout(params.anchorBodyGindex, scene.anchorBodyEvidence); // validated at the anchor slot only

        MessageBridge.MessageProof memory proof = _messageProof(scene, named);
        _expectRefusal(proof, abi.encodeWithSelector(BeaconProofVerifier.LayoutNotValidated.selector, params.depositSlot));

        vm.prank(attacker); // any caller
        bridge.addBlockHashLayout(
            params.blockHashGindex, _hashEvidence(scene.evidenceBefore, scene.evidenceBeforeBranch)
        );
        bridge.executeMessage(proof);
        assertTrue(bridge.messageCallStatus(named.messageId), "the range now reaches the source slot");
    }

    // ================================================================ the constructor

    /// Claim: a bridge stores any capella era that it is given, zero included. Shows: eras 0 and 758 read back as given,
    /// and 758 differs from the era of the fixture bridge. Matters: the era sets every historical leaf position, and a
    /// chain that started its capella fork in the first era has a real era of zero.
    function test_constructor_storesAnyCapellaEraIncludingZero() public {
        vm.chainId(CHAIN_B);
        MessageBridge.BridgeTerms memory terms = MessageBridge.BridgeTerms(0, address(lightClientForA));
        MessageBridge zero = new MessageBridge(
            address(lightClientForB), CHAIN_A, MessageFixtures.REMOTE_BRIDGE, terms, 0, address(gateB)
        );
        MessageBridge later = new MessageBridge(
            address(lightClientForB), CHAIN_A, MessageFixtures.REMOTE_BRIDGE, terms, 758, address(gateB)
        );
        assertEq(zero.capellaEra(), 0);
        assertEq(later.capellaEra(), 758);
        assertTrue(later.capellaEra() != bridge.capellaEra(), "the value is not the default");
    }

    // ================================================================ the send cutoff and delivery

    /// Claim: a cutoff of zero means no cutoff, for a send and for a delivery. Shows: at the largest timestamp, a send on
    /// the source bridge passes and a message delivers on the destination bridge, and both bridges report a cutoff of
    /// zero. Matters: the cutoff is opt in, and set only when a breaking fork of the other chain is scheduled.
    function test_cutoff_zeroMeansNoCutoffForSendAndDelivery() public {
        assertEq(sourceBridge.sendCutoffTimestamp(), 0);
        assertEq(bridge.sendCutoffTimestamp(), 0);
        Scene memory scene = _messageScene(bridge);
        vm.warp(type(uint64).max);

        vm.chainId(CHAIN_A);
        _send(sourceBridge, "late", 100_000);
        vm.chainId(CHAIN_B);
        _assertDeliverable(scene, MessageFixtures.deliver());
    }

    /// Claim: delivery still works after the send cutoff of the delivering bridge. Shows: a destination bridge with a
    /// cutoff delivers two messages 30 days after the cutoff, while a send on the same bridge reverts with
    /// `SendCutoffReached` (control: the cutoff is real). Matters: a route that closed to new messages keeps delivering
    /// the messages that it can still prove.
    function test_cutoff_deliveryStillWorksAfterTheCutoff() public {
        uint64 cutoff = 2_000_000_000;
        bridge = _newDestinationBridge(lightClientForB, cutoff, DEFAULT_CAPELLA_ERA);
        assertEq(bridge.sendCutoffTimestamp(), cutoff);
        Scene memory scene = _messageScene(bridge);
        vm.warp(cutoff + 30 days);

        vm.chainId(CHAIN_B);
        vm.expectRevert(abi.encodeWithSelector(MessageBridge.SendCutoffReached.selector, cutoff));
        vm.prank(MessageFixtures.SENDER);
        bridge.requireToPassMessage(MessageFixtures.TARGET_RECORDER, "x", 100_000);

        _assertDeliverable(scene, MessageFixtures.deliver());
        bridge.executeMessage(_messageProof(scene, MessageFixtures.order_a()));
        assertEq(recorder.callCount(), 2, "both messages reached the target");
    }

    // ================================================================ the order of the checks of a send

    /// Claim: a send checks in this order: the lock, the cutoff, the selector, the gate. Shows: with every
    /// check failing at once, the errors come one by one as each earlier check is satisfied: closed lock, then cutoff
    /// reached, then a forbidden selector, then the refusal of the gate. The bridge reads no gas number. The gate is
    /// never called before it. Matters: the order is part of the contract. The retired vault ran the gate FIRST. The
    /// message bridge runs it LAST, on purpose: the gate may spend gas and write state, so every cheap check goes
    /// before it.
    function test_sendOrder_lockCutoffGasSelectorThenGate() public {
        MessageGate gate = new MessageGate();
        gate.setRefusing(true);
        bytes memory forbidden = abi.encodePacked(bytes4(0xa9059cbb), new bytes(64));

        // Lock first: closed, cutoff reached, bad selector, refusing gate.
        uint64 cutoff = uint64(block.timestamp + 100);
        MessageBridge closing = _deploySourceBridge(cutoff, address(gate));
        vm.warp(cutoff);
        vm.expectRevert(BeaconProofVerifier.DepositsNotOpen.selector);
        closing.requireToPassMessage(address(0), forbidden, 5);

        // Cutoff second: open, and the rest as before.
        _openDepositsWithoutProof(closing);
        vm.expectRevert(abi.encodeWithSelector(MessageBridge.SendCutoffReached.selector, cutoff));
        closing.requireToPassMessage(address(0), forbidden, 5);

        // Selector third: no cutoff, any gas (the bridge reads none), bad selector, refusing gate.
        MessageBridge open = _redeployWithGate(address(gate));
        vm.expectRevert(abi.encodeWithSelector(MessageBridge.ForbiddenSelector.selector, bytes4(0xa9059cbb)));
        open.requireToPassMessage(address(0), forbidden, 5);

        // The gate last: everything else is fine.
        assertEq(gate.calls(), 0, "no earlier check reached the gate");
        vm.expectRevert(abi.encodeWithSelector(MessageGate.GateRefused.selector, bytes("")));
        open.requireToPassMessage(address(0), hex"c0ffee", 100_000);

        gate.setRefusing(false);
        open.requireToPassMessage(address(0), hex"c0ffee", 100_000);
        assertEq(gate.calls(), 1, "the gate saw only the send that passed every other check");
    }

    function _redeployWithGate(address gate) internal returns (MessageBridge created) {
        created = _deploySourceBridge(0, gate);
        _openDepositsWithoutProof(created);
    }

    /// Claim: every send hands the gate EMPTY evidence, whoever sends, whatever the call data and whichever of the two send
    /// functions runs. Shows: a recording gate sees four admissions, each from the bridge, each with zero bytes of
    /// evidence, and a failed send adds none. Matters: a send has no evidence parameter. The first poster of an epoch
    /// confirms it with `BeaconForkGate.confirm`, and the send never carries evidence. A gate that read the evidence of
    /// a send would see nothing.
    function test_gate_everySendHandsTheGateEmptyEvidence() public {
        GapsRecordingGate gate = new GapsRecordingGate();
        MessageBridge gated = _redeployWithGate(address(gate));

        vm.prank(MessageFixtures.SENDER);
        gated.requireToPassMessage(MessageFixtures.TARGET_RECORDER, "", 100_000);
        vm.prank(attacker);
        gated.requireToPassMessage(MessageFixtures.TARGET_RECORDER, new bytes(2000), 10_000_000);
        vm.prank(MessageFixtures.SENDER);
        gated.requireToConfirmMessage(MessageFixtures.TARGET_RECORDER, hex"c0ffee", 100);
        gated.requireToPassMessage(address(0), abi.encodePacked(bytes4(0x12345678), hex"c0ffee0102"), 500_000);

        vm.expectRevert(abi.encodeWithSelector(MessageBridge.ForbiddenSelector.selector, bytes4(0xa9059cbb)));
        gated.requireToPassMessage(address(0), abi.encodePacked(bytes4(0xa9059cbb)), 5);

        assertEq(gate.admissionCount(), 4, "one admission per successful send and none for the failed one");
        for (uint256 i = 0; i < 4; i++) {
            assertEq(gate.admissionAt(i).caller, address(gated), "the bridge calls the gate");
            assertEq(gate.admissionAt(i).evidence.length, 0, "the evidence is empty");
        }
    }

    /// Claim: a send has no parameter that names the destination chain, and the message always names the remote chain.
    /// Shows: the call with a chain argument does not exist, the standard call works, and the logged message names the
    /// remote chain and this chain as source. Matters: a typo in a destination would lock funds. The route is fixed at
    /// deployment.
    function test_send_hasNoDestinationChainParameter() public {
        vm.chainId(CHAIN_A);
        vm.prank(MessageFixtures.SENDER);
        (bool withChain,) = address(sourceBridge).call(
            abi.encodeWithSignature(
                "requireToPassMessage(address,bytes,uint256,uint64)", MessageFixtures.TARGET_RECORDER, bytes("x"), 100_000, uint64(56)
            )
        );
        assertFalse(withChain, "no overload takes a destination chain");

        vm.recordLogs();
        _send(sourceBridge, "x", 100_000);
        Vm.Log[] memory logs = vm.getRecordedLogs();
        (AmbMessageCodec.Header memory header,) = AmbMessageCodec.decode(abi.decode(logs[0].data, (bytes)));
        assertEq(header.destinationChainId, CHAIN_B, "the destination is the remote chain");
        assertEq(header.sourceChainId, CHAIN_A, "the source is this chain");
    }

    // ================================================================ a second bridge on the destination chain

    /// @dev A second bridge on chain B with the same remote bridge, the same light client and the same layouts as `bridge`.
    function _secondBridge() internal returns (MessageBridge second) {
        vm.chainId(CHAIN_B);
        second = new MessageBridge(
            address(lightClientForB),
            CHAIN_A,
            MessageFixtures.REMOTE_BRIDGE,
            MessageBridge.BridgeTerms(0, address(lightClientForA)),
            DEFAULT_CAPELLA_ERA,
            address(gateB)
        );
        _registerBridge(second);
    }

    /// Claim: a second bridge on the destination chain, with the same remote bridge, delivers the same message too, and
    /// the target sees which bridge called. Shows: the one message delivers once through each bridge; the target records
    /// two calls with the same identifier and two different callers; each bridge refuses a replay on its own. Matters: a
    /// message names a destination chain and a target, NOT a destination bridge. Anyone can deploy a bridge with the same
    /// remote bridge, and its delivery map starts empty. So a target must trust only its own bridge, with
    /// `msg.sender == bridge`, and never a message just because a bridge of this chain passed it.
    function test_secondBridge_deliversTheSameMessageAndTheTargetSeesTheCaller() public {
        MessageBridge second = _secondBridge();
        Scene memory scene = _scene(MessageFixtures.deliver(), _defaultParams());
        MessageFixtures.Named memory named = MessageFixtures.deliver();

        bridge.executeMessage(_messageProof(scene, named));
        second.executeMessage(_messageProof(scene, named));
        assertEq(recorder.callCount(), 2, "the target ran once for each bridge");
        assertEq(recorder.callAt(0).messageId, recorder.callAt(1).messageId, "the same message");
        assertEq(recorder.callAt(0).caller, address(bridge));
        assertEq(recorder.callAt(1).caller, address(second));
        assertTrue(recorder.callAt(0).caller != recorder.callAt(1).caller, "the callers differ");

        vm.expectRevert(abi.encodeWithSelector(MessageBridge.AlreadyDelivered.selector, named.messageId));
        second.executeMessage(_messageProof(scene, named));
        vm.expectRevert(abi.encodeWithSelector(MessageBridge.AlreadyDelivered.selector, named.messageId));
        bridge.executeMessage(_messageProof(scene, named));
    }

    /// @dev Builds the proof of one log with the real tries, and gives its fork layouts to `bridge` and to `other`. The one
    /// proof then delivers through either bridge.
    function _proveForTwoBridges(MessageBridge other, SourceTransaction memory source, uint256 logIndex)
        internal
        returns (MessageBridge.MessageProof memory proof)
    {
        bytes memory transaction = ReceiptBuilder.transaction(source.transactionType, source.transactionPayload);
        ReceiptBuilder.Block memory assembled = ReceiptBuilder.assemble(
            source.blockSize,
            source.index,
            ReceiptBuilder.receipt(source.receiptType, source.status, source.logs),
            transaction
        );
        SceneParams memory params = _defaultParams();
        Scene memory scene = _buildScene(
            MessageFixtures.deliver(),
            params,
            _executionHeaderRlp(assembled.receiptsRoot, assembled.transactionsRoot, 17)
        );
        _storeScene(lightClientForB, GENESIS_ROOT_A, params, scene);
        _addLayouts(bridge, lightClientForB, params, scene);
        _addLayouts(other, lightClientForB, params, scene);

        proof = _clone(scene.proof);
        proof.receiptProof = ReceiptBuilder.receiptProofOf(assembled, source.index);
        proof.receiptIndex = source.index;
        proof.transactionProof = ReceiptBuilder.transactionProofOf(assembled, source.index);
        proof.transactionIndex = source.index;
        proof.logIndex = logIndex;
    }

    /// Claim: the token mediator refuses a handler call from a second bridge. Shows: a message to the mediator that
    /// the second bridge delivers reverts with `NotBridge` (the message stays undelivered there, and the mediator
    /// changed nothing); a direct call from the second bridge reverts with `NotBridge` and the address of
    /// that bridge; the same message through the bridge that the mediator trusts is accepted and changes the mediator.
    /// Matters: the message layer cannot tell a target which bridge to trust. The mediator checks `msg.sender` against its own
    /// bridge, so a bridge that anyone deployed cannot reach its handlers.
    function test_secondBridge_mediatorRefusesAHandlerCallFromTheOtherBridge() public {
        vm.chainId(CHAIN_B);
        MockERC20 token = new MockERC20("Token", "TKN");
        TokenMediator.MediatorTerms memory terms;
        terms.bridge = address(bridge);
        terms.remoteMediator = MessageFixtures.SENDER;
        TokenMediator mediator = MediatorBuild.deploy(terms, "Chain A");
        MessageBridge second = _secondBridge();

        bytes memory handler = abi.encodeCall(TokenMediator.handleNativeTokens, (address(token), address(0xB0B), 0));
        vm.chainId(CHAIN_A);
        vm.recordLogs();
        vm.prank(MessageFixtures.SENDER);
        bytes32 id = sourceBridge.requireToPassMessage(address(mediator), handler, 300_000);
        Vm.Log[] memory recorded = vm.getRecordedLogs();
        SourceTransaction memory source = _sourceTransactionOf(recorded);
        uint256 logIndex = _logIndexOf(recorded, address(sourceBridge), sourceBridge.USER_REQUEST_TOPIC());
        MessageBridge.MessageProof memory proof = _proveForTwoBridges(second, source, logIndex);

        vm.chainId(CHAIN_B);
        vm.prank(address(second));
        vm.expectRevert(abi.encodeWithSelector(TokenMediator.NotBridge.selector, address(second)));
        mediator.handleNativeTokens(address(token), address(0xB0B), 0);

        vm.expectRevert(abi.encodeWithSelector(TokenMediator.NotBridge.selector, address(second)));
        second.executeMessage(proof);
        assertFalse(second.messageCallStatus(id), "the delivery through the second bridge reverted and left nothing");
        assertFalse(mediator.isBridgedTokenDeployAcknowledged(address(token)), "the mediator changed nothing");

        bridge.executeMessage(proof);
        assertTrue(bridge.messageCallStatus(id), "the trusted bridge delivers the same message");
        assertTrue(mediator.isBridgedTokenDeployAcknowledged(address(token)), "and the handler ran");
    }
}
