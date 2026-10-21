// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Vm} from "forge-std/Vm.sol";
import {IERC20Errors} from "@openzeppelin/contracts/interfaces/draft-IERC6093.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {BridgeVault} from "../../src/hardened/BridgeVault.sol";
import {BeaconLightClient} from "../../src/hardened/BeaconLightClient.sol";
import {OracleSP1Verifier} from "../../src/mocks/OracleSP1Verifier.sol";
import {MockERC20} from "../../src/mocks/MockERC20.sol";
import {NoReturnToken} from "../../src/mocks/NoReturnToken.sol";
import {FeeOnTransferToken} from "../../src/mocks/FeeOnTransferToken.sol";
import {ReturnsFalseToken} from "../../src/mocks/ReturnsFalseToken.sol";
import {FakeDepositEmitter} from "../../src/mocks/FakeDepositEmitter.sol";
import {WithdrawalScenes} from "./utils/WithdrawalScenes.sol";
import {ReceiptFixtures} from "./utils/ReceiptFixtures.sol";
import {BurnAllToken, ReentrantToken} from "./utils/HardenedMocks.sol";

/// @notice Unit tests of the hardened vault: constructor, deposit, withdraw, token handling.
contract BridgeVaultTest is WithdrawalScenes {
    event WithdrawalCompleted(
        bytes32 indexed depositNonce,
        address indexed recipient,
        address indexed localToken,
        uint256 amount,
        bytes32 depositBlockHash
    );
    event DepositInitiated(
        address indexed token,
        address indexed sender,
        address indexed recipient,
        uint256 amount,
        bytes32 nonce,
        uint64 targetChainId
    );

    function _pair(address localToken, address remoteToken, uint8 decimals)
        internal
        pure
        returns (BridgeVault.TokenPair[] memory pairs)
    {
        pairs = new BridgeVault.TokenPair[](1);
        pairs[0] = BridgeVault.TokenPair(localToken, remoteToken, decimals);
    }

    function _newVault(address client, uint64 local, uint64 remote, address remoteVault_, BridgeVault.TokenPair[] memory pairs)
        internal
        returns (BridgeVault)
    {
        return new BridgeVault(client, local, remote, remoteVault_, pairs, 0);
    }

    /// @dev A vault on chain B for one custom local token, paired with the fixture remote token and remote vault.
    function _vaultFor(address localToken, uint8 decimals) internal returns (BridgeVault) {
        vm.chainId(CHAIN_B);
        BridgeVault custom = _newVault(
            address(lightClientForB), CHAIN_B, CHAIN_A, ReceiptFixtures.REMOTE_VAULT, _pair(localToken, ReceiptFixtures.REMOTE_TOKEN, decimals)
        );
        createdVaults.push(custom); // `_scene` adds the fork layouts to it
        return custom;
    }

    // ================================================================ constructor

    /// Claim: the constructor stores the configuration and registers both directions of every pair.
    /// Shows: every immutable and both mappings. Matters: R2-08 and H-03 (explicit pairs, not same-address mapping).
    function test_H03_constructor_storesConfigurationAndPairs() public view {
        assertEq(address(vaultB.lightClient()), address(lightClientForB));
        assertEq(vaultB.localChainId(), CHAIN_B);
        assertEq(vaultB.remoteChainId(), CHAIN_A);
        assertEq(vaultB.remoteVault(), address(vaultA));
        assertEq(vaultB.remoteTokenOf(address(tokenOnB)), address(tokenOnA));
        assertEq(vaultB.localTokenOf(address(tokenOnA)), address(tokenOnB));
        assertEq(vaultB.depositCount(), 0);
    }

    /// Claim: each zero constructor argument is refused with its name. Shows: three reverts with exact errors (the vault has no verifier argument).
    /// Matters: R2-08 (a placeholder or an unset address must fail at deployment, not lock funds later).
    function test_R2_08_constructor_revertsOnZeroArguments() public {
        BridgeVault.TokenPair[] memory pairs = _pair(address(tokenOnB), address(tokenOnA), 18);
        vm.chainId(CHAIN_B);
        address client = address(lightClientForB);

        vm.expectRevert(abi.encodeWithSelector(BridgeVault.ZeroValue.selector, "lightClient"));
        _newVault(address(0), CHAIN_B, CHAIN_A, address(vaultA), pairs);
        vm.expectRevert(abi.encodeWithSelector(BridgeVault.ZeroValue.selector, "remoteChainId"));
        _newVault(client, CHAIN_B, 0, address(vaultA), pairs);
        vm.expectRevert(abi.encodeWithSelector(BridgeVault.ZeroValue.selector, "remoteVault"));
        _newVault(client, CHAIN_B, CHAIN_A, address(0), pairs);

        _newVault(client, CHAIN_B, CHAIN_A, address(vaultA), pairs); // honest path
    }

    /// Claim: the vault refuses a local chain id that differs from `block.chainid`. Shows: the exact error, and that
    /// the right id works. Matters: R2-08 (a vault deployed to the wrong chain would pin the wrong nonce domain).
    function test_R2_08_constructor_revertsOnLocalChainIdMismatch() public {
        BridgeVault.TokenPair[] memory pairs = _pair(address(tokenOnB), address(tokenOnA), 18);
        vm.chainId(CHAIN_B);
        vm.expectRevert(abi.encodeWithSelector(BridgeVault.LocalChainIdMismatch.selector, CHAIN_A, uint256(CHAIN_B)));
        _newVault(address(lightClientForB), CHAIN_A, CHAIN_B, address(vaultA), pairs);
        _newVault(address(lightClientForB), CHAIN_B, CHAIN_A, address(vaultA), pairs);
    }

    /// Claim: a vault cannot bridge to its own chain. Shows: the exact error. Matters: H-16 (nonce domains stay distinct).
    function test_H16_constructor_revertsWhenRemoteChainIsLocalChain() public {
        BridgeVault.TokenPair[] memory pairs = _pair(address(tokenOnB), address(tokenOnA), 18);
        vm.chainId(CHAIN_B);
        vm.expectRevert(BridgeVault.RemoteChainIsLocalChain.selector);
        _newVault(address(lightClientForB), CHAIN_B, CHAIN_B, address(vaultA), pairs);
    }

    /// Claim: a vault with no tokens is useless and is refused. Shows: the exact error. Matters: fail fast.
    function test_H03_constructor_revertsOnNoPairs() public {
        vm.chainId(CHAIN_B);
        vm.expectRevert(BridgeVault.NoTokenPairs.selector);
        _newVault(address(lightClientForB), CHAIN_B, CHAIN_A, address(vaultA), new BridgeVault.TokenPair[](0));
    }

    /// Claim: zero token addresses and tokens without code are refused. Shows: three exact errors.
    /// Matters: H-03 (a registry entry must name a real token on each side).
    function test_H03_constructor_revertsOnBadTokenAddresses() public {
        vm.chainId(CHAIN_B);
        address client = address(lightClientForB);
        vm.expectRevert(abi.encodeWithSelector(BridgeVault.ZeroValue.selector, "localToken"));
        _newVault(client, CHAIN_B, CHAIN_A, address(vaultA), _pair(address(0), address(tokenOnA), 18));
        vm.expectRevert(abi.encodeWithSelector(BridgeVault.ZeroValue.selector, "remoteToken"));
        _newVault(client, CHAIN_B, CHAIN_A, address(vaultA), _pair(address(tokenOnB), address(0), 18));
        vm.expectRevert(abi.encodeWithSelector(BridgeVault.TokenHasNoCode.selector, alice));
        _newVault(client, CHAIN_B, CHAIN_A, address(vaultA), _pair(alice, address(tokenOnA), 18));
    }

    /// Claim: a pair whose decimals differ from the local token is refused. Shows: a 6-decimal token claimed as
    /// 18 reverts with both numbers; the honest claim of 6 works. Matters: R2-07 (different decimals pay the wrong amount).
    function test_R2_07_constructor_revertsOnDecimalsMismatch() public {
        NoReturnToken sixDecimals = new NoReturnToken();
        vm.chainId(CHAIN_B);
        vm.expectRevert(abi.encodeWithSelector(BridgeVault.DecimalsMismatch.selector, address(sixDecimals), uint8(6), uint8(18)));
        _newVault(address(lightClientForB), CHAIN_B, CHAIN_A, address(vaultA), _pair(address(sixDecimals), address(tokenOnA), 18));

        BridgeVault ok = _newVault(address(lightClientForB), CHAIN_B, CHAIN_A, address(vaultA), _pair(address(sixDecimals), address(tokenOnA), 6)
        );
        assertEq(ok.remoteTokenOf(address(sixDecimals)), address(tokenOnA));
    }

    /// Claim: a token cannot be registered twice on either side. Shows: both duplicate errors. Matters: H-03 (one
    /// remote token cannot pay two local tokens).
    function test_H03_constructor_revertsOnDuplicates() public {
        MockERC20 other = new MockERC20("Other", "OTH");
        BridgeVault.TokenPair[] memory sameLocal = new BridgeVault.TokenPair[](2);
        sameLocal[0] = BridgeVault.TokenPair(address(tokenOnB), address(tokenOnA), 18);
        sameLocal[1] = BridgeVault.TokenPair(address(tokenOnB), address(other), 18);
        vm.chainId(CHAIN_B);
        vm.expectRevert(abi.encodeWithSelector(BridgeVault.DuplicateLocalToken.selector, address(tokenOnB)));
        _newVault(address(lightClientForB), CHAIN_B, CHAIN_A, address(vaultA), sameLocal);

        BridgeVault.TokenPair[] memory sameRemote = new BridgeVault.TokenPair[](2);
        sameRemote[0] = BridgeVault.TokenPair(address(tokenOnB), address(tokenOnA), 18);
        sameRemote[1] = BridgeVault.TokenPair(address(other), address(tokenOnA), 18);
        vm.expectRevert(abi.encodeWithSelector(BridgeVault.DuplicateRemoteToken.selector, address(tokenOnA)));
        _newVault(address(lightClientForB), CHAIN_B, CHAIN_A, address(vaultA), sameRemote);

        BridgeVault.TokenPair[] memory distinct = new BridgeVault.TokenPair[](2);
        distinct[0] = BridgeVault.TokenPair(address(tokenOnB), address(tokenOnA), 18);
        distinct[1] = BridgeVault.TokenPair(address(other), address(new MockERC20("R", "R")), 18);
        _newVault(address(lightClientForB), CHAIN_B, CHAIN_A, address(vaultA), distinct); // honest
    }

    // ================================================================ event topic

    /// Claim: `DEPOSIT_EVENT_TOPIC` is the keccak256 of the event signature string, and equals the compiler's
    /// selector. Shows: both, plus the topic on a real log. Matters: R2-02 (the circuit hardcoded a wrong topic).
    function test_R2_02_depositEventTopicIsKeccakOfSignature() public {
        bytes32 expected = keccak256("DepositInitiated(address,address,address,uint256,bytes32,uint64)");
        assertEq(vaultA.DEPOSIT_EVENT_TOPIC(), expected);
        assertEq(vaultA.DEPOSIT_EVENT_TOPIC(), BridgeVault.DepositInitiated.selector);
        assertTrue(vaultA.DEPOSIT_EVENT_TOPIC() != bytes32(0x2df9000000000000000000000000000000000000000000000000000000000000) , "not the wrong revision-2 prefix");

        vm.chainId(CHAIN_A);
        tokenOnA.mint(alice, 1e18);
        vm.startPrank(alice);
        tokenOnA.approve(address(vaultA), 1e18);
        vm.recordLogs();
        vaultA.deposit(address(tokenOnA), bob, 1e18);
        vm.stopPrank();
        Vm.Log[] memory logs = vm.getRecordedLogs();
        Vm.Log memory depositLog = logs[logs.length - 1];
        assertEq(depositLog.emitter, address(vaultA));
        assertEq(depositLog.topics[0], expected, "the log carries the pinned topic");
    }

    /// Claim: the event has exactly three indexed parameters (topic 0 plus three topics). Shows: the log has four
    /// topics and the contract compiled. Matters: R2-01 (four indexed parameters do not compile).
    function test_R2_01_depositEventHasThreeIndexedParameters() public {
        vm.chainId(CHAIN_A);
        tokenOnA.mint(alice, 1e18);
        vm.startPrank(alice);
        tokenOnA.approve(address(vaultA), 1e18);
        vm.recordLogs();
        vaultA.deposit(address(tokenOnA), bob, 1e18);
        vm.stopPrank();
        Vm.Log[] memory logs = vm.getRecordedLogs();
        Vm.Log memory depositLog = logs[logs.length - 1];
        assertEq(depositLog.topics.length, 4);
        assertEq(depositLog.topics[1], bytes32(uint256(uint160(address(tokenOnA)))));
        assertEq(depositLog.topics[2], bytes32(uint256(uint160(alice))));
        assertEq(depositLog.topics[3], bytes32(uint256(uint160(bob))));
        assertEq(depositLog.data.length, 96, "amount, nonce, target chain id");
    }

    // ================================================================ deposit

    /// Claim: an honest deposit locks the tokens, emits the event with the received amount, and targets the remote
    /// chain. Shows: balances, nonce, and the event. Matters: H-10 (the target is never caller-chosen).
    function test_H10_deposit_honestPathTargetsRemoteChain() public {
        vm.chainId(CHAIN_A);
        tokenOnA.mint(alice, 100e18);
        vm.startPrank(alice);
        tokenOnA.approve(address(vaultA), 100e18);
        bytes32 expectedNonce = keccak256(abi.encode(uint256(CHAIN_A), address(vaultA), uint256(0)));
        vm.expectEmit(true, true, true, true, address(vaultA));
        emit DepositInitiated(address(tokenOnA), alice, bob, 100e18, expectedNonce, CHAIN_B);
        bytes32 nonce = vaultA.deposit(address(tokenOnA), bob, 100e18);
        vm.stopPrank();

        assertEq(nonce, expectedNonce);
        assertEq(tokenOnA.balanceOf(address(vaultA)), 100e18);
        assertEq(tokenOnA.balanceOf(alice), 0);
        assertEq(vaultA.depositCount(), 1);
    }

    /// Claim: there is no way to name a target chain. Shows: the old four-argument selector does not exist, and the
    /// three-argument selector is the only `deposit`. Matters: H-10 (a typo in the target locked funds forever).
    function test_H10_deposit_hasNoTargetChainParameter() public {
        vm.chainId(CHAIN_A);
        tokenOnA.mint(alice, 1e18);
        vm.startPrank(alice);
        tokenOnA.approve(address(vaultA), 1e18);
        (bool oldShape,) = address(vaultA).call(
            abi.encodeWithSignature("deposit(address,address,uint256,uint64)", address(tokenOnA), bob, 1e18, uint64(999))
        );
        assertFalse(oldShape, "no overload takes a target chain");
        (bool newShape,) = address(vaultA).call(abi.encodeCall(BridgeVault.deposit, (address(tokenOnA), bob, 1e18)));
        assertTrue(newShape);
        vm.stopPrank();
    }

    /// Claim: only registered tokens deposit. Shows: the cheap copy of a token (H-03) is refused with its address, and
    /// the registered token works. Matters: H-03 (an unregistered token must never reach the mapping).
    function test_H03_deposit_revertsOnUnregisteredToken() public {
        vm.chainId(CHAIN_A);
        MockERC20 cheapCopy = new MockERC20("Cheap copy", "CHEAP");
        cheapCopy.mint(attacker, 1e18);
        vm.startPrank(attacker);
        cheapCopy.approve(address(vaultA), 1e18);
        vm.expectRevert(abi.encodeWithSelector(BridgeVault.UnsupportedToken.selector, address(cheapCopy)));
        vaultA.deposit(address(cheapCopy), attacker, 1e18);
        vm.stopPrank();

        _depositOnA(alice, bob, 1e18); // honest path
    }

    /// Claim: the remote-side token address is not a deposit token on this side. Shows: depositing the paired remote
    /// token on vault A reverts. Matters: H-03 (the registry is directional).
    function test_H03_deposit_revertsOnRemoteTokenAddress() public {
        vm.chainId(CHAIN_A);
        tokenOnB.mint(alice, 1e18);
        vm.startPrank(alice);
        tokenOnB.approve(address(vaultA), 1e18);
        vm.expectRevert(abi.encodeWithSelector(BridgeVault.UnsupportedToken.selector, address(tokenOnB)));
        vaultA.deposit(address(tokenOnB), bob, 1e18);
        vm.stopPrank();
    }

    /// Claim: a zero recipient and a zero amount are refused. Shows: both exact errors; honest path after.
    /// Matters: a deposit to the zero address burns the claim.
    function test_H10_deposit_revertsOnZeroRecipientAndZeroAmount() public {
        vm.chainId(CHAIN_A);
        tokenOnA.mint(alice, 1e18);
        vm.startPrank(alice);
        tokenOnA.approve(address(vaultA), 1e18);
        vm.expectRevert(BridgeVault.ZeroRecipient.selector);
        vaultA.deposit(address(tokenOnA), address(0), 1e18);
        vm.expectRevert(BridgeVault.ZeroAmount.selector);
        vaultA.deposit(address(tokenOnA), bob, 0);
        vaultA.deposit(address(tokenOnA), bob, 1e18);
        vm.stopPrank();
    }

    /// Claim: a deposit without allowance or balance reverts with the token's own error, and no nonce is used.
    /// Shows: the exact OpenZeppelin errors and an unchanged counter. Matters: failed deposits leave no trace.
    function test_H12_deposit_revertsWithoutAllowanceOrBalance() public {
        vm.chainId(CHAIN_A);
        tokenOnA.mint(alice, 1e18);
        vm.startPrank(alice);
        vm.expectRevert(abi.encodeWithSelector(IERC20Errors.ERC20InsufficientAllowance.selector, address(vaultA), 0, 1e18));
        vaultA.deposit(address(tokenOnA), bob, 1e18);
        tokenOnA.approve(address(vaultA), 2e18);
        vm.expectRevert(abi.encodeWithSelector(IERC20Errors.ERC20InsufficientBalance.selector, alice, 1e18, 2e18));
        vaultA.deposit(address(tokenOnA), bob, 2e18);
        assertEq(vaultA.depositCount(), 0);
        vaultA.deposit(address(tokenOnA), bob, 1e18); // honest path
        assertEq(vaultA.depositCount(), 1);
        vm.stopPrank();
    }

    /// Claim: a transfer that moves nothing is not a deposit. Shows: `NothingReceived` for a token whose
    /// `transferFrom` returns true and moves nothing. Matters: H-13 (the vault must measure, not trust).
    function test_H13_deposit_revertsWhenNothingIsReceived() public {
        BurnAllToken burn = new BurnAllToken();
        BridgeVault vault = _vaultFor(address(burn), 18);
        burn.mint(alice, 1e18);
        vm.prank(alice);
        vm.expectRevert(BridgeVault.NothingReceived.selector);
        vault.deposit(address(burn), bob, 1e18);
    }

    /// Claim: a fee-on-transfer token deposits the received amount, not the requested amount. Shows: the event and
    /// the vault balance agree at 99% of the request. Matters: H-13 (a claim for the requested amount makes the vault insolvent).
    function test_H13_deposit_feeOnTransferEmitsReceivedAmount() public {
        FeeOnTransferToken fee = new FeeOnTransferToken("Fee", "FEE");
        BridgeVault vault = _vaultFor(address(fee), 18);
        fee.mint(alice, 1000e18);
        vm.startPrank(alice);
        fee.approve(address(vault), 1000e18);
        vm.recordLogs();
        vault.deposit(address(fee), bob, 1000e18);
        vm.stopPrank();
        Vm.Log[] memory logs = vm.getRecordedLogs();
        (uint256 eventAmount,,) = abi.decode(logs[logs.length - 1].data, (uint256, bytes32, uint64));
        assertEq(fee.balanceOf(address(vault)), 990e18);
        assertEq(eventAmount, 990e18, "the event carries what the vault holds");
    }

    /// Claim: many deposits in one block get unique nonces. Shows: 60 identical deposits (same sender, token,
    /// recipient, amount, block) yield 60 distinct nonces that match the formula, and each can be claimed.
    /// Matters: H-12 (identical deposits shared one nonce in revision 1, so only one could be claimed).
    function test_H12_deposit_noncesAreUniqueInOneBlock() public {
        vm.chainId(CHAIN_A);
        tokenOnA.mint(alice, 60e18);
        vm.startPrank(alice);
        tokenOnA.approve(address(vaultA), 60e18);
        bytes32[] memory nonces = new bytes32[](60);
        for (uint256 i = 0; i < 60; i++) {
            nonces[i] = vaultA.deposit(address(tokenOnA), bob, 1e18);
            assertEq(nonces[i], keccak256(abi.encode(uint256(CHAIN_A), address(vaultA), i)));
        }
        vm.stopPrank();
        for (uint256 i = 0; i < 60; i++) {
            for (uint256 j = i + 1; j < 60; j++) {
                assertTrue(nonces[i] != nonces[j]);
            }
        }
        assertEq(vaultA.depositCount(), 60);
    }

    /// Claim: the nonce commits to the chain and the vault, so the same counter value on two vaults differs.
    /// Shows: deposit number 0 on vault A and on vault B differ. Matters: H-16 (the nonce included neither).
    function test_H16_deposit_nonceCommitsToChainAndVault() public {
        (bytes32 nonceA,) = _depositOnA(alice, bob, 1e18);
        (bytes32 nonceB,) = _depositOnB(alice, bob, 1e18);
        assertTrue(nonceA != nonceB);
        assertEq(nonceA, keccak256(abi.encode(uint256(CHAIN_A), address(vaultA), uint256(0))));
        assertEq(nonceB, keccak256(abi.encode(uint256(CHAIN_B), address(vaultB), uint256(0))));
    }

    /// Claim: the storage reentrancy guard blocks a token that calls back into `deposit`. Shows: the guard error
    /// bubbles up; with the callback off, the deposit works. Matters: H-13 (hostile tokens) and R2-10 (the guard is
    /// the storage version, because PulseChain has no TSTORE).
    function test_H13_deposit_blocksReentrancyThroughToken() public {
        ReentrantToken token = new ReentrantToken();
        BridgeVault vault = _vaultFor(address(token), 18);
        token.mint(alice, 2e18);
        vm.startPrank(alice);
        token.approve(address(vault), 2e18);
        token.arm(address(vault), abi.encodeCall(BridgeVault.deposit, (address(token), bob, 1)));
        vm.expectRevert(ReentrancyGuard.ReentrancyGuardReentrantCall.selector);
        vault.deposit(address(token), bob, 1e18);
        token.arm(address(0), ""); // the revert undid the first disarm
        vault.deposit(address(token), bob, 1e18); // honest path
        vm.stopPrank();
        assertEq(vault.depositCount(), 1);
    }

    // ================================================================ tokens on the payout path

    /// Claim: a token whose `transfer` returns false does not burn a claim. Shows: deposit works (its `transferFrom`
    /// is fine), and the payout reverts with `SafeERC20FailedOperation`, leaves the nonce unclaimed, and keeps the
    /// funds. Matters: H-13 (revision 1 ignored the return value and marked the claim paid).
    function test_H13_withdraw_returnsFalseTokenRevertsAndKeepsClaim() public {
        ReturnsFalseToken bad = new ReturnsFalseToken("Bad", "BAD");
        BridgeVault vault = _vaultFor(address(bad), 18);
        bad.mint(address(vault), 100e18);
        ReceiptFixtures.Named memory named = ReceiptFixtures.type2();
        Scene memory scene = _scene(named, _defaultParams());
        vm.expectRevert(abi.encodeWithSelector(SafeERC20.SafeERC20FailedOperation.selector, address(bad)));
        vault.withdraw(scene.proof);
        assertFalse(vault.claimed(named.nonce), "the claim is not burned");
        assertEq(bad.balanceOf(address(vault)), 100e18);
    }

    /// Claim: a USDT-style token that returns nothing works in both directions. Shows: deposit and withdraw succeed.
    /// The fixture amount is 3e18, and the 6-decimal token pays 3e18 base units of its own. Matters: H-13 (revision 1
    /// reverted on such tokens).
    function test_H13_noReturnTokenWorksBothWays() public {
        NoReturnToken usdt = new NoReturnToken();
        BridgeVault vault = _vaultFor(address(usdt), 6);
        usdt.mint(alice, 50e6);
        vm.startPrank(alice);
        usdt.approve(address(vault), 50e6);
        vault.deposit(address(usdt), bob, 50e6);
        vm.stopPrank();
        assertEq(usdt.balanceOf(address(vault)), 50e6);

        ReceiptFixtures.Named memory named = ReceiptFixtures.type2();
        usdt.mint(address(vault), named.amount); // liquidity for the fixture amount
        vault.withdraw(_scene(named, _defaultParams()).proof);
        assertEq(usdt.balanceOf(ReceiptFixtures.RECIPIENT), named.amount);
    }

    /// Claim: the storage guard stops a token that calls back into `withdraw` during the payout. Shows: the guard
    /// error bubbles up, and the claim stays open. Matters: H-13 (hostile token) and R2-10 (no TSTORE).
    function test_H13_withdraw_blocksReentrancyThroughToken() public {
        ReentrantToken token = new ReentrantToken();
        BridgeVault vault = _vaultFor(address(token), 18);
        token.mint(address(vault), 100e18);
        ReceiptFixtures.Named memory named = ReceiptFixtures.type2();
        Scene memory scene = _scene(named, _defaultParams());
        token.arm(address(vault), abi.encodeCall(BridgeVault.withdraw, (scene.proof)));
        vm.expectRevert(ReentrancyGuard.ReentrancyGuardReentrantCall.selector);
        vault.withdraw(scene.proof);
        assertFalse(vault.claimed(named.nonce));
        token.arm(address(0), ""); // the revert undid the first disarm
        vault.withdraw(scene.proof); // honest path
        assertEq(token.balanceOf(ReceiptFixtures.RECIPIENT), named.amount);
    }

    /// Claim: the vault has no verifier, no verification key, and no owner. Shows: calls to the old getters fail.
    /// Matters: the vault checks withdrawals itself, so no key can redirect it (coordinator decision, 2026-10-20).
    function test_H04_vaultHasNoVerifierOrKey() public {
        string[4] memory getters = ["verifier()", "withdrawalVKey()", "owner()", "programVKey()"];
        for (uint256 i = 0; i < getters.length; i++) {
            (bool ok,) = address(vaultB).staticcall(abi.encodeWithSignature(getters[i]));
            assertFalse(ok);
        }
    }

    /// Claim: the vault has no refund. Shows: no function with a refund-like name answers. Matters: scope decision
    /// (H-09): a refund without a cancellation proof allows a double claim.
    function test_H09_vaultHasNoRefundFunction() public {
        string[3] memory signatures = ["refund(bytes32)", "refund(address,uint256)", "cancel(bytes32)"];
        for (uint256 i = 0; i < signatures.length; i++) {
            (bool ok,) = address(vaultA).call(abi.encodeWithSignature(signatures[i], bytes32(0)));
            assertFalse(ok);
        }
    }
}
