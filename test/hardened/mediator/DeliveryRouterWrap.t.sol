// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {TokenMediator} from "../../../src/hardened/mediator/TokenMediator.sol";
import {DeliveryRouter} from "../../../src/hardened/mediator/DeliveryRouter.sol";
import {IWETH} from "../../../src/hardened/mediator/IWETH.sol";
import {ITokenMediator} from "../../../src/hardened/mediator/ITokenMediator.sol";
import {MediatorFixture, MockWrappedNative, RecordingReceiver} from "./utils/MediatorSupport.sol";

/// @notice Tests of the wrap and send entries of `DeliveryRouter` on the source chain, and of the way back: the same
/// router unwraps on the destination with the unwrap flag. There is one router on each chain.
contract DeliveryRouterWrapTest is MediatorFixture {
    MockWrappedNative internal weth;
    DeliveryRouter internal routerA;

    function setUp() public override {
        super.setUp();
        weth = new MockWrappedNative();
        routerA = _deliveryRouter();
        vm.deal(alice, 100 ether);
        vm.deal(bob, 100 ether);
    }

    function test_wrapAndRelayTokensLocksTheWrappedTokenAndMintsTheCopyForTheCaller() public {
        vm.prank(alice);
        routerA.wrapAndRelayTokens{value: 2 ether}();

        assertEq(weth.balanceOf(address(mediatorA)), 2 ether, "the wrapped token is locked");
        assertEq(weth.balanceOf(address(routerA)), 0, "the router keeps nothing");
        assertEq(address(routerA).balance, 0);
        assertEq(mediatorA.mediatorBalance(address(weth)), 2 ether);

        (bool ok,) = _deliverAtoB(0);
        assertTrue(ok);
        assertEq(IERC20(_copyOf(address(weth))).balanceOf(alice), 2 ether);
    }

    /// Claim: a wrap and send to a receiver sends the OmniBridge payload and names no address but the receiver. Shows:
    /// the exact message, with no address of the caller, and the receiver on the other chain holds the copy. Matters:
    /// the mediator pays the receiver only, and this router has no fallback option.
    function test_wrapAndRelayTokensToAReceiverNamesNoOtherAddress() public {
        vm.prank(alice);
        routerA.wrapAndRelayTokens{value: 1 ether}(bob);
        bytes memory expected = abi.encodeWithSelector(
            TokenMediator.deployAndHandleBridgedTokens.selector,
            address(weth),
            "Wrapped Native",
            "WNAT",
            uint8(18),
            bob,
            1 ether
        );
        assertEq(ambA.messageAt(0).data, expected, "the receiver is the only address");
        _deliverAtoB(0);
        assertEq(IERC20(_copyOf(address(weth))).balanceOf(bob), 1 ether);
    }

    /// Claim: the wrap and send with a gas limit passes the limit to the mediator, which applies its rule. Shows: a
    /// request above the default is the gas limit of the message, a request below it gives the default, a request
    /// above the bridge maximum reverts with the mediator error and the caller keeps the coin, and the payload is
    /// the same as without a limit. Matters: a router user needs the gas option of the mediator.
    function test_wrapAndRelayTokensWithAGasLimitFollowsTheMediatorRule() public {
        vm.startPrank(alice);
        routerA.wrapAndRelayTokens{value: 1 ether}(bob);
        routerA.wrapAndRelayTokens{value: 1 ether}(bob, 3_000_000);
        routerA.wrapAndRelayTokens{value: 1 ether}(bob, 1);
        vm.stopPrank();
        assertEq(ambA.messageAt(0).gasLimit, mediatorA.DEPLOY_GAS_LIMIT(), "the default");
        assertEq(ambA.messageAt(1).gasLimit, 3_000_000, "the request is above the default");
        assertEq(ambA.messageAt(2).gasLimit, mediatorA.DEPLOY_GAS_LIMIT(), "the request is below the default");
        assertEq(ambA.messageAt(1).data, ambA.messageAt(0).data, "the payload does not change");

        uint256 maximum = ambA.maxGasPerTx();
        uint256 before = alice.balance;
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(TokenMediator.GasLimitAboveBridgeMaximum.selector, maximum + 1, maximum));
        routerA.wrapAndRelayTokens{value: 1 ether}(bob, maximum + 1);
        assertEq(alice.balance, before, "the caller keeps the coin");
    }

    /// Claim: the wrap and call with a gas limit passes the limit and the data to the mediator. Shows: the message is
    /// `deployAndHandleBridgedTokensAndCall` with the data, the gas limit is the request when it is above the default,
    /// and the receiver sees the data. A request below the default gives the default. Empty data is still refused.
    function test_relayTokensAndCallWithAGasLimitFollowsTheMediatorRule() public {
        RecordingReceiver receiver = new RecordingReceiver();
        uint256 callDefault = mediatorA.DEPLOY_GAS_LIMIT() + mediatorA.CALLBACK_GAS_LIMIT();
        vm.startPrank(alice);
        routerA.relayTokensAndCall{value: 1 ether}(address(receiver), hex"7777", 5_000_000);
        routerA.relayTokensAndCall{value: 1 ether}(address(receiver), hex"7777", 1);
        vm.expectRevert(DeliveryRouter.EmptyData.selector);
        routerA.relayTokensAndCall{value: 1 ether}(address(receiver), "", 5_000_000);
        vm.stopPrank();
        assertEq(ambA.messageAt(0).gasLimit, 5_000_000, "the request is above the default");
        assertEq(ambA.messageAt(1).gasLimit, callDefault, "the request is below the default");
        assertEq(
            _selectorOf(ambA.messageAt(0).data), TokenMediator.deployAndHandleBridgedTokensAndCall.selector
        );
        _deliverAtoB(0);
        assertEq(receiver.lastData(), hex"7777");
        assertEq(receiver.lastValue(), 1 ether);
    }

    /// @dev Bridges `value` of the wrapped token to the copy on chain B, owned by bob.
    function _bobHoldsTheCopy(uint256 value) internal returns (address copy) {
        vm.prank(alice);
        routerA.wrapAndRelayTokens{value: value}(bob);
        _deliverAtoB(_lastIndexA());
        copy = _copyOf(address(weth));
        vm.prank(bob);
        IERC20(copy).approve(address(mediatorB), type(uint256).max);
    }

    /// Claim: the coin comes back as the native coin through `DeliveryRouter` with the unwrap flag, so this router needs
    /// no destination role. Shows: bob sends the copy to the delivery router with terms that name carol and the unwrap
    /// bit. Carol gets exactly the coin, the wrapped token is burned by the unwrap, and nothing stays anywhere.
    function test_theCoinComesBackUnwrappedThroughTheDeliveryRouterWithTheUnwrapFlag() public {
        DeliveryRouter delivery = routerA;
        address copy = _bobHoldsTheCopy(3 ether);
        assertEq(weth.totalSupply(), 3 ether);

        DeliveryRouter.FeeDirector memory terms = DeliveryRouter.FeeDirector(carol, delivery.UNWRAP(), 0, 0);
        uint256 carolBefore = carol.balance;
        vm.prank(bob);
        mediatorB.relayTokensAndCall(copy, address(delivery), 3 ether, abi.encode(terms));
        (bool ok,) = _deliverBtoA(_lastIndexB());
        assertTrue(ok);

        assertEq(carol.balance - carolBefore, 3 ether, "the receiver gets the coin");
        assertEq(weth.totalSupply(), 0, "the wrapped token is burned by the unwrap");
        assertEq(weth.balanceOf(address(delivery)), 0);
        assertEq(address(delivery).balance, 0);
        assertEq(mediatorA.mediatorBalance(address(weth)), 0);
    }

    /// Claim: the 20 byte legacy data of the old destination role still unwraps, through `DeliveryRouter`. Shows: carol
    /// gets the coin and the delivery router keeps nothing.
    function test_theTwentyByteLegacyDataStillUnwrapsThroughTheDeliveryRouter() public {
        DeliveryRouter delivery = routerA;
        address copy = _bobHoldsTheCopy(1 ether);

        uint256 carolBefore = carol.balance;
        vm.prank(bob);
        mediatorB.relayTokensAndCall(copy, address(delivery), 1 ether, abi.encodePacked(carol));
        (bool ok,) = _deliverBtoA(_lastIndexB());
        assertTrue(ok);

        assertEq(carol.balance - carolBefore, 1 ether);
        assertEq(weth.balanceOf(address(delivery)), 0);
        assertEq(address(delivery).balance, 0);
    }

    function _deliveryRouter() internal returns (DeliveryRouter) {
        return new DeliveryRouter(
            ITokenMediator(address(mediatorA)), IWETH(address(weth)), makeAddr("reward"), makeAddr("failed")
        );
    }

    function test_relayTokensAndCallWrapsAndCallsTheReceiverOnTheOtherChain() public {
        RecordingReceiver receiver = new RecordingReceiver();
        vm.prank(alice);
        routerA.relayTokensAndCall{value: 1 ether}(address(receiver), hex"7777");
        _deliverAtoB(0);
        assertEq(receiver.calls(), 1);
        assertEq(receiver.lastData(), hex"7777");
        assertEq(receiver.lastValue(), 1 ether);
    }

    function test_relayTokensAndCallNeedsData() public {
        vm.prank(alice);
        vm.expectRevert(DeliveryRouter.EmptyData.selector);
        routerA.relayTokensAndCall{value: 1 ether}(bob, "");
    }

    /// Claim: a zero receiver is refused on every entry, so the wrapped token never reaches the zero address on the
    /// other chain. Shows: each entry reverts with the receiver, and alice keeps the coin.
    function test_aZeroReceiverIsRefusedOnEveryEntry() public {
        bytes memory refusal = abi.encodeWithSelector(DeliveryRouter.InvalidReceiver.selector, address(0));
        uint256 before = alice.balance;
        vm.startPrank(alice);
        vm.expectRevert(refusal);
        routerA.wrapAndRelayTokens{value: 1 ether}(address(0));
        vm.expectRevert(refusal);
        routerA.relayTokensAndCall{value: 1 ether}(address(0), hex"01");
        vm.stopPrank();
        assertEq(alice.balance, before);
        assertEq(ambA.sentCount(), 0, "no message");
    }

    /// Claim: the router is refused as a receiver, because the router has no way to pay out on the other chain.
    function test_theRouterItselfIsRefusedAsReceiver() public {
        bytes memory refusal = abi.encodeWithSelector(DeliveryRouter.InvalidReceiver.selector, address(routerA));
        vm.startPrank(alice);
        vm.expectRevert(refusal);
        routerA.wrapAndRelayTokens{value: 1 ether}(address(routerA));
        vm.expectRevert(refusal);
        routerA.relayTokensAndCall{value: 1 ether}(address(routerA), hex"01");
        vm.stopPrank();
        assertEq(ambA.sentCount(), 0);
    }

    /// Claim: the router holds no standing approval, so the allowance of the router to the mediator is zero before and
    /// after each wrap entry point. Shows: the allowance reads zero at the start, and zero after each of the five entry
    /// points, whose wrapped token the mediator took in full (the mediator holds the sum). Matters: a standing approval
    /// would let a faulty mediator take any wrapped token that the router ever holds.
    function test_theAllowanceToTheMediatorIsZeroBeforeAndAfterEveryWrapEntry() public {
        RecordingReceiver receiver = new RecordingReceiver();
        assertEq(weth.allowance(address(routerA), address(mediatorA)), 0, "zero before any wrap");

        vm.startPrank(alice);
        routerA.wrapAndRelayTokens{value: 1 ether}();
        assertEq(weth.allowance(address(routerA), address(mediatorA)), 0, "after wrapAndRelayTokens()");
        routerA.wrapAndRelayTokens{value: 2 ether}(bob);
        assertEq(weth.allowance(address(routerA), address(mediatorA)), 0, "after wrapAndRelayTokens(receiver)");
        routerA.wrapAndRelayTokens{value: 3 ether}(bob, 3_000_000);
        assertEq(weth.allowance(address(routerA), address(mediatorA)), 0, "after wrapAndRelayTokens(receiver, gas)");
        routerA.relayTokensAndCall{value: 4 ether}(address(receiver), hex"7777");
        assertEq(weth.allowance(address(routerA), address(mediatorA)), 0, "after relayTokensAndCall(receiver, data)");
        routerA.relayTokensAndCall{value: 5 ether}(address(receiver), hex"7777", 5_000_000);
        assertEq(weth.allowance(address(routerA), address(mediatorA)), 0, "after relayTokensAndCall with gas");
        vm.stopPrank();

        assertEq(weth.balanceOf(address(mediatorA)), 15 ether, "the mediator took all of the wrapped token");
        assertEq(weth.balanceOf(address(routerA)), 0, "the router holds none");
    }

    function test_theImmutablesAreTheMediatorAndTheWrappedToken() public view {
        assertEq(address(routerA.bridge()), address(mediatorA));
        assertEq(address(routerA.wNative()), address(weth));
    }

    function test_theRouterHasNoOwner() public view {
        bytes4[3] memory selectors = [
            bytes4(keccak256("owner()")),
            bytes4(keccak256("claimTokens(address,address)")),
            bytes4(keccak256("transferOwnership(address)"))
        ];
        for (uint256 i = 0; i < selectors.length; i++) {
            (bool ok,) = address(routerA).staticcall(abi.encodeWithSelector(selectors[i], address(1), address(2)));
            assertFalse(ok);
        }
    }
}
