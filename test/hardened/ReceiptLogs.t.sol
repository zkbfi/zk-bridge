// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {ReceiptLogs} from "../../src/hardened/ReceiptLogs.sol";
import {RLPReader} from "../../src/hardened/vendor/optimism/rlp/RLPReader.sol";
import {
    EmptyItem,
    UnexpectedString,
    InvalidDataRemainder,
    ContentLengthMismatch,
    InvalidHeader
} from "../../src/hardened/vendor/optimism/rlp/RLPErrors.sol";

/// @notice Calls `ReceiptLogs` from outside the test contract, so that `vm.expectRevert` can see its reverts.
contract ReceiptLogsHarness {
    function itemAt(bytes calldata encodedList, uint256 index)
        external
        pure
        returns (bool found, bytes memory rawItem, uint256 count)
    {
        RLPReader.RLPItem memory item;
        (found, item, count) = ReceiptLogs.itemAt(RLPReader.toRLPItem(encodedList), index);
        if (found) rawItem = RLPReader.readRawBytes(item);
    }
}

/// @notice Hands `ReceiptLogs` an item that the vendored `toRLPItem` would never build: a list of length zero.
contract ReceiptLogsEmptyItemHarness {
    function itemAtOfEmptyItem() external pure returns (bool found, uint256 count) {
        RLPReader.RLPItem memory empty =
            RLPReader.RLPItem({length: 0, ptr: RLPReader.MemoryPointer.wrap(0x80)});
        (found,, count) = ReceiptLogs.itemAt(empty, 0);
    }
}

/// @notice Tests of the item walker that replaces the vendored `readList` for the logs of a receipt. The vendored
/// reader holds at most 32 items. A transaction can emit more logs than that, and the deposit it holds must stay
/// withdrawable.
contract ReceiptLogsTest is Test {
    ReceiptLogsHarness internal harness;

    function setUp() public {
        harness = new ReceiptLogsHarness();
    }

    // ---------------------------------------------------------------- encoding helpers

    /// @dev The RLP encoding of a byte string.
    function _string(bytes memory data) internal pure returns (bytes memory) {
        if (data.length == 1 && uint8(data[0]) < 0x80) return data;
        return bytes.concat(_prefix(data.length, 0x80), data);
    }

    /// @dev The RLP encoding of a list whose items are already encoded.
    function _list(bytes memory encodedItems) internal pure returns (bytes memory) {
        return bytes.concat(_prefix(encodedItems.length, 0xc0), encodedItems);
    }

    function _prefix(uint256 length, uint8 offset) internal pure returns (bytes memory) {
        if (length <= 55) return abi.encodePacked(uint8(offset + length));
        bytes memory lengthBytes = abi.encodePacked(uint16(length));
        if (length < 256) lengthBytes = abi.encodePacked(uint8(length));
        return bytes.concat(abi.encodePacked(uint8(offset + 55 + lengthBytes.length)), lengthBytes);
    }

    /// @dev Item `i` of a test list: a string whose length changes with `i`, so that items have different headers.
    /// Every fifth item is long (more than 55 bytes) and has a long-form header.
    function _itemFor(uint256 i) internal pure returns (bytes memory) {
        uint256 size = i % 5 == 4 ? 60 + (i % 7) : 1 + (i % 9);
        bytes memory data = new bytes(size);
        for (uint256 k = 0; k < size; k++) {
            data[k] = bytes1(uint8(i + k + 1));
        }
        return _string(data);
    }

    function _listOf(uint256 count) internal pure returns (bytes memory encodedList) {
        bytes memory items;
        for (uint256 i = 0; i < count; i++) {
            items = bytes.concat(items, _itemFor(i));
        }
        return _list(items);
    }

    // ---------------------------------------------------------------- lists of many sizes

    /// Claim: the walker finds every item of lists with 0, 1, 31, 32, 33 and 200 items. Shows: for each size, the first,
    /// the last and (where it exists) the item after the 32nd are returned byte for byte; the index equal to the size
    /// reports not found with the exact count. Matters: 33 and more items are where the vendored reader panics, so these
    /// sizes are the ones that lock a deposit. The 200 item list has a two-byte length header.
    function test_walkerFindsItemsInListsOfEverySize() public view {
        uint256[6] memory sizes = [uint256(0), 1, 31, 32, 33, 200];
        for (uint256 s = 0; s < sizes.length; s++) {
            uint256 size = sizes[s];
            bytes memory encodedList = _listOf(size);
            for (uint256 i = 0; i < size; i++) {
                (bool found, bytes memory rawItem,) = harness.itemAt(encodedList, i);
                assertTrue(found, "the item exists");
                assertEq(rawItem, _itemFor(i), "the item is the one at the index");
            }
            (bool foundPast, bytes memory rawPast, uint256 count) = harness.itemAt(encodedList, size);
            assertFalse(foundPast, "an index equal to the size is past the end");
            assertEq(rawPast.length, 0, "no item is returned");
            assertEq(count, size, "the count is exact");
        }
    }

    /// Claim: the vendored reader cannot read a list of 33 items, and the walker can. Shows: `RLPReader.readList` reverts
    /// on the 33 item list and returns on the 32 item list; the walker returns the 33rd item. Matters: this is the defect
    /// itself, shown against the real vendored code.
    function test_vendoredReaderFailsAt33ItemsAndWalkerDoesNot() public {
        bytes memory thirtyTwo = _listOf(32);
        bytes memory thirtyThree = _listOf(33);
        assertEq(RLPReader.readList(thirtyTwo).length, 32, "control: the vendored reader reads 32 items");
        vm.expectRevert(); // array out-of-bounds panic
        this.vendoredItemCount(thirtyThree);
        (bool found, bytes memory rawItem,) = harness.itemAt(thirtyThree, 32);
        assertTrue(found);
        assertEq(rawItem, _itemFor(32));
    }

    function vendoredItemCount(bytes calldata encodedList) external pure returns (uint256) {
        return RLPReader.readList(encodedList).length;
    }

    /// Claim: for lists the vendored reader can read, the walker returns the same bytes as the vendored reader.
    /// Shows: for a list of 32 items, every item equals the vendored item. Matters: the walker is a replacement, so it
    /// must not change what the vault reads for the lists that worked before.
    function test_walkerAgreesWithVendoredReaderOnSmallLists() public view {
        bytes memory encodedList = _listOf(32);
        RLPReader.RLPItem[] memory vendored = RLPReader.readList(encodedList);
        for (uint256 i = 0; i < vendored.length; i++) {
            (bool found, bytes memory rawItem,) = harness.itemAt(encodedList, i);
            assertTrue(found);
            assertEq(rawItem, RLPReader.readRawBytes(vendored[i]));
        }
    }

    /// Claim: the walker also steps over list items, which is what logs are. Shows: a list of 40 logs, each a list of
    /// three items, returns log 39 whole. Matters: the vault decodes the returned log with the vendored `readList`.
    function test_walkerReturnsListItemsWholeSoTheyDecode() public view {
        bytes memory logs;
        for (uint256 i = 0; i < 40; i++) {
            logs = bytes.concat(logs, _list(bytes.concat(_string(abi.encodePacked(uint8(i + 1))), _list(""), _string("data"))));
        }
        bytes memory encodedList = _list(logs);
        (bool found, bytes memory rawLog,) = harness.itemAt(encodedList, 39);
        assertTrue(found);
        RLPReader.RLPItem[] memory fields = RLPReader.readList(rawLog);
        assertEq(fields.length, 3);
        assertEq(RLPReader.readBytes(fields[0]), abi.encodePacked(uint8(40)));
    }

    // ---------------------------------------------------------------- malformed input

    /// Claim: the walker refuses an item that is not a list. Shows: a byte string reverts with `UnexpectedString`; the
    /// list next to it works. Matters: the logs field of a receipt is a list, and anything else is not a receipt.
    function test_walkerRefusesAStringWhereAListIsExpected() public {
        vm.expectRevert(UnexpectedString.selector);
        harness.itemAt(_string("abc"), 0);
        (bool found,,) = harness.itemAt(_listOf(2), 1); // control
        assertTrue(found);
    }

    /// Claim: bytes after the list are refused. Shows: a list followed by one more byte reverts with
    /// `InvalidDataRemainder`; the same list without the byte works. Matters: the vendored reader refuses this as well.
    function test_walkerRefusesBytesAfterTheList() public {
        bytes memory good = _listOf(3);
        vm.expectRevert(InvalidDataRemainder.selector);
        harness.itemAt(bytes.concat(good, hex"01"), 0);
        (bool found,,) = harness.itemAt(good, 0); // control
        assertTrue(found);
    }

    /// Claim: an item that claims more bytes than remain is refused, at the list and at an item. Shows: a list header
    /// that claims 5 bytes with 1 present, and an item header that claims 2 bytes with 1 present, both revert with
    /// `ContentLengthMismatch`. Matters: a length that runs past the end must never read beyond the receipt.
    function test_walkerRefusesLengthsThatRunPastTheEnd() public {
        vm.expectRevert(ContentLengthMismatch.selector);
        harness.itemAt(hex"c501", 0); // list claims 5 bytes, 1 present
        vm.expectRevert(ContentLengthMismatch.selector);
        harness.itemAt(hex"c28261", 1); // the item claims 2 bytes, 1 present
        (bool found,,) = harness.itemAt(hex"c28180", 0); // control: a well formed list of one string
        assertTrue(found);
    }

    /// Claim: non-canonical headers are refused, as the vendored reader refuses them. Shows: a long-form header for a
    /// short length (0xb8 0x05), a long length with a leading zero byte (0xb9 0x00 0x40), and a one byte string below
    /// 0x80 behind a prefix (0x81 0x05) each revert with `InvalidHeader`. Matters: one value must have one encoding,
    /// otherwise the same log could be addressed two ways.
    function test_walkerRefusesNonCanonicalHeaders() public {
        vm.expectRevert(InvalidHeader.selector);
        harness.itemAt(bytes.concat(hex"c7b805", hex"6162636465"), 0);
        vm.expectRevert(InvalidHeader.selector);
        harness.itemAt(bytes.concat(hex"c3b90040"), 0);
        vm.expectRevert(InvalidHeader.selector);
        harness.itemAt(hex"c28105", 0);
        (bool found,,) = harness.itemAt(hex"c105", 0); // control: the canonical form of the one byte string
        assertTrue(found);
    }

    /// Claim: a long list header with a leading zero length byte is refused. Shows: 0xf9 0x00 0x40 reverts with
    /// `InvalidHeader`. Matters: same as above, for the list header itself.
    function test_walkerRefusesNonCanonicalListHeader() public {
        vm.expectRevert(InvalidHeader.selector);
        harness.itemAt(bytes.concat(hex"f90040", new bytes(64)), 0);
        (bool found,,) = harness.itemAt(_listOf(40), 0); // control: a canonical long list
        assertTrue(found);
    }

    /// Claim: empty input is refused. Shows: zero bytes revert with `EmptyItem` (from the vendored `toRLPItem`). Matters:
    /// an empty receipt field must not read as an empty list.
    function test_walkerRefusesEmptyInput() public {
        vm.expectRevert(EmptyItem.selector);
        harness.itemAt("", 0);
        (bool found,,) = harness.itemAt(hex"c0", 0); // control: the empty list is valid and has no item
        assertFalse(found);
    }

    /// Claim: a long string header with no length byte after it is refused at an item. Shows: a list that holds only the
    /// prefix 0xb8 reverts with `ContentLengthMismatch`, where the same prefix followed by a length byte and a string
    /// of that length is read. Matters: the length bytes of an item must lie inside the list.
    function test_walkerRefusesAnItemWhoseLengthBytesAreMissing() public {
        vm.expectRevert(ContentLengthMismatch.selector);
        harness.itemAt(hex"c1b8", 0);
        (bool found, bytes memory raw,) = harness.itemAt(bytes.concat(hex"f83a", hex"b838", new bytes(56)), 0);
        assertTrue(found, "control: a string of 56 bytes behind a length byte");
        assertEq(raw.length, 58, "the item with its header");
    }

    /// Claim: a long string item that claims more bytes than the list holds is refused. Shows: the prefix 0xb8 0x38 (a
    /// string of 56 bytes) followed by 10 bytes reverts with `ContentLengthMismatch`. Matters: a length that runs past
    /// the end of the list must never read beyond the receipt.
    function test_walkerRefusesALongItemThatRunsPastTheEnd() public {
        vm.expectRevert(ContentLengthMismatch.selector);
        harness.itemAt(bytes.concat(hex"cc", hex"b838", new bytes(10)), 0);
    }

    /// Claim: the walker refuses an item of length zero. Shows: `EmptyItem` for a hand built item with no bytes, which
    /// the vendored `toRLPItem` never makes. Matters: a header cannot be read from no bytes.
    function test_walkerRefusesAnItemOfLengthZero() public {
        ReceiptLogsEmptyItemHarness emptyHarness = new ReceiptLogsEmptyItemHarness();
        vm.expectRevert(EmptyItem.selector);
        emptyHarness.itemAtOfEmptyItem();
    }
}
