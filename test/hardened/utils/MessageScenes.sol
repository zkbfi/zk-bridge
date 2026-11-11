// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {BeaconLightClient} from "../../../src/hardened/BeaconLightClient.sol";
import {BeaconProofVerifier} from "../../../src/hardened/BeaconProofVerifier.sol";
import {MessageBridge} from "../../../src/hardened/MessageBridge.sol";
import {BeaconBlockHeader} from "../../../src/hardened/SSZ.sol";
import {HistoricalScenes} from "./HistoricalScenes.sol";
import {OpeningScenes} from "./OpeningScenes.sol";
import {MessageFixtures} from "./MessageFixtures.sol";
import {MessageRecorder, MessageReverter, MessageBurner, MessageReentrant, MessageSending} from "./MessageTargets.sol";

/// @notice The bridges, the targets and the message proofs of the bridge tests, on top of the beacon scenes. The receipts
/// trie and the transactions trie come from `MessageFixtures`.
///
/// `bridge` is the destination: chain B, at the address that the fixture messages name nowhere, with the fixture remote
/// bridge as its remote. `sourceBridge` is the sending end, chain A, at the address of the emitter of every fixture log,
/// so its first send has the identifier of the first fixture message.
abstract contract MessageScenes is HistoricalScenes, OpeningScenes {
    /// @dev The address of the destination bridge. Fixture messages do not name it.
    address internal constant DESTINATION_BRIDGE = 0x7777777777777777777777777777777777777777;

    MessageBridge internal bridge;
    MessageBridge internal sourceBridge;
    MessageRecorder internal recorder;
    MessageReverter internal reverter;
    MessageBurner internal burner;
    MessageReentrant internal reentrant;
    MessageSending internal sending;

    function setUp() public virtual override {
        super.setUp();
        recorder = MessageRecorder(_putTarget(MessageFixtures.TARGET_RECORDER, address(new MessageRecorder())));
        reverter = MessageReverter(_putTarget(MessageFixtures.TARGET_REVERTER, address(new MessageReverter())));
        burner = MessageBurner(_putTarget(MessageFixtures.TARGET_BURNER, address(new MessageBurner())));
        reentrant = MessageReentrant(_putTarget(MessageFixtures.TARGET_REENTRANT, address(new MessageReentrant())));
        sending = MessageSending(_putTarget(MessageFixtures.TARGET_SENDING, address(new MessageSending())));
        sourceBridge = _newSourceBridge(0);
        bridge = _newDestinationBridge(lightClientForB, 0, DEFAULT_CAPELLA_ERA);
    }

    function _putTarget(address where, address implementation) internal returns (address) {
        vm.etch(where, implementation.code);
        return where;
    }

    // ---------------------------------------------------------------- bridges

    /// @dev The sending end on chain A, open, at the emitter address of the fixture logs.
    function _newSourceBridge(uint64 cutoff) internal returns (MessageBridge created) {
        created = _deploySourceBridge(cutoff, address(gateA));
        _openDepositsWithoutProof(created);
    }

    /// @dev The sending end on chain A with a chosen gate. It is closed: `depositsOpen` is false.
    function _deploySourceBridge(uint64 cutoff, address gate) internal returns (MessageBridge created) {
        vm.chainId(CHAIN_A);
        vm.etch(MessageFixtures.REMOTE_BRIDGE, "");
        vm.store(MessageFixtures.REMOTE_BRIDGE, bytes32(BRIDGE_FLAG_WORD_SLOT), bytes32(0));
        deployCodeTo(
            "MessageBridge.sol:MessageBridge",
            abi.encode(
                address(lightClientForA), CHAIN_B, DESTINATION_BRIDGE,
                MessageBridge.BridgeTerms(cutoff, address(lightClientForB)), DEFAULT_CAPELLA_ERA, gate
            ),
            MessageFixtures.REMOTE_BRIDGE
        );
        created = MessageBridge(MessageFixtures.REMOTE_BRIDGE);
    }

    /// @dev The destination on chain B, open, with the light client and the era that the caller names.
    function _newDestinationBridge(BeaconLightClient client, uint64 cutoff, uint64 capellaEra)
        internal
        returns (MessageBridge created)
    {
        created = _deployDestinationBridge(client, cutoff, capellaEra, address(gateB));
        _openDepositsWithoutProof(created);
        _registerBridge(created);
    }

    /// @dev The destination on chain B with a chosen gate. It is closed: `depositsOpen` is false. An earlier bridge at
    /// the address is wiped first.
    function _deployDestinationBridge(BeaconLightClient client, uint64 cutoff, uint64 capellaEra, address gate)
        internal
        returns (MessageBridge created)
    {
        vm.chainId(CHAIN_B);
        vm.etch(DESTINATION_BRIDGE, "");
        vm.store(DESTINATION_BRIDGE, bytes32(BRIDGE_FLAG_WORD_SLOT), bytes32(0));
        deployCodeTo(
            "MessageBridge.sol:MessageBridge",
            abi.encode(
                address(client), CHAIN_A, MessageFixtures.REMOTE_BRIDGE,
                MessageBridge.BridgeTerms(cutoff, address(lightClientForA)), capellaEra, gate
            ),
            DESTINATION_BRIDGE
        );
        created = MessageBridge(DESTINATION_BRIDGE);
    }

    // ---------------------------------------------------------------- scenes

    /// @dev A recent scene (the anchor is 2000 slots above the source block) with the layouts added to `target`.
    function _messageScene(MessageBridge target) internal returns (Scene memory scene) {
        SceneParams memory params = _defaultParams();
        scene = _buildScene(MessageFixtures.deliver(), params, _messageHeaderRlp());
        _storeScene(params, scene);
        _addLayouts(target, params, scene);
    }

    /// @notice A light client that starts at `initialSlot`, and a destination bridge on chain B with `capellaEra`. The
    /// fixture's `lightClientForB` is replaced, so every later scene stores its headers in the new client.
    function _historicalWorld(uint64 initialSlot, uint64 capellaEra) internal returns (MessageBridge created) {
        _freshLightClientForB(initialSlot);
        created = _newDestinationBridge(lightClientForB, 0, capellaEra);
    }

    /// @dev Builds a historical scene for the first fixture message (an anchor more than 8192 slots above its block), makes
    /// `bridge` a new destination bridge on a fresh light client with `capellaEra` 758, and returns the message and its proof.
    function _historicalMessage()
        internal
        returns (MessageFixtures.Named memory named, MessageBridge.MessageProof memory proof)
    {
        uint64 anchor = 6_400_000;
        uint64 capellaEra = 758;
        _freshLightClientForB(6_000_000);
        bridge = _newDestinationBridge(lightClientForB, 0, capellaEra);
        uint64[] memory depositSlots = new uint64[](1);
        depositSlots[0] = 6_250_000;
        HistoricalParams memory params = _historicalParams(anchor, capellaEra, 91, 6_300_000, depositSlots);
        HistoricalScene memory scene = _buildHistorical(params, _messageHeaderRlp());
        _storeHistorical(params, scene);
        _addBodyRows(bridge, scene);
        _addHistoricalRow(bridge, params, scene);
        assertGt(anchor - depositSlots[0], 8192, "the scene is on the historical path");
        named = MessageFixtures.deliver();
        proof = _proofOf(scene.anchorHeader, scene.depositHeaders[0], scene.historicalBranches[0], scene.blockHashBranches[0], scene.sourceFork, _messageHeaderRlp(), named);
    }

    /// @dev A new light client that starts at `initialSlot`. Every later scene stores its headers in it.
    function _freshLightClientForB(uint64 initialSlot) internal returns (BeaconLightClient) {
        lightClientForB = new BeaconLightClient(
            address(verifier),
            LIGHT_CLIENT_VKEY,
            GENESIS_ROOT_A,
            SLOTS_PER_PERIOD,
            LIGHT_CLIENT_GENESIS_TIME,
            LIGHT_CLIENT_SECONDS_PER_SLOT,
            initialSlot,
            INITIAL_HEADER_ROOT,
            COMMITTEE_100,
            COMMITTEE_101
        );
        return lightClientForB;
    }
}
