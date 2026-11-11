---
title: "Settings, search and Explore"
summary: "Make the app yours: pick a theme, use your own RPC endpoint and beacon endpoint for each chain, swap any service the app reads, and find anything in the bridge from one search."
audience: [user, integrator]
chains: all
verified_release: 0.1.0
---

# Settings, search and Explore

Make the app yours: pick a theme, use your own RPC endpoint and beacon endpoint for each chain, swap any service the app reads, and find anything in the bridge from one search.

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
- **Browse.** One tile per kind, each with its all-time count from the indexer (not the latest few): transfers and messages (with how many are in flight), proofs, tokens, addresses, contracts, gates and escrow, costs, and releases.
- **The live map.** The two chains joined by a ring, with each transfer in flight moving along its direction.
- **The numbers.** Transfers in the last 24 hours, the median time and more. A number the data cannot give yet shows "—", with the reason on hover.
- **Light clients.** Each chain's light client and the slot it has verified up to.
- **Forks.** For each direction: the next fork of the source chain with its countdown, when sends pause and resume, which fork schedule the page used (the beacon node's, or a saved copy and when it was fetched), and the finalized head of the light client that has to follow the fork. For each chain: the deposit gate (its mode, and whether it is sealed) and what the fork registry last observed (version, shape, slot). With a wallet connected, **Seal the gate** appears when the call would succeed now; it is simulated first, anyone may send it, and it closes the gate for good. A fork observation is posted with a proof of the observation program; the prover service offers none yet, so the page shows the last observation and cannot post a new one.
- **Latest transfers**, with **All** to see every one.
- **Services.** Each service the app reads, with a live check.

Every kind has its own page, and every value on a page links onward. The pages for transfers and messages, proofs, tokens and addresses are lists of 50 rows with the total in the header. Filter them with the menus (for transfers: the chain it was sent from, status, transfer or message, token, time, or an address), sort them (newest, oldest, or by amount once a token is chosen; for proofs by slot; for tokens by symbol or transfers; for addresses by activity), and move with First, Previous, Next and Last under "Page x of y". The filters, the sort and the page are in the address, so a link opens the same rows and Back returns to the one before. While you page through a list it keeps one snapshot, so new transfers do not shift the pages; "refresh" takes a new one. A message page tells one transfer's whole story: who sent it, what arrived, the fee with its parts, and each step with its time, its cost and a link to the transaction on the chain's explorer. Dollar values show where the token has a price; the testnets have none.

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

### Beacon endpoints

One beacon API for each chain of the pair: the chain's consensus layer, which a proof of that chain is made from. The default is valve.city's beacon route for the chain, with a public node behind it if valve.city does not answer:

| Chain | Default | Then |
|---|---|---|
| Ethereum | `one.valve.city/beacon/vk_demo/1` | `ethereum-beacon-api.publicnode.com` |
| PulseChain | `one.valve.city/beacon/vk_demo/369` | `rpc-pulsechain.g4mm4.io/beacon-api` |
| Sepolia | `one.valve.city/beacon/vk_demo/11155111` | `lodestar-sepolia.chainsafe.io` |
| PulseChain testnet v4 | `one.valve.city/beacon/vk_demo/943` | `rpc-testnet-pulsechain.g4mm4.io/beacon-api` |

The live check asks the endpoint for its genesis (`/eth/v1/beacon/genesis`) and passes only when it is the genesis of that chain, so a beacon API of another chain shows "down"; hover the dot for the reason. A beacon API you set is used alone, without the fallback.

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
