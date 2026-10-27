// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {Vm} from "forge-std/Vm.sol";
import {PausableToken} from "../../../src/mocks/PausableToken.sol";
import {AmbMessageCodec} from "../../../src/hardened/AmbMessageCodec.sol";
import {BridgedToken} from "../../../src/hardened/mediator/BridgedToken.sol";
import {Multicall3} from "../../../src/hardened/vendor/multicall3/Multicall3.sol";
import {TokenMediator} from "../../../src/hardened/mediator/TokenMediator.sol";
import {WorldSupport} from "../utils/WorldSupport.sol";
import {DenyListToken} from "./utils/MediatorSupport.sol";

/// @notice A token that an issuer can freeze, and a fallback address that is a contract. Both run through the real
/// bridge and the real mediator. A release that the token refuses goes to the fallback address of the message, then to
/// the claim record of the fallback address. The tests assert who is paid, who is not, and every balance.
contract TokenMediatorPauseTest is WorldSupport {
    uint256 internal constant AMOUNT = 100 ether;

    address internal recipient = makeAddr("recipient on A");
    address internal fallbackAccount = makeAddr("fallback on A");
    address internal stranger = makeAddr("a stranger");

    /// @dev Locks `AMOUNT` of `token` on chain A for bob on chain B, and delivers the message.
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

    /// @dev Bob sends the copy back to `to`, with `fallbackTo` as the fallback. Returns the proof, not yet executed.
    function _sendBack(address copy, address to, address fallbackTo) internal returns (Transit memory) {
        vm.chainId(CHAIN_B);
        vm.startPrank(bob);
        BridgedToken(copy).approve(address(mediatorB), type(uint256).max);
        vm.recordLogs();
        mediatorB.relayTokensWithFallback(copy, to, AMOUNT, "", fallbackTo);
        vm.stopPrank();
        return _proveForA(vm.getRecordedLogs());
    }

    function _executeOnA(Transit memory transit) internal returns (Vm.Log[] memory) {
        vm.recordLogs();
        _execute(bridgeA, transit);
        assertTrue(bridgeA.messageCallStatus(transit.messageId), "the handler did not revert");
        return vm.getRecordedLogs();
    }

    function _count(Vm.Log[] memory logs, address emitter, bytes32 topic) internal pure returns (uint256 count) {
        for (uint256 i = 0; i < logs.length; i++) {
            if (logs[i].emitter == emitter && logs[i].topics[0] == topic) count++;
        }
    }

    /// Claim: a token that is paused during a release sends the amount to the claim record of the fallback address.
    /// After the unpause, anyone can trigger the claim, and the fallback address is paid, not the caller. Shows: with
    /// the pause on, the handler does not revert, nobody holds tokens, and `claimable` holds the amount for the fallback
    /// address and not for the recipient. A claim while the token is still paused reverts and keeps the record. After
    /// the unpause, a stranger calls `claim`: the fallback address holds the amount, the stranger and the recipient hold
    /// nothing, the record and `mediatorBalance` are zero, and a second claim reverts. Matters: this is the safe path
    /// for a token that an issuer freezes, and the pause may be short.
    function test_aPausedTokenLeavesAClaimForTheFallbackAddress() public {
        PausableToken token = new PausableToken("Pausable Dollar", "PAUSE");
        token.mint(alice, AMOUNT);
        address copy = _lockAndDeliver(address(token));
        Transit memory transit = _sendBack(copy, recipient, fallbackAccount);

        token.pause();
        Vm.Log[] memory logs = _executeOnA(transit);

        assertEq(_count(logs, address(mediatorA), TokenMediator.ClaimableRecorded.selector), 1, "one claim event");
        assertEq(_count(logs, address(mediatorA), TokenMediator.TokensBridged.selector), 0, "nobody was paid");
        assertEq(_count(logs, address(mediatorA), TokenMediator.FallbackUsed.selector), 0, "the fallback was not paid");
        assertEq(mediatorA.claimable(address(token), fallbackAccount), AMOUNT, "the fallback address can claim");
        assertEq(mediatorA.claimable(address(token), recipient), 0, "the recipient has no claim");
        assertEq(token.balanceOf(address(mediatorA)), AMOUNT, "the mediator still holds the tokens");
        assertEq(mediatorA.mediatorBalance(address(token)), AMOUNT, "the mediator still owes the tokens");

        vm.prank(stranger);
        vm.expectRevert(
            abi.encodeWithSelector(TokenMediator.ClaimTransferFailed.selector, address(token), fallbackAccount)
        );
        mediatorA.claim(address(token), fallbackAccount);
        assertEq(mediatorA.claimable(address(token), fallbackAccount), AMOUNT, "a failed claim keeps the record");

        token.unpause();
        vm.recordLogs();
        vm.prank(stranger);
        mediatorA.claim(address(token), fallbackAccount);
        Vm.Log[] memory claimLogs = vm.getRecordedLogs();

        assertEq(_count(claimLogs, address(mediatorA), TokenMediator.Claimed.selector), 1, "one claimed event");
        assertEq(token.balanceOf(fallbackAccount), AMOUNT, "the fallback address is paid");
        assertEq(token.balanceOf(stranger), 0, "the caller is not paid");
        assertEq(token.balanceOf(recipient), 0, "the recipient is not paid");
        assertEq(token.balanceOf(address(mediatorA)), 0, "the mediator holds nothing");
        assertEq(mediatorA.claimable(address(token), fallbackAccount), 0, "the record is zero");
        assertEq(mediatorA.mediatorBalance(address(token)), 0, "the mediator owes nothing");
        vm.prank(stranger);
        vm.expectRevert(abi.encodeWithSelector(TokenMediator.NothingToClaim.selector, address(token), fallbackAccount));
        mediatorA.claim(address(token), fallbackAccount);
    }

    /// Claim: when the pause ends before the release, the recipient is paid and nothing is claimable. Shows: the control
    /// of the test above, with the same token: pause, unpause, then deliver.
    function test_aTokenThatIsPausedAndUnpausedBeforeTheReleasePaysTheRecipient() public {
        PausableToken token = new PausableToken("Pausable Dollar", "PAUSE");
        token.mint(alice, AMOUNT);
        address copy = _lockAndDeliver(address(token));
        Transit memory transit = _sendBack(copy, recipient, fallbackAccount);
        token.pause();
        token.unpause();

        Vm.Log[] memory logs = _executeOnA(transit);

        assertEq(_count(logs, address(mediatorA), TokenMediator.TokensBridged.selector), 1, "paid once");
        assertEq(token.balanceOf(recipient), AMOUNT, "the recipient is paid");
        assertEq(token.balanceOf(fallbackAccount), 0, "the fallback address is not paid");
        assertEq(mediatorA.claimable(address(token), fallbackAccount), 0, "no claim");
        assertEq(mediatorA.mediatorBalance(address(token)), 0, "the record is zero");
    }

    /// Claim: a fallback address that is a contract, here Multicall3, is paid when the recipient cannot be. This is
    /// allowed by design. The bridge is an arbitrary message bus, and contract senders, routers and fallback
    /// addresses are normal. Shows: the token refuses the recipient, `FallbackUsed` names the recipient and Multicall3,
    /// Multicall3 holds the amount, and no claim is recorded.
    function test_aContractFallbackAddressIsPaidWhenTheRecipientIsRefused() public {
        DenyListToken token = new DenyListToken();
        token.mint(alice, AMOUNT);
        address copy = _lockAndDeliver(address(token));
        Multicall3 multicall = new Multicall3();
        Transit memory transit = _sendBack(copy, recipient, address(multicall));
        token.setDenied(recipient, true);

        Vm.Log[] memory logs = _executeOnA(transit);

        assertEq(_count(logs, address(mediatorA), TokenMediator.FallbackUsed.selector), 1, "the fallback was used");
        assertEq(token.balanceOf(address(multicall)), AMOUNT, "Multicall3 holds the amount");
        assertEq(token.balanceOf(recipient), 0, "the recipient holds nothing");
        assertEq(mediatorA.claimable(address(token), address(multicall)), 0, "no claim");
        assertEq(mediatorA.mediatorBalance(address(token)), 0, "the record is zero");
        assertEq(token.balanceOf(address(mediatorA)), 0, "the mediator holds nothing");
    }

    /// Claim: a contract sender that calls `relayTokens` is its own fallback address, and one that wants another
    /// address calls `relayTokensWithFallback`. Shows: Multicall3 holds tokens and relays through `aggregate3`. The
    /// first message names Multicall3 as the fallback address (the same address on the other chain). The second names
    /// alice. Matters: the documentation tells a contract sender to name its fallback address.
    function test_aContractSenderNamesItsFallbackWithRelayTokensWithFallback() public {
        DenyListToken token = new DenyListToken();
        Multicall3 multicall = new Multicall3();
        token.mint(address(multicall), 2 * AMOUNT);

        Multicall3.Call3[] memory calls = new Multicall3.Call3[](3);
        calls[0] = Multicall3.Call3(
            address(token), false, abi.encodeCall(IERC20.approve, (address(mediatorA), type(uint256).max))
        );
        calls[1] = Multicall3.Call3(
            address(mediatorA),
            false,
            abi.encodeWithSignature("relayTokens(address,address,uint256)", address(token), bob, AMOUNT)
        );
        calls[2] = Multicall3.Call3(
            address(mediatorA),
            false,
            abi.encodeCall(TokenMediator.relayTokensWithFallback, (address(token), bob, AMOUNT, "", alice))
        );
        vm.chainId(CHAIN_A);
        vm.recordLogs();
        multicall.aggregate3(calls);
        Vm.Log[] memory logs = vm.getRecordedLogs();

        bytes32 topic = bridgeA.USER_REQUEST_TOPIC();
        Vm.Log[] memory sent = new Vm.Log[](2);
        uint256 found;
        for (uint256 i = 0; i < logs.length; i++) {
            if (logs[i].emitter == address(bridgeA) && logs[i].topics[0] == topic) sent[found++] = logs[i];
        }
        assertEq(found, 2, "two messages");
        (, bytes memory first) = AmbMessageCodec.decode(abi.decode(sent[0].data, (bytes)));
        (, bytes memory second) = AmbMessageCodec.decode(abi.decode(sent[1].data, (bytes)));
        assertEq(
            first,
            abi.encodeWithSelector(
                TokenMediator.deployAndHandleBridgedTokensWithFallback.selector,
                address(token),
                "Deny",
                "DENY",
                uint8(18),
                bob,
                AMOUNT,
                address(multicall)
            ),
            "relayTokens: the contract sender is its own fallback address"
        );
        assertEq(
            second,
            abi.encodeWithSelector(
                TokenMediator.deployAndHandleBridgedTokensWithFallback.selector,
                address(token),
                "Deny",
                "DENY",
                uint8(18),
                bob,
                AMOUNT,
                alice
            ),
            "relayTokensWithFallback: the sender names another fallback address"
        );
        assertEq(token.balanceOf(address(multicall)), 0, "Multicall3 sent both amounts");
        assertEq(mediatorA.mediatorBalance(address(token)), 2 * AMOUNT, "the record");
    }
}
