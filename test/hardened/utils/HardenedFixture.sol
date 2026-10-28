// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {BeaconLightClient} from "../../../src/hardened/BeaconLightClient.sol";
import {BeaconForkGate} from "../../../src/hardened/BeaconForkGate.sol";
import {OracleSP1Verifier} from "../../../src/mocks/OracleSP1Verifier.sol";
import {HardenedProofs} from "./HardenedProofs.sol";

/// @title HardenedFixture
/// @notice The parts that every hardened test shares. One Foundry chain plays both roles, and the test switches
/// `block.chainid` with `vm.chainId` before it calls a contract that reads the chain identifier. `lightClientForB`
/// tracks the beacon chain of chain A (chain identifier 1) and feeds the contracts on chain B (identifier 369).
/// `lightClientForA` tracks chain B and feeds the contracts on chain A.
abstract contract HardenedFixture is HardenedProofs {
    address internal alice = makeAddr("alice");
    address internal bob = makeAddr("bob");
    address internal attacker = makeAddr("attacker");
    address internal oracle;

    OracleSP1Verifier internal verifier;
    BeaconLightClient internal lightClientForA;
    BeaconLightClient internal lightClientForB;
    /// @dev Gates in detection mode. No beacon roots contract exists in the unit tests, so they admit every deposit.
    BeaconForkGate internal gateA;
    BeaconForkGate internal gateB;

    /// @notice The EIP-4788 address.
    address internal constant BEACON_ROOTS = 0x000F3df6D732807Ef1319fB7B8bB8522d0Beac02;
    /// @notice The `capellaEra` of the vaults in the unit tests: the synthetic source chain activated Capella at slot 0.
    uint64 internal constant DEFAULT_CAPELLA_ERA = 0;

    function setUp() public virtual {
        vm.warp(FIXTURE_START_TIME);
        oracle = vm.addr(ORACLE_KEY);
        verifier = new OracleSP1Verifier(oracle);
        lightClientForA = _newLightClient(GENESIS_ROOT_B, COMMITTEE_101);
        lightClientForB = _newLightClient(GENESIS_ROOT_A, COMMITTEE_101);
        gateA = _newGate(BeaconForkGate.GateMode.DetectBeaconRoots);
        gateB = _newGate(BeaconForkGate.GateMode.DetectBeaconRoots, GENESIS_ROOT_B);
    }

    /// @notice A fresh light client at the standard checkpoint for the given chain.
    function _newLightClient(bytes32 genesisRoot, bytes32 nextCommittee) internal returns (BeaconLightClient) {
        return new BeaconLightClient(
            address(verifier),
            LIGHT_CLIENT_VKEY,
            genesisRoot,
            SLOTS_PER_PERIOD,
            LIGHT_CLIENT_GENESIS_TIME,
            LIGHT_CLIENT_SECONDS_PER_SLOT,
            INITIAL_SLOT,
            INITIAL_HEADER_ROOT,
            COMMITTEE_100,
            nextCommittee
        );
    }

    /// @notice A gate with Ethereum timing in the given mode. It follows the beacon chain of chain A (`GENESIS_ROOT_A`).
    function _newGate(BeaconForkGate.GateMode mode) internal returns (BeaconForkGate) {
        return _newGate(mode, GENESIS_ROOT_A);
    }

    /// @notice A gate with Ethereum timing in the given mode that follows the beacon chain with `genesisValidatorsRoot`.
    function _newGate(BeaconForkGate.GateMode mode, bytes32 genesisValidatorsRoot) internal returns (BeaconForkGate) {
        return new BeaconForkGate(BEACON_ROOTS, mode, 1_606_824_023, 12, 32, genesisValidatorsRoot, address(0));
    }
}
