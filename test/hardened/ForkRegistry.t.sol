// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {BeaconForkGate} from "../../src/hardened/BeaconForkGate.sol";
import {BeaconLightClient} from "../../src/hardened/BeaconLightClient.sol";
import {BridgeVault} from "../../src/hardened/BridgeVault.sol";
import {ForkRegistry} from "../../src/hardened/ForkRegistry.sol";
import {OracleSP1Verifier} from "../../src/mocks/OracleSP1Verifier.sol";
import {GateSupport} from "./utils/GateSupport.sol";

/// @notice Tests of `ForkRegistry` (hole HB-02 on PulseChain) and of the gate mode that reads it. The light client is
/// the fixture client that tracks chain B. The proof system is `OracleSP1Verifier`: a proof exists only when the test
/// signed it, under the key it names. The observation program and the light-client program have different keys.
contract ForkRegistryTest is GateSupport {
    bytes32 internal constant OBSERVATION_VKEY = keccak256("fork observation program");

    ForkRegistry internal registry;
    BeaconForkGate internal registryGate;

    event ForkObserved(bytes4 indexed version, uint64 slot);
    event GateSealedByFork(bytes4 version, uint64 slot);

    function setUp() public override {
        super.setUp();
        registry = new ForkRegistry(address(lightClientForA), address(verifier), OBSERVATION_VKEY);
        registryGate = _registryGate(address(registry));
        _warpIntoEpoch(EPOCH_E, 3);
        vm.etch(BEACON_ROOTS, "");
    }

    // ---------------------------------------------------------------- builders

    function _registryGate(address registryAddress) internal returns (BeaconForkGate) {
        BeaconForkGate.SupportedVersion[] memory versions = new BeaconForkGate.SupportedVersion[](4);
        versions[0] = BeaconForkGate.SupportedVersion(CAPELLA, 5);
        versions[1] = BeaconForkGate.SupportedVersion(DENEB, 5);
        versions[2] = BeaconForkGate.SupportedVersion(ELECTRA, 6);
        versions[3] = BeaconForkGate.SupportedVersion(FULU, 6);
        return new BeaconForkGate(
            BEACON_ROOTS,
            BeaconForkGate.GateMode.DetectBeaconRootsAndRegistry,
            ETHEREUM_GENESIS,
            12,
            32,
            versions,
            _depths(5, 6, 7),
            registryAddress
        );
    }

    /// @dev An honest observation that starts from the stored head of `client`.
    function _observationFor(BeaconLightClient client, bytes32 genesisRoot, bytes4 version, uint64 attestedSlot)
        internal
        view
        returns (ForkRegistry.ForkObservation memory)
    {
        uint64 head = client.head();
        uint64 period = client.periodOf(head);
        return ForkRegistry.ForkObservation({
            genesisValidatorsRoot: genesisRoot,
            previousHeaderRoot: client.headers(head),
            previousHeadSlot: head,
            previousSyncCommitteeHash: client.syncCommittees(period),
            startNextSyncCommitteeHash: client.syncCommittees(period + 1),
            observedVersion: version,
            observedAttestedSlot: attestedSlot
        });
    }

    function _observation(bytes4 version, uint64 attestedSlot) internal view returns (ForkRegistry.ForkObservation memory) {
        return _observationFor(lightClientForA, GENESIS_ROOT_B, version, attestedSlot);
    }

    function _observe(ForkRegistry.ForkObservation memory observation) internal {
        registry.observe(_prove(OBSERVATION_VKEY, abi.encode(observation)), abi.encode(observation));
    }

    function _observeExpectingRevert(ForkRegistry.ForkObservation memory observation, bytes memory revertData) internal {
        bytes memory proof = _prove(OBSERVATION_VKEY, abi.encode(observation));
        bytes memory values = abi.encode(observation);
        vm.expectRevert(revertData);
        registry.observe(proof, values);
    }

    function _head() internal view returns (uint64) {
        return lightClientForA.head();
    }

    // ================================================================ constructor

    /// Claim: the observation key must differ from the light-client key, and nothing may be zero. Shows: the equal key
    /// reverts with the key; zero values revert by name. Control: a different key deploys and the three immutables
    /// read back. Matters: with equal keys a proof of one program would pass for the other.
    function test_HB02_registry_constructorRefusesEqualKeysAndZeroValues() public {
        bytes32 lightClientKey = lightClientForA.programVKey();
        vm.expectRevert(abi.encodeWithSelector(ForkRegistry.ObservationKeyEqualsLightClientKey.selector, lightClientKey));
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
            bad, abi.encodeWithSelector(ForkRegistry.GenesisValidatorsRootMismatch.selector, GENESIS_ROOT_B, GENESIS_ROOT_A)
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
            bad,
            abi.encodeWithSelector(ForkRegistry.StartNextSyncCommitteeMismatch.selector, COMMITTEE_101, bytes32(0))
        );

        vm.expectEmit(true, false, false, true, address(registry));
        emit ForkObserved(UNKNOWN_FORK, slot);
        _observe(good);
        assertEq(registry.firstSeenSlot(UNKNOWN_FORK), slot);
    }

    /// Claim: a light client with no stored next committee only accepts a start with a zero next committee. Shows: on a
    /// client whose next committee is zero, a non-zero start next committee reverts and zero passes. Matters: zero
    /// equals zero is the rule of the light client itself; a looser rule would let a caller choose the next committee.
    function test_HB02_registry_zeroNextCommitteeMeansZero() public {
        BeaconLightClient bare = _newLightClient(GENESIS_ROOT_B, bytes32(0));
        ForkRegistry bareRegistry = new ForkRegistry(address(bare), address(verifier), OBSERVATION_VKEY);
        ForkRegistry.ForkObservation memory observation = _observationFor(bare, GENESIS_ROOT_B, ELECTRA, bare.head() + 5);
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

    /// Claim: `observe` takes exactly 224 bytes. Shows: 223 bytes, 225 bytes (one trailing byte, which ABI decoding
    /// would accept) and 0 bytes revert with the length. Control: 224 passes. Matters: trailing bytes would be signed
    /// into the proof and ignored by the decoder, so two different statements could share one decoded meaning.
    function test_HB02_registry_publicValuesMustBeExactly224Bytes() public {
        ForkRegistry.ForkObservation memory observation = _observation(ELECTRA, _head() + 1);
        bytes memory exact = abi.encode(observation);
        assertEq(exact.length, 224);
        bytes[3] memory wrong = [bytes(""), _truncate(exact, 223), bytes.concat(exact, hex"00")];
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
    /// one made under a version that the chain left long ago) could be replayed to make the gate refuse deposits
    /// or to seal it falsely.
    function test_HB02_registry_freshnessNeedsASlotPastTheHead() public {
        _observeExpectingRevert(
            _observation(UNKNOWN_FORK, _head()), abi.encodeWithSelector(ForkRegistry.ObservationNotFresh.selector, _head(), _head())
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
        (bytes4 version, uint64 slot) = registry.latestObserved();
        assertEq(version, UNKNOWN_FORK);
        assertEq(slot, head + 300);
        assertEq(registry.firstSeenSlot(ELECTRA), head + 100, "entries stay");
        assertEq(registry.firstSeenSlot(UNKNOWN_FORK), head + 300);
    }

    // ================================================================ the two kinds of proof

    /// Claim: a light-client proof cannot be passed to `observe`, and an observation proof cannot be passed to
    /// `BeaconLightClient.update`. Shows, for each direction, two layers. Length: the 352-byte output is refused by
    /// `observe` and the 224-byte observation by `update`. Key: with the right length forced, a proof made under the
    /// other program's key fails the verifier (`InvalidProof`). Control: each contract accepts a proof under its own key.
    /// Matters: if one proof worked for both, a light-client proof could write a fork observation, or an observation
    /// could move the head of the light client.
    function test_HB02_registry_theTwoProofKindsCannotBeSwapped() public {
        BeaconLightClient.LightClientOutput memory output = _nextOutput(lightClientForA, GENESIS_ROOT_B, keccak256("block"));
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
        vm.expectRevert(abi.encodeWithSelector(BeaconLightClient.InvalidPublicValuesLength.selector, 224));
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
    /// for both chains, the three accepted observations are recorded by the registry when it starts from the light
    /// client state in the fixture (version outside the table included), and the eight rejected ones revert with the
    /// error that matches their reason (`StartMismatch` by the field that differs, `NotFresh`, `WrongLength`).
    /// Matters: the program and the contract are written separately; this test ties the byte layout and the rules of
    /// both to the same files, so a drift in either one fails here.
    function test_HB02_registry_agreesWithTheProgramFixtures() public {
        string[2] memory chains = ["ethereum", "pulsechain"];
        string[3] memory accepted =
            ["accept_version_in_the_table", "accept_version_outside_the_table", "accept_after_folding_a_stale_store"];
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
        string memory json = vm.readFile(
            string.concat("light-client/tests/fixtures/fork-observation/", chain, "_", name, ".json")
        );
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

    function _unsupportedObserved() internal {
        _observe(_observation(UNKNOWN_FORK, _head() + 100));
    }

    /// Claim: an unsupported observed version refuses deposits and allows `seal("")`. Shows: through a real vault,
    /// a deposit passes before any observation (control); after the registry shows an unsupported version the deposit
    /// reverts `UnsupportedObservedVersion`, with the tokens still in the wallet; `confirm` is refused too; anyone
    /// may call `seal("")`, which emits `GateSealedByFork` and closes the gate for good. Matters: this is how a
    /// PulseChain fork that the route cannot follow stops new deposits within minutes, with no admin.
    function test_HB02_registryGate_unsupportedObservedVersionRefusesDepositsAndAllowsSeal() public {
        BridgeVault vault = _vaultWithGate(address(registryGate));
        _depositWithEvidence(vault, alice, 1e18, "");
        assertEq(tokenOnA.balanceOf(address(vault)), 1e18, "control: admitted before the observation");

        _unsupportedObserved();
        tokenOnA.mint(alice, 1e18);
        vm.chainId(CHAIN_A);
        vm.startPrank(alice);
        tokenOnA.approve(address(vault), 1e18);
        vm.expectRevert(abi.encodeWithSelector(BeaconForkGate.UnsupportedObservedVersion.selector, UNKNOWN_FORK, _head() + 100));
        vault.deposit(address(tokenOnA), bob, 1e18, 0, "");
        vm.stopPrank();
        assertEq(tokenOnA.balanceOf(alice), 1e18, "the tokens stay in the wallet");

        vm.expectRevert(abi.encodeWithSelector(BeaconForkGate.UnsupportedObservedVersion.selector, UNKNOWN_FORK, _head() + 100));
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

    /// Claim: a supported observed version changes nothing. Shows: with ELECTRA observed, deposits are admitted as
    /// before and `seal("")` reverts `NoUnsupportedObservation`; an empty registry gives the same revert. Matters:
    /// ordinary observations must never close a route, and a seal must need an unsupported version in the registry.
    function test_HB02_registryGate_supportedObservedVersionChangesNothing() public {
        BridgeVault vault = _vaultWithGate(address(registryGate));
        vm.expectRevert(BeaconForkGate.NoUnsupportedObservation.selector);
        registryGate.seal("");

        _observe(_observation(ELECTRA, _head() + 100));
        _depositWithEvidence(vault, alice, 1e18, "");
        assertEq(tokenOnA.balanceOf(address(vault)), 1e18);
        assertFalse(registryGate.enforcing());
        vm.expectRevert(BeaconForkGate.NoUnsupportedObservation.selector);
        registryGate.seal("");
        assertFalse(registryGate.isSealed());
    }

    /// Claim: the refusal follows the latest observation until a seal makes it permanent. Shows: an unsupported
    /// version at head+100 refuses; a supported version at a higher slot lifts the refusal; the unsupported version
    /// again at a higher slot refuses and a seal closes the gate, after which a newer supported observation does not
    /// reopen it. Matters: the registry is a record of proven facts, and only the seal is irreversible.
    function test_HB02_registryGate_onlyTheSealIsPermanent() public {
        _unsupportedObserved();
        vm.expectRevert(abi.encodeWithSelector(BeaconForkGate.UnsupportedObservedVersion.selector, UNKNOWN_FORK, _head() + 100));
        registryGate.admit("");
        _observe(_observation(ELECTRA, _head() + 200));
        registryGate.admit(""); // lifted
        _observe(_observation(UNKNOWN_FORK, _head() + 300));
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
        BeaconForkGate.SupportedVersion[] memory versions = _oneVersion(ELECTRA, 6);
        uint8[] memory depths = _depths(6);
        vm.expectRevert(
            abi.encodeWithSelector(
                BeaconForkGate.ForkRegistryMismatch.selector, BeaconForkGate.GateMode.DetectBeaconRootsAndRegistry, address(0)
            )
        );
        new BeaconForkGate(
            BEACON_ROOTS, BeaconForkGate.GateMode.DetectBeaconRootsAndRegistry, ETHEREUM_GENESIS, 12, 32, versions, depths, address(0)
        );
        vm.expectRevert(
            abi.encodeWithSelector(BeaconForkGate.ForkRegistryHasNoCode.selector, address(0xdead))
        );
        new BeaconForkGate(
            BEACON_ROOTS, BeaconForkGate.GateMode.DetectBeaconRootsAndRegistry, ETHEREUM_GENESIS, 12, 32, versions, depths, address(0xdead)
        );
        BeaconForkGate.GateMode[2] memory others = [BeaconForkGate.GateMode.Enforcing, BeaconForkGate.GateMode.DetectBeaconRoots];
        for (uint256 i = 0; i < others.length; i++) {
            vm.expectRevert(abi.encodeWithSelector(BeaconForkGate.ForkRegistryMismatch.selector, others[i], address(registry)));
            new BeaconForkGate(BEACON_ROOTS, others[i], ETHEREUM_GENESIS, 12, 32, versions, depths, address(registry));
        }
        assertEq(address(registryGate.forkRegistry()), address(registry));
        assertEq(address(_newGate(BeaconForkGate.GateMode.DetectBeaconRoots).forkRegistry()), address(0));
    }
}
