#!/usr/bin/env bash
# Attacks on BeaconForkGate (the deposit gate of chain A runs in Enforcing mode; chain B has no beacon roots).
#
# The real gate of chain A accepts an empty proof after the bots confirm the epoch, so a "no evidence" attack on it
# only works in the few seconds after an epoch starts. So the suite also deploys a PROBE gate on chain A with the same
# configuration. Nobody confirms the probe gate, so it shows the refusal at any time. It reads the same beacon roots.
# seal() and admit() calls on the real gates are eth_calls: they change nothing.
source "$(dirname "$0")/lib.sh"
load_deployment

TUPLE='(uint256,(uint64,uint64,bytes32,bytes32,bytes32),bytes4,bytes32[])'

report_gate() { # NAME TARGET RPC DATA
  if call_raw "$3" "$ATTACKER" "$2" "$4"; then
    succeeded "$1" "eth_call returned success"
  else
    blocked "$1" "$CALL_REASON"
  fi
}

# evidence_of TRANSACTION prints the gate evidence in the calldata of a deposit transaction on chain A.
evidence_of() {
  local input
  input="$(cast rpc eth_getTransactionByHash "$1" --rpc-url "$RPC_A" | jq -r .input)"
  cast decode-calldata 'deposit(address,address,uint256,uint16,bytes)' "$input" | tail -1
}

# mutate EVIDENCE KIND prints the evidence with one forged field.
mutate() {
  local text
  text="$(cast abi-decode --input "x($TUPLE)" "$1" | sed -E 's/ \[[0-9.]+e[0-9]+\]//g')"
  case "$2" in
    version_unsupported) text="$(echo "$text" | sed -E 's/, 0x0000036c, \[/, 0x0000036d, [/')" ;;
    version_previous) text="$(echo "$text" | sed -E 's/, 0x0000036c, \[/, 0x0000036b, [/')" ;;
    branch_flipped) text="$(echo "$text" | sed -E 's/\[0x0000036b/[0x0000036a/')" ;;
    header_slot) text="$(echo "$text" | sed -E 's/^\(([0-9]+), \([0-9]+,/(\1, (7,/')" ;;
    timestamp_unknown) text="$(echo "$text" | sed -E 's/^\([0-9]+,/(1,/')" ;;
    *) echo "unknown mutation $2" >&2; return 1 ;;
  esac
  cast abi-encode "x($TUPLE)" "$text"
}

# ---- gather real evidence: the newest and the oldest deposit with a fork proof
logs="$(cast logs --rpc-url "$RPC_A" --address "$VAULT_A" --from-block earliest --json "$DEPOSIT_TOPIC")"
NEW_EVIDENCE="" OLD_EVIDENCE=""
for tx in $(echo "$logs" | jq -r '.[].transactionHash'); do
  evidence="$(evidence_of "$tx")"
  [ "$evidence" = "0x" ] && continue
  [ -z "$OLD_EVIDENCE" ] && OLD_EVIDENCE="$evidence"
  NEW_EVIDENCE="$evidence"
done
[ -n "$NEW_EVIDENCE" ] && [ "$NEW_EVIDENCE" != "$OLD_EVIDENCE" ] || fail_setup "need evidence from two epochs; let the bots run longer"
note "newest evidence timestamp: $(cast abi-decode --input "x($TUPLE)" "$NEW_EVIDENCE" | sed -E 's/^\(([0-9]+).*/\1/'); oldest: $(cast abi-decode --input "x($TUPLE)" "$OLD_EVIDENCE" | sed -E 's/^\(([0-9]+).*/\1/')"

# ---- the probe gate
BEACON_ROOTS="$(cast call "$GATE_A" 'beaconRoots()(address)' --rpc-url "$RPC_A")"
PROBE="$(forge_create "$RPC_A" src/hardened/BeaconForkGate.sol:BeaconForkGate "$BEACON_ROOTS" 0 "$GATE_GENESIS_TIME" 12 32 "[(0x0000036c,5)]" "[5,6,7]" 0x0000000000000000000000000000000000000000)"
[ -n "$PROBE" ] || fail_setup "cannot deploy the probe gate"
note "probe gate on chain A: $PROBE (mode Enforcing, same versions, nobody confirms it)"
admit() { calldata 'admit(bytes)' "$1"; }

# Deposit on chain A with no evidence.
report_gate gate_deposit_no_evidence_probe_gate "$PROBE" "$RPC_A" "$(admit 0x)"
if [ "$(gate_confirmed "$RPC_A" "$GATE_A")" = no ]; then
  call_raw "$RPC_A" "$ATTACKER" "$VAULT_A" "$(deposit_data "$TOKEN_A" "$VICTIM" 1)" \
    && succeeded gate_deposit_no_evidence_real_vault "eth_call succeeded in an unconfirmed epoch" \
    || blocked gate_deposit_no_evidence_real_vault "$CALL_REASON"
else
  note "the real gate of chain A has confirmed the current epoch, so an empty proof is allowed by design; the probe gate shows the refusal"
fi

# Stale evidence and evidence of the wrong epoch.
report_gate gate_stale_evidence_old_epoch "$PROBE" "$RPC_A" "$(admit "$OLD_EVIDENCE")"
# A forged version, with the rest of the evidence valid.
report_gate gate_forged_version_unsupported_version "$PROBE" "$RPC_A" "$(admit "$(mutate "$NEW_EVIDENCE" version_unsupported)")"
report_gate gate_forged_version_previous_fork_version "$PROBE" "$RPC_A" "$(admit "$(mutate "$NEW_EVIDENCE" version_previous)")"
report_gate gate_forged_branch_node "$PROBE" "$RPC_A" "$(admit "$(mutate "$NEW_EVIDENCE" branch_flipped)")"
report_gate gate_forged_header_slot "$PROBE" "$RPC_A" "$(admit "$(mutate "$NEW_EVIDENCE" header_slot)")"
report_gate gate_forged_timestamp_with_no_beacon_root "$PROBE" "$RPC_A" "$(admit "$(mutate "$NEW_EVIDENCE" timestamp_unknown)")"
report_gate gate_garbage_evidence "$PROBE" "$RPC_A" "$(admit "0x$(cast keccak garbage | cut -c3-)")"
# Control: genuine evidence of the current epoch. Anyone may confirm a gate with it, so this is not an attack.
if call_raw "$RPC_A" "$ATTACKER" "$PROBE" "$(admit "$NEW_EVIDENCE")"; then
  note "CONTROL genuine newest evidence confirms the probe gate (eth_call success); public evidence, permissionless by design"
else
  note "CONTROL genuine newest evidence on the probe gate reverts: $CALL_REASON (the epoch may have changed)"
fi

# ---- seal() on the real gates, as eth_call
seal() { calldata 'seal(bytes)' "$1"; }
report_gate gate_seal_with_genuine_supported_version_evidence "$GATE_A" "$RPC_A" "$(seal "$NEW_EVIDENCE")"
report_gate gate_seal_with_old_header_supported_version "$GATE_A" "$RPC_A" "$(seal "$OLD_EVIDENCE")"
report_gate gate_seal_forged_unsupported_version_new_header "$GATE_A" "$RPC_A" "$(seal "$(mutate "$NEW_EVIDENCE" version_unsupported)")"
report_gate gate_seal_forged_unsupported_version_old_header "$GATE_A" "$RPC_A" "$(seal "$(mutate "$OLD_EVIDENCE" version_unsupported)")"
report_gate gate_seal_empty_evidence "$GATE_A" "$RPC_A" "$(seal 0x)"
report_gate gate_seal_chain_b_gate_with_chain_a_evidence "$GATE_B" "$RPC_B" "$(seal "$(mutate "$NEW_EVIDENCE" version_unsupported)")"
report_gate gate_confirm_chain_b_gate "$GATE_B" "$RPC_B" "$(calldata 'confirm(bytes)' "$NEW_EVIDENCE")"
report_gate gate_seal_probe_gate_old_header_unsupported_version "$PROBE" "$RPC_A" "$(seal "$(mutate "$OLD_EVIDENCE" version_unsupported)")"
note "sealing a gate needs a header in the beacon roots ring buffer whose state has an unsupported fork version; only the chain itself writes that buffer, so the suite does not forge it"
