#!/usr/bin/env bash
# Shared helpers for the local attack suite. Source this file. Do not run it.
#
# The suite attacks the network of docs/local-network.md. It needs the stack up (chains, deploy, prover, bots).
# Every key is a public Anvil development key: the attacker is Anvil account 9, and Anvil unlocks the accounts, so
# the scripts hold no key. The only signature the suite makes itself is the oracle signature of the light-client test.
#
# Set ATTACK_SCRATCH to a scratch directory before you source this file.

set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
: "${ATTACK_SCRATCH:?set ATTACK_SCRATCH to a scratch directory}"
mkdir -p "$ATTACK_SCRATCH"

COMPOSE=(docker compose -f "$ROOT/docker/compose.yaml")
MNEMONIC="test test test test test test test test test test test junk"
DEPLOY_IMAGE="zk-bridge-local-deploy:latest"
# The attack-evidence binary. Build it with: cargo build --offline --bin attack-evidence (in prover/).
EVIDENCE_BIN="${EVIDENCE_BIN:-$ROOT/prover/target/debug/attack-evidence}"

# ---------------------------------------------------------------------------------------------------- reports

blocked() { printf 'ATTACK %s: BLOCKED (%s)\n' "$1" "$2"; }
succeeded() { printf 'ATTACK %s: SUCCEEDED (%s)\n' "$1" "$2"; }
note() { printf 'NOTE %s\n' "$*"; }
fail_setup() { printf 'SETUP FAILED: %s\n' "$*" >&2; exit 2; }

# ---------------------------------------------------------------------------------------------------- deployment

# Reads /state/deployment.json from the prover container and sets RPC_A, TOKEN_A, VAULT_A, GATE_A, LC_A, and the same
# with _B. Also writes the prover configuration without its signer section, for attack-evidence.
load_deployment() {
  "${COMPOSE[@]}" exec -T prover cat /state/deployment.json > "$ATTACK_SCRATCH/deployment.json" \
    || fail_setup "cannot read /state/deployment.json; is the stack up?"
  local file="$ATTACK_SCRATCH/deployment.json" side
  for side in a b; do
    local upper
    upper="$(echo "$side" | tr a-z A-Z)"
    eval "RPC_$upper=$(jq -r ".chain_$side.rpc_url" "$file")"
    eval "CHAIN_ID_$upper=$(jq -r ".chain_$side.chain_id" "$file")"
    eval "TOKEN_$upper=$(jq -r ".chain_$side.token" "$file")"
    eval "VAULT_$upper=$(jq -r ".chain_$side.vault" "$file")"
    eval "GATE_$upper=$(jq -r ".chain_$side.gate" "$file")"
    eval "LC_$upper=$(jq -r ".chain_$side.light_client" "$file")"
  done
  GATE_GENESIS_TIME="$(jq -r .chain_a.gate_genesis_time "$file")"
  "${COMPOSE[@]}" exec -T prover cat /state/prover.toml \
    | awk 'BEGIN{skip=0} /^\[signer\]/{skip=1; next} /^\[/{skip=0} skip==0{print}' \
    | sed "s|^database_path = .*|database_path = \"$ATTACK_SCRATCH/unused.sqlite\"|" > "$ATTACK_SCRATCH/prover.toml"
  ATTACKER="$(cast wallet address --mnemonic "$MNEMONIC" --mnemonic-index 9)"
  ATTACKER_TWO="$(cast wallet address --mnemonic "$MNEMONIC" --mnemonic-index 8)"
  VICTIM="$(cast wallet address --mnemonic "$MNEMONIC" --mnemonic-index 7)"
  PROVER_ACCOUNT="$(cast wallet address --mnemonic "$MNEMONIC" --mnemonic-index 1)"
  DEPLOYER="$(cast wallet address --mnemonic "$MNEMONIC" --mnemonic-index 0)"
  export RPC_A RPC_B CHAIN_ID_A CHAIN_ID_B TOKEN_A TOKEN_B VAULT_A VAULT_B GATE_A GATE_B LC_A LC_B GATE_GENESIS_TIME
  export ATTACKER ATTACKER_TWO VICTIM PROVER_ACCOUNT DEPLOYER
  build_selector_table
}

# lower TEXT prints the text in lower case (bash 3.2 on macOS has no ${var,,}).
lower() { echo "$1" | tr A-Z a-z; }

# rpc_of a|b prints the URL of that chain.
rpc_of() { if [ "$1" = a ]; then echo "$RPC_A"; else echo "$RPC_B"; fi; }

# ---------------------------------------------------------------------------------------------------- revert decoding

# Writes "selector name(types)" lines for every custom error of the contracts, so a revert shows its name.
build_selector_table() {
  local table="$ATTACK_SCRATCH/selectors.txt" signature
  : > "$table"
  {
    grep -h -o 'error [A-Za-z0-9_]*([^)]*)' "$ROOT"/src/hardened/*.sol "$ROOT"/src/hardened/vendor/*.sol "$ROOT"/src/mocks/*.sol 2> /dev/null \
      | sed 's/^error //' \
      | awk '{
          line = $0; open = index(line, "("); name = substr(line, 1, open - 1);
          args = substr(line, open + 1, length(line) - open - 1); count = split(args, parts, ",");
          out = "";
          for (i = 1; i <= count; i++) {
            gsub(/^ +/, "", parts[i]); split(parts[i], words, " "); type = words[1];
            if (type == "GateMode") type = "uint8";
            if (type == "uint") type = "uint256";
            out = out (i > 1 ? "," : "") type;
          }
          if (args == "") out = "";
          print name "(" out ")";
        }'
    printf '%s\n' "ERC20InsufficientBalance(address,uint256,uint256)" "ERC20InsufficientAllowance(address,uint256,uint256)" \
      "SafeERC20FailedOperation(address)" "ReentrancyGuardReentrantCall()" "ECDSAInvalidSignature()" \
      "ERC20InvalidReceiver(address)" "ERC20InvalidSender(address)"
  } | sort -u | while read -r signature; do
    [ -n "$signature" ] && printf '%s %s\n' "$(cast sig "$signature")" "$signature" >> "$table"
  done
}

# decode_revert 0xdata prints a readable reason.
decode_revert() {
  local data="$1" selector signature
  if [ -z "$data" ] || [ "$data" = "0x" ]; then echo "revert with no data"; return; fi
  selector="${data:0:10}"
  if [ "$selector" = "0x08c379a0" ]; then
    echo "Error(\"$(cast abi-decode 'x(string)' "0x${data:10}" 2> /dev/null | head -1 | tr -d '"')\")"
    return
  fi
  if [ "$selector" = "0x4e487b71" ]; then echo "Panic(0x${data:${#data}-2})"; return; fi
  signature="$(grep -m1 "^$selector " "$ATTACK_SCRATCH/selectors.txt" | cut -d' ' -f2)"
  if [ -z "$signature" ]; then echo "unknown error $selector"; return; fi
  local arguments=""
  if [[ "$signature" != *"()" ]]; then
    arguments=" $(cast decode-error --sig "$signature" "$data" 2> /dev/null | sed -E 's/ \[[0-9.e+]+\]//g' | tr '\n' ' ' | cut -c1-150)"
  fi
  echo "${signature%%(*}${arguments:+ args:$arguments}"
}

# ---------------------------------------------------------------------------------------------------- calls

# call_raw RPC FROM TO DATA runs eth_call. Sets CALL_OK=1 and CALL_RESULT on success, CALL_OK=0 and CALL_REASON on a revert.
call_raw() {
  local output
  CALL_OK=0 CALL_RESULT="" CALL_REASON=""
  if output="$(cast rpc eth_call "{\"from\":\"$2\",\"to\":\"$3\",\"data\":\"$4\"}" latest --rpc-url "$1" 2>&1)"; then
    CALL_OK=1 CALL_RESULT="$output"
    return 0
  fi
  local data
  data="$(echo "$output" | grep -o 'data: "0x[0-9a-fA-F]*"' | tail -1 | grep -o '0x[0-9a-fA-F]*')"
  if [ -n "$data" ]; then
    CALL_REASON="$(decode_revert "$data")"
  else
    CALL_REASON="$(echo "$output" | head -1 | cut -c1-200)"
  fi
  return 1
}

# send_raw RPC FROM TO DATA [GAS_HEX] [GAS_PRICE_HEX] sends a transaction from an unlocked account and prints its hash.
send_raw() {
  local gas="${5:-0x7a1200}" price="${6:-}" fields
  fields="\"from\":\"$2\",\"to\":\"$3\",\"data\":\"$4\",\"gas\":\"$gas\""
  if [ -n "$price" ]; then fields="$fields,\"gasPrice\":\"$price\""; fi
  cast rpc eth_sendTransaction "{$fields}" --rpc-url "$1" 2>&1 | tr -d '"'
}

# wait_receipt RPC HASH prints the receipt JSON once it is mined (up to 60 seconds).
wait_receipt() {
  local receipt attempt
  for attempt in $(seq 1 240); do
    receipt="$(cast rpc eth_getTransactionReceipt "$2" --rpc-url "$1" 2> /dev/null)"
    if [ -n "$receipt" ] && [ "$receipt" != "null" ]; then echo "$receipt"; return 0; fi
    sleep 0.25
  done
  return 1
}

# send_wait RPC FROM TO DATA [GAS_HEX] [GAS_PRICE_HEX] sends and waits. Prints the receipt JSON. The hash is in the receipt.
send_wait() {
  SENT_HASH="$(send_raw "$@")"
  if [[ "$SENT_HASH" != 0x* ]]; then echo "{\"status\":\"0x0\",\"error\":\"$SENT_HASH\"}"; return 1; fi
  wait_receipt "$1" "$SENT_HASH"
}

# calldata SIGNATURE ARGS... prints the calldata of a function call.
calldata() { cast calldata "$@"; }

# token_balance RPC TOKEN HOLDER
token_balance() { cast call "$2" 'balanceOf(address)(uint256)' "$3" --rpc-url "$1" | awk '{print $1}'; }

# claimed_on RPC VAULT NONCE
claimed_on() { cast call "$2" 'claimed(bytes32)(bool)' "$3" --rpc-url "$1"; }

# mint_and_approve RPC TOKEN VAULT ACCOUNT AMOUNT
mint_and_approve() {
  send_wait "$1" "$4" "$2" "$(calldata 'mint(address,uint256)' "$4" "$5")" > /dev/null
  send_wait "$1" "$4" "$2" "$(calldata 'approve(address,uint256)' "$3" "$5")" > /dev/null
}

# ---------------------------------------------------------------------------------------------------- deposits

# gate_evidence_for_current_epoch RPC GATE prints the gate evidence bytes of the newest deposit of the current epoch
# that carried evidence, or 0x when the gate has confirmed the current epoch already.
gate_confirmed() { # RPC GATE: prints "yes" or "no"
  local confirmed current exists
  read -r confirmed exists < <(cast call "$2" 'confirmedEpoch()(uint64,bool)' --rpc-url "$1" | sed -E 's/ \[[0-9.e+]+\]//' | tr '\n' ' ')
  current="$(cast call "$2" 'currentEpoch()(uint256)' --rpc-url "$1" | awk '{print $1}')"
  if [ "$exists" = true ] && [ "$confirmed" = "$current" ]; then echo yes; else echo no; fi
}

# deposit_data TOKEN RECIPIENT AMOUNT [MAX_FEE] [EVIDENCE]
deposit_data() {
  calldata 'deposit(address,address,uint256,uint16,bytes)' "$1" "$2" "$3" "${4:-0}" "${5:-0x}"
}

# deposit_nonce_from_receipt RECEIPT_JSON VAULT prints the nonce of the first deposit log of that vault.
DEPOSIT_TOPIC="$(cast keccak 'DepositInitiated(address,address,address,uint256,bytes32,uint64,address,address)')"
deposit_nonce_from_receipt() {
  echo "$1" | jq -r --arg vault "$(lower "$2")" --arg topic "$DEPOSIT_TOPIC" \
    '[.logs[] | select((.address|ascii_downcase)==$vault and .topics[0]==$topic)][0].data' \
    | cut -c67-130 | sed 's/^/0x/'
}

# deposit_log_index RECEIPT_JSON VAULT prints the index of the deposit log inside the receipt.
deposit_log_index() {
  echo "$1" | jq -r --arg vault "$(lower "$2")" --arg topic "$DEPOSIT_TOPIC" \
    '[.logs | to_entries[] | select((.value.address|ascii_downcase)==$vault and .value.topics[0]==$topic) | .key][0]'
}

# wait_gate_confirmed RPC GATE waits (up to 90 seconds) until the gate confirmed the current epoch. The bots make the
# first deposit of each epoch, with the fork proof. A script that paused the bots lets them run until the gate is
# confirmed, then pauses them again.
wait_gate_confirmed() {
  local attempt woke=no
  for attempt in $(seq 1 90); do
    if [ "$(gate_confirmed "$1" "$2")" = yes ]; then
      [ "$woke" = yes ] && "${COMPOSE[@]}" pause bots > /dev/null 2>&1
      return 0
    fi
    if [ "$attempt" = 8 ] && [ "$(docker inspect -f '{{.State.Paused}}' zk-bridge-local-bots-1 2> /dev/null)" = true ]; then
      "${COMPOSE[@]}" unpause bots > /dev/null 2>&1
      woke=yes
    fi
    sleep 1
  done
  return 1
}

# ---------------------------------------------------------------------------------------------------- forge in the deploy image

# forge_create RPC CONTRACT ARGS... deploys from the deployer account with the Foundry of the deploy image.
# The image holds the compiled contracts, so nothing is built on the host. Prints the address.
forge_create() {
  local rpc="$1" contract="$2"
  shift 2
  local args=()
  if [ "$#" -gt 0 ]; then args=(--constructor-args "$@"); fi
  docker run --rm --network host --entrypoint forge "$DEPLOY_IMAGE" create "$contract" --rpc-url "$rpc" \
    --unlocked --from "$DEPLOYER" --broadcast --json ${args[@]+"${args[@]}"} 2> /dev/null \
    | sed -n 's/.*"deployedTo": *"\(0x[0-9a-fA-F]*\)".*/\1/p'
}

# ---------------------------------------------------------------------------------------------------- evidence

# evidence_variants ROUTE TX LOG_INDEX FILE writes name<TAB>calldata lines. evidence_proof prints one calldata.
evidence_variants() { "$EVIDENCE_BIN" --config "$ATTACK_SCRATCH/prover.toml" --route "$1" --tx "$2" --log-index "$3" variants > "$4"; }
evidence_layouts() { "$EVIDENCE_BIN" --config "$ATTACK_SCRATCH/prover.toml" --route "$1" --tx "$2" --log-index "$3" layouts; }
evidence_proof() { "$EVIDENCE_BIN" --config "$ATTACK_SCRATCH/prover.toml" --route "$1" --tx "$2" --log-index "$3" proof --wait-seconds "${4:-0}"; }

# A paid deposit of a route: prints "TX LOG_INDEX NONCE RECIPIENT AMOUNT" for the newest deposit that the
# destination vault already paid, among the last 40 deposits. The deposits come from the events of the source vault.
paid_deposit() { # a|b (source side)
  local source="$1" destination
  destination=$([ "$source" = a ] && echo b || echo a)
  local vault_source vault_destination
  vault_source=$([ "$source" = a ] && echo "$VAULT_A" || echo "$VAULT_B")
  vault_destination=$([ "$source" = a ] && echo "$VAULT_B" || echo "$VAULT_A")
  local logs
  logs="$(cast logs --rpc-url "$(rpc_of "$source")" --address "$vault_source" --from-block earliest --json "$DEPOSIT_TOPIC")"
  local count index
  count="$(echo "$logs" | jq length)"
  for index in $(seq $((count - 1)) -1 $((count > 40 ? count - 40 : 0))); do
    local nonce transaction
    nonce="$(echo "$logs" | jq -r ".[$index].data" | cut -c67-130 | sed 's/^/0x/')"
    transaction="$(echo "$logs" | jq -r ".[$index].transactionHash")"
    if [ "$(claimed_on "$(rpc_of "$destination")" "$vault_destination" "$nonce")" = true ]; then
      local receipt log_position
      receipt="$(cast rpc eth_getTransactionReceipt "$transaction" --rpc-url "$(rpc_of "$source")")"
      log_position="$(deposit_log_index "$receipt" "$vault_source")"
      echo "$transaction $log_position $nonce $(echo "$logs" | jq -r ".[$index].topics[3]" | sed 's/0x000000000000000000000000/0x/') $(echo "$logs" | jq -r ".[$index].data" | cut -c3-66 | sed 's/^/0x/')"
      return 0
    fi
  done
  return 1
}

# ---------------------------------------------------------------------------------------------------- attacker funds

MAX_UINT="0xffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff"

# fund_attacker mints a large balance of both tokens to the attacker and approves both vaults. The tokens have a
# public mint, so this costs nothing but gas.
fund_attacker() {
  local big="1000000000000000000000000"
  send_wait "$RPC_A" "$ATTACKER" "$TOKEN_A" "$(calldata 'mint(address,uint256)' "$ATTACKER" "$big")" > /dev/null
  send_wait "$RPC_A" "$ATTACKER" "$TOKEN_A" "$(calldata 'approve(address,uint256)' "$VAULT_A" "$MAX_UINT")" > /dev/null
  send_wait "$RPC_B" "$ATTACKER" "$TOKEN_B" "$(calldata 'mint(address,uint256)' "$ATTACKER" "$big")" > /dev/null
  send_wait "$RPC_B" "$ATTACKER" "$TOKEN_B" "$(calldata 'approve(address,uint256)' "$VAULT_B" "$MAX_UINT")" > /dev/null
}

# attacker_deposit SIDE RECIPIENT AMOUNT prints the receipt JSON of a successful deposit by the attacker.
# The gate wants evidence for the first deposit of an epoch. The bots supply it, so this waits for the gate.
attacker_deposit() {
  local side="$1" recipient="$2" amount="$3" rpc token vault gate attempt receipt
  rpc="$(rpc_of "$side")"
  if [ "$side" = a ]; then token="$TOKEN_A" vault="$VAULT_A" gate="$GATE_A"; else token="$TOKEN_B" vault="$VAULT_B" gate="$GATE_B"; fi
  for attempt in 1 2 3 4 5; do
    wait_gate_confirmed "$rpc" "$gate"
    receipt="$(send_wait "$rpc" "$ATTACKER" "$vault" "$(deposit_data "$token" "$recipient" "$amount")" 0x7a1200)"
    if [ "$(echo "$receipt" | jq -r .status)" = "0x1" ]; then echo "$receipt"; return 0; fi
  done
  return 1
}
