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

/// @notice The generator of G1 on BLS12-381 in the EIP-2537 encoding (two 64 byte field elements, 16 leading zero
/// bytes each). The gate sends it with the point at infinity to `BLS12_G1ADD` and expects it back.
library GateBlsPoints {
    bytes32 internal constant X_HIGH = 0x0000000000000000000000000000000017f1d3a73197d7942695638c4fa9ac0f;
    bytes32 internal constant X_LOW = 0xc3688c4f9774b905a14e3a3f171bac586c55e83ff97a1aeffb3af00adb22c6bb;
    bytes32 internal constant Y_HIGH = 0x0000000000000000000000000000000008b3f481e3aaa0f1a09e30ed741d8ae4;
    bytes32 internal constant Y_LOW = 0xfcf5e095d5d00af600db18cb2c04b3edd03cc744a2888ae40caa232946c5e7e1;

    /// @notice The 128 byte encoding of the generator.
    function generator() internal pure returns (bytes memory) {
        return abi.encodePacked(X_HIGH, X_LOW, Y_HIGH, Y_LOW);
    }
}

/// @notice A stand-in for the `BLS12_G1ADD` precompile (EIP-2537, address 0x0b) that only understands the one input the
/// gate sends (generator plus infinity) and returns the generator. Any other input reverts.
contract GateBlsG1AddMock {
    fallback(bytes calldata data) external returns (bytes memory) {
        require(data.length == 256, "bad length");
        require(keccak256(data) == keccak256(abi.encodePacked(GateBlsPoints.generator(), new bytes(128))), "bad input");
        return GateBlsPoints.generator();
    }
}

/// @notice A `BLS12_G1ADD` stand-in that answers with the right length and the wrong bytes (all zero).
contract GateBlsWrongOutputMock {
    fallback() external {
        assembly {
            return(0, 128)
        }
    }
}

/// @notice A `BLS12_G1ADD` stand-in that answers with the right first 64 bytes only.
contract GateBlsShortOutputMock {
    fallback() external {
        bytes memory point = GateBlsPoints.generator();
        assembly {
            return(add(point, 0x20), 64)
        }
    }
}

/// @notice Runtime bytes for etching over the opcode probe.
library GateProbeCodes {
    /// @notice A probe that works for every selector: returns the word 1 (`PUSH1 1 PUSH0 MSTORE PUSH1 0x20 PUSH0 RETURN`).
    function succeeds() internal pure returns (bytes memory) {
        return hex"60015f5260205ff3";
    }

    /// @notice A probe that works for one selector only: it returns the word 1 when the first calldata byte equals
    /// `selector`, and reverts for every other byte and for empty calldata. It stands in for a chain that has the
    /// opcode of that one path and lacks the others.
    /// @dev `PUSH0 CALLDATALOAD PUSH1 0xf8 SHR PUSH1 selector EQ PUSH1 0x0e JUMPI PUSH0 PUSH0 REVERT JUMPDEST`, then
    /// the return of the word 1.
    function succeedsOnlyForSelector(uint8 selector) internal pure returns (bytes memory) {
        return abi.encodePacked(hex"5f3560f81c60", selector, hex"1460", hex"0e575f5ffd5b60015f5260205ff3");
    }

    /// @notice A probe that works for every selector from `first` upward and reverts below it. It stands in for a
    /// chain that has the later opcodes but not the earlier ones.
    /// @dev `PUSH0 CALLDATALOAD PUSH1 0xf8 SHR PUSH1 first GT ISZERO PUSH1 0x0f JUMPI PUSH0 PUSH0 REVERT JUMPDEST`, then
    /// the return of the word 1.
    function succeedsFromSelector(uint8 first) internal pure returns (bytes memory) {
        return abi.encodePacked(hex"5f3560f81c60", first, hex"1115600f575f5ffd5b60015f5260205ff3");
    }

    /// @notice A probe that burns all the gas it gets: `JUMPDEST PUSH0 JUMP` loops forever.
    function burnsAllGas() internal pure returns (bytes memory) {
        return hex"5b5f56";
    }

    /// @notice A probe that succeeds and returns the wrong word (2).
    function returnsWrongWord() internal pure returns (bytes memory) {
        return hex"60025f5260205ff3";
    }

    /// @notice A stand-in for the `BLS12_G1ADD` precompile in raw code. It returns the generator for any call with 256
    /// bytes of input and reverts for any other length. It costs about 100 gas, so it fits the gas that the gate gives
    /// the precompile even in a build with no optimizer, where `GateBlsG1AddMock` costs more.
    /// @dev `CALLDATASIZE PUSH2 0x0100 EQ PUSH1 0x0b JUMPI PUSH0 PUSH0 REVERT JUMPDEST`, then
    /// `PUSH1 0x80 PUSH1 0x16 PUSH0 CODECOPY PUSH1 0x80 PUSH0 RETURN`, then the 128 bytes of the generator.
    function blsG1AddAnswersTheGenerator() internal pure returns (bytes memory) {
        return abi.encodePacked(
            hex"3661010014600b575f5ffd5b", hex"60806016", hex"5f39", hex"60805ff3", GateBlsPoints.generator()
        );
    }

    /// @notice A probe that succeeds and returns nothing.
    function returnsNothing() internal pure returns (bytes memory) {
        return hex"00";
    }
}
