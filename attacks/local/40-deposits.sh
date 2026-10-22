#!/usr/bin/env bash
# Attacks on the deposit path and on the open functions of BridgeVault.
source "$(dirname "$0")/lib.sh"
load_deployment
fund_attacker

report_vault() { # NAME RPC TO DATA
  if call_raw "$2" "$ATTACKER" "$3" "$4"; then
    succeeded "$1" "eth_call returned success"
  else
    blocked "$1" "$CALL_REASON"
  fi
}
wait_gate_confirmed "$RPC_A" "$GATE_A"
ZERO32="0x0000000000000000000000000000000000000000000000000000000000000000"

# A token the vault does not pair.
UNPAIRED="$(forge_create "$RPC_A" src/mocks/MockERC20.sol:MockERC20 "Unpaired" UNP)"
FEE_TOKEN="$(forge_create "$RPC_A" src/mocks/FeeOnTransferToken.sol:FeeOnTransferToken "Fee" FEE)"
for token in "$UNPAIRED" "$FEE_TOKEN"; do
  send_wait "$RPC_A" "$ATTACKER" "$token" "$(calldata 'mint(address,uint256)' "$ATTACKER" 1000000000000000000000)" > /dev/null
  send_wait "$RPC_A" "$ATTACKER" "$token" "$(calldata 'approve(address,uint256)' "$VAULT_A" "$MAX_UINT")" > /dev/null
done
report_vault deposit_unpaired_token "$RPC_A" "$VAULT_A" "$(deposit_data "$UNPAIRED" "$VICTIM" 1000)"
report_vault deposit_fee_on_transfer_token_not_registered "$RPC_A" "$VAULT_A" "$(deposit_data "$FEE_TOKEN" "$VICTIM" 1000)"
report_vault deposit_zero_amount "$RPC_A" "$VAULT_A" "$(deposit_data "$TOKEN_A" "$VICTIM" 0)"
report_vault deposit_zero_recipient "$RPC_A" "$VAULT_A" "$(deposit_data "$TOKEN_A" 0x0000000000000000000000000000000000000000 1000)"
report_vault deposit_amount_above_balance "$RPC_A" "$VAULT_A" "$(deposit_data "$TOKEN_A" "$VICTIM" 100000000000000000000000000000)"
report_vault deposit_the_token_as_recipient_control "$RPC_A" "$VAULT_A" "$(deposit_data "$TOKEN_A" "$TOKEN_A" 1000)"
# Without allowance: a fresh account.
FRESH="$(cast wallet address --mnemonic "$MNEMONIC" --mnemonic-index 6)"
send_wait "$RPC_A" "$FRESH" "$TOKEN_A" "$(calldata 'mint(address,uint256)' "$FRESH" 1000)" > /dev/null
if call_raw "$RPC_A" "$FRESH" "$VAULT_A" "$(deposit_data "$TOKEN_A" "$VICTIM" 1000)"; then
  succeeded deposit_without_allowance "eth_call returned success"
else
  blocked deposit_without_allowance "$CALL_REASON"
fi
# The fee is zero and nobody can change it, so a low maximum fee cannot be tested against a real fee.
note "fee basis points on vault A: $(cast call "$VAULT_A" 'feeBasisPoints()(uint16)' --rpc-url "$RPC_A"); fee authority: $(cast call "$VAULT_A" 'feeAuthority()(address)' --rpc-url "$RPC_A")"
report_vault deposit_max_fee_zero_with_zero_fee_control "$RPC_A" "$VAULT_A" "$(deposit_data "$TOKEN_A" "$VICTIM" 1000 0)"
# Recipient is the destination vault itself (a self-transfer on the other chain): accepted by design, user error.
report_vault deposit_recipient_is_the_destination_vault "$RPC_A" "$VAULT_A" "$(deposit_data "$TOKEN_A" "$VAULT_B" 1000)"
report_vault deposit_recipient_is_the_source_vault "$RPC_A" "$VAULT_A" "$(deposit_data "$TOKEN_A" "$VAULT_A" 1000)"

# Privileged functions.
report_vault fee_set_by_attacker "$RPC_A" "$VAULT_A" "$(calldata 'setFee(uint16,address)' 100 "$ATTACKER")"
report_vault fee_nullify_by_attacker "$RPC_A" "$VAULT_A" "$(calldata 'nullifyFee()')"
report_vault fee_collect_with_nothing_accrued "$RPC_A" "$VAULT_A" "$(calldata 'collectFees(address)' "$TOKEN_A")"
report_vault flow_limiter_detach_by_attacker "$RPC_A" "$VAULT_A" "$(calldata 'detachFlowLimiter()')"

# Withdraw with empty and garbage evidence.
report_vault withdraw_empty_calldata "$RPC_B" "$VAULT_B" "0x$(cast sig 'withdraw(((uint64,uint64,bytes32,bytes32,bytes32),(uint64,uint64,bytes32,bytes32,bytes32),bytes32[],bytes32[],bytes,bytes[],uint256,uint256))' | cut -c3-)"
report_vault withdraw_all_zero_proof "$RPC_B" "$VAULT_B" "$(calldata 'withdraw(((uint64,uint64,bytes32,bytes32,bytes32),(uint64,uint64,bytes32,bytes32,bytes32),bytes32[],bytes32[],bytes,bytes[],uint256,uint256))' \
  "((0,0,$ZERO32,$ZERO32,$ZERO32),(0,0,$ZERO32,$ZERO32,$ZERO32),[],[],0x,[],0,0)")"

# Layout rows: anyone may add them, but the vault checks them against stored headers.
HEADER="(1,0,$ZERO32,$ZERO32,$ZERO32)"
for gindex in 1 2 36 37 100 4294967296; do
  report_vault "layout_block_roots_bogus_gindex_$gindex" "$RPC_B" "$VAULT_B" \
    "$(calldata 'addBlockRootsLayout(uint256,((uint64,uint64,bytes32,bytes32,bytes32),uint64,uint64,bytes32[],bytes32[]))' "$gindex" "($HEADER,1,2,[],[])")"
done
report_vault layout_block_hash_bogus "$RPC_B" "$VAULT_B" \
  "$(calldata 'addBlockHashLayout(uint256,((uint64,uint64,bytes32,bytes32,bytes32),bytes32[]))' 1000 "($HEADER,[])")"
report_vault layout_historical_bogus "$RPC_B" "$VAULT_B" \
  "$(calldata 'addHistoricalSummariesLayout(uint256,((uint64,uint64,bytes32,bytes32,bytes32),uint64,bytes32[]))' 1000 "($HEADER,1,[])")"
