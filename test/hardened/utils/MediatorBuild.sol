// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Vm} from "forge-std/Vm.sol";
import {TokenMediator} from "../../../src/hardened/mediator/TokenMediator.sol";
import {TokenFactory} from "../../../src/hardened/mediator/TokenFactory.sol";

/// @notice Deploys a token mediator as the deploy scripts do: first its token factory, which names the mediator at the
/// next nonce of the caller, then the mediator, which takes the factory as a term. Two creations from the caller.
library MediatorBuild {
    Vm private constant VM = Vm(address(uint160(uint256(keccak256("hevm cheat code")))));

    /// @notice The creations of one `deploy`: the factory, then the mediator.
    uint256 internal constant CREATIONS = 2;

    /// @notice Deploys the factory and the mediator. `terms.tokenFactory` is overwritten with the new factory.
    function deploy(TokenMediator.MediatorTerms memory terms, string memory remoteChainName)
        internal
        returns (TokenMediator mediator)
    {
        address predicted = VM.computeCreateAddress(address(this), VM.getNonce(address(this)) + 1);
        terms.tokenFactory = address(new TokenFactory(predicted, remoteChainName));
        mediator = new TokenMediator(terms);
    }

    /// @notice The address of the mediator of a `deploy` that starts at `nonce` of `deployer`.
    function predictMediator(address deployer, uint256 nonce) internal pure returns (address) {
        return VM.computeCreateAddress(deployer, nonce + 1);
    }
}
