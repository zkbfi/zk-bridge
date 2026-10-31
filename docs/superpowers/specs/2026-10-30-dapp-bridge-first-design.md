# zkb.fi dapp: bridge-first redesign

Date: 2026-10-30. Status: in review with the owner. Open: the review sheet, the settings pill at the seam, and
mode navigation (whole-screen slides), shown at https://zkb.fi/ui and in the companion.
Mockups: https://zkb.fi/ui (source `design/ui/screens/`): `page-v2.html` is the approved layout, `themes-v2.html` the
themes (D1, D3, E3 chosen), `ember-button-v2.html` the Bridge pill (1 chosen), `language.html` the design language,
`inflight-dots.html` option C the in-flight indicator. They are throwaway HTML, not code.

## Intent

The dapp (explorer/web) works but "looks like crap": it opens on an explorer with tables, filters and panels. A person
who came to bridge should see one thing: what they send, from where, to where, and one button. Around that, the page
answers the questions people have once they have bridged: where is my transfer, how long will it take, what did I do
before. Everything else stays in the dapp but out of the way.

The look comes from the zkb.fi mark, so the app and the logo read as one thing.

## Goals

- The first screen is the bridge: amount, token, direction (pair + chain), optional other destination address, one
  Bridge button. It opens on the default pair and direction (eth-pls, Ethereum → PulseChain; until that deployment
  exists, sepolia-pls943, Sepolia → PulseChain testnet v4), as already shipped in 0.1.1.
- Under it, "Your activity": the connected wallet's transfers, newest first, each with the pulse tracker, the current
  step in plain words, and the time left (estimate) while in flight.
- One design language, taken from the mark (below), applied to the whole bridge screen.
- Every state stays in the hash (0.1.1 behaviour): direction, token, amount, destination, open menus that matter.

## Non-goals

- No new bridge features, contracts or backend endpoints beyond what the activity list and the time estimate need.
- No redesign of the explorer views themselves in this project (pairs table, history, transfer and address pages,
  prover, audit, docs, connections). They keep working and keep their routes.
- No token swapping or price quotes; what arrives is the bridged amount minus the fee.

## Anti-goals (a failure even if it works)

- Any shape outside the design language: rounded-rectangle panels or cards, a second curve radius, gradients,
  shadows as decoration. The owner rejected "another curve to the design language".
- Native `<select>` elements anywhere on the bridge screen. Menus are custom (pill trigger, square popover).
- Explorer clutter on the first screen: tables, filter bars, light-client heads, summary stats.
- Mixed stroke weights that read as a "jumbled mess" (owner's words about the logo; same standard here).

## Design language (decided with the owner)

Everything is one of five shapes, all from the mark:

1. Straight 3-unit stroke, ends cut square (the deck, the stems): rules, dividers, panel borders.
2. The ring, one radius only: loaders and progress, never decoration. The swirl loader is already shipped.
3. Heavy dots: source (solid) and destination (faint until reached). Chain ends and status.
4. The pill (the Sync pulse): the only rounded rectangle. Buttons, token chips, the pair menu trigger, the destination
   toggle, wallet chip, and the thing in flight.
5. The 50.4° diagonal (z and k arm, parallel): available for direction marks; optional.

## Themes (decided with the owner)

Three themes, same shapes and layout:

- **Ember light** (mockup D1): page #fff7f2; the From band is solid accent #eb6834 with white text; the To band a pale
  tint #fde4d7; pills white; the Bridge pill solid ink #1b1a19.
- **Ember on black** (mockup D3): page #121110; the From band solid accent with white text; the To band #1c1a18; the
  Bridge pill solid off-white #f0ede8 with ink text. The owner: the Bridge pill "should outshout the orange band".
- **Monochrome** (mockup E3), the accessibility theme: pure black, one flat surface, hairline dividers, off-white
  outlined pills, off-white mark and Bridge pill; orange appears only on things in motion (the activity tracker).

Light/dark follows the system setting, with a manual choice that also offers Monochrome (the dapp already has a theme
setting). Bands are separated by tone, not by the heavy black rules of the first draft (the owner was unsure about the
borders; every chosen theme drops them; Monochrome uses hairlines). Text contrast meets 4.5:1 in every theme.

## Layout (decided with the owner)

Square panels, pill controls. Panels are full-width bands that bleed to the viewport edges, told apart by tone (see
Themes); the square corners are what let them meet the edge. Content inside every band shares one column (max ~420–480 px,
centred on wide screens, edge-to-edge minus a 16 px gutter on phones), so the fields, the Bridge pill and the activity
rows line up on one left and one right edge.

Top to bottom:

1. Header band: the mark (and "zkb.fi"), wallet pill on the right.
2. From band (the accent surface in the Ember themes): a pill "• From Ethereum ▾" that opens the direction menu; the amount (large); a token pill
   (menu); balance with Max.
3. Flip button: a round button sitting on the seam between From and To. It swaps the direction (same as picking the
   reverse in the menu).
4. To band (the tint, or one step lighter than the page on black): "∘ To PulseChain" (derived from the direction, faint destination dot), what arrives,
   and the token received.
5. Action band: "+ Send to another address" as a dashed pill that expands into an address field; arrival estimate and
   fee on one line; the Bridge pill (solid, the strongest element in each theme).
6. Activity band: "Your activity", one row per transfer.

The direction menu lists every direction of every pair the release has, grouped by pair, testnets under their own
heading: e.g. "Ethereum → PulseChain", "PulseChain → Ethereum", then "Testnet: Sepolia → PulseChain v4", "PulseChain
v4 → Sepolia". Picking one sets pair and direction. A different pair is a different page load today (services are
built per pair, see `selectPair`); that may stay, as long as the hash keeps the choice and the loader covers it.

## In-flight and activity (decided with the owner)

The pulse tracker (mockup `inflight-dots.html`, option C): a faded 3-unit track between a solid source dot and a
faint destination dot; small dots on the track for the stages; the two-tone pill sits at the current stage. Stages:
sent, final, proven, delivered (the same four as the ring-fill loader). Delivered: the track turns solid and the
destination dot lights. Each row: tracker, amount and token, the step in plain words ("final · waiting for the proof"),
and the time left while in flight or the age once delivered. A row links to the existing transfer page.

## Decided by me (owner can override)

- The rest of the current dapp (pairs table, history with filters, transfer/address pages, prover, audit, docs,
  connections/settings) stays reachable from the existing search/command palette and from a quiet menu behind the
  wallet pill, never on the bridge screen. I asked; the owner's reply ("yes, I think you have it now") did not settle
  it, so this is my call.
- Advanced delivery settings that exist today (call mode with target/data, gas limit, tip mode and its settings, relay
  router, wrap-and-bridge of the native coin) move behind one "Advanced" pill in the action band, collapsed by default;
  the native coin appears in the token menu and wraps automatically where the current form already supports it.
- No wallet connected: the bridge screen still shows (amount can be typed, estimate shown), the Bridge pill reads
  "Connect wallet", and the activity band explains it shows your transfers once connected.

## Settled after the builder check (my calls; owner can override)

- **Routes.** The bridge screen is home: an empty hash opens `#/bridge/<pair>` (with `?dir=` for the direction and the
  form fields in the query, as today). Nobody uses the dapp yet (owner), so there is no old link or route to keep working: routes and hash keys may be
  redesigned freely. The direction menu changes `<pair>` and `dir`; amount and destination survive a pair change
  through the hash (the page reloads behind the loader, as it does today).
- **Review step stays.** Bridge never opens the wallet directly: the existing review (tip, router warning, fee terms,
  and the "fields a link filled in" warning) and the step-by-step transaction view remain, redrawn in the new language
  (a square sheet that rises from the bottom edge on phones and sits as a square panel on desktop, pill buttons, no
  shadows). This is in scope.
- **Themes apply to the whole app.** Ember light, Ember on black and Monochrome are set at the token level (colours,
  radii: pills full, panels square), so the explorer views take the palette too; their layouts are not redesigned.
  The theme setting offers System, Light, Dark and Monochrome; the default is System (owner).
- **Header on every route:** the mark (home), a search pill (owner: "a generalized shortcut and search hamburger bar"
  that reaches anything: bridging, activity, the explorer and its pages, the indexer's data, docs, settings; it replaces
  a menu, works by tap on phones and by Ctrl/Cmd-K or / on desktop), and the wallet pill (its menu holds the explorer
  links, settings, and "Send a message").
- **Send a message and call mode.** "Send a message" leaves the bridge screen and lives in the wallet menu and the
  palette, opening the existing dialog (redrawn). Call mode, gas, tip and router stay behind "Advanced". Hash keys may change (no users yet); the linked-field warning still applies to whatever a link fills in.
- **Your activity:** the current pair, both directions; transfers the wallet sent and transfers it received (so a send
  to another address shows for both sides); messages the wallet sent; a transfer appears as "sent" the moment its
  transaction is submitted (local pending state until the indexer has it); the latest 5, then "All activity" opens the
  history view filtered to the wallet.
- **Token menu and Flip.** The direction comes first. The token picker is a sheet with a search field (owner) that
  searches every bridgeable token; the source chain's tokens come first, and picking a token on the other chain flips
  the direction (my guess at "search through all tokens"). The native coin is included where wrap-and-bridge exists. Flip reverses the direction and switches the token to its counterpart
  on the other chain, keeping the amount. The hash stores the direction (`dir`), not the token's side.

- **Chain and token icons** (owner): the real Ethereum and PulseChain marks, taken from gib.show
  (`https://gib.show/image/<chainId>` for chains, `https://gib.show/image/<chainId>/<token>` for tokens) by a build
  step that downloads them into the site, so the IPFS release never calls gib.show at run time. Downloaded files are
  checked (SVGs with scripts or outside references are refused) and pinned by hash in the repo so a build is
  reproducible.

## Card details (decided with the owner, 2026-10-30 afternoon)

- **Header:** logo · the active page's name in the middle (Activity / Bridge / Explore; the screens slide sideways and
  are also items in search) · search on the right.
- **From row:** "From" + the source chain's icon (opens the direction menu) joined to your account on that chain
  (address + identicon; opens the account menu). **To row** mirrors it above the Bridge pill: "To" + the destination
  chain icon joined to the destination address (your wallet by default).
- **Token:** the output shows the same token as the input: the same icon with a small badge of the destination chain
  (ETH with a PulseChain badge; the on-chain token is zkbWETH, said in small text under the amount).
- **Balance line:** right-aligned under the token pill so MAX lines up with the token pill's edge; the USD value on
  the left. Same line under the output (USD left).
- **USD needs a real oracle (owner):** today's USD values come from tokens bridged over the Omnibridge, not from this
  bridge's tokens, so they are wrong for zkb.fi. A price source covering the bridged tokens on both chains is a
  requirement; its design is a separate piece of work (see Open questions).
- **Fee line:** three soft-coloured icon + value items, no words: tip (a hand holding money), gas (a pump), time (a
  clock). Each has a tooltip; the tip's explains how the tip is calculated. Tapping the tip opens a drawer between the
  fee line and the output amount with sliders that have tick marks (e.g. where delivery stops being profitable for
  bots, a typical tip, today's gas price) and more ? tooltips. Tapping the time opens the same drawer listing every
  technical step with its estimate. Tapping again or anywhere else closes it.
- **Bridge pill carries the verdict:** solid = go; orange outline = overridable warning ("Tip too low · may not be
  delivered", explained under the pill); grey = blocked (balance, invalid address, paused gate).
- **Icons:** chevrons for every menu and disclosure (no ▾ carets); no gear icons. Delivery settings use a sliders
  icon; the account uses an identicon.

- **Tooltips:** never white on black; a raised dark surface (#2a2724, 1.5 px #3a3632 edge, off-white text); on light
  themes the mirror (a raised light surface).
- **Omnibridge tokens (owner):** when the chosen token is one that came over the existing Omnibridge (a wrapped copy of a
  token from the other chain), the card warns before anything else: bridging it with zkb.fi wraps it a second time,
  costs gas twice, and isolates the tokens (they only become the original again by undoing both bridges in order). It
  offers the Omnibridge as the way back and "Bridge anyway (double-wrapped)" as an orange-outline override. Detection
  needs a list of Omnibridge token addresses (or the Omnibridge mediators' token registries) per chain.
- **Activity screen** (left of Bridge): filter pills (All, In flight, Needs you, Delivered); in-flight transfers as
  cards with the pulse, the step in words and the time left; a transfer that needs you (proven but not delivered, e.g.
  the tip is below what bots need) says why and offers "Deliver it yourself" with its gas cost; delivered transfers
  below, by day, one line each (token, amount, route as chain icons, time). Opening one shows every step with its time
  and transaction link, plus "Open in the explorer" and "Bridge again".

- **The pulse, drawn properly (owner):** no opacity anywhere. The track is two solid colours: lit accent behind the
  pill (everything already passed), a solid dark ember (#4a2414 on black) ahead of it. Stops already passed are pale,
  stops ahead are dark. Proportions: **B, matched** (owner): the pill twice the track's height, the stops a third of the pill's height.
- **Steps of a transfer:** a vertical list whose dots are joined by a line, lit up to the current step and dark after
  it (the pulse turned on its side). Future steps show an estimate and no link. Every reached step ends with an external-link icon, right-justified, to the
  right of the timestamp, linking to that transaction (or block / proof) on the chain's explorer (owner).
- **Numbers that are not inputs:** three or more leading zeros after the decimal point collapse to a subscript count:
  0.0001234 shows as 0.0₃1234. Fewer than three zeros show as they are. Typed amounts are never rewritten.
- **Tokens always with their icon** wherever a symbol appears (amounts, fees, notes, buttons). **Gas is a gas can**
  icon, never the word. In the fee line, the gas can carries a small bar graph (like signal bars) showing the gas level
  chosen; tapping it lets the user pay more gas for speed (owner: "users can choose a higher gas payment if they want
  (default is a percent anyway)").
- **Self-delivery checks the wallet:** "Deliver it yourself" reads the connected wallet's native balance on the
  destination chain and is disabled when it can't pay the gas, with a tooltip saying how much it holds, how much is
  needed, and what to add.
- **Settings (owner):** theme (System default, Light, Dark, Mono); the RPC endpoint per chain, user-replaceable, with a
  live check, kept in this browser; the default for every chain, testnets included, is the valve.city demo key
  (owner): `https://one.valve.city/rpc/vk_demo/evm/<chainId>` (checked 2026-10-30: answers for 1, 369, 11155111, 943); the image server for token and chain icons (gib.show by default), replaceable.
  Icons the release already ships (pre-loaded at build time) don't depend on it.
- **Every endpoint is swappable (owner: "everything needs to be swappable"):** the settings list every outside service
  the page talks to, each with its default, a live check, and a reset: the RPC per chain (valve.city demo key), the
  prover request endpoint (default https://prove.zkb.fi), the indexer (https://indexer.zkb.fi), the archive
  (https://archive.zkb.fi), the msgboard endpoints the page uses, the price source once it exists, and the image server
  (gib.show). Nothing the page calls is fixed in code without a setting.

- **Token picker (owner, round 2):** a **modal** on phone and desktop (a square panel over the dimmed screen; on
  desktop centred in the column). Close is an icon-only round button. Under the search field, **tabs, one per chain**
  (chain icon + name + count); only one chain's list shows at a time. Each tab lists only **your** tokens: ones the
  wallet holds, or has used or bridged with zkb.fi before. Search finds every bridgeable token on every chain. Picking a
  token on the other chain's tab flips the direction. Omnibridge copies carry an orange "Omnibridge" flag in the list.
  Mockup: `picker-modal.html`.
- **Direction menu:** stays a dropdown from the From pill: routes grouped by pair (testnets under their own heading),
  each as two chain icons with a chevron, its time and status, a check on the current one, a paused route greyed with
  the reason. Mockup: `picker-direction.html` (right panel).
- **Drawers vs modals:** bottom drawers (sheets) work on phones (e.g. the review sheet); on desktop a drawer becomes a
  centred modal.

- **Token picker, round 3 (owner, supersedes round 2 where they differ):** on phone it runs edge to edge (full width,
  rising from the bottom), one layer of padding before content. No title. The close button is icon-only and sits
  inside the search field on its right. Tabs under the search are flat text tabs (no pills): **All**, then each
  supported chain (icon + name); the active tab has a 3-unit accent underline. Rows show the token, its chain in small
  text, balance and USD. The selected token is shown by a lit row with an accent bar on its left edge (absolutely
  placed): **no checkmark, nothing shifts**. No helper copy such as "anything else: search above". Terse. On desktop
  the same content is a centred modal. Mockup: `picker-v3.html`.

- **Token picker, round 4 (owner, supersedes rounds 2–3 where they differ):** the search is a full-width band edge to
  edge, coloured like the amount band ("a burn streak like the input"), with no pill and no top border; the close
  button is an exact square the full height of the band (52 × 52 px), flush right, the same orange as the band, set
  apart by a full-height 3-unit dark rule on its left edge (owner picked option A). Tabs: "All" as an icon (a 2×2
  grid of small circles), then each chain as its icon only (no names). Rows carry no
  chain name; the subtitle is the token's unit price. The badge on a token's icon shows its origin chain. Omnibridge
  copies get a bridge icon after the symbol (no pill), whose tooltip explains why it exists and offers an arrow link to
  the native token. Mockup: `picker-v4.html`.
- **Links can't silently set fund routing (security review of the first build):** only `dir`, `token` and `amount`
  prefill the Bridge screen silently; any other field a link sets (receiver, tip settings including the relay router,
  gas, call mode, target, data) is named in a warning on the screen and in the review sheet, which shows the full
  receiver address, the effective router and any router warning.

- **Custom tokens (owner):** the picker's search accepts a pasted address of a token neither bridge has seen. If zkb.fi
  has never bridged it, the Bridge pill takes the overridable warning state: "First time this token is bridged · keep
  the amount low", explained under the pill (the first transfer also creates its counterpart on the other chain).

- **Price oracle: PulseX pools (owner: "i think that the pulsex exchanges serve as good oracles").** Checked on-chain
  2026-10-30 through the valve.city RPC:
  - PulseX v1 factory `0x1715a3E4A142d8b698131108995174F37aEBA10D` (65,484 pairs) and v2 factory
    `0x29eA7545DEf87022BAdc76323F373EA1e707C523` (191,734 pairs); WPLS `0xA1077a294dDE1B09bB078844df40758a5D0f9a27`.
  - USD anchor: WPLS against the Omnibridge stablecoins USDC `0x15D38573d2feeb82e7ad5187aB8c1D52810B1f07`, DAI
    `0xefD766cCb38EaF1dfd701853BFCe31359239F305` and USDT `0x0Cb6F5a34ad42ec934882A05265A7d5F59b51A2f`. The v1 pools
    hold about $325k, $326k and $234k on the stable side and agree within 0.2% (PLS ≈ $0.0₅562).
  - Tokens price through their deepest WPLS pool (v1 or v2), times PLS/USD. Example: WETH from Ethereum
    `0x02DcdD04e3F455D838cd1249292C58f3B79e3C3C` ≈ 3.99e8 WPLS ≈ $2,243, matching its thin direct USDC pool ($2,230).
  - **Method:** PLS/USD = the depth-weighted median of the three stable pools across v1 and v2. A token's price =
    its WPLS pool with the deepest WPLS side, if that side is worth at least a minimum (say $10k), else "—". Tokens
    bridged by zkb.fi take their origin token's price (zkbWETH → ETH, via WETH from Ethereum on PulseX); Ethereum-side
    tokens likewise use their PulseChain market. Testnets show no prices.
  - **Bridged tokens and Ethereum costs (owner, short term):** every bridged token is reversed out through the current
    Omnibridge to its PulseChain copy and priced on PulseX (v1/v2) against USDC/USDT/DAI. ETH transaction costs use
    WETH from Ethereum on PulseX; a past cost uses the PulseChain block nearest the transaction's timestamp. No
    Ethereum pool or price feed is read.
  - **Where it runs:** in the browser, reading pool reserves through the user's RPC (swappable, batched, cached ~30 s),
    so the IPFS site needs no price server. The price source is listed in Settings like every other endpoint.
  - **Limits, stated in the UI tooltip:** spot reserves can be pushed around and Omnibridge copies can trade away from
    their originals, so prices are for display only and are never used to compute amounts, tips or fees.

- **Gas levels (owner):** choosing a higher level raises the gas-price ceiling the deliverer may spend (in every tip
  mode, including the default percentage tip), so the choice always does something. Normal / High / Highest allow
  up to 2× / 3× / 5× and are expected to cost 1× / 1.5× / 2.5× (owner: "those multipliers are fine"). The cost they
  multiply is the full cost of releasing as if this bridge were the only one: $0.025 proof + the destination gas.
- **Saving the cap (owner):** lowering the cap in the review applies to this bridge only; a small save button (a
  floppy-disk icon) next to the cap slider makes it the default for people who want that.
- **High-tip warning (owner):** the Bridge pill takes the overridable warning state when the tip is a large share of
  the amount: above 1% for transfers up to $100, a threshold that scales down to 0.1% at $1,000, and 0.1% above that.
  Between $100 and $1,000 the threshold is 1% × 100 / amount (a log-linear slide; it works out to a tip of about $1
  across that range). Uses the display price; without a price, the 1% threshold applies. The tip measured is the tip **before gas
  pricing** (owner): the share-of-amount part only, not what the gas level or gas reimbursement adds on top. **Tip and delivery are coupled in the UI**
  (owner, superseding "delivery is on top"): the user sees one fee, the money-hand item, that pays for everything; the
  tip drawer breaks it down. The **anticipated execution cost** = the destination-chain delivery gas at the chosen gas
  level + **$0.025 for proof generation** (owner's assumption). The "tip too low · may not be delivered" warning stays
  until the fee is at least **2 × the anticipated cost (a 100% margin)**. The high-tip warning (1% → 0.1%) measures the
  part of the fee above the anticipated cost, i.e. the tip before gas pricing (my reading of "this is before gas
  pricing"; owner to confirm).

- **Default fee and the automatic cap (owner):** the default fee is the larger of 0.1% of the amount and 2 × the
  anticipated cost. What the dapp sets automatically is capped at **1% of the amount**, and that cap is **adjustable**
  (a setting, also changeable in the review). When the cap binds, the fee stays below 2 × the cost and the low-fee
  warning stays on. **At checkout, always warn when the cap is too large** and let the user adjust it right there in
  the finalizing drawer (the review sheet). "Too large" (my reading, owner to confirm): the cap is above the high-tip
  threshold for this amount (1% up to $100, sliding to 0.1% at $1,000).

- **Fee-drawer motion (owner approved):** open ≈ 0.28 s (height 0.2 s ease-out via grid rows; the 3-unit accent deck
  line draws across the top from under the tapped icon; content fades in and settles 4 px, 0.06 s delay); close 0.12 s
  ease-in, content first; swapping redraws the line from the new icon; no overshoot or springs; reduced motion = none.
  Mockup: `design/ui/screens/accordion-motion.html`.

- **Size (owner):** the baseline is larger on phones and desktop, and grows further on large screens. Phones: 16 px
  body text, nothing under 13 px, a 40–44 px amount, touch targets ≥ 44 px (pills 48 px, the Bridge pill 56 px). The
  scale is fluid (clamp tokens) up to desktop, where type is visibly larger and the content column widens to about
  520–600 px, with the bands still running edge to edge.

- **Explore (owner: "explorer should help you explore every data aspect"):** mockups `design/ui/screens/explore-map.html`
  (v1: the live ring map, numbers, light clients, feed, services) and `design/ui/screens/explore.html` (v2):
  - The orange search band leads Explore and takes any identifier: tx hash, message ID, address, token symbol, slot,
    block, proof number, release CID. It shows what it recognised; results are grouped by kind with the match marked.
  - **Browse** is a single-column list: a large number on the left, the heading to its right, the subheading below
    it, a chevron on the far right. One row per kind: transfers & messages, proofs, tokens, addresses, contracts,
    gates & escrow, costs, releases.
  - The live ring map, the four numbers, the light-client cards, the latest-transfers feed and the services list follow.
  - **Every kind has its own page, and every value on a page links onward.** Proof page: what it proves, slot and
    block, the sync committee's 512 seats as lit/unlit cells, the posting tx, verifier, proving time, gas and cost,
    previous/next, and the transfers it proved. Token page: both addresses, escrowed vs minted, volume, gate cap, the
    Omnibridge copy as a separate token, its transfers. Address, transaction, message, slot/block, contract, gate,
    release and costs pages follow the same pattern.
  - **Row rule:** status is one word (delivered, waiting, proving, mining, …) as a pill at the right, and the chevron
    sits at the far right of the row.

- **Address and transaction pages** (mockup `design/ui/screens/explore-address-tx.html`): address = identity band
  (identicon, full address, role tags), per-chain balances and activity, totals through zkb.fi, tabs (transfers,
  proofs posted, contracts deployed, deliveries), "Bridge to this address" and "Watch". Transaction = kind band, decoded call, gas, fee, events, raw input collapsed, and **where it sits**: the step list
  starts with the **user's action** (the transfer that started it), and step labels are short ("Block final on
  PulseChain", not "Block 25,767,883 final…"). Tapping a step opens a small drawer with its details; the lit line joining
  completed steps runs on past an open drawer, unbroken (owner) (for a block:
  number, hash, time, slot, sync committee period and signers, explorer link). No explanatory sentence about what the
  transaction did (owner: it reads as temporary); the kind, the details and the steps say it. Routes in every list (including
  proofs) are shown as chain icons with a chevron, not as words.

- **Icons on the orange band (owner):** any chain or token icon placed on the accent band (the From band, the search
  band, Explore and page headers) sits on a neutral round plate, black or white, never directly on orange. The plate
  follows the theme (ink on Ember on black and Mono, white on Ember light), with a 2 px margin around the icon; badges
  keep their own small plate.

## Message page (decided with the owner, mockup explore-message.html)

Every transfer is a message; the message page tells one message's whole story. It is one of Explore's pages (header
reads Explore). Two kinds: a token transfer and a contract call.

- **Band:** the kind ("Token transfer" or "Contract call") with the route as chain icons on plates, the amount with
  its token icon (a call shows "Message"), the short message ID with a copy button, and status tags (status word, and
  the time it took once delivered).
- **Who and what (transfer):** From and To link to their address pages. A **Token** row names the token once: bold
  symbol then icon, linking to the token page. **Sent on / Received on** read "label, chain icon (alone, name only in
  its alt text), link to that chain's transaction" on the left as a fixed grid (label column ~11ch, then the chain
  icon, then the link icon, so icons line up down the rows); on the right the bold amount and the token icon, no
  symbol, then a chevron-wide spacer so token icons form one column with the Fee row. **Fee** is one row: "Fee" and the
  muted USD value (in the chain/link columns) on the left, the bold total and token icon on the right, with a right
  chevron that opens a drawer (chevron turns down): delivery gas (chain icon), proof generation, tip to the deliverer
  and a bold Total, each value an amount plus a 14 px token icon. The drawer uses the approved motion (grid rows
  0fr→1fr 200 ms cubic-bezier(.2,.7,.2,1), close 120 ms ease-in, the 3-unit accent deck line, content fading in after
  60 ms; none under reduced motion). **Delivered by** links to the address, or "—".
- **Who and what (call):** From, Calls (the target, by name when it is a deployment contract), Function (signature
  when the deployment's ABIs know it, else the selector), Arguments (bytes), Gas limit, Delivered by, Payload.
- **Steps:** the joined step line with a drawer per step: Sent on <chain>, Block final on <chain>, Proof #n posted to
  <chain>, Delivered on <chain> (or Call reverted / Release failed). The line stays joined through an open drawer. A
  reverted call stops there: its drawer opens by itself with a red top line and the reason first, and the page offers
  "Retry with more gas" (disabled until a retry path exists) and "Open the call". A step that is a real transaction
  shows its cost only in its open drawer, as a "Cost" row: "<native amount> <native symbol> · $<usd>" in the chain the
  transaction ran on (0.0₃ rule); a proof's row reads "shared · …" since one proof covers many transfers. Testnets
  have no USD: "—".
- **The message itself (transfer):** Nonce, Source app and Target app named precisely ("ERC-20 mediator <short
  address>", linking to the contract page; never "Token mediator"; names come from the deployment's contract map),
  Gas limit, and the payload collapsed with its decoded meaning ("mint 80 USDC to 0x52…9ee7").
- **No invented data:** whatever the indexer, deployment or chain does not give shows "—" with the reason on hover.

## Open questions

- Where the Omnibridge token list comes from and how it stays current.


## Left to the builder

- How the time-left estimate is computed (finality and proving timings per chain from what the indexer and backend
  already expose, or a per-pair constant to start); show it as an estimate ("about", "~").
- Where the activity data comes from (the indexer's feed filtered by address, as the history view does today).
- Component structure, how the existing BridgeForm logic is reused, and the test plan.
- Exact spacing, type scale, and the dark-theme palette within the language above.
- Keyboard and screen-reader behaviour of the custom menus (they must be accessible: proper roles, focus, Escape).

## The owner's words, verbatim

The owner asked that every spec carry their raw instructions, because builds made from a summary of a companion
session have dropped key pieces before. Where this document and these words disagree, these words win; ask. Keyboard
noise from one message (a child on the keyboard) is left out.

1. "it looks like the dapp loads. however, it still looks like crap. we need to greatly simplify what the user sees. an input token and amount and a chain/pairing selector. come up with a few options using the visual companion. i think that the main input and showing the result is pretty well established in bridge land, but there are other things we can do around it like communicate to the user where their bridge is in the process, how long it will take, their previous activity, things like that"
2. "we can also provide a destination address that is different than the existing infrastructure"
3. "the inflight bars are good, but we can use inspiration from the zkb logo with the dots at each end."
4. "i also think that you have to use pill shape. otherwise you are just adding another curve to the design language. that may be worth exploring as well. what is our design language. the pulse looks cool. go with that one for the activity"
5. "square panels, pill controls. that will allow us to line the button up with the content and the wrappers can get the the viewport edges"
6. "i think the chain/pair toggle can be combined and put into the "from ethereum" label. just turn it into a dropdown/menu (never use selects) and my point with having the pointed panels is to allow them to bleed to the edge of the viewport. do you disagree that that will work?"
7. "yes. i think you have it now"
8. "i don't know about the borders. i would like to see some theme variations"
9. "b,c,d,and e are all good. explore them all. 3 variations, or distinguishing characteristics from each would be good to surfac"
10. "i gotta say, ember d1 + d3 look really good. might be worth looking at an outlined white/orange button for the bridge button instead of white. i do like e3 for accessability purpose"
11. "no you're right. it should outshout the orange band. can you put some of these onto a picker so that i can share it with colleagues? something like zkb.fi/ui? we can put all of our variations there so that i can get collaboration"
12. On where the picker lives: "no, you know? lets just go with my suggestions. we can change it later. we need to get to the substance"
13. Answers to the builder check:
    - "1) one thing to remember is no one is using this yet"
    - "2) i have not seen this drawer from the bottom. please enlighten me"
    - "3) yes, and the default setting should be to follow the system"
    - "4) search pill should allow us to get to anything. docs, explorer, indexer, activity, bridging. anything. it's a generalized shortcut and search hamburger bar"
    - "5) i have not yet seen this gas pil so you'll have to help me out here. perhaps we move the switch button to the left side and then we have all of the toggles in a wider menu on the right, also between the input and output?"
    - "6) not sure how to present this yet. i think you could do something creative like a whole-screen-slide to the left / right to get into different modes/ navigate"
    - "7) correct, the token selector menu modal should also have a search bar and one should be able to search through all tokens"
14. "7) picking a token on the other chain flips the direction for you, yes / 2) that is fine, we should also use the bridge button to show things like, fee too low, bots will probably not deliver for you. and above the output token readout, we should have things like fee summaries. / so, something i have wanted to try is this: move the "from etheruem" up above the ember, and turn it into a continuous menu button, that joins with another input on the right side, which is your wallet on that network, then above the big bridge button, is your destination address section. we could also mirror it, showing "to pulsechain" on the left side and the address on the right. / 6) regarding your 3 modes, i think it would be worth putting the active page in the middle of the nav, and then, yes, the screens can slide sideways, but they are also accessible as items in the search on the right. i'll draw it out"
15. The sketch: "so we have / [logo] [active_page_name] [search] / From [input_chain_as_icon] ... [account_settings] / [input_amount] [selector - symbol+icon]"
16. "use the real ethereum and pulsechain icons. you can probably just pre-load them from gib.show during a build step so that we can host them on ipfs"
17. "eth icon with a small pulsechain badge. and the zkbweth should still be the same icon as the input and the output should match the input token. the balance line should be right aligned so that the max button lines up with the edge of the token input. we can then put a dollar value on the left side. we will also have to come up with a fairly comprehensive oracle. especially because, currently, the usd value is based on bridged tokens that have crossed over the omnibridge. not this one / the fee line is good, but is misses the mark. instead of the words "tip" and gas, you should use icons. 1) take my money fist, and gas can be a gas pump/can. The word arrives, can instead be removed. we can then soften the text color and add tooltips explaining each one. for the tip, it should explain how the tip is calculated. clicking on the tip should open a hidden drawer section below the 3 items and above the output amount to allow the user to use sliders with tick marks to denote end of profitabilty. more tooltips explaining hidden information there too. the duration can tell the user all of the different technical steps. clicking again or away closes it"
18. "i do not like the gear icons that you are using, nor the carots. use chevrons. pick something else to communicate what you are trying to say"
19. "the tooltip should be something other than white. it is too bright on the black bg. overall it looks good. i think the other thing that we need to check for is wrapped tokens from the existing omnibridge. if we detect such a token, we should warn the user about wasting gas and isolating their tokens since they would then be double wrapped. now show me the activity screen"
20. "the trail of the progress bar should not be so dark. it looks like you just slapped on opacity and called it a day. causes layered parts of the bar to be different colors. left of the pill should be lit up. and maybe play with the pill sizing and the middle dots sizing. looks clashy. also, some rules regarding number visualizations: anything static/not an input, should show leading zeros as 0.0<sub>3</sub>1234 for 0.0001234 any number under 3 does not make sense to do. we should show a gas can for the word, gas. we should also check the balance of the connected walet and disable delivery if they do not have enough (explaining why it is disabled with a tooltip) it looks like you are using a lot of token symbols without the icon. you should. use gib.show and we will have to add a settings modal / section for users to swap out the rpc. image server should be another thing that they can swap out"
21. "and the vertical dots that you are showing in the delivered section, those should be connected as they are progressed through"
22. "1) B, matched / 2) good, however the gas can on the input/output section should also have a bar graph showing different gas levels. users can choose a higher gas payment if they want (default is a percent anyway) / 3) great! be sure to add an external link icon justified to the right, to the right of the timestamp even, to link the user to the transaction / information on the blockchain / 4) you can use the valve.city demo key as a default for both chains. also supports testnets"
23. "if you are going to write specs for these updates, be sure to capture my raw instruction too. often when you do this with the visual companion, and then you build it for real, you leave out key pieces and end up creating a shittier ui"
24. "oh, you'll also have to point to a prover request endpoint. everything needs to be swappable"
25. "the drawer works well on mobile in general. dropdown works for the from network for sure, and the choose a token should be a modal. make the remove button just an icon+button if it is going to exist at all. on desktop, that drawer should be a modal. and i do not like that n chains are showing at the same time. we should pull tkoens that the user has a balance of or that they have used in this system or bridged with before. i would like to see tabs below the search."
26. "on mobile, your earlier render of the token picker on phone was better. all the way to the edge. only one layer of padding before content. remove the chain pills. just do all, and then each chain that is supported. all of the "anything else: search above. every bridgable token is found here" is stupid. be terse. remove the "choose a token" move the close button to be over/inside of the input on the right.. the checkmark denoting the selected token is dumb. it shifts content away. eggregious ui violation"
27. "the search got worse. i think you should refactor it to also go edge to edge. maybe play around with it as a burn streak like the input. then the close button could be square and hugging the right side and there would be no rounded pill shape, no top border. remove the word ethereum and pulsechain from the chain tabs as well as the item rows. you shoud instead show the price of the token. the network badge over the token icon shows the origination. and for the omnibridge pill, lets instead just go with a bridge icon and a tooltip explaining its existance. maybe with an arrow function to find the native coin"
28. "on the search input, good. better. fix the height. close button should be a square. the "all" text should be an icon"
29. "and the right square should be the same color as the input. try some sort of border to differentiate it"
30. "dark rule is fine"
31. "we will also have to handle custom tokens as well. tokens that neither bridge has ever seen. we can add a warning to the bridge button stating that this is the first time that this token hasbeen bridged and it may be wise to keep the amount low. lets look at the activity now"
32. "find an oracle. i think that the pulsex exchanges serve as good oracles"
33. "raise the gas price ceiling. warn when a tip is >1% for bridges under $100. then scale it down to 0.1% as it goes to $1000"
34. "this is before gas pricing"
35. "delivery is on top of this"
36. "well, no we need to couple them in the ui. think about it like this. we need to make a 100% margin on the anticipated cost to execute the bridge (assume a $0.025 cost for the proof generation) for the warning to go away"
37. "make the default the larger of the two. cap what we are willing to set in an automated manner at 1%. make the cap adjustable. always warn users as they are checking out if their cap is too large and give them an opportunity to adjust it in the finalizing drawer."
38. "give me an animation for when the accordion (gas/arrival/tip) expansions show/hide."
39. "http://100.90.134.51:5200/#/bridge/eth-pls?bridge.amount=1 did not see a correlative output number it stayed at zero"
40. "it's getting there, but you need to connect a lot of data points"
41. "the drawer animation is fine"
42. "it seems that your ui is quite small, especially for desktop AND mobile. the baseline should be larger. and large can be achieved on larger screens"
43. "show me the explore screen next. what i have seen so far in the implementation is not impressive. also, your chevrons in the top nav that allow the user to get to the explorer/activity should be fixed around a fixed width text block. otherwise you end up with chevrons moving back and forth"
44. "cool. i like it. iterate a bit more, include more data including searches of the proofs or transactions or identifers. explorer should help you explore every data aspect"
45. "for the "transfers it proved" move the chevron to the right, shorten the status to one word: delivered, waiting, proving, mining, etc. the browse section might be able to just have a single column grid if you used a large number to the left, the header to the right, and the subheader below that then send explore v2 to the build worker"
46. "show me the address and transaction pages"
47. "where it sits should also have to show the input transfer/user action. also, the "block n final on pulsechain" maybe should be shortened to "block final on Pulsechain" and maybe we can give a small drawer to show information about the block like its number or its hash or other info about the committee you are using "pulsechain -> sepolia" instead of icons in the proofs sections."
48. "you should still maintain the connection between completed steps when the drawer is opened"
49. "this seems temporary: "Sepolia's light client now trusts PulseChain testnet v4 up to slot 11,194,368 (block 25,767,883). Messages sent from PulseChain before that block can be proven on Sepolia." strike it"
50. "show me the message page. what is the message page"
51. "for chain and token icons in the burn streak, we need to have a neutral bg such as white or black"
52. "message looks fine. i think you should add more token icons to the sent, received and maybe break up the fee line into its componenet parts or show a total and allow a drawer to open from a right pointing chevron. token mediator is too broad. in this case, we are dealing with an erc20 mediator"
53. "so here's the thing: the chain icon, when it stands by itself, does not need the name of the chain after it. at least on mobile. i think removing it for both is better. and i also think that if you do it in this order you will have much better lineup visually:
Sent on [Chain_icon] [link]       [amount][symbol][token_icon]"
54. "i also wonder if you can add a "token" row so that you do not have to keep repeating the symbol. you can just do this, where the link is right aligned to a fixed width, grouping everything on the left side
Token                            [symbol][icon]
Sent on    [chain_icon][link]    [amount][icon]
the fees drawer can also then use the icon instead of the symbol.
and items in the stes that are actual transactions, we can note the eth/native transaction costs, not just the gas, and we should also look up the usd cost, if we are not already keeping the data in the indexers"
55. "you can remove the cost from the collapsed view. it should only show in the expanded views"
56. "are there situations where a high gas cap is always warning? we do not want to drive people away from giving us tips.
q3) network base fee? no, we are calculating the full fee of releaseing as if this bridge is the only bridge: so 0.025+any base fee costs - yeah, those multipliers are fine
q4) we can put a little save button (floppy icon) next to the slider for people who want to save it
q5) for all bridged tokens, for the short term, we need to a) reverse out the tokens, back through the current omnibridge. that way we can trace on pulsex (v1/2) what they actually cost in usdc/usdt/dai"
