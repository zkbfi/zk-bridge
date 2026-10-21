// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {console2} from "forge-std/console2.sol";
import {BridgeVault} from "../../src/hardened/BridgeVault.sol";
import {SupplyShareFlowLimiter} from "../../src/hardened/SupplyShareFlowLimiter.sol";
import {MockERC20} from "../../src/mocks/MockERC20.sol";
import {WithdrawalScenes} from "./utils/WithdrawalScenes.sol";
import {ReceiptFixtures} from "./utils/ReceiptFixtures.sol";

/// @notice Tests of the supply-share flow limiter: the first rule set for the flow limiter hook. Most tests call the
/// limiter as its vault (a prank). The sunset tests and the end-to-end test use a real vault.
contract SupplyShareFlowLimiterTest is WithdrawalScenes {
    event FlowLimiterDetached(address indexed limiter);

    uint256 internal constant DAY = 86_400;
    /// @dev 0.1 percent of 100 million ETH, and of 100 trillion PLS, in base units of 18 decimals.
    uint256 internal constant ETH_CAP = 100_000e18;
    uint256 internal constant PLS_CAP = 100_000_000_000e18;

    address internal unitVault = makeAddr("unit vault");
    MockERC20 internal wrappedEther;
    MockERC20 internal wrappedPulse;
    MockERC20 internal plainToken;
    SupplyShareFlowLimiter internal limiter;

    function setUp() public override {
        super.setUp();
        wrappedEther = new MockERC20("Wrapped Ether", "WETH");
        wrappedPulse = new MockERC20("Wrapped Pulse", "WPLS");
        plainToken = new MockERC20("Plain", "PLN");
        // Wrapped tokens hold only what is wrapped, so their real supplies are tiny next to the asset's supply.
        wrappedEther.mint(alice, 1e18);
        wrappedPulse.mint(alice, 1e18);
        limiter = _newLimiter(unitVault, 0, _twoSupplies());
    }

    // ---------------------------------------------------------------- helpers

    /// @dev The first limit of the user: wrapped ETH at 100 million ETH and wrapped PLS at 100 trillion PLS.
    function _twoSupplies() internal view returns (SupplyShareFlowLimiter.FixedSupply[] memory supplies) {
        supplies = new SupplyShareFlowLimiter.FixedSupply[](2);
        supplies[0] = SupplyShareFlowLimiter.FixedSupply(address(wrappedEther), 100_000_000e18);
        supplies[1] = SupplyShareFlowLimiter.FixedSupply(address(wrappedPulse), 100_000_000_000_000e18);
    }

    function _oneSupply(address token, uint256 supply)
        internal
        pure
        returns (SupplyShareFlowLimiter.FixedSupply[] memory supplies)
    {
        supplies = new SupplyShareFlowLimiter.FixedSupply[](1);
        supplies[0] = SupplyShareFlowLimiter.FixedSupply(token, supply);
    }

    /// @dev A limiter with a share of 10 basis points and a window of one day.
    function _newLimiter(address vault_, uint64 sunsetTimestamp, SupplyShareFlowLimiter.FixedSupply[] memory supplies)
        internal
        returns (SupplyShareFlowLimiter)
    {
        return new SupplyShareFlowLimiter(vault_, 10, uint64(DAY), sunsetTimestamp, supplies);
    }

    /// @dev A withdrawal check, made as the vault of `target`.
    function _withdraw(SupplyShareFlowLimiter target, address token, uint256 amount) internal {
        vm.prank(target.vault());
        target.checkWithdrawal(token, bob, amount, bytes32(0));
    }

    /// @dev Calls the check as the vault and expects the exact refusal.
    function _assertRefused(SupplyShareFlowLimiter target, address token, uint256 amount, uint256 available) internal {
        address vault_ = target.vault();
        vm.expectRevert(abi.encodeWithSelector(SupplyShareFlowLimiter.FlowRefused.selector, token, amount, available));
        vm.prank(vault_);
        target.checkWithdrawal(token, bob, amount, bytes32(0));
    }

    // ================================================================ who may call

    /// Claim: only the vault may call either check. Shows: three outsiders (a user, this test, the limiter itself)
    /// revert with `NotVault` and their own address on both functions, and a refused call spends none of the allowance;
    /// the vault passes. Matters: without this, anyone could use up the allowance and block honest withdrawals.
    function test_supplyShare_onlyTheVaultMayCallEitherCheck() public {
        address[3] memory outsiders = [alice, address(this), address(limiter)];
        for (uint256 i = 0; i < outsiders.length; i++) {
            vm.prank(outsiders[i]);
            vm.expectRevert(abi.encodeWithSelector(SupplyShareFlowLimiter.NotVault.selector, outsiders[i]));
            limiter.checkDeposit(address(wrappedEther), alice, 1);
            vm.prank(outsiders[i]);
            vm.expectRevert(abi.encodeWithSelector(SupplyShareFlowLimiter.NotVault.selector, outsiders[i]));
            limiter.checkWithdrawal(address(wrappedEther), bob, ETH_CAP, bytes32(0));
        }
        assertEq(limiter.availableNow(address(wrappedEther)), ETH_CAP, "outsiders spent nothing");

        vm.prank(unitVault);
        limiter.checkDeposit(address(wrappedEther), alice, 1); // control: the vault passes
        _withdraw(limiter, address(wrappedEther), ETH_CAP);
        assertEq(limiter.availableNow(address(wrappedEther)), 0, "the vault spent the allowance");
    }

    // ================================================================ deposits

    /// Claim: deposits always pass and change nothing. Shows: a deposit of the largest possible amount passes; it passes
    /// for a token that holds no code (so the limiter never reads the supply); it passes while the allowance of the
    /// token is spent; and it does not move the allowance. Matters: a forged proof drains through withdrawals, not
    /// deposits, so deposits stay free.
    function test_supplyShare_depositsAlwaysPass() public {
        address noCode = makeAddr("a token with no code");
        vm.startPrank(unitVault);
        limiter.checkDeposit(address(wrappedEther), alice, type(uint256).max);
        limiter.checkDeposit(noCode, alice, 1);
        vm.stopPrank();

        _withdraw(limiter, address(wrappedEther), ETH_CAP);
        assertEq(limiter.availableNow(address(wrappedEther)), 0);
        vm.prank(unitVault);
        limiter.checkDeposit(address(wrappedEther), alice, 1e18);
        assertEq(limiter.availableNow(address(wrappedEther)), 0, "a deposit gives no allowance");
    }

    // ================================================================ cap

    /// Claim: the cap of a token with a fixed supply is a share of that supply, and the on-chain supply does not matter.
    /// Shows: wrapped ETH at 100,000,000 ETH has a cap of exactly 100,000 ETH, wrapped PLS at 100,000,000,000,000 PLS has a
    /// cap of exactly 100,000,000,000 PLS (both in base units), although each token has a real supply of 1 token; a
    /// withdrawal of exactly the cap passes and one wei more than the cap refuses on the second try. Matters: the
    /// numbers the user chose, and the fixed supply for tokens that only hold the wrapped part of an asset.
    function test_supplyShare_capFromAFixedSupply_wrappedEtherAndWrappedPulse() public {
        assertEq(limiter.capOf(address(wrappedEther)), 100_000e18, "100,000 ETH");
        assertEq(limiter.capOf(address(wrappedPulse)), 100_000_000_000e18, "100,000,000,000 PLS");
        assertEq(wrappedEther.totalSupply(), 1e18, "the real supply is not used");
        assertEq(limiter.availableNow(address(wrappedEther)), ETH_CAP);
        assertEq(limiter.availableNow(address(wrappedPulse)), PLS_CAP);

        _withdraw(limiter, address(wrappedEther), ETH_CAP);
        _withdraw(limiter, address(wrappedPulse), PLS_CAP);
        _assertRefused(limiter, address(wrappedEther), 1, 0);
        _assertRefused(limiter, address(wrappedPulse), 1, 0);
    }

    /// Claim: a token with no fixed supply uses its `totalSupply()` at the time of the call, and a fixed supply wins over it.
    /// Shows: a token with a supply of 1,000,000 has a cap of 1,000; after a mint the cap follows the new supply; wrapped ETH,
    /// which has both, keeps its fixed cap. Matters: the limiter needs no setting for an ordinary token, and a supply that
    /// grows or shrinks moves the cap with it.
    function test_supplyShare_capFromTotalSupply() public {
        plainToken.mint(alice, 1_000_000e18);
        assertEq(limiter.capOf(address(plainToken)), 1_000e18);
        assertEq(limiter.availableNow(address(plainToken)), 1_000e18);
        plainToken.mint(alice, 1_000_000e18);
        assertEq(limiter.capOf(address(plainToken)), 2_000e18, "the cap follows the supply");
        assertEq(limiter.capOf(address(wrappedEther)), ETH_CAP, "a fixed supply wins");

        _withdraw(limiter, address(plainToken), 2_000e18);
        _assertRefused(limiter, address(plainToken), 1, 0);
    }

    /// Claim: a token with no fixed supply and a total supply of zero has a cap of zero, and its first withdrawal still
    /// passes from the full (empty) allowance. Shows: the cap is zero; a withdrawal of 5 passes; the next refuses with
    /// zero available. Matters: the rule for a withdrawal larger than the cap has no exception for a zero cap, and the
    /// limiter does not divide by the supply, so it cannot revert on it.
    function test_supplyShare_zeroTotalSupplyHasAZeroCapAndTheFirstWithdrawalPasses() public {
        assertEq(limiter.capOf(address(plainToken)), 0);
        _withdraw(limiter, address(plainToken), 5);
        _assertRefused(limiter, address(plainToken), 1, 0);
    }

    // ================================================================ refill

    /// Claim: the allowance refills in a straight line, and a long gap never takes it above the cap. Shows: after the
    /// whole cap is spent, half a window gives back exactly half the cap, so half the cap passes and one wei more
    /// refuses with the exact available amount; after 100 days the allowance is the cap and not more, so the cap passes
    /// and one wei more refuses. Matters: the refill is the rate of the limit, and a cap that could be exceeded by waiting
    /// would let a thief save up.
    function test_supplyShare_refillIsLinearAndNeverExceedsTheCap() public {
        address token = address(wrappedEther);
        _withdraw(limiter, token, ETH_CAP);
        vm.warp(block.timestamp + DAY / 2);
        assertEq(limiter.availableNow(token), ETH_CAP / 2, "half a window refills half the cap");
        _assertRefused(limiter, token, ETH_CAP / 2 + 1, ETH_CAP / 2);
        _withdraw(limiter, token, ETH_CAP / 2);
        assertEq(limiter.availableNow(token), 0);

        vm.warp(block.timestamp + 100 days);
        assertEq(limiter.availableNow(token), ETH_CAP, "a long gap fills the cap and no more");
        _withdraw(limiter, token, ETH_CAP);
        _assertRefused(limiter, token, 1, 0);
    }

    /// Claim: frequent calls do not starve a small cap of its refill. Shows: a token with a cap of 100 units refills 1 unit
    /// per 864 seconds. After the cap is spent, a call every 100 seconds (a zero withdrawal, which records) for 900 seconds
    /// leaves 1 unit available. Matters: if each call moved the update time forward, a refill below one unit would round
    /// down on every call and never arrive, and the token would be stuck.
    function test_supplyShare_refillBelowOneUnitIsNotLostToFrequentCalls() public {
        address token = makeAddr("a token with a small supply");
        SupplyShareFlowLimiter small = _newLimiter(unitVault, 0, _oneSupply(token, 100_000)); // cap: 100 units
        assertEq(small.capOf(token), 100);
        _withdraw(small, token, 100);
        for (uint256 i = 0; i < 9; i++) {
            vm.warp(block.timestamp + 100);
            _withdraw(small, token, 0);
        }
        assertEq(small.availableNow(token), 1, "one unit came back after 900 seconds");
        _withdraw(small, token, 1);
    }

    // ================================================================ oversize withdrawals

    /// Claim: a withdrawal larger than the cap passes from a full allowance and puts the allowance into debt, and the next
    /// withdrawal waits until the debt is refilled. Shows: with a cap of 100,000 ETH, a withdrawal of 250,000 ETH passes;
    /// nothing is available; after 1 day (debt of 50,000 ETH left) and after 1.5 days (zero) a withdrawal of 1 wei refuses;
    /// after 2 days exactly 50,000 ETH is available, it passes, and 1 wei more refuses. Matters: no valid withdrawal is
    /// stranded, and the average outflow stays at one cap per window.
    function test_supplyShare_oversizeWithdrawalPassesIntoDebtAndTheNextWaits() public {
        address token = address(wrappedEther);
        _withdraw(limiter, token, 250_000e18);
        assertEq(limiter.availableNow(token), 0);
        _assertRefused(limiter, token, 1, 0);

        vm.warp(block.timestamp + DAY);
        _assertRefused(limiter, token, 1, 0);
        vm.warp(block.timestamp + DAY / 2);
        assertEq(limiter.availableNow(token), 0, "the debt is paid and nothing is left");
        _assertRefused(limiter, token, 1, 0);

        vm.warp(block.timestamp + DAY / 2);
        assertEq(limiter.availableNow(token), 50_000e18);
        _withdraw(limiter, token, 50_000e18);
        _assertRefused(limiter, token, 1, 0);
    }

    /// Claim: a debt of several caps takes several windows to refill, and one call after a long gap does not forgive it.
    /// Shows: a withdrawal of 5 caps passes (debt of 4 caps); after 4 windows the allowance is zero; after 5 windows it is
    /// full. The refill is computed from the whole gap, not from one window. Matters: a limiter that capped the refill
    /// of one call at a single window would forgive part of every debt.
    function test_supplyShare_aDebtOfSeveralCapsNeedsSeveralWindows() public {
        address token = address(wrappedEther);
        _withdraw(limiter, token, 5 * ETH_CAP);
        vm.warp(block.timestamp + 4 * DAY);
        assertEq(limiter.availableNow(token), 0, "four windows pay a debt of four caps");
        _assertRefused(limiter, token, 1, 0);
        vm.warp(block.timestamp + DAY);
        assertEq(limiter.availableNow(token), ETH_CAP);
    }

    /// Claim: a withdrawal above the cap passes only from a FULL allowance. Shows: with half the cap spent, a withdrawal of
    /// two caps refuses with the exact available half cap, and the allowance is untouched; a withdrawal of exactly the cap
    /// when the allowance is full passes with no debt (the allowance is zero, and one window later it is full again).
    /// Matters: if any oversize withdrawal passed, a thief would send one withdrawal of any size after a small one.
    function test_supplyShare_oversizeNeedsAFullAllowance() public {
        address token = address(wrappedEther);
        _withdraw(limiter, token, ETH_CAP / 2);
        _assertRefused(limiter, token, 2 * ETH_CAP, ETH_CAP / 2);
        assertEq(limiter.availableNow(token), ETH_CAP / 2, "the refusal changed nothing");

        _withdraw(limiter, token, ETH_CAP / 2);
        vm.warp(block.timestamp + DAY);
        _withdraw(limiter, token, ETH_CAP); // exactly the cap, from a full allowance: no debt
        assertEq(limiter.availableNow(token), 0);
        vm.warp(block.timestamp + DAY);
        assertEq(limiter.availableNow(token), ETH_CAP, "no debt: full after one window");
    }

    // ================================================================ per token

    /// Claim: caps and allowances are per token. Shows: draining wrapped ETH leaves wrapped PLS and a plain token at their full
    /// allowances, and each refills on its own. Matters: a flood on one token must not block the others.
    function test_supplyShare_tokensDoNotShareAnAllowance() public {
        plainToken.mint(alice, 1_000_000e18);
        _withdraw(limiter, address(wrappedEther), ETH_CAP);
        assertEq(limiter.availableNow(address(wrappedEther)), 0);
        assertEq(limiter.availableNow(address(wrappedPulse)), PLS_CAP);
        assertEq(limiter.availableNow(address(plainToken)), 1_000e18);

        _withdraw(limiter, address(wrappedPulse), PLS_CAP / 2);
        vm.warp(block.timestamp + DAY / 4);
        assertEq(limiter.availableNow(address(wrappedEther)), ETH_CAP / 4);
        assertEq(limiter.availableNow(address(wrappedPulse)), 3 * PLS_CAP / 4, "half spent, a quarter refilled");
        assertEq(limiter.availableNow(address(plainToken)), 1_000e18, "untouched");
    }

    // ================================================================ overflow guards

    /// Claim: no amount and no supply can make the limiter overflow or revert with a panic. Shows: a withdrawal of the
    /// largest possible amount passes from a full allowance and the debt is clamped (the next call refuses); a token with
    /// the largest possible supply has the cap of the largest supply the limiter holds, and the refill after a gap up to the
    /// largest timestamp does not overflow (it refills the debt of the huge cap, and not the debt of the small cap). Matters: 100 trillion PLS of 18 decimals is about 1e32, far inside the range,
    /// but the numbers come from a token and a proof, so the extremes must be safe too.
    function test_supplyShare_extremeAmountsAndSupplies_neverOverflow() public {
        address token = address(wrappedEther);
        _withdraw(limiter, token, type(uint256).max);
        _assertRefused(limiter, token, type(uint256).max, 0);

        plainToken.mint(alice, type(uint256).max);
        uint256 expectedCap = limiter.MAXIMUM_SUPPLY() * 10 / 10_000;
        assertEq(limiter.capOf(address(plainToken)), expectedCap, "a supply above the maximum counts as the maximum");
        _withdraw(limiter, address(plainToken), type(uint256).max);
        vm.warp(type(uint64).max);
        assertEq(limiter.availableNow(address(plainToken)), expectedCap, "the huge cap refills the clamped debt in time");
        assertEq(limiter.availableNow(token), 0, "the small cap does not: the clamped debt is still a debt");
        _withdraw(limiter, address(wrappedPulse), PLS_CAP); // a fresh token at the far timestamp
        _withdraw(limiter, address(wrappedPulse), 0);
    }

    // ================================================================ constructor

    /// Claim: the constructor refuses values that would make a limiter that cannot work. Shows: a zero vault, a zero share,
    /// a share above 10,000 basis points, a zero window, a zero token, a zero supply, a duplicate token and a supply above
    /// the largest that the limiter holds each revert with their own error. Matters: every parameter is immutable, so a
    /// bad one cannot be fixed later.
    function test_supplyShare_constructorRefusesValuesThatCannotWork() public {
        SupplyShareFlowLimiter.FixedSupply[] memory none = new SupplyShareFlowLimiter.FixedSupply[](0);
        vm.expectRevert(abi.encodeWithSelector(SupplyShareFlowLimiter.ZeroValue.selector, "vault"));
        new SupplyShareFlowLimiter(address(0), 10, 1, 0, none);
        vm.expectRevert(abi.encodeWithSelector(SupplyShareFlowLimiter.ZeroValue.selector, "shareBasisPoints"));
        new SupplyShareFlowLimiter(unitVault, 0, 1, 0, none);
        vm.expectRevert(abi.encodeWithSelector(SupplyShareFlowLimiter.ShareAboveWhole.selector, uint16(10_001)));
        new SupplyShareFlowLimiter(unitVault, 10_001, 1, 0, none);
        vm.expectRevert(abi.encodeWithSelector(SupplyShareFlowLimiter.ZeroValue.selector, "windowSeconds"));
        new SupplyShareFlowLimiter(unitVault, 10, 0, 0, none);

        vm.expectRevert(abi.encodeWithSelector(SupplyShareFlowLimiter.ZeroValue.selector, "token"));
        new SupplyShareFlowLimiter(unitVault, 10, 1, 0, _oneSupply(address(0), 1));
        vm.expectRevert(abi.encodeWithSelector(SupplyShareFlowLimiter.ZeroValue.selector, "supply"));
        new SupplyShareFlowLimiter(unitVault, 10, 1, 0, _oneSupply(address(wrappedEther), 0));
        uint256 tooLarge = limiter.MAXIMUM_SUPPLY() + 1;
        vm.expectRevert(
            abi.encodeWithSelector(SupplyShareFlowLimiter.FixedSupplyTooLarge.selector, address(wrappedEther), tooLarge)
        );
        new SupplyShareFlowLimiter(unitVault, 10, 1, 0, _oneSupply(address(wrappedEther), tooLarge));

        SupplyShareFlowLimiter.FixedSupply[] memory twice = new SupplyShareFlowLimiter.FixedSupply[](2);
        twice[0] = SupplyShareFlowLimiter.FixedSupply(address(wrappedEther), 1);
        twice[1] = SupplyShareFlowLimiter.FixedSupply(address(wrappedEther), 2);
        vm.expectRevert(abi.encodeWithSelector(SupplyShareFlowLimiter.DuplicateFixedSupply.selector, address(wrappedEther)));
        new SupplyShareFlowLimiter(unitVault, 10, 1, 0, twice);

        assertEq(limiter.vault(), unitVault, "control: an honest limiter builds");
        assertEq(limiter.shareBasisPoints(), 10);
        assertEq(limiter.windowSeconds(), DAY);
        assertEq(limiter.sunsetTimestamp(), 0);
        assertEq(limiter.fixedSupplyOf(address(wrappedEther)), 100_000_000e18);
        assertEq(limiter.fixedSupplyOf(address(plainToken)), 0);
    }

    // ================================================================ sunset

    /// Claim: the sunset is refused before its time, works from its time, and works once. Shows: a limiter on a real vault
    /// with a sunset 30 days away refuses a call now and one second early with `SunsetNotReached` and both times; at the
    /// timestamp any caller detaches it, the vault emits the event and reads zero; a second call reverts in the vault.
    /// Matters: the sunset is the only way the limiter ends, and it must not be early or repeatable.
    function test_supplyShare_sunset_refusedBeforeWorksAfterAndWorksOnce() public {
        uint64 sunsetAt = uint64(block.timestamp + 30 days);
        SupplyShareFlowLimiter sunsetting = _newLimiter(ReceiptFixtures.DESTINATION_VAULT, sunsetAt, _twoSupplies());
        BridgeVault vault_ = _newWithdrawalVault(0, DEFAULT_CAPELLA_ERA, address(sunsetting));

        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(SupplyShareFlowLimiter.SunsetNotReached.selector, sunsetAt, block.timestamp));
        sunsetting.sunset();
        vm.warp(sunsetAt - 1);
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(SupplyShareFlowLimiter.SunsetNotReached.selector, sunsetAt, sunsetAt - 1));
        sunsetting.sunset();
        assertEq(address(vault_.flowLimiter()), address(sunsetting), "the early calls changed nothing");

        vm.warp(sunsetAt);
        vm.expectEmit(true, false, false, false, address(vault_));
        emit FlowLimiterDetached(address(sunsetting));
        vm.prank(alice);
        sunsetting.sunset();
        assertEq(address(vault_.flowLimiter()), address(0));

        vm.expectRevert(abi.encodeWithSelector(BridgeVault.NotFlowLimiter.selector, address(sunsetting)));
        sunsetting.sunset();
    }

    /// Claim: with a sunset of zero the limiter never ends. Shows: now and a hundred years later `sunset()` reverts with
    /// `SunsetNotReached` and a zero sunset, and the vault keeps its limiter. Matters: zero means never, not "already past".
    function test_supplyShare_sunset_zeroNeverWorks() public {
        SupplyShareFlowLimiter forever = _newLimiter(ReceiptFixtures.DESTINATION_VAULT, 0, _twoSupplies());
        BridgeVault vault_ = _newWithdrawalVault(0, DEFAULT_CAPELLA_ERA, address(forever));
        vm.expectRevert(abi.encodeWithSelector(SupplyShareFlowLimiter.SunsetNotReached.selector, 0, block.timestamp));
        forever.sunset();
        vm.warp(block.timestamp + 36_500 days);
        vm.expectRevert(abi.encodeWithSelector(SupplyShareFlowLimiter.SunsetNotReached.selector, 0, block.timestamp));
        forever.sunset();
        assertEq(address(vault_.flowLimiter()), address(forever));
    }

    // ================================================================ end to end through the vault

    /// Claim: through a real vault, a withdrawal over the allowance reverts with `FlowRefused`, stays claimable, and pays
    /// after the refill. Shows: with a cap of 4 tokens, a receipt of 3 pays; a receipt of 2 reverts with the token, the
    /// amount and 1 available, its nonce is unclaimed and the recipient has only the first payout; after half a window the
    /// same proof pays and marks the nonce. Matters: a rate limit works as wait and retry with no queue in the vault.
    function test_supplyShare_endToEnd_refusedWithdrawalStaysClaimableAndPaysAfterTheRefill() public {
        SupplyShareFlowLimiter attached =
            _newLimiter(ReceiptFixtures.DESTINATION_VAULT, 0, _oneSupply(address(tokenOnB), 4_000e18));
        BridgeVault vault_ = _newWithdrawalVault(0, DEFAULT_CAPELLA_ERA, address(attached));
        tokenOnB.mint(address(vault_), 1_000e18);
        assertEq(attached.capOf(address(tokenOnB)), 4e18);

        ReceiptFixtures.Named memory first = ReceiptFixtures.type2(); // 3 tokens
        ReceiptFixtures.Named memory second = ReceiptFixtures.access_list(); // 2 tokens
        Scene memory firstScene = _scene(first, _defaultParams());
        Scene memory secondScene = _scene(second, _defaultParams());
        assertEq(first.amount, 3e18);
        assertEq(second.amount, 2e18);

        vault_.withdraw(firstScene.proof);
        assertEq(tokenOnB.balanceOf(ReceiptFixtures.RECIPIENT), 3e18);
        assertEq(attached.availableNow(address(tokenOnB)), 1e18);

        vm.expectRevert(
            abi.encodeWithSelector(SupplyShareFlowLimiter.FlowRefused.selector, address(tokenOnB), 2e18, 1e18)
        );
        vault_.withdraw(secondScene.proof);
        assertFalse(vault_.claimed(second.nonce), "the refused nonce stays unclaimed");
        assertEq(tokenOnB.balanceOf(ReceiptFixtures.RECIPIENT), 3e18, "nothing was paid");

        vm.warp(block.timestamp + DAY / 2); // refills 2 tokens
        vault_.withdraw(secondScene.proof);
        assertTrue(vault_.claimed(second.nonce));
        assertEq(tokenOnB.balanceOf(ReceiptFixtures.RECIPIENT), 5e18);
        assertEq(attached.availableNow(address(tokenOnB)), 1e18);
    }

    // ================================================================ long run and fuzz

    /// Claim: over a long run the average outflow is one cap per window. Shows: for 30 days, a withdrawal of half a cap is
    /// tried every hour, and the total paid is at least 30 caps and at most 31 (the first full allowance plus 30 windows of
    /// refill). Matters: the limit is a rate, so it must neither stall nor leak.
    function test_supplyShare_longRunAverageIsOneCapPerWindow() public {
        address token = address(wrappedEther);
        uint256 paid;
        for (uint256 hour = 0; hour < 30 * 24; hour++) {
            vm.prank(unitVault);
            try limiter.checkWithdrawal(token, bob, ETH_CAP / 2, bytes32(0)) {
                paid += ETH_CAP / 2;
            } catch {}
            vm.warp(block.timestamp + 1 hours);
        }
        assertGe(paid, 30 * ETH_CAP);
        assertLe(paid, 31 * ETH_CAP);
    }

    /// Claim: over any sequence of withdrawals and time steps, the total paid in any span of one window is at most two caps
    /// plus the excess of the one oversize withdrawal in that span. Shows: 40 random steps (amounts up to three caps, gaps up
    /// to eight hours) against wrapped ETH; for the span that starts at each paid withdrawal, the sum of the paid
    /// withdrawals inside the span stays within the bound. Matters: this is the worst case that the specification states
    /// for a thief who finds the allowance full: a full allowance plus one window of refill, plus one oversize excess.
    function testFuzz_supplyShare_anyWindowPaysAtMostTwoCapsPlusOneExcess(uint256 seed) public {
        address token = address(wrappedEther);
        uint256 steps = 40;
        uint256[] memory times = new uint256[](steps);
        uint256[] memory amounts = new uint256[](steps);
        uint256 passed;
        for (uint256 i = 0; i < steps; i++) {
            uint256 draw = uint256(keccak256(abi.encode(seed, i)));
            uint256 amount = draw % (3 * ETH_CAP + 1);
            vm.warp(block.timestamp + (draw >> 128) % (8 hours + 1));
            vm.prank(unitVault);
            try limiter.checkWithdrawal(token, bob, amount, bytes32(0)) {
                times[passed] = block.timestamp;
                amounts[passed] = amount;
                passed++;
            } catch {}
        }
        for (uint256 start = 0; start < passed; start++) {
            uint256 total;
            uint256 largestExcess;
            for (uint256 j = start; j < passed && times[j] <= times[start] + DAY; j++) {
                total += amounts[j];
                if (amounts[j] > ETH_CAP && amounts[j] - ETH_CAP > largestExcess) largestExcess = amounts[j] - ETH_CAP;
            }
            assertLe(total, 2 * ETH_CAP + largestExcess, "a span paid more than two caps plus one excess");
        }
    }

    // ================================================================ gas

    /// Claim: the check is cheap. Shows: the gas of `checkWithdrawal` as the vault calls it, with the limiter cold each time
    /// (as in a new transaction): the first call for a token, which writes the state slot from zero, and a later call, which
    /// rewrites it; and the same first call for a token that uses `totalSupply()`. Matters: a user pays it on every
    /// withdrawal. The numbers are in the log.
    function test_gas_checkWithdrawal() public {
        address token = address(wrappedEther);
        vm.cool(address(limiter));
        vm.prank(unitVault);
        uint256 before = gasleft();
        limiter.checkWithdrawal(token, bob, 1e18, bytes32(0));
        console2.log("checkWithdrawal gas, first call for a token, fixed supply, cold", before - gasleft());

        vm.warp(block.timestamp + 1 hours);
        vm.cool(address(limiter));
        vm.prank(unitVault);
        before = gasleft();
        limiter.checkWithdrawal(token, bob, 1e18, bytes32(0));
        console2.log("checkWithdrawal gas, later call, fixed supply, cold", before - gasleft());

        vm.prank(unitVault);
        before = gasleft();
        limiter.checkWithdrawal(token, bob, 1e18, bytes32(0));
        console2.log("checkWithdrawal gas, later call, fixed supply, warm", before - gasleft());

        plainToken.mint(alice, 1_000_000e18);
        vm.cool(address(limiter));
        vm.cool(address(plainToken));
        vm.prank(unitVault);
        before = gasleft();
        limiter.checkWithdrawal(address(plainToken), bob, 1e18, bytes32(0));
        console2.log("checkWithdrawal gas, first call for a token, totalSupply(), cold", before - gasleft());
    }

    /// Claim: the vault withdrawal with this limiter attached costs a bounded amount more than without. Shows: the gas of
    /// a type 2 receipt withdrawal (3 tokens) on a vault built the same way, once with no limiter and once with the limiter
    /// attached (each in its own test, so that neither warms the other). Matters: both figures are in the log, and the
    /// difference is the cost of the hook plus the check.
    function test_gas_withdrawWithTheLimiterAttached() public {
        SupplyShareFlowLimiter attached =
            _newLimiter(ReceiptFixtures.DESTINATION_VAULT, 0, _oneSupply(address(tokenOnB), 4_000e18));
        uint256 used = _withdrawalGas(address(attached));
        console2.log("withdraw gas (type 2 receipt), supply-share limiter attached", used);
        assertLt(used, 450_000);
    }

    /// Claim: the same withdrawal with no limiter, as the baseline of the test above. Shows: the gas. Matters: see above.
    function test_gas_withdrawWithNoLimiterSameSetup() public {
        uint256 used = _withdrawalGas(address(0));
        console2.log("withdraw gas (type 2 receipt), no limiter, same setup", used);
        assertLt(used, 450_000);
    }

    function _withdrawalGas(address flowLimiter) internal returns (uint256) {
        BridgeVault vault_ = _newWithdrawalVault(0, DEFAULT_CAPELLA_ERA, flowLimiter);
        tokenOnB.mint(address(vault_), 1_000e18);
        Scene memory scene = _scene(ReceiptFixtures.type2(), _defaultParams());
        uint256 before = gasleft();
        vault_.withdraw(scene.proof);
        return before - gasleft();
    }
}
