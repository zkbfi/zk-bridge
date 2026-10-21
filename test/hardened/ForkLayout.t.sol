// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {BridgeVault} from "../../src/hardened/BridgeVault.sol";
import {BeaconBlockHeader, SSZ} from "../../src/hardened/SSZ.sol";
import {WithdrawalScenes} from "./utils/WithdrawalScenes.sol";
import {ReceiptFixtures} from "./utils/ReceiptFixtures.sol";

/// @notice Tests of the permissionless, self-validating fork layout table. The light client's stored data must prove a
/// candidate position, or the call reverts. Positions of other fields of the same trees must never be accepted.
contract ForkLayoutTest is WithdrawalScenes {
    event BlockRootsLayoutValidated(uint256 indexed blockRootsGindex, uint64 firstSlot, uint64 lastSlot);
    event BlockHashLayoutValidated(uint256 indexed blockHashGindex, uint64 firstSlot, uint64 lastSlot);

    BridgeVault internal fresh;
    SceneParams internal params;
    Scene internal scene;

    function setUp() public override {
        super.setUp();
        // The scene is built and stored before the vault under test exists, so the vault starts with no layout.
        params = _defaultParams();
        scene = _scene(ReceiptFixtures.type2(), params);
        fresh = _newWithdrawalVault();
    }

    function _rootsEvidence() internal view returns (BridgeVault.BlockRootsEvidence memory) {
        return scene.rootsEvidence;
    }

    function _hashEvidence() internal view returns (BridgeVault.BlockHashEvidence memory) {
        return scene.anchorBodyEvidence;
    }

    // ================================================================ accepted

    /// Claim: the correct `block_roots` position is accepted from any caller. Shows: a random caller adds position 69
    /// with two stored earlier headers under the stored anchor state; the event and the table show the validated slot.
    /// Matters: no administrator is needed, and the stored data alone authorizes the row.
    function testFuzz_H19_correctBlockRootsLayoutAcceptedFromAnyCaller(address caller) public {
        vm.expectEmit(true, false, false, true, address(fresh));
        emit BlockRootsLayoutValidated(69, params.anchorSlot, params.anchorSlot);
        vm.prank(caller);
        fresh.addBlockRootsLayout(69, _rootsEvidence());
        BridgeVault.StateLayout[] memory layouts = fresh.stateLayouts();
        assertEq(layouts.length, 1);
        assertEq(layouts[0].blockRootsGindex, 69);
        assertEq(layouts[0].firstSlot, params.anchorSlot);
        assertEq(layouts[0].lastSlot, params.anchorSlot);
    }

    /// Claim: the correct block hash position is accepted from any caller. Shows: position 812 under a stored body
    /// root with the stored execution block hash. Matters: same as above.
    function testFuzz_H19_correctBlockHashLayoutAcceptedFromAnyCaller(address caller) public {
        vm.expectEmit(true, false, false, true, address(fresh));
        emit BlockHashLayoutValidated(812, params.anchorSlot, params.anchorSlot);
        vm.prank(caller);
        fresh.addBlockHashLayout(812, _hashEvidence());
        BridgeVault.BodyLayout[] memory layouts = fresh.bodyLayouts();
        assertEq(layouts.length, 1);
        assertEq(layouts[0].blockHashGindex, 812);
    }

    /// Claim: more evidence widens the validated range of the same position and adds no new row. Shows: evidence at
    /// three stored slots gives the range from the lowest to the highest, in any order. Matters: a deposit between two
    /// validated slots of one position is covered (layouts only grow in field count, so the position cannot change and
    /// change back in between).
    function test_H19_widenValidatedRange() public {
        fresh.addBlockHashLayout(812, _hashEvidence()); // at the anchor slot
        fresh.addBlockHashLayout(812, BridgeVault.BlockHashEvidence(scene.evidenceAfter, scene.evidenceAfterBranch));
        fresh.addBlockHashLayout(812, BridgeVault.BlockHashEvidence(scene.evidenceBefore, scene.evidenceBeforeBranch));
        BridgeVault.BodyLayout[] memory layouts = fresh.bodyLayouts();
        assertEq(layouts.length, 1);
        assertEq(layouts[0].firstSlot, params.depositSlot - 40);
        assertEq(layouts[0].lastSlot, params.anchorSlot);
    }

    // ================================================================ rejected: block roots

    /// Claim: a candidate that points at `finalized_checkpoint.root` (position 105 in the Electra state) is rejected.
    /// Shows: the leaf under position 105 is not the stored header root, so the call reverts; the right position works.
    /// Matters: a wrong position cannot match, so no field of the state can pass for `block_roots`.
    function test_H19_blockRootsLayoutAtFinalizedCheckpointRejected() public {
        vm.expectRevert(BridgeVault.LayoutEvidenceInvalid.selector);
        fresh.addBlockRootsLayout(105, _rootsEvidence());
        fresh.addBlockRootsLayout(69, _rootsEvidence());
    }

    /// Claim: a candidate that points at `state_roots` (position 70, the field after `block_roots`) is rejected.
    /// Shows: same depth, other path, so the root differs. Matters: state_roots holds roots of the same shape and is
    /// the most likely confusion.
    function test_H19_blockRootsLayoutAtStateRootsRejected() public {
        vm.expectRevert(BridgeVault.LayoutEvidenceInvalid.selector);
        fresh.addBlockRootsLayout(70, _rootsEvidence());
        fresh.addBlockRootsLayout(69, _rootsEvidence());
    }

    /// Claim: a candidate with the wrong depth is rejected with a length error. Shows: the Capella position 37 against
    /// evidence built for 69. Matters: a layout from another fork never validates.
    function test_H19_blockRootsLayoutOfAnotherForkRejected() public {
        vm.expectRevert(abi.encodeWithSelector(SSZ.BranchLengthMismatch.selector, uint256(18), uint256(19)));
        fresh.addBlockRootsLayout(37, _rootsEvidence());
        fresh.addBlockRootsLayout(69, _rootsEvidence());
    }

    /// Claim: zero and absurdly deep candidates are rejected before any check. Shows: 0 and 512 (depth 9) revert.
    /// Matters: a sane depth bound.
    function test_H19_blockRootsLayoutOutOfBoundsRejected() public {
        vm.expectRevert(abi.encodeWithSelector(BridgeVault.LayoutOutOfBounds.selector, uint256(0)));
        fresh.addBlockRootsLayout(0, _rootsEvidence());
        vm.expectRevert(abi.encodeWithSelector(BridgeVault.LayoutOutOfBounds.selector, uint256(512)));
        fresh.addBlockRootsLayout(512, _rootsEvidence());
    }

    /// Claim: an evidence slot with no stored header is rejected. Shows: a slot that the light client never stored
    /// reverts with its number. Matters: the check compares against stored data only (an unvalidated slot proves nothing).
    function test_H19_blockRootsLayoutWithUnstoredSlotRejected() public {
        BridgeVault.BlockRootsEvidence memory evidence = _rootsEvidence();
        evidence.earlierSlotA = evidence.earlierSlotA + 1; // not stored
        vm.expectRevert(abi.encodeWithSelector(BridgeVault.EvidenceSlotNotStored.selector, evidence.earlierSlotA));
        fresh.addBlockRootsLayout(69, evidence);
        fresh.addBlockRootsLayout(69, _rootsEvidence());
    }

    /// Claim: the two earlier slots must differ. Shows: using one slot twice reverts. Matters: one matching leaf could
    /// be a coincidence of one position; two different slots at two different leaf indices cannot both match by chance.
    function test_H19_blockRootsLayoutWithEqualSlotsRejected() public {
        BridgeVault.BlockRootsEvidence memory evidence = _rootsEvidence();
        evidence.earlierSlotB = evidence.earlierSlotA;
        evidence.branchB = evidence.branchA;
        vm.expectRevert(abi.encodeWithSelector(BridgeVault.EvidenceSlotsEqual.selector, evidence.earlierSlotA));
        fresh.addBlockRootsLayout(69, evidence);
    }

    /// Claim: earlier slots must lie before the later header and within 8192 slots of it. Shows: a slot equal to the
    /// later slot and one 8193 below revert. Matters: `block_roots` holds only the last 8192 roots.
    function test_H19_blockRootsLayoutWithSlotOutsideWindowRejected() public {
        BridgeVault.BlockRootsEvidence memory evidence = _rootsEvidence();
        evidence.earlierSlotA = params.anchorSlot;
        vm.expectRevert(abi.encodeWithSelector(BridgeVault.EvidenceSlotOutOfWindow.selector, params.anchorSlot, params.anchorSlot));
        fresh.addBlockRootsLayout(69, evidence);

        evidence = _rootsEvidence();
        evidence.earlierSlotA = params.anchorSlot - 8193;
        vm.expectRevert(abi.encodeWithSelector(BridgeVault.EvidenceSlotOutOfWindow.selector, params.anchorSlot - 8193, params.anchorSlot));
        fresh.addBlockRootsLayout(69, evidence);
    }

    /// Claim: the later header must be a stored header. Shows: a forged later header with a chosen state root reverts
    /// with `AnchorNotStored`. Matters: an attacker cannot choose the tree that validates the position.
    function test_H19_blockRootsLayoutWithForgedLaterHeaderRejected() public {
        BridgeVault.BlockRootsEvidence memory evidence = _rootsEvidence();
        evidence.laterHeader.stateRoot = keccak256("a state root the attacker chose");
        bytes32 root = SSZ.hashTreeRootMemory(evidence.laterHeader);
        vm.expectRevert(abi.encodeWithSelector(BridgeVault.AnchorNotStored.selector, params.anchorSlot, root));
        fresh.addBlockRootsLayout(69, evidence);
    }

    /// Claim: the branches must belong to their slots. Shows: swapped branches revert. Matters: each leaf is tied to
    /// its own position.
    function test_H19_blockRootsLayoutWithSwappedBranchesRejected() public {
        BridgeVault.BlockRootsEvidence memory evidence = _rootsEvidence();
        bytes32[] memory swap = evidence.branchA;
        evidence.branchA = evidence.branchB;
        evidence.branchB = swap;
        vm.expectRevert(BridgeVault.LayoutEvidenceInvalid.selector);
        fresh.addBlockRootsLayout(69, evidence);
    }

    // ================================================================ rejected: block hash

    /// Claim: a candidate that points at `parent_hash` (the first field of the payload, position 800 in Deneb and
    /// later) is rejected. Shows: the leaf there is not the stored execution block hash. Matters: only the block hash
    /// field can pass for the block hash field.
    function test_H19_blockHashLayoutAtParentHashRejected() public {
        vm.expectRevert(BridgeVault.LayoutEvidenceInvalid.selector);
        fresh.addBlockHashLayout(800, _hashEvidence());
        fresh.addBlockHashLayout(812, _hashEvidence());
    }

    /// Claim: the neighbours of the block hash field (state_root 802, receipts_root 803, prev_randao 805, block_number
    /// 806) are rejected. Shows: reverts for each. Matters: no other payload field can pass.
    function test_H19_blockHashLayoutAtNeighbouringFieldsRejected() public {
        uint256[5] memory wrong = [uint256(802), 803, 805, 806, 813];
        for (uint256 i = 0; i < wrong.length; i++) {
            vm.expectRevert(BridgeVault.LayoutEvidenceInvalid.selector);
            fresh.addBlockHashLayout(wrong[i], _hashEvidence());
        }
        fresh.addBlockHashLayout(812, _hashEvidence());
    }

    /// Claim: a position of another fork (Capella 412, depth 8) does not validate evidence of depth 9. Shows: a length
    /// error. Matters: the old layout cannot be added for slots of the new fork.
    function test_H19_blockHashLayoutOfAnotherForkRejected() public {
        vm.expectRevert(abi.encodeWithSelector(SSZ.BranchLengthMismatch.selector, uint256(8), uint256(9)));
        fresh.addBlockHashLayout(412, _hashEvidence());
    }

    /// Claim: zero and absurdly deep candidates are rejected. Shows: 0 and 2^17 revert. Matters: a sane depth bound.
    function test_H19_blockHashLayoutOutOfBoundsRejected() public {
        vm.expectRevert(abi.encodeWithSelector(BridgeVault.LayoutOutOfBounds.selector, uint256(0)));
        fresh.addBlockHashLayout(0, _hashEvidence());
        vm.expectRevert(abi.encodeWithSelector(BridgeVault.LayoutOutOfBounds.selector, uint256(1) << 17));
        fresh.addBlockHashLayout(1 << 17, _hashEvidence());
    }

    /// Claim: the header must be stored. Shows: a forged header (a body root of the attacker's choice) reverts, and a
    /// header at an unstored slot reverts. Matters: an unvalidated slot proves nothing.
    function test_H19_blockHashLayoutWithUnstoredHeaderRejected() public {
        BridgeVault.BlockHashEvidence memory forged = _hashEvidence();
        forged.header.bodyRoot = keccak256("a body root the attacker chose");
        bytes32 root = SSZ.hashTreeRootMemory(forged.header);
        vm.expectRevert(abi.encodeWithSelector(BridgeVault.AnchorNotStored.selector, params.anchorSlot, root));
        fresh.addBlockHashLayout(812, forged);

        BridgeVault.BlockHashEvidence memory elsewhere = _hashEvidence();
        elsewhere.header.slot = params.anchorSlot + 1;
        bytes32 elsewhereRoot = SSZ.hashTreeRootMemory(elsewhere.header);
        vm.expectRevert(abi.encodeWithSelector(BridgeVault.AnchorNotStored.selector, params.anchorSlot + 1, elsewhereRoot));
        fresh.addBlockHashLayout(812, elsewhere);
    }

    /// Claim: the branch must belong to the stored header. Shows: the branch of another header reverts. Matters: the
    /// proven leaf is the stored block hash of THIS header.
    function test_H19_blockHashLayoutWithForeignBranchRejected() public {
        BridgeVault.BlockHashEvidence memory evidence = _hashEvidence();
        evidence.branch = scene.evidenceAfterBranch;
        vm.expectRevert(BridgeVault.LayoutEvidenceInvalid.selector);
        fresh.addBlockHashLayout(812, evidence);
    }
}
