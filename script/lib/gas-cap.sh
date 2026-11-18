#!/usr/bin/env bash
# Gas-cap check of a deploy preflight. Source this file; it defines `check_gas_cap` and sends no transaction.
#
# One delivery is one transaction on its destination chain, so a chain can carry the bridge only when
#   - its latest block gas limit is at least the worst-case delivery, and
#   - its `maxTransactionGas` in deploy/gas-defaults.json (the per-transaction cap, EIP-7825: 16,777,216) is at
#     least the worst-case delivery.
# The worst-case figure is `worstCaseDeliveryGas` in deploy/gas-defaults.json, the one place it lives; the file names
# the test that measures it (BridgeWorld.t.sol, at-cap delivery). The number of bridge pairs does not change it.
#
#   check_gas_cap <chain id> <rpc url>   prints one OK or FAIL line; returns 0 on OK, 1 on FAIL.
#                                        A chain missing from the table is a FAIL.
# GAS_DEFAULTS_FILE overrides the table (tests). Needs curl and jq.

GAS_DEFAULTS_FILE="${GAS_DEFAULTS_FILE:-$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)/deploy/gas-defaults.json}"

check_gas_cap() {
  local chain_id="$1" rpc_url="$2" worst cap limit_hex limit
  worst=$(jq -r '.worstCaseDeliveryGas // empty' "$GAS_DEFAULTS_FILE" 2>/dev/null)
  cap=$(jq -r --arg id "$chain_id" '.chains[$id].maxTransactionGas // empty' "$GAS_DEFAULTS_FILE" 2>/dev/null)
  if [ -z "$worst" ]; then
    printf 'FAIL gas  chain=%-8s %s has no worstCaseDeliveryGas\n' "$chain_id" "$GAS_DEFAULTS_FILE"
    return 1
  fi
  if [ -z "$cap" ]; then
    printf 'FAIL gas  chain=%-8s no maxTransactionGas in %s\n' "$chain_id" "$GAS_DEFAULTS_FILE"
    return 1
  fi
  limit_hex=$(curl -s --max-time 30 -X POST -H 'Content-Type: application/json' \
    --data '{"jsonrpc":"2.0","id":1,"method":"eth_getBlockByNumber","params":["latest",false]}' "$rpc_url" 2>/dev/null \
    | jq -r '.result.gasLimit // empty' 2>/dev/null)
  if ! [[ "$limit_hex" =~ ^0x[0-9a-fA-F]+$ ]]; then
    printf 'FAIL gas  chain=%-8s the latest block has no readable gas limit\n' "$chain_id"
    return 1
  fi
  limit=$((limit_hex))
  if [ "$limit" -lt "$worst" ]; then
    printf 'FAIL gas  chain=%-8s block gas limit %s is below the worst-case delivery %s\n' "$chain_id" "$limit" "$worst"
    return 1
  fi
  if [ "$cap" -lt "$worst" ]; then
    printf 'FAIL gas  chain=%-8s maxTransactionGas %s is below the worst-case delivery %s\n' "$chain_id" "$cap" "$worst"
    return 1
  fi
  printf 'OK   gas  chain=%-8s block gas limit %s, maxTransactionGas %s, worst-case delivery %s\n' "$chain_id" "$limit" "$cap" "$worst"
}
