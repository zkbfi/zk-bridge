// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Vm} from "forge-std/Vm.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IERC20Errors} from "@openzeppelin/contracts/interfaces/draft-IERC6093.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {MockERC20} from "../../../src/mocks/MockERC20.sol";
import {DeliveryRouter} from "../../../src/hardened/mediator/DeliveryRouter.sol";
import {IWETH} from "../../../src/hardened/mediator/IWETH.sol";
import {ITokenMediator} from "../../../src/hardened/mediator/ITokenMediator.sol";
import {MediatorFixture, MockWrappedNative, DenyListToken, CoinRefuser} from "./utils/MediatorSupport.sol";
import {
    CallRecorder,
    CallReverter,
    CallBurner,
    ReentryTarget,
    TokenThief,
    BalanceProbeToken
} from "./utils/CallTargets.sol";

/// @notice Tests of the call that the delivery router makes after it paid the recipient. Most tests run the whole flow:
/// the mediator on chain B sends tokens to the router on chain A with a director, a target and call data, and the
/// router executes the message through the mock bridge. The tests with a harness call `onTokenBridged` directly, with
/// the test contract as the mediator of a second router, so the gas of the callback is exact.
contract DeliveryRouterCallTest is MediatorFixture {
    /// @dev One `CallFailed` event as a test reads it.
    struct FailedCall {
        address target;
        address recipient;
        uint256 gasGiven;
    }

    event CallFailed(address indexed target, address indexed recipient, uint256 gasGiven);
    event DeliveryFailed(
        address indexed token, address indexed recipient, uint256 amount, DeliveryRouter.Reason reason
    );

    MockWrappedNative internal weth;
    DeliveryRouter internal router;
    DeliveryRouter internal harnessRouter;
    MockERC20 internal harnessToken;
    CallRecorder internal recorder;
    address internal executor = makeAddr("executor");
    address internal reward = makeAddr("reward address");
    address internal failedDelivery = makeAddr("failed delivery address");
    address internal recipient = makeAddr("recipient");
    address internal attacker = makeAddr("attacker");

    function setUp() public override {
        super.setUp();
        weth = new MockWrappedNative();
        router = new DeliveryRouter(ITokenMediator(address(mediatorA)), IWETH(address(weth)), reward, failedDelivery);
        harnessRouter = new DeliveryRouter(ITokenMediator(address(this)), IWETH(address(weth)), reward, failedDelivery);
        harnessToken = new MockERC20("Harness", "HRN");
        recorder = new CallRecorder();
        // Warm up: the first message of a token deploys its copy on chain B.
        _enterChainB(tokenA, 500_000 ether);
        vm.deal(alice, 1_000 ether);
    }

    // ------------------------------------------------------------------------------------------------ helpers

    /// @dev Moves `amount` of a token that lives on chain A to alice on chain B, where she holds its copy.
    function _enterChainB(IERC20 token, uint256 amount) internal {
        vm.startPrank(alice);
        token.approve(address(mediatorA), type(uint256).max);
        mediatorA.relayTokens(address(token), alice, amount);
        vm.stopPrank();
        _deliverAtoB(_lastIndexA());
        address copy = _copyOf(address(token));
        vm.prank(alice);
        IERC20(copy).approve(address(mediatorB), type(uint256).max);
    }

    function _director(uint256 settings, uint256 limit, uint256 multiplier)
        internal
        view
        returns (DeliveryRouter.FeeDirector memory)
    {
        return DeliveryRouter.FeeDirector(recipient, settings, limit, multiplier);
    }

    /// @dev The data of `onTokenBridged` with a call: the director, the 20 byte target and the call data.
    function _withCall(DeliveryRouter.FeeDirector memory director, address target, bytes memory callData)
        internal
        pure
        returns (bytes memory)
    {
        return bytes.concat(abi.encode(director), abi.encodePacked(target), callData);
    }

    /// @dev Chain B to the router on chain A. Returns the index of the message.
    function _sendBack(IERC20 nativeOnA, bytes memory data, uint256 value) internal returns (uint256) {
        address copy = _copyOf(address(nativeOnA));
        vm.prank(alice);
        mediatorB.relayTokensAndCall(copy, address(router), value, data);
        return _lastIndexB();
    }

    function _execute(uint256 index) internal {
        vm.prank(executor, executor);
        router.executeMessage(ambA.proofOf(ambB, index));
    }

    /// @dev Sends `data` with `tokenA`, executes it through the router, and returns the logs of the execution.
    function _run(bytes memory data, uint256 value) internal returns (Vm.Log[] memory) {
        uint256 index = _sendBack(tokenA, data, value);
        vm.recordLogs();
        _execute(index);
        return vm.getRecordedLogs();
    }

    function _failedCalls(Vm.Log[] memory logs, address emitter) internal pure returns (FailedCall[] memory found) {
        uint256 count;
        for (uint256 i = 0; i < logs.length; i++) {
            if (_matchesCallFailed(logs[i], emitter)) count++;
        }
        found = new FailedCall[](count);
        uint256 next;
        for (uint256 i = 0; i < logs.length; i++) {
            if (!_matchesCallFailed(logs[i], emitter)) continue;
            found[next++] = FailedCall(
                address(uint160(uint256(logs[i].topics[1]))),
                address(uint160(uint256(logs[i].topics[2]))),
                abi.decode(logs[i].data, (uint256))
            );
        }
    }

    function _matchesCallFailed(Vm.Log memory entry, address emitter) private pure returns (bool) {
        return entry.emitter == emitter && entry.topics.length == 3 && entry.topics[0] == CallFailed.selector;
    }

    function _failedCalls(Vm.Log[] memory logs) internal view returns (FailedCall[] memory) {
        return _failedCalls(logs, address(router));
    }

    function _deliveryFailedCount(Vm.Log[] memory logs) internal view returns (uint256 count) {
        for (uint256 i = 0; i < logs.length; i++) {
            if (logs[i].emitter == address(router) && logs[i].topics[0] == DeliveryFailed.selector) count++;
        }
    }

    // ---- harness: the test contract is the mediator of `harnessRouter`

    /// @dev Calls `onTokenBridged` on the harness router with exactly `gasSupplied`. The router gets the tokens first.
    function _harnessDeliver(bytes memory data, uint256 value, uint256 gasSupplied) internal returns (bool succeeded) {
        harnessToken.mint(address(harnessRouter), value);
        bytes memory payload = abi.encodeCall(DeliveryRouter.onTokenBridged, (address(harnessToken), value, data));
        (succeeded,) = address(harnessRouter).call{gas: gasSupplied}(payload);
    }

    /// @dev Marks a router delivery in the harness router, with `startingGas` as the stored starting gas.
    function _markRouterDelivery(uint256 startingGas) internal {
        vm.store(address(harnessRouter), harnessRouter.DELIVERY_SLOT(), bytes32(startingGas));
    }

    /// @dev One run of the harness at `gasSupplied` from a clean state: whether it succeeded, the `CallFailed` events,
    /// the tokens of `recipient` and the calls that `recorder` saw.
    function _probe(bytes memory data, uint256 value, uint256 gasSupplied)
        internal
        returns (bool succeeded, FailedCall[] memory failures, uint256 recipientTokens, uint256 recorderCalls)
    {
        uint256 snapshot = vm.snapshotState();
        vm.recordLogs();
        succeeded = _harnessDeliver(data, value, gasSupplied);
        failures = _failedCalls(vm.getRecordedLogs(), address(harnessRouter));
        recipientTokens = harnessToken.balanceOf(recipient);
        recorderCalls = recorder.calls();
        vm.revertToState(snapshot);
    }

    /// @dev The tip of a gas based run of the harness, in units of the gas price, and the tokens of the recipient.
    function _harnessTip(bytes memory data, uint256 value, uint256 gasSupplied, uint256 startingGas)
        internal
        returns (uint256 tipInGas, uint256 toRecipient)
    {
        uint256 snapshot = vm.snapshotState();
        _markRouterDelivery(startingGas);
        assertTrue(_harnessDeliver(data, value, gasSupplied), "the harness delivery succeeds");
        tipInGas = harnessToken.balanceOf(reward) / tx.gasprice;
        assertEq(harnessToken.balanceOf(reward) % tx.gasprice, 0, "the tip is whole gas prices");
        toRecipient = harnessToken.balanceOf(recipient);
        assertEq(harnessToken.balanceOf(address(harnessRouter)), 0, "the harness router keeps nothing");
        vm.revertToState(snapshot);
    }

    // ------------------------------------------------------------------------------------------------ 1. success

    /// Claim: after the payment the router calls the target with exactly the call data, from itself, with no coin.
    /// Shows: the recorder holds the exact bytes, the caller is the router, the value is zero, the target is not the
    /// recipient, the tip and the payment are exact, and no `CallFailed` event exists. Matters: a call that changes
    /// the bytes, the sender or the value breaks every integration that relies on the call.
    function test_aCallReachesTheTargetWithTheExactBytesFromTheRouterWithNoCoin() public {
        bytes memory callData = hex"deadbeef00112233445566778899";
        Vm.Log[] memory logs =
            _run(_withCall(_director(router.FIXED_FEE(), 3 ether, 0), address(recorder), callData), 100 ether);

        assertNotEq(address(recorder), recipient, "the target is not the recipient");
        assertEq(recorder.calls(), 1, "one call");
        assertEq(recorder.lastData(), callData, "the exact call data");
        assertEq(recorder.lastCaller(), address(router), "the router makes the call");
        assertEq(recorder.lastValue(), 0, "no coin");
        assertEq(tokenA.balanceOf(reward), 3 ether, "the tip");
        assertEq(tokenA.balanceOf(recipient), 97 ether, "the payment");
        assertEq(tokenA.balanceOf(address(recorder)), 0, "the target gets no token");
        assertEq(tokenA.balanceOf(address(router)), 0, "the router keeps nothing");
        assertEq(_failedCalls(logs).length, 0, "no CallFailed");
    }

    // ------------------------------------------------------------------------------------------------ 2. revert

    /// Claim: a target that reverts yields `CallFailed` with the gas that the call got, and the delivery stands.
    /// Shows: the event carries the target, the recipient and a gas figure that the same delivery repeats exactly with
    /// a second reverting target at the same state, and the tip, the payment and the empty router stand. Matters: the
    /// event is the only trace of a failed call, so its arguments must be exact.
    function test_aRevertingTargetEmitsCallFailedAndTheDeliveryStands() public {
        CallReverter first = new CallReverter();
        CallReverter second = new CallReverter();
        bytes memory callData = hex"c0ffee";
        DeliveryRouter.FeeDirector memory director = _director(router.FIXED_FEE(), 3 ether, 0);
        uint256 index = _sendBack(tokenA, _withCall(director, address(first), callData), 100 ether);
        uint256 secondIndex = _sendBack(tokenA, _withCall(director, address(second), callData), 100 ether);

        uint256 snapshot = vm.snapshotState();
        vm.recordLogs();
        _execute(index);
        FailedCall[] memory failures = _failedCalls(vm.getRecordedLogs());
        assertEq(failures.length, 1, "one CallFailed");
        assertEq(failures[0].target, address(first));
        assertEq(failures[0].recipient, recipient);
        assertGt(failures[0].gasGiven, 10_000, "the call got the gas that was left");
        assertEq(tokenA.balanceOf(reward), 3 ether, "the tip stands");
        assertEq(tokenA.balanceOf(recipient), 97 ether, "the payment stands");
        assertEq(tokenA.balanceOf(address(router)), 0, "the router keeps nothing");

        // The same state with a second target must repeat the figure, so the figure is a function of the state.
        vm.revertToState(snapshot);
        vm.expectEmit(true, true, false, true, address(router));
        emit CallFailed(address(second), recipient, failures[0].gasGiven);
        _execute(secondIndex);
        assertEq(tokenA.balanceOf(recipient), 97 ether);
    }

    /// Claim: `gasGiven` is the gas left at the call less the reserve, and the target sees it. Shows: in the harness at
    /// 500,000 gas (below the 63/64 limit, which binds above 640,000), a recorder sees at its first instruction a figure
    /// that is at most 100 gas below the `gasGiven` that a reverting target at the same state reports. The few gas
    /// between come from the dispatch of the fallback function before it reads the gas. Matters: it proves the event
    /// reports what the call got, and not a different number.
    function test_theGasGivenOfAFailedCallIsWhatTheTargetSees() public {
        DeliveryRouter.FeeDirector memory director = _director(router.FIXED_FEE(), 3 ether, 0);
        bytes memory callData = hex"c0ffee";
        (bool ok,,, uint256 calls) = _probe(_withCall(director, address(recorder), callData), 100 ether, 500_000);
        assertTrue(ok);
        assertEq(calls, 1);
        // The probe restores the state, so read the recorder through a run that keeps it.
        uint256 snapshot = vm.snapshotState();
        _harnessDeliver(_withCall(director, address(recorder), callData), 100 ether, 500_000);
        uint256 gasSeen = recorder.gasAtEntry();
        vm.revertToState(snapshot);

        CallReverter reverter = new CallReverter();
        (bool reverterOk, FailedCall[] memory failures,,) =
            _probe(_withCall(director, address(reverter), callData), 100 ether, 500_000);
        assertTrue(reverterOk);
        assertEq(failures.length, 1);
        assertGe(failures[0].gasGiven, gasSeen, "the target never sees more than it was given");
        assertLe(failures[0].gasGiven - gasSeen, 100, "the dispatch before the first read costs a few gas");
        assertLe(failures[0].gasGiven, 500_000 - 10_000, "the reserve is held back");
    }

    /// Claim: the user call never gets more gas than the message limit, however much gas the deliverer supplies.
    /// Shows: a message with a limit of 1,000,000 executed with 9,000,000 gas lets the target see less than 1,000,000
    /// at its first instruction. Matters: the bound holds because the bridge calls the mediator with exactly the
    /// message limit and the user call runs inside that call. This test fails if a change ever gives the user call
    /// the gas of the deliverer instead.
    function test_theUserCallNeverGetsMoreThanTheMessageGasLimit() public {
        uint256 messageGasLimit = 1_000_000;
        bytes memory data = _withCall(_director(router.FIXED_FEE(), 3 ether, 0), address(recorder), hex"01");
        address copy = _copyOf(address(tokenA));
        vm.prank(alice);
        mediatorB.relayTokensAndCall(copy, address(router), 100 ether, data, messageGasLimit);
        uint256 index = _lastIndexB();
        assertEq(ambB.messageAt(index).gasLimit, messageGasLimit, "the message carries the limit");

        vm.prank(executor, executor);
        router.executeMessage{gas: 9_000_000}(ambA.proofOf(ambB, index));

        assertEq(recorder.calls(), 1, "the call ran");
        assertLt(recorder.gasAtEntry(), messageGasLimit, "the target sees less than the message limit");
    }

    // ------------------------------------------------------------------------------------------------ 3. burner

    /// Claim: a target that burns all its gas cannot stop the router. Shows: with a message gas limit of 5,000,000 and
    /// 20,000,000 supplied by the deliverer, the burner takes its gas, the router still pays the tip and the
    /// recipient, emits `CallFailed` with a gas figure above 4,000,000 and keeps no tokens. Matters: the one hostile
    /// target must not turn the delivery into a failure that strands the tokens.
    function test_aTargetThatBurnsAllItsGasLeavesTheDeliveryWhole() public {
        CallBurner burner = new CallBurner();
        bytes memory data = _withCall(_director(router.FIXED_FEE(), 3 ether, 0), address(burner), hex"01");
        address copy = _copyOf(address(tokenA));
        vm.prank(alice);
        mediatorB.relayTokensAndCall(copy, address(router), 100 ether, data, 5_000_000);
        uint256 index = _lastIndexB();

        vm.recordLogs();
        vm.prank(executor, executor);
        router.executeMessage{gas: 20_000_000}(ambA.proofOf(ambB, index));
        FailedCall[] memory failures = _failedCalls(vm.getRecordedLogs());

        assertEq(failures.length, 1);
        assertEq(failures[0].target, address(burner));
        assertEq(failures[0].recipient, recipient);
        assertGt(failures[0].gasGiven, 4_000_000, "the burner got a large amount");
        assertEq(tokenA.balanceOf(reward), 3 ether);
        assertEq(tokenA.balanceOf(recipient), 97 ether);
        assertEq(tokenA.balanceOf(address(router)), 0);
    }

    // ------------------------------------------------------------------------------------------------ 4. reentry

    /// Claim: a target that calls back into the router fails on each entry point with a distinct error, and the
    /// delivery stands. Shows: `executeMessage` gives `DeliveryInProgress`, `sweep` gives the guard error, and
    /// `onTokenBridged` gives `NotMediator` with the target as the caller; no `CallFailed` event exists, because the
    /// target caught them all. Matters: each entry point is a way to move or duplicate funds in the middle of a delivery.
    function test_aTargetThatCallsBackIntoTheRouterFailsOnEveryEntryPoint() public {
        ReentryTarget target = new ReentryTarget(router, address(tokenA), ReentryTarget.Mode.Catch);
        Vm.Log[] memory logs =
            _run(_withCall(_director(router.FIXED_FEE(), 3 ether, 0), address(target), hex"01"), 100 ether);

        assertEq(target.entries(), 1);
        assertEq(target.executeMessageFailure(), abi.encodeWithSelector(DeliveryRouter.DeliveryInProgress.selector));
        assertEq(target.sweepFailure(), abi.encodeWithSelector(ReentrancyGuard.ReentrancyGuardReentrantCall.selector));
        assertEq(
            target.onTokenBridgedFailure(), abi.encodeWithSelector(DeliveryRouter.NotMediator.selector, address(target))
        );
        assertEq(_failedCalls(logs).length, 0, "the target caught every failure");
        assertEq(tokenA.balanceOf(reward), 3 ether);
        assertEq(tokenA.balanceOf(recipient), 97 ether);
        assertEq(tokenA.balanceOf(address(router)), 0);
    }

    /// Claim: a target that does not catch the failure of its inner call reverts, and the router reports it. Shows:
    /// `CallFailed` with the exact target and recipient, and the delivery stands. Matters: an uncaught reentry attempt
    /// must not revert the delivery of an honest recipient.
    function test_aTargetThatDoesNotCatchTheReentryFailureCausesCallFailed() public {
        ReentryTarget target = new ReentryTarget(router, address(tokenA), ReentryTarget.Mode.Uncaught);
        Vm.Log[] memory logs =
            _run(_withCall(_director(router.FIXED_FEE(), 3 ether, 0), address(target), hex"01"), 100 ether);

        FailedCall[] memory failures = _failedCalls(logs);
        assertEq(failures.length, 1);
        assertEq(failures[0].target, address(target));
        assertEq(failures[0].recipient, recipient);
        assertEq(target.entries(), 0, "the revert rolled the entry back");
        assertEq(tokenA.balanceOf(reward), 3 ether);
        assertEq(tokenA.balanceOf(recipient), 97 ether);
        assertEq(tokenA.balanceOf(address(router)), 0);
    }

    // ------------------------------------------------------------------------------------------------ 5. theft

    /// Claim: a target cannot pull tokens from the router with `transferFrom`, because the router grants no allowance.
    /// Shows: with 10 tokens stray in the router, the thief fails with the exact allowance error (spender is the
    /// thief, allowance 0, needed 10), the attacker gets nothing, and the stray tokens stay. Matters: the call comes
    /// from the router, so an allowance of the router would hand its tokens to any target.
    function test_aTargetCannotPullTokensFromTheRouterWithTransferFrom() public {
        uint256 stray = 10 ether;
        tokenA.mint(address(router), stray);
        TokenThief thief = new TokenThief(IERC20(address(tokenA)), address(router), attacker, stray);
        _run(_withCall(_director(router.FIXED_FEE(), 3 ether, 0), address(thief), hex"01"), 100 ether);

        assertEq(thief.attempts(), 1);
        assertFalse(thief.transferred());
        assertEq(
            thief.failure(),
            abi.encodeWithSelector(IERC20Errors.ERC20InsufficientAllowance.selector, address(thief), 0, stray)
        );
        assertEq(tokenA.balanceOf(attacker), 0);
        assertEq(tokenA.balanceOf(address(router)), stray, "only the stray tokens remain");
        assertEq(tokenA.balanceOf(reward), 3 ether);
        assertEq(tokenA.balanceOf(recipient), 97 ether);
    }

    /// Claim: a call to the token itself can move only what the router holds after the payments, which is the stray
    /// balance. Shows: with a stray balance S, a user call `transfer(attacker, S)` to the token moves exactly S, the
    /// token saw a router balance of exactly S at that moment (the delivery value was gone), the tip and the payment
    /// are exact, and the router ends empty. Matters: this bounds what a call can reach, and it shows that the value of
    /// the delivery itself is never reachable.
    function test_aCallToTheTokenMovesTheStrayBalanceAndNeverTheDeliveryValue() public {
        BalanceProbeToken probe = new BalanceProbeToken();
        probe.mint(alice, 1_000 ether);
        _enterChainB(IERC20(address(probe)), 500 ether);
        uint256 stray = 7 ether;
        probe.mint(address(router), stray);
        probe.watch(attacker);

        bytes memory data = _withCall(
            _director(router.FIXED_FEE(), 3 ether, 0),
            address(probe),
            abi.encodeCall(IERC20.transfer, (attacker, stray))
        );
        uint256 index = _sendBack(IERC20(address(probe)), data, 100 ether);
        vm.recordLogs();
        _execute(index);

        assertEq(_failedCalls(vm.getRecordedLogs()).length, 0, "the call succeeded");
        assertEq(probe.watchedTransfers(), 1);
        assertEq(probe.senderBalanceAtWatchedTransfer(), stray, "the router held only the stray balance");
        assertEq(probe.balanceOf(attacker), stray);
        assertEq(probe.balanceOf(reward), 3 ether);
        assertEq(probe.balanceOf(recipient), 97 ether);
        assertEq(probe.balanceOf(address(router)), 0);
    }

    /// Claim: a call to the mediator cannot pull the tokens of the router, because the router approves the mediator
    /// for nothing at rest. Shows: `relayTokens` of the stray balance fails (`CallFailed`), no bridge message is sent,
    /// the attacker gets nothing, and the stray tokens stay. Matters: the constructor of an older router approved the
    /// mediator without limit, which let any call spend the balance.
    function test_aCallToTheMediatorCannotRelayTheTokensOfTheRouter() public {
        uint256 stray = 7 ether;
        tokenA.mint(address(router), stray);
        uint256 sentBefore = ambA.sentCount();
        bytes memory data = _withCall(
            _director(router.FIXED_FEE(), 3 ether, 0),
            address(mediatorA),
            abi.encodeWithSignature("relayTokens(address,address,uint256)", address(tokenA), attacker, stray)
        );
        Vm.Log[] memory logs = _run(data, 100 ether);

        FailedCall[] memory failures = _failedCalls(logs);
        assertEq(failures.length, 1);
        assertEq(failures[0].target, address(mediatorA));
        assertEq(failures[0].recipient, recipient);
        assertEq(ambA.sentCount(), sentBefore, "no message left");
        assertEq(tokenA.balanceOf(address(router)), stray);
        assertEq(tokenA.balanceOf(attacker), 0);
        assertEq(tokenA.balanceOf(recipient), 97 ether);
    }

    /// Claim: after the wrap entry point the router holds no allowance for the mediator. Shows: the allowance of the
    /// wrapped token from the router to the mediator is zero and one message was sent. Matters: the allowance of one
    /// wrap ends at zero because the mediator takes all of it.
    function test_theAllowanceFromTheRouterToTheMediatorIsZeroAfterAWrap() public {
        uint256 sentBefore = ambA.sentCount();
        router.wrapAndRelayTokens{value: 1 ether}(bob);
        assertEq(ambA.sentCount(), sentBefore + 1);
        assertEq(weth.allowance(address(router), address(mediatorA)), 0);
        assertEq(weth.balanceOf(address(router)), 0);
    }

    /// Claim: the call to the router itself fails. Shows: the router calls `sweep` on itself while it holds the
    /// guard, the call fails, `CallFailed` names the router, and the stray tokens stay. Matters: a target equal to the
    /// router must not reach the router entry points with the router as the caller.
    function test_aTargetEqualToTheRouterFails() public {
        uint256 stray = 7 ether;
        tokenA.mint(address(router), stray);
        bytes memory data = _withCall(
            _director(router.FIXED_FEE(), 3 ether, 0),
            address(router),
            abi.encodeCall(DeliveryRouter.sweep, (address(tokenA)))
        );
        FailedCall[] memory failures = _failedCalls(_run(data, 100 ether));

        assertEq(failures.length, 1);
        assertEq(failures[0].target, address(router));
        assertEq(failures[0].recipient, recipient);
        assertEq(tokenA.balanceOf(failedDelivery), 0, "nothing was swept");
        assertEq(tokenA.balanceOf(address(router)), stray);
        assertEq(tokenA.balanceOf(recipient), 97 ether);
    }

    // ------------------------------------------------------------------------------------------------ 6. skips

    /// Claim: when the token refuses the recipient the amount is handed off and the call is skipped. Shows: with the
    /// recipient on the deny list, `DeliveryFailed` carries `PayoutRefused` and the exact amount, the failed delivery
    /// address gets it, the recorder is never called, and no `CallFailed` event exists. Matters: a call after a failed
    /// payment would act on a delivery that did not happen.
    function test_aRefusedPayoutHandsOffAndSkipsTheCall() public {
        DenyListToken denying = new DenyListToken();
        denying.mint(alice, 1_000 ether);
        _enterChainB(IERC20(address(denying)), 500 ether);
        denying.setDenied(recipient, true);
        bytes memory data = _withCall(_director(router.FIXED_FEE(), 3 ether, 0), address(recorder), hex"01");
        uint256 index = _sendBack(IERC20(address(denying)), data, 100 ether);

        vm.recordLogs();
        vm.expectEmit(true, true, false, true, address(router));
        emit DeliveryFailed(address(denying), recipient, 97 ether, DeliveryRouter.Reason.PayoutRefused);
        _execute(index);
        Vm.Log[] memory logs = vm.getRecordedLogs();

        assertEq(recorder.calls(), 0, "the target was not called");
        assertEq(_failedCalls(logs).length, 0, "no CallFailed");
        assertEq(denying.balanceOf(failedDelivery), 97 ether);
        assertEq(denying.balanceOf(reward), 3 ether);
        assertEq(denying.balanceOf(recipient), 0);
        assertEq(denying.balanceOf(address(router)), 0);
    }

    /// Claim: a recipient that is the zero address gets a hand-off, and the call is skipped. Shows: `DeliveryFailed`
    /// with `InvalidTerms`, the zero address and 97 tokens; the recorder is not called; no `CallFailed`. Matters: the
    /// terms are invalid, so nothing the sender asked for after the payment may run.
    function test_aZeroRecipientHandsOffAndSkipsTheCall() public {
        DeliveryRouter.FeeDirector memory director =
            DeliveryRouter.FeeDirector(address(0), router.FIXED_FEE(), 3 ether, 0);
        uint256 index = _sendBack(tokenA, _withCall(director, address(recorder), hex"01"), 100 ether);

        vm.recordLogs();
        vm.expectEmit(true, true, false, true, address(router));
        emit DeliveryFailed(address(tokenA), address(0), 97 ether, DeliveryRouter.Reason.InvalidTerms);
        _execute(index);

        assertEq(recorder.calls(), 0);
        assertEq(_failedCalls(vm.getRecordedLogs()).length, 0);
        assertEq(tokenA.balanceOf(failedDelivery), 97 ether);
        assertEq(tokenA.balanceOf(reward), 3 ether);
    }

    /// Claim: a tip that takes the whole value skips the call. Shows: the reward address gets 100, the recipient 0,
    /// the recorder is not called, and there is no `CallFailed`. Matters: the recipient was not paid, so the call that
    /// follows a payment has no payment to follow.
    function test_aTipThatTakesTheWholeValueSkipsTheCall() public {
        Vm.Log[] memory logs =
            _run(_withCall(_director(router.FIXED_FEE(), 100 ether, 0), address(recorder), hex"01"), 100 ether);

        assertEq(recorder.calls(), 0);
        assertEq(_failedCalls(logs).length, 0);
        assertEq(tokenA.balanceOf(reward), 100 ether);
        assertEq(tokenA.balanceOf(recipient), 0);
        assertEq(_deliveryFailedCount(logs), 0, "this is no failure");
    }

    // ------------------------------------------------------------------------------------------------ 7. native

    function _enterChainBWithWrapped(uint256 amount) internal {
        vm.startPrank(alice);
        weth.deposit{value: amount}();
        vm.stopPrank();
        _enterChainB(IERC20(address(weth)), amount);
    }

    /// Claim: with `UNWRAP` the router pays the coin and then calls the target. Shows: the recipient holds the exact
    /// coin (5 less the tip of 0.4), the reward address holds the coin tip, the recorder got the exact bytes from the
    /// router, and the router holds no coin and no token. Matters: the call follows the payment in the coin path too.
    function test_anUnwrappedPaymentIsFollowedByTheCall() public {
        _enterChainBWithWrapped(50 ether);
        bytes memory callData = hex"aabbccdd";
        bytes memory data =
            _withCall(_director(router.FIXED_FEE() | router.UNWRAP(), 0.4 ether, 0), address(recorder), callData);
        uint256 index = _sendBack(IERC20(address(weth)), data, 5 ether);
        vm.recordLogs();
        _execute(index);

        assertEq(_failedCalls(vm.getRecordedLogs()).length, 0);
        assertEq(recipient.balance, 4.6 ether);
        assertEq(reward.balance, 0.4 ether);
        assertEq(recorder.calls(), 1);
        assertEq(recorder.lastData(), callData);
        assertEq(recorder.lastCaller(), address(router));
        assertEq(recorder.lastValue(), 0);
        assertEq(address(router).balance, 0);
        assertEq(weth.balanceOf(address(router)), 0);
    }

    /// Claim: a recipient that refuses the coin but takes the wrapped token counts as paid, and the call runs. Shows:
    /// the refuser holds the wrapped token (4.6), no hand-off event exists, and the recorder got the call. Matters: the
    /// payment succeeded, so the sender gets the call that it asked for.
    function test_aRecipientThatTakesOnlyTheWrappedTokenStillGetsTheCall() public {
        _enterChainBWithWrapped(50 ether);
        address refuser = address(new CoinRefuser());
        DeliveryRouter.FeeDirector memory director =
            DeliveryRouter.FeeDirector(refuser, router.FIXED_FEE() | router.UNWRAP(), 0.4 ether, 0);
        uint256 index = _sendBack(IERC20(address(weth)), _withCall(director, address(recorder), hex"01"), 5 ether);
        vm.recordLogs();
        _execute(index);
        Vm.Log[] memory logs = vm.getRecordedLogs();

        assertEq(weth.balanceOf(refuser), 4.6 ether, "paid as the wrapped token");
        assertEq(refuser.balance, 0);
        assertEq(reward.balance, 0.4 ether);
        assertEq(_deliveryFailedCount(logs), 0, "no hand-off");
        assertEq(recorder.calls(), 1, "the call ran");
        assertEq(_failedCalls(logs).length, 0);
        assertEq(address(router).balance, 0);
    }

    // ------------------------------------------------------------------------------------------------ 8. gas tip

    /// Claim: a gas based tip counts the call. Shows: in the harness with 600,000 gas supplied and a stored starting
    /// gas of 2,000,000, a delivery with a call has the tip (starting gas less the reserve) times the gas price, which
    /// does not depend on the gas that ran before the measure, and a delivery without a call has a smaller tip by
    /// exactly the gas that the allowance adds. Matters: the call runs after the tip, so the tip must pay for it.
    function test_aGasBasedTipCountsTheGasThatTheCallMayUse() public {
        vm.txGasPrice(10 gwei);
        uint256 startingGas = 2_000_000;
        uint256 supplied = 600_000;
        DeliveryRouter.FeeDirector memory director = _director(0, 100 ether, 1 ether);

        (uint256 tipNone, uint256 paidNone) = _harnessTip(abi.encode(director), 100 ether, supplied, startingGas);
        (uint256 tipWith, uint256 paidWith) =
            _harnessTip(_withCall(director, address(recorder), hex"01"), 100 ether, supplied, startingGas);

        uint256 overhead = harnessRouter.TOKEN_GAS_OVERHEAD();
        uint256 reserve = harnessRouter.CALL_GAS_RESERVE();
        assertEq(tipWith, startingGas - reserve, "the tip with a call is the starting gas less the reserve");
        // Without a call: tip = startingGas - gasLeft + overhead. The gas left at the measure is below the supplied gas.
        uint256 gasLeftAtMeasure = startingGas + overhead - tipNone;
        assertLt(gasLeftAtMeasure, supplied, "the measure runs after the entry");
        assertGt(gasLeftAtMeasure, supplied - 20_000, "the entry costs less than 20,000 gas");
        assertEq(
            tipWith - tipNone,
            gasLeftAtMeasure - overhead - reserve,
            "the call adds the gas left at the measure less the overhead and the reserve"
        );
        assertEq(paidNone, 100 ether - tipNone * 10 gwei);
        assertEq(paidWith, 100 ether - tipWith * 10 gwei);
    }

    /// Claim: the tip counts the gas that the call may use, not the gas that it used. Shows: a burning target and a
    /// quiet target give the same tip, equal to the starting gas less the reserve times the gas price. Matters: a
    /// target cannot change the tip, up or down.
    function test_aBurningTargetAndAQuietTargetGiveTheSameTip() public {
        vm.txGasPrice(10 gwei);
        uint256 startingGas = 2_000_000;
        DeliveryRouter.FeeDirector memory director = _director(0, 100 ether, 1 ether);
        CallBurner burner = new CallBurner();

        (uint256 tipQuiet,) =
            _harnessTip(_withCall(director, address(recorder), hex"01"), 100 ether, 600_000, startingGas);
        (uint256 tipBurning, uint256 paidBurning) =
            _harnessTip(_withCall(director, address(burner), hex"01"), 100 ether, 600_000, startingGas);

        assertEq(tipBurning, tipQuiet);
        assertEq(tipBurning, startingGas - harnessRouter.CALL_GAS_RESERVE());
        assertEq(paidBurning, 100 ether - tipBurning * 10 gwei, "the recipient is paid before the burn");
    }

    /// Claim: when the gas left at the measure is below the overhead and the reserve, the allowance is zero. Shows: with
    /// 115,000 gas supplied, the tip in gas units is above the starting gas less the reserve by exactly the shortfall
    /// of the gas left against the held gas (110,000). Matters: the allowance never underflows.
    function test_aTipWithLittleGasLeftAddsNoAllowance() public {
        vm.txGasPrice(10 gwei);
        uint256 supplied = 115_000;
        DeliveryRouter.FeeDirector memory director = _director(0, 100 ether, 1 ether);
        (uint256 tipWith,) = _harnessTip(_withCall(director, address(recorder), hex"01"), 100 ether, supplied, supplied);

        uint256 held = harnessRouter.TOKEN_GAS_OVERHEAD() + harnessRouter.CALL_GAS_RESERVE();
        // With an allowance the tip would be supplied - reserve. With none it is supplied - gasLeft + overhead.
        assertGt(tipWith, supplied - harnessRouter.CALL_GAS_RESERVE(), "no allowance was added");
        uint256 gasLeftAtMeasure = supplied + harnessRouter.TOKEN_GAS_OVERHEAD() - tipWith;
        assertLe(gasLeftAtMeasure, held, "the gas left was below the held gas");
        assertGt(gasLeftAtMeasure, held - 20_000);
    }

    // ------------------------------------------------------------------------------------------------ 9. edges

    /// Claim: 1 to 19 bytes after the director make no call. Shows: for each length, a tail made of the first bytes of
    /// the recorder address delivers the payment and the recorder is never called. Matters: a short tail is no
    /// target, and the router must not read past it.
    function test_aTailShorterThanATargetMakesNoCall() public {
        bytes memory address20 = abi.encodePacked(address(recorder));
        for (uint256 length = 1; length < 20; length++) {
            bytes memory tail = new bytes(length);
            for (uint256 i = 0; i < length; i++) {
                tail[i] = address20[i];
            }
            bytes memory data = bytes.concat(abi.encode(_director(router.FIXED_FEE(), 1 ether, 0)), tail);
            Vm.Log[] memory logs = _run(data, 10 ether);
            assertEq(_failedCalls(logs).length, 0);
            assertEq(tokenA.balanceOf(recipient), 9 ether * length, "each delivery pays 9");
        }
        assertEq(recorder.calls(), 0);
        assertEq(tokenA.balanceOf(reward), 19 ether);
    }

    /// Claim: a target with no call data makes a call with empty data. Shows: 148 bytes of data make one call, and the
    /// recorder sees empty call data from the router. Matters: the call data may be empty, and the call still runs.
    function test_aTargetWithNoCallDataMakesACallWithEmptyData() public {
        Vm.Log[] memory logs =
            _run(_withCall(_director(router.FIXED_FEE(), 1 ether, 0), address(recorder), ""), 10 ether);

        assertEq(_failedCalls(logs).length, 0);
        assertEq(recorder.calls(), 1);
        assertEq(recorder.lastData().length, 0);
        assertEq(recorder.lastCaller(), address(router));
        assertEq(tokenA.balanceOf(recipient), 9 ether);
    }

    /// Claim: the legacy form of 20 bytes makes no call. Shows: the receiver gets the whole value as the token, and a
    /// receiver that is the recorder is not called. Matters: the legacy data names a receiver, never a target.
    function test_theLegacyFormMakesNoCall() public {
        uint256 index = _sendBack(tokenA, abi.encodePacked(address(recorder)), 10 ether);
        vm.recordLogs();
        _execute(index);

        assertEq(_failedCalls(vm.getRecordedLogs()).length, 0);
        assertEq(recorder.calls(), 0);
        assertEq(tokenA.balanceOf(address(recorder)), 10 ether);
    }

    /// Claim: a direct delivery, without the router, pays the recipient everything and still makes the call. Shows:
    /// the bridge executes the message, the recipient gets 100 with no tip, and the recorder got the exact bytes from
    /// the router. Matters: the bridge stays permissionless, and the call does not need the router to start it.
    function test_aDirectDeliveryTakesNoTipAndStillMakesTheCall() public {
        bytes memory callData = hex"0102030405";
        uint256 index = _sendBack(
            tokenA, _withCall(_director(router.FIXED_FEE(), 3 ether, 0), address(recorder), callData), 100 ether
        );
        vm.recordLogs();
        _deliverBtoA(index);

        assertEq(_failedCalls(vm.getRecordedLogs()).length, 0);
        assertEq(tokenA.balanceOf(recipient), 100 ether);
        assertEq(tokenA.balanceOf(reward), 0);
        assertEq(recorder.calls(), 1);
        assertEq(recorder.lastData(), callData);
        assertEq(recorder.lastCaller(), address(router));
    }

    /// @dev Whether a harness run at `gasSupplied` ends with an attempted call: it succeeded and the call got gas.
    function _callWasAttempted(bytes memory data, uint256 gasSupplied) internal returns (bool) {
        (bool succeeded, FailedCall[] memory failures,,) = _probe(data, 100 ether, gasSupplied);
        if (!succeeded) return false;
        if (failures.length == 0) return true;
        return failures[0].gasGiven != 0;
    }

    /// @dev The smallest supplied gas at which the call is attempted. Below it the call has no gas or the frame stops.
    function _smallestGasThatAttemptsTheCall(bytes memory data) internal returns (uint256) {
        uint256 low = 40_000;
        uint256 high = 400_000;
        assertTrue(_callWasAttempted(data, high), "the upper bound attempts the call");
        assertFalse(_callWasAttempted(data, low), "the lower bound does not");
        while (high - low > 1) {
            uint256 middle = (low + high) / 2;
            if (_callWasAttempted(data, middle)) high = middle;
            else low = middle;
        }
        return high;
    }

    /// Claim: with no gas to spare the router skips the call and says so. Shows: at the largest supplied gas below the
    /// threshold at which a call is attempted that still succeeds, `CallFailed` has `gasGiven` 0, the recorder is not
    /// called, and the recipient holds the whole value. Matters: the delivery must finish even when the deliverer gave
    /// too little gas for the call.
    function test_withNoSpareGasTheCallIsSkippedAndTheDeliveryStands() public {
        bytes memory data = _withCall(_director(router.FIXED_FEE(), 3 ether, 0), address(recorder), hex"01");
        uint256 threshold = _smallestGasThatAttemptsTheCall(data);

        bool found;
        for (uint256 step = 1; step <= 400 && !found; step++) {
            (bool succeeded, FailedCall[] memory failures, uint256 recipientTokens, uint256 recorderCalls) =
                _probe(data, 100 ether, threshold - step);
            if (!succeeded) continue;
            found = true;
            assertEq(failures.length, 1);
            assertEq(failures[0].target, address(recorder));
            assertEq(failures[0].recipient, recipient);
            assertEq(failures[0].gasGiven, 0, "no gas was given");
            assertEq(recorderCalls, 0);
            assertEq(recipientTokens, 100 ether, "the payment stands");
        }
        assertTrue(found, "a gas amount exists with a finished delivery and no spare gas");
    }

    /// Claim: the delivery never reverts for want of the gas of the call: every gas amount from the first that lets
    /// the frame finish upward finishes. Shows: the amount just below the threshold finishes with `gasGiven` 0, and
    /// the amount at the threshold attempts the call. Matters: the callback must never revert, because a revert
    /// strands the tokens in the router; a window of amounts that revert would let a deliverer force that.
    function test_noGasAmountNearTheReserveMakesTheCallbackRevert() public {
        bytes memory data = _withCall(_director(router.FIXED_FEE(), 3 ether, 0), address(recorder), hex"01");
        uint256 threshold = _smallestGasThatAttemptsTheCall(data);

        (bool succeeded, FailedCall[] memory failures,,) = _probe(data, 100 ether, threshold - 1);
        assertTrue(succeeded, "the amount below the threshold finishes");
        assertEq(failures.length, 1);
        assertEq(failures[0].gasGiven, 0);
        // Every amount in the window around the threshold finishes. The window is wider than the few gas that
        // separate two reads of the gas left, so a double read that underflows would show here.
        for (uint256 gasSupplied = threshold - 1_000; gasSupplied <= threshold + 100; gasSupplied++) {
            (bool finished,,,) = _probe(data, 100 ether, gasSupplied);
            assertTrue(finished, "every amount in the window finishes");
        }
    }

    /// Claim: a target equal to the mediator fails and moves nothing. Shows: a call to `handleBridgedTokens` on the
    /// mediator fails because the caller is not the remote mediator; `CallFailed` names the mediator and the router keeps
    /// its stray balance. Matters: the router must not become a way to speak as itself to the mediator.
    function test_aTargetEqualToTheMediatorFails() public {
        uint256 stray = 7 ether;
        tokenA.mint(address(router), stray);
        bytes memory data = _withCall(
            _director(router.FIXED_FEE(), 3 ether, 0),
            address(mediatorA),
            abi.encodeWithSignature("handleBridgedTokens(address,address,uint256)", address(tokenA), attacker, stray)
        );
        FailedCall[] memory failures = _failedCalls(_run(data, 100 ether));

        assertEq(failures.length, 1);
        assertEq(failures[0].target, address(mediatorA));
        assertEq(tokenA.balanceOf(attacker), 0);
        assertEq(tokenA.balanceOf(address(router)), stray);
    }
}
