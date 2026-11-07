#!/usr/bin/env bash
# Publishes a release made by script/release/release.sh: pins the site archives (dapp, landing), then pushes the signed
# manifest and the signed release log to the release remote. It refuses until both a release remote and a pinning account are configured.
#
# Usage:   script/release/publish.sh <release-directory>
#
# Environment (all required):
#   RELEASE_REMOTE           git URL of the release repository that holds version.json and its signature
#   RELEASE_PIN_PROVIDER     the pinning adapter (explorer/release/src/pin.ts): "kubo" or "filebase"
#   RELEASE_GIT_NAME, RELEASE_GIT_EMAIL
#                            the author and committer of the release commit. The script never takes them from the git
#                            configuration: its checkout is a temporary folder, where the machine's default identity
#                            would apply. Signing still follows the configuration (see docs/release.md).
# For "kubo", the IPFS node on the app server, reached through an SSH tunnel (docs/release.md):
#   KUBO_API_URL             the node's RPC address, for example http://127.0.0.1:5001. No credentials in it.
#   KUBO_API_AUTH            optional: the Authorization header value the node accepts. Never printed.
# For "filebase":
#   FILEBASE_ACCESS_KEY, FILEBASE_SECRET_KEY, FILEBASE_BUCKET
#                            the Filebase credentials and IPFS bucket, read by the adapter and never printed
# Optional:
#   RELEASE_CHANNEL          stable or next (required). The operator's intent, never read from the release: it picks
#                            the trusted keys, and the branch (main for stable, next for next). A release naming
#                            another channel is refused. See script/release/channels.sh.
#   RELEASE_PUBLIC_KEYS      the trusted keys to verify against (default: the keys built into that channel's landing
#                            page). The release's own public-keys.json is not trusted.
#
# Order: verify; check that the release's releases-log.json only appends to the log on the channel's branch (same
# entries byte for byte, chain intact, signatures by the trusted keys, sequence up) and ends with this release; pin
# every archive (each pin fails unless the service reports the CID computed here); then push. A branch that has
# releases but no log is refused: the first log comes from script/release/bootstrap-log.sh.
set -euo pipefail

if [ "$#" -ne 1 ]; then
  echo "usage: $0 <release-directory>" >&2
  exit 2
fi
if [ -z "${RELEASE_REMOTE:-}" ] || [ -z "${RELEASE_PIN_PROVIDER:-}" ]; then
  echo "no release remote or pinning account is configured (set RELEASE_REMOTE and RELEASE_PIN_PROVIDER)" >&2
  exit 1
fi

if [ -z "${RELEASE_GIT_NAME:-}" ] || [ -z "${RELEASE_GIT_EMAIL:-}" ]; then
  echo "no identity for the release commit (set RELEASE_GIT_NAME and RELEASE_GIT_EMAIL)" >&2
  exit 1
fi
export GIT_AUTHOR_NAME="$RELEASE_GIT_NAME" GIT_AUTHOR_EMAIL="$RELEASE_GIT_EMAIL"
export GIT_COMMITTER_NAME="$RELEASE_GIT_NAME" GIT_COMMITTER_EMAIL="$RELEASE_GIT_EMAIL"

repository_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
release="$(cd "$1" && pwd)"
cli=(node "$repository_root/explorer/release/src/cli.ts")
# shellcheck source=script/release/channels.sh
. "$repository_root/script/release/channels.sh"
channel_require
channel_check_release "$release"
channel="$RELEASE_CHANNEL"
branch="$(channel_branch "$channel")"
keys="${RELEASE_PUBLIC_KEYS:-$(channel_keys_file "$channel")}"

"${cli[@]}" verify "$release" --public-keys "$keys"
read -r release_version sequence <<<"$(node -e '
const m = JSON.parse(require("fs").readFileSync(process.argv[1], "utf8"));
console.log(`${m.channels[process.argv[2]]} ${m.sequence}`);
' "$release/version.json" "$channel")"

checkout="$(mktemp -d)"
trap 'rm -rf "$checkout"' EXIT
if ! git clone --quiet --depth 1 --branch "$branch" "$RELEASE_REMOTE" "$checkout" 2>/dev/null; then
  # The first release of a channel: start its branch with no history of another channel.
  git clone --quiet --depth 1 "$RELEASE_REMOTE" "$checkout"
  git -C "$checkout" checkout --quiet --orphan "$branch"
  git -C "$checkout" rm --quiet -rf .
fi

# The release log only grows: nothing is pinned or pushed unless the new log extends the published one exactly.
if [ -f "$checkout/releases-log.json" ]; then
  "${cli[@]}" log-check "$release/releases-log.json" --public-keys "$keys" --extends "$checkout/releases-log.json" \
    --manifest "$release/version.json"
elif [ -f "$checkout/version.json" ]; then
  echo "the $branch branch has releases but no releases-log.json: make the first log with script/release/bootstrap-log.sh, then build the release again" >&2
  exit 1
else
  "${cli[@]}" log-check "$release/releases-log.json" --public-keys "$keys" --manifest "$release/version.json"
fi

"${cli[@]}" pin "$release" --prefix "$release_version"

cp "$release/version.json" "$release/version.json.sig" "$release/public-keys.json" "$release/SHA256SUMS" \
  "$release/releases-log.json" "$release/releases-log.json.sig" "$checkout/"
git -C "$checkout" add version.json version.json.sig public-keys.json SHA256SUMS releases-log.json releases-log.json.sig
git -C "$checkout" commit --quiet -m "release $release_version (sequence $sequence, $channel)"
git -C "$checkout" push --quiet origin "HEAD:refs/heads/$branch"
echo "published $release_version (sequence $sequence) on $channel"
