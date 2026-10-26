// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Script} from "forge-std/Script.sol";
import {console2} from "forge-std/console2.sol";
import {FeeSchedule} from "src/hardened/mediator/FeeSchedule.sol";

/// @dev Calls the internal library functions, so that the script prints what the compiled library computes.
contract FeeScheduleProbe {
    function rateAt(FeeSchedule.Schedule memory schedule, uint256 timestamp) external pure returns (uint256) {
        return FeeSchedule.rateAt(schedule, timestamp);
    }

    function feeOn(uint256 amount, uint256 rate) external pure returns (uint256) {
        return FeeSchedule.feeOn(amount, rate);
    }
}

/// @title GenerateFeeScheduleVectors
/// @notice Prints test vectors of the fee schedule library, one JSON object per line. Run from the repository root:
///   forge script explorer/shared/vectors/GenerateFeeScheduleVectors.s.sol --tc GenerateFeeScheduleVectors --root . 2>&1 | grep '^  VECTOR ' | sed 's/^  VECTOR //'
/// The test in explorer/shared/test/fee-schedule.test.ts reads the saved lines in
/// test/fixtures/fee-schedule-vectors.jsonl, so the TypeScript copy and the library cannot drift.
contract GenerateFeeScheduleVectors is Script {
    uint256 private constant YEAR = 365 days;

    function run() external {
        FeeScheduleProbe probe = new FeeScheduleProbe();
        // The deployment: 0.10% falling 0.01% a year to 0.05%. The start time is a real timestamp.
        uint256 start = 1_790_000_000;
        FeeSchedule.Schedule memory deployment = FeeSchedule.Schedule(start, 1e15, 1e14, 5e14, YEAR);
        _schedule(probe, deployment, start - 1);
        _schedule(probe, deployment, start);
        for (uint256 year = 1; year <= 7; year++) {
            _schedule(probe, deployment, start + year * YEAR - 1);
            _schedule(probe, deployment, start + year * YEAR);
            _schedule(probe, deployment, start + year * YEAR + 1);
        }
        _schedule(probe, deployment, start + 1_000 * YEAR);
        _schedule(probe, deployment, type(uint64).max);
        _schedule(probe, deployment, type(uint256).max);
        // Edge schedules.
        FeeSchedule.Schedule memory edge = FeeSchedule.Schedule(0, 10, 3, 2, 100);
        for (uint256 step = 0; step <= 5; step++) {
            _schedule(probe, edge, step * 100);
            _schedule(probe, edge, step * 100 + 99);
        }
        _schedule(probe, FeeSchedule.Schedule(5, 0, 0, 0, 0), 1_000);
        _schedule(probe, FeeSchedule.Schedule(5, 7, 0, 7, 0), type(uint256).max);
        _schedule(probe, FeeSchedule.Schedule(5, 7, 1, 7, 9), 1_000);
        _schedule(probe, FeeSchedule.Schedule(0, type(uint256).max, type(uint256).max, 0, 1), 1);
        _schedule(probe, FeeSchedule.Schedule(0, type(uint256).max, 1, 0, 1), type(uint128).max);
        // Pseudo random schedules from a fixed seed.
        for (uint256 i = 0; i < 40; i++) {
            uint256 seed = uint256(keccak256(abi.encode("fee schedule vector", i)));
            uint256 startRate = seed % 1e18;
            FeeSchedule.Schedule memory random = FeeSchedule.Schedule(
                (seed >> 8) % 2 ** 40,
                startRate,
                (seed >> 16) % (startRate / 4 + 1),
                ((seed >> 24) % (startRate + 1)),
                1 + (seed >> 32) % (2 * YEAR)
            );
            _schedule(probe, random, random.startTime + (seed >> 64) % (60 * YEAR));
        }
        // Fees.
        uint256[6] memory amounts = [uint256(0), 1, 999, 9_999, 100 * 2 ** 220, type(uint256).max];
        uint256[5] memory rates = [uint256(0), 1, 5e14, 1e15, 1e18];
        for (uint256 a = 0; a < amounts.length; a++) {
            for (uint256 r = 0; r < rates.length; r++) {
                console2.log(
                    string.concat(
                        "VECTOR {\"kind\":\"fee\",\"amount\":\"", vm.toString(amounts[a]),
                        "\",\"rate\":\"", vm.toString(rates[r]),
                        "\",\"fee\":\"", vm.toString(probe.feeOn(amounts[a], rates[r])), "\"}"
                    )
                );
            }
        }
    }

    function _schedule(FeeScheduleProbe probe, FeeSchedule.Schedule memory schedule, uint256 timestamp) private {
        console2.log(
            string.concat(
                "VECTOR {\"kind\":\"rate\",\"startTime\":\"", vm.toString(schedule.startTime),
                "\",\"startRate\":\"", vm.toString(schedule.startRate),
                "\",\"stepRate\":\"", vm.toString(schedule.stepRate),
                "\",\"floorRate\":\"", vm.toString(schedule.floorRate),
                "\",\"stepPeriod\":\"", vm.toString(schedule.stepPeriod),
                "\",\"timestamp\":\"", vm.toString(timestamp),
                "\",\"rate\":\"", vm.toString(probe.rateAt(schedule, timestamp)), "\"}"
            )
        );
    }
}
