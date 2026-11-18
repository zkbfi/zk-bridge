// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {TokenReader} from "./TokenReader.sol";
import {TokenFactory} from "./TokenFactory.sol";
import {IBurnableMintableERC677Token} from "./IBurnableMintableERC677Token.sol";
import {IFlowLimiter} from "../IFlowLimiter.sol";
import {IAMB} from "../IAMB.sol";

/// @dev The name and the symbol rule of a bridged copy, one copy for this library and the public constants of
/// `TokenMediator` (`NAME_CONNECTOR`, `SYMBOL_PREFIX`).
string constant COPY_NAME_CONNECTOR = " from ";
string constant COPY_SYMBOL_PREFIX = "z";

/// @dev The largest callback gas that a relay may state, one copy for this library and the public constant of
/// `TokenMediator` (`MAX_CALLBACK_GAS`). See `TokenMediator.MAX_CALLBACK_GAS` for the figure.
uint256 constant CALLBACK_GAS_MAXIMUM = 10_468_731;

/// @title IMediatorHandlers
/// @notice The handlers of `TokenMediator` that a message of the other mediator calls. `TokenMediator` implements this
/// interface, so the selectors that `MediatorPayloads` encodes are checked against the mediator by the compiler.
interface IMediatorHandlers {
    function handleNativeTokens(address token, address recipient, uint256 value) external;

    function handleNativeTokensAndCall(
        address token,
        address recipient,
        uint256 value,
        bytes memory data,
        uint256 callbackGas
    ) external;

    function handleBridgedTokens(address token, address recipient, uint256 value) external;

    function handleBridgedTokensAndCall(
        address token,
        address recipient,
        uint256 value,
        bytes memory data,
        uint256 callbackGas
    ) external;

    function deployAndHandleBridgedTokens(
        address token,
        string memory name,
        string memory symbol,
        uint8 decimals,
        address recipient,
        uint256 value
    ) external;

    function deployAndHandleBridgedTokensAndCall(
        address token,
        string memory name,
        string memory symbol,
        uint8 decimals,
        address recipient,
        uint256 value,
        bytes memory data,
        uint256 callbackGas
    ) external;
}

/// @title MediatorPayloads
/// @notice The messages that `TokenMediator` sends to the mediator on the other chain, and the reading of the ERC-677
/// data of a transfer. It reads the name, the symbol and the decimals of a native token for its first message
/// (`TokenReader`).
/// @dev An external library, linked into `TokenMediator`, so that the creation of the mediator stays under the
/// per-transaction gas cap of EIP-7825 (16,777,216). It has no owner and no storage, and its address is fixed in the
/// bytecode of the mediator, so the mediator stays immutable. On the sending side it builds every message; on the
/// receiving side only the first message of a token calls it, to deploy the copy (`copyOrDeploy`). A relay with a call
/// always carries `callbackGas` after `data`.
library MediatorPayloads {
    /// @notice The record of a native token in `TokenMediator`, in one storage slot.
    /// @param balance What the mediator owes to the other chain in this token.
    /// @param registered The token was relayed at least once.
    /// @param deployAcknowledged The other chain proved that the bridged copy exists, by sending tokens back.
    struct NativeRecord {
        uint240 balance;
        bool registered;
        bool deployAcknowledged;
    }

    /// @notice What the sender asks for in one relay. `callbackGas` is the gas of the callback, zero for a plain relay.
    struct Relay {
        address token;
        address receiver;
        bytes data;
        bool withCall;
        uint256 callbackGas;
    }

    /// @notice The same errors as those of `TokenMediator`, with the same signatures.
    error InvalidReceiver(address receiver);
    error ZeroAmount();
    error ZeroCallbackGas();
    /// @notice The callback gas of a relay is above the largest that a delivery can give. The same error as
    /// `TokenMediator.CallbackGasTooHigh`.
    error CallbackGasTooHigh(uint256 callbackGas, uint256 maximum);
    error MediatorBalanceOverflow(address token);
    /// @notice A token has neither a name nor a symbol, so the other chain could not name its copy. The same error as
    /// `TokenMediator.NoTokenName`.
    error NoTokenName(address token);
    /// @notice The ERC-677 data is longer than a receiver and shorter than a receiver and the callback gas. The same error
    /// as `TokenMediator.MalformedTransferData`.
    error MalformedTransferData(uint256 length);

    /// @notice Emitted when the mediator deploys the bridged copy of a native token. The same event as
    /// `TokenMediator.NewTokenRegistered`; the library runs in the mediator, so the mediator emits it.
    event NewTokenRegistered(address indexed nativeToken, address indexed bridgedToken);
    /// @notice The same event as `TokenMediator.TokensBridgingInitiated`, emitted by the mediator.
    event TokensBridgingInitiated(
        address indexed token, address indexed sender, uint256 value, bytes32 indexed messageId
    );

    /// @dev The length of the receiver at the start of the ERC-677 data.
    uint256 internal constant RECEIVER_LENGTH = 20;
    /// @dev Where the callback data starts in the ERC-677 data: after the receiver and the callback gas word.
    uint256 internal constant CALL_DATA_START = 52;

    /// @notice The sending side of `TokenMediator`, after the tokens arrived: checks the receiver, the amount and the
    /// callback gas (not zero for a relay with a call, never above `CALLBACK_GAS_MAXIMUM`), asks the flow limiter,
    /// locks a native token (or burns a bridged copy), and sends the message to the mediator on the other chain. The
    /// message asks the bridge for no gas.
    /// @dev Runs with DELEGATECALL in the storage of the mediator: the record of the native tokens and the map of the
    /// bridged copies are `storage` arguments. The mediator passes its bridge, its twin and its limiter.
    function send(
        mapping(address => NativeRecord) storage native,
        mapping(address => address) storage nativeTokenAddress,
        IAMB bridge,
        address remoteMediator,
        IFlowLimiter limiter,
        Relay memory relay,
        address from,
        uint256 value
    ) external {
        if (relay.receiver == address(0) || relay.receiver == remoteMediator) {
            revert InvalidReceiver(relay.receiver);
        }
        if (value == 0) revert ZeroAmount();
        if (relay.withCall && relay.callbackGas == 0) revert ZeroCallbackGas();
        if (relay.callbackGas > CALLBACK_GAS_MAXIMUM) {
            revert CallbackGasTooHigh(relay.callbackGas, CALLBACK_GAS_MAXIMUM);
        }
        if (address(limiter) != address(0)) limiter.checkDeposit(relay.token, from, value);

        address nativeToken = nativeTokenAddress[relay.token];
        bytes memory payload = nativeToken == address(0)
            ? _lockAndEncode(native, relay, value)
            : _burnAndEncode(relay, nativeToken, value);
        bytes32 messageId = bridge.requireToPassMessage(remoteMediator, payload, 0);
        emit TokensBridgingInitiated(relay.token, from, value, messageId);
    }

    /// @dev A native token: records the lock and builds the message that mints, or unlocks, on the other chain. Until
    /// the other chain proves that the copy exists, it is the first message form, which carries the name, the symbol and
    /// the decimals; then the short form, which without a call is the OmniBridge payload, byte for byte.
    function _lockAndEncode(mapping(address => NativeRecord) storage native, Relay memory relay, uint256 value)
        private
        returns (bytes memory)
    {
        NativeRecord memory record = native[relay.token];
        uint256 newBalance = record.balance + value;
        if (newBalance > type(uint240).max) revert MediatorBalanceOverflow(relay.token);
        native[relay.token] = NativeRecord(uint240(newBalance), true, record.deployAcknowledged);

        if (record.deployAcknowledged) {
            if (relay.withCall) {
                return abi.encodeCall(
                    IMediatorHandlers.handleBridgedTokensAndCall,
                    (relay.token, relay.receiver, value, relay.data, relay.callbackGas)
                );
            }
            return abi.encodeCall(IMediatorHandlers.handleBridgedTokens, (relay.token, relay.receiver, value));
        }
        (string memory name, string memory symbol, uint8 decimals) = readMetadata(relay.token);
        if (relay.withCall) {
            return abi.encodeCall(
                IMediatorHandlers.deployAndHandleBridgedTokensAndCall,
                (relay.token, name, symbol, decimals, relay.receiver, value, relay.data, relay.callbackGas)
            );
        }
        return abi.encodeCall(
            IMediatorHandlers.deployAndHandleBridgedTokens, (relay.token, name, symbol, decimals, relay.receiver, value)
        );
    }

    /// @dev A bridged copy: burns it and builds the message that unlocks `nativeToken` on the other chain.
    function _burnAndEncode(Relay memory relay, address nativeToken, uint256 value) private returns (bytes memory) {
        IBurnableMintableERC677Token(relay.token).burn(value);
        if (relay.withCall) {
            return abi.encodeCall(
                IMediatorHandlers.handleNativeTokensAndCall,
                (nativeToken, relay.receiver, value, relay.data, relay.callbackGas)
            );
        }
        return abi.encodeCall(IMediatorHandlers.handleNativeTokens, (nativeToken, relay.receiver, value));
    }

    /// @notice Reads the ERC-677 data of a transfer of `token`: nothing (the receiver is `from`, no call), a receiver (no
    /// call), or a receiver, one 32 byte word with the gas of the callback, and the bytes passed to `onTokenBridged`
    /// (they may be empty). Data between 21 and 51 bytes reverts with `MalformedTransferData`.
    function readTransferData(address token, address from, bytes memory data)
        external
        pure
        returns (Relay memory relay)
    {
        relay.token = token;
        if (data.length < RECEIVER_LENGTH) {
            relay.receiver = from;
            return relay;
        }
        relay.receiver = address(bytes20(data));
        if (data.length == RECEIVER_LENGTH) return relay;
        if (data.length < CALL_DATA_START) revert MalformedTransferData(data.length);
        uint256 callbackGas;
        assembly ("memory-safe") {
            callbackGas := mload(add(data, add(32, RECEIVER_LENGTH)))
        }
        bytes memory callData = new bytes(data.length - CALL_DATA_START);
        for (uint256 i = 0; i < callData.length; i++) {
            callData[i] = data[i + CALL_DATA_START];
        }
        relay.data = callData;
        relay.withCall = true;
        relay.callbackGas = callbackGas;
    }

    /// @notice The bridged copy of `nativeToken`, on the receiving side of a first message. It deploys the copy when it does
    /// not exist and records it in the two mappings of the mediator. A copy that exists keeps its name, so a later message
    /// with other metadata changes nothing.
    /// @dev Runs with DELEGATECALL in the storage of the mediator: the mappings are `storage` arguments.
    function copyOrDeploy(
        mapping(address => address) storage bridgedTokenAddress,
        mapping(address => address) storage nativeTokenAddress,
        TokenFactory factory,
        uint256 homeChainId,
        address nativeToken,
        string calldata name,
        string calldata symbol,
        uint8 decimals
    ) external returns (address copy) {
        copy = bridgedTokenAddress[nativeToken];
        if (copy != address(0)) return copy;
        if (bytes(name).length == 0 && bytes(symbol).length == 0) revert NoTokenName(nativeToken);
        string memory baseName = bytes(name).length == 0 ? symbol : name;
        string memory baseSymbol = bytes(symbol).length == 0 ? name : symbol;
        copy = factory.deploy(
            string.concat(baseName, COPY_NAME_CONNECTOR, factory.homeChainName()),
            string.concat(COPY_SYMBOL_PREFIX, baseSymbol),
            decimals,
            homeChainId,
            nativeToken
        );
        bridgedTokenAddress[nativeToken] = copy;
        nativeTokenAddress[copy] = nativeToken;
        emit NewTokenRegistered(nativeToken, copy);
    }

    /// @dev The name, the symbol and the decimals of a native token for its first message. A token with neither a name
    /// nor a symbol is refused.
    function readMetadata(address token)
        internal
        view
        returns (string memory name, string memory symbol, uint8 decimals)
    {
        name = TokenReader.readName(token);
        symbol = TokenReader.readSymbol(token);
        if (bytes(name).length == 0 && bytes(symbol).length == 0) revert NoTokenName(token);
        decimals = TokenReader.readDecimals(token);
    }
}
