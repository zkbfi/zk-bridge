#!/usr/bin/env bash
# Starts the explorer indexer (Ponder, embedded PGlite database) on the two Anvil chains of the run. It reads the deployment
# file that e2e/deploy.sh wrote. Stop it with e2e/stop.sh.
set -euo pipefail
source "$(dirname "$0")/env.sh"
e2e_enter_root
[ -f "$E2E_STATE_DIR/deployment.json" ] || e2e_fail "$E2E_STATE_DIR has no deployment. Run e2e/deploy.sh."
: "${E2E_INDEXER_PORT:=42069}"
export EXPLORER_PAIR=eth-pls
export EXPLORER_DEPLOYMENT_FILE="$E2E_STATE_DIR/deployment.json"
export EXPLORER_RPC_URL_1="$E2E_RPC_A"
export EXPLORER_RPC_URL_369="$E2E_RPC_B"
export EXPLORER_BEACON_URL_1="$E2E_BEACON/a"
export EXPLORER_BEACON_URL_369="$E2E_BEACON/b"
export EXPLORER_FINALITY_SECONDS_1=60
export EXPLORER_FINALITY_SECONDS_369=60
export EXPLORER_TIP_INTERVAL_BLOCKS=1
export NO_COLOR=1
rm -rf explorer/indexer/.ponder
e2e_spawn indexer bash -c "cd explorer/indexer && exec node_modules/.bin/ponder start --port $E2E_INDEXER_PORT --schema e2e"
tries=0
until curl -sf "http://127.0.0.1:$E2E_INDEXER_PORT/ready" > /dev/null 2>&1; do
  tries=$((tries + 1))
  [ "$tries" -lt 180 ] || { tail -n 20 "$E2E_LOG_DIR/indexer.log" >&2; e2e_fail "the indexer is not ready after 180 seconds"; }
  sleep 1
done
e2e_log "the indexer answers on port $E2E_INDEXER_PORT"
