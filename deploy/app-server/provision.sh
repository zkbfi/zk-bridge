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
#   7. An IPFS node (kubo) that pins the release archives. Its RPC API listens on 127.0.0.1:5001 only, and it runs no
#      HTTP gateway. Peers reach it on port 4001 (TCP and UDP), which the cloud firewall must allow.
#
# It installs no secret, and no service of ours except the IPFS node. The others come with the deploy step. The token
# of the IPFS API is set with zkb-ipfs-api-token, which this script installs. The token travels on standard input only:
#
#   op read op://zkb.fi/kubo/credential | ssh zkbfi-app zkb-ipfs-api-token
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
KUBO_VERSION=v0.43.1
IPFS_PATH=/var/lib/zk-bridge-ipfs/repo

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

# --- 7. IPFS node -----------------------------------------------------------------------------------------------
log "ipfs (kubo $KUBO_VERSION)"
ensure_user zkb_ipfs /var/lib/zk-bridge-ipfs
install -d -m 0750 -o root -g zkb_ipfs /etc/zk-bridge/ipfs
if [ "$(/usr/local/bin/ipfs version --number 2>/dev/null || true)" != "${KUBO_VERSION#v}" ]; then
  arch=$(dpkg --print-architecture)
  archive="kubo_${KUBO_VERSION}_linux-${arch}.tar.gz"
  work=$(mktemp -d)
  curl -fsSL -o "$work/$archive" "https://github.com/ipfs/kubo/releases/download/$KUBO_VERSION/$archive"
  curl -fsSL -o "$work/$archive.sha512" "https://github.com/ipfs/kubo/releases/download/$KUBO_VERSION/$archive.sha512"
  (cd "$work" && sha512sum -c "$archive.sha512" >/dev/null) || { log "kubo archive fails its checksum"; exit 1; }
  tar -xzf "$work/$archive" -C "$work"
  install -m 0755 "$work/kubo/ipfs" /usr/local/bin/ipfs
  rm -rf "$work"
fi
ipfs_as() { runuser -u zkb_ipfs -- env IPFS_PATH="$IPFS_PATH" /usr/local/bin/ipfs "$@"; }
# The server profile turns off local network discovery, which a public host must not do.
[ -f "$IPFS_PATH/config" ] || ipfs_as init --profile server >/dev/null
ipfs_as config Addresses.API /ip4/127.0.0.1/tcp/5001
# No gateway: an open gateway serves anyone's content from this address.
ipfs_as config --json Addresses.Gateway '[]'
ipfs_as config Datastore.StorageMax 20GB
ipfs_as config Swarm.ResourceMgr.MaxMemory 1GB
# Announce only what is pinned here: the release archives.
ipfs_as config Provide.Strategy pinned
# The unit is written here and not by deploy.sh: the node holds the pins and does not change with a release.
cat > /etc/systemd/system/zk-bridge-ipfs.service <<EOF
# The IPFS node (kubo) that pins the release archives. provision.sh writes this file. RPC API on 127.0.0.1:5001 only,
# no gateway, peers on port 4001. The API token is in $IPFS_PATH/config (zkb-ipfs-api-token).
[Unit]
Description=zk-bridge IPFS node (kubo)
Wants=network-online.target
After=network-online.target
StartLimitIntervalSec=300
StartLimitBurst=5

[Service]
Type=notify
User=zkb_ipfs
Group=zkb_ipfs
Environment=IPFS_PATH=$IPFS_PATH
ExecStart=/usr/local/bin/ipfs daemon --migrate=false
Restart=on-failure
RestartSec=10
TimeoutStopSec=60
MemoryMax=1536M

# Sandbox. Writable: the repository only.
ReadWritePaths=/var/lib/zk-bridge-ipfs
NoNewPrivileges=yes
ProtectSystem=strict
ProtectHome=yes
PrivateTmp=yes
PrivateDevices=yes
ProtectKernelTunables=yes
ProtectKernelModules=yes
ProtectKernelLogs=yes
ProtectControlGroups=yes
ProtectClock=yes
ProtectHostname=yes
ProtectProc=invisible
RestrictAddressFamilies=AF_UNIX AF_INET AF_INET6 AF_NETLINK
RestrictNamespaces=yes
RestrictRealtime=yes
RestrictSUIDSGID=yes
LockPersonality=yes
MemoryDenyWriteExecute=yes
SystemCallArchitectures=native
SystemCallFilter=@system-service
SystemCallErrorNumber=EPERM
CapabilityBoundingSet=
AmbientCapabilities=
UMask=0077

[Install]
WantedBy=multi-user.target
EOF
# Reads the API token on standard input, so it never shows in a process list, and lets only that bearer token call
# the API. Without a token the API answers anyone on 127.0.0.1.
cat > /usr/local/sbin/zkb-ipfs-api-token <<EOF
#!/usr/bin/env bash
set -euo pipefail
[ "\$(id -u)" -eq 0 ] || { echo "run as root" >&2; exit 1; }
IFS= read -r token || [ -n "\$token" ]
[ "\${#token}" -ge 32 ] || { echo "the token on standard input is shorter than 32 characters" >&2; exit 1; }
config=$IPFS_PATH/config
runuser -u zkb_ipfs -- sh -c 'umask 077; jq --rawfile t /dev/stdin '"'"'.API.Authorizations = {operator: {AuthSecret: ("bearer:" + (\$t | rtrimstr("\n"))), AllowedPaths: ["/api/v0"]}}'"'"' "\$1" > "\$1.new" && mv "\$1.new" "\$1"' sh "\$config" <<<"\$token"
systemctl restart zk-bridge-ipfs.service
echo "the IPFS API now takes only the new token"
EOF
chmod 0750 /usr/local/sbin/zkb-ipfs-api-token
systemctl daemon-reload
systemctl enable --now zk-bridge-ipfs.service
systemctl restart zk-bridge-ipfs.service

log "done: node $(node --version), $(RUSTUP_HOME=$RUSTUP_HOME "$CARGO_HOME/bin/rustc" --version), $(psql --version)"
