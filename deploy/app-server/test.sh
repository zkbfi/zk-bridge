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
# The status service is the same: one process on one port, and so is the IPFS node's WebSocket listener.
if grep -E '^[[:space:]]*reverse_proxy' "$DIR/Caddyfile" | grep -vF -e '{$ZKB_IPFS_GATEWAY_PORT:8080}' -e '{$ZKB_STATUS_PORT:8790}' -e '{$ZKB_IPFS_WS_PORT:4003}' | grep -q .; then
  fail "Caddyfile: only the IPFS gateway (path and subdomain sites), the IPFS WebSocket listener and the status service may reverse_proxy directly"
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
# Root unpacks tars that service users stream: the archive's setuid, setgid and sticky bits must never survive, and the
# destination stays 0700 until it is checked.
UT=$(mktemp -d)
mkdir -p "$UT/src/d" "$UT/dst" && printf x >"$UT/src/d/f" && chmod 4755 "$UT/src/d/f" && chmod 2775 "$UT/src/d"
eval "$(sed -n '/^plain_modes() {/,/^}/p;/^untar() {/,/^}/p' "$DIR/proofs.sh")"
mode() { stat -c %a "$1" 2>/dev/null || stat -f %Lp "$1"; }
if tar -cf - -C "$UT/src" . | untar "$UT/dst" && [ "$(mode "$UT/dst")" = 700 ] && [ -z "$(find "$UT/dst" -perm -4000 -o -perm -2000)" ] \
  && plain_modes "$UT/dst" && [ "$(mode "$UT/dst/d/f")" = 644 ] && [ "$(mode "$UT/dst/d")" = 755 ]; then
  pass "proofs.sh untar: no setuid/setgid from the archive, 0700 until checked, then 0644/0755"
else
  fail "proofs.sh untar modes: dst $(mode "$UT/dst") file $(mode "$UT/dst/d/f") dir $(mode "$UT/dst/d")"
fi
rm -rf "$UT"
# A trust-list lookup takes whole lines only: a path with a newline must not match a line that is listed.
TL=$(mktemp -d)
eval "$(sed -n '/^trust_line_ok() {/,/^}/p;/^trusted() {/,/^}/p' "$DIR/proofs.sh")"
good=$(printf 'a%.0s' $(seq 1 64))
printf '%s  beacon-states/1/000000000001-0x%s.ssz\n' "$good" "$good" >"$TL/list"
nl='
'
if TRUST_LIST=$TL/list trusted "$good" "beacon-states/1/000000000001-0x$good.ssz" \
  && ! TRUST_LIST=$TL/list trusted "$good" "beacon-states/1x${nl}$good  beacon-states/1/000000000001-0x$good.ssz" \
  && ! TRUST_LIST=$TL/list trusted "${good}${nl}x" "beacon-states/1/000000000001-0x$good.ssz"; then
  pass "proofs.sh trusted: whole lines only, a newline in a name or hash never matches"
else
  fail "proofs.sh trusted: newline handling"
fi
rm -rf "$TL"
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
# The window of the mirror and the pins are documented where the operator sets them.
has_line config/proofs/proofs.env.example "#ZKB_PROOFS_RETENTION_DAYS=30"
has_line config/proofs/proofs.env.example "#ZKB_PROOFS_IPFS_KEEP=2"
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
if grep -q '^offsite_upload()' "$DIR/proofs.sh" && grep -q 'offsite_upload "\$MIRROR"' "$DIR/proofs.sh"; then pass "proofs.sh export calls offsite_upload"; else fail "proofs.sh lacks the off-site hook"; fi

# --- Proof archive: proofs.sh run for real against temporary directories ---------------------------------------------
# The mirror commands (add, prune, manifest, check, states) run the real archive CLI, without a database; the commands
# that need Postgres run a stub.
REAL_CLI=$DIR/../../explorer/indexer/bin/zk-bridge-proof-archive.mjs
if ! command -v node >/dev/null 2>&1 || ! command -v sqlite3 >/dev/null 2>&1; then
  printf 'SKIP  proofs.sh functional test: needs node and sqlite3\n'
elif [ ! -d "$DIR/../../explorer/indexer/node_modules/tsx" ]; then
  printf 'SKIP  proofs.sh functional test: the archive CLI needs its packages (pnpm install in explorer/)\n'
else
  PT=$(mktemp -d)
  # A crash of this block (set -u, set -e) must fail the run. bash 3.2 gives an EXIT trap $? = 0 after an unbound
  # variable, so the block marks its end instead, and the trap fails the run when the mark is missing.
  PT_DONE=0
  trap 'rm -rf "$PT"; if [ "$PT_DONE" != 1 ]; then printf "FAIL  the proofs.sh functional block stopped before its end\n"; exit 1; fi' EXIT
  # The stub of zk-bridge-proof-archive.mjs: records its calls, hands the mirror commands to the real CLI, writes fake
  # records and a real manifest for the rest.
  cat >"$PT/stub-cli.mjs" <<'EOS'
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { spawnSync } from "node:child_process";
const [cmd, ...rest] = process.argv.slice(2);
const arg = (n) => rest[rest.indexOf(n) + 1];
fs.appendFileSync(process.env.STUB_LOG, `${cmd} ${rest.join(" ")}\n`);
const walk = (d, base = d) => fs.readdirSync(d, { withFileTypes: true }).flatMap((e) =>
  e.isDirectory() ? walk(path.join(d, e.name), base) : [path.relative(base, path.join(d, e.name))]);
const hash = (bytes) => crypto.createHash("sha256").update(bytes).digest("hex");
const exitFor = (key) => Number(process.env[key] || 0);
if (["mirror-add", "mirror-prune", "mirror-manifest", "mirror-check", "mirror-states"].includes(cmd)) {
  if (cmd === "mirror-add" && process.env.STUB_SKIP_ADD) process.exit(0);
  process.exit(spawnSync(process.execPath, [process.env.REAL_CLI, cmd, ...rest], { stdio: "inherit" }).status ?? 1);
}
if (cmd === "mirror-write") {
  // One storage proof record, named by its content like the real ones.
  const text = process.env.STUB_RECORD || '{"stub":"storage proof"}\n';
  const file = path.join(arg("--dir"), "storage-proofs", "369", "0xabc", `100-0xdead.${hash(text)}.json`);
  if (fs.existsSync(file)) process.exit(0);
  const other = fs.existsSync(path.dirname(file)) && fs.readdirSync(path.dirname(file)).length > 0 && process.env.STUB_RECORD_CLASH;
  if (other) { console.error(`ERROR: ${path.relative(arg("--dir"), file)} exists with other content; it was not rewritten`); process.exit(3); }
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text, { mode: 0o644 });
  fs.chmodSync(file, 0o644);
} else if (cmd === "export") {
  fs.mkdirSync(path.join(arg("--out"), "archive"), { recursive: true });
  for (const n of ["storage_proofs", "light_client_proofs", "message_evidence", "conflicts"]) fs.writeFileSync(path.join(arg("--out"), "archive", `${n}.ndjson`), `{"stub":"${n}"}\n`);
} else if (cmd === "manifest-write") {
  const dir = arg("--dir");
  const files = {};
  for (const f of walk(dir)) if (f !== "manifest.json") files[f] = { sha256: hash(fs.readFileSync(path.join(dir, f))), bytes: fs.statSync(path.join(dir, f)).size };
  fs.writeFileSync(path.join(dir, "manifest.json"), JSON.stringify({ formatVersion: 1, createdAt: "now", commit: arg("--commit"), host: "stub", files, counts: {} }));
} else if (cmd === "manifest-check") {
  const dir = arg("--dir");
  const m = JSON.parse(fs.readFileSync(path.join(dir, "manifest.json"), "utf8"));
  let bad = 0;
  for (const [f, v] of Object.entries(m.files)) if (!fs.existsSync(path.join(dir, f)) || hash(fs.readFileSync(path.join(dir, f))) !== v.sha256) { console.error(`changed or missing: ${f}`); bad = 1; }
  for (const f of walk(dir)) if (f !== "manifest.json" && !(f in m.files)) { console.error(`unlisted: ${f}`); bad = 1; }
  process.exit(bad);
} else if (cmd === "import") {
  if (!fs.existsSync(path.join(arg("--in"), "archive", "storage_proofs.ndjson"))) process.exit(1);
  process.exit(exitFor("STUB_EXIT_IMPORT"));
} else if (cmd === "mirror-import") {
  if (!fs.existsSync(path.join(arg("--dir"), "storage-proofs"))) process.exit(1);
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
  # mkstate <state dir> <chain> <days ago> <root hex digit> [tail]: a beacon state whose slot is that many days old (on
  # the 12 second grid of the genesis it carries), the way the prover names it; prints the path under the state dir.
  cat >"$PT/mkstate.mjs" <<'EOS'
import fs from "node:fs";
import path from "node:path";
const [dir, chain, days, digit, tail = "state"] = process.argv.slice(2);
const genesis = 1655733600;
const slot = Math.floor((Date.now() / 1000 - Number(days) * 86400 - genesis) / 12);
const head = Buffer.alloc(48);
head.writeBigUInt64LE(BigInt(genesis), 0);
head.writeBigUInt64LE(BigInt(slot), 40);
const name = `${chain}/${String(slot).padStart(12, "0")}-0x${digit.repeat(64)}.ssz`;
fs.mkdirSync(path.join(dir, chain), { recursive: true });
fs.writeFileSync(path.join(dir, name), Buffer.concat([head, Buffer.from(tail)]));
console.log(name);
EOS
  mkstate() { node "$PT/mkstate.mjs" "$@"; }
  printf '#!/bin/sh\nshift\nexec "$@"\n' >"$PT/as.sh"
  chmod +x "$PT/as.sh"
  printf 'ZKB_RELEASE=abc123def\n' >"$PT/release.env"
  mkdir -p "$PT/src-backend" "$PT/src-runner/proof-cache/369/0xabc"
  sqlite3 "$PT/src-backend/backend.sqlite" "CREATE TABLE proofs (id INTEGER PRIMARY KEY, body TEXT); INSERT INTO proofs (body) VALUES ('p1');"
  printf '{"proof":1}\n' >"$PT/src-runner/proof-cache/369/0xabc/100-0xdead.json"
  # Beacon states: one both services hold (identical), one only the backend holds (with its summary), and a junk name.
  state_a=$(mkstate "$PT/src-runner/beacon-states" 11155111 0.5 a)
  mkdir -p "$PT/src-backend/beacon-states/11155111"
  cp "$PT/src-runner/beacon-states/$state_a" "$PT/src-backend/beacon-states/$state_a"
  state_b=$(mkstate "$PT/src-backend/beacon-states" 11155111 2 b)
  printf '0x01\n0x02\n' >"$PT/src-backend/beacon-states/${state_b%.ssz}.summary"
  printf 'junk\n' >"$PT/src-runner/beacon-states/11155111/junk.ssz"
  # As on the server: the services write their files 0600, and the backend's database runs in WAL mode.
  chmod 600 "$PT/src-runner/proof-cache/369/0xabc/100-0xdead.json" "$PT/src-runner/beacon-states/$state_a" "$PT/src-backend/beacon-states/$state_a" \
    "$PT/src-backend/beacon-states/$state_b" "$PT/src-backend/beacon-states/${state_b%.ssz}.summary"
  sqlite3 "$PT/src-backend/backend.sqlite" "PRAGMA journal_mode=WAL;" >/dev/null

  # proofs <out dir> <backend state> <runner state> <env...> -- <args...>
  PROOFS_OUT=""
  proofs() {
    local out=$1 be=$2 ru=$3
    shift 3
    env ZKB_PROOFS_UNPRIVILEGED=1 ZKB_PROOFS_DIR="$out" ZKB_BACKEND_STATE="$be" ZKB_RUNNER_STATE="$ru" \
      ZKB_RELEASE_DIR="$PT" ZKB_PROOFS_AS="$PT/as.sh" ZKB_PROOFS_CLI="node $PT/stub-cli.mjs" STUB_LOG="$PT/calls.log" REAL_CLI="$REAL_CLI" \
      "$@"
  }
  # out_has <pattern>: whether the last output has a line that matches. A here-string, not a pipe into `grep -q`: under
  # pipefail, grep leaving early could fail the writer.
  out_has() { grep -q -- "$1" <<<"$PROOFS_OUT"; }
  sha256_file() { if command -v sha256sum >/dev/null 2>&1; then sha256sum "$1" | awk '{print $1}'; else shasum -a 256 "$1" | awk '{print $1}'; fi; }
  # Stamps of today, so that the 30 day window keeps them.
  D=$(date -u +%Y%m%d)
  run_proofs() { # sets PROOFS_OUT and PROOFS_STATUS
    PROOFS_STATUS=0
    PROOFS_OUT=$("$@" 2>&1) || PROOFS_STATUS=$?
  }
  # modes_wrong <find arguments...>: the paths whose mode is not exactly $MODE.
  modes_wrong() { find "$@" ! -perm "$MODE" -print 2>/dev/null; }
  out1=$PT/out1
  m=$out1/mirror
  : >"$PT/calls.log"
  run_proofs proofs "$out1" "$PT/src-backend" "$PT/src-runner" ZKB_PROOFS_STAMP=${D}T000100Z bash "$DIR/proofs.sh" export
  if [ "$PROOFS_STATUS" -eq 0 ] && [ -f "$m/manifests/${D}T000100Z.json" ] && [ -f "$m/snapshots/${D}T000100Z.sqlite" ] \
    && [ -z "$(ls -A "$out1" | grep -E '^\.staging-|^\.extract-|\.tar\.gz')" ] && out_has "^manifest: $m/manifests/${D}T000100Z.json\$"; then
    pass "proofs.sh export: the mirror with its manifest and snapshot of the day, no staging left, no tarball"
  else
    fail "proofs.sh export (status $PROOFS_STATUS): $PROOFS_OUT"
  fi
  missing=""
  for entry in storage-proofs light-client-proofs evidence conflicts beacon-states snapshots manifests "beacon-states/$state_a" "beacon-states/$state_b" "beacon-states/${state_b%.ssz}.summary"; do
    [ -e "$m/$entry" ] || missing="$missing $entry"
  done
  if [ -z "$missing" ] && [ ! -e "$m/beacon-states/11155111/junk.ssz" ] && [ -n "$(find "$m/storage-proofs" -name '100-0xdead.*.json')" ]; then pass "proofs.sh export: records, both services' beacon states (not junk) in the mirror's layout"; else fail "mirror layout, missing:$missing"; fi
  if [ "$(grep -o '^[a-z-]*' "$PT/calls.log" | tr '\n' ' ')" = "migrate ingest-cache ingest-backend mirror-write mirror-add mirror-add mirror-add mirror-prune mirror-manifest " ] \
    && grep -q '^mirror-prune --dir .* --days 30 --held .*root/beacon-runner,.*root/beacon-backend$' "$PT/calls.log" && grep -q '^ingest-backend --sqlite .*/root/snapshots/' "$PT/calls.log" && grep -q "^mirror-manifest --dir .* --stamp ${D}T000100Z --commit abc123def --days 30 --print\$" "$PT/calls.log"; then
    pass "proofs.sh export: CLI calls in order (migrate, ingest, mirror-write, mirror-add x3, mirror-prune 30 days with the held states, mirror-manifest)"
  else
    fail "export CLI calls: $(tr '\n' '|' <"$PT/calls.log")"
  fi
  # The modes, explicitly: this test runs as one user, so a file the archive user could not read would pass unnoticed.
  MODE=0750; bad=$(modes_wrong "$m" -maxdepth 0)
  MODE=0755; bad=$bad$(modes_wrong "$m" -mindepth 1 -type d)
  MODE=0644; bad=$bad$(modes_wrong "$m" -type f)
  if [ -z "$bad" ]; then pass "proofs.sh export: mirror 0750, its directories 0755, every file 0644 (copies of 0600 service files too)"; else fail "mirror modes: $bad"; fi
  if [ "$(sqlite3 "$m/snapshots/${D}T000100Z.sqlite" 'SELECT body FROM proofs' 2>/dev/null)" = p1 ]; then pass "proofs.sh export: the SQLite snapshot is readable"; else fail "SQLite snapshot"; fi
  # The archive user opens the snapshot read only, so it must not be in WAL mode (that needs a writable -shm).
  if [ "$(sqlite3 "$m/snapshots/${D}T000100Z.sqlite" 'PRAGMA journal_mode;' 2>/dev/null)" = delete ]; then pass "proofs.sh export: the snapshot uses a rollback journal, not WAL"; else fail "snapshot journal mode"; fi
  manifest1=$m/manifests/${D}T000100Z.json
  if grep -q "\"beacon-states/$state_a\"" "$manifest1" && grep -q "\"snapshots/${D}T000100Z.sqlite\"" "$manifest1" && grep -q '"storage-proofs/369/0xabc/100-0xdead\.' "$manifest1" && ! grep -q '"manifests/' "$manifest1"; then pass "proofs.sh export: the manifest lists every file but the manifests"; else fail "manifest content"; fi

  # The next night: nothing is rewritten, a second snapshot and manifest.
  cksum "$m/beacon-states/$state_a" >"$PT/ck-1"
  ls -li "$m/beacon-states/$state_a" | awk '{print $1}' >>"$PT/ck-1"
  run_proofs proofs "$out1" "$PT/src-backend" "$PT/src-runner" ZKB_PROOFS_STAMP=${D}T000200Z bash "$DIR/proofs.sh" export
  cksum "$m/beacon-states/$state_a" >"$PT/ck-2"
  ls -li "$m/beacon-states/$state_a" | awk '{print $1}' >>"$PT/ck-2"
  if [ "$PROOFS_STATUS" -eq 0 ] && cmp -s "$PT/ck-1" "$PT/ck-2" && [ "$(ls "$m/manifests" | wc -l | tr -d ' ')" -eq 2 ] && [ "$(ls "$m/snapshots" | wc -l | tr -d ' ')" -eq 2 ]; then pass "proofs.sh export: a second night rewrites nothing and adds a snapshot and a manifest"; else fail "second export (status $PROOFS_STATUS): $PROOFS_OUT"; fi

  # Retention: by the slot's time and the stamps. A state the services still hold but older than the window is dropped
  # without a warning; records are never dropped; a file put in by hand (0600) is made readable.
  old_state=$(mkstate "$m/beacon-states" 11155111 31 c)
  printf '0x01\n0x02\n' >"$m/beacon-states/${old_state%.ssz}.summary"
  held_old=$(mkstate "$PT/src-runner/beacon-states" 11155111 40 d)
  printf 'old\n' >"$m/snapshots/20251101T000000Z.sqlite"
  printf '{}\n' >"$m/manifests/20251101T000000Z.json"
  mkdir -p "$m/evidence/p/first-to-second"
  printf 'by hand\n' >"$m/evidence/p/first-to-second/old.json"
  chmod 600 "$m/evidence/p/first-to-second/old.json"
  run_proofs proofs "$out1" "$PT/src-backend" "$PT/src-runner" ZKB_PROOFS_STAMP=${D}T000300Z bash "$DIR/proofs.sh" export
  if [ "$PROOFS_STATUS" -eq 0 ] && [ ! -e "$m/beacon-states/$old_state" ] && [ ! -e "$m/beacon-states/${old_state%.ssz}.summary" ] && [ ! -e "$m/beacon-states/$held_old" ] \
    && [ ! -e "$m/snapshots/20251101T000000Z.sqlite" ] && [ ! -e "$m/manifests/20251101T000000Z.json" ] && [ -e "$m/beacon-states/$state_a" ] \
    && [ -f "$m/evidence/p/first-to-second/old.json" ] && [ -f "$m/snapshots/${D}T000100Z.sqlite" ] && ! out_has WARNING; then
    pass "proofs.sh export: drops beacon states (by slot time), snapshots and manifests older than 30 days; keeps records; no warning for a held state the window drops"
  else
    fail "retention (status $PROOFS_STATUS): $PROOFS_OUT"
  fi
  MODE=0644
  if [ -z "$(modes_wrong "$m/evidence/p/first-to-second/old.json")" ]; then pass "proofs.sh export: a 0600 file put into the mirror by hand becomes 0644"; else fail "hand-placed file mode"; fi
  rm -f "$PT/src-runner/beacon-states/$held_old" "$m/evidence/p/first-to-second/old.json"
  # ZKB_PROOFS_RETENTION_DAYS sets the window; it must be a number.
  run_proofs proofs "$out1" "$PT/src-backend" "$PT/src-runner" ZKB_PROOFS_STAMP=${D}T000310Z ZKB_PROOFS_RETENTION_DAYS=1 bash "$DIR/proofs.sh" export
  if [ "$PROOFS_STATUS" -eq 0 ] && [ ! -e "$m/beacon-states/$state_b" ] && [ -e "$m/beacon-states/$state_a" ] && grep -q '"retentionDays": 1' "$m/manifests/${D}T000310Z.json"; then pass "proofs.sh export: ZKB_PROOFS_RETENTION_DAYS=1 keeps one day"; else fail "retention days (status $PROOFS_STATUS): $PROOFS_OUT"; fi
  rm -f "$m/manifests/${D}T000310Z.json"
  run_proofs proofs "$out1" "$PT/src-backend" "$PT/src-runner" ZKB_PROOFS_STAMP=${D}T000320Z ZKB_PROOFS_RETENTION_DAYS=thirty bash "$DIR/proofs.sh" export
  if [ "$PROOFS_STATUS" -eq 1 ] && out_has 'RETENTION_DAYS must be a positive number'; then pass "proofs.sh export: a window that is not a number is refused"; else fail "bad window (status $PROOFS_STATUS)"; fi

  # A state the services hold that did not reach the mirror is a WARNING (here: the copy is skipped).
  state_e=$(mkstate "$PT/src-runner/beacon-states" 11155111 0.5 e)
  run_proofs proofs "$out1" "$PT/src-backend" "$PT/src-runner" ZKB_PROOFS_STAMP=${D}T000400Z STUB_SKIP_ADD=1 bash "$DIR/proofs.sh" export
  if [ "$PROOFS_STATUS" -eq 0 ] && out_has "WARNING: the services hold the beacon state $state_e, and the mirror does not" \
    && out_has 'WARNING: 3 beacon state(s) that the services hold are not in the mirror'; then
    pass "proofs.sh export: a held state missing from the mirror after the run is a WARNING, named"
  else
    fail "held-missing warning (status $PROOFS_STATUS): $PROOFS_OUT"
  fi
  run_proofs proofs "$out1" "$PT/src-backend" "$PT/src-runner" ZKB_PROOFS_STAMP=${D}T000410Z bash "$DIR/proofs.sh" export
  if [ "$PROOFS_STATUS" -eq 0 ] && [ -e "$m/beacon-states/$state_e" ] && [ -e "$m/beacon-states/$state_b" ] && ! out_has WARNING; then pass "proofs.sh export: the next run takes the missing states in"; else fail "catch-up export (status $PROOFS_STATUS): $PROOFS_OUT"; fi

  # Another content under a name the mirror has: never overwritten, ERROR, the run fails at its end with the manifest written.
  cp "$m/beacon-states/$state_b" "$PT/state-b.keep"
  printf 'other bytes\n' >>"$PT/src-backend/beacon-states/$state_b"
  run_proofs proofs "$out1" "$PT/src-backend" "$PT/src-runner" ZKB_PROOFS_STAMP=${D}T000500Z bash "$DIR/proofs.sh" export
  if [ "$PROOFS_STATUS" -eq 1 ] && out_has "ERROR: beacon-states/$state_b exists with other content" && cmp -s "$m/beacon-states/$state_b" "$PT/state-b.keep" \
    && [ -f "$m/manifests/${D}T000500Z.json" ]; then
    pass "proofs.sh export: other content under an existing name fails loudly, after the manifest; the file is not rewritten"
  else
    fail "write-once clash (status $PROOFS_STATUS): $PROOFS_OUT"
  fi
  cp "$PT/state-b.keep" "$PT/src-backend/beacon-states/$state_b"
  run_proofs proofs "$out1" "$PT/src-backend" "$PT/src-runner" ZKB_PROOFS_STAMP=${D}T000510Z STUB_RECORD='{"stub":"changed"}' STUB_RECORD_CLASH=1 bash "$DIR/proofs.sh" export
  if [ "$PROOFS_STATUS" -eq 1 ] && out_has 'ERROR: mirror-write found a file'; then pass "proofs.sh export: a record clash in mirror-write fails the run too"; else fail "record clash (status $PROOFS_STATUS): $PROOFS_OUT"; fi
  run_proofs proofs "$out1" "$PT/src-backend" "$PT/src-runner" ZKB_PROOFS_STAMP=${D}T000510Z bash "$DIR/proofs.sh" export
  if [ "$PROOFS_STATUS" -eq 1 ] && out_has "manifest ${D}T000510Z exists already"; then pass "proofs.sh export: a stamp whose manifest exists is refused"; else fail "same stamp (status $PROOFS_STATUS)"; fi

  # Conflicts reported by the archive during export are a warning.
  run_proofs proofs "$out1" "$PT/src-backend" "$PT/src-runner" ZKB_PROOFS_STAMP=${D}T000600Z STUB_EXIT_INGEST=3 bash "$DIR/proofs.sh" export
  if [ "$PROOFS_STATUS" -eq 0 ] && out_has 'WARNING: ingest'; then pass "proofs.sh export: archive conflicts are a warning"; else fail "export with conflicts (status $PROOFS_STATUS)"; fi

  # Off-site hook: runs after the mirror; a failing hook fails the run but not the mirror.
  printf '#!/bin/sh\necho "$1 $2" >"%s/hook.out"\n' "$PT" >"$PT/hook-ok"
  printf '#!/bin/sh\nexit 1\n' >"$PT/hook-bad"
  chmod +x "$PT/hook-ok" "$PT/hook-bad"
  run_proofs proofs "$out1" "$PT/src-backend" "$PT/src-runner" ZKB_PROOFS_STAMP=${D}T000700Z ZKB_PROOFS_OFFSITE_HOOK="$PT/hook-ok" bash "$DIR/proofs.sh" export
  if [ "$PROOFS_STATUS" -eq 0 ] && [ "$(cat "$PT/hook.out")" = "$m $m/manifests/${D}T000700Z.json" ]; then pass "proofs.sh export: the off-site hook gets the mirror and the manifest of the day"; else fail "off-site hook (status $PROOFS_STATUS)"; fi
  run_proofs proofs "$out1" "$PT/src-backend" "$PT/src-runner" ZKB_PROOFS_STAMP=${D}T000800Z ZKB_PROOFS_OFFSITE_HOOK="$PT/hook-bad" bash "$DIR/proofs.sh" export
  if [ "$PROOFS_STATUS" -ne 0 ] && [ -f "$m/manifests/${D}T000800Z.json" ]; then pass "proofs.sh export: a failing hook fails the run after the manifest"; else fail "failing hook (status $PROOFS_STATUS)"; fi

  # verify: the newest manifest must match exactly, then the storage proofs; an old manifest is a warning.
  : >"$PT/calls.log"
  run_proofs proofs "$out1" "$PT/src-backend" "$PT/src-runner" bash "$DIR/proofs.sh" verify
  if [ "$PROOFS_STATUS" -eq 0 ] && grep -q "^mirror-check --dir $m --exact --manifest ${D}T000800Z.json\$" "$PT/calls.log" && grep -q "^verify-storage --mirror $m\$" "$PT/calls.log" \
    && out_has "newest manifest: ${D}T000800Z.json (today)"; then
    pass "proofs.sh verify: today's manifest matches the mirror, then the storage proofs verify"
  else
    fail "verify (status $PROOFS_STATUS): $PROOFS_OUT"
  fi
  # A mirror whose newest manifest is not today's still verifies, with a warning.
  mkdir -p "$PT/oldm/manifests"
  cp -R "$m/storage-proofs" "$PT/oldm/"
  node "$REAL_CLI" mirror-manifest --dir "$PT/oldm" --stamp 20251001T000000Z --commit abc --days 30 >/dev/null
  run_proofs proofs "$out1" "$PT/src-backend" "$PT/src-runner" bash "$DIR/proofs.sh" verify "$PT/oldm" --manifest-sha256 "$(sha256_file "$PT/oldm/manifests/20251001T000000Z.json")"
  if [ "$PROOFS_STATUS" -eq 0 ] && out_has 'WARNING: the newest manifest is 20251001T000000Z.json, not today'; then pass "proofs.sh verify: a manifest that is not today's is a warning"; else fail "old manifest (status $PROOFS_STATUS): $PROOFS_OUT"; fi
  run_proofs proofs "$out1" "$PT/src-backend" "$PT/src-runner" STUB_EXIT_VERIFY=3 bash "$DIR/proofs.sh" verify
  if [ "$PROOFS_STATUS" -eq 3 ]; then pass "proofs.sh verify: invalid proofs give exit 3"; else fail "verify invalid (status $PROOFS_STATUS)"; fi
  printf 'x' >>"$m/beacon-states/$state_a"
  run_proofs proofs "$out1" "$PT/src-backend" "$PT/src-runner" bash "$DIR/proofs.sh" verify
  if [ "$PROOFS_STATUS" -eq 1 ] && out_has 'does not match'; then pass "proofs.sh verify: a changed file fails the manifest"; else fail "verify tampered (status $PROOFS_STATUS)"; fi
  cp "$PT/src-runner/beacon-states/$state_a" "$m/beacon-states/$state_a"
  printf 'x\n' >"$m/snapshots/stray.txt"
  run_proofs proofs "$out1" "$PT/src-backend" "$PT/src-runner" bash "$DIR/proofs.sh" verify
  if [ "$PROOFS_STATUS" -eq 1 ]; then pass "proofs.sh verify: a file the manifest does not list fails it"; else fail "verify unlisted (status $PROOFS_STATUS)"; fi
  rm -f "$m/snapshots/stray.txt"

  # The trust list: root appends the sha256 of each day's manifest, outside the mirror, 0644.
  trusted=$(awk 'END {print $1}' "$out1/manifests.sha256")
  MODE=0644
  if [ "$trusted" = "$(sha256_file "$m/manifests/${D}T000800Z.json")" ] && grep -q "^$(sha256_file "$m/manifests/${D}T000100Z.json")  ${D}T000100Z.json\$" "$out1/manifests.sha256" \
    && [ -z "$(modes_wrong "$out1/manifests.sha256")" ]; then
    pass "proofs.sh export: the sha256 of each day's manifest goes to manifests.sha256 outside the mirror (0644)"
  else
    fail "trust list: $(cat "$out1/manifests.sha256" 2>&1 | tail -2)"
  fi
  if cmp -s "$out1/trusted-manifests/${D}T000800Z.json" "$m/manifests/${D}T000800Z.json" && [ -z "$(modes_wrong "$out1/trusted-manifests/${D}T000800Z.json")" ] \
    && grep -q "^$(sha256_file "$m/snapshots/${D}T000100Z.sqlite")  snapshots/${D}T000100Z.sqlite\$" "$out1/manifests.sha256" \
    && grep -q "^$(sha256_file "$m/beacon-states/$state_a")  beacon-states/$state_a\$" "$out1/manifests.sha256" \
    && [ "$(grep -c "  beacon-states/$state_a\$" "$out1/manifests.sha256")" -eq 1 ]; then
    pass "proofs.sh export: root keeps its own copy of each manifest, and records the hashes of the snapshots and beacon states it saw (once each)"
  else
    fail "trust list: $(cat "$out1/manifests.sha256" 2>&1 | tail -2)"
  fi

  # bundle: one tar.gz of the mirror with its .sha256, 0640.
  run_proofs proofs "$out1" "$PT/src-backend" "$PT/src-runner" ZKB_PROOFS_STAMP=${D}T000900Z bash "$DIR/proofs.sh" bundle
  mb=$out1/zk-bridge-mirror-${D}T000900Z.tar.gz
  MODE=0640
  if [ "$PROOFS_STATUS" -eq 0 ] && [ -f "$mb" ] && [ -f "$mb.sha256" ] && [ -z "$(modes_wrong "$mb" "$mb.sha256")" ] && tar -tzf "$mb" >"$PT/mb.list" && grep -q "beacon-states/$state_a\$" "$PT/mb.list" \
    && grep -q "manifests/${D}T000800Z.json\$" "$PT/mb.list"; then
    pass "proofs.sh bundle: the whole mirror in one tar.gz and its .sha256, both 0640"
  else
    fail "bundle (status $PROOFS_STATUS): $PROOFS_OUT"
  fi

  # Import of the mirror bundle into an empty server.
  mkdir -p "$PT/dst-backend" "$PT/dst-runner"
  : >"$PT/calls.log"
  run_proofs proofs "$PT/out2" "$PT/dst-backend" "$PT/dst-runner" bash "$DIR/proofs.sh" import "$mb" --trust-list "$out1/manifests.sha256"
  if [ "$PROOFS_STATUS" -eq 0 ] && [ "$(sqlite3 "$PT/dst-backend/backend.sqlite" 'SELECT body FROM proofs' 2>/dev/null)" = p1 ] \
    && cmp -s "$PT/dst-runner/beacon-states/$state_a" "$m/beacon-states/$state_a" && cmp -s "$PT/dst-backend/beacon-states/$state_b" "$m/beacon-states/$state_b" \
    && [ -f "$PT/dst-backend/beacon-states/${state_b%.ssz}.summary" ]; then
    pass "proofs.sh import of a mirror bundle into an empty server: installs the newest snapshot and gives both services the beacon states"
  else
    fail "import mirror bundle (status $PROOFS_STATUS): $PROOFS_OUT"
  fi
  if [ "$(grep -o '^[a-z-]*' "$PT/calls.log" | tr '\n' ' ')" = "mirror-check migrate mirror-import ingest-backend " ] && grep -q "^ingest-backend --sqlite .*/snapshots/${D}T000800Z.sqlite\$" "$PT/calls.log" \
    && grep -q "^mirror-check .* --exact --manifest ${D}T000800Z.json\$" "$PT/calls.log"; then
    pass "proofs.sh import: mirror-check (the named manifest), migrate, mirror-import, the newest snapshot"
  else
    fail "import CLI calls: $(tr '\n' '|' <"$PT/calls.log")"
  fi
  if [ -z "$(ls -A "$PT/out2" | grep -E '^\.extract-')" ]; then pass "proofs.sh import: the temporary directories are gone"; else fail "extract dir left behind"; fi
  find "$PT/dst-runner" "$PT/dst-backend" -type f -exec cksum {} + | sort >"$PT/state-1"
  run_proofs proofs "$PT/out2" "$PT/dst-backend" "$PT/dst-runner" bash "$DIR/proofs.sh" import "$mb" --trust-list "$out1/manifests.sha256"
  find "$PT/dst-runner" "$PT/dst-backend" -type f -exec cksum {} + | sort >"$PT/state-2"
  if [ "$PROOFS_STATUS" -eq 0 ] && cmp -s "$PT/state-1" "$PT/state-2" && out_has 'conflicts: 0'; then pass "proofs.sh import: a second import is a no-op with zero conflicts"; else fail "second import (status $PROOFS_STATUS)"; fi
  printf 'different\n' >"$PT/dst-runner/beacon-states/$state_a"
  rm -f "$PT/dst-backend/beacon-states/$state_b"
  run_proofs proofs "$PT/out2" "$PT/dst-backend" "$PT/dst-runner" bash "$DIR/proofs.sh" import "$mb" --trust-list "$out1/manifests.sha256"
  if [ "$PROOFS_STATUS" -eq 3 ] && out_has "conflict: $state_a" && [ "$(cat "$PT/dst-runner/beacon-states/$state_a")" = different ] && [ -f "$PT/dst-backend/beacon-states/$state_b" ]; then
    pass "proofs.sh import: a changed file is reported (exit 3), not overwritten, and the rest is still restored"
  else
    fail "import with a changed file (status $PROOFS_STATUS): $PROOFS_OUT"
  fi
  run_proofs proofs "$PT/out2" "$PT/dst-backend" "$PT/dst-runner" STUB_EXIT_IMPORT=3 bash "$DIR/proofs.sh" import "$mb" --trust-list "$out1/manifests.sha256"
  if [ "$PROOFS_STATUS" -eq 3 ]; then pass "proofs.sh import: archive conflicts give exit 3"; else fail "archive conflicts (status $PROOFS_STATUS)"; fi
  printf 'keep me\n' >"$PT/dst-backend/backend.sqlite"
  run_proofs proofs "$PT/out2" "$PT/dst-backend" "$PT/dst-runner" bash "$DIR/proofs.sh" import "$mb" --trust-list "$out1/manifests.sha256"
  if [ "$(cat "$PT/dst-backend/backend.sqlite")" = 'keep me' ]; then pass "proofs.sh import: an existing backend.sqlite is not replaced"; else fail "backend.sqlite overwritten"; fi
  # Import of this server's own mirror (no argument), and of a directory.
  run_proofs proofs "$out1" "$PT/src-backend" "$PT/src-runner" bash "$DIR/proofs.sh" import
  if [ "$PROOFS_STATUS" -eq 0 ]; then pass "proofs.sh import: without an argument, this server's mirror"; else fail "import own mirror (status $PROOFS_STATUS): $PROOFS_OUT"; fi
  # A tampered mirror bundle is refused by its .sha256, and without one by the manifest.
  mkdir -p "$PT/tamper-m" "$PT/out3"
  tar -xzf "$mb" -C "$PT/tamper-m"
  printf 'x' >>"$PT/tamper-m/beacon-states/$state_a"
  tar -czf "$PT/out3/zk-bridge-mirror-20260110T000000Z.tar.gz" -C "$PT/tamper-m" .
  run_proofs proofs "$PT/out3" "$PT/dst-backend" "$PT/dst-runner" bash "$DIR/proofs.sh" import "$PT/out3/zk-bridge-mirror-20260110T000000Z.tar.gz" --trust-list "$out1/manifests.sha256"
  if [ "$PROOFS_STATUS" -eq 1 ] && out_has 'does not match its newest manifest'; then pass "proofs.sh import: a tampered mirror fails its manifest"; else fail "tampered mirror (status $PROOFS_STATUS)"; fi
  cp "$mb.sha256" "$PT/out3/zk-bridge-mirror-20260110T000000Z.tar.gz.sha256"
  run_proofs proofs "$PT/out3" "$PT/dst-backend" "$PT/dst-runner" bash "$DIR/proofs.sh" import "$PT/out3/zk-bridge-mirror-20260110T000000Z.tar.gz" --trust-list "$out1/manifests.sha256"
  if [ "$PROOFS_STATUS" -eq 1 ] && out_has '.sha256'; then pass "proofs.sh import: a tampered bundle fails its .sha256"; else fail "tampered, with sha256 (status $PROOFS_STATUS)"; fi

  # --- The mirror is writable by the archive user; root trusts none of it. -------------------------------------------
  # A manifest changed after the export is refused by import and verify (its hash is not in the trust list).
  newest_m=$m/manifests/${D}T000800Z.json
  cp "$newest_m" "$PT/manifest.keep"
  sed 's/"retentionDays": 30/"retentionDays": 31/' "$PT/manifest.keep" >"$newest_m"
  : >"$PT/calls.log"
  run_proofs proofs "$out1" "$PT/src-backend" "$PT/src-runner" bash "$DIR/proofs.sh" import
  if [ "$PROOFS_STATUS" -eq 1 ] && out_has "differs from root's copy" && out_has 'is not vouched for' && ! grep -q '^mirror-import' "$PT/calls.log"; then pass "proofs.sh import: a manifest changed after the export is refused before anything is imported"; else fail "tampered manifest import (status $PROOFS_STATUS): $PROOFS_OUT"; fi
  run_proofs proofs "$out1" "$PT/src-backend" "$PT/src-runner" bash "$DIR/proofs.sh" verify
  if [ "$PROOFS_STATUS" -eq 1 ] && out_has 'it was changed after the export'; then pass "proofs.sh verify: a manifest changed after the export is refused"; else fail "tampered manifest verify (status $PROOFS_STATUS)"; fi
  cp "$PT/manifest.keep" "$newest_m"
  # verify picks the manifest by the CLI's own rule and names it: another name in manifests/, or a newer stamp-shaped
  # one root never kept, fails it.
  printf '{}\n' >"$m/manifests/zzz.json"
  run_proofs proofs "$out1" "$PT/src-backend" "$PT/src-runner" bash "$DIR/proofs.sh" verify
  if [ "$PROOFS_STATUS" -eq 1 ] && out_has 'manifests/ holds zzz.json, which is not a manifest name'; then pass "proofs.sh verify: a planted zzz.json in manifests/ fails it"; else fail "zzz.json (status $PROOFS_STATUS): $PROOFS_OUT"; fi
  rm -f "$m/manifests/zzz.json"
  cp "$PT/manifest.keep" "$m/manifests/29991231T235959Z.json"
  run_proofs proofs "$out1" "$PT/src-backend" "$PT/src-runner" bash "$DIR/proofs.sh" verify
  if [ "$PROOFS_STATUS" -eq 1 ] && out_has 'root holds no copy of the manifest 29991231T235959Z.json'; then pass "proofs.sh verify: a newer stamp-shaped manifest root never kept fails it"; else fail "planted stamp (status $PROOFS_STATUS): $PROOFS_OUT"; fi
  rm -f "$m/manifests/29991231T235959Z.json"
  : >"$PT/calls.log"
  run_proofs proofs "$out1" "$PT/src-backend" "$PT/src-runner" bash "$DIR/proofs.sh" verify
  if [ "$PROOFS_STATUS" -eq 0 ] && grep -q "^mirror-check --dir $m --exact --manifest ${D}T000800Z.json\$" "$PT/calls.log"; then pass "proofs.sh verify: the CLI checks the manifest the script picked, by name"; else fail "verify by name (status $PROOFS_STATUS): $(cat "$PT/calls.log")"; fi
  # A snapshot the trusted manifest does not list is never installed: the import stops.
  rm -f "$PT/dst2-backend/backend.sqlite"; mkdir -p "$PT/dst2-backend" "$PT/dst2-runner"
  printf 'planted\n' >"$m/snapshots/${D}T235959Z.sqlite"
  run_proofs proofs "$out1" "$PT/dst2-backend" "$PT/dst2-runner" bash "$DIR/proofs.sh" import
  if [ "$PROOFS_STATUS" -eq 1 ] && out_has 'does not match its newest manifest' && [ ! -e "$PT/dst2-backend/backend.sqlite" ]; then pass "proofs.sh import: an unlisted snapshot is refused, nothing installed"; else fail "unlisted snapshot (status $PROOFS_STATUS): $PROOFS_OUT"; fi
  rm -f "$m/snapshots/${D}T235959Z.sqlite"
  # A directory input with a symbolic link, or a hard link, is refused.
  mkdir -p "$PT/dirin"
  tar -xzf "$mb" -C "$PT/dirin"
  printf 'secret\n' >"$PT/outside-secret"
  ln -s "$PT/outside-secret" "$PT/dirin/snapshots/${D}T235959Z.sqlite"
  run_proofs proofs "$PT/out2" "$PT/dst2-backend" "$PT/dst2-runner" bash "$DIR/proofs.sh" import "$PT/dirin" --trust-list "$out1/manifests.sha256"
  if [ "$PROOFS_STATUS" -eq 1 ] && out_has 'holds links or special files' && [ ! -e "$PT/dst2-backend/backend.sqlite" ]; then pass "proofs.sh import: a directory input with a symbolic link is refused"; else fail "symlink input (status $PROOFS_STATUS): $PROOFS_OUT"; fi
  rm -f "$PT/dirin/snapshots/${D}T235959Z.sqlite"
  ln "$PT/outside-secret" "$PT/dirin/snapshots/${D}T235959Z.sqlite"
  run_proofs proofs "$PT/out2" "$PT/dst2-backend" "$PT/dst2-runner" bash "$DIR/proofs.sh" import "$PT/dirin" --trust-list "$out1/manifests.sha256"
  if [ "$PROOFS_STATUS" -eq 1 ] && out_has 'holds links or special files'; then pass "proofs.sh import: a directory input with a hard link is refused"; else fail "hardlink input (status $PROOFS_STATUS): $PROOFS_OUT"; fi
  rm -f "$PT/dirin/snapshots/${D}T235959Z.sqlite"
  run_proofs proofs "$PT/out2" "$PT/dst2-backend" "$PT/dst2-runner" bash "$DIR/proofs.sh" import "$PT/dirin"
  if [ "$PROOFS_STATUS" -eq 1 ] && out_has 'pass --trust-list'; then pass "proofs.sh import: a mirror from elsewhere needs --trust-list or --manifest-sha256"; else fail "foreign mirror without hash (status $PROOFS_STATUS)"; fi
  # With hashes given by hand (no trust list): the manifest and the snapshot pass, and the beacon states, whose hashes
  # nobody vouched for, are left out.
  dsnap=$(cd "$PT/dirin/snapshots" && ls | LC_ALL=C sort | tail -n 1)
  : >"$PT/calls.log"
  run_proofs proofs "$PT/out2" "$PT/dst2-backend" "$PT/dst2-runner" bash "$DIR/proofs.sh" import "$PT/dirin" --manifest-sha256 "$trusted" --snapshot-sha256 "$(sha256_file "$PT/dirin/snapshots/$dsnap")"
  if [ "$PROOFS_STATUS" -eq 0 ] && [ -f "$PT/dst2-backend/backend.sqlite" ] && [ ! -e "$PT/dst2-runner/beacon-states/$state_a" ] && out_has 'not given to the services'; then
    pass "proofs.sh import: --manifest-sha256 and --snapshot-sha256 import a mirror; states without recorded hashes are left out"
  else
    fail "directory import by hand (status $PROOFS_STATUS): $PROOFS_OUT"
  fi
  run_proofs proofs "$PT/out2" "$PT/dst3-backend" "$PT/dst3-runner" bash "$DIR/proofs.sh" import "$PT/dirin" --manifest-sha256 "$trusted" --snapshot-sha256 "$(printf '0%.0s' $(seq 1 64))"
  if [ "$PROOFS_STATUS" -eq 1 ] && out_has 'does not match --snapshot-sha256' && [ ! -e "$PT/dst3-backend/backend.sqlite" ]; then pass "proofs.sh import: a snapshot that does not match --snapshot-sha256 is refused"; else fail "snapshot hash by hand (status $PROOFS_STATUS)"; fi

  # The anchor covers what root saw, not what the archive user wrote. A mirror whose snapshot was replaced, with a new
  # manifest to match (the archive user can write both), passes the manifest by hand, but its snapshot is not one root
  # recorded: refused before anything is imported.
  mkdir -p "$PT/forged" "$PT/dst3-backend" "$PT/dst3-runner"
  tar -xzf "$mb" -C "$PT/forged"
  cp "$PT/dirin/snapshots/$dsnap" "$PT/forged/snapshots/$dsnap"
  sqlite3 "$PT/forged/snapshots/$dsnap" "INSERT INTO proofs (body) VALUES ('forged');"
  rm -f "$PT/forged/manifests/"*.json
  node "$REAL_CLI" mirror-manifest --dir "$PT/forged" --stamp "${D}T001000Z" --commit abc --days 30 >/dev/null
  forged_sha=$(sha256_file "$PT/forged/manifests/${D}T001000Z.json")
  : >"$PT/calls.log"
  run_proofs proofs "$PT/out2" "$PT/dst3-backend" "$PT/dst3-runner" bash "$DIR/proofs.sh" import "$PT/forged" --manifest-sha256 "$forged_sha" --trust-list "$out1/manifests.sha256"
  if [ "$PROOFS_STATUS" -eq 1 ] && out_has "snapshot $dsnap .* is not in the trust list" && [ ! -e "$PT/dst3-backend/backend.sqlite" ] && ! grep -q '^mirror-import' "$PT/calls.log"; then
    pass "proofs.sh import: a snapshot whose hash root never recorded is refused, nothing imported"
  else
    fail "forged snapshot (status $PROOFS_STATUS): $PROOFS_OUT"
  fi
  # Likewise a beacon state: the forged one is not given to the services, the rest is imported.
  cp "$PT/dirin/snapshots/$dsnap" "$PT/forged/snapshots/$dsnap"
  printf 'forged' >>"$PT/forged/beacon-states/$state_a"
  rm -f "$PT/forged/manifests/"*.json
  node "$REAL_CLI" mirror-manifest --dir "$PT/forged" --stamp "${D}T001100Z" --commit abc --days 30 >/dev/null
  forged_sha=$(sha256_file "$PT/forged/manifests/${D}T001100Z.json")
  run_proofs proofs "$PT/out2" "$PT/dst3-backend" "$PT/dst3-runner" bash "$DIR/proofs.sh" import "$PT/forged" --manifest-sha256 "$forged_sha" --trust-list "$out1/manifests.sha256"
  if [ "$PROOFS_STATUS" -eq 0 ] && out_has "beacon-states/$state_a has no hash in the trust list" && [ ! -e "$PT/dst3-runner/beacon-states/$state_a" ] && [ -f "$PT/dst3-backend/beacon-states/$state_b" ]; then
    pass "proofs.sh import: a beacon state whose hash root never recorded is not given to the services; recorded ones are"
  else
    fail "forged state (status $PROOFS_STATUS): $PROOFS_OUT"
  fi
  # A link planted in the mirror is never followed by a run: its target keeps its mode, and a mirror that is itself a
  # link is refused.
  chmod 600 "$PT/outside-secret"
  ln -s "$PT/outside-secret" "$m/evidence/planted.json"
  ln -s "$PT/outside-secret" "$m/beacon-states/11155111/000000000999-0x$(printf 'f%.0s' $(seq 1 64)).ssz"
  run_proofs proofs "$out1" "$PT/src-backend" "$PT/src-runner" ZKB_PROOFS_STAMP=${D}T000950Z bash "$DIR/proofs.sh" export
  MODE=0600
  if [ -z "$(modes_wrong "$PT/outside-secret")" ] && [ -L "$m/evidence/planted.json" ] && out_has 'links'; then pass "proofs.sh export: a link planted in the mirror is not followed (its target keeps 0600), and is reported"; else fail "planted link: $(ls -l "$PT/outside-secret") $PROOFS_OUT"; fi
  rm -f "$m/evidence/planted.json" "$m/beacon-states/11155111/000000000999-0x$(printf 'f%.0s' $(seq 1 64)).ssz"
  ln -s "$m" "$PT/mirror-link"
  run_proofs proofs "$out1" "$PT/src-backend" "$PT/src-runner" ZKB_PROOFS_MIRROR="$PT/mirror-link" ZKB_PROOFS_STAMP=${D}T000960Z bash "$DIR/proofs.sh" export
  if [ "$PROOFS_STATUS" -eq 1 ] && out_has 'is a symbolic link: refusing'; then pass "proofs.sh: a mirror path that is a symbolic link is refused"; else fail "mirror link (status $PROOFS_STATUS)"; fi

  # A nightly bundle of the old format still imports and verifies.
  lg=$PT/legacy
  mkdir -p "$lg/archive" "$lg/backend" "$lg/files/runner/proof-cache/369/0xabc" "$lg/files/backend/beacon-states/11155111"
  printf '{"stub":"x"}\n' >"$lg/archive/storage_proofs.ndjson"
  cp "$m/snapshots/${D}T000100Z.sqlite" "$lg/backend/backend.sqlite"
  printf '{"proof":"legacy"}\n' >"$lg/files/runner/proof-cache/369/0xabc/7-0xbeef.json"
  printf 'legacy-state\n' >"$lg/files/backend/beacon-states/11155111/legacy.ssz"
  STUB_LOG=/dev/null node "$PT/stub-cli.mjs" manifest-write --dir "$lg" --commit abc >/dev/null
  mkdir -p "$PT/out6"
  tar -czf "$PT/out6/zk-bridge-proofs-20251201T000000Z.tar.gz" -C "$lg" .
  : >"$PT/calls.log"
  run_proofs proofs "$PT/out6" "$PT/dst-backend" "$PT/dst-runner" bash "$DIR/proofs.sh" import "$PT/out6/zk-bridge-proofs-20251201T000000Z.tar.gz"
  if [ "$PROOFS_STATUS" -eq 0 ] && grep -q '^import --in ' "$PT/calls.log" && grep -q '^manifest-check' "$PT/calls.log" && [ -f "$PT/dst-runner/proof-cache/369/0xabc/7-0xbeef.json" ] \
    && [ -f "$PT/dst-backend/beacon-states/11155111/legacy.ssz" ]; then
    pass "proofs.sh import: a nightly bundle of the old format still imports"
  else
    fail "legacy import (status $PROOFS_STATUS): $PROOFS_OUT"
  fi
  run_proofs proofs "$PT/out6" "$PT/dst-backend" "$PT/dst-runner" bash "$DIR/proofs.sh" verify "$PT/out6/zk-bridge-proofs-20251201T000000Z.tar.gz"
  if [ "$PROOFS_STATUS" -eq 0 ] && grep -q '^verify-storage --in ' "$PT/calls.log"; then pass "proofs.sh verify: a nightly bundle of the old format still verifies"; else fail "legacy verify (status $PROOFS_STATUS)"; fi
  # An export next to old bundles leaves them alone and says so.
  run_proofs proofs "$PT/out6" "$PT/src-backend" "$PT/src-runner" ZKB_PROOFS_STAMP=${D}T001100Z bash "$DIR/proofs.sh" export
  if [ "$PROOFS_STATUS" -eq 0 ] && [ -f "$PT/out6/zk-bridge-proofs-20251201T000000Z.tar.gz" ] && out_has '1 nightly bundle(s) of the old format'; then pass "proofs.sh export: old nightly bundles are left alone"; else fail "old bundles (status $PROOFS_STATUS): $PROOFS_OUT"; fi

  # --- publish ---------------------------------------------------------------------------------------------------
  slot=000000000100
  h1=0x$(printf 'a%.0s' $(seq 1 64))
  h2=0x$(printf 'b%.0s' $(seq 1 64))
  # The beacon states come from the mirror (the whole window), not from the services' caches.
  pm=$PT/p-mirror/beacon-states
  mkdir -p "$pm/369" "$pm/eth" "$PT/p-runner/beacon-states/369" "$PT/p-backend"
  printf 'ssz-1\n' >"$pm/369/$slot-$h1.ssz"
  printf 'summary\n' >"$pm/369/$slot-$h2.summary"
  printf 'bad\n' >"$pm/369/junk.ssz"
  printf 'bad\n' >"$pm/369/$slot-$h1.ssz.bak"
  printf 'bad\n' >"$pm/eth/$slot-$h1.ssz"
  # A link with a state's name, pointing at a secret outside the mirror, never reaches the public tree.
  printf 'PUBLISH-SECRET\n' >"$PT/publish-secret"
  ln -s "$PT/publish-secret" "$pm/369/000000000200-$h1.ssz"
  printf 'cache\n' >"$PT/p-runner/beacon-states/369/000000000300-$h2.ssz"
  # A 0600 file (put into the mirror by hand) must still be readable in the tree.
  chmod 600 "$pm/369/$slot-$h1.ssz" "$pm/369/$slot-$h2.summary"
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
  /api/v0/repo/gc\?*) echo '{"Key":{"/":"bafygone"}}' ;;
  *) echo "unexpected $url" >&2; exit 22 ;;
esac
EOS
  chmod +x "$PT/fakebin/curl"
  printf '#!/bin/sh\nprintf "%%s\\n" "$*" >>"%s/ipfs/as-argv"\nshift\nexec "$@"\n' "$PT" >"$PT/as-rec.sh"
  chmod +x "$PT/as-rec.sh"
  pub() { # pub <out dir> <env...> -- args: runs proofs.sh publish with the publish test sources
    local out=$1
    shift
    proofs "$out" "$PT/p-backend" "$PT/p-runner" ZKB_PROOFS_MIRROR="$PT/p-mirror" IPFS_DIR="$PT/ipfs" ZKB_IPFS_PATH="$PT/ipfs-repo" PATH="$PT/fakebin:$PATH" ZKB_PROOFS_AS="$PT/as-rec.sh" ZKB_PINS_REFRESH="$PT/pins-refresh.sh" "$@"
  }
  printf '#!/bin/sh\necho "$*" >>"%s/pins-refresh.log"\n' "$PT" >"$PT/pins-refresh.sh"
  chmod +x "$PT/pins-refresh.sh"
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
  if [ "$beacon" = "beacon-states/369/$slot-$h1.ssz beacon-states/369/$slot-$h2.summary " ]; then pass "publish: the mirror's well-named beacon states only (numeric chain directories, no links), not the services' caches"; else fail "beacon states in tree: $beacon"; fi
  if ! grep -rq PUBLISH-SECRET "$tree" && [ -z "$(find "$tree" ! -type f ! -type d)" ]; then pass "publish: a link in the mirror's beacon states never puts its target in the public tree"; else fail "the public tree holds a link or its target"; fi
  if [ "$(grep -o '^[a-z-]*' "$PT/calls.log" | tr '\n' ' ')" = "public-export manifest-write public-check " ]; then pass "publish: public-export, manifest-write (--public), public-check in order"; else fail "publish CLI calls: $(tr '\n' '|' <"$PT/calls.log")"; fi
  # The archive user writes the manifest of the tree, so it must read every beacon state copied from a 0600 source.
  if [ -n "$(find "$tree/beacon-states" -type f 2>/dev/null)" ] && [ -z "$(find "$tree/beacon-states" -type f ! -perm -0044 2>/dev/null)" ]; then pass "publish: beacon states copied from 0600 files are readable in the tree"; else fail "publish: beacon state modes: $(find "$tree/beacon-states" -type f -exec ls -l {} + 2>&1 | head -3)"; fi
  if [ -z "$(find "$tree" -newermt 2000-01-03 -print -quit)" ] && [ ! -s "$PT/ipfs/calls" ] 2>/dev/null || [ ! -e "$PT/ipfs/calls" ]; then pass "publish --dry-run: fixed file times, nothing sent to ipfs"; else fail "dry run times or ipfs calls"; fi
  # The sanitizer failing stops it too.
  run_proofs pub "$PT/pub2" ZKB_PROOFS_STAMP=20260110T000000Z STUB_EXIT_CHECK=1 bash "$DIR/proofs.sh" publish
  if [ "$PROOFS_STATUS" -ne 0 ] && [ ! -e "$PT/ipfs/calls" ]; then pass "publish: a failing public-check stops the run before ipfs"; else fail "public-check failure (status $PROOFS_STATUS)"; fi
  # Real publications: the log, the pins and the retention.
  printf 'bafyforeign\n' >"$PT/ipfs/pins"
  for d in 1 2 3 4; do
    run_proofs pub "$PT/pub2" ZKB_PROOFS_STAMP=2026011${d}T000000Z bash "$DIR/proofs.sh" publish
  done
  if [ "$PROOFS_STATUS" -eq 0 ] && printf '%s' "$PROOFS_OUT" | grep -q '^cid: bafystub4$' && printf '%s' "$PROOFS_OUT" | grep -q '^gateway: .*/ipfs/bafystub4$'; then pass "publish prints the CID and the gateway form"; else fail "publish output (status $PROOFS_STATUS): $PROOFS_OUT"; fi
  if [ "$(grep -cx refresh "$PT/pins-refresh.log")" -eq 4 ]; then pass "publish refreshes the pin list after each real publication (not on a dry run or a failed check)"; else fail "pin list refreshes: $(cat "$PT/pins-refresh.log" 2>&1)"; fi
  if [ "$(wc -l <"$PT/pub2/ipfs-cids.log" | tr -d ' ')" -eq 4 ] && [ "$(awk 'NF == 4 && $2 ~ /^bafystub/ && $3 == 7 && $4 == "abc123def"' "$PT/pub2/ipfs-cids.log" | wc -l | tr -d ' ')" -eq 4 ]; then pass "publish appends <time> <cid> <files> <commit> to ipfs-cids.log"; else fail "cid log: $(cat "$PT/pub2/ipfs-cids.log")"; fi
  if [ "$(sort "$PT/ipfs/pins" | tr '\n' ' ')" = "bafyforeign bafystub3 bafystub4 " ]; then pass "publish keeps the newest 2 pinned by default, unpins older logged CIDs only (not foreign pins)"; else fail "pins: $(tr '\n' ' ' <"$PT/ipfs/pins")"; fi
  if grep -q '^POST http://127\.0\.0\.1:5001/api/v0/add?cid-version=1&pin=true&pin-name=zkb-proofs-2026011[0-9]T000000Z&' "$PT/ipfs/calls"; then pass "publish: POST /api/v0/add with cid-version=1, pin=true and a pin name, at the api address"; else fail "add call: $(head -1 "$PT/ipfs/calls")"; fi
  if grep -q '^POST http://127\.0\.0\.1:5001/api/v0/pin/rm?arg=bafystub1$' "$PT/ipfs/calls" && grep -q '/api/v0/pin/ls?arg=bafystub1&type=recursive$' "$PT/ipfs/calls"; then pass "publish: pin ls and pin rm through the RPC API"; else fail "pin calls: $(tr '\n' '|' <"$PT/ipfs/calls")"; fi
  grep -A2 'pin/rm?arg=bafystub1$' "$PT/ipfs/calls" >"$PT/ipfs/after-rm" || true
  if grep -q '/api/v0/repo/gc?quiet=true$' "$PT/ipfs/after-rm" && [ "$(grep -c '/api/v0/repo/gc' "$PT/ipfs/calls")" -eq 2 ]; then pass "publish: a garbage collection after each unpin, none without one"; else fail "gc calls: $(tr '\n' '|' <"$PT/ipfs/calls")"; fi
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
  if [ "$PROOFS_STATUS" -ne 0 ] && [ -f "$PT/p-mirror/manifests/20260122T000000Z.json" ]; then pass "export: a failing publication fails the run after the manifest is written"; else fail "export with failing publish (status $PROOFS_STATUS)"; fi
  if grep -q -- '^mirror-manifest .*--ipfs-log ' "$PT/calls.log" && grep -q '"lastPublished"' "$PT/p-mirror/manifests/20260122T000000Z.json"; then pass "export: the manifest of the day records the newest publication"; else fail "no --ipfs-log"; fi

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

# --- IPFS subdomain gateway (<cid>.ipfs.zkb.fi) ---------------------------------------------------------------------
# Caddy: a wildcard site with on-demand TLS, the ask option in the global block, and the apex site left as it was.
if grep -qxF '{$ZKB_IPFS_SUBDOMAIN_HOSTS:*.ipfs.zkb.fi} {' "$DIR/Caddyfile"; then pass "Caddyfile: wildcard site for the IPFS subdomains"; else fail "Caddyfile: no wildcard site for the IPFS subdomains"; fi
if awk '/^\{\$ZKB_IPFS_SUBDOMAIN_HOSTS/{in_site=1} in_site&&/^\t\ton_demand$/{found=1} in_site&&/^\}/{in_site=0} END{exit !found}' "$DIR/Caddyfile"; then pass "Caddyfile: the wildcard site uses tls on_demand"; else fail "Caddyfile: the wildcard site has no tls on_demand"; fi
if awk '/^\{\$ZKB_IPFS_SUBDOMAIN_HOSTS/{in_site=1} in_site&&/reverse_proxy 127\.0\.0\.1:\{\$ZKB_IPFS_GATEWAY_PORT:8080\}/{found=1} in_site&&/^\}/{in_site=0} END{exit !found}' "$DIR/Caddyfile"; then pass "Caddyfile: the wildcard site proxies to the IPFS gateway"; else fail "Caddyfile: the wildcard site does not proxy to the IPFS gateway"; fi
if awk '/^\{$/{g=1} g&&/^\ton_demand_tls \{$/{o=1} o&&/^\t\task http:\/\/127\.0\.0\.1:\{\$ZKB_TLSASK_PORT:8089\}\/check$/{found=1} /^\}$/{g=0;o=0} END{exit !found}' "$DIR/Caddyfile"; then pass "Caddyfile: global on_demand_tls asks the local check"; else fail "Caddyfile: no on_demand_tls ask in the global options"; fi
if grep -qxF '{$ZKB_IPFS_HOST:ipfs.zkb.fi} {' "$DIR/Caddyfile" && grep -qxF '	reverse_proxy 127.0.0.1:{$ZKB_IPFS_WS_PORT:4003}' "$DIR/Caddyfile"; then pass "Caddyfile: the ipfs.zkb.fi apex still proxies the WebSocket listener"; else fail "Caddyfile: the ipfs.zkb.fi apex site changed"; fi
if grep -qxF '{$ZKB_GATEWAY_HOST:gateway.zkb.fi} {' "$DIR/Caddyfile" && ! grep -qE 'redir|rewrite.*gateway' "$DIR/Caddyfile"; then pass "Caddyfile: gateway.zkb.fi stays path style, no redirect"; else fail "Caddyfile: gateway.zkb.fi changed or redirects"; fi
# kubo: both gateway entries.
if grep -q 'UseSubdomains: false' "$DIR/provision.sh" && grep -q 'UseSubdomains: true' "$DIR/provision.sh" && grep -q 'SUBDOMAIN_PARENT:-zkb.fi' "$DIR/provision.sh" && grep -qxF 'ipfs_as config --json Gateway.NoFetch true' "$DIR/provision.sh"; then pass "provision.sh: path gateway and zkb.fi subdomain gateway entries, NoFetch kept"; else fail "provision.sh: gateway entries"; fi
# The ask service: unit hardening, user, installation.
ASK_DIR=$DIR/ipfs-tls-ask
for setting in User=zkb_tlsask Group=zkb_tlsask NoNewPrivileges=yes ProtectSystem=strict ProtectHome=yes PrivateTmp=yes PrivateDevices=yes CapabilityBoundingSet= RestrictSUIDSGID=yes SystemCallFilter=@system-service UMask=0077 Restart=on-failure; do
  if grep -qxF -- "$setting" "$ASK_DIR/zk-bridge-ipfs-tls-ask.service"; then pass "ipfs-tls-ask unit: $setting"; else fail "ipfs-tls-ask unit: missing '$setting'"; fi
done
if grep -q '^ReadWritePaths=' "$ASK_DIR/zk-bridge-ipfs-tls-ask.service"; then fail "ipfs-tls-ask unit: must have no writable path"; else pass "ipfs-tls-ask unit: no writable path"; fi
if grep -q 'zkb_tlsask' "$DIR/provision.sh" && grep -q 'zk-bridge-ipfs-tls-ask.service' "$DIR/provision.sh"; then pass "provision.sh creates the user and installs the ask unit"; else fail "provision.sh does not install the ask unit"; fi
# The check itself: a pins file decides; the node is never asked. CIDs are built here (sha2-256 dag-pb and raw are
# strict; the identity hash, sha2-512 and other codecs are not).
if command -v python3 >/dev/null 2>&1; then
  if python3 -I - "$ASK_DIR/ipfs-tls-ask.py" <<'PY'
import base64, hashlib, importlib.util, os, sys, tempfile, threading, urllib.request, urllib.error

spec = importlib.util.spec_from_file_location("ask", sys.argv[1])
ask = importlib.util.module_from_spec(spec)
spec.loader.exec_module(ask)

def cid(codec, hash_code, digest):
    raw = bytes([1, codec, hash_code, len(digest)]) + digest
    return "b" + base64.b32encode(raw).decode().lower().rstrip("=")

sha = lambda b, h=hashlib.sha256: h(b).digest()
PINNED = cid(0x70, 0x12, sha(b"pin1"))
PINNED_RAW = cid(0x55, 0x12, sha(b"pin2"))
UNPINNED = cid(0x70, 0x12, sha(b"nopin"))
LATE = cid(0x70, 0x12, sha(b"late"))
IDENTITY = cid(0x55, 0x00, b"<h1>hi</h1>")
SHA512 = cid(0x70, 0x13, sha(b"a", hashlib.sha512))
CODEC = cid(0x71, 0x12, sha(b"a"))
SHORT_DIGEST = cid(0x70, 0x12, sha(b"a")[:20])

work = tempfile.mkdtemp()
pins = os.path.join(work, "pins.txt")
def write_pins(*lines):
    tmp = pins + ".new"
    with open(tmp, "w") as f:
        f.write("".join(l + "\n" for l in lines))
    os.replace(tmp, pins)
    st = os.stat(pins)
    os.utime(pins, ns=(st.st_atime_ns, st.st_mtime_ns + write_pins.n * 2_000_000_000)); write_pins.n += 1
write_pins.n = 1
# The identity CID and the others are in the file too: the shape check must refuse them regardless.
write_pins(PINNED, PINNED_RAW, IDENTITY, SHA512, CODEC, SHORT_DIGEST)

checker = ask.Checker(pins, ".ipfs.zkb.fi")
srv = ask.make_server(checker, "127.0.0.1", 0)
threading.Thread(target=srv.serve_forever, daemon=True).start()

def status(domain):
    url = "http://127.0.0.1:%d/check?domain=%s" % (srv.server_address[1], domain)
    try:
        return urllib.request.urlopen(url).status
    except urllib.error.HTTPError as e:
        return e.code

bad = 0
def expect(name, domain, want):
    global bad
    got = status(domain)
    print(("PASS" if got == want else "FAIL"), " ask:", name, "->", got)
    bad += got != want

expect("a pinned dag-pb CID", PINNED + ".ipfs.zkb.fi", 200)
expect("a pinned raw CID", PINNED_RAW + ".ipfs.zkb.fi", 200)
expect("a strict CID that is not pinned", UNPINNED + ".ipfs.zkb.fi", 403)
expect("an identity-hash CID (even if listed)", IDENTITY + ".ipfs.zkb.fi", 403)
expect("a sha2-512 CID (even if listed)", SHA512 + ".ipfs.zkb.fi", 403)
expect("an unknown codec (even if listed)", CODEC + ".ipfs.zkb.fi", 403)
expect("a short digest (even if listed)", SHORT_DIGEST + ".ipfs.zkb.fi", 403)
expect("a non-CID label", "www.ipfs.zkb.fi", 403)
expect("a CIDv0 label", "QmYwAPJzv5CZsnA625s3Xf2nemtYgPpHdWEz79ojWnPbdG.ipfs.zkb.fi", 403)
expect("an uppercase CID", PINNED.upper() + ".ipfs.zkb.fi", 403)
expect("two labels", "x." + PINNED + ".ipfs.zkb.fi", 403)
expect("another domain", PINNED + ".ipfs.example.com", 403)
expect("the apex", "ipfs.zkb.fi", 403)
expect("an over-long label", "b" + "a" * 70 + ".ipfs.zkb.fi", 403)
expect("a label of 64 characters", "b" + "a" * 63 + ".ipfs.zkb.fi", 403)
expect("no domain", "", 403)
# Reload: a pin added to the file is picked up without a restart, and a removed one is dropped.
expect("a CID before it is pinned", LATE + ".ipfs.zkb.fi", 403)
write_pins(PINNED, LATE)
expect("the same CID after the file changed", LATE + ".ipfs.zkb.fi", 200)
expect("a CID removed from the file", PINNED_RAW + ".ipfs.zkb.fi", 403)
os.remove(pins)
expect("a missing file", PINNED + ".ipfs.zkb.fi", 403)
sys.exit(1 if bad else 0)
PY
  then
    pass "ipfs-tls-ask.py answers as specified"
  else
    fail "ipfs-tls-ask.py answers as specified"
  fi
else
  printf 'SKIP  python3 is not installed\n'
fi
# The ask unit takes no network except its own listener, and reads the pins directory only.
for setting in RestrictAddressFamilies=AF_INET 'ReadOnlyPaths=-/var/lib/zk-bridge-ipfs-pins'; do
  if grep -qxF -- "$setting" "$ASK_DIR/zk-bridge-ipfs-tls-ask.service"; then pass "ipfs-tls-ask unit: $setting"; else fail "ipfs-tls-ask unit: missing '$setting'"; fi
done
if grep -qE 'http\.client|urlopen|ZKB_TLSASK_GATEWAY|api/v0' "$ASK_DIR/ipfs-tls-ask.py"; then fail "ipfs-tls-ask.py must not talk to the node"; else pass "ipfs-tls-ask.py does not talk to the node"; fi
# The pins writer (ipfs-pins.sh): a fake curl answers pin/ls with a mix of CID forms; the token stays out of argv.
PW=$(mktemp -d)
mkdir -p "$PW/bin" "$PW/repo"
tok=pinTOKENnotInArgv7q
printf '{"API":{"Authorizations":{"operator":{"AuthSecret":"bearer:%s"}}},"Addresses":{"API":"/ip4/127.0.0.1/tcp/5001"}}\n' "$tok" >"$PW/repo/config"
printf '/ip4/127.0.0.1/tcp/5001\n' >"$PW/repo/api"
cat >"$PW/bin/curl" <<'EOS'
#!/bin/sh
printf '%s\n' "$*" >>"$PW_DIR/argv"
cat >>"$PW_DIR/headers"
for a in "$@"; do url=$a; done
echo "$url" >>"$PW_DIR/calls"
[ -z "${PW_FAIL:-}" ] || { echo '{"Message":"boom"}'; exit 22; }
cat "$PW_DIR/answer"
EOS
chmod +x "$PW/bin/curl"
printf '#!/bin/sh\nprintf "%%s\\n" "$*" >>"%s/as-argv"\nshift\nexec "$@"\n' "$PW" >"$PW/as.sh"
chmod +x "$PW/as.sh"
cat >"$PW/answer" <<'EOS'
{"Keys":{"bafybeid7fd7craeysmup5xufs2lx2b5iic3qt55pafk6zxtxfc4irmyba4":{"Type":"recursive"},"QmYwAPJzv5CZsnA625s3Xf2nemtYgPpHdWEz79ojWnPbdG":{"Type":"recursive"},"BAFYUPPERCASE":{"Type":"recursive"},"zdj7WWeQ43G6JJvLWQWZpyHuAMq6uYWRjkBXFad11vE2LHhQ7":{"Type":"recursive"},"bafkreibspakongvhbu5yyh2pd4jdyecivtrmcbst3pjsfdq4symyqajkku":{"Type":"recursive"},"b1invalid":{"Type":"recursive"}}}
EOS
pins_run() {
  env PW_DIR="$PW" PATH="$PW/bin:$PATH" ZKB_IPFS_PATH="$PW/repo" ZKB_PINS_FILE="$PW/out/pins.txt" ZKB_PINS_AS="$PW/as.sh" "$@" bash "$ASK_DIR/ipfs-pins.sh" refresh >"$PW/out.log" 2>&1
}
if pins_run && [ "$(cat "$PW/out/pins.txt")" = "bafkreibspakongvhbu5yyh2pd4jdyecivtrmcbst3pjsfdq4symyqajkku
bafybeid7fd7craeysmup5xufs2lx2b5iic3qt55pafk6zxtxfc4irmyba4" ]; then pass "ipfs-pins.sh keeps only CIDv1 base32 (no CIDv0, uppercase, other bases), one per line"; else fail "ipfs-pins.sh output: $(cat "$PW/out/pins.txt" 2>&1)"; fi
if grep -q '/api/v0/pin/ls?type=recursive$' "$PW/calls" && [ "$(ls -ld "$PW/out/pins.txt" | cut -c1-10)" = "-rw-r--r--" ]; then pass "ipfs-pins.sh asks for recursive pins and writes a 0644 file"; else fail "ipfs-pins.sh call or mode: $(cat "$PW/calls")"; fi
if grep -qF "$tok" "$PW/argv" "$PW/as-argv" "$PW/out.log"; then fail "the pins writer puts the API token in an argv or its output"; else pass "ipfs-pins.sh: the API token is in no argv"; fi
if [ "$(sort -u "$PW/headers")" = "Authorization: Bearer $tok" ] && grep -q -- '-H @-' "$PW/argv"; then pass "ipfs-pins.sh: the token goes to curl -H @- on standard input"; else fail "ipfs-pins.sh header handling"; fi
cp "$PW/out/pins.txt" "$PW/before"
if pins_run PW_FAIL=1 && false; then :; elif cmp -s "$PW/before" "$PW/out/pins.txt" && [ -z "$(ls -A "$PW/out" | grep -v '^pins.txt$')" ]; then pass "ipfs-pins.sh: a failed call keeps the earlier list and leaves no temporary file"; else fail "ipfs-pins.sh failure handling"; fi
printf '{"Keys":{}}\n' >"$PW/answer"
if pins_run && [ ! -s "$PW/out/pins.txt" ]; then pass "ipfs-pins.sh: no pins gives an empty list"; else fail "ipfs-pins.sh empty list"; fi
rm -rf "$PW"
# Units and wiring.
for f in zk-bridge-ipfs-pins.service zk-bridge-ipfs-pins.timer; do
  [ -f "$ASK_DIR/$f" ] && pass "$f exists" || fail "$f is missing"
done
if grep -qxF 'OnUnitActiveSec=2min' "$ASK_DIR/zk-bridge-ipfs-pins.timer" && grep -qxF 'ExecStart=/opt/zk-bridge/current/deploy/app-server/ipfs-tls-ask/ipfs-pins.sh refresh' "$ASK_DIR/zk-bridge-ipfs-pins.service" && grep -qxF 'Type=oneshot' "$ASK_DIR/zk-bridge-ipfs-pins.service"; then pass "pins unit: oneshot refresh every 2 minutes"; else fail "pins unit or timer"; fi
if grep -q 'zk-bridge-ipfs-pins.timer' "$DIR/provision.sh" && grep -q '/var/lib/zk-bridge-ipfs-pins' "$DIR/provision.sh" && grep -qE 'install -d -m 0755 -o zkb_ipfs -g zkb_ipfs /var/lib/zk-bridge-ipfs-pins' "$DIR/provision.sh" && grep -qxF 'User=zkb_ipfs' "$ASK_DIR/zk-bridge-ipfs-pins.service"; then pass "provision.sh installs the pins timer; the node's user writes the 0755 pins directory"; else fail "provision.sh pins wiring"; fi
if grep -q 'ZKB_PINS_REFRESH' "$DIR/proofs.sh"; then pass "proofs.sh publish refreshes the pin list"; else fail "proofs.sh does not refresh the pin list"; fi
# Root never writes in the node's pins directory: proofs.sh starts the unit, and the script hands a root run to zkb_ipfs.
if grep -qF 'ZKB_PINS_REFRESH:-systemctl start zk-bridge-ipfs-pins.service' "$DIR/proofs.sh" && grep -qF 'exec runuser -u zkb_ipfs -- "$0" "$@"' "$ASK_DIR/ipfs-pins.sh"; then pass "pin list: root never writes in the node's directory"; else fail "pin list: a root path writes in the node's directory"; fi

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
