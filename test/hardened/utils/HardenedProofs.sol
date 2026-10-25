// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {BeaconLightClient} from "../../../src/hardened/BeaconLightClient.sol";
import {MessageBridge} from "../../../src/hardened/MessageBridge.sol";

/// @title HardenedProofs
/// @notice Constants and the reference prover. The oracle key signs the digest that
/// `OracleSP1Verifier` expects, which models a sound proof system: a proof exists only for
/// statements that the test chose to prove.
abstract contract HardenedProofs is Test {
    uint64 internal constant CHAIN_A = 1;
    uint64 internal constant CHAIN_B = 369;
    uint64 internal constant SLOTS_PER_PERIOD = 8192;
    uint64 internal constant CHECKPOINT_PERIOD = 100;
    uint64 internal constant INITIAL_SLOT = CHECKPOINT_PERIOD * SLOTS_PER_PERIOD + 64;
    /// @dev The light clients of the unit tests count one slot per second from time 1, so the slot at a timestamp is the
    /// timestamp minus 1. `FIXTURE_START_TIME` is far above every slot that the tests use, so no honest head lies in the future.
    uint64 internal constant LIGHT_CLIENT_GENESIS_TIME = 1;
    uint64 internal constant LIGHT_CLIENT_SECONDS_PER_SLOT = 1;
    uint64 internal constant FIXTURE_START_TIME = 2_000_000_000;

    bytes32 internal constant GENESIS_ROOT_A = keccak256("genesis validators root of chain A");
    bytes32 internal constant GENESIS_ROOT_B = keccak256("genesis validators root of chain B");
    bytes32 internal constant LIGHT_CLIENT_VKEY = keccak256("light client program");
        bytes32 internal constant INITIAL_HEADER_ROOT = keccak256("checkpoint header root");
    bytes32 internal constant COMMITTEE_100 = keccak256("sync committee of period 100");
    bytes32 internal constant COMMITTEE_101 = keccak256("sync committee of period 101");
    bytes32 internal constant COMMITTEE_102 = keccak256("sync committee of period 102");
    uint256 internal constant ORACLE_KEY = uint256(keccak256("hardened reference prover oracle"));

    /// @dev The storage slot of the word that holds the nonce (the low 8 bytes), the flag `depositsOpen` (the next byte)
    /// and the sender of the context in `MessageBridge`. A test pins it to the contract.
    uint256 internal constant BRIDGE_FLAG_WORD_SLOT = 0;
    /// @dev The bit offset of `depositsOpen` in that word: after the 8 bytes of the nonce.
    uint256 internal constant BRIDGE_FLAG_BIT_OFFSET = 64;

    /// @notice Opens sends on `bridge` by writing the flag, with no proof. For tests that are about something else than the
    /// opening: the opening tests use the real `openDeposits`. The write keeps the other fields of the word, and the function
    /// reads the flag back so that a moved slot fails here and not silently.
    function _openDepositsWithoutProof(MessageBridge bridge) internal {
        bytes32 word = vm.load(address(bridge), bytes32(BRIDGE_FLAG_WORD_SLOT));
        vm.store(address(bridge), bytes32(BRIDGE_FLAG_WORD_SLOT), word | bytes32(uint256(1) << BRIDGE_FLAG_BIT_OFFSET));
        require(bridge.depositsOpen(), "HardenedProofs: the flag slot moved");
    }

    /// @notice `bridge` after `_openDepositsWithoutProof`, so a builder can return an open bridge in one expression. A
    /// construction that `vm.expectRevert` caught leaves no code at the address, and the bridge passes through untouched.
    function _opened(MessageBridge bridge) internal returns (MessageBridge) {
        if (address(bridge).code.length == 0) return bridge;
        _openDepositsWithoutProof(bridge);
        return bridge;
    }

    /// @notice The reference prover: signs the statement as `OracleSP1Verifier` expects.
    function _prove(bytes32 programVKey, bytes memory publicValues) internal pure returns (bytes memory) {
        bytes32 digest = keccak256(abi.encodePacked(programVKey, sha256(publicValues)));
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(ORACLE_KEY, digest);
        return abi.encodePacked(r, s, v);
    }

    /// @notice Proof of a light-client statement.
    function _lightClientProof(BeaconLightClient.LightClientOutput memory output) internal pure returns (bytes memory) {
        return _prove(LIGHT_CLIENT_VKEY, abi.encode(output));
    }

    /// @notice An honest next output for `client`: 32 slots ahead, in the same period as the head.
    function _nextOutput(BeaconLightClient client, bytes32 genesisRoot, bytes32 executionBlockHash)
        internal
        view
        returns (BeaconLightClient.LightClientOutput memory output)
    {
        uint64 head = client.head();
        return _outputAt(client, genesisRoot, head + 32, executionBlockHash);
    }

    /// @notice An output for an explicit new slot. The committees follow the stored values.
    function _outputAt(BeaconLightClient client, bytes32 genesisRoot, uint64 newSlot, bytes32 executionBlockHash)
        internal
        view
        returns (BeaconLightClient.LightClientOutput memory output)
    {
        uint64 head = client.head();
        uint64 period = client.periodOf(newSlot);
        output = BeaconLightClient.LightClientOutput({
            genesisValidatorsRoot: genesisRoot,
            previousHeaderRoot: client.headers(head),
            previousHeadSlot: head,
            previousSyncCommitteeHash: client.syncCommittees(client.periodOf(head)),
            startNextSyncCommitteeHash: client.syncCommittees(client.periodOf(head) + 1),
            newHeaderRoot: keccak256(abi.encode("header", newSlot)),
            newHeadSlot: newSlot,
            executionBlockHash: executionBlockHash,
            executionBlockNumber: uint64(1_000_000 + newSlot),
            syncCommitteeHash: _committeeFor(client, period),
            nextSyncCommitteeHash: client.syncCommittees(period + 1)
        });
    }

    /// @notice The stored committee of a period, or a fixed stand-in for a period the client has not stored yet.
    /// A crossing into an empty period writes the output's committee (contract rule 4), so the stand-in models the
    /// committee that the folded program proved.
    function _committeeFor(BeaconLightClient client, uint64 period) internal view returns (bytes32) {
        bytes32 stored = client.syncCommittees(period);
        if (stored != bytes32(0)) return stored;
        return keccak256(abi.encode("folded committee of period", period));
    }

    /// @notice Proves and submits an output.
    function _submit(BeaconLightClient client, BeaconLightClient.LightClientOutput memory output) internal {
        client.update(_lightClientProof(output), abi.encode(output));
    }

    /// @notice Finalizes one execution block hash on `client` through an honest update.
    function _finalize(BeaconLightClient client, bytes32 genesisRoot, bytes32 executionBlockHash) internal {
        _submit(client, _nextOutput(client, genesisRoot, executionBlockHash));
    }

    /// @notice Proves an output, then expects the update to revert with `revertData`.
    /// @dev The proof is built before `expectRevert`, because `vm.sign` is itself a call that would consume the expectation.
    function _submitExpectingRevert(
        BeaconLightClient client,
        BeaconLightClient.LightClientOutput memory output,
        bytes memory revertData
    ) internal {
        bytes memory proof = _lightClientProof(output);
        bytes memory values = abi.encode(output);
        vm.expectRevert(revertData);
        client.update(proof, values);
    }

    /// @notice Revert data for a custom error without arguments.
    function _selector(bytes4 selector) internal pure returns (bytes memory) {
        return abi.encodePacked(selector);
    }
}
