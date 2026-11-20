#!/usr/bin/env bash
# Regenerates the real-data fixtures under tests/fixtures/ from public beacon and execution endpoints.
#
# Usage:
#   scripts/fetch-fixtures.sh ethereum      Ethereum mainnet: chain specification, light-client data, receipts
#   scripts/fetch-fixtures.sh pulsechain    PulseChain: chain specification, beacon blocks, state, receipts
#   scripts/fetch-fixtures.sh historical    PulseChain: real historical-path ancestry (needs `pulsechain` run first; same anchor)
#   scripts/fetch-fixtures.sh transactions  the raw transactions of every real execution block on file (*_transactions.json)
#   scripts/fetch-fixtures.sh all
#
# Needs: bash, curl, jq, cargo. It calls the derive tool for PulseChain (the beacon state is 18 MB and is not committed).
# Every fixture file is a JSON object {"source_url", "fetched_on", "response"} (or "request" for JSON-RPC calls).
# Raw downloads go to fetch-cache/ (ignored by git); this script lives apart from the downloaded data.
#
# Endpoints that worked on 2026-10-20 (see the report in progress notes):
#   Ethereum beacon (light-client endpoints): https://ethereum-beacon-api.publicnode.com and https://lodestar-mainnet.chainsafe.io
#   Ethereum beacon (specification only):     https://mainnet.checkpoint.sigp.io, https://sync-mainnet.beaconcha.in
#   Ethereum execution:                       https://ethereum-rpc.publicnode.com
#   PulseChain beacon:                        https://rpc-pulsechain.g4mm4.io/beacon-api (no light-client endpoints: 404)
#   PulseChain execution:                     https://rpc-pulsechain.g4mm4.io
set -euo pipefail

here="$(cd "$(dirname "$0")/.." && pwd)"
fixtures="${here}/tests/fixtures"
cache="${here}/fetch-cache"
today="$(date +%F)"

ethereum_beacon="${ETHEREUM_BEACON:-https://ethereum-beacon-api.publicnode.com}"
ethereum_execution="${ETHEREUM_EXECUTION:-https://ethereum-rpc.publicnode.com}"
pulsechain_beacon="${PULSECHAIN_BEACON:-https://rpc-pulsechain.g4mm4.io/beacon-api}"
pulsechain_execution="${PULSECHAIN_EXECUTION:-https://rpc-pulsechain.g4mm4.io}"

mkdir -p "${fixtures}/ethereum" "${fixtures}/pulsechain" "${cache}/pulsechain" "${cache}/work"

# get_json <url> <output-file>: GET a url and wrap the response with its source and date.
get_json() {
  local url="$1" output="$2"
  curl -sf --retry 3 -m 120 "${url}" > "${cache}/work/response.json"
  jq --arg url "${url}" --arg on "${today}" '{source_url: $url, fetched_on: $on, response: .}' "${cache}/work/response.json" > "${output}"
  echo "wrote ${output}"
}

# rpc_json <endpoint> <method> <params-json> <output-file>: JSON-RPC call wrapped with its source and date.
rpc_json() {
  local endpoint="$1" method="$2" params="$3" output="$4"
  local request
  request="$(jq -nc --arg method "${method}" --argjson params "${params}" '{jsonrpc:"2.0",id:1,method:$method,params:$params}')"
  curl -sf --retry 3 -m 120 -H 'content-type: application/json' -d "${request}" "${endpoint}" > "${cache}/work/response.json"
  jq -e '.error == null' "${cache}/work/response.json" > /dev/null
  jq --arg url "${endpoint}" --arg on "${today}" --argjson request "${request}" \
    '{source_url: $url, fetched_on: $on, request: $request, response: .result}' "${cache}/work/response.json" > "${output}"
  echo "wrote ${output}"
}

# first_existing_slot <beacon> <slot>: the first slot at or after <slot> that has a block header.
first_existing_slot() {
  local beacon="$1" slot="$2"
  until curl -sf -m 30 -o /dev/null "${beacon}/eth/v1/beacon/headers/${slot}"; do slot=$((slot + 1)); done
  echo "${slot}"
}

# first_epoch_start_block <beacon> <slot>: the first slot at or after <slot> that is a multiple of 32 and has a block.
# The bootstrap endpoint serves only epoch-start (checkpoint) blocks.
first_epoch_start_block() {
  local beacon="$1" slot=$(( ($2 + 31) / 32 * 32 ))
  until curl -sf -m 30 -o /dev/null "${beacon}/eth/v1/beacon/headers/${slot}"; do slot=$((slot + 32)); done
  echo "${slot}"
}

# popcount_hex <0x-hex>: number of set bits.
popcount_hex() {
  jq -nr --arg hex "$1" '$hex[2:] | explode | map(if . >= 97 then . - 87 else . - 48 end) | map([0,1,1,2,1,2,2,3,1,2,2,3,2,3,3,4][.]) | add'
}

# receipt_block <execution-endpoint> <label> <prefix>: finds a recent small block with type 0 and type 2 receipts.
fetch_receipts() {
  local endpoint="$1" directory="$2" latest number
  latest="$(curl -sf -m 30 -H 'content-type: application/json' -d '{"jsonrpc":"2.0","id":1,"method":"eth_blockNumber","params":[]}' "${endpoint}" | jq -r .result)"
  number=$(( latest - 400 ))
  local best="" best_count=100000
  for offset in $(seq 0 60); do
    local candidate=$(( number - offset ))
    local hex; hex="$(printf '0x%x' "${candidate}")"
    local body; body="$(curl -sf -m 60 -H 'content-type: application/json' \
      -d "{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"eth_getBlockReceipts\",\"params\":[\"${hex}\"]}" "${endpoint}")" || continue
    local count; count="$(echo "${body}" | jq '.result | length')"
    local both; both="$(echo "${body}" | jq '[.result[].type] | (index("0x0") != null) and (index("0x2") != null)')"
    if [ "${both}" = "true" ] && [ "${count}" -lt "${best_count}" ] && [ "${count}" -ge 4 ]; then
      best="${candidate}"; best_count="${count}"
    fi
  done
  [ -n "${best}" ] || { echo "no block with type 0 and type 2 receipts found"; return 1; }
  local best_hex; best_hex="$(printf '0x%x' "${best}")"
  echo "receipt block ${best} (${best_count} receipts) for ${directory}"
  rpc_json "${endpoint}" eth_getBlockByNumber "[\"${best_hex}\", false]" "${fixtures}/${directory}/execution_block.json"
  rpc_json "${endpoint}" eth_getBlockReceipts "[\"${best_hex}\"]" "${fixtures}/${directory}/block_receipts.json"
}

fetch_ethereum() {
  local beacon="${ethereum_beacon}"
  get_json "${beacon}/eth/v1/config/spec" "${fixtures}/ethereum/chain_spec.json"
  get_json "${beacon}/eth/v1/beacon/genesis" "${fixtures}/ethereum/genesis.json"

  # The newest finality update, and the period arithmetic around it.
  get_json "${beacon}/eth/v1/beacon/light_client/finality_update" "${fixtures}/ethereum/finality_update.json"
  local finalized_slot period period_start
  finalized_slot="$(jq -r '.response.data.finalized_header.beacon.slot' "${fixtures}/ethereum/finality_update.json")"
  period=$(( finalized_slot / 8192 ))
  period_start=$(( period * 8192 ))

  # Store for the same period: bootstrap from a block 64..1000 slots into the period and before the finalized slot.
  local same_slot=$(( finalized_slot - 1000 ))
  [ "${same_slot}" -lt $(( period_start + 64 )) ] && same_slot=$(( period_start + 64 ))
  same_slot="$(first_epoch_start_block "${beacon}" "${same_slot}")"
  local same_root; same_root="$(curl -sf "${beacon}/eth/v1/beacon/headers/${same_slot}" | jq -r .data.root)"
  get_json "${beacon}/eth/v1/beacon/light_client/bootstrap/${same_root}" "${fixtures}/ethereum/bootstrap_same_period.json"

  # Period crossing: bootstrap in the previous period, then the best updates of the previous and of this period.
  local previous_start=$(( (period - 1) * 8192 ))
  local previous_slot; previous_slot="$(first_epoch_start_block "${beacon}" $(( previous_start + 64 )))"
  local previous_root; previous_root="$(curl -sf "${beacon}/eth/v1/beacon/headers/${previous_slot}" | jq -r .data.root)"
  get_json "${beacon}/eth/v1/beacon/light_client/bootstrap/${previous_root}" "${fixtures}/ethereum/bootstrap_previous_period.json"
  get_json "${beacon}/eth/v1/beacon/light_client/updates?start_period=$(( period - 1 ))&count=2" "${fixtures}/ethereum/updates_two_periods.json"

  # Independent check data: the execution block of the finalized header from the execution endpoint.
  local number_hex
  number_hex="$(printf '0x%x' "$(jq -r '.response.data.finalized_header.execution.block_number' "${fixtures}/ethereum/finality_update.json")")"
  rpc_json "${ethereum_execution}" eth_getBlockByNumber "[\"${number_hex}\", false]" "${fixtures}/ethereum/finalized_execution_block.json"
  fetch_receipts "${ethereum_execution}" ethereum
}

fetch_pulsechain() {
  local beacon="${pulsechain_beacon}" work="${cache}/pulsechain"
  get_json "${beacon}/eth/v1/config/spec" "${fixtures}/pulsechain/chain_spec.json"
  get_json "${beacon}/eth/v1/beacon/genesis" "${fixtures}/pulsechain/genesis.json"

  # Pick attested block A and its child C. C must carry at least 342 signers and have A as parent.
  local head_slot; head_slot="$(curl -sf "${beacon}/eth/v1/beacon/headers/head" | jq -r .data.header.message.slot)"
  local attested_slot="" child_slot
  for slot in $(seq -f %.0f $(( head_slot - 6 )) -1 $(( head_slot - 60 ))); do
    local a_root c_parent bits
    a_root="$(curl -sf "${beacon}/eth/v1/beacon/headers/${slot}" | jq -r .data.root)" || continue
    c_parent="$(curl -sf "${beacon}/eth/v1/beacon/headers/$(( slot + 1 ))" | jq -r .data.header.message.parent_root)" || continue
    [ "${a_root}" = "${c_parent}" ] || continue
    bits="$(curl -sf "${beacon}/eth/v2/beacon/blocks/$(( slot + 1 ))" | jq -r .data.message.body.sync_aggregate.sync_committee_bits)"
    [ "$(popcount_hex "${bits}")" -ge 342 ] || continue
    attested_slot="${slot}"; child_slot=$(( slot + 1 )); break
  done
  [ -n "${attested_slot}" ] || { echo "no suitable attested block"; return 1; }
  echo "attested ${attested_slot}, child ${child_slot}"

  local attested_header attested_root state_root
  attested_header="$(curl -sf "${beacon}/eth/v1/beacon/headers/${attested_slot}")"
  attested_root="$(echo "${attested_header}" | jq -r .data.root)"
  state_root="$(echo "${attested_header}" | jq -r .data.header.message.state_root)"

  # Raw material for the derive tool. The state is about 18 MB.
  curl -sf -m 300 -H 'Accept: application/octet-stream' -o "${work}/attested_state.ssz" "${beacon}/eth/v2/debug/beacon/states/${state_root}"
  curl -sf -H 'Accept: application/octet-stream' -o "${work}/attested_block.ssz" "${beacon}/eth/v2/beacon/blocks/${attested_root}"
  echo "${attested_header}" > "${work}/attested_header.json"
  curl -sf "${beacon}/eth/v2/beacon/blocks/${child_slot}" > "${work}/child_block.json"
  curl -sf "${beacon}/eth/v1/beacon/states/${state_root}/finality_checkpoints" > "${work}/finality_checkpoints.json"
  local finalized_root; finalized_root="$(jq -r .data.finalized.root "${work}/finality_checkpoints.json")"
  curl -sf -H 'Accept: application/octet-stream' -o "${work}/finalized_block.ssz" "${beacon}/eth/v2/beacon/blocks/${finalized_root}"
  curl -sf "${beacon}/eth/v1/beacon/headers/${finalized_root}" > "${work}/finalized_header.json"
  local finalized_slot; finalized_slot="$(jq -r .data.header.message.slot "${work}/finalized_header.json")"

  # A second ancestor (about 100 slots before the anchor) for the ancestry proof, and an older head for the store.
  local ancestor_slot; ancestor_slot="$(first_existing_slot "${beacon}" $(( attested_slot - 100 )))"
  curl -sf "${beacon}/eth/v1/beacon/headers/${ancestor_slot}" > "${work}/ancestor_header.json"
  curl -sf -H 'Accept: application/octet-stream' -o "${work}/ancestor_block.ssz" "${beacon}/eth/v2/beacon/blocks/${ancestor_slot}"
  local previous_slot; previous_slot="$(first_existing_slot "${beacon}" $(( finalized_slot - 64 )))"
  curl -sf "${beacon}/eth/v1/beacon/headers/${previous_slot}" > "${work}/previous_header.json"

  # Independent source for the committee: validator indices and public keys from the state endpoints.
  get_json "${beacon}/eth/v1/beacon/states/${state_root}/sync_committees" "${fixtures}/pulsechain/sync_committee_indices.json"
  local indices; indices="$(jq -c '.response.data.validators' "${fixtures}/pulsechain/sync_committee_indices.json")"
  curl -sf -m 120 -H 'content-type: application/json' -d "{\"ids\": ${indices}}" "${beacon}/eth/v1/beacon/states/${state_root}/validators" > "${work}/committee_validators.json"
  jq --arg url "POST ${beacon}/eth/v1/beacon/states/${state_root}/validators (ids = sync committee indices)" --arg on "${today}" \
    '{source_url: $url, fetched_on: $on, response: {data: [.data[] | {index, pubkey: .validator.pubkey}]}}' \
    "${work}/committee_validators.json" > "${fixtures}/pulsechain/sync_committee_pubkeys.json"

  # Execution block of the finalized beacon block, as an independent check of the proven block hash.
  local number_hex
  number_hex="$(printf '0x%x' "$(curl -sf "${beacon}/eth/v2/beacon/blocks/${finalized_root}" | jq -r .data.message.body.execution_payload.block_number)")"
  rpc_json "${pulsechain_execution}" eth_getBlockByNumber "[\"${number_hex}\", false]" "${fixtures}/pulsechain/finalized_execution_block.json"
  fetch_receipts "${pulsechain_execution}" pulsechain

  (cd "${here}" && cargo run --quiet -p lc-testkit --bin derive-pulsechain-fixtures -- "${work}" "${fixtures}/pulsechain" "${beacon}" "${today}")
  fetch_path_blocks
}

# fetch_path_blocks: the execution block and receipts of every deposit candidate named in beacon_paths.json.
fetch_path_blocks() {
  local names; names="$(jq -r '.response.entries[].name' "${fixtures}/pulsechain/beacon_paths.json")"
  for name in ${names}; do
    local number_hex
    number_hex="$(printf '0x%x' "$(jq -r --arg name "${name}" '.response.entries[] | select(.name == $name) | .execution_block_number' "${fixtures}/pulsechain/beacon_paths.json")")"
    rpc_json "${pulsechain_execution}" eth_getBlockByNumber "[\"${number_hex}\", false]" "${fixtures}/pulsechain/path_${name}_block.json"
    rpc_json "${pulsechain_execution}" eth_getBlockReceipts "[\"${number_hex}\"]" "${fixtures}/pulsechain/path_${name}_receipts.json"
  done
}

# slot_root <slot>: prints "<slot> <root>" when the canonical chain has a block at the slot, nothing when the slot is empty.
slot_root() {
  local slot="$1" body
  body="$(curl -sf --retry 3 -m 30 -A zk-bridge-fixture-fetch "${HISTORICAL_BEACON}/eth/v1/beacon/blocks/${slot}/root")" || return 0
  echo "${slot} $(echo "${body}" | jq -r .data.root)"
}
export -f slot_root

# fetch_era_roots <era> <output>: the root of every canonical block in the slots of an era, and of the last block before it.
# It takes about five minutes per era and reuses the output file when it exists (delete the file to refetch).
# An empty slot repeats the root of the block before it in block_roots; the derive tool does that carry.
fetch_era_roots() {
  local era="$1" output="$2" start end previous
  if [ -s "${output}" ]; then echo "reusing ${output}"; return 0; fi
  start=$(( era * 8192 )); end=$(( start + 8191 ))
  export HISTORICAL_BEACON="${pulsechain_beacon}"
  seq -f %.0f "${start}" "${end}" | xargs -P 8 -I{} bash -c 'slot_root {}' | sort -n > "${output}"
  previous=$(( start - 1 ))
  if [ "${start}" -gt 0 ]; then
    until [ -n "$(slot_root "${previous}")" ]; do previous=$(( previous - 1 )); done
    slot_root "${previous}" >> "${output}"
  fi
  echo "wrote ${output}: $(wc -l < "${output}") blocks"
}

# fetch_historical: real historical-path ancestry for PulseChain. It reuses the anchor state that `pulsechain` downloaded.
# The era's block roots are rebuilt from canonical block roots, because on 2026-10-20 the node served every state older
# than a few hundred slots with ONE historical summary missing at the end of the list (the state root then fails to match
# the header). Only states near the head hash correctly.
fetch_historical() {
  local beacon="${pulsechain_beacon}" work="${cache}/pulsechain/era" anchor="${cache}/pulsechain"
  mkdir -p "${work}"
  local anchor_slot era
  anchor_slot="$(jq -r .data.header.message.slot "${anchor}/attested_header.json")"
  era=$(( anchor_slot / 8192 - 1 ))
  local edge_before=$(( era * 8192 - 1 )) edge_after=$(( era * 8192 )) era_last=$(( (era + 1) * 8192 - 1 ))
  local middle="${HISTORICAL_MIDDLE_SLOT:-$(( era * 8192 + 3471 ))}"
  local slot
  for slot in 96 8191 "${edge_before}" "${edge_after}" "${middle}" "${era_last}"; do
    curl -sf --retry 3 -m 60 -A zk-bridge-fixture-fetch "${beacon}/eth/v1/beacon/headers/${slot}" > "${work}/header_${slot}.json"
    curl -sf --retry 3 -m 60 -A zk-bridge-fixture-fetch -H 'Accept: application/octet-stream' -o "${work}/block_${slot}.ssz" "${beacon}/eth/v2/beacon/blocks/${slot}"
  done
  fetch_era_roots 0 "${work}/era_roots_0.txt"
  fetch_era_roots $(( era - 1 )) "${work}/era_roots_$(( era - 1 )).txt"
  fetch_era_roots "${era}" "${work}/era_roots_${era}.txt"
  (cd "${here}" && cargo run --quiet --release -p lc-testkit --bin derive-historical-fixtures -- "${work}" "${anchor}" "${fixtures}/pulsechain" "${beacon}" "${today}" \
    "capella_fork_block=96" "era_zero_last_block=8191" "era_previous_last_block=${edge_before}" "era_first_block=${edge_after}" \
    "era_middle_block=${middle}" "era_last_block=${era_last}")
  # Execution block and receipts of the middle block (few transactions), for the full message fixture.
  local number_hex
  number_hex="$(printf '0x%x' "$(jq -r '.response.entries[] | select(.name == "era_middle_block") | .execution_block_number' "${fixtures}/pulsechain/historical_paths.json")")"
  rpc_json "${pulsechain_execution}" eth_getBlockByNumber "[\"${number_hex}\", false]" "${fixtures}/pulsechain/path_historical_block.json"
  rpc_json "${pulsechain_execution}" eth_getBlockReceipts "[\"${number_hex}\"]" "${fixtures}/pulsechain/path_historical_receipts.json"
}

# fetch_transactions <execution-endpoint> <source-label> <block-fixture>: the raw bytes of every transaction of a block
# fixture (eth_getRawTransactionByHash, in block order) into the sibling file `*transactions.json`
# (`execution_block.json` -> `execution_transactions.json`, `path_<name>_block.json` -> `path_<name>_transactions.json`).
# The endpoint may hold a key in its path, so the file records <source-label>, never the endpoint.
fetch_transactions() {
  local endpoint="$1" label="$2" block="$3"
  local output="${block%block.json}transactions.json" hash request raw="${cache}/work/raw_transactions.txt"
  : > "${raw}"
  for hash in $(jq -r '.response.transactions[]' "${block}"); do
    request="$(jq -nc --arg hash "${hash}" '{jsonrpc:"2.0",id:1,method:"eth_getRawTransactionByHash",params:[$hash]}')"
    curl -sf --retry 3 -m 60 -H 'content-type: application/json' -d "${request}" "${endpoint}" \
      | jq -er '.result | select(. != null)' >> "${raw}"
  done
  jq -R . "${raw}" | jq -s --arg url "${label}" --arg on "${today}" \
    --arg number "$(jq -r .response.number "${block}")" --arg hash "$(jq -r .response.hash "${block}")" \
    '{source_url: $url, fetched_on: $on,
      request: {method: "eth_getRawTransactionByHash", params: "each hash of response.transactions of the block fixture, in block order", block_number: $number, block_hash: $hash},
      response: .}' > "${output}"
  echo "wrote ${output}: $(wc -l < "${raw}") transactions"
}

# fetch_all_transactions: the transaction bytes of every real execution block on file. The Rust tests rebuild the
# transactions trie from them (`receipts_real.rs`, `pulsechain_real.rs`). Set ETHEREUM_TX_EXECUTION / PULSECHAIN_TX_EXECUTION
# to nodes that serve eth_getRawTransactionByHash (2026-11-20: one.valve.city), and *_TX_LABEL to what the files record.
fetch_all_transactions() {
  local ethereum="${ETHEREUM_TX_EXECUTION:-${ethereum_execution}}" pulsechain="${PULSECHAIN_TX_EXECUTION:-${pulsechain_execution}}"
  local ethereum_label="${ETHEREUM_TX_LABEL:-${ethereum}}" pulsechain_label="${PULSECHAIN_TX_LABEL:-${pulsechain}}"
  fetch_transactions "${ethereum}" "${ethereum_label}" "${fixtures}/ethereum/execution_block.json"
  local block
  for block in "${fixtures}/pulsechain/execution_block.json" "${fixtures}"/pulsechain/path_*_block.json; do
    fetch_transactions "${pulsechain}" "${pulsechain_label}" "${block}"
  done
}

case "${1:-all}" in
  ethereum) fetch_ethereum ;;
  pulsechain) fetch_pulsechain ;;
  path-blocks) fetch_path_blocks ;;
  historical) fetch_historical ;;
  transactions) fetch_all_transactions ;;
  all) fetch_ethereum; fetch_pulsechain; fetch_all_transactions ;;
  *) echo "usage: $0 ethereum|pulsechain|path-blocks|historical|transactions|all"; exit 2 ;;
esac
