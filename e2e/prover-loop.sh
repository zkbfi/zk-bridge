#!/usr/bin/env bash
# Runs the prover with the subcommand `once` in a loop, one process for each pass, until it gets a termination signal.
#
# Why not `run`: the SP1 prover keeps memory after a Groth16 proof (about 40 GiB in our measurement). A second proof in the same
# process reached 77 GiB within a minute and the memory limit of 80 GiB killed the process. A new process for each pass
# returns the memory to the system between passes. A killed pass leaves the deposit state in the database, and the next pass
# goes on from it.
# Arguments: the command that starts the prover without a subcommand, for example `prover --config prover.toml`.
set -uo pipefail
: "${E2E_PASS_SECONDS:=3}"
child=0
trap 'kill "$child" 2> /dev/null; exit 0' TERM INT
while true; do
  "$@" once &
  child=$!
  wait "$child"
  sleep "$E2E_PASS_SECONDS" &
  child=$!
  wait "$child"
done
