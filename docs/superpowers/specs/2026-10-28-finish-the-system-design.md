# Finish the system: design

Date: 2026-10-28. Status: draft for the owner's approval.

## Intent

The contracts, the light-client programs and the prover are ready for an audit. What is missing is everything a person
needs to use the bridge, and everything a stranger needs to run it without us. This work finishes the system end to
end. It does not start over: it builds on `explorer/` (web, terminal, indexer, bots, shared) and `prover/`, and adds only
the pieces that do not exist.

The reason behind every choice below: **every part can be replaced without permission.** Anyone can run the backend,
the prover, the indexers, the bots and a delivery router with their own reward address. Every client points at
endpoints the user can see and change. If the current team goes rogue or stops, anyone can stand up a copy from the
docs, users move to it, and tips stop reaching the team. The docs must be complete enough for that.

## Goals

1. A user can bridge tokens and messages, follow them, ask for a proof, fetch a finished proof, and write a proof or a
   delivery on chain themselves when the bots are slow, from the dapp loaded from IPFS.
2. The terminal tool does the same, plus proving on the user's own processor, shipped as one standalone program.
3. A backend takes proof requests, sequences them, gets them proven on a rented GPU, publishes the proof to the
   msgboard, and keeps the evidence for undelivered messages.
4. Three sites (dapp, landing page, docs) and the terminal program ship through one signed release pipeline.
5. One end-to-end test runs the whole system on two local chains.

## Non-goals

- No change to the contracts or the light-client programs, except fixes that this work proves necessary.
- No discovery of backends. Clients point at endpoints. A successor publishes their addresses.
- No storage of past light-client proofs. Only the latest proof can be used: the contract accepts an update only from
  its current head (`PreviousHeadSlotMismatch`).
- No new trusted role. The backend holds no key that the contracts trust.

## Anti-goals (failure even if it works)

- Any reference to gibs.finance, or any tooling shared with it.
- A secret in a browser page or in a static build.
- Wording that ties tips to paying for proving, or that promises a service for a tip. A tip goes to the router's reward
  address, it is voluntary, and it buys no promise.
- A client that only works with our servers.
- A release that a hijacked domain can swap.

## Constraints (decided earlier, still binding)

- Indexer first, RPC as fallback (`docs/explorer.md`, 2026-10-26).
- The chain indexer stores only what lands on chain: no proofs, no off-chain records. The msgboard indexer and the
  archive are separate stores.
- The prover stays a stateless proof maker. The stateful parts live in the new backend, not in `prover/`. (The archived
  branch `archive/full-relayer` put a database and a wallet inside the prover; that is not repeated.)
- RunPod is used as an on-demand load-balancing endpoint (`docs/gpu-prover.md`).
- The proof publisher holds no wallet. Only the delivery runner (bots) and users sign transactions.
- Browser pages never hold secrets. Prover setup with keys stays in the terminal.
- No admin anywhere. Every package pinned exactly and at least 28 days old.
- Plain English with no acronyms in user-facing text.

## Decided by the owner (this conversation)

- Three sites: the dapp, a landing page that points to the latest releases, and the docs. All on IPFS.
- Endpoints are configured, never discovered: every client ships defaults and the user can change each one.
- The terminal tool is a first-class, low-level way to use the system, shipped as a standalone Bun program. It can prove
  on the user's processor (five minutes or more on a strong one).
- Proofs go to the msgboard for about 20 minutes. Only the latest proof matters.
- The archive is a database of evidence for messages sent and not yet delivered, plus the era block roots they need. An
  entry is dropped when its message is delivered. The window slides when deliveries happen and stretches when they do
  not.
- The team pays for GPU time today. The backend is open source and plugs into a rentable GPU service such as RunPod.
- The suggested tip is a low range, so the bridge is clearly cheap next to other bridges. Any frontend may set its own.
- A successor deploys their own delivery router with their own reward address, and users choose it at send time. Tips
  reach an address; nothing ties them to funding the GPU.
- Releases use a signed `version.json` manifest. Built from scratch, decoupled from gibs.finance.
- Finish the existing code. Do not start over.
- Tips may be below cost. A low tip never makes a delivery fail. The bots compute each delivery's expected loss before
  they send a bundle and leave out any delivery that would lose 20 percent or more of its cost (a setting). The dapp
  shows the user, before they send, two line graphs: the delivery cost and their tip, both against the base fee, with
  plain words on where the tip stops covering the cost.
- The router may be copied; no license credit is needed. Every reference to gibs.finance goes, contracts included.
- Every doc in `docs/` may be public, after a review that removes anything sensitive.

## The parts

### 1. Backend (new package `explorer/backend`, TypeScript, Node.js)

One open-source service with four modules. Each can run alone. My call: one package, so a successor deploys one thing.

- **Request service.** `POST /requests {pair, direction, reason, messageId?}` records a request. Requests for the same
  direction coalesce: a light-client update covers every finalized message, so there is at most one job per direction
  at a time. A job proves from the light client's current on-chain head to the latest finalized slot. `GET /requests/:id`
  and `GET /directions/:direction` give status (queued, proving, published, on chain, failed, with times). A job runs
  `zk-bridge-prover prove --backend remote` (the existing synchronous RunPod client) with a webhook to the service.
  The service is rate limited per caller and per direction.
- **Webhook receiver.** Receives the prover's handoff (`prover/src/handoff.rs`), checks the bearer token, verifies the
  proof the same way the bots' runner does, and hands it to the publisher.
- **Publisher.** Posts the proof to the msgboard. Reuse the bots' publisher code (`explorer/bots/src/publisher`,
  `src/msgboard`) by moving the shared part into `explorer/shared` or importing it. No wallet.
- **Evidence archive.** Watches the chain indexer for messages that are covered by a stored head and not delivered.
  Builds their evidence with `zk-bridge-prover evidence`, stores it, and serves `GET /evidence/:messageId`. Keeps the
  prover's era data for as long as an undelivered message needs it. Drops an entry when the indexer shows the message
  delivered (`AffirmationCompleted`).
- **Storage.** SQLite in one file. My call: the simplest thing a stranger can run and back up.
- **Health.** `GET /health` reports each module, the queue, and the last job per direction.

### 2. msgboard indexer (module of the backend, deployable alone)

Subscribes to the bridge's msgboard categories, keeps only the latest valid proof per direction (verified, and starting
from the current on-chain head), and serves `GET /proofs/latest/:direction`. It answers from memory plus SQLite so a
client gets the proof even after the board drops it, until a newer head makes it useless. It never serves a stale proof.

### 3. Chain indexer (`explorer/indexer`, Ponder)

Exists. Add only what the new parts need: a query for "covered and not delivered" messages (the archive's work list)
and whatever the history explorer needs for paging and filters across both chains.

### 3b. Bots (`explorer/bots`)

Exist: the publisher and the delivery runner. Change: the runner computes each delivery's expected loss (cost minus
tip) before it builds a bundle, and leaves out any delivery that would lose 20 percent or more of its cost (a setting).
A left-out message stays deliverable by anyone. The publisher's msgboard code moves where the backend can share it.

### 4. Dapp (`explorer/web`)

Exists: pair view, feed, address and message pages, bridge, wrap and message forms, default tip, indexer with RPC
fallback, in-app help. Add:

- **IPFS loading.** Relative asset paths (`base: './'`), hash routing (exists), no build that needs a server. The
  deployment configuration is baked in at build time as today; the user can override every endpoint at run time.
- **Endpoints.** Settings for backend, msgboard indexer, archive and msgboard node, beside the indexer and RPC settings
  that exist. Defaults come from the build.
- **Proof panel** on the message page: where the message is (sent, waiting for finality, covered, delivered); the latest
  proof for its direction from the msgboard indexer or the msgboard; a "request a proof" button; the request status.
- **Write actions:** "post the light-client update" (from a fetched proof) and "deliver the message" (with evidence from
  the archive or the backend). The terminal already has both (`explorer/terminal/src/tx/operator.ts`); share the logic
  through `explorer/shared`.
- **Tips:** the suggested range comes from `explorer/shared/src/default-tip.ts`. Make the range low by design and allow
  it below cost; show it as a range the user can change, with the two line graphs (delivery cost and the tip against
  the base fee) before the user sends.
- **History explorer:** every bridge event on both chains, with filters (pair, chain, kind, address, status, time),
  paging, and links to the message page. Indexer first, RPC fallback (partial history, marked as such).
- **Wallets:** injected wallets only, as today. My call: WalletConnect needs a hosted project key, which fights the
  "no secret, runs anywhere" rule.

### 5. Terminal tool (`explorer/terminal`)

Exists: views, signing (key, keystore, mnemonic, Ledger, Trezor), sends with tips, the two operator actions, prover setup.
Add:

- **Standalone program.** `bun build --compile` for macOS (arm64, x64) and Linux (x64, arm64). Windows if the
  hardware-wallet and secret-store libraries build there; otherwise say so in the release.
- **Local proving.** Run the prover on the user's processor: the release ships the `zk-bridge-prover` program and the
  two program files (ELFs) next to the terminal program, and the terminal drives `prove` and `evidence` with the local
  backend, shows progress, and offers to post the result.
- **The same reads as the dapp:** latest proof (msgboard indexer or msgboard), archive evidence, backend request and
  status, history explorer.

### 6. Docs site (new package `explorer/docs`)

A static site built from Markdown: the user help pages (`explorer/web/docs/pages`, which the dapp keeps showing) and the
operator docs in `docs/`, plus a new **"Run the whole system yourself"** guide that takes a stranger from nothing to a
running copy: deploy the contracts, run the prover and the GPU worker, the backend, the indexer, the bots, a delivery
router with their own reward address, and their own release with their own signing key. Same IPFS rules as the dapp.
My call: reuse the dapp's Markdown renderer rather than adding a docs framework.

### 7. Landing page (new package `explorer/landing`)

One static page, no framework. It fetches `version.json` and `version.json.sig` from the addresses built into it, checks
the signature against the public keys built into it, checks the sequence number never goes down (remembered in the
browser), and shows the current dapp and docs releases with several gateway links, and the terminal downloads with
checksums. If the signature fails it says so and shows nothing to click. It is served from a normal domain and also from
IPFS.

### 8. Release pipeline (`script/release/`)

One command builds a release:

- builds the dapp, docs and landing page with relative paths, packs each as an archive file (CAR), and computes its
  content address (CID) without a running node;
- builds the terminal programs and the prover programs, and writes a checksum file;
- writes `version.json`: schema number, a sequence number that only goes up, channels, and one entry per release with
  version, commit, CID, archive SHA-256 and publish time, plus the downloads with SHA-256;
- signs it with an Ed25519 key read at the moment of use (never written to disk), and writes `version.json.sig` and
  `public-keys.json`;
- verifies its own output: rebuilds and compares CIDs, checks the signature, loads each site from its archive file under
  a path prefix.

Publishing (pinning the archives, pushing the manifest to the public release repository) runs only when a remote and a
pinning account exist. Until then the pipeline runs and verifies locally.

### 9. End-to-end test (`explorer/e2e`, extended)

One command runs the whole system on two local Anvil chains: deploy, the local signed beacon node, the chain indexer,
the backend (with the oracle prover backend by default, and a real RunPod job when a key is present), a local msgboard,
the bots, then:

- a token sent each way is delivered by the bots;
- with the bots stopped, a user in the dapp (Playwright, the release build served under an IPFS-style path prefix)
  requests a proof, sees it published, posts the update and delivers the message;
- the terminal program does the same from its compiled binary, including a local proof (in a slow, opt-in stage);
- the archive serves evidence for an undelivered message and drops it on delivery;
- the landing page accepts a test-signed manifest and refuses a tampered one and a lower sequence number;
- the history explorer shows every event, with the indexer up and then down.

## Calls I made (the owner can overrule any of them)

- **First release targets testnet** (Sepolia and PulseChain testnet v4), which the prover already handles. The Ethereum
  mainnet block parser (Deneb, Electra, Fulu; `docs/audit/known-issues.md` 2.9) is still in this work, because
  bridging both ways on mainnet needs it.
- **Trust does not come from the domain.** The landing page on a normal domain is a convenience. Trust comes from the
  release public key built into the dapp and the terminal tool, and from content addresses published in more than one
  place. One release key. A new key is announced in a manifest signed by the old key. A compromised key is handled by
  a successor forking the release repository under a new key; the docs say so plainly.
- **RunPod limit.** The plan first times a real fold on the GPU worker. Queue mode is added only if a fold runs past
  the 5.5 minute limit of the load-balancing endpoint.
- **No Apple developer account.** A downloaded program needs no signature to run. Integrity comes from the SHA-256 of
  each download inside the signed manifest. The docs explain the one-time macOS approval and the `curl` install.
- **Build machines.** Bun builds the terminal program for all four platforms from one machine. The Rust prover is built
  natively: macOS arm64 on the development Mac, Linux x64 on the build host. macOS x64 and Linux arm64 get
  build-from-source steps until a machine exists for them.
- **gibs.finance references.** About 35 lines in 8 tracked files mention it, including comments in
  `src/hardened/mediator/DeliveryRouter.sol` and its tests and the name of the tip data format. They are reworded to
  describe the behavior on its own terms. Contract changes are comments only; the bytecode metadata hash changes, so the
  plan reruns the full suite and the gas checks.
- **Docs review.** Before the docs site ships, a pass over every published file removes secrets, personal data, home
  paths, private host names and anything else sensitive, and checks the red-team and containment notes for wording that
  could harm a third party.

## Left to the builder

The module layout inside each package, the database schema, the queue's retry and backoff numbers, the rate limits, the
page layouts, the tip range's numbers (within "clearly cheaper than other bridges"), the CAR and CID library (pinned,
28 days old), the signing library (or WebCrypto), and the test fixture data.

## Blocked on the owner (does not block building)

- A public remote for the source and the release repository.
- A pinning account for the IPFS archives.
- Optional: an Apple developer account, only to remove the one-time macOS warning.
- The brand name (sites, package names, the release repository).
- A license.
- The release signing key: create it in 1Password; its public key goes in the landing page and the clients.

## Known risks

- Local proving of a Groth16 proof needs at least 16 GB of memory (`prover/tests/sp1_execute.rs`), and SP1's Groth16
  wrap may need Docker on the user's machine. The builder must confirm what the terminal can do without Docker, and the
  docs must say plainly what a user needs.
- The prover cannot build message evidence from Ethereum mainnet blocks today (`docs/audit/known-issues.md` 2.9). The
  archive inherits that gap for Ethereum-sourced messages until the block parser learns Deneb, Electra and Fulu.
- RunPod's load-balancing endpoint limits a request to about 5.5 minutes; a long fold may need the queue mode named in
  `docs/gpu-prover.md`.
