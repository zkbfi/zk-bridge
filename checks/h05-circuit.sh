#!/usr/bin/env bash
# H-05: the specification's "circuit" is not a zkVM program and does not compile.
# Stage 1: the verbatim spec file. Stage 2: only the closure fix. Stage 3: closure fix
# plus the renamed alloy constructor, to see what the compiler says once it gets further.
source "$(dirname "${BASH_SOURCE[0]}")/lib.sh"

SPEC_MAIN="$SPEC_DIR/bridge circuits/src/main.rs"
[ -f "$SPEC_MAIN" ] || { fail "H-05 spec main.rs missing: $SPEC_MAIN"; finish; }

# Copy <crate-dir> from the template manifest, with the spec file (optionally patched by sed).
prepare_crate() { # <dir> <package-name> <sed-script or ''>
  mkdir -p "$1/src"
  sed "s/^name = .*/name = \"$2\"/" "$CHECKS_DIR/rust-circuit/Cargo.toml" > "$1/Cargo.toml"
  if [ -n "$3" ]; then sed "$3" "$SPEC_MAIN" > "$1/src/main.rs"; else cp "$SPEC_MAIN" "$1/src/main.rs"; fi
}

run_check() { # <dir> <log>
  cargo check --color never --manifest-path "$1/Cargo.toml" > "$2" 2>&1
}

# ---- Stage 1: verbatim ----
mkdir -p "$CHECKS_DIR/rust-circuit/src"
cp "$SPEC_MAIN" "$CHECKS_DIR/rust-circuit/src/main.rs"
LOG1="$OUT_DIR/h05-original.log"
run_check "$CHECKS_DIR/rust-circuit" "$LOG1"
STATUS1=$?
if [ $STATUS1 -ne 0 ] && grep -Eq '^error\[E[0-9]+\]' "$LOG1"; then
  pass "H-05 verbatim spec main.rs fails cargo check ($(grep -Ec '^error\[E' "$LOG1") compiler errors)"
else
  fail "H-05 verbatim spec main.rs compiled or failed without a compiler error (see $LOG1)"
fi
grep -E '^error' "$LOG1" | sed 's/^/        /'
grep -E -A1 '^error\[E' "$LOG1" | grep -E '^\s+--> ' | sed 's/^/        /'
if grep -Eq 'ok_or_else|FnOnce' "$LOG1"; then
  info "ok_or_else error IS reported in stage 1"
else
  info "ok_or_else error is NOT reported in stage 1 (masked by earlier type errors)"
fi
info "resolved alloy: $(grep -A1 '^name = "alloy"$' "$CHECKS_DIR/rust-circuit/Cargo.lock" | tail -1)"

# ---- Static greps: not a zkVM program ----
expect_absent "H-05 no sp1_zkvm entrypoint macro"       'entrypoint!'         "$SPEC_MAIN"
expect_absent "H-05 no sp1_zkvm reference at all"       'sp1_zkvm'            "$SPEC_MAIN"
expect_absent "H-05 no #![no_main]"                     'no_main'             "$SPEC_MAIN"
expect_absent "H-05 no commit of public values"         'commit'              "$SPEC_MAIN"
expect_match  "H-05 uses an async runtime (#[tokio::main])" 'tokio::main'     "$SPEC_MAIN"
expect_match  "H-05 makes network calls (on_http)"      'on_http|get_transaction_receipt' "$SPEC_MAIN"
expect_absent "H-05 no trie or proof verification call" 'verify|ordered_trie_root|HashBuilder|Nibbles|proof_verif' "$SPEC_MAIN"

# ---- Stage 2: only the closure fix ----
FIX_A="$CHECKS_DIR/rust-circuit-fixed"
prepare_crate "$FIX_A" spec-circuit-closure-fix 's/ok_or_else( eyre::eyre!/ok_or_else(|| eyre::eyre!/'
LOG2="$OUT_DIR/h05-closure-fix.log"
run_check "$FIX_A" "$LOG2"
if [ $? -ne 0 ]; then
  pass "H-05 closure fix alone is not enough: cargo check still fails"
else
  info "closure fix alone compiles"
fi
grep -E '^error' "$LOG2" | sed 's/^/        /'

# ---- Stage 3: closure fix plus renamed constructor (alloy dropped on_http) ----
FIX_B="$CHECKS_DIR/rust-circuit-fixed-2"
CLOSURE='s/ok_or_else( eyre::eyre!/ok_or_else(|| eyre::eyre!/'
RENAME='s/\.on_http(/.connect_http(/'
prepare_crate "$FIX_B" spec-circuit-rename-fix "$CLOSURE; $RENAME"
LOG3="$OUT_DIR/h05-rename-fix.log"
run_check "$FIX_B" "$LOG3"
if [ $? -ne 0 ]; then
  pass "H-05 closure fix + connect_http rename still fails (more alloy API drift)"
else
  info "closure fix + connect_http compiles"
fi
grep -E '^error' "$LOG3" | sed 's/^/        /'
grep -E -A1 '^error\[E' "$LOG3" | grep -E '^\s+--> ' | sed 's/^/        /'

# ---- Stage 4: every alloy API fix, but NOT the closure fix: reveals the ok_or_else error ----
APIFIX="$RENAME; s/, false)\.await/).await/; s/get_block_receipts(BlockNumberOrTag::Number(block_number))/get_block_receipts(block_number.into())/"
FIX_C="$CHECKS_DIR/rust-circuit-fixed-3"
prepare_crate "$FIX_C" spec-circuit-closure-bug-only "$APIFIX"
LOG4="$OUT_DIR/h05-closure-bug-only.log"
run_check "$FIX_C" "$LOG4"
if [ $? -ne 0 ] && grep -Eq 'ok_or_else|FnOnce|expected function' "$LOG4"; then
  pass "H-05 with alloy API fixed, the original ok_or_else(eyre::eyre!(..)) still fails"
else
  fail "H-05 expected the ok_or_else non-closure error once the alloy API errors are gone (see $LOG4)"
fi
grep -E '^error' "$LOG4" | sed 's/^/        /'
grep -E -A1 '^error\[E' "$LOG4" | grep -E '^\s+--> ' | sed 's/^/        /'

# ---- Stage 5: every fix; does it compile, and does it verify anything? ----
FIX_D="$CHECKS_DIR/rust-circuit-fixed-4"
prepare_crate "$FIX_D" spec-circuit-all-fixes "$CLOSURE; $APIFIX"
LOG5="$OUT_DIR/h05-all-fixes.log"
run_check "$FIX_D" "$LOG5"
if [ $? -eq 0 ]; then
  info "all fixes applied: compiles"
  if grep -Eq 'unused variable: .serialized_proof_payload.' "$LOG5"; then
    pass "H-05 once it compiles, the built payload is never used (compiler: unused variable serialized_proof_payload)"
  else
    fail "H-05 expected unused-variable warning for serialized_proof_payload (see $LOG5)"
  fi
else
  info "all fixes applied: still does not compile"
  grep -E '^error' "$LOG5" | sed 's/^/        /'
  grep -E -A1 '^error\[E' "$LOG5" | grep -E '^\s+--> ' | sed 's/^/        /'
  fail "H-05 stage 5 expected to compile with all fixes (see $LOG5)"
fi

finish
