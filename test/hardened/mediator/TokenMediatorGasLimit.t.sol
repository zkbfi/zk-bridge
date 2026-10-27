// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {MockERC20} from "../../../src/mocks/MockERC20.sol";
import {TokenMediator} from "../../../src/hardened/mediator/TokenMediator.sol";
import {ITokenMediator} from "../../../src/hardened/mediator/ITokenMediator.sol";
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

    function _options(address to, bytes memory data, address fallbackRecipient, uint256 gasLimit)
        internal
        pure
        returns (ITokenMediator.RelayOptions memory)
    {
        return ITokenMediator.RelayOptions(to, data, fallbackRecipient, gasLimit);
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
        mediatorA.relayTokensWithFallback(address(tokenA), bob, 1 ether, hex"02", carol);
        assertEq(
            _lastGasLimitA(),
            mediatorA.RELEASE_GAS_LIMIT() + mediatorA.CALLBACK_GAS_LIMIT(),
            "later call: release and call"
        );
    }

    // ================================================================ the options entry point

    /// Claim: a sender may ask for more gas than the default, and the mediator asks the bridge for exactly that.
    /// Shows: a release with a request of 400,000 gives a message limit of 400,000, and a release with a call and a
    /// request of 3,000,000 gives 3,000,000. The first relay of a token (deploy) asks for 4,000,000 and gets it.
    function test_aRequestAboveTheDefaultIsUsed() public {
        _teachTheNativeSideThatTheCopyExists();
        vm.startPrank(alice);
        mediatorA.relayTokensWithOptions(address(tokenA), 1 ether, _options(bob, "", bob, 400_000));
        assertEq(_lastGasLimitA(), 400_000, "release");
        mediatorA.relayTokensWithOptions(address(tokenA), 1 ether, _options(bob, hex"01", bob, 3_000_000));
        assertEq(_lastGasLimitA(), 3_000_000, "release and call");
        vm.stopPrank();

        MockERC20 second = new MockERC20("Second", "SEC");
        second.mint(alice, 5 ether);
        vm.startPrank(alice);
        second.approve(address(mediatorA), type(uint256).max);
        mediatorA.relayTokensWithOptions(address(second), 1 ether, _options(bob, "", bob, 4_000_000));
        vm.stopPrank();
        assertEq(_lastGasLimitA(), 4_000_000, "deploy");
    }

    /// Claim: a request below the default cannot lower the gas limit. Shows: zero and one and one less than the default
    /// all give the default, for a release, a release with a call and a deploy. Matters: a sender must not be able to
    /// starve the handler of the gas that its own work needs.
    function test_aRequestBelowTheDefaultGivesTheDefault() public {
        vm.startPrank(alice);
        mediatorA.relayTokensWithOptions(address(tokenA), 1 ether, _options(bob, "", bob, 0));
        assertEq(_lastGasLimitA(), mediatorA.DEPLOY_GAS_LIMIT(), "deploy, zero");
        mediatorA.relayTokensWithOptions(address(tokenA), 1 ether, _options(bob, "", bob, 1));
        assertEq(_lastGasLimitA(), mediatorA.DEPLOY_GAS_LIMIT(), "deploy, one");
        mediatorA.relayTokensWithOptions(
            address(tokenA),
            1 ether,
            _options(bob, hex"01", bob, mediatorA.DEPLOY_GAS_LIMIT() + mediatorA.CALLBACK_GAS_LIMIT() - 1)
        );
        assertEq(
            _lastGasLimitA(), mediatorA.DEPLOY_GAS_LIMIT() + mediatorA.CALLBACK_GAS_LIMIT(), "deploy and call, one less"
        );
        vm.stopPrank();

        _teachTheNativeSideThatTheCopyExists();
        vm.startPrank(alice);
        mediatorA.relayTokensWithOptions(
            address(tokenA), 1 ether, _options(bob, "", bob, mediatorA.RELEASE_GAS_LIMIT() - 1)
        );
        assertEq(_lastGasLimitA(), mediatorA.RELEASE_GAS_LIMIT(), "release, one less");
        mediatorA.relayTokensWithOptions(
            address(tokenA), 1 ether, _options(bob, "", bob, mediatorA.RELEASE_GAS_LIMIT())
        );
        assertEq(_lastGasLimitA(), mediatorA.RELEASE_GAS_LIMIT(), "release, equal");
        vm.stopPrank();
    }

    /// Claim: a request above the maximum of the bridge is refused with the existing error, and the maximum itself is
    /// allowed. Shows: the error carries the request and the maximum, and no tokens move. Matters: the bridge would
    /// refuse the send anyway, but with an error that does not name the mediator rule.
    function test_aRequestAboveTheBridgeMaximumIsRefused() public {
        uint256 maximum = ambA.maxGasPerTx();
        uint256 balanceBefore = tokenA.balanceOf(alice);
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(TokenMediator.GasLimitAboveBridgeMaximum.selector, maximum + 1, maximum));
        mediatorA.relayTokensWithOptions(address(tokenA), 1 ether, _options(bob, "", bob, maximum + 1));
        assertEq(tokenA.balanceOf(alice), balanceBefore, "nothing moved");
        assertEq(ambA.sentCount(), 0, "nothing sent");

        vm.prank(alice);
        mediatorA.relayTokensWithOptions(address(tokenA), 1 ether, _options(bob, "", bob, maximum));
        assertEq(_lastGasLimitA(), maximum, "the maximum is allowed");
    }

    /// Claim: the options entry point keeps the checks of the other entry points. Shows: a zero receiver, the remote
    /// mediator as receiver and a zero fallback revert with their own errors.
    function test_theOptionsKeepTheChecksOfTheOtherEntryPoints() public {
        vm.startPrank(alice);
        vm.expectRevert(abi.encodeWithSelector(TokenMediator.InvalidReceiver.selector, address(0)));
        mediatorA.relayTokensWithOptions(address(tokenA), 1 ether, _options(address(0), "", bob, 0));
        vm.expectRevert(abi.encodeWithSelector(TokenMediator.InvalidReceiver.selector, address(mediatorB)));
        mediatorA.relayTokensWithOptions(address(tokenA), 1 ether, _options(address(mediatorB), "", bob, 0));
        vm.expectRevert(TokenMediator.ZeroFallback.selector);
        mediatorA.relayTokensWithOptions(address(tokenA), 1 ether, _options(bob, "", address(0), 0));
        vm.expectRevert(TokenMediator.ZeroAmount.selector);
        mediatorA.relayTokensWithOptions(address(tokenA), 0, _options(bob, "", bob, 0));
        vm.stopPrank();
    }

    /// Claim: the receiver, the data and the fallback of the options reach the other chain unchanged, and the data is
    /// opaque. Shows: with the short form after the return trip, the message is exactly `handleBridgedTokensAndCallWithFallback`
    /// with the sender chosen fallback. The data is arbitrary bytes (a fee director of a router has such a shape, and
    /// the mediator never reads it). The receiver sees the same bytes in `onTokenBridged`. Empty data in the options
    /// means a plain release, with no callback.
    function test_theOptionsReachTheOtherChainUnchanged() public {
        _teachTheNativeSideThatTheCopyExists();
        bytes memory opaque = abi.encodePacked(hex"deadbeef", uint256(7), bytes32(type(uint256).max), hex"00");
        vm.prank(alice);
        mediatorA.relayTokensWithOptions(address(tokenA), 5 ether, _options(address(receiver), opaque, carol, 600_000));
        uint256 index = _lastIndexA();
        MockAMB.Sent memory message = ambA.messageAt(index);
        assertEq(
            message.data,
            abi.encodeWithSelector(
                TokenMediator.handleBridgedTokensAndCallWithFallback.selector,
                address(tokenA),
                address(receiver),
                5 ether,
                opaque,
                carol
            ),
            "the payload"
        );
        assertEq(message.gasLimit, 1_000_000, "the default of a release with a call is above the request");

        (bool ok,) = _deliverAtoB(index);
        assertTrue(ok, "delivered");
        assertEq(IERC20(_copyOf(address(tokenA))).balanceOf(address(receiver)), 5 ether, "the receiver is paid");
        assertEq(receiver.lastData(), opaque, "the callback sees the same bytes");
        assertEq(receiver.lastValue(), 5 ether);

        vm.prank(alice);
        mediatorA.relayTokensWithOptions(address(tokenA), 2 ether, _options(bob, "", carol, 0));
        assertEq(
            ambA.messageAt(_lastIndexA()).data,
            abi.encodeWithSelector(
                TokenMediator.handleBridgedTokensWithFallback.selector, address(tokenA), bob, 2 ether, carol
            ),
            "empty data is a plain release"
        );
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
        mediatorA.relayTokensWithOptions(address(tokenA), 1 ether, _options(address(heavy), hex"01", alice, 2_000_000));
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
