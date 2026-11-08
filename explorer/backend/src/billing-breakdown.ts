/**
 * Where the billed GPU seconds went. Pure: no clock, no database, no network.
 *
 * RunPod bills a worker for every second it is up: from the start of the cold start, through the proofs, until the
 * endpoint's idle timeout (`watch.warmup.idleTimeoutSeconds`, 60 s) after the last request. Our records say what that
 * time was for: the warm-up sessions (`warmup_sessions`) and the proof jobs (`job_timings`). Each record is turned into
 * time intervals on one timeline, each interval belongs to one bucket, and an instant belongs to only one bucket, the
 * first that claims it in this order:
 *
 *   1. proving            the worker runs a proof job. The job's `worker_total_ms` (the whole request on the worker,
 *                         including `worker_queue_ms`, the wait for the GPU behind another proof) or, when the worker
 *                         reported none, `remote_ms` (the accepted request, an upper bound), ending at `proved_at`:
 *                         [proved_at - D, proved_at]. A job without `remote_ms` (an older prover) counts from its
 *                         own `started_at`. The local build and native run before the request, the verification
 *                         after it and the part of the request outside the worker (`remote_overhead_ms`: network,
 *                         proxy, a start that RunPod hid inside the request) are not claimed.
 *   2. startingUp         the cold start, before a worker can take work:
 *                         - a session, from `started_at` to `ready_at`, when that took 5 s or more
 *                           (`COLD_START_FLOOR_SECONDS`; a faster answer found a worker that was up already);
 *                           a used session that never answered ready, from its start to its end;
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
 * `unaccounted` is what RunPod billed minus all five (negative when our records claim more time than was billed). It
 * holds what no record covers: failed jobs, local build time, the worker overhead of a request, and billing granularity.
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
 */
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
export function accountTimeline(input: { sessions: readonly SessionRecord[]; jobs: readonly JobRecord[]; idleTimeoutSeconds: number }): BucketTimeline {
  const idleMs = input.idleTimeoutSeconds * 1000;
  const raw: Record<Bucket, Interval[]> = { proving: [], startingUp: [], waitingForProof: [], unusedEarlyStarts: [], idleAfterJob: [] };

  const requestStarts: number[] = [];
  for (const job of input.jobs) {
    const request = job.remoteMs;
    const duration = job.workerTotalMs ?? request;
    if (duration === null) {
      raw.proving.push([job.startedAt ?? job.provedAt, job.provedAt]);
    } else {
      raw.proving.push([job.provedAt - duration, job.provedAt]);
      if (request !== null) {
        const requestStart = job.provedAt - request;
        requestStarts.push(requestStart);
        if ((job.notReadyCount ?? 0) > 0 && job.waitWorkerMs !== null) raw.startingUp.push([requestStart - job.waitWorkerMs, requestStart]);
      }
    }
    raw.idleAfterJob.push([job.provedAt, job.provedAt + idleMs]);
  }
  requestStarts.sort((left, right) => left - right);

  for (const session of input.sessions) {
    if (session.outcome !== "used") {
      const billed = session.billedSeconds ?? (session.endedAt - session.startedAt) / 1000 + input.idleTimeoutSeconds;
      raw.unusedEarlyStarts.push([session.startedAt, session.startedAt + billed * 1000]);
      continue;
    }
    const ready = session.readyAt;
    const cold = ready === null || ready - session.startedAt >= COLD_START_FLOOR_SECONDS * 1000;
    // The job that took the worker: the first request that starts from shortly before the session's end.
    const request = requestStarts.find((start) => start >= session.endedAt - 120_000);
    const waitEnd = request === undefined ? session.endedAt : Math.min(request, session.endedAt + idleMs);
    if (ready === null) {
      raw.startingUp.push([session.startedAt, session.endedAt]);
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

/** The breakdown of one period. `unaccounted` is null when RunPod has no figure for the period. */
export type Breakdown = Readonly<Record<Bucket, Amount>> & { readonly unaccounted: Amount | null };

const roundTo = (value: number, places: number) => Math.round(value * 10 ** places) / 10 ** places;
const amount = (seconds: number, usdPerHour: number): Amount => ({ seconds: roundTo(seconds, 2), usd: roundTo((seconds / 3600) * usdPerHour, 4) });

/**
 * The breakdown of a period: every bucket in seconds and in USD at `usdPerHour`, and `unaccounted` as the bill minus the
 * buckets (rounded as shown, so the six add up to the bill). The bill is null for a period without RunPod figures.
 */
export function breakdownOf(seconds: BucketSeconds, usdPerHour: number, billed: { readonly seconds: number; readonly usd: number } | null): Breakdown {
  const buckets = {} as Record<Bucket, Amount>;
  for (const bucket of BUCKETS) buckets[bucket] = amount(seconds[bucket], usdPerHour);
  if (billed === null) return { ...buckets, unaccounted: null };
  const claimed = BUCKETS.reduce((sum, bucket) => ({ seconds: sum.seconds + buckets[bucket].seconds, usd: sum.usd + buckets[bucket].usd }), { seconds: 0, usd: 0 });
  return { ...buckets, unaccounted: { seconds: roundTo(billed.seconds - claimed.seconds, 2), usd: roundTo(billed.usd - claimed.usd, 4) } };
}

/** Adds breakdowns (the days of a total). `unaccounted` sums the days that have one, and is null when none does. */
export function sumBreakdowns(parts: readonly Breakdown[]): Breakdown {
  const add = (pick: (part: Breakdown) => Amount | null): Amount | null => {
    const amounts = parts.map(pick).filter((entry): entry is Amount => entry !== null);
    return amounts.length === 0 ? null : { seconds: roundTo(amounts.reduce((sum, entry) => sum + entry.seconds, 0), 2), usd: roundTo(amounts.reduce((sum, entry) => sum + entry.usd, 0), 4) };
  };
  const total = {} as Record<Bucket, Amount>;
  for (const bucket of BUCKETS) total[bucket] = add((part) => part[bucket]) ?? { seconds: 0, usd: 0 };
  return { ...total, unaccounted: add((part) => part.unaccounted) };
}
