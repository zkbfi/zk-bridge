#!/usr/bin/env bash
# The deep run of the contract tests: long fuzz and invariant runs. Use it nightly and before a deploy.
#
# Usage:   script/test-deep.sh [extra forge test arguments]
# It selects the `deep` profile of foundry.toml (fuzz 50000 runs, invariant 2000 runs of depth 100). The normal commands
# (`forge test`, script/coverage-check.sh, script/test-all.sh) use the default profile and never run this.
# The deep profile compiles with the same settings as the default profile, so the two share out/ and the compile cache.
# Exit code: the exit code of forge test.
set -euo pipefail

cd "$(dirname "$0")/.."

start="${SECONDS}"
FOUNDRY_PROFILE=deep forge test "$@"
echo "deep run seconds: $((SECONDS - start))"
