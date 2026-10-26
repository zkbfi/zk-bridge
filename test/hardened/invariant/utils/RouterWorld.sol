// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {MockERC20} from "../../../../src/mocks/MockERC20.sol";
import {MockWrappedNative} from "../../../../src/mocks/MockWrappedNative.sol";
import {TokenMediator} from "../../../../src/hardened/mediator/TokenMediator.sol";
import {FeeRouter} from "../../../../src/hardened/mediator/FeeRouter.sol";
import {WETHOmnibridgeRouter} from "../../../../src/hardened/mediator/WETHOmnibridgeRouter.sol";
import {ITokenMediator} from "../../../../src/hardened/mediator/ITokenMediator.sol";
import {IWETH} from "../../../../src/hardened/mediator/IWETH.sol";
import {Multicall3} from "../../../../src/hardened/vendor/multicall3/Multicall3.sol";
import {
    MediatorFixture,
    MockAMB,
    DenyListToken,
    CoinRefuser,
    GasBurner,
    ContractWallet,
    RecordingReceiver
} from "../../mediator/utils/MediatorSupport.sol";

/// @title RouterWorld
/// @notice The two chains of the invariant suite: two mediators with a falling fee, each joined to a mock bridge, and on
/// each chain a wrapped native token, three fee routers, one wrapped native router and one Multicall3. It holds the
/// lists that the handler and the invariants both read: the native tokens, the bridged copies, and every account that can
/// hold a token. The two chains live in one test chain, as in `MediatorFixture`.
/// @dev Chain 0 is chain A (identifier 1) and chain 1 is chain B (identifier 369). Five native tokens exist. Tokens 0 and
/// 1 are native to A (a plain token and the wrapped native token of A), tokens 2 and 3 are native to B (a plain token and
/// the wrapped native token of B), and token 4 is native to A and refuses transfers to accounts on a deny list. The
/// universe has ten tokens: index `u` below 5 is the native token, and index `u + 5` is its bridged copy. The deny list
/// token never goes through a fee router, because a router leaves the tokens of a recipient that the token refuses
/// (see the contract notes of `FeeRouter`).
abstract contract RouterWorld is MediatorFixture {
    uint256 internal constant NATIVE_COUNT = 5;
    uint256 internal constant UNIVERSE = 10;
    uint256 internal constant ROUTERS_PER_CHAIN = 3;
    uint256 internal constant RECIPIENT_COUNT = 9;

    address internal treasury = makeAddr("treasury");
    address internal runner = makeAddr("runner");
    address internal stranger = makeAddr("stranger");
    /// @dev The account that sends the coin to a router in an attack. It is a holder, so the coin that it keeps counts.
    address internal attacker = makeAddr("attacker");
    address[] internal actors;
    /// @dev Four actors, then a contract that refuses the coin, a contract that burns its gas, a contract wallet, a
    /// receiver that records callbacks and a receiver that refuses them. Nine accounts that a message may name.
    address[] internal recipients;
    /// @dev The reward address of router `k` of each chain is `rewards[k]`: an account, a contract that refuses the
    /// coin, and a contract that burns its gas.
    address[] internal rewards;
    /// @dev Every account that may hold a token or a claim.
    address[] internal holders;

    MockWrappedNative[2] internal wrapped;
    FeeRouter[6] internal feeRouters;
    WETHOmnibridgeRouter[2] internal wethRouters;
    Multicall3 internal multicall;
    DenyListToken internal denyToken;
    RecordingReceiver internal refusingReceiver;

    address[] internal natives;
    address[] internal copies;
    uint256[] internal homes;

    constructor() {
        TokenMediator.MediatorTerms memory termsA = _noTerms();
        termsA.feeRecipient = treasury;
        termsA.feeStartRate = 3e16;
        termsA.feeStepRate = 5e15;
        termsA.feeFloorRate = 5e15;
        termsA.feeStepPeriod = 30 days;
        TokenMediator.MediatorTerms memory termsB = _noTerms();
        termsB.feeRecipient = treasury;
        termsB.feeStartRate = 1e16;
        termsB.feeStepRate = 1e15;
        termsB.feeFloorRate = 1e15;
        termsB.feeStepPeriod = 20 days;
        _deployMediators(termsA, termsB);
        _deployTokens();
        _deployRouters();
        _listAccounts();
        _listCopies();
    }

    // ---------------------------------------------------------------------------------------------------- views

    function mediatorOf(uint256 chain) public view returns (TokenMediator) {
        return chain == 0 ? mediatorA : mediatorB;
    }

    function bridgeOf(uint256 chain) public view returns (MockAMB) {
        return chain == 0 ? ambA : ambB;
    }

    function nativeAt(uint256 index) external view returns (address) {
        return natives[index];
    }

    function copyAt(uint256 index) external view returns (address) {
        return copies[index];
    }

    function homeOf(uint256 index) public view returns (uint256) {
        return homes[index];
    }

    function runnerAddress() external view returns (address) {
        return runner;
    }

    function strangerAddress() external view returns (address) {
        return stranger;
    }

    function holderCount() external view returns (uint256) {
        return holders.length;
    }

    function holderAt(uint256 index) external view returns (address) {
        return holders[index];
    }

    function rewardAt(uint256 index) external view returns (address) {
        return rewards[index];
    }

    function feeRouterAt(uint256 chain, uint256 index) public view returns (FeeRouter) {
        return feeRouters[chain * ROUTERS_PER_CHAIN + index];
    }

    function wethRouterAt(uint256 chain) external view returns (WETHOmnibridgeRouter) {
        return wethRouters[chain];
    }

    function wrappedAt(uint256 chain) external view returns (MockWrappedNative) {
        return wrapped[chain];
    }

    /// @notice The token of the universe: a native token below 5, and the bridged copy of `index - 5` from 5.
    function tokenAt(uint256 universeIndex) public view returns (address) {
        return universeIndex < NATIVE_COUNT ? natives[universeIndex] : copies[universeIndex - NATIVE_COUNT];
    }

    /// @notice The chain where the token of the universe lives.
    function chainOfToken(uint256 universeIndex) public view returns (uint256) {
        uint256 home = homes[universeIndex % NATIVE_COUNT];
        return universeIndex < NATIVE_COUNT ? home : 1 - home;
    }

    /// @notice Whether the token of the universe is the wrapped native token of its own chain. A holder of it also
    /// holds the coin, because the routers unwrap.
    function isWrappedNativeOfItsChain(uint256 universeIndex) public pure returns (bool) {
        return universeIndex == 1 || universeIndex == 3;
    }

    /// @notice The balance of a token that may not exist yet. A copy has no code before its first delivery.
    function balanceOrZero(address token, address account) public view returns (uint256) {
        if (token.code.length == 0) return 0;
        return IERC20(token).balanceOf(account);
    }

    function supplyOrZero(address token) public view returns (uint256) {
        if (token.code.length == 0) return 0;
        return IERC20(token).totalSupply();
    }

    /// @notice What `account` holds of a token of the universe, counting the coin for the wrapped native token of its
    /// chain: a payout may arrive as the token or as the coin, and the sum is the same value.
    function holding(uint256 universeIndex, address account) public view returns (uint256) {
        uint256 amount = balanceOrZero(tokenAt(universeIndex), account);
        if (isWrappedNativeOfItsChain(universeIndex)) amount += account.balance;
        return amount;
    }

    /// @notice What the holders hold of a token of the universe, in the sense of `holding`.
    function heldByHolders(uint256 universeIndex) public view returns (uint256 total) {
        for (uint256 i = 0; i < holders.length; i++) {
            total += holding(universeIndex, holders[i]);
        }
    }

    /// @notice The sum of the claims of the holders on a token of the universe, on the mediator of its chain.
    function claimableOfHolders(uint256 universeIndex) public view returns (uint256 total) {
        TokenMediator mediator = mediatorOf(chainOfToken(universeIndex));
        address token = tokenAt(universeIndex);
        for (uint256 i = 0; i < holders.length; i++) {
            total += mediator.claimable(token, holders[i]);
        }
    }

    // ------------------------------------------------------------------------------------------------ deployment

    function _deployTokens() private {
        wrapped[0] = new MockWrappedNative();
        wrapped[1] = new MockWrappedNative();
        denyToken = new DenyListToken();
        _addNative(address(new MockERC20("Plain A", "PLA")), 0);
        _addNative(address(wrapped[0]), 0);
        _addNative(address(new MockERC20("Plain B", "PLB")), 1);
        _addNative(address(wrapped[1]), 1);
        _addNative(address(denyToken), 0);
    }

    function _deployRouters() private {
        multicall = new Multicall3();
        rewards.push(makeAddr("reward account"));
        rewards.push(address(new CoinRefuser()));
        rewards.push(address(new GasBurner()));
        for (uint256 chain = 0; chain < 2; chain++) {
            for (uint256 k = 0; k < ROUTERS_PER_CHAIN; k++) {
                feeRouters[chain * ROUTERS_PER_CHAIN + k] = new FeeRouter(
                    ITokenMediator(address(mediatorOf(chain))), IWETH(address(wrapped[chain])), runner, rewards[k]
                );
            }
            wethRouters[chain] = new WETHOmnibridgeRouter(
                ITokenMediator(address(mediatorOf(chain))), IWETH(address(wrapped[chain]))
            );
        }
    }

    function _listAccounts() private {
        for (uint256 i = 0; i < 4; i++) {
            actors.push(address(uint160(0x1000 + i)));
            recipients.push(actors[i]);
        }
        refusingReceiver = new RecordingReceiver();
        refusingReceiver.setRefuse(true);
        recipients.push(address(new CoinRefuser()));
        recipients.push(address(new GasBurner()));
        recipients.push(address(new ContractWallet()));
        recipients.push(address(new RecordingReceiver()));
        recipients.push(address(refusingReceiver));
        for (uint256 i = 0; i < recipients.length; i++) {
            holders.push(recipients[i]);
        }
        for (uint256 i = 0; i < rewards.length; i++) {
            holders.push(rewards[i]);
        }
        holders.push(runner);
        holders.push(stranger);
        holders.push(attacker);
        for (uint256 i = 0; i < feeRouters.length; i++) {
            holders.push(address(feeRouters[i]));
        }
        holders.push(address(wethRouters[0]));
        holders.push(address(wethRouters[1]));
    }

    /// @dev The address where the copy of each native token will be, from the factory of the other chain. The copy has no
    /// code until its first delivery.
    function _listCopies() private {
        for (uint256 i = 0; i < natives.length; i++) {
            TokenMediator away = mediatorOf(1 - homes[i]);
            copies.push(away.tokenFactory().predictAddress(away.remoteChainId(), natives[i]));
        }
    }

    function _addNative(address token, uint256 home) private {
        natives.push(token);
        homes.push(home);
    }
}
