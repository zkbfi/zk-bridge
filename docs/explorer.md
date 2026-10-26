# Explorer: indexer, terminal dashboard, web interface

User decisions (2026-10-25): the explorer lives in this repository under `explorer/`. It uses TypeScript: Ponder for the indexer and OpenTUI for the terminal dashboard. A web interface comes later and reads the same indexer.

## Packages

| Path | What it is | Runtime |
|---|---|---|
| `explorer/shared` | Contract ABIs (generated from the Foundry build output), the chain pair registry, shared types, number formatting, the message and status rules that the indexer uses, the RPC data source, and the connection settings | any |
| `explorer/indexer` | Ponder project that indexes both chains of a pair into a local database and serves it | Node.js |
| `explorer/terminal` | OpenTUI dashboard | Bun |
| `explorer/web` | Later: React web interface on the same indexer API | browser |

"Load the data instantly": with the indexer, the dashboard never scans a chain itself. It reads the indexer's database through the indexer's API, so it opens with history already in place and live updates arrive as the indexer follows new blocks. When the indexer is not available, the RPC source takes over (see "Data sources: the indexer first, RPC as fallback").

## Pairs

A pair is two chains joined one to one: on each chain a light client of the other, a gate, a `MessageBridge`, a `TokenFactory`, a `TokenMediator`, a `WETHOmnibridgeRouter` and optionally a `FeeRouter`. The pair registry in `explorer/shared` lists pairs by name with each side's chain identifier, RPC and beacon endpoints (from configuration, never committed with keys) and contract addresses (from a deployment file). The default pair is Ethereum and PulseChain (`eth-pls`). A second known pair joins Sepolia and PulseChain testnet v4 (`sepolia-pls943`, chains 11155111 and 943).

## What the indexer stores

From both chains of each pair:
- Messages: `UserRequestForAffirmation` (sent), `AffirmationCompleted` (delivered, with status), decoded AMB fields (sender, executor, gas, data), transaction hash, block and timestamp on each side.
- Token transfers: `TokensBridgingInitiated`, `TokensBridged`, `NewTokenRegistered`, fallback and claimable events, `FeeCharged`, fee collections; joined to their message by message identifier.
- Light clients: each head update (slot, header root, execution block, transaction, gas used, poster), committee changes.
- Gate and registry: confirmations, seals, observed versions.
- Escrow and supply: per native token, the mediator balance on its home chain and the bridged token supply on the other chain (from mint and burn events), and accrued and collected fees.
- Status of each transfer or message, derived: sent, waiting for finality, covered by a stored head, delivered, failed call, fallback used, claimable.

The indexer tracks only what lands on chain. It stores no proofs and accepts no off-chain records (user decision, 2026-10-25). Proof-related data comes from chain events: each light client head update with its transaction, gas used and poster.

## Data sources: the indexer first, RPC as fallback (user decision, 2026-10-26)

The indexer is the upgrade. It holds the whole history and answers at once. The dashboards still work when it does not: they fall back to a data source that reads the chains by RPC. Both sources answer in the same shape, so no screen knows which one it reads.

### When the dashboard falls back, and when it returns

The terminal and the web page use the indexer while it is healthy. They switch to the RPC source for one of these reasons:

| Reason | What it means |
|---|---|
| `no indexer URL is set` | No source of settings names an indexer. |
| `indexer unreachable` | The request failed at the network level or timed out. |
| `indexer error: <text>` | The indexer answered with an error status, or an answer that the client cannot read. |
| `indexer <n> s behind the chain head` | The newest block that the indexer holds is more than 300 seconds older than the newest block of a chain. The check reads `/api/heads` and compares it with the clock of the chains (the wall clock when a chain has no RPC URL). |

No timer runs. A read checks the indexer when its interval has passed: every 30 seconds for a healthy indexer (the lag check) and every 15 seconds for a failed one. When a check of a failed indexer succeeds, the dashboard goes back to it.

The screens show the active source. The terminal shows it in the footer. The web page shows it as a badge in the header. The text is `indexer` or `RPC fallback: <reason>`.

### How the RPC source reads

- It reads `eth_getLogs` in bounded windows. The block span is configurable (default 2000 blocks). A node that refuses a window for its size gets two half windows, down to 50 blocks. Any other error stops the read at once.
- It reads newest first. A request reads at most 6 older windows (configurable), then answers with what it has and a cursor. The next request with that cursor reads further back. New blocks are read as they come, and the last 24 blocks are read again to follow a reorganization.
- It joins the two chains by message identifier. It uses the code of the indexer: the decoding of a send (`decodeSend`), the merge of facts into a message and a transfer row (`mergeMessage`, `mergeTransfer`), the status rules (`deriveStatus`), the audit sum (`auditToken`), the feed query (`parseFeedQuery`) and the shape of every answer (`explorer/shared/src/api-views.ts`). These modules moved from `explorer/indexer` to `explorer/shared`. The indexer imports them from there. A test fails when a row type of the indexer and its shared type differ.
- It reads the current state from the contracts and not from events when a contract can say it: the stored head of each light client, the gate flags and the newest confirmed epoch, whether sends are open, the escrow, the fees held, and the supply of a bridged copy. A bridged copy counts only when the mediator of its chain names the native token back, so the relationship is read in both directions.
- **A message is listed only when it is known fully.** A delivery lies on the other chain and after the send. So a message sent before the scan of the destination chain starts could look undelivered. The source lists only messages sent after the later of the two scan starts (`coveredFrom`). Every message that it lists has the status that it has with the whole history.

### What RPC mode cannot give

A figure that RPC mode cannot complete is marked, never shown as exact. Each answer carries a `coverage` block with the list of partial figures. The terminal and the web page show the mark.

| Figure | In RPC mode |
|---|---|
| Feed | Recent history only. The page says `history since <time>`. |
| Transfers in flight | At least the count in the scanned history, unless the scan reached the first block of the deployment. |
| Volume of the last 24 hours | Exact when the scan reaches back 24 hours or to the first block of the deployment. Partial otherwise. |
| Fees accrued, fees collected | The fees held now are exact for each known token (a contract read). The list of tokens comes from the scanned history, and so does the collected total. Both are partial until the scan is complete. |
| Audit | The escrow, the fees and the supply are exact. The transfers in flight come from the scanned history, so the row shows `unverified` and is never flagged as a mismatch while the history is partial. |
| Light client heads | The stored head and the lag are exact. The finalized slot comes from the finalized execution block of the tracked chain (`(timestamp - genesis time) / seconds per slot`). It is unknown when the node does not serve the `finalized` tag. The time and the count of updates come from the scanned history. |
| Gate | The flags, the sends state and the newest confirmed epoch are exact. The confirmation time comes from the event when it is in the scanned history. Otherwise it is the start of the confirmed epoch, and the answer says so. |
| Delivery cost | The base fee is exact. No delivery is measured, so the gas is the default and the report says `default`. |
| One message | Found in the scanned history only. A search by transaction reads the receipt, and the next request for that message reads back to that block, up to 80 windows. |

Routes that the dashboards do not use are not served in RPC mode: `/api/escrow`, `/api/claimables`, `/api/gate`, `/api/registry`, `/api/light-client-costs` and the GraphQL route.

### Settable and updatable URLs

The indexer URL and the RPC URL of each chain can be set in both dashboards. A setting takes effect at once, with no restart: the dashboard builds new clients and keeps the same screens.

- **Order of precedence.** The setting of the user, then the environment or the deployment of the page (`EXPLORER_INDEXER_URL` and `EXPLORER_RPC_URL_<chainId>` in the terminal, `VITE_EXPLORER_INDEXER_URL` and `VITE_EXPLORER_RPC_URL_<chainId>` in the web page), then the default of the pair registry (the `rpc_url` of the section of the deployment file, and `http://localhost:42069` for the indexer). A blank setting counts as no setting, so forgetting a setting returns to the next source.
- **Where the terminal keeps them.** In the secret store of the operating system, or in the encrypted file when the system has none. The names are `explorer.connection.indexer` and `explorer.connection.rpc.<chainId>`. An RPC URL can hold an API key, so no settings file holds one. The Connections view (key `5`) sits before the Prover setup view, which stays last.
- **Where the web page keeps them.** In the local storage of the browser, in clear text. The page warns about this. Every access of the storage is guarded, because a browser can block it. When a write fails, the setting lasts until the page closes, and the page says so.
- **What the screens show.** Only a masked form: the host, and the last four characters of the rest. A log line or an error message goes through the redactor first. It removes the whole URL, the user name, the password, the path and each query value of every URL in use.
- **The test.** The test of an RPC URL sends `eth_chainId`. A URL whose chain identifier is not the chain of the row is refused, and nothing is saved. A URL that fails the test is not saved either. The test of an indexer URL asks `/api/heads`.

Code: `explorer/shared/src/rpc` (the RPC source), `explorer/shared/src/fallback.ts` (the rule), `explorer/shared/src/connection.ts` (the indexer with the RPC source behind it), `explorer/shared/src/connection-settings.ts` (precedence, masking, redaction), `explorer/terminal/src/data/connection-runtime.ts` (the live runtime that both dashboards use).

## Terminal dashboard layout

```
+--------------------------------------------------------------------------------+
| SUMMARY (top): pair, both chains' head lag, transfers in flight, 24 h volume,   |
| fees accrued, last light client update, gate status per chain                   |
+---------------------------------------+----------------------------------------+
| ACTION AREA (left)                    | FILTERS (fixed header of the feed)     |
|  account and signer                   +----------------------------------------+
|  balances on both chains              | FEED (right): transfers and messages,  |
|  bridge tokens (relay, relay and call)|  newest first, with timestamps on both |
|  send a message                       |  sides and status                      |
|  claim claimable balances             |                                        |
|  post an update / execute a message   |                                        |
+---------------------------------------+----------------------------------------+
| LIGHT CLIENT HEADS (footer): per chain stored head slot, finalized slot, lag,   |
| last update time                                                                |
+--------------------------------------------------------------------------------+
```

Views:
- Global view: choose a pair (default `eth-pls`); one line per pair with its health.
- Pair view: the layout above for one pair.
- Audit view: escrow against bridged supply per token, fee balances, any mismatch flagged.
- Prover and costs view: light client updates as recorded on chain (slot, transaction, gas used, poster, time). Off-chain proof timing and RunPod cost are left out for now.

The feed filters: direction, kind (token or message), status, token, address (sender or recipient), time range.

## Signing

The dashboard can act (relay tokens, send messages, claim, post updates, execute messages), so it needs signers:
- A private key, loaded from an environment variable, a file, or an encrypted keystore (Foundry or Ethereum keystore format). Never written to disk in clear.
- A mnemonic, with key derivation: the standard path `m/44'/60'/0'/0/i` by default, a custom path, and a list of derived addresses to pick from.
- Hardware wallets: Ledger (USB, through the Ethereum application) and Trezor. Derivation paths as above.

The signer never leaves the dashboard process. Every transaction is shown in full (chain, contract, function, arguments, value, gas) and needs explicit confirmation.

## Numbers

Amounts are integers in each token's base units; rates are 18-decimal (1e18 = 100%). The fee follows a fixed declining schedule with no admin (see the fee schedule in `docs/hardened-build-contract.md`): a fee event is `charged_outgoing`, `charged_incoming` or `collected`, and the fee panel shows the current rate that the mediator reports. `explorer/shared` has `feeRateAt`, a copy of the contract math that is tested against vectors from the contract. The display formats them with the token's decimals; the stored values are never rounded.

## Dependencies

Every package version is pinned exactly and must be at least 28 days old, as for the rest of this repository.

## Prover setup view (user decision, 2026-10-25)

Whoever runs the proof side on their own remote GPU configures it in the dashboard. The view is deliberately tucked away: it is always the last option in every list or menu it appears in, never a default and never on the main path.

It holds: the remote GPU endpoint URL (for example a RunPod load balancing endpoint) and its API key; the RPC and beacon URLs per chain; the msgboard RPC and WebSocket URL; the pair and directions to prove; the proving policy. Each value has a test action (endpoint `/ping`, RPC chain identifier, msgboard `status()`).

Secrets are entered masked and never shown again (only the last four characters). They are stored in the operating system secret store where available (macOS Keychain, Linux Secret Service), otherwise in a file encrypted with a password (scrypt and AES-GCM); or the operator points at an environment variable or a 1Password reference instead of storing anything. Every log and error redacts them. The proof publisher bot reads the same configuration.

## Voluntary delivery fees

A sender can tip a runner to deliver a transfer. The sender fixes the tip when the transfer leaves. Nothing at delivery sets or changes the rate, and the runner supplies no rate.

The user interfaces turn the tip on by default at 0.1 percent of the transfer (the percentage mode, multiplier 1e15). The sender can edit the tip or remove it. With the tip removed, the interface sends a plain `relayTokens`.

**The router is chosen in the extra data.** The sender relays the tokens with `relayTokensAndCall`. The receiver of that call is the router, and the call data is a `FeeDirector`: the recipient, the settings flags, a limit and a multiplier. The default router is the `FeeRouter` of the destination chain from the deployment file. An advanced field lets the sender name another router. The review screen marks a router that is not the one of the deployment.

**One runner delivers, and the tip goes to a reward address.** The `FeeRouter` whitelists exactly one externally owned account, the immutable `runner` of its constructor, and exactly one reward address, the immutable `rewardAddress`. It has no owner and no setter. Only a transaction that the runner signs may call `FeeRouter.executeMessageWithRunner(proof, reward)`. The router checks `tx.origin`, so the runner can reach it through Multicall3. Any other origin reverts with `NotRunner`. This stops front-running by block builders and searchers: without it, any account could copy the pending call of the runner and take the tip. The runner names the reward address with each call, and the call reverts with `WrongRewardAddress` unless it equals the whitelisted one. The runner is the hot key that signs and pays the gas. The reward address is the account that receives the tips, and it can be a cold account. A stolen runner key cannot redirect a tip. The router stores the reward address, takes the tip when the mediator releases the tokens to it, pays the tip to the reward address, and pays the recipient the rest. The review screens of the terminal and the web page show the reward address and the failed delivery address that the router of a tipped transfer returns when they read it.

**Invalid terms go to the failed delivery address, so the interfaces refuse to build them.** The `FeeRouter` hands the value to its failed delivery address when the recipient is the zero address or the router itself (after it takes the tip by the terms), or when the data is neither 20 bytes nor at least 128 bytes (the whole value, because no tip can be computed). The contract keeps that behaviour and burns nothing. The terminal and the web page therefore refuse to build such a transfer. `assertValidFeeTerms` in `explorer/shared` refuses a recipient that is the zero address, the router, any fee router of the deployment, or a mediator or bridge. It also refuses data that is not the 128 byte director, and the 20 byte legacy shape for a token that is not the wrapped native token. `encodeFeeDirector` calls it, and both interfaces call it for any relay to a fee router, so no caller can skip it.

**A delivery that fails is handed off, not lost.** The `FeeRouter` has no owner, so it never keeps a balance that nobody can claim. It has a second immutable address, `failedDeliveryAddress`, which may equal the reward address. The tip is still paid first. When the token refuses the payout to the recipient (a blocklist, for example), or a native payout is refused in both coin and wrapped form, or a refund of a gas based fee fails, the router pushes the undelivered amount to the failed delivery address and emits `DeliveryFailed(token, recipient, amount, reason)`. A recipient that is the zero address or the router itself gets the same treatment after the tip. Data of no known shape has no tip, so the whole value is handed off. A 20 byte receiver with a token that is not the wrapped native token is paid the token, or handed off when the token refuses it. If a token also blocks the failed delivery address, the router keeps a record for that address only, in `claimable(token, failedDeliveryAddress)`, and anyone calls `claim(token)` to pay it. The router keeps no recipient records and has no `claimNative`. The review screens show "if delivery fails, the tokens go to <address>", read from the router (`failedDeliveryAddress()`); when the read fails they say the address is unknown and warn the user. The explorer does not show the record and has no claim button for it; read `claimable` on the router and send `claim` with a wallet. The ABI in `explorer/shared` includes the new constructor argument, function and event.

**Many deliveries go through Multicall3.** The router has no batch entry. The bots runner sends one transaction to Multicall3 (`aggregate3`, with `allowFailure` set on each call). The first call is `update(proof, publicValues)` at the light client, when the head is behind. Each other call is `executeMessageWithRunner(proof, reward)` at the router. One failed call never reverts the others, so the calls work independently of one another. A message that is already delivered fails alone with `AlreadyDelivered`. A message whose anchor is not stored fails alone with `AnchorNotStored`. The router checks `tx.origin`, because inside Multicall3 the caller of the router is the Multicall3 contract. The runner signs the transaction, so a copier cannot pass the check. The source of Multicall3 is in `src/hardened/vendor/multicall3`. The canonical address is `0xcA11bde05977b3631167028862bE2a173976CA11`. The bots runner reads the results from a simulation and the bridge events from the receipt. See `docs/bots.md` for the reasons and the gas figures.

**A direct delivery pays no tip.** The bridge stays permissionless. Anyone may call `MessageBridge.executeMessage` directly. The mediator still releases the tokens to the router, but no reward address is stored, so the router takes no tip and pays the recipient everything. A direct delivery costs the sender nothing. It only means that no tip is paid.

Code: `explorer/shared/src/delivery-fee.ts` (pure bigint), `delivery-suggestion.ts` (the labels and the three suggestions) and `delivery-cost-report.ts` (the shape of the indexer answer). The terminal form "Tip for delivery" is on by default. The web interface shows the same fields.

The three modes:

| Mode | Settings | The tip | Label |
|---|---|---|---|
| Percentage | share of value (8) | `value * multiplier / 1e18`. The default is multiplier 1e15 (0.1 percent) | exact |
| Fixed | fixed fee (1) | `limit` | exact |
| Gas multiplier | none | `(gas used + overhead) * multiplier * gas price / 1e18`, never above `limit` | estimate, at most the limit |

**The gas multiplier works for any token.** The router computes the gas based tip and the limit in base units of the token. The sender folds a price into the multiplier when the transfer leaves: `multiplier = (token units per wei of the destination native coin) * margin * 1e18`. The price is the sender's own. The interface labels the field as theirs and fills it from the token valuation as a starting point. The shared function `suggestGasMultiplier` takes the price as an exact ratio of two integers (`SenderPrice`), rounds the multiplier up, and refuses a multiplier that does not fit in 96 bits. `senderPriceOfToken` turns a token valuation into that ratio.

The limit of a gas multiplier suggestion is the tip at a ceiling base fee, in base units of the transferred token. A spike in the base fee cannot take more. `expectedFee` mirrors `FeeRouter.feeInfo`. The test `explorer/shared/test/delivery-fee.test.ts` checks it, and the encoding of the director, against vectors that the compiled router printed (`explorer/shared/vectors/GenerateDeliveryFeeVectors.s.sol`).

The cost of a delivery has three lines: the gas cost (delivery gas times base fee plus priority fee), the proof cost, and the margin. The proof cost is a share of one proof, set in US dollars (`EXPLORER_PROOF_COST_USD`, default 0.02, the measured cost of one warm proof) and converted with the price of the native coin of the destination chain (`EXPLORER_NATIVE_COIN_PRICE_USD_<chainId>`; no price feed, so with no price the proof cost is left out and the form says so). `EXPLORER_DELIVERIES_PER_PROOF` (default 1) divides it. The conversion uses scaled bigint math, rounded up. Every cost line is an estimate.

Every suggestion shows its data: where the delivery gas comes from ("measured from N recent deliveries, p90" or "default, no deliveries measured yet") and the block and time of the base fee. The indexer records the gas of each delivery transaction and serves `GET /api/delivery-cost` (see `explorer/indexer/README.md`). The figures improve as it records more deliveries, with no change in the clients. Without samples the indexer returns `EXPLORER_DEFAULT_DELIVERY_GAS`, default 550000. That figure comes from Foundry: the fee router call with a gas based fee uses about 197807 gas (`test/hardened/mediator/FeeRouterGas.t.sol`), the proof check of the bridge about 290655 gas (`test/hardened/MessageBridgeGas.t.sol`), and a transaction adds 21000 gas. The sum is 509462, rounded up for calldata.
