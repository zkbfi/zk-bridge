// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {TokenReader} from "../../../src/hardened/mediator/TokenReader.sol";

/// @notice Calls the internal functions of `TokenReader` from a contract of their own.
contract TokenReaderHarness {
    function name(address token) external view returns (string memory) {
        return TokenReader.readName(token);
    }

    function symbol(address token) external view returns (string memory) {
        return TokenReader.readSymbol(token);
    }

    function decimals(address token) external view returns (uint8) {
        return TokenReader.readDecimals(token);
    }
}

/// @notice Tests of the reader of token metadata. The reader tries the lower case selector, then the upper case
/// selector, and accepts a string or a `bytes32`. Each test mocks the exact return data of a token, because the tokens
/// that need this reader (the old stablecoins) do not follow the standard.
contract TokenReaderTest is Test {
    bytes4 internal constant NAME = 0x06fdde03;
    bytes4 internal constant NAME_UPPER = 0xa3f4df7e;
    bytes4 internal constant DECIMALS = 0x313ce567;
    bytes4 internal constant DECIMALS_UPPER = 0x2e0f2625;

    TokenReaderHarness internal reader;
    address internal token = makeAddr("token");

    function setUp() public {
        reader = new TokenReaderHarness();
        // A contract address, so that a call to it succeeds with no data until a test mocks something else.
        vm.etch(token, hex"00");
    }

    function _padded(bytes memory text) internal pure returns (bytes32 packed) {
        return bytes32(text);
    }

    // ================================================================ names

    /// Claim: a standard token returns its name as a string. Shows: the string comes back unchanged.
    function test_name_readsAString() public {
        vm.mockCall(token, abi.encodeWithSelector(NAME), abi.encode("Wrapped Ether"));
        assertEq(reader.name(token), "Wrapped Ether");
    }

    /// Claim: an old token returns its name as a `bytes32`, padded with zero bytes. Shows: the padding is cut and the
    /// text is exact. Matters: a name with trailing zero bytes would break the name of the copy.
    function test_name_readsABytes32AndCutsThePadding() public {
        vm.mockCall(token, abi.encodeWithSelector(NAME), abi.encode(_padded("Maker")));
        assertEq(reader.name(token), "Maker");
    }

    /// Claim: a `bytes32` name that fills all 32 bytes is read whole. Shows: the loop stops at 32 and not at a zero byte
    /// that does not exist.
    function test_name_readsAFullBytes32() public {
        bytes32 full = bytes32("abcdefghijklmnopqrstuvwxyz012345");
        vm.mockCall(token, abi.encodeWithSelector(NAME), abi.encode(full));
        assertEq(reader.name(token), "abcdefghijklmnopqrstuvwxyz012345");
    }

    /// Claim: when the lower case selector reverts, the upper case selector is tried. Shows: the name of the upper case
    /// selector is returned. Matters: some old tokens only have `NAME()`.
    function test_name_triesTheUpperCaseSelectorAfterARevert() public {
        vm.mockCallRevert(token, abi.encodeWithSelector(NAME), "");
        vm.mockCall(token, abi.encodeWithSelector(NAME_UPPER), abi.encode(_padded("Sai")));
        assertEq(reader.name(token), "Sai");
    }

    /// Claim: a token with neither selector has an empty name. Shows: both calls revert and the result is empty.
    function test_name_isEmptyWhenBothSelectorsRevert() public {
        vm.mockCallRevert(token, abi.encodeWithSelector(NAME), "");
        vm.mockCallRevert(token, abi.encodeWithSelector(NAME_UPPER), "");
        assertEq(reader.name(token), "");
    }

    /// Claim: return data that is shorter than 32 bytes is no name. Shows: 4 bytes of return data give an empty name and
    /// do not revert. Matters: an account with a fallback that returns a few bytes must not break a relay.
    function test_name_isEmptyWhenTheReturnDataIsShort() public {
        vm.mockCall(token, abi.encodeWithSelector(NAME), hex"01020304");
        assertEq(reader.name(token), "");
    }

    /// Claim: the symbol is read by the same rules, with its own selectors. Shows: a `bytes32` symbol from the lower
    /// case selector.
    function test_symbol_readsABytes32() public {
        vm.mockCall(token, abi.encodeWithSelector(0x95d89b41), abi.encode(_padded("MKR")));
        assertEq(reader.symbol(token), "MKR");
    }

    // ================================================================ decimals

    /// Claim: the decimals come from the lower case selector. Shows: 6 comes back as 6.
    function test_decimals_readsTheValue() public {
        vm.mockCall(token, abi.encodeWithSelector(DECIMALS), abi.encode(uint256(6)));
        assertEq(reader.decimals(token), 6);
    }

    /// Claim: when the lower case selector reverts, the upper case selector gives the decimals. Shows: 8 from `DECIMALS()`.
    function test_decimals_triesTheUpperCaseSelectorAfterARevert() public {
        vm.mockCallRevert(token, abi.encodeWithSelector(DECIMALS), "");
        vm.mockCall(token, abi.encodeWithSelector(DECIMALS_UPPER), abi.encode(uint256(8)));
        assertEq(reader.decimals(token), 8);
    }

    /// Claim: a token with no readable decimals has zero decimals. Shows: both selectors revert, and short return data
    /// from a call that succeeds. Matters: the copy then has zero decimals and not garbage.
    function test_decimals_isZeroWhenNothingIsReadable() public {
        vm.mockCallRevert(token, abi.encodeWithSelector(DECIMALS), "");
        vm.mockCallRevert(token, abi.encodeWithSelector(DECIMALS_UPPER), "");
        assertEq(reader.decimals(token), 0, "both selectors revert");

        vm.mockCall(token, abi.encodeWithSelector(DECIMALS), hex"12");
        assertEq(reader.decimals(token), 0, "one byte is not a word");
    }

    /// Claim: a value above 255 is refused, and 255 is read. Shows: 255 is read as 255, and 256 and 300 revert with
    /// the token and the value. Matters: a cast would turn 256 into 0 and 300 into 44, and a silent 0 would give the
    /// copy the wrong metadata for good. The decimals are metadata only, so a token that cannot state them in a byte
    /// is not relayed for the first time.
    function test_decimals_refusesAValueThatDoesNotFitInAByte() public {
        vm.mockCall(token, abi.encodeWithSelector(DECIMALS), abi.encode(uint256(255)));
        assertEq(reader.decimals(token), 255);
        vm.mockCall(token, abi.encodeWithSelector(DECIMALS), abi.encode(uint256(256)));
        vm.expectRevert(abi.encodeWithSelector(TokenReader.DecimalsOutOfRange.selector, token, uint256(256)));
        reader.decimals(token);
        vm.mockCall(token, abi.encodeWithSelector(DECIMALS), abi.encode(type(uint256).max));
        vm.expectRevert(abi.encodeWithSelector(TokenReader.DecimalsOutOfRange.selector, token, type(uint256).max));
        reader.decimals(token);
    }

    /// Claim: the upper case selector is checked by the same rule. Shows: `DECIMALS()` that returns 300 reverts.
    function test_decimals_refusesAValueOfTheUpperCaseSelectorThatDoesNotFit() public {
        vm.mockCallRevert(token, abi.encodeWithSelector(DECIMALS), "");
        vm.mockCall(token, abi.encodeWithSelector(DECIMALS_UPPER), abi.encode(uint256(300)));
        vm.expectRevert(abi.encodeWithSelector(TokenReader.DecimalsOutOfRange.selector, token, uint256(300)));
        reader.decimals(token);
    }
}
