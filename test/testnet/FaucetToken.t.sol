// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IERC20Metadata} from "@openzeppelin/contracts/token/ERC20/extensions/IERC20Metadata.sol";
import {FaucetToken} from "../../src/testnet/FaucetToken.sol";
import {MediatorFixture} from "../hardened/mediator/utils/MediatorSupport.sol";

/// @notice Tests of the open-mint testnet token: its metadata, the cap per call, and a round trip through the mediators,
/// whose copy carries the `z` prefix.
contract FaucetTokenTest is MediatorFixture {
    FaucetToken internal faucet;
    uint256 internal constant CAP = 1_000e18;

    function setUp() public override {
        super.setUp();
        faucet = new FaucetToken();
    }

    function test_metadata() public view {
        assertEq(faucet.name(), "zkb Faucet Token");
        assertEq(faucet.symbol(), "tFAU");
        assertEq(faucet.decimals(), 18);
        assertEq(faucet.MAX_MINT(), CAP);
        assertEq(faucet.totalSupply(), 0);
    }

    function test_mintsToTheCaller() public {
        vm.expectEmit(address(faucet));
        emit IERC20.Transfer(address(0), alice, 5e18);
        vm.prank(alice);
        faucet.mint(5e18);
        assertEq(faucet.balanceOf(alice), 5e18);
        assertEq(faucet.totalSupply(), 5e18);
    }

    function test_mintsToAnotherAddress() public {
        vm.expectEmit(address(faucet));
        emit IERC20.Transfer(address(0), bob, 7e18);
        vm.prank(alice);
        faucet.mint(bob, 7e18);
        assertEq(faucet.balanceOf(bob), 7e18);
        assertEq(faucet.balanceOf(alice), 0);
    }

    function test_mintsTheCap() public {
        vm.prank(alice);
        faucet.mint(CAP);
        vm.prank(alice);
        faucet.mint(bob, CAP);
        assertEq(faucet.balanceOf(alice), CAP);
        assertEq(faucet.balanceOf(bob), CAP);
    }

    function test_refusesAboveTheCap() public {
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(FaucetToken.AboveMaxMint.selector, CAP + 1, CAP));
        faucet.mint(CAP + 1);

        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(FaucetToken.AboveMaxMint.selector, type(uint256).max, CAP));
        faucet.mint(bob, type(uint256).max);

        assertEq(faucet.totalSupply(), 0);
    }

    function test_repeatedMintsAddUp() public {
        for (uint256 i; i < 10; ++i) {
            vm.prank(alice);
            faucet.mint(CAP);
            vm.prank(bob);
            faucet.mint(alice, CAP);
        }
        assertEq(faucet.balanceOf(alice), 20 * CAP);
        assertEq(faucet.totalSupply(), 20 * CAP);
    }

    function testFuzz_mintsUpToTheCap(address caller, address to, uint256 amount) public {
        vm.assume(to != address(0));
        amount = bound(amount, 0, CAP);
        vm.prank(caller);
        faucet.mint(to, amount);
        assertEq(faucet.balanceOf(to), amount);
        assertEq(faucet.totalSupply(), amount);
    }

    function testFuzz_refusesAboveTheCap(uint256 amount) public {
        amount = bound(amount, CAP + 1, type(uint256).max);
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(FaucetToken.AboveMaxMint.selector, amount, CAP));
        faucet.mint(amount);
    }

    function test_roundTripThroughTheMediators() public {
        vm.startPrank(alice);
        faucet.mint(100e18);
        faucet.approve(address(mediatorA), type(uint256).max);
        vm.stopPrank();

        _bridgeAtoB(alice, address(faucet), bob, 25e18);
        IERC20Metadata copy = IERC20Metadata(_copyOf(address(faucet)));
        assertEq(copy.symbol(), "ztFAU");
        assertEq(copy.decimals(), 18);
        assertEq(copy.balanceOf(bob), 25e18);
        assertEq(faucet.balanceOf(address(mediatorA)), 25e18);

        _bridgeBtoA(bob, address(copy), alice, 10e18);
        assertEq(copy.balanceOf(bob), 15e18);
        assertEq(faucet.balanceOf(alice), 85e18);
    }
}
