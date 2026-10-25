// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {BeaconLightClient} from "../../../src/hardened/BeaconLightClient.sol";
import {BeaconProofVerifier} from "../../../src/hardened/BeaconProofVerifier.sol";
import {WithdrawalScenes} from "./WithdrawalScenes.sol";

/// @notice The model of the remote chain for the tests of the deposit lock. A contract that has an `openDeposits`
/// (the vault and the message bridge) is opened with the proof that this model builds. The state tries here have one leaf
/// each, which is a valid trie. Branch and extension nodes of real tries are covered by the Anvil tests of the prover,
/// which use `eth_getProof`.
abstract contract OpeningScenes is WithdrawalScenes {
    /// @dev The mapping `executionBlockHashes` is the fourth declaration of `BeaconLightClient`: slot 3.
    uint256 internal constant EXECUTION_BLOCK_HASHES_SLOT = 3;
    /// @dev A slot at which the remote light client stores its first update, below the deposit slot of the first scene.
    uint64 internal constant FIRST_UPDATE_SLOT = 823_900;

    // ---------------------------------------------------------------- the model of the remote chain

    /// @dev The trie key of a storage slot or an account: the hash of the 32-byte slot or of the 20-byte address.
    function _leaf(bytes memory trieKey, bytes memory content) internal pure returns (bytes memory) {
        bytes[] memory items = new bytes[](2);
        items[0] = _rlpBytes(bytes.concat(bytes1(0x20), trieKey));
        items[1] = _rlpBytes(content);
        return _rlpList(items);
    }

    function _trimmed(bytes32 value) internal pure returns (bytes memory) {
        uint256 skip;
        while (skip < 32 && value[skip] == 0) skip++;
        bytes memory out = new bytes(32 - skip);
        for (uint256 i = 0; i < out.length; i++) {
            out[i] = value[skip + i];
        }
        return out;
    }

    function _account(bytes32 storageRoot, address contractAddress, uint256 fieldCount)
        internal
        view
        returns (bytes memory)
    {
        bytes[] memory items = new bytes[](fieldCount);
        bytes[4] memory all = [
            _rlpBytes(hex"01"),
            _rlpBytes(""),
            _rlpBytes(abi.encodePacked(storageRoot)),
            _rlpBytes(abi.encodePacked(contractAddress.codehash))
        ];
        for (uint256 i = 0; i < fieldCount; i++) {
            items[i] = all[i];
        }
        return _rlpList(items);
    }

    /// @dev A block header whose fourth item is `stateRoot`. The vault reads that item and no other.
    function _header(bytes32 stateRoot) internal pure returns (bytes memory) {
        bytes[] memory items = new bytes[](6);
        items[0] = _rlpBytes(abi.encodePacked(keccak256("parent")));
        items[1] = _rlpBytes(abi.encodePacked(keccak256("ommers")));
        items[2] = _rlpBytes(abi.encodePacked(address(0xC0FFEE)));
        items[3] = _rlpBytes(abi.encodePacked(stateRoot));
        items[4] = _rlpBytes(abi.encodePacked(keccak256("transactions root")));
        items[5] = _rlpBytes(abi.encodePacked(keccak256("receipts root")));
        return _rlpList(items);
    }

    /// @dev The storage slot of `executionBlockHashes[slot]`, computed here and not by the vault.
    function _entrySlot(uint64 slot) internal pure returns (bytes32) {
        return keccak256(abi.encode(uint256(slot), EXECUTION_BLOCK_HASHES_SLOT));
    }

    /// @dev What a prover builds. The remote chain has a block whose state holds `remote` with one storage entry: the
    /// entry that the remote light client really holds at `storedSlot` (read with `vm.load`, so the model cannot drift from
    /// the contract). The light client of the vault stores the hash of that block. Returns the evidence.
    struct Model {
        bytes32 entryValue;
        bytes entryLeaf;
        bytes accountLeaf;
        bytes header;
    }

    function _model(BeaconLightClient remote, uint64 storedSlot, bytes memory entryContent)
        internal
        view
        returns (Model memory model)
    {
        model.entryValue = vm.load(address(remote), _entrySlot(storedSlot));
        model.entryLeaf = _leaf(abi.encodePacked(keccak256(abi.encodePacked(_entrySlot(storedSlot)))), entryContent);
        bytes32 storageRoot = keccak256(model.entryLeaf);
        model.accountLeaf = _leaf(
            abi.encodePacked(keccak256(abi.encodePacked(address(remote)))), _account(storageRoot, address(remote), 4)
        );
        model.header = _header(keccak256(model.accountLeaf));
    }

    function _proof(Model memory model, uint64 remoteSlot, uint64 storedSlot)
        internal
        pure
        returns (BeaconProofVerifier.OpeningProof memory proof)
    {
        proof.remoteSlot = remoteSlot;
        proof.remoteHeaderRlp = model.header;
        proof.accountProof = new bytes[](1);
        proof.accountProof[0] = model.accountLeaf;
        proof.storedSlot = storedSlot;
        proof.storageProof = new bytes[](1);
        proof.storageProof[0] = model.entryLeaf;
    }

    /// @dev The remote light client stores its first update, as `follow` makes it do.
    function _remoteFollows(BeaconLightClient remote, uint64 slot) internal {
        BeaconLightClient.LightClientOutput memory output = _outputAt(remote, GENESIS_ROOT_A, slot, _execHash(slot));
        output.newHeaderRoot = keccak256(abi.encode("followed header", slot));
        _submit(remote, output);
    }

    /// @dev The light client of the vault stores the block of the remote chain that holds the model. Returns its slot.
    function _ownStores(BeaconLightClient own, bytes memory header) internal returns (uint64) {
        _finalize(own, GENESIS_ROOT_B, keccak256(header));
        return own.head();
    }

    /// @dev The whole honest preparation: the remote light client follows, the model is built from its real storage, and
    /// the own light client (the one that tracks the remote chain, which the opened contract reads) stores the block.
    function _honestOpeningProof(BeaconLightClient own, BeaconLightClient remote)
        internal
        returns (BeaconProofVerifier.OpeningProof memory)
    {
        _remoteFollows(remote, FIRST_UPDATE_SLOT);
        Model memory model = _model(remote, FIRST_UPDATE_SLOT, _rlpBytes(_trimmed(_execHash(FIRST_UPDATE_SLOT))));
        assertEq(model.entryValue, _execHash(FIRST_UPDATE_SLOT), "the model reads the entry from the real contract");
        return _proof(model, _ownStores(own, model.header), FIRST_UPDATE_SLOT);
    }
}
