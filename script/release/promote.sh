#!/usr/bin/env bash
# Promotes a staging release (the next channel, served at next.zkb.fi) to production (zkb.fi) without rebuilding the
# dapp (which holds the docs, at #/docs): its archive is copied, so production serves the exact content address that
# was tried on staging. Only the landing page is rebuilt, from the same commit, with the production configuration, because each
# landing page embeds the one key it trusts (production never trusts the staging key).
#
# Usage:   script/release/promote.sh <staging-release-directory> <output-directory> < production-release-key.jwk
#
# Steps:
#   1. verifies the staging release against the staging key (explorer/landing/landing.next.config.json)
#   2. checks the staging commit is a full SHA already on origin/main (production ships only what is on main), builds
#      the landing page at that commit with landing.config.json, and checks it trusts exactly the operator's
#      production keys (script/release/promote-checks.sh)
#   3. writes the production version.json (channels.stable, sequence = production + 1) with the same dapp
#      archive, the new landing archive and the same downloads; refuses if a kept archive differs from staging
#   4. writes the production releases-log.json: the published stable log (checked against landing.config.json) with
#      the production sites appended
#   5. signs version.json and releases-log.json with the production key from standard input, then verifies both
#      against landing.config.json
#   6. with PROMOTE_PUBLISH=1, runs publish.sh and publish-pages.sh for zkb.fi (their own settings apply)
#
# Keys are explicit, never taken from the releases: the input is verified against the staging key only, the output
# against the production key only.
#
# Environment:
#   PROMOTE_VERSION            the production version (default: the staging version without its -next.N suffix)
#   RELEASE_PREVIOUS_MANIFEST  the production version.json now live (default: fetched from https://zkb.fi/version.json)
#   RELEASE_REMOTE             the release repository: the published stable log is fetched from its main branch
#   RELEASE_PREVIOUS_LOG       the stable releases-log.json to append to instead (its signature at <file>.sig)
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
# shellcheck source=script/release/channels.sh
. "$repository_root/script/release/channels.sh"
production_keys="$(channel_keys_file stable)"

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

# The published stable log, checked against the production keys before anything is built.
channel_previous_log stable "$work" </dev/null
previous_log=()
if [ -n "$CHANNEL_PREVIOUS_LOG" ]; then
  "${cli[@]}" log-check "$CHANNEL_PREVIOUS_LOG" --public-keys "$production_keys" </dev/null
  previous_log=(--previous-log "$CHANNEL_PREVIOUS_LOG" --public-keys "$production_keys")
fi

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
"${cli[@]}" log "$out" "${previous_log[@]+"${previous_log[@]}"}" </dev/null
# The only step that reads standard input: the production release key. It signs version.json and releases-log.json.
"${cli[@]}" sign "$out"
"${cli[@]}" log-check "$out/releases-log.json" --public-keys "$production_keys" --manifest "$out/version.json" </dev/null
"${cli[@]}" verify "$out" --public-keys "$production_keys" </dev/null

if [ "${PROMOTE_PUBLISH:-}" = "1" ]; then
  # Promotion always publishes to production: the channel is fixed here, never taken from the environment or the release.
  RELEASE_CHANNEL=stable RELEASE_PUBLIC_KEYS="$repository_root/explorer/landing/landing.config.json" \
    "$repository_root/script/release/publish.sh" "$out" </dev/null
  RELEASE_CHANNEL=stable RELEASE_PUBLIC_KEYS="$repository_root/explorer/landing/landing.config.json" \
    RELEASE_PAGES_LANDING=zkb-fi RELEASE_LANDING_DOMAINS=zkb.fi,www.zkb.fi \
    "$repository_root/script/release/publish-pages.sh" "$out" </dev/null
fi
