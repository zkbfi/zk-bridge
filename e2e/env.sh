#!/usr/bin/env bash
# Shared settings and helpers of the end-to-end scripts. Source it from the repository root. See docs/end-to-end-real-proofs.md.
#
# Every setting has a default. Set the variable before you run a script to change it. All paths are relative to the
# repository root, and the scripts change to the root first.

: "${E2E_STATE_DIR:=e2e/state}"
: "${E2E_RPC_A_PORT:=38545}"
: "${E2E_RPC_B_PORT:=38546}"
: "${E2E_BEACON_PORT:=39000}"
# How many chain seconds pass in one real second. Each Anvil block advances the chain clock by one slot (12 seconds on chain
# A, 10 seconds on chain B). With 1, a block takes 12 or 10 real seconds, as on the real chains, and the clocks of the two
# chains agree with each other and with the real clock. With 2, blocks come twice as fast. The light client of a chain
# refuses a head that lies after its own clock, so both chains must run at the same scale. Only 1 and 2 divide both slot times.
: "${E2E_TIME_SCALE:=2}"
# What proves: `oracle` (the default: the oracle backend and the oracle verifier, free and fast, so the beacon chain and the
# scripts run in seconds) or `remote` (real Groth16 proofs on a RunPod endpoint, the vendored SP1 verifier). The run chooses
# `remote` only when RUNPOD_API_KEY is set, and then E2E_RUNPOD_URL must name the endpoint. No file holds an endpoint address.
if [ -n "${RUNPOD_API_KEY:-}" ]; then
  : "${E2E_BACKEND:=remote}"
  [ "$E2E_BACKEND" = remote ] || { printf 'e2e: RUNPOD_API_KEY is set but E2E_BACKEND is %s. Unset one of them.\n' "$E2E_BACKEND" >&2; exit 1; }
  [ -n "${E2E_RUNPOD_URL:-}" ] || { printf 'e2e: RUNPOD_API_KEY is set, so E2E_RUNPOD_URL must name the RunPod endpoint\n' >&2; exit 1; }
else
  : "${E2E_BACKEND:=oracle}"
  [ "$E2E_BACKEND" = oracle ] || { printf 'e2e: E2E_BACKEND is %s but RUNPOD_API_KEY is not set.\n' "$E2E_BACKEND" >&2; exit 1; }
fi
# The TypeScript driver reads this same variable (backendOf), so bash and TypeScript cannot choose differently.
export E2E_BACKEND
: "${E2E_PROVER:=prover/target/release/zk-bridge-prover}"
: "${E2E_SIGNED_BEACON:=prover/target/release/signed-beacon}"

# Accounts of the run, by index of the mnemonic: 0 deployer, 1 oracle (rehearsal only), 2 runner, 3 recipient, 4 reward address,
# 5 failed delivery address, 6 copier, 7 and up senders.
# The standard Anvil mnemonic. Every key it makes is public.
E2E_MNEMONIC="test test test test test test test test test test test junk"
# The oracle prover signs with account 1 of the public mnemonic, which holds no value. The remote prover needs none.
if [ "$E2E_BACKEND" = oracle ] && [ -z "${ORACLE_KEY:-}" ]; then
  ORACLE_KEY="$(cast wallet private-key --mnemonic "$E2E_MNEMONIC" --mnemonic-index 1)"
  export ORACLE_KEY
fi
E2E_RPC_A="http://127.0.0.1:${E2E_RPC_A_PORT}"
E2E_RPC_B="http://127.0.0.1:${E2E_RPC_B_PORT}"
E2E_BEACON="http://127.0.0.1:${E2E_BEACON_PORT}"
E2E_LOG_DIR="${E2E_STATE_DIR}/logs"
E2E_PID_DIR="${E2E_STATE_DIR}/pids"
# Public development keystore password. The keystore holds a public Anvil key.
E2E_KEYSTORE_PASSWORD=e2e-local

e2e_log() { printf 'e2e: %s\n' "$*" >&2; }
e2e_fail() { e2e_log "$*"; exit 1; }

# Changes to the repository root, the parent of the directory of the script that sources this file.
e2e_enter_root() { cd "$(dirname "${BASH_SOURCE[1]}")/.." || exit 1; }

# Fails unless every named command exists.
e2e_require() {
  local name
  for name in "$@"; do
    command -v "$name" > /dev/null 2>&1 || e2e_fail "the command $name is not on the PATH"
  done
}

# Starts a command in the background and records its process identifier. Arguments: name, then the command.
e2e_spawn() {
  local name="$1"
  shift
  mkdir -p "$E2E_LOG_DIR" "$E2E_PID_DIR"
  [ ! -f "$E2E_PID_DIR/$name.pid" ] || e2e_fail "$name already runs (pid file $E2E_PID_DIR/$name.pid). Run e2e/stop.sh first."
  nohup "$@" >> "$E2E_LOG_DIR/$name.log" 2>&1 &
  echo $! > "$E2E_PID_DIR/$name.pid"
  e2e_log "started $name (pid $!)"
}

# The block number of a chain. Argument: rpc url.
e2e_block_number() { cast block-number --rpc-url "$1"; }

# Waits until a chain has at least this many blocks. Arguments: rpc url, count.
e2e_wait_for_blocks() {
  local rpc="$1" wanted="$2" tries=0
  until [ "$(e2e_block_number "$rpc" 2> /dev/null || echo 0)" -ge "$wanted" ]; do
    tries=$((tries + 1))
    [ "$tries" -lt 300 ] || e2e_fail "the chain at $rpc has fewer than $wanted blocks after 300 tries"
    sleep 1
  done
}

# Waits until the mined nonce of an account reaches a value. Arguments: rpc url, account, nonce.
e2e_wait_for_nonce() {
  local rpc="$1" account="$2" wanted="$3" tries=0
  until [ "$(cast nonce "$account" --rpc-url "$rpc" 2> /dev/null || echo 0)" -ge "$wanted" ]; do
    tries=$((tries + 1))
    [ "$tries" -lt 120 ] || e2e_fail "the nonce of $account on $rpc did not reach $wanted"
    sleep 1
  done
}

