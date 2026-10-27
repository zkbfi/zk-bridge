// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Vm} from "forge-std/Vm.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {TokenMediator} from "../../../src/hardened/mediator/TokenMediator.sol";
import {MediatorFixture, ScriptedMediatorLimiter} from "./utils/MediatorSupport.sol";

/// @notice Tests of the flow limiter hook of the mediator, and of the exact value of a relay and of a delivery. The
/// one role, its removal, the limit on a relay, and the claim of a refused release. A refused release cannot revert,
/// because the message bridge marks the message delivered anyway, so the mediator records a claim and `claim` asks the
/// limiter again.
contract TokenMediatorLimiterTest is MediatorFixture {
    event FlowLimiterDetached(address indexed limiter);
    event ClaimableRecorded(address indexed token, address indexed account, uint256 value, bytes32 indexed messageId);
    event TokensBridgingInitiated(
        address indexed token, address indexed sender, uint256 value, bytes32 indexed messageId
    );
    event TokensBridged(address indexed token, address indexed recipient, uint256 value, bytes32 indexed messageId);

    /// @dev Terms with the given flow limiter, or none when it is zero.
    function _limiterTerms(address limiter) internal pure returns (TokenMediator.MediatorTerms memory terms) {
        terms = _noTerms();
        terms.flowLimiter = limiter;
    }

    function _redeploy(TokenMediator.MediatorTerms memory termsA, TokenMediator.MediatorTerms memory termsB) internal {
        _deployMediators(termsA, termsB);
        vm.prank(alice);
        tokenA.approve(address(mediatorA), type(uint256).max);
    }

    // ------------------------------------------------------------------------------------------------ exact value

    /// Claim: a relay and a delivery move exactly the relayed value, and no event names another value. Shows: a relay
    /// of 1,000 raises the balance of the mediator and the record by 1,000, and its event names 1,000; the delivery
    /// mints 1,000 and its event names 1,000; the way back burns 600 and releases 600, so the balance, the record and
    /// the supply fall by exactly 600. Matters: the mediator takes no fee, so no unit is held back on either side of
    /// the bridge.
    function test_aRelayAndADeliveryMoveExactlyTheRelayedValue() public {
        uint256 value = 1_000 ether;
        vm.recordLogs();
        vm.prank(alice);
        mediatorA.relayTokens(address(tokenA), bob, value);
        assertEq(_valueOfEvent(address(mediatorA), TokensBridgingInitiated.selector), value, "the relay event");
        assertEq(tokenA.balanceOf(address(mediatorA)), value, "the balance grew by the value");
        assertEq(mediatorA.mediatorBalance(address(tokenA)), value, "the record grew by the value");

        vm.recordLogs();
        (bool ok,) = _deliverAtoB(_lastIndexA());
        assertTrue(ok);
        assertEq(_valueOfEvent(address(mediatorB), TokensBridged.selector), value, "the delivery event");
        address copy = _copyOf(address(tokenA));
        assertEq(IERC20(copy).balanceOf(bob), value, "the receiver holds the whole value");
        assertEq(IERC20(copy).totalSupply(), value);
        assertEq(IERC20(copy).balanceOf(address(mediatorB)), 0, "the mediator on chain B holds no copy");

        _bridgeBtoA(bob, copy, carol, 600 ether);
        assertEq(tokenA.balanceOf(carol), 600 ether, "the whole value comes back");
        assertEq(mediatorA.mediatorBalance(address(tokenA)), 400 ether, "the record fell by the value");
        assertEq(tokenA.balanceOf(address(mediatorA)), 400 ether, "the balance fell by the value");
        assertEq(IERC20(copy).totalSupply(), 400 ether, "the supply fell by the value");
    }

    /// @dev The value in the data of the last recorded event of one kind from one emitter. Both events carry the value
    /// as their only unindexed word.
    function _valueOfEvent(address emitter, bytes32 topic) private view returns (uint256 value) {
        Vm.Log[] memory logs = vm.getRecordedLogs();
        bool found;
        for (uint256 i = 0; i < logs.length; i++) {
            if (logs[i].emitter != emitter || logs[i].topics[0] != topic) continue;
            value = abi.decode(logs[i].data, (uint256));
            found = true;
        }
        assertTrue(found, "the event was emitted");
    }

    // ------------------------------------------------------------------------------------------------ flow limiter

    /// Claim: the limiter sees the whole relayed value, the local token and the sender. Matters: the mediator takes
    /// no cut, so the limit applies to what the sender gave.
    function test_theLimiterSeesTheValueTheLocalTokenAndTheSender() public {
        ScriptedMediatorLimiter limiter = new ScriptedMediatorLimiter();
        _redeploy(_limiterTerms(address(limiter)), _limiterTerms(address(0)));
        vm.prank(alice);
        mediatorA.relayTokens(address(tokenA), bob, 1_000 ether);
        assertEq(limiter.depositChecks(), 1);
        assertEq(limiter.lastDepositToken(), address(tokenA));
        assertEq(limiter.lastDepositor(), alice);
        assertEq(limiter.lastDepositAmount(), 1_000 ether, "the whole value");
    }

    function test_aLimiterThatRefusesADepositRevertsTheRelay() public {
        ScriptedMediatorLimiter limiter = new ScriptedMediatorLimiter();
        _redeploy(_limiterTerms(address(limiter)), _limiterTerms(address(0)));
        limiter.setRefusals(true, false);
        vm.prank(alice);
        vm.expectRevert(ScriptedMediatorLimiter.FlowRefused.selector);
        mediatorA.relayTokens(address(tokenA), bob, 1 ether);
        assertEq(tokenA.balanceOf(alice), 1_000_000 ether);

        limiter.setRefusals(false, false);
        vm.prank(alice);
        mediatorA.relayTokens(address(tokenA), bob, 1 ether);
        assertEq(ambA.sentCount(), 1);
    }

    function test_theLimiterSeesTheReleaseWithTheMessageIdentifierAsNonce() public {
        ScriptedMediatorLimiter limiter = new ScriptedMediatorLimiter();
        _redeploy(_limiterTerms(address(limiter)), _limiterTerms(address(0)));
        _bridgeAtoB(alice, address(tokenA), bob, 100 ether);
        _bridgeBtoA(bob, _copyOf(address(tokenA)), carol, 60 ether);

        assertEq(limiter.withdrawalChecks(), 1);
        assertEq(limiter.lastWithdrawalToken(), address(tokenA), "the local token");
        assertEq(limiter.lastWithdrawalRecipient(), carol);
        assertEq(limiter.lastWithdrawalAmount(), 60 ether);
        assertEq(limiter.lastWithdrawalNonce(), ambB.messageAt(0).id, "the nonce is the message identifier");
        assertEq(tokenA.balanceOf(carol), 60 ether);
    }

    function test_aLimiterThatRefusesAReleaseLeavesAClaimAndTheDeliveryHolds() public {
        ScriptedMediatorLimiter limiter = new ScriptedMediatorLimiter();
        _redeploy(_limiterTerms(address(limiter)), _limiterTerms(address(0)));
        _bridgeAtoB(alice, address(tokenA), bob, 100 ether);
        address copy = _copyOf(address(tokenA));
        vm.startPrank(bob);
        IERC20(copy).approve(address(mediatorB), type(uint256).max);
        mediatorB.relayTokens(copy, carol, 60 ether);
        vm.stopPrank();

        limiter.setRefusals(false, true);
        bytes32 id = ambB.messageAt(0).id;
        vm.expectEmit(true, true, true, true, address(mediatorA));
        emit ClaimableRecorded(address(tokenA), carol, 60 ether, id);
        (bool ok,) = _deliverBtoA(0);
        assertTrue(ok, "the refusal does not revert the delivery, which would lose the tokens");
        assertEq(tokenA.balanceOf(carol), 0);
        assertEq(mediatorA.claimable(address(tokenA), carol), 60 ether);
        assertEq(mediatorA.mediatorBalance(address(tokenA)), 100 ether, "the record still counts the amount");

        // The claim asks the limiter again. A refusal reverts and the claim stays.
        vm.expectRevert(ScriptedMediatorLimiter.FlowRefused.selector);
        mediatorA.claim(address(tokenA), carol);
        assertEq(mediatorA.claimable(address(tokenA), carol), 60 ether);

        limiter.setRefusals(false, false);
        mediatorA.claim(address(tokenA), carol);
        assertEq(tokenA.balanceOf(carol), 60 ether);
        assertEq(limiter.lastWithdrawalNonce(), bytes32(0), "a claim has a zero nonce");
        assertEq(mediatorA.mediatorBalance(address(tokenA)), 40 ether);
    }

    function test_onlyTheLimiterCanDetachAndItIsOneWay() public {
        ScriptedMediatorLimiter limiter = new ScriptedMediatorLimiter();
        _redeploy(_limiterTerms(address(limiter)), _limiterTerms(address(0)));
        assertEq(address(mediatorA.flowLimiter()), address(limiter));

        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(TokenMediator.NotFlowLimiter.selector, alice));
        mediatorA.detachFlowLimiter();

        vm.expectEmit(true, false, false, false, address(mediatorA));
        emit FlowLimiterDetached(address(limiter));
        limiter.detachFrom(mediatorA);
        assertEq(address(mediatorA.flowLimiter()), address(0));

        vm.expectRevert(abi.encodeWithSelector(TokenMediator.NotFlowLimiter.selector, address(limiter)));
        limiter.detachFrom(mediatorA);
    }

    function test_afterADetachTheMediatorNeverCallsTheLimiter() public {
        ScriptedMediatorLimiter limiter = new ScriptedMediatorLimiter();
        _redeploy(_limiterTerms(address(limiter)), _limiterTerms(address(0)));
        limiter.setRefusals(true, true);
        limiter.detachFrom(mediatorA);

        _bridgeAtoB(alice, address(tokenA), bob, 10 ether);
        _bridgeBtoA(bob, _copyOf(address(tokenA)), bob, 10 ether);
        assertEq(limiter.depositChecks(), 0);
        assertEq(limiter.withdrawalChecks(), 0);
        assertEq(tokenA.balanceOf(bob), 10 ether);
    }

    function test_theMediatorHasNoFunctionThatSetsALimiter() public view {
        // The only function that writes the limiter is `detachFlowLimiter`. The constructor sets it once.
        bytes4[3] memory setters = [
            bytes4(keccak256("setFlowLimiter(address)")),
            bytes4(keccak256("attachFlowLimiter(address)")),
            bytes4(keccak256("replaceFlowLimiter(address)"))
        ];
        for (uint256 i = 0; i < setters.length; i++) {
            (bool ok,) = address(mediatorA).staticcall(abi.encodeWithSelector(setters[i], address(0x1234)));
            assertFalse(ok);
        }
    }
}
