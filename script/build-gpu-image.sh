#!/usr/bin/env bash
# Builds the image of the GPU proving worker (target prover-gpu-worker) on the build host, with the BuildKit cache.
#
# Usage:   script/build-gpu-image.sh [--tag <image:tag>] [--host <ssh host>] [--push] [--no-cache]
# Steps:   1. fixes the ownership of the persistent build directory on the host (earlier Docker runs leave root files),
#          2. syncs the files of HEAD (git archive) and the two ELFs of light-client/elf/ into that directory,
#          3. runs `docker build` there, which reuses the cache mounts of docker/Dockerfile,
#          4. fixes the ownership again, prints the elapsed time and the image digest.
# It pushes the image only with --push, and --push needs --tag with a full registry name.
#
# Options:
#   --tag   image name and tag (default: zk-bridge-prover-gpu-worker:local, never pushed)
#   --host  ssh host of the build host (required: this option or the variable BUILD_HOST)
#   --push  push the tag after the build and print the registry digest
#   --no-cache  ignore the layer cache (a cold build). The cache mounts of cargo stay, so for a fully cold build empty
#           them first with `docker builder prune` on the host.
#
# The persistent directory is $HOME/zk-bridge-build/gpu-image on the host (variable BUILD_DIR, relative to the home
# directory of the ssh user). Only tracked files of HEAD are synced: uncommitted changes are not built.
# The ELFs must match light-client/program-keys.json. The Dockerfile checks this and fails the build otherwise.
# See docs/gpu-prover.md.
set -euo pipefail

cd "$(dirname "$0")/.."

host="${BUILD_HOST:-}"
build_directory="${BUILD_DIR:-zk-bridge-build/gpu-image}"
tag="zk-bridge-prover-gpu-worker:local"
push_requested="no"
cache_option=""
tag_given="no"

while [ $# -gt 0 ]; do
  case "$1" in
    --tag) tag="${2:?--tag needs a value}"; tag_given="yes"; shift 2 ;;
    --host) host="${2:?--host needs a value}"; shift 2 ;;
    --push) push_requested="yes"; shift ;;
    --no-cache) cache_option="--no-cache"; shift ;;
    *) echo "usage: $0 [--tag <image:tag>] [--host <ssh host>] [--push] [--no-cache]" >&2; exit 2 ;;
  esac
done
if [ "${push_requested}" = "yes" ] && [ "${tag_given}" = "no" ]; then
  echo "--push needs --tag with the full registry name, for example ghcr.io/<owner>/zk-bridge-prover-gpu-worker:v6" >&2
  exit 2
fi
if [ -z "${host}" ]; then
  echo "set the variable BUILD_HOST (or pass --host) to the ssh host of the build host" >&2
  exit 2
fi
for elf in light-client fork-observation; do
  [ -f "light-client/elf/${elf}.elf" ] || { echo "missing light-client/elf/${elf}.elf (run light-client/scripts/program-keys.sh with ELF_OUTPUT_DIR)" >&2; exit 1; }
done

# The cleanup container uses the runtime image that the Dockerfile pins, so no new image enters the build.
cleanup_image="$(sed -n 's/^ARG RUNTIME_IMAGE=//p' docker/Dockerfile)"
[ -n "${cleanup_image}" ] || { echo "RUNTIME_IMAGE not found in docker/Dockerfile" >&2; exit 1; }

# Gives the files of the build directory back to the ssh user.
fix_ownership() {
  ssh "${host}" "mkdir -p '${build_directory}' && docker run --rm -v \"\$HOME/${build_directory}:/w\" '${cleanup_image}' chown -R \"\$(id -u):\$(id -g)\" /w"
}

started="${SECONDS}"
fix_ownership

staging="$(mktemp -d)"
trap 'rm -rf "${staging}"' EXIT
git archive HEAD | tar -x -C "${staging}"
mkdir -p "${staging}/light-client/elf"
cp light-client/elf/light-client.elf light-client/elf/fork-observation.elf "${staging}/light-client/elf/"
# Same files give the same content. rsync keeps the file times, and --delete removes files that left the repository.
rsync -a --delete --exclude 'target/' "${staging}/" "${host}:${build_directory}/"
echo "synced HEAD $(git rev-parse --short HEAD) to ${host}:${build_directory}"

build_started="${SECONDS}"
ssh "${host}" "cd '${build_directory}' && DOCKER_BUILDKIT=1 docker build ${cache_option} --platform linux/amd64 --target prover-gpu-worker -f docker/Dockerfile -t '${tag}' ."
build_seconds=$((SECONDS - build_started))
fix_ownership

image_id="$(ssh "${host}" "docker image inspect --format '{{.Id}}' '${tag}'")"
if [ "${push_requested}" = "yes" ]; then
  ssh "${host}" "docker push '${tag}'"
  registry_digest="$(ssh "${host}" "docker image inspect --format '{{index .RepoDigests 0}}' '${tag}'")"
  echo "registry digest: ${registry_digest}"
fi
echo "image: ${tag}"
echo "image id: ${image_id}"
echo "docker build seconds: ${build_seconds}"
echo "total seconds: $((SECONDS - started))"
