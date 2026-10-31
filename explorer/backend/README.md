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
| `remote.endpoint` | The remote proving endpoint (the load balancing endpoint of the graphics processor service). |
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
| `RUNPOD_API_KEY` | `runpodApiKeyVariable` | The key of the remote proving service. It reaches the prover only through the environment of the child process. |
| `BACKEND_WEBHOOK_BEARER` | `webhookBearerVariable` | The bearer value that the prover sends to the webhook. At least 32 bytes. The backend refuses to start with less. |

The endpoints in `rpcUrls`, `beaconUrls`, `stateUrls`, `msgboardUrl`, `remote.endpoint` and `indexerUrl` can carry a key.
They stay in the file, so protect the file. The logger removes every endpoint, and every long part of its path, from each log line.

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
  PulseChain) can never move again, so keep the value well below that.

The reason in the request (`message`, `keep-alive`, `user`) does not change this. The backend asks the indexer only after
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
