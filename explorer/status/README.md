# @zk-bridge/status

The status service of zkb.fi (`status.zkb.fi`). A standalone Node process on the app server, next to the others (not on IPFS). Every 60 seconds it runs a list of checks, stores each result in a small SQLite file, and serves a status page and a read-only JSON API on `127.0.0.1:8790`; Caddy puts `status.zkb.fi` in front.

## Checks

Each check has a timeout and ends as `ok`, `degraded` or `down`, with a latency and one plain sentence. A detail never holds a URL, a key or a long token (`src/sanitize.ts`, applied to every detail before it is stored).

| Section | Id | What it checks |
| --- | --- | --- |
| Services | `indexer-local`, `indexer-public` | `/ready` on 127.0.0.1:42069 and on the public host |
| | `backend-local` | `/health`: the state of each module, the queue |
| | `backend-public`, `webhook` | `/health` on the prove and webhook hosts |
| | `site-next`, `site-main` | the page answers 200; `version.json` has a release sequence that never goes back |
| | `gateway-next`, `gateway-main` | the dapp CID in each channel's `version.json` is served by the IPFS gateway |
| | `unit-<name>` | `systemctl show` of backend, indexer, runner, traffic (if installed), ipfs (the keep-alive timer is retired: the backend's watcher keeps the light clients alive) |
| Chains & light clients | `rpc-<chain>` | latest block and its age |
| | `beacon-<chain>` | newest finalized slot and its age |
| | `lightclient-deadline-<direction>` | time until the light client strands, read from the chain only (no beacon node, no backend), so it still works when either is down; see "Light client deadline" below |
| | `lightclient-<direction>` | head age and the deadline by which the light client must update (the keep-alive planner of `explorer/backend/src/keepalive`, imported) |
| Bridges & gates | `bridge-<chain>` | `depositsOpen()` |
| | `gate-<chain>` | enforcing and the last confirmed epoch (`readGateStatus` of `@zkb/data`); a detection-mode gate is ok (admits sends by design until the chain gains beacon roots or a newer opcode), an enforcing-mode gate that does not enforce is degraded, a sealed gate is down |
| Proving pipeline | `pipeline-benchmarks` | backend `/benchmarks`: last proof and median time per direction |
| | `pipeline-<direction>` | backend `/directions/<direction>/pipeline`: running job, failed job, held proof |
| | `pipeline-deliveries` | indexer: last delivery per direction, transfers in 24 h, oldest undelivered transfer |
| | `prover-runpod` | RunPod REST API `GET /endpoints/<id>`: workers, min and max, GPUs. The endpoint's own `/ping` and `/prove` are never called: they start paid workers |
| Wallets | `wallet-<name>-<chain>` | native balance against the minimum in the configuration |

States: a service that answers slower than `slowSeconds` is degraded; a light client past its keep-alive age or inside its margin is degraded, past its deadline or stranded is down; a transfer undelivered for more than `maxUndeliveredAgeSeconds` is degraded, three times that is down; a wallet under its minimum is degraded and an empty one is down.

## Light client deadline

A light client stores the sync committee of its head period, and of the next one once proven. Once the source chain signs in the period after the last stored one, only handoff updates can move it (it is "stranded" if none are available), and bridge requests made in that window can be lost. `lightclient-deadline-<direction>` (name `<destination label> light client deadline`) reads the light client's facts with `readLightClient` and computes the time left with `deadlineOf` (both from `explorer/backend/src/keepalive`).

| Time left | State |
|---|---|
| more than `lightClients.deadlineDegradedSeconds` (default 43200, 12 h) | ok |
| at most that | degraded |
| at most `lightClients.deadlineDownSeconds` (default 21600, 6 h), or passed | down |

The first label is the chain where the light client lives, the second the source chain it follows:

- `PulseChain testnet v4 checks Sepolia: 5.2 h until stranded (head slot 1234, period 15, strands in period 17)`
- `PulseChain testnet v4 checks Sepolia: stranded 3.1 h ago unless handoff updates move it (head slot 1234, period 15, stranded in period 17)` (down)

## Alerts

Off by default. With an `alerts` section the service POSTs JSON to a webhook when a watched check enters `down` (its previous state was not down):

```json
"alerts": { "webhookUrl": "env:STATUS_ALERT_WEBHOOK_URL", "checks": ["lightclient-deadline-first-to-second"] }
```

- `webhookUrl`: `env:NAME` or a literal URL. The URL is a secret: put it in the env file on the server (`STATUS_ALERT_WEBHOOK_URL=...` in `status.env`), never in the repository. It is added to the values removed from details and logs.
- `checks`: optional list of check ids. Default: every check whose id starts with `lightclient-deadline-`.
- Body: `{ "text": "<name>: <detail>", "content": "<same text>", "check": id, "name": name, "state": "down", "detail": detail, "at": ms }`. `text` serves Slack-style hooks, `content` Discord-style ones. Content type `application/json`, timeout 10 s.
- When a watched check leaves `down` the service posts once more, with `text` `<name> recovered: <detail>` and `state` set to the new state (`ok` or `degraded`).
- No repeat while a check stays down. After a restart the newest stored result of each check is the previous state, so a restart does not post again.
- A failed post is logged as `alert_failed` with the status code or the error message (never the URL) and does not affect the round.

## HTTP

| Route | Answer |
| --- | --- |
| `GET /` | the page (plain HTML, CSS and a small script; the palette of the bridge screen, light and dark) |
| `GET /api/status` | every check by section: state, detail, latency, since when, and the uptime of 24 h, 7 d and 30 d |
| `GET /api/history?check=<id>&window=24h\|7d\|30d` | the bars of a window (the worst state per slice; null where nothing ran), and the non-ok runs of that check. Without `check`, all checks |
| `GET /api/summary` | `{status, message, failing, checks, checkedAt}`. 200 when operational or degraded, 503 when down (or when no check ran for three intervals); `?strict=1` also 503 for degraded |

CORS allows GET, HEAD and OPTIONS from any origin. No answer holds a secret.

## Database

`runs`: one row per run of a check (check, time, state, latency; the detail only when the run was not ok). `current`: the newest result of each check. A daily prune keeps 30 days. About 40 checks a minute is 1.7 million rows in 30 days, roughly 100 MB. Uptime is the share of runs that were not down; the page also has the share that were fully ok (`ok` in the API).

## Configuration

`--config <file>` (JSON, `deploy/app-server/config/status/status.json.example`). Endpoints and keys are `env:NAME` references; the values are in `status.env`. The service has its own copies of the RPC and beacon endpoints and the RunPod key so it reads no other service's files. The chains and contracts come from the deployment file. `lightClients` also takes `deadlineDegradedSeconds` and `deadlineDownSeconds` (above); the optional `alerts` section is described under Alerts.

## Run and test

```sh
pnpm --filter @zk-bridge/status test        # vitest, 100 % coverage
pnpm --filter @zk-bridge/status typecheck
pnpm --filter @zk-bridge/status start -- --config ./status.json
```

## Blind spot

If the server is down, this page is down too. Point a free external monitor (UptimeRobot, Better Stack) at `https://status.zkb.fi/api/summary`; it answers 503 when something is down.
