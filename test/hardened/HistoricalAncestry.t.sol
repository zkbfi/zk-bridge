// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {MessageBridge} from "../../src/hardened/MessageBridge.sol";
import {BeaconProofVerifier} from "../../src/hardened/BeaconProofVerifier.sol";
import {BeaconBlockHeader, SSZ} from "../../src/hardened/SSZ.sol";
import {MessageScenes} from "./utils/MessageScenes.sol";
import {MessageFixtures} from "./utils/MessageFixtures.sol";
import {MessageRecorder} from "./utils/MessageTargets.sol";

/// @notice Tests of the historical ancestry path of `MessageBridge.executeMessage`. A message whose source block is more
/// than 8192 slots below the anchor is proven through `state.historical_summaries`. The anchor states are sparse Merkle
/// trees that hold the source header roots at positions that `HistoricalScenes` computes by hand. The receipts and the
/// transactions are the real `MessageFixtures` tries. The gas of this path is measured in `MessageBridgeGas.t.sol`.
contract HistoricalAncestryTest is MessageScenes {
    /// @dev An Ethereum-like chain: Capella started in era 758. Slots are near 6.3 million.
    uint64 internal constant ETHEREUM_CAPELLA_ERA = 758;
    uint64 internal constant ETHEREUM_INITIAL_SLOT = 6_000_000;
    uint64 internal constant ETHEREUM_ANCHOR = 6_400_000;
    uint64 internal constant ETHEREUM_EVIDENCE = 6_300_000;
    /// @dev The `historical_summaries` and `block_roots` positions in an Electra-like and a Deneb-like state.
    uint256 internal constant ELECTRA_SUMMARIES = 91;
    uint256 internal constant ELECTRA_BLOCK_ROOTS = 69;
    uint256 internal constant DENEB_SUMMARIES = 59;

    // ---------------------------------------------------------------- helpers

    function _ethereumParams(uint64[] memory sourceSlots) internal pure returns (HistoricalParams memory) {
        return _historicalParams(ETHEREUM_ANCHOR, ETHEREUM_CAPELLA_ERA, ELECTRA_SUMMARIES, ETHEREUM_EVIDENCE, sourceSlots);
    }

    /// @dev A destination bridge, a scene with the given source blocks, and every layout the delivery needs on the historical path.
    function _readyEthereum(uint64[] memory sourceSlots)
        internal
        returns (MessageBridge bridge_, HistoricalParams memory params, HistoricalScene memory scene)
    {
        bridge_ = _historicalWorld(ETHEREUM_INITIAL_SLOT, ETHEREUM_CAPELLA_ERA);
        params = _ethereumParams(sourceSlots);
        scene = _historicalScene(params);
        _addBodyRows(bridge_, scene);
        _addHistoricalRow(bridge_, params, scene);
    }

    /// @dev The bridge, the scene and all three layout rows, for a state that holds recent and historical leaves.
    function _readyEdge()
        internal
        returns (MessageBridge bridge_, HistoricalParams memory params, HistoricalScene memory scene)
    {
        bridge_ = _historicalWorld(ETHEREUM_INITIAL_SLOT, ETHEREUM_CAPELLA_ERA);
        params = _ethereumParams(_slots(ETHEREUM_ANCHOR - 8192, ETHEREUM_ANCHOR - 8193));
        params.blockRootsGindex = ELECTRA_BLOCK_ROOTS;
        scene = _historicalScene(params);
        _addBodyRows(bridge_, scene);
        _addHistoricalRow(bridge_, params, scene);
        _addRecentRow(bridge_, params, scene);
    }

    /// @dev Delivers the message and checks that the recorder ran once more, with the context of this message, and that
    /// the bridge records the call as a success.
    function _deliverAndAssert(
        MessageBridge bridge_,
        MessageBridge.MessageProof memory proof,
        MessageFixtures.Named memory named
    ) internal {
        uint256 before = recorder.callCount();
        bridge_.executeMessage(proof);
        assertEq(recorder.callCount(), before + 1, "the target ran once");
        MessageRecorder.Call memory call = recorder.callAt(before);
        assertEq(call.caller, address(bridge_), "the bridge is the caller");
        assertEq(call.messageId, named.messageId, "the target saw the identifier of this message");
        assertEq(call.transactionHash, named.transactionHash, "the target saw the proven transaction hash");
        assertTrue(bridge_.messageCallStatus(named.messageId), "the status records success");
    }

    /// @dev A second destination bridge on chain B, at its own address, with no layout rows. It uses the light client of
    /// the test and the `capellaEra` that the caller names.
    function _newSecondBridge(uint64 capellaEra) internal returns (MessageBridge) {
        vm.chainId(CHAIN_B);
        return new MessageBridge(
            address(lightClientForB),
            CHAIN_A,
            MessageFixtures.REMOTE_BRIDGE,
            MessageBridge.BridgeTerms(0, address(lightClientForA)),
            capellaEra,
            address(gateB)
        );
    }

    function _expectRejected(MessageBridge bridge_, MessageBridge.MessageProof memory proof, bytes memory revertData)
        internal
    {
        vm.expectRevert(revertData);
        bridge_.executeMessage(proof);
    }

    function _lengthMismatch(uint256 expected, uint256 actual) internal pure returns (bytes memory) {
        return abi.encodeWithSelector(SSZ.BranchLengthMismatch.selector, expected, actual);
    }

    /// @dev Builds a world and a scene for one source block, then delivers its message. The branch length is checked
    /// against the depth that the hand-built position has.
    function _deliverOneHistorical(
        HistoricalParams memory params,
        uint64 initialSlot,
        MessageFixtures.Named memory named,
        uint256 expectedBranchLength
    ) internal {
        MessageBridge bridge_ = _historicalWorld(initialSlot, params.capellaEra);
        HistoricalScene memory scene = _historicalScene(params);
        _addBodyRows(bridge_, scene);
        _addHistoricalRow(bridge_, params, scene);
        uint64 sourceSlot = params.depositSlots[0];
        assertGt(params.anchorSlot - sourceSlot, 8192, "the scene is on the historical path");
        uint256 position = _historicalLeaf(params.historicalSummariesGindex, params.capellaEra, sourceSlot);
        assertEq(SSZ.depthOf(position), expectedBranchLength, "the hand-built position has the expected depth");
        MessageBridge.MessageProof memory proof = _historicalProof(scene, 0, named);
        assertEq(proof.ancestryBranch.length, expectedBranchLength);
        _deliverAndAssert(bridge_, proof, named);
        BeaconProofVerifier.SlotRange[] memory rows = bridge_.historicalLayouts();
        assertEq(rows.length, 1);
        assertEq(rows[0].gindex, params.historicalSummariesGindex);
    }

    // ================================================================ the position, by hand

    /// Claim: the historical position follows the documented order: field, data root, list index, summary field, slot.
    /// Shows: with index 0 and slot 0 the position is the field shifted by 39 bits (1 + 24 + 1 + 13). The documented
    /// wrong order (both doublings after the index) gives another number. Depths are 44 for field 59 and 45 for field 91.
    /// Matters: a test helper that disagreed with the bridge would build proofs that only fail, or worse, pass by accident.
    /// This test pins the helper to numbers that are written out by hand, as in the Rust reference.
    function test_HB01_historicalPositionFollowsTheDocumentedOrder() public pure {
        assertEq(_historicalLeaf(59, 0, 0), uint256(59) << 39);
        assertEq(_historicalLeaf(91, 0, 0), uint256(91) << 39);
        assertEq(SSZ.depthOf(_historicalLeaf(59, 758, 6_213_536)), 44);
        assertEq(SSZ.depthOf(_historicalLeaf(91, 758, 6_213_536)), 45);
        // era 760, index 2, slot offset 5: ((((91 * 2) << 24) + 2) * 2) * 8192 + 5, written with literals.
        uint256 expected = ((((uint256(91) * 2) * 16_777_216) + 2) * 2) * 8192 + 5;
        assertEq(_historicalLeaf(91, 758, uint64(760 * 8192 + 5)), expected);
        uint256 wrongOrder = ((uint256(91) * 16_777_216 + 2) * 2 * 2) * 8192 + 5;
        assertTrue(_historicalLeaf(91, 758, uint64(760 * 8192 + 5)) != wrongOrder, "the order matters");
    }

    // ================================================================ honest historical deliveries

    /// Claim: a message from the first slot of an era is delivered through the historical path. Shows: era 770 slot 0
    /// (index 12 with capellaEra 758, an Electra-like state, branch of 45) reaches the target and the bridge records the
    /// success. Matters: an
    /// off-by-one in the slot offset or in the era index would show first at an era edge.
    function test_HB01_historical_firstSlotOfAnEraDelivers() public {
        MessageFixtures.Named memory named = MessageFixtures.deliver();
        _deliverOneHistorical(_ethereumParams(_slots(770 * 8192)), ETHEREUM_INITIAL_SLOT, named, 45);
    }

    /// Claim: a message from the last slot of an era is delivered through the historical path. Shows: era 760 slot 8191
    /// (index 2) is delivered. Matters: the other era edge; the slot offset 8191 is the largest leaf of the era's block roots.
    function test_HB01_historical_lastSlotOfAnEraDelivers() public {
        MessageFixtures.Named memory named = MessageFixtures.order_a();
        _deliverOneHistorical(_ethereumParams(_slots(761 * 8192 - 1)), ETHEREUM_INITIAL_SLOT, named, 45);
    }

    /// Claim: a message from the very first Capella era (index 0) is delivered. Shows: era 758 is delivered.
    /// Matters: index 0 is the first summary of the list. The era formula must subtract capellaEra and not more.
    function test_HB01_historical_firstCapellaEraDelivers() public {
        MessageFixtures.Named memory named = MessageFixtures.order_b();
        _deliverOneHistorical(_ethereumParams(_slots(758 * 8192 + 4000)), ETHEREUM_INITIAL_SLOT, named, 45);
    }

    /// Claim: the very first slot of the very first Capella era is delivered. Shows: slot 6209536 (index 0, offset 0) is
    /// delivered. Matters: the lowest position the bridge can ever accept on this chain.
    function test_HB01_historical_firstSlotOfFirstCapellaEraDelivers() public {
        MessageFixtures.Named memory named = MessageFixtures.deliver();
        _deliverOneHistorical(_ethereumParams(_slots(758 * 8192)), ETHEREUM_INITIAL_SLOT, named, 45);
    }

    /// Claim: a later era is delivered. Shows: era 779 (index 21) is delivered, one era below the last complete era of the anchor.
    /// Matters: the index grows with the era, so a large index must land at the right list position.
    function test_HB01_historical_laterEraDelivers() public {
        MessageFixtures.Named memory named = MessageFixtures.order_b();
        _deliverOneHistorical(_ethereumParams(_slots(779 * 8192 + 1234)), ETHEREUM_INITIAL_SLOT, named, 45);
    }

    /// Claim: a Capella or Deneb state (field 59, branch of 44) is delivered by the same code. Shows: a Deneb-like state
    /// with the same capellaEra is delivered. Matters: the bridge holds no fork table, so both depths must work from the layout row alone.
    function test_HB01_historical_denebLayoutDelivers() public {
        HistoricalParams memory params = _historicalParams(
            ETHEREUM_ANCHOR, ETHEREUM_CAPELLA_ERA, DENEB_SUMMARIES, ETHEREUM_EVIDENCE, _slots(775 * 8192 + 99)
        );
        _deliverOneHistorical(params, ETHEREUM_INITIAL_SLOT, MessageFixtures.order_b(), 44);
    }

    /// Claim: a PulseChain-like chain (capellaEra 0, Capella-layout state) delivers era 0, index 0. Shows: a message from slot 100
    /// is delivered; the light client of this scene starts at slot 32. Matters: with capellaEra 0 the index equals the era.
    function test_HB01_historical_pulseChainLikeEraZeroDelivers() public {
        HistoricalParams memory params = _historicalParams(120_000, 0, DENEB_SUMMARIES, 20_000, _slots(100));
        _deliverOneHistorical(params, 32, MessageFixtures.deliver(), 44);
    }

    /// Claim: several messages of different eras under one anchor are each delivered once, and a second delivery is refused.
    /// Shows: three eras deliver three different messages; repeating the first reverts with `AlreadyDelivered`.
    /// Matters: the historical path uses the same delivery book as the recent path.
    function test_HB01_historical_severalErasUnderOneAnchorDeliverOnceEach() public {
        (MessageBridge bridge_,, HistoricalScene memory scene) =
            _readyEthereum(_slots(758 * 8192, 761 * 8192 - 1, 770 * 8192));
        MessageFixtures.Named memory first = MessageFixtures.deliver();
        MessageFixtures.Named memory second = MessageFixtures.order_a();
        MessageFixtures.Named memory third = MessageFixtures.order_b();
        _deliverAndAssert(bridge_, _historicalProof(scene, 0, first), first);
        _deliverAndAssert(bridge_, _historicalProof(scene, 1, second), second);
        _deliverAndAssert(bridge_, _historicalProof(scene, 2, third), third);
        _expectRejected(
            bridge_,
            _historicalProof(scene, 0, first),
            abi.encodeWithSelector(MessageBridge.AlreadyDelivered.selector, first.messageId)
        );
    }

    // ================================================================ the path by distance

    /// Claim: a source block exactly 8192 slots below the anchor takes the recent path, and a source block 8193 below takes
    /// the historical path. Shows: with one anchor that holds both leaves, the recent branch (19 entries) delivers at
    /// 8192 and the historical branch (45 entries) delivers at 8193. Matters: the boundary of the two paths is exact.
    function test_HB01_edge_distance8192IsRecentAnd8193IsHistorical() public {
        (MessageBridge bridge_,, HistoricalScene memory scene) = _readyEdge();
        MessageFixtures.Named memory recentReceipt = MessageFixtures.deliver();
        MessageFixtures.Named memory historicalReceipt = MessageFixtures.order_b();
        MessageBridge.MessageProof memory recent = _recentProof(scene, 0, recentReceipt);
        MessageBridge.MessageProof memory historical = _historicalProof(scene, 1, historicalReceipt);
        assertEq(recent.sourceHeader.slot, ETHEREUM_ANCHOR - 8192);
        assertEq(recent.ancestryBranch.length, 19);
        assertEq(historical.sourceHeader.slot, ETHEREUM_ANCHOR - 8193);
        assertEq(historical.ancestryBranch.length, 45);
        _deliverAndAssert(bridge_, recent, recentReceipt);
        _deliverAndAssert(bridge_, historical, historicalReceipt);
    }

    /// Claim: the recent branch is refused at distance 8193. Shows: the same source block, with a state that really holds its
    /// header root at the recent position, reverts with `BranchLengthMismatch(45, 19)`: the bridge expects the historical
    /// length. The control (the historical branch) is delivered. Matters: the prover cannot pick the path. A state that holds a
    /// stale root in `block_roots` for a slot that the ring already overwrote cannot be used.
    function test_HB01_edge_recentBranchAtDistance8193Refused() public {
        (MessageBridge bridge_,, HistoricalScene memory scene) = _readyEdge();
        MessageFixtures.Named memory named = MessageFixtures.order_b();
        _expectRejected(bridge_, _recentProof(scene, 1, named), _lengthMismatch(45, 19));
        _deliverAndAssert(bridge_, _historicalProof(scene, 1, named), named);
    }

    /// Claim: the historical branch is refused at distance 8192. Shows: reverts with `BranchLengthMismatch(19, 45)`; the
    /// control (the recent branch) is delivered. Matters: the bridge never accepts the longer path for a source block that is still in
    /// `block_roots`, so the two paths cannot be mixed to dodge a layout row.
    function test_HB01_edge_historicalBranchAtDistance8192Refused() public {
        (MessageBridge bridge_,, HistoricalScene memory scene) = _readyEdge();
        MessageFixtures.Named memory named = MessageFixtures.deliver();
        _expectRejected(bridge_, _historicalProof(scene, 0, named), _lengthMismatch(19, 45));
        _deliverAndAssert(bridge_, _recentProof(scene, 0, named), named);
    }

    /// Claim: a source block that is not strictly before the anchor is refused on the historical scene too. Shows: the anchor
    /// slot and a slot after it revert with `DepositNotBeforeAnchor`; the control is delivered. Matters: the check runs before any
    /// layout row or era rule, so a slot after the anchor never reaches the era arithmetic.
    function test_HB01_edge_depositNotBeforeAnchorRejected() public {
        (MessageBridge bridge_,, HistoricalScene memory scene) = _readyEdge();
        MessageFixtures.Named memory named = MessageFixtures.order_b();
        MessageBridge.MessageProof memory same = _historicalProof(scene, 1, named);
        same.sourceHeader.slot = ETHEREUM_ANCHOR;
        _expectRejected(
            bridge_, same, abi.encodeWithSelector(BeaconProofVerifier.DepositNotBeforeAnchor.selector, ETHEREUM_ANCHOR, ETHEREUM_ANCHOR)
        );
        MessageBridge.MessageProof memory later = _historicalProof(scene, 1, named);
        later.sourceHeader.slot = ETHEREUM_ANCHOR + 3;
        _expectRejected(
            bridge_,
            later,
            abi.encodeWithSelector(BeaconProofVerifier.DepositNotBeforeAnchor.selector, ETHEREUM_ANCHOR + 3, ETHEREUM_ANCHOR)
        );
        _deliverAndAssert(bridge_, _historicalProof(scene, 1, named), named);
    }

    // ================================================================ exact branch lengths

    /// Claim: on an Electra or Fulu state (field 91) the historical branch has exactly 45 entries. Shows: one extra entry
    /// reverts with `BranchLengthMismatch(45, 46)`, one missing entry with `(45, 44)`, an empty branch with `(45, 0)`.
    /// The control (45 entries) is delivered. Matters: padding must not turn a wrong path into a pass.
    function test_HB01_branchLength_electraNeedsExactly45() public {
        (MessageBridge bridge_,, HistoricalScene memory scene) = _readyEthereum(_slots(770 * 8192));
        MessageFixtures.Named memory named = MessageFixtures.deliver();
        bytes32[] memory honest = scene.historicalBranches[0];
        assertEq(honest.length, 45);
        _expectRejected(
            bridge_,
            _proofWithBranch(scene, 0, named, _concat(honest, _repeat(keccak256("one more"), 1))),
            _lengthMismatch(45, 46)
        );
        _expectRejected(bridge_, _proofWithBranch(scene, 0, named, _slice(honest, 0, 44)), _lengthMismatch(45, 44));
        _expectRejected(bridge_, _proofWithBranch(scene, 0, named, new bytes32[](0)), _lengthMismatch(45, 0));
        _deliverAndAssert(bridge_, _historicalProof(scene, 0, named), named);
    }

    /// Claim: on a Capella or Deneb state (field 59) the historical branch has exactly 44 entries. Shows: 45 reverts with
    /// `BranchLengthMismatch(44, 45)` and 43 with `(44, 43)`; the control is delivered. Matters: the same as above for the
    /// shallower state, and a branch for the other fork never fits.
    function test_HB01_branchLength_denebNeedsExactly44() public {
        MessageBridge bridge_ = _historicalWorld(ETHEREUM_INITIAL_SLOT, ETHEREUM_CAPELLA_ERA);
        HistoricalParams memory params = _historicalParams(
            ETHEREUM_ANCHOR, ETHEREUM_CAPELLA_ERA, DENEB_SUMMARIES, ETHEREUM_EVIDENCE, _slots(770 * 8192)
        );
        HistoricalScene memory scene = _historicalScene(params);
        _addBodyRows(bridge_, scene);
        _addHistoricalRow(bridge_, params, scene);
        MessageFixtures.Named memory named = MessageFixtures.deliver();
        bytes32[] memory honest = scene.historicalBranches[0];
        assertEq(honest.length, 44);
        _expectRejected(
            bridge_,
            _proofWithBranch(scene, 0, named, _concat(honest, _repeat(keccak256("one more"), 1))),
            _lengthMismatch(44, 45)
        );
        _expectRejected(bridge_, _proofWithBranch(scene, 0, named, _slice(honest, 0, 43)), _lengthMismatch(44, 43));
        _deliverAndAssert(bridge_, _historicalProof(scene, 0, named), named);
    }

    /// Claim: a changed sibling at any of the 45 levels is refused with `AncestryBranchInvalid`. Shows: every position of
    /// the branch, changed one at a time, reverts; the control is delivered. Matters: each level of the path (era block roots,
    /// summary pair, list, length mix-in, state fields) is bound to the anchor state root.
    function test_HB01_branchTamper_everyLevelRejected() public {
        (MessageBridge bridge_,, HistoricalScene memory scene) = _readyEthereum(_slots(770 * 8192 + 17));
        MessageFixtures.Named memory named = MessageFixtures.deliver();
        for (uint256 level = 0; level < 45; level++) {
            MessageBridge.MessageProof memory proof = _historicalProof(scene, 0, named);
            proof.ancestryBranch[level] = keccak256(abi.encode("attacker sibling", level));
            _expectRejected(bridge_, proof, abi.encodeWithSelector(BeaconProofVerifier.AncestryBranchInvalid.selector));
        }
        _deliverAndAssert(bridge_, _historicalProof(scene, 0, named), named);
    }

    /// Claim: the source header, its slot offset and its era are each bound by the branch. Shows: a changed proposer
    /// index, a slot one higher in the same era, and the same offset in the next era each revert with
    /// `AncestryBranchInvalid`. The control is delivered. Matters: a valid branch for one source block never proves another.
    function test_HB01_branchTamper_headerAndSlotRejected() public {
        (MessageBridge bridge_,, HistoricalScene memory scene) = _readyEthereum(_slots(770 * 8192 + 17));
        MessageFixtures.Named memory named = MessageFixtures.deliver();
        bytes memory refused = abi.encodeWithSelector(BeaconProofVerifier.AncestryBranchInvalid.selector);
        MessageBridge.MessageProof memory header = _historicalProof(scene, 0, named);
        header.sourceHeader.proposerIndex += 1;
        _expectRejected(bridge_, header, refused);
        MessageBridge.MessageProof memory offset = _historicalProof(scene, 0, named);
        offset.sourceHeader.slot += 1;
        _expectRejected(bridge_, offset, refused);
        MessageBridge.MessageProof memory nextEra = _historicalProof(scene, 0, named);
        nextEra.sourceHeader.slot += 8192;
        _expectRejected(bridge_, nextEra, refused);
        _deliverAndAssert(bridge_, _historicalProof(scene, 0, named), named);
    }

    // ================================================================ era rules

    /// Claim: a message from an era before `capellaEra` is refused. Shows: the last slot of era 757 reverts with
    /// `DepositBeforeCapellaEra(757, 758)`, slot 0 with `(0, 758)`; the first slot of era 758 is delivered. Matters: no summary
    /// exists for earlier eras, and the index `era - capellaEra` would underflow.
    function test_HB01_era_depositBeforeCapellaEraRejected() public {
        (MessageBridge bridge_,, HistoricalScene memory scene) = _readyEthereum(_slots(758 * 8192));
        MessageFixtures.Named memory named = MessageFixtures.deliver();
        MessageBridge.MessageProof memory lastOfPrevious = _historicalProof(scene, 0, named);
        lastOfPrevious.sourceHeader.slot = 758 * 8192 - 1;
        _expectRejected(
            bridge_,
            lastOfPrevious,
            abi.encodeWithSelector(BeaconProofVerifier.DepositBeforeCapellaEra.selector, uint64(757), ETHEREUM_CAPELLA_ERA)
        );
        MessageBridge.MessageProof memory genesis = _historicalProof(scene, 0, named);
        genesis.sourceHeader.slot = 0;
        _expectRejected(
            bridge_,
            genesis,
            abi.encodeWithSelector(BeaconProofVerifier.DepositBeforeCapellaEra.selector, uint64(0), ETHEREUM_CAPELLA_ERA)
        );
        _deliverAndAssert(bridge_, _historicalProof(scene, 0, named), named);
    }

    /// Claim: an era index at or above 2**24 is refused, and the last index below it is delivered. Shows: eras 758 + 2**24 and
    /// 758 + 2**24 + 2 revert with `HistoricalIndexOutOfRange(2**24)` and `(2**24 + 2)`; era 758 + 2**24 - 1 (the last
    /// list position) is delivered. The light client of the scene jumps to slots near 1.4e11, which the client accepts because it
    /// has no jump cap and the test sets the clock to that slot. Matters: index 2**24 would spill into the length mix-in side of the tree and point at another node.
    function test_HB01_era_indexAtTheListLimitRejected() public {
        uint64 lastEra = ETHEREUM_CAPELLA_ERA + uint64(2 ** 24) - 1;
        uint64 lastSlot = lastEra * 8192 + 100;
        HistoricalParams memory params = _historicalParams(
            (lastEra + 6) * 8192 + 300, ETHEREUM_CAPELLA_ERA, ELECTRA_SUMMARIES, ETHEREUM_EVIDENCE, _slots(lastSlot)
        );
        // The clock must reach the anchor slot, or the light client refuses the head as a head from the future.
        vm.warp(LIGHT_CLIENT_GENESIS_TIME + uint256(params.anchorSlot) * LIGHT_CLIENT_SECONDS_PER_SLOT);
        MessageBridge bridge_ = _historicalWorld(ETHEREUM_INITIAL_SLOT, ETHEREUM_CAPELLA_ERA);
        HistoricalScene memory scene = _historicalScene(params);
        _addBodyRows(bridge_, scene);
        _addHistoricalRow(bridge_, params, scene);
        MessageFixtures.Named memory named = MessageFixtures.deliver();

        MessageBridge.MessageProof memory atLimit = _historicalProof(scene, 0, named);
        atLimit.sourceHeader.slot = (lastEra + 1) * 8192 + 100;
        _expectRejected(
            bridge_, atLimit, abi.encodeWithSelector(BeaconProofVerifier.HistoricalIndexOutOfRange.selector, uint64(2 ** 24))
        );
        MessageBridge.MessageProof memory pastLimit = _historicalProof(scene, 0, named);
        pastLimit.sourceHeader.slot = (lastEra + 3) * 8192 + 5;
        _expectRejected(
            bridge_, pastLimit, abi.encodeWithSelector(BeaconProofVerifier.HistoricalIndexOutOfRange.selector, uint64(2 ** 24 + 2))
        );
        MessageBridge.MessageProof memory honest = _historicalProof(scene, 0, named);
        assertEq(SSZ.depthOf(_historicalLeaf(ELECTRA_SUMMARIES, ETHEREUM_CAPELLA_ERA, lastSlot)), 45);
        _deliverAndAssert(bridge_, honest, named);
    }

    /// Claim: `capellaEra` is part of the position. Shows: with the same anchor state, a bridge built with capellaEra 757
    /// cannot validate the historical row (its index is one too high, so the leaf is elsewhere): `LayoutEvidenceInvalid`.
    /// The bridge with capellaEra 758 validates it. Matters: a wrong constructor argument cannot deliver anything, and the
    /// row check catches it before any message runs.
    function test_HB01_era_wrongCapellaEraCannotValidateTheRow() public {
        MessageBridge right = _historicalWorld(ETHEREUM_INITIAL_SLOT, ETHEREUM_CAPELLA_ERA);
        HistoricalParams memory params = _ethereumParams(_slots(770 * 8192));
        HistoricalScene memory scene = _historicalScene(params);
        MessageBridge wrong = _newSecondBridge(ETHEREUM_CAPELLA_ERA - 1);
        vm.expectRevert(BeaconProofVerifier.LayoutEvidenceInvalid.selector);
        wrong.addHistoricalSummariesLayout(ELECTRA_SUMMARIES, scene.historicalEvidence);
        right.addHistoricalSummariesLayout(ELECTRA_SUMMARIES, scene.historicalEvidence);
        assertEq(right.historicalLayouts().length, 1);
        assertEq(wrong.historicalLayouts().length, 0);
    }

    // ================================================================ layout rows

    /// Claim: the historical path needs a historical row that covers the anchor slot. Shows: a bridge with the block hash
    /// rows and the recent row, but no historical row, reverts with `LayoutNotValidated(anchorSlot)`. After anyone adds the
    /// row, the same proof is delivered. Matters: the recent row does not stand in for the historical one.
    function test_HB01_layout_historicalRowRequiredAndRecentRowDoesNotCount() public {
        MessageBridge bridge_ = _historicalWorld(ETHEREUM_INITIAL_SLOT, ETHEREUM_CAPELLA_ERA);
        HistoricalParams memory params = _ethereumParams(_slots(770 * 8192));
        params.blockRootsGindex = ELECTRA_BLOCK_ROOTS;
        HistoricalScene memory scene = _historicalScene(params);
        _addBodyRows(bridge_, scene);
        _addRecentRow(bridge_, params, scene);
        MessageFixtures.Named memory named = MessageFixtures.deliver();
        _expectRejected(
            bridge_,
            _historicalProof(scene, 0, named),
            abi.encodeWithSelector(BeaconProofVerifier.LayoutNotValidated.selector, ETHEREUM_ANCHOR)
        );
        vm.prank(attacker); // any caller
        _addHistoricalRow(bridge_, params, scene);
        _deliverAndAssert(bridge_, _historicalProof(scene, 0, named), named);
    }

    /// Claim: a historical row is usable only for the anchor slots at which it was validated. Shows: a row validated at
    /// the first anchor does not cover a later anchor (`LayoutNotValidated`); evidence at the later anchor widens the same
    /// row and the later message is delivered. Matters: a row that was valid in one fork must not be assumed for later anchors.
    function test_HB01_layout_rowCoversOnlyValidatedAnchorSlots() public {
        MessageBridge bridge_ = _historicalWorld(ETHEREUM_INITIAL_SLOT, ETHEREUM_CAPELLA_ERA);
        HistoricalParams memory first = _historicalParams(
            ETHEREUM_ANCHOR, ETHEREUM_CAPELLA_ERA, ELECTRA_SUMMARIES, 6_350_000, _slots(6_300_500)
        );
        HistoricalScene memory firstScene = _historicalScene(first);
        HistoricalParams memory second = _historicalParams(
            ETHEREUM_ANCHOR + 20_000, ETHEREUM_CAPELLA_ERA, ELECTRA_SUMMARIES, 6_410_000, _slots(6_401_000)
        );
        HistoricalScene memory secondScene = _historicalScene(second);
        _addBodyRows(bridge_, firstScene);
        _addBodyRows(bridge_, secondScene);
        _addHistoricalRow(bridge_, first, firstScene);
        MessageFixtures.Named memory named = MessageFixtures.order_b();
        _expectRejected(
            bridge_,
            _historicalProof(secondScene, 0, named),
            abi.encodeWithSelector(BeaconProofVerifier.LayoutNotValidated.selector, second.anchorSlot)
        );
        _addHistoricalRow(bridge_, second, secondScene);
        BeaconProofVerifier.SlotRange[] memory rows = bridge_.historicalLayouts();
        assertEq(rows.length, 1);
        assertEq(rows[0].firstSlot, first.anchorSlot);
        assertEq(rows[0].lastSlot, second.anchorSlot);
        _deliverAndAssert(bridge_, _historicalProof(secondScene, 0, named), named);
    }

    /// Claim: a row for the wrong state depth cannot be added, in either direction. Shows: evidence from a Deneb-like
    /// state (branch of 44) offered for position 91 reverts with `BranchLengthMismatch(45, 44)`. Evidence from an
    /// Electra-like state (branch of 45) offered for position 59 reverts with `(44, 45)`. The honest positions are
    /// accepted. Matters: a bridge cannot be given the row of another fork.
    function test_HB01_layout_rowOfTheOtherForkDepthRejected() public {
        MessageBridge bridge_ = _historicalWorld(ETHEREUM_INITIAL_SLOT, ETHEREUM_CAPELLA_ERA);
        HistoricalParams memory deneb = _historicalParams(
            ETHEREUM_ANCHOR, ETHEREUM_CAPELLA_ERA, DENEB_SUMMARIES, 6_350_000, _noSlots()
        );
        HistoricalScene memory denebScene = _historicalScene(deneb);
        HistoricalParams memory electra = _historicalParams(
            ETHEREUM_ANCHOR + 20_000, ETHEREUM_CAPELLA_ERA, ELECTRA_SUMMARIES, 6_410_000, _noSlots()
        );
        HistoricalScene memory electraScene = _historicalScene(electra);
        MessageBridge wrongForDeneb = _newSecondBridge(ETHEREUM_CAPELLA_ERA);
        vm.expectRevert(_lengthMismatch(45, 44));
        wrongForDeneb.addHistoricalSummariesLayout(ELECTRA_SUMMARIES, denebScene.historicalEvidence);
        vm.expectRevert(_lengthMismatch(44, 45));
        wrongForDeneb.addHistoricalSummariesLayout(DENEB_SUMMARIES, electraScene.historicalEvidence);
        wrongForDeneb.addHistoricalSummariesLayout(DENEB_SUMMARIES, denebScene.historicalEvidence);
        wrongForDeneb.addHistoricalSummariesLayout(ELECTRA_SUMMARIES, electraScene.historicalEvidence);
        assertEq(wrongForDeneb.historicalLayouts().length, 2);
        assertEq(bridge_.historicalLayouts().length, 0);
    }

    /// Claim: a neighbour field of the same depth is not accepted as the position. Shows: for an Electra-like state,
    /// candidates 90 and 92 revert with `LayoutPositionInvalid`. For a Deneb-like state, 58 and 60 revert the same way.
    /// The honest candidates are accepted. Matters: no near miss passes for `historical_summaries`.
    function test_HB01_layout_neighbourFieldsRejected() public {
        _historicalWorld(ETHEREUM_INITIAL_SLOT, ETHEREUM_CAPELLA_ERA);
        HistoricalParams memory electra = _historicalParams(
            ETHEREUM_ANCHOR, ETHEREUM_CAPELLA_ERA, ELECTRA_SUMMARIES, 6_350_000, _noSlots()
        );
        HistoricalScene memory electraScene = _historicalScene(electra);
        HistoricalParams memory deneb = _historicalParams(
            ETHEREUM_ANCHOR + 20_000, ETHEREUM_CAPELLA_ERA, DENEB_SUMMARIES, 6_410_000, _noSlots()
        );
        HistoricalScene memory denebScene = _historicalScene(deneb);
        MessageBridge bridge_ = _newSecondBridge(ETHEREUM_CAPELLA_ERA);
        vm.expectRevert(abi.encodeWithSelector(BeaconProofVerifier.LayoutPositionInvalid.selector, uint256(90)));
        bridge_.addHistoricalSummariesLayout(90, electraScene.historicalEvidence);
        vm.expectRevert(abi.encodeWithSelector(BeaconProofVerifier.LayoutPositionInvalid.selector, uint256(92)));
        bridge_.addHistoricalSummariesLayout(92, electraScene.historicalEvidence);
        vm.expectRevert(abi.encodeWithSelector(BeaconProofVerifier.LayoutPositionInvalid.selector, uint256(58)));
        bridge_.addHistoricalSummariesLayout(58, denebScene.historicalEvidence);
        vm.expectRevert(abi.encodeWithSelector(BeaconProofVerifier.LayoutPositionInvalid.selector, uint256(60)));
        bridge_.addHistoricalSummariesLayout(60, denebScene.historicalEvidence);
        bridge_.addHistoricalSummariesLayout(ELECTRA_SUMMARIES, electraScene.historicalEvidence);
        bridge_.addHistoricalSummariesLayout(DENEB_SUMMARIES, denebScene.historicalEvidence);
        assertEq(bridge_.historicalLayouts().length, 2);
    }

    /// Claim: a row for gindex 59 cannot deliver a message at an anchor whose state uses 91, and the reverse. Shows: a
    /// bridge that holds only the Deneb-like row reverts with `LayoutNotValidated` at an Electra-like anchor; after the
    /// Electra-like row is added from that anchor's own evidence, the message is delivered. Matters: the row is chosen by the
    /// anchor slot, so a fork change in the source chain needs fresh evidence under the new state.
    function test_HB01_layout_deneb59RowCannotServeAnElectra91Anchor() public {
        MessageBridge bridge_ = _historicalWorld(ETHEREUM_INITIAL_SLOT, ETHEREUM_CAPELLA_ERA);
        HistoricalParams memory deneb = _historicalParams(
            ETHEREUM_ANCHOR, ETHEREUM_CAPELLA_ERA, DENEB_SUMMARIES, 6_350_000, _slots(6_300_500)
        );
        HistoricalScene memory denebScene = _historicalScene(deneb);
        HistoricalParams memory electra = _historicalParams(
            ETHEREUM_ANCHOR + 20_000, ETHEREUM_CAPELLA_ERA, ELECTRA_SUMMARIES, 6_410_000, _slots(6_401_000)
        );
        HistoricalScene memory electraScene = _historicalScene(electra);
        _addBodyRows(bridge_, denebScene);
        _addBodyRows(bridge_, electraScene);
        _addHistoricalRow(bridge_, deneb, denebScene);
        MessageFixtures.Named memory named = MessageFixtures.order_b();
        _expectRejected(
            bridge_,
            _historicalProof(electraScene, 0, named),
            abi.encodeWithSelector(BeaconProofVerifier.LayoutNotValidated.selector, electra.anchorSlot)
        );
        // The Deneb-like message is still delivered under its own row.
        MessageFixtures.Named memory older = MessageFixtures.deliver();
        _deliverAndAssert(bridge_, _historicalProof(denebScene, 0, older), older);
        _addHistoricalRow(bridge_, electra, electraScene);
        _deliverAndAssert(bridge_, _historicalProof(electraScene, 0, named), named);
        assertEq(bridge_.historicalLayouts().length, 2);
    }

}
