#!/usr/bin/env bash
# R2-02 .. R2-06: the revision 2 circuit (spec/revision-2/bridge circuits/src/main.rs).
# Static greps, a compile check of the verbatim file, and a native run of the repaired file against real
# block headers, real receipts tries, and real Merkle-Patricia proofs (circuit-probe/).
# No SP1 toolchain is installed or used. `sp1_zkvm` is a local stub in circuit-probe/stub/.
# Reads spec/ only. Writes generated files to circuit-probe/generated/ (ignored by git) and logs to checks/.out/.
source "$(dirname "${BASH_SOURCE[0]}")/../lib.sh"

SPEC_MAIN="$SPEC_DIR/revision-2/bridge circuits/src/main.rs"
PROBE_DIR="$CHECKS_DIR/revision-2/circuit-probe"
MAIN_LF="$OUT_DIR/r2-main.lf.rs"
[ -f "$SPEC_MAIN" ] || { fail "R2 revision 2 main.rs missing: $SPEC_MAIN"; finish; }
tr -d '\r' < "$SPEC_MAIN" > "$MAIN_LF"
# Code without line comments: the comments talk about pairings, the code does not.
MAIN_CODE="$OUT_DIR/r2-main.code.rs"
sed 's#//.*$##' "$MAIN_LF" > "$MAIN_CODE"

# ------------------------------------------------------------------ R2-02: the topic constant
SIGNATURE='DepositInitiated(address,address,address,uint256,bytes32,uint64)'
CIRCUIT_TOPIC="0x$(grep -E 'const DEPOSIT_EVENT_SIG' "$MAIN_LF" | sed -E 's/.*fixed_bytes!\("([0-9a-f]+)"\).*/\1/')"
if command -v cast > /dev/null 2>&1; then
  REAL_TOPIC="$(cast keccak "$SIGNATURE")"
  info "circuit constant: $CIRCUIT_TOPIC"
  info "keccak256(\"$SIGNATURE\"): $REAL_TOPIC"
  if [ "$CIRCUIT_TOPIC" != "$REAL_TOPIC" ]; then
    pass "R2-02 the circuit's topic 0 constant differs from the keccak-256 of the event signature"
  else
    fail "R2-02 the circuit constant equals the real topic"
  fi
  case "$REAL_TOPIC" in 0x9bab*eaf5) pass "R2-02 the real topic is 0x9bab...eaf5, as docs/hardened-build-contract.md states";; *) fail "R2-02 the real topic is $REAL_TOPIC, which differs from the contract document";; esac
  for CANDIDATE in 'DepositInitiated(address,address,address,uint256,bytes32,uint64)' 'DepositInitiated(address,address,address,uint256,bytes32,bytes32,uint64)' 'DepositInitiated(address,address,address,uint256,bytes32,uint32)'; do
    [ "$(cast keccak "$CANDIDATE")" = "$CIRCUIT_TOPIC" ] && info "constant matches $CANDIDATE"
  done
else
  fail "R2-02 cast is not installed"
fi

# ------------------------------------------------------------------ R2-03: the BLS check
expect_match  "R2-03 the whole BLS check is a length test" 'let bls_is_valid = bls_aggregate_signature\.len\(\) == 96 && sync_committee_pubkeys\.len\(\) >= 342;' "$MAIN_LF"
expect_absent "R2-03 no pairing, hash-to-curve, or aggregate-verify call anywhere" 'pairing|hash_to_curve|blst|aggregate_verify|fast_aggregate|verify_signature|G1|G2' "$MAIN_CODE"
expect_absent "R2-03 no committee root or public key commitment is read, checked, or committed" 'committee_root|sync_committee_root|pubkeys_root|hash_tree_root|merkle' "$MAIN_CODE"
SIGNATURE_USES=$(grep -c 'bls_aggregate_signature' "$MAIN_LF")
KEY_USES=$(grep -c 'sync_committee_pubkeys' "$MAIN_LF")
if [ "$SIGNATURE_USES" -eq 2 ] && [ "$KEY_USES" -eq 2 ]; then
  pass "R2-03 the signature and the keys are each used twice only (read, then the length test)"
else
  fail "R2-03 expected 2 uses each, got signature=$SIGNATURE_USES keys=$KEY_USES"
fi
expect_absent "R2-03 the signed message (header root, slot, domain) never reaches the check" 'signing_root|compute_domain|DOMAIN_SYNC' "$MAIN_LF"

# ------------------------------------------------------------------ R2-04, R2-05, R2-06: static evidence
expect_match  "R2-04 the circuit calls alloy_trie::verify_proof at the crate root and keeps its return value" 'let verified_value = alloy_trie::verify_proof\(' "$MAIN_LF"
expect_match  "R2-04 it then compares that value with the expected receipt bytes" 'assert_eq!\(verified_value, expected_receipt_bytes' "$MAIN_LF"
expect_match  "R2-05 the receipt is decoded from the proven bytes as a bare RLP list" 'Receipt::decode\(&mut &expected_receipt_bytes' "$MAIN_LF"
expect_absent "R2-05 no EIP-2718 type byte handling anywhere" '2718|ReceiptEnvelope|TxType|expected_receipt_bytes\[0\]|0x02|0x01' "$MAIN_LF"
expect_match  "R2-06 the loop breaks after the first matching log" '^\s*break;' "$MAIN_LF"
expect_match  "R2-06 a log that matches address and topic is asserted field by field (a mismatch panics)" 'assert_eq!\(decoded_nonce, public_inputs\.deposit_nonce' "$MAIN_LF"
expect_absent "R2-06 the witness carries no log index" 'log_index' "$MAIN_LF"

# ------------------------------------------------------------------ compile evidence (plain cargo, stub sp1_zkvm)
command -v cargo > /dev/null 2>&1 || { fail "R2 cargo is not installed; compile and run evidence skipped"; finish; }
mkdir -p "$PROBE_DIR/generated"

# Stage 1: verbatim file against the stub. Expect compiler errors.
cp "$MAIN_LF" "$PROBE_DIR/generated/main.rs"
LOG1="$OUT_DIR/r2-circuit-verbatim.log"
(cd "$PROBE_DIR" && cargo check --color never --bin circuit) > "$LOG1" 2>&1
STATUS1=$?
if [ $STATUS1 -ne 0 ] && grep -Eq '^error\[E[0-9]+\]' "$LOG1"; then
  pass "R2-04 verbatim main.rs fails cargo check ($(grep -Ec '^error\[E' "$LOG1") compiler errors, sp1_zkvm replaced by a stub)"
else
  fail "R2-04 verbatim main.rs compiled or failed without a compiler error (see $LOG1)"
fi
grep -E '^error' "$LOG1" | sed 's/^/        /'
if grep -Eq 'E0425.*verify_proof|cannot find function `verify_proof` in crate `alloy_trie`' "$LOG1"; then
  pass "R2-04 the compiler: no function verify_proof at the root of alloy_trie"
else
  fail "R2-04 expected the verify_proof resolution error (see $LOG1)"
fi
if grep -Eq 'no function or associated item named `decode` found for struct `Receipt' "$LOG1"; then
  pass "R2-05 the compiler: Receipt has no decode function (the bare receipt cannot be decoded like this)"
else
  fail "R2-05 expected the Receipt::decode error (see $LOG1)"
fi
grep -q 'abi_decode' "$LOG1" && info "alloy-sol-types API drift also reported: abi_decode lost its second argument"

# Stage 2: the minimal compile repairs (compile-fixes.patch) plus a native entry point. Logic is unchanged.
cp "$MAIN_LF" "$PROBE_DIR/generated/main.rs"
(cd "$PROBE_DIR" && patch -s -p0 < compile-fixes.patch) || { fail "R2 compile-fixes.patch does not apply"; finish; }
sed -i.bak '/^#!\[no_main\]$/d' "$PROBE_DIR/generated/main.rs" && rm -f "$PROBE_DIR/generated/main.rs.bak"
LOG2="$OUT_DIR/r2-circuit-repaired.log"
(cd "$PROBE_DIR" && cargo build --color never) > "$LOG2" 2>&1
if [ $? -eq 0 ]; then
  pass "R2-04 with only the API repairs (verify_proof path and signature, Receipt decode, abi_decode) the circuit compiles"
else
  fail "R2-04 the repaired circuit does not compile (see $LOG2)"
  grep -E '^error' "$LOG2" | sed 's/^/        /'
  finish
fi

# ------------------------------------------------------------------ run evidence
WITNESS="$CARGO_TARGET_DIR/debug/witness"
CIRCUIT="$CARGO_TARGET_DIR/debug/circuit"
RUN_LOG=""
# run_scenario <name>: builds the witness for the scenario and runs the circuit on it.
run_scenario() {
  RUN_LOG="$OUT_DIR/r2-run-$1.log"
  "$WITNESS" "$1" "$OUT_DIR/r2-witness-$1.bin" || { RUN_LOG=""; return 99; }
  "$CIRCUIT" < "$OUT_DIR/r2-witness-$1.bin" > "$RUN_LOG" 2>&1
}
expect_accepts() { # <label> <scenario>
  run_scenario "$2"; local status=$?
  if [ $status -eq 0 ] && grep -q '^COMMIT:' "$RUN_LOG"; then pass "$1"; else fail "$1 (exit $status, see $RUN_LOG)"; fi
}
expect_panics() { # <label> <scenario> <message fragment>
  run_scenario "$2"; local status=$?
  if [ $status -ne 0 ] && grep -Fq -- "$3" "$RUN_LOG"; then pass "$1"; else fail "$1 (exit $status, expected '$3', see $RUN_LOG)"; fi
}

# Control for every run test below: the honest witness (bare receipt, the circuit's own topic) is accepted.
expect_accepts "control: a real header, trie, proof, and bare receipt with the circuit's own topic is accepted" control-pass

expect_panics "R2-02 a deposit log with the vault's REAL topic 0 is never matched: 'event not verified'" real-topic "Target Bridge Deposit Event not verified"

expect_panics "R2-05 the same receipt as a type 2 receipt (0x02 || rlp) cannot be decoded" typed-receipt "Failed to decode transaction receipt container"

expect_accepts "R2-06 control: with two deposits in one transaction, the FIRST can be proven" two-deposits-prove-first
expect_panics  "R2-06 the SECOND deposit in the same transaction cannot be proven: the first match panics" two-deposits-prove-second "Mismatched active unique nonce"

expect_accepts "R2-03 a 96 byte signature of zeros and 342 keys of zeros are accepted: nothing is verified" bls-zeros
expect_panics  "R2-03 control: a 95 byte signature is refused" bls-short-signature "BLS12-381 Consensus Attestation Fault"
expect_panics  "R2-03 control: 341 keys are refused" bls-few-keys "BLS12-381 Consensus Attestation Fault"

finish
