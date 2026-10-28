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

# Stops what still listens on a port of the run, when the process is provably this run's. The state directory may be gone or
# may belong to another run, so the pid files are not enough. A process is stopped only when its whole command line carries
# every marker that start.sh and indexer.sh give it. A program of another project on the same port stays alone, and the log
# says so. After the termination signal the port gets 10 seconds to free up; then a process this run owns is killed.
# Arguments: port, then one or more markers that the command line must contain.
stop_listener() {
  local port="$1" pid command marker owned tries
  shift
  for pid in $(lsof -nP -t -iTCP:"$port" -sTCP:LISTEN 2> /dev/null || true); do
    command="$(ps -o command= -p "$pid" 2> /dev/null || true)"
    owned=yes
    for marker in "$@"; do
      case "$command" in *"$marker"*) ;; *) owned=no ;; esac
    done
    if [ "$owned" = no ]; then
      e2e_log "port $port is held by a program that is not part of this run (pid $pid). Left alone."
      continue
    fi
    kill "$pid" 2> /dev/null || true
    tries=0
    while kill -0 "$pid" 2> /dev/null && [ "$tries" -lt 10 ]; do
      tries=$((tries + 1))
      sleep 1
    done
    kill -0 "$pid" 2> /dev/null && kill -9 "$pid" 2> /dev/null || true
    e2e_log "stopped the listener on port $port (pid $pid)"
  done
}
stop_listener "${E2E_INDEXER_PORT:-42069}" "ponder.js start --port ${E2E_INDEXER_PORT:-42069} --schema e2e" "$PWD/explorer/indexer/node_modules"
stop_listener "$E2E_BEACON_PORT" "signed-beacon serve --listen 127.0.0.1:$E2E_BEACON_PORT" "--chain a,ethereum,$E2E_RPC_A" "--chain b,pulsechain,$E2E_RPC_B"
stop_listener "$E2E_RPC_A_PORT" "anvil --host 127.0.0.1 --port $E2E_RPC_A_PORT --chain-id 1 " "--slots-in-an-epoch 1 --mnemonic $E2E_MNEMONIC"
stop_listener "$E2E_RPC_B_PORT" "anvil --host 127.0.0.1 --port $E2E_RPC_B_PORT --chain-id 369 " "--slots-in-an-epoch 1 --mnemonic $E2E_MNEMONIC"
# The driver and the programs it starts (the bots and the message board) carry the absolute path of this repository in their
# command lines, which no other project has.
for pattern in "$PWD/explorer/bots/bin/zk-bridge-bot.mjs" "$PWD/explorer/e2e/src/board.ts"; do
  pkill -f -- "$pattern" 2> /dev/null && e2e_log "stopped the programs that match $pattern" || true
done
e2e_log "everything is stopped"
