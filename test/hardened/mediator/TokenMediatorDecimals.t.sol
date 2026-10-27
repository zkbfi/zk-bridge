// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IERC20Metadata} from "@openzeppelin/contracts/token/ERC20/extensions/IERC20Metadata.sol";
import {TokenMediator} from "../../../src/hardened/mediator/TokenMediator.sol";
import {TokenReader} from "../../../src/hardened/mediator/TokenReader.sol";
import {MediatorFixture} from "./utils/MediatorSupport.sol";
import {DecimalsReturningToken, NoDecimalsToken} from "./utils/MetadataTokens.sol";

/// @notice The rules for decimals. Amounts are integers everywhere. Decimals are metadata that the copy of a token takes
/// when it is created. The mediator runs on both chains, so both sides check: the source refuses a token whose
/// `decimals()` is above 255, and the destination refuses a deploy message whose decimals are above 255. A token with no
/// readable `decimals()` keeps the old rule: its copy has 0 decimals.
contract TokenMediatorDecimalsTest is MediatorFixture {
    function _tokenWithDecimalsWord(uint256 word) internal returns (DecimalsReturningToken token) {
        token = new DecimalsReturningToken(word);
        token.mint(alice, 100 ether);
        vm.prank(alice);
        token.approve(address(mediatorA), type(uint256).max);
    }

    /// Claim: the source refuses the first relay of a token whose decimals are above 255. Shows: the revert names the
    /// token and the value, no tokens move, nothing is recorded, and no message is sent. 256 and 2^255 both refuse.
    /// Matters: the old reader turned such a value into 0 and gave the copy the wrong metadata for good.
    function test_theSourceRefusesDecimalsAbove255() public {
        uint256[2] memory words = [uint256(256), uint256(1) << 255];
        for (uint256 i = 0; i < words.length; i++) {
            DecimalsReturningToken token = _tokenWithDecimalsWord(words[i]);
            vm.prank(alice);
            vm.expectRevert(abi.encodeWithSelector(TokenReader.DecimalsOutOfRange.selector, address(token), words[i]));
            mediatorA.relayTokens(address(token), bob, 1 ether);
            assertEq(token.balanceOf(alice), 100 ether, "nothing moved");
            assertEq(mediatorA.mediatorBalance(address(token)), 0, "nothing recorded");
            assertFalse(mediatorA.isRegisteredAsNativeToken(address(token)), "not registered");
        }
        assertEq(ambA.sentCount(), 0, "no message");
    }

    /// Claim: 255 decimals is the largest value that passes, end to end. Shows: the copy reports 255 and holds the
    /// amount.
    function test_theLargestDecimalsPass() public {
        DecimalsReturningToken token = _tokenWithDecimalsWord(255);
        vm.prank(alice);
        mediatorA.relayTokens(address(token), bob, 1 ether);
        (bool ok,) = _deliverAtoB(0);
        assertTrue(ok);
        assertEq(IERC20Metadata(_copyOf(address(token))).decimals(), 255);
        assertEq(IERC20Metadata(_copyOf(address(token))).balanceOf(bob), 1 ether);
    }

    /// Claim: a token with no `decimals()` is still relayed, and its copy has 0 decimals. This is the rule that the
    /// mediator keeps and documents. Shows: the relay succeeds, and the copy reports 0 and holds the exact amount.
    /// Matters: amounts are integers, so the missing metadata costs the holder nothing but the display.
    function test_aMissingDecimalsFunctionGivesACopyWithZeroDecimals() public {
        NoDecimalsToken token = new NoDecimalsToken();
        token.mint(alice, 100 ether);
        vm.startPrank(alice);
        token.approve(address(mediatorA), type(uint256).max);
        mediatorA.relayTokens(address(token), bob, 7 ether);
        vm.stopPrank();
        (bool ok,) = _deliverAtoB(0);
        assertTrue(ok);
        IERC20Metadata copy = IERC20Metadata(_copyOf(address(token)));
        assertEq(copy.decimals(), 0, "zero decimals");
        assertEq(copy.balanceOf(bob), 7 ether, "the whole amount");
    }

    /// Claim: the destination refuses a deploy message whose decimals are above 255, in each of the four deploy forms.
    /// A mediator of this repository never sends one, because the source refuses first, so the message is forged here
    /// through the bridge context. Shows: the call fails, no copy exists, and no tokens were minted. Matters: the
    /// metadata of a copy is fixed at creation, so a wrong value must never create one.
    function test_theDestinationRefusesDecimalsAbove255InEveryDeployForm() public {
        address nativeToken = makeAddr("native token");
        bytes[4] memory forged = [
            abi.encodeWithSelector(
                TokenMediator.deployAndHandleBridgedTokens.selector, nativeToken, "N", "S", uint256(256), bob, 1 ether
            ),
            abi.encodeWithSelector(
                TokenMediator.deployAndHandleBridgedTokensAndCall.selector,
                nativeToken,
                "N",
                "S",
                uint256(256),
                bob,
                1 ether,
                hex"01"
            ),
            abi.encodeWithSelector(
                TokenMediator.deployAndHandleBridgedTokensWithFallback.selector,
                nativeToken,
                "N",
                "S",
                uint256(1000),
                bob,
                1 ether,
                carol
            ),
            abi.encodeWithSelector(
                TokenMediator.deployAndHandleBridgedTokensAndCallWithFallback.selector,
                nativeToken,
                "N",
                "S",
                type(uint256).max,
                bob,
                1 ether,
                hex"01",
                carol
            )
        ];
        for (uint256 i = 0; i < forged.length; i++) {
            (bool ok,) = ambB.execute(
                address(mediatorB), forged[i], address(mediatorA), bytes32(CHAIN_A), bytes32(i + 1), 2_000_000
            );
            assertFalse(ok, "the handler refuses");
            assertEq(mediatorB.bridgedTokenAddress(nativeToken), address(0), "no copy");
        }

        bytes memory good = abi.encodeWithSelector(
            TokenMediator.deployAndHandleBridgedTokens.selector, nativeToken, "N", "S", uint256(255), bob, 1 ether
        );
        (bool accepted,) =
            ambB.execute(address(mediatorB), good, address(mediatorA), bytes32(CHAIN_A), bytes32(uint256(9)), 2_000_000);
        assertTrue(accepted, "255 passes the same path");
        assertEq(IERC20Metadata(mediatorB.bridgedTokenAddress(nativeToken)).decimals(), 255);
    }
}
