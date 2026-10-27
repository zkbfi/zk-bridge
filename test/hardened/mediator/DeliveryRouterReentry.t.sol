// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {DeliveryRouter} from "../../../src/hardened/mediator/DeliveryRouter.sol";
import {MessageBridge} from "../../../src/hardened/MessageBridge.sol";
import {IWETH} from "../../../src/hardened/mediator/IWETH.sol";
import {ITokenMediator} from "../../../src/hardened/mediator/ITokenMediator.sol";
import {MediatorFixture} from "./utils/MediatorSupport.sol";
import {MedReentryToken, MedDenyListWrappedNative} from "./utils/MedMocks.sol";

/// @notice A payout hook of a recipient can call the bridge and deliver another message while a delivery runs. The
/// mediator then calls `onTokenBridged` on the router again. The router never reverts in the callback, because the
/// mediator keeps no hold on a failed call and the tokens would stay in the router with no record. It hands the value of
/// the nested callback off to the failed delivery address, after the tip when the terms decode.
contract DeliveryRouterReentryTest is MediatorFixture {
    MedDenyListWrappedNative internal weth;
    MedReentryToken internal token;
    DeliveryRouter internal router;
    address internal reward = makeAddr("reward address");
    address internal recipient = makeAddr("recipient");
    address internal otherRecipient = makeAddr("other recipient");
    address internal failedDelivery = makeAddr("failed delivery address");
    address internal copy;

    event DeliveryFailed(address indexed token, address indexed recipient, uint256 amount, DeliveryRouter.Reason reason);

    function setUp() public override {
        super.setUp();
        weth = new MedDenyListWrappedNative();
        router = new DeliveryRouter(ITokenMediator(address(mediatorA)), IWETH(address(weth)), reward, failedDelivery);
        token = new MedReentryToken();
        token.mint(alice, 1_000_000 ether);
        vm.startPrank(alice);
        token.approve(address(mediatorA), type(uint256).max);
        mediatorA.relayTokens(address(token), alice, 500_000 ether);
        vm.stopPrank();
        _deliverAtoB(_lastIndexA());
        copy = _copyOf(address(token));
    }

    function _terms(address to, uint256 settings, uint256 limit, uint256 multiplier)
        internal
        pure
        returns (bytes memory)
    {
        return abi.encode(DeliveryRouter.FeeDirector(to, settings, limit, multiplier));
    }

    function _send(bytes memory data, uint256 value) internal returns (uint256) {
        vm.startPrank(alice);
        IERC20(copy).approve(address(mediatorB), type(uint256).max);
        mediatorB.relayTokensAndCall(copy, address(router), value, data);
        vm.stopPrank();
        return _lastIndexB();
    }

    /// @dev Arms the token so that the payment to `recipient` makes the token execute message `nestedIndex` on the
    /// bridge, as a recipient hook would.
    function _armReentry(uint256 nestedIndex) internal {
        token.arm(
            recipient,
            address(ambA),
            abi.encodeCall(MessageBridge.executeMessage, (ambA.proofOf(ambB, nestedIndex)))
        );
    }

    function _run(uint256 index) internal {
        vm.prank(bob, bob);
        router.executeMessage(ambA.proofOf(ambB, index));
    }

    /// Claim: the stranding. Shows: after a delivery whose recipient hook delivers a second message, the router holds
    /// none of the tokens of the second message. Before the fix the callback reverted on the guard, and the tokens stayed
    /// in the router with no record.
    function test_aReentrantCallbackLeavesNoTokensInTheRouter() public {
        uint256 outer = _send(_terms(recipient, 1, 1 ether, 0), 100 ether);
        uint256 nested = _send(_terms(otherRecipient, 1, 2 ether, 0), 50 ether);
        _armReentry(nested);

        _run(outer);

        assertEq(token.hooksRun(), 1, "the hook ran");
        assertEq(token.balanceOf(address(router)), 0, "the router holds nothing");
    }

    /// Claim: a reentrant callback never strands tokens in the router. Shows: the nested message of 50 hands off to the
    /// failed delivery address after a tip of 2, the outer message pays its recipient after a tip of 1, and the router
    /// holds nothing. Matters: the router has no owner, so tokens that the mediator left in it would be lost for good.
    function test_aReentrantCallbackHandsItsValueOffAfterTheTip() public {
        uint256 outer = _send(_terms(recipient, 1, 1 ether, 0), 100 ether);
        uint256 nested = _send(_terms(otherRecipient, 1, 2 ether, 0), 50 ether);
        _armReentry(nested);

        vm.expectEmit(true, true, false, true, address(router));
        emit DeliveryFailed(address(token), otherRecipient, 48 ether, DeliveryRouter.Reason.Reentered);
        _run(outer);

        assertEq(token.hooksRun(), 1, "the hook ran");
        assertEq(token.balanceOf(recipient), 99 ether, "the outer recipient");
        assertEq(token.balanceOf(reward), 3 ether, "both tips");
        assertEq(token.balanceOf(failedDelivery), 48 ether, "the nested value");
        assertEq(token.balanceOf(otherRecipient), 0);
        assertEq(token.balanceOf(address(router)), 0, "nothing stays in the router");
        assertEq(router.totalClaimable(address(token)), 0, "and no record is owed");
    }

    /// Claim: a reentrant callback with data of no known shape hands the whole value off, as any such callback does.
    function test_aReentrantCallbackWithNoKnownShapeHandsTheWholeValueOff() public {
        uint256 outer = _send(_terms(recipient, 1, 1 ether, 0), 100 ether);
        uint256 nested = _send(hex"1234", 50 ether);
        _armReentry(nested);

        vm.expectEmit(true, true, false, true, address(router));
        emit DeliveryFailed(address(token), address(0), 50 ether, DeliveryRouter.Reason.Reentered);
        _run(outer);

        assertEq(token.balanceOf(failedDelivery), 50 ether);
        assertEq(token.balanceOf(address(router)), 0);
    }

    /// Claim: a reentrant callback with the legacy form hands the whole value off to nobody's loss: no tip, and the
    /// event names the receiver.
    function test_aReentrantLegacyCallbackHandsTheWholeValueOff() public {
        uint256 outer = _send(_terms(recipient, 1, 1 ether, 0), 100 ether);
        uint256 nested = _send(abi.encodePacked(otherRecipient), 50 ether);
        _armReentry(nested);

        vm.expectEmit(true, true, false, true, address(router));
        emit DeliveryFailed(address(token), otherRecipient, 50 ether, DeliveryRouter.Reason.Reentered);
        _run(outer);

        assertEq(token.balanceOf(failedDelivery), 50 ether);
        assertEq(token.balanceOf(reward), 1 ether, "only the outer tip");
        assertEq(token.balanceOf(address(router)), 0);
    }

    /// Claim: a nested callback of a delivery that no router started takes no tip, as for any callback that runs with
    /// no router delivery. Shows: a direct execution whose recipient hook reenters hands the nested value off whole.
    function test_aReentrantCallbackOfADirectExecutionTakesNoTip() public {
        uint256 outer = _send(_terms(recipient, 1, 1 ether, 0), 100 ether);
        uint256 nested = _send(_terms(otherRecipient, 1, 2 ether, 0), 50 ether);
        _armReentry(nested);

        _deliverBtoA(outer);

        assertEq(token.balanceOf(failedDelivery), 50 ether, "the whole nested value");
        assertEq(token.balanceOf(reward), 0, "no tip");
        assertEq(token.balanceOf(address(router)), 0);
    }

    /// Claim: only the mediator reenters the callback. Shows: a stranger that calls `onTokenBridged` during a delivery
    /// still gets `NotMediator`.
    function test_aStrangerStillCannotCallTheCallbackWhileADeliveryRuns() public {
        vm.prank(bob);
        vm.expectRevert(abi.encodeWithSelector(DeliveryRouter.NotMediator.selector, bob));
        router.onTokenBridged(address(token), 1 ether, "");
    }
}
