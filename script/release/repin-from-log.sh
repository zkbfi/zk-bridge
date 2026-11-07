#!/usr/bin/env bash
# Reads a channel's signed release log and asks the kubo node to pin every CID it lists. A dry run by default: it
# prints each CID as pinned or MISSING and pins nothing.
#
# Usage:   RELEASE_CHANNEL=<stable|next> KUBO_API_URL=http://127.0.0.1:5001 script/release/repin-from-log.sh [log-file]
#
# The log (and its signature, <log-file>.sig) comes from the file given, else from the channel's branch of
# RELEASE_REMOTE, else from the channel's site (https://next.zkb.fi or https://zkb.fi /releases-log.json). Wherever it
# comes from, it is checked against the channel's trusted keys (the landing configuration, or RELEASE_PUBLIC_KEYS)
# before anything is asked of the node.
#
# Environment:
#   RELEASE_CHANNEL   stable or next (required): picks the trusted keys and where the log comes from
#   KUBO_API_URL      the node's RPC address through the SSH tunnel (docs/release.md). No credentials in it.
#   KUBO_API_AUTH     optional: the Authorization header value the node accepts. Read from the environment only,
#                     never passed on a command line and never printed.
#   REPIN_APPLY=1     pin each missing CID (named zkbfi-<site>-<version>); the node fetches it from the network. A CID
#                     no reachable peer holds fails after a timeout and is reported; the script then exits 1.
set -euo pipefail

if [ "$#" -gt 1 ]; then
  echo "usage: RELEASE_CHANNEL=<stable|next> KUBO_API_URL=<url> $0 [log-file]" >&2
  exit 2
fi
repository_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cli=(node "$repository_root/explorer/release/src/cli.ts")
# shellcheck source=script/release/channels.sh
. "$repository_root/script/release/channels.sh"
channel_require
if [ -z "${KUBO_API_URL:-}" ]; then
  echo "no kubo node is configured (set KUBO_API_URL, through the SSH tunnel)" >&2
  exit 1
fi
channel="$RELEASE_CHANNEL"
keys="${RELEASE_PUBLIC_KEYS:-$(channel_keys_file "$channel")}"

work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT
if [ "$#" -eq 1 ]; then
  log="$1"
elif [ -n "${RELEASE_REMOTE:-}" ]; then
  if [ "$(channel_fetch_log "$channel" "$work")" != "log" ]; then
    echo "the $(channel_branch "$channel") branch of the release repository holds no releases-log.json" >&2
    exit 1
  fi
  log="$work/releases-log.json"
else
  site="$(channel_site "$channel")"
  curl -fsS "$site/releases-log.json" -o "$work/releases-log.json"
  curl -fsS "$site/releases-log.json.sig" -o "$work/releases-log.json.sig"
  log="$work/releases-log.json"
fi

mode=check
if [ "${REPIN_APPLY:-}" = "1" ]; then mode=apply; fi
"${cli[@]}" repin "$log" --public-keys "$keys" --mode "$mode"
