// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";

/// @notice ABI checks: the contracts have no owner, no upgrade path, and no setter. The scans read the compiled output
/// in `out/`.
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

    /// @dev Compares the names as sets, because an ABI lists an overloaded function once for each overload.
    function _assertSameNames(string[] memory names, string[] memory allowed) internal pure {
        for (uint256 i = 0; i < names.length; i++) {
            assertTrue(_contains(allowed, names[i]), string.concat("unexpected state-changing function ", names[i]));
        }
        for (uint256 i = 0; i < allowed.length; i++) {
            assertTrue(_contains(names, allowed[i]), string.concat("missing state-changing function ", allowed[i]));
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

    /// Claim: the message bridge has no owner, upgrade path, pause, or setter for the light client, the gate, or anything
    /// else. Shows: the ABI lists exactly seven state-changing functions: the two send functions
    /// (`requireToPassMessage`, `requireToConfirmMessage`), `executeMessage`, `openDeposits` and the three open layout
    /// functions (`addBlockRootsLayout`, `addHistoricalSummariesLayout`, `addBlockHashLayout`), which only add
    /// positions that stored light-client data proves. `openDeposits` only sets a one-way flag, and only when a proof of
    /// the remote light client storage checks out. Matters: H-04 (no key can redirect the bridge or change a delivery).
    function test_H04_messageBridge_onlySendDeliverAndLayoutFunctionsChangeState() public view {
        string[] memory allowed = new string[](7);
        allowed[0] = "requireToPassMessage";
        allowed[1] = "requireToConfirmMessage";
        allowed[2] = "executeMessage";
        allowed[3] = "openDeposits";
        allowed[4] = "addBlockRootsLayout";
        allowed[5] = "addHistoricalSummariesLayout";
        allowed[6] = "addBlockHashLayout";
        _assertSameNames(_mutatingFunctions("out/MessageBridge.sol/MessageBridge.json"), allowed);
    }

    /// Claim: the token mediator has no owner, upgrade path, pause, or setter for the bridge, the remote mediator or the
    /// factory. Shows: the ABI lists exactly these state-changing functions: the relay functions (`relayTokens`,
    /// `relayTokensAndCall`, `relayTokensWithFallback`, `relayTokensWithOptions`), the ERC-677 entry `onTokenTransfer`, the twelve handlers
    /// that only the message bridge may call for the remote mediator, `claim` and
    /// `detachFlowLimiter`. The mediator has no fee and no function that pays an account that a release does not
    /// name. Only the flow limiter can call `detachFlowLimiter`, and no function sets or replaces a limiter. Matters:
    /// H-04 (no key can redirect the mediator or reach the tokens that it holds).
    function test_H04_tokenMediator_onlyRelayHandlerAndClaimFunctionsChangeState() public view {
        string[] memory allowed = new string[](19);
        allowed[0] = "relayTokens";
        allowed[1] = "relayTokensAndCall";
        allowed[2] = "relayTokensWithFallback";
        allowed[3] = "onTokenTransfer";
        allowed[4] = "handleNativeTokens";
        allowed[5] = "handleNativeTokensAndCall";
        allowed[6] = "handleNativeTokensWithFallback";
        allowed[7] = "handleNativeTokensAndCallWithFallback";
        allowed[8] = "handleBridgedTokens";
        allowed[9] = "handleBridgedTokensAndCall";
        allowed[10] = "handleBridgedTokensWithFallback";
        allowed[11] = "handleBridgedTokensAndCallWithFallback";
        allowed[12] = "deployAndHandleBridgedTokens";
        allowed[13] = "deployAndHandleBridgedTokensAndCall";
        allowed[14] = "deployAndHandleBridgedTokensWithFallback";
        allowed[15] = "deployAndHandleBridgedTokensAndCallWithFallback";
        allowed[16] = "claim";
        allowed[17] = "detachFlowLimiter";
        allowed[18] = "relayTokensWithOptions";
        _assertSameNames(_mutatingFunctions("out/TokenMediator.sol/TokenMediator.json"), allowed);
    }

    /// Claim: a bridged token has no owner, upgrade path, or setter, and only its mediator can mint or burn. Shows: the
    /// ABI lists exactly the ERC-20 functions that move or approve tokens (`transfer`, `transferFrom`, `approve`,
    /// `increaseAllowance`, `decreaseAllowance`), `permit`, `transferAndCall`, and the two functions `mint` and `burn`
    /// that the mediator guards. Matters: H-04 (no function renames the token, changes its supply for a third party,
    /// or changes the mediator).
    function test_H04_bridgedToken_onlyTransferApprovalAndMediatorFunctionsChangeState() public view {
        string[] memory allowed = new string[](9);
        allowed[0] = "transfer";
        allowed[1] = "transferFrom";
        allowed[2] = "approve";
        allowed[3] = "increaseAllowance";
        allowed[4] = "decreaseAllowance";
        allowed[5] = "permit";
        allowed[6] = "transferAndCall";
        allowed[7] = "mint";
        allowed[8] = "burn";
        _assertSameNames(_mutatingFunctions("out/BridgedToken.sol/BridgedToken.json"), allowed);
    }

    /// Claim: the token factory has one state-changing function and no owner. Shows: the ABI lists exactly `deploy`,
    /// which only the mediator may call. Matters: H-04 (the factory deploys a copy at an address that the home chain
    /// and the native token fix, and nobody can change which mediator it serves).
    function test_H04_tokenFactory_onlyDeployChangesState() public view {
        string[] memory allowed = new string[](1);
        allowed[0] = "deploy";
        _assertSameNames(_mutatingFunctions("out/TokenFactory.sol/TokenFactory.json"), allowed);
    }

    /// Claim: neither the message bridge nor the token mediator has a refund or a reclaim function. Shows: no function
    /// name in either ABI, in any case, contains "refund" or "reclaim". Matters: H-09. A failed delivery stays failed
    /// and a failed release goes to its fallback address or to `claim`, so no key and no caller can take tokens back
    /// from a sender on a path of its own.
    function test_H09_messageBridgeAndMediatorHaveNoRefundFunction() public view {
        string[2] memory artifacts =
            ["out/MessageBridge.sol/MessageBridge.json", "out/TokenMediator.sol/TokenMediator.json"];
        string[2] memory banned = ["refund", "reclaim"];
        for (uint256 i = 0; i < artifacts.length; i++) {
            string[] memory names = _names(artifacts[i], '$.abi[?(@.type=="function")].name');
            assertGt(names.length, 5, "the scan reads the ABI");
            for (uint256 j = 0; j < names.length; j++) {
                for (uint256 k = 0; k < banned.length; k++) {
                    assertFalse(_hasSubstring(vm.toLowercase(names[j]), banned[k]), names[j]);
                }
            }
        }
    }

    /// Claim: the substring scan finds a name. Shows: it finds "refund" in `refundDeposit` and "reclaim" in `Reclaim`
    /// after lower casing, and finds nothing in `claim`. Matters: a scan that finds nothing would pass a refund
    /// function (control for the test above).
    function test_H09_substringScanControl() public pure {
        assertTrue(_hasSubstring(vm.toLowercase("refundDeposit"), "refund"));
        assertTrue(_hasSubstring(vm.toLowercase("Reclaim"), "reclaim"));
        assertFalse(_hasSubstring(vm.toLowercase("claim"), "reclaim"));
        assertFalse(_hasSubstring("re", "refund"));
    }

    function _hasSubstring(string memory text, string memory part) internal pure returns (bool) {
        bytes memory haystack = bytes(text);
        bytes memory needle = bytes(part);
        if (needle.length > haystack.length) return false;
        for (uint256 i = 0; i + needle.length <= haystack.length; i++) {
            bool matched = true;
            for (uint256 j = 0; j < needle.length && matched; j++) {
                matched = haystack[i + j] == needle[j];
            }
            if (matched) return true;
        }
        return false;
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
        string[7] memory artifacts = [
            "out/BeaconLightClient.sol/BeaconLightClient.json",
            "out/MessageBridge.sol/MessageBridge.json",
            "out/BeaconForkGate.sol/BeaconForkGate.json",
            "out/TokenMediator.sol/TokenMediator.json",
            "out/BridgedToken.sol/BridgedToken.json",
            "out/TokenFactory.sol/TokenFactory.json",
            "out/DeliveryRouter.sol/DeliveryRouter.json"
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
