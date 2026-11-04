#!/usr/bin/env bash
# Writes the list of CIDs that the IPFS node has pinned recursively, for the on-demand TLS check (ipfs-tls-ask.py).
#
#   ipfs-pins.sh refresh
#
# Run as root (zk-bridge-ipfs-pins.service, every 2 minutes; proofs.sh publish runs it after pinning). The check
# service runs as an unprivileged user and holds no API token: this script is the only place that talks to the node's
# RPC API for it. The node's user reads AuthSecret from the node's config, and the Authorization header goes to
# `curl -H @-` on standard input, never into an argument list (the same way as proofs.sh). The answer of
# /api/v0/pin/ls?type=recursive is cut down to CIDv1 in lowercase base32 (multibase prefix b) and written one per line,
# atomically, to a file in a directory that only the node's user (zkb_ipfs) can write: the check service only reads it.
#
#   ZKB_IPFS_PATH [/var/lib/zk-bridge-ipfs/repo]        the node's repository (config with the API secret, api file)
#   ZKB_PINS_FILE [/var/lib/zk-bridge-ipfs-pins/pins.txt]
#   ZKB_PINS_AS                                         a command that runs "<user> <command...>" (tests); default runuser
#
# A failed call leaves the earlier file in place.
set -euo pipefail

log() { printf 'ipfs-pins: %s\n' "$*" >&2; }

IPFS_REPO=${ZKB_IPFS_PATH:-/var/lib/zk-bridge-ipfs/repo}
PINS_FILE=${ZKB_PINS_FILE:-/var/lib/zk-bridge-ipfs-pins/pins.txt}

[ "${1:-}" = refresh ] || { log "usage: ipfs-pins.sh refresh"; exit 2; }

# As the node's user: reads the secret, builds the header the way kubo does, and calls the API.
IPFS_RPC='
set -eu
config=$IPFS_PATH/config
addr=
if [ -r "$IPFS_PATH/api" ]; then addr=$(cat "$IPFS_PATH/api"); fi
if [ -z "$addr" ]; then
  addr=$(jq -r "(.Addresses.API | if type == \"array\" then .[0] else . end) // empty" "$config")
fi
case $addr in
  /ip4/127.0.0.1/tcp/*) host=127.0.0.1 ;;
  /ip6/::1/tcp/*) host="[::1]" ;;
  *) echo "the RPC API of the IPFS node is not on a loopback address" >&2; exit 1 ;;
esac
port=${addr##*/tcp/}
case $port in "" | *[!0-9]*) echo "the RPC API of the IPFS node has no port" >&2; exit 1 ;; esac
secret=$(jq -r "[.API.Authorizations[]?.AuthSecret] | first // empty" "$config")
case $secret in
  "") echo "the IPFS node config holds no API.Authorizations secret" >&2; exit 1 ;;
  bearer:*) header="Bearer ${secret#bearer:}" ;;
  basic:*:*) header="Basic $(printf "%s" "${secret#basic:}" | base64 | tr -d "\n")" ;;
  basic:*) header="Basic ${secret#basic:}" ;;
  *:*) echo "the IPFS node secret has a type this script does not know" >&2; exit 1 ;;
  *) header="Bearer $secret" ;;
esac
printf "Authorization: %s\n" "$header" | curl -sS --fail-with-body --max-time 30 -X POST -H @- "http://$host:$port$1"
'

as_user() {
  local user=$1
  shift
  if [ -n "${ZKB_PINS_AS:-}" ]; then "$ZKB_PINS_AS" "$user" "$@"
  # The timer runs this as the node's own user: no switch (runuser cannot inside the unit's sandbox).
  elif [ "$(id -un)" = "$user" ]; then "$@"
  else runuser -u "$user" -- "$@"; fi
}

dir=$(dirname "$PINS_FILE")
mkdir -p "$dir"
chmod 0755 "$dir" 2>/dev/null || true

answer=$(as_user zkb_ipfs env "IPFS_PATH=$IPFS_REPO" sh -c "$IPFS_RPC" sh "/api/v0/pin/ls?type=recursive") || { log "the pin list of the node could not be read; the earlier list stays"; exit 1; }
keys=$(printf '%s' "$answer" | jq -r '(.Keys // error("no Keys in the answer")) | keys[]') || { log "the pin list has an unknown shape; the earlier list stays"; exit 1; }
tmp=$(mktemp "$dir/.pins.XXXXXX")
trap 'rm -f "$tmp"' EXIT
# Only CIDv1 base32 (lowercase, prefix b): the other forms never name a subdomain. No match is an empty list.
{ printf '%s\n' "$keys" | grep -E '^b[a-z2-7]+$' || true; } | sort -u >"$tmp"
chmod 0644 "$tmp"
mv -f "$tmp" "$PINS_FILE"
trap - EXIT
log "$(grep -c . "$PINS_FILE" || true) pinned CID(s) in $PINS_FILE"
