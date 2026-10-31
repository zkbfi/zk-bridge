#!/usr/bin/env bash
# Blue/green steps for the zkb.fi app server (docs/deploy-blue-green.md). Run it as root on the server, after
# deploy.sh has BUILT the release (ZKB_BUILD_ONLY=1):
#
#   ssh zkbfi-app 'bash -s' -- <command> [<commit>] < deploy/app-server/bluegreen.sh
#
# Commands (the playbook says when to use each):
#   preflight                       read-only checks before a deploy
#   init                            write the Caddy upstream files with today's routing (once; changes no traffic)
#   status                          what runs, where Caddy points, how many jobs are in flight
#   indexer-green <commit>          start the release's Ponder on 127.0.0.1:42070 (its own schema), wait for /ready, compare
#   indexer-switch                  point Caddy at green, with blue as the fallback
#   indexer-rollback                point Caddy back at blue and stop green
#   indexer-finish <commit>         stop green, restart the real indexer unit on the now-warm schema, point Caddy at it
#   backend-check <commit>          start the release's backend on a scratch database and port 8788, check /health, stop it
#   backend-switch <commit>         pause new jobs, wait for the jobs in flight, restart the backend on the release
#   backend-undrain                 put the backend routes back to normal (after an aborted backend-switch)
#   bots-switch <commit> [name...]  move publisher and/or runner to the release (publisher only when it is not proving)
#
# <commit> is the full hash or a prefix of a release that deploy.sh built under /opt/zk-bridge/releases.
# Settings (environment): ZKB_GREEN_TIMEOUT (seconds to wait for green /ready, default 7200), ZKB_STALL_SECONDS
# (green is stopped when its progress does not move for this long, default 600), ZKB_DRAIN_TIMEOUT (seconds to wait
# for jobs in flight, default 2400), ZKB_MIN_FREE_GB (default 10).
#
# It prints host names and counts, never a configuration value or a secret. Everything runs inside main, so the
# script can come in on standard input.
set -euo pipefail

log() { printf 'bluegreen: %s\n' "$*" >&2; }
die() { log "$*"; exit 1; }

BASE=/opt/zk-bridge
RELEASES=$BASE/releases
CURRENT=$BASE/current
ETC=/etc/zk-bridge
CADDY_UPSTREAMS=/etc/caddy/upstreams
CADDY_ENV=/etc/caddy/zkb.env
CADDYFILE=/etc/caddy/Caddyfile
BACKEND_STATE=/var/lib/zk-bridge-backend
INDEXER_UNIT=zk-bridge-indexer.service
GREEN_INDEXER_UNIT=zk-bridge-indexer-pre
CHECK_BACKEND_UNIT=zk-bridge-backend-pre
GREEN_INDEXER_PORT=${ZKB_INDEXER_GREEN_PORT:-42070}
CHECK_BACKEND_PORT=${ZKB_BACKEND_CHECK_PORT:-8788}
GREEN_TIMEOUT=${ZKB_GREEN_TIMEOUT:-7200}
STALL_SECONDS=${ZKB_STALL_SECONDS:-600}
DRAIN_TIMEOUT=${ZKB_DRAIN_TIMEOUT:-2400}
MIN_FREE_GB=${ZKB_MIN_FREE_GB:-10}
KEEP_BACKUPS=3

# The routes of the indexer that the comparison reads. Routes with a path parameter are left out.
COMPARE_ROUTES=(/api/summary /api/pair /api/heads /api/head-updates /api/light-client-costs /api/gate /api/registry
  /api/tokens /api/audit /api/escrow /api/release-events /api/feed /api/delivered /api/undelivered /api/history
  /api/delivery-cost)

# --- Small helpers ---------------------------------------------------------------------------------------------------

# env_value <file> <key> <default>: the last KEY=value of a plain environment file, else the default.
env_value() {
  local value=
  [ ! -f "$1" ] || value=$(grep -h "^$2=" "$1" | tail -n 1 | cut -d= -f2- || true)
  printf '%s' "${value:-$3}"
}

blue_indexer_port() { env_value "$CADDY_ENV" ZKB_INDEXER_PORT 42069; }
backend_port() { env_value "$CADDY_ENV" ZKB_BACKEND_PORT 8787; }
indexer_host() { env_value "$CADDY_ENV" ZKB_INDEXER_HOST ""; }
prove_host() { env_value "$CADDY_ENV" ZKB_PROVE_HOST ""; }

# resolve_release <commit or prefix>: prints the full commit of a complete release.
resolve_release() {
  local want=${1:-} found=() dir
  [ -n "$want" ] || die "name a release commit"
  case $want in *[!0-9a-f]*) die "not a commit hash: $want" ;; esac
  for dir in "$RELEASES"/"$want"*; do
    [ -f "$dir/.complete" ] && found+=("$(basename "$dir")")
  done
  [ ${#found[@]} -eq 1 ] || die "${#found[@]} complete releases match $want (build it first: ZKB_BUILD_ONLY=1 deploy.sh <ref>)"
  printf '%s' "${found[0]}"
}

current_release() { [ -L "$CURRENT" ] && basename "$(readlink "$CURRENT")" || printf 'none'; }

http_code() { curl -s -o /dev/null -m 10 -w '%{http_code}' "$1" || true; }

# code_is <url> <code>: true when the url answers with that status.
code_is() { [ "$(http_code "$1")" = "$2" ]; }

# wait_until <seconds> <what> <command...>: runs the command every 5 seconds until it succeeds.
wait_until() {
  local limit=$1 what=$2 start now
  shift 2
  start=$(date +%s)
  until "$@"; do
    now=$(date +%s)
    [ $((now - start)) -lt "$limit" ] || { log "timed out after ${limit}s: $what"; return 1; }
    sleep 5
  done
}

# --- Caddy: the upstream files -----------------------------------------------------------------------------------------

caddy_check() {
  # The Caddyfile reads its host names from the environment, so check with the same file the service loads.
  (
    set -a
    # shellcheck disable=SC1090
    [ ! -f "$CADDY_ENV" ] || . "$CADDY_ENV"
    set +a
    caddy validate --config "$CADDYFILE" --adapter caddyfile >/dev/null 2>&1
  )
}

# write_upstream <name> : the new content on standard input. Validates it with the whole Caddyfile and reloads; on any
# failure the previous file is back and Caddy is reloaded with it.
write_upstream() {
  local name=$1 file=$CADDY_UPSTREAMS/$1.caddy
  [ -f "$file" ] || die "$file is missing: run init"
  cat > "$file.new"
  cp -p "$file" "$file.prev"
  mv "$file.new" "$file"
  if ! caddy_check; then
    mv "$file.prev" "$file"
    die "caddy rejected the new $name upstream; the old one is back and Caddy was not reloaded"
  fi
  if ! systemctl reload caddy; then
    mv "$file.prev" "$file"
    systemctl reload caddy || true
    die "caddy reload failed; the old $name upstream is back"
  fi
  log "caddy: $name upstream changed and reloaded"
}

indexer_upstream_normal() {
  cat <<'EOF'
# Written by bluegreen.sh. Normal: the indexer unit, alone.
(indexer_upstream) {
	reverse_proxy 127.0.0.1:{$ZKB_INDEXER_PORT:42069}
}
EOF
}

# Green first, blue as the fallback: a request goes to blue when green does not answer /ready. lb_try_duration holds a
# request for a moment when no upstream is ready, so a restart of one does not show as an error.
indexer_upstream_green() {
  cat <<EOF
# Written by bluegreen.sh. Green (port $GREEN_INDEXER_PORT) first; blue is the fallback.
(indexer_upstream) {
	reverse_proxy 127.0.0.1:$GREEN_INDEXER_PORT 127.0.0.1:{\$ZKB_INDEXER_PORT:42069} {
		lb_policy first
		lb_try_duration 30s
		lb_try_interval 250ms
		health_uri /ready
		health_interval 5s
		health_timeout 3s
	}
}
EOF
}

backend_upstream_normal() {
  cat <<'EOF'
# Written by bluegreen.sh. Normal: the backend, alone.
(backend_upstream) {
	reverse_proxy 127.0.0.1:{$ZKB_BACKEND_PORT:8787}
}
EOF
}

# Draining: POST /requests (the only route that starts a job) answers 503 with a Retry-After, in the same shape as the
# backend's own "cannot-check" answer. Every other route goes on. A restart of the backend is held for up to 20 seconds.
backend_upstream_drain() {
  cat <<'EOF'
# Written by bluegreen.sh. DRAINING: no new proof jobs; everything else goes on.
(backend_upstream) {
	@zkb_new_jobs {
		method POST
		path /requests
	}
	handle @zkb_new_jobs {
		header Access-Control-Allow-Origin "*"
		header Access-Control-Expose-Headers "Retry-After"
		header Content-Type "application/json"
		header Retry-After "30"
		respond `{"error":"cannot-check","retryAfterSeconds":30}` 503
	}
	handle {
		reverse_proxy 127.0.0.1:{$ZKB_BACKEND_PORT:8787} {
			lb_try_duration 20s
			lb_try_interval 250ms
		}
	}
}
EOF
}

# --- Units: the hardening of the real unit, for a transient copy -------------------------------------------------------

# The settings of a service unit that a transient copy takes over: who it runs as, its files and its sandbox.
UNIT_KEYS="User Group WorkingDirectory Environment EnvironmentFile ReadWritePaths NoNewPrivileges ProtectSystem ProtectHome
  PrivateTmp PrivateDevices ProtectKernelTunables ProtectKernelModules ProtectKernelLogs ProtectControlGroups ProtectClock
  ProtectHostname ProtectProc RestrictAddressFamilies RestrictNamespaces RestrictRealtime RestrictSUIDSGID LockPersonality
  SystemCallArchitectures SystemCallFilter SystemCallErrorNumber CapabilityBoundingSet AmbientCapabilities UMask TimeoutStopSec"
UNIT_KEYS=${UNIT_KEYS//$'\n'/ }

# transient_unit <name> <release> <service> <extra systemd-run args... -- command args...>
# Starts <release>'s copy of zk-bridge-<service>.service as a transient unit: the same user, sandbox, environment files
# and command, read from the unit file of that release. Anything after -- is added to the command.
transient_unit() {
  local name=$1 release=$2 service=$3 unit
  shift 3
  unit=$release/deploy/app-server/zk-bridge-$service.service
  [ -f "$unit" ] || die "$unit is missing"
  local props=() key value line exec_start=
  while IFS= read -r line; do
    key=${line%%=*}
    value=${line#*=}
    value=${value//$CURRENT/$release}
    case " $UNIT_KEYS " in
      *" $key "*) props+=(-p "$key=$value") ;;
    esac
    case $key in
      ExecStart) exec_start=$value ;;
    esac
  done < <(sed -n '/^\[Service\]/,/^\[/p' "$unit" | grep -E '^[A-Za-z]+=')
  [ -n "$exec_start" ] || die "no ExecStart in $unit"
  local extra=() command=()
  while [ $# -gt 0 ] && [ "$1" != -- ]; do extra+=("$1"); shift; done
  [ "${1:-}" != -- ] || shift
  # The command words of ExecStart hold no quotes (the units are written that way); the extra words come last.
  # shellcheck disable=SC2206
  command=($exec_start "$@")
  systemd-run --unit="$name" --collect --quiet -p Restart=no "${props[@]}" ${extra[@]+"${extra[@]}"} -- "${command[@]}"
}

unit_active() { systemctl is-active -q "$1"; }

stop_transient() {
  if systemctl is-active -q "$1.service" || systemctl is-failed -q "$1.service"; then
    systemctl stop "$1.service" 2>/dev/null || true
    systemctl reset-failed "$1.service" 2>/dev/null || true
  fi
}

# --- Indexer ------------------------------------------------------------------------------------------------------------

# The schema that a Ponder process has: the last DATABASE_SCHEMA of the release file and the operator's file.
release_schema() {
  grep -h '^DATABASE_SCHEMA=' "$1/release.env" "$ETC/indexer/indexer.env" 2>/dev/null | tail -n 1 | cut -d= -f2-
}

# The schema of the running indexer unit, read from its process (it started from an older release.env maybe).
live_schema() {
  local pid
  pid=$(systemctl show -p MainPID --value "$INDEXER_UNIT")
  [ -n "$pid" ] && [ "$pid" != 0 ] || die "the indexer unit is not running"
  tr '\0' '\n' < "/proc/$pid/environ" | grep '^DATABASE_SCHEMA=' | tail -n 1 | cut -d= -f2-
}

# A number that changes while Ponder indexes: the /status body, hashed.
progress_mark() { curl -s -m 10 "http://127.0.0.1:$GREEN_INDEXER_PORT/status" | sha256sum | cut -c1-16; }

green_ready() { [ "$(http_code "http://127.0.0.1:$GREEN_INDEXER_PORT/ready")" = 200 ]; }

# Compares the routes of green and blue: the status code, and the shape (keys and types) of the body. Numbers that
# differ are printed as a count of leaves where green is behind, never their values beyond a count of 20 lines.
compare_indexers() {
  local blue=$1 green=$2 route failures=0
  for route in "${COMPARE_ROUTES[@]}"; do
    if ! node -e '
      const [blue, green, route] = process.argv.slice(1);
      const shape = (v) => v === null ? "null" : Array.isArray(v) ? "[" + (v.length ? shape(v[0]) : "") + "]"
        : typeof v === "object" ? "{" + Object.keys(v).sort().map((k) => k + ":" + shape(v[k])).join(",") + "}" : typeof v;
      const leaves = (v, path, out) => { if (typeof v === "number") out.set(path, v); else if (v && typeof v === "object" && !Array.isArray(v)) for (const k of Object.keys(v)) leaves(v[k], path + "." + k, out); return out; };
      const get = async (port) => { const r = await fetch(`http://127.0.0.1:${port}${route}`, { signal: AbortSignal.timeout(30000) }); const t = await r.text(); let j = null; try { j = JSON.parse(t); } catch {} return { status: r.status, json: j }; };
      (async () => {
        const [b, g] = await Promise.all([get(blue), get(green)]);
        if (b.status !== g.status) { console.log(`FAIL ${route}: status blue ${b.status}, green ${g.status}`); process.exit(1); }
        if (b.status === 200 && shape(b.json) !== shape(g.json)) { console.log(`FAIL ${route}: the shape of the answer differs`); process.exit(1); }
        let behind = 0;
        if (b.json !== null && g.json !== null) { const bl = leaves(b.json, "", new Map()); for (const [p, v] of leaves(g.json, "", new Map())) { const o = bl.get(p); if (o !== undefined && o > 0 && v < o * 0.98) { behind++; if (behind <= 20) console.log(`  ${route}${p}: blue ${o}, green ${v}`); } } }
        console.log(`${behind ? "WARN" : "ok  "} ${route}: status ${g.status}${behind ? `, ${behind} number(s) where green is behind blue by more than 2%` : ""}`);
      })().catch((error) => { console.log(`FAIL ${route}: ${error.name}`); process.exit(1); });
    ' "$blue" "$green" "$route"; then failures=$((failures + 1)); fi
  done
  [ "$failures" -eq 0 ]
}

# indexer_green_up <commit>: starts green and waits for /ready; stops it again when it fails or stalls.
indexer_green_up() {
  local commit=$1 release=$RELEASES/$1
  if unit_active "$GREEN_INDEXER_UNIT.service"; then die "$GREEN_INDEXER_UNIT is already running; stop it first: systemctl stop $GREEN_INDEXER_UNIT"; fi
  stop_transient "$GREEN_INDEXER_UNIT"
  local new live
  new=$(release_schema "$release")
  live=$(live_schema) || die "cannot read the schema of the running indexer"
  [ -n "$new" ] || die "the release has no DATABASE_SCHEMA"
  if [ "$new" = "$live" ]; then
    log "the release uses the schema of the running indexer ($new): nothing to pre-index."
    log "deploy it with: ZKB_SERVICES=indexer deploy.sh $commit (a warm restart of a few seconds; Caddy holds requests meanwhile)"
    exit 3
  fi
  log "new schema $new (running: $live)"
  [ "$(http_code "http://127.0.0.1:$GREEN_INDEXER_PORT/health")" = 000 ] || die "something already listens on port $GREEN_INDEXER_PORT"
  # Errexit is off inside a function that runs under `if !`, so each step checks itself.
  transient_unit "$GREEN_INDEXER_UNIT" "$release" indexer -p "Environment=PORT=$GREEN_INDEXER_PORT" -- --port "$GREEN_INDEXER_PORT" \
    || return 1
  log "green started as $GREEN_INDEXER_UNIT on 127.0.0.1:$GREEN_INDEXER_PORT; waiting for /ready"

  local start now mark last_mark= last_move
  start=$(date +%s)
  last_move=$start
  while ! green_ready; do
    now=$(date +%s)
    if ! unit_active "$GREEN_INDEXER_UNIT.service"; then
      log "green exited. Read: journalctl -u $GREEN_INDEXER_UNIT --no-pager | tail -n 50"
      stop_transient "$GREEN_INDEXER_UNIT"
      return 1
    fi
    mark=$(progress_mark)
    if [ "$mark" != "$last_mark" ]; then last_mark=$mark; last_move=$now; fi
    if [ $((now - last_move)) -ge "$STALL_SECONDS" ]; then
      log "green has not moved for ${STALL_SECONDS}s (a stalled backfill, the failure of 2026-10-31). Stopping it."
      log "read: journalctl -u $GREEN_INDEXER_UNIT --no-pager | tail -n 50"
      return 1
    fi
    if [ $((now - start)) -ge "$GREEN_TIMEOUT" ]; then log "green is not ready after ${GREEN_TIMEOUT}s"; return 1; fi
    sleep 15
  done
  log "green is ready after $(($(date +%s) - start))s"
}

cmd_indexer_green() {
  local commit
  commit=$(resolve_release "${1:-}")
  if ! indexer_green_up "$commit"; then
    stop_transient "$GREEN_INDEXER_UNIT"
    die "green failed; blue is untouched and Caddy did not change"
  fi
  log "comparing green (:$GREEN_INDEXER_PORT) with blue (:$(blue_indexer_port))"
  compare_indexers "$(blue_indexer_port)" "$GREEN_INDEXER_PORT" || die "the comparison failed; green keeps running for inspection. Stop it with: systemctl stop $GREEN_INDEXER_UNIT"
  log "green is ready and matches blue. Read the WARN lines above, then: indexer-switch"
}

cmd_indexer_switch() {
  green_ready || die "green is not ready on port $GREEN_INDEXER_PORT: run indexer-green first"
  [ "$(http_code "http://127.0.0.1:$(blue_indexer_port)/ready")" = 200 ] || log "warning: blue is not ready, so there is no fallback"
  indexer_upstream_green | write_upstream indexer
  # The same request through Caddy, on this machine.
  local host
  host=$(indexer_host)
  if [ -n "$host" ]; then
    sleep 6
    local code
    code=$(curl -s -o /dev/null -m 15 -w '%{http_code}' --resolve "$host:443:127.0.0.1" "https://$host/ready" || true)
    log "https://$host/ready answers $code"
    if [ "$code" != 200 ]; then
      indexer_upstream_normal | write_upstream indexer
      die "the public route did not answer 200 after the switch; Caddy is back on blue"
    fi
  fi
  log "switched. Blue keeps running as the fallback; rollback: indexer-rollback. Finish after the soak: indexer-finish <commit>"
}

cmd_indexer_rollback() {
  indexer_upstream_normal | write_upstream indexer
  stop_transient "$GREEN_INDEXER_UNIT"
  log "Caddy is on the indexer unit alone; green is stopped"
}

cmd_indexer_finish() {
  local commit release
  commit=$(resolve_release "${1:-}")
  release=$RELEASES/$commit
  green_ready || die "green is not ready: nothing to finish (is the switch done?)"
  [ "$(release_schema "$release")" != "$(live_schema)" ] || die "the indexer unit already runs this schema"
  # Stop green first: Ponder holds its schema, so the unit cannot take it over while green runs. Caddy falls back to
  # blue for the moment, which still serves the old schema; deploy.sh then restarts blue on the release.
  log "stopping green, then restarting the indexer unit on the release (warm: the schema is filled)"
  stop_transient "$GREEN_INDEXER_UNIT"
  ZKB_SERVICES=indexer bash "$release/deploy/app-server/deploy.sh" "$commit" || log "deploy.sh reported a problem; checking the indexer anyway"
  if wait_until 600 "the indexer unit /ready" code_is "http://127.0.0.1:$(blue_indexer_port)/ready" 200; then
    indexer_upstream_normal | write_upstream indexer
    log "done: the indexer unit serves the new schema, Caddy is on it alone"
    return 0
  fi
  log "the indexer unit is not ready. Starting green again on the same schema and pointing Caddy at it."
  systemctl stop "$INDEXER_UNIT" || true
  indexer_green_up "$commit" || die "green did not come back. The old schema is still in Postgres: roll back with deploy.sh <previous>"
  indexer_upstream_green | write_upstream indexer
  die "Caddy is on green again. Read: journalctl -u zk-bridge-indexer --no-pager | tail -n 50"
}

# --- Backend --------------------------------------------------------------------------------------------------------------

# Prints "<direction> <status> <age in minutes>" for each job in flight, and returns how many there are. A job is in
# flight when it is queued or proving. The newest job of a direction is the only one that can be (one active job per
# direction), and /health shows the newest job of each.
jobs_in_flight() {
  local body
  body=$(curl -s -m 10 -f "http://127.0.0.1:$(backend_port)/health") || return 99
  printf '%s' "$body" | node -e '
    let text = ""; process.stdin.on("data", (c) => (text += c)).on("end", () => {
      const report = JSON.parse(text);
      const now = Date.now();
      let active = 0;
      for (const [direction, job] of Object.entries(report.lastJobs ?? {})) {
        if (job && (job.status === "queued" || job.status === "proving")) {
          active++;
          console.log(`${direction} ${job.status} ${Math.round((now - job.createdAt) / 60000)}min`);
        }
      }
      process.exit(active > 9 ? 9 : active);
    });'
}

# modules_not_running <port>: the modules that /health does not report as running, "name state" per line.
modules_not_running() {
  curl -s -m 10 -f "http://127.0.0.1:$1/health" | node -e '
    let text = ""; process.stdin.on("data", (c) => (text += c)).on("end", () => {
      const report = JSON.parse(text);
      for (const [name, m] of Object.entries(report.modules ?? {})) if (m.state !== "running") console.log(`${name} ${m.state}`);
    });'
}

# nothing_new_down <port> <before>: true when every module that is down now was down before (same lines).
nothing_new_down() {
  local now
  now=$(modules_not_running "$1") || return 1
  [ -z "$now" ] || [ -z "$(printf '%s\n' "$now" | grep -vxF -- "$2" || true)" ]
}

cmd_backend_check() {
  local commit release scratch=$BACKEND_STATE/bluegreen-check
  commit=$(resolve_release "${1:-}")
  release=$RELEASES/$commit
  stop_transient "$CHECK_BACKEND_UNIT"
  # The check runs on an EMPTY database of its own and another port. It never touches the live file: a second backend
  # on the live file would start the jobs that the first one runs (service.recover), and post the same proofs.
  runuser -u zkb_backend -- sh -c "rm -rf '$scratch' && mkdir -m 0700 '$scratch'"
  runuser -u zkb_backend -- node -e '
    const fs = require("node:fs");
    const [src, dest, db, port] = process.argv.slice(1);
    const config = JSON.parse(fs.readFileSync(src, "utf8"));
    config.databasePath = db;
    config.listen = { ...config.listen, port: Number(port) };
    fs.writeFileSync(dest, JSON.stringify(config), { mode: 0o600 });
  ' "$ETC/backend/backend.json" "$scratch/backend.json" "$scratch/backend.sqlite" "$CHECK_BACKEND_PORT"
  # The command gets --config twice (the unit's, then ours); the backend takes the last one.
  transient_unit "$CHECK_BACKEND_UNIT" "$release" backend -- --config "$scratch/backend.json"
  local ok=0
  if wait_until 90 "backend check /health" code_is "http://127.0.0.1:$CHECK_BACKEND_PORT/health" 200; then ok=1; fi
  if [ "$ok" -eq 1 ]; then
    sleep 20
    log "modules not running on the check instance (an empty list is good):"
    modules_not_running "$CHECK_BACKEND_PORT" | sed 's/^/  /' || true
    log "modules not running on the live backend (the check may show the same ones):"
    modules_not_running "$(backend_port)" | sed 's/^/  /' || true
  fi
  stop_transient "$CHECK_BACKEND_UNIT"
  runuser -u zkb_backend -- rm -rf "$scratch"
  [ "$ok" -eq 1 ] || die "the release's backend did not answer /health on a scratch database. Nothing changed. Read: journalctl -u $CHECK_BACKEND_UNIT --no-pager | tail -n 50"
  log "backend check passed: the release starts and answers /health. Compare the two module lists above."
}

backup_backend_database() {
  local dest=$BACKEND_STATE/backups/backend-$(date +%Y%m%dT%H%M%S).sqlite
  runuser -u zkb_backend -- sh -c "mkdir -p -m 0700 '$BACKEND_STATE/backups'"
  runuser -u zkb_backend -- node -e '
    const { DatabaseSync } = require("node:sqlite");
    const db = new DatabaseSync(process.argv[1]);
    db.exec("PRAGMA busy_timeout = 5000");
    db.exec(`VACUUM INTO \x27${process.argv[2]}\x27`);
    db.close();
  ' "$BACKEND_STATE/backend.sqlite" "$dest"
  log "database copy: $dest"
  runuser -u zkb_backend -- sh -c "ls -1t '$BACKEND_STATE'/backups/backend-*.sqlite | tail -n +$((KEEP_BACKUPS + 1)) | xargs -r rm -f"
}

cmd_backend_undrain() {
  backend_upstream_normal | write_upstream backend
}

# wait_no_jobs: true when no job is in flight on three reads in a row, ten seconds apart.
wait_no_jobs() {
  local zeros=0 start now count
  start=$(date +%s)
  while :; do
    count=0
    jobs_in_flight >/tmp/bluegreen-jobs.$$ || count=$?
    if [ "$count" -eq 99 ]; then log "cannot read the backend /health"; return 1; fi
    if [ "$count" -eq 0 ]; then
      zeros=$((zeros + 1))
      [ "$zeros" -lt 3 ] || { rm -f /tmp/bluegreen-jobs.$$; return 0; }
    else
      zeros=0
      log "waiting for $count job(s):"
      sed 's/^/  /' /tmp/bluegreen-jobs.$$ >&2
    fi
    now=$(date +%s)
    if [ $((now - start)) -ge "$DRAIN_TIMEOUT" ]; then rm -f /tmp/bluegreen-jobs.$$; log "jobs still in flight after ${DRAIN_TIMEOUT}s"; return 1; fi
    sleep 10
  done
}

cmd_backend_switch() {
  local commit previous
  commit=$(resolve_release "${1:-}")
  previous=$(current_release)
  unit_active zk-bridge-backend.service || die "the backend is not running; use deploy.sh"
  if unit_active zk-bridge-keepalive.service; then die "a keep-alive march is running (it holds a job for up to 6 hours): wait for it, then run this again"; fi
  [ "$(http_code "http://127.0.0.1:$(backend_port)/health")" = 200 ] || die "the live backend does not answer /health"

  local before
  before=$(modules_not_running "$(backend_port)") || die "cannot read the modules of the live backend"
  local timer_was_active=0
  if unit_active zk-bridge-keepalive.timer; then timer_was_active=1; systemctl stop zk-bridge-keepalive.timer; fi
  # Whatever happens from here, new jobs are accepted again and the timer is back when this ends.
  # shellcheck disable=SC2064
  trap "log 'leaving: normal routes back'; backend_upstream_normal | write_upstream backend || true; [ $timer_was_active -eq 0 ] || systemctl start zk-bridge-keepalive.timer || true" EXIT
  trap 'exit 130' HUP INT TERM

  backend_upstream_drain | write_upstream backend
  log "draining: POST /requests answers 503 for 30 seconds at a time; the job routes stay up"
  sleep 15   # a request that passed Caddy before the reload may still be creating its job
  wait_no_jobs || die "jobs are still in flight. Nothing was restarted; new jobs are accepted again."
  backup_backend_database

  log "no job in flight: restarting the backend on $commit (was $previous)"
  ZKB_SERVICES=backend bash "$RELEASES/$commit/deploy/app-server/deploy.sh" "$commit" || true
  local healthy=0
  if wait_until 120 "backend /health after the restart" code_is "http://127.0.0.1:$(backend_port)/health" 200 \
    && wait_until 60 "the modules that ran before run again" nothing_new_down "$(backend_port)" "$before"; then
    healthy=1
  fi
  if [ "$healthy" -ne 1 ]; then
    log "the backend is not healthy on $commit. Going back to $previous (still draining while it restarts)."
    [ "$previous" != none ] || die "there was no previous release"
    ZKB_SERVICES=backend bash "$RELEASES/$previous/deploy/app-server/deploy.sh" "$previous" || true
    wait_until 120 "backend /health on $previous" code_is "http://127.0.0.1:$(backend_port)/health" 200 || die "the backend does not answer on $previous either. Read: journalctl -u zk-bridge-backend"
    die "rolled back to $previous; the new release failed its health check"
  fi
  log "backend is healthy on $commit. Normal routes come back now. Rollback: backend-switch $previous"
}

# --- Bots ------------------------------------------------------------------------------------------------------------------

# The publisher is proving when its last proving_started has no proof_made, nothing_to_prove or proof_discarded after it.
publisher_proving() {
  local last
  last=$(journalctl -u zk-bridge-publisher -o cat --since '-6 hours' --no-pager 2>/dev/null \
    | grep -oE 'proving_started|proof_made|nothing_to_prove|proof_discarded' | tail -n 1 || true)
  [ "$last" = proving_started ]
}

cmd_bots_switch() {
  local commit
  commit=$(resolve_release "${1:-}")
  shift || true
  local names=("$@") name
  [ ${#names[@]} -gt 0 ] || names=(publisher runner)
  for name in "${names[@]}"; do
    case $name in publisher | runner) ;; *) die "unknown bot $name" ;; esac
  done
  for name in "${names[@]}"; do
    if [ "$name" = publisher ] && publisher_proving; then
      die "the publisher is proving (a paid run on the remote prover). Wait for proof_made, then run this again."
    fi
  done
  for name in "${names[@]}"; do
    log "moving $name to $commit (it stops after its current step)"
    ZKB_SERVICES=$name bash "$RELEASES/$commit/deploy/app-server/deploy.sh" "$commit" || true
    sleep 15
    unit_active "zk-bridge-$name.service" || die "$name is not running on $commit. Read: journalctl -u zk-bridge-$name --no-pager | tail -n 50. Go back: bots-switch <previous> $name"
    log "$name is running"
  done
}

# --- Setup and reports --------------------------------------------------------------------------------------------------------

cmd_init() {
  install -d -m 0755 "$CADDY_UPSTREAMS"
  local name
  for name in indexer backend; do
    if [ -f "$CADDY_UPSTREAMS/$name.caddy" ]; then log "$name.caddy exists; left as it is"; continue; fi
    "${name}_upstream_normal" > "$CADDY_UPSTREAMS/$name.caddy"
    chmod 0644 "$CADDY_UPSTREAMS/$name.caddy"
    log "wrote $CADDY_UPSTREAMS/$name.caddy"
  done
  log "Caddyfile in use: $(readlink -f "$CADDYFILE")"
  if grep -q 'import /etc/caddy/upstreams/backend.caddy' "$CADDYFILE"; then
    caddy_check && log "the Caddyfile validates" || die "the Caddyfile does not validate"
  else
    log "the Caddyfile does not import the upstream files yet. Install the Caddyfile of the release, then: caddy validate, systemctl reload caddy"
  fi
}

cmd_status() {
  local unit
  for unit in zk-bridge-indexer zk-bridge-backend zk-bridge-publisher zk-bridge-runner zk-bridge-keepalive.timer \
    "$GREEN_INDEXER_UNIT" "$CHECK_BACKEND_UNIT" caddy; do
    printf '%-28s %s\n' "$unit" "$(systemctl is-active "${unit%.service}" 2>/dev/null || true)"
  done
  printf 'current release: %s\n' "$(current_release)"
  printf 'indexer schema (running): %s\n' "$(live_schema 2>/dev/null || echo unknown)"
  printf 'indexer :%s /ready %s, green :%s /ready %s\n' "$(blue_indexer_port)" "$(http_code "http://127.0.0.1:$(blue_indexer_port)/ready")" \
    "$GREEN_INDEXER_PORT" "$(http_code "http://127.0.0.1:$GREEN_INDEXER_PORT/ready")"
  printf 'caddy indexer upstream: %s\n' "$(grep -c "$GREEN_INDEXER_PORT" "$CADDY_UPSTREAMS/indexer.caddy" 2>/dev/null | sed 's/^0$/blue only/; s/^[1-9].*/green first, blue fallback/')"
  printf 'caddy backend routes: %s\n' "$(grep -q DRAINING "$CADDY_UPSTREAMS/backend.caddy" 2>/dev/null && echo DRAINING || echo normal)"
  local count=0
  jobs_in_flight >/tmp/bluegreen-jobs.$$ || count=$?
  printf 'jobs in flight: %s\n' "$([ "$count" -eq 99 ] && echo unreadable || echo "$count")"
  sed 's/^/  /' /tmp/bluegreen-jobs.$$ 2>/dev/null || true
  rm -f /tmp/bluegreen-jobs.$$
}

cmd_preflight() {
  local problems=0
  problem() { log "PROBLEM: $*"; problems=$((problems + 1)); }
  [ -d "$BASE" ] || problem "$BASE is missing"
  local free
  free=$(df -BG --output=avail /var/lib | tail -n 1 | tr -dc '0-9')
  [ "${free:-0}" -ge "$MIN_FREE_GB" ] && log "disk: ${free} GB free on /var/lib" || problem "only ${free:-0} GB free on /var/lib (need $MIN_FREE_GB for a second schema)"
  log "memory (MB available): $(free -m | awk '/^Mem:/ {print $7}')"
  local unit
  for unit in zk-bridge-indexer zk-bridge-backend caddy; do
    unit_active "$unit" || problem "$unit is not running"
  done
  [ -f "$CADDY_UPSTREAMS/indexer.caddy" ] && [ -f "$CADDY_UPSTREAMS/backend.caddy" ] || problem "the Caddy upstream files are missing: run init"
  grep -q 'import /etc/caddy/upstreams/backend.caddy' "$CADDYFILE" 2>/dev/null || problem "the Caddyfile in use does not import the upstream files"
  caddy_check || problem "the Caddyfile does not validate"
  grep -q DRAINING "$CADDY_UPSTREAMS/backend.caddy" 2>/dev/null && problem "the backend routes are still draining: backend-undrain"
  [ "$(http_code "http://127.0.0.1:$(blue_indexer_port)/ready")" = 200 ] || problem "the live indexer is not ready"
  [ "$(http_code "http://127.0.0.1:$(backend_port)/health")" = 200 ] || problem "the live backend does not answer /health"
  unit_active "$GREEN_INDEXER_UNIT" && problem "$GREEN_INDEXER_UNIT is running from an earlier attempt"
  unit_active "$CHECK_BACKEND_UNIT" && problem "$CHECK_BACKEND_UNIT is running from an earlier attempt"
  unit_active zk-bridge-keepalive.service && problem "a keep-alive march is running"
  ! publisher_proving || problem "the publisher is proving"
  local count=0
  jobs_in_flight >/tmp/bluegreen-jobs.$$ || count=$?
  [ "$count" -ne 99 ] && log "jobs in flight: $count" || problem "cannot read the backend /health"
  rm -f /tmp/bluegreen-jobs.$$
  command -v caddy >/dev/null && command -v node >/dev/null && command -v curl >/dev/null || problem "caddy, node and curl must be installed"
  if [ "$problems" -gt 0 ]; then die "$problems problem(s)"; fi
  log "preflight passed"
}

main() {
  exec </dev/null
  umask 022
  [ "$(id -u)" -eq 0 ] || die "run as root"
  local command=${1:-}
  [ -n "$command" ] || die "usage: bluegreen.sh preflight|init|status|indexer-green|indexer-switch|indexer-rollback|indexer-finish|backend-check|backend-switch|backend-undrain|bots-switch [<commit>]"
  shift
  # One blue/green step at a time (deploy.sh has its own lock, on another file).
  exec 8>/run/zk-bridge-bluegreen.lock
  flock -n 8 || die "another bluegreen.sh command is running"
  case $command in
    preflight) cmd_preflight ;;
    init) cmd_init ;;
    status) cmd_status ;;
    indexer-green) cmd_indexer_green "$@" ;;
    indexer-switch) cmd_indexer_switch ;;
    indexer-rollback) cmd_indexer_rollback ;;
    indexer-finish) cmd_indexer_finish "$@" ;;
    backend-check) cmd_backend_check "$@" ;;
    backend-switch) cmd_backend_switch "$@" ;;
    backend-undrain) cmd_backend_undrain ;;
    bots-switch) cmd_bots_switch "$@" ;;
    *) die "unknown command: $command" ;;
  esac
}

main "$@"
