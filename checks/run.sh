#!/usr/bin/env bash
# Entry point. Runs every static check and prints one PASS or FAIL line per assertion.
# PASS means "the hole is confirmed". Exit code 0 means every hole was confirmed.
# Never executes anything from spec/. Reads only.
CHECKS_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

OVERALL=0
for SCRIPT in h19-h20-files h17-h06-deploy h21-h22-registry h18-frontend h05-circuit revision-2/r2-01-vault-compile revision-2/r2-circuit; do
  printf '\n== %s ==\n' "$SCRIPT"
  bash "$CHECKS_DIR/$SCRIPT.sh" || OVERALL=1
done

printf '\n'
if [ $OVERALL -eq 0 ]; then
  echo "ALL HOLES CONFIRMED (exit 0)"
else
  echo "AT LEAST ONE CHECK FAILED (exit 1): a hole did not show up, or a check could not run"
fi
exit $OVERALL
