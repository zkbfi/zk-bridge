// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @title TokenReader
/// @notice Reads the name, the symbol and the decimals of a token that may not follow the standard. It tries the lower
/// case selector, then the upper case selector, and it reads a string or a `bytes32`. This is the reader of
/// OmniBridge (`contracts/libraries/TokenReader.sol`), ported to the current compiler.
library TokenReader {
    /// @notice A token returns a value from `decimals()` that does not fit in a byte.
    /// @param token The token.
    /// @param value The value that the token returned.
    error DecimalsOutOfRange(address token, uint256 value);

    bytes4 private constant NAME = 0x06fdde03;
    bytes4 private constant NAME_UPPER = 0xa3f4df7e;
    bytes4 private constant SYMBOL = 0x95d89b41;
    bytes4 private constant SYMBOL_UPPER = 0xf76f8d78;
    bytes4 private constant DECIMALS = 0x313ce567;
    bytes4 private constant DECIMALS_UPPER = 0x2e0f2625;

    function readName(address token) internal view returns (string memory) {
        return _readString(token, NAME, NAME_UPPER);
    }

    function readSymbol(address token) internal view returns (string memory) {
        return _readString(token, SYMBOL, SYMBOL_UPPER);
    }

    /// @dev A token with no readable decimals has zero decimals: the call fails, or it returns less than one word.
    /// Amounts are integers everywhere, so the decimals are metadata for the copy only, and a missing value costs a
    /// holder nothing but the display. A value above 255 is another case: no byte can state it, and a silent zero
    /// would give the copy the wrong metadata for good, so it reverts.
    /// @return The decimals, or zero when the token has no readable decimals.
    function readDecimals(address token) internal view returns (uint8) {
        (bool ok, bytes memory data) = token.staticcall(abi.encodeWithSelector(DECIMALS));
        if (!ok) (ok, data) = token.staticcall(abi.encodeWithSelector(DECIMALS_UPPER));
        if (!ok || data.length < 32) return 0;
        uint256 value = abi.decode(data, (uint256));
        if (value > type(uint8).max) revert DecimalsOutOfRange(token, value);
        return uint8(value);
    }

    function _readString(address token, bytes4 selector, bytes4 upperSelector) private view returns (string memory) {
        (bool ok, bytes memory data) = token.staticcall(abi.encodeWithSelector(selector));
        if (!ok) (ok, data) = token.staticcall(abi.encodeWithSelector(upperSelector));
        if (!ok) return "";
        return _toString(data);
    }

    function _toString(bytes memory returned) private pure returns (string memory) {
        if (returned.length > 32) return abi.decode(returned, (string));
        if (returned.length < 32) return "";
        bytes32 packed = abi.decode(returned, (bytes32));
        uint256 length;
        while (length < 32 && packed[length] != 0) length++;
        bytes memory result = new bytes(length);
        for (uint256 i = 0; i < length; i++) {
            result[i] = packed[i];
        }
        return string(result);
    }
}
