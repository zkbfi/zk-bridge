// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {MessageBridge} from "../../src/hardened/MessageBridge.sol";
import {BeaconProofVerifier} from "../../src/hardened/BeaconProofVerifier.sol";
import {MessageScenes} from "./utils/MessageScenes.sol";
import {MessageFixtures} from "./utils/MessageFixtures.sol";

/// @notice The two Gloas state positions: `block_roots` at 352 and `historical_summaries` at 2950. The Gloas `BeaconState`
/// is a progressive container, so a field has one fixed position and not `2**depth + index`. The numbers come from the
/// field list (`light-client/tests/fixtures/gindices.json`, key `gloas`, derived by `lc-core`). The rule takes exactly
/// these two numbers next to the depth rule: a neighbour is refused, the position of the other field is refused, and the
/// positions of today's layouts keep working. The messages of these tests have a source block before Gloas (block hash
/// position 812): a Gloas SOURCE block is refused by `GloasGuard.t.sol`.
contract GloasPositionsTest is MessageScenes {
    uint64 internal constant CAPELLA_ERA = 758;
    uint64 internal constant FIRST_STORED_SLOT = 6_000_000;
    uint64 internal constant ANCHOR = 6_400_000;
    uint64 internal constant EVIDENCE = 6_300_000;

    uint256 internal constant GLOAS_BLOCK_ROOTS = 352;
    uint256 internal constant GLOAS_SUMMARIES = 2950;

    function _gloasScene() internal returns (MessageBridge target, HistoricalParams memory params, HistoricalScene memory scene) {
        target = _historicalWorld(FIRST_STORED_SLOT, CAPELLA_ERA);
        params = _historicalParams(ANCHOR, CAPELLA_ERA, GLOAS_SUMMARIES, EVIDENCE, _slots(ANCHOR - 8192, ANCHOR - 8193));
        params.blockRootsGindex = GLOAS_BLOCK_ROOTS;
        scene = _historicalScene(params);
    }

    /// Claim: the fixture of `lc-core` names the two positions, and the contract takes them. Shows: the numbers of the
    /// fixture are 352 and 2950, with branch lengths 21 and 50. Matters: the contract constants and the derivation agree.
    function test_fixtureNamesTheGloasPositions() public view {
        string memory gindices = vm.readFile("light-client/tests/fixtures/gindices.json");
        assertEq(vm.parseJsonUint(gindices, ".gloas.blockRootsFieldGindex"), GLOAS_BLOCK_ROOTS);
        assertEq(vm.parseJsonUint(gindices, ".gloas.historicalSummariesFieldGindex"), GLOAS_SUMMARIES);
        assertEq(vm.parseJsonUint(gindices, ".gloas.blockRootsBranchLength"), 21);
        assertEq(vm.parseJsonUint(gindices, ".gloas.historicalAncestryBranchLength"), 50);
    }

    /// Claim: a Gloas anchor state with `block_roots` at 352 and `historical_summaries` at 2950 is accepted, and both proof
    /// paths work through it. Shows: both rows are added, the recent branch has 21 entries, the historical branch has 50,
    /// and both messages execute. Matters: a bridge that follows Sepolia after Gloas can prove sources from before the fork.
    function test_gloasStateRowsAreAcceptedAndBothPathsExecute() public {
        (MessageBridge target, HistoricalParams memory params, HistoricalScene memory scene) = _gloasScene();
        _addBodyRows(target, scene);
        _addRecentRow(target, params, scene);
        _addHistoricalRow(target, params, scene);
        assertEq(target.stateLayouts()[0].blockRootsGindex, GLOAS_BLOCK_ROOTS);
        assertEq(target.historicalLayouts()[0].historicalSummariesGindex, GLOAS_SUMMARIES);

        MessageFixtures.Named memory recentMessage = MessageFixtures.deliver();
        MessageFixtures.Named memory historicalMessage = MessageFixtures.order_a();
        MessageBridge.MessageProof memory recent = _recentProof(scene, 0, recentMessage);
        MessageBridge.MessageProof memory historical = _historicalProof(scene, 1, historicalMessage);
        assertEq(recent.ancestryBranch.length, 21);
        assertEq(historical.ancestryBranch.length, 50);
        target.executeMessage(recent);
        target.executeMessage(historical);
        assertTrue(target.messageCallStatus(recentMessage.messageId));
        assertTrue(target.messageCallStatus(historicalMessage.messageId));
    }

    /// Claim: the neighbours of the Gloas positions and the position of the other field are refused, even for evidence that
    /// matches 352 and 2950. Shows: 351 and 353 (depth 8) revert with `LayoutPositionInvalid` for `block_roots`; 2950 and
    /// 2947 are deeper than 8 and revert with `LayoutOutOfBounds` there. For `historical_summaries`, 352 reverts with
    /// `LayoutPositionInvalid`, and 2949 and 2951 (depth 11, not 2950) revert with `LayoutOutOfBounds`: the depth bound
    /// opens for the one number 2950 and for no other. Matters: the rule for an older fork is not looser.
    function test_neighboursAndTheOtherFieldAreRefused() public {
        (MessageBridge target,, HistoricalScene memory scene) = _gloasScene();
        uint256[2] memory invalid = [uint256(351), 353];
        for (uint256 i = 0; i < invalid.length; i++) {
            vm.expectRevert(abi.encodeWithSelector(BeaconProofVerifier.LayoutPositionInvalid.selector, invalid[i]));
            target.addBlockRootsLayout(invalid[i], scene.rootsEvidence);
        }
        uint256[2] memory tooDeep = [GLOAS_SUMMARIES, 2947];
        for (uint256 i = 0; i < tooDeep.length; i++) {
            vm.expectRevert(abi.encodeWithSelector(BeaconProofVerifier.LayoutOutOfBounds.selector, tooDeep[i]));
            target.addBlockRootsLayout(tooDeep[i], scene.rootsEvidence);
        }
        vm.expectRevert(abi.encodeWithSelector(BeaconProofVerifier.LayoutPositionInvalid.selector, GLOAS_BLOCK_ROOTS));
        target.addHistoricalSummariesLayout(GLOAS_BLOCK_ROOTS, scene.historicalEvidence);
        uint256[2] memory deepNeighbours = [uint256(2949), 2951];
        for (uint256 i = 0; i < deepNeighbours.length; i++) {
            vm.expectRevert(abi.encodeWithSelector(BeaconProofVerifier.LayoutOutOfBounds.selector, deepNeighbours[i]));
            target.addHistoricalSummariesLayout(deepNeighbours[i], scene.historicalEvidence);
        }
        assertEq(target.stateLayouts().length, 0);
        assertEq(target.historicalLayouts().length, 0);
    }
}
