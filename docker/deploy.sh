#!/usr/bin/env bash
# Deploys the local bridge on two fresh Anvil chains and writes the result to /state.
#
# Steps:
#   1. Refuse to run on chains that already hold a deployment from another run (or say that this run is done).
#   2. Install the EIP-4788 contract on chain A, so the deposit gate there can run in Enforcing mode.
#   3. Deploy a test token and the oracle verifier on each chain.
#   4. Run script/hardened/DeployBridge.s.sol with a configuration made from docker/bridge.config.template.json.
#   5. Put tokens in both vaults, so each vault can pay withdrawals.
#   6. Write /state/deployment.json, /state/prover.toml, /state/route-health.toml and a keystore for the prover.
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
# The keystore password. The keystore holds a public development key, so the password is not a secret.
KEYSTORE_PASSWORD=local-network
# The vault gets this many whole tokens at the start. Each completed withdrawal draws on the vault of its chain.
VAULT_LIQUIDITY_TOKENS=1000000
# The EIP-4788 contract: address and the genuine runtime code of the specification.
BEACON_ROOTS=0x000F3df6D732807Ef1319fB7B8bB8522d0Beac02
BEACON_ROOTS_CODE=0x3373fffffffffffffffffffffffffffffffffffffffe14604d57602036146024575f5ffd5b5f35801560495762001fff810690815414603c575f5ffd5b62001fff01545f5260205ff35b5f5ffd5b62001fff42064281555f359062001fff015500

log() { printf 'deploy: %s\n' "$*" >&2; }
fail() { log "$*"; exit 1; }

# The last word of the output of `cast compute-address`.
compute_address() { cast compute-address "$1" --nonce "$2" | awk '{print $NF}'; }

# Deploys a contract with `forge create` and prints its address. Arguments: rpc url, contract, constructor arguments.
create() {
  local rpc="$1" contract="$2"
  shift 2
  forge create "$contract" --rpc-url "$rpc" --unlocked --from "$DEPLOYER" --broadcast --json \
    --constructor-args "$@" | sed -n 's/.*"deployedTo": *"\(0x[0-9a-fA-F]*\)".*/\1/p'
}

has_code() { [ "$(cast code "$1" --rpc-url "$2")" != "0x" ]; }

# Reads one string field of the flat deployment file: field name, chain section.
recorded() { sed -n "/\"$2\"/,/}/s/.*\"$1\": \"\\(0x[0-9a-fA-F]*\\)\".*/\\1/p" "$STATE_DIR/deployment.json" | head -n 1; }

DEPLOYER="$(cast wallet address --mnemonic "$MNEMONIC" --mnemonic-index 0)"
PROVER_ACCOUNT="$(cast wallet address --mnemonic "$MNEMONIC" --mnemonic-index 1)"

cast chain-id --rpc-url "$RPC_A" > /dev/null || fail "chain A does not answer at $RPC_A"
cast chain-id --rpc-url "$RPC_B" > /dev/null || fail "chain B does not answer at $RPC_B"
[ "$(cast chain-id --rpc-url "$RPC_A")" = 1 ] || fail "the node at $RPC_A is not chain 1"
[ "$(cast chain-id --rpc-url "$RPC_B")" = 369 ] || fail "the node at $RPC_B is not chain 369"

# Step 1: one run per pair of chains.
if [ -f "$STATE_DIR/deployment.json" ]; then
  vault_a="$(recorded vault chain_a)"
  vault_b="$(recorded vault chain_b)"
  if [ -n "$vault_a" ] && [ -n "$vault_b" ] && has_code "$vault_a" "$RPC_A" && has_code "$vault_b" "$RPC_B"; then
    log "already deployed: vault A $vault_a, vault B $vault_b. Nothing to do."
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
rm -rf "$STATE_DIR/deployment.json" "$STATE_DIR/prover.toml" "$STATE_DIR/route-health.toml" \
  "$STATE_DIR"/prover.sqlite* "$STATE_DIR/keys"

# Step 2: EIP-4788 on chain A.
cast rpc anvil_setCode "$BEACON_ROOTS" "$BEACON_ROOTS_CODE" --rpc-url "$RPC_A" > /dev/null
has_code "$BEACON_ROOTS" "$RPC_A" || fail "the EIP-4788 contract is missing on chain A"

# Step 3: tokens and verifiers. Chain B sends one empty transaction first, so the two chains give different addresses.
start_block_a="$(cast block-number --rpc-url "$RPC_A")"
cast send "$DEPLOYER" --rpc-url "$RPC_B" --unlocked --from "$DEPLOYER" > /dev/null
start_block_b="$(cast block-number --rpc-url "$RPC_B")"
cd "$REPO"
TOKEN_A="$(create "$RPC_A" src/mocks/MockERC20.sol:MockERC20 "Token A" TKNA)"
TOKEN_B="$(create "$RPC_B" src/mocks/MockERC20.sol:MockERC20 "Token B" TKNB)"
# The oracle of the verifier is the prover account: the oracle backend signs light-client proofs with the prover key.
VERIFIER_A="$(create "$RPC_A" src/mocks/OracleSP1Verifier.sol:OracleSP1Verifier "$PROVER_ACCOUNT")"
VERIFIER_B="$(create "$RPC_B" src/mocks/OracleSP1Verifier.sol:OracleSP1Verifier "$PROVER_ACCOUNT")"
for value in "$TOKEN_A" "$TOKEN_B" "$VERIFIER_A" "$VERIFIER_B"; do
  [ -n "$value" ] || fail "a contract did not deploy"
done
log "token A $TOKEN_A, token B $TOKEN_B, verifier A $VERIFIER_A, verifier B $VERIFIER_B"

# Step 4: the bridge, through the deploy script.
NONCE_A="$(cast nonce "$DEPLOYER" --rpc-url "$RPC_A")"
NONCE_B="$(cast nonce "$DEPLOYER" --rpc-url "$RPC_B")"
config="$REPO/script/hardened/local.config.json"
cp "$REPO/docker/bridge.config.template.json" "$config"
fill() { sed -i "s|@@$1@@|$2|g" "$config"; }
fill DEPLOYER "$DEPLOYER"
fill RPC_A "$RPC_A"
fill RPC_B "$RPC_B"
fill VERIFIER_A "$VERIFIER_A"
fill VERIFIER_B "$VERIFIER_B"
fill VERIFIER_CODE_HASH_A "$(cast codehash "$VERIFIER_A" --rpc-url "$RPC_A")"
fill VERIFIER_CODE_HASH_B "$(cast codehash "$VERIFIER_B" --rpc-url "$RPC_B")"
fill NONCE_A "$NONCE_A"
fill NONCE_B "$NONCE_B"
fill TOKEN_A "$TOKEN_A"
fill TOKEN_B "$TOKEN_B"
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

# The script deploys the light client at the nonce, the gate after it, and the vault after the gate.
LIGHT_CLIENT_A="$(compute_address "$DEPLOYER" "$NONCE_A")"
GATE_A="$(compute_address "$DEPLOYER" $((NONCE_A + 1)))"
VAULT_A="$(compute_address "$DEPLOYER" $((NONCE_A + 2)))"
LIGHT_CLIENT_B="$(compute_address "$DEPLOYER" "$NONCE_B")"
GATE_B="$(compute_address "$DEPLOYER" $((NONCE_B + 1)))"
VAULT_B="$(compute_address "$DEPLOYER" $((NONCE_B + 2)))"
# A name is a hypothesis: read each relationship back from the chain.
for pair in "$VAULT_A $RPC_A $LIGHT_CLIENT_A lightClient()(address)" "$VAULT_A $RPC_A $GATE_A depositGate()(address)" \
  "$VAULT_A $RPC_A $VAULT_B remoteVault()(address)" "$VAULT_B $RPC_B $LIGHT_CLIENT_B lightClient()(address)" \
  "$VAULT_B $RPC_B $GATE_B depositGate()(address)" "$VAULT_B $RPC_B $VAULT_A remoteVault()(address)"; do
  read -r contract rpc expected signature <<< "$pair"
  actual="$(cast call "$contract" "$signature" --rpc-url "$rpc")"
  [ "${actual,,}" = "${expected,,}" ] || fail "$signature of $contract is $actual, expected $expected"
done
[ "$(cast call "$VAULT_A" 'remoteTokenOf(address)(address)' "$TOKEN_A" --rpc-url "$RPC_A" | tr 'A-F' 'a-f')" = "$(echo "$TOKEN_B" | tr 'A-F' 'a-f')" ] \
  || fail "vault A does not pair token A with token B"
[ "$(cast call "$VAULT_B" 'remoteTokenOf(address)(address)' "$TOKEN_B" --rpc-url "$RPC_B" | tr 'A-F' 'a-f')" = "$(echo "$TOKEN_A" | tr 'A-F' 'a-f')" ] \
  || fail "vault B does not pair token B with token A"
log "vault A $VAULT_A (gate $GATE_A, light client $LIGHT_CLIENT_A)"
log "vault B $VAULT_B (gate $GATE_B, light client $LIGHT_CLIENT_B)"

# Step 5: liquidity. A vault pays a withdrawal from its own balance.
liquidity="${VAULT_LIQUIDITY_TOKENS}000000000000000000"
cast send "$TOKEN_A" 'mint(address,uint256)' "$VAULT_A" "$liquidity" --rpc-url "$RPC_A" --unlocked --from "$DEPLOYER" > /dev/null
cast send "$TOKEN_B" 'mint(address,uint256)' "$VAULT_B" "$liquidity" --rpc-url "$RPC_B" --unlocked --from "$DEPLOYER" > /dev/null

# Step 6: the files for the other services.
mkdir -p "$STATE_DIR/keys"
cast wallet import prover --keystore-dir "$STATE_DIR/keys" --unsafe-password "$KEYSTORE_PASSWORD" \
  --private-key "$(cast wallet private-key --mnemonic "$MNEMONIC" --mnemonic-index 1)" > /dev/null
printf '%s' "$KEYSTORE_PASSWORD" > "$STATE_DIR/keys/prover.password"

chain_json() { # name rpc chain_id token vault gate light_client
  printf '    "name": "%s",\n    "rpc_url": "%s",\n    "chain_id": %s,\n    "token": "%s",\n    "vault": "%s",\n    "gate": "%s",\n    "light_client": "%s",\n    "gate_genesis_time": %s\n' \
    "$1" "$2" "$3" "$4" "$5" "$6" "$7" "$GATE_GENESIS_TIME"
}
{
  printf '{\n  "chain_a": {\n'
  chain_json chain-a "$RPC_A" 1 "$TOKEN_A" "$VAULT_A" "$GATE_A" "$LIGHT_CLIENT_A"
  printf '  },\n  "chain_b": {\n'
  chain_json chain-b "$RPC_B" 369 "$TOKEN_B" "$VAULT_B" "$GATE_B" "$LIGHT_CLIENT_B"
  printf '  }\n}\n'
} > "$STATE_DIR/deployment.json.partial"

prover_config() { # beacon section for chain a, for chain b
  cat <<TOML
database_path = "$STATE_DIR/prover.sqlite"
poll_interval_seconds = 3
receipt_timeout_seconds = 30
max_attempts = 5

[signer]
keystore = "$STATE_DIR/keys/prover"
password_file = "$STATE_DIR/keys/prover.password"

[prover]
backend = "oracle"
program_vkey = "$PROGRAM_VKEY"

[chain_a]
name = "chain-a"
rpc_url = "$RPC_A"
start_block = $start_block_a
chain_id = 1
vault = "$VAULT_A"
light_client = "$LIGHT_CLIENT_A"
[chain_a.beacon]
chain = "pulsechain"
$1

[chain_b]
name = "chain-b"
rpc_url = "$RPC_B"
start_block = $start_block_b
chain_id = 369
vault = "$VAULT_B"
light_client = "$LIGHT_CLIENT_B"
[chain_b.beacon]
chain = "pulsechain"
$2
TOML
}
# The service reads the development beacon source. `route-health` needs a beacon API, so it reads the stub.
prover_config 'kind = "dev"
finality_depth = 2' 'kind = "dev"
finality_depth = 2' > "$STATE_DIR/prover.toml"
prover_config 'kind = "http"
url = "http://127.0.0.1:29000/a"' 'kind = "http"
url = "http://127.0.0.1:29000/b"' > "$STATE_DIR/route-health.toml"

# The deployment file comes last: its presence tells the other services that the deployment is complete.
mv "$STATE_DIR/deployment.json.partial" "$STATE_DIR/deployment.json"
log "done. Next: docker compose -f docker/compose.yaml up -d prover bots"
