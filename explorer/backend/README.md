# zk-bridge backend

The backend is one open-source service with four modules. Each module can run alone.

| Module | What it does | Routes |
| --- | --- | --- |
| `requests` | Takes proof requests from dapp pages and runs one proving job per direction, and shows where each transfer is in the pipeline. | `POST /requests`, `GET /requests/:id`, `GET /directions/:direction`, `GET /progress/:messageId`, `GET /directions/:direction/pipeline`, `GET /benchmarks`, `GET /billing`, `GET /warmup/summary` (deprecated) |
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
| `headerRpcUrls` | Optional. More execution RPCs of each chain, by chain identifier, as a list. The prover asks them in order, only for `debug_getRawHeader`, when the RPC endpoint lacks it (the `opening-proof` command needs the raw header of the other chain's block, and the `evidence` command the raw header of a Gloas source block). The prover file names them for both sides of a route (`source.header_rpc_urls`, `destination.header_rpc_urls`). Every header is checked against its block hash. |
| `msgboardUrl` | The msgboard node. The `webhook` and `msgboard-indexer` modules need it. |
| `indexerUrl` | The chain indexer. The `requests` module needs it and refuses to start without it. Without it the archive reports `degraded`. |
| `acceptOracleProof` | Local testing only. See below. Default `false`. |
| `trustForwardedHeader`, `trustedProxyHops` | See "Callers and limits". |
| `limits` | See "Callers and limits". |

## Secrets

A secret is never in the file. The file names the environment variable, and the backend reads the value at start.

| Variable (default name) | Set by field | Use |
| --- | --- | --- |
| `RUNPOD_API_KEY` | `apiKeyVariable` of an entry of `remote.endpoints`, or `runpodApiKeyVariable` with `remote.endpoint` | The key of a proving endpoint. Each entry with a key names its own variable; an entry without one (a dedicated worker on its TCP port) needs none. A key reaches the prover only through the environment of the child process. |
| `BACKEND_WEBHOOK_BEARER` | `webhookBearerVariable` | The bearer value that the prover sends to the webhook. At least 32 bytes. The backend refuses to start with less. |

The endpoints in `rpcUrls`, `beaconUrls`, `stateUrls`, `headerRpcUrls`, `msgboardUrl`, `remote.endpoints` (every entry), `remote.endpoint`
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

The `prove_timing` fields of `job_proved` carry `endpoint` (the label that gave the proof) and `failover_count`.
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
the caller limits, the wait of the direction and the daily budget passed, and one answer serves a direction for 15
seconds. The answers:

| Status | Body | Meaning |
| --- | --- | --- |
| 202 | `{ requestId, jobId }` | The request joined a job or started one. |
| 409 | `{ error: "nothing-to-prove" }` | No message waits and the head is fresh, or a proof we already have waits to land (see "Proofs we already have"). Asking again changes nothing until a message waits or that proof lands. |
| 429 | `{ error: "rate-limited", retryAfterSeconds }` | A limit refused it. `Retry-After` says when to ask again. |
| 503 | `{ error: "cannot-check", retryAfterSeconds }` | The indexer did not answer in 5 seconds, or answered an error or an unknown shape. The backend starts no paid job it cannot justify. |

Two limits remain as a backstop when the indexer reports wrong facts:

- `secondsBetweenJobsPerDirection` (default 120) between the start of two jobs of a direction, and
  `secondsBeforeRetryAfterFailure` (default 60) after a failed job.
- `jobsPerDirectionPerDay` (default 96) jobs that may pay for a proof, per direction, in any 24 hours. A job that found
  the chain up to date paid nothing and does not count.

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
    profitability rule (fees that cannot be valued never pay early), a proof we hold, the retry wait after a failed
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
  - *Not done:* the backend never changes the endpoint's `workersMin`; the server holds no RunPod management key.
    Set the endpoint's idle timeout to 60 s (docs/gpu-prover.md); `holdIntervalSeconds` must stay below it.
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
| `pairs` | none | Overrides per pair and per direction: `{ "sepolia-pls943": { "minIntervalSeconds": 3600, "directions": { "first-to-second": { "minIntervalSeconds": 1800 } } } }`. A direction's field beats its pair's, a pair's beats the global one. Unknown pair names and directions are refused. |
| `warmup.enabled` | `true` | `false` sends no ping. |
| `warmup.leadP`, `leadObservations`, `leadMarginSeconds` | 0.75, 20, 5 | The quantile of the newest observations that the lead time takes, and the seconds added to it. A higher quantile or margin spares the proof a wait and costs idle GPU time. |
| `warmup.defaultLeadSeconds`, `minLeadSeconds`, `maxLeadSeconds` | 90, 20, 600 | The lead time without observations, and its bounds. |
| `warmup.holdIntervalSeconds` | 40 | The ping that keeps a warm worker, after its last ready answer. Below the endpoint's idle timeout. |
| `warmup.intervalSeconds`, `graceSeconds`, `minGapSeconds` | 30, 45, 300 | Ping again while no worker is ready; end after the due time; the pause after a timed-out ping. |
| `warmup.idleTimeoutSeconds`, `gpuUsdPerHour` | 60, 2.25 | The endpoint's idle timeout (billed after the last request) and the GPU price, for the unused-worker cost of `/billing` when RunPod's billing cannot be read. |
| `warmup.dailyCapSeconds` | 3600 | The most warm-up seconds in any 24 hours, both directions together. |
| `warmup.pingTimeoutSeconds` | 300 | How long one ping may wait for a cold worker. |
| `warmup.leadSeconds` | none | The fixed lead time of before 2026-11-01. Still accepted; it does nothing and the start log warns (`config_ignored`). |

`limits.pendingProofStaleSeconds` (600) belongs to the same rules: see "Proofs we already have".

The keep-alive timer (docs/testnet-run.md, "Keeping the light clients alive") stays as the backstop.

### Batching and profit

A message proof pays for itself only when the fees of the messages it carries cover what it costs. With
`minIntervalSeconds` above 0 the watcher asks three questions of a direction at each finality, in the owner's words "is
there a bridge? is it profitable? has it been an hour", where the hour runs from the last proof ("no, the last proof
was in a previous hour"):

- **The batch** is every waiting message the light client head does not cover. Its **fees** are what the fee address
  receives: the fee in each message's delivery terms (the delivery router's `expectedFee`, for a message sent to the
  router), valued in dollars with the dapp's PulseX price rules at one named PulseChain block. A token without a price
  counts nothing; testnet tokens have no price, so a testnet batch never pays. Its **cost** is the proof
  (`PROOF_COST_USD`, $0.025) plus the delivery gas of each message on the destination (`deliveryGasUsd` at the newest
  base fee, the chain's minimum tip and `requiredDeliveryGas` of a release, which errs high), times `profitMargin`. The
  runner that delivers is not paid by us: "pays" means the fee address's take covers our costs. Dollars are integers
  (USD × 1e18), as in `@zkb/core`.
- **Nothing waits:** no final message the head does not cover. Nothing proves, however long ago the last proof was,
  and no worker is warmed ("if there were no transfers over the bridge that are waiting from the last hour or before
  then do nothing"). Only a due handoff or the age keep-alive (`limits.keepAliveSeconds`) can prove then.
- **Due** at a finality that covers a waiting message when the fees of the messages final by its slot reach the cost
  (`trigger: "profit"`, at once, inside the interval too), or when the direction's **last proof** started at least
  `minIntervalSeconds` ago (`trigger: "interval"`; at once when the direction has no proof). The last proof is the
  newest job of the direction in the `jobs` table, whatever asked for it (a message, a handoff, a keep-alive, a user),
  except a job that failed or ended on chain without a proof; it is read on each decision, so a restart keeps the
  interval. A message that arrives long after the last proof is therefore proven at its finality, with no extra wait.
  Inside the interval the batch is due at the last proof plus `minIntervalSeconds` (`dueAt`); the watcher wakes itself
  then when no new finality comes first, and the proof covers every message final by then.
- **Looking ahead.** Messages that are not final yet, within `lookaheadSeconds`, count toward the time the batch is
  expected to pay: the expected finality at which the fees of the final and the soon final messages first cover the
  cost. The watcher then waits for that finality rather than proving part of the batch, unless the interval ends
  first, and the warm-up is timed to it (else to `dueAt`, and never before the batch's first finality). A proof can only target a finalized header, so such a message is never proven
  before its finality.
- **Unknown prices** (no PulseChain endpoint, no route, an RPC error) never prove early: the batch waits for the
  interval, and the reason is in `proof_not_due`.
- **Never delayed:** a period handoff and a keep-alive of the age rule prove at once, inside the interval too, and the
  waiting messages ride along (`riders`). They count as a proof: the next interval runs from them.
- **What it means in practice.** With `minIntervalSeconds: 3600` on a testnet (where nothing pays), a direction gets at
  most one message proof per rolling hour: a message after a quiet hour proves at its finality, and the ones that follow
  within the hour wait for its end and go together. Quiet hours prove nothing; a handoff still proves on time. On
  mainnet `minIntervalSeconds: 0` with the profit rule proves every waiting message at its finality.
- **The wire keeps its first names.** `GET /directions/:direction/pipeline` reports a batch that waits for the interval
  as `trigger: "max-wait"` with `fallbackAt` (the `dueAt`), and `GET /progress/:messageId` as the service
  `batch-max-wait`, so the web app's readers stay as they are. The `decision` object carries the new names.


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
  | `board-post` | "I have the proof but it is not on chain": the proof is stored and is posted to the msgboard | + median grind |
  | `light-client-update` | the proof is on the msgboard; a runner posts the update | + median board-to-chain |
  | `delivery` | the light client covers the message; a runner delivers it | + median covered-to-delivered |
  | `none` | delivered, or the delivery ended (`failed_call`, `release_failed`; `detail` says which) | none |

  The prover reports its steps only when it ends, so the two GPU services are an estimate from the newest 20 proofs.
- `proof`, once a proof reaches the message: `{ startSlot, newSlot, where }`, `where` is `stored` (made, not on the
  board), `board` (on the msgboard, not on chain) or `applied` (the head reaches it).
- `slot` is null when the backend knows no slot clock (no watcher decision and no indexer head).

### `GET /directions/:direction/pipeline`

```json
{
  "direction": "second-to-first", "now": 1793500000000,
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

`batch` is null unless the watcher's latest decision is `min-interval`. `job` is the queued or proving job, or
null. `latestProof` is the proof that reaches furthest among the msgboard indexer's, the webhook's and the newest job's
that did not fail. `head` is null when the indexer cannot be read. `decision` carries the `why` and `detail` of
`proof_due` / `proof_not_due`, and for a due proof `trigger`, `batchSize`, `feesUsd`, `costUsd` and `outcome`
(`job-started`, `job-active`, `keep-alive-this-period`, `duplicate`, `nothing-to-prove`, `rate-limited`, `cannot-check`).

### `GET /billing?days=7`

GPU billing in general, per UTC day and in total: what RunPod billed, the billed seconds, the effective price of a GPU
hour, the last 24 hours and where the rate comes from. `days` is a whole number from 1 to 30 (default 7); anything else
is a 400. It names no host and no key. The account (`account`: balance, spend limit, spend now, days left) is filled
only for a direct local request, such as the status service on 127.0.0.1; a request that came through Caddy (it has
`X-Forwarded-For`) gets nulls.

```json
{
  "days": 7, "rateSource": "runpod", "usdPerHour": 0.76,
  "assumptions": { "idleTimeoutSeconds": 60, "gpuUsdPerHour": 2.25, "gpuUsdPerHourIsFallback": true, "dailyCapSeconds": 3600 },
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
session overlaps) and `unaccounted` (RunPod's bill minus the five; negative when our records claim more than was billed;
null for a period without a RunPod figure). An instant counts in one bucket only; the boundaries and a worked example are
in the header of `src/billing-breakdown.ts`. Session records are kept 7 days, so older days show no early starts. The
status page shows the last 24 hours (`GPU billing`), degraded when `unaccounted` is more than 25% of the bill.

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
the board post), `proofToOnChain` (board post → the first head update on the destination at or past the proof's new
slot, from the indexer's `/api/head-updates`), `coveredToDelivered` and `sentToDelivered` (the indexer's delivered
messages of the window). Without the indexer (`"indexer": "unavailable"`) the last three are empty. `recent` lists the
newest 20 proofs of the window.

The numbers come from the `job_timings` table: one row per job, written when the prover returns (the `prove_timing`
fields: `wait_worker_ms`, `not_ready_count`, `retry_count`, `failover_count`, `remote_ms`, `prove_ms`, `total_ms`,
`worker_queue_ms`, `worker_prove_ms`, `worker_total_ms`, `remote_overhead_ms`, the endpoint label and the GPU name) and
when the webhook posts the proof (stored, posted, grind ms). Rows older than 30 days are deleted as new ones arrive.
The prove host passes these routes on (`deploy/app-server/Caddyfile`), and indexer.zkb.fi shows them.

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
