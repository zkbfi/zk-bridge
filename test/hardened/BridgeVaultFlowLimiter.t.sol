// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {console2} from "forge-std/console2.sol";
import {IERC20Errors} from "@openzeppelin/contracts/interfaces/draft-IERC6093.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {BridgeVault} from "../../src/hardened/BridgeVault.sol";
import {ScriptedFlowLimiter} from "./utils/FlowLimiterMocks.sol";
import {WithdrawalScenes} from "./utils/WithdrawalScenes.sol";
import {ReceiptFixtures} from "./utils/ReceiptFixtures.sol";

/// @notice Tests of the flow limiter hook: the one optional contract that the vault asks before it books a deposit or
/// pays a withdrawal, and that can detach itself for good. The limiter here is a test double with no real rules.
contract BridgeVaultFlowLimiterTest is WithdrawalScenes {
    event FlowLimiterDetached(address indexed limiter);

    address internal feeAuthority = makeAddr("fee authority");
    ScriptedFlowLimiter internal limiter;
    /// @dev The vault that pays withdrawals, with the limiter attached. It sits at the address of the fixture receipts.
    BridgeVault internal payoutVault;
    /// @dev The vault that takes deposits on chain A, with the limiter attached and a live fee.
    BridgeVault internal depositVault;

    function setUp() public override {
        super.setUp();
        limiter = new ScriptedFlowLimiter();
        payoutVault = _newWithdrawalVault(0, DEFAULT_CAPELLA_ERA, address(limiter));
        tokenOnB.mint(address(payoutVault), 1_000_000e18);
        depositVault = _newDepositVault(address(limiter));
    }

    // ---------------------------------------------------------------- helpers

    /// @dev A vault on chain A for `tokenOnA`, with a fee of 25 basis points and the given limiter.
    function _newDepositVault(address flowLimiter) internal returns (BridgeVault) {
        BridgeVault.TokenPair[] memory pairs = new BridgeVault.TokenPair[](1);
        pairs[0] = BridgeVault.TokenPair(address(tokenOnA), address(tokenOnB), 18);
        vm.chainId(CHAIN_A);
        return _opened(new BridgeVault(
            address(lightClientForA), CHAIN_A, CHAIN_B, address(vaultB), pairs,
            BridgeVault.VaultTerms(0, feeAuthority, makeAddr("fee recipient"), 25, 50, flowLimiter, address(lightClientForB)),
            DEFAULT_CAPELLA_ERA, address(gateA)
        ));
    }

    /// @dev Mints and approves for `user`, then deposits `amount` into `vault` for `bob`.
    function _depositInto(BridgeVault vault, address user, uint256 amount) internal returns (bytes32 nonce) {
        vm.chainId(CHAIN_A);
        tokenOnA.mint(user, amount);
        vm.startPrank(user);
        tokenOnA.approve(address(vault), amount);
        nonce = vault.deposit(address(tokenOnA), bob, amount, 25, "");
        vm.stopPrank();
    }

    /// @dev The first scene of the default parameters, built once for the payout vault.
    function _withdrawalScene() internal returns (ReceiptFixtures.Named memory named, Scene memory scene) {
        named = ReceiptFixtures.type2();
        scene = _scene(named, _defaultParams());
    }

    function _expectReentryRefused() internal view {
        assertTrue(limiter.moveTried(), "the limiter tried its move");
        assertEq(
            limiter.moveError(),
            abi.encodeWithSelector(ReentrancyGuard.ReentrancyGuardReentrantCall.selector),
            "the vault refused the reentry with the guard error"
        );
    }

    // ================================================================ no limiter

    /// Claim: a vault with no limiter deposits and withdraws as before. Shows: `flowLimiter` is zero; a deposit and a
    /// withdrawal both succeed with no limiter to call. Matters: the zero address is the default, and the cost of the
    /// hook with no limiter is one storage read (see the gas tests).
    function test_flowLimiter_none_depositAndWithdrawWork() public {
        BridgeVault plainPayout = _newWithdrawalVault();
        tokenOnB.mint(address(plainPayout), 1_000_000e18);
        BridgeVault plainDeposit = _newDepositVault(address(0));
        assertEq(address(plainPayout.flowLimiter()), address(0));
        assertEq(address(plainDeposit.flowLimiter()), address(0));

        _depositInto(plainDeposit, alice, 1000e18);
        assertEq(plainDeposit.depositCount(), 1);

        (ReceiptFixtures.Named memory named, Scene memory scene) = _withdrawalScene();
        plainPayout.withdraw(scene.proof);
        assertEq(tokenOnB.balanceOf(ReceiptFixtures.RECIPIENT), named.amount);
        assertEq(limiter.depositChecks() + limiter.withdrawalChecks(), 0, "an unrelated limiter is never called");
    }

    // ================================================================ a limiter that refuses

    /// Claim: a limiter that refuses a deposit stops it, and the same deposit works after the limiter allows it.
    /// Shows: the deposit reverts with `FlowRefused`; the tokens stay with the sender, no deposit is counted and no fee
    /// is booked; after `setRefusals(false, false)` the same call succeeds. Matters: the refusal undoes the whole call.
    function test_flowLimiter_refusedDeposit_revertsAndSucceedsAfterAllow() public {
        limiter.setRefusals(true, false);
        tokenOnA.mint(alice, 1000e18);
        vm.startPrank(alice);
        tokenOnA.approve(address(depositVault), 1000e18);
        vm.expectRevert(ScriptedFlowLimiter.FlowRefused.selector);
        depositVault.deposit(address(tokenOnA), bob, 1000e18, 25, "");
        vm.stopPrank();
        assertEq(tokenOnA.balanceOf(alice), 1000e18, "the tokens stay with the sender");
        assertEq(depositVault.depositCount(), 0);
        assertEq(depositVault.accruedFees(address(tokenOnA)), 0, "the fee is not booked");

        limiter.setRefusals(false, false);
        vm.prank(alice);
        depositVault.deposit(address(tokenOnA), bob, 1000e18, 25, "");
        assertEq(depositVault.depositCount(), 1);
        assertEq(tokenOnA.balanceOf(alice), 0);
    }

    /// Claim: a limiter that refuses a withdrawal stops it, the nonce stays unclaimed, and the same proof pays after
    /// the limiter allows it. Shows: the withdrawal reverts with `FlowRefused`; the nonce is unclaimed and the recipient
    /// has nothing; after the allow the same proof pays and marks the nonce. Matters: a refused claim stays claimable,
    /// so a rate limit works as wait and retry with no queue in the vault.
    function test_flowLimiter_refusedWithdrawal_staysClaimableAfterAllow() public {
        (ReceiptFixtures.Named memory named, Scene memory scene) = _withdrawalScene();
        limiter.setRefusals(false, true);
        vm.expectRevert(ScriptedFlowLimiter.FlowRefused.selector);
        payoutVault.withdraw(scene.proof);
        assertFalse(payoutVault.claimed(named.nonce), "the nonce stays unclaimed");
        assertEq(tokenOnB.balanceOf(ReceiptFixtures.RECIPIENT), 0);

        limiter.setRefusals(false, false);
        payoutVault.withdraw(scene.proof);
        assertTrue(payoutVault.claimed(named.nonce));
        assertEq(tokenOnB.balanceOf(ReceiptFixtures.RECIPIENT), named.amount);
    }

    /// Claim: a limiter sees only the calls that it should. Shows: a refusal of withdrawals does not stop deposits, and a
    /// refusal of deposits does not stop withdrawals. Matters: each hook is its own check.
    function test_flowLimiter_refusalsAreIndependent() public {
        (, Scene memory scene) = _withdrawalScene();
        limiter.setRefusals(false, true);
        _depositInto(depositVault, alice, 1000e18); // deposits still pass

        limiter.setRefusals(true, false);
        payoutVault.withdraw(scene.proof); // withdrawals still pass
        assertEq(limiter.depositChecks(), 1);
        assertEq(limiter.withdrawalChecks(), 1);
    }

    // ================================================================ what the limiter receives

    /// Claim: on a deposit the limiter gets the local token, the depositor and the NET amount, after the fee. Shows: for
    /// a deposit of 1000 tokens with a fee of 25 basis points, the limiter sees 997.5 tokens, the same as the deposit
    /// event. Matters: the limiter counts what is bridged, not what the user sent.
    function test_flowLimiter_deposit_receivesTheNetAmount() public {
        _depositInto(depositVault, alice, 1000e18);
        assertEq(limiter.depositChecks(), 1);
        assertEq(limiter.lastDepositToken(), address(tokenOnA));
        assertEq(limiter.lastDepositor(), alice);
        assertEq(limiter.lastDepositAmount(), 997.5e18, "the amount after the fee");
        assertEq(depositVault.accruedFees(address(tokenOnA)), 2.5e18);
    }

    /// Claim: on a withdrawal the limiter gets the local token, the recipient, the amount and the nonce. Shows: the four
    /// values equal the fixture receipt, and the token is the local token of the vault, not the remote one. Matters: the
    /// limiter keys its record on the same nonce that the vault marks.
    function test_flowLimiter_withdrawal_receivesTokenRecipientAmountAndNonce() public {
        (ReceiptFixtures.Named memory named, Scene memory scene) = _withdrawalScene();
        payoutVault.withdraw(scene.proof);
        assertEq(limiter.withdrawalChecks(), 1);
        assertEq(limiter.lastWithdrawalToken(), address(tokenOnB), "the local token");
        assertTrue(limiter.lastWithdrawalToken() != ReceiptFixtures.REMOTE_TOKEN);
        assertEq(limiter.lastWithdrawalRecipient(), ReceiptFixtures.RECIPIENT);
        assertEq(limiter.lastWithdrawalAmount(), named.amount);
        assertEq(limiter.lastWithdrawalNonce(), named.nonce);
    }

    /// Claim: the vault asks the limiter only after the proof checks pass, and never for a claimed deposit. Shows: the
    /// first withdrawal calls the limiter once; the same proof again reverts with `AlreadyClaimed` and the limiter
    /// is not called a second time. Matters: a limiter that records usage must never record a withdrawal that is invalid.
    function test_flowLimiter_withdrawal_isNotCalledForAClaimedDeposit() public {
        (ReceiptFixtures.Named memory named, Scene memory scene) = _withdrawalScene();
        payoutVault.withdraw(scene.proof);
        assertEq(limiter.withdrawalChecks(), 1);

        vm.expectRevert(abi.encodeWithSelector(BridgeVault.AlreadyClaimed.selector, named.nonce));
        payoutVault.withdraw(scene.proof);
        assertEq(limiter.withdrawalChecks(), 1, "the limiter saw nothing the second time");
    }

    // ================================================================ detach

    /// Claim: only the limiter can detach, and the detach is one-way. Shows: an ordinary caller, the fee authority and
    /// the recipient revert with `NotFlowLimiter`; the limiter detaches, the event names it, and the view reads zero; a
    /// second detach by the same limiter reverts. A vault with no limiter refuses everyone. Matters: the limiter's own
    /// rules decide when it ends, and nothing can attach a limiter again.
    function test_flowLimiter_detach_isOnlyForTheLimiterAndOneWay() public {
        address[3] memory outsiders = [alice, feeAuthority, ReceiptFixtures.RECIPIENT];
        for (uint256 i = 0; i < outsiders.length; i++) {
            vm.prank(outsiders[i]);
            vm.expectRevert(abi.encodeWithSelector(BridgeVault.NotFlowLimiter.selector, outsiders[i]));
            payoutVault.detachFlowLimiter();
        }
        assertEq(address(payoutVault.flowLimiter()), address(limiter), "outsiders changed nothing");

        vm.expectEmit(true, false, false, false, address(payoutVault));
        emit FlowLimiterDetached(address(limiter));
        limiter.detachFrom(payoutVault);
        assertEq(address(payoutVault.flowLimiter()), address(0));

        vm.expectRevert(abi.encodeWithSelector(BridgeVault.NotFlowLimiter.selector, address(limiter)));
        limiter.detachFrom(payoutVault);

        BridgeVault plainDeposit = _newDepositVault(address(0));
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(BridgeVault.NotFlowLimiter.selector, alice));
        plainDeposit.detachFlowLimiter();
    }

    /// Claim: after the detach the vault never calls the limiter. Shows: a limiter that refuses everything blocks a
    /// deposit and a withdrawal; after the detach both succeed and the call counters do not move. Matters: the way out
    /// of a limiter that would otherwise block the vault for good, when its own rules allow it.
    function test_flowLimiter_afterDetach_theVaultNeverCallsIt() public {
        (ReceiptFixtures.Named memory named, Scene memory scene) = _withdrawalScene();
        limiter.setRefusals(true, true);
        vm.expectRevert(ScriptedFlowLimiter.FlowRefused.selector);
        payoutVault.withdraw(scene.proof);
        limiter.detachFrom(payoutVault);
        limiter.detachFrom(depositVault);

        uint256 depositChecksBefore = limiter.depositChecks();
        uint256 withdrawalChecksBefore = limiter.withdrawalChecks();
        payoutVault.withdraw(scene.proof);
        _depositInto(depositVault, alice, 1000e18);
        assertEq(tokenOnB.balanceOf(ReceiptFixtures.RECIPIENT), named.amount);
        assertEq(depositVault.depositCount(), 1);
        assertEq(limiter.depositChecks(), depositChecksBefore);
        assertEq(limiter.withdrawalChecks(), withdrawalChecksBefore);
    }

    // ================================================================ a hostile limiter

    /// Claim: a limiter cannot reenter the vault. Shows: in a deposit and in a withdrawal, an attempt to call
    /// `withdraw` and an attempt to call `deposit` each fail with the guard error, and the outer call still completes
    /// (the test limiter swallows the failure and allows). Matters: the vault calls the limiter under its reentrancy
    /// guard, so the limiter cannot act on a half-finished call.
    function test_flowLimiter_cannotReenter() public {
        ScriptedFlowLimiter.Move[2] memory attempts =
            [ScriptedFlowLimiter.Move.ReenterWithdraw, ScriptedFlowLimiter.Move.ReenterDeposit];
        for (uint256 i = 0; i < attempts.length; i++) {
            limiter.setMove(attempts[i]);
            _depositInto(depositVault, alice, 1000e18);
            _expectReentryRefused();
        }
        assertEq(depositVault.depositCount(), 2, "both outer deposits completed");

        (ReceiptFixtures.Named memory named, Scene memory scene) = _withdrawalScene();
        limiter.setMove(ScriptedFlowLimiter.Move.ReenterDeposit);
        payoutVault.withdraw(scene.proof);
        _expectReentryRefused();
        assertTrue(payoutVault.claimed(named.nonce), "the outer withdrawal completed");

        // A second scene for the other attempt: another receipt of the same vault.
        ReceiptFixtures.Named memory second = ReceiptFixtures.legacy();
        Scene memory secondScene = _scene(second, _defaultParams());
        limiter.setMove(ScriptedFlowLimiter.Move.ReenterWithdraw);
        payoutVault.withdraw(secondScene.proof);
        _expectReentryRefused();
        assertTrue(payoutVault.claimed(second.nonce));
    }

    /// Claim: a limiter cannot move the vault's tokens. Shows: in a deposit and in a withdrawal, `transferFrom` from the
    /// vault to the limiter fails with an allowance of zero, and the limiter ends with no tokens. Matters: the vault
    /// gives no approval to anyone, so a limiter holds no power over funds.
    function test_flowLimiter_cannotMoveVaultFunds() public {
        limiter.setMove(ScriptedFlowLimiter.Move.PullVaultTokens);

        _depositInto(depositVault, alice, 1000e18);
        assertEq(
            limiter.moveError(),
            abi.encodeWithSelector(IERC20Errors.ERC20InsufficientAllowance.selector, address(limiter), 0, 997.5e18)
        );
        assertEq(tokenOnA.balanceOf(address(limiter)), 0);
        assertEq(tokenOnA.balanceOf(address(depositVault)), 1000e18, "the vault holds the deposit and the fee");

        (ReceiptFixtures.Named memory named, Scene memory scene) = _withdrawalScene();
        uint256 vaultBefore = tokenOnB.balanceOf(address(payoutVault));
        payoutVault.withdraw(scene.proof);
        assertEq(
            limiter.moveError(),
            abi.encodeWithSelector(IERC20Errors.ERC20InsufficientAllowance.selector, address(limiter), 0, named.amount)
        );
        assertEq(tokenOnB.balanceOf(address(limiter)), 0);
        assertEq(tokenOnB.balanceOf(address(payoutVault)), vaultBefore - named.amount, "only the payout left the vault");
    }

    // ================================================================ gas

    /// Claim: a limiter that allows adds a bounded cost to a deposit. Shows: the gas of the first deposit with a trivial
    /// limiter attached. Matters: the cost with no limiter is in `BridgeVaultFee.t.sol`; this is the cost of the call.
    function test_gas_deposit_withAllowingLimiter() public {
        vm.chainId(CHAIN_A);
        tokenOnA.mint(alice, 1000e18);
        vm.startPrank(alice);
        tokenOnA.approve(address(depositVault), 1000e18);
        uint256 before = gasleft();
        depositVault.deposit(address(tokenOnA), bob, 1000e18, 25, "");
        uint256 used = before - gasleft();
        vm.stopPrank();
        console2.log("deposit gas, allowing limiter attached", used);
    }
}
