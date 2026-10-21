// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Vm} from "forge-std/Vm.sol";
import {BeaconLightClient} from "../../../src/hardened/BeaconLightClient.sol";
import {BridgeVault} from "../../../src/hardened/BridgeVault.sol";
import {OracleSP1Verifier} from "../../../src/mocks/OracleSP1Verifier.sol";
import {MockERC20} from "../../../src/mocks/MockERC20.sol";
import {HardenedProofs} from "./HardenedProofs.sol";

/// @title HardenedFixture
/// @notice One Foundry chain plays both roles. `vaultA` has chain id 1 and `vaultB` has chain id 369.
/// The test switches `block.chainid` with `vm.chainId` before it calls a vault, because the
/// deposit nonce reads `block.chainid`. `lightClientForB` tracks the beacon chain of chain A and
/// feeds `vaultB`. `lightClientForA` tracks chain B and feeds `vaultA`.
/// @notice The mint and approve functions of the mock tokens.
interface IMintableToken {
    function mint(address to, uint256 amount) external;
    function approve(address spender, uint256 amount) external returns (bool);
}

abstract contract HardenedFixture is HardenedProofs {
    address internal alice = makeAddr("alice");
    address internal bob = makeAddr("bob");
    address internal attacker = makeAddr("attacker");
    address internal oracle;

    OracleSP1Verifier internal verifier;
    BeaconLightClient internal lightClientForA;
    BeaconLightClient internal lightClientForB;
    MockERC20 internal tokenOnA;
    MockERC20 internal tokenOnB;
    BridgeVault internal vaultA;
    BridgeVault internal vaultB;

    function setUp() public virtual {
        oracle = vm.addr(ORACLE_KEY);
        verifier = new OracleSP1Verifier(oracle);
        lightClientForA = _newLightClient(GENESIS_ROOT_B, COMMITTEE_101);
        lightClientForB = _newLightClient(GENESIS_ROOT_A, COMMITTEE_101);
        tokenOnA = new MockERC20("Token on A", "TKA");
        tokenOnB = new MockERC20("Token on B", "TKB");

        BridgeVault.TokenPair[] memory pairsA = new BridgeVault.TokenPair[](1);
        pairsA[0] = BridgeVault.TokenPair(address(tokenOnA), address(tokenOnB), 18);
        BridgeVault.TokenPair[] memory pairsB = new BridgeVault.TokenPair[](1);
        pairsB[0] = BridgeVault.TokenPair(address(tokenOnB), address(tokenOnA), 18);

        // vaultA is created first, so vaultB lands on the next nonce of this contract.
        address predictedVaultB = vm.computeCreateAddress(address(this), vm.getNonce(address(this)) + 1);
        vm.chainId(CHAIN_A);
        vaultA = new BridgeVault(
            address(lightClientForA), CHAIN_A, CHAIN_B, predictedVaultB, pairsA, 0
        );
        vm.chainId(CHAIN_B);
        vaultB = new BridgeVault(
            address(lightClientForB), CHAIN_B, CHAIN_A, address(vaultA), pairsB, 0
        );
        require(address(vaultB) == predictedVaultB, "fixture: vaultB address prediction failed");
    }

    /// @notice A fresh light client at the standard checkpoint for the given chain.
    function _newLightClient(bytes32 genesisRoot, bytes32 nextCommittee) internal returns (BeaconLightClient) {
        return new BeaconLightClient(
            address(verifier),
            LIGHT_CLIENT_VKEY,
            genesisRoot,
            SLOTS_PER_PERIOD,
            INITIAL_SLOT,
            INITIAL_HEADER_ROOT,
            COMMITTEE_100,
            nextCommittee,
            SLOTS_PER_HISTORICAL_ROOT
        );
    }

    // ---------------------------------------------------------------- deposits

    /// @notice Mints, approves, and deposits on `vault` as `user`. Returns the nonce and the amount in the event.
    function _deposit(BridgeVault vault, address token, address user, address recipient, uint256 amount)
        internal
        returns (bytes32 nonce, uint256 eventAmount)
    {
        IMintableToken(token).mint(user, amount);
        vm.recordLogs();
        vm.startPrank(user);
        IMintableToken(token).approve(address(vault), amount);
        vault.deposit(token, recipient, amount);
        vm.stopPrank();
        Vm.Log[] memory logs = vm.getRecordedLogs();
        for (uint256 i = 0; i < logs.length; i++) {
            if (logs[i].emitter == address(vault) && logs[i].topics[0] == vault.DEPOSIT_EVENT_TOPIC()) {
                (eventAmount, nonce,) = abi.decode(logs[i].data, (uint256, bytes32, uint64));
            }
        }
    }

    /// @notice Deposit on chain A.
    function _depositOnA(address user, address recipient, uint256 amount) internal returns (bytes32, uint256) {
        vm.chainId(CHAIN_A);
        return _deposit(vaultA, address(tokenOnA), user, recipient, amount);
    }

    /// @notice Deposit on chain B.
    function _depositOnB(address user, address recipient, uint256 amount) internal returns (bytes32, uint256) {
        vm.chainId(CHAIN_B);
        return _deposit(vaultB, address(tokenOnB), user, recipient, amount);
    }
}
