#!/usr/bin/env bash
# Builds the standalone terminal program with `bun build --compile`.
#
# Usage: script/build-terminal.sh <output-directory> [target...]
#
# The targets default to: bun-darwin-arm64 bun-darwin-x64 bun-linux-x64 bun-linux-arm64 bun-windows-x64.
# Each target writes zk-bridge-terminal-<os>-<arch> into the output directory (Bun adds .exe for Windows).
# The script prints one line per target: "ok <file>" or "skipped <target>: <reason>".
# Windows is attempted, and a failure there is a skip. A failure for any other target exits with code 1.
# The build commit comes from `git rev-parse --short HEAD`, or from BUILD_COMMIT when that is set.
set -uo pipefail

if [ "$#" -lt 1 ]; then
  echo "usage: $0 <output-directory> [target...]" >&2
  exit 2
fi

repository_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
mkdir -p "$1"
output_directory="$(cd "$1" && pwd)"
shift

if [ "$#" -gt 0 ]; then
  targets=("$@")
else
  targets=(bun-darwin-arm64 bun-darwin-x64 bun-linux-x64 bun-linux-arm64 bun-windows-x64)
fi

terminal_directory="$repository_root/explorer/terminal"

# OpenTUI ships its native library in one package per platform, and only the package for this machine is
# installed. A compiled program needs the package of its target, so this fetches the ones that are missing, checks
# each against the integrity hash that explorer/terminal/bun.lock pins, and points the build at them.
opentui_version="$(sed -n 's/^ *"@opentui\/core": *"\([^"]*\)".*/\1/p' "$terminal_directory/package.json")"
if [ -z "$opentui_version" ]; then
  echo "cannot read the @opentui/core version from explorer/terminal/package.json" >&2
  exit 1
fi
opentui_platforms=(darwin-arm64 darwin-x64 linux-x64 linux-x64-musl linux-arm64 linux-arm64-musl win32-x64)

# Prints the pinned integrity hash of one platform package, or nothing when the lock file does not pin it.
pinned_integrity() {
  grep -F "\"@opentui/core-$1@$opentui_version\"" "$terminal_directory/bun.lock" | grep -o 'sha512-[^"]*' | head -n 1
}

# Downloads and unpacks every platform package into $1/modules/@opentui and writes $1/tsconfig.json.
# Returns 1 when a download fails or no hash is pinned (the caller may carry on without the packages).
# Returns 2 when a download does not match its pinned hash. That is a supply-chain signal, and the caller must stop.
prepare_platform_packages() {
  local scratch="$1" platform tarball expected actual
  for platform in "${opentui_platforms[@]}"; do
    expected="$(pinned_integrity "$platform")"
    if [ -z "$expected" ]; then
      echo "no pinned integrity hash for @opentui/core-$platform in bun.lock" >&2
      return 1
    fi
    (cd "$scratch" && npm pack "@opentui/core-$platform@$opentui_version" --silent >/dev/null 2>&1) || {
      echo "could not download @opentui/core-$platform@$opentui_version" >&2
      return 1
    }
    tarball="$scratch/opentui-core-$platform-$opentui_version.tgz"
    actual="sha512-$(openssl dgst -sha512 -binary "$tarball" | openssl base64 -A)"
    if [ "$actual" != "$expected" ]; then
      echo "@opentui/core-$platform does not match the hash in bun.lock" >&2
      return 2
    fi
    mkdir -p "$scratch/modules/@opentui/core-$platform"
    tar xzf "$tarball" -C "$scratch/modules/@opentui/core-$platform" --strip-components=1
  done
  # A tsconfig override replaces the project one, so it extends it and repeats the paths of the shared package
  # (every alias of explorer/terminal/tsconfig.json; explorer/terminal/test/build-script.test.ts checks that).
  # Each path names index.bun.js, the file that embeds the native library; a bare directory would pick index.js.
  cat >"$scratch/tsconfig.json" <<JSON
{
  "extends": "$terminal_directory/tsconfig.json",
  "compilerOptions": {
    "paths": {
      "@zk-bridge/shared": ["$repository_root/explorer/shared/src/index.ts"],
      "@zk-bridge/shared/config": ["$repository_root/explorer/shared/src/config/index.ts"],
      "@zk-bridge/shared/prover": ["$repository_root/explorer/shared/src/prover/index.ts"],
      "@zk-bridge/shared/backend-client": ["$repository_root/explorer/shared/src/backend-client.ts"],
      "@zk-bridge/shared/msgboard-http": ["$repository_root/explorer/shared/src/msgboard/board-http.ts"],
      "@opentui/core-*": ["$scratch/modules/@opentui/core-*/index.bun.js"]
    }
  }
}
JSON
}

commit="${BUILD_COMMIT:-$(git -C "$repository_root" rev-parse --short HEAD 2>/dev/null || echo unknown)}"
native_failed=0

cd "$terminal_directory" || exit 1

scratch_directory="$(mktemp -d)"
trap 'rm -rf "$scratch_directory"' EXIT
tsconfig_arguments=()
prepare_platform_packages "$scratch_directory"
prepare_status=$?
if [ "$prepare_status" -eq 0 ]; then
  tsconfig_arguments=(--tsconfig-override="$scratch_directory/tsconfig.json")
elif [ "$prepare_status" -eq 2 ]; then
  echo "stopping: a downloaded package does not match explorer/terminal/bun.lock" >&2
  exit 1
else
  echo "warning: building with the platform packages that are installed; other targets may fail" >&2
fi

for target in "${targets[@]}"; do
  platform="${target#bun-}"
  case "$platform" in
    darwin-* | linux-* | windows-*) ;;
    *)
      echo "skipped $target: not a Bun compile target of the form bun-<os>-<arch>"
      native_failed=1
      continue
      ;;
  esac
  file="zk-bridge-terminal-$platform"
  log="$(mktemp)"
  if bun build --compile --minify --target="$target" "${tsconfig_arguments[@]+"${tsconfig_arguments[@]}"}" \
    --define "BUILD_COMMIT=\"$commit\"" \
    src/main.tsx --outfile "$output_directory/$file" >"$log" 2>&1; then
    case "$platform" in windows-*) file="$file.exe" ;; esac
    echo "ok $file"
  else
    reason="$(tail -n 1 "$log")"
    case "$platform" in
      windows-*)
        echo "skipped $target: ${reason:-build failed}"
        ;;
      *)
        echo "skipped $target: ${reason:-build failed}"
        native_failed=1
        ;;
    esac
  fi
  rm -f "$log"
done

exit "$native_failed"
