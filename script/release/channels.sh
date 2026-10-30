# Release channels, in one place. Sourced by publish.sh, publish-pages.sh and promote.sh.
#
# The channel is the operator's intent, set with RELEASE_CHANNEL (stable or next). It is never read from a release
# artifact: a staging release carries a valid signature from the staging key, so trusting the channel it names would
# let it pick its own keys and land on zkb.fi. The channel decides:
#   - which keys verify a release (each landing page trusts exactly one key),
#   - which branch of the release repository it goes to,
#   - which Cloudflare Worker and domains may serve it.
# shellcheck shell=bash

channel_repository_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"

# Production and staging targets. A release may only go to the targets of its channel.
CHANNEL_STABLE_WORKER=zkb-fi
CHANNEL_STABLE_DOMAINS="zkb.fi www.zkb.fi"
CHANNEL_NEXT_WORKER=zkb-fi-next
CHANNEL_NEXT_DOMAINS="next.zkb.fi"

# Exits 1 unless RELEASE_CHANNEL is stable or next.
channel_require() {
  case "${RELEASE_CHANNEL:-}" in
    stable | next) ;;
    "") echo "no release channel is set (set RELEASE_CHANNEL to stable or next)" >&2; exit 1 ;;
    *) echo "RELEASE_CHANNEL must be stable or next, not ${RELEASE_CHANNEL}" >&2; exit 1 ;;
  esac
}

# The landing configuration whose keys a channel trusts.
channel_keys_file() {
  case "$1" in
    stable) echo "$channel_repository_root/explorer/landing/landing.config.json" ;;
    next) echo "$channel_repository_root/explorer/landing/landing.next.config.json" ;;
  esac
}

# The branch of the release repository a channel publishes to.
channel_branch() {
  case "$1" in
    stable) echo main ;;
    next) echo next ;;
  esac
}

# Exits 1 when the release's version.json names another channel than RELEASE_CHANNEL. An unreadable version.json is
# left to verification, which refuses it.
channel_check_release() {
  local named
  named="$(node -e '
try { console.log(Object.keys(JSON.parse(require("fs").readFileSync(process.argv[1], "utf8")).channels).join(",")); }
catch { console.log(""); }
' "$1/version.json")"
  if [ -n "$named" ] && [ "$named" != "$RELEASE_CHANNEL" ]; then
    echo "the release names the channel \"$named\" but RELEASE_CHANNEL is $RELEASE_CHANNEL: nothing is published" >&2
    exit 1
  fi
}

# Exits 1 when a Worker or a domain belongs to the other channel.
channel_check_target() {
  local worker="$1" domains="$2" forbidden_worker forbidden_domains domain
  if [ "$RELEASE_CHANNEL" = "next" ]; then
    forbidden_worker="$CHANNEL_STABLE_WORKER"; forbidden_domains="$CHANNEL_STABLE_DOMAINS"
  else
    forbidden_worker="$CHANNEL_NEXT_WORKER"; forbidden_domains="$CHANNEL_NEXT_DOMAINS"
  fi
  if [ "$worker" = "$forbidden_worker" ]; then
    echo "a $RELEASE_CHANNEL release may not deploy to the Worker $worker" >&2
    exit 1
  fi
  for domain in ${domains//,/ }; do
    case " $forbidden_domains " in
      *" $domain "*) echo "a $RELEASE_CHANNEL release may not deploy to $domain" >&2; exit 1 ;;
    esac
  done
}
