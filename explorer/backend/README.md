# zk-bridge backend

The backend is one open-source service with four modules. Each module can run alone.

| Module | What it does | Routes |
| --- | --- | --- |
| `requests` | Takes proof requests from dapp pages and runs one proving job per direction. | `POST /requests`, `GET /requests/:id`, `GET /directions/:direction` |
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

The endpoints in `rpcUrls`, `beaconUrls`, `stateUrls`, `msgboardUrl`, `remote.endpoints` (every entry), `remote.endpoint`
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
| 409 | `{ error: "nothing-to-prove" }` | No message waits and the head is fresh. Asking again changes nothing until a message waits. |
| 429 | `{ error: "rate-limited", retryAfterSeconds }` | A limit refused it. `Retry-After` says when to ask again. |
| 503 | `{ error: "cannot-check", retryAfterSeconds }` | The indexer did not answer in 5 seconds, or answered an error or an unknown shape. The backend starts no paid job it cannot justify. |

Two limits remain as a backstop when the indexer reports wrong facts:

- `secondsBetweenJobsPerDirection` (default 120) between the start of two jobs of a direction, and
  `secondsBeforeRetryAfterFailure` (default 60) after a failed job.
- `jobsPerDirectionPerDay` (default 96) jobs that may pay for a proof, per direction, in any 24 hours. A job that found
  the chain up to date paid nothing and does not count.

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
  two-thirds rule), and either a waiting message lies between the light client head and the new finalized header, or
  the keep-alive planner (`src/keepalive/plan.ts`) calls for a proof that can make progress: the source finalized a
  header in a sync-committee period after the head's (or handoff steps are needed), the head is older than
  `limits.keepAliveSeconds`, or the light client has no head. A young head in the period of the source's finality starts
  nothing, however close its deadline: such a proof moves the head inside the period and hands off to no new committee
  (`proof_not_due` names the next possible handoff). Only a handoff skips the indexer's age rule (`plannedHandoff`); a
  keep-alive of the age rule meets it like any request. The watcher starts at most one keep-alive per period of the
  source's finality unless the head has aged past the keep-alive age. A message that a proof already posted to the board
  covers, while that proof still starts at the head, starts nothing. One finalized header starts at most one job, and
  no job starts while one runs.
- **Warm-up.** The backend wakes the remote prover (`GET <first endpoint>/ping`, with that endpoint's key if it has one) a learned
  lead time before a proof is expected, and keeps the worker warm until the job starts.
  - *When a proof is expected:* at the expected finality of each sent message (the start of epoch e + 3, plus one
    slot), and when the source's finality crosses into a new sync-committee period and so makes a handoff due (about
    two epochs after the border, not when the clock crosses it). A keep-alive of the age rule gets no warm-up.
  - *Lead time:* the p90 (`warmup.leadP`) of the last 20 (`leadObservations`) observed times to a ready worker,
    clamped to 30 to 600 s; 90 s until there is one. Observations, kept in the `warmup_observations` table: the time
    from a session's first ping to its first ready answer (200), when that took 5 s or more (a faster one found a
    worker that was up already); the time a ping waited before it timed out (a cold start at least that long); and
    `wait_worker_ms` of a job that met a cold worker (`not_ready_count` above 0) while no warm-up ran.
  - *Session:* one per direction, started at the due time minus the lead time. One ping is outstanding at most; it
    waits up to `pingTimeoutSeconds` (300 s), because the load-balancing endpoint holds it while a worker starts. Until
    a worker answers ready, the ping repeats every 30 s after an answer. Once ready, a ping 40 s after the last ready
    answer (`holdIntervalSeconds`, under the endpoint's 60 s idle timeout) keeps the worker; a ping to a warm worker
    answers at once. A hold not answered ready, or failed, is followed by the next no sooner than 30 s later. The session ends when the job starts (`warmup_used`), when the message is delivered or covered,
    when the due time is past by 90 s (`graceSeconds`), or when the daily cap is spent (each `warmup_wasted`). A ping
    that times out ends the session, and no new one starts for 5 minutes. Sessions are kept in `warmup_sessions`; a
    restart ends the ones left open.
  - *Cost cap:* at most `dailyCapSeconds` (1 hour) of sessions in any 24 hours, both directions together. Over it, no
    session starts (`warmup_capped`, once per target) and a warm one stops at its next hold.
  - *Not done:* the backend never changes the endpoint's `workersMin`; the server holds no RunPod management key.
    Set the endpoint's idle timeout to 60 s (docs/gpu-prover.md); `holdIntervalSeconds` must stay below it.
- **The log.** `finality_seen` (slot, `source` sse or poll, `latencyMs` from the start of the signature slot),
  `proof_due` (why), `proof_not_due` (why, at debug level unless signatures are short or the light client is stranded),
  `job_started` (`reason: "finality"`, `latencyMs` from the arrival of the finality event; the aim is under 5 s), and
  for the warm-up: `warmup_scheduled` (why, `dueAt`, `leadSeconds`, `leadBasis` default or observed), `warmup_ping`
  (a non-ready answer: the status only; the address and the key never appear), `warmup_ready` (`readySeconds`, `cold`),
  `warmup_held` (`holds`, `secondsToDue`), `warmup_used` (`warmSeconds`, `readyBeforeDueSeconds`), `warmup_wasted`
  (`reason` covered, grace or cap, `warmSeconds`), `warmup_capped`, `warmup_ping_timeout`, `warmup_ping_failed`, and
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
| `warmup.enabled` | `true` | `false` sends no ping. |
| `warmup.leadP`, `leadObservations` | 0.9, 20 | The quantile of the newest observations that the lead time takes. |
| `warmup.defaultLeadSeconds`, `minLeadSeconds`, `maxLeadSeconds` | 90, 30, 600 | The lead time without observations, and its bounds. |
| `warmup.holdIntervalSeconds` | 40 | The ping that keeps a warm worker, after its last ready answer. Below the endpoint's idle timeout. |
| `warmup.intervalSeconds`, `graceSeconds`, `minGapSeconds` | 30, 90, 300 | Ping again while no worker is ready; end after the due time; the pause after a timed-out ping. |
| `warmup.dailyCapSeconds` | 3600 | The most warm-up seconds in any 24 hours, both directions together. |
| `warmup.pingTimeoutSeconds` | 300 | How long one ping may wait for a cold worker. |
| `warmup.leadSeconds` | none | The fixed lead time of before 2026-11-01. Still accepted; it does nothing and the start log warns (`config_ignored`). |

The keep-alive timer (docs/testnet-run.md, "Keeping the light clients alive") stays as the backstop.

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
