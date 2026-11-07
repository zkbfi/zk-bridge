# Release channels, in one place. Sourced by release.sh, publish.sh, publish-pages.sh, promote.sh, bootstrap-log.sh and
# repin-from-log.sh.
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
# Where each channel's landing page, version.json and releases-log.json are served.
CHANNEL_STABLE_SITE=https://zkb.fi
CHANNEL_NEXT_SITE=https://next.zkb.fi

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

# The address that serves a channel's landing page, version.json and releases-log.json.
channel_site() {
  case "$1" in
    stable) echo "$CHANNEL_STABLE_SITE" ;;
    next) echo "$CHANNEL_NEXT_SITE" ;;
  esac
}

# Copies releases-log.json and releases-log.json.sig from the channel $1's branch of RELEASE_REMOTE into the directory
# $2, and prints what it found: "log" (copied), "none" (the branch exists but holds no log yet) or "new" (no such
# branch). Exits 1 when the remote cannot be read. Nothing here is trusted: the log is checked by its reader.
channel_fetch_log() {
  local branch checkout status=0
  branch="$(channel_branch "$1")"
  git ls-remote --exit-code --heads "$RELEASE_REMOTE" "refs/heads/$branch" >/dev/null 2>&1 </dev/null || status=$?
  if [ "$status" -eq 2 ]; then echo new; return 0; fi
  if [ "$status" -ne 0 ]; then
    echo "could not read the release repository to fetch the $1 release log" >&2
    exit 1
  fi
  checkout="$(mktemp -d)"
  if ! git clone --quiet --depth 1 --branch "$branch" "$RELEASE_REMOTE" "$checkout" >/dev/null 2>&1 </dev/null; then
    rm -rf "$checkout"
    echo "could not clone the $branch branch of the release repository" >&2
    exit 1
  fi
  if [ -f "$checkout/releases-log.json" ]; then
    cp "$checkout/releases-log.json" "$2/releases-log.json"
    if [ -f "$checkout/releases-log.json.sig" ]; then cp "$checkout/releases-log.json.sig" "$2/releases-log.json.sig"; fi
    echo log
  else
    echo none
  fi
  rm -rf "$checkout"
}

# Finds the published release log of channel $1 that a new release appends to, and sets CHANNEL_PREVIOUS_LOG to its
# path (its signature next to it, as <path>.sig), or to "" when the log starts with this release. $2 is a scratch
# directory. RELEASE_PREVIOUS_LOG names the file directly; otherwise it comes from RELEASE_REMOTE. Exits 1 when the
# channel's branch already has releases but no log: the first log comes from script/release/bootstrap-log.sh.
channel_previous_log() {
  CHANNEL_PREVIOUS_LOG=""
  if [ -n "${RELEASE_PREVIOUS_LOG:-}" ]; then
    CHANNEL_PREVIOUS_LOG="$RELEASE_PREVIOUS_LOG"
    return 0
  fi
  if [ -z "${RELEASE_REMOTE:-}" ]; then
    echo "no previous release log (set RELEASE_REMOTE or RELEASE_PREVIOUS_LOG): the log starts with this release, and publish.sh refuses it if the release repository already has one" >&2
    return 0
  fi
  local found
  found="$(channel_fetch_log "$1" "$2")"
  case "$found" in
    log) CHANNEL_PREVIOUS_LOG="$2/releases-log.json" ;;
    new) echo "the $1 branch of the release repository does not exist yet: the release log starts with this release" >&2 ;;
    *)
      echo "the $(channel_branch "$1") branch of the release repository has releases but no releases-log.json: make the first log with script/release/bootstrap-log.sh" >&2
      exit 1
      ;;
  esac
}
