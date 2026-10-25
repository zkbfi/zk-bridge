#!/usr/bin/env bash
# Deploys the local bridge on two fresh Anvil chains and writes the result to /state.
#
# Steps:
#   1. Refuse to run on chains that already hold a deployment from another run (or say that this run is done).
#   2. Install the EIP-4788 contract on chain A, so the deposit gate there can run in Enforcing mode.
#   3. Deploy a wrapped native token, a test token and the oracle verifier on each chain.
#   4. Run script/hardened/DeployBridge.s.sol with a configuration made from docker/bridge.config.template.json.
#      It deploys the light client, the gate, the message bridge, the token mediator (which creates its token factory)
#      and the native coin router on each chain.
#   5. Read every relationship back from the chains.
#   6. Write /state/deployment.json.
#
# The test token is not part of the configuration: the mediator needs no registration. It is there so that you can try
# a relay. The chains hold no pre-loaded liquidity: the mediator locks native tokens and mints copies on first use.
#
# Both bridges start locked: they refuse sends until a stateful server opens them with `openDeposits` (see the launch
# sequence in docs/hardened-build-contract.md and docs/local-network.md).
#
# Every key comes from the public Anvil development mnemonic. Nothing here is secret.
set -euo pipefail

STATE_DIR="${STATE_DIR:-/state}"
RPC_A="${RPC_A:-http://127.0.0.1:28545}"
RPC_B="${RPC_B:-http://127.0.0.1:28546}"
MNEMONIC="${ANVIL_MNEMONIC:-test test test test test test test test test test test junk}"
REPO="${REPO:-/repo}"
# The beacon clock of both gates. Any time in the past works.
GATE_GENESIS_TIME=1600000000
# The wrapped native token mock of the native coin router.
WRAPPED_NATIVE_CONTRACT=src/mocks/MockWrappedNative.sol:MockWrappedNative

# The EIP-4788 contract: address and the genuine runtime code of the specification.
BEACON_ROOTS=0x000F3df6D732807Ef1319fB7B8bB8522d0Beac02
BEACON_ROOTS_CODE=0x3373fffffffffffffffffffffffffffffffffffffffe14604d57602036146024575f5ffd5b5f35801560495762001fff810690815414603c575f5ffd5b62001fff01545f5260205ff35b5f5ffd5b62001fff42064281555f359062001fff015500

log() { printf 'deploy: %s\n' "$*" >&2; }
fail() { log "$*"; exit 1; }

# The last word of the output of `cast compute-address`.
compute_address() { cast compute-address "$1" --nonce "$2" | awk '{print $NF}'; }

# Deploys a contract with `forge create` and prints its address. Arguments: rpc url, contract, constructor arguments
# (none is allowed).
create() {
  local rpc="$1" contract="$2"
  shift 2
  local arguments=()
  [ "$#" -eq 0 ] || arguments=(--constructor-args "$@")
  forge create "$contract" --rpc-url "$rpc" --unlocked --from "$DEPLOYER" --broadcast --json \
    ${arguments[@]+"${arguments[@]}"} | sed -n 's/.*"deployedTo": *"\(0x[0-9a-fA-F]*\)".*/\1/p'
}

lower() { printf '%s' "$1" | tr 'A-F' 'a-f'; }

# Compares a value read from a chain with the expected value. Arguments: contract, rpc url, expected value, signature.
# The first word of the answer counts, because `cast` adds a note after large numbers.
expect() {
  local contract="$1" rpc="$2" expected="$3" signature="$4" actual
  actual="$(cast call "$contract" "$signature" --rpc-url "$rpc" | awk '{print $1}')"
  [ "$(lower "$actual")" = "$(lower "$expected")" ] || fail "$signature of $contract is $actual, expected $expected"
}

has_code() { [ "$(cast code "$1" --rpc-url "$2")" != "0x" ]; }

# Reads one string field of the flat deployment file: field name, chain section.
recorded() { sed -n "/\"$2\"/,/}/s/.*\"$1\": \"\\(0x[0-9a-fA-F]*\\)\".*/\\1/p" "$STATE_DIR/deployment.json" | head -n 1; }

DEPLOYER="$(cast wallet address --mnemonic "$MNEMONIC" --mnemonic-index 0)"
ORACLE_ACCOUNT="$(cast wallet address --mnemonic "$MNEMONIC" --mnemonic-index 1)"

cast chain-id --rpc-url "$RPC_A" > /dev/null || fail "chain A does not answer at $RPC_A"
cast chain-id --rpc-url "$RPC_B" > /dev/null || fail "chain B does not answer at $RPC_B"
[ "$(cast chain-id --rpc-url "$RPC_A")" = 1 ] || fail "the node at $RPC_A is not chain 1"
[ "$(cast chain-id --rpc-url "$RPC_B")" = 369 ] || fail "the node at $RPC_B is not chain 369"

# Step 1: one run per pair of chains.
if [ -f "$STATE_DIR/deployment.json" ]; then
  bridge_a="$(recorded bridge chain_a)"
  bridge_b="$(recorded bridge chain_b)"
  mediator_a="$(recorded mediator chain_a)"
  mediator_b="$(recorded mediator chain_b)"
  if [ -n "$bridge_a" ] && [ -n "$bridge_b" ] && [ -n "$mediator_a" ] && [ -n "$mediator_b" ] \
    && has_code "$bridge_a" "$RPC_A" && has_code "$bridge_b" "$RPC_B" \
    && has_code "$mediator_a" "$RPC_A" && has_code "$mediator_b" "$RPC_B"; then
    log "already deployed: bridge A $bridge_a, bridge B $bridge_b, mediator A $mediator_a, mediator B $mediator_b. Nothing to do."
    log "to start over, run: docker compose -f docker/compose.yaml down -v"
    exit 0
  fi
fi
nonce_a="$(cast nonce "$DEPLOYER" --rpc-url "$RPC_A")"
nonce_b="$(cast nonce "$DEPLOYER" --rpc-url "$RPC_B")"
if [ "$nonce_a" != 0 ] || [ "$nonce_b" != 0 ]; then
  fail "the chains are not fresh (deployer nonce $nonce_a on chain A, $nonce_b on chain B) and no matching deployment is recorded. Run: docker compose -f docker/compose.yaml down -v, then start again."
fi
# The chains are fresh. Remove what an earlier deployment on other chains left behind.
rm -rf "$STATE_DIR/deployment.json"

# Step 2: EIP-4788 on chain A.
cast rpc anvil_setCode "$BEACON_ROOTS" "$BEACON_ROOTS_CODE" --rpc-url "$RPC_A" > /dev/null
has_code "$BEACON_ROOTS" "$RPC_A" || fail "the EIP-4788 contract is missing on chain A"

# Step 3: wrapped native tokens, test tokens and verifiers. Chain B sends one empty transaction first, so the two chains give different addresses.
start_block_a="$(cast block-number --rpc-url "$RPC_A")"
cast send "$DEPLOYER" --rpc-url "$RPC_B" --unlocked --from "$DEPLOYER" > /dev/null
start_block_b="$(cast block-number --rpc-url "$RPC_B")"
cd "$REPO"
WRAPPED_NATIVE_A="$(create "$RPC_A" "$WRAPPED_NATIVE_CONTRACT")"
WRAPPED_NATIVE_B="$(create "$RPC_B" "$WRAPPED_NATIVE_CONTRACT")"
TOKEN_A="$(create "$RPC_A" src/mocks/MockERC20.sol:MockERC20 "Token A" TKNA)"
TOKEN_B="$(create "$RPC_B" src/mocks/MockERC20.sol:MockERC20 "Token B" TKNB)"
# The oracle of the verifier is the second Anvil account: the oracle backend of the producer signs proofs with its key.
VERIFIER_A="$(create "$RPC_A" src/mocks/OracleSP1Verifier.sol:OracleSP1Verifier "$ORACLE_ACCOUNT")"
VERIFIER_B="$(create "$RPC_B" src/mocks/OracleSP1Verifier.sol:OracleSP1Verifier "$ORACLE_ACCOUNT")"
for value in "$WRAPPED_NATIVE_A" "$WRAPPED_NATIVE_B" "$TOKEN_A" "$TOKEN_B" "$VERIFIER_A" "$VERIFIER_B"; do
  [ -n "$value" ] || fail "a contract did not deploy"
done
log "wrapped native A $WRAPPED_NATIVE_A, wrapped native B $WRAPPED_NATIVE_B"
log "token A $TOKEN_A, token B $TOKEN_B, verifier A $VERIFIER_A, verifier B $VERIFIER_B"

# Step 4: the bridge, through the deploy script.
NONCE_A="$(cast nonce "$DEPLOYER" --rpc-url "$RPC_A")"
NONCE_B="$(cast nonce "$DEPLOYER" --rpc-url "$RPC_B")"
config="$REPO/script/hardened/local.config.json"
cp "$REPO/docker/bridge.config.template.json" "$config"
fill() { sed "s|@@$1@@|$2|g" "$config" > "$config.next" && mv "$config.next" "$config"; }
fill DEPLOYER "$DEPLOYER"
fill RPC_A "$RPC_A"
fill RPC_B "$RPC_B"
fill VERIFIER_A "$VERIFIER_A"
fill VERIFIER_B "$VERIFIER_B"
fill VERIFIER_CODE_HASH_A "$(cast codehash "$VERIFIER_A" --rpc-url "$RPC_A")"
fill VERIFIER_CODE_HASH_B "$(cast codehash "$VERIFIER_B" --rpc-url "$RPC_B")"
fill NONCE_A "$NONCE_A"
fill NONCE_B "$NONCE_B"
fill WRAPPED_NATIVE_A "$WRAPPED_NATIVE_A"
fill WRAPPED_NATIVE_B "$WRAPPED_NATIVE_B"
fill GATE_GENESIS_TIME "$GATE_GENESIS_TIME"
PROGRAM_VKEY="$(cast keccak light-client-program)"
fill PROGRAM_VKEY "$PROGRAM_VKEY"
fill GENESIS_ROOT_A "$(cast keccak genesis-of-chain-a)"
fill GENESIS_ROOT_B "$(cast keccak genesis-of-chain-b)"
fill CHECKPOINT_HEADER_ROOT "$(cast keccak checkpoint)"
fill COMMITTEE_HASH "$(cast keccak committee)"
fill NEXT_COMMITTEE_HASH "$(cast keccak next-committee)"
if grep -q '@@' "$config"; then fail "the configuration still has a placeholder: $(grep -o '@@[A-Z_]*@@' "$config" | head -n 1)"; fi

log "running script/hardened/DeployBridge.s.sol"
BRIDGE_CONFIG="$config" forge script script/hardened/DeployBridge.s.sol --tc DeployBridge \
  --broadcast --slow --unlocked --sender "$DEPLOYER" > "$STATE_DIR/forge-script.log" 2>&1 \
  || { cat "$STATE_DIR/forge-script.log" >&2; fail "the deploy script failed"; }

# Both chains have no fork registry (chain A enforces, chain B only detects), so the script deploys in this order: the
# light client at the nonce, then the gate, the message bridge, the token mediator and the native coin router. The
# mediator creates the token factory as its first contract, so the factory takes no nonce of the deployer.
LIGHT_CLIENT_A="$(compute_address "$DEPLOYER" "$NONCE_A")"
GATE_A="$(compute_address "$DEPLOYER" $((NONCE_A + 1)))"
BRIDGE_A="$(compute_address "$DEPLOYER" $((NONCE_A + 2)))"
MEDIATOR_A="$(compute_address "$DEPLOYER" $((NONCE_A + 3)))"
ROUTER_A="$(compute_address "$DEPLOYER" $((NONCE_A + 4)))"
FACTORY_A="$(compute_address "$MEDIATOR_A" 1)"
LIGHT_CLIENT_B="$(compute_address "$DEPLOYER" "$NONCE_B")"
GATE_B="$(compute_address "$DEPLOYER" $((NONCE_B + 1)))"
BRIDGE_B="$(compute_address "$DEPLOYER" $((NONCE_B + 2)))"
MEDIATOR_B="$(compute_address "$DEPLOYER" $((NONCE_B + 3)))"
ROUTER_B="$(compute_address "$DEPLOYER" $((NONCE_B + 4)))"
FACTORY_B="$(compute_address "$MEDIATOR_B" 1)"
# A name is a hypothesis: read each relationship back from the chain. Each bridge names the bridge and the light client
# of the OTHER chain, and starts locked: it refuses sends until a stateful server opens it with `openDeposits`. Each
# mediator names its bridge and its twin on the other chain. Each router names its mediator and its wrapped native token.
for contract in "$BRIDGE_A $RPC_A" "$MEDIATOR_A $RPC_A" "$ROUTER_A $RPC_A" "$FACTORY_A $RPC_A" \
  "$BRIDGE_B $RPC_B" "$MEDIATOR_B $RPC_B" "$ROUTER_B $RPC_B" "$FACTORY_B $RPC_B"; do
  read -r address rpc <<< "$contract"
  has_code "$address" "$rpc" || fail "no contract at $address on $rpc"
done
expect "$BRIDGE_A" "$RPC_A" "$LIGHT_CLIENT_A" 'lightClient()(address)'
expect "$BRIDGE_A" "$RPC_A" "$GATE_A" 'depositGate()(address)'
expect "$BRIDGE_A" "$RPC_A" "$BRIDGE_B" 'remoteBridge()(address)'
expect "$BRIDGE_A" "$RPC_A" "$LIGHT_CLIENT_B" 'remoteLightClient()(address)'
expect "$BRIDGE_A" "$RPC_A" 369 'remoteChainId()(uint64)'
expect "$BRIDGE_A" "$RPC_A" false 'depositsOpen()(bool)'
expect "$BRIDGE_B" "$RPC_B" "$LIGHT_CLIENT_B" 'lightClient()(address)'
expect "$BRIDGE_B" "$RPC_B" "$GATE_B" 'depositGate()(address)'
expect "$BRIDGE_B" "$RPC_B" "$BRIDGE_A" 'remoteBridge()(address)'
expect "$BRIDGE_B" "$RPC_B" "$LIGHT_CLIENT_A" 'remoteLightClient()(address)'
expect "$BRIDGE_B" "$RPC_B" 1 'remoteChainId()(uint64)'
expect "$BRIDGE_B" "$RPC_B" false 'depositsOpen()(bool)'
expect "$MEDIATOR_A" "$RPC_A" "$BRIDGE_A" 'bridgeContract()(address)'
expect "$MEDIATOR_A" "$RPC_A" "$MEDIATOR_B" 'mediatorContractOnOtherSide()(address)'
expect "$MEDIATOR_A" "$RPC_A" 369 'remoteChainId()(uint256)'
expect "$MEDIATOR_A" "$RPC_A" "$FACTORY_A" 'tokenFactory()(address)'
expect "$MEDIATOR_B" "$RPC_B" "$BRIDGE_B" 'bridgeContract()(address)'
expect "$MEDIATOR_B" "$RPC_B" "$MEDIATOR_A" 'mediatorContractOnOtherSide()(address)'
expect "$MEDIATOR_B" "$RPC_B" 1 'remoteChainId()(uint256)'
expect "$MEDIATOR_B" "$RPC_B" "$FACTORY_B" 'tokenFactory()(address)'
expect "$ROUTER_A" "$RPC_A" "$MEDIATOR_A" 'bridge()(address)'
expect "$ROUTER_A" "$RPC_A" "$WRAPPED_NATIVE_A" 'WETH()(address)'
expect "$ROUTER_B" "$RPC_B" "$MEDIATOR_B" 'bridge()(address)'
expect "$ROUTER_B" "$RPC_B" "$WRAPPED_NATIVE_B" 'WETH()(address)'
log "chain A: bridge $BRIDGE_A, mediator $MEDIATOR_A, native router $ROUTER_A (gate $GATE_A, light client $LIGHT_CLIENT_A)"
log "chain B: bridge $BRIDGE_B, mediator $MEDIATOR_B, native router $ROUTER_B (gate $GATE_B, light client $LIGHT_CLIENT_B)"

# Step 6: the record for the other services.
chain_json() { # name rpc chain_id token wrapped_native bridge mediator token_factory native_router gate light_client start_block
  printf '    "name": "%s",\n    "rpc_url": "%s",\n    "chain_id": %s,\n    "token": "%s",\n    "wrapped_native": "%s",\n    "bridge": "%s",\n    "mediator": "%s",\n    "token_factory": "%s",\n    "native_router": "%s",\n    "gate": "%s",\n    "light_client": "%s",\n    "start_block": %s,\n    "gate_genesis_time": %s\n' \
    "$1" "$2" "$3" "$4" "$5" "$6" "$7" "$8" "$9" "${10}" "${11}" "${12}" "$GATE_GENESIS_TIME"
}
{
  printf '{\n  "chain_a": {\n'
  chain_json chain-a "$RPC_A" 1 "$TOKEN_A" "$WRAPPED_NATIVE_A" "$BRIDGE_A" "$MEDIATOR_A" "$FACTORY_A" "$ROUTER_A" "$GATE_A" "$LIGHT_CLIENT_A" "$start_block_a"
  printf '  },\n  "chain_b": {\n'
  chain_json chain-b "$RPC_B" 369 "$TOKEN_B" "$WRAPPED_NATIVE_B" "$BRIDGE_B" "$MEDIATOR_B" "$FACTORY_B" "$ROUTER_B" "$GATE_B" "$LIGHT_CLIENT_B" "$start_block_b"
  printf '  }\n}\n'
} > "$STATE_DIR/deployment.json.partial"

# The deployment file comes last: its presence tells the other services that the deployment is complete.
mv "$STATE_DIR/deployment.json.partial" "$STATE_DIR/deployment.json"
log "done. The record is $STATE_DIR/deployment.json"
