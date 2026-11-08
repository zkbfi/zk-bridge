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

const dollars = (value: unknown) => `$${(number(value) ?? 0).toFixed(2)}`;
const balanceDollars = (value: number) => `$${value >= 10 ? Math.round(value) : value.toFixed(2)}`;

/**
 * What the GPU warm-ups of the last 24 hours cost: `GET /warmup/summary?days=1`. The money is what RunPod billed
 * (`billing`), and the wasted part is the wasted warm-up seconds at the rate RunPod's billing gives; when the backend
 * cannot read RunPod it says so and the check shows the configured price. Degraded when the balance covers fewer than
 * {@link BALANCE_WARNING_DAYS} days at the last 7 days' average spend; otherwise ok, since a wasted warm-up is a cost, not an outage.
 */
export const warmupCheck = (backendBase: string): Spec => ({
  id: "pipeline-warmup",
  name: "Prover warm-ups (24 h)",
  section: "pipeline",
  async run(run) {
    const answer = await get(run, `${backendBase}/warmup/summary?days=1`);
    if (answer.status !== 200) return { state: "down", detail: `answered ${answer.status} on /warmup/summary` };
    const body = record(json(answer));
    const total = record(body?.total);
    if (body === null || total === null) return { state: "down", detail: "answered something that is not the warm-up summary" };
    const billing = record(body.billing);
    const spendKnown = billing?.available === true && number(billing.last24hUsd) !== null;
    const sessions = number(total.sessions) ?? 0;
    const wasted = number(total.wasted) ?? 0;
    const parts: string[] = [];
    if (sessions === 0) parts.push("no warm-up in 24 h");
    else parts.push(`${count(sessions, "warm-up")} in 24 h, ${number(total.used) ?? 0} used and ${wasted} wasted`);
    if (spendKnown) {
      const wastedText = sessions === 0 ? "" : `, about ${dollars(total.wastedCostUsd)} of it wasted`;
      parts.push(`${dollars(billing?.last24hUsd)} billed by RunPod in 24 h${wastedText}`);
    } else if (sessions > 0) {
      const assumed = number(record(body.assumptions)?.gpuUsdPerHour);
      const rate = assumed === null ? "" : ` at the assumed $${assumed.toFixed(2)}/h`;
      parts.push(`RunPod billing is not available; about ${dollars(total.estimatedCostUsd)} of GPU time${rate}, ${dollars(total.wastedCostUsd)} of it wasted (${duration(number(total.wastedSeconds) ?? 0)})`);
    }
    const age = number(billing?.ageSeconds);
    if (spendKnown && age !== null && age > BILLING_STALE_SECONDS) parts.push(`RunPod figures are ${duration(age)} old`);
    let state: "ok" | "degraded" = "ok";
    const balance = number(billing?.balanceUsd);
    if (balance !== null) {
      const daysLeft = number(billing?.balanceDaysLeft);
      if (daysLeft === null) parts.push(`balance ${balanceDollars(balance)}, no spend in the last 7 days`);
      else {
        const left = Math.floor(daysLeft);
        const low = daysLeft < BALANCE_WARNING_DAYS;
        if (low) state = "degraded";
        parts.push(`balance ${balanceDollars(balance)}, ${count(left, "day")} left at the 7-day average${low ? ` (under ${BALANCE_WARNING_DAYS})` : ""}`);
      }
    }
    return { state, detail: parts.join("; ") };
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
