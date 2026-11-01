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
for script in deploy.sh provision.sh test.sh; do
  if bash -n "$DIR/$script"; then pass "bash -n $script"; else fail "bash -n $script"; fi
done
if command -v shellcheck >/dev/null 2>&1; then
  for script in deploy.sh provision.sh test.sh; do
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
lacks Caddyfile '^[[:space:]]*reverse_proxy'
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

# The light client lines of the indexer's live page (indexer-home/heads.test.mjs).
if command -v node >/dev/null; then
  if node --test "$DIR/indexer-home/heads.test.mjs" >/dev/null 2>&1; then pass "indexer-home: light client lines"; else fail "indexer-home: light client lines (node --test $DIR/indexer-home/heads.test.mjs)"; fi
fi

printf '%d failure(s)\n' "$FAILURES"
[ "$FAILURES" -eq 0 ]
