// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {TokenMediator} from "../../../src/hardened/mediator/TokenMediator.sol";
import {WETHOmnibridgeRouter} from "../../../src/hardened/mediator/WETHOmnibridgeRouter.sol";
import {IWETH} from "../../../src/hardened/mediator/IWETH.sol";
import {ITokenMediator} from "../../../src/hardened/mediator/ITokenMediator.sol";
import {
    MediatorFixture,
    MockAMB,
    MockWrappedNative,
    RecordingReceiver,
    CoinRefuser,
    GasBurner,
    CoinReverter,
    ContractWallet
} from "./utils/MediatorSupport.sol";

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

    /// @dev Sends `value` of the wrapped token back to the router with `receiver` as data and delivers the message with
    /// exactly the gas limit that the mediator asked for. Returns whether the delivery passed.
    function _returnCoin(address receiver, uint256 value) internal returns (bool ok) {
        vm.prank(alice);
        routerA.wrapAndRelayTokens{value: value}(bob);
        _deliverAtoB(_lastIndexA());
        address copy = _copyOf(address(weth));
        vm.startPrank(bob);
        IERC20(copy).approve(address(mediatorB), type(uint256).max);
        mediatorB.relayTokensAndCall(copy, address(routerA), value, abi.encodePacked(receiver));
        vm.stopPrank();
        uint256 index = _lastIndexB();
        assertEq(
            ambB.messageAt(index).gasLimit,
            mediatorB.RELEASE_GAS_LIMIT() + mediatorB.CALLBACK_GAS_LIMIT(),
            "the gas limit of a release with a call"
        );
        (ok,) = _deliverBtoA(index);
    }

    function _assertRouterHoldsNothing() internal view {
        assertEq(weth.balanceOf(address(routerA)), 0, "no wrapped token stays in the router");
        assertEq(address(routerA).balance, 0, "no coin stays in the router");
    }

    /// Claim: a receiver that burns all the gas it is given cannot strand the value. Shows: at exactly the gas limit of
    /// the message, the router gives the receiver 50,000 gas, keeps the rest, wraps the coin again and sends the wrapped
    /// token. The delivery passes and the router holds nothing. Matters: with all gas forwarded, the receiver would
    /// leave nothing for the fallback, the callback would fail without effect, and the tokens would sit in a router
    /// with no owner.
    function test_aReceiverThatBurnsAllItsGasGetsTheWrappedTokenAtTheExactGasLimit() public {
        GasBurner burner = new GasBurner();
        assertTrue(_returnCoin(address(burner), 2 ether), "the delivery does not run out of gas");
        assertEq(weth.balanceOf(address(burner)), 2 ether);
        assertEq(address(burner).balance, 0);
        _assertRouterHoldsNothing();
    }

    function test_aReceiverThatRevertsGetsTheWrappedToken() public {
        CoinReverter reverter = new CoinReverter();
        assertTrue(_returnCoin(address(reverter), 2 ether));
        assertEq(weth.balanceOf(address(reverter)), 2 ether);
        _assertRouterHoldsNothing();
    }

    function test_aContractWalletThatNeedsSomeGasGetsTheCoin() public {
        ContractWallet wallet = new ContractWallet();
        assertTrue(_returnCoin(address(wallet), 2 ether));
        assertEq(address(wallet).balance, 2 ether, "the wallet took the coin with the gas it was given");
        assertEq(wallet.received(), 1);
        assertEq(weth.balanceOf(address(wallet)), 0);
        _assertRouterHoldsNothing();
    }

    function test_theGasGivenToTheReceiverIsFixed() public view {
        assertEq(routerA.NATIVE_SEND_GAS(), 50_000);
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
