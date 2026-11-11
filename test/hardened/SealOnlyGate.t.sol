// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Vm} from "forge-std/Vm.sol";
import {BeaconForkGate} from "../../src/hardened/BeaconForkGate.sol";
import {ForkRegistry} from "../../src/hardened/ForkRegistry.sol";
import {MessageBridge} from "../../src/hardened/MessageBridge.sol";
import {GateSupport} from "./utils/GateSupport.sol";

/// @notice The seal-only gate (decision of 2026-11-10, `docs/superpowers/specs/2026-11-10-mainnet-readiness.md`, A2,
/// "Superseded the same day: a seal-only gate"). The owner: "no proof writing on the deposit". A send is admitted
/// unless the gate is sealed: one storage read, no epoch, no evidence, no probe. `seal` is the audited code of the other
/// modes, unchanged: a proof of a state shape outside the allowed set seals for good, by EIP-4788 evidence
/// (`SealOnly`, Ethereum) or from the fork registry (`SealOnlyWithRegistry`, PulseChain, which has no beacon roots).
contract SealOnlyGateTest is GateSupport {
    bytes32 internal constant OBSERVATION_VKEY = keccak256("fork observation program");
    uint8 internal constant DISALLOWED_SHAPE = 8;

    event GateSealedByFork(bytes4 version, uint64 slot);
    event ForkConfirmed(uint256 indexed epoch, bytes4 version);

    BeaconForkGate internal sealOnly;
    ForkRegistry internal registry;
    BeaconForkGate internal sealOnlyWithRegistry;

    function setUp() public override {
        super.setUp();
        _warpIntoEpoch(EPOCH_E, 3);
        _etchMock();
        sealOnly = _newGate(BeaconForkGate.GateMode.SealOnly);
        registry = new ForkRegistry(address(lightClientForA), address(verifier), OBSERVATION_VKEY);
        sealOnlyWithRegistry = _registryGate(BeaconForkGate.GateMode.SealOnlyWithRegistry, address(registry));
    }

    // ---------------------------------------------------------------- builders

    function _registryGate(BeaconForkGate.GateMode mode, address registryAddress) internal returns (BeaconForkGate) {
        return new BeaconForkGate(BEACON_ROOTS, mode, ETHEREUM_GENESIS, 12, 32, GENESIS_ROOT_A, registryAddress);
    }

    /// @dev An honest observation of `shape` under `version` that starts from the stored head of the light client.
    function _observe(bytes4 version, uint8 shape, uint64 attestedSlot) internal {
        uint64 head = lightClientForA.head();
        uint64 period = lightClientForA.periodOf(head);
        ForkRegistry.ForkObservation memory observation = ForkRegistry.ForkObservation({
            genesisValidatorsRoot: GENESIS_ROOT_B,
            previousHeaderRoot: lightClientForA.headers(head),
            previousHeadSlot: head,
            previousSyncCommitteeHash: lightClientForA.syncCommittees(period),
            startNextSyncCommitteeHash: lightClientForA.syncCommittees(period + 1),
            observedVersion: version,
            observedAttestedSlot: attestedSlot,
            shape: shape
        });
        registry.observe(_prove(OBSERVATION_VKEY, abi.encode(observation)), abi.encode(observation));
    }

    // ================================================================ admit

    /// Claim: a seal-only gate admits every send in every epoch with no confirmation and no evidence, and reads nothing
    /// outside its own storage. Shows: through a real bridge, sends pass in epoch E and in E + 5 with nothing confirmed;
    /// `admit` with bytes that do not decode passes; the gate calls neither the beacon roots contract, nor the opcode
    /// probe, nor the BLS precompile, nor the registry; no `ForkConfirmed` is emitted. Control: an `Enforcing` gate
    /// refuses the same send with `ForkNotConfirmed`. Matters: "no proof writing on the deposit". A send must cost the
    /// same every time and depend on nothing but the seal.
    function test_sealOnly_admitsEverySendWithNoEvidence() public {
        MessageBridge sender = _bridgeWithGate(address(sealOnly));
        MessageBridge registrySender = _bridgeWithGate(address(sealOnlyWithRegistry));
        vm.expectCall(BEACON_ROOTS, "", 0);
        vm.expectCall(sealOnly.opcodeProbe(), "", 0);
        vm.expectCall(sealOnlyWithRegistry.opcodeProbe(), "", 0);
        vm.expectCall(address(0x0b), "", 0);
        vm.expectCall(address(registry), "", 0);
        vm.recordLogs();
        _send(sender, alice);
        _send(registrySender, alice);
        sealOnly.admit(hex"deadbeef");
        _warpIntoEpoch(EPOCH_E + 5, 7);
        _send(sender, alice);
        _send(registrySender, alice);
        Vm.Log[] memory recorded = vm.getRecordedLogs();
        for (uint256 i; i < recorded.length; i++) {
            assertTrue(recorded[i].topics[0] != ForkConfirmed.selector, "nothing is confirmed");
        }
        (, bool exists) = sealOnly.confirmedEpoch();
        assertFalse(exists, "no epoch was confirmed");

        BeaconForkGate enforcing = _newGate(BeaconForkGate.GateMode.Enforcing);
        MessageBridge control = _bridgeWithGate(address(enforcing));
        vm.expectRevert(abi.encodeWithSelector(BeaconForkGate.ForkNotConfirmed.selector, EPOCH_E + 5));
        _send(control, alice);
    }

    /// Claim: the registry-mode seal-only gate does not consult the registry on a send. Shows: after the registry
    /// records a disallowed shape, a send still passes (the `DetectBeaconRootsAndRegistry` gate refuses it as a
    /// control); `seal("")` then closes the gate and the next send reverts `GateSealed`. Matters: the cost of a send is one
    /// storage read on both chains. The window between the observation and the seal is the accepted gap (known issue
    /// 1.6): anyone, and the backend watcher, can seal in the next block.
    function test_sealOnlyWithRegistry_sendsDoNotReadTheRegistryUntilTheSeal() public {
        MessageBridge sender = _bridgeWithGate(address(sealOnlyWithRegistry));
        BeaconForkGate detecting =
            _registryGate(BeaconForkGate.GateMode.DetectBeaconRootsAndRegistry, address(registry));
        MessageBridge control = _bridgeWithGate(address(detecting));
        uint64 slot = lightClientForA.head() + 100;
        _observe(UNKNOWN_FORK, DISALLOWED_SHAPE, slot);

        _send(sender, alice);
        vm.expectRevert(
            abi.encodeWithSelector(
                BeaconForkGate.ObservedShapeNotAllowed.selector, UNKNOWN_FORK, DISALLOWED_SHAPE, slot
            )
        );
        _send(control, alice);

        vm.expectEmit(address(sealOnlyWithRegistry));
        emit GateSealedByFork(UNKNOWN_FORK, slot);
        vm.prank(attacker);
        sealOnlyWithRegistry.seal("");
        assertTrue(sealOnlyWithRegistry.isSealed());
        vm.expectRevert(BeaconForkGate.GateSealed.selector);
        _send(sender, alice);
    }

    // ================================================================ seal

    /// Claim: on a seal-only gate, a proof of a disallowed shape seals for good, and a proof of an allowed shape does
    /// not. Shows: allowed depth 6 evidence reverts `ShapeIsAllowed(6)`; depth 8 evidence from the current block emits
    /// `GateSealedByFork` and seals; a send then reverts `GateSealed` with no log; `admit` with any bytes reverts
    /// `GateSealed`; a second seal reverts `GateSealed`. Matters: the seal is the only thing that stops sends on a
    /// seal-only gate, and it must be the audited rule.
    function test_sealOnly_aDisallowedShapeSealsForGood() public {
        MessageBridge sender = _bridgeWithGate(address(sealOnly));
        uint64 slot = _slotIn(EPOCH_E, 3);
        bytes memory allowed = _honestEvidence(block.timestamp, slot, 6, ELECTRA);
        vm.expectRevert(abi.encodeWithSelector(BeaconForkGate.ShapeIsAllowed.selector, uint8(6)));
        sealOnly.seal(allowed);

        bytes memory evidence = _sealEvidence(block.timestamp, slot, UNKNOWN_FORK);
        vm.expectEmit(address(sealOnly));
        emit GateSealedByFork(UNKNOWN_FORK, slot);
        vm.prank(attacker);
        sealOnly.seal(evidence);
        assertTrue(sealOnly.isSealed());

        vm.recordLogs();
        vm.expectRevert(BeaconForkGate.GateSealed.selector);
        _send(sender, alice);
        assertEq(vm.getRecordedLogs().length, 0, "no message is logged");
        vm.expectRevert(BeaconForkGate.GateSealed.selector);
        sealOnly.admit(hex"deadbeef");
        vm.expectRevert(BeaconForkGate.GateSealed.selector);
        sealOnly.seal(evidence);
    }

    /// Claim: the seal keeps its rule against old evidence: a header from before the deployment of the gate cannot
    /// seal. Shows: a gate deployed in epoch E + 1 refuses depth 8 evidence of a slot in epoch E with
    /// `SealEvidenceTooOld`. Matters: the beacon roots ring buffer holds about a day of roots; without the rule a stale
    /// header could close a new route.
    function test_sealOnly_refusesEvidenceOlderThanTheDeployment() public {
        uint256 oldTime = block.timestamp;
        uint64 oldSlot = _slotIn(EPOCH_E, 2);
        bytes memory stale = _sealEvidence(oldTime, oldSlot, UNKNOWN_FORK);
        _warpIntoEpoch(EPOCH_E + 1, 3);
        BeaconForkGate later = _newGate(BeaconForkGate.GateMode.SealOnly);
        vm.expectRevert(
            abi.encodeWithSelector(BeaconForkGate.SealEvidenceTooOld.selector, oldSlot, later.deploymentSlot())
        );
        later.seal(stale);
    }

    /// Claim: on a chain without beacon roots, the registry-mode seal-only gate seals only from the registry, and never
    /// runs a probe or a canary. Shows: with no code at the beacon roots address, `seal(evidence)` reverts
    /// `BeaconRootUnavailable` (not `BeaconRootsAbsent`: there is no detection step) without calling the opcode probe or
    /// the BLS precompile; `seal("")` with nothing observed reverts `NoDisallowedObservedShape`; with an allowed shape
    /// observed it reverts the same; with shape 8 observed it seals. Matters: this is PulseChain. Its seal has to come
    /// from the fork registry.
    function test_sealOnlyWithRegistry_sealsFromTheRegistryOnAChainWithoutBeaconRoots() public {
        vm.etch(BEACON_ROOTS, "");
        bytes memory evidence = _evidenceOf(
            block.timestamp,
            _header(_slotIn(EPOCH_E, 2), bytes32(uint256(1))),
            UNKNOWN_FORK,
            _stateTree(DISALLOWED_DEPTH, UNKNOWN_FORK, ELECTRA)
        );
        vm.expectCall(sealOnlyWithRegistry.opcodeProbe(), "", 0);
        vm.expectCall(address(0x0b), "", 0);
        vm.expectRevert(abi.encodeWithSelector(BeaconForkGate.BeaconRootUnavailable.selector, block.timestamp));
        sealOnlyWithRegistry.seal(evidence);

        vm.expectRevert(BeaconForkGate.NoDisallowedObservedShape.selector);
        sealOnlyWithRegistry.seal("");
        _observe(ELECTRA, 6, lightClientForA.head() + 50);
        vm.expectRevert(BeaconForkGate.NoDisallowedObservedShape.selector);
        sealOnlyWithRegistry.seal("");
        _observe(UNKNOWN_FORK, DISALLOWED_SHAPE, lightClientForA.head() + 100);
        sealOnlyWithRegistry.seal("");
        assertTrue(sealOnlyWithRegistry.isSealed());
    }

    /// Claim: `SealOnly` with empty evidence and no registry decodes nothing and reverts. Shows: `seal("")` reverts (an
    /// abi decode of empty bytes). Matters: the registry path exists only where a registry was deployed.
    function test_sealOnly_emptyEvidenceWithoutRegistryReverts() public {
        vm.expectRevert();
        sealOnly.seal("");
        assertFalse(sealOnly.isSealed());
    }

    // ================================================================ construction

    /// Claim: the two seal-only modes read back, apply their rule from the first call, and pair with the registry as
    /// declared. Shows: `mode()` is 3 and 4 (the three earlier values keep their numbers); `enforcing()` is true from
    /// deployment; `SealOnly` with a registry and `SealOnlyWithRegistry` without one each revert
    /// `ForkRegistryMismatch`; `SealOnlyWithRegistry` with an address without code reverts `ForkRegistryHasNoCode`.
    /// Matters: the deploy script derives the registry deployment from the mode, and testnet gates of the earlier modes
    /// must keep decoding.
    function test_sealOnly_constructorAndModes() public {
        assertEq(uint256(BeaconForkGate.GateMode.Enforcing), 0);
        assertEq(uint256(BeaconForkGate.GateMode.DetectBeaconRoots), 1);
        assertEq(uint256(BeaconForkGate.GateMode.DetectBeaconRootsAndRegistry), 2);
        assertEq(uint256(sealOnly.mode()), 3);
        assertEq(uint256(sealOnlyWithRegistry.mode()), 4);
        assertTrue(sealOnly.enforcing());
        assertTrue(sealOnlyWithRegistry.enforcing());
        assertEq(address(sealOnly.forkRegistry()), address(0));
        assertEq(address(sealOnlyWithRegistry.forkRegistry()), address(registry));

        vm.expectRevert(
            abi.encodeWithSelector(
                BeaconForkGate.ForkRegistryMismatch.selector, BeaconForkGate.GateMode.SealOnly, address(registry)
            )
        );
        _registryGate(BeaconForkGate.GateMode.SealOnly, address(registry));
        vm.expectRevert(
            abi.encodeWithSelector(
                BeaconForkGate.ForkRegistryMismatch.selector, BeaconForkGate.GateMode.SealOnlyWithRegistry, address(0)
            )
        );
        _registryGate(BeaconForkGate.GateMode.SealOnlyWithRegistry, address(0));
        vm.expectRevert(abi.encodeWithSelector(BeaconForkGate.ForkRegistryHasNoCode.selector, address(0xdead)));
        _registryGate(BeaconForkGate.GateMode.SealOnlyWithRegistry, address(0xdead));
    }
}

/// @notice The cost of the seal-only gate, receipt level (each call its own transaction, refund capped at a fifth).
contract SealOnlyGateGasTest is GateSupport {
    /// Claim: `admit` of a seal-only gate is one cold storage read, and costs the same in every epoch. Shows: each send
    /// is its own transaction (isolation); the receipt gas of a send through a seal-only gate, less that of a send
    /// through a gate that reads nothing, is under 3,000 (a cold `SLOAD` is 2,100) and the same in two epochs; logged.
    /// Matters: "one storage read, about 3,500 gas, the same for every send" (A2). A regression that reads more would
    /// show here.
    /// forge-config: default.isolate = true
    /// forge-config: deep.isolate = true
    function test_gas_admitIsOneStorageRead() public {
        _warpIntoEpoch(EPOCH_E, 3);
        _etchMock();
        BeaconForkGate gate = _newGate(BeaconForkGate.GateMode.SealOnly);
        MessageBridge sender = _bridgeWithGate(address(gate));
        MessageBridge baseline = _bridgeWithGate(address(new AdmitNothing()));
        _sendGas(sender);
        _sendGas(baseline);

        uint256 withGate = _sendGas(sender);
        uint256 without = _sendGas(baseline);
        assertGe(without, 21_000, "control: isolation is on, each call is a transaction");
        _warpIntoEpoch(EPOCH_E + 1, 9);
        uint256 nextEpoch = _sendGas(sender);
        emit log_named_uint("send through a seal-only gate, receipt", withGate);
        emit log_named_uint("the same send through a gate that reads nothing", without);
        emit log_named_uint("admit of a seal-only gate inside a send", withGate - without);
        assertLt(withGate - without, 3_000, "one storage read");
        assertGt(withGate - without, 2_100, "control: the read is cold, as in a real send");
        assertEq(withGate, nextEpoch, "the same in every epoch");
    }

    function _sendGas(MessageBridge bridge) private returns (uint256) {
        vm.chainId(CHAIN_A);
        vm.prank(alice, alice);
        bridge.requireToPassMessage(makeAddr("target"), hex"c0ffee", 100_000);
        Vm.Gas memory spent = vm.lastCallGas();
        uint256 refund = uint256(int256(spent.gasRefunded));
        if (refund > spent.gasTotalUsed / 5) refund = spent.gasTotalUsed / 5;
        return spent.gasTotalUsed - refund;
    }
}

/// @notice A gate that admits everything and reads nothing: the baseline of the gas test.
contract AdmitNothing {
    function admit(bytes calldata) external {}
}
