// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {Vm} from "forge-std/Vm.sol";
import {BridgedToken} from "../../../src/hardened/mediator/BridgedToken.sol";
import {TokenMediator} from "../../../src/hardened/mediator/TokenMediator.sol";
import {WorldSupport} from "../utils/WorldSupport.sol";
import {DenyListToken} from "./utils/MediatorSupport.sol";
import {GasBurningToken, InvalidOpcodeToken, RevertingToken} from "./utils/HostileTokens.sol";

/// @notice A native token whose transfer uses much gas, or burns all the gas, or reverts. The release runs on the real
/// `MessageBridge` and the real mediator. The rule: a token that refuses (it reverts with gas to spare) ends with a
/// recorded `ReleaseFailed`, and the delivery completes; a token that runs out of the gas it got makes the delivery
/// revert (`ReleaseOutOfGas`), and the message waits for an executor with more gas. Each test reads the status that the
/// real bridge keeps for the message.
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

    /// @dev Bob sends the copy back to the recipient. Returns the proof of the release for chain A.
    function _returnRelease(address copy) internal returns (Transit memory transit) {
        vm.chainId(CHAIN_B);
        vm.startPrank(bob);
        BridgedToken(copy).approve(address(mediatorB), type(uint256).max);
        vm.recordLogs();
        mediatorB.relayTokens(copy, recipient, AMOUNT);
        vm.stopPrank();
        transit = _proveForA(vm.getRecordedLogs());
    }

    /// @dev Runs the release on chain A with exactly `gas`. Returns whether it went through, its error and its logs.
    function _deliverWithGas(Transit memory transit, uint256 gas)
        internal
        returns (bool ok, bytes memory error, Vm.Log[] memory logs)
    {
        vm.chainId(CHAIN_A);
        vm.recordLogs();
        (ok, error) = address(bridgeA).call{gas: gas}(abi.encodeCall(bridgeA.executeMessage, (transit.proof)));
        logs = vm.getRecordedLogs();
    }

    /// @dev Bob sends the copy back and the release runs on chain A with plenty of gas. Returns its logs and identifier.
    function _returnAndDeliver(address copy) internal returns (Vm.Log[] memory deliveryLogs, bytes32 messageId) {
        Transit memory transit = _returnRelease(copy);
        messageId = transit.messageId;
        bool ok;
        (ok,, deliveryLogs) = _deliverWithGas(transit, 10_000_000);
        assertTrue(ok, "the delivery went through");
    }

    /// @dev The release is still undelivered and nothing moved: the record and the balances are as before the attempt.
    function _assertWaiting(address token, bytes32 messageId) internal view {
        assertFalse(bridgeA.messageCallStatus(messageId), "the message waits");
        assertEq(mediatorA.mediatorBalance(token), AMOUNT, "the record is unchanged");
        assertEq(IERC20(token).balanceOf(address(mediatorA)), AMOUNT, "the mediator holds the tokens");
        assertEq(IERC20(token).balanceOf(recipient), 0, "nobody was paid");
    }

    function _countOf(Vm.Log[] memory logs, address emitter, bytes32 topic) internal pure returns (uint256 count) {
        for (uint256 i = 0; i < logs.length; i++) {
            if (logs[i].emitter == emitter && logs[i].topics[0] == topic) count++;
        }
    }

    /// @dev What a refusing token ends with: the delivery went through, one `ReleaseFailed` event names the recipient and
    /// the amount, nobody was paid, the record fell by the release, and the mediator still holds the tokens, owed to
    /// nobody.
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

    /// Claim: a token whose transfer burns 300,000 gas is paid when the executor brings the gas, and an executor that
    /// brings too little only reverts its own transaction. Shows: below the least gas that delivers, every attempt
    /// reverts and leaves the message waiting with nothing moved, and at least one of them reverts with
    /// `ReleaseOutOfGas` (the transfer ran out, not the proof); at the least gas the recipient is paid. Matters: before
    /// this redesign such a token ended with a final `ReleaseFailed` under the default gas of the message, and the
    /// sender had to know to ask for more.
    function test_aHeavyTokenIsPaidWhenTheExecutorBringsTheGas() public {
        GasBurningToken token = new GasBurningToken(300_000);
        token.mint(alice, AMOUNT);
        Transit memory transit = _returnRelease(_lockAndDeliver(address(token)));

        uint256 low = 300_000;
        uint256 high = 3_000_000;
        while (low < high) {
            uint256 middle = (low + high) / 2;
            uint256 snapshot = vm.snapshotState();
            (bool done,,) = _deliverWithGas(transit, middle);
            vm.revertToState(snapshot);
            if (done) high = middle;
            else low = middle + 1;
        }
        bool sawReleaseOutOfGas;
        for (uint256 offset = 1; offset <= 200_000; offset += 10_000) {
            (bool ok, bytes memory error,) = _deliverWithGas(transit, low - offset);
            assertFalse(ok, "less than the least gas reverts");
            if (bytes4(error) == TokenMediator.ReleaseOutOfGas.selector) sawReleaseOutOfGas = true;
            _assertWaiting(address(token), transit.messageId);
        }
        assertTrue(sawReleaseOutOfGas, "the transfer, starved, reverts the delivery");

        (bool delivered,, Vm.Log[] memory logs) = _deliverWithGas(transit, low);
        assertTrue(delivered, "the least gas delivers");
        assertEq(_countOf(logs, address(mediatorA), TokenMediator.TokensBridged.selector), 1, "paid once");
        assertEq(_countOf(logs, address(mediatorA), TokenMediator.ReleaseFailed.selector), 0, "never a failed release");
        assertEq(token.balanceOf(recipient), AMOUNT, "the recipient is paid");
        assertEq(mediatorA.mediatorBalance(address(token)), 0, "the record is zero");
    }

    /// Claim: a token that runs the INVALID opcode on transfer burns all the gas that it gets, so its release reverts
    /// with `ReleaseOutOfGas` at any gas, and the message waits; when the token later transfers normally, the same
    /// proof delivers. Shows: attempts with 1,000,000 and 10,000,000 gas revert with `ReleaseOutOfGas` and leave
    /// everything as it was; after the code of the token is replaced by a plain token with the same storage, the
    /// release pays the recipient. Matters: a failure that used up all its gas reads as a lack of gas, never as a
    /// refusal, so an executor cannot turn starvation into a final `ReleaseFailed`. The price: a token that burns all
    /// its gas keeps its release undelivered, instead of ending it.
    function test_aTokenThatBurnsAllItsGasKeepsItsReleaseWaiting() public {
        InvalidOpcodeToken token = new InvalidOpcodeToken();
        token.mint(alice, AMOUNT);
        Transit memory transit = _returnRelease(_lockAndDeliver(address(token)));

        uint256[2] memory gases = [uint256(1_000_000), 10_000_000];
        for (uint256 i = 0; i < gases.length; i++) {
            (bool ok, bytes memory error,) = _deliverWithGas(transit, gases[i]);
            assertFalse(ok, "the delivery reverts");
            assertEq(error, abi.encodeWithSelector(TokenMediator.ReleaseOutOfGas.selector, address(token)));
            _assertWaiting(address(token), transit.messageId);
        }

        vm.etch(address(token), address(new DenyListToken()).code);
        (bool delivered,,) = _deliverWithGas(transit, 10_000_000);
        assertTrue(delivered, "the same proof delivers");
        assertEq(IERC20(address(token)).balanceOf(recipient), AMOUNT, "the recipient is paid");
    }

    /// Claim: a recipient that the token blocks ends with a failed release through the real bridge, and the message is
    /// delivered. Shows: the assertions of a refusal. Matters: a refusal is final, so it cannot hold a message back.
    function test_aBlockedRecipientEndsWithAFailedRelease() public {
        DenyListToken token = new DenyListToken();
        token.mint(alice, AMOUNT);
        address copy = _lockAndDeliver(address(token));
        token.setDenied(recipient, true);

        (Vm.Log[] memory logs, bytes32 id) = _returnAndDeliver(copy);

        _assertReleaseFailed(address(token), logs, id);
    }

    /// Claim: a blocked recipient stays unpaid even after the token unblocks it. Shows: the release failed, and after
    /// `setDenied(recipient, false)` nothing pays: the mediator has no claim function, and the tokens stay in it; the
    /// same proof is refused as delivered.
    function test_aRecipientThatTheTokenUnblocksLaterIsNotPaid() public {
        DenyListToken token = new DenyListToken();
        token.mint(alice, AMOUNT);
        address copy = _lockAndDeliver(address(token));
        token.setDenied(recipient, true);
        Transit memory transit = _returnRelease(copy);
        (bool ok,,) = _deliverWithGas(transit, 10_000_000);
        assertTrue(ok);
        assertTrue(bridgeA.messageCallStatus(transit.messageId));

        token.setDenied(recipient, false);
        vm.chainId(CHAIN_A);
        vm.prank(makeAddr("a stranger"));
        (bool claimed,) = address(mediatorA).call(abi.encodeWithSignature("claim(address,address)", address(token), recipient));
        assertFalse(claimed, "the mediator has no claim function");
        (bool replayed,,) = _deliverWithGas(transit, 10_000_000);
        assertFalse(replayed, "the delivered message cannot run again");
        assertEq(token.balanceOf(recipient), 0, "the recipient is not paid");
        assertEq(token.balanceOf(address(mediatorA)), AMOUNT, "the tokens stay in the mediator");
        assertEq(mediatorA.mediatorBalance(address(token)), 0, "the record is zero");
    }

    /// Claim: a token whose transfer always reverts (with gas to spare) ends with a failed release through the real
    /// bridge, and the release is final. Shows: the assertions of a refusal. Matters: the token said no, so the
    /// delivery records it and completes.
    function test_aTokenThatRevertsOnEveryTransferEndsWithAFailedRelease() public {
        RevertingToken token = new RevertingToken();
        token.mint(alice, AMOUNT);
        address copy = _lockAndDeliver(address(token));

        (Vm.Log[] memory logs, bytes32 id) = _returnAndDeliver(copy);

        _assertReleaseFailed(address(token), logs, id);
    }
}
