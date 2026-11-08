// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Vm} from "forge-std/Vm.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {TokenMediator} from "../../../src/hardened/mediator/TokenMediator.sol";
import {ExactGasCall} from "../../../src/hardened/mediator/ExactGasCall.sol";
import {
    MediatorFixture,
    MockAMB,
    RecordingReceiver,
    ScriptedMediatorLimiter,
    TEST_CALLBACK_GAS
} from "./utils/MediatorSupport.sol";
import {CallBurner, CallReverter} from "./utils/CallTargets.sol";

/// @notice A receiver that returns a large error: it reverts with 100,000 bytes of data.
contract LargeErrorReceiver {
    function onTokenBridged(address, uint256, bytes calldata) external pure {
        assembly {
            revert(0, 100000)
        }
    }
}

/// @notice A receiver that reverts with no data at all.
contract SilentReverter {
    function onTokenBridged(address, uint256, bytes calldata) external pure {
        assembly {
            revert(0, 0)
        }
    }
}

/// @notice The rule at every level of a delivery, swept over the gas that an executor brings: not enough gas reverts the
/// whole delivery (the message waits); a callee that says no with gas to spare is recorded and the delivery completes.
/// The sweep calls the mediator through the mock bridge with every gas amount in a range. At no amount may a delivery
/// go through with a failure that only a lack of gas caused: a `ReleaseFailed` for a token that pays, or a
/// `CallbackFailed` for a receiver that works.
contract TokenMediatorStarvationTest is MediatorFixture {
    address internal recipient = makeAddr("recipient");

    /// @dev Delivers message `index` of `source` on `destination` with exactly `gas` and keeps the state. Returns
    /// whether it went through, its error and its logs.
    function _attempt(MockAMB destination, MockAMB source, uint256 index, uint256 gas)
        internal
        returns (bool ok, bytes memory error, Vm.Log[] memory logs)
    {
        vm.recordLogs();
        (ok, error) = destination.deliverWithGas(source, index, gas);
        logs = vm.getRecordedLogs();
    }

    function _count(Vm.Log[] memory logs, bytes32 topic) internal pure returns (uint256 count) {
        for (uint256 i = 0; i < logs.length; i++) {
            if (logs[i].topics.length > 0 && logs[i].topics[0] == topic) count++;
        }
    }

    /// @dev Sweeps the gas from `low` to `high` in steps of `step`. Each attempt runs from the same state. It checks
    /// that every attempt either reverted or paid with no failure event, and returns the least gas that paid and
    /// whether some attempt reverted with `errorSelector`.
    function _sweep(
        MockAMB destination,
        MockAMB source,
        uint256 index,
        uint256[3] memory range,
        bytes4 errorSelector
    ) internal returns (uint256 leastPaid, bool sawError) {
        for (uint256 gas = range[0]; gas <= range[1]; gas += range[2]) {
            uint256 snapshot = vm.snapshotState();
            (bool ok, bytes memory error, Vm.Log[] memory logs) = _attempt(destination, source, index, gas);
            vm.revertToState(snapshot);
            if (!ok) {
                if (bytes4(error) == errorSelector) sawError = true;
                continue;
            }
            assertEq(_count(logs, TokenMediator.ReleaseFailed.selector), 0, "no failed release from a lack of gas");
            assertEq(_count(logs, TokenMediator.CallbackFailed.selector), 0, "no failed callback from a lack of gas");
            assertEq(_count(logs, TokenMediator.TokensBridged.selector), 1, "the release paid");
            if (leastPaid == 0) leastPaid = gas;
        }
    }

    /// @dev Locks `tokenA` on A for bob on B, delivers it, and has bob send the copy back to `recipient`. Returns the
    /// index of the release on B.
    function _releaseOnA() internal returns (uint256) {
        _bridgeAtoB(alice, address(tokenA), bob, 100 ether);
        vm.startPrank(bob);
        IERC20(_copyOf(address(tokenA))).approve(address(mediatorB), type(uint256).max);
        mediatorB.relayTokens(_copyOf(address(tokenA)), recipient, 10 ether);
        vm.stopPrank();
        return _lastIndexB();
    }

    /// Claim: a native release (a transfer) never ends as a failure for a lack of gas. Shows: across every gas from
    /// 20,000 to 120,000 in steps of 250, an attempt either reverts or pays, some attempts revert with
    /// `ReleaseOutOfGas` (the reserve check and the check after a starved transfer), and the attempts from the least
    /// paying gas on all pay. Matters: anyone may deliver, so an executor must not be able to turn a lack of gas into a
    /// final `ReleaseFailed`.
    function test_aStarvedTransferAlwaysRevertsTheDelivery() public {
        uint256 index = _releaseOnA();
        (uint256 least, bool sawError) =
            _sweep(ambA, ambB, index, [uint256(20_000), 120_000, 250], TokenMediator.ReleaseOutOfGas.selector);
        assertTrue(sawError, "a starved transfer reverts with ReleaseOutOfGas");
        assertGt(least, 0, "enough gas pays");
        (bool ok,,) = _attempt(ambA, ambB, index, least);
        assertTrue(ok);
        assertEq(tokenA.balanceOf(recipient), 10 ether, "the recipient is paid");
    }

    /// Claim: a mint of a copy never ends as a failure for a lack of gas. Shows: the same sweep for a later message
    /// (mint only): every attempt reverts or pays. A starved mint leaves the mediator one 64th of its gas, which may be
    /// too little to revert with `ReleaseOutOfGas`, so the revert can also be a plain out-of-gas. Matters: the mint is a
    /// call that the mediator catches, so its lack of gas must never read as a refusal.
    function test_aStarvedMintAlwaysRevertsTheDelivery() public {
        _bridgeAtoB(alice, address(tokenA), bob, 1 ether);
        vm.prank(alice);
        mediatorA.relayTokens(address(tokenA), recipient, 5 ether);
        (uint256 least,) =
            _sweep(ambB, ambA, _lastIndexA(), [uint256(20_000), 150_000, 250], TokenMediator.ReleaseOutOfGas.selector);
        assertGt(least, 0, "enough gas mints");
    }

    /// Claim: the flow limiter never refuses a release for a lack of gas. Shows: with a limiter attached, the sweep
    /// finds attempts that revert with `ReleaseOutOfGas` from the starved limiter, and none that records a failed
    /// release; a limiter that refuses with gas to spare is recorded as `ReleaseFailed`. Matters: the limiter is a
    /// call that the mediator catches, like the token.
    function test_aStarvedLimiterAlwaysRevertsTheDelivery() public {
        ScriptedMediatorLimiter limiter = new ScriptedMediatorLimiter();
        TokenMediator.MediatorTerms memory termsA = _noTerms();
        termsA.flowLimiter = address(limiter);
        _deployMediators(termsA, _noTerms());
        vm.prank(alice);
        tokenA.approve(address(mediatorA), type(uint256).max);

        uint256 index = _releaseOnA();
        (, bool sawError) =
            _sweep(ambA, ambB, index, [uint256(20_000), 200_000, 250], TokenMediator.ReleaseOutOfGas.selector);
        assertTrue(sawError, "a starved limiter reverts with ReleaseOutOfGas");

        limiter.setRefusals(false, true);
        (bool ok,, Vm.Log[] memory logs) = _attempt(ambA, ambB, index, 1_000_000);
        assertTrue(ok, "a refusal with gas to spare is recorded");
        assertEq(_count(logs, TokenMediator.ReleaseFailed.selector), 1, "as a failed release");
    }

    /// @dev Bob sends the copy back to `receiver` with a call and `callbackGas`. Returns the index on B.
    function _releaseWithCall(address receiver, uint256 callbackGas) internal returns (uint256) {
        _bridgeAtoB(alice, address(tokenA), bob, 100 ether);
        vm.startPrank(bob);
        IERC20(_copyOf(address(tokenA))).approve(address(mediatorB), type(uint256).max);
        mediatorB.relayTokensAndCall(_copyOf(address(tokenA)), receiver, 10 ether, hex"c0ffee", callbackGas);
        vm.stopPrank();
        return _lastIndexB();
    }

    /// Claim: a callback never fails for a lack of gas: a delivery that cannot give the callback its stated gas
    /// reverts with `InsufficientGas`. Shows: across a sweep, every attempt either reverts or pays and runs the
    /// callback (the receiver counts one call, and no `CallbackFailed`); some attempts revert with `InsufficientGas`.
    /// Matters: the mediator guarantees the gas of the callback to any receiver, so a router (or any contract) gets
    /// the same guarantee without the mediator knowing it.
    function test_aCallbackGetsItsGasOrTheDeliveryReverts() public {
        RecordingReceiver receiver = new RecordingReceiver();
        uint256 index = _releaseWithCall(address(receiver), 200_000);
        (uint256 least, bool sawError) =
            _sweep(ambA, ambB, index, [uint256(150_000), 450_000, 1_000], ExactGasCall.InsufficientGas.selector);
        assertTrue(sawError, "too little gas for the callback reverts with InsufficientGas");
        (bool ok,,) = _attempt(ambA, ambB, index, least);
        assertTrue(ok);
        assertEq(receiver.calls(), 1, "the callback ran once");
    }

    /// @dev Classifies one attempt: 0 another failure, 1 `InsufficientGas`, 2 `CallOutOfGas`, 3 delivered.
    function _classify(uint256 index, uint256 gas) internal returns (uint256) {
        uint256 snapshot = vm.snapshotState();
        (bool ok, bytes memory error,) = _attempt(ambA, ambB, index, gas);
        vm.revertToState(snapshot);
        if (ok) return 3;
        if (bytes4(error) == ExactGasCall.CallOutOfGas.selector) return 2;
        if (bytes4(error) == ExactGasCall.InsufficientGas.selector) return 1;
        return 0;
    }

    /// @dev The least gas whose attempt classifies at `level` or above. Found by bisection.
    function _leastAtLevel(uint256 index, uint256 level, uint256 low, uint256 high) internal returns (uint256) {
        while (low < high) {
            uint256 middle = (low + high) / 2;
            if (_classify(index, middle) >= level) high = middle;
            else low = middle + 1;
        }
        return low;
    }

    /// Claim: the check before the callback is what binds, and a burner with all of its gas is recorded. Shows: with a
    /// receiver that burns all its gas, the least gas at which the delivery goes through records `CallbackFailed` (the
    /// burner got its whole callback gas and failed), and one unit less reverts with `InsufficientGas`, not with a lack
    /// of gas after the call. Matters: the reserve of the mediator covers its work after the callback, so a burner can
    /// never make the delivery fail after the call; the second side of the rule (`CallOutOfGas`) is shown on the library
    /// itself in `ExactGasCall.t.sol`.
    function test_aBurnerWithItsFullGasIsRecordedAndOneUnitLessReverts() public {
        CallBurner burner = new CallBurner();
        uint256 index = _releaseWithCall(address(burner), 100_000);
        uint256 recorded = _leastAtLevel(index, 3, 100_000, 600_000);
        assertEq(_classify(index, recorded - 1), 1, "one unit less: InsufficientGas");
        (bool ok,, Vm.Log[] memory logs) = _attempt(ambA, ambB, index, recorded);
        assertTrue(ok, "with its full gas, the burner's failure is recorded");
        assertEq(_count(logs, TokenMediator.CallbackFailed.selector), 1, "CallbackFailed");
        assertEq(tokenA.balanceOf(address(burner)), 10 ether, "the receiver keeps the tokens");
    }

    /// Claim: a callback that reverts cleanly, with a reason or with no data, is recorded and the delivery completes.
    /// Shows: `CallbackFailed` once for each, the receiver holds the tokens. Matters: the callee said no, with its gas.
    function test_aCallbackThatRevertsCleanlyIsRecorded() public {
        address[2] memory receivers = [address(new CallReverter()), address(new SilentReverter())];
        for (uint256 i = 0; i < receivers.length; i++) {
            uint256 index = _releaseWithCall(receivers[i], TEST_CALLBACK_GAS);
            (bool ok,, Vm.Log[] memory logs) = _attempt(ambA, ambB, index, 3_000_000);
            assertTrue(ok, "delivered");
            assertEq(_count(logs, TokenMediator.CallbackFailed.selector), 1, "recorded");
            assertEq(tokenA.balanceOf(receivers[i]), 10 ether, "the receiver keeps the tokens");
        }
    }

    /// Claim: a callback that reverts with 100,000 bytes of error costs the mediator nothing extra. Shows: the delivery
    /// with that receiver uses less than 45,000 gas more than the same delivery with a receiver that reverts with no
    /// data. The receiver pays about 28,500 gas for its own memory; a copy into the mediator would add about 38,000
    /// more. Matters: the mediator copies no return data, so a receiver cannot make the work after its call run out of
    /// gas.
    function test_aLargeErrorCostsTheCallerNothing() public {
        LargeErrorReceiver large = new LargeErrorReceiver();
        SilentReverter silent = new SilentReverter();
        uint256 largeIndex = _releaseWithCall(address(large), TEST_CALLBACK_GAS);
        uint256 silentIndex = _releaseWithCall(address(silent), TEST_CALLBACK_GAS);

        uint256 before = gasleft();
        (bool largeOk,) = ambA.deliverWithGas(ambB, largeIndex, 5_000_000);
        uint256 largeCost = before - gasleft();
        before = gasleft();
        (bool silentOk,) = ambA.deliverWithGas(ambB, silentIndex, 5_000_000);
        uint256 silentCost = before - gasleft();

        assertTrue(largeOk && silentOk, "both delivered");
        emit log_named_uint("delivery with a 100,000 byte error", largeCost);
        emit log_named_uint("delivery with an empty error", silentCost);
        assertLt(largeCost, silentCost + 45_000, "the large error is not copied by the mediator");
    }
}
