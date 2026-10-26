// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {MockERC20} from "../../../src/mocks/MockERC20.sol";
import {DeliveryRouter} from "../../../src/hardened/mediator/DeliveryRouter.sol";
import {MessageBridge} from "../../../src/hardened/MessageBridge.sol";
import {IWETH} from "../../../src/hardened/mediator/IWETH.sol";
import {ITokenMediator} from "../../../src/hardened/mediator/ITokenMediator.sol";
import {MediatorFixture, DenyListToken, CoinRefuser} from "./utils/MediatorSupport.sol";
import {MedCutToken, MedDenyListWrappedNative, MedToggleReceiver} from "./utils/MedMocks.sol";

/// @notice The router never keeps a delivery that it cannot pay, and never burns it. It takes the tip first when the
/// delivery path takes a tip, then hands the rest off to the failed delivery address and emits `DeliveryFailed`. Only
/// when a token refuses that address too does the router keep a record for it, which anyone may claim. These tests
/// cover each hand-off: a token that refuses the recipient, terms that decode but name nobody who can receive, data of
/// no known shape, a legacy receiver, the native coin, and a refused refund of a gas based fee. Tokens flow from chain B
/// back to the router on chain A.
contract DeliveryRouterClaimsTest is MediatorFixture {
    MedDenyListWrappedNative internal weth;
    DenyListToken internal token;
    DeliveryRouter internal router;
    address internal reward = makeAddr("reward address");
    address internal recipient = makeAddr("recipient");
    address internal failedDelivery = makeAddr("failed delivery address");
    address internal copy;

    event DeliveryFailed(address indexed token, address indexed recipient, uint256 amount, DeliveryRouter.Reason reason);
    event Claimed(address indexed token, uint256 amount);

    function setUp() public override {
        super.setUp();
        weth = new MedDenyListWrappedNative();
        router = new DeliveryRouter(ITokenMediator(address(mediatorA)), IWETH(address(weth)), reward, failedDelivery);
        token = new DenyListToken();
        token.mint(alice, 1_000_000 ether);
        vm.startPrank(alice);
        token.approve(address(mediatorA), type(uint256).max);
        mediatorA.relayTokens(address(token), alice, 500_000 ether);
        vm.stopPrank();
        _deliverAtoB(_lastIndexA());
        copy = _copyOf(address(token));
        vm.deal(alice, 1_000 ether);
    }

    // ------------------------------------------------------------------------------------------------ helpers

    function _share(address to, uint256 settings, uint256 limit, uint256 multiplier)
        internal
        pure
        returns (DeliveryRouter.FeeDirector memory)
    {
        return DeliveryRouter.FeeDirector(to, settings, limit, multiplier);
    }

    /// @dev Sends the copy of the deny list token from chain B to the router, with `data`, and returns the message.
    function _sendCopy(bytes memory data, uint256 value) internal returns (uint256) {
        vm.startPrank(alice);
        IERC20(copy).approve(address(mediatorB), type(uint256).max);
        mediatorB.relayTokensAndCall(copy, address(router), value, data);
        vm.stopPrank();
        return _lastIndexB();
    }

    /// @dev Sends the wrapped token of chain A to chain B and back to the router, with `data`.
    function _sendWrapped(bytes memory data, uint256 value) internal returns (uint256) {
        vm.startPrank(alice);
        weth.deposit{value: value}();
        weth.approve(address(mediatorA), type(uint256).max);
        vm.stopPrank();
        _bridgeAtoB(alice, address(weth), alice, value);
        address wrappedCopy = _copyOf(address(weth));
        vm.startPrank(alice);
        IERC20(wrappedCopy).approve(address(mediatorB), type(uint256).max);
        mediatorB.relayTokensAndCall(wrappedCopy, address(router), value, data);
        vm.stopPrank();
        return _lastIndexB();
    }

    function _run(uint256 index) internal {
        MessageBridge.MessageProof memory proof = ambA.proofOf(ambB, index);
        vm.prank(bob, bob);
        router.executeMessage(proof);
    }

    /// @dev Delivers the message, then checks that the bridge saw a successful call.
    function _deliver(uint256 index) internal {
        (bool ok,) = _deliverBtoA(index);
        assertTrue(ok, "the delivery reverted");
    }

    /// @dev Expects the hand-off event of the router.
    function _expectHandOff(address handedToken, address named, uint256 amount, DeliveryRouter.Reason reason) internal {
        vm.expectEmit(true, true, false, true, address(router));
        emit DeliveryFailed(handedToken, named, amount, reason);
    }

    /// @dev The router holds nothing of a token, and no coin.
    function _assertRouterEmpty(address heldToken) internal view {
        assertEq(IERC20(heldToken).balanceOf(address(router)), 0, "the router holds none of the token");
        assertEq(address(router).balance, 0, "the router holds no coin");
        assertEq(router.totalClaimable(heldToken), 0, "nothing is recorded");
    }

    // ------------------------------------------------------------------------------------------------ a token refuses the recipient

    /// Claim: a token that refuses the recipient hands the rest off, and the tip is still paid. Shows: the reward
    /// address gets the fixed fee, the failed delivery address gets the rest, the event names the recipient, and the
    /// router keeps nothing. Matters: the router has no owner, so an unhandled balance would be lost for good.
    function test_aTokenThatRefusesTheRecipientHandsTheRestOffAfterTheTip() public {
        token.setDenied(recipient, true);
        uint256 index = _sendCopy(abi.encode(_share(recipient, 1, 5 ether, 0)), 100 ether);

        _expectHandOff(address(token), recipient, 95 ether, DeliveryRouter.Reason.PayoutRefused);
        _run(index);

        assertEq(token.balanceOf(reward), 5 ether, "the tip");
        assertEq(token.balanceOf(recipient), 0);
        assertEq(token.balanceOf(failedDelivery), 95 ether, "the hand-off");
        _assertRouterEmpty(address(token));
    }

    /// Claim: a refused payout does not block the message when no one calls the router. Shows: a direct execution takes
    /// no tip, and the failed delivery address gets the whole value. Matters: the bridge stays permissionless.
    function test_aDirectDeliveryToARefusedRecipientHandsTheWholeValueOff() public {
        token.setDenied(recipient, true);
        _deliver(_sendCopy(abi.encode(_share(recipient, 1, 5 ether, 0)), 100 ether));
        assertEq(token.balanceOf(failedDelivery), 100 ether);
        assertEq(token.balanceOf(reward), 0, "no tip");
        _assertRouterEmpty(address(token));
    }

    /// Claim: a refused refund of a gas based fee is handed off. Shows: the reward address gets the fee, and the
    /// failed delivery address gets the rest: the part paid in the callback and the held cap less the fee.
    function test_aGasBasedRefundThatTheTokenRefusesIsHandedOff() public {
        vm.txGasPrice(10 gwei);
        token.setDenied(recipient, true);
        _run(_sendCopy(abi.encode(_share(recipient, 0, 50 ether, 1 ether)), 100 ether));

        uint256 fee = token.balanceOf(reward);
        assertGt(fee, 0, "a fee was paid");
        assertEq(token.balanceOf(failedDelivery), 100 ether - fee, "the rest is handed off");
        _assertRouterEmpty(address(token));
    }

    // ------------------------------------------------------------------------------------------------ the push fails too

    /// Claim: a token that blocks the failed delivery address as well leaves a record, never a burn. Shows: the
    /// tip is paid, the amount is recorded for the failed delivery address only, the router holds exactly that, and the
    /// event is still emitted. Matters: the tokens must stay owed to someone.
    function test_aHandOffThatTheTokenRefusesIsRecordedForTheFailedDeliveryAddress() public {
        token.setDenied(recipient, true);
        token.setDenied(failedDelivery, true);
        uint256 index = _sendCopy(abi.encode(_share(recipient, 1, 5 ether, 0)), 100 ether);

        _expectHandOff(address(token), recipient, 95 ether, DeliveryRouter.Reason.PayoutRefused);
        _run(index);

        assertEq(token.balanceOf(reward), 5 ether, "the tip");
        assertEq(router.claimable(address(token), failedDelivery), 95 ether, "the record");
        assertEq(router.claimable(address(token), recipient), 0, "the recipient has no record");
        assertEq(router.totalClaimable(address(token)), 95 ether);
        assertEq(token.balanceOf(address(router)), 95 ether, "the balance equals the record");
    }

    /// Claim: the claim waits for the token, pays only the failed delivery address, and pays once. Shows: the first
    /// call reverts and the record stays; once the token allows the address, anyone can pay it, and the caller gets
    /// nothing. A second call has nothing to pay.
    function test_aClaimWaitsForTheTokenAndPaysOnlyTheFailedDeliveryAddress() public {
        token.setDenied(recipient, true);
        token.setDenied(failedDelivery, true);
        _run(_sendCopy(abi.encode(_share(recipient, 1, 5 ether, 0)), 100 ether));

        vm.expectRevert();
        router.claim(address(token));
        assertEq(router.claimable(address(token), failedDelivery), 95 ether, "the record stays");

        token.setDenied(failedDelivery, false);
        vm.expectEmit(true, false, false, true, address(router));
        emit Claimed(address(token), 95 ether);
        vm.prank(bob);
        router.claim(address(token));

        assertEq(token.balanceOf(failedDelivery), 95 ether, "paid to the address, not the caller");
        assertEq(token.balanceOf(bob), 0);
        _assertRouterEmpty(address(token));
        vm.expectRevert(abi.encodeWithSelector(DeliveryRouter.NothingToClaim.selector, address(token)));
        router.claim(address(token));
    }

    /// Claim: a delivery is never paid out of a record. Shows: with 40 recorded for the failed delivery address, a later
    /// delivery of 100 of a token that takes a cut arrives as 90, pays 90 to its recipient, and leaves the 40 alone.
    /// Matters: the balance of the router includes the record, and a payout from the whole balance would take from it.
    function test_aDeliveryIsNeverPaidFromTheRecord() public {
        MedCutToken cutToken = new MedCutToken();
        cutToken.mint(alice, 1_000 ether);
        vm.startPrank(alice);
        cutToken.approve(address(mediatorA), type(uint256).max);
        mediatorA.relayTokens(address(cutToken), alice, 500 ether);
        vm.stopPrank();
        _deliverAtoB(_lastIndexA());
        address cutCopy = _copyOf(address(cutToken));

        token.setDenied(bob, true);
        token.setDenied(failedDelivery, true);
        _run(_sendCopy(abi.encode(_share(bob, 0, 0, 0)), 40 ether));
        assertEq(router.totalClaimable(address(token)), 40 ether);

        cutToken.setCut(address(mediatorA), 1_000);
        vm.startPrank(alice);
        IERC20(cutCopy).approve(address(mediatorB), type(uint256).max);
        mediatorB.relayTokensAndCall(cutCopy, address(router), 100 ether, abi.encode(_share(recipient, 0, 0, 0)));
        vm.stopPrank();
        _run(_lastIndexB());
        assertEq(cutToken.balanceOf(recipient), 90 ether);
        assertEq(cutToken.balanceOf(address(router)), 0);
        assertEq(token.balanceOf(address(router)), 40 ether, "the record of another token is untouched");
    }

    /// Claim: the failed delivery address may equal the reward address. Shows: the tip and the hand-off both reach it.
    function test_theFailedDeliveryAddressMayEqualTheRewardAddress() public {
        router = new DeliveryRouter(ITokenMediator(address(mediatorA)), IWETH(address(weth)), reward, reward);
        token.setDenied(recipient, true);
        _run(_sendCopy(abi.encode(_share(recipient, 1, 5 ether, 0)), 100 ether));
        assertEq(token.balanceOf(reward), 100 ether, "tip plus hand-off");
        _assertRouterEmpty(address(token));
    }

    // ------------------------------------------------------------------------------------------------ invalid terms

    /// Claim: terms that decode but name the router take the tip by their own terms, and the rest is handed off. Shows:
    /// the reward address gets the fixed fee, and the failed delivery address gets the rest.
    function test_theRouterAsRecipientPaysTheTipAndHandsTheRestOff() public {
        uint256 index = _sendCopy(abi.encode(_share(address(router), 1, 5 ether, 0)), 100 ether);
        _expectHandOff(address(token), address(router), 95 ether, DeliveryRouter.Reason.InvalidTerms);
        _run(index);

        assertEq(token.balanceOf(reward), 5 ether, "the tip");
        assertEq(token.balanceOf(failedDelivery), 95 ether);
        _assertRouterEmpty(address(token));
    }

    /// Claim: the zero address as recipient is handled like the router, with the share fee of the terms. Shows: a share
    /// of 10 percent is the tip, and the rest is handed off with the zero address named. Matters: nothing is sent to
    /// the zero address.
    function test_theZeroAddressAsRecipientPaysTheShareAndHandsTheRestOff() public {
        uint256 index = _sendCopy(abi.encode(_share(address(0), 8, 0, 0.1 ether)), 100 ether);
        _expectHandOff(address(token), address(0), 90 ether, DeliveryRouter.Reason.InvalidTerms);
        _run(index);

        assertEq(token.balanceOf(reward), 10 ether);
        assertEq(token.balanceOf(failedDelivery), 90 ether);
        assertEq(token.balanceOf(address(0)), 0);
        _assertRouterEmpty(address(token));
    }

    /// Claim: invalid terms respect the cap of a gas based fee. Shows: the fee is below the cap of 3 and the rest,
    /// the held cap less the fee included, is handed off. Matters: the settlement runs after the callback and sends the
    /// refund to the recipient of the terms.
    function test_invalidTermsWithAGasBasedFeeSettleAndHandTheRestOff() public {
        vm.txGasPrice(10 gwei);
        _run(_sendCopy(abi.encode(_share(address(0), 0, 3 ether, 1 ether)), 100 ether));
        uint256 fee = token.balanceOf(reward);
        assertGt(fee, 0);
        assertLe(fee, 3 ether, "within the cap");
        assertEq(token.balanceOf(failedDelivery), 100 ether - fee);
        _assertRouterEmpty(address(token));
    }

    /// Claim: a direct delivery with invalid terms takes no tip. Shows: the failed delivery address gets everything.
    function test_aDirectDeliveryWithInvalidTermsHandsTheWholeValueOff() public {
        _deliver(_sendCopy(abi.encode(_share(address(router), 1, 5 ether, 0)), 100 ether));
        assertEq(token.balanceOf(failedDelivery), 100 ether);
        assertEq(token.balanceOf(reward), 0);
    }

    /// Claim: a director whose recipient word has bits above 160 is data of no known shape, so the callback does not
    /// revert and the whole value is handed off. Shows: a 128 byte director with a dirty first word, delivered through
    /// the router, ends at the failed delivery address in full, the reward address gets no tip, and the event names the
    /// zero address. Matters: `abi.decode` would revert on that word, and a revert in the callback strands the tokens.
    function test_aDirtyRecipientWordHandsTheWholeValueOff() public {
        bytes memory dirty = abi.encode(_share(recipient, 1, 5 ether, 0));
        dirty[0] = 0x01;
        uint256 index = _sendCopy(dirty, 40 ether);
        _expectHandOff(address(token), address(0), 40 ether, DeliveryRouter.Reason.InvalidTerms);
        _run(index);
        assertEq(token.balanceOf(failedDelivery), 40 ether, "the whole value is handed off");
        assertEq(token.balanceOf(reward), 0, "no tip");
        assertEq(token.balanceOf(recipient), 0);
        _assertRouterEmpty(address(token));
    }

    /// Claim: data of no known shape has no tip to compute, so the whole value is handed off, even when the caller
    /// executes it. Shows: seven bytes and 127 bytes both reach the failed delivery address in full, and the delivery
    /// succeeds. Matters: a revert in the callback leaves the tokens in the router, because the mediator has paid it.
    function test_dataOfNoKnownShapeHandsTheWholeValueOff() public {
        uint256 index = _sendCopy(hex"01020304050607", 10 ether);
        _expectHandOff(address(token), address(0), 10 ether, DeliveryRouter.Reason.InvalidTerms);
        _run(index);
        _run(_sendCopy(new bytes(127), 20 ether));
        assertEq(token.balanceOf(failedDelivery), 30 ether);
        assertEq(token.balanceOf(reward), 0, "no tip");
        _assertRouterEmpty(address(token));
    }

    /// Claim: a legacy receiver that is the router or the zero address is handed off, with no fee. Shows: both reach the
    /// failed delivery address in full.
    function test_aLegacyReceiverThatIsTheRouterOrZeroIsHandedOff() public {
        _run(_sendCopy(abi.encodePacked(address(router)), 10 ether));
        _run(_sendCopy(abi.encodePacked(address(0)), 20 ether));
        assertEq(token.balanceOf(failedDelivery), 30 ether);
        assertEq(token.balanceOf(reward), 0);
        _assertRouterEmpty(address(token));
    }

    // ------------------------------------------------------------------------------------------------ legacy form

    /// Claim: the legacy form with a token that is not the wrapped native token pays the token to the receiver. Shows:
    /// the receiver gets the whole value as the token, with no fee, and the router holds nothing.
    function test_theLegacyFormPaysAnotherTokenToTheReceiverWithNoFee() public {
        _run(_sendCopy(abi.encodePacked(carol), 100 ether));
        assertEq(token.balanceOf(carol), 100 ether);
        assertEq(token.balanceOf(reward), 0, "no fee");
        _assertRouterEmpty(address(token));
    }

    /// Claim: the legacy form to a receiver that the token refuses is handed off in full. Shows: the failed delivery
    /// address gets the whole value and the event names the receiver.
    function test_theLegacyFormToARefusedReceiverIsHandedOff() public {
        token.setDenied(carol, true);
        uint256 index = _sendCopy(abi.encodePacked(carol), 100 ether);
        _expectHandOff(address(token), carol, 100 ether, DeliveryRouter.Reason.PayoutRefused);
        _run(index);
        assertEq(token.balanceOf(failedDelivery), 100 ether);
        _assertRouterEmpty(address(token));
    }

    // ------------------------------------------------------------------------------------------------ the native coin

    /// Claim: a recipient that refuses both the coin and the wrapped token gets a hand-off in the wrapped token. Shows:
    /// the tip goes out as the coin, the failed delivery address receives the rest as the wrapped token, and the router
    /// holds no coin. Matters: the unwrap happens before the payout, and a failed payout must not strand coin.
    function test_aRecipientThatRefusesTheCoinAndTheWrappedTokenIsHandedOff() public {
        MedToggleReceiver receiver = new MedToggleReceiver();
        weth.setDenied(address(receiver), true);
        uint256 index = _sendWrapped(abi.encode(_share(address(receiver), 3, 0.5 ether, 0)), 5 ether);
        _expectHandOff(address(weth), address(receiver), 4.5 ether, DeliveryRouter.Reason.PayoutRefused);
        _run(index);

        assertEq(reward.balance, 0.5 ether, "the tip as the coin");
        assertEq(weth.balanceOf(failedDelivery), 4.5 ether, "the wrapped token");
        _assertRouterEmpty(address(weth));
    }

    /// Claim: a wrapped token that blocks the failed delivery address too leaves a record in the wrapped token. Shows:
    /// the record, the claim that pays the wrapped token once the block lifts, and no coin in the router.
    function test_aWrappedTokenThatBlocksTheFailedDeliveryAddressLeavesARecord() public {
        MedToggleReceiver receiver = new MedToggleReceiver();
        weth.setDenied(address(receiver), true);
        weth.setDenied(failedDelivery, true);
        _run(_sendWrapped(abi.encode(_share(address(receiver), 2, 0, 0)), 5 ether));
        assertEq(router.claimable(address(weth), failedDelivery), 5 ether);
        assertEq(weth.balanceOf(address(router)), 5 ether);
        assertEq(address(router).balance, 0);

        weth.setDenied(failedDelivery, false);
        router.claim(address(weth));
        assertEq(weth.balanceOf(failedDelivery), 5 ether);
        _assertRouterEmpty(address(weth));
    }

    /// Claim: a legacy receiver that refuses the coin and the wrapped token is handed off. Shows: the wrapped token
    /// reaches the failed delivery address, with no coin left in the router.
    function test_aLegacyCoinReceiverThatRefusesBothIsHandedOff() public {
        MedToggleReceiver receiver = new MedToggleReceiver();
        weth.setDenied(address(receiver), true);
        _run(_sendWrapped(abi.encodePacked(address(receiver)), 5 ether));
        assertEq(weth.balanceOf(failedDelivery), 5 ether);
        _assertRouterEmpty(address(weth));
    }

    /// Claim: a native refund of a gas based fee that nobody can receive is handed off. Shows: the held cap less the
    /// fee reaches the failed delivery address as the wrapped token. Matters: the settlement uses the same native path.
    function test_aNativeGasBasedRefundThatNobodyCanReceiveIsHandedOff() public {
        vm.txGasPrice(10 gwei);
        MedToggleReceiver receiver = new MedToggleReceiver();
        weth.setDenied(address(receiver), true);
        _run(_sendWrapped(abi.encode(_share(address(receiver), 2, 3 ether, 1 ether)), 5 ether));
        uint256 fee = reward.balance;
        assertGt(fee, 0);
        assertEq(weth.balanceOf(failedDelivery), 5 ether - fee);
        _assertRouterEmpty(address(weth));
    }

    /// Claim: invalid terms with the unwrap flag take the tip as the coin and hand the rest off as the wrapped token.
    /// Shows: nothing is sent to the zero address, and the router holds no coin. Matters: the coin must not leave through
    /// a call to an address that nobody controls.
    function test_invalidTermsWithTheUnwrapFlagHandTheRestOffAsTheWrappedToken() public {
        _run(_sendWrapped(abi.encode(_share(address(0), 3, 0.5 ether, 0)), 5 ether));
        assertEq(reward.balance, 0.5 ether, "the tip as the coin");
        assertEq(address(0).balance, 0, "nothing reached the zero address");
        assertEq(weth.balanceOf(failedDelivery), 4.5 ether);
        _assertRouterEmpty(address(weth));
    }

    /// Claim: a contract that cannot receive the coin does not matter to a token hand-off. Shows: a recipient with no
    /// `receive` function, refused by the token, is handed off like any other.
    function test_aContractRecipientThatTheTokenRefusesIsHandedOff() public {
        address refuser = address(new CoinRefuser());
        token.setDenied(refuser, true);
        _run(_sendCopy(abi.encode(_share(refuser, 0, 0, 0)), 10 ether));
        assertEq(token.balanceOf(failedDelivery), 10 ether);
        _assertRouterEmpty(address(token));
    }
}
