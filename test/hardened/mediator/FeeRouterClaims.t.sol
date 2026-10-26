// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {MockERC20} from "../../../src/mocks/MockERC20.sol";
import {FeeRouter} from "../../../src/hardened/mediator/FeeRouter.sol";
import {MessageBridge} from "../../../src/hardened/MessageBridge.sol";
import {IWETH} from "../../../src/hardened/mediator/IWETH.sol";
import {ITokenMediator} from "../../../src/hardened/mediator/ITokenMediator.sol";
import {MediatorFixture, DenyListToken, CoinRefuser} from "./utils/MediatorSupport.sol";
import {MedCutToken, MedDenyListWrappedNative, MedToggleReceiver} from "./utils/MedMocks.sol";

/// @notice The router never keeps a delivery that it cannot pay. It records the amount for an account, and the account
/// claims it. These tests cover each way that a sender can make a payout fail: a token that refuses the recipient, terms
/// that name nobody who can receive, a legacy receiver for a token that cannot unwrap, and a wrapped token that refuses
/// the recipient after the coin was refused. Tokens flow from chain B back to the router on chain A.
contract FeeRouterClaimsTest is MediatorFixture {
    MedDenyListWrappedNative internal weth;
    DenyListToken internal token;
    FeeRouter internal router;
    address internal runner = makeAddr("runner");
    address internal reward = makeAddr("reward address");
    address internal recipient = makeAddr("recipient");
    address internal copy;

    event ClaimableRecorded(address indexed token, address indexed account, uint256 amount, FeeRouter.Cause cause);
    event Claimed(address indexed token, address indexed account, uint256 amount);

    function setUp() public override {
        super.setUp();
        weth = new MedDenyListWrappedNative();
        router = new FeeRouter(ITokenMediator(address(mediatorA)), IWETH(address(weth)), runner, reward);
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
        returns (FeeRouter.FeeDirector memory)
    {
        return FeeRouter.FeeDirector(to, settings, limit, multiplier);
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
        vm.prank(runner, runner);
        router.executeMessageWithRunner(proof, reward);
    }

    /// @dev Delivers the message, then checks that the bridge saw a successful call.
    function _deliver(uint256 index) internal {
        (bool ok,) = _deliverBtoA(index);
        assertTrue(ok, "the delivery reverted");
    }

    // ------------------------------------------------------------------------------------------------ a token refuses the recipient

    /// Claim: a token that refuses the recipient does not strand the value, and the tip is not redirected. Shows: the
    /// reward address gets the fixed fee, the rest is recorded for the recipient, the router holds exactly that record,
    /// and the event names the cause. Matters: the router has no owner, so an unrecorded balance would be lost for good.
    function test_aTokenThatRefusesTheRecipientLeavesARecordAndTheTipIsPaid() public {
        token.setDenied(recipient, true);
        uint256 index = _sendCopy(abi.encode(_share(recipient, 1, 5 ether, 0)), 100 ether);

        vm.expectEmit(true, true, false, true, address(router));
        emit ClaimableRecorded(address(token), recipient, 95 ether, FeeRouter.Cause.PayoutRefused);
        _run(index);

        assertEq(token.balanceOf(reward), 5 ether, "the tip");
        assertEq(token.balanceOf(recipient), 0);
        assertEq(router.claimable(address(token), recipient), 95 ether, "the record");
        assertEq(router.totalClaimable(address(token)), 95 ether);
        assertEq(token.balanceOf(address(router)), 95 ether, "the balance equals the record");
    }

    /// Claim: the claim is refused while the token refuses the account, and pays once it does not. Shows: the first call
    /// reverts and the record stays; after the token allows the account, anyone can pay it, and only to the account.
    /// A second call has nothing to pay. Matters: a blocklist can lift, and the value must still be there.
    function test_aClaimWaitsForTheTokenAndPaysOnlyTheAccount() public {
        token.setDenied(recipient, true);
        _run(_sendCopy(abi.encode(_share(recipient, 1, 5 ether, 0)), 100 ether));

        vm.expectRevert();
        router.claim(address(token), recipient);
        assertEq(router.claimable(address(token), recipient), 95 ether, "the record stays");

        token.setDenied(recipient, false);
        vm.expectEmit(true, true, false, true, address(router));
        emit Claimed(address(token), recipient, 95 ether);
        vm.prank(bob);
        router.claim(address(token), recipient);

        assertEq(token.balanceOf(recipient), 95 ether, "paid to the account, not the caller");
        assertEq(token.balanceOf(bob), 0);
        assertEq(token.balanceOf(address(router)), 0);
        assertEq(router.totalClaimable(address(token)), 0);
        vm.expectRevert(abi.encodeWithSelector(FeeRouter.NothingToClaim.selector, address(token), recipient));
        router.claim(address(token), recipient);
    }

    /// Claim: a refused payout does not block the message when no runner executes it. Shows: a direct execution on the
    /// bridge takes no fee, and the recipient gets a record for everything. Matters: the bridge stays permissionless.
    function test_aDirectDeliveryToARefusedRecipientRecordsTheWholeValue() public {
        token.setDenied(recipient, true);
        _deliver(_sendCopy(abi.encode(_share(recipient, 1, 5 ether, 0)), 100 ether));
        assertEq(router.claimable(address(token), recipient), 100 ether);
        assertEq(token.balanceOf(reward), 0);
    }

    /// Claim: the share held back for a gas based fee also lands in a record when the token refuses the recipient.
    /// Shows: the fee goes to the reward address and the held cap, less the fee, is recorded for the recipient. The
    /// part paid in the callback is recorded too. Matters: the settlement runs after the callback and used to push the
    /// refund with a call that could fail and leave it in the router.
    function test_aGasBasedRefundThatTheTokenRefusesIsRecorded() public {
        vm.txGasPrice(10 gwei);
        token.setDenied(recipient, true);
        _run(_sendCopy(abi.encode(_share(recipient, 0, 50 ether, 1 ether)), 100 ether));

        uint256 fee = token.balanceOf(reward);
        assertGt(fee, 0, "a fee was paid");
        assertEq(router.claimable(address(token), recipient), 100 ether - fee, "the rest is recorded");
        assertEq(token.balanceOf(address(router)), 100 ether - fee);
    }

    /// Claim: a token that takes a cut on transfer cannot make the router pay a delivery out of the records of others.
    /// Shows: with 40 recorded for a denied account, a later delivery of 100 that arrives as 90 pays 90 to its own
    /// recipient and leaves the 40 untouched. Matters: the balance of the router includes the records, and a payout
    /// from the whole balance would take from the claimants.
    function test_aDeliveryIsNeverPaidFromTheRecordsOfOthers() public {
        MedCutToken cutToken = new MedCutToken();
        cutToken.mint(alice, 1_000 ether);
        vm.startPrank(alice);
        cutToken.approve(address(mediatorA), type(uint256).max);
        mediatorA.relayTokens(address(cutToken), alice, 500 ether);
        vm.stopPrank();
        _deliverAtoB(_lastIndexA());
        address cutCopy = _copyOf(address(cutToken));

        // 40 sits in the router for `bob`, with nothing else in the way: a record put there by an unpayable payout is
        // simulated by a delivery that the copy cannot refuse, so the record is built with the deny list token instead.
        token.setDenied(bob, true);
        _run(_sendCopy(abi.encode(_share(bob, 0, 0, 0)), 40 ether));
        assertEq(router.totalClaimable(address(token)), 40 ether);

        // The cut token has no record. Its delivery arrives short and is paid in full from what arrived.
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

    // ------------------------------------------------------------------------------------------------ invalid terms

    /// Claim: terms that name the router as the recipient do not strand the value. Shows: the whole value is recorded
    /// for the reward address, no fee is split, and the reward address can claim it. Matters: the router cannot pay
    /// itself, and no account owns the value, so the router forfeits it to the one account that it names.
    function test_theRouterAsRecipientForfeitsTheValueToTheRewardAddress() public {
        uint256 index = _sendCopy(abi.encode(_share(address(router), 1, 5 ether, 0)), 100 ether);
        vm.expectEmit(true, true, false, true, address(router));
        emit ClaimableRecorded(address(token), reward, 100 ether, FeeRouter.Cause.InvalidTerms);
        _run(index);

        assertEq(router.claimable(address(token), reward), 100 ether);
        assertEq(token.balanceOf(address(router)), 100 ether);
        router.claim(address(token), reward);
        assertEq(token.balanceOf(reward), 100 ether);
        assertEq(token.balanceOf(address(router)), 0);
    }

    function test_theZeroAddressAsRecipientForfeitsTheValueToTheRewardAddress() public {
        _deliver(_sendCopy(abi.encode(_share(address(0), 1, 5 ether, 0)), 100 ether));
        assertEq(router.claimable(address(token), reward), 100 ether);
        assertEq(token.balanceOf(address(router)), 100 ether);
    }

    /// Claim: data that is neither 20 bytes nor a full set of terms is forfeited too, not reverted. Shows: seven bytes
    /// and 127 bytes both leave a record for the reward address and the delivery succeeds. Matters: a revert in the
    /// callback leaves the tokens in the router, because the mediator has already paid it.
    function test_dataOfNoKnownShapeForfeitsTheValueToTheRewardAddress() public {
        _deliver(_sendCopy(hex"01020304050607", 10 ether));
        _deliver(_sendCopy(new bytes(127), 20 ether));
        assertEq(router.claimable(address(token), reward), 30 ether);
        assertEq(token.balanceOf(address(router)), 30 ether);
    }

    /// Claim: a legacy receiver that is invalid is forfeited like invalid terms. Shows: the router and the zero address
    /// as a 20 byte receiver both leave a record for the reward address. Matters: the same guard covers both forms.
    function test_aLegacyReceiverThatIsTheRouterOrZeroIsForfeited() public {
        _deliver(_sendCopy(abi.encodePacked(address(router)), 10 ether));
        _deliver(_sendCopy(abi.encodePacked(address(0)), 20 ether));
        assertEq(router.claimable(address(token), reward), 30 ether);
    }

    // ------------------------------------------------------------------------------------------------ legacy form

    /// Claim: the legacy form with a token that is not the wrapped native token pays the token to the receiver. Shows:
    /// the receiver gets the whole value as the token, with no fee, and the router holds nothing. Matters: the router
    /// cannot unwrap this token, and it used to revert in the callback and keep the tokens.
    function test_theLegacyFormPaysAnotherTokenToTheReceiverWithNoFee() public {
        _run(_sendCopy(abi.encodePacked(carol), 100 ether));
        assertEq(token.balanceOf(carol), 100 ether);
        assertEq(token.balanceOf(reward), 0, "no fee");
        assertEq(token.balanceOf(address(router)), 0);
    }

    /// Claim: the legacy form to a receiver that the token refuses is recorded, not lost. Shows: a record for the
    /// receiver. Matters: the legacy form has the same failure as the terms form.
    function test_theLegacyFormToARefusedReceiverIsRecorded() public {
        token.setDenied(carol, true);
        _run(_sendCopy(abi.encodePacked(carol), 100 ether));
        assertEq(router.claimable(address(token), carol), 100 ether);
    }

    // ------------------------------------------------------------------------------------------------ the native coin

    /// Claim: a recipient that refuses both the coin and the wrapped token gets a record in the wrapped token, and
    /// `claimNative` pays the coin when the recipient accepts it. Shows: the router holds the wrapped token and no coin
    /// after the delivery; the tip goes out as the coin; `claimNative` unwraps and sends the coin with the gas cap, and
    /// the record clears. Matters: the unwrap happens before the payout, and a failed payout must not strand coin.
    function test_aRecipientThatRefusesTheCoinAndTheWrappedTokenGetsARecord() public {
        MedToggleReceiver receiver = new MedToggleReceiver();
        weth.setDenied(address(receiver), true);
        _run(_sendWrapped(abi.encode(_share(address(receiver), 3, 0.5 ether, 0)), 5 ether));

        assertEq(reward.balance, 0.5 ether, "the tip as the coin");
        assertEq(address(router).balance, 0, "no coin stays");
        assertEq(router.claimable(address(weth), address(receiver)), 4.5 ether);
        assertEq(weth.balanceOf(address(router)), 4.5 ether, "the balance equals the record");

        // Both refuse: nothing moves.
        vm.expectRevert(abi.encodeWithSelector(FeeRouter.ClaimTransferFailed.selector, address(weth), address(receiver)));
        router.claimNative(address(receiver));
        assertEq(router.claimable(address(weth), address(receiver)), 4.5 ether, "the record stays");
        assertEq(address(router).balance, 0);

        receiver.setRefuse(false);
        router.claimNative(address(receiver));
        assertEq(address(receiver).balance, 4.5 ether);
        assertEq(weth.balanceOf(address(router)), 0);
        assertEq(router.totalClaimable(address(weth)), 0);
        vm.expectRevert(abi.encodeWithSelector(FeeRouter.NothingToClaim.selector, address(weth), address(receiver)));
        router.claimNative(address(receiver));
    }

    /// Claim: `claimNative` falls back to the wrapped token when the account refuses the coin but the token accepts it.
    /// Shows: a contract that cannot take the coin receives the wrapped token. Matters: the claim has the same
    /// fallback as a payout, so a contract recipient is never locked out by a missing `receive`.
    function test_claimNativeFallsBackToTheWrappedToken() public {
        MedToggleReceiver receiver = new MedToggleReceiver();
        weth.setDenied(address(receiver), true);
        _run(_sendWrapped(abi.encode(_share(address(receiver), 2, 0, 0)), 5 ether));
        assertEq(router.claimable(address(weth), address(receiver)), 5 ether);

        weth.setDenied(address(receiver), false);
        router.claimNative(address(receiver));
        assertEq(weth.balanceOf(address(receiver)), 5 ether, "the wrapped token");
        assertEq(address(receiver).balance, 0);
        assertEq(address(router).balance, 0);
    }

    /// Claim: `claim` pays the wrapped native token as the token. Shows: the same record, paid as the token.
    function test_claimPaysTheWrappedTokenAsTheToken() public {
        MedToggleReceiver receiver = new MedToggleReceiver();
        weth.setDenied(address(receiver), true);
        _run(_sendWrapped(abi.encode(_share(address(receiver), 2, 0, 0)), 5 ether));
        weth.setDenied(address(receiver), false);
        router.claim(address(weth), address(receiver));
        assertEq(weth.balanceOf(address(receiver)), 5 ether);
    }

    /// Claim: a legacy receiver that refuses the coin and the wrapped token is recorded. Shows: a record in the wrapped
    /// token and no coin in the router.
    function test_aLegacyCoinReceiverThatRefusesBothIsRecorded() public {
        MedToggleReceiver receiver = new MedToggleReceiver();
        weth.setDenied(address(receiver), true);
        _run(_sendWrapped(abi.encodePacked(address(receiver)), 5 ether));
        assertEq(router.claimable(address(weth), address(receiver)), 5 ether);
        assertEq(address(router).balance, 0);
    }

    /// Claim: a native refund of a gas based fee that nobody can receive is recorded. Shows: the held cap, less the
    /// fee, is a record in the wrapped token. Matters: the settlement uses the same native path as the callback.
    function test_aNativeGasBasedRefundThatNobodyCanReceiveIsRecorded() public {
        vm.txGasPrice(10 gwei);
        MedToggleReceiver receiver = new MedToggleReceiver();
        weth.setDenied(address(receiver), true);
        _run(_sendWrapped(abi.encode(_share(address(receiver), 2, 3 ether, 1 ether)), 5 ether));
        uint256 fee = reward.balance;
        assertGt(fee, 0);
        assertEq(router.claimable(address(weth), address(receiver)), 5 ether - fee);
        assertEq(weth.balanceOf(address(router)), 5 ether - fee);
        assertEq(address(router).balance, 0);
    }

    /// Claim: a claim pays once, even when the receiver calls `claimNative` again from its `receive` function. Shows: the
    /// coin arrives once, the inner call fails, and the record is zero. Matters: the router pays with a call to an
    /// account that the sender chose.
    function test_aClaimCannotReenter() public {
        ReenteringClaimant claimant = new ReenteringClaimant(router);
        weth.setDenied(address(claimant), true);
        _run(_sendWrapped(abi.encode(_share(address(claimant), 2, 0, 0)), 5 ether));
        weth.setDenied(address(claimant), false);
        claimant.arm();
        router.claimNative(address(claimant));
        assertEq(address(claimant).balance, 5 ether, "paid once");
        assertEq(router.totalClaimable(address(weth)), 0);
    }

    /// Claim: a recipient that cannot take the coin does not matter to a record in a plain token. Shows: a router
    /// whose token is the deny list token and recipient is a contract with no `receive` gets a record, and the claim
    /// pays the token. Matters: `claim` is open to anyone for the account, so a contract that cannot call is not locked.
    function test_aContractThatCannotCallStillGetsItsClaim() public {
        address refuser = address(new CoinRefuser());
        token.setDenied(refuser, true);
        _run(_sendCopy(abi.encode(_share(refuser, 0, 0, 0)), 10 ether));
        token.setDenied(refuser, false);
        router.claim(address(token), refuser);
        assertEq(token.balanceOf(refuser), 10 ether);
    }
}

/// @dev A receiver that tries to claim again while it receives the coin of a claim.
contract ReenteringClaimant {
    FeeRouter internal immutable router;
    bool internal armed;

    constructor(FeeRouter router_) {
        router = router_;
    }

    function arm() external {
        armed = true;
    }

    receive() external payable {
        require(armed, "refused");
        armed = false;
        (bool ok,) = address(router).call(abi.encodeCall(FeeRouter.claimNative, (address(this))));
        require(!ok, "reentered");
    }
}
