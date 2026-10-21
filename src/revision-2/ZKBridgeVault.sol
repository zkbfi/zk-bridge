// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";

interface ISP1Verifier {
    // FIXED (H-11): Perfectly aligned with the production Succinct SP1 Verifier Gateway signature selector
    function verifyProof(bytes32 programVKey, bytes calldata publicValues, bytes calldata proofBytes) external view;
}

interface ILightClientSync {
    function isVerifiedBlockRoot(bytes32 blockRoot) external view returns (bool);
}

contract ZKBridgeVault {
    using SafeERC20 for IERC20;

    struct LocalDepositRecord {
        address token;
        address sender;
        uint256 amount;
        uint64 timestamp;
        bool refunded;
    }

    ISP1Verifier public immutable sp1Verifier;
    ILightClientSync public immutable syncRegistry;
    bytes32 public immutable programVKey;
    uint64 public immutable currentChainId;
    
    // FIXED (H-16): Bound the vault immutable context fields to its target cross-chain counterpart profiles
    uint64 public immutable expectedSourceChainId;
    address public immutable expectedSourceVault;

    mapping(bytes32 => bool) public processedNonces;
    mapping(address => uint256) public userNonceCounter;
    
    // FIXED (H-10): Active whitelists prevent dead-end token parameter routing setups
    mapping(uint64 => bool) public supportedChains;
    
    // FIXED (H-03): Explicit Remote Token Address -> Local Asset Address pairing lookup matrix
    mapping(address => address) public remoteToLocalTokenRegistry;
    mapping(address => bool) public supportedDepositTokens;
    mapping(bytes32 => LocalDepositRecord) public localDeposits;
    
    uint64 public constant REFUND_DELAY = 7 days; // FIXED (H-09)

    event DepositInitiated(address indexed token, address indexed sender, address indexed recipient, uint256 amount, bytes32 nonce, uint64 targetChainId);
    event WithdrawalCompleted(address indexed token, address indexed recipient, uint256 amount, bytes32 indexed nonce);
    event DepositRefunded(bytes32 indexed nonce, address indexed token, address indexed sender, uint256 amount);

    constructor(
        address _sp1Verifier, 
        bytes32 _programVKey, 
        uint64 _currentChainId, 
        address _syncRegistry, 
        uint64[] memory _allowedChains,
        address[] memory _allowedDepositTokens,
        address[] memory _remoteTokens,
        address[] memory _localRedeemableTokens,
        uint64 _expectedSourceChainId,
        address _expectedSourceVault
    ) {
        require(_remoteTokens.length == _localRedeemableTokens.length, "Token registry bounds mismatch");
        sp1Verifier = ISP1Verifier(_sp1Verifier);
        programVKey = _programVKey;
        currentChainId = _currentChainId;
        syncRegistry = ILightClientSync(_syncRegistry);
        expectedSourceChainId = _expectedSourceChainId;
        expectedSourceVault = _expectedSourceVault;
        
        for (uint256 i = 0; i < _allowedChains.length; i++) {
            supportedChains[_allowedChains[i]] = true;
        }
        for (uint256 j = 0; j < _allowedDepositTokens.length; j++) {
            supportedDepositTokens[_allowedDepositTokens[j]] = true;
        }
        for (uint256 k = 0; k < _remoteTokens.length; k++) {
            remoteToLocalTokenRegistry[_remoteTokens[k]] = _localRedeemableTokens[k];
        }
    }

    function deposit(address token, address recipient, uint256 amount, uint64 targetChainId) external {
        require(amount > 0, "Amount must be greater than 0");
        require(supportedChains[targetChainId], "Target network architecture unsupported"); // FIXED (H-10)
        require(supportedDepositTokens[token], "Token target asset unsupported for deposit operations");

        // FIXED (H-12): Sequential internal tracking counter completely prevents same-block nonce collisions
        uint256 currentNonceCount = userNonceCounter[msg.sender]++;
        bytes32 nonce = keccak256(abi.encodePacked(msg.sender, recipient, amount, block.timestamp, currentNonceCount, currentChainId));

        // FIXED (H-13): Measure actual balances received to neutralize fee-on-transfer loopholes completely
        uint256 balanceBefore = IERC20(token).balanceOf(address(this));
        IERC20(token).safeTransferFrom(msg.sender, address(this), amount);
        uint256 actualReceivedAmount = IERC20(token).balanceOf(address(this)) - balanceBefore;
        require(actualReceivedAmount > 0, "Zero net transfer volume");

        localDeposits[nonce] = LocalDepositRecord({
            token: token,
            sender: msg.sender,
            amount: actualReceivedAmount,
            timestamp: uint64(block.timestamp),
            refunded: false
        });

        emit DepositInitiated(token, msg.sender, recipient, actualReceivedAmount, nonce, targetChainId);
    }

    /// @dev Extracted from `withdraw` only so the contract compiles without viaIR (stack too deep). Same checks, same order.
    function _checkContextAndProof(bytes calldata proof, bytes calldata publicInputsBytes) internal view {
        (
            uint64 sourceChainId,
            uint64 targetChainId,
            address sourceVault,
            ,
            ,
            ,
            bytes32 depositNonce,
            bytes32 confirmedBlockRoot
        ) = abi.decode(publicInputsBytes, (uint64, uint64, address, address, address, uint256, bytes32, bytes32));

        // FIXED (H-16): Strictly validate the source domain and origin vault parameters before evaluating math
        require(sourceChainId == expectedSourceChainId, "Invalid source chain context mapping");
        require(sourceVault == expectedSourceVault, "Invalid source vault contract emitter mapping");
        require(targetChainId == currentChainId, "Invalid target chain execution");
        require(!processedNonces[depositNonce], "Bridge transaction already claimed");
        require(syncRegistry.isVerifiedBlockRoot(confirmedBlockRoot), "Block root unverified by consensus layer");

        // Invoke the production verifier gateway (reverts natively on cryptographic validation breakdown)
        sp1Verifier.verifyProof(programVKey, publicInputsBytes, proof);
    }

    function withdraw(bytes calldata proof, bytes calldata publicInputsBytes) external {
        _checkContextAndProof(proof, publicInputsBytes);

        (, , , address tokenAddress, address recipient, uint256 amount, bytes32 depositNonce, ) =
            abi.decode(publicInputsBytes, (uint64, uint64, address, address, address, uint256, bytes32, bytes32));

        processedNonces[depositNonce] = true;
        
        address targetLocalToken = remoteToLocalTokenRegistry[tokenAddress];
        require(targetLocalToken != address(0), "Unregistered remote asset origin mapping");

        // FIXED (H-13): SafeTransfer handles non-standard ERC20 architectures (like USDT) without dropping execution paths
        IERC20(targetLocalToken).safeTransfer(recipient, amount);
        emit WithdrawalCompleted(targetLocalToken, recipient, amount, depositNonce);
    }

    /**
     * @notice FIXED (H-09): Free-standing user-initiated refund mechanism safeguards assets if counterpart chain stalls
     */
    function requestRefund(bytes32 nonce) external {
        LocalDepositRecord storage record = localDeposits[nonce];
        require(record.amount > 0, "Deposit record target tracking profile absent");
        require(!record.refunded, "Refund allocation profile already processed");
        require(block.timestamp >= record.timestamp + REFUND_DELAY, "Refund lock safety window active");

        record.refunded = true;
        IERC20(record.token).safeTransfer(record.sender, record.amount);

        emit DepositRefunded(nonce, record.token, record.sender, record.amount);
    }
}