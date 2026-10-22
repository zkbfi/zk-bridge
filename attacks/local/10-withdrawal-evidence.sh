#!/usr/bin/env bash
# Attacks on BridgeVault.withdraw: replay, wrong vault, fake emitter, tampered evidence, front-running.
# Output: one line per attack, "ATTACK name: BLOCKED (reason)" or "ATTACK name: SUCCEEDED (evidence)".
source "$(dirname "$0")/lib.sh"
load_deployment
fund_attacker

# The prover handles deposits one after another, about one every 14 seconds, and the bots deposit faster than that,
# so a queue builds up. The two time-critical attacks below (fake emitter, front-run) need coverage within minutes.
# So the bots pause for this script, the queue drains, and the bots resume when the script ends. The prover keeps
# running the whole time.
"${COMPOSE[@]}" pause bots > /dev/null
trap '"${COMPOSE[@]}" unpause bots > /dev/null' EXIT
note "bots paused while this script runs; waiting for the prover queue to drain"
for _ in $(seq 1 120); do
  pending="$("${COMPOSE[@]}" exec -T prover prover-entry status | grep -cE "state=(seen|light_client_updated|proven|submitted)")"
  [ "$pending" = 0 ] && break
  sleep 5
done
note "prover queue pending: $pending"

# report_call NAME RPC TO DATA: runs an eth_call as the attacker and reports BLOCKED or SUCCEEDED.
report_call() {
  local name="$1"
  if call_raw "$2" "$ATTACKER" "$3" "$4"; then
    succeeded "$name" "eth_call returned success; the vault would pay"
    return
  fi
  blocked "$name" "$CALL_REASON"
}

# ---- 1. the paid deposit that the other attacks reuse
read -r PAID_TX PAID_LOG PAID_NONCE PAID_RECIPIENT PAID_AMOUNT < <(paid_deposit a) || fail_setup "no paid a_to_b deposit yet"
note "paid deposit: transaction $PAID_TX log $PAID_LOG nonce $PAID_NONCE recipient $PAID_RECIPIENT"
PAID_PROOF="$(evidence_proof a_to_b "$PAID_TX" "$PAID_LOG")" || fail_setup "cannot build the honest proof"

# Control: the honest proof passes every check up to the claimed check. AlreadyClaimed is the last check before the
# transfer, so this reason proves that the evidence itself is valid and only the replay protection stops it.
if call_raw "$RPC_B" "$ATTACKER" "$VAULT_B" "$PAID_PROOF"; then
  note "CONTROL honest proof: eth_call succeeded, so the deposit was not paid yet; pick another"
else
  note "CONTROL honest proof of a paid deposit reverts with: $CALL_REASON"
fi

# ---- 2. replay: eth_call, then a real transaction, with balance checks
before_vault="$(token_balance "$RPC_B" "$TOKEN_B" "$VAULT_B")"
before_recipient="$(token_balance "$RPC_B" "$TOKEN_B" "$PAID_RECIPIENT")"
before_attacker="$(token_balance "$RPC_B" "$TOKEN_B" "$ATTACKER")"
report_call replay_paid_withdrawal_eth_call "$RPC_B" "$VAULT_B" "$PAID_PROOF"
receipt="$(send_wait "$RPC_B" "$ATTACKER" "$VAULT_B" "$PAID_PROOF" 0x7a1200)"
after_vault="$(token_balance "$RPC_B" "$TOKEN_B" "$VAULT_B")"
after_recipient="$(token_balance "$RPC_B" "$TOKEN_B" "$PAID_RECIPIENT")"
after_attacker="$(token_balance "$RPC_B" "$TOKEN_B" "$ATTACKER")"
if [ "$(echo "$receipt" | jq -r .status)" = "0x1" ] || [ "$before_vault" != "$after_vault" ] \
  || [ "$before_recipient" != "$after_recipient" ] || [ "$before_attacker" != "$after_attacker" ]; then
  succeeded replay_paid_withdrawal_transaction "status $(echo "$receipt" | jq -r .status); vault $before_vault -> $after_vault; recipient $before_recipient -> $after_recipient; attacker $before_attacker -> $after_attacker"
else
  blocked replay_paid_withdrawal_transaction "transaction $(echo "$receipt" | jq -r .transactionHash) mined with status 0x0; vault, recipient and attacker balances unchanged"
fi

# ---- 3. the evidence goes to the wrong vault
report_call wrong_vault_source_chain_vault_a "$RPC_A" "$VAULT_A" "$PAID_PROOF"

SIBLING="$(forge_create "$RPC_B" src/hardened/BridgeVault.sol:BridgeVault "$LC_B" "$CHAIN_ID_B" "$CHAIN_ID_A" "$VAULT_A" \
  "[($TOKEN_B,$TOKEN_A,18)]" "(0,0x0000000000000000000000000000000000000000,0x0000000000000000000000000000000000000000,0,0,0x0000000000000000000000000000000000000000)" 0 "$GATE_B")"
if [ -z "$SIBLING" ]; then
  note "could not deploy a sibling vault on chain B; wrong_vault_sibling skipped"
else
  note "sibling vault on chain B: $SIBLING (same light client, same remote vault, same token pair)"
  send_wait "$RPC_B" "$ATTACKER" "$TOKEN_B" "$(calldata 'mint(address,uint256)' "$SIBLING" 1000000000000000000000000)" > /dev/null
  # A fresh vault has no layout rows, so it would stop at LayoutNotValidated. Anyone may add the rows; the vault checks them.
  evidence_layouts a_to_b "$PAID_TX" "$PAID_LOG" > "$ATTACK_SCRATCH/layouts.txt"
  while read -r layout_call; do
    send_wait "$RPC_B" "$ATTACKER" "$SIBLING" "$layout_call" > /dev/null
  done < "$ATTACK_SCRATCH/layouts.txt"
  report_call wrong_vault_sibling_vault_same_chain "$RPC_B" "$SIBLING" "$PAID_PROOF"
fi

# A deposit made in the other direction goes to the vault on its own chain (its source vault).
if read -r BACK_TX BACK_LOG BACK_NONCE _ _ < <(paid_deposit b); then
  BACK_PROOF="$(evidence_proof b_to_a "$BACK_TX" "$BACK_LOG")"
  report_call wrong_vault_b_to_a_evidence_to_source_vault_b "$RPC_B" "$VAULT_B" "$BACK_PROOF"
  report_call wrong_vault_b_to_a_evidence_to_a_paid_control "$RPC_A" "$VAULT_A" "$BACK_PROOF"
fi

# ---- 4. a contract on the source chain that emits a byte-identical DepositInitiated
FAKE="$(forge_create "$RPC_A" src/mocks/FakeDepositEmitter.sol:FakeDepositEmitter)"
[ -n "$FAKE" ] || fail_setup "could not deploy the fake emitter"
FAKE_NONCE="$(cast keccak "fake-deposit-$(date +%s)")"
FAKE_AMOUNT="500000000000000000000000"
receipt="$(send_wait "$RPC_A" "$ATTACKER" "$FAKE" "$(calldata 'fakeHardenedDeposit(address,address,uint256,bytes32,uint64,address,address)' \
  "$TOKEN_A" "$ATTACKER" "$FAKE_AMOUNT" "$FAKE_NONCE" "$CHAIN_ID_B" "$VAULT_B" "$TOKEN_B")")"
FAKE_TX="$(echo "$receipt" | jq -r .transactionHash)"
fake_topic="$(echo "$receipt" | jq -r '.logs[0].topics[0]')"
fake_data="$(echo "$receipt" | jq -r '.logs[0].data')"
note "fake emitter $FAKE, transaction $FAKE_TX, topic0 equals the vault event topic: $([ "$fake_topic" = "$DEPOSIT_TOPIC" ] && echo yes || echo NO)"
real_data_length="$(( $(echo "$(cast logs --rpc-url "$RPC_A" --address "$VAULT_A" --from-block earliest --json "$DEPOSIT_TOPIC" | jq -r '.[0].data')" | wc -c) - 1 ))"
note "log data bytes: fake $(( ${#fake_data} )) characters, real $real_data_length characters"
# The prover never scans the fake emitter, so the light client has no anchor for this block until the next honest
# deposit on chain A makes it store one. So the attacker makes a real deposit after it; the builder then waits.
attacker_deposit a "$VICTIM" 1000000000000000000 > /dev/null
if FAKE_PROOF="$(evidence_proof a_to_b "$FAKE_TX" 0 240)"; then
  # The vault checks layout rows before it reads the log. Anyone may add them, so the attacker adds the rows
  # for the fake block, to get past that check and reach the emitter check.
  evidence_layouts a_to_b "$FAKE_TX" 0 > "$ATTACK_SCRATCH/fake-layouts.txt"
  while read -r layout_call; do
    send_wait "$RPC_B" "$ATTACKER" "$VAULT_B" "$layout_call" > /dev/null
  done < "$ATTACK_SCRATCH/fake-layouts.txt"
  before_attacker="$(token_balance "$RPC_B" "$TOKEN_B" "$ATTACKER")"
  report_call fake_emitter_identical_event "$RPC_B" "$VAULT_B" "$FAKE_PROOF"
  receipt="$(send_wait "$RPC_B" "$ATTACKER" "$VAULT_B" "$FAKE_PROOF" 0x7a1200)"
  after_attacker="$(token_balance "$RPC_B" "$TOKEN_B" "$ATTACKER")"
  if [ "$before_attacker" = "$after_attacker" ] && [ "$(claimed_on "$RPC_B" "$VAULT_B" "$FAKE_NONCE")" = false ]; then
    blocked fake_emitter_identical_event_transaction "transaction mined with status $(echo "$receipt" | jq -r .status); attacker balance unchanged $after_attacker; nonce still unclaimed"
  else
    succeeded fake_emitter_identical_event_transaction "attacker balance $before_attacker -> $after_attacker; claimed($FAKE_NONCE)=$(claimed_on "$RPC_B" "$VAULT_B" "$FAKE_NONCE")"
  fi
else
  note "no anchor covered the fake deposit block within 120 seconds; fake_emitter attack not run"
fi

# ---- 5. tampered evidence: field edits and forged receipts, tried against the paid deposit
VARIANTS="$ATTACK_SCRATCH/variants.tsv"
evidence_variants a_to_b "$PAID_TX" "$PAID_LOG" "$VARIANTS" || fail_setup "cannot build the variants"
while IFS=$'\t' read -r name data; do
  if call_raw "$RPC_B" "$ATTACKER" "$VAULT_B" "$data"; then
    succeeded "tamper_$name" "eth_call returned success; the vault would pay"
    continue
  fi
  case "$CALL_REASON" in
    AlreadyClaimed*) succeeded "tamper_$name" "the vault accepted the tampered evidence: it passed every check and stopped only at AlreadyClaimed" ;;
    *) blocked "tamper_$name" "$CALL_REASON" ;;
  esac
done < "$VARIANTS"

# ---- 6. front-running: the attacker deposits for a victim, then races the prover to the withdrawal
frontrun_round() {
  local round="$1" receipt tx log nonce amount="5000000000000000000" proof
  receipt="$(attacker_deposit a "$VICTIM" "$amount")" || { note "front-run round $round: deposit failed"; return 1; }
  tx="$(echo "$receipt" | jq -r .transactionHash)"
  log="$(deposit_log_index "$receipt" "$VAULT_A")"
  nonce="$(deposit_nonce_from_receipt "$receipt" "$VAULT_A")"
  # The recipient is the depositor's own choice (VICTIM), fixed inside the proven evidence: whoever submits
  # the withdrawal, the payout goes to VICTIM, never to the submitter. So the race decides WHO PAYS GAS to submit,
  # not who gets the funds. The only thing that could go wrong is a double payment.
  local anchor_slot
  anchor_slot="$("$EVIDENCE_BIN" --config "$ATTACK_SCRATCH/prover.toml" --route a_to_b --tx "$tx" --log-index "$log" anchor-slot)"
  proof="$("$EVIDENCE_BIN" --config "$ATTACK_SCRATCH/prover.toml" --route a_to_b --tx "$tx" --log-index "$log" proof --assume-anchor --wait-seconds 30)" \
    || { note "front-run round $round: cannot prebuild the proof"; return 1; }
  if call_raw "$RPC_B" "$ATTACKER" "$VAULT_B" "$proof"; then
    note "front-run round $round: the proof was already valid before polling"
  else
    note "front-run round $round: before coverage the vault says: $CALL_REASON"
  fi
  local waited=0
  until [ "$(cast call "$LC_B" 'headers(uint64)(bytes32)' "$anchor_slot" --rpc-url "$RPC_B")" != "0x0000000000000000000000000000000000000000000000000000000000000000" ]; do
    sleep 0.1
    waited=$((waited + 1))
    [ "$waited" -gt 1200 ] && { note "front-run round $round: no coverage in 120 seconds"; return 1; }
  done
  proof="$(evidence_proof a_to_b "$tx" "$log" 30)" || { note "front-run round $round: cannot rebuild the proof after coverage"; return 1; }
  local hash
  hash="$(send_raw "$RPC_B" "$ATTACKER" "$VAULT_B" "$proof" 0x7a1200 0x174876e800)"
  receipt="$(wait_receipt "$RPC_B" "$hash")"
  local status; status="$(echo "$receipt" | jq -r .status)"
  sleep 15
  local completed count winner_tx winner recipient_paid
  completed="$(cast logs --rpc-url "$RPC_B" --address "$VAULT_B" --from-block earliest --json "$(cast keccak 'WithdrawalCompleted(address,address,bytes32,uint256,bytes32)')" \
    | jq -c --arg nonce "$nonce" '[.[] | select(.topics[3]==$nonce)]')"
  count="$(echo "$completed" | jq length)"
  winner_tx="$(echo "$completed" | jq -r '.[0].transactionHash // empty')"
  recipient_paid="$(echo "$completed" | jq -r '.[0].topics[2] // empty' | sed 's/0x000000000000000000000000/0x/')"
  if [ -n "$winner_tx" ]; then winner="$(cast rpc eth_getTransactionByHash "$winner_tx" --rpc-url "$RPC_B" | jq -r .from)"; else winner="none"; fi
  local who="the prover"
  [ "$(lower "$winner")" = "$(lower "$ATTACKER")" ] && who="the attacker"
  local prover_note
  prover_note="$("${COMPOSE[@]}" logs --no-log-prefix prover 2>&1 | grep "$nonce" | grep -E "to=(confirmed|failed)|already" | tail -2 | cut -c1-240 | tr '\n' '|')"
  if [ "$count" = 1 ] && [ "$(claimed_on "$RPC_B" "$VAULT_B" "$nonce")" = true ] && [ "$(lower "${recipient_paid:-0x}")" = "$(lower "$VICTIM")" ]; then
    blocked "front_run_round_$round" "attacker transaction status $status; first to be MINED was $who (the recipient is fixed in the proof: VICTIM gets paid either way); WithdrawalCompleted events for the nonce: $count, paid to $recipient_paid; prover log: $prover_note"
  else
    succeeded "front_run_round_$round" "events=$count paid_to=$recipient_paid claimed=$(claimed_on "$RPC_B" "$VAULT_B" "$nonce"); prover log: $prover_note"
  fi
  echo "$who" > "$ATTACK_SCRATCH/frontrun-winner-$round"
}
for round in 1 2 3; do
  frontrun_round "$round"
  if grep -q "the attacker" "$ATTACK_SCRATCH"/frontrun-winner-* 2> /dev/null; then break; fi
done
