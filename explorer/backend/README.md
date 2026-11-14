# zk-bridge backend

The backend is one open-source service with four modules. Each module can run alone.

| Module | What it does | Routes |
| --- | --- | --- |
| `requests` | Takes proof requests from dapp pages and runs one proving job per direction, shows where each transfer is in the pipeline, and makes the proof of any route step on request. | `POST /requests`, `GET /requests/:id`, `GET /directions/:direction`, `GET /progress/:messageId`, `GET /directions/:direction/pipeline`, `GET /benchmarks`, `GET /billing`, `GET /warmup/summary` (deprecated), `GET /route/steps`, `POST /steps/requests`, `GET /steps/jobs/:jobId`, `GET /steps/proofs/:kind/:subject` |
| `webhook` | Receives the proof package from the prover, checks it, and posts it to the msgboard. | `POST /webhook/jobs/:jobId` |
| `msgboard-indexer` | Keeps the latest valid proof of each direction. | `GET /proofs/latest/:direction` |
| `archive` | Builds and keeps evidence for messages that are sent and not yet delivered. | `GET /evidence/:messageId` |

`GET /health` always answers. It lists each running module with the state `running`, `degraded` or `not built`.

Run it with:

```
node bin/zk-bridge-backend.mjs --config backend.config.json [--modules requests,webhook,msgboard-indexer,archive]
```

Without `--modules`, the `modules` field of the file decides.

## Settings

Copy `backend.config.example.json` and change it. Keep the file private (mode 0600): an endpoint can carry a key.
The backend reads no endpoint from the environment.

| Field | Meaning |
| --- | --- |
| `schemaVersion` | Always `1`. |
| `pair` | The pair to serve, such as `eth-pls`. |
| `deploymentFile` | The deployment file with the contract addresses of both chains. |
| `databasePath` | The SQLite file. Back up this one file. |
| `listen` | `host` and `port` of the web server. |
| `modules` | The modules to run when the command line names none. |
| `publicUrl` | How the prover reaches this service. The prover posts to `<publicUrl>/webhook/jobs/<id>`. |
| `prover` | `binary` (path of `zk-bridge-prover`) and `timeoutSeconds`. |
| `remote.endpoints` | The proving endpoints in priority order, such as a dedicated worker first and the serverless endpoint as the fallback. See "Proving endpoints". |
| `remote.endpoint` | The older form: one load balancing endpoint, with its key in `runpodApiKeyVariable`. Set `remote.endpoint` or `remote.endpoints`, not both. |
| `rpcUrls` | The execution endpoint of each chain, by chain identifier. Both chains of the pair are required. |
| `beaconUrls` | The beacon endpoint of each chain. The `requests` module needs both. |
| `stateUrls` | Optional. More beacon APIs of each chain, by chain identifier, as a list. The prover asks them in order, only for states, when the beacon endpoint does not serve an old state. The prover also keeps every state it verified in `beacon-states/` next to `databasePath`, and reads the start state of a job from there first. |
| `handoffUrls` | Optional. More beacon APIs of each chain, by chain identifier, as a list. Asked for the committee handoff update of a period that the beacon endpoint and the states cannot give, and for states after `stateUrls` (prover `source.handoff_urls`). See "The handoff archive". |
| `handoffArchiveUrls` | Optional. More base URLs of the handoff archive (`<base>/<chainId>/<period>.json`), asked after this backend's own table and the indexer's, such as `https://<gateway>/ipfs/<cid>/handoff-updates`. |
| `handoffCapture` | `{ enabled: true, backfillPeriods: 8, intervalSeconds: 600 }`. The capture of the handoff archive (archive module). |
| `forkProofCapture` | `{ enabled: true, intervalSeconds: 120 }`. The capture of the fork proof archive (archive module). See "The fork proof archive". |
| `forkProofArchiveUrls` | Optional. More base URLs of the fork proof archive (`<base>/<chainId>/<stateRoot>.json`), asked by the `evidence` command after this backend's own table and the indexer's, such as `https://<gateway>/ipfs/<cid>/fork-proofs`. |
| `headerRpcUrls` | Optional. More execution RPCs of each chain, by chain identifier, as a list. The prover asks them in order, only for `debug_getRawHeader`, when the RPC endpoint lacks it (the `opening-proof` command needs the raw header of the other chain's block, and the `evidence` command the raw header of a Gloas source block). The prover file names them for both sides of a route (`source.header_rpc_urls`, `destination.header_rpc_urls`). Every header is checked against its block hash. |
| `msgboardUrl` | The msgboard node. The `webhook` and `msgboard-indexer` modules need it. |
| `indexerUrl` | The chain indexer. The `requests` module needs it and refuses to start without it. Without it the archive reports `degraded`. |
| `acceptOracleProof` | Local testing only. See below. Default `false`. |
| `trustForwardedHeader`, `trustedProxyHops` | See "Callers and limits". |
| `limits` | See "Callers and limits". |
| `seal` | Optional; needed by the `seal` module. `{ signer, receiptTimeoutSeconds: 180, observation, registryKeepAlive }`. See "Sealing a gate" and "The registry light client's keep-alive". |

## Sealing a gate

The `seal` module (`src/seal/`) watches the deposit gate of each chain of the pair once per epoch of that chain. It asks
`offerSeal` of `@zkb/data`, the code of the dapp's "Seal the gate" button: `seal("")` when the gate's fork registry shows
a state shape the gate does not allow (PulseChain), else beacon evidence of a state at a disallowed depth (Ethereum, from
`beaconUrls`). Each is simulated from the module's signer, and only a call that simulated is sent, through the runner's
transaction port (the simulated gas plus 30 percent, twice the base fee plus the chain's minimum priority fee, a wait of
`receiptTimeoutSeconds` for the receipt). Two checks of a chain never overlap.

Every finding is logged (`seal_not_needed` when the reason changes, `seal_check_failed`); a ready seal (`seal_ready`), its
outcome (`seal_sent`, `seal_reverted`, `seal_send_failed`) and a sealed gate (`seal_gate_sealed`, once) also write an
`alert` line at error level, which is the alert path of this service: ship the log to whatever pages you. The status
service also turns its check `gate-<chainId>` down once a gate is sealed; list it in `alerts.checks` there to have it
posted to the webhook.

`seal.signer` is configured exactly as the runner's signer of `explorer/bots` (`signerSchema` there): `{ "kind":
"private-key", "key": "env:ZKB_SEAL_KEY" }` reads the key from that environment variable, `"op://vault/item/field"`
from 1Password, and `keystore`, `mnemonic`, `ledger` and `trezor` work as in the runner. The file never holds the secret,
and the logger removes every value read this way from each line. The account pays the gas of a seal (about 70,000 to
100,000 gas, once per route); keep a little native coin on it on both chains. Run it with `--modules requests,seal` or
add `"seal"` to `modules`.

### Fork observations (PulseChain)

PulseChain has no beacon roots, so its gate (`SealOnlyWithRegistry`) can only seal from its `ForkRegistry`, and the
registry only learns of a fork from a proof of the fork observation program. On a chain whose pair side names a
`fork_registry` (and has a beacon endpoint), the module proves and posts those observations itself (`src/seal/observe-watch.ts`):

- **When.** Once per epoch it reads the beacon node's fork schedule (`/eth/v1/config/fork_schedule`, genesis, spec) and
  the registry's `latestObserved()`. A proof is asked for only when the version the chain runs now is not the version of
  the registry's newest observation: once to seed an empty registry, then once per fork. The shape comes with the
  version, so an unchanged version never asks for a proof (`observationNeed` of `@zkb/data`).
- **How.** `zk-bridge-prover fork-observation --route <the chain's outgoing route> --registry <address>` with the same
  remote endpoints and keys as a proving job (`remote.endpoint` or `remote.endpoints`), and no webhook: the package comes
  back on standard output. The prover reads the registry's light client (a light client of PulseChain on PulseChain),
  folds from its head to the newest final header, and observes the newest signed update (its fork version and the shape
  of its attested state). The GPU time is written to `job_timings` under the direction whose source is the chain
  (`observation-<id>`), so it counts toward that direction's `limits.gpuBudgetUsdPerDirectionPerDay`, the
  `/billing` breakdown and `/benchmarks`.
- **Bounds.** At most `seal.observation.maxProofsPerVersionPerDay` (default 4) tries for one version in 24 hours,
  `seal.observation.retryMinutes` (default 60) apart. A seed waits while the direction's GPU budget is spent; a new fork
  version goes past it (`gpu_budget_bypassed`), because that proof is what lets the gate seal.
- **Posting.** `observe(proof, publicValues)` is simulated from the seal signer and sent through the same port as a seal.
  A proof the registry refuses (its light client moved) is kept and tried again at the next epoch before any new proof.
  A recorded shape the gate does not allow wakes the seal check of that chain at once, which then seals from the registry.
- **Logs and alerts.** `observation_not_needed` (when the reason changes), `observation_check_failed`,
  `observation_proving`, `observation_proved`, `observation_prove_failed`, `observation_refused`, `observation_posted`,
  `observation_reverted`, `observation_send_failed`. A new fork version, its outcome, and a refused or failed post also
  write an `alert` line. A seed is logged only.
- **Public route.** `GET /fork-observations/:chainId/latest` serves the newest proof of a chain: `chainId`, `registry`,
  `lightClient`, `programKey`, `startHeadSlot`, `observedVersion`, `shape`, `shapeAllowed`, `observedAttestedSlot`,
  `foldSteps`, `publicValues`, `proof`, `provedAt` and `postedTransaction` (null until the backend's own `observe`
  succeeded); 404 when there is none. The dapp's Explore page uses it for "Post the fork observation".
- **Switch.** `"seal": { ..., "observation": { "enabled": false } }` turns it off.

Cost: one observation proves a fold of one update per sync committee period since the registry's light client head
(about 22.75 hours each on PulseChain), plus the observation. A fold has at most 64 updates
(`docs/audit/known-issues.md` 1.23), so the module keeps that light client within one period (next section).

### The registry light client's keep-alive

The fork registry reads its own light client (a light client of PulseChain on PulseChain). Anyone can update it from the
dapp (route step "Fork registry light client update"); the module posts the update only when nobody did for one sync
committee period (`seal/registry-watch.ts`, owner's planner call of 2026-11-11: "registry light client every period
(about 22.75 h)"):

- **When.** Once per epoch it reads the light client's head (`head()`, `headers(head)`, `syncCommittees(period + 1)`,
  `programVKey()`, its clock). Younger than one period (`slotsPerPeriod` x `secondsPerSlot`, 81,920 s on PulseChain):
  nothing (`registry_keepalive_not_needed`, once per change).
- **How.** It asks the step service (`POST /steps/requests` without the caller limit) for a `registry-light-client-update`:
  it joins a job that runs, or starts `zk-bridge-prover prove --route <the chain's outgoing route> --head-slot ...
  --head-root ... --next-committee-hash ... --program-vkey ... --to stdout` on the remote endpoints of the proving jobs. It
  is a liveness proof: it goes past the direction's GPU budget (`gpu_budget_bypassed`). The GPU time is written to
  `job_timings` (`registry-<id>`) under the direction whose source is the chain.
- **Posting.** `update(proof, publicValues)` on the light client is simulated from the seal signer and sent through the
  same port as a seal. A simulation that reverts means the head moved (someone posted first): nothing is sent
  (`registry_keepalive_refused`).
- **Logs and alerts.** `registry_keepalive_due`, `registry_keepalive_waiting` (the service refused, with its reason),
  `registry_keepalive_prove_failed`, `registry_keepalive_posted`; `registry_keepalive_reverted` and
  `registry_keepalive_send_failed` also write an `alert` line.
- **Switch.** `"seal": { ..., "registryKeepAlive": { "enabled": false } }` turns it off. It needs the proving endpoints
  (`remote`), like the observations.

## Secrets

A secret is never in the file. The file names the environment variable, and the backend reads the value at start.

| Variable (default name) | Set by field | Use |
| --- | --- | --- |
| `RUNPOD_API_KEY` | `apiKeyVariable` of an entry of `remote.endpoints`, or `runpodApiKeyVariable` with `remote.endpoint` | The key of a proving endpoint. Each entry with a key names its own variable; an entry without one (a dedicated worker on its TCP port) needs none. A key reaches the prover only through the environment of the child process. |
| `BACKEND_WEBHOOK_BEARER` | `webhookBearerVariable` | The bearer value that the prover sends to the webhook. At least 32 bytes. The backend refuses to start with less. |

The endpoints in `rpcUrls`, `beaconUrls`, `stateUrls`, `headerRpcUrls`, `handoffUrls`, `handoffArchiveUrls`, `msgboardUrl`, `remote.endpoints` (every entry), `remote.endpoint`
and `indexerUrl` can carry a key. They stay in the file, so protect the file. The logger removes every endpoint, and every
long part of its path, from each log line.

## Proving endpoints

The prover tries the entries of `remote.endpoints` in order, one at a time, and moves to the next only when one cannot
give a proof: it is unreachable, it stays not ready past its `readyWaitSeconds`, it runs out of `attempts`, or it turns
the request away (401, 403, 404). A refusal of the job (a 400 or 422 of the worker), a 200 that is not a proof and a
proof that fails the local checks end the job at once: no other endpoint proves it again. The job never goes to two
endpoints at the same time, so the serverless fallback bills nothing while the dedicated worker answers. The full table
is in `docs/gpu-prover.md`, "Endpoint list".

```json
"remote": {
  "endpoints": [
    { "label": "dedicated", "url": "http://203.0.113.7:40123", "readyWaitSeconds": 20, "timeoutSeconds": 120, "attempts": 2 },
    { "label": "serverless", "url": "https://ENDPOINT_IDENTIFIER.api.runpod.ai", "apiKeyVariable": "RUNPOD_API_KEY" }
  ]
}
```

| Entry field | Meaning |
| --- | --- |
| `label` | The name in the logs: 1 to 32 lower case letters, digits, `-` or `_`. Each label once. The logs never show the URL. |
| `url` | The base URL of the worker. With `apiKeyVariable` it must be `https://` (or `http://` on the local machine). |
| `apiKeyVariable` | Optional. The NAME of the variable with the key. Without it the prover sends no `Authorization` header. |
| `readyWaitSeconds` | Optional. The longest wait for a worker that answers "not ready". Default 900. Keep it short for a dedicated worker. |
| `timeoutSeconds` | Optional. One request. Default 360. |
| `attempts` | Optional. Requests after ordinary failures before the prover moves on. Default 3. |
| `startWaitSeconds` | Optional. The start wait of a GPU tier. The prover pings the endpoint until a worker is ready, then sends the job. After this many seconds it pings the next endpoint too and sends the job to the first that is ready, the earlier one when both are. A whole number of 1 or more, below `readyWaitSeconds` (900 when unset). The backend writes it as `start_wait_seconds`. |

GPU tiers: one RunPod endpoint per price band, cheapest first, each with a start wait but the last.

```json
"remote": {
  "endpoints": [
    { "label": "gpu-24gb", "url": "https://TIER1_IDENTIFIER.api.runpod.ai", "apiKeyVariable": "RUNPOD_API_KEY", "startWaitSeconds": 30 },
    { "label": "gpu-32gb", "url": "https://TIER2_IDENTIFIER.api.runpod.ai", "apiKeyVariable": "RUNPOD_API_KEY", "startWaitSeconds": 30 },
    { "label": "gpu-48gb", "url": "https://TIER3_IDENTIFIER.api.runpod.ai", "apiKeyVariable": "RUNPOD_API_KEY" }
  ]
}
```

The `prove_timing` fields of `job_proved` carry `endpoint` (the label that gave the proof), `failover_count` and
`start_wait_ms` (the time spent pinging GPU tiers before the job was sent).
The warm-up ping goes to the first endpoint only, with its key when it has one: a ping of the serverless fallback would
start a paid worker that a healthy dedicated worker never needs. With the older `remote.endpoint`, the label is `remote`.

## Callers and limits

The backend faces the open internet. It counts each caller in a window of one minute.

- With `trustForwardedHeader` off, the caller is the socket address.
- With it on, the caller is the `X-Forwarded-For` entry `trustedProxyHops` places from the right. Your own proxies add those entries. The entries to the left can be forged by the client, so the backend ignores them. If the header has fewer entries, the backend uses the socket address.
- An IPv6 caller is counted by its first 64 bits, because one person holds a whole /64 network.
- A request with no socket address and no usable header has no known caller. All such requests share one bucket with a low limit (`requestsPerUnknownCallerPerMinute`, default 2).
- `globalRequestsPerMinute` (default 120) caps how many distinct callers may make requests in one minute. A caller counts once however many requests it makes, and a caller already counted in the minute is held only by its own limit, so a few busy addresses cannot lock everyone else out.
- `requestRetentionHours` (default 24) sets how long a request row stays in the database. It must not be shorter than `prover.timeoutSeconds`. The backend prunes at start and every hour, and it keeps the rows of a job that still runs.
- A request body over 4 KiB gets the answer 413.

## When a request starts a job

A request only asks. A request for a direction that has an active job joins that job. Any other request starts a new
job only when the chain indexer (`indexerUrl`) shows that the direction needs a proof:

- a message of the direction waits for finality and no stored head covers it (status `waiting_for_finality`), or
- the light client of the destination holds no head, or a head older than `limits.keepAliveSeconds` (default 43200,
  12 hours). A light client that falls a whole sync committee period behind (about 27 hours on Ethereum, 23 on
  PulseChain) can then move only through the committee handoff updates of the source beacon node, and a node without
  them (the public chain 943 node) strands it for good, so keep the value well below that. `bin/zk-bridge-keepalive.mjs`
  checks and marches the light clients through this API (docs/testnet-run.md, "Keeping the light clients alive").

The reason in the request (`message`, `keep-alive`, `user`, and the backend's own `finality`) does not change this. The backend asks the indexer only after
the caller limits, the finality rule, the retry wait and the daily backstop passed, and one answer serves a direction
for 15 seconds. A request from outside never waits for the watcher's minimum interval (`watch.minIntervalSeconds`): it
starts a job when the finality is new and the indexer shows a need (the urgent reason `requested`, logged as
`job_started` `urgent: ["requested"]`; see "Proving now"). The answers:

| Status | Body | Meaning |
| --- | --- | --- |
| 202 | `{ requestId, jobId, joined? }` | The request started a job, or joined the running one (`joined: true`). |
| 409 | `{ error: "nothing-to-prove", why }` | `why: "no-need"`: no message waits and the head is fresh. `why: "proof-pending"`: a proof we already have waits to land (see "Proofs we already have"). Asking again changes nothing until a message waits or that proof lands. |
| 429 | `{ error: "rate-limited", retryAfterSeconds, why, detail? }` | A limit refused it. `why: "limit"` (a caller limit, the retry wait after a failed job, the daily backstop), `"same-finality"` (a job already proves to the newest finality; `retryAfterSeconds` is when the next one is expected), `"gpu-budget"` (the direction's 24 h GPU budget is spent; `detail` says by how much). `Retry-After` says when to ask again. |
| 503 | `{ error: "cannot-check", retryAfterSeconds }` | The indexer did not answer in 5 seconds, or answered an error or an unknown shape. The backend starts no paid job it cannot justify. |

The job limits (owner, 2026-11-07: "yes to the job limit changes"):

- **One job per new finality and direction.** A job starts only for a finalized slot newer than the newest one a job
  of the direction proves to (the slot its prover reported, else the one planned for it; a failed job does not count).
  The watcher names its finality in the request; a request from outside proves to the newest finality the watcher
  handled, and is refused (`same-finality`) while a job already proves to it. That is at most 225 jobs a day from
  Ethereum or Sepolia (epochs of 6.4 minutes) and 270 from PulseChain (5.33 minutes). Without a watcher the finality
  is not known, and a request from outside starts a job without one; the backstops below bound it.
- `secondsBeforeRetryAfterFailure` (default 60) after a failed job.
- `jobsPerDirectionPerDay`: a backstop of jobs that may pay for a proof, per direction, in any 24 hours. Default: the
  epochs per day of the direction's source chain (225 or 270). A job that found the chain up to date paid nothing and
  does not count.
- `gpuBudgetUsdPerDirectionPerDay` (default 5): before a job starts, the spend of the direction's jobs proved in the
  last 24 hours must be under it. The spend is each job's worker seconds (`worker_total_ms`, else `remote_ms`, else
  its start to its proof, plus the wait for a cold worker) at the GPU rate RunPod billed over the last 7 days
  (`GET /billing`, `effectiveUsdPerHour`), or at `watch.warmup.gpuUsdPerHour` while that cannot be read. A spent budget
  is refused with `why: "gpu-budget"` and a `detail` such as "the 24 h GPU budget of $5.00 for first-to-second is spent:
  $5.04", and logged as `gpu_budget_spent`. A handoff or a keep-alive of the age rule keeps the light client alive and
  goes past it, logged as `gpu_budget_bypassed`. Idle tails and unused warm-ups are not counted (see `GET /billing`).
- `secondsBetweenJobsPerDirection` is deprecated and ignored: one job per finality replaced it. A file that still sets
  it loads, and the start logs `config_deprecated`.

### Proofs we already have

The backend never pays twice for the same proof. Before any job starts (a request from outside, the keep-alive march,
or the watcher), it looks at every proof of the direction it has: the one the msgboard indexer keeps from the board
(`proofs`), the ones the webhook stored (`webhook_proofs`, posted or not), and the slots the newest job's prover
reported. A proof still counts while it starts at the light client's head (it can still land); one that ends at or
below the head is applied already.

- While such a proof waits to land, no job starts from that head, whether the messages to prove lie inside it or after
  it: the runner posts it, and the next proof starts from the head it makes. The service answers `nothing-to-prove`
  and logs `proof_pending` (its slots and `where`: `board`, `stored` or `job`). A pending handoff counts too.
- Once it has waited longer than `limits.pendingProofStaleSeconds` (default 600), it holds nothing back any more:
  `proof_pending_stale` is logged and a new proof from the head may start. Posting it ourselves is not the backend's
  job.
- The watcher names the proof it wants: from the head it read to the finalized slot it acts on. That target gets one
  job per direction, ever (a unique index in SQLite), also after a failure, a retry wait or a restart; a second request
  for it is refused as `duplicate`.
- A proof whose slots another job already brought is not stored a second time: the webhook keeps the first, fails the
  later job with `the same proof is held already`, and logs `proof_duplicate`.

### Copies in the indexer's proof archive

The backend deletes a held proof once its job ends, and deletes the evidence of a message once the message is delivered.
So the explorer indexer keeps a copy of each. It reads `GET /archive/proofs` on the backend's loopback port every few
minutes: the board proof (`proofs`), every `webhook_proofs` row (posted or held), and every `evidence` row. No Caddy
host passes this route on. The nightly export (`deploy/app-server/proofs.sh`) also takes the proofs from a snapshot of
the SQLite file. See docs/proof-archive.md.

### The handoff archive

A light client that missed a sync-committee period border moves again only with the handoff update of each period it
missed (docs/testnet-run.md, "Why a light client strands"). PulseChain nodes serve no light-client routes and prune the
states the prover builds those updates from, so the archive module captures one per period of each source chain:

- Every `handoffCapture.intervalSeconds` (600) it looks at the last `handoffCapture.backfillPeriods` (8) ended periods
  of each source chain (the clock comes from the light client on the other side) and runs
  `zk-bridge-prover handoff-update --route <route> --period <p>` for each one without a record. The record (about
  60 KB) goes into the `handoff_updates` table and stays for good. A failed period waits the interval, doubled with each
  failure, at most 6 hours (`handoff_capture_failed`, with every source the prover tried); `handoff_captured` logs a
  success. `handoffCapture.enabled: false` turns it off; `GET /health` counts the records and the failing periods.
- `GET /archive/handoffs/<chainId>` lists the periods; `GET /archive/handoffs/<chainId>/<period>.json` gives a record
  exactly as stored. They are loopback-only like `/archive/proofs`, which lists the records of the last 7 days for the
  indexer (older ones reach it through the nightly snapshot).
- Every prover run of the backend names the archive as `source.handoff_archive_urls`: this backend's route, then
  `<indexerUrl>/api/proofs/handoffs`, then `handoffArchiveUrls`. `handoffUrls` (per chain) adds beacon APIs asked for a
  handoff update and for states (`source.handoff_urls`).
- The watcher's planner asks the same sources (`readHistoryFrom` in `src/keepalive/sources.ts`), so "stranded" means
  none of them has the period; its reason lists each source by host and what it answered.

### The fork proof archive

Owner, 2026-11-10: "yes, and save fork proofs in the watcher too". Every message proof carries the fork proof of the
state of its source block (`MessageProof.sourceFork`, `docs/audit/known-issues.md` 1.22). PulseChain nodes prune old
states and an Ethereum mainnet state is hundreds of MB, so a message left unproven for long could become unprovable. The
archive module saves the proof while the state is fresh (`src/archive/fork-proofs.ts`):

- Every `forkProofCapture.intervalSeconds` (120) it reads, like the watcher, the messages of each direction from the
  chain indexer (`GET /api/feed`, statuses `waiting_for_finality` and `covered`: older than the finality window and not
  delivered; up to 5 pages of 200, newest first). For each source block without a record, oldest first and once per
  block, it runs `zk-bridge-prover fork-proof --route <route> --tx <hash>`. The record (about 1 KB) is checked again
  (`checkForkProofRecord` of `@zk-bridge/shared/prover`) and goes into the `fork_proofs` table, keyed by chain and state
  root, for good. Several messages of one block share it. A failed block (not final yet, or no node gives the proof)
  waits the interval, doubled with each failure, at most 6 hours (`fork_proof_capture_failed`); `fork_proof_captured`
  logs a success. A direction whose source has no beacon endpoint, a backend without `indexerUrl`, and
  `forkProofCapture.enabled: false` capture nothing (`fork_proof_capture_off` says why). `GET /health` counts the records
  and the failing blocks.
- `GET /archive/fork-proofs/<chainId>/<stateRoot>.json` gives a record exactly as stored. It is loopback-only like
  `/archive/proofs`, whose field `forkProofs` lists the records of the last 7 days for the indexer (older ones reach it
  through the nightly snapshot, table `fork_proofs`).
- Every prover run of the backend names the archive as `source.fork_proof_archive_urls`: this backend's route, then
  `<indexerUrl>/api/proofs/fork-proofs`, then `forkProofArchiveUrls`. The `evidence` command asks it after a held state and the
  multiproof route of the nodes and before it downloads a whole state (prover README, "The `fork-proof` command"), and
  checks every record against the state root of the source header.
- Load: one `fork-proof` run per source block that carries a message. The prover asks the compact multiproof route first
  (about 1 KB, served by Lodestar) and reads the whole state only from a node without it (about 4.5 MB on the testnets).

## Proving on finality

The requests module also starts proofs on its own, within seconds of the source chain finalizing what a proof needs.
Per direction it watches the source beacon node and, on each new finalized header, starts a job through the same path
as `POST /requests` (reason `finality`, caller `watch`), so the gates above apply unchanged.

- **How it learns of finality.** The beacon event stream (`/eth/v1/events`). When the node does not serve it, holds its
  headers for 10 s, closes it, or sends nothing for three slots, the backend polls every slot (12 s on Ethereum and
  Sepolia, 10 s on PulseChain) and tries the stream again after 5 s, doubling up to 5 minutes. `watch_transport` in the
  log says which one runs.
- **What it reads.** On a node that serves `/eth/v1/beacon/light_client/finality_update`, that update: the one the
  prover takes. On a node that does not (the PulseChain nodes), the newest block and the sync aggregate of the block
  after it, as the prover builds its update there. A new finalized slot then counts one block later.
- **When it starts a job.** At least 342 of the 512 sync committee members signed (the light-client program's
  two-thirds rule), and either a waiting message lies between the light client head and the new finalized header and
  its batch is due (see "Batching and profit"; by default at once), or
  the keep-alive planner (`src/keepalive/plan.ts`) calls for a proof that can make progress: the source finalized a
  header in a sync-committee period after the head's (or handoff steps are needed), the head is older than
  `limits.keepAliveSeconds`, or the light client has no head. A young head in the period of the source's finality starts
  nothing, however close its deadline: such a proof moves the head inside the period and hands off to no new committee
  (`proof_not_due` names the next possible handoff). Only a handoff skips the indexer's age rule (`plannedHandoff`); a
  keep-alive of the age rule meets it like any request. The watcher starts at most one keep-alive per period of the
  source's finality unless the head has aged past the keep-alive age. While a proof we have still starts at the head,
  nothing starts from that head (see "Proofs we already have"). One finalized header starts at most one job, and no
  job starts while one runs.
- **Warm-up.** The backend wakes the remote prover (`GET <first endpoint>/ping`, with that endpoint's key if it has one) a learned
  lead time before a proof is expected, and keeps the worker warm until the job starts.
  - *When a proof is expected:* the first moment at which the real decision (`decideProof`) would say due, asked for
    the future. One function, `warmupPlan` (`src/watch/decide.ts`), collects the moments that can change the answer
    (now, the expected finality of each waiting message, the end of the minimum interval and the moment the batch is
    expected to pay, the finality that crosses into a new sync-committee period, and the moment the request service
    admits a new job) and calls `decideProof` at each with the finalized slot expected then. So the warm-up applies the
    same rules as the proof: the finality and the signatures, the minimum interval since the last proof, the
    profitability rule (fees that cannot be valued pay early only through a tip at the automatic maximum), a proof we hold, the retry wait after a failed
    job and the spacing and the daily budget of jobs (`RequestService.admitAfterSeconds`), a finality a job started
    for already (no second warm-up for it) and the one keep-alive per period. Where `decideProof` would not prove,
    there is no warm-up. A keep-alive of the age rule gets none.
  - *Lead time:* the p75 (`warmup.leadP`) of the last 20 (`leadObservations`) observed times to a ready worker plus
    5 s (`leadMarginSeconds`), clamped to 20 to 600 s; 90 s until there is one. The p90 and no margin (before
    2026-11-06) left the worker ready 25 s before the due time on average; `scripts/warmup-replay.sh` replays the stored
    sessions with other settings (see "Measuring the warm-up"). Observations, kept in the `warmup_observations` table: the time
    from a session's first ping to its first ready answer (200), when that took 5 s or more (a faster one found a
    worker that was up already); the time a ping waited before it timed out (a cold start at least that long); and
    `wait_worker_ms` of a job that met a cold worker (`not_ready_count` above 0) while no warm-up ran.
  - *Session:* one per direction, started at the due time minus the lead time. One ping is outstanding at most; it
    waits up to `pingTimeoutSeconds` (300 s), because the load-balancing endpoint holds it while a worker starts. Until
    a worker answers ready, the ping repeats every 30 s after an answer. Once ready, a ping 40 s after the last ready
    answer (`holdIntervalSeconds`, under the endpoint's 60 s idle timeout) keeps the worker; a ping to a warm worker
    answers at once. A hold not answered ready, or failed, is followed by the next no sooner than 30 s later. The
    session ends when the job starts (`warmup_used`), when the message is delivered or covered, when the plan has no
    proof within the lead time and a ping interval (`unusable`: the decision says not due, for example the minimum
    interval or the retry wait: ended at once, and a new session starts when the proof is within the lead time), when
    the due time is past by 45 s (`graceSeconds`), or when the daily cap is spent (each `warmup_wasted`). A ping
    that times out ends the session, and no new one starts for 5 minutes. Sessions are kept in `warmup_sessions`, with
    the billed time estimated at their end (from the start to the end plus `idleTimeoutSeconds`); a restart ends the
    ones left open.
  - *Cost cap:* at most `dailyCapSeconds` (1 hour) of sessions in any 24 hours, both directions together. Over it, no
    session starts (`warmup_capped`, once per target) and a warm one stops at its next hold.
  - *The idle timeout is owned here.* `idleTimeoutSeconds` (default 5) is the one place to set it: at start-up the backend reads
    each RunPod endpoint's settings and, when `idleTimeout` differs, sets it (see "Tuning the idle timeout"). The backend
    never changes `workersMin` or `workersMax`.
- **The log.** `finality_seen` (slot, `source` sse or poll, `latencyMs` from the start of the signature slot),
  `proof_due` (why; for a message `trigger` profit or interval, `batch`, `waitedSeconds`, `feesUsd`, `costUsd`; for a
  handoff or keep-alive that took waiting messages along, `riders`), `proof_not_due` (why, at debug level unless
  signatures are short, the light client is stranded, a batch waits for the minimum interval (`min-interval`, with
  `messages`, `feesUsd`, `costUsd`, `startAt`, `startWhy`, `lastProofAt` and `dueAt`) or a proof we have waits to land
  (`proof-pending`)), `proof_pending_stale`, `watch_economics_failed` (the prices could not be read: the batch waits
  for the interval), `config_deprecated` (at the start, for each `maxWaitSeconds` the configuration still names),
  `job_started` (`reason: "finality"`, `latencyMs` from the arrival of the finality event; the aim is under 5 s), and
  for the warm-up: `warmup_scheduled` (why, `dueAt`, `leadSeconds`, `leadBasis` default or observed), `warmup_ping`
  (a non-ready answer: the status only; the address and the key never appear), `warmup_ready` (`readySeconds`, `cold`),
  `warmup_held` (`holds`, `secondsToDue`), `warmup_used` (`warmSeconds`, `readyBeforeDueSeconds`), `warmup_wasted`
  (`reason` covered, unusable, grace or cap, `warmSeconds`), `warmup_capped`, `warmup_ping_timeout`, `warmup_ping_failed`, and
  from a finished job `warmup_observed` (a cold start learned from `wait_worker_ms`) or `warmup_missed` (a job met a
  cold worker although a warm-up ran). The sum of `warmSeconds` is what the warm-ups cost.

Settings, all optional (`watch` in the configuration file):

| Key | Default | Meaning |
| --- | --- | --- |
| `enabled` | on when `indexerUrl` and the beacon endpoint of each watched source chain are set | `false` turns it off; `true` makes a missing endpoint a start error. |
| `directions` | both | `["first-to-second"]` or `["second-to-first"]` to watch one. |
| `sse` | `true` | `false` polls only. |
| `pollSeconds` | one slot of the source chain | The poll interval while no stream runs. |
| `scanSeconds` | 15 | How often the warm-up looks at the sent messages. |
| `minIntervalSeconds` | 0 | The fallback of a batch that does not pay: prove once the direction's last proof started at least this long ago (rolling, not clock hours). With no waiting message nothing proves, however long ago the last proof was. 0 proves at the first finality that covers a waiting message. |
| `maxWaitSeconds` | none | Deprecated: the old name of `minIntervalSeconds`, read as it on the same level (`minIntervalSeconds` wins when a level names both). The start log warns (`config_deprecated`) with the key to rename. |
| `lookaheadSeconds` | one epoch of the source chain (384 s, 320 s on PulseChain) | How far ahead messages that are not final yet count toward the time a batch is expected to pay. |
| `profitMargin` | 1.0 | A batch proves early when its fees reach the cost times this. |
| `unpricedAtMaximumPays` | `true` | Whether a message whose token has no price and whose tip is at the automatic maximum (1% of the amount) makes its batch pay at once. `false`: such a message waits for `minIntervalSeconds` like any other; priced fees still count. Resolved like `minIntervalSeconds`: a direction's value beats its pair's, a pair's beats the global one. The testnet pair sets it to `false`, so the traffic bot's transfers share one light-client update an hour per direction. |
| `pairs` | none | Overrides per pair and per direction: `{ "sepolia-pls943": { "minIntervalSeconds": 3600, "directions": { "first-to-second": { "minIntervalSeconds": 1800 } } } }`. A direction's field beats its pair's, a pair's beats the global one. Unknown pair names and directions are refused. |
| `warmup.enabled` | `true` | `false` sends no ping. |
| `warmup.leadP`, `leadObservations`, `leadMarginSeconds` | 0.75, 20, 5 | The quantile of the newest observations that the lead time takes, and the seconds added to it. A higher quantile or margin spares the proof a wait and costs idle GPU time. |
| `warmup.defaultLeadSeconds`, `minLeadSeconds`, `maxLeadSeconds` | 90, 20, 600 | The lead time without observations, and its bounds. |
| `warmup.holdIntervalSeconds` | `idleTimeoutSeconds - 2`, at least 1 (3) | The ping that keeps a warm worker, after its last ready answer. Must be below `idleTimeoutSeconds` (the start-up refuses the file otherwise); leave it out and it follows the idle timeout. |
| `warmup.intervalSeconds`, `graceSeconds`, `minGapSeconds` | 30, 45, 300 | Ping again while no worker is ready; end after the due time; the pause after a timed-out ping. |
| `warmup.idleTimeoutSeconds` | 5 | The RunPod endpoint's idle timeout in whole seconds (1 to 3600): a worker is billed this long after its last request. The backend sets the endpoint to it at start-up; the billing breakdown uses it too. |
| `warmup.syncIdleTimeout` | `true` | `false` only reads the endpoint's idle timeout and warns (`runpod_idle_timeout_differs`) when it differs; nothing is changed at RunPod. |
| `warmup.gpuUsdPerHour` | 2.25 | The GPU price, for the unused-worker cost of `/billing` when RunPod's billing cannot be read. |
| `billing.refreshSeconds` | 3600 | How often RunPod's billing (REST, two requests per endpoint) and the balance (GraphQL) are read. RunPod's REST API has a daily request limit, so this is slow. `/billing` never calls RunPod. |
| `billing.retrySeconds` | 900 | How long to wait after a failed read. After a 429 (the daily limit) the backend waits for the next refresh instead. |
| `warmup.dailyCapSeconds` | 3600 | The most warm-up seconds in any 24 hours, both directions together. |
| `warmup.pingTimeoutSeconds` | 300 | How long one ping may wait for a cold worker. |
| `warmup.leadSeconds` | none | The fixed lead time of before 2026-11-01. Still accepted; it does nothing and the start log warns (`config_ignored`). |

`limits.pendingProofStaleSeconds` (600) belongs to the same rules: see "Proofs we already have".

The keep-alive timer (docs/testnet-run.md, "Keeping the light clients alive") stays as the backstop.

For a missed period the planner asks every handoff source in the prover's order (beacon node, states, `handoffUrls`,
the handoff archive) and reports `stranded` only when all of them lack it, with what each answered; a source that cannot
be reached makes the read fail and retry instead. Each decision also records the light client's deadline (`deadline`
on the pipeline wire).

### Batching and profit

A message proof pays for itself only when the fees of the messages it carries cover what it costs. With
`minIntervalSeconds` above 0 the watcher asks three questions of a direction at each finality, in the owner's words "is
there a bridge? is it profitable? has it been an hour", where the hour runs from the last proof ("no, the last proof
was in a previous hour"):

- **The batch** is every waiting message the light client head does not cover. Its **fees** are what the fee address
  receives: the fee in each message's delivery terms (the delivery router's `expectedFee`, for a message sent to the
  router), valued in dollars by the one price source of `@zkb/core` (`token-pricing.ts`: PulseX pools read through the
  backend's PulseChain client at one named block, with the dapp's four price states and its 10-minute stale rule) and
  judged by the one tip verdict (`tip-verdict.ts`), the same as the dapp and the delivery runner. A message whose token
  (or the destination's coin) has no price, a testnet's included, cannot be valued: its tip **pays when it is at least
  the frontend's automatic maximum, 1% of the amount**, and such a message makes its batch pay, so the batch proves at
  its finality (owner, 2026-11-09: "yes, deliver straight away"); a smaller tip counts nothing. Its **cost** is the proof
  (`PROOF_COST_USD`, $0.025) plus the delivery gas of each message on the destination (`deliveryGasUsd` at the newest
  base fee, the chain's minimum tip and the **delivery gas**), times `profitMargin`. The delivery gas is **500,000** (the
  start figure of `deploy/gas-defaults.json`; forge measures a plain token delivery at 469,247 gas to a new recipient and
  452,134 to an existing holder, the first delivery through the router at 552,261) until the destination chain's recent
  deliveries are known: from **10 recorded deliveries through the delivery router** on, it is their **90th percentile**
  (the newest 200 receipts, read from the chain indexer's `GET /api/delivery-cost?chainId=`, kind `token_callback`),
  above or below 500,000. The log line `watch_delivery_gas` names the source (`start` or `measured`), the figure and the
  sample count whenever they change; an unreadable indexer gives the start figure and a `watch_delivery_gas_unreadable`
  warning. The
  runner that delivers is not paid by us: "pays" means the fee address's take covers our costs. Dollars are integers
  (USD × 1e18), as in `@zkb/core`.
- **Nothing waits:** no final message the head does not cover. Nothing proves, however long ago the last proof was,
  and no worker is warmed ("if there were no transfers over the bridge that are waiting from the last hour or before
  then do nothing"). Only a due handoff or the age keep-alive (`limits.keepAliveSeconds`) can prove then.
- **Due** at a finality that covers a waiting message when the fees of the messages final by its slot reach the cost,
  or one of them has no price and a tip at the automatic maximum (`trigger: "profit"`, at once, inside the interval
  too; the detail then reads "a tip of at least 1% of the amount pays (no price for the token)"), or when the direction's **last proof** started at least
  `minIntervalSeconds` ago (`trigger: "interval"`; at once when the direction has no proof). The last proof is the
  newest job of the direction in the `jobs` table, whatever asked for it (a message, a handoff, a keep-alive, a user),
  except a job that failed or ended on chain without a proof; it is read on each decision, so a restart keeps the
  interval. A message that arrives long after the last proof is therefore proven at its finality, with no extra wait.
  Inside the interval the batch is due at the last proof plus `minIntervalSeconds` (`dueAt`); the watcher wakes itself
  then when no new finality comes first, and the proof covers every message final by then.
- **Looking ahead.** Messages that are not final yet, within `lookaheadSeconds`, count toward the time the batch is
  expected to pay: the expected finality at which the fees of the final and the soon final messages first cover the
  cost, or a message with a tip at the automatic maximum is final. The watcher then waits for that finality rather than proving part of the batch, unless the interval ends
  first, and the warm-up is timed to it (else to `dueAt`, and never before the batch's first finality). A proof can only target a finalized header, so such a message is never proven
  before its finality.
- **Unknown prices** (no PulseChain endpoint, no route, an RPC error and no price from the last 10 minutes) value no
  fee: only a tip at the automatic maximum proves early, any other waits for the interval, and the reason is in
  `proof_not_due`.
- **Which profit rule applies where.** `profitMargin` is the backend's: the fees the fee address takes against the
  proof and the delivery gas. The delivery runner judges its own gas with `runner.maximumLossPercent` (the tip against
  what it spends), and the dapp's low-tip warning asks for twice the total cost. The unpriced rule (1% of the amount) is
  the same in all three; the shared fixture `core/vectors/tip-verdict-vectors.json` pins it, and
  `test/tip-verdict-parity.test.ts` runs it through the economics reader and the batch plan.
- **Never delayed:** a period handoff and a keep-alive of the age rule prove at once, inside the interval too, and the
  waiting messages ride along (`riders`). They count as a proof: the next interval runs from them.
- **What it means in practice.** With `minIntervalSeconds: 3600` on a testnet (where no fee is valued), a message with
  a tip of 1% of the amount or more proves at its finality; for the others a direction gets at most one message proof
  per rolling hour: a message after a quiet hour proves at its finality, and the ones that follow
  within the hour wait for its end and go together. Quiet hours prove nothing; a handoff still proves on time. On
  mainnet `minIntervalSeconds: 0` with the profit rule proves every waiting message at its finality. With
  `unpricedAtMaximumPays: false` on that testnet pair, even a tip of 1% or more waits for the interval. The rule appears as `unpricedAtMaximumPays` in the `watch_started` log, and in the `rule`
  of `GET /directions/:direction/pipeline`.
- **The wire keeps its first names.** `GET /directions/:direction/pipeline` reports a batch that waits for the interval
  as `trigger: "max-wait"` with `fallbackAt` (the `dueAt`), and `GET /progress/:messageId` as the service
  `batch-max-wait`, so the web app's readers stay as they are. The `decision` object carries the new names.

### Proving now

Owner, 2026-11-07: "3600 is fine for a minimum, but we should have code in place that can say, oh, yes, we should
create a proof for this situation - especially when we are waiting for deposits to be enabled". An urgent reason
(`urgentReasons` in `src/watch/decide.ts`, a list of rules: add a situation by adding a rule) proves before the
minimum interval ends. Everything else still applies: a finality newer than the covered head, 342 signers, no pending
proof from the head, and the request service's gates (one job per finality, the retry wait, the backstop, the GPU
budget).

| Reason | When | Where |
| --- | --- | --- |
| `deposits-locked` | The bridge on the destination chain of the direction reports `depositsOpen() == false`, the light client on the source chain holds a head, and the direction's last proof started at least 600 s ago (`DEPOSITS_LOCKED_RETRY_SECONDS`; the first new finality after a quiet spell proves at once, and a failed opening is not retried every finality). | The watcher. It reads the deposits only when nothing else makes a proof due, so a due proof never waits for the read. `proof_due` `why: "deposits-locked"`; the request carries `urgent`, which takes it past the indexer's need like `plannedHandoff`. |
| `requested` | A user asked through `POST /requests`, the finality is new and the indexer shows a need. | The request service. That path never had the batch rule, so the interval never held it back; `job_started` logs `urgent: ["requested"]`. |

The mapping of `deposits-locked` (the runner's opener, `explorer/bots/src/runner/opener.ts`): the direction S to D
proves blocks of S to the light client on D. The bridge on D names that light client as its own and the light client on
S as its remote one, and `openDeposits` on D proves that the light client on D stored a block of S in whose state the
light client on S already held a head. So the bridge on D opens only after an update of the S to D light client, made
from a finality of S after the light client on S got its first head. The watcher of S to D reads `depositsOpen()` of
the bridge on D (from the deployment file) and the head of the light client on S, each at most once a minute, and stops
reading once the bridge is open (`src/watch/deposits.ts`). A failed read counts as unknown and holds nothing back
(`watch_deposits_read_failed`, once). The warm-up does not plan for it: such a proof meets a cold worker.


## Pipeline reads

Owner, 2026-11-01: "we should also be updating things like indexer.zkb.fi or the frontend to show the progression of
each small piece so that we can show users when they are waiting on server a or service b. this may require us to expose
a bit more information than we are now such as i have the proof but i do not type of get endpoints", and "i look forward
to seeing actual timing from bridges and proofs being generated."

Three read routes of the `requests` module show where each transfer is and how long each step takes. They answer from
the backend database, the watcher's latest decision (kept in memory per direction; a restart forgets it until the next
finality) and the chain indexer (`indexerUrl`, read with a cache of 5 to 60 seconds). Every route answers
cross-origin like the others, names no endpoint, key or path, and allows 60 reads a minute per caller (the same caller
key as `POST /requests`); over it the answer is 429 with `Retry-After`. Times are milliseconds since 1970, durations
milliseconds. `@zkb/data` has the client (`createBackendClient(...).progress`, `.pipeline`, `.benchmarks`) and the zod
schemas (`transferProgressSchema`, `directionPipelineSchema`, `benchmarksSchema`).

### `GET /progress/:messageId`

400 for an identifier that is not 32 bytes of hex, 404 when the indexer does not know the message (or it is of another
pair), 503 when the indexer is not configured or cannot be read.

```json
{
  "messageId": "0xabab…", "direction": "first-to-second", "status": "waiting_for_finality", "slot": 99900,
  "stages": [
    { "key": "sent", "status": "done", "at": 1793498800000 },
    { "key": "final", "status": "done", "at": 1793499628000, "detail": "slot 99900; the source chain finalized slot 99990" },
    { "key": "batched", "status": "done", "at": 1793499990000, "detail": "job 7f3c2a91-…" },
    { "key": "proving", "status": "current" },
    { "key": "proof-ready", "status": "pending" },
    { "key": "update-posted", "status": "pending", "detail": "the light client head is at slot 99000" },
    { "key": "delivered", "status": "pending" }
  ],
  "waitingOn": { "service": "gpu-worker-start", "since": 1793499990000, "eta": 1793500090000,
    "detail": "estimated from recent jobs: a cold worker took 60 s to start; the prover reports its steps when it ends" },
  "job": { "jobId": "7f3c2a91-…", "status": "proving" }
}
```

- `stages`, in order: `sent`, `final` (the source chain finalized the block), `batched` (a job or a proof we hold
  reaches the message), `proving` (the proof is made: the webhook stored it or the prover returned), `proof-ready` (the
  proof is on the msgboard), `update-posted` (the destination light client covers the message), `delivered`. Each is
  `done`, `current` (the first not done) or `pending`; `at` is when it was done, when known. `final.at` is the expected
  finality time of the block (the source chain does not say when it finalized it).
- `waitingOn.service`, what the current stage waits on:

  | Service | When | `eta` |
  | --- | --- | --- |
  | `source-chain-finality` | the block is not final; or the watcher has not acted on a finality covering it yet | the expected finality |
  | `batch-profit` | the batch waits until its fees cover the proof | when the batch is expected to pay |
  | `batch-max-wait` | the batch waits for the minimum interval since the direction's last proof (the name is the first one) | the last proof + `minIntervalSeconds` |
  | `proof-dedup-pending` | a proof we have from the head waits to land; this message goes in the next proof | none |
  | `gpu-worker-start` | the job is queued, or (estimated) a cold worker starts | job start + median prover run |
  | `gpu-proving` | the job runs past the median cold start, or a warm-up had a worker ready | job start + median prover run |
  | `board-post` | "I have the proof but it is not on chain": the proof is stored and is posted to the msgboard | + median webhook-to-board |
  | `light-client-update` | the proof is on the msgboard; a runner posts the update | + median board-to-chain |
  | `delivery` | the light client covers the message; a runner delivers it | + median covered-to-delivered |
  | `none` | delivered, or the delivery ended (`release_failed`; `detail` says so) | none |

  The prover reports its steps only when it ends, so the two GPU services are an estimate from the newest 20 proofs.
  The stage times are computed with the dapp's own functions (`@zkb/core`, `wait-estimates.ts`): the expected finality
  is `expectedFinalityAt`; the prover run, webhook-to-board and board-to-chain medians are left out (no `eta`) with
  fewer than 5 prover runs or when their 90th percentiles add up past 30 minutes; covered-to-delivered needs 5
  deliveries and a 90th percentile under 30 minutes. `test/wait-estimates-parity.test.ts` checks the backend against
  the shared vectors (`core/vectors/wait-estimates-vectors.json`), as the dapp's twin test does.
- `proof`, once a proof reaches the message: `{ startSlot, newSlot, where }`, `where` is `stored` (made, not on the
  board), `board` (on the msgboard, not on chain) or `applied` (the head reaches it).
- `slot` is null when the backend knows no slot clock (no watcher decision and no indexer head).

### `GET /directions/:direction/pipeline`

```json
{
  "direction": "second-to-first", "now": 1793500000000,
  "rule": { "minIntervalSeconds": 3600, "lookaheadSeconds": 320, "profitMargin": 1, "proofCostUsd": "0.025000", "priced": false },
  "batch": { "count": 2, "oldestFinalAt": 1793499400000, "trigger": "max-wait", "eta": 1793503000000,
    "fallbackAt": 1793503000000, "feesUsd": null, "costUsd": null, "detail": "2 messages wait, …" },
  "job": { "jobId": "…", "status": "proving", "step": "gpu-proving", "startedAt": 1793499960000, "elapsedMs": 40000,
    "eta": 1793500060000, "detail": "a warm-up made a worker ready before the job" },
  "latestJob": { "jobId": "…", "status": "proving", "createdAt": 0, "updatedAt": 0, "startSlot": null, "newSlot": null, "error": null },
  "latestProof": { "startSlot": 11463040, "newSlot": 11477760, "where": "board", "since": 1793499880000 },
  "head": { "slot": 11463040, "finalizedSlot": 11478000, "lastUpdateAt": 1793497000000, "lagSeconds": 600 },
  "decision": { "at": 1793499970000, "finalizedSlot": 11478000, "headSlot": 11463040, "due": false, "why": "min-interval",
    "detail": "…", "batch": { "messages": 2, "startAt": 1793503000000, "startWhy": "interval", "dueAt": 1793503000000, "lastProofAt": 1793499400000, "…": "…" } }
}
```

`deadline` is `{ at, hoursLeft, period, headSlot, headPeriod }`: when the destination light client strands if no proof
lands (the first second of the period after the last committee it stores; from then on only handoff updates move it),
from the watcher's latest decision. `hoursLeft` is negative once it passed; `period` is the period it would strand in.
It is null until the watcher read the light client. The dapp shows it on the light client cards; the status service
computes the same deadline from the chain itself.

`deposits` is `{ open, remoteHasHead, waiting, proofDue }` when the latest decision read the destination bridge:
`waiting` while it waits for an update of this direction's light client to open deposits, `proofDue` when that
decision started a proof for it (`decision.why` "deposits-locked"); null when it did not read them (another reason made
a proof due, or no watcher runs).
`rule` is how the direction's proofs start, resolved from the configuration as the watcher resolves it: a batch that
does not pay waits `minIntervalSeconds` since the direction's last proof; it pays when its fees reach (`proofCostUsd`
plus the delivery gas of each message) times `profitMargin`; `priced` is false when the pair has no PulseChain mainnet
side to price tokens on (a testnet), where no fee is valued: a tip of at least 1% of the amount pays, any other waits for
the interval. The dapp's wait timeline reads
it. `batch` is null unless the watcher's latest decision is `min-interval`. `job` is the queued or proving job, or
null. `latestProof` is the proof that reaches furthest among the msgboard indexer's, the webhook's and the newest job's
that did not fail. `head` is null when the indexer cannot be read. `decision` carries the `why` and `detail` of
`proof_due` / `proof_not_due`, and for a due proof `trigger`, `batchSize`, `feesUsd`, `costUsd` and `outcome`
(`job-started`, `job-active`, `keep-alive-this-period`, `duplicate`, `nothing-to-prove`, `rate-limited`, `cannot-check`).

### Tuning the idle timeout

`watch.warmup.idleTimeoutSeconds` decides how long RunPod keeps a worker up, and bills it, after its last request. It
trades two costs. A long timeout pays for the tail after every proof: with 60 s and about one proof an hour, "idle after
job" was $3.22 of $11.54 in 7 days. A short one risks a cold start for the next request: a worker that stopped takes
about 49 s to answer ready (observed), during which a proof waits.

To change it, set `watch.warmup.idleTimeoutSeconds` in the backend config and restart. At start-up the backend reads each
RunPod endpoint (the same endpoints and key as the billing reads), and when `idleTimeout` differs it sets it, logging
`runpod_idle_timeout_set` (`endpointId` first 6 characters, `from`, `to`); when it already matches it logs
`runpod_idle_timeout_ok`. If RunPod cannot be reached the backend logs `runpod_idle_timeout_failed` (the reason, never the
key) and starts anyway. Nothing else needs to change: `holdIntervalSeconds` follows (`idleTimeoutSeconds - 2`, at least 1),
so a warm worker is pinged 2 s before it would stop. A hold interval of `idleTimeoutSeconds` or more is refused at
start-up. `syncIdleTimeout: false` stops the backend from changing the endpoint. `/billing` shows both numbers
(`assumptions.idleTimeoutSeconds`, `assumptions.endpointIdleTimeoutSeconds`, null while unknown) and the status check
"GPU billing" is degraded when they differ.

A rough rule for mainnet: raise the timeout when proofs arrive closer together than the idle timeout plus a cold start (about 5 s
plus 49 s now, so about a minute). Then the gap between two proofs is shorter than what a stop and a restart cost, and
holding the worker is cheaper than starting it again. Look at "starting up" and "idle after job" in `/billing`: a large
"starting up" with a small "idle after job" says to raise it. With a few proofs an hour, keep it low.

Other intervals: `intervalSeconds` (30) applies only while no worker is ready, and a hold that is not answered ready
repeats after the shorter of it and `holdIntervalSeconds`; `pingTimeoutSeconds` (300) only bounds a ping that meets a
cold worker. The 2 s margin between a hold and the stop must cover the ping's round trip: if holds regularly arrive
late, the worker restarts between them, and `warmup_held` followed by a slow `warmup_ready` shows it; raise the idle timeout then.
The billing breakdown applies the idle timeout that was in effect when each job ended: the backend keeps the endpoint's
timeout over time in the `idle_timeout_history` table (`at`, `seconds`). A migration seeds it: 60 s from the beginning, and
5 s from 2026-11-08T01:59:00Z, when the timeout was set to 5 s by hand (a PATCH on the endpoint); at start-up the sync
adds a row whenever the timeout it reads (or sets) differs from the latest row. `warmup_sessions.billed_seconds` stays as
it was stored.

### `GET /billing?days=7`

GPU billing in general (RunPod is read every `billing.refreshSeconds`, one hour by default; `assumptions.billingRefreshSeconds` and `assumptions.billingRetrySeconds` show the times), per UTC day and in total: what RunPod billed, the billed seconds, the effective price of a GPU
hour, the last 24 hours and where the rate comes from. `days` is a whole number from 1 to 30 (default 7); anything else
is a 400. It names no host and no key. The account (`account`: balance, spend limit, spend now, days left) is filled
only for a direct local request, such as the status service on 127.0.0.1; a request that came through Caddy (it has
`X-Forwarded-For`) gets nulls.

```json
{
  "days": 7, "rateSource": "runpod", "usdPerHour": 0.76,
  "assumptions": { "idleTimeoutSeconds": 5, "endpointIdleTimeoutSeconds": 5, "gpuUsdPerHour": 2.25, "gpuUsdPerHourIsFallback": true, "dailyCapSeconds": 3600, "billingRefreshSeconds": 3600, "billingRetrySeconds": 900 },
  "available": true, "ageSeconds": 90,
  "last24h": { "billedUsd": 1.18, "billedSeconds": 5400, "breakdown": { "...": "as in total" } }, "effectiveUsdPerHour": 0.76, "averageDailyUsd7d": 1.7,
  "account": { "balanceUsd": 153.38, "balanceAgeSeconds": 30, "spendNowUsdPerHour": 0, "spendLimitUsd": 80, "daysLeft": 90.2 },
  "total": { "billedUsd": 11.9, "billedSeconds": 52000, "effectiveUsdPerHour": 0.8238,
    "earlyStarts": { "sessions": 31, "used": 26, "unused": 5, "unusedSeconds": 420, "unusedUsd": 0.0887, "waitingSeconds": 380 },
    "breakdown": { "proving": { "seconds": 31000, "usd": 6.54 }, "startingUp": { "seconds": 4100, "usd": 0.87 }, "waitingForProof": { "seconds": 2200, "usd": 0.46 },
      "unusedEarlyStarts": { "seconds": 420, "usd": 0.0887 }, "idleAfterJob": { "seconds": 9300, "usd": 1.96 }, "unaccounted": { "seconds": 4980, "usd": 2.0 } } },
  "byDay": [ { "day": "2026-11-06", "billedUsd": 1.7, "billedSeconds": 7600, "effectiveUsdPerHour": 0.8053,
    "earlyStarts": { "sessions": 5, "used": 4, "unused": 1, "unusedSeconds": 80, "unusedUsd": 0.0169, "waitingSeconds": 60 },
    "breakdown": { "...": "the six buckets of the day, each { seconds, usd }" } } ]
}
```

`rateSource` is `runpod` when the rate is measured from RunPod's billing (amount over billed hours, last 7 days) and
`assumed` when it could not be read; then `usdPerHour` is the configured price. `billedUsd` and `billedSeconds` are null
for a day RunPod has no figure for. `earlyStarts` is the part of it that workers started before a proof account for
(by the day a session started): `unused` counts the sessions that did not end `used`, `unusedSeconds` their billed time
estimated from each session's start to its end plus the endpoint's idle timeout (a session that a restart ended has no
idle part), `unusedUsd` that time at `usdPerHour`, and `readyBeforeDueSeconds` how long a worker sat ready before the due
time in used sessions: the lead that was longer than it needed to be.

`breakdown` (on each day, in `total` and in `last24h`) puts every billed second in one bucket, each `{ seconds, usd }` at
`usdPerHour`: `proving` (the request on the worker, until the proof returned), `startingUp` (cold start before a worker
can take work), `waitingForProof` (a started worker ready and idle until its proof began), `unusedEarlyStarts` (billed
time of sessions with no proof), `idleAfterJob` (the idle timeout after each job, not counted again where a later job or
session overlaps; its tail is the idle timeout of the time the job ended) and `unaccounted` (RunPod's bill minus the five;
null for a period without a RunPod figure). An instant counts in one bucket only; the boundaries and a worked example are
in the header of `src/billing-breakdown.ts`. Session records are kept 7 days, so older days show no early starts.

What makes `unaccounted` meaningful: each period is priced at its own RunPod rate (a day at its day's bill over its billed
hours, the last 24 hours hour by hour), so its seconds and dollars agree and a total is the sum of its days. RunPod's bill
lags, so only time before `billedThrough` (ISO, the start of RunPod's latest hour bucket, which is still filling) is
compared: the records after it are `notYetBilled` (`{ seconds, usd }`, an estimate at the period's rate), and `billed`
is the bill that was compared, which the six buckets add up to. Each breakdown has `billedThrough`, `billed` and
`notYetBilled`. What remains negative is a real disagreement between record and bill, small ones mostly from proving
being an upper bound: a job whose worker reported no `worker_total_ms` (an image that predates the field) is counted by
`remote_ms`, the whole accepted request, which also holds the wait of RunPod's load balancer for a GPU that RunPod does
not bill; hours with such a wait over-claim by about the wait. The load-balancing endpoint returns no `executionTime` or
`delayTime` (those are for queue endpoints), so only the worker's own `timings` fix it. A used warm-up session that never
answered ready claims no time of its own; it counts as start-up (from its start to the job's request) only when the job
that took it was answered "not ready" too. The status page shows
the last 24 hours (`GPU billing`), degraded when `unaccounted` is more than 25% of the compared bill; it says "billing
caught up to 03:00 UTC" when records after that are left out.

### `GET /warmup/summary?days=7` (deprecated)

The old name of `/billing`, with its old body: the worker sessions per day (`sessions`, `used`, `wasted`, `billedSeconds`,
`wastedSeconds`, `idleBeforeDueSeconds`, `estimatedCostUsd`, `wastedCostUsd`) with RunPod's `billing` beside them
(`billedUsd` and `runpodBilledSeconds` per day and in total). Same `days`, same limit, same account rule. Use `/billing`.

#### Measuring the early starts

`scripts/warmup-replay.sh /path/to/backend.sqlite [hours] ["p:margin ..."]` (needs `sqlite3`, only reads) prints the
sessions of the window by outcome with the GPU time they held, and replays the `used` ones with other lead settings from
the stored observations: the average seconds a ready worker idles before the due time, the average seconds a proof waits
for a worker still starting, and the share of proofs that wait. Run it on the server after a change of `leadP` or
`leadMarginSeconds`; the row `recorded` is what ran.

### `GET /benchmarks?window=24h`

`window` is a number and `m`, `h` or `d`, from 1h to 30d (default `24h`); anything else is a 400.

```json
{
  "window": "24h", "windowSeconds": 86400, "from": 1793413600000, "to": 1793500000000, "indexer": "ok",
  "steps": { "workerWait": { "count": 4, "medianMs": 61000, "p90Ms": 95000 }, "…": "…" },
  "byDirection": { "first-to-second": { "…": "…" }, "second-to-first": { "…": "…" } },
  "recent": [ { "jobId": "…", "direction": "first-to-second", "startSlot": 1, "newSlot": 2, "provedAt": 0, "waitWorkerMs": 61000,
    "coldWorker": true, "remoteMs": 38000, "workerProveMs": 33400, "totalMs": 100000, "grindMs": 850, "boardPostedAt": 0,
    "onChainAt": 0, "endpoint": "serverless", "workerGpu": "NVIDIA GeForce RTX 4090" } ]
}
```

Steps: `workerWait` (`wait_worker_ms`), `remote` (`remote_ms`), `workerQueue`, `workerProve` (`worker_prove_ms`, when the
worker reports it), `total` (`total_ms`), `webhookToBoard` (webhook stored → board took it), `boardPost` (the grind of
the board post), `proofToOnChain` (board post → the head update on the destination that stored exactly the proof's
new slot, from the indexer's `/api/head-updates`; a proof without its own update, such as one deduplicated on the board
or posted to a light client that is no longer indexed, is left out rather than matched to a later head), `coveredToDelivered` and `sentToDelivered` (the indexer's delivered
messages of the window). Without the indexer (`"indexer": "unavailable"`) the last three are empty. `recent` lists the
newest 20 proofs of the window.

The numbers come from the `job_timings` table: one row per job, written when the prover returns (the `prove_timing`
fields: `wait_worker_ms`, `not_ready_count`, `retry_count`, `failover_count`, `remote_ms`, `prove_ms`, `total_ms`,
`worker_queue_ms`, `worker_prove_ms`, `worker_total_ms`, `remote_overhead_ms`, the endpoint label and the GPU name) and
when the webhook posts the proof (stored, posted, grind ms). Rows older than 30 days are deleted as new ones arrive.
The prove host passes these routes on (`deploy/app-server/Caddyfile`), and indexer.zkb.fi shows them.

## Route steps

Owner, 2026-11-11 (docs/superpowers/specs/2026-11-11-route-actions-design.md): "you should make them all yes in the dapp.
our ui should show the situation / constraints of each situation and then guide the user through making it happen (using
our backend + gpu to create proofs)". Every on-chain step of the route is permissionless; the dapp lets a visitor make the
proof here and post it from their own wallet. The `requests` module serves four routes for it (`src/steps/`); the shapes
and the client are in `@zkb/data` (`route-steps.ts`: `routeStepsSchema`, `stepJobSchema`, `stepProofSchema`,
`createBackendClient(...).routeSteps`, `.requestStep`, `.stepJob`, `.stepProof`, and `stepFlow`, the guided flow).

| Kind | Subject | Proof | Made by | Fallback poster, deadline |
| --- | --- | --- | --- | --- |
| `light-client-update` | a direction | SP1, GPU | a job of `POST /requests` (`reason: "user"`) | the keep-alive proves it `limits.keepAliveSeconds` (12 h) after the head's last update; the runner posts it |
| `registry-light-client-update` | the chain id of a side with a `fork_registry` | SP1, GPU | `prove` from the registry light client's head | the seal module, one sync committee period (about 22.75 h) after the head |
| `fork-observation` | the chain id of a side with a `fork_registry` | SP1, GPU | `fork-observation` (seal module's table) | the seal module, at once |
| `open-deposits` | a direction: the bridge on its destination opens | `opening-proof`, no GPU | the prover, on request | the runner, as soon as it can |
| `layout-rows`, `deliver` | a message id | `evidence`, no GPU | the archive, on request | the runner, for a paying tip (`deliverUnpaidAfterSeconds` for the rest) |
| `seal` | a chain id | none (beacon evidence or the registry) | the dapp itself | the seal module, at once |

### `POST /steps/requests`

Body `{ pair, kind, subject }` (4 KiB at most). It asks for the proof of one step; a request while a job of the step runs
joins it. The guards are the existing ones:

- the per-caller limit counts this route and `POST /requests` together (`limits.requestsPerCallerPerMinute`); a request
  counts once it started or joined a job;
- a light client update is a request of the request service: one job per finality, the daily job backstop, the GPU
  budget, a proof we already have (answered `nothing-to-prove`, `proof-pending`);
- a registry light client update: one job per head it proves from (a finished proof from the current head is answered
  `ready`), nothing for a head younger than two epochs, `secondsBeforeRetryAfterFailure` after a failed job, the GPU budget
  of the direction whose source is the chain;
- a fork observation: only while the chain runs a fork version the registry does not hold, a proof held for it is
  answered `ready`, `seal.observation.maxProofsPerVersionPerDay` and `retryMinutes` (shared with the seal module's own
  tries), the GPU budget for a first observation (a new version goes past it);
- an opening proof: only while the bridge takes no deposits; a proof made in the last 10 minutes is answered `ready`;
- delivery evidence: answered `ready` when the archive holds it, else one archive pass builds it.

| Status | Body |
| --- | --- |
| 202 | `{ jobId, joined?, ready? }`. `jobId` is `job:<id>` (light client update), `observation:<id>`, `step:<id>` or `ready:<kind>:<subject>`. |
| 400 | `{ error }`: a bad body, another pair, a subject that does not fit the kind. |
| 404 | `{ error: "not-served", detail }`: this backend does not make the kind (no prover for it, no requests module, no indexer). |
| 409 | `{ error: "nothing-to-prove", why }`: `no-need` (the step is not pending) or `proof-pending`. |
| 429 | `{ error: "rate-limited", retryAfterSeconds, why, detail }` with `Retry-After`: `limit`, `same-finality` or `gpu-budget`. |
| 503 | `{ error: "cannot-check", retryAfterSeconds }`: a chain or beacon read failed. |

### `GET /steps/jobs/:jobId`

`{ jobId, kind, subject, status, startedAt, updatedAt, etaAt, error }`. `status`: `queued`, `running`, `done`, `failed`.
`etaAt` (a GPU job that runs): its start plus the median prover run of the newest 20 proofs, plus the median wait for a
cold worker when no worker is warm; null otherwise. `error` is safe to show. 404 for an unknown job.

### `GET /steps/proofs/:kind/:subject`

The finished proof, public fields only; 404 when there is none:

- `light-client-update`: `{ chainId, payload, startSlot, newSlot, provedAt, where }`, the proof message as the board
  carries it (`payload`), from the webhook (`stored`) or the board (`board`), the one that reaches furthest;
- `registry-light-client-update`: `{ chainId, lightClient, programKey, startSlot, startRoot, newSlot, newRoot,
  publicValues, proof, provedAt }`;
- `fork-observation`: `{ observation }`, the view of `GET /fork-observations/:chainId/latest`;
- `open-deposits`: `{ chainId, bridge, calldata, remoteSlot, storedSlot, remoteBlockNumber, provedAt }`;
- `layout-rows`, `deliver`: `{ evidence }`, the archived evidence.

### `GET /route/steps`

`{ now, steps, unread }`: every pending step of both directions, built from the pipeline of each direction, the chain
indexer (the newest 20 covered messages of each direction), the chains (deposits, the registry light client, the gas
price, a simulation of the posting from `0x…dEaD`) and the beacon node (the fork schedule). A read that fails leaves its
steps out and is named in `unread`. One answer serves 15 seconds (a request that started a job drops it). Pending means:

- light client update: transfers wait (`batch`), a proof waits to land, the destination bridge waits for it to open, a
  job runs, or the head is 1 h old;
- open deposits: `depositsOpen()` is false on the destination (`after` names the other direction's light client update
  while that light client has no head yet);
- layout rows / delivery: the message is covered and not delivered (`layout-rows` while its evidence lists rows);
- registry light client update: its head is half a period old;
- fork observation: the chain runs a version the registry does not hold.

Each step: `situation` (`since`, `behindSeconds`, `waitingTransfers`, `blocks` (`sends`, `deliveries`), `strandsAt` (the
stranding deadline of a light client, or 64 periods after the registry light client's head), `layoutRows`,
`activeVersion`, `recordedVersion`), `constraints` (`finality` `{ finalizedSlot, nextAt }`; `gpu` `{ warmMs, coldMs,
workerWarm, budgetUsd, spentUsd, leftUsd }`; `job` to join; `proofReady`; `posting` `{ gas, gasSource, gasPriceWei,
costWei }` with the gas simulated when a proof is ready, else the runner's fallback: 337,000 for an update, 600,000 for a
delivery; `after`) and `fallback` `{ by, at }`. A worker is warm while a warm-up session is ready, or for the endpoint's
idle timeout after the last proof. Reads count toward the 60 reads a minute of the pipeline reads (their own counter).

## Local testing with the oracle setting

The free test prover signs the public values with a test key instead of making a full proof. Its proof has 65 bytes.
A real deployment refuses such a proof. Set `"acceptOracleProof": true` only on a machine that talks to a local chain whose
verifier is the oracle stand-in (see `docs/local-network.md`).

The setting applies to the `webhook` and `msgboard-indexer` modules together:

- The webhook builds the version 2 proof message from a 65 byte proof, and skips the local Groth16 check for it.
- The msgboard indexer keeps and serves version 2 messages.

The `requests` module always starts the prover with the remote backend. For a local run, start the modules
`webhook,msgboard-indexer` with the oracle setting, and send the package of an oracle prover to the webhook of a job
that is `proving`:

```
node bin/zk-bridge-backend.mjs --config backend.local.json --modules webhook,msgboard-indexer
curl -H "Authorization: Bearer $BACKEND_WEBHOOK_BEARER" --data @package.json http://127.0.0.1:8787/webhook/jobs/<id>
```

Never turn the setting on for a public service.
