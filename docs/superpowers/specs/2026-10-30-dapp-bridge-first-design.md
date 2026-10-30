# zkb.fi dapp: bridge-first redesign

Date: 2026-10-30. Status: approved in conversation (layout), written up for planning.
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
  form fields in the query, as today). `#/pair/<id>` stays the explorer's pair view, so links shared since 0.1.1 still
  open what they opened. The direction menu changes `<pair>` and `dir`; amount and destination survive a pair change
  through the hash (the page reloads behind the loader, as it does today).
- **Review step stays.** Bridge never opens the wallet directly: the existing review (tip, router warning, fee terms,
  and the "fields a link filled in" warning) and the step-by-step transaction view remain, redrawn in the new language
  (a square sheet that rises from the bottom edge on phones and sits as a square panel on desktop, pill buttons, no
  shadows). This is in scope.
- **Themes apply to the whole app.** Ember light, Ember on black and Monochrome are set at the token level (colours,
  radii: pills full, panels square), so the explorer views take the palette too; their layouts are not redesigned.
  The theme setting offers System, Light, Dark and Monochrome.
- **Header on every route:** the mark (home), a search pill (opens the existing palette; works by tap on phones, so the
  explorer is reachable without a wallet and without a keyboard), and the wallet pill (its menu holds the explorer
  links, settings, and "Send a message").
- **Send a message and call mode.** "Send a message" leaves the bridge screen and lives in the wallet menu and the
  palette, opening the existing dialog (redrawn). Call mode, gas, tip and router stay behind "Advanced". Old links
  (`?dialog=bridge&bridge.*`, `?dialog=wrap`, `?dialog=message`) keep working: their keys are kept or mapped, and the
  linked-field warning still applies.
- **Your activity:** the current pair, both directions; transfers the wallet sent and transfers it received (so a send
  to another address shows for both sides); messages the wallet sent; a transfer appears as "sent" the moment its
  transaction is submitted (local pending state until the indexer has it); the latest 5, then "All activity" opens the
  history view filtered to the wallet.
- **Token menu and Flip.** The direction comes first; the token menu lists the source chain's tokens only (the native
  coin included where wrap-and-bridge exists). Flip reverses the direction and switches the token to its counterpart
  on the other chain, keeping the amount. The hash stores the direction (`dir`), not the token's side.

## Left to the builder

- How the time-left estimate is computed (finality and proving timings per chain from what the indexer and backend
  already expose, or a per-pair constant to start); show it as an estimate ("about", "~").
- Where the activity data comes from (the indexer's feed filtered by address, as the history view does today).
- Component structure, how the existing BridgeForm logic is reused, and the test plan.
- Exact spacing, type scale, and the dark-theme palette within the language above.
- Keyboard and screen-reader behaviour of the custom menus (they must be accessible: proper roles, focus, Escape).
