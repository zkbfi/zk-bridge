import type { ProofDirection } from "@zk-bridge/shared";
import { labelOf, type Deps } from "../deps.ts";
import { duration } from "../format.ts";
import type { CheckSpec, Outcome } from "../types.ts";
import { count, get, json } from "./fetch.ts";

type Spec = CheckSpec<Deps>;
type Obj = Record<string, unknown>;

const record = (value: unknown): Obj | null => (typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Obj) : null);
const number = (value: unknown): number | null => (typeof value === "number" && Number.isFinite(value) ? value : null);
const ago = (deps: Deps, milliseconds: number): string => duration((deps.now() - milliseconds) / 1000);

/** The two directions of the pair with the chains they join. */
function directions(deps: Deps) {
  const [first, second] = deps.pair.sides;
  return [
    { direction: "first-to-second" as const, source: first, destination: second },
    { direction: "second-to-first" as const, source: second, destination: first },
  ].map((entry) => ({ ...entry, text: `${labelOf(deps, entry.source.chainId)} to ${labelOf(deps, entry.destination.chainId)}` }));
}

/** The track record of the backend's proofs in the last 24 hours: `GET /benchmarks`. */
export const benchmarksCheck = (deps: Deps, backendBase: string): Spec => ({
  id: "pipeline-benchmarks",
  name: "Proof history (24 h)",
  section: "pipeline",
  async run(run) {
    const answer = await get(run, `${backendBase}/benchmarks?window=24h`);
    if (answer.status !== 200) return { state: "down", detail: `answered ${answer.status} on /benchmarks` };
    const body = record(json(answer));
    if (body === null) return { state: "down", detail: "answered something that is not the benchmarks" };
    const byDirection = record(body.byDirection);
    const recent = Array.isArray(body.recent) ? body.recent.map(record) : [];
    const parts = directions(deps).map(({ direction, text }) => {
      const last = number(recent.find((proof) => proof?.direction === direction)?.provedAt);
      const total = record(record(byDirection?.[direction])?.total);
      const median = number(total?.medianMs);
      const proofs = number(total?.count) ?? 0;
      if (last === null && proofs === 0) return `${text}: no proof in 24 h`;
      const lastText = last === null ? "last proof not in the list" : `last proof ${ago(run, last)} ago`;
      return `${text}: ${lastText}, ${median === null ? "no proof time in 24 h" : `median ${duration(median / 1000)} over ${count(proofs, "proof")} in 24 h`}`;
    });
    const detail = parts.join("; ");
    return body.indexer === "unavailable" ? { state: "degraded", detail: `the backend cannot reach the indexer; ${detail}` } : { state: "ok", detail };
  },
});

/** The balance covers fewer days than this at the last 7 days' average spend: the check is degraded. */
export const BALANCE_WARNING_DAYS = 14;
/** RunPod figures older than this many seconds are said to be old. */
const BILLING_STALE_SECONDS = 1800;

const dollars = (value: number) => `$${value.toFixed(2)}`;
const balanceDollars = (value: number) => `$${value >= 10 ? Math.round(value) : value.toFixed(2)}`;

/** The unaccounted time is flagged (the check is degraded) when it is more than this share of the bill of 24 hours. */
export const UNACCOUNTED_WARNING_SHARE = 0.25;
/** The most characters of the detail that the sanitizer keeps; the line stays within it. */
const DETAIL_LIMIT = 200;

/** The buckets of the breakdown, with the words the line uses. */
const BUCKETS: ReadonlyArray<readonly [string, string]> = [
  ["proving", "proving"],
  ["idleAfterJob", "idle after jobs"],
  ["startingUp", "starting up"],
  ["waitingForProof", "waiting for a proof"],
  ["unusedEarlyStarts", "unused early starts"],
  ["unaccounted", "unaccounted"],
];

const signedDollars = (value: number) => `${value < 0 ? "-" : ""}$${Math.abs(value).toFixed(2)}`;

/**
 * GPU billing of the last 24 hours: `GET /billing?days=1`. The line leads with what RunPod billed, then says where it
 * went, the buckets of `last24h.breakdown` largest first (by size, whatever the sign), as dollars; buckets that round to
 * $0.00 are left out, and when the line would pass {@link DETAIL_LIMIT} characters the smallest go and "+N more" says
 * how many. The balance and the days it lasts at the last 7 days' average follow. When the backend cannot read RunPod
 * the line says so and gives what our records hold, at the assumed price.
 *
 * Degraded when the balance covers fewer than {@link BALANCE_WARNING_DAYS} days, and when the unaccounted dollars are
 * more than {@link UNACCOUNTED_WARNING_SHARE} of the part of the bill that was compared (our records do not match the bill;
 * RunPod's bill lags, so only time up to `billedThrough` is judged and the line says "billing caught up to 03:00 UTC"
 * when records after it are left out), and when the
 * idle timeout RunPod reports for the endpoint differs from the backend's configuration; the line gives both numbers. Otherwise ok: an unused worker is a cost, not an outage.
 */
export const gpuBillingCheck = (backendBase: string): Spec => ({
  id: "gpu-billing",
  name: "GPU billing",
  section: "pipeline",
  async run(run) {
    const answer = await get(run, `${backendBase}/billing?days=1`);
    if (answer.status !== 200) return { state: "down", detail: `answered ${answer.status} on /billing` };
    const body = record(json(answer));
    const total = record(body?.total);
    if (body === null || total === null) return { state: "down", detail: "answered something that is not the GPU billing" };
    const last24h = record(body.last24h);
    const billed = number(last24h?.billedUsd);
    const spendKnown = body.available === true && billed !== null;
    let state: "ok" | "degraded" = "ok";

    const assumed = number(record(body.assumptions)?.gpuUsdPerHour);
    const rate = body.rateSource === "assumed" && assumed !== null ? ` at the assumed $${assumed.toFixed(2)}/h` : "";
    const head = spendKnown ? `${dollars(billed)} in 24 h` : `RunPod billing is not available; our records for 24 h${rate}`;

    const breakdown = record(last24h?.breakdown);
    const unaccounted = number(record(breakdown?.unaccounted)?.usd);
    // RunPod's bill lags: the backend compares only what RunPod has billed (`breakdown.billed`, up to `billedThrough`) and
    // reports the records after it as `notYetBilled`. The mismatch is judged on that complete part only.
    const compared = number(record(breakdown?.billed)?.usd) ?? billed;
    const mismatch = spendKnown && compared !== null && compared > 0 && unaccounted !== null && Math.abs(unaccounted) > UNACCOUNTED_WARNING_SHARE * compared;
    if (mismatch) state = "degraded";
    const items = BUCKETS.map(([key, label], order) => ({ key, order, usd: number(record(breakdown?.[key])?.usd), label }))
      .filter((item): item is typeof item & { usd: number } => item.usd !== null && Math.abs(item.usd) >= 0.005)
      .sort((left, right) => Math.abs(right.usd) - Math.abs(left.usd) || left.order - right.order)
      .map((item) => ({
        flagged: item.key === "unaccounted" && mismatch,
        text:
          item.key === "unaccounted" && mismatch
            ? `${item.label} ${signedDollars(item.usd)} (${Math.round((Math.abs(item.usd) / (compared as number)) * 100)}% of the ${dollars(compared as number)} billed, records do not match the bill)`
            : `${item.label} ${signedDollars(item.usd)}`,
      }));

    const tail: string[] = [];
    const through = typeof breakdown?.billedThrough === "string" ? new Date(breakdown.billedThrough) : null;
    if (through !== null && !Number.isNaN(through.getTime()) && (number(record(breakdown?.notYetBilled)?.seconds) ?? 0) > 0) {
      const clock = through.toISOString().slice(11, 16);
      tail.push(`billing caught up to ${through.toISOString().slice(0, 10) === new Date(run.now()).toISOString().slice(0, 10) ? "" : `${through.toISOString().slice(5, 10)} `}${clock} UTC`);
    }
    // The idle timeout is set only by deploy/runpod/endpoints.json; the backend reads it from RunPod. While it cannot, it
    // estimates with its fallback, so the warm-up timing and the billing estimates may be off.
    const assumptions = record(body.assumptions);
    const fallback = number(assumptions?.idleTimeoutSeconds);
    if (assumptions?.idleTimeoutSource === "fallback") {
      state = "degraded";
      tail.push(`RunPod idle timeout not read, the backend uses its fallback${fallback === null ? "" : ` of ${fallback} s`}`);
    }
    const age = number(body.ageSeconds);
    if (spendKnown && age !== null && age > BILLING_STALE_SECONDS) tail.push(`RunPod figures are ${duration(age)} old`);
    const account = record(body.account);
    const balance = number(account?.balanceUsd);
    if (balance !== null) {
      const daysLeft = number(account?.daysLeft);
      if (daysLeft === null) tail.push(`balance ${balanceDollars(balance)}, no spend in the last 7 days`);
      else {
        const low = daysLeft < BALANCE_WARNING_DAYS;
        if (low) state = "degraded";
        tail.push(`balance ${balanceDollars(balance)}, ${count(Math.floor(daysLeft), "day")} left${low ? ` (under ${BALANCE_WARNING_DAYS})` : ""}`);
      }
    }

    const compose = (shown: typeof items, hidden: number) => {
      const list = [...shown.map((item) => item.text), ...(hidden > 0 ? [`+${hidden} more`] : [])].join(", ");
      return `${[`${head}${list === "" ? "" : `: ${list}`}`, ...tail].join("; ")}.`;
    };
    // Too long: the smallest buckets go first, and the flagged one stays.
    let shown = items;
    for (let keep = items.length; keep >= 0; keep -= 1) {
      shown = items.filter((item, index) => item.flagged || index < keep);
      if (compose(shown, items.length - shown.length).length <= DETAIL_LIMIT) break;
    }
    return { state, detail: compose(shown, items.length - shown.length) };
  },
});

/** One direction of the proof pipeline: the job that runs, the newest job, the proofs held and the batch that waits. */
export const pipelineCheck = (deps: Deps, backendBase: string, direction: ProofDirection): Spec => {
  const text = directions(deps).find((entry) => entry.direction === direction)?.text as string;
  const [from, to] = text.split(" to ");
  return {
    id: `pipeline-${direction}`,
    name: `Proofs from ${from} to ${to}`,
    section: "pipeline",
    async run(run) {
      const answer = await get(run, `${backendBase}/directions/${direction}/pipeline`);
      if (answer.status !== 200) return { state: "down", detail: `answered ${answer.status} on /directions/${direction}/pipeline` };
      const body = record(json(answer));
      if (body === null) return { state: "down", detail: "answered something that is not a pipeline report" };
      const latestJob = record(body.latestJob);
      if (latestJob?.status === "failed") {
        const reason = typeof latestJob.error === "string" ? latestJob.error : "no reason recorded";
        return { state: "degraded", detail: `the newest proof job failed ${ago(run, number(latestJob.updatedAt) ?? run.now())} ago: ${reason}` };
      }
      const job = record(body.job);
      if (job !== null) {
        const elapsed = (number(job.elapsedMs) ?? 0) / 1000;
        const limit = run.config.pipeline.maxJobSeconds;
        if (elapsed > limit) return { state: "degraded", detail: `a proof job has run for ${duration(elapsed)}, it should take under ${duration(limit)}` };
        return { state: "ok", detail: `a proof job is running, ${duration(elapsed)} so far` };
      }
      const batch = number(record(body.batch)?.count) ?? 0;
      const proof = number(record(body.latestProof)?.since);
      const waiting = batch === 0 ? "nothing waits for a batch" : `${count(batch, "transfer")} ${batch === 1 ? "waits" : "wait"} for a batch`;
      return { state: "ok", detail: `idle, ${waiting}, ${proof === null ? "no proof held" : `newest proof held ${ago(run, proof)} ago`}` };
    },
  };
};

const FEED_PAGES = 5;
const FEED_LIMIT = 200;
const IN_FLIGHT = "sent,waiting_for_finality,covered";

/** `GET /api/feed` and the items of its answer. */
async function readFeed(deps: Deps, base: string, query: string): Promise<{ items: Obj[]; nextCursor: string | null }> {
  const answer = await get(deps, `${base}/api/feed?${query}`);
  if (answer.status !== 200) throw new Failure(`answered ${answer.status} on /api/feed`);
  const body = record(json(answer));
  if (body === null || !Array.isArray(body.items)) throw new Failure("answered something that is not a feed");
  return { items: body.items.map((item) => record(item) ?? {}), nextCursor: typeof body.nextCursor === "string" ? body.nextCursor : null };
}

class Failure extends Error {}

const secondsOf = (value: unknown, key: string): number | null => number(record(record(value)?.[key])?.timestamp);

/** The indexer's side of the pipeline: the last delivery of each direction, the transfers of the day, the oldest wait. */
export const indexerFeedCheck = (deps: Deps, indexerBase: string): Spec => ({
  id: "pipeline-deliveries",
  name: "Deliveries",
  section: "pipeline",
  async run(run): Promise<Outcome> {
    try {
      const summaryAnswer = await get(run, `${indexerBase}/api/summary`);
      if (summaryAnswer.status !== 200) return { state: "down", detail: `answered ${summaryAnswer.status} on /api/summary` };
      const summary = record(json(summaryAnswer));
      if (summary === null) return { state: "down", detail: "answered something that is not the summary" };
      const transfers = (Array.isArray(summary.volume24h) ? summary.volume24h : []).reduce((sum: number, entry) => sum + (number(record(entry)?.transfers) ?? 0), 0);

      const lasts = await Promise.all(
        directions(deps).map(async ({ source, destination, text }) => {
          const label = encodeURIComponent(`${source.chainId}>${destination.chainId}`);
          const { items } = await readFeed(run, indexerBase, `direction=${label}&status=delivered&limit=1`);
          const at = secondsOf(items[0], "delivered");
          return at === null ? `${text}: no delivery yet` : `${text}: last delivery ${duration(run.now() / 1000 - at)} ago`;
        }),
      );

      let oldest: number | null = null;
      let cursor: string | null = null;
      let truncated = false;
      for (let page = 1; page <= FEED_PAGES; page += 1) {
        const { items, nextCursor } = await readFeed(run, indexerBase, `status=${encodeURIComponent(IN_FLIGHT)}&limit=${FEED_LIMIT}${cursor === null ? "" : `&cursor=${encodeURIComponent(cursor)}`}`);
        for (const item of items) oldest = Math.min(oldest ?? Infinity, secondsOf(item, "sent") ?? Infinity);
        cursor = nextCursor;
        if (cursor === null) break;
        truncated = page === FEED_PAGES;
      }

      const parts = [...lasts, `${count(transfers, "transfer")} in the last 24 h`];
      if (oldest === null || oldest === Infinity) return { state: "ok", detail: `${parts.join("; ")}; no undelivered transfer` };
      const wait = run.now() / 1000 - oldest;
      const limit = run.config.pipeline.maxUndeliveredAgeSeconds;
      const waits = `oldest undelivered transfer waits ${truncated ? "at least " : ""}${duration(wait)}`;
      if (wait > limit) return { state: wait > limit * 3 ? "down" : "degraded", detail: `${parts.join("; ")}; ${waits}, delivery should happen within ${duration(limit)}` };
      return { state: "ok", detail: `${parts.join("; ")}; ${waits}` };
    } catch (error) {
      if (error instanceof Failure) return { state: "down", detail: error.message };
      throw error;
    }
  },
});
