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

    function _attempt(address target, uint256 reserve, uint256 supplied) internal returns (bool ok, bytes memory error) {
        uint256 snapshot = vm.snapshotState();
        // Every attempt finds the target cold, so the call pays the cold address access between the check and the call.
        vm.cool(target);
        (ok, error) = address(harness).call{gas: supplied}(
            abi.encodeCall(ExactGasCallHarness.call, (target, GAS, reserve, hex"01", 0))
        );
        vm.revertToState(snapshot);
    }

    /// @dev The least supplied gas whose attempt does not revert with `InsufficientGas`. Found by bisection.
    function _firstPastTheCheck(address target, uint256 reserve) internal returns (uint256) {
        uint256 low = GAS;
        uint256 high = 3 * GAS;
        while (low < high) {
            uint256 middle = (low + high) / 2;
            (bool ok, bytes memory error) = _attempt(target, reserve, middle);
            if (ok || bytes4(error) != ExactGasCall.InsufficientGas.selector) high = middle;
            else low = middle + 1;
        }
        return low;
    }

    /// Claim: a callee that got a little less than its gas and burned it all is read as starved: `CallOutOfGas`. Shows:
    /// with no reserve and a cold target, the least gas that passes the check before the call leaves the callee short
    /// by about the cost of the cold address access, and the burner's failure reverts with `CallOutOfGas`; with 20,000
    /// gas more the burner gets its whole gas and the call reports false. Matters: the check after the call is the
    /// second side of the rule; the window between the check and the call cannot turn a lack of gas into a recorded
    /// failure.
    function test_aBurnerALittleShortOfItsGasRevertsWithCallOutOfGas() public {
        address burner = address(new CallBurner());
        uint256 first = _firstPastTheCheck(burner, 0);
        (bool ok, bytes memory error) = _attempt(burner, 0, first);
        assertFalse(ok);
        assertEq(error, abi.encodeWithSelector(ExactGasCall.CallOutOfGas.selector, GAS), "CallOutOfGas");

        (bool full, bytes memory answer) = _attempt(burner, 0, first + 20_000);
        assertTrue(full, "with its whole gas the burner's failure is an answer");
        assertFalse(abi.decode(answer, (bool)), "the call failed");
    }

    /// Claim: too little gas before the call reverts with the gas left and the gas required. Shows: the error names
    /// `GAS + GAS / 63 + reserve` as required.
    function test_tooLittleGasRevertsWithTheRequiredGas() public {
        (bool ok, bytes memory error) = _attempt(address(new CallRecorder()), 5_000, 500_000);
        assertFalse(ok);
        assertEq(bytes4(error), ExactGasCall.InsufficientGas.selector);
        (, uint256 required) = abi.decode(_tail(error), (uint256, uint256));
        assertEq(required, GAS + GAS / 63 + 5_000);
    }

    /// Claim: a callee that succeeds gets exactly the stated gas and the data from `start`. Shows: a recorder sees at
    /// most `GAS` at its entry, and the bytes after the offset.
    function test_theCalleeGetsTheGasAndTheDataFromTheOffset() public {
        CallRecorder recorder = new CallRecorder();
        bool ok = harness.call{gas: 3 * GAS}(address(recorder), GAS, 0, hex"aabbccdd", 2);
        assertTrue(ok);
        assertLe(recorder.gasAtEntry(), GAS);
        assertEq(recorder.lastData(), hex"ccdd");
    }

    function _tail(bytes memory error) internal pure returns (bytes memory rest) {
        rest = new bytes(error.length - 4);
        for (uint256 i = 0; i < rest.length; i++) {
            rest[i] = error[i + 4];
        }
    }
}
