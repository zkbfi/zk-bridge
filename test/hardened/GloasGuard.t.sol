// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {BeaconProofVerifier} from "../../src/hardened/BeaconProofVerifier.sol";
import {MessageBridge} from "../../src/hardened/MessageBridge.sol";
import {MessageScenes} from "./utils/MessageScenes.sol";
import {MessageFixtures} from "./utils/MessageFixtures.sol";

/// @notice The Gloas guard of the body-layout path. From the Gloas fork on, the stored execution block hash of a slot is
/// `state.latest_block_hash` of the finalized state, which is an earlier payload, and the block body holds a bid and no
/// payload. So `addBlockHashLayout` and the block hash branch of a message proof refuse every slot at or after
/// `gloasForkSlot`. Each test shows the refusal and then the same call below the fork slot as the control.
contract GloasGuardTest is MessageScenes {
    function _bridgeWithForkSlot(uint64 forkSlot) internal returns (MessageBridge created) {
        bridgeGloasForkSlot = forkSlot;
        created = _newDestinationBridge(lightClientForB, 0, DEFAULT_CAPELLA_ERA);
    }

    /// Claim: the fork slot is stored as given, and the default route has none. Matters: the guard reads one immutable.
    function test_forkSlotIsStored() public {
        assertEq(bridge.gloasForkSlot(), type(uint64).max);
        assertEq(bridge.NO_GLOAS_FORK(), type(uint64).max);
        assertEq(_bridgeWithForkSlot(353_024 * 32).gloasForkSlot(), 353_024 * 32);
    }

    /// Claim: a stored head at or after the Gloas fork slot cannot validate a body-layout position, even with a branch that
    /// is valid for the position. Shows: `GloasSlotRefused(slot, forkSlot)` for the fork slot itself. Control: one slot
    /// later as the fork slot, the same evidence is accepted. Matters: a Gloas head holds `latest_block_hash`, and a body
    /// position that happens to lead to it must not become the layout of the slot.
    function test_blockHashLayoutIsRefusedForAGloasHead() public {
        SceneParams memory params = _defaultParams();
        Scene memory scene = _buildScene(MessageFixtures.deliver(), params, _messageHeaderRlp());
        _storeScene(params, scene);

        MessageBridge gloas = _bridgeWithForkSlot(params.anchorSlot);
        vm.expectRevert(abi.encodeWithSelector(BeaconProofVerifier.GloasSlotRefused.selector, params.anchorSlot, params.anchorSlot));
        gloas.addBlockHashLayout(params.anchorBodyGindex, scene.anchorBodyEvidence);

        MessageBridge before = _bridgeWithForkSlot(params.anchorSlot + 1);
        before.addBlockHashLayout(params.anchorBodyGindex, scene.anchorBodyEvidence);
        assertEq(before.bodyLayouts().length, 1);
    }

    /// Claim: a message proof whose source block is at or after the fork slot is refused with `GloasSlotRefused`, also when
    /// the bridge holds a validated body layout for the slots before. Shows: the layouts are added from the evidence
    /// below the fork slot, and the honest proof is refused for its source slot. Control: with no fork slot the same
    /// proof delivers. Matters: this is the negative test of the body-layout path under a Gloas head.
    function test_messageProofFromAGloasSourceIsRefused() public {
        SceneParams memory params = _defaultParams();
        Scene memory scene = _buildScene(MessageFixtures.deliver(), params, _messageHeaderRlp());
        _storeScene(params, scene);

        MessageBridge gloas = _bridgeWithForkSlot(params.depositSlot);
        gloas.addBlockRootsLayout(params.blockRootsGindex, scene.rootsEvidence);
        gloas.addBlockHashLayout(
            params.blockHashGindex,
            BeaconProofVerifier.BlockHashEvidence(scene.evidenceBefore, scene.evidenceBeforeBranch)
        );
        vm.expectRevert(abi.encodeWithSelector(BeaconProofVerifier.GloasSlotRefused.selector, params.depositSlot, params.depositSlot));
        gloas.executeMessage(_messageProof(scene, MessageFixtures.deliver()));

        MessageBridge open = _bridgeWithForkSlot(type(uint64).max);
        _addLayouts(open, params, scene);
        open.executeMessage(_messageProof(scene, MessageFixtures.deliver()));
        assertTrue(open.messageCallStatus(MessageFixtures.deliver().messageId));
    }
}
