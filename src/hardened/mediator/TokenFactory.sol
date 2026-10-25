// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {BridgedToken} from "./BridgedToken.sol";
import {ITokenParameters} from "./ITokenParameters.sol";

/// @title TokenFactory
/// @notice Deploys the bridged copies of native tokens at addresses that can be computed. Only the mediator may call
/// `deploy`. The factory has no owner and no token image to change: every copy has the same code.
/// @dev The address of a copy is `CREATE2(factory, salt, creationCode)` with `salt = keccak256(abi.encode(homeChainId,
/// nativeToken))`. The creation code has no arguments, so the name, the symbol and the decimals do not change the
/// address. The factory holds them in storage during the deployment, and the token reads them in its constructor.
contract TokenFactory is ITokenParameters {
    /// @notice Only the mediator may deploy.
    error NotMediator(address caller);

    /// @dev What the token constructor reads while a deployment runs.
    struct Parameters {
        string name;
        string symbol;
        uint8 decimals;
    }

    /// @notice The only account that may call `deploy`, and the only account that may mint and burn the copies.
    address public immutable mediator;

    Parameters private _pending;

    constructor(address mediator_) {
        mediator = mediator_;
    }

    /// @notice Deploys the copy of `nativeToken`. It reverts when the copy exists.
    /// @dev This is the OmniBridge signature `deploy(string,string,uint8,uint256)` with one more argument. A
    /// deterministic address needs the native token, and OmniBridge does not pass it. Its `chainId` argument is the
    /// chain of the permit domain. Here `chainId` is the home chain of the native token, which is the other half of
    /// the salt. The token reads `block.chainid` for its own permit domain.
    /// @param name The name of the copy.
    /// @param symbol The symbol of the copy.
    /// @param decimals The decimals of the copy.
    /// @param chainId The home chain of the native token.
    /// @param nativeToken The native token, on the home chain.
    /// @return token The address of the copy.
    function deploy(string calldata name, string calldata symbol, uint8 decimals, uint256 chainId, address nativeToken)
        external
        returns (address token)
    {
        if (msg.sender != mediator) revert NotMediator(msg.sender);
        _pending = Parameters(name, symbol, decimals);
        token = address(new BridgedToken{salt: _salt(chainId, nativeToken)}());
        delete _pending;
    }

    /// @notice The address where the copy of `nativeToken` is, or will be, deployed.
    /// @param chainId The home chain of the native token.
    /// @param nativeToken The native token, on the home chain.
    function predictAddress(uint256 chainId, address nativeToken) external view returns (address) {
        bytes32 hash = keccak256(
            abi.encodePacked(
                bytes1(0xff), address(this), _salt(chainId, nativeToken), keccak256(type(BridgedToken).creationCode)
            )
        );
        return address(uint160(uint256(hash)));
    }

    /// @inheritdoc ITokenParameters
    function parameters() external view returns (string memory, string memory, uint8, address) {
        return (_pending.name, _pending.symbol, _pending.decimals, mediator);
    }

    function _salt(uint256 chainId, address nativeToken) private pure returns (bytes32) {
        return keccak256(abi.encode(chainId, nativeToken));
    }
}
