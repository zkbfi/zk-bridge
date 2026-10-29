#!/usr/bin/env bash
# Publishes a release made by script/release/release.sh: pins the three site archives, then pushes the signed
# manifest to the release remote. It refuses until both a release remote and a pinning account are configured.
#
# Usage:   script/release/publish.sh <release-directory>
#
# Environment (all required):
#   RELEASE_REMOTE           git URL of the release repository that holds version.json and its signature
#   RELEASE_PIN_PROVIDER     the pinning adapter (explorer/release/src/pin.ts); the only one is "filebase"
#   FILEBASE_ACCESS_KEY, FILEBASE_SECRET_KEY, FILEBASE_BUCKET
#                            the Filebase credentials and IPFS bucket, read by the adapter and never printed
# Optional:
#   RELEASE_PUBLIC_KEYS      the trusted keys to verify against (default: the keys built into the landing page,
#                            explorer/landing/landing.config.json). The release's own public-keys.json is not trusted.
#
# Order: verify, pin every archive (each pin fails unless the service reports the CID computed here), then push.
set -euo pipefail

if [ "$#" -ne 1 ]; then
  echo "usage: $0 <release-directory>" >&2
  exit 2
fi
if [ -z "${RELEASE_REMOTE:-}" ] || [ -z "${RELEASE_PIN_PROVIDER:-}" ]; then
  echo "no release remote or pinning account is configured (set RELEASE_REMOTE and RELEASE_PIN_PROVIDER)" >&2
  exit 1
fi

repository_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
release="$(cd "$1" && pwd)"
cli=(node "$repository_root/explorer/release/src/cli.ts")
keys="${RELEASE_PUBLIC_KEYS:-$repository_root/explorer/landing/landing.config.json}"

"${cli[@]}" verify "$release" --public-keys "$keys"
version="$(node -e 'const m = JSON.parse(require("fs").readFileSync(process.argv[1], "utf8")); console.log(m.channels.stable + " " + m.sequence)' "$release/version.json")"
read -r release_version sequence <<<"$version"

"${cli[@]}" pin "$release" --prefix "$release_version"

checkout="$(mktemp -d)"
trap 'rm -rf "$checkout"' EXIT
git clone --quiet --depth 1 "$RELEASE_REMOTE" "$checkout"
cp "$release/version.json" "$release/version.json.sig" "$release/public-keys.json" "$release/SHA256SUMS" "$checkout/"
git -C "$checkout" add version.json version.json.sig public-keys.json SHA256SUMS
git -C "$checkout" commit --quiet -m "release $release_version (sequence $sequence)"
git -C "$checkout" push --quiet origin HEAD
echo "published $release_version (sequence $sequence)"
