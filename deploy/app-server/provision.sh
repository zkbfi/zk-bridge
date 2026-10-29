#!/usr/bin/env bash
# Prepares the zkb.fi app server (docs/deployment-plan.md) for the services. Run it as root on the server. It is safe to
# run again: every step checks what is already there.
#
#   ssh zkbfi-app 'bash -s' < deploy/app-server/provision.sh
#
# Steps:
#   1. Base system: time zone, swap, journal size, packages (libudev-dev: node-hid and usb build from source on ARM64).
#   2. Node.js 24 from the NodeSource apt repository, and pnpm through corepack.
#   3. Rust 1.93.0 (prover/rust-toolchain.toml) in /opt/rust, to build the prover for this machine (ARM64).
#   4. One system user per service. The publisher and the runner are separate users, so only the runner can read the
#      wallet key, in its file or in its process environment.
#   5. Postgres for the explorer indexer: local socket only, peer login for the indexer's user.
#   6. Caddy as the TLS proxy. Until the backend has a host name it answers 503 on port 80.
#
# It installs no service of ours and no secret. Those come with the deploy step.
set -euo pipefail

log() { printf 'provision: %s\n' "$*" >&2; }

[ "$(id -u)" -eq 0 ] || { log "run as root"; exit 1; }
. /etc/os-release
[ "$ID" = ubuntu ] && [ "$VERSION_ID" = 24.04 ] || { log "expects Ubuntu 24.04, found $PRETTY_NAME"; exit 1; }

export DEBIAN_FRONTEND=noninteractive

NODE_MAJOR=24
RUST_TOOLCHAIN=1.93.0
RUST_HOME=/opt/rust
SWAP_FILE=/swapfile
SWAP_SIZE=2G

# --- 1. Base system ---------------------------------------------------------------------------------------------
log "base system"
timedatectl set-timezone UTC

if ! swapon --show=NAME --noheadings | grep -qx "$SWAP_FILE"; then
  [ -f "$SWAP_FILE" ] || { fallocate -l "$SWAP_SIZE" "$SWAP_FILE"; chmod 600 "$SWAP_FILE"; mkswap "$SWAP_FILE" >/dev/null; }
  swapon "$SWAP_FILE"
fi
grep -q "^$SWAP_FILE " /etc/fstab || echo "$SWAP_FILE none swap sw 0 0" >> /etc/fstab
# Swap only under real pressure: Postgres and the indexer should stay in memory.
echo 'vm.swappiness=10' > /etc/sysctl.d/90-zkbfi.conf
sysctl -q --system

mkdir -p /etc/systemd/journald.conf.d
printf '[Journal]\nSystemMaxUse=1G\n' > /etc/systemd/journald.conf.d/90-zkbfi.conf
systemctl restart systemd-journald

apt-get update -q
apt-get install -y -q --no-install-recommends \
  ca-certificates curl gnupg git jq sqlite3 \
  build-essential pkg-config libudev-dev \
  postgresql caddy \
  unattended-upgrades

# --- 2. Node.js -------------------------------------------------------------------------------------------------
log "node.js $NODE_MAJOR"
NODE_KEYRING=/usr/share/keyrings/nodesource.gpg
if [ ! -f "$NODE_KEYRING" ]; then
  curl -fsSL https://deb.nodesource.com/gpgkey/nodesource-repo.gpg.key | gpg --dearmor -o "$NODE_KEYRING"
fi
echo "deb [signed-by=$NODE_KEYRING] https://deb.nodesource.com/node_$NODE_MAJOR.x nodistro main" \
  > /etc/apt/sources.list.d/nodesource.list
# Prefer NodeSource over the older nodejs of Ubuntu.
printf 'Package: nodejs\nPin: origin deb.nodesource.com\nPin-Priority: 600\n' > /etc/apt/preferences.d/nodesource
apt-get update -q
apt-get install -y -q nodejs
node --version | grep -q "^v$NODE_MAJOR\." || { log "node is $(node --version), expected $NODE_MAJOR"; exit 1; }
# pnpm comes from corepack, at the version in explorer/package.json (packageManager), when the deploy step runs it.
corepack enable

# --- 3. Rust ----------------------------------------------------------------------------------------------------
log "rust $RUST_TOOLCHAIN"
export RUSTUP_HOME="$RUST_HOME/rustup" CARGO_HOME="$RUST_HOME/cargo"
if [ ! -x "$CARGO_HOME/bin/rustup" ]; then
  curl -fsSL --proto '=https' --tlsv1.2 https://sh.rustup.rs \
    | sh -s -- -y --no-modify-path --profile minimal --default-toolchain "$RUST_TOOLCHAIN"
fi
"$CARGO_HOME/bin/rustup" toolchain install "$RUST_TOOLCHAIN" --profile minimal
cat > /etc/profile.d/rust.sh <<EOF
export RUSTUP_HOME=$RUSTUP_HOME
export CARGO_HOME=$CARGO_HOME
export PATH=$CARGO_HOME/bin:\$PATH
EOF

# --- 4. Service users and directories ---------------------------------------------------------------------------
# Underscores, not hyphens: Postgres peer login needs the role name to equal the system user name.
log "service users"
ensure_user() {
  local user=$1 home=$2
  id "$user" >/dev/null 2>&1 || useradd --system --home-dir "$home" --no-create-home --shell /usr/sbin/nologin "$user"
  install -d -m 0700 -o "$user" -g "$user" "$home"
}
ensure_user zkb_backend /var/lib/zk-bridge-backend
ensure_user zkb_indexer /var/lib/zk-bridge-indexer
ensure_user zkb_publisher /var/lib/zk-bridge-publisher
ensure_user zkb_runner /var/lib/zk-bridge-runner

# Code: owned by root, readable by the services, written only by the deploy step.
install -d -m 0755 -o root -g root /opt/zk-bridge
# Configuration and secrets: one directory per service, readable by that service only.
install -d -m 0755 -o root -g root /etc/zk-bridge
install -d -m 0750 -o root -g zkb_backend /etc/zk-bridge/backend
install -d -m 0750 -o root -g zkb_indexer /etc/zk-bridge/indexer
install -d -m 0750 -o root -g zkb_publisher /etc/zk-bridge/publisher
install -d -m 0750 -o root -g zkb_runner /etc/zk-bridge/runner

# Before 2026-10-29 both bots shared the user zkb_bots. Remove it while it holds nothing; refuse to guess otherwise.
if id zkb_bots >/dev/null 2>&1; then
  if [ -n "$(find /etc/zk-bridge/bots /var/lib/zk-bridge-bots -mindepth 1 -print -quit 2>/dev/null)" ]; then
    log "zkb_bots still has files in /etc/zk-bridge/bots or /var/lib/zk-bridge-bots: move them to publisher/ or runner/ first"
    exit 1
  fi
  rmdir /etc/zk-bridge/bots /var/lib/zk-bridge-bots 2>/dev/null || true
  userdel zkb_bots
fi

# --- 5. Postgres ------------------------------------------------------------------------------------------------
log "postgres"
PG_CONF_DIR=$(find /etc/postgresql -mindepth 2 -maxdepth 2 -type d -name main | head -1)
[ -n "$PG_CONF_DIR" ] || { log "no postgres cluster found"; exit 1; }
# Local socket only: no TCP listener at all. Sizes for 8 GB shared with the indexer and the bots.
cat > "$PG_CONF_DIR/conf.d/90-zkbfi.conf" <<'EOF'
listen_addresses = ''
shared_buffers = 1GB
effective_cache_size = 4GB
work_mem = 16MB
maintenance_work_mem = 256MB
EOF
systemctl restart postgresql
sudo -u postgres psql -qtAc "SELECT 1 FROM pg_roles WHERE rolname = 'zkb_indexer'" | grep -q 1 \
  || sudo -u postgres createuser zkb_indexer
sudo -u postgres psql -qtAc "SELECT 1 FROM pg_database WHERE datname = 'zkb_indexer'" | grep -q 1 \
  || sudo -u postgres createdb --owner zkb_indexer zkb_indexer

# --- 6. Caddy ---------------------------------------------------------------------------------------------------
log "caddy"
# Until the backend has a host name: answer 503 on port 80. With a host name, the Caddyfile becomes
#   api.example { reverse_proxy 127.0.0.1:8787 }
# and Caddy gets its certificate itself. The backend then trusts one proxy hop (trustedProxyHops).
# Ubuntu's default Caddyfile names reverse_proxy in a comment, so only a line that is not a comment counts.
if ! grep -qE '^[[:space:]]*reverse_proxy' /etc/caddy/Caddyfile; then
  cat > /etc/caddy/Caddyfile <<'EOF'
:80 {
	respond "zkb.fi backend: not configured yet" 503
}
EOF
fi
systemctl reload-or-restart caddy

log "done: node $(node --version), $(RUSTUP_HOME=$RUSTUP_HOME "$CARGO_HOME/bin/rustc" --version), $(psql --version)"
