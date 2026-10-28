# Gas limits: one rule, traced through every layer

This page records how the gas limit of one message travels from the sender to the user call. It lists where the rule
holds today and where it does not. Later tasks fix the gaps and add the tests below as their first step.

## The rule

1. The limit is read from the message, never guessed.
2. A limit below the minimum for its kind, or above the maximum, is refused at the source. A message that cannot be
   delivered is never sent.
3. A delivery supplies at least the limit of the message, and a bundle never packs more than fits.
4. The user call of the router is bounded by the limit of the message.

## The layers today

I read each file and ran the test named in the "Evidence" column on 2026-10-28.

| Layer | Today | Rule holds? | Evidence | Fixed by |
|---|---|---|---|---|
| Source bridge `MessageBridge._send` | Refuses gas below `MIN_GAS_PER_CALL` (100) or above `MAX_GAS_PER_TX` (10,000,000) with `GasOutOfRange`. | Yes | `src/hardened/MessageBridge.sol` line 243 | none |
| Mediator `TokenMediator._chooseGasLimit` | A request of zero gives the default of the kind. A request above zero and below the default is refused. Defaults: `RELEASE_GAS_LIMIT` 250,000; plus `CALLBACK_GAS_LIMIT` 750,000 with a call; deploy is `max(2,000,000, 1,300,000 + 1,600 x name and symbol bytes)`. Refuses above `maxGasPerTx()` with `GasLimitAboveBridgeMaximum`. | Yes since Task 11. A request above zero and below the default is refused with `GasLimitBelowMinimum`; zero gives the default. (Before Task 11 a low request was raised without a refusal.) | `TokenMediatorGasLimit.t.sol` `test_aRequestBelowTheDefaultIsRefused` | Task 11 |
| Delivery `MessageBridge._callTarget` | Requires `gasleft() >= gasLimit + gasLimit/63 + 1 + 100,000` and calls with exactly `gasLimit`. | Yes | `src/hardened/MessageBridge.sol` lines 371 to 395 | none |
| Router `DeliveryRouter._callTarget` | The user call gets `gasleft() - CALL_GAS_RESERVE` (10,000), inside the mediator frame that the bridge capped at the message limit. | Yes, but only by that cap | Test 3 below passes today | Task 8 keeps the test as a guard |
| Router tip measure | `startingGas - gasleft()` plus the call allowance. It measures the gas the deliverer made available. | Not a limit question | none | no change |
| Bots `planBatches` and `evaluateBatch` | Assume `executionGasFallback` (900,000) for each item and never read the message limit. An item above `maximumBatchGas` gets a batch alone. The transaction limit is cut to `maximumBatchGas` (`batch.ts` line 260). | No | Test 4 below fails | Task 11 |
| Shared helper | No `requiredDeliveryGas` exists in `explorer/shared`. | No | Test 5 below fails | Task 11 |
| Dapp and terminal forms | Accept any whole number above zero. The hint says the mediator uses the larger value. The cost estimate uses the indexer's measured gas, not the message limit. | No | `BridgeForm.tsx` line 134, `action-modals.tsx` line 156, `plan.ts` lines 102 and 114 | Tasks 12 and 13 |

Corrections to the plan's table: none. Every row matched the code. Two points are worth noting. The router row holds
today and test 3 passes, so that row needs a guard and no repair. The assumed gas of 900,000 sits below the deploy
default, so a bot that trusts it can under-supply a first-relay message.

## The failing tests

Each test was written in a scratch copy, run, and removed. Nothing red is committed. Tasks 8, 11, 12 and 13 add them
back as their first step.

### 1. `test/hardened/mediator/TokenMediatorGasLimit.t.sol::test_aRequestBelowTheDefaultIsRefused`

For a token whose copy exists (release kind), `relayTokens(token, receiver, 1 ether, 249_999)` must revert with
`GasLimitBelowMinimum(249_999, 250_000)`. The scratch copy declared that error locally, because the contract did not
have it then. Task 8 added `error GasLimitBelowMinimum(uint256 requested, uint256 minimum)` to the mediator.

```
[FAIL: next call did not revert as expected] test_aRequestBelowTheDefaultIsRefused() (gas: 2306735)
```

Task 8 must also change `test_aRequestBelowTheDefaultGivesTheDefault`, which asserts the old behavior for requests of
1 and of one below the default. Zero stays valid and means the default.

### 2. `test/hardened/mediator/TokenMediatorGasLimit.t.sol::test_aRequestOfZeroGivesTheDefault`

The sent message carries `gasLimit == 250_000` for `relayTokens(token, receiver, 1 ether, 0)` on a release.

```
[PASS] test_aRequestOfZeroGivesTheDefault() (gas: 2044704)
```

This test is green today. It is not a failing test. It pins the zero case, so the fix in test 1 cannot refuse zero.

### 3. `test/hardened/mediator/DeliveryRouterCall.t.sol::test_theUserCallNeverGetsMoreThanTheMessageGasLimit`

The scratch test sent a message with a limit of 1,000,000 (release with a call) and executed it through the router with
a transaction gas of 9,000,000. The target recorded `gasleft()` at its first instruction.

```
[PASS] test_theUserCallNeverGetsMoreThanTheMessageGasLimit() (gas: 701728)
  gas at entry: 855816
```

This test is green today. The bound holds because the bridge calls the mediator with exactly the message limit, and
the user call lives inside that frame. The mock bridge copies that behavior (`target.call{gas: gasLimit}`), and so
does `MessageBridge._callTarget`. The test is a guard. Task 8 adds it so that no later change removes the cap.

### 4. `explorer/bots/test/unit/batch-plan.test.ts` "never packs an item whose required gas exceeds the batch maximum"

The scratch test used items with gas `[1n, 50n, 1n]` and limits `{ maximumBatchSize: 5, maximumBatchGas: 10n }`. It
expects the packed ids to be `[1, 3]`. Today `planBatches` gives the oversized item a batch of its own, so the
result is `[[1], [2], [3]]`. This test conflicts with the existing test "gives an item that is above the gas limit
alone a batch of its own", so Task 11 must replace that test.

```
AssertionError: expected [ 1, 2, 3 ] to deeply equal [ 1, 3 ]
```

Task 11 must decide where the dropped item goes (a skip reason). The brief does not say. I assumed the item leaves the
packing and is reported by the caller.

### 5. `explorer/shared/test/gas-limit.test.ts` "requiredDeliveryGas mirrors the bridge guard"

`requiredDeliveryGas(1_000_000n)` must equal `1_115_874n`. That is `1,000,000 + 1,000,000 / 63 (15,873) + 1 + 100,000`,
the same sum as `MessageBridge._callTarget` with `EXECUTION_OVERHEAD_GAS` of 100,000.

```
TypeError: requiredDeliveryGas is not a function
```

Task 11 adds the helper to `explorer/shared/src` and exports it from the index.

## Which task fixes which layer

| Task | Layer | Tests to add first |
|---|---|---|
| 8 | Mediator refuses a request below the kind minimum; the router cap is guarded | 1, 2, 3 |
| 11 | Bots read the message limit, pack by required gas, never pack an oversized item | 4, 5 |
| 12 | Dapp form and estimate use the message limit | 5 (the shared helper) |
| 13 | Terminal form and review text use the message limit | 5 (the shared helper) |

## Result of Task 11 (2026-10-28)

The mediator now refuses a token request above zero and below the default of its kind with
`GasLimitBelowMinimum(gasLimit, minimum)`. Zero gives the default. The router needed no change: the guard test
`test_theUserCallNeverGetsMoreThanTheMessageGasLimit` passes, and the user call stays inside the call of the mediator.
The terminal plan and the dapp form refuse a value below the minimum of a release (they cannot see whether the copy
exists, so they check the lowest minimum) or above the bridge maximum. The mediator still refuses a low first relay. A plain message sent straight through the bridge has no default: the bridge needs a limit of at least `MIN_GAS_PER_CALL` (100) and refuses a lower one with `GasOutOfRange`.

### Mutation results

Each mutation was applied to `src/hardened/mediator/TokenMediator.sol`, the tests of
`test/hardened/mediator/*{GasLimit,Fuzz}*` ran, and the file was restored.

| Mutation | Change | Result |
|---|---|---|
| M-G1 | Remove the new revert | Red: `test_aRequestBelowTheDefaultIsRefused`, `test_aDeployRequestBelowTheNameRuleIsRefused`, the fuzz test |
| M-G2 | `requested < minimum` becomes `requested <= minimum` | Red: `test_aRequestAtTheDefaultIsAccepted`, `test_aDeployRequestBelowTheNameRuleIsRefused`, `test_theGasLimitOverloadsSendTheOmnibridgePayload`, the fuzz test |
| M-G3 | Drop the zero case (`gasLimit = requested`) | Red: `test_aRequestOfZeroGivesTheDefault`, `test_theExistingEntryPointsKeepTheDefaultLimits`, the fuzz test and more |
| M-G4 | Skip the deploy rule in the minimum (`if (needed > gasLimit) gasLimit = needed;` removed) | Red: `test_aDeployRequestBelowTheNameRuleIsRefused` |
