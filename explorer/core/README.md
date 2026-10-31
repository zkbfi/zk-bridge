# @zkb/core

The deterministic rules of the zkb.fi bridge screen, as pure functions: the fee rules (cost, default fee, caps, warnings,
gas levels), the delivery terms (settings bits, `FeeDirector` encoding, router fee formulas), the default tip, fixed-point
`ln`/`exp`, number formatting, and the maths of the PulseX price oracle.

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
4. **No I/O, clock or randomness.** Prices, gas, balances and the block come from the caller as arguments. A price carries
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
| `ceilingWeiOf(baseFee, level)`, `gasLevelOfCeiling` | The base fee ceiling a gas level signs, and the level a ceiling stands for. |
| `defaultFee({ amountUsd, costUsd, capWad })` | The default fee curve: which rule binds, the share to sign, the fee. |
| `feeWarnings(input)`, `highCap`, `smallTransfer`, `lowFee`, `capWarns` | The warnings of the screen. |
| `hardCapCheck`, `clampAutoCap`, `feeSpanUsd`, `shareWadOfPercentText` | Caps and share helpers. |
| `PROOF_COST_USD`, `COST_MARGIN`, `GAS_LEVELS`, `WAD`, `PERCENT_WAD`, `USD`, ... | The constants. |

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

PulseX price maths (`pulsex-pricing`; the pool reading stays with the host):

| Export | What it does |
| --- | --- |
| `poolOf`, `stablePoolEntry`, `plsQuoteOf`, `tokenQuoteOf` | From pool reserves to a PLS/USD quote and a token quote. |
| `weightedMedian`, `weightedMedianEntry`, `pricingAddress` | The median and the pricing address of a token. |
| `PULSEX_FACTORIES`, `WPLS`, `STABLES`, `MINIMUM_DEPTH_USD`, ... | The constants. |

### Examples

```ts
import { USD, PERCENT_WAD, defaultFee, totalCostUsd, usdOf } from "@zkb/core";

// What a delivery costs at the Normal gas level, then the default fee for a $500 transfer capped at 1%.
const costUsd = totalCostUsd({ gasUsed: 150_000n, baseFeeWei: 10n ** 9n, priorityFeeWei: 0n, nativePriceE18: USD / 2n, level: 1 });
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

## Test vectors

`@zkb/core/vectors` is `vectors/fee-rules-vectors.json`: for each fee rule, a list of `{ input, output }` cases (plus a
`note` on some), with every number as a decimal string. The group name is the function name.

```ts
import vectors from "@zkb/core/vectors" with { type: "json" };
```

To run them against this build: `pnpm test` in `explorer/core` (the "the fixed vectors" block of `test/fee-rules.test.ts`
checks every case, `test/vectors.test.ts` checks the file and the groups). To check a port in another language, read the
same JSON file, convert strings to your big integer type, call your function per group and compare the output exactly.

The router vectors (`test/fixtures/delivery-*.jsonl`) come from the compiled contract; regenerate them with
`vectors/GenerateDeliveryFeeVectors.s.sol` (the command is in its header).

## Develop

```
pnpm install       # builds dist/ through the prepare script
pnpm test          # vitest with 100% coverage thresholds
pnpm typecheck     # tsc -p .
pnpm build         # tsc -p tsconfig.build.json -> dist/
```
