#!/usr/bin/env python3
"""One poll of a green indexer that is backfilling, with the stall guard.

  green_poll.py --port 42070 --unit zk-bridge-indexer-pre --state /run/zkb-green-progress.json --stall 600

Exit 0: /ready answers 200. Exit 10: not ready yet, still moving. Exit 20: /status has not changed for `stall` seconds
(a stalled backfill, the failure of 2026-10-31). Exit 30: the unit is no longer running. The playbook calls this every
15 seconds; the state file carries the hash of /status and the time it last changed between calls.
"""
import argparse
import hashlib
import json
import os
import subprocess
import sys
import time
import urllib.error
import urllib.request


def fetch(url):
    try:
        with urllib.request.urlopen(url, timeout=10) as response:
            return response.status, response.read()
    except urllib.error.HTTPError as error:
        return error.code, error.read()
    except Exception:  # noqa: BLE001 - not listening yet
        return 0, b""


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--port", required=True)
    parser.add_argument("--unit", required=True)
    parser.add_argument("--state", required=True)
    parser.add_argument("--stall", type=int, required=True)
    args = parser.parse_args()
    base = "http://127.0.0.1:%s" % args.port
    now = int(time.time())

    if fetch(base + "/ready")[0] == 200:
        print("green answers /ready")
        return 0
    if subprocess.call(["systemctl", "is-active", "--quiet", args.unit + ".service"]) != 0:
        print("the unit %s is not running" % args.unit)
        return 30

    mark = hashlib.sha256(fetch(base + "/status")[1]).hexdigest()[:16]
    state = {"mark": None, "moved": now}
    try:
        with open(args.state) as handle:
            state = json.load(handle)
    except (OSError, ValueError):
        pass
    if mark != state.get("mark"):
        state = {"mark": mark, "moved": now}
        descriptor = os.open(args.state, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
        with os.fdopen(descriptor, "w") as handle:
            json.dump(state, handle)
    idle = now - state["moved"]
    if idle >= args.stall:
        print("green has not moved for %ds" % idle)
        return 20
    print("not ready; progress last changed %ds ago" % idle)
    return 10


if __name__ == "__main__":
    sys.exit(main())
