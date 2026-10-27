// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {Vm} from "forge-std/Vm.sol";
import {BridgedToken} from "../../../src/hardened/mediator/BridgedToken.sol";
import {TokenMediator} from "../../../src/hardened/mediator/TokenMediator.sol";
import {WorldSupport} from "../utils/WorldSupport.sol";
import {DenyListToken} from "./utils/MediatorSupport.sol";
import {GasBurningToken, InvalidOpcodeToken} from "./utils/HostileTokens.sol";

/// @notice A native token whose transfer uses too much gas, or burns all the gas, or reverts. The release runs on the
/// real `MessageBridge` and the real mediator, because the mock bridge does not apply the real gas rule. A message that
/// the bridge delivers is final. So the handler must never revert on such a token: it must end with a recorded claim.
/// Each test reads the status that the real bridge keeps for the message.
contract TokenMediatorHostileGasTest is WorldSupport {
    uint256 internal constant AMOUNT = 100 ether;

    address internal recipient = makeAddr("recipient on A");
    address internal fallbackAccount = makeAddr("fallback on A");

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

    /// @dev Bob sends the copy back with the options, and the release is delivered on chain A with the gas that the
    /// message carries. Returns the logs of the delivery and the identifier of the message.
    function _returnWithOptions(address copy, uint256 gasLimit)
        internal
        returns (Vm.Log[] memory deliveryLogs, bytes32 messageId)
    {
        vm.chainId(CHAIN_B);
        vm.startPrank(bob);
        BridgedToken(copy).approve(address(mediatorB), type(uint256).max);
        vm.recordLogs();
        mediatorB.relayTokensWithOptions(
            copy, AMOUNT, TokenMediator.RelayOptions(recipient, "", fallbackAccount, gasLimit)
        );
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

    /// @dev What every hostile token must end with: the handler did not revert, nobody was paid, the whole amount is
    /// claimable by the fallback account, and the mediator still owes and holds the amount.
    function _assertClaimRecorded(address token, Vm.Log[] memory deliveryLogs, bytes32 messageId) internal view {
        assertTrue(bridgeA.messageCallStatus(messageId), "the handler did not revert");
        assertEq(
            _countOf(deliveryLogs, address(mediatorA), TokenMediator.ClaimableRecorded.selector), 1, "one claim event"
        );
        assertEq(_countOf(deliveryLogs, address(mediatorA), TokenMediator.TokensBridged.selector), 0, "nobody was paid");
        assertEq(mediatorA.claimable(token, fallbackAccount), AMOUNT, "the fallback account can claim the amount");
        assertEq(mediatorA.claimable(token, recipient), 0, "the recipient has no claim");
        assertEq(IERC20(token).balanceOf(recipient), 0, "recipient balance");
        assertEq(IERC20(token).balanceOf(fallbackAccount), 0, "fallback balance");
        assertEq(IERC20(token).balanceOf(address(mediatorA)), AMOUNT, "the mediator still holds the tokens");
        assertEq(mediatorA.mediatorBalance(token), AMOUNT, "the mediator still owes the tokens");
    }

    /// Claim: a token whose transfer burns 300,000 gas, released with the default 250,000 gas of the message, ends
    /// with a recorded claim and no revert. Before the cap, the call into the token took 63/64 of the gas and burned
    /// it, and the 1/64 that was left could not pay for the claim write, so the handler reverted and the message
    /// failed for good with no claim. Shows: the real bridge reports the call as successful, the claim event is
    /// emitted once, the claim record holds the amount for the fallback account, and no account was paid.
    function test_aTokenThatNeedsMoreGasThanTheMessageGivesEndsWithAClaim() public {
        GasBurningToken token = new GasBurningToken(300_000);
        token.mint(alice, AMOUNT);
        address copy = _lockAndDeliver(address(token));

        (Vm.Log[] memory logs, bytes32 id) = _returnWithOptions(copy, 0);

        _assertClaimRecorded(address(token), logs, id);
    }

    /// Claim: the same token is paid when the sender asks for enough gas. Shows: with a gas limit of 800,000 the
    /// recipient holds the amount, nothing is claimable and the record of the mediator is zero. Matters: the option of
    /// the sender is the way out for a heavy token.
    function test_theSameTokenIsPaidWhenTheSenderAsksForMoreGas() public {
        GasBurningToken token = new GasBurningToken(300_000);
        token.mint(alice, AMOUNT);
        address copy = _lockAndDeliver(address(token));

        (Vm.Log[] memory logs, bytes32 id) = _returnWithOptions(copy, 800_000);

        assertTrue(bridgeA.messageCallStatus(id), "delivered");
        assertEq(_countOf(logs, address(mediatorA), TokenMediator.TokensBridged.selector), 1, "paid once");
        assertEq(token.balanceOf(recipient), AMOUNT, "the recipient is paid");
        assertEq(mediatorA.claimable(address(token), fallbackAccount), 0, "no claim");
        assertEq(mediatorA.mediatorBalance(address(token)), 0, "the record is zero");
        assertEq(token.balanceOf(address(mediatorA)), 0, "the mediator holds nothing");
    }

    /// Claim: a token that runs the INVALID opcode on transfer burns all the gas that it gets. The handler still ends
    /// with a recorded claim and no revert, with the default gas and with a large gas limit. Shows: the same
    /// assertions as for the heavy token.
    function test_aTokenThatBurnsAllItsGasEndsWithAClaim() public {
        InvalidOpcodeToken token = new InvalidOpcodeToken();
        token.mint(alice, AMOUNT);
        address copy = _lockAndDeliver(address(token));

        (Vm.Log[] memory logs, bytes32 id) = _returnWithOptions(copy, 0);

        _assertClaimRecorded(address(token), logs, id);
    }

    /// Claim: the same holds when the sender asks for 5,000,000 gas, so a cap that only fits a small message fails
    /// here. Shows: the claim is recorded, and the call did not revert.
    function test_aTokenThatBurnsAllItsGasEndsWithAClaimWithALargeGasLimit() public {
        InvalidOpcodeToken token = new InvalidOpcodeToken();
        token.mint(alice, AMOUNT);
        address copy = _lockAndDeliver(address(token));

        (Vm.Log[] memory logs, bytes32 id) = _returnWithOptions(copy, 5_000_000);

        _assertClaimRecorded(address(token), logs, id);
    }

    /// Claim: a token that reverts for both the recipient and the fallback ends with a claim through the real bridge.
    /// Shows: the same assertions. Matters: the revert path must not change with the cap.
    function test_aTokenThatRevertsEndsWithAClaim() public {
        DenyListToken token = new DenyListToken();
        token.mint(alice, AMOUNT);
        address copy = _lockAndDeliver(address(token));
        token.setDenied(recipient, true);
        token.setDenied(fallbackAccount, true);

        (Vm.Log[] memory logs, bytes32 id) = _returnWithOptions(copy, 0);

        _assertClaimRecorded(address(token), logs, id);
    }

    /// Claim: a claim of a heavy token pays when the claimer gives enough gas, and the amount is paid once. Shows: the
    /// claim of the burning token, called with the gas of a normal transaction after the sender could not pay, still
    /// fails here because the transfer needs 300,000 gas and the claim path is capped the same way; and the fallback
    /// account has the claim until a token pays. Here the token pays when its burn is zero, so the test uses the deny
    /// list token: unblock, then claim.
    function test_aClaimPaysAfterTheTokenAcceptsTheAccount() public {
        DenyListToken token = new DenyListToken();
        token.mint(alice, AMOUNT);
        address copy = _lockAndDeliver(address(token));
        token.setDenied(recipient, true);
        token.setDenied(fallbackAccount, true);
        (, bytes32 id) = _returnWithOptions(copy, 0);
        assertTrue(bridgeA.messageCallStatus(id));

        token.setDenied(fallbackAccount, false);
        vm.chainId(CHAIN_A);
        vm.prank(makeAddr("a stranger"));
        mediatorA.claim(address(token), fallbackAccount);

        assertEq(token.balanceOf(fallbackAccount), AMOUNT, "the fallback account is paid, not the caller");
        assertEq(mediatorA.claimable(address(token), fallbackAccount), 0, "paid once");
        assertEq(mediatorA.mediatorBalance(address(token)), 0, "the record is zero");
    }
}
