#!/usr/bin/env bash
# Tests of the operator-side pull (pull-proofs.sh) and its launchd installer, with a fake ssh and rsync and temporary
# directories. It touches no real ~/Library, ssh or server.
#
#   deploy/operator/test.sh
set -euo pipefail

DIR=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
FAILURES=0
pass() { printf 'PASS  %s\n' "$1"; }
fail() { printf 'FAIL  %s\n' "$1"; FAILURES=$((FAILURES + 1)); }
check() { if "${@:2}"; then pass "$1"; else fail "$1"; fi; }

for script in pull-proofs.sh install-proofs-pull.sh test.sh; do
  check "bash -n operator/$script" bash -n "$DIR/$script"
done
if command -v shellcheck >/dev/null 2>&1; then
  for script in pull-proofs.sh install-proofs-pull.sh test.sh; do
    check "shellcheck operator/$script" shellcheck -S warning "$DIR/$script"
  done
else
  printf 'SKIP  shellcheck is not installed (brew install shellcheck)\n'
fi
if grep -hv '^[[:space:]]*#' "$DIR/pull-proofs.sh" "$DIR/install-proofs-pull.sh" | grep -q 'zkb\.fi'; then fail "operator scripts name zkb.fi"; else pass "operator scripts name no host of zkb.fi"; fi

T=$(mktemp -d)
trap 'rm -rf "$T"' EXIT

sha() { if command -v shasum >/dev/null 2>&1; then shasum -a 256 "$1" | awk '{print $1}'; else sha256sum "$1" | awk '{print $1}'; fi; }

# --- The rendered plist ----------------------------------------------------------------------------------------------
agents=$T/agents
env ZKB_PULL_AT=05:10 ZKB_PULL_AGENT_DIR=$agents ZKB_PULL_INSTALL_DIR=$T/inst ZKB_PULL_LOCAL_DIR=$T/pulled ZKB_PULL_NO_LOAD=1 \
  bash "$DIR/install-proofs-pull.sh" 2>/dev/null
plist=$agents/fi.zkb.proofs-pull.plist
check "installer writes the plist and the script" test -f "$plist" -a -x "$T/inst/pull-proofs.sh"
if grep -q '@[A-Z_]*@' "$plist"; then fail "plist has an unfilled value"; else pass "plist has no unfilled value"; fi
if grep -A1 '<key>Hour</key>' "$plist" | grep -q '<integer>5</integer>' && grep -A1 '<key>Minute</key>' "$plist" | grep -q '<integer>10</integer>'; then pass "plist runs at 05:10"; else fail "plist run time"; fi
if grep -A1 '<key>RunAtLoad</key>' "$plist" | grep -q '<false/>'; then pass "plist: RunAtLoad false"; else fail "plist: RunAtLoad"; fi
if command -v plutil >/dev/null 2>&1; then
  check "plutil -lint on the rendered plist" plutil -lint "$plist"
else
  printf 'SKIP  plutil is not installed\n'
fi
env ZKB_PULL_AGENT_DIR=$agents ZKB_PULL_INSTALL_DIR=$T/inst ZKB_PULL_NO_LOAD=1 bash "$DIR/install-proofs-pull.sh" --uninstall 2>/dev/null
check "uninstall removes the plist and the script" test ! -e "$plist" -a ! -e "$T/inst"

# --- The pull ---------------------------------------------------------------------------------------------------------
if ! command -v node >/dev/null 2>&1 && ! command -v python3 >/dev/null 2>&1; then
  printf 'SKIP  pull tests: neither node nor python3 to read the manifest\n'
  printf '%d failure(s)\n' "$FAILURES"
  [ "$FAILURES" -eq 0 ]
  exit
fi

# The server's mirror, in a fake root: the fake rsync maps "host:/path" to "$FAKE_ROOT/path", drops the ssh and
# rsync-path options (after logging them), and hands the rest to the real rsync of this machine.
REAL_RSYNC=$(command -v rsync || true)
if [ -z "$REAL_RSYNC" ]; then
  printf 'SKIP  pull tests: no rsync\n'
  printf '%d failure(s)\n' "$FAILURES"
  [ "$FAILURES" -eq 0 ]
  exit
fi
root=$T/server
remote=$root/var/backups/zk-bridge/proofs/mirror
cat >"$T/rsync" <<'EOS'
#!/bin/bash
printf '%s\n' "$*" >>"$FAKE_LOG"
args=()
while [ $# -gt 0 ]; do
  case $1 in
    -e) shift ;;
    --rsync-path=*) ;;
    *:/*) src=${1#*:}; dir=${src%/}; dir=${dir##*/}
      # FAKE_SKIP_ONCE=<dir>: the first pull of that directory brings nothing (as if an export ran meanwhile).
      if [ -n "${FAKE_SKIP_ONCE:-}" ] && [ "$dir" = "$FAKE_SKIP_ONCE" ] && [ ! -e "$FAKE_LOG.skipped" ]; then : >"$FAKE_LOG.skipped"; exit 0; fi
      args+=("$FAKE_ROOT$src") ;;
    *) args+=("$1") ;;
  esac
  shift
done
exec "$REAL_RSYNC" "${args[@]}"
EOS
chmod +x "$T/rsync"

sha_list() { (cd "$remote" && find . -type f ! -path './manifests/*' | sed 's|^\./||' | LC_ALL=C sort); }
# write_manifest <stamp>: the server's manifest of the day, over every file but the manifests.
write_manifest() {
  local first=1 f
  mkdir -p "$remote/manifests"
  {
    printf '{"formatVersion":2,"kind":"mirror","files":{'
    while IFS= read -r f; do
      [ -n "$f" ] || continue
      [ "$first" -eq 1 ] || printf ','
      first=0
      printf '"%s":{"sha256":"%s","bytes":1}' "$f" "$(sha "$remote/$f")"
    done < <(sha_list)
    printf '}}\n'
  } >"$remote/manifests/$1.json"
  # The server's root records each manifest's hash outside the mirror.
  printf '%s  %s.json\n' "$(sha "$remote/manifests/$1.json")" "$1" >>"$root/var/backups/zk-bridge/proofs/manifests.sha256"
  # ... and keeps its own copy of the manifest.
  mkdir -p "$root/var/backups/zk-bridge/proofs/trusted-manifests"
  cp "$remote/manifests/$1.json" "$root/var/backups/zk-bridge/proofs/trusted-manifests/$1.json"
}
put() { mkdir -p "$(dirname "$remote/$1")"; printf '%s\n' "$2" >"$remote/$1"; }
record() { # record <dir/stem> <content>: a record file named by its content
  local tmp=$T/record.tmp
  printf '%s\n' "$2" >"$tmp"
  mkdir -p "$(dirname "$remote/$1")"
  mv "$tmp" "$remote/$1.$(sha "$tmp").json"
}
# Every directory the pull asks for, read from the script itself, so the fake server cannot drift from it (it once
# lacked handoff-updates, and every pull failed). The real server creates them all on each export (MIRROR_DIRS in
# deploy/app-server/proofs.sh).
mirror_dirs=$(sed -nE 's/^(RECORD|PRUNED)_DIRS="(.*)"$/\2/p' "$DIR/pull-proofs.sh" | tr '\n' ' ')
missing_dirs=""
for d in storage-proofs light-client-proofs evidence handoff-updates fork-proofs conflicts beacon-states snapshots manifests; do
  case " $mirror_dirs " in *" $d "*) ;; *) missing_dirs="$missing_dirs $d" ;; esac
done
if [ -z "$missing_dirs" ]; then pass "the pull asks for every directory of the mirror"; else fail "pull-proofs.sh does not pull:$missing_dirs"; fi
for d in $mirror_dirs; do mkdir -p "$remote/$d"; done
record storage-proofs/369/0xabc/100-0xdead '{"proof":1}'
record evidence/p/first-to-second/0x0e-aa '{"e":1}'
state1=11155111/000000000100-0x$(printf 'a%.0s' $(seq 1 64)).ssz
state2=11155111/000000000200-0x$(printf 'b%.0s' $(seq 1 64)).ssz
put "beacon-states/$state1" state-1
put "beacon-states/$state2" state-2
put snapshots/20261101T033000Z.sqlite db-1
write_manifest 20261101T033000Z

local_dir=$T/pulled
lm=$local_dir/mirror
: >"$T/rsync.log"
pull() {
  env FAKE_ROOT=$root FAKE_LOG=$T/rsync.log REAL_RSYNC=$REAL_RSYNC ZKB_PULL_RSYNC=$T/rsync ZKB_PULL_SSH=false ZKB_PULL_LOCAL_DIR=$local_dir ZKB_PULL_HOST=fakehost "$@" \
    bash "$DIR/pull-proofs.sh" >/dev/null 2>&1
}
mkdir -p "$local_dir"
printf 'old bundle\n' >"$local_dir/zk-bridge-proofs-20261030T033000Z.tar.gz"

status=0
pull || status=$?
if [ "$status" -eq 0 ] && diff -r "$remote" "$lm" >/dev/null && grep -q 'verified against 20261101T033000Z.json' "$local_dir/pull.log"; then pass "the first pull copies the whole mirror and verifies the newest manifest"; else fail "first pull (status $status): $(tail -3 "$local_dir/pull.log")"; fi
if grep -q -- '--ignore-existing.*storage-proofs/' "$T/rsync.log" && ! grep -qE -- '--delete.*:/var/backups/zk-bridge/proofs/mirror/(storage-proofs|light-client-proofs|evidence|conflicts)/' "$T/rsync.log" \
  && grep -q -- '--ignore-existing --delete.*mirror/beacon-states/' "$T/rsync.log" && grep -q -- '--ignore-existing --delete.*mirror/snapshots/' "$T/rsync.log" && grep -q -- '--ignore-existing --delete.*mirror/manifests/' "$T/rsync.log"; then
  pass "records: --ignore-existing, never --delete; beacon states, snapshots, manifests: --ignore-existing --delete"
else
  fail "rsync options: $(tr '\n' '|' <"$T/rsync.log")"
fi
if grep -q -- '--rsync-path=flock -s -w 3600 /var/backups/zk-bridge/proofs/.lock rsync' "$T/rsync.log"; then pass "each rsync waits for a running export (shared flock on the server's lock)"; else fail "no remote lock"; fi
if [ -f "$local_dir/zk-bridge-proofs-20261030T033000Z.tar.gz" ] && grep -q '1 bundle(s) of the old format stay' "$local_dir/pull.log"; then pass "the old tar.gz bundles are left alone"; else fail "old bundles"; fi
if [ -n "$(find "$local_dir" "$lm" -maxdepth 0 -perm 0700 | sed -n 2p)" ]; then pass "the local mirror is private to this user (0700 directories)"; else fail "local mirror modes: $(ls -ld "$local_dir" "$lm")"; fi

# The next day: the server pruned a state, a snapshot and its first manifest, lost a record, and added new files.
# (A failed first pull leaves no file: record that, so the remaining checks still run and report.)
{ ls -li "$lm/beacon-states/$state2" 2>/dev/null || echo missing; } | awk '{print $1}' >"$T/inode-1"
rm "$remote/beacon-states/$state1" "$remote/snapshots/20261101T033000Z.sqlite" "$remote/manifests/20261101T033000Z.json"
lost=$(cd "$remote" && ls evidence/p/first-to-second/)
rm "$remote/evidence/p/first-to-second/$lost"
state3=11155111/000000000300-0x$(printf 'c%.0s' $(seq 1 64)).ssz
put "beacon-states/$state3" state-3
put snapshots/20261102T033000Z.sqlite db-2
record light-client-proofs/p/first-to-second/1-2-0xff '{"lc":1}'
write_manifest 20261102T033000Z
status=0
pull || status=$?
{ ls -li "$lm/beacon-states/$state2" 2>/dev/null || echo missing-2; } | awk '{print $1}' >"$T/inode-2"
if [ "$status" -eq 0 ] && [ ! -e "$lm/beacon-states/$state1" ] && [ ! -e "$lm/snapshots/20261101T033000Z.sqlite" ] && [ ! -e "$lm/manifests/20261101T033000Z.json" ] \
  && [ -f "$lm/beacon-states/$state3" ] && [ -f "$lm/snapshots/20261102T033000Z.sqlite" ] && [ -n "$(ls "$lm/light-client-proofs/p/first-to-second/")" ]; then
  pass "a pull deletes what the server pruned and fetches what is new"
else
  fail "second pull (status $status): $(tail -3 "$local_dir/pull.log")"
fi
if [ -f "$lm/evidence/p/first-to-second/$lost" ] && grep -q "kept: evidence/p/first-to-second/$lost" "$local_dir/pull.log"; then pass "a record the server no longer has is kept here, and logged"; else fail "lost record: $(tail -5 "$local_dir/pull.log")"; fi
if grep -q 'beacon-states: 1 file(s) deleted here' "$local_dir/pull.log"; then pass "the deletions are logged"; else fail "deletions not logged"; fi
if cmp -s "$T/inode-1" "$T/inode-2"; then pass "a file that is here already is not fetched again"; else fail "existing file replaced"; fi

# A pull that meets an export half way: a file of the newest manifest is not here; one more pull fixes it.
state4=11155111/000000000400-0x$(printf 'd%.0s' $(seq 1 64)).ssz
put "beacon-states/$state4" state-4
write_manifest 20261103T033000Z
status=0
pull FAKE_SKIP_ONCE=beacon-states || status=$?
if [ "$status" -eq 0 ] && [ -f "$lm/beacon-states/$state4" ] && grep -q 'pulling again' "$local_dir/pull.log"; then pass "a file of the manifest that is missing after a pull gets one more pull"; else fail "retry (status $status): $(tail -3 "$local_dir/pull.log")"; fi

# A file here whose content differs from the manifest fails the run and is left as it is (--ignore-existing never
# replaces it; a person looks).
printf 'corrupt\n' >"$lm/beacon-states/$state2"
status=0
pull || status=$?
if [ "$status" -ne 0 ] && [ "$(cat "$lm/beacon-states/$state2")" = corrupt ] && grep -q "differs from the manifest: beacon-states/$state2" "$local_dir/pull.log"; then pass "a file that differs from the manifest fails the run and is left alone"; else fail "corrupt file (status $status)"; fi
cp "$remote/beacon-states/$state2" "$lm/beacon-states/$state2" 2>/dev/null || fail "restore the corrupted state (the pulls before failed)"

# A real manifest lists thousands of files with long paths. The check must not fail on a long list (a `grep -q` at
# the end of a pipe ends early, and under pipefail the SIGPIPE of the writer turned a match into a failure).
for i in $(seq 1 3000); do printf 'file %s\n' "$i" >"$remote/storage-proofs/369/0xabc/$i-0x$(printf 'e%.0s' $(seq 1 64)).json"; done
write_manifest 20261104T033000Z
status=0
pull || status=$?
if [ "$status" -eq 0 ] && grep -q 'verified against 20261104T033000Z.json: 3006 file(s)' "$local_dir/pull.log"; then pass "a manifest that lists 3000 files passes the check"; else fail "large manifest (status $status): $(tail -1 "$local_dir/pull.log")"; fi

# The hook gets the mirror and the newest manifest.
printf '#!/bin/sh\necho "$1 $2" >"%s/hook.out"\n' "$T" >"$T/hook"
chmod +x "$T/hook"
pull ZKB_PULL_HOOK="$T/hook" || true
if [ "$(cat "$T/hook.out" 2>/dev/null)" = "$lm $lm/manifests/20261104T033000Z.json" ]; then pass "the hook gets the mirror and the newest manifest"; else fail "hook: $(cat "$T/hook.out" 2>/dev/null)"; fi

# The hash checker failing without naming a file (a missing tool, an unreadable list, a format it rejects) is a failure,
# not a verified mirror: a fake shasum and sha256sum that exit 2 in silence when asked to check.
mkdir -p "$T/fakebin"
for tool in shasum sha256sum; do
  real=$(command -v "$tool" || true)
  [ -z "$real" ] || printf '#!/bin/sh\ncase " $* " in *" -c "*) exit 2 ;; esac\nexec %s "$@"\n' "$real" >"$T/fakebin/$tool"
done
chmod +x "$T/fakebin"/* 2>/dev/null || true
status=0
pull PATH="$T/fakebin:$PATH" || status=$?
if [ "$status" -ne 0 ] && grep -q 'hash checker exited 2 without naming a file' "$local_dir/pull.log" && ! grep -q 'verified against 20261104T033000Z.json' <(tail -2 "$local_dir/pull.log"); then pass "a hash checker that fails without naming a file fails the run"; else fail "silent checker failure (status $status): $(tail -2 "$local_dir/pull.log")"; fi

# A manifest entry whose hash is not 64 hex digits is refused (a Mac's shasum -c --quiet skips such a line in silence).
write_manifest 20261105T033000Z
bad=$remote/manifests/20261105T033000Z.json
sed 's/"sha256":"[0-9a-f]*"/"sha256":"notahash"/' "$bad" >"$T/bad.json"
cp "$T/bad.json" "$bad"
cp "$T/bad.json" "$root/var/backups/zk-bridge/proofs/trusted-manifests/20261105T033000Z.json"
printf '%s  20261105T033000Z.json\n' "$(sha "$bad")" >>"$root/var/backups/zk-bridge/proofs/manifests.sha256"
status=0
pull || status=$?
if [ "$status" -ne 0 ] && grep -q 'the manifest has a malformed entry: notahash' "$local_dir/pull.log"; then pass "a manifest entry with a malformed hash fails the run"; else fail "malformed hash (status $status): $(tail -2 "$local_dir/pull.log")"; fi
rm -f "$bad" "$root/var/backups/zk-bridge/proofs/trusted-manifests/20261105T033000Z.json" "$lm/manifests/20261105T033000Z.json" "$local_dir/trusted-manifests/20261105T033000Z.json"
pull || true

# A manifest changed on the server after the export (by whoever can write the mirror) is refused: its hash is not in
# the list root keeps outside the mirror.
if [ -f "$local_dir/manifests.sha256" ]; then pass "the pull fetches the server's manifests.sha256"; else fail "no local manifests.sha256"; fi
mf=$remote/manifests/20261104T033000Z.json
cp "$mf" "$T/mf.keep"
sed 's/"formatVersion":2/"formatVersion":2,"note":"x"/' "$T/mf.keep" >"$mf"
rm -f "$lm/manifests/20261104T033000Z.json"
# (A server without a trusted copy of it: only the hash list can catch it.)
tm=$root/var/backups/zk-bridge/proofs/trusted-manifests/20261104T033000Z.json
mv "$tm" "$T/tm.keep"
status=0
pull || status=$?
if [ "$status" -ne 0 ] && grep -q 'is not in the server.s manifests.sha256' "$local_dir/pull.log"; then pass "a manifest that is not in the server's manifests.sha256 fails the pull"; else fail "tampered manifest (status $status)"; fi
cp "$T/mf.keep" "$mf"
mv "$T/tm.keep" "$tm"
rm -f "$lm/manifests/20261104T033000Z.json"
pull || true
# The trusted copy is preferred: a mirror manifest that differs from it fails, even when its own hash were listed.
sed 's/"formatVersion":2/"formatVersion":2,"note":"y"/' "$T/mf.keep" >"$mf"
printf '%s  20261104T033000Z.json\n' "$(sha "$mf")" >>"$root/var/backups/zk-bridge/proofs/manifests.sha256"
rm -f "$lm/manifests/20261104T033000Z.json"
status=0
pull || status=$?
if [ "$status" -ne 0 ] && [ -f "$local_dir/trusted-manifests/20261104T033000Z.json" ] && grep -q "differs from the server's trusted copy" "$local_dir/pull.log"; then pass "the pull fetches the server's trusted manifests and prefers them"; else fail "trusted copy (status $status)"; fi
cp "$T/mf.keep" "$mf"
rm -f "$lm/manifests/20261104T033000Z.json"
# A name in manifests/ outside the server's rule fails the pull.
printf '{}\n' >"$remote/manifests/zzz.json"
status=0
pull || status=$?
if [ "$status" -ne 0 ] && grep -q 'manifests/ holds zzz.json' "$local_dir/pull.log"; then pass "a manifest name outside the rule fails the pull"; else fail "zzz.json pull (status $status)"; fi
rm -f "$remote/manifests/zzz.json"
pull || true

# No manifest on the server: the run fails.
rm -f "$remote"/manifests/*.json
status=0
pull || status=$?
if [ "$status" -ne 0 ] && grep -q 'the mirror has no manifest' "$local_dir/pull.log"; then pass "a mirror without a manifest fails the run"; else fail "no manifest (status $status)"; fi
if ! grep -q '://' "$local_dir/pull.log" && grep -q 'from fakehost' "$local_dir/pull.log"; then pass "log written, host alias only"; else fail "log"; fi

printf '%d failure(s)\n' "$FAILURES"
[ "$FAILURES" -eq 0 ]
