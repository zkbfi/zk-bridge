#!/usr/bin/env bash
# Reorg on chain A (the source of a_to_b deposits), with Anvil's evm_snapshot / evm_revert.
#
# IMPORTANT CAVEAT, reported again in docs/local-attack-report.md: the local development beacon source
# (prover/src/beacon/dev.rs, config kind "dev") treats a block as final once it is `finality_depth` blocks below the
# chain head (2, from docker/deploy.sh). It builds its synthetic beacon chain over whatever the execution chain
# reports at that moment, and it never re-checks a block it already used. On a real beacon chain, finality comes from
# a justified-then-finalized checkpoint that two-thirds of the validator set signs; this never un-does. The dev source
# has no such mechanism, so if this script makes the prover treat a reorged block as final and act on it, that is an
# artefact of the local depth rule standing in for a beacon chain, not a hole in BeaconLightClient or BridgeVault.
source "$(dirname "$0")/lib.sh"
load_deployment
fund_attacker
# The bots pause, so that no honest transaction sits in the blocks that the revert removes.
"${COMPOSE[@]}" pause bots > /dev/null 2>&1
trap '"${COMPOSE[@]}" unpause bots > /dev/null 2>&1' EXIT

# ---- round 1: revert a deposit before the prover has covered it (right after it is seen, before finality_depth=2
# more blocks are mined, so before the dev source would call it final)
snapshot="$(cast rpc evm_snapshot --rpc-url "$RPC_A" | tr -d '"')"
receipt="$(attacker_deposit a "$VICTIM" 3000000000000000000)" || fail_setup "could not make the reorg probe deposit"
tx1="$(echo "$receipt" | jq -r .transactionHash)"
nonce1="$(deposit_nonce_from_receipt "$receipt" "$VAULT_A")"
note "round 1: deposit $nonce1 mined in transaction $tx1, then immediately reverted with evm_revert"
reverted="$(cast rpc evm_revert "$snapshot" --rpc-url "$RPC_A")"
note "evm_revert returned $reverted"
receipt_after="$(cast rpc eth_getTransactionReceipt "$tx1" --rpc-url "$RPC_A")"
note "the deposit transaction after the revert: $(echo "$receipt_after" | jq -c .)"
sleep 10
state_line="$("${COMPOSE[@]}" exec -T prover prover-entry status | grep "$nonce1" || true)"
note "prover status for $nonce1 after the revert: ${state_line:-not tracked}"
paid1="$(claimed_on "$RPC_B" "$VAULT_B" "$nonce1" 2> /dev/null || echo false)"
if [ "$paid1" = true ]; then
  succeeded reorg_before_finality "the vault paid a deposit whose block was reverted before the dev source called it final; claimed($nonce1)=true"
else
  blocked reorg_before_finality "claimed($nonce1)=$paid1; the deposit transaction no longer exists after the revert: $(echo "$receipt_after" | jq -r .)"
fi

# ---- round 2: revert chain A after the deposit was paid on chain B. On a real chain this cannot happen to a final block.
# Here the dev source called the block final after 2 blocks, so the prover paid it. The snapshot comes BEFORE the deposit.
snapshot2="$(cast rpc evm_snapshot --rpc-url "$RPC_A" | tr -d '"')"
amount2="2000000000000000000"
balance_a_before="$(token_balance "$RPC_A" "$TOKEN_A" "$ATTACKER")"
vault_a_before="$(token_balance "$RPC_A" "$TOKEN_A" "$VAULT_A")"
receipt2="$(attacker_deposit a "$VICTIM" "$amount2")" || fail_setup "could not make the second reorg probe deposit"
tx2="$(echo "$receipt2" | jq -r .transactionHash)"
nonce2="$(deposit_nonce_from_receipt "$receipt2" "$VAULT_A")"
note "round 2: deposit $nonce2 in transaction $tx2; waiting up to 120 seconds for the prover to pay it on chain B"
deadline=$(( $(date +%s) + 120 ))
while [ "$(date +%s)" -lt "$deadline" ]; do
  [ "$(claimed_on "$RPC_B" "$VAULT_B" "$nonce2")" = true ] && break
  sleep 2
done
if [ "$(claimed_on "$RPC_B" "$VAULT_B" "$nonce2")" != true ]; then
  note "round 2 skipped: the deposit was not paid within 120 seconds"
else
  victim_b_before="$(token_balance "$RPC_B" "$TOKEN_B" "$VICTIM")"
  reverted2="$(cast rpc evm_revert "$snapshot2" --rpc-url "$RPC_A")"
  note "evm_revert returned $reverted2; transaction $tx2 on chain A afterwards: $(cast rpc eth_getTransactionReceipt "$tx2" --rpc-url "$RPC_A" | jq -c .)"
  balance_a_after="$(token_balance "$RPC_A" "$TOKEN_A" "$ATTACKER")"
  vault_a_after="$(token_balance "$RPC_A" "$TOKEN_A" "$VAULT_A")"
  note "chain A after the revert: attacker token balance $balance_a_before -> $balance_a_after; vault A token balance $vault_a_before -> $vault_a_after"
  note "chain B: claimed=$(claimed_on "$RPC_B" "$VAULT_B" "$nonce2"), victim holds $victim_b_before (the payout of the vanished deposit stays)"
  succeeded reorg_after_payment_double_spend_artefact "the deposit vanished from chain A (the attacker keeps the tokens: $balance_a_after) while chain B kept the payout of $amount2 to the victim. Needs a reorg of a block that the dev source called final. ARTEFACT of the dev depth rule; a real beacon chain finalizes with two-thirds of the stake, so the light client never stores a header that can be reorged"
  # The nonce is keccak(chain id, vault, depositCount). The revert reset depositCount, so the next deposit repeats the claimed nonce.
  sleep 4
  receipt3="$(attacker_deposit a "$VICTIM" 1000000000000000000)" || fail_setup "could not make the third probe deposit"
  nonce3="$(deposit_nonce_from_receipt "$receipt3" "$VAULT_A")"
  note "round 3: the next deposit after the revert has nonce $nonce3; it equals the claimed nonce of round 2: $([ "$nonce3" = "$nonce2" ] && echo yes || echo no)"
  sleep 60
  note "round 3: claimed events on chain B for that nonce: $(cast logs --rpc-url "$RPC_B" --address "$VAULT_B" --from-block earliest --json "$(cast keccak 'WithdrawalCompleted(address,address,bytes32,uint256,bytes32)')" | jq --arg n "$nonce3" '[.[] | select(.topics[3]==$n)] | length'); prover state: $("${COMPOSE[@]}" exec -T prover prover-entry status | grep "$nonce3" | sed -E 's/.*(state=[a-z_]+).*(attempts=[0-9]+).*/\1 \2/' | tr '\n' ' ')"
fi

note "both rounds depend on the local dev beacon source, which treats a block as final 2 blocks below the head; see the header comment of this script."
