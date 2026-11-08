---
name: read-bridge-data
description: Reads zkb.fi bridge data from a program or script: transfers, message status, light client heads, delivery costs, gate state and search, through the indexer's HTTP API and the @zkb/data functions. Use when an integrator needs to list transfers, follow a message, measure light client lag, or resolve a hash or address to what it is.
kind: skill
title: Read bridge data
summary: Query the indexer API and use the @zkb/data feed, search and head readers.
audience: [integrator]
chains: all
verified_release: 0.1.2-next.14
---

# Read bridge data

## When to use

- You build a dashboard, bot, wallet or alert on top of bridge activity and need transfers, statuses, heads, costs or the gate state.
- You need to turn a hash, address, token symbol, slot or block into "what is this" with links to every surface.

For the SDK packages themselves, see `integrate-the-sdk`. To follow one transfer as a person, see `check-transfer-status`.

## Preconditions

- Node 22 or newer, or any runtime with `fetch`. No key is needed to read the public indexer.
- The indexer address: the `indexer` entry of `ZKB_SITES` in `@zkb/data` (`https://indexer.zkb.fi`). It serves one pair; on 2026-11-06 it served the pair `sepolia-pls943` (chains 11155111 and 943). `GET /api/pair` tells you which pair, its chains and its contract addresses.
- `@zkb/data` is private and unpublished (version 0.0.0, `UNLICENSED`). You can read the code in `explorer/data`, or use the HTTP API, which needs no package.

## Steps

### 1. Know the contracts

`GET /api/pair` returns `{ name, sides: [{ name, chainId, startBlock, finalitySeconds, contracts }] }`. `contracts` holds `bridge`, `mediator`, `tokenFactory`, `wrappedNative`, `gate`, `lightClient`, `deliveryRouter` and `forkRegistry` (the last two can be null). Do not copy addresses into code from a document: read them here. In these docs they are written as placeholders, for example the light client on PulseChain testnet v4 is `{{contracts.943.lightClient}}` and the bridge on Sepolia is `{{contracts.11155111.bridge}}`.

### 2. Use the API

Conventions: every endpoint is a GET and answers JSON; errors answer `{ "error": "..." }` with status 400, 404 or 503; token amounts are decimal strings of base units (never parse as a float; use `formatTokenAmount` of `@zkb/core` with the token's `decimals`); addresses and hashes are lowercase hex; block numbers, timestamps (Unix seconds), slots and chain ids are numbers.

| Endpoint | Gives |
|---|---|
| `GET /api/feed` | `{ items, nextCursor }`, newest send first. Filters: `direction` (source chain id, then `>`, then destination chain id, for example `943>11155111`; a hyphen also works), `kind` (`token` or `message`), `status` (one or a comma list), `token`, `address` (sender, executor, recipient or payee, any letter case), `from` and `to` (Unix seconds), `limit` (1 to 200, default 50), `cursor`. |
| `GET /api/messages/:messageId` | One item as in the feed, plus `data` (call data as hex) and `costs` (`sent`, `delivered`, `proof`). 400 for an id that is not 0x and 64 hex digits; 404 `unknown message`. |
| `GET /api/search?q=&limit=` | Resolves what a person types (see below). |
| `GET /api/heads` | One light client head per side: `storedHeadSlot`, `storedHeadSource` (`update` or `deployment`), `storedHeadExecutionBlock`, `lastUpdateTimestamp`, `updateCount`, `finalizedSlot`, `lagSlots`, `lagSeconds`, and more. |
| `GET /api/head-updates?chainId=&limit=&before=` | Stored heads, newest first (`before` is a slot). |
| `GET /api/summary` | The top bar in one call: heads, gates, in flight counts by status and direction, 24 hour volume, last head updates. |
| `GET /api/delivered` | Deliveries in the last 24 hours and 7 days per direction, with timing (`sentToDelivered` average, median, p90). |
| `GET /api/delivery-cost?chainId=` | What a delivery costs on one destination chain: base fee, gas by kind (`token_callback`, `token`, `message`), with `isDefault` true when it is a configured default (550,000 gas) rather than a measurement. 400 for a missing or unknown `chainId`. |
| `GET /api/undelivered?direction=&after=&limit=` | Covered, undelivered messages, oldest first (`limit` 1 to 500, default 100). |
| `GET /api/history`, `/api/tx/:chainId/:hash`, `/api/gate`, `/api/registry`, `/api/tokens`, `/api/escrow`, `/api/audit`, `/api/release-events`, `/api/light-client-costs` | History events, one transaction's cost, deposit gate state, fork versions, tokens, escrow balances, the escrow audit, failed releases, update costs. The full contract is in the indexer's readme in the source repository. |
| `GET /health`, `/ready`, `/status`, `/metrics` | Ponder's own endpoints. |

Statuses are `sent`, `waiting_for_finality`, `covered`, `delivered` and `release_failed` (see `check-transfer-status` for each meaning). In flight is the first three.

Search (`GET /api/search?q=<text>`): `q` is 1 to 200 characters. A 32 byte value is read as a message id and a transaction hash; a 20 byte value as an address (a deployment contract by role, a bridged token, or an address with its transfer count); `0x` and 6 to 63 hex digits as a prefix; a word as a token symbol or name; digits as a proof, slot or block; `bafy...` or `Qm...` as a release CID; a name such as `name.eth` gives `unsupported: "name"`. Each result is `{ id, kind, title, subtitle, confirmed, chainId, addressType, target, links, rank }`; `confirmed` is false when only the shape fits.

```js
const api = "https://indexer.zkb.fi";
const getJson = async (path) => {
  const response = await fetch(`${api}${path}`);
  if (response.status === 404) return null;
  if (!response.ok) throw new Error(`indexer answered ${response.status}`);
  return response.json();
};

// The newest transfers, then the next page.
const page = await getJson("/api/feed?limit=50");
const more = page.nextCursor === null ? null : await getJson(`/api/feed?limit=50&cursor=${encodeURIComponent(page.nextCursor)}`);

// Transfers waiting for a deliverer, and how far each light client is behind.
const covered = await getJson("/api/feed?status=covered&limit=200");
const { heads } = await getJson("/api/heads");
for (const head of heads) console.log(head.chainId, "tracks", head.trackedChainId, "slot", head.storedHeadSlot, "lag seconds", head.lagSeconds);
```

(This code was run against the live indexer on 2026-11-06.)

### 3. Use `@zkb/data`

`@zkb/data` holds the same views and the readers behind them. Import from the package root only.

- `resolve(text, sources, { limit })` is the resolver of search. `sources` holds `sites`, `chains` and optional readers (`indexer.message`, `indexer.messageByTransaction`, `tokens`, and so on). A missing reader leaves its results shaped but not confirmed. A failing reader adds a fixed sentence `"<source>: unavailable"` to `problems` and never leaks its error text.
- `ZKB_SITES` (the public hosts: dapp, indexer, status, backend, gateway) and `DAPP_ORIGINS`.
- `createExplorerConnection({ pair, resolved, ... })`: the indexer while it is reachable and close to the head, else RPC reads, with the reason in `status()`. `getJson(url)`, `request(url)`, `run`, `subscribe`, `checkNow`. `resolveConnection({ chainIds, user, environment, registry })` picks each setting from the user, then the environment, then the default. No URL is built in: every endpoint is the caller's.
- `parseFeedQuery(searchParams)` and `encodeCursor` for the feed's query rules; `MAX_FEED_LIMIT` is 200 and `DEFAULT_FEED_LIMIT` 50.
- Chain reads that name their block: `readAt`, `readStoredHeadAt`, `readGateAt`, `createLightClientReader(client, address)`, `createHttpChainReader`, `createViemChainReader`. A failed read throws; nothing is replaced by a default.
- Proofs and the proof queue: `readBoardMessages({ boardUrl, category, fetchJson })` (messages now on the msgboard), `tryDecodeProofMessage`, `createBackendClient({ baseUrl, fetchJson, postJson })` with `requestProof`, `requestStatus`, `directionStatus`, `latestProof` (null on 404), `evidence`, `health`.

```js
import { resolve, ZKB_SITES } from "@zkb/data";

const getJson = async (path) => {
  const response = await fetch(`${ZKB_SITES.indexer}${path}`);
  if (response.status === 404) return null;
  if (!response.ok) throw new Error(`indexer answered ${response.status}`);
  return response.json();
};
const asSearchMessage = (item) => item === null ? null : {
  messageId: item.messageId,
  kind: item.kind,
  status: item.status,
  sourceChainId: item.direction.sourceChainId,
  destinationChainId: item.direction.destinationChainId,
  sentTransactionHash: item.sent?.transactionHash ?? null,
  deliveredTransactionHash: item.delivered?.transactionHash ?? null,
  symbol: item.transfer?.sourceToken.symbol ?? null,
};

const resolution = await resolve(messageId, {
  sites: ZKB_SITES,
  chains: [
    { chainId: 11155111, name: "Sepolia", side: "first", contracts: {} },
    { chainId: 943, name: "PulseChain testnet v4", side: "second", contracts: {} },
  ],
  indexer: {
    message: async (id) => asSearchMessage(await getJson(`/api/messages/${id}`)),
    messageByTransaction: async () => null,
  },
});
// resolution.results[0]: kind "message", confirmed true, with links to the dapp, indexer, status and backend.
```

(Run against the built `dist` of `@zkb/data` and the live indexer on 2026-11-06. To resolve a transaction hash, put a real reader in `messageByTransaction`, or call `GET /api/search` and let the indexer do it.)

## Expected result

- `/api/feed?limit=50` returns up to 50 items and a `nextCursor` string, or `null` on the last page.
- A feed item has `messageId`, `kind`, `status`, `direction`, `sender`, `executor`, `sentLogIndex`, `sent`, `covered`, `delivered`, `callbackFailed`, `releaseFailed` and `transfer`. `sent`, `covered`, `delivered` and `transfer` are null when they do not apply.
- `/api/heads` returns `{ heads: [...] }` with one entry for each side. `lagSeconds` of a few thousand on the testnet pair was normal on 2026-11-06 (2,360 s and 4,152 s).
- `resolve` of a message id returns a result of kind `message` with `confirmed: true` when the indexer knows it.

## If it fails

- **400 `invalid message identifier`, or 400 on `/api/delivery-cost`.** The id must be 0x and 64 hex digits; `chainId` must be a chain of the pair.
- **404 `unknown message`.** The indexer has not seen it, or you passed a transaction hash. Search by hash with `/api/search`.
- **503.** The indexer is not ready or an optional module is not running. Retry later. In `@zkb/data`, `createExplorerConnection` falls back to RPC reads and says why in `status()`.
- **A number that looks wrong.** Amounts are decimal strings of base units. A token with `metadataRead: false` has `decimals` of 18 by assumption, because the chain did not answer.
- **Different pair than expected.** The indexer serves one pair at a time. Read `/api/pair` first.
- **Light client lag is large.** `lagSeconds` is the newest indexed time of the tracked chain minus the time of the stored head. A head still at `storedHeadSource: "deployment"` has `updateCount` 0 and null execution fields.

<!-- TODO: the rate limits and the availability promise of https://indexer.zkb.fi are not documented anywhere I read. Ask the owner what to tell integrators. -->
<!-- TODO: the CORS behaviour for browser calls of the indexer was not checked. -->
<!-- TODO: contract placeholder names (bridge, mediator, lightClient, deliveryRouter, gate, tokenFactory, wrappedNative, forkRegistry) are the keys of /api/pair; confirm they match contracts.json. -->

## References

- `check-transfer-status`, `integrate-the-sdk`, `run-a-delivery-bot`.
- `settings-and-explore`: the services the dapp reads.
