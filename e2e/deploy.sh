#!/usr/bin/env bash
# Deploys the bridge on the two running Anvil chains and writes the files that the prover and the bots read.
#
# It follows docker/deploy.sh, with these changes for a run with real proofs:
#   - The verifier is the vendored SP1 Groth16 verifier (src/hardened/vendor/sp1-contracts/v6.1.0), and the program key is the
#     light-client key of light-client/program-keys.json. With E2E_BACKEND=oracle it is the oracle verifier, as in docker/.
#   - The checkpoint of each light client, the genesis time and the genesis validators root come from the signed beacon node
#     (`local-network checkpoint`), so the light clients start on the synthetic beacon chains.
#   - The prover reads that beacon node over HTTP, with the backend `sp1`.
#
# Every key comes from the public Anvil development mnemonic. Nothing here is secret.
set -euo pipefail
source "$(dirname "$0")/env.sh"
e2e_enter_root
e2e_require cast forge

STATE_DIR="$E2E_STATE_DIR"
VERIFIER_SOURCE=src/hardened/vendor/sp1-contracts/v6.1.0/SP1VerifierGroth16.sol:SP1Verifier
BEACON_ROOTS=0x000F3df6D732807Ef1319fB7B8bB8522d0Beac02
BEACON_ROOTS_CODE=0x3373fffffffffffffffffffffffffffffffffffffffe14604d57602036146024575f5ffd5b5f35801560495762001fff810690815414603c575f5ffd5b62001fff01545f5260205ff35b5f5ffd5b62001fff42064281555f359062001fff015500
VAULT_LIQUIDITY_TOKENS=1000000

lower() { printf '%s' "$1" | tr 'A-F' 'a-f'; }
compute_address() { cast compute-address "$1" --nonce "$2" | awk '{print $NF}'; }
has_code() { [ "$(cast code "$1" --rpc-url "$2")" != "0x" ]; }

# Deploys a contract with `forge create` and prints its address. Arguments: rpc url, contract, constructor arguments (optional).
create() {
  local rpc="$1" contract="$2" output
  shift 2
  if [ "$#" -eq 0 ]; then
    output="$(forge create "$contract" --rpc-url "$rpc" --unlocked --from "$DEPLOYER" --broadcast --json)"
  else
    output="$(forge create "$contract" --rpc-url "$rpc" --unlocked --from "$DEPLOYER" --broadcast --json --constructor-args "$@")"
  fi
  printf '%s' "$output" | sed -n 's/.*"deployedTo": *"\(0x[0-9a-fA-F]*\)".*/\1/p'
}

# The value of a `name=value` line. Arguments: text, name.
value_of() { printf '%s\n' "$1" | sed -n "s/^$2=//p"; }

# Replaces @@NAME@@ in a file. Arguments: file, name, value.
fill() {
  local temporary
  temporary="$(mktemp)"
  sed "s|@@$2@@|$3|g" "$1" > "$temporary"
  mv "$temporary" "$1"
}

DEPLOYER="$(cast wallet address --mnemonic "$E2E_MNEMONIC" --mnemonic-index 0)"
PROVER_ACCOUNT="$(cast wallet address --mnemonic "$E2E_MNEMONIC" --mnemonic-index 1)"

[ "$(cast chain-id --rpc-url "$E2E_RPC_A")" = 1 ] || e2e_fail "the node at $E2E_RPC_A is not chain 1"
[ "$(cast chain-id --rpc-url "$E2E_RPC_B")" = 369 ] || e2e_fail "the node at $E2E_RPC_B is not chain 369"
[ ! -f "$STATE_DIR/deployment.json" ] || e2e_fail "$STATE_DIR/deployment.json exists. Run e2e/stop.sh and start again on fresh chains."
for rpc in "$E2E_RPC_A" "$E2E_RPC_B"; do
  [ "$(cast nonce "$DEPLOYER" --rpc-url "$rpc")" = 0 ] || e2e_fail "the chain at $rpc is not fresh (the deployer has sent transactions)"
done

# Step 1: the program key and the checkpoints of both light clients, read from the beacon node.
if [ "$E2E_BACKEND" = oracle ]; then
  PROGRAM_VKEY="$(cast keccak light-client-program)"
else
  PROGRAM_VKEY="$(sed -n '/"light-client"/,/}/s/.*"program_key": "\(0x[0-9a-f]*\)".*/\1/p' light-client/program-keys.json)"
fi
[ -n "$PROGRAM_VKEY" ] || e2e_fail "no program key"
checkpoint_a="$("$E2E_LOCAL_NETWORK" checkpoint --beacon-url "$E2E_BEACON/a" --chain ethereum)"
checkpoint_b="$("$E2E_LOCAL_NETWORK" checkpoint --beacon-url "$E2E_BEACON/b" --chain pulsechain)"
e2e_log "program key $PROGRAM_VKEY"
e2e_log "checkpoint of chain A: slot $(value_of "$checkpoint_a" slot), chain B: slot $(value_of "$checkpoint_b" slot)"

# Step 2: EIP-4788 on chain A, so that its deposit gate can run in Enforcing mode.
cast rpc anvil_setCode "$BEACON_ROOTS" "$BEACON_ROOTS_CODE" --rpc-url "$E2E_RPC_A" > /dev/null
has_code "$BEACON_ROOTS" "$E2E_RPC_A" || e2e_fail "the EIP-4788 contract is missing on chain A"

# Step 3: tokens and verifiers. Chain B sends one empty transaction first, so the two chains give different addresses.
start_block_a="$(e2e_block_number "$E2E_RPC_A")"
cast send "$DEPLOYER" --rpc-url "$E2E_RPC_B" --unlocked --from "$DEPLOYER" > /dev/null
start_block_b="$(e2e_block_number "$E2E_RPC_B")"
TOKEN_A="$(create "$E2E_RPC_A" src/mocks/MockERC20.sol:MockERC20 "Token A" TKNA)"
TOKEN_B="$(create "$E2E_RPC_B" src/mocks/MockERC20.sol:MockERC20 "Token B" TKNB)"
if [ "$E2E_BACKEND" = oracle ]; then
  VERIFIER_A="$(create "$E2E_RPC_A" src/mocks/OracleSP1Verifier.sol:OracleSP1Verifier "$PROVER_ACCOUNT")"
  VERIFIER_B="$(create "$E2E_RPC_B" src/mocks/OracleSP1Verifier.sol:OracleSP1Verifier "$PROVER_ACCOUNT")"
else
  VERIFIER_A="$(create "$E2E_RPC_A" "$VERIFIER_SOURCE")"
  VERIFIER_B="$(create "$E2E_RPC_B" "$VERIFIER_SOURCE")"
fi
for value in "$TOKEN_A" "$TOKEN_B" "$VERIFIER_A" "$VERIFIER_B"; do
  [ -n "$value" ] || e2e_fail "a contract did not deploy"
done
e2e_log "token A $TOKEN_A, token B $TOKEN_B, verifier A $VERIFIER_A, verifier B $VERIFIER_B"
CODE_HASH_A="$(cast codehash "$VERIFIER_A" --rpc-url "$E2E_RPC_A")"
CODE_HASH_B="$(cast codehash "$VERIFIER_B" --rpc-url "$E2E_RPC_B")"
e2e_log "verifier code hash on chain A $CODE_HASH_A, on chain B $CODE_HASH_B"

# Step 4: the bridge, through the deploy script.
NONCE_A="$(cast nonce "$DEPLOYER" --rpc-url "$E2E_RPC_A")"
NONCE_B="$(cast nonce "$DEPLOYER" --rpc-url "$E2E_RPC_B")"
# Foundry reads the configuration only from a path that foundry.toml allows (script/hardened). The file is not tracked.
config=script/hardened/e2e.config.json
cp e2e/bridge.config.template.json "$config"
fill "$config" DEPLOYER "$DEPLOYER"
fill "$config" RPC_A "$E2E_RPC_A"
fill "$config" RPC_B "$E2E_RPC_B"
fill "$config" VERIFIER_A "$VERIFIER_A"
fill "$config" VERIFIER_B "$VERIFIER_B"
fill "$config" VERIFIER_CODE_HASH_A "$CODE_HASH_A"
fill "$config" VERIFIER_CODE_HASH_B "$CODE_HASH_B"
fill "$config" NONCE_A "$NONCE_A"
fill "$config" NONCE_B "$NONCE_B"
fill "$config" TOKEN_A "$TOKEN_A"
fill "$config" TOKEN_B "$TOKEN_B"
fill "$config" PROGRAM_VKEY "$PROGRAM_VKEY"
for side in A B; do
  checkpoint="$checkpoint_a"
  [ "$side" = A ] || checkpoint="$checkpoint_b"
  fill "$config" "GENESIS_TIME_$side" "$(value_of "$checkpoint" genesis_time)"
  fill "$config" "GENESIS_VALIDATORS_ROOT_$side" "$(value_of "$checkpoint" genesis_validators_root)"
  fill "$config" "CHECKPOINT_SLOT_$side" "$(value_of "$checkpoint" slot)"
  fill "$config" "CHECKPOINT_HEADER_ROOT_$side" "$(value_of "$checkpoint" header_root)"
  fill "$config" "CHECKPOINT_COMMITTEE_HASH_$side" "$(value_of "$checkpoint" committee_hash)"
  fill "$config" "CHECKPOINT_NEXT_COMMITTEE_HASH_$side" "$(value_of "$checkpoint" next_committee_hash)"
done
if grep -q '@@' "$config"; then e2e_fail "the configuration still has a placeholder: $(grep -o '@@[A-Z_]*@@' "$config" | head -n 1)"; fi

e2e_log "running script/hardened/DeployBridge.s.sol"
BRIDGE_CONFIG="$config" forge script script/hardened/DeployBridge.s.sol --tc DeployBridge \
  --broadcast --slow --unlocked --sender "$DEPLOYER" > "$STATE_DIR/forge-script.log" 2>&1 \
  || { cat "$STATE_DIR/forge-script.log" >&2; e2e_fail "the deploy script failed"; }

# The script deploys the light client at the nonce, the gate after it, and the vault after the gate.
LIGHT_CLIENT_A="$(compute_address "$DEPLOYER" "$NONCE_A")"
GATE_A="$(compute_address "$DEPLOYER" $((NONCE_A + 1)))"
VAULT_A="$(compute_address "$DEPLOYER" $((NONCE_A + 2)))"
LIGHT_CLIENT_B="$(compute_address "$DEPLOYER" "$NONCE_B")"
GATE_B="$(compute_address "$DEPLOYER" $((NONCE_B + 1)))"
VAULT_B="$(compute_address "$DEPLOYER" $((NONCE_B + 2)))"
# A name is a hypothesis: read each relationship back from the chain.
check_link() { # contract rpc expected signature [argument]
  local actual
  actual="$(cast call "$1" "$4" ${5:+"$5"} --rpc-url "$2")"
  [ "$(lower "$actual")" = "$(lower "$3")" ] || e2e_fail "$4 of $1 is $actual, expected $3"
}
check_link "$VAULT_A" "$E2E_RPC_A" "$LIGHT_CLIENT_A" 'lightClient()(address)'
check_link "$VAULT_A" "$E2E_RPC_A" "$GATE_A" 'depositGate()(address)'
check_link "$VAULT_A" "$E2E_RPC_A" "$VAULT_B" 'remoteVault()(address)'
check_link "$VAULT_B" "$E2E_RPC_B" "$LIGHT_CLIENT_B" 'lightClient()(address)'
check_link "$VAULT_B" "$E2E_RPC_B" "$GATE_B" 'depositGate()(address)'
check_link "$VAULT_B" "$E2E_RPC_B" "$VAULT_A" 'remoteVault()(address)'
# Each vault names the light client of the OTHER chain, and starts locked: it refuses deposits until `prover follow` opens it.
check_link "$VAULT_A" "$E2E_RPC_A" "$LIGHT_CLIENT_B" 'remoteLightClient()(address)'
check_link "$VAULT_B" "$E2E_RPC_B" "$LIGHT_CLIENT_A" 'remoteLightClient()(address)'
check_link "$VAULT_A" "$E2E_RPC_A" false 'depositsOpen()(bool)'
check_link "$VAULT_B" "$E2E_RPC_B" false 'depositsOpen()(bool)'
check_link "$VAULT_A" "$E2E_RPC_A" "$TOKEN_B" 'remoteTokenOf(address)(address)' "$TOKEN_A"
check_link "$VAULT_B" "$E2E_RPC_B" "$TOKEN_A" 'remoteTokenOf(address)(address)' "$TOKEN_B"
# The light clients hold the program key, the verifier and the checkpoint that the beacon node gave.
check_link "$LIGHT_CLIENT_A" "$E2E_RPC_A" "$PROGRAM_VKEY" 'programVKey()(bytes32)'
check_link "$LIGHT_CLIENT_B" "$E2E_RPC_B" "$PROGRAM_VKEY" 'programVKey()(bytes32)'
check_link "$LIGHT_CLIENT_A" "$E2E_RPC_A" "$VERIFIER_A" 'verifier()(address)'
check_link "$LIGHT_CLIENT_B" "$E2E_RPC_B" "$VERIFIER_B" 'verifier()(address)'
# The light client of a chain tracks the other chain: its checkpoint is the one of the other beacon node.
check_link "$LIGHT_CLIENT_A" "$E2E_RPC_A" "$(value_of "$checkpoint_b" header_root)" 'headers(uint64)(bytes32)' "$(value_of "$checkpoint_b" slot)"
check_link "$LIGHT_CLIENT_B" "$E2E_RPC_B" "$(value_of "$checkpoint_a" header_root)" 'headers(uint64)(bytes32)' "$(value_of "$checkpoint_a" slot)"
e2e_log "vault A $VAULT_A (gate $GATE_A, light client $LIGHT_CLIENT_A)"
e2e_log "vault B $VAULT_B (gate $GATE_B, light client $LIGHT_CLIENT_B)"

# Step 5: liquidity. A vault pays a withdrawal from its own balance.
liquidity="${VAULT_LIQUIDITY_TOKENS}000000000000000000"
cast send "$TOKEN_A" 'mint(address,uint256)' "$VAULT_A" "$liquidity" --rpc-url "$E2E_RPC_A" --unlocked --from "$DEPLOYER" > /dev/null
cast send "$TOKEN_B" 'mint(address,uint256)' "$VAULT_B" "$liquidity" --rpc-url "$E2E_RPC_B" --unlocked --from "$DEPLOYER" > /dev/null

# Step 6: the files for the other services.
mkdir -p "$STATE_DIR/keys"
cast wallet import prover --keystore-dir "$STATE_DIR/keys" --unsafe-password "$E2E_KEYSTORE_PASSWORD" \
  --private-key "$(cast wallet private-key --mnemonic "$E2E_MNEMONIC" --mnemonic-index 1)" > /dev/null
printf '%s' "$E2E_KEYSTORE_PASSWORD" > "$STATE_DIR/keys/prover.password"

prover_config="$STATE_DIR/prover.toml"
cp e2e/prover.toml.template "$prover_config"
prover_extra=""
[ "$E2E_BACKEND" != sp1 ] || prover_extra="sp1_elf_path = \"$E2E_LIGHT_CLIENT_ELF\""
fill "$prover_config" STATE_DIR "$STATE_DIR"
fill "$prover_config" MAX_ATTEMPTS "$E2E_MAX_ATTEMPTS"
fill "$prover_config" BACKEND "$E2E_BACKEND"
fill "$prover_config" PROGRAM_VKEY "$PROGRAM_VKEY"
fill "$prover_config" PROVER_EXTRA "$prover_extra"
fill "$prover_config" RPC_A "$E2E_RPC_A"
fill "$prover_config" RPC_B "$E2E_RPC_B"
fill "$prover_config" BEACON "$E2E_BEACON"
fill "$prover_config" START_BLOCK_A "$start_block_a"
fill "$prover_config" START_BLOCK_B "$start_block_b"
fill "$prover_config" VAULT_A "$VAULT_A"
fill "$prover_config" VAULT_B "$VAULT_B"
fill "$prover_config" LIGHT_CLIENT_A "$LIGHT_CLIENT_A"
fill "$prover_config" LIGHT_CLIENT_B "$LIGHT_CLIENT_B"

chain_json() { # name rpc chain_id token vault gate light_client gate_genesis_time
  printf '    "name": "%s",\n    "rpc_url": "%s",\n    "chain_id": %s,\n    "token": "%s",\n    "vault": "%s",\n    "gate": "%s",\n    "light_client": "%s",\n    "gate_genesis_time": %s\n' \
    "$1" "$2" "$3" "$4" "$5" "$6" "$7" "$8"
}
{
  printf '{\n  "chain_a": {\n'
  chain_json chain-a "$E2E_RPC_A" 1 "$TOKEN_A" "$VAULT_A" "$GATE_A" "$LIGHT_CLIENT_A" "$(value_of "$checkpoint_a" genesis_time)"
  printf '  },\n  "chain_b": {\n'
  chain_json chain-b "$E2E_RPC_B" 369 "$TOKEN_B" "$VAULT_B" "$GATE_B" "$LIGHT_CLIENT_B" "$(value_of "$checkpoint_b" genesis_time)"
  printf '  }\n}\n'
} > "$STATE_DIR/deployment.json.partial"
# The deployment file comes last: its presence tells the other services that the deployment is complete.
mv "$STATE_DIR/deployment.json.partial" "$STATE_DIR/deployment.json"
e2e_log "done. The record is $STATE_DIR/deployment.json and the prover configuration is $STATE_DIR/prover.toml"
