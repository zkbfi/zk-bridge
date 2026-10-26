// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Vm} from "forge-std/Vm.sol";
import {console2} from "forge-std/console2.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IERC20Errors} from "@openzeppelin/contracts/interfaces/draft-IERC6093.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {MockERC20} from "../../../src/mocks/MockERC20.sol";
import {NoReturnToken} from "../../../src/mocks/NoReturnToken.sol";
import {ReturnsFalseToken} from "../../../src/mocks/ReturnsFalseToken.sol";
import {TokenMediator} from "../../../src/hardened/mediator/TokenMediator.sol";
import {BurnAllToken} from "../utils/HardenedMocks.sol";
import {MediatorFixture, MockAMB, ScriptedMediatorLimiter} from "./utils/MediatorSupport.sol";
import {MedBonusToken, MedHostileToken, MedHostileLimiter} from "./utils/MedMocks.sol";

/// @notice The checks that the vault tests held and that no other mediator test makes: tokens that misbehave on the
/// way in and on the way out, hostile tokens and limiters that call back into the mediator, the pull-based fee
/// collection, and the independence of the limiter checks. Each test names the vault test that it replaces.
contract TokenMediatorGapsTest is MediatorFixture {
    event ClaimableRecorded(address indexed token, address indexed account, uint256 value, bytes32 indexed messageId);
    event FallbackUsed(
        address indexed token, address indexed recipient, address indexed fallbackRecipient, bytes32 messageId
    );
    event FeeCharged(address indexed token, uint256 fee, TokenMediator.FeeDirection direction);
    event FeesCollected(address indexed token, address indexed feeRecipient, uint256 amount);

    address internal treasury = makeAddr("treasury");

    // ------------------------------------------------------------------------------------------------ helpers

    /// @dev A fee that does not change: the start rate and the floor are the rate, and the step is zero.
    function _flatFeeTerms(uint256 rate, address limiter)
        internal
        view
        returns (TokenMediator.MediatorTerms memory terms)
    {
        terms = _noTerms();
        terms.feeRecipient = treasury;
        terms.feeStartRate = rate;
        terms.feeFloorRate = rate;
        terms.flowLimiter = limiter;
    }

    function _redeploy(TokenMediator.MediatorTerms memory termsA, TokenMediator.MediatorTerms memory termsB) internal {
        _deployMediators(termsA, termsB);
        vm.prank(alice);
        tokenA.approve(address(mediatorA), type(uint256).max);
    }

    /// @dev Sends `value` of a copy from `from` on chain B back to `receiver`, with `from` as the fallback. It does
    /// not deliver. It returns the index of the message on chain B.
    function _sendBack(address copy, address from, address receiver, uint256 value) internal returns (uint256) {
        vm.startPrank(from);
        IERC20(copy).approve(address(mediatorB), type(uint256).max);
        mediatorB.relayTokens(copy, receiver, value);
        vm.stopPrank();
        return _lastIndexB();
    }

    /// @dev Delivers message `index` of chain B on chain A with more gas than the release limit. A hostile token
    /// that relays inside a release needs it, because the mock bridge stores every message it gets.
    function _deliverBtoAWithGas(uint256 index, uint256 gas) internal returns (bool ok) {
        MockAMB.Sent memory message = ambB.messageAt(index);
        (ok,) = ambA.execute(message.target, message.data, message.sender, bytes32(CHAIN_B), message.id, gas);
    }

    /// @dev A hostile token, native on chain A, with `locked` of it bridged to alice on chain B.
    function _hostileWorld(TokenMediator mediator, uint256 locked) internal returns (MedHostileToken token) {
        token = new MedHostileToken();
        token.mint(alice, 1_000 ether);
        vm.startPrank(alice);
        token.approve(address(mediator), type(uint256).max);
        mediator.relayTokens(address(token), alice, locked);
        vm.stopPrank();
        (bool ok,) = _deliverAtoB(_lastIndexA());
        assertTrue(ok);
    }

    /// @dev The tokens of a native token on chain A are backed: the balance covers the record and the fees, and
    /// the copies on chain B equal the record once every message is delivered.
    function _assertBacked(address token, address copy) internal view {
        uint256 record = mediatorA.mediatorBalance(token);
        assertGe(IERC20(token).balanceOf(address(mediatorA)), record + mediatorA.accruedFees(token), "balance");
        assertEq(IERC20(copy).totalSupply(), record, "the copies equal the record");
    }

    function _feeEventsOf(address emitter) internal view returns (uint256 count) {
        Vm.Log[] memory logs = vm.getRecordedLogs();
        for (uint256 i = 0; i < logs.length; i++) {
            if (logs[i].emitter == emitter && logs[i].topics[0] == FeeCharged.selector) count++;
        }
    }

    // ------------------------------------------------------------------------------------------------ relay inputs

    /// Claim: a relay without allowance, or without balance, reverts with the token's own error and leaves no trace.
    /// Shows: the exact errors; the tokens stay with the sender; no message, no record, no registration. A relay with
    /// an allowance and a balance works after. Matters: replaces `test_H12_deposit_revertsWithoutAllowanceOrBalance`.
    function test_aRelayWithoutAllowanceOrBalanceRevertsAndTheTokensStayWithTheSender() public {
        MockERC20 fresh = new MockERC20("Fresh", "FRS");
        fresh.mint(bob, 1 ether);
        vm.startPrank(bob);
        vm.expectRevert(
            abi.encodeWithSelector(IERC20Errors.ERC20InsufficientAllowance.selector, address(mediatorA), 0, 1 ether)
        );
        mediatorA.relayTokens(address(fresh), carol, 1 ether);
        fresh.approve(address(mediatorA), 2 ether);
        vm.expectRevert(abi.encodeWithSelector(IERC20Errors.ERC20InsufficientBalance.selector, bob, 1 ether, 2 ether));
        mediatorA.relayTokens(address(fresh), carol, 2 ether);
        vm.stopPrank();

        assertEq(fresh.balanceOf(bob), 1 ether, "the tokens stay with the sender");
        assertEq(fresh.balanceOf(address(mediatorA)), 0);
        assertEq(mediatorA.mediatorBalance(address(fresh)), 0);
        assertFalse(mediatorA.isRegisteredAsNativeToken(address(fresh)));
        assertEq(ambA.sentCount(), 0, "no message");

        vm.prank(bob);
        mediatorA.relayTokens(address(fresh), carol, 1 ether);
        assertEq(ambA.sentCount(), 1, "control: the honest relay works");
    }

    /// Claim: a token whose transfer returns true and moves nothing is not a relay. Shows: `ZeroAmount`, no message,
    /// no record, and the sender keeps the tokens. Matters: replaces `test_H13_deposit_revertsWhenNothingIsReceived`.
    /// The mediator measures the balance. It does not trust the return value.
    function test_aRelayOfATokenThatMovesNothingIsRefused() public {
        BurnAllToken burn = new BurnAllToken();
        burn.mint(alice, 10 ether);
        vm.startPrank(alice);
        burn.approve(address(mediatorA), type(uint256).max);
        vm.expectRevert(TokenMediator.ZeroAmount.selector);
        mediatorA.relayTokens(address(burn), bob, 10 ether);
        vm.stopPrank();
        assertEq(ambA.sentCount(), 0);
        assertEq(mediatorA.mediatorBalance(address(burn)), 0);
        assertEq(burn.balanceOf(alice), 10 ether);
    }

    /// Claim: a token that credits more than the sender named is refused. Shows: `ReceivedMoreThanSent` with the two
    /// amounts, and no message. Matters: no vault test had this case. Without the check the record would count tokens
    /// that no sender gave, and the other chain would mint them.
    function test_aRelayOfATokenThatCreditsMoreThanWasSentIsRefused() public {
        MedBonusToken bonus = new MedBonusToken();
        bonus.mint(alice, 10 ether);
        vm.startPrank(alice);
        bonus.approve(address(mediatorA), type(uint256).max);
        vm.expectRevert(abi.encodeWithSelector(TokenMediator.ReceivedMoreThanSent.selector, 10 ether + 1, 10 ether));
        mediatorA.relayTokens(address(bonus), bob, 10 ether);
        vm.stopPrank();
        assertEq(ambA.sentCount(), 0);
        assertEq(mediatorA.mediatorBalance(address(bonus)), 0);
    }

    // ------------------------------------------------------------------------------------------------ odd tokens

    /// Claim: a token whose `transfer` returns false can be relayed, and its release never burns the claim. Shows:
    /// the relay works (its `transferFrom` is fine); the release does not revert, so the message stays delivered; the
    /// amount is claimable by the fallback; the record and the balance keep the tokens; `claim` reverts with
    /// `ClaimTransferFailed` and keeps the amount. Matters: replaces
    /// `test_H13_withdraw_returnsFalseTokenRevertsAndKeepsClaim`. The vault reverted. The mediator cannot, so the
    /// claim moves to `claimable`.
    function test_aTokenThatReturnsFalseOnTransferLeavesAClaimableAmount() public {
        ReturnsFalseToken bad = new ReturnsFalseToken("Bad", "BAD");
        bad.mint(alice, 100 ether);
        vm.prank(alice);
        bad.approve(address(mediatorA), type(uint256).max);
        _bridgeAtoB(alice, address(bad), alice, 100 ether);
        address copy = _copyOf(address(bad));

        uint256 index = _sendBack(copy, alice, bob, 60 ether);
        bytes32 id = ambB.messageAt(index).id;
        vm.expectEmit(true, true, true, true, address(mediatorA));
        emit ClaimableRecorded(address(bad), alice, 60 ether, id);
        (bool ok,) = _deliverBtoA(index);
        assertTrue(ok, "the delivery does not revert, which would lose the tokens");
        assertEq(bad.balanceOf(bob), 0);
        assertEq(bad.balanceOf(alice), 0);
        assertEq(mediatorA.claimable(address(bad), alice), 60 ether, "the fallback can claim it");
        assertEq(mediatorA.mediatorBalance(address(bad)), 100 ether, "the record keeps the amount");
        assertEq(bad.balanceOf(address(mediatorA)), 100 ether, "the tokens stay in the mediator");

        vm.expectRevert(abi.encodeWithSelector(TokenMediator.ClaimTransferFailed.selector, address(bad), alice));
        mediatorA.claim(address(bad), alice);
        assertEq(mediatorA.claimable(address(bad), alice), 60 ether, "the failed claim keeps the amount");
        assertEq(mediatorA.mediatorBalance(address(bad)), 100 ether);
    }

    /// Claim: a token that returns nothing (as USDT does) works in both directions. Shows: relay, mint of the copy
    /// with the decimals of the token, burn and release back. Matters: replaces `test_H13_noReturnTokenWorksBothWays`.
    function test_aTokenThatReturnsNothingWorksInBothDirections() public {
        NoReturnToken usdt = new NoReturnToken();
        usdt.mint(alice, 50e6);
        vm.prank(alice);
        usdt.approve(address(mediatorA), 50e6);

        _bridgeAtoB(alice, address(usdt), bob, 50e6);
        address copy = _copyOf(address(usdt));
        assertEq(usdt.balanceOf(address(mediatorA)), 50e6);
        assertEq(mediatorA.mediatorBalance(address(usdt)), 50e6);
        assertEq(IERC20(copy).balanceOf(bob), 50e6);
        assertEq(BridgedDecimals(copy).decimals(), 6, "the copy has the decimals of the token");

        _bridgeBtoA(bob, copy, carol, 30e6);
        assertEq(usdt.balanceOf(carol), 30e6, "the release pays a token that returns nothing");
        assertEq(mediatorA.mediatorBalance(address(usdt)), 20e6);
        assertEq(IERC20(copy).totalSupply(), 20e6);
    }

    // ------------------------------------------------------------------------------------------------ hostile tokens

    /// Claim: a token that relays through the mediator while the mediator pays it out cannot corrupt the accounting.
    /// Shows: the token pays after its callback. The nested relay locks 10, the release pays 60, and the record, the
    /// balance and the supply of the copies agree after both messages are delivered. Matters: replaces
    /// `test_H13_withdraw_blocksReentrancyThroughToken` for a token that pays.
    function test_aTokenThatRelaysDuringAReleaseAndThenPaysKeepsTheAccountingExact() public {
        MedHostileToken token = _hostileWorld(mediatorA, 100 ether);
        token.fundSelf(address(mediatorA), 10 ether);
        uint256 index = _sendBack(_copyOf(address(token)), alice, carol, 60 ether);
        token.arm(
            address(mediatorA),
            abi.encodeWithSignature("relayTokens(address,uint256)", address(token), 10 ether),
            MedHostileToken.Ending.Pay
        );

        assertTrue(_deliverBtoAWithGas(index, 1_500_000));
        assertEq(token.hooksRun(), 1);
        assertTrue(token.hookOk(), "the nested relay ran");
        assertEq(token.balanceOf(carol), 60 ether);
        (bool delivered,) = _deliverAtoB(_lastIndexA());
        assertTrue(delivered, "the nested relay made a message");
        assertEq(mediatorA.mediatorBalance(address(token)), 50 ether, "100 locked, 10 locked again, 60 released");
        _assertBacked(address(token), _copyOf(address(token)));
    }

    /// Claim: the same, when the token refuses the first payment after its callback. Shows: the first payment
    /// fails, the fallback receives the 60, and the record still counts the nested lock of 10: the record equals the
    /// balance and the supply of the copies. Matters: a release restores the record after a refusal. A restore from
    /// a stale copy would erase what the nested relay locked, and the copies would exceed the record.
    function test_aTokenThatRelaysDuringAReleaseAndThenRefusesKeepsTheNestedLock() public {
        MedHostileToken token = _hostileWorld(mediatorA, 100 ether);
        token.fundSelf(address(mediatorA), 10 ether);
        uint256 index = _sendBack(_copyOf(address(token)), alice, carol, 60 ether);
        uint256 aliceBefore = token.balanceOf(alice);
        token.arm(
            address(mediatorA),
            abi.encodeWithSignature("relayTokens(address,uint256)", address(token), 10 ether),
            MedHostileToken.Ending.Refuse
        );

        vm.expectEmit(true, true, true, false, address(mediatorA));
        emit FallbackUsed(address(token), carol, alice, ambB.messageAt(index).id);
        assertTrue(_deliverBtoAWithGas(index, 1_500_000));
        assertEq(token.balanceOf(alice) - aliceBefore, 60 ether, "the fallback received the release");
        (bool delivered,) = _deliverAtoB(_lastIndexA());
        assertTrue(delivered);
        assertEq(mediatorA.mediatorBalance(address(token)), 50 ether, "the nested lock stays in the record");
        _assertBacked(address(token), _copyOf(address(token)));
    }

    /// Claim: a token that claims for another account while the mediator pays it out cannot corrupt the accounting.
    /// Shows: a claim of 60 waits for alice. During a release of 20 to carol, the token calls `claim`. Alice is paid
    /// once, carol is paid once, and the record, the balance and the supply agree. Matters: `claim` and the release
    /// both move the record, so a nested one must not undo the other.
    function test_aTokenThatClaimsDuringAReleaseKeepsTheAccountingExact() public {
        MedHostileToken token = _hostileWorld(mediatorA, 100 ether);
        address copy = _copyOf(address(token));
        token.setRefusingAll(true);
        (bool ok,) = _deliverBtoA(_sendBack(copy, alice, bob, 60 ether));
        assertTrue(ok);
        assertEq(mediatorA.claimable(address(token), alice), 60 ether, "control: a claim waits");
        token.setRefusingAll(false);

        uint256 index = _sendBack(copy, alice, carol, 20 ether);
        uint256 aliceBefore = token.balanceOf(alice);
        token.arm(
            address(mediatorA), abi.encodeCall(TokenMediator.claim, (address(token), alice)), MedHostileToken.Ending.Pay
        );
        (ok,) = _deliverBtoA(index);
        assertTrue(ok);
        assertTrue(token.hookOk(), "the nested claim ran");
        assertEq(token.balanceOf(alice) - aliceBefore, 60 ether, "alice is paid once");
        assertEq(token.balanceOf(carol), 20 ether);
        assertEq(mediatorA.claimable(address(token), alice), 0);
        assertEq(mediatorA.mediatorBalance(address(token)), 20 ether);
        _assertBacked(address(token), copy);
    }

    /// Claim: a token that collects the fees while the mediator pays it out cannot make the mediator pay them twice.
    /// Shows: with 10 of fees accrued, the nested `collectFees` pays the treasury 10, and the accrued amount is zero.
    /// The balance covers the record. Matters: the fees and the record are separate. A release and a collection must
    /// not draw on the same tokens.
    function test_aTokenThatCollectsFeesDuringAReleaseKeepsTheAccountingExact() public {
        _redeploy(_flatFeeTerms(100e14, address(0)), _flatFeeTerms(0, address(0)));
        MedHostileToken token = _hostileWorld(mediatorA, 1_000 ether);
        address copy = _copyOf(address(token));
        assertEq(mediatorA.accruedFees(address(token)), 10 ether);
        uint256 index = _sendBack(copy, alice, carol, 100 ether);
        token.arm(
            address(mediatorA), abi.encodeCall(TokenMediator.collectFees, (address(token))), MedHostileToken.Ending.Pay
        );

        (bool ok,) = _deliverBtoA(index);
        assertTrue(ok);
        assertTrue(token.hookOk());
        assertEq(token.balanceOf(treasury), 11 ether, "the fees are paid once: 10 ether outgoing, 1 ether incoming");
        assertEq(mediatorA.accruedFees(address(token)), 0);
        assertEq(token.balanceOf(carol), 99 ether, "100 ether less the 1% incoming fee");
        assertEq(mediatorA.mediatorBalance(address(token)), 890 ether);
        _assertBacked(address(token), copy);
    }

    /// Claim: a token that calls back into the mediator while `collectFees` pays it cannot collect twice, relay or
    /// claim. Shows: for each of the three calls the guard refuses with its own error, the collection pays the
    /// treasury once, and the accrued amount is zero. Matters: replaces `test_fee_collect_zeroesBeforeItTransfers`
    /// from the side of reentry. See the next test for the order of the writes.
    function test_aTokenCannotCallBackIntoTheMediatorWhileCollectFeesPays() public {
        _redeploy(_flatFeeTerms(100e14, address(0)), _flatFeeTerms(0, address(0)));
        MedHostileToken token = _hostileWorld(mediatorA, 1_000 ether);
        bytes[3] memory attempts = [
            abi.encodeCall(TokenMediator.collectFees, (address(token))),
            abi.encodeCall(TokenMediator.claim, (address(token), alice)),
            abi.encodeWithSignature("relayTokens(address,uint256)", address(token), 1 ether)
        ];
        token.mint(alice, 300 ether);
        for (uint256 i = 0; i < attempts.length; i++) {
            vm.prank(alice);
            mediatorA.relayTokens(address(token), alice, 100 ether);
            uint256 fees = mediatorA.accruedFees(address(token));
            uint256 treasuryBefore = token.balanceOf(treasury);
            token.arm(address(mediatorA), attempts[i], MedHostileToken.Ending.Pay);

            mediatorA.collectFees(address(token));
            assertFalse(token.hookOk(), "the nested call failed");
            assertEq(
                token.hookReturned(), abi.encodeWithSelector(ReentrancyGuard.ReentrancyGuardReentrantCall.selector)
            );
            assertEq(token.balanceOf(treasury) - treasuryBefore, fees, "paid once");
            assertEq(mediatorA.accruedFees(address(token)), 0);
        }
    }

    /// Claim: a token that calls back into the mediator while `claim` pays it is refused by the guard. Shows: for
    /// each of the three calls the guard error, and the account is paid once. Matters: `claim` moves the record, so a
    /// nested call must not run on a half-finished state.
    function test_aTokenCannotCallBackIntoTheMediatorWhileClaimPays() public {
        MedHostileToken token = _hostileWorld(mediatorA, 100 ether);
        address copy = _copyOf(address(token));
        bytes[3] memory attempts = [
            abi.encodeCall(TokenMediator.collectFees, (address(token))),
            abi.encodeCall(TokenMediator.claim, (address(token), alice)),
            abi.encodeWithSignature("relayTokens(address,uint256)", address(token), 1 ether)
        ];
        for (uint256 i = 0; i < attempts.length; i++) {
            token.setRefusingAll(true);
            _deliverBtoA(_sendBack(copy, alice, bob, 10 ether));
            token.setRefusingAll(false);
            uint256 aliceBefore = token.balanceOf(alice);
            uint256 recordBefore = mediatorA.mediatorBalance(address(token));
            token.arm(address(mediatorA), attempts[i], MedHostileToken.Ending.Pay);

            mediatorA.claim(address(token), alice);
            assertFalse(token.hookOk(), "the nested call failed");
            assertEq(
                token.hookReturned(), abi.encodeWithSelector(ReentrancyGuard.ReentrancyGuardReentrantCall.selector)
            );
            assertEq(token.balanceOf(alice) - aliceBefore, 10 ether, "paid once");
            assertEq(mediatorA.mediatorBalance(address(token)), recordBefore - 10 ether);
        }
        _assertBacked(address(token), copy);
    }

    // ------------------------------------------------------------------------------------------------ fees

    /// Claim: `collectFees` sets the accrued amount to zero before it transfers. Shows: a token that reads
    /// `accruedFees` during the transfer reads zero; the event names the recipient and the amount; a second call
    /// reverts with `NoFeesAccrued`. Matters: replaces `test_fee_collect_zeroesBeforeItTransfers`. A reentrant path
    /// must never see the fees as still owed.
    function test_collectFeesZeroesTheAccruedAmountBeforeItTransfers() public {
        _redeploy(_flatFeeTerms(100e14, address(0)), _flatFeeTerms(0, address(0)));
        MedHostileToken token = _hostileWorld(mediatorA, 1_000 ether);
        assertEq(mediatorA.accruedFees(address(token)), 10 ether);
        token.arm(
            address(mediatorA),
            abi.encodeWithSignature("accruedFees(address)", address(token)),
            MedHostileToken.Ending.Pay
        );

        vm.expectEmit(true, true, false, true, address(mediatorA));
        emit FeesCollected(address(token), treasury, 10 ether);
        mediatorA.collectFees(address(token));
        assertEq(token.hooksRun(), 1, "the probe ran during the transfer");
        assertEq(abi.decode(token.hookReturned(), (uint256)), 0, "the amount was zero before the transfer");
        assertEq(token.balanceOf(treasury), 10 ether);

        vm.expectRevert(abi.encodeWithSelector(TokenMediator.NoFeesAccrued.selector, address(token)));
        mediatorA.collectFees(address(token));
    }

    /// Claim: the fee is computed on the received amount and rounds down, and a fee under one unit books nothing.
    /// Shows: 199 received at 1% is a fee of 1 and a net of 198; 99 received is a fee of 0 with no
    /// `FeeCharged` event; 1 received is never taken. Matters: replaces `test_fee_roundsDownOnTheReceivedAmount`. The
    /// existing rounding test covers one amount only. Rounding favours the sender, and the mediator never books a fee
    /// it did not take.
    function test_aFeeUnderOneUnitBooksNothingAndTheNetAmountIsTheRest() public {
        _redeploy(_flatFeeTerms(100e14, address(0)), _flatFeeTerms(0, address(0)));
        uint256[3] memory amounts = [uint256(199), 99, 1];
        uint256[3] memory expectedFees = [uint256(1), 0, 0];
        uint256 booked;
        for (uint256 i = 0; i < amounts.length; i++) {
            vm.recordLogs();
            vm.prank(alice);
            mediatorA.relayTokens(address(tokenA), bob, amounts[i]);
            uint256 feeEvents = _feeEventsOf(address(mediatorA));
            booked += expectedFees[i];
            assertEq(feeEvents, expectedFees[i], "one event only when a fee is booked");
            assertEq(mediatorA.accruedFees(address(tokenA)), booked);
        }
        assertEq(mediatorA.mediatorBalance(address(tokenA)), 199 + 99 + 1 - 1, "the record counts the net amounts");
        assertEq(tokenA.balanceOf(address(mediatorA)), 199 + 99 + 1, "the balance covers the record and the fee");
    }

    // ------------------------------------------------------------------------------------------------ flow limiter

    /// Claim: the refusals of a relay and of a release are independent. Shows: a limiter that refuses relays still
    /// lets a release through, and a limiter that refuses releases still lets a relay through. Matters: replaces
    /// `test_flowLimiter_refusalsAreIndependent`. Each hook is its own check.
    function test_theRefusalsOfARelayAndOfAReleaseAreIndependent() public {
        ScriptedMediatorLimiter limiter = new ScriptedMediatorLimiter();
        _redeploy(_flatFeeTerms(0, address(limiter)), _flatFeeTerms(0, address(0)));
        _bridgeAtoB(alice, address(tokenA), bob, 100 ether);
        address copy = _copyOf(address(tokenA));

        limiter.setRefusals(true, false);
        vm.prank(alice);
        vm.expectRevert(ScriptedMediatorLimiter.FlowRefused.selector);
        mediatorA.relayTokens(address(tokenA), bob, 1 ether);
        _bridgeBtoA(bob, copy, carol, 40 ether);
        assertEq(tokenA.balanceOf(carol), 40 ether, "the release passes while relays are refused");

        limiter.setRefusals(false, true);
        vm.prank(alice);
        mediatorA.relayTokens(address(tokenA), bob, 1 ether);
        uint256 index = _sendBack(copy, bob, dave, 10 ether);
        (bool ok,) = _deliverBtoA(index);
        assertTrue(ok);
        assertEq(mediatorA.claimable(address(tokenA), dave), 10 ether, "the release is held while releases are refused");
        assertEq(limiter.depositChecks(), 2, "the refused relay and the later relay");
        assertEq(limiter.withdrawalChecks(), 1, "the refused check reverted inside the handler and left no count");
    }

    /// Claim: a refused relay leaves no fee and no record. Shows: with a fee set and a limiter that refuses, the
    /// accrued fees, the record and the registration stay empty, and the sender keeps the tokens. Matters: replaces
    /// `test_flowLimiter_refusedDeposit_revertsAndSucceedsAfterAllow` for the fee and the record, which the existing
    /// test does not read. The fee is booked before the limiter runs, so the revert must undo it.
    function test_aRefusedRelayBooksNoFeeAndNoRecord() public {
        ScriptedMediatorLimiter limiter = new ScriptedMediatorLimiter();
        _redeploy(_flatFeeTerms(100e14, address(limiter)), _flatFeeTerms(0, address(0)));
        limiter.setRefusals(true, false);
        vm.prank(alice);
        vm.expectRevert(ScriptedMediatorLimiter.FlowRefused.selector);
        mediatorA.relayTokens(address(tokenA), bob, 1_000 ether);
        assertEq(mediatorA.accruedFees(address(tokenA)), 0, "the fee is not booked");
        assertEq(mediatorA.mediatorBalance(address(tokenA)), 0);
        assertFalse(mediatorA.isRegisteredAsNativeToken(address(tokenA)));
        assertEq(tokenA.balanceOf(alice), 1_000_000 ether);
        assertEq(ambA.sentCount(), 0);
    }

    /// Claim: the limiter is asked only about messages that the mediator accepts. Shows: a message from a wrong
    /// sender, from a wrong chain, from a caller that is not the bridge, and a release above the record each fail
    /// before the limiter runs, so its counter stays at zero. Matters: replaces
    /// `test_flowLimiter_withdrawal_isNotCalledForAClaimedDeposit`. The message bridge refuses a repeated message, so
    /// the mediator-level form is this one: a limiter that records usage must never record a refused release.
    function test_theLimiterIsNotAskedAboutAReleaseTheMediatorRefuses() public {
        ScriptedMediatorLimiter limiter = new ScriptedMediatorLimiter();
        _redeploy(_flatFeeTerms(0, address(limiter)), _flatFeeTerms(0, address(0)));
        _bridgeAtoB(alice, address(tokenA), bob, 10 ether);
        bytes memory release =
            abi.encodeWithSelector(TokenMediator.handleNativeTokens.selector, address(tokenA), carol, 1 ether);
        bytes32 id = bytes32(uint256(7));

        (bool ok,) = ambA.execute(address(mediatorA), release, carol, bytes32(CHAIN_B), id, 1_000_000);
        assertFalse(ok, "wrong sender");
        (ok,) = ambA.execute(address(mediatorA), release, address(mediatorB), bytes32(CHAIN_A), id, 1_000_000);
        assertFalse(ok, "wrong chain");
        vm.prank(carol);
        (ok,) = address(mediatorA).call(release);
        assertFalse(ok, "not the bridge");
        bytes memory greedy =
            abi.encodeWithSelector(TokenMediator.handleNativeTokens.selector, address(tokenA), carol, 11 ether);
        (ok,) = ambA.execute(address(mediatorA), greedy, address(mediatorB), bytes32(CHAIN_B), id, 1_000_000);
        assertFalse(ok, "above the record");
        assertEq(limiter.withdrawalChecks(), 0, "the limiter saw nothing");

        (ok,) = ambA.execute(address(mediatorA), release, address(mediatorB), bytes32(CHAIN_B), id, 1_000_000);
        assertTrue(ok, "control: the honest message passes");
        assertEq(limiter.withdrawalChecks(), 1);
    }

    /// Claim: only the limiter can detach, and a mediator with no limiter refuses every other caller too. Shows:
    /// the fee recipient and other accounts revert with `NotFlowLimiter` on a mediator with a limiter and on one
    /// without. Matters: replaces `test_flowLimiter_detach_isOnlyForTheLimiterAndOneWay` for the callers that the
    /// existing test does not try.
    function test_noOtherAccountCanDetachTheLimiter() public {
        ScriptedMediatorLimiter limiter = new ScriptedMediatorLimiter();
        _redeploy(_flatFeeTerms(0, address(limiter)), _flatFeeTerms(0, address(0)));
        address[3] memory outsiders = [treasury, address(mediatorB), alice];
        for (uint256 i = 0; i < outsiders.length; i++) {
            vm.prank(outsiders[i]);
            vm.expectRevert(abi.encodeWithSelector(TokenMediator.NotFlowLimiter.selector, outsiders[i]));
            mediatorA.detachFlowLimiter();
            vm.prank(outsiders[i]);
            vm.expectRevert(abi.encodeWithSelector(TokenMediator.NotFlowLimiter.selector, outsiders[i]));
            mediatorB.detachFlowLimiter();
        }
        assertEq(address(mediatorA.flowLimiter()), address(limiter), "outsiders changed nothing");
    }

    /// Claim: a limiter cannot re-enter the mediator when the mediator asks it about a relay or a claim. Shows: from
    /// `checkDeposit` and from the check inside `claim`, a call to `relayTokens`, `claim` or `collectFees` fails with
    /// the guard error, and the outer call completes. Matters: replaces `test_flowLimiter_cannotReenter`. The
    /// mediator calls the limiter under its reentrancy guard, so the limiter cannot act on a half-finished call.
    function test_aLimiterCannotReenterDuringARelayOrAClaim() public {
        MedHostileLimiter limiter = new MedHostileLimiter();
        _redeploy(_flatFeeTerms(100e14, address(limiter)), _flatFeeTerms(0, address(0)));
        MedHostileLimiter.Move[3] memory attempts = [
            MedHostileLimiter.Move.ReenterRelay,
            MedHostileLimiter.Move.ReenterClaim,
            MedHostileLimiter.Move.ReenterCollect
        ];
        bytes memory guardError = abi.encodeWithSelector(ReentrancyGuard.ReentrancyGuardReentrantCall.selector);
        for (uint256 i = 0; i < attempts.length; i++) {
            limiter.setMove(attempts[i]);
            vm.prank(alice);
            mediatorA.relayTokens(address(tokenA), bob, 100 ether);
            assertEq(limiter.moveError(), guardError, "relay: the guard refused the reentry");
        }
        assertEq(ambA.sentCount(), 3, "all three outer relays completed");

        // A claim waits for dave. The claim asks the limiter again, and the limiter tries each move.
        limiter.setMove(MedHostileLimiter.Move.None);
        _bridgeAtoB(alice, address(tokenA), bob, 100 ether);
        limiter.setRefusals(false, true);
        (bool ok,) = _deliverBtoA(_sendBack(_copyOf(address(tokenA)), bob, dave, 10 ether));
        assertTrue(ok);
        assertEq(mediatorA.claimable(address(tokenA), dave), 9.9 ether, "10 ether less the 1% incoming fee");
        limiter.setRefusals(false, false);
        for (uint256 i = 0; i < attempts.length; i++) {
            limiter.setMove(attempts[i]);
            if (i == 0) {
                mediatorA.claim(address(tokenA), dave);
                assertEq(limiter.moveError(), guardError, "claim: the guard refused the reentry");
                assertEq(tokenA.balanceOf(dave), 9.9 ether, "the outer claim completed");
            }
            if (i > 0) {
                // The claim is spent. Make a new one, so that each move runs inside a claim.
                limiter.setMove(MedHostileLimiter.Move.None);
                limiter.setRefusals(false, true);
                (ok,) = _deliverBtoA(_sendBack(_copyOf(address(tokenA)), bob, dave, 10 ether));
                assertTrue(ok);
                limiter.setRefusals(false, false);
                limiter.setMove(attempts[i]);
                mediatorA.claim(address(tokenA), dave);
                assertEq(limiter.moveError(), guardError, "claim: the guard refused the reentry");
            }
        }
    }

    /// Claim: from the check of a release, a limiter cannot call a handler or spend the mediator's tokens. Shows: a
    /// call to a handler fails with `NotBridge`; a relay with no allowance fails with the token's allowance error;
    /// the release completes and the limiter holds nothing. Matters: replaces the release half of
    /// `test_flowLimiter_cannotReenter`. A handler runs without the guard, because the bridge calls it, so the
    /// protection here is that the limiter has no standing.
    function test_aLimiterHasNoStandingDuringARelease() public {
        MedHostileLimiter limiter = new MedHostileLimiter();
        _redeploy(_flatFeeTerms(0, address(limiter)), _flatFeeTerms(0, address(0)));
        _bridgeAtoB(alice, address(tokenA), bob, 100 ether);
        address copy = _copyOf(address(tokenA));

        limiter.setMove(MedHostileLimiter.Move.CallHandler);
        _bridgeBtoA(bob, copy, carol, 10 ether);
        assertEq(limiter.moveError(), abi.encodeWithSelector(TokenMediator.NotBridge.selector, address(limiter)));
        assertEq(tokenA.balanceOf(carol), 10 ether, "the release completed");

        limiter.setMove(MedHostileLimiter.Move.ReenterRelay);
        _bridgeBtoA(bob, copy, carol, 10 ether);
        assertEq(
            limiter.moveError(),
            abi.encodeWithSelector(IERC20Errors.ERC20InsufficientAllowance.selector, address(mediatorA), 0, 10 ether),
            "the limiter has no allowance to relay with"
        );
        assertEq(tokenA.balanceOf(carol), 20 ether);
        assertEq(tokenA.balanceOf(address(limiter)), 0);
        assertEq(mediatorA.mediatorBalance(address(tokenA)), 80 ether);
        assertEq(ambA.sentCount(), 1, "the limiter relayed nothing");
    }

    /// Claim: a limiter cannot move the mediator's tokens, on a relay or on a release, native or copy. Shows: a
    /// `transferFrom` from the mediator fails with an allowance of zero, in `checkDeposit` and in `checkWithdrawal`,
    /// for a native token and for a bridged copy, and the limiter ends with no tokens. Matters: replaces
    /// `test_flowLimiter_cannotMoveVaultFunds`. The mediator approves nobody, so a limiter holds no power over funds.
    function test_aLimiterCannotMoveTheMediatorFunds() public {
        MedHostileLimiter limiterA = new MedHostileLimiter();
        MedHostileLimiter limiterB = new MedHostileLimiter();
        _redeploy(_flatFeeTerms(100e14, address(limiterA)), _flatFeeTerms(0, address(limiterB)));
        limiterA.setMove(MedHostileLimiter.Move.PullTokens);
        limiterB.setMove(MedHostileLimiter.Move.PullTokens);

        vm.prank(alice);
        mediatorA.relayTokens(address(tokenA), bob, 1_000 ether);
        assertEq(
            limiterA.moveError(),
            abi.encodeWithSelector(IERC20Errors.ERC20InsufficientAllowance.selector, address(limiterA), 0, 990 ether),
            "relay of a native token"
        );
        assertEq(tokenA.balanceOf(address(limiterA)), 0);
        assertEq(tokenA.balanceOf(address(mediatorA)), 1_000 ether, "the mediator holds the lock and the fee");

        (bool ok,) = _deliverAtoB(0);
        assertTrue(ok);
        address copy = _copyOf(address(tokenA));
        assertEq(
            limiterB.moveError(),
            abi.encodeWithSelector(IERC20Errors.ERC20InsufficientAllowance.selector, address(limiterB), 0, 990 ether),
            "release of a copy"
        );
        assertEq(IERC20(copy).balanceOf(address(limiterB)), 0);

        vm.startPrank(bob);
        IERC20(copy).approve(address(mediatorB), type(uint256).max);
        mediatorB.relayTokens(copy, bob, 100 ether);
        vm.stopPrank();
        assertEq(
            limiterB.moveError(),
            abi.encodeWithSelector(IERC20Errors.ERC20InsufficientAllowance.selector, address(limiterB), 0, 100 ether),
            "relay of a copy"
        );
        assertEq(IERC20(copy).balanceOf(address(limiterB)), 0);

        uint256 lockedBefore = tokenA.balanceOf(address(mediatorA));
        (ok,) = _deliverBtoA(0);
        assertTrue(ok);
        assertEq(
            limiterA.moveError(),
            abi.encodeWithSelector(IERC20Errors.ERC20InsufficientAllowance.selector, address(limiterA), 0, 99 ether),
            "release of a native token, net of the 1% incoming fee"
        );
        assertEq(tokenA.balanceOf(address(limiterA)), 0);
        assertEq(
            tokenA.balanceOf(address(mediatorA)), lockedBefore - 99 ether, "only the net release left the mediator"
        );
    }

    /// Claim: a limiter that allows adds a bounded cost to a relay, and a fee adds a bounded cost too. Shows: the gas
    /// of the first relay of a token on a fresh mediator with no fee and no limiter, with a fee, and with a fee and an
    /// allowing limiter, printed for the report. The figures are the total gas, with no correction for the mock bridge.
    /// Matters: replaces `test_gas_deposit_withAllowingLimiter`, `test_gas_deposit_feeZero` and
    /// `test_gas_deposit_feeSet`. The cost of the limiter hook is its own call and its own storage.
    function test_gasOfARelayWithAFeeAndWithAnAllowingLimiter() public {
        uint256 plain = _firstRelayGas(_flatFeeTerms(0, address(0)));
        uint256 withFee = _firstRelayGas(_flatFeeTerms(25e14, address(0)));
        MedHostileLimiter limiter = new MedHostileLimiter();
        uint256 withLimiter = _firstRelayGas(_flatFeeTerms(25e14, address(limiter)));
        console2.log("relay gas, no fee, no limiter:       ", plain);
        console2.log("relay gas, fee set:                  ", withFee);
        console2.log("relay gas, fee set, allowing limiter:", withLimiter);
        assertGt(withLimiter, withFee, "the limiter call costs something");
        assertLt(withLimiter - withFee, 60_000, "the limiter hook stays cheap");
        assertLt(withFee - plain, 60_000, "the fee stays cheap");
    }

    function _firstRelayGas(TokenMediator.MediatorTerms memory terms) internal returns (uint256) {
        _redeploy(terms, _flatFeeTerms(0, address(0)));
        vm.prank(alice);
        uint256 gasBefore = gasleft();
        mediatorA.relayTokens(address(tokenA), bob, 100 ether);
        return gasBefore - gasleft();
    }

    // ------------------------------------------------------------------------------------------------ no owner

    /// Claim: the mediator has no owner, no verifier and no refund path. Shows: the getters of the old vault, and the
    /// functions with a refund-like name, do not exist. Matters: replaces `test_H04_vaultHasNoVerifierOrKey` and
    /// `test_H09_vaultHasNoRefundFunction`. A refund without proof of a cancellation allows a double claim, and an
    /// owner could redirect funds.
    function test_theMediatorHasNoOwnerNoVerifierAndNoRefund() public {
        string[8] memory signatures = [
            "owner()",
            "verifier()",
            "withdrawalVKey()",
            "programVKey()",
            "refund(bytes32)",
            "refund(address,uint256)",
            "cancel(bytes32)",
            "fixFailedMessage(bytes32)"
        ];
        for (uint256 i = 0; i < signatures.length; i++) {
            (bool ok,) = address(mediatorA).call(abi.encodeWithSignature(signatures[i], bytes32(0)));
            assertFalse(ok, signatures[i]);
        }
    }
}

interface BridgedDecimals {
    function decimals() external view returns (uint8);
}
