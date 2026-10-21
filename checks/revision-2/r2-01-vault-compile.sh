#!/usr/bin/env bash
# R2-01: the verbatim revision 2 vault does not compile (4 indexed event parameters, error 7249).
# R2-11: after the one-word repair for R2-01, the vault still does not compile (stack too deep in withdraw).
# Also proves that the copies in src/revision-2/ differ from the specification only in the recorded ways.
# Copies the specification to a temporary directory first. Never edits spec/.
source "$(dirname "${BASH_SOURCE[0]}")/../lib.sh"

SPEC_VAULT="$SPEC_DIR/revision-2/Smart contracts/ZKBridgeVault.sol"
SPEC_CLIENT="$SPEC_DIR/revision-2/Smart contracts/LightClientSync.sol"
[ -f "$SPEC_VAULT" ] && [ -f "$SPEC_CLIENT" ] || { fail "R2-01 revision 2 contracts missing under spec/revision-2"; finish; }
command -v forge > /dev/null 2>&1 || { fail "R2-01 forge is not installed"; finish; }

SCRATCH="$(mktemp -d)"
trap 'rm -rf "$SCRATCH"' EXIT
mkdir -p "$SCRATCH/src"
cp "$ROOT_DIR/foundry.toml" "$ROOT_DIR/remappings.txt" "$SCRATCH/"
ln -s "$ROOT_DIR/lib" "$SCRATCH/lib"

build_in_scratch() { # <log>
  (cd "$SCRATCH" && forge build --root "$SCRATCH" --offline --force) > "$1" 2>&1
}

# ---- Stage 1: verbatim vault ----
cp "$SPEC_VAULT" "$SCRATCH/src/ZKBridgeVault.sol"
LOG1="$OUT_DIR/r2-01-verbatim.log"
if ! build_in_scratch "$LOG1" && grep -Eq '7249|Indexed expression has to be' "$LOG1"; then
  pass "R2-01 verbatim revision 2 vault fails forge build with error 7249 (more than 3 indexed parameters)"
else
  fail "R2-01 verbatim vault compiled or failed with another error (see $LOG1)"
fi
grep -E 'Error|-->' "$LOG1" | head -4 | sed 's/^/        /'

# ---- Control: the verbatim LightClientSync compiles, so the toolchain in the scratch directory works ----
rm "$SCRATCH/src/ZKBridgeVault.sol"
cp "$SPEC_CLIENT" "$SCRATCH/src/LightClientSync.sol"
LOGC="$OUT_DIR/r2-01-control-light-client.log"
if build_in_scratch "$LOGC"; then
  pass "R2-01 control: the verbatim LightClientSync builds in the same scratch project (so the failure above is the vault)"
else
  fail "R2-01 control: the verbatim LightClientSync did not build (see $LOGC)"
fi
rm "$SCRATCH/src/LightClientSync.sol"

# ---- Stage 2: only 'indexed' removed from nonce ----
sed 's/bytes32 indexed nonce, uint64 targetChainId/bytes32 nonce, uint64 targetChainId/' "$SPEC_VAULT" > "$SCRATCH/src/ZKBridgeVault.sol"
if diff <(tr -d '\r' < "$SPEC_VAULT") <(tr -d '\r' < "$SCRATCH/src/ZKBridgeVault.sol") | grep -c '^<' | grep -qx 1; then
  pass "R2-11 stage 2 differs from the specification in exactly one line (the DepositInitiated event)"
else
  fail "R2-11 stage 2 differs from the specification in more than one line"
fi
LOG2="$OUT_DIR/r2-11-after-indexed-repair.log"
if ! build_in_scratch "$LOG2" && grep -q 'Stack too deep' "$LOG2"; then
  pass "R2-11 after the R2-01 repair the vault still fails: Stack too deep in withdraw (needs viaIR or a refactor)"
else
  fail "R2-11 expected a 'Stack too deep' error after the R2-01 repair (see $LOG2)"
fi
grep -E 'Stack too deep|-->' "$LOG2" | head -3 | sed 's/^/        /'

# ---- Stage 3: the repaired copy in src/revision-2 builds ----
LOG3="$OUT_DIR/r2-01-repaired.log"
if (cd "$ROOT_DIR" && forge build --offline) > "$LOG3" 2>&1; then
  pass "R2-01 the repaired copies in src/revision-2 build with the repository configuration"
else
  fail "R2-01 the repaired copies do not build (see $LOG3)"
fi

# ---- The copies differ from the specification only in the recorded ways ----
SPEC_CLIENT_LF="$OUT_DIR/r2-spec-light-client.lf"
SPEC_VAULT_LF="$OUT_DIR/r2-spec-vault.lf"
tr -d '\r' < "$SPEC_CLIENT" > "$SPEC_CLIENT_LF"
tr -d '\r' < "$SPEC_VAULT" > "$SPEC_VAULT_LF"
if cmp -s "$SPEC_CLIENT_LF" "$ROOT_DIR/src/revision-2/LightClientSync.sol"; then
  pass "deviation: src/revision-2/LightClientSync.sol equals the specification with LF line endings (byte for byte)"
else
  fail "deviation: src/revision-2/LightClientSync.sol differs from the specification beyond line endings"
fi
# Vault: the event line (1 line) and the withdraw refactor (see docs/spec-deviations.md). Count removed lines.
REMOVED=$(diff "$SPEC_VAULT_LF" "$ROOT_DIR/src/revision-2/ZKBridgeVault.sol" | grep -c '^<')
info "vault: $REMOVED specification lines changed or removed (recorded in docs/spec-deviations.md, Revision 2)"
expect_match "deviation: repaired event has three indexed parameters" 'event DepositInitiated\(address indexed token, address indexed sender, address indexed recipient, uint256 amount, bytes32 nonce, uint64 targetChainId\);' "$ROOT_DIR/src/revision-2/ZKBridgeVault.sol"

finish
