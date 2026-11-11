// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {BeaconProofVerifier} from "../../src/hardened/BeaconProofVerifier.sol";
import {MessageBridge} from "../../src/hardened/MessageBridge.sol";
import {BeaconLightClient} from "../../src/hardened/BeaconLightClient.sol";
import {ForkShape} from "../../src/hardened/ForkShape.sol";
import {BeaconBlockHeader, SSZ} from "../../src/hardened/SSZ.sol";
import {MessageScenes} from "./utils/MessageScenes.sol";
import {MessageFixtures} from "./utils/MessageFixtures.sol";
import {ForkProofs} from "./utils/ForkProofs.sol";

/// @notice A message from a GLOAS source. The source header of the proof is a beacon block B whose state the fork proof
/// shows to be progressive, and B comes after the execution block X. The bid of B names X as its `parent_block_hash`
/// (index 2856, 11 entries). The soundness argument is in `BeaconLayoutLib` (`GLOAS_BID_PARENT_BLOCK_HASH_GINDEX`). The
/// bid's own `block_hash` (index 22857, 14 entries) is never accepted. The bridge holds no fork slot: every bridge here is
/// built the same way, and the fork proof of the source state alone picks the rule. The body here is a sparse tree with the
/// hash at the named index, so the test holds each position to its number. The Rust fixtures `gloas_*` run the same cases
/// through the real layout of a Gloas body (`LightClientFixtures.t.sol`).
contract GloasSourceTest is MessageScenes {
    uint256 internal constant BID_PARENT_BLOCK_HASH = 2856;
    uint256 internal constant BID_BLOCK_HASH = 22857;
    uint256 internal constant BID_PARENT_BLOCK_ROOT = 2857;
    /// @dev The genesis validators root of Sepolia, which the real states below hold at index 40.
    bytes32 internal constant SEPOLIA_GENESIS_VALIDATORS_ROOT =
        0xd8ea171f3c94aea21ebc42a1ed61052acf3f9209c00e4efbaaddac09ed9b8078;

    /// @dev A scene whose source state has `sourceShape` and whose body holds X at `position`, on a new destination
    /// bridge. Only the `block_roots` layout is added: a Gloas source takes no body layout.
    function _sourceScene(uint256 position, uint8 sourceShape)
        internal
        returns (MessageBridge target, SceneParams memory params, Scene memory scene)
    {
        params = _defaultParams();
        params.blockHashGindex = position;
        params.sourceShape = sourceShape;
        scene = _buildScene(MessageFixtures.deliver(), params, _messageHeaderRlp());
        _storeScene(params, scene);
        target = _newDestinationBridge(lightClientForB, 0, DEFAULT_CAPELLA_ERA);
        target.addBlockRootsLayout(params.blockRootsGindex, scene.rootsEvidence);
    }

    function _gloasScene(uint256 position)
        internal
        returns (MessageBridge target, SceneParams memory params, Scene memory scene)
    {
        return _sourceScene(position, ForkProofs.PROGRESSIVE);
    }

    /// Claim: a message whose source block B holds X as the bid `parent_block_hash` is delivered, on a bridge that was given
    /// no fork slot and holds no body layout. Shows: the fork proof proves the progressive shape, the branch has 11 entries,
    /// and the target is called once. Matters: this is the rule that lets a Gloas chain send messages, and it needs nothing
    /// at deployment, so a route deployed before the fork is scheduled follows it (the A6 case: Ethereum mainnet today).
    function test_bidParentBlockHashProvesTheMessageBlock() public {
        (MessageBridge target,, Scene memory scene) = _gloasScene(BID_PARENT_BLOCK_HASH);
        MessageFixtures.Named memory named = MessageFixtures.deliver();
        MessageBridge.MessageProof memory proof = _messageProof(scene, named);
        assertEq(proof.blockHashBranch.length, 11);
        assertEq(proof.sourceFork.versionBranch.length, 7, "a progressive version branch");
        assertEq(proof.sourceFork.genesisValidatorsRootBranch.length, 5, "the genesis validators root at index 40");
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
        (MessageBridge target,, Scene memory scene) = _gloasScene(BID_BLOCK_HASH);
        MessageBridge.MessageProof memory proof = _messageProof(scene, MessageFixtures.deliver());
        assertEq(proof.blockHashBranch.length, 14);
        vm.expectRevert(abi.encodeWithSelector(SSZ.BranchLengthMismatch.selector, 11, 14));
        target.executeMessage(proof);
    }

    /// Claim: X in the neighbouring bid field (`parent_block_root`, index 2857, same depth) is refused with
    /// `BlockHashBranchInvalid`. Matters: the position is exact, not just the depth.
    function test_wrongPositionIsRefused() public {
        (MessageBridge target,, Scene memory scene) = _gloasScene(BID_PARENT_BLOCK_ROOT);
        MessageBridge.MessageProof memory proof = _messageProof(scene, MessageFixtures.deliver());
        assertEq(proof.blockHashBranch.length, 11);
        vm.expectRevert(BeaconProofVerifier.BlockHashBranchInvalid.selector);
        target.executeMessage(proof);
    }

    /// Claim: an execution header RLP that does not hash to the bid `parent_block_hash` is refused, also when it is a valid
    /// header of another block. Matters: the receipts root and the transactions root come from this RLP.
    function test_rlpMismatchIsRefused() public {
        (MessageBridge target,, Scene memory scene) = _gloasScene(BID_PARENT_BLOCK_HASH);
        MessageBridge.MessageProof memory proof = _messageProof(scene, MessageFixtures.deliver());
        proof.executionHeaderRlp = _executionHeaderRlp(MessageFixtures.RECEIPTS_ROOT, keccak256("another block"), 17);
        vm.expectRevert(BeaconProofVerifier.BlockHashBranchInvalid.selector);
        target.executeMessage(proof);
    }

    /// Claim: B must be an ancestor of the stored head. A flipped entry of the ancestry branch gives
    /// `AncestryBranchInvalid`. Control: the honest proof delivers.
    function test_sourceThatIsNotAnAncestorIsRefused() public {
        (MessageBridge target,, Scene memory scene) = _gloasScene(BID_PARENT_BLOCK_HASH);
        MessageFixtures.Named memory named = MessageFixtures.deliver();
        MessageBridge.MessageProof memory proof = _messageProof(scene, named);
        proof.ancestryBranch[5] = bytes32(uint256(proof.ancestryBranch[5]) ^ 1);
        vm.expectRevert(BeaconProofVerifier.AncestryBranchInvalid.selector);
        target.executeMessage(proof);
        target.executeMessage(_messageProof(scene, named));
        assertTrue(target.messageCallStatus(named.messageId));
    }

    /// Claim: a source block whose state is PLAIN gets no Gloas rule, whatever its body holds. The body holds X at 2856 and
    /// the proof carries that branch; the plain fork proof sends it to the layout path: with no body layout it reverts
    /// `LayoutNotValidated`, and with the layout of a Fulu body (9 entries) it reverts `BranchLengthMismatch(9, 11)`.
    /// Matters: the fixed index must not reach a pre-Gloas body, where 2856 lies under fields that a proposer fills.
    function test_plainSourceTakesTheLayoutPath() public {
        // The Fulu scene first: scenes store their headers in rising slot order.
        SceneParams memory fulu = _defaultParams();
        Scene memory fuluScene = _buildScene(MessageFixtures.deliver(), fulu, _messageHeaderRlp());
        _storeScene(fulu, fuluScene);
        (MessageBridge target, SceneParams memory params, Scene memory scene) = _sourceScene(BID_PARENT_BLOCK_HASH, 6);
        MessageBridge.MessageProof memory proof = _messageProof(scene, MessageFixtures.deliver());
        assertEq(proof.sourceFork.versionBranch.length, 8, "a plain depth 6 version branch");
        vm.expectRevert(abi.encodeWithSelector(BeaconProofVerifier.LayoutNotValidated.selector, params.depositSlot));
        target.executeMessage(proof);

        MessageBridge withLayout = _newDestinationBridge(lightClientForB, 0, DEFAULT_CAPELLA_ERA);
        withLayout.addBlockRootsLayout(fulu.blockRootsGindex, fuluScene.rootsEvidence);
        withLayout.addBlockHashLayout(fulu.blockHashGindex, _hashEvidence(fuluScene.evidenceBefore, fuluScene.evidenceBeforeBranch));
        withLayout.addBlockHashLayout(fulu.blockHashGindex, _hashEvidence(fuluScene.evidenceAfter, fuluScene.evidenceAfterBranch));
        MessageBridge.MessageProof memory gloasBranch = _messageProof(fuluScene, MessageFixtures.deliver());
        gloasBranch.blockHashBranch = proof.blockHashBranch;
        vm.expectRevert(abi.encodeWithSelector(SSZ.BranchLengthMismatch.selector, 9, 11));
        withLayout.executeMessage(gloasBranch);
    }

    /// Claim: the prover cannot swap the fork proof. A Gloas source with the fork proof of a plain state (valid for another
    /// root) reverts `ForkShapeProofInvalid(VersionProofInvalid)`, and a Fulu source with the proof of a progressive state
    /// reverts the same. Control: each honest proof delivers. Matters: the rule follows the state of the proven source
    /// header, and no other state.
    function test_aForkProofOfAnotherStateIsRefused() public {
        (MessageBridge target,, Scene memory scene) = _gloasScene(BID_PARENT_BLOCK_HASH);
        MessageFixtures.Named memory named = MessageFixtures.deliver();
        MessageBridge.MessageProof memory proof = _messageProof(scene, named);
        proof.sourceFork = ForkProofs.state(6, GENESIS_ROOT_A).fork;
        vm.expectRevert(_shapeError(ForkShape.Verdict.VersionProofInvalid));
        target.executeMessage(proof);
        target.executeMessage(_messageProof(scene, named));
        assertTrue(target.messageCallStatus(named.messageId));

        MessageFixtures.Named memory second = MessageFixtures.confirm();
        Scene memory fulu = _scene(second, _defaultParams());
        MessageBridge.MessageProof memory fuluProof = _messageProof(fulu, second);
        fuluProof.sourceFork = ForkProofs.state(ForkProofs.PROGRESSIVE, GENESIS_ROOT_A).fork;
        vm.expectRevert(_shapeError(ForkShape.Verdict.VersionProofInvalid));
        target.executeMessage(fuluProof);
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
    /// the log, on a bridge given no fork slot. B is the real beacon block whose bid names the real execution block X as
    /// `parent_block_hash` (the node served the 11 entry branch). Its fork proof is real: the version branch of its state
    /// (`gloas_fork_version.json`, 7 entries to index 169) and the genesis validators root branch to index 40, which shares
    /// four siblings with the version branch and adds the `slot` chunk. The anchor is a real later header whose real state
    /// holds B in `block_roots` (352), the RLP is the real 23 item header, and the receipt and transaction proofs are real.
    /// The log is a transfer log and not a bridge message, so the bridge reverts `WrongEventTopic` with the real topic: the
    /// reverts of the earlier checks would have come first. A flipped branch entry reverts `BlockHashBranchInvalid`, and a
    /// flipped entry of the genesis validators root branch reverts `ForkShapeProofInvalid`.
    function test_realSepoliaProofReachesTheLogChecks() public {
        string memory json = vm.readFile("light-client/tests/fixtures/sepolia/gloas_message_source.json");
        BeaconBlockHeader memory source = _headerFrom(json, ".response.source_header");
        BeaconBlockHeader memory anchor = _headerFrom(json, ".response.anchor_header");
        vm.chainId(943);
        address emitter = vm.parseJsonAddress(json, ".response.log.address");
        BeaconLightClient client = new BeaconLightClient(
            address(0xdead), keccak256("light client program"), SEPOLIA_GENESIS_VALIDATORS_ROOT, 8192, 1, 1,
            anchor.slot, SSZ.hashTreeRootMemory(anchor), keccak256("committee"), keccak256("next")
        );
        MessageBridge real = new MessageBridge(
            address(client), 11_155_111, emitter, MessageBridge.BridgeTerms(0, makeAddr("remote light client")), 222,
            address(0x6a7e)
        );
        // The Sepolia state layout (352 for block_roots) is a validated row. Seed it as the fixtures harness does.
        _seedStateLayout(address(real), 352);
        bytes memory rlp = vm.parseJsonBytes(
            vm.readFile("light-client/tests/fixtures/sepolia/gloas_head_execution_header.json"), ".raw_header"
        );
        MessageBridge.MessageProof memory proof = _realProof(json, anchor, source, rlp);
        proof.sourceFork = _realSourceFork(source);
        assertEq(proof.blockHashBranch.length, 11);
        bytes32 topic = vm.parseJsonBytes32(json, ".response.log.topics[0]");
        vm.expectRevert(abi.encodeWithSelector(BeaconProofVerifier.WrongEventTopic.selector, topic));
        real.executeMessage(proof);

        MessageBridge.MessageProof memory wrongRoot = _clone(proof);
        wrongRoot.sourceFork.genesisValidatorsRootBranch[0] = bytes32(uint256(proof.sourceFork.genesisValidatorsRootBranch[0]) ^ 1);
        vm.expectRevert(_shapeError(ForkShape.Verdict.GenesisValidatorsRootProofInvalid));
        real.executeMessage(wrongRoot);

        proof.blockHashBranch[4] = bytes32(uint256(proof.blockHashBranch[4]) ^ 1);
        vm.expectRevert(BeaconProofVerifier.BlockHashBranchInvalid.selector);
        real.executeMessage(proof);
    }

    /// @dev The real fork proof of the state of B. The version branch is the fixture. The genesis validators root branch is
    /// derived by hand: index 40 has the siblings 41 (`slot`, chunk 2), 21 (the node over `fork` and chunk 4), 11, 4 and
    /// 3; the last three are entries 4 to 6 of the version branch, and node 21 hashes the `fork` root (from the version
    /// leaves and entry 1) with entry 2 (chunk 4). The bridge checks the result, so a wrong derivation fails the test.
    function _realSourceFork(BeaconBlockHeader memory source)
        internal
        view
        returns (BeaconProofVerifier.ForkProof memory fork)
    {
        string memory json = vm.readFile("light-client/tests/fixtures/sepolia/gloas_fork_version.json");
        bytes32[] memory versionBranch = vm.parseJsonBytes32Array(json, ".response.branch");
        bytes32 version = vm.parseJsonBytes32(json, ".response.version");
        bytes32 forkRoot = sha256(abi.encodePacked(sha256(abi.encodePacked(versionBranch[0], version)), versionBranch[1]));
        bytes32[] memory rootBranch = new bytes32[](5);
        rootBranch[0] = bytes32(_littleEndian64(source.slot));
        rootBranch[1] = sha256(abi.encodePacked(forkRoot, versionBranch[2]));
        rootBranch[2] = versionBranch[4];
        rootBranch[3] = versionBranch[5];
        rootBranch[4] = versionBranch[6];
        fork = BeaconProofVerifier.ForkProof(bytes4(version), versionBranch, rootBranch);
    }

    /// @dev A `uint64` as SSZ packs it in a chunk: little endian, in the first 8 bytes.
    function _littleEndian64(uint64 value) internal pure returns (uint256 chunk) {
        for (uint256 i = 0; i < 8; i++) {
            chunk |= uint256((value >> (8 * i)) & 0xff) << (248 - 8 * i);
        }
    }

    function _shapeError(ForkShape.Verdict verdict) internal pure returns (bytes memory) {
        return abi.encodeWithSelector(BeaconProofVerifier.ForkShapeProofInvalid.selector, uint8(verdict));
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
        proof.anchorHeader = anchor;
        proof.sourceHeader = source;
        proof.ancestryBranch = vm.parseJsonBytes32Array(json, ".response.ancestry_branch");
        proof.blockHashBranch = vm.parseJsonBytes32Array(json, ".response.block_hash_branch");
        proof.executionHeaderRlp = rlp;
        proof.receiptProof = vm.parseJsonBytesArray(json, ".response.receipt_proof");
        proof.receiptIndex = index;
        proof.transactionProof = vm.parseJsonBytesArray(json, ".response.transaction_proof");
        proof.transactionIndex = index;
        proof.logIndex = 0;
    }

    /// @dev Writes one `block_roots` layout row (slot 4 of the bridge storage, the first table of `LayoutTables`) that
    /// covers every slot.
    function _seedStateLayout(address target, uint256 gindex) internal {
        bytes32 base = keccak256(abi.encode(uint256(4)));
        vm.store(target, bytes32(uint256(4)), bytes32(uint256(1)));
        vm.store(target, base, bytes32(gindex));
        vm.store(target, bytes32(uint256(base) + 1), bytes32(uint256(0) | (uint256(type(uint64).max) << 64)));
    }
}
