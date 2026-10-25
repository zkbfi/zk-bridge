// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {TokenMediator} from "../../../src/hardened/mediator/TokenMediator.sol";
import {WETHOmnibridgeRouter} from "../../../src/hardened/mediator/WETHOmnibridgeRouter.sol";
import {IWETH} from "../../../src/hardened/mediator/IWETH.sol";
import {ITokenMediator} from "../../../src/hardened/mediator/ITokenMediator.sol";
import {MediatorFixture, MockAMB, MockWrappedNative, RecordingReceiver, CoinRefuser} from "./utils/MediatorSupport.sol";

/// @notice Tests of the router that wraps the native coin on the way out and unwraps it on delivery.
contract WETHOmnibridgeRouterTest is MediatorFixture {
    MockWrappedNative internal weth;
    WETHOmnibridgeRouter internal routerA;

    function setUp() public override {
        super.setUp();
        weth = new MockWrappedNative();
        routerA = new WETHOmnibridgeRouter(ITokenMediator(address(mediatorA)), IWETH(address(weth)));
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

    function test_wrapAndRelayTokensToAReceiverNamesTheCallerAsFallback() public {
        vm.prank(alice);
        routerA.wrapAndRelayTokens{value: 1 ether}(bob);
        bytes memory expected = abi.encodeWithSelector(
            TokenMediator.deployAndHandleBridgedTokensWithFallback.selector,
            address(weth),
            "Wrapped Native",
            "WNAT",
            uint8(18),
            bob,
            1 ether,
            alice
        );
        assertEq(ambA.messageAt(0).data, expected, "the fallback is the caller, not the router");
        _deliverAtoB(0);
        assertEq(IERC20(_copyOf(address(weth))).balanceOf(bob), 1 ether);
    }

    function test_theCoinComesBackUnwrappedThroughTheRouter() public {
        vm.prank(alice);
        routerA.wrapAndRelayTokens{value: 3 ether}(bob);
        _deliverAtoB(0);
        address copy = _copyOf(address(weth));
        assertEq(weth.totalSupply(), 3 ether);

        uint256 carolBefore = carol.balance;
        vm.startPrank(bob);
        IERC20(copy).approve(address(mediatorB), type(uint256).max);
        mediatorB.relayTokensAndCall(copy, address(routerA), 3 ether, abi.encodePacked(carol));
        vm.stopPrank();
        (bool ok,) = _deliverBtoA(0);
        assertTrue(ok);

        assertEq(carol.balance - carolBefore, 3 ether, "the receiver gets the coin");
        assertEq(weth.totalSupply(), 0, "the wrapped token is burned by the unwrap");
        assertEq(weth.balanceOf(address(routerA)), 0);
        assertEq(address(routerA).balance, 0);
        assertEq(mediatorA.mediatorBalance(address(weth)), 0);
    }

    function test_aReceiverThatCannotTakeTheCoinGetsTheWrappedToken() public {
        vm.prank(alice);
        routerA.wrapAndRelayTokens{value: 1 ether}(bob);
        _deliverAtoB(0);
        address copy = _copyOf(address(weth));
        CoinRefuser refuser = new CoinRefuser();

        vm.startPrank(bob);
        IERC20(copy).approve(address(mediatorB), type(uint256).max);
        mediatorB.relayTokensAndCall(copy, address(routerA), 1 ether, abi.encodePacked(address(refuser)));
        vm.stopPrank();
        _deliverBtoA(0);

        assertEq(weth.balanceOf(address(refuser)), 1 ether, "paid as the wrapped token, not stranded");
        assertEq(weth.balanceOf(address(routerA)), 0);
        assertEq(address(routerA).balance, 0);
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
        vm.expectRevert(WETHOmnibridgeRouter.EmptyData.selector);
        routerA.relayTokensAndCall{value: 1 ether}(bob, "");
    }

    function test_onlyTheMediatorCanCallOnTokenBridged() public {
        vm.prank(bob);
        vm.expectRevert(abi.encodeWithSelector(WETHOmnibridgeRouter.NotMediator.selector, bob));
        routerA.onTokenBridged(address(weth), 1, abi.encodePacked(carol));
    }

    function test_onTokenBridgedRefusesAnotherTokenAndBadData() public {
        vm.startPrank(address(mediatorA));
        vm.expectRevert(abi.encodeWithSelector(WETHOmnibridgeRouter.NotWrappedToken.selector, address(tokenA)));
        routerA.onTokenBridged(address(tokenA), 1, abi.encodePacked(carol));
        vm.expectRevert(abi.encodeWithSelector(WETHOmnibridgeRouter.InvalidReceiverData.selector, uint256(19)));
        routerA.onTokenBridged(address(weth), 1, new bytes(19));
        vm.stopPrank();
    }

    function test_theRouterTakesTheCoinOnlyFromTheWrappedToken() public {
        vm.prank(bob);
        (bool ok, bytes memory returned) = address(routerA).call{value: 1 ether}("");
        assertFalse(ok);
        assertEq(returned, abi.encodeWithSelector(WETHOmnibridgeRouter.NotWrappedTokenSender.selector, bob));
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
