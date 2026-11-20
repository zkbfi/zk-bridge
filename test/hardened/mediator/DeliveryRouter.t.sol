// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Vm} from "forge-std/Vm.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {MockERC20} from "../../mocks/MockERC20.sol";
import {DeliveryRouter} from "../../../src/hardened/mediator/DeliveryRouter.sol";
import {MessageBridge} from "../../../src/hardened/MessageBridge.sol";
import {Multicall3} from "../../../src/hardened/vendor/multicall3/Multicall3.sol";
import {IWETH} from "../../../src/hardened/mediator/IWETH.sol";
import {ITokenMediator} from "../../../src/hardened/mediator/ITokenMediator.sol";
import {
    MediatorFixture,
    MockAMB,
    MockWrappedNative,
    DenyListToken,
    CoinRefuser,
    GasBurner,
    CoinReverter,
    ContractWallet, TEST_CALLBACK_GAS} from "./utils/MediatorSupport.sol";
import {MedCutToken, SlotProbeToken} from "./utils/MedMocks.sol";
import {CallRecorder} from "./utils/CallTargets.sol";
import {TokenMediator} from "../../../src/hardened/mediator/TokenMediator.sol";

/// @notice Tests of the executor delivery router. Tokens flow from chain B to chain A, where the router lives. Anyone
/// executes the message through the router, and the reward address earns the tip that the sender wrote in the
/// `FeeDirector`.
contract DeliveryRouterTest is MediatorFixture {
    MockERC20 internal tokenB;
    MockWrappedNative internal weth;
    DeliveryRouter internal router;
    address internal executor = makeAddr("executor");
    address internal reward = makeAddr("reward address");
    address internal failedDelivery = makeAddr("failed delivery address");
    address internal recipient = makeAddr("recipient");

    function setUp() public override {
        super.setUp();
        weth = new MockWrappedNative();
        router = _routerFor(reward);
        tokenB = new MockERC20("Token B", "TKB");
        tokenB.mint(alice, 1_000_000 ether);
        // Warm up: the first message of a token deploys its copy. Later messages do not, so gas based fees stay small.
        vm.startPrank(alice);
        tokenB.approve(address(mediatorB), type(uint256).max);
        mediatorB.relayTokens(address(tokenB), alice, 1 ether);
        vm.stopPrank();
        _deliverBtoA(_lastIndexB());
        vm.deal(alice, 1_000 ether);
    }

    function _routerFor(address rewardAccount) internal returns (DeliveryRouter) {
        return
            new DeliveryRouter(ITokenMediator(address(mediatorA)), IWETH(address(weth)), rewardAccount, failedDelivery);
    }

    /// @dev A new router whose reward address is `account`. Call it before the message is sent: the sender names the
    /// router.
    function _useReward(address account) internal {
        router = _routerFor(account);
    }

    function _director(uint256 settings, uint256 limit, uint256 multiplier)
        internal
        view
        returns (DeliveryRouter.FeeDirector memory)
    {
        return DeliveryRouter.FeeDirector(recipient, settings, limit, multiplier, 0);
    }

    /// @dev Chain B to the router on chain A. Returns the index of the message.
    function _sendTokenB(DeliveryRouter.FeeDirector memory director, uint256 value) internal returns (uint256) {
        vm.prank(alice);
        mediatorB.relayTokensAndCall(address(tokenB), address(router), value, abi.encode(director), TEST_CALLBACK_GAS);
        return _lastIndexB();
    }

    /// @dev Sends a token message with `director`, and runs it through the router with exactly `gasSupplied`. It returns
    /// the tip of the reward address, the amount of the recipient and the gas that the message asks of the bridge (zero:
    /// the mediator asks for none), then restores the state. So every run starts
    /// from the same state, and two runs differ only in their inputs.
    function _runAtGas(DeliveryRouter.FeeDirector memory director, uint256 value, uint256 gasSupplied)
        internal
        returns (uint256 tip, uint256 toRecipient, uint256 forwardedGasLimit)
    {
        uint256 snapshot = vm.snapshotState();
        uint256 rewardBefore = _copyB().balanceOf(reward);
        uint256 recipientBefore = _copyB().balanceOf(recipient);
        uint256 index = _sendTokenB(director, value);
        forwardedGasLimit = ambB.messageAt(index).gasLimit;
        MessageBridge.MessageProof memory proof = ambA.proofOf(ambB, index);
        vm.prank(executor, executor);
        router.executeMessage{gas: gasSupplied}(proof);
        tip = _copyB().balanceOf(reward) - rewardBefore;
        toRecipient = _copyB().balanceOf(recipient) - recipientBefore;
        vm.revertToState(snapshot);
    }

    /// @dev An account with no special role delivers the message through the router.
    function _runThroughRouter(uint256 index) internal {
        MessageBridge.MessageProof memory proof = ambA.proofOf(ambB, index);
        vm.prank(executor, executor);
        router.executeMessage(proof);
    }

    function _copyB() internal view returns (IERC20) {
        return IERC20(mediatorA.bridgedTokenAddress(address(tokenB)));
    }

    /// @dev The callback gas base of `@zkb/core` (`ROUTER_CALLBACK_GAS_BASE`): what a frontend adds for the work of the
    /// router in `onTokenBridged`. The test below shows that it covers the costliest path of this router.
    uint256 internal constant CORE_ROUTER_CALLBACK_GAS_BASE = 300_000;

    /// Claim: the callback gas that `routerCallbackGas` of the core package recommends covers the costliest path of the
    /// router: a gas based tip with an unwrap, a reward address that refuses the native coin (its tip stays with the recipient)
    /// and a recipient that refuses it too (it gets the wrapped token after a failed send of 50,000 gas, to a new
    /// account), and a follow-up call
    /// of 200,000 gas to a target that writes fresh storage. Shows: a relay with exactly `base + callGas +
    /// ceil(callGas / 63) + CALL_GAS_RESERVE` delivers with no `CallbackFailed`, the call runs, and the recipient
    /// holds the whole value as the wrapped token; the least callback gas that runs this path (found by bisection) is
    /// at most the recommendation and less than 250,000 below it. The router work of this path is about 100,000 gas
    /// with a plain token; the base of 300,000 leaves room for tokens whose transfers cost more. Matters: a frontend that follows the core package never strands tokens in the
    /// router.
    function test_theCoreCallbackGasBaseCoversTheCostliestPathOfTheRouter() public {
        _costliestPathWithCallGas(200_000, 250_000);
    }

    /// Claim: the same recommendation covers the costliest path at the largest call gas, `MAX_CALL_GAS`, through the
    /// hop to `routerCaller`. Shows: with a call gas of 10,000,000, the recommended callback gas is
    /// `TokenMediator.MAX_CALLBACK_GAS` (10,468,731), the path delivers with it, and the least callback gas that runs
    /// it is logged with the room that is left. Matters: since 2026-11-18 (third round) the call goes out through
    /// `routerCaller`, a second call frame, so a second 63/64 share (about `callGas / 63`, 158,731 here) comes out of
    /// the 300,000 of router work in the formula; it is largest at the largest call gas.
    function test_theCoreCallbackGasCoversTheCostliestPathAtTheLargestCallGas() public {
        uint256 recommended = _costliestPathWithCallGas(router.MAX_CALL_GAS(), 250_000);
        assertEq(recommended, mediatorA.MAX_CALLBACK_GAS(), "the recommendation at the largest call gas");
    }

    /// @dev The costliest path of the router with a call of `callGas` (see the claim above), and the bisection of the
    /// least callback gas that runs it. Returns the recommended callback gas.
    function _costliestPathWithCallGas(uint256 callGas, uint256 maximumRoom) internal returns (uint256 recommended) {
        vm.txGasPrice(10 gwei);
        address refusingReward = address(new CoinRefuser());
        _useReward(refusingReward);
        address refusingRecipient = address(new CoinRefuser());
        CallRecorder target = new CallRecorder();
        DeliveryRouter.FeeDirector memory director =
            DeliveryRouter.FeeDirector(refusingRecipient, router.UNWRAP(), 1 ether, 1 ether, callGas);
        bytes memory data = bytes.concat(abi.encode(director), abi.encodePacked(address(target)), hex"c0ffee");
        recommended = CORE_ROUTER_CALLBACK_GAS_BASE + callGas + (callGas + 62) / 63 + router.CALL_GAS_RESERVE();

        uint256 snapshot = vm.snapshotState();
        uint256 index = _sendWrappedBackWithGas(5 ether, data, recommended);
        vm.recordLogs();
        _runThroughRouter(index);
        assertEq(_countOf(vm.getRecordedLogs(), TokenMediator.CallbackFailed.selector), 0, "the callback had its gas");
        assertEq(target.calls(), 1, "the call ran");
        assertEq(weth.balanceOf(refusingRecipient), 5 ether, "the recipient holds the wrapped token, tip included");
        assertEq(weth.balanceOf(refusingReward), 0, "a refused tip stays with the recipient");
        vm.revertToState(snapshot);

        uint256 low = callGas;
        uint256 high = recommended;
        while (low < high) {
            uint256 middle = (low + high) / 2;
            uint256 probe = vm.snapshotState();
            index = _sendWrappedBackWithGas(5 ether, data, middle);
            vm.recordLogs();
            _runThroughRouter(index);
            bool failed = _countOf(vm.getRecordedLogs(), TokenMediator.CallbackFailed.selector) != 0;
            vm.revertToState(probe);
            if (failed) low = middle + 1;
            else high = middle;
        }
        emit log_named_uint("call gas", callGas);
        emit log_named_uint("least callback gas of the costliest path", low);
        emit log_named_uint("recommended callback gas", recommended);
        emit log_named_uint("room", recommended - low);
        assertLe(low, recommended, "the recommendation covers the costliest path");
        assertLt(recommended - low, maximumRoom, "and asks for less than the room allowed more than it needs");
    }

    function _countOf(Vm.Log[] memory logs, bytes32 topic) internal pure returns (uint256 count) {
        for (uint256 i = 0; i < logs.length; i++) {
            if (logs[i].topics.length > 0 && logs[i].topics[0] == topic) count++;
        }
    }

    /// @dev `_sendWrappedBack` with raw data and a chosen callback gas.
    function _sendWrappedBackWithGas(uint256 value, bytes memory data, uint256 callbackGas) internal returns (uint256) {
        vm.startPrank(alice);
        weth.deposit{value: value}();
        weth.approve(address(mediatorA), type(uint256).max);
        vm.stopPrank();
        _bridgeAtoB(alice, address(weth), alice, value);
        address copy = _copyOf(address(weth));
        vm.startPrank(alice);
        IERC20(copy).approve(address(mediatorB), type(uint256).max);
        mediatorB.relayTokensAndCall(copy, address(router), value, data, callbackGas);
        vm.stopPrank();
        return _lastIndexB();
    }

    /// @dev Gives alice the copy of the wrapped token on chain B and sends it back to the router with a director.
    function _sendWrappedBack(DeliveryRouter.FeeDirector memory director, uint256 value, bytes memory data)
        internal
        returns (uint256)
    {
        vm.startPrank(alice);
        weth.deposit{value: value}();
        weth.approve(address(mediatorA), type(uint256).max);
        vm.stopPrank();
        _bridgeAtoB(alice, address(weth), alice, value);
        address copy = _copyOf(address(weth));
        vm.startPrank(alice);
        IERC20(copy).approve(address(mediatorB), type(uint256).max);
        mediatorB.relayTokensAndCall(copy, address(router), value, data.length == 0 ? abi.encode(director) : data, TEST_CALLBACK_GAS);
        vm.stopPrank();
        return _lastIndexB();
    }

    // ------------------------------------------------------------------------------------------------ fee modes

    function test_aFixedFeeGoesToTheRewardAddressAndTheRestToTheRecipient() public {
        uint256 index = _sendTokenB(_director(router.FIXED_FEE(), 3 ether, 0), 100 ether);
        _runThroughRouter(index);

        assertEq(_copyB().balanceOf(reward), 3 ether);
        assertEq(_copyB().balanceOf(recipient), 97 ether);
        assertEq(_copyB().balanceOf(address(router)), 0, "the router keeps nothing");
    }

    /// Claim: the router reads neither the origin nor the caller, so a generic Multicall3 batches deliveries from any
    /// account. Shows: through Multicall3, with a caller whose origin is the caller itself, the call succeeds, the
    /// reward address is paid the fixed tip, the recipient gets the rest, and the caller gets nothing. Matters: no
    /// batching contract and no origin rule are needed.
    function test_multicall3BatchesFromAnyAccountWithNoOriginRule() public {
        Multicall3 multicall = new Multicall3();
        DeliveryRouter.FeeDirector memory director = _director(router.FIXED_FEE(), 3 ether, 0);
        MessageBridge.MessageProof memory proof = ambA.proofOf(ambB, _sendTokenB(director, 100 ether));
        Multicall3.Call3[] memory calls = new Multicall3.Call3[](1);
        calls[0] = Multicall3.Call3(address(router), true, abi.encodeCall(DeliveryRouter.executeMessage, (proof)));

        vm.prank(bob, bob);
        Multicall3.Result[] memory results = multicall.aggregate3(calls);
        assertTrue(results[0].success);
        assertEq(_copyB().balanceOf(reward), 3 ether, "the reward address gets the tip");
        assertEq(_copyB().balanceOf(recipient), 97 ether);
        assertEq(_copyB().balanceOf(bob), 0, "the caller gets nothing");
        assertEq(_copyB().balanceOf(address(multicall)), 0, "Multicall3 gets nothing");
    }

    /// Claim: a copy of a delivery pays the same tip to the same address and gains the copier nothing. Shows: for a
    /// fixed tip and a multiplier tip, and for each of three accounts (each its own caller and origin, one of them the
    /// reward address, one the recipient), the reward address receives the identical tip, the recipient the identical
    /// rest, and the caller nothing. Matters: this is why the router needs no whitelist: a front-runner pays the gas and
    /// the tip stays put.
    function test_aCopyOfADeliveryFromAnyAccountPaysTheIdenticalTip() public {
        address[3] memory copiers = [bob, reward, recipient];
        DeliveryRouter.FeeDirector[2] memory directors =
            [_director(router.FIXED_FEE(), 3 ether, 0), _director(router.MULTIPLIER_OF_TOTAL(), 0, 0.03 ether)];
        for (uint256 i = 0; i < copiers.length; i++) {
            for (uint256 j = 0; j < directors.length; j++) {
                uint256 rewardBefore = _copyB().balanceOf(reward);
                uint256 recipientBefore = _copyB().balanceOf(recipient);
                MessageBridge.MessageProof memory proof = ambA.proofOf(ambB, _sendTokenB(directors[j], 100 ether));
                vm.prank(copiers[i], copiers[i]);
                router.executeMessage(proof);
                assertEq(_copyB().balanceOf(reward) - rewardBefore, 3 ether, "the identical tip");
                assertEq(_copyB().balanceOf(recipient) - recipientBefore, 97 ether, "the identical rest");
            }
        }
        assertEq(_copyB().balanceOf(bob), 0, "an outside copier gains nothing");
        assertEq(_copyB().balanceOf(address(router)), 0);
    }

    /// Claim: the caller and the origin may differ, and the tip still goes to the reward address. Matters: the router
    /// reads no `tx.origin`.
    function test_aCallerWithAnUnrelatedOriginDelivers() public {
        uint256 index = _sendTokenB(_director(router.FIXED_FEE(), 3 ether, 0), 100 ether);
        MessageBridge.MessageProof memory proof = ambA.proofOf(ambB, index);
        vm.prank(bob, carol);
        router.executeMessage(proof);
        assertEq(_copyB().balanceOf(reward), 3 ether);
        assertEq(_copyB().balanceOf(bob), 0);
        assertEq(_copyB().balanceOf(carol), 0);
    }

    function test_aShareOfTheValueGoesToTheRewardAddress() public {
        // The multiplier is scaled by 1e18: 0.02 is 2%.
        uint256 index = _sendTokenB(_director(router.MULTIPLIER_OF_TOTAL(), 0, 0.02 ether), 500 ether);
        _runThroughRouter(index);

        assertEq(_copyB().balanceOf(reward), 10 ether);
        assertEq(_copyB().balanceOf(recipient), 490 ether);
    }

    function test_theFixedModeWinsOverTheMultiplierOfTotalMode() public {
        uint256 index =
            _sendTokenB(_director(router.FIXED_FEE() | router.MULTIPLIER_OF_TOTAL(), 1 ether, 0.5 ether), 100 ether);
        _runThroughRouter(index);
        assertEq(_copyB().balanceOf(reward), 1 ether);
    }

    /// Claim: the gas based tip is the measured gas plus the token overhead, times the multiplier and the gas price.
    /// Shows: with the caller supplying exactly 3,500,000 gas, the tip is a whole number of gas prices, the measured gas
    /// is at most the supplied gas and at least the supplied gas less the callback gas of the relay, and 500,000 more
    /// supplied gas adds exactly 500,000 times the gas price. The message asks the bridge for no gas. The recipient gets
    /// the rest. Matters: the figure is exact, not a bound.
    function test_aGasBasedFeeUsesTheGasPriceAndTheMultiplier() public {
        vm.txGasPrice(10 gwei);
        DeliveryRouter.FeeDirector memory director = _director(0, 100 ether, 1 ether);
        (uint256 tip, uint256 toRecipient, uint256 messageGas) = _runAtGas(director, 1_000 ether, 3_500_000);

        assertEq(messageGas, 0, "the mediator asks the bridge for no gas");
        assertEq(tip % 10 gwei, 0, "the unit is the gas price");
        uint256 measuredGas = tip / 10 gwei - router.TOKEN_GAS_OVERHEAD();
        assertLe(measuredGas, 3_500_000, "the callback cannot measure more than the caller supplied");
        assertGe(measuredGas, 3_500_000 - TEST_CALLBACK_GAS, "the supplied gas less the gas of the callback");
        assertEq(toRecipient, 1_000 ether - tip, "the recipient gets the rest");

        (uint256 largerTip,,) = _runAtGas(director, 1_000 ether, 4_000_000);
        assertEq(largerTip - tip, 500_000 * 10 gwei, "each supplied gas unit adds one gas price");
    }

    /// Claim: a caller can raise a gas based tip by the gas that it supplies, up to the limit of the sender. Shows: the
    /// same delivery with a small and with a large gas amount gives two different tips, both at most the limit, and a
    /// third run with a very large amount ends at the limit. The callback runs with exactly the callback gas of the
    /// relay, while the bridge and the mediator keep the rest of the supplied gas, so `startingGas - gasleft()` in the
    /// callback also counts the gas that they keep. Matters: this is the residual of the design (it was the same when the
    /// bridge forwarded only the gas limit of the message), and it is bounded: the limit of the sender caps the tip, and
    /// the tip goes to the fixed reward address, so a stranger who raises it gains nothing. A frontend shows `limit` as
    /// the most that the fee can be.
    function test_aCallerCanRaiseAGasBasedTipByTheGasItSuppliesUpToTheLimit() public {
        vm.txGasPrice(10 gwei);
        uint256 limit = 0.1 ether;
        DeliveryRouter.FeeDirector memory director = _director(0, limit, 1 ether);

        (uint256 smallTip,,) = _runAtGas(director, 1_000 ether, 3_500_000);
        (uint256 largeTip,,) = _runAtGas(director, 1_000 ether, 8_000_000);
        (uint256 hugeTip, uint256 hugeToRecipient,) = _runAtGas(director, 1_000 ether, 50_000_000);

        emit log_named_uint("tip with 3,500,000 gas supplied", smallTip);
        emit log_named_uint("tip with 8,000,000 gas supplied", largeTip);
        assertGt(largeTip, smallTip, "more supplied gas raises the tip");
        assertLe(largeTip, limit, "the limit of the sender bounds it");
        assertEq(hugeTip, limit, "a very large amount of gas ends at the limit");
        assertEq(hugeToRecipient, 1_000 ether - limit, "the recipient keeps the rest");
    }

    function test_theMultiplierScalesAGasBasedFee() public {
        vm.txGasPrice(10 gwei);
        (uint256 feeOne,,) = _runAtGas(_director(0, 100 ether, 1 ether), 1_000 ether, 3_500_000);
        (uint256 feeTwo,,) = _runAtGas(_director(0, 100 ether, 2 ether), 1_000 ether, 3_500_000);
        assertEq(feeTwo, feeOne * 2, "the same gas, so doubling the multiplier doubles the tip");
    }

    function test_aGasBasedFeeIsCappedByTheLimit() public {
        vm.txGasPrice(10 gwei);
        (uint256 tip, uint256 toRecipient,) = _runAtGas(_director(0, 12_345, 1 ether), 1_000 ether, 3_500_000);
        assertEq(tip, 12_345, "capped");
        assertEq(toRecipient, 1_000 ether - 12_345);
    }

    /// Claim: a gas based tip never exceeds the smaller of the limit and the value. Shows: with a limit far above a
    /// value of 1,000 units and a large gas amount, the tip is the whole value and the recipient gets nothing.
    function test_aGasBasedTipNeverExceedsTheValue() public {
        vm.txGasPrice(10 gwei);
        (uint256 tip, uint256 toRecipient,) = _runAtGas(_director(0, 100 ether, 1 ether), 1_000, 8_000_000);
        assertEq(tip, 1_000, "the value binds");
        assertEq(toRecipient, 0);
    }

    function test_theExcludePriorityFlagPricesGasAtTheBaseFee() public {
        vm.txGasPrice(50 gwei);
        vm.fee(7 gwei);
        (uint256 tip,,) = _runAtGas(_director(router.EXCLUDE_PRIORITY(), 100 ether, 1 ether), 1_000 ether, 3_500_000);
        assertEq(tip % 7 gwei, 0, "priced at the base fee");
        uint256 measuredGas = tip / 7 gwei - router.TOKEN_GAS_OVERHEAD();
        assertLe(measuredGas, 3_500_000);
        assertGe(measuredGas, 3_500_000 - TEST_CALLBACK_GAS);
    }

    function test_aGasBasedFeeInTheNativeCoinIsPaidInTheCoin() public {
        vm.txGasPrice(10 gwei);
        uint256 index = _sendWrappedBack(_director(router.UNWRAP(), 1 ether, 1 ether), 5 ether, "");
        uint256 recipientBefore = recipient.balance;
        MessageBridge.MessageProof memory proof = ambA.proofOf(ambB, index);
        vm.prank(executor, executor);
        router.executeMessage{gas: 1_500_000}(proof);
        uint256 fee = reward.balance;
        assertEq(fee % 10 gwei, 0, "the unit is the gas price");
        uint256 measuredGas = fee / 10 gwei - router.NATIVE_GAS_OVERHEAD();
        assertLe(measuredGas, 1_500_000);
        assertGe(measuredGas, 1_500_000 - TEST_CALLBACK_GAS);
        assertEq(recipient.balance - recipientBefore, 5 ether - fee);
        assertEq(address(router).balance, 0);
        assertEq(weth.totalSupply(), 0);
    }

    function test_aGasBasedFeeOnADirectDeliveryIsZero() public {
        vm.txGasPrice(10 gwei);
        uint256 index = _sendTokenB(_director(0, 100 ether, 1 ether), 1_000 ether);
        ambA.executeMessage(ambA.proofOf(ambB, index));
        assertEq(_copyB().balanceOf(recipient), 1_000 ether);
    }

    function test_aRewardAddressThatCannotTakeTheCoinLeavesTheRecipientWholeInCoinForAGasBasedFee() public {
        vm.txGasPrice(10 gwei);
        address refuser = address(new CoinRefuser());
        _useReward(refuser);
        uint256 index = _sendWrappedBack(_director(router.UNWRAP(), 1 ether, 1 ether), 5 ether, "");
        uint256 recipientBefore = recipient.balance;
        _runThroughRouter(index);
        assertEq(recipient.balance - recipientBefore, 5 ether);
    }

    function test_feeInfoPricesAGasBasedFeeFromTheGasUsed() public {
        vm.txGasPrice(10 gwei);
        (uint256 fee, uint256 toRecipient) =
            router.feeInfo(address(tokenB), 1_000 ether, 400_000, _director(0, 100 ether, 1 ether));
        assertEq(fee, (400_000 + 100_000) * 10 gwei, "gas used plus the token overhead, times the gas price");
        assertEq(toRecipient, 1_000 ether - fee);
        (fee,) = router.feeInfo(address(tokenB), 1_000 ether, 400_000, _director(0, 1 gwei, 1 ether));
        assertEq(fee, 1 gwei, "capped");
        (fee,) = router.feeInfo(address(weth), 1_000 ether, 400_000, _director(router.UNWRAP(), 100 ether, 1 ether));
        assertEq(fee, (400_000 + router.NATIVE_GAS_OVERHEAD()) * 10 gwei, "gas used plus the native overhead");
        assertEq(
            router.NATIVE_GAS_OVERHEAD(),
            105_000,
            "measured: 50,000 was too low when both payees are new accounts; the Delivered event adds about 3,800"
        );
    }

    function test_theFeeNeverExceedsTheValue() public {
        uint256 index = _sendTokenB(_director(router.FIXED_FEE(), 500 ether, 0), 100 ether);
        _runThroughRouter(index);
        assertEq(_copyB().balanceOf(reward), 100 ether);
        assertEq(_copyB().balanceOf(recipient), 0);
    }

    /// Claim: a delivery on the bridge, not through the router, takes no tip. Shows: the recipient gets the whole
    /// value, nobody else gets anything, and the slot stays at rest. Matters: the router marks only its own deliveries.
    function test_aDirectDeliveryTakesNoTip() public {
        uint256 index = _sendTokenB(_director(router.FIXED_FEE(), 3 ether, 0), 100 ether);
        ambA.executeMessage(ambA.proofOf(ambB, index));
        assertEq(_copyB().balanceOf(recipient), 100 ether, "everything goes to the recipient");
        assertEq(_copyB().balanceOf(reward), 0);
        assertLe(
            uint256(vm.load(address(router), router.DELIVERY_SLOT())),
            1,
            "the slot stays at rest (0 before the first use)"
        );
    }

    /// Claim: the slot marks a router delivery, and only that. Shows: the slot reads 1 before a router delivery, holds
    /// the starting gas (above 1) while the callback pays out, and reads 1 after it. A direct delivery of the same
    /// kind sees 1 during the callback. A probe token reads the slot of the router each time that the router pays out
    /// of it. Matters: the tip rests on this marker alone.
    function test_theSlotHoldsTheStartingGasOnlyDuringARouterDelivery() public {
        SlotProbeToken probe = new SlotProbeToken(address(router), router.DELIVERY_SLOT());
        probe.mint(alice, 100 ether);
        vm.startPrank(alice);
        probe.approve(address(mediatorA), type(uint256).max);
        mediatorA.relayTokens(address(probe), alice, 100 ether);
        vm.stopPrank();
        _deliverAtoB(_lastIndexA());
        address copy = _copyOf(address(probe));

        assertLe(
            uint256(vm.load(address(router), router.DELIVERY_SLOT())), 1, "at rest before (0 before the first use)"
        );
        bytes memory data = abi.encode(_director(router.FIXED_FEE(), 1 ether, 0));
        vm.startPrank(alice);
        IERC20(copy).approve(address(mediatorB), type(uint256).max);
        mediatorB.relayTokensAndCall(copy, address(router), 20 ether, data, TEST_CALLBACK_GAS);
        uint256 viaRouter = _lastIndexB();
        mediatorB.relayTokensAndCall(copy, address(router), 20 ether, data, TEST_CALLBACK_GAS);
        uint256 direct = _lastIndexB();
        vm.stopPrank();

        _runThroughRouter(viaRouter);
        assertGt(probe.slotSeenAtPayout(), 1, "the starting gas during a router delivery");
        assertEq(probe.balanceOf(reward), 1 ether, "the router delivery paid the tip");
        assertEq(uint256(vm.load(address(router), router.DELIVERY_SLOT())), 1, "at rest after");

        probe.resetSeen();
        ambA.executeMessage(ambA.proofOf(ambB, direct));
        assertEq(probe.slotSeenAtPayout(), 1, "a direct delivery leaves the slot at rest");
        assertEq(probe.balanceOf(reward), 1 ether, "the direct delivery paid no tip");
        assertEq(uint256(vm.load(address(router), router.DELIVERY_SLOT())), 1, "at rest at the end");
    }

    function test_theSlotIsClearedAfterTheRun() public {
        uint256 index = _sendTokenB(_director(router.FIXED_FEE(), 1 ether, 0), 10 ether);
        _runThroughRouter(index);
        assertEq(uint256(vm.load(address(router), router.DELIVERY_SLOT())), 1, "back to the idle value");

        // A later direct execution pays no tip, because the slot holds 1.
        uint256 next = _sendTokenB(_director(router.FIXED_FEE(), 1 ether, 0), 10 ether);
        ambA.executeMessage(ambA.proofOf(ambB, next));
        assertEq(_copyB().balanceOf(reward), 1 ether, "still the first tip only");
    }

    /// Claim: a second delivery cannot start while one runs. Shows: with the slot set to a starting gas, `executeMessage`
    /// reverts with `DeliveryInProgress`. Matters: a nested run would overwrite the starting gas of the first.
    function test_aDeliveryWhileAnotherDeliveryRunsIsRefused() public {
        vm.store(address(router), router.DELIVERY_SLOT(), bytes32(uint256(5)));
        vm.expectRevert(DeliveryRouter.DeliveryInProgress.selector);
        MessageBridge.MessageProof memory empty;
        vm.prank(executor, executor);
        router.executeMessage(empty);
    }

    function test_theSlotNameIsTheDeliveryRouterName() public view {
        assertEq(router.DELIVERY_SLOT(), keccak256(abi.encode("deliveryrouter.delivery")), "the slot of the router");
    }

    /// Claim: the four flag constants carry the names `FIXED_FEE`, `UNWRAP`, `EXCLUDE_PRIORITY` and
    /// `MULTIPLIER_OF_TOTAL` and the bit values 1, 2, 4 and 8 of the `FeeDirector` settings.
    function test_theFlagConstantsHaveTheirNamesAndBits() public view {
        assertEq(router.FIXED_FEE(), 1);
        assertEq(router.UNWRAP(), 2);
        assertEq(router.EXCLUDE_PRIORITY(), 4);
        assertEq(router.MULTIPLIER_OF_TOTAL(), 8);
    }

    /// Claim: `baseFee(true)` is the base fee of the block, and `baseFee(false)` is the gas price of the transaction.
    /// Shows: with the two set apart, each call returns its own. Matters: a gas based tip prices gas by these.
    function test_baseFeeReadsTheBlockOrTheTransaction() public {
        vm.fee(7 gwei);
        vm.txGasPrice(50 gwei);
        assertEq(router.baseFee(true), 7 gwei);
        assertEq(router.baseFee(true), block.basefee);
        assertEq(router.baseFee(false), 50 gwei);
        assertEq(router.baseFee(false), tx.gasprice);
    }

    // ------------------------------------------------------------------------------------------------ unwrap

    function test_unwrapPaysTheRecipientAndTheRewardAddressInTheNativeCoin() public {
        uint256 index = _sendWrappedBack(_director(router.FIXED_FEE() | router.UNWRAP(), 0.4 ether, 0), 5 ether, "");
        uint256 recipientBefore = recipient.balance;
        uint256 rewardBefore = reward.balance;
        _runThroughRouter(index);

        assertEq(reward.balance - rewardBefore, 0.4 ether);
        assertEq(recipient.balance - recipientBefore, 4.6 ether);
        assertEq(weth.totalSupply(), 0, "unwrapped");
        assertEq(weth.balanceOf(address(router)), 0);
        assertEq(address(router).balance, 0);
    }

    function test_unwrapWithARewardAddressThatCannotTakeTheCoinPaysTheRecipientInFull() public {
        address refuser = address(new CoinRefuser());
        _useReward(refuser);
        uint256 index = _sendWrappedBack(_director(router.FIXED_FEE() | router.UNWRAP(), 0.4 ether, 0), 5 ether, "");
        uint256 recipientBefore = recipient.balance;
        _runThroughRouter(index);
        assertEq(recipient.balance - recipientBefore, 5 ether, "the reward address cannot block the recipient");
        assertEq(refuser.balance, 0);
    }

    /// @dev A native coin delivery to `receiver` with a 10 percent multiplier tip for the reward address, delivered through the router
    /// with the callback gas of the relay.
    function _deliverNativeTo(address receiver, uint256 value) internal returns (uint256 toRecipientBefore) {
        DeliveryRouter.FeeDirector memory director =
            DeliveryRouter.FeeDirector(receiver, router.UNWRAP() | router.MULTIPLIER_OF_TOTAL(), 0, 0.1 ether, 0);
        uint256 index = _sendWrappedBack(director, value, "");
        assertEq(ambB.messageAt(index).gasLimit, 0, "the mediator asks the bridge for no gas");
        toRecipientBefore = receiver.balance;
        _runThroughRouter(index);
        assertEq(address(router).balance, 0, "no coin stays in the router");
        assertEq(weth.balanceOf(address(router)), 0, "no wrapped token stays in the router");
    }

    /// Claim: a recipient that burns all its gas, reverts, or needs some gas to receive cannot strand the value, and the
    /// whole path passes within the callback gas of the relay. Shows: the router gives the recipient 50,000 gas; a
    /// burner and a reverter get the wrapped token; a contract wallet gets the coin; the reward address holds its tip in each
    /// case and the router holds nothing. Matters: with all gas forwarded, a burner leaves nothing for the fallback.
    function test_aRecipientThatBurnsItsGasOrRevertsStillGetsTheValue() public {
        GasBurner burner = new GasBurner();
        _deliverNativeTo(address(burner), 5 ether);
        assertEq(weth.balanceOf(address(burner)), 4.5 ether, "the burner gets the wrapped token");
        assertEq(reward.balance, 0.5 ether, "the reward address is paid");

        CoinReverter reverter = new CoinReverter();
        _deliverNativeTo(address(reverter), 5 ether);
        assertEq(weth.balanceOf(address(reverter)), 4.5 ether);
        assertEq(reward.balance, 1 ether);
    }

    function test_aContractWalletRecipientGetsTheCoin() public {
        ContractWallet wallet = new ContractWallet();
        _deliverNativeTo(address(wallet), 5 ether);
        assertEq(address(wallet).balance, 4.5 ether);
        assertEq(wallet.received(), 1);
        assertEq(weth.balanceOf(address(wallet)), 0);
    }

    /// Claim: a reward address that burns its gas or reverts loses its tip and nothing else. Matters: the reward address is an account
    /// that can refuse, and it must not leave the recipient short or the router holding value.
    function test_aRewardAddressThatBurnsItsGasLosesOnlyItsTip() public {
        GasBurner burner = new GasBurner();
        _useReward(address(burner));
        uint256 recipientBefore = _deliverNativeTo(recipient, 5 ether);
        assertEq(recipient.balance - recipientBefore, 5 ether, "the recipient gets the fee as well");
        assertEq(address(burner).balance, 0);
    }

    function test_theGasGivenToAReceiverIsFixed() public view {
        assertEq(router.NATIVE_SEND_GAS(), 50_000);
    }

    function test_unwrapWithARecipientThatCannotTakeTheCoinPaysTheWrappedToken() public {
        address refuser = address(new CoinRefuser());
        DeliveryRouter.FeeDirector memory director =
            DeliveryRouter.FeeDirector(refuser, router.UNWRAP() | router.MULTIPLIER_OF_TOTAL(), 0, 0.1 ether, 0);
        uint256 index = _sendWrappedBack(director, 5 ether, "");
        _runThroughRouter(index);
        assertEq(weth.balanceOf(refuser), 4.5 ether, "paid as the wrapped token");
        assertEq(reward.balance, 0.5 ether);
        assertEq(address(router).balance, 0);
    }

    function test_theUnwrapFlagIsIgnoredForAnotherToken() public {
        uint256 index = _sendTokenB(_director(router.FIXED_FEE() | router.UNWRAP(), 1 ether, 0), 10 ether);
        _runThroughRouter(index);
        assertEq(_copyB().balanceOf(recipient), 9 ether, "only the wrapped native token unwraps");
        assertEq(_copyB().balanceOf(reward), 1 ether);
    }

    function test_theLegacyTwentyByteFormUnwrapsWithNoFee() public {
        uint256 index = _sendWrappedBack(_director(0, 0, 0), 2 ether, abi.encodePacked(carol));
        uint256 carolBefore = carol.balance;
        _runThroughRouter(index);
        assertEq(carol.balance - carolBefore, 2 ether);
        assertEq(reward.balance, 0, "no fee in the legacy form");
    }

    // ------------------------------------------------------------------------------------------------ a reward address the token refuses

    /// @dev A deny list token that has crossed to chain B, with its copy approved, and the reward address denied.
    /// Returns the copy.
    function _denyListCopyThatRefusesTheRewardAddress() internal returns (DenyListToken token, address copy) {
        token = new DenyListToken();
        token.mint(alice, 100 ether);
        vm.startPrank(alice);
        token.approve(address(mediatorA), type(uint256).max);
        mediatorA.relayTokens(address(token), alice, 100 ether);
        vm.stopPrank();
        _deliverAtoB(_lastIndexA());
        copy = _copyOf(address(token));
        token.setDenied(reward, true);
        vm.prank(alice);
        IERC20(copy).approve(address(mediatorB), type(uint256).max);
    }

    function test_aRewardAddressThatTheTokenRefusesCannotBlockTheRecipient() public {
        (DenyListToken token, address copy) = _denyListCopyThatRefusesTheRewardAddress();
        bytes memory data = abi.encode(_director(router.FIXED_FEE(), 5 ether, 0));
        vm.prank(alice);
        mediatorB.relayTokensAndCall(copy, address(router), 50 ether, data, TEST_CALLBACK_GAS);
        _runThroughRouter(_lastIndexB());

        assertEq(
            token.balanceOf(recipient), 50 ether, "the tip that the reward address could not take goes to the recipient"
        );
        assertEq(token.balanceOf(reward), 0);
        assertEq(token.balanceOf(address(router)), 0);
    }

    /// Claim: a gas based tip that the reward address refuses stays with the recipient. Shows: the token refuses the
    /// reward address, the recipient gets the whole value in one transfer, and the router pays the reward address
    /// nothing. Matters: the refusal of the reward address never costs the recipient.
    function test_aGasBasedTipThatTheRewardAddressRefusesStaysWithTheRecipient() public {
        vm.txGasPrice(10 gwei);
        (DenyListToken token, address copy) = _denyListCopyThatRefusesTheRewardAddress();
        vm.prank(alice);
        mediatorB.relayTokensAndCall(copy, address(router), 50 ether, abi.encode(_director(0, 10 ether, 1 ether)), TEST_CALLBACK_GAS);
        MessageBridge.MessageProof memory proof = ambA.proofOf(ambB, _lastIndexB());
        vm.recordLogs();
        vm.prank(executor, executor);
        router.executeMessage{gas: 3_500_000}(proof);
        Vm.Log[] memory logs = vm.getRecordedLogs();

        assertEq(token.balanceOf(recipient), 50 ether, "the whole value");
        assertEq(token.balanceOf(reward), 0);
        assertEq(_transfersTo(logs, address(token), recipient), 1, "one transfer to the recipient");
        assertEq(_transfersTo(logs, address(token), reward), 0, "none to the reward address");
        assertEq(token.balanceOf(address(router)), 0);
    }

    /// Claim: a token that takes a cut on transfer cannot make the router pay more than it holds. Shows: the mediator
    /// reports 100 but the router receives 90, so the fee (a fixed 3) and the share of the recipient are computed on 90:
    /// the reward address gets 3, the recipient gets 87, and the router holds nothing. Matters: a cut would otherwise
    /// make the payout of the recipient revert and block the message.
    function test_aTokenThatTakesACutOnTransferIsPaidOutOfWhatTheRouterHolds() public {
        MedCutToken token = new MedCutToken();
        token.mint(alice, 100 ether);
        vm.startPrank(alice);
        token.approve(address(mediatorA), type(uint256).max);
        mediatorA.relayTokens(address(token), alice, 100 ether);
        vm.stopPrank();
        _deliverAtoB(_lastIndexA());
        address copy = _copyOf(address(token));
        token.setCut(address(mediatorA), 1_000);

        vm.startPrank(alice);
        IERC20(copy).approve(address(mediatorB), type(uint256).max);
        mediatorB.relayTokensAndCall(
            copy, address(router), 100 ether, abi.encode(_director(router.FIXED_FEE(), 3 ether, 0))
        , TEST_CALLBACK_GAS);
        vm.stopPrank();
        _runThroughRouter(_lastIndexB());

        assertEq(token.balanceOf(reward), 3 ether, "the fixed fee");
        assertEq(token.balanceOf(recipient), 87 ether, "the rest of the 90 that arrived");
        assertEq(token.balanceOf(address(router)), 0, "the router keeps nothing");
    }

    /// Claim: a gas based fee with a limit of zero takes no tip. Shows: the recipient gets the whole value, the reward
    /// address gets nothing, and the delivery slot returns to the idle value. Matters: a limit of zero means that the
    /// sender pays no tip.
    function test_aGasBasedFeeWithACapOfZeroTakesNoFee() public {
        vm.txGasPrice(10 gwei);
        (uint256 tip, uint256 toRecipient,) = _runAtGas(_director(0, 0, 1 ether), 100 ether, 5_000_000);
        assertEq(tip, 0, "no fee");
        assertEq(toRecipient, 100 ether, "the whole value");
    }

    // ------------------------------------------------------------------------------------------------ one transfer each

    bytes32 internal constant TRANSFER_TOPIC = keccak256("Transfer(address,address,uint256)");

    /// @dev The number of `Transfer` events of `token` whose payee is `to`.
    function _transfersTo(Vm.Log[] memory logs, address token, address to) internal pure returns (uint256 count) {
        for (uint256 i = 0; i < logs.length; i++) {
            bool isTransferTo = logs[i].emitter == token && logs[i].topics.length == 3
                && logs[i].topics[0] == TRANSFER_TOPIC && address(uint160(uint256(logs[i].topics[2]))) == to;
            if (isTransferTo) count++;
        }
    }

    /// Claim: in a token payout the recipient gets exactly one transfer and the reward address at most one. Shows: for
    /// a fixed tip, a percent tip and a gas based tip, one `Transfer` event names the recipient and one names the
    /// reward address. A tip of zero (a gas based limit of zero) gives the reward address none. Matters: the router
    /// pays with no second transfer for a refund.
    function test_theRecipientGetsOneTokenTransferAndTheRewardAddressAtMostOne() public {
        vm.txGasPrice(10 gwei);
        DeliveryRouter.FeeDirector[4] memory directors = [
            _director(router.FIXED_FEE(), 3 ether, 0),
            _director(router.MULTIPLIER_OF_TOTAL(), 0, 0.02 ether),
            _director(0, 100 ether, 1 ether),
            _director(0, 0, 1 ether)
        ];
        for (uint256 i = 0; i < directors.length; i++) {
            uint256 rewardBefore = _copyB().balanceOf(reward);
            MessageBridge.MessageProof memory proof = ambA.proofOf(ambB, _sendTokenB(directors[i], 100 ether));
            vm.recordLogs();
            vm.prank(executor, executor);
            router.executeMessage{gas: 3_500_000}(proof);
            Vm.Log[] memory logs = vm.getRecordedLogs();

            uint256 tip = _copyB().balanceOf(reward) - rewardBefore;
            assertEq(_transfersTo(logs, address(_copyB()), recipient), 1, "one transfer to the recipient");
            assertEq(
                _transfersTo(logs, address(_copyB()), reward), tip == 0 ? 0 : 1, "at most one to the reward address"
            );
        }
    }

    /// @dev Runs a native payout of `director` and expects exactly one coin call to the recipient and one to the
    /// reward address.
    function _assertOneCoinCallEach(DeliveryRouter.FeeDirector memory director) internal {
        uint256 index = _sendWrappedBack(director, 5 ether, "");
        MessageBridge.MessageProof memory proof = ambA.proofOf(ambB, index);
        vm.expectCall(recipient, "", 1);
        vm.expectCall(reward, "", 1);
        vm.prank(executor, executor);
        router.executeMessage{gas: 3_000_000}(proof);
        assertGt(reward.balance, 0, "a tip was paid");
        assertGt(recipient.balance, 0, "the recipient was paid");
        assertEq(reward.balance + recipient.balance, 5 ether, "the coin is all paid out");
    }

    /// Claim: in a native payout the recipient gets one coin call and the reward address one, for each tip kind.
    function test_aFixedTipInTheCoinIsOneCallToEach() public {
        _assertOneCoinCallEach(_director(router.FIXED_FEE() | router.UNWRAP(), 0.4 ether, 0));
    }

    function test_aPercentTipInTheCoinIsOneCallToEach() public {
        _assertOneCoinCallEach(_director(router.MULTIPLIER_OF_TOTAL() | router.UNWRAP(), 0, 0.1 ether));
    }

    function test_aGasBasedTipInTheCoinIsOneCallToEach() public {
        vm.txGasPrice(10 gwei);
        _assertOneCoinCallEach(_director(router.UNWRAP(), 1 ether, 1 ether));
    }

    // ------------------------------------------------------------------------------------------------ access

    /// Claim: any account delivers through the router, and nothing is refused for who calls. Shows: a stranger, the
    /// recipient and the sender each call `executeMessage` as caller and origin; the first delivers, and the tip goes
    /// to the reward address. Matters: the
    /// bridge stays permissionless, and the router adds no whitelist.
    function test_anyAccountCanDeliverThroughTheRouter() public {
        address[3] memory others = [bob, recipient, alice];
        for (uint256 i = 0; i < others.length; i++) {
            uint256 index = _sendTokenB(_director(router.FIXED_FEE(), 3 ether, 0), 100 ether);
            MessageBridge.MessageProof memory proof = ambA.proofOf(ambB, index);
            vm.prank(others[i], others[i]);
            router.executeMessage(proof);
            assertEq(_copyB().balanceOf(reward), (i + 1) * 3 ether, "the tip goes to the reward address");
        }
    }

    /// Claim: a direct delivery pays no tip in any fee mode. Shows: for each fee mode, delivery on the bridge sends the
    /// whole amount to the recipient and nothing to any other account. Matters: the bridge stays permissionless, so a
    /// user is never stuck if nobody calls the router, and the user pays nothing.
    function test_aDirectDeliveryPaysNoTipInAnyMode() public {
        vm.txGasPrice(10 gwei);
        DeliveryRouter.FeeDirector[3] memory directors = [
            _director(router.FIXED_FEE(), 3 ether, 0),
            _director(router.MULTIPLIER_OF_TOTAL(), 0, 0.02 ether),
            _director(0, 100 ether, 1 ether)
        ];
        for (uint256 i = 0; i < directors.length; i++) {
            uint256 index = _sendTokenB(directors[i], 100 ether);
            vm.prank(bob);
            ambA.executeMessage(ambA.proofOf(ambB, index));
            assertEq(_copyB().balanceOf(recipient), 100 ether * (i + 1), "the recipient gets everything");
        }
        assertEq(_copyB().balanceOf(reward), 0, "a direct delivery pays no tip");
        assertEq(_copyB().balanceOf(bob), 0);
        assertEq(_copyB().balanceOf(address(router)), 0);
    }

    /// Claim: the reward address and the failed delivery address are fixed at deployment, and neither can be zero.
    function test_theAddressesAreFixedAtDeployment() public {
        assertEq(router.rewardAddress(), reward);
        assertEq(router.failedDeliveryAddress(), failedDelivery, "the failed delivery address is fixed");
        vm.expectRevert(DeliveryRouter.ZeroFailedDeliveryAddress.selector);
        new DeliveryRouter(ITokenMediator(address(mediatorA)), IWETH(address(weth)), reward, address(0));
        vm.expectRevert(DeliveryRouter.ZeroRewardAddress.selector);
        new DeliveryRouter(ITokenMediator(address(mediatorA)), IWETH(address(weth)), address(0), failedDelivery);

        // No function changes an address.
        bytes4[4] memory selectors = [
            bytes4(keccak256("setRewardAddress(address)")),
            bytes4(keccak256("changeRewardAddress(address)")),
            bytes4(keccak256("setFailedDeliveryAddress(address)")),
            bytes4(keccak256("runner()"))
        ];
        for (uint256 i = 0; i < selectors.length; i++) {
            (bool ok,) = address(router).call(abi.encodeWithSelector(selectors[i], bob));
            assertFalse(ok);
        }
    }

    /// Claim: the unwrap flag on a token that is not the wrapped native token pays the plain token, in every fee mode,
    /// and the tip comes in that token. Shows: fixed, multiplier of total, and gas based each pay the recipient the
    /// token, and the reward address holds its tip in the token and no coin.
    function test_unwrapOnAnotherTokenPaysTheTokenInEveryFeeMode() public {
        vm.txGasPrice(10 gwei);
        uint256 unwrap = router.UNWRAP();
        DeliveryRouter.FeeDirector[3] memory directors = [
            _director(router.FIXED_FEE() | unwrap, 3 ether, 0),
            _director(router.MULTIPLIER_OF_TOTAL() | unwrap, 0, 0.03 ether),
            _director(unwrap, 100 ether, 1 ether)
        ];
        for (uint256 i = 0; i < directors.length; i++) {
            uint256 rewardBefore = _copyB().balanceOf(reward);
            uint256 recipientBefore = _copyB().balanceOf(recipient);
            _runThroughRouter(_sendTokenB(directors[i], 100 ether));
            uint256 tip = _copyB().balanceOf(reward) - rewardBefore;
            assertGt(tip, 0, "the tip is taken in the token");
            assertEq(_copyB().balanceOf(recipient) - recipientBefore, 100 ether - tip, "the recipient gets the token");
            if (i < 2) assertEq(tip, 3 ether);
        }
        assertEq(reward.balance, 0, "no coin goes to the reward address");
        assertEq(recipient.balance, 0, "no coin goes to the recipient");
        assertEq(address(router).balance, 0);
        assertEq(_copyB().balanceOf(address(router)), 0);
    }

    /// Claim: the fixed tip wins when the fixed bit and the multiplier of total bit are both set. Shows: the tip is
    /// `limit`, not a share of the value, and the unit is not mixed.
    function test_fixedWinsOverMultiplierOfTotalWhenBothBitsAreSet() public {
        uint256 both = router.FIXED_FEE() | router.MULTIPLIER_OF_TOTAL();
        _runThroughRouter(_sendTokenB(_director(both, 2 ether, 0.5 ether), 100 ether));
        assertEq(_copyB().balanceOf(reward), 2 ether, "the fixed tip, not 50 percent");
        assertEq(_copyB().balanceOf(recipient), 98 ether);
        (uint256 fee,) = router.feeInfo(address(tokenB), 100 ether, 0, _director(both, 2 ether, 0.5 ether));
        assertEq(fee, 2 ether, "the view agrees");
    }

    function test_onlyTheMediatorCanCallOnTokenBridged() public {
        vm.prank(bob);
        vm.expectRevert(abi.encodeWithSelector(DeliveryRouter.NotMediator.selector, bob));
        router.onTokenBridged(address(tokenB), 1, abi.encode(_director(0, 0, 0)));
    }

    function test_theRouterTakesTheCoinOnlyFromTheWrappedToken() public {
        vm.prank(bob);
        (bool ok, bytes memory returned) = address(router).call{value: 0}("");
        assertFalse(ok);
        assertEq(returned, abi.encodeWithSelector(DeliveryRouter.NotWrappedTokenSender.selector, bob));
    }

    function test_theRouterHasNoOwnerNoClaimAndNoValidatorFilter() public view {
        bytes4[5] memory selectors = [
            bytes4(keccak256("owner()")),
            bytes4(keccak256("claimTokens(address,address)")),
            bytes4(keccak256("validatorsFilter()")),
            bytes4(keccak256("isValidator(address)")),
            bytes4(keccak256("setValidatorStatus(address,bool)"))
        ];
        for (uint256 i = 0; i < selectors.length; i++) {
            (bool ok,) = address(router).staticcall(abi.encodeWithSelector(selectors[i], address(1), true));
            assertFalse(ok);
        }
    }

    function test_feeInfoMatchesTheFixedAndShareModes() public view {
        (uint256 fee, uint256 toRecipient) =
            router.feeInfo(address(tokenB), 100 ether, 0, _director(router.FIXED_FEE(), 4 ether, 0));
        assertEq(fee, 4 ether);
        assertEq(toRecipient, 96 ether);
        (fee, toRecipient) =
            router.feeInfo(address(tokenB), 100 ether, 0, _director(router.MULTIPLIER_OF_TOTAL(), 0, 0.25 ether));
        assertEq(fee, 25 ether);
        assertEq(toRecipient, 75 ether);
    }
}
