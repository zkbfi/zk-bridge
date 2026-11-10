// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {MessageBridge} from "../../src/hardened/MessageBridge.sol";
import {BeaconProofVerifier} from "../../src/hardened/BeaconProofVerifier.sol";
import {MessageScenes} from "./utils/MessageScenes.sol";
import {MessageFixtures} from "./utils/MessageFixtures.sol";

/// @notice Tests of the range rule of the layout tables. A validated range must never cover a slot where another
/// position was validated, so ranges of different positions never overlap and a lookup has at most one answer. The
/// tests use the `historical_summaries` table (positions 59 and 91). The other two tables share the rule.
contract LayoutRangeRuleTest is MessageScenes {
    uint64 internal constant CAPELLA_ERA = 758;
    uint64 internal constant FIRST_STORED_SLOT = 6_000_000;
    uint256 internal constant DENEB_SUMMARIES = 59;
    uint256 internal constant ELECTRA_SUMMARIES = 91;

    uint64 internal constant FIRST_ANCHOR = 6_400_000;
    uint64 internal constant SECOND_ANCHOR = 6_420_000;
    uint64 internal constant MIDDLE_ANCHOR = 6_440_000;
    uint64 internal constant MIDDLE_DEPOSIT = 6_425_000;
    uint64 internal constant THIRD_ANCHOR = 6_460_000;

    /// @dev The anchors of the fuzz scenes and the position of each one. Positions alternate in a pattern that holds
    /// the A-B-A shape in several places.
    uint256 internal constant FUZZ_SCENE_COUNT = 8;
    uint64 internal constant FUZZ_FIRST_ANCHOR = 6_400_000;
    uint64 internal constant FUZZ_ANCHOR_STEP = 30_000;
    uint64 internal constant FUZZ_EVIDENCE_GAP = 10_000;

    MessageBridge internal target;
    BeaconProofVerifier.HistoricalSummariesEvidence[] internal fuzzEvidence;
    uint256[] internal fuzzPositions;

    /// @dev The scene of one anchor in a state of `position`, with no deposit.
    function _sceneAt(uint64 anchor, uint256 position) internal returns (HistoricalScene memory) {
        return _historicalScene(_historicalParams(anchor, CAPELLA_ERA, position, anchor - FUZZ_EVIDENCE_GAP, _noSlots()));
    }

    // ================================================================ the A-B-A shape

    /// Claim: a position validated, then replaced, then validated again never covers the slots of its replacement.
    /// Shows: position 59 at the first anchor, position 91 at the second, position 59 at the third. The third call
    /// starts a new range for 59 instead of growing the first one over the second anchor. An anchor between the second
    /// and the third has no layout: its message is refused with `LayoutNotValidated`. Anyone can then validate 59 at that
    /// anchor, which grows the third range downward (not the first one upward), and the message executes. Matters: before
    /// the rule, the first range grew to the third anchor and a message at the middle anchor used position 59 in a
    /// state that has position 91. The safety rested on the tree shape alone.
    function test_rangeRule_positionValidatedAgainAfterAnotherStartsNewRange() public {
        target = _historicalWorld(FIRST_STORED_SLOT, CAPELLA_ERA);
        HistoricalScene memory first = _sceneAt(FIRST_ANCHOR, DENEB_SUMMARIES);
        HistoricalScene memory second = _sceneAt(SECOND_ANCHOR, ELECTRA_SUMMARIES);
        HistoricalParams memory middleParams = _historicalParams(
            MIDDLE_ANCHOR, CAPELLA_ERA, DENEB_SUMMARIES, MIDDLE_ANCHOR - FUZZ_EVIDENCE_GAP, _slots(MIDDLE_DEPOSIT)
        );
        HistoricalScene memory middle = _historicalScene(middleParams);
        HistoricalScene memory third = _sceneAt(THIRD_ANCHOR, DENEB_SUMMARIES);

        target.addHistoricalSummariesLayout(DENEB_SUMMARIES, first.historicalEvidence);
        target.addHistoricalSummariesLayout(ELECTRA_SUMMARIES, second.historicalEvidence);
        target.addHistoricalSummariesLayout(DENEB_SUMMARIES, third.historicalEvidence);

        BeaconProofVerifier.SlotRange[] memory rows = target.historicalLayouts();
        assertEq(rows.length, 3, "the third call starts a new range");
        assertEq(rows[0].gindex, DENEB_SUMMARIES);
        assertEq(rows[0].lastSlot, FIRST_ANCHOR, "the first range stops at its own anchor");
        assertEq(rows[1].gindex, ELECTRA_SUMMARIES);
        assertEq(rows[2].gindex, DENEB_SUMMARIES);
        assertEq(rows[2].firstSlot, THIRD_ANCHOR);

        _addBodyRows(target, middle);
        MessageFixtures.Named memory named = MessageFixtures.deliver();
        vm.expectRevert(abi.encodeWithSelector(BeaconProofVerifier.LayoutNotValidated.selector, MIDDLE_ANCHOR));
        target.executeMessage(_historicalProof(middle, 0, named));

        target.addHistoricalSummariesLayout(DENEB_SUMMARIES, middle.historicalEvidence);
        rows = target.historicalLayouts();
        assertEq(rows.length, 3, "the middle anchor grows the third range");
        assertEq(rows[0].lastSlot, FIRST_ANCHOR);
        assertEq(rows[2].firstSlot, MIDDLE_ANCHOR);
        assertEq(rows[2].lastSlot, THIRD_ANCHOR);
        target.executeMessage(_historicalProof(middle, 0, named));
        assertTrue(target.messageCallStatus(named.messageId), "the middle message executes once its anchor is validated");
        assertEq(recorder.callCount(), 1, "the target is called once");
    }

    /// Claim: a range still grows when no other position was validated in the way. Shows: position 59 at the first and
    /// the third anchor, with 91 validated only above both, gives one range from the first to the third anchor.
    /// Matters: the rule must not split ranges that are safe, because every split leaves anchors with no layout.
    function test_rangeRule_rangeGrowsWhenNothingIsInTheWay() public {
        target = _historicalWorld(FIRST_STORED_SLOT, CAPELLA_ERA);
        HistoricalScene memory first = _sceneAt(FIRST_ANCHOR, DENEB_SUMMARIES);
        HistoricalScene memory third = _sceneAt(THIRD_ANCHOR, DENEB_SUMMARIES);
        HistoricalScene memory above = _sceneAt(THIRD_ANCHOR + FUZZ_ANCHOR_STEP, ELECTRA_SUMMARIES);

        target.addHistoricalSummariesLayout(DENEB_SUMMARIES, first.historicalEvidence);
        target.addHistoricalSummariesLayout(ELECTRA_SUMMARIES, above.historicalEvidence);
        target.addHistoricalSummariesLayout(DENEB_SUMMARIES, third.historicalEvidence);

        BeaconProofVerifier.SlotRange[] memory rows = target.historicalLayouts();
        assertEq(rows.length, 2);
        assertEq(rows[0].gindex, DENEB_SUMMARIES);
        assertEq(rows[0].firstSlot, FIRST_ANCHOR);
        assertEq(rows[0].lastSlot, THIRD_ANCHOR);
    }

    /// Claim: a layout cannot be validated at a slot that another position's range already covers. Shows: position 91
    /// validated at the first and the third anchor covers the second anchor, so 59 at the second anchor reverts with
    /// `LayoutRangeConflict`. Matters: the table never holds two answers for one slot. The range of 91 was built from
    /// real evidence at both ends, and the conflict is reported instead of hidden. Validating 59 first would have kept both.
    function test_rangeRule_slotInsideAnotherRangeRefused() public {
        target = _historicalWorld(FIRST_STORED_SLOT, CAPELLA_ERA);
        HistoricalScene memory first = _sceneAt(FIRST_ANCHOR, ELECTRA_SUMMARIES);
        HistoricalScene memory second = _sceneAt(SECOND_ANCHOR, DENEB_SUMMARIES);
        HistoricalScene memory third = _sceneAt(THIRD_ANCHOR, ELECTRA_SUMMARIES);

        target.addHistoricalSummariesLayout(ELECTRA_SUMMARIES, first.historicalEvidence);
        target.addHistoricalSummariesLayout(ELECTRA_SUMMARIES, third.historicalEvidence);
        vm.expectRevert(abi.encodeWithSelector(BeaconProofVerifier.LayoutRangeConflict.selector, SECOND_ANCHOR));
        target.addHistoricalSummariesLayout(DENEB_SUMMARIES, second.historicalEvidence);
        assertEq(target.historicalLayouts().length, 1);
    }

    // ================================================================ random orders

    /// @dev Builds the fuzz scenes once. Evidence goes to storage, so each fuzz run starts from the same chain.
    function _buildFuzzScenes() internal {
        target = _historicalWorld(FIRST_STORED_SLOT, CAPELLA_ERA);
        uint256[8] memory pattern = [uint256(59), 91, 59, 59, 91, 59, 91, 91];
        for (uint256 i = 0; i < FUZZ_SCENE_COUNT; i++) {
            uint64 anchor = FUZZ_FIRST_ANCHOR + uint64(i) * FUZZ_ANCHOR_STEP;
            fuzzEvidence.push(_sceneAt(anchor, pattern[i]).historicalEvidence);
            fuzzPositions.push(pattern[i]);
        }
    }

    function setUp() public override {
        super.setUp();
        _buildFuzzScenes();
    }

    /// Claim: under any order of validation, ranges of different positions never overlap, and a slot that was
    /// validated is covered by a range of its own position only. Shows: a random order and subset of eight anchors with
    /// A-B-A shapes, each call either succeeds or reverts with `LayoutRangeConflict`; after every call the table holds
    /// no overlap between positions, and every validated anchor has exactly one covering position. Matters: this is the
    /// property that the lookup relies on when it returns the first match.
    /// forge-config: default.fuzz.runs = 64
    function testFuzz_rangeRule_rangesOfDifferentPositionsNeverOverlap(uint256 seed) public {
        bool[8] memory validated;
        for (uint256 step = 0; step < 12; step++) {
            seed = uint256(keccak256(abi.encode(seed, step)));
            uint256 pick = seed % FUZZ_SCENE_COUNT;
            try target.addHistoricalSummariesLayout(fuzzPositions[pick], fuzzEvidence[pick]) {
                validated[pick] = true;
            } catch (bytes memory reason) {
                assertEq(
                    bytes4(reason),
                    BeaconProofVerifier.LayoutRangeConflict.selector,
                    "only a range conflict may refuse valid evidence"
                );
            }
            _assertNoOverlap();
            _assertEachValidatedAnchorHasOneOwner(validated);
        }
    }

    function _assertNoOverlap() internal view {
        BeaconProofVerifier.SlotRange[] memory rows = target.historicalLayouts();
        for (uint256 i = 0; i < rows.length; i++) {
            for (uint256 j = i + 1; j < rows.length; j++) {
                if (rows[i].gindex == rows[j].gindex) continue;
                bool overlaps = rows[i].firstSlot <= rows[j].lastSlot && rows[j].firstSlot <= rows[i].lastSlot;
                assertFalse(overlaps, "ranges of different positions overlap");
            }
        }
    }

    function _assertEachValidatedAnchorHasOneOwner(bool[8] memory validated) internal view {
        BeaconProofVerifier.SlotRange[] memory rows = target.historicalLayouts();
        for (uint256 scene = 0; scene < FUZZ_SCENE_COUNT; scene++) {
            if (!validated[scene]) continue;
            uint64 anchor = FUZZ_FIRST_ANCHOR + uint64(scene) * FUZZ_ANCHOR_STEP;
            for (uint256 i = 0; i < rows.length; i++) {
                if (rows[i].firstSlot > anchor || anchor > rows[i].lastSlot) continue;
                assertEq(rows[i].gindex, fuzzPositions[scene], "a validated anchor has a foreign cover");
            }
        }
    }
}
