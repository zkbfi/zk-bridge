#!/usr/bin/env bash
# Pulls the newest proof archive bundle from the zkb.fi app server to this machine, unattended (launchd runs it daily;
# install-proofs-pull.sh sets that up). Run it by hand the same way:
#
#   deploy/operator/pull-proofs.sh
#
# It asks the server (over the "zkbfi-app" alias of ~/.ssh/config, BatchMode: it never prompts) for the newest
# zk-bridge-proofs-*.tar.gz in /var/backups/zk-bridge/proofs, fetches it and its .sha256 with rsync into
# ~/zkb-backups/proofs/, and keeps it only when
#   - the .sha256 matches the bundle, and
#   - every file that manifest.json inside the bundle lists has the listed sha256, and no file is unlisted.
# A bundle that fails is deleted and the run fails (exit 1). A bundle that is already here is not fetched again.
# The newest ZKB_PULL_KEEP (30) bundles stay. The log is ~/zkb-backups/proofs/pull.log (bounded to about 1 MB, one
# rotated copy). It names the host alias only. No secret is read or written.
#
# The manifest is read with node, else with python3; with neither the run fails and says so. (launchd has a short PATH:
# install-proofs-pull.sh records the node it finds in ZKB_PULL_NODE.)
#
# Settings (environment; defaults in brackets):
#   ZKB_PULL_HOST [zkbfi-app]   ZKB_PULL_REMOTE_DIR [/var/backups/zk-bridge/proofs]
#   ZKB_PULL_LOCAL_DIR [~/zkb-backups/proofs]   ZKB_PULL_KEEP [30]   ZKB_PULL_LOG [<local dir>/pull.log]
#   ZKB_PULL_NODE [node on PATH]   ZKB_PULL_SSH [ssh]   ZKB_PULL_RSYNC [rsync]   (the last three: tests)
#   ZKB_PULL_HOOK   an executable called as `<hook> <bundle>` after a bundle was pulled and verified (a copy to
#                   somewhere else on this machine, say). A failing hook is logged and fails the run.
set -euo pipefail

HOST=${ZKB_PULL_HOST:-zkbfi-app}
REMOTE_DIR=${ZKB_PULL_REMOTE_DIR:-/var/backups/zk-bridge/proofs}
LOCAL_DIR=${ZKB_PULL_LOCAL_DIR:-$HOME/zkb-backups/proofs}
KEEP=${ZKB_PULL_KEEP:-30}
LOG=${ZKB_PULL_LOG:-$LOCAL_DIR/pull.log}
SSH=${ZKB_PULL_SSH:-ssh}
RSYNC=${ZKB_PULL_RSYNC:-rsync}
LOG_MAX=1000000
SSH_OPTS="-o BatchMode=yes -o ConnectTimeout=20 -o ServerAliveInterval=15 -o ServerAliveCountMax=4"

TMP_DIRS=("")
cleanup() {
  local d
  for d in ${TMP_DIRS[@]+"${TMP_DIRS[@]}"}; do
    if [ -n "$d" ]; then rm -rf "$d"; fi
  done
}

log() {
  local line
  line="$(date '+%Y-%m-%d %H:%M:%S') pull-proofs: $*"
  printf '%s\n' "$line" >&2
  printf '%s\n' "$line" >>"$LOG" 2>/dev/null || true
}
die() { log "$*"; exit 1; }

sha256_of() {
  if command -v shasum >/dev/null 2>&1; then shasum -a 256 "$1" | awk '{print $1}'; else sha256sum "$1" | awk '{print $1}'; fi
}

# manifest_lines <manifest.json>: prints "<sha256> <path>" for each listed file, with whatever JSON reader exists.
manifest_lines() {
  local node=${ZKB_PULL_NODE:-}
  [ -n "$node" ] || node=$(command -v node 2>/dev/null || true)
  if [ -n "$node" ] && [ -x "$node" ]; then
    "$node" -e 'const m = JSON.parse(require("fs").readFileSync(process.argv[1], "utf8"));
      for (const [p, v] of Object.entries(m.files)) console.log(v.sha256 + " " + p);' "$1"
    return
  fi
  # /usr/bin/python3 on a Mac without the developer tools opens an install dialog; use it only when it is real.
  local py
  py=$(command -v python3 2>/dev/null || true)
  if [ "$py" = /usr/bin/python3 ] && ! xcode-select -p >/dev/null 2>&1; then py=""; fi
  if [ -n "$py" ]; then
    "$py" -I -c 'import json,sys
for p, v in json.load(open(sys.argv[1]))["files"].items():
    print(v["sha256"] + " " + p)' "$1"
    return
  fi
  die "neither node nor python3 is available to read manifest.json (set ZKB_PULL_NODE)"
}

# verify_bundle <bundle>: sha256 file, then the manifest inside. Returns non-zero with a log line on any mismatch.
verify_bundle() {
  local bundle=$1 want got work lines line sha rel
  [ -f "$bundle.sha256" ] || { log "no .sha256 for $(basename "$bundle")"; return 1; }
  want=$(awk '{print $1; exit}' "$bundle.sha256")
  got=$(sha256_of "$bundle")
  [ "$want" = "$got" ] || { log "$(basename "$bundle") does not match its .sha256"; return 1; }

  work=$(mktemp -d "$LOCAL_DIR/.verify-XXXXXX")
  TMP_DIRS+=("$work")
  tar --no-same-owner -xzf "$bundle" -C "$work" 2>/dev/null || { log "$(basename "$bundle") cannot be unpacked"; return 1; }
  if [ -n "$(find "$work" ! -type f ! -type d -print -quit)" ]; then log "$(basename "$bundle") holds links or special files"; return 1; fi
  [ -f "$work/manifest.json" ] || { log "$(basename "$bundle") has no manifest.json"; return 1; }
  lines=$(manifest_lines "$work/manifest.json") || { log "manifest.json cannot be read"; return 1; }
  while IFS= read -r line; do
    [ -n "$line" ] || continue
    sha=${line%% *}
    rel=${line#* }
    case $rel in /* | *..*) log "manifest lists a path outside the bundle: $rel"; return 1 ;; esac
    [ -f "$work/$rel" ] || { log "manifest lists $rel, which is missing"; return 1; }
    [ "$(sha256_of "$work/$rel")" = "$sha" ] || { log "$rel does not match the manifest"; return 1; }
  done <<EOF_LINES
$lines
EOF_LINES
  # No file may be missing from the manifest.
  while IFS= read -r rel; do
    rel=${rel#./}
    [ "$rel" = manifest.json ] && continue
    printf '%s\n' "$lines" | sed 's/^[^ ]* //' | grep -qxF -- "$rel" || { log "$rel is in the bundle but not in the manifest"; return 1; }
  done < <(cd "$work" && find . -type f)
  rm -rf "$work"
  return 0
}

main() {
  exec </dev/null
  umask 077
  case $KEEP in '' | *[!0-9]* | 0) echo "pull-proofs: ZKB_PULL_KEEP must be a positive number" >&2; exit 1 ;; esac
  mkdir -p "$LOCAL_DIR"
  if [ -f "$LOG" ] && [ "$(wc -c <"$LOG")" -gt "$LOG_MAX" ]; then mv -f "$LOG" "$LOG.1"; fi
  trap cleanup EXIT

  # One run at a time. A lock left by a run that died is taken over.
  local lock=$LOCAL_DIR/.pull.lock
  if ! mkdir "$lock" 2>/dev/null; then
    if kill -0 "$(cat "$lock/pid" 2>/dev/null || echo 0)" 2>/dev/null; then die "another run is going"; fi
    rm -rf "$lock"
    mkdir "$lock" || die "cannot take the lock"
  fi
  echo $$ >"$lock/pid"
  TMP_DIRS+=("$lock")
  rm -rf "$LOCAL_DIR"/.verify-* "$LOCAL_DIR"/.incoming

  # The newest bundle on the server (names carry a UTC stamp, so the last in sort order is the newest).
  local name
  # shellcheck disable=SC2086
  name=$($SSH $SSH_OPTS "$HOST" "ls -1 '$REMOTE_DIR'" | grep -E '^zk-bridge-proofs-[0-9TZ]+\.tar\.gz$' | sort | tail -n 1) \
    || die "cannot list the bundles on $HOST"
  [ -n "$name" ] || die "$HOST has no bundle in $REMOTE_DIR"

  local pulled=0
  if [ -f "$LOCAL_DIR/$name" ] && [ -f "$LOCAL_DIR/$name.sha256" ]; then
    log "$name is here already"
  else
    log "fetching $name from $HOST"
    mkdir "$LOCAL_DIR/.incoming"
    TMP_DIRS+=("$LOCAL_DIR/.incoming")
    # shellcheck disable=SC2086
    $RSYNC -t --partial -e "ssh $SSH_OPTS" "$HOST:$REMOTE_DIR/$name" "$HOST:$REMOTE_DIR/$name.sha256" "$LOCAL_DIR/.incoming/" \
      || die "rsync from $HOST failed"
    if verify_bundle "$LOCAL_DIR/.incoming/$name"; then
      mv "$LOCAL_DIR/.incoming/$name" "$LOCAL_DIR/$name"
      mv "$LOCAL_DIR/.incoming/$name.sha256" "$LOCAL_DIR/$name.sha256"
      pulled=1
      log "$name verified (sha256 and manifest) and kept"
    else
      rm -rf "$LOCAL_DIR/.incoming"
      die "$name FAILED verification and was deleted"
    fi
  fi

  # Retention: the newest KEEP bundles stay.
  local -a all
  local f total=0 i=0 pruned=0
  for f in "$LOCAL_DIR"/zk-bridge-proofs-*.tar.gz; do
    [ -e "$f" ] || continue
    all[total]=$f
    total=$((total + 1))
  done
  for f in ${all[@]+"${all[@]}"}; do
    if [ $((total - i)) -gt "$KEEP" ]; then
      rm -f "$f" "$f.sha256"
      pruned=$((pruned + 1))
      log "pruned $(basename "$f")"
    fi
    i=$((i + 1))
  done
  log "done: $((total - pruned)) bundle(s) here, $pruned pruned"

  if [ "$pulled" -eq 1 ] && [ -n "${ZKB_PULL_HOOK:-}" ]; then
    if [ -x "$ZKB_PULL_HOOK" ] && "$ZKB_PULL_HOOK" "$LOCAL_DIR/$name"; then log "hook ok"; else die "the hook failed"; fi
  fi
}

main "$@"
