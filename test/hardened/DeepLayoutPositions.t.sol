// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {BridgeVault} from "../../src/hardened/BridgeVault.sol";
import {BeaconProofVerifier} from "../../src/hardened/BeaconProofVerifier.sol";
import {SSZ} from "../../src/hardened/SSZ.sol";
import {HistoricalScenes} from "./utils/HistoricalScenes.sol";
import {ReceiptFixtures} from "./utils/ReceiptFixtures.sol";

/// @notice Tests of the deeper layout positions that the vault rule also allows: `block_roots` at 133 and
/// `historical_summaries` at 155 (a state of 128 leaves), and the block hash at 668 and 1324 (a body of 32 leaves).
/// No layout of today (Capella, Deneb, Electra, Fulu) has a field there. Each position must refuse evidence of today's
/// layouts, and must accept a synthetic state or body of the matching depth, so the rule stays correct for a later fork.
/// Capella and Deneb share one state shape (37 and 59), so one scene stands for both. The body differs: 412 in Capella,
/// 812 from Deneb on.
contract DeepLayoutPositionsTest is HistoricalScenes {
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

    /// @dev A vault with no layout, and two stored states of today: a Capella or Deneb one (`block_roots` 37,
    /// `historical_summaries` 59) and an Electra or Fulu one (69 and 91).
    function _todaysStates()
        internal
        returns (BridgeVault vault_, HistoricalScene memory capellaLike, HistoricalScene memory electraLike)
    {
        _historicalWorld(FIRST_STORED_SLOT, CAPELLA_ERA);
        HistoricalParams memory capellaParams = _historicalParams(ANCHOR, CAPELLA_ERA, 59, EVIDENCE, _noSlots());
        capellaParams.blockRootsGindex = 37;
        HistoricalParams memory electraParams =
            _historicalParams(SECOND_ANCHOR, CAPELLA_ERA, 91, SECOND_EVIDENCE, _noSlots());
        electraParams.blockRootsGindex = 69;
        capellaLike = _historicalScene(capellaParams);
        electraLike = _historicalScene(electraParams);
        vault_ = _newSecondWithdrawalVault(0, CAPELLA_ERA);
    }

    /// @dev A vault with no layout, and the body evidence of today: Capella (412) and Deneb or Electra (812).
    function _todaysBodies()
        internal
        returns (BridgeVault vault_, BeaconProofVerifier.BlockHashEvidence memory capella, BeaconProofVerifier.BlockHashEvidence memory deneb)
    {
        SceneParams memory capellaParams = _defaultParams();
        capellaParams.anchorBodyGindex = 412;
        capellaParams.blockHashGindex = 412;
        capella = _scene(ReceiptFixtures.type2(), capellaParams).anchorBodyEvidence;
        deneb = _scene(ReceiptFixtures.type2(), _defaultParams()).anchorBodyEvidence;
        vault_ = _newWithdrawalVault();
    }

    // ================================================================ block_roots at 133: refused

    /// Claim: evidence of today's layouts cannot be accepted at `block_roots` position 133. Shows: the Capella shape
    /// (branch of 18) reverts with `BranchLengthMismatch(20, 18)` and the Electra shape (19) with `(20, 19)`. A branch
    /// padded to the full length of 20 passes the length check and reverts with `LayoutEvidenceInvalid`. The honest
    /// positions 37 and 69 are accepted first, as the control. Matters: no state of today holds `block_roots` at depth 7.
    function test_HB03_deepBlockRoots133_evidenceOfTodaysLayoutsRefused() public {
        (BridgeVault vault_, HistoricalScene memory capellaLike, HistoricalScene memory electraLike) = _todaysStates();
        vault_.addBlockRootsLayout(37, capellaLike.rootsEvidence);
        vault_.addBlockRootsLayout(69, electraLike.rootsEvidence);
        assertEq(vault_.stateLayouts().length, 2);
        BeaconProofVerifier.BlockRootsEvidence memory capella = capellaLike.rootsEvidence;
        BeaconProofVerifier.BlockRootsEvidence memory electra = electraLike.rootsEvidence;
        assertEq(capella.branchA.length, 18);
        assertEq(electra.branchA.length, 19);

        vm.expectRevert(_lengthMismatch(20, 18));
        vault_.addBlockRootsLayout(DEEP_BLOCK_ROOTS, capella);
        vm.expectRevert(_lengthMismatch(20, 19));
        vault_.addBlockRootsLayout(DEEP_BLOCK_ROOTS, electra);

        capella.branchA = _padTo(capella.branchA, 20);
        vm.expectRevert(BeaconProofVerifier.LayoutEvidenceInvalid.selector);
        vault_.addBlockRootsLayout(DEEP_BLOCK_ROOTS, capella);
        electra.branchA = _padTo(electra.branchA, 20);
        vm.expectRevert(BeaconProofVerifier.LayoutEvidenceInvalid.selector);
        vault_.addBlockRootsLayout(DEEP_BLOCK_ROOTS, electra);

    }

    // ================================================================ historical_summaries at 155: refused

    /// Claim: evidence of today's layouts cannot be accepted at `historical_summaries` position 155. Shows: the Capella
    /// shape (branch of 44) reverts with `BranchLengthMismatch(46, 44)` and the Electra shape (45) with `(46, 45)`.
    /// A branch padded to 46 reverts with `LayoutEvidenceInvalid`. The honest positions 59 and 91 are accepted first, as the control.
    /// Matters: no state of today holds `historical_summaries` at depth 7.
    function test_HB03_deepSummaries155_evidenceOfTodaysLayoutsRefused() public {
        (BridgeVault vault_, HistoricalScene memory capellaLike, HistoricalScene memory electraLike) = _todaysStates();
        vault_.addHistoricalSummariesLayout(59, capellaLike.historicalEvidence);
        vault_.addHistoricalSummariesLayout(91, electraLike.historicalEvidence);
        assertEq(vault_.historicalLayouts().length, 2);
        BeaconProofVerifier.HistoricalSummariesEvidence memory capella = capellaLike.historicalEvidence;
        BeaconProofVerifier.HistoricalSummariesEvidence memory electra = electraLike.historicalEvidence;
        assertEq(capella.branch.length, 44);
        assertEq(electra.branch.length, 45);

        vm.expectRevert(_lengthMismatch(46, 44));
        vault_.addHistoricalSummariesLayout(DEEP_SUMMARIES, capella);
        vm.expectRevert(_lengthMismatch(46, 45));
        vault_.addHistoricalSummariesLayout(DEEP_SUMMARIES, electra);

        capella.branch = _padTo(capella.branch, 46);
        vm.expectRevert(BeaconProofVerifier.LayoutEvidenceInvalid.selector);
        vault_.addHistoricalSummariesLayout(DEEP_SUMMARIES, capella);
        electra.branch = _padTo(electra.branch, 46);
        vm.expectRevert(BeaconProofVerifier.LayoutEvidenceInvalid.selector);
        vault_.addHistoricalSummariesLayout(DEEP_SUMMARIES, electra);

    }

    // ================================================================ block hash at 668 and 1324: refused

    /// Claim: evidence of today's layouts cannot be accepted at block hash position 668 (body of 32 leaves, payload of
    /// 16). Shows: the Capella shape (branch of 8) reverts with `BranchLengthMismatch(9, 8)`. The Deneb shape has the
    /// same length of 9 as position 668, so only the hash check can refuse it: `LayoutEvidenceInvalid`, because the
    /// branch was built for the path of 812. A Capella branch padded to 9 reverts the same way. The honest positions 412
    /// and 812 are accepted. Matters: the length check alone does not separate 668 from 812.
    function test_HB04_deepBlockHash668_evidenceOfTodaysLayoutsRefused() public {
        (BridgeVault vault_, BeaconProofVerifier.BlockHashEvidence memory capella, BeaconProofVerifier.BlockHashEvidence memory deneb) =
            _todaysBodies();
        assertEq(capella.branch.length, 8);
        assertEq(deneb.branch.length, 9);

        vm.expectRevert(_lengthMismatch(9, 8));
        vault_.addBlockHashLayout(DEEP_BODY_FIVE_PAYLOAD_FOUR, capella);
        vm.expectRevert(BeaconProofVerifier.LayoutEvidenceInvalid.selector);
        vault_.addBlockHashLayout(DEEP_BODY_FIVE_PAYLOAD_FOUR, deneb);

        BeaconProofVerifier.BlockHashEvidence memory padded = BeaconProofVerifier.BlockHashEvidence(capella.header, _padTo(capella.branch, 9));
        vm.expectRevert(BeaconProofVerifier.LayoutEvidenceInvalid.selector);
        vault_.addBlockHashLayout(DEEP_BODY_FIVE_PAYLOAD_FOUR, padded);

        vault_.addBlockHashLayout(412, capella);
        vault_.addBlockHashLayout(812, deneb);
        assertEq(vault_.bodyLayouts().length, 2);
    }

    /// Claim: evidence of today's layouts cannot be accepted at block hash position 1324 (body of 32 leaves, payload of
    /// 32). Shows: the Capella shape reverts with `BranchLengthMismatch(10, 8)` and the Deneb shape with `(10, 9)`.
    /// Branches padded to 10 revert with `LayoutEvidenceInvalid`. The honest positions are accepted. Matters: no body of
    /// today has 32 leaves.
    function test_HB04_deepBlockHash1324_evidenceOfTodaysLayoutsRefused() public {
        (BridgeVault vault_, BeaconProofVerifier.BlockHashEvidence memory capella, BeaconProofVerifier.BlockHashEvidence memory deneb) =
            _todaysBodies();

        vm.expectRevert(_lengthMismatch(10, 8));
        vault_.addBlockHashLayout(DEEP_BODY_FIVE_PAYLOAD_FIVE, capella);
        vm.expectRevert(_lengthMismatch(10, 9));
        vault_.addBlockHashLayout(DEEP_BODY_FIVE_PAYLOAD_FIVE, deneb);

        vm.expectRevert(BeaconProofVerifier.LayoutEvidenceInvalid.selector);
        vault_.addBlockHashLayout(
            DEEP_BODY_FIVE_PAYLOAD_FIVE, BeaconProofVerifier.BlockHashEvidence(capella.header, _padTo(capella.branch, 10))
        );
        vm.expectRevert(BeaconProofVerifier.LayoutEvidenceInvalid.selector);
        vault_.addBlockHashLayout(
            DEEP_BODY_FIVE_PAYLOAD_FIVE, BeaconProofVerifier.BlockHashEvidence(deneb.header, _padTo(deneb.branch, 10))
        );

        vault_.addBlockHashLayout(412, capella);
        vault_.addBlockHashLayout(812, deneb);
        assertEq(vault_.bodyLayouts().length, 2);
    }

    // ================================================================ accepted for a synthetic state or body

    /// Claim: a synthetic state of 128 leaves, with `block_roots` at 133 and `historical_summaries` at 155, is
    /// accepted, and both paths of a withdrawal work through it. Shows: both rows are added, the recent branch has 20
    /// entries, the historical branch has 46, and both deposits pay. Matters: the rule stays correct for a future fork
    /// with more than 64 state fields.
    function test_HB03_deepState_rowsAreAcceptedAndBothPathsPay() public {
        BridgeVault vault_ = _historicalWorld(FIRST_STORED_SLOT, CAPELLA_ERA);
        HistoricalParams memory params =
            _historicalParams(ANCHOR, CAPELLA_ERA, DEEP_SUMMARIES, EVIDENCE, _slots(ANCHOR - 8192, ANCHOR - 8193));
        params.blockRootsGindex = DEEP_BLOCK_ROOTS;
        HistoricalScene memory scene = _historicalScene(params);
        _addBodyRows(vault_, scene);
        _addRecentRow(vault_, params, scene);
        _addHistoricalRow(vault_, params, scene);

        assertEq(vault_.stateLayouts().length, 1);
        assertEq(vault_.stateLayouts()[0].blockRootsGindex, DEEP_BLOCK_ROOTS);
        assertEq(vault_.historicalLayouts().length, 1);
        assertEq(vault_.historicalLayouts()[0].historicalSummariesGindex, DEEP_SUMMARIES);

        ReceiptFixtures.Named memory recentReceipt = ReceiptFixtures.legacy();
        ReceiptFixtures.Named memory historicalReceipt = ReceiptFixtures.type2();
        BridgeVault.WithdrawalProof memory recent = _recentProof(scene, 0, recentReceipt);
        BridgeVault.WithdrawalProof memory historical = _historicalProof(scene, 1, historicalReceipt);
        assertEq(recent.ancestryBranch.length, 20);
        assertEq(historical.ancestryBranch.length, 46);
        vault_.withdraw(recent);
        vault_.withdraw(historical);
        assertTrue(vault_.claimed(recentReceipt.nonce), "the recent deposit is claimed");
        assertTrue(vault_.claimed(historicalReceipt.nonce), "the historical deposit is claimed");
    }

    /// @dev Builds a scene whose bodies hold the block hash at `position`, and pays its deposit through that row.
    function _acceptBodyPosition(uint256 position) internal {
        BridgeVault vault_ = _newWithdrawalVault();
        tokenOnB.mint(address(vault_), 1_000_000e18);
        SceneParams memory params = _defaultParams();
        params.anchorBodyGindex = position;
        params.blockHashGindex = position;
        ReceiptFixtures.Named memory named = ReceiptFixtures.type2();
        Scene memory scene = _scene(named, params);

        assertEq(vault_.bodyLayouts().length, 1);
        assertEq(vault_.bodyLayouts()[0].blockHashGindex, position);
        assertEq(scene.proof.blockHashBranch.length, SSZ.depthOf(position));
        vault_.withdraw(scene.proof);
        assertEq(tokenOnB.balanceOf(ReceiptFixtures.RECIPIENT), named.amount, "the recipient got the logged amount");
        assertTrue(vault_.claimed(named.nonce), "the nonce is marked");
    }

    /// Claim: a synthetic body of 32 leaves with a payload of 16 leaves (block hash at 668, branch of 9) is accepted
    /// and a deposit pays through it. Matters: the rule stays correct for a future body with more than 16 fields.
    function test_HB04_deepBlockHash668_acceptedForMatchingBody() public {
        _acceptBodyPosition(DEEP_BODY_FIVE_PAYLOAD_FOUR);
    }

    /// Claim: a synthetic body of 32 leaves with a payload of 32 leaves (block hash at 1324, branch of 10) is accepted
    /// and a deposit pays through it. Matters: same as above, with the deepest position that the rule allows.
    function test_HB04_deepBlockHash1324_acceptedForMatchingBody() public {
        _acceptBodyPosition(DEEP_BODY_FIVE_PAYLOAD_FIVE);
    }
}
