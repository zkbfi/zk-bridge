#!/usr/bin/env bash
# Shared runner of light-client-status.sh and march-light-clients.sh: fills the testnet endpoints and the deployment
# file, then starts explorer/backend/bin/zk-bridge-keepalive.mjs. Needs Node.js 24 and `pnpm install` in explorer/.
set -euo pipefail

ROOT=$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)
ENDPOINTS=${ENDPOINTS:-$([ -n "${VALVE_KEY:-}" ] && echo valve || echo public)}

case "$ENDPOINTS" in
  valve)
    [ -n "${VALVE_KEY:-}" ] || { echo "ENDPOINTS=valve needs VALVE_KEY" >&2; exit 2; }
    for chain in 11155111 943; do
      rpc=EXPLORER_RPC_URL_$chain beacon=EXPLORER_BEACON_URL_$chain
      export "$rpc=${!rpc:-https://one.valve.city/rpc/$VALVE_KEY/evm/$chain}"
      export "$beacon=${!beacon:-https://one.valve.city/beacon/$VALVE_KEY/$chain}"
    done
    ;;
  public)
    export EXPLORER_RPC_URL_11155111=${EXPLORER_RPC_URL_11155111:-https://ethereum-sepolia-rpc.publicnode.com}
    export EXPLORER_RPC_URL_943=${EXPLORER_RPC_URL_943:-https://rpc-testnet-pulsechain.g4mm4.io}
    export EXPLORER_BEACON_URL_11155111=${EXPLORER_BEACON_URL_11155111:-https://lodestar-sepolia.chainsafe.io}
    export EXPLORER_BEACON_URL_943=${EXPLORER_BEACON_URL_943:-https://rpc-testnet-pulsechain.g4mm4.io/beacon-api}
    ;;
  *)
    echo "ENDPOINTS must be valve or public" >&2
    exit 2
    ;;
esac

exec node "$ROOT/explorer/backend/bin/zk-bridge-keepalive.mjs" "$@" --pair sepolia-pls943 --deployment "$ROOT/deploy/deployments/sepolia-pls943.json"
