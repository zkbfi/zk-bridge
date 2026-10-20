#!/usr/bin/env bash
# H-17: the deploy script cannot deploy. H-06: each vault trusts its own chain's committee.
# This script only READS spec/Deployments/deploy.sh. It never executes it.
# deploy.sh is bricked: every original line carries a "#BRICKED# " prefix, so patterns allow it.
source "$(dirname "${BASH_SOURCE[0]}")/lib.sh"

DEPLOY="$SPEC_DIR/Deployments/deploy.sh"
[ -f "$DEPLOY" ] || { fail "H-17 deploy.sh missing: $DEPLOY"; finish; }

# ---- Containment: the spec script must stay bricked ----
# Only the guard header may run: a shebang to /usr/bin/false, comments, one echo, and exit 1.
LIVE_LINES=$(grep -Ev '^(#|$|echo "deploy\.sh is bricked|exit 1$)' "$DEPLOY")
if [ -z "$LIVE_LINES" ] && head -1 "$DEPLOY" | grep -qx '#!/usr/bin/false'; then
  pass "containment: deploy.sh is bricked (no runnable original line)"
else
  fail "containment: deploy.sh has runnable lines; re-brick it before anything else"
fi

# ---- Syntax and linting (informational: a clean parse means every failure below is semantic) ----
if bash -n "$DEPLOY" 2> "$OUT_DIR/h17-bash-n.log"; then
  info "bash -n: no syntax errors (the script parses; its problems are semantic)"
else
  info "bash -n reports syntax errors: $(head -1 "$OUT_DIR/h17-bash-n.log")"
fi
if command -v shellcheck > /dev/null 2>&1; then
  shellcheck "$DEPLOY" > "$OUT_DIR/h17-shellcheck.log" 2>&1
  info "shellcheck: $(grep -c '^In ' "$OUT_DIR/h17-shellcheck.log") findings, see $OUT_DIR/h17-shellcheck.log"
else
  info "shellcheck not installed; skipped (not installed on purpose, Homebrew is broken here)"
fi

# ---- Folder names ----
expect_match "H-17 script does 'cd bridge-circuits'" '^(#BRICKED# )?cd bridge-circuits$' "$DEPLOY"
if [ -d "$SPEC_DIR/bridge-circuits" ]; then fail "H-17 folder bridge-circuits exists"; else pass "H-17 folder bridge-circuits does not exist"; fi
if [ -d "$SPEC_DIR/bridge circuits" ]; then pass "H-17 the real folder is 'bridge circuits' (with a space)"; else fail "H-17 folder 'bridge circuits' not found"; fi
expect_match "H-17 script does 'cd smart-contracts'" '^(#BRICKED# )?cd smart-contracts$' "$DEPLOY"
if [ -d "$SPEC_DIR/smart-contracts" ]; then fail "H-17 folder smart-contracts exists"; else pass "H-17 folder smart-contracts does not exist"; fi
if [ -d "$SPEC_DIR/Smart contracts" ]; then pass "H-17 the real folder is 'Smart contracts' (capital S, space)"; else fail "H-17 folder 'Smart contracts' not found"; fi

# ---- Shell environment ----
expect_match  "H-17 uses 'source ~/.bashrc' (macOS default shell is zsh)" '^(#BRICKED# )?source ~/\.bashrc' "$DEPLOY"
expect_match  "H-17 pipes remote installers into bash"                   'curl -L https://[^ ]+ \| bash' "$DEPLOY"
expect_absent "H-17 no 'set -o pipefail', so a failed forge inside \$(... | jq) is masked" 'pipefail' "$DEPLOY"

# ---- forge create statements (join backslash continuations into one line each) ----
STATEMENTS="$OUT_DIR/h17-forge-statements.txt"
awk '{ line = $0; if (sub(/\\$/, "", line)) { joined = joined line; next } print joined line; joined = "" }' "$DEPLOY" \
  | grep 'forge create' > "$STATEMENTS"
CREATE_COUNT=$(wc -l < "$STATEMENTS" | tr -d ' ')
BROADCAST_COUNT=$(grep -c -- '--broadcast' "$STATEMENTS")
if [ "$CREATE_COUNT" -eq 4 ] && [ "$BROADCAST_COUNT" -eq 0 ]; then
  pass "H-17 all $CREATE_COUNT 'forge create' statements lack --broadcast"
else
  fail "H-17 expected 4 forge create statements and 0 with --broadcast, got $CREATE_COUNT and $BROADCAST_COUNT"
fi
if forge create --help 2>/dev/null | grep -q -- '--broadcast'; then
  info "installed forge ($(forge --version | head -1)) has a --broadcast flag on 'forge create'"
fi

# ---- Placeholders reaching constructors ----
expect_match "H-17 placeholder INITIAL_ETH_COMMITTEE_ROOT is passed as a string"   '"INITIAL_ETH_COMMITTEE_ROOT"'   "$DEPLOY"
expect_match "H-17 placeholder INITIAL_PULSE_COMMITTEE_ROOT is passed as a string" '"INITIAL_PULSE_COMMITTEE_ROOT"' "$DEPLOY"
expect_match "H-17 placeholder CURRENT_PERIOD_INT is passed as a string"           '"CURRENT_PERIOD_INT"'           "$DEPLOY"
expect_match "H-17 placeholder verifier address 0xSP1Verifier... reaches --constructor-args" '--constructor-args "0xSP1Verifier' "$DEPLOY"
expect_match "H-17 placeholder deployer key"                                       'DEPLOYER_KEY="YOUR_REAL_DEPLOYER_PRIVATE_KEY"' "$DEPLOY"
expect_match "H-17 ETH_RPC is a marketing site, not an RPC endpoint"               '^(#BRICKED# )?export ETH_RPC="https://alchemy\.com"$' "$DEPLOY"

# ---- Verification key ----
VKEY_LINE=$(grep 'cargo prove vkey' "$DEPLOY")
if [ -n "$VKEY_LINE" ] && ! printf '%s' "$VKEY_LINE" | grep -Eq -- '--elf|--program'; then
  pass "H-17 'cargo prove vkey' has no --elf or --program argument"
else
  fail "H-17 'cargo prove vkey' line missing or already has --elf/--program: $VKEY_LINE"
fi

# ---- H-06: which committee root each chain's contracts get ----
# Each statement is classified by the RPC variable it targets and the contract it creates.
ETH_SYNC=$(grep 'LightClientSync' "$STATEMENTS" | grep -F -- '--rpc-url $ETH_RPC')
PULSE_SYNC=$(grep 'LightClientSync' "$STATEMENTS" | grep -F -- '--rpc-url $PULSE_RPC')
ETH_VAULT=$(grep 'ZKBridgeVault' "$STATEMENTS" | grep -F -- '--rpc-url $ETH_RPC')
PULSE_VAULT=$(grep 'ZKBridgeVault' "$STATEMENTS" | grep -F -- '--rpc-url $PULSE_RPC')
[ -n "$ETH_SYNC" ] && [ -n "$PULSE_SYNC" ] && [ -n "$ETH_VAULT" ] && [ -n "$PULSE_VAULT" ] \
  || { fail "H-06 could not classify the four forge create statements"; finish; }

has() { printf '%s' "$1" | grep -Fq -- "$2"; }
has "$ETH_SYNC"    'INITIAL_ETH_COMMITTEE_ROOT'   && pass "H-06 Ethereum-side LightClientSync gets INITIAL_ETH_COMMITTEE_ROOT (the Ethereum committee)" \
                                                  || fail "H-06 Ethereum-side LightClientSync does not get INITIAL_ETH_COMMITTEE_ROOT"
has "$PULSE_SYNC"  'INITIAL_PULSE_COMMITTEE_ROOT' && pass "H-06 PulseChain-side LightClientSync gets INITIAL_PULSE_COMMITTEE_ROOT (the PulseChain committee)" \
                                                  || fail "H-06 PulseChain-side LightClientSync does not get INITIAL_PULSE_COMMITTEE_ROOT"
has "$ETH_VAULT"   '$SYNC_ETH_ADDRESS'            && pass "H-06 Ethereum vault is wired to SYNC_ETH_ADDRESS, the Ethereum-side light client" \
                                                  || fail "H-06 Ethereum vault is not wired to SYNC_ETH_ADDRESS"
has "$PULSE_VAULT" '$SYNC_PULSE_ADDRESS'          && pass "H-06 PulseChain vault is wired to SYNC_PULSE_ADDRESS, the PulseChain-side light client" \
                                                  || fail "H-06 PulseChain vault is not wired to SYNC_PULSE_ADDRESS"
# A withdrawal on Ethereum proves a PulseChain deposit, so the Ethereum vault needs the PulseChain committee.
has "$ETH_VAULT" 'SYNC_PULSE_ADDRESS'  && fail "H-06 Ethereum vault IS wired to the PulseChain light client" \
                                        || pass "H-06 Ethereum vault never references SYNC_PULSE_ADDRESS (it cannot track PulseChain)"
has "$PULSE_VAULT" 'SYNC_ETH_ADDRESS'  && fail "H-06 PulseChain vault IS wired to the Ethereum light client" \
                                        || pass "H-06 PulseChain vault never references SYNC_ETH_ADDRESS (it cannot track Ethereum)"

finish
