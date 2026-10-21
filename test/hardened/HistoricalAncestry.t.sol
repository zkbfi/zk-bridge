// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {console2} from "forge-std/console2.sol";
import {BridgeVault} from "../../src/hardened/BridgeVault.sol";
import {BeaconBlockHeader, SSZ} from "../../src/hardened/SSZ.sol";
import {HistoricalScenes} from "./utils/HistoricalScenes.sol";
import {ReceiptFixtures} from "./utils/ReceiptFixtures.sol";

/// @notice Tests of the historical ancestry path of `BridgeVault.withdraw`. A deposit more than 8192 slots below the
/// anchor is proven through `state.historical_summaries`. The anchor states are sparse Merkle trees that hold the
/// deposit header roots at positions that `HistoricalScenes` computes by hand. The receipts are the real fixture trie.
contract HistoricalAncestryTest is HistoricalScenes {
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

    function _ethereumParams(uint64[] memory depositSlots) internal pure returns (HistoricalParams memory) {
        return _historicalParams(ETHEREUM_ANCHOR, ETHEREUM_CAPELLA_ERA, ELECTRA_SUMMARIES, ETHEREUM_EVIDENCE, depositSlots);
    }

    /// @dev A funded vault, a scene with the given deposits, and every layout the withdrawal needs on the historical path.
    function _readyEthereum(uint64[] memory depositSlots)
        internal
        returns (BridgeVault vault_, HistoricalParams memory params, HistoricalScene memory scene)
    {
        vault_ = _historicalWorld(ETHEREUM_INITIAL_SLOT, ETHEREUM_CAPELLA_ERA);
        params = _ethereumParams(depositSlots);
        scene = _historicalScene(params);
        _addBodyRows(vault_, scene);
        _addHistoricalRow(vault_, params, scene);
    }

    /// @dev The vault, the scene and all three layout rows, for a state that holds recent and historical leaves.
    function _readyEdge()
        internal
        returns (BridgeVault vault_, HistoricalParams memory params, HistoricalScene memory scene)
    {
        vault_ = _historicalWorld(ETHEREUM_INITIAL_SLOT, ETHEREUM_CAPELLA_ERA);
        params = _ethereumParams(_slots(ETHEREUM_ANCHOR - 8192, ETHEREUM_ANCHOR - 8193));
        params.blockRootsGindex = ELECTRA_BLOCK_ROOTS;
        scene = _historicalScene(params);
        _addBodyRows(vault_, scene);
        _addHistoricalRow(vault_, params, scene);
        _addRecentRow(vault_, params, scene);
    }

    function _withdrawAndAssertPaid(
        BridgeVault vault_,
        BridgeVault.WithdrawalProof memory proof,
        ReceiptFixtures.Named memory named
    ) internal {
        uint256 before = tokenOnB.balanceOf(ReceiptFixtures.RECIPIENT);
        vault_.withdraw(proof);
        assertEq(tokenOnB.balanceOf(ReceiptFixtures.RECIPIENT) - before, named.amount, "the recipient got the logged amount");
        assertTrue(vault_.claimed(named.nonce), "the nonce is marked");
    }

    function _expectRejected(BridgeVault vault_, BridgeVault.WithdrawalProof memory proof, bytes memory revertData)
        internal
    {
        vm.expectRevert(revertData);
        vault_.withdraw(proof);
    }

    function _lengthMismatch(uint256 expected, uint256 actual) internal pure returns (bytes memory) {
        return abi.encodeWithSelector(SSZ.BranchLengthMismatch.selector, expected, actual);
    }

    /// @dev Builds a world and a scene for one deposit, then pays it. The branch length is checked against the depth that
    /// the hand-built position has.
    function _payOneHistorical(
        HistoricalParams memory params,
        uint64 initialSlot,
        ReceiptFixtures.Named memory named,
        uint256 expectedBranchLength
    ) internal {
        BridgeVault vault_ = _historicalWorld(initialSlot, params.capellaEra);
        HistoricalScene memory scene = _historicalScene(params);
        _addBodyRows(vault_, scene);
        _addHistoricalRow(vault_, params, scene);
        uint64 depositSlot = params.depositSlots[0];
        assertGt(params.anchorSlot - depositSlot, 8192, "the scene is on the historical path");
        uint256 position = _historicalLeaf(params.historicalSummariesGindex, params.capellaEra, depositSlot);
        assertEq(SSZ.depthOf(position), expectedBranchLength, "the hand-built position has the expected depth");
        BridgeVault.WithdrawalProof memory proof = _historicalProof(scene, 0, named);
        assertEq(proof.ancestryBranch.length, expectedBranchLength);
        _withdrawAndAssertPaid(vault_, proof, named);
        BridgeVault.HistoricalLayout[] memory rows = vault_.historicalLayouts();
        assertEq(rows.length, 1);
        assertEq(rows[0].historicalSummariesGindex, params.historicalSummariesGindex);
    }

    // ================================================================ the position, by hand

    /// Claim: the historical position follows the documented order: field, data root, list index, summary field, slot.
    /// Shows: with index 0 and slot 0 the position is the field shifted by 39 bits (1 + 24 + 1 + 13). The documented
    /// wrong order (both doublings after the index) gives another number. Depths are 44 for field 59 and 45 for field 91.
    /// Matters: a test helper that disagreed with the vault would build proofs that only fail, or worse, pass by accident.
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

    // ================================================================ honest historical withdrawals

    /// Claim: a deposit in the first slot of an era is paid through the historical path. Shows: era 770 slot 0 (index 12
    /// with capellaEra 758, an Electra-like state, branch of 45) pays the logged amount and marks the nonce. Matters: an
    /// off-by-one in the slot offset or in the era index would show first at an era edge.
    function test_HB01_historical_firstSlotOfAnEraPays() public {
        ReceiptFixtures.Named memory named = ReceiptFixtures.legacy();
        _payOneHistorical(_ethereumParams(_slots(770 * 8192)), ETHEREUM_INITIAL_SLOT, named, 45);
    }

    /// Claim: a deposit in the last slot of an era is paid through the historical path. Shows: era 760 slot 8191 (index 2)
    /// pays. Matters: the other era edge; the slot offset 8191 is the largest leaf of the era's block roots.
    function test_HB01_historical_lastSlotOfAnEraPays() public {
        ReceiptFixtures.Named memory named = ReceiptFixtures.access_list();
        _payOneHistorical(_ethereumParams(_slots(761 * 8192 - 1)), ETHEREUM_INITIAL_SLOT, named, 45);
    }

    /// Claim: a deposit in the very first Capella era (index 0) is paid. Shows: era 758 pays, with a type 2 receipt.
    /// Matters: index 0 is the first summary of the list. The era formula must subtract capellaEra and not more.
    function test_HB01_historical_firstCapellaEraPays() public {
        ReceiptFixtures.Named memory named = ReceiptFixtures.type2();
        _payOneHistorical(_ethereumParams(_slots(758 * 8192 + 4000)), ETHEREUM_INITIAL_SLOT, named, 45);
    }

    /// Claim: the very first slot of the very first Capella era is paid. Shows: slot 6209536 (index 0, offset 0) pays.
    /// Matters: the lowest position the vault can ever accept on this chain.
    function test_HB01_historical_firstSlotOfFirstCapellaEraPays() public {
        ReceiptFixtures.Named memory named = ReceiptFixtures.legacy();
        _payOneHistorical(_ethereumParams(_slots(758 * 8192)), ETHEREUM_INITIAL_SLOT, named, 45);
    }

    /// Claim: a later era is paid. Shows: era 779 (index 21) pays, one era below the last complete era of the anchor.
    /// Matters: the index grows with the era, so a large index must land at the right list position.
    function test_HB01_historical_laterEraPays() public {
        ReceiptFixtures.Named memory named = ReceiptFixtures.type2();
        _payOneHistorical(_ethereumParams(_slots(779 * 8192 + 1234)), ETHEREUM_INITIAL_SLOT, named, 45);
    }

    /// Claim: a Capella or Deneb state (field 59, branch of 44) is paid by the same code. Shows: a Deneb-like state with
    /// the same capellaEra pays. Matters: the vault holds no fork table, so both depths must work from the layout row alone.
    function test_HB01_historical_denebLayoutPays() public {
        HistoricalParams memory params = _historicalParams(
            ETHEREUM_ANCHOR, ETHEREUM_CAPELLA_ERA, DENEB_SUMMARIES, ETHEREUM_EVIDENCE, _slots(775 * 8192 + 99)
        );
        _payOneHistorical(params, ETHEREUM_INITIAL_SLOT, ReceiptFixtures.type2(), 44);
    }

    /// Claim: a PulseChain-like chain (capellaEra 0, Capella-layout state) pays era 0, index 0. Shows: a deposit in slot 100
    /// is paid; the light client of this scene starts at slot 32. Matters: with capellaEra 0 the index equals the era.
    function test_HB01_historical_pulseChainLikeEraZeroPays() public {
        HistoricalParams memory params = _historicalParams(120_000, 0, DENEB_SUMMARIES, 20_000, _slots(100));
        _payOneHistorical(params, 32, ReceiptFixtures.legacy(), 44);
    }

    /// Claim: several deposits of different eras under one anchor are each paid once, and a second claim is refused.
    /// Shows: three eras pay three different receipts; repeating the first claim reverts with `AlreadyClaimed`.
    /// Matters: the historical path uses the same nonce book as the recent path.
    function test_HB01_historical_severalErasUnderOneAnchorPayOnceEach() public {
        (BridgeVault vault_,, HistoricalScene memory scene) =
            _readyEthereum(_slots(758 * 8192, 761 * 8192 - 1, 770 * 8192));
        ReceiptFixtures.Named memory first = ReceiptFixtures.legacy();
        ReceiptFixtures.Named memory second = ReceiptFixtures.access_list();
        ReceiptFixtures.Named memory third = ReceiptFixtures.type2();
        _withdrawAndAssertPaid(vault_, _historicalProof(scene, 0, first), first);
        _withdrawAndAssertPaid(vault_, _historicalProof(scene, 1, second), second);
        _withdrawAndAssertPaid(vault_, _historicalProof(scene, 2, third), third);
        _expectRejected(
            vault_,
            _historicalProof(scene, 0, first),
            abi.encodeWithSelector(BridgeVault.AlreadyClaimed.selector, first.nonce)
        );
    }

    // ================================================================ the path by distance

    /// Claim: a deposit exactly 8192 slots below the anchor takes the recent path, and a deposit 8193 below takes the
    /// historical path. Shows: with one anchor that holds both leaves, the recent branch (19 entries) pays at 8192 and
    /// the historical branch (45 entries) pays at 8193. Matters: the boundary of the two paths is exact.
    function test_HB01_edge_distance8192IsRecentAnd8193IsHistorical() public {
        (BridgeVault vault_,, HistoricalScene memory scene) = _readyEdge();
        ReceiptFixtures.Named memory recentReceipt = ReceiptFixtures.legacy();
        ReceiptFixtures.Named memory historicalReceipt = ReceiptFixtures.type2();
        BridgeVault.WithdrawalProof memory recent = _recentProof(scene, 0, recentReceipt);
        BridgeVault.WithdrawalProof memory historical = _historicalProof(scene, 1, historicalReceipt);
        assertEq(recent.depositHeader.slot, ETHEREUM_ANCHOR - 8192);
        assertEq(recent.ancestryBranch.length, 19);
        assertEq(historical.depositHeader.slot, ETHEREUM_ANCHOR - 8193);
        assertEq(historical.ancestryBranch.length, 45);
        _withdrawAndAssertPaid(vault_, recent, recentReceipt);
        _withdrawAndAssertPaid(vault_, historical, historicalReceipt);
    }

    /// Claim: the recent branch is refused at distance 8193. Shows: the same deposit, with a state that really holds its
    /// header root at the recent position, reverts with `BranchLengthMismatch(45, 19)`: the vault expects the historical
    /// length. The control (the historical branch) pays. Matters: the prover cannot pick the path. A state that holds a
    /// stale root in `block_roots` for a slot that the ring already overwrote cannot be used.
    function test_HB01_edge_recentBranchAtDistance8193Refused() public {
        (BridgeVault vault_,, HistoricalScene memory scene) = _readyEdge();
        ReceiptFixtures.Named memory named = ReceiptFixtures.type2();
        _expectRejected(vault_, _recentProof(scene, 1, named), _lengthMismatch(45, 19));
        _withdrawAndAssertPaid(vault_, _historicalProof(scene, 1, named), named);
    }

    /// Claim: the historical branch is refused at distance 8192. Shows: reverts with `BranchLengthMismatch(19, 45)`; the
    /// control (the recent branch) pays. Matters: the vault never accepts the longer path for a deposit that is still in
    /// `block_roots`, so the two paths cannot be mixed to dodge a layout row.
    function test_HB01_edge_historicalBranchAtDistance8192Refused() public {
        (BridgeVault vault_,, HistoricalScene memory scene) = _readyEdge();
        ReceiptFixtures.Named memory named = ReceiptFixtures.legacy();
        _expectRejected(vault_, _historicalProof(scene, 0, named), _lengthMismatch(19, 45));
        _withdrawAndAssertPaid(vault_, _recentProof(scene, 0, named), named);
    }

    /// Claim: a deposit that is not strictly before the anchor is refused on the historical scene too. Shows: the anchor
    /// slot and a slot after it revert with `DepositNotBeforeAnchor`; the control pays. Matters: the check runs before any
    /// layout row or era rule, so a slot after the anchor never reaches the era arithmetic.
    function test_HB01_edge_depositNotBeforeAnchorRejected() public {
        (BridgeVault vault_,, HistoricalScene memory scene) = _readyEdge();
        ReceiptFixtures.Named memory named = ReceiptFixtures.type2();
        BridgeVault.WithdrawalProof memory same = _historicalProof(scene, 1, named);
        same.depositHeader.slot = ETHEREUM_ANCHOR;
        _expectRejected(
            vault_, same, abi.encodeWithSelector(BridgeVault.DepositNotBeforeAnchor.selector, ETHEREUM_ANCHOR, ETHEREUM_ANCHOR)
        );
        BridgeVault.WithdrawalProof memory later = _historicalProof(scene, 1, named);
        later.depositHeader.slot = ETHEREUM_ANCHOR + 3;
        _expectRejected(
            vault_,
            later,
            abi.encodeWithSelector(BridgeVault.DepositNotBeforeAnchor.selector, ETHEREUM_ANCHOR + 3, ETHEREUM_ANCHOR)
        );
        _withdrawAndAssertPaid(vault_, _historicalProof(scene, 1, named), named);
    }

    // ================================================================ exact branch lengths

    /// Claim: on an Electra or Fulu state (field 91) the historical branch has exactly 45 entries. Shows: one extra entry
    /// reverts with `BranchLengthMismatch(45, 46)`, one missing entry with `(45, 44)`, an empty branch with `(45, 0)`.
    /// The control (45 entries) pays. Matters: padding must not turn a wrong path into a pass.
    function test_HB01_branchLength_electraNeedsExactly45() public {
        (BridgeVault vault_,, HistoricalScene memory scene) = _readyEthereum(_slots(770 * 8192));
        ReceiptFixtures.Named memory named = ReceiptFixtures.legacy();
        bytes32[] memory honest = scene.historicalBranches[0];
        assertEq(honest.length, 45);
        _expectRejected(
            vault_,
            _proofWithBranch(scene, 0, named, _concat(honest, _repeat(keccak256("one more"), 1))),
            _lengthMismatch(45, 46)
        );
        _expectRejected(vault_, _proofWithBranch(scene, 0, named, _slice(honest, 0, 44)), _lengthMismatch(45, 44));
        _expectRejected(vault_, _proofWithBranch(scene, 0, named, new bytes32[](0)), _lengthMismatch(45, 0));
        _withdrawAndAssertPaid(vault_, _historicalProof(scene, 0, named), named);
    }

    /// Claim: on a Capella or Deneb state (field 59) the historical branch has exactly 44 entries. Shows: 45 reverts with
    /// `BranchLengthMismatch(44, 45)` and 43 with `(44, 43)`; the control pays. Matters: the same as above for the
    /// shallower state, and a branch for the other fork never fits.
    function test_HB01_branchLength_denebNeedsExactly44() public {
        BridgeVault vault_ = _historicalWorld(ETHEREUM_INITIAL_SLOT, ETHEREUM_CAPELLA_ERA);
        HistoricalParams memory params = _historicalParams(
            ETHEREUM_ANCHOR, ETHEREUM_CAPELLA_ERA, DENEB_SUMMARIES, ETHEREUM_EVIDENCE, _slots(770 * 8192)
        );
        HistoricalScene memory scene = _historicalScene(params);
        _addBodyRows(vault_, scene);
        _addHistoricalRow(vault_, params, scene);
        ReceiptFixtures.Named memory named = ReceiptFixtures.legacy();
        bytes32[] memory honest = scene.historicalBranches[0];
        assertEq(honest.length, 44);
        _expectRejected(
            vault_,
            _proofWithBranch(scene, 0, named, _concat(honest, _repeat(keccak256("one more"), 1))),
            _lengthMismatch(44, 45)
        );
        _expectRejected(vault_, _proofWithBranch(scene, 0, named, _slice(honest, 0, 43)), _lengthMismatch(44, 43));
        _withdrawAndAssertPaid(vault_, _historicalProof(scene, 0, named), named);
    }

    /// Claim: a changed sibling at any of the 45 levels is refused with `AncestryBranchInvalid`. Shows: every position of
    /// the branch, changed one at a time, reverts; the control pays. Matters: each level of the path (era block roots,
    /// summary pair, list, length mix-in, state fields) is bound to the anchor state root.
    function test_HB01_branchTamper_everyLevelRejected() public {
        (BridgeVault vault_,, HistoricalScene memory scene) = _readyEthereum(_slots(770 * 8192 + 17));
        ReceiptFixtures.Named memory named = ReceiptFixtures.legacy();
        for (uint256 level = 0; level < 45; level++) {
            BridgeVault.WithdrawalProof memory proof = _historicalProof(scene, 0, named);
            proof.ancestryBranch[level] = keccak256(abi.encode("attacker sibling", level));
            _expectRejected(vault_, proof, abi.encodeWithSelector(BridgeVault.AncestryBranchInvalid.selector));
        }
        _withdrawAndAssertPaid(vault_, _historicalProof(scene, 0, named), named);
    }

    /// Claim: the deposit header, its slot offset and its era are each bound by the branch. Shows: a changed proposer
    /// index, a slot one higher in the same era, and the same offset in the next era each revert with
    /// `AncestryBranchInvalid`. The control pays. Matters: a valid branch for one deposit never proves another.
    function test_HB01_branchTamper_headerAndSlotRejected() public {
        (BridgeVault vault_,, HistoricalScene memory scene) = _readyEthereum(_slots(770 * 8192 + 17));
        ReceiptFixtures.Named memory named = ReceiptFixtures.legacy();
        bytes memory refused = abi.encodeWithSelector(BridgeVault.AncestryBranchInvalid.selector);
        BridgeVault.WithdrawalProof memory header = _historicalProof(scene, 0, named);
        header.depositHeader.proposerIndex += 1;
        _expectRejected(vault_, header, refused);
        BridgeVault.WithdrawalProof memory offset = _historicalProof(scene, 0, named);
        offset.depositHeader.slot += 1;
        _expectRejected(vault_, offset, refused);
        BridgeVault.WithdrawalProof memory nextEra = _historicalProof(scene, 0, named);
        nextEra.depositHeader.slot += 8192;
        _expectRejected(vault_, nextEra, refused);
        _withdrawAndAssertPaid(vault_, _historicalProof(scene, 0, named), named);
    }

    // ================================================================ era rules

    /// Claim: a deposit in an era before `capellaEra` is refused. Shows: the last slot of era 757 reverts with
    /// `DepositBeforeCapellaEra(757, 758)`, slot 0 with `(0, 758)`; the first slot of era 758 pays. Matters: no summary
    /// exists for earlier eras, and the index `era - capellaEra` would underflow.
    function test_HB01_era_depositBeforeCapellaEraRejected() public {
        (BridgeVault vault_,, HistoricalScene memory scene) = _readyEthereum(_slots(758 * 8192));
        ReceiptFixtures.Named memory named = ReceiptFixtures.legacy();
        BridgeVault.WithdrawalProof memory lastOfPrevious = _historicalProof(scene, 0, named);
        lastOfPrevious.depositHeader.slot = 758 * 8192 - 1;
        _expectRejected(
            vault_,
            lastOfPrevious,
            abi.encodeWithSelector(BridgeVault.DepositBeforeCapellaEra.selector, uint64(757), ETHEREUM_CAPELLA_ERA)
        );
        BridgeVault.WithdrawalProof memory genesis = _historicalProof(scene, 0, named);
        genesis.depositHeader.slot = 0;
        _expectRejected(
            vault_,
            genesis,
            abi.encodeWithSelector(BridgeVault.DepositBeforeCapellaEra.selector, uint64(0), ETHEREUM_CAPELLA_ERA)
        );
        _withdrawAndAssertPaid(vault_, _historicalProof(scene, 0, named), named);
    }

    /// Claim: an era index at or above 2**24 is refused, and the last index below it pays. Shows: eras 758 + 2**24 and
    /// 758 + 2**24 + 2 revert with `HistoricalIndexOutOfRange(2**24)` and `(2**24 + 2)`; era 758 + 2**24 - 1 (the last
    /// list position) pays. The light client of the scene jumps to slots near 1.4e11, which the client accepts because it
    /// has no jump cap and the test sets the clock to that slot. Matters: index 2**24 would spill into the length mix-in side of the tree and point at another node.
    function test_HB01_era_indexAtTheListLimitRejected() public {
        uint64 lastEra = ETHEREUM_CAPELLA_ERA + uint64(2 ** 24) - 1;
        uint64 lastSlot = lastEra * 8192 + 100;
        HistoricalParams memory params = _historicalParams(
            (lastEra + 6) * 8192 + 300, ETHEREUM_CAPELLA_ERA, ELECTRA_SUMMARIES, ETHEREUM_EVIDENCE, _slots(lastSlot)
        );
        // The clock must reach the anchor slot, or the light client refuses the head as a head from the future.
        vm.warp(LIGHT_CLIENT_GENESIS_TIME + uint256(params.anchorSlot) * LIGHT_CLIENT_SECONDS_PER_SLOT);
        BridgeVault vault_ = _historicalWorld(ETHEREUM_INITIAL_SLOT, ETHEREUM_CAPELLA_ERA);
        HistoricalScene memory scene = _historicalScene(params);
        _addBodyRows(vault_, scene);
        _addHistoricalRow(vault_, params, scene);
        ReceiptFixtures.Named memory named = ReceiptFixtures.legacy();

        BridgeVault.WithdrawalProof memory atLimit = _historicalProof(scene, 0, named);
        atLimit.depositHeader.slot = (lastEra + 1) * 8192 + 100;
        _expectRejected(
            vault_, atLimit, abi.encodeWithSelector(BridgeVault.HistoricalIndexOutOfRange.selector, uint64(2 ** 24))
        );
        BridgeVault.WithdrawalProof memory pastLimit = _historicalProof(scene, 0, named);
        pastLimit.depositHeader.slot = (lastEra + 3) * 8192 + 5;
        _expectRejected(
            vault_, pastLimit, abi.encodeWithSelector(BridgeVault.HistoricalIndexOutOfRange.selector, uint64(2 ** 24 + 2))
        );
        BridgeVault.WithdrawalProof memory honest = _historicalProof(scene, 0, named);
        assertEq(SSZ.depthOf(_historicalLeaf(ELECTRA_SUMMARIES, ETHEREUM_CAPELLA_ERA, lastSlot)), 45);
        _withdrawAndAssertPaid(vault_, honest, named);
    }

    /// Claim: `capellaEra` is part of the position. Shows: with the same anchor state, a vault built with capellaEra 757
    /// cannot validate the historical row (its index is one too high, so the leaf is elsewhere): `LayoutEvidenceInvalid`.
    /// The vault with capellaEra 758 validates it. Matters: a wrong constructor argument cannot pay anything, and the row
    /// check catches it before any money moves.
    function test_HB01_era_wrongCapellaEraCannotValidateTheRow() public {
        BridgeVault right = _historicalWorld(ETHEREUM_INITIAL_SLOT, ETHEREUM_CAPELLA_ERA);
        HistoricalParams memory params = _ethereumParams(_slots(770 * 8192));
        HistoricalScene memory scene = _historicalScene(params);
        BridgeVault wrong = _newSecondWithdrawalVault(0, ETHEREUM_CAPELLA_ERA - 1);
        vm.expectRevert(BridgeVault.LayoutEvidenceInvalid.selector);
        wrong.addHistoricalSummariesLayout(ELECTRA_SUMMARIES, scene.historicalEvidence);
        right.addHistoricalSummariesLayout(ELECTRA_SUMMARIES, scene.historicalEvidence);
        assertEq(right.historicalLayouts().length, 1);
        assertEq(wrong.historicalLayouts().length, 0);
    }

    // ================================================================ layout rows

    /// Claim: the historical path needs a historical row that covers the anchor slot. Shows: a vault with the block hash
    /// rows and the recent row, but no historical row, reverts with `LayoutNotValidated(anchorSlot)`. After anyone adds the
    /// row, the same proof pays. Matters: the recent row does not stand in for the historical one.
    function test_HB01_layout_historicalRowRequiredAndRecentRowDoesNotCount() public {
        BridgeVault vault_ = _historicalWorld(ETHEREUM_INITIAL_SLOT, ETHEREUM_CAPELLA_ERA);
        HistoricalParams memory params = _ethereumParams(_slots(770 * 8192));
        params.blockRootsGindex = ELECTRA_BLOCK_ROOTS;
        HistoricalScene memory scene = _historicalScene(params);
        _addBodyRows(vault_, scene);
        _addRecentRow(vault_, params, scene);
        ReceiptFixtures.Named memory named = ReceiptFixtures.legacy();
        _expectRejected(
            vault_,
            _historicalProof(scene, 0, named),
            abi.encodeWithSelector(BridgeVault.LayoutNotValidated.selector, ETHEREUM_ANCHOR)
        );
        vm.prank(attacker); // any caller
        _addHistoricalRow(vault_, params, scene);
        _withdrawAndAssertPaid(vault_, _historicalProof(scene, 0, named), named);
    }

    /// Claim: a historical row is usable only for the anchor slots at which it was validated. Shows: a row validated at
    /// the first anchor does not cover a later anchor (`LayoutNotValidated`); evidence at the later anchor widens the same
    /// row and the later deposit pays. Matters: a row that was valid in one fork must not be assumed for later anchors.
    function test_HB01_layout_rowCoversOnlyValidatedAnchorSlots() public {
        BridgeVault vault_ = _historicalWorld(ETHEREUM_INITIAL_SLOT, ETHEREUM_CAPELLA_ERA);
        HistoricalParams memory first = _historicalParams(
            ETHEREUM_ANCHOR, ETHEREUM_CAPELLA_ERA, ELECTRA_SUMMARIES, 6_350_000, _slots(6_300_500)
        );
        HistoricalScene memory firstScene = _historicalScene(first);
        HistoricalParams memory second = _historicalParams(
            ETHEREUM_ANCHOR + 20_000, ETHEREUM_CAPELLA_ERA, ELECTRA_SUMMARIES, 6_410_000, _slots(6_401_000)
        );
        HistoricalScene memory secondScene = _historicalScene(second);
        _addBodyRows(vault_, firstScene);
        _addBodyRows(vault_, secondScene);
        _addHistoricalRow(vault_, first, firstScene);
        ReceiptFixtures.Named memory named = ReceiptFixtures.type2();
        _expectRejected(
            vault_,
            _historicalProof(secondScene, 0, named),
            abi.encodeWithSelector(BridgeVault.LayoutNotValidated.selector, second.anchorSlot)
        );
        _addHistoricalRow(vault_, second, secondScene);
        BridgeVault.HistoricalLayout[] memory rows = vault_.historicalLayouts();
        assertEq(rows.length, 1);
        assertEq(rows[0].firstSlot, first.anchorSlot);
        assertEq(rows[0].lastSlot, second.anchorSlot);
        _withdrawAndAssertPaid(vault_, _historicalProof(secondScene, 0, named), named);
    }

    /// Claim: a row for the wrong state depth cannot be added, in either direction. Shows: evidence from a Deneb-like
    /// state (branch of 44) offered for position 91 reverts with `BranchLengthMismatch(45, 44)`. Evidence from an
    /// Electra-like state (branch of 45) offered for position 59 reverts with `(44, 45)`. The honest positions are
    /// accepted. Matters: a vault cannot be given the row of another fork.
    function test_HB01_layout_rowOfTheOtherForkDepthRejected() public {
        BridgeVault vault_ = _historicalWorld(ETHEREUM_INITIAL_SLOT, ETHEREUM_CAPELLA_ERA);
        HistoricalParams memory deneb = _historicalParams(
            ETHEREUM_ANCHOR, ETHEREUM_CAPELLA_ERA, DENEB_SUMMARIES, 6_350_000, _noSlots()
        );
        HistoricalScene memory denebScene = _historicalScene(deneb);
        HistoricalParams memory electra = _historicalParams(
            ETHEREUM_ANCHOR + 20_000, ETHEREUM_CAPELLA_ERA, ELECTRA_SUMMARIES, 6_410_000, _noSlots()
        );
        HistoricalScene memory electraScene = _historicalScene(electra);
        BridgeVault wrongForDeneb = _newSecondWithdrawalVault(0, ETHEREUM_CAPELLA_ERA);
        vm.expectRevert(_lengthMismatch(45, 44));
        wrongForDeneb.addHistoricalSummariesLayout(ELECTRA_SUMMARIES, denebScene.historicalEvidence);
        vm.expectRevert(_lengthMismatch(44, 45));
        wrongForDeneb.addHistoricalSummariesLayout(DENEB_SUMMARIES, electraScene.historicalEvidence);
        wrongForDeneb.addHistoricalSummariesLayout(DENEB_SUMMARIES, denebScene.historicalEvidence);
        wrongForDeneb.addHistoricalSummariesLayout(ELECTRA_SUMMARIES, electraScene.historicalEvidence);
        assertEq(wrongForDeneb.historicalLayouts().length, 2);
        assertEq(vault_.historicalLayouts().length, 0);
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
        BridgeVault vault_ = _newSecondWithdrawalVault(0, ETHEREUM_CAPELLA_ERA);
        vm.expectRevert(abi.encodeWithSelector(BridgeVault.LayoutPositionInvalid.selector, uint256(90)));
        vault_.addHistoricalSummariesLayout(90, electraScene.historicalEvidence);
        vm.expectRevert(abi.encodeWithSelector(BridgeVault.LayoutPositionInvalid.selector, uint256(92)));
        vault_.addHistoricalSummariesLayout(92, electraScene.historicalEvidence);
        vm.expectRevert(abi.encodeWithSelector(BridgeVault.LayoutPositionInvalid.selector, uint256(58)));
        vault_.addHistoricalSummariesLayout(58, denebScene.historicalEvidence);
        vm.expectRevert(abi.encodeWithSelector(BridgeVault.LayoutPositionInvalid.selector, uint256(60)));
        vault_.addHistoricalSummariesLayout(60, denebScene.historicalEvidence);
        vault_.addHistoricalSummariesLayout(ELECTRA_SUMMARIES, electraScene.historicalEvidence);
        vault_.addHistoricalSummariesLayout(DENEB_SUMMARIES, denebScene.historicalEvidence);
        assertEq(vault_.historicalLayouts().length, 2);
    }

    /// Claim: a row for gindex 59 cannot pay a withdrawal at an anchor whose state uses 91, and the reverse. Shows: a
    /// vault that holds only the Deneb-like row reverts with `LayoutNotValidated` at an Electra-like anchor; after the
    /// Electra-like row is added from that anchor's own evidence, the deposit pays. Matters: the row is chosen by the
    /// anchor slot, so a fork change in the source chain needs fresh evidence under the new state.
    function test_HB01_layout_deneb59RowCannotPayAtAnElectra91Anchor() public {
        BridgeVault vault_ = _historicalWorld(ETHEREUM_INITIAL_SLOT, ETHEREUM_CAPELLA_ERA);
        HistoricalParams memory deneb = _historicalParams(
            ETHEREUM_ANCHOR, ETHEREUM_CAPELLA_ERA, DENEB_SUMMARIES, 6_350_000, _slots(6_300_500)
        );
        HistoricalScene memory denebScene = _historicalScene(deneb);
        HistoricalParams memory electra = _historicalParams(
            ETHEREUM_ANCHOR + 20_000, ETHEREUM_CAPELLA_ERA, ELECTRA_SUMMARIES, 6_410_000, _slots(6_401_000)
        );
        HistoricalScene memory electraScene = _historicalScene(electra);
        _addBodyRows(vault_, denebScene);
        _addBodyRows(vault_, electraScene);
        _addHistoricalRow(vault_, deneb, denebScene);
        ReceiptFixtures.Named memory named = ReceiptFixtures.type2();
        _expectRejected(
            vault_,
            _historicalProof(electraScene, 0, named),
            abi.encodeWithSelector(BridgeVault.LayoutNotValidated.selector, electra.anchorSlot)
        );
        // The Deneb-like deposit still pays under its own row.
        ReceiptFixtures.Named memory older = ReceiptFixtures.legacy();
        _withdrawAndAssertPaid(vault_, _historicalProof(denebScene, 0, older), older);
        _addHistoricalRow(vault_, electra, electraScene);
        _withdrawAndAssertPaid(vault_, _historicalProof(electraScene, 0, named), named);
        assertEq(vault_.historicalLayouts().length, 2);
    }

    // ================================================================ gas

    /// Claim: a recent withdrawal (branch of 19, type 2 receipt of the 140 receipt trie) costs a bounded amount of gas.
    /// Shows: the measured gas of one cold withdrawal (386665) is printed and bounded about 20 percent above. Matters: the comparison point for the
    /// historical path below.
    function test_HB01_gas_recentWithdrawal() public {
        (BridgeVault vault_,, HistoricalScene memory scene) = _readyEdge();
        BridgeVault.WithdrawalProof memory recent = _recentProof(scene, 0, ReceiptFixtures.type2());
        uint256 before = gasleft();
        vault_.withdraw(recent);
        uint256 used = before - gasleft();
        console2.log("recent withdraw gas (branch of 19)", used);
        assertLt(used, RECENT_GAS_BOUND);
    }

    /// Claim: a historical withdrawal (branch of 45, same receipt) costs only a little more than a recent one. Shows: the
    /// measured gas of one cold withdrawal is printed and bounded about 20 percent above the measurement (418069
    /// gas; the recent one measured 386665). Matters: the user pays this once per claim, and an old deposit adds no
    /// storage reads beyond the layout row.
    function test_HB01_gas_historicalWithdrawal() public {
        (BridgeVault vault_,, HistoricalScene memory scene) = _readyEdge();
        BridgeVault.WithdrawalProof memory historical = _historicalProof(scene, 1, ReceiptFixtures.type2());
        uint256 before = gasleft();
        vault_.withdraw(historical);
        uint256 used = before - gasleft();
        console2.log("historical withdraw gas (branch of 45)", used);
        assertLt(used, HISTORICAL_GAS_BOUND);
    }

    uint256 internal constant RECENT_GAS_BOUND = 465_000;
    uint256 internal constant HISTORICAL_GAS_BOUND = 505_000;
}
