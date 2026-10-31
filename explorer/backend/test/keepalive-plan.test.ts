import { describe, expect, it } from "vitest";
import { assess, currentSlotAt, DEFAULT_POLICY, formatHours, neededHandoffPeriods, worseExitCode, EXIT_READ_FAILED, VERDICT_EXIT_CODES, type LightClientFacts, type SourceHistory } from "../src/keepalive/plan.ts";

// A PulseChain-like clock: 10 s slots, 8192 slots per period (22.75 hours), genesis at time 0 for easy numbers.
const PERIOD = 8192;
const SLOT_SECONDS = 10;
const at = (slot: number) => slot * SLOT_SECONDS;
const facts = (headSlot: number, nextCommitteeKnown = true): LightClientFacts => ({ headSlot, slotsPerPeriod: PERIOD, genesisTime: 0, secondsPerSlot: SLOT_SECONDS, nextCommitteeKnown });
/** Finality trails the clock by three epochs. */
const FINALITY_LAG = 96;

function judge(input: { head: number; nowSlot: number; next?: boolean; history?: SourceHistory; finalized?: number }) {
  return assess({
    facts: facts(input.head, input.next ?? true),
    source: { finalizedSlot: input.finalized ?? input.nowSlot - FINALITY_LAG },
    history: input.history ?? { kind: "not-needed" },
    policy: DEFAULT_POLICY,
    nowSeconds: at(input.nowSlot),
  });
}

describe("assess", () => {
  it("fresh: a head two hours old in the current period, deadline more than a period away", () => {
    const head = 100 * PERIOD + 1000;
    const result = judge({ head, nowSlot: head + 720 });
    expect(result.verdict).toBe("fresh");
    expect(result.periodsKnown).toEqual([100, 101]);
    expect(result.periodsBehind).toBe(0);
    expect(result.handoffPeriods).toEqual([]);
    expect(result.headAgeSeconds).toBe(7200);
    // The deadline is the first slot of period 102.
    expect(result.deadlineSeconds).toBe(at(102 * PERIOD));
    expect(result.steps).toEqual([{ kind: "latest", period: 100, signedBy: 100 }]);
    expect(result.reason).toMatch(/2\.0 h old/);
  });

  it("fresh: the head is the newest finalized header", () => {
    const head = 100 * PERIOD + 1000;
    const result = judge({ head, nowSlot: head + 100, finalized: head });
    expect(result).toMatchObject({ verdict: "fresh", proofs: 0, steps: [], reason: "the head is the newest finalized header" });
  });

  it("needs a keep-alive: the head is older than the keep-alive age", () => {
    const head = 100 * PERIOD + 10;
    const result = judge({ head, nowSlot: head + 13 * 360 });
    expect(result.verdict).toBe("needs-keep-alive");
    expect(result.reason).toMatch(/past the keep-alive age/);
    expect(result.proofs).toBe(1);
  });

  it("one period behind: the stored next committee carries one ordinary proof across the border", () => {
    const head = 100 * PERIOD + 8000;
    const result = judge({ head, nowSlot: 101 * PERIOD + 5000 });
    expect(result.verdict).toBe("needs-keep-alive");
    expect(result.periodsBehind).toBe(1);
    expect(result.handoffPeriods).toEqual([]);
    expect(result.steps).toEqual([{ kind: "latest", period: 101, signedBy: 101 }]);
    expect(result.waitForFinality).toBe(false);
  });

  it("needs a keep-alive when the deadline is inside the margin, even with a young head", () => {
    // No next committee stored: the deadline is the end of the head period.
    const head = 100 * PERIOD + 7000;
    const result = judge({ head, nowSlot: head + 360, next: false });
    expect(result.periodsKnown).toEqual([100]);
    expect(result.secondsUntilDeadline).toBe(at(101 * PERIOD) - at(head + 360));
    expect(result.verdict).toBe("needs-keep-alive");
    expect(result.reason).toMatch(/inside the margin/);
  });

  it("waits for finality right after a border: the update would be signed in the next period without crossing", () => {
    const result = judge({ head: 100 * PERIOD + 5000, nowSlot: 101 * PERIOD + 20, finalized: 101 * PERIOD - 70 });
    expect(result.waitForFinality).toBe(true);
    expect(result.verdict).toBe("needs-keep-alive");
    expect(result.reason).toMatch(/wait until finality crosses/);
  });

  it("two behind but recoverable: the source serves the handoff of the last stored period, one proof folds it", () => {
    // The light client on chain 943 on 2026-10-31: head in 1399, stores 1399 and 1400, Sepolia signs in 1401.
    const head = 11_463_040;
    const result = judge({ head, nowSlot: 1401 * PERIOD + 900, history: { kind: "serves" } });
    expect(result.headPeriod).toBe(1399);
    expect(result.periodsBehind).toBe(2);
    expect(result.handoffPeriods).toEqual([1400]);
    expect(result.steps).toEqual([
      { kind: "handoff", period: 1400, signedBy: 1400, proves: 1401 },
      { kind: "latest", period: 1401, signedBy: 1401 },
    ]);
    expect(result.proofs).toBe(1);
    expect(result.verdict).toBe("needs-stepping");
    expect(result.reason).toMatch(/1 handoff step \(period 1400\) in 1 proof$/);
    expect(result.secondsUntilDeadline).toBeLessThan(0);
  });

  it("many periods behind: one proof per 64 folded updates", () => {
    const head = 100 * PERIOD + 10;
    const result = judge({ head, nowSlot: 200 * PERIOD + 900, history: { kind: "serves" } });
    expect(result.handoffPeriods).toHaveLength(99);
    expect(result.proofs).toBe(2);
    expect(result.reason).toMatch(/99 handoff steps \(periods 101, 102,.*\) in 2 proofs$/);
  });

  it("without a stored next committee the handoff of the head period is needed too", () => {
    const head = 100 * PERIOD + 10;
    expect(neededHandoffPeriods(facts(head, false), { finalizedSlot: 101 * PERIOD + 100 }, at(101 * PERIOD + 200))).toEqual([100]);
    expect(neededHandoffPeriods(facts(head, true), { finalizedSlot: 101 * PERIOD + 100 }, at(101 * PERIOD + 200))).toEqual([]);
  });

  it("stranded: the source node gives no handoff for the period it needs", () => {
    // The light client on Sepolia on 2026-10-31: head in 1366, stores 1366 and 1367, chain 943 signs in 1368.
    const head = 11_194_368;
    const result = judge({ head, nowSlot: 1368 * PERIOD + 4000, history: { kind: "missing", period: 1367 } });
    expect(result.verdict).toBe("stranded");
    expect(result.handoffPeriods).toEqual([1367]);
    expect(result.reason).toMatch(/no handoff update for period 1367/);
  });

  it("stranded names the first needed period when the history was not asked", () => {
    const result = judge({ head: 100 * PERIOD, nowSlot: 103 * PERIOD + 4000, history: { kind: "not-needed" } });
    expect(result.verdict).toBe("stranded");
    expect(result.reason).toMatch(/for period 101/);
  });
});

describe("helpers", () => {
  it("the clock never goes below slot zero", () => {
    expect(currentSlotAt(facts(0), -50)).toBe(0);
  });

  it("formats hours with one decimal", () => {
    expect(formatHours(5400)).toBe("1.5 h");
  });

  it("the worst exit code wins: stranded, read failure, stepping, keep-alive, fresh; an unknown code beats all", () => {
    expect(worseExitCode(0, VERDICT_EXIT_CODES["needs-keep-alive"])).toBe(10);
    expect(worseExitCode(11, 10)).toBe(11);
    expect(worseExitCode(EXIT_READ_FAILED, 11)).toBe(EXIT_READ_FAILED);
    expect(worseExitCode(EXIT_READ_FAILED, 12)).toBe(12);
    expect(worseExitCode(12, 13)).toBe(13);
    expect(worseExitCode(13, 0)).toBe(13);
  });
});
