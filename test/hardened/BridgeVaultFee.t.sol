// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Vm} from "forge-std/Vm.sol";
import {console2} from "forge-std/console2.sol";
import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {BridgeVault} from "../../src/hardened/BridgeVault.sol";
import {FeeOnTransferToken} from "../../src/mocks/FeeOnTransferToken.sol";
import {HardenedFixture, IMintableToken} from "./utils/HardenedFixture.sol";

/// @notice A token that refuses every transfer to one address, as a token with a deny list does.
contract RefusingToken is ERC20 {
    error TransferRefused(address to);

    address public refused;

    constructor() ERC20("Refusing", "REF") {}

    function mint(address to, uint256 amount) external {
        _mint(to, amount);
    }

    function refuse(address account) external {
        refused = account;
    }

    function _update(address from, address to, uint256 value) internal override {
        if (to == refused) revert TransferRefused(to);
        super._update(from, to, value);
    }
}

/// @notice A token that reads the accrued fees of the vault while the vault sends tokens out.
contract ProbeToken is ERC20 {
    BridgeVault public vault;
    bool public probed;
    uint256 public accruedWhileSending;

    constructor() ERC20("Probe", "PRB") {}

    function mint(address to, uint256 amount) external {
        _mint(to, amount);
    }

    function watch(BridgeVault vault_) external {
        vault = vault_;
    }

    function _update(address from, address to, uint256 value) internal override {
        super._update(from, to, value);
        if (address(vault) == address(0) || from != address(vault)) return;
        probed = true;
        accruedWhileSending = vault.accruedFees(address(this));
    }
}

/// @notice Tests of the deposit fee switch: the one role of the hardened build, its ceiling, its removal, and the
/// pull-based collection of the fees.
contract BridgeVaultFeeTest is HardenedFixture {
    event FeeChanged(uint16 feeBasisPoints, address feeRecipient);
    event FeeNullified();
    event FeeCharged(address indexed token, uint256 fee);
    event FeesCollected(address indexed token, address indexed feeRecipient, uint256 amount);

    address internal authority = makeAddr("fee authority");
    address internal feeRecipient = makeAddr("fee recipient");
    /// @dev A vault with a live fee, built in `setUp` so that the gas tests see cold storage, as a user does.
    BridgeVault internal liveFeeVault;

    function setUp() public override {
        super.setUp();
        liveFeeVault = _vaultWith(address(tokenOnA), authority, feeRecipient, 25, 50);
    }

    // ---------------------------------------------------------------- helpers

    /// @dev A vault on chain A for one token pair and the given fee switch.
    function _vaultWith(address localToken, address authority_, address recipient_, uint16 basisPoints, uint16 ceiling)
        internal
        returns (BridgeVault)
    {
        BridgeVault.TokenPair[] memory pairs = new BridgeVault.TokenPair[](1);
        pairs[0] = BridgeVault.TokenPair(localToken, address(tokenOnB), 18);
        vm.chainId(CHAIN_A);
        return new BridgeVault(
            address(lightClientForA),
            CHAIN_A,
            CHAIN_B,
            address(vaultB),
            pairs,
            BridgeVault.DepositTerms(0, authority_, recipient_, basisPoints, ceiling),
            DEFAULT_CAPELLA_ERA,
            address(gateA)
        );
    }

    /// @dev A new vault for `tokenOnA` with a live fee switch: the authority, the recipient, a fee of 25 and a ceiling of 50.
    function _liveVault() internal returns (BridgeVault) {
        return _vaultWith(address(tokenOnA), authority, feeRecipient, 25, 50);
    }

    /// @dev Mints and approves for `user`, deposits with the fee limit, and returns the amount of the deposit event.
    /// The helper also returns how many `FeeCharged` events the deposit emitted.
    function _depositWithLimit(BridgeVault vault, address token, address user, uint256 amount, uint16 maxFeeBasisPoints)
        internal
        returns (uint256 eventAmount, uint256 feeEvents)
    {
        IMintableToken(token).mint(user, amount);
        vm.startPrank(user);
        IMintableToken(token).approve(address(vault), amount);
        vm.recordLogs();
        vault.deposit(token, bob, amount, maxFeeBasisPoints, "");
        vm.stopPrank();
        Vm.Log[] memory logs = vm.getRecordedLogs();
        for (uint256 i = 0; i < logs.length; i++) {
            if (logs[i].emitter != address(vault)) continue;
            if (logs[i].topics[0] == vault.DEPOSIT_EVENT_TOPIC()) {
                (eventAmount,,,,) = abi.decode(logs[i].data, (uint256, bytes32, uint64, address, address));
            }
            if (logs[i].topics[0] == FeeCharged.selector) feeEvents++;
        }
    }

    // ================================================================ nullified at the start

    /// Claim: a vault built with no fee authority charges no fee, and nobody can ever set one. Shows: a deposit keeps
    /// its whole amount and emits no `FeeCharged`; `setFee` and `nullifyFee` revert for an ordinary caller, for the
    /// recipient and for the zero address; the constructor refuses a fee or a ceiling next to a zero authority.
    /// Matters: the user decision that a vault can launch with the fee removed for good.
    function test_fee_nullifiedAtTheStart_chargesNothingAndRefusesEveryone() public {
        BridgeVault vault = _vaultWith(address(tokenOnA), address(0), address(0), 0, 0);
        assertEq(vault.feeAuthority(), address(0));
        assertEq(vault.feeCeilingBasisPoints(), 0);

        (uint256 eventAmount, uint256 feeEvents) = _depositWithLimit(vault, address(tokenOnA), alice, 1000e18, 0);
        assertEq(eventAmount, 1000e18, "the whole amount is bridged");
        assertEq(feeEvents, 0);
        assertEq(vault.accruedFees(address(tokenOnA)), 0);

        address[3] memory callers = [alice, feeRecipient, address(0)];
        for (uint256 i = 0; i < callers.length; i++) {
            vm.startPrank(callers[i]);
            vm.expectRevert(abi.encodeWithSelector(BridgeVault.NotFeeAuthority.selector, callers[i]));
            vault.setFee(1, bob);
            vm.expectRevert(abi.encodeWithSelector(BridgeVault.NotFeeAuthority.selector, callers[i]));
            vault.nullifyFee();
            vm.stopPrank();
        }
        assertEq(vault.feeBasisPoints(), 0);

        vm.expectRevert(abi.encodeWithSelector(BridgeVault.NullifiedFeeMustBeZero.selector, uint16(1), uint16(0)));
        _vaultWith(address(tokenOnA), address(0), feeRecipient, 1, 0);
        vm.expectRevert(abi.encodeWithSelector(BridgeVault.NullifiedFeeMustBeZero.selector, uint16(0), uint16(1)));
        _vaultWith(address(tokenOnA), address(0), feeRecipient, 0, 1);
    }

    // ================================================================ ceiling

    /// Claim: the ceiling is at most 1% and the fee never passes the ceiling. Shows: a ceiling of 101 reverts and 100
    /// deploys; a constructor fee above the ceiling reverts; `setFee` above the ceiling reverts and at the ceiling
    /// works; a non-zero fee needs a recipient, in the constructor and in `setFee`; the ceiling does not move.
    /// Matters: users read the worst case before they deposit, for the whole life of the vault.
    function test_fee_ceiling_boundsEveryFee() public {
        assertEq(_liveVault().MAX_FEE_CEILING_BASIS_POINTS(), 100);

        vm.expectRevert(abi.encodeWithSelector(BridgeVault.FeeCeilingTooHigh.selector, uint16(101), uint16(100)));
        _vaultWith(address(tokenOnA), authority, feeRecipient, 0, 101);
        vm.expectRevert(abi.encodeWithSelector(BridgeVault.FeeCeilingTooHigh.selector, type(uint16).max, uint16(100)));
        _vaultWith(address(tokenOnA), authority, feeRecipient, 0, type(uint16).max);
        BridgeVault atMaximum = _vaultWith(address(tokenOnA), authority, feeRecipient, 100, 100); // control
        assertEq(atMaximum.feeCeilingBasisPoints(), 100);
        assertEq(atMaximum.feeBasisPoints(), 100);

        vm.expectRevert(abi.encodeWithSelector(BridgeVault.FeeAboveCeiling.selector, uint16(51), uint16(50)));
        _vaultWith(address(tokenOnA), authority, feeRecipient, 51, 50);
        vm.expectRevert(BridgeVault.ZeroFeeRecipient.selector);
        _vaultWith(address(tokenOnA), authority, address(0), 25, 50);

        BridgeVault vault = _liveVault();
        vm.startPrank(authority);
        vm.expectRevert(abi.encodeWithSelector(BridgeVault.FeeAboveCeiling.selector, uint16(51), uint16(50)));
        vault.setFee(51, feeRecipient);
        vm.expectRevert(abi.encodeWithSelector(BridgeVault.ZeroFeeRecipient.selector));
        vault.setFee(10, address(0));

        vm.expectEmit(address(vault));
        emit FeeChanged(50, bob);
        vault.setFee(50, bob); // control: the ceiling itself
        vm.stopPrank();
        assertEq(vault.feeBasisPoints(), 50);
        assertEq(vault.feeRecipient(), bob);
        assertEq(vault.feeCeilingBasisPoints(), 50, "the ceiling did not move");
    }

    /// Claim: only the fee authority sets the fee. Shows: any other caller, the recipient included, reverts; the
    /// authority works. Matters: the one role of the build.
    function test_fee_setFee_isOnlyForTheAuthority() public {
        BridgeVault vault = _liveVault();
        vm.prank(feeRecipient);
        vm.expectRevert(abi.encodeWithSelector(BridgeVault.NotFeeAuthority.selector, feeRecipient));
        vault.setFee(10, feeRecipient);
        vm.prank(authority);
        vault.setFee(10, feeRecipient);
        assertEq(vault.feeBasisPoints(), 10);
    }

    // ================================================================ nullify

    /// Claim: `nullifyFee` is one-way. Shows: after it the fee and the authority are zero, the recipient stays,
    /// `setFee` and `nullifyFee` revert even for the old authority, new deposits charge nothing, and fees charged
    /// before can still be collected by anyone. Matters: the user decision that the fee can be removed for good.
    function test_fee_nullify_isOneWayAndKeepsCollectionOpen() public {
        BridgeVault vault = _liveVault();
        _depositWithLimit(vault, address(tokenOnA), alice, 1000e18, 25);
        uint256 accrued = vault.accruedFees(address(tokenOnA));
        assertEq(accrued, 2.5e18, "control: 25 basis points of 1000");

        vm.expectEmit(address(vault));
        emit FeeNullified();
        vm.prank(authority);
        vault.nullifyFee();
        assertEq(vault.feeBasisPoints(), 0);
        assertEq(vault.feeAuthority(), address(0));
        assertEq(vault.feeRecipient(), feeRecipient, "the recipient stays");
        assertEq(vault.feeCeilingBasisPoints(), 50, "the ceiling is immutable");

        vm.startPrank(authority);
        vm.expectRevert(abi.encodeWithSelector(BridgeVault.NotFeeAuthority.selector, authority));
        vault.setFee(10, feeRecipient);
        vm.expectRevert(abi.encodeWithSelector(BridgeVault.NotFeeAuthority.selector, authority));
        vault.nullifyFee();
        vm.stopPrank();

        (uint256 eventAmount, uint256 feeEvents) = _depositWithLimit(vault, address(tokenOnA), alice, 1000e18, 0);
        assertEq(eventAmount, 1000e18, "no fee after the nullification");
        assertEq(feeEvents, 0);

        vm.prank(bob); // anyone may collect
        vault.collectFees(address(tokenOnA));
        assertEq(tokenOnA.balanceOf(feeRecipient), accrued, "the fees charged before are collected");
        assertEq(vault.accruedFees(address(tokenOnA)), 0);
    }

    // ================================================================ fee raised ahead of a deposit

    /// Claim: a fee raise that lands just before a deposit cannot charge more than the sender agreed to. Shows: the
    /// sender signs for a limit of 25. The authority raises the fee to 50. The deposit reverts with `FeeAboveLimit`
    /// and the tokens stay with the sender. Without the raise, the same deposit succeeds. A limit of 50 accepts the
    /// raised fee. Matters: this limit takes the place of a timelock, which the user rejected.
    function test_fee_raiseAheadOfDeposit_revertsAndTokensStayWithSender() public {
        BridgeVault vault = _liveVault();
        tokenOnA.mint(alice, 100e18);
        vm.prank(alice);
        tokenOnA.approve(address(vault), 100e18);

        // Control: no raise, the deposit with a limit of 25 succeeds. A second vault state is not needed: alice deposits
        // 10 and keeps 90 for the attack.
        vm.prank(alice);
        vault.deposit(address(tokenOnA), bob, 10e18, 25, "");
        assertEq(tokenOnA.balanceOf(alice), 90e18);

        vm.prank(authority);
        vault.setFee(50, feeRecipient);

        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(BridgeVault.FeeAboveLimit.selector, uint16(50), uint16(25)));
        vault.deposit(address(tokenOnA), bob, 90e18, 25, "");
        assertEq(tokenOnA.balanceOf(alice), 90e18, "the tokens stay with the sender");
        assertEq(tokenOnA.balanceOf(address(vault)), 10e18);

        vm.prank(alice);
        vault.deposit(address(tokenOnA), bob, 90e18, 50, ""); // control: the raised fee is accepted at its own limit
        assertEq(vault.accruedFees(address(tokenOnA)), 0.025e18 + 0.45e18);
    }

    // ================================================================ collection

    /// Claim: a recipient that the token refuses blocks only `collectFees`. Shows: deposits keep working and keep
    /// accruing; `collectFees` reverts and leaves the accrued amount untouched; once the authority names another
    /// recipient, the same amount is collected. Matters: a deposit never transfers to the recipient.
    function test_fee_collect_recipientRefusedByTheTokenBlocksOnlyCollection() public {
        RefusingToken token = new RefusingToken();
        BridgeVault vault = _vaultWith(address(token), authority, feeRecipient, 100, 100);
        token.refuse(feeRecipient);

        _depositWithLimit(vault, address(token), alice, 1000e18, 100);
        _depositWithLimit(vault, address(token), alice, 1000e18, 100); // deposits are not blocked
        assertEq(vault.accruedFees(address(token)), 20e18);

        vm.expectRevert(abi.encodeWithSelector(RefusingToken.TransferRefused.selector, feeRecipient));
        vault.collectFees(address(token));
        assertEq(vault.accruedFees(address(token)), 20e18, "the revert keeps the accrued amount");
        assertEq(token.balanceOf(address(vault)), 2000e18);

        vm.prank(authority);
        vault.setFee(100, bob);
        vault.collectFees(address(token)); // control: another recipient is paid
        assertEq(token.balanceOf(bob), 20e18);
        assertEq(vault.accruedFees(address(token)), 0);
    }

    /// Claim: `collectFees` zeroes the accrued amount before it transfers, and it pays exactly once. Shows: a token
    /// that reads the accrued amount during the transfer sees zero; a second call reverts with `NoFeesAccrued`; the
    /// event names the recipient and the amount. Matters: no reentrant path can collect the same fees twice.
    function test_fee_collect_zeroesBeforeItTransfers() public {
        ProbeToken token = new ProbeToken();
        BridgeVault vault = _vaultWith(address(token), authority, feeRecipient, 100, 100);
        token.watch(vault);
        _depositWithLimit(vault, address(token), alice, 1000e18, 100);
        assertEq(vault.accruedFees(address(token)), 10e18);
        assertFalse(token.probed(), "control: the deposit sent nothing out of the vault");

        vm.expectEmit(address(vault));
        emit FeesCollected(address(token), feeRecipient, 10e18);
        vault.collectFees(address(token));
        assertTrue(token.probed(), "the probe ran during the transfer");
        assertEq(token.accruedWhileSending(), 0, "the amount was zero before the transfer");
        assertEq(token.balanceOf(feeRecipient), 10e18);

        vm.expectRevert(abi.encodeWithSelector(BridgeVault.NoFeesAccrued.selector, address(token)));
        vault.collectFees(address(token));
    }

    // ================================================================ accounting

    /// Claim: the fee is computed on the measured received amount and rounds down. Shows: 199 received at 100 basis
    /// points is a fee of 1 and a net of 198; 99 received is a fee of 0, with no `FeeCharged` event; the event amount is
    /// the net amount. Matters: rounding favours the sender, and the vault never books a fee it did not receive.
    function test_fee_roundsDownOnTheReceivedAmount() public {
        BridgeVault vault = _vaultWith(address(tokenOnA), authority, feeRecipient, 100, 100);
        (uint256 net, uint256 feeEvents) = _depositWithLimit(vault, address(tokenOnA), alice, 199, 100);
        assertEq(net, 198);
        assertEq(feeEvents, 1);
        assertEq(vault.accruedFees(address(tokenOnA)), 1);

        (net, feeEvents) = _depositWithLimit(vault, address(tokenOnA), alice, 99, 100);
        assertEq(net, 99, "a fee under one unit rounds to zero");
        assertEq(feeEvents, 0);
        assertEq(vault.accruedFees(address(tokenOnA)), 1);

        (net,) = _depositWithLimit(vault, address(tokenOnA), alice, 1, 100);
        assertEq(net, 1, "one unit is never taken whole");
    }

    /// Claim: a fee-on-transfer token is charged on what the vault received. Shows: 1000 requested, 990 received, a fee
    /// of 9.9 (not 10), a net of 980.1 in the event, and a vault balance that equals the net amount plus the accrued
    /// fee. After collection the balance equals the net amount, which is what the destination pays. Matters: the
    /// vault stays solvent for every withdrawal while it holds the fees.
    function test_fee_feeOnTransferToken_isChargedOnTheMeasuredAmount() public {
        FeeOnTransferToken token = new FeeOnTransferToken("Fee", "FEE");
        BridgeVault vault = _vaultWith(address(token), authority, feeRecipient, 100, 100);

        (uint256 net, uint256 feeEvents) = _depositWithLimit(vault, address(token), alice, 1000e18, 100);
        assertEq(feeEvents, 1);
        assertEq(vault.accruedFees(address(token)), 9.9e18, "the fee is on the 990 received");
        assertEq(net, 980.1e18, "the event carries the received amount less the fee");
        assertEq(token.balanceOf(address(vault)), net + vault.accruedFees(address(token)), "the balance covers both");

        vault.collectFees(address(token));
        assertEq(token.balanceOf(address(vault)), net, "after collection the vault holds what it owes");
    }

    // ================================================================ gas

    /// Claim: a deposit costs more with a fee only by the accrual and the event. Shows: the gas of the first deposit on
    /// a vault from `setUp` (cold storage) with no fee authority, printed for the report. The vault of the fixture is
    /// built the same way as the vault of the baseline measurement taken before the fee switch existed. Matters: the
    /// user asked for the cost of the switch.
    function test_gas_deposit_feeZero() public {
        vm.chainId(CHAIN_A);
        uint256 used = _gasOfDeposit(vaultA);
        console2.log("deposit gas, fee zero", used);
        assertLt(used, 120_000);
    }

    /// Claim: see `test_gas_deposit_feeZero`. Shows: the gas of the first deposit with a fee of 25 basis points, which
    /// adds one new storage slot and one event.
    function test_gas_deposit_feeSet() public {
        vm.chainId(CHAIN_A);
        uint256 used = _gasOfDeposit(liveFeeVault);
        console2.log("deposit gas, fee set", used);
        assertLt(used, 150_000);
    }

    function _gasOfDeposit(BridgeVault vault) internal returns (uint256) {
        tokenOnA.mint(alice, 100e18);
        vm.startPrank(alice);
        tokenOnA.approve(address(vault), 100e18);
        uint256 before = gasleft();
        vault.deposit(address(tokenOnA), bob, 100e18, 25, "");
        uint256 used = before - gasleft();
        vm.stopPrank();
        return used;
    }
}
