# Images of the repository. The build context is the repository root (see docker/compose.yaml).
#
#   target deploy   Foundry plus the compiled contracts and the deploy script (the local network).
#   target prover-sp1   The proof producer for a server: linux/amd64, feature sp1-native-gnark, the two SP1 guest ELFs.
#                       Build: docker build --platform linux/amd64 --target prover-sp1 -f docker/Dockerfile .
#                       Needs about 8 GB of memory to build. See docs/server-prover.md. Do not build it on the 2 GB VM.
#   target prover-gpu-worker   The proving worker for a GPU host (RunPod Serverless): linux/amd64, feature sp1-cuda, the two
#                       SP1 guest ELFs and the SP1 GPU server of the same release. It runs only on an NVIDIA GPU with
#                       about 24 GB of video memory. Build: docker build --platform linux/amd64 --target prover-gpu-worker
#                       -f docker/Dockerfile .  See docs/gpu-prover.md.
#
# The chains run from the Foundry image itself, so they need no target here.
#
# Every base image is pinned by an exact version tag and by digest. Each tag is older than 28 days at the cutoff of
# 2026-09-24. The Rust version is the one the repository builds with.
ARG FOUNDRY_IMAGE=ghcr.io/foundry-rs/foundry:v1.7.0@sha256:ff06299a789deee1d9e07d93961f08330820e2444a8dbbb425c1256bc3d1c206
ARG RUST_IMAGE=rust:1.93.0-slim-bookworm@sha256:776861219cd851131c1cec3bbd7cbeb16b99a794048097eb69ad9682a8ed0d57
ARG RUNTIME_IMAGE=debian:bookworm-20260316-slim@sha256:f06537653ac770703bc45b4b113475bd402f451e85223f0f2837acbf89ab020a
# The base of the GPU worker: CUDA 12.8.2 runtime on Ubuntu 24.04 (glibc 2.39, newer than the glibc 2.36 of the Rust
# build image, so the worker binary runs on it). The tag was pushed on 2026-04-30. The digest is the multi-platform index.
# The SP1 GPU server of release v6.8.1 links libcudart.so.12 and needs a host driver for CUDA 12.8 (version 570 or newer).
ARG CUDA_RUNTIME_IMAGE=nvidia/cuda:12.8.2-runtime-ubuntu24.04@sha256:7e62235c5d6f22a57ec8ba51f1583634fdbbf4b08a15b42dc1a60f086145c210

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
# The proof producer for a server (target prover-sp1). Platform linux/amd64.
#
# - Cargo features: sp1-native-gnark (SP1 prover on the local CPU; the Groth16 wrapper runs inside the process, so the
#   container needs no Docker socket). Without the signed beacon chain of the tests.
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
LABEL org.opencontainers.image.title="zk-bridge proof producer (SP1, local CPU)"
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
CMD ["--config", "/state/prover.toml", "prove"]

# ---------------------------------------------------------------------------------------------------------------
# The proving worker for a GPU host (target prover-gpu-worker). Platform linux/amd64.
#
# - Cargo features: sp1-cuda. The worker is a client of the SP1 GPU server. Building it needs no CUDA toolkit and no Go:
#   the Groth16 wrapper runs inside the GPU server binary, and the worker verifies the proof with Rust code only.
# - The SP1 GPU server is the binary of the release v6.8.1, pinned by SHA-256 (the digest that GitHub shows for the
#   release asset). The SDK looks for it at $HOME/.sp1/bin/sp1-gpu-server and checks that `--version` prints the SDK
#   version. When the file is there, the SDK downloads nothing at run time.
# - The ELFs come from the reproducible build, as for prover-sp1, and the same check compares them with
#   light-client/program-keys.json.
# - The worker listens on PORT (8000 here) and answers GET /ping for the health check. RunPod needs both variables on
#   the endpoint too (docs/gpu-prover.md).
# ---------------------------------------------------------------------------------------------------------------
FROM --platform=linux/amd64 ${RUST_IMAGE} AS build-gpu-worker
# protobuf-compiler and libprotobuf-dev: the build script of sp1-prover-types (pulled in by sp1-cuda) runs protoc,
# and its proto files import the standard google/protobuf types.
RUN apt-get update \
    && apt-get install -y --no-install-recommends build-essential clang libclang-dev ca-certificates protobuf-compiler libprotobuf-dev \
    && rm -rf /var/lib/apt/lists/*
WORKDIR /build
# Layer order, slowest to change first: toolchain and packages (above), then the dependency build, then the prover
# source. The cache mounts keep the cargo registry, the git dependencies and the target directory between builds on
# one builder, so a change in prover/src recompiles only the crate zk-bridge-prover. The light-client files that the
# prover compiles come first. The ELFs and program-keys.json are not copied here: the prover build does not read them.
COPY light-client/Cargo.toml light-client/Cargo.lock light-client/rust-toolchain.toml ./light-client/
COPY light-client/crates ./light-client/crates
COPY prover/Cargo.toml prover/Cargo.lock prover/rust-toolchain.toml ./prover/
WORKDIR /build/prover
# Dependency-only build: stub targets stand in for the prover source, so this layer depends on the manifests only.
# The examples and tests are named in Cargo.toml, so cargo needs a file for each, even though it does not build them.
RUN --mount=type=cache,id=zk-bridge-cargo-registry,target=/usr/local/cargo/registry \
    --mount=type=cache,id=zk-bridge-cargo-git,target=/usr/local/cargo/git \
    --mount=type=cache,id=zk-bridge-gpu-target,target=/build/prover/target \
    set -eu; \
    mkdir -p src/bin examples tests; \
    : > src/lib.rs; \
    echo 'fn main() {}' > src/main.rs; \
    echo 'fn main() {}' > src/bin/prove_worker.rs; \
    echo 'fn main() {}' > examples/live_update.rs; \
    for name in signed_beacon produce evidence checkpoint opening_proof; do : > "tests/${name}.rs"; done; \
    cargo build --release --locked --no-default-features --features sp1-cuda --bin prove-worker; \
    rm -rf src examples tests
COPY prover/src ./src
# Cargo compares file times. The files of the context can be older than the stub objects, so mark the source as new.
RUN --mount=type=cache,id=zk-bridge-cargo-registry,target=/usr/local/cargo/registry \
    --mount=type=cache,id=zk-bridge-cargo-git,target=/usr/local/cargo/git \
    --mount=type=cache,id=zk-bridge-gpu-target,target=/build/prover/target \
    set -eu; \
    mkdir -p examples tests; \
    echo 'fn main() {}' > examples/live_update.rs; \
    for name in signed_beacon produce evidence checkpoint opening_proof; do : > "tests/${name}.rs"; done; \
    find src -type f -exec touch {} +; \
    cargo build --release --locked --no-default-features --features sp1-cuda --bin prove-worker; \
    mkdir /out; \
    cp target/release/prove-worker /out/

# The Groth16 circuit files of SP1 circuit v6.1.0 (the circuit of sp1-sdk 6.8.1), baked into the image so a cold worker reads
# them from local disk instead of downloading 6.2 GB on its first proof. The tarball is pinned by SHA-256, and the build
# refuses it unless groth16_vk.bin hashes to VERIFIER_HASH of the pinned on-chain verifier (docs/sp1-version-policy.md).
FROM --platform=linux/amd64 ${RUNTIME_IMAGE} AS groth16-circuits
ARG SP1_CIRCUIT_VERSION=v6.1.0
ARG SP1_GROTH16_CIRCUITS_SHA256=18beebb6cd0cc9b4d4a240ee4f49511da6c2a7e51724bad4232de538a9147810
ARG SP1_VERIFIER_HASH=4388a21c687fdd5f218d7e3d13190cac4c5355818d3605fd5fb811df468ee696
ADD --checksum=sha256:${SP1_GROTH16_CIRCUITS_SHA256} \
    https://sp1-circuits.s3-us-east-2.amazonaws.com/${SP1_CIRCUIT_VERSION}-groth16.tar.gz \
    /tmp/groth16.tar.gz
RUN mkdir -p /circuits/groth16/${SP1_CIRCUIT_VERSION} \
    && tar -xzf /tmp/groth16.tar.gz -C /circuits/groth16/${SP1_CIRCUIT_VERSION} --exclude='._*' \
    && rm /tmp/groth16.tar.gz \
    && echo "${SP1_VERIFIER_HASH}  /circuits/groth16/${SP1_CIRCUIT_VERSION}/groth16_vk.bin" | sha256sum -c - \
    && touch /circuits/groth16/${SP1_CIRCUIT_VERSION}/.complete

FROM --platform=linux/amd64 ${CUDA_RUNTIME_IMAGE} AS prover-gpu-worker
ARG SP1_GPU_SERVER_VERSION=6.8.1
ARG SP1_GPU_SERVER_SHA256=1116d91fb36cbc0158112c78491ff665ae43ad1dbfb95c66bea0c9d530e81ec3
LABEL org.opencontainers.image.title="zk-bridge proving worker (SP1, NVIDIA GPU)"
ADD --checksum=sha256:${SP1_GPU_SERVER_SHA256} \
    https://github.com/succinctlabs/sp1/releases/download/v${SP1_GPU_SERVER_VERSION}/sp1_gpu_server_v${SP1_GPU_SERVER_VERSION}_x86_64.tar.gz \
    /tmp/sp1-gpu-server.tar.gz
RUN apt-get update \
    && apt-get install -y --no-install-recommends ca-certificates libstdc++6 \
    && rm -rf /var/lib/apt/lists/* \
    && useradd --uid 10001 --create-home --home-dir /home/bridge --shell /usr/sbin/nologin bridge \
    && mkdir -p /home/bridge/.sp1/bin /state /elf \
    && tar -xzf /tmp/sp1-gpu-server.tar.gz -C /home/bridge/.sp1/bin \
    && rm /tmp/sp1-gpu-server.tar.gz \
    && chown -R bridge:bridge /home/bridge /state
# Layer order: the circuit files (6 GB, almost never change), then the worker binary, then the ELFs, which change most often.
COPY --from=groth16-circuits /circuits /opt/sp1-circuits
COPY --from=build-gpu-worker /out/prove-worker /usr/local/bin/
COPY --from=check-elfs /check/light-client.elf /check/fork-observation.elf /elf/
ENV HOME=/home/bridge \
    SP1_GROTH16_CIRCUIT_PATH=/opt/sp1-circuits/groth16 \
    PORT=8000 \
    PORT_HEALTH=8000 \
    ZK_BRIDGE_WORKER_LIGHT_CLIENT_ELF=/elf/light-client.elf \
    ZK_BRIDGE_WORKER_OBSERVATION_ELF=/elf/fork-observation.elf
EXPOSE 8000
USER bridge
WORKDIR /state
ENTRYPOINT ["prove-worker"]
