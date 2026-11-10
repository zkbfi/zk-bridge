# @zkb/core

The deterministic rules of the zkb.fi bridge screen, as pure functions: the fee rules (cost, default fee, caps, warnings,
gas levels), the delivery terms (settings bits, `FeeDirector` encoding, router fee formulas), the default tip, fixed-point
`ln`/`exp`, number formatting, the maths of the PulseX price oracle, and the one price source and tip verdict that the
dapp, the backend's batching and the delivery runner share.

Status: private and unpublished. The name `@zkb/core` is the owner's npm scope; the licence is not chosen yet
(`UNLICENSED`). This is the first slice of the SDK: a data package (proof fetching, RPC reads) and a React package are meant
to sit on top of it.

One runtime dependency: `viem`, for the ABI encoding of the `FeeDirector` and the checksum of a decoded address. ESM only,
Node 22 or newer, plain `tsc` output in `dist/` with `.d.ts`.

## Determinism rules

Same inputs, same answer, in any implementation. Every function in this package follows these:

1. **Integers only.** Every amount is a `bigint`. No floats, no epsilons. (In JSON a bigint is a decimal string.)
2. **Fixed scales.** Money is USD scaled by `1e18` (`USD = 10n ** 18n`). A share or rate is scaled by `1e18` (`WAD`,
   `RATE_SCALE`: 1% is `1e16`, the router's own multiplier scale). A price is USD per whole token times `1e18`. Token
   amounts are base units, gas prices are wei.
3. **One rounding rule: down.** Division truncates, toward the user: a cost, a fee or a share is never rounded up.
   Thresholds are compared exactly, by cross-multiplying, so no threshold is rounded at all. The few "round up" helpers
   (`weiToTokenUnitsCeiling`, `ceilingDivide`) exist because the delivery router rounds up in its own formulas.
4. **No I/O of its own, no clock or randomness.** Prices, gas, balances and the block come from the caller as arguments;
   the price source (`token-pricing`) reads pools only through a client or pool reader the caller passes, and its stale
   rule reads the caller's clock. A price carries
   the block it was read at. Ties (equal depth, equal value) break by the lower address, never by input order.
5. **Fixed-point maths by fixed steps.** `lnScaled` and `expNegScaled` (scale `1e36`) stop their series when a term truncates
   to zero, so the steps depend only on the input.

The fixed test vectors in `vectors/fee-rules-vectors.json` pin the fee rules. A port in another language runs the same file.

## API

Import from the package root only; there are no deep paths.

```ts
import { defaultFee, USD, PERCENT_WAD } from "@zkb/core";
```

Fee rules (`fee-rules`):

| Export | What it does |
| --- | --- |
| `usdOf(units, decimals, priceE18)` | A token amount in USD x 1e18. |
| `totalCostUsd(cost)`, `ceilingCostUsd`, `gasRange` | Cost of a delivery at a gas level: proof cost plus gas. |
| `ceilingWeiOf(baseFee, level)`, `gasLevelOfCeiling` | The base fee ceiling a gas level signs (1 Low ×2, 2 Normal ×3, 3 High ×5), and the level a ceiling stands for (no ceiling is `DEFAULT_GAS_LEVEL`, Normal). |
| `defaultFee({ amountUsd, costUsd, capWad })` | The default fee curve: which rule binds, the share to sign, the fee. |
| `feeWarnings(input)`, `highCap`, `smallTransfer`, `lowFee`, `capWarns` | The warnings of the screen. |
| `hardCapCheck`, `clampAutoCap`, `feeSpanUsd`, `shareWadOfPercentText` | Caps and share helpers. |
| `PROOF_COST_USD`, `COST_MARGIN`, `GAS_LEVELS`, `DEFAULT_GAS_LEVEL`, `WAD`, `PERCENT_WAD`, `USD`, ... | The constants. |

Delivery terms and tips (`delivery-terms`, `delivery-fee`, `default-tip`):

| Export | What it does |
| --- | --- |
| `settingsOf`, `feeModeOf`, `settingFlagsOf`, `requestedPayoutOf`, `gasPriceBasisOf`, `gasPriceBasisFor` | The settings bits of a `FeeDirector`. |
| `encodeFeeDirector`, `decodeFeeDirector`, `decodeDeliveryCall`, `readDeliveryTerms`, `assertValidFeeTerms` | Encoding, decoding and the guard against terms the router would not honour. |
| `expectedFee`, `maximumFee`, `payoutOf`, `ceilingDivide` | The router's fee formulas. |
| `deliveryCostBreakdown`, `suggestPercentage`, `suggestFixed`, `suggestGasMultiplier`, `gasMultiplierOf`, `defaultTip`, `senderPriceOfToken`, `weiToTokenUnitsCeiling`, `tokenUnitsToWeiFloor` | Turn a cost, a price and a margin into a `FeeDirector`. |
| `defaultTipChoiceOf` | The default tip choice (gas based mode, which price, the notice). |

Numbers and addresses (`fixed-point`, `format`, `address`):

| Export | What it does |
| --- | --- |
| `lnScaled`, `expNegScaled`, `FIXED_SCALE` | Deterministic `ln` and `exp(-t)` at scale 1e36. |
| `formatTokenAmount`, `parseTokenAmount`, `formatRate`, `formatDuration`, `RATE_SCALE` | Format and parse amounts without floats; digits are cut, never rounded. |
| `normalizeAddress`, `sameAddress`, `ZERO_ADDRESS` | Address helpers. |

PulseX price maths (`pulsex-pricing`):

| Export | What it does |
| --- | --- |
| `poolOf`, `stablePoolEntry`, `plsQuoteOf`, `tokenQuoteOf` | From pool reserves to a PLS/USD quote and a token quote. |
| `weightedMedian`, `weightedMedianEntry`, `pricingAddress` | The median and the pricing address of a token. |
| `PULSEX_FACTORIES`, `WPLS`, `STABLES`, `MINIMUM_DEPTH_USD`, ... | The constants. |

The one price source (`token-pricing`). Owner, 2026-11-09: "where are the prices coming from?". The dapp (through
`@zkb/react`'s `usePrices`, over its RPC pool), the backend's batching and the delivery runner (over their server's
PulseChain RPC) all read prices here:

| Export | What it does |
| --- | --- |
| `poolReaderOver(client, block)`, `poolReaderAtLatest(client)`, `countingCaller`, `isChainAnswer` | A pool reader over the caller's client (`readContract`, plus `getBlockNumber` for the latest block), every read pinned to one block; a request that does not get through is counted, so it is never read as "no market". |
| `plsUsd`, `tokenUsd`, `nativeUsd`, `resolvePricingAddress` | PLS/USD, a token's price (an Ethereum token through its Omnibridge copy, a zkb.fi copy through its origin), a native coin's price. |
| `readPrices(subjects, nativeChainIds, poolReader)` | Prices of tokens and native coins at one block; a testnet's are null without a read; throws when the source failed. |
| `PriceState` (`known`, `stale` with `ageSeconds`, `no-market`, `unreachable`), `STALE_PRICE_MAX_SECONDS` (600), `holdingAfterRead`, `holdingAfterFailure`, `priceProblemOf`, `isUsablePrice` | The four states and the stale rule: after a failed read, a price at most 10 minutes old is used as stale. |
| `createPriceKeeper({ poolReader, now })` | For a server: reads, holds the last good prices, and applies the stale rule; never throws. |
| `tokenValuationOf`, `tokenValuationIn`, `worsePriceState` | A token in USD and in wei of the destination's coin; usable only when the token's and the coin's prices both are (the wrapped coin is exactly 1e18 wei a token). |

The one tip verdict (`tip-verdict`):

| Export | What it does |
| --- | --- |
| `tipVerdict({ amount, fee, decimals, price, cost, rule, feeValue? })`, `tipVerdictOfTerms({ director, gas, ... })` | `pays` / `below-cost` for a priced tip, by the profit rule; `unpriced-at-max` / `unpriced-below-max` for a tip that cannot be valued, by the automatic maximum. |
| `atAutomaticMaximum(fee, amount)` | The tip is at least the frontend's automatic maximum, `DEFAULT_CAP_WAD` (1%) of the amount as the router rounds it: it pays without a price (owner: "yes, deliver straight away"). |
| `meetsProfitRule(value, cost, rule)` | `margin` (the backend's `profitMargin`, the dapp's 2× `COST_MARGIN`): value ≥ cost × margin, rounded up. `loss` (the runner's `maximumLossPercent`): (cost − value) × 100 < limit × cost, and always at or above the cost. |
| `tipPays`, `feeValueOf` | `pays` and `unpriced-at-max` count as paying; a fee's value in the cost's unit. |

Which rule applies where: the runner judges the gas it spends (`loss`, `runner.maximumLossPercent`); the backend judges
whether the fee address's take covers a proof and its deliveries (`margin`, `watch.profitMargin`); the dapp warns under
twice the total cost (`margin`, 2). The unpriced rule is the same everywhere. `FeeReading` of the wait estimates has a
`{ kind: "unpriced", atMaximum }` case: a tip at the automatic maximum proves at finality, as in the backend.

Fork evidence of the deposit gate (`gate-evidence`; the reads are `buildGateEvidence` and `ensureGateConfirmed` of `@zkb/data`):

| Export | What it does |
| --- | --- |
| `checkConfirmEvidence({ evidence, beaconRoot, epoch, slotsPerEpoch, genesisValidatorsRoot })` | The checks of `BeaconForkGate.confirm`, in the contract's order. Gives `{ ok: true, shape }` or the contract's error name (`BeaconRootUnavailable`, `HeaderRootMismatch`, `HeaderNotInCurrentEpoch`, `GenesisValidatorsRootBranchInvalid`, `ForkProofInvalid`, `ShapeNotAllowed`). |
| `judgeForkEvidence`, `isValidBranch`, `beaconHeaderRoot`, `versionLeaf` | Ports of `ForkShape.judge`, `SSZ.isValidBranchMemory` and `SSZ.hashTreeRootMemory`. |
| `ALLOWED_SHAPES`, `PROGRESSIVE_SHAPE`, `versionGindex`, `genesisValidatorsRootGindex`, `plainVersionGindex`, `versionBranchLength`, `genesisValidatorsRootBranchLength`, `depthOfVersionBranch`, `isAllowedShape`, `forkProofGindices` | The positions of `ForkShape`: depths 5, 6 and 7, and 255 for the progressive state of Gloas (version at 169, `genesis_validators_root` at 40). |
| `compactMultiproofDescriptor`, `compactMultiproofNodes`, `branchFromNodes`, `forkEvidenceFromMultiproof` | The compact multiproof that Lodestar serves (`/eth/v0/beacon/proof/state/{id}?format=<descriptor>`): its descriptor, the tree it gives, the branches in it, and the evidence of a shape from it. |
| `encodeForkEvidence`, `decodeForkEvidence`, `confirmCalldata`, `FORK_EVIDENCE_ABI` | `abi.encode(ForkEvidence)` and the calldata of `confirm`. |
| `gateEpochAt`, `gateEpochEnd`, `BEACON_ROOTS_ADDRESS` | The epoch of a block time as the gate counts it, the first second of the next epoch, the EIP-4788 address. |

The tests run on one real Sepolia epoch (`test/hardened/fixtures/gate_evidence_sepolia.json` at the repository root), and
the forge test `test/hardened/GateEvidenceSepolia.t.sol` feeds the same calldata to the real gate.

### Examples

```ts
import { DEFAULT_GAS_LEVEL, USD, PERCENT_WAD, defaultFee, totalCostUsd, usdOf } from "@zkb/core";

// What a delivery costs at the default gas level (Normal), then the default fee for a $500 transfer capped at 1%.
const costUsd = totalCostUsd({ gasUsed: 150_000n, baseFeeWei: 10n ** 9n, priorityFeeWei: 0n, nativePriceE18: USD / 2n, level: DEFAULT_GAS_LEVEL });
const fee = defaultFee({ amountUsd: usdOf(500_000_000n, 6, USD), costUsd, capWad: PERCENT_WAD });
// fee.binding, fee.shareWad (1e18 = 100%), fee.feeUsd (USD x 1e18)
```

```ts
import { encodeFeeDirector, settingsOf, expectedFee } from "@zkb/core";

const director = { recipient: "0x90F79bf6EB2c4f870365E785982E1f101E93b906", settings: settingsOf({ mode: "share" }), limit: 0n, multiplier: 10n ** 16n };
const data = encodeFeeDirector(director, { router: "0x1111111111111111111111111111111111111111", protectedAddresses: [], destinationToken: null, destinationWrappedNative: null });
expectedFee(director, { value: 1_000_000n, gasUsed: 0n, baseFeeWei: 0n }); // { fee: 10000n, toRecipient: 990000n }
```

```ts
import { lnScaled, expNegScaled, FIXED_SCALE } from "@zkb/core";

lnScaled(2n * FIXED_SCALE); // ln 2 at 1e36
expNegScaled(FIXED_SCALE); // exp(-1) at 1e36
```

```ts
import { formatTokenAmount, parseTokenAmount } from "@zkb/core";

formatTokenAmount(1_234_567n, 6, { fractionDigits: 2, thousandsSeparator: "," }); // "1.23"
parseTokenAmount("1.5", 6); // 1500000n
```

```ts
import { stablePoolEntry, plsQuoteOf, poolOf, WPLS } from "@zkb/core";

// The host reads reserves at one block; core turns them into a quote.
const pool = poolOf(pair, USDC, { token0: USDC, reserve0, reserve1 }); // Pool | null
const pls = plsQuoteOf(pool === null ? [] : [stablePoolEntry(pool, 6)], block); // { usdE18, block, pool } | null
```

Wait-time estimates (`wait-estimates`), shared by the backend and the dapp. Times are numbers (seconds, or
milliseconds where a name says `Ms`), not bigints; money in them stays USD × 1e18:

| Export | What it does |
| --- | --- |
| `SLOTS_PER_EPOCH`, `FINALITY_EPOCHS`, `SLOTS_PER_SYNC_COMMITTEE_PERIOD`, `secondsPerSlot`, `epochSeconds`, `defaultFinalitySeconds` | The chains' timing. |
| `clockFromSlot`, `slotAtTime`, `slotStartTime`, `expectedFinalityAt`, `finalizedSlotAt`, `finalityWaitRange` | The beacon clock and when a block is expected final (the next epoch's checkpoint, two epochs later, plus one slot). |
| `syncCommitteePeriodOf`, `strandingDeadline`, `hoursUntil`, `hoursUntilRounded` | When a light client strands, and the hours until it. |
| `marginWadOf`, `withMargin`, `batchCostUsd`, `feesPay`, `intervalAllows`, `batchDueAt`, `proofWaitRange` | The proof rule: when fees pay for a proof and when a batch is due. |
| `provingPartsOf`, `saneProvingParts`, `provingRangeOf`, `deliveryRangeOfStat`, `MIN_SAMPLES`, `SANE_LIMITS`, `PROVING_DEFAULT`, `DELIVERY_DEFAULT` | Measured step times, the samples they need, their sanity limits and the fallbacks. |
| `waitEstimate`, `feeVerdict`, `remainingWait`, `waitDurationText` | The timeline of a direction (Sent, Final, Proved, Delivered; typical and worst case) and the time left of a transfer. |

## Test vectors

`@zkb/core/vectors` is `vectors/fee-rules-vectors.json`: for each fee rule, a list of `{ input, output }` cases (plus a
`note` on some), with every number as a decimal string. The group name is the function name.

```ts
import vectors from "@zkb/core/vectors" with { type: "json" };
```

To run them against this build: `pnpm test` in `explorer/core` (the "the fixed vectors" block of `test/fee-rules.test.ts`
checks every case, `test/vectors.test.ts` checks the file and the groups). To check a port in another language, read the
same JSON file, convert strings to your big integer type, call your function per group and compare the output exactly.

`@zkb/core/wait-vectors` is `vectors/wait-estimates-vectors.json`: the chains' timing, a message's finality and batch
due times, stranding deadlines, the proof rule and the live case of 2026-11-08 (testnet rule 3600 s and that day's
measured times, with Final on the source by the watcher's finality rule: Sepolia to 943 about 48 min typical and 83 min
worst, 943 to Sepolia about 46 and 80). `test/wait-estimates.test.ts`
pins them here; the backend (`backend/test/wait-estimates-parity.test.ts`) and the dapp
(`web/test/wait/wait-estimates-parity.test.ts`) compute the same vectors through their own paths.

`@zkb/core/tip-vectors` is `vectors/tip-verdict-vectors.json`: PulseX pools, tokens, terms, amounts and a delivery cost,
with the verdict each case must get (priced, no market, unreachable, and the testnet: 1% pays, 0.5% and no tip do not).
`test/tip-verdict.test.ts` checks them here; the backend (`backend/test/tip-verdict-parity.test.ts`), the runner
(`bots/test/unit/tip-verdict-parity.test.ts`) and the dapp (`web/test/bridge/tip-verdict-parity.test.tsx`) read the same
pools through their own paths, over the fake client of `test/fixtures/pool-caller.ts`.

The router vectors (`test/fixtures/delivery-*.jsonl`) come from the compiled contract; regenerate them with
`vectors/GenerateDeliveryFeeVectors.s.sol` (the command is in its header).

## Develop

```
pnpm install       # builds dist/ through the prepare script
pnpm test          # vitest with 100% coverage thresholds
pnpm typecheck     # tsc -p .
pnpm build         # tsc -p tsconfig.build.json -> dist/
```
