#!/usr/bin/env bash
# Stops everything that e2e/start.sh started: the indexer, the bots, the beacon node and both Anvil chains.
# It leaves the state directory, the logs and the binaries in place.
set -euo pipefail
source "$(dirname "$0")/env.sh"
e2e_enter_root

# Stops one process: a termination signal first, a kill after 30 seconds. Argument: pid file.
stop_one() {
  local file="$1" name pid tries=0
  name="$(basename "$file" .pid)"
  pid="$(cat "$file")"
  if kill -0 "$pid" 2> /dev/null; then
    kill "$pid" 2> /dev/null || true
    while kill -0 "$pid" 2> /dev/null && [ "$tries" -lt 30 ]; do
      tries=$((tries + 1))
      sleep 1
    done
    kill -0 "$pid" 2> /dev/null && kill -9 "$pid" 2> /dev/null || true
    e2e_log "stopped $name (pid $pid)"
  else
    e2e_log "$name was not running (pid $pid)"
  fi
  rm -f "$file"
}

# The order is the reverse of the start: the indexer and the bots first, then the beacon node and the chains.
for name in indexer bots publisher runner beacon anvil-b anvil-a; do
  [ ! -f "$E2E_PID_DIR/$name.pid" ] || stop_one "$E2E_PID_DIR/$name.pid"
done
e2e_log "everything is stopped"
