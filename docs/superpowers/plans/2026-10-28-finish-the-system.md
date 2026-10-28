# Finish the System Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Finish the bridge end to end: one gas-limit rule in every layer, a backend that gets proofs made and published, a dapp and a terminal program that can do every step themselves, three IPFS sites and a terminal program shipped through one signed release, and one end-to-end test over two local chains.

**Architecture:** Build on what exists. `explorer/shared` becomes the one home for logic that two or more of web, terminal, bots and backend use (msgboard, prover wrapper, proof check, operator actions, gas rule, history query). A new `explorer/backend` (Node, SQLite through the built-in `node:sqlite`, hono) holds every stateful service; `prover/` stays a stateless command that the backend and the terminal call. Sites build with relative paths; a release tool packs them as archive files (CAR), computes their content addresses (CID) offline, and signs `version.json` with WebCrypto Ed25519.

**Tech Stack:** Solidity 0.8.28 and Foundry; Rust (prover, `lc-core`); TypeScript on Node 24 or later and Bun 1.4.4; pnpm 12.6.0 workspace in `explorer/`; Ponder 0.17.10; hono 4.13.9; React 19, Chakra UI 3, Vite 8.3.1; vitest 4.1.11; Playwright 1.63.0.

**Spec:** `docs/superpowers/specs/2026-10-28-finish-the-system-design.md`. Executors read the spec section that each task names.

## Global Constraints

- No admin anywhere. No new trusted role. The backend holds no key that a contract trusts, and the proof publisher holds no wallet.
- Browser pages and static builds hold no secret. The existing `refuseSecretsPlugin` in `explorer/web/vite.config.ts` stays on, and every new Vite build uses it.
- Indexer first, RPC as fallback. The chain indexer stores only what lands on chain.
- The prover stays stateless: no database, no wallet, no queue inside `prover/`.
- Every new package is pinned exactly and was published on or before 2026-09-30 (28 days before 2026-10-28). `explorer/pnpm-workspace.yaml` keeps `minimumReleaseAge: 40320`. Prefer the platform: `node:sqlite`, WebCrypto Ed25519, `fetch`.
- Checked new packages (all versions verified with `npm view <package> time` on 2026-10-28): `@ipld/car` 5.4.7 (2026-07-30), `ipfs-unixfs-importer` 17.1.1 (2026-09-07), `ipfs-unixfs-exporter` 16.2.3 (2026-09-18), `multiformats` 14.0.5 (2026-07-23), `blockstore-core` 7.0.1 (2026-05-11). Reused, already in the lockfile: `hono` 4.13.9, `@hono/node-server` 1.19.5 (2025-09-29), `@msgboard/sdk` 0.4.0, `viem` 2.56.9, `zod` 4.6.5, `@playwright/test` 1.63.0. No other new package without the same check, written in the task's commit message.
- Only one task per phase changes `explorer/pnpm-lock.yaml`; those tasks are marked **[lockfile]**.
- Plain English in every user-facing text: no acronyms where a plain word exists. Never write an email address, a real name or a home directory path into any file, log line, request header or commit.
- Tip wording: a tip goes to the router's reward address, it is voluntary, and it buys no promise. No text ties a tip to the cost of proving or promises a service.
- After Task 9, no file names the project that Task 9 removes; `script/check-forbidden-names.sh` stays green.
- Any contract change is inside the audit scope: tests, the mutation list in its task, `script/coverage-check.sh` at 100 percent, and the gas tests.
- Every task keeps its package's coverage thresholds (100 percent lines, branches, functions, statements in shared, bots and web) and runs that package's full test command before its commit.
- Code style: no nested conditionals, no boolean parameters, no abbreviations, pure functions, TSDoc on every export.
- Commits: Conventional Commits, subject at most 50 characters, no AI attribution. Never commit `.serena/`.

## Review Focus

1. A dapp page loaded from an IPFS gateway calls the backend from another origin. The backend must answer `GET` and `POST /requests` with cross-origin headers, or every button fails silently. Test added to Task 15.
2. A user types an endpoint with a trailing slash, a path prefix, or plain `http` while the page is on `https`. The setting must normalize the slash, keep the prefix, and warn that the browser will block plain `http`. Test added to Task 10.
3. Two people press "request a proof" for the same direction at the same moment. Exactly one job must exist and both requests must point at it. Test added to Task 15.
4. A browser refuses local storage (private window) on the landing page. The page must still check the signature and say plainly that it cannot remember the sequence number, not crash or accept silently. Test added to Task 6.
5. The indexer returns a message with no gas limit (a row first seen from the destination side). The runner must skip it with a reason, never guess a limit. Test added to Task 12.

---

## Phases and the critical path

Tasks inside one phase touch disjoint files and run at once. A task starts when its phase starts and its hard dependencies are committed.

| Phase | Tasks | Hard dependencies |
|---|---|---|
| 1 | 1 gas trace, 2 adopt end-to-end folders, 3 mainnet block parser, 4 indexer additions, 5 terminal standalone build, 6 landing page | none |
| 2 | 7 shared msgboard and prover **[lockfile]**, 8 shared gas rule, 9 scrub, 10 dapp IPFS build and endpoints | 7 needs 2; 8 needs 1; 9 needs 2 and 3 |
| 3 | 11 contract gas rule, 12 bots gas and loss rule, 13 low tip range, 14 operator actions to shared, 15 backend core **[lockfile]**, 16 dapp history, 17 terminal local proving | 11 needs 1, 8, 9; 12 needs 7, 8; 13 needs 8; 15 needs 4, 7; 16 needs 4, 10; 17 needs 7 |
| 4 | 18 webhook and publisher, 19 msgboard indexer, 20 evidence archive, 21 dapp graphs, 22 docs review, 23 terminal reads | 18 to 20 need 15; 21 needs 13; 22 needs 9 and 11; 23 needs 4, 14, 15 |
| 5 | 24 dapp proof panel and write actions, 25 docs site **[lockfile]** | 24 needs 10, 14, 15; 25 needs 22 |
| 6 | 26 release pipeline **[lockfile]**, 27 run-it-yourself guide | 26 needs 5, 6, 10, 25; 27 needs 18, 19, 20 |
| 7 | 28 end-to-end test **[lockfile]** | all |

**Critical path for the end-to-end test:** 2, 7, 15, then 18, 19 and 20, then 24, 26, 28. Task 4 feeds 15 and must not slip.

---

### Task 1: Trace the gas limit through every layer (phase 1)

Spec section 0. Output is a finding and the exact failing tests; the fixes land in Tasks 8, 11, 12 and 13, which add these tests as their first step. Nothing red is committed to `main`.

**Files:**
- Create: `docs/gas-limits.md`

**Interfaces:**
- Produces: the table of layers and the failing test list below, which Tasks 8, 11, 12, 13 copy.

What the code does today (verify each line by reading the file and running the named test; correct the finding where the code says otherwise):

| Layer | Today | Rule holds? |
|---|---|---|
| Source bridge `MessageBridge._send` | refuses gas below `MIN_GAS_PER_CALL` (100) or above `MAX_GAS_PER_TX` (10,000,000) with `GasOutOfRange` | yes |
| Mediator `TokenMediator._chooseGasLimit` | uses the larger of the request and the kind default (`RELEASE_GAS_LIMIT` 250,000, plus `CALLBACK_GAS_LIMIT` 750,000 with a call, deploy rule `max(2,000,000, 1,300,000 + 1,600 × name and symbol bytes)`); refuses above `maxGasPerTx()` with `GasLimitAboveBridgeMaximum` | no: a low request is raised silently, not refused (`test_aRequestBelowTheDefaultGivesTheDefault` pins this) |
| Delivery `MessageBridge._callTarget` | requires `gasleft() >= gasLimit + gasLimit/63 + 1 + 100,000`, calls with exactly `gasLimit` | yes |
| Router `DeliveryRouter._callTarget` | the user call gets `gasleft() - CALL_GAS_RESERVE`, inside the mediator frame that the bridge capped at the message limit | holds only transitively; confirm with a test |
| Router tip measure | `startingGas - gasleft()` plus the call allowance; measures the gas the deliverer made available | not a limit question; no change |
| Bots `planBatches`, `evaluateBatch` | assume `executionGasFallback` (900,000) per item, never read `gasLimit`; an item larger than `maximumBatchGas` gets a batch alone; the transaction limit is cut to `maximumBatchGas` | no |
| Dapp and terminal forms | accept any whole number above zero; the note says the mediator uses the larger value; the cost estimate uses the indexer's measured gas, never the message limit | no |

- [ ] **Step 1: Write each failing test in a scratch copy, run it, record the red output in the finding, then discard the scratch change.** Tests:
  - `test/hardened/mediator/TokenMediatorGasLimit.t.sol::test_aRequestBelowTheDefaultIsRefused`: for a token whose copy exists (release kind), `relayTokens(token, receiver, 1 ether, 249_999)` reverts with `GasLimitBelowMinimum(249_999, 250_000)`.
  - `test/hardened/mediator/TokenMediatorGasLimit.t.sol::test_aRequestOfZeroGivesTheDefault`: the sent message carries `gasLimit == 250_000`.
  - `test/hardened/mediator/DeliveryRouterCall.t.sol::test_theUserCallNeverGetsMoreThanTheMessageGasLimit`: deliver with a transaction gas of 9,000,000 and a message limit of 1,000,000 to a target that records `gasleft()`; assert the recorded value is below 1,000,000.
  - `explorer/bots/test/unit/batch-plan.test.ts › "never packs an item whose required gas exceeds the batch maximum"`.
  - `explorer/shared/test/gas-limit.test.ts › "requiredDeliveryGas mirrors the bridge guard"`: `requiredDeliveryGas(1_000_000n) === 1_115_874n`.
- [ ] **Step 2: Write `docs/gas-limits.md`**: the table above as verified, the one rule in four lines (spec section 0), the test list with each red output line, and which task fixes each layer.
- [ ] **Step 3: Verify the tree is clean apart from the finding.** Run: `git status --short` — Expected: only `docs/gas-limits.md` new.
- [ ] **Step 4: Commit.** `git add docs/gas-limits.md && git commit -m "docs(gas): trace the gas limit through layers"`

---

### Task 2: Adopt the end-to-end folders (phase 1)

Spec "Calls I made: the end-to-end folders" and section 9 (the default backend). Read every file of `e2e/` and `explorer/e2e/` first.

**Files:**
- Modify: `e2e/run-all.sh`, `e2e/env.sh`, `e2e/deploy.sh`, `explorer/e2e/src/stages/bots.ts`, `explorer/e2e/src/context.ts`
- Commit as is after review: the rest of `e2e/`, `explorer/e2e/`
- Modify: `explorer/pnpm-workspace.yaml` (commit the pending `e2e` line; add `backend`, `docs`, `release`)
- Commit: the pending diffs of `explorer/pnpm-lock.yaml`, `.gitignore` (`e2e/state/`), `docs/bots.md` (two paragraphs from the end-to-end run)
- Modify: `docs/end-to-end-real-proofs.md`

**Interfaces:**
- Produces: `E2E_BACKEND` defaults to `oracle`; `remote` only when `RUNPOD_API_KEY` is set. The RunPod endpoint comes from `E2E_RUNPOD_URL` with no default in any file. Stage names stay: `open gate fund send-a deliver-a send-b deliver-b bots dashboards`.

- [ ] **Step 1: Write the failing test** `explorer/e2e/test/backend-choice.test.ts`:
  - `"chooses oracle when no RunPod key is set"`: `backendOf({}) === "oracle"`.
  - `"chooses remote when a RunPod key is set"`: `backendOf({ RUNPOD_API_KEY: "rpa_x", E2E_RUNPOD_URL: "https://example.invalid" }) === "remote"`.
  - `"refuses remote without an endpoint"`: `backendOf({ RUNPOD_API_KEY: "rpa_x" })` throws `/E2E_RUNPOD_URL/`.
- [ ] **Step 2: Run it.** `cd explorer/e2e && bun test test/backend-choice.test.ts` — Expected: FAIL, `backendOf` not exported.
- [ ] **Step 3: Implement `backendOf(environment: Readonly<Record<string, string | undefined>>): "oracle" | "remote"`** in `explorer/e2e/src/context.ts`; use it in `loadContext`. In `e2e/run-all.sh` drop the hard requirement of the key; in `e2e/env.sh` set `E2E_BACKEND` from the key's presence and remove the endpoint default. Remove the endpoint default from `stages/bots.ts`.
- [ ] **Step 4: Run.** `cd explorer/e2e && bun test && pnpm --filter @zk-bridge/e2e typecheck` — Expected: PASS.
- [ ] **Step 5: Run the oracle rehearsal once.** `E2E_STATE_DIR=$(mktemp -d) e2e/run-all.sh` — Expected: last line `all stages passed`.
- [ ] **Step 6: Commit.** `git add e2e explorer/e2e explorer/pnpm-workspace.yaml explorer/pnpm-lock.yaml .gitignore docs/bots.md docs/end-to-end-real-proofs.md && git commit -m "test(e2e): adopt the run, oracle by default"`

---

### Task 3: Read Ethereum mainnet blocks of Deneb, Electra and Fulu (phase 1)

Known issue 2.9. `lc-core` is compiled into the light-client guest, so the new parser sits behind the existing `json` feature (the prover enables it, the guests do not) and the program keys must stay identical.

**Files:**
- Modify: `light-client/crates/lc-core/src/ssz_state.rs` (add, behind `#[cfg(feature = "json")]`, `try_parse_signed_block_for_fork`)
- Modify: `prover/src/light_client.rs` (`BlockView::parse_for_chain`, `BlockView::parse`)
- Create: `prover/tests/fixtures/ethereum-mainnet-blocks/{deneb,electra,fulu}.ssz` and `.json` (header root, body root, execution block hash, slot)
- Create: `prover/tests/mainnet_blocks.rs`
- Modify: `docs/audit/known-issues.md` (2.9 marked fixed, with the slots used)

**Interfaces:**
- Produces: `pub fn try_parse_signed_block_for_fork(bytes: &[u8], fork: ForkName) -> Result<ParsedBlock>` in `lc-core` (`body_field_roots` has 11, 12 or 13 entries); `BlockView::parse_for_chain` accepts Capella, Deneb, Electra and Fulu and still refuses Gloas with the existing message.

Layouts to implement (from `ethereum/consensus-specs`): Deneb body adds `blob_kzg_commitments` (12 fields) and the payload header has 17 fields (`ExecutionHeaderForm::Deneb`); Electra and Fulu bodies add `execution_requests` (13 fields), and attestations and attester slashings use the Electra sizes. The execution payload stays body field 9 and the body tree depth stays 4.

- [ ] **Step 1: Fetch fixtures** from a public beacon node: `GET /eth/v2/beacon/blocks/<slot>` with `Accept: application/octet-stream`, and the same slot as JSON plus `GET /eth/v1/beacon/headers/<slot>`. One slot per fork: Deneb between 8,626,176 and 11,649,023, Electra between 11,649,024 and 13,164,543, Fulu from 13,164,544. Prefer blocks with transactions. Store the downloads in a fresh empty directory, check them, then copy. Send the neutral User-Agent `zk-bridge-fixture-fetch`.
- [ ] **Step 2: Write the failing tests** in `prover/tests/mainnet_blocks.rs`, one per fork:
  - `deneb_block_parses_to_the_node_header_root`: `BlockView::parse_for_chain(bytes, ChainKind::Ethereum)?.header.hash_tree_root() == fixture.header_root`, `payload.block_hash == fixture.execution_block_hash`, and `block_hash_branch` verifies from `block_hash` to `header.body_root` at `block_hash_gindex_for_fork(ForkName::Deneb)`.
  - `electra_block_parses_to_the_node_header_root`, `fulu_block_parses_to_the_node_header_root`: same three assertions.
  - `gloas_block_is_still_refused_on_this_path`: the existing Sepolia Gloas refusal message is unchanged.
  - `a_truncated_fulu_block_is_malformed`: the first 1,000 bytes give `Error::Malformed`.
- [ ] **Step 3: Run.** `cd prover && cargo test --test mainnet_blocks` — Expected: FAIL, "the block path reads Capella blocks only".
- [ ] **Step 4: Implement** `try_parse_signed_block_for_fork` and dispatch from `parse_for_chain` by fork; `BlockView::parse` takes the fork so the payload leaves use the right `ExecutionHeaderForm`.
- [ ] **Step 5: Run.** `cd prover && cargo test && cargo clippy --all-targets -- -D warnings` and `cd light-client && cargo test --workspace` — Expected: all pass.
- [ ] **Step 6: Prove the guests did not change.** `light-client/scripts/program-keys.sh` — Expected: exit 0, both ELF SHA-256 values and program keys equal `program-keys.json`.
- [ ] **Step 7: Check every new crate rule still holds.** `prover/scripts/check-crate-ages.sh` — Expected: no crate younger than the rule (no new crate is expected).
- [ ] **Step 8: Commit.** `git add light-client/crates/lc-core/src/ssz_state.rs prover/src/light_client.rs prover/tests docs/audit/known-issues.md && git commit -m "feat(prover): read Deneb, Electra and Fulu blocks"`

---

### Task 4: Indexer: the send's log index, the archive's work list, the history (phase 1)

Spec section 3. The archive and the dapp need the log index of the send; the indexer does not store it today.

**Files:**
- Modify: `explorer/indexer/ponder.schema.ts` (`messages.sentLogIndex: t.integer()`), `explorer/indexer/src/handlers/messages.ts`
- Create: `explorer/indexer/src/api/routes/undelivered.ts`, `explorer/indexer/src/api/routes/history.ts`
- Modify: `explorer/indexer/src/api/index.ts`
- Create: `explorer/shared/src/history-query.ts`; Modify: `explorer/shared/src/index.ts`, `explorer/shared/src/api-views.ts` (`sentLogIndex` in the feed item)
- Test: `explorer/indexer/test/unit/api-undelivered-route.test.ts`, `explorer/indexer/test/unit/api-history-route.test.ts`, `explorer/indexer/test/unit/handlers-messages.test.ts`, `explorer/shared/test/history-query.test.ts`

**Interfaces:**
- Produces: `GET /api/undelivered?direction=<src>><dst>&after=<sentTimestamp>:<messageId>&limit=<1..500>` → `{ items: { messageId: Hex; sourceChainId: number; destinationChainId: number; sentTransactionHash: Hex; sentLogIndex: number; gasLimit: number; coveredByHeadSlot: string }[]; nextCursor: string | null }`, oldest first, status `covered` only.
- Produces: `GET /api/history?...` with the feed filters plus `chain=<chainId>` and `eventKind=sent|delivered|head-update` → `{ items: HistoryEvent[]; nextCursor: string | null; partial: false }`, newest first.
- Produces (shared): `type HistoryEvent = { kind: "sent" | "delivered" | "head-update"; chainId: number; timestamp: bigint; transactionHash: Hex; messageId: Hex | null; slot: bigint | null; status: MessageStatus | null }`, `parseHistoryQuery(params: URLSearchParams): HistoryQueryResult`, `encodeHistoryCursor`, `parseHistoryEvents(body: unknown): { items: HistoryEvent[]; nextCursor: string | null; partial: boolean }`.

- [ ] **Step 1: Write the failing tests.**
  - handlers: `"stores the log index of the UserRequestForAffirmation log"`: after the send handler, `row.sentLogIndex === event.log.logIndex`.
  - undelivered: `"lists covered messages oldest first and leaves out delivered ones"`; `"pages with after and returns nextCursor only when more rows exist"`; `"refuses a limit of 501 with 400"`.
  - history: `"merges sent, delivered and head-update events newest first"`; `"filters by chain and eventKind"`; `"keeps the feed filters: address, status, from, to"`.
  - shared: `"parseHistoryQuery refuses an unknown eventKind"`; `"a cursor survives a round trip"`.
- [ ] **Step 2: Run.** `pnpm --filter @zk-bridge/indexer test:unit && pnpm --filter @zk-bridge/shared test:unit` — Expected: FAIL on the new tests.
- [ ] **Step 3: Implement** the column and handler write, `registerUndeliveredRoute(app: Hono): void`, `registerHistoryRoute(app: Hono): void` (a union of `messages` sends, `messages` deliveries and `head_updates`, sorted by `(timestamp, id)`), and the shared parser.
- [ ] **Step 4: Run.** `pnpm --filter @zk-bridge/indexer test && pnpm --filter @zk-bridge/indexer test:integration && pnpm --filter @zk-bridge/shared test` — Expected: PASS, coverage thresholds met.
- [ ] **Step 5: Commit.** `git add explorer/indexer explorer/shared/src/history-query.ts explorer/shared/src/index.ts explorer/shared/src/api-views.ts explorer/shared/test/history-query.test.ts && git commit -m "feat(indexer): log index, work list and history"`

---

### Task 5: Terminal standalone program (phase 1)

Spec section 5 "Standalone program" and "Build machines".

**Files:**
- Modify: `explorer/terminal/src/main.tsx` (handle `--version` and `--help` before the renderer starts)
- Create: `explorer/terminal/src/cli-arguments.ts`, `explorer/terminal/test/cli-arguments.test.ts`
- Create: `script/build-terminal.sh`
- Modify: `explorer/terminal/package.json` (script `build:standalone`)
- Create: `docs/terminal-program.md`

**Interfaces:**
- Produces: `script/build-terminal.sh <output-directory> [target...]` writes `zk-bridge-terminal-<os>-<arch>` per target (`bun-darwin-arm64 bun-darwin-x64 bun-linux-x64 bun-linux-arm64`, plus `bun-windows-x64` attempted) and prints one line per target: `ok <file>` or `skipped <target>: <reason>`. Exit 1 only when a native target fails.
- Produces: `parseCliArguments(argv: readonly string[]): { kind: "version" } | { kind: "help" } | { kind: "run" }`; `zk-bridge-terminal --version` prints `zk-bridge-terminal <package version> <commit>`; the commit is injected at build time with `--define`.

- [ ] **Step 1: Write the failing tests:** `"--version gives version"`, `"--help gives help"`, `"no argument runs the dashboard"`, `"an unknown flag gives help with exit code 2"`.
- [ ] **Step 2: Run.** `cd explorer/terminal && bun test test/cli-arguments.test.ts` — Expected: FAIL.
- [ ] **Step 3: Implement** `parseCliArguments` and the early exit in `main.tsx`; write the build script with `bun build --compile --minify --target=<target> --define BUILD_COMMIT=...`.
- [ ] **Step 4: Run the build on the development machine.** `script/build-terminal.sh "$(mktemp -d)"` — Expected: `ok` for every macOS and Linux target; the native binary prints its version with `--version`.
- [ ] **Step 5: Find out what each cross-built binary can do.** For each target, record whether the OpenTUI native library and the hardware wallet modules (`node-hid`, `usb`) are inside the binary. Write the result in `docs/terminal-program.md` as a table: target, starts, hardware wallets, secret store. Windows: say plainly if it does not build. Lead the page with building from source.
- [ ] **Step 6: Run.** `cd explorer/terminal && bun test && bun run typecheck` — Expected: PASS.
- [ ] **Step 7: Commit.** `git add explorer/terminal script/build-terminal.sh docs/terminal-program.md && git commit -m "build(terminal): standalone program per platform"`

---

### Task 6: Landing page (phase 1)

Spec section 7 and "Calls I made: trust does not come from the domain". No framework and no dependency: TypeScript run and tested by Node's type stripping and `node --test`, built by a script that uses `module.stripTypeScriptTypes`. The package is not part of the pnpm workspace.

**Files:**
- Create: `explorer/landing/package.json` (no dependencies; scripts `test`, `build`), `explorer/landing/index.html`, `explorer/landing/src/manifest.ts`, `explorer/landing/src/sequence-memory.ts`, `explorer/landing/src/page.ts`, `explorer/landing/scripts/build.ts`, `explorer/landing/landing.config.json` (manifest addresses and public keys, filled at build time)
- Test: `explorer/landing/test/manifest.test.ts`, `explorer/landing/test/sequence-memory.test.ts`, `explorer/landing/test/page.test.ts`

**Interfaces:**
- Produces (Task 26 imports `manifest.ts` by path):
  - `type ReleaseManifest = { schema: 1; sequence: number; channels: Record<string, string>; releases: ReleaseEntry[]; downloads: DownloadEntry[] }`
  - `type ReleaseEntry = { name: "dapp" | "docs" | "landing"; version: string; commit: string; cid: string; archiveSha256: string; publishedAt: string }`
  - `type DownloadEntry = { name: string; platform: string; file: string; sha256: string }`
  - `parseManifest(text: string): ReleaseManifest` (throws `ManifestError`)
  - `verifyManifestSignature(input: { manifestBytes: Uint8Array; signature: Uint8Array; publicKeys: readonly JsonWebKey[] }): Promise<boolean>` (WebCrypto `Ed25519`; true when any listed key verifies)
  - `canonicalManifestBytes(manifest: ReleaseManifest): Uint8Array` (keys sorted, no spaces, UTF-8)
- Produces: `rememberSequence(storage: Pick<Storage, "getItem" | "setItem"> | null, sequence: number): { kind: "accepted" } | { kind: "lower"; remembered: number } | { kind: "not-remembered" }`.
- Produces: `renderLanding(state: LandingState): string` (HTML text from data; every value escaped).

- [ ] **Step 1: Write the failing tests.**
  - manifest: `"accepts a manifest signed by a built-in key"`; `"refuses a manifest with one changed byte"`; `"refuses a signature by an unknown key"`; `"parseManifest refuses schema 2"`; `"canonical bytes do not depend on key order"`.
  - sequence: `"accepts the first sequence and stores it"`; `"refuses a lower sequence and names the remembered one"`; `"accepts an equal sequence"`; Review Focus 4: `"says not-remembered when storage throws, and still lets the signature check decide"` (a storage whose `getItem` throws).
  - page: `"a failed signature shows the warning and no link"` (`!html.includes("<a ")`); `"a good manifest shows the dapp and docs CIDs with at least three gateway links each, and every download with its SHA-256"`; `"escapes a version string holding <script>"`.
- [ ] **Step 2: Run.** `cd explorer/landing && node --test` — Expected: FAIL.
- [ ] **Step 3: Implement** the three modules and `index.html` with relative script paths; `scripts/build.ts` writes `dist/` with stripped JavaScript and `landing.config.json` baked in.
- [ ] **Step 4: Run.** `cd explorer/landing && node --test && node scripts/build.ts && ls dist` — Expected: PASS; `dist/index.html` references `./` paths only (`grep -c 'src="/' dist/index.html` prints `0`).
- [ ] **Step 5: Commit.** `git add explorer/landing && git commit -m "feat(landing): signed release page"`

---

### Task 7: Move msgboard, the prover wrapper and the proof check into shared (phase 2) [lockfile]

Spec sections 1 (publisher), 3b and 5. Node-only code goes behind subpath exports so the web bundle never loads it.

**Files:**
- Move: `explorer/bots/src/msgboard/*` → `explorer/shared/src/msgboard/` (board, grind, worker)
- Move: `explorer/bots/src/prover/*` → `explorer/shared/src/prover/` (command runner, packages, binary, config renderer)
- Move: `explorer/bots/src/runner/proof-intake.ts` → `explorer/shared/src/prover/proof-intake.ts`
- Create: `explorer/shared/src/msgboard/board-http.ts` (browser-safe read of `msgboard_content` over HTTP)
- Modify: `explorer/shared/package.json` (exports `./msgboard`, `./prover`, `./msgboard-http`; dependency `@msgboard/sdk` 0.4.0), every importer in `explorer/bots/src`
- Move the tests: `explorer/bots/test/unit/{board,grind,grind-job,execute-command,prover,prover-binary,proof-intake}.test.ts` → `explorer/shared/test/`

**Interfaces:**
- Produces from `@zk-bridge/shared/msgboard`: `createBoardPublisher`, `createBoardFeed`, `grindInWorker`, `BoardMessage`, `BoardFeed`, `BoardPublisher` (unchanged signatures).
- Produces from `@zk-bridge/shared/prover`: `createProverBinary`, `executeCommand`, `renderProverConfig`, `describeRoute`, `assessProofPayload`, `proofPackageSchema`, `evidencePackageSchema`; `BackendSection` gains `{ kind: "sp1"; lightClientElfPath: string; observationElfPath: string }`; `renderProverConfig(route, backend, handoff?: { webhookUrl: string; bearerVariable: string })` writes `targets = ["stdout", "webhook"]` when a handoff is given.
- Produces from `@zk-bridge/shared/msgboard-http`: `readBoardMessages(input: { boardUrl: string; category: Hex; fetchJson: JsonFetcher }): Promise<readonly BoardMessage[]>`.

- [ ] **Step 1: Write the failing tests** in `explorer/shared/test/`: `"renderProverConfig writes the webhook target and the bearer variable name, never a token"`; `"renderProverConfig writes the sp1 backend with both program file paths"`; `"readBoardMessages reads msgboard_content over HTTP and keeps only the category"`; `"the main entry imports no node: module"` (read `src/index.ts` import graph text and assert no `node:`).
- [ ] **Step 2: Run.** `pnpm --filter @zk-bridge/shared test:unit` — Expected: FAIL.
- [ ] **Step 3: Move the files with `git mv`, add the subpaths and the new functions, update the bots imports.** `pnpm install` once.
- [ ] **Step 4: Run.** `pnpm --filter @zk-bridge/shared test && pnpm --filter @zk-bridge/bots test && pnpm --filter @zk-bridge/bots test:integration && pnpm -r typecheck` — Expected: PASS, thresholds met.
- [ ] **Step 5: Commit.** `git add explorer && git commit -m "refactor(shared): host msgboard and prover code"`

---

### Task 8: One gas rule in shared (phase 2)

Spec section 0. The off-chain mirror of the contract rule, used by bots, web and terminal.

**Files:**
- Create: `explorer/shared/src/gas-limit.ts`; Modify: `explorer/shared/src/index.ts`
- Test: `explorer/shared/test/gas-limit.test.ts`

**Interfaces:**
- Produces:
  - constants `MIN_GAS_PER_CALL = 100n`, `MAX_GAS_PER_TX = 10_000_000n`, `EXECUTION_OVERHEAD_GAS = 100_000n`, `RELEASE_GAS_LIMIT = 250_000n`, `CALLBACK_GAS_LIMIT = 750_000n`, `DEPLOY_GAS_LIMIT = 2_000_000n`, `DEPLOY_GAS_BASE = 1_300_000n`, `DEPLOY_GAS_PER_BYTE = 1_600n`
  - `type MessageKind = { kind: "plain-message" } | { kind: "token-release"; withCall: boolean } | { kind: "token-deploy"; withCall: boolean; nameAndSymbolBytes: number }` (the boolean is a field of a data record, not a parameter)
  - `minimumGasLimitOf(kind: MessageKind): bigint`
  - `checkRequestedGasLimit(input: { kind: MessageKind; requested: bigint }): { ok: true; gasLimit: bigint } | { ok: false; reason: "below-minimum" | "above-maximum"; minimum: bigint; maximum: bigint }` (0 means the default)
  - `requiredDeliveryGas(messageGasLimit: bigint): bigint` = `limit + limit / 63n + 1n + EXECUTION_OVERHEAD_GAS`

- [ ] **Step 1: Write the failing tests:** `"requiredDeliveryGas mirrors the bridge guard"` (`1_000_000n → 1_115_874n`); `"a deploy with 500 bytes of name and symbol needs 2_100_000"` (`minimumGasLimitOf({ kind: "token-deploy", withCall: false, nameAndSymbolBytes: 500 }) === 2_100_000n`); `"zero gives the default"`; `"249_999 for a plain release is below-minimum with minimum 250_000"`; `"10_000_001 is above-maximum"`; `"the constants equal the Solidity source"` (read `src/hardened/mediator/TokenMediator.sol` and `src/hardened/MessageBridge.sol` as text and match each `constant NAME = value;`).
- [ ] **Step 2: Run.** `pnpm --filter @zk-bridge/shared test:unit -- gas-limit` — Expected: FAIL.
- [ ] **Step 3: Implement** the module.
- [ ] **Step 4: Run.** `pnpm --filter @zk-bridge/shared test` — Expected: PASS.
- [ ] **Step 5: Commit.** `git add explorer/shared && git commit -m "feat(shared): one gas limit rule"`

---

### Task 9: Remove every reference to a named outside project (phase 2)

Spec anti-goals and "Calls I made: outside project references". Content only. Reword each line to describe the behavior on its own terms; do not swap in another project's name. Contract changes are comments only; the struct name `FeeDirector` and every identifier stay.

**Files:** find them with `script/check-forbidden-names.sh`. Today: `src/hardened/mediator/DeliveryRouter.sol`, `test/hardened/mediator/DeliveryRouter.t.sol`, `explorer/shared/src/delivery-terms.ts`, `docs/hardened-build-contract.md`, `docs/audit/known-issues.md`, `docs/bots.md`, `docs/pulsechain-amb-review.md`, `docs/testnet-run.md`, plus the spec and this plan, whose mentions go last.

**Interfaces:** none.

- [ ] **Step 1: Write the gate** `script/check-forbidden-names.sh`: exits 1 and prints file and line when a tracked file names the removed project (`progress.txt` excluded).
- [ ] **Step 2: Run it.** Expected: FAIL with about 35 lines.
- [ ] **Step 3: Reword every line.** Example: "the router pattern of the outside project" becomes "a router that delivers a bridged message and pays a tip from it". Rename the test claim at `DeliveryRouter.t.sol:418` to describe the flag bits.
- [ ] **Step 4: Run the gate.** `script/check-forbidden-names.sh` — Expected: exit 0, no output.
- [ ] **Step 5: Run the full contract gate, because the metadata hash changed.** `forge test && script/coverage-check.sh` — Expected: every test passes; 100 percent lines, branches and functions; the thirteen optimizer tests pass.
- [ ] **Step 6: Run.** `pnpm --filter @zk-bridge/shared test` — Expected: PASS.
- [ ] **Step 7: Commit.** `git add -A src test explorer/shared/src/delivery-terms.ts docs script/check-forbidden-names.sh && git commit -m "docs: describe the router on its own terms"`

---

### Task 10: Dapp from IPFS, and every endpoint configurable (phase 2)

Spec section 4 "IPFS loading" and "Endpoints".

**Files:**
- Modify: `explorer/web/vite.config.ts` (`base: './'`), `explorer/web/index.html` (relative script path)
- Modify: `explorer/shared/src/connection-settings.ts` (new settings), `explorer/web/src/config/environment.ts` (variables), `explorer/web/src/config/connection-storage.ts`, `explorer/web/src/views/ConnectionsView.tsx`
- Test: `explorer/shared/test/connection-settings.test.ts`, `explorer/web/test/config/environment.test.ts`, `explorer/web/test/views/connections-view.test.tsx`, `explorer/web/e2e/path-prefix.spec.ts`

**Interfaces:**
- Produces: `ConnectionSettings` gains `backendUrl`, `msgboardIndexerUrl`, `archiveUrl`, `msgboardUrl` (each `string | null`), resolved with the same `user > environment > default` rule; `VARIABLES` gains `VITE_EXPLORER_BACKEND_URL`, `VITE_EXPLORER_MSGBOARD_INDEXER_URL`, `VITE_EXPLORER_ARCHIVE_URL`, `VITE_EXPLORER_MSGBOARD_URL`.
- Produces: `normalizeEndpoint(input: { text: string; pageProtocol: "https:" | "http:" }): { ok: true; url: string; warning: "insecure-on-secure-page" | null } | { ok: false; reason: string }`.

- [ ] **Step 1: Write the failing tests.**
  - shared: `"resolves the backend URL from the user, then the environment, then the default"` (same for the other three).
  - Review Focus 2: `"normalizeEndpoint drops one trailing slash and keeps a path prefix"` (`"https://x.example/api/" → "https://x.example/api"`); `"warns for http on an https page"`; `"refuses a URL with credentials"`.
  - web: `"the settings view saves and clears each new endpoint"`.
  - Playwright `path-prefix.spec.ts`: serve `dist/` under `/ipfs/bafytest/` with a static server; `"the dapp loads, routes by hash and shows no failed asset request"`.
- [ ] **Step 2: Run.** `pnpm --filter @zk-bridge/shared test:unit && pnpm --filter @zk-bridge/web test:unit` — Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run.** `pnpm --filter @zk-bridge/shared test && pnpm --filter @zk-bridge/web test && pnpm --filter @zk-bridge/web build && pnpm --filter @zk-bridge/web e2e` — Expected: PASS; `grep -c '"/assets' explorer/web/dist/index.html` prints `0`.
- [ ] **Step 5: Commit.** `git add explorer/shared explorer/web && git commit -m "feat(web): load from IPFS, configure endpoints"`

---

### Task 11: The contract gas rule (phase 3)

Spec section 0. Inside the audit scope. Read `docs/gas-limits.md` (Task 1) first; if it found more contract gaps, add them here with their tests.

**Files:**
- Modify: `src/hardened/mediator/TokenMediator.sol` (`_chooseGasLimit`, new error, NatSpec), `src/hardened/mediator/DeliveryRouter.sol` (comment line on "the larger of the request and its default")
- Modify: `test/hardened/mediator/TokenMediatorGasLimit.t.sol` (replace `test_aRequestBelowTheDefaultGivesTheDefault`), `test/hardened/mediator/DeliveryRouterCall.t.sol`, `test/hardened/mediator/TokenMediatorFuzz.t.sol`
- Modify: `docs/hardened-build-contract.md` (gas section), `docs/audit/invariants.md` (the rule as an invariant)
- Modify: `explorer/terminal/src/tx/plan.ts` (`GAS_LIMIT_NOTE`, check with `checkRequestedGasLimit`), `explorer/web/src/tx/bridge-steps.ts` (`parseGasLimitText` checks the minimum and maximum of the kind)
- Test: `explorer/terminal/test/tx/plan.test.ts`, `explorer/web/test/tx/bridge-steps.test.ts`

**Interfaces:**
- Consumes: `checkRequestedGasLimit`, `minimumGasLimitOf` (Task 8).
- Produces: `error GasLimitBelowMinimum(uint256 gasLimit, uint256 minimum)` in `TokenMediator`. Rule: a request of 0 means the kind default; a request above 0 and below the default reverts; a request above `maxGasPerTx()` reverts as today.

- [ ] **Step 1: Write the failing tests** from `docs/gas-limits.md`: `test_aRequestBelowTheDefaultIsRefused`, `test_aRequestOfZeroGivesTheDefault`, `test_aRequestAtTheDefaultIsAccepted` (request 250,000 sends 250,000), `test_aDeployRequestBelowTheNameRuleIsRefused` (name and symbol of 500 bytes, request 2,000,000, expects `GasLimitBelowMinimum(2_000_000, 2_100_000)`), `test_theUserCallNeverGetsMoreThanTheMessageGasLimit`, and fuzz `testFuzz_everySentLimitIsAtLeastTheKindMinimumAndAtMostTheMaximum`. Off chain: terminal `"plan refuses a gas limit below the default of the kind"`; web `"the bridge form refuses 249999 for a plain release"`.
- [ ] **Step 2: Run.** `forge test --match-path 'test/hardened/mediator/*GasLimit*' -vv` — Expected: FAIL on `test_aRequestBelowTheDefaultIsRefused`.
- [ ] **Step 3: Implement** the revert in `_chooseGasLimit`; update the NatSpec and both docs; update the two forms and the note text ("The gas limit must be at least the default for this kind of message and at most the bridge maximum. Leave it empty for the default.").
- [ ] **Step 4: Run the mutation list.** For each mutation, apply it, run the named tests, confirm red, revert: M-G1 remove the new revert (`test_aRequestBelowTheDefaultIsRefused`); M-G2 `requested < minimum` becomes `requested <= minimum` (`test_aRequestAtTheDefaultIsAccepted` turns red); M-G3 drop the zero case (`test_aRequestOfZeroGivesTheDefault`); M-G4 skip the deploy rule in the minimum (`test_aDeployRequestBelowTheNameRuleIsRefused`). Record the results in `docs/gas-limits.md`.
- [ ] **Step 5: Run the full gate.** `forge test && script/coverage-check.sh` — Expected: all pass, 100 percent, the gas tests pass.
- [ ] **Step 6: Run.** `cd explorer/terminal && bun test` and `pnpm --filter @zk-bridge/web test` — Expected: PASS.
- [ ] **Step 7: Commit.** `git add src test docs explorer/terminal explorer/web && git commit -m "fix(mediator): refuse a gas limit below its kind"`

---

### Task 12: Bots: pack by the message's limit, and the 20 percent loss rule (phase 3)

Spec section 0 and section 3b, "Decided by the owner: tips may be below cost".

**Files:**
- Modify: `explorer/bots/src/runner/batch-plan.ts`, `fee.ts`, `delivery.ts`, `batch.ts`, `explorer/bots/src/config/bot-config.ts`, `explorer/bots/src/indexer/client.ts` (`gasLimit` nullable)
- Modify: `docs/bots.md` (packing and loss rule)
- Test: `explorer/bots/test/unit/batch-plan.test.ts`, `fee.test.ts`, `runner.test.ts`, `batch-sending.test.ts`, `foundation.test.ts` (configuration)

**Interfaces:**
- Consumes: `requiredDeliveryGas` (Task 8); `@zk-bridge/shared/prover` (Task 7).
- Produces: `planBatches<Item extends { assumedGas: bigint }>(items, limits): { batches: Item[][]; oversize: Item[] }`; `assumedGas = requiredDeliveryGas(item.gasLimit) + settings.proofCheckGas`.
- Produces: `decideDelivery(input: { feeWei: bigint; costWei: bigint; maximumLossPercent: number }): { deliver: true; costWei: bigint; lossWei: bigint } | { deliver: false; costWei: bigint; lossWei: bigint }`. Deliver when `(costWei - feeWei) * 100 < maximumLossPercent * costWei`.
- Configuration: `runner.maximumLossPercent` (integer 0 to 100, default 20) replaces `runner.minimumMarginWei`; `runner.proofCheckGas` (default 400,000; measured 290,655 in `MessageBridgeGas.t.sol` plus the router entry) replaces `runner.executionGasFallback`. A configuration that still names a removed key is refused with a message naming the replacement.
- New skip reasons: `loss-at-or-above-limit` (replaces `fee-below-cost-plus-margin`), `message-gas-above-batch-maximum`, `gas-limit-unknown`.

- [ ] **Step 1: Write the failing tests.**
  - batch-plan: `"never packs an item whose required gas exceeds the batch maximum"` (it lands in `oversize`); `"the sum of assumed gas in a batch never passes maximumBatchGas"`.
  - fee: cost 1,000 wei: fee 801 delivers; fee 800 is left out (exactly 20 percent); fee 0 left out; fee 1,200 delivers with `lossWei === -200n`; `maximumLossPercent` 0 means the fee must cover the cost.
  - runner: `"each item's cost includes its share of the update, split by gas"`; `"a left-out item stays deliverable: the runner sends nothing for it and logs loss-at-or-above-limit"`; `"the transaction gas limit is at least the sum of required delivery gas of its items"`.
  - Review Focus 5: `"a feed item with a null gasLimit is skipped with gas-limit-unknown"`.
  - configuration: `"refuses minimumMarginWei and names maximumLossPercent"`.
- [ ] **Step 2: Run.** `pnpm --filter @zk-bridge/bots test:unit` — Expected: FAIL.
- [ ] **Step 3: Implement.** In `evaluateBatch`, drop the cap that cut the limit to `maximumBatchGas`; the planner already keeps the sum under it. Replace `unpaidUpdateOf` with the per-item share rule and drop items whose loss reaches the limit, then simulate again (the existing rounds).
- [ ] **Step 4: Run.** `pnpm --filter @zk-bridge/bots test && pnpm --filter @zk-bridge/bots test:integration` — Expected: PASS, thresholds met.
- [ ] **Step 5: Commit.** `git add explorer/bots docs/bots.md && git commit -m "feat(bots): pack by message gas, 20% loss rule"`

---

### Task 13: A low tip range, with no proof cost in it (phase 3)

Spec section 4 "Tips" and the anti-goal on tip wording. Today the suggestions add a share of the proof cost (`DEFAULT_PROOF_COST_USD`, report `proofCost`), and the fees help page explains it; that ties a tip to proving, so it goes.

**Files:**
- Modify: `explorer/shared/src/default-tip.ts`, `delivery-suggestion.ts`, `delivery-fee.ts` (delete `proofCostWei`, `DEFAULT_PROOF_COST_USD`), `delivery-cost-report.ts` (delete `proofCost`), `delivery-cost-settings.ts`, `tip-copy.ts`
- Modify: `explorer/indexer/src/api/routes/delivery-cost.ts`
- Modify: `explorer/terminal/src/ui/delivery-fee-lines.ts`, `explorer/terminal/src/app/delivery-fee-form.ts`, `explorer/terminal/src/data/fixtures.ts`
- Modify: `explorer/web/src/actions/DeliveryFeeSection.tsx`, `explorer/web/docs/pages/05-fees-explained.md`
- Test: the matching tests in each package

**Interfaces:**
- Consumes: `minimumGasLimitOf` (Task 8) for the cost line of the kind.
- Produces: `DEFAULT_GAS_MARGIN = RATE_SCALE` (1.0); `SUGGESTED_TIP_RANGE = { low: RATE_SCALE / 2n, high: (RATE_SCALE * 3n) / 2n }` (0.5 to 1.5 times the measured delivery gas cost at the base fee); `suggestedTipRange(input: BuildFeeSuggestionsInput): { low: FeeDirector; default: FeeDirector; high: FeeDirector }`. The user may set any tip from zero up; no floor.
- Produces: `DeliveryCostReport` without `proofCost`; `BuildFeeSuggestionsInput` without proof fields.

- [ ] **Step 1: Write the failing tests:** shared `"the default tip equals the measured gas cost at the base fee, with no proof share"`; `"the range is half to one and a half times the cost"`; `"a tip of zero is allowed and described as below cost"`; `"no tip text mentions proof, prover, proving or graphics"` (scan every exported string of `tip-copy.ts`); indexer `"the delivery cost report has no proofCost field"`; web `"the fee section shows the range as low, suggested and high, editable"`.
- [ ] **Step 2: Run.** `pnpm --filter @zk-bridge/shared test:unit` — Expected: FAIL.
- [ ] **Step 3: Implement**, delete the proof cost code, rewrite the fees help page section in plain words (a tip goes to the reward address, it is voluntary, it buys no promise, a low tip never makes a delivery fail).
- [ ] **Step 4: Run.** `pnpm --filter @zk-bridge/shared test && pnpm --filter @zk-bridge/indexer test && pnpm --filter @zk-bridge/web test && (cd explorer/terminal && bun test)` — Expected: PASS.
- [ ] **Step 5: Commit.** `git add explorer && git commit -m "feat(tip): a low range with no proof share"`

---

### Task 14: Operator actions in shared (phase 3)

Spec section 4 "Write actions". The terminal keeps a thin adapter. (The web already imports terminal source through the `@terminal` alias; that alias stays for now and is flagged for cleanup.)

**Files:**
- Create: `explorer/shared/src/operator.ts`; Modify: `explorer/shared/src/index.ts`
- Modify: `explorer/terminal/src/tx/operator.ts` (adapter only)
- Move: `explorer/terminal/test/tx/operator.test.ts` cases into `explorer/shared/test/operator.test.ts`; keep adapter tests in the terminal file

**Interfaces:**
- Produces:
  - `type OperatorChain = { chainId: number; name: string; lightClient: Address; messageBridge: Address }`
  - `type OperatorCall = { title: string; chainId: number; to: Address; functionName: "update" | "executeMessage" | string; functionSignature: string; data: Hex; arguments: readonly { name: string; type: string; value: string }[]; notes: readonly string[] }`
  - `planUpdateFromHandoff(text: string, chains: readonly OperatorChain[]): OperatorCall`
  - `planUpdateFromProofMessage(message: ProofMessage, chain: OperatorChain): OperatorCall`
  - `planMessageExecution(text: string, chains: readonly OperatorChain[]): { summary: EvidenceSummary; steps: readonly { call: OperatorCall; role: "prerequisite" | "execute"; reason: string | null }[] }`
  - `OperatorFileError`, `encodeUpdateCalldata` (moved)

- [ ] **Step 1: Write the failing test** `"planUpdateFromProofMessage builds update(proof, publicValues) at the chain's light client"`, plus the moved handoff and evidence cases.
- [ ] **Step 2: Run.** `pnpm --filter @zk-bridge/shared test:unit -- operator` — Expected: FAIL.
- [ ] **Step 3: Implement**; the terminal adapter maps `OperatorCall` to `PlannedTransaction` by chain id.
- [ ] **Step 4: Run.** `pnpm --filter @zk-bridge/shared test && (cd explorer/terminal && bun test)` — Expected: PASS; the terminal snapshot tests unchanged.
- [ ] **Step 5: Commit.** `git add explorer/shared explorer/terminal && git commit -m "refactor(shared): host the operator actions"`

---

### Task 15: Backend core: storage, request service, health, client (phase 3) [lockfile]

Spec section 1. One package, four modules, each able to run alone. This task builds the package, storage, the request service and health, and stub modules that Tasks 18 to 20 replace (each owns one file).

**Files:**
- Create: `explorer/backend/package.json` (Node `>=24`; dependencies `@zk-bridge/shared` workspace, `hono` 4.13.9, `@hono/node-server` 1.19.5, `viem` 2.56.9, `zod` 4.6.5), `tsconfig.json`, `vitest.config.ts` (thresholds 100)
- Create: `explorer/backend/src/config.ts`, `src/storage.ts`, `src/app.ts`, `src/main.ts`, `src/requests/service.ts`, `src/requests/jobs.ts`, `src/requests/rate-limit.ts`, `src/health.ts`
- Create stubs: `src/webhook/module.ts`, `src/msgboard-indexer/module.ts`, `src/archive/module.ts` (each `register(app, context)` answering 503 `{ error: "module not built" }`)
- Create: `explorer/shared/src/backend-client.ts`; Modify: `explorer/shared/src/index.ts`
- Create: `explorer/backend/backend.config.example.json`
- Test: `explorer/backend/test/*.test.ts`, `explorer/shared/test/backend-client.test.ts`

**Interfaces:**
- Consumes: `createProverBinary`, `renderProverConfig` with handoff (Task 7); `GET /api/undelivered` (Task 4).
- Produces:
  - `openStorage(path: string): Storage` over `node:sqlite` `DatabaseSync`, one file; tables `jobs`, `requests`, `proofs`, `evidence`; `Storage.close(): void`.
  - `type JobStatus = "queued" | "proving" | "published" | "on-chain" | "failed"`; `type Job = { id: string; direction: ProofDirection; status: JobStatus; createdAt: number; updatedAt: number; startSlot: string | null; newSlot: string | null; error: string | null }`.
  - `createRequestService(input: { storage: Storage; prover: ProverBinary; now: () => number; limits: RateLimits }): RequestService` with `submit(request: { pair: string; direction: ProofDirection; reason: "message" | "keep-alive" | "user"; messageId?: Hex; caller: string }): { requestId: string; jobId: string } | { refused: "rate-limited"; retryAfterSeconds: number }`.
  - Routes: `POST /requests`, `GET /requests/:id`, `GET /directions/:direction`, `GET /health`.
  - `type BackendModuleContext = { storage: Storage; config: BackendConfig; prover: ProverBinary; now: () => number; logger: Logger }`; each module exports `register(app: Hono, context: BackendModuleContext): void` and `start(context): Promise<() => Promise<void>>`.
  - `main.ts --modules requests,webhook,msgboard-indexer,archive` starts any subset.
  - Shared client: `createBackendClient(input: { baseUrl: string; fetchJson: JsonFetcher; postJson: JsonPoster }): { requestProof(...); requestStatus(id); directionStatus(direction); latestProof(direction); evidence(messageId); health() }`, each answer parsed with zod.
  - Configuration names environment variables for secrets (`webhookBearerVariable`, `runpodApiKeyVariable`); no secret in the file.

- [ ] **Step 1: Write the failing tests.**
  - `"two requests for the same direction coalesce into one job"`; Review Focus 3: `"twenty concurrent POST /requests for one direction create exactly one job"` (`Promise.all`, then `SELECT count(*) FROM jobs` is 1 and all request rows name it).
  - `"a finished job lets the next request start a new job"`; `"a job proves from the on-chain head: the prover runs with no explicit head"`.
  - `"the job runs prove with a webhook to /webhook/jobs/<id> and the bearer variable name only"` (assert the rendered file has no token value).
  - `"rate limits per caller and per direction answer 429 with Retry-After"`.
  - Review Focus 1: `"answers GET and POST /requests from another origin with Access-Control-Allow-Origin *, and OPTIONS with the allowed methods"`.
  - `"GET /health reports each module, the queue length and the last job per direction"`; `"a stub module answers 503"`.
  - `"a restart keeps queued and proving jobs; a proving job older than the prover timeout becomes failed"`.
  - client: `"latestProof parses the proof answer and refuses a malformed one"`.
- [ ] **Step 2: Run.** `pnpm install && pnpm --filter @zk-bridge/backend test` — Expected: FAIL.
- [ ] **Step 3: Implement.** Retry and backoff: a failed job is not retried by itself; the next request starts a new job after 60 seconds. Rate limits: 10 requests per caller per minute, 1 new job per direction per 2 minutes (both in the configuration). The caller key is the socket address, or the first `X-Forwarded-For` entry when `trustForwardedHeader` is on.
- [ ] **Step 4: Run.** `pnpm --filter @zk-bridge/backend test && pnpm --filter @zk-bridge/backend typecheck && pnpm --filter @zk-bridge/shared test` — Expected: PASS, thresholds met.
- [ ] **Step 5: Commit.** `git add explorer/backend explorer/shared explorer/pnpm-lock.yaml && git commit -m "feat(backend): requests, storage and health"`

---

### Task 16: Dapp history explorer (phase 3)

Spec section 4 "History explorer".

**Files:**
- Create: `explorer/web/src/views/HistoryView.tsx`, `explorer/web/src/views/history-model.ts`
- Modify: `explorer/web/src/app/route.ts` (`{ name: "history"; filters: HistoryFilters }`), `explorer/web/src/app/Shell.tsx`
- Create: `explorer/shared/src/rpc/history-scan.ts`
- Test: `explorer/web/test/views/history-view.test.tsx`, `explorer/web/test/app/route.test.ts`, `explorer/shared/test/rpc-history-scan.test.ts`

**Interfaces:**
- Consumes: `parseHistoryEvents`, `GET /api/history` (Task 4); the connection's fallback (`createExplorerConnection`).
- Produces: `scanHistory(input: { pair: Pair; readers: ReadonlyMap<number, ChainReader>; fromBlock: bigint }): Promise<{ items: HistoryEvent[]; partial: true }>`.

- [ ] **Step 1: Write the failing tests:** `"#/history?chain=369&eventKind=sent round-trips"`; `"the view lists events with links to the message page"`; `"filters by pair, chain, kind, address, status and time"`; `"next page uses nextCursor"`; `"with the indexer down the view shows RPC events and the words Partial history"`.
- [ ] **Step 2: Run.** `pnpm --filter @zk-bridge/web test:unit` — Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run.** `pnpm --filter @zk-bridge/web test && pnpm --filter @zk-bridge/shared test` — Expected: PASS.
- [ ] **Step 5: Commit.** `git add explorer/web explorer/shared && git commit -m "feat(web): history explorer"`

---

### Task 17: Terminal local proving (phase 3)

Spec section 5 "Local proving" and "Known risks".

**Files:**
- Create: `explorer/terminal/src/prove/local-prover.ts`, `explorer/terminal/src/prove/progress.ts`, `explorer/terminal/src/ui/prove-view.tsx`
- Modify: `explorer/terminal/src/app/App.tsx` (register the view)
- Create: `docs/local-proving.md`
- Test: `explorer/terminal/test/prove/local-prover.test.ts`, `explorer/terminal/test/prove/progress.test.ts`

**Interfaces:**
- Consumes: `createProverBinary`, `renderProverConfig` with `{ kind: "sp1", lightClientElfPath, observationElfPath }` (Task 7); `planUpdateFromHandoff` (Task 14).
- Produces: `locateBundledProver(input: { executablePath: string; exists: (path: string) => boolean }): { prover: string; lightClientElf: string; observationElf: string } | { missing: string[] }` (files next to the terminal program: `zk-bridge-prover`, `light-client.elf`, `fork-observation.elf`).
- Produces: `parseProgressLine(line: string): ProgressEvent | null` for the prover's standard error lines.

- [ ] **Step 1: Write the failing tests:** `"finds the prover and both program files next to the executable"`; `"names every missing file"`; `"a progress line becomes a step with its elapsed seconds"`; `"a finished proof offers the update transaction"` (fake prover from `explorer/bots/test/support/fake-prover.mjs`, moved by Task 7 to shared test support if it moved).
- [ ] **Step 2: Run.** `cd explorer/terminal && bun test test/prove` — Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Find out what a user needs.** Build `cd prover && cargo build --release --no-default-features --features sp1` and run one local `prove` with the `sp1` backend against the end-to-end chains. Check whether SP1's Groth16 wrap needs Docker in this build, and whether a native wrap feature exists in the pinned SP1. Write `docs/local-proving.md`: memory (at least 16 gigabytes), Docker yes or no, expected minutes, and what the terminal shows when a need is missing.
- [ ] **Step 5: Run.** `cd explorer/terminal && bun test && bun run typecheck` — Expected: PASS.
- [ ] **Step 6: Commit.** `git add explorer/terminal docs/local-proving.md && git commit -m "feat(terminal): prove on the local processor"`

---

### Task 18: Backend webhook receiver and publisher (phase 4)

Spec section 1 "Webhook receiver" and "Publisher".

**Files:**
- Modify: `explorer/backend/src/webhook/module.ts`; Create: `explorer/backend/src/webhook/receive.ts`, `explorer/backend/src/webhook/publish.ts`
- Test: `explorer/backend/test/webhook.test.ts`

**Interfaces:**
- Consumes: `assessProofPayload`, `proofPackageSchema` from `@zk-bridge/shared/prover`; `createBoardPublisher`, `grindInWorker` from `@zk-bridge/shared/msgboard`; `encodeProofMessage`, `proofCategory` from shared.
- Produces: `POST /webhook/jobs/:jobId` (bearer token from the variable that the configuration names, compared in constant time); job moves to `published` after the post; to `on-chain` when a later head read shows the light client at or past `newSlot`.

- [ ] **Step 1: Write the failing tests:** `"refuses a missing or wrong bearer token with 401 and stores nothing"`; `"refuses a package for a job that is not proving"`; `"refuses a proof that does not verify and marks the job failed with the reason"`; `"posts a verified proof to the job's category and marks the job published"`; `"a board error leaves the proof stored and retries on the next tick"`; `"marks the job on-chain when the head reaches newSlot"`.
- [ ] **Step 2: Run.** `pnpm --filter @zk-bridge/backend test -- webhook` — Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run.** `pnpm --filter @zk-bridge/backend test` — Expected: PASS.
- [ ] **Step 5: Commit.** `git add explorer/backend && git commit -m "feat(backend): receive, check and publish proofs"`

---

### Task 19: Backend msgboard indexer (phase 4)

Spec section 2.

**Files:**
- Modify: `explorer/backend/src/msgboard-indexer/module.ts`; Create: `explorer/backend/src/msgboard-indexer/latest-proof.ts`
- Test: `explorer/backend/test/msgboard-indexer.test.ts`

**Interfaces:**
- Consumes: `createBoardFeed` (Task 7), `assessProofPayload` (Task 7), a light-client reader with a 12-second cache.
- Produces: `GET /proofs/latest/:direction` → `200 { pair, direction, startSlot, newSlot, payload: Hex, receivedAt }` or `404 { error: "no usable proof" }`. `chooseLatest(current: StoredProof | null, candidate: ProofMessage, head: StoredHead): StoredProof | null` keeps the proof with the highest `newSlot` that starts at the current head.

- [ ] **Step 1: Write the failing tests:** `"keeps the proof that starts at the head and reaches furthest"`; `"refuses a proof that fails the check"`; `"serves the proof after the board dropped it, from SQLite after a restart"`; `"answers 404 once the head moved past the proof's start"` (never stale); `"subscribes again after a socket close and reads recent messages"`.
- [ ] **Step 2: Run.** `pnpm --filter @zk-bridge/backend test -- msgboard-indexer` — Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run.** `pnpm --filter @zk-bridge/backend test` — Expected: PASS.
- [ ] **Step 5: Commit.** `git add explorer/backend && git commit -m "feat(backend): msgboard indexer"`

---

### Task 20: Backend evidence archive (phase 4)

Spec section 1 "Evidence archive". The prover keeps no era data of its own. The light client keeps every stored header (`headers` mapping), so evidence anchored at a stored header stays valid; the archive keeps that evidence and rebuilds it with `--anchor-slot` only when the bridge answers `AnchorNotStored`.

**Files:**
- Modify: `explorer/backend/src/archive/module.ts`; Create: `explorer/backend/src/archive/work-list.ts`, `explorer/backend/src/archive/build.ts`
- Test: `explorer/backend/test/archive.test.ts`

**Interfaces:**
- Consumes: `GET /api/undelivered`, `GET /api/messages/:id` (Task 4); `ProverBinary.evidence` (Task 7).
- Produces: `GET /evidence/:messageId` → `200` with the prover's evidence JSON as printed (schema version 2), or `404`; an entry is dropped when the indexer shows `delivered`, `failed_call` or `release_failed`.

- [ ] **Step 1: Write the failing tests:** `"builds evidence for each covered message from its transaction hash and log index"`; `"serves the stored evidence unchanged"`; `"drops the entry once the indexer shows the message delivered"`; `"keeps an entry and retries later when the prover fails"`; `"an Ethereum-sourced message records the prover's refusal and retries after the next head"`.
- [ ] **Step 2: Run.** `pnpm --filter @zk-bridge/backend test -- archive` — Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run.** `pnpm --filter @zk-bridge/backend test` — Expected: PASS.
- [ ] **Step 5: Commit.** `git add explorer/backend && git commit -m "feat(backend): evidence archive"`

---

### Task 21: Dapp graphs of delivery cost and tip against the base fee (phase 4)

Spec "Decided by the owner": two line graphs before the user sends. Follow the dataviz method: one y axis per chart, both charts share the same x and y scales (small multiples), 2-pixel lines, a crosshair tooltip, a table view, a selected dark mode, and the palette checked with the dataviz validator script. No new dependency: inline SVG.

**Files:**
- Create: `explorer/shared/src/tip-coverage.ts`; Modify: `explorer/shared/src/index.ts`
- Create: `explorer/web/src/actions/TipCostCharts.tsx`, `explorer/web/src/actions/tip-cost-chart-model.ts`
- Modify: `explorer/web/src/actions/DeliveryFeeSection.tsx`
- Test: `explorer/shared/test/tip-coverage.test.ts`, `explorer/web/test/actions/tip-cost-charts.test.tsx`

**Interfaces:**
- Consumes: `suggestedTipRange`, `expectedFee` (Task 13), `minimumGasLimitOf` (Task 8).
- Produces: `tipCoverage(input: { director: FeeDirector; deliveryGas: bigint; priorityFeeWei: bigint; baseFeeNowWei: bigint; transferValue: bigint; price: TokenPrice; points: number }): { points: { baseFeeWei: bigint; costWei: bigint; tipWei: bigint }[]; coveredUpToBaseFeeWei: bigint | null; coveredEverywhere: boolean }` over base fees from 0 to 4 times now.
- Produces: `coverageSentence(result, chainName): string`, for example "Your tip covers the delivery cost while the base fee stays under 31 gwei. Above that, a deliverer loses money on it, and the message may wait. Anyone can still deliver it."

- [ ] **Step 1: Write the failing tests:** shared `"a gas based tip stops covering at the ceiling base fee"`; `"a fixed tip crosses the cost line at tip / gas"`; `"a zero tip covers nowhere"`; `"a tip above cost everywhere says so"`; web `"shows two charts with the same axes, titles Delivery cost and Your tip"`; `"the crossing base fee is marked in both and named in the sentence"`; `"a table view lists every point"`; `"the tooltip shows base fee, cost and tip at the pointer"`.
- [ ] **Step 2: Run.** `pnpm --filter @zk-bridge/shared test:unit -- tip-coverage && pnpm --filter @zk-bridge/web test:unit -- tip-cost` — Expected: FAIL.
- [ ] **Step 3: Implement**; run `node <dataviz skill>/scripts/validate_palette.js "<two hexes>" --mode light` and `--mode dark` against the theme surfaces; fix any FAIL.
- [ ] **Step 4: Look at it.** Run the dev server in fixture mode, take a screenshot of the bridge form in light and dark, check labels do not collide.
- [ ] **Step 5: Run.** `pnpm --filter @zk-bridge/shared test && pnpm --filter @zk-bridge/web test` — Expected: PASS.
- [ ] **Step 6: Commit.** `git add explorer/shared explorer/web && git commit -m "feat(web): cost and tip graphs by base fee"`

---

### Task 22: Docs sensitivity review (phase 4)

Spec "Calls I made: docs review" and "Every doc in `docs/` may be public".

**Files:**
- Create: `script/check-docs-public.sh`
- Modify: any file in `docs/`, `explorer/web/docs/pages/`, `README.md` that the scan or the read flags

**Interfaces:**
- Produces: `script/check-docs-public.sh` exits 1 and prints file and line for: email addresses, home directory paths (`/Users/`, `/home/`), private host names and the operator's own server names, RunPod endpoint identifiers, key-shaped strings, and one-time identifiers listed in the script. Task 25 runs it before the docs build.

- [ ] **Step 1: Write the gate and run it.** Expected: FAIL, listing at least `docs/gpu-prover.md` and `docs/testnet-run.md` (a RunPod endpoint identifier) and the files naming the operator's server.
- [ ] **Step 2: Fix every hit.** Replace a private endpoint with a placeholder such as `https://<your-endpoint>`. Keep facts and numbers.
- [ ] **Step 3: Read the red-team and containment notes** (`docs/red-team.md`, `docs/red-team-revision-2.md`, `docs/local-attack-report.md`, `docs/pulsechain-amb-review.md`): reword anything that names or could harm a third party beyond the technical finding.
- [ ] **Step 4: Run.** `script/check-docs-public.sh && script/check-forbidden-names.sh` — Expected: both exit 0.
- [ ] **Step 5: Commit.** `git add docs explorer/web/docs README.md script/check-docs-public.sh && git commit -m "docs: make every page safe to publish"`

---

### Task 23: Terminal reads the same as the dapp (phase 4)

Spec section 5 "The same reads as the dapp".

**Files:**
- Create: `explorer/terminal/src/ui/proof-panel.tsx`, `explorer/terminal/src/ui/history-view.tsx`, `explorer/terminal/src/data/backend-source.ts`
- Modify: `explorer/terminal/src/app/App.tsx`, `explorer/terminal/src/app/connections-model.ts` (the four new endpoints)
- Test: `explorer/terminal/test/ui/proof-panel.test.tsx`, `explorer/terminal/test/ui/history-view.test.tsx`, `explorer/terminal/test/data/backend-source.test.ts`

**Interfaces:**
- Consumes: `createBackendClient` (Task 15), `readBoardMessages` (Task 7), `parseHistoryEvents` (Task 4), `planUpdateFromProofMessage`, `planMessageExecution` (Task 14).

- [ ] **Step 1: Write the failing tests:** `"the proof panel shows the latest proof from the msgboard indexer, then the board when the indexer is down"`; `"request a proof shows the request status as it changes"`; `"evidence from the archive opens the execute sequence"`; `"history pages and filters like the dapp"`.
- [ ] **Step 2: Run.** `cd explorer/terminal && bun test test/ui/proof-panel.test.tsx` — Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run.** `cd explorer/terminal && bun test && bun run typecheck` — Expected: PASS.
- [ ] **Step 5: Commit.** `git add explorer/terminal && git commit -m "feat(terminal): proofs, evidence and history"`

---

### Task 24: Dapp proof panel and write actions (phase 5)

Spec section 4 "Proof panel" and "Write actions". Injected wallets only.

**Files:**
- Create: `explorer/web/src/views/ProofPanel.tsx`, `explorer/web/src/views/proof-panel-model.ts`
- Modify: `explorer/web/src/views/MessageView.tsx`, `explorer/web/src/app/services.tsx`
- Test: `explorer/web/test/views/proof-panel.test.tsx`, `explorer/web/test/views/message-view-coverage.test.tsx`

**Interfaces:**
- Consumes: `createBackendClient` (Task 15), `readBoardMessages` (Task 7), `planUpdateFromProofMessage`, `planMessageExecution` (Task 14), the endpoint settings (Task 10), the existing `use-transaction-sequence`.
- Produces: `messageStage(input: { status: MessageStatus; headSlot: bigint | null; sourceSlot: bigint | null }): "sent" | "waiting-for-finality" | "covered" | "delivered"`.

- [ ] **Step 1: Write the failing tests:** `"shows where the message is"`; `"shows the latest proof from the msgboard indexer, or from the board when the indexer is unset"`; `"request a proof posts once and then shows the status"`; `"post the light-client update sends update at the light client"`; `"deliver the message runs the prerequisites and then executeMessage from archive evidence"`; `"with no backend set, the buttons explain which setting is missing"`.
- [ ] **Step 2: Run.** `pnpm --filter @zk-bridge/web test:unit -- proof-panel` — Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run.** `pnpm --filter @zk-bridge/web test` — Expected: PASS.
- [ ] **Step 5: Commit.** `git add explorer/web && git commit -m "feat(web): proof panel and write actions"`

---

### Task 25: Docs site (phase 5) [lockfile]

Spec section 6. Reuse the dapp's Markdown reader; add links to it.

**Files:**
- Modify: `explorer/web/src/docs/markdown.ts` (inline `{ kind: "link"; href: string; children: Inline[] }`; only relative paths, `#` anchors and `https:` are links, anything else stays text), `explorer/web/src/docs/MarkdownView.tsx`
- Create: `explorer/docs/package.json` (React, Chakra, Vite at the versions the web uses), `vite.config.ts` (`base: './'`, alias `@web` to `../web/src`, the secret check), `index.html`, `src/main.tsx`, `src/pages.ts`, `src/DocsSite.tsx`
- Test: `explorer/web/test/docs/markdown.test.ts`, `explorer/docs/test/pages.test.ts`

**Interfaces:**
- Produces: `collectPages(input: { userPages: Record<string, string>; operatorPages: Record<string, string> }): DocsSitePage[]` (user help pages from `explorer/web/docs/pages`, operator pages from `docs/`, minus `docs/superpowers/`); links between `.md` files become hash routes.

- [ ] **Step 1: Write the failing tests:** `"a relative .md link becomes a link"`; `"a javascript: link stays text"`; `"every link between pages resolves to a page"` (build the page set and check every relative target); `"the site leaves out docs/superpowers"`.
- [ ] **Step 2: Run.** `pnpm --filter @zk-bridge/web test:unit -- markdown` — Expected: FAIL.
- [ ] **Step 3: Implement**; `pnpm install`.
- [ ] **Step 4: Run.** `script/check-docs-public.sh && pnpm --filter @zk-bridge/docs test && pnpm --filter @zk-bridge/docs build && pnpm --filter @zk-bridge/web test` — Expected: PASS; `dist/index.html` uses `./` paths only.
- [ ] **Step 5: Commit.** `git add explorer/docs explorer/web explorer/pnpm-lock.yaml && git commit -m "feat(docs): static docs site"`

---

### Task 26: Release pipeline (phase 6) [lockfile]

Spec section 8 and "Calls I made" on the release key and build machines. Publishing stays off until a remote and a pinning account exist.

**Files:**
- Create: `explorer/release/package.json` (dependencies `@ipld/car` 5.4.7, `ipfs-unixfs-importer` 17.1.1, `ipfs-unixfs-exporter` 16.2.3, `multiformats` 14.0.5, `blockstore-core` 7.0.1; dev `vitest` 4.1.11, `typescript` 5.9.3)
- Create: `explorer/release/src/car.ts`, `src/checksums.ts`, `src/manifest-writer.ts`, `src/sign.ts`, `src/verify.ts`, `src/main.ts`
- Create: `script/release/release.sh`, `script/release/publish.sh`
- Create: `docs/release.md`
- Test: `explorer/release/test/*.test.ts`

**Interfaces:**
- Consumes: `canonicalManifestBytes`, `parseManifest`, `verifyManifestSignature` from `explorer/landing/src/manifest.ts` (Task 6), `script/build-terminal.sh` (Task 5), the three site builds (Tasks 10, 25, 6).
- Produces:
  - `packDirectory(directory: string): Promise<{ cid: string; carBytes: Uint8Array }>` (UnixFS, CID version 1, raw leaves, fixed chunker, so the same files give the same CID)
  - `sha256File(path: string): Promise<string>`
  - `writeManifest(input: { previous: ReleaseManifest | null; releases: ReleaseEntry[]; downloads: DownloadEntry[] }): ReleaseManifest` (sequence = previous + 1, or 1)
  - `signManifest(input: { manifest: ReleaseManifest; privateKey: JsonWebKey }): Promise<Uint8Array>` (key read from standard input at the moment of use, never written)
  - `verifyRelease(directory: string, publicKeys: readonly JsonWebKey[]): Promise<{ ok: true } | { ok: false; problems: string[] }>`
  - `script/release/release.sh <output-directory>` builds dapp, docs and landing, the terminal programs, the prover for this machine (`cargo build --release --no-default-features --features sp1`) with both program files, writes `SHA256SUMS`, the archive files, `version.json`, `version.json.sig`, `public-keys.json`, then verifies. `publish.sh` exits 1 with "no release remote or pinning account is configured" until both are set.

- [ ] **Step 1: Write the failing tests:** `"the same directory packs to the same CID twice"`; `"a changed byte changes the CID"`; `"the archive unpacks to the same files"` (exporter); `"the sequence only goes up"`; `"a signature from signManifest verifies with the landing page's check"`; `"verifyRelease reports a tampered archive and a wrong checksum"`; `"sign refuses when no key arrives on standard input, and writes nothing"`; `"each site loads from its archive under /ipfs/<cid>/ with no failed asset"` (serve the unpacked files under a prefix and fetch every asset that `index.html` names).
- [ ] **Step 2: Run.** `pnpm install && pnpm --filter @zk-bridge/release test` — Expected: FAIL.
- [ ] **Step 3: Implement.** Generate a throwaway test key inside the test only.
- [ ] **Step 4: Run a local release with a test key.** `script/release/release.sh "$(mktemp -d)" < test-key.jwk` (the test generates the key in a temporary directory and deletes it) — Expected: last line `release verified`; `version.json` lists dapp, docs, landing and every download with SHA-256.
- [ ] **Step 5: Write `docs/release.md`:** how to create the signing key in a password manager, the one-key rule, a key change announced in a manifest signed by the old key, a successor forking the release repository under a new key, reproducible builds that anyone can check, and which platforms get build-from-source steps.
- [ ] **Step 6: Run.** `pnpm --filter @zk-bridge/release test && pnpm --filter @zk-bridge/release typecheck` — Expected: PASS.
- [ ] **Step 7: Commit.** `git add explorer/release script/release docs/release.md explorer/pnpm-lock.yaml && git commit -m "build(release): signed manifest and archives"`

---

### Task 27: "Run the whole system yourself" guide (phase 6)

Spec section 6 and the intent: a stranger goes from nothing to a running copy.

**Files:**
- Create: `docs/run-the-whole-system.md`
- Modify: `README.md` (one link)

**Interfaces:**
- Consumes: the configuration examples of Tasks 15 to 20, `docs/release.md` (Task 26), `docs/local-proving.md` (Task 17), `docs/terminal-program.md` (Task 5).

- [ ] **Step 1: Write the guide** in this order, every step with its command and how to check it worked: deploy the contracts (`script/hardened/DeployBridge.s.sol`), the prover and the GPU worker (`docs/gpu-prover.md`), the backend (each module alone or together), the chain indexer, the bots, a delivery router with your own reward address, the sites and your own release with your own key, and pointing users at your endpoints. Say plainly what is blocked on accounts.
- [ ] **Step 2: Check every command and path exists.** Run: `script/check-docs-public.sh` and, for each file path in the guide, `test -e <path>` — Expected: all present, gate exit 0.
- [ ] **Step 3: Commit.** `git add docs/run-the-whole-system.md README.md && git commit -m "docs: run the whole system yourself"`

---

### Task 28: The end-to-end test (phase 7) [lockfile]

Spec section 9. Extends the stages of Task 2.

**Files:**
- Create: `explorer/e2e/src/stages/backend.ts`, `stages/user-dapp.ts`, `stages/user-terminal.ts`, `stages/archive.ts`, `stages/landing.ts`, `stages/history.ts`
- Create: `explorer/e2e/playwright.config.ts`, `explorer/e2e/browser/dapp.spec.ts`, `explorer/e2e/browser/landing.spec.ts`, `explorer/e2e/browser/history.spec.ts` (`@playwright/test` 1.63.0)
- Modify: `explorer/e2e/src/main.ts` (stages), `e2e/run-all.sh` (one command; `--slow` adds the local proof)
- Modify: `docs/end-to-end-real-proofs.md`

**Interfaces:**
- Consumes: everything above. The dapp is the release build from Task 26 served under `/ipfs/<cid>/`; the terminal is the compiled binary from Task 5; the backend runs with the oracle backend unless `RUNPOD_API_KEY` is set.

- [ ] **Step 1: Write the stages as tests that fail before the system runs:**
  - `"a token sent each way is delivered by the bots"` (existing stages).
  - `"with the bots stopped, the dapp requests a proof, sees it published, posts the update and delivers the message"`: the message status becomes `delivered` and the executor is the test user.
  - `"the terminal binary does the same"`; with `--slow`, `"the terminal makes a local proof"`.
  - `"the archive serves evidence for an undelivered message and drops it on delivery"`.
  - `"the landing page accepts a test-signed manifest, refuses a tampered one, and refuses a lower sequence"`.
  - `"the history explorer shows every event with the indexer up, and a partial list marked as such with the indexer down"`.
  - With a RunPod key only: record the time of a long fold of many handoffs in `results.json`.
- [ ] **Step 2: Run.** `E2E_STATE_DIR=$(mktemp -d) e2e/run-all.sh` — Expected: FAIL at the first new stage until the pieces are wired.
- [ ] **Step 3: Wire the stages.** No product code changes here; a product defect found here goes back to its task with a failing unit test first.
- [ ] **Step 4: Run.** `E2E_STATE_DIR=$(mktemp -d) e2e/run-all.sh` — Expected: `all stages passed`; then `script/test-all.sh` — Expected: every step passes.
- [ ] **Step 5: Commit.** `git add explorer/e2e e2e docs/end-to-end-real-proofs.md explorer/pnpm-lock.yaml && git commit -m "test(e2e): the whole system on two chains"`

---

## Self-review

**Spec coverage.** Section 0: Tasks 1, 8, 11, 12, 13, 21. Section 1: 15, 18, 20. Section 2: 19. Section 3: 4. Section 3b: 7, 12. Section 4: 10, 13, 16, 21, 24 (wallets unchanged: injected only). Section 5: 5, 17, 23. Section 6: 22, 25, 27. Section 7: 6. Section 8: 26. Section 9: 2, 28. Mainnet parser: 3. Scrub: 9. Docs review: 22. Blocked items (remote, pinning, brand name, license, signing key, Apple account) are left as configuration or placeholders; publishing stays off (Task 26).

**Decisions the spec left to the builder, made here.** Tip range 0.5 to 1.5 times the measured gas cost (Task 13); loss rule `(cost − fee) × 100 < percent × cost` (Task 12); rate limits and retry (Task 15); `node:sqlite` storage; WebCrypto Ed25519; the CAR and CID packages listed in Global Constraints.

**Type consistency.** `ProofDirection`, `ProofMessage`, `FeeDirector`, `ReleaseManifest`, `HistoryEvent`, `OperatorCall`, `BackendModuleContext` are each defined once, in the task that produces them, and named the same where consumed.

**Proportion.** Signatures, test names and assertions only; no function bodies.
