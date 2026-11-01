# Gas reverts up, in three layers

Owner, 2026-11-01, verbatim, in order:

> i think that the message has to pass the gas limit. there should be no defaults

> well, no i think you may be misunderstanding. the erc20 mediators on both sides do not need to understand this limit.
> they need to pass/use it for use in the delivery router

> when i have been talking about the gas limits, i have only been talking about the gas limit set during the
> onTokensBridged call to the delivery router. that is it. i do not know that we need gas limits for other pieces. why
> do you think that we do? if anyone can call them and they run out of gas, does it not just revert up the chain? up
> from token mediator through messagebridge?

> yes, build it test-first and show me the redeploy plan. does it make sense to extend this to the deliveryrouter too?

> so here is the thing, the first layer is neutral, anyone can use it. what likely happens in the second layer is that
> many people use it so it needs to be mosty trusted / immutable as well. the 3rd layer (deliveryrouter) can be swapped
> out at the will of the frontends that point to it

> would it be better if 3 bubbled up its errors? or is that too difficult given the ability for errors to surface

> lets go through those arguments and figure out which ones are missing. many of them should probably also be
> immutables /constants

## The rule

Not enough gas reverts the whole delivery: the message stays `NotDelivered` and anyone can deliver it again with more
gas. A callee that says no, with the gas it was promised, is recorded and the delivery completes. The same rule holds
at every layer.

## The layers

| Layer | Contract | Gas number | What changes |
|---|---|---|---|
| 1, neutral | `MessageBridge` | none | The target gets all the gas; a failed call reverts the delivery with the target's error. No `Failed` status, no gas guard, no gas range. The 4 byte gas field of the OmniBridge encoding stays, always zero. The constructor takes no local chain identifier (`block.chainid`). |
| 2, shared and immutable | `TokenMediator`, `TokenFactory` | `callbackGas`, stated by the sender of a relay with a call, carried in the mediator's own payload | No defaults, no minimums, no deploy rule. The callback gets exactly `callbackGas` (`ExactGasCall`), for any receiver. A token, a mint or a limiter that runs out of gas reverts the delivery (`ReleaseOutOfGas`); a refusal is `ReleaseFailed`. `remoteChainId` comes from the bridge; the home chain name is immutable. |
| 3, swappable | `DeliveryRouter` | `callGas`, the fifth word of the `FeeDirector` | The follow-up call gets exactly `callGas`; too little gas reverts the callback; a call that fails with its gas is `CallFailed`. |

The full text, the decisions and the list of tests are in `docs/hardened-build-contract.md`, "Gas reverts up, and three
layers". The redeploy plan is `docs/redeploy-2026-11-gas.md`.

## For frontends

- A plain relay: `relayTokens(token, receiver, value)`. No gas number.
- A relay to a router: `relayTokensAndCall(token, router, value, terms, routerCallbackGas({ callGas }))`, with
  `terms = encodeFeeDirector({ ..., callGas }, context, call?)` from `@zkb/core`. `callGas` is 0 without a follow-up call.
- A relay to another contract: `relayTokensAndCall(token, receiver, value, data, callbackGas)`, with the gas that the
  receiver's `onTokenBridged` needs (`recommendedCallbackGas({ kind: "contract", callbackGas })` in `@zk-bridge/shared`).
- The fee: `maximumFee(director, value)` (the smaller of `limit` and the value) is the most a gas based fee can be,
  because a deliverer that supplies more gas still raises the measure of the router up to `limit`.
  `worstCaseFee(director, { value, deliveryGas, gasPrice, payout, withCall })` is the expected fee for an estimate of
  the delivery gas.
- Which routers to show is the frontend's own list (`isKnownDeliveryRouter`); the protocol names none.
