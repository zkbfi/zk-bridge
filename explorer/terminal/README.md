# Explorer terminal dashboard

An OpenTUI (React reconciler) dashboard for the bridge. It runs on Bun. Design: `docs/explorer.md`.

## Run

```
cd explorer/terminal
bun install --frozen-lockfile
EXPLORER_DATA=fixture bun run src/main.tsx      # sample data, no network, nothing reaches a chain
bun run src/main.tsx                            # reads the indexer and the chains
bun test                                        # tests
bunx tsc --noEmit                               # type check
```

Keys: `1` to `5` views (global, pair, audit, prover and costs, connections), `Tab` area, arrows move, `Enter` opens, `?` help, `q` quit. `6` opens the Prover setup view,
which is deliberately the last option everywhere.

## Environment variables

| Variable | Use |
|---|---|
| `EXPLORER_DATA=fixture` | Built-in sample data and simulated sends. |
| `EXPLORER_INDEXER_URL` | Indexer API. A URL that you set in the Connections view wins over it. Default `http://localhost:42069`. |
| `EXPLORER_BACKEND_URL`, `EXPLORER_MSGBOARD_INDEXER_URL`, `EXPLORER_ARCHIVE_URL`, `EXPLORER_MSGBOARD_URL` | The backend, the msgboard indexer, the archive and the msgboard node. None has a default: an endpoint you do not set is skipped, and the proof panel says so. A URL that you set in the Connections view wins over it. |
| `EXPLORER_PAIR`, `EXPLORER_DEPLOYMENT_FILE` | Pair (default `eth-pls`) and the deployment JSON that `docker/deploy.sh` writes. |
| `EXPLORER_RPC_URL_<chainId>` | RPC URL of each chain. A URL that you set in the Connections view wins over it. The `rpc_url` of the deployment file is the weaker default. Keyed URLs: keep them out of files. |
| `EXPLORER_PRIVATE_KEY`, `EXPLORER_PRIVATE_KEY_FILE` | Signer at startup. The variable is removed from the environment when read. The file must be mode 0600. |
| `EXPLORER_KEYSTORE_FILE` | Prefills the keystore dialog. The password is always prompted. |
| `EXPLORER_MNEMONIC`, `EXPLORER_MNEMONIC_PASSPHRASE` | Used when the mnemonic field is left empty. Removed from the environment when read. |
| `EXPLORER_TREZOR_CONTACT` | Required by Trezor Connect for its manifest. |
| `EXPLORER_HANDOFF_FILE`, `EXPLORER_EVIDENCE_FILE` | Prefill the operator dialogs. |
| `EXPLORER_CONFIG_DIR` | Where the Prover setup file lives. |
| `EXPLORER_TOKEN_VALUATIONS_WEI` | Optional prices for delivery fee suggestions. A JSON object from a token address to the value of one whole token in wei, as a decimal text. The wrapped native token needs no entry (one whole token is 10^18 wei). The bots take the same setting as `tokenValuationsWei`. |

## Connections: the indexer first, RPC as fallback

The dashboard reads the indexer. When the indexer is unreachable, answers with an error, or is more than 300 seconds behind the chain head, it reads the chains by RPC instead. It checks the indexer again from time to time and goes back when it is healthy. The footer shows `indexer` or `RPC fallback: <reason>`. The full rules, and what RPC mode cannot give, are in `docs/explorer.md` (section "Data sources: the indexer first, RPC as fallback").

Key `5` opens the Connections view. It lists the indexer URL and the RPC URL of each chain, and for each one where it comes from: set by you, from the environment, or default. The order is: your setting, then the environment, then the `rpc_url` of the deployment file (and `http://localhost:42069` for the indexer).

| Key | Action |
|---|---|
| `Enter` on a URL | Type a new URL into a masked field. An RPC URL is tested first with `eth_chainId`. A URL of another chain, or one that fails, is refused and not saved. |
| `d` on a URL | Forget your setting. The row uses the next source. |
| `Enter` on a test row | Test the URL in force now. |
| `Enter` on `Check the indexer now` | Check the indexer now and switch the source if the check says so. |

A change applies at once. The dashboard builds new clients and keeps its screens, so no restart is needed.

An RPC URL can hold an API key. The view shows only the host and the last four characters of the rest. The URL goes to the secret store (the Keychain on macOS, the Secret Service on Linux, or an encrypted file with a password), never to a settings file. Every log line and error message is redacted. When the store needs a password, the dashboard starts with your environment settings, and the Connections view asks for the password and then applies your stored settings.

In RPC mode some figures are partial. The summary bar marks them with `>=` and a note, the audit view shows `unverified` for a row that it cannot prove, and the feed says `history since <time>`.

## Proofs, evidence and history

These screens read what the dapp reads. They are modal screens, opened from any view.

- `r` opens the proof panel. It shows the latest proof of each direction, from the msgboard indexer first and from the
  msgboard node when the indexer is not set, does not answer or is not built. It shows the backend job of each direction.
  `1` and `2` ask the backend for a proof and show the status of the request as it changes. `3` and `4` open the review
  of a light client update from the proof. `e` asks the archive for the evidence of a message and opens the execute
  sequence.
- `t` opens the history of sends, deliveries and head updates. `c e s d` change the chain, event, status and direction
  filters, `x` clears them, and `n` and `p` change the page. The indexer answers while it is healthy. When the chains
  answer, the page says it is partial and names the filters the chains could not apply.
- The four endpoints are rows of the Connections view (key `5`). Each is configured, never discovered.

## Tip for delivery (voluntary delivery fee)

User documentation lives in `explorer/web/docs/pages` (see `05-fees-explained.md`).

The bridge form has a choice field `Tip for delivery`. It is `Yes` by default, in the gas based mode at the base fee
(label `Gas, to limit`). The tip equals the measured gas cost at the base fee: the multiplier is your price of one wei of the destination coin, in
base units of the token, times 1 times 1e18, rounded up. The panel shows a low range of half, one and one and a half
times that cost. A tip goes to the reward address of the router, it is voluntary, and it buys no promise. The gas mode's lowest tip is just above zero; for zero, choose
`No tip` or a fixed amount of 0. The limit is the tip at the ceiling base fee, which is twice the
base fee now. You can edit the tip or choose `No tip`. You fix the tip now: nothing at delivery sets or changes the
rate, and the account that delivers supplies no rate.

- The field is offered for a token transfer when the deployment file names a delivery router (`delivery_router`) for the
  destination chain. When it does not, the form hides the field and sends a plain relay, and the note under the form
  says why. The wrap and relay route carries no call data, so it never carries a tip.
- `Yes` always sends `relayTokensAndCall`. The `Mode` and `Call data` fields disappear, because the
  call data now holds the tip terms. The tokens go to the `Fee recipient` after the tip (blank means the `Receiver`
  field).
- `Router (advanced)` chooses the router in the extra data: the receiver of the relay. Blank means the delivery router of
  the deployment on the destination chain. The confirmation screen shows the router and marks one that is not the router
  of the deployment.
- `Tip mode` is `Gas, to limit` (the default), `Percentage`, `Fixed amount` or `Custom terms`. The percentage starts at
  `0.1` when you choose it. Choosing the fixed mode, or changing the margin, the priority fee, the amount or the token,
  fills the fixed amount with the suggestion. Editing a number keeps your number. A blank percentage means 0.1 percent.
- The gas based mode follows the gas that the deliverer's transaction makes available. The deliverer chooses the gas
  limit of that transaction, and the bridge forwards only the message gas limit, so gas held back above it counts. Expect
  the tip to reach the limit. The limit is the price ceiling, and the help line says `Up to the limit; the deliverer's
  gas choice decides`. The panel and the confirmation screen show the limit as the price ceiling.
- Gas based mode fields: a decimal factor such as `1` on the cost (1 is the cost itself, 0.5 half of it), the base fee ceiling in gwei,
  and `Your coin price`: your own price of one whole native coin of the other chain, in whole tokens. The form folds
  your price into the multiplier now, so the mode works for any token. It fills the fields when you enter the form, or
  choose the mode or the token, with the factor of 1, twice the base fee now, and the price from the token valuation.
  A number that you typed stays when you change the amount.
- Where the destination chain reports no base fee (the `baseFee` field of the chain configuration is `none`, for example BSC), the default
  reads the whole gas price, with the same margin, and the panel says why. Without your price and without a token
  valuation the tip cannot be computed. The panel then asks you to enter your price. There is no fixed fallback, because
  a fixed tip needs the same price to turn a cost into tokens.
- Percentage: a percent text such as `0.1`. Fixed: a token amount. Custom: the kind, the limit, the multiplier
  and the gas price basis, as the router reads them. `Margin percent` and `Priority fee gwei` feed the suggestions.
  `Pay the reward address in` appears only when the token on the destination chain is the wrapped native token.
- The panel under the form shows the router, the gas of a delivery with its data source (`measured from 40 recent
  deliveries, p90` or `default, no deliveries measured yet`), the base fee with its block and time, the cost split into
  gas and margin, the tip range (low, suggested and high), and the three suggestions. A percentage or a fixed tip is `exact`. A gas based tip is
  `estimate, at most X`.
- The percentage and the fixed suggestions turn the cost into tokens, so they need the value of the token. Set
  `EXPLORER_TOKEN_VALUATIONS_WEI`. Without a value the panel says `no value of the token is configured`, and the
  gas based default needs your coin price too: the panel asks for it.
- The panel reads `GET /api/delivery-cost?chainId=<id>` from the indexer, and `EXPLORER_DATA=fixture` serves a built-in
  report. The confirmation screen shows the router, the tip mode, the recipient, the address that receives the tip, the address that receives the tokens when delivery fails, the flags, the limit, the multiplier in
  words, the tip now with its label (`exact`, or `estimate, at most X`), the most that the tip can be, and the data
  source.
- Anyone can deliver through the delivery router with `executeMessage(proof)`. The router pays the tip to its immutable
  `rewardAddress`, never to the account that delivers. A copied delivery therefore gains the copier nothing. When
  someone delivers on the bridge directly, no tip is paid and the recipient gets everything. The router keeps no claim
  record for the recipient. When it cannot deliver to the recipient, it hands the tokens to its immutable
  `failedDeliveryAddress`.
- The native coin payout (the `UNWRAP` flag) exists for the wrapped native token only. The form offers it for that token
  alone. The terminal refuses the flag for every other token, also in hand written call data to a delivery router.
- The confirmation screen reads `rewardAddress()` and `failedDeliveryAddress()` from the router on the destination chain
  at the moment you press Enter, and shows them as `Tip goes to` and `On failure`. When the router does not answer (an older router, a wrong address, or a dead
  endpoint), both lines say `unknown` and a warning explains why. The warning does not block the send: you decide.

## Layout of the code

- `src/tx`, `src/signing`, `src/flow`, `src/format`, `src/model`, `src/config`: no terminal library inside. The web
  interface can reuse them. The setup schema, the secret store, the setup file and the redactor moved to
  `explorer/shared/src/config` (import `@zk-bridge/shared/config`), because the bots read the same file. `src/config`
  keeps the pair mirror and the connection tests. The bots import `src/signing` by path.
- `src/ui`, `src/app`: the OpenTUI views.

## Joining the workspace

`explorer/pnpm-workspace.yaml` already lists `terminal`. This package keeps its own `bun.lock` and imports only
`@zk-bridge/shared/config` and `@zk-bridge/shared` (the delivery fee modules) from the workspace, through the `paths`
entries of its `tsconfig.json` (Bun and `tsc` both read them), so `bun install --frozen-lockfile` still works. Besides that, it mirrors the pair loader (`src/config/pairs.ts`) and keeps small ABI fragments
(`src/tx/abis.ts`) that tests check against the shared ABIs and the Foundry output.
