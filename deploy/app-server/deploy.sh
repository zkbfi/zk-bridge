#!/usr/bin/env bash
# Deploys one commit of the repository to the zkb.fi app server (docs/deployment-plan.md). Run it as root on the
# server, after provision.sh. It is safe to run again: a release that is already built is only switched to.
#
#   ssh zkbfi-app 'bash -s' -- <git-ref> [<repo-url>] < deploy/app-server/deploy.sh
#
# <git-ref> is a branch, a tag or a full commit hash. <repo-url> defaults to ZKB_REPO_URL, else the public repository.
#
# Steps:
#   1. Fetch the commit into a bare copy of the repository at /opt/zk-bridge/repo.git.
#   2. Unpack it into /opt/zk-bridge/releases/<commit>.
#   3. Install the Node.js packages of explorer/ (pnpm through corepack, frozen lockfile).
#   4. Build the prover for this machine (no default features: no sp1, no test beacon) into <release>/bin.
#   5. Point /opt/zk-bridge/current at the release, in one rename.
#   6. Install the systemd units of the release and the directories that the services write.
#   7. Restart each service whose configuration exists. A service without its files is skipped, with a log line.
#   8. Remove old releases.
#
# It writes no configuration and no secret. Those go into /etc/zk-bridge by hand (config/*.example).
set -euo pipefail

log() { printf 'deploy: %s\n' "$*" >&2; }

[ "$(id -u)" -eq 0 ] || { log "run as root"; exit 1; }

BASE=/opt/zk-bridge
REPO_DIR=$BASE/repo.git
RELEASES=$BASE/releases
CURRENT=$BASE/current
PROVER_TARGET=$BASE/build/prover-target
KEEP_RELEASES=5
RUST_HOME=/opt/rust
ETC=/etc/zk-bridge
UNIT_DIR=/etc/systemd/system
DEFAULT_REPO_URL=https://github.com/zkbfi/zk-bridge.git

# The services in start order: the indexer first, because the others read it.
SERVICES=(indexer backend publisher runner)

# The files a service needs before it may start, relative to /etc/zk-bridge.
required_files() {
  case $1 in
    backend) echo backend/backend.json backend/backend.env deployment.json ;;
    indexer) echo indexer/indexer.env deployment.json ;;
    publisher) echo publisher/bots.json publisher/prover-setup.json publisher/bots.env deployment.json ;;
    runner) echo runner/bots.json runner/prover-setup.json runner/bots.env runner/runner.env deployment.json ;;
  esac
}

# The system user of a service; its configuration directory belongs to that user's group.
service_user() {
  case $1 in
    backend) echo zkb_backend ;;
    indexer) echo zkb_indexer ;;
    publisher) echo zkb_publisher ;;
    runner) echo zkb_runner ;;
  esac
}

# Everything runs inside main: when the script comes in on standard input (bash -s), bash has read all of it before
# the first command runs, so no command can swallow the rest of the script.
main() {
  exec </dev/null
  umask 022

  local ref=${1:-} repo_url=${2:-${ZKB_REPO_URL:-$DEFAULT_REPO_URL}}
  [ -n "$ref" ] || { log "usage: deploy.sh <git-ref> [<repo-url>]"; exit 1; }
  if [ ! -d "$BASE" ] || ! id zkb_backend >/dev/null 2>&1; then log "run provision.sh first"; exit 1; fi

  # One deploy at a time.
  exec 9>/run/zk-bridge-deploy.lock
  flock -n 9 || { log "another deploy is running"; exit 1; }

  # --- 1. Fetch -------------------------------------------------------------------------------------------------
  log "fetch $ref from $repo_url"
  [ -d "$REPO_DIR" ] || git init -q --bare "$REPO_DIR"
  git -C "$REPO_DIR" fetch -q --force "$repo_url" "$ref"
  local commit
  commit=$(git -C "$REPO_DIR" rev-parse --verify 'FETCH_HEAD^{commit}')
  local release=$RELEASES/$commit
  log "commit $commit"

  if [ -f "$release/.complete" ]; then
    log "release $commit is already built"
  else
    # --- 2. Unpack ----------------------------------------------------------------------------------------------
    # A release without the marker is what an earlier run left half done. Start it again.
    rm -rf "$release"
    install -d -m 0755 "$RELEASES" "$release"
    git -C "$REPO_DIR" archive "$commit" | tar -x -C "$release"

    # --- 3. Node.js packages ------------------------------------------------------------------------------------
    log "pnpm install"
    (cd "$release/explorer" && COREPACK_ENABLE_DOWNLOAD_PROMPT=0 corepack pnpm install --frozen-lockfile)
    # Ponder writes these at start, into its project folder. The release stays read-only, so they point into the
    # state directory of the indexer, which its unit may write.
    local indexer_dir=$release/explorer/indexer
    rm -rf "$indexer_dir/.ponder" "$indexer_dir/generated" "$indexer_dir/ponder-env.d.ts"
    ln -s /var/lib/zk-bridge-indexer/ponder "$indexer_dir/.ponder"
    ln -s /var/lib/zk-bridge-indexer/generated "$indexer_dir/generated"
    ln -s /var/lib/zk-bridge-indexer/ponder-env.d.ts "$indexer_dir/ponder-env.d.ts"

    # --- 4. Prover ----------------------------------------------------------------------------------------------
    # The production build: no default features, so no test beacon and no sp1 (that runs only in the RunPod image).
    # The target directory lives outside the release, so the next deploy builds only what changed.
    log "build the prover"
    local toolchain
    toolchain=$(sed -n 's/^channel = "\(.*\)"$/\1/p' "$release/prover/rust-toolchain.toml")
    [ -n "$toolchain" ] || { log "no channel in prover/rust-toolchain.toml"; exit 1; }
    (
      export RUSTUP_HOME=$RUST_HOME/rustup CARGO_HOME=$RUST_HOME/cargo
      export PATH=$CARGO_HOME/bin:$PATH CARGO_TARGET_DIR=$PROVER_TARGET
      rustup toolchain install "$toolchain" --profile minimal --component clippy --component rustfmt >/dev/null
      cd "$release/prover"
      cargo build --release --locked --no-default-features --bin zk-bridge-prover
    )
    install -d -m 0755 "$release/bin"
    install -m 0755 "$PROVER_TARGET/release/zk-bridge-prover" "$release/bin/zk-bridge-prover"
    "$release/bin/zk-bridge-prover" --help >/dev/null

    # The indexer's database schema. Ponder refuses to start on a schema that another build of the indexer used, so
    # each build of it gets its own: a hash of the indexer, the shared code and the lockfile. A deploy that changes
    # none of them keeps the schema and the indexed data.
    local schema_hash
    schema_hash=$(git -C "$REPO_DIR" rev-parse "$commit:explorer/indexer" "$commit:explorer/shared" \
      "$commit:explorer/pnpm-lock.yaml" | sha256sum | cut -c1-12)
    printf 'ZKB_RELEASE=%s\nDATABASE_SCHEMA=indexer_%s\n' "$commit" "$schema_hash" > "$release/release.env"

    touch "$release/.complete"
  fi

  # ZKB_BUILD_ONLY=1 stops here, so a new indexer schema can be filled on a spare port before the switch.
  if [ "${ZKB_BUILD_ONLY:-}" = 1 ]; then log "built $release, not switched"; exit 0; fi

  # --- 5. Switch ------------------------------------------------------------------------------------------------
  local previous=none
  [ ! -L "$CURRENT" ] || previous=$(basename "$(readlink "$CURRENT")")
  # The time of the release folder says when it was last in use; step 8 keeps the newest.
  touch "$release"
  ln -sfn "$release" "$CURRENT.new"
  mv -T "$CURRENT.new" "$CURRENT"
  log "current: $commit (was $previous)"

  # --- 6. Units and directories ---------------------------------------------------------------------------------
  log "systemd units"
  local service
  for service in "${SERVICES[@]}"; do
    install -m 0644 "$CURRENT/deploy/app-server/zk-bridge-$service.service" "$UNIT_DIR/"
  done
  systemctl daemon-reload

  # The indexer's user owns its state directory and could plant links in it, so root does no file work there: the
  # indexer's user makes its directories and clears the Vite cache, which belongs to one build of the indexer.
  runuser -u zkb_indexer -- sh -c 'cd /var/lib/zk-bridge-indexer && mkdir -p -m 0700 ponder generated && rm -rf ponder/vite'

  # Configuration: readable by the service's group only. The deployment file holds no secret.
  for service in "${SERVICES[@]}"; do
    local user dir
    user=$(service_user "$service")
    dir=$ETC/${user#zkb_}
    find "$dir" -maxdepth 1 -type f -exec chown root:"$user" {} + -exec chmod 0640 {} +
  done
  [ ! -f "$ETC/deployment.json" ] || { chown root:root "$ETC/deployment.json"; chmod 0644 "$ETC/deployment.json"; }

  # --- 7. Restart -----------------------------------------------------------------------------------------------
  local started=() file missing
  for service in "${SERVICES[@]}"; do
    missing=
    for file in $(required_files "$service"); do
      [ -f "$ETC/$file" ] || { missing=$ETC/$file; break; }
    done
    if [ -n "$missing" ]; then
      log "skip $service: $missing is missing (see deploy/app-server/config/)"
      continue
    fi
    log "restart $service"
    systemctl enable -q "zk-bridge-$service.service"
    systemctl restart "zk-bridge-$service.service"
    started+=("$service")
  done

  # A service that exits at once (a bad setting, a missing secret) is restarting or failed by now.
  local failed=()
  if [ ${#started[@]} -gt 0 ]; then
    sleep 10
    for service in "${started[@]}"; do
      systemctl is-active -q "zk-bridge-$service.service" || failed+=("$service")
    done
  fi

  # --- 8. Old releases ------------------------------------------------------------------------------------------
  local old
  find "$RELEASES" -mindepth 1 -maxdepth 1 -type d -printf '%T@ %p\n' | sort -rn | tail -n +$((KEEP_RELEASES + 1)) \
    | cut -d' ' -f2- | while read -r old; do
      [ "$old" = "$release" ] || { log "remove old release $(basename "$old")"; rm -rf "$old"; }
    done

  if [ ${#failed[@]} -gt 0 ]; then
    log "not running: ${failed[*]}. See journalctl -u zk-bridge-<name>. To go back: deploy.sh $previous"
    exit 1
  fi
  log "done: $commit, running: ${started[*]:-none}"
}

main "$@"
