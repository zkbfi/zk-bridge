// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {AmbMessageCodec} from "../../src/hardened/AmbMessageCodec.sol";
import {MessageFixtures} from "./utils/MessageFixtures.sol";

/// @notice Calls the internal functions of the codec from outside.
contract CodecHarness {
    function encode(AmbMessageCodec.Header memory header, bytes calldata data) external pure returns (bytes memory) {
        return AmbMessageCodec.encode(header, data);
    }

    function decode(bytes memory encoded) external view returns (AmbMessageCodec.Header memory, bytes memory) {
        return AmbMessageCodec.decode(encoded);
    }
}

/// @notice Tests of the message encoding against the OmniBridge encoding. The vectors come from three sources that
/// share no code with the codec: the layout comment of `ArbitraryMessage.unpackData`, the packing in the mock
/// `AMBMock.sol` of `poanetwork/tokenbridge-contracts` (its chain identifiers are 1337 and 1338, two bytes each), and the
/// Python generator of the fixtures. The OmniBridge repositories hold no literal encoded message in their tests: the
/// JavaScript tests only check the identifier format and read the encoding back through the contracts.
contract MessageBridgeCodecTest is Test {
    CodecHarness internal codec = new CodecHarness();

    function _header(bytes32 id, uint32 gas, uint8 dataType, uint256 source, uint256 destination)
        internal
        pure
        returns (AmbMessageCodec.Header memory)
    {
        return AmbMessageCodec.Header({
            messageId: id,
            sender: address(0x5555555555555555555555555555555555555555),
            executor: address(0x3131313131313131313131313131313131313131),
            gasLimit: gas,
            dataType: dataType,
            sourceChainId: source,
            destinationChainId: destination
        });
    }

    // ================================================================ encoding vectors

    /// Claim: the encoding equals the packing of `AMBMock.sol` for the same inputs. Shows: with chain identifiers 1337 and
    /// 1338 the two outputs are equal byte for byte, for both data types. Matters: this is the layout that every
    /// OmniBridge receiver parses.
    function test_encode_equalsThePackingOfTheOmniBridgeMock() public view {
        bytes32 id = bytes32(uint256(0x11223344) << 224) | bytes32(uint256(7));
        bytes memory data = hex"b1591967aed668a4b27645ff40c444892d91bf5951b382995d4d4f6ee3a2ce03";
        uint8[2] memory types = [0x00, 0x80];
        for (uint256 i = 0; i < types.length; i++) {
            AmbMessageCodec.Header memory header = _header(id, 1_535_604_485, types[i], 1337, 1338);
            // `AMBMock._sendMessage`: abi.encodePacked(_messageId, msg.sender, _contract, uint32(_gas), uint8(2), uint8(2),
            // uint8(_dataType), uint16(1337), uint16(1338), _data)
            bytes memory packed = abi.encodePacked(
                id, header.sender, header.executor, uint32(1_535_604_485), uint8(2), uint8(2), types[i], uint16(1337), uint16(1338), data
            );
            assertEq(codec.encode(header, data), packed);
        }
    }

    /// Claim: the encoding equals a vector written out by hand from the layout comment of `unpackData`. Shows: sender and
    /// executor are 20 bytes each, the gas is 4 bytes, the lengths are 1 and 2 for the chain identifiers 1 and 369, and the data follows.
    function test_encode_equalsAVectorWrittenByHand() public view {
        bytes32 id = bytes32(abi.encodePacked(hex"00050000", hex"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", hex"0000000000000007"));
        bytes memory expected = bytes.concat(
            hex"00050000aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa0000000000000007", // identifier
            hex"5555555555555555555555555555555555555555", // sender
            hex"3131313131313131313131313131313131313131", // executor
            hex"0007a120", // gas 500000
            hex"010200", // lengths 1 and 2, data type 0
            hex"01", // source chain 1
            hex"0171", // destination chain 369
            hex"cafe" // data
        );
        assertEq(codec.encode(_header(id, 500_000, 0, 1, 369), hex"cafe"), expected);
        assertEq(expected.length, 79 + 1 + 2 + 2);
    }

    /// Claim: the codec and the independent Python encoder write the same bytes, and the codec reads what the
    /// Python encoder wrote. Shows: for the first fixture message, `encode` of the decoded header gives the fixture bytes,
    /// and the decoded fields are the inputs of the generator. Matters: two implementations from one layout comment
    /// agree only if both follow it.
    function test_encode_roundTripsAgainstThePythonEncoder() public view {
        MessageFixtures.Named memory named = MessageFixtures.deliver();
        (AmbMessageCodec.Header memory header, bytes memory data) = codec.decode(named.encoded);
        assertEq(header.messageId, named.messageId);
        assertEq(header.sender, MessageFixtures.SENDER);
        assertEq(header.executor, MessageFixtures.TARGET_RECORDER);
        assertEq(header.gasLimit, 500_000);
        assertEq(header.dataType, 0);
        assertEq(header.sourceChainId, MessageFixtures.SOURCE_CHAIN_ID);
        assertEq(header.destinationChainId, MessageFixtures.DESTINATION_CHAIN_ID);
        assertEq(data.length, 70);
        assertEq(codec.encode(header, data), named.encoded);
    }

    // ================================================================ identifiers

    /// Claim: the identifier is the version, bytes 4 to 23 of the hash of the 32-byte chain identifier and the bridge
    /// address, and the nonce in the lowest 8 bytes. Shows: the Python generator computed the first fixture identifier
    /// from the formula of the OmniBridge test (`soliditySha3(paddedChainId + address).slice(10, 50)`), and the
    /// codec gives the same value; the nonce occupies the low 8 bytes and the bytes 24 to 31 are the nonce alone.
    function test_identifier_followsTheOmniBridgeFormula() public pure {
        bytes32 prefix = AmbMessageCodec.messageIdPrefix(MessageFixtures.SOURCE_CHAIN_ID, MessageFixtures.REMOTE_BRIDGE);
        assertEq(prefix, MessageFixtures.deliver().messageId, "the first message has nonce zero");
        assertEq(bytes4(prefix), bytes4(0x00050000), "the version");
        bytes32 hashed = keccak256(abi.encodePacked(uint256(MessageFixtures.SOURCE_CHAIN_ID), MessageFixtures.REMOTE_BRIDGE));
        assertEq(bytes20(prefix << 32), bytes20(hashed << 32), "bytes 4 to 23 of the hash");
        assertEq(uint64(uint256(prefix)), 0, "no nonce in the prefix");
        assertEq(MessageFixtures.confirm().messageId, prefix | bytes32(uint256(1)), "the nonce is the low 8 bytes");
    }

    /// Claim: only an identifier with the version of this format is valid. Shows: version 5 passes; version 4, a
    /// different top byte and zero fail. Matters: a receiver refuses a layout that it does not read.
    function test_identifier_versionCheck() public pure {
        assertTrue(AmbMessageCodec.hasValidVersion(bytes32(uint256(0x00050000) << 224) | bytes32(uint256(123))));
        assertFalse(AmbMessageCodec.hasValidVersion(bytes32(uint256(0x00040000) << 224)));
        assertFalse(AmbMessageCodec.hasValidVersion(bytes32(uint256(0x01050000) << 224)));
        assertFalse(AmbMessageCodec.hasValidVersion(bytes32(0)));
    }

    /// Claim: chain identifiers take the fewest bytes. Shows: the lengths at the byte edges and for the chains of this
    /// bridge (Ethereum 1, PulseChain 369), and the full word for the largest value. Matters: the length bytes are part
    /// of the layout, and a receiver reads the identifier by them.
    function test_chainIdLength_isTheFewestBytes() public pure {
        assertEq(AmbMessageCodec.chainIdLength(0), 1);
        assertEq(AmbMessageCodec.chainIdLength(1), 1);
        assertEq(AmbMessageCodec.chainIdLength(255), 1);
        assertEq(AmbMessageCodec.chainIdLength(256), 2);
        assertEq(AmbMessageCodec.chainIdLength(369), 2);
        assertEq(AmbMessageCodec.chainIdLength(65_535), 2);
        assertEq(AmbMessageCodec.chainIdLength(65_536), 3);
        assertEq(AmbMessageCodec.chainIdLength(1 << 32), 5);
        assertEq(AmbMessageCodec.chainIdLength(type(uint256).max), 32);
        assertEq(AmbMessageCodec.chainIdLength(1 << 255), 32);
    }

    // ================================================================ decoding

    /// Claim: a message shorter than the fixed header is refused. Shows: 78 bytes revert, and 79 bytes with a zero
    /// chain identifier length revert too. Matters: the reader must not run past the message.
    function test_decode_refusesAShortMessage() public {
        vm.expectRevert(AmbMessageCodec.MalformedMessage.selector);
        codec.decode(new bytes(78));
        vm.expectRevert(AmbMessageCodec.MalformedMessage.selector);
        codec.decode(new bytes(79));
    }

    /// Claim: chain identifier lengths of zero or above 32, and lengths that run past the message, are refused. Shows:
    /// the exact error for each. Matters: a length byte is data that the sender controls.
    function test_decode_refusesBadChainIdLengths() public {
        bytes memory good = codec.encode(_header(bytes32(uint256(0x00050000) << 224), 100, 0, 1, 369), "");
        uint8[4] memory sourceLengths = [0, 33, 1, 1];
        uint8[4] memory destinationLengths = [2, 2, 0, 33];
        for (uint256 i = 0; i < 4; i++) {
            bytes memory bad = good;
            bad[76] = bytes1(sourceLengths[i]);
            bad[77] = bytes1(destinationLengths[i]);
            vm.expectRevert(AmbMessageCodec.MalformedMessage.selector);
            codec.decode(bad);
        }
        bytes memory runsPast = good;
        runsPast[76] = bytes1(uint8(10));
        vm.expectRevert(AmbMessageCodec.MalformedMessage.selector);
        codec.decode(runsPast);
    }

    /// Claim: the reader takes a longer chain identifier than the fewest bytes, as `unpackData` does. Shows: the
    /// identifier 1 written in 4 bytes reads as 1. Matters: compatibility with OmniBridge, whose receivers mask by length.
    function test_decode_readsAnIdentifierWrittenInMoreBytes() public view {
        bytes memory encoded = bytes.concat(
            bytes32(uint256(0x00050000) << 224),
            bytes20(address(0x5555555555555555555555555555555555555555)),
            bytes20(address(0x3131313131313131313131313131313131313131)),
            bytes4(uint32(7)),
            hex"040100",
            hex"00000001",
            hex"01",
            hex"abcd"
        );
        (AmbMessageCodec.Header memory header, bytes memory data) = codec.decode(encoded);
        assertEq(header.sourceChainId, 1);
        assertEq(header.destinationChainId, 1);
        assertEq(data, hex"abcd");
    }

    /// Claim: encode then decode returns the input, for any header and data. Shows: a fuzz over the gas, the data type,
    /// both chain identifiers and the data. Matters: the codec must not lose or move a field for any value.
    function testFuzz_roundTrip(
        bytes32 id,
        address sender,
        address executor,
        uint32 gas,
        uint8 dataType,
        uint256 source,
        uint256 destination,
        bytes calldata data
    ) public view {
        AmbMessageCodec.Header memory header = AmbMessageCodec.Header(id, sender, executor, gas, dataType, source, destination);
        (AmbMessageCodec.Header memory read, bytes memory readData) = codec.decode(codec.encode(header, data));
        assertEq(read.messageId, id);
        assertEq(read.sender, sender);
        assertEq(read.executor, executor);
        assertEq(read.gasLimit, gas);
        assertEq(read.dataType, dataType);
        assertEq(read.sourceChainId, source);
        assertEq(read.destinationChainId, destination);
        assertEq(readData, data);
    }
}
