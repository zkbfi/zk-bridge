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
for script in deploy.sh provision.sh bluegreen.sh test.sh; do
  if bash -n "$DIR/$script"; then pass "bash -n $script"; else fail "bash -n $script"; fi
done
if command -v shellcheck >/dev/null 2>&1; then
  for script in deploy.sh provision.sh bluegreen.sh test.sh; do
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

# The wallet key: only the runner's user can read it. The publisher runs as another user, so it can read neither the
# file nor the runner's environment in /proc.
has_line zk-bridge-runner.service "EnvironmentFile=/etc/zk-bridge/runner/runner.env"
lacks zk-bridge-publisher.service 'runner\.env'
lacks zk-bridge-publisher.service 'zkb_runner'
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

# --- bluegreen.sh and the Caddy upstream files -----------------------------------------------------------------------
if [ "$(id -u)" -ne 0 ]; then
  status=0
  output=$(bash "$DIR/bluegreen.sh" status 2>&1) || status=$?
  if [ "$status" -ne 0 ] && [ "$output" = "bluegreen: run as root" ]; then pass "bluegreen.sh refuses to run without root"; else fail "bluegreen.sh without root: status $status, output '$output'"; fi
fi
# The Caddyfile imports the upstream files and no longer names a port itself, so the scripts own the routing.
for name in backend indexer; do
  if grep -qxF "import /etc/caddy/upstreams/$name.caddy" "$DIR/Caddyfile"; then pass "Caddyfile imports $name.caddy"; else fail "Caddyfile does not import $name.caddy"; fi
done
lacks Caddyfile '^[[:space:]]*reverse_proxy'
# The snippets that init writes give the routing the Caddyfile had before: the same ports, and no other behaviour.
# shellcheck disable=SC1090
snippets=$(sed '$d' "$DIR/bluegreen.sh" > /tmp/bluegreen-lib.$$ && bash -c ". /tmp/bluegreen-lib.$$; indexer_upstream_normal; backend_upstream_normal"; rm -f /tmp/bluegreen-lib.$$)
if printf '%s\n' "$snippets" | grep -qxF '	reverse_proxy 127.0.0.1:{$ZKB_INDEXER_PORT:42069}' \
  && printf '%s\n' "$snippets" | grep -qxF '	reverse_proxy 127.0.0.1:{$ZKB_BACKEND_PORT:8787}'; then
  pass "bluegreen.sh init writes the ports the Caddyfile had"
else
  fail "bluegreen.sh init does not write the old ports"
fi
# The drain answers only POST /requests: the webhook and the job reads must stay up.
drain=$(sed '$d' "$DIR/bluegreen.sh" > /tmp/bluegreen-lib.$$ && bash -c ". /tmp/bluegreen-lib.$$; backend_upstream_drain"; rm -f /tmp/bluegreen-lib.$$)
if printf '%s\n' "$drain" | grep -qx '		method POST' && printf '%s\n' "$drain" | grep -qx '		path /requests'; then pass "drain matches POST /requests only"; else fail "drain does not match POST /requests only"; fi
# Every release-specific setting that a transient copy takes comes from the unit file: no sandbox setting is repeated here.
if grep -E '^[[:space:]]*-p [A-Za-z]*=' "$DIR/bluegreen.sh" | grep -vE 'Environment=PORT|Restart=no' | grep -q .; then fail "bluegreen.sh sets a unit property by hand"; else pass "bluegreen.sh takes the sandbox from the unit files"; fi
# deploy.sh moves one service at a time on request.
if grep -q 'ZKB_SERVICES' "$DIR/deploy.sh"; then pass "deploy.sh honours ZKB_SERVICES"; else fail "deploy.sh lacks ZKB_SERVICES"; fi

# The light client lines of the indexer's live page (indexer-home/heads.test.mjs).
if command -v node >/dev/null; then
  if node --test "$DIR/indexer-home/heads.test.mjs" >/dev/null 2>&1; then pass "indexer-home: light client lines"; else fail "indexer-home: light client lines (node --test $DIR/indexer-home/heads.test.mjs)"; fi
fi

printf '%d failure(s)\n' "$FAILURES"
[ "$FAILURES" -eq 0 ]
