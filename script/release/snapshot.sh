#!/usr/bin/env bash
# Takes the screenshots of the app that the landing page shows: the bridge screen after the loader, light and dark,
# at desktop width (snapshot-light.webp, snapshot-dark.webp, snapshot.json), plus snapshot-og.jpg (1200x630, for link previews) in <output-directory>.
#
# The screenshots come from a build of this commit's dapp on the sample data (VITE_EXPLORER_DATA=fixture), so they
# need no network, indexer or wallet. The dapp that is published is built separately by release.sh.
#
# It never fails a release: when anything goes wrong it says so, removes partial output and exits 0, and the landing
# page is then built without a snapshot block. RELEASE_SKIP_SNAPSHOT=1 skips it on purpose.
#
# Usage: script/release/snapshot.sh <output-directory>
set -uo pipefail

if [ "$#" -ne 1 ]; then
  echo "usage: $0 <output-directory>" >&2
  exit 2
fi
output="$1"
repository_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
mkdir -p "$output"

skip() {
  echo "no snapshot: $1; the landing page is built without one" >&2
  rm -f "$output"/snapshot-light.webp "$output"/snapshot-dark.webp "$output"/snapshot.json "$output"/snapshot-og.jpg
  exit 0
}

if [ "${RELEASE_SKIP_SNAPSHOT:-}" = "1" ]; then skip "RELEASE_SKIP_SNAPSHOT=1"; fi

work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT
(cd "$repository_root/explorer" && VITE_EXPLORER_DATA=fixture pnpm --filter @zk-bridge/web exec vite build --outDir "$work/dapp" --emptyOutDir) </dev/null >"$work/build.log" 2>&1 \
  || { tail -n 5 "$work/build.log" >&2; skip "the sample build of the dapp failed"; }
(cd "$repository_root/explorer/web" && node scripts/capture-snapshot.ts "$work/dapp" "$output") </dev/null \
  || skip "the headless capture failed"
for file in snapshot-light.webp snapshot-dark.webp snapshot.json snapshot-og.jpg; do
  [ -s "$output/$file" ] || skip "$file was not written"
done
echo "snapshot ok: $output"
