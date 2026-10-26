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

Keys: `1` to `4` views, `Tab` area, arrows move, `Enter` opens, `?` help, `q` quit. `5` opens the Prover setup view,
which is deliberately the last option everywhere.

## Environment variables

| Variable | Use |
|---|---|
| `EXPLORER_DATA=fixture` | Built-in sample data and simulated sends. |
| `EXPLORER_INDEXER_URL` | Indexer API. Default `http://localhost:42069`. |
| `EXPLORER_PAIR`, `EXPLORER_DEPLOYMENT_FILE` | Pair (default `eth-pls`) and the deployment JSON that `docker/deploy.sh` writes. |
| `EXPLORER_RPC_URL_<chainId>` | RPC URL of each chain. Keyed URLs: keep them out of files. |
| `EXPLORER_PRIVATE_KEY`, `EXPLORER_PRIVATE_KEY_FILE` | Signer at startup. The variable is removed from the environment when read. The file must be mode 0600. |
| `EXPLORER_KEYSTORE_FILE` | Prefills the keystore dialog. The password is always prompted. |
| `EXPLORER_MNEMONIC`, `EXPLORER_MNEMONIC_PASSPHRASE` | Used when the mnemonic field is left empty. Removed from the environment when read. |
| `EXPLORER_TREZOR_CONTACT` | Required by Trezor Connect for its manifest. |
| `EXPLORER_HANDOFF_FILE`, `EXPLORER_EVIDENCE_FILE` | Prefill the operator dialogs. |
| `EXPLORER_CONFIG_DIR` | Where the Prover setup file lives. |
| `EXPLORER_TOKEN_VALUATIONS_WEI` | Optional prices for delivery fee suggestions. A JSON object from a token address to the value of one whole token in wei, as a decimal text. The wrapped native token needs no entry (one whole token is 10^18 wei). The bots take the same setting as `tokenValuationsWei`. |

## Tip for delivery (voluntary delivery fee)

User documentation lives in `explorer/web/docs/pages` (see `05-fees-explained.md`).

The bridge form has a choice field `Tip for delivery`. It is `Yes` by default, at 0.1 percent of the transfer (the
percentage mode, multiplier 1e15). You can edit the tip or choose `No tip`. You fix the tip now: nothing at delivery
sets or changes the rate, and the runner supplies no rate.

- The field is offered for a token transfer when the deployment file names a fee router (`fee_router`) for the
  destination chain. When it does not, the form hides the field and sends a plain relay, and the note under the form
  says why. The wrap and relay route carries no call data, so it never carries a tip.
- `Yes` always sends `relayTokensAndCall`. The `Mode`, `Call data` and `Fallback recipient` fields disappear, because the
  call data now holds the tip terms. The tokens go to the `Fee recipient` after the tip (blank means the `Receiver`
  field).
- `Router (advanced)` chooses the router in the extra data: the receiver of the relay. Blank means the fee router of
  the deployment on the destination chain. The confirmation screen shows the router and marks one that is not the router
  of the deployment.
- `Tip mode` is `Percentage`, `Fixed amount`, `Gas multiplier` or `Custom terms`. The percentage starts at `0.1`.
  Choosing the fixed mode, or changing the margin, the priority fee, the amount or the token, fills the fixed amount
  with the suggestion. Editing a number keeps your number. A blank percentage means the default tip.
- Percentage: a percent text such as `0.1`. Fixed: a token amount. Gas multiplier: a decimal such as `1.2` for the
  margin, the base fee ceiling in gwei, and `Your coin price`: your own price of one whole native coin of the other
  chain, in whole tokens. The form folds your price into the multiplier now, so the gas multiplier works for any
  token. It fills the field from the token valuation as a starting point. Custom: the kind, the limit, the multiplier
  and the gas price basis, as the router reads them. `Margin percent` and `Priority fee gwei` feed the suggestions.
  `Pay the reward address in` appears only when the token on the destination chain is the wrapped native token.
- The panel under the form shows the router, the gas of a delivery with its data source (`measured from 40 recent
  deliveries, p90` or `default, no deliveries measured yet`), the base fee with its block and time, the cost split into
  gas, proof and margin, and the three suggestions. A percentage or a fixed tip is `exact`. A gas multiplier is
  `estimate, at most X`. When the report holds no native coin price, the panel says that the proof cost is not included.
- The percentage and the fixed suggestions turn the cost into tokens, so they need the value of the token. Set
  `EXPLORER_TOKEN_VALUATIONS_WEI`. Without a value the panel says `no value of the token is configured`, and the
  default tip still stands. The gas multiplier then asks for your coin price.
- The panel reads `GET /api/delivery-cost?chainId=<id>` from the indexer, and `EXPLORER_DATA=fixture` serves a built-in
  report. The confirmation screen shows the router, the tip mode, the recipient, the address that receives the tip, the flags, the limit, the multiplier in
  words, the tip now with its label (`exact`, or `estimate, at most X`), the most that the tip can be, and the data
  source.
- The fee router whitelists exactly one account, its immutable `runner`. Only that runner account can deliver through
  the router, and it does not receive the tip. The router pays the tip to its immutable `rewardAddress`. The runner
  names that address with each delivery, and the call reverts unless it matches. When anyone else delivers on the
  bridge directly, no tip is paid and the recipient gets everything. A direct delivery costs you nothing.
- The confirmation screen reads `rewardAddress()` from the router on the destination chain at the moment you press
  Enter, and shows it as `Tip goes to`. When the router does not answer (an older router, a wrong address, or a dead
  endpoint), the line says `unknown` and a warning explains why. The warning does not block the send: you decide.

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
