# Blue/green deploys for the zkb.fi app server

How to put a new release on the app server (`zkbfi-app`, one Hetzner machine) without losing a paid proof and without
serving an indexer that has not caught up. The steps are Ansible playbooks in `deploy/ansible/`; `deploy/app-server/deploy.sh`
still builds and switches a release, and the playbooks call it. Nothing here has been run on the server yet; see "What is
not verified" at the end.

## What went wrong on 2026-10-31, and what stops it now

1. **A deploy restarted the backend while a proof job was in flight.** The prover is a child process of the backend, so
   the restart killed it; the startup sweep (`failLostJobs`) failed the job, and the paid proof was gone.
   Now: `backend.yml` stops new jobs at Caddy, waits until the backend reports no job in flight (three reads in a row),
   copies the database, and only then restarts. If jobs do not finish within the wait, nothing is restarted.
2. **A new indexer schema stalled at 0% and `indexer.zkb.fi` returned 503 until a rollback.** The old flow switched
   `current` and restarted the indexer onto a cold schema.
   Now: `indexer.yml` fills the new schema on a second port while the old indexer keeps serving. It stops green if its
   progress does not move for 10 minutes, and it does not switch until `/ready` answers 200 and the key API routes match
   the live ones. The switch is a Caddy reload, and the old indexer stays as the fallback.

## One server, so what "blue" and "green" mean

Blue is what runs now; green is the new release, started next to it where that is safe, or in blue's place after a drain
where running two would do harm.

| Service | Two at once? | Why | Green is | The switch | Playbook |
| --- | --- | --- | --- | --- | --- |
| Indexer (Ponder) | Yes | Each release has its own Postgres schema | The release's Ponder, transient unit `zk-bridge-indexer-pre`, port 42070 | Caddy upstream file, then reload | `indexer.yml` |
| Backend | No | See below | The release, after a drain | Restart of `zk-bridge-backend` with `current` moved | `backend.yml` |
| Publisher, runner | No | The runner signs with one wallet; the publisher posts proofs | The release, after the old one stopped cleanly | Restart of that unit | `bots.yml` |
| Caddy | No | One process owns ports 80 and 443 | The new config, validated | `caddy reload` (the old config stays if the new one is bad) | `caddy.yml` |
| Release sites, docs, design UI | Yes | Workers, channels, content addresses | `next.zkb.fi`, a new CID, an uploaded version | Promotion, DNSLink record, version deploy | `sites.yml` |

### Why the backend does not run twice on the live database

The backend keeps its state in one SQLite file (`/var/lib/zk-bridge-backend/backend.sqlite`, WAL mode). Two processes can
open it, and a unique index keeps them from both holding an active job for a direction. That is all they share safely:
`recover()` at start launches every active job without a `start_slot` (a second backend would start a second paid proof for
the job the first runs), the running jobs and the indexer's cached answer live in memory, and each process posts stored
proofs. So a second backend is safe only on a copy of the database (`backend.yml -e action=check`, an empty scratch
database on port 8788) or when no job is in flight (`backend.yml`, after the drain). A job is in flight when its status is
`queued` or `proving`.

## Set up the control machine (once)

```sh
python3 -m venv .venv-ansible && .venv-ansible/bin/pip install ansible-core ansible-lint   # or: uv tool install ansible-core
cd deploy/ansible && ../../.venv-ansible/bin/ansible-galaxy collection install -r requirements.yml
```

The inventory has one host, `zkbfi-app`, reached through the `zkbfi-app` alias in `~/.ssh/config` (root, key from the
1Password SSH agent). Every path, port, unit name and limit is in `inventory/group_vars/zkbfi.yml`. No secret is in the
repository. `sites.yml` reads the Cloudflare token with `op read` on your machine (references in
`inventory/group_vars/control.yml`; confirm the item names before the first run) and marks those tasks `no_log`.
Run everything from `deploy/ansible`, in `tmux` (the longest waits are two hours for green and 40 minutes for jobs).
`--check` is supported: reads run, nothing is changed (the build has no read-only form and is skipped).

## Pre-deploy checklist

Do all of it before the build. Stop at the first thing that is wrong.

1. The commit is on the branch you mean to deploy, pushed, and its tests passed (`pnpm` tests in `explorer/`,
   `deploy/app-server/test.sh`).
2. If the commit changes `explorer/backend/src/storage.ts`: the change only adds (`CREATE ... IF NOT EXISTS`). A change
   that drops or rewrites a column cannot be rolled back, because the old release reads the same file.
3. If the commit changes a file under `/etc/zk-bridge` (a new setting, a new secret): put it on the server first, and
   check that blue still starts with it.
4. `ansible-playbook preflight.yml` passes (free disk 10 GB, upstream files, a valid Caddyfile that imports them, a live
   indexer and backend, no leftover green or check unit, no drain, no publisher proof in progress).
5. You can watch the whole run and know the rollback for each step (table below).

## Run it

One playbook at a time (the careful way), or `site.yml` for all of it in order.

| Step | Command | Does |
| --- | --- | --- |
| Build | `ansible-playbook build.yml -e ref=<ref>` | Fetches the ref, builds the release, does not switch. Prints the commit, path and schema. |
| Caddy | `ansible-playbook caddy.yml -e commit=<hash>` | Writes the upstream files if missing, installs the Caddyfile of the release, validates, reloads. |
| Check | `ansible-playbook preflight.yml` | Read-only checks. `status.yml` shows where things stand. |
| Indexer | `ansible-playbook indexer.yml -e commit=<hash>` | Green on 42070, wait for `/ready` (stall guard), compare 16 routes with blue, switch Caddy. Blue stays. |
| Backend | `ansible-playbook backend.yml -e commit=<hash>` | Drain, wait for no job, copy the database, switch, check, rollback by itself on failure. |
| Bots | `ansible-playbook bots.yml -e commit=<hash> [-e bots=runner]` | Publisher and runner, only those with a configuration; publisher not while proving. |
| Finish | `ansible-playbook indexer.yml -e commit=<hash> -e action=finish` | After the soak: the real unit takes the new schema. |
| Everything | `ansible-playbook site.yml -e ref=<ref>` | build, caddy, preflight, indexer (green, switch, soak, finish), backend, bots, then removes the retired keep-alive units. |
| Sites | `ansible-playbook sites.yml -e publish_next=<dir>` | See "Hosted sites". Runs on your machine. |

Order matters: Caddy before the indexer (the upstream files must exist), the indexer before the backend, and the bots
last. The first run on a fresh server starts with `caddy.yml`.

### Indexer details

- **Same schema:** when the release's schema (`DATABASE_SCHEMA` of `release.env`, then `indexer.env`) equals the running
  indexer's, the playbook says so and ends: two Ponders cannot share a schema, and the indexer's code is unchanged.
  `-e action=restart` does a warm restart of the unit from the release (a few seconds; Caddy holds requests meanwhile).
- **Green** is started with `systemd-run` from the release's own unit file (user, sandbox, environment files, command); only
  the port differs. The wait stops green when `/status` does not change for 10 minutes (`zkb_stall_seconds`) or the unit
  exits, and gives up after 2 hours. On any failure blue and Caddy are untouched. The journal is not printed (it can hold
  endpoint URLs): `journalctl -u zk-bridge-indexer-pre --no-pager | tail -n 50`.
- **Compare:** status codes and the shape of 16 routes must match; numbers where green is more than 2% behind blue are
  `WARN`. The switch is refused on a WARN unless `-e accept_warnings=true`. Open one message on green by hand through an SSH
  tunnel (`/api/messages/<id>` is not compared).
- **Switch:** `indexer.caddy` gets green first and blue as the fallback (`lb_policy first`, active check on `/ready`, a
  request held up to 30 s when neither is ready); the whole Caddyfile is validated, Caddy is reloaded, `https://<indexer
  host>/ready` is asked from the server, and Caddy goes back to blue if it is not 200.
- **Soak and finish:** keep both for an hour and until you have seen a new message appear on `indexer.zkb.fi`, then
  `-e action=finish`. It stops green, restarts only the indexer unit through `deploy.sh`, waits up to 10 minutes for
  `/ready`, and points Caddy at it alone. If the unit is not ready it starts green again on the same schema and fails. There
  is a window of seconds to a minute where the indexer may answer slowly: do it when traffic is low.
- `site.yml` waits `zkb_soak_seconds` (1 hour) and then asks you to press Enter after looking at the indexer
  (`-e zkb_interactive_soak=false -e zkb_soak_seconds=0` skips both).
- **While green runs and `current` has moved** (after the backend step): do not restart `zk-bridge-indexer` by hand. It would
  start the new release on the schema green holds.

### Backend details

In order: refuse when the backend is not running; drain (Caddy
answers `POST /requests` with `503 {"error":"cannot-check","retryAfterSeconds":30}` and `Retry-After: 30`; every other route
goes on); wait 15 s; `files/jobs_idle.py` reads `/health` until no job is `queued` or `proving` on three reads in a row (limit
40 minutes, `zkb_drain_timeout`; if jobs remain, **nothing is restarted**, the routes are restored and the playbook fails);
copy the database with `VACUUM INTO` into `/var/lib/zk-bridge-backend/backups/` (newest three kept);
`ZKB_SERVICES=backend deploy.sh`; wait for `/health` 200 and for every module that ran before to run again. In a `rescue`, the
previous release is put back. An `always` section restores normal routes.
`-e action=check` starts the release on a scratch database (port 8788) and lists the modules that are not running on it and on
the live backend: a module down on the check only is a reason to stop.

### Bots

No green beside blue: two runners would collide on nonces and deliver twice. A bot whose files under `/etc/zk-bridge` are
missing is skipped with a message (as `deploy.sh` does). The publisher is not restarted while its last journal event of six
hours is `proving_started`. The runner stops after its current step (`TimeoutStopSec` 330 s). One bot at a time, then 15 s and
an `active` check.

## Rollback and what is kept

| What | Blue is kept as | Rollback |
| --- | --- | --- |
| Indexer, before the finish | The old indexer process and its schema | `ansible-playbook indexer.yml -e action=rollback` (Caddy to blue alone, stop green; a reload, no downtime) |
| Indexer, after the finish | The old schema in Postgres (keep it 7 days) | `ZKB_SERVICES=indexer deploy.sh <previous>`; the old schema then catches up, and the site serves stale data or 503 meanwhile. This is why the soak comes first. |
| Backend | The previous release directory (`deploy.sh` keeps five) and the database copies (keep the newest for 24 hours) | `ansible-playbook backend.yml -e commit=<previous>`: it drains the same way. The old release reads the same database (safe when checklist item 2 held). A database copy is for a damaged file only: restoring it loses every job and proof since. |
| A drain left on (run killed) | | `ansible-playbook backend.yml -e action=undrain` (`status.yml` shows `DRAINING`) |
| Bots | The previous release directory | `ansible-playbook bots.yml -e commit=<previous> -e bots=<name>` |
| Caddy | `<file>.<n>.<date>~` next to each file Ansible replaced | Each play restores the previous file itself when validation or reload fails. By hand: put the backup back and `systemctl reload caddy`. |

Ansible reads `-e action=...` as a variable named like its own keyword and prints a warning; it works. `-e step=...` is the
same switch without the warning.

Binary upgrades (`apt upgrade caddy`) restart the process and drop connections for a moment. Do them alone, never in the
same window as another step. Never `systemctl restart caddy` for a config change.

## Proof archive

Each indexer release gets a new Ponder schema, but the proof archive lives in its own schema, `proof_archive`, and
moves across releases untouched. It is backed up separately from the backend snapshots above:

- The nightly `zk-bridge-proofs-export.timer` writes a bundle to `/var/backups/zk-bridge/proofs`.
- `ansible-playbook proofs.yml -e action=export|import|verify|publish` runs the same steps by hand.
- The owner's Mac pulls a copy every day.

See docs/proof-archive.md.

## Hosted sites

These are not on the app server. `sites.yml` runs on your machine with the repository's scripts and wrangler, and does only
what a variable names. Each public name needs `-e confirm_production=yes`.

| What | Command | Check before the switch | Rollback |
| --- | --- | --- | --- |
| `next.zkb.fi` (Worker `zkb-fi-next`) | `sites.yml -e publish_next=<release-dir>` | Open it; `/version.json` has the `sequence` and archive CIDs `release.sh` printed; try the testnet pair | New release to `next` |
| `zkb.fi` (Worker `zkb-fi`) | `sites.yml -e publish_stable=<promoted-dir> -e confirm_production=yes` | The release was promoted by `promote.sh` from what ran on `next.zkb.fi` | A new, higher sequence that names the older archives, signed with the production key. Clients refuse a lower sequence, so an old `version.json` or `wrangler rollback` does not move users who saw the newer one. |
| `docs.zkb.fi` (DNSLink) | `sites.yml -e docs_cid=<dapp cid> -e confirm_production=yes` | The CID is pinned on the kubo node and a gateway serves it (the playbook asks one); load three pages | Run again with the old CID (printed first). Resolvers cache by TTL (printed). Never unpin the old CID for a week. |
| Design UI (`zkb-fi-ui`) | `sites.yml -e design_ui=upload`, then `design_ui=deploy` | Request `https://next.zkb.fi/ui/` with `Cloudflare-Workers-Version-Overrides: zkb-fi-ui="<version-id>"` | `design_ui=rollback` |

The release itself is built, signed and pinned before this (`script/release/release.sh`, `publish.sh`, `promote.sh`); the
release keys are never read by the playbooks. `publish-pages.sh` verifies the release against the channel's keys and refuses
a release for the wrong channel. The design UI Worker serves both routes, so deploying it changes both at once.

## Never

- Never restart `zk-bridge-backend` (or run `deploy.sh` without `ZKB_SERVICES`, which restarts all four services) while a job
  is `queued` or `proving`. Use `backend.yml`.
- Never start a second backend on the live database file while the first one runs. Its startup restarts the jobs of the first.
- Never switch `current` and restart the indexer onto a schema that has not been filled and compared. A new schema is built
  on green first.
- Never run two runners, or two publishers. Never run the runner and a test copy with the same wallet.
- Never `systemctl restart caddy` for a config change, and never edit an upstream file by hand without `caddy validate`. The
  playbooks validate every write.
- Never drop an indexer schema in the same session as the deploy that retired it. Wait the 7 days. Nothing in the playbooks
  drops a schema.
- Never delete a pinned release, an old CID, or the newest database copy during a deploy.
- Never put a secret or a full endpoint URL in a log line, a commit, or this repository. The playbooks print host names,
  counts and schema names only, and the tasks that hold a token are `no_log`.
- Never skip the preflight because the change is small. The two incidents above were small changes.
- Never push or promote from a branch that has not been tested on `next.zkb.fi`.

## What is not verified

The playbooks were written without access to the server. They pass `ansible-playbook --syntax-check` and `ansible-lint`
(production profile), the helper scripts and Jinja expressions were run against local stand-ins, and `deploy/app-server/test.sh`
checks the templates. Nothing has run on `zkbfi-app`. Check these on the first supervised run (start with `--check --diff`
for `caddy.yml` and `preflight.yml`):

- Caddy: that `import` of a file that defines a snippet works at the top of the Caddyfile on the installed version, that
  `lb_policy first` with the active `/ready` check falls back to blue, and that `lb_try_duration` holds a request while both
  upstreams are down. Where `/etc/caddy/Caddyfile` comes from (a link into `current` becomes a file).
- Ponder: that `--port` and `PORT` move its port, that `/status` changes while it backfills (the stall check relies on it), and
  that blue and green can share `/var/lib/zk-bridge-indexer/ponder` and `generated/`.
- `systemd-run` accepting every property copied from the unit file (a rejected property fails the start at once).
- The `script` module (it runs the local `deploy.sh` and the Python helpers on the server) and Python 3 on the server.
- The publisher's journal contains the event names `proving_started`, `proof_made`, `nothing_to_prove`, `proof_discarded`.
- Cloudflare: the 1Password references, the token's rights (Workers, DNS edit), `wrangler versions deploy --yes` and
  `rollback --yes`, the version-override header, and the DNSLink record update.
- That the dapp shows something sensible for the drain's `503 cannot-check` answer.
