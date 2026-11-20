// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Vm} from "forge-std/Vm.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {MockERC20} from "../../mocks/MockERC20.sol";
import {DeliveryRouter} from "../../../src/hardened/mediator/DeliveryRouter.sol";
import {MessageBridge} from "../../../src/hardened/MessageBridge.sol";
import {IWETH} from "../../../src/hardened/mediator/IWETH.sol";
import {ITokenMediator} from "../../../src/hardened/mediator/ITokenMediator.sol";
import {TokenMediator} from "../../../src/hardened/mediator/TokenMediator.sol";
import {
    MediatorFixture,
    MockWrappedNative,
    DenyListToken,
    CoinRefuser,
    TEST_CALLBACK_GAS
} from "./utils/MediatorSupport.sol";
import {CallRecorder, CallReverter} from "./utils/CallTargets.sol";

/// @notice Tests of the `Delivered` event of the delivery router: one event on every delivery that pays its recipient,
/// with what the router received, the fee, what the recipient received, how, and the target of the call that follows.
/// No event on a hand-off. Most tests use a harness: the test contract is the mediator of the router, so it calls
/// `onTokenBridged` directly, and a stored starting gas stands for a delivery through `executeMessage`. One test runs
/// the whole flow through the mediator and the mock bridge.
contract DeliveryRouterDeliveredTest is MediatorFixture {
    MockWrappedNative internal weth;
    DeliveryRouter internal harness;
    MockERC20 internal token;
    address internal reward = makeAddr("reward address");
    address internal failedDelivery = makeAddr("failed delivery address");
    address internal recipient = makeAddr("recipient");

    uint256 internal constant VALUE = 100 ether;

    function setUp() public override {
        super.setUp();
        weth = new MockWrappedNative();
        harness = new DeliveryRouter(ITokenMediator(address(this)), IWETH(address(weth)), reward, failedDelivery);
        token = new MockERC20("Harness", "HRN");
    }

    // ------------------------------------------------------------------------------------------------ helpers

    /// @dev Marks a delivery through `executeMessage`: the slot holds a starting gas far above what any test uses, so a
    /// gas based fee measures a huge gas and reaches its cap.
    function _asRouterDelivery(DeliveryRouter router) internal {
        vm.store(address(router), router.DELIVERY_SLOT(), bytes32(uint256(type(uint96).max)));
    }

    function _terms(uint256 settings, uint256 limit, uint256 multiplier) internal view returns (bytes memory) {
        return abi.encode(DeliveryRouter.FeeDirector(recipient, settings, limit, multiplier, 0));
    }

    /// @dev Funds the harness with `VALUE` of the token. Call it before `_expectDelivered`: the mint emits an event.
    function _fundToken() internal {
        token.mint(address(harness), VALUE);
    }

    function _deliverToken(bytes memory data) internal {
        harness.onTokenBridged(address(token), VALUE, data);
    }

    function _fundWithWrapped(uint256 amount) internal {
        vm.deal(address(this), amount);
        weth.deposit{value: amount}();
        weth.transfer(address(harness), amount);
    }

    function _expectDelivered(
        address token_,
        address recipient_,
        address feeTo,
        uint256 amount,
        uint256 fee,
        uint256 paidOut,
        DeliveryRouter.PaidAs paidAs,
        address callTarget
    ) internal {
        vm.expectEmit(true, true, true, true, address(harness));
        emit DeliveryRouter.Delivered(token_, recipient_, feeTo, amount, fee, paidOut, paidAs, callTarget);
    }

    function _count(Vm.Log[] memory logs, bytes32 topic) internal pure returns (uint256 count) {
        for (uint256 i = 0; i < logs.length; i++) {
            if (logs[i].topics.length > 0 && logs[i].topics[0] == topic) count++;
        }
    }

    function _indexOf(Vm.Log[] memory logs, bytes32 topic) internal pure returns (uint256) {
        for (uint256 i = 0; i < logs.length; i++) {
            if (logs[i].topics.length > 0 && logs[i].topics[0] == topic) return i;
        }
        return type(uint256).max;
    }

    // ------------------------------------------------------------------------------------------------ the event

    /// Claim: the event has the signature that the indexer reads. Matters: the indexer matches the topic, so a change
    /// here must change the ABI of the indexer too.
    function test_theSignatureOfTheEvent() public pure {
        assertEq(
            DeliveryRouter.Delivered.selector,
            keccak256("Delivered(address,address,address,uint256,uint256,uint256,uint8,address)")
        );
    }

    // ------------------------------------------------------------------------------------------------ token payouts

    /// Claim: a token payout with a fixed fee reports the fee to the reward address and the rest to the recipient.
    function test_aTokenPayoutWithAFixedFee() public {
        _fundToken();
        _asRouterDelivery(harness);
        _expectDelivered(
            address(token), recipient, reward, VALUE, 3 ether, 97 ether, DeliveryRouter.PaidAs.Token, address(0)
        );
        _deliverToken(_terms(harness.FIXED_FEE(), 3 ether, 0));
        assertEq(token.balanceOf(reward), 3 ether);
        assertEq(token.balanceOf(recipient), 97 ether);
    }

    /// Claim: a share of the value (0.1%) is reported as the fee. This is the shape of the testnet delivery that showed
    /// no fee: 12.3 in, 0.0123 to the reward address, 12.2877 to the recipient.
    function test_aTokenPayoutWithAShareOfTheValue() public {
        _asRouterDelivery(harness);
        token.mint(address(harness), 12.3 ether);
        _expectDelivered(
            address(token),
            recipient,
            reward,
            12.3 ether,
            0.0123 ether,
            12.2877 ether,
            DeliveryRouter.PaidAs.Token,
            address(0)
        );
        harness.onTokenBridged(address(token), 12.3 ether, _terms(harness.MULTIPLIER_OF_TOTAL(), 0, 0.001 ether));
    }

    /// Claim: terms that ask for no fee report a fee of 0 and no fee account.
    function test_aFeeOfZeroReportsNoFeeAccount() public {
        _fundToken();
        _asRouterDelivery(harness);
        _expectDelivered(address(token), recipient, address(0), VALUE, 0, VALUE, DeliveryRouter.PaidAs.Token, address(0));
        _deliverToken(_terms(harness.MULTIPLIER_OF_TOTAL(), 0, 0));
    }

    /// Claim: a message executed on the bridge directly (no starting gas) takes no fee, and the event says so.
    function test_aDirectDeliveryReportsNoFee() public {
        _fundToken();
        _expectDelivered(address(token), recipient, address(0), VALUE, 0, VALUE, DeliveryRouter.PaidAs.Token, address(0));
        _deliverToken(_terms(harness.FIXED_FEE(), 3 ether, 0));
    }

    /// Claim: a gas based fee capped by `limit` reports the cap as the fee.
    function test_aGasBasedFeeCappedByTheLimit() public {
        _fundToken();
        vm.txGasPrice(10 gwei);
        _asRouterDelivery(harness);
        _expectDelivered(
            address(token), recipient, reward, VALUE, 2 ether, 98 ether, DeliveryRouter.PaidAs.Token, address(0)
        );
        _deliverToken(_terms(0, 2 ether, 1 ether));
    }

    /// Claim: a fee capped by the value leaves the recipient nothing, and the event still reports the delivery, with
    /// a payout of 0.
    function test_aFeeCappedByTheValueReportsAPayoutOfZero() public {
        _fundToken();
        _asRouterDelivery(harness);
        _expectDelivered(address(token), recipient, reward, VALUE, VALUE, 0, DeliveryRouter.PaidAs.Token, address(0));
        _deliverToken(_terms(harness.FIXED_FEE(), 500 ether, 0));
        assertEq(token.balanceOf(recipient), 0);
    }

    /// Claim: a fee that the reward address refuses stays with the recipient, and the event reports a fee of 0.
    function test_aRefusedFeeIsReportedAsNoFee() public {
        DenyListToken denied = new DenyListToken();
        denied.setDenied(reward, true);
        denied.mint(address(harness), VALUE);
        _asRouterDelivery(harness);
        vm.expectEmit(true, true, true, true, address(harness));
        emit DeliveryRouter.Delivered(
            address(denied), recipient, address(0), VALUE, 0, VALUE, DeliveryRouter.PaidAs.Token, address(0)
        );
        harness.onTokenBridged(address(denied), VALUE, _terms(harness.FIXED_FEE(), 3 ether, 0));
    }

    /// Claim: a token that takes a cut on transfer reports what the router could use, not what the mediator reported.
    function test_theAmountIsWhatTheRouterHolds() public {
        _asRouterDelivery(harness);
        token.mint(address(harness), 90 ether);
        _expectDelivered(
            address(token), recipient, reward, 90 ether, 3 ether, 87 ether, DeliveryRouter.PaidAs.Token, address(0)
        );
        harness.onTokenBridged(address(token), VALUE, _terms(harness.FIXED_FEE(), 3 ether, 0));
    }

    // ------------------------------------------------------------------------------------------------ native payouts

    /// Claim: an unwrap reports the wrapped token, the fee in coin, and a payout in the native coin.
    function test_aNativePayout() public {
        _fundWithWrapped(VALUE);
        _asRouterDelivery(harness);
        _expectDelivered(
            address(weth), recipient, reward, VALUE, 1 ether, 99 ether, DeliveryRouter.PaidAs.Native, address(0)
        );
        harness.onTokenBridged(address(weth), VALUE, _terms(harness.FIXED_FEE() | harness.UNWRAP(), 1 ether, 0));
        assertEq(recipient.balance, 99 ether);
        assertEq(reward.balance, 1 ether);
    }

    /// Claim: a recipient that refuses the coin gets the wrapped token, and the event says `Wrapped`.
    function test_aRefusedCoinIsReportedAsWrapped() public {
        address refuser = address(new CoinRefuser());
        _fundWithWrapped(VALUE);
        _asRouterDelivery(harness);
        vm.expectEmit(true, true, true, true, address(harness));
        emit DeliveryRouter.Delivered(
            address(weth), refuser, reward, VALUE, 1 ether, 99 ether, DeliveryRouter.PaidAs.Wrapped, address(0)
        );
        harness.onTokenBridged(
            address(weth),
            VALUE,
            abi.encode(DeliveryRouter.FeeDirector(refuser, harness.FIXED_FEE() | harness.UNWRAP(), 1 ether, 0, 0))
        );
        assertEq(weth.balanceOf(refuser), 99 ether);
    }

    /// Claim: a native fee that takes the whole value reports a native payout of 0.
    function test_aNativeFeeOfTheWholeValueReportsAPayoutOfZero() public {
        _fundWithWrapped(VALUE);
        _asRouterDelivery(harness);
        _expectDelivered(address(weth), recipient, reward, VALUE, VALUE, 0, DeliveryRouter.PaidAs.Native, address(0));
        harness.onTokenBridged(address(weth), VALUE, _terms(harness.FIXED_FEE() | harness.UNWRAP(), 500 ether, 0));
    }

    // ------------------------------------------------------------------------------------------------ the legacy form

    /// Claim: the 20 byte legacy form reports a token payout with no fee.
    function test_theLegacyFormWithAToken() public {
        _fundToken();
        _asRouterDelivery(harness);
        _expectDelivered(address(token), recipient, address(0), VALUE, 0, VALUE, DeliveryRouter.PaidAs.Token, address(0));
        _deliverToken(abi.encodePacked(recipient));
    }

    /// Claim: the 20 byte legacy form with the wrapped token reports a native payout with no fee.
    function test_theLegacyFormWithTheWrappedToken() public {
        _fundWithWrapped(VALUE);
        _expectDelivered(address(weth), recipient, address(0), VALUE, 0, VALUE, DeliveryRouter.PaidAs.Native, address(0));
        harness.onTokenBridged(address(weth), VALUE, abi.encodePacked(recipient));
        assertEq(recipient.balance, VALUE);
    }

    // ------------------------------------------------------------------------------------------------ the call

    /// Claim: a delivery with a call reports the target, and the call runs after the event.
    function test_aDeliveryWithACallReportsTheTarget() public {
        _fundToken();
        CallRecorder target = new CallRecorder();
        bytes memory data = bytes.concat(
            abi.encode(DeliveryRouter.FeeDirector(recipient, harness.FIXED_FEE(), 3 ether, 0, 100_000)),
            abi.encodePacked(address(target)),
            hex"c0ffee"
        );
        _asRouterDelivery(harness);
        _expectDelivered(
            address(token), recipient, reward, VALUE, 3 ether, 97 ether, DeliveryRouter.PaidAs.Token, address(target)
        );
        _deliverToken(data);
        assertEq(target.calls(), 1);
    }

    /// Claim: a call that fails still leaves the delivery reported, and `CallFailed` follows `Delivered`.
    function test_aFailedCallFollowsTheEvent() public {
        _fundToken();
        address target = address(new CallReverter());
        bytes memory data = bytes.concat(
            abi.encode(DeliveryRouter.FeeDirector(recipient, harness.FIXED_FEE(), 3 ether, 0, 100_000)),
            abi.encodePacked(target),
            hex"01"
        );
        _asRouterDelivery(harness);
        vm.recordLogs();
        _deliverToken(data);
        Vm.Log[] memory logs = vm.getRecordedLogs();
        uint256 delivered = _indexOf(logs, DeliveryRouter.Delivered.selector);
        uint256 failed = _indexOf(logs, DeliveryRouter.CallFailed.selector);
        assertLt(delivered, failed, "Delivered, then CallFailed");
        assertLt(failed, logs.length, "the call failed");
        (,,, DeliveryRouter.PaidAs paidAs, address callTarget) =
            abi.decode(logs[delivered].data, (uint256, uint256, uint256, DeliveryRouter.PaidAs, address));
        assertEq(uint8(paidAs), uint8(DeliveryRouter.PaidAs.Token));
        assertEq(callTarget, target);
    }

    /// Claim: data with fewer than 20 bytes after the director means no call, and the event reports no target.
    function test_aShortTailMeansNoTarget() public {
        _fundToken();
        bytes memory data =
            bytes.concat(abi.encode(DeliveryRouter.FeeDirector(recipient, 0, 0, 0, 100_000)), hex"0102030405");
        _expectDelivered(address(token), recipient, address(0), VALUE, 0, VALUE, DeliveryRouter.PaidAs.Token, address(0));
        _deliverToken(data);
    }

    // ------------------------------------------------------------------------------------------------ failures

    /// Claim: a payout that the token refuses is a hand-off: `DeliveryFailed`, and no `Delivered`.
    function test_aRefusedPayoutEmitsNoDelivered() public {
        DenyListToken denied = new DenyListToken();
        denied.setDenied(recipient, true);
        denied.mint(address(harness), VALUE);
        _asRouterDelivery(harness);
        vm.recordLogs();
        harness.onTokenBridged(address(denied), VALUE, _terms(harness.FIXED_FEE(), 3 ether, 0));
        Vm.Log[] memory logs = vm.getRecordedLogs();
        assertEq(_count(logs, DeliveryRouter.Delivered.selector), 0);
        assertEq(_count(logs, DeliveryRouter.DeliveryFailed.selector), 1);
    }

    /// Claim: data with no known shape, and terms that name the router itself, are hand-offs with no `Delivered`.
    function test_invalidTermsEmitNoDelivered() public {
        _fundToken();
        vm.recordLogs();
        _deliverToken(hex"0badda7a");
        token.mint(address(harness), VALUE);
        harness.onTokenBridged(
            address(token), VALUE, abi.encode(DeliveryRouter.FeeDirector(address(harness), 0, 0, 0, 0))
        );
        Vm.Log[] memory logs = vm.getRecordedLogs();
        assertEq(_count(logs, DeliveryRouter.Delivered.selector), 0);
        assertEq(_count(logs, DeliveryRouter.DeliveryFailed.selector), 2);
    }

    /// Claim: a native payout to an invalid recipient (the legacy form naming the router itself) is a hand-off with no
    /// `Delivered`.
    function test_aNativePayoutToAnInvalidRecipientEmitsNoDelivered() public {
        _fundWithWrapped(VALUE);
        vm.recordLogs();
        harness.onTokenBridged(address(weth), VALUE, abi.encodePacked(address(harness)));
        Vm.Log[] memory logs = vm.getRecordedLogs();
        assertEq(_count(logs, DeliveryRouter.Delivered.selector), 0);
        assertEq(_count(logs, DeliveryRouter.DeliveryFailed.selector), 1);
    }

    // ------------------------------------------------------------------------------------------------ the whole flow

    /// Claim: through the mediator and `executeMessage`, the router emits one `Delivered` right after the mediator's
    /// `TokensBridged` to the router, in the same transaction, with the bridged copy, the fee and the payout. Matters:
    /// the indexer pairs the event with the message by that order.
    function test_theWholeFlowEmitsDeliveredAfterTokensBridged() public {
        DeliveryRouter router =
            new DeliveryRouter(ITokenMediator(address(mediatorA)), IWETH(address(weth)), reward, failedDelivery);
        MockERC20 tokenB = new MockERC20("Token B", "TKB");
        tokenB.mint(alice, 1_000 ether);
        vm.startPrank(alice);
        tokenB.approve(address(mediatorB), type(uint256).max);
        mediatorB.relayTokens(address(tokenB), alice, 1 ether);
        vm.stopPrank();
        _deliverBtoA(_lastIndexB());
        address copy = mediatorA.bridgedTokenAddress(address(tokenB));

        bytes memory terms =
            abi.encode(DeliveryRouter.FeeDirector(recipient, router.MULTIPLIER_OF_TOTAL(), 0, 0.001 ether, 0));
        vm.prank(alice);
        mediatorB.relayTokensAndCall(address(tokenB), address(router), 12.3 ether, terms, TEST_CALLBACK_GAS);
        MessageBridge.MessageProof memory proof = ambA.proofOf(ambB, _lastIndexB());
        vm.recordLogs();
        vm.prank(alice, alice);
        router.executeMessage(proof);
        Vm.Log[] memory logs = vm.getRecordedLogs();

        uint256 bridged = _indexOf(logs, TokenMediator.TokensBridged.selector);
        uint256 delivered = _indexOf(logs, DeliveryRouter.Delivered.selector);
        assertLt(bridged, delivered);
        assertEq(_count(logs, DeliveryRouter.Delivered.selector), 1);
        assertEq(address(uint160(uint256(logs[bridged].topics[2]))), address(router), "the mediator paid the router");
        assertEq(logs[delivered].emitter, address(router));
        assertEq(address(uint160(uint256(logs[delivered].topics[1]))), copy);
        assertEq(address(uint160(uint256(logs[delivered].topics[2]))), recipient);
        assertEq(address(uint160(uint256(logs[delivered].topics[3]))), reward);
        (uint256 amount, uint256 fee, uint256 paidOut,,) =
            abi.decode(logs[delivered].data, (uint256, uint256, uint256, DeliveryRouter.PaidAs, address));
        assertEq(amount, 12.3 ether);
        assertEq(fee, 0.0123 ether);
        assertEq(paidOut, 12.2877 ether);
        assertEq(IERC20(copy).balanceOf(recipient), 12.2877 ether);
    }
}
