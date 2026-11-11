#!/usr/bin/env bash
# Keeps the durable proof archive of the zkb.fi app server in a private mirror, and restores it. Run it as root on the
# server.
#
#   proofs.sh export                       # update the mirror (zk-bridge-proofs-export.timer runs this every night)
#   proofs.sh import [<mirror dir> | <bundle.tar.gz>]   # restore into this server (default: this server's mirror)
#   proofs.sh verify [<mirror dir>]        # the newest manifest, then every storage proof against the chain
#   proofs.sh publish [--dry-run]          # build the PUBLIC proof tree and add it to IPFS (see "publish" below)
#   proofs.sh bundle                       # one tar.gz of the whole mirror, for a one-off copy
#
# Owner, 2026-11-02: "ok, so lets plan to do 30 days of everything".
#
# The mirror is /var/backups/zk-bridge/proofs/mirror (ZKB_PROOFS_MIRROR). It is PRIVATE: it keeps the whole records,
# with source hosts and backend job ids. One file per record, named by its content, written once and never again:
#   storage-proofs/<chain>/<account>/<block>-<block hash>.<sha256>.json        never deleted
#   light-client-proofs/<pair>/<direction>/<start>-<new>-<proof hash>.<sha256>.json   never deleted
#   evidence/<pair>/<direction>/<message id>-<body sha256>.<sha256>.json       never deleted
#   handoff-updates/<chain id>/<period>.<sha256>.json   a source chain's sync-committee handoff update   never deleted
#   fork-proofs/<chain id>/<state root>.<sha256>.json   the fork proof of a source block that carries a message   never deleted
#   conflicts/conflict.<sha256>.json         the archive's conflict reports    never deleted
#   beacon-states/<chain>/<slot>-<root>.ssz|.summary   from the runner and the backend; kept ZKB_PROOFS_RETENTION_DAYS
#   snapshots/<stamp>.sqlite                 the backend's database, one a night; kept ZKB_PROOFS_RETENTION_DAYS
#   manifests/<stamp>.json                   sha256 and size of every other file, one a night; kept the same
# <sha256> is the hash of the file itself, so a record that a later source filled in (a posting transaction) is a new
# file beside the old one. A file whose name exists with other content is never overwritten: the run reports it as
# ERROR and fails at its end, after everything else is done. The window (30 days) counts from each beacon state's slot
# time (the genesis time in the state, the chain's slot length), not from the file time; snapshots and manifests count
# from the stamp in their names.
#
# export: snapshots the backend's SQLite file (rollback journal, so the archive user opens it read only), copies the
# runner's proof cache and both services' beacon states into a staging directory (their copies 0644: the services keep
# 0600 files, and the archive user reads the copies), takes the cache and the backend's proofs into the archive, writes
# every archive row as a record file, adds the beacon states and the snapshot, prunes the window, and writes the
# manifest of the day. The services keep 3 days of states, so the nightly run copies each state long before they prune
# it. A state the services hold and the mirror lacks afterwards is a WARNING. Then the off-site hook and, when switched
# on, the publication.
#
# Trust: the mirror is writable by zkb_indexer, so root never reads, chmods or chowns a path inside it (the archive
# user does that work, and streams a tar when root needs a copy). Root's trust list,
# /var/backups/zk-bridge/proofs/manifests.sha256 (root's, 0644, outside the mirror, appended to only), holds only hashes
# of bytes root itself holds: its own copy of each day's manifest (trusted-manifests/<stamp>.json, as the CLI printed
# it to root), the backend snapshot and the beacon states as the services handed them to root. Import installs only a
# snapshot and states listed there, and import and verify accept only a manifest equal to root's copy. Manifest names
# follow one rule (YYYYMMDDTHHMMSSZ.json) in the script and the CLI, and the script names the manifest it picked.
#
# import: copies the input (a directory, by default this server's mirror read by zkb_indexer, or an unpacked tar.gz)
# into a directory only root can write, refusing links, special files and hard links; its newest manifest must be root's
# copy and listed (for a mirror from another server: --trust-list <its manifests.sha256>, or --manifest-sha256 and
# --snapshot-sha256 by hand), the copy must match that manifest exactly, and then it upserts every
# record file into the archive (it never overwrites a different value: it records the conflict), ingests the newest
# snapshot and installs it when the server has no backend database, and gives each service the 16 newest beacon states
# of each chain (copied only when missing; a file that exists with other content is reported and left alone). With a
# tar.gz: a mirror bundle (proofs.sh bundle) is unpacked and imported the same way; an old nightly bundle
# (zk-bridge-proofs-<stamp>.tar.gz, archive/*.ndjson) is still imported as before. Exit 3 when there were conflicts.
#
# verify: the newest manifest must be in manifests.sha256 and match the mirror exactly (a WARNING when it is not
# today's), then every storage proof
# is verified again against the state root of its block (an RPC, from /etc/zk-bridge/indexer/indexer.env). Exit 3 when
# a proof is invalid, 1 when the mirror does not match.
#
# bundle: zk-bridge-mirror-<stamp>.tar.gz and its .sha256 in /var/backups/zk-bridge/proofs, for a one-off copy. Delete
# it when it has been copied; the nightly run does not make or keep any.
#
# publish: a separate PUBLIC tree, never the mirror. The archive user builds it: the CLI writes the allowlisted tree
# (storage-proofs, light-client-proofs, evidence, handoff-updates, fork-proofs, README.txt), the beacon states of the mirror are copied in (the whole
# window; only plain files named <12-digit slot>-0x<64 hex>.ssz or .summary under a numeric chain directory, never a
# link), and manifest.json is written. Root takes it as a tar stream into a directory only root can write (links,
# special files and hard links stop the run), and the CLI's sanitizer (public-check) must pass on that copy. --dry-run stops there, leaves the tree and prints its path for
# review. Without it the tree is added to the local IPFS node through its HTTP RPC API (POST
# /api/v0/add?cid-version=1&pin=true&pin-name=..., one multipart part per file and directory, as kubo's own client
# sends a tree; see ipfs_rpc), a line
#   <UTC time> <cid> <file count> <commit>
# is appended to ipfs-cids.log (append-only, in the backup directory), the newest ZKB_PROOFS_IPFS_KEEP (2) publications
# stay pinned (each holds the whole window) and older CIDs from that log are unpinned (a CID that is not in the log is
# never touched), a garbage collection of the node frees what was unpinned, and the gateway form of the address is
# printed. export runs publish after its own work only when
# ZKB_PROOFS_PUBLISH=1 (the unit reads /etc/zk-bridge/proofs/proofs.env; off by default). The first publication is run
# by hand, after review of a dry run.
#
# Exit codes: 0 ok, 1 failure, 2 usage, 3 finished with conflicts (import) or invalid proofs (verify).
#
# The archive CLI runs as zkb_indexer in a transient unit (systemd-run) with the indexer's environment files: the
# files are read by systemd, and this script never prints or copies them. The mirror belongs to zkb_indexer (the CLI
# writes and prunes in it): its top directory is 0750, the directories in it 0755 and the files 0644, and each run sets
# that again. The service users' files are read and written as those users (runuser); root creates and deletes nothing
# inside a service's state directory. /var/backups/zk-bridge/proofs is 0711: the CLI user and the service users must
# reach the staging directories inside it, and cannot list it.
#
# Settings (environment; /etc/zk-bridge/proofs/proofs.env for the nightly unit; defaults in brackets):
#   ZKB_PROOFS_MIRROR [<ZKB_PROOFS_DIR>/mirror]   another place needs ReadWritePaths in the unit (a drop-in)
#   ZKB_PROOFS_RETENTION_DAYS [30]   ZKB_PROOFS_PUBLISH [0]   ZKB_PROOFS_IPFS_KEEP [2]
#   ZKB_PROOFS_IPFS_GC [1]   after an unpin, a garbage collection of the node (it keeps pinned content only)
#   ZKB_PROOFS_GATEWAY_HOST [gateway.zkb.fi]
#   ZKB_PROOFS_OFFSITE_HOOK  one executable for the off-site copy (default: those in ZKB_PROOFS_OFFSITE_DIR
#                             [/etc/zk-bridge/proofs/offsite.d]), called as `<hook> <mirror dir> <manifest of the day>`
# Overrides, for tests:
#   ZKB_PROOFS_DIR [/var/backups/zk-bridge/proofs]  ZKB_BACKEND_STATE [/var/lib/zk-bridge-backend]
#   ZKB_RUNNER_STATE [/var/lib/zk-bridge-runner]    ZKB_RELEASE_DIR [/opt/zk-bridge/current]
#   ZKB_INDEXER_ENV [/etc/zk-bridge/indexer/indexer.env]   ZKB_PROOFS_STAMP [UTC now]
#   ZKB_PROOFS_CLI        a command prefix that replaces the systemd-run call (the command and its options follow)
#   ZKB_PROOFS_AS         an executable called as `$ZKB_PROOFS_AS <user> <command...>` instead of `runuser -u <user> --`
#   ZKB_PINS_REFRESH [systemctl start zk-bridge-ipfs-pins.service]   the command that refreshes the list of pinned CIDs after a publish
#   ZKB_IPFS_PATH [/var/lib/zk-bridge-ipfs/repo]   the node's repository: its config (API secret) and api file (address)
#   ZKB_PROOFS_UNPRIVILEGED=1   no root check, no chown
set -euo pipefail

log() { printf 'proofs: %s\n' "$*" >&2; }
die() { log "$*"; exit 1; }

BACKEND_STATE=${ZKB_BACKEND_STATE:-/var/lib/zk-bridge-backend}
RUNNER_STATE=${ZKB_RUNNER_STATE:-/var/lib/zk-bridge-runner}
OUT_DIR=${ZKB_PROOFS_DIR:-/var/backups/zk-bridge/proofs}
MIRROR=${ZKB_PROOFS_MIRROR:-$OUT_DIR/mirror}
RETENTION_DAYS=${ZKB_PROOFS_RETENTION_DAYS:-30}
RELEASE_DIR=${ZKB_RELEASE_DIR:-/opt/zk-bridge/current}
INDEXER_ENV=${ZKB_INDEXER_ENV:-/etc/zk-bridge/indexer/indexer.env}
IPFS_REPO=${ZKB_IPFS_PATH:-/var/lib/zk-bridge-ipfs/repo}
IPFS_KEEP=${ZKB_PROOFS_IPFS_KEEP:-2}
GATEWAY_HOST=${ZKB_PROOFS_GATEWAY_HOST:-gateway.zkb.fi}
CID_LOG=$OUT_DIR/ipfs-cids.log
# The sha256 of each day's manifest, appended by root at export time: root-owned (0644) outside the mirror, so the
# archive user cannot change what an import or a pull trusts.
TRUST=$OUT_DIR/manifests.sha256
# Root's own copies of each day's manifest, as the CLI printed them to root (root:root 0644, outside the mirror). Import
# and verify compare the mirror's manifest with this copy byte for byte.
TRUSTED_MANIFESTS=$OUT_DIR/trusted-manifests
OFFSITE_DIR=${ZKB_PROOFS_OFFSITE_DIR:-/etc/zk-bridge/proofs/offsite.d}
DATABASE_URL_VALUE='postgresql:///zkb_indexer?host=/var/run/postgresql'
CLI_SCRIPT=$RELEASE_DIR/explorer/indexer/bin/zk-bridge-proof-archive.mjs
# The directories of the mirror: records (never pruned), then those that keep the window.
MIRROR_DIRS="storage-proofs light-client-proofs evidence handoff-updates fork-proofs conflicts beacon-states snapshots manifests"
# How many beacon states of each chain an import gives each service (the services' own cache keeps 16).
STATES_PER_CHAIN=16

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

# cli_exec <command> [options]: the archive CLI as zkb_indexer, plain. Its summary (one JSON object) goes to standard
# output, its log lines to standard error.
cli_exec() {
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
      -p "ReadWritePaths=$OUT_DIR -$MIRROR" \
      -- /usr/bin/node "$CLI_SCRIPT" "$@"
  fi
}

# cli <command> [options]: cli_exec with its log lines (standard error) caught in a file and written again by this
# script. Run through systemd-run, the CLI's own output is attributed by journald to the transient run-u unit, so the
# names it prints (a file that conflicts, a state the mirror lacks) would not show under zk-bridge-proofs-export. Written
# again here, they do. A file, not a pipe: the exit code stays the CLI's under `set -o pipefail`, and nothing waits on a
# reader. Standard output stays the caller's (it is a JSON summary that callers read).
cli() {
  local errfile rc=0
  errfile=$(mktemp "${TMPDIR:-/tmp}/zkb-proofs-cli.XXXXXX") || return 1
  cli_exec "$@" 2>"$errfile" || rc=$?
  cat "$errfile" >&2 || true
  rm -f "$errfile"
  return "$rc"
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
#
# A beacon state may be held in two forms (docs/proof-archive.md, "One beacon state, two forms"): the bytes as the node
# served them with a <name>.summary, or the bytes with that 64 byte entry appended. The same state in the other form is
# identical, not a conflict: an .ssz that differs from the one there by exactly the 64 bytes that the summary names (the
# shorter is the start of the longer). A .summary is not copied next to an .ssz that was already there: the entry would be
# counted twice, or be redundant.
COPY_TREE='
umask "$3"
src=$1 dest=$2
copied=0 identical=0 conflicts=0 new_ssz=
size_of() { wc -c <"$1" | tr -d " "; }
# two_forms <file> <file>: both are the same state, one in each form. Needs the summary next to the shorter one.
two_forms() {
  local a=$1 b=$2 long short sa sb want got
  sa=$(size_of "$a") sb=$(size_of "$b")
  if [ "$sa" -eq $((sb + 64)) ]; then long=$a short=$b; elif [ "$sb" -eq $((sa + 64)) ]; then long=$b short=$a; else return 1; fi
  [ -f "${short%.ssz}.summary" ] || return 1
  head -c "$(size_of "$short")" "$long" | cmp -s - "$short" || return 1
  want=$(tr -d "\n" <"${short%.ssz}.summary" | sed "s/0x//g")
  got=$(tail -c 64 "$long" | od -An -v -tx1 | tr -d " \n")
  [ "$want" = "$got" ]
}
while IFS= read -r -d "" f; do
  rel=${f#"$src"/}
  d=$dest/$rel
  if [ -e "$d" ] || [ -L "$d" ]; then
    if [ -f "$d" ] && [ ! -L "$d" ] && cmp -s "$f" "$d"; then
      identical=$((identical + 1))
    elif [ -f "$d" ] && [ ! -L "$d" ] && [[ $rel == *.ssz ]] && two_forms "$f" "$d"; then
      identical=$((identical + 1))
    else
      echo "conflict: $rel differs from the file already there"
      conflicts=$((conflicts + 1))
    fi
    continue
  fi
  # A .summary is only for an .ssz that is short; next to one the destination already held it would be counted twice, or
  # be redundant. It goes in only with an .ssz copied in this run.
  if [[ $rel == *.summary ]] && [ -f "${d%.summary}.ssz" ] && [[ $new_ssz != *"|${d%.summary}.ssz|"* ]]; then
    identical=$((identical + 1))
    continue
  fi
  mkdir -p "$(dirname "$d")"
  # A new file through a redirect takes 0666 minus the umask. cp would keep the source mode (0600 in a service state
  # directory), and the archive user could not read the copy.
  if cat "$f" > "$d.part.$$" && mv "$d.part.$$" "$d"; then :; else rm -f "$d.part.$$"; exit 1; fi
  copied=$((copied + 1))
  if [[ $rel == *.ssz ]]; then new_ssz="$new_ssz|$d|"; fi
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

# Two runs never overlap. A pull of the mirror (deploy/operator/pull-proofs.sh) holds a shared lock on the same file
# while it copies, so a run waits for it (up to an hour) instead of failing.
take_lock() {
  if command -v flock >/dev/null 2>&1; then
    exec 9>"$OUT_DIR/.lock"
    flock -w 3600 9 || die "another run (or a pull) has held the lock for an hour"
  else
    # No flock (macOS, tests): a directory is the lock.
    mkdir "$OUT_DIR/.lock.d" 2>/dev/null || die "another run holds the lock ($OUT_DIR/.lock.d)"
    TMP_DIRS+=("$OUT_DIR/.lock.d")
  fi
}

# offsite_upload <mirror> <manifest>: ships the mirror off the server. This is the place where a Cloudflare R2
# (S3-compatible) uploader plugs in later: drop an executable into /etc/zk-bridge/proofs/offsite.d/ (run in name order),
# or point ZKB_PROOFS_OFFSITE_HOOK at one. Each is called as `<hook> <mirror dir> <manifest of the day>` as root, with
# this script's environment; the manifest lists every file and its sha256, and files are never rewritten, so a hook
# uploads what the remote side lacks. The mirror is writable by zkb_indexer: a hook reads it as that user
# (runuser -u zkb_indexer -- ...), never as root, and checks the manifest's sha256 against manifests.sha256 next to it. With no hook it does nothing. Returns non-zero when a hook failed; the caller
# decides what that means.
offsite_upload() {
  local mirror=$1 manifest=$2 hook failed=0 ran=0
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
    if [ -x "$hook" ] && "$hook" "$mirror" "$manifest"; then
      log "off-site hook $(basename "$hook"): ok"
    else
      log "ERROR: off-site hook $(basename "$hook") failed"
      failed=1
    fi
  done <<EOF_HOOKS
$hooks
EOF_HOOKS
  [ "$ran" -gt 0 ] || log "no off-site hook: the mirror stays on this server (and on the machines that pull it)"
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
# The name test is bash, not a pipe into `grep -q` (under pipefail an early exit of grep can fail the writer).
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
    if [[ $name =~ ^[0-9]{12}-0x[0-9a-f]{64}\.(ssz|summary)$ ]]; then
      mkdir -p "$dest/$c"
      # install, not cp: cp keeps the 0600 of the service directory, and the archive user reads the copy.
      install -m 0644 "$f" "$dest/$c/$name"
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
  # Root never reads inside the mirror: the archive user builds the tree in <work>/build (records from the archive,
  # beacon states from the mirror, the manifest), streams it out as a tar, and root unpacks that into <work>/tree, which
  # only root can write. Links, special files and hard links there stop the run; the sanitizer and the IPFS add read
  # only that copy.
  local work=$OUT_DIR/.publish-$stamp tree build out
  tree=$work/tree
  build=$work/build
  rm -rf "$OUT_DIR"/.publish-*
  mkdir "$work" "$tree" "$build"
  chmod 0755 "$work" "$tree" "$build"
  own zkb_indexer:zkb_indexer "$build"

  must_cli public-export --out "$build"

  # The beacon states of the mirror: the whole window, which the nightly export has just pruned. Copied by the archive
  # user, plain files with the exact names only (COPY_BEACON skips links).
  out=$(as_user zkb_indexer bash -c "$COPY_BEACON" _ "$MIRROR/beacon-states" "$build/beacon-states") || die "copying the mirror's beacon states failed"
  log "beacon states in the tree: $out"

  # The public manifest leaves out the host name.
  local -a mlog=()
  if [ -f "$CID_LOG" ]; then mlog=(--ipfs-log "$CID_LOG"); fi
  must_cli manifest-write --dir "$build" --commit "$(release_commit)" --public ${mlog[@]+"${mlog[@]}"}
  snapshot_tree zkb_indexer "$build" "$tree"
  rm -rf "$build"
  normalize_tree "$tree"
  # The sanitizer runs on the copy that is added, so it checks the manifest too.
  must_cli public-check --dir "$tree"
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

  # Retention: the newest IPFS_KEEP distinct CIDs of the log stay pinned. Each holds the whole window, and the node
  # stores a block once, so two cost about one window plus a day. Only CIDs from the log are ever unpinned.
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
  # The node keeps unpinned blocks until a garbage collection (the daemon runs without --enable-gc), so the beacon
  # states that left the window would stay on disk. Only pinned content survives it: the release archives and the
  # publications kept above.
  if [ "$unpinned" -gt 0 ] && [ "${ZKB_PROOFS_IPFS_GC:-1}" = 1 ]; then
    if ipfs_rpc "/api/v0/repo/gc?quiet=true" >/dev/null; then log "ipfs repo gc: done"; else log "WARNING: ipfs repo gc failed"; fi
  fi
  # The list of pinned CIDs behind the TLS check of <cid>.ipfs.zkb.fi (ipfs-tls-ask): refreshed now, so the new tree
  # has its subdomain at once and an unpinned one loses it. The timer does the same every 2 minutes.
  # The unit, not the script: it runs as the node's user in its sandbox, so root writes nothing in that directory.
  ${ZKB_PINS_REFRESH:-systemctl start zk-bridge-ipfs-pins.service} || log "WARNING: the list of pinned CIDs could not be refreshed (the timer retries)"
  log "published $files files; $((total - unpinned)) publication(s) of the log pinned, $unpinned unpinned"
  printf 'cid: %s\n' "$cid"
  printf 'files: %s\n' "$files"
  printf 'gateway: %s/ipfs/%s\n' "$GATEWAY_HOST" "$cid"
  rm -rf "$work"
}

# --- the mirror -------------------------------------------------------------------------------------------------------
check_days() {
  case $RETENTION_DAYS in '' | *[!0-9]* | 0) die "ZKB_PROOFS_RETENTION_DAYS must be a positive number, not '$RETENTION_DAYS'" ;; esac
}

# The mirror's directories, all owned by the archive user (it writes and prunes there): the top 0750 (root and the
# archive user only), the directories in it 0755 and the files 0644. Root only creates and hands over the top directory
# (in its own 0711 parent, so nobody can swap it); everything inside is set by the archive user, on what it owns, never
# through a link. Root never chmods, chowns or reads a path inside the mirror.
NORMALIZE_MIRROR='
m=$1
shift
for d in "$@"; do
  if [ -L "$m/$d" ]; then echo "refusing: $d in the mirror is a link" >&2; exit 1; fi
  mkdir -p "$m/$d"
done
me=$(id -u)
find -P "$m" -mindepth 1 -type d -user "$me" ! -perm 0755 -exec chmod 0755 {} +
find -P "$m" -type f -user "$me" ! -perm 0644 -exec chmod 0644 {} +
echo "foreign=$(find -P "$m" -mindepth 1 ! -user "$me" | wc -l | tr -d " ") links=$(find -P "$m" -mindepth 1 -type l | wc -l | tr -d " ")"
'
prepare_mirror() {
  local out
  if [ -L "$MIRROR" ]; then die "$MIRROR is a symbolic link: refusing to use it"; fi
  if [ -e "$MIRROR" ] && [ ! -d "$MIRROR" ]; then die "$MIRROR is not a directory"; fi
  mkdir -p "$MIRROR"
  own zkb_indexer:zkb_indexer "$MIRROR"
  chmod 0750 "$MIRROR"
  # shellcheck disable=SC2086
  out=$(as_user zkb_indexer bash -c "$NORMALIZE_MIRROR" _ "$MIRROR" $MIRROR_DIRS) || die "preparing the mirror as zkb_indexer failed"
  case $out in
    "foreign=0 links=0") ;;
    *) log "WARNING: the mirror holds entries of another owner or links ($out); they are left alone and never read by root" ;;
  esac
}

# sha256_stdin: the sha256 of standard input.
sha256_stdin() {
  if command -v sha256sum >/dev/null 2>&1; then sha256sum | awk '{print $1}'; else shasum -a 256 | awk '{print $1}'; fi
}

# The trust list (manifests.sha256): lines "<sha256>  <path>", appended to only, by root, from bytes root itself holds:
#   <stamp>.json                      root's copy of a day's manifest (trusted-manifests/<stamp>.json)
#   snapshots/<stamp>.sqlite          the backend snapshot, hashed in root's staging copy before the mirror gets it
#   beacon-states/<chain>/<name>      a beacon state (or summary), hashed in root's staging copy of a service's states
# Records (proofs, evidence) need no line: storage proofs are verified against state roots, light client proofs are data.

# trust_line_ok <sha256> <path>: a line of the trust list has exactly this shape. The whole string must match (bash
# regex anchors do not match at a newline), so a name holding a newline cannot become two patterns of a grep -F.
trust_line_ok() {
  [[ $1 =~ ^[0-9a-f]{64}$ ]] || return 1
  [[ $2 =~ ^([0-9]{8}T[0-9]{6}Z\.json|snapshots/[0-9]{8}T[0-9]{6}Z\.sqlite|beacon-states/[0-9]+/[0-9]{12}-0x[0-9a-f]{64}\.(ssz|summary))$ ]]
}

# trust_add <sha256> <path>: one line, once.
trust_add() {
  [ ! -L "$TRUST" ] || die "$TRUST is a symbolic link: refusing to write it"
  trust_line_ok "$1" "$2" || die "refusing a trust line of another shape (path or hash)"
  if [ ! -f "$TRUST" ] || ! grep -qxF -- "$1  $2" "$TRUST"; then printf '%s  %s\n' "$1" "$2" >>"$TRUST"; fi
  own root:root "$TRUST"
  chmod 0644 "$TRUST"
}

# trust_tree <root-owned directory> <path prefix>: a line for every file in it.
trust_tree() {
  local f
  while IFS= read -r -d '' f; do
    trust_add "$(sha256_of "$f")" "$2/${f#"$1"/}"
  done < <(find -P "$1" -type f -print0)
}

# trusted <sha256> <path>: whether the trust list in force vouches for that file (--trust-list, else this server's).
TRUST_LIST=""
trusted() {
  local list=${TRUST_LIST:-$TRUST}
  trust_line_ok "$1" "$2" || return 1
  [ -f "$list" ] && [ ! -L "$list" ] && grep -qxF -- "$1  $2" "$list"
}

# keep_manifest <stamp> <mirror-manifest command...>: the CLI writes the day's manifest and prints the same bytes to
# root, which keeps them in trusted-manifests/ and records their hash; the mirror's copy must equal them.
keep_manifest() {
  local stamp=$1 copy
  shift
  [ ! -L "$TRUSTED_MANIFESTS" ] || die "$TRUSTED_MANIFESTS is a symbolic link: refusing it"
  mkdir -p "$TRUSTED_MANIFESTS"
  chmod 0755 "$TRUSTED_MANIFESTS"
  copy=$TRUSTED_MANIFESTS/$stamp.json
  cli "$@" --print >"$copy.part" || { rm -f "$copy.part"; die "mirror-manifest failed"; }
  mv "$copy.part" "$copy"
  own root:root "$copy"
  chmod 0644 "$copy"
  as_user zkb_indexer cat -- "$MIRROR/manifests/$stamp.json" | cmp -s - "$copy" || die "the mirror's manifest $stamp differs from what the CLI printed"
  trust_add "$(sha256_of "$copy")" "$stamp.json"
}

# prune_trusted: root's manifest copies follow the window too (root's own directory, so root may delete there).
prune_trusted() {
  local now cutoff f name
  now=$(date -u +%s)
  cutoff=$(date -u -d "@$((now - RETENTION_DAYS * 86400))" +%Y%m%dT%H%M%SZ 2>/dev/null || date -u -r "$((now - RETENTION_DAYS * 86400))" +%Y%m%dT%H%M%SZ)
  for f in "$TRUSTED_MANIFESTS"/*.json; do
    [ -f "$f" ] || continue
    name=$(basename "$f" .json)
    if [[ $name < $cutoff ]]; then rm -f "$f"; fi
  done
}

# manifest_names <directory> <reader>: every name in a manifests/ directory must follow the CLI's rule
# (YYYYMMDDTHHMMSSZ.json); prints the newest. Another name (a planted zzz.json) stops the run.
manifest_names() {
  local dir=$1 reader=$2 names name newest=""
  if [ "$reader" = root ]; then names=$(ls -A "$dir") || die "cannot list $dir"; else names=$(as_user "$reader" ls -A "$dir") || die "cannot list $dir"; fi
  while IFS= read -r name; do
    [ -n "$name" ] || continue
    [[ $name =~ ^[0-9]{8}T[0-9]{6}Z\.json$ ]] || die "manifests/ holds $name, which is not a manifest name: refusing the mirror"
    if [[ -z $newest || $name > $newest ]]; then newest=$name; fi
  done <<EOF_NAMES
$names
EOF_NAMES
  [ -n "$newest" ] || die "the mirror has no manifest"
  printf '%s' "$newest"
}

# manifest_vouched <name> <sha256> <reader> <path of the mirror's copy>: --manifest-sha256, or --trust-list, or this
# server's own copy (byte for byte) and its line.
manifest_vouched() {
  local name=$1 sha=$2 reader=$3 path=$4
  if [ -n "$MANIFEST_SHA" ]; then [ "$sha" = "$MANIFEST_SHA" ]; return; fi
  if [ -n "$TRUST_LIST" ]; then trusted "$sha" "$name"; return; fi
  [ -f "$TRUSTED_MANIFESTS/$name" ] || { log "root holds no copy of the manifest $name"; return 1; }
  if [ "$reader" = root ]; then
    cmp -s "$path" "$TRUSTED_MANIFESTS/$name" || { log "the manifest $name differs from root's copy"; return 1; }
  else
    as_user "$reader" cat -- "$path" | cmp -s - "$TRUSTED_MANIFESTS/$name" || { log "the manifest $name differs from root's copy"; return 1; }
  fi
  trusted "$sha" "$name"
}

# copy_beacon <user> <state directory> <destination>: the beacon states of one service, copied by their owner.
copy_beacon() {
  local user=$1 src=$2 dest=$3 out
  if as_user "$user" test -d "$src"; then
    out=$(as_user "$user" bash -c "$COPY_BEACON" _ "$src" "$dest") || die "reading the beacon states of $user failed"
    log "$user beacon states: $out"
  else
    log "no $src: skipped"
  fi
}

# mirror_step <command> [options]: one mirror command of the CLI. Exit 3 (a name that exists with other content; the
# file was left alone) is counted in MIRROR_CONFLICTS and the run goes on; any other failure stops it.
MIRROR_CONFLICTS=0
mirror_step() {
  run_cli "$@"
  case $CLI_RC in
    0) ;;
    3)
      MIRROR_CONFLICTS=$((MIRROR_CONFLICTS + 1))
      log "ERROR: $1 found a file that exists with other content (named above); it was not overwritten"
      ;;
    *) die "$1 failed (exit $CLI_RC)" ;;
  esac
}

# --- export -------------------------------------------------------------------------------------------------------
cmd_export() {
  local stamp=${ZKB_PROOFS_STAMP:-$(date -u +%Y%m%dT%H%M%SZ)}
  local stage=$OUT_DIR/.staging-$stamp
  local warnings=0 snapshot=0 cache=0 out missing
  check_days
  case $stamp in [0-9][0-9][0-9][0-9][0-9][0-9][0-9][0-9]T[0-9][0-9][0-9][0-9][0-9][0-9]Z) ;; *) die "the stamp must look like 20261102T033000Z, not '$stamp'" ;; esac
  prepare_mirror
  if as_user zkb_indexer test -e "$MIRROR/manifests/$stamp.json"; then die "the manifest $stamp exists already"; fi

  rm -rf "$OUT_DIR"/.staging-* "$OUT_DIR"/.extract-*
  mkdir "$stage"
  TMP_DIRS+=("$stage")
  chmod 0755 "$stage"
  mkdir "$stage/snapshots" "$stage/proof-cache" "$stage/beacon-runner" "$stage/beacon-backend" "$stage/root"
  chmod 0755 "$stage/snapshots" "$stage/proof-cache" "$stage/beacon-runner" "$stage/beacon-backend" "$stage/root"
  # <stage>/root: copies only root can write, of what the services gave. Root hashes these into the trust list, and the
  # mirror and the archive take them from here.
  mkdir "$stage/root/snapshots" "$stage/root/beacon-runner" "$stage/root/beacon-backend"
  chmod 0755 "$stage/root/snapshots"
  own zkb_backend:zkb_backend "$stage/snapshots" "$stage/beacon-backend"
  own zkb_runner:zkb_runner "$stage/proof-cache" "$stage/beacon-runner"

  # The SQLite file: a consistent snapshot (the online backup API), taken by the backend's user.
  # Even the tests for what a service holds run as that service's user: root does nothing inside a state directory.
  if as_user zkb_backend test -f "$BACKEND_STATE/backend.sqlite"; then
    log "snapshot of backend.sqlite"
    # The copy keeps the WAL mode of the source, and a read-only open of a WAL file must write its -shm next to it, which
    # the archive user cannot. A rollback-journal copy opens read only with no writes.
    as_user zkb_backend sh -c 'umask 022; sqlite3 -cmd ".timeout 5000" "$1" ".backup \"$2\"" && exec sqlite3 "$2" "PRAGMA journal_mode=DELETE;" >/dev/null' _ \
      "$BACKEND_STATE/backend.sqlite" "$stage/snapshots/$stamp.sqlite" || die "the SQLite snapshot failed"
    # The backend's user hands the bytes to root, which writes them where only root can, and hashes them there.
    as_user zkb_backend cat -- "$stage/snapshots/$stamp.sqlite" >"$stage/root/snapshots/$stamp.sqlite" || die "reading the SQLite snapshot failed"
    chmod 0644 "$stage/root/snapshots/$stamp.sqlite"
    trust_add "$(sha256_of "$stage/root/snapshots/$stamp.sqlite")" "snapshots/$stamp.sqlite"
    snapshot=1
  else
    log "no $BACKEND_STATE/backend.sqlite: no snapshot tonight"
  fi

  # The files the services hold, as plain files the archive user can read.
  if as_user zkb_runner test -d "$RUNNER_STATE/proof-cache"; then
    log "copying the runner's proof cache"
    copy_tree zkb_runner "$RUNNER_STATE/proof-cache" "$stage/proof-cache" 022
    cache=1
  else
    log "no $RUNNER_STATE/proof-cache: skipped"
  fi
  copy_beacon zkb_runner "$RUNNER_STATE/beacon-states" "$stage/beacon-runner"
  copy_beacon zkb_backend "$BACKEND_STATE/beacon-states" "$stage/beacon-backend"
  # Each service's states, streamed by its user into root's copy (no links, plain modes), hashed there.
  snapshot_tree zkb_runner "$stage/beacon-runner" "$stage/root/beacon-runner"
  snapshot_tree zkb_backend "$stage/beacon-backend" "$stage/root/beacon-backend"
  trust_tree "$stage/root/beacon-runner" beacon-states
  trust_tree "$stage/root/beacon-backend" beacon-states

  # Everything the server holds goes into the archive first; the record files come from the archive.
  must_cli migrate
  if [ "$cache" -eq 1 ]; then
    run_cli ingest-cache --dir "$stage/proof-cache"
    case $CLI_RC in 0) ;; 3) warnings=$((warnings + 1)); log "WARNING: ingest-cache found conflicts (recorded in the archive)" ;; *) die "ingest-cache failed (exit $CLI_RC)" ;; esac
  fi
  if [ "$snapshot" -eq 1 ]; then
    run_cli ingest-backend --sqlite "$stage/root/snapshots/$stamp.sqlite"
    case $CLI_RC in 0) ;; 3) warnings=$((warnings + 1)); log "WARNING: ingest-backend found conflicts (recorded in the archive)" ;; *) die "ingest-backend failed (exit $CLI_RC)" ;; esac
  fi

  # The mirror: records, beacon states, the snapshot; then the window; then the manifest of the day.
  mirror_step mirror-write --dir "$MIRROR"
  mirror_step mirror-add --dir "$MIRROR" --from "$stage/root/beacon-runner" --to beacon-states
  mirror_step mirror-add --dir "$MIRROR" --from "$stage/root/beacon-backend" --to beacon-states
  if [ "$snapshot" -eq 1 ]; then mirror_step mirror-add --dir "$MIRROR" --from "$stage/root/snapshots" --to snapshots; fi
  out=$(cli mirror-prune --dir "$MIRROR" --days "$RETENTION_DAYS" --held "$stage/root/beacon-runner,$stage/root/beacon-backend") || die "mirror-prune failed"
  printf '%s\n' "$out"
  missing=$(printf '%s\n' "$out" | sed -n 's/.*"heldMissing":\([0-9][0-9]*\).*/\1/p' | tail -n 1)
  if [ "${missing:-0}" -gt 0 ]; then
    warnings=$((warnings + 1))
    log "WARNING: $missing beacon state(s) that the services hold are not in the mirror (named above)"
  fi
  local -a mlog=()
  if [ -f "$CID_LOG" ]; then mlog=(--ipfs-log "$CID_LOG"); fi
  keep_manifest "$stamp" mirror-manifest --dir "$MIRROR" --stamp "$stamp" --commit "$(release_commit)" --days "$RETENTION_DAYS" ${mlog[@]+"${mlog[@]}"}
  prune_trusted
  rm -rf "$stage"
  local manifest=$MIRROR/manifests/$stamp.json

  # The nightly bundles of the old format are left as they are; the mirror replaces them.
  local old=0 f
  for f in "$OUT_DIR"/zk-bridge-proofs-*.tar.gz; do [ -e "$f" ] && old=$((old + 1)); done
  [ "$old" -eq 0 ] || log "$old nightly bundle(s) of the old format are still in $OUT_DIR; nothing makes new ones (delete them once the mirror is pulled)"

  # Off-site copy, after the mirror is complete: a failing hook fails the run, not the mirror.
  local offsite=0
  offsite_upload "$MIRROR" "$manifest" || offsite=1

  # The public tree, only when switched on (ZKB_PROOFS_PUBLISH=1 in /etc/zk-bridge/proofs/proofs.env). A failure here
  # fails the run after everything above is done. A subshell, so that its die does not skip the lines below.
  local published=0
  if [ "${ZKB_PROOFS_PUBLISH:-0}" = 1 ]; then
    ( cmd_publish ) || published=1
  fi

  log "done: $warnings warning(s), $MIRROR_CONFLICTS step(s) that met a file with other content"
  printf 'mirror: %s\n' "$MIRROR"
  printf 'manifest: %s\n' "$manifest"
  [ "$MIRROR_CONFLICTS" -eq 0 ] || die "the mirror holds a file whose name came again with other content (ERROR lines above); nothing was overwritten"
  [ "$offsite" -eq 0 ] || die "the off-site upload failed; the mirror is complete on this server"
  [ "$published" -eq 0 ] || die "the publication failed; the mirror is complete on this server"
}

# --- shared by import and verify ------------------------------------------------------------------------------------
# extract_bundle <bundle>: checks the .sha256, unpacks into a fresh directory (EXTRACTED). A nightly bundle of the old
# format (manifest.json) is checked against its manifest here; a mirror bundle is checked by its caller.
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
  # Unreachable (0700) until the checks below pass, and unpacked without the archive's modes: a bundle could carry a
  # setuid file, and root would own it.
  chmod 0700 "$EXTRACTED"
  untar "$EXTRACTED" -z <"$bundle" || die "cannot unpack $bundle"
  # Only plain files and directories, none shared by a hard link: nothing a service user copies can point elsewhere.
  if [ -n "$(find "$EXTRACTED" ! -type f ! -type d -print -quit)" ] || [ -n "$(find "$EXTRACTED" -type f -links +1 -print -quit)" ]; then
    die "$bundle holds links or special files"
  fi
  plain_modes "$EXTRACTED"
  if [ -f "$EXTRACTED/manifest.json" ]; then
    run_cli manifest-check --dir "$EXTRACTED"
    [ "$CLI_RC" -eq 0 ] || die "$bundle fails its manifest (exit $CLI_RC)"
  elif [ ! -d "$EXTRACTED/manifests" ]; then
    die "$bundle is neither a mirror bundle nor a nightly bundle"
  fi
}

# check_plain <directory> <what>: only plain files and directories, none shared by a hard link, in a copy only root can
# write; then the usual modes.
check_plain() {
  if [ -n "$(find -P "$1" ! -type f ! -type d -print -quit)" ] || [ -n "$(find -P "$1" -type f -links +1 -print -quit)" ]; then
    die "$2 holds links or special files: refusing it"
  fi
  plain_modes "$1"
}

# plain_modes <directory>: setuid, setgid and sticky bits cleared first (a numeric chmod keeps setgid on a directory),
# then 0755 directories and 0644 files.
plain_modes() {
  # -perm -4000 -o ... rather than GNU find's -perm /7000, which BSD find (macOS, the tests) does not read.
  find -P "$1" \( -type f -o -type d \) \( -perm -4000 -o -perm -2000 -o -perm -1000 \) -exec chmod u-s,g-s,o-t {} +
  find -P "$1" -type d -exec chmod 0755 {} +
  find -P "$1" -type f -exec chmod 0644 {} +
}

# untar <destination> [-z]: root unpacks standard input into a destination it keeps at 0700, never applying the
# archive's owners or modes (a tar from a service user could carry a setuid file).
untar() {
  local dest=$1
  shift
  chmod 0700 "$dest"
  ( umask 077; exec tar --no-same-owner --no-same-permissions "$@" -xf - -C "$dest" )
}

# snapshot_tree <reader> <source> <destination>: copies a directory into a root-owned one. The reader (the archive user
# for its own trees, root for a directory only root can write) streams a tar; root unpacks it. A source that holds a
# link, a special file or a hard link is refused, and so is a copy that does.
snapshot_tree() {
  local reader=$1 src=$2 dest=$3 found
  local probe='find -P "$1" -mindepth 1 \( ! -type f ! -type d \) -print -quit; find -P "$1" -type f -links +1 -print -quit'
  if [ "$reader" = root ]; then found=$(sh -c "$probe" _ "$src"); else found=$(as_user "$reader" sh -c "$probe" _ "$src"); fi
  [ -z "$found" ] || die "$src holds links or special files: refusing it"
  if [ "$reader" = root ]; then
    tar -cf - -C "$src" . | untar "$dest" || die "copying $src failed"
  else
    as_user "$reader" tar -cf - -C "$src" . | untar "$dest" || die "copying $src as $reader failed"
  fi
  check_plain "$dest" "$src"
}

# parse_input_args [<mirror dir> | <bundle.tar.gz>] [--manifest-sha256 <hex>] [--snapshot-sha256 <hex>]
#   [--trust-list <file>]: sets INPUT_ARG, MANIFEST_SHA, SNAPSHOT_SHA and TRUST_LIST.
MANIFEST_SHA=""
SNAPSHOT_SHA=""
parse_input_args() {
  INPUT_ARG=""
  while [ $# -gt 0 ]; do
    case $1 in
      --manifest-sha256) [ $# -ge 2 ] || usage; MANIFEST_SHA=$2; shift ;;
      --snapshot-sha256) [ $# -ge 2 ] || usage; SNAPSHOT_SHA=$2; shift ;;
      --trust-list)
        [ $# -ge 2 ] || usage
        TRUST_LIST=$2
        shift
        { [ -f "$TRUST_LIST" ] && [ ! -L "$TRUST_LIST" ]; } || die "--trust-list must name a plain file"
        ;;
      --*) usage ;;
      *) [ -z "$INPUT_ARG" ] || usage; INPUT_ARG=$1 ;;
    esac
    shift
  done
  case $MANIFEST_SHA in "" | [0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f]*) ;; *) die "--manifest-sha256 must be 64 hex digits" ;; esac
  if [ -n "$MANIFEST_SHA" ] && [ ${#MANIFEST_SHA} -ne 64 ]; then die "--manifest-sha256 must be 64 hex digits"; fi
  if [ -n "$SNAPSHOT_SHA" ] && ! [[ $SNAPSHOT_SHA =~ ^[0-9a-f]{64}$ ]]; then die "--snapshot-sha256 must be 64 hex digits"; fi
}

# resolve_input [<mirror dir> | <bundle.tar.gz>]: copies the input into a root-owned directory (INPUT) and sets
# INPUT_KIND (mirror or legacy). Default: this server's mirror, read by the archive user that owns it.
resolve_input() {
  local arg=${1:-$MIRROR}
  if [ -d "$arg" ] || [ "$arg" = "$MIRROR" ]; then
    INPUT=$(mktemp -d "$OUT_DIR/.extract-XXXXXX")
    TMP_DIRS+=("$INPUT")
    chmod 0755 "$INPUT"
    if [ "$arg" = "$MIRROR" ]; then
      prepare_mirror
      snapshot_tree zkb_indexer "$MIRROR" "$INPUT"
    else
      [ ! -L "$arg" ] || die "$arg is a symbolic link: refusing it"
      snapshot_tree root "$arg" "$INPUT"
    fi
    INPUT_KIND=mirror
    return
  fi
  [ -f "$arg" ] || die "no mirror or bundle at $arg"
  extract_bundle "$arg"
  INPUT=$EXTRACTED
  if [ -f "$INPUT/manifest.json" ]; then INPUT_KIND=legacy; else INPUT_KIND=mirror; fi
}

# newest <directory> <glob suffix>: the last file name of the directory in name order (the stamps sort by time).
newest() {
  local f last=""
  for f in "$1"/*"$2"; do [ -f "$f" ] && last=$(basename "$f"); done
  printf '%s' "$last"
}

# trusted_mirror <root-owned copy>: every name in its manifests/ follows the manifest rule, the newest is vouched for
# (root's own copy and its line, or --trust-list, or --manifest-sha256), and the copy matches that manifest exactly
# (the CLI is told which one by name). Sets MANIFEST.
trusted_mirror() {
  local dir=$1 sha
  MANIFEST=$(manifest_names "$dir/manifests" root)
  sha=$(sha256_of "$dir/manifests/$MANIFEST")
  if manifest_vouched "$MANIFEST" "$sha" root "$dir/manifests/$MANIFEST"; then
    log "manifest $MANIFEST: sha256 $sha is trusted"
  else
    die "manifest $MANIFEST (sha256 $sha) is not vouched for by $TRUST and root's copy: refusing it (for a mirror from another server, pass --trust-list <that server's manifests.sha256> or --manifest-sha256 <hex>)"
  fi
  run_cli mirror-check --dir "$dir" --exact --manifest "$MANIFEST"
  [ "$CLI_RC" -eq 0 ] || die "the mirror does not match its newest manifest $MANIFEST exactly (exit $CLI_RC)"
}

# --- import -------------------------------------------------------------------------------------------------------
cmd_import() {
  parse_input_args "$@"
  resolve_input "$INPUT_ARG"
  if [ "$INPUT_KIND" = legacy ]; then import_legacy "$INPUT"; else import_mirror "$INPUT"; fi
}

# finish_import <conflicts>
finish_import() {
  log "done: $1 conflict(s)"
  printf 'conflicts: %s\n' "$1"
  if [ "$1" -gt 0 ]; then
    log "files and archive entries that differ were NOT overwritten; see the lines above"
    exit 3
  fi
}

# install_snapshot <sqlite file>: its proofs go into the archive; it becomes the backend's database only when the
# server has none. Adds to IMPORT_CONFLICTS.
install_snapshot() {
  local state
  run_cli ingest-backend --sqlite "$1"
  case $CLI_RC in 0) ;; 3) IMPORT_CONFLICTS=$((IMPORT_CONFLICTS + 1)); log "ingest-backend recorded conflicts" ;; *) die "ingest-backend failed (exit $CLI_RC)" ;; esac
  state=$(as_user zkb_backend bash -c "$INSTALL_IF_MISSING" _ "$1" "$BACKEND_STATE/backend.sqlite") || die "installing backend.sqlite failed"
  if [ "$state" = installed ]; then
    log "backend.sqlite: this server had none, the snapshot is installed"
  else
    log "backend.sqlite: left as it is; its proofs went into the archive instead"
  fi
}

IMPORT_CONFLICTS=0
import_mirror() {
  local dir=$1 snapshot="" stage entry user dest sha f
  # Everything below reads the root-owned copy, and only what its trusted manifest lists.
  trusted_mirror "$dir"
  # Before anything is imported: the snapshot to install must be one whose hash root recorded (or the operator gave).
  for f in "$dir"/snapshots/*; do
    [ -e "$f" ] || continue
    [[ $(basename "$f") =~ ^[0-9]{8}T[0-9]{6}Z\.sqlite$ ]] || die "snapshots/ holds $(basename "$f"), which is not a snapshot name: refusing the mirror"
    snapshot=$(basename "$f")
  done
  if [ -n "$snapshot" ]; then
    sha=$(sha256_of "$dir/snapshots/$snapshot")
    if [ -n "$SNAPSHOT_SHA" ]; then
      [ "$sha" = "$SNAPSHOT_SHA" ] || die "snapshot $snapshot (sha256 $sha) does not match --snapshot-sha256: refusing it"
    else
      trusted "$sha" "snapshots/$snapshot" || die "snapshot $snapshot (sha256 $sha) is not in the trust list: refusing it (for a mirror from another server, pass --trust-list or --snapshot-sha256)"
    fi
  fi
  stage=$(mktemp -d "$OUT_DIR/.extract-XXXXXX")
  TMP_DIRS+=("$stage")
  chmod 0755 "$stage"
  trusted_states "$dir" "$stage/states"
  must_cli migrate
  run_cli mirror-import --dir "$dir"
  case $CLI_RC in 0) ;; 3) IMPORT_CONFLICTS=$((IMPORT_CONFLICTS + 1)); log "the archive recorded conflicts" ;; *) die "mirror-import failed (exit $CLI_RC)" ;; esac

  if [ -n "$snapshot" ]; then
    log "newest snapshot: $snapshot (sha256 vouched for)"
    install_snapshot "$dir/snapshots/$snapshot"
  else
    log "the mirror has no snapshot"
  fi

  # The beacon states: the newest of each chain whose hash root recorded, copied into a directory only root can write,
  # then taken by each service's user.
  if [ -n "$(find -P "$stage/states" -type f -print -quit)" ]; then
    for entry in "zkb_runner $RUNNER_STATE/beacon-states" "zkb_backend $BACKEND_STATE/beacon-states"; do
      read -r user dest <<<"$entry"
      log "beacon states -> $dest"
      copy_tree "$user" "$stage/states" "$dest" 077
      IMPORT_CONFLICTS=$((IMPORT_CONFLICTS + TREE_CONFLICTS))
    done
  fi
  finish_import "$IMPORT_CONFLICTS"
}

# trusted_states <mirror copy> <out>: copies the newest STATES_PER_CHAIN beacon states of each chain (with their
# summaries) whose sha256 the trust list holds; the others are named in a WARNING and left out.
trusted_states() {
  local dir=$1 out=$2 chain c name n skipped=0 f rel ok names
  mkdir -p "$out"
  for chain in "$dir"/beacon-states/*/; do
    [ -d "$chain" ] || continue
    c=$(basename "$chain")
    n=0
    names=$(ls -1 "$chain" | LC_ALL=C sort -r)
    while IFS= read -r name; do
      [[ $name =~ ^[0-9]{12}-0x[0-9a-f]{64}\.ssz$ ]] || continue
      [ "$n" -lt "$STATES_PER_CHAIN" ] || break
      ok=1
      for f in "$chain$name" "$chain${name%.ssz}.summary"; do
        [ -f "$f" ] || continue
        rel=beacon-states/$c/$(basename "$f")
        trusted "$(sha256_of "$f")" "$rel" || ok=0
      done
      if [ "$ok" -eq 0 ]; then
        log "WARNING: beacon-states/$c/$name has no hash in the trust list: not given to the services"
        skipped=$((skipped + 1))
        continue
      fi
      mkdir -p "$out/$c"
      for f in "$chain$name" "$chain${name%.ssz}.summary"; do
        if [ -f "$f" ]; then install -m 0644 "$f" "$out/$c/"; fi
      done
      n=$((n + 1))
    done <<EOF_STATES
$names
EOF_STATES
  done
  find -P "$out" -type d -exec chmod 0755 {} +
  [ "$skipped" -eq 0 ] || log "$skipped beacon state(s) left out: root never recorded their hashes"
}

# A nightly bundle of the old format (archive/*.ndjson, backend/backend.sqlite, files/...), unpacked into $1.
import_legacy() {
  local dir=$1 tree user rel dest
  must_cli migrate
  if [ -d "$dir/archive" ]; then
    run_cli import --in "$dir"
    case $CLI_RC in 0) ;; 3) IMPORT_CONFLICTS=$((IMPORT_CONFLICTS + 1)); log "the archive recorded conflicts" ;; *) die "import failed (exit $CLI_RC)" ;; esac
  else
    log "the bundle has no archive directory"
  fi
  if [ -f "$dir/backend/backend.sqlite" ]; then install_snapshot "$dir/backend/backend.sqlite"; fi

  # Each entry: user, path in the bundle, destination.
  for tree in "zkb_runner files/runner/proof-cache $RUNNER_STATE/proof-cache" \
    "zkb_runner files/runner/beacon-states $RUNNER_STATE/beacon-states" \
    "zkb_backend files/backend/beacon-states $BACKEND_STATE/beacon-states"; do
    read -r user rel dest <<<"$tree"
    if [ -d "$dir/$rel" ]; then
      log "files: $rel -> $dest"
      copy_tree "$user" "$dir/$rel" "$dest" 077
      IMPORT_CONFLICTS=$((IMPORT_CONFLICTS + TREE_CONFLICTS))
    else
      log "files: $rel is not in the bundle"
    fi
  done
  finish_import "$IMPORT_CONFLICTS"
}

# --- verify -------------------------------------------------------------------------------------------------------
cmd_verify() {
  parse_input_args "$@"
  local dir sha
  if [ -z "$INPUT_ARG" ] || [ "$INPUT_ARG" = "$MIRROR" ]; then
    # This server's mirror, in place (no copy of several GB): the archive user reads it, root only its trust list.
    prepare_mirror
    dir=$MIRROR
    MANIFEST=$(manifest_names "$MIRROR/manifests" zkb_indexer)
    sha=$(as_user zkb_indexer cat -- "$MIRROR/manifests/$MANIFEST" | sha256_stdin)
    manifest_vouched "$MANIFEST" "$sha" zkb_indexer "$MIRROR/manifests/$MANIFEST" || die "manifest $MANIFEST (sha256 $sha) is not root's copy or not in $TRUST: it was changed after the export"
    run_cli mirror-check --dir "$dir" --exact --manifest "$MANIFEST"
    [ "$CLI_RC" -eq 0 ] || die "the mirror does not match $MANIFEST (exit $CLI_RC)"
  else
    resolve_input "$INPUT_ARG"
    dir=$INPUT
    if [ "$INPUT_KIND" = legacy ]; then
      run_cli verify-storage --in "$dir"
      if [ "$CLI_RC" -ne 0 ]; then log "verify-storage exit $CLI_RC: at least one proof did not verify"; exit "$CLI_RC"; fi
      log "all storage proofs verify"
      return
    fi
    trusted_mirror "$dir"
  fi
  case $MANIFEST in
    "$(date -u +%Y%m%d)"T*) log "newest manifest: $MANIFEST (today)" ;;
    *) log "WARNING: the newest manifest is $MANIFEST, not today's: did tonight's export run?" ;;
  esac
  log "the mirror matches $MANIFEST"
  run_cli verify-storage --mirror "$dir"
  if [ "$CLI_RC" -ne 0 ]; then
    log "verify-storage exit $CLI_RC: at least one proof did not verify"
    exit "$CLI_RC"
  fi
  log "all storage proofs verify"
}

# --- bundle -------------------------------------------------------------------------------------------------------
# One tar.gz of the whole mirror, for a one-off copy (another machine, a disk). Nothing makes or keeps these nightly.
cmd_bundle() {
  local stamp=${ZKB_PROOFS_STAMP:-$(date -u +%Y%m%dT%H%M%SZ)}
  local bundle=$OUT_DIR/zk-bridge-mirror-$stamp.tar.gz
  [ -f "$TRUST" ] || die "no export has run yet: run proofs.sh export first"
  [ ! -e "$bundle" ] || die "$bundle exists already"
  prepare_mirror
  umask 027
  # The archive user reads its tree and streams it; root only writes the bundle, outside the mirror.
  as_user zkb_indexer tar -czf - -C "$MIRROR" . >"$bundle.part" || die "packing the mirror failed"
  mv "$bundle.part" "$bundle"
  own root:root "$bundle"
  chmod 0640 "$bundle"
  printf '%s  %s\n' "$(sha256_of "$bundle")" "$(basename "$bundle")" >"$bundle.sha256"
  own root:root "$bundle.sha256"
  chmod 0640 "$bundle.sha256"
  log "bundled the mirror; copy it, then delete it. Another server imports it with --trust-list <a copy of $TRUST>"
  printf 'bundle: %s\n' "$bundle"
}

usage() {
  log "usage: proofs.sh export | import [<mirror dir> | <bundle.tar.gz>] [--trust-list <file> | --manifest-sha256 <hex> [--snapshot-sha256 <hex>]] | verify [<mirror dir> | <bundle.tar.gz>] [--trust-list <file> | --manifest-sha256 <hex>] | publish [--dry-run] | bundle"
  exit 2
}

# Everything runs inside main: when the script comes in on standard input (bash -s), bash has read all of it before
# the first command runs, so no command can swallow the rest of the script.
main() {
  exec </dev/null
  umask 022
  local cmd=${1:-}
  case $cmd in export | import | verify | publish | bundle) ;; *) usage ;; esac
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
    bundle) cmd_bundle ;;
  esac
}

main "$@"
