#!/usr/bin/env bash
# Static checks of the app server files: the scripts parse, each systemd unit runs as its own user with its own
# writable directory and secrets, and deploy.sh refuses to run without root. It runs nothing on a server.
#
#   deploy/app-server/test.sh
#
# systemd-analyze is not on every machine (macOS), so the units are checked by pattern. On the server, also run
#   systemd-analyze verify /etc/systemd/system/zk-bridge-*.service
set -euo pipefail

DIR=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
FAILURES=0

pass() { printf 'PASS  %s\n' "$1"; }
fail() { printf 'FAIL  %s\n' "$1"; FAILURES=$((FAILURES + 1)); }

# has_line <unit> <exact line>
has_line() {
  if grep -qxF -- "$2" "$DIR/$1"; then pass "$1: $2"; else fail "$1: missing line '$2'"; fi
}

# lacks <unit> <extended regex>
lacks() {
  if grep -qE -- "$2" "$DIR/$1"; then fail "$1: must not match '$2'"; else pass "$1: no '$2'"; fi
}

# --- Scripts parse ------------------------------------------------------------------------------------------------
for script in deploy.sh provision.sh proofs.sh test.sh; do
  if bash -n "$DIR/$script"; then pass "bash -n $script"; else fail "bash -n $script"; fi
done
if command -v shellcheck >/dev/null 2>&1; then
  for script in deploy.sh provision.sh proofs.sh test.sh; do
    # Warnings and errors only: provision.sh sources /etc/os-release, which only the server has (an info note).
    if shellcheck -S warning "$DIR/$script"; then pass "shellcheck $script"; else fail "shellcheck $script"; fi
  done
else
  printf 'SKIP  shellcheck is not installed\n'
fi

# --- Units --------------------------------------------------------------------------------------------------------
# unit, user, state directory, configuration directory, working directory under explorer/
check_unit() {
  local unit=zk-bridge-$1.service user=$2 state=$3 config=$4 workdir=$5
  [ -f "$DIR/$unit" ] || { fail "$unit is missing"; return; }
  has_line "$unit" "User=$user"
  has_line "$unit" "Group=$user"
  has_line "$unit" "ReadWritePaths=$state"
  has_line "$unit" "WorkingDirectory=/opt/zk-bridge/current/explorer/$workdir"
  has_line "$unit" "Restart=on-failure"
  local setting
  for setting in NoNewPrivileges=yes ProtectSystem=strict ProtectHome=yes PrivateTmp=yes PrivateDevices=yes \
    CapabilityBoundingSet= RestrictSUIDSGID=yes SystemCallFilter=@system-service UMask=0077; do
    has_line "$unit" "$setting"
  done
  # Exactly one writable path, and secrets only from this service's configuration directory or the release.
  if [ "$(grep -c '^ReadWritePaths=' "$DIR/$unit")" -eq 1 ]; then pass "$unit: one ReadWritePaths"; else fail "$unit: more than one ReadWritePaths"; fi
  local file found=0
  while IFS= read -r file; do
    found=1
    case $file in
      "/etc/zk-bridge/$config/"* | /opt/zk-bridge/current/release.env) pass "$unit: EnvironmentFile=$file" ;;
      *) fail "$unit: EnvironmentFile=$file is outside /etc/zk-bridge/$config" ;;
    esac
    # Each secret file has its template.
    case $file in
      /etc/zk-bridge/*)
        local example=$DIR/config/${file#/etc/zk-bridge/}.example
        if [ -f "$example" ]; then pass "$unit: template for $file"; else fail "$unit: no template $example"; fi ;;
    esac
  done < <(sed -n 's/^EnvironmentFile=-\{0,1\}//p' "$DIR/$unit")
  [ "$found" -eq 1 ] || fail "$unit: no EnvironmentFile"
  # V8 needs writable and executable memory; this setting would stop Node.js.
  lacks "$unit" '^MemoryDenyWriteExecute='
  # The units name no host of the deployment.
  lacks "$unit" 'zkb\.fi'
}

check_unit backend zkb_backend /var/lib/zk-bridge-backend backend backend
check_unit indexer zkb_indexer /var/lib/zk-bridge-indexer indexer indexer
check_unit publisher zkb_publisher /var/lib/zk-bridge-publisher publisher bots
check_unit runner zkb_runner /var/lib/zk-bridge-runner runner bots
check_unit traffic zkb_traffic /var/lib/zk-bridge-traffic traffic bots
check_unit status zkb_status /var/lib/zk-bridge-status status status

# The wallet key: only the runner's user can read it. The publisher runs as another user, so it can read neither the
# file nor the runner's environment in /proc.
has_line zk-bridge-runner.service "EnvironmentFile=/etc/zk-bridge/runner/runner.env"
lacks zk-bridge-publisher.service 'runner\.env'
lacks zk-bridge-publisher.service 'zkb_runner'
# The traffic wallet key: only the traffic bot's user can read it, and the traffic bot reads no other wallet key.
has_line zk-bridge-traffic.service "EnvironmentFile=/etc/zk-bridge/traffic/traffic.env"
for unit in zk-bridge-publisher.service zk-bridge-runner.service; do lacks "$unit" 'traffic\.env'; done
lacks zk-bridge-traffic.service 'runner\.env'
# The indexer reaches Postgres on the socket, with peer login, and listens on loopback only.
has_line zk-bridge-indexer.service "Environment=DATABASE_URL=postgresql:///zkb_indexer?host=/var/run/postgresql"
if grep -q '^ExecStart=.*--hostname 127\.0\.0\.1' "$DIR/zk-bridge-indexer.service"; then pass "indexer listens on 127.0.0.1"; else fail "indexer: ExecStart lacks --hostname 127.0.0.1"; fi

# --- Templates ----------------------------------------------------------------------------------------------------
for example in "$DIR"/config/*/*.json.example; do
  name=${example#"$DIR"/}
  if command -v jq >/dev/null 2>&1; then
    if jq empty "$example"; then pass "$name is JSON"; else fail "$name is not JSON"; fi
  else
    printf 'SKIP  %s: jq is not installed\n' "$name"
  fi
  # Every endpoint stays configuration: the templates hold placeholders, never a host of zkb.fi.
  if grep -q 'zkb\.fi' "$example"; then fail "$name names zkb.fi"; else pass "$name has no zkb.fi value"; fi
  # The prover is where deploy.sh installs it.
  if grep -q '"binary"' "$example"; then
    if grep '"binary"' "$example" | grep -qv '/opt/zk-bridge/current/bin/zk-bridge-prover'; then
      fail "$name: prover binary is not /opt/zk-bridge/current/bin/zk-bridge-prover"
    else
      pass "$name: prover binary is /opt/zk-bridge/current/bin/zk-bridge-prover"
    fi
  fi
done

# --- deploy.sh ----------------------------------------------------------------------------------------------------
if [ "$(id -u)" -eq 0 ]; then
  printf 'SKIP  deploy.sh root check: this test runs as root\n'
else
  status=0
  output=$(bash "$DIR/deploy.sh" 0000000000000000000000000000000000000000 2>&1) || status=$?
  if [ "$status" -ne 0 ] && [ "$output" = "deploy: run as root" ]; then
    pass "deploy.sh refuses to run without root"
  else
    fail "deploy.sh without root: status $status, output '$output'"
  fi
  status=0
  output=$(bash -s -- main <"$DIR/deploy.sh" 2>&1) || status=$?
  if [ "$status" -ne 0 ] && [ "$output" = "deploy: run as root" ]; then
    pass "deploy.sh from standard input refuses to run without root"
  else
    fail "deploy.sh from standard input without root: status $status, output '$output'"
  fi
fi
for unit in "$DIR"/zk-bridge-*.service; do
  name=$(basename "$unit" .service)
  if grep -q "\"\$CURRENT/deploy/app-server/zk-bridge-\$service.service\"" "$DIR/deploy.sh" \
    && grep -qE "^SERVICES=\((.* )?${name#zk-bridge-}[ )]" "$DIR/deploy.sh"; then
    pass "deploy.sh installs $name"
  else
    fail "deploy.sh does not install $name"
  fi
done
# Each file deploy.sh requires before a start has a template.
for file in $(sed -n 's/^ *[a-z]*) echo \(.*\/.*\) ;;$/\1/p' "$DIR/deploy.sh" | tr ' ' '\n' | sort -u); do
  [ "$file" = deployment.json ] && continue
  if [ -f "$DIR/config/$file.example" ]; then pass "template for required $file"; else fail "no template for required $file"; fi
done

# Root never creates or deletes inside a directory that a service user can write: a link planted there would point
# root's install or rm at any file. Such work runs as the service user.
if grep -nE '^[[:space:]]*(install|rm|chown|chmod|mkdir)[^#]*/var/lib/zk-bridge-' "$DIR/deploy.sh" >/dev/null; then
  fail "deploy.sh works as root inside a service's state directory: $(grep -nE '^[[:space:]]*(install|rm|chown|chmod|mkdir)[^#]*/var/lib/zk-bridge-' "$DIR/deploy.sh" | head -1)"
else
  pass "deploy.sh leaves the state directories to their users"
fi

# --- Caddy upstream files (deploy/ansible) -------------------------------------------------------------------------
ANSIBLE_DIR="$DIR/../ansible"
# The Caddyfile imports the upstream files and no longer names a port itself, so the playbooks own the routing.
for name in backend indexer; do
  if grep -qxF "import /etc/caddy/upstreams/$name.caddy" "$DIR/Caddyfile"; then pass "Caddyfile imports $name.caddy"; else fail "Caddyfile imports $name.caddy"; fi
done
# The backend and the indexer go through the upstream snippets (blue/green). The only proxy written in the Caddyfile is
# the IPFS gateway, which has one node and no green.
# The status service is the same: one process on one port.
if grep -E '^[[:space:]]*reverse_proxy' "$DIR/Caddyfile" | grep -vF -e '{$ZKB_IPFS_GATEWAY_PORT:8080}' -e '{$ZKB_STATUS_PORT:8790}' | grep -q .; then
  fail "Caddyfile: only the IPFS gateway and the status service may reverse_proxy directly"
else
  pass "Caddyfile: only the IPFS gateway and the status service proxy directly"
fi
if grep -qE '^[[:space:]]*reverse_proxy 127\.0\.0\.1:\{\$ZKB_STATUS_PORT:8790\}$' "$DIR/Caddyfile"; then pass "Caddyfile: status.zkb.fi proxies to the status port"; else fail "Caddyfile: no proxy to the status port"; fi
# The snippets that caddy.yml writes give the routing the Caddyfile had before: the same ports, and no other behaviour.
if grep -qxF '	reverse_proxy 127.0.0.1:{$ZKB_INDEXER_PORT:{{ zkb_default_indexer_port }}}' "$ANSIBLE_DIR/templates/indexer-normal.caddy.j2" \
  && grep -qxF '	reverse_proxy 127.0.0.1:{$ZKB_BACKEND_PORT:{{ zkb_default_backend_port }}}' "$ANSIBLE_DIR/templates/backend-normal.caddy.j2" \
  && grep -qx 'zkb_default_indexer_port: 42069' "$ANSIBLE_DIR/inventory/group_vars/zkbfi.yml" \
  && grep -qx 'zkb_default_backend_port: 8787' "$ANSIBLE_DIR/inventory/group_vars/zkbfi.yml"; then
  pass "the normal upstream templates carry the ports the Caddyfile had"
else
  fail "the normal upstream templates do not carry the old ports"
fi
# The drain answers only POST /requests: the webhook and the job reads must stay up.
if grep -qx '		method POST' "$ANSIBLE_DIR/templates/backend-drain.caddy.j2" && grep -qx '		path /requests' "$ANSIBLE_DIR/templates/backend-drain.caddy.j2"; then pass "drain matches POST /requests only"; else fail "drain does not match POST /requests only"; fi
# The prove host passes on the pipeline reads (/progress, /directions, /benchmarks) next to the proof flow, and no webhook.
if grep -qxF '	@routes path /health /requests /requests/* /proofs/latest/* /progress/* /directions/* /benchmarks' "$DIR/Caddyfile"; then pass "the prove host serves the pipeline reads"; else fail "the prove host does not serve the pipeline reads"; fi
# A transient copy takes its sandbox from the unit file of the release: no sandbox setting is repeated in the playbooks.
if grep -rE -- '--property=(Protect|Restrict|NoNewPrivileges|SystemCall|CapabilityBoundingSet)' "$ANSIBLE_DIR/tasks" "$ANSIBLE_DIR"/*.yml | grep -q .; then fail "a playbook sets a sandbox property by hand"; else pass "the playbooks take the sandbox from the unit files"; fi
# The helpers the playbooks run on the server compile.
if command -v python3 >/dev/null 2>&1; then
  if python3 -m py_compile "$ANSIBLE_DIR"/files/*.py; then pass "ansible helpers compile"; else fail "ansible helpers compile"; fi
  find "$ANSIBLE_DIR/files" -name __pycache__ -type d -exec rm -rf {} + 2>/dev/null || true
fi
# deploy.sh moves one service at a time on request.
if grep -q 'ZKB_SERVICES' "$DIR/deploy.sh"; then pass "deploy.sh honours ZKB_SERVICES"; else fail "deploy.sh lacks ZKB_SERVICES"; fi

# The indexer's live page (indexer-home): light client lines, pipeline, timings, the search palette, the tabs and the
# cross-links, and that zkb-search.js is built from the current sources.
if command -v node >/dev/null; then
  if node --test "$DIR/indexer-home" >/dev/null 2>&1; then pass "indexer-home: live page, search and cross-links"; else fail "indexer-home: live page (node --test $DIR/indexer-home)"; fi
# The blue/green comparison: order of list items and nullable fields must not fail it; a changed key or type must.
if python3 -I - "$DIR/../ansible/files/compare_indexers.py" >/dev/null 2>&1 <<'PY'
import importlib.util, sys
spec = importlib.util.spec_from_file_location("compare", sys.argv[1]); c = importlib.util.module_from_spec(spec); spec.loader.exec_module(c)
ok = lambda a, b: c.compatible(c.shape(a), c.shape(b))
assert ok({"t": [{"n": None, "s": "x"}, {"n": 1, "s": "y"}]}, {"t": [{"n": 2, "s": "y"}, {"n": None, "s": "x"}]})
assert ok({"t": []}, {"t": [{"n": 1}]})
assert not ok({"t": [{"n": 1}]}, {"t": [{"m": 1}]})
assert not ok({"t": [{"n": 1}]}, {"t": [{"n": "1"}]})
assert not ok({"a": 1}, {"a": 1, "b": 2})
PY
then pass "compare_indexers: list order and nullable fields pass, changed keys and types fail"; else fail "compare_indexers: shape comparison"; fi
fi
# Caddy serves the shared search script next to the page.
if grep -q 'zkb-search.js' "$DIR/Caddyfile"; then pass "Caddyfile serves indexer-home/zkb-search.js"; else fail "Caddyfile does not serve indexer-home/zkb-search.js"; fi

# --- Proof archive: units ------------------------------------------------------------------------------------------
PROOFS_SERVICE=proofs/zk-bridge-proofs-export.service
PROOFS_TIMER=proofs/zk-bridge-proofs-export.timer
has_line "$PROOFS_SERVICE" "Type=oneshot"
has_line "$PROOFS_SERVICE" "ExecStart=/opt/zk-bridge/current/deploy/app-server/proofs.sh export"
has_line "$PROOFS_SERVICE" "IOSchedulingClass=idle"
has_line "$PROOFS_SERVICE" "NoNewPrivileges=yes"
has_line "$PROOFS_SERVICE" "ProtectSystem=strict"
lacks "$PROOFS_SERVICE" 'zkb\.fi'
has_line "$PROOFS_SERVICE" "EnvironmentFile=-/etc/zk-bridge/proofs/proofs.env"
if [ "$(grep -c '^EnvironmentFile=' "$DIR/$PROOFS_SERVICE")" -eq 1 ]; then pass "proofs service: one EnvironmentFile"; else fail "proofs service: more than one EnvironmentFile"; fi
# The nightly publication is off until the owner has reviewed the first one.
has_line config/proofs/proofs.env.example "ZKB_PROOFS_PUBLISH=0"
has_line "$PROOFS_TIMER" "Persistent=true"
has_line "$PROOFS_TIMER" "WantedBy=timers.target"
if grep -qE '^OnCalendar=.*03:30' "$DIR/$PROOFS_TIMER" && grep -q '^RandomizedDelaySec=' "$DIR/$PROOFS_TIMER"; then pass "proofs timer: nightly at 03:30 with a random delay"; else fail "proofs timer: schedule"; fi
lacks "$PROOFS_TIMER" 'zkb\.fi'
if grep -q 'zk-bridge-proofs-export.timer' "$DIR/provision.sh" && grep -q 'zk-bridge-proofs-export.service' "$DIR/provision.sh"; then pass "provision.sh installs the proofs units"; else fail "provision.sh does not install the proofs units"; fi
# Root does no file work inside a service's state directory: that goes through runuser.
if grep -nE '^[[:space:]]*(install|rm|chown|chmod|mkdir|cp|mv)[^#]*\$\{?(BACKEND|RUNNER)_STATE' "$DIR/proofs.sh" >/dev/null; then
  fail "proofs.sh works as root inside a service's state directory"
else
  pass "proofs.sh leaves the state directories to their users"
fi
# The off-site hook is in the export.
if grep -q '^offsite_upload()' "$DIR/proofs.sh" && grep -q 'offsite_upload "\$bundle"' "$DIR/proofs.sh"; then pass "proofs.sh export calls offsite_upload"; else fail "proofs.sh lacks the off-site hook"; fi

# --- Proof archive: proofs.sh run for real against temporary directories ---------------------------------------------
if ! command -v node >/dev/null 2>&1 || ! command -v sqlite3 >/dev/null 2>&1; then
  printf 'SKIP  proofs.sh functional test: needs node and sqlite3\n'
else
  PT=$(mktemp -d)
  # A crash of this block (set -u, set -e) must fail the run. bash 3.2 gives an EXIT trap $? = 0 after an unbound
  # variable, so the block marks its end instead, and the trap fails the run when the mark is missing.
  PT_DONE=0
  trap 'rm -rf "$PT"; if [ "$PT_DONE" != 1 ]; then printf "FAIL  the proofs.sh functional block stopped before its end\n"; exit 1; fi' EXIT
  # The stub of zk-bridge-proof-archive.mjs: records its calls, writes fake archive files, a real manifest and checks it.
  cat >"$PT/stub-cli.mjs" <<'EOS'
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
const [cmd, ...rest] = process.argv.slice(2);
const arg = (n) => rest[rest.indexOf(n) + 1];
fs.appendFileSync(process.env.STUB_LOG, `${cmd} ${rest.join(" ")}\n`);
const walk = (d, base = d) => fs.readdirSync(d, { withFileTypes: true }).flatMap((e) =>
  e.isDirectory() ? walk(path.join(d, e.name), base) : [path.relative(base, path.join(d, e.name))]);
const hash = (f) => crypto.createHash("sha256").update(fs.readFileSync(f)).digest("hex");
const exitFor = (key) => Number(process.env[key] || 0);
if (cmd === "export") {
  fs.mkdirSync(path.join(arg("--out"), "archive"), { recursive: true });
  for (const n of ["storage_proofs", "light_client_proofs", "message_evidence", "conflicts"]) fs.writeFileSync(path.join(arg("--out"), "archive", `${n}.ndjson`), `{"stub":"${n}"}\n`);
} else if (cmd === "manifest-write") {
  const dir = arg("--dir");
  const files = {};
  for (const f of walk(dir)) if (f !== "manifest.json") files[f] = { sha256: hash(path.join(dir, f)), bytes: fs.statSync(path.join(dir, f)).size };
  fs.writeFileSync(path.join(dir, "manifest.json"), JSON.stringify({ formatVersion: 1, createdAt: "now", commit: arg("--commit"), host: "stub", files, counts: {} }));
} else if (cmd === "manifest-check") {
  const dir = arg("--dir");
  const m = JSON.parse(fs.readFileSync(path.join(dir, "manifest.json"), "utf8"));
  let bad = 0;
  for (const [f, v] of Object.entries(m.files)) if (!fs.existsSync(path.join(dir, f)) || hash(path.join(dir, f)) !== v.sha256) { console.error(`changed or missing: ${f}`); bad = 1; }
  for (const f of walk(dir)) if (f !== "manifest.json" && !(f in m.files)) { console.error(`unlisted: ${f}`); bad = 1; }
  process.exit(bad);
} else if (cmd === "import") {
  if (!fs.existsSync(path.join(arg("--in"), "archive", "storage_proofs.ndjson"))) process.exit(1);
  process.exit(exitFor("STUB_EXIT_IMPORT"));
} else if (cmd === "ingest-cache" || cmd === "ingest-backend") {
  process.exit(exitFor("STUB_EXIT_INGEST"));
} else if (cmd === "public-export") {
  const out = arg("--out");
  for (const f of ["storage-proofs/369/0xabc/100-0xdead.json", "light-client-proofs/a-b/1-2-0xff.json", "evidence/a-b/7-0xee.json", "README.txt"]) {
    fs.mkdirSync(path.dirname(path.join(out, f)), { recursive: true });
    fs.writeFileSync(path.join(out, f), `{"public":"${f}"}\n`);
  }
} else if (cmd === "public-check") {
  process.exit(exitFor("STUB_EXIT_CHECK"));
} else if (cmd === "verify-storage") {
  process.exit(exitFor("STUB_EXIT_VERIFY"));
}
console.log(JSON.stringify({ ok: true, command: cmd }));
EOS
  printf '#!/bin/sh\nshift\nexec "$@"\n' >"$PT/as.sh"
  chmod +x "$PT/as.sh"
  printf 'ZKB_RELEASE=abc123def\n' >"$PT/release.env"
  mkdir -p "$PT/src-backend/beacon-states/pulsechain" "$PT/src-runner/proof-cache/369/0xabc" "$PT/src-runner/beacon-states/eth"
  sqlite3 "$PT/src-backend/backend.sqlite" "CREATE TABLE proofs (id INTEGER PRIMARY KEY, body TEXT); INSERT INTO proofs (body) VALUES ('p1');"
  printf 'state-a\n' >"$PT/src-backend/beacon-states/pulsechain/a.ssz"
  printf '{"proof":1}\n' >"$PT/src-runner/proof-cache/369/0xabc/100-0xdead.json"
  printf 'state-e\n' >"$PT/src-runner/beacon-states/eth/s.ssz"

  # proofs <out dir> <backend state> <runner state> <env...> -- <args...>
  PROOFS_OUT=""
  proofs() {
    local out=$1 be=$2 ru=$3
    shift 3
    env ZKB_PROOFS_UNPRIVILEGED=1 ZKB_PROOFS_DIR="$out" ZKB_BACKEND_STATE="$be" ZKB_RUNNER_STATE="$ru" \
      ZKB_RELEASE_DIR="$PT" ZKB_PROOFS_AS="$PT/as.sh" ZKB_PROOFS_CLI="node $PT/stub-cli.mjs" STUB_LOG="$PT/calls.log" \
      "$@"
  }
  run_proofs() { # sets PROOFS_OUT and PROOFS_STATUS
    PROOFS_STATUS=0
    PROOFS_OUT=$("$@" 2>&1) || PROOFS_STATUS=$?
  }
  out1=$PT/out1
  : >"$PT/calls.log"
  run_proofs proofs "$out1" "$PT/src-backend" "$PT/src-runner" ZKB_PROOFS_STAMP=20260101T000000Z ZKB_PROOFS_KEEP=2 bash "$DIR/proofs.sh" export
  bundle=$out1/zk-bridge-proofs-20260101T000000Z.tar.gz
  if [ "$PROOFS_STATUS" -eq 0 ] && [ -f "$bundle" ] && [ -f "$bundle.sha256" ] && [ -z "$(ls -A "$out1" | grep -E '^\.staging-|^\.extract-')" ]; then
    pass "proofs.sh export: one bundle with its .sha256, no staging left"
  else
    fail "proofs.sh export (status $PROOFS_STATUS): $PROOFS_OUT"
  fi
  listing=$(tar -tzf "$bundle" 2>/dev/null || true)
  missing=""
  for entry in manifest.json archive/storage_proofs.ndjson archive/light_client_proofs.ndjson archive/message_evidence.ndjson archive/conflicts.ndjson \
    backend/backend.sqlite files/runner/proof-cache/369/0xabc/100-0xdead.json files/runner/beacon-states/eth/s.ssz files/backend/beacon-states/pulsechain/a.ssz; do
    printf '%s\n' "$listing" | grep -q "$entry\$" || missing="$missing $entry"
  done
  if [ -z "$missing" ]; then pass "proofs.sh export: the bundle has the expected layout"; else fail "bundle layout, missing:$missing"; fi
  if [ "$(grep -c . "$PT/calls.log")" -eq 5 ] && sed -n 1p "$PT/calls.log" | grep -q '^migrate' && sed -n 2p "$PT/calls.log" | grep -q '^ingest-cache --dir .*proof-cache$' \
    && sed -n 3p "$PT/calls.log" | grep -q '^ingest-backend --sqlite .*backend.sqlite$' && sed -n 4p "$PT/calls.log" | grep -q '^export --out ' \
    && sed -n 5p "$PT/calls.log" | grep -q '^manifest-write --dir .* --commit abc123def$'; then
    pass "proofs.sh export: CLI calls in order (migrate, ingest-cache, ingest-backend, export, manifest-write with the release)"
  else
    fail "export CLI calls: $(tr '\n' '|' <"$PT/calls.log")"
  fi
  # A snapshot, not the live file: it opens as a database.
  tar -xzf "$bundle" -C "$PT" ./backend/backend.sqlite 2>/dev/null || true
  if [ "$(sqlite3 "$PT/backend/backend.sqlite" 'SELECT body FROM proofs' 2>/dev/null)" = p1 ]; then pass "proofs.sh export: the SQLite snapshot is readable"; else fail "SQLite snapshot"; fi
  rm -rf "$PT/backend"

  # Retention.
  proofs "$out1" "$PT/src-backend" "$PT/src-runner" ZKB_PROOFS_STAMP=20260102T000000Z ZKB_PROOFS_KEEP=2 bash "$DIR/proofs.sh" export >/dev/null 2>&1 || true
  proofs "$out1" "$PT/src-backend" "$PT/src-runner" ZKB_PROOFS_STAMP=20260103T000000Z ZKB_PROOFS_KEEP=2 bash "$DIR/proofs.sh" export >/dev/null 2>&1 || true
  n=$(ls "$out1"/zk-bridge-proofs-*.tar.gz | wc -l | tr -d ' ')
  if [ "$n" -eq 2 ] && [ ! -e "$bundle" ] && [ ! -e "$bundle.sha256" ] && [ -f "$out1/zk-bridge-proofs-20260103T000000Z.tar.gz" ]; then pass "proofs.sh export: retention keeps the newest 2"; else fail "retention kept $n"; fi

  # Conflicts reported by the archive during export are a warning.
  run_proofs proofs "$out1" "$PT/src-backend" "$PT/src-runner" ZKB_PROOFS_STAMP=20260104T000000Z ZKB_PROOFS_KEEP=2 STUB_EXIT_INGEST=3 bash "$DIR/proofs.sh" export
  if [ "$PROOFS_STATUS" -eq 0 ] && printf '%s' "$PROOFS_OUT" | grep -q 'WARNING'; then pass "proofs.sh export: archive conflicts are a warning"; else fail "export with conflicts (status $PROOFS_STATUS)"; fi

  # Off-site hook: runs after the bundle; a failing hook fails the run but not the bundle.
  printf '#!/bin/sh\necho "$1 $2" >"%s/hook.out"\n' "$PT" >"$PT/hook-ok"
  printf '#!/bin/sh\nexit 1\n' >"$PT/hook-bad"
  chmod +x "$PT/hook-ok" "$PT/hook-bad"
  run_proofs proofs "$out1" "$PT/src-backend" "$PT/src-runner" ZKB_PROOFS_STAMP=20260105T000000Z ZKB_PROOFS_KEEP=2 ZKB_PROOFS_OFFSITE_HOOK="$PT/hook-ok" bash "$DIR/proofs.sh" export
  if [ "$PROOFS_STATUS" -eq 0 ] && grep -q 'zk-bridge-proofs-20260105T000000Z.tar.gz .*\.sha256$' "$PT/hook.out"; then pass "proofs.sh export: the off-site hook gets the bundle and its .sha256"; else fail "off-site hook (status $PROOFS_STATUS)"; fi
  run_proofs proofs "$out1" "$PT/src-backend" "$PT/src-runner" ZKB_PROOFS_STAMP=20260106T000000Z ZKB_PROOFS_KEEP=2 ZKB_PROOFS_OFFSITE_HOOK="$PT/hook-bad" bash "$DIR/proofs.sh" export
  if [ "$PROOFS_STATUS" -ne 0 ] && [ -f "$out1/zk-bridge-proofs-20260106T000000Z.tar.gz" ] && [ "$(ls "$out1"/zk-bridge-proofs-*.tar.gz | wc -l | tr -d ' ')" -eq 2 ]; then pass "proofs.sh export: a failing hook fails the run after the bundle and retention"; else fail "failing hook (status $PROOFS_STATUS)"; fi

  # Import into an empty server.
  good=$out1/zk-bridge-proofs-20260106T000000Z.tar.gz
  mkdir -p "$PT/dst-backend" "$PT/dst-runner"
  : >"$PT/calls.log"
  run_proofs proofs "$PT/out2" "$PT/dst-backend" "$PT/dst-runner" bash "$DIR/proofs.sh" import "$good"
  if [ "$PROOFS_STATUS" -eq 0 ] && cmp -s "$PT/dst-runner/proof-cache/369/0xabc/100-0xdead.json" "$PT/src-runner/proof-cache/369/0xabc/100-0xdead.json" \
    && cmp -s "$PT/dst-runner/beacon-states/eth/s.ssz" "$PT/src-runner/beacon-states/eth/s.ssz" \
    && cmp -s "$PT/dst-backend/beacon-states/pulsechain/a.ssz" "$PT/src-backend/beacon-states/pulsechain/a.ssz" \
    && [ "$(sqlite3 "$PT/dst-backend/backend.sqlite" 'SELECT body FROM proofs' 2>/dev/null)" = p1 ]; then
    pass "proofs.sh import into an empty target copies the files and installs the SQLite file"
  else
    fail "import into empty target (status $PROOFS_STATUS): $PROOFS_OUT"
  fi
  if grep -q '^import --in ' "$PT/calls.log" && grep -q '^migrate' "$PT/calls.log" && grep -q '^manifest-check' "$PT/calls.log" && grep -q '^ingest-backend --sqlite' "$PT/calls.log"; then pass "proofs.sh import: manifest-check, migrate, import, ingest-backend"; else fail "import CLI calls: $(tr '\n' '|' <"$PT/calls.log")"; fi
  if [ -z "$(ls -A "$PT/out2" | grep -E '^\.extract-')" ]; then pass "proofs.sh import: the temporary directory is gone"; else fail "extract dir left behind"; fi

  # A second import changes nothing.
  find "$PT/dst-runner" "$PT/dst-backend" -type f -exec cksum {} + | sort >"$PT/state-1"
  run_proofs proofs "$PT/out2" "$PT/dst-backend" "$PT/dst-runner" bash "$DIR/proofs.sh" import "$good"
  find "$PT/dst-runner" "$PT/dst-backend" -type f -exec cksum {} + | sort >"$PT/state-2"
  if [ "$PROOFS_STATUS" -eq 0 ] && cmp -s "$PT/state-1" "$PT/state-2" && printf '%s' "$PROOFS_OUT" | grep -q 'copied=0 identical=1 conflicts=0' && printf '%s' "$PROOFS_OUT" | grep -q 'conflicts: 0'; then pass "proofs.sh import: a second import is a no-op with zero conflicts"; else fail "second import (status $PROOFS_STATUS)"; fi

  # A file that exists with other content is reported and kept; exit 3 after the rest was done.
  printf '{"proof":"different"}\n' >"$PT/dst-runner/proof-cache/369/0xabc/100-0xdead.json"
  rm -f "$PT/dst-runner/beacon-states/eth/s.ssz"
  run_proofs proofs "$PT/out2" "$PT/dst-backend" "$PT/dst-runner" bash "$DIR/proofs.sh" import "$good"
  if [ "$PROOFS_STATUS" -eq 3 ] && printf '%s' "$PROOFS_OUT" | grep -q 'conflict: 369/0xabc/100-0xdead.json' \
    && [ "$(cat "$PT/dst-runner/proof-cache/369/0xabc/100-0xdead.json")" = '{"proof":"different"}' ] && [ -f "$PT/dst-runner/beacon-states/eth/s.ssz" ]; then
    pass "proofs.sh import: a changed file is reported (exit 3), not overwritten, and the rest is still restored"
  else
    fail "import with a changed file (status $PROOFS_STATUS)"
  fi
  # Conflicts the archive reports itself also give exit 3.
  run_proofs proofs "$PT/out2" "$PT/dst-backend" "$PT/dst-runner" STUB_EXIT_IMPORT=3 bash "$DIR/proofs.sh" import "$good"
  if [ "$PROOFS_STATUS" -eq 3 ]; then pass "proofs.sh import: archive conflicts give exit 3"; else fail "archive conflicts (status $PROOFS_STATUS)"; fi
  # An existing SQLite file is left alone.
  printf 'keep me\n' >"$PT/dst-backend/backend.sqlite"
  run_proofs proofs "$PT/out2" "$PT/dst-backend" "$PT/dst-runner" bash "$DIR/proofs.sh" import "$good"
  if [ "$(cat "$PT/dst-backend/backend.sqlite")" = 'keep me' ]; then pass "proofs.sh import: an existing backend.sqlite is not replaced"; else fail "backend.sqlite overwritten"; fi

  # verify: a good bundle passes; the newest is the default; tampering fails.
  : >"$PT/calls.log"
  run_proofs proofs "$out1" "$PT/src-backend" "$PT/src-runner" bash "$DIR/proofs.sh" verify
  if [ "$PROOFS_STATUS" -eq 0 ] && grep -q '^verify-storage --in ' "$PT/calls.log"; then pass "proofs.sh verify: the newest bundle passes"; else fail "verify (status $PROOFS_STATUS)"; fi
  run_proofs proofs "$out1" "$PT/src-backend" "$PT/src-runner" STUB_EXIT_VERIFY=3 bash "$DIR/proofs.sh" verify "$good"
  if [ "$PROOFS_STATUS" -eq 3 ]; then pass "proofs.sh verify: invalid proofs give a non-zero exit"; else fail "verify invalid (status $PROOFS_STATUS)"; fi
  mkdir -p "$PT/tamper-x" "$PT/out3"
  tar -xzf "$good" -C "$PT/tamper-x"
  printf 'x\n' >>"$PT/tamper-x/archive/storage_proofs.ndjson"
  tar -czf "$PT/out3/zk-bridge-proofs-20260107T000000Z.tar.gz" -C "$PT/tamper-x" .
  # Without a .sha256 the manifest catches it ...
  run_proofs proofs "$PT/out3" "$PT/src-backend" "$PT/src-runner" bash "$DIR/proofs.sh" verify
  if [ "$PROOFS_STATUS" -ne 0 ] && printf '%s' "$PROOFS_OUT" | grep -q 'manifest'; then pass "proofs.sh verify: a tampered bundle fails its manifest"; else fail "tampered, no sha256 (status $PROOFS_STATUS)"; fi
  # ... and with the old .sha256 next to it, the checksum does.
  cp "$good.sha256" "$PT/out3/zk-bridge-proofs-20260107T000000Z.tar.gz.sha256"
  run_proofs proofs "$PT/out3" "$PT/src-backend" "$PT/src-runner" bash "$DIR/proofs.sh" verify
  if [ "$PROOFS_STATUS" -ne 0 ] && printf '%s' "$PROOFS_OUT" | grep -q '.sha256'; then pass "proofs.sh verify: a tampered bundle fails its .sha256"; else fail "tampered, with sha256 (status $PROOFS_STATUS)"; fi
  # Import refuses it too.
  run_proofs proofs "$PT/out3" "$PT/dst-backend" "$PT/dst-runner" bash "$DIR/proofs.sh" import "$PT/out3/zk-bridge-proofs-20260107T000000Z.tar.gz"
  if [ "$PROOFS_STATUS" -eq 1 ]; then pass "proofs.sh import: a tampered bundle is refused"; else fail "import tampered (status $PROOFS_STATUS)"; fi


  # --- publish ---------------------------------------------------------------------------------------------------
  slot=000000000100
  h1=0x$(printf 'a%.0s' $(seq 1 64))
  h2=0x$(printf 'b%.0s' $(seq 1 64))
  for who in runner backend; do mkdir -p "$PT/p-$who/beacon-states/369" "$PT/p-$who/beacon-states/eth"; done
  printf 'ssz-1\n' >"$PT/p-runner/beacon-states/369/$slot-$h1.ssz"
  printf 'ssz-1\n' >"$PT/p-backend/beacon-states/369/$slot-$h1.ssz"
  printf 'summary\n' >"$PT/p-backend/beacon-states/369/$slot-$h2.summary"
  printf 'bad\n' >"$PT/p-runner/beacon-states/369/junk.ssz"
  printf 'bad\n' >"$PT/p-runner/beacon-states/369/$slot-$h1.ssz.bak"
  printf 'bad\n' >"$PT/p-runner/beacon-states/eth/$slot-$h1.ssz"
  ln -s /etc/hosts "$PT/p-runner/beacon-states/369/000000000200-$h1.ssz"
  # The IPFS node: a repository with the API secret and address, and a fake curl in front of the RPC API. The fake
  # records its argv and the header it got on standard input; the tests check that the secret never reaches an argv.
  ipfs_token=tok3nNEVERinARGV9f
  mkdir -p "$PT/ipfs" "$PT/ipfs-repo" "$PT/fakebin"
  printf '{"API":{"Authorizations":{"operator":{"AuthSecret":"bearer:%s","AllowedPaths":["/api/v0"]}}},"Addresses":{"API":"/ip4/127.0.0.1/tcp/5001"}}\n' "$ipfs_token" >"$PT/ipfs-repo/config"
  printf '/ip4/127.0.0.1/tcp/5001\n' >"$PT/ipfs-repo/api"
  cat >"$PT/fakebin/curl" <<'EOS'
#!/bin/sh
# Records argv, reads the header lines of `-H @-` from stdin, and answers like kubo's RPC API.
printf '%s\n' "$*" >>"$IPFS_DIR/argv"
cat >>"$IPFS_DIR/headers"
url= conf=
while [ $# -gt 0 ]; do
  case $1 in
    http://*) url=$1 ;;
    -K) shift; conf=$1 ;;
  esac
  shift
done
path=${url#http://*/}
echo "POST $url" >>"$IPFS_DIR/calls"
arg=${url##*arg=}; arg=${arg%%&*}
case /$path in
  /api/v0/add\?*)
    c=$(cat "$IPFS_DIR/n" 2>/dev/null || echo 0); c=$((c + 1)); echo "$c" >"$IPFS_DIR/n"
    cp "$conf" "$IPFS_DIR/last-add.conf"
    root=$(sed -n '1s/.*filename=\([^;]*\);.*/\1/p' "$conf")
    # The root first, then the rest: the script must pick the root by its name, not by position.
    printf '{"Name":"%s","Hash":"bafystub%s"}\n' "$root" "$c"
    sed -n '2,$s/.*filename=\([^;]*\);.*/\1/p' "$conf" | sed 's/%2F/\//g' | while IFS= read -r n; do printf '{"Name":"%s","Hash":"bafyleaf"}\n' "$n"; done
    echo "bafystub$c" >>"$IPFS_DIR/pins" ;;
  /api/v0/pin/ls\?*) grep -qx "$arg" "$IPFS_DIR/pins" 2>/dev/null || { echo '{"Message":"not pinned","Code":0,"Type":"error"}'; exit 22; } ;;
  /api/v0/pin/rm\?*) grep -vx "$arg" "$IPFS_DIR/pins" >"$IPFS_DIR/pins.new" || true; mv "$IPFS_DIR/pins.new" "$IPFS_DIR/pins"; echo "{\"Pins\":[\"$arg\"]}" ;;
  *) echo "unexpected $url" >&2; exit 22 ;;
esac
EOS
  chmod +x "$PT/fakebin/curl"
  printf '#!/bin/sh\nprintf "%%s\\n" "$*" >>"%s/ipfs/as-argv"\nshift\nexec "$@"\n' "$PT" >"$PT/as-rec.sh"
  chmod +x "$PT/as-rec.sh"
  pub() { # pub <out dir> <env...> -- args: runs proofs.sh publish with the publish test sources
    local out=$1
    shift
    proofs "$out" "$PT/p-backend" "$PT/p-runner" IPFS_DIR="$PT/ipfs" ZKB_IPFS_PATH="$PT/ipfs-repo" PATH="$PT/fakebin:$PATH" ZKB_PROOFS_AS="$PT/as-rec.sh" "$@"
  }
  : >"$PT/calls.log"
  run_proofs pub "$PT/pub1" ZKB_PROOFS_STAMP=20260110T000000Z bash "$DIR/proofs.sh" publish --dry-run
  tree=$PT/pub1/.publish-20260110T000000Z/tree
  if [ "$PROOFS_STATUS" -eq 0 ] && printf '%s' "$PROOFS_OUT" | grep -q "^tree: $tree\$" && [ -f "$tree/storage-proofs/369/0xabc/100-0xdead.json" ] \
    && [ -f "$tree/light-client-proofs/a-b/1-2-0xff.json" ] && [ -f "$tree/evidence/a-b/7-0xee.json" ] && [ -f "$tree/README.txt" ] && [ -f "$tree/manifest.json" ]; then
    pass "proofs.sh publish --dry-run builds the public tree and leaves it"
  else
    fail "publish --dry-run (status $PROOFS_STATUS): $PROOFS_OUT"
  fi
  beacon=$(cd "$tree" && find beacon-states -type f | sort | tr '\n' ' ')
  if [ "$beacon" = "beacon-states/369/$slot-$h1.ssz beacon-states/369/$slot-$h2.summary " ]; then pass "publish: only well-named beacon states, deduplicated, from numeric chain directories, no links"; else fail "beacon states in tree: $beacon"; fi
  if [ "$(grep -o '^[a-z-]*' "$PT/calls.log" | tr '\n' ' ')" = "public-export manifest-write public-check " ]; then pass "publish: public-export, manifest-write (--public), public-check in order"; else fail "publish CLI calls: $(tr '\n' '|' <"$PT/calls.log")"; fi
  if [ -z "$(find "$tree" -newermt 2000-01-03 -print -quit)" ] && [ ! -s "$PT/ipfs/calls" ] 2>/dev/null || [ ! -e "$PT/ipfs/calls" ]; then pass "publish --dry-run: fixed file times, nothing sent to ipfs"; else fail "dry run times or ipfs calls"; fi
  # A beacon state with the same name and other content stops the run before anything is added.
  printf 'ssz-OTHER\n' >"$PT/p-backend/beacon-states/369/$slot-$h1.ssz"
  run_proofs pub "$PT/pub2" ZKB_PROOFS_STAMP=20260110T000000Z bash "$DIR/proofs.sh" publish
  if [ "$PROOFS_STATUS" -ne 0 ] && printf '%s' "$PROOFS_OUT" | grep -q 'different content' && [ ! -e "$PT/ipfs/calls" ]; then pass "publish: a beacon state clash fails the run before ipfs"; else fail "clash (status $PROOFS_STATUS)"; fi
  printf 'ssz-1\n' >"$PT/p-backend/beacon-states/369/$slot-$h1.ssz"
  # The sanitizer failing stops it too.
  run_proofs pub "$PT/pub2" ZKB_PROOFS_STAMP=20260110T000000Z STUB_EXIT_CHECK=1 bash "$DIR/proofs.sh" publish
  if [ "$PROOFS_STATUS" -ne 0 ] && [ ! -e "$PT/ipfs/calls" ]; then pass "publish: a failing public-check stops the run before ipfs"; else fail "public-check failure (status $PROOFS_STATUS)"; fi
  # Real publications: the log, the pins and the retention.
  printf 'bafyforeign\n' >"$PT/ipfs/pins"
  for d in 1 2 3 4; do
    run_proofs pub "$PT/pub2" ZKB_PROOFS_STAMP=2026011${d}T000000Z ZKB_PROOFS_IPFS_KEEP=2 bash "$DIR/proofs.sh" publish
  done
  if [ "$PROOFS_STATUS" -eq 0 ] && printf '%s' "$PROOFS_OUT" | grep -q '^cid: bafystub4$' && printf '%s' "$PROOFS_OUT" | grep -q '^gateway: .*/ipfs/bafystub4$'; then pass "publish prints the CID and the gateway form"; else fail "publish output (status $PROOFS_STATUS): $PROOFS_OUT"; fi
  if [ "$(wc -l <"$PT/pub2/ipfs-cids.log" | tr -d ' ')" -eq 4 ] && [ "$(awk 'NF == 4 && $2 ~ /^bafystub/ && $3 == 7 && $4 == "abc123def"' "$PT/pub2/ipfs-cids.log" | wc -l | tr -d ' ')" -eq 4 ]; then pass "publish appends <time> <cid> <files> <commit> to ipfs-cids.log"; else fail "cid log: $(cat "$PT/pub2/ipfs-cids.log")"; fi
  if [ "$(sort "$PT/ipfs/pins" | tr '\n' ' ')" = "bafyforeign bafystub3 bafystub4 " ]; then pass "publish keeps the newest 2 pinned, unpins older logged CIDs only (not foreign pins)"; else fail "pins: $(tr '\n' ' ' <"$PT/ipfs/pins")"; fi
  if grep -q '^POST http://127\.0\.0\.1:5001/api/v0/add?cid-version=1&pin=true&pin-name=zkb-proofs-2026011[0-9]T000000Z&' "$PT/ipfs/calls"; then pass "publish: POST /api/v0/add with cid-version=1, pin=true and a pin name, at the api address"; else fail "add call: $(head -1 "$PT/ipfs/calls")"; fi
  if grep -q '^POST http://127\.0\.0\.1:5001/api/v0/pin/rm?arg=bafystub1$' "$PT/ipfs/calls" && grep -q '/api/v0/pin/ls?arg=bafystub1&type=recursive$' "$PT/ipfs/calls"; then pass "publish: pin ls and pin rm through the RPC API"; else fail "pin calls: $(tr '\n' '|' <"$PT/ipfs/calls")"; fi
  # The secret: on standard input as the header kubo expects, never in any argv (curl's, or anything run as a user).
  if grep -qF "$ipfs_token" "$PT/ipfs/argv" "$PT/ipfs/as-argv"; then fail "the IPFS API secret appears in an argv"; else pass "publish: the IPFS API secret is in no argv"; fi
  if [ "$(sort -u "$PT/ipfs/headers")" = "Authorization: Bearer $ipfs_token" ]; then pass "publish: Authorization: Bearer <token> from bearer:<token>, on stdin"; else fail "headers: $(sort -u "$PT/ipfs/headers" | sed "s/$ipfs_token/<token>/")"; fi
  if grep -q '^form = "file=@/dev/null;filename=tree;type=application/x-directory"$' "$PT/ipfs/last-add.conf" \
    && grep -q '^form = "file=@/dev/null;filename=tree%2Fstorage-proofs;type=application/x-directory"$' "$PT/ipfs/last-add.conf" \
    && grep -q '^form = "file=@.*/tree/storage-proofs/369/0xabc/100-0xdead\.json;filename=tree%2Fstorage-proofs%2F369%2F0xabc%2F100-0xdead\.json;type=application/octet-stream"$' "$PT/ipfs/last-add.conf" \
    && [ "$(head -1 "$PT/ipfs/last-add.conf")" = 'form = "file=@/dev/null;filename=tree;type=application/x-directory"' ]; then
    pass "publish: one multipart part per directory and file, names url-encoded, root first"
  else
    fail "add parts: $(head -3 "$PT/ipfs/last-add.conf" | tr '\n' '|')"
  fi
  # Other secret forms map as kubo maps them; an address off loopback and an unknown secret type are refused.
  rpc_try() { # rpc_try <AuthSecret> <api address>: one pin ls through the script's RPC call; sets rpc_status and rpc_header
    printf '{"API":{"Authorizations":{"o":{"AuthSecret":"%s"}}}}\n' "$1" >"$PT/ipfs-repo2/config"
    printf '%s\n' "$2" >"$PT/ipfs-repo2/api"
    : >"$PT/ipfs/headers"
    rpc_status=0
    env IPFS_DIR="$PT/ipfs" IPFS_PATH="$PT/ipfs-repo2" PATH="$PT/fakebin:$PATH" sh -c "$rpc_script" sh "/api/v0/pin/ls?arg=bafystub4&type=recursive" >/dev/null 2>&1 || rpc_status=$?
    rpc_header=$(cat "$PT/ipfs/headers")
  }
  mkdir -p "$PT/ipfs-repo2"
  rpc_script=$(sed -n "/^IPFS_RPC='/,/^'\$/p" "$DIR/proofs.sh" | sed '1s/^IPFS_RPC=.//;$d')
  rpc_try 'basic:alice:pw' /ip4/127.0.0.1/tcp/5001
  if [ "$rpc_header" = "Authorization: Basic YWxpY2U6cHc=" ] && [ "$rpc_status" -eq 0 ]; then pass "ipfs rpc: basic:user:pass is Basic base64(user:pass)"; else fail "basic header"; fi
  rpc_try 'plaintoken' /ip4/127.0.0.1/tcp/5001
  if [ "$rpc_header" = "Authorization: Bearer plaintoken" ]; then pass "ipfs rpc: a secret without a type is a Bearer token"; else fail "untyped header"; fi
  rpc_try 'weird:x' /ip4/127.0.0.1/tcp/5001
  if [ -z "$rpc_header" ] && [ "$rpc_status" -ne 0 ]; then pass "ipfs rpc: an unknown secret type is refused"; else fail "unknown type accepted"; fi
  rpc_try 'bearer:t' /ip4/10.0.0.5/tcp/5001
  if [ -z "$rpc_header" ] && [ "$rpc_status" -ne 0 ]; then pass "ipfs rpc: an API address off loopback is refused"; else fail "non-loopback accepted"; fi
  rm -f "$PT/ipfs-repo2/api"
  printf '{"API":{"Authorizations":{"o":{"AuthSecret":"bearer:t"}}},"Addresses":{"API":["/ip4/127.0.0.1/tcp/5002"]}}\n' >"$PT/ipfs-repo2/config"
  : >"$PT/ipfs/calls"
  env IPFS_DIR="$PT/ipfs" IPFS_PATH="$PT/ipfs-repo2" PATH="$PT/fakebin:$PATH" sh -c "$rpc_script" sh "/api/v0/pin/ls?arg=x&type=recursive" >/dev/null 2>&1 || true
  if grep -q '^POST http://127\.0\.0\.1:5002/' "$PT/ipfs/calls"; then pass "ipfs rpc: without an api file, Addresses.API of the config"; else fail "Addresses.API fallback: $(cat "$PT/ipfs/calls")"; fi
  if [ -z "$(ls -A "$PT/pub2" | grep -E '^\.publish-')" ]; then pass "publish: the work directory is gone after a real publication"; else fail "publish work dir left"; fi
  # The nightly export publishes only when told to; the backup manifest then records the log.
  : >"$PT/calls.log"
  run_proofs pub "$PT/pub3" ZKB_PROOFS_STAMP=20260120T000000Z bash "$DIR/proofs.sh" export
  if [ "$PROOFS_STATUS" -eq 0 ] && ! grep -q '^public-export' "$PT/calls.log"; then pass "proofs.sh export does not publish by default"; else fail "export published by default (status $PROOFS_STATUS)"; fi
  n=$(wc -l <"$PT/ipfs/calls" | tr -d ' ')
  run_proofs pub "$PT/pub3" ZKB_PROOFS_STAMP=20260121T000000Z ZKB_PROOFS_PUBLISH=1 bash "$DIR/proofs.sh" export
  if [ "$PROOFS_STATUS" -eq 0 ] && grep -q '^public-export' "$PT/calls.log" && [ "$(wc -l <"$PT/ipfs/calls" | tr -d ' ')" -gt "$n" ] && [ -f "$PT/pub3/ipfs-cids.log" ]; then pass "proofs.sh export publishes with ZKB_PROOFS_PUBLISH=1"; else fail "export with publish (status $PROOFS_STATUS): $PROOFS_OUT"; fi
  run_proofs pub "$PT/pub3" ZKB_PROOFS_STAMP=20260122T000000Z ZKB_PROOFS_PUBLISH=1 STUB_EXIT_CHECK=1 bash "$DIR/proofs.sh" export
  if [ "$PROOFS_STATUS" -ne 0 ] && [ -f "$PT/pub3/zk-bridge-proofs-20260122T000000Z.tar.gz" ]; then pass "export: a failing publication fails the run after the bundle is written"; else fail "export with failing publish (status $PROOFS_STATUS)"; fi
  if grep -q -- '--ipfs-log ' "$PT/calls.log"; then pass "export: manifest-write gets --ipfs-log once a publication exists"; else fail "no --ipfs-log"; fi

  # Two runs never overlap, and usage errors exit 2.
  mkdir -p "$PT/out4/.lock.d"
  if ! command -v flock >/dev/null 2>&1; then
    run_proofs proofs "$PT/out4" "$PT/src-backend" "$PT/src-runner" bash "$DIR/proofs.sh" export
    if [ "$PROOFS_STATUS" -eq 1 ] && printf '%s' "$PROOFS_OUT" | grep -q 'lock'; then pass "proofs.sh: a held lock stops a second run"; else fail "lock (status $PROOFS_STATUS)"; fi
  fi
  run_proofs proofs "$PT/out4" "$PT/src-backend" "$PT/src-runner" bash "$DIR/proofs.sh" bogus
  if [ "$PROOFS_STATUS" -eq 2 ]; then pass "proofs.sh: usage error exits 2"; else fail "usage (status $PROOFS_STATUS)"; fi
  if [ "$(id -u)" -ne 0 ]; then
    run_proofs env ZKB_PROOFS_DIR="$PT/out5" bash "$DIR/proofs.sh" export
    if [ "$PROOFS_STATUS" -eq 1 ] && [ "$PROOFS_OUT" = "proofs: run as root" ]; then pass "proofs.sh refuses to run without root"; else fail "proofs.sh without root (status $PROOFS_STATUS: $PROOFS_OUT)"; fi
  fi
  PT_DONE=1
fi

# --- Operator-side pull (deploy/operator) ---------------------------------------------------------------------------
operator_status=0
operator_output=$(bash "$DIR/../operator/test.sh" 2>&1) || operator_status=$?
if [ "$operator_status" -eq 0 ]; then
  pass "operator pull tests ($(printf '%s\n' "$operator_output" | grep -c '^PASS') checks)"
else
  fail "operator pull tests"
  printf '%s\n' "$operator_output" | grep -v '^PASS'
fi

printf '%d failure(s)\n' "$FAILURES"
[ "$FAILURES" -eq 0 ]
