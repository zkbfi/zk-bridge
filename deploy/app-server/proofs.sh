#!/usr/bin/env bash
# Exports and imports the durable proof archive of the zkb.fi app server. Run it as root on the server.
#
#   proofs.sh export                    # a nightly bundle (zk-bridge-proofs-export.timer runs this)
#   proofs.sh import <bundle.tar.gz>    # restore a bundle into this server (a fresh one, or a running one)
#   proofs.sh verify [<bundle.tar.gz>]  # re-check a bundle (default: the newest) against the chain
#   proofs.sh publish [--dry-run]       # build the PUBLIC proof tree and add it to IPFS (see "publish" below)
#
# A bundle is one tar.gz with a .sha256 file next to it, in /var/backups/zk-bridge/proofs:
#   manifest.json                        sha256 and size of every file below, the commit, the host
#   archive/*.ndjson                     the proof_archive schema of Postgres (storage proofs, light client proofs,
#                                        message evidence, conflicts), written by zk-bridge-proof-archive.mjs
#   backend/backend.sqlite               a consistent snapshot of the backend's database
#   files/runner/proof-cache/            the runner's opening proof cache
#   files/runner/beacon-states/          the beacon states of the runner and of the backend (plain files)
#   files/backend/beacon-states/
#
# export: copies the held files, snapshots the SQLite file, takes the cache and the backend's proofs into the archive
# (so every night's bundle holds everything the server has seen), exports the archive, writes the manifest, packs, and
# keeps the newest ZKB_PROOFS_KEEP (14) bundles. A conflict that the archive records (a different value for a key it
# already holds) is a warning here, not a failure.
#
# import: checks the .sha256 and the manifest, then loads the archive (it never overwrites a different value: it
# records the conflict). Each file is copied only when it is missing; an identical file is skipped, and a file that
# exists with other content is REPORTED and left alone. The backend's SQLite file is installed only when the server has
# none; otherwise its proofs are taken into the archive instead. A second import of the same bundle changes nothing.
# Exit 3 when there were conflicts, after everything else was done.
#
# verify: checks the .sha256 and the manifest, then re-verifies every storage proof against the state root of its block
# (an RPC, from /etc/zk-bridge/indexer/indexer.env). Exit 3 when a proof is invalid.
#
# publish: a separate PUBLIC tree, never the backup bundle. The archive CLI writes the allowlisted tree (storage-proofs,
# light-client-proofs, evidence, README.txt); this script adds the beacon states of the runner and the backend (only
# files named <12-digit slot>-0x<64 hex>.ssz or .summary under a numeric chain directory; the two sources are merged,
# identical files once, a same-name file with other content stops the run), the CLI's sanitizer (public-check) must pass,
# and manifest.json is written. --dry-run stops there, leaves the tree and prints its path for review. Without it the
# tree is added to the local IPFS node through its HTTP RPC API (POST /api/v0/add?cid-version=1&pin=true&pin-name=...,
# one multipart part per file and directory, as kubo's own client sends a tree; see ipfs_rpc), a line
#   <UTC time> <cid> <file count> <commit>
# is appended to ipfs-cids.log (append-only, in the backup directory), the newest ZKB_PROOFS_IPFS_KEEP (7) publications
# stay pinned and older CIDs from that log are unpinned (a CID that is not in the log is never touched), and the gateway
# form of the address is printed. export runs publish after its own work only when ZKB_PROOFS_PUBLISH=1 (the unit reads
# /etc/zk-bridge/proofs/proofs.env; off by default). The first publication is run by hand, after review of a dry run.
#
# Exit codes: 0 ok, 1 failure, 2 usage, 3 finished with conflicts (import) or invalid proofs (verify).
#
# The archive CLI runs as zkb_indexer in a transient unit (systemd-run) with the indexer's environment files: the
# files are read by systemd, and this script never prints or copies them. The service users' files are read and written
# as those users (runuser); root creates and deletes nothing inside a service's state directory.
# /var/backups/zk-bridge/proofs is 0711: the CLI user and the service users must reach the staging and extraction
# directories inside it, and cannot list it. The bundles are 0640 root:root.
#
# Overrides, for tests (defaults in brackets):
#   ZKB_PROOFS_DIR [/var/backups/zk-bridge/proofs]  ZKB_BACKEND_STATE [/var/lib/zk-bridge-backend]
#   ZKB_RUNNER_STATE [/var/lib/zk-bridge-runner]    ZKB_RELEASE_DIR [/opt/zk-bridge/current]
#   ZKB_INDEXER_ENV [/etc/zk-bridge/indexer/indexer.env]   ZKB_PROOFS_KEEP [14]   ZKB_PROOFS_STAMP [UTC now]
#   ZKB_PROOFS_CLI        a command prefix that replaces the systemd-run call (the command and its options follow)
#   ZKB_PROOFS_AS         an executable called as `$ZKB_PROOFS_AS <user> <command...>` instead of `runuser -u <user> --`
#   ZKB_PROOFS_OFFSITE_HOOK  one executable for the off-site copy (default: those in ZKB_PROOFS_OFFSITE_DIR
#                             [/etc/zk-bridge/proofs/offsite.d]), called as `<hook> <bundle> <sha256 file>`
#   ZKB_PROOFS_PUBLISH [0]  ZKB_PROOFS_IPFS_KEEP [7]  ZKB_PROOFS_GATEWAY_HOST [gateway.zkb.fi]
#   ZKB_IPFS_PATH [/var/lib/zk-bridge-ipfs/repo]   the node's repository: its config (API secret) and api file (address)
#   ZKB_PROOFS_UNPRIVILEGED=1   no root check, no chown
set -euo pipefail

log() { printf 'proofs: %s\n' "$*" >&2; }
die() { log "$*"; exit 1; }

BACKEND_STATE=${ZKB_BACKEND_STATE:-/var/lib/zk-bridge-backend}
RUNNER_STATE=${ZKB_RUNNER_STATE:-/var/lib/zk-bridge-runner}
OUT_DIR=${ZKB_PROOFS_DIR:-/var/backups/zk-bridge/proofs}
RELEASE_DIR=${ZKB_RELEASE_DIR:-/opt/zk-bridge/current}
INDEXER_ENV=${ZKB_INDEXER_ENV:-/etc/zk-bridge/indexer/indexer.env}
KEEP=${ZKB_PROOFS_KEEP:-14}
IPFS_REPO=${ZKB_IPFS_PATH:-/var/lib/zk-bridge-ipfs/repo}
IPFS_KEEP=${ZKB_PROOFS_IPFS_KEEP:-7}
GATEWAY_HOST=${ZKB_PROOFS_GATEWAY_HOST:-gateway.zkb.fi}
CID_LOG=$OUT_DIR/ipfs-cids.log
OFFSITE_DIR=${ZKB_PROOFS_OFFSITE_DIR:-/etc/zk-bridge/proofs/offsite.d}
DATABASE_URL_VALUE='postgresql:///zkb_indexer?host=/var/run/postgresql'
CLI_SCRIPT=$RELEASE_DIR/explorer/indexer/bin/zk-bridge-proof-archive.mjs

TMP_DIRS=("")
CLI_RC=0

cleanup() {
  local d
  for d in ${TMP_DIRS[@]+"${TMP_DIRS[@]}"}; do
    if [ -n "$d" ]; then rm -rf "$d"; fi
  done
}

# as_user <user> <command...>
as_user() {
  local user=$1
  shift
  if [ -n "${ZKB_PROOFS_AS:-}" ]; then "$ZKB_PROOFS_AS" "$user" "$@"; else runuser -u "$user" -- "$@"; fi
}

# own <user>:<group> <path...>
own() {
  [ -n "${ZKB_PROOFS_UNPRIVILEGED:-}" ] || chown "$@"
}

# cli <command> [options]: the archive CLI as zkb_indexer. Its summary (one JSON object) goes to standard output.
cli() {
  local -a prefix
  if [ -n "${ZKB_PROOFS_CLI:-}" ]; then
    read -r -a prefix <<<"$ZKB_PROOFS_CLI"
    "${prefix[@]}" "$@"
  else
    systemd-run --quiet --pipe --wait --collect --uid=zkb_indexer --gid=zkb_indexer \
      -p "EnvironmentFile=-$RELEASE_DIR/release.env" -p "EnvironmentFile=$INDEXER_ENV" \
      -p "Environment=DATABASE_URL=$DATABASE_URL_VALUE" \
      -p "WorkingDirectory=$RELEASE_DIR/explorer/indexer" \
      -p NoNewPrivileges=yes -p PrivateTmp=yes -p ProtectHome=yes -p ProtectSystem=strict \
      -p "ReadWritePaths=$OUT_DIR" \
      -- /usr/bin/node "$CLI_SCRIPT" "$@"
  fi
}

# run_cli <command> [options]: sets CLI_RC and never stops the script.
run_cli() {
  CLI_RC=0
  cli "$@" || CLI_RC=$?
}

# must_cli <command> [options]: stops the script unless the CLI exits 0.
must_cli() {
  run_cli "$@"
  [ "$CLI_RC" -eq 0 ] || die "$1 failed (exit $CLI_RC)"
}

sha256_of() {
  if command -v sha256sum >/dev/null 2>&1; then sha256sum "$1" | awk '{print $1}'; else shasum -a 256 "$1" | awk '{print $1}'; fi
}

# One tree copy, run as the owner of the destination: copies each regular file that is missing, skips identical ones and
# lists (never overwrites) those that differ. $1 source, $2 destination, $3 umask. Symbolic links are not followed.
COPY_TREE='
umask "$3"
src=$1 dest=$2
copied=0 identical=0 conflicts=0
while IFS= read -r -d "" f; do
  rel=${f#"$src"/}
  d=$dest/$rel
  if [ -e "$d" ] || [ -L "$d" ]; then
    if [ -f "$d" ] && [ ! -L "$d" ] && cmp -s "$f" "$d"; then
      identical=$((identical + 1))
    else
      echo "conflict: $rel differs from the file already there"
      conflicts=$((conflicts + 1))
    fi
    continue
  fi
  mkdir -p "$(dirname "$d")"
  # A new file through a redirect takes 0666 minus the umask. cp would keep the source mode (0600 in a service state
  # directory), and the archive user could not read the copy.
  if cat "$f" > "$d.part.$$" && mv "$d.part.$$" "$d"; then :; else rm -f "$d.part.$$"; exit 1; fi
  copied=$((copied + 1))
done < <(find "$src" -type f -print0)
echo "copied=$copied identical=$identical conflicts=$conflicts"
'

# Installs a file when the destination is missing. $1 source, $2 destination.
INSTALL_IF_MISSING='
umask 077
if [ -e "$2" ]; then echo exists; exit 0; fi
if cp "$1" "$2.part.$$" && mv "$2.part.$$" "$2"; then echo installed; else rm -f "$2.part.$$"; exit 1; fi
'

# copy_tree <user> <source> <destination> <umask>: prints the report; sets TREE_CONFLICTS.
copy_tree() {
  local user=$1 src=$2 dest=$3 mask=$4 out
  TREE_CONFLICTS=0
  out=$(as_user "$user" bash -c "$COPY_TREE" _ "$src" "$dest" "$mask") || die "copying $src for $user failed"
  printf '%s\n' "$out"
  TREE_CONFLICTS=$(printf '%s\n' "$out" | sed -n 's/.*conflicts=\([0-9][0-9]*\)$/\1/p' | tail -n 1)
  TREE_CONFLICTS=${TREE_CONFLICTS:-0}
}

release_commit() {
  local v=""
  if [ -f "$RELEASE_DIR/release.env" ]; then
    v=$(sed -n 's/^ZKB_RELEASE=//p' "$RELEASE_DIR/release.env" | tail -n 1 | tr -d "\"'")
  fi
  printf '%s' "${v:-unknown}"
}

prepare_out_dir() {
  [ -d "$OUT_DIR" ] || { mkdir -p "$OUT_DIR"; chmod 0711 "$OUT_DIR"; }
}

# Two runs never overlap.
take_lock() {
  if command -v flock >/dev/null 2>&1; then
    exec 9>"$OUT_DIR/.lock"
    flock -n 9 || die "another run holds the lock"
  else
    # No flock (macOS, tests): a directory is the lock.
    mkdir "$OUT_DIR/.lock.d" 2>/dev/null || die "another run holds the lock ($OUT_DIR/.lock.d)"
    TMP_DIRS+=("$OUT_DIR/.lock.d")
  fi
}

# offsite_upload <bundle> <sha256 file>: ships a finished bundle off the server. This is the place where a Cloudflare R2
# (S3-compatible) uploader plugs in later: drop an executable into /etc/zk-bridge/proofs/offsite.d/ (run in name order),
# or point ZKB_PROOFS_OFFSITE_HOOK at one. Each is called as `<hook> <bundle> <sha256 file>` as root, with this script's
# environment. With no hook it does nothing. Returns non-zero when a hook failed; the caller decides what that means.
offsite_upload() {
  local bundle=$1 sum=$2 hook failed=0 ran=0
  local hooks=""
  if [ -n "${ZKB_PROOFS_OFFSITE_HOOK:-}" ]; then
    hooks=$ZKB_PROOFS_OFFSITE_HOOK
  elif [ -d "$OFFSITE_DIR" ]; then
    for hook in "$OFFSITE_DIR"/*; do
      if [ -f "$hook" ] && [ -x "$hook" ]; then hooks="$hooks$hook
"; fi
    done
  fi
  while IFS= read -r hook; do
    [ -n "$hook" ] || continue
    ran=$((ran + 1))
    if [ -x "$hook" ] && "$hook" "$bundle" "$sum"; then
      log "off-site hook $(basename "$hook"): ok"
    else
      log "ERROR: off-site hook $(basename "$hook") failed"
      failed=1
    fi
  done <<EOF_HOOKS
$hooks
EOF_HOOKS
  [ "$ran" -gt 0 ] || log "no off-site hook: the bundle stays on this server"
  return "$failed"
}

# --- publish ------------------------------------------------------------------------------------------------------
# The kubo node of provision.sh, reached through its HTTP RPC API with curl. The API wants a secret, and a secret never
# goes on a command line (any local user can read those): the node's user reads AuthSecret from the node's config with
# jq, turns it into the Authorization header the way kubo does (config/api.go: "bearer:<t>" or a bare "<t>" is
# "Bearer <t>"; "basic:<user>:<pass>" is "Basic " and the base64 of "<user>:<pass>"; "basic:<b64>" is "Basic <b64>";
# any other "<type>:" is refused), and pipes the header line into `curl -H @-`. The address comes from the api file of
# the repository (the running daemon writes it), else Addresses.API, and must be a loopback address.
#   sh -c "$IPFS_RPC" sh <endpoint with query> [curl options...]   as the node's user, IPFS_PATH set
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
endpoint=$1
shift
printf "Authorization: %s\n" "$header" | curl -sS --fail-with-body -X POST -H @- "http://$host:$port$endpoint" "$@"
'

# ipfs_rpc <endpoint with query> [curl options...]: one call of the node's RPC API, as the node's user.
ipfs_rpc() {
  as_user zkb_ipfs env "IPFS_PATH=$IPFS_REPO" sh -c "$IPFS_RPC" sh "$@"
}

# ipfs_add_tree <tree> <pin name>: adds the tree (pinned, CIDv1) and prints its root CID. The form parts go into a curl
# config file (no secret in it), one per directory and file, in the order of find (each directory before what it holds,
# as kubo's MultiFileReader sends them), each filename url-encoded as kubo's client does (url.QueryEscape; the tree
# holds only [A-Za-z0-9._-] names, so only "/" changes).
ipfs_add_tree() {
  local tree=$1 name=$2 root parts entry rel enc answer cid
  root=$(basename "$tree")
  parts=$(dirname "$tree")/curl-add.conf
  case $tree in *[\;,\"\\]*) die "the tree path holds a character curl's form syntax cannot carry: $tree" ;; esac
  : >"$parts"
  while IFS= read -r entry; do
    rel=$root${entry#"$tree"}
    case $rel in *[!A-Za-z0-9._/-]*) die "a file name the public tree may not hold: $rel" ;; esac
    enc=${rel//\//%2F}
    if [ -d "$entry" ]; then
      printf 'form = "file=@/dev/null;filename=%s;type=application/x-directory"\n' "$enc" >>"$parts"
    else
      printf 'form = "file=@%s;filename=%s;type=application/octet-stream"\n' "$entry" "$enc" >>"$parts"
    fi
  done < <(find "$tree")
  chmod 0644 "$parts"
  answer=$(ipfs_rpc "/api/v0/add?cid-version=1&pin=true&pin-name=$name&progress=false" -K "$parts") || die "ipfs add failed"
  cid=$(printf '%s\n' "$answer" | jq -r --arg root "$root" 'select(.Name == $root) | .Hash' | tail -n 1)
  case $cid in '' | *[!A-Za-z0-9]*) die "the add answer names no root CID" ;; esac
  printf '%s\n' "$cid"
}

# Copies the beacon state files of one service into $2/<chainId>/ by their owner. Only plain files with the exact names.
COPY_BEACON='
umask 022
src=$1 dest=$2
n=0 skipped=0
for chain in "$src"/*/; do
  [ -d "$chain" ] && [ ! -L "${chain%/}" ] || continue
  c=$(basename "$chain")
  case $c in "" | *[!0-9]*) skipped=$((skipped + 1)); continue ;; esac
  for f in "$chain"*; do
    [ -f "$f" ] && [ ! -L "$f" ] || continue
    name=$(basename "$f")
    if printf "%s\n" "$name" | grep -Eq "^[0-9]{12}-0x[0-9a-f]{64}\.(ssz|summary)$"; then
      mkdir -p "$dest/$c"
      cp "$f" "$dest/$c/$name"
      n=$((n + 1))
    else
      skipped=$((skipped + 1))
    fi
  done
done
echo "beacon-files=$n skipped=$skipped"
'

# Same modes and times for every file, so the tree does not depend on when or how it was built.
normalize_tree() {
  find "$1" -type d -exec chmod 0755 {} +
  find "$1" -type f -exec chmod 0644 {} +
  find "$1" -exec touch -t 200001010000 {} +
}

cmd_publish() {
  local dry=0 arg
  for arg in "$@"; do
    case $arg in --dry-run) dry=1 ;; *) usage ;; esac
  done
  case $IPFS_KEEP in '' | *[!0-9]* | 0) die "ZKB_PROOFS_IPFS_KEEP must be a positive number, not '$IPFS_KEEP'" ;; esac
  umask 022
  local stamp=${ZKB_PROOFS_STAMP:-$(date -u +%Y%m%dT%H%M%SZ)}
  local work=$OUT_DIR/.publish-$stamp tree src
  tree=$work/tree
  src=$work/src
  rm -rf "$OUT_DIR"/.publish-*
  mkdir "$work"
  chmod 0755 "$work"
  mkdir -p "$tree" "$src/runner" "$src/backend"
  chmod 0755 "$tree" "$src" "$src/runner" "$src/backend"
  own zkb_runner:zkb_runner "$src/runner"
  own zkb_backend:zkb_backend "$src/backend"
  own zkb_indexer:zkb_indexer "$tree"

  must_cli public-export --out "$tree"

  # The beacon states, from both services; each by its owner.
  local out
  if [ -d "$RUNNER_STATE/beacon-states" ]; then
    out=$(as_user zkb_runner bash -c "$COPY_BEACON" _ "$RUNNER_STATE/beacon-states" "$src/runner") || die "reading the runner's beacon states failed"
    log "runner beacon states: $out"
  else
    log "no $RUNNER_STATE/beacon-states: skipped"
  fi
  if [ -d "$BACKEND_STATE/beacon-states" ]; then
    out=$(as_user zkb_backend bash -c "$COPY_BEACON" _ "$BACKEND_STATE/beacon-states" "$src/backend") || die "reading the backend's beacon states failed"
    log "backend beacon states: $out"
  else
    log "no $BACKEND_STATE/beacon-states: skipped"
  fi
  local who f rel dest merged=0
  for who in runner backend; do
    while IFS= read -r -d '' f; do
      rel=${f#"$src/$who"/}
      dest=$tree/beacon-states/$rel
      if [ -e "$dest" ]; then
        cmp -s "$f" "$dest" || die "beacon state $rel exists in both services with different content: not publishing"
        continue
      fi
      mkdir -p "$(dirname "$dest")"
      cp "$f" "$dest"
      merged=$((merged + 1))
    done < <(find "$src/$who" -type f -print0)
  done
  log "beacon states in the tree: $merged"
  rm -rf "$src"

  # The public manifest leaves out the host name. The sanitizer runs last, so it checks the manifest too.
  local -a mlog=()
  if [ -f "$CID_LOG" ]; then mlog=(--ipfs-log "$CID_LOG"); fi
  must_cli manifest-write --dir "$tree" --commit "$(release_commit)" --public ${mlog[@]+"${mlog[@]}"}
  must_cli public-check --dir "$tree"
  normalize_tree "$tree"
  local files
  files=$(find "$tree" -type f | wc -l | tr -d ' ')

  if [ "$dry" -eq 1 ]; then
    log "dry run: $files files, nothing added to IPFS. Review the tree, then run: proofs.sh publish"
    printf 'tree: %s\n' "$tree"
    return 0
  fi
  TMP_DIRS+=("$work")

  local cid
  cid=$(ipfs_add_tree "$tree" "zkb-proofs-$stamp") || die "ipfs add failed"
  printf '%s %s %s %s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$cid" "$files" "$(release_commit)" >>"$CID_LOG"
  chmod 0644 "$CID_LOG"

  # Retention: the newest IPFS_KEEP distinct CIDs of the log stay pinned. Only CIDs from the log are ever unpinned.
  local old total=0 i=0 unpinned=0 c
  old=$(awk '$2 ~ /^[A-Za-z0-9]+$/ {last[$2] = NR} END {for (c in last) print last[c], c}' "$CID_LOG" | sort -n | awk '{print $2}')
  total=$(printf '%s\n' "$old" | grep -c . || true)
  while IFS= read -r c; do
    [ -n "$c" ] || continue
    i=$((i + 1))
    [ $((total - i)) -ge "$IPFS_KEEP" ] || continue
    [ "$c" != "$cid" ] || continue
    if ipfs_rpc "/api/v0/pin/ls?arg=$c&type=recursive" >/dev/null 2>&1; then
      if ipfs_rpc "/api/v0/pin/rm?arg=$c" >/dev/null; then unpinned=$((unpinned + 1)); else log "WARNING: could not unpin $c"; fi
    fi
  done <<EOF_OLD
$old
EOF_OLD
  log "published $files files; $((total - unpinned)) publication(s) of the log pinned, $unpinned unpinned"
  printf 'cid: %s\n' "$cid"
  printf 'files: %s\n' "$files"
  printf 'gateway: %s/ipfs/%s\n' "$GATEWAY_HOST" "$cid"
  rm -rf "$work"
}

# --- export -------------------------------------------------------------------------------------------------------
cmd_export() {
  local stamp=${ZKB_PROOFS_STAMP:-$(date -u +%Y%m%dT%H%M%SZ)}
  local stage=$OUT_DIR/.staging-$stamp
  local bundle=$OUT_DIR/zk-bridge-proofs-$stamp.tar.gz
  local warnings=0 snapshot=0 cache=0
  case $KEEP in '' | *[!0-9]* | 0) die "ZKB_PROOFS_KEEP must be a positive number, not '$KEEP'" ;; esac
  [ ! -e "$bundle" ] || die "$bundle exists already"

  rm -rf "$OUT_DIR"/.staging-* "$OUT_DIR"/.extract-*
  mkdir "$stage"
  TMP_DIRS+=("$stage")
  chmod 0755 "$stage"
  mkdir -p "$stage/backend" "$stage/files/runner" "$stage/files/backend"
  chmod 0755 "$stage/backend" "$stage/files" "$stage/files/runner" "$stage/files/backend"
  own zkb_backend:zkb_backend "$stage/backend" "$stage/files/backend"
  own zkb_runner:zkb_runner "$stage/files/runner"

  # The SQLite file: a consistent snapshot (the online backup API), taken by the backend's user.
  if [ -f "$BACKEND_STATE/backend.sqlite" ]; then
    log "snapshot of backend.sqlite"
    # The copy keeps the WAL mode of the source, and a read-only open of a WAL file must write its -shm next to it, which
    # the archive user cannot. A rollback-journal copy opens read only with no writes.
    as_user zkb_backend sh -c 'umask 022; sqlite3 -cmd ".timeout 5000" "$1" ".backup \"$2\"" && exec sqlite3 "$2" "PRAGMA journal_mode=DELETE;" >/dev/null' _ \
      "$BACKEND_STATE/backend.sqlite" "$stage/backend/backend.sqlite" || die "the SQLite snapshot failed"
    snapshot=1
  else
    log "no $BACKEND_STATE/backend.sqlite: no SQLite snapshot in this bundle"
  fi

  # The files the services hold, as plain trees the archive user can read.
  if [ -d "$RUNNER_STATE/proof-cache" ]; then
    log "copying the runner's proof cache"
    copy_tree zkb_runner "$RUNNER_STATE/proof-cache" "$stage/files/runner/proof-cache" 022
    cache=1
  else
    log "no $RUNNER_STATE/proof-cache: skipped"
  fi
  if [ -d "$RUNNER_STATE/beacon-states" ]; then
    log "copying the runner's beacon states"
    copy_tree zkb_runner "$RUNNER_STATE/beacon-states" "$stage/files/runner/beacon-states" 022
  else
    log "no $RUNNER_STATE/beacon-states: skipped"
  fi
  if [ -d "$BACKEND_STATE/beacon-states" ]; then
    log "copying the backend's beacon states"
    copy_tree zkb_backend "$BACKEND_STATE/beacon-states" "$stage/files/backend/beacon-states" 022
  else
    log "no $BACKEND_STATE/beacon-states: skipped"
  fi

  # The archive user writes <stage>/archive and manifest.json.
  own zkb_indexer:zkb_indexer "$stage"
  must_cli migrate
  if [ "$cache" -eq 1 ]; then
    run_cli ingest-cache --dir "$stage/files/runner/proof-cache"
    case $CLI_RC in 0) ;; 3) warnings=$((warnings + 1)); log "WARNING: ingest-cache found conflicts (recorded in the archive)" ;; *) die "ingest-cache failed (exit $CLI_RC)" ;; esac
  fi
  if [ "$snapshot" -eq 1 ]; then
    run_cli ingest-backend --sqlite "$stage/backend/backend.sqlite"
    case $CLI_RC in 0) ;; 3) warnings=$((warnings + 1)); log "WARNING: ingest-backend found conflicts (recorded in the archive)" ;; *) die "ingest-backend failed (exit $CLI_RC)" ;; esac
  fi
  must_cli export --out "$stage"
  # The backup manifest records the newest publication of the public tree, when there is one.
  local -a mlog=()
  if [ -f "$CID_LOG" ]; then mlog=(--ipfs-log "$CID_LOG"); fi
  must_cli manifest-write --dir "$stage" --commit "$(release_commit)" ${mlog[@]+"${mlog[@]}"}

  # Pack. The bundle appears under its name only when complete.
  umask 027
  tar -czf "$bundle.part" -C "$stage" .
  mv "$bundle.part" "$bundle"
  own root:root "$bundle"
  chmod 0640 "$bundle"
  printf '%s  %s\n' "$(sha256_of "$bundle")" "$(basename "$bundle")" >"$bundle.sha256"
  own root:root "$bundle.sha256"
  chmod 0640 "$bundle.sha256"
  rm -rf "$stage"

  # Retention: the newest KEEP bundles stay.
  local -a all
  local f total=0 i=0 pruned=0
  for f in "$OUT_DIR"/zk-bridge-proofs-*.tar.gz; do
    [ -e "$f" ] || continue
    all[total]=$f
    total=$((total + 1))
  done
  for f in ${all[@]+"${all[@]}"}; do
    if [ $((total - i)) -gt "$KEEP" ]; then
      rm -f "$f" "$f.sha256"
      pruned=$((pruned + 1))
    fi
    i=$((i + 1))
  done

  # Off-site copy, after the local bundle and the retention are done: a failing hook fails the run, not the bundle.
  local offsite=0
  offsite_upload "$bundle" "$bundle.sha256" || offsite=1

  # The public tree, only when switched on (ZKB_PROOFS_PUBLISH=1 in /etc/zk-bridge/proofs/proofs.env). A failure here
  # fails the run after everything above is done. A subshell, so that its die does not skip the lines below.
  local published=0
  if [ "${ZKB_PROOFS_PUBLISH:-0}" = 1 ]; then
    ( cmd_publish ) || published=1
  fi

  log "done: $((total - pruned)) bundle(s) kept, $pruned pruned, $warnings warning(s)"
  printf 'bundle: %s\n' "$bundle"
  [ "$offsite" -eq 0 ] || die "the off-site upload failed; the bundle is complete on this server"
  [ "$published" -eq 0 ] || die "the publication failed; the bundle is complete on this server"
}

# --- shared by import and verify ------------------------------------------------------------------------------------
# extract_bundle <bundle>: checks the .sha256, unpacks into a fresh directory (EXTRACTED) and checks the manifest.
extract_bundle() {
  local bundle=$1 want got
  [ -f "$bundle" ] || die "no such bundle: $bundle"
  if [ -f "$bundle.sha256" ]; then
    want=$(awk '{print $1; exit}' "$bundle.sha256")
    got=$(sha256_of "$bundle")
    [ "$want" = "$got" ] || die "$bundle does not match its .sha256"
    log "sha256 matches"
  else
    log "no $bundle.sha256: only the manifest vouches for the bundle"
  fi
  EXTRACTED=$(mktemp -d "$OUT_DIR/.extract-XXXXXX")
  TMP_DIRS+=("$EXTRACTED")
  chmod 0755 "$EXTRACTED"
  tar --no-same-owner -xzf "$bundle" -C "$EXTRACTED" || die "cannot unpack $bundle"
  # Only plain files and directories, none shared by a hard link: nothing a service user copies can point elsewhere.
  if [ -n "$(find "$EXTRACTED" ! -type f ! -type d -print -quit)" ] || [ -n "$(find "$EXTRACTED" -type f -links +1 -print -quit)" ]; then
    die "$bundle holds links or special files"
  fi
  find "$EXTRACTED" -type d -exec chmod 0755 {} +
  find "$EXTRACTED" -type f -exec chmod 0644 {} +
  run_cli manifest-check --dir "$EXTRACTED"
  [ "$CLI_RC" -eq 0 ] || die "$bundle fails its manifest (exit $CLI_RC)"
}

# --- import -------------------------------------------------------------------------------------------------------
cmd_import() {
  local bundle=${1:-} conflicts=0 state
  [ -n "$bundle" ] || usage
  extract_bundle "$bundle"
  local dir=$EXTRACTED

  must_cli migrate
  if [ -d "$dir/archive" ]; then
    run_cli import --in "$dir"
    case $CLI_RC in 0) ;; 3) conflicts=$((conflicts + 1)); log "the archive recorded conflicts" ;; *) die "import failed (exit $CLI_RC)" ;; esac
  else
    log "the bundle has no archive directory"
  fi

  if [ -f "$dir/backend/backend.sqlite" ]; then
    run_cli ingest-backend --sqlite "$dir/backend/backend.sqlite"
    case $CLI_RC in 0) ;; 3) conflicts=$((conflicts + 1)); log "ingest-backend recorded conflicts" ;; *) die "ingest-backend failed (exit $CLI_RC)" ;; esac
    state=$(as_user zkb_backend bash -c "$INSTALL_IF_MISSING" _ "$dir/backend/backend.sqlite" "$BACKEND_STATE/backend.sqlite") \
      || die "installing backend.sqlite failed"
    if [ "$state" = installed ]; then
      log "backend.sqlite: this server had none, the snapshot is installed"
    else
      log "backend.sqlite: left as it is; its proofs went into the archive instead"
    fi
  fi

  # Each entry: user, path in the bundle, destination.
  local tree n user rel dest
  for tree in "zkb_runner files/runner/proof-cache $RUNNER_STATE/proof-cache" \
    "zkb_runner files/runner/beacon-states $RUNNER_STATE/beacon-states" \
    "zkb_backend files/backend/beacon-states $BACKEND_STATE/beacon-states"; do
    read -r user rel dest <<<"$tree"
    if [ -d "$dir/$rel" ]; then
      log "files: $rel -> $dest"
      copy_tree "$user" "$dir/$rel" "$dest" 077
      n=$TREE_CONFLICTS
      conflicts=$((conflicts + n))
    else
      log "files: $rel is not in the bundle"
    fi
  done

  log "done: $conflicts conflict(s)"
  printf 'conflicts: %s\n' "$conflicts"
  if [ "$conflicts" -gt 0 ]; then
    log "files and archive entries that differ were NOT overwritten; see the lines above"
    exit 3
  fi
}

# --- verify -------------------------------------------------------------------------------------------------------
cmd_verify() {
  local bundle=${1:-} f
  if [ -z "$bundle" ]; then
    for f in "$OUT_DIR"/zk-bridge-proofs-*.tar.gz; do
      [ -e "$f" ] && bundle=$f
    done
    [ -n "$bundle" ] || die "no bundle in $OUT_DIR"
    log "newest bundle: $bundle"
  fi
  extract_bundle "$bundle"
  run_cli verify-storage --in "$EXTRACTED"
  if [ "$CLI_RC" -ne 0 ]; then
    log "verify-storage exit $CLI_RC: at least one proof did not verify"
    exit "$CLI_RC"
  fi
  log "all storage proofs verify"
}

usage() {
  log "usage: proofs.sh export | import <bundle.tar.gz> | verify [<bundle.tar.gz>] | publish [--dry-run]"
  exit 2
}

# Everything runs inside main: when the script comes in on standard input (bash -s), bash has read all of it before
# the first command runs, so no command can swallow the rest of the script.
main() {
  exec </dev/null
  umask 022
  local cmd=${1:-}
  case $cmd in export | import | verify | publish) ;; *) usage ;; esac
  [ -n "${ZKB_PROOFS_UNPRIVILEGED:-}" ] || [ "$(id -u)" -eq 0 ] || die "run as root"
  trap cleanup EXIT
  prepare_out_dir
  take_lock
  shift
  case $cmd in
    export) cmd_export ;;
    import) cmd_import "$@" ;;
    verify) cmd_verify "$@" ;;
    publish) cmd_publish "$@" ;;
  esac
}

main "$@"
