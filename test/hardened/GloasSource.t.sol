// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {BeaconProofVerifier} from "../../src/hardened/BeaconProofVerifier.sol";
import {MessageBridge} from "../../src/hardened/MessageBridge.sol";
import {BeaconLightClient} from "../../src/hardened/BeaconLightClient.sol";
import {BeaconBlockHeader, SSZ} from "../../src/hardened/SSZ.sol";
import {MessageScenes} from "./utils/MessageScenes.sol";
import {MessageFixtures} from "./utils/MessageFixtures.sol";

/// @notice A message from a GLOAS source. The source header of the proof is a beacon block B at or after
/// `gloasForkSlot`, which comes after the execution block X. The bid of B names X as its `parent_block_hash` (index 2856,
/// 11 entries). The soundness argument is in `BeaconProofVerifier` (`GLOAS_BID_PARENT_BLOCK_HASH_GINDEX`). The bid's own
/// `block_hash` (index 22857, 14 entries) is never accepted. The body here is a sparse tree with the hash at the named
/// index, so the test holds each position to its number. The Rust fixtures `gloas_*` run the same cases through the real
/// layout of a Gloas body (`LightClientFixtures.t.sol`).
contract GloasSourceTest is MessageScenes {
    uint256 internal constant BID_PARENT_BLOCK_HASH = 2856;
    uint256 internal constant BID_BLOCK_HASH = 22857;
    uint256 internal constant BID_PARENT_BLOCK_ROOT = 2857;

    /// @dev A scene whose body holds X at `position`, on a bridge whose Gloas fork starts at `forkSlot`. Only the
    /// `block_roots` layout is added: a Gloas source takes no body layout.
    function _gloasScene(uint256 position, uint64 forkSlot)
        internal
        returns (MessageBridge target, SceneParams memory params, Scene memory scene)
    {
        params = _defaultParams();
        params.blockHashGindex = position;
        scene = _buildScene(MessageFixtures.deliver(), params, _messageHeaderRlp());
        _storeScene(params, scene);
        target = _bridgeWithForkSlot(forkSlot == 0 ? params.depositSlot : forkSlot);
        target.addBlockRootsLayout(params.blockRootsGindex, scene.rootsEvidence);
    }

    function _bridgeWithForkSlot(uint64 forkSlot) internal returns (MessageBridge created) {
        bridgeGloasForkSlot = forkSlot;
        created = _newDestinationBridge(lightClientForB, 0, DEFAULT_CAPELLA_ERA);
    }

    /// Claim: a message whose source block B holds X as the bid `parent_block_hash` is delivered, with no body layout in
    /// the bridge. Shows: the branch has 11 entries, the bridge holds no body layout, and the target is called once.
    /// Matters: this is the rule that lets a Gloas chain send messages.
    function test_bidParentBlockHashProvesTheMessageBlock() public {
        (MessageBridge target,, Scene memory scene) = _gloasScene(BID_PARENT_BLOCK_HASH, 0);
        MessageFixtures.Named memory named = MessageFixtures.deliver();
        MessageBridge.MessageProof memory proof = _messageProof(scene, named);
        assertEq(proof.blockHashBranch.length, 11);
        assertEq(target.bodyLayouts().length, 0, "a Gloas source takes no body layout");
        uint256 before = gasleft();
        target.executeMessage(proof);
        emit log_named_uint("gas of the same message (deliver) from a Gloas source", before - gasleft());
        assertTrue(target.messageCallStatus(named.messageId));
        assertEq(recorder.callCount(), 1);
    }

    /// Claim: the bid `block_hash` (index 22857) is not accepted in place of the `parent_block_hash`. Shows: a body that holds
    /// X at 22857 gives a branch of 14 entries and `BranchLengthMismatch(11, 14)`. Matters: the payload of the bid may be
    /// withheld.
    function test_bidBlockHashIsRefused() public {
        (MessageBridge target,, Scene memory scene) = _gloasScene(BID_BLOCK_HASH, 0);
        MessageBridge.MessageProof memory proof = _messageProof(scene, MessageFixtures.deliver());
        assertEq(proof.blockHashBranch.length, 14);
        vm.expectRevert(abi.encodeWithSelector(SSZ.BranchLengthMismatch.selector, 11, 14));
        target.executeMessage(proof);
    }

    /// Claim: X in the neighbouring bid field (`parent_block_root`, index 2857, same depth) is refused with
    /// `BlockHashBranchInvalid`. Matters: the position is exact, not just the depth.
    function test_wrongPositionIsRefused() public {
        (MessageBridge target,, Scene memory scene) = _gloasScene(BID_PARENT_BLOCK_ROOT, 0);
        MessageBridge.MessageProof memory proof = _messageProof(scene, MessageFixtures.deliver());
        assertEq(proof.blockHashBranch.length, 11);
        vm.expectRevert(BeaconProofVerifier.BlockHashBranchInvalid.selector);
        target.executeMessage(proof);
    }

    /// Claim: an execution header RLP that does not hash to the bid `parent_block_hash` is refused, also when it is a valid
    /// header of another block. Matters: the receipts root and the transactions root come from this RLP.
    function test_rlpMismatchIsRefused() public {
        (MessageBridge target,, Scene memory scene) = _gloasScene(BID_PARENT_BLOCK_HASH, 0);
        MessageBridge.MessageProof memory proof = _messageProof(scene, MessageFixtures.deliver());
        proof.executionHeaderRlp = _executionHeaderRlp(MessageFixtures.RECEIPTS_ROOT, keccak256("another block"), 17);
        vm.expectRevert(BeaconProofVerifier.BlockHashBranchInvalid.selector);
        target.executeMessage(proof);
    }

    /// Claim: B must be an ancestor of the stored head. A flipped entry of the ancestry branch gives
    /// `AncestryBranchInvalid`. Control: the honest proof delivers.
    function test_sourceThatIsNotAnAncestorIsRefused() public {
        (MessageBridge target,, Scene memory scene) = _gloasScene(BID_PARENT_BLOCK_HASH, 0);
        MessageFixtures.Named memory named = MessageFixtures.deliver();
        MessageBridge.MessageProof memory proof = _messageProof(scene, named);
        proof.ancestryBranch[5] = bytes32(uint256(proof.ancestryBranch[5]) ^ 1);
        vm.expectRevert(BeaconProofVerifier.AncestryBranchInvalid.selector);
        target.executeMessage(proof);
        target.executeMessage(_messageProof(scene, named));
        assertTrue(target.messageCallStatus(named.messageId));
    }

    /// Claim: a source block B BEFORE the Gloas fork gets no Gloas rule. With the fork one slot after the source, the same
    /// proof (a Gloas branch) takes the layout path: with no body layout it reverts `LayoutNotValidated`, and with the
    /// layout of a Fulu body (9 entries) it reverts `BranchLengthMismatch(9, 11)`. Matters: the fixed index must not
    /// reach a pre-Gloas body.
    function test_sourceBeforeTheForkTakesTheLayoutPath() public {
        // The Fulu scene first: scenes store their headers in rising slot order.
        SceneParams memory fulu = _defaultParams();
        Scene memory fuluScene = _buildScene(MessageFixtures.deliver(), fulu, _messageHeaderRlp());
        _storeScene(fulu, fuluScene);
        (, SceneParams memory params, Scene memory scene) = _gloasScene(BID_PARENT_BLOCK_HASH, 0);
        MessageBridge.MessageProof memory proof = _messageProof(scene, MessageFixtures.deliver());

        MessageBridge before = _bridgeWithForkSlot(params.depositSlot + 1);
        before.addBlockRootsLayout(params.blockRootsGindex, scene.rootsEvidence);
        vm.expectRevert(abi.encodeWithSelector(BeaconProofVerifier.LayoutNotValidated.selector, params.depositSlot));
        before.executeMessage(proof);

        MessageBridge withLayout = _bridgeWithForkSlot(fulu.anchorSlot);
        withLayout.addBlockRootsLayout(fulu.blockRootsGindex, fuluScene.rootsEvidence);
        withLayout.addBlockHashLayout(
            fulu.blockHashGindex, BeaconProofVerifier.BlockHashEvidence(fuluScene.evidenceBefore, fuluScene.evidenceBeforeBranch)
        );
        withLayout.addBlockHashLayout(
            fulu.blockHashGindex, BeaconProofVerifier.BlockHashEvidence(fuluScene.evidenceAfter, fuluScene.evidenceAfterBranch)
        );
        MessageBridge.MessageProof memory gloasBranch = _messageProof(fuluScene, MessageFixtures.deliver());
        gloasBranch.blockHashBranch = proof.blockHashBranch;
        vm.expectRevert(abi.encodeWithSelector(SSZ.BranchLengthMismatch.selector, 9, 11));
        withLayout.executeMessage(gloasBranch);
    }

    /// Claim: the gas of the same message from a Fulu source (recent path, one layout read), for the comparison with
    /// `test_bidParentBlockHashProvesTheMessageBlock`, which logs the gas of the Gloas source. The Gloas proof reads no layout
    /// and hashes two more nodes of the body branch.
    function test_gasOfTheSameMessageFromAFuluSource() public {
        MessageFixtures.Named memory named = MessageFixtures.deliver();
        Scene memory scene = _scene(named, _defaultParams());
        uint256 before = gasleft();
        bridge.executeMessage(scene.proof);
        emit log_named_uint("gas of the same message (deliver) from a Fulu source", before - gasleft());
        assertTrue(bridge.messageCallStatus(named.messageId));
    }

    /// Claim: a REAL Sepolia proof (`light-client/tests/fixtures/sepolia/gloas_message_source.json`) passes every check up to
    /// the log. B is the real beacon block whose bid names the real execution block X as `parent_block_hash` (the node
    /// served the 11 entry branch), the anchor is a real later header whose real state holds B in `block_roots` (352), the
    /// RLP is the real 23 item header, and the receipt and transaction proofs are real. The log is a transfer log and not a
    /// bridge message, so the bridge reverts `WrongEventTopic` with the real topic: the reverts of the earlier checks would
    /// have come first. A flipped branch entry reverts `BlockHashBranchInvalid`.
    function test_realSepoliaProofReachesTheLogChecks() public {
        string memory json = vm.readFile("light-client/tests/fixtures/sepolia/gloas_message_source.json");
        BeaconBlockHeader memory source = _headerFrom(json, ".response.source_header");
        BeaconBlockHeader memory anchor = _headerFrom(json, ".response.anchor_header");
        vm.chainId(943);
        address emitter = vm.parseJsonAddress(json, ".response.log.address");
        BeaconLightClient client = new BeaconLightClient(
            address(0xdead), keccak256("light client program"), keccak256("genesis"), 8192, 1, 1,
            anchor.slot, SSZ.hashTreeRootMemory(anchor), keccak256("committee"), keccak256("next")
        );
        MessageBridge real = new MessageBridge(
            address(client), 11_155_111, emitter,
            MessageBridge.BridgeTerms(0, makeAddr("remote light client"), 353_024 * 32), 222, address(0x6a7e)
        );
        // The Sepolia state layout (352 for block_roots) is a validated row. Seed it as the fixtures harness does.
        _seedStateLayout(address(real), 352);
        bytes memory rlp = vm.parseJsonBytes(
            vm.readFile("light-client/tests/fixtures/sepolia/gloas_head_execution_header.json"), ".raw_header"
        );
        MessageBridge.MessageProof memory proof = _realProof(json, anchor, source, rlp);
        assertEq(proof.blockHashBranch.length, 11);
        bytes32 topic = vm.parseJsonBytes32(json, ".response.log.topics[0]");
        vm.expectRevert(abi.encodeWithSelector(BeaconProofVerifier.WrongEventTopic.selector, topic));
        real.executeMessage(proof);

        proof.blockHashBranch[4] = bytes32(uint256(proof.blockHashBranch[4]) ^ 1);
        vm.expectRevert(BeaconProofVerifier.BlockHashBranchInvalid.selector);
        real.executeMessage(proof);
    }

    function _headerFrom(string memory json, string memory key) internal pure returns (BeaconBlockHeader memory) {
        return BeaconBlockHeader({
            slot: uint64(vm.parseUint(vm.parseJsonString(json, string.concat(key, ".slot")))),
            proposerIndex: uint64(vm.parseUint(vm.parseJsonString(json, string.concat(key, ".proposer_index")))),
            parentRoot: vm.parseJsonBytes32(json, string.concat(key, ".parent_root")),
            stateRoot: vm.parseJsonBytes32(json, string.concat(key, ".state_root")),
            bodyRoot: vm.parseJsonBytes32(json, string.concat(key, ".body_root"))
        });
    }

    function _realProof(string memory json, BeaconBlockHeader memory anchor, BeaconBlockHeader memory source, bytes memory rlp)
        internal
        pure
        returns (MessageBridge.MessageProof memory proof)
    {
        uint256 index = vm.parseJsonUint(json, ".response.transaction_index");
        proof = MessageBridge.MessageProof({
            anchorHeader: anchor,
            sourceHeader: source,
            ancestryBranch: vm.parseJsonBytes32Array(json, ".response.ancestry_branch"),
            blockHashBranch: vm.parseJsonBytes32Array(json, ".response.block_hash_branch"),
            executionHeaderRlp: rlp,
            receiptProof: vm.parseJsonBytesArray(json, ".response.receipt_proof"),
            receiptIndex: index,
            transactionProof: vm.parseJsonBytesArray(json, ".response.transaction_proof"),
            transactionIndex: index,
            logIndex: 0
        });
    }

    /// @dev Writes one `block_roots` layout row (slot 4 of the bridge storage) that covers every slot.
    function _seedStateLayout(address target, uint256 gindex) internal {
        bytes32 base = keccak256(abi.encode(uint256(4)));
        vm.store(target, bytes32(uint256(4)), bytes32(uint256(1)));
        vm.store(target, base, bytes32(gindex));
        vm.store(target, bytes32(uint256(base) + 1), bytes32(uint256(0) | (uint256(type(uint64).max) << 64)));
    }
}
