#!/usr/bin/env bash
# Marches the light clients of the testnet pair sepolia-pls943 forward so they never fall a whole sync committee
# period behind. Dry run by default: it prints the plan and sends nothing. See docs/testnet-run.md,
# "Keeping the light clients alive".
#
# For each light client that is not fresh it plans the updates (the handoff of each period it must cross, each signed
# by a committee it stores by then, then the newest update) and makes one proof at a time:
#   --via backend (default)  POST https://prove.zkb.fi/requests {pair, direction, reason: keep-alive}; the backend proves
#                            on RunPod and posts to msgboard, the runner bot sends update. Respects the backend's limits.
#   --via local              zk-bridge-prover prove --route <route> --to stdout, then cast send update (sends a
#                            transaction; needs --prover-config, PROVER and KEYSTORE_NAME).
# After each proof it reads head() until the head moved, then judges again. It stops when every light client is fresh,
# stranded, or the proof budget (--max-proofs) is used. Each run starts from the chain as it is, so it is idempotent.
#
# Usage:  script/testnet/march-light-clients.sh                 # plan only
#         script/testnet/march-light-clients.sh --execute       # request keep-alive proofs from the backend
#         script/testnet/march-light-clients.sh --execute --via local --prover-config "$RUN_DIR/prover.toml"
#
# Endpoints as in light-client-status.sh. Exit codes as there, plus 13: a proof failed, was refused near the
# deadline, or the head did not move. Each problem also prints a line that starts with "ALERT light-client".
set -euo pipefail
exec "$(dirname "${BASH_SOURCE[0]}")/keepalive-run.sh" march "$@"
