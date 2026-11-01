// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IERC20Metadata} from "@openzeppelin/contracts/token/ERC20/extensions/IERC20Metadata.sol";
import {TestToken} from "../../src/testnet/TestToken.sol";
import {MediatorFixture} from "../hardened/mediator/utils/MediatorSupport.sol";

/// @notice Tests of the testnet token: who mints, its decimals, and a round trip through the mediators, whose copy
/// carries the `z` prefix and the decimals of the token.
contract TestTokenTest is MediatorFixture {
    TestToken internal dollar;
    address internal minterAccount = makeAddr("minter");

    function setUp() public override {
        super.setUp();
        dollar = new TestToken("zkb Test Dollar", "tUSD", 6, minterAccount);
    }

    function test_metadata() public view {
        assertEq(dollar.name(), "zkb Test Dollar");
        assertEq(dollar.symbol(), "tUSD");
        assertEq(dollar.decimals(), 6);
        assertEq(dollar.minter(), minterAccount);
        assertEq(dollar.totalSupply(), 0);
    }

    function test_eighteenDecimals() public {
        TestToken token = new TestToken("zkb Test Token", "tTKN", 18, minterAccount);
        assertEq(token.decimals(), 18);
    }

    function test_refusesAZeroMinter() public {
        vm.expectRevert(TestToken.ZeroMinter.selector);
        new TestToken("zkb Test Dollar", "tUSD", 6, address(0));
    }

    function test_onlyTheMinterMints() public {
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(TestToken.NotMinter.selector, alice));
        dollar.mint(alice, 1);

        vm.prank(minterAccount);
        dollar.mint(alice, 5_000_000);
        assertEq(dollar.balanceOf(alice), 5_000_000);
        assertEq(dollar.totalSupply(), 5_000_000);
    }

    function test_roundTripThroughTheMediators() public {
        vm.prank(minterAccount);
        dollar.mint(alice, 100e6);
        vm.prank(alice);
        dollar.approve(address(mediatorA), type(uint256).max);

        _bridgeAtoB(alice, address(dollar), bob, 25e6);
        IERC20Metadata copy = IERC20Metadata(_copyOf(address(dollar)));
        assertEq(copy.symbol(), "ztUSD");
        assertEq(copy.decimals(), 6);
        assertEq(copy.balanceOf(bob), 25e6);
        assertEq(dollar.balanceOf(address(mediatorA)), 25e6);

        _bridgeBtoA(bob, address(copy), alice, 10e6);
        assertEq(copy.balanceOf(bob), 15e6);
        assertEq(dollar.balanceOf(alice), 85e6);
    }
}
