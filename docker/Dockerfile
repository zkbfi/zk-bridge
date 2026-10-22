# Images of the local network. The build context is the repository root (see docker/compose.yaml).
#
#   target deploy   Foundry plus the compiled contracts and the deploy script.
#   target prover   The prover service, the bots and the beacon stub, on a small Debian base.
#   target prover-sp1   The production prover for a server: linux/amd64, feature sp1-native-gnark, the two SP1 guest ELFs.
#                       Build: docker build --platform linux/amd64 --target prover-sp1 -f docker/Dockerfile .
#                       Needs about 8 GB of memory to build. See docs/server-prover.md. Do not build it on the 2 GB VM.
#
# The chains run from the Foundry image itself, so they need no target here.
#
# Every base image is pinned by an exact version tag and by digest. Each tag is older than 28 days at the cutoff of
# 2026-09-24. The Rust version is the one the repository builds with.
ARG FOUNDRY_IMAGE=ghcr.io/foundry-rs/foundry:v1.7.0@sha256:ff06299a789deee1d9e07d93961f08330820e2444a8dbbb425c1256bc3d1c206
ARG RUST_IMAGE=rust:1.93.0-slim-bookworm@sha256:776861219cd851131c1cec3bbd7cbeb16b99a794048097eb69ad9682a8ed0d57
ARG RUNTIME_IMAGE=debian:bookworm-20260316-slim@sha256:f06537653ac770703bc45b4b113475bd402f451e85223f0f2837acbf89ab020a

# ---------------------------------------------------------------------------------------------------------------
# Rust build. Two jobs only: the build VM has about 2 GB of memory. The cache mounts keep the downloaded crates
# and the compiled dependencies between builds. The binaries are copied out inside the same RUN, because a cache
# mount is not part of the image.
# ---------------------------------------------------------------------------------------------------------------
FROM ${RUST_IMAGE} AS build
WORKDIR /build
COPY light-client ./light-client
COPY prover ./prover
WORKDIR /build/prover
RUN --mount=type=cache,target=/usr/local/cargo/registry \
    --mount=type=cache,target=/usr/local/cargo/git \
    --mount=type=cache,target=/build/prover/target \
    cargo build --release --locked -j 2 \
    && mkdir /out \
    && cp target/release/zk-bridge-prover target/release/local-network /out/

# ---------------------------------------------------------------------------------------------------------------
# The prover image: the prover, the bots and the beacon stub.
# ---------------------------------------------------------------------------------------------------------------
FROM ${RUNTIME_IMAGE} AS prover
LABEL org.opencontainers.image.title="zk-bridge local network: prover and bots" \
      org.opencontainers.image.description="Development image. The keys it uses are the public Anvil development keys."
RUN useradd --uid 1000 --no-create-home --shell /usr/sbin/nologin bridge \
    && mkdir /state \
    && chown bridge:bridge /state
COPY --from=build /out/zk-bridge-prover /out/local-network /usr/local/bin/
COPY docker/prover-entry.sh /usr/local/bin/prover-entry
RUN chmod 0755 /usr/local/bin/prover-entry
USER bridge
WORKDIR /state

# ---------------------------------------------------------------------------------------------------------------
# The deploy image: Foundry, the contracts built once, and the deploy script.
# ---------------------------------------------------------------------------------------------------------------
FROM ${FOUNDRY_IMAGE} AS deploy
LABEL org.opencontainers.image.title="zk-bridge local network: deploy" \
      org.opencontainers.image.description="Development image. It deploys test contracts to two local Anvil chains."
USER root
RUN mkdir /repo /state && chown foundry:foundry /repo /state
USER foundry
WORKDIR /repo
COPY --chown=foundry:foundry foundry.toml remappings.txt ./
COPY --chown=foundry:foundry lib ./lib
COPY --chown=foundry:foundry src ./src
COPY --chown=foundry:foundry script ./script
# Build once, so the deploy step needs no compiler download and no long compile.
RUN forge build --skip test
COPY --chown=foundry:foundry docker/deploy.sh docker/bridge.config.template.json ./docker/
ENTRYPOINT ["/usr/bin/bash", "/repo/docker/deploy.sh"]

# ---------------------------------------------------------------------------------------------------------------
# The production prover for a server (target prover-sp1). Platform linux/amd64.
#
# - Cargo features: sp1-native-gnark (SP1 prover on the local CPU; the Groth16 wrapper runs inside the process, so the
#   container needs no Docker socket). Without the development source and without the local-network binaries.
# - Go is needed at build time only, for the Groth16 wrapper that sp1-sdk compiles. The tarball is pinned by SHA-256.
#   The commit of go1.25.14 is dated 2026-08-19, more than 28 days before the cutoff of 2026-09-24. The Go modules of
#   the wrapper are pinned by the go.sum file inside the crate sp1-recursion-gnark-ffi and checked by the Go checksum database.
# - The apt packages (compiler, libclang) are not pinned. They build the wrapper and are not part of the final image.
# - The ELFs come from the reproducible build: `ELF_OUTPUT_DIR=light-client/elf light-client/scripts/program-keys.sh`.
#   The build fails when the SHA-256 of an ELF differs from light-client/program-keys.json.
# ---------------------------------------------------------------------------------------------------------------
FROM --platform=linux/amd64 ${RUST_IMAGE} AS build-sp1
ARG GO_VERSION=1.25.14
ARG GO_SHA256=a21ae5633a269bcd7e90cf767e48225633795e99d831742cbf3397064fee7712
ADD --checksum=sha256:${GO_SHA256} https://go.dev/dl/go${GO_VERSION}.linux-amd64.tar.gz /tmp/go.tar.gz
RUN tar -C /usr/local -xzf /tmp/go.tar.gz && rm /tmp/go.tar.gz
RUN apt-get update \
    && apt-get install -y --no-install-recommends build-essential clang libclang-dev ca-certificates \
    && rm -rf /var/lib/apt/lists/*
ENV PATH="/usr/local/go/bin:${PATH}" GOPROXY=https://proxy.golang.org
WORKDIR /build
COPY light-client ./light-client
COPY prover ./prover
WORKDIR /build/prover
RUN --mount=type=cache,target=/usr/local/cargo/registry \
    --mount=type=cache,target=/usr/local/cargo/git \
    --mount=type=cache,target=/root/go/pkg/mod \
    --mount=type=cache,target=/build/prover/target \
    cargo build --release --locked --no-default-features --features sp1-native-gnark --bin zk-bridge-prover \
    && mkdir /out \
    && cp target/release/zk-bridge-prover /out/

# Checks the two ELFs against light-client/program-keys.json before they enter the image.
FROM --platform=linux/amd64 ${RUNTIME_IMAGE} AS check-elfs
COPY light-client/program-keys.json /check/program-keys.json
COPY light-client/elf/light-client.elf light-client/elf/fork-observation.elf /check/
RUN set -eu; \
    for guest in light-client fork-observation; do \
      expected="$(awk -v g="\"${guest}\"" '$1 == g":" {found=1} found && /elf_sha256/ {gsub(/[",]/, "", $2); print $2; exit}' /check/program-keys.json)"; \
      actual="$(sha256sum "/check/${guest}.elf" | cut -d' ' -f1)"; \
      test -n "${expected}" || { echo "no entry for ${guest} in program-keys.json"; exit 1; }; \
      test "${expected}" = "${actual}" || { echo "ELF ${guest}: SHA-256 ${actual} differs from program-keys.json (${expected})"; exit 1; }; \
    done

FROM --platform=linux/amd64 ${RUNTIME_IMAGE} AS prover-sp1
LABEL org.opencontainers.image.title="zk-bridge production prover (SP1, local CPU)"
RUN apt-get update \
    && apt-get install -y --no-install-recommends ca-certificates \
    && rm -rf /var/lib/apt/lists/* \
    && useradd --uid 1000 --create-home --home-dir /home/bridge --shell /usr/sbin/nologin bridge \
    && mkdir /state /elf \
    && chown bridge:bridge /state
COPY --from=build-sp1 /out/zk-bridge-prover /usr/local/bin/
COPY --from=check-elfs /check/light-client.elf /check/fork-observation.elf /elf/
# The Groth16 circuit files are downloaded on the first proof. Mount a volume on /state to keep them.
ENV SP1_GROTH16_CIRCUIT_PATH=/state/sp1-circuits
USER bridge
WORKDIR /state
ENTRYPOINT ["zk-bridge-prover"]
CMD ["--config", "/state/prover.toml", "run"]
