# Explorer web interface

The browser interface for the bridge. It shows the same views and does the same actions as the terminal dashboard (`explorer/terminal`). Design: `docs/explorer.md`.

## What it is

- **One search field, no menu.** The top bar holds a single search field. Press `Ctrl K`, `Command K` or `/` to open it. It finds views, pairs, tokens (by symbol or address, on either chain), a transfer or message (by message identifier, or by the transaction hash on either chain), an address, actions, and the documentation (by page title and heading). Results sit in groups, the arrow keys move through them, Enter opens one, and recent results come first. On a narrow screen the field replaces the menu entirely.
- **Pair view.** Summary across the top. On the left: the connected account, the balances on both chains, and the actions (bridge tokens, wrap the native coin, send a message). On the right: the feed under a fixed filter bar (direction, kind, status, token, address, time range), with the time on both chains and the status of each row. In the footer: the light client head of each chain.
- **Other views.** Global (choose a pair, default `eth-pls`), audit (escrow against bridged supply, and fees), prover and costs (light client updates recorded on chain), the page of one transfer, the page of one address, and the Docs view.
- **Docs.** The redesigned docs site (`explorer/docs`) lives inside this app at `#/docs/<page>(/<heading>)`. It loads on demand: `src/docs/DocsRoute.tsx` imports it dynamically, so its code, styles and Markdown pages are a separate chunk that downloads only when a docs address opens, and the bridge screen's first bundle does not carry them. The pages are `explorer/web/docs/pages/*.md` plus the operator pages listed in `explorer/docs/public-pages.json`; `script/check-docs-public.sh` runs before every build. The docs have their own search; the palette searches the docs titles and headings too, and fetches the pages when the first search is typed. docs.zkb.fi serves this same app, and an empty address on a `docs.` host moves to `#/docs` (`src/app/docs-host.ts`). Owner, verbatim: "perhaps docs should be async loaded in the same app as dapp? no need to consume a second domain" and "yes, point docs.zkb.fi at the dapp. have it go to /#/docs".
- **Connections.** The header shows where the data comes from: `indexer`, or `RPC fallback: <reason>`. The page `#/settings` (in the palette: "Connections: indexer and RPC URLs") sets the indexer URL and the RPC URL of each chain. See "Connections" below.
- **Not here: the Prover setup view.** It holds operator secrets (a remote endpoint key and RPC keys), so it lives in the terminal only. A browser page must never hold such secrets.

## Fees: what you see before you sign

1. **Tip for delivery, on by default.** It is the only fee: the mediator charges none. The page adds a gas based tip at the base fee (flag `EXCLUDE_PRIORITY`), equal to the measured gas cost (the multiplier is your price of one wei times 1e18, rounded up). The page also shows a low range of tips (half, the cost, and one and a half times the cost) that you can pick or edit, down to zero. A tip goes to the reward address of the router, it is voluntary, and it buys no promise. Its limit is the price ceiling: the tip at three times the base fee now (the Normal gas level), and the most it can take. The page shows the most the tip is expected to be at its gas estimate (`worstCaseFee` in `@zkb/core`), next to the limit. The default comes from `defaultTipChoiceOf` in `@zk-bridge/shared`. On a destination chain that reports no base fee (`baseFee: 'none'` in the chain configuration), the default reads the whole gas price and the form says why. With no coin price typed and no valuation of the token, the form shows a notice that asks for a price, because a fixed tip needs the same price. You can edit the margin and the ceiling, switch to a percentage (exact) or to a fixed amount (exact), or remove the tip with "No tip: deliver directly, no router". That choice sends a plain relay (`relayTokens`) with no router and no fee terms, so nobody can take a fee. Anyone can still deliver directly on the bridge, for free, and it may take longer. The confirm dialog says that no router is involved. The gas based mode works for any token: the field "Your coin price" holds your own price of the destination native coin, and the page folds it into the multiplier (it starts at 1 for the wrapped native token, and for any other token you type it). An advanced field names the router. It starts at the default delivery router on the destination chain, and a router that is not that one is marked. The page shows the cost breakdown (gas cost and margin) when it knows your price, the data source ("measured from N recent deliveries, p90" or "default, no deliveries measured yet") and the base fee with its block and time. The suggestion refreshes every 15 seconds, so it follows the indexer as it records more deliveries.
   - **The call after the delivery.** The bridge form has two optional fields: Call target and Call data. The target is a contract on the destination chain, and the data is hex for that contract. The delivery router calls the target after it pays the recipient. The call comes from the router, sends no native coin and gets exactly the call gas that you enter (there is no default, and zero is refused). The callback gas of the transfer is worked out from it and shown read only. A call that fails with its gas does not undo the delivery, and the router emits `CallFailed`. The tip counts the call gas, so a call raises a gas based tip. Empty target means no call. Empty data means a call with no data. The help page "Bridging tokens" explains the fields in plain words.
   - **Who collects the tip.** Anyone can deliver through the delivery router. The router pays the tip to its immutable reward address, so a copied delivery gains the copier nothing. A direct delivery on the bridge, without the router, pays no tip, and the recipient gets the whole amount. The fee panel and the confirm dialog say this.
   - **When no tip can travel.** The wrap route carries no call data, and a destination with no delivery router in the deployment has no router to tip. In both cases the page sends a plain relay and says why on the form, as the terminal does.
2. **Confirm dialog.** Before the wallet opens it shows the chain, the contract, the function, the arguments decoded from the bytes that the wallet will receive, the value, the router (marked when it is not the default delivery router), the tip mode, the tip now (exact or estimate), the most that the tip can take, the tip terms in the call data and the network fee. The Send button stays disabled when the bytes do not match what the page planned.

Amounts are `bigint` everywhere, shown with the decimals of the token and cut, never rounded. Rates scaled by 1e18 show as exact percentages.

## Run

All commands run in `explorer/`.

```sh
pnpm install
pnpm --filter @zk-bridge/web dev            # Vite dev server, http://localhost:5173
pnpm --filter @zk-bridge/web build          # type check, then production build into explorer/web/dist
pnpm --filter @zk-bridge/web preview        # serve the build
pnpm --filter @zk-bridge/web test           # Vitest and React Testing Library
pnpm --filter @zk-bridge/web typecheck
pnpm --filter @zk-bridge/web e2e            # Playwright smoke test against the sample data, needs Google Chrome
```

To try the page with no network and no indexer, use the sample data:

```sh
VITE_EXPLORER_DATA=fixture pnpm --filter @zk-bridge/web dev
```

## Environment variables

Vite copies every `VITE_` variable into the page at build time, so all of them are public. Use public endpoints only. **The build and the start of the page refuse a configuration that holds anything key-like** (a `vk_` token, 32 bytes of hex, a name and password or a key in a URL, a long key-like path segment, a recovery phrase, or a variable named for a secret). The message names the variable, never the value. The check is `src/config/secret-scan.ts`, and `vite.config.ts` runs it at build and at dev start.

| Variable | Meaning | Default |
|---|---|---|
| `VITE_EXPLORER_DATA` | `live`, or `fixture` for sample data and a simulated wallet. | `live` |
| `VITE_EXPLORER_INDEXER_URL` | Base URL of the indexer (`explorer/indexer`). A URL that you set on the connections page wins over it. | none. The registry default is `http://localhost:42069`. |
| `VITE_EXPLORER_PAIR` | Pair name. | `eth-pls` |
| `VITE_EXPLORER_DEPLOYMENT_URL` | URL of the deployment JSON that `docker/deploy.sh` writes. | none |
| `VITE_EXPLORER_DEPLOYMENT_JSON` | The same JSON, inline. Wins over the URL. | none |
| `VITE_EXPLORER_RPC_URL_<chainId>` | Public RPC endpoint of each chain, for balances, allowances, gas and fees, and for the RPC fallback. A URL that you set on the connections page wins over it. The `rpc_url` of the deployment JSON is the weaker default. | none |
| `VITE_WALLETCONNECT_PROJECT_ID` | The Reown project id (made under the zkb.fi account at dashboard.reown.com). Set at release, at build time. See "Wallets". | none |

A live page needs a deployment (URL or inline JSON). The page serves one pair, because the indexer serves one. The global view lists the known pairs and marks the others as not configured.

## Connections

The page reads the indexer. When the indexer is unreachable, answers with an error, or is more than 300 seconds behind the chain head, the page reads the chains by RPC instead, and it goes back when the indexer is healthy. The header badge says which source answers. The rules, and what RPC mode cannot give, are in `docs/explorer.md` (section "Data sources: the indexer first, RPC as fallback"). Partial figures are marked: the summary says "at least", the audit shows "unverified" for a row that it cannot prove, and the feed says "history since <time>".

The page `#/settings` shows the indexer URL and the RPC URL of each chain, where each one comes from (set by you, from the environment, or default), and lets you test, save and forget your own. The order is: your setting, then the `VITE_` variable, then the `rpc_url` of the deployment JSON (and `http://localhost:42069` for the indexer). The test of an RPC URL sends `eth_chainId`. The page refuses to save a URL of another chain or one that fails. A change applies at once, with no reload.

**The browser keeps these URLs in its local storage, in clear text.** Anyone who can use this browser profile can read them. An RPC URL can hold an API key, so use a key that you can replace. The page shows only the host and the last four characters of the rest, and it removes every URL from error messages. When the browser blocks its storage, the setting lasts until you close the page, and the page says so.

## Wallets

- **With a Reown project id** (`VITE_WALLETCONNECT_PROJECT_ID` set when the release is built), Connect opens Reown AppKit's modal (`@reown/appkit` with its wagmi adapter, exact versions in `package.json`). It lists the wallets in the browser, offers install links, and shows a QR code for a phone wallet. Its networks are the two chains of the pair, with the same transports as the rest of the page. Analytics, email and social login, swaps, on-ramp, history, send and receive are off. The modal follows the page's theme (the accent token, square corners, the page's font). AppKit is a separate chunk: the page imports it on the first Connect, and at load when the viewer connected here before. The project id is public by design (it ships in the bundle) and is limited by the allowed origins set in the Reown dashboard, so add every gateway host the dapp is served from there.
- **Without a project id**, there is no AppKit. Connect uses the wallets in the browser: wallets that announce themselves (EIP-6963) and the generic `window.ethereum` connector when the page has one. One wallet connects at once; several open a short list to pick from; none opens a list of install links (MetaMask, Rabby, Coinbase Wallet, Rainbow) with "Install a wallet, then reload this page to connect." A failed connect shows its message in that list, never as an uncaught error. Ledger and Trezor work through the browser wallet that holds them. The page has no direct USB access.
- The page sets no Content-Security-Policy. If a gateway adds one, AppKit needs `connect-src` for `https://api.web3modal.org`, `https://pulse.walletconnect.org` (named in the bundle; analytics is off), `https://rpc.walletconnect.org`, `https://verify.walletconnect.org` and `wss://relay.walletconnect.org`, `frame-src https://secure.walletconnect.org https://verify.walletconnect.org`, and `font-src https://fonts.reown.com`, and `img-src https://api.web3modal.org` for the wallet icons. These come from the built bundle and were not exercised against a real CSP.
- The page never holds a key. The wallet signs and sends. The page asks the wallet to switch chain when a transaction is for the other chain.

## What is mocked

- `VITE_EXPLORER_DATA=fixture` uses the sample data of the terminal (`explorer/terminal/src/data/fixtures.ts`): a pair with made-up addresses, 36 feed rows, heads, audit rows, light client updates and a delivery cost report with measured callback deliveries and default values for the other kinds. Balances and gas come from the fixture chain access. The wallet is simulated: it reports one made-up account and sends nothing. A banner says so on every page.
- The tests use the same fixtures. No test reaches a network. The Playwright test runs against the fixture build with no network.
- Not mocked, and not verified against a live deployment: the shape of `GET /api/delivery-cost` is read with `parseDeliveryCostReport` from `@zk-bridge/shared`. The transaction lookup uses the GraphQL route of Ponder (`messagess` with `sentTransactionHash` or `deliveredTransactionHash`), which the tests check only against a fake.

## Code layout

- `src/config`: environment, deployment loading, the secret check.
- `src/data`: the calls to the indexer that the terminal data source does not make (one message, a lookup by transaction hash) with the RPC fallback, and the fixture client.
- `src/config/connection-storage.ts`: your settings in local storage, every access guarded. The runtime itself is `explorer/terminal/src/data/connection-runtime.ts`, which both dashboards use.
- `src/tx`: pure planning. `bridge-steps.ts` calls the terminal builder (`buildBridgeSteps`), so calldata equals what the terminal builds for the same inputs. `bridge-draft.ts` is everything the form can say before Review. `confirm-model.ts` is the text of the confirm dialog. `transaction-sequence.ts` is the confirm-before-send state machine.
- `src/search`: the palette model, the identifier lookups, the recent list, the palette.
- `src/docs`: the Markdown reader, the slug of a docs page, the palette's page list and the lazy entry of the docs (`DocsRoute.tsx`). No markup is ever injected as HTML.
- `src/wallet`: the wallet port, the wagmi implementation and the simulated one.
- `src/views`, `src/actions`, `src/app`: the screens.
- The page imports `@terminal/*` from `explorer/terminal/src` by path (formatting, models, the data source, the transaction planners, the chain reads). The terminal library is not imported. See the report that came with this package for what should move to `explorer/shared`.

## Tests

`test/` holds Vitest and React Testing Library tests: the secret check, the environment, routes, fee disclosure, delivery selection (exact, estimate, maximum, data source), calldata against the shared ABIs and the terminal builders, the confirm model and dialog, the transaction sequence, the feed filters, the form and its disabled states, the palette (grouping, keyboard, every jump target), the shell, the docs and the modal. `e2e/` holds an optional Playwright smoke test.
