// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {AmbMessageCodec} from "../../src/hardened/AmbMessageCodec.sol";
import {SSZ} from "../../src/hardened/SSZ.sol";

/// @notice Calls the internal functions of the codec and of the tree library from a contract of their own, so that a
/// test can limit their gas and see their reverts.
contract CodecHarness {
    function decode(bytes memory encoded) external view returns (AmbMessageCodec.Header memory, bytes memory) {
        return AmbMessageCodec.decode(encoded);
    }

    /// @dev Decodes and returns only the length of the call data, so that the work after the copy is small.
    function decodeLength(bytes calldata encoded) external view returns (uint256) {
        (, bytes memory data) = AmbMessageCodec.decode(encoded);
        return data.length;
    }

    /// @dev The hash of the call data that the decoder copied.
    function decodeDigest(bytes calldata encoded) external view returns (bytes32) {
        (, bytes memory data) = AmbMessageCodec.decode(encoded);
        return keccak256(data);
    }

    function depthOf(uint256 generalizedIndex) external pure returns (uint256) {
        return SSZ.depthOf(generalizedIndex);
    }
}

/// @notice The refusals of the message codec and of the tree library that no proof reaches: a message whose header
/// promises more chain identifier bytes than it holds, a copy of the call data that runs out of gas, and an index of zero.
contract AmbMessageCodecGapsTest is Test {
    CodecHarness internal harness;

    function setUp() public {
        harness = new CodecHarness();
    }

    /// @dev A fixed header of 79 bytes with the given chain identifier lengths and no more bytes.
    function _headerOnly(uint8 sourceLength, uint8 destinationLength) internal pure returns (bytes memory) {
        return abi.encodePacked(
            bytes32(uint256(0x00050000) << 224),
            address(0x1111),
            address(0x2222),
            uint32(100_000),
            sourceLength,
            destinationLength,
            uint8(0)
        );
    }

    // ================================================================ truncated chain identifiers

    /// Claim: a message that ends inside its chain identifiers is refused. Shows: a header that promises 1 + 2 identifier
    /// bytes with only 2 present reverts with `MalformedMessage`, and the same header with all 3 bytes decodes with the
    /// identifiers and an empty call data. Matters: the call data starts after the identifiers, so a short message must
    /// never be read with a start past its end.
    function test_decode_refusesAMessageThatEndsInsideTheChainIdentifiers() public {
        bytes memory truncated = bytes.concat(_headerOnly(1, 2), hex"0102");
        vm.expectRevert(AmbMessageCodec.MalformedMessage.selector);
        harness.decode(truncated);

        (AmbMessageCodec.Header memory header, bytes memory data) = harness.decode(bytes.concat(_headerOnly(1, 2), hex"010203"));
        assertEq(header.sourceChainId, 1);
        assertEq(header.destinationChainId, 0x0203);
        assertEq(data.length, 0);
    }

    // ================================================================ the copy of the call data

    /// Claim: when the copy of the call data fails for lack of gas, the decoder reverts with `MalformedMessage` and does
    /// not return zeros. Shows: a decode of two hundred thousand bytes, with the gas lowered until the identity precompile cannot
    /// pay for the copy, reverts with the exact error for some gas limit, and the same message decodes in full with
    /// plenty of gas, with the call data intact. Matters: an ignored failure would hand the bridge a message whose call
    /// data is all zeros, and the bridge would call its target with that.
    function test_decode_revertsWhenTheCopyOfTheCallDataRunsOutOfGas() public {
        bytes memory data = new bytes(200_000);
        data[0] = 0xaa;
        data[199_999] = 0xbb;
        bytes memory message = bytes.concat(_headerOnly(1, 1), hex"0102", data);

        assertEq(harness.decodeLength(message), 200_000, "the call data is whole");
        assertEq(harness.decodeDigest(message), keccak256(data), "the call data is intact");

        bytes memory call = abi.encodeCall(CodecHarness.decodeLength, (message));
        // The least gas that lets the decode succeed, by bisection. Just below it, the call fails inside the decode.
        uint256 low = 0;
        uint256 high = 2_000_000;
        while (high - low > 1) {
            uint256 middle = (low + high) / 2;
            (bool succeeds,) = address(harness).call{gas: middle}(call);
            if (succeeds) high = middle;
            else low = middle;
        }

        // Below the least gas the failure has two shapes. Running out of gas anywhere leaves no revert data. A copy that
        // the precompile cannot pay is a failed call inside the decode, which leaves 1/64 of the gas for the revert.
        bool refusedByTheCodec;
        for (uint256 reduction = 1; reduction < 20_000 && !refusedByTheCodec; reduction += 250) {
            (bool ok, bytes memory returned) = address(harness).call{gas: high - reduction}(call);
            assertFalse(ok, "less gas than the least that succeeds fails");
            refusedByTheCodec =
                keccak256(returned) == keccak256(abi.encodeWithSelector(AmbMessageCodec.MalformedMessage.selector));
        }
        assertTrue(refusedByTheCodec, "a copy that cannot be paid reverts with the codec error");
    }

    // ================================================================ the tree library

    /// Claim: the depth of generalized index zero is refused, and the depth of one is zero. Shows: the exact error for 0,
    /// and 0, 1 and 4 for the indices 1, 2 and 16. Matters: index zero names no node, and a loop on it would never end.
    function test_depthOf_refusesZero() public {
        vm.expectRevert(SSZ.ZeroGeneralizedIndex.selector);
        harness.depthOf(0);
        assertEq(harness.depthOf(1), 0);
        assertEq(harness.depthOf(2), 1);
        assertEq(harness.depthOf(16), 4);
    }
}
