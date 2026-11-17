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
/** The comparison of `claimed` seconds, priced at $3600 an hour (one dollar a second), with a bill of `billedUsd`. RunPod's bill has no seconds. */
const unaccountedFor = (claimed: BucketSeconds, billedUsd: number) => {
  const total = totalSeconds(claimed);
  const line = { proving: [[0, total * S]], startingUp: [], waitingForProof: [], unusedEarlyStarts: [], idleAfterJob: [] } as never;
  return breakdownOfSpans(line, [span({ from: 0, to: 4_000_000_000_000, cutoff: 4_000_000_000_000, usdPerHour: 3600, billed: { seconds: null, usd: billedUsd } })], null).unaccounted;
};

describe("the billing breakdown", () => {
  it("follows the worked example of the header: a cold session, a job after it, a second job during its tail", () => {
    const result = seconds([session({ start: 0, readyAt: at(40), end: 100 })], [job(110, 50), job(190, 50)]);
    expect(result).toEqual({ proving: 100, startingUp: 40, waitingForProof: 70, unusedEarlyStarts: 0, idleAfterJob: 90 });
    expect(totalSeconds(result)).toBe(300);
    // RunPod gives dollars only: the seconds of what it billed are unknown, and the dollars are compared with our buckets' dollars.
    expect(unaccountedFor(result, 310)).toEqual({ seconds: null, usd: 10 });
    expect(unaccountedFor(result, 290)).toEqual({ seconds: null, usd: -10 });
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

  it("prices our buckets at the configured rate and compares their dollars with RunPod's dollars of each day; RunPod's seconds are unknown", () => {
    // Two days: RunPod billed $2.70 and $1.00. The records claim 1800 s of proving on each; at the configured $3.6 an hour that is $1.80.
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
      { start: "2026-11-06", amountUsd: 2.7 },
      { start: "2026-11-07", amountUsd: 1 },
    ];
    const through = day2 + DAY;
    const parts = rows.map((row, index) => breakdownOfSpans(timeline, [daySpan({ dayStart: day1 + index * DAY, row, hours: [], billedThrough: through, fallbackUsdPerHour: 3.6 })], through));
    expect(parts.map((part) => part.proving)).toEqual([{ seconds: 1800, usd: 1.8 }, { seconds: 1800, usd: 1.8 }]);
    expect(parts.map((part) => part.billed)).toEqual([{ seconds: null, usd: 2.7 }, { seconds: null, usd: 1 }]);
    expect(parts.map((part) => part.unaccounted)).toEqual([{ seconds: null, usd: 0.9 }, { seconds: null, usd: -0.8 }]);
    const total = sumBreakdowns(parts);
    expect(total.unaccounted).toEqual({ seconds: null, usd: 0.1 });
    expect(total.proving).toEqual({ seconds: 3600, usd: 3.6 });
    expect(total.billed).toEqual({ seconds: null, usd: 3.7 });
    // The span of a day is priced at the configured rate whatever the day's amount, and a day without a row has no bill.
    expect(daySpan({ dayStart: day1, row: { start: "2026-11-06", amountUsd: 0 }, hours: [], billedThrough: through, fallbackUsdPerHour: 9 })).toMatchObject({ usdPerHour: 9, billed: { seconds: null, usd: 0 } });
    expect(daySpan({ dayStart: day1, row: undefined, hours: [], billedThrough: null, fallbackUsdPerHour: 9 })).toMatchObject({ usdPerHour: 9, billed: null, cutoff: day1 + DAY });
  });

  it("prices the last 24 hours at the configured rate against RunPod's dollars of each hour; an hour RunPod billed nothing for is billed nothing", () => {
    const at = Date.UTC(2026, 10, 8, 10, 30);
    const h = (hour: number) => Date.UTC(2026, 10, 8, hour);
    // Proving 600 s in hour 8, 600 s in hour 9 and 300 s in hour 5, which has no bill.
    const timeline = accountTimeline({
      sessions: [],
      jobs: [[8, 700], [9, 700], [5, 400]].map(([hour, end]) => ({ startedAt: null, provedAt: h(hour as number) + (end as number) * S, waitWorkerMs: null, notReadyCount: 0, remoteMs: (hour === 5 ? 300 : 600) * S, workerTotalMs: (hour === 5 ? 300 : 600) * S })),
      idleSecondsAt: () => 0,
    });
    const hours = [
      { start: "2026-11-08T08", amountUsd: 1.0 },
      { start: "2026-11-08T09", amountUsd: 0.1 },
      { start: "2026-11-08T10", amountUsd: 0.01 },
    ];
    const through = billedThroughOf({ days: [], hours }, at);
    expect(through).toBe(h(10));
    const spans = hourSpans({ at, hours, billedThrough: through, fallbackUsdPerHour: 3.6 });
    expect(spans).toHaveLength(25);
    expect(new Set(spans.map((entry) => entry.usdPerHour))).toEqual(new Set([3.6]));
    const result = breakdownOfSpans(timeline, spans, through);
    // 1500 s at $3.6 an hour is $1.50 (0.6 + 0.6 + 0.3); RunPod billed $1.10 up to hour 10, which is still filling.
    expect(result.proving).toEqual({ seconds: 1500, usd: 1.5 });
    expect(result.billed).toEqual({ seconds: null, usd: 1.1 });
    expect(result.unaccounted).toEqual({ seconds: null, usd: -0.4 });
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
    // Billing reached hour 02:00 ($0.25 for 01:00-02:00, $0.25 for the filling 02:00 hour); our records have 600 s of proving in 01:00-02:00 and 900 s in 03:00-04:00 (not billed yet).
    const timeline = accountTimeline({
      sessions: [],
      jobs: [
        { startedAt: null, provedAt: midnight + HOUR + 700 * S, waitWorkerMs: null, notReadyCount: 0, remoteMs: 600 * S, workerTotalMs: 600 * S },
        { startedAt: null, provedAt: midnight + 3 * HOUR + 900 * S, waitWorkerMs: null, notReadyCount: 0, remoteMs: 900 * S, workerTotalMs: 900 * S },
      ],
      idleSecondsAt: () => 0,
    });
    const spend = {
      days: [{ start: "2026-11-08", amountUsd: 0.5 }],
      hours: [
        { start: "2026-11-08T01", amountUsd: 0.25 },
        { start: "2026-11-08T02", amountUsd: 0.25 },
      ],
    };
    const through = billedThroughOf(spend, at);
    expect(through).toBe(midnight + 2 * HOUR);
    const day = breakdownOfSpans(timeline, [daySpan({ dayStart: midnight, row: spend.days[0], hours: spend.hours, billedThrough: through, fallbackUsdPerHour: 0.9 })], through);
    // Compared: the day's dollars without the filling hour ($0.25) against the 600 s proved before it, at $0.9 an hour ($0.15).
    expect(day.billed).toEqual({ seconds: null, usd: 0.25 });
    expect(day.proving).toEqual({ seconds: 600, usd: 0.15 });
    expect(day.unaccounted).toEqual({ seconds: null, usd: 0.1 });
    expect(day.notYetBilled).toEqual({ seconds: 900, usd: 0.225 });
    expect(day.billedThrough).toBe("2026-11-08T02:00:00.000Z");
    const last24h = breakdownOfSpans(timeline, hourSpans({ at, hours: spend.hours, billedThrough: through, fallbackUsdPerHour: 0.9 }), through);
    expect(last24h.notYetBilled.seconds).toBe(900);
    expect(last24h.unaccounted).toEqual({ seconds: null, usd: 0.1 });
    // A day that starts after the billing has reached has nothing to compare; RunPod reading nothing leaves the start of the day.
    const next = breakdownOfSpans(timeline, [daySpan({ dayStart: midnight + DAY, row: { start: "2026-11-09", amountUsd: 1 }, hours: [], billedThrough: through, fallbackUsdPerHour: 9 })], through);
    expect(next.unaccounted).toBeNull();
    expect(billedThroughOf({ days: [], hours: [] }, at)).toBe(midnight);
    expect(billedThroughOf({ days: [], hours: [{ start: "2026-11-08T03", amountUsd: 0 }] }, at)).toBe(midnight);
    expect(billedThroughOf(null, at)).toBeNull();
    // A cutoff inside the day takes the filling hours' dollars off the day's, and never goes below zero.
    const small = daySpan({ dayStart: midnight, row: { start: "2026-11-08", amountUsd: 0.1 }, hours: spend.hours, billedThrough: through, fallbackUsdPerHour: 0.9 });
    expect(small.billed).toEqual({ seconds: null, usd: 0 });
  });

  it("keeps a small negative that real records cause: more proving claimed than billed, over a complete period", () => {
    const timeline = provingFor(0, [[0, 600]]);
    const result = breakdownOfSpans(timeline, [span({ from: 0, to: 3_600_000, cutoff: 3_600_000, usdPerHour: 3.6, billed: { seconds: null, usd: 0.59 } })], 4_000_000);
    expect(result.unaccounted).toEqual({ seconds: null, usd: -0.01 });
    expect(ZERO.proving).toBe(0);
  });

  it("adds days; unaccounted and billed add the days that have one, notYetBilled all, and nothing is null for no days", () => {
    const line = provingFor(0, [[0, 100]]);
    const a = breakdownOfSpans(line, [span({ from: 0, to: 1_000_000, cutoff: 1_000_000, usdPerHour: 3600, billed: { seconds: null, usd: 130 } })], 5000);
    const b = breakdownOfSpans(line, [span({ from: 0, to: 1_000_000, cutoff: 1_000_000, usdPerHour: 3600 })], null);
    const c = breakdownOfSpans(line, [span({ from: 0, to: 1_000_000, cutoff: 50_000, usdPerHour: 3600, billed: { seconds: null, usd: 20 } })], 50_000);
    expect(a.unaccounted).toEqual({ seconds: null, usd: 30 });
    expect(b.unaccounted).toBeNull();
    expect(b.billedThrough).toBeNull();
    expect(c.notYetBilled).toEqual({ seconds: 50, usd: 50 });
    const total = sumBreakdowns([a, b, c]);
    expect(total.proving).toEqual({ seconds: 250, usd: 250 });
    expect(total.unaccounted).toEqual({ seconds: null, usd: 0 });
    expect(total.billed).toEqual({ seconds: null, usd: 150 });
    expect(total.notYetBilled).toEqual({ seconds: 50, usd: 50 });
    expect(total.billedThrough).toBe(new Date(5000).toISOString());
    expect(sumBreakdowns([b]).unaccounted).toBeNull();
    expect(sumBreakdowns([b]).billed).toBeNull();
    expect(sumBreakdowns([])).toMatchObject({ proving: { seconds: 0, usd: 0 }, notYetBilled: { seconds: 0, usd: 0 }, billedThrough: null });
  });

  it("counts the buckets of a day that RunPod has no figure for, outside the comparison", () => {
    const line = provingFor(0, [[0, 100]]);
    const mixed = breakdownOfSpans(line, [span({ from: 0, to: 1_000_000, cutoff: 1_000_000, usdPerHour: 3600, billed: { seconds: null, usd: 150 } }), span({ from: 1_000_000, to: 2_000_000, cutoff: 2_000_000, usdPerHour: 3600 })], null);
    expect(mixed.unaccounted).toEqual({ seconds: null, usd: 50 });
  });
});
