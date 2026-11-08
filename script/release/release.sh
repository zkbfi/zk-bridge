#!/usr/bin/env bash
# Builds a complete signed release into an empty directory, then verifies it.
#
# Usage:   script/release/release.sh <output-directory> < release-key.jwk
#
# The release key (an Ed25519 private key in JWK form) arrives on standard input and is read only by the signing step
# at the end. Every build step runs with standard input closed, so no build tool can read the key. Nothing writes it.
#
# Steps:
#   1. builds the dapp (explorer/web, which holds the docs: they load lazily at #/docs) and the landing page
#      (explorer/landing). There is no separate docs archive: docs.zkb.fi serves the dapp.
#   2. packs each site into archives/<name>.car (UnixFS, CID version 1: the same files give the same CID)
#   3. builds the terminal programs into downloads/ (script/build-terminal.sh)
#   4. builds both guest programs (light-client.elf, fork-observation.elf) and the prover for this machine
#      (cargo build --release --no-default-features --features sp1) into downloads/
#   5. writes version.json and SHA256SUMS, then releases-log.json: the channel's published release log with this
#      release's sites appended (see "The release log" in docs/release.md)
#   6. signs version.json and releases-log.json, writes public-keys.json
#   7. verifies the directory; the last line is "release verified"
#
# Environment:
#   RELEASE_VERSION              the release version (default 0.0.0-<short commit>)
#   RELEASE_PREVIOUS_MANIFEST    the previous version.json, so the sequence goes up (default: none, sequence 1)
#   RELEASE_REMOTE               the release repository. The published releases-log.json of the channel's branch is
#                                fetched from it before the build and checked against the channel's trusted keys
#                                (the landing configuration, never the release). A branch that has releases but no
#                                log stops the build: make the first log with script/release/bootstrap-log.sh.
#   RELEASE_PREVIOUS_LOG         a releases-log.json to append to instead (its signature at <file>.sig)
#                                With neither, the log starts with this release, and publish.sh refuses it when the
#                                release repository already has a log.
#   RELEASE_TERMINAL_TARGETS     Bun targets for the terminal, space separated (default: all of build-terminal.sh)
#   RELEASE_CHANNEL              stable (default) or next. next is the staging channel served at next.zkb.fi: the
#                                landing page is built from landing.next.config.json (it trusts only the staging key),
#                                version.json names channels.next, and the release is signed with the staging key.
#   RELEASE_SKIP_PROVER=1        builds no prover and no guest program. version.json then lists no prover download,
#                                and the script says so. For a test run on a machine without Docker or SP1 only.
#   DOCS_GATE_WITHOUT_PRIVATE_PATTERNS=1 is passed through to the dapp build, which runs the docs public-content gate
#                                (see script/check-docs-public.sh).
set -euo pipefail

if [ "$#" -ne 1 ]; then
  echo "usage: $0 <output-directory> < release-key.jwk" >&2
  exit 2
fi
channel="${RELEASE_CHANNEL:-stable}"
case "$channel" in
  stable) landing_config=landing.config.json ;;
  next) landing_config=landing.next.config.json ;;
  *) echo "RELEASE_CHANNEL must be stable or next, not $channel" >&2; exit 1 ;;
esac

repository_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
mkdir -p "$1"
release="$(cd "$1" && pwd)"
if [ -n "$(ls -A "$release")" ]; then
  echo "$release is not empty: a release starts from an empty directory" >&2
  exit 1
fi
cli=(node "$repository_root/explorer/release/src/cli.ts")
# shellcheck source=script/release/channels.sh
. "$repository_root/script/release/channels.sh"
trusted_keys="$(channel_keys_file "$channel")"

# The published release log comes first, so a missing or broken one stops the build before it starts.
log_work="$(mktemp -d)"
trap 'rm -rf "$log_work"' EXIT
channel_previous_log "$channel" "$log_work" </dev/null
previous_log=()
if [ -n "$CHANNEL_PREVIOUS_LOG" ]; then
  "${cli[@]}" log-check "$CHANNEL_PREVIOUS_LOG" --public-keys "$trusted_keys" </dev/null
  previous_log=(--previous-log "$CHANNEL_PREVIOUS_LOG" --public-keys "$trusted_keys")
fi

# The full SHA: a promotion checks it is on origin/main (script/release/promote-checks.sh).
commit="$(git -C "$repository_root" rev-parse HEAD)"
published_at="$(git -C "$repository_root" log -1 --format=%cI)"
version="${RELEASE_VERSION:-0.0.0-${commit:0:7}}"
mkdir -p "$release/archives" "$release/downloads"

echo "== sites"
(cd "$repository_root/explorer" && VITE_ZKB_VERSION="$version" pnpm --filter @zk-bridge/web build) </dev/null
(cd "$repository_root/explorer/landing" && LANDING_CONFIG="$landing_config" node scripts/build.ts) </dev/null
"${cli[@]}" pack "$repository_root/explorer/web/dist" "$release/archives/dapp.car" </dev/null
"${cli[@]}" pack "$repository_root/explorer/landing/dist" "$release/archives/landing.car" </dev/null

echo "== terminal"
# shellcheck disable=SC2086 # the targets are a space separated list on purpose
"$repository_root/script/build-terminal.sh" "$release/downloads" ${RELEASE_TERMINAL_TARGETS:-} </dev/null

echo "== prover"
if [ "${RELEASE_SKIP_PROVER:-}" = "1" ]; then
  echo "skipped prover: RELEASE_SKIP_PROVER=1, so version.json lists no prover and no guest program"
else
  case "$(uname -s)" in Darwin) os=darwin ;; Linux) os=linux ;; *) echo "no prover build for $(uname -s)" >&2; exit 1 ;; esac
  case "$(uname -m)" in arm64 | aarch64) arch=arm64 ;; x86_64) arch=x64 ;; *) echo "no prover build for $(uname -m)" >&2; exit 1 ;; esac
  ELF_OUTPUT_DIR="$release/downloads" "$repository_root/light-client/scripts/program-keys.sh" </dev/null
  (cd "$repository_root/prover" && cargo build --release --no-default-features --features sp1) </dev/null
  cp "$repository_root/prover/target/release/zk-bridge-prover" "$release/downloads/zk-bridge-prover-$os-$arch"
fi

echo "== manifest"
previous=()
if [ -n "${RELEASE_PREVIOUS_MANIFEST:-}" ]; then previous=(--previous "$RELEASE_PREVIOUS_MANIFEST"); fi
"${cli[@]}" manifest "$release" --version "$version" --commit "$commit" --published-at "$published_at" --channel "$channel" \
  "${previous[@]+"${previous[@]}"}" </dev/null
"${cli[@]}" log "$release" "${previous_log[@]+"${previous_log[@]}"}" </dev/null
# The only step that reads standard input: the release key. It signs version.json and releases-log.json.
"${cli[@]}" sign "$release"

echo "== verify"
"${cli[@]}" log-check "$release/releases-log.json" --public-keys "$release/public-keys.json" --manifest "$release/version.json" </dev/null
"${cli[@]}" verify "$release" --public-keys "$release/public-keys.json" </dev/null
