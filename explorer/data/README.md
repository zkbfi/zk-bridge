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

Gate evidence (`gate-evidence`): the confirmation that a send needs first on a chain whose gate enforces (Sepolia today,
Ethereum later). The bots, the terminal and the web app use the same functions:

| Export | What it does |
| --- | --- |
| `readGateStatus({ client, gate })` | The gate at the latest block: `mode`, `enforcing`, `sealed`, `confirmedEpoch`, the clock, the block, the `epoch` of the next block and `needsConfirmation`. |
| `createBeaconProofSource({ url, fetch? })` | The beacon node: a header by root, and a compact multiproof of a state (the Lodestar endpoint `/eth/v0/beacon/proof/state/{id}`; the public Lodestar nodes serve it). The proofs are checked, so the node need not be trusted. No message repeats the URL. |
| `buildGateEvidence({ client, gate, beacon, status? })` | `{ kind: "ready", to, data, epoch, forkVersion, shape, timestamp, beaconRoot, header, validUntil, evidence, encoded }`, checked with `checkConfirmEvidence` against the root that the beacon roots contract holds on chain, or `{ kind: "wait", retryAfterSeconds }` when no header of the epoch is on chain yet. |
| `ensureGateConfirmed({ client, gate, beacon, account })` | What a sender does before a send: `not-needed` (`not-enforcing` or `confirmed`), `sealed`, `wait`, or `confirm` with the `call` to send first and the `gas` of its simulation from `account`. A confirmation that would revert throws `GateEvidenceError` with the code `simulation-reverted`. |
| `ensureSendEvidence({ client, gate, beacon, now? })` | The gate evidence of a send through the delivery router, whose sends take `gateEvidence` last (decision D1): `evidence` with `gateEvidence` (`abi.encode(ForkEvidence)`) to put in the send when the epoch is unconfirmed, `not-needed` (send empty evidence), `sealed`, `wait` (no header of the epoch yet), or `late` with `waitSeconds` when less than `GATE_SAFETY_SECONDS` (60) are left in the epoch, confirmed or not. Nothing is simulated: the estimate of the send runs the gate. The rule alone is `sendEvidenceRule(status, nowMilliseconds)`. A token relay straight to the mediator takes no evidence and keeps `ensureGateConfirmed`. |
| `fallbackBeaconSource(sources, { noneText? })` | Several beacon sources tried in order; a request that one fails goes to the next. |
| `createGateCheck({ clientFor, beaconUrlsFor, noneText?, fetch?, now? })` | The gate check of a program that sends (the web app, the terminal): `ensureSendEvidence` when the question says `carriesEvidence` (a router send), else `ensureGateConfirmed`, on the chain's flow client over the beacon endpoints in force at each check. What a send does with the answer (send with or without evidence, wait, refuse, or insert the confirmation step) is `decideGateStep` in `explorer/terminal/src/tx/gate-step.ts`, which both programs use. |
| `GateEvidenceError` (`code`), `describeRevert`, `GATE_MODES`, `SHAPE_REQUEST_ORDER` | The error, a revert for a log without the URL, the modes, the order in which shapes are asked for. |

How the evidence is bound: the evidence block (`status.evidenceBlock`, two blocks behind the latest, `EVIDENCE_BLOCK_LAG`) names its `parentBeaconBlockRoot`, and EIP-4788 stores that root under the
block's time. The evidence takes that time, the header of that root, and two branches under its state root
(`fork.current_version` and `genesis_validators_root`). The gate accepts it only while the header lies in the epoch of the
block that carries `confirm`, so it is good until `validUntil` (the start of the next epoch, at most 6.4 minutes on
Ethereum). In the first slots of an epoch the newest header is from the epoch before: `wait` one slot. The simulation of `confirm` runs at the evidence block, so a load-balanced backend that is a block behind cannot miss the root; if it still reverts `BeaconRootUnavailable`, the simulation is repeated once after `SIMULATION_RETRY_MILLISECONDS`.

Send `call` as its own transaction, then the send. There is no Multicall3 bundle: inside a multicall, `msg.sender` of the
send is the multicall, and the token mediator pulls the tokens from `msg.sender`. A wallet that batches and keeps the sender
(EIP-5792 `wallet_sendCalls` on an account with code) can take `[call, send]` in one batch.

**A send of the native coin through the delivery router** carries the evidence itself, in one transaction:

```ts
import { createBeaconProofSource, ensureSendEvidence } from "@zkb/data";

const answer = await ensureSendEvidence({ client, gate: pair.sides[0].contracts.gate, beacon: createBeaconProofSource({ url }) });
// "evidence": router.wrapAndRelayTokens(receiver, answer.gateEvidence); "not-needed": the same with "0x";
// "late": wait answer.waitSeconds and ask again; "wait": wait answer.retryAfterSeconds; "sealed": stop.
```

**For a token relay straight to the mediator** (the web app and the terminal do this through `createGateCheck` and
`decideGateStep`). Before a send from a chain whose gate enforces, call `ensureGateConfirmed` with the wallet's public client, the gate of the pair side
(`pair.sides[i].contracts.gate`), a beacon source for that chain and the connected account. On `confirm`, ask the wallet
to send `call` first (one more signature, about 79,000 gas on Sepolia), wait for its receipt, then send. On `wait`, show
"waiting for the next beacon block" and call again after `retryAfterSeconds`. On `not-needed`, send at once. On `sealed`,
stop: the route is closed for good. If the send's own simulation still reverts with `ForkNotConfirmed`, the epoch turned
between the two transactions: call `ensureGateConfirmed` again.

```ts
import { createBeaconProofSource, ensureGateConfirmed } from "@zkb/data";

const step = await ensureGateConfirmed({
  client, // a viem PublicClient of the chain of the gate
  gate: pair.sides[0].contracts.gate,
  beacon: createBeaconProofSource({ url: "https://lodestar-sepolia.chainsafe.io" }),
  account,
});
if (step.kind === "confirm") await walletClient.sendTransaction({ account, ...step.call, gas: (step.gas * 13n) / 10n });
// then the send; step.kind "wait": try again after step.retryAfterSeconds
```

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

## Search

`resolve(text, sources)` reads a search text (`classifyQuery` of `@zkb/core`) and returns typed results (`message`, `transaction`, `address`, `token`, `slot`, `block`, `proof`, `release`), each with `links` to the dapp's Explore, the indexer's page (`#lookup=`), the status page (`#check=`), the backend JSON, the IPFS gateway and the block explorers of the chain (`crossLinks`, `CHAIN_METADATA`). The readers (`sources.indexer`, `sources.chain`, `sources.proofs`, `sources.backend`) are the caller's and all optional; a reader that fails is named in `problems` and the rest still answer. Ranking is fixed: exact identifier, address, prefix, token symbol, number; found before shaped. `SearchSites` are link targets, not connections: the public hosts are `ZKB_SITES`, an empty base makes relative links. The dapp's palette, the indexer's `GET /api/search` and the indexer's page (`deploy/app-server/indexer-home/zkb-search.js`, built by `pnpm --filter @zk-bridge/web run build:indexer-search`) all use it.
