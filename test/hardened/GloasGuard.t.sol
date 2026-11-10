// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {BeaconProofVerifier} from "../../src/hardened/BeaconProofVerifier.sol";
import {ForkShape} from "../../src/hardened/ForkShape.sol";
import {BeaconBlockHeader, SSZ} from "../../src/hardened/SSZ.sol";
import {MessageScenes} from "./utils/MessageScenes.sol";
import {MessageFixtures} from "./utils/MessageFixtures.sol";
import {ForkProofs} from "./utils/ForkProofs.sol";

/// @notice The Gloas guard of the body-layout path. From the Gloas fork on, the stored execution block hash of a slot is
/// `state.latest_block_hash` of the finalized state, which is an earlier payload, and the block body holds a bid and no
/// payload. So `addBlockHashLayout` refuses every header whose state the fork proof shows to be progressive. The bridge
/// holds no fork slot: the proof of each evidence header decides. A message source of that shape takes no layout and
/// reads the fixed bid index (`GloasSource.t.sol`).
contract GloasGuardTest is MessageScenes {
    /// @dev The position of `graffiti` in the progressive Gloas body (chunk 2 of the subtree of chunks 1 to 4), which the
    /// proposer fills with any 32 bytes.
    uint256 internal constant GLOAS_GRAFFITI = 41;

    /// Claim: a stored head whose state is progressive cannot validate a body-layout position, even with a branch that is
    /// valid for the position. Shows: `GloasSlotRefused(slot)` for the anchor of a scene whose state is progressive (its
    /// `block_roots` at 352). Control: the anchor of a plain scene (depth 6) is accepted with the same kind of evidence.
    /// Matters: a Gloas head holds `latest_block_hash`, and a body position that happens to lead to it must not become the
    /// layout of the slot.
    function test_blockHashLayoutIsRefusedForAGloasHead() public {
        SceneParams memory plain = _defaultParams();
        Scene memory plainScene = _buildScene(MessageFixtures.deliver(), plain, _messageHeaderRlp());
        _storeScene(plain, plainScene);
        SceneParams memory gloas = _defaultParams();
        gloas.blockRootsGindex = 352;
        Scene memory gloasScene = _buildScene(MessageFixtures.deliver(), gloas, _messageHeaderRlp());
        _storeScene(gloas, gloasScene);
        assertEq(gloasScene.anchorBodyEvidence.fork.versionBranch.length, 7, "the progressive version branch");

        vm.expectRevert(abi.encodeWithSelector(BeaconProofVerifier.GloasSlotRefused.selector, gloas.anchorSlot));
        bridge.addBlockHashLayout(gloas.anchorBodyGindex, gloasScene.anchorBodyEvidence);

        bridge.addBlockHashLayout(plain.anchorBodyGindex, plainScene.anchorBodyEvidence);
        assertEq(bridge.bodyLayouts().length, 1);
        assertEq(bridge.bodyLayouts()[0].lastSlot, plain.anchorSlot);
    }

    /// Claim: the attack that a fixed fork slot of "never" left open is closed. In a Gloas body, 668 = 41 * 16 + 4 lies four
    /// levels under `graffiti` (node 41), so a proposer can make the leaf at 668 equal the stored `latest_block_hash`.
    /// Shows: the branch to 668 is valid for the body root, and the bridge still refuses with `GloasSlotRefused`, because the
    /// state is proven progressive. A plain fork proof for the same state root fails with `ForkShapeProofInvalid`.
    /// Matters: a layout row at a Gloas slot would let the same proposer forge the block hash of any later Gloas block that
    /// the row covers.
    function test_aGraffitiPlacedHashCannotBecomeALayout() public {
        assertEq(uint256(668) >> 4, GLOAS_GRAFFITI, "668 lies under graffiti");
        uint64 slot = _defaultParams().anchorSlot;
        (BeaconBlockHeader memory header, bytes32[] memory branch) = _bodyEvidenceHeader(slot, 668);
        ForkProofs.ForkedState memory progressive = ForkProofs.state(ForkProofs.PROGRESSIVE, GENESIS_ROOT_A);
        header.stateRoot = progressive.root;
        assertTrue(SSZ.isValidBranchMemory(_execHash(slot), branch, 668, header.bodyRoot), "the branch itself is valid");
        _storeAnchor(slot, SSZ.hashTreeRootMemory(header));

        vm.expectRevert(abi.encodeWithSelector(BeaconProofVerifier.GloasSlotRefused.selector, slot));
        bridge.addBlockHashLayout(668, BeaconProofVerifier.BlockHashEvidence(header, branch, progressive.fork));

        // Built before `expectRevert`: the tree hashing calls the SHA-256 precompile, which would count as the next call.
        BeaconProofVerifier.BlockHashEvidence memory plainClaim = _hashEvidence(header, branch);
        vm.expectRevert(_shapeError(ForkShape.Verdict.VersionProofInvalid));
        bridge.addBlockHashLayout(668, plainClaim);
        assertEq(bridge.bodyLayouts().length, 0);
    }

    /// Claim: the evidence header must prove an allowed shape with the genesis validators root of the light client. Shows:
    /// a valid proof of a plain state of depth 8 (outside `ForkShape.allowedShapes`) reverts
    /// `ForkShapeProofInvalid(ShapeNotAllowed)`; a depth 6 state that holds the root of another chain reverts
    /// `ForkShapeProofInvalid(GenesisValidatorsRootProofInvalid)`; an empty proof reverts with `ShapeNotAllowed`.
    /// Matters: a fork that the gate seals on is never read, and a state of another chain never counts.
    function test_aShapeOutsideTheListOrAnotherChainIsRefused() public {
        uint64 slot = _defaultParams().anchorSlot;
        (BeaconBlockHeader memory header, bytes32[] memory branch) = _bodyEvidenceHeader(slot, 812);
        ForkProofs.ForkedState memory deep = ForkProofs.state(ForkProofs.DISALLOWED_DEPTH, GENESIS_ROOT_A);
        header.stateRoot = deep.root;
        _storeAnchor(slot, SSZ.hashTreeRootMemory(header));
        vm.expectRevert(_shapeError(ForkShape.Verdict.ShapeNotAllowed));
        bridge.addBlockHashLayout(812, BeaconProofVerifier.BlockHashEvidence(header, branch, deep.fork));

        uint64 other = _defaultParams().anchorSlot;
        (BeaconBlockHeader memory foreignHeader, bytes32[] memory foreignBranch) = _bodyEvidenceHeader(other, 812);
        ForkProofs.ForkedState memory foreign = ForkProofs.state(6, GENESIS_ROOT_B);
        foreignHeader.stateRoot = foreign.root;
        _storeAnchor(other, SSZ.hashTreeRootMemory(foreignHeader));
        vm.expectRevert(_shapeError(ForkShape.Verdict.GenesisValidatorsRootProofInvalid));
        bridge.addBlockHashLayout(812, BeaconProofVerifier.BlockHashEvidence(foreignHeader, foreignBranch, foreign.fork));

        BeaconProofVerifier.ForkProof memory empty;
        vm.expectRevert(_shapeError(ForkShape.Verdict.ShapeNotAllowed));
        bridge.addBlockHashLayout(812, BeaconProofVerifier.BlockHashEvidence(foreignHeader, foreignBranch, empty));
        assertEq(bridge.bodyLayouts().length, 0);
    }

    function _shapeError(ForkShape.Verdict verdict) internal pure returns (bytes memory) {
        return abi.encodeWithSelector(BeaconProofVerifier.ForkShapeProofInvalid.selector, uint8(verdict));
    }
}
