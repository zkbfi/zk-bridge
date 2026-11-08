// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {FeeOnTransferToken} from "../../../src/mocks/FeeOnTransferToken.sol";
import {TokenMediator} from "../../../src/hardened/mediator/TokenMediator.sol";
import {MediatorFixture, MockAMB} from "./utils/MediatorSupport.sol";

/// @notice Fuzz tests of the token mediator: the amount that a relay locks is the amount that the message names.
contract TokenMediatorFuzzTest is MediatorFixture {
    /// @dev The fields of the first message of a relay with a receiver other than the sender, which deploys the copy
    /// on the other chain.
    struct DeployMessage {
        address token;
        address recipient;
        uint256 value;
    }

    /// @dev External so that a test can slice the call data of a message with `data[4:]`.
    function decodeDeployMessage(bytes calldata data) external pure returns (DeployMessage memory message) {
        (address token,,,, address recipient, uint256 value) =
            abi.decode(data[4:], (address, string, string, uint8, address, uint256));
        message = DeployMessage(token, recipient, value);
    }

    function _firstMessage() internal view returns (DeployMessage memory) {
        MockAMB.Sent memory message = ambA.messageAt(0);
        assertEq(ambA.sentCount(), 1, "a relay sends one message");
        assertEq(_selectorOf(message.data), TokenMediator.deployAndHandleBridgedTokens.selector);
        return this.decodeDeployMessage(message.data);
    }

    /// Claim: for any amount, a plain token relay locks exactly that amount and the message names it. Shows: for
    /// amounts from 1 to 2^128, the token balance of the mediator, `mediatorBalance`, and the amount in the payload that
    /// the bridge recorded are equal to the amount that the sender gave. Matters: H-13 (accounting is exact for honest
    /// tokens, and the other chain mints or releases what this chain holds).
    function testFuzz_H13_depositAmountIsLockedAndEmitted(uint128 rawAmount) public {
        uint256 amount = bound(rawAmount, 1, type(uint128).max);
        tokenA.mint(alice, amount);
        vm.prank(alice);
        mediatorA.relayTokens(address(tokenA), bob, amount);

        assertEq(tokenA.balanceOf(address(mediatorA)), amount, "the mediator holds the amount");
        assertEq(mediatorA.mediatorBalance(address(tokenA)), amount, "the record equals the held amount");
        DeployMessage memory message = _firstMessage();
        assertEq(message.value, amount, "the message names the held amount");
        assertEq(message.token, address(tokenA));
        assertEq(message.recipient, bob);
    }

    /// Claim: for any amount, a fee-on-transfer relay bridges what arrived, never what the sender asked for. Shows: for
    /// amounts from 1 to 2^100 (amounts under 100 have no fee), the message names the balance that the mediator holds,
    /// the record equals that balance, and both equal the amount less the one percent that the token burns. Matters:
    /// H-13 (the other chain must not mint more than this chain holds).
    function testFuzz_H13_feeOnTransferEventEqualsHeldBalance(uint128 rawAmount) public {
        uint256 amount = bound(rawAmount, 1, uint256(1) << 100);
        FeeOnTransferToken taxed = new FeeOnTransferToken("Taxed", "TAX");
        taxed.mint(alice, amount);
        vm.startPrank(alice);
        taxed.approve(address(mediatorA), amount);
        mediatorA.relayTokens(address(taxed), bob, amount);
        vm.stopPrank();

        uint256 held = taxed.balanceOf(address(mediatorA));
        assertEq(held, amount - amount / 100, "the token took its fee on the way in");
        assertEq(mediatorA.mediatorBalance(address(taxed)), held, "the record equals the held balance");
        assertEq(_firstMessage().value, held, "the message names what arrived");
    }

    /// Claim: the callback gas that a sender states is carried as it is, and only zero is refused. Shows: for any
    /// request, a relay with a call either reverts with `ZeroCallbackGas` (zero) or sends a message whose payload carries
    /// exactly the request, while the gas asked of the bridge stays zero. Matters: the owner's rule, "the message
    /// has to pass the gas limit. there should be no defaults".
    function testFuzz_theCallbackGasIsCarriedAsItIs(uint256 request) public {
        vm.prank(alice);
        if (request == 0) vm.expectRevert(TokenMediator.ZeroCallbackGas.selector);
        mediatorA.relayTokensAndCall(address(tokenA), bob, 1 ether, hex"01", request);
        if (request == 0) {
            assertEq(ambA.sentCount(), 0, "a refused relay sends nothing");
            return;
        }
        bytes memory data = ambA.messageAt(0).data;
        // The first relay of the token deploys its copy: the callback gas is the eighth argument of the payload.
        uint256 gasWord;
        assembly {
            gasWord := mload(add(data, add(36, mul(7, 32))))
        }
        assertEq(gasWord, request, "the payload carries the request");
        assertEq(ambA.messageAt(0).gasLimit, 0, "the bridge is asked for no gas");
    }
}
