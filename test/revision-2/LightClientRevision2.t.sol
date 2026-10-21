// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {console} from "forge-std/console.sol";
import {Revision2Fixture} from "./Revision2Fixture.sol";
import {Committee} from "../utils/Committee.sol";
import {LightClientSync} from "../../src/revision-2/LightClientSync.sol";

/// @notice Red-team tests against revision 2 of `LightClientSync`: R2-09, R2-12, and the status of
/// H-01, H-04, H-07, H-08, H-14, H-15. Tests named "fixConfirmed" show that a revision 2 fix holds.
/// All others pass when the attack succeeds.
contract LightClientRevision2Test is Revision2Fixture {
    using Committee for Committee.Set;

    string internal constant INSUFFICIENT = "Insufficient unique valid sync committee signatures";

    // ------------------------------------------------------------------ R2-09

    /// Revision 2 claim: the signed message now holds `attestedHeader`, `period`, and `nextCommitteeRoot`.
    /// What the test shows: the message still has no chain identifier and no contract address. Two light
    /// client deployments that share one committee accept the same signed update, and both rotate to the
    /// same next committee.
    /// Why it matters: a signature meant for one deployment (one chain pair, or a test net, or a fork such as
    /// PulseChain that copied Ethereum's state) installs state in every other deployment with that committee.
    function test_R2_09_oneSignedUpdateIsValidOnEveryLightClientSharingTheCommittee() public {
        LightClientSync deploymentOne = new LightClientSync(honest.root, INITIAL_PERIOD);
        LightClientSync deploymentTwo = new LightClientSync(honest.root, INITIAL_PERIOD);
        Committee.Set memory other = Committee.build("some-other-committee");
        LightClientSync unrelated = new LightClientSync(other.root, INITIAL_PERIOD);

        bytes32 header = keccak256("header meant only for deployment one");
        bytes32 nextRoot = keccak256("next committee root");
        uint32 period = INITIAL_PERIOD + 1;
        Committee.Signed memory signed = _sign(honest, header, period, nextRoot, Committee.THRESHOLD);

        // Control: the signature is not valid for a deployment with a different committee,
        // so acceptance below comes from the shared committee, not from missing checks.
        vm.expectRevert(bytes(INSUFFICIENT));
        unrelated.updateSyncState(period, header, signed.signatures, signed.proofs, nextRoot);
        assertFalse(unrelated.isVerifiedBlockRoot(header));

        deploymentOne.updateSyncState(period, header, signed.signatures, signed.proofs, nextRoot);
        assertTrue(deploymentOne.isVerifiedBlockRoot(header));

        // The same bytes, never meant for deployment two, are accepted there too.
        vm.prank(attacker);
        deploymentTwo.updateSyncState(period, header, signed.signatures, signed.proofs, nextRoot);
        assertTrue(deploymentTwo.isVerifiedBlockRoot(header), "replayed on a second deployment");
        assertEq(deploymentTwo.currentCommitteeRoot(), nextRoot, "second deployment rotated too");
        assertEq(deploymentOne.currentCommitteeRoot(), deploymentTwo.currentCommitteeRoot());
    }

    // ------------------------------------------------------------------ H-01

    /// Revision 2 claim (H-01 fixed): `nextCommitteeRoot` is hashed into the signed message.
    /// What the test shows: the fix holds. Honest signatures copied from the mempool do not install an
    /// attacker committee. The same signatures with the true root still work.
    /// Why it matters: this was the critical hijack in revision 1. It confirms the fix, so a reader does
    /// not look for it again. The residual risk is R2-09 and H-04.
    function test_H01_fixConfirmed_copiedSignaturesCannotInstallAnotherCommittee() public {
        bytes32 header = keccak256("honest header for period 2");
        uint32 period = INITIAL_PERIOD + 1;
        Committee.Set memory honestNext = Committee.build("chainA-next");
        Committee.Set memory evil = Committee.build("attacker");
        Committee.Signed memory signed = _sign(honest, header, period, honestNext.root, Committee.THRESHOLD);

        // Signatures over another message recover unrelated addresses, so the call reverts in the ordering
        // check or the count check. Either way the forged root is refused.
        vm.prank(attacker);
        vm.expectRevert();
        lightClient.updateSyncState(period, header, signed.signatures, signed.proofs, evil.root);
        assertEq(lightClient.currentCommitteeRoot(), honest.root, "committee unchanged");
        assertFalse(lightClient.isVerifiedBlockRoot(header), "header not stored by the failed call");

        // Control: with the signed root the same signatures succeed.
        lightClient.updateSyncState(period, header, signed.signatures, signed.proofs, honestNext.root);
        assertEq(lightClient.currentCommitteeRoot(), honestNext.root);
        assertTrue(lightClient.isVerifiedBlockRoot(header));
    }

    /// Revision 2 claim (H-01 fixed): same as above, for the period field.
    /// What the test shows: signatures for one period fail for another period.
    /// Why it matters: the period is part of the signed message, so it cannot be moved by a relayer.
    function test_H01_fixConfirmed_periodIsBoundToTheSignature() public {
        bytes32 header = keccak256("header");
        Committee.Signed memory signed = _sign(honest, header, INITIAL_PERIOD, bytes32(0), Committee.THRESHOLD);
        vm.expectRevert();
        lightClient.updateSyncState(INITIAL_PERIOD + 1, header, signed.signatures, signed.proofs, bytes32(0));
        lightClient.updateSyncState(INITIAL_PERIOD, header, signed.signatures, signed.proofs, bytes32(0));
        assertTrue(lightClient.isVerifiedBlockRoot(header));
    }

    // ------------------------------------------------------------------ H-04

    /// Revision 2 claim: H-04 is listed as fixed, "offloading" the pairing check to the circuit.
    /// What the test shows: the contract still checks 342 ECDSA signatures against a Merkle root that the
    /// deployer chose. Whoever holds 342 of the 512 keys attests any header, and then installs any next
    /// committee. Ethereum's real committee holds BLS12-381 keys that `ecrecover` cannot check.
    /// Why it matters: the bridge is a 342-of-512 multisignature, not a light client.
    function test_H04_stillAMultisignature_342KeysAttestAnyHeaderAndCaptureTheCommittee() public {
        bytes32 arbitraryHeader = keccak256("any header the key holders like");
        Committee.Signed memory tooFew = _sign(honest, arbitraryHeader, INITIAL_PERIOD, bytes32(0), Committee.THRESHOLD - 1);

        // Control: 341 keys fail.
        vm.expectRevert(bytes(INSUFFICIENT));
        lightClient.updateSyncState(INITIAL_PERIOD, arbitraryHeader, tooFew.signatures, tooFew.proofs, bytes32(0));
        assertFalse(lightClient.isVerifiedBlockRoot(arbitraryHeader));

        Committee.Signed memory enough = _sign(honest, arbitraryHeader, INITIAL_PERIOD, bytes32(0), Committee.THRESHOLD);
        lightClient.updateSyncState(INITIAL_PERIOD, arbitraryHeader, enough.signatures, enough.proofs, bytes32(0));
        assertTrue(lightClient.isVerifiedBlockRoot(arbitraryHeader), "342 keys attest an invented header");

        // The same 342 keys hand the committee to a root of their choosing.
        Committee.Set memory chosen = Committee.build("chosen-by-key-holders");
        Committee.Signed memory rotate = _sign(honest, keccak256("h2"), INITIAL_PERIOD + 1, chosen.root, Committee.THRESHOLD);
        lightClient.updateSyncState(INITIAL_PERIOD + 1, keccak256("h2"), rotate.signatures, rotate.proofs, chosen.root);
        assertEq(lightClient.currentCommitteeRoot(), chosen.root);
    }

    // ------------------------------------------------------------------ H-07

    /// Revision 2 claim (H-07 fixed): every attested root is stored, with no one-root-per-period lock.
    /// What the test shows: two roots in one period are both accepted. The fix holds.
    /// Why it matters: the period lockout from revision 1 is gone. The price is H-08 below.
    function test_H07_fixConfirmed_twoBlockRootsInOnePeriodAreBothAccepted() public {
        bytes32 first = keccak256("first header");
        bytes32 second = keccak256("second header");
        bytes32 never = keccak256("never attested");
        _attest(first);
        _attest(second);
        assertTrue(lightClient.isVerifiedBlockRoot(first));
        assertTrue(lightClient.isVerifiedBlockRoot(second));
        assertFalse(lightClient.isVerifiedBlockRoot(never), "control: only attested roots are stored");
    }

    // ------------------------------------------------------------------ H-08

    /// Revision 2 claim: none. Revision 2 does not mention finality.
    /// What the test shows: the contract stores a root as soon as 342 keys sign it. It has no notion of a
    /// finalized checkpoint, no delay, and no way to remove a root. Two conflicting headers for the same
    /// period (one of them would be orphaned on a real chain) are both verified for ever.
    /// Why it matters: after a reorganization, the destination vault still honors deposits from the orphaned block.
    function test_H08_noFinality_conflictingHeadersAreBothVerifiedForever() public {
        bytes32 canonical = keccak256("canonical header at slot 100");
        bytes32 orphaned = keccak256("orphaned header at slot 100");
        _attest(canonical);
        _attest(orphaned);
        assertTrue(lightClient.isVerifiedBlockRoot(orphaned), "orphaned header is verified");

        // Later periods do not revoke it.
        Committee.Signed memory rotate = _sign(honest, keccak256("later"), INITIAL_PERIOD + 5, honest.root, Committee.THRESHOLD);
        lightClient.updateSyncState(INITIAL_PERIOD + 5, keccak256("later"), rotate.signatures, rotate.proofs, honest.root);
        assertTrue(lightClient.isVerifiedBlockRoot(orphaned), "still verified after later periods");

        // Control: the interface has no finality getter or revocation function.
        (bool hasFinalized,) = address(lightClient).staticcall(abi.encodeWithSignature("isFinalized(bytes32)", orphaned));
        assertFalse(hasFinalized, "no isFinalized function exists");
        (bool canRevoke,) = address(lightClient).call(abi.encodeWithSignature("revoke(bytes32)", orphaned));
        assertFalse(canRevoke, "no revoke function exists");
    }

    // ------------------------------------------------------------------ R2-12

    /// Revision 2 claim: `period` and `currentCommitteeRoot` track the sync committee period.
    /// What the test shows: the contract never ties `period` to the header or to time. With
    /// `nextCommitteeRoot == 0` the committee never rotates, yet it keeps attesting headers for any later
    /// period. The old committee keeps its power for ever, and `currentPeriod` stays at its start value.
    /// Why it matters: compromised or retired keys stay valid. A stale committee cannot be retired by time.
    function test_R2_12_periodIsNotBoundToTheHeaderSoAnOldCommitteeAttestsFarFuturePeriods() public {
        bytes32 farFutureHeader = keccak256("header claimed for period 1000");
        uint32 farFuture = INITIAL_PERIOD + 1000;
        Committee.Signed memory signed = _sign(honest, farFutureHeader, farFuture, bytes32(0), Committee.THRESHOLD);
        lightClient.updateSyncState(farFuture, farFutureHeader, signed.signatures, signed.proofs, bytes32(0));
        assertTrue(lightClient.isVerifiedBlockRoot(farFutureHeader));
        assertEq(lightClient.currentPeriod(), INITIAL_PERIOD, "the period did not advance");
        assertEq(lightClient.currentCommitteeRoot(), honest.root, "the committee did not rotate");

        // Control: a rotation to a non-zero root does advance the period, so the stall comes from the zero root.
        bytes32 rotateHeader = keccak256("rotation header");
        Committee.Signed memory rotate = _sign(honest, rotateHeader, farFuture, honest.root, Committee.THRESHOLD);
        lightClient.updateSyncState(farFuture, rotateHeader, rotate.signatures, rotate.proofs, honest.root);
        assertEq(lightClient.currentPeriod(), farFuture);
    }

    // ------------------------------------------------------------------ H-14

    /// Revision 2 claim (H-14 fixed): `tryRecover` skips a malformed signature instead of reverting.
    /// What the test shows: the fix holds for garbage bytes, a wrong length, and a high-s signature.
    /// Why it matters: one bad entry no longer blocks an update. Control: with only 341 good signatures
    /// the same padded call fails, so the bad entries are skipped and not counted.
    function test_H14_fixConfirmed_malformedSignaturesAreSkipped() public {
        bytes32 header = keccak256("header with noisy signatures");
        Committee.Signed memory good = _sign(honest, header, INITIAL_PERIOD, bytes32(0), Committee.THRESHOLD);
        Committee.Signed memory noisy = _withNoise(good, honest, header);

        lightClient.updateSyncState(INITIAL_PERIOD, header, noisy.signatures, noisy.proofs, bytes32(0));
        assertTrue(lightClient.isVerifiedBlockRoot(header));

        bytes32 other = keccak256("header with too few good signatures");
        Committee.Signed memory few = _sign(honest, other, INITIAL_PERIOD, bytes32(0), Committee.THRESHOLD - 1);
        Committee.Signed memory fewNoisy = _withNoise(few, honest, other);
        vm.expectRevert(bytes(INSUFFICIENT));
        lightClient.updateSyncState(INITIAL_PERIOD, other, fewNoisy.signatures, fewNoisy.proofs, bytes32(0));
    }

    /// @dev Appends three malformed signatures (garbage, short, high-s) to the end of a signed set.
    /// The garbage entries come last, so ordering of the good entries is untouched.
    function _withNoise(Committee.Signed memory base, Committee.Set memory set, bytes32 header)
        private
        pure
        returns (Committee.Signed memory out)
    {
        uint256 count = base.signatures.length;
        out.signatures = new bytes[](count + 3);
        out.proofs = new bytes32[][](count + 3);
        for (uint256 i = 0; i < count; i++) {
            out.signatures[i] = base.signatures[i];
            out.proofs[i] = base.proofs[i];
        }
        bytes memory valid = Committee.signWith(set, 0, _digest(header, INITIAL_PERIOD, bytes32(0)));
        bytes32 r;
        bytes32 s;
        uint8 v = uint8(valid[64]);
        assembly {
            r := mload(add(valid, 32))
            s := mload(add(valid, 64))
        }
        uint256 secp256k1n = 0xFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFEBAAEDCE6AF48A03BBFD25E8CD0364141;
        bytes memory highS = abi.encodePacked(r, bytes32(secp256k1n - uint256(s)), uint8(v == 27 ? 28 : 27));
        out.signatures[count] = hex"deadbeef";
        out.signatures[count + 1] = new bytes(65);
        out.signatures[count + 2] = highS;
        for (uint256 j = 0; j < 3; j++) {
            out.proofs[count + j] = new bytes32[](0);
        }
    }

    // ------------------------------------------------------------------ H-15

    /// Revision 2 claim: "H-15 Gas Hardened", one linear pass.
    /// What the test shows: an update still costs hundreds of thousands to millions of gas, because each
    /// signature needs an `ecrecover` plus a 9-hash Merkle proof, and nobody earns a fee for paying it.
    /// The numbers print to the test output (run with -vv). Control: cost grows with the signature count.
    /// Why it matters: with "0% fee" nobody has a reason to relay.
    function test_H15_updateGasIsLargeAndLinearInSignatures() public {
        bytes32 headerSmall = keccak256("gas header 342");
        bytes32 headerFull = keccak256("gas header 512");
        Committee.Signed memory small = _sign(honest, headerSmall, INITIAL_PERIOD, bytes32(0), 342);
        Committee.Signed memory full = _sign(honest, headerFull, INITIAL_PERIOD, bytes32(0), 512);

        uint256 before = gasleft();
        lightClient.updateSyncState(INITIAL_PERIOD, headerSmall, small.signatures, small.proofs, bytes32(0));
        uint256 gas342 = before - gasleft();

        before = gasleft();
        lightClient.updateSyncState(INITIAL_PERIOD, headerFull, full.signatures, full.proofs, bytes32(0));
        uint256 gas512 = before - gasleft();

        console.log("revision 2 update gas, 342 signatures:", gas342);
        console.log("revision 2 update gas, 512 signatures:", gas512);
        assertGt(gas342, 1_000_000, "342 signatures cost more than one million gas");
        assertGt(gas512, gas342, "control: more signatures cost more gas");
        assertGt(gas512 - gas342, 400_000, "control: the cost is per signature, not fixed");
    }
}
