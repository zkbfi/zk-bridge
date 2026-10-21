// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test, console2} from "forge-std/Test.sol";
import {DeployBridge} from "../../script/hardened/DeployBridge.s.sol";
import {BeaconLightClient} from "../../src/hardened/BeaconLightClient.sol";
import {BridgeVault} from "../../src/hardened/BridgeVault.sol";
import {BeaconForkGate} from "../../src/hardened/BeaconForkGate.sol";
import {OracleSP1Verifier} from "../../src/mocks/OracleSP1Verifier.sol";
import {MockERC20} from "../../src/mocks/MockERC20.sol";

/// @notice Tests of the deploy script logic. One Foundry chain plays both chains: the test switches `block.chainid`
/// and the deployer nonce with cheatcodes, and it uses different nonces on the two sides so the addresses differ.
/// Chain A is Ethereum (chain identifier 1) and chain B is PulseChain (chain identifier 369). Each chain gets a light
/// client at nonce `n`, a deposit gate at `n + 1` and a vault at `n + 2`.
/// The `run()` entry point needs two live endpoints (see the harness) and is not run here.
contract DeployBridgeTest is Test {
    DeployBridge internal script;
    OracleSP1Verifier internal verifier;
    MockERC20 internal tokenOnA;
    MockERC20 internal tokenOnB;

    address internal deployer = makeAddr("deployer");
    uint256 internal constant NONCE_A = 3;
    uint256 internal constant NONCE_B = 8;
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
        tokenOnA = new MockERC20("A", "A");
        tokenOnB = new MockERC20("B", "B");
    }

    // ---------------------------------------------------------------- configuration builders

    function _hexString(bytes32 value) internal pure returns (string memory) {
        return vm.toString(value);
    }

    /// @dev The settings of one chain. The light client part describes the OTHER chain. Chain 1 is Ethereum, so its
    /// light client tracks PulseChain (Capella epoch 3, era 0) and its gate follows Ethereum (enforcing from the start).
    /// Chain 369 is the reverse: its light client tracks Ethereum (Capella epoch 194048, era 758) and its gate follows
    /// PulseChain (detects the beacon roots contract).
    function _chainJson(uint64 chainId, uint256 nonce, string memory verifierText, string memory slot)
        internal
        pure
        returns (string memory)
    {
        string memory head = string.concat(
            '{"rpcAlias":"chain-', vm.toString(chainId), '","chainId":"', vm.toString(chainId),
            '","verifier":"', verifierText, '","depositCutoffTimestamp":"0","deployerNonce":"', vm.toString(nonce), '",'
        );
        string memory client = string.concat(
            '"lightClient":{"programVKey":"', _hexString(keccak256("light client program")),
            '","genesisValidatorsRoot":"', _hexString(keccak256(abi.encode("genesis", chainId))),
            '","slotsPerPeriod":"8192",', chainId == 1 ? _pulsechainCapella() : _ethereumCapella()
        );
        string memory checkpoint = string.concat(
            '"initialSlot":"', slot, '","initialHeaderRoot":"', _hexString(keccak256("header")),
            '","initialSyncCommitteeHash":"', _hexString(keccak256("committee")),
            '","initialNextSyncCommitteeHash":"', _hexString(keccak256("next committee")), '"},'
        );
        return string.concat(head, client, checkpoint, chainId == 1 ? _ethereumGate() : _pulsechainGate(), "}");
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
            '"gate":{"mode":"DetectBeaconRoots","genesisTime":"1683785555","secondsPerSlot":"10","slotsPerEpoch":"32",',
            '"supportedVersions":', PULSECHAIN_VERSIONS, ',"sealDepths":', SEAL_DEPTHS, "}"
        );
    }

    function _configJson(string memory deployerText, string memory slot) internal view returns (string memory) {
        string memory verifierText = vm.toString(address(verifier));
        return string.concat(
            '{"deployer":"', deployerText, '","chainA":', _chainJson(1, NONCE_A, verifierText, slot),
            ',"chainB":', _chainJson(369, NONCE_B, verifierText, slot),
            ',"tokenPairs":[{"chainA":"', vm.toString(address(tokenOnA)), '","chainB":"', vm.toString(address(tokenOnB)), '"}]}'
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
        uint8[] memory decimalsA = new uint8[](1);
        decimalsA[0] = MockERC20(address(tokenOnA)).decimals();
        uint8[] memory decimalsB = new uint8[](1);
        decimalsB[0] = tokenOnB.decimals();
        deploymentA = script.withPairs(
            script.baseDeployment(
                config.chainA, config.chainB.chainId, config.deployer, plan.lightClientA, plan.gateA, plan.vaultA, plan.vaultB
            ),
            config.tokensA,
            config.tokensB,
            decimalsB
        );
        deploymentB = script.withPairs(
            script.baseDeployment(
                config.chainB, config.chainA.chainId, config.deployer, plan.lightClientB, plan.gateB, plan.vaultB, plan.vaultA
            ),
            config.tokensB,
            config.tokensA,
            decimalsA
        );
    }

    /// @dev Puts code at the beacon roots address, as an Ethereum node has it.
    function _etchBeaconRoots() internal {
        vm.etch(BEACON_ROOTS, hex"00");
    }

    // ================================================================ configuration is validated

    /// Claim: the script parses a complete configuration. Shows: every field lands where it belongs, including the
    /// deposit cutoff, the Capella era of the other chain, and every gate setting of both chains.
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
        assertEq(config.tokensA[0], address(tokenOnA));
        assertEq(config.tokensB[0], address(tokenOnB));

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

        assertEq(uint8(config.chainB.gate.mode), uint8(BeaconForkGate.GateMode.DetectBeaconRoots));
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
    /// Shows: each key exists in the example file; the removed `slotsPerHistoricalRoot` key does not. Matters: an
    /// example that lacks a key sends the operator into a failure the example never warned about, and an example with a
    /// dead key suggests a setting that no longer has any effect.
    function test_HB02_exampleConfigurationHoldsEveryKeyTheScriptReads() public view {
        string memory json = vm.readFile("script/hardened/bridge.config.example.json");
        string[2] memory chains = [".chainA", ".chainB"];
        string[15] memory keys = [
            ".rpcAlias", ".chainId", ".verifier", ".depositCutoffTimestamp", ".deployerNonce",
            ".lightClient.programVKey", ".lightClient.genesisValidatorsRoot", ".lightClient.slotsPerPeriod",
            ".lightClient.slotsPerEpoch", ".lightClient.capellaForkEpoch", ".lightClient.capellaEra",
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
        assertTrue(vm.keyExistsJson(json, ".tokenPairs[0].chainA"));
        assertTrue(vm.keyExistsJson(json, ".tokenPairs[0].chainB"));
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
    /// identifier, a zero checkpoint header root, a zero committee, a zero token address, zero slots per period, and
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

        vm.expectRevert(abi.encodeWithSelector(DeployBridge.ZeroConfigValue.selector, ".chainA.chainId"));
        script.parseConfig(vm.replace(json, '"chainId":"1"', '"chainId":"0"'));

        vm.expectRevert(abi.encodeWithSelector(DeployBridge.ZeroConfigValue.selector, ".chainA.lightClient.initialHeaderRoot"));
        script.parseConfig(vm.replace(json, vm.toString(keccak256("header")), zeroWord));

        vm.expectRevert(abi.encodeWithSelector(DeployBridge.ZeroConfigValue.selector, ".chainA.lightClient.initialSyncCommitteeHash"));
        script.parseConfig(vm.replace(json, vm.toString(keccak256("committee")), zeroWord));

        vm.expectRevert(abi.encodeWithSelector(DeployBridge.ZeroConfigValue.selector, ".chainA.lightClient.initialNextSyncCommitteeHash"));
        script.parseConfig(vm.replace(json, vm.toString(keccak256("next committee")), zeroWord));

        vm.expectRevert(abi.encodeWithSelector(DeployBridge.ZeroConfigValue.selector, ".tokenPairs.chainA"));
        script.parseConfig(vm.replace(json, vm.toString(address(tokenOnA)), zeroAddress));

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
    /// vault turns a deposit slot into an index of `historical_summaries` with this number, so a number that is too low
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
        script.parseConfig(vm.replace(json, '"mode":"DetectBeaconRoots"', '"mode":"Detect"'));

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

    /// Claim: the predicted addresses equal the deployed addresses, on both chains, before anything deploys, and the
    /// three contracts of a chain are wired to each other. Shows: `predictAddresses` from the configuration (light
    /// client at `n`, gate at `n + 1`, vault at `n + 2`), then two `deployChain` runs at the configured nonces; every
    /// deployed contract sits at its predicted address, each vault points at the other vault, at its own gate and at
    /// the Capella era of the OTHER chain, and each gate has the mode of its own chain. Matters: R2-08 (each vault needs
    /// the other's address as an immutable) and HB-02 (a vault with the wrong gate would admit deposits unchecked).
    function test_R2_08_predictedAddressesMatchDeployedAddresses() public {
        DeployBridge.BridgeConfig memory config = script.parseConfig(_validJson());
        DeployBridge.Plan memory plan = script.predictAddresses(config);
        assertEq(plan.lightClientA, vm.computeCreateAddress(deployer, NONCE_A));
        assertEq(plan.gateA, vm.computeCreateAddress(deployer, NONCE_A + 1));
        assertEq(plan.vaultA, vm.computeCreateAddress(deployer, NONCE_A + 2));
        assertEq(plan.lightClientB, vm.computeCreateAddress(deployer, NONCE_B));
        assertEq(plan.gateB, vm.computeCreateAddress(deployer, NONCE_B + 1));
        assertEq(plan.vaultB, vm.computeCreateAddress(deployer, NONCE_B + 2));
        (DeployBridge.ChainDeployment memory deploymentA, DeployBridge.ChainDeployment memory deploymentB) =
            _deployments(config, plan);

        _etchBeaconRoots();
        vm.chainId(1);
        vm.setNonce(deployer, uint64(NONCE_A));
        uint256 gasBefore = gasleft();
        (address lightClientA, address gateA, address vaultA) = script.deployChain(deploymentA);
        console2.log("gas of deployChain for chain A (light client, gate, vault, read-back)", gasBefore - gasleft());
        vm.chainId(369);
        vm.setNonce(deployer, uint64(NONCE_B));
        gasBefore = gasleft();
        (address lightClientB, address gateB, address vaultB) = script.deployChain(deploymentB);
        console2.log("gas of deployChain for chain B (light client, gate, vault, read-back)", gasBefore - gasleft());

        assertEq(lightClientA, plan.lightClientA);
        assertEq(gateA, plan.gateA);
        assertEq(vaultA, plan.vaultA);
        assertEq(lightClientB, plan.lightClientB);
        assertEq(gateB, plan.gateB);
        assertEq(vaultB, plan.vaultB);
        assertEq(vm.getNonce(deployer), NONCE_B + 3, "three contracts left the deployer on chain B");

        assertEq(BridgeVault(vaultA).remoteVault(), vaultB, "vault A points at the real vault B");
        assertEq(BridgeVault(vaultB).remoteVault(), vaultA, "vault B points at the real vault A");
        assertEq(address(BridgeVault(vaultA).lightClient()), lightClientA);
        assertEq(address(BridgeVault(vaultB).lightClient()), lightClientB);
        assertEq(address(BridgeVault(vaultA).depositGate()), gateA, "vault A uses the gate of chain A");
        assertEq(address(BridgeVault(vaultB).depositGate()), gateB, "vault B uses the gate of chain B");
        assertEq(BridgeVault(vaultA).capellaEra(), 0, "vault A proves PulseChain deposits: Capella era 0");
        assertEq(BridgeVault(vaultB).capellaEra(), 758, "vault B proves Ethereum deposits: Capella era 758");
        assertEq(BridgeVault(vaultA).remoteTokenOf(address(tokenOnA)), address(tokenOnB));
        assertEq(BeaconLightClient(lightClientB).head(), 819264);

        assertTrue(BeaconForkGate(gateA).enforcing(), "the Ethereum gate enforces from deployment");
        assertFalse(BeaconForkGate(gateB).enforcing(), "the PulseChain gate waits for a beacon root");
        assertEq(uint8(BeaconForkGate(gateA).mode()), uint8(BeaconForkGate.GateMode.Enforcing));
        assertEq(uint8(BeaconForkGate(gateB).mode()), uint8(BeaconForkGate.GateMode.DetectBeaconRoots));
        assertEq(BeaconForkGate(gateA).secondsPerSlot(), 12);
        assertEq(BeaconForkGate(gateB).secondsPerSlot(), 10);
        assertEq(BeaconForkGate(gateA).supportedVersions().length, 4);
        assertEq(BeaconForkGate(gateB).supportedVersions().length, 1);
        assertEq(BeaconForkGate(gateB).supportedVersions()[0].version, bytes4(0x0000036c));
    }

    // ================================================================ guards

    /// Claim: the script refuses to run when the deployer nonce differs from the configuration, on either chain.
    /// Shows: a nonce one too high and one too low revert with all three numbers; the right nonce passes.
    /// Matters: R2-08 (a different nonce shifts every predicted address, so the vaults would point at nothing).
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
        assertEq(plan.lightClientA.code.length, 0);
        assertEq(plan.gateA.code.length, 0);

        vm.setNonce(deployer, uint64(NONCE_A)); // honest
        (address lightClient, address gate, address vault) = script.deployChain(deploymentA);
        assertEq(lightClient, plan.lightClientA);
        assertEq(gate, plan.gateA);
        assertEq(vault, plan.vaultA);
    }

    /// Claim: the connected chain must be the configured chain, and the verifier must have code there.
    /// Shows: two exact errors, each followed by the honest call. Matters: the specification's SP1 gateways have code
    /// on Ethereum but none on PulseChain.
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
            c.lightClient.initialSlot,
            c.lightClient.initialHeaderRoot,
            c.lightClient.initialSyncCommitteeHash,
            c.lightClient.initialNextSyncCommitteeHash
        );
    }

    function _newGateFrom(DeployBridge.GateConfig memory g) internal returns (BeaconForkGate) {
        return new BeaconForkGate(
            BEACON_ROOTS, g.mode, g.genesisTime, g.secondsPerSlot, g.slotsPerEpoch, g.supportedVersions, g.sealDepths
        );
    }

    /// @dev A vault for chain A. The constructor reads `block.chainid`, so the caller sets chain 1 first.
    function _newVaultA(
        DeployBridge.ChainDeployment memory d,
        address lightClient,
        address gate,
        address remoteVault,
        uint64 cutoff,
        uint64 capellaEra
    ) internal returns (BridgeVault) {
        return new BridgeVault(lightClient, 1, 369, remoteVault, d.pairs, cutoff, capellaEra, gate);
    }

    /// @dev Deploys the honest contracts of chain A at addresses of this test, records them as the predicted addresses,
    /// and proves that `verifyDeployment` accepts them. Every attack test below starts here, so it can fail.
    function _honestChainA() internal returns (DeployBridge.ChainDeployment memory deploymentA) {
        DeployBridge.BridgeConfig memory config = script.parseConfig(_validJson());
        DeployBridge.Plan memory plan = script.predictAddresses(config);
        (deploymentA,) = _deployments(config, plan);
        vm.chainId(1);
        BeaconLightClient lightClient = _newClient(deploymentA.chain, deploymentA.chain.lightClient.genesisValidatorsRoot);
        BeaconForkGate gate = _newGateFrom(deploymentA.chain.gate);
        BridgeVault vault = _newVaultA(
            deploymentA, address(lightClient), address(gate), plan.vaultB, 0, deploymentA.chain.lightClient.capellaEra
        );
        deploymentA.predictedLightClient = address(lightClient);
        deploymentA.predictedGate = address(gate);
        deploymentA.predictedVault = address(vault);
        script.verifyDeployment(deploymentA, address(lightClient), address(gate), address(vault)); // control
    }

    /// Claim: the post-deploy check catches a wrong remote vault. Shows: a vault with another remote vault fails
    /// `verifyDeployment` with the field name, while the honest vault passes; a contract at an address other than the
    /// prediction fails with the prediction error, for the light client, the gate and the vault. Matters: R2-08 (read
    /// every immutable back, do not trust that the deployment matched).
    function test_R2_08_postDeployAssertionsCatchWrongRemoteVault() public {
        DeployBridge.ChainDeployment memory deploymentA = _honestChainA();
        address lightClient = deploymentA.predictedLightClient;
        address gate = deploymentA.predictedGate;
        BridgeVault wrongRemote =
            _newVaultA(deploymentA, lightClient, gate, makeAddr("not the predicted vault B"), 0, 0);
        deploymentA.predictedVault = address(wrongRemote);
        vm.expectRevert(abi.encodeWithSelector(DeployBridge.DeploymentMismatch.selector, "vault.remoteVault"));
        script.verifyDeployment(deploymentA, lightClient, gate, address(wrongRemote));

        // The prediction itself is checked first, for each of the three contracts.
        address vault = deploymentA.predictedVault;
        vm.expectRevert(abi.encodeWithSelector(DeployBridge.AddressNotAsPredicted.selector, "vault", vault, address(this)));
        script.verifyDeployment(deploymentA, lightClient, gate, address(this));
        vm.expectRevert(abi.encodeWithSelector(DeployBridge.AddressNotAsPredicted.selector, "gate", gate, address(this)));
        script.verifyDeployment(deploymentA, lightClient, address(this), vault);
        vm.expectRevert(
            abi.encodeWithSelector(DeployBridge.AddressNotAsPredicted.selector, "lightClient", lightClient, address(this))
        );
        script.verifyDeployment(deploymentA, address(this), gate, vault);
    }

    /// Claim: the post-deploy check catches a wrong deposit cutoff, and passes for the right deployment. Shows: a
    /// vault with cutoff 12345 fails with the field name; the vault with the configured cutoff passes. Matters: R2-08.
    function test_R2_08_postDeployAssertionsCatchWrongCutoffAndPassWhenRight() public {
        DeployBridge.ChainDeployment memory deploymentA = _honestChainA(); // its own run proves the honest vault passes
        address lightClient = deploymentA.predictedLightClient;
        address gate = deploymentA.predictedGate;
        BridgeVault wrongCutoff = _newVaultA(
            deploymentA, lightClient, gate, deploymentA.remoteVault, 12_345, deploymentA.chain.lightClient.capellaEra
        );
        deploymentA.predictedVault = address(wrongCutoff);
        vm.expectRevert(abi.encodeWithSelector(DeployBridge.DeploymentMismatch.selector, "vault.depositCutoffTimestamp"));
        script.verifyDeployment(deploymentA, lightClient, gate, address(wrongCutoff));
    }

    /// Claim: the light client read-back catches a wrong checkpoint. Shows: a light client with another genesis
    /// validators root fails with the field name, and the honest light client passes. Matters: R2-09 (the chain binding
    /// is the point of that field).
    function test_R2_09_postDeployAssertionsCatchWrongGenesisRoot() public {
        DeployBridge.ChainDeployment memory deploymentA = _honestChainA();
        BeaconLightClient wrong = _newClient(deploymentA.chain, keccak256("another chain"));
        deploymentA.predictedLightClient = address(wrong);
        vm.expectRevert(abi.encodeWithSelector(DeployBridge.DeploymentMismatch.selector, "lightClient.genesisValidatorsRoot"));
        script.verifyDeployment(deploymentA, address(wrong), deploymentA.predictedGate, deploymentA.predictedVault);
    }

    /// Claim: the post-deploy check catches a wrong Capella era on the vault. Shows: a vault built with era 5 instead
    /// of 0 fails with the field name; the honest vault passes. Matters: HB-01 (the era shifts every index into
    /// `historical_summaries`, so a wrong era makes honest withdrawals fail or reads a neighbouring summary).
    function test_HB01_postDeployAssertionsCatchWrongCapellaEra() public {
        DeployBridge.ChainDeployment memory deploymentA = _honestChainA();
        address lightClient = deploymentA.predictedLightClient;
        address gate = deploymentA.predictedGate;
        BridgeVault wrongEra = _newVaultA(deploymentA, lightClient, gate, deploymentA.remoteVault, 0, 5);
        deploymentA.predictedVault = address(wrongEra);
        vm.expectRevert(abi.encodeWithSelector(DeployBridge.DeploymentMismatch.selector, "vault.capellaEra"));
        script.verifyDeployment(deploymentA, lightClient, gate, address(wrongEra));
    }

    /// Claim: the post-deploy check catches a vault wired to another deposit gate. Shows: a vault that points at a
    /// second gate with the same settings fails with the field name, although that gate is itself correct; the honest
    /// pair passes. Matters: HB-02 (the gate is the only guard of the deposit side after an unknown fork; a vault that
    /// uses a different gate than the one the operator checked is unguarded in practice).
    function test_HB02_postDeployAssertionsCatchVaultWithAnotherGate() public {
        DeployBridge.ChainDeployment memory deploymentA = _honestChainA();
        address lightClient = deploymentA.predictedLightClient;
        address gate = deploymentA.predictedGate;
        BeaconForkGate otherGate = _newGateFrom(deploymentA.chain.gate);
        assertTrue(address(otherGate) != gate, "the second gate is a different contract");
        BridgeVault wired = _newVaultA(
            deploymentA, lightClient, address(otherGate), deploymentA.remoteVault, 0, deploymentA.chain.lightClient.capellaEra
        );
        deploymentA.predictedVault = address(wired);
        vm.expectRevert(abi.encodeWithSelector(DeployBridge.DeploymentMismatch.selector, "vault.depositGate"));
        script.verifyDeployment(deploymentA, lightClient, gate, address(wired));
    }

    /// Claim: the post-deploy check reads every gate setting back. Shows: for each setting in turn (mode, genesis
    /// time, seconds per slot, slots per epoch, the length of the version table, one version, one state depth, the seal
    /// depths) a gate that differs in only that setting fails with the field name; the honest gate passes at the end.
    /// Matters: HB-02 (a wrong version table either supports a fork that the light client cannot prove, or rejects a
    /// fork it can, and a wrong seal depth lets a stranger seal the gate or blocks the seal).
    function test_HB02_postDeployAssertionsCatchEveryWrongGateSetting() public {
        DeployBridge.ChainDeployment memory deploymentA = _honestChainA();
        address lightClient = deploymentA.predictedLightClient;
        address honestGate = deploymentA.predictedGate;
        address vault = deploymentA.predictedVault;

        DeployBridge.GateConfig memory tampered = script.parseConfig(_validJson()).chainA.gate;
        tampered.mode = BeaconForkGate.GateMode.DetectBeaconRoots;
        _expectGateMismatch(deploymentA, tampered, "gate.mode");

        tampered = script.parseConfig(_validJson()).chainA.gate;
        tampered.genesisTime += 1;
        _expectGateMismatch(deploymentA, tampered, "gate.genesisTime");

        tampered = script.parseConfig(_validJson()).chainA.gate;
        tampered.secondsPerSlot = 10;
        _expectGateMismatch(deploymentA, tampered, "gate.secondsPerSlot");

        tampered = script.parseConfig(_validJson()).chainA.gate;
        tampered.slotsPerEpoch = 31;
        _expectGateMismatch(deploymentA, tampered, "gate.slotsPerEpoch");

        tampered = script.parseConfig(_validJson()).chainA.gate;
        BeaconForkGate.SupportedVersion[] memory shorter = new BeaconForkGate.SupportedVersion[](3);
        for (uint256 i = 0; i < 3; i++) {
            shorter[i] = tampered.supportedVersions[i];
        }
        tampered.supportedVersions = shorter;
        _expectGateMismatch(deploymentA, tampered, "gate.supportedVersions");

        tampered = script.parseConfig(_validJson()).chainA.gate;
        tampered.supportedVersions[3].version = bytes4(0x07000000);
        _expectGateMismatch(deploymentA, tampered, "gate.supportedVersions.version");

        tampered = script.parseConfig(_validJson()).chainA.gate;
        tampered.supportedVersions[2].stateDepth = 5;
        _expectGateMismatch(deploymentA, tampered, "gate.supportedVersions.stateDepth");

        tampered = script.parseConfig(_validJson()).chainA.gate;
        uint8[] memory fewerDepths = new uint8[](2);
        fewerDepths[0] = 5;
        fewerDepths[1] = 6;
        tampered.sealDepths = fewerDepths;
        _expectGateMismatch(deploymentA, tampered, "gate.sealDepths");

        tampered = script.parseConfig(_validJson()).chainA.gate;
        tampered.sealDepths[2] = 8;
        _expectGateMismatch(deploymentA, tampered, "gate.sealDepths");

        // Honest control: the configured gate passes, with the vault wired to it.
        deploymentA.predictedGate = honestGate;
        script.verifyDeployment(deploymentA, lightClient, honestGate, vault);
    }

    /// @dev Deploys a gate with the tampered settings, predicts it, and expects the read-back to name `field`.
    function _expectGateMismatch(
        DeployBridge.ChainDeployment memory deploymentA,
        DeployBridge.GateConfig memory tampered,
        string memory field
    ) internal {
        address lightClient = deploymentA.predictedLightClient;
        address vault = deploymentA.predictedVault;
        BeaconForkGate gate = _newGateFrom(tampered);
        deploymentA.predictedGate = address(gate);
        vm.expectRevert(abi.encodeWithSelector(DeployBridge.DeploymentMismatch.selector, field));
        script.verifyDeployment(deploymentA, lightClient, address(gate), vault);
    }

    /// Claim: the post-deploy check demands that all three layout tables start empty, including the table of
    /// `historical_summaries` layouts. Shows: with one entry written into each table in turn (by storage write, because
    /// a real entry needs light-client evidence), `verifyDeployment` fails with the field name; the honest vault
    /// passes. Matters: HB-01 (a table that starts non-empty would mean the deployment was not the fresh contract the
    /// operator thinks; the new table is the one an old check would miss).
    function test_HB01_postDeployAssertionsCatchLayoutsThatDoNotStartEmpty() public {
        DeployBridge.ChainDeployment memory deploymentA = _honestChainA();
        address lightClient = deploymentA.predictedLightClient;
        address gate = deploymentA.predictedGate;
        address vault = deploymentA.predictedVault;
        // Storage slots 4, 5 and 6 hold the three layout arrays (see `forge inspect BridgeVault storageLayout`).
        for (uint256 slot = 4; slot <= 6; slot++) {
            BridgeVault fresh = _newVaultA(
                deploymentA, lightClient, gate, deploymentA.remoteVault, 0, deploymentA.chain.lightClient.capellaEra
            );
            vm.store(address(fresh), bytes32(slot), bytes32(uint256(1)));
            deploymentA.predictedVault = address(fresh);
            vm.expectRevert(abi.encodeWithSelector(DeployBridge.DeploymentMismatch.selector, "vault.layouts must start empty"));
            script.verifyDeployment(deploymentA, lightClient, gate, address(fresh));
        }
        deploymentA.predictedVault = vault;
        script.verifyDeployment(deploymentA, lightClient, gate, vault); // honest
    }
}
