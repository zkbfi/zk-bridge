// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {MockERC20} from "../../../../src/mocks/MockERC20.sol";
import {MockWrappedNative} from "../../../../src/mocks/MockWrappedNative.sol";
import {IFlowLimiter} from "../../../../src/hardened/IFlowLimiter.sol";
import {IAMB} from "../../../../src/hardened/IAMB.sol";
import {TokenMediator} from "../../../../src/hardened/mediator/TokenMediator.sol";
import {MessageBridge} from "../../../../src/hardened/MessageBridge.sol";

/// @notice An Arbitrary Message Bridge for tests. It records every message that a mediator sends, and a test delivers
/// it on the other side, as the real bridge would: the context (`messageSender`, `messageSourceChainId`, `messageId`)
/// is set during the call and cleared after, and the call gets exactly the gas that the sender asked for. Delivery is
/// final: a failing call does not stop the delivery, and the test reads the result.
contract MockAMB is IAMB {
    struct Sent {
        address sender;
        address target;
        bytes data;
        uint256 gasLimit;
        bytes32 id;
    }

    uint256 public immutable chainId;
    uint256 public immutable peerChainId;
    Sent[] private _sent;

    address public messageSender;
    bytes32 public messageId;
    bytes32 public messageSourceChainId;
    bytes32 public transactionHash;
    uint256 public maxGasPerTx = 10_000_000;

    constructor(uint256 chainId_, uint256 peerChainId_) {
        chainId = chainId_;
        peerChainId = peerChainId_;
    }

    /// @notice Lowers or raises the ceiling that the mock reports, so a test can check what a mediator does with it.
    function setMaxGasPerTx(uint256 maximum) external {
        maxGasPerTx = maximum;
    }

    function sentCount() external view returns (uint256) {
        return _sent.length;
    }

    function messageAt(uint256 index) external view returns (Sent memory) {
        return _sent[index];
    }

    function sourceChainId() external view returns (uint256) {
        return chainId;
    }

    function destinationChainId() external view returns (uint256) {
        return peerChainId;
    }

    function messageCallStatus(bytes32) external pure returns (bool) {
        return false;
    }

    function failedMessageDataHash(bytes32) external pure returns (bytes32) {
        return bytes32(0);
    }

    function failedMessageReceiver(bytes32) external pure returns (address) {
        return address(0);
    }

    function failedMessageSender(bytes32) external pure returns (address) {
        return address(0);
    }

    function requireToPassMessage(address target, bytes calldata data, uint256 gasLimit) public returns (bytes32 id) {
        id = keccak256(abi.encode(chainId, _sent.length));
        _sent.push(Sent(msg.sender, target, data, gasLimit, id));
        emit UserRequestForAffirmation(id, data);
    }

    function requireToConfirmMessage(address target, bytes calldata data, uint256 gasLimit) external returns (bytes32) {
        return requireToPassMessage(target, data, gasLimit);
    }

    /// @notice Delivers message `index` of `source` on this chain.
    function deliver(MockAMB source, uint256 index) public returns (bool ok, bytes memory returned) {
        Sent memory message = source.messageAt(index);
        return
            execute(
                message.target, message.data, message.sender, bytes32(source.chainId()), message.id, message.gasLimit
            );
    }

    /// @notice The entry that the delivery router calls. The mock reads no proof: it takes the source bridge and the message
    /// index from `abi.encode(source, index)` in the `executionHeaderRlp` field (see `proofOf`).
    function executeMessage(MessageBridge.MessageProof calldata proof) external {
        (MockAMB source, uint256 index) = abi.decode(proof.executionHeaderRlp, (MockAMB, uint256));
        deliver(source, index);
    }

    /// @notice A proof that names message `index` of `source`, in the form that `executeMessage` reads.
    function proofOf(MockAMB source, uint256 index) public pure returns (MessageBridge.MessageProof memory proof) {
        proof.executionHeaderRlp = abi.encode(source, index);
    }

    /// @notice Calls `target` with a chosen context. Tests use it to forge a sender or a chain.
    function execute(
        address target,
        bytes memory data,
        address sender,
        bytes32 sourceChain,
        bytes32 id,
        uint256 gasLimit
    ) public returns (bool ok, bytes memory returned) {
        messageSender = sender;
        messageSourceChainId = sourceChain;
        messageId = id;
        (ok, returned) = target.call{gas: gasLimit}(data);
        messageSender = address(0);
        messageSourceChainId = bytes32(0);
        messageId = bytes32(0);
        emit AffirmationCompleted(sender, target, id, ok);
    }
}

/// @notice A receiver that records the callback of a `...AndCall` delivery. It can be told to revert.
contract RecordingReceiver {
    uint256 public calls;
    address public lastCaller;
    address public lastToken;
    uint256 public lastValue;
    bytes public lastData;
    bool public refuse;

    error ReceiverRefused();

    function setRefuse(bool refuse_) external {
        refuse = refuse_;
    }

    function onTokenBridged(address token, uint256 value, bytes calldata data) external {
        if (refuse) revert ReceiverRefused();
        calls++;
        lastCaller = msg.sender;
        lastToken = token;
        lastValue = value;
        lastData = data;
    }

    /// @dev The ERC-677 callback, for `transferAndCall` tests.
    function onTokenTransfer(address from, uint256 value, bytes calldata data) external returns (bool) {
        calls++;
        lastCaller = msg.sender;
        lastToken = from;
        lastValue = value;
        lastData = data;
        return true;
    }
}

/// @notice A token that refuses every transfer to the accounts on its deny list, as a token with a blacklist does.
contract DenyListToken is ERC20 {
    error TransferRefused(address to);

    mapping(address account => bool) public denied;

    constructor() ERC20("Deny", "DENY") {}

    function mint(address to, uint256 amount) external {
        _mint(to, amount);
    }

    function setDenied(address account, bool isDenied) external {
        denied[account] = isDenied;
    }

    function _update(address from, address to, uint256 value) internal override {
        if (denied[to]) revert TransferRefused(to);
        super._update(from, to, value);
    }
}

/// @notice A token with chosen decimals.
contract DecimalsToken is ERC20 {
    uint8 private immutable _tokenDecimals;

    constructor(string memory name_, string memory symbol_, uint8 decimals_) ERC20(name_, symbol_) {
        _tokenDecimals = decimals_;
    }

    function decimals() public view override returns (uint8) {
        return _tokenDecimals;
    }

    function mint(address to, uint256 amount) external {
        _mint(to, amount);
    }
}

/// @notice A token that has no name and no symbol. It moves tokens without an allowance.
contract NamelessToken {
    mapping(address => uint256) public balanceOf;

    function mint(address to, uint256 amount) external {
        balanceOf[to] += amount;
    }

    function transferFrom(address from, address to, uint256 amount) external returns (bool) {
        balanceOf[from] -= amount;
        balanceOf[to] += amount;
        return true;
    }
}

/// @notice A token that calls a target during `transferFrom`, as a token with hooks does, and keeps the result.
contract HookToken is ERC20 {
    address public target;
    bytes public data;
    bool public hookOk;
    bytes public hookReturned;
    bool public callMediator;

    constructor() ERC20("Hook", "HOOK") {}

    function mint(address to, uint256 amount) external {
        _mint(to, amount);
    }

    function arm(address target_, bytes calldata data_) external {
        target = target_;
        data = data_;
    }

    /// @dev Makes the token call `onTokenTransfer` on the receiver of every `transferFrom`, as ERC-677 tokens do.
    function setCallMediator(bool callMediator_) external {
        callMediator = callMediator_;
    }

    function transferFrom(address from, address to, uint256 value) public override returns (bool) {
        super.transferFrom(from, to, value);
        if (callMediator) {
            (hookOk, hookReturned) =
                to.call(abi.encodeWithSignature("onTokenTransfer(address,uint256,bytes)", from, value, ""));
            return true;
        }
        if (target == address(0)) return true;
        address callee = target;
        target = address(0);
        (hookOk, hookReturned) = callee.call(data);
        return true;
    }
}

/// @notice A contract that cannot receive the native coin.
contract CoinRefuser {}

/// @notice A receiver that burns all the gas that it is given, then fails.
contract GasBurner {
    receive() external payable {
        while (true) {}
    }
}

/// @notice A receiver that reverts with data.
contract CoinReverter {
    error Refused();

    receive() external payable {
        revert Refused();
    }
}

/// @notice A contract wallet that needs some gas to receive: it writes one fresh storage slot, which costs about 24,000
/// gas, so a call with the 2,300 gas stipend fails and a call with 50,000 gas passes.
contract ContractWallet {
    uint256 public received;

    receive() external payable {
        received += 1;
    }
}

/// @notice A flow limiter for tests. It refuses on command and records what the mediator passes.
contract ScriptedMediatorLimiter is IFlowLimiter {
    error FlowRefused();

    bool public refuseDeposits;
    bool public refuseWithdrawals;

    uint256 public depositChecks;
    address public lastDepositToken;
    address public lastDepositor;
    uint256 public lastDepositAmount;

    uint256 public withdrawalChecks;
    address public lastWithdrawalToken;
    address public lastWithdrawalRecipient;
    uint256 public lastWithdrawalAmount;
    bytes32 public lastWithdrawalNonce;

    function setRefusals(bool deposits, bool withdrawals) external {
        refuseDeposits = deposits;
        refuseWithdrawals = withdrawals;
    }

    function detachFrom(TokenMediator mediator) external {
        mediator.detachFlowLimiter();
    }

    function checkDeposit(address token, address depositor, uint256 amount) external {
        depositChecks++;
        lastDepositToken = token;
        lastDepositor = depositor;
        lastDepositAmount = amount;
        if (refuseDeposits) revert FlowRefused();
    }

    function checkWithdrawal(address token, address recipient, uint256 amount, bytes32 nonce) external {
        withdrawalChecks++;
        lastWithdrawalToken = token;
        lastWithdrawalRecipient = recipient;
        lastWithdrawalAmount = amount;
        lastWithdrawalNonce = nonce;
        if (refuseWithdrawals) revert FlowRefused();
    }
}

/// @notice Two mediators joined by two mock bridges, one per side. Chain A and chain B share one test chain, so the
/// chain identifiers are the ones that the mediators are told. Each mediator names the other as its remote mediator.
abstract contract MediatorFixture is Test {
    uint256 internal constant CHAIN_A = 1;
    uint256 internal constant CHAIN_B = 369;

    MockAMB internal ambA;
    MockAMB internal ambB;
    TokenMediator internal mediatorA;
    TokenMediator internal mediatorB;

    MockERC20 internal tokenA;

    address internal alice = makeAddr("alice");
    address internal bob = makeAddr("bob");
    address internal carol = makeAddr("carol");
    address internal dave = makeAddr("dave");

    function setUp() public virtual {
        _deployMediators(_noTerms(), _noTerms());
        tokenA = new MockERC20("Token A", "TKA");
        tokenA.mint(alice, 1_000_000 ether);
        vm.prank(alice);
        tokenA.approve(address(mediatorA), type(uint256).max);
    }

    /// @dev The names that the mediators take for the two chains. A test sets them before it deploys the mediators.
    string internal nameOfChainA = "Chain A";
    string internal nameOfChainB = "Chain B";

    /// @dev Terms with no fee and no limiter. The fixture fills in the bridge and the remote mediator.
    function _noTerms() internal pure returns (TokenMediator.MediatorTerms memory terms) {
        terms.remoteChainId = 1;
        terms.remoteChainName = "Chain";
    }

    function _deployMediators(TokenMediator.MediatorTerms memory termsA, TokenMediator.MediatorTerms memory termsB)
        internal
    {
        ambA = new MockAMB(CHAIN_A, CHAIN_B);
        ambB = new MockAMB(CHAIN_B, CHAIN_A);
        uint256 nonce = vm.getNonce(address(this));
        address predictedA = vm.computeCreateAddress(address(this), nonce);
        address predictedB = vm.computeCreateAddress(address(this), nonce + 1);
        termsA.bridge = address(ambA);
        termsA.remoteMediator = predictedB;
        termsA.remoteChainId = CHAIN_B;
        termsA.remoteChainName = nameOfChainB;
        termsB.bridge = address(ambB);
        termsB.remoteMediator = predictedA;
        termsB.remoteChainId = CHAIN_A;
        termsB.remoteChainName = nameOfChainA;
        mediatorA = new TokenMediator(termsA);
        mediatorB = new TokenMediator(termsB);
        assertEq(address(mediatorA), predictedA);
        assertEq(address(mediatorB), predictedB);
    }

    function _deliverAtoB(uint256 index) internal returns (bool, bytes memory) {
        return ambB.deliver(ambA, index);
    }

    function _deliverBtoA(uint256 index) internal returns (bool, bytes memory) {
        return ambA.deliver(ambB, index);
    }

    function _lastIndexA() internal view returns (uint256) {
        return ambA.sentCount() - 1;
    }

    function _lastIndexB() internal view returns (uint256) {
        return ambB.sentCount() - 1;
    }

    /// @dev Relays from chain A to chain B and delivers the message. The call must succeed.
    function _bridgeAtoB(address from, address token, address receiver, uint256 value)
        internal
        returns (uint256 index)
    {
        vm.prank(from);
        mediatorA.relayTokens(token, receiver, value);
        index = _lastIndexA();
        (bool ok,) = _deliverAtoB(index);
        assertTrue(ok, "delivery on chain B failed");
    }

    /// @dev Relays from chain B to chain A and delivers the message. The call must succeed.
    function _bridgeBtoA(address from, address token, address receiver, uint256 value)
        internal
        returns (uint256 index)
    {
        vm.startPrank(from);
        IERC20Approve(token).approve(address(mediatorB), type(uint256).max);
        mediatorB.relayTokens(token, receiver, value);
        vm.stopPrank();
        index = _lastIndexB();
        (bool ok,) = _deliverBtoA(index);
        assertTrue(ok, "delivery on chain A failed");
    }

    function _copyOf(address nativeOnA) internal view returns (address) {
        return mediatorB.bridgedTokenAddress(nativeOnA);
    }

    function _selectorOf(bytes memory data) internal pure returns (bytes4 selector) {
        assembly {
            selector := mload(add(data, 0x20))
        }
    }
}

interface IERC20Approve {
    function approve(address spender, uint256 value) external returns (bool);
}
