// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Script} from "forge-std/Script.sol";
import {DeliveryRouter} from "../../src/hardened/mediator/DeliveryRouter.sol";
import {RouterCaller} from "../../src/hardened/mediator/RouterCaller.sol";

/// @title LinkedCode
/// @notice Deploys the external libraries of the message bridge and the token mediator, and deploys the bridge and the
/// mediator with their library addresses linked in, from the deployer's own nonces.
/// @dev Why the split: the per-transaction gas cap of EIP-7825 (16,777,216). Sepolia charged about 1,580 gas per byte
/// of runtime code for a creation on 2026-10-26, so one creation fits only up to about 10,000 bytes. The bridge uses
/// `ReceiptProofLib`, `OpeningProofLib` and `BeaconLayoutLib`; the mediator uses `MediatorPayloads`. Each is deployed by
/// a transaction of its own.
///
/// Why by hand: a script that names `new MessageBridge(...)` makes Foundry link the libraries itself, which deploys them
/// from the sender at nonces that the script does not choose, and Foundry refuses library linking in a script that
/// deploys to two chains. So the scripts never name the creation code of the bridge or of the mediator: they read it from
/// the build output (`out/`), replace each library placeholder with the address of the library deployed just before,
/// refuse code with a placeholder left, and create it. After deployment, `requireLinked` checks every link site of the
/// runtime code against the library addresses, and `requireLibraryCode` checks the code of each library.
abstract contract LinkedCode is Script {
    /// @notice The addresses of the libraries on one chain.
    struct Libraries {
        address receiptProof;
        address openingProof;
        address beaconLayout;
        address mediatorPayloads;
    }

    /// @notice The fully qualified names of the libraries, as the compiler hashes them into the placeholders.
    string internal constant RECEIPT_PROOF_LIB = "src/hardened/ReceiptProofLib.sol:ReceiptProofLib";
    string internal constant OPENING_PROOF_LIB = "src/hardened/OpeningProofLib.sol:OpeningProofLib";
    string internal constant BEACON_LAYOUT_LIB = "src/hardened/BeaconLayoutLib.sol:BeaconLayoutLib";
    string internal constant MEDIATOR_PAYLOADS_LIB = "src/hardened/mediator/MediatorPayloads.sol:MediatorPayloads";

    /// @notice A creation returned the zero address.
    error CreationFailed(string name);
    /// @notice The creation code still holds a library placeholder after linking.
    error UnlinkedLibrary(string name);
    /// @notice A link site of a deployed contract does not hold the expected library address.
    error LinkMismatch(string name, string library_, uint256 offset);
    /// @notice The runtime code of a deployed contract differs from the build output (immutables aside).
    error BuiltCodeMismatch(string name, address account);
    /// @notice The code of a deployed library differs from the build output.
    error LibraryCodeMismatch(string name, address account);
    /// @notice The caller of a delivery router is not the contract that the router created first, or it names another
    /// router.
    error RouterCallerMismatch(address router, address caller);

    /// @notice Deploys a library from its creation code in the build output.
    /// @param name The library name, also the file name (`out/<name>.sol/<name>.json`).
    function deployLibrary(string memory name) internal returns (address) {
        return _create(vm.getCode(string.concat(name, ".sol:", name)), name);
    }

    /// @notice Deploys the message bridge, linked to the three bridge libraries, with `constructorArguments` appended.
    function deployLinkedBridge(Libraries memory libraries, bytes memory constructorArguments)
        internal
        returns (address)
    {
        return _create(
            bytes.concat(linkedCreationCode("MessageBridge", libraries), constructorArguments), "MessageBridge"
        );
    }

    /// @notice Deploys the token mediator, linked to `MediatorPayloads`, with `constructorArguments` appended.
    function deployLinkedMediator(Libraries memory libraries, bytes memory constructorArguments)
        internal
        returns (address)
    {
        return _create(
            bytes.concat(linkedCreationCode("TokenMediator", libraries), constructorArguments), "TokenMediator"
        );
    }

    /// @notice Deploys `name` from the creation code in the build output (`out/`), linked to `libraries` where it uses
    /// them, with `constructorArguments` appended. Every contract that `requireBuiltCode` checks is deployed this way, so
    /// the deployed code is the code of the build output, whatever profile compiled the script itself.
    function deployBuilt(string memory name, Libraries memory libraries, bytes memory constructorArguments)
        internal
        returns (address)
    {
        return _create(bytes.concat(linkedCreationCode(name, libraries), constructorArguments), name);
    }

    /// @notice The creation code of `name` from the build output, with every library placeholder replaced.
    function linkedCreationCode(string memory name, Libraries memory libraries) internal view returns (bytes memory) {
        string memory code = vm.parseJsonString(vm.readFile(_artifact(name)), ".bytecode.object");
        code = _link(code, RECEIPT_PROOF_LIB, libraries.receiptProof);
        code = _link(code, OPENING_PROOF_LIB, libraries.openingProof);
        code = _link(code, BEACON_LAYOUT_LIB, libraries.beaconLayout);
        code = _link(code, MEDIATOR_PAYLOADS_LIB, libraries.mediatorPayloads);
        if (vm.indexOf(code, "__$") != type(uint256).max) revert UnlinkedLibrary(name);
        return vm.parseBytes(code);
    }

    /// @notice Requires that every link site of the deployed runtime code of `name` at `account` holds the address of its
    /// library. A library that `name` does not use has no link site and is not read.
    function requireLinked(string memory name, address account, Libraries memory libraries) internal view {
        string memory json = vm.readFile(_artifact(name));
        bytes memory code = account.code;
        _requireLinkSites(json, code, name, RECEIPT_PROOF_LIB, libraries.receiptProof);
        _requireLinkSites(json, code, name, OPENING_PROOF_LIB, libraries.openingProof);
        _requireLinkSites(json, code, name, BEACON_LAYOUT_LIB, libraries.beaconLayout);
        _requireLinkSites(json, code, name, MEDIATOR_PAYLOADS_LIB, libraries.mediatorPayloads);
    }

    /// @notice Requires that the runtime code at `account` is the runtime code of `name` in the build output, linked to
    /// `libraries`, except for its immutables (the constructor writes them; the build output holds zeros there). With
    /// this check a deployed contract is the compiled contract, byte for byte, apart from the values that the read-back
    /// checks one by one.
    function requireBuiltCode(string memory name, address account, Libraries memory libraries) internal view {
        string memory json = vm.readFile(_artifact(name));
        string memory code = vm.parseJsonString(json, ".deployedBytecode.object");
        code = _link(code, RECEIPT_PROOF_LIB, libraries.receiptProof);
        code = _link(code, OPENING_PROOF_LIB, libraries.openingProof);
        code = _link(code, BEACON_LAYOUT_LIB, libraries.beaconLayout);
        code = _link(code, MEDIATOR_PAYLOADS_LIB, libraries.mediatorPayloads);
        if (vm.indexOf(code, "__$") != type(uint256).max) revert UnlinkedLibrary(name);
        bytes memory expected = vm.parseBytes(code);
        bytes memory actual = account.code;
        if (expected.length != actual.length) revert BuiltCodeMismatch(name, account);
        string[] memory ids = vm.parseJsonKeys(json, ".deployedBytecode.immutableReferences");
        for (uint256 i = 0; i < ids.length; i++) {
            string memory key = string.concat(".deployedBytecode.immutableReferences.", ids[i]);
            for (uint256 j = 0;; j++) {
                string memory site = string.concat(key, "[", vm.toString(j), "]");
                if (!vm.keyExistsJson(json, site)) break;
                uint256 start = vm.parseJsonUint(json, string.concat(site, ".start"));
                uint256 length = vm.parseJsonUint(json, string.concat(site, ".length"));
                for (uint256 k = start; k < start + length && k < actual.length; k++) {
                    actual[k] = 0;
                }
            }
        }
        if (keccak256(actual) != keccak256(expected)) revert BuiltCodeMismatch(name, account);
    }

    /// @notice Requires that the caller of the delivery router at `router` (`routerCaller`, which makes the call after a
    /// delivery) is the contract that the router created in its constructor: the first creation of the router (its
    /// nonce 1), naming the router back, with the runtime code of `RouterCaller` in the build output. The router creates
    /// it in the same transaction, so the deployer's nonces do not change.
    function requireRouterCaller(address router) internal view {
        address caller = address(DeliveryRouter(payable(router)).routerCaller());
        if (caller != vm.computeCreateAddress(router, 1)) revert RouterCallerMismatch(router, caller);
        Libraries memory none;
        requireBuiltCode("RouterCaller", caller, none);
        if (RouterCaller(caller).router() != router) revert RouterCallerMismatch(router, caller);
    }

    /// @notice Requires that the code at `account` is the runtime code of the library `name` in the build output. A
    /// library's runtime code starts with `PUSH20 <its own address>` (the call guard), which the build output holds as
    /// zeros, so that word is compared with the account itself.
    function requireLibraryCode(string memory name, address account) internal view {
        bytes memory expected = vm.getDeployedCode(string.concat(name, ".sol:", name));
        bytes memory actual = account.code;
        if (expected.length != actual.length || expected.length < 21 || actual[0] != 0x73) {
            revert LibraryCodeMismatch(name, account);
        }
        address guard;
        assembly ("memory-safe") {
            guard := shr(96, mload(add(actual, 33)))
        }
        if (guard != account) revert LibraryCodeMismatch(name, account);
        for (uint256 i = 1; i < 21; i++) {
            actual[i] = 0;
        }
        if (keccak256(actual) != keccak256(expected)) revert LibraryCodeMismatch(name, account);
    }

    /// @notice The placeholder of a library in unlinked code: `__$` and the first 34 hex digits of the keccak256 of the
    /// fully qualified name, then `$__`.
    function placeholderOf(string memory fullyQualifiedName) internal pure returns (string memory) {
        string memory digits = vm.toString(keccak256(bytes(fullyQualifiedName)));
        return string.concat("__$", _substring(digits, 2, 36), "$__");
    }

    function _link(string memory code, string memory fullyQualifiedName, address library_)
        private
        view
        returns (string memory)
    {
        string memory placeholder = placeholderOf(fullyQualifiedName);
        if (vm.indexOf(code, placeholder) == type(uint256).max) return code;
        if (library_ == address(0) || library_.code.length == 0) revert UnlinkedLibrary(fullyQualifiedName);
        string memory hexAddress = _substring(vm.toLowercase(vm.toString(library_)), 2, 42);
        return vm.replace(code, placeholder, hexAddress);
    }

    function _requireLinkSites(
        string memory json,
        bytes memory code,
        string memory name,
        string memory fullyQualifiedName,
        address library_
    ) private view {
        string[] memory parts = vm.split(fullyQualifiedName, ":");
        string memory key = string.concat(".deployedBytecode.linkReferences['", parts[0], "'].", parts[1]);
        // A library whose placeholder is in the unlinked runtime code must have link sites: the check never passes empty.
        bool used = vm.indexOf(vm.parseJsonString(json, ".deployedBytecode.object"), placeholderOf(fullyQualifiedName))
            != type(uint256).max;
        if (!vm.keyExistsJson(json, key)) {
            if (used) revert LinkMismatch(name, fullyQualifiedName, 0);
            return;
        }
        // One entry per link site. A single entry reads back as a number with `[*]`, so the sites are read one by one.
        for (uint256 i = 0;; i++) {
            string memory site = string.concat(key, "[", vm.toString(i), "].start");
            if (!vm.keyExistsJson(json, site)) break;
            uint256 start = vm.parseJsonUint(json, site);
            address linked;
            if (start + 20 <= code.length) {
                assembly ("memory-safe") {
                    linked := shr(96, mload(add(add(code, 32), start)))
                }
            }
            if (linked != library_) revert LinkMismatch(name, fullyQualifiedName, start);
        }
    }

    function _create(bytes memory code, string memory name) private returns (address deployed) {
        assembly ("memory-safe") {
            deployed := create(0, add(code, 32), mload(code))
        }
        if (deployed == address(0)) revert CreationFailed(name);
    }

    function _artifact(string memory name) private view returns (string memory) {
        return string.concat(vm.projectRoot(), "/out/", name, ".sol/", name, ".json");
    }

    function _substring(string memory text, uint256 from, uint256 to) private pure returns (string memory) {
        bytes memory raw = bytes(text);
        bytes memory out = new bytes(to - from);
        for (uint256 i = from; i < to; i++) {
            out[i - from] = raw[i];
        }
        return string(out);
    }
}
