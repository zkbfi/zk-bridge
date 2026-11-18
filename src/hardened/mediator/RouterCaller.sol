// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {ExactGasCall} from "./ExactGasCall.sol";

/// @title RouterCaller
/// @notice The account that makes the follow-up call of a `DeliveryRouter` delivery. The router creates it in its
/// constructor, and only that router may use it. It makes one call to a target with exactly the gas that the sender
/// stated, the given data and no native value, and answers whether the call succeeded. The target sees this contract
/// as `msg.sender`, not the router.
/// @dev Why it exists. The sender of a delivery names the target and the call data, so the call can do anything that
/// its caller may do. When the router made the call itself, a call `token.transfer(attacker, balance)` took what the
/// router held at that moment: tokens of a plain relay to the router, of a failed callback, or of a refused hand-off,
/// which `sweep` sends to `failedDeliveryAddress` (code review, 2026-11-18, third round). This contract holds nothing,
/// gives no approval and has no owner, so the call can reach nothing that belongs to anyone. Anything sent to it (a
/// token transfer, coin from a self-destruct) is not protected: any follow-up call can move it. It is not where funds
/// go, and nothing in the bridge pays it.
///
/// The data from the router is packed, with no selector: the gas of the call (one word), the 20 byte target, then the
/// call data, which fills the rest. These are the last word of the router's `FeeDirector` (its `callGas`, at most
/// `DeliveryRouter.MAX_CALL_GAS`) and the bytes that follow it, so the router passes them in place with no copy. The
/// router always sends at least the 52 bytes of the gas word and the target.
///
/// The gas rule is the one of `ExactGasCall`, written out in assembly so that the code stays small: the router creates
/// this contract in its constructor, and the creation of the router must stay under the gas cap of one transaction
/// (`CreationGasCap.t.sol`). (a) Before the call it requires `gas + gas / 63 + ExactGasCall.CALL_OVERHEAD +
/// RETURN_RESERVE`, else it reverts with `ExactGasCall.InsufficientGas(available, required)`. (b) After a failed call
/// that leaves less than `gas / 63`, the target received less than its gas: it reverts with
/// `ExactGasCall.CallOutOfGas(gas)`. The router passes either revert up, so the delivery can run again with more gas.
/// Otherwise it answers one word: 1 when the target succeeded, 0 when it failed with its whole gas. It copies no
/// return data of the target. `RouterCaller.t.sol` checks the rule at the boundary.
contract RouterCaller {
    /// @notice The gas that this contract keeps after the call to the target, to return its answer. A target that
    /// burns its whole gas leaves at least this much, so its failure is always answered.
    uint256 internal constant RETURN_RESERVE = 1_000;

    /// @notice The router that created this contract, the only account that may use it.
    address public immutable router;

    /// @notice The caller is not the router.
    error NotRouter(address caller);

    constructor() {
        router = msg.sender;
    }

    /// @notice Calls the target with exactly the gas of the first word, no native value and the data after the target.
    /// Only the router may call it, and it takes no coin. It answers one word: 1 when the target succeeded, else 0.
    fallback() external {
        address only = router;
        uint256 overhead = ExactGasCall.CALL_OVERHEAD + RETURN_RESERVE;
        bytes4 notRouter = NotRouter.selector;
        bytes4 insufficientGas = ExactGasCall.InsufficientGas.selector;
        bytes4 callOutOfGas = ExactGasCall.CallOutOfGas.selector;
        assembly {
            // The memory of this frame holds only the call data or an error; the frame ends in this block.
            if iszero(eq(caller(), only)) {
                mstore(0, notRouter)
                mstore(4, caller())
                revert(0, 36)
            }
            let gasAmount := calldataload(0)
            let length := sub(calldatasize(), 52)
            calldatacopy(0, 52, length)
            let required := add(add(gasAmount, div(gasAmount, 63)), overhead)
            let available := gas()
            if lt(available, required) {
                mstore(0, insufficientGas)
                mstore(4, available)
                mstore(36, required)
                revert(0, 68)
            }
            let success := call(gasAmount, shr(96, calldataload(32)), 0, 0, length, 0, 0)
            if and(iszero(success), lt(gas(), div(gasAmount, 63))) {
                mstore(0, callOutOfGas)
                mstore(4, gasAmount)
                revert(0, 36)
            }
            mstore(0, success)
            return(0, 32)
        }
    }
}
