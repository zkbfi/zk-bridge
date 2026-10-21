// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {StdInvariant} from "forge-std/StdInvariant.sol";
import {Test} from "forge-std/Test.sol";
import {BridgeVault} from "../../src/hardened/BridgeVault.sol";
import {MockERC20} from "../../src/mocks/MockERC20.sol";
import {WithdrawalScenes} from "./utils/WithdrawalScenes.sol";
import {ReceiptFixtures} from "./utils/ReceiptFixtures.sol";

/// @title SolvencyHandler
/// @notice Drives the paying vault through funding, claim registration, claims, replays, and tampered proofs.
/// @dev What this handler claims, and what it does not.
/// It claims: it registers a claim of `amount` only when the vault holds at least `owed + amount`, all of it funded by
/// real deposits into the vault. So every registered claim is backed by tokens in the vault.
/// It does NOT claim: that a deposit on the other chain backs the claim. The evidence is synthetic (a script-built
/// receipts trie with a made-up beacon tree), and the handler picks which fixtures to submit. The invariants show
/// that the vault pays exactly the logged amounts, only once, and never pays a tampered proof.
contract SolvencyHandler is Test {
    BridgeVault public immutable vault;
    MockERC20 public immutable localToken;

    bytes[] internal _encodedProofs;
    uint256[] internal _amounts;
    bytes32[] internal _nonces;
    bool[] internal _registered;
    bool[] internal _paid;

    uint256 public fundedLiquidity;
    uint256 public totalPaid;
    uint256 public owed;
    uint256 public tamperAttempts;
    uint256 public tamperSuccesses;
    uint256 public replayAttempts;
    uint256 public replaySuccesses;
    uint256 public claimsPaid;

    constructor(BridgeVault vault_, MockERC20 localToken_) {
        vault = vault_;
        localToken = localToken_;
    }

    /// @notice Adds a claim that the handler may register and pay later.
    function addClaim(BridgeVault.WithdrawalProof memory proof, uint256 amount, bytes32 nonce) external {
        _encodedProofs.push(abi.encode(proof));
        _amounts.push(amount);
        _nonces.push(nonce);
        _registered.push(false);
        _paid.push(false);
    }

    function claimCount() external view returns (uint256) {
        return _nonces.length;
    }

    function nonceAt(uint256 index) external view returns (bytes32) {
        return _nonces[index];
    }

    function paidAt(uint256 index) external view returns (bool) {
        return _paid[index];
    }

    /// @notice Someone deposits into the vault. The tokens are real, and the handler counts them as liquidity.
    function fundLiquidity(uint96 rawAmount, uint8 userSeed) external {
        uint256 amount = bound(rawAmount, 1, 40e18);
        address user = address(uint160(bound(userSeed, 1, 5) + 0x1000));
        localToken.mint(user, amount);
        vm.startPrank(user);
        localToken.approve(address(vault), amount);
        vault.deposit(address(localToken), user, amount);
        vm.stopPrank();
        fundedLiquidity += amount;
    }

    /// @notice Registers a claim as owed, but only if funded liquidity still covers it.
    function registerClaim(uint256 index) external {
        index = index % _nonces.length;
        if (_registered[index]) return;
        if (fundedLiquidity - totalPaid - owed < _amounts[index]) return;
        _registered[index] = true;
        owed += _amounts[index];
    }

    /// @notice Pays a registered claim.
    function claim(uint256 index) external {
        index = index % _nonces.length;
        if (!_registered[index] || _paid[index]) return;
        vault.withdraw(abi.decode(_encodedProofs[index], (BridgeVault.WithdrawalProof)));
        _paid[index] = true;
        owed -= _amounts[index];
        totalPaid += _amounts[index];
        claimsPaid++;
    }

    /// @notice Submits a paid claim again. The vault must refuse.
    function replayPaidClaim(uint256 index) external {
        index = index % _nonces.length;
        if (!_paid[index]) return;
        replayAttempts++;
        try vault.withdraw(abi.decode(_encodedProofs[index], (BridgeVault.WithdrawalProof))) {
            replaySuccesses++;
        } catch {}
    }

    /// @notice Flips one bit in the anchor state root or a branch of an unpaid claim and submits it. It must revert.
    function submitTampered(uint256 index, uint8 part, uint8 bit) external {
        index = index % _nonces.length;
        BridgeVault.WithdrawalProof memory proof = abi.decode(_encodedProofs[index], (BridgeVault.WithdrawalProof));
        uint256 flip = uint256(1) << bit;
        if (part % 3 == 0) proof.anchorHeader.stateRoot ^= bytes32(flip);
        if (part % 3 == 1) proof.blockHashBranch[0] ^= bytes32(flip);
        if (part % 3 == 2) proof.depositHeader.bodyRoot ^= bytes32(flip);
        tamperAttempts++;
        try vault.withdraw(proof) {
            tamperSuccesses++;
        } catch {}
    }
}

/// @notice Invariants of the paying vault. See `SolvencyHandler` for what the handler claims.
/// forge-config: default.invariant.runs = 64
/// forge-config: default.invariant.depth = 100
contract BridgeVaultInvariantTest is StdInvariant, WithdrawalScenes {
    SolvencyHandler internal handler;
    BridgeVault internal vault;

    function setUp() public override {
        super.setUp();
        vault = _newWithdrawalVault();
        handler = new SolvencyHandler(vault, tokenOnB);
        SceneParams memory params = _defaultParams();
        ReceiptFixtures.Named[8] memory all = [
            ReceiptFixtures.legacy(),
            ReceiptFixtures.access_list(),
            ReceiptFixtures.type2(),
            ReceiptFixtures.two_a(),
            ReceiptFixtures.two_b(),
            ReceiptFixtures.high_index(),
            ReceiptFixtures.type3(),
            ReceiptFixtures.type4()
        ];
        for (uint256 i = 0; i < all.length; i++) {
            // All claims share one anchor and one set of blocks. The anchor is stored once.
            Scene memory scene = i == 0
                ? _scene(all[i], params)
                : _buildScene(all[i], params, _executionHeaderRlp(ReceiptFixtures.RECEIPTS_ROOT, 17));
            handler.addClaim(scene.proof, all[i].amount, all[i].nonce);
        }
        targetContract(address(handler));
        bytes4[] memory selectors = new bytes4[](5);
        selectors[0] = SolvencyHandler.fundLiquidity.selector;
        selectors[1] = SolvencyHandler.registerClaim.selector;
        selectors[2] = SolvencyHandler.claim.selector;
        selectors[3] = SolvencyHandler.replayPaidClaim.selector;
        selectors[4] = SolvencyHandler.submitTampered.selector;
        targetSelector(FuzzSelector({addr: address(handler), selectors: selectors}));
    }

    /// Claim: the vault's balance never drops below what registered, unpaid claims are owed.
    /// Shows: after every call sequence, balance >= owed. Matters: H-13 and H-09 (a claim that the handler registered
    /// is always payable, so the vault is solvent for everything it promised).
    /// Honest limit: the handler funds claims itself. This says nothing about source-chain deposits.
    function invariant_H13_balanceCoversOwedClaims() public view {
        assertGe(tokenOnB.balanceOf(address(vault)), handler.owed());
    }

    /// Claim: the balance equals funded liquidity minus paid claims, to the wei. Shows: exact conservation, so
    /// no hidden transfer exists. Matters: H-13.
    function invariant_H13_balanceEqualsFundedMinusPaid() public view {
        assertEq(tokenOnB.balanceOf(address(vault)), handler.fundedLiquidity() - handler.totalPaid());
    }

    /// Claim: no replay and no tampered proof ever pays. Shows: zero successes over all attempts.
    /// Matters: H-08, H-16 and R2-04 (the checks hold under random sequences, not just in examples).
    function invariant_H16_tamperedAndReplayedProofsNeverPay() public view {
        assertEq(handler.tamperSuccesses(), 0);
        assertEq(handler.replaySuccesses(), 0);
    }

    /// Claim: the claimed flag matches the handler's ledger for every claim. Shows: a flag is set exactly when the
    /// handler paid that claim. Matters: double-claim protection.
    function invariant_H16_claimedFlagsMatchLedger() public view {
        uint256 count = handler.claimCount();
        for (uint256 i = 0; i < count; i++) {
            assertEq(vault.claimed(handler.nonceAt(i)), handler.paidAt(i));
        }
    }

    /// Claim: the handler really exercises the paths. Shows: after a fixed scripted sequence, claims are paid and
    /// attacks are attempted. Matters: an invariant over a handler that never acts proves nothing.
    function test_H13_handlerReachesThePayingPath() public {
        handler.fundLiquidity(40e18, 1);
        handler.registerClaim(0);
        handler.claim(0);
        handler.replayPaidClaim(0);
        handler.submitTampered(0, 1, 5);
        assertEq(handler.claimsPaid(), 1);
        assertEq(handler.replayAttempts(), 1);
        assertEq(handler.tamperAttempts(), 1);
        assertEq(tokenOnB.balanceOf(ReceiptFixtures.RECIPIENT), 1e18);
    }
}
