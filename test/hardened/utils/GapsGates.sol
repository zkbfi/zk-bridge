// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IDepositGate} from "../../../src/hardened/IDepositGate.sol";

/// @notice A gate that records who called it and with which evidence, on every call. `MessageGate` counts calls only.
/// A test uses it to show what a bridge hands to its gate.
contract GapsRecordingGate is IDepositGate {
    /// @notice One call of `admit`.
    struct Admission {
        address caller;
        bytes evidence;
    }

    Admission[] private _admissions;

    /// @notice The number of calls so far.
    function admissionCount() external view returns (uint256) {
        return _admissions.length;
    }

    /// @notice The call at `index`.
    function admissionAt(uint256 index) external view returns (Admission memory) {
        return _admissions[index];
    }

    /// @inheritdoc IDepositGate
    function admit(bytes calldata evidence) external override {
        _admissions.push(Admission({caller: msg.sender, evidence: evidence}));
    }
}
