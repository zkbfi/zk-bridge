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

## Open questions

- Where the Omnibridge token list comes from and how it stays current.

- The price oracle: which sources (DEX pools on PulseChain, an ETH/USD feed on Ethereum), how bridged tokens map to
  their originals, and where it runs (indexer or backend).

## Left to the builder

- How the time-left estimate is computed (finality and proving timings per chain from what the indexer and backend
  already expose, or a per-pair constant to start); show it as an estimate ("about", "~").
- Where the activity data comes from (the indexer's feed filtered by address, as the history view does today).
- Component structure, how the existing BridgeForm logic is reused, and the test plan.
- Exact spacing, type scale, and the dark-theme palette within the language above.
- Keyboard and screen-reader behaviour of the custom menus (they must be accessible: proper roles, focus, Escape).
