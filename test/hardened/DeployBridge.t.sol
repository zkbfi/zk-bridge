// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test, console2} from "forge-std/Test.sol";
import {DeployBridge} from "../../script/hardened/DeployBridge.s.sol";
import {BeaconLightClient} from "../../src/hardened/BeaconLightClient.sol";
import {MessageBridge} from "../../src/hardened/MessageBridge.sol";
import {TokenMediator} from "../../src/hardened/mediator/TokenMediator.sol";
import {TokenFactory} from "../../src/hardened/mediator/TokenFactory.sol";
import {WETHOmnibridgeRouter} from "../../src/hardened/mediator/WETHOmnibridgeRouter.sol";
import {FeeRouter} from "../../src/hardened/mediator/FeeRouter.sol";
import {ITokenMediator} from "../../src/hardened/mediator/ITokenMediator.sol";
import {IWETH} from "../../src/hardened/mediator/IWETH.sol";
import {BeaconForkGate} from "../../src/hardened/BeaconForkGate.sol";
import {ForkRegistry} from "../../src/hardened/ForkRegistry.sol";
import {OracleSP1Verifier} from "../../src/mocks/OracleSP1Verifier.sol";
import {MockWrappedNative} from "../../src/mocks/MockWrappedNative.sol";
import {DeployFlowLimiter} from "./utils/DeployMocks.sol";

/// @notice Tests of the deploy script logic. One Foundry chain plays both chains: the test switches `block.chainid`
/// and the deployer nonce with cheatcodes, and it uses different nonces on the two sides so the addresses differ.
/// Chain A is Ethereum (chain identifier 1) and chain B is PulseChain (chain identifier 369). The nonce table is in the
/// comment of the script. Chain A has a wrapped native token and a fee router. Chain B has a wrapped native token and no
/// fee router.
/// The `run()` entry point needs two live endpoints (see the harness) and is not run here.
contract DeployBridgeTest is Test {
    DeployBridge internal script;
    OracleSP1Verifier internal verifier;
    MockWrappedNative internal wrappedNativeOnA;
    MockWrappedNative internal wrappedNativeOnB;

    address internal deployer = makeAddr("deployer");
    /// @dev The flow limiter that `_chainJson` writes for chain 1. Zero, as in the example configuration, unless a test sets it.
    address internal configuredFlowLimiter;
    uint256 internal constant NONCE_A = 3;
    uint256 internal constant NONCE_B = 20;
    address internal constant BEACON_ROOTS = 0x000F3df6D732807Ef1319fB7B8bB8522d0Beac02;

    /// @dev The fork table of Ethereum: Capella, Deneb, Electra and Fulu.
    string internal constant ETHEREUM_VERSIONS = '[{"version":"0x03000000","stateDepth":"5"},'
        '{"version":"0x04000000","stateDepth":"5"},{"version":"0x05000000","stateDepth":"6"},'
        '{"version":"0x06000000","stateDepth":"6"}]';
    /// @dev The fork table of PulseChain: only Capella (it never scheduled Deneb).
    string internal constant PULSECHAIN_VERSIONS = '[{"version":"0x0000036c","stateDepth":"5"}]';
    string internal constant SEAL_DEPTHS = '["5","6","7"]';

    function setUp() public {
        script = new DeployBridge();
        verifier = new OracleSP1Verifier(makeAddr("oracle"));
        wrappedNativeOnA = new MockWrappedNative();
        wrappedNativeOnB = new MockWrappedNative();
    }

    // ---------------------------------------------------------------- configuration builders

    function _hexString(bytes32 value) internal pure returns (string memory) {
        return vm.toString(value);
    }

    /// @dev The settings of one chain. The light client part describes the OTHER chain. Chain 1 is Ethereum, so its
    /// light client tracks PulseChain (Capella epoch 3, era 0) and its gate follows Ethereum (enforcing from the start).
    /// Chain 369 is the reverse: its light client tracks Ethereum (Capella epoch 194048, era 758) and its gate follows
    /// PulseChain (detects the beacon roots contract). The verifier is pinned to its real code hash. The mediator on
    /// chain 1 has a live fee switch (the deployer is the authority); the mediator on chain 369 has none. Chain 1 deploys
    /// the native coin router and the fee router, chain 369 only the native coin router.
    function _chainJson(uint64 chainId, uint256 nonce, string memory verifierText, string memory slot)
        internal
        view
        returns (string memory)
    {
        string memory head = string.concat(
            '{"rpcAlias":"chain-', vm.toString(chainId), '","chainId":"', vm.toString(chainId),
            '","verifier":"', verifierText, '","verifierCodeHash":"', _hexString(address(verifier).codehash),
            '","depositCutoffTimestamp":"0","deployerNonce":"', vm.toString(nonce), '",',
            chainId == 1 ? _liveFeeJson() : _nullifiedFeeJson(),
            '"flowLimiter":"', vm.toString(chainId == 1 ? configuredFlowLimiter : address(0)), '",',
            '"wrappedNative":"', vm.toString(chainId == 1 ? address(wrappedNativeOnA) : address(wrappedNativeOnB)),
            '","deployFeeRouter":"', chainId == 1 ? "true" : "false", '",'
        );
        string memory client = string.concat(
            '"lightClient":{"programVKey":"', _hexString(keccak256("light client program")),
            chainId == 1 ? _pulsechainClock() : _ethereumClock(),
            '","genesisValidatorsRoot":"', _hexString(keccak256(abi.encode("genesis", chainId))),
            '","slotsPerPeriod":"8192",', chainId == 1 ? _pulsechainCapella() : _ethereumCapella()
        );
        string memory checkpoint = string.concat(
            '"initialSlot":"', slot, '","initialHeaderRoot":"', _hexString(keccak256("header")),
            '","initialSyncCommitteeHash":"', _hexString(keccak256("committee")),
            '","initialNextSyncCommitteeHash":"', _hexString(keccak256("next committee")), '"},'
        );
        return string.concat(
            head, client, checkpoint, chainId == 1 ? _ethereumGate() : string.concat(_pulsechainGate(), _observationJson(slot)), "}"
        );
    }

    function _liveFeeJson() internal view returns (string memory) {
        return string.concat(
            '"fee":{"authority":"', vm.toString(deployer), '","recipient":"', vm.toString(deployer),
            '","rate":"2500000000000000","ceiling":"5000000000000000"},'
        );
    }

    /// @dev A zero authority removes the fee from the start. The fee and the ceiling must then be zero.
    function _nullifiedFeeJson() internal pure returns (string memory) {
        return '"fee":{"authority":"0x0000000000000000000000000000000000000000","recipient":"0x0000000000000000000000000000000000000000","rate":"0","ceiling":"0"},';
    }

    /// @dev The own-chain light client and the registry settings of PulseChain. Its genesis validators root and period
    /// length are those that the light client of chain 1 tracks (the PulseChain beacon chain).
    function _observationJson(string memory slot) internal pure returns (string memory) {
        return string.concat(
            ',"observation":{"genesisTime":"1683785555","secondsPerSlot":"10","lightClientProgramVKey":"', _hexString(keccak256("light client program")),
            '","observationProgramVKey":"', _hexString(keccak256("fork observation program")),
            '","genesisValidatorsRoot":"', _hexString(keccak256(abi.encode("genesis", uint64(1)))),
            '","slotsPerPeriod":"8192","initialSlot":"', slot,
            '","initialHeaderRoot":"', _hexString(keccak256("own header")),
            '","initialSyncCommitteeHash":"', _hexString(keccak256("own committee")),
            '","initialNextSyncCommitteeHash":"', _hexString(keccak256("own next committee")), '"}'
        );
    }

    /// @dev The clock of the light client of chain 369: it tracks Ethereum, so it holds the clock of the Ethereum gate.
    function _ethereumClock() internal pure returns (string memory) {
        return '","genesisTime":"1606824023","secondsPerSlot":"12';
    }

    /// @dev The clock of the light client of chain 1: it tracks PulseChain, so it holds the clock of the PulseChain gate.
    function _pulsechainClock() internal pure returns (string memory) {
        return '","genesisTime":"1683785555","secondsPerSlot":"10';
    }

    function _ethereumCapella() internal pure returns (string memory) {
        return '"slotsPerEpoch":"32","capellaForkEpoch":"194048","capellaEra":"758",';
    }

    function _pulsechainCapella() internal pure returns (string memory) {
        return '"slotsPerEpoch":"32","capellaForkEpoch":"3","capellaEra":"0",';
    }

    function _ethereumGate() internal pure returns (string memory) {
        return string.concat(
            '"gate":{"mode":"Enforcing","genesisTime":"1606824023","secondsPerSlot":"12","slotsPerEpoch":"32",',
            '"supportedVersions":', ETHEREUM_VERSIONS, ',"sealDepths":', SEAL_DEPTHS, "}"
        );
    }

    function _pulsechainGate() internal pure returns (string memory) {
        return string.concat(
            '"gate":{"mode":"DetectBeaconRootsAndRegistry","genesisTime":"1683785555","secondsPerSlot":"10","slotsPerEpoch":"32",',
            '"supportedVersions":', PULSECHAIN_VERSIONS, ',"sealDepths":', SEAL_DEPTHS, "}"
        );
    }

    function _configJson(string memory deployerText, string memory slot) internal view returns (string memory) {
        string memory verifierText = vm.toString(address(verifier));
        return string.concat(
            '{"deployer":"', deployerText, '","chainA":', _chainJson(1, NONCE_A, verifierText, slot),
            ',"chainB":', _chainJson(369, NONCE_B, verifierText, slot), "}"
        );
    }

    function _validJson() internal view returns (string memory) {
        return _configJson(vm.toString(deployer), "819264");
    }

    function _deployments(DeployBridge.BridgeConfig memory config, DeployBridge.Plan memory plan)
        internal
        view
        returns (DeployBridge.ChainDeployment memory deploymentA, DeployBridge.ChainDeployment memory deploymentB)
    {
        return script.buildDeployments(config, plan);
    }

    /// @dev Puts code at the beacon roots address, as an Ethereum node has it.
    function _etchBeaconRoots() internal {
        vm.etch(BEACON_ROOTS, hex"00");
    }

    // ================================================================ configuration is validated

    /// Claim: the script parses a complete configuration. Shows: every field lands where it belongs, including the
    /// send cutoff, the Capella era of the other chain, and every gate setting of both chains.
    /// Matters: R2-08 (the plan starts from a configuration the script understands) and HB-02 (each gate is built from
    /// the settings of its own chain, so a swapped field would fail here).
    function test_R2_08_parseConfig_acceptsCompleteConfiguration() public view {
        DeployBridge.BridgeConfig memory config = script.parseConfig(_validJson());
        assertEq(config.deployer, deployer);
        assertEq(config.chainA.chainId, 1);
        assertEq(config.chainB.chainId, 369);
        assertEq(config.chainA.deployerNonce, NONCE_A);
        assertEq(config.chainB.deployerNonce, NONCE_B);
        assertEq(config.chainA.depositCutoffTimestamp, 0);
        assertEq(config.chainA.verifierCodeHash, address(verifier).codehash, "the pin is the code hash of the verifier");
        assertEq(config.chainB.verifierCodeHash, address(verifier).codehash);
        assertEq(config.chainA.fee.authority, deployer);
        assertEq(config.chainA.fee.recipient, deployer);
        assertEq(config.chainA.fee.rate, 2500000000000000);
        assertEq(config.chainA.fee.ceiling, 5000000000000000);
        assertEq(config.chainB.fee.authority, address(0), "chain B starts with the fee removed");
        assertEq(config.chainB.fee.rate, 0);
        assertEq(config.chainB.fee.ceiling, 0);
        assertEq(config.chainA.wrappedNative, address(wrappedNativeOnA));
        assertEq(config.chainB.wrappedNative, address(wrappedNativeOnB));
        assertEq(uint8(config.chainA.feeRouter), uint8(DeployBridge.RouterChoice.Deploy));
        assertEq(uint8(config.chainB.feeRouter), uint8(DeployBridge.RouterChoice.Skip));

        // The light client of chain A tracks PulseChain; the light client of chain B tracks Ethereum.
        assertEq(config.chainA.lightClient.capellaForkEpoch, 3);
        assertEq(config.chainA.lightClient.capellaEra, 0);
        assertEq(config.chainB.lightClient.capellaForkEpoch, 194048);
        assertEq(config.chainB.lightClient.capellaEra, 758);

        // The gate of chain A follows Ethereum, the gate of chain B follows PulseChain.
        assertEq(uint8(config.chainA.gate.mode), uint8(BeaconForkGate.GateMode.Enforcing));
        assertEq(config.chainA.gate.genesisTime, 1_606_824_023);
        assertEq(config.chainA.gate.secondsPerSlot, 12);
        assertEq(config.chainA.gate.slotsPerEpoch, 32);
        assertEq(config.chainA.gate.supportedVersions.length, 4);
        assertEq(config.chainA.gate.supportedVersions[0].version, bytes4(0x03000000));
        assertEq(config.chainA.gate.supportedVersions[0].stateDepth, 5);
        assertEq(config.chainA.gate.supportedVersions[2].version, bytes4(0x05000000));
        assertEq(config.chainA.gate.supportedVersions[2].stateDepth, 6);
        assertEq(config.chainA.gate.supportedVersions[3].version, bytes4(0x06000000));
        assertEq(config.chainA.gate.sealDepths.length, 3);
        assertEq(config.chainA.gate.sealDepths[0], 5);
        assertEq(config.chainA.gate.sealDepths[2], 7);

        assertEq(uint8(config.chainB.gate.mode), uint8(BeaconForkGate.GateMode.DetectBeaconRootsAndRegistry));
        assertEq(config.chainB.observation.genesisValidatorsRoot, config.chainA.lightClient.genesisValidatorsRoot);
        assertEq(config.chainB.observation.slotsPerPeriod, 8192);
        assertEq(config.chainB.observation.initialSlot, 819264);
        assertEq(config.chainB.observation.observationProgramVKey, keccak256("fork observation program"));
        assertEq(config.chainB.observation.lightClientProgramVKey, keccak256("light client program"));
        assertEq(config.chainA.observation.observationProgramVKey, bytes32(0), "Ethereum has no registry");
        assertEq(config.chainB.gate.genesisTime, 1_683_785_555);
        assertEq(config.chainB.gate.secondsPerSlot, 10);
        assertEq(config.chainB.gate.supportedVersions.length, 1);
        assertEq(config.chainB.gate.supportedVersions[0].version, bytes4(0x0000036c));
        assertEq(config.chainB.gate.supportedVersions[0].stateDepth, 5);
        assertEq(script.BEACON_ROOTS(), BEACON_ROOTS, "the script uses the address of EIP-4788");
    }

    /// Claim: the example configuration cannot be used as it is. Shows: reading the shipped example file reverts with a
    /// placeholder error on the first key. Matters: H-17 (placeholder strings reached the constructor in the
    /// specification's deploy notes).
    function test_R2_08_exampleConfigurationIsRefused() public {
        string memory json = vm.readFile("script/hardened/bridge.config.example.json");
        vm.expectRevert(abi.encodeWithSelector(DeployBridge.PlaceholderValue.selector, ".deployer"));
        script.parseConfig(json);
    }

    /// Claim: the example file holds every key the script reads for both chains, and no key the script no longer reads.
    /// Shows: each key exists in the example file; the removed `slotsPerHistoricalRoot` key and the removed token pairs
    /// do not. Matters: an
    /// example that lacks a key sends the operator into a failure the example never warned about, and an example with a
    /// dead key suggests a setting that no longer has any effect.
    function test_HB02_exampleConfigurationHoldsEveryKeyTheScriptReads() public view {
        string memory json = vm.readFile("script/hardened/bridge.config.example.json");
        string[2] memory chains = [".chainA", ".chainB"];
        string[25] memory keys = [
            ".rpcAlias", ".chainId", ".verifier", ".verifierCodeHash", ".depositCutoffTimestamp", ".deployerNonce",
            ".fee.authority", ".fee.recipient", ".fee.rate", ".fee.ceiling",
            ".flowLimiter", ".wrappedNative", ".deployFeeRouter", ".lightClient.programVKey", ".lightClient.genesisValidatorsRoot", ".lightClient.slotsPerPeriod",
            ".lightClient.genesisTime", ".lightClient.secondsPerSlot", ".lightClient.slotsPerEpoch", ".lightClient.capellaForkEpoch", ".lightClient.capellaEra",
            ".lightClient.initialSlot", ".lightClient.initialHeaderRoot", ".lightClient.initialSyncCommitteeHash",
            ".lightClient.initialNextSyncCommitteeHash"
        ];
        string[9] memory gateKeys = [
            ".gate.mode", ".gate.genesisTime", ".gate.secondsPerSlot", ".gate.slotsPerEpoch",
            ".gate.supportedVersions[0].version", ".gate.supportedVersions[0].stateDepth", ".gate.sealDepths[0]",
            ".gate.sealDepths[1]", ".gate.sealDepths[2]"
        ];
        for (uint256 c = 0; c < chains.length; c++) {
            for (uint256 k = 0; k < keys.length; k++) {
                assertTrue(vm.keyExistsJson(json, string.concat(chains[c], keys[k])), string.concat(chains[c], keys[k]));
            }
            for (uint256 k = 0; k < gateKeys.length; k++) {
                string memory path = string.concat(chains[c], gateKeys[k]);
                assertTrue(vm.keyExistsJson(json, path), path);
            }
            string memory removed = string.concat(chains[c], ".lightClient.slotsPerHistoricalRoot");
            assertFalse(vm.keyExistsJson(json, removed), "the removed key is still in the example");
        }
        string[10] memory observationKeys = [
            ".lightClientProgramVKey", ".observationProgramVKey", ".genesisValidatorsRoot", ".slotsPerPeriod",
            ".genesisTime", ".secondsPerSlot", ".initialSlot", ".initialHeaderRoot", ".initialSyncCommitteeHash", ".initialNextSyncCommitteeHash"
        ];
        for (uint256 k = 0; k < observationKeys.length; k++) {
            string memory path = string.concat(".chainB.observation", observationKeys[k]);
            assertTrue(vm.keyExistsJson(json, path), path);
        }
        assertFalse(vm.keyExistsJson(json, ".chainA.observation"), "Ethereum has no registry");
        assertFalse(vm.keyExistsJson(json, ".tokenPairs"), "the mediator needs no token registration");
    }

    /// Claim: a placeholder in any field is refused with the name of the field. Shows: ten fields in turn, three of
    /// them new gate and Capella fields. Matters: H-17.
    function test_R2_08_parseConfig_refusesPlaceholders() public {
        string memory json = _validJson();
        string memory placeholder = "REPLACE_WITH_VALUE";

        vm.expectRevert(abi.encodeWithSelector(DeployBridge.PlaceholderValue.selector, ".deployer"));
        script.parseConfig(_configJson(placeholder, "819264"));

        vm.expectRevert(abi.encodeWithSelector(DeployBridge.PlaceholderValue.selector, ".chainA.lightClient.initialSlot"));
        script.parseConfig(_configJson(vm.toString(deployer), placeholder));

        vm.expectRevert(abi.encodeWithSelector(DeployBridge.PlaceholderValue.selector, ".chainA.verifier"));
        script.parseConfig(vm.replace(json, vm.toString(address(verifier)), placeholder));

        vm.expectRevert(abi.encodeWithSelector(DeployBridge.PlaceholderValue.selector, ".chainA.verifierCodeHash"));
        script.parseConfig(vm.replace(json, vm.toString(address(verifier).codehash), placeholder));

        vm.expectRevert(abi.encodeWithSelector(DeployBridge.PlaceholderValue.selector, ".chainA.rpcAlias"));
        script.parseConfig(vm.replace(json, "chain-1", placeholder));

        vm.expectRevert(abi.encodeWithSelector(DeployBridge.PlaceholderValue.selector, ".chainA.deployerNonce"));
        script.parseConfig(vm.replace(json, string.concat('"deployerNonce":"', vm.toString(NONCE_A), '"'), '"deployerNonce":"REPLACE_ME"'));

        vm.expectRevert(abi.encodeWithSelector(DeployBridge.PlaceholderValue.selector, ".chainA.depositCutoffTimestamp"));
        script.parseConfig(vm.replace(json, '"depositCutoffTimestamp":"0"', '"depositCutoffTimestamp":"REPLACE_ME"'));

        vm.expectRevert(abi.encodeWithSelector(DeployBridge.PlaceholderValue.selector, ".chainA.lightClient.capellaForkEpoch"));
        script.parseConfig(vm.replace(json, '"capellaForkEpoch":"3"', '"capellaForkEpoch":"REPLACE_ME"'));

        vm.expectRevert(abi.encodeWithSelector(DeployBridge.PlaceholderValue.selector, ".chainA.gate.mode"));
        script.parseConfig(vm.replace(json, '"mode":"Enforcing"', '"mode":"REPLACE_ME"'));

        vm.expectRevert(
            abi.encodeWithSelector(DeployBridge.PlaceholderValue.selector, ".chainA.gate.supportedVersions[0].version")
        );
        script.parseConfig(vm.replace(json, '"version":"0x03000000"', '"version":"REPLACE_ME"'));

        vm.expectRevert(abi.encodeWithSelector(DeployBridge.PlaceholderValue.selector, ".chainA.gate.sealDepths[0]"));
        script.parseConfig(vm.replace(json, '"sealDepths":["5","6","7"]', '"sealDepths":["REPLACE_ME","6","7"]'));

        script.parseConfig(json); // the real values pass
    }

    /// Claim: zero values are refused with the name of the field. Shows: a zero deployer, a zero verifier, a zero chain
    /// identifier, a zero checkpoint header root, a zero committee, zero slots per period, and
    /// the zero gate settings (genesis time, seconds per slot, slots per epoch, fork version, state depth, seal depth).
    /// A zero deposit cutoff is valid (no cutoff). Matters: a zero value is an unset value (H-17).
    function test_R2_08_parseConfig_refusesZeroValues() public {
        string memory json = _validJson();
        string memory zeroAddress = vm.toString(address(0));
        string memory zeroWord = vm.toString(bytes32(0));

        vm.expectRevert(abi.encodeWithSelector(DeployBridge.ZeroConfigValue.selector, ".deployer"));
        script.parseConfig(_configJson(zeroAddress, "819264"));

        vm.expectRevert(abi.encodeWithSelector(DeployBridge.ZeroConfigValue.selector, ".chainA.verifier"));
        script.parseConfig(vm.replace(json, vm.toString(address(verifier)), zeroAddress));

        vm.expectRevert(abi.encodeWithSelector(DeployBridge.ZeroConfigValue.selector, ".chainA.verifierCodeHash"));
        script.parseConfig(vm.replace(json, vm.toString(address(verifier).codehash), zeroWord));

        vm.expectRevert(abi.encodeWithSelector(DeployBridge.ZeroConfigValue.selector, ".chainA.chainId"));
        script.parseConfig(vm.replace(json, '"chainId":"1"', '"chainId":"0"'));

        vm.expectRevert(abi.encodeWithSelector(DeployBridge.ZeroConfigValue.selector, ".chainA.lightClient.initialHeaderRoot"));
        script.parseConfig(vm.replace(json, vm.toString(keccak256("header")), zeroWord));

        vm.expectRevert(abi.encodeWithSelector(DeployBridge.ZeroConfigValue.selector, ".chainA.lightClient.initialSyncCommitteeHash"));
        script.parseConfig(vm.replace(json, vm.toString(keccak256("committee")), zeroWord));

        vm.expectRevert(abi.encodeWithSelector(DeployBridge.ZeroConfigValue.selector, ".chainA.lightClient.initialNextSyncCommitteeHash"));
        script.parseConfig(vm.replace(json, vm.toString(keccak256("next committee")), zeroWord));

        vm.expectRevert(abi.encodeWithSelector(DeployBridge.ZeroConfigValue.selector, ".chainA.lightClient.slotsPerPeriod"));
        script.parseConfig(vm.replace(json, '"slotsPerPeriod":"8192"', '"slotsPerPeriod":"0"'));

        vm.expectRevert(abi.encodeWithSelector(DeployBridge.ZeroConfigValue.selector, ".chainA.gate.genesisTime"));
        script.parseConfig(vm.replace(json, '"genesisTime":"1606824023"', '"genesisTime":"0"'));

        vm.expectRevert(abi.encodeWithSelector(DeployBridge.ZeroConfigValue.selector, ".chainA.gate.secondsPerSlot"));
        script.parseConfig(vm.replace(json, '"secondsPerSlot":"12"', '"secondsPerSlot":"0"'));

        vm.expectRevert(abi.encodeWithSelector(DeployBridge.ZeroConfigValue.selector, ".chainA.gate.slotsPerEpoch"));
        script.parseConfig(vm.replace(json, '"mode":"Enforcing","genesisTime":"1606824023","secondsPerSlot":"12","slotsPerEpoch":"32"', '"mode":"Enforcing","genesisTime":"1606824023","secondsPerSlot":"12","slotsPerEpoch":"0"'));

        vm.expectRevert(abi.encodeWithSelector(DeployBridge.ZeroConfigValue.selector, ".chainA.gate.supportedVersions[0].version"));
        script.parseConfig(vm.replace(json, '"version":"0x03000000"', '"version":"0x00000000"'));

        vm.expectRevert(abi.encodeWithSelector(DeployBridge.ZeroConfigValue.selector, ".chainA.gate.supportedVersions[1].stateDepth"));
        script.parseConfig(vm.replace(json, '{"version":"0x04000000","stateDepth":"5"}', '{"version":"0x04000000","stateDepth":"0"}'));

        vm.expectRevert(abi.encodeWithSelector(DeployBridge.ZeroConfigValue.selector, ".chainA.gate.sealDepths[1]"));
        script.parseConfig(vm.replace(json, '"sealDepths":["5","6","7"]', '"sealDepths":["5","0","7"]'));

        script.parseConfig(json); // the real values pass, and a zero cutoff is valid in them
    }

    /// Claim: both chains need different identifiers. Shows: equal identifiers revert, and the honest pair passes.
    /// Matters: the nonce domains.
    function test_R2_08_parseConfig_refusesSameChainIdentifier() public {
        string memory json = _validJson();
        script.parseConfig(json); // honest
        vm.expectRevert(abi.encodeWithSelector(DeployBridge.SameChainIdentifier.selector, uint64(1)));
        script.parseConfig(vm.replace(json, '"chainId":"369"', '"chainId":"1"'));
    }

    /// Claim: the Capella era must be the era of the Capella fork slot of the chain the light client tracks, rounded
    /// down. Shows: a wrong era on each chain reverts with the configured and the derived value; an epoch that sits one
    /// before an era boundary and one on it give the neighbouring eras; the honest values pass. Matters: HB-01 (the
    /// bridge turns a message slot into an index of `historical_summaries` with this number, so a number that is too low
    /// reads the wrong summary and one that is too high rejects every old deposit).
    function test_HB01_parseConfig_refusesCapellaEraThatDiffersFromTheForkEpoch() public {
        string memory json = _validJson();
        script.parseConfig(json); // honest: Ethereum 194048 * 32 / 8192 = 758, PulseChain 3 * 32 / 8192 = 0

        vm.expectRevert(abi.encodeWithSelector(DeployBridge.CapellaEraMismatch.selector, uint64(1), uint64(1), uint64(0)));
        script.parseConfig(vm.replace(json, '"capellaForkEpoch":"3","capellaEra":"0"', '"capellaForkEpoch":"3","capellaEra":"1"'));

        vm.expectRevert(abi.encodeWithSelector(DeployBridge.CapellaEraMismatch.selector, uint64(369), uint64(757), uint64(758)));
        script.parseConfig(vm.replace(json, '"capellaEra":"758"', '"capellaEra":"757"'));

        // Epoch 256 starts era 1 (256 * 32 = 8192). Epoch 255 still belongs to era 0.
        script.parseConfig(vm.replace(json, '"capellaForkEpoch":"3","capellaEra":"0"', '"capellaForkEpoch":"256","capellaEra":"1"'));
        vm.expectRevert(abi.encodeWithSelector(DeployBridge.CapellaEraMismatch.selector, uint64(1), uint64(1), uint64(0)));
        script.parseConfig(vm.replace(json, '"capellaForkEpoch":"3","capellaEra":"0"', '"capellaForkEpoch":"255","capellaEra":"1"'));
    }

    /// Claim: the gate mode must be one of the two names, spelled exactly. Shows: a lower case name and an unknown name
    /// revert with the text; both real names pass. Matters: HB-02 (a mode that parsed to the default would silently turn
    /// an enforcing gate into a detecting gate, which admits every deposit on a chain whose roots contract is absent).
    function test_HB02_parseConfig_refusesUnknownGateMode() public {
        string memory json = _validJson();
        script.parseConfig(vm.replace(json, '"mode":"Enforcing"', '"mode":"DetectBeaconRoots"')); // honest variant

        vm.expectRevert(abi.encodeWithSelector(DeployBridge.UnknownGateMode.selector, "enforcing"));
        script.parseConfig(vm.replace(json, '"mode":"Enforcing"', '"mode":"enforcing"'));

        vm.expectRevert(abi.encodeWithSelector(DeployBridge.UnknownGateMode.selector, "Detect"));
        script.parseConfig(vm.replace(json, '"mode":"DetectBeaconRootsAndRegistry"', '"mode":"Detect"'));
        // control: a PulseChain gate in plain detection mode needs no observation block
        script.parseConfig(vm.replace(json, '"mode":"DetectBeaconRootsAndRegistry"', '"mode":"DetectBeaconRoots"'));

        script.parseConfig(json); // honest
    }

    /// Claim: a fork version must be four bytes. Shows: three bytes and five bytes revert with the key and the length;
    /// four bytes pass. Matters: HB-02 (`bytes4` would cut a long value or pad a short one, and the gate would then
    /// support a version that nobody configured).
    function test_HB02_parseConfig_refusesForkVersionOfWrongLength() public {
        string memory json = _validJson();
        script.parseConfig(json); // honest

        vm.expectRevert(
            abi.encodeWithSelector(
                DeployBridge.ForkVersionLengthInvalid.selector, ".chainA.gate.supportedVersions[0].version", uint256(3)
            )
        );
        script.parseConfig(vm.replace(json, '"version":"0x03000000"', '"version":"0x030000"'));

        vm.expectRevert(
            abi.encodeWithSelector(
                DeployBridge.ForkVersionLengthInvalid.selector, ".chainB.gate.supportedVersions[0].version", uint256(5)
            )
        );
        script.parseConfig(vm.replace(json, '"version":"0x0000036c"', '"version":"0x0000036c00"'));
    }

    /// Claim: a gate needs at least one supported version and one seal depth. Shows: an empty list of each reverts with
    /// the key; the honest lists pass. Matters: HB-02 (the gate constructor refuses empty lists, and the script should
    /// refuse them before it spends gas on the first contract).
    function test_HB02_parseConfig_refusesEmptyGateLists() public {
        string memory json = _validJson();
        script.parseConfig(json); // honest

        vm.expectRevert(abi.encodeWithSelector(DeployBridge.EmptyConfigList.selector, ".chainA.gate.supportedVersions"));
        script.parseConfig(vm.replace(json, ETHEREUM_VERSIONS, "[]"));

        vm.expectRevert(abi.encodeWithSelector(DeployBridge.EmptyConfigList.selector, ".chainA.gate.sealDepths"));
        script.parseConfig(vm.replace(json, '"sealDepths":["5","6","7"]', '"sealDepths":[]'));
    }

    /// Claim: the values in the test configuration agree with the chain specifications shipped for the light-client
    /// program. Shows: Capella epoch, slots per epoch, seconds per slot, genesis time and fork versions of both chains
    /// read from the specification files equal the configuration, and the Capella era follows from the specification.
    /// Matters: HB-01 and HB-02 (the era and the fork table are the two numbers that must come from the chain, not from
    /// memory; the test configuration is the template an operator copies).
    function test_HB02_testConfigurationMatchesTheShippedChainSpecifications() public view {
        DeployBridge.BridgeConfig memory config = script.parseConfig(_validJson());
        string memory ethereumSpec = vm.readFile("light-client/tests/fixtures/ethereum/chain_spec.json");
        string memory pulsechainSpec = vm.readFile("light-client/tests/fixtures/pulsechain/chain_spec.json");
        string memory ethereumGenesis = vm.readFile("light-client/tests/fixtures/ethereum/genesis.json");
        string memory pulsechainGenesis = vm.readFile("light-client/tests/fixtures/pulsechain/genesis.json");

        // Ethereum is chain A for its gate, and chain B for the light client that tracks it.
        uint256 ethereumCapellaEpoch = _specNumber(ethereumSpec, "CAPELLA_FORK_EPOCH");
        uint256 ethereumSlotsPerEpoch = _specNumber(ethereumSpec, "SLOTS_PER_EPOCH");
        assertEq(config.chainB.lightClient.capellaForkEpoch, ethereumCapellaEpoch);
        assertEq(config.chainB.lightClient.slotsPerEpoch, ethereumSlotsPerEpoch);
        assertEq(config.chainB.lightClient.capellaEra, ethereumCapellaEpoch * ethereumSlotsPerEpoch / 8192);
        assertEq(config.chainA.gate.slotsPerEpoch, ethereumSlotsPerEpoch);
        assertEq(config.chainA.gate.secondsPerSlot, _specNumber(ethereumSpec, "SECONDS_PER_SLOT"));
        assertEq(config.chainA.gate.genesisTime, vm.parseUint(vm.parseJsonString(ethereumGenesis, ".response.data.genesis_time")));
        assertEq(config.chainA.gate.supportedVersions[0].version, _specVersion(ethereumSpec, "CAPELLA_FORK_VERSION"));
        assertEq(config.chainA.gate.supportedVersions[1].version, _specVersion(ethereumSpec, "DENEB_FORK_VERSION"));
        assertEq(config.chainA.gate.supportedVersions[2].version, _specVersion(ethereumSpec, "ELECTRA_FORK_VERSION"));
        assertEq(config.chainA.gate.supportedVersions[3].version, _specVersion(ethereumSpec, "FULU_FORK_VERSION"));

        uint256 pulsechainCapellaEpoch = _specNumber(pulsechainSpec, "CAPELLA_FORK_EPOCH");
        uint256 pulsechainSlotsPerEpoch = _specNumber(pulsechainSpec, "SLOTS_PER_EPOCH");
        assertEq(config.chainA.lightClient.capellaForkEpoch, pulsechainCapellaEpoch);
        assertEq(config.chainA.lightClient.slotsPerEpoch, pulsechainSlotsPerEpoch);
        assertEq(config.chainA.lightClient.capellaEra, pulsechainCapellaEpoch * pulsechainSlotsPerEpoch / 8192);
        assertEq(config.chainB.gate.slotsPerEpoch, pulsechainSlotsPerEpoch);
        assertEq(config.chainB.gate.secondsPerSlot, _specNumber(pulsechainSpec, "SECONDS_PER_SLOT"));
        assertEq(config.chainB.gate.genesisTime, vm.parseUint(vm.parseJsonString(pulsechainGenesis, ".response.data.genesis_time")));
        assertEq(config.chainB.gate.supportedVersions.length, 1, "PulseChain never scheduled Deneb");
        assertEq(config.chainB.gate.supportedVersions[0].version, _specVersion(pulsechainSpec, "CAPELLA_FORK_VERSION"));

        // The anchor of the test: the two eras the documentation names.
        assertEq(config.chainB.lightClient.capellaEra, 758);
        assertEq(config.chainA.lightClient.capellaEra, 0);
    }

    function _specNumber(string memory spec, string memory name) internal pure returns (uint256) {
        return vm.parseUint(vm.parseJsonString(spec, string.concat(".response.data.", name)));
    }

    function _specVersion(string memory spec, string memory name) internal pure returns (bytes4) {
        return bytes4(vm.parseBytes(vm.parseJsonString(spec, string.concat(".response.data.", name))));
    }

    // ================================================================ prediction

    /// @dev The addresses of both chains after `_deployBoth`.
    DeployBridge.Plan internal planned;
    DeployBridge.ChainAddresses internal deployedA;
    DeployBridge.ChainAddresses internal deployedB;

    /// @dev Deploys both chains from the configured nonces, as `run` does, and records the plan and the deployed addresses.
    function _deployBoth() internal {
        DeployBridge.BridgeConfig memory config = script.parseConfig(_validJson());
        planned = script.predictAddresses(config);
        (DeployBridge.ChainDeployment memory deploymentA, DeployBridge.ChainDeployment memory deploymentB) =
            _deployments(config, planned);
        _etchBeaconRoots();
        vm.chainId(1);
        vm.setNonce(deployer, uint64(NONCE_A));
        deployedA = script.deployChain(deploymentA);
        vm.chainId(369);
        vm.setNonce(deployer, uint64(NONCE_B));
        deployedB = script.deployChain(deploymentB);
    }

    function _assertSameAddresses(DeployBridge.ChainAddresses memory predicted, DeployBridge.ChainAddresses memory actual)
        internal
        pure
    {
        assertEq(actual.lightClient, predicted.lightClient, "light client");
        assertEq(actual.observedLightClient, predicted.observedLightClient, "own-chain light client");
        assertEq(actual.registry, predicted.registry, "registry");
        assertEq(actual.gate, predicted.gate, "gate");
        assertEq(actual.bridge, predicted.bridge, "bridge");
        assertEq(actual.mediator, predicted.mediator, "mediator");
        assertEq(actual.factory, predicted.factory, "factory");
        assertEq(actual.wrappedRouter, predicted.wrappedRouter, "wrapped router");
        assertEq(actual.feeRouter, predicted.feeRouter, "fee router");
    }

    /// Claim: the nonce table of the script is the order of the deployment. Shows: the plan puts each contract at the
    /// documented offset on both chains (chain A has no registry and has both routers; chain B has the registry and one
    /// router), the factory at nonce 1 of its mediator, and the two `deployChain` runs end on the nonce that the table
    /// gives. Every deployed address equals its prediction. Matters: R2-08. Each bridge and each mediator names its twin
    /// as an immutable, so one shifted nonce would point a contract at an address that holds something else.
    function test_R2_08_predictedAddressesMatchDeployedAddresses() public {
        DeployBridge.BridgeConfig memory config = script.parseConfig(_validJson());
        DeployBridge.Plan memory plan = script.predictAddresses(config);
        assertEq(plan.chainA.lightClient, vm.computeCreateAddress(deployer, NONCE_A));
        assertEq(plan.chainA.observedLightClient, address(0), "Ethereum has no own-chain light client");
        assertEq(plan.chainA.registry, address(0), "Ethereum has no registry");
        assertEq(plan.chainA.gate, vm.computeCreateAddress(deployer, NONCE_A + 1));
        assertEq(plan.chainA.bridge, vm.computeCreateAddress(deployer, NONCE_A + 2));
        assertEq(plan.chainA.mediator, vm.computeCreateAddress(deployer, NONCE_A + 3));
        assertEq(plan.chainA.wrappedRouter, vm.computeCreateAddress(deployer, NONCE_A + 4));
        assertEq(plan.chainA.feeRouter, vm.computeCreateAddress(deployer, NONCE_A + 5));
        assertEq(plan.chainA.factory, vm.computeCreateAddress(plan.chainA.mediator, 1));
        assertEq(plan.chainB.lightClient, vm.computeCreateAddress(deployer, NONCE_B));
        assertEq(plan.chainB.observedLightClient, vm.computeCreateAddress(deployer, NONCE_B + 1));
        assertEq(plan.chainB.registry, vm.computeCreateAddress(deployer, NONCE_B + 2));
        assertEq(plan.chainB.gate, vm.computeCreateAddress(deployer, NONCE_B + 3));
        assertEq(plan.chainB.bridge, vm.computeCreateAddress(deployer, NONCE_B + 4));
        assertEq(plan.chainB.mediator, vm.computeCreateAddress(deployer, NONCE_B + 5));
        assertEq(plan.chainB.wrappedRouter, vm.computeCreateAddress(deployer, NONCE_B + 6));
        assertEq(plan.chainB.feeRouter, address(0), "chain B deploys no fee router");
        assertEq(plan.chainB.factory, vm.computeCreateAddress(plan.chainB.mediator, 1));

        (DeployBridge.ChainDeployment memory deploymentA, DeployBridge.ChainDeployment memory deploymentB) =
            _deployments(config, plan);
        _etchBeaconRoots();
        vm.chainId(1);
        vm.setNonce(deployer, uint64(NONCE_A));
        uint256 gasBefore = gasleft();
        DeployBridge.ChainAddresses memory actualA = script.deployChain(deploymentA);
        console2.log("gas of deployChain for chain A (all contracts and the read-back)", gasBefore - gasleft());
        assertEq(vm.getNonce(deployer), NONCE_A + 6, "six contracts left the deployer on chain A");
        vm.chainId(369);
        vm.setNonce(deployer, uint64(NONCE_B));
        gasBefore = gasleft();
        DeployBridge.ChainAddresses memory actualB = script.deployChain(deploymentB);
        console2.log("gas of deployChain for chain B (all contracts and the read-back)", gasBefore - gasleft());
        assertEq(vm.getNonce(deployer), NONCE_B + 7, "seven contracts left the deployer on chain B");

        _assertSameAddresses(plan.chainA, actualA);
        _assertSameAddresses(plan.chainB, actualB);
    }

    /// Claim: the mediator on each side names the real mediator of the other chain. Shows: after both deployments,
    /// `mediatorContractOnOtherSide` of each mediator equals the deployed mediator of the other chain, which has code, and
    /// each mediator names the bridge and the chain identifier of its own side. Matters: the remote mediator is an
    /// immutable that decides which contract may order releases. A wrong one cannot be repaired.
    function test_mediatorOnEachSideNamesTheRealMediatorOfTheOtherChain() public {
        _deployBoth();
        TokenMediator mediatorA = TokenMediator(deployedA.mediator);
        TokenMediator mediatorB = TokenMediator(deployedB.mediator);
        assertTrue(deployedA.mediator != deployedB.mediator, "control: the two mediators differ");
        assertGt(deployedB.mediator.code.length, 0, "the mediator of chain B exists");
        assertEq(mediatorA.mediatorContractOnOtherSide(), deployedB.mediator, "mediator A points at the real mediator B");
        assertEq(mediatorB.mediatorContractOnOtherSide(), deployedA.mediator, "mediator B points at the real mediator A");
        assertEq(address(mediatorA.bridgeContract()), deployedA.bridge);
        assertEq(address(mediatorB.bridgeContract()), deployedB.bridge);
        assertEq(mediatorA.remoteChainId(), 369);
        assertEq(mediatorB.remoteChainId(), 1);
    }

    /// Claim: the bridge on each side names the real bridge and the real light client of the other chain. Shows: after both
    /// deployments, `remoteBridge` and `remoteLightClient` of each bridge equal the deployed contracts of the other
    /// chain, and each bridge uses its own light client, its own gate and the Capella era of the OTHER chain. Matters:
    /// R2-08 (a bridge accepts logs only from its remote bridge) and HB-02 (a bridge with the wrong gate would admit
    /// sends unchecked).
    function test_bridgeOnEachSideNamesTheRealRemoteBridge() public {
        _deployBoth();
        MessageBridge bridgeA = MessageBridge(deployedA.bridge);
        MessageBridge bridgeB = MessageBridge(deployedB.bridge);
        assertGt(deployedB.bridge.code.length, 0, "the bridge of chain B exists");
        assertEq(bridgeA.remoteBridge(), deployedB.bridge, "bridge A points at the real bridge B");
        assertEq(bridgeB.remoteBridge(), deployedA.bridge, "bridge B points at the real bridge A");
        assertEq(bridgeA.remoteLightClient(), deployedB.lightClient, "bridge A opens on the state of the light client of chain B");
        assertEq(bridgeB.remoteLightClient(), deployedA.lightClient, "bridge B opens on the state of the light client of chain A");
        assertEq(address(bridgeA.lightClient()), deployedA.lightClient);
        assertEq(address(bridgeB.lightClient()), deployedB.lightClient);
        assertEq(address(bridgeA.depositGate()), deployedA.gate, "bridge A uses the gate of chain A");
        assertEq(address(bridgeB.depositGate()), deployedB.gate, "bridge B uses the gate of chain B");
        assertEq(bridgeA.localChainId(), 1);
        assertEq(bridgeA.remoteChainId(), 369);
        assertEq(bridgeB.localChainId(), 369);
        assertEq(bridgeB.remoteChainId(), 1);
        assertEq(bridgeA.capellaEra(), 0, "bridge A proves PulseChain messages: Capella era 0");
        assertEq(bridgeB.capellaEra(), 758, "bridge B proves Ethereum messages: Capella era 758");
        assertEq(BeaconLightClient(deployedB.lightClient).head(), 819264);
    }

    /// Claim: both bridges start locked. Shows: `depositsOpen()` is false on both after the deployment, and the send
    /// cutoff is the configured one. Matters: a bridge that starts open would take messages that the other chain cannot
    /// prove yet, and those messages would be lost for good.
    function test_lock_bothBridgesStartLockedWithTheConfiguredCutoff() public {
        _deployBoth();
        assertFalse(MessageBridge(deployedA.bridge).depositsOpen(), "bridge A starts locked");
        assertFalse(MessageBridge(deployedB.bridge).depositsOpen(), "bridge B starts locked");
        assertEq(MessageBridge(deployedA.bridge).sendCutoffTimestamp(), 0);
        assertEq(MessageBridge(deployedB.bridge).sendCutoffTimestamp(), 0);

        string memory json = vm.replace(_validJson(), '"depositCutoffTimestamp":"0"', '"depositCutoffTimestamp":"1900000000"');
        DeployBridge.BridgeConfig memory config = script.parseConfig(json);
        assertEq(config.chainA.depositCutoffTimestamp, 1_900_000_000, "control: the setting reaches the configuration");
    }

    /// Claim: the factory of each mediator is the predicted address, and it belongs to that mediator. Shows: the plan
    /// holds `computeCreateAddress(mediator, 1)`; `tokenFactory()` of each deployed mediator equals it; the factory has
    /// code and names the mediator. Matters: the script cannot send the factory in a transaction. It must predict an
    /// address that the mediator creates, and a wrong rule would make the read-back fail on every honest deployment.
    function test_factoryOfEachMediatorIsThePredictedAddress() public {
        _deployBoth();
        assertEq(planned.chainA.factory, vm.computeCreateAddress(deployedA.mediator, 1));
        assertEq(planned.chainB.factory, vm.computeCreateAddress(deployedB.mediator, 1));
        assertEq(address(TokenMediator(deployedA.mediator).tokenFactory()), planned.chainA.factory);
        assertEq(address(TokenMediator(deployedB.mediator).tokenFactory()), planned.chainB.factory);
        assertGt(planned.chainA.factory.code.length, 0);
        assertEq(TokenFactory(planned.chainA.factory).mediator(), deployedA.mediator);
        assertEq(TokenFactory(planned.chainB.factory).mediator(), deployedB.mediator);
        assertTrue(planned.chainA.factory != planned.chainB.factory);
    }

    /// Claim: the native coin router and the optional fee router are deployed where the configuration asks, and they
    /// point at the mediator and the wrapped token of their own chain. Shows: chain A has both routers, chain B has the
    /// native coin router and no fee router; each router reads the mediator of its chain and the wrapped token of its
    /// chain. Matters: a router on the wrong mediator would wrap coin that no mediator accepts, and a wrong wrapped token
    /// would unwrap the wrong asset.
    function test_routersAreDeployedAndPointAtTheMediator() public {
        _deployBoth();
        assertGt(deployedA.wrappedRouter.code.length, 0);
        assertGt(deployedA.feeRouter.code.length, 0, "chain A asks for the fee router");
        assertGt(deployedB.wrappedRouter.code.length, 0);
        assertEq(deployedB.feeRouter, address(0), "chain B does not ask for the fee router");

        assertEq(address(WETHOmnibridgeRouter(payable(deployedA.wrappedRouter)).bridge()), deployedA.mediator);
        assertEq(address(WETHOmnibridgeRouter(payable(deployedA.wrappedRouter)).WETH()), address(wrappedNativeOnA));
        assertEq(address(FeeRouter(payable(deployedA.feeRouter)).bridge()), deployedA.mediator);
        assertEq(address(FeeRouter(payable(deployedA.feeRouter)).wNative()), address(wrappedNativeOnA));
        assertEq(address(WETHOmnibridgeRouter(payable(deployedB.wrappedRouter)).bridge()), deployedB.mediator);
        assertEq(address(WETHOmnibridgeRouter(payable(deployedB.wrappedRouter)).WETH()), address(wrappedNativeOnB));
    }

    /// Claim: a chain with no wrapped native token deploys no router, and the plan leaves no gap. Shows: with a zero
    /// `wrappedNative` (and no fee router) the plan holds zero for both routers and the next nonce after the mediator is
    /// unused; the deployment ends on the nonce after the mediator and its read-back passes. With the key absent the
    /// result is the same. Matters: a gap in the plan would shift the fee router on a chain that has one, and a router
    /// with a zero wrapped token would be a contract that can never work.
    function test_chainWithNoWrappedNativeDeploysNoRouterAndLeavesNoGap() public {
        string memory json = vm.replace(_validJson(), vm.toString(address(wrappedNativeOnB)), vm.toString(address(0)));
        DeployBridge.BridgeConfig memory config = script.parseConfig(json);
        DeployBridge.Plan memory plan = script.predictAddresses(config);
        assertEq(plan.chainB.wrappedRouter, address(0));
        assertEq(plan.chainB.feeRouter, address(0));
        assertEq(plan.chainB.mediator, vm.computeCreateAddress(deployer, NONCE_B + 5), "the offsets before the router do not move");

        (, DeployBridge.ChainDeployment memory deploymentB) = _deployments(config, plan);
        _etchBeaconRoots();
        vm.chainId(369);
        vm.setNonce(deployer, uint64(NONCE_B));
        DeployBridge.ChainAddresses memory deployed = script.deployChain(deploymentB);
        assertEq(deployed.wrappedRouter, address(0));
        assertEq(deployed.feeRouter, address(0));
        assertEq(vm.getNonce(deployer), NONCE_B + 6, "the mediator is the last contract of the deployer");
        _assertSameAddresses(plan.chainB, deployed);

        // The key may also be absent.
        string memory absent = vm.replace(
            _validJson(), string.concat('"wrappedNative":"', vm.toString(address(wrappedNativeOnB)), '",'), ""
        );
        assertEq(script.parseConfig(absent).chainB.wrappedNative, address(0));

        // A chain without a router and without a fee router at all: the plan ends on the mediator.
        string memory bare = vm.replace(json, '"deployFeeRouter":"true"', '"deployFeeRouter":"false"');
        bare = vm.replace(bare, vm.toString(address(wrappedNativeOnA)), vm.toString(address(0)));
        plan = script.predictAddresses(script.parseConfig(bare));
        assertEq(plan.chainA.wrappedRouter, address(0));
        assertEq(plan.chainA.feeRouter, address(0));
        assertTrue(plan.chainA.mediator != address(0));
    }

    /// Claim: the fee router needs a wrapped native token, and the setting must be `true` or `false`. Shows: a fee
    /// router with a zero wrapped token reverts with the chain; a setting of `yes` reverts with the text; `false` and an
    /// absent key both mean no fee router. Matters: a fee router with no wrapped token would deploy and then fail on
    /// every use. A setting that parsed to a default could add or drop a contract and shift every later nonce.
    function test_feeRouter_parseConfigNeedsAWrappedNativeAndAKnownSetting() public {
        string memory json = _validJson();
        vm.expectRevert(abi.encodeWithSelector(DeployBridge.FeeRouterNeedsWrappedNative.selector, uint64(1)));
        script.parseConfig(vm.replace(json, vm.toString(address(wrappedNativeOnA)), vm.toString(address(0))));

        vm.expectRevert(abi.encodeWithSelector(DeployBridge.UnknownFeeRouterSetting.selector, "yes"));
        script.parseConfig(vm.replace(json, '"deployFeeRouter":"true"', '"deployFeeRouter":"yes"'));

        DeployBridge.BridgeConfig memory config =
            script.parseConfig(vm.replace(json, '"deployFeeRouter":"true"', '"deployFeeRouter":"false"'));
        assertEq(uint8(config.chainA.feeRouter), uint8(DeployBridge.RouterChoice.Skip));
        config = script.parseConfig(vm.replace(json, '"deployFeeRouter":"true",', ""));
        assertEq(uint8(config.chainA.feeRouter), uint8(DeployBridge.RouterChoice.Skip), "an absent key means no fee router");

        vm.expectRevert(abi.encodeWithSelector(DeployBridge.PlaceholderValue.selector, ".chainA.wrappedNative"));
        script.parseConfig(vm.replace(json, vm.toString(address(wrappedNativeOnA)), "REPLACE_WITH_WRAPPED_NATIVE"));
        script.parseConfig(json); // the honest file passes
    }

    /// Claim: the deployed bridge lets through at least the gas that its mediator asks for. Shows: for each side,
    /// `maxGasPerTx` of the deployed bridge is not below `DEPLOY_GAS_LIMIT + CALLBACK_GAS_LIMIT` of the deployed mediator.
    /// Matters: the mediator constructor refuses a bridge below that number (`GasLimitAboveBridgeMaximum`). The script
    /// cannot cause it with the real bridge, and this test fails if a change of either contract breaks the pair.
    function test_deployedBridgeLetsThroughTheGasThatTheMediatorNeeds() public {
        _deployBoth();
        address[2] memory mediators = [deployedA.mediator, deployedB.mediator];
        address[2] memory bridges = [deployedA.bridge, deployedB.bridge];
        for (uint256 i = 0; i < 2; i++) {
            TokenMediator mediator = TokenMediator(mediators[i]);
            uint256 needed = mediator.DEPLOY_GAS_LIMIT() + mediator.CALLBACK_GAS_LIMIT();
            assertGe(MessageBridge(bridges[i]).maxGasPerTx(), needed);
            assertEq(address(mediator.bridgeContract()), bridges[i], "control: the mediator reads this bridge");
        }
    }

    // ================================================================ flow limiter

    /// Claim: the flow limiter setting defaults to zero and a non-zero address is read as written. Shows: the
    /// complete configuration gives chain A and chain B a zero limiter; with an address in the setting, chain A gets that
    /// address and chain B stays zero. Matters: the limiter is optional, and a misread address would pin the wrong rules.
    function test_flowLimiter_parseConfig_defaultsToZeroAndReadsAnAddress() public {
        DeployBridge.BridgeConfig memory config = script.parseConfig(_validJson());
        assertEq(config.chainA.flowLimiter, address(0));
        assertEq(config.chainB.flowLimiter, address(0));

        configuredFlowLimiter = address(new DeployFlowLimiter());
        config = script.parseConfig(_validJson());
        assertEq(config.chainA.flowLimiter, configuredFlowLimiter);
        assertEq(config.chainB.flowLimiter, address(0), "the setting is per chain");
    }

    /// Claim: a non-zero limiter must have code on its chain. Shows: an address with no code reverts with the chain and
    /// the address; a limiter with code passes; a zero limiter passes. Matters: a limiter address with no code would make
    /// every relay revert on the call, and the immutable choice could not be repaired.
    function test_flowLimiter_environmentRequiresCodeForANonZeroLimiter() public {
        DeployBridge.BridgeConfig memory config = script.parseConfig(_validJson());
        _etchBeaconRoots();
        vm.chainId(1);
        vm.setNonce(deployer, uint64(NONCE_A));
        script.assertChainEnvironment(config.chainA, deployer); // honest: no limiter

        address withoutCode = makeAddr("a limiter address with no code");
        config.chainA.flowLimiter = withoutCode;
        vm.expectRevert(abi.encodeWithSelector(DeployBridge.FlowLimiterHasNoCode.selector, uint64(1), withoutCode));
        script.assertChainEnvironment(config.chainA, deployer);

        config.chainA.flowLimiter = address(new DeployFlowLimiter());
        script.assertChainEnvironment(config.chainA, deployer); // honest: a limiter with code
    }

    /// Claim: a non-zero wrapped native token must have code on its chain. Shows: an address with no code reverts with
    /// the chain and the address; the real token passes; a zero token passes (no router). Matters: a router that wraps
    /// into an address with no code would take the coin and give back nothing.
    function test_wrappedNative_environmentRequiresCodeForANonZeroToken() public {
        DeployBridge.BridgeConfig memory config = script.parseConfig(_validJson());
        _etchBeaconRoots();
        vm.chainId(1);
        vm.setNonce(deployer, uint64(NONCE_A));
        script.assertChainEnvironment(config.chainA, deployer); // honest

        address withoutCode = makeAddr("a wrapped native address with no code");
        config.chainA.wrappedNative = withoutCode;
        vm.expectRevert(abi.encodeWithSelector(DeployBridge.WrappedNativeHasNoCode.selector, uint64(1), withoutCode));
        script.assertChainEnvironment(config.chainA, deployer);

        config.chainA.wrappedNative = address(0);
        script.assertChainEnvironment(config.chainA, deployer); // no token, no router, no check
    }

    /// Claim: a deployment with a non-zero limiter puts that limiter in the mediator, and the read-back refuses a
    /// mediator with another limiter or none. Shows: `deployChain` for chain A with a limiter; the mediator reports it and
    /// `verifyDeployment` passes; a mediator built with no limiter and one built with another limiter each fail with the
    /// field name. Matters: the limiter is immutable at deployment, so the read-back is the only check.
    function test_flowLimiter_deployChainSetsItAndReadBackCatchesAWrongOne() public {
        configuredFlowLimiter = address(new DeployFlowLimiter());
        (DeployBridge.ChainDeployment memory deploymentA, DeployBridge.ChainAddresses memory deployed) = _honestChainA();
        assertEq(address(TokenMediator(deployed.mediator).flowLimiter()), configuredFlowLimiter);

        address[2] memory wrongLimiters = [address(0), address(new DeployFlowLimiter())];
        for (uint256 i = 0; i < wrongLimiters.length; i++) {
            TokenMediator.MediatorTerms memory terms = _mediatorTerms(deploymentA, deployed.bridge);
            terms.flowLimiter = wrongLimiters[i];
            _swapMediator(deploymentA, deployed, new TokenMediator(terms));
            vm.expectRevert(abi.encodeWithSelector(DeployBridge.DeploymentMismatch.selector, "mediator.flowLimiter"));
            script.verifyDeployment(deploymentA, deployed);
        }
    }

    // ================================================================ guards

    /// Claim: the script refuses to run when the deployer nonce differs from the configuration, on either chain.
    /// Shows: a nonce one too high and one too low revert with all three numbers; the right nonce passes.
    /// Matters: R2-08 (a different nonce shifts every predicted address, so the bridges would point at nothing).
    function test_R2_08_nonceGuardRefusesMismatchedNonce() public {
        DeployBridge.BridgeConfig memory config = script.parseConfig(_validJson());
        _etchBeaconRoots();
        vm.chainId(1);

        vm.setNonce(deployer, uint64(NONCE_A - 1));
        vm.expectRevert(abi.encodeWithSelector(DeployBridge.DeployerNonceMismatch.selector, uint64(1), NONCE_A, NONCE_A - 1));
        script.assertChainEnvironment(config.chainA, deployer);

        vm.setNonce(deployer, uint64(NONCE_A));
        script.assertChainEnvironment(config.chainA, deployer); // honest path

        vm.setNonce(deployer, uint64(NONCE_A + 1));
        vm.expectRevert(abi.encodeWithSelector(DeployBridge.DeployerNonceMismatch.selector, uint64(1), NONCE_A, NONCE_A + 1));
        script.assertChainEnvironment(config.chainA, deployer);

        vm.chainId(369);
        vm.setNonce(deployer, uint64(NONCE_B + 2));
        vm.expectRevert(abi.encodeWithSelector(DeployBridge.DeployerNonceMismatch.selector, uint64(369), NONCE_B, NONCE_B + 2));
        script.assertChainEnvironment(config.chainB, deployer);
    }

    /// Claim: the nonce guard also stops `deployChain`, and no contract is created. Shows: the revert, an unchanged
    /// nonce and no code at the predicted address; then, with the right nonce, the same call deploys at the predicted
    /// address. Matters: a mismatched deployment would burn the nonce and strand the other chain's pointers.
    function test_R2_08_deployChainRefusesMismatchedNonce() public {
        DeployBridge.BridgeConfig memory config = script.parseConfig(_validJson());
        DeployBridge.Plan memory plan = script.predictAddresses(config);
        (DeployBridge.ChainDeployment memory deploymentA,) = _deployments(config, plan);
        _etchBeaconRoots();
        vm.chainId(1);
        vm.setNonce(deployer, uint64(NONCE_A - 1));
        vm.expectRevert(abi.encodeWithSelector(DeployBridge.DeployerNonceMismatch.selector, uint64(1), NONCE_A, NONCE_A - 1));
        script.deployChain(deploymentA);
        assertEq(vm.getNonce(deployer), NONCE_A - 1);
        assertEq(plan.chainA.lightClient.code.length, 0);
        assertEq(plan.chainA.gate.code.length, 0);

        vm.setNonce(deployer, uint64(NONCE_A)); // honest
        _assertSameAddresses(plan.chainA, script.deployChain(deploymentA));
    }

    /// Claim: the connected chain must be the configured chain, and the verifier must have code there, and the code must
    /// be the pinned code. Shows: three exact errors, each followed by the honest call. The code hash error names the
    /// expected and the actual hash, and it also fires for a verifier with other code at the right address. Matters:
    /// the specification's SP1 gateways have code on Ethereum but none on PulseChain, and an address with other code
    /// (a verifier that accepts any proof) would pass a check for code alone.
    function test_R2_08_environmentGuardsChainAndVerifier() public {
        DeployBridge.BridgeConfig memory config = script.parseConfig(_validJson());
        _etchBeaconRoots();
        vm.setNonce(deployer, uint64(NONCE_A));
        vm.chainId(56);
        vm.expectRevert(abi.encodeWithSelector(DeployBridge.ChainIdMismatch.selector, uint64(1), uint256(56)));
        script.assertChainEnvironment(config.chainA, deployer);

        vm.chainId(1);
        script.assertChainEnvironment(config.chainA, deployer); // honest
        address verifierWithoutCode = makeAddr("an address with no code");
        config.chainA.verifier = verifierWithoutCode;
        vm.expectRevert(abi.encodeWithSelector(DeployBridge.VerifierHasNoCode.selector, uint64(1), verifierWithoutCode));
        script.assertChainEnvironment(config.chainA, deployer);

        // The same address with another pinned hash is refused, and so is other code at the pinned address.
        config.chainA.verifier = address(verifier);
        script.assertChainEnvironment(config.chainA, deployer); // honest: the pin is the real hash
        bytes32 realHash = address(verifier).codehash;
        bytes32 otherHash = keccak256("the code of another verifier");
        config.chainA.verifierCodeHash = otherHash;
        vm.expectRevert(
            abi.encodeWithSelector(DeployBridge.VerifierCodeHashMismatch.selector, uint64(1), address(verifier), otherHash, realHash)
        );
        script.assertChainEnvironment(config.chainA, deployer);

        config.chainA.verifierCodeHash = realHash;
        address impostor = makeAddr("a verifier that accepts any proof");
        vm.etch(impostor, hex"600160005260206000f3");
        config.chainA.verifier = impostor;
        vm.expectRevert(
            abi.encodeWithSelector(DeployBridge.VerifierCodeHashMismatch.selector, uint64(1), impostor, realHash, impostor.codehash)
        );
        script.assertChainEnvironment(config.chainA, deployer);
    }

    /// Claim: a gate in `Enforcing` mode needs the beacon roots contract on its chain, and a gate in detection mode
    /// does not. Shows: chain A (enforcing) reverts while no code sits at the address of EIP-4788 and passes once the
    /// code is there; chain B (detecting) passes with no code. Matters: HB-02 (an enforcing gate on a chain without the
    /// contract would refuse every deposit for good, and the operator would learn it only after the deployment).
    function test_HB02_environmentGuardsBeaconRootsForEnforcingGate() public {
        DeployBridge.BridgeConfig memory config = script.parseConfig(_validJson());
        assertEq(BEACON_ROOTS.code.length, 0, "the test starts with no beacon roots contract");

        vm.chainId(1);
        vm.setNonce(deployer, uint64(NONCE_A));
        vm.expectRevert(abi.encodeWithSelector(DeployBridge.BeaconRootsHaveNoCode.selector, uint64(1), BEACON_ROOTS));
        script.assertChainEnvironment(config.chainA, deployer);

        _etchBeaconRoots();
        script.assertChainEnvironment(config.chainA, deployer); // honest: the contract is there

        vm.etch(BEACON_ROOTS, ""); // remove the contract again
        vm.chainId(369);
        vm.setNonce(deployer, uint64(NONCE_B));
        script.assertChainEnvironment(config.chainB, deployer); // detection mode needs no contract
    }

    // ================================================================ post-deploy assertions

    function _newClient(DeployBridge.ChainConfig memory c, bytes32 genesisRoot) internal returns (BeaconLightClient) {
        return new BeaconLightClient(
            address(verifier),
            c.lightClient.programVKey,
            genesisRoot,
            c.lightClient.slotsPerPeriod,
            c.lightClient.genesisTime,
            c.lightClient.secondsPerSlot,
            c.lightClient.initialSlot,
            c.lightClient.initialHeaderRoot,
            c.lightClient.initialSyncCommitteeHash,
            c.lightClient.initialNextSyncCommitteeHash
        );
    }

    function _newGateFrom(DeployBridge.GateConfig memory g) internal returns (BeaconForkGate) {
        return new BeaconForkGate(
            BEACON_ROOTS, g.mode, g.genesisTime, g.secondsPerSlot, g.slotsPerEpoch, g.supportedVersions, g.sealDepths, address(0)
        );
    }

    /// @dev A bridge for chain A. The constructor reads `block.chainid`, so the caller sets chain 1 first.
    function _newBridgeA(
        DeployBridge.ChainAddresses memory deployed,
        address remoteBridge,
        address remoteLightClient,
        uint64 cutoff,
        uint64 capellaEra
    ) internal returns (MessageBridge) {
        return new MessageBridge(
            deployed.lightClient, 1, 369, remoteBridge, MessageBridge.BridgeTerms(cutoff, remoteLightClient), capellaEra,
            deployed.gate
        );
    }

    /// @dev The honest terms of the mediator of a chain. A test changes one field and builds the tampered mediator.
    function _mediatorTerms(DeployBridge.ChainDeployment memory d, address bridge)
        internal
        pure
        returns (TokenMediator.MediatorTerms memory)
    {
        DeployBridge.FeeConfig memory fee = d.chain.fee;
        return TokenMediator.MediatorTerms({
            bridge: bridge,
            remoteMediator: d.remoteMediator,
            remoteChainId: d.remoteChainId,
            feeAuthority: fee.authority,
            feeRecipient: fee.recipient,
            feeRate: fee.rate,
            feeCeiling: fee.ceiling,
            flowLimiter: d.chain.flowLimiter
        });
    }

    /// @dev Puts a tampered bridge in place of the honest one, in the plan and in the deployed record, so the
    /// prediction check passes and the read-back must find the fault itself.
    function _swapBridge(
        DeployBridge.ChainDeployment memory d,
        DeployBridge.ChainAddresses memory deployed,
        MessageBridge wrong
    ) internal pure {
        d.plan.bridge = address(wrong);
        deployed.bridge = address(wrong);
    }

    /// @dev Puts a tampered mediator and its factory in place of the honest ones, in the plan and in the record.
    function _swapMediator(
        DeployBridge.ChainDeployment memory d,
        DeployBridge.ChainAddresses memory deployed,
        TokenMediator wrong
    ) internal view {
        d.plan.mediator = address(wrong);
        d.plan.factory = address(wrong.tokenFactory());
        deployed.mediator = address(wrong);
        deployed.factory = address(wrong.tokenFactory());
    }

    /// @dev Deploys the honest contracts of chain A for real, once for each test, and proves that `verifyDeployment`
    /// accepts them. A second call returns a fresh copy of the same record, so a test can tamper with it again. Every
    /// attack test below starts here, so it can fail.
    function _honestChainA()
        internal
        returns (DeployBridge.ChainDeployment memory deploymentA, DeployBridge.ChainAddresses memory deployed)
    {
        DeployBridge.BridgeConfig memory config = script.parseConfig(_validJson());
        DeployBridge.Plan memory plan = script.predictAddresses(config);
        (deploymentA,) = _deployments(config, plan);
        if (deployedA.bridge == address(0)) {
            _etchBeaconRoots();
            vm.chainId(1);
            vm.setNonce(deployer, uint64(NONCE_A));
            deployedA = script.deployChain(deploymentA);
        }
        deployed = _copy(deployedA);
        script.verifyDeployment(deploymentA, deployed); // control
    }

    /// Claim: the post-deploy check catches a wrong remote bridge. Shows: a bridge with another remote bridge fails
    /// `verifyDeployment` with the field name, while the honest deployment passes; a contract at an address other than
    /// the prediction fails with the prediction error, for each of the seven predicted contracts. Matters: R2-08 (read
    /// every immutable back, do not trust that the deployment matched).
    function test_R2_08_postDeployAssertionsCatchWrongRemoteBridge() public {
        (DeployBridge.ChainDeployment memory d, DeployBridge.ChainAddresses memory deployed) = _honestChainA();
        _swapBridge(
            d, deployed, _newBridgeA(deployed, makeAddr("not the predicted bridge B"), d.remoteLightClient, 0, 0)
        );
        vm.expectRevert(abi.encodeWithSelector(DeployBridge.DeploymentMismatch.selector, "bridge.remoteBridge"));
        script.verifyDeployment(d, deployed);

        // The prediction itself is checked first, for each contract.
        (d, deployed) = _honestChainA();
        string[7] memory names = ["lightClient", "gate", "bridge", "mediator", "factory", "wrappedRouter", "feeRouter"];
        for (uint256 i = 0; i < names.length; i++) {
            DeployBridge.ChainAddresses memory moved = _copy(deployed);
            address predicted = _slot(moved, i);
            _setSlot(moved, i, address(this));
            vm.expectRevert(abi.encodeWithSelector(DeployBridge.AddressNotAsPredicted.selector, names[i], predicted, address(this)));
            script.verifyDeployment(d, moved);
        }
    }

    function _copy(DeployBridge.ChainAddresses memory a) internal pure returns (DeployBridge.ChainAddresses memory) {
        return DeployBridge.ChainAddresses(
            a.lightClient, a.observedLightClient, a.registry, a.gate, a.bridge, a.mediator, a.factory, a.wrappedRouter,
            a.feeRouter
        );
    }

    /// @dev Reads one of the seven predicted contracts by its position in `verifyDeployment`.
    function _slot(DeployBridge.ChainAddresses memory a, uint256 index) internal pure returns (address) {
        address[7] memory all = [a.lightClient, a.gate, a.bridge, a.mediator, a.factory, a.wrappedRouter, a.feeRouter];
        return all[index];
    }

    function _setSlot(DeployBridge.ChainAddresses memory a, uint256 index, address value) internal pure {
        if (index == 0) a.lightClient = value;
        if (index == 1) a.gate = value;
        if (index == 2) a.bridge = value;
        if (index == 3) a.mediator = value;
        if (index == 4) a.factory = value;
        if (index == 5) a.wrappedRouter = value;
        if (index == 6) a.feeRouter = value;
    }

    /// Claim: the post-deploy check catches a mediator that names the wrong remote mediator. Shows: a mediator built
    /// with another remote mediator fails with the exact field name, although it is wired to the honest bridge; so does
    /// a mediator that names another bridge, another remote chain, or a factory that another mediator made; the honest
    /// mediator passes. Matters: the remote mediator is the only contract that may order a release on this chain. A wrong
    /// one either strands every transfer or gives a stranger the power to mint.
    function test_postDeployAssertionsCatchWrongRemoteMediator() public {
        (DeployBridge.ChainDeployment memory d, DeployBridge.ChainAddresses memory deployed) = _honestChainA();
        TokenMediator.MediatorTerms memory terms = _mediatorTerms(d, deployed.bridge);
        terms.remoteMediator = makeAddr("not the predicted mediator B");
        _swapMediator(d, deployed, new TokenMediator(terms));
        vm.expectRevert(abi.encodeWithSelector(DeployBridge.DeploymentMismatch.selector, "mediator.mediatorContractOnOtherSide"));
        script.verifyDeployment(d, deployed);

        (d, deployed) = _honestChainA();
        terms = _mediatorTerms(d, deployed.bridge);
        terms.remoteChainId = 56;
        _swapMediator(d, deployed, new TokenMediator(terms));
        vm.expectRevert(abi.encodeWithSelector(DeployBridge.DeploymentMismatch.selector, "mediator.remoteChainId"));
        script.verifyDeployment(d, deployed);

        // A second bridge with the same settings is a different contract, so the mediator names the wrong bridge.
        (d, deployed) = _honestChainA();
        MessageBridge otherBridge = _newBridgeA(deployed, d.remoteBridge, d.remoteLightClient, 0, 0);
        _swapMediator(d, deployed, new TokenMediator(_mediatorTerms(d, address(otherBridge))));
        vm.expectRevert(abi.encodeWithSelector(DeployBridge.DeploymentMismatch.selector, "mediator.bridgeContract"));
        script.verifyDeployment(d, deployed);

        // A predicted factory that another mediator made is refused at the prediction.
        (d, deployed) = _honestChainA();
        TokenMediator other = new TokenMediator(_mediatorTerms(d, deployed.bridge));
        deployed.factory = address(other.tokenFactory());
        vm.expectRevert(
            abi.encodeWithSelector(DeployBridge.AddressNotAsPredicted.selector, "factory", d.plan.factory, deployed.factory)
        );
        script.verifyDeployment(d, deployed);
    }

    /// Claim: the post-deploy check catches a bridge that reads the wrong remote light client, and a bridge that starts
    /// open. Shows: a bridge built with another remote light client fails with the field name, and so does a bridge whose
    /// flag is already set, while the honest deployment passes. Matters: the remote light client is immutable and it is
    /// the only source of the opening. A wrong one locks sends for good or opens them on the proof of another contract.
    function test_lock_postDeployAssertionsCatchWrongRemoteLightClientAndAnOpenStart() public {
        (DeployBridge.ChainDeployment memory d, DeployBridge.ChainAddresses memory deployed) = _honestChainA();
        assertTrue(d.remoteLightClient != address(0), "control: the deployment names a remote light client");
        uint64 era = d.chain.lightClient.capellaEra;

        _swapBridge(
            d, deployed, _newBridgeA(deployed, d.remoteBridge, makeAddr("not the predicted light client of chain B"), 0, era)
        );
        vm.expectRevert(abi.encodeWithSelector(DeployBridge.DeploymentMismatch.selector, "bridge.remoteLightClient"));
        script.verifyDeployment(d, deployed);

        (d, deployed) = _honestChainA();
        MessageBridge startsOpen = _newBridgeA(deployed, d.remoteBridge, d.remoteLightClient, 0, era);
        // The flag is bit 64 of storage word 0, beside the nonce (see `forge inspect MessageBridge storageLayout`).
        bytes32 word = vm.load(address(startsOpen), bytes32(uint256(0)));
        vm.store(address(startsOpen), bytes32(uint256(0)), word | bytes32(uint256(1) << 64));
        assertTrue(startsOpen.depositsOpen(), "control: the flag is set");
        _swapBridge(d, deployed, startsOpen);
        vm.expectRevert(abi.encodeWithSelector(DeployBridge.DeploymentMismatch.selector, "bridge.depositsOpen must start false"));
        script.verifyDeployment(d, deployed);
    }

    /// Claim: the post-deploy check catches a wrong send cutoff, and passes for the right deployment. Shows: a bridge
    /// with cutoff 12345 fails with the field name; the bridge with the configured cutoff passes. Matters: R2-08.
    function test_R2_08_postDeployAssertionsCatchWrongCutoffAndPassWhenRight() public {
        (DeployBridge.ChainDeployment memory d, DeployBridge.ChainAddresses memory deployed) = _honestChainA();
        _swapBridge(d, deployed, _newBridgeA(deployed, d.remoteBridge, d.remoteLightClient, 12_345, d.chain.lightClient.capellaEra));
        vm.expectRevert(abi.encodeWithSelector(DeployBridge.DeploymentMismatch.selector, "bridge.sendCutoffTimestamp"));
        script.verifyDeployment(d, deployed);

        // A configured cutoff reaches the bridge: deploy again with a cutoff and read it back.
        string memory json = vm.replace(_validJson(), '"depositCutoffTimestamp":"0"', '"depositCutoffTimestamp":"1900000000"');
        json = vm.replace(json, string.concat('"deployerNonce":"', vm.toString(NONCE_A), '"'), '"deployerNonce":"50"');
        DeployBridge.BridgeConfig memory config = script.parseConfig(json);
        (d,) = _deployments(config, script.predictAddresses(config));
        vm.setNonce(deployer, 50);
        deployed = script.deployChain(d);
        assertEq(MessageBridge(deployed.bridge).sendCutoffTimestamp(), 1_900_000_000);
    }

    /// Claim: the post-deploy check catches a mediator whose fee switch differs from the configuration. Shows: a mediator
    /// with no fee authority, a mediator with another fee, and a mediator with another ceiling each fail with the field
    /// name, while the honest mediator passes. Matters: the fee ceiling is immutable, so a wrong ceiling cannot be
    /// repaired after launch.
    function test_R2_08_postDeployAssertionsCatchWrongFeeSwitch() public {
        (DeployBridge.ChainDeployment memory d, DeployBridge.ChainAddresses memory deployed) = _honestChainA();
        DeployBridge.FeeConfig memory fee = d.chain.fee;
        assertEq(fee.rate, 2500000000000000, "control: the configured fee is live");

        string[3] memory fields = ["mediator.feeAuthority", "mediator.feeRate", "mediator.feeCeiling"];
        for (uint256 i = 0; i < fields.length; i++) {
            TokenMediator.MediatorTerms memory terms = _mediatorTerms(d, deployed.bridge);
            if (i == 0) (terms.feeAuthority, terms.feeRecipient, terms.feeRate, terms.feeCeiling) = (address(0), address(0), 0, 0);
            if (i == 1) terms.feeRate = 3000000000000000;
            if (i == 2) terms.feeCeiling = 1e16;
            _swapMediator(d, deployed, new TokenMediator(terms));
            vm.expectRevert(abi.encodeWithSelector(DeployBridge.DeploymentMismatch.selector, fields[i]));
            script.verifyDeployment(d, deployed);
        }
    }

    /// Claim: the light client read-back catches a wrong checkpoint. Shows: a light client with another genesis
    /// validators root fails with the field name, and the honest light client passes. Matters: R2-09 (the chain binding
    /// is the point of that field).
    function test_R2_09_postDeployAssertionsCatchWrongGenesisRoot() public {
        (DeployBridge.ChainDeployment memory d, DeployBridge.ChainAddresses memory deployed) = _honestChainA();
        BeaconLightClient wrong = _newClient(d.chain, keccak256("another chain"));
        d.plan.lightClient = address(wrong);
        deployed.lightClient = address(wrong);
        vm.expectRevert(abi.encodeWithSelector(DeployBridge.DeploymentMismatch.selector, "lightClient.genesisValidatorsRoot"));
        script.verifyDeployment(d, deployed);
    }

    /// Claim: the post-deploy check catches a wrong Capella era on the bridge. Shows: a bridge built with era 5 instead
    /// of 0 fails with the field name; the honest bridge passes. Matters: HB-01 (the era shifts every index into
    /// `historical_summaries`, so a wrong era makes honest messages fail or reads a neighbouring summary).
    function test_HB01_postDeployAssertionsCatchWrongCapellaEra() public {
        (DeployBridge.ChainDeployment memory d, DeployBridge.ChainAddresses memory deployed) = _honestChainA();
        _swapBridge(d, deployed, _newBridgeA(deployed, d.remoteBridge, d.remoteLightClient, 0, 5));
        vm.expectRevert(abi.encodeWithSelector(DeployBridge.DeploymentMismatch.selector, "bridge.capellaEra"));
        script.verifyDeployment(d, deployed);
    }

    /// Claim: the post-deploy check catches a bridge wired to another deposit gate. Shows: a bridge that points at a
    /// second gate with the same settings fails with the field name, although that gate is itself correct; the honest
    /// pair passes. Matters: HB-02 (the gate is the only guard of the send side after an unknown fork; a bridge that
    /// uses a different gate than the one the operator checked is unguarded in practice).
    function test_HB02_postDeployAssertionsCatchBridgeWithAnotherGate() public {
        (DeployBridge.ChainDeployment memory d, DeployBridge.ChainAddresses memory deployed) = _honestChainA();
        BeaconForkGate otherGate = _newGateFrom(d.chain.gate);
        assertTrue(address(otherGate) != deployed.gate, "the second gate is a different contract");
        DeployBridge.ChainAddresses memory viaOtherGate = _copy(deployed);
        viaOtherGate.gate = address(otherGate);
        MessageBridge wired = _newBridgeA(viaOtherGate, d.remoteBridge, d.remoteLightClient, 0, d.chain.lightClient.capellaEra);
        _swapBridge(d, deployed, wired);
        vm.expectRevert(abi.encodeWithSelector(DeployBridge.DeploymentMismatch.selector, "bridge.depositGate"));
        script.verifyDeployment(d, deployed);
    }

    /// Claim: the post-deploy check reads every gate setting back. Shows: for each setting in turn (mode, genesis
    /// time, seconds per slot, slots per epoch, the length of the version table, one version, one state depth, the seal
    /// depths) a gate that differs in only that setting fails with the field name; the honest gate passes at the end.
    /// Matters: HB-02 (a wrong version table either supports a fork that the light client cannot prove, or rejects a
    /// fork it can, and a wrong seal depth lets a stranger seal the gate or blocks the seal).
    function test_HB02_postDeployAssertionsCatchEveryWrongGateSetting() public {
        (DeployBridge.ChainDeployment memory d, DeployBridge.ChainAddresses memory deployed) = _honestChainA();
        address honestGate = deployed.gate;

        DeployBridge.GateConfig memory tampered = script.parseConfig(_validJson()).chainA.gate;
        tampered.mode = BeaconForkGate.GateMode.DetectBeaconRoots;
        _expectGateMismatch(d, deployed, tampered, "gate.mode");

        tampered = script.parseConfig(_validJson()).chainA.gate;
        tampered.genesisTime += 1;
        _expectGateMismatch(d, deployed, tampered, "gate.genesisTime");

        tampered = script.parseConfig(_validJson()).chainA.gate;
        tampered.secondsPerSlot = 10;
        _expectGateMismatch(d, deployed, tampered, "gate.secondsPerSlot");

        tampered = script.parseConfig(_validJson()).chainA.gate;
        tampered.slotsPerEpoch = 31;
        _expectGateMismatch(d, deployed, tampered, "gate.slotsPerEpoch");

        tampered = script.parseConfig(_validJson()).chainA.gate;
        BeaconForkGate.SupportedVersion[] memory shorter = new BeaconForkGate.SupportedVersion[](3);
        for (uint256 i = 0; i < 3; i++) {
            shorter[i] = tampered.supportedVersions[i];
        }
        tampered.supportedVersions = shorter;
        _expectGateMismatch(d, deployed, tampered, "gate.supportedVersions");

        tampered = script.parseConfig(_validJson()).chainA.gate;
        tampered.supportedVersions[3].version = bytes4(0x07000000);
        _expectGateMismatch(d, deployed, tampered, "gate.supportedVersions.version");

        tampered = script.parseConfig(_validJson()).chainA.gate;
        tampered.supportedVersions[2].stateDepth = 5;
        _expectGateMismatch(d, deployed, tampered, "gate.supportedVersions.stateDepth");

        tampered = script.parseConfig(_validJson()).chainA.gate;
        uint8[] memory fewerDepths = new uint8[](2);
        fewerDepths[0] = 5;
        fewerDepths[1] = 6;
        tampered.sealDepths = fewerDepths;
        _expectGateMismatch(d, deployed, tampered, "gate.sealDepths");

        tampered = script.parseConfig(_validJson()).chainA.gate;
        tampered.sealDepths[2] = 8;
        _expectGateMismatch(d, deployed, tampered, "gate.sealDepths");

        // Honest control: the configured gate passes, with the bridge wired to it.
        d.plan.gate = honestGate;
        deployed.gate = honestGate;
        script.verifyDeployment(d, deployed);
    }

    /// @dev Deploys a gate with the tampered settings, predicts it, and expects the read-back to name `field`.
    function _expectGateMismatch(
        DeployBridge.ChainDeployment memory d,
        DeployBridge.ChainAddresses memory deployed,
        DeployBridge.GateConfig memory tampered,
        string memory field
    ) internal {
        BeaconForkGate gate = _newGateFrom(tampered);
        d.plan.gate = address(gate);
        deployed.gate = address(gate);
        vm.expectRevert(abi.encodeWithSelector(DeployBridge.DeploymentMismatch.selector, field));
        script.verifyDeployment(d, deployed);
    }

    /// Claim: the post-deploy check demands that all three layout tables of the bridge start empty, including the table
    /// of `historical_summaries` layouts. Shows: with one entry written into each table in turn (by storage write, because
    /// a real entry needs light-client evidence), `verifyDeployment` fails with the field name; the honest bridge
    /// passes. Matters: HB-01 (a table that starts non-empty would mean the deployment was not the fresh contract the
    /// operator thinks; the new table is the one an old check would miss).
    function test_HB01_postDeployAssertionsCatchLayoutsThatDoNotStartEmpty() public {
        (DeployBridge.ChainDeployment memory d, DeployBridge.ChainAddresses memory deployed) = _honestChainA();
        address honestBridge = deployed.bridge;
        // Storage slots 6, 7 and 8 hold the three layout arrays (see `forge inspect MessageBridge storageLayout`).
        for (uint256 slot = 6; slot <= 8; slot++) {
            MessageBridge fresh = _newBridgeA(deployed, d.remoteBridge, d.remoteLightClient, 0, d.chain.lightClient.capellaEra);
            vm.store(address(fresh), bytes32(slot), bytes32(uint256(1)));
            _swapBridge(d, deployed, fresh);
            vm.expectRevert(abi.encodeWithSelector(DeployBridge.DeploymentMismatch.selector, "bridge.layouts must start empty"));
            script.verifyDeployment(d, deployed);
        }
        d.plan.bridge = honestBridge;
        deployed.bridge = honestBridge;
        script.verifyDeployment(d, deployed); // honest
    }

    /// Claim: the post-deploy check catches a router that points at the wrong mediator or the wrong wrapped token.
    /// Shows: for the native coin router and the fee router in turn, a router built with another mediator and one built
    /// with another wrapped token each fail with the field name; the honest routers pass. Matters: a router on the wrong
    /// mediator or token wraps coin that the bridge cannot carry, and nothing can change a router after deployment.
    function test_postDeployAssertionsCatchRoutersOnTheWrongMediatorOrToken() public {
        (DeployBridge.ChainDeployment memory d, DeployBridge.ChainAddresses memory deployed) = _honestChainA();
        ITokenMediator mediator = ITokenMediator(deployed.mediator);
        ITokenMediator otherMediator = ITokenMediator(makeAddr("another mediator"));
        IWETH honestToken = IWETH(address(wrappedNativeOnA));
        IWETH otherToken = IWETH(address(wrappedNativeOnB));
        address honestWrapped = deployed.wrappedRouter;
        address honestFee = deployed.feeRouter;

        deployed.wrappedRouter = address(new WETHOmnibridgeRouter(otherMediator, otherToken));
        d.plan.wrappedRouter = deployed.wrappedRouter;
        vm.expectRevert(abi.encodeWithSelector(DeployBridge.DeploymentMismatch.selector, "wrappedRouter.mediator"));
        script.verifyDeployment(d, deployed);

        deployed.wrappedRouter = address(new WETHOmnibridgeRouter(mediator, otherToken));
        d.plan.wrappedRouter = deployed.wrappedRouter;
        vm.expectRevert(abi.encodeWithSelector(DeployBridge.DeploymentMismatch.selector, "wrappedRouter.wrappedNative"));
        script.verifyDeployment(d, deployed);
        d.plan.wrappedRouter = honestWrapped;
        deployed.wrappedRouter = honestWrapped;

        deployed.feeRouter = address(new FeeRouter(otherMediator, honestToken));
        d.plan.feeRouter = deployed.feeRouter;
        vm.expectRevert(abi.encodeWithSelector(DeployBridge.DeploymentMismatch.selector, "feeRouter.mediator"));
        script.verifyDeployment(d, deployed);

        deployed.feeRouter = address(new FeeRouter(mediator, otherToken));
        d.plan.feeRouter = deployed.feeRouter;
        vm.expectRevert(abi.encodeWithSelector(DeployBridge.DeploymentMismatch.selector, "feeRouter.wrappedNative"));
        script.verifyDeployment(d, deployed);
        d.plan.feeRouter = honestFee;
        deployed.feeRouter = honestFee;

        script.verifyDeployment(d, deployed); // honest
    }

    /// Claim: the read-back checks that the verifier still has the pinned code after the deployment. Shows: the honest
    /// deployment passes; after other code is put at the verifier address, `verifyDeployment` fails with the expected and
    /// the actual hash. Matters: every light client trusts the verifier, and a verifier whose code changed between the
    /// check and the end of the deployment (or an address that never held the pinned code) would accept any proof.
    function test_postDeployAssertionsCatchAVerifierWhoseCodeIsNotThePinnedCode() public {
        (DeployBridge.ChainDeployment memory d, DeployBridge.ChainAddresses memory deployed) = _honestChainA();
        bytes32 pinned = address(verifier).codehash;
        vm.etch(address(verifier), hex"600160005260206000f3");
        vm.expectRevert(
            abi.encodeWithSelector(
                DeployBridge.VerifierCodeHashMismatch.selector, uint64(1), address(verifier), pinned, address(verifier).codehash
            )
        );
        script.verifyDeployment(d, deployed);
    }

    // ================================================================ the fork registry on PulseChain

    function _deploymentB(DeployBridge.BridgeConfig memory config, DeployBridge.Plan memory plan)
        internal
        view
        returns (DeployBridge.ChainDeployment memory deploymentB)
    {
        (, deploymentB) = _deployments(config, plan);
    }

    /// Claim: the clock of each light client is checked against the gate of the chain that it tracks. Shows: a genesis
    /// time or a seconds-per-slot value that differs reverts `ClockMismatch` (light client) or `ObservationMismatch`
    /// (own-chain light client) with the field, and a zero value reverts `ZeroConfigValue`. Matters: G-04. The light
    /// client refuses heads later than its clock. A clock that runs ahead would let a forged head in, and a clock that
    /// runs behind would refuse honest heads.
    function test_G04_parseConfig_checksTheLightClientClockAgainstTheOtherChain() public {
        string memory json = _validJson();
        string memory key = _hexString(keccak256("light client program"));
        string memory chainAClient = string.concat('"lightClient":{"programVKey":"', key, '","genesisTime":"1683785555",');

        vm.expectRevert(
            abi.encodeWithSelector(
                DeployBridge.ClockMismatch.selector, "lightClient.genesisTime differs from the gate of the other chain"
            )
        );
        script.parseConfig(vm.replace(json, chainAClient, string.concat('"lightClient":{"programVKey":"', key, '","genesisTime":"1683785556",')));

        vm.expectRevert(
            abi.encodeWithSelector(
                DeployBridge.ClockMismatch.selector, "lightClient.secondsPerSlot differs from the gate of the other chain"
            )
        );
        script.parseConfig(vm.replace(json, '"secondsPerSlot":"10","genesisValidatorsRoot"', '"secondsPerSlot":"11","genesisValidatorsRoot"'));

        vm.expectRevert(
            abi.encodeWithSelector(
                DeployBridge.ObservationMismatch.selector, "genesisTime differs from the other chain's light client"
            )
        );
        script.parseConfig(vm.replace(json, '"observation":{"genesisTime":"1683785555"', '"observation":{"genesisTime":"1683785556"'));

        vm.expectRevert(
            abi.encodeWithSelector(
                DeployBridge.ObservationMismatch.selector, "secondsPerSlot differs from the other chain's light client"
            )
        );
        script.parseConfig(vm.replace(json, '"secondsPerSlot":"10","lightClientProgramVKey"', '"secondsPerSlot":"11","lightClientProgramVKey"'));

        vm.expectRevert(abi.encodeWithSelector(DeployBridge.ZeroConfigValue.selector, ".chainA.lightClient.genesisTime"));
        script.parseConfig(vm.replace(json, chainAClient, string.concat('"lightClient":{"programVKey":"', key, '","genesisTime":"0",')));
    }

    /// Claim: the registry settings are checked against the other chain, not only read. Shows: a genesis validators
    /// root, a period length or a key that does not fit each revert `ObservationMismatch` with the field; a placeholder
    /// reverts `PlaceholderValue`; the honest file parses. Matters: HB-02 on PulseChain. The own-chain light client
    /// must follow the same beacon chain as the Ethereum-side light client, or the registry would record versions of
    /// another chain. An observation key equal to the light-client key would let the two kinds of proof be swapped.
    function test_HB02_parseConfig_checksTheObservationAgainstTheOtherChain() public {
        string memory json = _validJson();
        string memory honestRoot = _hexString(keccak256(abi.encode("genesis", uint64(1))));
        string memory otherRoot = _hexString(keccak256("another chain"));

        vm.expectRevert(
            abi.encodeWithSelector(
                DeployBridge.ObservationMismatch.selector, "genesisValidatorsRoot differs from the other chain's light client"
            )
        );
        script.parseConfig(vm.replace(json, string.concat('"genesisValidatorsRoot":"', honestRoot, '","slotsPerPeriod":"8192","initialSlot"'), string.concat('"genesisValidatorsRoot":"', otherRoot, '","slotsPerPeriod":"8192","initialSlot"')));

        vm.expectRevert(
            abi.encodeWithSelector(
                DeployBridge.ObservationMismatch.selector, "slotsPerPeriod differs from the other chain's light client"
            )
        );
        script.parseConfig(vm.replace(json, '"slotsPerPeriod":"8192","initialSlot"', '"slotsPerPeriod":"4096","initialSlot"'));

        string memory sameKey = _hexString(keccak256("light client program"));
        vm.expectRevert(
            abi.encodeWithSelector(
                DeployBridge.ObservationMismatch.selector, "observationProgramVKey equals lightClientProgramVKey"
            )
        );
        script.parseConfig(vm.replace(json, _hexString(keccak256("fork observation program")), sameKey));

        vm.expectRevert(
            abi.encodeWithSelector(DeployBridge.PlaceholderValue.selector, ".chainB.observation.observationProgramVKey")
        );
        script.parseConfig(vm.replace(json, _hexString(keccak256("fork observation program")), "REPLACE_WITH_KEY"));

        script.parseConfig(json); // honest
    }

    /// Claim: after deployment the script reads the registry and the own-chain light client back and compares each
    /// with the configuration and the prediction. Shows: with an honest chain B deployment the read-back passes; a
    /// wrong observation key, a wrong predicted registry, a wrong own-chain genesis root and a registry on an
    /// Ethereum-mode chain each revert. Matters: the registry is the only thing that closes a consensus-only fork on
    /// PulseChain. A registry wired to the wrong light client or the wrong key would give a false sense of cover.
    function test_HB02_postDeployAssertionsCatchAWrongRegistry() public {
        DeployBridge.BridgeConfig memory config = script.parseConfig(_validJson());
        DeployBridge.Plan memory plan = script.predictAddresses(config);
        (, DeployBridge.ChainDeployment memory deploymentB) = _deployments(config, plan);
        _etchBeaconRoots();
        vm.chainId(369);
        vm.setNonce(deployer, uint64(NONCE_B));
        address gateB = script.deployChain(deploymentB).gate;
        script.verifyRegistry(deploymentB, gateB); // honest

        DeployBridge.ChainDeployment memory wrong = _deploymentB(config, plan);
        wrong.chain.observation.observationProgramVKey = keccak256("another key");
        vm.expectRevert(abi.encodeWithSelector(DeployBridge.DeploymentMismatch.selector, "registry.observationProgramVKey"));
        script.verifyRegistry(wrong, gateB);

        wrong = _deploymentB(config, plan);
        wrong.plan.registry = makeAddr("elsewhere");
        vm.expectRevert(
            abi.encodeWithSelector(DeployBridge.AddressNotAsPredicted.selector, "forkRegistry", wrong.plan.registry, plan.chainB.registry)
        );
        script.verifyRegistry(wrong, gateB);

        wrong = _deploymentB(config, plan);
        wrong.chain.observation.genesisValidatorsRoot = keccak256("another chain");
        vm.expectRevert(abi.encodeWithSelector(DeployBridge.DeploymentMismatch.selector, "observed.genesisValidatorsRoot"));
        script.verifyRegistry(wrong, gateB);

        wrong = _deploymentB(config, plan);
        wrong.chain.gate.mode = BeaconForkGate.GateMode.Enforcing;
        vm.expectRevert(abi.encodeWithSelector(DeployBridge.DeploymentMismatch.selector, "gate.forkRegistry must be empty"));
        script.verifyRegistry(wrong, gateB);
    }
}
