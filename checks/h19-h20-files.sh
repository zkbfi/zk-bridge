#!/usr/bin/env bash
# H-19: the specification cites FORK_GUIDE.md but does not ship it.
# H-20: the specification ships no build manifests.
source "$(dirname "${BASH_SOURCE[0]}")/lib.sh"

[ -d "$SPEC_DIR" ] || { fail "H-19 spec directory missing"; finish; }

FORK_FILES=$(find "$SPEC_DIR" -iname 'FORK_GUIDE*')
if [ -z "$FORK_FILES" ]; then pass "H-19 no FORK_GUIDE file anywhere under spec/"; else fail "H-19 found: $FORK_FILES"; fi

# The citation lives in the screenshots (images), so a text grep over code cannot see it.
# Record whether any text file cites it, for honesty.
if grep -rIl 'FORK_GUIDE' "$SPEC_DIR" > "$OUT_DIR/h19-citations.txt" 2>/dev/null && [ -s "$OUT_DIR/h19-citations.txt" ]; then
  info "text files that cite FORK_GUIDE: $(cat "$OUT_DIR/h19-citations.txt" | tr '\n' ' ')"
else
  info "no text file under spec/ cites FORK_GUIDE (the citation is in the screenshot images)"
fi

for MANIFEST in Cargo.toml foundry.toml package.json remappings.txt Cargo.lock; do
  FOUND=$(find "$SPEC_DIR" -name "$MANIFEST")
  if [ -z "$FOUND" ]; then pass "H-20 no $MANIFEST under spec/"; else fail "H-20 found $MANIFEST: $FOUND"; fi
done

finish
