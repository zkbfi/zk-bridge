// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Vm} from "forge-std/Vm.sol";
import {MockERC20} from "../../../src/mocks/MockERC20.sol";
import {AmbMessageCodec} from "../../../src/hardened/AmbMessageCodec.sol";
import {BridgedToken} from "../../../src/hardened/mediator/BridgedToken.sol";
import {TokenMediator} from "../../../src/hardened/mediator/TokenMediator.sol";
import {WorldSupport} from "../utils/WorldSupport.sol";
import {RecordingReceiver} from "./utils/MediatorSupport.sol";

/// @notice The first message of a native token carries its name and its symbol, and the copy stores both. The cost of
/// the deployment grows with their length: measured at about 1,058,000 to 1,153,000 gas for a short name and 1,142 to 1,419
/// gas for each further byte of name and symbol together. A fixed limit of 2,000,000 gas ran out at a name of about 627 bytes, and
/// then every later message of that token failed. The tests run on the real `MessageBridge`, where the limit of the
/// message is the gas that the call gets.
contract TokenMediatorDeployGasTest is WorldSupport {
    uint256 internal constant AMOUNT = 10 ether;
    /// @dev The rule that the mediator documents: a base and a gas amount for each byte of name and symbol, with a
    /// margin over the measured 1,153,000 and 1,419. Written out here so a change to the rule fails a test.
    uint256 internal constant EXPECTED_BASE = 1_300_000;
    uint256 internal constant EXPECTED_PER_BYTE = 1_600;

    function _text(uint256 length, bytes1 letter) internal pure returns (string memory) {
        bytes memory text = new bytes(length);
        for (uint256 i = 0; i < length; i++) {
            text[i] = letter;
        }
        return string(text);
    }

    function _expectedLimit(uint256 nameLength, uint256 symbolLength) internal pure returns (uint256) {
        uint256 computed = EXPECTED_BASE + EXPECTED_PER_BYTE * (nameLength + symbolLength);
        return computed > 2_000_000 ? computed : 2_000_000;
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

    function _gasLimitOfMessage(Vm.Log[] memory recorded) internal view returns (uint256) {
        (AmbMessageCodec.Header memory header,) = _messageOf(recorded, bridgeA);
        return header.gasLimit;
    }

    /// Claim: a token with a 5,000-byte name deploys its copy through the real bridge, and a second message of the same
    /// token delivers too. Shows: the call status of the bridge is true for both, the copy has the full name and the
    /// symbol, and the receiver holds both amounts. The limit of the message is the rule: 1,300,000 plus 1,600 for each
    /// byte of name and symbol. Matters: before the rule, the limit was 2,000,000, the deployment ran out of gas at about
    /// 627 bytes, the bridge marked the message as failed for good, and the tokens stayed locked.
    function test_aFiveThousandByteNameDeploysThroughTheRealBridge() public {
        MockERC20 token = _tokenWith(5_000, 3);

        Vm.Log[] memory first = _relay(token);
        assertEq(_gasLimitOfMessage(first), _expectedLimit(5_000, 3), "the limit follows the length");
        Transit memory firstTransit = _deliverToB(first);
        assertTrue(bridgeB.messageCallStatus(firstTransit.messageId), "the deployment succeeded");

        address copy = mediatorB.bridgedTokenAddress(address(token));
        assertGt(copy.code.length, 0, "the copy exists");
        assertEq(BridgedToken(copy).name(), string.concat(_text(5_000, "n"), " from Chain A"), "the whole name");
        assertEq(BridgedToken(copy).symbol(), string.concat("zkb", _text(3, "s")), "the symbol");
        assertEq(BridgedToken(copy).balanceOf(bob), AMOUNT, "the receiver holds the first amount");

        Transit memory secondTransit = _deliverToB(_relay(token));
        assertTrue(bridgeB.messageCallStatus(secondTransit.messageId), "a later message delivers");
        assertEq(BridgedToken(copy).balanceOf(bob), 2 * AMOUNT, "the receiver holds both amounts");
        assertEq(BridgedToken(copy).totalSupply(), 2 * AMOUNT, "the supply is both amounts");
        assertEq(mediatorA.mediatorBalance(address(token)), 2 * AMOUNT, "the record on chain A");
    }

    /// Claim: the limit is the default of 2,000,000 for a short name, and it grows with the name and the symbol
    /// together. Shows: lengths of 3 and 3, 600 and 3 (still below the default, so 2,000,000), 700 and 3, 3 and 1,000,
    /// and 400 and 400 give the exact rule. Matters: the symbol is stored too, so it counts the same as the name.
    function test_theDefaultLimitGrowsWithTheNameAndTheSymbol() public {
        uint256[2][5] memory lengths =
            [[uint256(3), 3], [uint256(600), 3], [uint256(700), 3], [uint256(3), 1_000], [uint256(400), 400]];
        for (uint256 i = 0; i < lengths.length; i++) {
            MockERC20 token = _tokenWith(lengths[i][0], lengths[i][1]);
            Vm.Log[] memory recorded = _relay(token);
            assertEq(
                _gasLimitOfMessage(recorded), _expectedLimit(lengths[i][0], lengths[i][1]), "the limit of the message"
            );
            Transit memory transit = _deliverToB(recorded);
            assertTrue(bridgeB.messageCallStatus(transit.messageId), "every length deploys");
        }
        assertEq(_expectedLimit(3, 3), 2_000_000, "short names keep the default");
        assertGt(_expectedLimit(700, 3), 2_000_000, "long names get more");
    }

    /// Claim: a first message with a call adds the callback limit to the deploy limit that follows the length. Shows:
    /// the limit of the message and the callback of the receiver after the deployment.
    function test_aDeployWithACallAddsTheCallbackLimit() public {
        MockERC20 token = _tokenWith(2_000, 3);
        RecordingReceiver receiver = new RecordingReceiver();
        vm.chainId(CHAIN_A);
        vm.recordLogs();
        vm.prank(alice);
        mediatorA.relayTokensAndCall(address(token), address(receiver), AMOUNT, hex"abcd");
        Vm.Log[] memory recorded = vm.getRecordedLogs();

        assertEq(_gasLimitOfMessage(recorded), _expectedLimit(2_000, 3) + 750_000, "deploy limit plus callback limit");
        Transit memory transit = _deliverToB(recorded);
        assertTrue(bridgeB.messageCallStatus(transit.messageId), "delivered");
        assertEq(receiver.calls(), 1, "the callback ran");
        assertEq(receiver.lastData(), hex"abcd");
        assertEq(BridgedToken(mediatorB.bridgedTokenAddress(address(token))).balanceOf(address(receiver)), AMOUNT);
    }

    /// Claim: a name so long that the deployment needs more than the maximum of the bridge is refused at the source,
    /// before any token moves. Shows: the error carries the limit that the rule asks for and the maximum of 10,000,000.
    /// Matters: the sender learns at once, and does not lock tokens that no message can deploy.
    function test_aNameBeyondTheBridgeMaximumIsRefusedAtTheSource() public {
        MockERC20 token = _tokenWith(9_000, 3);
        uint256 balanceBefore = token.balanceOf(alice);
        vm.chainId(CHAIN_A);
        vm.prank(alice);
        vm.expectRevert(
            abi.encodeWithSelector(
                TokenMediator.GasLimitAboveBridgeMaximum.selector, EXPECTED_BASE + EXPECTED_PER_BYTE * 9_003, 10_000_000
            )
        );
        mediatorA.relayTokens(address(token), bob, AMOUNT);
        assertEq(token.balanceOf(alice), balanceBefore, "nothing moved");
        assertEq(mediatorA.mediatorBalance(address(token)), 0, "nothing recorded");
    }
}
