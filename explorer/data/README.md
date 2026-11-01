# @zkb/data

The data layer of the zkb.fi bridge screen: it sources what the rules of `@zkb/core` compute on. It fetches proofs from the
msgboard, forms and sends the request to the proof queue, reads the indexer API and reads straight from an RPC (the user's
choice, with the same fallback the dapp uses), and decodes what comes back into the views the screen shows.

Status: private and unpublished (`UNLICENSED` until the npm org and a licence exist). This is the second slice of the SDK:
`@zkb/core` (rules) is below it, `@zkb/react` is meant to sit on top. The code moved here from `explorer/shared`, which
keeps a re-export at every old path.

Runtime dependencies: `@zkb/core`, `viem`, `@msgboard/sdk` (the msgboard socket client) and `zod` (the shape of the proof
queue answers). ESM only, Node 22 or newer or any browser, plain `tsc` output in `dist/` with `.d.ts`.

## I/O rules

1. **Endpoints are the caller's.** No URL is built in. Every URL comes from the caller (`resolveConnection` picks each
   setting from the user, then the environment, then the registry default, like the Settings screen of the dapp).
   A URL can hold a key: nothing here logs one, and `connection.redact(text)` / `redactConnectionText` remove every known
   secret from a text.
2. **`fetch` and `WebSocket` are the global ones, and every client takes its own.** The proof queue client takes
   `fetchJson` and `postJson`, the board reader takes `fetchJson`, the connection takes `fetchJson` and `createReader`, the
   board feed takes `createSocket`. Defaults (`fetchJsonResponse`, `postJsonResponse`, `fetchClient`) use the global
   `fetch`; the msgboard socket client uses the global `WebSocket` (Node 22 and every browser have one). No `node:` import
   is in the public surface; a test checks the import graph.
3. **Reads name their block.** A read that feeds a core rule gives back the block it read at, so the rule gets the block as
   an argument and stays deterministic. A `ViewCall` takes `blockNumber`. `readAt` resolves a block once (a tag is read once
   and fixed to its number), pins every contract read of the callback to it, and returns `{ value, block }`. The
   `read...At` functions are the reads of the screen done that way. The old functions are unchanged: without a block, the
   node answers at its own latest block.
4. **A failed read throws.** A number that could not be read is never replaced by a default. The one documented exception
   is `readFinalizedSlot`, which gives null because a lag that cannot be measured is shown as unknown.
5. **Answers are parsed.** The proof queue client and the board reader refuse a wrong shape at the edge.

## API

Import from the package root only; there are no deep paths.

```ts
import { createBackendClient, readGateAt, resolveConnection } from "@zkb/data";
```

Msgboard (`msgboard/board`, `msgboard/board-http`):

| Export | What it does |
| --- | --- |
| `readBoardMessages({ boardUrl, category, fetchJson })` | The messages now on the board for a category, over HTTP (`msgboard_content`). Works in a browser. |
| `createBoardFeed({ boardUrl, reconnectDelayMilliseconds, logger, createSocket? })` | The socket side: `subscribe(category, onMessage)` across reconnects, `recent(category)`, `close()`. |
| `createBoardPublisher({ boardUrl, maximumMessageBytes, grind, grindTimeoutMilliseconds, logger })` | Posts a message. `grind` (the proof of work) is the caller's: a worker thread in Node, see `GrindFunction`. |
| `toWebSocketUrl`, `toHttpUrl`, `postJsonResponse`, `BoardReadError`, `MessageTooLargeError` | URL scheme helpers, the default poster, the errors. |
| `decodeProofMessage`, `tryDecodeProofMessage`, `encodeProofMessage`, `PROOF_DIRECTIONS`, ... (`proof-message`) | The proof message that the board carries. |

Proof queue (`backend-client`):

| Export | What it does |
| --- | --- |
| `createBackendClient({ baseUrl, fetchJson, postJson })` | `requestProof` (POST `/requests`; a refusal comes back as a value), `requestStatus` (GET `/requests/:id`), `directionStatus` (GET `/directions/:direction`), `latestProof` (GET `/proofs/latest/:direction`, null on 404), `evidence`, `health`, and the pipeline reads `progress` (GET `/progress/:messageId`, null on 404), `pipeline` (GET `/directions/:direction/pipeline`) and `benchmarks` (GET `/benchmarks?window=24h`). |
| `BackendClientError`, `jobViewSchema`, `latestProofSchema`, `ProofRequestInput`, `ProofRequestAnswer`, `JobView`, `LatestProof`, `BackendHealth` | Errors, schemas and types. |
| `transferProgressSchema`, `directionPipelineSchema`, `benchmarksSchema`, `TransferProgress`, `DirectionPipeline`, `Benchmarks` | The shapes of the pipeline reads (explorer/backend/README.md, "Pipeline reads"). |
| `PIPELINE_STAGES`, `WAITING_SERVICES`, `WAITING_SERVICE_TEXT`, `BENCHMARK_STEPS` | The stage keys in order, the services a transfer can wait on with one sentence each, and the timed steps. |
| `evidencePackageSchema`, `EvidencePackage` | The evidence package of a message. |

Indexer API views (`api-views`, `audit`, `feed-query`, `history-query`, `delivery-cost*`):

| Export | What it does |
| --- | --- |
| `feedItemView`, `tokenView`, `escrowView`, `supplyView`, `headView`, `gateView`, `inFlightView`, `volumeView`, `auditItemView`, ... | The JSON views of the indexer API, built from rows. |
| `parseFeedQuery`, `encodeCursor`, `parseHistoryQuery`, `compareHistoryEvents`, ... | Query parsing and ordering. |
| `buildDeliveryCostReport`, `parseDeliveryCostSettings`, `auditToken` | The delivery cost report and the token audit. |
| `mergeMessage`, `mergeTransfer`, `deriveStatus`, `decodeSend`, `decodeAmbMessage`, `decodeMediatorMessage` | Rows of messages and the decoding of sends. |
| `loadPair`, `PAIR_DEFINITIONS`, `describePair`, `sideOf`, `otherSide` | The pair registry. |

RPC reads (`rpc/*`, `token-facts`, `prover/light-client`, `pulsex-oracle`):

| Export | What it does |
| --- | --- |
| `createHttpChainReader`, `createViemChainReader`, `ChainReader`, `ViewCall` | A narrow reader over viem; a test passes a fake. |
| `readAt`, `pinReader`, `AtBlock` | Run reads at one block and get the block back. |
| `readStoredHeadAt`, `readGateAt`, `readMediatorBalancesAt`, `readBridgedCopyAt`, `readFinalizedSlotAt` | Reads of the light client, gate and mediator that return `{ value, block }`. |
| `readStoredHead`, `readGate`, `readMediatorBalances`, `readBridgedCopy`, `readFinalizedSlot`, `readExecutionBlockNumber` | The same reads without a block, as before. |
| `readTokenMetadata`, `nativeTokenBehind` | Token facts; an optional last argument `blockNumber`. |
| `createLightClientReader(client, address)` | The head, root and program key of the light client, all three at one block (`clock` too). |
| `createChainScan`, `scanHistory`, `createRpcExplorer`, `createRpcExplorerApi` | The log scans and the indexer-shaped API answered from RPC. |
| `plsUsd`, `tokenUsd`, `nativeUsd`, `nearestBlockAt`, `poolReaderOver(client, block)` | PulseX pool reads, each at a named block. |
| `messageBridgeAbi`, `beaconLightClientAbi`, ... | The ABIs of the contracts (generated by `pnpm abis`). |

Endpoints and fallback (`connection-settings`, `connection`, `fallback`, `connection-test`, `redaction`):

| Export | What it does |
| --- | --- |
| `resolveConnection({ chainIds, user, environment, registry })` | Each setting from the strongest source: user, environment, default. |
| `createExplorerConnection({ pair, resolved, fetchJson?, createReader? })` | The data path: the indexer while it is reachable and close to the head, else the RPC source, with the reason. `getJson`, `request`, `run`, `status`, `subscribe`, `checkNow`, `redact`. |
| `createFallbackController`, `judgeIndexerFreshness`, `describeFailure` | The fallback rule on its own. |
| `parseConnectionUrl`, `normalizeEndpoint`, `maskUrl`, `redactConnectionText`, `redactSecrets`, `redactError` | Validate, mask and redact URLs. |
| `testRpcChainId`, `testIndexerUrl`, `testHealthUrl`, `testJsonRpcUrl`, `testBeaconGenesis`, `fetchClient` | The "test this endpoint" checks of Settings. |

### Examples

These run against the built `dist/` with fakes, and use no network.

```ts
import { loadPair, readGateAt } from "@zkb/data";

// `pair` comes from loadPair({ environment, deployment }); `reader` is any ChainReader (a fake here).
const gate = await readGateAt(reader, pair.sides[0]);
// gate.value.enforcing === true, gate.value.confirmedEpoch === 3n
// gate.block.number === 500n, and every contract read of the gate named block 500
```

```ts
import { createBackendClient } from "@zkb/data";

const queue = createBackendClient({
  baseUrl: "https://queue.example/",
  fetchJson: async () => ({ status: 404, body: null }),
  postJson: async () => ({ status: 202, body: { requestId: "r1", jobId: "j1" } }),
});
await queue.requestProof({ pair: "eth-pls", direction: "ethereum-to-pulsechain", reason: "user" });
// { requestId: "r1", jobId: "j1" }; a 429, 409 or 503 comes back as { refused: ... }
await queue.latestProof("ethereum-to-pulsechain"); // null: the queue holds none
```

```ts
import { readBoardMessages } from "@zkb/data";

const messages = await readBoardMessages({
  boardUrl: "wss://board.example/rpc", // a ws(s) address is read over http(s)
  category,
  fetchJson: async () => ({ status: 200, body: { result: { [category]: [{ category, data: "0xaa", hash }] } } }),
});
// [{ category, data: "0xaa", hash }]
```

```ts
import { createExplorerConnection, resolveConnection } from "@zkb/data";

const resolved = resolveConnection({
  chainIds: [1, 369],
  user: { indexerUrl: null },
  environment: {},
  registry: { rpcUrls: { 1: "https://rpc1.example", 369: "https://rpc369.example" } },
});
const connection = createExplorerConnection({ pair, resolved, createReader: () => reader });
connection.status();
// { kind: "rpc", reason: { code: "not-set", message: "no indexer URL is set" }, label: "RPC fallback: no indexer URL is set" }
```

## What stays in `@zk-bridge/shared`

Anything that spawns a process, writes a file or needs Node: the grind worker thread (`grindInWorker`; `GrindFunction` is
the type here), the prover binary wrapper and the proof intake (`proof-intake`, `prover-binary`, `verify-guard`,
`execute-command`, `prover-config`), and the settings and secret files (`config/`). Rule-like code that is neither fetching
nor core stays too (gas limit, operator checks, delivery suggestions, transfer timing, tip coverage, proven message
decoding).

## Develop

```
pnpm install       # builds dist/ through the prepare script
pnpm test          # vitest with 100% coverage thresholds
pnpm typecheck     # tsc -p .
pnpm build         # tsc -p tsconfig.build.json -> dist/
pnpm abis          # regenerate src/abis from the Foundry output (forge build first)
```
