#!/usr/bin/env bash
# H-21: the npm package named in the setup notes does not exist (PASS = still nonexistent).
# H-22: the setup notes' tooling is stale. Reports facts from the npm registry.
# Needs network access. A network failure is a FAIL, never a silent PASS.
source "$(dirname "${BASH_SOURCE[0]}")/lib.sh"

TODAY="$(date -u +%Y-%m-%d)"
info "date (UTC): $TODAY"

# ---- H-21 ----
PACKAGE_URL='https://registry.npmjs.org/@succinctlabs%2fsp1-sdk'
SEARCH_URL='https://registry.npmjs.org/-/v1/search?text=scope:succinctlabs&size=250'

PACKAGE_STATUS=$(curl -s -o "$OUT_DIR/h21-package.json" -w '%{http_code}' --max-time 30 "$PACKAGE_URL")
if [ "$PACKAGE_STATUS" = "404" ]; then
  pass "H-21 $TODAY: GET @succinctlabs/sp1-sdk returns 404 (package does not exist; squattable)"
else
  fail "H-21 $TODAY: GET @succinctlabs/sp1-sdk returned HTTP $PACKAGE_STATUS (somebody may have registered it; inspect $OUT_DIR/h21-package.json before any install)"
fi

SEARCH_STATUS=$(curl -s -o "$OUT_DIR/h21-search.json" -w '%{http_code}' --max-time 30 "$SEARCH_URL")
SEARCH_TOTAL=$(node -p "try { JSON.parse(require('fs').readFileSync('$OUT_DIR/h21-search.json','utf8')).total } catch { 'unparseable' }")
if [ "$SEARCH_STATUS" = "200" ] && [ "$SEARCH_TOTAL" = "0" ]; then
  pass "H-21 $TODAY: registry search scope:succinctlabs returns 0 packages"
else
  fail "H-21 $TODAY: registry search returned HTTP $SEARCH_STATUS with total=$SEARCH_TOTAL (scope may now hold packages)"
fi

# ---- H-22 ----
NEXT_VERSION=$(npm view next version 2>/dev/null)
NEXT_MODIFIED=$(npm view next time.modified 2>/dev/null)
WORKER_VERSION=$(npm view worker-loader version 2>/dev/null)
WORKER_PUBLISHED=$(npm view worker-loader "time[$WORKER_VERSION]" 2>/dev/null)
info "next latest: $NEXT_VERSION (registry record modified $NEXT_MODIFIED)"
info "worker-loader latest: $WORKER_VERSION, published $WORKER_PUBLISHED"
WORKER_PEERS=$(npm view worker-loader peerDependencies --json 2>/dev/null | tr -d '\n ')
info "worker-loader peerDependencies: $WORKER_PEERS"

# PASS when worker-loader's newest release is more than two years old (abandoned for a 2026 toolchain).
WORKER_YEAR="${WORKER_PUBLISHED%%-*}"
if [ -n "$WORKER_YEAR" ] && [ "$WORKER_YEAR" -le "$(( ${TODAY%%-*} - 2 ))" ]; then
  pass "H-22 worker-loader last published $WORKER_PUBLISHED, over two years ago (webpack-only loader, unmaintained)"
else
  fail "H-22 worker-loader was published recently ($WORKER_PUBLISHED); the staleness claim does not hold"
fi

NEXT_MAJOR="${NEXT_VERSION%%.*}"
if [ -n "$NEXT_MAJOR" ] && [ "$NEXT_MAJOR" -ge 16 ]; then
  pass "H-22 next latest is $NEXT_VERSION (major $NEXT_MAJOR, so create-next-app@latest gives a Next.js 16 project)"
else
  fail "H-22 next latest is $NEXT_VERSION, below 16; the Turbopack-default claim does not apply"
fi

# The Next.js 16 release post is the primary source for the Turbopack default.
DOC_URL='https://nextjs.org/blog/next-16'
curl -sL --max-time 30 "$DOC_URL" | sed 's/<[^>]*>/ /g' | tr -s ' \n' ' ' > "$OUT_DIR/h22-next16-post.txt"
if grep -Fq 'Turbopack is now the default bundler for all apps; opt out with next build --webpack' "$OUT_DIR/h22-next16-post.txt"; then
  pass "H-22 $DOC_URL says: Turbopack is now the default bundler for all apps; opt out with next build --webpack (the notes' webpack() patch only applies with --webpack)"
else
  fail "H-22 could not find the Turbopack default sentence at $DOC_URL (page changed or network failure)"
fi

finish
