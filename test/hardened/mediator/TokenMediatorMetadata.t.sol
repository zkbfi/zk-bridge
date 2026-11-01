// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {Vm} from "forge-std/Vm.sol";
import {BridgedToken} from "../../../src/hardened/mediator/BridgedToken.sol";
import {TokenMediator} from "../../../src/hardened/mediator/TokenMediator.sol";
import {WorldSupport} from "../utils/WorldSupport.sol";
import {BareToken, Bytes32MetadataToken, OnlyNameToken, OnlySymbolToken, ZrxToken} from "./utils/MetadataTokens.sol";

/// @notice Tokens with unusual metadata, bridged from chain A to chain B and back through the real bridge and the real
/// mediator. Each test asserts the exact name, symbol, decimals, balances, events and records, on both chains.
contract TokenMediatorMetadataTest is WorldSupport {
    uint256 internal constant AMOUNT = 25 ether;
    uint256 internal constant RETURNED = 10 ether;

    address internal receiverOnA = makeAddr("receiver on A");

    /// @dev Locks `value` of a bare token on chain A for bob on chain B, delivers the message, and returns the logs of
    /// the delivery on chain B.
    function _lockAndDeliver(BareToken token, uint256 value) internal returns (address copy, Vm.Log[] memory logs) {
        token.mint(alice, value);
        vm.chainId(CHAIN_A);
        vm.startPrank(alice);
        token.approve(address(mediatorA), type(uint256).max);
        vm.recordLogs();
        mediatorA.relayTokens(address(token), bob, value);
        vm.stopPrank();
        Transit memory transit = _proveForB(vm.getRecordedLogs());
        vm.recordLogs();
        _execute(bridgeB, transit);
        logs = vm.getRecordedLogs();
        assertTrue(bridgeB.messageCallStatus(transit.messageId), "the first message executed");
        copy = mediatorB.bridgedTokenAddress(address(token));
    }

    /// @dev Bob sends `value` of the copy back to `receiverOnA`, and chain A releases the native token.
    function _returnAndDeliver(address copy, uint256 value) internal {
        vm.chainId(CHAIN_B);
        vm.startPrank(bob);
        BridgedToken(copy).approve(address(mediatorB), type(uint256).max);
        vm.recordLogs();
        mediatorB.relayTokens(copy, receiverOnA, value);
        vm.stopPrank();
        Transit memory transit = _deliverToA(vm.getRecordedLogs());
        assertTrue(bridgeA.messageCallStatus(transit.messageId), "the return executed");
    }

    function _logsOf(Vm.Log[] memory logs, address emitter, bytes32 topic)
        internal
        pure
        returns (Vm.Log[] memory found)
    {
        uint256 count;
        for (uint256 i = 0; i < logs.length; i++) {
            if (logs[i].emitter == emitter && logs[i].topics[0] == topic) count++;
        }
        found = new Vm.Log[](count);
        count = 0;
        for (uint256 i = 0; i < logs.length; i++) {
            if (logs[i].emitter == emitter && logs[i].topics[0] == topic) found[count++] = logs[i];
        }
    }

    /// @dev What every end to end test asserts besides the metadata: the registration event, the payout event, the
    /// balances on both chains, and the return trip.
    function _assertTheTrip(BareToken token, address copy, Vm.Log[] memory deliveryLogs) internal {
        Vm.Log[] memory registered =
            _logsOf(deliveryLogs, address(mediatorB), TokenMediator.NewTokenRegistered.selector);
        assertEq(registered.length, 1, "one registration event");
        assertEq(address(uint160(uint256(registered[0].topics[1]))), address(token), "the event names the native token");
        assertEq(address(uint160(uint256(registered[0].topics[2]))), copy, "the event names the copy");

        Vm.Log[] memory paid = _logsOf(deliveryLogs, address(mediatorB), TokenMediator.TokensBridged.selector);
        assertEq(paid.length, 1, "one payout event");
        assertEq(address(uint160(uint256(paid[0].topics[1]))), copy, "the payout names the copy");
        assertEq(address(uint160(uint256(paid[0].topics[2]))), bob, "the payout names the receiver");
        assertEq(abi.decode(paid[0].data, (uint256)), AMOUNT, "the payout amount");

        assertEq(BridgedToken(copy).balanceOf(bob), AMOUNT, "bob holds the amount on chain B");
        assertEq(BridgedToken(copy).totalSupply(), AMOUNT, "the supply of the copy");
        assertEq(token.balanceOf(address(mediatorA)), AMOUNT, "the mediator holds the lock");
        assertEq(mediatorA.mediatorBalance(address(token)), AMOUNT, "the record");
        assertEq(token.balanceOf(alice), 0, "alice sent all");

        _returnAndDeliver(copy, RETURNED);
        assertEq(BridgedToken(copy).balanceOf(bob), AMOUNT - RETURNED, "bob after the return");
        assertEq(BridgedToken(copy).totalSupply(), AMOUNT - RETURNED, "the supply after the return");
        assertEq(token.balanceOf(receiverOnA), RETURNED, "the receiver on chain A holds the returned amount");
        assertEq(token.balanceOf(address(mediatorA)), AMOUNT - RETURNED, "the lock after the return");
        assertEq(mediatorA.mediatorBalance(address(token)), AMOUNT - RETURNED, "the record after the return");
        assertTrue(mediatorA.isBridgedTokenDeployAcknowledged(address(token)), "the return proves the copy");
    }

    /// Claim: a token with a name and no symbol bridges end to end. The copy takes the name for both. Shows: the copy
    /// name is `Only Name from Chain A`, the symbol is `zOnly Name`, the decimals are 18, and the events and balances
    /// are exact on both chains. Matters: the token has no symbol function, and the first relay must not revert.
    function test_aTokenWithOnlyANameBridgesEndToEnd() public {
        OnlyNameToken token = new OnlyNameToken();
        (address copy, Vm.Log[] memory logs) = _lockAndDeliver(token, AMOUNT);

        assertEq(BridgedToken(copy).name(), "Only Name from Chain A", "the name");
        assertEq(BridgedToken(copy).symbol(), "zOnly Name", "the symbol falls back to the name");
        assertEq(BridgedToken(copy).decimals(), 18, "the decimals");
        _assertTheTrip(token, copy, logs);
    }

    /// Claim: a token with a symbol and no name bridges end to end. The copy takes the symbol for both. Shows: the
    /// copy name is `ONLY from Chain A` and the symbol is `zONLY`.
    function test_aTokenWithOnlyASymbolBridgesEndToEnd() public {
        OnlySymbolToken token = new OnlySymbolToken();
        (address copy, Vm.Log[] memory logs) = _lockAndDeliver(token, AMOUNT);

        assertEq(BridgedToken(copy).name(), "ONLY from Chain A", "the name falls back to the symbol");
        assertEq(BridgedToken(copy).symbol(), "zONLY", "the symbol");
        assertEq(BridgedToken(copy).decimals(), 18, "the decimals");
        _assertTheTrip(token, copy, logs);
    }

    /// Claim: a token whose name and symbol are `bytes32` values bridges end to end. Shows: the zero padding is cut, so
    /// the copy name is `Maker from Chain A` and the symbol is `zMKR`, with no zero bytes inside.
    function test_aBytes32NameBridgesEndToEnd() public {
        Bytes32MetadataToken token = new Bytes32MetadataToken();
        (address copy, Vm.Log[] memory logs) = _lockAndDeliver(token, AMOUNT);

        assertEq(BridgedToken(copy).name(), "Maker from Chain A", "the name");
        assertEq(bytes(BridgedToken(copy).name()).length, 18, "no padding in the name");
        assertEq(BridgedToken(copy).symbol(), "zMKR", "the symbol");
        assertEq(bytes(BridgedToken(copy).symbol()).length, 4, "no padding in the symbol");
        _assertTheTrip(token, copy, logs);
    }

    /// Claim: a token whose symbol already starts with Z gets the prefix like any other. Shows: the copy of `ZRX` is
    /// `zZRX`. Matters: the prefix is one letter, and the rule must never read a Z at the start as "already a copy".
    function test_aTokenWhoseSymbolStartsWithZGetsThePrefix() public {
        ZrxToken token = new ZrxToken();
        (address copy, Vm.Log[] memory logs) = _lockAndDeliver(token, AMOUNT);

        assertEq(BridgedToken(copy).name(), "0x Protocol from Chain A", "the name");
        assertEq(BridgedToken(copy).symbol(), "zZRX", "the symbol");
        _assertTheTrip(token, copy, logs);
    }
}
