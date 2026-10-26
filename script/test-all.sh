#!/usr/bin/env bash
# Runs every test suite of the repository and prints the time of each step.
#
# Usage:   script/test-all.sh [--serial] [--keep-logs]
# Steps:   contracts   script/coverage-check.sh (the single gate for forge: all tests plus 100 percent coverage)
#          light-client  cargo test --workspace in light-client/
#          prover        cargo test in prover/
#          explorer      pnpm test in explorer/ for every package except the terminal
#          terminal      bun test in explorer/terminal/
# The steps use separate build directories and separate caches, so they run at the same time by default. A step prints
# nothing until it ends: its output goes to a log file, and the log of a failed step is printed at the end.
#   --serial     run the steps one after another (the times then show the cost of each step alone)
#   --keep-logs  keep the log directory and print its path
# Exit code: 0 when every step passes, 1 when any step fails.
# The deep fuzz profile is not a step here. Run script/test-deep.sh before a deploy and nightly.
set -euo pipefail

cd "$(dirname "$0")/.."
root="$(pwd)"

serial="no"
keep_logs="no"
for argument in "$@"; do
  case "${argument}" in
    --serial) serial="yes" ;;
    --keep-logs) keep_logs="yes" ;;
    *) echo "usage: $0 [--serial] [--keep-logs]" >&2; exit 2 ;;
  esac
done

log_directory="$(mktemp -d)"
cleanup() { [ "${keep_logs}" = "yes" ] && echo "logs: ${log_directory}" || rm -rf "${log_directory}"; }
trap cleanup EXIT

# Each step is "name|directory relative to the root|command".
steps=(
  "contracts|.|script/coverage-check.sh"
  "light-client|light-client|cargo test --workspace"
  "prover|prover|cargo test"
  "explorer|explorer|pnpm -r --filter '!@zk-bridge/terminal' --if-present run test"
  "terminal|explorer/terminal|bun test"
)

# Runs one step, and writes its log, its exit code and its elapsed seconds into the log directory.
run_step() {
  local name="${1%%|*}" rest="${1#*|}"
  local directory="${rest%%|*}" command="${rest#*|}"
  local started="${SECONDS}" code=0
  (cd "${root}/${directory}" && eval "${command}") >"${log_directory}/${name}.log" 2>&1 || code=$?
  echo "${code}" >"${log_directory}/${name}.code"
  echo "$((SECONDS - started))" >"${log_directory}/${name}.seconds"
}

overall_started="${SECONDS}"
for step in "${steps[@]}"; do
  if [ "${serial}" = "yes" ]; then
    run_step "${step}"
  else
    run_step "${step}" &
  fi
done
wait

failed=0
printf '%-14s %-6s %8s\n' "step" "result" "seconds"
for step in "${steps[@]}"; do
  name="${step%%|*}"
  code="$(cat "${log_directory}/${name}.code")"
  result="pass"
  [ "${code}" = "0" ] || { result="FAIL"; failed=$((failed + 1)); }
  printf '%-14s %-6s %8s\n' "${name}" "${result}" "$(cat "${log_directory}/${name}.seconds")"
done
printf '%-14s %-6s %8s\n' "total" "" "$((SECONDS - overall_started))"

for step in "${steps[@]}"; do
  name="${step%%|*}"
  [ "$(cat "${log_directory}/${name}.code")" = "0" ] && continue
  echo
  echo "=== ${name}: last 60 lines of the log ==="
  tail -n 60 "${log_directory}/${name}.log"
done

[ "${failed}" = "0" ] || { echo "${failed} step(s) failed"; exit 1; }
echo "all steps passed"
