#!/usr/bin/env python3
"""Reads the backend /health and says whether a proof job is in flight (status queued or proving).

  jobs_idle.py --port 8787 [--reads 3] [--interval 10]

One active job per direction exists, and it is the newest job of its direction, so lastJobs shows every job in flight.
Exit 0: no job on `reads` reads in a row. Exit 1: a job is in flight (the line printed names direction, status and
age in minutes). Exit 99: /health cannot be read. Prints no configuration, only job directions, states and ages.
"""
import argparse
import json
import sys
import time
import urllib.request


def read_jobs(port):
    with urllib.request.urlopen("http://127.0.0.1:%s/health" % port, timeout=10) as response:
        report = json.load(response)
    now = time.time() * 1000
    active = []
    for direction, job in (report.get("lastJobs") or {}).items():
        if job and job.get("status") in ("queued", "proving"):
            minutes = round((now - job.get("createdAt", now)) / 60000)
            active.append("%s %s %dmin" % (direction, job["status"], minutes))
    return active


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--port", required=True)
    parser.add_argument("--reads", type=int, default=3)
    parser.add_argument("--interval", type=int, default=10)
    args = parser.parse_args()
    for index in range(args.reads):
        try:
            active = read_jobs(args.port)
        except Exception as error:  # noqa: BLE001 - any failure to read means "do not restart"
            print("cannot read /health: %s" % type(error).__name__)
            return 99
        if active:
            print("jobs in flight: " + "; ".join(active))
            return 1
        if index + 1 < args.reads:
            time.sleep(args.interval)
    print("no job in flight on %d read(s) in a row" % args.reads)
    return 0


if __name__ == "__main__":
    sys.exit(main())
