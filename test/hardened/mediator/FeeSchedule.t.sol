// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {FeeSchedule} from "../../../src/hardened/mediator/FeeSchedule.sol";

/// @notice Tests of the pure fee schedule math, on the library directly.
contract FeeScheduleTest is Test {
    uint256 internal constant YEAR = 365 days;
    uint256 internal constant START_TIME = 1_000_000;

    /// @dev The deployment: 0.10% falling 0.01% a year to a floor of 0.05%.
    function _deployment() internal pure returns (FeeSchedule.Schedule memory) {
        return FeeSchedule.Schedule(START_TIME, 1e15, 1e14, 5e14, YEAR);
    }

    /// Claim: the deployment schedule is exact at each year boundary. Shows: the rate one second before and at each
    /// boundary for six years, which includes the step down to the floor.
    function test_theDeploymentValuesAtEachYearBoundary() public pure {
        FeeSchedule.Schedule memory schedule = _deployment();
        uint256[6] memory expected = [uint256(10e14), 9e14, 8e14, 7e14, 6e14, 5e14];
        assertEq(FeeSchedule.rateAt(schedule, START_TIME), 10e14, "at the start");
        for (uint256 year = 1; year < 6; year++) {
            assertEq(FeeSchedule.rateAt(schedule, START_TIME + year * YEAR - 1), expected[year - 1], "just before");
            assertEq(FeeSchedule.rateAt(schedule, START_TIME + year * YEAR), expected[year], "at the boundary");
            assertEq(FeeSchedule.rateAt(schedule, START_TIME + year * YEAR + 1), expected[year], "just after");
        }
    }

    function test_beforeTheStartTheRateIsTheStartRate() public pure {
        assertEq(FeeSchedule.rateAt(_deployment(), 0), 10e14);
        assertEq(FeeSchedule.rateAt(_deployment(), START_TIME - 1), 10e14);
    }

    function test_theFloorHoldsLongAfter() public pure {
        FeeSchedule.Schedule memory schedule = _deployment();
        assertEq(FeeSchedule.rateAt(schedule, START_TIME + 6 * YEAR), 5e14);
        assertEq(FeeSchedule.rateAt(schedule, START_TIME + 1_000 * YEAR), 5e14, "year 1000");
        assertEq(FeeSchedule.rateAt(schedule, type(uint64).max), 5e14, "the largest uint64 timestamp");
        assertEq(FeeSchedule.rateAt(schedule, type(uint256).max), 5e14, "the largest timestamp");
    }

    function test_aStepOfZeroKeepsTheStartRate() public pure {
        FeeSchedule.Schedule memory schedule = FeeSchedule.Schedule(START_TIME, 10e14, 0, 10e14, 0);
        assertEq(FeeSchedule.rateAt(schedule, START_TIME + 100 * YEAR), 10e14, "a zero period is fine with a zero step");
        assertEq(FeeSchedule.rateAt(schedule, type(uint256).max), 10e14);
    }

    function test_aStartOfZeroIsAZeroFeeForever() public pure {
        FeeSchedule.Schedule memory schedule = FeeSchedule.Schedule(START_TIME, 0, 0, 0, 0);
        assertEq(FeeSchedule.rateAt(schedule, START_TIME), 0);
        assertEq(FeeSchedule.rateAt(schedule, type(uint256).max), 0);
        schedule = FeeSchedule.Schedule(START_TIME, 0, 5, 0, 10);
        assertEq(FeeSchedule.rateAt(schedule, START_TIME + 1_000), 0, "a step on a zero start stays at zero");
    }

    function test_aStartEqualToTheFloorNeverMoves() public pure {
        FeeSchedule.Schedule memory schedule = FeeSchedule.Schedule(START_TIME, 7e14, 1e14, 7e14, YEAR);
        assertEq(FeeSchedule.rateAt(schedule, START_TIME + YEAR), 7e14);
        assertEq(FeeSchedule.rateAt(schedule, START_TIME + 50 * YEAR), 7e14);
    }

    /// Claim: a floor that whole steps do not reach stops the rate at the floor. Shows: start 10, step 3, floor 2
    /// gives 10, 7, 4, 2, 2.
    function test_aFloorNotReachableByWholeStepsIsStillTheLastRate() public pure {
        FeeSchedule.Schedule memory schedule = FeeSchedule.Schedule(0, 10, 3, 2, 100);
        assertEq(FeeSchedule.rateAt(schedule, 0), 10);
        assertEq(FeeSchedule.rateAt(schedule, 100), 7);
        assertEq(FeeSchedule.rateAt(schedule, 200), 4);
        assertEq(FeeSchedule.rateAt(schedule, 300), 2, "10 - 9 = 1 is below the floor");
        assertEq(FeeSchedule.rateAt(schedule, 400), 2);
    }

    function test_aStepAsLargeAsTheWholeSpanReachesTheFloorAtOnce() public pure {
        FeeSchedule.Schedule memory schedule = FeeSchedule.Schedule(0, type(uint256).max, type(uint256).max, 0, 1);
        assertEq(FeeSchedule.rateAt(schedule, 0), type(uint256).max);
        assertEq(FeeSchedule.rateAt(schedule, 1), 0, "no overflow with the largest values");
        assertEq(FeeSchedule.rateAt(schedule, type(uint256).max), 0);
    }

    function test_feeOnRoundsDownAndNeverExceedsTheAmount() public pure {
        assertEq(FeeSchedule.feeOn(9_999, 25e14), 24, "24.99 rounds down");
        assertEq(FeeSchedule.feeOn(999, 1e15), 0);
        assertEq(FeeSchedule.feeOn(1_000, 1e18), 1_000, "100% takes the amount and no more");
        assertEq(FeeSchedule.feeOn(100 * 2 ** 220, 1e16), 2 ** 220, "no overflow in the product");
        assertEq(FeeSchedule.feeOn(type(uint256).max, 1e18), type(uint256).max);
    }

    /// @dev A straightforward reference: walk the steps one at a time with no shortcut. The walk is bounded, so the
    /// fuzz inputs keep the number of steps small.
    function _reference(FeeSchedule.Schedule memory schedule, uint256 timestamp) internal pure returns (uint256 rate) {
        rate = schedule.startRate;
        if (timestamp <= schedule.startTime || schedule.stepRate == 0) return rate;
        uint256 steps = (timestamp - schedule.startTime) / schedule.stepPeriod;
        for (uint256 i = 0; i < steps; i++) {
            if (rate < schedule.floorRate + schedule.stepRate) return schedule.floorRate;
            rate -= schedule.stepRate;
        }
        if (rate < schedule.floorRate) return schedule.floorRate;
    }

    /// Claim: the closed form equals a step by step walk. Matters: the shortcut is the only place where an overflow
    /// or an off by one can hide.
    function testFuzz_theClosedFormEqualsTheStepWalk(
        uint64 startTime,
        uint32 startRate,
        uint32 stepRate,
        uint32 floorSeed,
        uint32 period,
        uint32 elapsed
    ) public pure {
        period = uint32(bound(period, 1, 1_000));
        uint256 floorRate = uint256(floorSeed) % (uint256(startRate) + 1);
        FeeSchedule.Schedule memory schedule = FeeSchedule.Schedule(startTime, startRate, stepRate, floorRate, period);
        // At most 2000 steps.
        uint256 timestamp = uint256(startTime) + (uint256(elapsed) % (2_000 * uint256(period)));
        assertEq(FeeSchedule.rateAt(schedule, timestamp), _reference(schedule, timestamp));
    }

    /// Claim: for any valid schedule and any timestamp the rate is between the floor and the start rate, never rises
    /// with time, and never reverts.
    function testFuzz_theRateStaysBetweenTheFloorAndTheStartAndNeverRises(
        uint256 startTime,
        uint256 startRate,
        uint256 stepRate,
        uint256 floorSeed,
        uint256 period,
        uint256 early,
        uint256 late
    ) public pure {
        period = bound(period, 1, type(uint256).max);
        floorSeed = floorSeed % (startRate == type(uint256).max ? startRate : startRate + 1);
        FeeSchedule.Schedule memory schedule = FeeSchedule.Schedule(startTime, startRate, stepRate, floorSeed, period);
        if (late < early) (early, late) = (late, early);
        uint256 rateEarly = FeeSchedule.rateAt(schedule, early);
        uint256 rateLate = FeeSchedule.rateAt(schedule, late);
        assertLe(rateLate, rateEarly);
        assertLe(rateEarly, startRate);
        assertGe(rateLate, floorSeed);
    }
}
