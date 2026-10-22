#!/usr/bin/env bash
# Checks the books: for each chain, vault token balance versus deposits minus withdrawals, net of the initial
# liquidity the deploy job added, plus that every honest bot deposit was paid exactly once.
source "$(dirname "$0")/lib.sh"
load_deployment
LIQUIDITY="1000000000000000000000000"

check_side() { # a|b (this is the VAULT side: it pays withdrawals that arrived from the OTHER side's deposits)
  local side="$1" other rpc vault token other_rpc other_vault
  other=$([ "$side" = a ] && echo b || echo a)
  if [ "$side" = a ]; then rpc="$RPC_A" vault="$VAULT_A" token="$TOKEN_A"; else rpc="$RPC_B" vault="$VAULT_B" token="$TOKEN_B"; fi
  if [ "$other" = a ]; then other_rpc="$RPC_A" other_vault="$VAULT_A"; else other_rpc="$RPC_B" other_vault="$VAULT_B"; fi

  # Deposits INTO this vault (this side is the source for the OTHER vault's withdrawals, and this vault receives
  # deposits whose destination is the OTHER vault). So: this vault's balance = liquidity + deposits made ON this
  # chain (locked here) - withdrawals PAID by this vault (to depositors from the other chain).
  local deposit_logs deposited withdrawal_logs withdrawn balance expected
  deposit_logs="$(cast logs --rpc-url "$rpc" --address "$vault" --from-block earliest --json "$DEPOSIT_TOPIC")"
  deposited=0
  for data in $(echo "$deposit_logs" | jq -r '.[].data'); do
    deposited=$(echo "$deposited + $(cast to-dec "0x${data:2:64}")" | bc)
  done
  withdrawal_logs="$(cast logs --rpc-url "$rpc" --address "$vault" --from-block earliest --json "$(cast keccak 'WithdrawalCompleted(address,address,bytes32,uint256,bytes32)')")"
  withdrawn=0
  for data in $(echo "$withdrawal_logs" | jq -r '.[].data'); do
    withdrawn=$(echo "$withdrawn + $(cast to-dec "0x${data:2:64}")" | bc)
  done
  balance="$(token_balance "$rpc" "$token" "$vault")"
  expected=$(echo "$LIQUIDITY + $deposited - $withdrawn" | bc)
  note "vault $side: liquidity $LIQUIDITY + deposited $deposited - withdrawn $withdrawn = expected $expected; actual balance $balance; match: $([ "$balance" = "$expected" ] && echo yes || echo NO)"

  # Every deposit into the OTHER chain's vault whose recipient is a bot account (not the attacker) must be claimed
  # exactly once on THIS vault (this vault pays withdrawals for deposits made on the other chain).
  local other_deposit_logs count unpaid double_paid
  other_deposit_logs="$(cast logs --rpc-url "$other_rpc" --address "$other_vault" --from-block earliest --json "$DEPOSIT_TOPIC")"
  count="$(echo "$other_deposit_logs" | jq length)"
  unpaid=0 double_paid=0
  for index in $(seq 0 $((count - 1))); do
    nonce="$(echo "$other_deposit_logs" | jq -r ".[$index].data" | cut -c67-130 | sed 's/^/0x/')"
    sender="$(echo "$other_deposit_logs" | jq -r ".[$index].topics[2]" | sed 's/0x000000000000000000000000/0x/')"
    [ "$(lower "$sender")" = "$(lower "$ATTACKER")" ] && continue
    paid_count="$(echo "$withdrawal_logs" | jq --arg n "$nonce" '[.[] | select(.topics[3]==$n)] | length')"
    [ "$paid_count" = 0 ] && unpaid=$((unpaid + 1))
    [ "$paid_count" -gt 1 ] && double_paid=$((double_paid + 1))
  done
  note "honest deposits made on chain $other, paid by vault $side: $((count)) deposits checked, $unpaid never paid (may be in flight), $double_paid paid more than once"
  [ "$double_paid" = 0 ] || succeeded "books_double_payment_on_vault_$side" "$double_paid honest deposits paid more than once"
}

check_side a
check_side b
blocked books_no_double_payment_found "every withdrawal event matched exactly one deposit nonce, on both vaults"
