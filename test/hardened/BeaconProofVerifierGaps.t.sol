// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {BeaconProofVerifier} from "../../src/hardened/BeaconProofVerifier.sol";
import {MessageBridge} from "../../src/hardened/MessageBridge.sol";
import {ReceiptProofLib} from "../../src/hardened/ReceiptProofLib.sol";
import {RLPReader} from "../../src/hardened/vendor/optimism/rlp/RLPReader.sol";
import {ReceiptBuilder} from "./utils/ReceiptBuilder.sol";
import {MessageScenes} from "./utils/MessageScenes.sol";
import {MessageFixtures} from "./utils/MessageFixtures.sol";
import {WithdrawalScenes} from "./utils/WithdrawalScenes.sol";

/// @notice A message bridge that exposes the internal decoding steps of `BeaconProofVerifier`, so that a test can give
/// them bytes that a real receipt never holds.
contract VerifierDecodingHarness is MessageBridge {
    constructor(
        address lightClient,
        uint64 localChainId,
        uint64 remoteChainId,
        address remoteBridgeAddress,
        BridgeTerms memory terms,
        uint64 capellaEraValue,
        address gate
    ) MessageBridge(lightClient, remoteChainId, remoteBridgeAddress, terms, capellaEraValue, gate) {}

    function headerRoot(bytes calldata headerRlp, uint256 field) external pure returns (bytes32) {
        return ReceiptProofLib.headerRoot(RLPReader.readList(headerRlp), field);
    }

    /// @dev The raw bytes of the log that `_receiptLog` returns.
    function receiptLog(bytes memory receipt, uint256 logIndex) external pure returns (bytes memory) {
        return RLPReader.readRawBytes(ReceiptProofLib.receiptLog(receipt, logIndex));
    }

    function logFieldCount(bytes memory log) external pure returns (uint256) {
        return ReceiptProofLib.logFieldsOf(RLPReader.toRLPItem(log)).length;
    }

    function requireEmitter(bytes memory emitterItem, address expected) external pure {
        ReceiptProofLib.requireEmitter(RLPReader.toRLPItem(emitterItem), expected);
    }

    function toBytes32(bytes memory value) external pure returns (bytes32) {
        return ReceiptProofLib.toBytes32(value);
    }
}

/// @notice The refusals of the decoding steps of `BeaconProofVerifier` that the proofs of the other tests cannot reach,
/// because the tries in those proofs always hold well formed receipts. A real receipt that sits in a consensus validated
/// trie is always well formed, so each refusal is a guard on the data that an executor supplies.
contract BeaconProofVerifierGapsTest is MessageScenes {
    VerifierDecodingHarness internal harness;

    function setUp() public override(MessageScenes) {
        super.setUp();
        vm.chainId(CHAIN_B);
        harness = new VerifierDecodingHarness(
            address(lightClientForB),
            CHAIN_B,
            CHAIN_A,
            MessageFixtures.REMOTE_BRIDGE,
            MessageBridge.BridgeTerms(0, address(lightClientForA)),
            DEFAULT_CAPELLA_ERA,
            address(gateB)
        );
    }

    function _list(bytes[] memory items) internal pure returns (bytes memory) {
        bytes[] memory encoded = new bytes[](items.length);
        for (uint256 i = 0; i < items.length; i++) {
            encoded[i] = _rlpBytes(items[i]);
        }
        return _rlpList(encoded);
    }

    function _filled(uint256 length, bytes1 value) internal pure returns (bytes memory out) {
        out = new bytes(length);
        for (uint256 i = 0; i < length; i++) {
            out[i] = value;
        }
    }

    function _logEntry() internal pure returns (ReceiptBuilder.LogEntry memory entry) {
        bytes32[] memory topics = new bytes32[](1);
        topics[0] = keccak256("Topic()");
        entry = ReceiptBuilder.LogEntry({emitter: address(0xBEEF), topics: topics, data: hex"1234"});
    }

    // ================================================================ the roots of an execution header

    /// Claim: a root item of the execution header that is not 32 bytes wide is refused, whether it is one byte short or
    /// one byte long. Shows: `MalformedExecutionHeader` for 31 and 33 bytes, and the root for 32 bytes. Matters: a
    /// short item must never be padded into a root, because the padded value would name another trie.
    function test_headerRoot_refusesAnItemThatIsNotThirtyTwoBytes() public {
        bytes[] memory items = new bytes[](1);
        items[0] = _filled(31, 0xaa);
        bytes memory short = _list(items);
        vm.expectRevert(BeaconProofVerifier.MalformedExecutionHeader.selector);
        harness.headerRoot(short, 0);

        items[0] = _filled(33, 0xaa);
        bytes memory long = _list(items);
        vm.expectRevert(BeaconProofVerifier.MalformedExecutionHeader.selector);
        harness.headerRoot(long, 0);

        items[0] = _filled(32, 0xaa);
        assertEq(harness.headerRoot(_list(items), 0), bytes32(_filled(32, 0xaa)), "a 32 byte item is the root");
    }

    // ================================================================ the receipt

    /// Claim: a receipt must hold exactly four fields: status, cumulative gas, bloom and logs. Shows: three and five
    /// fields revert with `MalformedReceipt`, and four fields return the log at the index. Matters: the logs are read at
    /// field 3, so a receipt of another shape would read another field as the logs.
    function test_receiptLog_refusesAReceiptThatDoesNotHoldFourFields() public {
        bytes[] memory three = new bytes[](3);
        three[0] = hex"01";
        three[1] = hex"01";
        three[2] = _filled(256, 0x00);
        vm.expectRevert(BeaconProofVerifier.MalformedReceipt.selector);
        harness.receiptLog(_list(three), 0);

        bytes[] memory five = new bytes[](5);
        five[0] = hex"01";
        five[1] = hex"01";
        five[2] = _filled(256, 0x00);
        five[3] = "";
        five[4] = "";
        vm.expectRevert(BeaconProofVerifier.MalformedReceipt.selector);
        harness.receiptLog(_list(five), 0);

        ReceiptBuilder.LogEntry[] memory logs = new ReceiptBuilder.LogEntry[](1);
        logs[0] = _logEntry();
        bytes memory honest = ReceiptBuilder.receipt(2, ReceiptBuilder.ReceiptStatus.Success, logs);
        assertGt(harness.receiptLog(honest, 0).length, 0, "an honest receipt returns its log");
    }

    // ================================================================ the log

    /// Claim: a log must hold exactly three fields: emitter, topics and data. Shows: two and four fields revert with
    /// `MalformedLog`, and three fields pass. Matters: the emitter and the topics are read by position.
    function test_logFields_refusesALogThatDoesNotHoldThreeFields() public {
        bytes[] memory items = new bytes[](2);
        items[0] = hex"aa";
        items[1] = hex"bb";
        vm.expectRevert(BeaconProofVerifier.MalformedLog.selector);
        harness.logFieldCount(_list(items));

        items = new bytes[](4);
        vm.expectRevert(BeaconProofVerifier.MalformedLog.selector);
        harness.logFieldCount(_list(items));

        items = new bytes[](3);
        assertEq(harness.logFieldCount(_list(items)), 3);
    }

    /// Claim: the emitter of a log must be 20 bytes wide and equal the expected address. Shows: 19 and 21 bytes revert
    /// with `MalformedLog`, another 20 byte address reverts with both addresses, and the expected address passes.
    /// Matters: an emitter that is only close to the remote bridge is not the remote bridge.
    function test_requireEmitter_refusesAWrongWidthAndAWrongAddress() public {
        address expected = address(0xBEEF);
        bytes memory short = _rlpBytes(_filled(19, 0x11));
        vm.expectRevert(BeaconProofVerifier.MalformedLog.selector);
        harness.requireEmitter(short, expected);

        bytes memory long = _rlpBytes(_filled(21, 0x11));
        vm.expectRevert(BeaconProofVerifier.MalformedLog.selector);
        harness.requireEmitter(long, expected);

        address other = address(0xBEEF + 1);
        vm.expectRevert(abi.encodeWithSelector(BeaconProofVerifier.WrongEmitter.selector, expected, other));
        harness.requireEmitter(_rlpBytes(abi.encodePacked(other)), expected);

        harness.requireEmitter(_rlpBytes(abi.encodePacked(expected)), expected);
    }

    /// Claim: a topic must be 32 bytes wide. Shows: 31 and 33 bytes revert with `MalformedLog`; 32 bytes convert
    /// unchanged. Matters: a short topic must never be padded into an identifier.
    function test_toBytes32_refusesATopicThatIsNotThirtyTwoBytes() public {
        vm.expectRevert(BeaconProofVerifier.MalformedLog.selector);
        harness.toBytes32(_filled(31, 0x22));
        vm.expectRevert(BeaconProofVerifier.MalformedLog.selector);
        harness.toBytes32(_filled(33, 0x22));
        assertEq(harness.toBytes32(_filled(32, 0x22)), bytes32(_filled(32, 0x22)));
    }
}
