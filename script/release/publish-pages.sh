#!/usr/bin/env bash
# Deploys the landing page of a verified release to Cloudflare Pages, a mirror at the zkb.fi root.
# Only the landing page goes to Pages. The dapp and the docs are published on IPFS only.
# The signed release on IPFS is the source of truth: the mirror is the landing archive of that release, unpacked,
# plus version.json and its signature, so the page checks the same signed manifest wherever it is loaded.
#
# Usage:   script/release/publish-pages.sh <release-directory>
#
# Environment:
#   RELEASE_PAGES_LANDING    the Cloudflare Pages project name (required)
#   RELEASE_PUBLIC_KEYS      the trusted keys to verify against (default: explorer/landing/landing.config.json)
#   Wrangler reads its own Cloudflare credentials (CLOUDFLARE_API_TOKEN, CLOUDFLARE_ACCOUNT_ID); they are not read here.
#
# It refuses (exit 1) when the project name is missing or the release does not verify.
set -euo pipefail

if [ "$#" -ne 1 ]; then
  echo "usage: $0 <release-directory>" >&2
  exit 2
fi
if [ -z "${RELEASE_PAGES_LANDING:-}" ]; then
  echo "no Cloudflare Pages project is configured (set RELEASE_PAGES_LANDING)" >&2
  exit 1
fi

repository_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
release="$(cd "$1" && pwd)"
cli=(node "$repository_root/explorer/release/src/cli.ts")
keys="${RELEASE_PUBLIC_KEYS:-$repository_root/explorer/landing/landing.config.json}"

if ! "${cli[@]}" verify "$release" --public-keys "$keys"; then
  echo "the release does not verify, so nothing is deployed" >&2
  exit 1
fi

site="$(mktemp -d)"
trap 'rm -rf "$site"' EXIT
"${cli[@]}" unpack "$release/archives/landing.car" "$site" >/dev/null
cp "$release/version.json" "$release/version.json.sig" "$site/"
npx --yes wrangler@4 pages deploy "$site" --project-name "$RELEASE_PAGES_LANDING" --branch main
