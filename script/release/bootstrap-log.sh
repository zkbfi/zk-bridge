#!/usr/bin/env bash
# Makes the first signed release log (releases-log.json) of a channel from the history of the release repository, once.
#
# Usage:   RELEASE_CHANNEL=<stable|next> RELEASE_REMOTE=<release repository> \
#            script/release/bootstrap-log.sh <output-directory> < <channel's release key>.jwk
#
# Every signed version.json ever pushed is a commit of the channel's branch (main for stable, next for next). Each one
# is checked against the channel's trusted keys (the landing configuration, never the repository) and its sites become
# log entries in sequence order. What the history does not hold is reported as a gap, never invented or re-pinned.
#
# Steps:
#   1. clones the channel's branch with its full history (read only); refuses when it already holds releases-log.json
#   2. writes <output-directory>/releases-log.json and prints what went in, what was skipped and the gaps
#   3. signs it with the key from standard input (the only step that reads it), writes releases-log.json.sig
#   4. checks it against the trusted keys, and that it ends with the version.json now on the branch
#   5. with BOOTSTRAP_PUBLISH=1, commits releases-log.json and its signature to the branch and pushes (never forced: a
#      branch that moved meanwhile refuses the push). Needs RELEASE_GIT_NAME and RELEASE_GIT_EMAIL, as publish.sh.
#
# The mirror (next.zkb.fi, zkb.fi) serves the log from the next publish-pages.sh of that channel.
set -euo pipefail

if [ "$#" -ne 1 ]; then
  echo "usage: RELEASE_CHANNEL=<stable|next> RELEASE_REMOTE=<url> $0 <output-directory> < release-key.jwk" >&2
  exit 2
fi
repository_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cli=(node "$repository_root/explorer/release/src/cli.ts")
# shellcheck source=script/release/channels.sh
. "$repository_root/script/release/channels.sh"
channel_require
if [ -z "${RELEASE_REMOTE:-}" ]; then
  echo "no release repository is configured (set RELEASE_REMOTE)" >&2
  exit 1
fi
if [ "${BOOTSTRAP_PUBLISH:-}" = "1" ] && { [ -z "${RELEASE_GIT_NAME:-}" ] || [ -z "${RELEASE_GIT_EMAIL:-}" ]; }; then
  echo "no identity for the log commit (set RELEASE_GIT_NAME and RELEASE_GIT_EMAIL)" >&2
  exit 1
fi
channel="$RELEASE_CHANNEL"
branch="$(channel_branch "$channel")"
keys="${RELEASE_PUBLIC_KEYS:-$(channel_keys_file "$channel")}"

mkdir -p "$1"
out="$(cd "$1" && pwd)"
if [ -n "$(ls -A "$out")" ]; then
  echo "$out is not empty: the log is written to an empty directory" >&2
  exit 1
fi

checkout="$(mktemp -d)"
trap 'rm -rf "$checkout"' EXIT
git clone --quiet --branch "$branch" "$RELEASE_REMOTE" "$checkout" </dev/null
if [ -e "$checkout/releases-log.json" ]; then
  echo "the $branch branch already holds releases-log.json: the first log is made once, then each release appends to it" >&2
  exit 1
fi

"${cli[@]}" log-bootstrap "$checkout" "$out" --branch HEAD --channel "$channel" --public-keys "$keys" </dev/null
# The only step that reads standard input: the channel's release key.
"${cli[@]}" sign "$out"
"${cli[@]}" log-check "$out/releases-log.json" --public-keys "$keys" --manifest "$checkout/version.json" </dev/null

if [ "${BOOTSTRAP_PUBLISH:-}" = "1" ]; then
  export GIT_AUTHOR_NAME="$RELEASE_GIT_NAME" GIT_AUTHOR_EMAIL="$RELEASE_GIT_EMAIL"
  export GIT_COMMITTER_NAME="$RELEASE_GIT_NAME" GIT_COMMITTER_EMAIL="$RELEASE_GIT_EMAIL"
  cp "$out/releases-log.json" "$out/releases-log.json.sig" "$checkout/"
  git -C "$checkout" add releases-log.json releases-log.json.sig
  git -C "$checkout" commit --quiet -m "release log: every release on $channel so far" </dev/null
  git -C "$checkout" push --quiet origin "HEAD:refs/heads/$branch" </dev/null
  echo "published the $channel release log to the $branch branch"
fi
