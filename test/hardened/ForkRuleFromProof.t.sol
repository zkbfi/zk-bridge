// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {BeaconProofVerifier} from "../../src/hardened/BeaconProofVerifier.sol";
import {MessageBridge} from "../../src/hardened/MessageBridge.sol";
import {ForkShape} from "../../src/hardened/ForkShape.sol";
import {MessageScenes} from "./utils/MessageScenes.sol";
import {MessageFixtures} from "./utils/MessageFixtures.sol";
import {ForkProofs} from "./utils/ForkProofs.sol";

/// @notice The fork rule of the message verifier comes from proof, and from the same list as the deposit gate
/// (`docs/superpowers/specs/2026-11-10-mainnet-readiness.md`, A6, part 2). The gate admits a deposit when `ForkShape.judge`
/// proves an allowed shape of the state of its chain. The bridge on the other chain proves a message when the same judge
/// proves an allowed shape of the state of its source block, and the `block_roots` and `historical_summaries` positions
/// that it accepts are the positions of the same shapes. The tests below fail if the two ever diverge: a shape that the
/// gate admits and the verifier cannot follow would lock deposits, and a shape that the verifier follows and the gate
/// refuses is a list that no longer means one thing.
contract ForkRuleFromProofTest is MessageScenes {
    /// @dev The shapes that the tests try: every plain depth from 1 to 31, and the progressive marker.
    uint8 internal constant DEEPEST_PLAIN = 31;

    /// Claim: the list is 5, 6, 7 and 255 (progressive), in this order. The Rust reference pins the same values
    /// (`lc-core` `ancestry::ALLOWED_SHAPES`, test `the_allowed_shapes_are_the_list_of_the_contracts`). Matters: the
    /// off-chain twin and the contracts read one list.
    function test_theAllowedShapesAreFiveSixSevenAndProgressive() public pure {
        uint8[] memory shapes = ForkShape.allowedShapes();
        assertEq(shapes.length, 4);
        assertEq(shapes[0], 5);
        assertEq(shapes[1], 6);
        assertEq(shapes[2], 7);
        assertEq(shapes[3], ForkShape.PROGRESSIVE);
    }

    /// Claim: the `block_roots` position of a shape is accepted exactly when the shape is in `ForkShape.allowedShapes`,
    /// for every plain depth from 1 to 31 and for the progressive position 352. Shows: an accepted position reaches the
    /// next check (`AnchorNotStored`, the evidence names no stored header); a refused one stops at `LayoutPositionInvalid`
    /// or `LayoutOutOfBounds`. Matters: an anchor of a fork that the gate admits must be readable, and an anchor of a shape
    /// that the gate refuses must not be.
    function test_theAncestryPositionsFollowTheGateList() public {
        BeaconProofVerifier.BlockRootsEvidence memory unstored;
        unstored.laterHeader.slot = 12_345;
        for (uint8 depth = 1; depth <= DEEPEST_PLAIN; depth++) {
            bool accepted = _blockRootsPositionAccepted((uint256(1) << depth) + 5, unstored);
            assertEq(accepted, ForkShape.isAllowed(depth), string.concat("plain depth ", vm.toString(depth)));
        }
        assertEq(_blockRootsPositionAccepted(352, unstored), ForkShape.isAllowed(ForkShape.PROGRESSIVE), "progressive");
    }

    /// Claim: for each shape the gate judges, the bridge proves a message from a source block of that shape exactly when
    /// the gate admits a state of that shape. Shows, for the plain depths 4 to 9 and the progressive form: `ForkShape.judge`
    /// (the rule of `BeaconForkGate`) on the state gives `Allowed` for 5, 6, 7 and progressive, and the message from a
    /// source block of that state is delivered; for 4, 8 and 9 the judge refuses and the message reverts
    /// `ForkShapeProofInvalid`. The plain sources take the body layout (812), the progressive one the bid (2856). Matters:
    /// this is the one list: no fork admits deposits that the other side cannot pay, and the verifier follows a fork
    /// without a date.
    function test_theGateAdmitsExactlyTheShapesThatTheVerifierProves() public {
        uint8[7] memory shapes = [4, 5, 6, 7, 8, 9, ForkProofs.PROGRESSIVE];
        // One fixture message per shape, so that each delivery is a new message on the one bridge.
        MessageFixtures.Named[7] memory messages = [
            MessageFixtures.order_a(),
            MessageFixtures.deliver(),
            MessageFixtures.confirm(),
            MessageFixtures.order_b(),
            MessageFixtures.order_c(),
            MessageFixtures.two_a(),
            MessageFixtures.two_b()
        ];
        for (uint256 i = 0; i < shapes.length; i++) {
            uint8 shape = shapes[i];
            ForkProofs.ForkedState memory state = ForkProofs.state(shape, GENESIS_ROOT_A);
            (ForkShape.Verdict verdict, uint8 proven) = ForkShape.judge(
                state.root, state.fork.version, state.fork.versionBranch, state.fork.genesisValidatorsRootBranch, GENESIS_ROOT_A
            );
            bool gateAdmits = verdict == ForkShape.Verdict.Allowed;
            assertEq(gateAdmits, ForkShape.isAllowed(shape), string.concat("judge, shape ", vm.toString(shape)));
            if (gateAdmits) assertEq(proven, shape);

            SceneParams memory params = _defaultParams();
            params.sourceShape = shape;
            if (shape == ForkProofs.PROGRESSIVE) params.blockHashGindex = 2856;
            MessageFixtures.Named memory named = messages[i];
            Scene memory scene = _scene(named, params);
            if (gateAdmits) {
                bridge.executeMessage(scene.proof);
                assertTrue(bridge.messageCallStatus(named.messageId), string.concat("delivered, shape ", vm.toString(shape)));
            } else {
                vm.expectRevert(
                    abi.encodeWithSelector(BeaconProofVerifier.ForkShapeProofInvalid.selector, uint8(verdict))
                );
                bridge.executeMessage(scene.proof);
            }
        }
    }

    /// Claim: the rule reads no slot. A Fulu-era source and a Gloas source are delivered by one bridge in either order,
    /// with slots that interleave: a plain source ABOVE a progressive one still takes the payload layout. Matters: a chain
    /// whose fork date moves, or a bridge deployed before the date is set, needs nothing but the proofs.
    function test_theRuleReadsNoSlot() public {
        SceneParams memory gloas = _defaultParams();
        gloas.sourceShape = ForkProofs.PROGRESSIVE;
        gloas.blockHashGindex = 2856;
        Scene memory gloasScene = _scene(MessageFixtures.deliver(), gloas);
        // The plain source lies above the progressive one, and its body evidence headers above the stored head.
        SceneParams memory plain = _defaultParams();
        plain.depositSlot = gloas.anchorSlot + 50;
        assertGt(plain.depositSlot, gloas.depositSlot, "the plain source lies above the progressive one");
        Scene memory plainScene = _scene(MessageFixtures.confirm(), plain);

        bridge.executeMessage(plainScene.proof);
        bridge.executeMessage(gloasScene.proof);
        assertTrue(bridge.messageCallStatus(MessageFixtures.confirm().messageId));
        assertTrue(bridge.messageCallStatus(MessageFixtures.deliver().messageId));
    }

    /// Claim: the fork proof must be of the state of the source header itself. The proof of the ANCHOR state (a valid
    /// proof of an allowed shape, for another root) reverts `ForkShapeProofInvalid(VersionProofInvalid)`, and so does the
    /// honest proof with a flipped version byte. Matters: the prover must not borrow the shape of another state.
    function test_theProofIsOfTheSourceState() public {
        MessageFixtures.Named memory named = MessageFixtures.deliver();
        SceneParams memory params = _defaultParams();
        Scene memory scene = _scene(named, params);
        MessageBridge.MessageProof memory borrowed = _clone(scene.proof);
        borrowed.sourceFork = scene.anchorBodyEvidence.fork;
        vm.expectRevert(
            abi.encodeWithSelector(
                BeaconProofVerifier.ForkShapeProofInvalid.selector, uint8(ForkShape.Verdict.VersionProofInvalid)
            )
        );
        bridge.executeMessage(borrowed);

        MessageBridge.MessageProof memory otherVersion = _clone(scene.proof);
        otherVersion.sourceFork.version = 0x06000001;
        vm.expectRevert(
            abi.encodeWithSelector(
                BeaconProofVerifier.ForkShapeProofInvalid.selector, uint8(ForkShape.Verdict.VersionProofInvalid)
            )
        );
        bridge.executeMessage(otherVersion);

        bridge.executeMessage(scene.proof);
        assertTrue(bridge.messageCallStatus(named.messageId));
    }

    /// @dev Whether `addBlockRootsLayout` takes `gindex` as a `block_roots` position: it then reaches the stored header
    /// check, which the unstored evidence fails.
    function _blockRootsPositionAccepted(uint256 gindex, BeaconProofVerifier.BlockRootsEvidence memory unstored)
        internal
        returns (bool)
    {
        try bridge.addBlockRootsLayout(gindex, unstored) {
            revert("the unstored evidence cannot pass");
        } catch (bytes memory reason) {
            bytes4 selector = bytes4(reason);
            if (selector == BeaconProofVerifier.AnchorNotStored.selector) return true;
            assertTrue(
                selector == BeaconProofVerifier.LayoutPositionInvalid.selector
                    || selector == BeaconProofVerifier.LayoutOutOfBounds.selector,
                "a refused position stops at the position rule"
            );
            return false;
        }
    }
}
