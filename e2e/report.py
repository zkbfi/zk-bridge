#!/usr/bin/env python3
"""Summarizes an end-to-end run: the proofs, the gas of each transaction, the time from deposit to payout, and the books.

Run it from the repository root with `python3 -I e2e/report.py`, while the run goes or after it. It reads the logs and the
record in the state directory (`E2E_STATE_DIR`, default `e2e/state`) and the two chains (they must still run), and prints
Markdown tables. It changes nothing.
"""

import json
import os
import re
import subprocess
import sys
from collections import defaultdict

STATE_DIR = os.environ.get("E2E_STATE_DIR", "e2e/state")
INITIAL_LIQUIDITY_TOKENS = 1_000_000
TOKEN_UNIT = 10**18
FIELD = re.compile(r'(\w+)=("[^"]*"|\S+)')

DEPOSIT_SIGNATURE = "DepositInitiated(address,address,address,uint256,bytes32,uint64,address,address)"
WITHDRAWAL_SIGNATURE = "WithdrawalCompleted(address,address,bytes32,uint256,bytes32)"
HEAD_SIGNATURE = "HeadUpdated(uint64,bytes32,bytes32)"
LAYOUT_SIGNATURES = {
    "block roots layout": "BlockRootsLayoutValidated(uint256,uint64,uint64)",
    "block hash layout": "BlockHashLayoutValidated(uint256,uint64,uint64)",
    "historical layout": "HistoricalSummariesLayoutValidated(uint256,uint64,uint64,uint256)",
}


def cast(*arguments):
    """Runs cast and returns its output without the final newline."""
    result = subprocess.run(["cast", *arguments], capture_output=True, text=True, check=False)
    if result.returncode != 0:
        sys.exit(f"cast {' '.join(arguments)}: {result.stderr.strip()}")
    return result.stdout.strip()


def logs(rpc, address, signature):
    """The logs of one event of one contract, from the first block."""
    answer = cast("logs", "--rpc-url", rpc, "--address", address, "--from-block", "0", "--to-block", "latest", signature, "--json")
    return json.loads(answer) if answer else []


def gas_used(rpc, transaction):
    """The gas of a mined transaction."""
    receipt = json.loads(cast("receipt", transaction, "--rpc-url", rpc, "--json"))
    return int(receipt["gasUsed"], 16)


def words(data):
    """The 32-byte words of log data, as integers."""
    body = data[2:]
    return [int(body[index : index + 64], 16) for index in range(0, len(body), 64)]


def read_lines(name):
    path = os.path.join(STATE_DIR, "logs", name)
    if not os.path.exists(path):
        return []
    with open(path, encoding="utf-8", errors="replace") as handle:
        return handle.read().splitlines()


def fields_of(line):
    return {key: value.strip('"') for key, value in FIELD.findall(line)}


def table(headers, rows):
    print("| " + " | ".join(headers) + " |")
    print("|" + "|".join("---" for _ in headers) + "|")
    for row in rows:
        print("| " + " | ".join(str(cell) for cell in row) + " |")
    print()


def proofs():
    """The proofs of the logs of `follow` and of the prover, each with the peak memory of the prover scope while it ran."""
    memory = []
    memory_path = os.path.join(STATE_DIR, "memory.log")
    if os.path.exists(memory_path):
        with open(memory_path, encoding="utf-8") as handle:
            for line in handle:
                parts = [int(part) for part in line.split() if part.isdigit()]
                if len(parts) < 2:
                    continue
                # Old lines hold two numbers (no anonymous column).
                memory.append((parts[0], parts[1], parts[2] if len(parts) > 2 else 0))
    rows = []
    started = None
    for line in read_lines("follow.log") + read_lines("prover.log"):
        fields = fields_of(line)
        if fields.get("event") == "proof_started":
            started = int(fields["ts"])
        if fields.get("event") != "proof_finished" or started is None:
            continue
        finished = int(fields["ts"])
        window = [(size, anonymous) for moment, size, anonymous in memory if started <= moment <= finished + 4]
        peak = f"{max(size for size, _ in window) / 2**30:.1f}" if window else "not sampled"
        peak_anonymous = max((anonymous for _, anonymous in window), default=0)
        anonymous_text = f"{peak_anonymous / 2**30:.1f}" if peak_anonymous else "not sampled"
        rows.append((len(rows) + 1, fields["prove_seconds"], fields["total_seconds"], anonymous_text, peak, fields["proof_bytes"]))
        started = None
    print("## Proofs\n")
    table(["proof", "prove seconds", "with local check, seconds", "peak memory of the processes, GiB", "peak with file cache, GiB", "proof bytes"], rows)
    if rows:
        seconds = [int(row[1]) for row in rows]
        print(f"Proofs: {len(rows)}. Prove time: minimum {min(seconds)} s, mean {sum(seconds) / len(seconds):.0f} s, maximum {max(seconds)} s.\n")


def deployment():
    with open(os.path.join(STATE_DIR, "deployment.json"), encoding="utf-8") as handle:
        return json.load(handle)


def light_client_updates(record):
    print("## Light client updates (real Groth16 check on chain)\n")
    rows = []
    for side in ("chain_a", "chain_b"):
        chain = record[side]
        for log in logs(chain["rpc_url"], chain["light_client"], HEAD_SIGNATURE):
            slot = int(log["topics"][1], 16)
            rows.append((chain["name"], slot, int(log["blockNumber"], 16), gas_used(chain["rpc_url"], log["transactionHash"])))
    table(["chain", "new head slot", "block", "gas of the update transaction"], rows)
    gas = [row[3] for row in rows]
    if gas:
        print(f"Updates: {len(gas)}. Gas: minimum {min(gas):,}, mean {sum(gas) // len(gas):,}, maximum {max(gas):,}.\n")


def layout_rows(record):
    print("## Layout rows added by the prover\n")
    rows = []
    for side in ("chain_a", "chain_b"):
        chain = record[side]
        for label, signature in LAYOUT_SIGNATURES.items():
            for log in logs(chain["rpc_url"], chain["vault"], signature):
                rows.append((chain["name"], label, gas_used(chain["rpc_url"], log["transactionHash"])))
    table(["chain", "row", "gas"], rows)


def books(record):
    """Joins every deposit with its withdrawal, and checks the token balance of each vault."""
    deposits = {}
    paid = defaultdict(list)
    for side, other in (("chain_a", "chain_b"), ("chain_b", "chain_a")):
        source, destination = record[side], record[other]
        for log in logs(source["rpc_url"], source["vault"], DEPOSIT_SIGNATURE):
            data = words(log["data"])
            deposits[log["data"][2 + 64 : 2 + 128]] = {"direction": f"{source['name']} to {destination['name']}", "amount": data[0], "nonce": "0x" + log["data"][2 + 64 : 2 + 128], "source": side}
        for log in logs(destination["rpc_url"], destination["vault"], WITHDRAWAL_SIGNATURE):
            nonce = log["topics"][3][2:]
            paid[nonce].append({"amount": words(log["data"])[0], "transaction": log["transactionHash"], "chain": other})
    return deposits, paid


def withdrawals_and_books(record):
    deposits, paid = books(record)
    print("## Withdrawals\n")
    rows = []
    for nonce, entries in paid.items():
        for entry in entries:
            chain = record[entry["chain"]]
            rows.append((chain["name"], "0x" + nonce[:10] + "...", gas_used(chain["rpc_url"], entry["transaction"])))
    table(["chain", "deposit nonce", "gas of the withdraw transaction"], rows)
    gas = [row[2] for row in rows]
    if gas:
        print(f"Withdrawals: {len(gas)}. Gas: minimum {min(gas):,}, mean {sum(gas) // len(gas):,}, maximum {max(gas):,}.\n")

    print("## Books\n")
    unpaid = [nonce for nonce in deposits if nonce not in paid]
    twice = [nonce for nonce, entries in paid.items() if len(entries) != 1]
    wrong_amount = [nonce for nonce, entries in paid.items() if nonce in deposits and entries[0]["amount"] != deposits[nonce]["amount"]]
    unknown = [nonce for nonce in paid if nonce not in deposits]
    per_direction = defaultdict(lambda: [0, 0])
    for nonce, deposit in deposits.items():
        per_direction[deposit["direction"]][0] += 1
        per_direction[deposit["direction"]][1] += 1 if nonce in paid else 0
    table(["direction", "deposits", "paid"], [(name, count[0], count[1]) for name, count in sorted(per_direction.items())])
    print(f"Deposits paid more than once: {len(twice)}. Deposits not yet paid: {len(unpaid)}. Payouts with another amount than the deposit: {len(wrong_amount)}. Payouts with no deposit: {len(unknown)}.\n")

    rows = []
    for side, other in (("chain_a", "chain_b"), ("chain_b", "chain_a")):
        chain = record[side]
        deposited = sum(deposit["amount"] for deposit in deposits.values() if deposit["source"] == side)
        withdrawn = sum(entry["amount"] for entries in paid.values() for entry in entries if entry["chain"] == side)
        expected = INITIAL_LIQUIDITY_TOKENS * TOKEN_UNIT + deposited - withdrawn
        balance = int(cast("call", chain["token"], "balanceOf(address)(uint256)", chain["vault"], "--rpc-url", chain["rpc_url"]).split()[0])
        rows.append((chain["name"], balance, expected, "equal" if balance == expected else "DIFFERENT"))
    table(["vault", "token balance", "liquidity + deposits - withdrawals", "check"], rows)


def payout_times():
    """The seconds from a deposit to its payout, as the bots saw them, and what the prover's first sight cost."""
    print("## Time from deposit to payout\n")
    rows = []
    for line in read_lines("bots.log"):
        fields = fields_of(line)
        if fields.get("event") != "withdrawal_completed":
            continue
        rows.append((fields["direction"], fields["nonce"][:12] + "...", fields["seconds"]))
    table(["direction", "deposit nonce", "seconds from deposit to payout"], rows)
    seconds = [int(row[2]) for row in rows]
    if seconds:
        print(f"Payouts seen by the bots: {len(seconds)}. Seconds: minimum {min(seconds)}, median {sorted(seconds)[len(seconds) // 2]}, maximum {max(seconds)}.\n")


def main():
    record = deployment()
    proofs()
    light_client_updates(record)
    layout_rows(record)
    withdrawals_and_books(record)
    payout_times()


if __name__ == "__main__":
    main()
