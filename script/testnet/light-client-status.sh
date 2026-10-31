#!/usr/bin/env bash
# Status of both light clients of the testnet pair sepolia-pls943. Reads only; sends nothing.
#
# For each light client: head slot and period, the committees it stores, the source chain's slot and finalized period,
# how many periods behind it is, the time until only handoff updates can move it, and a verdict:
#   fresh / needs keep-alive / needs stepping (k steps) / STRANDED.
# See docs/testnet-run.md, "Keeping the light clients alive".
#
# Usage:  script/testnet/light-client-status.sh [--json] [--direction first-to-second|second-to-first] [...]
#         VALVE_KEY=$(op read '...') script/testnet/light-client-status.sh     # beacon and RPC through valve.city
#         ENDPOINTS=public script/testnet/light-client-status.sh               # keyless public servers
#
# Endpoints: EXPLORER_RPC_URL_<chainId> and EXPLORER_BEACON_URL_<chainId> win when set. Otherwise ENDPOINTS picks
# them: valve (the default when VALVE_KEY is set) or public. Use the beacon the prover uses: the verdict depends on
# which periods that node serves (the public chain 943 node serves no light-client updates; valve.city does).
# The key never reaches the output: every line goes through a redactor.
#
# Exit codes: 0 fresh, 10 needs keep-alive, 11 needs stepping, 12 stranded, 3 a read failed, 2 bad arguments.
# The worst light client decides.
set -euo pipefail
exec "$(dirname "${BASH_SOURCE[0]}")/keepalive-run.sh" status "$@"
