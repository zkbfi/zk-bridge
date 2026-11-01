// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {BridgedToken} from "../../../src/hardened/mediator/BridgedToken.sol";
import {TokenFactory} from "../../../src/hardened/mediator/TokenFactory.sol";
import {MediatorFixture, RecordingReceiver, CoinRefuser} from "./utils/MediatorSupport.sol";

/// @notice Tests of the bridged token and its factory: who may mint and burn, the permit, the transfer callback, the
/// allowance helpers, and the deterministic deployment.
contract BridgedTokenTest is MediatorFixture {
    event Transfer(address indexed from, address indexed to, uint256 value, bytes data);

    BridgedToken internal copy;
    address internal signer;
    uint256 internal signerKey;

    function setUp() public override {
        super.setUp();
        (signer, signerKey) = makeAddrAndKey("signer");
        _bridgeAtoB(alice, address(tokenA), signer, 100 ether);
        copy = BridgedToken(_copyOf(address(tokenA)));
    }

    // ------------------------------------------------------------------------------------------------ mint and burn

    function test_onlyTheMediatorCanMint() public {
        vm.prank(bob);
        vm.expectRevert(abi.encodeWithSelector(BridgedToken.NotMediator.selector, bob));
        copy.mint(bob, 1);

        vm.prank(address(mediatorB));
        assertTrue(copy.mint(bob, 5));
        assertEq(copy.balanceOf(bob), 5);
    }

    function test_onlyTheMediatorCanBurnAndItBurnsItsOwnBalance() public {
        vm.prank(signer);
        vm.expectRevert(abi.encodeWithSelector(BridgedToken.NotMediator.selector, signer));
        copy.burn(1);

        vm.prank(address(mediatorB));
        copy.mint(address(mediatorB), 7);
        vm.prank(address(mediatorB));
        copy.burn(7);
        assertEq(copy.balanceOf(address(mediatorB)), 0);
        assertEq(copy.totalSupply(), 100 ether);
    }

    function test_theTokenHasNoOwnerAndNoUpgradePath() public view {
        bytes4[5] memory selectors = [
            bytes4(keccak256("owner()")),
            bytes4(keccak256("transferOwnership(address)")),
            bytes4(keccak256("claimTokens(address,address)")),
            bytes4(keccak256("upgradeTo(address)")),
            bytes4(keccak256("implementation()"))
        ];
        for (uint256 i = 0; i < selectors.length; i++) {
            (bool ok,) = address(copy).staticcall(abi.encodeWithSelector(selectors[i], address(1), address(2)));
            assertFalse(ok);
        }
    }

    function test_bridgeContractIsTheMediatorAndTheMetadataIsSet() public view {
        assertEq(copy.bridgeContract(), address(mediatorB));
        assertEq(copy.name(), "Token A from Chain A");
        assertEq(copy.symbol(), "zTKA");
        assertEq(copy.decimals(), 18);
    }

    // ------------------------------------------------------------------------------------------------ permit

    function _permitDigest(address owner, address spender, uint256 value, uint256 nonce, uint256 deadline)
        internal
        view
        returns (bytes32)
    {
        bytes32 domain = keccak256(
            abi.encode(
                keccak256("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)"),
                keccak256(bytes("Token A from Chain A")),
                keccak256(bytes("1")),
                block.chainid,
                address(copy)
            )
        );
        bytes32 structHash = keccak256(
            abi.encode(
                keccak256("Permit(address owner,address spender,uint256 value,uint256 nonce,uint256 deadline)"),
                owner,
                spender,
                value,
                nonce,
                deadline
            )
        );
        return keccak256(abi.encodePacked("\x19\x01", domain, structHash));
    }

    function test_permitSetsTheAllowanceAndBumpsTheNonce() public {
        uint256 deadline = block.timestamp + 1 hours;
        bytes32 digest = _permitDigest(signer, bob, 25 ether, 0, deadline);
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(signerKey, digest);

        assertEq(copy.nonces(signer), 0);
        copy.permit(signer, bob, 25 ether, deadline, v, r, s);
        assertEq(copy.allowance(signer, bob), 25 ether);
        assertEq(copy.nonces(signer), 1);

        vm.prank(bob);
        copy.transferFrom(signer, carol, 25 ether);
        assertEq(copy.balanceOf(carol), 25 ether);
    }

    function test_theDomainSeparatorFollowsTheStandard() public view {
        bytes32 expected = keccak256(
            abi.encode(
                keccak256("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)"),
                keccak256(bytes("Token A from Chain A")),
                keccak256(bytes("1")),
                block.chainid,
                address(copy)
            )
        );
        assertEq(copy.DOMAIN_SEPARATOR(), expected);
    }

    function test_aPermitCannotBeReplayed() public {
        uint256 deadline = block.timestamp + 1 hours;
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(signerKey, _permitDigest(signer, bob, 1 ether, 0, deadline));
        copy.permit(signer, bob, 1 ether, deadline, v, r, s);
        // The second use recovers a different signer, because the nonce changed.
        vm.expectPartialRevert(BridgedToken.PermitSignerInvalid.selector);
        copy.permit(signer, bob, 1 ether, deadline, v, r, s);
    }

    function test_anExpiredPermitIsRefused() public {
        uint256 deadline = block.timestamp - 1;
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(signerKey, _permitDigest(signer, bob, 1 ether, 0, deadline));
        vm.expectRevert(abi.encodeWithSelector(BridgedToken.PermitExpired.selector, deadline));
        copy.permit(signer, bob, 1 ether, deadline, v, r, s);
    }

    function test_aPermitSignedByAnotherKeyIsRefused() public {
        (, uint256 otherKey) = makeAddrAndKey("other");
        uint256 deadline = block.timestamp + 1 hours;
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(otherKey, _permitDigest(signer, bob, 1 ether, 0, deadline));
        vm.expectPartialRevert(BridgedToken.PermitSignerInvalid.selector);
        copy.permit(signer, bob, 1 ether, deadline, v, r, s);
        assertEq(copy.allowance(signer, bob), 0);
    }

    function test_aPermitWithTheMalleableTwinOfASignatureIsRefused() public {
        uint256 deadline = block.timestamp + 1 hours;
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(signerKey, _permitDigest(signer, bob, 1 ether, 0, deadline));
        uint256 curveOrder = 0xFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFEBAAEDCE6AF48A03BBFD25E8CD0364141;
        bytes32 twinS = bytes32(curveOrder - uint256(s));
        uint8 twinV = v == 27 ? 28 : 27;
        vm.expectRevert(abi.encodeWithSelector(BridgedToken.PermitSignerInvalid.selector, address(0), signer));
        copy.permit(signer, bob, 1 ether, deadline, twinV, r, twinS);
        // The original still works.
        copy.permit(signer, bob, 1 ether, deadline, v, r, s);
    }

    function test_aPermitFromAnOwnerWithTheZeroAddressSignerIsRefused() public {
        vm.expectRevert(abi.encodeWithSelector(BridgedToken.PermitSignerInvalid.selector, address(0), address(0)));
        copy.permit(address(0), bob, 1 ether, block.timestamp + 1, 27, bytes32(0), bytes32(0));
    }

    // ------------------------------------------------------------------------------------------------ transferAndCall

    function test_transferAndCallMovesTokensAndCallsAReceiverContract() public {
        RecordingReceiver receiver = new RecordingReceiver();
        vm.expectEmit(true, true, false, true, address(copy));
        emit Transfer(signer, address(receiver), 3 ether, hex"abcd");
        vm.prank(signer);
        assertTrue(copy.transferAndCall(address(receiver), 3 ether, hex"abcd"));
        assertEq(copy.balanceOf(address(receiver)), 3 ether);
        assertEq(receiver.calls(), 1);
        assertEq(receiver.lastCaller(), address(copy));
        assertEq(receiver.lastToken(), signer, "the callback carries the sender");
        assertEq(receiver.lastValue(), 3 ether);
        assertEq(receiver.lastData(), hex"abcd");
    }

    function test_transferAndCallToAnAccountWithNoCodeOnlyMovesTokens() public {
        vm.prank(signer);
        assertTrue(copy.transferAndCall(bob, 1 ether, "x"));
        assertEq(copy.balanceOf(bob), 1 ether);
    }

    function test_transferAndCallUndoesTheTransferWhenTheReceiverCallFails() public {
        CoinRefuser noCallback = new CoinRefuser();
        vm.prank(signer);
        vm.expectRevert(abi.encodeWithSelector(BridgedToken.TransferCallFailed.selector, address(noCallback)));
        copy.transferAndCall(address(noCallback), 1 ether, "");
        assertEq(copy.balanceOf(signer), 100 ether);
    }

    // ------------------------------------------------------------------------------------------------ allowance helpers

    function test_increaseAndDecreaseAllowance() public {
        vm.startPrank(signer);
        assertTrue(copy.increaseAllowance(bob, 10 ether));
        assertTrue(copy.increaseAllowance(bob, 5 ether));
        assertEq(copy.allowance(signer, bob), 15 ether);
        assertTrue(copy.decreaseAllowance(bob, 6 ether));
        assertEq(copy.allowance(signer, bob), 9 ether);
        vm.expectRevert(
            abi.encodeWithSignature("ERC20InsufficientAllowance(address,uint256,uint256)", bob, 9 ether, 10 ether)
        );
        copy.decreaseAllowance(bob, 10 ether);
        vm.stopPrank();
    }

    // ------------------------------------------------------------------------------------------------ factory

    function test_onlyTheMediatorCanDeployThroughTheFactory() public {
        TokenFactory factory = mediatorB.tokenFactory();
        vm.prank(bob);
        vm.expectRevert(abi.encodeWithSelector(TokenFactory.NotMediator.selector, bob));
        factory.deploy("N", "S", 18, CHAIN_A, address(0x1234));
    }

    function test_theFactoryDeploysAtThePredictedAddressOnce() public {
        TokenFactory factory = mediatorB.tokenFactory();
        address native = address(0x1234);
        address predicted = factory.predictAddress(CHAIN_A, native);
        assertEq(predicted.code.length, 0);

        vm.prank(address(mediatorB));
        address deployed = factory.deploy("Name", "SYM", 9, CHAIN_A, native);
        assertEq(deployed, predicted);
        assertEq(BridgedToken(deployed).name(), "Name");
        assertEq(BridgedToken(deployed).symbol(), "SYM");
        assertEq(BridgedToken(deployed).decimals(), 9);
        assertEq(BridgedToken(deployed).bridgeContract(), address(mediatorB));

        vm.prank(address(mediatorB));
        vm.expectRevert();
        factory.deploy("Name", "SYM", 9, CHAIN_A, native);
    }

    function test_theFactoryKeepsNoParametersAfterADeployment() public view {
        TokenFactory factory = mediatorB.tokenFactory();
        (string memory name, string memory symbol, uint8 decimals, address mediator) = factory.parameters();
        assertEq(bytes(name).length, 0);
        assertEq(bytes(symbol).length, 0);
        assertEq(decimals, 0);
        assertEq(mediator, address(mediatorB));
    }

    function test_theAddressDependsOnTheHomeChainAndTheNativeTokenOnly() public view {
        TokenFactory factory = mediatorB.tokenFactory();
        address one = factory.predictAddress(CHAIN_A, address(0x1111));
        assertTrue(one != factory.predictAddress(CHAIN_A, address(0x2222)));
        assertTrue(one != factory.predictAddress(CHAIN_B, address(0x1111)));
        assertEq(one, factory.predictAddress(CHAIN_A, address(0x1111)));
    }
}
