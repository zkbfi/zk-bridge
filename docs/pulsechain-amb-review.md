# Review of the PulseChain bridge: the second WPLS path, and lessons for our bridge

Date of research: 2026-10-25. All on-chain reads use `cast call` against the keyed valve.city endpoint for chain 369 (PulseChain, written `$PLS`) and chain 1 (Ethereum, written `$ETH`). Explorer facts come from the Blockscout APIs of `api.scan.pulsechain.com` and `eth.blockscout.com`.

In this document, "AMB" means the Arbitrary Message Bridge of the OmniBridge (TokenBridge) code base: the validator-signed message layer under the token mediators.

## Summary

The premise needs one correction. I found **no second AMB**. The PulseChain bridge has one AMB pair, and both AMB proxies are still at implementation version 1. What PulseChain added 18 days after launch is a **second token mediator pair, dedicated to WPLS**, a **WPLS router** that unwraps to native PLS, and a **new WPLS token on Ethereum**. The new mediator pair uses the same AMB pair as the first.

The reason is visible on chain. The first, general mediator pair bridged WPLS like any other PulseChain token. A user bridged WPLS on 2023-05-16, the day after launch. The Ethereum mediator then auto-deployed a WPLS copy through its token factory (`0x97Ac…5341`). OmniBridge cannot re-point a token that is already bridged: `setCustomTokenAddressPair` requires `bridgedTokenAddress(native) == 0`. So to get a different Ethereum WPLS (a pre-deployed token, a fixed pair set at initialization, and a router that delivers native PLS), the team deployed a whole new mediator pair. Two WPLS tokens on Ethereum now exist side by side, each fully backed.

I could not find a public statement of the team's motive. The motive in this summary is my inference from the code and the state, not a quote.

## 1. The deployments

Every contract below was deployed by the same account, `0x30e22ab6e6B576e6A9c5dD73191237a9A5c72539`, on both chains. Sources: deployer creation lists from `https://api.scan.pulsechain.com/api/v2/addresses/0x30e2…2539/transactions` and `https://eth.blockscout.com/api/v2/addresses/0x30e2…2539/transactions`.

Source of the address roles: the official front end. `https://bridge.pulsechain.com/version.json` names the IPFS build `bafybeidiqi4vctdd4b4w25aknradtdioh63phuqmobyu5fp6kutfjih36q` and the repository `https://gitlab.com/pulsechaincom/pulsechain-bridge-server`. The script of that build (`https://bridge.mypinata.cloud/ipfs/bafybeidiqi4vctdd4b4w25aknradtdioh63phuqmobyu5fp6kutfjih36q/`, file `main.3cb38ca5.js`) holds this mainnet configuration: `homeAmbAddress 0x6ef79F…8b2b`, `foreignAmbAddress 0xd0764F…636c`, `homeMediatorAddress 0x4fD0aa…51Ef`, `foreignMediatorAddress 0x1715a3…A10D`, `homePlsMediatorAddress 0x0e18d0…3996`, `foreignPlsMediatorAddress 0xe20E33…68bF`, `oldForeignWPLSAddress 0x97Ac4a…5341`, and the routers `1: 0x8AC4ae…0f55`, `369: 0xf868dA…8499`.

### 1.1 The AMB pair (one pair only)

| Role | Chain | Proxy | Implementation | Created |
|---|---|---|---|---|
| Home AMB | PulseChain | `0x6ef79FD6f9f840264332884240539Ed7A2dA8b2b` | `0xD346C53c659d9D1dAE7A915DD2E6BFEAB5cb50B8` (`HomeAMB`, solc 0.4.24) | 2023-05-15 08:52 UTC |
| Foreign AMB | Ethereum | `0xd0764FAe29E0a6a96fF685f71CfC685456D5636c` | `0xe98699957d3504aCD57ffF861E4b77b57eB02467` (`ForeignAMB`, solc 0.4.24) | 2023-05-15 08:54 UTC |

On-chain configuration (`cast call <proxy> '<getter>' --rpc-url $PLS` or `$ETH`):

| Getter | Home AMB | Foreign AMB |
|---|---|---|
| `version()` (proxy upgrade count) | 1 | 1 |
| `upgradeabilityOwner()` | `0x75225BD35A4D2D897b6c5044e2CB6e9840dA32E9` | `0xDf5d165A7EB95D26355c56d53799B7da1240e585` |
| `owner()` | `0x415F4919f96c1843AF730d8293E02B42A160d838` | `0x0Fb17ADb94627EeA37BB7EF12f85aB4590e3805F` |
| `validatorContract()` | `0x0FD542ff87cD22DB5402c92deCB13d2bdfB995b7` | `0x2fa878Ab3F87CC1C9737Fc071108F904c0B0C95d` |
| `requiredSignatures()` | 5 | 5 |
| `maxGasPerTx()` | 2,000,000 | 2,000,000 |
| `requiredBlockConfirmations()` | 65 | 65 |
| `getBridgeInterfacesVersion()` | 6.2.0 | 6.2.0 |
| `getBridgeMode()` | `0x2544fbb9` | `0x2544fbb9` |
| `sourceChainId()` / `destinationChainId()` | 369 / 1 | 1 / 369 |
| `gasPrice()` | 4e15 | 1e11 |

`version() == 1` on both proxies means that nobody upgraded either AMB after the first implementation. So no AMB change was made for PLS.

The PulseChain explorer also lists other `HomeAMB` and `ForeignAMB` contracts (for example `0x774ea23f…9583`, `0x4257322e…2ec7`). PulseChain copied the Ethereum state at its fork in May 2023, so those are copies of Gnosis Chain deployments. The PulseChain deployer did not create them, and the front end does not use them. Source: `https://api.scan.pulsechain.com/api/v2/search?q=HomeAMB`.

### 1.2 The first mediator pair (general tokens)

| Role | Chain | Proxy | Implementation | Created |
|---|---|---|---|---|
| Home mediator | PulseChain | `0x4fD0aaa7506f3d9cB8274bdB946Ec42A1b8751Ef` | `0xe64b29DEB76616FF5a39E48EA33352Dff62a72E4` (`HomeOmnibridge`) | 2023-05-15 09:03 UTC |
| Foreign mediator | Ethereum | `0x1715a3E4A142d8b698131108995174F37aEBA10D` | `0xB7DF1E00ae030e966E635ede273625240546B873` (`ForeignOmnibridge`) | 2023-05-15 09:04 UTC |
| Token factory | Ethereum | `0x98bf93ebf5c380C0e6Ae8e192A7e2AE08edAcc02` | — | 2023-05-15 |
| ETH router (`WETHOmnibridgeRouter`) | Ethereum | `0x8AC4ae65b3656e26dC4e0e69108B392283350f55` | — | 2023-05-15 |

- `cast call 0x4fD0…51Ef 'bridgeContract()(address)' --rpc-url $PLS` returns `0x6ef79F…8b2b`. The other side is `0x1715…A10D`.
- `cast call 0x1715…A10D 'bridgeContract()(address)' --rpc-url $ETH` returns `0xd0764F…636c`. `requestGasLimit()` returns 2,000,000. `tokenFactory()` returns `0x98bf…cc02`.
- The ETH router: `bridge()` is `0x1715…A10D` and `WETH()` is `0xC02a…6Cc2`.
- Fee manager on the home mediator: `0xBa86ca0A…01dc4`. Gas limit manager: `0x2650B134…0503`.
- The proxy owner of both mediators: `upgradeabilityOwner()` on the home mediator returns `0xF3BEC23E2f9F9a6ED63191e9dB5EAdDBF97555C9`.

### 1.3 The second mediator pair (WPLS only), its router and its token

| Role | Chain | Address | Implementation | Created |
|---|---|---|---|---|
| Home WPLS mediator | PulseChain | `0x0e18d0d556b652794EF12Bf68B2dC857EF5f3996` | `0xE38a267501c29347b4B430E70e5B355FC1170faA` (`HomeOmnibridge`, a reduced variant) | 2023-06-02 11:49 UTC |
| Foreign WPLS mediator | Ethereum | `0xe20E337DB2a00b1C37139c873B92a0AAd3F468bF` | `0xb825Fd1E322061AaC2aC8b3CDE4Ce18B93FAE276` (`ForeignOmnibridge`) | 2023-06-02 11:50 UTC |
| WPLS router (`WPLSOmnibridgeRouter`) | PulseChain | `0xf868dA5a5D5f799CEe2205d8FD1f5aD2c4A28499` | — | 2023-06-02 11:49 UTC |
| New WPLS on Ethereum (`PermittableToken`) | Ethereum | `0xA882606494D86804B5514E07e6Bd2D6a6eE6d68A` | — | 2023-06-02 11:50 UTC |
| Old WPLS on Ethereum (`TokenProxy`, auto-deployed) | Ethereum | `0x97Ac4a2439A47c07ad535bb1188c989dae755341` | factory image | 2023-05-16 01:38 UTC |

On-chain facts:

- `cast call 0x0e18…3996 'bridgeContract()(address)' --rpc-url $PLS` returns `0x6ef79F…8b2b`, **the same home AMB as the first pair**.
- `cast call 0xe20E…68bF 'bridgeContract()(address)' --rpc-url $ETH` returns `0xd0764F…636c`, **the same foreign AMB**.
- `wplsContract()` on the home WPLS mediator returns `0xA1077a…9a27` (WPLS on PulseChain). `bridgedTokenAddress(WPLS)` returns `0xA882…d68A` on both WPLS mediators.
- `bridgedTokenAddress(WPLS)` on the first foreign mediator returns `0x97Ac…5341`, and `isTokenRegistered(0x97Ac…5341)` returns true. `executionMaxPerTx` and `maxPerTx` for it are 5e29, so the old path is still open.
- Owners: `owner()` of `0xA882…d68A` is `0xe20E…68bF`, and `owner()` of `0x97Ac…5341` is `0x1715…A10D`.
- `name()` of both tokens is `"Wrapped Pulse from PulseChain"`.
- The WPLS router: `bridge()` is `0x0e18…3996`, `WPLS()` is `0xA1077a…9a27`, and `owner()` is `0x4792865c793a2Db4DEbDB30fCb8E38C45B09e7dF`.
- `requestGasLimit()` on the foreign WPLS mediator returns 2,000,000.
- The WPLS mediator has its own fee manager (`0x91fD47AF…6911`) and gas limit manager (`0x49da1539…61F3`).

Supply and backing on 2026-10-25:

| Path | WPLS locked on PulseChain (`WPLS.balanceOf(mediator)`) | Supply on Ethereum (`totalSupply()`) |
|---|---|---|
| First pair, old token `0x97Ac…` | 47,044,580,523.14 WPLS (47044580523143449957205169846 wei) | 47044580523143449957205169846 |
| WPLS pair, new token `0xA882…` | 77,211,026,336.55 WPLS (77211026336546837502179995213 wei) | 77206746200332973361062738612 |

Both representations are fully backed. The small surplus on the WPLS pair is consistent with fees retained by the mediator, but I did not trace it.

Creation of the old token: transaction `0xd70c779371d7cda9dd99644915d2a24d79122b1da9a43fda61904e6dbbe67bf5` on Ethereum, block 17,269,069, 2023-05-16 01:38:11 UTC, method `safeExecuteSignaturesWithAutoGasLimit`, sent by `0x4F6B7726DDA7F4A7bDDa363E6442D01d6Ca3c2f6` (source: `https://eth.blockscout.com/api/v2/transactions/0xd70c…bf5`). So the copy came from a normal user transfer that the first mediator executed, about 17 hours after the mediators existed.

Not mine to confirm: the front end still lists `0x97Ac…` as `oldForeignWPLSAddress` and routes it through the first foreign mediator back to WPLS on PulseChain. That is a migration path for holders of the old token. I found no announcement of it.

## 2. What differs, and why the first path was a problem for PLS

### 2.1 The AMB: no difference

The WPLS pair sends through the same AMB proxies, with the same validators, the same 5 required signatures, the same 2,000,000 `maxGasPerTx`, the same message format (interface 6.2.0) and the same executor model. The AMB has no field for native value in a message. The PLS path does not change that. It moves WPLS as a token and unwraps it in a router, exactly as the ETH path moves WETH.

### 2.2 The home mediator: two different `HomeOmnibridge` builds

I fetched both verified sources from `https://api.scan.pulsechain.com/api/v2/smart-contracts/<address>` and diffed them.

First pair (`0xe64b29…72E4`, constructor suffix `" from Ethereum"`):

- It contains `TokenFactory`, `TokenFactoryConnector`, `TokenProxy`, `TokensRelayer` and `MultiTokenForwardingRulesManager`.
- It accepts any token. An unregistered native token is registered on first relay (`_initializeTokenBridgeLimits` inside `bridgeSpecificActionsOnTokenTransfer`).
- The first message for a native token carries `deployAndHandleBridgedTokens(token, name, symbol, decimals, …)`. The other side then deploys a copy through its token factory and stores the pair for good.
- It has `setCustomTokenAddressPair`, guarded by `require(bridgedTokenAddress(_nativeToken) == address(0))`. The owner can set a custom pair only **before** the first bridge of that token.
- It has oracle-driven and manual lanes (`requireToPassMessage` against `requireToConfirmMessage`, chosen by forwarding rules), and `upgradeToReverseMode`.

WPLS pair (`0xE38a26…0faA`, no constructor arguments):

- It has no token factory, no forwarding rules, no `setCustomTokenAddressPair` and no deploy messages.
- `initialize(…, _wplsContract, _bridgedWPLSContract)` calls `_setWPLSContract`, `_setTokenAddressPair(_wplsContract, _bridgedWPLSContract)` and `_initializeTokenBridgeLimits(_wplsContract, 18)`. The pair is fixed at initialization, against a token deployed in advance (`0xA882…`, owned by the foreign WPLS mediator).
- `_relayTokens` has `require(address(token) == addressStorage[WPLS_CONTRACT])`, and `onTokenTransfer` has `require(nativeTokenAddress(msg.sender) == addressStorage[WPLS_CONTRACT])`. It moves WPLS and nothing else.
- `bridgeSpecificActionsOnTokenTransfer` has `require(isTokenRegistered(_token))` in place of auto-registration.
- `_passMessage` always calls `requireToPassMessage` (one lane).
- `_handleTokens` returns the value after the fee, and the receiver callback gets that net value. In the first build, the callback gets the gross value. That is a real defect in the first build for any router that unwraps: the router would be told it received more than it did.

### 2.3 The router: native PLS delivery

`WPLSOmnibridgeRouter` (`0xf868…8499`, verified source at `https://api.scan.pulsechain.com/api/v2/smart-contracts/0xf868dA5a5D5f799CEe2205d8FD1f5aD2c4A28499`):

```solidity
function onTokenBridged(address _token, uint256 _value, bytes memory _data) external {
    require(_token == address(WPLS));
    require(msg.sender == address(bridge));
    require(_data.length == 20);
    WPLS.withdraw(_value);
    AddressHelper.safeSendValue(payable(Bytes.bytesToAddress(_data)), _value);
}
// AddressHelper.safeSendValue:
if (!(_receiver).send(_value)) { new Sacrifice{ value: _value }(_receiver); }
// Sacrifice: constructor(address payable _recipient) payable { selfdestruct(_recipient); }
```

Two properties matter. First, `send` forwards only the 2,300 gas stipend, so a receiver cannot burn the gas of the delivery. Second, a receiver that refuses the coin still gets it, by `selfdestruct`. The router never reverts because of the receiver.

The front end sends PLS out with the router (`wrapAndRelayTokens(_receiver)`, payable) and brings PLS in by `transferAndCall` on the Ethereum WPLS with router data (source: the `NATIVE` and `erc677` branches in `main.3cb38ca5.js`). I did not trace a live delivery transaction end to end.

### 2.4 Why the first path was a problem

These are the facts:

1. WPLS was bridged through the general pair on day one, and the Ethereum mediator deployed `0x97Ac…` as a permanent factory copy.
2. OmniBridge allows a custom pair only before the first bridge, so that copy could not be replaced on the general pair.
3. Eighteen days later the team deployed a pre-made token (`0xA882…`), a mediator pair that moves only WPLS with the pair fixed at initialization, and a router bound to that pair.
4. The general home build passes the gross value to the receiver callback. The WPLS build passes the net value.

My inference: the team wanted an Ethereum WPLS that it chose (a pre-deployed `PermittableToken` with a controlled pair), a native PLS delivery path with fee-correct callbacks, and its own fee and gas limit managers. The general pair could not give the first item once the factory copy existed. A new mediator pair was the only way, because neither mediator has a function to re-point a registered token. The cost is a split: two "Wrapped Pulse from PulseChain" tokens on Ethereum, about 47 billion and 77 billion WPLS each, with a migration route in the front end.

### 2.5 Public discussion

I found no incident report, forum thread or announcement about the second pair, stuck PLS, or gas limit failures. Third-party token pages list both Ethereum WPLS contracts as "WPLS (Wrapped Pulse from PulseChain)", which shows the user-facing confusion: `https://dexrabbit.bitquery.io/eth/token/0x97ac4a2439a47c07ad535bb1188c989dae755341` and `https://dexrabbit.bitquery.io/eth/token/0xa882606494d86804b5514e07e6bd2d6a6ee6d68a`. DefiLlama tracks the bridge at `https://defillama.com/protocol/pulsechain-bridge`. I did not read the GitLab repository history: the front end names `https://gitlab.com/pulsechaincom/pulsechain-bridge-server`, and a diff of its commits from May to June 2023 could confirm the motive.

## 3. Lessons for our bridge

### 3.1 A receiver can burn the gas of an unwrap and strand the wrapped token (change needed)

The PulseChain router sends with a 2,300 gas stipend and falls back to a forced send. Our routers send with all the gas left:

- `src/hardened/mediator/WETHOmnibridgeRouter.sol:73`: `(bool sent,) = receiver.call{value: value}("");`. On failure, lines 75 and 76 wrap again and transfer.
- `src/hardened/mediator/FeeRouter.sol:293` (`_tryPay`) and `:299` (`_payNative`) do the same.

The failure chain:

1. A release with a call gets `RELEASE_GAS_LIMIT + CALLBACK_GAS_LIMIT` = 1,000,000 gas (`TokenMediator.sol:141-143`, `:784`).
2. `TokenMediator._callback` (`TokenMediator.sol:946-952`) calls `onTokenBridged` with all its gas left. A failure only emits `CallbackFailed`, and the tokens stay with the router.
3. The router calls the receiver with 63/64 of its gas. A receiver that burns all of it leaves the router about 1/64. With roughly 800,000 gas at that point, that is about 12,000 gas.
4. `WETH.deposit` plus `safeTransfer` cost more than that. So `onTokenBridged` reverts, the `withdraw` reverts with it, and the wrapped token stays in the router.
5. Our routers have no owner and no `claimTokens` (by design, `WETHOmnibridgeRouter.sol:8-18`). The tokens are lost for good. The message is final (`MessageBridge.sol:290-297`).

The gas numbers in steps 3 and 4 are my estimate, not a measurement. A receiver that refuses cheaply (a plain revert) is handled correctly today. Only a receiver that burns gas breaks the fallback.

Change: cap the gas of the coin send, for example `receiver.call{value: value, gas: NATIVE_SEND_GAS}("")` with a constant sized for a smart wallet (for example 50,000), and keep the wrap fallback. Do the same in `FeeRouter._tryPay` and `_payNative`. As an alternative, copy the OmniBridge pattern: `send`, then a `Sacrifice` contract that self-destructs to the receiver. Under the Ethereum Cancun rules (EIP-6780), self-destruct in the creating transaction still moves the balance. I did not confirm which rule set PulseChain runs. Add a test with a receiver that loops until out of gas, and assert that the receiver ends with the wrapped token and that the router holds nothing.

### 3.2 The callback must see the net value (handled)

The first PulseChain home build passes the gross value to the callback. Our mediator takes the incoming fee first (`TokenMediator.sol:863`), and `_callback` passes `delivery.value` after that (`:867`, `:949`). `docs/hardened-build-contract.md:579` states it. No change needed.

### 3.3 The first bridged copy is permanent, and we have no way to replace it (decide before launch)

PulseChain had an owner and still needed a new mediator pair to change the Ethereum WPLS. Our mediator has no owner and no `setCustomTokenAddressPair` (`docs/hardened-build-contract.md:896`). `_copyOrDeploy` (`TokenMediator.sol:834-853`) deploys the copy on first use, with the name `"<name> from <chain>"` and the symbol `"zkb<symbol>"`, and stores the pair for good. So the first relay of WPLS fixes our Ethereum WPLS for the life of the mediator. Any later wish for a different representation means a new mediator, a split of liquidity, and a migration path, exactly as PulseChain shows.

Actions:

- Before `openDeposits`, check the computed copy address and metadata of WPLS and WETH (and any other token we expect), and record them in the deployment output. A deploy test can assert the predicted copy address from `TokenFactory`.
- State in `docs/hardened-build-contract.md` that the copy of a token is permanent and that the remedy for a wrong copy is a new mediator.
- Make the front end and the explorer carry an explicit "canonical token" list, so that a later second representation is labelled from day one.

### 3.4 One router per chain, bound to one mediator (handled, with a note)

PulseChain binds its WPLS router to the WPLS mediator only (`bridge()` is `0x0e18…`), and the ETH router to the general mediator. Our `WETHOmnibridgeRouter` binds to the one mediator in its constructor (`WETHOmnibridgeRouter.sol:40-44`), and `DeployBridge.s.sol` deploys one router per chain that has a wrapped native token (`docs/hardened-build-contract.md:757`). If we ever add a second mediator, it needs its own router. Clients must not reuse the router address across mediators.

### 3.5 Native value never rides in a message (handled)

The PulseChain AMB carries no value, and the PLS path wraps and unwraps in routers. Our `MessageBridge` calls the target with zero value (`MessageBridge.sol:383`), and the mediator moves only tokens (`docs/hardened-build-contract.md:839`, `:915-916`). This matches. No change needed.

### 3.6 Gas limits for deliveries that unwrap (handled; one check to add)

PulseChain uses 2,000,000 for `maxGasPerTx` and for `requestGasLimit` on both mediators. Our mediator asks for 250,000 for a release, 1,000,000 with a callback, 2,000,000 for a deploy and 2,750,000 for a deploy with a callback (`TokenMediator.sol:141-145`, `:782-787`). The constructor refuses a bridge whose `maxGasPerTx` is smaller (`TokenMediator.sol:271-273`), and our bridge allows 10,000,000 (`MessageBridge.sol:94`). The 750,000 callback budget is enough for an unwrap and a capped send, but only once 3.1 caps the send. Add a test that runs the full router path (release, callback, withdraw, send, wrap fallback) at exactly `RELEASE_GAS_LIMIT + CALLBACK_GAS_LIMIT`, and the same for the first-use deploy path at 2,750,000.

### 3.7 Executor gas (handled)

OmniBridge validators choose the execution gas. Our bridge refuses execution when the gas left cannot cover the message gas under the 63/64 rule plus `EXECUTION_OVERHEAD_GAS` (`MessageBridge.sol:376-379`). So an executor cannot starve a router delivery into a final failure. No change needed.

### 3.8 Message size (not a PulseChain lesson)

The PulseChain AMB limits size by its validators and its gas. I found nothing about size in the PLS change. Our bridge has no explicit size cap, and the gas range bounds the delivery cost. No action from this review.

### 3.9 Receivers that refuse tokens (handled)

For tokens, our mediator never reverts on a refusing recipient. It tries the recipient, then the fallback, then records a claim (`TokenMediator.sol:891-907`, `:928-942`). That is stronger than both PulseChain mediators, which revert. The gap is only in the coin send of the routers (3.1).

## What I could not confirm

- The team's stated reason for the WPLS pair. No public announcement or repository commit was read.
- Whether PulseChain has activated EIP-6780. This matters only if we copy the `Sacrifice` pattern.
- The exact gas that a gas-burning receiver leaves our router (3.1). It is an estimate. A test must measure it.
- The cause of the small surplus of locked WPLS over the supply of `0xA882…`.
