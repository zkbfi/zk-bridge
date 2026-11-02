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
  printf 'SKIP  pull tests: neither node nor python3 to read manifest.json\n'
  printf '%d failure(s)\n' "$FAILURES"
  [ "$FAILURES" -eq 0 ]
  exit
fi

remote=$T/remote
mkdir -p "$remote"
# make_bundle <stamp> [tamper]: a bundle with a manifest, in the fake remote directory.
make_bundle() {
  local stamp=$1 w=$T/w-$1
  mkdir -p "$w/archive" "$w/files"
  printf 'proof %s\n' "$stamp" >"$w/archive/storage_proofs.ndjson"
  printf 'cache %s\n' "$stamp" >"$w/files/a.json"
  printf '{"formatVersion":1,"files":{"archive/storage_proofs.ndjson":{"sha256":"%s","bytes":1},"files/a.json":{"sha256":"%s","bytes":1}}}\n' \
    "$(sha "$w/archive/storage_proofs.ndjson")" "$(sha "$w/files/a.json")" >"$w/manifest.json"
  if [ "${2:-}" = tamper ]; then printf 'x\n' >>"$w/files/a.json"; fi
  tar -czf "$remote/zk-bridge-proofs-$stamp.tar.gz" -C "$w" .
  # The .sha256 is of the real bundle, so only the manifest check can catch a tampered file.
  printf '%s  zk-bridge-proofs-%s.tar.gz\n' "$(sha "$remote/zk-bridge-proofs-$stamp.tar.gz")" "$stamp" >"$remote/zk-bridge-proofs-$stamp.tar.gz.sha256"
}

# The fake ssh answers the listing; the fake rsync copies "host:path" sources from the fake remote directory.
cat >"$T/ssh" <<'EOS'
#!/bin/sh
ls -1 "$FAKE_REMOTE"
EOS
cat >"$T/rsync" <<'EOS'
#!/bin/sh
for a in "$@"; do last=$a; done
for a in "$@"; do
  case $a in
    *:/*) cp "$FAKE_REMOTE/$(basename "${a#*:}")" "$last" || exit 23 ;;
  esac
done
EOS
chmod +x "$T/ssh" "$T/rsync"

local_dir=$T/pulled
pull() {
  env FAKE_REMOTE=$remote ZKB_PULL_SSH=$T/ssh ZKB_PULL_RSYNC=$T/rsync ZKB_PULL_LOCAL_DIR=$local_dir ZKB_PULL_HOST=fakehost "$@" \
    bash "$DIR/pull-proofs.sh" >/dev/null 2>&1
}

make_bundle 20260101T000000Z
status=0
pull ZKB_PULL_KEEP=2 || status=$?
if [ "$status" -eq 0 ] && [ -f "$local_dir/zk-bridge-proofs-20260101T000000Z.tar.gz" ] && [ -f "$local_dir/zk-bridge-proofs-20260101T000000Z.tar.gz.sha256" ]; then pass "pulls the newest bundle and its .sha256"; else fail "pull (status $status)"; fi
status=0
pull ZKB_PULL_KEEP=2 || status=$?
if [ "$status" -eq 0 ] && grep -q 'here already' "$local_dir/pull.log"; then pass "skips a bundle that is already here"; else fail "skip (status $status)"; fi
make_bundle 20260102T000000Z
pull ZKB_PULL_KEEP=2 || true
make_bundle 20260103T000000Z
pull ZKB_PULL_KEEP=2 || true
n=$(ls "$local_dir"/zk-bridge-proofs-*.tar.gz | wc -l | tr -d ' ')
if [ "$n" -eq 2 ] && [ ! -e "$local_dir/zk-bridge-proofs-20260101T000000Z.tar.gz" ] && [ ! -e "$local_dir/zk-bridge-proofs-20260101T000000Z.tar.gz.sha256" ]; then pass "retention keeps the newest 2 (and drops the .sha256)"; else fail "retention (kept $n)"; fi

make_bundle 20260104T000000Z tamper
status=0
pull ZKB_PULL_KEEP=5 || status=$?
if [ "$status" -ne 0 ] && [ ! -e "$local_dir/zk-bridge-proofs-20260104T000000Z.tar.gz" ] && [ -z "$(ls -A "$local_dir/.incoming" 2>/dev/null)" ]; then pass "a bundle whose file differs from its manifest is rejected and deleted"; else fail "tampered bundle (status $status)"; fi
make_bundle 20260105T000000Z
printf 'corrupt\n' >>"$remote/zk-bridge-proofs-20260105T000000Z.tar.gz"
status=0
pull ZKB_PULL_KEEP=5 || status=$?
if [ "$status" -ne 0 ] && [ ! -e "$local_dir/zk-bridge-proofs-20260105T000000Z.tar.gz" ]; then pass "a bundle that fails its .sha256 is rejected and deleted"; else fail "bad sha256 (status $status)"; fi
if ls "$local_dir"/pull.log >/dev/null 2>&1 && ! grep -q 'fakehost.*://' "$local_dir/pull.log"; then pass "log written, hosts only"; else fail "log"; fi

printf '%d failure(s)\n' "$FAILURES"
[ "$FAILURES" -eq 0 ]
