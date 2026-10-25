// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {FeeOnTransferToken} from "../../../src/mocks/FeeOnTransferToken.sol";
import {TokenMediator} from "../../../src/hardened/mediator/TokenMediator.sol";
import {MediatorFixture, MockAMB, DenyListToken, ScriptedMediatorLimiter} from "./utils/MediatorSupport.sol";

/// @notice Tests of the fee switch and the flow limiter hook of the mediator. They follow the tests of the vault: the
/// one role, its ceiling, its removal, the limit on a relay, and the pull-based collection. The limiter cases differ in
/// one place: a refused release cannot revert, because the message bridge marks the message delivered anyway, so the
/// mediator records a claim and `claim` asks the limiter again.
contract TokenMediatorFeeTest is MediatorFixture {
    event FeeChanged(uint256 feeRate, address feeRecipient);
    event FeeNullified();
    event FeeCharged(address indexed token, uint256 fee);
    event FeesCollected(address indexed token, address indexed feeRecipient, uint256 amount);
    event FlowLimiterDetached(address indexed limiter);
    event ClaimableRecorded(address indexed token, address indexed account, uint256 value, bytes32 indexed messageId);

    address internal authority = makeAddr("authority");
    address internal treasury = makeAddr("treasury");

    function _feeTerms(uint256 rate, uint256 ceiling, address limiter)
        internal
        view
        returns (TokenMediator.MediatorTerms memory terms)
    {
        terms = _noTerms();
        terms.feeAuthority = authority;
        terms.feeRecipient = treasury;
        terms.feeRate = rate;
        terms.feeCeiling = ceiling;
        terms.flowLimiter = limiter;
    }

    function _redeploy(TokenMediator.MediatorTerms memory termsA, TokenMediator.MediatorTerms memory termsB) internal {
        _deployMediators(termsA, termsB);
        vm.prank(alice);
        tokenA.approve(address(mediatorA), type(uint256).max);
    }

    // ------------------------------------------------------------------------------------------------ terms

    function test_theDefaultMediatorHasNoFeeAndNoAuthority() public {
        assertEq(mediatorA.feeAuthority(), address(0));
        assertEq(mediatorA.feeRate(), 0);
        vm.expectRevert(abi.encodeWithSelector(TokenMediator.NotFeeAuthority.selector, authority));
        vm.prank(authority);
        mediatorA.setFee(1e14, treasury);
        vm.expectRevert(abi.encodeWithSelector(TokenMediator.NotFeeAuthority.selector, address(0)));
        vm.prank(address(0));
        mediatorA.setFee(1e14, treasury);
    }

    function test_aCeilingAboveOnePercentIsRefused() public {
        TokenMediator.MediatorTerms memory terms = _feeTerms(0, 1e16 + 1, address(0));
        terms.bridge = address(ambA);
        terms.remoteMediator = address(mediatorB);
        terms.remoteChainId = CHAIN_B;
        vm.expectRevert(abi.encodeWithSelector(TokenMediator.FeeCeilingTooHigh.selector, 1e16 + 1, 1e16));
        new TokenMediator(terms);
    }

    function test_aFeeAboveTheCeilingIsRefusedAtTheStart() public {
        TokenMediator.MediatorTerms memory terms = _feeTerms(51e14, 50e14, address(0));
        terms.bridge = address(ambA);
        terms.remoteMediator = address(mediatorB);
        terms.remoteChainId = CHAIN_B;
        vm.expectRevert(abi.encodeWithSelector(TokenMediator.FeeAboveCeiling.selector, 51e14, 50e14));
        new TokenMediator(terms);
    }

    function test_noAuthorityRequiresAZeroFeeAndZeroCeiling() public {
        TokenMediator.MediatorTerms memory terms = _noTerms();
        terms.bridge = address(ambA);
        terms.remoteMediator = address(mediatorB);
        terms.remoteChainId = CHAIN_B;
        terms.feeCeiling = 10e14;
        vm.expectRevert(abi.encodeWithSelector(TokenMediator.NullifiedFeeMustBeZero.selector, 0, 10e14));
        new TokenMediator(terms);
    }

    function test_aFeeAtTheStartNeedsARecipient() public {
        TokenMediator.MediatorTerms memory terms = _feeTerms(10e14, 50e14, address(0));
        terms.feeRecipient = address(0);
        terms.bridge = address(ambA);
        terms.remoteMediator = address(mediatorB);
        terms.remoteChainId = CHAIN_B;
        vm.expectRevert(TokenMediator.ZeroFeeRecipient.selector);
        new TokenMediator(terms);
    }

    // ------------------------------------------------------------------------------------------------ authority

    function test_theAuthoritySetsTheFeeWithinTheCeiling() public {
        _redeploy(_feeTerms(0, 50e14, address(0)), _feeTerms(0, 50e14, address(0)));
        vm.expectEmit(address(mediatorA));
        emit FeeChanged(40e14, treasury);
        vm.prank(authority);
        mediatorA.setFee(40e14, treasury);
        assertEq(mediatorA.feeRate(), 40e14);

        vm.startPrank(authority);
        vm.expectRevert(abi.encodeWithSelector(TokenMediator.FeeAboveCeiling.selector, 51e14, 50e14));
        mediatorA.setFee(51e14, treasury);
        vm.expectRevert(TokenMediator.ZeroFeeRecipient.selector);
        mediatorA.setFee(10e14, address(0));
        vm.stopPrank();

        vm.prank(bob);
        vm.expectRevert(abi.encodeWithSelector(TokenMediator.NotFeeAuthority.selector, bob));
        mediatorA.setFee(10e14, treasury);
    }

    function test_nullifyIsOneWayAndFeesAlreadyChargedCanStillBeCollected() public {
        _redeploy(_feeTerms(100e14, 100e14, address(0)), _feeTerms(0, 0, address(0)));
        _bridgeAtoB(alice, address(tokenA), bob, 10_000 ether);

        vm.expectEmit(address(mediatorA));
        emit FeeNullified();
        vm.prank(authority);
        mediatorA.nullifyFee();
        assertEq(mediatorA.feeRate(), 0);
        assertEq(mediatorA.feeAuthority(), address(0));

        vm.startPrank(authority);
        vm.expectRevert(abi.encodeWithSelector(TokenMediator.NotFeeAuthority.selector, authority));
        mediatorA.setFee(1e14, treasury);
        vm.expectRevert(abi.encodeWithSelector(TokenMediator.NotFeeAuthority.selector, authority));
        mediatorA.nullifyFee();
        vm.stopPrank();

        // New relays carry no fee. The fee charged before the nullify is still collectable.
        vm.prank(alice);
        mediatorA.relayTokens(address(tokenA), bob, 1_000 ether);
        assertEq(
            abi.decode(_tail(ambA.messageAt(1).data, 4 + 32 * 5), (uint256)), 1_000 ether, "no fee after the nullify"
        );
        mediatorA.collectFees(address(tokenA));
        assertEq(tokenA.balanceOf(treasury), 100 ether);
    }

    // ------------------------------------------------------------------------------------------------ charging

    function test_theFeeIsChargedOnTheReceivedAmountAndRoundedDown() public {
        _redeploy(_feeTerms(25e14, 100e14, address(0)), _feeTerms(0, 0, address(0)));
        vm.expectEmit(true, false, false, true, address(mediatorA));
        emit FeeCharged(address(tokenA), 24);
        vm.prank(alice);
        mediatorA.relayTokens(address(tokenA), bob, 9_999);
        // 9,999 * 0.25% = 24.99, rounded down to 24.
        assertEq(mediatorA.accruedFees(address(tokenA)), 24);
        assertEq(mediatorA.mediatorBalance(address(tokenA)), 9_975, "the record counts the net amount only");
        assertEq(tokenA.balanceOf(address(mediatorA)), 9_999);
        (bool ok,) = _deliverAtoB(0);
        assertTrue(ok);
        assertEq(IERC20(_copyOf(address(tokenA))).balanceOf(bob), 9_975, "the copy is minted for the net amount");
    }

    function test_aRateFinerThanOneBasisPointChargesTheExactAmount() public {
        // 0.0123% has more resolution than a whole basis point (0.01%) can say.
        uint256 rate = 123_000_000_000_000;
        _redeploy(_feeTerms(rate, 1e16, address(0)), _feeTerms(0, 0, address(0)));
        vm.prank(alice);
        mediatorA.relayTokens(address(tokenA), bob, 1_000_000 ether);
        // 1,000,000 ether * 0.0123% = 123 ether.
        assertEq(mediatorA.accruedFees(address(tokenA)), 123 ether);
        assertEq(mediatorA.mediatorBalance(address(tokenA)), 999_877 ether);
    }

    function test_theOnePercentCapIsEnforcedAtTheStartAndInSetFee() public {
        TokenMediator.MediatorTerms memory terms = _feeTerms(0, 1e16 + 1, address(0));
        terms.bridge = address(ambA);
        terms.remoteMediator = address(mediatorB);
        terms.remoteChainId = CHAIN_B;
        vm.expectRevert(abi.encodeWithSelector(TokenMediator.FeeCeilingTooHigh.selector, 1e16 + 1, 1e16));
        new TokenMediator(terms);

        terms = _feeTerms(0, 1e16, address(0));
        terms.bridge = address(ambA);
        terms.remoteMediator = address(mediatorB);
        terms.remoteChainId = CHAIN_B;
        TokenMediator atTheCap = new TokenMediator(terms);
        assertEq(atTheCap.feeCeiling(), 1e16, "the cap itself is accepted");

        vm.startPrank(authority);
        atTheCap.setFee(1e16, treasury);
        assertEq(atTheCap.feeRate(), 1e16);
        vm.expectRevert(abi.encodeWithSelector(TokenMediator.FeeAboveCeiling.selector, 1e16 + 1, 1e16));
        atTheCap.setFee(1e16 + 1, treasury);
        vm.stopPrank();
    }

    function test_aTinyAmountRoundsTheFeeDownToZeroAndPaysNoFee() public {
        _redeploy(_feeTerms(1e16, 1e16, address(0)), _feeTerms(0, 0, address(0)));
        vm.prank(alice);
        mediatorA.relayTokens(address(tokenA), bob, 99);
        // 99 * 1% = 0.99, rounded down to 0.
        assertEq(mediatorA.accruedFees(address(tokenA)), 0);
        assertEq(mediatorA.mediatorBalance(address(tokenA)), 99);

        vm.prank(alice);
        mediatorA.relayTokens(address(tokenA), bob, 199);
        assertEq(mediatorA.accruedFees(address(tokenA)), 1, "199 * 1% = 1.99, rounded down to 1");
        assertEq(mediatorA.mediatorBalance(address(tokenA)), 99 + 198);
    }

    function test_aHugeAmountDoesNotOverflowAndTheFeeNeverExceedsTheAmount() public {
        _redeploy(_feeTerms(1e16, 1e16, address(0)), _feeTerms(0, 0, address(0)));
        // The product of this amount and the rate is far above 2^256, so a plain multiplication would revert.
        uint256 unit = 2 ** 220;
        uint256 amount = 100 * unit;
        assertGt(amount, type(uint256).max / 1e16, "control: the plain product would overflow");
        tokenA.mint(alice, amount);
        vm.prank(alice);
        mediatorA.relayTokens(address(tokenA), bob, amount);
        assertEq(mediatorA.accruedFees(address(tokenA)), unit, "1% of the amount, exact");
        assertEq(mediatorA.mediatorBalance(address(tokenA)), 99 * unit);
    }

    /// Claim: at the highest rate the contract allows, the fee is exactly the amount divided by 100, rounded down,
    /// and never above the amount. Matters: `Math.mulDiv` keeps this true where the amount is so large that a plain
    /// product would overflow.
    function testFuzz_theFeeIsTheAmountOverOneHundredRoundedDownAndNeverAboveTheAmount(uint256 amount) public {
        amount = bound(amount, 1, type(uint240).max / 2);
        _redeploy(_feeTerms(1e16, 1e16, address(0)), _feeTerms(0, 0, address(0)));
        tokenA.mint(alice, amount);
        vm.prank(alice);
        mediatorA.relayTokens(address(tokenA), bob, amount);
        uint256 fee = mediatorA.accruedFees(address(tokenA));
        assertEq(fee, amount / 100);
        assertLe(fee, amount);
    }

    function test_collectFeesPaysTheRecipientOnceAndAnyoneMayCall() public {
        _redeploy(_feeTerms(100e14, 100e14, address(0)), _feeTerms(0, 0, address(0)));
        _bridgeAtoB(alice, address(tokenA), bob, 10_000 ether);
        assertEq(mediatorA.accruedFees(address(tokenA)), 100 ether);

        vm.expectEmit(true, true, false, true, address(mediatorA));
        emit FeesCollected(address(tokenA), treasury, 100 ether);
        vm.prank(dave);
        mediatorA.collectFees(address(tokenA));
        assertEq(tokenA.balanceOf(treasury), 100 ether);
        assertEq(mediatorA.accruedFees(address(tokenA)), 0);
        assertEq(tokenA.balanceOf(address(mediatorA)), 9_900 ether, "what remains is the record");

        vm.expectRevert(abi.encodeWithSelector(TokenMediator.NoFeesAccrued.selector, address(tokenA)));
        mediatorA.collectFees(address(tokenA));
    }

    function test_theFeeOnABridgedCopyStaysAsCopiesInTheMediator() public {
        _redeploy(_feeTerms(0, 0, address(0)), _feeTerms(100e14, 100e14, address(0)));
        _bridgeAtoB(alice, address(tokenA), bob, 1_000 ether);
        address copy = _copyOf(address(tokenA));

        vm.startPrank(bob);
        IERC20(copy).approve(address(mediatorB), type(uint256).max);
        mediatorB.relayTokens(copy, bob, 1_000 ether);
        vm.stopPrank();
        assertEq(mediatorB.accruedFees(copy), 10 ether);
        assertEq(IERC20(copy).balanceOf(address(mediatorB)), 10 ether, "the fee is held, not burned");
        assertEq(IERC20(copy).totalSupply(), 10 ether, "the net amount is burned");

        mediatorB.collectFees(copy);
        assertEq(IERC20(copy).balanceOf(treasury), 10 ether);
    }

    function test_theFeeIsChargedOnTheMeasuredAmountOfAFeeOnTransferToken() public {
        _redeploy(_feeTerms(100e14, 100e14, address(0)), _feeTerms(0, 0, address(0)));
        FeeOnTransferToken taxed = new FeeOnTransferToken("Taxed", "TAX");
        taxed.mint(alice, 1_000 ether);
        vm.startPrank(alice);
        taxed.approve(address(mediatorA), type(uint256).max);
        mediatorA.relayTokens(address(taxed), bob, 1_000 ether);
        vm.stopPrank();
        // 990 arrive. The fee is 1% of 990. The net amount is 980.1.
        assertEq(mediatorA.accruedFees(address(taxed)), 9.9 ether);
        assertEq(mediatorA.mediatorBalance(address(taxed)), 980.1 ether);
        assertEq(taxed.balanceOf(address(mediatorA)), 990 ether, "the balance covers the record and the fee");
    }

    function test_aRaiseAheadOfARelayCannotChargeMoreThanTheSenderAccepted() public {
        _redeploy(_feeTerms(25e14, 100e14, address(0)), _feeTerms(0, 0, address(0)));
        vm.prank(authority);
        mediatorA.setFee(50e14, treasury);

        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(TokenMediator.FeeAboveLimit.selector, 50e14, 25e14));
        mediatorA.relayTokensWithFallback(address(tokenA), bob, 1_000 ether, "", alice, 25e14);
        assertEq(tokenA.balanceOf(alice), 1_000_000 ether, "the tokens stay with the sender");

        vm.prank(alice);
        mediatorA.relayTokensWithFallback(address(tokenA), bob, 1_000 ether, "", alice, 50e14);
        assertEq(
            mediatorA.accruedFees(address(tokenA)), 5 ether, "the same relay passes with a limit that covers the fee"
        );
    }

    function test_theOmnibridgeFunctionsAcceptTheCurrentFee() public {
        _redeploy(_feeTerms(25e14, 100e14, address(0)), _feeTerms(0, 0, address(0)));
        vm.prank(authority);
        mediatorA.setFee(100e14, treasury);
        vm.prank(alice);
        mediatorA.relayTokens(address(tokenA), bob, 1_000 ether);
        assertEq(mediatorA.accruedFees(address(tokenA)), 10 ether, "no limit: the fee is bounded by the ceiling only");
    }

    function test_aRecipientThatTheTokenRefusesBlocksCollectionOnly() public {
        _redeploy(_feeTerms(100e14, 100e14, address(0)), _feeTerms(0, 0, address(0)));
        DenyListToken token = new DenyListToken();
        token.mint(alice, 1_000 ether);
        vm.startPrank(alice);
        token.approve(address(mediatorA), type(uint256).max);
        mediatorA.relayTokens(address(token), bob, 500 ether);
        vm.stopPrank();
        token.setDenied(treasury, true);

        vm.expectRevert(abi.encodeWithSelector(DenyListToken.TransferRefused.selector, treasury));
        mediatorA.collectFees(address(token));
        assertEq(mediatorA.accruedFees(address(token)), 5 ether, "the fee stays accrued");

        vm.prank(alice);
        mediatorA.relayTokens(address(token), bob, 500 ether);
        assertEq(ambA.sentCount(), 2, "relays keep working");
    }

    // ------------------------------------------------------------------------------------------------ flow limiter

    function test_theLimiterSeesTheNetAmountTheLocalTokenAndTheSender() public {
        ScriptedMediatorLimiter limiter = new ScriptedMediatorLimiter();
        _redeploy(_feeTerms(100e14, 100e14, address(limiter)), _feeTerms(0, 0, address(0)));
        vm.prank(alice);
        mediatorA.relayTokens(address(tokenA), bob, 1_000 ether);
        assertEq(limiter.depositChecks(), 1);
        assertEq(limiter.lastDepositToken(), address(tokenA));
        assertEq(limiter.lastDepositor(), alice);
        assertEq(limiter.lastDepositAmount(), 990 ether, "the net amount, after the fee");
    }

    function test_aLimiterThatRefusesADepositRevertsTheRelay() public {
        ScriptedMediatorLimiter limiter = new ScriptedMediatorLimiter();
        _redeploy(_feeTerms(0, 0, address(limiter)), _feeTerms(0, 0, address(0)));
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
        _redeploy(_feeTerms(0, 0, address(limiter)), _feeTerms(0, 0, address(0)));
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
        _redeploy(_feeTerms(0, 0, address(limiter)), _feeTerms(0, 0, address(0)));
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
        _redeploy(_feeTerms(0, 0, address(limiter)), _feeTerms(0, 0, address(0)));
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
        _redeploy(_feeTerms(0, 0, address(limiter)), _feeTerms(0, 0, address(0)));
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

    // ------------------------------------------------------------------------------------------------ helpers

    function _tail(bytes memory data, uint256 offset) private pure returns (bytes memory rest) {
        rest = new bytes(32);
        for (uint256 i = 0; i < 32; i++) {
            rest[i] = data[offset + i];
        }
    }
}
