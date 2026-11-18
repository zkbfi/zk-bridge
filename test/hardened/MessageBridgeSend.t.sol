// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Vm} from "forge-std/Vm.sol";
import {BeaconLightClient} from "../../src/hardened/BeaconLightClient.sol";
import {BeaconProofVerifier} from "../../src/hardened/BeaconProofVerifier.sol";
import {MessageBridge} from "../../src/hardened/MessageBridge.sol";
import {AmbMessageCodec} from "../../src/hardened/AmbMessageCodec.sol";
import {IAMB} from "../../src/hardened/IAMB.sol";
import {MessageScenes} from "./utils/MessageScenes.sol";
import {MessageFixtures} from "./utils/MessageFixtures.sol";
import {MessageGate} from "./utils/MessageTargets.sol";

/// @notice A message bridge that exposes the reading of the local chain identifier, so that a test can give it a chain
/// identifier above 64 bits, which the test EVM cannot run on (`vm.chainId` refuses one).
contract LocalChainIdHarness is MessageBridge {
    constructor(
        address lightClient,
        uint64 remoteChainId,
        address remoteBridgeAddress,
        BridgeTerms memory terms,
        address gate
    ) MessageBridge(lightClient, remoteChainId, remoteBridgeAddress, terms, 0, gate) {}

    function localChainIdOf(uint256 chainId) external pure returns (uint64) {
        return _toLocalChainId(chainId);
    }
}

/// @notice Tests of the sending side of the message bridge, of the deposit lock that guards it, and of the constructor.
contract MessageBridgeSendTest is MessageScenes {
    event UserRequestForAffirmation(bytes32 indexed messageId, bytes encodedData);
    event DepositsOpened(uint64 indexed remoteSlot, bytes32 indexed remoteBlockHash, uint64 storedSlot);

    function _payload() internal pure returns (bytes memory payload) {
        payload = new bytes(70);
        for (uint256 i = 0; i < payload.length; i++) {
            payload[i] = bytes1(uint8(i));
        }
    }

    function _send(MessageBridge from, bytes memory data, uint256 gas) internal returns (bytes32) {
        vm.prank(MessageFixtures.SENDER);
        return from.requireToPassMessage(MessageFixtures.TARGET_RECORDER, data, gas);
    }

    function _terms(address remoteLightClient_) internal pure returns (MessageBridge.BridgeTerms memory) {
        return MessageBridge.BridgeTerms(0, remoteLightClient_);
    }

    // ================================================================ the message that a send logs

    /// Claim: a send logs `UserRequestForAffirmation` with the identifier and the encoding that the fixture generator
    /// wrote for the same inputs, and returns the identifier. Shows: the identifier, the topic and the data equal the
    /// bytes of the first fixture message; the second send, with `requireToConfirmMessage`, equals the second one
    /// (nonce 1, data type 0x80). Matters: the source bridge and the destination bridge must agree on the format, and the
    /// fixtures are the independent third party.
    function test_send_logsTheAmbEncodingOfTheFixtures() public {
        MessageFixtures.Named memory first = MessageFixtures.deliver();
        vm.recordLogs();
        assertEq(_send(sourceBridge, _payload(), 500_000), first.messageId, "the call returns the identifier");
        Vm.Log[] memory logs = vm.getRecordedLogs();
        assertEq(logs[0].topics[1], first.messageId, "the topic");
        assertEq(
            logs[0].data,
            abi.encode(_withZeroGasField(first.encoded)),
            "the raw data is the event data of the fixture, with the gas field zero"
        );

        MessageFixtures.Named memory second = MessageFixtures.confirm();
        vm.expectEmit(true, false, false, true, address(sourceBridge));
        emit UserRequestForAffirmation(second.messageId, _withZeroGasField(second.encoded));
        vm.prank(MessageFixtures.SENDER);
        assertEq(
            sourceBridge.requireToConfirmMessage(MessageFixtures.TARGET_RECORDER, "confirm", 500_000), second.messageId
        );
    }

    /// @dev The fixtures come from receipts of a bridge that wrote the gas of the message into the gas field (bytes 72
    /// to 75). This bridge writes zero there and changes nothing else.
    function _withZeroGasField(bytes memory encoded) internal pure returns (bytes memory copy) {
        copy = bytes.concat(encoded);
        for (uint256 i = 72; i < 76; i++) {
            copy[i] = 0;
        }
    }

    /// Claim: the topic 0 of the event is the hash of the OmniBridge event signature. Shows: the constant equals the
    /// selector of `IAMB.UserRequestForAffirmation`, and a send emits it. Matters: a receiver filters logs by it.
    function test_send_topicIsTheOmniBridgeEventSignature() public {
        assertEq(sourceBridge.USER_REQUEST_TOPIC(), IAMB.UserRequestForAffirmation.selector);
        vm.recordLogs();
        _send(sourceBridge, "x", 100_000);
        Vm.Log[] memory logs = vm.getRecordedLogs();
        assertEq(logs.length, 1, "a send logs exactly one event");
        assertEq(logs[0].topics[0], IAMB.UserRequestForAffirmation.selector);
    }

    /// Claim: identifiers are unique and carry the nonce, and the nonce implies no order for the receiver. Shows: ten
    /// sends give ten different identifiers that differ in the low 8 bytes only. Matters: the identifier is the replay key.
    function test_send_identifiersAreUniqueAndOnlyTheNonceChanges() public {
        bytes32 prefix = AmbMessageCodec.messageIdPrefix(CHAIN_A, address(sourceBridge));
        for (uint256 i = 0; i < 10; i++) {
            assertEq(_send(sourceBridge, "x", 100_000), prefix | bytes32(i));
        }
    }

    /// Claim: the views of the bridge are those of OmniBridge. Shows: the chain identifiers, the gas ceiling, an
    /// empty context and an empty status for an unknown message. Matters: mediators and clients read them.
    function test_views_matchTheOmniBridgeInterface() public view {
        assertEq(sourceBridge.sourceChainId(), CHAIN_A);
        assertEq(sourceBridge.destinationChainId(), CHAIN_B);
        assertEq(bridge.sourceChainId(), CHAIN_B);
        assertEq(bridge.destinationChainId(), CHAIN_A);
        assertEq(sourceBridge.maxGasPerTx(), type(uint32).max, "no ceiling below the width of the gas field");
        assertEq(sourceBridge.messageSender(), address(0));
        assertEq(sourceBridge.messageId(), bytes32(0));
        assertEq(sourceBridge.messageSourceChainId(), bytes32(0));
        assertEq(sourceBridge.transactionHash(), bytes32(0));
        assertFalse(sourceBridge.messageCallStatus(bytes32(uint256(1))));
        assertEq(sourceBridge.failedMessageDataHash(bytes32(uint256(1))), bytes32(0));
        assertEq(sourceBridge.failedMessageReceiver(bytes32(uint256(1))), address(0));
        assertEq(sourceBridge.failedMessageSender(bytes32(uint256(1))), address(0));
    }

    // ================================================================ the limits of a send

    /// Claim: the gas argument of a send is ignored, and the gas field of every message is zero. Shows: sends with 0, 1,
    /// 10,000,001 and the largest uint256 all pass, and each logged message decodes with a gas field of zero. Matters:
    /// the owner's rule, "there should be no defaults": the bridge carries no gas number, so none can be wrong. Delivery
    /// gives the target all the gas, and a lack of gas reverts.
    function test_send_gasArgumentIsIgnoredAndTheGasFieldIsZero() public {
        uint256[4] memory gases = [uint256(0), 1, 10_000_001, type(uint256).max];
        for (uint256 i = 0; i < gases.length; i++) {
            vm.recordLogs();
            _send(sourceBridge, "x", gases[i]);
            Vm.Log[] memory logs = vm.getRecordedLogs();
            (AmbMessageCodec.Header memory header,) = AmbMessageCodec.decode(abi.decode(logs[0].data, (bytes)));
            assertEq(header.gasLimit, 0, "the gas field is zero");
        }
    }

    /// Claim: call data that starts with the selector of a token transfer or approval is refused, as OmniBridge refuses it.
    /// Shows: each of the five selectors reverts with the exact error; call data shorter than four bytes and another
    /// selector pass. Matters: without the rule, a message could make the bridge move the tokens of a contract that approved it.
    function test_send_forbiddenSelectorsAreRefused() public {
        bytes4[5] memory forbidden = [bytes4(0xa9059cbb), 0x095ea7b3, 0x23b872dd, 0x4000aea0, 0xcae9ca51];
        for (uint256 i = 0; i < forbidden.length; i++) {
            vm.expectRevert(abi.encodeWithSelector(MessageBridge.ForbiddenSelector.selector, forbidden[i]));
            _send(sourceBridge, abi.encodePacked(forbidden[i], new bytes(64)), 100_000);
        }
        _send(sourceBridge, hex"a9059c", 100_000);
        _send(sourceBridge, "", 100_000);
        _send(sourceBridge, hex"a9059cbc", 100_000);
    }

    /// Claim: sends are refused from the cutoff time on, and not before. Shows: with a cutoff 100 seconds ahead a
    /// send passes, and at the cutoff it reverts with the exact error. Matters: a route whose other chain has a breaking
    /// fork scheduled must stop taking messages that it cannot deliver.
    function test_send_cutoffRefusesFromItsTimestamp() public {
        uint64 cutoff = uint64(block.timestamp + 100);
        MessageBridge cut = _deploySourceBridge(cutoff, address(gateA));
        _openDepositsWithoutProof(cut);
        _send(cut, "x", 100_000);
        vm.warp(cutoff);
        vm.expectRevert(abi.encodeWithSelector(MessageBridge.SendCutoffReached.selector, cutoff));
        _send(cut, "x", 100_000);
    }

    // ================================================================ the fork gate

    /// Claim: every send calls the gate with empty evidence, and a gate that refuses stops the send. Shows: the gate
    /// counts one call per send; once it refuses, the send reverts with the gate's error and the nonce is not spent
    /// (the next send after the gate relents has the identifier of nonce 1). Matters: the gate keeps the route from taking
    /// messages across a fork that it cannot prove.
    function test_gate_refusalStopsTheSendAndSpendsNoNonce() public {
        MessageGate gate = new MessageGate();
        MessageBridge gated = _deploySourceBridge(0, address(gate));
        _openDepositsWithoutProof(gated);
        bytes32 prefix = AmbMessageCodec.messageIdPrefix(CHAIN_A, address(gated));

        assertEq(_send(gated, "x", 100_000), prefix);
        assertEq(gate.calls(), 1, "one gate call per send");

        gate.setRefusing(true);
        vm.expectRevert(abi.encodeWithSelector(MessageGate.GateRefused.selector, bytes("")));
        _send(gated, "x", 100_000);
        assertEq(gate.calls(), 1);

        gate.setRefusing(false);
        assertEq(_send(gated, "x", 100_000), prefix | bytes32(uint256(1)), "the refused send spent no nonce");
    }

    // ================================================================ the deposit lock

    /// Claim: a closed bridge refuses a send with `DepositsNotOpen`, before every other check. Shows: with bad gas, a
    /// forbidden selector and a refusing gate, the first error is still the lock; and no nonce is spent. Matters: a
    /// message sent before the remote light client stored a head can never be delivered.
    function test_lock_closedBridgeRefusesEverySendFirst() public {
        MessageGate gate = new MessageGate();
        gate.setRefusing(true);
        MessageBridge closed = _deploySourceBridge(0, address(gate));
        assertFalse(closed.depositsOpen());
        vm.expectRevert(BeaconProofVerifier.DepositsNotOpen.selector);
        closed.requireToPassMessage(address(0), abi.encodePacked(bytes4(0xa9059cbb)), 5);
        vm.expectRevert(BeaconProofVerifier.DepositsNotOpen.selector);
        closed.requireToConfirmMessage(address(0), "", 100_000);
        assertEq(gate.calls(), 0, "the gate was not reached");
    }

    /// Claim: the bridge opens when the remote light client stored an update, and the first send after that works.
    /// Shows: the honest proof opens a closed bridge, emits `DepositsOpened`, and a send then passes; a stranger may
    /// call it; a second call with garbage returns at once. Matters: this is the lock of the design: opening is
    /// permanent and needs no key.
    function test_lock_honestProofOpensTheBridgeForGood() public {
        MessageBridge closed = _deploySourceBridge(0, address(gateA));
        BeaconProofVerifier.OpeningProof memory proof =
            _honestOpeningProof(BeaconLightClient(address(closed.lightClient())), BeaconLightClient(closed.remoteLightClient()));
        vm.expectRevert(BeaconProofVerifier.DepositsNotOpen.selector);
        closed.requireToPassMessage(address(0), "", 100_000);

        vm.expectEmit(true, false, false, false, address(closed));
        emit DepositsOpened(proof.remoteSlot, bytes32(0), proof.storedSlot);
        vm.prank(attacker);
        closed.openDeposits(proof);
        assertTrue(closed.depositsOpen());
        closed.requireToPassMessage(address(0), "", 100_000);

        closed.openDeposits(_emptyOpeningProof());
        assertTrue(closed.depositsOpen(), "it never closes");
    }

    /// Claim: a proof that the remote light client stored nothing does not open the bridge. Shows: an unstored slot
    /// reverts with the exact error and the flag stays false. Matters: the opening is the condition itself.
    function test_lock_unstoredRemoteSlotDoesNotOpen() public {
        MessageBridge closed = _deploySourceBridge(0, address(gateA));
        BeaconProofVerifier.OpeningProof memory proof = _emptyOpeningProof();
        proof.remoteSlot = 777;
        vm.expectRevert(abi.encodeWithSelector(BeaconProofVerifier.OpeningSlotNotStored.selector, 777));
        closed.openDeposits(proof);
        assertFalse(closed.depositsOpen());
    }

    function _emptyOpeningProof() internal pure returns (BeaconProofVerifier.OpeningProof memory proof) {
        proof.accountProof = new bytes[](0);
        proof.storageProof = new bytes[](0);
    }

    /// Claim: the nonce, the flag and the sender of the context share one storage word, in this order, and a send
    /// keeps the flag. Shows: the word of an open bridge holds the flag at bit 64 and a zero nonce; one send makes the
    /// nonce 1 and leaves the flag. Matters: the unit tests open bridges by writing this word, and a layout change
    /// must break this test and not the others silently.
    function test_pin_flagAndNonceShareTheFirstWord() public {
        assertEq(uint256(vm.load(address(sourceBridge), bytes32(BRIDGE_FLAG_WORD_SLOT))), uint256(1) << 64);
        _send(sourceBridge, "x", 100_000);
        assertEq(uint256(vm.load(address(sourceBridge), bytes32(BRIDGE_FLAG_WORD_SLOT))), (uint256(1) << 64) | 1);
    }

    // ================================================================ the constructor

    /// Claim: the constructor stores what it gets, and the identifier prefix follows from the chain and the address.
    function test_constructor_storesTheConfiguration() public view {
        assertEq(address(bridge.lightClient()), address(lightClientForB));
        assertEq(bridge.localChainId(), CHAIN_B);
        assertEq(bridge.remoteChainId(), CHAIN_A);
        assertEq(bridge.remoteBridge(), MessageFixtures.REMOTE_BRIDGE);
        assertEq(bridge.remoteLightClient(), address(lightClientForA));
        assertEq(bridge.capellaEra(), DEFAULT_CAPELLA_ERA);
        assertEq(address(bridge.depositGate()), address(gateB));
        assertEq(bridge.sendCutoffTimestamp(), 0);
    }

    /// Claim: each zero argument is refused with its name, and the chain checks hold, and the local chain is read from `block.chainid` (no argument can disagree with it). Shows: the exact error for every
    /// case. Matters: an unset address must fail at deployment, not lock messages later.
    function test_constructor_refusesBadArguments() public {
        vm.chainId(CHAIN_B);
        address client = address(lightClientForB);
        address remote = MessageFixtures.REMOTE_BRIDGE;
        address gate = address(gateB);
        address remoteClient = address(lightClientForA);

        vm.expectRevert(abi.encodeWithSelector(BeaconProofVerifier.ZeroValue.selector, "lightClient"));
        new MessageBridge(address(0), CHAIN_A, remote, _terms(remoteClient), 0, gate);
        vm.expectRevert(abi.encodeWithSelector(BeaconProofVerifier.ZeroValue.selector, "remoteChainId"));
        new MessageBridge(client, 0, remote, _terms(remoteClient), 0, gate);
        vm.expectRevert(abi.encodeWithSelector(BeaconProofVerifier.ZeroValue.selector, "remoteBridge"));
        new MessageBridge(client, CHAIN_A, address(0), _terms(remoteClient), 0, gate);
        vm.expectRevert(abi.encodeWithSelector(BeaconProofVerifier.ZeroValue.selector, "depositGate"));
        new MessageBridge(client, CHAIN_A, remote, _terms(remoteClient), 0, address(0));
        vm.expectRevert(abi.encodeWithSelector(BeaconProofVerifier.ZeroValue.selector, "remoteLightClient"));
        new MessageBridge(client, CHAIN_A, remote, _terms(address(0)), 0, gate);
        vm.expectRevert(BeaconProofVerifier.RemoteChainIsLocalChain.selector);
        new MessageBridge(client, CHAIN_B, remote, _terms(remoteClient), 0, gate);
        MessageBridge built = new MessageBridge(client, CHAIN_A, remote, _terms(remoteClient), 758, gate);
        assertEq(built.localChainId(), CHAIN_B, "the local chain is block.chainid at deployment");
    }

    /// Claim: the local chain identifier is `block.chainid` whole, and a chain identifier above 64 bits is refused, not
    /// cut. Shows: on the chain 2^64 - 1 the bridge deploys with that identifier; the reading of the identifier refuses
    /// 2^64 with `LocalChainIdTooLarge` and the identifier. Matters: the message format holds the chain in 64 bits; a
    /// cut identifier would name another chain in every message and every message identifier of this bridge.
    /// @dev The test EVM refuses a chain identifier of 2^64 or more (`vm.chainId`), so the refusal is shown through the
    /// harness, which runs the same function as the constructor.
    function test_constructor_refusesAChainIdAboveSixtyFourBits() public {
        address client = address(lightClientForB);
        address remote = MessageFixtures.REMOTE_BRIDGE;
        address gate = address(gateB);
        vm.chainId(type(uint64).max);
        MessageBridge built = new MessageBridge(client, CHAIN_A, remote, _terms(address(lightClientForA)), 0, gate);
        assertEq(built.localChainId(), type(uint64).max, "the largest identifier is kept whole");

        LocalChainIdHarness harness =
            new LocalChainIdHarness(client, CHAIN_A, remote, _terms(address(lightClientForA)), gate);
        assertEq(harness.localChainIdOf(type(uint64).max), type(uint64).max);
        uint256 tooLarge = uint256(type(uint64).max) + 1;
        vm.expectRevert(abi.encodeWithSelector(MessageBridge.LocalChainIdTooLarge.selector, tooLarge));
        harness.localChainIdOf(tooLarge);
        vm.expectRevert(abi.encodeWithSelector(MessageBridge.LocalChainIdTooLarge.selector, type(uint256).max));
        harness.localChainIdOf(type(uint256).max);
    }

    // ================================================================ gas

    /// Gas of a send, measured with a warm bridge and with the first send (cold slot). Reported, and bounded so that a
    /// large change shows up.
    function test_gas_requireToPassMessage() public {
        uint256 before = gasleft();
        _send(sourceBridge, _payload(), 500_000);
        uint256 first = before - gasleft();
        before = gasleft();
        _send(sourceBridge, _payload(), 500_000);
        uint256 second = before - gasleft();
        emit log_named_uint("requireToPassMessage, first send (70 bytes of data)", first);
        emit log_named_uint("requireToPassMessage, second send", second);
        assertLt(first, 80_000);
        assertLt(second, 60_000);
    }
}
