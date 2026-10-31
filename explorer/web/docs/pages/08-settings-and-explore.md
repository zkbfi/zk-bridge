# Settings, search and Explore

Make the app yours: pick a theme, use your own RPC endpoint for each chain, swap any service the app reads, and find anything in the bridge from one search.

## Search

Search reaches every part of the app. Tap the search button in the header, or press ⌘K on a Mac, Ctrl K elsewhere, or the slash key.

| Type or paste | You get |
|---|---|
| A word | Screens, tokens, pairs, actions and pages of these docs |
| A transaction hash or a message ID | That transfer or message |
| An address | Its transfers and balances |
| Nothing | Your recent results, then the screens and the actions |

The actions include Bridge tokens, Send a message, Connect or disconnect the wallet, Switch the wallet to either chain, Settings, and each theme. The arrow keys move through the results, Enter opens one and Escape closes the search. The footer links to Settings and to these docs.

## Explore

Explore is the screen to the right of Bridge. It shows the whole bridge, not only your transfers.

- **Search band.** Takes any identifier: a transaction hash, a message ID, an address, a token symbol, a slot, a block, a proof number or a release. It says what it recognised and groups the matches by kind.
- **Browse.** One row per kind, each with its count: transfers and messages, proofs, tokens, addresses, contracts, gates and escrow, costs, and releases.
- **The live map.** The two chains joined by a ring, with each transfer in flight moving along its direction.
- **The numbers.** Transfers in the last 24 hours, the median time and more. A number the data cannot give yet shows "—", with the reason on hover.
- **Light clients.** Each chain's light client and the slot it has verified up to.
- **Latest transfers**, with **All** to see every one.
- **Services.** Each service the app reads, with a live check.

Every kind has its own page, and every value on a page links onward. A message page tells one transfer's whole story: who sent it, what arrived, the fee with its parts, and each step with its time, its cost and a link to the transaction on the chain's explorer. Dollar values show where the token has a price; the testnets have none.

## Activity

Activity is the screen to the left of Bridge. It lists your transfers and messages on the current pair, in both directions, sent and received. The page Getting started walks through it, and the page Fees explained covers **Needs you** and **Deliver it yourself**.

## Settings

Open Settings from search. Every value has its default, a live check where it reaches a service, and a reset button when you have changed it. **Save** keeps everything at once; **Reset to defaults** fills the defaults back in, and nothing changes until you save.

### Theme

| Theme | Looks like |
|---|---|
| System (the default) | Follows your device's light or dark setting |
| Light | Ember on a light page |
| Dark | Ember on black |
| Mono | Black and off-white with hairlines; colour only on things in motion. Made for accessibility. |

The theme also applies to these docs; their footer has the same choice.

### RPC endpoints

One RPC endpoint for each chain of the pair. The app uses it to read balances, gas prices and token prices, and to send transactions. A new RPC endpoint must answer for its chain before Save keeps it. Each field shows a live check with its response time, or "down".

### Token and chain images

The image server for token and chain icons. Icons the release already carries do not depend on it. The default is gib.show.

### Services

The indexer, the prover, the archive and the msgboard indexer: everything else the app talks to. Prices come from PulseX pools through your RPC endpoint, so they need no service of their own.

### Msgboard nodes

One msgboard node for each chain. The app reads proofs from the destination chain's node. Two chains can share one address; each is checked on its own.

### Fee caps

The automatic fee cap (1% of the amount by default) and the hard fee cap (2% by default), each typed next to its unit. The automatic cap cannot be above the hard cap. The page Fees explained covers both.

### More

**Clear recent searches**, and **Connections and fallback** for the full list of connections and how the app falls back when one is down.

## Where your settings are kept

Your settings stay in this browser. They are never sent anywhere. On a gateway shared with other sites, they last for this visit only, and Settings says so. An address that looks like it holds a key is shown masked and kept only until you close the page.

## Credits

The take-my-money icon on the fee is from game-icons.net (game-icons.net contributors), under CC BY 3.0. Settings and the footer of these docs credit it too.
