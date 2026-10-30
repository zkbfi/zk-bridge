# Bridge-first dapp: implementation plan (phase 1, the Bridge screen)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or
> superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the explorer-first landing of `explorer/web` with the bridge-first screen from the design: one card
(From row, orange From band, seam, fee line with drawers, To band, To row, Bridge pill with verdict), the direction
menu, the token picker, three themes, swappable endpoints, and the pulse and step-list components.

**Architecture:** The new screen is plain React components in `src/bridge/` styled by one stylesheet
(`src/bridge/bridge.css`) driven by CSS custom properties per theme class on `<html>`, so the design's exact colours
and shapes are not filtered through Chakra. The existing logic is reused untouched where possible: `computeBridgeDraft`,
`tipStatusOf`, the delivery-cost and priority-fee queries, the URL-state model in `src/app/route.ts`, and
`TransactionDialog` for signing. Chakra stays for the explorer views; the theme class also sets Chakra's `dark`/`light`.

**Tech stack:** React 19, TypeScript, Vite, Vitest + Testing Library, viem, wagmi; Chakra UI only outside `src/bridge/`.

**Spec:** `docs/superpowers/specs/2026-10-30-dapp-bridge-first-design.md` — read it in full, including "The owner's
words, verbatim", which wins over every summary here. Mockups: `design/ui/screens/` and https://zkb.fi/ui.

## Global constraints

- Shapes: square panels, pill controls (border-radius 999px), one ring radius, heavy dots, 50.4° diagonal. No other
  radius, no shadows, no gradients, no opacity on the pulse track.
- Never a native `<select>`; menus are custom (pill trigger, square popover/sheet), keyboard and screen-reader usable
  (role menu/listbox, arrow keys, Escape, focus return).
- Chevrons for every menu/disclosure; no carets (▾); no gear icons. Delivery settings use a sliders icon; the account
  uses an identicon.
- Tokens always shown with their icon. The output token shows the input token's icon with a destination-chain badge.
- Non-input numbers with three or more leading zeros after the point render as `0.0<sub>n</sub>rest`
  (0.0001234 → 0.0₃1234). Fewer zeros render as they are. Typed amounts are never rewritten.
- Tooltips are never white on black: dark raised surface `#2a2724`, edge `#3a3632`, text `#f0ede8` (mirror on light).
- Themes: Ember light, Ember on black, Mono; the setting offers System (default), Light, Dark, Mono.
- Default RPC for every chain: `https://one.valve.city/rpc/vk_demo/evm/<chainId>`. Every outside endpoint is
  user-replaceable in Settings with a live check and a reset.
- Gas is a gas-can icon, never the word "gas".
- Commits as zkbfidev <zkbfi@proton.me>, no attribution lines.

## Review focus

1. A token symbol rendered without an icon anywhere on the bridge screen (fees, notes, buttons) — grep the rendered
   DOM in a test for every token symbol and assert an `img` sibling.
2. Tiny static values (gas, tips on cheap chains) with many zeros — `formatStatic(0.00000042)` must give zeros=6.
3. Wallet not connected: the card still renders and the Bridge pill reads "Connect wallet"; nothing throws on
   `account === null`.
4. A crafted link prefilling receiver/amount/tip: the review sheet still lists the linked fields (existing
   `linkedFields`), and the Bridge pill never submits without the sheet.
5. Images: a downloaded SVG with `<script>`, `<foreignObject>`, `on*=` attributes or `href="http…"` is rejected by the
   icon build step; a failed download falls back to a lettered pill, never a broken image.

---

### Task 1: Theme tokens and the three themes

**Files:** Create `src/bridge/bridge.css`, `src/bridge/themes.ts`; Modify `src/app/theme.ts`,
`src/search/search-model.ts` (ThemeChoice), `src/app/SettingsDialog.tsx`, `src/main.tsx` (import css);
Test `test/bridge/themes.test.ts`.

**Interfaces:** Produces `type ThemeChoice = "system" | "light" | "dark" | "mono"`,
`resolveTheme(choice: ThemeChoice, prefersDark: boolean): "ember-light" | "ember-dark" | "mono"`; `useThemeChoice`
applies `theme-<resolved>` plus `dark`/`light` on `<html>`.

- [ ] Test: `resolveTheme("system", true) === "ember-dark"`, `resolveTheme("system", false) === "ember-light"`,
  `resolveTheme("mono", false) === "mono"`, stored `"mono"` survives a reload; Settings offers four choices, System
  first and default.
- [ ] Implement; the CSS defines per theme: `--page --band-from --band-from-ink --band-to --ink --muted --accent
  --track-ahead --pill-bg --pill-edge --go-bg --go-ink --tooltip-bg --tooltip-edge` with the mockup values
  (Ember on black: page #121110, from #eb6834, to #1c1a18, go #f0ede8 on #121110; Ember light: page #fff7f2, to
  #fde4d7, go #1b1a19; Mono: #0b0b0b flat, off-white pills/mark/go, accent only on motion).
- [ ] tsc, vitest, vite build; commit.

### Task 2: Icons and numbers

**Files:** Create `src/bridge/icons.tsx`, `src/bridge/number.ts`, `src/bridge/Num.tsx`; Test
`test/bridge/number.test.ts`, `test/bridge/icons.test.tsx`.

**Interfaces:** `collapseZeros(text: string): { lead: string; zeros: number; rest: string } | null` (null below 3);
`<Num text={string} />`; icons `Chevron({dir})`, `SlidersIcon`, `MoneyHand`, `GasCan({level?: 0|1|2|3})` (bars),
`ClockIcon`, `ExternalLink`, `FlipIcon`, `Identicon({address})`.

- [ ] Test `collapseZeros("0.0001234")` → `{lead:"0.0", zeros:3, rest:"1234"}`; `"0.00000042"` → zeros 6;
  `"0.0012"` → null; `"12.5"` → null; `<Num text="0.0001234"/>` renders a `<sub>3</sub>`.
- [ ] Implement; commit.

### Task 3: Token and chain images (build step + runtime source)

**Files:** Create `scripts/fetch-icons.ts`, `public/icons/` (+ `icons.lock.json`), `src/bridge/TokenIcon.tsx`,
`src/bridge/image-source.ts`; Modify `package.json` (`"icons": "node scripts/fetch-icons.ts"`); Test
`test/bridge/fetch-icons.test.ts`, `test/bridge/token-icon.test.tsx`.

**Interfaces:** `checkSvg(text: string): string | null` (reason or null); `iconUrl({ chainId, address? },
imageServer: string): string` — shipped file `./icons/<chainId>[-<address>].<ext>` when listed in the lock, else the
image server template `{chainId}`/`{address}`; `<TokenIcon chainId address? badgeChainId? symbol />` falls back to a
lettered pill on error.

- [ ] Tests: `checkSvg` rejects script, foreignObject, `on*=`, external `href`; accepts the gib.show Ethereum SVG;
  TokenIcon renders the badge `img` only when `badgeChainId` is set; image error shows the lettered fallback.
- [ ] Run the script for chains 1, 369, 11155111, 943 (and the pair's tokens it can list); commit files + lock.

### Task 4: Endpoint settings (everything swappable)

**Files:** Create `src/bridge/endpoints.ts`, `src/bridge/SettingsPanel.tsx`; Modify `src/app/SettingsDialog.tsx`,
the RPC wiring in `src/app/services.tsx`/wallet providers to read overrides; Test `test/bridge/endpoints.test.ts`.

**Interfaces:** `type Endpoints = { rpc: Record<number,string>; prover: string; indexer: string; archive: string;
msgboard: string; images: string }`; `defaultEndpoints(chainIds: number[], configuration): Endpoints` (RPC default
`https://one.valve.city/rpc/vk_demo/evm/<id>`); `loadEndpoints/saveEndpoints/resetEndpoints` (localStorage,
try/catch); `checkEndpoint(kind, url): Promise<{ok:boolean; ms:number}>`.

- [ ] Tests: defaults per chain id; a saved override wins; reset restores; a malformed URL is refused; the secret
  scan (`assertNoSecrets`) still applies to build-time values (the demo key is public and allowed).
- [ ] Commit.

### Task 5: Pulse track and step list

**Files:** Create `src/bridge/PulseTrack.tsx`, `src/bridge/StepList.tsx`; Test `test/bridge/pulse.test.tsx`.

**Interfaces:** `<PulseTrack position={0..1} stops={number[]} />` — variant B: track 3, pill 14×6.4, stops r 1.2,
lit `--accent` behind the pill, `--track-ahead` ahead, passed stops pale, ahead stops dark, destination dot dark until
1; `<StepList steps={{label, at?: string, estimate?: string, href?: string}[]} current={n} />` — dots joined by a
line, lit through `current`, external-link icon right of the timestamp for reached steps with `href`.

- [ ] Tests: no `opacity` attribute anywhere in the pulse SVG; the lit segment ends at the pill; future steps have no
  link; reached steps render an external link with `rel="noreferrer"` and the href.
- [ ] Commit.

### Task 6: Header and routes (bridge home; Activity/Explore stubs)

**Files:** Create `src/bridge/Header.tsx`; Modify `src/app/route.ts` (routes `bridge` with `pairId` and `dir`,
`activity`, `explore`; empty hash → bridge), `src/app/Shell.tsx`; Test `test/app/route.test.ts`,
`test/bridge/header.test.tsx`.

**Interfaces:** `Route` gains `{name:"bridge"; pairId: string|null; dir: "first-to-second"|"second-to-first"}`,
`{name:"activity"}`, `{name:"explore"}`; header `[mark] [page name] [search pill]` (search opens the existing palette;
the palette lists Activity, Bridge, Explore as items).

- [ ] Tests: `#/` → bridge default; `#/bridge/eth-pls?dir=second-to-first` round-trips; palette contains the three
  pages; header shows the active page name.
- [ ] Commit.

### Task 7: The card — From row, From band, seam, To band, To row

**Files:** Create `src/bridge/BridgeScreen.tsx`, `src/bridge/JoinedPill.tsx`, `src/bridge/bridge-model.ts`; Test
`test/bridge/bridge-screen.test.tsx`, `test/bridge/bridge-model.test.ts`.

**Interfaces:** `bridgeView(input): { source, destination, token, amountText, received, balanceText, usdText|null,
receiver, receiverIsSelf }` built on `computeBridgeDraft`; JoinedPill `{left, right, onLeft, onRight}`.

- [ ] Tests: From row shows "From" + source chain icon and the account; balance + MAX right, USD left ("—" until an
  oracle exists); MAX fills the amount; flip swaps dir and maps the token to its counterpart keeping the amount; the
  output shows the input token's icon with the destination badge and "arrives as <symbol> on <chain>"; To row shows
  the destination chain and receiver (self by default); typing in the amount writes the hash in place.
- [ ] Commit.

### Task 8: Fee line and drawers

**Files:** Create `src/bridge/FeeLine.tsx`, `src/bridge/Tooltip.tsx`; Test `test/bridge/fee-line.test.tsx`.

**Interfaces:** `<FeeLine draft report priority onOptions />` — three items (MoneyHand tip, GasCan with level bars,
Clock); tooltips on hover/focus/long-press; tip drawer with two sliders and tick marks (break-even for bots, typical;
today's gas price); time drawer with the steps and estimates; click again or outside closes.

- [ ] Tests: the words "Tip" and "Gas" never appear as labels in the line; each item has a tooltip; clicking the tip
  opens the drawer between the line and the output; Escape/click outside closes; slider changes update options
  (percent) and the hash.
- [ ] Commit.

### Task 9: Bridge pill verdict and the review sheet

**Files:** Create `src/bridge/verdict.ts`, `src/bridge/BridgePill.tsx`, `src/bridge/ReviewSheet.tsx`; Test
`test/bridge/verdict.test.ts`, `test/bridge/review-sheet.test.tsx`.

**Interfaces:** `verdictOf({ draft, connected, balanceOk, receiverValid, gateOpen, tipBelowBreakEven }):
{ kind: "go" | "warn" | "blocked" | "connect"; label: string; detail: string | null }`.

- [ ] Tests: no wallet → "Connect wallet"; amount over balance → blocked "Not enough <symbol>"; tip below break-even
  → warn "Tip too low · may not be delivered" (still pressable); paused gate → blocked; ready → go "Bridge". Pressing
  go/warn opens the review sheet (lists send, arrives, tip, gas, time, destination, linked-field warning); "Confirm in
  wallet" hands the steps to `TransactionDialog`.
- [ ] Commit.

### Task 10: Direction menu and token picker

Owner (verbatim, wins over anything else here): "the drawer works well on mobile in general. dropdown works for the from
network for sure, and the choose a token should be a modal. make the remove button just an icon+button if it is going
to exist at all. on desktop, that drawer should be a modal. and i do not like that n chains are showing at the same
time. we should pull tkoens that the user has a balance of or that they have used in this system or bridged with
before. i would like to see tabs below the search." Mockups: `picker-modal.html`, `picker-direction.html`.

Owner, round 3 (verbatim; supersedes round 2 where they differ): "on mobile, your earlier render of the token picker on
phone was better. all the way to the edge. only one layer of padding before content. remove the chain pills. just do
all, and then each chain that is supported. all of the "anything else: search above. every bridgable token is found
here" is stupid. be terse. remove the "choose a token" move the close button to be over/inside of the input on the
right.. the checkmark denoting the selected token is dumb. it shifts content away. eggregious ui violation"
Mockup: `picker-v3.html`. So:
- Phone: full width, edge to edge, rising from the bottom; one layer of padding before content. Desktop: the same
  content as a centred modal.
- No title. Close is an icon-only round button inside the search field, on its right.
- Flat text tabs under the search (no pills): All, then each supported chain (icon + name); the active tab has a
  3-unit accent underline.
- Rows: token icon (+ chain badge where bridged), symbol, chain name in small text, balance and USD right-aligned. Only
  the user's tokens (held, or used/bridged with zkb.fi); search covers every token.
- The selected token: lit row background plus an accent bar on its left edge, absolutely positioned. No checkmark;
  nothing may shift.
- No helper copy. Terse.
- General rule: selection and state indicators never change layout (no added icons that push content). Applies to
  every menu (the direction menu's current route too).

**Files:** Create `src/bridge/DirectionMenu.tsx`, `src/bridge/TokenPicker.tsx`, `src/bridge/token-picker-model.ts`,
`src/bridge/Sheet.tsx`; Test `test/bridge/direction-menu.test.tsx`, `test/bridge/token-picker.test.tsx`.

**Interfaces:**
- `Sheet({ title, onClose, variant: "drawer" | "modal" })`: a drawer from the bottom on phones that becomes a centred
  modal on desktop (`drawer`), or a square modal on both (`modal`); close is an icon-only round button (no text).
- DirectionMenu: a dropdown from the From pill. Routes grouped by pair, testnets under their own heading; each row
  shows the two chain icons with a chevron between, the time and status; a check on the current route; paused routes
  greyed with the reason. Choosing one sets pair + dir.
- TokenPicker: a modal on phone and desktop. Search field, then flat text tabs: All, then one per chain (chain icon + name);
  the active tab has a 3-unit accent underline (round 3 replaced the counted chain pills). A tab lists only the user's tokens: balance > 0, or used/bridged with zkb.fi before
  (activity history). Search finds every bridgeable token on every chain. Picking a token on the other chain's tab
  flips the direction. Omnibridge copies carry an orange "Omnibridge" flag.
- `pickerTokens({ tokens, balances, history, query, tab }): { tabs: {chainId, count}[]; rows: TokenRow[] }`.

- [ ] Tests: the open picker shows tabs, not two chains' lists at once; without a query a tab lists only held or used
  tokens; a query searches every chain; picking a second-chain token sets dir second-to-first; keyboard (arrows,
  Enter, Escape returns focus); the close control has an accessible name and no visible text; no `<select>` in the DOM.
- [ ] Commit.

### Task 11: Self-delivery balance check (Activity groundwork)

**Files:** Create `src/bridge/self-delivery.ts`; Test `test/bridge/self-delivery.test.ts`.

**Interfaces:** `selfDeliveryState({ nativeBalance, estimatedGas }): { enabled: boolean; reason: string | null }`.

- [ ] Tests: short balance disables with a reason naming what is held, what is needed, and what to add.
- [ ] Commit.

### Task 12: Verification against the owner's words

- [ ] Build with `VITE_EXPLORER_DATA=fixture`; screenshot phone (390 px) and desktop in all three themes.
- [ ] Walk every item of "The owner's words, verbatim" and record pass/fail with the screenshot that shows it.

### Task 13: Custom tokens (after the round-4 picker, the delivery menu, gas levels, the dialog, paused routes, history)

Owner (verbatim): "we will also have to handle custom tokens as well. tokens that neither bridge has ever seen. we can
add a warning to the bridge button stating that this is the first time that this token hasbeen bridged and it may be
wise to keep the amount low."

**Files:** Create `src/bridge/custom-token.ts`; Modify `src/bridge/TokenPicker.tsx`, `src/bridge/verdict.ts`,
`src/bridge/BridgeScreen.tsx`; Test `test/bridge/custom-token.test.tsx`.

**Interfaces:** `resolveCustomToken(address, chainId, readContract): Promise<{ address, name, symbol, decimals } | null>`
reads name/symbol/decimals over the user's RPC (refuses a non-contract or a contract that does not answer as ERC-20);
`isFirstBridge(token, tokens, factory)`: true when zkb.fi has no deployed counterpart for it (not known to the token
factory) and it is not an Omnibridge copy. Icon: the image server, else the neutral lettered disc.

- [ ] The picker's search accepts a pasted address that is in no list; it resolves on-chain and appears as one row.
- [ ] The verdict gets `firstBridge: boolean`: the Bridge pill takes the overridable warning state (orange outline)
  "First time this token is bridged · keep the amount low", with a line under it: the first transfer also deploys the
  token's counterpart on the other chain, and a small first amount limits the risk.
- [ ] Tests: an unknown address resolves and shows the warning; a known token does not; an Omnibridge copy keeps its
  own double-wrap warning instead.

## Data-wiring audit (live build, Sepolia ↔ PulseChain v4, 2026-10-30)

Owner: "it's getting there, but you need to connect a lot of data points". Every value that showed "—", a constant, a
sample number or nothing in live mode, checked against `release.env` on the dev server and the indexer's answers
(`/api/tokens` = `[]`, `/api/feed` = no items, `/api/heads` = the light client on Sepolia 9504 slots behind PulseChain v4,
`/api/delivery-cost` = default gas 550000 on both chains). Watched as the deployer with the dev-only `?watch=`.

Bridge
- [x] Token pill and output with no wallet and no bridged tokens: native coin by default, fee estimated without a wallet.
- [x] Source balance, per chain, native and ERC-20 (user's RPC). Native read from the snapshot's native balance.
- [x] MAX = balance less a gas reserve (400k gas × max fee per gas) for the native coin; the full balance for a token.
- [x] Route status from the gate (paused shows on the pill; real: Sepolia → PulseChain v4 is paused).
- [x] Light-client lag in the time item ("~16 min + light client 32 h behind") from the indexer's heads. On v4 the
      light client on Sepolia (PulseChain → Sepolia) is ~26 h behind; the one on PulseChain reports no lag (null), so
      Sepolia → PulseChain shows the plain estimate.
- [x] Fee from the delivery-cost report and the priority fee through the RPC; breakdown in the drawer (needs a price).
- [ ] USD on the balance lines: "—" on testnets by spec. A labelled "mainnet price" is not trivial (the oracle maps
      only Ethereum-mainnet origins), so it stays "—".
- [ ] Arrival time per direction: still the per-chain constants (finality + proof + delivery). The heads give the lag
      only; the backend has no proving-time status endpoint the dapp reads yet, and no recorded average is published.
- [ ] "arrives as zkbETH" for the wrap route: the label should name what the wrap route mints; not checked on chain.

Picker
- [x] Token list per chain: the registry (`/api/tokens`, empty on v4) plus each chain's native coin.
- [x] Balances per token including the native coin.
- [ ] The wallet's history (indexer) adds tokens only through the feed, which is empty on v4.
- [ ] Unit prices: "—" on testnets (spec).

Drawers and review
- [x] Gas level, ceiling, cap and tip sliders read the live report.
- [ ] Time drawer steps: constants per chain (same as arrival time above).

Signing
- [x] Steps and decoded calls come from the planned transactions (real).

Activity
- [x] Feed from the indexer filtered by the wallet, plus pending local submissions. Empty on v4 (no transfers yet).
- [ ] Not verifiable with real rows until a transfer exists on v4.

Explore
- [ ] Still the pairs table; the Explore build (spec "Explore", mockups explore-map, explore, explore-address-tx) is next.

`/api/delivery-cost` is right (checked against the chains): testnet base fees really are 14 wei (Sepolia) and 7 wei
(PulseChain v4). Near-zero gas shows through the leading-zeros rule, and the anticipated cost is then mostly the $0.025
proof.

Explore, where neither the indexer nor the chain gives a value (shown as "—", reason on hover): which of the 512 sync
committee seats signed a proof; proving time; transfers a proof covered (no proof → message link); volume in dollars on
testnets; who delivered (so "Delivered by bots" and "Tips earned"); contracts an address deployed; per-token gate caps;
release versions (no release events yet). "Watch" on the address page is not built (no watched-address store).

## Later phase (not in this plan)

Activity screen, Explore screen, the sideways slide between screens, the price oracle, the Omnibridge token list and
warning, the restyled transaction dialog and message dialog.
