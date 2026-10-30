#!/usr/bin/env bash
# Builds a complete signed release into an empty directory, then verifies it.
#
# Usage:   script/release/release.sh <output-directory> < release-key.jwk
#
# The release key (an Ed25519 private key in JWK form) arrives on standard input and is read only by the signing step
# at the end. Every build step runs with standard input closed, so no build tool can read the key. Nothing writes it.
#
# Steps:
#   1. builds the dapp (explorer/web), the docs (explorer/docs) and the landing page (explorer/landing)
#   2. packs each site into archives/<name>.car (UnixFS, CID version 1: the same files give the same CID)
#   3. builds the terminal programs into downloads/ (script/build-terminal.sh)
#   4. builds both guest programs (light-client.elf, fork-observation.elf) and the prover for this machine
#      (cargo build --release --no-default-features --features sp1) into downloads/
#   5. writes version.json, SHA256SUMS, version.json.sig and public-keys.json
#   6. verifies the directory; the last line is "release verified"
#
# Environment:
#   RELEASE_VERSION              the release version (default 0.0.0-<short commit>)
#   RELEASE_PREVIOUS_MANIFEST    the previous version.json, so the sequence goes up (default: none, sequence 1)
#   RELEASE_TERMINAL_TARGETS     Bun targets for the terminal, space separated (default: all of build-terminal.sh)
#   RELEASE_CHANNEL              stable (default) or next. next is the staging channel served at next.zkb.fi: the
#                                landing page is built from landing.next.config.json (it trusts only the staging key),
#                                version.json names channels.next, and the release is signed with the staging key.
#   RELEASE_SKIP_PROVER=1        builds no prover and no guest program. version.json then lists no prover download,
#                                and the script says so. For a test run on a machine without Docker or SP1 only.
#   DOCS_GATE_WITHOUT_PRIVATE_PATTERNS=1 is passed through to the docs build (see script/check-docs-public.sh).
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

commit="$(git -C "$repository_root" rev-parse --short HEAD)"
published_at="$(git -C "$repository_root" log -1 --format=%cI)"
version="${RELEASE_VERSION:-0.0.0-$commit}"
mkdir -p "$release/archives" "$release/downloads"

echo "== sites"
(cd "$repository_root/explorer" && pnpm --filter @zk-bridge/web build) </dev/null
(cd "$repository_root/explorer" && pnpm --filter @zk-bridge/docs build) </dev/null
(cd "$repository_root/explorer/landing" && LANDING_CONFIG="$landing_config" node scripts/build.ts) </dev/null
"${cli[@]}" pack "$repository_root/explorer/web/dist" "$release/archives/dapp.car" </dev/null
"${cli[@]}" pack "$repository_root/explorer/docs/dist" "$release/archives/docs.car" </dev/null
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
# The only step that reads standard input: the release key.
"${cli[@]}" sign "$release"

echo "== verify"
"${cli[@]}" verify "$release" --public-keys "$release/public-keys.json" </dev/null
