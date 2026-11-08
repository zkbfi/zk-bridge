/**
 * The latest decision of the watcher of each direction, kept in memory for `GET /directions/:direction/pipeline` and
 * `GET /progress/:messageId`. A restart forgets it; the next finality writes it again.
 */
import type { ProofDirection } from "@zk-bridge/shared";
import type { DepositsFacts } from "./decide.ts";

/** A batch that waits: how many messages, what they are worth, and when the proof is expected. Times in ms since 1970. */
export type WaitingBatch = {
  readonly messages: number;
  readonly feesUsd: string | null;
  readonly costUsd: string | null;
  /** Why the fees cannot be valued, when they cannot. */
  readonly unknownWhy: string | null;
  readonly oldestFinalAt: number;
  /** When the proof is expected to start: when the batch pays, or when the minimum interval ends. */
  readonly startAt: number;
  readonly startWhy: "profit" | "interval";
  /** The fallback: the latest the proof starts, `minIntervalSeconds` after the last proof started. */
  readonly dueAt: number;
  /** When the direction's last proof job started: the interval counts from it. */
  readonly lastProofAt: number;
};

/** What happened after a due decision: a job started or joined, a job was running, or the request was refused. */
export type DecisionOutcome = "job-started" | "job-active" | "keep-alive-this-period" | "duplicate" | "nothing-to-prove" | "rate-limited" | "cannot-check";

/** One decision of a watcher. Times in milliseconds since 1970. */
export type WatchDecision = {
  readonly at: number;
  readonly finalizedSlot: number;
  /** The destination light client head the decision read. */
  readonly headSlot: number;
  /** The slot clock of the source chain, from the light client: the start of slot 0 (seconds) and the slot length. */
  readonly genesisTime: number;
  readonly secondsPerSlot: number;
  readonly due: boolean;
  /** The `why` of `proof_due` or `proof_not_due`. */
  readonly why: string;
  readonly detail: string;
  /** For a due message proof: profit or interval, the batch size and how long its oldest message waited. */
  readonly trigger?: "profit" | "interval";
  readonly batchSize?: number;
  readonly waitedSeconds?: number;
  readonly feesUsd?: string | null;
  readonly costUsd?: string | null;
  /** For `min-interval`: the batch that waits. */
  readonly batch?: WaitingBatch;
  readonly outcome?: DecisionOutcome;
  /**
   * The deposits of the bridge on the destination chain, as the decision read them: `open` false means the bridge
   * waits for an update of this direction's light client to open (`why` "deposits-locked" when a proof is due for it).
   * Absent when the watcher does not read them.
   */
  readonly deposits?: DepositsFacts;
  /**
   * When the destination light client strands if no proof lands (`deadlineOf` in keepalive/plan.ts, of the facts this decision read):
   * `at` in milliseconds since 1970, `period` the period it would strand in. Absent from a decision made before it.
   */
  readonly deadline?: { readonly at: number; readonly period: number; readonly headPeriod: number; readonly lastKnownPeriod: number };
};

/** The latest decision per direction. */
export interface DecisionBoard {
  record(direction: ProofDirection, decision: WatchDecision): void;
  latest(direction: ProofDirection): WatchDecision | null;
}

/** An empty board. */
export function createDecisionBoard(): DecisionBoard {
  const latest = new Map<ProofDirection, WatchDecision>();
  return {
    record: (direction, decision) => void latest.set(direction, decision),
    latest: (direction) => latest.get(direction) ?? null,
  };
}

const boards = new WeakMap<object, DecisionBoard>();

/** The board of one backend context: the watch writes it, the progress routes read it. */
export function decisionBoardOf(context: object): DecisionBoard {
  const known = boards.get(context);
  if (known !== undefined) return known;
  const created = createDecisionBoard();
  boards.set(context, created);
  return created;
}
