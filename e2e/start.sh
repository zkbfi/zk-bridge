#!/usr/bin/env bash
# Starts the whole end-to-end run: two Anvil chains, the signed beacon node, the deployment, the prover and the bots.
#
# Needs anvil, forge and cast on the PATH, the binaries of prover/ (`cargo build --release --features sp1-native-gnark`
# for E2E_BACKEND=sp1) and, for real proofs, the light-client program (E2E_LIGHT_CLIENT_ELF). Stop it with e2e/stop.sh.
# See docs/end-to-end-real-proofs.md.
set -euo pipefail
source "$(dirname "$0")/env.sh"
e2e_enter_root
e2e_require anvil cast forge
[ -x "$E2E_PROVER" ] || e2e_fail "$E2E_PROVER is not built"
[ -x "$E2E_LOCAL_NETWORK" ] || e2e_fail "$E2E_LOCAL_NETWORK is not built"
[ "$E2E_BACKEND" != sp1 ] || [ -f "$E2E_LIGHT_CLIENT_ELF" ] || e2e_fail "the light-client program $E2E_LIGHT_CLIENT_ELF is missing"
[ ! -f "$E2E_STATE_DIR/deployment.json" ] || e2e_fail "$E2E_STATE_DIR holds a deployment. Run e2e/stop.sh first."
[ $((12 % E2E_TIME_SCALE)) -eq 0 ] && [ $((10 % E2E_TIME_SCALE)) -eq 0 ] || e2e_fail "E2E_TIME_SCALE must divide 12 and 10 (use 1 or 2)"
mkdir -p "$E2E_LOG_DIR" "$E2E_PID_DIR"

# Starts one Anvil chain on the slot grid: one block per slot, with the chain clock one slot ahead for each block, and one
# block every `slot_seconds / E2E_TIME_SCALE` real seconds. Arguments: name, port, chain identifier, hardfork, seconds per slot.
start_chain() {
  local name="$1" port="$2" chain_id="$3" hardfork="$4" slot_seconds="$5" rpc="http://127.0.0.1:$2"
  e2e_spawn "anvil-$name" anvil --host 127.0.0.1 --port "$port" --chain-id "$chain_id" --hardfork "$hardfork" \
    --no-mining --slots-in-an-epoch 1 --mnemonic "$E2E_MNEMONIC"
  local tries=0
  until cast chain-id --rpc-url "$rpc" > /dev/null 2>&1; do
    tries=$((tries + 1))
    [ "$tries" -lt 60 ] || e2e_fail "anvil-$name does not answer at $rpc"
    sleep 1
  done
  cast rpc anvil_setBlockTimestampInterval "$slot_seconds" --rpc-url "$rpc" > /dev/null
  cast rpc evm_setIntervalMining "$((slot_seconds / E2E_TIME_SCALE))" --rpc-url "$rpc" > /dev/null
}

start_chain a "$E2E_RPC_A_PORT" 1 cancun 12
start_chain b "$E2E_RPC_B_PORT" 369 shanghai 10
e2e_spawn beacon "$E2E_LOCAL_NETWORK" signed-beacon --listen "127.0.0.1:$E2E_BEACON_PORT" \
  --chain "a,ethereum,$E2E_RPC_A" --chain "b,pulsechain,$E2E_RPC_B"
# The finality rule of the beacon chain needs a few blocks, and the checkpoint is read at the newest final header.
e2e_wait_for_blocks "$E2E_RPC_A" 8
e2e_wait_for_blocks "$E2E_RPC_B" 8

e2e/deploy.sh
e2e/services.sh
