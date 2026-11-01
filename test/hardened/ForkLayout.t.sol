// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {BeaconLightClient} from "../../src/hardened/BeaconLightClient.sol";
import {MessageBridge} from "../../src/hardened/MessageBridge.sol";
import {BeaconProofVerifier} from "../../src/hardened/BeaconProofVerifier.sol";
import {BeaconBlockHeader, SSZ} from "../../src/hardened/SSZ.sol";
import {MessageScenes} from "./utils/MessageScenes.sol";
import {MessageFixtures} from "./utils/MessageFixtures.sol";

/// @notice Tests of the permissionless, self-validating fork layout table. The light client's stored data must prove a
/// candidate position, or the call reverts. Positions of other fields of the same trees must never be accepted.
contract ForkLayoutTest is MessageScenes {
    event BlockRootsLayoutValidated(uint256 indexed blockRootsGindex, uint64 firstSlot, uint64 lastSlot);
    event BlockHashLayoutValidated(uint256 indexed blockHashGindex, uint64 firstSlot, uint64 lastSlot);
    event HistoricalSummariesLayoutValidated(uint256 indexed historicalSummariesGindex, uint64 firstSlot, uint64 lastSlot);

    /// @dev The historical fixture: an Electra-like state (position 91) of an anchor at slot 1,000,000, a stored evidence
    /// slot 100,000 below it, and three extra stored slots. The default bridge has capellaEra 0.
    uint64 internal constant HISTORICAL_ANCHOR = 1_000_000;
    uint64 internal constant HISTORICAL_EVIDENCE = 900_000;
    uint256 internal constant SUMMARIES = 91;

    MessageBridge internal fresh;
    SceneParams internal params;
    Scene internal scene;

    function setUp() public override {
        super.setUp();
        // The scene is built and stored, but no layout is added: the bridge under test starts with no layout.
        params = _defaultParams();
        scene = _buildScene(MessageFixtures.deliver(), params, _messageHeaderRlp());
        _storeScene(params, scene);
        fresh = bridge;
    }

    function _rootsEvidence() internal view returns (BeaconProofVerifier.BlockRootsEvidence memory) {
        return scene.rootsEvidence;
    }

    function _hashEvidence() internal view returns (BeaconProofVerifier.BlockHashEvidence memory) {
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
        BeaconProofVerifier.StateLayout[] memory layouts = fresh.stateLayouts();
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
        BeaconProofVerifier.BodyLayout[] memory layouts = fresh.bodyLayouts();
        assertEq(layouts.length, 1);
        assertEq(layouts[0].blockHashGindex, 812);
    }

    /// Claim: more evidence widens the validated range of the same position and adds no new row. Shows: evidence at
    /// three stored slots gives the range from the lowest to the highest, in any order. Matters: a deposit between two
    /// validated slots of one position is covered (layouts only grow in field count, so the position cannot change and
    /// change back in between).
    function test_H19_widenValidatedRange() public {
        fresh.addBlockHashLayout(812, _hashEvidence()); // at the anchor slot
        fresh.addBlockHashLayout(812, BeaconProofVerifier.BlockHashEvidence(scene.evidenceAfter, scene.evidenceAfterBranch));
        fresh.addBlockHashLayout(812, BeaconProofVerifier.BlockHashEvidence(scene.evidenceBefore, scene.evidenceBeforeBranch));
        BeaconProofVerifier.BodyLayout[] memory layouts = fresh.bodyLayouts();
        assertEq(layouts.length, 1);
        assertEq(layouts[0].firstSlot, params.depositSlot - 40);
        assertEq(layouts[0].lastSlot, params.anchorSlot);
    }

    /// Claim: evidence at an earlier anchor than the validated range widens the range downward. Shows: position 69 is
    /// validated at the later of two stored anchors, then at the earlier one. The event and the table then show the
    /// earlier slot as the first slot and the later slot as the last slot. Matters: a message at the earlier anchor
    /// needs the layout, and the range may only grow from stored evidence.
    function test_H19_widenBlockRootsRangeDownward() public {
        SceneParams memory laterParams = _defaultParams();
        Scene memory later = _buildScene(MessageFixtures.deliver(), laterParams, _messageHeaderRlp());
        _storeScene(laterParams, later);
        assertGt(laterParams.anchorSlot, params.anchorSlot, "the second scene is the later one");

        fresh.addBlockRootsLayout(69, later.rootsEvidence);
        vm.expectEmit(true, false, false, true, address(fresh));
        emit BlockRootsLayoutValidated(69, params.anchorSlot, laterParams.anchorSlot);
        fresh.addBlockRootsLayout(69, _rootsEvidence());
        BeaconProofVerifier.StateLayout[] memory layouts = fresh.stateLayouts();
        assertEq(layouts.length, 1, "the same position widens and adds no row");
        assertEq(layouts[0].firstSlot, params.anchorSlot);
        assertEq(layouts[0].lastSlot, laterParams.anchorSlot);
    }

    // ================================================================ rejected: block roots

    /// Claim: a candidate that points at `finalized_checkpoint.root` (position 105 in the Electra state) is rejected.
    /// Shows: position 105 is not the `block_roots` field, so the call reverts with `LayoutPositionInvalid`; the right
    /// position works. Matters: no other field of the state can pass for `block_roots`.
    function test_H19_blockRootsLayoutAtFinalizedCheckpointRejected() public {
        vm.expectRevert(abi.encodeWithSelector(BeaconProofVerifier.LayoutPositionInvalid.selector, uint256(105)));
        fresh.addBlockRootsLayout(105, _rootsEvidence());
        fresh.addBlockRootsLayout(69, _rootsEvidence());
    }

    /// Claim: a candidate that points at `state_roots` (position 70, the field after `block_roots`) is rejected.
    /// Shows: same depth, other field, so the position check refuses it. Matters: state_roots holds roots of the same
    /// shape and is the most likely confusion.
    function test_H19_blockRootsLayoutAtStateRootsRejected() public {
        vm.expectRevert(abi.encodeWithSelector(BeaconProofVerifier.LayoutPositionInvalid.selector, uint256(70)));
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
        vm.expectRevert(abi.encodeWithSelector(BeaconProofVerifier.LayoutOutOfBounds.selector, uint256(0)));
        fresh.addBlockRootsLayout(0, _rootsEvidence());
        vm.expectRevert(abi.encodeWithSelector(BeaconProofVerifier.LayoutOutOfBounds.selector, uint256(512)));
        fresh.addBlockRootsLayout(512, _rootsEvidence());
    }

    /// Claim: an evidence slot with no stored header is rejected. Shows: a slot that the light client never stored
    /// reverts with its number. Matters: the check compares against stored data only (an unvalidated slot proves nothing).
    function test_H19_blockRootsLayoutWithUnstoredSlotRejected() public {
        BeaconProofVerifier.BlockRootsEvidence memory evidence = _rootsEvidence();
        evidence.earlierSlotA = evidence.earlierSlotA + 1; // not stored
        vm.expectRevert(abi.encodeWithSelector(BeaconProofVerifier.EvidenceSlotNotStored.selector, evidence.earlierSlotA));
        fresh.addBlockRootsLayout(69, evidence);
        fresh.addBlockRootsLayout(69, _rootsEvidence());
    }

    /// Claim: the two earlier slots must differ. Shows: using one slot twice reverts. Matters: one matching leaf could
    /// be a coincidence of one position; two different slots at two different leaf indices cannot both match by chance.
    function test_H19_blockRootsLayoutWithEqualSlotsRejected() public {
        BeaconProofVerifier.BlockRootsEvidence memory evidence = _rootsEvidence();
        evidence.earlierSlotB = evidence.earlierSlotA;
        evidence.branchB = evidence.branchA;
        vm.expectRevert(abi.encodeWithSelector(BeaconProofVerifier.EvidenceSlotsEqual.selector, evidence.earlierSlotA));
        fresh.addBlockRootsLayout(69, evidence);
    }

    /// Claim: earlier slots must lie before the later header and within 8192 slots of it. Shows: a slot equal to the
    /// later slot and one 8193 below revert. Matters: `block_roots` holds only the last 8192 roots.
    function test_H19_blockRootsLayoutWithSlotOutsideWindowRejected() public {
        BeaconProofVerifier.BlockRootsEvidence memory evidence = _rootsEvidence();
        evidence.earlierSlotA = params.anchorSlot;
        vm.expectRevert(abi.encodeWithSelector(BeaconProofVerifier.EvidenceSlotOutOfWindow.selector, params.anchorSlot, params.anchorSlot));
        fresh.addBlockRootsLayout(69, evidence);

        evidence = _rootsEvidence();
        evidence.earlierSlotA = params.anchorSlot - 8193;
        vm.expectRevert(abi.encodeWithSelector(BeaconProofVerifier.EvidenceSlotOutOfWindow.selector, params.anchorSlot - 8193, params.anchorSlot));
        fresh.addBlockRootsLayout(69, evidence);
    }

    /// Claim: the later header must be a stored header. Shows: a forged later header with a chosen state root reverts
    /// with `AnchorNotStored`. Matters: an attacker cannot choose the tree that validates the position.
    function test_H19_blockRootsLayoutWithForgedLaterHeaderRejected() public {
        BeaconProofVerifier.BlockRootsEvidence memory evidence = _rootsEvidence();
        evidence.laterHeader.stateRoot = keccak256("a state root the attacker chose");
        bytes32 root = SSZ.hashTreeRootMemory(evidence.laterHeader);
        vm.expectRevert(abi.encodeWithSelector(BeaconProofVerifier.AnchorNotStored.selector, params.anchorSlot, root));
        fresh.addBlockRootsLayout(69, evidence);
    }

    /// Claim: the branches must belong to their slots. Shows: swapped branches revert. Matters: each leaf is tied to
    /// its own position.
    function test_H19_blockRootsLayoutWithSwappedBranchesRejected() public {
        BeaconProofVerifier.BlockRootsEvidence memory evidence = _rootsEvidence();
        bytes32[] memory swap = evidence.branchA;
        evidence.branchA = evidence.branchB;
        evidence.branchB = swap;
        vm.expectRevert(BeaconProofVerifier.LayoutEvidenceInvalid.selector);
        fresh.addBlockRootsLayout(69, evidence);
    }

    // ================================================================ rejected: block hash

    /// Claim: a candidate that points at `parent_hash` (the first field of the payload, position 800 in Deneb and
    /// later) is rejected. Shows: the leaf there is not the stored execution block hash. Matters: only the block hash
    /// field can pass for the block hash field.
    function test_H19_blockHashLayoutAtParentHashRejected() public {
        vm.expectRevert(abi.encodeWithSelector(BeaconProofVerifier.LayoutPositionInvalid.selector, uint256(800)));
        fresh.addBlockHashLayout(800, _hashEvidence());
        fresh.addBlockHashLayout(812, _hashEvidence());
    }

    /// Claim: the neighbours of the block hash field (state_root 802, receipts_root 803, prev_randao 805, block_number
    /// 806) are rejected. Shows: reverts for each. Matters: no other payload field can pass.
    function test_H19_blockHashLayoutAtNeighbouringFieldsRejected() public {
        uint256[5] memory wrong = [uint256(802), 803, 805, 806, 813];
        for (uint256 i = 0; i < wrong.length; i++) {
            vm.expectRevert(abi.encodeWithSelector(BeaconProofVerifier.LayoutPositionInvalid.selector, wrong[i]));
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
        vm.expectRevert(abi.encodeWithSelector(BeaconProofVerifier.LayoutOutOfBounds.selector, uint256(0)));
        fresh.addBlockHashLayout(0, _hashEvidence());
        vm.expectRevert(abi.encodeWithSelector(BeaconProofVerifier.LayoutOutOfBounds.selector, uint256(1) << 17));
        fresh.addBlockHashLayout(1 << 17, _hashEvidence());
    }

    /// Claim: the header must be stored. Shows: a forged header (a body root of the attacker's choice) reverts, and a
    /// header at an unstored slot reverts. Matters: an unvalidated slot proves nothing.
    function test_H19_blockHashLayoutWithUnstoredHeaderRejected() public {
        BeaconProofVerifier.BlockHashEvidence memory forged = _hashEvidence();
        forged.header.bodyRoot = keccak256("a body root the attacker chose");
        bytes32 root = SSZ.hashTreeRootMemory(forged.header);
        vm.expectRevert(abi.encodeWithSelector(BeaconProofVerifier.AnchorNotStored.selector, params.anchorSlot, root));
        fresh.addBlockHashLayout(812, forged);

        BeaconProofVerifier.BlockHashEvidence memory elsewhere = _hashEvidence();
        elsewhere.header.slot = params.anchorSlot + 1;
        bytes32 elsewhereRoot = SSZ.hashTreeRootMemory(elsewhere.header);
        vm.expectRevert(abi.encodeWithSelector(BeaconProofVerifier.AnchorNotStored.selector, params.anchorSlot + 1, elsewhereRoot));
        fresh.addBlockHashLayout(812, elsewhere);
    }

    /// Claim: the checkpoint header of a light client cannot validate a block hash position. Shows: the constructor of
    /// the light client stores the header root of its checkpoint and no execution block hash, so the call reverts with
    /// `EvidenceSlotNotStored` and the slot, and the table stays empty. Matters: the check compares against the stored
    /// execution block hash, and zero must never stand for a block hash.
    function test_H19_blockHashLayoutAtTheCheckpointSlotRejected() public {
        BeaconBlockHeader memory checkpoint = BeaconBlockHeader({
            slot: INITIAL_SLOT,
            proposerIndex: 1,
            parentRoot: keccak256("checkpoint parent"),
            stateRoot: keccak256("checkpoint state"),
            bodyRoot: keccak256("checkpoint body")
        });
        BeaconLightClient client = new BeaconLightClient(
            address(verifier),
            LIGHT_CLIENT_VKEY,
            GENESIS_ROOT_A,
            SLOTS_PER_PERIOD,
            LIGHT_CLIENT_GENESIS_TIME,
            LIGHT_CLIENT_SECONDS_PER_SLOT,
            INITIAL_SLOT,
            SSZ.hashTreeRootMemory(checkpoint),
            COMMITTEE_100,
            COMMITTEE_101
        );
        assertEq(client.executionBlockHashes(INITIAL_SLOT), bytes32(0), "the checkpoint has no execution block hash");
        MessageBridge atCheckpoint = _deployDestinationBridge(client, 0, DEFAULT_CAPELLA_ERA, address(gateB));

        BeaconProofVerifier.BlockHashEvidence memory evidence = _hashEvidence();
        evidence.header = checkpoint;
        vm.expectRevert(abi.encodeWithSelector(BeaconProofVerifier.EvidenceSlotNotStored.selector, INITIAL_SLOT));
        atCheckpoint.addBlockHashLayout(812, evidence);
        assertEq(atCheckpoint.bodyLayouts().length, 0, "nothing was validated");
    }

    /// Claim: the branch must belong to the stored header. Shows: the branch of another header reverts. Matters: the
    /// proven leaf is the stored block hash of THIS header.
    function test_H19_blockHashLayoutWithForeignBranchRejected() public {
        BeaconProofVerifier.BlockHashEvidence memory evidence = _hashEvidence();
        evidence.branch = scene.evidenceAfterBranch;
        vm.expectRevert(BeaconProofVerifier.LayoutEvidenceInvalid.selector);
        fresh.addBlockHashLayout(812, evidence);
    }

    // ================================================================ historical summaries: accepted

    /// @dev A deep copy, because memory structs are references and a test edits the evidence.
    function _copy(BeaconProofVerifier.HistoricalSummariesEvidence memory evidence)
        internal
        pure
        returns (BeaconProofVerifier.HistoricalSummariesEvidence memory)
    {
        return abi.decode(abi.encode(evidence), (BeaconProofVerifier.HistoricalSummariesEvidence));
    }

    function _historicalFixture() internal returns (HistoricalParams memory fixtureParams, HistoricalScene memory historical) {
        fixtureParams = _historicalParams(HISTORICAL_ANCHOR, 0, SUMMARIES, HISTORICAL_EVIDENCE, _noSlots());
        // One slot at distance 8193 (historical), one at 8192 (recent), one after the anchor.
        fixtureParams.extraStoredSlots = _slots(HISTORICAL_ANCHOR - 8193, HISTORICAL_ANCHOR - 8192, HISTORICAL_ANCHOR + 64);
        historical = _historicalScene(fixtureParams);
    }

    /// Claim: the correct `historical_summaries` position is accepted from any caller. Shows: a random caller adds
    /// position 91 with a stored earlier header under the stored anchor state; the event and the table show the anchor slot.
    /// Matters: no administrator is needed, and the stored data alone authorizes the row.
    /// forge-config: default.fuzz.runs = 16
    function testFuzz_HB01_historicalLayoutAcceptedFromAnyCaller(address caller) public {
        (, HistoricalScene memory historical) = _historicalFixture();
        vm.expectEmit(true, false, false, true, address(fresh));
        emit HistoricalSummariesLayoutValidated(SUMMARIES, HISTORICAL_ANCHOR, HISTORICAL_ANCHOR);
        vm.prank(caller);
        fresh.addHistoricalSummariesLayout(SUMMARIES, historical.historicalEvidence);
        BeaconProofVerifier.HistoricalLayout[] memory rows = fresh.historicalLayouts();
        assertEq(rows.length, 1);
        assertEq(rows[0].historicalSummariesGindex, SUMMARIES);
        assertEq(rows[0].firstSlot, HISTORICAL_ANCHOR);
        assertEq(rows[0].lastSlot, HISTORICAL_ANCHOR);
    }

    /// Claim: more evidence widens the validated anchor range of the same position and adds no new row. Shows: evidence at
    /// a later anchor, then at the earlier one, gives the range from the lowest to the highest anchor slot in one row.
    /// Matters: a deposit under any anchor between two validated anchors is covered.
    function test_HB01_historicalLayoutWidensValidatedRange() public {
        (, HistoricalScene memory first) = _historicalFixture();
        HistoricalParams memory laterParams = _historicalParams(1_200_000, 0, SUMMARIES, 1_100_000, _noSlots());
        HistoricalScene memory later = _historicalScene(laterParams);
        fresh.addHistoricalSummariesLayout(SUMMARIES, later.historicalEvidence);
        fresh.addHistoricalSummariesLayout(SUMMARIES, first.historicalEvidence);
        BeaconProofVerifier.HistoricalLayout[] memory rows = fresh.historicalLayouts();
        assertEq(rows.length, 1);
        assertEq(rows[0].firstSlot, HISTORICAL_ANCHOR);
        assertEq(rows[0].lastSlot, 1_200_000);
    }

    /// Claim: the boundary of the evidence distance is exact. Shows: an earlier slot 8193 below the anchor is accepted
    /// (the era of the slot is complete). Matters: this is the control of the distance tests below.
    function test_HB01_historicalLayoutAcceptedAtDistance8193() public {
        (, HistoricalScene memory historical) = _historicalFixture();
        BeaconProofVerifier.HistoricalSummariesEvidence memory evidence = _copy(historical.historicalEvidence);
        evidence.earlierSlot = HISTORICAL_ANCHOR - 8193;
        evidence.branch = historical.extraBranches[0];
        fresh.addHistoricalSummariesLayout(SUMMARIES, evidence);
        assertEq(fresh.historicalLayouts().length, 1);
    }

    // ================================================================ historical summaries: rejected

    /// Claim: zero and absurdly deep candidates are rejected before any check. Shows: 0, 512 (depth 9) and 2^20 revert
    /// with `LayoutOutOfBounds`; the honest candidate is accepted. Matters: a sane depth bound.
    function test_HB01_historicalLayoutOutOfBoundsRejected() public {
        (, HistoricalScene memory historical) = _historicalFixture();
        uint256[3] memory bad = [uint256(0), 512, uint256(1) << 20];
        for (uint256 i = 0; i < bad.length; i++) {
            vm.expectRevert(abi.encodeWithSelector(BeaconProofVerifier.LayoutOutOfBounds.selector, bad[i]));
            fresh.addHistoricalSummariesLayout(bad[i], historical.historicalEvidence);
        }
        fresh.addHistoricalSummariesLayout(SUMMARIES, historical.historicalEvidence);
    }

    /// Claim: an earlier slot with no stored header is rejected. Shows: the slot after the evidence slot reverts with
    /// `EvidenceSlotNotStored`. Matters: the check compares against stored data only.
    function test_HB01_historicalLayoutWithUnstoredEarlierSlotRejected() public {
        (, HistoricalScene memory historical) = _historicalFixture();
        BeaconProofVerifier.HistoricalSummariesEvidence memory evidence = _copy(historical.historicalEvidence);
        evidence.earlierSlot = HISTORICAL_EVIDENCE + 1;
        vm.expectRevert(abi.encodeWithSelector(BeaconProofVerifier.EvidenceSlotNotStored.selector, HISTORICAL_EVIDENCE + 1));
        fresh.addHistoricalSummariesLayout(SUMMARIES, evidence);
        fresh.addHistoricalSummariesLayout(SUMMARIES, historical.historicalEvidence);
    }

    /// Claim: an earlier slot within 8192 of the anchor, equal to it, or after it is rejected. Shows: stored slots at
    /// distance 8192, at distance 0 and 64 after the anchor revert with `EvidenceSlotNotHistorical`, even though the first
    /// has a valid branch. The control at distance 8193 is accepted. Matters: those slots belong to `block_roots`, which
    /// holds the ring, so they cannot prove the historical position.
    function test_HB01_historicalLayoutWithRecentEarlierSlotRejected() public {
        (, HistoricalScene memory historical) = _historicalFixture();
        BeaconProofVerifier.HistoricalSummariesEvidence memory near = _copy(historical.historicalEvidence);
        near.earlierSlot = HISTORICAL_ANCHOR - 8192;
        near.branch = historical.extraBranches[1];
        vm.expectRevert(
            abi.encodeWithSelector(
                BeaconProofVerifier.EvidenceSlotNotHistorical.selector, HISTORICAL_ANCHOR - 8192, HISTORICAL_ANCHOR
            )
        );
        fresh.addHistoricalSummariesLayout(SUMMARIES, near);

        BeaconProofVerifier.HistoricalSummariesEvidence memory equal = _copy(historical.historicalEvidence);
        equal.earlierSlot = HISTORICAL_ANCHOR;
        vm.expectRevert(
            abi.encodeWithSelector(BeaconProofVerifier.EvidenceSlotNotHistorical.selector, HISTORICAL_ANCHOR, HISTORICAL_ANCHOR)
        );
        fresh.addHistoricalSummariesLayout(SUMMARIES, equal);

        BeaconProofVerifier.HistoricalSummariesEvidence memory after_ = _copy(historical.historicalEvidence);
        after_.earlierSlot = HISTORICAL_ANCHOR + 64;
        vm.expectRevert(
            abi.encodeWithSelector(
                BeaconProofVerifier.EvidenceSlotNotHistorical.selector, HISTORICAL_ANCHOR + 64, HISTORICAL_ANCHOR
            )
        );
        fresh.addHistoricalSummariesLayout(SUMMARIES, after_);

        BeaconProofVerifier.HistoricalSummariesEvidence memory boundary = _copy(historical.historicalEvidence);
        boundary.earlierSlot = HISTORICAL_ANCHOR - 8193;
        boundary.branch = historical.extraBranches[0];
        fresh.addHistoricalSummariesLayout(SUMMARIES, boundary);
    }

    /// Claim: the anchor must be a stored header. Shows: a forged anchor (a state root of the attacker's choice) reverts
    /// with `AnchorNotStored`. The honest anchor is accepted. Matters: an attacker cannot choose the tree.
    function test_HB01_historicalLayoutWithForgedAnchorRejected() public {
        (, HistoricalScene memory historical) = _historicalFixture();
        BeaconProofVerifier.HistoricalSummariesEvidence memory evidence = _copy(historical.historicalEvidence);
        evidence.anchorHeader.stateRoot = keccak256("a state root the attacker chose");
        bytes32 root = SSZ.hashTreeRootMemory(evidence.anchorHeader);
        vm.expectRevert(abi.encodeWithSelector(BeaconProofVerifier.AnchorNotStored.selector, HISTORICAL_ANCHOR, root));
        fresh.addHistoricalSummariesLayout(SUMMARIES, evidence);
        fresh.addHistoricalSummariesLayout(SUMMARIES, historical.historicalEvidence);
    }

    /// Claim: the branch must belong to the earlier slot. Shows: the branch of another stored slot, and a branch with a
    /// changed sibling, revert with `LayoutEvidenceInvalid`. The honest branch is accepted. Matters: the leaf is tied to
    /// its own era index and its own slot offset.
    function test_HB01_historicalLayoutWithForeignBranchRejected() public {
        (, HistoricalScene memory historical) = _historicalFixture();
        BeaconProofVerifier.HistoricalSummariesEvidence memory foreign = _copy(historical.historicalEvidence);
        foreign.branch = historical.extraBranches[0];
        vm.expectRevert(BeaconProofVerifier.LayoutEvidenceInvalid.selector);
        fresh.addHistoricalSummariesLayout(SUMMARIES, foreign);

        BeaconProofVerifier.HistoricalSummariesEvidence memory tampered = _copy(historical.historicalEvidence);
        tampered.branch = _concat(_slice(tampered.branch, 0, 20), _concat(_repeat(keccak256("x"), 1), _slice(tampered.branch, 21, 45)));
        vm.expectRevert(BeaconProofVerifier.LayoutEvidenceInvalid.selector);
        fresh.addHistoricalSummariesLayout(SUMMARIES, tampered);
        fresh.addHistoricalSummariesLayout(SUMMARIES, historical.historicalEvidence);
    }

    /// Claim: an earlier slot in an era before `capellaEra` is rejected. Shows: the evidence slot is in era 109; a bridge
    /// with capellaEra 110 reverts with `DepositBeforeCapellaEra(109, 110)`. The bridge with capellaEra 0 accepts the same
    /// evidence. Matters: no summary exists before Capella, and the index would underflow.
    function test_HB01_historicalLayoutWithEraBeforeCapellaRejected() public {
        (, HistoricalScene memory historical) = _historicalFixture();
        MessageBridge late = new MessageBridge(
            address(lightClientForB),
            CHAIN_A,
            MessageFixtures.REMOTE_BRIDGE,
            MessageBridge.BridgeTerms(0, address(lightClientForA), type(uint64).max),
            110,
            address(gateB)
        );
        vm.expectRevert(abi.encodeWithSelector(BeaconProofVerifier.DepositBeforeCapellaEra.selector, uint64(109), uint64(110)));
        late.addHistoricalSummariesLayout(SUMMARIES, historical.historicalEvidence);
        fresh.addHistoricalSummariesLayout(SUMMARIES, historical.historicalEvidence);
    }

    // ================================================================ historical summaries: other fields that hold block roots

    /// @dev A bad anchor: a stored header whose state really holds the stored header root of the evidence slot at
    /// `leafGindex` (and a stand-in in every other field). Returns the evidence with the real branch of that leaf.
    function _anchorHoldingRootAt(uint64 anchorSlot, uint256 leafGindex)
        internal
        returns (BeaconProofVerifier.HistoricalSummariesEvidence memory evidence)
    {
        bytes32 storedRoot = lightClientForB.headers(HISTORICAL_EVIDENCE);
        assertTrue(storedRoot != bytes32(0), "the evidence slot is stored");
        (bytes32 stateRoot, bytes32[] memory branch) = _stateWithLeaf(leafGindex, storedRoot);
        BeaconBlockHeader memory anchor = BeaconBlockHeader({
            slot: anchorSlot,
            proposerIndex: 9,
            parentRoot: keccak256(abi.encode("bad anchor parent", anchorSlot)),
            stateRoot: stateRoot,
            bodyRoot: keccak256(abi.encode("bad anchor body", anchorSlot))
        });
        _storeAnchor(anchorSlot, SSZ.hashTreeRootMemory(anchor));
        evidence = BeaconProofVerifier.HistoricalSummariesEvidence({anchorHeader: anchor, earlierSlot: HISTORICAL_EVIDENCE, branch: branch});
    }

    /// Claim: a candidate that is `state.block_roots` (field 5, position 69) is refused although the state really holds
    /// the stored header root there, at index `earlierSlot % 8192`. Shows: position 69 is not the `historical_summaries`
    /// field, so the call reverts with `LayoutPositionInvalid(69)`; the honest anchor is accepted. Matters: a field
    /// that holds the same root cannot pass as `historical_summaries`.
    function test_HB01_historicalLayoutAtBlockRootsFieldRejected() public {
        _historicalFixture();
        uint256 leaf = 69 * 8192 + (HISTORICAL_EVIDENCE % 8192);
        BeaconProofVerifier.HistoricalSummariesEvidence memory bad = _anchorHoldingRootAt(1_100_000, leaf);
        assertEq(bad.branch.length, 19);
        vm.expectRevert(abi.encodeWithSelector(BeaconProofVerifier.LayoutPositionInvalid.selector, uint256(69)));
        fresh.addHistoricalSummariesLayout(69, bad);

        (, HistoricalScene memory honest) = _honestAfterBad();
        fresh.addHistoricalSummariesLayout(SUMMARIES, honest.historicalEvidence);
        assertEq(fresh.historicalLayouts().length, 1);
        assertEq(fresh.historicalLayouts()[0].historicalSummariesGindex, SUMMARIES);
    }

    /// @dev The honest control: the fixture's own anchor (stored before the bad anchors).
    function _honestAfterBad() internal pure returns (HistoricalParams memory fixtureParams, HistoricalScene memory historical) {
        fixtureParams = _historicalParams(HISTORICAL_ANCHOR, 0, SUMMARIES, HISTORICAL_EVIDENCE, _noSlots());
        fixtureParams.extraStoredSlots = _slots(HISTORICAL_ANCHOR - 8193, HISTORICAL_ANCHOR - 8192, HISTORICAL_ANCHOR + 64);
        historical = _buildHistorical(fixtureParams, _defaultHeaderRlp());
    }

    /// Claim: a candidate that is `state.finalized_checkpoint.root` (field 20, then field 1 of the checkpoint: position
    /// (64 + 20) * 2 + 1 = 169, depth 7) is refused although the state really holds the stored header root there.
    /// Shows: the call reverts with `LayoutPositionInvalid(169)`; the honest anchor is accepted. Matters: a finalized
    /// checkpoint root is a block root, so it is the most natural impostor.
    function test_HB01_historicalLayoutAtFinalizedCheckpointRootRejected() public {
        _historicalFixture();
        BeaconProofVerifier.HistoricalSummariesEvidence memory bad = _anchorHoldingRootAt(1_100_000, 169);
        assertEq(bad.branch.length, 7);
        vm.expectRevert(abi.encodeWithSelector(BeaconProofVerifier.LayoutPositionInvalid.selector, uint256(169)));
        fresh.addHistoricalSummariesLayout(169, bad);
        (, HistoricalScene memory honest) = _honestAfterBad();
        fresh.addHistoricalSummariesLayout(SUMMARIES, honest.historicalEvidence);
        assertEq(fresh.historicalLayouts().length, 1);
    }

    /// Claim: a candidate that is `state.latest_block_header` (field 4, position 68) is refused although the state really
    /// holds the stored header root as its `parent_root`. The header container has 5 fields padded to 8 leaves and
    /// `parent_root` is its leaf 2, so the leaf sits at 68 * 8 + 2 = 546 (depth 9). Shows: candidate 68 reverts with
    /// `LayoutPositionInvalid(68)`, and candidate 546 is deeper than 8 and reverts with `LayoutOutOfBounds(546)`. The
    /// honest anchor is accepted. Matters: the parent root of the latest header is a stored root too.
    function test_HB01_historicalLayoutAtLatestBlockHeaderRejected() public {
        _historicalFixture();
        BeaconProofVerifier.HistoricalSummariesEvidence memory bad = _anchorHoldingRootAt(1_100_000, 68 * 8 + 2);
        assertEq(bad.branch.length, 9);
        vm.expectRevert(abi.encodeWithSelector(BeaconProofVerifier.LayoutPositionInvalid.selector, uint256(68)));
        fresh.addHistoricalSummariesLayout(68, bad);
        vm.expectRevert(abi.encodeWithSelector(BeaconProofVerifier.LayoutOutOfBounds.selector, uint256(546)));
        fresh.addHistoricalSummariesLayout(546, bad);
        (, HistoricalScene memory honest) = _honestAfterBad();
        fresh.addHistoricalSummariesLayout(SUMMARIES, honest.historicalEvidence);
        assertEq(fresh.historicalLayouts().length, 1);
    }

    // ================================================================ historical summaries: wrong list depth

    /// @dev A bad anchor whose `historical_summaries` list was built with another depth: the root commits the stored
    /// header root at the position that the other limit gives. Returns the evidence with the real branch of that tree.
    function _anchorWithListDepth(uint64 anchorSlot, uint256 listDepth)
        internal
        returns (BeaconProofVerifier.HistoricalSummariesEvidence memory evidence)
    {
        uint256 leaf = _historicalLeafWithListDepth(SUMMARIES, 0, HISTORICAL_EVIDENCE, listDepth);
        evidence = _anchorHoldingRootAt(anchorSlot, leaf);
        assertEq(evidence.branch.length, 6 + 1 + listDepth + 1 + 13, "the bad tree has its own depth");
    }

    /// Claim: a state whose summaries list has depth 23 (limit 2^23) is refused for position 91. Shows: its real branch has
    /// 44 entries and reverts with `BranchLengthMismatch(45, 44)`. Adding one sibling at any of the 45 places (the best
    /// the attacker can do to reach the length) reverts with `LayoutEvidenceInvalid` every time. The depth 24 anchor is
    /// accepted. Matters: the list depth is part of the root, so a state with another limit cannot validate the row.
    function test_HB01_historicalLayoutWithListDepth23Rejected() public {
        _historicalFixture();
        BeaconProofVerifier.HistoricalSummariesEvidence memory bad = _anchorWithListDepth(1_100_000, 23);
        vm.expectRevert(abi.encodeWithSelector(SSZ.BranchLengthMismatch.selector, uint256(45), uint256(44)));
        fresh.addHistoricalSummariesLayout(SUMMARIES, bad);
        bytes32[] memory real = bad.branch;
        for (uint256 place = 0; place < 45; place++) {
            bad.branch = _inserting(real, place, keccak256("arbitrary sibling"));
            vm.expectRevert(BeaconProofVerifier.LayoutEvidenceInvalid.selector);
            fresh.addHistoricalSummariesLayout(SUMMARIES, bad);
            bad.branch = _inserting(real, place, bytes32(0));
            vm.expectRevert(BeaconProofVerifier.LayoutEvidenceInvalid.selector);
            fresh.addHistoricalSummariesLayout(SUMMARIES, bad);
        }
        (, HistoricalScene memory honest) = _honestAfterBad();
        fresh.addHistoricalSummariesLayout(SUMMARIES, honest.historicalEvidence);
        assertEq(fresh.historicalLayouts().length, 1);
    }

    /// Claim: a state whose summaries list has depth 25 (limit 2^25) is refused for position 91. Shows: its real branch has
    /// 46 entries and reverts with `BranchLengthMismatch(45, 46)`. Removing one sibling at any of the 46 places reverts
    /// with `LayoutEvidenceInvalid` every time. The depth 24 anchor is accepted. Matters: the same as above, in the other direction.
    function test_HB01_historicalLayoutWithListDepth25Rejected() public {
        _historicalFixture();
        BeaconProofVerifier.HistoricalSummariesEvidence memory bad = _anchorWithListDepth(1_100_000, 25);
        vm.expectRevert(abi.encodeWithSelector(SSZ.BranchLengthMismatch.selector, uint256(45), uint256(46)));
        fresh.addHistoricalSummariesLayout(SUMMARIES, bad);
        bytes32[] memory real = bad.branch;
        for (uint256 place = 0; place < 46; place++) {
            bad.branch = _without(real, place);
            vm.expectRevert(BeaconProofVerifier.LayoutEvidenceInvalid.selector);
            fresh.addHistoricalSummariesLayout(SUMMARIES, bad);
        }
        (, HistoricalScene memory honest) = _honestAfterBad();
        fresh.addHistoricalSummariesLayout(SUMMARIES, honest.historicalEvidence);
        assertEq(fresh.historicalLayouts().length, 1);
    }

    // ================================================================ position rules: fields a proposer writes

    /// @dev Builds and stores a scene whose evidence uses the given positions, without adding any layout to a bridge.
    /// The evidence is real: the stored light client data and the sparse trees agree with the chosen positions.
    function _storedScene(uint256 blockRootsGindex, uint256 anchorBodyGindex) internal returns (SceneParams memory forgedParams, Scene memory forged) {
        forgedParams = _defaultParams();
        forgedParams.blockRootsGindex = blockRootsGindex;
        forgedParams.anchorBodyGindex = anchorBodyGindex;
        forged = _buildScene(MessageFixtures.deliver(), forgedParams, _messageHeaderRlp());
        _storeScene(forgedParams, forged);
    }

    /// Claim: the position of `eth1_data_votes` (field 9 of the state: 82 in Capella and Deneb, 146 in Electra and Fulu)
    /// is refused as a `block_roots` position, even when the evidence is valid for it. Shows: the evidence is built so
    /// that two stored header roots sit at `G * 8192 + slot % 8192` under a stored state root (the test proves that with
    /// the branch check itself), and the call still reverts with `LayoutPositionInvalid`. The honest position 69 is
    /// accepted afterwards. Matters: `eth1_data_votes` has the same tree shape as `block_roots`, and a block proposer
    /// writes its entries. If the bridge accepted that position, a proposer could pick the "block roots" and forge deposits.
    function test_defect1_eth1DataVotesPositionRefusedAsBlockRoots() public {
        uint256[2] memory votesPositions = [uint256(82), 146];
        for (uint256 i = 0; i < votesPositions.length; i++) {
            (, Scene memory forged) = _storedScene(votesPositions[i], 812);
            BeaconProofVerifier.BlockRootsEvidence memory evidence = forged.rootsEvidence;
            assertTrue(
                SSZ.isValidBranchMemory(
                    lightClientForB.headers(evidence.earlierSlotA),
                    evidence.branchA,
                    votesPositions[i] * 8192 + (evidence.earlierSlotA % 8192),
                    evidence.laterHeader.stateRoot
                ),
                "the forged evidence is valid for the position"
            );
            vm.expectRevert(abi.encodeWithSelector(BeaconProofVerifier.LayoutPositionInvalid.selector, votesPositions[i]));
            fresh.addBlockRootsLayout(votesPositions[i], evidence);
            assertEq(fresh.stateLayouts().length, 0, "nothing was stored");
        }
        fresh.addBlockRootsLayout(69, _rootsEvidence());
        assertEq(fresh.stateLayouts().length, 1);
    }

    /// Claim: only `2**d + 5` with `d` of 5, 6 or 7 is accepted as a `block_roots` position. Shows: 37, 69 and 133 pass
    /// the position check (they fail later, on evidence built for another depth, with a length error that proves the
    /// position check let them through), and the neighbours 36, 38, 68, 70, 132, 134 and the depth 4 and 8 positions
    /// are refused. Matters: the rule is exactly the position of the field in the three accepted tree depths.
    function test_defect1_blockRootsPositionRuleIsExact() public {
        uint256[3] memory allowed = [uint256(37), 69, 133];
        for (uint256 i = 0; i < allowed.length; i++) {
            if (allowed[i] == 69) continue;
            vm.expectRevert(abi.encodeWithSelector(SSZ.BranchLengthMismatch.selector, SSZ.depthOf(allowed[i] * 8192 + 1), uint256(19)));
            fresh.addBlockRootsLayout(allowed[i], _rootsEvidence());
        }
        uint256[8] memory refused = [uint256(36), 38, 68, 70, 132, 134, 21, 261];
        for (uint256 i = 0; i < refused.length; i++) {
            vm.expectRevert(abi.encodeWithSelector(BeaconProofVerifier.LayoutPositionInvalid.selector, refused[i]));
            fresh.addBlockRootsLayout(refused[i], _rootsEvidence());
        }
        fresh.addBlockRootsLayout(69, _rootsEvidence()); // control
    }

    /// Claim: `graffiti` (body field 4: position 16 + 2 = 18) and `eth1_data.block_hash` (body field 1, then leaf 2 of
    /// `Eth1Data`: position 70) are refused as block hash positions, even when the body holds the stored execution block
    /// hash there. Shows: the evidence is valid for the position (proved with the branch check), and the call reverts
    /// with `LayoutPositionInvalid`. The honest position 812 is accepted afterwards. Matters: a block proposer can copy
    /// the execution block hash into graffiti or into `eth1_data.block_hash`, and then forge the proof of any block hash.
    function test_defect2_graffitiAndEth1DataPositionsRefusedAsBlockHash() public {
        uint256[2] memory writablePositions = [uint256(18), 70];
        for (uint256 i = 0; i < writablePositions.length; i++) {
            (, Scene memory forged) = _storedScene(69, writablePositions[i]);
            BeaconProofVerifier.BlockHashEvidence memory evidence = forged.anchorBodyEvidence;
            assertTrue(
                SSZ.isValidBranchMemory(
                    lightClientForB.executionBlockHashes(evidence.header.slot),
                    evidence.branch,
                    writablePositions[i],
                    evidence.header.bodyRoot
                ),
                "the forged evidence is valid for the position"
            );
            vm.expectRevert(abi.encodeWithSelector(BeaconProofVerifier.LayoutPositionInvalid.selector, writablePositions[i]));
            fresh.addBlockHashLayout(writablePositions[i], evidence);
            assertEq(fresh.bodyLayouts().length, 0, "nothing was stored");
        }
        fresh.addBlockHashLayout(812, _hashEvidence());
        assertEq(fresh.bodyLayouts().length, 1);
    }

    /// Claim: the block hash rule is `(2**db + 9) * 2**dp + 12` with `db` and `dp` in 4 to 5: 412, 668, 812, 1324. Shows:
    /// each of 412, 668 and 1324 passes the position check (it fails later, on the evidence that was built for 812), and near misses are
    /// refused. Matters: the Rust reference accepts only 412 and 812. The bridge also admits 668 and 1324, the positions
    /// of the same field if the body or the payload grows to 17 or more fields. They need evidence that the stored data
    /// proves, so they cannot be used to forge.
    function test_defect2_blockHashPositionRuleIsExact() public {
        vm.expectRevert(abi.encodeWithSelector(SSZ.BranchLengthMismatch.selector, uint256(8), uint256(9)));
        fresh.addBlockHashLayout(412, _hashEvidence());
        vm.expectRevert(BeaconProofVerifier.LayoutEvidenceInvalid.selector); // depth 9 like 812, but the leaf is elsewhere
        fresh.addBlockHashLayout(668, _hashEvidence());
        vm.expectRevert(abi.encodeWithSelector(SSZ.BranchLengthMismatch.selector, uint256(10), uint256(9)));
        fresh.addBlockHashLayout(1324, _hashEvidence());
        uint256[6] memory refused = [uint256(411), 413, 667, 811, 813, 1325];
        for (uint256 i = 0; i < refused.length; i++) {
            vm.expectRevert(abi.encodeWithSelector(BeaconProofVerifier.LayoutPositionInvalid.selector, refused[i]));
            fresh.addBlockHashLayout(refused[i], _hashEvidence());
        }
        fresh.addBlockHashLayout(812, _hashEvidence()); // control
    }
}
