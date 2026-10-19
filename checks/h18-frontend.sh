#!/usr/bin/env bash
# H-18 / H-22: the specification's frontend does not typecheck and contradicts "no backend".
source "$(dirname "${BASH_SOURCE[0]}")/lib.sh"

FE="$CHECKS_DIR/frontend"
APP_SRC="$SPEC_DIR/Frontend/src/components/BridgeInterface.tsx"
WORKER_SRC="$SPEC_DIR/Frontend/src/workers/zkProver.worker.ts"
[ -f "$APP_SRC" ] && [ -f "$WORKER_SRC" ] || { fail "H-18 spec frontend files missing"; finish; }

mkdir -p "$FE/src/components" "$FE/src/workers"
cp "$APP_SRC" "$FE/src/components/BridgeInterface.tsx"
cp "$WORKER_SRC" "$FE/src/workers/zkProver.worker.ts"

# Install only the exact versions pinned in package.json. No install scripts run.
if [ ! -x "$FE/node_modules/.bin/tsc" ]; then
  npm install --prefix "$FE" --ignore-scripts --no-audit --no-fund > "$OUT_DIR/h18-npm-install.log" 2>&1 \
    || { fail "H-18 npm install failed (see $OUT_DIR/h18-npm-install.log)"; finish; }
fi
TSC="$FE/node_modules/.bin/tsc"
info "typescript $("$TSC" --version), viem $(node -p "require('$FE/node_modules/viem/package.json').version"), react $(node -p "require('$FE/node_modules/react/package.json').version")"

# Guard: the hostile package must NOT be installed by this harness.
if [ -e "$FE/node_modules/@succinctlabs" ]; then
  fail "H-21 safety: @succinctlabs exists in node_modules; remove it"; finish
fi

LOG_APP="$OUT_DIR/h18-tsc-app.log"
LOG_WORKER="$OUT_DIR/h18-tsc-worker.log"
"$TSC" -p "$FE/tsconfig.app.json" --pretty false > "$LOG_APP" 2>&1
APP_STATUS=$?
"$TSC" -p "$FE/tsconfig.worker.json" --pretty false > "$LOG_WORKER" 2>&1
WORKER_STATUS=$?

[ $APP_STATUS -ne 0 ] && pass "H-18 BridgeInterface.tsx fails tsc --strict" || fail "H-18 BridgeInterface.tsx typechecks cleanly"
[ $WORKER_STATUS -ne 0 ] && pass "H-18 zkProver.worker.ts fails tsc --strict" || fail "H-18 zkProver.worker.ts typechecks cleanly"
sed 's/^/        /' "$LOG_APP" "$LOG_WORKER"

# Predicted errors. Each is a separate line, so a missing prediction shows up as a FAIL.
expect_match "H-18/H-21 worker: cannot resolve @succinctlabs/sp1-sdk" "error TS2307.*@succinctlabs/sp1-sdk" "$LOG_WORKER"
expect_match "H-18 app: window.ethereum is not typed (TS2339)" "error TS2339.*'ethereum'" "$LOG_APP"

# Predicted, but tsc does NOT reject the ABI strings: viem accepts `readonly unknown[]` as an abi.
# So the type check says nothing here. The runtime check below proves the break instead.
if grep -Eq "VAULT_ABI|abi" "$LOG_APP"; then
  info "NOTE: tsc reports an error that mentions the ABI (unexpected, see $LOG_APP)"
else
  info "NOTE: predicted tsc error on the human-readable ABI did NOT occur; viem's types accept it"
fi
RUNTIME_LOG="$OUT_DIR/h18-abi-runtime.log"
node "$FE/abi-runtime.mjs" "$APP_SRC" > "$RUNTIME_LOG" 2>&1
expect_match "H-18 runtime: viem encodeFunctionData throws on the spec's string ABI" "^RESULT=raw-strings-throw" "$RUNTIME_LOG"
expect_match "H-18 runtime control: the same signatures work through parseAbi" "^CONTROL=parseAbi-ok" "$RUNTIME_LOG"

# Static wiring checks.
expect_absent "H-18 BridgeInterface.tsx never references the worker"  "[Ww]orker|zkProver"   "$APP_SRC"
expect_absent "H-18 BridgeInterface.tsx never imports the prover SDK" "sp1-sdk|SP1Prover"     "$APP_SRC"
expect_match  "H-18 generateProof calls the server route /api/prove-deposit" "fetch\('/api/prove-deposit'" "$APP_SRC"
expect_absent "H-18 VAULT_ABI never goes through parseAbi"           "parseAbi"               "$APP_SRC"
expect_match  "H-18 worker expects the SP1Prover browser class"      "new SP1Prover\(\)"      "$WORKER_SRC"

finish
