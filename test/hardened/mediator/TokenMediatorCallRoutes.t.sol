// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {MockERC20} from "../../mocks/MockERC20.sol";
import {TokenMediator} from "../../../src/hardened/mediator/TokenMediator.sol";
import {MediatorFixture, MockAMB, RecordingReceiver, TEST_CALLBACK_GAS} from "./utils/MediatorSupport.sol";

/// @notice The message forms of a relay with a callback when the sender is also the receiver, so that the sender needs
/// no separate fallback, and the refusals of a message that the other mediator would never send. Each test sends through
/// the real mediators and checks the form of the message, the payout and the callback.
contract TokenMediatorCallRoutesTest is MediatorFixture {
    RecordingReceiver internal selfReceiver;

    function setUp() public override {
        super.setUp();
        selfReceiver = new RecordingReceiver();
        tokenA.mint(address(selfReceiver), 1_000 ether);
        vm.prank(address(selfReceiver));
        tokenA.approve(address(mediatorA), type(uint256).max);
    }

    /// @dev Sends a first message so that the copy exists and the native side learns it, by a trip back to bob.
    function _teachTheNativeSideThatTheCopyExists() internal {
        _bridgeAtoB(alice, address(tokenA), bob, 10 ether);
        _bridgeBtoA(bob, _copyOf(address(tokenA)), bob, 1 ether);
    }

    // ================================================================ lock side

    /// Claim: the first message of a token to itself with a callback deploys the copy, pays the sender, and calls the
    /// sender, with the short form `deployAndHandleBridgedTokensAndCall` that names no fallback. Shows: the selector, the
    /// copy balance of the receiver, and the callback arguments (token is the copy, value, data). Matters: a sender that
    /// is also the receiver is its own fallback, so the message carries one address less.
    function test_selfCall_firstMessageDeploysTheCopyAndCallsTheSender() public {
        vm.prank(address(selfReceiver));
        mediatorA.relayTokensAndCall(address(tokenA), address(selfReceiver), 100 ether, hex"abcd", TEST_CALLBACK_GAS);
        MockAMB.Sent memory message = ambA.messageAt(0);
        assertEq(_selectorOf(message.data), TokenMediator.deployAndHandleBridgedTokensAndCall.selector);

        (bool ok,) = _deliverAtoB(0);
        assertTrue(ok, "delivered");
        address copy = _copyOf(address(tokenA));
        assertTrue(copy != address(0), "the copy exists");
        assertEq(IERC20(copy).balanceOf(address(selfReceiver)), 100 ether, "paid before the call");
        assertEq(selfReceiver.calls(), 1);
        assertEq(selfReceiver.lastCaller(), address(mediatorB));
        assertEq(selfReceiver.lastToken(), copy);
        assertEq(selfReceiver.lastValue(), 100 ether);
        assertEq(selfReceiver.lastData(), hex"abcd");
    }

    /// Claim: once the native side knows the copy exists, a message of a token to itself with a callback has the form
    /// `handleBridgedTokensAndCall`. Shows: the selector and the exact arguments of the message, then the delivery.
    function test_selfCall_afterTheCopyExistsUsesTheShortForm() public {
        _teachTheNativeSideThatTheCopyExists();
        uint256 sentBefore = ambA.sentCount();
        vm.prank(address(selfReceiver));
        mediatorA.relayTokensAndCall(address(tokenA), address(selfReceiver), 7 ether, hex"01", TEST_CALLBACK_GAS);
        MockAMB.Sent memory message = ambA.messageAt(sentBefore);
        assertEq(
            message.data,
            abi.encodeWithSelector(
                TokenMediator.handleBridgedTokensAndCall.selector, address(tokenA), address(selfReceiver), 7 ether, hex"01", TEST_CALLBACK_GAS
            )
        );

        (bool ok,) = _deliverAtoB(sentBefore);
        assertTrue(ok, "delivered");
        assertEq(IERC20(_copyOf(address(tokenA))).balanceOf(address(selfReceiver)), 7 ether);
        assertEq(selfReceiver.lastData(), hex"01");
        assertEq(selfReceiver.lastValue(), 7 ether);
    }

    /// Claim: once the copy exists, a callback relay with another receiver has the form
    /// `handleBridgedTokensAndCall`, with no address of the sender. Shows: the exact message. A receiver
    /// that refuses the callback still keeps the tokens, because the payout comes before the call, and the delivery
    /// emits `CallbackFailed` with the copy, the receiver and the message identifier. Matters: a failed callback must
    /// neither revert the delivery nor move the tokens.
    function test_callToAnotherReceiver_afterTheCopyExistsKeepsThePayoutWhenTheCallRefuses() public {
        _teachTheNativeSideThatTheCopyExists();
        selfReceiver.setRefuse(true);
        uint256 sentBefore = ambA.sentCount();
        vm.prank(alice);
        mediatorA.relayTokensAndCall(address(tokenA), address(selfReceiver), 5 ether, hex"02", TEST_CALLBACK_GAS);
        MockAMB.Sent memory message = ambA.messageAt(sentBefore);
        assertEq(
            message.data,
            abi.encodeWithSelector(
                TokenMediator.handleBridgedTokensAndCall.selector,
                address(tokenA),
                address(selfReceiver),
                5 ether,
                hex"02",
                TEST_CALLBACK_GAS
            )
        );

        address copy = _copyOf(address(tokenA));
        uint256 aliceBefore = IERC20(copy).balanceOf(alice);
        vm.expectEmit(true, true, true, false, address(mediatorB));
        emit TokenMediator.CallbackFailed(copy, address(selfReceiver), message.id);
        (bool ok,) = _deliverAtoB(sentBefore);
        assertTrue(ok, "the delivery itself is final");
        assertEq(IERC20(copy).balanceOf(address(selfReceiver)), 5 ether, "the receiver keeps the payout");
        assertEq(IERC20(copy).balanceOf(alice), aliceBefore, "nobody but the receiver is paid");
        assertEq(selfReceiver.calls(), 0);
    }

    // ================================================================ burn side

    /// Claim: a copy relayed back to its own sender with a callback has the form `handleNativeTokensAndCall`. Shows: the
    /// exact message, the release of the native token to the receiver, and the callback with the native token. Matters:
    /// the native side must pay the same account that sent, with no extra fallback address.
    function test_selfCall_tripBackReleasesAndCallsTheSender() public {
        vm.prank(address(selfReceiver));
        mediatorA.relayTokens(address(tokenA), address(selfReceiver), 50 ether);
        (bool delivered,) = _deliverAtoB(_lastIndexA());
        assertTrue(delivered);
        address copy = _copyOf(address(tokenA));

        vm.startPrank(address(selfReceiver));
        IERC20(copy).approve(address(mediatorB), type(uint256).max);
        mediatorB.relayTokensAndCall(copy, address(selfReceiver), 20 ether, hex"beef", TEST_CALLBACK_GAS);
        vm.stopPrank();
        uint256 index = _lastIndexB();
        assertEq(
            ambB.messageAt(index).data,
            abi.encodeWithSelector(
                TokenMediator.handleNativeTokensAndCall.selector, address(tokenA), address(selfReceiver), 20 ether, hex"beef", TEST_CALLBACK_GAS
            )
        );

        uint256 balanceBefore = tokenA.balanceOf(address(selfReceiver));
        (bool ok,) = _deliverBtoA(index);
        assertTrue(ok, "delivered");
        assertEq(tokenA.balanceOf(address(selfReceiver)), balanceBefore + 20 ether, "the native token is released");
        assertEq(selfReceiver.lastToken(), address(tokenA));
        assertEq(selfReceiver.lastValue(), 20 ether);
        assertEq(selfReceiver.lastData(), hex"beef");
    }

    // ================================================================ refusals

    /// Claim: a message that deploys a copy for a token with no name and no symbol is refused. Shows: the exact error with
    /// the token. The sending mediator never builds such a message, so the bridge sends it by hand. Matters: a copy with
    /// an empty name could not be told from another copy.
    function test_deploy_refusesAMessageThatNamesNothing() public {
        bytes memory call = abi.encodeWithSelector(
            TokenMediator.deployAndHandleBridgedTokens.selector, address(tokenA), "", "", uint8(18), bob, 1 ether
        );
        (bool ok, bytes memory returned) =
            ambB.execute(address(mediatorB), call, address(mediatorA), bytes32(CHAIN_A), bytes32(uint256(1)), 5_000_000);
        assertFalse(ok);
        assertEq(returned, abi.encodeWithSelector(TokenMediator.NoTokenName.selector, address(tokenA)));
        assertEq(_copyOf(address(tokenA)), address(0), "no copy was deployed");
    }

    /// Claim: the locked balance of one native token cannot pass the largest value of its record. Shows: a token with a
    /// supply above that limit reverts with `MediatorBalanceOverflow` on the send that would pass it, and the send up to
    /// the limit works. Matters: the record packs the balance in 240 bits, and a wrap would unlock too much.
    function test_lock_refusesABalanceAboveTheRecordLimit() public {
        uint256 limit = type(uint240).max;
        MockERC20 whale = new MockERC20("Whale", "WHL");
        whale.mint(alice, limit + 1);
        vm.startPrank(alice);
        whale.approve(address(mediatorA), type(uint256).max);
        mediatorA.relayTokens(address(whale), bob, limit);
        assertEq(mediatorA.mediatorBalance(address(whale)), limit);
        vm.expectRevert(abi.encodeWithSelector(TokenMediator.MediatorBalanceOverflow.selector, address(whale)));
        mediatorA.relayTokens(address(whale), bob, 1);
        vm.stopPrank();
        assertEq(mediatorA.mediatorBalance(address(whale)), limit, "the record did not move");
    }
}
