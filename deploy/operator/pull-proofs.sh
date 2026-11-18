#!/usr/bin/env bash
# Pulls the private proof mirror of the zkb.fi app server to this machine, unattended (launchd runs it daily;
# install-proofs-pull.sh sets that up). Run it by hand the same way:
#
#   deploy/operator/pull-proofs.sh
#
# Owner, 2026-11-02: "ok, so lets plan to do 30 days of everything". The server keeps a mirror
# (/var/backups/zk-bridge/proofs/mirror, docs/proof-archive.md): one file per record, named by its content and never
# rewritten, plus beacon states, SQLite snapshots and daily manifests for a window of 30 days. This script copies it over
# the "zkbfi-app" alias of ~/.ssh/config (BatchMode: it never prompts) into ~/zkb-backups/proofs/mirror:
#   - storage-proofs/, light-client-proofs/, evidence/, conflicts/: rsync --ignore-existing. A file that is here already
#     is never fetched again, and nothing here is ever deleted, even when the server no longer has it (that is logged).
#   - beacon-states/, snapshots/, manifests/: rsync --ignore-existing --delete. What the server pruned is deleted here
#     too, and the count is logged.
# Each rsync waits for a running export on the server (a shared flock on its lock file), and rsync puts each file in
# place only when it is complete. Then the newest manifest is checked: its own sha256 must be in the server's
# manifests.sha256 (fetched to ~/zkb-backups/proofs/manifests.sha256; root appends a line each night, outside the
# mirror), and every file it lists must be here with its sha256. A file that is missing (the pull met an export half way) gets one more pull; a file whose content differs is a
# failure (exit 1) and is left as it is for a person to look at. The log is ~/zkb-backups/proofs/pull.log (bounded to
# about 1 MB, one rotated copy). It names the host alias only. No secret is read or written.
#
# The nightly bundles of the old format (~/zkb-backups/proofs/zk-bridge-proofs-*.tar.gz) are left as they are; nothing
# makes new ones.
#
# The manifest is read with node, else with python3; with neither the run fails and says so. (launchd has a short PATH:
# install-proofs-pull.sh records the node and the rsync it finds in ZKB_PULL_NODE and ZKB_PULL_RSYNC.)
#
# Settings (environment; defaults in brackets):
#   ZKB_PULL_HOST [zkbfi-app]   ZKB_PULL_REMOTE_DIR [/var/backups/zk-bridge/proofs/mirror]
#   ZKB_PULL_REMOTE_LOCK [/var/backups/zk-bridge/proofs/.lock; empty: no lock]
#   ZKB_PULL_REMOTE_TRUST [/var/backups/zk-bridge/proofs/manifests.sha256]
#   ZKB_PULL_REMOTE_TRUSTED_MANIFESTS [/var/backups/zk-bridge/proofs/trusted-manifests]
#   ZKB_PULL_LOCAL_DIR [~/zkb-backups/proofs] (the mirror goes to <local dir>/mirror)   ZKB_PULL_LOG [<local dir>/pull.log]
#   ZKB_PULL_NODE [node on PATH]   ZKB_PULL_RSYNC [rsync on PATH]   ZKB_PULL_SSH [ssh]
#   ZKB_PULL_HOOK   an executable called as `<hook> <mirror dir> <newest manifest>` after a pull that verified (a copy to
#                   somewhere else on this machine, say). A failing hook is logged and fails the run.
set -euo pipefail

HOST=${ZKB_PULL_HOST:-zkbfi-app}
REMOTE_DIR=${ZKB_PULL_REMOTE_DIR:-/var/backups/zk-bridge/proofs/mirror}
REMOTE_LOCK=${ZKB_PULL_REMOTE_LOCK-/var/backups/zk-bridge/proofs/.lock}
# The server's list of the sha256 of each day's manifest: root writes it at export time, outside the mirror, so whoever
# can write the mirror cannot change it.
REMOTE_TRUST=${ZKB_PULL_REMOTE_TRUST:-/var/backups/zk-bridge/proofs/manifests.sha256}
# Root's own copies of each day's manifest (written from what the archive CLI printed to root, outside the mirror).
REMOTE_TRUSTED_MANIFESTS=${ZKB_PULL_REMOTE_TRUSTED_MANIFESTS:-/var/backups/zk-bridge/proofs/trusted-manifests}
LOCAL_DIR=${ZKB_PULL_LOCAL_DIR:-$HOME/zkb-backups/proofs}
MIRROR_DIR=$LOCAL_DIR/mirror
LOG=${ZKB_PULL_LOG:-$LOCAL_DIR/pull.log}
SSH=${ZKB_PULL_SSH:-ssh}
RSYNC=${ZKB_PULL_RSYNC:-rsync}
LOG_MAX=1000000
SSH_OPTS="-o BatchMode=yes -o ConnectTimeout=20 -o ServerAliveInterval=15 -o ServerAliveCountMax=4"
# Records: never deleted here. The rest: the server's window.
RECORD_DIRS="storage-proofs light-client-proofs evidence handoff-updates fork-proofs conflicts"
PRUNED_DIRS="beacon-states snapshots manifests"

TMP_FILES=("")
cleanup() {
  local f
  for f in ${TMP_FILES[@]+"${TMP_FILES[@]}"}; do
    if [ -n "$f" ]; then rm -rf "$f"; fi
  done
}

log() {
  local line
  line="$(date '+%Y-%m-%d %H:%M:%S') pull-proofs: $*"
  printf '%s\n' "$line" >&2
  printf '%s\n' "$line" >>"$LOG" 2>/dev/null || true
}
die() { log "$*"; exit 1; }

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
  die "neither node nor python3 is available to read the manifest (set ZKB_PULL_NODE)"
}

sha256_of() {
  if command -v shasum >/dev/null 2>&1; then shasum -a 256 "$1" | awk '{print $1}'; else sha256sum "$1" | awk '{print $1}'; fi
}

# sha256_check <list>: checks "<sha256>  <path>" lines from the mirror directory; prints the paths that fail and returns 0.
# When the checker exits non-zero without naming a failed path (a malformed line, a missing tool, an unreadable list),
# nothing was verified: it logs what the checker said and returns 1, so that the caller counts a failure.
sha256_check() {
  local out status=0 failed err
  [ -s "$1" ] || return 0
  err=$(mktemp "$LOCAL_DIR/.checker-XXXXXX")
  if command -v shasum >/dev/null 2>&1; then
    out=$(cd "$MIRROR_DIR" && shasum -a 256 -c --quiet "$1" 2>"$err") || status=$?
  else
    out=$(cd "$MIRROR_DIR" && sha256sum -c --quiet "$1" 2>"$err") || status=$?
  fi
  if [ "$status" -eq 0 ]; then rm -f "$err"; return 0; fi
  failed=$(printf '%s\n' "$out" | sed -n 's/: FAILED.*$//p')
  if [ -n "$failed" ]; then rm -f "$err"; printf '%s\n' "$failed"; return 0; fi
  log "the hash checker exited $status without naming a file that differs; nothing is verified: $(head -c 300 "$err" | tr '\n' ' ')"
  rm -f "$err"
  return 1
}

# files_of <directory>: the files under it, relative, sorted.
files_of() {
  if [ -d "$1" ]; then (cd "$1" && find . -type f ! -name '.*' | sed 's|^\./||' | LC_ALL=C sort); fi
}

# sync_once: one rsync per directory of the mirror. Returns non-zero when an rsync failed.
sync_once() {
  local d before after gone
  local -a lock=()
  if [ -n "$REMOTE_LOCK" ]; then lock=("--rsync-path=flock -s -w 3600 $REMOTE_LOCK rsync"); fi
  for d in $RECORD_DIRS $PRUNED_DIRS; do
    mkdir -p "$MIRROR_DIR/$d"
    case " $PRUNED_DIRS " in
      *" $d "*)
        before=$(files_of "$MIRROR_DIR/$d")
        # shellcheck disable=SC2086
        $RSYNC -rt --ignore-existing --delete ${lock[@]+"${lock[@]}"} -e "$SSH $SSH_OPTS" "$HOST:$REMOTE_DIR/$d/" "$MIRROR_DIR/$d/" || { log "rsync of $d from $HOST failed"; return 1; }
        after=$(files_of "$MIRROR_DIR/$d")
        gone=$(comm -23 <(printf '%s\n' "$before") <(printf '%s\n' "$after") | grep -c . || true)
        [ "$gone" -eq 0 ] || log "$d: $gone file(s) deleted here, as the server pruned them"
        ;;
      *)
        # shellcheck disable=SC2086
        $RSYNC -rt --ignore-existing ${lock[@]+"${lock[@]}"} -e "$SSH $SSH_OPTS" "$HOST:$REMOTE_DIR/$d/" "$MIRROR_DIR/$d/" || { log "rsync of $d from $HOST failed"; return 1; }
        ;;
    esac
  done
  # Last, so that it lists every manifest just fetched.
  # shellcheck disable=SC2086
  mkdir -p "$LOCAL_DIR/trusted-manifests"
  # shellcheck disable=SC2086
  $RSYNC -rt --ignore-existing --delete ${lock[@]+"${lock[@]}"} -e "$SSH $SSH_OPTS" "$HOST:$REMOTE_TRUSTED_MANIFESTS/" "$LOCAL_DIR/trusted-manifests/" \
    || { log "rsync of trusted-manifests from $HOST failed"; return 1; }
  # shellcheck disable=SC2086
  $RSYNC -t ${lock[@]+"${lock[@]}"} -e "$SSH $SSH_OPTS" "$HOST:$REMOTE_TRUST" "$LOCAL_DIR/manifests.sha256" || { log "rsync of manifests.sha256 from $HOST failed"; return 1; }
}

# verify: the newest manifest against the files here. Sets MISSING and CHANGED (counts), NEWEST (the mirror's copy)
# and READ (the copy the file list is read from: the server's trusted copy when there is one).
verify() {
  local name lines line sha rel list listed unlisted failed checked n
  MISSING=0
  CHANGED=0
  NEWEST=""
  # The server's rule for manifest names; any other name in manifests/ fails the run.
  for name in "$MIRROR_DIR"/manifests/*; do
    [ -e "$name" ] || continue
    if ! [[ $(basename "$name") =~ ^[0-9]{8}T[0-9]{6}Z\.json$ ]]; then log "manifests/ holds $(basename "$name"), which is not a manifest name"; CHANGED=1; return 1; fi
    NEWEST=$name
  done
  [ -n "$NEWEST" ] || { log "the mirror has no manifest"; MISSING=1; return 1; }
  READ=$NEWEST
  # Root's copy of the manifest, when the server keeps one, must be the same bytes; the list of files is read from it.
  local copy
  copy=$LOCAL_DIR/trusted-manifests/$(basename "$NEWEST")
  if [ -f "$copy" ]; then
    cmp -s "$NEWEST" "$copy" || { log "$(basename "$NEWEST") differs from the server's trusted copy: it was changed after the export"; CHANGED=1; return 1; }
    READ=$copy
  else
    log "no trusted copy of $(basename "$NEWEST") from the server; its hash is checked against manifests.sha256 only"
  fi
  # The manifest itself must be one the server's root recorded.
  sha=$(sha256_of "$NEWEST")
  # Whole-string checks first: a newline in either part would make grep -F match any listed line.
  if ! [[ $sha =~ ^[0-9a-f]{64}$ && $(basename "$NEWEST") =~ ^[0-9]{8}T[0-9]{6}Z\.json$ ]] \
    || ! grep -qxF -- "$sha  $(basename "$NEWEST")" "$LOCAL_DIR/manifests.sha256" 2>/dev/null; then
    log "$(basename "$NEWEST") (sha256 $sha) is not in the server's manifests.sha256: it was changed after the export"
    CHANGED=1
    return 1
  fi
  lines=$(manifest_lines "$READ") || { log "$(basename "$NEWEST") cannot be read"; CHANGED=1; return 1; }
  list=$(mktemp "$LOCAL_DIR/.check-XXXXXX")
  listed=$(mktemp "$LOCAL_DIR/.listed-XXXXXX")
  TMP_FILES+=("$list" "$listed")
  : >"$list"
  while IFS= read -r line; do
    [ -n "$line" ] || continue
    sha=${line%% *}
    rel=${line#* }
    # A hash that is not 64 lowercase hex digits would make the checker skip or reject the line: refuse it here.
    if ! [[ $sha =~ ^[0-9a-f]{64}$ && -n $rel && $rel != "$line" ]]; then log "the manifest has a malformed entry: $(printf '%s' "$line" | head -c 120)"; CHANGED=$((CHANGED + 1)); continue; fi
    case $rel in /* | *..*) log "the manifest lists a path outside the mirror: $rel"; CHANGED=$((CHANGED + 1)); continue ;; esac
    printf '%s\n' "$rel" >>"$listed"
    if [ -f "$MIRROR_DIR/$rel" ]; then
      printf '%s  %s\n' "$sha" "$rel" >>"$list"
    else
      MISSING=$((MISSING + 1))
      [ "$MISSING" -gt 10 ] || log "missing here: $rel"
    fi
  done <<EOF_LINES
$lines
EOF_LINES
  checked=0
  failed=$(sha256_check "$list") || checked=$?
  if [ "$checked" -ne 0 ]; then CHANGED=$((CHANGED + 1)); fi
  if [ -n "$failed" ]; then
    CHANGED=$((CHANGED + $(printf '%s\n' "$failed" | grep -c .)))
    printf '%s\n' "$failed" | sed -n '1,10p' | while IFS= read -r rel; do log "differs from the manifest: $rel"; done
  fi
  # Records here that the server's manifest does not list: kept (they are never deleted here), and named. The listed
  # paths are read from a file: a `grep -q` at the end of a pipe could fail the writer under pipefail.
  LC_ALL=C sort -o "$listed" "$listed"
  unlisted=$(for d in $RECORD_DIRS; do files_of "$MIRROR_DIR/$d" | sed "s|^|$d/|"; done | LC_ALL=C sort | comm -23 - "$listed")
  n=$(printf '%s\n' "$unlisted" | grep -c . || true)
  if [ "$n" -gt 0 ]; then
    log "$n record file(s) are kept here that the server's newest manifest does not list (the server lost them?):"
    printf '%s\n' "$unlisted" | sed -n '1,10p' | while IFS= read -r rel; do log "  kept: $rel"; done
  fi
  [ "$MISSING" -eq 0 ] && [ "$CHANGED" -eq 0 ]
}

main() {
  exec </dev/null
  umask 077
  # Private: the mirror keeps source hosts and job ids. The directories are 0700 whatever modes rsync gives the files
  # (the system's openrsync keeps the server's 0644).
  mkdir -p "$LOCAL_DIR" "$MIRROR_DIR"
  chmod 0700 "$LOCAL_DIR" "$MIRROR_DIR"
  if [ -f "$LOG" ] && [ "$(wc -c <"$LOG")" -gt "$LOG_MAX" ]; then mv -f "$LOG" "$LOG.1"; fi
  trap cleanup EXIT

  # One run at a time. A lock left by a run that died is taken over.
  local run_lock=$LOCAL_DIR/.pull.lock
  if ! mkdir "$run_lock" 2>/dev/null; then
    # The pid must be a number: `kill -0 0` signals this process's own group and always succeeds. A lock with no pid
    # (a run killed between its mkdir and writing the pid) is stale, but one younger than a minute may be a run that is
    # starting right now, so it counts as live.
    local holder
    holder=$(cat "$run_lock/pid" 2>/dev/null || true)
    case $holder in
      '' | *[!0-9]*)
        if [ -n "$(find "$run_lock" -maxdepth 0 -mmin -1 2>/dev/null)" ]; then die "another run is going (its lock is under a minute old and has no pid yet)"; fi
        log "the lock has no valid pid and is over a minute old; taking it over"
        ;;
      *)
        if kill -0 "$holder" 2>/dev/null; then die "another run is going"; fi
        ;;
    esac
    rm -rf "$run_lock"
    mkdir "$run_lock" || die "cannot take the lock"
  fi
  echo $$ >"$run_lock/pid"
  TMP_FILES+=("$run_lock")
  rm -f "$LOCAL_DIR"/.check-* "$LOCAL_DIR"/.listed-*

  log "pulling the mirror from $HOST"
  sync_once || die "the pull from $HOST failed"
  if ! verify; then
    [ "$CHANGED" -eq 0 ] || die "FAILED: $CHANGED file(s) here differ from the newest manifest; they are left as they are"
    log "$MISSING file(s) of the newest manifest are not here (the pull met an export?); pulling again"
    sync_once || die "the second pull from $HOST failed"
    verify || die "FAILED: the mirror here does not match its newest manifest ($MISSING missing, $CHANGED different)"
  fi
  local files
  files=$(printf '%s\n' "$(manifest_lines "$READ")" | grep -c . || true)
  log "verified against $(basename "$NEWEST"): $files file(s)"

  local old=0 f
  for f in "$LOCAL_DIR"/zk-bridge-proofs-*.tar.gz; do [ -e "$f" ] && old=$((old + 1)); done
  [ "$old" -eq 0 ] || log "$old bundle(s) of the old format stay in $LOCAL_DIR; nothing deletes them or makes new ones"

  if [ -n "${ZKB_PULL_HOOK:-}" ]; then
    if [ -x "$ZKB_PULL_HOOK" ] && "$ZKB_PULL_HOOK" "$MIRROR_DIR" "$NEWEST"; then log "hook ok"; else die "the hook failed"; fi
  fi
}

main "$@"
