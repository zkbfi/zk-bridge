// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Script} from "forge-std/Script.sol";
import {console2} from "forge-std/console2.sol";
import {AmbMessageCodec} from "src/hardened/AmbMessageCodec.sol";
import {TokenMediator} from "src/hardened/mediator/TokenMediator.sol";

/// @dev Calls the library through an external function, because `encode` takes calldata.
contract CodecHarness {
    function encode(AmbMessageCodec.Header memory header, bytes calldata data) external pure returns (bytes memory) {
        return AmbMessageCodec.encode(header, data);
    }

    function prefix(uint256 chainId, address bridge) external pure returns (bytes32) {
        return AmbMessageCodec.messageIdPrefix(chainId, bridge);
    }
}

/// @title GenerateAmbVectors
/// @notice Prints test vectors of the message codec and of the mediator payloads, one JSON object per line.
/// Run from the repository root:
///   forge script explorer/shared/vectors/GenerateAmbVectors.s.sol --tc GenerateAmbVectors --root . 2>&1 | grep '^  VECTOR ' | sed 's/^  VECTOR //'
/// The test in explorer/shared/test/amb.test.ts reads the saved lines in test/fixtures/amb-vectors.jsonl.
contract GenerateAmbVectors is Script {
    address private constant BRIDGE_A = 0x1111111111111111111111111111111111111111;
    address private constant BRIDGE_B = 0xabCDeF0123456789AbcdEf0123456789aBCDEF01;
    address private constant SENDER = 0x70997970C51812dc3A010C7d01b50e0d17dc79C8;
    address private constant EXECUTOR = 0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC;

    struct Spec {
        uint256 sourceChainId;
        uint256 destinationChainId;
        address bridge;
        uint64 nonce;
        uint8 dataType;
        uint32 gasLimit;
        bytes data;
    }

    function run() external {
        CodecHarness harness = new CodecHarness();
        _message(harness, Spec(1, 369, BRIDGE_A, 0, 0x00, 1_000_000, hex""));
        _message(harness, Spec(369, 1, BRIDGE_B, 7, 0x80, 250_000, hex"deadbeef"));
        _message(harness, Spec(1, 369, BRIDGE_A, type(uint64).max, 0x00, 10_000_000, new bytes(300)));
        _message(harness, Spec(0, 256, BRIDGE_B, 1, 0x00, 100, hex"00"));
        _message(harness, Spec((1 << 40) + 5, 65535, BRIDGE_A, 42, 0x80, 4_294_967_295, hex"0102030405060708090a0b0c0d0e0f10"));
        _message(harness, Spec(type(uint256).max, 1, BRIDGE_B, 3, 0x00, 12_345, abi.encode(uint256(1), uint256(2))));
        _mediator();
    }

    function _message(CodecHarness harness, Spec memory spec) private {
        AmbMessageCodec.Header memory header = AmbMessageCodec.Header({
            messageId: harness.prefix(spec.sourceChainId, spec.bridge) | bytes32(uint256(spec.nonce)),
            sender: SENDER,
            executor: EXECUTOR,
            gasLimit: spec.gasLimit,
            dataType: spec.dataType,
            sourceChainId: spec.sourceChainId,
            destinationChainId: spec.destinationChainId
        });
        console2.log(_json(header, spec.bridge, spec.nonce, spec.data, harness.encode(header, spec.data)));
    }

    function _json(
        AmbMessageCodec.Header memory header,
        address bridge,
        uint64 nonce,
        bytes memory data,
        bytes memory encoded
    ) private pure returns (string memory) {
        string memory chains = string.concat(
            "\"sourceChainId\":\"", vm.toString(header.sourceChainId),
            "\",\"destinationChainId\":\"", vm.toString(header.destinationChainId), "\","
        );
        string memory ids = string.concat(
            "\"bridge\":\"", vm.toString(bridge),
            "\",\"nonce\":\"", vm.toString(uint256(nonce)),
            "\",\"messageId\":\"", vm.toString(header.messageId), "\","
        );
        string memory parties = string.concat(
            "\"sender\":\"", vm.toString(header.sender),
            "\",\"executor\":\"", vm.toString(header.executor),
            "\",\"gasLimit\":", vm.toString(uint256(header.gasLimit)),
            ",\"dataType\":", vm.toString(uint256(header.dataType)), ","
        );
        return string.concat(
            "VECTOR {\"kind\":\"message\",", chains, ids, parties,
            "\"data\":\"", vm.toString(data), "\",\"encoded\":\"", vm.toString(encoded), "\"}"
        );
    }

    function _mediator() private {
        address token = 0xdAC17F958D2ee523a2206206994597C13D831ec7;
        address recipient = 0x90F79bf6EB2c4f870365E785982E1f101E93b906;
        _payload("handleNativeTokens", abi.encodeWithSelector(TokenMediator.handleNativeTokens.selector, token, recipient, 5 ether));
        _payload("handleBridgedTokens", abi.encodeWithSelector(TokenMediator.handleBridgedTokens.selector, token, recipient, 123));
        _payload("handleNativeTokensAndCall", abi.encodeWithSelector(TokenMediator.handleNativeTokensAndCall.selector, token, recipient, 99, hex"c0ffee", 750_000));
        _payload("deployAndHandleBridgedTokens", abi.encodeWithSelector(TokenMediator.deployAndHandleBridgedTokens.selector, token, "Tether USD", "USDT", uint8(6), recipient, 1_000_000));
        _payload("deployAndHandleBridgedTokensAndCall", abi.encodeWithSelector(TokenMediator.deployAndHandleBridgedTokensAndCall.selector, token, "Wrapped Ether", "WETH", uint8(18), recipient, 7, hex"aabb", 1_500_000));
    }

    function _payload(string memory handler, bytes memory data) private {
        console2.log(string.concat("VECTOR {\"kind\":\"mediator\",\"handler\":\"", handler, "\",\"data\":\"", vm.toString(data), "\"}"));
    }
}
