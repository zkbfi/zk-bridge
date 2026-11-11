import { describe, expect, it } from "vitest";
import { accountTimeline, billedThroughOf, bucketSecondsWithin, breakdownOfSpans, daySpan, hourSpans, sumBreakdowns, totalSeconds, type BucketSeconds, type JobRecord, type SessionRecord, type Span } from "../src/billing-breakdown.ts";

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
const seconds = (sessions: SessionRecord[], jobs: JobRecord[], idle = 60) => bucketSecondsWithin(accountTimeline({ sessions, jobs, idleSecondsAt: () => idle }), ...FOREVER);

const ZERO: BucketSeconds = { proving: 0, startingUp: 0, waitingForProof: 0, unusedEarlyStarts: 0, idleAfterJob: 0 };
const HOUR = 3_600_000;
const DAY = 24 * HOUR;
/** A timeline of the given seconds, all as proving, from `from` on. */
const provingFor = (from: number, spans: Array<[number, number]>) => accountTimeline({ sessions: [], jobs: spans.map(([start, end]) => ({ startedAt: null, provedAt: from + end * S, waitWorkerMs: null, notReadyCount: 0, remoteMs: (end - start) * S, workerTotalMs: (end - start) * S })), idleSecondsAt: () => 0 });
/** One span of an hour, billed or not. */
const span = (over: Partial<Span> & { from: number }): Span => ({ to: over.from + HOUR, cutoff: over.from + HOUR, usdPerHour: 1, billed: null, ...over });
const unaccountedFor = (claimed: BucketSeconds, billed: { seconds: number; usd: number }) => {
  const total = totalSeconds(claimed);
  const line = { proving: [[0, total * S]], startingUp: [], waitingForProof: [], unusedEarlyStarts: [], idleAfterJob: [] } as never;
  return breakdownOfSpans(line, [span({ from: 0, to: 4_000_000_000_000, cutoff: 4_000_000_000_000, usdPerHour: 3600, billed })], null).unaccounted;
};

describe("the billing breakdown", () => {
  it("follows the worked example of the header: a cold session, a job after it, a second job during its tail", () => {
    const result = seconds([session({ start: 0, readyAt: at(40), end: 100 })], [job(110, 50), job(190, 50)]);
    expect(result).toEqual({ proving: 100, startingUp: 40, waitingForProof: 70, unusedEarlyStarts: 0, idleAfterJob: 90 });
    expect(totalSeconds(result)).toBe(300);
    expect(unaccountedFor(result, { seconds: 310, usd: 310 })).toEqual({ seconds: 10, usd: 10 });
    expect(unaccountedFor(result, { seconds: 290, usd: 290 })).toEqual({ seconds: -10, usd: -10 });
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
    // A used session that never answered ready proves nothing about a worker, so it claims no time by itself.
    expect(seconds([session({ start: 0, readyAt: null, end: 50 })], [])).toMatchObject({ startingUp: 0, waitingForProof: 0 });
    // The job that took it found a ready worker (not_ready_count 0): still nothing from the session.
    expect(seconds([session({ start: 0, readyAt: null, end: 50 })], [job(60, 30)])).toMatchObject({ startingUp: 0, waitingForProof: 0 });
    // The job that took it met a worker that was not ready: the worker was starting up to the job's request.
    expect(seconds([session({ start: 0, readyAt: null, end: 50 })], [job(60, 30, { waitWorkerMs: 5 * S, notReadyCount: 1 })])).toMatchObject({ startingUp: 60, waitingForProof: 0 });
    // The request cannot start before the session: nothing to claim.
    expect(seconds([session({ start: 100, readyAt: null, end: 150 })], [job(60, 30, { waitWorkerMs: 5 * S, notReadyCount: 1, startedAt: null })]).startingUp).toBe(5);
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
    const timeline = accountTimeline({ sessions: [], jobs: [job(before - 10, 30)], idleSecondsAt: () => 60 });
    const first = bucketSecondsWithin(timeline, midnight - 86_400_000, midnight);
    const second = bucketSecondsWithin(timeline, midnight, midnight + 86_400_000);
    expect(first.proving).toBe(10);
    expect(second.proving).toBe(20);
    expect(first.proving + second.proving).toBe(30);
    expect(first.idleAfterJob + second.idleAfterJob).toBe(60);
  });

  it("prices each day at its own RunPod rate, so that the dollars of unaccounted follow its seconds (cause 1, 2026-11-08)", () => {
    // Two days: day one billed 3600 s at $1.80 an hour, day two 3600 s at $0.72. The records claim 1800 s on each.
    const day1 = Date.UTC(2026, 10, 6);
    const day2 = day1 + DAY;
    const timeline = accountTimeline({
      sessions: [],
      jobs: [
        { startedAt: null, provedAt: day1 + 2 * HOUR, waitWorkerMs: null, notReadyCount: 0, remoteMs: 1800 * S, workerTotalMs: 1800 * S },
        { startedAt: null, provedAt: day2 + 2 * HOUR, waitWorkerMs: null, notReadyCount: 0, remoteMs: 1800 * S, workerTotalMs: 1800 * S },
      ],
      idleSecondsAt: () => 0,
    });
    const rows = [
      { start: "2026-11-06", amountUsd: 1.8, billedSeconds: 3600 },
      { start: "2026-11-07", amountUsd: 0.72, billedSeconds: 3600 },
    ];
    const through = day2 + DAY;
    const parts = rows.map((row, index) => breakdownOfSpans(timeline, [daySpan({ dayStart: day1 + index * DAY, row, hours: [], billedThrough: through, fallbackUsdPerHour: 9 })], through));
    expect(parts.map((part) => part.proving.usd)).toEqual([0.9, 0.36]);
    expect(parts.map((part) => part.unaccounted)).toEqual([{ seconds: 1800, usd: 0.9 }, { seconds: 1800, usd: 0.36 }]);
    const total = sumBreakdowns(parts);
    expect(total.unaccounted).toEqual({ seconds: 3600, usd: 1.26 });
    expect(total.proving).toEqual({ seconds: 3600, usd: 1.26 });
    expect(total.billed).toEqual({ seconds: 7200, usd: 2.52 });
    // Priced at the average rate ($1.26) the two would both be 0.63, and the dollars and the seconds would disagree.
    // A day without billed time uses the fallback rate for its (empty) comparison.
    expect(daySpan({ dayStart: day1, row: { start: "2026-11-06", amountUsd: 0, billedSeconds: 0 }, hours: [], billedThrough: through, fallbackUsdPerHour: 9 })).toMatchObject({ usdPerHour: 9, billed: { seconds: 0, usd: 0 } });
    expect(daySpan({ dayStart: day1, row: undefined, hours: [], billedThrough: null, fallbackUsdPerHour: 9 })).toMatchObject({ usdPerHour: 9, billed: null, cutoff: day1 + DAY });
  });

  it("prices the last 24 hours hour by hour; an hour RunPod billed nothing for is billed nothing (cause 1)", () => {
    const at = Date.UTC(2026, 10, 8, 10, 30);
    const h = (hour: number) => Date.UTC(2026, 10, 8, hour);
    // Proving 600 s in hour 8 (rate $3.6/h) and 600 s in hour 9 (rate $0.36/h), 300 s in hour 5 that has no bill.
    const timeline = accountTimeline({
      sessions: [],
      jobs: [[8, 700], [9, 700], [5, 400]].map(([hour, end]) => ({ startedAt: null, provedAt: h(hour as number) + (end as number) * S, waitWorkerMs: null, notReadyCount: 0, remoteMs: (hour === 5 ? 300 : 600) * S, workerTotalMs: (hour === 5 ? 300 : 600) * S })),
      idleSecondsAt: () => 0,
    });
    const hours = [
      { start: "2026-11-08T08", amountUsd: 1.0, billedSeconds: 1000 },
      { start: "2026-11-08T09", amountUsd: 0.1, billedSeconds: 1000 },
      { start: "2026-11-08T10", amountUsd: 0.01, billedSeconds: 100 },
    ];
    const through = billedThroughOf({ days: [], hours }, at);
    expect(through).toBe(h(10));
    const spans = hourSpans({ at, hours, billedThrough: through, fallbackUsdPerHour: 5 });
    expect(spans).toHaveLength(25);
    const result = breakdownOfSpans(timeline, spans, through);
    // Hour 8: 600 s at $3.6/h = 0.6; hour 9: 600 s at $0.36/h = 0.06; hour 5 has no bill, so it takes the rate of the window
    // (1.11 / 2100 s = $1.9029/h): 300 s = 0.1586.
    expect(result.proving).toEqual({ seconds: 1500, usd: 0.8186 });
    expect(result.billed).toEqual({ seconds: 2000, usd: 1.1 });
    // Unaccounted: hour 8 +400 s ($0.4), hour 9 +400 s ($0.04), hour 5 -300 s against a bill of zero (-$0.1586); the dollars follow each hour's rate.
    expect(result.unaccounted).toEqual({ seconds: 500, usd: 0.2814 });
    expect(result.billedThrough).toBe("2026-11-08T10:00:00.000Z");
  });

  it("applies the idle timeout that was in effect when each job ended (cause 2, 2026-11-08)", () => {
    const change = T + 1000 * S;
    const idleSecondsAt = (when: number) => (when < change ? 60 : 5);
    const jobs = [job(100, 50), job(1100, 50)];
    const result = bucketSecondsWithin(accountTimeline({ sessions: [], jobs, idleSecondsAt }), ...FOREVER);
    // The first job ended at 150 (60 s tail), the second at 1150 (5 s tail).
    expect(result).toMatchObject({ proving: 100, idleAfterJob: 65 });
    // An unused session without billed seconds takes the timeout of the time it ended.
    const old = bucketSecondsWithin(accountTimeline({ sessions: [session({ start: 0, end: 50, outcome: "restart" })], jobs: [], idleSecondsAt }), ...FOREVER);
    const recent = bucketSecondsWithin(accountTimeline({ sessions: [session({ start: 1500, end: 1550, outcome: "restart" })], jobs: [], idleSecondsAt }), ...FOREVER);
    expect(old.unusedEarlyStarts).toBe(110);
    expect(recent.unusedEarlyStarts).toBe(55);
    // A used session waits for its job no longer than the timeout at its end.
    const waits = bucketSecondsWithin(accountTimeline({ sessions: [session({ start: 1000, readyAt: at(1030), end: 1100 })], jobs: [job(1300, 10, { waitWorkerMs: 100 * S, notReadyCount: 1 })], idleSecondsAt }), ...FOREVER);
    expect(waits.waitingForProof).toBe(70 + 5);
  });

  it("leaves out what RunPod has not billed yet, and reports it as not yet billed (cause 3, 2026-11-08)", () => {
    const at = Date.UTC(2026, 10, 8, 4, 20);
    const midnight = Date.UTC(2026, 10, 8);
    // Billing reached hour 02:00; our records have 600 s of proving in 01:00-02:00 (billed 500 s) and 900 s in 03:00-04:00 (not billed yet).
    const timeline = accountTimeline({
      sessions: [],
      jobs: [
        { startedAt: null, provedAt: midnight + HOUR + 700 * S, waitWorkerMs: null, notReadyCount: 0, remoteMs: 600 * S, workerTotalMs: 600 * S },
        { startedAt: null, provedAt: midnight + 3 * HOUR + 900 * S, waitWorkerMs: null, notReadyCount: 0, remoteMs: 900 * S, workerTotalMs: 900 * S },
      ],
      idleSecondsAt: () => 0,
    });
    const spend = {
      days: [{ start: "2026-11-08", amountUsd: 0.5, billedSeconds: 1000 }],
      hours: [
        { start: "2026-11-08T01", amountUsd: 0.25, billedSeconds: 500 },
        { start: "2026-11-08T02", amountUsd: 0.25, billedSeconds: 500 },
      ],
    };
    const through = billedThroughOf(spend, at);
    expect(through).toBe(midnight + 2 * HOUR);
    const day = breakdownOfSpans(timeline, [daySpan({ dayStart: midnight, row: spend.days[0], hours: spend.hours, billedThrough: through, fallbackUsdPerHour: 9 })], through);
    // Compared: the day's bill without the filling hour (500 s, $0.25) against the 600 s proved before it.
    expect(day.billed).toEqual({ seconds: 500, usd: 0.25 });
    expect(day.proving.seconds).toBe(600);
    expect(day.unaccounted).toEqual({ seconds: -100, usd: -0.05 });
    expect(day.notYetBilled).toEqual({ seconds: 900, usd: 0.45 });
    expect(day.billedThrough).toBe("2026-11-08T02:00:00.000Z");
    // Without the lag handling the day would show 1000 - 1500 = -500 s.
    const last24h = breakdownOfSpans(timeline, hourSpans({ at, hours: spend.hours, billedThrough: through, fallbackUsdPerHour: 9 }), through);
    expect(last24h.notYetBilled.seconds).toBe(900);
    expect(last24h.unaccounted).toEqual({ seconds: -100, usd: -0.05 });
    // A day that starts after the billing has reached has nothing to compare; RunPod reading nothing leaves the start of the day.
    const next = breakdownOfSpans(timeline, [daySpan({ dayStart: midnight + DAY, row: { start: "2026-11-09", amountUsd: 1, billedSeconds: 10 }, hours: [], billedThrough: through, fallbackUsdPerHour: 9 })], through);
    expect(next.unaccounted).toBeNull();
    expect(billedThroughOf({ days: [], hours: [] }, at)).toBe(midnight);
    expect(billedThroughOf({ days: [], hours: [{ start: "2026-11-08T03", amountUsd: 0, billedSeconds: 0 }] }, at)).toBe(midnight);
    expect(billedThroughOf(null, at)).toBeNull();
  });

  it("keeps a small negative that real records cause: more proving claimed than billed, over a complete period", () => {
    const timeline = provingFor(0, [[0, 600]]);
    const result = breakdownOfSpans(timeline, [span({ from: 0, to: 3_600_000, cutoff: 3_600_000, usdPerHour: 3.6, billed: { seconds: 590, usd: 0.59 } })], 4_000_000);
    expect(result.unaccounted).toEqual({ seconds: -10, usd: -0.01 });
    expect(ZERO.proving).toBe(0);
  });

  it("adds days; unaccounted and billed add the days that have one, notYetBilled all, and nothing is null for no days", () => {
    const line = provingFor(0, [[0, 100]]);
    const a = breakdownOfSpans(line, [span({ from: 0, to: 1_000_000, cutoff: 1_000_000, usdPerHour: 3600, billed: { seconds: 130, usd: 130 } })], 5000);
    const b = breakdownOfSpans(line, [span({ from: 0, to: 1_000_000, cutoff: 1_000_000, usdPerHour: 3600 })], null);
    const c = breakdownOfSpans(line, [span({ from: 0, to: 1_000_000, cutoff: 50_000, usdPerHour: 3600, billed: { seconds: 20, usd: 20 } })], 50_000);
    expect(a.unaccounted).toEqual({ seconds: 30, usd: 30 });
    expect(b.unaccounted).toBeNull();
    expect(b.billedThrough).toBeNull();
    expect(c.notYetBilled).toEqual({ seconds: 50, usd: 50 });
    const total = sumBreakdowns([a, b, c]);
    expect(total.proving).toEqual({ seconds: 250, usd: 250 });
    expect(total.unaccounted).toEqual({ seconds: 30 + -30, usd: 0 });
    expect(total.notYetBilled).toEqual({ seconds: 50, usd: 50 });
    expect(total.billedThrough).toBe(new Date(5000).toISOString());
    expect(sumBreakdowns([b]).unaccounted).toBeNull();
    expect(sumBreakdowns([b]).billed).toBeNull();
    expect(sumBreakdowns([])).toMatchObject({ proving: { seconds: 0, usd: 0 }, notYetBilled: { seconds: 0, usd: 0 }, billedThrough: null });
  });

  it("counts the buckets of a day that RunPod has no figure for, outside the comparison", () => {
    const line = provingFor(0, [[0, 100]]);
    const mixed = breakdownOfSpans(line, [span({ from: 0, to: 1_000_000, cutoff: 1_000_000, usdPerHour: 3600, billed: { seconds: 150, usd: 150 } }), span({ from: 1_000_000, to: 2_000_000, cutoff: 2_000_000, usdPerHour: 3600 })], null);
    expect(mixed.unaccounted).toEqual({ seconds: 50, usd: 50 });
  });
});
