# @zkb/react

The React layer of the zkb.fi bridge screen: hooks for the fee, the verdict, prices at a block and delivery status, and the
self-contained components (the sheet, the review sheet, the token and chain icons) with a stylesheet that a host themes
through CSS variables.

Status: private and unpublished (`UNLICENSED` until the npm org and a licence exist). This is the third slice of the SDK:
`@zkb/core` (rules) and `@zkb/data` (fetching) are below it. The code moved here from `explorer/web`, which imports it
from the package like any other dapp would.

Runtime dependencies: `@zkb/core`, `@zkb/data` and `viem` (types and addresses). Peer dependencies: `react` and `react-dom`
19.3 or newer. ESM only, plain `tsc` output in `dist/` with `.d.ts`, and one stylesheet, `styles.css`.

## I/O rules

1. **The host owns every read.** No hook builds a client, names an endpoint or reads the network on its own. A hook takes
   what it needs as an argument: the pool reader for prices (`PriceSource`, made from `@zkb/data`'s `poolReaderOver` over
   the host's RPC), the status and the clock for delivery status, the amounts and costs for the fee. The host reads its
   delivery cost report, its balances and its gas the way it likes (react-query, `@zkb/data` clients, anything).
2. **Storage is the host's, and optional.** The only thing the package stores is the user's two fee caps. `useFeeCaps`
   and the `loadFeeCap`/`saveFeeCap` family take a `Storage`-like object; omitted, they use `window.localStorage` when the
   browser allows it, and a `null` keeps nothing (the choice lasts for the visit). A storage that throws is treated as
   absent.
3. **Icons come from the host's two sources.** The image server template (default `https://gib.show/image/{chainId}/{address}`)
   and the copies the host ships. The package makes no request itself except the `<img src>` the browser makes; icons are
   only ever drawn through `<img>`, never as inline markup, and a failed image falls back to a lettered disc.
4. **The rules are `@zkb/core`'s.** The hooks keep the answer of a rule while its inputs stay; they add no rule of their own
   (money is `bigint` USD x 1e18, a share is x 1e18, a cap is a number of percent). A price carries the block it was read at.
5. **Timers belong to the hook that starts them.** `usePrices` reads now and every 30 s while mounted, stops on unmount, and
   ignores an answer that comes after it moved on. Prices are display only.
6. **No `node:` import** and no global state: two hosts in one page do not see each other.

## Use

Import from the package root only (there are no deep paths), and import the stylesheet once:

```ts
import "@zkb/react/styles.css";
import { useDefaultFee, TokenIcon } from "@zkb/react";
```

An example host app. This is the test `test/example.test.tsx`, rendered with jsdom on every run:

```tsx
import "@zkb/react/styles.css";
import { useState } from "react";
import { PRICE_NOTE, ReviewNotice, ReviewRow, ReviewSheet, TokenIcon, useDefaultFee, useFeeCaps, useHardCap, usePrices, useVerdict, type PriceSource } from "@zkb/react";

const ETH = { address: "0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE", symbol: "ETH", decimals: 18, side: "first", counterpart: null } as const;
const pair = { first: { chainId: 1 }, second: { chainId: 369 } };
// The host decides where prices come from. Here: the sample data. A live host passes { mode: "live", id, poolReader }.
const source: PriceSource = { mode: "sample" };

export const Bridge = ({ amountUsd }: { amountUsd: bigint }) => {
  const [review, setReview] = useState(false);
  const caps = useFeeCaps(); // the caps live in the host's storage (localStorage unless you pass your own)
  const prices = usePrices({ tokens: [ETH], pair, source }).data;
  const costUsd = 5n * 10n ** 18n; // the host reads the delivery cost from its own indexer
  const { auto } = useDefaultFee({ amountUsd, costUsd, costDefaultUsd: costUsd, capPercent: caps.storedCap });
  const amountUnits = 10n ** 18n;
  const feeUnits = amountUnits / 100n; // 1% of the amount
  const hard = useHardCap({ hardCapPercent: caps.hardCapPercent, amountUnits, feeUnits, worstFeeUnits: 0n });
  const { verdict, pressable } = useVerdict({
    connected: true,
    draft: { status: "ready", reason: null },
    amountEntered: true,
    overBalance: false,
    symbol: ETH.symbol,
    paused: null,
    tipBelowBreakEven: false,
  });
  const price = prices?.get(`first:${ETH.address}`)?.usdE18;
  return (
    <main>
      <TokenIcon subject={{ chainId: 1 }} symbol="ETH" imageServer="https://img.example/{chainId}/{address}" />
      <p title={PRICE_NOTE}>{price === undefined ? "no price" : `ETH $${price / 10n ** 18n}`}</p>
      <p>Default fee: ${(auto.feeUsd ?? 0n) / 10n ** 16n} cents; hard cap {caps.hardCapPercent}%{hard.over ? " (over)" : ""}</p>
      <button type="button" disabled={!pressable} onClick={() => setReview(true)}>{verdict.label}</button>
      {review ? (
        <ReviewSheet onClose={() => setReview(false)}>
          <ReviewRow label="You send"><b>1 ETH</b></ReviewRow>
          <ReviewNotice>Check the receiver before you confirm.</ReviewNotice>
        </ReviewSheet>
      ) : null}
    </main>
  );
};
```

## Theming

The components carry no palette. Every colour and size in `styles.css` is a CSS custom property of the `--zkb-*` family, with a
neutral fallback after the comma for a host that sets none. Set them on `:root` (or any ancestor) and map them to the host's
own roles; a theme switch that changes the host's variables changes the components, because the mapping is `var()`:

```css
:root {
  --zkb-accent: var(--brand);
  --zkb-sheet-bg: var(--surface);
  --zkb-sheet-ink: var(--text);
}
```

| Variable | Role | Fallback |
| --- | --- | --- |
| `--zkb-page` | The page behind a chain badge on an icon | `#ffffff` |
| `--zkb-plate` | The round plate under an icon on the accent band | `#ffffff` |
| `--zkb-raised` | Background of the lettered fallback disc | `#f2f2f2` |
| `--zkb-raised-ink` | Text of the lettered fallback disc | `#1a1a1a` |
| `--zkb-raised-edge` | Border of the lettered fallback disc | `#d9d9d9` |
| `--zkb-sheet-bg` | Background of a sheet | `#ffffff` |
| `--zkb-sheet-ink` | Text of a sheet | `#1a1a1a` |
| `--zkb-accent` | The sheet's edge, and the edge of a notice | `#d4501e` |
| `--zkb-scrim` | The dimmed page behind a sheet | `rgba(0, 0, 0, 0.55)` |
| `--zkb-elev-2` | Shadow of a sheet (elevation level 2; only layering uses shadows) | `none` |
| `--zkb-edge` | Border of the round close button | `#d9d9d9` |
| `--zkb-line` | The rule between review rows | `#e3e3e3` |
| `--zkb-muted` | Labels and sub rows | `#666666` |
| `--zkb-warn` | Text of a notice | `#a8400f` |
| `--zkb-column-width` | Widest a sheet and its column get | `640px` |
| `--zkb-touch` | Size of the close button | `44px` |
| `--zkb-text-micro` | The lettered fallback's base size | `13px` |
| `--zkb-text-small` | Sub rows and notices | `14px` |
| `--zkb-text` | Review rows | `16px` |
| `--zkb-text-large` | The sheet's title | `18px` |
| `--zkb-layer-scrim` | `z-index` of the scrim | `40` |
| `--zkb-layer-sheet` | `z-index` of the sheet | `41` |

The class names (`zb-sheet`, `zb-kv`, `zb-tok-icon`, ...) are stable and listed in `styles.css`; a host may add rules on top
of them (the dapp adds the token picker's layout to `zb-sheet-top` and `zb-sheet-bare`). The dapp's own mapping is the
`--zkb-*` block of `explorer/web/src/bridge/bridge.css`.

## API

Hooks:

| Export | What it does |
| --- | --- |
| `useDefaultFee({ amountUsd, costUsd, costDefaultUsd, capPercent })` | `{ capWad, auto }`: the default fee of `@zkb/core` (the larger of the curve and twice the cost, held at the cap, plus the extra of a gas level above Normal). |
| `useFeeWarnings(input)` | `{ warnings, linePercent, thresholdText }`: small transfer, low fee, "High cap %", the cap warning, and the line a tip should stay under. `input` is `FeeWarningsInput` of `@zkb/core`. |
| `useHardCap({ hardCapPercent, amountUnits, feeUnits, worstFeeUnits })` | `{ hardCapWad, check, over, raisePercent }`: the hard cap against the fee now (or the worst case of a gas-based fee), and the smallest cap that admits it. |
| `useFeeCaps(storage?)` | `{ storedCap, storedHardCap, hardCapPercent, setHardCapPercent, saveCap(percent), saveHard() }`: the two stored caps. |
| `useVerdict(input)` | `{ verdict, pressable }`: what the Bridge pill says (`go`, `warn`, `blocked`, `connect`), in the priority order of `verdictOf`. |
| `usePrices({ tokens, pair, source, refreshMilliseconds? })` | `{ data, error, isError }`: prices of tokens (`<side>:<address>`) and native coins (`native:<chainId>`), each a `PriceQuote` carrying its block or null. `source` is `{ mode: "sample" }`, `{ mode: "live", id, poolReader }` or null. The last good data stays when a read fails. |
| `useDeliveryStatus({ status, sentAt, destinationName, now })` | `{ group, step, position, words }` of a transfer. `status` is `@zkb/data`'s `MessageStatus`. |

Functions behind the hooks (pure, no React): `verdictOf`, `pressable`, `capWadOf`, `plainNumber`, `samplePrices`, `loadPrices(tokens,
pair, reader)`, `tokenPriceKey`, `nativePriceKey`, `stepOf`, `positionOf`, `stepWords`, `groupOf`, and the caps store:
`loadFeeCap`, `loadHardCap`, `saveFeeCap`, `saveHardCap`, `feeCapProblem`, `DEFAULT_AUTO_CAP_PERCENT` (1), `DEFAULT_HARD_CAP_PERCENT`
(2). Constants: `PRICE_NOTE`, `PRICE_REFRESH_MILLISECONDS`, `NEEDS_YOU_AFTER_SECONDS`, `DEFAULT_IMAGE_SERVER`.

Components:

| Export | Props |
| --- | --- |
| `TokenIcon` | `subject` (`{ chainId, address? }`), `symbol`, `badgeChainId?`, `size?` (24), `decorative?`, `surface?` (`plain` or `accent`), `imageServer?`, `shipped?`, `shippedBase?` (`./icons/`). |
| `Sheet` | `label`, `showTitle?`, `bare?`, `top?`, `onClose`, `children`. A dialog: Escape and the scrim close it, focus moves in and returns. |
| `CloseButton` | `onClose`, `label?`. |
| `ReviewSheet` | `label?` (`Review`), `onClose`, `children`: the frame of the review. |
| `ReviewRow` | `label`, `sub?`, `children`: one row. |
| `ReviewNotice` | `role?` (`alert` or `group`), `groupLabel?`, `children`: a boxed warning. |
| `iconUrl(subject, { imageServer?, shipped?, shippedBase? })` | The URL of an icon: the shipped copy when there is one, else the image server. |

## What stays in the dapp

Not in this package, on purpose: the fee line and drawer (`FeeLine`: its icons are the dapp's `icons.tsx`, which moves later),
the token picker, everything wired to the router, the wallet (wagmi), Settings or the app shell, the image server setting
(its storage and validation), and `iconSubjectOf` (it reads the dapp's token and pair types).

## Tests

`pnpm test` runs vitest with jsdom and Testing Library at 100 percent coverage of `src/`. No test makes a network call.
