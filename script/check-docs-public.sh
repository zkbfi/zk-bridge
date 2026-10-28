#!/usr/bin/env bash
# Gate: every page that may be published holds nothing private.
# Scans the docs, the web documentation pages and the readmes. Prints file and line for each
# match and exits 1. A match is one of: an email address, a home directory path, the name of a
# private machine or account, a RunPod endpoint identifier, a key-shaped string, a key inside a
# valve.city address, or a one-time identifier that the owner listed.
set -euo pipefail

cd "$(git rev-parse --show-toplevel)"

# Planning notes in docs/superpowers describe these patterns, so they are not scanned.
scanned_paths=(docs explorer/web/docs/pages README.md 'explorer/*/README.md' ':!docs/superpowers')

patterns=(
  # email address
  '[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+\.(com|net|org|io|xyz|city|dev|app|me)\b'
  # home directory path
  '/Users/[A-Za-z]'
  '/home/[A-Za-z]'
  # private machine and account names
  '\b[private]\b'
  'hexpayday'
  '[private]'
  # RunPod endpoint identifier before the proxy domain
  '[a-z0-9]{10,}\.api\.runpod\.ai'
  # key-shaped strings: valve.city key, RunPod key, GitHub token, secret key, cloud access key
  'vk_[A-Za-z0-9_-]{8,}'
  'rpa_[A-Za-z0-9]{8,}'
  'gh[pousr]_[A-Za-z0-9]{20,}'
  'sk-[A-Za-z0-9]{20,}'
  'AKIA[A-Z0-9]{12,}'
  'BEGIN [A-Z ]*PRIVATE KEY'
  # a literal key in a valve.city address (a placeholder starts with $ or <)
  'valve\.city/(rpc|beacon)/[A-Za-z0-9_-]{12,}'
  # one-time identifiers
  'ghcr\.io/[a-z0-9-]+/zk-bridge'
)

status=0
for pattern in "${patterns[@]}"; do
  if git grep -n -I -E -e "$pattern" -- "${scanned_paths[@]}"; then
    status=1
  fi
done

if [ "$status" -ne 0 ]; then
  echo "check-docs-public: the lines above hold something private." >&2
fi
exit "$status"
