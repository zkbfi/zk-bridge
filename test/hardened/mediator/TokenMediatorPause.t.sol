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

/// @notice A token that an issuer can freeze, and a recipient that is a contract. Both run through the real bridge and
/// the real mediator. A release that the token refuses is final: the handler emits `ReleaseFailed`, and nobody is paid. The
/// tests assert who is paid, who is not, and every balance.
contract TokenMediatorPauseTest is WorldSupport {
    uint256 internal constant AMOUNT = 100 ether;

    address internal recipient = makeAddr("recipient on A");
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

    /// @dev Bob sends the copy back to `to`. Returns the proof, not yet executed.
    function _sendBack(address copy, address to) internal returns (Transit memory) {
        vm.chainId(CHAIN_B);
        vm.startPrank(bob);
        BridgedToken(copy).approve(address(mediatorB), type(uint256).max);
        vm.recordLogs();
        mediatorB.relayTokens(copy, to, AMOUNT);
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

    /// Claim: a token that is paused during a release ends the release for good. Shows: with the pause on, the
    /// handler does not revert, `ReleaseFailed` names the recipient and the amount, nobody holds tokens, the record
    /// falls by the release and the tokens stay in the mediator, owed to nobody. After the unpause nothing pays the
    /// recipient: the mediator has no claim. Matters: this is the cost of a token that an issuer freezes, and it is
    /// the rule of the design: if tokens get stuck, they are stuck for good.
    function test_aPausedTokenEndsTheReleaseForGood() public {
        PausableToken token = new PausableToken("Pausable Dollar", "PAUSE");
        token.mint(alice, AMOUNT);
        address copy = _lockAndDeliver(address(token));
        Transit memory transit = _sendBack(copy, recipient);

        token.pause();
        Vm.Log[] memory logs = _executeOnA(transit);

        assertEq(_count(logs, address(mediatorA), TokenMediator.ReleaseFailed.selector), 1, "one failure event");
        assertEq(_count(logs, address(mediatorA), TokenMediator.TokensBridged.selector), 0, "nobody was paid");
        assertEq(token.balanceOf(recipient), 0, "the recipient holds nothing");
        assertEq(token.balanceOf(address(mediatorA)), AMOUNT, "the mediator still holds the tokens");
        assertEq(mediatorA.mediatorBalance(address(token)), 0, "the record fell by the release");
        assertEq(IERC20(copy).totalSupply(), 0, "the copies are burned");

        token.unpause();
        (bool claimed,) = address(mediatorA).call(abi.encodeWithSignature("claim(address,address)", address(token), recipient));
        assertFalse(claimed, "the mediator has no claim function");
        assertEq(token.balanceOf(recipient), 0, "nothing pays the recipient later");
        assertEq(token.balanceOf(stranger), 0);
        assertEq(token.balanceOf(address(mediatorA)), AMOUNT, "the tokens stay in the mediator");
    }

    /// Claim: when the pause ends before the release, the recipient is paid and nothing is claimable. Shows: the control
    /// of the test above, with the same token: pause, unpause, then deliver.
    function test_aTokenThatIsPausedAndUnpausedBeforeTheReleasePaysTheRecipient() public {
        PausableToken token = new PausableToken("Pausable Dollar", "PAUSE");
        token.mint(alice, AMOUNT);
        address copy = _lockAndDeliver(address(token));
        Transit memory transit = _sendBack(copy, recipient);
        token.pause();
        token.unpause();

        Vm.Log[] memory logs = _executeOnA(transit);

        assertEq(_count(logs, address(mediatorA), TokenMediator.TokensBridged.selector), 1, "paid once");
        assertEq(token.balanceOf(recipient), AMOUNT, "the recipient is paid");
        assertEq(_count(logs, address(mediatorA), TokenMediator.ReleaseFailed.selector), 0, "no failure");
        assertEq(mediatorA.mediatorBalance(address(token)), 0, "the record is zero");
    }

    /// Claim: a recipient that is a contract, here Multicall3, is paid like any account when the token accepts it.
    /// This is allowed by design. The bridge is an arbitrary message bus, and contract recipients and routers are
    /// normal. Shows: Multicall3 holds the amount, and no claim is recorded.
    function test_aContractRecipientIsPaid() public {
        DenyListToken token = new DenyListToken();
        token.mint(alice, AMOUNT);
        address copy = _lockAndDeliver(address(token));
        Multicall3 multicall = new Multicall3();
        Transit memory transit = _sendBack(copy, address(multicall));

        Vm.Log[] memory logs = _executeOnA(transit);

        assertEq(_count(logs, address(mediatorA), TokenMediator.TokensBridged.selector), 1, "paid once");
        assertEq(token.balanceOf(address(multicall)), AMOUNT, "Multicall3 holds the amount");
        assertEq(_count(logs, address(mediatorA), TokenMediator.ReleaseFailed.selector), 0, "no failure");
        assertEq(mediatorA.mediatorBalance(address(token)), 0, "the record is zero");
        assertEq(token.balanceOf(address(mediatorA)), 0, "the mediator holds nothing");
    }

    /// Claim: a contract recipient that the token refuses ends the release for good. Shows: `ReleaseFailed` names
    /// Multicall3, no other account is paid, the record falls by the release, and the tokens stay in the mediator.
    function test_aContractRecipientThatTheTokenRefusesEndsTheReleaseForGood() public {
        DenyListToken token = new DenyListToken();
        token.mint(alice, AMOUNT);
        address copy = _lockAndDeliver(address(token));
        Multicall3 multicall = new Multicall3();
        Transit memory transit = _sendBack(copy, address(multicall));
        token.setDenied(address(multicall), true);

        Vm.Log[] memory logs = _executeOnA(transit);

        assertEq(_count(logs, address(mediatorA), TokenMediator.ReleaseFailed.selector), 1, "one failure event");
        assertEq(_count(logs, address(mediatorA), TokenMediator.TokensBridged.selector), 0, "nobody was paid");
        assertEq(token.balanceOf(address(multicall)), 0, "Multicall3 holds nothing");
        assertEq(token.balanceOf(address(mediatorA)), AMOUNT, "the mediator holds the amount");
        assertEq(mediatorA.mediatorBalance(address(token)), 0, "the record fell by the release");
    }

    /// Claim: a contract sender that calls a relay function names the receiver and nothing else, and the sender adds
    /// no address to the payload. Shows: Multicall3 holds tokens and relays through `aggregate3`, once with
    /// `relayTokens` and once with a gas limit. Both messages carry the same payload: the receiver is bob. Matters:
    /// the mediator never pays the sender on the other chain, so a contract sender need not exist there.
    function test_aContractSenderAddsNoAddressToThePayload() public {
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
            abi.encodeWithSignature(
                "relayTokens(address,address,uint256,uint256)", address(token), bob, AMOUNT, uint256(2_500_000)
            )
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
        bytes memory expected = abi.encodeWithSelector(
            TokenMediator.deployAndHandleBridgedTokens.selector, address(token), "Deny", "DENY", uint8(18), bob, AMOUNT
        );
        assertEq(first, expected, "relayTokens: the receiver is the only address");
        assertEq(second, expected, "relayTokens with a gas limit: the same payload");
        assertEq(token.balanceOf(address(multicall)), 0, "Multicall3 sent both amounts");
        assertEq(mediatorA.mediatorBalance(address(token)), 2 * AMOUNT, "the record");
    }
}
