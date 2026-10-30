#!/usr/bin/env bash
# Promotes a staging release (the next channel, served at next.zkb.fi) to production (zkb.fi) without rebuilding the
# dapp or the docs: their archives are copied, so production serves the exact content addresses that were tried on
# staging. Only the landing page is rebuilt, from the same commit, with the production configuration, because each
# landing page embeds the one key it trusts (production never trusts the staging key).
#
# Usage:   script/release/promote.sh <staging-release-directory> <output-directory> < production-release-key.jwk
#
# Steps:
#   1. verifies the staging release against the staging key (explorer/landing/landing.next.config.json)
#   2. checks the staging commit is a full SHA already on origin/main (production ships only what is on main), builds
#      the landing page at that commit with landing.config.json, and checks it trusts exactly the operator's
#      production keys (script/release/promote-checks.sh)
#   3. writes the production version.json (channels.stable, sequence = production + 1) with the same dapp and docs
#      archives, the new landing archive and the same downloads; refuses if a kept archive differs from staging
#   4. signs it with the production key from standard input, then verifies it against landing.config.json
#   5. with PROMOTE_PUBLISH=1, runs publish.sh and publish-pages.sh for zkb.fi (their own settings apply)
#
# Keys are explicit, never taken from the releases: the input is verified against the staging key only, the output
# against the production key only.
#
# Environment:
#   PROMOTE_VERSION            the production version (default: the staging version without its -next.N suffix)
#   RELEASE_PREVIOUS_MANIFEST  the production version.json now live (default: fetched from https://zkb.fi/version.json)
#   PROMOTE_PUBLISH=1          also publish (pin, push to main of the release repository, deploy zkb.fi)
set -euo pipefail

if [ "$#" -ne 2 ]; then
  echo "usage: $0 <staging-release-directory> <output-directory> < production-release-key.jwk" >&2
  exit 2
fi

repository_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
# shellcheck source=script/release/promote-checks.sh
. "$repository_root/script/release/promote-checks.sh"
staging="$(cd "$1" && pwd)"
mkdir -p "$2"
out="$(cd "$2" && pwd)"
cli=(node "$repository_root/explorer/release/src/cli.ts")

if ! "${cli[@]}" verify "$staging" --public-keys "$repository_root/explorer/landing/landing.next.config.json" </dev/null; then
  echo "the staging release does not verify against the staging key, so nothing is promoted" >&2
  exit 1
fi

read -r staging_version commit <<<"$(node -e '
const m = JSON.parse(require("fs").readFileSync(process.argv[1], "utf8"));
const dapp = m.releases.find((r) => r.name === "dapp");
console.log(`${m.channels.next} ${dapp.commit}`);
' "$staging/version.json")"
version="${PROMOTE_VERSION:-${staging_version%%-next.*}}"
# The commit comes from a manifest signed only by the staging key: it must be a full SHA already on origin/main.
promote_check_commit "$repository_root" "$commit"

work="$(mktemp -d)"
cleanup() { git -C "$repository_root" worktree remove --force "$work/source" >/dev/null 2>&1 || true; rm -rf "$work"; }
trap cleanup EXIT

echo "== landing page at $commit, production configuration"
git -C "$repository_root" worktree add --quiet --detach "$work/source" "$commit" </dev/null
(cd "$work/source/explorer/landing" && LANDING_CONFIG=landing.config.json LANDING_OUT="$work/landing" node scripts/build.ts) </dev/null
# The page must trust exactly the operator's production keys, whatever the staging commit's configuration says.
promote_check_landing_keys "$work/landing" "$repository_root/explorer/landing/landing.config.json" \
  "$repository_root/explorer/landing/landing.next.config.json"
"${cli[@]}" pack "$work/landing" "$work/landing.car" </dev/null

previous="${RELEASE_PREVIOUS_MANIFEST:-}"
if [ -z "$previous" ]; then
  previous="$work/previous.json"
  curl -fsS https://zkb.fi/version.json -o "$previous" </dev/null
fi

echo "== production manifest $version"
"${cli[@]}" promote "$staging" "$out" --landing "$work/landing.car" --version "$version" \
  --published-at "$(date -u +%Y-%m-%dT%H:%M:%SZ)" --previous "$previous" </dev/null
# The only step that reads standard input: the production release key.
"${cli[@]}" sign "$out"
"${cli[@]}" verify "$out" --public-keys "$repository_root/explorer/landing/landing.config.json" </dev/null

if [ "${PROMOTE_PUBLISH:-}" = "1" ]; then
  # Promotion always publishes to production: the channel is fixed here, never taken from the environment or the release.
  RELEASE_CHANNEL=stable RELEASE_PUBLIC_KEYS="$repository_root/explorer/landing/landing.config.json" \
    "$repository_root/script/release/publish.sh" "$out" </dev/null
  RELEASE_CHANNEL=stable RELEASE_PUBLIC_KEYS="$repository_root/explorer/landing/landing.config.json" \
    RELEASE_PAGES_LANDING=zkb-fi RELEASE_LANDING_DOMAINS=zkb.fi,www.zkb.fi \
    "$repository_root/script/release/publish-pages.sh" "$out" </dev/null
fi
