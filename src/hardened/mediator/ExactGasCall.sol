// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @title ExactGasCall
/// @notice A call that gets exactly the gas that a sender stated, or none at all. The rule is the same wherever a
/// sender states a gas number for a call (the callback of the mediator, the follow-up call of a router): not enough gas
/// reverts the whole delivery, so it can run again with more gas; a callee that fails with the gas it was promised is
/// a recorded failure, and the delivery completes.
/// @dev Two checks, one on each side of the call.
/// (a) Before the call. The EVM forwards at most 63/64 of the gas left, so the call can receive `gasAmount` only when
/// `gasleft() >= gasAmount + gasAmount / 63`. The caller adds `reserve`, the gas that it needs after the call. Less
/// gas reverts with `InsufficientGas`.
/// (b) After a failed call. A few operations run between check (a) and the call (the address access, the memory of
/// the arguments), so the callee may still have received a little less than `gasAmount`. When it did, and failed,
/// the gas left is below `gasAmount / 63`: with the full amount forwarded it is at least that much. So a failed call
/// that leaves less than `gasAmount / 63` reverts with `CallOutOfGas`. A failed call that leaves more ran with the
/// gas that it was promised.
/// The call copies no return data, so a callee cannot spend the gas of the caller with a large answer or a large
/// error.
library ExactGasCall {
    /// @notice The gas left cannot give the call its gas under the 63/64 rule, plus the reserve of the caller.
    error InsufficientGas(uint256 available, uint256 required);
    /// @notice The call failed after it received less than its gas. The delivery can run again with more gas.
    error CallOutOfGas(uint256 gasAmount);

    /// @notice Calls `target` with exactly `gasAmount`, no native value, and the bytes of `data` from `start` on.
    /// @param target The callee.
    /// @param gasAmount The gas that the callee gets.
    /// @param reserve The gas that the caller needs after the call. Check (a) adds it.
    /// @param data The memory that holds the call data.
    /// @param start The offset of the call data in `data`. The call data runs to the end of `data`.
    /// @return success Whether the call succeeded.
    function callWithExactGas(address target, uint256 gasAmount, uint256 reserve, bytes memory data, uint256 start)
        internal
        returns (bool success)
    {
        uint256 required = gasAmount + gasAmount / 63 + reserve;
        uint256 available = gasleft();
        if (available < required) revert InsufficientGas(available, required);
        uint256 length = data.length - start;
        assembly ("memory-safe") {
            success := call(gasAmount, target, 0, add(add(data, 32), start), length, 0, 0)
        }
        if (!success && gasleft() < gasAmount / 63) revert CallOutOfGas(gasAmount);
    }
}
