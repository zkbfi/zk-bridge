# Off-chain red team, 2026-10-29

This report lists every attack that I ran against the off-chain code in `explorer/`: the backend, the shared logic, the bots, the web interface and the terminal. Each attack is a unit test. No production code was changed. No external service, Anvil node or end-to-end script was used. The code under test is `main` at `60a3cca`.

Result words: **BLOCKED** means the code refused the attack, and the test asserts the refusal. **SUCCEEDED** means the attack did what the attacker wanted, and the test asserts that (its name starts with `ATTACK SUCCEEDS`). Each SUCCEEDED line is explained under "Findings".

**Summary.** No input was found that the client reads as message X while the contract delivers message Y. `readProvenMessage` reads the same header fields, trie key, receipt, log and message bytes as `MessageBridge.executeMessage`. Where they differ, the client accepts and the contract reverts, so the cost is the signer's gas. Fixes `3473404`, `2caba1f`, `f983930` and `e776f05` hold. The most serious findings are these:

- The evidence planner accepts any bridge function as a "layout row" prerequisite, including a send (medium).
- The runner trusts the indexer's fee offer and token decimals (medium).
- Server text reaches the terminal with escape bytes in it (medium).
- Any anonymous caller can make the backend start a GPU proving run every `secondsBetweenJobsPerDirection` in each direction, even when no message is waiting (medium).

## Status

The fix round of 2026-10-29 fixed S-1, S-2, B-1, B-2, W-2, K-4 and K-1. No finding was rated high or critical. Each finding below ends with its status. The tests of the fixed findings now assert the refusal; their names end with "(BLOCKED, was <finding>)".

## How to run

| Package | Command (from the package folder) | Files |
|---|---|---|
| shared | `pnpm vitest run test/redteam` | `explorer/shared/test/redteam/proven-message.redteam.test.ts`, `shared-intake.redteam.test.ts` |
| backend | `pnpm vitest run test/redteam` | `explorer/backend/test/redteam/requests.redteam.test.ts`, `webhook.redteam.test.ts`, `msgboard-indexer.redteam.test.ts`, `archive-and-leaks.redteam.test.ts` |
| bots | `pnpm vitest run --config test/redteam/vitest.redteam.config.ts` (the package config only includes `test/unit`) | `explorer/bots/test/redteam/runner-attacks.test.ts` |
| web | `pnpm vitest run test/redteam` | `explorer/web/test/redteam/proof-panel-attacks.test.ts` |
| terminal | `bun test test/redteam` | `explorer/terminal/test/redteam/evidence-attacks.test.tsx` |

Method notes:

- `readProvenMessage` was attacked with synthetic `executeMessage` calldata. The test file builds the receipt trie, the transaction trie and the execution header around a forged receipt. The client does not check the beacon part, so it reads these proofs. The contract would refuse every one of them on the block hash branch. So a divergence matters only if it can also occur on the real, honest trie of a real block.
- The contract side was read, not run: `MessageBridge.executeMessage` and `_provenLog`, `BeaconProofVerifier._receiptLog` and `_receiptPayload`, `ReceiptLogs.itemAt`, and the vendored Optimism `MerkleTrie.get` and `RLPReader`.

## Results

### Shared: `readProvenMessage` against the contract (`proven-message.redteam.test.ts`)

| Attack | Result | Evidence |
|---|---|---|
| Log index selects the second message in one receipt | BLOCKED | Client reads Y, the same log as `ReceiptLogs.itemAt` |
| Log index one past the end, 2^64, 2^256-1 | BLOCKED | "log index is out of range" (contract: `LogIndexOutOfRange`) |
| Receipt with 41 logs, log 40 | BLOCKED | Read correctly; no 32-item cap |
| Receipt index 1, 127, 128, 255, 256, 65535, 2^64 | BLOCKED | Client key equals `_encodeUint` |
| Receipt index differs from transaction index | BLOCKED | Refused (contract: `IndexMismatch`) |
| Proof of index 1 presented as index 2 | BLOCKED | "not in the trie" |
| Receipts and transactions roots swapped in the header | BLOCKED | Same fields 4 and 5 as the contract; hash mismatch |
| Header of five fields; header that is a string | BLOCKED | Refused |
| Failed receipt (status empty or 2) | BLOCKED | Refused (contract: `ReceiptFailed`) |
| Legacy receipt (no type byte) | BLOCKED | Read like the contract |
| Topic identifier differs from the message identifier | BLOCKED | Refused (contract: `MessageIdMismatch`) |
| One topic, three topics, another event | BLOCKED | Refused |
| Event data with offset 64 | BLOCKED | Refused (contract: `MalformedEventData`) |
| Trie: node with a wrong hash, leaf path a prefix of the key, empty proof, 31-byte reference, empty branch value | BLOCKED | Refused |
| Log from a fake emitter with the bridge topic | SUCCEEDED | Client reads message X; contract reverts `WrongEmitter` (finding S-3) |
| Extra proof node after the leaf | SUCCEEDED | Client ignores it; contract reverts "value node must be last node in proof" (S-4) |
| Receipt type byte 0x00, 0x05, 0x7f | SUCCEEDED | Client strips it; contract accepts only 0x01 to 0x04 (S-4) |
| Event data with a trailing word | SUCCEEDED | Client decodes it; contract requires the exact length (S-4) |
| Unknown version, data type 0x80, wrong source chain | SUCCEEDED | Client reads it; contract reverts (S-3) |
| Leaf with hex-prefix flag 4 | SUCCEEDED | Client treats it as a leaf; contract reverts "unknown prefix" (S-4) |
| Receipt status written `0x8101` (non-canonical RLP) | SUCCEEDED | Client reads it; the vendored `RLPReader` reverts (S-4) |

### Shared: the operator plan (`proven-message.redteam.test.ts`)

| Attack | Result | Evidence |
|---|---|---|
| Evidence for another destination chain | BLOCKED | "The proven message is for chain 1" |
| File labels name message Y, proof proves X | BLOCKED | "messageId in the file differs" |
| `alreadyDelivered: "false"` (a string) | BLOCKED | Only the boolean `false` passes |
| Fake-emitter proof passes the plan | SUCCEEDED | Review shows X; the transaction reverts (S-3) |
| Wrong source chain passes the plan, with the file's route label | SUCCEEDED | S-3 |
| Summary source slot and anchor slot come from the file | SUCCEEDED | S-5 |
| `requireToPassMessage` as a prerequisite, titled "Add a layout row" | SUCCEEDED | S-1 |
| `executeMessage` of another message as a prerequisite | SUCCEEDED | S-2 |

### Shared: redaction, light client reader, codec, intake, board (`shared-intake.redteam.test.ts`)

| Attack | Result | Evidence |
|---|---|---|
| Alchemy, Infura, `api_key=`, `user:password@`, percent-encoded password, RunPod `rpa_` key, bearer token in an error line | BLOCKED | Removed |
| Known secret in any shape (QuickNode path) | BLOCKED | Removed when the caller passes it |
| QuickNode path token, Ankr path key, dRPC `dkey=`, `access_token=`, `x-api-key:` header, not passed as known | SUCCEEDED | Kept in the text (S-6) |
| Known secret of five characters; known secret in percent-encoded form | SUCCEEDED | Kept (S-6) |
| Light client reads at different heights | BLOCKED | All three reads name one block (`e776f05` holds) |
| Lagging node answers an empty root | BLOCKED | The read fails |
| Pair code 0, direction 2, header slot differs from the public values | BLOCKED | Refused |
| Oracle form in upper-case hex on a strict reader | BLOCKED | `oracle-proof-not-accepted` |
| Same payload in two cases gives two payload keys | BLOCKED | One key |
| Version 1 message with a trailing byte | BLOCKED | `trailing-bytes` |
| Board answer with a message of another category | BLOCKED | Dropped |
| Board answer with a non-hex field | BLOCKED | Refused |
| Board answer of 20,000 messages with a forged hash | SUCCEEDED | Passed on whole (S-7) |

### Backend (`explorer/backend/test/redteam/`)

| Attack | Result | Evidence |
|---|---|---|
| X-Forwarded-For spoof, default config | BLOCKED | Ignored unless `trustForwardedHeader` |
| Forged left-hand XFF entries behind one proxy | BLOCKED | Only the entry `trustedProxyHops` from the right counts |
| XFF spoof with trust on and the proxy bypassed | SUCCEEDED | Misconfiguration only (K-6) |
| Junk or over-long caller text | BLOCKED | Shared `unknown` bucket |
| IPv4-mapped, ported, bracketed, zero-padded forms | BLOCKED | One IPv4 key |
| IPv6 variants in one /64 | BLOCKED | One /64 key |
| One IPv6 /48 gets many caller keys | SUCCEEDED | Global limit still caps it (K-7) |
| NAT64 and IPv4-compatible IPv6 callers share one bucket | SUCCEEDED | Denial of service only (K-7) |
| 12 IPv4 addresses fill the global limit | SUCCEEDED | Every other caller gets 429 for a minute (K-2) |
| Many callers start parallel jobs | BLOCKED | One active job per direction |
| New job before `secondsBetweenJobsPerDirection` | BLOCKED | 429 |
| Anonymous caller starts a proving run with nothing pending | BLOCKED | 409, no job (K-1) |
| Retry loop after a failed job | BLOCKED | Waits `secondsBeforeRetryAfterFailure` |
| 1 MB request body; extra fields, wrong pair, bad message id | BLOCKED | 413, 400 |
| Prover error with RunPod key or bearer in answers, health or logs | BLOCKED | Fixed phrases; logger redacts |
| Jobs table growth | SUCCEEDED | Never pruned (K-8) |
| Webhook bearer missing, wrong case, padded, Basic, prefix | BLOCKED | 401; hash plus `timingSafeEqual` |
| Webhook bearer variable unset or empty | BLOCKED | 503 |
| Unauthenticated 1 MB webhook body | BLOCKED | 401 before reading the body |
| Job id guessing | BLOCKED | Ids are public; the bearer is the gate |
| Replay or different package for a job with a proof; post to a published, failed or on-chain job | BLOCKED | 202/409, stored payload unchanged |
| Unknown or injection-style job id | BLOCKED | 404 |
| Oracle proof when `acceptOracleProof` is false | BLOCKED | 422, job failed |
| Proof for the other direction; stale proof; header against public values; proof that does not verify | BLOCKED | 422 or intake refusal; verifier text not echoed |
| Light client read error naming the RPC endpoint | BLOCKED | 503 with fixed text |
| Board down longer than the prover timeout | SUCCEEDED | Paid proof dropped, a new job runs (K-3) |
| Oracle, other direction, other pair, other program key on msgboard | BLOCKED | Refused before the verifier |
| Shorter (stale) proof after a longer one | BLOCKED | Longer proof stays |
| Oversized payload | BLOCKED | Never queued |
| Fewer than 512 junk proofs (control) | BLOCKED | Each verified once |
| More than 512 junk proofs that start at the head | SUCCEEDED | Re-verified every poll (K-5) |
| `/proofs/latest` with unknown direction, traversal, `__proto__` | BLOCKED | 404 |
| Lagging RPC read deletes a good proof | SUCCEEDED | One public GET deletes it (K-4) |
| Right start slot, wrong start root | BLOCKED | Not stored |
| `/evidence` traversal, `%0a`, `%00`, SQL text, over-long id | BLOCKED | 400 by regex |
| Prover builds evidence for another message | BLOCKED | `messageId` check |
| Indexer item with chains outside the pair | BLOCKED | Ignored |
| Lying chain indexer deletes good evidence | SUCCEEDED | Needs a compromised indexer (K-9) |
| Indexer error with a key reaches `/health` | BLOCKED | Only the error name |
| RPC keys in path, query, userinfo, msgboard path, host name in logs | BLOCKED | Redacted |


### Bots: the runner (`runner-attacks.test.ts`)

| Attack | Result | Evidence |
|---|---|---|
| Oracle-form proof on a strict runner; oracle option `"yes"` | BLOCKED | `oracle-proof-not-accepted`; the prover never runs |
| Proof for the other direction; for another pair | BLOCKED | `wrong-direction`, `wrong-pair` |
| Garbage, empty, truncated, trailing-byte, 100 KB payloads | BLOCKED | `undecodable`, no verify |
| Header slot differs from the public values | BLOCKED | `inconsistent-public-values` |
| Stale proof; wrong program key | BLOCKED | `already-stored`, `program-key-mismatch` before the prover |
| Forged Groth16 proof naming the current head | BLOCKED | `proof-does-not-verify`, no gas |
| Already delivered evidence | BLOCKED | Skipped |
| Proof that would revert | BLOCKED | `simulation-reverted`, nothing sent |
| Zero, negative cost, or full loss | BLOCKED | `decideDelivery` refuses |
| Fee token with no valuation, zero or negative | BLOCKED | `no-price-for-fee-token` |
| Indexer lies about the fee offer | SUCCEEDED | Item becomes ready; the runner pays gas for no tip (B-1) |
| Indexer lies about token decimals | SUCCEEDED | Tip valued 10^18 times too high (B-1) |
| Evidence names another message than the feed item | SUCCEEDED | No identifier check (B-2) |
| Target contract emits a forged `AffirmationCompleted` | SUCCEEDED | A failed item is recorded as delivered (B-3) |
| Flood of distinct forged proofs | SUCCEEDED | Each spawns one local verify (B-4) |

### Web and terminal (`proof-panel-attacks.test.ts`, `evidence-attacks.test.tsx`)

| Attack | Result | Evidence |
|---|---|---|
| Evidence labels (message id, sender, executor, gas limit, transaction hash, log index) differ from the proof | BLOCKED | `3473404` holds |
| PulseChain evidence relabelled as Ethereum (wrong-chain signing) | BLOCKED | Proven destination chain must equal the chain |
| `execute.to` or `prerequisite.to` is not the bridge | BLOCKED | Refused |
| Archive serves valid evidence of another message, or relabels B as A (web) | BLOCKED | `evidenceMismatch` |
| Message id with path characters in the archive URL | BLOCKED | Hash pattern; no fetch |
| `deliveryStatus` "delivered" with `alreadyDelivered` false | BLOCKED | Refused |
| Prerequisite with an unknown selector, or a wrong function label | BLOCKED | Refused |
| Cleared rows reordered on re-read; execute row equal to a cleared calldata | BLOCKED | Keyed by calldata (`f983930` holds) |
| Indexer serves a proof for the other direction, or the oracle form | BLOCKED | Route filter, strict decode |
| Posting a proof that does not start at the head read again | BLOCKED | `proofStartProblem` (`2caba1f` holds) |
| Archive prerequisite `requireToPassMessage` | SUCCEEDED | S-1 |
| Archive prerequisite `executeMessage` of another message | SUCCEEDED | S-2 |
| Real fixture vectors the contract refuses (other emitter, wrong source chain, bad version, bad data type) pass the planner | SUCCEEDED | S-3 |
| Summary route, anchor slot, source slot from the file | SUCCEEDED | S-5 |
| Web indexer path shows a stale proof as found | SUCCEEDED | W-1 |
| Escape sequences (ANSI, OSC 8 link, clear screen, bidi) in server text reach the terminal cell buffer | SUCCEEDED | W-2 |

## Findings

### S-1 Medium: a hostile evidence file can make the user send a message from their own wallet

- **Where.** `explorer/shared/src/operator.ts`, `prerequisiteStep`. Any function of the message bridge ABI passes, and the row is titled "Add a layout row: <function>" with the note "The chain validates the row."
- **Scenario.** The backend archive (or a file) adds a prerequisite `requireToPassMessage(attackerTarget, data, gas)` with the reason "no validated block hash row covers the source slot". A user who clicks through the sequence sends a message whose `messageSender()` is the user. On the other chain, any contract that trusts that user as a cross-chain sender (a cross-chain account, an app with per-user authority) runs the attacker's call. The function name and arguments are shown, but the title and note say it is a layout row.
- **Tests.** shared "ATTACK SUCCEEDS a send (requireToPassMessage) is accepted as a prerequisite and titled 'Add a layout row'"; terminal "ATTACK SUCCEEDS a prerequisite that sends a new message as the user (requireToPassMessage)"; web "ATTACK SUCCEEDS archive adds a prerequisite that sends a new message from the user's wallet".
- **Suggested fix.** Allow only `addBlockRootsLayout`, `addBlockHashLayout` and `addHistoricalSummariesLayout` as prerequisites.
- **Status.** Fixed in `dcf255f`. `prerequisiteStep` allows only `addBlockRootsLayout`, `addBlockHashLayout` and `addHistoricalSummariesLayout`. The shared, web and terminal tests now assert the refusal.

### S-2 Low: a prerequisite can execute another message

- **Where.** Same code as S-1.
- **Scenario.** The archive adds `executeMessage` of an unrelated message Y as a "layout row". The user pays its gas (up to about 10 million gas). Delivery of Y is permissionless anyway, so only gas is lost.
- **Tests.** shared "ATTACK SUCCEEDS executeMessage of another message is accepted as a prerequisite"; terminal "ATTACK SUCCEEDS a prerequisite that executes a different message (user pays its gas)".
- **Suggested fix.** The allow-list of S-1.
- **Status.** Fixed in `dcf255f`, by the allow-list of S-1.

### S-3 Low: the planner accepts proofs that the contract always refuses

- **Where.** `explorer/shared/src/proven-message.ts` does not check the emitter, the message version, the data type or the source chain; `operator.ts` checks only the destination chain.
- **Scenario.** On the source chain, anyone deploys a contract that emits `UserRequestForAffirmation` with the identifier, sender, executor and gas limit of a real pending message X. A hostile archive serves evidence built on that log. The review shows message X, every label agrees, and the transaction reverts with `WrongEmitter`. The user loses the gas of a reverted transaction, unless the wallet's simulation warns. The same holds for a wrong source chain, an unknown version or an unknown data type.
- **Why not X vs Y.** The contract delivers only the log of `remoteBridge`, and the remote bridge only writes canonical messages. So the client can be wrong only towards "reverts", never towards another message.
- **Tests.** shared "ATTACK SUCCEEDS fake emitter: …", "ATTACK SUCCEEDS fake-emitter proof passes the plan …", "ATTACK SUCCEEDS a message of an unknown version, data type or source chain is read …", "ATTACK SUCCEEDS wrong source chain passes the plan …"; terminal "ATTACK SUCCEEDS planner accepts electra_reject_…" (four real fixture vectors).
- **Suggested fix.** Pass the remote bridge address and the remote chain identifier to `readProvenMessage` (both are in the pair list), and check the emitter, `sourceChainId`, the version prefix and the data type as `_messageOf` and `_requireAcceptableMessage` do.
- **Status.** Open. Low: the contract refuses these proofs, so only the gas of a reverted transaction is at stake.

### S-4 Low (informational): the client parser is looser than the contract

- **Where.** `explorer/shared/src/proven-message.ts`: `readTrieValue` stops at the value and ignores extra proof nodes, and treats any flag nibble of 2 or more as a leaf; `receiptFields` strips any type byte below 0x80; viem's `fromRlp` accepts non-canonical RLP; `decodeAbiParameters` accepts trailing words.
- **Scenario.** A hostile evidence file appends a node to an honest receipt proof. The client reads the right message, and the contract reverts. Only gas is lost. The other cases (type byte, flag nibble, non-canonical RLP, trailing event data) cannot occur on an honest trie of a real block, which the contract requires.
- **Tests.** shared "ATTACK SUCCEEDS extra proof node after the leaf …", "ATTACK SUCCEEDS receipt type byte 0x…", "ATTACK SUCCEEDS event data with a trailing word …", "ATTACK SUCCEEDS a leaf with an unknown hex-prefix flag …", "ATTACK SUCCEEDS non-canonical status …".
- **Suggested fix.** Require the value node to be the last proof node; allow only types 0x01 to 0x04; require flags 0 to 3; require the exact event data length. A strict RLP decoder is optional.
- **Status.** Open. Informational: only gas is at stake, and most shapes cannot occur on an honest trie.

### S-5 Low (display): some summary fields come from the file

- **Where.** `explorer/shared/src/operator.ts`, the `summary` in `planMessageExecution`: `route`, `sourceSlot` and `anchorSlot` are read from the file. The web uses `sourceSlot` for its "covered" logic.
- **Scenario.** A hostile archive shows another source slot, anchor slot or route than the calldata holds. The signed calldata is still the proven message, so only the display and the layout advice are wrong.
- **Tests.** shared "ATTACK SUCCEEDS the source slot and anchor slot shown in the summary are not bound to the calldata"; terminal "ATTACK SUCCEEDS summary sourceSlot, anchorSlot and route come from the file, not the proof".
- **Suggested fix.** Read the slots from `anchorHeader.slot` and `sourceHeader.slot` of the decoded calldata, and derive the route from the proven chains.
- **Status.** Open. Low: display only; the signed calldata is the proven message.

### S-6 Low: redaction misses common provider key shapes

- **Where.** `explorer/shared/src/redaction.ts`, `RULES`.
- **Scenario.** An RPC or beacon URL with its key in the path (QuickNode `/<token>/`, Ankr `/eth/<key>`) or in a query parameter not on the list (`dkey`, `access_token`), or an `x-api-key` header, shows up in an error that is logged or returned. It is removed only if the caller passes the value as a known secret. A known secret shorter than six characters, or in its percent-encoded form, is never removed.
- **Tests.** shared "ATTACK SUCCEEDS QuickNode path token survives …" and the five cases next to it; "ATTACK SUCCEEDS a known secret of five characters is not removed"; "ATTACK SUCCEEDS a known secret is not removed in its percent-encoded form".
- **Suggested fix.** Every caller should pass the configured endpoint URLs (and their path and query parts) as known secrets. Also remove the percent-encoded form of each known secret. Add rules for `[?&][a-z_]*(key|token)=` and `x-api-key:`.
- **Status.** Open. Low.

### S-7 Low: the board reader has no limit

- **Where.** `explorer/shared/src/msgboard/board-http.ts`, `readBoardMessages`.
- **Scenario.** A hostile board answers with tens of thousands of messages and forged hashes. Each one is passed on, and each one is decoded by the reader. The decoder refuses junk cheaply, so the cost is memory and CPU in the browser or bot.
- **Test.** shared "ATTACK SUCCEEDS a hostile board answer of 20,000 messages with a forged hash is passed on whole (no count limit, hash not checked)".
- **Suggested fix.** Cap the count and the data size, and do not use the board's `hash` as a key without checking it.
- **Status.** Open. Low.

### B-1 Medium: the runner trusts the indexer's fee offer and token decimals

- **Where.** `explorer/bots/src/runner/delivery.ts` around line 428 (`prepareItem` reads the fee offer from the indexer's `message.data`) and around line 189 (`decimals` from the feed item).
- **Scenario.** A compromised or third-party indexer advertises large tips on messages that carry none, or claims 0 decimals for an 18-decimal token. The runner delivers each one and pays the gas, up to `maximumDeliveriesPerSweep` per sweep, again on every sweep. The batch simulation checks only that the call succeeds, not that the tip arrives.
- **Tests.** bots "ATTACK SUCCEEDS lying indexer: a fee offer that is not in the proven message makes the item ready to be paid for"; "ATTACK SUCCEEDS lying indexer decimals: a copy token that claims 0 decimals inflates the tip value (valuation is per whole token)".
- **Suggested fix.** Read the offer and the gas limit from `evidence.message.data` (the prover builds it from the source chain), or require the indexer data to equal it. Read `decimals` from the token or pin it in the valuation config.
- **Status.** Fixed in `e277299`, `c70eed6` and `01c3246`. The runner skips an item whose indexer data or gas limit differs from the message that its prover read (`indexer-disagrees-with-evidence`), reads the decimals of the fee token from the token, derives the token that the message releases to the router (the named token, or the factory copy of a source token) and skips an item that lists another, and takes the chain ids for the copy lookup from its configuration, skipping an item of another direction (`wrong-direction`). A tip in a copy that is not deployed yet can no longer be valued (`no-price-for-fee-token`).

### B-2 Low: the runner does not bind evidence to the feed item

- **Where.** `explorer/bots/src/runner/delivery.ts` around line 449; only `alreadyDelivered` is checked.
- **Scenario.** A buggy or misconfigured prover returns evidence for message Y when asked for X. The runner delivers Y and records it under X.
- **Test.** bots "ATTACK SUCCEEDS evidence for another message: the runner does not compare evidence.message.messageId with the feed item".
- **Suggested fix.** Check the calldata with `readProvenMessage` and compare its identifier with the item, as the web and the terminal now do.
- **Status.** Fixed in `6d626e5`. The runner skips evidence whose `message.messageId` is not the item (`evidence-for-another-message`). It compares the label of its own prover, not the calldata proof.

### B-3 Low to medium: forged `AffirmationCompleted` events are trusted

- **Where.** `explorer/bots/src/runner/batch.ts` around line 313 (`affirmedMessageOf`) and 334 (`isTransferTo`). The log address is not checked.
- **Scenario.** A message target that runs inside a batch emits an event with the bridge's signature naming item B, whose call failed. B is recorded as delivered and never retried by this runner. Forged `Transfer` events to the router shift the fee accounting.
- **Test.** bots "ATTACK SUCCEEDS forged AffirmationCompleted from a target contract marks a failed item as delivered".
- **Suggested fix.** Require `log.address` to be the destination bridge, and take release segments only from the mediator.
- **Status.** Open. Low to medium; not in this round.

### B-4 Low: a flood of forged proofs costs prover CPU

- **Where.** `explorer/shared/src/prover/proof-intake.ts`, the verify step.
- **Scenario.** The head is public, so each distinct forgery that names it passes the cheap checks and spawns one `verify` process. The payload memory is per payload. No gas is lost; msgboard proof of work is the only brake.
- **Test.** bots "ATTACK SUCCEEDS forged-proof flood: every distinct forgery that names the current head spawns one local verify".
- **Suggested fix.** One verify in flight per head and a cap per minute; remember refusals per head.
- **Status.** Open. Low.

### W-1 Low: the web indexer path shows a stale proof as found

- **Where.** `explorer/web/src/views/proof-panel-model.ts`, `fromMsgboardIndexer`.
- **Scenario.** The indexer serves a proof that ends before the stored head. The panel shows it as found. The post button still refuses it through `proofStartProblem`, so only the panel misleads.
- **Test.** web "ATTACK SUCCEEDS indexer serves a stale proof …".
- **Suggested fix.** Filter by the head read from the chain, as the board path does.
- **Related, not tested.** The terminal's head re-read before posting (`terminal/src/ui/proof-panel.tsx`, `post`) uses `dataSource.getHeads`, which can be the indexer. A lying indexer can therefore make the terminal post a proof that reverts. The web reads the head from the chain.
- **Status.** Open. Low: the post button still refuses the stale proof.

### W-2 Medium: escape sequences from servers reach the terminal

- **Where.** `explorer/terminal/src/ui/proof-panel.tsx` (`directionLines`, `jobWords`), `RequestLines`, `AcceptedRequest`, and the evidence error lines. Text from the backend, the archive and the board passes only through redaction, which keeps control characters.
- **Scenario.** A hostile backend returns a job error holding `ESC ] 8 ;; https://evil.example/ BEL` (a clickable link with any label), `ESC [2J` (clear screen), or bidi overrides. The text can paint a fake review over the real one or hide a link.
- **Test.** terminal "ATTACK SUCCEEDS escape bytes survive into the OpenTUI cell buffer". It shows the bytes kept as cells in OpenTUI's test renderer. Whether a real terminal acts on them was not observed.
- **Suggested fix.** Strip C0 and C1 control characters, DEL and the bidi controls (U+202A to U+202E, U+2066 to U+2069) from all server text, in `RichLine` or in one shared sanitizer. React escapes the same text on the web; no cross-site scripting was found there.
- **Status.** Fixed in `4960a21`. `safeText` in `terminal/src/ui/rich-text.tsx` removes CSI and OSC sequences, C0 and C1 controls, DEL and bidi controls. `RichLine` and the direct error lines (feed, pairs, audit, updates, status bar, address filter) use it. The tests now render and check the cell buffer.

### K-1 Medium: anyone can make the backend spend GPU money

- **Where.** `explorer/backend/src/requests/service.ts`, `submit()`: a job starts for any reason; the rate limits are the only control.
- **Scenario.** Any address posts `{reason: "user"}` every 120 seconds per direction. Each run that finds a newer finalized head pays for a GPU proof: about 225 proofs per direction per day with nothing waiting. The prover was faked, so the cost is inferred, not measured.
- **Test.** backend "ATTACK SUCCEEDS an anonymous caller starts a proving run in each direction every secondsBetweenJobsPerDirection, with no message pending".
- **Suggested fix.** Start a remote job only for a message the chain indexer reports as covered and undelivered, or for an authenticated keep-alive; add a daily job budget per direction.
- **Status.** Fixed. A request only asks: before it starts a new job, the backend asks the chain indexer whether the direction needs a proof. It needs one when a message waits for finality and no stored head covers it, or when the destination head is missing or older than `limits.keepAliveSeconds` (default 12 hours). Otherwise the answer is 409 `nothing-to-prove`. When the indexer cannot answer, the answer is 503 `cannot-check` and no job starts. The cheap limits run before the indexer is asked, and one answer serves a direction for 15 seconds. The daily budget `limits.jobsPerDirectionPerDay` (default 96) stays as a backstop for an indexer that reports wrong facts. Tests: backend "ATTACK an anonymous caller who asks for a proving run … while no message waits starts nothing (BLOCKED, was K-1)" and "… the daily job budget still stops the spend (backstop)".

### K-2 Low to medium: twelve addresses lock everyone out

- **Where.** `service.ts`, `submit()` checks the global window before `findActiveJob`.
- **Scenario.** 12 IPv4 addresses (or one IPv6 /48) fill `globalRequestsPerMinute` (120). Requests that only join an active job count too.
- **Test.** backend "ATTACK SUCCEEDS twelve IPv4 addresses fill the global limit and lock every honest caller out for a minute".
- **Suggested fix.** Do not count joins of an active job; give keep-alive and message requests their own budget.
- **Status.** Open. Low to medium.

### K-3 Low to medium: a slow board wastes paid proofs

- **Where.** `service.ts`, `failLostJobs`; `src/webhook/publish.ts`, `tick()`.
- **Scenario.** A job is failed after `prover.timeoutSeconds` (1800 s) although its proof is stored and the post is still retrying (retries take about 1.5 hours). The next tick deletes the proof and the next request pays again.
- **Test.** backend "ATTACK SUCCEEDS a board that is slow or down for longer than prover.timeoutSeconds loses a paid GPU proof, and the next request pays for another".
- **Suggested fix.** Skip jobs with a stored proof in `failLostJobs`, or refresh `updatedAt` on each post attempt.
- **Status.** Open. Low to medium.

### K-4 Low to medium: a lagging RPC read deletes a good proof

- **Where.** `src/msgboard-indexer/module.ts`: the route, `ingest` and `chooseLatest` call `deleteStoredProof` on any head mismatch.
- **Scenario.** A load-balanced node one update behind answers one read, triggered by any public GET of `/proofs/latest`; the stored proof is deleted for good.
- **Test.** backend "ATTACK SUCCEEDS one read of a lagging RPC node (an older head) makes a public GET delete a good proof for good".
- **Suggested fix.** Delete only when the read head is higher than the proof's start slot; on a lower head answer 503 without deleting.
- **Status.** Fixed in `6892b77`. A head read below the start of the kept proof no longer deletes it: `GET /proofs/latest` answers 503, and `chooseLatest` keeps the proof.

### K-5 Low: junk proofs keep the verifier busy

- **Where.** `module.ts`, `SEEN_LIMIT` (512) with a poll that re-reads every recent message.
- **Scenario.** More than 512 junk proofs that start at the head (each costs msgboard proof of work once) thrash the cache, so every 30-second poll spawns a verify for each.
- **Tests.** backend "ATTACK SUCCEEDS more than SEEN_LIMIT junk proofs …" and its control.
- **Suggested fix.** Keep refusals until the head moves; cap verifications per poll.
- **Status.** Open. Low.

### K-6 Low (misconfiguration): forged X-Forwarded-For with the proxy bypassed

- **Where.** `src/requests/module.ts`, `callerOf`.
- **Test.** backend "ATTACK SUCCEEDS forged X-Forwarded-For when trustForwardedHeader is on and the backend is reached without the proxy".
- **Suggested fix.** Refuse `trustForwardedHeader` unless `listen.host` is loopback, or check the socket address against an allowed proxy list.
- **Status.** Open. Misconfiguration only.

### K-7 Low: IPv6 caller keys

- **Where.** `src/requests/caller.ts`, `callerKey`.
- **Scenario.** A /48 gives 65,536 keys (capped by the global limit). All NAT64 (`64:ff9b::/96`) and `::a.b.c.d` callers share one bucket.
- **Tests.** backend "ATTACK SUCCEEDS one holder of an IPv6 /48 …", "ATTACK SUCCEEDS IPv4-compatible … NAT64 …".
- **Suggested fix.** Key IPv6 by /56 or add a /48 limit; map the embedded IPv4 forms to their IPv4 address.
- **Status.** Open. Low.

### K-8 Low: job rows are never pruned

- **Where.** `src/requests/jobs.ts`, `pruneRequests` prunes requests only.
- **Test.** backend "ATTACK SUCCEEDS job rows are never pruned …". Growth is slow (at most about 1,440 jobs a day).
- **Suggested fix.** Prune finished jobs and posted proofs after the retention window.
- **Status.** Open. Low.

### K-9 Low: a lying indexer deletes good evidence

- **Where.** `src/archive/build.ts`, `dropFinished`.
- **Test.** backend "ATTACK SUCCEEDS a lying chain indexer … delete good evidence".
- **Suggested fix.** Confirm delivery on chain before deleting evidence.
- **Status.** Open. Low; needs a compromised indexer.

## Known issues

No item of `docs/audit/known-issues.md` covers the off-chain code beyond the interface cutover (1.5). Nothing above repeats it. Item 1.20 (a deliverer can raise a gas-based tip) is about the router contract; B-1 is about the runner believing a tip that does not exist.

## What I could not test

- Real chains: no Anvil, so every "the contract reverts" above comes from reading the contract, not from running it. The fixture vectors in `light-client/tests/fixtures/message/` back the four real-vector cases of S-3.
- Real terminal output for W-2: only the OpenTUI test renderer.
- The bots publisher service, and whole-sweep loops of the runner (read, not tested: the retry path only re-simulates).
- Wallet chain switching in the web wallet UI.
- Backend: slow clients (slowloris) against `@hono/node-server`, real RunPod billing, the real msgboard proof-of-work cost of K-5, and two processes on one SQLite file.
