// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {Vm} from "forge-std/Vm.sol";
import {MockERC20} from "../../mocks/MockERC20.sol";
import {DeliveryRouter} from "../../../src/hardened/mediator/DeliveryRouter.sol";
import {RouterCaller} from "../../../src/hardened/mediator/RouterCaller.sol";
import {ExactGasCall} from "../../../src/hardened/mediator/ExactGasCall.sol";
import {IWETH} from "../../../src/hardened/mediator/IWETH.sol";
import {ITokenMediator} from "../../../src/hardened/mediator/ITokenMediator.sol";
import {MockWrappedNative} from "./utils/MediatorSupport.sol";
import {CallBurner, CallRecorder} from "./utils/CallTargets.sol";

/// @notice Tests of `RouterCaller`, the contract that makes the call after a delivery for a `DeliveryRouter`, and of the
/// gas of the hop from the router through it to the target. The test contract is the mediator of the router, so a test
/// calls `onTokenBridged` with exact gas.
contract RouterCallerTest is Test {
    event CallFailed(address indexed target, address indexed recipient, uint256 gasGiven);

    DeliveryRouter internal router;
    RouterCaller internal caller;
    MockERC20 internal token;
    CallRecorder internal recorder;
    CallBurner internal burner;
    address internal reward = makeAddr("reward address");
    address internal failedDelivery = makeAddr("failed delivery address");
    address internal recipient = makeAddr("recipient");
    address internal attacker = makeAddr("attacker");

    function setUp() public {
        router = new DeliveryRouter(
            ITokenMediator(address(this)), IWETH(address(new MockWrappedNative())), reward, failedDelivery
        );
        caller = router.routerCaller();
        token = new MockERC20("Harness", "HRN");
        recorder = new CallRecorder();
        burner = new CallBurner();
        token.mint(recipient, 1);
    }

    /// @dev The packed data that the router gives its caller: the gas word, the 20 byte target, the call data.
    function _packed(uint256 gasAmount, address target, bytes memory callData) internal pure returns (bytes memory) {
        return abi.encodePacked(gasAmount, target, callData);
    }

    function _data(address target, uint256 callGas) internal view returns (bytes memory) {
        return bytes.concat(
            abi.encode(DeliveryRouter.FeeDirector(recipient, router.FIXED_FEE(), 0, 0, callGas)),
            abi.encodePacked(target),
            hex"01"
        );
    }

    function _payload(bytes memory data) internal view returns (bytes memory) {
        return abi.encodeCall(DeliveryRouter.onTokenBridged, (address(token), 100 ether, data));
    }

    /// @dev One callback with exactly `gasSupplied`, from a clean state: whether it finished, its error, and the number
    /// of `CallFailed` events with the call gas as `gasGiven`.
    function _attempt(bytes memory payload, uint256 gasSupplied, uint256 callGas)
        internal
        returns (bool finished, bytes memory error, uint256 failedWithItsGas)
    {
        uint256 snapshot = vm.snapshotState();
        token.mint(address(router), 100 ether);
        vm.recordLogs();
        (finished, error) = address(router).call{gas: gasSupplied}(payload);
        Vm.Log[] memory logs = vm.getRecordedLogs();
        for (uint256 i = 0; i < logs.length; i++) {
            if (logs[i].emitter != address(router) || logs[i].topics[0] != CallFailed.selector) continue;
            if (abi.decode(logs[i].data, (uint256)) == callGas) failedWithItsGas++;
        }
        vm.revertToState(snapshot);
    }

    /// @dev The least gas with which the callback finishes. Found by bisection.
    function _leastGasThatFinishes(bytes memory payload, uint256 low, uint256 high) internal returns (uint256) {
        while (low < high) {
            uint256 middle = (low + high) / 2;
            (bool done,,) = _attempt(payload, middle, 0);
            if (done) high = middle;
            else low = middle + 1;
        }
        return low;
    }

    // ------------------------------------------------------------------------------------------------ the contract

    /// Claim: the router creates its caller in its constructor, and the caller names that router. Shows: the caller
    /// has code, `router()` is the router, and a second router has another caller. Matters: the caller must serve one
    /// router only, and the deploy scripts read the pair back.
    function test_theRouterCreatesItsCallerAndTheCallerNamesIt() public {
        assertGt(address(caller).code.length, 0);
        assertEq(caller.router(), address(router));
        DeliveryRouter other = new DeliveryRouter(
            ITokenMediator(address(this)), IWETH(address(new MockWrappedNative())), reward, failedDelivery
        );
        assertNotEq(address(other.routerCaller()), address(caller), "one caller per router");
        assertEq(other.routerCaller().router(), address(other));
    }

    /// Claim: the caller refuses anyone but its router. Shows: a stranger, the attacker, and another router's caller
    /// each get `NotRouter` with their address, and the recorder is never called. Matters: a caller that anyone could
    /// use would be a second door to whatever it can reach.
    function test_theCallerRefusesAnyoneButItsRouter() public {
        bytes memory packed = _packed(100_000, address(recorder), hex"c0ffee");
        address[3] memory strangers = [address(this), attacker, address(0xBEEF)];
        for (uint256 i = 0; i < strangers.length; i++) {
            vm.prank(strangers[i]);
            (bool ok, bytes memory error) = address(caller).call(packed);
            assertFalse(ok);
            assertEq(error, abi.encodeWithSelector(RouterCaller.NotRouter.selector, strangers[i]));
        }
        assertEq(recorder.calls(), 0);
    }

    /// Claim: the caller takes no coin, even from its router. Shows: a call with value from the router reverts.
    /// Matters: the call after a delivery sends no native value, and the caller never holds coin of its own will.
    function test_theCallerTakesNoCoin() public {
        vm.deal(address(router), 1 ether);
        vm.prank(address(router));
        (bool ok,) = address(caller).call{value: 1}(_packed(100_000, address(recorder), ""));
        assertFalse(ok);
        assertEq(address(caller).balance, 0);
    }

    /// Claim: a call to the caller itself, named as the target, fails and the delivery stands. Shows: `CallFailed`
    /// names the caller with the call gas, and the recipient is paid. Matters: the caller must not be a way to call
    /// itself as its router.
    function test_aTargetEqualToTheCallerFails() public {
        uint256 callGas = 100_000;
        (bool finished,, uint256 failed) = _attempt(_payload(_data(address(caller), callGas)), 1_000_000, callGas);
        assertTrue(finished);
        assertEq(failed, 1, "CallFailed with the call gas");
    }

    // ------------------------------------------------------------------------------------------------ the gas of the hop

    /// Claim: through the hop the target still gets exactly its call gas, at the boundary and above it. Shows: with a
    /// burning target and a call gas of 200,000, one gas less than the least gas that finishes reverts the callback
    /// with `ExactGasCall.InsufficientGas` (from the caller, passed up by the router), and every gas from the least
    /// one to 7,000 above it finishes with one `CallFailed` that reports the call gas, never `CallOutOfGas`. Matters:
    /// too little gas must revert so the delivery can run again; a target that fails with its whole gas is the
    /// target's no, and the delivery completes.
    function test_theTargetGetsItsExactGasThroughTheHop() public {
        uint256 callGas = 200_000;
        bytes memory payload = _payload(_data(address(burner), callGas));
        uint256 least = _leastGasThatFinishes(payload, callGas, 1_000_000);

        (bool starved, bytes memory error,) = _attempt(payload, least - 1, callGas);
        assertFalse(starved);
        assertEq(bytes4(error), ExactGasCall.InsufficientGas.selector, "the check of the caller binds");

        for (uint256 supplied = least; supplied < least + 7_000; supplied += 7) {
            (bool finished,, uint256 failed) = _attempt(payload, supplied, callGas);
            assertTrue(finished, "past the boundary the callback finishes");
            assertEq(failed, 1, "with one CallFailed of the call gas");
        }
        emit log_named_uint("least callback gas, burning call of 200,000", least);
    }

    /// Claim: a recorder through the hop sees at most its call gas, and all of it but the dispatch. Shows: the gas at
    /// the first instruction of the recorder is at most the call gas and at most 100 less, at the least gas that
    /// finishes and with 5,000,000. Matters: exact means exact at both ends of the range of the deliverer.
    function test_aRecorderSeesItsCallGasThroughTheHop() public {
        uint256 callGas = 300_000;
        bytes memory payload = _payload(_data(address(recorder), callGas));
        uint256 least = _leastGasThatFinishes(payload, callGas, 1_000_000);
        uint256[2] memory supplies = [least, uint256(5_000_000)];
        for (uint256 i = 0; i < supplies.length; i++) {
            uint256 snapshot = vm.snapshotState();
            token.mint(address(router), 100 ether);
            (bool ok,) = address(router).call{gas: supplies[i]}(payload);
            assertTrue(ok);
            assertEq(recorder.lastCaller(), address(caller), "the caller makes the call");
            assertLe(recorder.gasAtEntry(), callGas);
            assertGe(recorder.gasAtEntry() + 100, callGas);
            vm.revertToState(snapshot);
        }
    }
}
