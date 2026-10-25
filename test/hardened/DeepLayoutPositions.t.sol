// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {MessageBridge} from "../../src/hardened/MessageBridge.sol";
import {BeaconProofVerifier} from "../../src/hardened/BeaconProofVerifier.sol";
import {SSZ} from "../../src/hardened/SSZ.sol";
import {MessageScenes} from "./utils/MessageScenes.sol";
import {MessageFixtures} from "./utils/MessageFixtures.sol";

/// @notice Tests of the deeper layout positions that the layout rule also allows: `block_roots` at 133 and
/// `historical_summaries` at 155 (a state of 128 leaves), and the block hash at 668 and 1324 (a body of 32 leaves).
/// No layout of today (Capella, Deneb, Electra, Fulu) has a field there. Each position must refuse evidence of today's
/// layouts, and must accept a synthetic state or body of the matching depth, so the rule stays correct for a later fork.
/// Capella and Deneb share one state shape (37 and 59), so one scene stands for both. The body differs: 412 in Capella,
/// 812 from Deneb on.
contract DeepLayoutPositionsTest is MessageScenes {
    uint64 internal constant CAPELLA_ERA = 758;
    uint64 internal constant FIRST_STORED_SLOT = 6_000_000;
    uint64 internal constant ANCHOR = 6_400_000;
    uint64 internal constant EVIDENCE = 6_300_000;
    /// @dev The anchor of the second state, far enough above the first for its own evidence headers.
    uint64 internal constant SECOND_ANCHOR = ANCHOR + 20_000;
    uint64 internal constant SECOND_EVIDENCE = 6_410_000;

    uint256 internal constant DEEP_BLOCK_ROOTS = 133;
    uint256 internal constant DEEP_SUMMARIES = 155;
    uint256 internal constant DEEP_BODY_FIVE_PAYLOAD_FOUR = 668;
    uint256 internal constant DEEP_BODY_FIVE_PAYLOAD_FIVE = 1324;

    // ---------------------------------------------------------------- helpers

    function _lengthMismatch(uint256 expected, uint256 actual) internal pure returns (bytes memory) {
        return abi.encodeWithSelector(SSZ.BranchLengthMismatch.selector, expected, actual);
    }

    /// @dev The branch with extra siblings on top, so that its length is `length`. The length check passes and the hash
    /// check must catch it.
    function _padTo(bytes32[] memory branch, uint256 length) internal pure returns (bytes32[] memory) {
        return _concat(branch, _repeat(keccak256("padding sibling"), length - branch.length));
    }

    /// @dev A bridge with no layout, and two stored states of today: a Capella or Deneb one (`block_roots` 37,
    /// `historical_summaries` 59) and an Electra or Fulu one (69 and 91).
    function _todaysStates()
        internal
        returns (MessageBridge target, HistoricalScene memory capellaLike, HistoricalScene memory electraLike)
    {
        target = _historicalWorld(FIRST_STORED_SLOT, CAPELLA_ERA);
        HistoricalParams memory capellaParams = _historicalParams(ANCHOR, CAPELLA_ERA, 59, EVIDENCE, _noSlots());
        capellaParams.blockRootsGindex = 37;
        HistoricalParams memory electraParams =
            _historicalParams(SECOND_ANCHOR, CAPELLA_ERA, 91, SECOND_EVIDENCE, _noSlots());
        electraParams.blockRootsGindex = 69;
        capellaLike = _historicalScene(capellaParams);
        electraLike = _historicalScene(electraParams);
    }

    /// @dev Builds and stores a scene, and adds no layout to any bridge.
    function _storedScene(SceneParams memory sceneParams) internal returns (Scene memory stored) {
        stored = _buildScene(MessageFixtures.deliver(), sceneParams, _messageHeaderRlp());
        _storeScene(sceneParams, stored);
    }

    /// @dev The setup bridge, which holds no layout, and the body evidence of today: Capella (412) and Deneb or Electra
    /// (812).
    function _todaysBodies()
        internal
        returns (MessageBridge target, BeaconProofVerifier.BlockHashEvidence memory capella, BeaconProofVerifier.BlockHashEvidence memory deneb)
    {
        SceneParams memory capellaParams = _defaultParams();
        capellaParams.anchorBodyGindex = 412;
        capellaParams.blockHashGindex = 412;
        capella = _storedScene(capellaParams).anchorBodyEvidence;
        deneb = _storedScene(_defaultParams()).anchorBodyEvidence;
        target = bridge;
    }

    // ================================================================ block_roots at 133: refused

    /// Claim: evidence of today's layouts cannot be accepted at `block_roots` position 133. Shows: the Capella shape
    /// (branch of 18) reverts with `BranchLengthMismatch(20, 18)` and the Electra shape (19) with `(20, 19)`. A branch
    /// padded to the full length of 20 passes the length check and reverts with `LayoutEvidenceInvalid`. The honest
    /// positions 37 and 69 are accepted first, as the control. Matters: no state of today holds `block_roots` at depth 7.
    function test_HB03_deepBlockRoots133_evidenceOfTodaysLayoutsRefused() public {
        (MessageBridge target, HistoricalScene memory capellaLike, HistoricalScene memory electraLike) = _todaysStates();
        target.addBlockRootsLayout(37, capellaLike.rootsEvidence);
        target.addBlockRootsLayout(69, electraLike.rootsEvidence);
        assertEq(target.stateLayouts().length, 2);
        BeaconProofVerifier.BlockRootsEvidence memory capella = capellaLike.rootsEvidence;
        BeaconProofVerifier.BlockRootsEvidence memory electra = electraLike.rootsEvidence;
        assertEq(capella.branchA.length, 18);
        assertEq(electra.branchA.length, 19);

        vm.expectRevert(_lengthMismatch(20, 18));
        target.addBlockRootsLayout(DEEP_BLOCK_ROOTS, capella);
        vm.expectRevert(_lengthMismatch(20, 19));
        target.addBlockRootsLayout(DEEP_BLOCK_ROOTS, electra);

        capella.branchA = _padTo(capella.branchA, 20);
        vm.expectRevert(BeaconProofVerifier.LayoutEvidenceInvalid.selector);
        target.addBlockRootsLayout(DEEP_BLOCK_ROOTS, capella);
        electra.branchA = _padTo(electra.branchA, 20);
        vm.expectRevert(BeaconProofVerifier.LayoutEvidenceInvalid.selector);
        target.addBlockRootsLayout(DEEP_BLOCK_ROOTS, electra);

    }

    // ================================================================ historical_summaries at 155: refused

    /// Claim: evidence of today's layouts cannot be accepted at `historical_summaries` position 155. Shows: the Capella
    /// shape (branch of 44) reverts with `BranchLengthMismatch(46, 44)` and the Electra shape (45) with `(46, 45)`.
    /// A branch padded to 46 reverts with `LayoutEvidenceInvalid`. The honest positions 59 and 91 are accepted first, as the control.
    /// Matters: no state of today holds `historical_summaries` at depth 7.
    function test_HB03_deepSummaries155_evidenceOfTodaysLayoutsRefused() public {
        (MessageBridge target, HistoricalScene memory capellaLike, HistoricalScene memory electraLike) = _todaysStates();
        target.addHistoricalSummariesLayout(59, capellaLike.historicalEvidence);
        target.addHistoricalSummariesLayout(91, electraLike.historicalEvidence);
        assertEq(target.historicalLayouts().length, 2);
        BeaconProofVerifier.HistoricalSummariesEvidence memory capella = capellaLike.historicalEvidence;
        BeaconProofVerifier.HistoricalSummariesEvidence memory electra = electraLike.historicalEvidence;
        assertEq(capella.branch.length, 44);
        assertEq(electra.branch.length, 45);

        vm.expectRevert(_lengthMismatch(46, 44));
        target.addHistoricalSummariesLayout(DEEP_SUMMARIES, capella);
        vm.expectRevert(_lengthMismatch(46, 45));
        target.addHistoricalSummariesLayout(DEEP_SUMMARIES, electra);

        capella.branch = _padTo(capella.branch, 46);
        vm.expectRevert(BeaconProofVerifier.LayoutEvidenceInvalid.selector);
        target.addHistoricalSummariesLayout(DEEP_SUMMARIES, capella);
        electra.branch = _padTo(electra.branch, 46);
        vm.expectRevert(BeaconProofVerifier.LayoutEvidenceInvalid.selector);
        target.addHistoricalSummariesLayout(DEEP_SUMMARIES, electra);

    }

    // ================================================================ block hash at 668 and 1324: refused

    /// Claim: evidence of today's layouts cannot be accepted at block hash position 668 (body of 32 leaves, payload of
    /// 16). Shows: the Capella shape (branch of 8) reverts with `BranchLengthMismatch(9, 8)`. The Deneb shape has the
    /// same length of 9 as position 668, so only the hash check can refuse it: `LayoutEvidenceInvalid`, because the
    /// branch was built for the path of 812. A Capella branch padded to 9 reverts the same way. The honest positions 412
    /// and 812 are accepted. Matters: the length check alone does not separate 668 from 812.
    function test_HB04_deepBlockHash668_evidenceOfTodaysLayoutsRefused() public {
        (MessageBridge target, BeaconProofVerifier.BlockHashEvidence memory capella, BeaconProofVerifier.BlockHashEvidence memory deneb) =
            _todaysBodies();
        assertEq(capella.branch.length, 8);
        assertEq(deneb.branch.length, 9);

        vm.expectRevert(_lengthMismatch(9, 8));
        target.addBlockHashLayout(DEEP_BODY_FIVE_PAYLOAD_FOUR, capella);
        vm.expectRevert(BeaconProofVerifier.LayoutEvidenceInvalid.selector);
        target.addBlockHashLayout(DEEP_BODY_FIVE_PAYLOAD_FOUR, deneb);

        BeaconProofVerifier.BlockHashEvidence memory padded = BeaconProofVerifier.BlockHashEvidence(capella.header, _padTo(capella.branch, 9));
        vm.expectRevert(BeaconProofVerifier.LayoutEvidenceInvalid.selector);
        target.addBlockHashLayout(DEEP_BODY_FIVE_PAYLOAD_FOUR, padded);

        target.addBlockHashLayout(412, capella);
        target.addBlockHashLayout(812, deneb);
        assertEq(target.bodyLayouts().length, 2);
    }

    /// Claim: evidence of today's layouts cannot be accepted at block hash position 1324 (body of 32 leaves, payload of
    /// 32). Shows: the Capella shape reverts with `BranchLengthMismatch(10, 8)` and the Deneb shape with `(10, 9)`.
    /// Branches padded to 10 revert with `LayoutEvidenceInvalid`. The honest positions are accepted. Matters: no body of
    /// today has 32 leaves.
    function test_HB04_deepBlockHash1324_evidenceOfTodaysLayoutsRefused() public {
        (MessageBridge target, BeaconProofVerifier.BlockHashEvidence memory capella, BeaconProofVerifier.BlockHashEvidence memory deneb) =
            _todaysBodies();

        vm.expectRevert(_lengthMismatch(10, 8));
        target.addBlockHashLayout(DEEP_BODY_FIVE_PAYLOAD_FIVE, capella);
        vm.expectRevert(_lengthMismatch(10, 9));
        target.addBlockHashLayout(DEEP_BODY_FIVE_PAYLOAD_FIVE, deneb);

        vm.expectRevert(BeaconProofVerifier.LayoutEvidenceInvalid.selector);
        target.addBlockHashLayout(
            DEEP_BODY_FIVE_PAYLOAD_FIVE, BeaconProofVerifier.BlockHashEvidence(capella.header, _padTo(capella.branch, 10))
        );
        vm.expectRevert(BeaconProofVerifier.LayoutEvidenceInvalid.selector);
        target.addBlockHashLayout(
            DEEP_BODY_FIVE_PAYLOAD_FIVE, BeaconProofVerifier.BlockHashEvidence(deneb.header, _padTo(deneb.branch, 10))
        );

        target.addBlockHashLayout(412, capella);
        target.addBlockHashLayout(812, deneb);
        assertEq(target.bodyLayouts().length, 2);
    }

    // ================================================================ accepted for a synthetic state or body

    /// Claim: a synthetic state of 128 leaves, with `block_roots` at 133 and `historical_summaries` at 155, is
    /// accepted, and both proof paths of a message work through it. Shows: both rows are added, the recent branch has 20
    /// entries, the historical branch has 46, and both messages execute. Matters: the rule stays correct for a future
    /// fork with more than 64 state fields.
    function test_HB03_deepState_rowsAreAcceptedAndBothPathsExecute() public {
        MessageBridge target = _historicalWorld(FIRST_STORED_SLOT, CAPELLA_ERA);
        HistoricalParams memory params =
            _historicalParams(ANCHOR, CAPELLA_ERA, DEEP_SUMMARIES, EVIDENCE, _slots(ANCHOR - 8192, ANCHOR - 8193));
        params.blockRootsGindex = DEEP_BLOCK_ROOTS;
        HistoricalScene memory scene = _historicalScene(params);
        _addBodyRows(target, scene);
        _addRecentRow(target, params, scene);
        _addHistoricalRow(target, params, scene);

        assertEq(target.stateLayouts().length, 1);
        assertEq(target.stateLayouts()[0].blockRootsGindex, DEEP_BLOCK_ROOTS);
        assertEq(target.historicalLayouts().length, 1);
        assertEq(target.historicalLayouts()[0].historicalSummariesGindex, DEEP_SUMMARIES);

        MessageFixtures.Named memory recentMessage = MessageFixtures.deliver();
        MessageFixtures.Named memory historicalMessage = MessageFixtures.order_a();
        MessageBridge.MessageProof memory recent = _recentProof(scene, 0, recentMessage);
        MessageBridge.MessageProof memory historical = _historicalProof(scene, 1, historicalMessage);
        assertEq(recent.ancestryBranch.length, 20);
        assertEq(historical.ancestryBranch.length, 46);
        target.executeMessage(recent);
        target.executeMessage(historical);
        assertTrue(target.messageCallStatus(recentMessage.messageId), "the recent message executes");
        assertTrue(target.messageCallStatus(historicalMessage.messageId), "the historical message executes");
        assertEq(recorder.callCount(), 2, "each message reaches its target once");
    }

    /// @dev Builds a scene whose bodies hold the block hash at `position`, and executes its message through that row.
    function _acceptBodyPosition(uint256 position) internal {
        SceneParams memory params = _defaultParams();
        params.anchorBodyGindex = position;
        params.blockHashGindex = position;
        MessageFixtures.Named memory named = MessageFixtures.deliver();
        Scene memory scene = _scene(named, params);

        assertEq(bridge.bodyLayouts().length, 1);
        assertEq(bridge.bodyLayouts()[0].blockHashGindex, position);
        assertEq(scene.proof.blockHashBranch.length, SSZ.depthOf(position));
        bridge.executeMessage(scene.proof);
        assertTrue(bridge.messageCallStatus(named.messageId), "the message executes");
        assertEq(recorder.callCount(), 1, "the target is called once");
    }

    /// Claim: a synthetic body of 32 leaves with a payload of 16 leaves (block hash at 668, branch of 9) is accepted
    /// and a message executes through it. Matters: the rule stays correct for a future body with more than 16 fields.
    function test_HB04_deepBlockHash668_acceptedForMatchingBody() public {
        _acceptBodyPosition(DEEP_BODY_FIVE_PAYLOAD_FOUR);
    }

    /// Claim: a synthetic body of 32 leaves with a payload of 32 leaves (block hash at 1324, branch of 10) is accepted
    /// and a message executes through it. Matters: same as above, with the deepest position that the rule allows.
    function test_HB04_deepBlockHash1324_acceptedForMatchingBody() public {
        _acceptBodyPosition(DEEP_BODY_FIVE_PAYLOAD_FIVE);
    }
}
