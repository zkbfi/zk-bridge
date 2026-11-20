#!/usr/bin/env bash
# Checks a new DeliveryRouter against the router it replaces, read only, on one chain:
#   script/testnet/router-redeploy-check.sh <rpc url> <old router> <new router> [--fork-smoke]
#
# Read only (any RPC): the new router has code, names the same mediator, wrapped native token, reward address and
# failed delivery address as the old one, and its RouterCaller is the contract it created at its own nonce 1, has
# code, and names the router back. Exits non-zero at the first mismatch.
#
# --fork-smoke (an Anvil fork only; it sends transactions there with impersonated accounts): one follow-up call that
# tries to take tokens that sit in the router, `token.transfer(thief, amount)`, delivered through the old router and
# through the new one. Through the old router the tokens move; through the new one the call runs from RouterCaller,
# which holds nothing, so it fails (`CallFailed`) and the tokens stay. Then a harmless follow-up call (`approve`)
# through the new router, which succeeds and whose `Approval` names RouterCaller as the owner. The script refuses to
# send on a chain that does not answer `anvil_nodeInfo`.
set -euo pipefail

if [[ $# -lt 3 ]]; then
  echo "usage: $0 <rpc url> <old router> <new router> [--fork-smoke]" >&2
  exit 2
fi
RPC=$1
OLD=$2
NEW=$3
SMOKE=${4:-}

fail() { echo "FAIL: $*" >&2; exit 1; }
lower() { tr '[:upper:]' '[:lower:]'; }
read_address() { cast call "$1" "$2" --rpc-url "$RPC" | lower; }

echo "chain $(cast chain-id --rpc-url "$RPC"), old router $OLD, new router $NEW"
[[ $(cast codesize "$NEW" --rpc-url "$RPC") -gt 0 ]] || fail "the new router has no code"
for getter in 'bridge()(address)' 'wNative()(address)' 'rewardAddress()(address)' 'failedDeliveryAddress()(address)'; do
  old_value=$(read_address "$OLD" "$getter")
  new_value=$(read_address "$NEW" "$getter")
  [[ "$old_value" == "$new_value" ]] || fail "$getter: old $old_value, new $new_value"
  echo "ok   ${getter%%(*} = $new_value (same as the old router)"
done
CALLER=$(read_address "$NEW" 'routerCaller()(address)')
EXPECTED=$(cast compute-address "$NEW" --nonce 1 | awk '{print $NF}' | lower)
[[ "$CALLER" == "$EXPECTED" ]] || fail "routerCaller is $CALLER, the router's nonce 1 gives $EXPECTED"
echo "ok   routerCaller = $CALLER (created by the router at its nonce 1)"
[[ $(cast codesize "$CALLER" --rpc-url "$RPC") -gt 0 ]] || fail "RouterCaller has no code"
[[ $(read_address "$CALLER" 'router()(address)') == $(echo "$NEW" | lower) ]] || fail "RouterCaller.router() is not the new router"
echo "ok   RouterCaller.router() = the new router, code $(cast codesize "$CALLER" --rpc-url "$RPC") bytes; router code $(cast codesize "$NEW" --rpc-url "$RPC") bytes"
MAX_CALL_GAS=$(cast call "$NEW" 'MAX_CALL_GAS()(uint256)' --rpc-url "$RPC" | awk '{print $1}')
echo "ok   MAX_CALL_GAS = $MAX_CALL_GAS"

[[ "$SMOKE" == "--fork-smoke" ]] || exit 0

cast rpc anvil_nodeInfo --rpc-url "$RPC" >/dev/null 2>&1 || fail "--fork-smoke sends transactions and runs on an Anvil fork only"
MEDIATOR=$(read_address "$NEW" 'bridge()(address)')
TOKEN=$(read_address "$NEW" 'wNative()(address)')
FUNDER=0x00000000000000000000000000000000000f0001
RECIPIENT=0x00000000000000000000000000000000000f0002
THIEF=0x00000000000000000000000000000000000f0003
STUCK=1000000000000000      # tokens that sit in a router (a plain relay to it, a refused hand-off)
DELIVERED=2000000000000000  # what the mediator releases for the delivery
# The gas of the follow-up call. A transfer to a new holder writes a new storage slot, which Sepolia (Amsterdam rules
# on Anvil's fork) prices far above 100,000 gas, so the call gets enough for that on every chain.
CALL_GAS=1000000
for account in "$FUNDER" "$MEDIATOR"; do
  cast rpc anvil_impersonateAccount "$account" --rpc-url "$RPC" >/dev/null
  cast rpc anvil_setBalance "$account" 0x56BC75E2D63100000 --rpc-url "$RPC" >/dev/null
done
send() { cast send --unlocked --from "$1" --rpc-url "$RPC" --gas-limit 2000000 "${@:2}" >/dev/null; }
balance() { cast call "$TOKEN" 'balanceOf(address)(uint256)' "$1" --rpc-url "$RPC" | awk '{print $1}'; }
send "$FUNDER" "$TOKEN" 'deposit()' --value 10000000000000000

# The director (five words: recipient, settings 0, limit 0, multiplier 0, callGas), the 20 byte target, the call data.
deliver_with_call() { # <router> <callGas> <target> <call data>
  local director
  director=$(cast abi-encode 'f(address,uint256,uint256,uint256,uint256)' "$RECIPIENT" 0 0 0 "$2")
  # The mediator releases the tokens to the router, then calls onTokenBridged (outside executeMessage: no tip).
  send "$FUNDER" "$TOKEN" 'transfer(address,uint256)' "$1" "$DELIVERED"
  send "$MEDIATOR" "$1" 'onTokenBridged(address,uint256,bytes)' "$TOKEN" "$DELIVERED" "${director}${3#0x}${4#0x}"
}

for router in "$OLD" "$NEW"; do
  send "$FUNDER" "$TOKEN" 'transfer(address,uint256)' "$router" "$STUCK"
  held=$(balance "$router")
  before=$(balance "$THIEF")
  paid_before=$(balance "$RECIPIENT")
  steal=$(cast calldata 'transfer(address,uint256)' "$THIEF" "$STUCK")
  deliver_with_call "$router" "$CALL_GAS" "$TOKEN" "$steal"
  taken=$(( $(balance "$THIEF") - before ))
  paid=$(( $(balance "$RECIPIENT") - paid_before ))
  echo "smoke router $router: recipient paid $paid; follow-up call token.transfer(thief, $STUCK): thief received $taken, router keeps $(balance "$router")"
  [[ "$paid" == "$DELIVERED" ]] || fail "the delivery through $router did not pay the recipient $DELIVERED"
  if [[ "$router" == "$NEW" ]]; then
    [[ "$taken" == 0 ]] || fail "the new router let the follow-up call take its tokens"
    [[ $(balance "$router") == "$held" ]] || fail "the new router does not hold the stuck tokens any more"
  fi
done

block=$(cast block-number --rpc-url "$RPC")
approve=$(cast calldata 'approve(address,uint256)' "$THIEF" 1)
deliver_with_call "$NEW" "$CALL_GAS" "$TOKEN" "$approve"
approval_topic=$(cast keccak 'Approval(address,address,uint256)')
owner_topic=0x$(printf '%064s' "$(cast to-hex "$CALLER" | sed 's/^0x//' | lower)" | tr ' ' 0)
logs=$(cast logs --from-block $((block + 1)) --address "$TOKEN" --rpc-url "$RPC" "$approval_topic" "$owner_topic" | grep -c "$approval_topic" || true)
[[ "$logs" -ge 1 ]] || fail "no Approval from RouterCaller after a successful follow-up call"
echo "ok   a follow-up call through the new router ran from RouterCaller (Approval with owner $CALLER)"
echo "smoke passed"
