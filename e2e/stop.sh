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
for name in indexer beacon anvil-b anvil-a; do
  [ ! -f "$E2E_PID_DIR/$name.pid" ] || stop_one "$E2E_PID_DIR/$name.pid"
done

# Stops what still listens on a port of the run and answers as an e2e service. The state directory may be gone or may belong
# to another run, so the pid files are not enough. A process is stopped only when its command line matches the service.
# Arguments: port, pattern of the command line.
stop_listener() {
  local port="$1" pattern="$2" pid command
  for pid in $(lsof -nP -t -iTCP:"$port" -sTCP:LISTEN 2> /dev/null || true); do
    command="$(ps -o command= -p "$pid" 2> /dev/null || true)"
    case "$command" in
      *$pattern*) kill "$pid" 2> /dev/null && e2e_log "stopped the $pattern listener on port $port (pid $pid)" ;;
      *) e2e_log "port $port is held by another program (pid $pid); left alone" ;;
    esac
  done
}
stop_listener "${E2E_INDEXER_PORT:-42069}" ponder
stop_listener "$E2E_BEACON_PORT" signed-beacon
stop_listener "$E2E_RPC_A_PORT" anvil
stop_listener "$E2E_RPC_B_PORT" anvil
e2e_log "everything is stopped"
