#!/usr/bin/env bash
# Runs the whole end-to-end run on fresh chains: two Anvil chains, the signed beacon node, the deployment, the proofs, the
# transfers and their deliveries, the bots, and the checks of the dashboards. See docs/end-to-end-real-proofs.md.
#
# By default the oracle prover proves, which is free. With RUNPOD_API_KEY and E2E_RUNPOD_URL in the environment (for example
# the key from `op read`), real proofs run on RunPod. The state directory is E2E_STATE_DIR. The key is passed to the prover
# and the bots only through their environment. Progress goes to $E2E_STATE_DIR/run.log and the facts of
# the run to $E2E_STATE_DIR/results.json.
set -euo pipefail
source "$(dirname "$0")/env.sh"
e2e_enter_root
case "${RUNPOD_API_KEY:-rpa_}" in rpa_*) ;; *) e2e_fail "RUNPOD_API_KEY does not look like a RunPod key" ;; esac

# Whatever happens, stop the chains, the beacon node and the indexer at exit, so a failed stage leaves nothing behind.
E2E_ROOT="$PWD"
trap 'pkill -TERM -P $$ 2> /dev/null || true; "$E2E_ROOT/e2e/stop.sh" || true' EXIT
e2e/stop.sh || true
rm -rf "$E2E_STATE_DIR" .deploy explorer/indexer/.ponder
e2e/start.sh
e2e/deploy.sh
e2e/indexer.sh
cd explorer/e2e
for stage in open gate fund send-a deliver-a send-b deliver-b bots dashboards; do
  e2e_log "stage $stage"
  bun run src/main.ts "$stage"
done
e2e_log "all stages passed. Facts: $E2E_STATE_DIR/results.json"
