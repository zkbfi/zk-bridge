// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {TokenMediator} from "../../../src/hardened/mediator/TokenMediator.sol";
import {MediatorFixture, DenyListToken, ScriptedMediatorLimiter} from "./utils/MediatorSupport.sol";

/// @notice Tests of the fixed fee schedule and of the incoming fee. The mediator has no fee authority. The schedule is
/// set at deployment and falls with time. The deployment collects all fees on PulseChain, in both directions: chain B
/// in these tests stands for PulseChain, with the schedule 0.10% falling by 0.01% a year down to 0.05%. Chain A stands
/// for Ethereum, with the fee off.
contract TokenMediatorFeeScheduleTest is MediatorFixture {
    event FeeCharged(address indexed token, uint256 fee, TokenMediator.FeeDirection direction);
    event FallbackUsed(
        address indexed token, address indexed recipient, address indexed fallbackRecipient, bytes32 messageId
    );
    event FeesCollected(address indexed token, address indexed feeRecipient, uint256 amount);

    uint256 internal constant START = 1e15; // 0.10%
    uint256 internal constant STEP = 1e14; // 0.01%
    uint256 internal constant FLOOR = 5e14; // 0.05%
    uint256 internal constant YEAR = 365 days;

    address internal treasury = makeAddr("treasury");
    uint256 internal deployedAt;

    function _schedule(uint256 start, uint256 step, uint256 floorRate, uint256 period, address limiter)
        internal
        view
        returns (TokenMediator.MediatorTerms memory terms)
    {
        terms = _noTerms();
        terms.feeRecipient = start == 0 ? address(0) : treasury;
        terms.feeStartRate = start;
        terms.feeStepRate = step;
        terms.feeFloorRate = floorRate;
        terms.feeStepPeriod = period;
        terms.flowLimiter = limiter;
    }

    function _redeploy(TokenMediator.MediatorTerms memory termsA, TokenMediator.MediatorTerms memory termsB) internal {
        _deployMediators(termsA, termsB);
        deployedAt = block.timestamp;
        vm.prank(alice);
        tokenA.approve(address(mediatorA), type(uint256).max);
    }

    /// @dev The deployment: no fee on chain A, the declining schedule on chain B.
    function _pulsechainFee() internal {
        _redeploy(_noTerms(), _schedule(START, STEP, FLOOR, YEAR, address(0)));
    }

    /// @dev Sends the copy back from `from` on chain B and delivers it on chain A.
    function _bridgeCopyBack(address from, address copy, address receiver, uint256 value) internal {
        vm.startPrank(from);
        IERC20(copy).approve(address(mediatorB), type(uint256).max);
        mediatorB.relayTokens(copy, receiver, value);
        vm.stopPrank();
        (bool ok,) = _deliverBtoA(_lastIndexB());
        assertTrue(ok);
    }

    // ------------------------------------------------------------------------------------------------ schedule

    /// Claim: the rate follows the schedule exactly. Shows: the rate at deployment, one second before and at each
    /// year boundary, at the floor, and long after. Matters: users read the table of the documentation, and the
    /// contract must agree with it at the edges.
    function test_theRateFollowsTheScheduleAtEveryBoundary() public {
        _pulsechainFee();
        assertEq(mediatorB.feeStartTime(), deployedAt);
        assertEq(mediatorB.currentFeeRate(), 10e14, "at deployment: 0.10%");
        assertEq(mediatorB.feeRateAt(deployedAt - 1), 10e14, "before the start: the start rate");
        assertEq(mediatorB.feeRateAt(deployedAt + YEAR - 1), 10e14, "one second before year two");
        assertEq(mediatorB.feeRateAt(deployedAt + YEAR), 9e14, "year two: 0.09%");
        assertEq(mediatorB.feeRateAt(deployedAt + 2 * YEAR - 1), 9e14);
        assertEq(mediatorB.feeRateAt(deployedAt + 2 * YEAR), 8e14, "year three: 0.08%");
        assertEq(mediatorB.feeRateAt(deployedAt + 4 * YEAR), 6e14, "year five: 0.06%");
        assertEq(mediatorB.feeRateAt(deployedAt + 5 * YEAR - 1), 6e14, "one second before the floor");
        assertEq(mediatorB.feeRateAt(deployedAt + 5 * YEAR), 5e14, "year six: the floor, 0.05%");
        assertEq(mediatorB.feeRateAt(deployedAt + 6 * YEAR), 5e14, "the floor holds");
        assertEq(mediatorB.feeRateAt(deployedAt + 1_000 * YEAR), 5e14, "long after");
        assertEq(mediatorB.feeRateAt(type(uint256).max), 5e14, "no overflow at the largest time");

        vm.warp(deployedAt + 3 * YEAR + 5);
        assertEq(mediatorB.currentFeeRate(), 7e14, "the current rate reads the block time");
    }

    /// Claim: the rate never rises. Shows: stepping through 20 years in steps of a month, no rate is above the one
    /// before it.
    function test_theRateNeverRises() public {
        _pulsechainFee();
        uint256 previous = mediatorB.feeRateAt(deployedAt);
        for (uint256 month = 1; month <= 240; month++) {
            uint256 rate = mediatorB.feeRateAt(deployedAt + month * 30 days);
            assertLe(rate, previous);
            assertGe(rate, FLOOR);
            previous = rate;
        }
    }

    /// Claim: a step that does not divide the span to the floor still stops at the floor and never goes below it.
    function test_aStepThatSkipsOverTheFloorStopsAtTheFloor() public {
        _redeploy(_noTerms(), _schedule(10e14, 4e14, 3e14, 1 days, address(0)));
        assertEq(mediatorB.feeRateAt(deployedAt + 1 days), 6e14);
        assertEq(mediatorB.feeRateAt(deployedAt + 2 days), 3e14, "10 - 8 = 2 is below the floor, so the floor");
        assertEq(mediatorB.feeRateAt(deployedAt + 3 days), 3e14);
    }

    /// Claim: a step of zero keeps the start rate, and then the period may be zero.
    function test_aStepOfZeroKeepsTheStartRate() public {
        _redeploy(_noTerms(), _schedule(10e14, 0, 10e14, 0, address(0)));
        assertEq(mediatorB.feeRateAt(deployedAt + 100 * YEAR), 10e14);
    }

    /// Claim: the constructor refuses a schedule that cannot work. Shows: a start rate above 100%, a floor above the
    /// start, a step with no period, and a fee with no recipient. A start rate of exactly 100% is accepted.
    function test_theConstructorRefusesAnImpossibleSchedule() public {
        TokenMediator.MediatorTerms memory terms = _schedule(1e18 + 1, 0, 0, 0, address(0));
        _wire(terms);
        vm.expectRevert(abi.encodeWithSelector(TokenMediator.FeeStartRateTooHigh.selector, 1e18 + 1));
        new TokenMediator(terms);

        terms = _schedule(1e18, 0, 0, 0, address(0));
        _wire(terms);
        assertEq(new TokenMediator(terms).feeStartRate(), 1e18, "100% is the only built-in bound");

        terms = _schedule(10e14, 0, 11e14, 0, address(0));
        _wire(terms);
        vm.expectRevert(abi.encodeWithSelector(TokenMediator.FeeFloorAboveStart.selector, 11e14, 10e14));
        new TokenMediator(terms);

        terms = _schedule(10e14, 1e14, 5e14, 0, address(0));
        _wire(terms);
        vm.expectRevert(TokenMediator.ZeroFeeStepPeriod.selector);
        new TokenMediator(terms);

        terms = _schedule(10e14, 0, 10e14, 0, address(0));
        terms.feeRecipient = address(0);
        _wire(terms);
        vm.expectRevert(TokenMediator.ZeroFeeRecipient.selector);
        new TokenMediator(terms);
    }

    function _wire(TokenMediator.MediatorTerms memory terms) internal view {
        terms.bridge = address(ambB);
        terms.remoteMediator = address(mediatorA);
        terms.remoteChainId = CHAIN_A;
    }

    /// Claim: a mediator with a start rate of zero charges nothing in either direction and needs no recipient.
    function test_aZeroFeeMediatorChargesNothing() public {
        vm.recordLogs();
        _bridgeAtoB(alice, address(tokenA), bob, 1_000 ether);
        address copy = _copyOf(address(tokenA));
        _bridgeCopyBack(bob, copy, carol, 1_000 ether);
        assertEq(tokenA.balanceOf(carol), 1_000 ether, "the whole amount returns");
        assertEq(mediatorA.accruedFees(address(tokenA)), 0);
        assertEq(mediatorB.accruedFees(copy), 0);
        assertEq(mediatorA.currentFeeRate(), 0);
        assertEq(mediatorA.feeRecipient(), address(0));
        vm.expectRevert(abi.encodeWithSelector(TokenMediator.NoFeesAccrued.selector, address(tokenA)));
        mediatorA.collectFees(address(tokenA));
    }

    // ------------------------------------------------------------------------------------------------ bridged mint

    /// Claim: a delivery that mints a copy takes the incoming fee from the minted value, once, and keeps it as a
    /// collectable fee of the copy. The immutable recipient is paid by `collectFees`, called by anyone.
    function test_incomingFeeOnABridgedMintIsExactAndCollectable() public {
        _pulsechainFee();
        vm.prank(alice);
        mediatorA.relayTokens(address(tokenA), bob, 1_000 ether);
        address copy = mediatorB.tokenFactory().predictAddress(CHAIN_A, address(tokenA));

        vm.expectEmit(true, false, false, true, address(mediatorB));
        emit FeeCharged(copy, 1 ether, TokenMediator.FeeDirection.Incoming);
        (bool ok,) = _deliverAtoB(0);
        assertTrue(ok);

        assertEq(IERC20(copy).balanceOf(bob), 999 ether, "the recipient receives the value minus the fee");
        assertEq(mediatorB.accruedFees(copy), 1 ether, "the fee is accrued");
        assertEq(IERC20(copy).balanceOf(address(mediatorB)), 1 ether, "the mediator holds the fee as copies");
        assertEq(IERC20(copy).totalSupply(), 1_000 ether, "the supply is the locked amount");
        assertEq(mediatorA.mediatorBalance(address(tokenA)), 1_000 ether);

        vm.expectEmit(true, true, false, true, address(mediatorB));
        emit FeesCollected(copy, treasury, 1 ether);
        vm.prank(dave);
        mediatorB.collectFees(copy);
        assertEq(IERC20(copy).balanceOf(treasury), 1 ether, "the immutable recipient is paid");
        assertEq(mediatorB.accruedFees(copy), 0);
        assertEq(IERC20(copy).totalSupply(), mediatorA.mediatorBalance(address(tokenA)), "supply still equals record");
    }

    // ------------------------------------------------------------------------------------------------ native release

    /// Claim: a delivery that releases a native token takes the incoming fee from the released value. The fee leaves
    /// the record and stays in the mediator as an accrued fee.
    function test_incomingFeeOnANativeReleaseLeavesTheRecordAndStaysAsAFee() public {
        _redeploy(_schedule(START, STEP, FLOOR, YEAR, address(0)), _noTerms());
        _bridgeAtoB(alice, address(tokenA), bob, 1_000 ether);
        address copy = _copyOf(address(tokenA));
        assertEq(mediatorA.accruedFees(address(tokenA)), 1 ether, "the outgoing fee on chain A is 0.1% of the relay");
        assertEq(mediatorA.mediatorBalance(address(tokenA)), 999 ether);
        mediatorA.collectFees(address(tokenA));

        _bridgeCopyBack(bob, copy, carol, 999 ether);

        assertEq(tokenA.balanceOf(carol), 998.001 ether, "the recipient receives the value minus the fee");
        assertEq(mediatorA.accruedFees(address(tokenA)), 0.999 ether);
        assertEq(mediatorA.mediatorBalance(address(tokenA)), 0, "the whole value left the record");
        assertEq(tokenA.balanceOf(address(mediatorA)), 0.999 ether, "the fee is the only token left in the mediator");
        assertEq(IERC20(copy).totalSupply(), 0, "every copy is burned");

        mediatorA.collectFees(address(tokenA));
        assertEq(tokenA.balanceOf(treasury), 1.999 ether, "both fees reached the recipient");
        assertEq(tokenA.balanceOf(address(mediatorA)), 0);
    }

    // ------------------------------------------------------------------------------------------------ round trip

    /// Claim: PulseChain charges both directions and Ethereum charges none, each at the current rate. Shows: a round
    /// trip with exact amounts at the start, and the same trip two years later at 0.08%.
    function test_aRoundTripPaysTheFeeOnPulsechainInBothDirectionsAndNothingOnEthereum() public {
        _pulsechainFee();
        _bridgeAtoB(alice, address(tokenA), bob, 1_000 ether);
        address copy = _copyOf(address(tokenA));
        assertEq(IERC20(copy).balanceOf(bob), 999 ether, "incoming fee on chain B: 1 ether");
        assertEq(mediatorB.accruedFees(copy), 1 ether);

        _bridgeCopyBack(bob, copy, carol, 999 ether);
        // The outgoing fee on chain B is 0.1% of 999 ether = 0.999 ether. The burn is 998.001 ether.
        assertEq(mediatorB.accruedFees(copy), 1.999 ether, "both fees accrue on chain B");
        assertEq(tokenA.balanceOf(carol), 998.001 ether, "chain A charges nothing");
        assertEq(mediatorA.accruedFees(address(tokenA)), 0);
        assertEq(mediatorA.mediatorBalance(address(tokenA)), 1.999 ether, "the record backs the fee copies");
        assertEq(IERC20(copy).totalSupply(), 1.999 ether);
        assertGe(tokenA.balanceOf(address(mediatorA)), mediatorA.mediatorBalance(address(tokenA)));

        // Two years later the rate is 0.08% for both charges.
        vm.warp(deployedAt + 2 * YEAR);
        mediatorB.collectFees(copy);
        _bridgeAtoB(alice, address(tokenA), bob, 1_000 ether);
        assertEq(IERC20(copy).balanceOf(bob), 999.2 ether, "incoming at 0.08%");
        _bridgeCopyBack(bob, copy, dave, 999.2 ether);
        // Outgoing: 999.2 * 0.08% = 0.79936. The first fee of 0.8 ether and this one are accrued.
        assertEq(mediatorB.accruedFees(copy), 0.8 ether + 0.79936 ether);
    }

    /// Claim: a rate that falls between the send and the delivery is the rate at the delivery. The sender needs no
    /// maximum, because the rate only falls.
    function test_aMessageSentEarlyIsChargedTheLowerRateAtTheDelivery() public {
        _pulsechainFee();
        vm.prank(alice);
        mediatorA.relayTokens(address(tokenA), bob, 1_000 ether);
        vm.warp(deployedAt + YEAR);
        _deliverAtoB(0);
        address copy = _copyOf(address(tokenA));
        assertEq(IERC20(copy).balanceOf(bob), 999.1 ether, "0.09% at the delivery, not 0.10% at the send");
    }

    // ------------------------------------------------------------------------------------------------ fallback paths

    /// Claim: a release that goes to the fallback address pays the fee once.
    function test_aFallbackReleaseChargesTheFeeOnce() public {
        DenyListToken token = new DenyListToken();
        _redeploy(_schedule(START, STEP, FLOOR, YEAR, address(0)), _noTerms());
        token.mint(alice, 1_000 ether);
        vm.startPrank(alice);
        token.approve(address(mediatorA), type(uint256).max);
        mediatorA.relayTokens(address(token), bob, 1_000 ether);
        vm.stopPrank();
        _deliverAtoB(0);
        address copy = mediatorB.bridgedTokenAddress(address(token));
        mediatorA.collectFees(address(token));
        uint256 recordBefore = mediatorA.mediatorBalance(address(token));
        assertEq(recordBefore, 999 ether);

        token.setDenied(carol, true);
        vm.startPrank(bob);
        IERC20(copy).approve(address(mediatorB), type(uint256).max);
        mediatorB.relayTokensWithFallback(copy, carol, 999 ether, "", dave);
        vm.stopPrank();

        vm.expectEmit(true, true, true, false, address(mediatorA));
        emit FallbackUsed(address(token), carol, dave, bytes32(0));
        (bool ok,) = _deliverBtoA(_lastIndexB());
        assertTrue(ok);
        assertEq(token.balanceOf(dave), 998.001 ether, "the fallback receives the value minus one fee");
        assertEq(token.balanceOf(carol), 0);
        assertEq(mediatorA.accruedFees(address(token)), 0.999 ether, "one fee, not two");
        assertEq(mediatorA.mediatorBalance(address(token)), 0);
    }

    /// Claim: a release that is held for a claim pays the fee once, at the delivery, and the claim takes no second fee.
    function test_aClaimableReleaseChargesTheFeeOnceAndTheClaimTakesNone() public {
        DenyListToken token = new DenyListToken();
        _redeploy(_schedule(START, STEP, FLOOR, YEAR, address(0)), _noTerms());
        token.mint(alice, 1_000 ether);
        vm.startPrank(alice);
        token.approve(address(mediatorA), type(uint256).max);
        mediatorA.relayTokens(address(token), bob, 1_000 ether);
        vm.stopPrank();
        _deliverAtoB(0);
        address copy = mediatorB.bridgedTokenAddress(address(token));
        mediatorA.collectFees(address(token));

        token.setDenied(carol, true);
        token.setDenied(dave, true);
        vm.startPrank(bob);
        IERC20(copy).approve(address(mediatorB), type(uint256).max);
        mediatorB.relayTokensWithFallback(copy, carol, 999 ether, "", dave);
        vm.stopPrank();
        (bool ok,) = _deliverBtoA(_lastIndexB());
        assertTrue(ok);

        assertEq(mediatorA.claimable(address(token), dave), 998.001 ether, "the claim holds the value minus the fee");
        assertEq(mediatorA.accruedFees(address(token)), 0.999 ether, "the fee is taken at the delivery");
        assertEq(mediatorA.mediatorBalance(address(token)), 998.001 ether, "the claim stays in the record");

        token.setDenied(dave, false);
        mediatorA.claim(address(token), dave);
        assertEq(token.balanceOf(dave), 998.001 ether);
        assertEq(mediatorA.accruedFees(address(token)), 0.999 ether, "the claim charged no second fee");
        assertEq(mediatorA.mediatorBalance(address(token)), 0);
    }

    /// Claim: a mint that falls back to the fallback address pays the fee once.
    function test_aBridgedMintThatFallsBackChargesTheFeeOnce() public {
        _pulsechainFee();
        _bridgeAtoB(alice, address(tokenA), bob, 100 ether);
        address copy = _copyOf(address(tokenA));
        bytes memory call = abi.encodeWithSelector(
            TokenMediator.handleBridgedTokensWithFallback.selector, address(tokenA), address(0), 1_000 ether, carol
        );
        uint256 supplyBefore = IERC20(copy).totalSupply();
        (bool ok,) =
            ambB.execute(address(mediatorB), call, address(mediatorA), bytes32(CHAIN_A), bytes32(uint256(9)), 1_000_000);
        assertTrue(ok);
        assertEq(IERC20(copy).balanceOf(carol), 999 ether, "the fallback receives the value minus one fee");
        assertEq(mediatorB.accruedFees(copy), 0.1 ether + 1 ether, "one fee for each delivery");
        assertEq(IERC20(copy).totalSupply() - supplyBefore, 1_000 ether);
    }

    // ------------------------------------------------------------------------------------------------ limits

    /// Claim: the flow limiter sees the net amount of both sides.
    function test_theFlowLimiterSeesTheNetAmountOfADelivery() public {
        ScriptedMediatorLimiter limiter = new ScriptedMediatorLimiter();
        _redeploy(_noTerms(), _schedule(START, STEP, FLOOR, YEAR, address(limiter)));
        _bridgeAtoB(alice, address(tokenA), bob, 1_000 ether);
        address copy = _copyOf(address(tokenA));
        assertEq(limiter.lastWithdrawalAmount(), 999 ether, "the delivery passes the net amount");

        _bridgeCopyBack(bob, copy, carol, 999 ether);
        assertEq(limiter.lastDepositAmount(), 998.001 ether, "the relay passes the net amount");
    }

    /// Claim: the fee is rounded down and never exceeds the value, even at a rate of 100%.
    function test_theIncomingFeeRoundsDownAndNeverExceedsTheValue() public {
        _pulsechainFee();
        _bridgeAtoB(alice, address(tokenA), bob, 999);
        address copy = _copyOf(address(tokenA));
        assertEq(IERC20(copy).balanceOf(bob), 999, "999 * 0.1% rounds down to zero");
        assertEq(mediatorB.accruedFees(copy), 0);

        _redeploy(_noTerms(), _schedule(1e18, 0, 1e18, 0, address(0)));
        _bridgeAtoB(alice, address(tokenA), bob, 1_000);
        copy = _copyOf(address(tokenA));
        assertEq(IERC20(copy).balanceOf(bob), 0, "a rate of 100% takes the whole value");
        assertEq(mediatorB.accruedFees(copy), 1_000, "and no more");
    }

    // ------------------------------------------------------------------------------------------------ no admin

    /// Claim: the schedule and the recipient cannot change. Shows: the fee views are the same after years and after
    /// a call by every account that could plausibly hold a power, and the mediator has no setter selector.
    function test_theScheduleAndTheRecipientAreImmutable() public {
        _pulsechainFee();
        address[4] memory callers = [treasury, address(this), address(mediatorA), alice];
        bytes4[4] memory selectors = [
            bytes4(keccak256("setFee(uint256,address)")),
            bytes4(keccak256("setFee(uint256,uint256,address)")),
            bytes4(keccak256("nullifyFee()")),
            bytes4(keccak256("setFeeRecipient(address)"))
        ];
        for (uint256 i = 0; i < callers.length; i++) {
            for (uint256 j = 0; j < selectors.length; j++) {
                vm.prank(callers[i]);
                (bool ok,) = address(mediatorB).call(abi.encodeWithSelector(selectors[j], 1, 1, treasury));
                assertFalse(ok, "no fee admin function exists");
            }
        }
        assertEq(mediatorB.feeRecipient(), treasury);
        assertEq(mediatorB.feeStartRate(), START);
        assertEq(mediatorB.feeStepRate(), STEP);
        assertEq(mediatorB.feeFloorRate(), FLOOR);
        assertEq(mediatorB.feeStepPeriod(), YEAR);
    }
}
