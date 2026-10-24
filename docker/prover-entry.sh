#!/bin/sh
# Runs one prover command with the configuration that the deploy step wrote.
#
#   prover-entry run            loop (the service)
#   prover-entry status         print every deposit and its state
#   prover-entry route-health   ask each route whether it can still deliver (reads the beacon stub)
#   prover-entry once           one pass, then exit
#   prover-entry follow         store light client heads and try to open the vaults once (exit code 2: a vault is still locked)
#   prover-entry open           run `follow` again and again until both vaults are open, then exit (a new vault is locked)
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

# A new vault refuses every deposit until a proof shows that the light client on the other chain stored a head. The reverse
# route needs a block that finalized after the first update, so the second run of `follow` opens both vaults. The chains
# mine one block every 2 seconds, so a pause of a few blocks between the runs is enough.
if [ "$command" = "open" ]; then
  tries=0
  until zk-bridge-prover --config "$config" follow "$@"; do
    code=$?
    if [ "$code" -ne 2 ]; then
      echo "open: follow failed with exit code $code" >&2
      exit "$code"
    fi
    tries=$((tries + 1))
    if [ "$tries" -ge 10 ]; then
      echo "open: a vault is still locked after $tries runs of follow" >&2
      exit 1
    fi
    sleep 10
  done
  echo "open: both vaults are open" >&2
  exit 0
fi

exec zk-bridge-prover --config "$config" "$command" "$@"
