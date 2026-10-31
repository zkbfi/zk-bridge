import { describe, expect, it } from "vitest";
import { backendPath, localPath, PROVER_UP_TO_DATE, type BackendPort, type RunResult } from "../src/keepalive/paths.ts";
import type { Runtime, Target } from "../src/keepalive/march.ts";
import type { LightClientFacts } from "../src/keepalive/plan.ts";
import type { ProofRequestAnswer } from "@zk-bridge/shared/backend-client";
import { parseArguments } from "../src/keepalive/cli.ts";

const TARGET: Target = { direction: "second-to-first", label: "pulsechain-testnet-v4 -> sepolia", lightClient: "0x64ddc23ff43ea0cd2ce9a13ef6681ee651e76e4e", destinationChainId: 11155111 };
const FACTS: LightClientFacts = { headSlot: 11_194_368, slotsPerPeriod: 8192, genesisTime: 0, secondsPerSlot: 10, nextCommitteeKnown: true };

function runtime() {
  const state = { now: 0, slept: [] as number[], lines: [] as string[] };
  const value: Runtime = {
    now: () => state.now,
    sleep: async (milliseconds) => {
      state.slept.push(milliseconds);
      state.now += milliseconds / 1000;
    },
    log: (line) => state.lines.push(line),
  };
  return { state, value };
}

const OPTIONS = { pair: "sepolia-pls943", baseUrl: "https://prove.example", maxRetryWaitSeconds: 300, jobTimeoutSeconds: 600, pollSeconds: 30 };

function backend(answers: ProofRequestAnswer[], statuses: Array<{ status: string; error?: string | null; newSlot?: string | null }>) {
  const requests: unknown[] = [];
  const port: BackendPort = {
    requestProof: async (request) => {
      requests.push(request);
      return answers.shift() as ProofRequestAnswer;
    },
    requestStatus: async () => {
      const next = statuses.length > 1 ? (statuses.shift() as (typeof statuses)[number]) : (statuses[0] as (typeof statuses)[number]);
      return { status: next.status, jobId: "job-1", error: next.error ?? null, newSlot: next.newSlot ?? null };
    },
  };
  return { port, requests };
}

describe("backendPath", () => {
  it("asks for a keep-alive and follows the job until it is published", async () => {
    const r = runtime();
    const b = backend([{ requestId: "r1", jobId: "job-1" }], [{ status: "queued" }, { status: "proving" }, { status: "published", newSlot: "11211000" }]);
    const proofs = backendPath(b.port, OPTIONS, r.value);
    expect(proofs.describe(TARGET)).toBe("POST https://prove.example/requests {pair: sepolia-pls943, direction: second-to-first, reason: keep-alive}");
    expect(await proofs.prove(TARGET, FACTS)).toEqual({ kind: "submitted", detail: "backend job job-1 is published (new slot 11211000)" });
    expect(b.requests).toEqual([{ pair: "sepolia-pls943", direction: "second-to-first", reason: "keep-alive" }]);
    expect(r.state.slept).toEqual([30_000, 30_000]);
  });

  it("an on-chain job without a slot, a failed job and a job past its time", async () => {
    const onChain = backend([{ requestId: "r1", jobId: "job-1" }], [{ status: "on-chain" }]);
    expect(await backendPath(onChain.port, OPTIONS, runtime().value).prove(TARGET, FACTS)).toMatchObject({ kind: "submitted", detail: "backend job job-1 is on-chain (new slot unknown)" });
    const failed = backend([{ requestId: "r1", jobId: "job-1" }], [{ status: "failed", error: "beacon: no update for period 1366" }]);
    expect(await backendPath(failed.port, OPTIONS, runtime().value).prove(TARGET, FACTS)).toEqual({ kind: "failed", detail: "backend job job-1 failed: beacon: no update for period 1366" });
    const silent = backend([{ requestId: "r1", jobId: "job-1" }], [{ status: "failed" }]);
    expect(await backendPath(silent.port, OPTIONS, runtime().value).prove(TARGET, FACTS)).toMatchObject({ detail: "backend job job-1 failed: no reason given" });
    const stuck = backend([{ requestId: "r1", jobId: "job-1" }], [{ status: "proving" }]);
    expect(await backendPath(stuck.port, OPTIONS, runtime().value).prove(TARGET, FACTS)).toEqual({ kind: "failed", detail: "backend job job-1 is still proving after 600 s" });
  });

  it("waits out a short limit, then defers when the waits add up past the maximum", async () => {
    const r = runtime();
    const b = backend(
      [
        { refused: "rate-limited", retryAfterSeconds: 120 },
        { refused: "cannot-check", retryAfterSeconds: 60 },
        { requestId: "r1", jobId: "job-1" },
      ],
      [{ status: "published" }],
    );
    expect((await backendPath(b.port, OPTIONS, r.value).prove(TARGET, FACTS)).kind).toBe("submitted");
    expect(r.state.slept).toEqual([120_000, 60_000]);
    expect(r.state.lines[0]).toMatch(/answered rate-limited; asking again in 120 s/);

    const long = backend([{ refused: "rate-limited", retryAfterSeconds: 200 }, { refused: "rate-limited", retryAfterSeconds: 200 }], []);
    expect(await backendPath(long.port, OPTIONS, runtime().value).prove(TARGET, FACTS)).toEqual({ kind: "deferred", detail: "the backend refused: rate-limited, retry after 200 s" });
  });

  it("nothing-to-prove defers and points at the local path", async () => {
    const b = backend([{ refused: "nothing-to-prove" }], []);
    const outcome = await backendPath(b.port, OPTIONS, runtime().value).prove(TARGET, FACTS);
    expect(outcome.kind).toBe("deferred");
    expect(outcome.detail).toMatch(/--via local/);
  });
});

const PACKAGE = { startHeadSlot: FACTS.headSlot, newHeadSlot: 11_211_000, updateCalldata: "0xabcdef", destination: { chainId: 11155111, lightClient: "0x64DDC23FF43EA0CD2CE9A13EF6681EE651E76E4E" } };

describe("localPath", () => {
  const options = { prover: "/bin/zk-bridge-prover", proverConfig: "/run/prover.toml", routes: { "first-to-second": "a_to_b", "second-to-first": "b_to_a" } };

  function local(result: RunResult, sendOk = true) {
    const runs: Array<{ command: string; args: readonly string[] }> = [];
    const sends: string[] = [];
    const proofs = localPath(
      options,
      async (command, args) => {
        runs.push({ command, args });
        return result;
      },
      async (_target, calldata) => {
        sends.push(calldata);
        return { ok: sendOk, detail: sendOk ? "transaction 0x12 status 0x1" : "cast send exit code 1" };
      },
    );
    return { proofs, runs, sends };
  }

  it("runs the route of the direction and sends the calldata of a package that starts at the head", async () => {
    const l = local({ exitCode: 0, stdout: `${JSON.stringify(PACKAGE)}\n`, stderr: "" });
    expect(l.proofs.describe(TARGET)).toBe("run /bin/zk-bridge-prover --config /run/prover.toml prove --route b_to_a --to stdout and send update to 0x64ddc23ff43ea0cd2ce9a13ef6681ee651e76e4e");
    expect(await l.proofs.prove(TARGET, FACTS)).toEqual({ kind: "submitted", detail: "update to slot 11211000 sent: transaction 0x12 status 0x1" });
    expect(l.runs[0]?.args).toEqual(["--config", "/run/prover.toml", "prove", "--route", "b_to_a", "--to", "stdout"]);
    expect(l.sends).toEqual(["0xabcdef"]);
  });

  it("a package without a destination is accepted", async () => {
    const { destination: _, ...bare } = PACKAGE;
    expect((await local({ exitCode: 0, stdout: JSON.stringify(bare), stderr: "" }).proofs.prove(TARGET, FACTS)).kind).toBe("submitted");
  });

  it("refuses to send what does not fit, and reports the prover's exit codes", async () => {
    expect(await local({ exitCode: PROVER_UP_TO_DATE, stdout: "", stderr: "" }).proofs.prove(TARGET, FACTS)).toMatchObject({ kind: "up-to-date" });
    expect(await local({ exitCode: 1, stdout: "", stderr: "line one\nbeacon: no update for period 1366\n" }).proofs.prove(TARGET, FACTS)).toEqual({
      kind: "failed",
      detail: "zk-bridge-prover exit code 1: beacon: no update for period 1366",
    });
    expect(await local({ exitCode: 0, stdout: "log line\n{\"other\":1}\n", stderr: "" }).proofs.prove(TARGET, FACTS)).toMatchObject({ detail: "zk-bridge-prover printed no proof package" });
    const moved = local({ exitCode: 0, stdout: JSON.stringify({ ...PACKAGE, startHeadSlot: 5 }), stderr: "" });
    expect(await moved.proofs.prove(TARGET, FACTS)).toMatchObject({ kind: "failed", detail: "the package starts at slot 5, the light client is at 11194368" });
    expect(moved.sends).toEqual([]);
    const elsewhere = local({ exitCode: 0, stdout: JSON.stringify({ ...PACKAGE, destination: { lightClient: "0x1dbbcc0bc25de5f6ae122fb0009b3ee4931fd958" } }), stderr: "" });
    expect((await elsewhere.proofs.prove(TARGET, FACTS)).detail).toMatch(/check the route of second-to-first/);
    expect(await local({ exitCode: 0, stdout: JSON.stringify(PACKAGE), stderr: "" }, false).proofs.prove(TARGET, FACTS)).toEqual({ kind: "failed", detail: "update was not sent: cast send exit code 1" });
  });
});

describe("parseArguments", () => {
  it("fills the defaults", () => {
    const parsed = parseArguments(["status"]);
    expect(parsed).toMatchObject({
      command: "status",
      directions: ["first-to-second", "second-to-first"],
      keepAliveHours: undefined,
      marginHours: 6,
      json: false,
      execute: false,
      via: "backend",
      backendUrl: "https://prove.zkb.fi",
      maxProofs: 3,
      routes: { "first-to-second": "sepolia_to_pulsechain_testnet", "second-to-first": "pulsechain_testnet_to_sepolia" },
    });
  });

  it("reads every option, and the prover and account from the environment", () => {
    const parsed = parseArguments(
      ["march", "--execute", "--json", "--direction", "second-to-first", "--via", "local", "--keep-alive-hours", "8", "--margin-hours", "0", "--max-proofs", "2", "--pair", "p", "--deployment", "d.json", "--backend-config", "b.json", "--prover-config", "c.toml", "--route-first-to-second", "x", "--max-retry-wait-seconds", "0"],
      { PROVER: "/p", KEYSTORE_NAME: "k" },
    );
    expect(parsed).toMatchObject({ command: "march", execute: true, json: true, directions: ["second-to-first"], via: "local", keepAliveHours: 8, marginHours: 0, maxProofs: 2, pair: "p", deployment: "d.json", backendConfig: "b.json", proverConfig: "c.toml", prover: "/p", account: "k", maxRetryWaitSeconds: 0 });
    expect(parseArguments(["march", "--prover", "/q", "--account", "a"], { PROVER: "/p" })).toMatchObject({ prover: "/q", account: "a" });
  });

  it("names the bad argument", () => {
    expect(parseArguments([])).toEqual({ error: "the first argument must be status or march" });
    expect(parseArguments(["status", "--nope"])).toEqual({ error: "unknown argument --nope" });
    expect(parseArguments(["status", "--pair"])).toEqual({ error: "--pair needs a value" });
    expect(parseArguments(["status", "--max-proofs", "1.5"])).toEqual({ error: "--max-proofs must be a positive number" });
    expect(parseArguments(["status", "--poll-seconds", "x"])).toEqual({ error: "--poll-seconds must be a positive number" });
    expect(parseArguments(["status", "--direction", "up"])).toMatchObject({ error: expect.stringMatching(/--direction/) });
    expect(parseArguments(["status", "--via", "pigeon"])).toEqual({ error: "--via must be backend or local" });
  });
});
