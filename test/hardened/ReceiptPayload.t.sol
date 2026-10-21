// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {BridgeVault} from "../../src/hardened/BridgeVault.sol";
import {RLPReader} from "../../src/hardened/vendor/optimism/rlp/RLPReader.sol";
import {WithdrawalScenes} from "./utils/WithdrawalScenes.sol";
import {ReceiptFixtures} from "./utils/ReceiptFixtures.sol";

/// @notice A vault that exposes the receipt envelope step, so a test can feed it receipts of any length.
contract ReceiptPayloadVault is BridgeVault {
    constructor(
        address lightClient,
        uint64 localChainId,
        uint64 remoteChainId,
        address remoteVaultAddress,
        TokenPair[] memory pairs,
        DepositTerms memory terms,
        uint64 capellaEraValue,
        address gate
    ) BridgeVault(lightClient, localChainId, remoteChainId, remoteVaultAddress, pairs, terms, capellaEraValue, gate) {}

    /// @dev The bytes that the payload item covers, and its length.
    function payloadBytes(bytes memory receipt) external pure returns (bytes memory) {
        RLPReader.RLPItem memory payload = _receiptPayload(receipt);
        if (payload.length == 0) return "";
        return RLPReader.readRawBytes(payload);
    }

    function payloadLength(bytes memory receipt) external pure returns (uint256) {
        return _receiptPayload(receipt).length;
    }
}

/// @notice Tests of the receipt envelope step of `BridgeVault`: the type byte is skipped without a copy, and the
/// payload must equal the receipt without its first byte at every length.
contract ReceiptPayloadTest is WithdrawalScenes {
    ReceiptPayloadVault internal harness;

    function setUp() public override {
        super.setUp();
        vm.chainId(CHAIN_B);
        BridgeVault.TokenPair[] memory pairs = new BridgeVault.TokenPair[](1);
        pairs[0] = BridgeVault.TokenPair(address(tokenOnB), ReceiptFixtures.REMOTE_TOKEN, 18);
        harness = new ReceiptPayloadVault(
            address(lightClientForB),
            CHAIN_B,
            CHAIN_A,
            ReceiptFixtures.REMOTE_VAULT,
            pairs,
            BridgeVault.DepositTerms(0, address(0), address(0), 0, 0),
            DEFAULT_CAPELLA_ERA,
            address(gateB)
        );
    }

    function _receiptOf(uint8 first, uint256 length) internal pure returns (bytes memory receipt) {
        receipt = new bytes(length);
        receipt[0] = bytes1(first);
        for (uint256 i = 1; i < length; i++) {
            receipt[i] = bytes1(uint8(i * 7 + 3));
        }
    }

    /// Claim: for every supported type byte and every length from 2 to 130 (so most are not a multiple of 32), the
    /// payload is the receipt minus its first byte. Matters: a word-wise or pointer approach must not drop or add a
    /// trailing byte at a word boundary.
    function test_receiptPayload_typedReceiptDropsOnlyTheTypeByte() public view {
        for (uint8 typeByte = 1; typeByte <= 4; typeByte++) {
            for (uint256 length = 2; length <= 130; length++) {
                bytes memory receipt = _receiptOf(typeByte, length);
                bytes memory expected = new bytes(length - 1);
                for (uint256 i = 0; i < expected.length; i++) {
                    expected[i] = receipt[i + 1];
                }
                assertEq(harness.payloadBytes(receipt), expected, "payload is the receipt without the type byte");
            }
        }
    }

    /// Claim: a legacy receipt (first byte at least 0xc0) is returned whole, at lengths that are and are not a multiple
    /// of 32. Matters: the legacy path must not strip a byte.
    function test_receiptPayload_legacyReceiptIsUnchanged() public view {
        uint256[4] memory lengths = [uint256(1), 31, 32, 77];
        for (uint256 j = 0; j < lengths.length; j++) {
            bytes memory receipt = _receiptOf(0xc0, lengths[j]);
            assertEq(harness.payloadBytes(receipt), receipt, "legacy receipt is whole");
        }
    }

    /// Claim: a type byte with nothing after it gives an empty payload, which the reader then refuses. Shows: the
    /// length is zero. Matters: a one byte receipt must never read the memory after it.
    function test_receiptPayload_typeByteAloneGivesEmptyPayload() public view {
        assertEq(harness.payloadLength(_receiptOf(0x02, 1)), 0);
    }

    /// Claim: an empty receipt, a zero type byte and a type byte above 4 are refused. Matters: only known layouts decode.
    function test_receiptPayload_unknownTypeBytesRejected() public {
        vm.expectRevert(BridgeVault.MalformedReceipt.selector);
        harness.payloadLength("");
        vm.expectRevert(BridgeVault.MalformedReceipt.selector);
        harness.payloadLength(_receiptOf(0x00, 5));
        vm.expectRevert(BridgeVault.MalformedReceipt.selector);
        harness.payloadLength(_receiptOf(0x05, 5));
        vm.expectRevert(BridgeVault.MalformedReceipt.selector);
        harness.payloadLength(_receiptOf(0xbf, 5));
    }
}
