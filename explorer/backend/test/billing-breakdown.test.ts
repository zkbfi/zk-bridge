import { describe, expect, it } from "vitest";
import { accountTimeline, bucketSecondsWithin, breakdownOf, sumBreakdowns, totalSeconds, type JobRecord, type SessionRecord } from "../src/billing-breakdown.ts";

const S = 1000;
const T = 1_800_000_000_000;
const at = (seconds: number) => T + seconds * S;
const FOREVER: [number, number] = [0, 4_000_000_000_000];

const session = (over: Partial<SessionRecord> & { start: number; end: number }): SessionRecord => ({
  startedAt: at(over.start),
  readyAt: over.readyAt === undefined ? null : over.readyAt,
  endedAt: at(over.end),
  outcome: over.outcome === undefined ? "used" : over.outcome,
  billedSeconds: over.billedSeconds === undefined ? null : over.billedSeconds,
});
/** A proved job whose request starts at `request` and runs `proving` seconds on the worker. */
const job = (request: number, proving: number, over: Partial<JobRecord> = {}): JobRecord => ({
  startedAt: at(request - 20),
  provedAt: at(request + proving),
  waitWorkerMs: null,
  notReadyCount: 0,
  remoteMs: proving * S,
  workerTotalMs: proving * S,
  ...over,
});
const seconds = (sessions: SessionRecord[], jobs: JobRecord[], idle = 60) => bucketSecondsWithin(accountTimeline({ sessions, jobs, idleTimeoutSeconds: idle }), ...FOREVER);

describe("the billing breakdown", () => {
  it("follows the worked example of the header: a cold session, a job after it, a second job during its tail", () => {
    const result = seconds([session({ start: 0, readyAt: at(40), end: 100 })], [job(110, 50), job(190, 50)]);
    expect(result).toEqual({ proving: 100, startingUp: 40, waitingForProof: 70, unusedEarlyStarts: 0, idleAfterJob: 90 });
    expect(totalSeconds(result)).toBe(300);
    const billed = breakdownOf(result, 3600, { seconds: 310, usd: 310 });
    expect(billed.unaccounted).toEqual({ seconds: 10, usd: 10 });
    expect(breakdownOf(result, 3600, { seconds: 290, usd: 290 }).unaccounted).toEqual({ seconds: -10, usd: -10 });
  });

  it("counts a job without a session: its proving, its tail, and the wait of a job that met no worker", () => {
    expect(seconds([], [job(100, 30)])).toEqual({ proving: 30, startingUp: 0, waitingForProof: 0, unusedEarlyStarts: 0, idleAfterJob: 60 });
    // Not ready twice, waited 45 s before the request that the worker accepted.
    const cold = seconds([], [job(100, 30, { waitWorkerMs: 45 * S, notReadyCount: 2 })]);
    expect(cold).toMatchObject({ proving: 30, startingUp: 45 });
    // Answered ready at once (not_ready_count 0): the wait is not a start-up. Missing counts are not either.
    expect(seconds([], [job(100, 30, { waitWorkerMs: 5 * S, notReadyCount: 0 })]).startingUp).toBe(0);
    expect(seconds([], [job(100, 30, { waitWorkerMs: 5 * S, notReadyCount: null })]).startingUp).toBe(0);
    expect(seconds([], [job(100, 30, { waitWorkerMs: null, notReadyCount: 1 })]).startingUp).toBe(0);
  });

  it("uses the worker's own time, else the request, else the whole job", () => {
    expect(seconds([], [job(100, 30, { workerTotalMs: 20 * S })]).proving).toBe(20);
    expect(seconds([], [job(100, 30, { workerTotalMs: null })]).proving).toBe(30);
    // The worker reported its time but the request time is missing: no start of request, so no wait can be placed.
    expect(seconds([], [job(100, 30, { workerTotalMs: 20 * S, remoteMs: null, waitWorkerMs: 9 * S, notReadyCount: 1 })])).toMatchObject({ proving: 20, startingUp: 0 });
    const old = seconds([], [{ startedAt: at(100), provedAt: at(140), waitWorkerMs: null, notReadyCount: null, remoteMs: null, workerTotalMs: null }]);
    expect(old.proving).toBe(40);
    const unstarted = seconds([], [{ startedAt: null, provedAt: at(140), waitWorkerMs: null, notReadyCount: null, remoteMs: null, workerTotalMs: null }]);
    expect(unstarted.proving).toBe(0);
  });

  it("counts an idle tail once where a later job, a later session or another tail overlaps it", () => {
    // The jobs prove 100-130 and 120-150; their tails 130-190 and 150-210 merge to 130-210, minus the proving: 150-210.
    expect(seconds([], [job(100, 30), job(120, 30)])).toMatchObject({ proving: 50, idleAfterJob: 60 });
    // A session that starts 20 s after a job ends takes the rest of the tail (its start-up is 25 s, cold).
    const next = seconds([session({ start: 150, readyAt: at(175), end: 190, outcome: "grace", billedSeconds: 100 })], [job(100, 30)]);
    expect(next.idleAfterJob).toBe(20);
    expect(next.unusedEarlyStarts).toBe(100);
  });

  it("separates a cold session (start-up, then waiting) from a warm one (all waiting)", () => {
    const cold = seconds([session({ start: 0, readyAt: at(30), end: 50 })], []);
    expect(cold).toMatchObject({ startingUp: 30, waitingForProof: 20 });
    // Ready in 2 s: the worker was up already, so its seconds are waiting, not start-up.
    const warm = seconds([session({ start: 0, readyAt: at(2), end: 50 })], []);
    expect(warm).toMatchObject({ startingUp: 0, waitingForProof: 50 });
    // The 5 s floor is a cold start.
    expect(seconds([session({ start: 0, readyAt: at(5), end: 50 })], []).startingUp).toBe(5);
    // A used session that never answered ready was all start-up.
    expect(seconds([session({ start: 0, readyAt: null, end: 50 })], [])).toMatchObject({ startingUp: 50, waitingForProof: 0 });
  });

  it("ends the waiting at the request of the job, or after the idle timeout when the job came much later", () => {
    const jobs = [job(130, 10)];
    expect(seconds([session({ start: 0, readyAt: at(30), end: 100 })], jobs).waitingForProof).toBe(100);
    // The build took long: the request starts 200 s after the session ended, the worker stopped after 60 s.
    const late = seconds([session({ start: 0, readyAt: at(30), end: 100 })], [job(300, 10, { waitWorkerMs: 120 * S, notReadyCount: 1 })]);
    expect(late.waitingForProof).toBe(130);
    // Its own start-up (0 to 30) and the job's wait for a worker (180 to 300).
    expect(late.startingUp).toBe(30 + 120);
  });

  it("gives an unused session all of its billed time, taking what a job inside it proves", () => {
    const unused = seconds([session({ start: 0, readyAt: at(30), end: 100, outcome: "grace", billedSeconds: 160 })], []);
    expect(unused).toEqual({ proving: 0, startingUp: 0, waitingForProof: 0, unusedEarlyStarts: 160, idleAfterJob: 0 });
    // A job that proves inside the unused session's billed time keeps its seconds; the session loses them.
    const overlap = seconds([session({ start: 0, readyAt: at(30), end: 100, outcome: "unusable", billedSeconds: 160 })], [job(120, 20)]);
    expect(overlap).toMatchObject({ proving: 20, unusedEarlyStarts: 140 });
    expect(totalSeconds(overlap)).toBe(160 + 40);
    // An old record without billed seconds: the time to the end plus the idle timeout. A null outcome is unused.
    expect(seconds([session({ start: 0, end: 50, outcome: null })], []).unusedEarlyStarts).toBe(110);
    expect(seconds([session({ start: 0, end: 50, outcome: "restart" })], [], 30).unusedEarlyStarts).toBe(80);
  });

  it("splits at UTC midnight and measures any window", () => {
    const midnight = Math.ceil(T / 86_400_000) * 86_400_000;
    const before = (midnight - T) / S;
    const timeline = accountTimeline({ sessions: [], jobs: [job(before - 10, 30)], idleTimeoutSeconds: 60 });
    const first = bucketSecondsWithin(timeline, midnight - 86_400_000, midnight);
    const second = bucketSecondsWithin(timeline, midnight, midnight + 86_400_000);
    expect(first.proving).toBe(10);
    expect(second.proving).toBe(20);
    expect(first.proving + second.proving).toBe(30);
    expect(first.idleAfterJob + second.idleAfterJob).toBe(60);
  });

  it("reports unaccounted as the bill minus the buckets, rounded as shown, and null without a bill", () => {
    const result = breakdownOf({ proving: 1800, startingUp: 360, waitingForProof: 0, unusedEarlyStarts: 0, idleAfterJob: 360 }, 1.8, { seconds: 3000, usd: 1.5 });
    expect(result).toEqual({
      proving: { seconds: 1800, usd: 0.9 },
      startingUp: { seconds: 360, usd: 0.18 },
      waitingForProof: { seconds: 0, usd: 0 },
      unusedEarlyStarts: { seconds: 0, usd: 0 },
      idleAfterJob: { seconds: 360, usd: 0.18 },
      unaccounted: { seconds: 480, usd: 0.24 },
    });
    // A record that claims more than was billed is reported as it is.
    expect(breakdownOf({ proving: 4000, startingUp: 0, waitingForProof: 0, unusedEarlyStarts: 0, idleAfterJob: 0 }, 1.8, { seconds: 3000, usd: 1.5 }).unaccounted).toEqual({ seconds: -1000, usd: -0.5 });
    expect(breakdownOf({ proving: 10, startingUp: 0, waitingForProof: 0, unusedEarlyStarts: 0, idleAfterJob: 0 }, 1.8, null).unaccounted).toBeNull();
  });

  it("adds days; unaccounted adds the days that have a bill and is null when none has", () => {
    const zero = { proving: 0, startingUp: 0, waitingForProof: 0, unusedEarlyStarts: 0, idleAfterJob: 0 };
    const a = breakdownOf({ ...zero, proving: 100 }, 3600, { seconds: 130, usd: 130 });
    const b = breakdownOf({ ...zero, proving: 50 }, 3600, null);
    const c = breakdownOf({ ...zero, idleAfterJob: 60 }, 3600, { seconds: 50, usd: 50 });
    const total = sumBreakdowns([a, b, c]);
    expect(total.proving).toEqual({ seconds: 150, usd: 150 });
    expect(total.idleAfterJob).toEqual({ seconds: 60, usd: 60 });
    expect(total.unaccounted).toEqual({ seconds: 20, usd: 20 });
    expect(sumBreakdowns([b]).unaccounted).toBeNull();
    expect(sumBreakdowns([]).proving).toEqual({ seconds: 0, usd: 0 });
  });
});
