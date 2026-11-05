#!/usr/bin/env bash
# Deploys the landing page of a verified release to Cloudflare, a mirror at the zkb.fi root. It is a Worker with static
# assets only (no code): new projects are no longer classic Pages projects, and wrangler 4 creates a Worker for them.
# Only the landing page goes to Pages. The dapp (docs included, at #/docs) is published on IPFS only.
# The signed release on IPFS is the source of truth: the mirror is the landing archive of that release, unpacked,
# plus version.json and its signature, so the page checks the same signed manifest wherever it is loaded.
#
# Usage:   script/release/publish-pages.sh <release-directory>
#
# Environment:
#   RELEASE_PAGES_LANDING    the name of the Cloudflare Worker that serves the landing page (required)
#   RELEASE_LANDING_DOMAINS  optional comma list of custom domains for it, such as zkb.fi,www.zkb.fi. Each domain must
#                            be a zone of the same account with no other DNS record on that name.
#   RELEASE_CHANNEL          stable or next (required, the operator's intent; never read from the release). It picks
#                            the trusted keys and the allowed targets: stable may not deploy to zkb-fi-next or
#                            next.zkb.fi, next may not deploy to zkb-fi, zkb.fi or www.zkb.fi (script/release/channels.sh).
#   RELEASE_PUBLIC_KEYS      the trusted keys to verify against (default: the landing config of RELEASE_CHANNEL)
# Staging: RELEASE_CHANNEL=next RELEASE_PAGES_LANDING=zkb-fi-next RELEASE_LANDING_DOMAINS=next.zkb.fi
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
# shellcheck source=script/release/channels.sh
. "$repository_root/script/release/channels.sh"
channel_require
channel_check_release "$release"
channel_check_target "$RELEASE_PAGES_LANDING" "${RELEASE_LANDING_DOMAINS:-}"
keys="${RELEASE_PUBLIC_KEYS:-$(channel_keys_file "$RELEASE_CHANNEL")}"

if ! "${cli[@]}" verify "$release" --public-keys "$keys"; then
  echo "the release does not verify, so nothing is deployed" >&2
  exit 1
fi

site="$(mktemp -d)"
trap 'rm -rf "$site"' EXIT
"${cli[@]}" unpack "$release/archives/landing.car" "$site" >/dev/null
cp "$release/version.json" "$release/version.json.sig" "$site/"
# The configuration lives outside the site, so it is never published.
config_dir="$(mktemp -d)"
trap 'rm -rf "$site" "$config_dir"' EXIT
node -e '
const [name, site, domains] = process.argv.slice(1);
const routes = domains.split(",").map((d) => d.trim()).filter(Boolean).map((pattern) => ({ pattern, custom_domain: true }));
const config = { name, compatibility_date: "2026-10-01", assets: { directory: site }, ...(routes.length ? { routes } : {}) };
process.stdout.write(JSON.stringify(config, null, 2));
' "$RELEASE_PAGES_LANDING" "$site" "${RELEASE_LANDING_DOMAINS:-}" > "$config_dir/wrangler.json"
npx --yes wrangler@4 deploy --config "$config_dir/wrangler.json"
