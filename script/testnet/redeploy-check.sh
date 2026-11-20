#!/usr/bin/env bash
# Checks the new message layers of one chain against the ones they replace, read only:
#   script/testnet/redeploy-check.sh <rpc url> <rpc url of the other chain> <old router> <new router> \
#     <new router on the other chain> [--fork-smoke]
#
# Everything else is found from the routers: a router's `bridge()` is its mediator, the mediator's `bridgeContract()`
# its bridge and `tokenFactory()` its factory. Read only (any RPC), it requires:
# - router: code; the mediator, wrapped native token, reward and failed delivery addresses of the old router (the
#   mediator is the new one); `routerCaller()` created by the router at its nonce 1, with code, naming it back;
# - mediator: the new bridge; the new mediator of the other chain as `mediatorContractOnOtherSide()`; the other chain's
#   id; the old mediator's flow limiter; a factory that names this mediator and the old factory's home chain name;
# - bridge: the light client, remote light client, deposit gate, Capella era and send cutoff of the old bridge; the new
#   bridge of the other chain as `remoteBridge()`; both chain ids. It prints `depositsOpen()` (false until the runner
#   opens the bridge).
# Exits non-zero at the first mismatch.
#
# --fork-smoke (an Anvil fork only; it sends transactions there with impersonated accounts):
# 1. A delivery with a follow-up call `wrapped.transfer(thief, amount)` while the router holds `amount`, through the old
#    router and through the new one (the mediator impersonated, outside `executeMessage`, so no tip). The old router
#    pays the thief; the new router's call runs from RouterCaller, fails, and the router keeps its tokens.
# 2. A relay of the wrapped native token through the new mediator: refused with `DepositsNotOpen` while the bridge is
#    locked. Then the script sets `depositsOpen` in the bridge's storage (slot 0, byte 8; on the fork only, in place of
#    the opening proof that the runner sends on the live chain) and relays again: the tokens are locked in the new
#    mediator and the bridge's message nonce moves. A relay with a callback gas above `MAX_CALLBACK_GAS` is refused
#    (`CallbackGasTooHigh`, second review round).
set -euo pipefail

if [[ $# -lt 5 ]]; then
  echo "usage: $0 <rpc url> <rpc url of the other chain> <old router> <new router> <new router on the other chain> [--fork-smoke]" >&2
  exit 2
fi
RPC=$1
REMOTE_RPC=$2
OLD=$3
NEW=$4
REMOTE_NEW=$5
SMOKE=${6:-}

fail() { echo "FAIL: $*" >&2; exit 1; }
lower() { tr '[:upper:]' '[:lower:]'; }
at() { cast call "$1" "$2" --rpc-url "${3:-$RPC}" | awk '{print $1}' | lower; }
text() { cast call "$1" "$2" --rpc-url "${3:-$RPC}"; }
same() { # <label> <expected> <actual>
  [[ "$2" == "$3" ]] || fail "$1: expected $2, found $3"
  echo "ok   $1 = $3"
}
has_code() { [[ $(cast codesize "$1" --rpc-url "${2:-$RPC}") -gt 0 ]] || fail "$3 $1 has no code"; }

CHAIN=$(cast chain-id --rpc-url "$RPC")
REMOTE_CHAIN=$(cast chain-id --rpc-url "$REMOTE_RPC")
echo "chain $CHAIN (other chain $REMOTE_CHAIN): old router $OLD, new router $NEW"
has_code "$NEW" "$RPC" "new router"
OLD_MEDIATOR=$(at "$OLD" 'bridge()(address)')
OLD_BRIDGE=$(at "$OLD_MEDIATOR" 'bridgeContract()(address)')
OLD_FACTORY=$(at "$OLD_MEDIATOR" 'tokenFactory()(address)')
MEDIATOR=$(at "$NEW" 'bridge()(address)')
BRIDGE=$(at "$MEDIATOR" 'bridgeContract()(address)')
FACTORY=$(at "$MEDIATOR" 'tokenFactory()(address)')
REMOTE_MEDIATOR=$(at "$REMOTE_NEW" 'bridge()(address)' "$REMOTE_RPC")
REMOTE_BRIDGE=$(at "$REMOTE_MEDIATOR" 'bridgeContract()(address)' "$REMOTE_RPC")
for pair in "mediator $MEDIATOR $OLD_MEDIATOR" "bridge $BRIDGE $OLD_BRIDGE" "factory $FACTORY $OLD_FACTORY"; do
  set -- $pair
  [[ "$2" != "$3" ]] || fail "the new $1 is the old one ($2)"
  has_code "$2" "$RPC" "new $1"
done
echo "new bridge $BRIDGE, mediator $MEDIATOR, factory $FACTORY"

# Router
for getter in 'wNative()(address)' 'rewardAddress()(address)' 'failedDeliveryAddress()(address)'; do
  same "router.${getter%%(*}" "$(at "$OLD" "$getter")" "$(at "$NEW" "$getter")"
done
CALLER=$(at "$NEW" 'routerCaller()(address)')
same "router.routerCaller" "$(cast compute-address "$NEW" --nonce 1 | awk '{print $NF}' | lower)" "$CALLER"
has_code "$CALLER" "$RPC" "RouterCaller"
same "RouterCaller.router" "$(echo "$NEW" | lower)" "$(at "$CALLER" 'router()(address)')"

# Mediator and factory
same "mediator.mediatorContractOnOtherSide" "$REMOTE_MEDIATOR" "$(at "$MEDIATOR" 'mediatorContractOnOtherSide()(address)')"
same "mediator.remoteChainId" "$REMOTE_CHAIN" "$(at "$MEDIATOR" 'remoteChainId()(uint256)')"
same "mediator.flowLimiter" "$(at "$OLD_MEDIATOR" 'flowLimiter()(address)')" "$(at "$MEDIATOR" 'flowLimiter()(address)')"
same "mediator.MAX_CALLBACK_GAS" "10468731" "$(at "$MEDIATOR" 'MAX_CALLBACK_GAS()(uint256)')"
same "factory.mediator" "$MEDIATOR" "$(at "$FACTORY" 'mediator()(address)')"
same "factory.homeChainName" "$(text "$OLD_FACTORY" 'homeChainName()(string)')" "$(text "$FACTORY" 'homeChainName()(string)')"

# Bridge
for getter in 'lightClient()(address)' 'remoteLightClient()(address)' 'depositGate()(address)' 'capellaEra()(uint64)' 'sendCutoffTimestamp()(uint64)'; do
  same "bridge.${getter%%(*}" "$(at "$OLD_BRIDGE" "$getter")" "$(at "$BRIDGE" "$getter")"
done
same "bridge.remoteBridge" "$REMOTE_BRIDGE" "$(at "$BRIDGE" 'remoteBridge()(address)')"
same "bridge.localChainId" "$CHAIN" "$(at "$BRIDGE" 'localChainId()(uint64)')"
same "bridge.remoteChainId" "$REMOTE_CHAIN" "$(at "$BRIDGE" 'remoteChainId()(uint64)')"
echo "info bridge.depositsOpen = $(at "$BRIDGE" 'depositsOpen()(bool)') (false until the runner opens it)"

[[ "$SMOKE" == "--fork-smoke" ]] || exit 0

cast rpc anvil_nodeInfo --rpc-url "$RPC" >/dev/null 2>&1 || fail "--fork-smoke sends transactions and runs on an Anvil fork only"
TOKEN=$(at "$NEW" 'wNative()(address)')
FUNDER=0x00000000000000000000000000000000000f0001
RECIPIENT=0x00000000000000000000000000000000000f0002
THIEF=0x00000000000000000000000000000000000f0003
STUCK=1000000000000000      # tokens that sit in a router (a plain relay to it, a refused hand-off)
DELIVERED=2000000000000000  # what the mediator releases for the delivery
# A transfer to a new holder writes a new storage slot, which Sepolia prices far above 100,000 gas.
CALL_GAS=1000000
for account in "$FUNDER" "$MEDIATOR" "$OLD_MEDIATOR"; do
  cast rpc anvil_impersonateAccount "$account" --rpc-url "$RPC" >/dev/null
  cast rpc anvil_setBalance "$account" 0x56BC75E2D63100000 --rpc-url "$RPC" >/dev/null
done
send() { cast send --unlocked --from "$1" --rpc-url "$RPC" --gas-limit 3000000 "${@:2}" >/dev/null; }
balance() { cast call "$TOKEN" 'balanceOf(address)(uint256)' "$1" --rpc-url "$RPC" | awk '{print $1}'; }
send "$FUNDER" "$TOKEN" 'deposit()' --value 100000000000000000

# 1. The follow-up call cannot take what the router holds.
for router in "$OLD" "$NEW"; do
  mediator=$(at "$router" 'bridge()(address)')
  send "$FUNDER" "$TOKEN" 'transfer(address,uint256)' "$router" "$STUCK"
  held=$(balance "$router")
  before=$(balance "$THIEF")
  paid_before=$(balance "$RECIPIENT")
  director=$(cast abi-encode 'f(address,uint256,uint256,uint256,uint256)' "$RECIPIENT" 0 0 0 "$CALL_GAS")
  steal=$(cast calldata 'transfer(address,uint256)' "$THIEF" "$STUCK")
  send "$FUNDER" "$TOKEN" 'transfer(address,uint256)' "$router" "$DELIVERED"
  send "$mediator" "$router" 'onTokenBridged(address,uint256,bytes)' "$TOKEN" "$DELIVERED" "${director}${TOKEN#0x}${steal#0x}"
  taken=$(( $(balance "$THIEF") - before ))
  paid=$(( $(balance "$RECIPIENT") - paid_before ))
  echo "smoke router $router: recipient paid $paid; follow-up call wrapped.transfer(thief, $STUCK): thief received $taken, router keeps $(balance "$router")"
  [[ "$paid" == "$DELIVERED" ]] || fail "the delivery through $router did not pay the recipient $DELIVERED"
  if [[ "$router" == "$NEW" ]]; then
    [[ "$taken" == 0 ]] || fail "the new router let the follow-up call take its tokens"
    [[ $(balance "$router") == "$held" ]] || fail "the new router does not hold the stuck tokens any more"
  fi
done

# 2. A relay through the new mediator.
AMOUNT=10000000000000000
send "$FUNDER" "$TOKEN" 'approve(address,uint256)' "$MEDIATOR" 1000000000000000000
if out=$(cast call --from "$FUNDER" "$MEDIATOR" 'relayTokens(address,address,uint256)' "$TOKEN" "$RECIPIENT" "$AMOUNT" --rpc-url "$RPC" 2>&1); then
  fail "a relay through the new mediator passed while its bridge is locked"
fi
[[ "$out" == *"$(cast sig 'DepositsNotOpen()')"* || "$out" == *DepositsNotOpen* ]] || fail "the locked relay failed with something else: $out"
echo "ok   relay refused while the new bridge is locked (DepositsNotOpen)"
# Slot 0 packs `_nonce` (uint64, bytes 0 to 7) and `depositsOpen` (byte 8). The words are 256 bit, so python does the
# arithmetic.
word() { python3 -I -c "import sys; print($1)" "$(cast storage "$BRIDGE" 0 --rpc-url "$RPC")"; }
cast rpc anvil_setStorageAt "$BRIDGE" 0x0 "$(word '"0x%064x" % (int(sys.argv[1], 16) | (1 << 64))')" --rpc-url "$RPC" >/dev/null
same "bridge.depositsOpen (set on the fork)" "true" "$(at "$BRIDGE" 'depositsOpen()(bool)')"
locked_before=$(balance "$MEDIATOR")
nonce_before=$(word 'int(sys.argv[1], 16) & 0xffffffffffffffff')
send "$FUNDER" "$MEDIATOR" 'relayTokens(address,address,uint256)' "$TOKEN" "$RECIPIENT" "$AMOUNT"
locked=$(( $(balance "$MEDIATOR") - locked_before ))
nonce_after=$(word 'int(sys.argv[1], 16) & 0xffffffffffffffff')
same "tokens locked in the new mediator by the relay" "$AMOUNT" "$locked"
[[ $nonce_after -gt $nonce_before ]] || fail "the bridge sent no message for the relay"
echo "ok   the new bridge sent the relay's message (message nonce $nonce_before to $nonce_after)"
if out=$(cast call --from "$FUNDER" "$MEDIATOR" 'relayTokensAndCall(address,address,uint256,bytes,uint256)' "$TOKEN" "$NEW" "$AMOUNT" 0x01 10468732 --rpc-url "$RPC" 2>&1); then
  fail "a relay with a callback gas above MAX_CALLBACK_GAS passed"
fi
[[ "$out" == *"$(cast sig 'CallbackGasTooHigh(uint256,uint256)')"* || "$out" == *CallbackGasTooHigh* ]] || fail "the relay above MAX_CALLBACK_GAS failed with something else: $out"
echo "ok   a relay with callback gas 10,468,732 is refused (CallbackGasTooHigh)"
echo "smoke passed"
