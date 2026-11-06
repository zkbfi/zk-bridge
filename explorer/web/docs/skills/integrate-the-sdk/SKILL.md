---
name: integrate-the-sdk
description: Builds on the three zkb.fi SDK packages, @zkb/core (fee and delivery rules, pure functions), @zkb/data (indexer, proofs, RPC reads, search) and @zkb/react (hooks and components), with a minimal working example for each. Use when an integrator wants to compute bridge fees, read bridge state, or embed the bridge screen's logic in their own app.
kind: skill
title: Integrate the SDK
summary: What each of @zkb/core, @zkb/data and @zkb/react exports, and a minimal example for each.
audience: [integrator]
chains: all
verified_release: 0.1.2-next.14
---

# Integrate the SDK

## When to use

- You compute fees, tips, warnings or delivery terms the same way the dapp does (`@zkb/core`).
- You read proofs, indexer views, light client heads or search results (`@zkb/data`; see also `read-bridge-data`).
- You build a screen in React with the dapp's fee hooks, Bridge button verdict and icons (`@zkb/react`).

## Preconditions

- Node 22 or newer. The packages are ESM only. `@zkb/react` also needs React and React DOM 19.3 or newer as peer dependencies.
- The three packages are private and unpublished: version 0.0.0, licence `UNLICENSED`, `"private": true`. You get them from the source repository (`explorer/core`, `explorer/data`, `explorer/react`), where they are pnpm workspace packages. Inside that workspace a package depends on them with `"@zkb/core": "workspace:*"`. `pnpm install` in `explorer/` builds each package's `dist/` through its `prepare` script. `@zkb/data` depends on `@zkb/core`, and `@zkb/react` on both.
- Import from the package root only. There are no deep paths. (`@zkb/core/vectors` and `@zkb/react/styles.css` are the two named exceptions.)
- Contract addresses come from the indexer (`GET /api/pair`) or the dapp, never from a document. In these docs they are placeholders such as `{{contracts.943.bridge}}` and `{{contracts.11155111.lightClient}}`.

<!-- TODO: the packages are not on npm and have no licence (the READMEs say "private and unpublished"). Replace the Preconditions note with an install command and a licence when the owner publishes them. -->

## Steps

### `@zkb/core`: the rules

Pure functions over `bigint`. No I/O, no clock, no randomness. Same inputs give the same answer in any implementation. Money is USD times 1e18 (`USD = 10n ** 18n`), a share is times 1e18 (`WAD`; 1% is `PERCENT_WAD`, which is 1e16), and division rounds down.

Exports by group: the fee rules (`defaultFee`, `totalCostUsd`, `deliveryGasUsd`, `usdOf`, `feeWarnings`, `highCap`, `smallTransfer`, `lowFee`, `hardCapCheck`, `clampAutoCap`, `gasRange`, `ceilingWeiOf`, and constants such as `PROOF_COST_USD`, `GAS_LEVELS`, `DEFAULT_GAS_LEVEL`); delivery terms (`settingsOf`, `encodeFeeDirector`, `decodeFeeDirector`, `readDeliveryTerms`, `assertValidFeeTerms`, `expectedFee`, `maximumFee`); tips (`suggestPercentage`, `suggestFixed`, `suggestGasMultiplier`, `defaultTip`, `defaultTipChoiceOf`); numbers (`formatTokenAmount`, `parseTokenAmount`, `formatRate`, `formatDuration`, `lnScaled`, `expNegScaled`); addresses (`normalizeAddress`, `sameAddress`, `ZERO_ADDRESS`); PulseX price maths (`poolOf`, `plsQuoteOf`, `tokenQuoteOf`, `weightedMedian`); bridged copy symbols (`bridgedSymbolOf`, `nativeSymbolOf`); deposit gate evidence (`checkConfirmEvidence`, `judgeForkEvidence`, `encodeForkEvidence`, `confirmCalldata`); and search text (`classifyQuery`).

Minimal example: the default fee for a $500 transfer, capped at 1%.

```js
import { DEFAULT_GAS_LEVEL, USD, PERCENT_WAD, defaultFee, totalCostUsd, usdOf } from "@zkb/core";

const costUsd = totalCostUsd({ gasUsed: 150_000n, baseFeeWei: 10n ** 9n, priorityFeeWei: 0n, nativePriceE18: USD / 2n, level: DEFAULT_GAS_LEVEL });
const fee = defaultFee({ amountUsd: usdOf(500_000_000n, 6, USD), costUsd, capWad: PERCENT_WAD });
// costUsd = 37612500000000000n (about $0.0376)
// fee = { binding: "curve", shareWad: 1000000000000000n, feeUsd: 500000000000000000n }  -> 0.1% of $500 = $0.50
```

Format and parse amounts without floats, and compute what a router fee splits into:

```js
import { formatTokenAmount, parseTokenAmount, expectedFee, settingsOf } from "@zkb/core";

formatTokenAmount(1_234_567n, 6, { fractionDigits: 2 }); // "1.23" (digits are cut, never rounded)
parseTokenAmount("1.5", 6);                              // 1500000n
const director = { recipient: "0x" + "11".repeat(20), settings: settingsOf({ mode: "share" }), limit: 0n, multiplier: 10n ** 16n };
expectedFee(director, { value: 1_000_000n, gasUsed: 0n, baseFeeWei: 0n }); // { fee: 10000n, toRecipient: 990000n }
```

(Both examples were run against the built `@zkb/core` on 2026-11-06 and gave the values shown.) `@zkb/core/vectors` is `fee-rules-vectors.json`: a list of `{ input, output }` cases per rule, with every number as a decimal string, so a port in another language can check itself.

### `@zkb/data`: the data layer

Every URL is the caller's: nothing is built in. `fetch` and `WebSocket` are the global ones, and every client accepts its own. A read that feeds a rule names its block. A failed read throws; the one exception is `readFinalizedSlot`, which returns null.

Main exports: `resolve` and `ZKB_SITES` (search), `createExplorerConnection` and `resolveConnection` (indexer with RPC fallback), `createBackendClient` (the proof queue), `readBoardMessages` and `createBoardFeed` (the msgboard that carries proofs), `readStoredHeadAt`, `readGateAt`, `readMediatorBalancesAt`, `createLightClientReader`, `createHttpChainReader`, `createViemChainReader` (chain reads), `parseFeedQuery`, the indexer views (`feedItemView`, `headView`, ...), `loadPair` and `PAIR_DEFINITIONS`, and the gate flow (`readGateStatus`, `createBeaconProofSource`, `buildGateEvidence`, `ensureGateConfirmed`).

Minimal example: the proof queue client, with fakes so it needs no network.

```js
import { createBackendClient } from "@zkb/data";

const queue = createBackendClient({
  baseUrl: "https://queue.example/",
  fetchJson: async () => ({ status: 404, body: null }),
  postJson: async () => ({ status: 202, body: { requestId: "r1", jobId: "j1" } }),
});
await queue.requestProof({ pair: "eth-pls", direction: "ethereum-to-pulsechain", reason: "user" });
// { requestId: "r1", jobId: "j1" }; a 429, 409 or 503 comes back as { refused: ... }
await queue.latestProof("ethereum-to-pulsechain"); // null: the queue holds none
```

(Run on 2026-11-06 with the output shown.) For a live read of the indexer with `resolve`, see `read-bridge-data`.

### `@zkb/react`: hooks and components

The host owns every read: no hook builds a client or names an endpoint. The package stores only the user's two fee caps (in `window.localStorage` unless you pass a `Storage`-like object; a storage that throws is treated as absent). Import the stylesheet once: `import "@zkb/react/styles.css";`.

Exports: `useDefaultFee`, `useFeeWarnings`, `useHardCap`, `useFeeCaps`, `loadFeeCap`/`saveFeeCap`, `DEFAULT_AUTO_CAP_PERCENT` (1) and `DEFAULT_HARD_CAP_PERCENT` (2), `verdictOf`, `pressable` and `useVerdict` (what the Bridge button says), `usePrices`, `loadPrices` and `samplePrices` (prices at a block), `useDeliveryStatus`, `stepWords`, `groupOf`, `stepOf` and `positionOf` (delivery status), and the components `Sheet`, `ReviewSheet`, `ReviewRow`, `ReviewNotice` and `TokenIcon`. Theme the components with the `--zkb-*` CSS variables (for example `--zkb-accent`, `--zkb-sheet-bg`, `--zkb-sheet-ink`).

Minimal example: the Bridge button's verdict, and a delivery status in words. These are pure functions, so they run outside React too.

```js
import { verdictOf, stepWords, groupOf } from "@zkb/react";

verdictOf({ connected: true, draft: { status: "ready", reason: null }, amountEntered: true, overBalance: false, symbol: "USDC", paused: null, tipBelowBreakEven: true });
// { kind: "warn", label: "Tip too low · may not be delivered", detail: "The fee is under twice what delivering and proving it should cost, so bots likely skip it and you would deliver it yourself. Raise it with the tip." }

const now = Math.floor(Date.now() / 1000);
stepWords({ status: "covered", sentAt: now - 20 * 60, destinationName: "PulseChain", now }); // "Proven · waiting for a deliverer for 20 min"
groupOf("covered", now - 31 * 60, now); // "needs-you" (a proven transfer undelivered for more than 30 minutes)
```

(Run against the built `@zkb/react` on 2026-11-06 with the output shown.) For a component host with `useDefaultFee`, `useFeeCaps`, `useHardCap`, `usePrices`, `useVerdict`, `ReviewSheet` and `TokenIcon`, see the example host in the `@zkb/react` readme (its test renders it with jsdom on every run).

## Expected result

- `defaultFee` for $500 returns `binding: "curve"`, a share of 0.1% (`1000000000000000n` at 1e18 scale) and a fee of $0.50, the same as the table in `fees-explained`.
- `verdictOf` returns `{ kind, label, detail }` where `kind` is `go`, `warn`, `blocked` or `connect`, and `pressable(verdict)` is true for `go`, `warn` and `connect`.
- The queue client returns values, not exceptions, for a refused request (`{ refused: ... }`).

## If it fails

- **The package cannot be resolved.** They are not on npm. Work inside the `explorer/` pnpm workspace, and run `pnpm install` so the `prepare` script builds `dist/`.
- **A float sneaks in.** Every amount is a `bigint`; in JSON it is a decimal string. Convert with `BigInt(text)`, not `Number`.
- **A different fee than the dapp's.** The rules take prices, gas and balances as arguments; the dapp reads them at one block. Pass the same inputs. The fixed vectors (`@zkb/core/vectors`) pin every fee rule.
- **A read throws.** That is by design: a number that could not be read is not replaced by a default. Catch it and show it as unknown.
- **A URL appears in a log.** Do not log the connection object. `redactConnectionText`, `redactSecrets` and `connection.redact(text)` remove known secrets from text; endpoints can hold keys.
- **`useFeeCaps` stores nothing.** Private windows and blocked storage give no `localStorage`; the choice then lasts for the visit. Pass your own `Storage`-like object to change that.

## References

- `read-bridge-data`: the indexer API and `@zkb/data` readers in use.
- `fees-explained`: the fee rules in words.
- `how-the-bridge-works`, `glossary`.
