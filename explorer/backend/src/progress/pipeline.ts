/**
 * The proving pipeline of one direction: the batch that waits, the job that runs and its step, the newest proof and
 * where it is, the light client head, and the watcher's latest decision.
 */
import { PROOF_COST_USD, USD, type ProofDirection } from "@zk-bridge/shared";
import type { HeldProof } from "../requests/held-proofs.ts";
import type { Job } from "../requests/jobs.ts";
import type { Storage } from "../storage.ts";
import type { WatchDecision } from "../watch/decisions.ts";
import type { IndexedHead } from "./indexer.ts";
import { jobStep, type Estimates, type ProofWhere, type WaitingService } from "./progress.ts";

/**
 * The rule that decides when a message of the direction gets a proof, for the dapp's wait timeline: a batch that does
 * not pay waits `minIntervalSeconds` since the direction's last proof; it pays when its fees reach
 * (`proofCostUsd` + the delivery gas of each message) times `profitMargin`. `priced` is false when the pair has no
 * PulseChain mainnet side to price tokens on (a testnet): nothing pays there, so only the interval applies.
 */
export type PipelineRule = {
  readonly minIntervalSeconds: number;
  readonly lookaheadSeconds: number;
  readonly profitMargin: number;
  /** The proof's share of the cost of one message, in dollars, as text ("0.025000"). */
  readonly proofCostUsd: string;
  readonly priced: boolean;
};

/** The rule of a direction as the answer shows it. */
export function pipelineRuleOf(rule: { readonly minIntervalSeconds: number; readonly lookaheadSeconds: number; readonly marginWad: bigint }, priced: boolean): PipelineRule {
  return {
    minIntervalSeconds: rule.minIntervalSeconds,
    lookaheadSeconds: rule.lookaheadSeconds,
    profitMargin: Number(rule.marginWad) / 1e18,
    proofCostUsd: `${PROOF_COST_USD / USD}.${(PROOF_COST_USD % USD).toString().padStart(18, "0").slice(0, 6)}`,
    priced,
  };
}

/** The answer of `GET /directions/:direction/pipeline`. Times in milliseconds since 1970. */
export type Pipeline = {
  readonly direction: ProofDirection;
  readonly now: number;
  /** When a proof of the direction starts: the interval, the margin and whether fees can be priced. */
  readonly rule: PipelineRule;
  /**
   * The batch the watcher holds back, or null when none waits. The wire keeps its first names: `trigger` "max-wait" and
   * `fallbackAt` are the minimum interval since the last proof (`watch.minIntervalSeconds`) and when it ends.
   */
  readonly batch: {
    readonly count: number;
    readonly oldestFinalAt: number;
    readonly trigger: "profit" | "max-wait";
    readonly eta: number;
    readonly fallbackAt: number;
    readonly feesUsd: string | null;
    readonly costUsd: string | null;
    readonly detail: string;
  } | null;
  /** The job that runs, or null. */
  readonly job: {
    readonly jobId: string;
    readonly status: string;
    readonly step: WaitingService;
    readonly startedAt: number;
    readonly elapsedMs: number;
    readonly eta?: number;
    readonly detail: string;
  } | null;
  /** The newest job, whatever its status. */
  readonly latestJob: { readonly jobId: string; readonly status: string; readonly createdAt: number; readonly updatedAt: number; readonly startSlot: string | null; readonly newSlot: string | null; readonly error: string | null } | null;
  /** The proof that reaches furthest of those the backend has, and where it is. */
  readonly latestProof: { readonly startSlot: number; readonly newSlot: number; readonly where: ProofWhere; readonly since: number } | null;
  /** The destination light client, from the chain indexer; null when it cannot be read. */
  readonly head: { readonly slot: number | null; readonly finalizedSlot: number | null; readonly lastUpdateAt: number | null; readonly lagSeconds: number | null } | null;
  readonly decision: WatchDecision | null;
  /**
   * The deposits of the bridge on the destination chain, as the watcher's latest decision read them: `waiting` while
   * the bridge waits for an update of this direction's light client to open deposits, and `proofDue` when that decision
   * started a proof for it (`why` "deposits-locked"). Null when the latest decision did not read them (another reason
   * made a proof due, or no watcher runs).
   */
  readonly deposits: { readonly open: boolean | null; readonly remoteHasHead: boolean | null; readonly waiting: boolean; readonly proofDue: boolean } | null;
};

const tableExists = (storage: Storage, name: string): boolean =>
  storage.database.prepare("SELECT 1 AS found FROM sqlite_master WHERE type = 'table' AND name = ?").get(name) !== undefined;

/**
 * Every proof of the direction the backend has, with where it is: `board` for the proof the msgboard indexer keeps and
 * for a webhook proof that was posted, `stored` for one the webhook holds unposted, `job` for the slots the prover of the newest job that did
 * not fail reported (its proof may be applied already: the head then reaches it).
 */
export function knownProofs(storage: Storage, direction: ProofDirection): HeldProof[] {
  type Row = { start_slot: string; new_slot: string; at: number; posted: number };
  const of = (row: Row, where: HeldProof["where"]): HeldProof => ({ startSlot: Number(row.start_slot), newSlot: Number(row.new_slot), where, since: row.at });
  const board = (storage.database.prepare("SELECT start_slot, new_slot, stored_at AS at, 1 AS posted FROM proofs WHERE direction = ?").all(direction) as Row[]).map((row) => of(row, "board"));
  const webhook = tableExists(storage, "webhook_proofs")
    ? (storage.database.prepare("SELECT start_slot, new_slot, stored_at AS at, posted_at IS NOT NULL AS posted FROM webhook_proofs WHERE direction = ?").all(direction) as Row[]).map((row) => of(row, row.posted === 1 ? "board" : "stored"))
    : [];
  // The newest job whose prover reported slots and that did not fail: a proof being posted, posted, or applied.
  const job = storage.database
    .prepare("SELECT start_slot, new_slot, updated_at AS at, 0 AS posted FROM jobs WHERE direction = ? AND new_slot IS NOT NULL AND status IN ('proving', 'published', 'on-chain') ORDER BY created_at DESC, rowid DESC LIMIT 1")
    .get(direction) as Row | undefined;
  return [...board, ...webhook, ...(job === undefined ? [] : [of(job, "job")])];
}

/** The proof that reaches furthest; on a tie the one further along (board before stored). */
export function furthestProof(proofs: readonly HeldProof[], headSlot: number | null): Pipeline["latestProof"] {
  const rank = { job: 0, stored: 1, board: 2 } as const;
  let best: HeldProof | null = null;
  for (const proof of proofs) {
    if (best === null || proof.newSlot > best.newSlot || (proof.newSlot === best.newSlot && rank[proof.where] > rank[best.where])) best = proof;
  }
  if (best === null) return null;
  const where: ProofWhere = headSlot !== null && headSlot >= best.newSlot ? "applied" : best.where === "board" ? "board" : "stored";
  return { startSlot: best.startSlot, newSlot: best.newSlot, where, since: best.since };
}

/** The step of a job as the answer shows it. */
const stepFields = (step: ReturnType<typeof jobStep>) => ({ step: step.service, ...(step.eta === undefined ? {} : { eta: step.eta }), detail: step.detail as string });

const describeJob = (job: Job) => ({ jobId: job.id, status: job.status, createdAt: job.createdAt, updatedAt: job.updatedAt, startSlot: job.startSlot, newSlot: job.newSlot, error: job.error });

/** Builds the pipeline of a direction from its facts. */
export function buildPipeline(input: {
  direction: ProofDirection;
  rule: PipelineRule;
  activeJob: Job | null;
  latestJob: Job | null;
  proofs: readonly HeldProof[];
  head: IndexedHead | null;
  decision: WatchDecision | null;
  workerWarm: boolean;
  estimates: Estimates;
  now: number;
}): Pipeline {
  const { decision, head, now } = input;
  const waiting = decision?.why === "min-interval" ? (decision.batch ?? null) : null;
  const batch =
    waiting === null || decision === null
      ? null
      : {
          count: waiting.messages,
          oldestFinalAt: waiting.oldestFinalAt,
          trigger: waiting.startWhy === "profit" ? ("profit" as const) : ("max-wait" as const),
          eta: waiting.startAt,
          fallbackAt: waiting.dueAt,
          feesUsd: waiting.feesUsd,
          costUsd: waiting.costUsd,
          detail: decision.detail,
        };
  const active = input.activeJob;
  const step = (job: Job) => jobStep({ job, workerWarm: input.workerWarm, estimates: input.estimates, now });
  const job =
    active === null
      ? null
      : { jobId: active.id, status: active.status, startedAt: active.createdAt, elapsedMs: now - active.createdAt, ...stepFields(step(active)) };
  const headSlot = head?.storedHeadSlot ?? null;
  return {
    direction: input.direction,
    now,
    rule: input.rule,
    batch,
    job,
    latestJob: input.latestJob === null ? null : describeJob(input.latestJob),
    latestProof: furthestProof(input.proofs, headSlot),
    head:
      head === null
        ? null
        : {
            slot: headSlot,
            finalizedSlot: head.finalizedSlot ?? null,
            lastUpdateAt: head.lastUpdateTimestamp == null ? null : head.lastUpdateTimestamp * 1000,
            lagSeconds: head.lagSeconds ?? null,
          },
    decision,
    deposits:
      decision?.deposits === undefined
        ? null
        : { ...decision.deposits, waiting: decision.deposits.open === false, proofDue: decision.due && decision.why === "deposits-locked" },
  };
}
