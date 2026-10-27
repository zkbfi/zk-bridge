// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Vm} from "forge-std/Vm.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {DeliveryRouter} from "../../../src/hardened/mediator/DeliveryRouter.sol";
import {MessageBridge} from "../../../src/hardened/MessageBridge.sol";
import {IWETH} from "../../../src/hardened/mediator/IWETH.sol";
import {ITokenMediator} from "../../../src/hardened/mediator/ITokenMediator.sol";
import {MediatorFixture, MockWrappedNative} from "./utils/MediatorSupport.sol";
import {MedHookedDenyListToken} from "./utils/MedMocks.sol";

/// @notice The sweep recovers what reached the router with no callback and no record: a plain relay that names the
/// router as the receiver, a plain transfer, or a hand-off that the token refused. It hands the whole balance of the
/// token off to the failed delivery address. When the token refuses that address, the tokens stay and the router emits
/// `HandOffRefused`. The tokens are native to chain A. Senders on chain B relay the copy back, so the router on chain A receives the native token.
contract DeliveryRouterSweepTest is MediatorFixture {
    MockWrappedNative internal weth;
    MedHookedDenyListToken internal token;
    DeliveryRouter internal router;
    address internal reward = makeAddr("reward address");
    address internal recipient = makeAddr("recipient");
    address internal failedDelivery = makeAddr("failed delivery address");
    address internal copy;

    event Swept(address indexed token, uint256 amount);
    event HandOffRefused(address indexed token, uint256 amount);
    event DeliveryFailed(address indexed token, address indexed recipient, uint256 amount, DeliveryRouter.Reason reason);

    function setUp() public override {
        super.setUp();
        weth = new MockWrappedNative();
        router = new DeliveryRouter(ITokenMediator(address(mediatorA)), IWETH(address(weth)), reward, failedDelivery);
        token = new MedHookedDenyListToken();
        token.mint(alice, 1_000_000 ether);
        vm.startPrank(alice);
        token.approve(address(mediatorA), type(uint256).max);
        mediatorA.relayTokens(address(token), alice, 500_000 ether);
        vm.stopPrank();
        _deliverAtoB(_lastIndexA());
        copy = _copyOf(address(token));
        vm.startPrank(alice);
        IERC20(copy).approve(address(mediatorB), type(uint256).max);
        vm.stopPrank();
    }

    // ------------------------------------------------------------------------------------------------ helpers

    /// @dev A plain relay: the mediator pays the router and makes no callback. The router holds the amount.
    function _plainRelayToRouter(uint256 value) internal {
        vm.prank(alice);
        mediatorB.relayTokens(copy, address(router), value);
        (bool ok,) = _deliverBtoA(_lastIndexB());
        assertTrue(ok, "the plain relay failed");
    }

    /// @dev A delivery whose payout to the recipient is refused, with a refused hand-off: the router keeps `value` less
    /// the tip of 5.
    function _stickAHandOff(uint256 value) internal {
        token.setDenied(recipient, true);
        token.setDenied(failedDelivery, true);
        bytes memory terms = abi.encode(DeliveryRouter.FeeDirector(recipient, router.FIXED_FEE(), 5 ether, 0));
        vm.prank(alice);
        mediatorB.relayTokensAndCall(copy, address(router), value, terms);
        uint256 index = _lastIndexB();
        vm.prank(bob, bob);
        router.executeMessage(ambA.proofOf(ambB, index));
    }

    // ------------------------------------------------------------------------------------------------ the sweep

    /// Claim: tokens that a plain relay left in the router are recovered by anyone. Shows: the router holds 10 with no
    /// record, a stranger calls `sweep`, the failed delivery address receives exactly 10, the event names the token
    /// and the amount, and the caller gets nothing. Matters: the router has no owner, so a plain relay to it would
    /// otherwise lock the tokens for good.
    function test_aPlainRelayToTheRouterIsSweptToTheFailedDeliveryAddress() public {
        _plainRelayToRouter(10 ether);
        assertEq(token.balanceOf(address(router)), 10 ether, "the router holds the plain relay");

        vm.expectEmit(true, false, false, true, address(router));
        emit Swept(address(token), 10 ether);
        vm.prank(bob);
        router.sweep(address(token));

        assertEq(token.balanceOf(failedDelivery), 10 ether, "the failed delivery address gets the balance");
        assertEq(token.balanceOf(address(router)), 0, "the router keeps nothing");
        assertEq(token.balanceOf(bob), 0, "the caller earns nothing");
    }

    /// Claim: a plain transfer of a stranger is swept the same way.
    function test_aPlainTransferToTheRouterIsSwept() public {
        vm.prank(alice);
        token.transfer(address(router), 3 ether);
        vm.expectEmit(true, false, false, true, address(router));
        emit Swept(address(token), 3 ether);
        router.sweep(address(token));
        assertEq(token.balanceOf(failedDelivery), 3 ether);
        assertEq(token.balanceOf(address(router)), 0);
    }

    /// Claim: with nothing in the router, the sweep reverts and changes nothing. Shows: an empty router reverts with
    /// `NothingToSweep`, and so does a second sweep after a first one emptied the router.
    function test_aSweepWithAnEmptyRouterReverts() public {
        vm.expectRevert(abi.encodeWithSelector(DeliveryRouter.NothingToSweep.selector, address(token)));
        router.sweep(address(token));

        _plainRelayToRouter(1 ether);
        router.sweep(address(token));
        vm.expectRevert(abi.encodeWithSelector(DeliveryRouter.NothingToSweep.selector, address(token)));
        router.sweep(address(token));
        assertEq(token.balanceOf(failedDelivery), 1 ether);
    }

    /// Claim: the sweep sends the whole balance, whatever its origin. Shows: the router holds 95 from a refused
    /// hand-off and 7 from a plain relay. One sweep sends 102 and the event names 102. Matters: the router keeps no
    /// record, so the balance is all there is, and a sweep that left part of it would strand that part.
    function test_aSweepSendsTheWholeBalance() public {
        _stickAHandOff(100 ether);
        token.setDenied(failedDelivery, false);
        _plainRelayToRouter(7 ether);
        assertEq(token.balanceOf(address(router)), 102 ether);

        vm.expectEmit(true, false, false, true, address(router));
        emit Swept(address(token), 102 ether);
        router.sweep(address(token));

        assertEq(token.balanceOf(failedDelivery), 102 ether, "the whole balance");
        assertEq(token.balanceOf(address(router)), 0);
    }

    /// Claim: a token that refuses the failed delivery address does not make the sweep revert, burn or report a sweep.
    /// Shows: the sweep emits `HandOffRefused` with the amount and no `Swept`, the tokens stay, and nothing reverts.
    /// Once the token allows the address, the second sweep pays it and emits `Swept`. Matters: a refused sweep must not
    /// claim a transfer that did not happen.
    function test_aSweepThatTheTokenRefusesLeavesTheTokensAndEmitsHandOffRefused() public {
        _plainRelayToRouter(10 ether);
        token.setDenied(failedDelivery, true);

        vm.recordLogs();
        router.sweep(address(token));
        Vm.Log[] memory logs = vm.getRecordedLogs();
        uint256 refused;
        for (uint256 i = 0; i < logs.length; i++) {
            if (logs[i].emitter != address(router)) continue;
            assertEq(logs[i].topics[0], HandOffRefused.selector, "no event but the refusal");
            assertEq(logs[i].topics[1], bytes32(uint256(uint160(address(token)))));
            assertEq(logs[i].data, abi.encode(10 ether));
            refused++;
        }
        assertEq(refused, 1, "exactly one refusal event, and no Swept");
        assertEq(token.balanceOf(address(router)), 10 ether, "the tokens stay");
        assertEq(token.balanceOf(failedDelivery), 0);

        token.setDenied(failedDelivery, false);
        vm.expectEmit(true, false, false, true, address(router));
        emit Swept(address(token), 10 ether);
        router.sweep(address(token));
        assertEq(token.balanceOf(failedDelivery), 10 ether);
        assertEq(token.balanceOf(address(router)), 0);
    }

    /// Claim: the sweep works for any token, the wrapped native token included, and tokens of one kind do not move the
    /// other. Shows: a stray 2 of the wrapped token is swept while the stuck tokens of the other token stay.
    function test_aSweepOfOneTokenLeavesTheBalanceOfAnotherToken() public {
        _stickAHandOff(100 ether);
        vm.deal(alice, 2 ether);
        vm.startPrank(alice);
        weth.deposit{value: 2 ether}();
        weth.transfer(address(router), 2 ether);
        vm.stopPrank();
        router.sweep(address(weth));
        assertEq(weth.balanceOf(failedDelivery), 2 ether);
        assertEq(token.balanceOf(address(router)), 95 ether);
    }

    /// Claim: a sweep cannot run inside a delivery. Shows: while a delivery pays the recipient, a payout hook calls
    /// `sweep`. The call reverts on the guard, the stray balance stays, and the delivery completes. Matters: a hook must
    /// not move balances that a delivery counts on.
    function test_aSweepFromAPayoutHookIsRefusedWhileADeliveryRuns() public {
        _plainRelayToRouter(4 ether);
        bytes memory terms = abi.encode(DeliveryRouter.FeeDirector(recipient, 0, 0, 0));
        vm.prank(alice);
        mediatorB.relayTokensAndCall(copy, address(router), 50 ether, terms);
        uint256 index = _lastIndexB();
        token.arm(recipient, address(router), abi.encodeCall(DeliveryRouter.sweep, (address(token))));

        vm.prank(bob, bob);
        router.executeMessage(ambA.proofOf(ambB, index));

        assertEq(token.hooksRun(), 1, "the hook ran");
        assertEq(token.balanceOf(recipient), 50 ether, "the delivery paid in full");
        assertEq(token.balanceOf(address(router)), 4 ether, "the stray balance stayed");
        assertEq(token.balanceOf(failedDelivery), 0);
        router.sweep(address(token));
        assertEq(token.balanceOf(failedDelivery), 4 ether, "swept after the delivery");
    }

    /// Claim: for any stuck amount and any stray amount, one sweep sends the sum and the router ends empty.
    function testFuzz_aSweepSendsTheWholeBalance(uint96 delivered, uint96 stray) public {
        uint256 deliveredAmount = bound(delivered, 6 ether, 1_000 ether);
        uint256 strayAmount = bound(stray, 1, 1_000 ether);
        _stickAHandOff(deliveredAmount);
        token.setDenied(failedDelivery, false);
        _plainRelayToRouter(strayAmount);
        uint256 held = token.balanceOf(address(router));
        assertEq(held, deliveredAmount - 5 ether + strayAmount);

        router.sweep(address(token));

        assertEq(token.balanceOf(failedDelivery), held, "the whole balance");
        assertEq(token.balanceOf(address(router)), 0);
    }
}
