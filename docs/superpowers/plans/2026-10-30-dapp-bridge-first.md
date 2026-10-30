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

**Files:** Create `src/bridge/DirectionMenu.tsx`, `src/bridge/TokenPicker.tsx`; Test
`test/bridge/direction-menu.test.tsx`, `test/bridge/token-picker.test.tsx`.

**Interfaces:** DirectionMenu lists every direction of every pair the release has, grouped by pair, testnets under
their own heading; choosing one sets pair + dir (a pair change reloads via the hash). TokenPicker is a sheet with a
search field over every bridgeable token (both chains; source chain first); choosing a token on the other chain flips
the direction.

- [ ] Tests: keyboard navigation (arrows, Enter, Escape returns focus); search narrows by symbol and address; picking
  a second-chain token sets dir second-to-first; no `<select>` in the DOM.
- [ ] Commit.

### Task 11: Self-delivery balance check (Activity groundwork)

**Files:** Create `src/bridge/self-delivery.ts`; Test `test/bridge/self-delivery.test.ts`.

**Interfaces:** `selfDeliveryState({ nativeBalance, estimatedGas }): { enabled: boolean; reason: string | null }`.

- [ ] Tests: short balance disables with a reason naming what is held, what is needed, and what to add.
- [ ] Commit.

### Task 12: Verification against the owner's words

- [ ] Build with `VITE_EXPLORER_DATA=fixture`; screenshot phone (390 px) and desktop in all three themes.
- [ ] Walk every item of "The owner's words, verbatim" and record pass/fail with the screenshot that shows it.

## Later phase (not in this plan)

Activity screen, Explore screen, the sideways slide between screens, the price oracle, the Omnibridge token list and
warning, the restyled transaction dialog and message dialog.
