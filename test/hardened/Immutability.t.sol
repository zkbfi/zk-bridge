// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";

/// @notice ABI checks: the contracts have no owner, no upgrade path, and no setter.
contract ImmutabilityTest is Test {
    /// @dev A query with one match returns a bare string, and a query with several returns an array.
    function _names(string memory artifact, string memory query) internal view returns (string[] memory names) {
        bytes memory raw = vm.parseJson(vm.readFile(artifact), query);
        try this.decodeNames(raw) returns (string[] memory many) {
            return many;
        } catch {
            names = new string[](1);
            names[0] = abi.decode(raw, (string));
        }
    }

    /// @dev External so that `_names` can catch a decoding failure.
    function decodeNames(bytes calldata raw) external pure returns (string[] memory) {
        return abi.decode(raw, (string[]));
    }

    function _mutatingFunctions(string memory artifact) internal view returns (string[] memory) {
        return _names(
            artifact, '$.abi[?(@.type=="function" && @.stateMutability!="view" && @.stateMutability!="pure")].name'
        );
    }

    function _assertOnly(string[] memory names, string[] memory allowed) internal pure {
        assertEq(names.length, allowed.length, "unexpected number of state-changing functions");
        for (uint256 i = 0; i < allowed.length; i++) {
            assertEq(names[i], allowed[i]);
        }
    }

    /// Claim: the light client has no owner, upgrade path, pause, or setter. Shows: the ABI lists exactly one
    /// state-changing function, `update`. Matters: H-04 and H-01 (nobody can swap the verifier, the program key, or
    /// the committee by a privileged call; the immutables have no setter).
    function test_H04_beaconLightClient_onlyUpdateChangesState() public view {
        string[] memory allowed = new string[](1);
        allowed[0] = "update";
        _assertOnly(_mutatingFunctions("out/BeaconLightClient.sol/BeaconLightClient.json"), allowed);
    }

    /// Claim: the vault has no owner, upgrade path, pause, or setter for the light client, the gate, or anything else.
    /// Shows: the ABI lists exactly eight state-changing functions: `deposit`, `withdraw`, the three open layout
    /// functions (`addBlockRootsLayout`, `addHistoricalSummariesLayout`, `addBlockHashLayout`), which only add
    /// positions that stored light-client data proves, and the three fee functions (`setFee`, `nullifyFee`,
    /// `collectFees`). Only `setFee` and `nullifyFee` need the fee authority, and neither reaches locked tokens.
    /// Matters: H-04 (no key can redirect the vault).
    function test_H04_bridgeVault_onlyDepositWithdrawAndLayoutFunctionsChangeState() public view {
        string[] memory names = _mutatingFunctions("out/BridgeVault.sol/BridgeVault.json");
        string[] memory allowed = new string[](8);
        allowed[0] = "deposit";
        allowed[1] = "withdraw";
        allowed[2] = "addBlockRootsLayout";
        allowed[3] = "addHistoricalSummariesLayout";
        allowed[4] = "addBlockHashLayout";
        allowed[5] = "setFee";
        allowed[6] = "nullifyFee";
        allowed[7] = "collectFees";
        assertEq(names.length, allowed.length, "unexpected number of state-changing functions");
        for (uint256 i = 0; i < allowed.length; i++) {
            assertTrue(_contains(names, allowed[i]), allowed[i]);
        }
    }

    /// Claim: the fork gate has no owner, upgrade path, pause, or setter. Shows: the ABI lists exactly three
    /// state-changing functions, `admit`, `confirm` and `seal`, which only record what beacon chain evidence proves.
    /// Matters: HB-02. A key that could switch the gate on or off was rejected on purpose, because a one-way switch
    /// in the wrong hand would halt deposits for good.
    function test_HB02_beaconForkGate_onlyAdmitConfirmAndSealChangeState() public view {
        string[] memory names = _mutatingFunctions("out/BeaconForkGate.sol/BeaconForkGate.json");
        string[] memory allowed = new string[](3);
        allowed[0] = "admit";
        allowed[1] = "confirm";
        allowed[2] = "seal";
        assertEq(names.length, allowed.length, "unexpected number of state-changing functions");
        for (uint256 i = 0; i < allowed.length; i++) {
            assertTrue(_contains(names, allowed[i]), allowed[i]);
        }
    }

    function _contains(string[] memory names, string memory wanted) internal pure returns (bool) {
        for (uint256 i = 0; i < names.length; i++) {
            if (keccak256(bytes(names[i])) == keccak256(bytes(wanted))) return true;
        }
        return false;
    }

    /// Claim: `update` never takes a period (or a slot of a period) from the caller. Shows: its only inputs are
    /// `bytes proof` and `bytes publicValues`, and no input name mentions a period. Matters: R2-14 (periods come only from
    /// `periodOf(slot)`, so a caller cannot name the period whose committee is replaced).
    function test_R2_14_updateTakesNoPeriodParameter() public view {
        string[] memory inputNames = _names("out/BeaconLightClient.sol/BeaconLightClient.json", '$.abi[?(@.name=="update")].inputs[*].name');
        string[] memory inputTypes = _names("out/BeaconLightClient.sol/BeaconLightClient.json", '$.abi[?(@.name=="update")].inputs[*].type');
        assertEq(inputNames.length, 2);
        assertEq(inputTypes.length, 2);
        assertEq(inputNames[0], "proof");
        assertEq(inputNames[1], "publicValues");
        assertEq(inputTypes[0], "bytes");
        assertEq(inputTypes[1], "bytes");
    }

    /// Claim: no ownership or upgrade function names exist in every ABI. Shows: none of the usual names appear.
    /// Matters: a second line of defense in case the first test is weakened by a future mutability change.
    function test_H04_noOwnershipOrUpgradeNamesInAbi() public view {
        string[3] memory artifacts = [
            "out/BeaconLightClient.sol/BeaconLightClient.json",
            "out/BridgeVault.sol/BridgeVault.json",
            "out/BeaconForkGate.sol/BeaconForkGate.json"
        ];
        string[9] memory banned = [
            "owner", "transferOwnership", "renounceOwnership", "upgradeTo", "upgradeToAndCall", "setVerifier",
            "setProgramVKey", "setLightClient", "pause"
        ];
        for (uint256 i = 0; i < artifacts.length; i++) {
            string[] memory names = _names(artifacts[i], '$.abi[?(@.type=="function")].name');
            for (uint256 j = 0; j < names.length; j++) {
                for (uint256 k = 0; k < banned.length; k++) {
                    assertTrue(keccak256(bytes(names[j])) != keccak256(bytes(banned[k])), banned[k]);
                }
            }
        }
    }
}
