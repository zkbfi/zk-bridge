// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {IERC20Errors} from "@openzeppelin/contracts/interfaces/draft-IERC6093.sol";
import {Revision2Fixture} from "./Revision2Fixture.sol";
import {ZKBridgeVault} from "../../src/revision-2/ZKBridgeVault.sol";
import {LightClientSync} from "../../src/revision-2/LightClientSync.sol";
import {RealShapeOracleVerifier} from "../../src/revision-2/mocks/RealShapeOracleVerifier.sol";
import {DecimalsToken} from "../../src/revision-2/mocks/DecimalsToken.sol";
import {MockERC20} from "../../src/mocks/MockERC20.sol";
import {FeeOnTransferToken} from "../../src/mocks/FeeOnTransferToken.sol";
import {ReturnsFalseToken} from "../../src/mocks/ReturnsFalseToken.sol";
import {NoReturnToken} from "../../src/mocks/NoReturnToken.sol";
import {FakeDepositEmitter} from "../../src/mocks/FakeDepositEmitter.sol";

/// @notice Tests against revision 2 of `ZKBridgeVault`. "fixConfirmed" tests show that a revision 2 fix
/// holds. Tests named after an R2 identifier pass when the defect is real. The refund path (H-09) is out
/// of scope by the user's decision. `Revision2Guards.t.sol` pins its behaviour so that the coverage gate holds. It is a mention only: `requestRefund` exists in
/// the specification and a refund without a cancellation proof can pay one deposit twice.
contract VaultRevision2Test is Revision2Fixture {
    bytes32 internal constant ROOT = keccak256("block that holds the deposit");

    /// @dev Deposits on vault A, attests the root, and returns the nonce.
    function _depositAndAttest(uint256 amount) internal returns (bytes32 nonce) {
        tokenA.mint(alice, amount);
        (nonce,) = _deposit(vaultA, address(tokenA), alice, bob, amount, CHAIN_B);
        _attest(ROOT);
    }

    // ------------------------------------------------------------------ baseline

    /// Control for the whole file: the honest path works with the real-shape verifier.
    /// Without it, a revert in a later test could come from a broken fixture and not from the fix under test.
    function test_baseline_honestDepositAndWithdrawWork() public {
        bytes32 nonce = _depositAndAttest(100e18);
        _claim(vaultB, _publicValues(address(vaultA), address(tokenA), bob, 100e18, nonce, ROOT));
        assertEq(tokenB.balanceOf(bob), 100e18);
        assertTrue(vaultB.processedNonces(nonce));
    }

    /// The verifier double reverts on a bad proof (H-11 fix: the vault calls `verifyProof`, which reverts).
    function test_H11_fixConfirmed_realShapeVerifierRevertsOnInvalidProof() public {
        bytes32 nonce = _depositAndAttest(100e18);
        bytes memory publicValues = _publicValues(address(vaultA), address(tokenA), bob, 100e18, nonce, ROOT);
        vm.expectRevert(RealShapeOracleVerifier.InvalidProof.selector);
        vaultB.withdraw(hex"00", publicValues);

        // A proof for different public values is refused too (the amount is bound).
        bytes memory otherValues = _publicValues(address(vaultA), address(tokenA), bob, 101e18, nonce, ROOT);
        bytes memory proofForOther = _prove(otherValues);
        vm.expectRevert(RealShapeOracleVerifier.InvalidProof.selector);
        vaultB.withdraw(proofForOther, publicValues);
        assertEq(tokenB.balanceOf(bob), 0);
    }

    // ------------------------------------------------------------------ H-10

    /// Revision 2 claim (H-10 fixed): `supportedChains` rejects unknown targets.
    /// What the test shows: the fix holds. Unknown chains and the local chain are refused. Control: the listed chain works.
    /// Why it matters: a typo no longer locks funds.
    function test_H10_fixConfirmed_unsupportedTargetChainIsRefused() public {
        tokenA.mint(alice, 300e18);
        vm.startPrank(alice);
        tokenA.approve(address(vaultA), 300e18);
        vm.expectRevert("Target network architecture unsupported");
        vaultA.deposit(address(tokenA), bob, 100e18, 56);
        vm.expectRevert("Target network architecture unsupported");
        vaultA.deposit(address(tokenA), bob, 100e18, 0);
        vm.expectRevert("Target network architecture unsupported");
        vaultA.deposit(address(tokenA), bob, 100e18, CHAIN_A);
        vaultA.deposit(address(tokenA), bob, 100e18, CHAIN_B);
        vm.stopPrank();
        assertEq(tokenA.balanceOf(address(vaultA)), 100e18, "only the supported deposit locked tokens");
    }

    // ------------------------------------------------------------------ H-12

    /// Revision 2 claim (H-12 fixed): a per-sender counter feeds the nonce.
    /// What the test shows: two identical deposits in one block get different nonces and both pay out.
    /// Why it matters: in revision 1 only one of them could be claimed.
    function test_H12_fixConfirmed_identicalDepositsInOneBlockBothClaimable() public {
        tokenA.mint(alice, 200e18);
        (bytes32 nonceOne,) = _deposit(vaultA, address(tokenA), alice, bob, 100e18, CHAIN_B);
        (bytes32 nonceTwo,) = _deposit(vaultA, address(tokenA), alice, bob, 100e18, CHAIN_B);
        assertTrue(nonceOne != nonceTwo, "nonces differ");
        _attest(ROOT);
        _claim(vaultB, _publicValues(address(vaultA), address(tokenA), bob, 100e18, nonceOne, ROOT));
        _claim(vaultB, _publicValues(address(vaultA), address(tokenA), bob, 100e18, nonceTwo, ROOT));
        assertEq(tokenB.balanceOf(bob), 200e18);

        // Control: the same nonce cannot be claimed twice.
        bytes memory again = _publicValues(address(vaultA), address(tokenA), bob, 100e18, nonceOne, ROOT);
        bytes memory proof = _prove(again);
        vm.expectRevert("Bridge transaction already claimed");
        vaultB.withdraw(proof, again);
    }

    // ------------------------------------------------------------------ H-13

    /// Revision 2 claim (H-13 fixed): the vault measures the received balance.
    /// What the test shows: with a 1% fee token the event and the stored claim carry the net amount, so
    /// the vault stays solvent. Control: a plain token reports the gross amount.
    function test_H13_fixConfirmed_feeOnTransferDepositReportsNetAmount() public {
        FeeOnTransferToken feeToken = new FeeOnTransferToken("Fee", "FEE");
        MockERC20 remote = new MockERC20("Remote", "REM");
        (ZKBridgeVault feeVaultA,) = _deployPair(address(feeToken), address(remote));
        feeToken.mint(alice, 100e18);
        (, uint256 reported) = _deposit(feeVaultA, address(feeToken), alice, bob, 100e18, CHAIN_B);
        assertEq(reported, 99e18, "event carries the net amount");
        assertEq(feeToken.balanceOf(address(feeVaultA)), 99e18, "vault holds exactly what the event says");

        tokenA.mint(alice, 100e18);
        (, uint256 plainReported) = _deposit(vaultA, address(tokenA), alice, bob, 100e18, CHAIN_B);
        assertEq(plainReported, 100e18, "control: plain token reports the gross amount");
    }

    /// Revision 2 claim (H-13 fixed): `safeTransfer` handles a token whose `transfer` returns false.
    /// What the test shows: the withdrawal reverts as a whole, so the nonce is not burned. In revision 1 it was burned with no payment.
    /// Why it matters: a bad token no longer eats a claim silently. The claim stays open (but unpayable).
    function test_H13_fixConfirmed_returnsFalseTokenRevertsAndKeepsTheNonceOpen() public {
        ReturnsFalseToken badLocal = new ReturnsFalseToken("Bad", "BAD");
        (, ZKBridgeVault badVaultB) = _deployPair(address(tokenA), address(badLocal));
        badLocal.mint(address(badVaultB), 1000e18);
        tokenA.mint(alice, 100e18);
        (bytes32 nonce,) = _deposit(vaultA, address(tokenA), alice, bob, 100e18, CHAIN_B);
        _attest(ROOT);
        bytes memory publicValues = _publicValues(address(vaultA), address(tokenA), bob, 100e18, nonce, ROOT);
        // badVaultB expects its source vault to be the vault deployed in the same pair, so rebuild the values.
        publicValues = abi.encode(CHAIN_A, CHAIN_B, badVaultB.expectedSourceVault(), address(tokenA), bob, 100e18, nonce, ROOT);
        bytes memory proof = _prove(publicValues);
        vm.expectRevert(abi.encodeWithSelector(SafeERC20.SafeERC20FailedOperation.selector, address(badLocal)));
        badVaultB.withdraw(proof, publicValues);
        assertFalse(badVaultB.processedNonces(nonce), "nonce stays open");
    }

    /// Revision 2 claim (H-13 fixed): USDT-style tokens that return nothing work.
    /// What the test shows: deposit and withdrawal succeed with a no-return token.
    /// Control: the amounts moved exactly.
    function test_H13_fixConfirmed_noReturnTokenDepositsAndWithdraws() public {
        NoReturnToken usdtLikeA = new NoReturnToken();
        NoReturnToken usdtLikeB = new NoReturnToken();
        (ZKBridgeVault noReturnVaultA, ZKBridgeVault noReturnVaultB) = _deployPair(address(usdtLikeA), address(usdtLikeB));
        usdtLikeB.mint(address(noReturnVaultB), 1000e6);
        usdtLikeA.mint(alice, 100e6);
        (bytes32 nonce,) = _deposit(noReturnVaultA, address(usdtLikeA), alice, bob, 100e6, CHAIN_B);
        _attest(ROOT);
        _claim(noReturnVaultB, abi.encode(CHAIN_A, CHAIN_B, address(noReturnVaultA), address(usdtLikeA), bob, 100e6, nonce, ROOT));
        assertEq(usdtLikeB.balanceOf(bob), 100e6);
        assertEq(usdtLikeA.balanceOf(address(noReturnVaultA)), 100e6);
    }

    // ------------------------------------------------------------------ H-16 / H-02

    /// Revision 2 claim (H-16 fixed): the vault checks source chain, source vault, and target chain.
    /// What the test shows: each wrong value is refused with its own message. Control: the honest values pass.
    function test_H16_fixConfirmed_sourceChainSourceVaultAndTargetAreChecked() public {
        bytes32 nonce = _depositAndAttest(100e18);
        bytes32 honestRoot = ROOT;
        address vaultAddress = address(vaultA);

        bytes memory wrongSource = abi.encode(uint64(56), CHAIN_B, vaultAddress, address(tokenA), bob, 100e18, nonce, honestRoot);
        bytes memory wrongSourceProof = _prove(wrongSource);
        vm.expectRevert("Invalid source chain context mapping");
        vaultB.withdraw(wrongSourceProof, wrongSource);

        bytes memory wrongTarget = abi.encode(CHAIN_A, uint64(56), vaultAddress, address(tokenA), bob, 100e18, nonce, honestRoot);
        bytes memory wrongTargetProof = _prove(wrongTarget);
        vm.expectRevert("Invalid target chain execution");
        vaultB.withdraw(wrongTargetProof, wrongTarget);

        // Replaying vault B's own statement on vault A is refused: vault A expects source chain 369.
        bytes memory forA = _publicValues(vaultAddress, address(tokenA), bob, 100e18, nonce, honestRoot);
        bytes memory forAProof = _prove(forA);
        vm.expectRevert("Invalid source chain context mapping");
        vaultA.withdraw(forAProof, forA);

        _claim(vaultB, _publicValues(vaultAddress, address(tokenA), bob, 100e18, nonce, honestRoot));
        assertEq(tokenB.balanceOf(bob), 100e18);
    }

    /// Revision 2 claim (H-02 fixed): the public values name the source vault and the vault compares it.
    /// What the test shows: a deposit event emitted by a fake contract cannot be claimed, because the
    /// statement names the fake emitter and the vault rejects that address. The circuit would also have to
    /// reject a lie about the emitter, and the oracle models a sound circuit.
    /// Why it matters: the fake-emitter attack from revision 1 needs a circuit that lies about the emitter (it does not compile, see R2-04).
    function test_H02_fixConfirmed_fakeEmitterIsRejectedByTheVault() public {
        FakeDepositEmitter fake = new FakeDepositEmitter();
        vm.prank(attacker);
        fake.fakeDeposit(address(tokenA), attacker, 1000e18, keccak256("fake"), CHAIN_B);
        _attest(ROOT);
        bytes memory fakeValues =
            _publicValues(address(fake), address(tokenA), attacker, 1000e18, keccak256("fake"), ROOT);
        bytes memory fakeProof = _prove(fakeValues);
        vm.expectRevert("Invalid source vault contract emitter mapping");
        vaultB.withdraw(fakeProof, fakeValues);
        assertEq(tokenB.balanceOf(attacker), 0);
    }

    // ------------------------------------------------------------------ H-03

    /// Revision 2 claim (H-03 fixed): an explicit remote-to-local registry plus a deposit allow list.
    /// What the test shows: an unregistered token is refused on deposit, and a statement for an unregistered
    /// source token is refused on withdrawal with no state change. Control: the registered token works.
    /// Why it matters: a same-address copy on the other chain can no longer pay out unless the registry lists it.
    function test_H03_fixConfirmed_unregisteredTokensAreRefused() public {
        MockERC20 stranger = new MockERC20("Stranger", "STR");
        stranger.mint(alice, 100e18);
        vm.startPrank(alice);
        stranger.approve(address(vaultA), 100e18);
        vm.expectRevert("Token target asset unsupported for deposit operations");
        vaultA.deposit(address(stranger), bob, 100e18, CHAIN_B);
        vm.stopPrank();

        bytes32 nonce = _depositAndAttest(100e18);
        bytes memory strangerValues = _publicValues(address(vaultA), address(stranger), bob, 100e18, nonce, ROOT);
        bytes memory strangerProof = _prove(strangerValues);
        vm.expectRevert("Unregistered remote asset origin mapping");
        vaultB.withdraw(strangerProof, strangerValues);
        assertFalse(vaultB.processedNonces(nonce), "revert leaves the nonce open");

        _claim(vaultB, _publicValues(address(vaultA), address(tokenA), bob, 100e18, nonce, ROOT));
        assertEq(tokenB.balanceOf(bob), 100e18);
    }

    // ------------------------------------------------------------------ R2-07

    /// Revision 2 claim: the registry maps a remote token to a local token.
    /// What the test shows: nothing compares decimals. A pair of 6 and 18 decimals pays the raw amount, so
    /// 100 tokens of 6 decimals (100e6) pay 100e6 units of the 18 decimal token: a factor of 10^12 too little.
    /// Why it matters: users lose almost all value. Control: a pair with equal decimals pays the exact amount.
    function test_R2_07_sixDecimalsToEighteenPaysTwelveOrdersTooLittle() public {
        DecimalsToken sixDecimals = new DecimalsToken("Six", "SIX", 6);
        DecimalsToken eighteenDecimals = new DecimalsToken("Eighteen", "EIGHTEEN", 18);
        (ZKBridgeVault sourceVault, ZKBridgeVault payingVault) = _deployPair(address(sixDecimals), address(eighteenDecimals));
        eighteenDecimals.mint(address(payingVault), 1_000e18);
        sixDecimals.mint(alice, 100e6);
        (bytes32 nonce,) = _deposit(sourceVault, address(sixDecimals), alice, bob, 100e6, CHAIN_B);
        _attest(ROOT);
        _claim(payingVault, abi.encode(CHAIN_A, CHAIN_B, address(sourceVault), address(sixDecimals), bob, 100e6, nonce, ROOT));
        assertEq(eighteenDecimals.balanceOf(bob), 100e6, "bob receives the raw amount");
        uint256 fairAmount = 100e18;
        assertEq(fairAmount / eighteenDecimals.balanceOf(bob), 1e12, "wrong by a factor of 10^12");

        // Control: with equal decimals the raw amount is correct.
        bytes32 plainNonce = _depositAndAttest(100e18);
        _claim(vaultB, _publicValues(address(vaultA), address(tokenA), bob, 100e18, plainNonce, ROOT));
        assertEq(tokenB.balanceOf(bob), 100e18);
    }

    /// Same defect in the other direction: 18 decimals to 6 decimals pays 10^12 times too much.
    /// What the test shows: one token of 18 decimals (1e18 units) takes 10^12 tokens of 6 decimals (1e18 units) from the paying vault.
    /// Why it matters: this drains the vault with a small deposit. Control: the vault balance falls by exactly the raw amount.
    function test_R2_07_eighteenDecimalsToSixDrainsThePayingVault() public {
        DecimalsToken eighteenDecimals = new DecimalsToken("Eighteen", "EIGHTEEN", 18);
        DecimalsToken sixDecimals = new DecimalsToken("Six", "SIX", 6);
        (ZKBridgeVault sourceVault, ZKBridgeVault payingVault) = _deployPair(address(eighteenDecimals), address(sixDecimals));
        uint256 poolOfOtherUsers = 5_000_000e6; // five million tokens of 6 decimals
        sixDecimals.mint(address(payingVault), poolOfOtherUsers * 1_000_000);
        eighteenDecimals.mint(attacker, 1e18); // one whole token
        (bytes32 nonce,) = _deposit(sourceVault, address(eighteenDecimals), attacker, attacker, 1e18, CHAIN_B);
        _attest(ROOT);
        uint256 before = sixDecimals.balanceOf(address(payingVault));
        _claim(payingVault, abi.encode(CHAIN_A, CHAIN_B, address(sourceVault), address(eighteenDecimals), attacker, 1e18, nonce, ROOT));
        assertEq(sixDecimals.balanceOf(attacker), 1e18, "one token in, 10^12 tokens out");
        assertEq(before - sixDecimals.balanceOf(address(payingVault)), 1e18);
        assertEq(sixDecimals.balanceOf(attacker) / 1e6, 1e12, "10^12 whole tokens of 6 decimals");
    }

    // ------------------------------------------------------------------ R2-08

    /// Revision 2 claim: each vault holds the other vault's address as an immutable (H-16 fix).
    /// What the test shows: the cycle is solvable only by predicting the CREATE address. The fixture does
    /// it with `vm.computeCreateAddress`. The specification ships no such procedure.
    /// Why it matters: this is the workable path. The next test shows how it fails.
    function test_R2_08_workablePath_predictedAddressesMatchTheDeployedVaults() public view {
        assertEq(vaultA.expectedSourceVault(), address(vaultB));
        assertEq(vaultB.expectedSourceVault(), address(vaultA));
        assertEq(vaultA.expectedSourceChainId(), CHAIN_B);
        assertEq(vaultB.expectedSourceChainId(), CHAIN_A);
    }

    /// What the test shows: when one extra transaction lands between the plan and the deployment, vault B
    /// deploys at a different address than vault A expects. The immutable cannot change, so vault A trusts an
    /// address that is not a vault, and a redeploy of A would need another prediction.
    /// Control: with no extra transaction the prediction is right (see the previous test).
    function test_R2_08_oneStrayTransactionBreaksThePredictionPermanently() public {
        uint256 nonceBefore = vm.getNonce(address(this));
        address predictedB = vm.computeCreateAddress(address(this), nonceBefore + 1);
        ZKBridgeVault vaultAWithPrediction = _newVault(CHAIN_A, CHAIN_B, address(tokenA), address(tokenB), predictedB);
        new MockERC20("stray", "STRAY"); // the deployer sends one more transaction
        ZKBridgeVault vaultBActual = _newVault(CHAIN_B, CHAIN_A, address(tokenB), address(tokenA), address(vaultAWithPrediction));
        assertTrue(address(vaultBActual) != predictedB, "vault B landed elsewhere");
        assertTrue(predictedB != address(vaultBActual));
        (bool isVault,) = predictedB.staticcall(abi.encodeWithSignature("currentChainId()"));
        assertFalse(isVault, "the expected source vault address holds the stray token, not a vault");
        assertEq(vaultAWithPrediction.expectedSourceVault(), predictedB, "the immutable still points there");

        // A statement from the real vault B is refused by vault A for ever.
        _attest(ROOT);
        bytes memory fromActual = abi.encode(CHAIN_B, CHAIN_A, address(vaultBActual), address(tokenB), bob, 1e18, bytes32(uint256(1)), ROOT);
        bytes memory fromActualProof = _prove(fromActual);
        vm.expectRevert("Invalid source vault contract emitter mapping");
        vaultAWithPrediction.withdraw(fromActualProof, fromActual);
    }

    // ------------------------------------------------------------------ R2-13

    /// Revision 2 claim: the circuit asserts `keccak256(raw_block_header) == confirmed_block_root`, and the
    /// light client checks `isVerifiedBlockRoot(confirmedBlockRoot)`.
    /// What the test shows: the two sides use different kinds of root. A sync committee signs a beacon block
    /// header root (an SSZ hash tree root built with SHA-256). The circuit pins an execution block hash
    /// (Keccak-256 of the execution header). The contract never links the two. Attesting the beacon root
    /// does not verify the execution hash, and the vault wants the execution hash.
    /// Why it matters: with a real committee no honest update can ever unlock a withdrawal.
    function test_R2_13_beaconRootAndExecutionBlockHashLiveInDifferentNamespaces() public {
        bytes memory executionHeaderRlp = hex"f90211a0aaaa"; // stands for the RLP of an execution header
        bytes32 executionBlockHash = keccak256(executionHeaderRlp);
        bytes32 bodyRoot = keccak256("body root that would commit to the execution payload");
        bytes32 beaconRoot = _beaconHeaderRoot(12345, 7, keccak256("parent"), keccak256("state"), bodyRoot);

        _attest(beaconRoot); // what the real committee signs
        assertTrue(lightClient.isVerifiedBlockRoot(beaconRoot));
        assertTrue(beaconRoot != executionBlockHash, "different hash functions, different values");
        assertFalse(lightClient.isVerifiedBlockRoot(executionBlockHash), "the execution hash is not verified");

        // The vault wants the execution hash, so the statement for a real deposit is refused.
        bytes32 nonce = bytes32(uint256(77));
        bytes memory publicValues = _publicValues(address(vaultA), address(tokenA), bob, 1e18, nonce, executionBlockHash);
        bytes memory proof = _prove(publicValues);
        vm.expectRevert("Block root unverified by consensus layer");
        vaultB.withdraw(proof, publicValues);

        // Control: the statement passes the light client gate only when the beacon root is used, and
        // then the circuit's Keccak-256 check could not hold, since no header hashes to the beacon root.
        bytes memory beaconValues = _publicValues(address(vaultA), address(tokenA), bob, 1e18, nonce, beaconRoot);
        tokenB.mint(address(vaultB), 1e18);
        vaultB.withdraw(_prove(beaconValues), beaconValues);
        assertEq(tokenB.balanceOf(bob), 1e18, "the vault itself accepts it: only the circuit could object");
    }

    /// @dev SSZ hash tree root of a BeaconBlockHeader: five fields, padded to eight leaves, SHA-256 pairs.
    function _beaconHeaderRoot(uint64 slot, uint64 proposer, bytes32 parent, bytes32 state, bytes32 body)
        private
        pure
        returns (bytes32)
    {
        bytes32[8] memory leaves;
        leaves[0] = _littleEndian(slot);
        leaves[1] = _littleEndian(proposer);
        leaves[2] = parent;
        leaves[3] = state;
        leaves[4] = body;
        bytes32 left = sha256(abi.encodePacked(sha256(abi.encodePacked(leaves[0], leaves[1])), sha256(abi.encodePacked(leaves[2], leaves[3]))));
        bytes32 right = sha256(abi.encodePacked(sha256(abi.encodePacked(leaves[4], leaves[5])), sha256(abi.encodePacked(leaves[6], leaves[7]))));
        return sha256(abi.encodePacked(left, right));
    }

    function _littleEndian(uint64 value) private pure returns (bytes32 word) {
        uint256 reversed;
        for (uint256 i = 0; i < 8; i++) {
            reversed = (reversed << 8) | ((value >> (8 * i)) & 0xff);
        }
        word = bytes32(reversed << 192);
    }

    // ------------------------------------------------------------------ R2-14

    /// Revision 2 claim: the constructor takes the verifier and the light client with no validation.
    /// What the test shows: the revision 1 zero-address checks were removed. A vault with a zero verifier,
    /// a zero light client, and a zero expected source vault deploys. Its withdrawals can never work, and
    /// the immutables cannot change.
    /// Why it matters: one typo in the deploy configuration bricks the vault silently. Control: a vault with
    /// real addresses deploys and works (see the baseline test).
    function test_R2_14_constructorAcceptsZeroAddressesAndTheVaultIsBricked() public {
        ZKBridgeVault bricked = new ZKBridgeVault(
            address(0),
            PROGRAM_VKEY,
            CHAIN_B,
            address(0),
            _chains(CHAIN_A),
            _addresses(address(tokenB)),
            _addresses(address(tokenA)),
            _addresses(address(tokenB)),
            CHAIN_A,
            address(0)
        );
        assertEq(address(bricked.sp1Verifier()), address(0));
        assertEq(address(bricked.syncRegistry()), address(0));
        bytes memory publicValues = abi.encode(CHAIN_A, CHAIN_B, address(0), address(tokenA), bob, 1e18, bytes32(uint256(1)), ROOT);
        vm.expectRevert();
        bricked.withdraw(hex"01", publicValues);
    }

    // ------------------------------------------------------------------ R2-15

    /// Revision 2 claim: `deposit` checks the amount, the chain, and the token.
    /// What the test shows: it does not check the recipient. A deposit to the zero address succeeds and
    /// locks tokens, and the claim on the other chain reverts for ever because OpenZeppelin refuses a
    /// transfer to the zero address. The nonce stays unclaimed.
    /// Why it matters: a typo loses the funds on the happy path (a refund is out of scope, see the header comment).
    /// Control: a deposit to a real recipient is claimed.
    function test_R2_15_depositToZeroRecipientLocksFundsAndTheClaimCannotPay() public {
        tokenA.mint(alice, 100e18);
        (bytes32 nonce,) = _deposit(vaultA, address(tokenA), alice, address(0), 100e18, CHAIN_B);
        assertEq(tokenA.balanceOf(address(vaultA)), 100e18, "locked");
        _attest(ROOT);
        bytes memory publicValues = _publicValues(address(vaultA), address(tokenA), address(0), 100e18, nonce, ROOT);
        bytes memory proof = _prove(publicValues);
        vm.expectRevert(abi.encodeWithSelector(IERC20Errors.ERC20InvalidReceiver.selector, address(0)));
        vaultB.withdraw(proof, publicValues);
        assertFalse(vaultB.processedNonces(nonce));

        bytes32 goodNonce;
        tokenA.mint(alice, 1e18);
        (goodNonce,) = _deposit(vaultA, address(tokenA), alice, bob, 1e18, CHAIN_B);
        _claim(vaultB, _publicValues(address(vaultA), address(tokenA), bob, 1e18, goodNonce, ROOT));
        assertEq(tokenB.balanceOf(bob), 1e18);
    }

    // ------------------------------------------------------------------ R2-16

    /// Revision 2 claim: no liquidity model is added (H-09 stays open by the user's decision).
    /// What the test shows, as a mention only: the paying vault pays from its own balance. With an empty
    /// paying vault a proven claim reverts and stays unclaimed.
    /// Why it matters: the bridge is a lock-and-release swap between two pools, not a mint-and-burn bridge.
    /// Control: after funding the vault the same claim succeeds.
    function test_R2_16_emptyPayingVaultMakesAProvenClaimRevertUntilFunded() public {
        DecimalsToken fresh = new DecimalsToken("Fresh", "FRESH", 18);
        DecimalsToken freshRemote = new DecimalsToken("FreshRemote", "FRR", 18);
        (ZKBridgeVault source, ZKBridgeVault payer) = _deployPair(address(freshRemote), address(fresh));
        freshRemote.mint(alice, 10e18);
        (bytes32 nonce,) = _deposit(source, address(freshRemote), alice, bob, 10e18, CHAIN_B);
        _attest(ROOT);
        bytes memory publicValues = abi.encode(CHAIN_A, CHAIN_B, address(source), address(freshRemote), bob, 10e18, nonce, ROOT);
        bytes memory proof = _prove(publicValues);
        vm.expectRevert(abi.encodeWithSelector(IERC20Errors.ERC20InsufficientBalance.selector, address(payer), 0, 10e18));
        payer.withdraw(proof, publicValues);
        assertFalse(payer.processedNonces(nonce));

        fresh.mint(address(payer), 10e18);
        payer.withdraw(proof, publicValues);
        assertEq(fresh.balanceOf(bob), 10e18);
    }
}
