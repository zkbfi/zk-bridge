#!/usr/bin/env bash
# The single gate for the contracts of this repository: the whole forge suite under coverage, plus the tests that need
# optimized bytecode, plus the 100 percent rule.
#
# Usage:   script/coverage-check.sh [lcov-output-path]
# Result:  exit 0 when every test passes and every measured file has 100 percent
#          lines, branches and functions. Exit 1 and a table of the offending
#          files otherwise.
#
# One gate, not two: this script runs every test of the default profile. Most run
# under coverage. The twelve optimizer tests below run in a second step with
# `forge test` and the real optimizer. So `forge test` followed by this
# script runs the suite twice for nothing. Run only this script, or only
# `forge test` while you iterate. The deep fuzz profile is not part of it: use
# script/test-deep.sh.
#
# Coverage exclusions (the only ones allowed):
#   vendor   - src/hardened/vendor is vendored third party code.
#   test     - test files are not contract code.
#   script   - deploy scripts are not contract code.
#   mocks    - src/mocks and src/revision-2/mocks are test support.
#
# Test exclusions: `forge coverage` compiles without the optimizer. Twelve
# tests depend on optimized bytecode (gas budgets, the contract size limit,
# the canary that depends on gas cost, and the verifier code hash). They
# fail under coverage and pass under `forge test`. They are not weakened.
# The coverage run skips them, and the second step of this script runs them.
set -euo pipefail

cd "$(dirname "$0")/.."

lcov_path="${1:-$(mktemp -d)/lcov.info}"

optimizer_dependent_tests='(test_HB02_gas_confirmWithProof|test_HB02_gas_sendInAConfirmedEpoch|test_HB02_gas_sendInDetectionModeWithColdCanaries|test_HB02_canary_blsPrecompileFiresOnlyOnTheKnownOutput|test_gasOfRelayAndDelivery|test_R2_10_hardenedContractsFitTheSizeLimit|test_gas_openDeposits|test_gas_sendAfterOpeningCostsNoColdRead|test_gas_executeMessage_failedCall|test_gas_executeMessage_historicalPath|test_gas_executeMessage_recentPath|test_codeHashIsTheDocumentedVerifierCodeHash)'

forge coverage \
  --report lcov \
  --report-file "$lcov_path" \
  --no-match-coverage 'vendor|test|script|mocks' \
  --no-match-test "$optimizer_dependent_tests"

# The twelve optimizer tests, with the optimizer on, as `forge test` runs them.
forge test --match-test "$optimizer_dependent_tests"

awk '
  function pct(hit, found) { return found == 0 ? 100 : 100 * hit / found }
  /^SF:/  { file = substr($0, 4); seen[file] = 1 }
  /^LF:/  { lf[file] += substr($0, 4) }
  /^LH:/  { lh[file] += substr($0, 4) }
  /^FNF:/ { fnf[file] += substr($0, 5) }
  /^FNH:/ { fnh[file] += substr($0, 5) }
  /^BRF:/ { brf[file] += substr($0, 5) }
  /^BRH:/ { brh[file] += substr($0, 5) }
  END {
    bad = 0
    printf "%-52s %8s %9s %10s\n", "file", "lines", "branches", "functions"
    for (f in seen) {
      l = pct(lh[f], lf[f]); b = pct(brh[f], brf[f]); n = pct(fnh[f], fnf[f])
      total_lf += lf[f]; total_lh += lh[f]; total_brf += brf[f]
      total_brh += brh[f]; total_fnf += fnf[f]; total_fnh += fnh[f]
      if (l < 100 || b < 100 || n < 100) {
        printf "%-52s %7.1f%% %8.1f%% %9.1f%%\n", f, l, b, n
        bad++
      }
    }
    printf "%-52s %7.1f%% %8.1f%% %9.1f%%\n", "TOTAL", \
      pct(total_lh, total_lf), pct(total_brh, total_brf), pct(total_fnh, total_fnf)
    if (bad > 0) { printf "%d file(s) below 100 percent\n", bad; exit 1 }
    print "all files at 100 percent"
  }
' "$lcov_path"
