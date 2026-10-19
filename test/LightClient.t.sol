// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {console} from "forge-std/console.sol";
import {BridgeFixture} from "./utils/BridgeFixture.sol";
import {Committee} from "./utils/Committee.sol";
import {LightClientSync} from "../src/LightClientSync.sol";

/// @notice Red-team tests against `LightClientSync`: H-01, H-04, H-07, H-14, H-15.
/// Every test passes when the attack succeeds.
contract LightClientTest is BridgeFixture {
    using Committee for Committee.Set;

    // ------------------------------------------------------------------ H-01

    /// Specification claim: "Permissionlessly update the latest chain state using Sync Committee
    /// signatures", with a "strict 2/3 supermajority rule". It implies the committee controls who
    /// takes over next.
    /// What the test shows: `nextCommitteeRoot` is not in the signed digest. An attacker replays the
    /// honest signatures with an attacker committee root, installs that committee, and then the
    /// attacker committee alone attests any block root.
    function test_H01_committeeHijackThroughUnsignedNextRoot() public {
        bytes32 headerX = keccak256("honest header for period 2");
        uint32 period = INITIAL_PERIOD + 1;
        Committee.Set memory honestNext = Committee.build("chainA-next");
        Committee.Set memory evil = Committee.build("attacker");
        Committee.Signed memory honestSigned = honest.attest(headerX, period, Committee.THRESHOLD);

        // Control 1: before the attack the attacker committee has no power.
        bytes32 forgedRoot = keccak256("forged block root with a forged deposit receipt");
        Committee.Signed memory forgedSigned = evil.attest(forgedRoot, period + 1, Committee.THRESHOLD);
        vm.expectRevert("Insufficient unique valid sync committee signatures");
        lightClient.updateSyncState(period + 1, forgedRoot, forgedSigned.signatures, forgedSigned.proofs, evil.root);
        assertFalse(lightClient.isVerifiedBlockRoot(forgedRoot));

        // The attacker copies the honest relayer's signatures and proofs from the mempool,
        // but names their own committee as the next committee.
        vm.prank(attacker);
        lightClient.updateSyncState(period, headerX, honestSigned.signatures, honestSigned.proofs, evil.root);
        assertEq(lightClient.currentCommitteeRoot(), evil.root, "attacker committee is installed");

        // The honest relayer's original transaction now reverts, because the period is finalized.
        vm.expectRevert("Period state already finalized");
        lightClient.updateSyncState(period, headerX, honestSigned.signatures, honestSigned.proofs, honestNext.root);

        // The attacker committee alone now attests an arbitrary block root.
        lightClient.updateSyncState(period + 1, forgedRoot, forgedSigned.signatures, forgedSigned.proofs, evil.root);
        assertTrue(lightClient.isVerifiedBlockRoot(forgedRoot), "forged root is accepted");

        // Control 2: the honest committee can no longer attest anything.
        bytes32 laterHeader = keccak256("honest header for period 4");
        Committee.Signed memory laterSigned = honest.attest(laterHeader, period + 2, Committee.THRESHOLD);
        vm.expectRevert("Insufficient unique valid sync committee signatures");
        lightClient.updateSyncState(
            period + 2, laterHeader, laterSigned.signatures, laterSigned.proofs, honestNext.root
        );
        assertFalse(lightClient.isVerifiedBlockRoot(laterHeader));
    }

    // ------------------------------------------------------------------ H-04

    /// Specification claim: an "adminless", "user-validated" bridge that follows Ethereum's sync committee.
    /// What the test shows: the contract only recovers ECDSA addresses, so the deployer must choose the
    /// 512 "committee" keys. Whoever holds 342 of them finalizes any header. That is a trusted
    /// 342-of-512 multisignature (the real committee uses BLS12-381 keys that `ecrecover` cannot check).
    function test_H04_chosenEcdsaCommitteeIsAMultisignature() public {
        bytes32 arbitraryHeader = keccak256("any header the key holders like");
        Committee.Signed memory signed = honest.attest(arbitraryHeader, INITIAL_PERIOD, Committee.THRESHOLD);

        // Control: 341 keys are not enough.
        Committee.Signed memory tooFew = honest.attest(arbitraryHeader, INITIAL_PERIOD, Committee.THRESHOLD - 1);
        vm.expectRevert("Insufficient unique valid sync committee signatures");
        lightClient.updateSyncState(INITIAL_PERIOD, arbitraryHeader, tooFew.signatures, tooFew.proofs, bytes32(0));
        assertFalse(lightClient.isVerifiedBlockRoot(arbitraryHeader));

        // 342 keys from the deployer's chosen set finalize any header.
        lightClient.updateSyncState(INITIAL_PERIOD, arbitraryHeader, signed.signatures, signed.proofs, bytes32(0));
        assertTrue(lightClient.isVerifiedBlockRoot(arbitraryHeader));
    }

    // ------------------------------------------------------------------ H-07

    /// Specification claim: a block root that the committee attests can be used to withdraw.
    /// What the test shows: `finalizedPeriods[period]` allows one header per period. After the first
    /// header X is accepted, a second valid header Y for the same period is refused. A deposit that
    /// only Y contains cannot be withdrawn until a later period is finalized.
    function test_H07_secondHeaderInSamePeriodIsRejected() public {
        uint32 period = INITIAL_PERIOD + 1;
        bytes32 headerX = keccak256("early header X");
        bytes32 headerY = keccak256("later header Y that contains the deposit");

        // The deposit lands after X, so only Y can prove it.
        token.mint(alice, 100e18);
        bytes32 nonce = _deposit(vaultA, address(token), alice, bob, 100e18, CHAIN_B);

        // Anyone (here: the attacker) submits the earliest signed header of the period.
        Committee.Signed memory signedX = honest.attest(headerX, period, Committee.THRESHOLD);
        vm.prank(attacker);
        lightClient.updateSyncState(period, headerX, signedX.signatures, signedX.proofs, honest.root);

        // Y has a valid supermajority, and the committee did sign it, but the period is locked.
        Committee.Signed memory signedY = honest.attest(headerY, period, Committee.THRESHOLD);
        vm.expectRevert("Period state already finalized");
        lightClient.updateSyncState(period, headerY, signedY.signatures, signedY.proofs, honest.root);
        assertFalse(lightClient.isVerifiedBlockRoot(headerY));

        // The withdrawal is stuck.
        bytes memory publicInputsBytes = abi.encode(_inputs(address(token), bob, 100e18, nonce, headerY));
        bytes memory proof = _prove(publicInputsBytes);
        vm.expectRevert("Block root not yet confirmed by consensus layer");
        vaultB.withdraw(proof, publicInputsBytes);

        // Control: the same header Y in the next period is accepted, and then the withdrawal works.
        // The delay, not an invalid signature, is what blocks the user.
        Committee.Signed memory signedYNext = honest.attest(headerY, period + 1, Committee.THRESHOLD);
        lightClient.updateSyncState(period + 1, headerY, signedYNext.signatures, signedYNext.proofs, honest.root);
        vaultB.withdraw(proof, publicInputsBytes);
        assertEq(token.balanceOf(bob), 100e18);
    }

    // ------------------------------------------------------------------ H-14

    /// Specification claim: `if (validatorAddress == address(0)) continue;` skips unusable signatures.
    /// What the test shows: OpenZeppelin 5 `recover` reverts on a malformed signature and never returns
    /// the zero address, so the branch is dead code. One bad signature fails an update that carries
    /// 400 valid signatures (58 more than needed).
    function test_H14_oneMalformedSignatureRevertsWholeUpdate() public {
        bytes32 header = keccak256("header");
        uint256 validCount = 400;
        Committee.Signed memory clean = honest.attest(header, INITIAL_PERIOD, validCount);

        // Bad signature 1: 64 bytes (compact form) appended to the arrays.
        Committee.Signed memory withShort = _withExtraEntry(clean, new bytes(64));
        vm.expectRevert(abi.encodeWithSignature("ECDSAInvalidSignatureLength(uint256)", 64));
        lightClient.updateSyncState(INITIAL_PERIOD, header, withShort.signatures, withShort.proofs, bytes32(0));

        // Bad signature 2: a valid signature with high-s (the malleable twin).
        bytes memory highS = _highSTwin(clean.signatures[0]);
        Committee.Signed memory withHighS = _withExtraEntry(clean, highS);
        vm.expectRevert(abi.encodeWithSignature("ECDSAInvalidSignatureS(bytes32)", _s(highS)));
        lightClient.updateSyncState(INITIAL_PERIOD, header, withHighS.signatures, withHighS.proofs, bytes32(0));
        assertFalse(lightClient.isVerifiedBlockRoot(header));

        // Control: the same 400 valid signatures without the bad entry are accepted.
        lightClient.updateSyncState(INITIAL_PERIOD, header, clean.signatures, clean.proofs, bytes32(0));
        assertTrue(lightClient.isVerifiedBlockRoot(header));
    }

    // ------------------------------------------------------------------ H-15

    /// Specification claim: "0% fee" and a "permissionless" update, with gas "optimization" by sorting.
    /// What the test shows: an update costs over 3 million gas of execution for 342 signatures and
    /// over 5 million for 512, before about 2 to 3 million more for calldata. Nobody earns a fee for paying it.
    function test_H15_updateGasIsLargeAndUnpaid() public {
        (uint256 executionGas342, uint256 calldataGas342) =
            _measureUpdate(keccak256("header 342"), INITIAL_PERIOD, 342);
        (uint256 executionGas512, uint256 calldataGas512) =
            _measureUpdate(keccak256("header 512"), INITIAL_PERIOD + 1, 512);

        console.log("H-15 342 signatures: execution gas", executionGas342);
        console.log("H-15 342 signatures: calldata gas ", calldataGas342);
        console.log("H-15 342 signatures: total gas    ", executionGas342 + calldataGas342 + 21_000);
        console.log("H-15 512 signatures: execution gas", executionGas512);
        console.log("H-15 512 signatures: calldata gas ", calldataGas512);
        console.log("H-15 512 signatures: total gas    ", executionGas512 + calldataGas512 + 21_000);

        // The precompile alone costs 3,000 gas per recovery (1,026,000 for 342). Copying the signatures
        // out of calldata, nine-hash Merkle proofs, and the strict ordering checks add the rest.
        // Thresholds are set just under the measured values (3.44 million and 5.85 million).
        assertGt(executionGas342, 3_000_000, "342 signature update execution gas");
        assertGt(executionGas512, 5_000_000, "512 signature update execution gas");
        // Control: more signatures cost more, so the cost comes from the signature loop.
        assertGt(executionGas512, executionGas342);
    }

    // ------------------------------------------------------------------ helpers

    /// @dev Returns execution gas of the update and the standard calldata gas of the transaction.
    function _measureUpdate(bytes32 header, uint32 period, uint256 count)
        internal
        returns (uint256 executionGas, uint256 calldataGas)
    {
        Committee.Signed memory signed = honest.attest(header, period, count);
        bytes memory callData = abi.encodeCall(
            LightClientSync.updateSyncState, (period, header, signed.signatures, signed.proofs, honest.root)
        );
        for (uint256 i = 0; i < callData.length; i++) {
            calldataGas += callData[i] == 0 ? 4 : 16;
        }
        uint256 gasBefore = gasleft();
        lightClient.updateSyncState(period, header, signed.signatures, signed.proofs, honest.root);
        executionGas = gasBefore - gasleft();
    }

    function _withExtraEntry(Committee.Signed memory base, bytes memory extraSignature)
        internal
        pure
        returns (Committee.Signed memory out)
    {
        uint256 length = base.signatures.length;
        out.signatures = new bytes[](length + 1);
        out.proofs = new bytes32[][](length + 1);
        for (uint256 i = 0; i < length; i++) {
            out.signatures[i] = base.signatures[i];
            out.proofs[i] = base.proofs[i];
        }
        out.signatures[length] = extraSignature;
        out.proofs[length] = new bytes32[](0);
    }

    function _s(bytes memory signature) internal pure returns (bytes32 s) {
        assembly {
            s := mload(add(signature, 0x40))
        }
    }

    /// @dev Flips (s, v) to the equivalent high-s signature that OpenZeppelin refuses.
    function _highSTwin(bytes memory signature) internal pure returns (bytes memory) {
        bytes32 r;
        uint8 v = uint8(signature[64]);
        assembly {
            r := mload(add(signature, 0x20))
        }
        uint256 secp256k1n = 0xFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFEBAAEDCE6AF48A03BBFD25E8CD0364141;
        return abi.encodePacked(r, bytes32(secp256k1n - uint256(_s(signature))), v == 27 ? uint8(28) : uint8(27));
    }
}
