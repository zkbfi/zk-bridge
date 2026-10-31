# Blue/green deploys for the zkb.fi app server

This is the playbook for putting a new release on the app server (`zkbfi-app`, one Hetzner machine) without losing a
paid proof and without serving an indexer that has not caught up. The scripts are `deploy/app-server/deploy.sh`
(builds and switches a release) and `deploy/app-server/bluegreen.sh` (the steps in this document). Nothing here has
been run on the server yet; see "What is not verified" at the end.

## What went wrong on 2026-10-31, and what stops it now

1. **A deploy restarted the backend while a proof job was in flight.** The prover is a child process of the backend, so
   the restart killed it; the startup sweep (`failLostJobs`) failed the job, and the paid proof was gone.
   Now: `backend-switch` stops new jobs at Caddy, waits until the backend reports no job in flight, copies the
   database, and only then restarts. If jobs do not finish within the wait, nothing is restarted.
2. **A new indexer schema stalled at 0% and `indexer.zkb.fi` returned 503 until a rollback.** The old flow switched
   `current` and restarted the indexer onto a cold schema.
   Now: `indexer-green` fills the new schema on a second port while the old indexer keeps serving. It stops green if
   its progress does not move for 10 minutes, and it does not offer a switch until `/ready` answers 200 and the key API
   routes match the live ones. The switch is a Caddy reload, and the old indexer stays as the fallback.

## One server, so what "blue" and "green" mean

There is one machine. Blue is what runs now; green is the new release, started next to it where that is safe, or
started in blue's place where running two would do harm. Per service:

| Service | Two at once? | Why | Green is | The switch |
| --- | --- | --- | --- | --- |
| Indexer (Ponder) | Yes | Each release has its own Postgres schema | The release's Ponder, transient unit `zk-bridge-indexer-pre`, port 42070 | Caddy upstream file, then reload |
| Backend | No, not on the live database | See below | The release, after a drain | Restart of `zk-bridge-backend` with `current` moved |
| Publisher, runner | No | The runner signs with the wallet key; the publisher posts proofs | The release, after the old one stopped cleanly | Restart of that unit |
| Keep-alive timer | No | A oneshot that asks the backend for proofs | The next run, from the new `current` | Stop the timer during the backend switch |
| Caddy | No | One process owns ports 80 and 443 | The new config, validated | `caddy reload` (atomic: the old config stays if the new one is bad) |
| Release sites | Yes | Two Workers and two channels | `next.zkb.fi` | Promotion to `zkb.fi` |
| docs.zkb.fi | Yes | Content is addressed by CID | The new CID, pinned and checked | DNSLink TXT record |
| Design UI Worker | Partly | One Worker serves both routes | An uploaded, not activated, version | Activate the version |

### Why the backend does not run twice on the live database

The backend keeps its state in one SQLite file (`/var/lib/zk-bridge-backend/backend.sqlite`, WAL mode, 5 s busy
timeout). Two processes can open that file, and the unique index `jobs_one_active_per_direction` keeps them from both
holding an active job for a direction. That is all they share safely. What lives only in a process:

- `recover()` runs at start. It starts every active job that has no `start_slot` yet. A second backend would start a
  second paid proof for the job the first one is running.
- The set of running jobs, and the cached answer of the indexer, are in memory.
- Each process runs the webhook tick and posts stored proofs. Two of them can post the same proof.

So a second backend is safe only on a copy of the database, or when there is no job in flight. `backend-check` uses the
first (an empty scratch database, port 8788, never a job). `backend-switch` uses the second.

A job is in flight when its status is `queued` or `proving`. That includes a job whose proof has been made and waits for
the webhook, and a stored proof that is not yet posted (its job is still `proving`). When no job is `queued` or
`proving`, nothing is lost by a restart: `published` and `on-chain` jobs live in the database.

## Pre-deploy checklist

Do all of it before the build. Stop at the first thing that is wrong.

1. The commit is on the branch you mean to deploy, pushed, and its tests passed (`pnpm` tests in `explorer/`,
   `deploy/app-server/test.sh`).
2. If the commit changes `explorer/backend/src/storage.ts`: the change only adds (`CREATE ... IF NOT EXISTS`). A change
   that drops or rewrites a column cannot be rolled back, because the old release reads the same file.
3. If the commit changes a file under `/etc/zk-bridge` (a new setting, a new secret): put it on the server first, and
   check that blue still starts with it. The release must not need a setting that blue rejects.
4. `bluegreen.sh preflight` passes. It checks free disk (10 GB), the Caddy upstream files, a valid Caddyfile, a live
   indexer and backend, no leftover green or check unit, no keep-alive march, no publisher proof in progress, and
   prints the jobs in flight and the memory available.
5. You know what to do if it goes wrong: the rollback column below. Do not deploy when you cannot watch it for the
   whole run; the longest waits are an hour for green, and 40 minutes for jobs to drain.
6. Run the long steps inside `tmux` on your machine. A dropped SSH session leaves green running (it is a systemd unit),
   and leaves the backend routes normal (the script's exit trap restores them), but it ends the wait.

## The deploy, in order

Each command is `ssh zkbfi-app 'bash -s' -- <command> [<commit>] < deploy/app-server/bluegreen.sh`. `<commit>` is the
full hash printed by the build.

### 0. One-time setup

```sh
ssh zkbfi-app 'bash -s' -- init < deploy/app-server/bluegreen.sh
```

`init` writes `/etc/caddy/upstreams/indexer.caddy` and `backend.caddy` with the routing the Caddyfile had before
(`127.0.0.1:42069` and `127.0.0.1:8787`, from `ZKB_INDEXER_PORT` and `ZKB_BACKEND_PORT` when `/etc/caddy/zkb.env`
sets them). It changes no traffic. Then install the Caddyfile of this branch, run `caddy validate`, and reload. The
Caddyfile imports those two files, and an import of a missing file fails, so `init` comes first. `init` prints which
file `/etc/caddy/Caddyfile` really is; if it is a copy and not a link into `current`, copy the new one by hand.

### 1. Build, without switching

```sh
ssh zkbfi-app 'ZKB_BUILD_ONLY=1 bash -s' -- <git-ref> < deploy/app-server/deploy.sh
ssh zkbfi-app 'bash -s' -- preflight < deploy/app-server/bluegreen.sh
```

`ZKB_BUILD_ONLY=1` unpacks, installs, builds the prover and writes `release.env` (the indexer schema), and stops.
`current` does not move. Note the commit hash it logs.

### 2. Indexer: green, compare, switch

```sh
ssh zkbfi-app 'bash -s' -- indexer-green <commit> < deploy/app-server/bluegreen.sh
```

What it does:

1. Reads the schema of the release (`DATABASE_SCHEMA` from `release.env`, then `indexer.env`, the later wins) and of
   the running indexer (from its process). **If they are the same, it stops with exit code 3**: there is nothing to
   pre-index, because two Ponders cannot share a schema. Deploy with
   `ZKB_SERVICES=indexer deploy.sh <commit>`: a warm restart of a few seconds, which Caddy covers (see Caddy below).
2. Starts `zk-bridge-indexer-pre` with `systemd-run`: the unit file of the release is read, and its user
   (`zkb_indexer`), environment files (the release's `release.env` and `/etc/zk-bridge/indexer/indexer.env`),
   command, and every sandbox setting are copied. Only the port differs: `127.0.0.1:42070`.
3. Waits for `GET /ready` on 42070 to answer 200. While it waits it hashes `/status` every 15 seconds. If the hash does
   not change for 10 minutes (`ZKB_STALL_SECONDS`), green is stopped: that is the stalled backfill of today. If the unit
   exits, it stops too. The overall limit is 2 hours (`ZKB_GREEN_TIMEOUT`). On every failure, blue and Caddy are
   untouched. The script does not print the journal (it can hold endpoint URLs); read it with
   `journalctl -u zk-bridge-indexer-pre --no-pager | tail -n 50`.
4. Compares 16 routes on 42070 against the live indexer: the status code must match, and for a 200 the shape of the
   answer (keys and value types) must match. It prints each route, and `WARN` lines for numbers where green is more
   than 2% behind blue. Read the WARN lines. A green that is `/ready` but far behind on a count is not ready to serve.

The checks are: `/ready` 200 on green, equal status codes and equal shapes on the routes
(`/api/summary`, `/pair`, `/heads`, `/head-updates`, `/light-client-costs`, `/gate`, `/registry`, `/tokens`, `/audit`,
`/escrow`, `/release-events`, `/feed`, `/delivered`, `/undelivered`, `/history`, `/delivery-cost`). Routes with a path
parameter (`/api/tx/...`, `/api/messages/...`) are not compared. Open one message of a recent transfer on green by
hand: `curl -s http://127.0.0.1:42070/api/messages/<id>` through an SSH tunnel.

Then switch:

```sh
ssh zkbfi-app 'bash -s' -- indexer-switch < deploy/app-server/bluegreen.sh
```

It writes `indexer.caddy` with green first and blue as the fallback (`lb_policy first`, active health check on
`/ready` every 5 s, a request held up to 30 s when neither is ready), validates the whole Caddyfile, and runs
`systemctl reload caddy`. It then calls `https://<indexer host>/ready` through Caddy on the machine itself, and puts
Caddy back on blue if that is not 200. A failed validation restores the old file and does not reload.

- **Blue kept:** the old indexer process keeps running, and its schema stays in Postgres. Keep both for at least one
  hour after the switch, and until you have seen a new message appear on `indexer.zkb.fi`. If green dies, Caddy falls
  back to blue by itself.
- **Rollback (until the finish):**
  `ssh zkbfi-app 'bash -s' -- indexer-rollback < deploy/app-server/bluegreen.sh`. It points Caddy at blue alone and
  stops green. This is a reload, with no restart and no downtime.

### 3. Backend: check, drain, switch

```sh
ssh zkbfi-app 'bash -s' -- backend-check <commit> < deploy/app-server/bluegreen.sh
```

It starts the release's backend as `zk-bridge-backend-pre` on port 8788, with the same sandbox and the real
`backend.env`, but on a **scratch database** that the backend's own user creates and the script deletes (a copy of
`backend.json` with another `databasePath` and port). It waits for `/health` to answer 200, waits 20 seconds, prints
the modules that are not `running` on the check instance and on the live backend, and stops. A module that is down on
the check and not on the live one is a reason to stop. It never takes a job: it is empty, and nothing sends it a request.

```sh
ssh zkbfi-app 'bash -s' -- backend-switch <commit> < deploy/app-server/bluegreen.sh
```

In order:

1. Refuses when `zk-bridge-keepalive.service` is running (a march holds a job for up to 6 hours), or when `/health`
   of the live backend fails. Stops `zk-bridge-keepalive.timer` (a run during the drain would get a 503).
2. Records which modules are down now. Sets the exit trap that restores normal routes and restarts the timer.
3. Writes `backend.caddy` in drain mode and reloads Caddy. In drain mode `POST /requests` answers
   `503 {"error":"cannot-check","retryAfterSeconds":30}` with `Retry-After: 30` and the CORS headers (the dapp already
   treats `cannot-check` as "try again"). All other routes go on: `GET /requests/<id>`, `/proofs/latest/*`, the
   webhook host, the archive host, `/health`. Only `POST /requests` can start a job.
4. Waits 15 seconds, then polls the live `/health` every 10 seconds until `lastJobs` shows no `queued` or `proving`
   job on three reads in a row. (One active job per direction exists, and it is always the newest job of its direction,
   so `lastJobs` shows every job in flight.) It prints the direction, status and age of what it waits for. The limit is
   40 minutes (`ZKB_DRAIN_TIMEOUT`: the prover limit of 30 minutes plus 10). If jobs remain, it **restarts nothing**,
   restores the normal routes and exits 1. Try again later; do not force it.
5. Copies the database with `VACUUM INTO` as the backend's user into
   `/var/lib/zk-bridge-backend/backups/` and keeps the newest three.
6. Runs `ZKB_SERVICES=backend deploy.sh <commit>`: `current` moves to the release, the units are installed, and only
   the backend restarts. Caddy holds requests up to 20 seconds while it comes up, so reads do not see an error.
7. Waits up to 2 minutes for `/health` 200, then up to 1 minute for every module that was running to be running.
   If that fails, it goes back by itself: `deploy.sh <previous>` for the backend, the same checks, then exit 1.
8. On exit, whatever happened: normal routes back, timer started.

- **Blue kept:** the previous release directory (`deploy.sh` keeps the newest five) and the database copies. Keep the
  newest copy for 24 hours.
- **Rollback:** `backend-switch <previous-commit>`. It drains the same way, so it does not lose a job either. The old
  release reads the same database; that is safe when the checklist's storage rule held. The copy in `backups/` is for a
  damaged file, not for a normal rollback: restoring it loses every job and proof stored since.
- **If a drain is left on** (the script was killed with `SIGKILL`):
  `ssh zkbfi-app 'bash -s' -- backend-undrain < deploy/app-server/bluegreen.sh`. `status` shows `DRAINING`.

### 4. Publisher and runner

```sh
ssh zkbfi-app 'bash -s' -- bots-switch <commit> < deploy/app-server/bluegreen.sh          # both
ssh zkbfi-app 'bash -s' -- bots-switch <commit> runner < deploy/app-server/bluegreen.sh   # one
```

There is no green beside blue: the runner sends transactions from one wallet, and two would collide on nonces and
deliver twice. The green is the new process started after the old one stopped cleanly.

- **Publisher:** it asks the remote prover for a paid proof (`proving_started` in its log, then `proof_made`,
  `nothing_to_prove` or `proof_discarded`). The script reads the last 6 hours of the journal and refuses while the last
  such event is `proving_started`. After `proof_made` the proof is in its state file and survives a restart.
- **Runner:** it stops after its current step, which can wait for a receipt; the unit allows 330 seconds
  (`TimeoutStopSec`). `systemctl` waits for that, so the stop is the drain.
- The script moves one bot at a time, waits 15 seconds, and checks that the unit is active.
- **Blue kept:** the previous release directory. **Rollback:** `bots-switch <previous-commit> <name>`.

Both bots are restart-safe by design (`docs/bots.md`: no double work beyond a reverted simulation). Still, restart the
publisher only when it is not proving, and the runner only when you have looked at its last log lines.

### 5. Finish the indexer

After the soak (an hour at least, and a new message seen on green):

```sh
ssh zkbfi-app 'bash -s' -- indexer-finish <commit> < deploy/app-server/bluegreen.sh
```

Green is a transient unit and does not survive a reboot, while the real unit `zk-bridge-indexer` still runs the old
release. The finish makes the real unit the one that serves. Ponder holds its schema, so green and the real unit cannot
run on it together:

1. Stops green. Caddy's active check marks it down and sends requests to blue (old schema, still correct data).
2. Runs `ZKB_SERVICES=indexer deploy.sh <commit>`: restarts the real unit on the new schema. The schema is full, so
   this is a warm start, not a backfill. Caddy holds requests for up to 30 seconds meanwhile.
3. Waits up to 10 minutes for `/ready` on 42069, then writes `indexer.caddy` back to the normal single upstream.
4. If the unit is not ready in 10 minutes: stops the unit, starts green again on the same schema, points Caddy at it,
   and exits 1. The site stays up on green; read the journal of `zk-bridge-indexer`.

This step has a window of seconds to a minute, at the point of the restart, where the indexer may answer slowly. It is
the cost of a unit that survives reboots. Do it when traffic is low.

- **Blue kept after the finish:** the old schema, in Postgres. Keep it 7 days. List the schemas with
  `sudo -u postgres psql -d zkb_indexer -c '\dn'`. Dropping one is deliberate and by hand:
  `DROP SCHEMA indexer_<hash> CASCADE;` as `zkb_indexer`, after you have checked the name twice. Nothing in the scripts
  drops a schema.
- **Rollback after the finish:** `ZKB_SERVICES=indexer deploy.sh <previous-commit>` restarts the unit on the old schema,
  which then catches up from where it stopped. How long that takes depends on how long it was idle, and the site serves
  stale data (or 503s) meanwhile. This is why the soak comes before the finish, and why old schemas stay a week.

### While green runs, and `current` has moved

After the backend step, `current` points at the new release but the real indexer unit still runs the old process in
memory. Do not restart `zk-bridge-indexer` by hand in that window: it would start the new release on the new schema,
which green holds. If it crashes and systemd restarts it, that start fails, and Caddy goes on serving green.

## The other services

### Keep-alive timer (`zk-bridge-keepalive.timer`)

Blue and green are the same unit; `current` decides which release a run uses, and each run starts fresh.

- **Check:** `systemctl list-timers zk-bridge-keepalive.timer`, and the status line the unit prints before each run
  (`node bin/zk-bridge-keepalive.mjs status --backend-config /etc/zk-bridge/backend/backend.json`, as `zkb_backend`).
- **Switch:** `backend-switch` stops the timer, and starts it again at the end. A deploy never starts a march itself.
- **Do not deploy while a march runs.** It can hold a job for up to 6 hours; `backend-switch` refuses. The light client
  deadline is more than 7 hours away when a run starts (see the unit file), so waiting is safe.
- **Kept:** nothing to keep. **Rollback:** `systemctl start zk-bridge-keepalive.timer`, after the backend is back.

### Caddy

No second Caddy can run: it owns ports 80 and 443. Blue/green here is the config.

- **Green:** the new Caddyfile or upstream file, checked with `caddy validate` using the environment of
  `/etc/caddy/zkb.env` (the script does this before every reload).
- **Switch:** `systemctl reload caddy`. Caddy loads the new config and swaps it in; a config that fails to load leaves
  the old one running, and open connections are not dropped.
- **Kept:** `<file>.prev` next to each upstream file the script wrote. For the Caddyfile itself, copy it to
  `/etc/caddy/Caddyfile.prev` before you replace it.
- **Rollback:** put the `.prev` file back and `systemctl reload caddy`.
- **Binary upgrades (`apt upgrade caddy`)** restart the process, and a restart drops connections for a moment. Do it
  alone, never in the same window as another step. Certificates are kept in `/var/lib/caddy`.
- Never `systemctl restart caddy` for a config change.

## Hosted sites

These are not on the app server. Each already has a green side by design; the rule is to use it before the public name.

### `next.zkb.fi` and `zkb.fi` (Cloudflare Workers `zkb-fi-next` and `zkb-fi`)

- **Blue:** the signed release now on `zkb.fi` (Worker `zkb-fi`). **Green:** the same release on `next.zkb.fi`,
  signed with the staging key, listing a release on the `next` channel (`docs/release.md`, "Staging").
- **Check:** open `next.zkb.fi`, confirm it shows the version you published and that it verifies; read
  `https://next.zkb.fi/version.json` and compare the `sequence` and the archive CIDs with what `release.sh` printed. Try
  a transfer on the testnet pair through it.
- **Switch:** `promote.sh` (`docs/release.md`, "Promotion"). It keeps the dapp and docs archives byte for byte (the
  CIDs tried on staging) and signs a production `version.json` with sequence = the live one + 1. Production serves the
  exact content that staging tried.
- **Kept:** every released version stays pinned on the kubo node (`zkbfi-<site>-<version>`); nothing is unpinned
  until a newer version has moved users off it.
- **Rollback:** a production rollback is a new, higher sequence that names the older archives, signed with the
  production key. Clients refuse a lower sequence (each landing page keeps its sequence memory), so restoring an old
  `version.json`, or an old Worker version with `wrangler rollback`, does not move users who already saw the newer one.
  Use `wrangler rollback --name zkb-fi` only for the landing page's own HTML, and expect that it does not undo a
  manifest.

### `docs.zkb.fi` (DNSLink)

- **Blue:** the CID in `_dnslink.docs.zkb.fi` now. **Green:** the new docs CID, pinned on the kubo node.
- **Check:** `dig +short TXT _dnslink.docs.zkb.fi` (blue's value); `ipfs pin ls --type=recursive <new-cid>` on the
  server; load `https://<new-cid>.ipfs.dweb.link/` (or another gateway) and open three pages.
- **Switch:** the release publish updates the TXT record to `dnslink=/ipfs/<new-cid>`. The Worker `zkb-fi-docs` only
  redirects to `docs-zkb-fi.ipns.inbrowser.link`, which resolves the record, so it needs no deploy.
- **Kept:** the old CID stays pinned. Never unpin it before the new one has been the answer for a week.
- **Rollback:** set the TXT record back to the old CID. Resolvers cache by TTL; read the TTL before you start, and expect
  that long before everyone sees the change either way.

### Design UI (`zkb-fi-ui`, routes `zkb.fi/ui*` and `next.zkb.fi/ui*`)

One Worker serves both routes, so deploying it changes both at once. Use a version that is uploaded and not active as
green.

- **Green:** `npx wrangler@4 versions upload -c design/ui/wrangler.json` (after `design/ui/build.py` has written
  `dist`). It makes a version without sending traffic to it.
- **Check:** request `https://next.zkb.fi/ui/` with the header
  `Cloudflare-Workers-Version-Overrides: zkb-fi-ui="<version-id>"` (see Cloudflare's gradual deployments) and compare it
  with the live page. Do not use `workers.dev`: it is off in the config.
- **Switch:** `npx wrangler@4 versions deploy -c design/ui/wrangler.json` with 100% on the new version.
- **Kept:** Cloudflare keeps the previous versions. **Rollback:** `npx wrangler@4 rollback -c design/ui/wrangler.json`.

## Never

- Never restart `zk-bridge-backend` (or run `deploy.sh` without `ZKB_SERVICES`, which restarts all four services)
  while a job is `queued` or `proving`. Use `backend-switch`.
- Never start a second backend on the live database file while the first one runs. Its startup restarts the jobs of the
  first.
- Never switch `current` and restart the indexer onto a schema that has not been filled and compared. A new schema is
  built on green first.
- Never run two runners, or two publishers. Never run the runner and a test copy with the same wallet.
- Never `systemctl restart caddy` for a config change, and never edit an upstream file by hand without
  `caddy validate`. The script validates every write.
- Never drop an indexer schema in the same session as the deploy that retired it. Wait the 7 days.
- Never delete a pinned release, an old CID, or the newest database copy during a deploy.
- Never put a secret or a full endpoint URL in a log line, a commit, or this repository. The scripts print host names,
  counts and schema names only.
- Never skip the preflight because the change is small. The two incidents above were small changes.
- Never push or promote from a branch that has not been tested on `next.zkb.fi`.

## Quick reference

| What | Command (all `ssh zkbfi-app 'bash -s' -- ... < deploy/app-server/bluegreen.sh`) |
| --- | --- |
| Where things stand | `status` |
| Checks before | `preflight` |
| Start the new indexer beside the old | `indexer-green <commit>` |
| Send traffic to it | `indexer-switch` |
| Undo that | `indexer-rollback` |
| Make it permanent | `indexer-finish <commit>` |
| Try the new backend on a scratch database | `backend-check <commit>` |
| Move the backend safely | `backend-switch <commit>` |
| Undo it | `backend-switch <previous-commit>` |
| Accept jobs again after a stuck drain | `backend-undrain` |
| Move the bots | `bots-switch <commit> [publisher] [runner]` |

`deploy.sh` also takes `ZKB_SERVICES="backend publisher"` to restart only some services, and `ZKB_BUILD_ONLY=1` to build
only.

## What is not verified

Nothing was run on the server when this was written; the scripts parse (`bash -n`) and the helper logic was exercised
against local stand-ins. Check these on the first real run:

- Caddy: that `import` of a file that defines a snippet works at the top of the Caddyfile on the installed version, that
  `lb_policy first` with the active `/ready` check falls back to blue, and that `lb_try_duration` holds a request while
  both upstreams are down. Run `caddy validate` with the new Caddyfile on the server before anything else.
- Where `/etc/caddy/Caddyfile` comes from (`init` prints the real path).
- Ponder: that `--port` and `PORT` move its port, that `/status` changes while it backfills (the stall check relies on
  it), and that blue and green can share `/var/lib/zk-bridge-indexer/ponder` (the Vite cache) and `generated/`. The
  manual pre-index of 2026-10-31 ran a second Ponder beside the live one; whether it used these same shared paths was
  not checked.
- `systemd-run` accepting every property the script copies from the unit file (a property it rejects fails the start
  at once, with a message).
- The publisher's journal contains the event names `proving_started`, `proof_made`, `nothing_to_prove`,
  `proof_discarded` (they are in `explorer/bots/src/publisher/service.ts`, but the journal format was not read).
- The Worker, DNSLink and design UI commands follow the repository's files and Cloudflare's documented behavior; the
  version-override header and `wrangler rollback --name` were not run.
- That the dapp shows something sensible for the drain's `503 cannot-check` answer.
