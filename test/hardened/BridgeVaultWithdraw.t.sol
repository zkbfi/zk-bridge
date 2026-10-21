// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {console2} from "forge-std/console2.sol";
import {IERC20Errors} from "@openzeppelin/contracts/interfaces/draft-IERC6093.sol";
import {BridgeVault} from "../../src/hardened/BridgeVault.sol";
import {BeaconBlockHeader, SSZ} from "../../src/hardened/SSZ.sol";
import {MockERC20} from "../../src/mocks/MockERC20.sol";
import {WithdrawalScenes} from "./utils/WithdrawalScenes.sol";
import {ReceiptFixtures} from "./utils/ReceiptFixtures.sol";

/// @notice Tests of `BridgeVault.withdraw`: every check of the direct-verification design, each with an accept case
/// and a reject case. The receipts come from a script-generated trie. The beacon levels are synthetic.
contract BridgeVaultWithdrawTest is WithdrawalScenes {
    event WithdrawalCompleted(
        address indexed token,
        address indexed recipient,
        bytes32 indexed depositNonce,
        uint256 amount,
        bytes32 depositBlockHash
    );

    BridgeVault internal vault;

    function setUp() public override {
        super.setUp();
        vault = _newWithdrawalVault();
        tokenOnB.mint(address(vault), 1_000_000e18);
    }

    function _expectRejected(BridgeVault.WithdrawalProof memory proof, bytes memory revertData) internal {
        vm.expectRevert(revertData);
        vault.withdraw(proof);
    }

    function _assertPaid(ReceiptFixtures.Named memory named) internal view {
        assertEq(tokenOnB.balanceOf(ReceiptFixtures.RECIPIENT), named.amount, "the recipient got the logged amount");
        assertTrue(vault.claimed(named.nonce), "the nonce is marked");
    }

    // ================================================================ honest paths (receipt types)

    /// Claim: a legacy receipt (no type byte, trie key 0x80) pays the logged amount to the logged recipient in the
    /// mapped local token, and emits the event with the execution block hash. Shows: balance, claim flag, event.
    /// Matters: R2-05 (revision 2 could decode only bare lists) and the whole direct-verification path.
    function test_R2_05_withdraw_legacyReceiptPays() public {
        ReceiptFixtures.Named memory named = ReceiptFixtures.legacy();
        Scene memory scene = _scene(named, _defaultParams());

        vm.expectEmit(true, true, true, true, address(vault));
        emit WithdrawalCompleted(address(tokenOnB), ReceiptFixtures.RECIPIENT, named.nonce, named.amount, scene.blockHash);
        vault.withdraw(scene.proof);
        _assertPaid(named);
    }

    /// Claim: a type 2 receipt (type byte 0x02 before the RLP list) pays. Shows: balance and flag.
    /// Matters: R2-05 (type 1, 2, 3, 4 receipts store `type ‖ rlp(receipt)`; revision 2 failed on most real receipts).
    function test_R2_05_withdraw_type2ReceiptPays() public {
        ReceiptFixtures.Named memory named = ReceiptFixtures.type2();
        vault.withdraw(_scene(named, _defaultParams()).proof);
        _assertPaid(named);
    }

    /// Claim: a type 1 (access list) receipt pays. Shows: balance and flag. Matters: R2-05.
    function test_R2_05_withdraw_type1ReceiptPays() public {
        ReceiptFixtures.Named memory named = ReceiptFixtures.access_list();
        vault.withdraw(_scene(named, _defaultParams()).proof);
        _assertPaid(named);
    }

    /// Claim: the trie key of a transaction index above 127 is encoded as RLP (0x8182 for 130). Shows: a receipt at
    /// index 130 pays. Matters: a wrong key encoding would fail every deposit in a busy block.
    function test_R2_05_withdraw_highTransactionIndexPays() public {
        ReceiptFixtures.Named memory named = ReceiptFixtures.high_index();
        vault.withdraw(_scene(named, _defaultParams()).proof);
        _assertPaid(named);
    }

    /// Claim: two deposits in one receipt are each claimable by their own log index. Shows: log 1 and log 2 pay
    /// their own amounts and nonces, in either order; claiming one does not claim the other. Matters: R2-06 (revision 2
    /// proved only the first matching log, so a second deposit in a transaction could never be claimed).
    function test_R2_06_withdraw_twoDepositsInOneReceiptEachClaimable() public {
        ReceiptFixtures.Named memory first = ReceiptFixtures.two_a();
        ReceiptFixtures.Named memory second = ReceiptFixtures.two_b();
        SceneParams memory params = _defaultParams();
        Scene memory sceneA = _scene(first, params);
        Scene memory sceneB = _buildScene(second, params, _executionHeaderRlp(ReceiptFixtures.RECEIPTS_ROOT, 17));
        assertEq(sceneB.anchorRoot, sceneA.anchorRoot, "same anchor, same blocks");

        vault.withdraw(sceneB.proof); // the second deposit first
        assertTrue(vault.claimed(second.nonce));
        assertFalse(vault.claimed(first.nonce), "the other deposit stays claimable");
        assertEq(tokenOnB.balanceOf(ReceiptFixtures.RECIPIENT), second.amount);

        vault.withdraw(sceneA.proof);
        assertTrue(vault.claimed(first.nonce));
        assertEq(tokenOnB.balanceOf(ReceiptFixtures.RECIPIENT), first.amount + second.amount);
    }

    /// Claim: a log index that points at another event of the right emitter is refused. Shows: log 0 of the
    /// two-deposit receipt is an unrelated event and reverts with its topic; log 1 pays. Matters: R2-06 (the wrong
    /// log index never pays by accident).
    function test_R2_06_withdraw_wrongLogIndexRejected() public {
        ReceiptFixtures.Named memory named = ReceiptFixtures.two_a();
        Scene memory scene = _scene(named, _defaultParams());
        BridgeVault.WithdrawalProof memory wrong = _clone(scene.proof);
        wrong.logIndex = 0;
        _expectRejected(wrong, abi.encodeWithSelector(BridgeVault.WrongEventTopic.selector, keccak256("Unrelated(uint256)")));
        assertFalse(vault.claimed(named.nonce));

        vault.withdraw(scene.proof);
        _assertPaid(named);
    }

    /// Claim: a log index past the end is refused with the count. Shows: index 3 of a three-log receipt reverts.
    /// Matters: no out-of-range read.
    function test_R2_06_withdraw_logIndexOutOfRangeRejected() public {
        ReceiptFixtures.Named memory named = ReceiptFixtures.two_a();
        Scene memory scene = _scene(named, _defaultParams());
        BridgeVault.WithdrawalProof memory wrong = _clone(scene.proof);
        wrong.logIndex = 3;
        _expectRejected(wrong, abi.encodeWithSelector(BridgeVault.LogIndexOutOfRange.selector, uint256(3), uint256(3)));
        vault.withdraw(scene.proof);
        _assertPaid(named);
    }

    // ================================================================ check 7: the log

    /// Claim: a deposit log from any contract other than the pinned remote vault cannot be withdrawn. Shows: a log
    /// that has the right topic and layout but another emitter reverts with both addresses. Matters: H-02 (the fake
    /// deposit emitter).
    function test_H02_withdraw_otherEmitterRejected() public {
        ReceiptFixtures.Named memory fake = ReceiptFixtures.other_emitter();
        SceneParams memory params = _defaultParams();
        Scene memory scene = _scene(fake, params);
        _expectRejected(scene.proof, abi.encodeWithSelector(BridgeVault.WrongEmitter.selector, ReceiptFixtures.REMOTE_VAULT, ReceiptFixtures.OTHER_EMITTER));
        assertEq(tokenOnB.balanceOf(ReceiptFixtures.RECIPIENT), 0);

        ReceiptFixtures.Named memory real = ReceiptFixtures.type2();
        vault.withdraw(_buildScene(real, params, _executionHeaderRlp(ReceiptFixtures.RECEIPTS_ROOT, 17)).proof); // honest path
        _assertPaid(real);
    }

    /// Claim: a failed transaction pays nothing even if its receipt holds a deposit-looking log. Shows: the status 0
    /// receipt reverts with `ReceiptFailed`. Matters: a reverted deposit transaction locked no tokens.
    function test_H02_withdraw_failedReceiptRejected() public {
        ReceiptFixtures.Named memory failed = ReceiptFixtures.failed();
        SceneParams memory params = _defaultParams();
        Scene memory scene = _scene(failed, params);
        _expectRejected(scene.proof, abi.encodeWithSelector(BridgeVault.ReceiptFailed.selector));
        assertFalse(vault.claimed(failed.nonce));

        ReceiptFixtures.Named memory real = ReceiptFixtures.legacy();
        vault.withdraw(_buildScene(real, params, _executionHeaderRlp(ReceiptFixtures.RECEIPTS_ROOT, 17)).proof);
        _assertPaid(real);
    }

    /// Claim: a deposit for another target chain is refused. Shows: target 56 reverts with `WrongTargetChain`.
    /// Matters: H-10 and H-16 (a deposit for chain 56 cannot be paid on chain 369).
    function test_H10_withdraw_wrongTargetChainRejected() public {
        ReceiptFixtures.Named memory wrong = ReceiptFixtures.wrong_target();
        SceneParams memory params = _defaultParams();
        Scene memory scene = _scene(wrong, params);
        _expectRejected(scene.proof, abi.encodeWithSelector(BridgeVault.WrongTargetChain.selector, CHAIN_B, uint64(56)));

        ReceiptFixtures.Named memory real = ReceiptFixtures.type2();
        vault.withdraw(_buildScene(real, params, _executionHeaderRlp(ReceiptFixtures.RECEIPTS_ROOT, 17)).proof);
        _assertPaid(real);
    }

    /// Claim: a token that is not registered cannot be paid. Shows: the unregistered remote token reverts with its
    /// address. Matters: H-03 (only explicit pairs map tokens).
    function test_H03_withdraw_unregisteredTokenRejected() public {
        ReceiptFixtures.Named memory bad = ReceiptFixtures.unregistered();
        SceneParams memory params = _defaultParams();
        Scene memory scene = _scene(bad, params);
        _expectRejected(scene.proof, abi.encodeWithSelector(BridgeVault.UnsupportedRemoteToken.selector, ReceiptFixtures.UNREGISTERED_TOKEN));

        ReceiptFixtures.Named memory real = ReceiptFixtures.type2();
        vault.withdraw(_buildScene(real, params, _executionHeaderRlp(ReceiptFixtures.RECEIPTS_ROOT, 17)).proof);
        _assertPaid(real);
    }

    /// Claim: a deposit pays once. Shows: the second submission of the same evidence reverts with `AlreadyClaimed`.
    /// Matters: no double claim, and the nonce commits to chain and vault (H-16).
    function test_H16_withdraw_doubleClaimRejected() public {
        ReceiptFixtures.Named memory named = ReceiptFixtures.type2();
        Scene memory scene = _scene(named, _defaultParams());
        vault.withdraw(scene.proof);
        _expectRejected(scene.proof, abi.encodeWithSelector(BridgeVault.AlreadyClaimed.selector, named.nonce));
        _assertPaid(named);
    }

    /// Claim: with no liquidity the payout reverts and the claim stays open (H-09 is accepted: no refund).
    /// Shows: the token's balance error, an unmarked nonce, and a retry that works after funding. Matters: a failed
    /// payout never burns the claim.
    function test_H13_withdraw_withoutLiquidityRevertsAndStaysClaimable() public {
        BridgeVault empty = _newWithdrawalVault();
        deal(address(tokenOnB), address(empty), 0); // the setUp vault held liquidity at the same address
        ReceiptFixtures.Named memory named = ReceiptFixtures.type2();
        Scene memory scene = _scene(named, _defaultParams());
        vm.expectRevert(abi.encodeWithSelector(IERC20Errors.ERC20InsufficientBalance.selector, address(empty), 0, named.amount));
        empty.withdraw(scene.proof);
        assertFalse(empty.claimed(named.nonce));
        tokenOnB.mint(address(empty), named.amount);
        empty.withdraw(scene.proof);
        assertTrue(empty.claimed(named.nonce));
    }

    // ================================================================ check 1: the anchor

    /// Claim: the anchor must be a header that the light client stored. Shows: a header at a slot that holds no stored
    /// header reverts with `AnchorNotStored`; the stored one pays. Matters: H-08 (only finalized headers anchor a proof).
    function test_H08_withdraw_anchorNotAStoredHeadRejected() public {
        ReceiptFixtures.Named memory named = ReceiptFixtures.type2();
        SceneParams memory params = _defaultParams();
        Scene memory scene = _scene(named, params);

        BridgeVault.WithdrawalProof memory unstored = _clone(scene.proof);
        unstored.anchorHeader.slot = params.anchorSlot + 1; // the client stored a header at params.anchorSlot only
        bytes32 root = SSZ.hashTreeRootMemory(unstored.anchorHeader);
        _expectRejected(unstored, abi.encodeWithSelector(BridgeVault.AnchorNotStored.selector, params.anchorSlot + 1, root));

        vault.withdraw(scene.proof);
        _assertPaid(named);
    }

    /// Claim: the anchor header must equal the stored header root, field by field. Shows: changing the proposer index
    /// changes the root and reverts; the original pays. Matters: H-08 / H-01 (a forged anchor with a chosen state root).
    function test_H08_withdraw_forgedAnchorHeaderRejected() public {
        ReceiptFixtures.Named memory named = ReceiptFixtures.type2();
        Scene memory scene = _scene(named, _defaultParams());
        BridgeVault.WithdrawalProof memory forged = _clone(scene.proof);
        forged.anchorHeader.proposerIndex += 1;
        bytes32 root = SSZ.hashTreeRootMemory(forged.anchorHeader);
        _expectRejected(forged, abi.encodeWithSelector(BridgeVault.AnchorNotStored.selector, forged.anchorHeader.slot, root));
        vault.withdraw(scene.proof);
    }

    /// Claim: a slot that the client never stored has a zero root and is refused even for an all-zero header.
    /// Shows: an empty header at an unstored slot reverts. Matters: zero is never a valid stored root.
    function test_H08_withdraw_zeroHeaderRejected() public {
        BridgeVault.WithdrawalProof memory empty;
        empty.anchorHeader.slot = 5;
        empty.depositHeader.slot = 4;
        bytes32 root = SSZ.hashTreeRootMemory(empty.anchorHeader);
        _expectRejected(empty, abi.encodeWithSelector(BridgeVault.AnchorNotStored.selector, uint64(5), root));
    }

    // ================================================================ check 2: the path by distance

    /// Claim: the vault picks the ancestry path from the distance. Shows: a deposit exactly 8192 slots below the anchor
    /// pays through `state.block_roots`. One slot further (8193) the vault no longer reads `block_roots`: it needs a
    /// `historical_summaries` row, and this vault has none, so it reverts with `LayoutNotValidated` for the anchor slot.
    /// Matters: the old refusal `DepositOutsideWindow` is gone. An old deposit is proven by the historical path, which
    /// `HistoricalAncestry.t.sol` tests with real evidence. The vault never falls back to `block_roots` for it.
    function test_HB01_withdraw_distanceBoundarySwitchesPath() public {
        ReceiptFixtures.Named memory named = ReceiptFixtures.type2();

        // Exactly 8192 below the anchor.
        SceneParams memory edgeParams = SceneParams({
            anchorSlot: 835_192,
            depositSlot: 835_192 - 8192,
            blockRootsGindex: 69,
            anchorBodyGindex: 812,
            blockHashGindex: 812
        });
        Scene memory edge = _scene(named, edgeParams);
        vault.withdraw(edge.proof);
        _assertPaid(named);

        // One slot further: the same recent evidence, but the vault now takes the historical path.
        SceneParams memory farParams = SceneParams({
            anchorSlot: 835_300,
            depositSlot: 835_300 - 8193,
            blockRootsGindex: 69,
            anchorBodyGindex: 812,
            blockHashGindex: 812
        });
        Scene memory far = _scene(ReceiptFixtures.legacy(), farParams);
        _expectRejected(far.proof, abi.encodeWithSelector(BridgeVault.LayoutNotValidated.selector, farParams.anchorSlot));
        assertEq(vault.historicalLayouts().length, 0, "no historical row was added by the scene");
    }

    /// Claim: the deposit block must be strictly before the anchor. Shows: the same slot and a later slot revert with
    /// `DepositNotBeforeAnchor`. Matters: the anchor state holds roots only up to the slot before it.
    function test_H08_withdraw_depositNotBeforeAnchorRejected() public {
        ReceiptFixtures.Named memory named = ReceiptFixtures.type2();
        SceneParams memory params = _defaultParams();
        Scene memory scene = _scene(named, params);

        BridgeVault.WithdrawalProof memory same = _clone(scene.proof);
        same.depositHeader.slot = params.anchorSlot;
        _expectRejected(same, abi.encodeWithSelector(BridgeVault.DepositNotBeforeAnchor.selector, params.anchorSlot, params.anchorSlot));

        BridgeVault.WithdrawalProof memory later = _clone(scene.proof);
        later.depositHeader.slot = params.anchorSlot + 5;
        _expectRejected(later, abi.encodeWithSelector(BridgeVault.DepositNotBeforeAnchor.selector, params.anchorSlot + 5, params.anchorSlot));

        vault.withdraw(scene.proof);
        _assertPaid(named);
    }

    // ================================================================ check 3: block roots branch

    /// Claim: the deposit header must be in the anchor's `block_roots`. Shows: a changed sibling, a changed deposit
    /// header, and a changed deposit slot each revert with `AncestryBranchInvalid`. Matters: this ties the deposit
    /// block to the finalized chain.
    function test_H08_withdraw_ancestryBranchTamperRejected() public {
        ReceiptFixtures.Named memory named = ReceiptFixtures.type2();
        Scene memory scene = _scene(named, _defaultParams());

        BridgeVault.WithdrawalProof memory sibling = _clone(scene.proof);
        sibling.ancestryBranch[3] = keccak256("attacker sibling");
        _expectRejected(sibling, abi.encodeWithSelector(BridgeVault.AncestryBranchInvalid.selector));

        BridgeVault.WithdrawalProof memory header = _clone(scene.proof);
        header.depositHeader.proposerIndex += 1;
        _expectRejected(header, abi.encodeWithSelector(BridgeVault.AncestryBranchInvalid.selector));

        BridgeVault.WithdrawalProof memory slot = _clone(scene.proof);
        slot.depositHeader.slot -= 1; // another vector index, so another path
        _expectRejected(slot, abi.encodeWithSelector(BridgeVault.AncestryBranchInvalid.selector));

        vault.withdraw(scene.proof);
        _assertPaid(named);
    }

    /// Claim: a branch of the wrong length is an error of its own, not a silent pass. Shows: one sibling too many
    /// and one too few revert with the expected depth 19 (Electra-like state, 6 + 13). Matters: a wrong fork row
    /// shows up as a clear failure.
    function test_H08_withdraw_ancestryBranchLengthRejected() public {
        ReceiptFixtures.Named memory named = ReceiptFixtures.type2();
        Scene memory scene = _scene(named, _defaultParams());
        BridgeVault.WithdrawalProof memory longer = _clone(scene.proof);
        bytes32[] memory extended = new bytes32[](20);
        for (uint256 i = 0; i < 19; i++) {
            extended[i] = longer.ancestryBranch[i];
        }
        longer.ancestryBranch = extended;
        _expectRejected(longer, abi.encodeWithSelector(SSZ.BranchLengthMismatch.selector, uint256(19), uint256(20)));

        BridgeVault.WithdrawalProof memory shorter = _clone(scene.proof);
        bytes32[] memory cut = new bytes32[](18);
        for (uint256 i = 0; i < 18; i++) {
            cut[i] = shorter.ancestryBranch[i];
        }
        shorter.ancestryBranch = cut;
        _expectRejected(shorter, abi.encodeWithSelector(SSZ.BranchLengthMismatch.selector, uint256(19), uint256(18)));

        vault.withdraw(scene.proof);
    }

    // ================================================================ fork layouts

    /// Claim: a vault with no validated layout pays nothing, and anyone can fix that with evidence. Shows: a vault
    /// created after the scene reverts with `LayoutNotValidated(anchorSlot)`; after the permissionless layout calls it
    /// pays. Matters: the vault never guesses a position, and no administrator is needed to enable it.
    function test_H08_withdraw_layoutNotValidatedRejectedUntilAdded() public {
        ReceiptFixtures.Named memory named = ReceiptFixtures.type2();
        SceneParams memory params = _defaultParams();
        Scene memory scene = _scene(named, params);

        BridgeVault fresh = _newWithdrawalVault();
        tokenOnB.mint(address(fresh), 100e18);
        vm.expectRevert(abi.encodeWithSelector(BridgeVault.LayoutNotValidated.selector, params.anchorSlot));
        fresh.withdraw(scene.proof);

        vm.prank(attacker); // any caller
        fresh.addBlockRootsLayout(params.blockRootsGindex, scene.rootsEvidence);
        vm.expectRevert(abi.encodeWithSelector(BridgeVault.LayoutNotValidated.selector, params.depositSlot));
        fresh.withdraw(scene.proof); // the state position is known, the body position is not

        _addLayouts(fresh, params, scene);
        fresh.withdraw(scene.proof);
        assertTrue(fresh.claimed(named.nonce));
    }

    /// Claim: a layout is usable only inside the slot range at which it was validated. Shows: a deposit header whose
    /// slot lies below every validated body slot reverts with `LayoutNotValidated`. Matters: a position validated in
    /// one fork must not be used for slots of an earlier fork, where it could point at another field.
    function test_H08_withdraw_depositSlotOutsideValidatedRangeRejected() public {
        ReceiptFixtures.Named memory named = ReceiptFixtures.type2();
        SceneParams memory params = _defaultParams();
        // A vault that knows only the anchor's body position (validated at the anchor slot) and the state position.
        Scene memory scene = _scene(named, params);
        BridgeVault narrow = _newWithdrawalVault();
        narrow.addBlockRootsLayout(params.blockRootsGindex, scene.rootsEvidence);
        narrow.addBlockHashLayout(params.anchorBodyGindex, scene.anchorBodyEvidence); // validated at the anchor slot only
        tokenOnB.mint(address(narrow), 100e18);
        vm.expectRevert(abi.encodeWithSelector(BridgeVault.LayoutNotValidated.selector, params.depositSlot));
        narrow.withdraw(scene.proof);

        narrow.addBlockHashLayout(params.blockHashGindex, BridgeVault.BlockHashEvidence(scene.evidenceBefore, scene.evidenceBeforeBranch));
        narrow.withdraw(scene.proof); // the range now reaches the deposit slot
        assertTrue(narrow.claimed(named.nonce));
    }

    /// Claim: the state position and the block hash position may differ between the anchor's fork and the deposit's
    /// fork. Shows: a deposit under block hash position 412 with an anchor under 812 pays. Matters: a withdrawal window
    /// can span a fork.
    function test_H08_withdraw_depositInEarlierForkLayoutPays() public {
        ReceiptFixtures.Named memory named = ReceiptFixtures.type2();
        SceneParams memory params = SceneParams({
            anchorSlot: 823_000,
            depositSlot: 822_300,
            blockRootsGindex: 69,
            anchorBodyGindex: 812,
            blockHashGindex: 412
        });
        vault.withdraw(_scene(named, params).proof);
        _assertPaid(named);
        assertEq(vault.bodyLayouts().length, 2, "two block hash positions are known");
    }

    // ================================================================ check 4 and 5: block hash and header

    /// Claim: the execution block hash must be in the deposit header's body. Shows: a changed sibling reverts with
    /// `BlockHashBranchInvalid`; a different execution header (so a different hash) reverts the same way.
    /// Matters: the receipts root is trusted only through this link.
    function test_H08_withdraw_blockHashBranchTamperRejected() public {
        ReceiptFixtures.Named memory named = ReceiptFixtures.type2();
        Scene memory scene = _scene(named, _defaultParams());

        BridgeVault.WithdrawalProof memory sibling = _clone(scene.proof);
        sibling.blockHashBranch[2] = keccak256("attacker sibling");
        _expectRejected(sibling, abi.encodeWithSelector(BridgeVault.BlockHashBranchInvalid.selector));

        BridgeVault.WithdrawalProof memory otherHeader = _clone(scene.proof);
        otherHeader.executionHeaderRlp = _executionHeaderRlp(ReceiptFixtures.RECEIPTS_ROOT, 16);
        _expectRejected(otherHeader, abi.encodeWithSelector(BridgeVault.BlockHashBranchInvalid.selector));

        vault.withdraw(scene.proof);
        _assertPaid(named);
    }

    /// Claim: a header without a sixth item is not accepted. Shows: a five-item header (with a valid branch for its
    /// own hash) reverts with `MalformedExecutionHeader`. Matters: no out-of-range read of the receipts root.
    function test_H08_withdraw_truncatedExecutionHeaderRejected() public {
        ReceiptFixtures.Named memory named = ReceiptFixtures.type2();
        SceneParams memory params = _defaultParams();
        Scene memory truncated = _sceneWithHeader(named, params, _executionHeaderRlp(ReceiptFixtures.RECEIPTS_ROOT, 5));
        _expectRejected(truncated.proof, abi.encodeWithSelector(BridgeVault.MalformedExecutionHeader.selector));

        SceneParams memory good = _defaultParams();
        vault.withdraw(_scene(named, good).proof);
        _assertPaid(named);
    }

    /// Claim: a receipts root of another trie does not verify the receipt. Shows: a header with another receipts root
    /// (and a valid branch for its own hash) reverts in the trie check. Matters: the receipt must belong to the block.
    function test_H08_withdraw_otherReceiptsRootRejected() public {
        ReceiptFixtures.Named memory named = ReceiptFixtures.type2();
        SceneParams memory params = _defaultParams();
        Scene memory other = _sceneWithHeader(named, params, _executionHeaderRlp(keccak256("another receipts root"), 17));
        vm.expectRevert("MerkleTrie: invalid root hash");
        vault.withdraw(other.proof);

        vault.withdraw(_scene(named, _defaultParams()).proof);
        _assertPaid(named);
    }

    /// Claim: a header that is not an RLP list is refused. Shows: a byte string as header reverts (the RLP reader
    /// rejects it). Matters: no decoding of arbitrary bytes as a header.
    function test_H08_withdraw_nonListExecutionHeaderRejected() public {
        ReceiptFixtures.Named memory named = ReceiptFixtures.type2();
        SceneParams memory params = _defaultParams();
        Scene memory bad = _sceneWithHeader(named, params, _rlpBytes("this is a string, not a list of fields"));
        vm.expectRevert();
        vault.withdraw(bad.proof);

        vault.withdraw(_scene(named, _defaultParams()).proof);
        _assertPaid(named);
    }

    // ================================================================ check 6: the receipt proof

    /// Claim: the receipt must be in the trie under the key of the transaction index. Shows: a tampered node reverts in
    /// the trie check; the proof of another index reverts; a proof cut short reverts; the honest proof pays.
    /// Matters: the receipt is the only evidence that a deposit happened (R2-04: the trie result is the leaf).
    function test_R2_04_withdraw_receiptProofTamperRejected() public {
        ReceiptFixtures.Named memory named = ReceiptFixtures.type2();
        Scene memory scene = _scene(named, _defaultParams());

        BridgeVault.WithdrawalProof memory node = _clone(scene.proof);
        uint256 last = node.receiptProof.length - 1;
        node.receiptProof[last][node.receiptProof[last].length - 1] ^= 0x01;
        vm.expectRevert("MerkleTrie: invalid large internal hash");
        vault.withdraw(node);

        BridgeVault.WithdrawalProof memory wrongIndex = _clone(scene.proof);
        wrongIndex.transactionIndex = ReceiptFixtures.legacy().transactionIndex; // proof of index 2, key of index 0
        vm.expectRevert();
        vault.withdraw(wrongIndex);

        BridgeVault.WithdrawalProof memory cut = _clone(scene.proof);
        bytes[] memory shortProof = new bytes[](cut.receiptProof.length - 1);
        for (uint256 i = 0; i < shortProof.length; i++) {
            shortProof[i] = cut.receiptProof[i];
        }
        cut.receiptProof = shortProof;
        vm.expectRevert("MerkleTrie: ran out of proof elements");
        vault.withdraw(cut);

        vault.withdraw(scene.proof);
        _assertPaid(named);
    }

    /// Claim: receipt types 3 and 4 pay, like 1 and 2. Shows: both fixtures pay. Matters: R2-05 (every type that
    /// real Ethereum blocks hold today).
    function test_R2_05_withdraw_type3AndType4ReceiptsPay() public {
        ReceiptFixtures.Named memory blob = ReceiptFixtures.type3();
        ReceiptFixtures.Named memory setCode = ReceiptFixtures.type4();
        SceneParams memory params = _defaultParams();
        vault.withdraw(_scene(blob, params).proof);
        vault.withdraw(_buildScene(setCode, params, _executionHeaderRlp(ReceiptFixtures.RECEIPTS_ROOT, 17)).proof);
        assertTrue(vault.claimed(blob.nonce));
        assertTrue(vault.claimed(setCode.nonce));
        assertEq(tokenOnB.balanceOf(ReceiptFixtures.RECIPIENT), blob.amount + setCode.amount);
    }

    /// Claim: an unknown type byte (5) and an explicit 0x00 prefix are refused. Shows: both revert with
    /// `MalformedReceipt`, and a supported type pays. Matters: the decoder accepts only layouts it knows.
    function test_R2_05_withdraw_unsupportedReceiptTypeRejected() public {
        ReceiptFixtures.Named memory unknown = ReceiptFixtures.type5();
        ReceiptFixtures.Named memory zeroPrefixed = ReceiptFixtures.type0_prefixed();
        SceneParams memory params = _defaultParams();
        Scene memory unknownScene = _scene(unknown, params);
        _expectRejected(unknownScene.proof, abi.encodeWithSelector(BridgeVault.MalformedReceipt.selector));
        Scene memory zeroScene = _buildScene(zeroPrefixed, params, _executionHeaderRlp(ReceiptFixtures.RECEIPTS_ROOT, 17));
        _expectRejected(zeroScene.proof, abi.encodeWithSelector(BridgeVault.MalformedReceipt.selector));

        ReceiptFixtures.Named memory real = ReceiptFixtures.type2();
        vault.withdraw(_buildScene(real, params, _executionHeaderRlp(ReceiptFixtures.RECEIPTS_ROOT, 17)).proof);
        _assertPaid(real);
    }

    // ================================================================ gas

    /// Claim: a typical withdrawal (a type 2 receipt in a 140-receipt trie, a 3-node proof) costs a bounded amount.
    /// Shows: the measured gas. Matters: a user pays this once per claim, and it grows with proof size, not with the
    /// number of past deposits. The bound of 450k is the measured value plus headroom (see the log).
    function test_H15_gas_typicalWithdrawal() public {
        ReceiptFixtures.Named memory named = ReceiptFixtures.type2();
        Scene memory scene = _scene(named, _defaultParams());
        uint256 before = gasleft();
        vault.withdraw(scene.proof);
        uint256 used = before - gasleft();
        console2.log("withdraw gas (type 2 receipt, 3 trie nodes, depth 19 + 9 branches)", used);
        assertLt(used, 450_000);
    }

    // ================================================================ deposit cutoff

    /// Claim: a zero cutoff means deposits never close. Shows: deposits succeed far in the future. Matters: the
    /// cutoff is opt-in, set only when a breaking fork is scheduled.
    function test_H19_cutoff_zeroMeansNoCutoff() public {
        assertEq(vaultA.depositCutoffTimestamp(), 0);
        vm.chainId(CHAIN_A);
        vm.warp(type(uint64).max);
        _deposit(vaultA, address(tokenOnA), alice, bob, 1e18);
        assertEq(vaultA.depositCount(), 1);
    }

    /// Claim: deposits close at the cutoff. Shows: one second before, a deposit succeeds; at the cutoff and after, it
    /// reverts with `DepositCutoffReached`. Matters: nobody deposits into a route whose counterpart may no longer prove.
    function test_H19_cutoff_depositsCloseAtTheCutoff() public {
        uint64 cutoff = 2_000_000_000;
        BridgeVault closing = _newWithdrawalVault(cutoff);
        assertEq(closing.depositCutoffTimestamp(), cutoff);
        tokenOnB.mint(alice, 10e18);
        vm.startPrank(alice);
        tokenOnB.approve(address(closing), 10e18);

        vm.warp(cutoff - 1);
        closing.deposit(address(tokenOnB), bob, 1e18, 0, ""); // honest path

        vm.warp(cutoff);
        vm.expectRevert(abi.encodeWithSelector(BridgeVault.DepositCutoffReached.selector, cutoff));
        closing.deposit(address(tokenOnB), bob, 1e18, 0, "");

        vm.warp(cutoff + 1 days);
        vm.expectRevert(abi.encodeWithSelector(BridgeVault.DepositCutoffReached.selector, cutoff));
        closing.deposit(address(tokenOnB), bob, 1e18, 0, "");
        vm.stopPrank();
        assertEq(closing.depositCount(), 1);
    }

    /// Claim: withdrawals still work after the cutoff. Shows: a claim pays after the cutoff time. Matters: the old
    /// route keeps paying what it can still prove.
    function test_H19_cutoff_withdrawalsStillWorkAfterTheCutoff() public {
        uint64 cutoff = 2_000_000_000;
        BridgeVault closing = _newWithdrawalVault(cutoff);
        tokenOnB.mint(address(closing), 100e18);
        ReceiptFixtures.Named memory named = ReceiptFixtures.type2();
        Scene memory scene = _scene(named, _defaultParams());
        vm.warp(cutoff + 30 days);
        closing.withdraw(scene.proof);
        assertTrue(closing.claimed(named.nonce));
        assertEq(tokenOnB.balanceOf(ReceiptFixtures.RECIPIENT), named.amount);
    }

    // ================================================================ destination vault (defect 4)

    /// Claim: a deposit is payable only by the vault that the deposit names. Shows: a second vault with the same remote
    /// vault, the same chains and the same token pair refuses a deposit that names the first vault, with
    /// `WrongDestinationVault`, and it marks nothing. The first vault, the control, pays the same proof. Matters: the
    /// second vault has an empty `claimed` map. Before the event named its destination, it paid every deposit a second
    /// time, and it drained its own liquidity.
    function test_defect4_secondVaultWithTheSameRemoteRefusesTheDeposit() public {
        ReceiptFixtures.Named memory named = ReceiptFixtures.type2();
        BridgeVault second = _newSecondWithdrawalVault(); // before the scene, so that it gets the fork layouts too
        Scene memory scene = _scene(named, _defaultParams());
        tokenOnB.mint(address(second), 100e18);
        assertEq(second.remoteVault(), vault.remoteVault(), "both vaults have the same remote vault");

        vm.expectRevert(abi.encodeWithSelector(BridgeVault.WrongDestinationVault.selector, address(second), address(vault)));
        second.withdraw(scene.proof);
        assertFalse(second.claimed(named.nonce), "the second vault marked nothing");
        assertEq(tokenOnB.balanceOf(address(second)), 100e18, "the second vault paid nothing");

        vault.withdraw(scene.proof); // control: the vault named in the deposit pays
        _assertPaid(named);
    }

    // ================================================================ destination token (code review finding)

    /// Claim: a deposit is payable only in the token that the depositing vault expects. Shows: the fixture deposit
    /// names `tokenOnB`, the token that the depositing vault pairs with its own token. A destination vault with an
    /// asymmetric table maps the same remote token to another local token. It refuses with `WrongDestinationToken`
    /// naming the token it would pay and the token the log names, marks nothing, and pays nothing in either token. The
    /// vault with the symmetric table pays the same deposit (control, after a state revert). Matters: before the event named the token, the
    /// destination vault paid whatever its own table said, so two vaults with different tables paid the wrong token.
    function test_destinationToken_asymmetricTablesRefuseTheDeposit() public {
        ReceiptFixtures.Named memory named = ReceiptFixtures.type2();
        uint256 symmetricState = vm.snapshotState();

        MockERC20 other = new MockERC20("Other", "OTH");
        BridgeVault.TokenPair[] memory pairs = new BridgeVault.TokenPair[](1);
        pairs[0] = BridgeVault.TokenPair(address(other), ReceiptFixtures.REMOTE_TOKEN, 18);
        BridgeVault asymmetric = _newDestinationVault(pairs, 0, DEFAULT_CAPELLA_ERA);
        Scene memory scene = _scene(named, _defaultParams());
        other.mint(address(asymmetric), 100e18);
        tokenOnB.mint(address(asymmetric), 100e18);
        assertEq(asymmetric.localTokenOf(ReceiptFixtures.REMOTE_TOKEN), address(other), "the table maps to the other token");

        vm.expectRevert(abi.encodeWithSelector(BridgeVault.WrongDestinationToken.selector, address(other), address(tokenOnB)));
        asymmetric.withdraw(scene.proof);
        assertFalse(asymmetric.claimed(named.nonce), "nothing is marked");
        assertEq(other.balanceOf(ReceiptFixtures.RECIPIENT), 0, "the wrong token is not paid");
        assertEq(tokenOnB.balanceOf(ReceiptFixtures.RECIPIENT), 0, "the named token is not paid either");

        // Control: back at the state of `setUp`, the vault with the symmetric table pays the same deposit.
        vm.revertToState(symmetricState);
        vault.withdraw(_scene(named, _defaultParams()).proof);
        _assertPaid(named);
    }

    /// Claim: a deposit that names another vault than the paying vault is refused. Shows: the fixture receipt
    /// `wrong_destination` names 0x88..88, so the vault at the fixture address refuses it with the exact addresses. The
    /// same vault pays a receipt that names it (control). Matters: the check compares the vault address, not only the
    /// chain, so a deposit for vault X never pays at vault Y.
    function test_defect4_depositNamingAnotherVaultIsRefused() public {
        ReceiptFixtures.Named memory wrong = ReceiptFixtures.wrong_destination();
        Scene memory scene = _scene(wrong, _defaultParams());
        _expectRejected(
            scene.proof,
            abi.encodeWithSelector(
                BridgeVault.WrongDestinationVault.selector, address(vault), ReceiptFixtures.OTHER_DESTINATION_VAULT
            )
        );
        assertFalse(vault.claimed(wrong.nonce));

        ReceiptFixtures.Named memory honest = ReceiptFixtures.type2();
        vault.withdraw(_scene(honest, _defaultParams()).proof);
        _assertPaid(honest);
    }

    // ================================================================ many logs (defect 3)

    /// Claim: a deposit at log index 40 of a receipt with 64 logs pays. Shows: the vault finds log 40 and pays the
    /// logged amount. Matters: the vendored list reader panics on 33 or more items, so before the log walker such a
    /// deposit could never be withdrawn and its tokens stayed locked. Any depositor can put more than 32 logs in one
    /// transaction (a call to a contract that logs a lot).
    function test_defect3_depositAtLogForty_of64Logs_pays() public {
        ReceiptFixtures.Named memory named = ReceiptFixtures.many_logs();
        assertEq(named.logIndex, 40);
        Scene memory scene = _scene(named, _defaultParams());
        assertEq(scene.proof.logIndex, 40);
        vault.withdraw(scene.proof);
        _assertPaid(named);
    }

    /// Claim: a log index past the end of a long list still reverts with the count. Shows: index 64 in the 64-log
    /// receipt reverts with `LogIndexOutOfRange(64, 64)`; index 63 (a log of another emitter) reverts with
    /// `WrongEmitter`, which proves the walk reached the last log. Matters: the walker counts every item, not 32.
    function test_defect3_logIndexPastTheEndOfLongListReverts() public {
        ReceiptFixtures.Named memory named = ReceiptFixtures.many_logs();
        Scene memory scene = _scene(named, _defaultParams());

        BridgeVault.WithdrawalProof memory past = _clone(scene.proof);
        past.logIndex = 64;
        _expectRejected(past, abi.encodeWithSelector(BridgeVault.LogIndexOutOfRange.selector, uint256(64), uint256(64)));

        BridgeVault.WithdrawalProof memory last = _clone(scene.proof);
        last.logIndex = 63;
        _expectRejected(last, abi.encodeWithSelector(BridgeVault.WrongEmitter.selector, ReceiptFixtures.REMOTE_VAULT, ReceiptFixtures.OTHER_EMITTER));

        vault.withdraw(scene.proof); // control: log 40 pays
        _assertPaid(named);
    }
}
