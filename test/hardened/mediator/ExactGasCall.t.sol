// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {ExactGasCall} from "../../../src/hardened/mediator/ExactGasCall.sol";
import {CallBurner, CallRecorder} from "./utils/CallTargets.sol";

/// @notice Calls the library with a chosen gas, reserve and target.
contract ExactGasCallHarness {
    function call(address target, uint256 gasAmount, uint256 reserve, bytes memory data, uint256 start)
        external
        returns (bool)
    {
        return ExactGasCall.callWithExactGas(target, gasAmount, reserve, data, start);
    }
}

/// @notice The two checks of a call with a stated gas, on the library alone.
contract ExactGasCallTest is Test {
    ExactGasCallHarness internal harness = new ExactGasCallHarness();
    uint256 internal constant GAS = 1_000_000;
    /// @dev The gas of the scans. Each attempt of a scan burns it, so it is small enough for thousands of attempts.
    uint256 internal constant SCAN_GAS = 100_000;

    /// @dev Targets are created here, before the test, so that `vm.cool` makes them cold: a contract created inside the
    /// test stays warm.
    address internal burner;
    address internal recorder;
    address internal strict;
    address internal delegating;

    function setUp() public {
        burner = address(new CallBurner());
        recorder = address(new CallRecorder());
        strict = makeAddr("failsOnlyWithItsWholeGas");
        // GAS, PUSH3 SCAN_GAS-3, LT, PUSH1 10, JUMPI, STOP, JUMPDEST, INVALID. GAS costs 2, so the word it reads is
        // above SCAN_GAS - 3 only when the code received all of SCAN_GAS: then it fails with the invalid opcode, which
        // burns the rest. With less it stops.
        vm.etch(strict, abi.encodePacked(hex"5a62", uint24(SCAN_GAS - 3), hex"10600a57005bfe"));
        // An account that delegates its code to `strict` (EIP-7702): a call to it also reads `strict`.
        delegating = makeAddr("delegating");
        vm.etch(delegating, abi.encodePacked(hex"ef0100", strict));
    }

    function _attempt(address target, uint256 gasAmount, uint256 reserve, uint256 supplied)
        internal
        returns (bool ok, bytes memory error)
    {
        uint256 snapshot = vm.snapshotState();
        // Every attempt finds the target cold, so the call pays the cold address access between the check and the call.
        vm.cool(target);
        (ok, error) = address(harness).call{gas: supplied}(
            abi.encodeCall(ExactGasCallHarness.call, (target, gasAmount, reserve, hex"01", 0))
        );
        vm.revertToState(snapshot);
    }

    /// @dev The least supplied gas whose attempt does not revert with `InsufficientGas`. Found by bisection.
    function _firstPastTheCheck(address target, uint256 gasAmount, uint256 reserve) internal returns (uint256) {
        uint256 low = gasAmount;
        uint256 high = 3 * gasAmount + 100_000;
        while (low < high) {
            uint256 middle = (low + high) / 2;
            (bool ok, bytes memory error) = _attempt(target, gasAmount, reserve, middle);
            if (ok || bytes4(error) != ExactGasCall.InsufficientGas.selector) high = middle;
            else low = middle + 1;
        }
        return low;
    }

    /// Claim: the least gas that passes the check before the call gives the callee its whole gas, even with no
    /// reserve and a cold target. Shows: at that gas a burner gets all of `GAS` and its failure is a recorded failure
    /// (false), not `CallOutOfGas`. Matters: check (a) counts the gas that the call itself spends before it forwards
    /// (`CALL_OVERHEAD`), so a caller that passes it has given the callee what it was promised.
    function test_theLeastGasPastTheCheckGivesABurnerItsWholeGas() public {
        uint256 first = _firstPastTheCheck(burner, GAS, 0);
        (bool ok, bytes memory answer) = _attempt(burner, GAS, 0, first);
        assertTrue(ok, "no revert past the check");
        assertFalse(abi.decode(answer, (bool)), "the call failed");
    }

    /// Claim: a callee that received its whole gas and failed is a recorded failure, for any reserve, even zero.
    /// Shows: a cold callee that fails only when it received all of `SCAN_GAS` (and stops when it received less) is
    /// called with no reserve at every supplied gas from the least that passes the check before the call to 4,000
    /// more. Every attempt returns false: none reverts with `CallOutOfGas`, and the callee got its whole gas each time.
    /// Matters: check (b) must not read the gas that the call itself spends (the cold address access, the opcodes
    /// around it) as a short callee. Measured with `CALL_OVERHEAD` at zero: from 2,752 to 2,844 gas past the check, the
    /// callee had all of its gas, failed, and the call reverted `CallOutOfGas`.
    function test_aCalleeWithItsWholeGasThatFailsIsARecordedFailureWithNoReserve() public {
        uint256 first = _firstPastTheCheck(strict, SCAN_GAS, 0);
        uint256 failures;
        for (uint256 supplied = first; supplied < first + 4_000; supplied++) {
            (bool ok, bytes memory answer) = _attempt(strict, SCAN_GAS, 0, supplied);
            assertTrue(ok, "no revert past the check");
            if (!abi.decode(answer, (bool))) failures += 1;
        }
        assertEq(failures, 4_000, "the callee got its whole gas and failed, every time");
    }

    /// Claim: the same holds for a target that delegates its code (EIP-7702), the costliest call that the EVM makes
    /// before it forwards. Shows: the scan above, on the Prague rules, with the delegating account and its delegate
    /// both cold. Matters: a recipient may be such an account. The call then spends two cold accesses (5,200 gas)
    /// before it forwards; measured with `CALL_OVERHEAD` at zero, the band of false `CallOutOfGas` sat 5,352 to 5,444
    /// gas past the check, under the 6,000 of `CALL_OVERHEAD`.
    /// forge-config: default.evm_version = "prague"
    function test_aDelegatingCalleeWithItsWholeGasThatFailsIsARecordedFailure() public {
        uint256 first = _firstPastTheCheck(delegating, SCAN_GAS, 0);
        uint256 failures;
        for (uint256 supplied = first; supplied < first + 6_500; supplied++) {
            vm.cool(strict);
            (bool ok, bytes memory answer) = _attempt(delegating, SCAN_GAS, 0, supplied);
            assertTrue(ok, "no revert past the check");
            if (!abi.decode(answer, (bool))) failures += 1;
        }
        assertEq(failures, 6_500, "the callee got its whole gas and failed, every time");
    }

    /// Claim: too little gas before the call reverts with the gas left and the gas required. Shows: the error names
    /// `GAS + GAS / 63 + CALL_OVERHEAD + reserve` as required.
    function test_tooLittleGasRevertsWithTheRequiredGas() public {
        (bool ok, bytes memory error) = _attempt(recorder, GAS, 5_000, 500_000);
        assertFalse(ok);
        assertEq(bytes4(error), ExactGasCall.InsufficientGas.selector);
        (, uint256 required) = abi.decode(_tail(error), (uint256, uint256));
        assertEq(required, GAS + GAS / 63 + ExactGasCall.CALL_OVERHEAD + 5_000);
    }

    /// Claim: a callee that succeeds gets exactly the stated gas and the data from `start`. Shows: a recorder sees at
    /// most `GAS` at its entry, and the bytes after the offset.
    function test_theCalleeGetsTheGasAndTheDataFromTheOffset() public {
        bool ok = harness.call{gas: 3 * GAS}(recorder, GAS, 0, hex"aabbccdd", 2);
        assertTrue(ok);
        assertLe(CallRecorder(payable(recorder)).gasAtEntry(), GAS);
        assertEq(CallRecorder(payable(recorder)).lastData(), hex"ccdd");
    }

    function _tail(bytes memory error) internal pure returns (bytes memory rest) {
        rest = new bytes(error.length - 4);
        for (uint256 i = 0; i < rest.length; i++) {
            rest[i] = error[i + 4];
        }
    }
}
