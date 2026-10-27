// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {Vm} from "forge-std/Vm.sol";
import {BridgedToken} from "../../../src/hardened/mediator/BridgedToken.sol";
import {TokenMediator} from "../../../src/hardened/mediator/TokenMediator.sol";
import {WorldSupport} from "../utils/WorldSupport.sol";
import {DenyListToken} from "./utils/MediatorSupport.sol";
import {GasBurningToken, InvalidOpcodeToken, RevertingToken} from "./utils/HostileTokens.sol";
import {RecordingReceiver} from "./utils/MediatorSupport.sol";

/// @notice A native token whose transfer uses too much gas, or burns all the gas, or reverts. The release runs on the
/// real `MessageBridge` and the real mediator, because the mock bridge does not apply the real gas rule. A message that
/// the bridge delivers is final. So the handler must never revert on such a token: it must end with a recorded claim.
/// Each test reads the status that the real bridge keeps for the message.
contract TokenMediatorHostileGasTest is WorldSupport {
    uint256 internal constant AMOUNT = 100 ether;

    address internal recipient = makeAddr("recipient on A");

    /// @dev Locks `token` on chain A for `bob` on chain B, delivers the message, and returns the copy.
    function _lockAndDeliver(address token) internal returns (address copy) {
        vm.chainId(CHAIN_A);
        vm.startPrank(alice);
        IERC20(token).approve(address(mediatorA), type(uint256).max);
        vm.recordLogs();
        mediatorA.relayTokens(token, bob, AMOUNT);
        vm.stopPrank();
        _deliverToB(vm.getRecordedLogs());
        copy = mediatorB.bridgedTokenAddress(token);
    }

    /// @dev Bob sends the copy back to the recipient with a gas limit, and the release is delivered on chain A with the gas that the
    /// message carries. Returns the logs of the delivery and the identifier of the message.
    function _returnWithGasLimit(address copy, uint256 gasLimit)
        internal
        returns (Vm.Log[] memory deliveryLogs, bytes32 messageId)
    {
        vm.chainId(CHAIN_B);
        vm.startPrank(bob);
        BridgedToken(copy).approve(address(mediatorB), type(uint256).max);
        vm.recordLogs();
        mediatorB.relayTokens(copy, recipient, AMOUNT, gasLimit);
        vm.stopPrank();
        Transit memory transit = _proveForA(vm.getRecordedLogs());
        messageId = transit.messageId;
        vm.recordLogs();
        _execute(bridgeA, transit);
        deliveryLogs = vm.getRecordedLogs();
    }

    function _countOf(Vm.Log[] memory logs, address emitter, bytes32 topic) internal pure returns (uint256 count) {
        for (uint256 i = 0; i < logs.length; i++) {
            if (logs[i].emitter == emitter && logs[i].topics[0] == topic) count++;
        }
    }

    /// @dev What every hostile token must end with: the handler did not revert, one `ReleaseFailed` event names the
    /// recipient and the amount, nobody was paid, the record fell by the release, and the mediator still holds the
    /// tokens, owed to nobody.
    function _assertReleaseFailed(address token, Vm.Log[] memory deliveryLogs, bytes32 messageId) internal view {
        assertTrue(bridgeA.messageCallStatus(messageId), "the handler did not revert");
        assertEq(
            _countOf(deliveryLogs, address(mediatorA), TokenMediator.ReleaseFailed.selector), 1, "one failure event"
        );
        assertEq(_countOf(deliveryLogs, address(mediatorA), TokenMediator.TokensBridged.selector), 0, "nobody was paid");
        assertEq(IERC20(token).balanceOf(recipient), 0, "recipient balance");
        assertEq(IERC20(token).balanceOf(address(mediatorA)), AMOUNT, "the mediator still holds the tokens");
        assertEq(mediatorA.mediatorBalance(token), 0, "the record fell by the release");
        assertEq(IERC20(mediatorB.bridgedTokenAddress(token)).totalSupply(), 0, "the copies are burned");
    }

    /// Claim: a token whose transfer burns 300,000 gas, released with the default 250,000 gas of the message, ends
    /// with a failed release and no revert. Before the cap, the call into the token took 63/64 of the gas and burned
    /// it, and the 1/64 that was left could not pay for the claim write, so the handler reverted and the message
    /// failed for good with no claim. Shows: the real bridge reports the call as successful, the failure event is
    /// emitted once, and no account was paid.
    function test_aTokenThatNeedsMoreGasThanTheMessageGivesEndsWithAFailedRelease() public {
        GasBurningToken token = new GasBurningToken(300_000);
        token.mint(alice, AMOUNT);
        address copy = _lockAndDeliver(address(token));

        (Vm.Log[] memory logs, bytes32 id) = _returnWithGasLimit(copy, 0);

        _assertReleaseFailed(address(token), logs, id);
    }

    /// Claim: the same token is paid when the sender asks for enough gas. Shows: with a gas limit of 800,000 the
    /// recipient holds the amount, nothing is claimable and the record of the mediator is zero. Matters: the option of
    /// the sender is the way out for a heavy token.
    function test_theSameTokenIsPaidWhenTheSenderAsksForMoreGas() public {
        GasBurningToken token = new GasBurningToken(300_000);
        token.mint(alice, AMOUNT);
        address copy = _lockAndDeliver(address(token));

        (Vm.Log[] memory logs, bytes32 id) = _returnWithGasLimit(copy, 800_000);

        assertTrue(bridgeA.messageCallStatus(id), "delivered");
        assertEq(_countOf(logs, address(mediatorA), TokenMediator.TokensBridged.selector), 1, "paid once");
        assertEq(token.balanceOf(recipient), AMOUNT, "the recipient is paid");
        assertEq(mediatorA.mediatorBalance(address(token)), 0, "the record is zero");
        assertEq(token.balanceOf(address(mediatorA)), 0, "the mediator holds nothing");
    }

    /// Claim: a token that runs the INVALID opcode on transfer burns all the gas that it gets. The handler still ends
    /// with a recorded claim and no revert, with the default gas and with a large gas limit. Shows: the same
    /// assertions as for the heavy token.
    function test_aTokenThatBurnsAllItsGasEndsWithAFailedRelease() public {
        InvalidOpcodeToken token = new InvalidOpcodeToken();
        token.mint(alice, AMOUNT);
        address copy = _lockAndDeliver(address(token));

        (Vm.Log[] memory logs, bytes32 id) = _returnWithGasLimit(copy, 0);

        _assertReleaseFailed(address(token), logs, id);
    }

    /// Claim: the same holds when the sender asks for 5,000,000 gas, so a cap that only fits a small message fails
    /// here. Shows: the claim is recorded, and the call did not revert.
    function test_aTokenThatBurnsAllItsGasEndsWithAFailedReleaseWithALargeGasLimit() public {
        InvalidOpcodeToken token = new InvalidOpcodeToken();
        token.mint(alice, AMOUNT);
        address copy = _lockAndDeliver(address(token));

        (Vm.Log[] memory logs, bytes32 id) = _returnWithGasLimit(copy, 5_000_000);

        _assertReleaseFailed(address(token), logs, id);
    }

    /// Claim: a recipient that the token blocks ends with a claim through the real bridge. Shows: the same assertions.
    /// Matters: the revert path must not change with the cap.
    function test_aBlockedRecipientEndsWithAFailedRelease() public {
        DenyListToken token = new DenyListToken();
        token.mint(alice, AMOUNT);
        address copy = _lockAndDeliver(address(token));
        token.setDenied(recipient, true);

        (Vm.Log[] memory logs, bytes32 id) = _returnWithGasLimit(copy, 0);

        _assertReleaseFailed(address(token), logs, id);
    }

    /// Claim: a blocked recipient stays unpaid even after the token unblocks it. Shows: the release failed, and after
    /// `setDenied(recipient, false)` nothing pays: the mediator has no claim function, and the tokens stay in it.
    function test_aRecipientThatTheTokenUnblocksLaterIsNotPaid() public {
        DenyListToken token = new DenyListToken();
        token.mint(alice, AMOUNT);
        address copy = _lockAndDeliver(address(token));
        token.setDenied(recipient, true);
        (, bytes32 id) = _returnWithGasLimit(copy, 0);
        assertTrue(bridgeA.messageCallStatus(id));

        token.setDenied(recipient, false);
        vm.chainId(CHAIN_A);
        vm.prank(makeAddr("a stranger"));
        (bool claimed,) = address(mediatorA).call(abi.encodeWithSignature("claim(address,address)", address(token), recipient));
        assertFalse(claimed, "the mediator has no claim function");
        assertEq(token.balanceOf(recipient), 0, "the recipient is not paid");
        assertEq(token.balanceOf(address(mediatorA)), AMOUNT, "the tokens stay in the mediator");
        assertEq(mediatorA.mediatorBalance(address(token)), 0, "the record is zero");
    }

    /// Claim: a token whose transfer always reverts ends with a failed release through the real bridge, and
    /// the release is final. Shows: the same assertions as for the other hostile tokens. Matters: the handler never
    /// reverts, so the delivery is final and nothing is half done.
    function test_aTokenThatRevertsOnEveryTransferEndsWithAFailedRelease() public {
        RevertingToken token = new RevertingToken();
        token.mint(alice, AMOUNT);
        address copy = _lockAndDeliver(address(token));

        (Vm.Log[] memory logs, bytes32 id) = _returnWithGasLimit(copy, 0);

        _assertReleaseFailed(address(token), logs, id);
    }

    /// Claim: the gas limit overload with a call pays a heavy token that the default gas cannot pay. Shows: a token
    /// whose transfer burns 1,100,000 gas ends with a failed release under the default gas of a release with a
    /// call (1,000,000), and the recipient is paid when the sender asks for 2,000,000 with `relayTokensAndCall`. The
    /// recipient is a contract, so the callback runs. Matters: the sender chooses the gas, and the mediator passes it
    /// to the real bridge.
    function test_theCallOverloadWithAGasLimitPaysAHeavyTokenThatTheDefaultCannot() public {
        GasBurningToken token = new GasBurningToken(1_100_000);
        token.mint(alice, 2 * AMOUNT);
        address copy = _lockAndDeliver(address(token));
        vm.chainId(CHAIN_A);
        vm.recordLogs();
        vm.prank(alice);
        mediatorA.relayTokens(address(token), bob, AMOUNT);
        _deliverToB(vm.getRecordedLogs());
        RecordingReceiver contractRecipient = new RecordingReceiver();

        vm.chainId(CHAIN_B);
        vm.prank(bob);
        BridgedToken(copy).approve(address(mediatorB), type(uint256).max);
        vm.recordLogs();
        vm.prank(bob);
        mediatorB.relayTokensAndCall(copy, address(contractRecipient), AMOUNT, hex"aa");
        Transit memory withDefault = _proveForA(vm.getRecordedLogs());
        vm.recordLogs();
        vm.prank(bob);
        mediatorB.relayTokensAndCall(copy, address(contractRecipient), AMOUNT, hex"bb", 2_000_000);
        Transit memory withRequest = _proveForA(vm.getRecordedLogs());

        vm.recordLogs();
        _execute(bridgeA, withDefault);
        Vm.Log[] memory defaultLogs = vm.getRecordedLogs();
        assertTrue(bridgeA.messageCallStatus(withDefault.messageId), "the default gas message was delivered");
        assertEq(_countOf(defaultLogs, address(mediatorA), TokenMediator.ReleaseFailed.selector), 1, "failed");
        assertEq(token.balanceOf(address(contractRecipient)), 0, "the contract recipient is not paid");
        assertEq(contractRecipient.calls(), 0, "no callback without a payment");

        vm.recordLogs();
        _execute(bridgeA, withRequest);
        Vm.Log[] memory requestedLogs = vm.getRecordedLogs();
        assertTrue(bridgeA.messageCallStatus(withRequest.messageId), "the requested gas message was delivered");
        assertEq(_countOf(requestedLogs, address(mediatorA), TokenMediator.TokensBridged.selector), 1, "paid");
        assertEq(token.balanceOf(address(contractRecipient)), AMOUNT, "the recipient is paid");
        assertEq(contractRecipient.lastData(), hex"bb", "the callback ran with the data");
        assertEq(token.balanceOf(address(mediatorA)), AMOUNT, "the failed release stays in the mediator");
    }
}
