// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

// Test doubles for the integration test of the explorer bots. They are never deployed anywhere else.
//
// The test deploys the REAL BeaconLightClient and the REAL FeeRouter next to these doubles. The doubles replace the two
// parts that need a beacon chain: the proof verifier (no Groth16 proof exists for a made-up update) and the mediator with
// its message bridge (no receipt proof exists for a made-up message).

import {BeaconLightClient} from "../../../../../src/hardened/BeaconLightClient.sol";
import {FeeRouter} from "../../../../../src/hardened/mediator/FeeRouter.sol";
import {MessageBridge} from "../../../../../src/hardened/MessageBridge.sol";
import {ISP1Verifier} from "../../../../../src/hardened/ISP1Verifier.sol";
import {MockERC20} from "../../../../../src/mocks/MockERC20.sol";
import {MockWrappedNative} from "../../../../../src/mocks/MockWrappedNative.sol";
import {ECDSA} from "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";

/// @dev Accepts what the real Groth16 verifier shape is: 356 proof bytes, of which bytes 4 to 68 hold a 65 byte signature
/// of the oracle over the digest of the program key and the public values. It is the oracle verifier of the local
/// stack with the length of a real proof, so that a proof fits the proof message of the bots.
contract ProofSizedVerifier is ISP1Verifier {
    error InvalidProof();

    address public immutable oracle;

    constructor(address oracle_) {
        oracle = oracle_;
    }

    function verifyProof(bytes32 programVKey, bytes calldata publicValues, bytes calldata proofBytes) external view override {
        if (proofBytes.length != 356) revert InvalidProof();
        bytes32 digest = keccak256(abi.encodePacked(programVKey, sha256(publicValues)));
        (address signer, ECDSA.RecoverError error,) = ECDSA.tryRecoverCalldata(digest, proofBytes[4:69]);
        if (error != ECDSA.RecoverError.NoError || signer != oracle) revert InvalidProof();
    }
}

/// @dev One contract that plays the token mediator and its message bridge for the fee router. `executeMessage` accepts a
/// proof whose anchor slot is `VALID_ANCHOR_SLOT` and nothing else. It then does what the mediator does: it releases the
/// armed tokens to the router and calls `onTokenBridged` with the armed data. The router, the fee maths and the payouts
/// are the real ones.
contract StubMediatorBridge {
    error BadProof();
    error AlreadyDelivered();

    uint64 public constant VALID_ANCHOR_SLOT = 4242;

    address public router;
    address public token;
    uint256 public value;
    bytes public data;
    bool public delivered;

    function bridgeContract() external view returns (address) {
        return address(this);
    }

    function arm(address router_, address token_, uint256 value_, bytes calldata data_) external {
        router = router_;
        token = token_;
        value = value_;
        data = data_;
        delivered = false;
    }

    function executeMessage(MessageBridge.MessageProof calldata proof) external {
        if (proof.anchorHeader.slot != VALID_ANCHOR_SLOT) revert BadProof();
        if (delivered) revert AlreadyDelivered();
        delivered = true;
        MockERC20(token).mint(router, value);
        FeeRouter(payable(router)).onTokenBridged(token, value, data);
    }
}
