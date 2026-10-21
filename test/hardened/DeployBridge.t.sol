// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {DeployBridge} from "../../script/hardened/DeployBridge.s.sol";
import {BeaconLightClient} from "../../src/hardened/BeaconLightClient.sol";
import {BridgeVault} from "../../src/hardened/BridgeVault.sol";
import {OracleSP1Verifier} from "../../src/mocks/OracleSP1Verifier.sol";
import {MockERC20} from "../../src/mocks/MockERC20.sol";

/// @notice Tests of the deploy script logic. One Foundry chain plays both chains: the test switches `block.chainid`
/// and the deployer nonce with cheatcodes, and it uses different nonces on the two sides so the addresses differ.
/// The `run()` entry point needs two live RPC endpoints (see the harness) and is not run here.
contract DeployBridgeTest is Test {
    DeployBridge internal script;
    OracleSP1Verifier internal verifier;
    MockERC20 internal tokenOnA;
    MockERC20 internal tokenOnB;

    address internal deployer = makeAddr("deployer");
    uint256 internal constant NONCE_A = 3;
    uint256 internal constant NONCE_B = 8;

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

    function _chainJson(uint64 chainId, uint256 nonce, string memory verifierText, string memory slot) internal view returns (string memory) {
        string memory head = string.concat(
            '{"rpcAlias":"chain-', vm.toString(chainId), '","chainId":"', vm.toString(chainId),
            '","verifier":"', verifierText, '","depositCutoffTimestamp":"0","deployerNonce":"', vm.toString(nonce), '",'
        );
        string memory client = string.concat(
            '"lightClient":{"programVKey":"', _hexString(keccak256("light client program")),
            '","genesisValidatorsRoot":"', _hexString(keccak256(abi.encode("genesis", chainId))),
            '","slotsPerPeriod":"8192","slotsPerHistoricalRoot":"8192",'
        );
        string memory checkpoint = string.concat(
            '"initialSlot":"', slot, '","initialHeaderRoot":"', _hexString(keccak256("header")),
            '","initialSyncCommitteeHash":"', _hexString(keccak256("committee")),
            '","initialNextSyncCommitteeHash":"', _hexString(keccak256("next committee")), '"}}'
        );
        return string.concat(head, client, checkpoint);
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
            script.baseDeployment(config.chainA, config.chainB.chainId, config.deployer, plan.lightClientA, plan.vaultA, plan.vaultB),
            config.tokensA,
            config.tokensB,
            decimalsB
        );
        deploymentB = script.withPairs(
            script.baseDeployment(config.chainB, config.chainA.chainId, config.deployer, plan.lightClientB, plan.vaultB, plan.vaultA),
            config.tokensB,
            config.tokensA,
            decimalsA
        );
    }

    // ================================================================ configuration is validated

    /// Claim: the script parses a complete configuration. Shows: every field lands where it belongs, including the
    /// deposit cutoff. Matters: R2-08 (the plan starts from a configuration the script understands).
    function test_R2_08_parseConfig_acceptsCompleteConfiguration() public view {
        DeployBridge.BridgeConfig memory config = script.parseConfig(_validJson());
        assertEq(config.deployer, deployer);
        assertEq(config.chainA.chainId, 1);
        assertEq(config.chainB.chainId, 369);
        assertEq(config.chainA.deployerNonce, NONCE_A);
        assertEq(config.chainB.deployerNonce, NONCE_B);
        assertEq(config.chainA.depositCutoffTimestamp, 0);
        assertEq(config.chainA.lightClient.slotsPerHistoricalRoot, 8192);
        assertEq(config.tokensA[0], address(tokenOnA));
        assertEq(config.tokensB[0], address(tokenOnB));
    }

    /// Claim: the example configuration cannot be used as it is. Shows: reading the shipped example file reverts with a
    /// placeholder error. Matters: H-17 (placeholder strings reached the constructor in the specification's deploy
    /// notes). Needs read access to `script/`; the test skips when `fs_permissions` does not allow it.
    function test_R2_08_exampleConfigurationIsRefused() public {
        string memory json;
        try this.readExample() returns (string memory text) {
            json = text;
        } catch {
            vm.skip(true, "fs_permissions does not allow reading script/hardened");
        }
        vm.expectRevert(abi.encodeWithSelector(DeployBridge.PlaceholderValue.selector, ".deployer"));
        script.parseConfig(json);
    }

    function readExample() external view returns (string memory) {
        return vm.readFile("script/hardened/bridge.config.example.json");
    }

    /// Claim: a placeholder in any field is refused with the name of the field. Shows: six fields in turn.
    /// Matters: H-17.
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

        script.parseConfig(json); // the real values pass
    }

    /// Claim: zero values are refused with the name of the field. Shows: a zero deployer, a zero verifier, a zero chain
    /// identifier, a zero checkpoint header root, a zero committee, a zero token address, and zero slots per period. A zero deposit cutoff is valid (no cutoff).
    /// Matters: a zero value is an unset value (H-17).
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
    }

    /// Claim: both chains need different identifiers. Shows: equal identifiers revert. Matters: the nonce domains.
    function test_R2_08_parseConfig_refusesSameChainIdentifier() public {
        string memory json = _validJson();
        vm.expectRevert(abi.encodeWithSelector(DeployBridge.SameChainIdentifier.selector, uint64(1)));
        script.parseConfig(vm.replace(json, '"chainId":"369"', '"chainId":"1"'));
    }

    // ================================================================ prediction

    /// Claim: the predicted addresses equal the deployed addresses, on both chains, before anything deploys. Shows:
    /// `predictAddresses` from the configuration, then two `deployChain` runs at the configured nonces; each deployed
    /// light client and vault sits at its predicted address, and each vault points at the other vault. Matters: R2-08
    /// (each vault needs the other's address as an immutable, and nothing in revision 2 predicted it).
    function test_R2_08_predictedAddressesMatchDeployedAddresses() public {
        DeployBridge.BridgeConfig memory config = script.parseConfig(_validJson());
        DeployBridge.Plan memory plan = script.predictAddresses(config);
        assertEq(plan.lightClientA, vm.computeCreateAddress(deployer, NONCE_A));
        assertEq(plan.vaultA, vm.computeCreateAddress(deployer, NONCE_A + 1));
        assertEq(plan.lightClientB, vm.computeCreateAddress(deployer, NONCE_B));
        assertEq(plan.vaultB, vm.computeCreateAddress(deployer, NONCE_B + 1));
        (DeployBridge.ChainDeployment memory deploymentA, DeployBridge.ChainDeployment memory deploymentB) =
            _deployments(config, plan);

        vm.chainId(1);
        vm.setNonce(deployer, uint64(NONCE_A));
        (address lightClientA, address vaultA) = script.deployChain(deploymentA);
        vm.chainId(369);
        vm.setNonce(deployer, uint64(NONCE_B));
        (address lightClientB, address vaultB) = script.deployChain(deploymentB);

        assertEq(lightClientA, plan.lightClientA);
        assertEq(vaultA, plan.vaultA);
        assertEq(lightClientB, plan.lightClientB);
        assertEq(vaultB, plan.vaultB);
        assertEq(BridgeVault(vaultA).remoteVault(), vaultB, "vault A points at the real vault B");
        assertEq(BridgeVault(vaultB).remoteVault(), vaultA, "vault B points at the real vault A");
        assertEq(address(BridgeVault(vaultA).lightClient()), lightClientA);
        assertEq(BridgeVault(vaultA).remoteTokenOf(address(tokenOnA)), address(tokenOnB));
        assertEq(BeaconLightClient(lightClientB).head(), 819264);
    }

    // ================================================================ guards

    /// Claim: the script refuses to run when the deployer nonce differs from the configuration, on either chain.
    /// Shows: a nonce one too high and one too low revert with all three numbers; the right nonce passes.
    /// Matters: R2-08 (a different nonce shifts every predicted address, so the vaults would point at nothing).
    function test_R2_08_nonceGuardRefusesMismatchedNonce() public {
        DeployBridge.BridgeConfig memory config = script.parseConfig(_validJson());
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

    /// Claim: the nonce guard also stops `deployChain`, and no contract is created. Shows: the revert and an unchanged
    /// nonce. Matters: a mismatched deployment would burn the nonce and strand the other chain's pointers.
    function test_R2_08_deployChainRefusesMismatchedNonce() public {
        DeployBridge.BridgeConfig memory config = script.parseConfig(_validJson());
        DeployBridge.Plan memory plan = script.predictAddresses(config);
        (DeployBridge.ChainDeployment memory deploymentA,) = _deployments(config, plan);
        vm.chainId(1);
        vm.setNonce(deployer, uint64(NONCE_A + 5));
        vm.expectRevert(abi.encodeWithSelector(DeployBridge.DeployerNonceMismatch.selector, uint64(1), NONCE_A, NONCE_A + 5));
        script.deployChain(deploymentA);
        assertEq(vm.getNonce(deployer), NONCE_A + 5);
        assertEq(plan.lightClientA.code.length, 0);
    }

    /// Claim: the connected chain must be the configured chain, and the verifier must have code there.
    /// Shows: two exact errors. Matters: the specification's SP1 gateways have code on Ethereum but none on PulseChain.
    function test_R2_08_environmentGuardsChainAndVerifier() public {
        DeployBridge.BridgeConfig memory config = script.parseConfig(_validJson());
        vm.setNonce(deployer, uint64(NONCE_A));
        vm.chainId(56);
        vm.expectRevert(abi.encodeWithSelector(DeployBridge.ChainIdMismatch.selector, uint64(1), uint256(56)));
        script.assertChainEnvironment(config.chainA, deployer);

        vm.chainId(1);
        config.chainA.verifier = makeAddr("an address with no code");
        vm.expectRevert(abi.encodeWithSelector(DeployBridge.VerifierHasNoCode.selector, uint64(1), config.chainA.verifier));
        script.assertChainEnvironment(config.chainA, deployer);
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
            c.lightClient.initialNextSyncCommitteeHash,
            c.lightClient.slotsPerHistoricalRoot
        );
    }

    function _deployLightClientA(DeployBridge.ChainDeployment memory deploymentA) internal returns (BeaconLightClient) {
        vm.chainId(1);
        vm.setNonce(deployer, uint64(NONCE_A));
        vm.prank(deployer);
        return _newClient(deploymentA.chain, deploymentA.chain.lightClient.genesisValidatorsRoot);
    }

    /// Claim: the post-deploy check catches a wrong remote vault. Shows: a vault deployed at the predicted nonce but
    /// with another remote vault has the predicted address and still fails `verifyDeployment` with the field name; a
    /// wrong actual address fails with the prediction error. Matters: R2-08 (read every immutable back, do not trust
    /// that the deployment matched).
    function test_R2_08_postDeployAssertionsCatchWrongRemoteVault() public {
        DeployBridge.BridgeConfig memory config = script.parseConfig(_validJson());
        DeployBridge.Plan memory plan = script.predictAddresses(config);
        (DeployBridge.ChainDeployment memory deploymentA,) = _deployments(config, plan);
        BeaconLightClient lightClient = _deployLightClientA(deploymentA);
        vm.prank(deployer);
        BridgeVault wrongRemote =
            new BridgeVault(address(lightClient), 1, 369, makeAddr("not the predicted vault B"), deploymentA.pairs, 0);
        assertEq(address(wrongRemote), plan.vaultA, "the nonce was right, so the address matched the prediction");
        vm.expectRevert(abi.encodeWithSelector(DeployBridge.DeploymentMismatch.selector, "vault.remoteVault"));
        script.verifyDeployment(deploymentA, address(lightClient), address(wrongRemote));

        vm.expectRevert(abi.encodeWithSelector(DeployBridge.AddressNotAsPredicted.selector, "vault", plan.vaultA, address(this)));
        script.verifyDeployment(deploymentA, address(lightClient), address(this));
    }

    /// Claim: the post-deploy check catches a wrong deposit cutoff, and passes for the right deployment. Shows: a
    /// vault with cutoff 12345 fails with the field name; the vault with the configured cutoff passes. Matters: R2-08.
    function test_R2_08_postDeployAssertionsCatchWrongCutoffAndPassWhenRight() public {
        DeployBridge.BridgeConfig memory config = script.parseConfig(_validJson());
        DeployBridge.Plan memory plan = script.predictAddresses(config);
        (DeployBridge.ChainDeployment memory deploymentA,) = _deployments(config, plan);
        BeaconLightClient lightClient = _deployLightClientA(deploymentA);
        deploymentA.predictedLightClient = address(lightClient);

        vm.prank(deployer);
        BridgeVault wrongCutoff = new BridgeVault(address(lightClient), 1, 369, plan.vaultB, deploymentA.pairs, 12345);
        deploymentA.predictedVault = address(wrongCutoff);
        vm.expectRevert(abi.encodeWithSelector(DeployBridge.DeploymentMismatch.selector, "vault.depositCutoffTimestamp"));
        script.verifyDeployment(deploymentA, address(lightClient), address(wrongCutoff));

        vm.prank(deployer);
        BridgeVault correct = new BridgeVault(address(lightClient), 1, 369, plan.vaultB, deploymentA.pairs, 0);
        deploymentA.predictedVault = address(correct);
        script.verifyDeployment(deploymentA, address(lightClient), address(correct)); // honest path
    }

    /// Claim: the light client read-back catches a wrong checkpoint. Shows: a light client with another genesis
    /// validators root fails with the field name. Matters: R2-09 (the chain binding is the point of that field).
    function test_R2_09_postDeployAssertionsCatchWrongGenesisRoot() public {
        DeployBridge.BridgeConfig memory config = script.parseConfig(_validJson());
        DeployBridge.Plan memory plan = script.predictAddresses(config);
        (DeployBridge.ChainDeployment memory deploymentA,) = _deployments(config, plan);
        BeaconLightClient wrong = _newClient(deploymentA.chain, keccak256("another chain"));
        deploymentA.predictedLightClient = address(wrong);
        deploymentA.predictedVault = address(this);
        vm.expectRevert(abi.encodeWithSelector(DeployBridge.DeploymentMismatch.selector, "lightClient.genesisValidatorsRoot"));
        script.verifyDeployment(deploymentA, address(wrong), address(this));
    }
}
