// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {MockERC20} from "../../../src/mocks/MockERC20.sol";
import {TokenMediator} from "../../../src/hardened/mediator/TokenMediator.sol";
import {MediatorFixture, MockAMB, RecordingReceiver} from "./utils/MediatorSupport.sol";

/// @notice The gas limit that a sender chooses for a message. OmniBridge sets the gas limit of each selector and token
/// through an owner. This mediator has no owner, so the sender chooses. The tests read the gas limit that the mediator
/// passes to the bridge, and then deliver the message with exactly that gas, as the real bridge does.
contract TokenMediatorGasLimitTest is MediatorFixture {
    RecordingReceiver internal receiver;

    function setUp() public override {
        super.setUp();
        receiver = new RecordingReceiver();
    }

    /// @dev A first message and a trip back, so that the native side sends the short form from now on.
    function _teachTheNativeSideThatTheCopyExists() internal {
        _bridgeAtoB(alice, address(tokenA), bob, 10 ether);
        _bridgeBtoA(bob, _copyOf(address(tokenA)), bob, 1 ether);
    }

    function _lastGasLimitA() internal view returns (uint256) {
        return ambA.messageAt(_lastIndexA()).gasLimit;
    }

    // ================================================================ the entry points that exist

    /// Claim: the entry points of OmniBridge keep the default gas limit of each message kind. Shows: a first relay asks
    /// for the deploy limit, a first relay with a call for the deploy limit plus the callback limit, a later relay for
    /// the release limit and a later relay with a call for the release limit plus the callback limit. Matters: a
    /// router or a wallet that calls `relayTokens` must see no change in cost.
    function test_theExistingEntryPointsKeepTheDefaultLimits() public {
        vm.prank(alice);
        mediatorA.relayTokens(address(tokenA), bob, 1 ether);
        assertEq(_lastGasLimitA(), mediatorA.DEPLOY_GAS_LIMIT(), "first relay: deploy");

        vm.prank(alice);
        mediatorA.relayTokensAndCall(address(tokenA), address(receiver), 1 ether, hex"01");
        assertEq(
            _lastGasLimitA(),
            mediatorA.DEPLOY_GAS_LIMIT() + mediatorA.CALLBACK_GAS_LIMIT(),
            "first call: deploy and call"
        );

        _teachTheNativeSideThatTheCopyExists();
        vm.prank(alice);
        mediatorA.relayTokens(address(tokenA), 1 ether);
        assertEq(_lastGasLimitA(), mediatorA.RELEASE_GAS_LIMIT(), "later relay: release");

        vm.prank(alice);
        mediatorA.relayTokensAndCall(address(tokenA), bob, 1 ether, hex"02");
        assertEq(
            _lastGasLimitA(),
            mediatorA.RELEASE_GAS_LIMIT() + mediatorA.CALLBACK_GAS_LIMIT(),
            "later call: release and call"
        );
    }

    // ================================================================ the entry points with a gas limit

    /// Claim: a sender may ask for more gas than the default, and the mediator asks the bridge for exactly that.
    /// Shows: a release with a request of 400,000 gives a message limit of 400,000, and a release with a call and a
    /// request of 3,000,000 gives 3,000,000. The first relay of a token (deploy) asks for 4,000,000 and gets it.
    function test_aRequestAboveTheDefaultIsUsed() public {
        _teachTheNativeSideThatTheCopyExists();
        vm.startPrank(alice);
        mediatorA.relayTokens(address(tokenA), bob, 1 ether, 400_000);
        assertEq(_lastGasLimitA(), 400_000, "release");
        mediatorA.relayTokensAndCall(address(tokenA), bob, 1 ether, hex"01", 3_000_000);
        assertEq(_lastGasLimitA(), 3_000_000, "release and call");
        vm.stopPrank();

        MockERC20 second = new MockERC20("Second", "SEC");
        second.mint(alice, 5 ether);
        vm.startPrank(alice);
        second.approve(address(mediatorA), type(uint256).max);
        mediatorA.relayTokens(address(second), bob, 1 ether, 4_000_000);
        vm.stopPrank();
        assertEq(_lastGasLimitA(), 4_000_000, "deploy");
    }

    /// Claim: a request of zero gives the default of the message kind. Shows: a deploy, a deploy with a call, a
    /// release and a release with a call each send their own default. Matters: zero is the way to say "use the
    /// default", and the rule that refuses a low request must never refuse it.
    function test_aRequestOfZeroGivesTheDefault() public {
        vm.startPrank(alice);
        mediatorA.relayTokens(address(tokenA), bob, 1 ether, 0);
        assertEq(_lastGasLimitA(), mediatorA.DEPLOY_GAS_LIMIT(), "deploy");
        mediatorA.relayTokensAndCall(address(tokenA), bob, 1 ether, hex"01", 0);
        assertEq(_lastGasLimitA(), mediatorA.DEPLOY_GAS_LIMIT() + mediatorA.CALLBACK_GAS_LIMIT(), "deploy and call");
        vm.stopPrank();

        _teachTheNativeSideThatTheCopyExists();
        vm.startPrank(alice);
        mediatorA.relayTokens(address(tokenA), bob, 1 ether, 0);
        assertEq(_lastGasLimitA(), mediatorA.RELEASE_GAS_LIMIT(), "release");
        mediatorA.relayTokensAndCall(address(tokenA), bob, 1 ether, hex"01", 0);
        assertEq(_lastGasLimitA(), mediatorA.RELEASE_GAS_LIMIT() + mediatorA.CALLBACK_GAS_LIMIT(), "release and call");
        vm.stopPrank();
    }

    /// Claim: a request at the default is accepted and sent unchanged. Shows: a release with a request of 250,000
    /// sends 250,000, and a release with a call sends 1,000,000 for a request of 1,000,000. Matters: the minimum is
    /// inclusive, so the exact default is a valid choice.
    function test_aRequestAtTheDefaultIsAccepted() public {
        _teachTheNativeSideThatTheCopyExists();
        vm.startPrank(alice);
        mediatorA.relayTokens(address(tokenA), bob, 1 ether, 250_000);
        assertEq(_lastGasLimitA(), 250_000, "release");
        mediatorA.relayTokensAndCall(address(tokenA), bob, 1 ether, hex"01", 1_000_000);
        assertEq(_lastGasLimitA(), 1_000_000, "release and call");
        vm.stopPrank();
    }

    /// Claim: a request above zero and below the default is refused, and nothing moves. Shows: for a release, a
    /// release with a call, a deploy and a deploy with a call, one gas less than the default, and a request of one,
    /// revert with `GasLimitBelowMinimum(request, default)`. Matters: a handler that gets less gas than its own work
    /// needs fails for good, so such a message is never sent.
    function test_aRequestBelowTheDefaultIsRefused() public {
        uint256 deployDefault = mediatorA.DEPLOY_GAS_LIMIT();
        uint256 callbackGas = mediatorA.CALLBACK_GAS_LIMIT();
        uint256 balanceBefore = tokenA.balanceOf(alice);
        vm.startPrank(alice);
        _expectBelow(1, deployDefault);
        mediatorA.relayTokens(address(tokenA), bob, 1 ether, 1);
        _expectBelow(deployDefault - 1, deployDefault);
        mediatorA.relayTokens(address(tokenA), bob, 1 ether, deployDefault - 1);
        _expectBelow(deployDefault + callbackGas - 1, deployDefault + callbackGas);
        mediatorA.relayTokensAndCall(address(tokenA), bob, 1 ether, hex"01", deployDefault + callbackGas - 1);
        vm.stopPrank();
        assertEq(tokenA.balanceOf(alice), balanceBefore, "nothing moved");
        assertEq(ambA.sentCount(), 0, "nothing sent");

        _teachTheNativeSideThatTheCopyExists();
        uint256 releaseDefault = mediatorA.RELEASE_GAS_LIMIT();
        vm.startPrank(alice);
        _expectBelow(249_999, releaseDefault);
        mediatorA.relayTokens(address(tokenA), bob, 1 ether, 249_999);
        _expectBelow(releaseDefault + callbackGas - 1, releaseDefault + callbackGas);
        mediatorA.relayTokensAndCall(address(tokenA), bob, 1 ether, hex"01", releaseDefault + callbackGas - 1);
        vm.stopPrank();
    }

    /// Claim: the minimum of a deploy grows with the name and the symbol, and the request is measured against it.
    /// Shows: a name and a symbol of 500 bytes together give a default of 2,100,000, so a request of 2,000,000 (the
    /// base default) is refused with `GasLimitBelowMinimum(2000000, 2100000)`, and 2,100,000 is accepted. Matters: a
    /// fixed minimum would let a long name through with too little gas to deploy the copy.
    function test_aDeployRequestBelowTheNameRuleIsRefused() public {
        MockERC20 longNamed = new MockERC20(_text(250), _text(250));
        longNamed.mint(alice, 5 ether);
        vm.startPrank(alice);
        longNamed.approve(address(mediatorA), type(uint256).max);
        _expectBelow(2_000_000, 2_100_000);
        mediatorA.relayTokens(address(longNamed), bob, 1 ether, 2_000_000);
        mediatorA.relayTokens(address(longNamed), bob, 1 ether, 2_100_000);
        vm.stopPrank();
        assertEq(_lastGasLimitA(), 2_100_000, "the rule is the minimum");
    }

    function _expectBelow(uint256 request, uint256 minimum) internal {
        vm.expectRevert(abi.encodeWithSelector(TokenMediator.GasLimitBelowMinimum.selector, request, minimum));
    }

    function _text(uint256 length) internal pure returns (string memory) {
        return string(_filled(length));
    }

    function _filled(uint256 length) internal pure returns (bytes memory text) {
        text = new bytes(length);
        for (uint256 i = 0; i < length; i++) {
            text[i] = "a";
        }
    }

    /// Claim: a request above the maximum of the bridge is refused with the existing error, and the maximum itself is
    /// allowed. Shows: the error carries the request and the maximum, no tokens move, and both overloads obey the rule.
    /// Matters: the bridge would refuse the send anyway, but with an error that does not name the mediator rule.
    function test_aRequestAboveTheBridgeMaximumIsRefused() public {
        uint256 maximum = ambA.maxGasPerTx();
        uint256 balanceBefore = tokenA.balanceOf(alice);
        vm.startPrank(alice);
        vm.expectRevert(abi.encodeWithSelector(TokenMediator.GasLimitAboveBridgeMaximum.selector, maximum + 1, maximum));
        mediatorA.relayTokens(address(tokenA), bob, 1 ether, maximum + 1);
        vm.expectRevert(abi.encodeWithSelector(TokenMediator.GasLimitAboveBridgeMaximum.selector, maximum + 1, maximum));
        mediatorA.relayTokensAndCall(address(tokenA), bob, 1 ether, hex"01", maximum + 1);
        vm.stopPrank();
        assertEq(tokenA.balanceOf(alice), balanceBefore, "nothing moved");
        assertEq(ambA.sentCount(), 0, "nothing sent");

        vm.startPrank(alice);
        mediatorA.relayTokens(address(tokenA), bob, 1 ether, maximum);
        assertEq(_lastGasLimitA(), maximum, "the maximum is allowed");
        mediatorA.relayTokensAndCall(address(tokenA), bob, 1 ether, hex"01", maximum);
        assertEq(_lastGasLimitA(), maximum, "the maximum is allowed with a call");
        vm.stopPrank();
    }

    /// Claim: the overloads with a gas limit keep the checks of the other entry points. Shows: a zero receiver, the
    /// remote mediator as receiver and a zero amount revert with their own errors.
    function test_theGasLimitOverloadsKeepTheChecksOfTheOtherEntryPoints() public {
        vm.startPrank(alice);
        vm.expectRevert(abi.encodeWithSelector(TokenMediator.InvalidReceiver.selector, address(0)));
        mediatorA.relayTokens(address(tokenA), address(0), 1 ether, 0);
        vm.expectRevert(abi.encodeWithSelector(TokenMediator.InvalidReceiver.selector, address(mediatorB)));
        mediatorA.relayTokens(address(tokenA), address(mediatorB), 1 ether, 0);
        vm.expectRevert(abi.encodeWithSelector(TokenMediator.InvalidReceiver.selector, address(0)));
        mediatorA.relayTokensAndCall(address(tokenA), address(0), 1 ether, hex"01", 0);
        vm.expectRevert(TokenMediator.ZeroAmount.selector);
        mediatorA.relayTokens(address(tokenA), bob, 0, 0);
        vm.expectRevert(TokenMediator.ZeroAmount.selector);
        mediatorA.relayTokensAndCall(address(tokenA), bob, 0, hex"01", 0);
        vm.stopPrank();
    }

    /// Claim: the receiver and the data reach the other chain unchanged, and the data is opaque. Shows: with the short
    /// form after the return trip, the message is exactly `handleBridgedTokensAndCall`, with no other address. The data
    /// is arbitrary bytes (a fee director of a router has such a shape, and the mediator never reads it). The receiver
    /// sees the same bytes in `onTokenBridged`. The overload without data sends the plain release, with no callback.
    function test_theGasLimitOverloadsSendTheOmnibridgePayload() public {
        _teachTheNativeSideThatTheCopyExists();
        bytes memory opaque = abi.encodePacked(hex"deadbeef", uint256(7), bytes32(type(uint256).max), hex"00");
        vm.prank(alice);
        mediatorA.relayTokensAndCall(address(tokenA), address(receiver), 5 ether, opaque, 1_000_000);
        uint256 index = _lastIndexA();
        MockAMB.Sent memory message = ambA.messageAt(index);
        assertEq(
            message.data,
            abi.encodeWithSelector(
                TokenMediator.handleBridgedTokensAndCall.selector, address(tokenA), address(receiver), 5 ether, opaque
            ),
            "the payload"
        );
        assertEq(message.gasLimit, 1_000_000, "the request is the default of a release with a call");

        (bool ok,) = _deliverAtoB(index);
        assertTrue(ok, "delivered");
        assertEq(IERC20(_copyOf(address(tokenA))).balanceOf(address(receiver)), 5 ether, "the receiver is paid");
        assertEq(receiver.lastData(), opaque, "the callback sees the same bytes");
        assertEq(receiver.lastValue(), 5 ether);

        vm.prank(alice);
        mediatorA.relayTokens(address(tokenA), bob, 2 ether, 0);
        assertEq(
            ambA.messageAt(_lastIndexA()).data,
            abi.encodeWithSelector(TokenMediator.handleBridgedTokens.selector, address(tokenA), bob, 2 ether),
            "no data is a plain release"
        );
    }

    /// Claim: a gas limit from the sender changes nothing in the payload. Shows: the same relay with and without a gas
    /// limit gives the same data, and only the gas limit of the message differs. Matters: the gas limit is a request to
    /// the bridge and no part of the message that the other chain reads.
    function test_theGasLimitIsNotPartOfThePayload() public {
        _teachTheNativeSideThatTheCopyExists();
        vm.startPrank(alice);
        mediatorA.relayTokens(address(tokenA), bob, 1 ether);
        mediatorA.relayTokens(address(tokenA), bob, 1 ether, 900_000);
        vm.stopPrank();
        uint256 last = _lastIndexA();
        assertEq(ambA.messageAt(last).data, ambA.messageAt(last - 1).data, "same payload");
        assertEq(ambA.messageAt(last - 1).gasLimit, mediatorA.RELEASE_GAS_LIMIT());
        assertEq(ambA.messageAt(last).gasLimit, 900_000);
    }

    /// Claim: the receiver on the other chain gets the gas that the sender asked for, because the message carries it.
    /// Shows: the delivery through the mock bridge uses the stored gas limit, and a callback that needs 1,200,000 gas
    /// fails with the default limit of a release with a call but passes when the sender asks for 2,000,000.
    /// Matters: this is the reason for the option.
    function test_aHeavyCallbackNeedsTheRequestedGas() public {
        _teachTheNativeSideThatTheCopyExists();
        HeavyReceiver heavy = new HeavyReceiver();
        vm.prank(alice);
        mediatorA.relayTokensAndCall(address(tokenA), address(heavy), 1 ether, hex"01");
        (bool ok,) = _deliverAtoB(_lastIndexA());
        assertTrue(ok, "the handler itself does not revert");
        assertEq(heavy.finished(), 0, "the default gas is too little for the callback");

        vm.prank(alice);
        mediatorA.relayTokensAndCall(address(tokenA), address(heavy), 1 ether, hex"01", 2_000_000);
        (ok,) = _deliverAtoB(_lastIndexA());
        assertTrue(ok);
        assertEq(heavy.finished(), 1, "the requested gas is enough for the callback");
    }
}

/// @notice A receiver whose callback burns 1,200,000 gas and then records that it finished.
contract HeavyReceiver {
    uint256 public finished;

    function onTokenBridged(address, uint256, bytes calldata) external {
        uint256 start = gasleft();
        while (start - gasleft() < 1_200_000) {}
        finished++;
    }
}
