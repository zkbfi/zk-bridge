#!/usr/bin/env bash
# Shared settings and helpers of the end-to-end scripts. Source it from the repository root. See docs/end-to-end-real-proofs.md.
#
# Every setting has a default. Set the variable before you run a script to change it. All paths are relative to the
# repository root, and the scripts change to the root first.

# What proves: `sp1` (real Groth16 proofs, the vendored SP1 verifier) or `oracle` (a rehearsal: the oracle backend and the
# oracle verifier, so the beacon chain and the scripts can be tried in seconds).
: "${E2E_BACKEND:=sp1}"
: "${E2E_STATE_DIR:=e2e/state}"
: "${E2E_RPC_A_PORT:=38545}"
: "${E2E_RPC_B_PORT:=38546}"
: "${E2E_BEACON_PORT:=39000}"
# How many chain seconds pass in one real second. Each Anvil block advances the chain clock by one slot (12 seconds on chain
# A, 10 seconds on chain B). With 1, a block takes 12 or 10 real seconds, as on the real chains, and the clocks of the two
# chains agree with each other and with the real clock. With 2, blocks come twice as fast. The light client of a chain
# refuses a head that lies after its own clock, so both chains must run at the same scale. Only 1 and 2 divide both slot times.
: "${E2E_TIME_SCALE:=1}"
# The bots wait a random time between the two limits (in seconds) after each deposit. The bots alternate the direction.
: "${E2E_MINIMUM_WAIT_SECONDS:=150}"
: "${E2E_MAXIMUM_WAIT_SECONDS:=270}"
: "${E2E_BOTS:=2}"
: "${E2E_LIGHT_CLIENT_ELF:=light-client/elf/light-client.elf}"
# The memory limit of the prover (a systemd scope, when systemd-run exists). One Groth16 proof of one update peaks near
# 56 GiB. The prover makes one proof in each process (`max_proofs_per_process = 1`), because a second proof in a process needs
# about 85 GiB. Do not run two proofs at the same time.
: "${E2E_MEMORY_LIMIT:=70G}"
: "${E2E_PROVER:=prover/target/release/zk-bridge-prover}"
: "${E2E_LOCAL_NETWORK:=prover/target/release/local-network}"
# The least rounds of `prover follow` for each route before the first deposit. Two stored heads below an anchor are the
# least that the first block roots layout row needs.
: "${E2E_SEED_UPDATES:=2}"
# The most rounds of `prover follow` before the run gives up. A new vault is locked: it refuses every deposit until a proof shows
# that the light client on the other chain stored a head. The run follows both routes, round after round, until both vaults are
# open. The second round usually opens them, because the reverse route needs a block that finalized after the first update.
: "${E2E_OPENING_ROUNDS:=8}"
# The prover gives up on a deposit after this many failed attempts. The default of the prover is 5. A pass that cannot build
# a withdrawal yet counts as an attempt, so a long wait for a proof needs a higher limit.
: "${E2E_MAX_ATTEMPTS:=1000}"

# The standard Anvil mnemonic. Every key it makes is public.
E2E_MNEMONIC="test test test test test test test test test test test junk"
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
