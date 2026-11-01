// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Vm} from "forge-std/Vm.sol";
import {MockERC20} from "../../../src/mocks/MockERC20.sol";
import {AmbMessageCodec} from "../../../src/hardened/AmbMessageCodec.sol";
import {MessageBridge} from "../../../src/hardened/MessageBridge.sol";
import {BridgedToken} from "../../../src/hardened/mediator/BridgedToken.sol";
import {TokenMediator} from "../../../src/hardened/mediator/TokenMediator.sol";
import {WorldSupport} from "../utils/WorldSupport.sol";
import {RecordingReceiver, TEST_CALLBACK_GAS} from "./utils/MediatorSupport.sol";

/// @notice The first message of a native token carries its name and its symbol, and the copy stores both, so the
/// deployment costs about 1,060,000 to 1,160,000 gas for a short name and 1,140 to 1,420 gas for each further byte. The
/// mediator once gave this message a gas limit that grew with the name, and refused names that needed more than the
/// bridge allowed. Now the message carries no gas number: the executor brings the gas, and too little gas reverts the
/// delivery, which can run again. These tests run on the real `MessageBridge`.
contract TokenMediatorDeployGasTest is WorldSupport {
    uint256 internal constant AMOUNT = 10 ether;

    function _text(uint256 length, bytes1 letter) internal pure returns (string memory) {
        bytes memory text = new bytes(length);
        for (uint256 i = 0; i < length; i++) {
            text[i] = letter;
        }
        return string(text);
    }

    function _tokenWith(uint256 nameLength, uint256 symbolLength) internal returns (MockERC20 token) {
        token = new MockERC20(_text(nameLength, "n"), _text(symbolLength, "s"));
        token.mint(alice, 1_000 ether);
        vm.prank(alice);
        token.approve(address(mediatorA), type(uint256).max);
    }

    function _relay(MockERC20 token) internal returns (Vm.Log[] memory) {
        vm.chainId(CHAIN_A);
        vm.recordLogs();
        vm.prank(alice);
        mediatorA.relayTokens(address(token), bob, AMOUNT);
        return vm.getRecordedLogs();
    }

    function _gasFieldOf(Vm.Log[] memory recorded) internal view returns (uint256) {
        (AmbMessageCodec.Header memory header,) = _messageOf(recorded, bridgeA);
        return header.gasLimit;
    }

    /// @dev Runs the proof on chain B with exactly `gas` and reports whether the call went through. The state is kept.
    function _executeWithGas(Transit memory transit, uint256 gas) internal returns (bool ok) {
        vm.chainId(CHAIN_B);
        (ok,) = address(bridgeB).call{gas: gas}(abi.encodeCall(MessageBridge.executeMessage, (transit.proof)));
    }

    /// Claim: the first send of a token needs no gas number. Shows: the message carries zero in its gas field; a
    /// delivery with 600,000 gas (too little for the copy) reverts and leaves the message undelivered with no copy; the
    /// same proof with 3,000,000 gas deploys the copy and pays the receiver. Matters: the owner's rule, "if anyone can
    /// call them and they run out of gas, does it not just revert up the chain?": the copy deployment needs no
    /// special limit, because starving it costs nothing but the executor's own transaction.
    function test_aFirstSendNeedsNoGasNumber() public {
        MockERC20 token = _tokenWith(5, 3);
        Vm.Log[] memory recorded = _relay(token);
        assertEq(_gasFieldOf(recorded), 0, "the message carries no gas number");
        Transit memory transit = _proveForB(recorded);

        assertFalse(_executeWithGas(transit, 600_000), "too little gas reverts");
        assertFalse(bridgeB.messageCallStatus(transit.messageId), "the message waits");
        assertEq(mediatorB.bridgedTokenAddress(address(token)), address(0), "no copy yet");

        assertTrue(_executeWithGas(transit, 3_000_000), "enough gas delivers");
        address copy = mediatorB.bridgedTokenAddress(address(token));
        assertEq(BridgedToken(copy).balanceOf(bob), AMOUNT, "the receiver holds the amount");
    }

    /// Claim: a token with a 5,000-byte name deploys its copy through the real bridge, and a second message of the same
    /// token delivers too. Shows: the call status of the bridge is true for both, the copy has the full name and the
    /// symbol, and the receiver holds both amounts. Matters: a fixed limit once ran out at about 627 bytes and made the
    /// message fail for good; with no limit the executor brings what the name needs.
    function test_aFiveThousandByteNameDeploysThroughTheRealBridge() public {
        MockERC20 token = _tokenWith(5_000, 3);

        Transit memory firstTransit = _deliverToB(_relay(token));
        assertTrue(bridgeB.messageCallStatus(firstTransit.messageId), "the deployment succeeded");

        address copy = mediatorB.bridgedTokenAddress(address(token));
        assertGt(copy.code.length, 0, "the copy exists");
        assertEq(BridgedToken(copy).name(), string.concat(_text(5_000, "n"), " from Chain A"), "the whole name");
        assertEq(BridgedToken(copy).symbol(), string.concat("z", _text(3, "s")), "the symbol");
        assertEq(BridgedToken(copy).balanceOf(bob), AMOUNT, "the receiver holds the first amount");

        Transit memory secondTransit = _deliverToB(_relay(token));
        assertTrue(bridgeB.messageCallStatus(secondTransit.messageId), "a later message delivers");
        assertEq(BridgedToken(copy).balanceOf(bob), 2 * AMOUNT, "the receiver holds both amounts");
        assertEq(BridgedToken(copy).totalSupply(), 2 * AMOUNT, "the supply is both amounts");
        assertEq(mediatorA.mediatorBalance(address(token)), 2 * AMOUNT, "the record on chain A");
    }

    /// Claim: a first message with a call carries the callback gas of the sender and nothing else. Shows: the gas field
    /// is zero, the last argument of the payload is the callback gas, and the callback of the receiver runs after the deployment.
    function test_aDeployWithACallCarriesOnlyTheCallbackGas() public {
        MockERC20 token = _tokenWith(2_000, 3);
        RecordingReceiver receiver = new RecordingReceiver();
        vm.chainId(CHAIN_A);
        vm.recordLogs();
        vm.prank(alice);
        mediatorA.relayTokensAndCall(address(token), address(receiver), AMOUNT, hex"abcd", TEST_CALLBACK_GAS);
        Vm.Log[] memory recorded = vm.getRecordedLogs();

        (AmbMessageCodec.Header memory header, bytes memory data) = _messageOf(recorded, bridgeA);
        assertEq(header.gasLimit, 0, "the gas field is zero");
        // The callback gas is the eighth argument: the eighth word of the head, after the selector.
        uint256 gasWord;
        assembly {
            gasWord := mload(add(data, add(36, mul(7, 32))))
        }
        assertEq(gasWord, TEST_CALLBACK_GAS, "the payload carries the callback gas as its last argument");

        Transit memory transit = _deliverToB(recorded);
        assertTrue(bridgeB.messageCallStatus(transit.messageId), "delivered");
        assertEq(receiver.calls(), 1, "the callback ran");
        assertEq(receiver.lastData(), hex"abcd");
        assertEq(BridgedToken(mediatorB.bridgedTokenAddress(address(token))).balanceOf(address(receiver)), AMOUNT);
    }

    /// Claim: a name that once needed more than the old bridge maximum of 10,000,000 gas is no longer refused at the
    /// source, and its copy deploys when the executor brings the gas. Shows: a 9,000-byte name relays, and delivers.
    /// Matters: the source has no gas rule left that could refuse a token.
    function test_aNineThousandByteNameRelaysAndDeploys() public {
        MockERC20 token = _tokenWith(9_000, 3);
        Transit memory transit = _deliverToB(_relay(token));
        assertTrue(bridgeB.messageCallStatus(transit.messageId), "delivered");
        assertEq(BridgedToken(mediatorB.bridgedTokenAddress(address(token))).balanceOf(bob), AMOUNT);
    }
}
