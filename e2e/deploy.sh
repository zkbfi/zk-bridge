#!/usr/bin/env bash
# Deploys the bridge on the two running Anvil chains (e2e/start.sh) and writes the files that the other steps read:
# deployment.json (the explorer deployment file), prover.toml (the proof producer) and run.json (tokens and accounts).
#
# The verifier is the vendored SP1 Groth16 verifier, and the program key is the light-client key of
# light-client/program-keys.json. With E2E_BACKEND=oracle the verifier is the oracle verifier of src/mocks (a rehearsal).
# The checkpoint of each light client, the genesis time and the genesis validators root come from the signed beacon node,
# so each light client starts on the synthetic beacon chain of the other chain.
#
# Every key comes from the public Anvil development mnemonic. Nothing here is secret.
set -euo pipefail
source "$(dirname "$0")/env.sh"
e2e_enter_root
e2e_require cast forge jq

STATE_DIR="$E2E_STATE_DIR"
VERIFIER_SOURCE=src/hardened/vendor/sp1-contracts/v6.1.0/SP1VerifierGroth16.sol:SP1Verifier
BEACON_ROOTS=0x000F3df6D732807Ef1319fB7B8bB8522d0Beac02
BEACON_ROOTS_CODE=0x3373fffffffffffffffffffffffffffffffffffffffe14604d57602036146024575f5ffd5b5f35801560495762001fff810690815414603c575f5ffd5b62001fff01545f5260205ff35b5f5ffd5b62001fff42064281555f359062001fff015500
MULTICALL3=0xcA11bde05977b3631167028862bE2a173976CA11

account() { cast wallet address --mnemonic "$E2E_MNEMONIC" --mnemonic-index "$1"; }
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
  printf '%s' "$output" | jq -r .deployedTo
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

DEPLOYER="$(account 0)"
ORACLE="$(account 1)"
REWARD="$(account 4)"
FAILED_DELIVERY="$(account 5)"

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
  PROGRAM_VKEY="$(jq -r '."light-client".program_key' light-client/program-keys.json)"
fi
checkpoint_a="$("$E2E_SIGNED_BEACON" checkpoint --beacon-url "$E2E_BEACON/a" --chain ethereum)"
checkpoint_b="$("$E2E_SIGNED_BEACON" checkpoint --beacon-url "$E2E_BEACON/b" --chain pulsechain)"
e2e_log "program key $PROGRAM_VKEY"
e2e_log "checkpoint of chain A: slot $(value_of "$checkpoint_a" slot), chain B: slot $(value_of "$checkpoint_b" slot)"

# Step 1b: Anvil funds ten accounts. The run uses more, so the accounts 10 to 15 get the same balance.
for index in 10 11 12 13 14 15; do
  for rpc in "$E2E_RPC_A" "$E2E_RPC_B"; do
    cast rpc anvil_setBalance "$(account "$index")" 0x21e19e0c9bab2400000 --rpc-url "$rpc" > /dev/null
  done
done

# Step 2: EIP-4788 and Multicall3 on both chains (the gates run Enforcing, and the runner batches deliveries).
MULTICALL3_CODE="$(forge inspect src/hardened/vendor/multicall3/Multicall3.sol:Multicall3 deployedBytecode 2> /dev/null || true)"
for rpc in "$E2E_RPC_A" "$E2E_RPC_B"; do
  cast rpc anvil_setCode "$BEACON_ROOTS" "$BEACON_ROOTS_CODE" --rpc-url "$rpc" > /dev/null
  has_code "$BEACON_ROOTS" "$rpc" || e2e_fail "the EIP-4788 contract is missing on $rpc"
  [ -z "$MULTICALL3_CODE" ] || cast rpc anvil_setCode "$MULTICALL3" "$MULTICALL3_CODE" --rpc-url "$rpc" > /dev/null
  has_code "$MULTICALL3" "$rpc" || e2e_fail "Multicall3 is missing on $rpc"
done

# Step 3: tokens and verifiers. Chain B sends 24 empty transactions first, so the nonce ranges of the two chains do not overlap
# and no contract has the same address on both chains. Equal addresses would hide a mix-up between the two sides.
start_block_a="$(e2e_block_number "$E2E_RPC_A")"
for nonce in $(seq 0 23); do
  cast send "$DEPLOYER" --rpc-url "$E2E_RPC_B" --unlocked --from "$DEPLOYER" --nonce "$nonce" --async > /dev/null
done
e2e_wait_for_nonce "$E2E_RPC_B" "$DEPLOYER" 24
start_block_b="$(e2e_block_number "$E2E_RPC_B")"
if [ "$E2E_BACKEND" = oracle ]; then
  VERIFIER_A="$(create "$E2E_RPC_A" src/mocks/OracleSP1Verifier.sol:OracleSP1Verifier "$ORACLE")"
  VERIFIER_B="$(create "$E2E_RPC_B" src/mocks/OracleSP1Verifier.sol:OracleSP1Verifier "$ORACLE")"
else
  VERIFIER_A="$(create "$E2E_RPC_A" "$VERIFIER_SOURCE")"
  VERIFIER_B="$(create "$E2E_RPC_B" "$VERIFIER_SOURCE")"
fi
WRAPPED_A="$(create "$E2E_RPC_A" src/mocks/MockWrappedNative.sol:MockWrappedNative)"
WRAPPED_B="$(create "$E2E_RPC_B" src/mocks/MockWrappedNative.sol:MockWrappedNative)"
TOKEN_A="$(create "$E2E_RPC_A" src/mocks/MockERC20.sol:MockERC20 "Token A" TKNA)"
BLOCKABLE_A="$(create "$E2E_RPC_A" src/mocks/BlockableToken.sol:BlockableToken "Blockable A" BLKA)"
TOKEN_B="$(create "$E2E_RPC_B" src/mocks/MockERC20.sol:MockERC20 "Token B" TKNB)"
for value in "$VERIFIER_A" "$VERIFIER_B" "$WRAPPED_A" "$WRAPPED_B" "$TOKEN_A" "$BLOCKABLE_A" "$TOKEN_B"; do
  [ -n "$value" ] && [ "$value" != null ] || e2e_fail "a contract did not deploy"
done
CODE_HASH_A="$(cast codehash "$VERIFIER_A" --rpc-url "$E2E_RPC_A")"
CODE_HASH_B="$(cast codehash "$VERIFIER_B" --rpc-url "$E2E_RPC_B")"
e2e_log "verifier code hash on chain A $CODE_HASH_A, on chain B $CODE_HASH_B"

# Step 4: the bridge, through the deploy script. Foundry reads the configuration only from .deploy/ (listed in .gitignore).
NONCE_A="$(cast nonce "$DEPLOYER" --rpc-url "$E2E_RPC_A")"
NONCE_B="$(cast nonce "$DEPLOYER" --rpc-url "$E2E_RPC_B")"
mkdir -p .deploy "$STATE_DIR"
config=.deploy/bridge.config.json
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
fill "$config" WRAPPED_A "$WRAPPED_A"
fill "$config" WRAPPED_B "$WRAPPED_B"
fill "$config" REWARD "$REWARD"
fill "$config" FAILED_DELIVERY "$FAILED_DELIVERY"
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
  || { tail -n 40 "$STATE_DIR/forge-script.log" >&2; e2e_fail "the deploy script failed"; }
FLAGS_A="$(sed -n 's/^ *prover flags, chain A: //p' "$STATE_DIR/forge-script.log")"
FLAGS_B="$(sed -n 's/^ *prover flags, chain B: //p' "$STATE_DIR/forge-script.log")"
[ -n "$FLAGS_A" ] && [ -n "$FLAGS_B" ] || e2e_fail "the deploy script printed no prover flags"

# Step 5: the deployment file of the explorer, written by the producer from the printed flags.
rm -f "$STATE_DIR/deployment.json"
eval "$E2E_PROVER deployment-file --output $STATE_DIR/deployment.json $FLAGS_A --chain-a start_block=$start_block_a --chain-a rpc_url=$E2E_RPC_A $FLAGS_B --chain-b start_block=$start_block_b --chain-b rpc_url=$E2E_RPC_B"

# Step 6: the record of the run: tokens, accounts and the first blocks.
jq -n \
  --arg deployer "$DEPLOYER" --arg oracle "$ORACLE" --arg runner "$(account 2)" --arg recipient "$(account 3)" \
  --arg reward "$REWARD" --arg failed "$FAILED_DELIVERY" --arg copier "$(account 6)" \
  --arg tokenA "$TOKEN_A" --arg blockableA "$BLOCKABLE_A" --arg tokenB "$TOKEN_B" --arg wrappedA "$WRAPPED_A" --arg wrappedB "$WRAPPED_B" \
  --arg verifierA "$VERIFIER_A" --arg verifierB "$VERIFIER_B" --arg program "$PROGRAM_VKEY" --arg multicall "$MULTICALL3" \
  --arg backend "$E2E_BACKEND" --arg beaconRoots "$BEACON_ROOTS" \
  '{accounts:{deployer:$deployer,oracle:$oracle,runner:$runner,recipient:$recipient,reward:$reward,failedDelivery:$failed,copier:$copier},
    tokens:{a:$tokenA,blockableA:$blockableA,b:$tokenB,wrappedA:$wrappedA,wrappedB:$wrappedB},
    verifiers:{a:$verifierA,b:$verifierB}, programKey:$program, multicall3:$multicall, beaconRoots:$beaconRoots, backend:$backend}' \
  > "$STATE_DIR/run.json"
e2e_log "done. See $STATE_DIR/deployment.json and $STATE_DIR/run.json"

# Step 7: the configuration of the proof producer. It names the environment variable of the RunPod key and holds no key.
dep() { jq -r ".$1.$2" "$STATE_DIR/deployment.json"; }
{
  if [ "$E2E_BACKEND" = oracle ]; then
    printf '[prover]\nbackend = "oracle"\noracle_key_env = "ORACLE_KEY"\n\n'
  else
    printf '[prover]\nbackend = "remote"\nremote_url = "%s"\nremote_api_key_env = "RUNPOD_API_KEY"\nremote_timeout_seconds = 900\n\n' "$E2E_RUNPOD_URL"
  fi
  printf '[handoff]\ntargets = ["stdout"]\n\n'
  route() { # name source_side source_chain_id source_kind source_prefix destination_side destination_chain_id
    printf '[routes.%s.source]\nchain_id = %s\nchain = "%s"\nbeacon_url = "%s/%s"\nrpc_url = "%s"\nbridge = "%s"\n\n' \
      "$1" "$3" "$4" "$E2E_BEACON" "$5" "$(dep "$2" rpc_url)" "$(dep "$2" bridge)"
    printf '[routes.%s.destination]\nchain_id = %s\nrpc_url = "%s"\nlight_client = "%s"\nbridge = "%s"\nstart_block = %s\n\n' \
      "$1" "$7" "$(dep "$6" rpc_url)" "$(dep "$6" light_client)" "$(dep "$6" bridge)" "$(dep "$6" start_block)"
  }
  route a_to_b chain_a 1 ethereum a chain_b 369
  route b_to_a chain_b 369 pulsechain b chain_a 1
} > "$STATE_DIR/prover.toml"
e2e_log "prover configuration: $STATE_DIR/prover.toml"
