#!/usr/bin/env bash
# Prover griefing: a burst of 1-wei deposits on chain A, while honest bot traffic keeps running.
# Checks: honest deposits still get paid, and what the burst costs the prover in light-client updates.
source "$(dirname "$0")/lib.sh"
load_deployment
fund_attacker

BURST=25
WITHDRAWAL_TOPIC="$(cast keccak 'WithdrawalCompleted(address,address,bytes32,uint256,bytes32)')"

# latency_report: for every a_to_b deposit by an honest sender, the seconds from the deposit block to the block of its
# withdrawal, grouped by when the deposit was made relative to the attacker burst (the window between the first and
# the last attacker deposit). Reads only the chains.
mean() { if [ "$2" -gt 0 ]; then echo $(($1 / $2)); else echo 0; fi; }

latency_report() {
  local deposits withdrawals window_start window_end
  deposits="$(cast logs --rpc-url "$RPC_A" --address "$VAULT_A" --from-block earliest --json "$DEPOSIT_TOPIC")"
  withdrawals="$(cast logs --rpc-url "$RPC_B" --address "$VAULT_B" --from-block earliest --json "$WITHDRAWAL_TOPIC")"
  local attacker_blocks
  attacker_blocks="$(echo "$deposits" | jq -r --arg a "$(lower "$ATTACKER")" '[.[] | select((.topics[2] | ascii_downcase | sub("0x000000000000000000000000";"0x"))==$a) | .blockNumber][]' \
    | while read -r hex; do printf '%d\n' "$hex"; done | sort -n | tail -n "$BURST" | sed -n '1p;$p' | tr '\n' '\t')"
  note "burst window, first and last attacker deposit block: $attacker_blocks"
  local first_block last_block
  first_block="$(echo "$attacker_blocks" | cut -f1)"
  last_block="$(echo "$attacker_blocks" | cut -f2)"
  local count index before_sum=0 before_n=0 during_sum=0 during_n=0 after_sum=0 after_n=0 worst=0
  count="$(echo "$deposits" | jq length)"
  for index in $(seq 0 $((count - 1))); do
    local sender nonce block paid_block deposit_time paid_time latency
    sender="$(echo "$deposits" | jq -r ".[$index].topics[2]" | sed 's/0x000000000000000000000000/0x/')"
    [ "$(lower "$sender")" = "$(lower "$ATTACKER")" ] && continue
    nonce="$(echo "$deposits" | jq -r ".[$index].data" | cut -c67-130 | sed 's/^/0x/')"
    paid_block="$(echo "$withdrawals" | jq -r --arg n "$nonce" '[.[] | select(.topics[3]==$n)][0].blockNumber // empty')"
    [ -z "$paid_block" ] && continue
    block="$(echo "$deposits" | jq -r ".[$index].blockNumber")"
    deposit_time="$(cast block "$((block))" --field timestamp --rpc-url "$RPC_A")"
    paid_time="$(cast block "$((paid_block))" --field timestamp --rpc-url "$RPC_B")"
    latency=$((paid_time - deposit_time))
    if [ "$((block))" -lt "$((first_block))" ]; then before_sum=$((before_sum + latency)); before_n=$((before_n + 1))
    elif [ "$((block))" -le "$((last_block))" ]; then during_sum=$((during_sum + latency)); during_n=$((during_n + 1))
    else after_sum=$((after_sum + latency)); after_n=$((after_n + 1)); fi
    [ "$latency" -gt "$worst" ] && worst="$latency"
  done
  note "honest a_to_b deposits, mean seconds from deposit to payment: before the burst ${before_n} deposits mean $(mean "$before_sum" "$before_n"); during ${during_n} deposits mean $(mean "$during_sum" "$during_n"); after ${after_n} deposits mean $(mean "$after_sum" "$after_n"); worst $worst"
  echo "$before_n $(mean "$before_sum" "$before_n") $during_n $(mean "$during_sum" "$during_n") $after_n $(mean "$after_sum" "$after_n") $worst"
}

if [ -z "${ANALYSE_ONLY:-}" ]; then
  note "sending a burst of $BURST 1-wei deposits a_to_b while the bots keep depositing"
  start_balance="$(cast balance "$PROVER_ACCOUNT" --rpc-url "$RPC_B")"
  sent=0
  for i in $(seq 1 "$BURST"); do
    wait_gate_confirmed "$RPC_A" "$GATE_A"
    hash="$(send_raw "$RPC_A" "$ATTACKER" "$VAULT_A" "$(deposit_data "$TOKEN_A" "$ATTACKER" 1)" 0x7a1200)"
    [[ "$hash" == 0x* ]] && sent=$((sent + 1))
  done
  note "sent $sent of $BURST 1-wei deposit transactions"
  note "waiting up to 240 seconds for the prover to clear its queue"
  for _ in $(seq 1 48); do
    pending="$("${COMPOSE[@]}" exec -T prover prover-entry status | grep -cE "state=(seen|light_client_updated|proven|submitted)")"
    [ "$pending" -le 1 ] && break
    sleep 5
  done
  end_balance="$(cast balance "$PROVER_ACCOUNT" --rpc-url "$RPC_B")"
  note "prover balance on chain B: $start_balance -> $end_balance (wei), a spend of $(echo "$start_balance - $end_balance" | bc) wei; the prover also pays for light-client updates on chain B only for this direction, and for its own light client updates on chain A"
fi
latency_report
