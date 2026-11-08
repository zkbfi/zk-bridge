// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {MediatorBuild} from "./MediatorBuild.sol";
import {Vm} from "forge-std/Vm.sol";
import {BeaconLightClient} from "../../../src/hardened/BeaconLightClient.sol";
import {AmbMessageCodec} from "../../../src/hardened/AmbMessageCodec.sol";
import {MessageBridge} from "../../../src/hardened/MessageBridge.sol";
import {TokenMediator} from "../../../src/hardened/mediator/TokenMediator.sol";
import {DynamicProofs} from "./DynamicProofs.sol";
import {GateSupport} from "./GateSupport.sol";

/// @title WorldSupport
/// @notice Two chains in one Foundry test, each with the real `MessageBridge` and the real `TokenMediator`. Chain A has
/// chain identifier 1 and chain B has 369. The bridge of chain A reads `lightClientForA` (which tracks chain B), and the
/// bridge of chain B reads `lightClientForB` (which tracks chain A).
///
/// A message crosses in four steps, and a test controls each one:
/// 1. A test records the logs of one send: `vm.recordLogs()`, the send, `vm.getRecordedLogs()`. One window per send,
///    because the receipt of a send holds ALL the logs of the call (token transfers and the message log).
/// 2. `_proveForB` or `_proveForA` builds the proof of the message log among the recorded logs.
/// 3. `_executeOn...` runs the proof on the other bridge and measures the gas.
/// 4. `_deliverToB` and `_deliverToA` do steps 2 and 3 together.
///
/// The deployment order is part of the contract of this file. The test contract deploys, in this order: `bridgeA`,
/// `mediatorA`, `bridgeB`, `mediatorB`. Each address is predicted with `vm.computeCreateAddress`, so every side knows
/// the other side at construction. Each mediator deploys its own `TokenFactory` from its own nonce, which does not move
/// the nonce of the test contract. The gates exist before the world: `_deployWorld` takes them as arguments.
abstract contract WorldSupport is GateSupport, DynamicProofs {
    MessageBridge internal bridgeA;
    MessageBridge internal bridgeB;
    TokenMediator internal mediatorA;
    TokenMediator internal mediatorB;

    /// @notice What `_proveForA` and `_proveForB` build, and what `_deliverToA` and `_deliverToB` also run.
    /// @param proof The evidence for the destination bridge.
    /// @param source The transaction of the source block that holds the message log.
    /// @param logIndex The position of the message log among the logs of the receipt.
    /// @param messageId The identifier that the log carries in its topic.
    /// @param gasUsed The gas of the call to `executeMessage`. Zero when the proof was only built.
    struct Transit {
        MessageBridge.MessageProof proof;
        SourceTransaction source;
        uint256 logIndex;
        bytes32 messageId;
        uint256 gasUsed;
    }

    /// @dev The fixture gates (detection mode, no beacon roots contract) admit every send.
    function setUp() public virtual override {
        super.setUp();
        _deployWorld(address(gateA), address(gateB));
    }

    // ---------------------------------------------------------------- deployment

    /// @notice Deploys the world again with chosen gates. A test that needs another gate calls it. The old contracts stay
    /// where they are and the state variables point to the new ones.
    /// @param gateOfA The gate that the bridge of chain A calls on every send.
    /// @param gateOfB The gate that the bridge of chain B calls on every send.
    function _deployWorld(address gateOfA, address gateOfB) internal {
        uint256 nonce = vm.getNonce(address(this));
        // Each mediator takes two creations: its factory, then itself (`MediatorBuild`).
        address predictedBridgeA = vm.computeCreateAddress(address(this), nonce);
        address predictedMediatorA = MediatorBuild.predictMediator(address(this), nonce + 1);
        address predictedBridgeB = vm.computeCreateAddress(address(this), nonce + 1 + MediatorBuild.CREATIONS);
        address predictedMediatorB = MediatorBuild.predictMediator(address(this), nonce + 2 + MediatorBuild.CREATIONS);

        vm.chainId(CHAIN_A);
        bridgeA = new MessageBridge(
            address(lightClientForA),
            CHAIN_B,
            predictedBridgeB,
            MessageBridge.BridgeTerms(0, address(lightClientForB), type(uint64).max),
            DEFAULT_CAPELLA_ERA,
            gateOfA
        );
        mediatorA = MediatorBuild.deploy(_mediatorTerms(address(bridgeA), predictedMediatorB), "Chain B");

        vm.chainId(CHAIN_B);
        bridgeB = new MessageBridge(
            address(lightClientForB),
            CHAIN_A,
            predictedBridgeA,
            MessageBridge.BridgeTerms(0, address(lightClientForA), type(uint64).max),
            DEFAULT_CAPELLA_ERA,
            gateOfB
        );
        mediatorB = MediatorBuild.deploy(_mediatorTerms(address(bridgeB), predictedMediatorA), "Chain A");

        assertEq(address(bridgeA), predictedBridgeA, "the nonce order of the world: bridge A");
        assertEq(address(mediatorA), predictedMediatorA, "the nonce order of the world: mediator A");
        assertEq(address(bridgeB), predictedBridgeB, "the nonce order of the world: bridge B");
        assertEq(address(mediatorB), predictedMediatorB, "the nonce order of the world: mediator B");

        _openDepositsWithoutProof(bridgeA);
        _openDepositsWithoutProof(bridgeB);
        vm.chainId(CHAIN_A);
    }

    /// @dev Mediator terms with no flow limiter.
    function _mediatorTerms(address bridge_, address remoteMediator)
        internal
        pure
        returns (TokenMediator.MediatorTerms memory terms)
    {
        terms.bridge = bridge_;
        terms.remoteMediator = remoteMediator;
    }

    // ---------------------------------------------------------------- proofs and delivery

    /// @notice Builds the proof of the message that `bridgeA` sent in `recorded`, for `bridgeB`.
    function _proveForB(Vm.Log[] memory recorded) internal returns (Transit memory transit) {
        return _prove(recorded, bridgeA, bridgeB, lightClientForB, GENESIS_ROOT_A);
    }

    /// @notice Builds the proof of the message that `bridgeB` sent in `recorded`, for `bridgeA`.
    function _proveForA(Vm.Log[] memory recorded) internal returns (Transit memory transit) {
        return _prove(recorded, bridgeB, bridgeA, lightClientForA, GENESIS_ROOT_B);
    }

    /// @notice Builds the proof of a message of `bridgeA` and runs it on `bridgeB`.
    function _deliverToB(Vm.Log[] memory recorded) internal returns (Transit memory transit) {
        transit = _proveForB(recorded);
        _execute(bridgeB, transit);
    }

    /// @notice Builds the proof of a message of `bridgeB` and runs it on `bridgeA`.
    function _deliverToA(Vm.Log[] memory recorded) internal returns (Transit memory transit) {
        transit = _proveForA(recorded);
        _execute(bridgeA, transit);
    }

    /// @notice Runs the proof of `transit` on `destination` as the test contract, and stores the gas of the call.
    /// @dev The figure is the gas of the call to `executeMessage`, with its argument copy. It leaves out the intrinsic
    /// cost of a transaction (21000 and the calldata).
    function _execute(MessageBridge destination, Transit memory transit) internal {
        vm.chainId(destination.localChainId());
        uint256 before = gasleft();
        destination.executeMessage(transit.proof);
        transit.gasUsed = before - gasleft();
    }

    /// @notice The message of the first `UserRequestForAffirmation` log that `emitter` emitted in `recorded`, decoded.
    function _messageOf(Vm.Log[] memory recorded, MessageBridge emitter)
        internal
        view
        returns (AmbMessageCodec.Header memory header, bytes memory data)
    {
        uint256 index = _logIndexOf(recorded, address(emitter), emitter.USER_REQUEST_TOPIC());
        (header, data) = AmbMessageCodec.decode(abi.decode(recorded[index].data, (bytes)));
    }

    function _prove(
        Vm.Log[] memory recorded,
        MessageBridge emitter,
        MessageBridge destination,
        BeaconLightClient client,
        bytes32 genesisRoot
    ) private returns (Transit memory transit) {
        transit.logIndex = _logIndexOf(recorded, address(emitter), emitter.USER_REQUEST_TOPIC());
        transit.messageId = recorded[transit.logIndex].topics[1];
        transit.source = _sourceTransactionOf(recorded);
        (transit.proof,) = _proveMessage(destination, client, genesisRoot, transit.source, transit.logIndex);
    }
}
