/**
 * Where the billed GPU seconds went. Pure: no clock, no database, no network.
 *
 * RunPod bills a worker for every second it is up: from the start of the cold start, through the proofs, until the
 * endpoint's idle timeout after the last request. The timeout changed over time (60 s until 2026-11-08 01:59 UTC, then
 * 5 s; `idle_timeout_history`, `idle-history.ts`), so every job's tail uses the timeout that was in effect when the job
 * ended (`idleSecondsAt`), not today's. Our records say what that
 * time was for: the warm-up sessions (`warmup_sessions`) and the proof jobs (`job_timings`). Each record is turned into
 * time intervals on one timeline, each interval belongs to one bucket, and an instant belongs to only one bucket, the
 * first that claims it in this order:
 *
 *   1. proving            the worker runs a proof job. The job's `worker_total_ms` (the whole request on the worker,
 *                         including `worker_queue_ms`, the wait for the GPU behind another proof) or, when the worker
 *                         reported none, `remote_ms` (the accepted request, an upper bound that also holds RunPod's wait
 *                         to allocate a GPU, which RunPod does not bill), ending at `proved_at`:
 *                         [proved_at - D, proved_at]. A job without `remote_ms` (an older prover) counts from its
 *                         own `started_at`. The local build and native run before the request, the verification
 *                         after it and the part of the request outside the worker (`remote_overhead_ms`: network,
 *                         proxy, a start that RunPod hid inside the request) are not claimed.
 *   2. startingUp         the cold start, before a worker can take work:
 *                         - a session, from `started_at` to `ready_at`, when that took 5 s or more
 *                           (`COLD_START_FLOOR_SECONDS`; a faster answer found a worker that was up already);
 *                           a used session that never answered ready (`ready_at` null) claims nothing of its own, since
 *                           no record says that a worker ran: only when the job that took it met a worker that was
 *                           not ready too (`not_ready_count` above 0) was the worker starting, and then it counts from
 *                           the session's start to that job's request. Its billed time beyond that stays unaccounted;
 *                         - a job that was answered "not ready" (`not_ready_count` above 0) and waited
 *                           `wait_worker_ms`, ending where its accepted request starts (`proved_at - remote_ms`).
 *   3. waitingForProof    a ready worker with nothing to do before its proof: in a used session, from `ready_at`
 *                         (from `started_at` for a warm answer) to the start of the job's request, but not longer
 *                         than the idle timeout after the session's end (then the worker had stopped, and the rest
 *                         is start-up of the job). Without a job found, up to the session's end.
 *   4. unusedEarlyStarts  a session that did not end `used`: all of its billed time, from `started_at` for
 *                         `billed_seconds` (its start-up, its waiting and the idle timeout after its last ping).
 *   5. idleAfterJob       the idle timeout after each proof: [proved_at, proved_at + idle timeout].
 *
 * Because an instant counts once, an idle tail that a following job, a following session or another tail overlaps is
 * counted only up to where the next claim starts. The billed seconds of a used session are not taken as a whole: they
 * end with an idle timeout that the job's own proving and tail overlap, so only the start-up and the waiting count.
 * `unaccounted` is what RunPod billed minus all five. It holds what no record covers: failed jobs, local build time, the
 * worker overhead of a request, and billing granularity.
 *
 * What is compared, and how it is priced (so that `unaccounted` means something):
 *
 *   - Each period is priced at its own RunPod effective rate (the bill of the period divided by its billed hours): a
 *     day at its day's rate, the last 24 hours hour by hour at each hour's rate. Seconds and dollars of every bucket,
 *     `unaccounted` included, then agree: usd = seconds x the rate of the period, within rounding. A total is the sum
 *     of its days. A period without a rate of its own (no billed time) uses the 7-day rate, else the configured price.
 *   - RunPod's bill lags. The latest hour bucket RunPod returns is taken as still filling: `billedThrough` is its start
 *     (or the start of the UTC day when RunPod returned no hour). Only time before it is compared; our records after
 *     it are `notYetBilled` (seconds, and dollars at the period's rate, an estimate), never part of `unaccounted`.
 *     `buckets + unaccounted` add up to `billed`, the bill up to `billedThrough`.
 *   - `unaccounted` can still be negative, from genuine disagreement between record and bill. The main cause is proving
 *     being an upper bound for a job whose worker reported no `worker_total_ms` (an image that predates the field):
 *     `remote_ms` is the whole accepted request, and when RunPod was slow to allocate a GPU the load balancer held the
 *     request for that wait, which RunPod does not bill. The hours with such waits over-claim by about the wait, while
 *     the hours without agree. (RunPod's load-balancing endpoint, which this prover calls, returns no `executionTime`
 *     or `delayTime`: those belong to queue endpoints. The worker's own `timings` are the only measure.) A negative
 *     that stays large when every job reports `worker_total_ms` is a real mismatch: records that claim time RunPod did
 *     not bill.
 *
 * Worked example (idle timeout 60 s, times in seconds). A session starts at 0, answers ready at 40 (a cold start of
 * 40 s), and ends `used` at 100 when a job begins. The job's request starts at 110 and the worker proves for 50 s, so
 * the proof returns at 160. A second job's request starts at 190 and proves until 240.
 *
 *   startingUp       0 to 40                        = 40
 *   waitingForProof  40 to 110 (to the request)     = 70
 *   proving          110 to 160 and 190 to 240      = 100
 *   idleAfterJob     the tail of job 1 is 160 to 220, but the second job claims 190 onward, so 160 to 190 = 30;
 *                    the tail of job 2 is 240 to 300                                        = 60  => 90
 *   unusedEarlyStarts 0
 *   Sum 300 s. If RunPod billed 310 s, unaccounted is 10 s; if it billed 290 s, unaccounted is -10 s.
 *
 * A session that never answered ready (`ready_at` null), used at 50 s by a job whose request starts at 60 s:
 *   - the job was answered "ready" at once: startingUp 0, waitingForProof 0 (the session claims nothing);
 *   - the job was answered "not ready" first (and waited 5 s, 55 to 60): startingUp 0 to 60 = 60 s (the job's own wait,
 *     55 to 60, lies inside it and counts once).
 */
import type { BillingBucket } from "./billing.ts";
import { COLD_START_FLOOR_SECONDS } from "./watch/warmup.ts";

/** The buckets, in the order that they claim time. `unaccounted` is not here: it is the bill minus these. */
export const BUCKETS = ["proving", "startingUp", "waitingForProof", "unusedEarlyStarts", "idleAfterJob"] as const;
export type Bucket = (typeof BUCKETS)[number];

/** A warm-up session that has ended. Times in milliseconds since 1970. */
export type SessionRecord = {
  readonly startedAt: number;
  readonly readyAt: number | null;
  readonly endedAt: number;
  /** How the session ended; `used` means that a job started on its worker. Anything else is an unused early start. */
  readonly outcome: string | null;
  /** Billed seconds as recorded when it ended, or null for an old record. */
  readonly billedSeconds: number | null;
};

/** A proof job that was proved, with the timing fields that the prover reported (null where it did not). */
export type JobRecord = {
  readonly startedAt: number | null;
  readonly provedAt: number;
  readonly waitWorkerMs: number | null;
  readonly notReadyCount: number | null;
  readonly remoteMs: number | null;
  readonly workerTotalMs: number | null;
};

type Interval = readonly [number, number];

/** Sorted, non-overlapping, non-empty intervals. */
function union(intervals: readonly Interval[]): Interval[] {
  const sorted = intervals.filter(([from, to]) => to > from).sort((left, right) => left[0] - right[0]);
  const merged: Array<[number, number]> = [];
  for (const [from, to] of sorted) {
    const last = merged[merged.length - 1];
    if (last !== undefined && from <= last[1]) last[1] = Math.max(last[1], to);
    else merged.push([from, to]);
  }
  return merged;
}

/** `from` without the parts that `taken` covers; both normalised. */
function subtract(from: readonly Interval[], taken: readonly Interval[]): Interval[] {
  const result: Interval[] = [];
  for (const [start, end] of from) {
    let cursor = start;
    for (const [takenStart, takenEnd] of taken) {
      if (takenEnd <= cursor) continue;
      if (takenStart >= end) break;
      if (takenStart > cursor) result.push([cursor, takenStart]);
      cursor = Math.max(cursor, takenEnd);
    }
    if (cursor < end) result.push([cursor, end]);
  }
  return result;
}

/** Seconds of `intervals` that fall inside [from, to). */
function secondsWithin(intervals: readonly Interval[], from: number, to: number): number {
  let total = 0;
  for (const [start, end] of intervals) total += Math.max(0, Math.min(end, to) - Math.max(start, from));
  return total / 1000;
}

/** The time of every bucket on the timeline; each instant is in at most one. */
export type BucketTimeline = Readonly<Record<Bucket, readonly Interval[]>>;

/** The seconds of every bucket. */
export type BucketSeconds = Readonly<Record<Bucket, number>>;

/** Builds the timeline of the buckets from the sessions and jobs. */
export function accountTimeline(input: { sessions: readonly SessionRecord[]; jobs: readonly JobRecord[]; idleSecondsAt: (atMilliseconds: number) => number }): BucketTimeline {
  const idleMsAt = (at: number) => input.idleSecondsAt(at) * 1000;
  const raw: Record<Bucket, Interval[]> = { proving: [], startingUp: [], waitingForProof: [], unusedEarlyStarts: [], idleAfterJob: [] };

  // Where each job's request starts, and whether the job met a worker that was not ready (a start-up it saw itself).
  const requests: Array<{ start: number; metColdWorker: boolean }> = [];
  for (const job of input.jobs) {
    const request = job.remoteMs;
    const duration = job.workerTotalMs ?? request;
    if (duration === null) {
      raw.proving.push([job.startedAt ?? job.provedAt, job.provedAt]);
    } else {
      raw.proving.push([job.provedAt - duration, job.provedAt]);
      if (request !== null) {
        const requestStart = job.provedAt - request;
        const metColdWorker = (job.notReadyCount ?? 0) > 0;
        requests.push({ start: requestStart, metColdWorker });
        if (metColdWorker && job.waitWorkerMs !== null) raw.startingUp.push([requestStart - job.waitWorkerMs, requestStart]);
      }
    }
    raw.idleAfterJob.push([job.provedAt, job.provedAt + idleMsAt(job.provedAt)]);
  }
  requests.sort((left, right) => left.start - right.start);

  for (const session of input.sessions) {
    if (session.outcome !== "used") {
      const billed = session.billedSeconds ?? (session.endedAt - session.startedAt) / 1000 + input.idleSecondsAt(session.endedAt);
      raw.unusedEarlyStarts.push([session.startedAt, session.startedAt + billed * 1000]);
      continue;
    }
    const ready = session.readyAt;
    const cold = ready === null || ready - session.startedAt >= COLD_START_FLOOR_SECONDS * 1000;
    // The job that took the worker: the first request that starts from shortly before the session's end.
    const request = requests.find((candidate) => candidate.start >= session.endedAt - 120_000);
    const waitEnd = request === undefined ? session.endedAt : Math.min(request.start, session.endedAt + idleMsAt(session.endedAt));
    if (ready === null) {
      // No answer of "ready" came, so no record says that a worker ran. The worker was starting up only when the job
      // that took the session met a worker that was not ready too; then until that job's request.
      if (request?.metColdWorker === true) raw.startingUp.push([session.startedAt, request.start]);
    } else if (cold) {
      raw.startingUp.push([session.startedAt, ready]);
      raw.waitingForProof.push([ready, waitEnd]);
    } else {
      raw.waitingForProof.push([session.startedAt, waitEnd]);
    }
  }

  const timeline = {} as Record<Bucket, Interval[]>;
  let taken: Interval[] = [];
  for (const bucket of BUCKETS) {
    timeline[bucket] = subtract(union(raw[bucket]), taken);
    taken = union([...taken, ...timeline[bucket]]);
  }
  return timeline;
}

/** The seconds of every bucket inside [from, to), in milliseconds since 1970. */
export function bucketSecondsWithin(timeline: BucketTimeline, from: number, to: number): BucketSeconds {
  const seconds = {} as Record<Bucket, number>;
  for (const bucket of BUCKETS) seconds[bucket] = secondsWithin(timeline[bucket], from, to);
  return seconds;
}

/** The sum of the bucket seconds. */
export function totalSeconds(seconds: BucketSeconds): number {
  return BUCKETS.reduce((sum, bucket) => sum + seconds[bucket], 0);
}

/** Seconds and USD of one bucket. */
export type Amount = { readonly seconds: number; readonly usd: number };

/**
 * The breakdown of a period, compared with the bill up to `billedThrough`. `billed` is that bill (null when RunPod has
 * no figure), `unaccounted` is `billed` minus the buckets (null without a bill), `notYetBilled` is our records after
 * `billedThrough` (an estimate at the period's rate), and `billedThrough` is ISO or null when RunPod could not be read.
 */
export type Breakdown = Readonly<Record<Bucket, Amount>> & {
  readonly unaccounted: Amount | null;
  readonly billed: Amount | null;
  readonly notYetBilled: Amount;
  readonly billedThrough: string | null;
};

/** A stretch of time with one RunPod rate: a UTC day or an hour. */
export type Span = {
  readonly from: number;
  readonly to: number;
  /** Where the comparison stops, from `from` to `to`: the bill is known before it, and our records after it are not yet billed. */
  readonly cutoff: number;
  readonly usdPerHour: number;
  /** The bill of [from, cutoff), or null when RunPod has no figure for it or the span is not billed yet. */
  readonly billed: Amount | null;
};

const roundTo = (value: number, places: number) => Math.round(value * 10 ** places) / 10 ** places;
const zero: Amount = { seconds: 0, usd: 0 };
const HOUR = 3_600_000;
const DAY = 86_400_000;
const clamp = (value: number, low: number, high: number) => Math.min(high, Math.max(low, value));
const hourStart = (at: number) => Math.floor(at / HOUR) * HOUR;
const hourKey = (at: number) => new Date(at).toISOString().slice(0, 13);

/** The spend as RunPod returned it: days and hours, oldest first (the hour and the day cut to `YYYY-MM-DDTHH` and `YYYY-MM-DD`). */
export type Spend = { readonly days: readonly BillingBucket[]; readonly hours: readonly BillingBucket[] };

/**
 * How far RunPod's billing has reached, in milliseconds: the start of its latest hour bucket with billed time (that hour
 * may still be filling, so it is not compared), else the start of the UTC day of `at`. Null when RunPod was not read.
 */
export function billedThroughOf(spend: Spend | null, at: number): number | null {
  if (spend === null) return null;
  const latest = spend.hours.filter((hour) => hour.billedSeconds > 0 || hour.amountUsd > 0).pop();
  return latest === undefined ? Math.floor(at / DAY) * DAY : Date.parse(`${latest.start}:00:00Z`);
}

/** The span of a UTC day: its bill (the day's, less the hours after the cutoff when the cutoff falls inside it) at the day's own rate. */
export function daySpan(input: { dayStart: number; row: BillingBucket | undefined; hours: readonly BillingBucket[]; billedThrough: number | null; fallbackUsdPerHour: number }): Span {
  const { dayStart, row, hours, billedThrough, fallbackUsdPerHour } = input;
  const to = dayStart + DAY;
  const cutoff = billedThrough === null ? to : clamp(billedThrough, dayStart, to);
  const rate = row !== undefined && row.billedSeconds > 0 ? row.amountUsd / (row.billedSeconds / 3600) : fallbackUsdPerHour;
  let billed: Amount | null = null;
  if (row !== undefined && cutoff > dayStart) {
    if (cutoff === to) billed = { seconds: roundTo(row.billedSeconds, 2), usd: roundTo(row.amountUsd, 4) };
    else {
      const after = hours.filter((hour) => Date.parse(`${hour.start}:00:00Z`) >= cutoff && Date.parse(`${hour.start}:00:00Z`) < to).reduce((sum, hour) => sum + hour.billedSeconds, 0);
      const seconds = Math.max(0, row.billedSeconds - after);
      billed = { seconds: roundTo(seconds, 2), usd: roundTo((seconds / 3600) * rate, 4) };
    }
  }
  return { from: dayStart, to, cutoff, usdPerHour: rate, billed };
}

/**
 * The spans of the last 24 hours, one per hour from the hour that holds `at - 24 h` to the hour of `at`, each at its own
 * hour's rate (an hour with no billed time uses the rate of the whole window, else `fallbackUsdPerHour`). An hour before
 * `billedThrough` that RunPod has no row for was billed nothing.
 */
export function hourSpans(input: { at: number; hours: readonly BillingBucket[]; billedThrough: number | null; fallbackUsdPerHour: number }): Span[] {
  const { at, hours, billedThrough, fallbackUsdPerHour } = input;
  const first = hourStart(at - DAY);
  const rows = new Map(hours.map((hour) => [hour.start, hour]));
  const inWindow = [...rows.values()].filter((hour) => Date.parse(`${hour.start}:00:00Z`) >= first);
  const seconds = inWindow.reduce((sum, hour) => sum + hour.billedSeconds, 0);
  const windowRate = seconds > 0 ? inWindow.reduce((sum, hour) => sum + hour.amountUsd, 0) / (seconds / 3600) : fallbackUsdPerHour;
  const spans: Span[] = [];
  for (let from = first; from <= at; from += HOUR) {
    const to = from + HOUR;
    const row = rows.get(hourKey(from));
    const cutoff = billedThrough === null ? to : clamp(billedThrough, from, to);
    const billed: Amount | null = billedThrough === null || cutoff < to ? null : row === undefined ? zero : { seconds: roundTo(row.billedSeconds, 2), usd: roundTo(row.amountUsd, 4) };
    spans.push({ from, to, cutoff, usdPerHour: row !== undefined && row.billedSeconds > 0 ? row.amountUsd / (row.billedSeconds / 3600) : windowRate, billed });
  }
  return spans;
}

/** The breakdown of spans: the buckets before each cutoff at the span's rate, `unaccounted` against the bill, the rest as `notYetBilled`. */
export function breakdownOfSpans(timeline: BucketTimeline, spans: readonly Span[], billedThrough: number | null): Breakdown {
  const seconds = Object.fromEntries(BUCKETS.map((bucket) => [bucket, 0])) as Record<Bucket, number>;
  const usd = { ...seconds };
  let billedSeconds = 0;
  let billedUsd = 0;
  let claimedSeconds = 0;
  let claimedUsd = 0;
  let anyBilled = false;
  let restSeconds = 0;
  let restUsd = 0;
  for (const span of spans) {
    const compared = bucketSecondsWithin(timeline, span.from, span.cutoff);
    const rest = totalSeconds(bucketSecondsWithin(timeline, span.cutoff, span.to));
    restSeconds += rest;
    restUsd += (rest / 3600) * span.usdPerHour;
    let claimed = 0;
    for (const bucket of BUCKETS) {
      seconds[bucket] += compared[bucket];
      usd[bucket] += (compared[bucket] / 3600) * span.usdPerHour;
      claimed += compared[bucket];
    }
    if (span.billed !== null) {
      anyBilled = true;
      billedSeconds += span.billed.seconds;
      billedUsd += span.billed.usd;
      claimedSeconds += claimed;
      claimedUsd += (claimed / 3600) * span.usdPerHour;
    }
  }
  const buckets = {} as Record<Bucket, Amount>;
  for (const bucket of BUCKETS) buckets[bucket] = { seconds: roundTo(seconds[bucket], 2), usd: roundTo(usd[bucket], 4) };
  // With every span billed the buckets add up to the bill as shown; otherwise only the billed spans count.
  const shown = BUCKETS.reduce((sum, bucket) => ({ seconds: sum.seconds + buckets[bucket].seconds, usd: sum.usd + buckets[bucket].usd }), { seconds: 0, usd: 0 });
  const allBilled = spans.every((span) => span.billed !== null);
  return {
    ...buckets,
    unaccounted: anyBilled ? (allBilled ? { seconds: roundTo(billedSeconds - shown.seconds, 2), usd: roundTo(billedUsd - shown.usd, 4) } : { seconds: roundTo(billedSeconds - claimedSeconds, 2), usd: roundTo(billedUsd - claimedUsd, 4) }) : null,
    billed: anyBilled ? { seconds: roundTo(billedSeconds, 2), usd: roundTo(billedUsd, 4) } : null,
    notYetBilled: { seconds: roundTo(restSeconds, 2), usd: roundTo(restUsd, 4) },
    billedThrough: billedThrough === null ? null : new Date(billedThrough).toISOString(),
  };
}

/** Adds breakdowns (the days of a total). `unaccounted` and `billed` sum the days that have one, and are null when none does. */
export function sumBreakdowns(parts: readonly Breakdown[]): Breakdown {
  const add = (pick: (part: Breakdown) => Amount | null): Amount | null => {
    const amounts = parts.map(pick).filter((entry): entry is Amount => entry !== null);
    return amounts.length === 0 ? null : { seconds: roundTo(amounts.reduce((sum, entry) => sum + entry.seconds, 0), 2), usd: roundTo(amounts.reduce((sum, entry) => sum + entry.usd, 0), 4) };
  };
  const total = {} as Record<Bucket, Amount>;
  for (const bucket of BUCKETS) total[bucket] = add((part) => part[bucket]) ?? zero;
  return {
    ...total,
    unaccounted: add((part) => part.unaccounted),
    billed: add((part) => part.billed),
    notYetBilled: add((part) => part.notYetBilled) ?? zero,
    billedThrough: parts.find((part) => part.billedThrough !== null)?.billedThrough ?? null,
  };
}
