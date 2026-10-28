#!/usr/bin/env bash
# Gate: no tracked file may name the outside project that the owner asked to remove.
# Prints file and line for every match and exits 1. `progress.txt` is excluded.
set -euo pipefail

cd "$(git rev-parse --show-toplevel)"

forbidden_pattern='gi''bs'

if git grep -n -i -e "$forbidden_pattern" -- . ':!progress.txt'; then
  echo "check-forbidden-names: the lines above name a removed project." >&2
  exit 1
fi
