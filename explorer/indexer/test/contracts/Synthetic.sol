// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

// Test doubles for the integration test of the explorer indexer. They emit the same events as the real contracts
// (same names, same argument types, same indexed flags) at the call of anyone, so that the test can drive the
// delivered side of the bridge without a prover. They hold no security logic and are never deployed anywhere else.

/// @dev A bridge that emits the events of MessageBridge.
contract SyntheticBridge {
    event UserRequestForAffirmation(bytes32 indexed messageId, bytes encodedData);
    event AffirmationCompleted(address indexed sender, address indexed executor, bytes32 indexed messageId, bool status);
    event DepositsOpened(uint64 indexed remoteSlot, bytes32 indexed remoteBlockHash, uint64 storedSlot);

    function send(bytes32 messageId, bytes calldata encodedData) external {
        emit UserRequestForAffirmation(messageId, encodedData);
    }

    function complete(address sender, address executor, bytes32 messageId, bool status) external {
        emit AffirmationCompleted(sender, executor, messageId, status);
    }

    function open(uint64 remoteSlot, bytes32 remoteBlockHash, uint64 storedSlot) external {
        emit DepositsOpened(remoteSlot, remoteBlockHash, storedSlot);
    }
}

/// @dev A token with free mint and burn. It emits the ERC-20 Transfer event.
contract SyntheticToken {
    event Transfer(address indexed from, address indexed to, uint256 value);

    string public name;
    string public symbol;
    uint8 public decimals;
    uint256 public totalSupply;

    constructor(string memory name_, string memory symbol_, uint8 decimals_) {
        name = name_;
        symbol = symbol_;
        decimals = decimals_;
    }

    function mint(address to, uint256 value) external {
        totalSupply += value;
        emit Transfer(address(0), to, value);
    }

    function burn(address from, uint256 value) external {
        totalSupply -= value;
        emit Transfer(from, address(0), value);
    }

    function move(address from, address to, uint256 value) external {
        emit Transfer(from, to, value);
    }
}

/// @dev A mediator that emits the events of TokenMediator and answers the three views that the indexer reads.
contract SyntheticMediator {
    event TokensBridgingInitiated(address indexed token, address indexed sender, uint256 value, bytes32 indexed messageId);
    event TokensBridged(address indexed token, address indexed recipient, uint256 value, bytes32 indexed messageId);
    event NewTokenRegistered(address indexed nativeToken, address indexed bridgedToken);
    event ReleaseFailed(address indexed token, address indexed recipient, uint256 value, bytes32 indexed messageId);
    event CallbackFailed(address indexed token, address indexed recipient, bytes32 indexed messageId);

    mapping(address => uint256) public mediatorBalance;
    mapping(address => address) public nativeTokenAddress;

    function setBalance(address token, uint256 value) external {
        mediatorBalance[token] = value;
    }

    function setNative(address copy, address nativeToken) external {
        nativeTokenAddress[copy] = nativeToken;
    }

    function initiated(address token, address sender, uint256 value, bytes32 messageId) external {
        emit TokensBridgingInitiated(token, sender, value, messageId);
    }

    function bridged(address token, address recipient, uint256 value, bytes32 messageId) external {
        emit TokensBridged(token, recipient, value, messageId);
    }

    function registered(address nativeToken, address copy) external {
        emit NewTokenRegistered(nativeToken, copy);
    }

    function releaseFailed(address token, address recipient, uint256 value, bytes32 messageId) external {
        emit ReleaseFailed(token, recipient, value, messageId);
    }

    function callbackFailed(address token, address recipient, bytes32 messageId) external {
        emit CallbackFailed(token, recipient, messageId);
    }
}

/// @dev A light client that emits HeadUpdated and answers executionBlockNumber(hash).
contract SyntheticLightClient {
    event HeadUpdated(uint64 indexed slot, bytes32 indexed headerRoot, bytes32 indexed executionBlockHash);

    mapping(bytes32 => uint64) public executionBlockNumber;

    function update(uint64 slot, bytes32 headerRoot, bytes32 executionBlockHash, uint64 number) external {
        executionBlockNumber[executionBlockHash] = number;
        emit HeadUpdated(slot, headerRoot, executionBlockHash);
    }
}

/// @dev A gate that emits the events of BeaconForkGate and answers enforcing() and isSealed().
contract SyntheticGate {
    event BeaconRootsDetected();
    event ForkConfirmed(uint256 indexed epoch, bytes4 version);
    event ExecutionCanaryFired(uint8 canary);
    event GateSealedByFork(bytes4 version, uint64 slot);

    bool public enforcing;
    bool public isSealed;

    constructor(bool enforcing_) {
        enforcing = enforcing_;
    }

    function confirm(uint256 epoch, bytes4 version) external {
        enforcing = true;
        emit ForkConfirmed(epoch, version);
    }

    function seal(bytes4 version, uint64 slot) external {
        isSealed = true;
        emit GateSealedByFork(version, slot);
    }
}

/// @dev A fork registry that emits ForkObserved.
contract SyntheticRegistry {
    event ForkObserved(bytes4 indexed version, uint8 shape, uint64 slot);

    function observe(bytes4 version, uint8 shape, uint64 slot) external {
        emit ForkObserved(version, shape, slot);
    }
}

/// @dev A gate that admits every send. The integration test puts its runtime code at the address of an enforcing gate,
/// so that the real bridge accepts sends without a beacon proof.
contract AdmitAllGate {
    bool public enforcing = true;
    bool public isSealed;

    function admit(bytes calldata) external {}
}
