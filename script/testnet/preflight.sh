#!/usr/bin/env bash
# Preflight for the testnet run: Sepolia (11155111) and PulseChain testnet v4 (943).
#
# For each chain it checks the execution endpoint (eth_chainId) and every beacon route that the prover reads
# (see prover/src/beacon/http.rs). It prints one OK or FAIL line for each route, with the HTTP status.
# It exits with code 1 when any route fails, and with code 2 when the setup is wrong.
#
# Usage:  VALVE_KEY=$(op read 'op://valve/valve city unlimited key v3/password') script/testnet/preflight.sh
#
# The key comes only from the environment variable VALVE_KEY. The script never prints it:
#   - the key reaches curl through a configuration file on standard input, so it is not in any process list;
#   - all output passes through a sed script that replaces the key, and any text that has the shape of a key.
# It sends no transaction and it reads only. It downloads at most a few bytes of each large state.

set -uo pipefail

readonly BASE_URL="https://one.valve.city"
readonly USER_AGENT="Mozilla/5.0 (compatible; preflight/1.0)"
readonly CHAIN_IDS=(11155111 943)
readonly SLOTS_PER_PERIOD=8192
readonly STATE_PROBE_BYTES=64

fail_count=0
body_file=""

# Prints a sed script that redacts the key. The caller feeds it to `sed -f` through a file descriptor.
redaction_script() {
  local escaped
  if [ -n "${VALVE_KEY:-}" ]; then
    escaped=$(printf '%s' "$VALVE_KEY" | sed -e 's/[][\.*^$/|&]/\\&/g')
    printf 's|%s|[redacted]|g\n' "$escaped"
  fi
  printf 's|vk_[A-Za-z0-9_-]*|[redacted]|g\n'
  printf 's|/\\(rpc\\|beacon\\)/[^/ ]*/|/\\1/[redacted]/|g\n'
}

# Sends one request. Arguments: method, url, accept header, extra curl lines (optional body).
# Prints the HTTP status. Leaves the body in $body_file. Status 000 means no answer.
request() {
  local method="$1" url="$2" accept="$3" body="${4:-}"
  {
    printf 'url = "%s"\n' "$url"
    printf 'request = "%s"\n' "$method"
    printf 'header = "Accept: %s"\n' "$accept"
    printf 'user-agent = "%s"\n' "$USER_AGENT"
    printf 'silent\nmax-time = 60\nmax-filesize = %s\n' "${MAX_BYTES:-20000000}"
    [ -n "$body" ] && printf 'header = "Content-Type: application/json"\ndata = "%s"\n' "${body//\"/\\\"}"
    printf 'output = "%s"\nwrite-out = "%%{http_code}"\n' "$body_file"
  } | curl --config - 2>/dev/null
  # curl exits 63 when the body passes max-filesize. The status line was still read, which is all a state probe needs.
  return 0
}

report() {
  local label="$1" status="$2" verdict="$3" note="${4:-}"
  [ "$verdict" = "FAIL" ] && fail_count=$((fail_count + 1))
  printf '%-4s %-5s chain=%-8s %s%s\n' "$verdict" "$status" "$CHAIN_ID" "$label" "${note:+  ($note)}"
}

# Checks one beacon route. Arguments: label, path, accept header, optional jq filter that must be true on the body.
check_beacon() {
  local label="$1" path="$2" accept="$3" filter="${4:-}" status
  status=$(request GET "$BASE_URL/beacon/$VALVE_KEY/$CHAIN_ID$path" "$accept")
  if [ "$status" != "200" ]; then
    report "$label $path" "${status:-000}" FAIL
    return
  fi
  if [ -n "$filter" ] && ! jq -e "$filter" "$body_file" >/dev/null 2>&1; then
    report "$label $path" "$status" FAIL "200 but the body has the wrong shape"
    return
  fi
  report "$label $path" "$status" OK
}

check_rpc() {
  local status answer
  status=$(request POST "$BASE_URL/rpc/$VALVE_KEY/evm/$CHAIN_ID" "application/json" \
    '{"jsonrpc":"2.0","id":1,"method":"eth_chainId","params":[]}')
  if [ "$status" != "200" ]; then
    report "rpc eth_chainId" "${status:-000}" FAIL
    return
  fi
  answer=$(jq -r '.result // empty' "$body_file" 2>/dev/null)
  if [ -z "$answer" ] || [ "$((answer))" != "$CHAIN_ID" ]; then
    report "rpc eth_chainId" "$status" FAIL "answer ${answer:-none}, expected $CHAIN_ID"
    return
  fi
  report "rpc eth_chainId" "$status" OK "$((answer))"
}

check_chain() {
  local head_slot head_root state_root period finalized_root
  check_rpc

  check_beacon "genesis" "/eth/v1/beacon/genesis" "application/json" '.data.genesis_time'
  check_beacon "config/spec" "/eth/v1/config/spec" "application/json" '.data.SECONDS_PER_SLOT'
  check_beacon "config/fork_schedule" "/eth/v1/config/fork_schedule" "application/json" '.data | length > 0'

  check_beacon "headers" "/eth/v1/beacon/headers/head" "application/json" '.data.header.message.slot'
  if ! jq -e '.data.header.message.slot' "$body_file" >/dev/null 2>&1; then
    # The next routes need a slot. Without headers we mark them as failed, so the exit code stays honest.
    for skipped in "headers/finalized" "blocks v2" "blocks v1 root" "debug states v2" "light_client bootstrap" \
      "light_client updates" "light_client finality_update"; do
      report "$skipped" "n/a" FAIL "skipped: no head header"
    done
    return
  fi
  head_slot=$(jq -r '.data.header.message.slot' "$body_file")
  state_root=$(jq -r '.data.header.message.state_root' "$body_file")
  head_root=$(jq -r '.data.root' "$body_file")
  period=$((head_slot / SLOTS_PER_PERIOD))

  check_beacon "headers" "/eth/v1/beacon/headers/finalized" "application/json" '.data.root'
  finalized_root=$(jq -r '.data.root // empty' "$body_file" 2>/dev/null)

  check_beacon "blocks v2" "/eth/v2/beacon/blocks/$head_slot" "application/json" '.data.message.slot'
  check_beacon "blocks v2" "/eth/v2/beacon/blocks/head" "application/json" '.data.message.slot'
  check_beacon "blocks v1 root" "/eth/v1/beacon/blocks/$head_slot/root" "application/json" '.data.root'

  # A state is large (SSZ). Read a few bytes only: the status line is what we need.
  MAX_BYTES=$STATE_PROBE_BYTES check_beacon "debug states v2" "/eth/v2/debug/beacon/states/head" "application/octet-stream"
  MAX_BYTES=$STATE_PROBE_BYTES check_beacon "debug states v2" "/eth/v2/debug/beacon/states/$state_root" "application/octet-stream"
  MAX_BYTES=$STATE_PROBE_BYTES check_beacon "debug states v2" "/eth/v2/debug/beacon/states/finalized" "application/octet-stream"

  check_beacon "light_client finality_update" "/eth/v1/beacon/light_client/finality_update" "application/json" '.data.finalized_header'
  check_beacon "light_client updates" "/eth/v1/beacon/light_client/updates?start_period=$period&count=1" "application/json" 'length > 0'
  if [ -n "$finalized_root" ]; then
    check_beacon "light_client bootstrap" "/eth/v1/beacon/light_client/bootstrap/$finalized_root" "application/json" '.data.current_sync_committee'
  else
    report "light_client bootstrap" "n/a" FAIL "skipped: no finalized root"
  fi
  : "$head_root"
}

main() {
  if [ -z "${VALVE_KEY:-}" ]; then
    echo "VALVE_KEY is not set. Run: VALVE_KEY=\$(op read 'op://valve/valve city unlimited key v3/password') $0" >&2
    return 2
  fi
  command -v jq >/dev/null && command -v curl >/dev/null || { echo "jq and curl are required" >&2; return 2; }
  body_file=$(mktemp) && trap 'rm -f "$body_file"' EXIT
  for CHAIN_ID in "${CHAIN_IDS[@]}"; do
    echo "== chain $CHAIN_ID =="
    check_chain
  done
  echo "== failed routes: $fail_count =="
  [ "$fail_count" -eq 0 ]
}

# The redaction filter reads its script from a file descriptor, so the key is not on a command line.
main 2>&1 | sed -f <(redaction_script 2>/dev/null || true)
exit_code=${PIPESTATUS[0]}
[ "$exit_code" -eq 0 ] && exit 0
[ "$exit_code" -eq 2 ] && exit 2
exit 1
