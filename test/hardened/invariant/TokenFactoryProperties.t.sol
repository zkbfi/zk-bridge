// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {BridgedToken} from "../../../src/hardened/mediator/BridgedToken.sol";
import {TokenFactory} from "../../../src/hardened/mediator/TokenFactory.sol";

/// @notice Properties of `TokenFactory` and `BridgedToken` for any name, symbol, decimals, chain and native token. The
/// test contract plays the mediator: it is the account that the factory and its tokens obey. Every test is a fuzz test,
/// so the deep profile runs it 50000 times.
contract TokenFactoryPropertiesTest is Test {
    TokenFactory internal factory;

    function setUp() public {
        factory = new TokenFactory(address(this), "Home Chain");
    }

    /// Claim: the copy is deployed where the factory says it will be, with the metadata that was asked for. Shows: for any
    /// native token, chain, name, symbol and decimals, `deploy` returns `predictAddress`, the address holds code, and the
    /// token reports the name, symbol and decimals, obeys the mediator, and starts with no supply. Matters: the other
    /// chain and the dashboard compute the copy address without a call, so a mismatch hides the copy.
    function testFuzz_theCopyIsAtThePredictedAddressWithTheAskedMetadata(
        uint256 chainId,
        address nativeToken,
        string calldata name,
        string calldata symbol,
        uint8 decimals
    ) public {
        address predicted = factory.predictAddress(chainId, nativeToken);
        address copy = factory.deploy(name, symbol, decimals, chainId, nativeToken);
        assertEq(copy, predicted, "deployed away from the prediction");
        assertGt(copy.code.length, 0, "no code at the copy");
        assertEq(BridgedToken(copy).name(), name, "name");
        assertEq(BridgedToken(copy).symbol(), symbol, "symbol");
        assertEq(BridgedToken(copy).decimals(), decimals, "decimals");
        assertEq(BridgedToken(copy).bridgeContract(), address(this), "mediator");
        assertEq(BridgedToken(copy).totalSupply(), 0, "supply");
        assertEq(factory.homeChainName(), "Home Chain", "home chain name");
    }

    /// Claim: a copy exists once for each pair of chain and native token, and two pairs never share an address. Shows: a
    /// second deploy for the same pair reverts, whatever the metadata; two different pairs give different addresses.
    /// Matters: a second copy of one token, or one address for two tokens, would split or merge supplies.
    function testFuzz_oneCopyForEachPairAndNoTwoPairsShareAnAddress(
        uint256 chainId,
        address nativeToken,
        uint256 otherChainId,
        address otherToken
    ) public {
        vm.assume(chainId != otherChainId || nativeToken != otherToken);
        address first = factory.deploy("A", "A", 18, chainId, nativeToken);
        vm.expectRevert();
        factory.deploy("B", "B", 6, chainId, nativeToken);
        address second = factory.deploy("C", "C", 8, otherChainId, otherToken);
        assertTrue(first != second, "two pairs share an address");
    }

    /// Claim: only the mediator deploys. Shows: any other caller gets `NotMediator` with its own address, and nothing is
    /// deployed. Matters: a stranger must not put a token at an address that the mediator will trust.
    function testFuzz_onlyTheMediatorDeploys(address caller, uint256 chainId, address nativeToken) public {
        vm.assume(caller != address(this));
        address predicted = factory.predictAddress(chainId, nativeToken);
        vm.prank(caller);
        vm.expectRevert(abi.encodeWithSelector(TokenFactory.NotMediator.selector, caller));
        factory.deploy("X", "X", 18, chainId, nativeToken);
        assertEq(predicted.code.length, 0, "a stranger deployed");
    }

    /// Claim: only the mediator mints and burns, and mint and burn move the supply exactly. Shows: a stranger gets
    /// `NotMediator` on both calls; the mediator's mint adds to the balance and the supply, and its burn takes from its
    /// own balance and the supply, and one cannot burn more than the mediator holds. Matters: the supply of a copy is the
    /// claim of its holders on the locked native token.
    function testFuzz_onlyTheMediatorMintsAndBurnsAndTheSupplyFollows(
        address stranger,
        address holder,
        uint128 minted,
        uint128 burnedSeed
    ) public {
        vm.assume(stranger != address(this) && holder != address(0) && holder != address(this));
        BridgedToken copy = BridgedToken(factory.deploy("N", "S", 18, 1, address(0xABC)));
        vm.prank(stranger);
        vm.expectRevert(abi.encodeWithSelector(BridgedToken.NotMediator.selector, stranger));
        copy.mint(holder, minted);
        vm.prank(stranger);
        vm.expectRevert(abi.encodeWithSelector(BridgedToken.NotMediator.selector, stranger));
        copy.burn(1);

        copy.mint(holder, minted);
        assertEq(copy.balanceOf(holder), minted, "balance after mint");
        assertEq(copy.totalSupply(), minted, "supply after mint");

        // The mediator burns what it holds. Move some of the supply to it first.
        uint256 toMediator = bound(burnedSeed, 0, minted);
        vm.prank(holder);
        copy.transfer(address(this), toMediator);
        copy.burn(toMediator);
        assertEq(copy.totalSupply(), minted - toMediator, "supply after burn");
        assertEq(copy.balanceOf(address(this)), 0, "the mediator holds nothing after the burn");
        vm.expectRevert();
        copy.burn(1);
    }
}
