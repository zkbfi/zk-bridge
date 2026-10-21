// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {RLPReader} from "./vendor/optimism/rlp/RLPReader.sol";
import {
    EmptyItem,
    UnexpectedString,
    InvalidDataRemainder,
    ContentLengthMismatch,
    InvalidHeader
} from "./vendor/optimism/rlp/RLPErrors.sol";

/// @title ReceiptLogs
/// @notice Finds one item of an RLP list without a fixed limit on the number of items.
/// @dev The vendored `RLPReader.readList` copies at most 32 items and panics on the 33rd. A receipt can hold many more
/// logs, so a deposit in such a transaction could never be withdrawn. This library steps over the items one by one and
/// returns only the item that the caller asks for. The vendored decoder keeps its length helper private, so this library
/// holds its own header decoder. It applies the same rules as the vendored one: a canonical header, no leading zero in a
/// long length, no long form for a short length, and every item inside the bytes that remain. It returns the vendored
/// `RLPItem` type, so the caller decodes the chosen item with the vendored `readList` and `readBytes`.
library ReceiptLogs {
    /// @notice Finds the item at `index` of an RLP list.
    /// @dev When the index is past the end, the walk reaches the end of the list and `count` holds the number of items.
    /// When the item is found, the walk stops there and `count` is zero: the caller must not read it.
    /// @param list The RLP list item. It must be a list that fills the whole item.
    /// @param index The position of the wanted item.
    /// @return found Whether the list holds an item at `index`.
    /// @return item The wanted item, with its header. Empty when `found` is false.
    /// @return count The number of items in the list when `found` is false.
    function itemAt(RLPReader.RLPItem memory list, uint256 index)
        internal
        pure
        returns (bool found, RLPReader.RLPItem memory item, uint256 count)
    {
        (uint256 listOffset, uint256 listLength, bool isList) = _header(list.ptr, list.length);
        if (!isList) revert UnexpectedString();
        if (listOffset + listLength != list.length) revert InvalidDataRemainder();

        uint256 base = RLPReader.MemoryPointer.unwrap(list.ptr);
        uint256 offset = listOffset;
        while (offset < list.length) {
            RLPReader.MemoryPointer itemPointer = RLPReader.MemoryPointer.wrap(base + offset);
            (uint256 itemOffset, uint256 itemLength,) = _header(itemPointer, list.length - offset);
            if (count == index) {
                return (true, RLPReader.RLPItem({length: itemOffset + itemLength, ptr: itemPointer}), 0);
            }
            count += 1;
            offset += itemOffset + itemLength;
        }
        return (false, RLPReader.RLPItem({length: 0, ptr: RLPReader.MemoryPointer.wrap(0)}), count);
    }

    /// @dev Decodes the header of the item at `pointer`, which has `available` bytes left. Returns the header length,
    /// the payload length and whether the item is a list. It reverts on every non-canonical or truncated header.
    function _header(RLPReader.MemoryPointer pointer, uint256 available)
        private
        pure
        returns (uint256 headerLength, uint256 payloadLength, bool isList)
    {
        if (available == 0) revert EmptyItem();
        uint256 position = RLPReader.MemoryPointer.unwrap(pointer);
        uint256 prefix;
        uint256 word;
        assembly {
            word := mload(add(position, 1))
            prefix := byte(0, mload(position))
        }
        if (prefix <= 0x7f) return (0, 1, false);
        if (prefix <= 0xb7) return _shortHeader(prefix - 0x80, word, available, false);
        if (prefix <= 0xbf) return _longHeader(prefix - 0xb7, word, available, false);
        if (prefix <= 0xf7) return _shortHeader(prefix - 0xc0, word, available, true);
        return _longHeader(prefix - 0xf7, word, available, true);
    }

    /// @dev A header whose payload length is in the prefix byte (at most 55).
    function _shortHeader(uint256 length, uint256 word, uint256 available, bool isList)
        private
        pure
        returns (uint256, uint256, bool)
    {
        if (available <= length) revert ContentLengthMismatch();
        // A single byte below 0x80 must be written as itself, never behind a prefix.
        if (!isList && length == 1 && (word >> 248) < 0x80) revert InvalidHeader();
        return (1, length, isList);
    }

    /// @dev A header whose payload length follows the prefix byte in `lengthOfLength` bytes.
    function _longHeader(uint256 lengthOfLength, uint256 word, uint256 available, bool isList)
        private
        pure
        returns (uint256, uint256, bool)
    {
        if (available <= lengthOfLength) revert ContentLengthMismatch();
        if ((word >> 248) == 0) revert InvalidHeader();
        uint256 length = word >> (256 - 8 * lengthOfLength);
        if (length <= 55) revert InvalidHeader();
        if (available <= lengthOfLength + length) revert ContentLengthMismatch();
        return (1 + lengthOfLength, length, isList);
    }
}
