// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @title ExactGasCall
/// @notice A call that gets exactly the gas that a sender stated, or none at all. The rule is the same wherever a
/// sender states a gas number for a call (the callback of the mediator, the follow-up call of a router): not enough gas
/// reverts the whole delivery, so it can run again with more gas; a callee that fails with the gas it was promised is
/// a recorded failure, and the delivery completes.
/// @dev Two checks, one on each side of the call.
/// (a) Before the call. The EVM forwards at most 63/64 of the gas left, so the call can receive `gasAmount` only when
/// `gasleft() >= gasAmount + gasAmount / 63` at the moment it forwards. Between this check and that moment the call
/// spends some gas of its own: the address access (2,600 cold), a second access of 2,600 when the target is an account
/// that delegates its code (EIP-7702), and the opcodes that prepare the call; after the call, check (b) spends a few
/// more before it reads the gas left. `CALL_OVERHEAD` (6,000) covers all of it. Measured (`ExactGasCall.t.sol`):
/// 2,845 gas with a cold target, 5,445 with a cold target that delegates to a cold account. The caller adds `reserve`,
/// the gas that it needs after the call. So the check requires `gasAmount + gasAmount / 63 + CALL_OVERHEAD + reserve`;
/// less gas reverts with `InsufficientGas`.
/// (b) After a failed call. Let `L` be the gas left at the moment the call forwards. Check (a) gives
/// `L >= gasAmount + gasAmount / 63 + reserve + t`, where `t` is the gas that check (b) spends before it reads the gas
/// left. Then `L - L / 64 >= gasAmount`, so the callee received all of `gasAmount`, and a callee that used all of it
/// leaves at least `L - gasAmount - t >= gasAmount / 63 + reserve` when check (b) reads the gas left. So a failed call
/// that leaves less than `gasAmount / 63` received less than its gas: it reverts with `CallOutOfGas`. On the EVM of
/// today check (a) makes that impossible; check (b) keeps the rule if a call ever spends more than `CALL_OVERHEAD`
/// before it forwards. A failed call that leaves more ran with the gas that it was promised. The sum holds for any
/// `reserve`, zero included: without `CALL_OVERHEAD`, a caller with a reserve smaller than the call's own gas could
/// see a callee that received all of its gas and failed reported as `CallOutOfGas`.
/// The call copies no return data, so a callee cannot spend the gas of the caller with a large answer or a large
/// error.
library ExactGasCall {
    /// @notice The gas that the call spends of its own between check (a) and the moment it forwards, and that check (b)
    /// spends before it reads the gas left. Check (a) requires it on top of the gas of the call and its 63/64 share.
    uint256 internal constant CALL_OVERHEAD = 6_000;

    /// @notice The gas left cannot give the call its gas under the 63/64 rule, plus `CALL_OVERHEAD` and the reserve of
    /// the caller.
    error InsufficientGas(uint256 available, uint256 required);
    /// @notice The call failed after it received less than its gas. The delivery can run again with more gas.
    error CallOutOfGas(uint256 gasAmount);

    /// @notice Calls `target` with exactly `gasAmount`, no native value, and the bytes of `data` from `start` on.
    /// @param target The callee.
    /// @param gasAmount The gas that the callee gets.
    /// @param reserve The gas that the caller needs after the call. Check (a) adds it. Any value is sound, even zero.
    /// @param data The memory that holds the call data.
    /// @param start The offset of the call data in `data`. The call data runs to the end of `data`.
    /// @return success Whether the call succeeded.
    function callWithExactGas(address target, uint256 gasAmount, uint256 reserve, bytes memory data, uint256 start)
        internal
        returns (bool success)
    {
        uint256 required = gasAmount + gasAmount / 63 + CALL_OVERHEAD + reserve;
        uint256 available = gasleft();
        if (available < required) revert InsufficientGas(available, required);
        uint256 length = data.length - start;
        assembly ("memory-safe") {
            success := call(gasAmount, target, 0, add(add(data, 32), start), length, 0, 0)
        }
        if (!success && gasleft() < gasAmount / 63) revert CallOutOfGas(gasAmount);
    }
}
