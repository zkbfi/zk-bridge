#!/usr/bin/env bash
# Front-run that the attacker wins. The prover is frozen (docker pause) after it covered a deposit with the light
# client and before it sends the withdrawal. The attacker sends the withdrawal first. Then the prover resumes and
# finds the nonce already claimed. Checks: who is paid, how many times, and what the prover does.
source "$(dirname "$0")/lib.sh"
load_deployment
fund_attacker
"${COMPOSE[@]}" pause bots > /dev/null
trap '"${COMPOSE[@]}" unpause prover > /dev/null 2>&1; "${COMPOSE[@]}" unpause bots > /dev/null 2>&1' EXIT
WITHDRAWAL_TOPIC="$(cast keccak 'WithdrawalCompleted(address,address,bytes32,uint256,bytes32)')"

for _ in $(seq 1 60); do
  pending="$("${COMPOSE[@]}" exec -T prover prover-entry status | grep -cE "state=(seen|light_client_updated|proven|submitted)")"
  [ "$pending" = 0 ] && break
  sleep 3
done

amount="4000000000000000000"
receipt="$(attacker_deposit a "$VICTIM" "$amount")" || fail_setup "deposit failed"
tx="$(echo "$receipt" | jq -r .transactionHash)"
log="$(deposit_log_index "$receipt" "$VAULT_A")"
nonce="$(deposit_nonce_from_receipt "$receipt" "$VAULT_A")"
anchor_slot="$("$EVIDENCE_BIN" --config "$ATTACK_SCRATCH/prover.toml" --route a_to_b --tx "$tx" --log-index "$log" anchor-slot)"
# Built before coverage, on the anchor that the prover will store. The vault accepts it once that anchor is stored.
proof="$("$EVIDENCE_BIN" --config "$ATTACK_SCRATCH/prover.toml" --route a_to_b --tx "$tx" --log-index "$log" proof --assume-anchor --wait-seconds 30)" || fail_setup "cannot prebuild the proof"

# Freeze the prover as soon as the anchor of this deposit is stored on chain B.
for _ in $(seq 1 1200); do
  [ "$(cast call "$LC_B" 'headers(uint64)(bytes32)' "$anchor_slot" --rpc-url "$RPC_B")" != "0x0000000000000000000000000000000000000000000000000000000000000000" ] && break
  sleep 0.1
done
"${COMPOSE[@]}" pause prover > /dev/null
note "prover frozen after the light client stored the anchor of deposit $nonce"
# The prover adds the vault layout rows itself just before a withdrawal. The attacker adds them first.
evidence_layouts a_to_b "$tx" "$log" > "$ATTACK_SCRATCH/frontrun-layouts.txt"
while read -r layout_call; do
  send_wait "$RPC_B" "$ATTACKER" "$VAULT_B" "$layout_call" > /dev/null
done < "$ATTACK_SCRATCH/frontrun-layouts.txt"
note "before the dry run: block $(cast block-number --rpc-url "$RPC_B"), claimed=$(claimed_on "$RPC_B" "$VAULT_B" "$nonce"), prover paused=$(docker inspect -f '{{.State.Paused}}' zk-bridge-local-prover-1)"
call_raw "$RPC_B" "$ATTACKER" "$VAULT_B" "$proof" && note "dry run of the attacker withdrawal: success" || note "dry run of the attacker withdrawal: $CALL_REASON"
victim_before="$(token_balance "$RPC_B" "$TOKEN_B" "$VICTIM")"
attacker_before="$(token_balance "$RPC_B" "$TOKEN_B" "$ATTACKER")"
result="$(send_wait "$RPC_B" "$ATTACKER" "$VAULT_B" "$proof" 0x7a1200)"
note "attacker withdrawal transaction status: $(echo "$result" | jq -r .status)"
victim_after="$(token_balance "$RPC_B" "$TOKEN_B" "$VICTIM")"
attacker_after="$(token_balance "$RPC_B" "$TOKEN_B" "$ATTACKER")"
note "victim balance $victim_before -> $victim_after; attacker balance $attacker_before -> $attacker_after"
"${COMPOSE[@]}" unpause prover > /dev/null
note "prover resumed; waiting 40 seconds"
sleep 40
events="$(cast logs --rpc-url "$RPC_B" --address "$VAULT_B" --from-block earliest --json "$WITHDRAWAL_TOPIC" | jq --arg n "$nonce" '[.[] | select(.topics[3]==$n)] | length')"
prover_lines="$("${COMPOSE[@]}" logs --no-log-prefix prover 2>&1 | grep "$nonce" | grep -vE "to=seen" | cut -c1-230 | tail -4)"
echo "$prover_lines" | sed 's/^/PROVER LOG /'
paid="$(echo "$victim_after - $victim_before" | bc)"
final_state="$("${COMPOSE[@]}" exec -T prover prover-entry status | grep "$nonce" | sed -E 's/.*state=([a-z_]+).*/\1/')"
if [ "$events" = 1 ] && [ "$paid" = "$amount" ] && [ "$attacker_after" = "$attacker_before" ] && [ "$final_state" = confirmed ]; then
  blocked front_run_attacker_first_prover_second "the attacker's transaction paid the VICTIM once ($amount), the attacker gained nothing, the prover ended in state $final_state with $events payment event"
else
  succeeded front_run_attacker_first_prover_second "events=$events victim paid $paid attacker $attacker_before -> $attacker_after prover state '$final_state'"
fi
