// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IDepositGate} from "../../../src/hardened/IDepositGate.sol";

/// @title GateGenuineBeaconRoots
/// @notice The runtime bytecode of the beacon roots contract, exactly as the standard publishes it.
/// @dev Source: EIP-4788, https://eips.ethereum.org/EIPS/eip-4788, section "Deployment". The standard lists the
/// creation code in the "input" field of its keyless deployment transaction:
/// `0x60618060095f395ff3` followed by the runtime code. The prefix is a nine byte constructor that copies the next
/// 0x61 (97) bytes. This file holds the 97 runtime bytes, cut from that field without change (the text was fetched with
/// a download, not typed). The system address is 0xfffffffffffffffffffffffffffffffffffffffe. The ring buffer length
/// is 8191.
library GateGenuineBeaconRoots {
    /// @notice keccak256 of the runtime code, recorded once. A test asserts it, so a changed byte fails loudly.
    bytes32 internal constant RECORDED_HASH = 0xf57acd40259872606d76197ef052f3d35588dadf919ee1f0e3cb9b62d3f4b02c;
    /// @notice The address that writes roots in the real protocol.
    address internal constant SYSTEM_ADDRESS = 0xffffFFFfFFffffffffffffffFfFFFfffFFFfFFfE;
    /// @notice The length of the ring buffer of the standard.
    uint256 internal constant HISTORY_BUFFER_LENGTH = 8191;

    /// @notice The runtime code.
    function code() internal pure returns (bytes memory) {
        return
        hex"3373fffffffffffffffffffffffffffffffffffffffe14604d57602036146024575f5ffd5b5f35801560495762001fff810690815414603c575f5ffd5b62001fff01545f5260205ff35b5f5ffd5b62001fff42064281555f359062001fff015500";
    }
}

/// @title GateBeaconRootsMock
/// @notice A model of the beacon roots contract with the same ring buffer: slot is `timestamp % 8191`, the slot holds
/// the timestamp and the root, and a read reverts when the stored timestamp differs from the one asked for.
/// @dev Etch the runtime code of an instance at the beacon roots address, then call `plant` through that address.
contract GateBeaconRootsMock {
    uint256 internal constant RING = 8191;
    uint256[8191] internal timestamps;
    bytes32[8191] internal roots;

    /// @notice Writes a root for a timestamp, like the system call of the protocol.
    function plant(uint256 timestamp, bytes32 root) external {
        timestamps[timestamp % RING] = timestamp;
        roots[timestamp % RING] = root;
    }

    /// @notice A read: the calldata is exactly the 32 byte timestamp.
    fallback(bytes calldata data) external returns (bytes memory) {
        require(data.length == 32, "bad length");
        uint256 timestamp = abi.decode(data, (uint256));
        require(timestamp != 0, "zero timestamp");
        require(timestamps[timestamp % RING] == timestamp, "timestamp not in ring");
        return abi.encode(roots[timestamp % RING]);
    }
}

/// @notice Answers every call with 32 zero bytes.
contract GateAnswersZero {
    fallback() external {
        assembly {
            mstore(0, 0)
            return(0, 32)
        }
    }
}

/// @notice Answers every call with 31 non-zero bytes (one byte short of a word).
contract GateAnswersShort {
    fallback() external {
        assembly {
            mstore(0, not(0))
            return(0, 31)
        }
    }
}

/// @notice Answers every call with 64 bytes, the first word non-zero.
contract GateAnswersLong {
    fallback() external {
        assembly {
            mstore(0, not(0))
            mstore(32, not(0))
            return(0, 64)
        }
    }
}

/// @notice Answers every call with three bytes of garbage.
contract GateAnswersGarbage {
    fallback() external {
        assembly {
            mstore(0, 0xdeadbe0000000000000000000000000000000000000000000000000000000000)
            return(0, 3)
        }
    }
}

/// @notice Reverts on every call.
contract GateAlwaysReverts {
    fallback() external {
        revert("no");
    }
}

/// @notice A gate that admits everything, to measure a deposit without a real gate.
contract GateAlwaysAdmits is IDepositGate {
    function admit(bytes calldata) external pure override {}
}
