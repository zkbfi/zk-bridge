#!/usr/bin/env bash
# Starts the prover and the bots on a finished deployment (the state directory holds deployment.json and prover.toml).
# e2e/start.sh calls it after the deployment. Run it alone to start the services again on chains that still run.
set -euo pipefail
source "$(dirname "$0")/env.sh"
e2e_enter_root
[ -f "$E2E_STATE_DIR/deployment.json" ] || e2e_fail "$E2E_STATE_DIR has no deployment. Run e2e/start.sh."
[ -x "$E2E_PROVER" ] || e2e_fail "$E2E_PROVER is not built"
mkdir -p "$E2E_LOG_DIR" "$E2E_PID_DIR"

export RUST_LOG="${RUST_LOG:-info}"
# The memory of a proof grows with the number of proving workers. These values kept a Groth16 proof of one update near
# 62 GB on a machine with 32 threads.
export SP1_WORKER_NUM_CORE_WORKERS="${SP1_WORKER_NUM_CORE_WORKERS:-2}"
export SP1_WORKER_CORE_BUFFER_SIZE="${SP1_WORKER_CORE_BUFFER_SIZE:-2}"
export SP1_WORKER_NUM_RECURSION_PROVER_WORKERS="${SP1_WORKER_NUM_RECURSION_PROVER_WORKERS:-4}"
export SP1_WORKER_RECURSION_PROVER_BUFFER_SIZE="${SP1_WORKER_RECURSION_PROVER_BUFFER_SIZE:-4}"
# The prover runs in a systemd scope with a memory limit when it proves with SP1 and systemd-run exists.
prover_prefix=()
if [ "$E2E_BACKEND" = sp1 ] && command -v systemd-run > /dev/null 2>&1; then
  prover_prefix=(systemd-run --user --scope --collect --quiet --unit zk-bridge-e2e-prover -p "MemoryMax=$E2E_MEMORY_LIMIT" -p MemorySwapMax=0)
  [ -f "$E2E_PID_DIR/memory.pid" ] || e2e_spawn memory e2e/sample-memory.sh zk-bridge-e2e-prover.scope "$E2E_STATE_DIR/memory.log"
fi
prover_command=(${prover_prefix[@]+"${prover_prefix[@]}"} "$E2E_PROVER" --config "$E2E_STATE_DIR/prover.toml")
prover_prefix_and_binary=(${prover_prefix[@]+"${prover_prefix[@]}"} "$E2E_PROVER")

# Open the vaults before the first deposit. A new vault is locked: it refuses every deposit until `follow` proves that the light
# client on the other chain stored a head. The proof needs a block of the other chain that finalized after the first update, so
# the run follows both routes, round after round, until `follow` reports both vaults open. `follow` also stores the heads that
# the first layout rows need: two stored headers below the anchor, and a header at or below the slot of the first deposit.
e2e_log "following both routes until both vaults are open (at least $E2E_SEED_UPDATES rounds, at most $E2E_OPENING_ROUNDS)"
# One configuration for each route, so that each follow process makes one proof.
for route in a_to_b b_to_a; do
  { printf 'routes = ["%s"]\n' "$route"; cat "$E2E_STATE_DIR/prover.toml"; } > "$E2E_STATE_DIR/prover-$route.toml"
done
both_open=no
for round in $(seq 1 "$E2E_OPENING_ROUNDS"); do
  still_locked=no
  for route in a_to_b b_to_a; do
    follow_code=0
    "${prover_prefix_and_binary[@]}" --config "$E2E_STATE_DIR/prover-$route.toml" follow --rounds 1 >> "$E2E_LOG_DIR/follow.log" 2>&1 \
      || follow_code=$?
    # Exit code 2 means that the source vault of the route is still locked. Any other code is a failure.
    case "$follow_code" in
      0) ;;
      2) still_locked=yes ;;
      *) e2e_fail "the prover could not follow $route (round $round, exit code $follow_code). See $E2E_LOG_DIR/follow.log" ;;
    esac
  done
  if [ "$still_locked" = no ] && [ "$round" -ge "$E2E_SEED_UPDATES" ]; then
    both_open=yes
    break
  fi
  # The next head needs a newer final block. A real proof takes minutes, so this wait matters only for the oracle backend.
  sleep $((36 / E2E_TIME_SCALE))
done
[ "$both_open" = yes ] || e2e_fail "a vault is still locked after $E2E_OPENING_ROUNDS rounds. See $E2E_LOG_DIR/follow.log"
e2e_log "both vaults are open"

e2e_spawn prover e2e/prover-loop.sh "${prover_command[@]}"
e2e_spawn bots "$E2E_LOCAL_NETWORK" --deployment "$E2E_STATE_DIR/deployment.json" traffic \
  --minimum-wait-seconds "$E2E_MINIMUM_WAIT_SECONDS" --maximum-wait-seconds "$E2E_MAXIMUM_WAIT_SECONDS" --bots "$E2E_BOTS"
e2e_log "running. Logs are in $E2E_LOG_DIR. Watch with: python3 -I e2e/report.py"
