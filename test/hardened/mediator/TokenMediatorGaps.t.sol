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
/// way in and on the way out, hostile tokens and limiters that call back into the mediator, and the independence of the limiter checks. Each test names the vault test that it replaces.
contract TokenMediatorGapsTest is MediatorFixture {
    event ReleaseFailed(address indexed token, address indexed recipient, uint256 value, bytes32 indexed messageId);

    // ------------------------------------------------------------------------------------------------ helpers

    /// @dev Terms with the given flow limiter, or none when it is zero.
    function _limiterTerms(address limiter) internal pure returns (TokenMediator.MediatorTerms memory terms) {
        terms = _noTerms();
        terms.flowLimiter = limiter;
    }

    function _redeploy(TokenMediator.MediatorTerms memory termsA, TokenMediator.MediatorTerms memory termsB) internal {
        _deployMediators(termsA, termsB);
        vm.prank(alice);
        tokenA.approve(address(mediatorA), type(uint256).max);
    }

    /// @dev Sends `value` of a copy from `from` on chain B back to `receiver`. It does
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

    /// @dev The tokens of a native token on chain A are backed: the balance covers the record, and
    /// the copies on chain B equal the record once every message is delivered.
    function _assertBacked(address token, address copy) internal view {
        uint256 record = mediatorA.mediatorBalance(token);
        assertGe(IERC20(token).balanceOf(address(mediatorA)), record, "balance");
        assertEq(IERC20(copy).totalSupply(), record, "the copies equal the record");
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

    /// Claim: a token whose `transfer` returns false can be relayed, and its release never reverts. Shows: the relay
    /// works (its `transferFrom` is fine); the release does not revert, so the message stays delivered; `ReleaseFailed`
    /// names the recipient; nobody is paid; the record falls by the release (the copies are burned) and the tokens stay
    /// in the mediator, owed to nobody. Matters: replaces `test_H13_withdraw_returnsFalseTokenRevertsAndKeepsClaim`.
    /// The vault reverted. The mediator cannot, and a failed release is final.
    function test_aTokenThatReturnsFalseOnTransferEndsWithAFinalFailedRelease() public {
        ReturnsFalseToken bad = new ReturnsFalseToken("Bad", "BAD");
        bad.mint(alice, 100 ether);
        vm.prank(alice);
        bad.approve(address(mediatorA), type(uint256).max);
        _bridgeAtoB(alice, address(bad), alice, 100 ether);
        address copy = _copyOf(address(bad));

        uint256 index = _sendBack(copy, alice, bob, 60 ether);
        bytes32 id = ambB.messageAt(index).id;
        vm.expectEmit(true, true, true, true, address(mediatorA));
        emit ReleaseFailed(address(bad), bob, 60 ether, id);
        (bool ok,) = _deliverBtoA(index);
        assertTrue(ok, "the delivery does not revert, which would lose the tokens");
        assertEq(bad.balanceOf(bob), 0);
        assertEq(bad.balanceOf(alice), 0);
        assertEq(mediatorA.mediatorBalance(address(bad)), 40 ether, "the record fell by the release");
        assertEq(bad.balanceOf(address(mediatorA)), 100 ether, "the tokens stay in the mediator");
        assertEq(IERC20(copy).totalSupply(), 40 ether, "the record equals the copies that remain");
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
    /// fails, `ReleaseFailed` names carol, and the record still counts the nested lock of 10: the record equals the
    /// supply of the copies. The 60 stay in the mediator, owed to nobody. Matters: a release lowers the record once,
    /// before the transfer. A stale write after the refusal would erase what the nested relay locked.
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

        vm.expectEmit(true, true, true, true, address(mediatorA));
        emit ReleaseFailed(address(token), carol, 60 ether, ambB.messageAt(index).id);
        assertTrue(_deliverBtoAWithGas(index, 1_500_000));
        assertEq(token.balanceOf(alice), aliceBefore, "nobody else is paid");
        assertEq(token.balanceOf(carol), 0, "carol is not paid");
        (bool delivered,) = _deliverAtoB(_lastIndexA());
        assertTrue(delivered);
        assertEq(mediatorA.mediatorBalance(address(token)), 50 ether, "the nested lock stays in the record");
        address copy = _copyOf(address(token));
        assertEq(IERC20(copy).totalSupply(), 50 ether, "the copies equal the record");
        assertEq(token.balanceOf(address(mediatorA)), 110 ether, "the failed 60 stay in the mediator");
    }

    /// Claim: a release that reaches the transfer with no more gas than `TRANSFER_GAS_RESERVE` makes no call to the
    /// token and reverts with `ReleaseOutOfGas`. Shows: at the smallest gas that delivers, carol is paid in full (never
    /// a failed release); below it every attempt reverts and leaves the record and the balances as they were, and at
    /// least one of them reverts with `ReleaseOutOfGas` for the token. Matters: before 2026-11-01 this case ended as a
    /// final `ReleaseFailed`, so an executor could turn a lack of gas into a lost release; now it only reverts its own
    /// transaction.
    function test_aReleaseThatReachesTheTransferWithOnlyTheReserveLeftReverts() public {
        _bridgeAtoB(alice, address(tokenA), bob, 100 ether);
        uint256 index = _sendBack(_copyOf(address(tokenA)), bob, carol, 60 ether);
        MockAMB.Sent memory message = ambB.messageAt(index);

        uint256 gas = _smallestGasThatDelivers(message);
        assertGt(gas, 0, "some gas delivers the message");
        bool sawOutOfGas;
        for (uint256 lower = gas - 250; lower >= 20_000 && lower < gas; lower -= 250) {
            uint256 snapshot = vm.snapshotState();
            (bool failedOk, bytes memory error) =
                ambA.execute(message.target, message.data, message.sender, bytes32(CHAIN_B), message.id, lower);
            vm.revertToState(snapshot);
            assertFalse(failedOk, "less gas reverts");
            if (keccak256(error) == keccak256(abi.encodeWithSelector(TokenMediator.ReleaseOutOfGas.selector, address(tokenA)))) {
                sawOutOfGas = true;
            }
        }
        assertTrue(sawOutOfGas, "a starved transfer reverts with ReleaseOutOfGas");
        assertEq(mediatorA.mediatorBalance(address(tokenA)), 100 ether, "the record is unchanged");

        (bool ok,) = ambA.execute(message.target, message.data, message.sender, bytes32(CHAIN_B), message.id, gas);
        assertTrue(ok, "the smallest delivering gas delivers");
        assertEq(tokenA.balanceOf(carol), 60 ether, "and pays carol in full");
        assertEq(mediatorA.mediatorBalance(address(tokenA)), 40 ether, "the record fell by the release");
    }

    /// @dev The smallest gas, in steps of 250, with which the handler does not revert.
    function _smallestGasThatDelivers(MockAMB.Sent memory message) internal returns (uint256) {
        for (uint256 gas = 20_000; gas < 400_000; gas += 250) {
            uint256 snapshot = vm.snapshotState();
            (bool ok,) = ambA.execute(message.target, message.data, message.sender, bytes32(CHAIN_B), message.id, gas);
            vm.revertToState(snapshot);
            if (ok) return gas;
        }
        return 0;
    }

    // ------------------------------------------------------------------------------------------------ flow limiter

    /// Claim: the refusals of a relay and of a release are independent. Shows: a limiter that refuses relays still
    /// lets a release through, and a limiter that refuses releases still lets a relay through. Matters: replaces
    /// `test_flowLimiter_refusalsAreIndependent`. Each hook is its own check.
    function test_theRefusalsOfARelayAndOfAReleaseAreIndependent() public {
        ScriptedMediatorLimiter limiter = new ScriptedMediatorLimiter();
        _redeploy(_limiterTerms(address(limiter)), _limiterTerms(address(0)));
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
        assertEq(tokenA.balanceOf(dave), 0, "the release is refused while releases are refused");
        assertEq(limiter.depositChecks(), 2, "the refused relay and the later relay");
        assertEq(limiter.withdrawalChecks(), 1, "the refused check reverted inside the handler and left no count");
    }

    /// Claim: a refused relay leaves no record. Shows: with a limiter that refuses, the record and the registration
    /// stay empty, and the sender keeps the tokens. Matters: replaces
    /// `test_flowLimiter_refusedDeposit_revertsAndSucceedsAfterAllow` for the record, which the existing test does not
    /// read. The lock is written before the limiter runs, so the revert must undo it.
    function test_aRefusedRelayLeavesNoRecord() public {
        ScriptedMediatorLimiter limiter = new ScriptedMediatorLimiter();
        _redeploy(_limiterTerms(address(limiter)), _limiterTerms(address(0)));
        limiter.setRefusals(true, false);
        vm.prank(alice);
        vm.expectRevert(ScriptedMediatorLimiter.FlowRefused.selector);
        mediatorA.relayTokens(address(tokenA), bob, 1_000 ether);
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
        _redeploy(_limiterTerms(address(limiter)), _limiterTerms(address(0)));
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
    /// other accounts revert with `NotFlowLimiter` on a mediator with a limiter and on one
    /// without. Matters: replaces `test_flowLimiter_detach_isOnlyForTheLimiterAndOneWay` for the callers that the
    /// existing test does not try.
    function test_noOtherAccountCanDetachTheLimiter() public {
        ScriptedMediatorLimiter limiter = new ScriptedMediatorLimiter();
        _redeploy(_limiterTerms(address(limiter)), _limiterTerms(address(0)));
        address[3] memory outsiders = [carol, address(mediatorB), alice];
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

    /// Claim: a limiter cannot re-enter the mediator when the mediator asks it about a relay. Shows: from
    /// `checkDeposit`, a call to `relayTokens` fails with the guard error, and the outer call completes. Matters:
    /// replaces `test_flowLimiter_cannotReenter`. The mediator calls the limiter under its reentrancy guard, so the
    /// limiter cannot act on a half-finished call.
    function test_aLimiterCannotReenterDuringARelay() public {
        MedHostileLimiter limiter = new MedHostileLimiter();
        _redeploy(_limiterTerms(address(limiter)), _limiterTerms(address(0)));
        limiter.setMove(MedHostileLimiter.Move.ReenterRelay);
        vm.prank(alice);
        mediatorA.relayTokens(address(tokenA), bob, 100 ether);
        assertEq(
            limiter.moveError(),
            abi.encodeWithSelector(ReentrancyGuard.ReentrancyGuardReentrantCall.selector),
            "relay: the guard refused the reentry"
        );
        assertEq(ambA.sentCount(), 1, "the outer relay completed");
    }

    /// Claim: from the check of a release, a limiter cannot call a handler or spend the mediator's tokens. Shows: a
    /// call to a handler fails with `NotBridge`; a relay with no allowance fails with the token's allowance error;
    /// the release completes and the limiter holds nothing. Matters: replaces the release half of
    /// `test_flowLimiter_cannotReenter`. A handler runs without the guard, because the bridge calls it, so the
    /// protection here is that the limiter has no standing.
    function test_aLimiterHasNoStandingDuringARelease() public {
        MedHostileLimiter limiter = new MedHostileLimiter();
        _redeploy(_limiterTerms(address(limiter)), _limiterTerms(address(0)));
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
        _redeploy(_limiterTerms(address(limiterA)), _limiterTerms(address(limiterB)));
        limiterA.setMove(MedHostileLimiter.Move.PullTokens);
        limiterB.setMove(MedHostileLimiter.Move.PullTokens);

        vm.prank(alice);
        mediatorA.relayTokens(address(tokenA), bob, 1_000 ether);
        assertEq(
            limiterA.moveError(),
            abi.encodeWithSelector(IERC20Errors.ERC20InsufficientAllowance.selector, address(limiterA), 0, 1_000 ether),
            "relay of a native token"
        );
        assertEq(tokenA.balanceOf(address(limiterA)), 0);
        assertEq(tokenA.balanceOf(address(mediatorA)), 1_000 ether, "the mediator holds the lock");

        (bool ok,) = _deliverAtoB(0);
        assertTrue(ok);
        address copy = _copyOf(address(tokenA));
        assertEq(
            limiterB.moveError(),
            abi.encodeWithSelector(IERC20Errors.ERC20InsufficientAllowance.selector, address(limiterB), 0, 1_000 ether),
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
            abi.encodeWithSelector(IERC20Errors.ERC20InsufficientAllowance.selector, address(limiterA), 0, 100 ether),
            "release of a native token"
        );
        assertEq(tokenA.balanceOf(address(limiterA)), 0);
        assertEq(tokenA.balanceOf(address(mediatorA)), lockedBefore - 100 ether, "only the release left the mediator");
    }

    /// Claim: a limiter that allows adds a bounded cost to a relay. Shows: the gas of the first relay of a token on a
    /// fresh mediator with no limiter and with an allowing limiter, printed for the report. The figures are the total
    /// gas, with no correction for the mock bridge. Matters: replaces `test_gas_deposit_withAllowingLimiter`. The cost
    /// of the limiter hook is its own call and its own storage.
    function test_gasOfARelayWithAnAllowingLimiter() public {
        uint256 plain = _firstRelayGas(_limiterTerms(address(0)));
        MedHostileLimiter limiter = new MedHostileLimiter();
        uint256 withLimiter = _firstRelayGas(_limiterTerms(address(limiter)));
        console2.log("relay gas, no limiter:       ", plain);
        console2.log("relay gas, allowing limiter: ", withLimiter);
        assertGt(withLimiter, plain, "the limiter call costs something");
        assertLt(withLimiter - plain, 60_000, "the limiter hook stays cheap");
    }

    function _firstRelayGas(TokenMediator.MediatorTerms memory terms) internal returns (uint256) {
        _redeploy(terms, _limiterTerms(address(0)));
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
