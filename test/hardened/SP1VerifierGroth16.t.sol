// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Test} from "forge-std/Test.sol";
import {ISP1Verifier as BridgeISP1Verifier} from "../../src/hardened/ISP1Verifier.sol";
import {BeaconLightClient} from "../../src/hardened/BeaconLightClient.sol";
import {SP1Verifier} from "../../src/hardened/vendor/sp1-contracts/v6.1.0/SP1VerifierGroth16.sol";
import {SP1Verifier as SP1VerifierV600} from "./vendor-sp1-contracts-v6.0.0/v6.0.0/SP1VerifierGroth16.sol";

/// @notice Tests of the vendored SP1 Groth16 verifier (circuit v6.1.0, the circuit of sp1-sdk 6.8.x).
/// @dev The release ships no proof for circuit v6.1.0. The tests of the v6.1.0 verifier use a proof of the current
/// light-client program that the testnet backend made on a GPU worker (`test/hardened/fixtures/sp1-proof-sepolia-update.json`,
/// a real Sepolia update, posted to the light client on PulseChain testnet v4). The release's own proof is for circuit
/// v6.0.0, so its acceptance and tamper tests run against the v6.0.0 verifier (test use only).
contract SP1VerifierGroth16Test is Test {
    // The proof of release v6.1.1 (contracts/test/SP1VerifierGroth16V6.sol), valid for circuit v6.0.0.
    bytes32 internal constant PROGRAM_VKEY = 0x004a55ed3c7a07d0233a027278a8b7ff8681ffbd5d1ec4795c18966f6e693090;
    bytes internal constant PUBLIC_VALUES =
        hex"00000000000000000000000000000000000000000000000000000000000000140000000000000000000000000000000000000000000000000000000000001a6d0000000000000000000000000000000000000000000000000000000000002ac2";
    bytes internal constant PROOF_BYTES =
        hex"0e78f4db0000000000000000000000000000000000000000000000000000000000000000008cd56e10c2fe24795cff1e1d1f40d3a324528d315674da45d26afb376e867000000000000000000000000000000000000000000000000000000000000000001e2e0ff3f06238b1a0f13c92e9e6dc64bd103006ab92764445220fecc884ac6f2c7c5c82d3914e85262103f1e262b35d8d3c1e513672ef8482861f21241a8618031f773e85f625d0d3dd3f24b5dcc8489de1b12f38921c7fe55bc2b6d9abc6e716ed0979ff2668a4d50b2f2af2d0513a008e21823a93a19ce53287206191b5e71206f6bd7829711609fa90159683133d43d5e7ca12fb42d99bfd84d0961c02282dea228329dc9f774d214eb74f5c583e63035a9e6b7aae3b5c1f9e6b8929deca2d494130d03ce620238c428eb75c605aff699b779d51b21e93065ffda48c7e5b0c188f0e786e474cbf2263fb9fe2b9260fb4b08332b7ab331fc3f4f9b247a393";

    // Circuit v6.1.0: the constants that sp1-sdk 6.8.1 expects (see src/hardened/vendor/sp1-contracts/README.md).
    bytes32 internal constant EXPECTED_VERIFIER_HASH =
        0x4388a21c687fdd5f218d7e3d13190cac4c5355818d3605fd5fb811df468ee696;
    bytes32 internal constant EXPECTED_VK_ROOT = 0x002f850ee998974d6cc00e50cd0814b098c05bfade466d28573240d057f25352;

    // Where our own proof for circuit v6.1.0 lives. The proof comes from the backend's GPU worker (sp1-sdk 6.8.1,
    // Groth16) for the light-client program with the key below, on a real Sepolia update.
    string internal constant OWN_PROOF_FILE = "test/hardened/fixtures/sp1-proof-sepolia-update.json";
    // The key of `light-client/program-keys.json` (the current light-client program; the deployed testnet light clients
    // hold it). `prover/tests/remote_prover.rs` checks that the fixture key equals the file.
    bytes32 internal constant LIGHT_CLIENT_PROGRAM_VKEY =
        0x000854b9b72ab6bfca191c95cb131971a17a458c2faebdd216d9dbe874eb4730;
    // The genesis validators root of Sepolia. The proof binds its output to this chain.
    bytes32 internal constant SEPOLIA_GENESIS_VALIDATORS_ROOT =
        0xd8ea171f3c94aea21ebc42a1ed61052acf3f9209c00e4efbaaddac09ed9b8078;

    SP1Verifier internal verifier;
    SP1VerifierV600 internal verifierV600;

    function setUp() public {
        verifier = new SP1Verifier();
        verifierV600 = new SP1VerifierV600();
    }

    /// @dev A copy of `PROOF_BYTES` with the byte at `index` changed.
    function _proofWithByteFlipped(uint256 index) internal pure returns (bytes memory proof) {
        proof = PROOF_BYTES;
        proof[index] = bytes1(uint8(proof[index]) ^ 0x01);
    }

    /// @dev `PROOF_BYTES` with its first four bytes (the verifier selector) replaced.
    function _proofWithSelector(bytes4 selector) internal pure returns (bytes memory proof) {
        proof = PROOF_BYTES;
        for (uint256 i = 0; i < 4; i++) {
            proof[i] = selector[i];
        }
    }

    // ------------------------------------------------------------------ the verifier of circuit v6.1.0

    /// Claim: the vendored verifier carries the hash, the key root and the version that sp1-sdk 6.8.1 expects.
    /// Why it matters: a verifier of another circuit refuses every proof of the prover. The values are the SHA-256 of
    /// groth16_vk.bin and VK_ROOT_BYTES of the crate sp1-verifier 6.8.1; the README of the vendor directory shows how.
    function test_vendoredVerifierMatchesTheCircuitOfSdk681() public view {
        assertEq(verifier.VERIFIER_HASH(), EXPECTED_VERIFIER_HASH);
        assertEq(verifier.VK_ROOT(), EXPECTED_VK_ROOT);
        assertEq(verifier.VERSION(), "v6.1.0");
        assertEq(
            bytes4(verifier.VERIFIER_HASH()), bytes4(0x4388a21c), "the selector that the SDK puts in front of a proof"
        );
    }

    /// Claim: the runtime code hash of the vendored verifier, built with the settings of this repository, is the value
    /// that docs/sp1-version-policy.md gives for `verifierCodeHash`.
    /// Why it matters: the deploy script refuses a verifier whose code hash differs. A change of compiler settings or of the
    /// vendored files moves this hash, and this test then fails until the document and the deploy config follow.
    function test_codeHashIsTheDocumentedVerifierCodeHash() public view {
        assertEq(address(verifier).codehash, 0xe5878a94678c40ab6b1bebc391f4d4c12f44bedb8291921b5c0f5a251ec6e84b);
    }

    /// Claim: the light client and the fork registry call the vendored verifier through the bridge's own interface.
    /// A proof with the selector of circuit v6.0.0 is refused with the selector error.
    /// Why it matters: this is the exact call `verifier.verifyProof(programVKey, publicValues, proof)` of the contracts.
    function test_bridgeInterfaceReachesTheVendoredVerifier() public {
        vm.expectRevert(
            abi.encodeWithSelector(SP1Verifier.WrongVerifierSelector.selector, bytes4(0x0e78f4db), bytes4(0x4388a21c))
        );
        BridgeISP1Verifier(address(verifier)).verifyProof(PROGRAM_VKEY, PUBLIC_VALUES, PROOF_BYTES);
    }

    /// Claim: a proof of circuit v6.0.0 never passes the v6.1.0 verifier, even when only the selector is swapped.
    /// The key root inside the proof is the v6.0.0 root, so the verifier refuses it.
    function test_proofOfAnotherCircuitIsRefusedEvenWithTheRightSelector() public {
        bytes memory relabelled = _proofWithSelector(bytes4(0x4388a21c));
        vm.expectRevert(SP1Verifier.InvalidVkRoot.selector);
        verifier.verifyProof(PROGRAM_VKEY, PUBLIC_VALUES, relabelled);
    }

    /// Claim: with the right selector and the right key root, a non-zero exit code is refused.
    function test_nonZeroExitCodeIsRefused() public {
        bytes memory proof =
            abi.encodePacked(bytes4(0x4388a21c), uint256(1), EXPECTED_VK_ROOT, uint256(0), new uint256[](8));
        vm.expectRevert(SP1Verifier.InvalidExitCode.selector);
        verifier.verifyProof(PROGRAM_VKEY, PUBLIC_VALUES, proof);
    }

    /// Claim: with the right selector, exit code and key root, a proof of zeros does not verify.
    /// Why it matters: the pairing check is the last gate, and it must refuse an empty proof.
    function test_proofOfZerosIsRefused() public {
        bytes memory proof =
            abi.encodePacked(bytes4(0x4388a21c), uint256(0), EXPECTED_VK_ROOT, uint256(0), new uint256[](8));
        vm.expectRevert();
        verifier.verifyProof(PROGRAM_VKEY, PUBLIC_VALUES, proof);
    }

    /// Claim: a proof shorter than the selector reverts instead of verifying.
    function test_proofShorterThanTheSelectorIsRefused() public {
        vm.expectRevert();
        verifier.verifyProof(PROGRAM_VKEY, PUBLIC_VALUES, hex"4388a2");
    }

    // ------------------------------------------------------------------ our own real proof (circuit v6.1.0)

    /// @dev The program key, the public values and the proof of the fixture of our own prover.
    function _ownProof() internal view returns (bytes32 programVKey, bytes memory publicValues, bytes memory proof) {
        string memory json = vm.readFile(OWN_PROOF_FILE);
        programVKey = vm.parseJsonBytes32(json, ".programVKey");
        publicValues = vm.parseJsonBytes(json, ".publicValues");
        proof = vm.parseJsonBytes(json, ".proof");
    }

    /// Claim: the fixture holds a proof of the current light-client program of this repository, for a real Sepolia
    /// update. The key is the key of `light-client/program-keys.json`, the proof starts with the selector of circuit
    /// v6.1.0, and the public values decode to a head that moves forward on the chain with the Sepolia genesis validators
    /// root.
    /// Why it matters: the acceptance test below proves something about the bridge only if the fixture is this program on
    /// this chain. A proof of some other program would pass the verifier just as well.
    function test_ownProofIsTheCurrentLightClientProgramOnASepoliaUpdate() public view {
        (bytes32 programVKey, bytes memory publicValues, bytes memory proof) = _ownProof();
        assertEq(programVKey, LIGHT_CLIENT_PROGRAM_VKEY);
        assertEq(bytes4(proof), bytes4(EXPECTED_VERIFIER_HASH), "the selector of circuit v6.1.0");
        BeaconLightClient.LightClientOutput memory output =
            abi.decode(publicValues, (BeaconLightClient.LightClientOutput));
        assertEq(output.genesisValidatorsRoot, SEPOLIA_GENESIS_VALIDATORS_ROOT);
        assertGt(output.newHeadSlot, output.previousHeadSlot, "the head moves forward");
        assertEq(publicValues.length, 11 * 32, "the length that BeaconLightClient.update demands");
    }

    /// Claim: the v6.1.0 verifier accepts the real proof of our own prover, and the check costs less than 400,000 gas.
    /// Why it matters: this is the first accepting test for circuit v6.1.0. It shows that the verifier that we vendored
    /// is the verifier of the circuit that `sp1-sdk` 6.8.1 proves with. The gas bound guards the cost of every `update`.
    function test_ownProofIsAcceptedByTheVendoredVerifier() public {
        (bytes32 programVKey, bytes memory publicValues, bytes memory proof) = _ownProof();
        uint256 gasBefore = gasleft();
        verifier.verifyProof(programVKey, publicValues, proof);
        uint256 gasUsed = gasBefore - gasleft();
        emit log_named_uint("gas of verifyProof for the real proof", gasUsed);
        assertLt(gasUsed, 400_000);
    }

    /// Claim: the call that `BeaconLightClient.update` makes, through the interface of the bridge, accepts the proof.
    function test_ownProofIsAcceptedThroughTheBridgeInterface() public view {
        (bytes32 programVKey, bytes memory publicValues, bytes memory proof) = _ownProof();
        BridgeISP1Verifier(address(verifier)).verifyProof(programVKey, publicValues, proof);
    }

    /// Claim: one changed bit in any word of the public values makes the verifier refuse the proof.
    /// Why it matters: the light client acts on the public values. If the proof did not bind every word, a caller could
    /// keep the proof and change the new head, the committee hash or the execution block hash.
    function test_ownProofWithTamperedPublicValuesIsRefused() public {
        (bytes32 programVKey, bytes memory publicValues, bytes memory proof) = _ownProof();
        for (uint256 word = 0; word < 11; word++) {
            bytes memory tampered = bytes.concat(publicValues);
            uint256 index = word * 32 + 31;
            tampered[index] = bytes1(uint8(tampered[index]) ^ 0x01);
            vm.expectRevert();
            verifier.verifyProof(programVKey, tampered, proof);
        }
    }

    /// Claim: one changed bit in the nonce or in any of the eight proof words makes the verifier refuse the proof.
    /// Layout of the proof: 4 selector, 32 exit code, 32 key root, 32 nonce, 256 proof.
    function test_ownProofWithTamperedProofBytesIsRefused() public {
        (bytes32 programVKey, bytes memory publicValues, bytes memory proof) = _ownProof();
        for (uint256 word = 0; word < 9; word++) {
            bytes memory tampered = bytes.concat(proof);
            uint256 index = 4 + 64 + word * 32 + 31;
            tampered[index] = bytes1(uint8(tampered[index]) ^ 0x01);
            vm.expectRevert();
            // A proof word that is not a point of the curve burns all gas of the call. The cap leaves gas for the next round.
            verifier.verifyProof{gas: 2_000_000}(programVKey, publicValues, tampered);
        }
    }

    /// Claim: the proof does not pass under another program key, and a changed selector, exit code or key root is
    /// refused with the matching error.
    /// Why it matters: the program key keeps a proof of the fork observation program from passing as a light-client proof.
    function test_ownProofUnderAnotherKeyOrWithChangedHeaderIsRefused() public {
        (bytes32 programVKey, bytes memory publicValues, bytes memory proof) = _ownProof();
        vm.expectRevert();
        verifier.verifyProof(bytes32(uint256(programVKey) ^ 1), publicValues, proof);

        bytes memory wrongSelector = bytes.concat(proof);
        wrongSelector[0] = bytes1(uint8(wrongSelector[0]) ^ 0x01);
        vm.expectRevert(
            abi.encodeWithSelector(
                SP1Verifier.WrongVerifierSelector.selector, bytes4(wrongSelector), bytes4(EXPECTED_VERIFIER_HASH)
            )
        );
        verifier.verifyProof(programVKey, publicValues, wrongSelector);

        bytes memory wrongExitCode = bytes.concat(proof);
        wrongExitCode[4 + 31] = bytes1(uint8(wrongExitCode[4 + 31]) ^ 0x01);
        vm.expectRevert(SP1Verifier.InvalidExitCode.selector);
        verifier.verifyProof(programVKey, publicValues, wrongExitCode);

        bytes memory wrongKeyRoot = bytes.concat(proof);
        wrongKeyRoot[4 + 32 + 31] = bytes1(uint8(wrongKeyRoot[4 + 32 + 31]) ^ 0x01);
        vm.expectRevert(SP1Verifier.InvalidVkRoot.selector);
        verifier.verifyProof(programVKey, publicValues, wrongKeyRoot);
    }

    // ------------------------------------------------------------------ the release proof (circuit v6.0.0, test use only)

    /// Control: the real proof of release v6.1.1 verifies on the verifier of its own circuit.
    /// Why it matters: every refusal below means something only because this call succeeds.
    function test_realProofIsAccepted() public view {
        verifierV600.verifyProof(PROGRAM_VKEY, PUBLIC_VALUES, PROOF_BYTES);
    }

    /// Claim: changing one bit of any proof byte after the selector, exit code and key root makes the verifier refuse.
    /// The checked bytes: the nonce, and the eight words of the proof itself.
    function test_realProofWithOneBitFlippedIsRefused() public {
        // Layout: 4 selector, 32 exit code, 32 key root, 32 nonce, 256 proof.
        uint256[5] memory indexes = [uint256(4 + 64 + 31), 4 + 96, 4 + 96 + 31, 4 + 96 + 128, 4 + 96 + 255];
        for (uint256 i = 0; i < indexes.length; i++) {
            bytes memory tampered = _proofWithByteFlipped(indexes[i]);
            vm.expectRevert();
            verifierV600.verifyProof(PROGRAM_VKEY, PUBLIC_VALUES, tampered);
        }
    }

    /// Claim: changing one bit of the public values makes the verifier refuse the proof.
    /// Why it matters: the public values are what the contracts act on; the proof must bind them.
    function test_realProofWithTamperedPublicValuesIsRefused() public {
        bytes memory tampered = PUBLIC_VALUES;
        tampered[tampered.length - 1] = bytes1(uint8(tampered[tampered.length - 1]) ^ 0x01);
        vm.expectRevert();
        verifierV600.verifyProof(PROGRAM_VKEY, tampered, PROOF_BYTES);
    }

    /// Claim: the proof does not verify under the key of another program.
    /// Why it matters: this is what keeps a proof of the fork observation program from passing as a light client proof.
    function test_realProofUnderAnotherProgramKeyIsRefused() public {
        vm.expectRevert();
        verifierV600.verifyProof(bytes32(uint256(PROGRAM_VKEY) ^ 1), PUBLIC_VALUES, PROOF_BYTES);
    }

    /// Claim: a changed selector, exit code or key root in the real proof is refused with the matching error.
    function test_realProofWithChangedHeaderFieldsIsRefused() public {
        vm.expectRevert(
            abi.encodeWithSelector(
                SP1VerifierV600.WrongVerifierSelector.selector, bytes4(0x4388a21c), bytes4(0x0e78f4db)
            )
        );
        verifierV600.verifyProof(PROGRAM_VKEY, PUBLIC_VALUES, _proofWithSelector(bytes4(0x4388a21c)));

        vm.expectRevert(SP1VerifierV600.InvalidExitCode.selector);
        verifierV600.verifyProof(PROGRAM_VKEY, PUBLIC_VALUES, _proofWithByteFlipped(4 + 31));

        vm.expectRevert(SP1VerifierV600.InvalidVkRoot.selector);
        verifierV600.verifyProof(PROGRAM_VKEY, PUBLIC_VALUES, _proofWithByteFlipped(4 + 32 + 31));
    }
}
