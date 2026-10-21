# Images of the local network. The build context is the repository root (see docker/compose.yaml).
#
#   target deploy   Foundry plus the compiled contracts and the deploy script.
#   target prover   The prover service, the bots and the beacon stub, on a small Debian base.
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
