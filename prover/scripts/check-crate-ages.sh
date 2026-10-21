#!/usr/bin/env bash
# Checks the supply-chain age rule for every registry crate in Cargo.lock.
# Rule: each locked version must have been published at least 28 days before the cutoff date.
# Usage: scripts/check-crate-ages.sh [cutoff-date-of-newest-allowed-publish]
# The default cutoff, 2026-09-22, is 28 days before 2026-10-20.
# Output: one line per crate, "ok" or "TOO NEW". The exit code is 1 when any crate is too new.
# Source of dates: https://crates.io/api/v1/crates/<name>/<version> (field version.created_at).
set -euo pipefail

cutoff="${1:-2026-09-22}"
here="$(cd "$(dirname "$0")/.." && pwd)"
cache_dir="${here}/fetch-cache"
cache_file="${cache_dir}/crate-dates.tsv"
mkdir -p "${cache_dir}"
touch "${cache_file}"

user_agent="zk-bridge-crate-age-check"
failures=0

while read -r name version; do
  published="$(awk -v n="${name}" -v v="${version}" '$1==n && $2==v {print $3}' "${cache_file}")"
  if [ -z "${published}" ]; then
    for attempt in 1 2 3 4 5; do
      published="$(curl -s -A "${user_agent}" "https://crates.io/api/v1/crates/${name}/${version}" | jq -r '.version.created_at[0:10] // empty' 2>/dev/null || true)"
      [ -n "${published}" ] && break
      sleep $((attempt * 3))
    done
    if [ -z "${published}" ]; then
      echo "UNKNOWN  ${name} ${version} (crates.io returned no date)"
      failures=$((failures + 1))
      continue
    fi
    printf '%s\t%s\t%s\n' "${name}" "${version}" "${published}" >> "${cache_file}"
    sleep 1
  fi
  if [[ "${published}" > "${cutoff}" ]]; then
    echo "TOO NEW  ${name} ${version} published ${published}"
    failures=$((failures + 1))
    continue
  fi
  echo "ok       ${name} ${version} published ${published}"
done < <(awk '/^name = /{gsub(/"/,"",$3); n=$3} /^version = /{gsub(/"/,"",$3); v=$3} /^source = "registry/{print n, v}' "${here}/Cargo.lock")

exit $((failures > 0 ? 1 : 0))
