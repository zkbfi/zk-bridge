// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Vm} from "forge-std/Vm.sol";
import {Test} from "forge-std/Test.sol";
import {MockERC20} from "../../../src/mocks/MockERC20.sol";
import {MockWrappedNative} from "../../../src/mocks/MockWrappedNative.sol";
import {DeliveryRouter} from "../../../src/hardened/mediator/DeliveryRouter.sol";
import {IWETH} from "../../../src/hardened/mediator/IWETH.sol";
import {ITokenMediator} from "../../../src/hardened/mediator/ITokenMediator.sol";
import {CALLBACK_GAS_MAXIMUM} from "../../../src/hardened/mediator/MediatorPayloads.sol";
import {CallRecorder} from "./utils/CallTargets.sol";

/// @notice The callback of the router never reverts on the words of the terms. The sender writes every word of the
/// `FeeDirector`, so a word near 2^256 must not make the arithmetic of the fee overflow, and a `callGas` that no
/// callback can carry must not reach the call. Terms that cannot be honoured take the hand-off path, with
/// `DeliveryFailed`.
/// @dev The harness: the test contract is the mediator of the router, so a test calls `onTokenBridged` directly, after
/// it gives the router the tokens. A test that needs a router delivery writes a starting gas into `DELIVERY_SLOT`, as
/// `executeMessage` does.
contract DeliveryRouterTermsTest is Test {
    MockERC20 internal token;
    MockWrappedNative internal weth;
    DeliveryRouter internal router;
    CallRecorder internal target;
    address internal reward = makeAddr("reward address");
    address internal failedDelivery = makeAddr("failed delivery address");
    address internal recipient = makeAddr("recipient");

    /// @dev A starting gas far above what any callback here can use, so `startingGas - gasleft()` never goes below
    /// zero.
    uint256 internal constant FAR_STARTING_GAS = type(uint96).max;

    event DeliveryFailed(address indexed token, address indexed recipient, uint256 amount, DeliveryRouter.Reason reason);

    function setUp() public {
        token = new MockERC20("Token", "TKN");
        weth = new MockWrappedNative();
        router = new DeliveryRouter(ITokenMediator(address(this)), IWETH(address(weth)), reward, failedDelivery);
        target = new CallRecorder();
    }

    // ------------------------------------------------------------------------------------------------ helpers

    function _director(uint256 settings, uint256 limit, uint256 multiplier, uint256 callGas)
        internal
        view
        returns (DeliveryRouter.FeeDirector memory)
    {
        return DeliveryRouter.FeeDirector(recipient, settings, limit, multiplier, callGas);
    }

    /// @dev The director followed by the target of a call and one byte of call data.
    function _withCall(DeliveryRouter.FeeDirector memory director) internal view returns (bytes memory) {
        return bytes.concat(abi.encode(director), abi.encodePacked(address(target)), hex"01");
    }

    /// @dev Gives the router `value` of the token and runs the callback as a router delivery.
    function _deliver(uint256 value, bytes memory data) internal {
        token.mint(address(router), value);
        vm.store(address(router), router.DELIVERY_SLOT(), bytes32(FAR_STARTING_GAS));
        router.onTokenBridged(address(token), value, data);
    }

    function _assertRouterEmpty() internal view {
        assertEq(token.balanceOf(address(router)), 0, "the router keeps nothing");
    }

    // ------------------------------------------------------------------------------------------------ a share of the value

    /// Claim: a share fee with a multiplier near 2^256 is the whole value, with no overflow. Shows: the reward address
    /// gets the value and the recipient nothing, as `limit`, the value cap, says; the callback does not revert.
    /// Matters: `value * multiplier` overflowed before, the callback reverted, and the tokens sat in the router with no
    /// `DeliveryFailed`.
    function test_aShareWithAHugeMultiplierIsTheWholeValue() public {
        _deliver(100 ether, abi.encode(_director(router.MULTIPLIER_OF_TOTAL(), 0, type(uint256).max, 0)));
        assertEq(token.balanceOf(reward), 100 ether, "a share of more than all is all");
        assertEq(token.balanceOf(recipient), 0);
        _assertRouterEmpty();
    }

    /// Claim: a share of a value near 2^256 is exact. Shows: 1% of 2^250 + 7 is `(2^250 + 7) / 100`, to the unit.
    /// Matters: the share is computed without the product `value * multiplier`, which does not fit 256 bits here, so a
    /// large balance pays the share that the sender signed and not the whole value.
    function test_aShareOfAHugeValueIsExact() public {
        uint256 value = 2 ** 250 + 7;
        _deliver(value, abi.encode(_director(router.MULTIPLIER_OF_TOTAL(), 0, 0.01 ether, 0)));
        assertEq(token.balanceOf(reward), value / 100, "one percent, rounded down");
        assertEq(token.balanceOf(recipient), value - value / 100);
        _assertRouterEmpty();
    }

    // ------------------------------------------------------------------------------------------------ a gas based fee

    /// Claim: a gas based fee whose product does not fit 256 bits is the cap. Shows: with a multiplier of 2^256 - 1 the
    /// reward address gets `limit`, and with a limit of 2^256 - 1 it gets the value. Matters: `limit` is the ceiling
    /// that the sender signed for a gas based fee, so a fee that saturates there charges nothing the sender did not
    /// accept, and the callback does not revert.
    function test_aGasBasedFeeWhoseProductOverflowsIsTheCap() public {
        vm.txGasPrice(1 gwei);
        _deliver(100 ether, abi.encode(_director(0, 5 ether, type(uint256).max, 0)));
        assertEq(token.balanceOf(reward), 5 ether, "the limit");
        assertEq(token.balanceOf(recipient), 95 ether);

        address second = makeAddr("second recipient");
        DeliveryRouter.FeeDirector memory director = _director(0, type(uint256).max, type(uint256).max, 0);
        director.recipient = second;
        _deliver(100 ether, abi.encode(director));
        assertEq(token.balanceOf(reward), 105 ether, "the value");
        assertEq(token.balanceOf(second), 0);

        // A value above 2^256 / 1e18: the saturated product is the cap itself, not the largest number divided by 1e18.
        uint256 huge = 2 ** 250;
        _deliver(huge, abi.encode(director));
        assertEq(token.balanceOf(reward), 105 ether + huge, "the whole value");
        _assertRouterEmpty();
    }

    /// Claim: the share fee is `value * multiplier / 1e18`, rounded down, wherever that product fits. Shows: for any
    /// value below 2^128 and any multiplier below 1e18, `feeInfo` gives exactly that figure. Matters: the share is now
    /// computed in two parts so that it cannot overflow; it must still be the share that the sender signed, to the
    /// unit.
    function testFuzz_aShareIsExact(uint128 value, uint64 rawMultiplier) public view {
        uint256 multiplier = bound(rawMultiplier, 0, 1 ether - 1);
        (uint256 fee, uint256 toRecipient) =
            router.feeInfo(address(token), value, 0, _director(router.MULTIPLIER_OF_TOTAL(), 0, multiplier, 0));
        assertEq(fee, uint256(value) * multiplier / 1 ether, "the share, rounded down");
        assertEq(toRecipient, uint256(value) - fee);
    }

    /// Claim: a gas price of zero gives a gas based fee of zero, whatever the multiplier. Shows: with the base fee at
    /// 0, `EXCLUDE_PRIORITY` and a multiplier of 2^256 - 1, the recipient gets everything. Matters: the saturation of
    /// the product must not turn a factor of zero into the cap (a chain with no base fee).
    function test_aZeroGasPriceIsAZeroFeeAtAnyMultiplier() public {
        vm.fee(0);
        _deliver(100 ether, abi.encode(_director(router.EXCLUDE_PRIORITY(), 5 ether, type(uint256).max, 0)));
        assertEq(token.balanceOf(reward), 0, "no fee");
        assertEq(token.balanceOf(recipient), 100 ether);
    }

    /// Claim: `feeInfo` answers for any gas figure and any multiplier. Shows: a gas used of 2^256 - 1 and a multiplier
    /// of 2^256 - 1 give the cap, and the plain figures give the plain product. Matters: a frontend reads the fee from
    /// it, and a view that panics on large input tells it nothing.
    function test_feeInfoAnswersForAnyFigure() public {
        vm.txGasPrice(10 gwei);
        DeliveryRouter.FeeDirector memory director = _director(0, 7 ether, type(uint256).max, 0);
        (uint256 fee, uint256 toRecipient) = router.feeInfo(address(token), 100 ether, type(uint256).max, director);
        assertEq(fee, 7 ether, "the limit");
        assertEq(toRecipient, 93 ether);
        director.multiplier = 1 ether;
        (fee,) = router.feeInfo(address(token), 100 ether, type(uint256).max, director);
        assertEq(fee, 7 ether, "a gas figure of 2^256 - 1 saturates too");
        (fee,) = router.feeInfo(address(token), 100 ether, 400_000, director);
        assertEq(fee, (400_000 + router.TOKEN_GAS_OVERHEAD()) * 10 gwei, "the plain product");
    }

    // ------------------------------------------------------------------------------------------------ the call gas

    /// Claim: the router's largest call gas fits the mediator's largest callback gas, with the router's own work.
    /// Shows: `MAX_CALL_GAS` (10,000,000), its 63/64 share (rounded up), `CALL_GAS_RESERVE` and the 300,000 gas of the
    /// router's own work (`ROUTER_CALLBACK_GAS_BASE` of the explorer core) add up to `MAX_CALLBACK_GAS` of the
    /// mediator. Matters: the two limits are one rule; a call gas above the router's limit could never run inside a
    /// callback that the mediator lets a sender ask for.
    function test_theLargestCallFitsTheLargestCallback() public {
        uint256 callGas = router.MAX_CALL_GAS();
        assertEq(callGas, 10_000_000, "the figure of the frontends (MAX_CALL_GAS of @zkb/core)");
        uint256 routerWork = 300_000;
        assertEq(
            routerWork + callGas + (callGas + 62) / 63 + router.CALL_GAS_RESERVE(),
            CALLBACK_GAS_MAXIMUM,
            "MAX_CALLBACK_GAS of the mediator (TokenMediator.t.sol checks that it is this figure)"
        );
    }

    /// Claim: a call gas above `MAX_CALL_GAS` is terms that cannot be honoured: the router hands the whole value off,
    /// takes no tip and makes no call. Shows: for one above the maximum and for 2^256 - 1, `DeliveryFailed` names the
    /// recipient, the value and `InvalidTerms`; the failed delivery address holds the value; the target was not called.
    /// Matters: before, a call gas near 2^256 overflowed the gas measure of the tip and the callback reverted; one just
    /// above the maximum asked for a call that no callback can carry.
    function test_aCallGasAboveTheMaximumIsHandedOffWithNoTip() public {
        uint256[2] memory figures = [router.MAX_CALL_GAS() + 1, type(uint256).max];
        for (uint256 i = 0; i < figures.length; i++) {
            uint256 before = token.balanceOf(failedDelivery);
            bytes memory data = _withCall(_director(router.FIXED_FEE(), 1 ether, 0, figures[i]));
            token.mint(address(router), 100 ether);
            vm.store(address(router), router.DELIVERY_SLOT(), bytes32(FAR_STARTING_GAS));
            vm.expectEmit(true, true, false, true, address(router));
            emit DeliveryFailed(address(token), recipient, 100 ether, DeliveryRouter.Reason.InvalidTerms);
            router.onTokenBridged(address(token), 100 ether, data);
            assertEq(token.balanceOf(failedDelivery) - before, 100 ether, "the whole value is handed off");
        }
        assertEq(token.balanceOf(reward), 0, "no tip");
        assertEq(token.balanceOf(recipient), 0, "no payout");
        assertEq(target.calls(), 0, "no call");
        _assertRouterEmpty();
    }

    /// Claim: the hand-off of a call gas above the maximum keeps the wrapped token, even with `UNWRAP`. Shows: the
    /// failed delivery address gets the wrapped token and the router holds no coin. Matters: the router unwraps only
    /// for a payout that it makes.
    function test_aCallGasAboveTheMaximumHandsOffTheWrappedTokenWithNoUnwrap() public {
        vm.deal(address(this), 3 ether);
        weth.deposit{value: 3 ether}();
        weth.transfer(address(router), 3 ether);
        bytes memory data = _withCall(_director(router.UNWRAP(), 0, 0, router.MAX_CALL_GAS() + 1));
        router.onTokenBridged(address(weth), 3 ether, data);
        assertEq(weth.balanceOf(failedDelivery), 3 ether, "handed off as the wrapped token");
        assertEq(address(router).balance, 0);
        assertEq(recipient.balance, 0);
    }

    /// Claim: a call gas of exactly `MAX_CALL_GAS` is honoured. Shows: the target is called and the recipient paid.
    /// Matters: the bound refuses only what no callback can carry.
    function test_theMaximumCallGasIsHonoured() public {
        _deliver(100 ether, _withCall(_director(router.FIXED_FEE(), 1 ether, 0, router.MAX_CALL_GAS())));
        assertEq(target.calls(), 1, "the call ran");
        assertGt(target.gasAtEntry(), router.MAX_CALL_GAS() - 5_000, "with its gas");
        assertEq(token.balanceOf(recipient), 99 ether);
        assertEq(token.balanceOf(reward), 1 ether);
    }

    /// Claim: the call gas of a director with no call after it is not read. Shows: a call gas of 2^256 - 1 with no
    /// target pays the recipient as usual. Matters: the words of the director keep their meaning; only a call reads
    /// `callGas`.
    function test_aCallGasWithNoCallIsNotRead() public {
        _deliver(100 ether, abi.encode(_director(router.FIXED_FEE(), 1 ether, 0, type(uint256).max)));
        assertEq(token.balanceOf(recipient), 99 ether);
        assertEq(token.balanceOf(reward), 1 ether);
    }

    // ------------------------------------------------------------------------------------------------ any terms

    /// Claim: the callback never reverts on any terms. Shows: for any settings, limit, multiplier, call gas, value, gas
    /// price and base fee, with and without a call, through a router delivery or not, `onTokenBridged` returns, and the
    /// value ends with the reward address, the recipient or the failed delivery address, none of it in the router.
    /// Matters: the header of the router promises that the callback never reverts, because a revert there leaves the
    /// tokens in the router with no `DeliveryFailed`.
    function testFuzz_theCallbackNeverRevertsOnAnyTerms(
        uint256 settings,
        uint256 limit,
        uint256 multiplier,
        uint256 callGas,
        uint128 value,
        uint64 gasPrice,
        uint64 blockBaseFee,
        bool withCall,
        bool routerDelivery
    ) public {
        vm.assume(value > 0);
        // Half of the call gas figures inside the range, so the call runs in some runs.
        if (callGas % 2 == 0) callGas = bound(callGas, 0, router.MAX_CALL_GAS());
        vm.txGasPrice(gasPrice);
        vm.fee(blockBaseFee);
        DeliveryRouter.FeeDirector memory director = _director(settings, limit, multiplier, callGas);
        bytes memory data = withCall ? _withCall(director) : abi.encode(director);
        token.mint(address(router), value);
        if (routerDelivery) vm.store(address(router), router.DELIVERY_SLOT(), bytes32(FAR_STARTING_GAS));

        router.onTokenBridged(address(token), value, data);

        assertEq(
            token.balanceOf(reward) + token.balanceOf(recipient) + token.balanceOf(failedDelivery),
            value,
            "every unit is with a payee"
        );
        _assertRouterEmpty();
    }
}

