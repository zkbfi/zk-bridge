// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {FeeSchedule} from "../../../src/hardened/mediator/FeeSchedule.sol";
import {TokenMediator} from "../../../src/hardened/mediator/TokenMediator.sol";
import {MockAMB} from "../mediator/utils/MediatorSupport.sol";

/// @notice Properties of the declining fee: the pure math of `FeeSchedule` against an independent loop, and the
/// constructor and the views of `TokenMediator` against the library. Every test is a fuzz test, so the deep profile runs
/// it 50000 times.
contract FeeSchedulePropertiesTest is Test {
    uint256 internal constant DENOMINATOR = 1e18;

    // ----------------------------------------------------------------------------------------------- helpers

    /// @dev A valid schedule from raw seeds. The floor is at most the start, and a step has a period.
    function _schedule(uint256 startTime, uint256 startRate, uint256 stepRate, uint256 floorRate, uint256 stepPeriod)
        internal
        pure
        returns (FeeSchedule.Schedule memory schedule)
    {
        startRate = bound(startRate, 0, DENOMINATOR);
        floorRate = bound(floorRate, 0, startRate);
        stepRate = bound(stepRate, 0, DENOMINATOR);
        stepPeriod = bound(stepPeriod, stepRate == 0 ? 0 : 1, 3650 days);
        schedule = FeeSchedule.Schedule(startTime, startRate, stepRate, floorRate, stepPeriod);
    }

    /// @dev The rate by repeated subtraction, one step at a time. It is the definition in words: after each period the
    /// rate falls by the step, and it stops at the floor.
    function _rateByLoop(FeeSchedule.Schedule memory schedule, uint256 elapsedSteps) internal pure returns (uint256 rate) {
        rate = schedule.startRate;
        for (uint256 i = 0; i < elapsedSteps; i++) {
            if (rate <= schedule.floorRate + schedule.stepRate) return schedule.floorRate;
            rate -= schedule.stepRate;
        }
        if (rate < schedule.floorRate) rate = schedule.floorRate;
    }

    // ------------------------------------------------------------------------------------------------- tests

    /// Claim: the rate equals the loop of repeated subtraction. Shows: for any valid schedule and any whole number of
    /// steps up to 300 plus any offset inside the step, `rateAt` equals the loop. Matters: the contract, the dashboard and
    /// the tests must read one schedule. A loop cannot overflow, so it is the check on the closed form.
    function testFuzz_rateEqualsTheLoopOfSubtractions(
        uint256 startTime,
        uint256 startRate,
        uint256 stepRate,
        uint256 floorRate,
        uint256 stepPeriod,
        uint16 stepsSeed,
        uint256 offsetSeed
    ) public pure {
        startTime = bound(startTime, 0, type(uint128).max);
        FeeSchedule.Schedule memory schedule = _schedule(startTime, startRate, stepRate, floorRate, stepPeriod);
        if (schedule.stepRate == 0) return;
        uint256 steps = stepsSeed % 301;
        uint256 offset = bound(offsetSeed, 0, schedule.stepPeriod - 1);
        uint256 timestamp = startTime + steps * schedule.stepPeriod + offset;
        // At the start time itself no step has passed, whatever the offset.
        uint256 expectedSteps = timestamp <= startTime ? 0 : steps;
        assertEq(FeeSchedule.rateAt(schedule, timestamp), _rateByLoop(schedule, expectedSteps), "rate != loop");
    }

    /// Claim: the rate never rises over time and never leaves its band. Shows: for any valid schedule and any two times,
    /// including the largest word, the later rate is at most the earlier rate, both lie between the floor and the start
    /// rate, and the call does not revert. Matters: a sender reads the rate and relies on it not rising; a revert on a
    /// far timestamp would block every relay.
    function testFuzz_rateIsMonotoneAndBounded(
        uint256 startTime,
        uint256 startRate,
        uint256 stepRate,
        uint256 floorRate,
        uint256 stepPeriod,
        uint256 earlier,
        uint256 later
    ) public pure {
        FeeSchedule.Schedule memory schedule = _schedule(startTime, startRate, stepRate, floorRate, stepPeriod);
        if (earlier > later) (earlier, later) = (later, earlier);
        uint256 rateEarlier = FeeSchedule.rateAt(schedule, earlier);
        uint256 rateLater = FeeSchedule.rateAt(schedule, later);
        assertLe(rateLater, rateEarlier, "the rate rose");
        assertLe(rateEarlier, schedule.startRate, "above the start");
        assertGe(rateLater, schedule.floorRate, "under the floor");
    }

    /// Claim: the rate is the start rate until the first period ends, and for ever when the step is zero. Shows: at
    /// any time up to the end of the first period, and at any time when the step is zero, the rate is the start rate.
    /// Matters: a sender who relays on day one pays the published rate.
    function testFuzz_rateIsTheStartRateBeforeTheFirstStep(
        uint256 startTime,
        uint256 startRate,
        uint256 stepRate,
        uint256 floorRate,
        uint256 stepPeriod,
        uint256 offsetSeed
    ) public pure {
        startTime = bound(startTime, 0, type(uint128).max);
        FeeSchedule.Schedule memory schedule = _schedule(startTime, startRate, stepRate, floorRate, stepPeriod);
        uint256 span = schedule.stepRate == 0 ? type(uint128).max : schedule.stepPeriod - 1;
        uint256 timestamp = startTime + bound(offsetSeed, 0, span);
        assertEq(FeeSchedule.rateAt(schedule, timestamp), schedule.startRate, "the rate fell early");
        if (startTime > 0) assertEq(FeeSchedule.rateAt(schedule, startTime - 1), schedule.startRate, "before the start");
    }

    /// Claim: the fee is the amount times the rate, rounded down, and never above the amount. Shows: for any amount up to
    /// the largest word and any rate up to 100 percent, `feeOn` equals the exact floor of `amount * rate / 1e18` (computed
    /// without a product that overflows), does not exceed the amount, and grows with the rate and with the amount.
    /// Matters: the mediator takes the fee from the delivered value, so a fee above the value would underflow.
    function testFuzz_feeIsTheRoundedDownShareAndNeverAboveTheAmount(uint256 amount, uint256 rate, uint256 smallerRate)
        public
        pure
    {
        rate = bound(rate, 0, DENOMINATOR);
        smallerRate = bound(smallerRate, 0, rate);
        uint256 fee = FeeSchedule.feeOn(amount, rate);
        uint256 exact = (amount / DENOMINATOR) * rate + ((amount % DENOMINATOR) * rate) / DENOMINATOR;
        assertEq(fee, exact, "fee != exact floor");
        assertLe(fee, amount, "fee above the amount");
        assertLe(FeeSchedule.feeOn(amount, smallerRate), fee, "fee fell as the rate rose");
        if (amount > 0) assertLe(FeeSchedule.feeOn(amount - 1, rate), fee, "fee fell as the amount rose");
        assertEq(FeeSchedule.feeOn(amount, 0), 0, "a zero rate takes a fee");
        assertEq(FeeSchedule.feeOn(amount, DENOMINATOR), amount, "a full rate takes less than the amount");
    }

    /// Claim: the mediator accepts exactly the valid schedules, and its views are the library. Shows: for any terms, the
    /// constructor either reverts with the error of the broken rule (a start above 100 percent, a floor above the start, a
    /// step with no period, a fee with no recipient) or deploys; a deployed mediator reports `feeRateAt(t)` equal to the
    /// library on the schedule that its immutables form, and `currentFeeRate` equals `feeRateAt(now)`, for any time.
    /// Matters: the contract has no owner, so a bad schedule is final; and the views must follow the library.
    function testFuzz_theMediatorAcceptsExactlyTheValidSchedulesAndReadsTheLibrary(
        uint256 startRate,
        uint256 stepRate,
        uint256 floorRate,
        uint256 stepPeriod,
        bool hasRecipient,
        uint256 deployTime,
        uint256 queryOffset
    ) public {
        deployTime = bound(deployTime, 1, type(uint64).max);
        vm.warp(deployTime);
        TokenMediator.MediatorTerms memory terms = _terms(startRate, stepRate, floorRate, stepPeriod, hasRecipient);
        bytes memory expected = _expectedRefusal(terms);
        if (expected.length != 0) {
            vm.expectRevert(expected);
            new TokenMediator(terms);
            return;
        }
        TokenMediator mediator = new TokenMediator(terms);
        assertEq(mediator.feeStartTime(), deployTime, "the schedule starts at deployment");
        FeeSchedule.Schedule memory schedule =
            FeeSchedule.Schedule(deployTime, terms.feeStartRate, terms.feeStepRate, terms.feeFloorRate, terms.feeStepPeriod);
        uint256 timestamp = deployTime + bound(queryOffset, 0, type(uint128).max);
        assertEq(mediator.feeRateAt(timestamp), FeeSchedule.rateAt(schedule, timestamp), "the view differs from the library");
        vm.warp(timestamp);
        assertEq(mediator.currentFeeRate(), mediator.feeRateAt(block.timestamp), "currentFeeRate != feeRateAt(now)");
        assertGe(mediator.currentFeeRate(), terms.feeFloorRate, "under the floor");
        assertLe(mediator.currentFeeRate(), terms.feeStartRate, "above the start");
    }

    // ------------------------------------------------------------------------------------------------ helpers

    function _terms(uint256 startRate, uint256 stepRate, uint256 floorRate, uint256 stepPeriod, bool hasRecipient)
        internal
        returns (TokenMediator.MediatorTerms memory terms)
    {
        terms.bridge = address(new MockAMB(1, 369));
        terms.remoteMediator = address(0xBEEF);
        terms.remoteChainId = 369;
        terms.remoteChainName = "Chain B";
        terms.feeRecipient = hasRecipient ? address(0xFEE) : address(0);
        // Let some fuzz values pass 100 percent and some floors pass the start, so the refusals are reached.
        terms.feeStartRate = startRate % 3 == 0 ? startRate : bound(startRate, 0, DENOMINATOR);
        terms.feeFloorRate = floorRate % 3 == 0 ? floorRate : bound(floorRate, 0, terms.feeStartRate);
        terms.feeStepRate = bound(stepRate, 0, DENOMINATOR);
        terms.feeStepPeriod = stepPeriod % 3 == 0 ? 0 : bound(stepPeriod, 1, 3650 days);
    }

    /// @dev The revert data that the constructor must give for these terms, in the order of its checks, or empty bytes
    /// when the terms are valid. It restates the four rules of the documentation, not the code.
    function _expectedRefusal(TokenMediator.MediatorTerms memory terms) internal pure returns (bytes memory) {
        if (terms.feeStartRate > DENOMINATOR) {
            return abi.encodeWithSelector(TokenMediator.FeeStartRateTooHigh.selector, terms.feeStartRate);
        }
        if (terms.feeFloorRate > terms.feeStartRate) {
            return abi.encodeWithSelector(
                TokenMediator.FeeFloorAboveStart.selector, terms.feeFloorRate, terms.feeStartRate
            );
        }
        if (terms.feeStepRate != 0 && terms.feeStepPeriod == 0) {
            return abi.encodeWithSelector(TokenMediator.ZeroFeeStepPeriod.selector);
        }
        if (terms.feeStartRate != 0 && terms.feeRecipient == address(0)) {
            return abi.encodeWithSelector(TokenMediator.ZeroFeeRecipient.selector);
        }
        return "";
    }
}
