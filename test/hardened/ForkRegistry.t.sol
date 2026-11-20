// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {BeaconForkGate} from "../../src/hardened/BeaconForkGate.sol";
import {BeaconLightClient} from "../../src/hardened/BeaconLightClient.sol";
import {MessageBridge} from "../../src/hardened/MessageBridge.sol";
import {ForkRegistry} from "../../src/hardened/ForkRegistry.sol";
import {OracleSP1Verifier} from "../mocks/OracleSP1Verifier.sol";
import {GateSupport} from "./utils/GateSupport.sol";

/// @notice Tests of `ForkRegistry` (hole HB-02 on PulseChain) and of the gate mode that reads it. The light client is
/// the fixture client that tracks chain B. The proof system is `OracleSP1Verifier`: a proof exists only when the test
/// signed it, under the key it names. The observation program and the light-client program have different keys.
contract ForkRegistryTest is GateSupport {
    bytes32 internal constant OBSERVATION_VKEY = keccak256("fork observation program");

    ForkRegistry internal registry;
    BeaconForkGate internal registryGate;

    /// @dev The plain depth that the observations of most tests prove: an allowed shape.
    uint8 internal constant ALLOWED_SHAPE = 6;
    /// @dev A shape outside the allowed set (a plain depth 8).
    uint8 internal constant DISALLOWED_SHAPE = 8;

    event ForkObserved(bytes4 indexed version, uint8 shape, uint64 slot);
    event GateSealedByFork(bytes4 version, uint64 slot);

    function setUp() public override {
        super.setUp();
        registry = new ForkRegistry(address(lightClientForA), address(verifier), OBSERVATION_VKEY);
        registryGate = _registryGate(address(registry));
        _warpIntoEpoch(EPOCH_E, 3);
        vm.etch(BEACON_ROOTS, "");
    }

    // ---------------------------------------------------------------- builders

    /// @dev A gate in registry mode that follows chain A and reads `registryAddress`.
    function _registryGate(address registryAddress) internal returns (BeaconForkGate) {
        return new BeaconForkGate(
            BEACON_ROOTS,
            BeaconForkGate.GateMode.DetectBeaconRootsAndRegistry,
            ETHEREUM_GENESIS,
            12,
            32,
            GENESIS_ROOT_A,
            registryAddress
        );
    }

    /// @dev An honest observation that starts from the stored head of `client`.
    function _observationFor(
        BeaconLightClient client,
        bytes32 genesisRoot,
        bytes4 version,
        uint8 shape,
        uint64 attestedSlot
    ) internal view returns (ForkRegistry.ForkObservation memory) {
        uint64 head = client.head();
        uint64 period = client.periodOf(head);
        return ForkRegistry.ForkObservation({
            genesisValidatorsRoot: genesisRoot,
            previousHeaderRoot: client.headers(head),
            previousHeadSlot: head,
            previousSyncCommitteeHash: client.syncCommittees(period),
            startNextSyncCommitteeHash: client.syncCommittees(period + 1),
            observedVersion: version,
            observedAttestedSlot: attestedSlot,
            shape: shape
        });
    }

    /// @dev An honest observation of an allowed shape.
    function _observation(bytes4 version, uint64 attestedSlot)
        internal
        view
        returns (ForkRegistry.ForkObservation memory)
    {
        return _observationFor(lightClientForA, GENESIS_ROOT_B, version, ALLOWED_SHAPE, attestedSlot);
    }

    /// @dev An honest observation that proves `shape`.
    function _observationOfShape(bytes4 version, uint8 shape, uint64 attestedSlot)
        internal
        view
        returns (ForkRegistry.ForkObservation memory)
    {
        return _observationFor(lightClientForA, GENESIS_ROOT_B, version, shape, attestedSlot);
    }

    /// @dev Observes with a proof of the observation program.
    function _observe(ForkRegistry.ForkObservation memory observation) internal {
        registry.observe(_prove(OBSERVATION_VKEY, abi.encode(observation)), abi.encode(observation));
    }

    function _observeExpectingRevert(ForkRegistry.ForkObservation memory observation, bytes memory revertData)
        internal
    {
        bytes memory proof = _prove(OBSERVATION_VKEY, abi.encode(observation));
        bytes memory values = abi.encode(observation);
        vm.expectRevert(revertData);
        registry.observe(proof, values);
    }

    /// @dev The head slot of the light client of chain B.
    function _head() internal view returns (uint64) {
        return lightClientForA.head();
    }

    // ================================================================ constructor

    /// Claim: the observation key must differ from the light-client key, and nothing may be zero. Shows: the equal key
    /// reverts with the key; zero values revert by name. Control: a different key deploys and the three immutables
    /// read back. Matters: with equal keys a proof of one program would pass for the other.
    function test_HB02_registry_constructorRefusesEqualKeysAndZeroValues() public {
        bytes32 lightClientKey = lightClientForA.programVKey();
        vm.expectRevert(
            abi.encodeWithSelector(ForkRegistry.ObservationKeyEqualsLightClientKey.selector, lightClientKey)
        );
        new ForkRegistry(address(lightClientForA), address(verifier), lightClientKey);
        vm.expectRevert(abi.encodeWithSelector(ForkRegistry.ZeroValue.selector, "lightClient"));
        new ForkRegistry(address(0), address(verifier), OBSERVATION_VKEY);
        vm.expectRevert(abi.encodeWithSelector(ForkRegistry.ZeroValue.selector, "verifier"));
        new ForkRegistry(address(lightClientForA), address(0), OBSERVATION_VKEY);
        vm.expectRevert(abi.encodeWithSelector(ForkRegistry.ZeroValue.selector, "observationProgramVKey"));
        new ForkRegistry(address(lightClientForA), address(verifier), bytes32(0));

        assertEq(address(registry.lightClient()), address(lightClientForA));
        assertEq(address(registry.verifier()), address(verifier));
        assertEq(registry.observationProgramVKey(), OBSERVATION_VKEY);
        assertEq(registry.latestObservedVersion(), bytes4(0), "nothing observed yet");
    }

    // ================================================================ start fields

    /// Claim: every start field must equal the stored light-client value (light-client rule 1). Shows: a wrong
    /// genesis root, head slot, header root, committee and next committee each revert with their own error and both
    /// values. Control: the honest observation, with the same proof key, is accepted and recorded. Matters: the
    /// private starting store of the program is bound to the chain, so a caller cannot invent a starting committee
    /// and make the program sign off on an observation by a committee that is not the real one.
    function test_HB02_registry_everyStartFieldMustMatchTheLightClient() public {
        uint64 slot = _head() + 100;
        ForkRegistry.ForkObservation memory good = _observation(UNKNOWN_FORK, slot);

        ForkRegistry.ForkObservation memory bad = _observation(UNKNOWN_FORK, slot);
        bad.genesisValidatorsRoot = GENESIS_ROOT_A;
        _observeExpectingRevert(
            bad,
            abi.encodeWithSelector(ForkRegistry.GenesisValidatorsRootMismatch.selector, GENESIS_ROOT_B, GENESIS_ROOT_A)
        );

        bad = _observation(UNKNOWN_FORK, slot);
        bad.previousHeadSlot = _head() + 1;
        _observeExpectingRevert(
            bad, abi.encodeWithSelector(ForkRegistry.PreviousHeadSlotMismatch.selector, _head(), _head() + 1)
        );

        bad = _observation(UNKNOWN_FORK, slot);
        bad.previousHeaderRoot = keccak256("another header");
        _observeExpectingRevert(
            bad,
            abi.encodeWithSelector(
                ForkRegistry.PreviousHeaderRootMismatch.selector, INITIAL_HEADER_ROOT, keccak256("another header")
            )
        );

        bad = _observation(UNKNOWN_FORK, slot);
        bad.previousSyncCommitteeHash = keccak256("another committee");
        _observeExpectingRevert(
            bad,
            abi.encodeWithSelector(
                ForkRegistry.PreviousSyncCommitteeMismatch.selector, COMMITTEE_100, keccak256("another committee")
            )
        );

        bad = _observation(UNKNOWN_FORK, slot);
        bad.startNextSyncCommitteeHash = bytes32(0);
        _observeExpectingRevert(
            bad, abi.encodeWithSelector(ForkRegistry.StartNextSyncCommitteeMismatch.selector, COMMITTEE_101, bytes32(0))
        );

        vm.expectEmit(true, false, false, true, address(registry));
        emit ForkObserved(UNKNOWN_FORK, ALLOWED_SHAPE, slot);
        _observe(good);
        assertEq(registry.firstSeenSlot(UNKNOWN_FORK), slot);
    }

    /// Claim: a light client with no stored next committee only accepts a start with a zero next committee. Shows: on a
    /// client whose next committee is zero, a non-zero start next committee reverts and zero passes. Matters: zero
    /// equals zero is the rule of the light client itself; a looser rule would let a caller choose the next committee.
    function test_HB02_registry_zeroNextCommitteeMeansZero() public {
        BeaconLightClient bare = _newLightClient(GENESIS_ROOT_B, bytes32(0));
        ForkRegistry bareRegistry = new ForkRegistry(address(bare), address(verifier), OBSERVATION_VKEY);
        ForkRegistry.ForkObservation memory observation =
            _observationFor(bare, GENESIS_ROOT_B, ELECTRA, ALLOWED_SHAPE, bare.head() + 5);
        observation.startNextSyncCommitteeHash = COMMITTEE_101;
        bytes memory proof = _prove(OBSERVATION_VKEY, abi.encode(observation));
        bytes memory values = abi.encode(observation);
        vm.expectRevert(
            abi.encodeWithSelector(ForkRegistry.StartNextSyncCommitteeMismatch.selector, bytes32(0), COMMITTEE_101)
        );
        bareRegistry.observe(proof, values);

        observation.startNextSyncCommitteeHash = bytes32(0);
        bareRegistry.observe(_prove(OBSERVATION_VKEY, abi.encode(observation)), abi.encode(observation));
        assertEq(bareRegistry.firstSeenSlot(ELECTRA), bare.head() + 5);
    }

    // ================================================================ length

    /// Claim: `observe` takes exactly 256 bytes: eight words, the eighth being the proven shape. Shows: 255 bytes, 257
    /// bytes (one trailing byte, which ABI decoding would accept), 224 bytes (the old output without the shape) and 0
    /// bytes revert with the length. Control: 256 passes. Matters: trailing bytes would be signed
    /// into the proof and ignored by the decoder, so two different statements could share one decoded meaning.
    function test_HB02_registry_publicValuesMustBeExactly256Bytes() public {
        ForkRegistry.ForkObservation memory observation = _observation(ELECTRA, _head() + 1);
        bytes memory exact = abi.encode(observation);
        assertEq(exact.length, 256);
        bytes[4] memory wrong = [bytes(""), _truncate(exact, 255), _truncate(exact, 224), bytes.concat(exact, hex"00")];
        for (uint256 i = 0; i < wrong.length; i++) {
            bytes memory proof = _prove(OBSERVATION_VKEY, wrong[i]);
            vm.expectRevert(abi.encodeWithSelector(ForkRegistry.InvalidPublicValuesLength.selector, wrong[i].length));
            registry.observe(proof, wrong[i]);
        }
        registry.observe(_prove(OBSERVATION_VKEY, exact), exact);
    }

    function _truncate(bytes memory data, uint256 length) internal pure returns (bytes memory out) {
        out = new bytes(length);
        for (uint256 i = 0; i < length; i++) {
            out[i] = data[i];
        }
    }

    // ================================================================ freshness

    /// Claim: the attested slot must be strictly past the light-client head. Shows: a slot equal to the head and a slot
    /// before it revert `ObservationNotFresh`; head plus one passes. Matters: without it an old signature (for example
    /// one made under a version that the chain left long ago) could be replayed to make the gate refuse sends
    /// or to seal it falsely.
    function test_HB02_registry_freshnessNeedsASlotPastTheHead() public {
        _observeExpectingRevert(
            _observation(UNKNOWN_FORK, _head()),
            abi.encodeWithSelector(ForkRegistry.ObservationNotFresh.selector, _head(), _head())
        );
        _observeExpectingRevert(
            _observation(UNKNOWN_FORK, _head() - 1),
            abi.encodeWithSelector(ForkRegistry.ObservationNotFresh.selector, _head(), _head() - 1)
        );
        assertEq(registry.firstSeenSlot(UNKNOWN_FORK), 0, "nothing was recorded");
        _observe(_observation(UNKNOWN_FORK, _head() + 1));
        assertEq(registry.firstSeenSlot(UNKNOWN_FORK), _head() + 1);
    }

    /// Claim: after the light client moves forward, an observation that is fresh for the old head but built on it is
    /// refused for its start. Shows: the head advances, and the old observation reverts `PreviousHeadSlotMismatch`.
    /// Matters: an observation cannot outlive the head it was proven from.
    function test_HB02_registry_anObservationDoesNotSurviveAHeadUpdate() public {
        ForkRegistry.ForkObservation memory old = _observation(UNKNOWN_FORK, _head() + 100);
        uint64 oldHead = _head();
        _finalize(lightClientForA, GENESIS_ROOT_B, keccak256("block"));
        _observeExpectingRevert(
            old, abi.encodeWithSelector(ForkRegistry.PreviousHeadSlotMismatch.selector, _head(), oldHead)
        );
        _observe(_observation(UNKNOWN_FORK, _head() + 100));
    }

    // ================================================================ ordering

    /// Claim: the registry keeps the minimum first-seen slot for each version. Shows: version V seen at head+300, then
    /// head+100, then head+200: `firstSeenSlot(V)` is head+300, then head+100, and stays head+100. Matters: the
    /// earliest slot is the best evidence of when a fork began.
    function test_HB02_registry_firstSeenSlotKeepsTheMinimum() public {
        uint64 head = _head();
        _observe(_observation(UNKNOWN_FORK, head + 300));
        assertEq(registry.firstSeenSlot(UNKNOWN_FORK), head + 300);
        _observe(_observation(UNKNOWN_FORK, head + 100));
        assertEq(registry.firstSeenSlot(UNKNOWN_FORK), head + 100, "an earlier slot moves the entry earlier");
        _observe(_observation(UNKNOWN_FORK, head + 200));
        assertEq(registry.firstSeenSlot(UNKNOWN_FORK), head + 100, "a later slot does not move it");
        assertEq(registry.firstSeenSlot(ELECTRA), 0, "a version never seen has no entry");
    }

    /// Claim: `latestObservedVersion` is the version with the highest slot seen, whatever the order of arrival. Shows:
    /// ELECTRA at head+100, then the unknown version at head+300 (latest moves), then ELECTRA at head+200 (latest
    /// stays); entries are never removed. Matters: the gate refuses on the latest version, so a late arrival of an
    /// older observation must not hide a newer fork.
    function test_HB02_registry_latestVersionIsTheOneWithTheHighestSlot() public {
        uint64 head = _head();
        _observe(_observation(ELECTRA, head + 100));
        assertEq(registry.latestObservedVersion(), ELECTRA);
        _observe(_observation(UNKNOWN_FORK, head + 300));
        assertEq(registry.latestObservedVersion(), UNKNOWN_FORK);
        _observe(_observation(ELECTRA, head + 200));
        assertEq(registry.latestObservedVersion(), UNKNOWN_FORK, "an older slot does not take the latest place");
        (bytes4 version, uint8 shape, uint64 slot) = registry.latestObserved();
        assertEq(version, UNKNOWN_FORK);
        assertEq(shape, ALLOWED_SHAPE);
        assertEq(slot, head + 300);
        assertEq(registry.firstSeenSlot(ELECTRA), head + 100, "entries stay");
        assertEq(registry.firstSeenSlot(UNKNOWN_FORK), head + 300);
    }

    // ================================================================ the shape

    /// Claim: the registry stores the proven shape next to each version, for the shape of the newest observation of that
    /// version, and the latest record carries the shape of the newest observation overall. Shows: ELECTRA at shape 6
    /// (head+100), then ELECTRA at shape 7 (head+300), then ELECTRA at shape 5 with an older slot (head+200): `shapeOf`
    /// is 6, then 7, then stays 7, and `latestObserved` reports shape 7 at head+300. The progressive marker 255 and the
    /// shape 8 are stored as given, and the event carries the shape. Control: a version never seen has shape zero.
    /// Matters: the gate judges the stored shape with the rule of `ForkShape`. If a late observation of an older shape
    /// overwrote the newest one, a fork could be hidden from the gate.
    function test_HB02_registry_theShapeFollowsTheNewestObservationOfAVersion() public {
        uint64 head = _head();
        _observe(_observationOfShape(ELECTRA, 6, head + 100));
        assertEq(registry.shapeOf(ELECTRA), 6);
        _observe(_observationOfShape(ELECTRA, 7, head + 300));
        assertEq(registry.shapeOf(ELECTRA), 7);
        _observe(_observationOfShape(ELECTRA, 5, head + 200));
        assertEq(registry.shapeOf(ELECTRA), 7, "an older slot does not overwrite the newest shape");
        (bytes4 version, uint8 shape, uint64 slot) = registry.latestObserved();
        assertEq(version, ELECTRA);
        assertEq(shape, 7);
        assertEq(slot, head + 300);
        assertEq(registry.shapeOf(UNKNOWN_FORK), 0, "a version never seen has no shape");

        vm.expectEmit(true, false, false, true, address(registry));
        emit ForkObserved(UNKNOWN_FORK, 255, head + 400);
        _observe(_observationOfShape(UNKNOWN_FORK, 255, head + 400));
        assertEq(registry.shapeOf(UNKNOWN_FORK), 255);
        _observe(_observationOfShape(FULU, DISALLOWED_SHAPE, head + 500));
        assertEq(registry.shapeOf(FULU), DISALLOWED_SHAPE, "the registry records every proven shape and judges none");
    }

    // ================================================================ the two kinds of proof

    /// Claim: a light-client proof cannot be passed to `observe`, and an observation proof cannot be passed to
    /// `BeaconLightClient.update`. Shows, for each direction, two layers. Length: the 352-byte output is refused by
    /// `observe` and the 256-byte observation by `update`. Key: with the right length forced, a proof made under the
    /// other program's key fails the verifier (`InvalidProof`). Control: each contract accepts a proof under its own key.
    /// Matters: if one proof worked for both, a light-client proof could write a fork observation, or an observation
    /// could move the head of the light client.
    function test_HB02_registry_theTwoProofKindsCannotBeSwapped() public {
        BeaconLightClient.LightClientOutput memory output =
            _nextOutput(lightClientForA, GENESIS_ROOT_B, keccak256("block"));
        bytes memory outputValues = abi.encode(output);
        assertEq(outputValues.length, 352);
        bytes memory lightClientProof = _prove(LIGHT_CLIENT_VKEY, outputValues);

        // light-client proof into observe: wrong length
        vm.expectRevert(abi.encodeWithSelector(ForkRegistry.InvalidPublicValuesLength.selector, 352));
        registry.observe(lightClientProof, outputValues);

        // observation proof into update: wrong length
        ForkRegistry.ForkObservation memory observation = _observation(UNKNOWN_FORK, _head() + 100);
        bytes memory observationValues = abi.encode(observation);
        bytes memory observationProof = _prove(OBSERVATION_VKEY, observationValues);
        vm.expectRevert(abi.encodeWithSelector(BeaconLightClient.InvalidPublicValuesLength.selector, 256));
        lightClientForA.update(observationProof, observationValues);

        // right length, wrong key: the observation signed by the light-client program
        bytes memory observationUnderLightClientKey = _prove(LIGHT_CLIENT_VKEY, observationValues);
        vm.expectRevert(OracleSP1Verifier.InvalidProof.selector);
        registry.observe(observationUnderLightClientKey, observationValues);

        // right length, wrong key: the light-client output signed by the observation program
        bytes memory outputUnderObservationKey = _prove(OBSERVATION_VKEY, outputValues);
        vm.expectRevert(OracleSP1Verifier.InvalidProof.selector);
        lightClientForA.update(outputUnderObservationKey, outputValues);

        // controls: each proof under its own key and its own contract
        registry.observe(observationProof, observationValues);
        lightClientForA.update(lightClientProof, outputValues);
        assertEq(registry.firstSeenSlot(UNKNOWN_FORK), observation.observedAttestedSlot);
    }

    // ================================================================ fixtures of the program

    /// Claim: the registry agrees with the program fixtures in `light-client/tests/fixtures/fork-observation`. Shows:
    /// for both chains, the four accepted observations are recorded by the registry when it starts from the light
    /// client state in the fixture (version outside the table included), and the eight rejected ones revert with the
    /// error that matches their reason (`StartMismatch` by the field that differs, `NotFresh`, `WrongLength`).
    /// Matters: the program and the contract are written separately; this test ties the byte layout and the rules of
    /// both to the same files, so a drift in either one fails here.
    function test_HB02_registry_agreesWithTheProgramFixtures() public {
        string[2] memory chains = ["ethereum", "pulsechain"];
        string[4] memory accepted = [
            "accept_version_in_the_table",
            "accept_version_outside_the_table",
            "accept_after_folding_a_stale_store",
            "accept_plain_depth_eight_after_folding_a_stale_store"
        ];
        string[5] memory rejected = [
            "reject_not_fresh",
            "reject_start_committee_differs",
            "reject_start_header_differs",
            "reject_start_next_committee_differs",
            "reject_light_client_output_as_public_values"
        ];
        for (uint256 c = 0; c < chains.length; c++) {
            for (uint256 i = 0; i < accepted.length; i++) {
                _checkFixture(chains[c], accepted[i], true);
            }
            for (uint256 i = 0; i < rejected.length; i++) {
                _checkFixture(chains[c], rejected[i], false);
            }
        }
    }

    function _checkFixture(string memory chain, string memory name, bool accepts) internal {
        string memory json =
            vm.readFile(string.concat("light-client/tests/fixtures/fork-observation/", chain, "_", name, ".json"));
        bytes memory values = vm.parseJsonBytes(json, ".publicValues");
        bytes32 genesisRoot = bytes32(_firstWord(values));
        BeaconLightClient client = new BeaconLightClient(
            address(verifier),
            LIGHT_CLIENT_VKEY,
            genesisRoot,
            SLOTS_PER_PERIOD,
            LIGHT_CLIENT_GENESIS_TIME,
            LIGHT_CLIENT_SECONDS_PER_SLOT,
            uint64(vm.parseJsonUint(json, ".lightClient.headSlot")),
            vm.parseJsonBytes32(json, ".lightClient.headerRoot"),
            vm.parseJsonBytes32(json, ".lightClient.currentSyncCommitteeHash"),
            vm.parseJsonBytes32(json, ".lightClient.nextSyncCommitteeHash")
        );
        ForkRegistry fixtureRegistry = new ForkRegistry(address(client), address(verifier), OBSERVATION_VKEY);
        bytes memory proof = _prove(OBSERVATION_VKEY, values);
        string memory label = string.concat(chain, " ", name);

        if (accepts) {
            fixtureRegistry.observe(proof, values);
            bytes4 version = bytes4(vm.parseJsonBytes(json, ".observedVersion"));
            assertEq(
                fixtureRegistry.firstSeenSlot(version), uint64(vm.parseJsonUint(json, ".observedAttestedSlot")), label
            );
            assertEq(fixtureRegistry.latestObservedVersion(), version, label);
            assertEq(
                fixtureRegistry.shapeOf(version), uint8(uint256(_wordAt(values, 7))), string.concat(label, " shape")
            );
            return;
        }
        string memory reason = vm.parseJsonString(json, ".expected.reason");
        bytes4 expected = _selectorForReason(reason, name);
        vm.expectPartialRevert(expected);
        fixtureRegistry.observe(proof, values);
    }

    function _firstWord(bytes memory values) internal pure returns (bytes32 word) {
        assembly {
            word := mload(add(values, 0x20))
        }
    }

    /// @dev The word at `index` of encoded public values.
    function _wordAt(bytes memory values, uint256 index) internal pure returns (bytes32 word) {
        assembly {
            word := mload(add(add(values, 0x20), mul(index, 0x20)))
        }
    }

    function _selectorForReason(string memory reason, string memory name) internal pure returns (bytes4) {
        if (_same(reason, "NotFresh")) return ForkRegistry.ObservationNotFresh.selector;
        if (_same(reason, "WrongLength")) return ForkRegistry.InvalidPublicValuesLength.selector;
        require(_same(reason, "StartMismatch"), "unknown fixture reason");
        if (_same(name, "reject_start_committee_differs")) return ForkRegistry.PreviousSyncCommitteeMismatch.selector;
        if (_same(name, "reject_start_header_differs")) return ForkRegistry.PreviousHeaderRootMismatch.selector;
        require(_same(name, "reject_start_next_committee_differs"), "unknown start fixture");
        return ForkRegistry.StartNextSyncCommitteeMismatch.selector;
    }

    function _same(string memory a, string memory b) internal pure returns (bool) {
        return keccak256(bytes(a)) == keccak256(bytes(b));
    }

    // ================================================================ the gate reads the registry

    /// @dev The registry shows a state shape outside the allowed set, under `UNKNOWN_FORK`.
    function _disallowedObserved() internal {
        _observe(_observationOfShape(UNKNOWN_FORK, DISALLOWED_SHAPE, _head() + 100));
    }

    /// Claim: an observed state shape outside the allowed set refuses sends and allows `seal("")`. Shows: through a real
    /// message bridge, a send passes before any observation (control); after the registry shows shape 8 the send reverts
    /// `ObservedShapeNotAllowed(version, shape, slot)`, with no message logged; `confirm` is refused too; anyone may call
    /// `seal("")`, which emits `GateSealedByFork` and closes the gate for good. Matters: this is how a PulseChain fork
    /// that the route cannot follow stops new sends within minutes, with no admin.
    function test_HB02_registryGate_aDisallowedObservedShapeRefusesSendsAndAllowsSeal() public {
        MessageBridge sender = _bridgeWithGate(address(registryGate));
        _send(sender, alice);

        _disallowedObserved();
        bytes memory expected = abi.encodeWithSelector(
            BeaconForkGate.ObservedShapeNotAllowed.selector, UNKNOWN_FORK, DISALLOWED_SHAPE, _head() + 100
        );
        vm.recordLogs();
        vm.expectRevert(expected);
        _send(sender, alice);
        assertEq(vm.getRecordedLogs().length, 0, "no message is logged");

        vm.expectRevert(expected);
        registryGate.confirm("");

        vm.expectEmit(address(registryGate));
        emit GateSealedByFork(UNKNOWN_FORK, _head() + 100);
        vm.prank(attacker);
        registryGate.seal("");
        assertTrue(registryGate.isSealed());
        vm.expectRevert(BeaconForkGate.GateSealed.selector);
        registryGate.admit("");
        vm.expectRevert(BeaconForkGate.GateSealed.selector);
        registryGate.seal("");
    }

    // ================================================================ a real depth 8 observation reaches the gate

    /// Claim: the 256 byte output of a REAL depth 8 observation (the program fixture, not a mock value) makes the gate in
    /// registry mode refuse deposits and lets anyone seal it with empty evidence. Shows: the fixture holds shape 8 and
    /// the observed version in its last words; before the observation a send passes (control); after it the registry
    /// shows shape 8 under that version, `ObservedShapeNotAllowed(version, 8, slot)` refuses the send, and `seal("")`
    /// emits `GateSealedByFork` and closes the gate. Matters: the program used to refuse depth 8 with no proof, so the
    /// registry could never record a disallowed shape and the gate never reacted. This test fails again if the program
    /// stops proving the shape, because the fixture then would not exist.
    function test_HB02_registryGate_aRealDepthEightObservationRefusesDepositsAndSeals() public {
        string memory json = vm.readFile(
            "light-client/tests/fixtures/fork-observation/pulsechain_accept_plain_depth_eight_after_folding_a_stale_store.json"
        );
        bytes memory values = vm.parseJsonBytes(json, ".publicValues");
        assertEq(values.length, 256, "the output of the program");
        assertEq(uint256(_wordAt(values, 7)), 8, "the program proved shape 8");
        BeaconLightClient client = new BeaconLightClient(
            address(verifier),
            LIGHT_CLIENT_VKEY,
            bytes32(_firstWord(values)),
            SLOTS_PER_PERIOD,
            LIGHT_CLIENT_GENESIS_TIME,
            LIGHT_CLIENT_SECONDS_PER_SLOT,
            uint64(vm.parseJsonUint(json, ".lightClient.headSlot")),
            vm.parseJsonBytes32(json, ".lightClient.headerRoot"),
            vm.parseJsonBytes32(json, ".lightClient.currentSyncCommitteeHash"),
            vm.parseJsonBytes32(json, ".lightClient.nextSyncCommitteeHash")
        );
        ForkRegistry fixtureRegistry = new ForkRegistry(address(client), address(verifier), OBSERVATION_VKEY);
        BeaconForkGate gate = _registryGate(address(fixtureRegistry));
        MessageBridge sender = _bridgeWithGate(address(gate));
        _send(sender, alice);

        fixtureRegistry.observe(_prove(OBSERVATION_VKEY, values), values);
        bytes4 version = bytes4(vm.parseJsonBytes(json, ".observedVersion"));
        uint64 slot = uint64(vm.parseJsonUint(json, ".observedAttestedSlot"));
        (bytes4 latestVersion, uint8 latestShape, uint64 latestSlot) = fixtureRegistry.latestObserved();
        assertEq(latestVersion, version);
        assertEq(latestShape, 8);
        assertEq(latestSlot, slot);

        vm.expectRevert(
            abi.encodeWithSelector(BeaconForkGate.ObservedShapeNotAllowed.selector, version, uint8(8), slot)
        );
        _send(sender, alice);

        vm.expectEmit(address(gate));
        emit GateSealedByFork(version, slot);
        vm.prank(attacker);
        gate.seal("");
        assertTrue(gate.isSealed());
    }

    /// Claim: an allowed observed shape changes nothing, whatever the version is called. Shows: with every allowed shape
    /// (5, 6, 7 and the marker 255) observed under an unlisted version, sends are admitted as before and `seal("")`
    /// reverts `NoDisallowedObservedShape`; an empty registry gives the same revert. Control: shape 8 then refuses.
    /// Matters: ordinary observations, and new names at known shapes, must never close a route, and a seal must need a
    /// disallowed shape in the registry. This is the rule that G-13 chooses for the registry path: the same rule as on
    /// Ethereum, applied to the shape that the observation program proved.
    function test_HB02_registryGate_anAllowedObservedShapeChangesNothing() public {
        MessageBridge sender = _bridgeWithGate(address(registryGate));
        vm.expectRevert(BeaconForkGate.NoDisallowedObservedShape.selector);
        registryGate.seal("");

        uint8[4] memory allowed = [uint8(5), 6, 7, 255];
        for (uint256 i = 0; i < allowed.length; i++) {
            _observe(_observationOfShape(UNKNOWN_FORK, allowed[i], _head() + uint64(100 * (i + 1))));
            _send(sender, alice);
            assertFalse(registryGate.enforcing());
            vm.expectRevert(BeaconForkGate.NoDisallowedObservedShape.selector);
            registryGate.seal("");
        }
        assertFalse(registryGate.isSealed());

        _observe(_observationOfShape(UNKNOWN_FORK, DISALLOWED_SHAPE, _head() + 500));
        vm.expectRevert(
            abi.encodeWithSelector(
                BeaconForkGate.ObservedShapeNotAllowed.selector, UNKNOWN_FORK, DISALLOWED_SHAPE, _head() + 500
            )
        );
        _send(sender, alice);
    }

    /// Claim: the refusal follows the latest observation until a seal makes it permanent. Shows: shape 8 at head+100
    /// refuses; an allowed shape at a higher slot lifts the refusal; shape 8 again at a higher slot refuses and a seal
    /// closes the gate, after which a newer allowed observation does not reopen it. Matters: the registry is a record of
    /// proven facts, and only the seal is irreversible.
    function test_HB02_registryGate_onlyTheSealIsPermanent() public {
        _disallowedObserved();
        vm.expectRevert(
            abi.encodeWithSelector(
                BeaconForkGate.ObservedShapeNotAllowed.selector, UNKNOWN_FORK, DISALLOWED_SHAPE, _head() + 100
            )
        );
        registryGate.admit("");
        _observe(_observation(ELECTRA, _head() + 200));
        registryGate.admit(""); // lifted
        _observe(_observationOfShape(UNKNOWN_FORK, DISALLOWED_SHAPE, _head() + 300));
        registryGate.seal("");
        _observe(_observation(ELECTRA, _head() + 400));
        vm.expectRevert(BeaconForkGate.GateSealed.selector);
        registryGate.admit("");
    }

    /// Claim: the registry address and the mode go together. Shows: registry mode with a zero address, registry mode
    /// with an address without code, and the other modes with a registry address each revert; registry mode with a
    /// real registry deploys. Matters: a gate that ignores a configured registry, or waits for a missing one, would
    /// be misconfigured without any sign.
    function test_HB02_registryGate_constructorMatchesRegistryAndMode() public {
        vm.expectRevert(
            abi.encodeWithSelector(
                BeaconForkGate.ForkRegistryMismatch.selector,
                BeaconForkGate.GateMode.DetectBeaconRootsAndRegistry,
                address(0)
            )
        );
        new BeaconForkGate(
            BEACON_ROOTS,
            BeaconForkGate.GateMode.DetectBeaconRootsAndRegistry,
            ETHEREUM_GENESIS,
            12,
            32,
            GENESIS_ROOT_A,
            address(0)
        );
        vm.expectRevert(abi.encodeWithSelector(BeaconForkGate.ForkRegistryHasNoCode.selector, address(0xdead)));
        new BeaconForkGate(
            BEACON_ROOTS,
            BeaconForkGate.GateMode.DetectBeaconRootsAndRegistry,
            ETHEREUM_GENESIS,
            12,
            32,
            GENESIS_ROOT_A,
            address(0xdead)
        );
        BeaconForkGate.GateMode[2] memory others =
            [BeaconForkGate.GateMode.Enforcing, BeaconForkGate.GateMode.DetectBeaconRoots];
        for (uint256 i = 0; i < others.length; i++) {
            vm.expectRevert(
                abi.encodeWithSelector(BeaconForkGate.ForkRegistryMismatch.selector, others[i], address(registry))
            );
            new BeaconForkGate(BEACON_ROOTS, others[i], ETHEREUM_GENESIS, 12, 32, GENESIS_ROOT_A, address(registry));
        }
        assertEq(address(registryGate.forkRegistry()), address(registry));
        assertEq(address(_newGate(BeaconForkGate.GateMode.DetectBeaconRoots).forkRegistry()), address(0));
    }
}
