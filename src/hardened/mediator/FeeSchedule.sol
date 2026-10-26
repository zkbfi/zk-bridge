// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";

/// @title FeeSchedule
/// @notice The pure math of the declining fee of the token mediator. The rate starts at `startRate` and falls by
/// `stepRate` after each `stepPeriod`, down to `floorRate`. All rates are scaled by `DENOMINATOR`. The rate never
/// rises. The library holds no state, so the contract and the dashboard can use the same function: the TypeScript
/// copy in `explorer/shared` is tested against vectors that this library prints.
library FeeSchedule {
    /// @notice The divisor of a rate. A rate of `DENOMINATOR` is 100%.
    uint256 internal constant DENOMINATOR = 1e18;

    /// @notice The five values of a schedule.
    /// @param startTime The start of the schedule in seconds.
    /// @param startRate The rate from the start until the end of the first period.
    /// @param stepRate The amount that the rate falls after each period.
    /// @param floorRate The lowest rate. It must not exceed `startRate`.
    /// @param stepPeriod The length of one step in seconds. It must not be zero when `stepRate` is not zero.
    struct Schedule {
        uint256 startTime;
        uint256 startRate;
        uint256 stepRate;
        uint256 floorRate;
        uint256 stepPeriod;
    }

    /// @notice The rate at a time: `max(startRate - stepRate * floor((timestamp - startTime) / stepPeriod), floorRate)`.
    /// It is the start rate at or before the start time, and when the step is zero.
    /// @dev The step count is compared with the number of steps that reach the floor, so the product never overflows
    /// and the subtraction never underflows, for any timestamp. A schedule with a floor above the start rate, or with
    /// a step and no period, is not valid. The mediator refuses both at deployment.
    function rateAt(Schedule memory schedule, uint256 timestamp) internal pure returns (uint256) {
        if (timestamp <= schedule.startTime || schedule.stepRate == 0) return schedule.startRate;
        uint256 steps = (timestamp - schedule.startTime) / schedule.stepPeriod;
        if (steps > (schedule.startRate - schedule.floorRate) / schedule.stepRate) return schedule.floorRate;
        return schedule.startRate - steps * schedule.stepRate;
    }

    /// @notice The fee on an amount at a rate, rounded down. It never exceeds the amount when the rate is at most
    /// `DENOMINATOR`, and it does not overflow for a large amount.
    function feeOn(uint256 amount, uint256 rate) internal pure returns (uint256) {
        return Math.mulDiv(amount, rate, DENOMINATOR);
    }
}
