#!/usr/bin/env bash
# Rebuilds both SP1 guest programs in the pinned Docker image and checks them against program-keys.json.
# Usage: scripts/program-keys.sh [--write]
#   no option : print the ELF SHA-256 and the program key of each guest. Exit 1 when any value differs from program-keys.json.
#   --write   : print the values and write them to program-keys.json.
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
mode="${1:-check}"
[ "${mode}" = "check" ] || [ "${mode}" = "--write" ] || { echo "usage: $0 [--write]" >&2; exit 2; }

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
  echo "${guest}: elf_sha256=${elf_sha256} program_key=${program_key}"
  result="$(jq --arg g "${guest}" --arg s "${elf_sha256}" --arg k "${program_key}" '.[$g] = {elf_sha256: $s, program_key: $k}' <<<"${result}")"
done

if [ "${mode}" = "--write" ]; then
  jq -S . <<<"${result}" > "${keys_file}"
  echo "wrote ${keys_file}"
  exit 0
fi
if [ "$(jq -S . <<<"${result}")" = "$(jq -S . "${keys_file}")" ]; then
  echo "program keys match program-keys.json"
  exit 0
fi
echo "MISMATCH against program-keys.json" >&2
exit 1
