#!/usr/bin/env bash
# Shared helpers for the red-team checks. Source this file; do not run it.
# PASS means "the hole is confirmed". FAIL means "the hole did not show up".

CHECKS_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(cd "$CHECKS_DIR/.." && pwd)"
SPEC_DIR="$ROOT_DIR/spec"
OUT_DIR="$CHECKS_DIR/.out"
export CARGO_TARGET_DIR="$CHECKS_DIR/target"
mkdir -p "$OUT_DIR"

CHECK_FAILURES=0

pass() { printf 'PASS  %s\n' "$1"; }
fail() { printf 'FAIL  %s\n' "$1"; CHECK_FAILURES=$((CHECK_FAILURES + 1)); }
info() { printf '      %s\n' "$1"; }

# expect_match <label> <extended-regex> <file>
# PASS when the pattern is found in the file.
expect_match() {
  if grep -Eq -- "$2" "$3"; then pass "$1"; else fail "$1 (pattern not found: $2)"; fi
}

# expect_absent <label> <extended-regex> <file>
# PASS when the pattern is NOT found in the file.
expect_absent() {
  if grep -Eq -- "$2" "$3"; then fail "$1 (pattern found: $2)"; else pass "$1"; fi
}

# show_matches <extended-regex> <file>: print matching lines, indented.
show_matches() {
  grep -En -- "$1" "$2" | sed 's/^/        /' || true
}

finish() { exit $((CHECK_FAILURES > 0 ? 1 : 0)); }
