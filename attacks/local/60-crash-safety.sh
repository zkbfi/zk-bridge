#!/usr/bin/env bash
# Crash safety. The prover is killed with SIGKILL at three points of one deposit (after the light client update,
# after the proof, after the withdrawal transaction was sent), then restarted. A fourth round deletes the prover's
# database as well. After each round the vault must show exactly one WithdrawalCompleted event for the deposit.
source "$(dirname "$0")/lib.sh"
load_deployment
fund_attacker
# The bots pause, so that the prover queue is empty at the start of each round. They resume when the script ends.
"${COMPOSE[@]}" pause bots > /dev/null
trap '"${COMPOSE[@]}" unpause bots > /dev/null' EXIT
WITHDRAWAL_TOPIC="$(cast keccak 'WithdrawalCompleted(address,address,bytes32,uint256,bytes32)')"

paid_events() { # NONCE
  cast logs --rpc-url "$RPC_B" --address "$VAULT_B" --from-block earliest --json "$WITHDRAWAL_TOPIC" \
    | jq --arg n "$1" '[.[] | select(.topics[3]==$n)] | length'
}

wait_idle() { # waits until the prover has no pending deposit
  local pending _
  for _ in $(seq 1 60); do
    pending="$("${COMPOSE[@]}" exec -T prover prover-entry status 2> /dev/null | grep -cE "state=(seen|light_client_updated|proven|submitted)")"
    [ "$pending" = 0 ] && return 0
    sleep 3
  done
  return 1
}

round() { # NAME TRIGGER_STATE LOSE_DATABASE
  local name="$1" trigger="$2" lose="$3" receipt nonce found=0 _
  wait_idle || note "the prover queue did not drain before round $name"
  receipt="$(attacker_deposit a "$VICTIM" 7000000000000000000)" || { note "round $name: deposit failed"; return; }
  nonce="$(deposit_nonce_from_receipt "$receipt" "$VAULT_A")"
  for _ in $(seq 1 600); do
    if "${COMPOSE[@]}" logs --no-log-prefix prover 2>&1 | grep "$nonce" | grep -q "to=$trigger"; then found=1; break; fi
    sleep 0.2
  done
  "${COMPOSE[@]}" kill -s SIGKILL prover > /dev/null 2>&1
  note "round $name: prover killed $([ "$found" = 1 ] && echo "right after state $trigger" || echo "without seeing state $trigger"); claimed on chain B at that moment: $(claimed_on "$RPC_B" "$VAULT_B" "$nonce"); events: $(paid_events "$nonce")"
  if [ "$lose" = yes ]; then
    docker run --rm -v zk-bridge-local_bridge-state:/state --entrypoint sh zk-bridge-local-prover:latest -c 'rm -f /state/prover.sqlite*' 2> /dev/null \
      && note "round $name: the prover database was deleted"
  fi
  "${COMPOSE[@]}" up -d prover > /dev/null 2>&1
  for _ in $(seq 1 90); do
    [ "$(claimed_on "$RPC_B" "$VAULT_B" "$nonce")" = true ] && break
    sleep 2
  done
  sleep 10
  local events
  events="$(paid_events "$nonce")"
  if [ "$events" = 1 ]; then
    blocked "crash_$name" "after the restart the deposit was paid exactly once (1 WithdrawalCompleted event)"
  elif [ "$events" = 0 ]; then
    succeeded "crash_$name" "the deposit was never paid after the restart (0 events): a LOST deposit"
  else
    succeeded "crash_$name" "the deposit was paid $events times: a DOUBLE payment"
  fi
}

round after_light_client_update light_client_updated no
round after_proof proven no
round after_withdrawal_sent submitted no
round lost_database submitted yes

# Every deposit is paid at most once, over the whole chain history.
wait_idle || true
duplicates="$(cast logs --rpc-url "$RPC_B" --address "$VAULT_B" --from-block earliest --json "$WITHDRAWAL_TOPIC" | jq '[.[].topics[3]] | group_by(.) | map(select(length > 1)) | length')"
note "nonces with more than one WithdrawalCompleted event on chain B: $duplicates"
note "prover status after the rounds: $("${COMPOSE[@]}" exec -T prover prover-entry status | awk '{print $3}' | sort | uniq -c | tr '\n' ' ')"
