// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {IERC20Permit} from "@openzeppelin/contracts/token/ERC20/extensions/IERC20Permit.sol";
import {IERC677} from "./IERC677.sol";
import {IBurnableMintableERC677Token} from "./IBurnableMintableERC677Token.sol";
import {ITokenParameters} from "./ITokenParameters.sol";

/// @title BridgedToken
/// @notice The copy of a native token on the chain that the native token does not live on. It is an ERC-20 with the
/// transfer callback of ERC-677 (`transferAndCall`), the allowance helpers of OmniBridge, and `permit`.
/// @dev The mediator is the only account that can mint and burn. The token has no owner and no upgrade path. The
/// constructor takes no arguments: it reads name, symbol, decimals and mediator from the factory that deploys it
/// (`ITokenParameters`), so the address of a copy depends on the home chain and the native token only. The permit
/// domain uses the token name and the version `"1"`, as OmniBridge does. The permit code is written here and not taken
/// from the OpenZeppelin extension, because that extension imports a library that needs the `mcopy` instruction, which
/// the Shanghai target of this repository does not have.
contract BridgedToken is ERC20, IERC20Permit, IBurnableMintableERC677Token {
    /// @notice Only the mediator may call the function.
    error NotMediator(address caller);
    /// @notice The receiver of `transferAndCall` is a contract and its `onTokenTransfer` call failed.
    error TransferCallFailed(address receiver);
    /// @notice The permit deadline has passed.
    error PermitExpired(uint256 deadline);
    /// @notice The permit signature does not come from the owner.
    error PermitSignerInvalid(address signer, address owner);

    bytes32 private constant DOMAIN_TYPEHASH =
        keccak256("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)");
    bytes32 private constant PERMIT_TYPEHASH =
        keccak256("Permit(address owner,address spender,uint256 value,uint256 nonce,uint256 deadline)");
    bytes32 private constant VERSION_HASH = keccak256("1");
    /// @dev The upper bound of `s` that rejects the malleable twin of a signature.
    uint256 private constant HALF_CURVE_ORDER = 0x7FFFFFFFFFFFFFFFFFFFFFFFFFFFFFFF5D576E7357A4501DDFE92F46681B20A0;

    mapping(address owner => uint256) public nonces;

    /// @notice The mediator, as OmniBridge names the bridge contract of a bridged token.
    address public immutable bridgeContract;
    uint8 private immutable _tokenDecimals;

    constructor() ERC20(_nameFromFactory(), _symbolFromFactory()) {
        (,, uint8 tokenDecimals, address mediator) = ITokenParameters(msg.sender).parameters();
        _tokenDecimals = tokenDecimals;
        bridgeContract = mediator;
    }

    modifier onlyMediator() {
        if (msg.sender != bridgeContract) revert NotMediator(msg.sender);
        _;
    }

    /// @inheritdoc ERC20
    function decimals() public view override returns (uint8) {
        return _tokenDecimals;
    }

    /// @inheritdoc IERC20Permit
    function DOMAIN_SEPARATOR() public view returns (bytes32) {
        return
            keccak256(abi.encode(DOMAIN_TYPEHASH, keccak256(bytes(name())), VERSION_HASH, block.chainid, address(this)));
    }

    /// @inheritdoc IERC20Permit
    function permit(address owner, address spender, uint256 value, uint256 deadline, uint8 v, bytes32 r, bytes32 s)
        external
    {
        if (block.timestamp > deadline) revert PermitExpired(deadline);
        bytes32 structHash = keccak256(abi.encode(PERMIT_TYPEHASH, owner, spender, value, nonces[owner]++, deadline));
        bytes32 digest = keccak256(abi.encodePacked("\x19\x01", DOMAIN_SEPARATOR(), structHash));
        address signer = uint256(s) > HALF_CURVE_ORDER ? address(0) : ecrecover(digest, v, r, s);
        if (signer == address(0) || signer != owner) revert PermitSignerInvalid(signer, owner);
        _approve(owner, spender, value);
    }

    /// @notice Mints tokens. Only the mediator may call it.
    function mint(address to, uint256 amount) external onlyMediator returns (bool) {
        _mint(to, amount);
        return true;
    }

    /// @notice Burns tokens of the caller. Only the mediator may call it, and it burns its own balance.
    function burn(uint256 value) external onlyMediator {
        _burn(msg.sender, value);
    }

    /// @inheritdoc IERC677
    /// @dev Moves the tokens, emits the data event, and then calls `onTokenTransfer(sender, value, data)` on a
    /// receiver that has code. A receiver whose call fails undoes the transfer.
    function transferAndCall(address to, uint256 value, bytes calldata data) external returns (bool) {
        _transfer(msg.sender, to, value);
        emit Transfer(msg.sender, to, value, data);
        if (to.code.length == 0) return true;
        (bool ok,) = to.call(abi.encodeWithSignature("onTokenTransfer(address,uint256,bytes)", msg.sender, value, data));
        if (!ok) revert TransferCallFailed(to);
        return true;
    }

    /// @inheritdoc IERC677
    function increaseAllowance(address spender, uint256 addedValue) external returns (bool) {
        _approve(msg.sender, spender, allowance(msg.sender, spender) + addedValue);
        return true;
    }

    /// @inheritdoc IERC677
    function decreaseAllowance(address spender, uint256 subtractedValue) external returns (bool) {
        uint256 current = allowance(msg.sender, spender);
        if (subtractedValue > current) revert ERC20InsufficientAllowance(spender, current, subtractedValue);
        _approve(msg.sender, spender, current - subtractedValue);
        return true;
    }

    function _nameFromFactory() private view returns (string memory name) {
        (name,,,) = ITokenParameters(msg.sender).parameters();
    }

    function _symbolFromFactory() private view returns (string memory symbol) {
        (, symbol,,) = ITokenParameters(msg.sender).parameters();
    }
}
