# Explorer indexer

A Ponder project that follows both chains of one pair and serves what it finds over HTTP. The terminal dashboard and the later web interface read this API. They never scan a chain.

The indexer holds only what lands on chain. It accepts no records from outside. Proof data comes from light client `HeadUpdated` events: the transaction, the gas used and the poster.

Design: `docs/explorer.md`. Contracts: `docs/hardened-build-contract.md`.

## Workspace choice

`explorer/` is a pnpm workspace with three packages: `shared`, `indexer`, `terminal`.

- Ponder 0.17 needs Node.js 22 or newer and runs on Node.js. pnpm gives it a strict `node_modules` that Ponder handles well.
- The terminal package runs on Bun. Bun reads the pnpm `node_modules` and the workspace links. `shared` is plain TypeScript source with no build step, so both runtimes import it.
- `explorer/pnpm-workspace.yaml` sets `minimumReleaseAge: 40320` (28 days). pnpm refuses any version, direct or transitive, that is younger. Every direct dependency is pinned to an exact version. The lockfile is `explorer/pnpm-lock.yaml`.

## Commands

All commands run in `explorer/`.

```sh
pnpm install                       # install and write the lockfile
pnpm abis                          # regenerate shared/src/abis from the Foundry output in out/ (run forge build first)
pnpm test                          # unit tests of shared and indexer
pnpm typecheck
pnpm --filter @zk-bridge/indexer run test:integration   # starts anvil, Postgres and Ponder; needs forge, anvil, initdb, pg_ctl
pnpm indexer:dev                   # ponder dev: reloads on a file change
pnpm indexer:start                 # ponder start: production mode
```

Index and query:

```sh
export EXPLORER_DEPLOYMENT_FILE=/path/to/deployment.json   # the file that docker/deploy.sh writes
export EXPLORER_RPC_URL_1=...                               # execution RPC endpoint of chain 1
export EXPLORER_RPC_URL_369=...                             # execution RPC endpoint of chain 369
pnpm indexer:start                                          # serves http://localhost:42069
curl -s localhost:42069/api/summary
curl -s 'localhost:42069/api/feed?status=sent,covered&limit=20'
```

## Configuration

| Variable | Meaning | Default |
|---|---|---|
| `EXPLORER_PAIR` | Pair name. Known: `eth-pls` (chain 1 and chain 369), `sepolia-pls943` (chain 11155111 and chain 943). | `eth-pls` |
| `EXPLORER_DEPLOYMENT_FILE` | Deployment JSON: one section per chain with `chain_id`, `bridge`, `mediator`, `token_factory`, `native_router`, `wrapped_native`, `gate`, `light_client`, `start_block`, and optional `delivery_router` and `fork_registry`. A section matches a side by `chain_id`. `rpc_url` in the file is a fallback. | `../deployments/<pair>.json` |
| `EXPLORER_RPC_URL_<chainId>` | Execution endpoint. Comes from the environment because URLs can carry keys. | the `rpc_url` of the file |
| `EXPLORER_BEACON_URL_<chainId>` | Beacon node endpoint of that chain. Optional. Used for the finalized slot in `/api/heads`. | none |
| `EXPLORER_FINALITY_SECONDS_<chainId>` | Seconds before a send counts as `waiting_for_finality`. | 768 (chains 369 and 943: 640) |
| `EXPLORER_TIP_INTERVAL_BLOCKS` | Blocks between two clock updates. | 5 |
| `EXPLORER_DELIVERY_SAMPLE_LIMIT` | How many of the newest recorded deliveries of each kind feed `/api/delivery-cost`. | 200 |
| `EXPLORER_DEFAULT_DELIVERY_GAS` | Gas that `/api/delivery-cost` gives for a kind with no samples. The default is the Foundry measured sum: the delivery router delivery call with the gas based fee (about 197807 gas, `test/hardened/mediator/DeliveryRouterGas.t.sol`), plus the bridge proof check (290655 gas, `test/hardened/MessageBridgeGas.t.sol`), plus 21000 gas of transaction base. That sum is 509462. The default rounds it up to 550000 for calldata. | 550000 |
| `EXPLORER_PROOF_COST_USD` | The cost of one proof, in US dollars, as a decimal text. | 0.02 |
| `EXPLORER_DELIVERIES_PER_PROOF` | How many deliveries one proof covers. | 1 |
| `EXPLORER_NATIVE_COIN_PRICE_USD_<chainId>` | The price of the native coin of that chain in US dollars, as a decimal text. Without it, `proofCost.wei` is null. | none |
| `DATABASE_URL` | Postgres connection string. Without it, Ponder uses its embedded PGlite database in `.ponder/pglite`. | PGlite |
| `PORT` / `--port` | HTTP port. | 42069 |

No endpoint, key or address of a deployment is committed. The API never shows RPC or beacon URLs.

## API contract

Stable. Add fields freely. Do not rename or remove a field without telling the terminal and web authors.

The shapes come from `shared/src/api-views.ts`, and the message, transfer and status rules from `shared/src/message-merge.ts`, `shared/src/send-decoding.ts` and `shared/src/status.ts`. The dashboards use the RPC data source (`shared/src/rpc`) when this indexer is not available, and it builds its answers with the same functions. So a field that you add here belongs in `api-views.ts`. `test/unit/rpc-equivalence.test.ts` feeds one synthetic history to the handlers of this indexer and to the RPC data source, and compares the feed, one message and the tokens.

Conventions:

- Every endpoint is `GET` and answers JSON. Errors answer `{ "error": "..." }` with status 400, 404 or 503.
- Block numbers, timestamps (Unix seconds), slots, chain identifiers and counts are JSON numbers.
- Every token amount is a decimal string of base units, for example `"1500000"`. Never parse it as a float. Use `formatTokenAmount` from `@zk-bridge/shared` with the token `decimals`.
- Addresses and hashes are lowercase hex. Lowercase an address before you put it in a filter. The API does it for its own parameters.
- A token object is `{ chainId, address, symbol, name, decimals, metadataRead, isBridgedCopy, homeChainId, homeToken }`. When `metadataRead` is false, the chain did not answer and `decimals` is 18 by assumption.

### Status values

| Status | Meaning |
|---|---|
| `sent` | The send is on the source chain and younger than the finality window. |
| `waiting_for_finality` | Older than the window. No stored head covers it yet. |
| `covered` | The destination light client stored a head whose execution block is at or after the source block. Anyone can deliver it. |
| `delivered` | The destination bridge executed it and the call succeeded. |
| `failed_call` | Executed and the call reverted. Final. |
| `fallback_used` | The fallback address received a token release. |
| `claimable` | The release waits for `claim`. It returns to `delivered` after the claim. |

In flight means `sent`, `waiting_for_finality` or `covered`.

### Endpoints

`GET /api/pair` returns `{ name, sides: [{ name, chainId, startBlock, finalitySeconds, contracts }] }`. `contracts` holds `bridge`, `mediator`, `tokenFactory`, `nativeRouter`, `wrappedNative`, `gate`, `lightClient`, `deliveryRouter`, `forkRegistry` (the last two can be null).

`GET /api/summary` is the top bar and the footer in one call. Query: `now` replaces the clock (tests).

```json
{
  "pair": "eth-pls", "now": 1790000000,
  "heads": [ /* as /api/heads */ ],
  "gates": [{ "chainId": 1, "gate": "0x..", "enforcing": true, "sealed": false, "sealedVersion": null, "sealedSlot": null,
              "lastConfirmedEpoch": 7, "lastConfirmedVersion": "0x0000036c", "lastConfirmedTimestamp": 1789999000,
              "confirmations": 3, "depositsOpen": true, "depositsOpenedTimestamp": 1789000000 }],
  "inFlight": { "total": 3, "byStatus": { "sent": 1, "waiting_for_finality": 1, "covered": 1 }, "byDirection": { "1>369": 2, "369>1": 1 } },
  "volume24h": [{ "chainId": 1, "token": { "...": "token object" }, "volume": "1150000", "transfers": 3 }],
  "feesAccrued": [{ "chainId": 1, "token": { "...": "..." }, "accrued": "800" }],
  "lastHeadUpdates": [{ "chainId": 369, "update": { "slot": 101, "executionBlockNumber": 55, "transactionHash": "0x..", "timestamp": 1789999900,
                       "gasUsed": "5400000", "costWei": "...", "poster": "0x.." } }]
}
```

`volume24h` sums the net amount of transfers sent in the last 24 hours, per source chain and source token. `lastHeadUpdates[].update` is null when the light client has not stored a head.

`GET /api/heads` returns `{ heads: [...] }`, one per side. The light client on a side tracks the other chain: `trackedChainId`. Fields: `chainId`, `name`, `lightClient`, `trackedChainId`, `storedHeadSlot`, `storedHeadExecutionBlock`, `storedHeadExecutionTimestamp`, `lastUpdateTimestamp`, `updateCount`, `finalizedSlot` (needs a beacon URL, else null), `lagSlots` (`finalizedSlot - storedHeadSlot`), `lagSeconds` (newest indexed time of the tracked chain minus the time of the head's execution block), `trackedChainTipBlock`, `trackedChainTipTimestamp`, `ownChainTipBlock`, `ownChainTipTimestamp`. Unknown values are null.

`GET /api/feed` returns `{ items: [...], nextCursor }`, newest send first. Query parameters, all optional:

| Parameter | Meaning |
|---|---|
| `direction` | `1>369` or `1-369`: source chain, then destination chain. |
| `kind` | `token` or `message`. |
| `status` | One status or a comma list. |
| `token` | A token address on either side of a transfer. |
| `address` | Sender, executor, recipient, fallback or payee. Any letter case. |
| `from`, `to` | Send time range in Unix seconds, inclusive. |
| `limit` | 1 to 200. Default 50. |
| `cursor` | The `nextCursor` of the previous page. |

An item:

```json
{
  "messageId": "0x..", "kind": "token", "status": "delivered",
  "direction": { "sourceChainId": 1, "destinationChainId": 369, "label": "1>369" },
  "sender": "0x..", "executor": "0x..", "gasLimit": 2000000,
  "sent": { "transactionHash": "0x..", "blockNumber": 12, "timestamp": 1789999000 },
  "covered": { "headSlot": 100, "timestamp": 1789999100 },
  "delivered": { "transactionHash": "0x..", "blockNumber": 40, "timestamp": 1789999200, "success": true, "executedBy": "0x.." },
  "fallbackUsed": false, "callbackFailed": false, "claimableOutstanding": false,
  "transfer": {
    "sourceToken": { "...": "token object" }, "destinationToken": { "...": "token object" },
    "sender": "0x..", "recipient": "0x..", "fallbackRecipient": "0x..", "paidTo": "0x..",
    "value": "1000000", "deliveredValue": "1000000",
    "handler": "deployAndHandleBridgedTokens", "deploysCopy": true, "hasCallback": false, "sourceIsNative": true
  }
}
```

`sent`, `covered`, `delivered` and `transfer` are null when they do not apply. `executor` is the message target. For a token message it is the mediator on the destination chain. `transfer.value` is the net amount after the bridge fee. `sentTimestamp` and `deliveredTimestamp` are times on different chains.

`GET /api/messages/:messageId` returns one item as above, plus `data` (the call data as hex).

`GET /api/head-updates?chainId=&limit=&before=` returns `{ items: [{ chainId, slot, headerRoot, executionBlockHash, executionBlockNumber, transactionHash, blockNumber, timestamp, gasUsed, effectiveGasPrice, costWei, poster }] }`, newest first. `before` is a slot.

`GET /api/light-client-costs` returns `{ perChain: [{ chainId, updates, gasUsed, costWei }], perPoster: [{ chainId, poster, updates, gasUsed, costWei }] }`. Sums are decimal strings. `costWei` is in the smallest unit of the chain's coin.

`GET /api/delivery-cost?chainId=` returns what a delivery costs on one destination chain. A missing or unknown `chainId` gives status 400 and `{ error }`. The shape is `DeliveryCostReport` in `shared/src/delivery-cost-report.ts` (check it with `parseDeliveryCostReport`). Gas and wei are decimal strings.

```json
{
  "chainId": 369,
  "baseFee": { "wei": "2000000000", "blockNumber": 25000000, "timestamp": 1760000000 },
  "proofCost": { "usd": "0.02", "nativeCoinPriceUsd": "0.00005", "deliveriesPerProof": 1, "wei": "400000000000000000000", "isEstimate": true },
  "kinds": {
    "token_callback": { "sampleCount": 0, "averageGas": null, "p90Gas": null, "defaultGas": "550000", "isDefault": true },
    "token": { "sampleCount": 12, "averageGas": "301220", "p90Gas": "310004", "defaultGas": "550000", "isDefault": false },
    "message": { "sampleCount": 3, "averageGas": "296810", "p90Gas": "297500", "defaultGas": "550000", "isDefault": false }
  }
}
```

The gas is `gasUsed` of the whole delivery transaction. The indexer records it for each `AffirmationCompleted` event (table `delivery_costs`), except when the same transaction holds more than one delivery of the bridge: a batch has no gas that belongs to one message, so the indexer records nothing for it. `averageGas` is the mean rounded half up. `p90Gas` is the 90th percentile by nearest rank, with the rank rounded up. Only the newest `EXPLORER_DELIVERY_SAMPLE_LIMIT` samples of each kind count.

The kind rules: `token_callback` is a `token` message whose transfer has a callback (a delivery through the delivery router). `token` is a `token` message without a callback. `message` is every other message kind. The send and the delivery arrive in either order, and a delivery that arrives first creates the `messages` row with the placeholder kind `message`. So a delivery counts only after its send is indexed (`sent_timestamp` is set), and a `token` delivery also needs its `transfers` row. Until then the delivery is left out, and it joins the figures when its send arrives. The kind is not stored in `delivery_costs`.

When a kind has no samples, `isDefault` is true and `defaultGas` is a configured default, not a measure. Figures improve by themselves as the indexer records more deliveries. `proofCost.wei` comes from configured prices with exact integer math, and `isEstimate` is always true. `baseFee` is the base fee of the newest block that the clock handler saw (every `EXPLORER_TIP_INTERVAL_BLOCKS` blocks), and is null before the first block or on a chain without a base fee.

`GET /api/gate` returns `{ sides: [...as summary.gates], events: [{ chainId, kind, epoch, version, slot, canary, transactionHash, blockNumber, timestamp }] }`. `kind` is `confirmed`, `sealed`, `beacon_roots_detected` or `canary_fired`. `enforcing` and `sealed` come from the gate contract.

`GET /api/registry` returns `{ observations: [{ chainId, version, slot, transactionHash, blockNumber, timestamp }] }`.

`GET /api/tokens` returns `{ tokens: [token object + registeredTransactionHash, registeredBlockNumber, registeredTimestamp] }`.

`GET /api/escrow` returns `{ escrow: [{ chainId, token, balance, accruedFees, updatedBlockNumber, updatedTimestamp }], bridgedSupply: [{ chainId, token, nativeToken, homeChainId, minted, burned, supply, ... }] }`. `balance` is `mediatorBalance(token)` read from the contract. `supply` is mints minus burns of the copy.

`GET /api/audit` is the escrow check for each native token:

```json
{ "tokens": [{ "token": {}, "bridgedToken": {}, "escrow": "750000", "accruedFees": "0", "bridgedSupply": "750000",
               "pendingForward": "0", "pendingBackward": "0", "expectedEscrow": "750000", "difference": "0", "mismatch": false }] }
```

The rule: `escrow = bridgedSupply + pendingForward + pendingBackward`. `pendingForward` is the value locked on the home chain and not yet paid on the other chain. `pendingBackward` is the value burned on the other chain and not yet paid on the home chain. A transfer is paid when its status is `delivered` or `fallback_used`. `claimable` and `failed_call` count as pending, because the tokens are held or owed. `difference` is `escrow - expectedEscrow`: negative means the copy is under-backed. Accrued fees sit outside the escrow. The two sides are read at different blocks. Check a `mismatch` twice before you raise an alarm.

`GET /api/fees?limit=` returns `{ balances: [{ chainId, token, charged, collected, accrued }], terms: [{ chainId, rate, recipient }], events: [...] }`. `rate` is `currentFeeRate()` at the last charged fee, in the units of `TokenMediator.FEE_DENOMINATOR`. The fee follows a fixed declining schedule with no admin, so no event announces it. A fee event has `kind` `charged_outgoing`, `charged_incoming` or `collected`.

`GET /api/claimables?address=&limit=` returns `{ outstanding: [{ chainId, token, account, outstanding, recordedTotal, claimedTotal }], events: [{ chainId, kind, token, account, fallbackRecipient, value, messageId, transactionHash, timestamp }] }`. `kind` is `fallback_used`, `claimable_recorded`, `claimed` or `callback_failed`.

Ponder also serves `GET /health`, `/ready`, `/status`, `/metrics`, GraphQL at `/graphql`, and Structured Query Language over HTTP at `/sql/*` for `@ponder/client`.

### Tables

Ponder writes the tables into the schema that `--schema` names (default for `ponder start`: the deployment schema). Column names are snake case in Postgres (`sent_timestamp`) and camel case in TypeScript and GraphQL (`sentTimestamp`). Block numbers, timestamps, slots and amounts are `numeric(78,0)` columns. Definitions: `ponder.schema.ts`.

| Table | Key | Content |
|---|---|---|
| `messages` | `message_id` | One row per message: ids, chains, `direction`, `kind`, `status`, sender, executor, gas, data, send and delivery facts, `covered_by_head_slot`, `fallback_used`, `claimable_outstanding`. |
| `transfers` | `message_id` | Token view of a `token` message: tokens, sender, recipient, fallback, `value`, `delivered_value`, `paid_to`, `source_is_native`. |
| `tokens` | `chain_id, address` | Metadata, `is_bridged_copy`, home chain and home token. |
| `escrow` | `chain_id, token` | `balance`, `accrued_fees` of a native token. |
| `bridged_supply` | `chain_id, token` | `minted`, `burned`, `supply` of a copy. |
| `claimables` | `chain_id, token, account` | `outstanding`, `recorded_total`, `claimed_total`. |
| `claim_events` | `id` | Fallback, claimable, claim and callback events. |
| `fee_events`, `fee_balances`, `fee_terms` | | Fee events, totals per token, the last read rate and recipient. |
| `head_updates` | `chain_id, slot` | Every head update: header root, execution block, transaction, `gas_used`, `effective_gas_price`, `cost_wei`, `poster`. |
| `light_client_heads` | `chain_id` | Newest head per chain. |
| `chain_tips` | `chain_id` | Newest indexed block and time per chain, and its `base_fee_per_gas` (null when absent). |
| `delivery_costs` | `message_id` | `gas_used` and `effective_gas_price` of the delivery transaction, one row per delivered message. No row for a batch. Index on `destination_chain_id, timestamp`. |
| `gate_events`, `gate_states` | | Gate events and the folded state. |
| `registry_observations` | `chain_id, version` | Fork versions the registry observed. |
| `bridge_states` | `chain_id` | Whether sends are open. |

Example queries over HTTP with `@ponder/client`:

```ts
import { createClient } from "@ponder/client";
import * as schema from "@zk-bridge/indexer/ponder.schema";
import { desc, eq } from "@ponder/client";

const client = createClient("http://localhost:42069/sql", { schema });
const waiting = await client.db.select().from(schema.messages).where(eq(schema.messages.status, "waiting_for_finality"));
const updates = await client.db.select().from(schema.headUpdates).orderBy(desc(schema.headUpdates.timestamp)).limit(10);
```

Example GraphQL:

```graphql
{ messagess(limit: 10, where: { status: "covered" }, orderBy: "sentTimestamp", orderDirection: "desc") { items { messageId status sender } } }
```

Prefer the JSON routes above for the dashboard: they join tokens, format amounts as strings and need no schema import.

## How it derives status

- Both chains are indexed with Ponder ordering "multichain": each chain on its own clock. A message row can start from the send or from the delivery. Every writer merges its facts into the row and recomputes `status` with `deriveStatus` (`shared/src/status.ts`), a pure function. The order of arrival does not change the result.
- Coverage: a `HeadUpdated` event on the destination reads `executionBlockNumber(hash)` from the light client. Every uncovered message of that direction with `sent_block_number <= executionBlockNumber` becomes covered. A send that arrives later checks the stored head.
- Clock: a block handler runs every few blocks on each chain. It stores the chain time and moves old `sent` rows to `waiting_for_finality`.
- Escrow: after each mediator event that can change it, the handler reads `mediatorBalance` and `accruedFees` from the contract at that block. The contract is the authority.
- Supply: from `Transfer` events of bridged copies that go from or to the zero address. The copies are found through `NewTokenRegistered`.

## Tests

- Unit: `test/unit`. Handlers, routes, beacon helper, pair loading, the row types against the shared types, and the equivalence with the RPC data source. Shared (message merge order, send decoding, feed query parsing, audit rule, the RPC data source): AMB codec against vectors that `AmbMessageCodec.sol` produced (`shared/vectors/GenerateAmbVectors.s.sol`), mediator payloads, status, formatting, pair registry, ABIs.
- Integration `test/integration/synthetic.test.ts`: two Anvil chains with test doubles that emit the real event signatures (`test/contracts/Synthetic.sol`), a real Postgres server and the real Ponder process. It covers the delivered side, which needs proofs on the real contracts.
- Integration `test/integration/real-stack.test.ts`: the real contracts from `docker/deploy.sh`. See the file header for what it covers.

## Limits

- The real bridge delivers a message only with a proof. The indexer covers the delivered side with synthetic events in the test, and never with proofs.
- Committee changes of the light client emit no event, so they are not indexed.
- Without a beacon URL, `finalizedSlot` and `lagSlots` are null.
