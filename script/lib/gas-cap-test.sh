#!/usr/bin/env bash
# Tests script/lib/gas-cap.sh against a fake JSON-RPC server (node). Sends nothing outside the machine.
#   script/lib/gas-cap-test.sh
set -uo pipefail
DIR=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
FAILURES=0
pass() { printf 'PASS  %s\n' "$1"; }
fail() { printf 'FAIL  %s\n' "$1"; FAILURES=$((FAILURES + 1)); }

work=$(mktemp -d)
trap 'kill "${server_pid:-0}" 2>/dev/null; rm -rf "$work"' EXIT
# The fake answers eth_getBlockByNumber with the gas limit that its path names: /<hex limit>, or /none for no result.
cat >"$work/server.mjs" <<'JS'
import { createServer } from "node:http";
const server = createServer((request, response) => {
  const value = request.url.slice(1);
  response.setHeader("content-type", "application/json");
  response.end(JSON.stringify(value === "none" ? { jsonrpc: "2.0", id: 1, error: { code: -1, message: "no" } } : { jsonrpc: "2.0", id: 1, result: { gasLimit: value } }));
});
server.listen(0, "127.0.0.1", () => console.log(server.address().port));
JS
node "$work/server.mjs" >"$work/port" &
server_pid=$!
disown
for _ in $(seq 50); do [ -s "$work/port" ] && break; sleep 0.1; done
base="http://127.0.0.1:$(cat "$work/port")"

# shellcheck source=gas-cap.sh
source "$DIR/gas-cap.sh"

expect() { # <name> <want status 0|1> <want text> <chain> <path>
  local out status
  out=$(check_gas_cap "$4" "$base/$5"); status=$?
  if [ "$status" = "$2" ] && [[ "$out" == *"$3"* ]]; then pass "$1"; else fail "$1: status $status, output: $out"; fi
}

# The shipped table: the 11,428,828 worst case sits under the 16,777,216 cap.
expect "block limit above the worst case passes (shipped table, chain 369)" 0 "OK" 369 0x2aea540
expect "block limit at the worst case passes" 0 "OK" 943 0xae63dc
expect "block limit one below the worst case fails" 1 "block gas limit" 943 0xae63db
expect "no readable block gas limit fails" 1 "no readable gas limit" 1 none
expect "a chain missing from the table fails" 1 "no maxTransactionGas" 5 0x2aea540

# A table whose cap is below the worst case.
GAS_DEFAULTS_FILE="$work/low.json"
printf '{"worstCaseDeliveryGas":11428828,"chains":{"369":{"maxTransactionGas":10000000}}}' >"$GAS_DEFAULTS_FILE"
expect "table cap below the worst case fails" 1 "maxTransactionGas 10000000 is below" 369 0x2aea540
printf '{"chains":{"369":{"maxTransactionGas":16777216}}}' >"$GAS_DEFAULTS_FILE"
expect "a table without the worst case fails" 1 "no worstCaseDeliveryGas" 369 0x2aea540

# The RPC URL can hold a key: it must reach curl on standard input, never on its argv (the process list).
lib="$(dirname "${BASH_SOURCE[0]}")/gas-cap.sh"
if grep -q 'curl --config -' "$lib" && ! grep -E 'curl[^|]*"\$rpc_url"' "$lib" >/dev/null; then
  echo "PASS  the RPC URL never goes on curl's argv"
else
  echo "FAIL  the RPC URL never goes on curl's argv"; FAILURES=$((FAILURES + 1))
fi

[ "$FAILURES" -eq 0 ] && { echo "all passed"; exit 0; }
echo "$FAILURES failed"; exit 1
