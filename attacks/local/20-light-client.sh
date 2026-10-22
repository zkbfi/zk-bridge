#!/usr/bin/env bash
# Attacks on BeaconLightClient.update, on the light client of chain B (it tracks chain A).
#
# The oracle verifier accepts a signature by Anvil account 1, a public development key. The suite holds that key, so
# it can sign any statement. This models a proof system that has a proof for a false statement, which a sound system
# never has. So the attacks that need a valid proof test the checks of the CONTRACT, in the order the contract runs
# them, and every one of them is an eth_call: no attack here changes the light client.
source "$(dirname "$0")/lib.sh"
load_deployment

LC="$LC_B"
RPC="$RPC_B"
head="$(cast call "$LC" 'head()(uint64)' --rpc-url "$RPC" | awk '{print $1}')"
head_root="$(cast call "$LC" 'headers(uint64)(bytes32)' "$head" --rpc-url "$RPC")"
period_length="$(cast call "$LC" 'slotsPerPeriod()(uint64)' --rpc-url "$RPC" | awk '{print $1}')"
head_period=$((head / period_length))
committee="$(cast call "$LC" 'syncCommittees(uint64)(bytes32)' "$head_period" --rpc-url "$RPC")"
next_committee="$(cast call "$LC" 'syncCommittees(uint64)(bytes32)' $((head_period + 1)) --rpc-url "$RPC")"
genesis_root="$(cast call "$LC" 'genesisValidatorsRoot()(bytes32)' --rpc-url "$RPC")"
other_genesis_root="$(cast call "$LC_A" 'genesisValidatorsRoot()(bytes32)' --rpc-url "$RPC_A")"
program_key="$(cast call "$LC" 'programVKey()(bytes32)' --rpc-url "$RPC")"
genesis_time="$(cast call "$LC" 'genesisTime()(uint64)' --rpc-url "$RPC" | awk '{print $1}')"
seconds_per_slot="$(cast call "$LC" 'secondsPerSlot()(uint64)' --rpc-url "$RPC" | awk '{print $1}')"
block_time="$(cast block latest --field timestamp --rpc-url "$RPC")"
current_slot=$(((block_time - genesis_time) / seconds_per_slot))
note "light client B: head $head, period $head_period, current slot $current_slot, genesis root $genesis_root (chain A), light client A tracks $other_genesis_root"
ZERO="0x0000000000000000000000000000000000000000000000000000000000000000"
FORGED_ROOT="$(cast keccak forged-header)"
FORGED_EXECUTION="$(cast keccak forged-execution)"
FORGED_COMMITTEE="$(cast keccak forged-committee)"

# public_values GENESIS PREV_ROOT PREV_SLOT PREV_COMMITTEE START_NEXT NEW_ROOT NEW_SLOT EXEC_HASH EXEC_NUMBER COMMITTEE NEXT
public_values() {
  cast abi-encode 'f(bytes32,bytes32,uint64,bytes32,bytes32,bytes32,uint64,bytes32,uint64,bytes32,bytes32)' "$@"
}

# honest_values NEW_SLOT builds public values that follow the stored state, with forged contents.
honest_values() {
  public_values "$genesis_root" "$head_root" "$head" "$committee" "$next_committee" "$FORGED_ROOT" "$1" "$FORGED_EXECUTION" 1 "$committee" "$ZERO"
}

# oracle_signature PUBLIC_VALUES prints the oracle signature for the values, as the oracle verifier wants it.
oracle_signature() {
  local values="$1" digest sha
  sha="$(echo -n "${values#0x}" | xxd -r -p | shasum -a 256 | cut -d' ' -f1)"
  digest="$(cast keccak "0x${program_key#0x}${sha}")"
  cast wallet sign --no-hash --mnemonic "$MNEMONIC" --mnemonic-index 1 "$digest"
}

# attacker_signature PUBLIC_VALUES: the same digest, signed by a key that is not the oracle.
attacker_signature() {
  local values="$1" digest sha
  sha="$(echo -n "${values#0x}" | xxd -r -p | shasum -a 256 | cut -d' ' -f1)"
  digest="$(cast keccak "0x${program_key#0x}${sha}")"
  cast wallet sign --no-hash --mnemonic "$MNEMONIC" --mnemonic-index 9 "$digest"
}

# report_update NAME PROOF VALUES [TARGET_LIGHT_CLIENT] [TARGET_RPC]
report_update() {
  local name="$1" proof="$2" values="$3" target="${4:-$LC}" rpc="${5:-$RPC}"
  if call_raw "$rpc" "$ATTACKER" "$target" "$(calldata 'update(bytes,bytes)' "$proof" "$values")"; then
    succeeded "$name" "eth_call returned success; the light client would move its head"
    return
  fi
  blocked "$name" "$CALL_REASON"
}

next_slot=$((head + 1))
values="$(honest_values "$next_slot")"
good_signature="$(oracle_signature "$values")"

# ---- proofs that are garbage
report_update lc_garbage_proof_empty "0x" "$values"
report_update lc_garbage_proof_random_65_bytes "0x$(cast keccak a | cut -c3-)$(cast keccak b | cut -c3-)aa" "$values"
report_update lc_garbage_proof_64_bytes "0x$(cast keccak a | cut -c3-)$(cast keccak b | cut -c3-)" "$values"
report_update lc_garbage_proof_zero_signature "0x$(printf '00%.0s' $(seq 1 65))" "$values"
report_update lc_signature_by_non_oracle_key "$(attacker_signature "$values")" "$values"
report_update lc_signature_for_other_values "$good_signature" "$(honest_values $((head + 2)))"
report_update lc_public_values_wrong_length "$good_signature" "0x1234"
report_update lc_public_values_empty "$good_signature" "0x"

# ---- the contract checks, with a signature that the verifier accepts
report_update lc_head_not_advancing_same_slot "$(oracle_signature "$(honest_values "$head")")" "$(honest_values "$head")"
future_slot=$((current_slot + 1000))
report_update lc_head_in_future "$(oracle_signature "$(honest_values "$future_slot")")" "$(honest_values "$future_slot")"
report_update lc_head_in_future_by_one_slot "$(oracle_signature "$(honest_values $((current_slot + 1)))")" "$(honest_values $((current_slot + 1)))"

stale="$(public_values "$genesis_root" "$head_root" $((head - 4)) "$committee" "$next_committee" "$FORGED_ROOT" "$next_slot" "$FORGED_EXECUTION" 1 "$committee" "$ZERO")"
report_update lc_stale_previous_head_slot "$(oracle_signature "$stale")" "$stale"
wrong_root="$(public_values "$genesis_root" "$(cast keccak other)" "$head" "$committee" "$next_committee" "$FORGED_ROOT" "$next_slot" "$FORGED_EXECUTION" 1 "$committee" "$ZERO")"
report_update lc_wrong_previous_header_root "$(oracle_signature "$wrong_root")" "$wrong_root"
wrong_previous="$(public_values "$genesis_root" "$head_root" "$head" "$FORGED_COMMITTEE" "$next_committee" "$FORGED_ROOT" "$next_slot" "$FORGED_EXECUTION" 1 "$committee" "$ZERO")"
report_update lc_wrong_previous_committee "$(oracle_signature "$wrong_previous")" "$wrong_previous"
wrong_start="$(public_values "$genesis_root" "$head_root" "$head" "$committee" "$FORGED_COMMITTEE" "$FORGED_ROOT" "$next_slot" "$FORGED_EXECUTION" 1 "$committee" "$ZERO")"
report_update lc_wrong_start_next_committee "$(oracle_signature "$wrong_start")" "$wrong_start"

other_chain="$(public_values "$other_genesis_root" "$head_root" "$head" "$committee" "$next_committee" "$FORGED_ROOT" "$next_slot" "$FORGED_EXECUTION" 1 "$committee" "$ZERO")"
report_update lc_update_signed_for_the_other_chain "$(oracle_signature "$other_chain")" "$other_chain"

zero_root="$(public_values "$genesis_root" "$head_root" "$head" "$committee" "$next_committee" "$ZERO" "$next_slot" "$FORGED_EXECUTION" 1 "$committee" "$ZERO")"
report_update lc_zero_header_root "$(oracle_signature "$zero_root")" "$zero_root"
zero_execution="$(public_values "$genesis_root" "$head_root" "$head" "$committee" "$next_committee" "$FORGED_ROOT" "$next_slot" "$ZERO" 1 "$committee" "$ZERO")"
report_update lc_zero_execution_block_hash "$(oracle_signature "$zero_execution")" "$zero_execution"
zero_committee="$(public_values "$genesis_root" "$head_root" "$head" "$committee" "$next_committee" "$FORGED_ROOT" "$next_slot" "$FORGED_EXECUTION" 1 "$ZERO" "$ZERO")"
report_update lc_zero_committee "$(oracle_signature "$zero_committee")" "$zero_committee"
swapped="$(public_values "$genesis_root" "$head_root" "$head" "$committee" "$next_committee" "$FORGED_ROOT" "$next_slot" "$FORGED_EXECUTION" 1 "$FORGED_COMMITTEE" "$ZERO")"
report_update lc_committee_swap_in_same_period "$(oracle_signature "$swapped")" "$swapped"
forged_next="$(public_values "$genesis_root" "$head_root" "$head" "$committee" "$next_committee" "$FORGED_ROOT" "$next_slot" "$FORGED_EXECUTION" 1 "$committee" "$FORGED_COMMITTEE")"
report_update lc_next_committee_forged "$(oracle_signature "$forged_next")" "$forged_next"

# ---- replays of real updates
heads="$(cast logs --rpc-url "$RPC" --address "$LC" --from-block earliest --json "$(cast keccak 'HeadUpdated(uint64,bytes32,bytes32)')")"
count="$(echo "$heads" | jq length)"
note "light client B has $count stored heads"
replay() { # NAME LOG_INDEX
  local transaction input
  transaction="$(echo "$heads" | jq -r ".[$2].transactionHash")"
  input="$(cast rpc eth_getTransactionByHash "$transaction" --rpc-url "$RPC" | jq -r .input)"
  if call_raw "$RPC" "$ATTACKER" "$LC" "$input"; then
    succeeded "$1" "eth_call returned success: the replayed update would be accepted"
  else
    blocked "$1" "$CALL_REASON"
  fi
}
replay lc_replay_earliest_signed_update 0
replay lc_replay_latest_signed_update $((count - 1))
# An update that the light client of chain A accepted, sent to the light client of chain B.
heads_a="$(cast logs --rpc-url "$RPC_A" --address "$LC_A" --from-block earliest --json "$(cast keccak 'HeadUpdated(uint64,bytes32,bytes32)')")"
transaction="$(echo "$heads_a" | jq -r ".[-1].transactionHash")"
input="$(cast rpc eth_getTransactionByHash "$transaction" --rpc-url "$RPC_A" | jq -r .input)"
if call_raw "$RPC" "$ATTACKER" "$LC" "$input"; then
  succeeded lc_replay_update_of_the_other_chain "eth_call returned success"
else
  blocked lc_replay_update_of_the_other_chain "$CALL_REASON"
fi

# ---- the structural attacks that only the proof system can stop
note "the next two results depend on the oracle key being public, so a success is an artefact of the local setup"
report_update lc_oracle_signed_forged_head_artefact "$good_signature" "$values"
# One period ahead: the next committee is stored, so a forged committee must match it.
near_slot=$((head + period_length))
near_values="$(public_values "$genesis_root" "$head_root" "$head" "$committee" "$next_committee" "$FORGED_ROOT" "$near_slot" "$FORGED_EXECUTION" 1 "$FORGED_COMMITTEE" "$ZERO")"
report_update lc_new_period_with_forged_committee_when_next_is_stored "$(oracle_signature "$near_values")" "$near_values"
# Two periods ahead: no committee is stored for that period, so the contract writes the committee of the output.
# Only the proof system can stop this one.
far_slot=$((head + 2 * period_length))
far_values="$(public_values "$genesis_root" "$head_root" "$head" "$committee" "$next_committee" "$FORGED_ROOT" "$far_slot" "$FORGED_EXECUTION" 1 "$FORGED_COMMITTEE" "$ZERO")"
report_update lc_oracle_signed_forged_committee_two_periods_ahead_artefact "$(oracle_signature "$far_values")" "$far_values"
