#!/usr/bin/env bash
# Installs (or removes) the daily pull of the proof archive on this Mac.
#
#   deploy/operator/install-proofs-pull.sh              # install and load the launchd agent
#   deploy/operator/install-proofs-pull.sh --uninstall  # unload and remove the agent and the installed script
#   deploy/operator/install-proofs-pull.sh --render     # print the plist, change nothing
#
# It copies pull-proofs.sh to ~/.local/share/zkb-proofs-pull/ (launchd agents are not allowed to read ~/Documents
# without a privacy grant, and this repository may live there), renders fi.zkb.proofs-pull.plist.template into
# ~/Library/LaunchAgents and loads it with `launchctl bootstrap gui/<uid>`. Each day the agent pulls the server's private
# proof mirror into ~/zkb-backups/proofs/mirror (records only ever added; beacon states, snapshots and manifests follow
# the server's 30 day window) and checks it against the newest manifest; see pull-proofs.sh. Expect about 4.6 GB on
# testnet (30 days of beacon states, all proofs) and about double that on mainnet. The first pull copies the whole
# window; later ones copy a day. The bundles of the old format (zk-bridge-proofs-*.tar.gz) that earlier versions left in
# ~/zkb-backups/proofs stay where they are; nothing deletes them or makes new ones.
# The run time is 04:45 UTC (the server exports at 03:30 UTC plus up to 20 minutes of delay; a pull that meets a running
# export waits for it) in the local time zone; ZKB_PULL_AT=HH:MM sets another local time. Run the installer again after a
# daylight saving change. Run once by hand to try:
#   launchctl kickstart gui/$(id -u)/fi.zkb.proofs-pull
# The node and the rsync found now are written into the agent (launchd's PATH is short; a newer rsync from Homebrew is
# preferred over the system's).
# Settings: ZKB_PULL_AT, ZKB_PULL_LOCAL_DIR, ZKB_PULL_INSTALL_DIR, ZKB_PULL_AGENT_DIR, ZKB_PULL_NO_LOAD=1 (tests).
set -euo pipefail

LABEL=fi.zkb.proofs-pull
HERE=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
INSTALL_DIR=${ZKB_PULL_INSTALL_DIR:-$HOME/.local/share/zkb-proofs-pull}
AGENT_DIR=${ZKB_PULL_AGENT_DIR:-$HOME/Library/LaunchAgents}
LOCAL_DIR=${ZKB_PULL_LOCAL_DIR:-$HOME/zkb-backups/proofs}
PLIST=$AGENT_DIR/$LABEL.plist

log() { printf 'install-proofs-pull: %s\n' "$*" >&2; }

# The local clock time of 04:45 UTC today.
local_time() {
  if [ -n "${ZKB_PULL_AT:-}" ]; then printf '%s' "$ZKB_PULL_AT"; return; fi
  date -j -f '%Y-%m-%d %H:%M:%S %z' "$(date -u +%Y-%m-%d) 04:45:00 +0000" +%H:%M 2>/dev/null || printf '06:45'
}

# esc <value>: for the replacement side of sed.
esc() { printf '%s' "$1" | sed -e 's/[\\&|]/\\&/g'; }

render() {
  local at hour minute node rsync
  at=$(local_time)
  case $at in [0-2][0-9]:[0-5][0-9]) ;; *) log "ZKB_PULL_AT must be HH:MM"; exit 2 ;; esac
  hour=$((10#${at%%:*}))
  minute=$((10#${at##*:}))
  node=$(command -v node 2>/dev/null || true)
  rsync=$(command -v rsync 2>/dev/null || true)
  sed -e "s|@SCRIPT@|$(esc "$INSTALL_DIR/pull-proofs.sh")|g" \
    -e "s|@HOME@|$(esc "$HOME")|g" \
    -e "s|@NODE@|$(esc "$node")|g" \
    -e "s|@RSYNC@|$(esc "$rsync")|g" \
    -e "s|@LOCAL_DIR@|$(esc "$LOCAL_DIR")|g" \
    -e "s|@HOUR@|$hour|g" -e "s|@MINUTE@|$minute|g" \
    "$HERE/$LABEL.plist.template"
}

main() {
  exec </dev/null
  local uid
  uid=$(id -u)
  case ${1:-install} in
    --render) render ;;
    --uninstall)
      [ -n "${ZKB_PULL_NO_LOAD:-}" ] || launchctl bootout "gui/$uid/$LABEL" 2>/dev/null || true
      rm -f "$PLIST"
      rm -rf "$INSTALL_DIR"
      log "removed $LABEL (the mirror and the old bundles in $LOCAL_DIR stay)"
      ;;
    install)
      mkdir -p "$AGENT_DIR" "$INSTALL_DIR" "$LOCAL_DIR"
      install -m 0755 "$HERE/pull-proofs.sh" "$INSTALL_DIR/pull-proofs.sh"
      render >"$PLIST.new"
      mv "$PLIST.new" "$PLIST"
      chmod 0644 "$PLIST"
      if command -v plutil >/dev/null 2>&1; then plutil -lint "$PLIST" >/dev/null || { log "the rendered plist is invalid"; exit 1; }; fi
      if [ -z "${ZKB_PULL_NO_LOAD:-}" ]; then
        launchctl bootout "gui/$uid/$LABEL" 2>/dev/null || true
        launchctl bootstrap "gui/$uid" "$PLIST"
      fi
      log "installed $LABEL: daily at $(local_time) local time, the mirror in $LOCAL_DIR/mirror"
      ;;
    *) log "usage: install-proofs-pull.sh [--uninstall | --render]"; exit 2 ;;
  esac
}

main "$@"
