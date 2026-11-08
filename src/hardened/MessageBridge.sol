// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {IDepositGate} from "./IDepositGate.sol";
import {BeaconBlockHeader} from "./SSZ.sol";
import {BeaconProofVerifier} from "./BeaconProofVerifier.sol";
import {ReceiptProofLib} from "./ReceiptProofLib.sol";
import {AmbMessageCodec} from "./AmbMessageCodec.sol";
import {IAMB} from "./IAMB.sol";

/// @title MessageBridge
/// @notice One end of a two-chain message bridge with the interface of the OmniBridge Arbitrary Message Bridge. A
/// contract sends a message with `requireToPassMessage`. Anyone proves the message on the other chain with
/// `executeMessage`, and the bridge calls the target. The light client and the proof replace the validators of
/// OmniBridge. The bridge has no owner, no executor fee, no refund and no upgrade path.
/// @dev Sending. `requireToPassMessage` and `requireToConfirmMessage` emit `UserRequestForAffirmation` with the message
/// encoding of `AmbMessageCodec`, which is the OmniBridge encoding unchanged. There is no manual lane, so both calls
/// differ only in the data type byte of the message. A send first needs the deposit lock open, then the fork gate
/// admits it (with empty evidence: a keeper confirms the epoch with `BeaconForkGate.confirm`).
///
/// Delivery. `executeMessage` checks a proof of the log, in this order: the anchor, the ancestry, the block hash, the
/// execution header, the receipt (which must record success), the transaction at the same index, the log (emitter and
/// topic) and the message (identifier, version, chains and data type). A message executes once, and only a call
/// that succeeds counts: when the call to the target fails, `executeMessage` reverts with the error of the target, and
/// the message stays `NotDelivered`, so anyone can deliver it again later, with more gas or after the target changed
/// its mind. Messages are independent: the nonce of the sender only makes identifiers unique, and no order exists
/// between messages.
///
/// Gas. A message carries no gas number that the bridge reads. The target gets all the gas that is left (the EVM
/// keeps back one 64th), and if that is not enough the call fails and the delivery reverts. So an executor that gives
/// too little gas loses only its own transaction: it cannot make a message fail for good. The gas field of the
/// OmniBridge encoding stays in the message, always zero, so the encoding keeps its layout. A target that needs a
/// guarantee for a call of its own (a callback, a follow-up call) states the gas of that call in its own data and
/// checks it itself: the bridge knows nothing about the target.
///
/// The context (`messageSender`, `messageId`, `messageSourceChainId`, `transactionHash`) is set during the call to the
/// target and cleared after it. A target trusts a message by checking `msg.sender == bridge` and the pair
/// (`messageSourceChainId()`, `messageSender()`). While a message executes, another `executeMessage` is refused,
/// because it would overwrite the context. A target may send messages meanwhile: sends do not touch the context.
contract MessageBridge is BeaconProofVerifier, IAMB {
    /// @notice The terms at deployment: the cutoff and the remote light client.
    /// @param cutoffTimestamp Sends revert from this timestamp on. Zero means no cutoff.
    /// @param remoteLightClient The light client on the other chain, which tracks the beacon chain of THIS chain and
    /// feeds the remote bridge. `openDeposits` reads its storage. It must not be zero.
    /// @param gloasForkSlot The first slot of Gloas on the remote chain, or `NO_GLOAS_FORK`. Body-layout proofs from a
    /// slot at or after it are refused.
    struct BridgeTerms {
        uint64 cutoffTimestamp;
        address remoteLightClient;
        uint64 gloasForkSlot;
    }

    /// @notice The evidence for one message. Nothing in it is secret.
    /// @param anchorHeader A stored finalized header. Its root must equal `lightClient.headers(slot)`.
    /// @param sourceHeader The beacon block that carries the execution block of the sending transaction.
    /// @param ancestryBranch The branch from the root of `sourceHeader` to the state root of `anchorHeader`.
    /// @param blockHashBranch The branch from the execution block hash to the body root of `sourceHeader`.
    /// @param executionHeaderRlp The RLP of the execution block header. Its hash must be the proven block hash.
    /// @param receiptProof The trie nodes from the receipts root to the receipt.
    /// @param receiptIndex The index of the transaction in the block. It is the trie key of the receipt.
    /// @param transactionProof The trie nodes from the transactions root to the transaction.
    /// @param transactionIndex The trie key of the transaction. It must equal `receiptIndex`.
    /// @param logIndex The index of the `UserRequestForAffirmation` log inside the receipt.
    struct MessageProof {
        BeaconBlockHeader anchorHeader;
        BeaconBlockHeader sourceHeader;
        bytes32[] ancestryBranch;
        bytes32[] blockHashBranch;
        bytes executionHeaderRlp;
        bytes[] receiptProof;
        uint256 receiptIndex;
        bytes[] transactionProof;
        uint256 transactionIndex;
        uint256 logIndex;
    }

    /// @notice The state of a message on this chain. A message that was never delivered, or whose every delivery
    /// reverted, is `NotDelivered`.
    /// @dev `InProgress` lasts only inside the call to the target. It is the mark that the bridge sets before the call.
    /// There is no failed state: a failed call reverts the delivery.
    enum DeliveryStatus {
        NotDelivered,
        InProgress,
        Succeeded
    }

    /// @notice The topic 0 of `UserRequestForAffirmation`. A message proof matches logs against this value.
    /// @dev Solidity 0.8.28 rejects `UserRequestForAffirmation.selector` in a constant. A test pins this value.
    bytes32 public constant USER_REQUEST_TOPIC = keccak256("UserRequestForAffirmation(bytes32,bytes)");

    /// @dev The call data types that this bridge sends and accepts.
    uint8 private constant DATA_TYPE_PASS = AmbMessageCodec.DATA_TYPE_PASS;
    uint8 private constant DATA_TYPE_CONFIRM = AmbMessageCodec.DATA_TYPE_CONFIRM;

    /// @dev OmniBridge refuses a message whose call data starts with one of these selectors, so that the bridge cannot
    /// be made to move tokens of a contract that approved it: `transfer(address,uint256)`,
    /// `approve(address,uint256)`, `transferFrom(address,address,uint256)`, `approveAndCall(address,uint256,bytes)` and
    /// `transferAndCall(address,uint256,bytes)`.
    bytes4 private constant TRANSFER_SELECTOR = 0xa9059cbb;
    bytes4 private constant APPROVE_SELECTOR = 0x095ea7b3;
    bytes4 private constant TRANSFER_FROM_SELECTOR = 0x23b872dd;
    bytes4 private constant TRANSFER_AND_CALL_SELECTOR = 0x4000aea0;
    bytes4 private constant APPROVE_AND_CALL_SELECTOR = 0xcae9ca51;

    /// @notice The call data starts with a selector that the bridge never forwards.
    error ForbiddenSelector(bytes4 selector);
    /// @notice Sends are closed because the cutoff time passed.
    error SendCutoffReached(uint64 cutoff);
    /// @notice A message is executing. Another `executeMessage` would overwrite its context.
    error MessageInProgress(bytes32 messageId);
    /// @notice The receipt index and the transaction index of the proof differ.
    error IndexMismatch(uint256 receiptIndex, uint256 transactionIndex);
    /// @notice The log event data is not the encoding of one `bytes` value.
    error MalformedEventData();
    /// @notice The topic holds another message identifier than the message.
    error MessageIdMismatch(bytes32 topicMessageId, bytes32 encodedMessageId);
    /// @notice The message identifier has another format version than this bridge reads.
    error MessageVersionInvalid(bytes32 messageId);
    /// @notice The message has a data type that this bridge does not send.
    error UnknownDataType(uint8 dataType);
    /// @notice The message names another source chain than the remote chain.
    error WrongSourceChain(uint64 expected, uint256 actual);
    /// @notice The message names another destination chain than this chain.
    error WrongDestinationChain(uint64 expected, uint256 actual);
    /// @notice The message was already delivered.
    error AlreadyDelivered(bytes32 messageId);
    /// @notice The call to the target failed and returned no error of its own (for example, it ran out of gas). The
    /// message stays `NotDelivered`.
    error TargetCallFailed(bytes32 messageId);

    /// @notice The identifier of this chain: `block.chainid` at deployment.
    uint64 public immutable localChainId;
    /// @notice The identifier of the other chain.
    uint64 public immutable remoteChainId;
    /// @notice The bridge on the other chain.
    address public immutable remoteBridge;
    /// @notice Sends revert at and after this timestamp. Zero disables the cutoff. Set it at deployment only when a
    /// breaking fork of the other chain is already scheduled.
    uint64 public immutable sendCutoffTimestamp;
    /// @notice The gate that every send calls. It refuses a send that the route cannot deliver.
    IDepositGate public immutable depositGate;
    /// @dev The version and the bridge part of every message identifier of this bridge.
    bytes32 private immutable messageIdPrefix;

    // The nonce, the flag and the sender of the context share one storage word.
    /// @dev The number of messages sent. It feeds the identifier.
    uint64 private _nonce;
    /// @notice Whether sends are open. It starts false and `openDeposits` sets it true for good.
    bool public depositsOpen;
    /// @dev The sender of the message that executes now. Zero outside the call to the target.
    address private _activeSender;
    /// @dev The identifier of the message that executes now. Zero outside the call to the target.
    bytes32 private _activeMessageId;
    /// @dev The source transaction hash of the message that executes now. Zero outside the call to the target.
    bytes32 private _activeTransactionHash;

    mapping(bytes32 messageId => DeliveryStatus) private _deliveries;

    StateLayout[] private _stateLayouts;
    BodyLayout[] private _bodyLayouts;
    HistoricalLayout[] private _historicalLayouts;

    /// @param lightClient_ The light client of the remote chain.
    /// @param remoteChainId_ The identifier of the other chain.
    /// @param remoteBridge_ The bridge on the other chain.
    /// @param bridgeTerms The send cutoff and the remote light client. See `BridgeTerms`.
    /// @param capellaEra_ `floor(capellaForkSlot / 8192)` of the remote chain. The deploy script checks it.
    /// @param depositGate_ The gate that every send calls. It must not be the zero address.
    constructor(
        address lightClient_,
        uint64 remoteChainId_,
        address remoteBridge_,
        BridgeTerms memory bridgeTerms,
        uint64 capellaEra_,
        address depositGate_
    ) BeaconProofVerifier(lightClient_, capellaEra_, bridgeTerms.remoteLightClient, bridgeTerms.gloasForkSlot) {
        if (lightClient_ == address(0)) revert ZeroValue("lightClient");
        if (remoteChainId_ == 0) revert ZeroValue("remoteChainId");
        if (remoteBridge_ == address(0)) revert ZeroValue("remoteBridge");
        if (depositGate_ == address(0)) revert ZeroValue("depositGate");
        if (bridgeTerms.remoteLightClient == address(0)) revert ZeroValue("remoteLightClient");
        uint64 localChainId_ = uint64(block.chainid);
        if (remoteChainId_ == localChainId_) revert RemoteChainIsLocalChain();

        localChainId = localChainId_;
        remoteChainId = remoteChainId_;
        remoteBridge = remoteBridge_;
        sendCutoffTimestamp = bridgeTerms.cutoffTimestamp;
        depositGate = IDepositGate(depositGate_);
        messageIdPrefix = AmbMessageCodec.messageIdPrefix(localChainId_, address(this));
    }

    // ------------------------------------------------------------------ sending

    /// @inheritdoc IAMB
    /// @dev `_gas` is accepted for the OmniBridge interface and ignored: delivery gives the target all the gas that is
    /// left, and the gas field of the message is zero.
    function requireToPassMessage(address _contract, bytes calldata _data, uint256)
        external
        override
        returns (bytes32)
    {
        return _send(_contract, _data, DATA_TYPE_PASS);
    }

    /// @inheritdoc IAMB
    /// @dev The same as `requireToPassMessage`, with the data type of the manual lane. This bridge has no manual lane.
    function requireToConfirmMessage(address _contract, bytes calldata _data, uint256)
        external
        override
        returns (bytes32)
    {
        return _send(_contract, _data, DATA_TYPE_CONFIRM);
    }

    /// @dev The checks run in this order: the lock, the cutoff, the selector, the gate. The nonce moves before the gate
    /// call, so a gate that calls back cannot cause a repeated identifier. There is no gas check: the gas argument of
    /// the interface is not used.
    function _send(address target, bytes calldata data, uint8 dataType) private returns (bytes32 id) {
        if (!depositsOpen) revert DepositsNotOpen();
        if (sendCutoffTimestamp != 0 && block.timestamp >= sendCutoffTimestamp) {
            revert SendCutoffReached(sendCutoffTimestamp);
        }
        _requireForwardableSelector(data);

        uint64 nonce = _nonce;
        _nonce = nonce + 1;
        depositGate.admit("");

        id = messageIdPrefix | bytes32(uint256(nonce));
        AmbMessageCodec.Header memory header = AmbMessageCodec.Header({
            messageId: id,
            sender: msg.sender,
            executor: target,
            gasLimit: 0,
            dataType: dataType,
            sourceChainId: localChainId,
            destinationChainId: remoteChainId
        });
        emit UserRequestForAffirmation(id, AmbMessageCodec.encode(header, data));
    }

    /// @dev Reverts when the call data starts with a selector of a token transfer or approval.
    function _requireForwardableSelector(bytes calldata data) private pure {
        if (data.length < 4) return;
        bytes4 selector = bytes4(data[:4]);
        if (
            selector == TRANSFER_SELECTOR || selector == APPROVE_SELECTOR || selector == TRANSFER_FROM_SELECTOR
                || selector == TRANSFER_AND_CALL_SELECTOR || selector == APPROVE_AND_CALL_SELECTOR
        ) {
            revert ForbiddenSelector(selector);
        }
    }

    // ------------------------------------------------------------------ delivery

    /// @notice Delivers a message that a bridge on the other chain sent, given direct evidence. Anyone may call it.
    /// @dev A message executes once, with the target and data that the sender fixed, so an executor that runs ahead of
    /// another does no harm. The executor pays the gas and gets no fee from the bridge. When the call to the target
    /// fails, the delivery reverts with the error of the target (or `TargetCallFailed` when the target returned none),
    /// and the message stays `NotDelivered`.
    /// @param proof The evidence.
    function executeMessage(MessageProof calldata proof) external {
        if (_activeMessageId != bytes32(0)) revert MessageInProgress(_activeMessageId);
        if (proof.receiptIndex != proof.transactionIndex) {
            revert IndexMismatch(proof.receiptIndex, proof.transactionIndex);
        }
        (bytes memory encoded, bytes32 topicMessageId, bytes32 sourceTransactionHash) = _provenLog(proof);
        (AmbMessageCodec.Header memory header, bytes memory data) = AmbMessageCodec.decode(encoded);
        _requireAcceptableMessage(header, topicMessageId);

        if (_deliveries[header.messageId] != DeliveryStatus.NotDelivered) revert AlreadyDelivered(header.messageId);
        _deliveries[header.messageId] = DeliveryStatus.InProgress;

        _callTarget(header, data, sourceTransactionHash);
        _deliveries[header.messageId] = DeliveryStatus.Succeeded;
        emit AffirmationCompleted(header.sender, header.executor, header.messageId, true);
    }

    /// @dev Checks 1 to 7 and the log, and returns the encoded message of the log, the identifier in its topic and the
    /// hash of the transaction. The identifier in the topic and the one in the message are two copies of the same value.
    /// Checks 1 to 4 run here; the execution header, the receipt, the transaction and the log run in
    /// `ReceiptProofLib.provenLog`, under the block hash proven here.
    function _provenLog(MessageProof calldata proof)
        private
        view
        returns (bytes memory encoded, bytes32 topicMessageId, bytes32 sourceTransactionHash)
    {
        _requireAncestry(proof.anchorHeader, proof.sourceHeader, proof.ancestryBranch);
        bytes32 blockHash = keccak256(proof.executionHeaderRlp);
        _requireBlockHashBranch(blockHash, proof.sourceHeader, proof.blockHashBranch);

        (topicMessageId, encoded, sourceTransactionHash) = ReceiptProofLib.provenLog(
            proof.executionHeaderRlp,
            proof.receiptProof,
            proof.receiptIndex,
            proof.transactionProof,
            proof.logIndex,
            remoteBridge,
            USER_REQUEST_TOPIC
        );
    }

    /// @dev Checks the message against the log and this bridge.
    function _requireAcceptableMessage(AmbMessageCodec.Header memory header, bytes32 topicMessageId) private view {
        if (header.messageId != topicMessageId) revert MessageIdMismatch(topicMessageId, header.messageId);
        if (!AmbMessageCodec.hasValidVersion(header.messageId)) revert MessageVersionInvalid(header.messageId);
        if (header.sourceChainId != remoteChainId) revert WrongSourceChain(remoteChainId, header.sourceChainId);
        if (header.destinationChainId != localChainId) {
            revert WrongDestinationChain(localChainId, header.destinationChainId);
        }
        if (header.dataType != DATA_TYPE_PASS && header.dataType != DATA_TYPE_CONFIRM) {
            revert UnknownDataType(header.dataType);
        }
    }

    /// @dev Sets the context, calls the target with all the gas that is left, and clears the context. A failed call
    /// reverts the delivery with the error data of the target. A successful call copies no return data, so a target
    /// cannot cost gas with a large answer. The error data of a failed call is copied, at the cost of the delivery that
    /// reverts anyway.
    function _callTarget(AmbMessageCodec.Header memory header, bytes memory data, bytes32 sourceTransactionHash)
        private
    {
        _activeSender = header.sender;
        _activeMessageId = header.messageId;
        _activeTransactionHash = sourceTransactionHash;

        address target = header.executor;
        bool success;
        assembly {
            success := call(gas(), target, 0, add(data, 32), mload(data), 0, 0)
        }
        if (!success) _bubble(header.messageId);

        _activeSender = address(0);
        _activeMessageId = bytes32(0);
        _activeTransactionHash = bytes32(0);
    }

    /// @dev Reverts with the error data of the call that just failed, or with `TargetCallFailed` when it has none.
    function _bubble(bytes32 id) private pure {
        assembly ("memory-safe") {
            let size := returndatasize()
            if size {
                let pointer := mload(0x40)
                returndatacopy(pointer, 0, size)
                revert(pointer, size)
            }
        }
        revert TargetCallFailed(id);
    }

    // ------------------------------------------------------------------ the lock

    /// @notice Opens sends for good, given proof that the remote light client has stored a head.
    /// @dev A message sent at slot `s` is delivered only if some block hash row covers `s`. A row starts at a stored
    /// head that has an execution block hash, and the constructor of the light client stores none. So a message sent
    /// before the remote light client stored its first update is lost for ever. `_verifyOpening` checks the proof.
    /// After the call, the flag stays true. The call needs no key. A call after the opening returns at once, so two
    /// openers do not fail each other.
    /// @param proof The evidence.
    function openDeposits(OpeningProof calldata proof) external {
        if (depositsOpen) return;
        bytes32 blockHash = _verifyOpening(proof);

        depositsOpen = true;
        emit DepositsOpened(proof.remoteSlot, blockHash, proof.storedSlot);
    }

    // ------------------------------------------------------------------ context and views

    /// @inheritdoc IAMB
    function messageSender() external view override returns (address) {
        return _activeSender;
    }

    /// @inheritdoc IAMB
    function messageId() external view override returns (bytes32) {
        return _activeMessageId;
    }

    /// @inheritdoc IAMB
    /// @dev The proven transaction hash of the source chain: the hash of the transaction at the index of the receipt.
    function transactionHash() external view override returns (bytes32) {
        return _activeTransactionHash;
    }

    /// @inheritdoc IAMB
    /// @dev The source chain is always the remote chain, so the value follows the context: it is zero when no message
    /// executes.
    function messageSourceChainId() external view override returns (bytes32) {
        if (_activeMessageId == bytes32(0)) return bytes32(0);
        return bytes32(uint256(remoteChainId));
    }

    /// @inheritdoc IAMB
    /// @dev True once the message was delivered. A delivery whose call fails reverts, so there is no false after an
    /// attempt: false means not delivered yet.
    function messageCallStatus(bytes32 id) external view override returns (bool) {
        return _deliveries[id] == DeliveryStatus.Succeeded;
    }

    /// @notice The state of a message on this chain.
    /// @param id The message identifier.
    function deliveryStatus(bytes32 id) external view returns (DeliveryStatus) {
        return _deliveries[id];
    }

    /// @inheritdoc IAMB
    /// @dev Always zero: no message ends as a failure on this bridge. Kept for the OmniBridge interface.
    function failedMessageDataHash(bytes32) external pure override returns (bytes32) {
        return bytes32(0);
    }

    /// @inheritdoc IAMB
    /// @dev Always zero, as `failedMessageDataHash`.
    function failedMessageReceiver(bytes32) external pure override returns (address) {
        return address(0);
    }

    /// @inheritdoc IAMB
    /// @dev Always zero, as `failedMessageDataHash`.
    function failedMessageSender(bytes32) external pure override returns (address) {
        return address(0);
    }

    /// @inheritdoc IAMB
    /// @dev The bridge has no gas ceiling for a message: delivery gives the target all the gas that is left. It answers
    /// the largest value that the gas field of the encoding can hold, so that an OmniBridge sender that checks its gas
    /// against this value passes.
    function maxGasPerTx() external pure override returns (uint256) {
        return type(uint32).max;
    }

    /// @inheritdoc IAMB
    function sourceChainId() external view override returns (uint256) {
        return localChainId;
    }

    /// @inheritdoc IAMB
    function destinationChainId() external view override returns (uint256) {
        return remoteChainId;
    }

    // ------------------------------------------------------------------ storage hooks

    function _stateLayoutTable() internal view override returns (StateLayout[] storage) {
        return _stateLayouts;
    }

    function _bodyLayoutTable() internal view override returns (BodyLayout[] storage) {
        return _bodyLayouts;
    }

    function _historicalLayoutTable() internal view override returns (HistoricalLayout[] storage) {
        return _historicalLayouts;
    }
}
