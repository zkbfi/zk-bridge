#!/bin/sh
# Runs one prover command with the configuration that the deploy step wrote.
#
#   prover-entry run            loop (the service)
#   prover-entry status         print every deposit and its state
#   prover-entry route-health   ask each route whether it can still deliver (reads the beacon stub)
#   prover-entry once           one pass, then exit
#
# It waits until the deploy step has written the configuration, so `up` may come before `run deploy`.
set -eu

command="${1:-run}"
if [ "$#" -gt 0 ]; then shift; fi

config=/state/prover.toml
if [ "$command" = "route-health" ]; then
  config=/state/route-health.toml
fi

told=no
while [ ! -f "$config" ]; do
  if [ "$told" = no ]; then
    echo "waiting for $config: run the deploy step" >&2
    told=yes
  fi
  sleep 2
done

exec zk-bridge-prover --config "$config" "$command" "$@"
