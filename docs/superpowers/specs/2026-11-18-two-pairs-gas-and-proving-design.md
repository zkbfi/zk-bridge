# Two pairs at once: gas limits and GPU proving

Date: 2026-11-18. Status: approved for implementation.

## The owner's words

- "gas can be high, no need to change it. we just need to spec out and implement how much it should be based on how many bridges we will execute at the same time."
- "lets just assume 2 for now. one between sepolia and v4pls and the other between pulsechain and ethereum"
- "for the gpu proving, it will probably increase because the mainnet prover will be as active as user activity needs it to be"
- "yes, write it up and implement it" (after the proposal: testnet stays hourly; mainnet proves on demand with a minimum interval per direction, starting at 10 minutes; a guard and budget per pair; a runner wallet per chain; per-chain gas caps checked at deploy; `MAX_CALL_GAS` stays 10,000,000).

## The two pairs

| Pair | Chains | Proving |
|---|---|---|
| `sepolia-pls943` (testnet, live) | Sepolia (11155111) and PulseChain testnet v4 (943) | Hourly: `watch.pairs.sepolia-pls943.minIntervalSeconds = 3600` |
| `eth-pls` (mainnet, not deployed) | Ethereum (1) and PulseChain (369) | On demand, `minIntervalSeconds = 600` per direction |

## Decision 1: the on-chain gas limits do not depend on the number of pairs

Every delivery is its own transaction on one destination chain. Two pairs never share a transaction, so the number of
pairs changes no on-chain figure. `DeliveryRouter.MAX_CALL_GAS` stays 10,000,000 and `TokenMediator.MAX_CALLBACK_GAS`
stays as it is. What a chain must fit is one worst-case delivery under its per-transaction gas cap (EIP-7825,
16,777,216 where it applies). The at-cap delivery measured in `BridgeWorld.t.sol` is 11,428,828 gas of execution.

**Implement:** a per-chain table in `deploy/gas-defaults.json`:

```json
{
  "backendStartDeliveryGas": 500000,
  "chains": {
    "1":        { "maxTransactionGas": 16777216 },
    "11155111": { "maxTransactionGas": 16777216 },
    "369":      { "maxTransactionGas": 16777216 },
    "943":      { "maxTransactionGas": 16777216 }
  }
}
```

The figure for 369 is set to the EIP-7825 cap because it is safe on any chain (a lower cap than the chain's own only
limits us). Whether PulseChain mainnet enforces the cap is checked and written into this file's history; it changes
nothing in the contracts either way.

The deploy preflight (`script/testnet/preflight.sh` and the mainnet equivalent) refuses a pair when, on either chain:
- the chain's latest block gas limit is below the worst-case delivery, or
- `maxTransactionGas` from the table is below the worst-case delivery.

The worst-case delivery figure lives in one place (the table or a constant next to it) with a comment naming the test
that measures it.

## Decision 2: proving is per pair, demand-driven on mainnet

The backend already proves on demand: a message waiting for a direction makes a proof due when the batch pays or when
`minIntervalSeconds` has passed since the direction's last proof (`watch/decide.ts`, `watch/batch.ts`); keep-alive proofs
keep a quiet light client from falling behind (`limits.keepAliveSeconds`). One light-client update covers every message
sent before its head, so GPU spend follows how often we prove, not how many transfers there are.

- Testnet keeps its hourly interval.
- Mainnet uses `minIntervalSeconds: 600`. With nothing waiting, it proves only keep-alives.
- Worst case for a pair is `directions x ceil(3600 / minIntervalSeconds)` proofs an hour plus keep-alives and urgent
  proofs (`decide.ts` "urgent reasons").

## Decision 3: the GPU limits follow the interval

Today both limits are flat: `gpuGuard.maxUsdPerHour` (default 0.5 a tier an hour) and
`limits.gpuBudgetUsdPerDirectionPerDay` (5 on the server). A 10-minute mainnet interval needs more than either, so a
busy hour would trip the guard and a busy day would exhaust the budget.

**Implement:** both limits default to a figure derived from the pair's interval, never below today's defaults:

- `proofsPerHour = ceil(3600 / minIntervalSeconds)` of the pair (the pair's `watch.pairs.<pair>` value, else the
  `watch` value; an interval of 0 counts as 60 seconds).
- `gpuGuard.proofCostUsd` (new, default 0.10: the measured cost on 2026-11-18 was about 0.06 a proof including the
  cold start) and `gpuGuard.headroom` (new, default 2).
- Derived `maxUsdPerHour = max(0.5, directions x proofsPerHour x proofCostUsd x headroom)`, with `directions = 2`:
  both directions may land on the same tier in the tier race.
- Derived `gpuBudgetUsdPerDirectionPerDay = max(5, 24 x proofsPerHour x proofCostUsd x headroom)`.
- An explicit value in the file still wins. When an explicit value is below the derived one, the backend logs
  `gpu_limits_below_interval` once at startup with both figures, and runs.
- `/health` or the startup log names the limits in force and whether each was derived or set.

Figures: testnet (3600 s) derives 0.5 / 5, the same as today. Mainnet (600 s) derives 2.40 an hour a tier and 28.80
a direction a day.

## Decision 4: each pair has its own GPU tiers

The guard reads RunPod spend per endpoint. Two backends on the same tiers would each see the other's spend, and one
pair's trip would stop the other pair's proving.

**Implement:**
- `deploy/runpod/endpoints.json`: each endpoint names its `pair`. The existing tiers are `sepolia-pls943`.
- `apply.mjs` refuses a file in which one endpoint id or one endpoint name appears under two pairs, and can apply one
  pair only (`--pair <name>`).
- The mainnet tiers are written into the file (same images and GPU pools, names with an `eth-pls` suffix, workers min
  0) but are created only at the mainnet deploy. If `apply.mjs` cannot create an endpoint, the entries say so and the
  deploy runbook names the step.
- The backend logs `gpu_endpoint_pair_mismatch` and refuses to start the guard for an endpoint that `endpoints.json`
  (when the release has it) names under another pair.

## Decision 5: one runner wallet per destination chain

Four chains, four runner wallets: Sepolia and 943 (testnet), Ethereum and PulseChain (mainnet). A wallet is never
shared across pairs, so a nonce or a balance on one pair never blocks the other. Documented in `docs/bots.md`; the
bots already take a signer per chain. Mainnet ETH gas is the large cost; the tip covers it.

## Not in scope now

- A second backend process on the server (a `zk-bridge-backend@<pair>` unit) and its config: written at the mainnet
  deploy. This spec only makes the backend and the files ready for it.
- Charging part of the proof cost in the tip: an open question.
- Batching several deliveries into one transaction.

## Checks

- Backend: unit tests for the derivation (3600 s gives 0.5 / 5; 600 s gives 2.40 / 28.80; explicit values win;
  the warning fires when an explicit value is below), the pair mismatch, 100% coverage, `tsc` clean.
- `node --test deploy/runpod/apply.test.mjs`: duplicate id or name across pairs refused, `--pair` applies one pair.
- The preflight refuses a chain whose cap or block gas limit is below the worst-case delivery (a test with a fake RPC,
  in the style of the existing preflight tests if any, else a shell test).
- The live testnet backend behaves exactly as before: same derived limits, same tiers.
