#!/usr/bin/env bash
# Writes the memory of a systemd unit to a file every two seconds, one line `seconds current_bytes anonymous_bytes` each.
# `current_bytes` is `MemoryCurrent`: it counts the page cache of the circuit files too. `anonymous_bytes` is the memory of
# the processes themselves (the `anon` line of the cgroup `memory.stat`), or 0 while the unit does not exist.
# Arguments: unit name (for example zk-bridge-e2e-prover.scope), output file.
set -euo pipefail
unit="$1"
output="$2"
while true; do
  current="$(systemctl --user show "$unit" --property MemoryCurrent --value 2> /dev/null || true)"
  group="$(systemctl --user show "$unit" --property ControlGroup --value 2> /dev/null || true)"
  anonymous=0
  if [ -n "$group" ] && [ -r "/sys/fs/cgroup$group/memory.stat" ]; then
    anonymous="$(awk '$1 == "anon" {print $2}' "/sys/fs/cgroup$group/memory.stat")"
  fi
  case "$current" in '' | *[!0-9]*) current=0 ;; esac
  printf '%s %s %s\n' "$(date +%s)" "$current" "${anonymous:-0}" >> "$output"
  sleep 2
done
