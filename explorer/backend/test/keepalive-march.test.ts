import { describe, expect, it } from "vitest";
import { describeInspection, inspect, marchExitCode, marchOne, summarize, EXIT_ACTION_FAILED, type MarchOptions, type MarchResult, type ProofOutcome, type ProofPath, type Reads, type Runtime, type Target } from "../src/keepalive/march.ts";
import { DEFAULT_POLICY, type LightClientFacts, type SourceHistory } from "../src/keepalive/plan.ts";

const PERIOD = 8192;
const TARGET: Target = { direction: "first-to-second", label: "sepolia -> pulsechain-testnet-v4", lightClient: "0x1dbbcc0bc25de5f6ae122fb0009b3ee4931fd958", destinationChainId: 943 };
const facts = (headSlot: number, nextCommitteeKnown = true): LightClientFacts => ({ headSlot, slotsPerPeriod: PERIOD, genesisTime: 0, secondsPerSlot: 10, nextCommitteeKnown });

/** A chain whose light client head the proof path moves. Time runs on a fake clock that `sleep` advances. */
function world(input: { head: number; nowSlot: number; history?: SourceHistory; failReads?: boolean; next?: boolean }) {
  const state = { head: input.head, now: input.nowSlot * 10, historyAsked: [] as number[][], failHeadReads: false };
  const lines: string[] = [];
  const reads: Reads = {
    lightClient: async () => {
      if (input.failReads === true || state.failHeadReads) throw new Error("rpc down");
      return facts(state.head, input.next ?? true);
    },
    source: async () => ({ finalizedSlot: Math.floor(state.now / 10) - 96 }),
    history: async (_target, periods) => {
      state.historyAsked.push([...periods]);
      return input.history ?? { kind: "serves" };
    },
  };
  const runtime: Runtime = {
    now: () => state.now,
    sleep: async (milliseconds) => {
      state.now += milliseconds / 1000;
    },
    log: (line) => lines.push(line),
  };
  return { state, lines, reads, runtime };
}

const OPTIONS: MarchOptions = { execute: true, maxProofs: 3, headTimeoutSeconds: 600, pollSeconds: 30 };

function path(outcomes: Array<ProofOutcome | Error>, onProve: () => void = () => undefined): ProofPath & { calls: number } {
  const result = {
    calls: 0,
    describe: () => "POST https://prove.example/requests",
    async prove(): Promise<ProofOutcome> {
      const outcome = outcomes[result.calls] as ProofOutcome | Error;
      result.calls += 1;
      if (outcome instanceof Error) throw outcome;
      onProve();
      return outcome;
    },
  };
  return result;
}

describe("inspect", () => {
  it("asks the source for handoffs only when some are needed", async () => {
    const fresh = world({ head: 100 * PERIOD + 10, nowSlot: 100 * PERIOD + 400 });
    await inspect(TARGET, fresh.reads, DEFAULT_POLICY, fresh.state.now);
    expect(fresh.state.historyAsked).toEqual([]);
    const behind = world({ head: 100 * PERIOD + 10, nowSlot: 102 * PERIOD + 400 });
    await inspect(TARGET, behind.reads, DEFAULT_POLICY, behind.state.now);
    expect(behind.state.historyAsked).toEqual([[101]]);
  });

  it("describes a light client in five lines, with the deadline ahead or past", async () => {
    const fresh = world({ head: 100 * PERIOD + 10, nowSlot: 100 * PERIOD + 400 });
    const lines = describeInspection(TARGET, await inspect(TARGET, fresh.reads, DEFAULT_POLICY, fresh.state.now));
    expect(lines).toHaveLength(5);
    expect(lines[1]).toMatch(/committees known: 100, 101/);
    expect(lines[2]).toMatch(/0 periods behind/);
    expect(lines[3]).toMatch(/ends: in /);
    expect(lines[4]).toMatch(/verdict: fresh/);

    const one = world({ head: 100 * PERIOD + 8000, nowSlot: 101 * PERIOD + 20 });
    const oneLines = describeInspection(TARGET, await inspect(TARGET, one.reads, DEFAULT_POLICY, one.state.now));
    expect(oneLines[2]).toMatch(/1 period behind/);
    expect(oneLines[3]).toMatch(/finality has not crossed/);
    expect(oneLines[4]).toMatch(/verdict: needs keep alive/);

    const two = world({ head: 100 * PERIOD + 10, nowSlot: 102 * PERIOD + 400 });
    expect(describeInspection(TARGET, await inspect(TARGET, two.reads, DEFAULT_POLICY, two.state.now))[4]).toMatch(/needs stepping \(1 step\)/);
    const three = world({ head: 100 * PERIOD + 10, nowSlot: 103 * PERIOD + 400 });
    const threeLines = describeInspection(TARGET, await inspect(TARGET, three.reads, DEFAULT_POLICY, three.state.now));
    expect(threeLines[3]).toMatch(/ ago/);
    expect(threeLines[4]).toMatch(/needs stepping \(2 steps\)/);
    const stranded = world({ head: 100 * PERIOD + 10, nowSlot: 102 * PERIOD + 400, history: { kind: "missing", period: 101 } });
    expect(describeInspection(TARGET, await inspect(TARGET, stranded.reads, DEFAULT_POLICY, stranded.state.now))[4]).toMatch(/verdict: STRANDED/);
  });
});

describe("marchOne", () => {
  it("does nothing for a fresh light client", async () => {
    const w = world({ head: 100 * PERIOD + 10, nowSlot: 100 * PERIOD + 400 });
    const proofs = path([]);
    const result = await marchOne({ target: TARGET, reads: w.reads, path: proofs, policy: DEFAULT_POLICY, options: OPTIONS, runtime: w.runtime });
    expect(result).toMatchObject({ result: "fresh", urgent: false, verdict: "fresh" });
    expect(proofs.calls).toBe(0);
  });

  it("dry run: prints the plan and sends nothing", async () => {
    const w = world({ head: 1399 * PERIOD + 2000, nowSlot: 1401 * PERIOD + 900 });
    const proofs = path([]);
    const result = await marchOne({ target: TARGET, reads: w.reads, path: proofs, policy: DEFAULT_POLICY, options: { ...OPTIONS, execute: false }, runtime: w.runtime });
    expect(result.result).toBe("planned");
    expect(result.detail).toBe("would POST https://prove.example/requests: 1 proof: handoff 1400 (proves 1401), then latest in 1401");
    expect(proofs.calls).toBe(0);
    expect(marchExitCode(result)).toBe(11);
    expect(summarize([result]).alerts).toEqual([]);
  });

  it("dry run of a keep-alive says proofs in the plural when there are several", async () => {
    const w = world({ head: 100 * PERIOD + 10, nowSlot: 200 * PERIOD + 900 });
    const result = await marchOne({ target: TARGET, reads: w.reads, path: path([]), policy: DEFAULT_POLICY, options: { ...OPTIONS, execute: false }, runtime: w.runtime });
    expect(result.detail).toMatch(/: 2 proofs: /);
  });

  it("steps a light client two periods behind: one proof, waits for the head, judges it fresh", async () => {
    const w = world({ head: 1399 * PERIOD + 2000, nowSlot: 1401 * PERIOD + 900 });
    const proofs = path([{ kind: "submitted", detail: "backend job j1 is published" }]);
    // The runner posts the update a minute after the proof.
    const moving = { ...w.reads, lightClient: async (target: Target) => {
      if (proofs.calls > 0 && w.state.now > (1401 * PERIOD + 900) * 10 + 60) w.state.head = Math.floor(w.state.now / 10) - 96;
      return w.reads.lightClient(target);
    } };
    const result = await marchOne({ target: TARGET, reads: moving, path: proofs, policy: DEFAULT_POLICY, options: OPTIONS, runtime: w.runtime });
    expect(result).toMatchObject({ result: "fresh", verdict: "fresh" });
    expect(proofs.calls).toBe(1);
    expect(w.lines.some((line) => line.includes("head moved 11462608 ->"))).toBe(true);
    expect(marchExitCode(result)).toBe(0);
  });

  it("a head that does not move in time is not-landed; failed head reads count as no move", async () => {
    const w = world({ head: 100 * PERIOD + 10, nowSlot: 102 * PERIOD + 400 });
    const proofs = path([{ kind: "submitted", detail: "sent" }], () => {
      w.state.failHeadReads = true;
    });
    const result = await marchOne({ target: TARGET, reads: w.reads, path: proofs, policy: DEFAULT_POLICY, options: OPTIONS, runtime: w.runtime });
    expect(result.result).toBe("not-landed");
    expect(marchExitCode(result)).toBe(EXIT_ACTION_FAILED);
  });

  it("stops after maxProofs when the head moves but stays behind", async () => {
    const w = world({ head: 100 * PERIOD + 10, nowSlot: 102 * PERIOD + 400 });
    const proofs = path(
      Array.from({ length: 5 }, () => ({ kind: "submitted", detail: "sent" }) as const),
      () => {
        w.state.head += 1;
      },
    );
    const result = await marchOne({ target: TARGET, reads: w.reads, path: proofs, policy: DEFAULT_POLICY, options: { ...OPTIONS, maxProofs: 2 }, runtime: w.runtime });
    expect(result.result).toBe("incomplete");
    expect(proofs.calls).toBe(2);
  });

  it("reports a stranded light client without proving", async () => {
    const w = world({ head: 100 * PERIOD + 10, nowSlot: 102 * PERIOD + 400, history: { kind: "missing", period: 101 } });
    const proofs = path([]);
    const result = await marchOne({ target: TARGET, reads: w.reads, path: proofs, policy: DEFAULT_POLICY, options: OPTIONS, runtime: w.runtime });
    expect(result).toMatchObject({ result: "stranded", urgent: true });
    expect(proofs.calls).toBe(0);
    expect(summarize([result])).toEqual({ exitCode: 12, alerts: [expect.stringMatching(/^ALERT light-client sepolia -> pulsechain-testnet-v4: stranded: /)] });
  });

  it("defers right after a border until finality crosses", async () => {
    const w = world({ head: 100 * PERIOD + 8000, nowSlot: 101 * PERIOD + 20 });
    const result = await marchOne({ target: TARGET, reads: w.reads, path: path([]), policy: DEFAULT_POLICY, options: OPTIONS, runtime: w.runtime });
    expect(result.result).toBe("deferred");
  });

  it("a read failure, a failed proof, a thrown proof, a refusal and an up-to-date prover each end the march", async () => {
    const broken = world({ head: 1, nowSlot: 2, failReads: true });
    const readFailed = await marchOne({ target: TARGET, reads: broken.reads, path: path([]), policy: DEFAULT_POLICY, options: OPTIONS, runtime: broken.runtime });
    expect(readFailed).toMatchObject({ result: "read-failed", detail: "rpc down", urgent: false, verdict: null });
    expect(marchExitCode(readFailed)).toBe(3);

    const old = () => world({ head: 100 * PERIOD + 10, nowSlot: 100 * PERIOD + 6000 });
    const run = async (outcome: ProofOutcome | Error) => {
      const w = old();
      return marchOne({ target: TARGET, reads: w.reads, path: path([outcome]), policy: DEFAULT_POLICY, options: OPTIONS, runtime: w.runtime });
    };
    expect(await run({ kind: "failed", detail: "job failed" })).toMatchObject({ result: "failed", detail: "job failed" });
    expect(await run(new Error("boom"))).toMatchObject({ result: "failed", detail: "boom" });
    const deferred = await run({ kind: "deferred", detail: "rate-limited" });
    expect(deferred).toMatchObject({ result: "deferred", urgent: false });
    expect(marchExitCode(deferred)).toBe(0);
    expect(await run({ kind: "up-to-date", detail: "exit 3" })).toMatchObject({ result: "deferred", detail: "the prover found nothing to prove: exit 3" });
  });

  it("a thrown non-Error read is reported as text", async () => {
    const w = world({ head: 1, nowSlot: 2 });
    const reads: Reads = { ...w.reads, lightClient: () => Promise.reject("plain") };
    expect(await marchOne({ target: TARGET, reads, path: path([]), policy: DEFAULT_POLICY, options: OPTIONS, runtime: w.runtime })).toMatchObject({ detail: "plain" });
  });
});

describe("summarize", () => {
  const result = (overrides: Partial<MarchResult>): MarchResult => ({ target: TARGET, result: "fresh", detail: "", urgent: false, verdict: "fresh", ...overrides });

  it("an urgent deferral alerts, a calm one does not; the worst code wins", () => {
    expect(marchExitCode(result({ result: "deferred", urgent: true }))).toBe(EXIT_ACTION_FAILED);
    const summary = summarize([result({}), result({ result: "deferred", urgent: true, detail: "nothing-to-prove" }), result({ result: "planned", verdict: "needs-keep-alive" })]);
    expect(summary.exitCode).toBe(EXIT_ACTION_FAILED);
    expect(summary.alerts).toEqual(["ALERT light-client sepolia -> pulsechain-testnet-v4: deferred: nothing-to-prove"]);
    expect(summarize([result({})])).toEqual({ exitCode: 0, alerts: [] });
  });
});
