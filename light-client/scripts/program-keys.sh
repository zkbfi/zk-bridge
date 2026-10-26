#!/usr/bin/env bash
# Rebuilds both SP1 guest programs in the pinned Docker image and checks them against program-keys.json.
# Usage: scripts/program-keys.sh [--write] [--force] [--print-source-hash]
# Environment: ELF_OUTPUT_DIR=<dir> also copies the two ELFs to <dir>/light-client.elf and <dir>/fork-observation.elf.
#   The server image (docker/Dockerfile, target prover-sp1) reads them from light-client/elf/.
#   no option : print the ELF SHA-256 and the program key of each guest. Exit 1 when any value differs from program-keys.json.
#   --write   : print the values and write them to program-keys.json. It always builds, and it records the source hash
#               in program-keys.source-hash (next to program-keys.json).
#               A full check that matches records the hash too, so the next check can skip.
#   --force   : build even when the source hash matches the recorded hash.
#   --print-source-hash : print the source hash and exit. It builds nothing.
# The check skips the Docker build when the hash of the build inputs equals the recorded hash. The inputs are every file of
# guests/ and crates/lc-core/ (the target directories excluded), the three root files Cargo.toml, Cargo.lock and
# rust-toolchain.toml, the Cargo.toml of lc-testkit, and the pinned image digest. The tests and lc-testkit/src are not inputs
# of a guest. The skip needs program-keys.json, and with ELF_OUTPUT_DIR it needs both ELFs there with the recorded SHA-256.
# Needs: cargo prove (sp1-cli 6.8.1), a running Docker engine (Colima), jq, shasum.
# The image is the linux/amd64 manifest of ghcr.io/succinctlabs/sp1:v6.8.1, pinned by digest below.
# The first build pulls the image and compiles under emulation. Expect several minutes per guest.
set -euo pipefail

image_tag="v6.8.1"
image_digest="sha256:2ddd7c1d74be98be628e5e58f9b177a739eb3e7c0a6b8f7b97b358682cb4677b"
image="ghcr.io/succinctlabs/sp1"

here="$(cd "$(dirname "$0")/.." && pwd)"
keys_file="${here}/program-keys.json"
guests=(light-client fork-observation)
hash_file="${here}/program-keys.source-hash"
mode="check"
force="no"
print_hash_only="no"
for argument in "$@"; do
  case "${argument}" in
    --write) mode="--write" ;;
    --force) force="yes" ;;
    --print-source-hash) print_hash_only="yes" ;;
    *) echo "usage: $0 [--write] [--force] [--print-source-hash]" >&2; exit 2 ;;
  esac
done

# One SHA-256 over the build inputs. The file list is sorted in the C locale, so the value is the same on every machine.
source_hash() {
  (
    cd "${here}"
    {
      echo "image=${image}@${image_digest}"
      find guests crates -type f ! -path '*/target/*' ! -path '*/tests/*' ! -path 'crates/lc-testkit/src/*' ! -name '*.elf' |
        LC_ALL=C sort |
        while IFS= read -r file; do shasum -a 256 "${file}"; done
      shasum -a 256 Cargo.toml Cargo.lock rust-toolchain.toml
    } | shasum -a 256 | awk '{print $1}'
  )
}

current_hash="$(source_hash)"
if [ "${print_hash_only}" = "yes" ]; then
  echo "${current_hash}"
  exit 0
fi

# True when both ELFs in ELF_OUTPUT_DIR (if set) already carry the SHA-256 recorded in program-keys.json.
requested_elfs_are_current() {
  [ -n "${ELF_OUTPUT_DIR:-}" ] || return 0
  for guest in "${guests[@]}"; do
    [ -f "${ELF_OUTPUT_DIR}/${guest}.elf" ] || return 1
    [ "$(shasum -a 256 "${ELF_OUTPUT_DIR}/${guest}.elf" | awk '{print $1}')" = "$(jq -r --arg g "${guest}" '.[$g].elf_sha256' "${keys_file}")" ] || return 1
  done
}

skip_is_allowed() {
  [ "${mode}" = "check" ] || return 1
  [ "${force}" = "no" ] || return 1
  [ -f "${hash_file}" ] && [ -f "${keys_file}" ] || return 1
  [ "$(cat "${hash_file}")" = "${current_hash}" ] || return 1
  requested_elfs_are_current
}

if skip_is_allowed; then
  echo "build inputs unchanged (source hash ${current_hash}); skipping the Docker build. Use --force to build anyway."
  echo "program keys match program-keys.json (recorded after the last full match)"
  exit 0
fi

# Pull by digest and tag the result, so that `cargo prove build --docker --tag` uses exactly this image.
docker pull --platform linux/amd64 "${image}@${image_digest}" >/dev/null
docker tag "${image}@${image_digest}" "${image}:${image_tag}"

out_dir="$(mktemp -d)"
trap 'rm -rf "${out_dir}"' EXIT
result="{}"
for guest in "${guests[@]}"; do
  guest_dir="${here}/guests/${guest}"
  (cd "${guest_dir}" && cargo prove build --docker --tag "${image_tag}" --locked \
    --workspace-directory "${here}" --output-directory "${out_dir}/${guest}" >&2)
  elf="$(find "${out_dir}/${guest}" -type f | head -n 1)"
  [ -n "${elf}" ] || { echo "no ELF produced for ${guest}" >&2; exit 1; }
  elf_sha256="$(shasum -a 256 "${elf}" | awk '{print $1}')"
  program_key="$(cargo prove vkey --elf "${elf}" | grep -Eo '0x[0-9a-f]{64}')"
  if [ -n "${ELF_OUTPUT_DIR:-}" ]; then
    mkdir -p "${ELF_OUTPUT_DIR}"
    cp "${elf}" "${ELF_OUTPUT_DIR}/${guest}.elf"
  fi
  echo "${guest}: elf_sha256=${elf_sha256} program_key=${program_key}"
  result="$(jq --arg g "${guest}" --arg s "${elf_sha256}" --arg k "${program_key}" '.[$g] = {elf_sha256: $s, program_key: $k}' <<<"${result}")"
done

if [ "${mode}" = "--write" ]; then
  jq -S . <<<"${result}" > "${keys_file}"
  echo "${current_hash}" > "${hash_file}"
  echo "wrote ${keys_file} and ${hash_file}"
  exit 0
fi
if [ "$(jq -S . <<<"${result}")" = "$(jq -S . "${keys_file}")" ]; then
  echo "${current_hash}" > "${hash_file}"
  echo "program keys match program-keys.json (source hash recorded)"
  exit 0
fi
echo "MISMATCH against program-keys.json" >&2
exit 1
