#!/usr/bin/env bash
# Lowers every locked crate that is younger than the age cutoff to the newest older version that Cargo accepts.
# Run scripts/check-crate-ages.sh first; it lists the crates that are too new.
# Usage: scripts/downgrade-young-crates.sh [cutoff-date]   (default 2026-09-22 = 28 days before 2026-10-20)
set -uo pipefail

cutoff="${1:-2026-09-22}"
here="$(cd "$(dirname "$0")/.." && pwd)"
cd "${here}"
user_agent="zk-bridge-crate-age-check"

# Iterates until no crate is too new, because one downgrade can pull another crate to a newer version.
for round in 1 2 3 4 5 6; do
  young="$("${here}/scripts/check-crate-ages.sh" "${cutoff}" | awk '$1=="TOO" {print $3, $4}')"
  [ -z "${young}" ] && { echo "all crates are old enough"; exit 0; }
  echo "round ${round}: $(echo "${young}" | wc -l | tr -d ' ') crates too new"
  while read -r name version; do
    candidates="$(curl -s -A "${user_agent}" "https://crates.io/api/v1/crates/${name}/versions" \
      | jq -r --arg cutoff "${cutoff}" '.versions[] | select(.yanked==false) | select(.created_at[0:10] <= $cutoff) | select(.num|test("-")|not) | .num' | head -25)"
    sleep 1
    for candidate in ${candidates}; do
      if cargo update -p "${name}@${version}" --precise "${candidate}" >/dev/null 2>&1; then
        echo "  ${name} ${version} -> ${candidate}"
        break
      fi
    done
  done <<< "${young}"
done
exit 1
