/**
 * The step service: one way to ask for the proof of any route step (`POST /steps/requests`), the job behind it
 * (`GET /steps/jobs/:jobId`) and the finished proof, public fields only (`GET /steps/proofs/:kind/:subject`).
 *
 * Every kind goes through the guards that already exist, and a request while a job of the step runs joins that job:
 *
 * - a light client update is a request of the request service (`requests/service.ts`): one job per finality, the daily
 *   job backstop, the direction's 24 h GPU budget, the proof we already have;
 * - an update of the fork registry's own light client is a GPU job of `step_jobs`, one per head it proves from, under the
 *   GPU budget of the direction whose source is the registry's chain and the retry wait after a failure;
 * - a fork observation is an attempt of `fork_observations` (the seal module's table): only when the chain runs a fork
 *   version the registry does not hold, under the observation caps (`seal.observation`) and the GPU budget (a new version
 *   goes past it, as in the seal module);
 * - the opening proof of a bridge and the evidence of a delivery need no GPU: the prover's `opening-proof` and the archive.
 *
 * The per-caller limit counts the requests of `POST /requests` and of this service together. The backend's own fallback
 * posters ask with `liveness`: no caller limit, and the GPU budget is passed (logged), as for a keep-alive.
 */
import { randomUUID } from "node:crypto";
import { getAddress, type Address, type Hex } from "viem";
import {
  PROOF_DIRECTIONS,
  SLOTS_PER_EPOCH,
  isRequestableKind,
  observationNeed,
  type Pair,
  type PairSide,
  type ProofDirection,
  type RequestableStepKind,
  type RouteStepKind,
  type StepJob,
  type StepProof,
  type StepRequestAnswer,
} from "@zk-bridge/shared";
import { CommandTimeoutError, ProverCommandError, type ForkObservationProver, type HeadProver, type OpeningProver } from "@zk-bridge/shared/prover";
import type { ArchiveService } from "../archive/build.ts";
import type { Logger } from "../logger.ts";
import { UNKNOWN_CALLER } from "../requests/caller.ts";
import { getJob, recentJobSeconds, recentRequestsOfCaller } from "../requests/jobs.ts";
import { CALLER_WINDOW_MILLISECONDS, JOB_BUDGET_WINDOW_MILLISECONDS, gpuBudgetWait, windowWaitSeconds, type RateLimits } from "../requests/rate-limit.ts";
import type { RequestService } from "../requests/service.ts";
import { recordProveTiming } from "../requests/timings.ts";
import { proveObservation } from "../seal/observe-watch.ts";
import { getObservationAttempt, latestObservationProof, latestObservationView, provingObservation, recentObservationAttempts } from "../seal/observations.ts";
import type { Storage } from "../storage.ts";
import { slotTimeOf, type StepChainReads } from "./chain.ts";
import {
  failLostStepJobs,
  finishStepJob,
  getStepJob,
  insertStepJob,
  insertStepRequest,
  latestDoneStepJob,
  latestStepJob,
  recentStepRequestsOfCaller,
  UP_TO_DATE_REASON,
  type StepJobKind,
  type StepRow,
} from "./store.ts";

/** How long an opening proof made on request is offered, in milliseconds: the remote block it rests on stays stored. */
export const OPENING_PROOF_REUSE_MILLISECONDS = 600_000;

/** A request to the service. `liveness`: the backend's own fallback poster (no caller limit, the GPU budget is passed). */
export type StepSubmit = { readonly kind: RequestableStepKind; readonly subject: string; readonly caller: string; readonly pair: string; readonly liveness?: boolean };

/** The answer, or `invalid` when the subject does not fit the kind (a 400). */
export type StepSubmitResult = StepRequestAnswer | { readonly invalid: string };

/** The estimate of a GPU proof of a direction: the median on a warm worker, with a worker start, and whether a worker is warm now. */
export type GpuEstimate = { readonly warmMs: number | null; readonly coldMs: number | null; readonly workerWarm: boolean };

/** What the service needs. Each prover and the archive is optional: a kind without its part answers `not-served`. */
export type StepServiceInput = {
  readonly storage: Storage;
  readonly pair: Pair;
  readonly now: () => number;
  readonly logger: Logger;
  readonly limits: RateLimits;
  /** A job older than this many milliseconds is lost. The prover limit. */
  readonly proverTimeoutMilliseconds: number;
  /** The request service of the light client updates; null when the requests module does not run in this process. */
  readonly requestService: () => RequestService | null;
  readonly headProver?: HeadProver;
  readonly observationProver?: ForkObservationProver;
  readonly openingProver?: OpeningProver;
  /** The archive that builds the evidence of a delivery; null without a chain indexer. */
  readonly archive: () => ArchiveService | null;
  readonly chain: StepChainReads;
  /** The price of a GPU hour in USD, as the request service prices its budget. */
  readonly readUsdPerHour: () => Promise<number>;
  readonly observationLimits: { readonly retryMinutes: number; readonly maxProofsPerVersionPerDay: number };
  readonly gpuEstimate: (direction: ProofDirection) => GpuEstimate;
};

/** The service. */
export interface StepService {
  submit(request: StepSubmit): Promise<StepSubmitResult>;
  /** A job by id, or null. */
  job(jobId: string): StepJob | null;
  /** The finished proof of a step, or null. */
  proof(kind: RouteStepKind, subject: string): StepProof | null;
  /** Resolves when the job ends (at once for an unknown or ended job). */
  wait(jobId: string): Promise<void>;
  /** Resolves when no job runs. A test awaits it. */
  settled(): Promise<void>;
}

/** A reason for a failed job that is safe to show: it holds no path, no endpoint and no prover output. */
export function describeFailure(error: unknown): string {
  if (error instanceof ProverCommandError) return `the prover stopped with exit code ${error.exitCode}`;
  if (error instanceof CommandTimeoutError) return "the prover ran longer than its limit";
  return "the prover could not make a proof";
}

const MESSAGE_ID = /^0x[0-9a-f]{64}$/;

/** The two sides of a direction. */
export const sidesOf = (pair: Pair, direction: ProofDirection): { readonly source: PairSide; readonly destination: PairSide } => {
  const [first, second] = pair.sides;
  return direction === "first-to-second" ? { source: first, destination: second } : { source: second, destination: first };
};

/** The direction whose source is a side: its GPU budget pays for a proof of that side's chain. */
export const directionFrom = (pair: Pair, side: PairSide): ProofDirection => (side.chainId === pair.sides[0].chainId ? "first-to-second" : "second-to-first");

/** The other direction. */
export const opposite = (direction: ProofDirection): ProofDirection => (direction === "first-to-second" ? "second-to-first" : "first-to-second");

/** The side whose chain id is `subject` and that has a fork registry, or null. */
export const registrySideOf = (pair: Pair, subject: string): PairSide | null => pair.sides.find((side) => String(side.chainId) === subject && side.contracts.forkRegistry !== null) ?? null;

const isDirection = (subject: string): subject is ProofDirection => (PROOF_DIRECTIONS as readonly string[]).includes(subject);

const hasTable = (storage: Storage, name: string): boolean => storage.database.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(name) !== undefined;

/** The newest light client proof of a direction the backend holds: unposted at the webhook, or on the board. */
export function heldLightClientProof(
  storage: Storage,
  direction: ProofDirection,
): { readonly payload: Hex; readonly startSlot: number; readonly newSlot: number; readonly at: number; readonly where: "stored" | "board"; readonly jobId: string | null } | null {
  type Row = { payload: Hex; start_slot: string; new_slot: string; at: number; posted: number; job_id: string | null };
  const rows: Row[] = [];
  if (hasTable(storage, "webhook_proofs")) {
    rows.push(
      ...(storage.database.prepare("SELECT payload, start_slot, new_slot, stored_at AS at, posted_at IS NOT NULL AS posted, job_id FROM webhook_proofs WHERE direction = ?").all(direction) as Row[]),
    );
  }
  const board = storage.database.prepare("SELECT body, start_slot, new_slot, stored_at AS at, job_id FROM proofs WHERE direction = ?").get(direction) as
    { body: string; start_slot: string; new_slot: string; at: number; job_id: string | null } | undefined;
  if (board !== undefined)
    rows.push({ payload: (JSON.parse(board.body) as { payload: Hex }).payload, start_slot: board.start_slot, new_slot: board.new_slot, at: board.at, posted: 1, job_id: board.job_id });
  const best = rows.reduce<Row | null>((current, row) => (current === null || Number(row.new_slot) > Number(current.new_slot) ? row : current), null);
  if (best === null) return null;
  return { payload: best.payload, startSlot: Number(best.start_slot), newSlot: Number(best.new_slot), at: best.at, where: best.posted === 1 ? "board" : "stored", jobId: best.job_id };
}

/** Builds the service. */
export function createStepService(input: StepServiceInput): StepService {
  const { storage, pair, now, logger, limits } = input;
  const running = new Map<string, Promise<void>>();

  /** Runs a job in the background and keeps its promise for {@link StepService.wait}. */
  const track = (jobId: string, work: Promise<unknown>): void => {
    // Every job catches its own failure; allSettled only keeps a slip from becoming an unhandled rejection.
    const task = Promise.allSettled([work]).then(() => undefined);
    running.set(jobId, task);
    void task.finally(() => running.delete(jobId));
  };

  /** Seconds the caller waits: its requests of both routes in the last minute. */
  const callerWait = (caller: string, current: number): number => {
    const since = current - CALLER_WINDOW_MILLISECONDS;
    const one = recentRequestsOfCaller(storage, caller, since);
    const two = recentStepRequestsOfCaller(storage, caller, since);
    const oldest = [one.oldest, two.oldest].filter((value): value is number => value !== null);
    const limit = caller === UNKNOWN_CALLER ? limits.requestsPerUnknownCallerPerMinute : limits.requestsPerCallerPerMinute;
    return windowWaitSeconds({ recent: { count: one.count + two.count, oldest: oldest.length === 0 ? null : Math.min(...oldest) }, now: current, limit });
  };

  /** An accepted answer; the caller's request is counted unless it is the backend's own. */
  const accepted = (request: StepSubmit, jobId: string, extra: { joined?: true; ready?: true } = {}): StepRequestAnswer => {
    if (request.liveness !== true) insertStepRequest(storage, { id: randomUUID(), jobId, caller: request.caller, at: now() });
    return { jobId, ...extra };
  };

  /** The GPU budget of a direction: null while it is not spent, else the refusal. A liveness request passes it, logged. */
  const overBudget = async (request: StepSubmit, direction: ProofDirection, bypass: boolean): Promise<StepRequestAnswer | null> => {
    const current = now();
    const usdPerHour = await input.readUsdPerHour();
    const budgetUsd = limits.gpuBudgetUsdPerDirectionPerDay;
    const spent = gpuBudgetWait({ jobs: recentJobSeconds(storage, direction, current - JOB_BUDGET_WINDOW_MILLISECONDS), usdPerHour, budgetUsd, now: current });
    if (spent === null) return null;
    const detail = `the 24 h GPU budget of $${budgetUsd.toFixed(2)} for ${direction} is spent: $${spent.spentUsd.toFixed(2)}`;
    const fields = { kind: request.kind, subject: request.subject, direction, budgetUsd, spentUsd: Math.round(spent.spentUsd * 10_000) / 10_000, detail };
    if (bypass) {
      logger.warn("gpu_budget_bypassed", { ...fields, why: request.liveness === true ? "liveness: the backend's fallback post" : "safety: an observation of a new fork version lets the gate seal" });
      return null;
    }
    logger.warn("gpu_budget_spent", { ...fields, retryAfterSeconds: spent.retryAfterSeconds });
    return { refused: "rate-limited", retryAfterSeconds: spent.retryAfterSeconds, why: "gpu-budget", detail };
  };

  /** The retry wait after a failed job of a step: null when none applies. */
  const retryWait = (latest: StepRow | null): StepRequestAnswer | null => {
    if (latest === null || latest.status !== "failed") return null;
    const readyAt = latest.updatedAt + limits.secondsBeforeRetryAfterFailure * 1000;
    if (readyAt <= now()) return null;
    const seconds = Math.max(1, Math.ceil((readyAt - now()) / 1000));
    return { refused: "rate-limited", retryAfterSeconds: seconds, why: "limit", detail: "the last proof of this step failed" };
  };

  /** Starts a row, or joins the one a concurrent request started (the unique index). */
  const startRow = (kind: StepJobKind, subject: string, startSlot: number | null, direction?: ProofDirection): { readonly id: string; readonly joined: boolean } => {
    const id = `step:${randomUUID()}`;
    try {
      insertStepJob(storage, { id, kind, subject, at: now(), startSlot, ...(direction === undefined ? {} : { direction }) });
      logger.info("step_job_started", { jobId: id, kind, subject });
      return { id, joined: false };
    } catch {
      return { id: (latestStepJob(storage, kind, subject) as StepRow).id, joined: true };
    }
  };

  /**
   * Starts a job of a step and runs `work` in the background, or joins the job that a concurrent request started between
   * this request's checks and its insert.
   */
  const startOrJoin = (request: StepSubmit, kind: StepJobKind, subject: string, startSlot: number | null, work: (id: string) => Promise<void>, direction?: ProofDirection): StepRequestAnswer => {
    const started = startRow(kind, subject, startSlot, direction);
    if (started.joined) return accepted(request, started.id, { joined: true });
    track(started.id, work(started.id));
    return accepted(request, started.id);
  };

  const finish = (id: string, kind: StepJobKind, outcome: { result: string } | { error: string }): void => {
    finishStepJob(storage, { id, at: now(), ...outcome });
    if ("error" in outcome) logger.warn("step_job_failed", { jobId: id, kind, error: outcome.error });
    else logger.info("step_job_done", { jobId: id, kind });
  };

  async function lightClientUpdate(request: StepSubmit): Promise<StepSubmitResult> {
    if (!isDirection(request.subject)) return { invalid: "the subject of a light client update is a direction" };
    const service = input.requestService();
    if (service === null) return { refused: "not-served", detail: "the requests module does not run on this backend" };
    const answer = await service.submit({ pair: request.pair, direction: request.subject, reason: "user", caller: request.caller });
    if (!("refused" in answer)) return { jobId: `job:${answer.jobId}`, ...(answer.joined === true ? { joined: true as const } : {}) };
    if (answer.refused === "duplicate") return { refused: "nothing-to-prove", why: "proof-pending" };
    return answer;
  }

  async function registryUpdate(request: StepSubmit): Promise<StepSubmitResult> {
    const side = registrySideOf(pair, request.subject);
    if (side === null) return { invalid: `chain ${request.subject} has no fork registry in this pair` };
    if (input.headProver === undefined) return { refused: "not-served", detail: "this backend proves no update of a fork registry's light client" };
    const latest = latestStepJob(storage, "registry-light-client-update", request.subject);
    if (latest?.status === "running") return accepted(request, latest.id, { joined: true });
    let state;
    try {
      state = await input.chain.registryLightClient(side, side.contracts.forkRegistry as Address);
    } catch (error) {
      logger.warn("step_check_failed", { kind: request.kind, subject: request.subject, error });
      return { refused: "cannot-check", retryAfterSeconds: 30 };
    }
    const done = latestDoneStepJob(storage, "registry-light-client-update", request.subject);
    if (done !== null && done.startSlot === state.head.slot) return accepted(request, done.id, { ready: true });
    const epochMilliseconds = SLOTS_PER_EPOCH * state.secondsPerSlot * 1000;
    if (request.liveness !== true && now() - slotTimeOf(state, state.head.slot) < 2 * epochMilliseconds) return { refused: "nothing-to-prove", why: "no-need" };
    const wait = retryWait(latest);
    if (wait !== null) return wait;
    const direction = directionFrom(pair, side);
    const budget = await overBudget(request, direction, request.liveness === true);
    if (budget !== null) return budget;
    const prover = input.headProver;
    const at = now();
    return startOrJoin(request, "registry-light-client-update", request.subject, state.head.slot, async (id) => {
      const started = { id };
      try {
        const outcome = await prover.proveFromHead({ direction, head: state.head, programKey: state.programKey });
        if (outcome.kind === "up-to-date") return finish(started.id, "registry-light-client-update", { error: UP_TO_DATE_REASON });
        recordProveTiming(storage, { jobId: `registry-${started.id.slice(5)}`, direction, startedAt: at, provedAt: now(), timing: outcome.timing ?? null });
        const proven = outcome.proofPackage;
        const result = {
          chainId: side.chainId,
          lightClient: getAddress(state.lightClient),
          programKey: proven.programKey,
          startSlot: proven.startHeadSlot,
          startRoot: proven.startHeadRoot,
          newSlot: proven.newHeadSlot,
          newRoot: proven.newHeadRoot,
          publicValues: proven.publicValues,
          proof: proven.proof,
        };
        finish(started.id, "registry-light-client-update", { result: JSON.stringify(result) });
      } catch (error) {
        logger.warn("step_prove_failed", { jobId: started.id, kind: request.kind, error });
        finish(started.id, "registry-light-client-update", { error: describeFailure(error) });
      }
    }, direction);
  }

  async function forkObservation(request: StepSubmit): Promise<StepSubmitResult> {
    const side = registrySideOf(pair, request.subject);
    if (side === null) return { invalid: `chain ${request.subject} has no fork registry in this pair` };
    if (input.observationProver === undefined || side.beaconUrl === null) return { refused: "not-served", detail: "this backend proves no fork observation for this chain" };
    const registry = side.contracts.forkRegistry as Address;
    const proving = provingObservation(storage, side.chainId, now() - input.proverTimeoutMilliseconds);
    if (proving !== null) return accepted(request, `observation:${proving.id}`, { joined: true });
    let facts;
    try {
      facts = await input.chain.forkFacts(side, registry, now());
    } catch (error) {
      logger.warn("step_check_failed", { kind: request.kind, subject: request.subject, error });
      return { refused: "cannot-check", retryAfterSeconds: 30 };
    }
    const need = observationNeed(facts);
    if (!need.needed) return { refused: "nothing-to-prove", why: "no-need" };
    const held = latestObservationProof(storage, side.chainId);
    if (held !== null && held.observation.observedVersion.toLowerCase() === need.version && BigInt(held.observation.observedAttestedSlot) > facts.registry.slot) {
      return accepted(request, `observation:${held.id}`, { ready: true });
    }
    const current = now();
    const recent = recentObservationAttempts(storage, { chainId: side.chainId, version: need.version, since: current - 86_400_000 });
    const { retryMinutes, maxProofsPerVersionPerDay } = input.observationLimits;
    if (recent.count >= maxProofsPerVersionPerDay) {
      return { refused: "rate-limited", retryAfterSeconds: 3600, why: "limit", detail: `${recent.count} observation proofs of version ${need.version} in 24 h, the most allowed` };
    }
    if (recent.latestAt !== null && current - recent.latestAt < retryMinutes * 60_000) {
      const seconds = Math.max(1, Math.ceil((recent.latestAt + retryMinutes * 60_000 - current) / 1000));
      return { refused: "rate-limited", retryAfterSeconds: seconds, why: "limit", detail: `tries for version ${need.version} are ${retryMinutes} minutes apart` };
    }
    const direction = directionFrom(pair, side);
    const budget = await overBudget(request, direction, request.liveness === true || need.why === "new-version");
    if (budget !== null) return budget;
    const id = randomUUID();
    const prover = input.observationProver;
    track(
      `observation:${id}`,
      proveObservation({ id, storage, chainId: side.chainId, registry, direction, version: need.version, why: need.why, now, logger, prove: () => prover.forkObservation({ direction, registry }) }),
    );
    return accepted(request, `observation:${id}`);
  }

  async function openDeposits(request: StepSubmit): Promise<StepSubmitResult> {
    if (!isDirection(request.subject)) return { invalid: "the subject of opening deposits is a direction: the bridge on its destination opens" };
    if (input.openingProver === undefined) return { refused: "not-served", detail: "this backend makes no opening proof" };
    const { destination } = sidesOf(pair, request.subject);
    const latest = latestStepJob(storage, "open-deposits", request.subject);
    if (latest?.status === "running") return accepted(request, latest.id, { joined: true });
    let open;
    try {
      open = await input.chain.depositsOpen(destination);
    } catch (error) {
      logger.warn("step_check_failed", { kind: request.kind, subject: request.subject, error });
      return { refused: "cannot-check", retryAfterSeconds: 30 };
    }
    if (open) return { refused: "nothing-to-prove", why: "no-need" };
    const done = latestDoneStepJob(storage, "open-deposits", request.subject);
    if (done !== null && now() - done.updatedAt < OPENING_PROOF_REUSE_MILLISECONDS) return accepted(request, done.id, { ready: true });
    const wait = retryWait(latest);
    if (wait !== null) return wait;
    const prover = input.openingProver;
    const routeDirection = opposite(request.subject);
    return startOrJoin(request, "open-deposits", request.subject, null, async (id) => {
      const started = { id };
      try {
        const opening = await prover.openingProof({ direction: routeDirection });
        if (opening.chainId !== destination.chainId || opening.to.toLowerCase() !== destination.contracts.bridge.toLowerCase()) {
          return finish(started.id, "open-deposits", { error: "the proof is for another bridge" });
        }
        if (opening.depositsOpen) return finish(started.id, "open-deposits", { error: "the bridge takes deposits already" });
        const result = {
          chainId: opening.chainId,
          bridge: getAddress(opening.to),
          calldata: opening.calldata,
          remoteSlot: opening.proof.remoteSlot,
          storedSlot: opening.proof.storedSlot,
          remoteBlockNumber: opening.remoteBlockNumber,
        };
        finish(started.id, "open-deposits", { result: JSON.stringify(result) });
      } catch (error) {
        logger.warn("step_prove_failed", { jobId: started.id, kind: request.kind, error });
        finish(started.id, "open-deposits", { error: describeFailure(error) });
      }
    });
  }

  async function evidence(request: StepSubmit, kind: "layout-rows" | "deliver"): Promise<StepSubmitResult> {
    const messageId = request.subject.toLowerCase();
    if (!MESSAGE_ID.test(messageId)) return { invalid: "the subject of a delivery is a message id: 32 bytes of 0x hex" };
    const archive = input.archive();
    if (archive === null) return { refused: "not-served", detail: "this backend builds no delivery evidence (no chain indexer)" };
    if (archive.readEvidence(messageId) !== null) return accepted(request, `ready:${kind}:${messageId}`, { ready: true });
    const latest = latestStepJob(storage, kind, messageId);
    if (latest?.status === "running") return accepted(request, latest.id, { joined: true });
    const wait = retryWait(latest);
    if (wait !== null) return wait;
    return startOrJoin(request, kind, messageId, null, async (id) => {
      await archive.runCycle();
      if (archive.readEvidence(messageId) !== null) finish(id, kind, { result: "{}" });
      else finish(id, kind, { error: "the archive holds no evidence for this message yet: it is built once a light client head covers the message" });
    });
  }

  /** The job of a light client update, from the `jobs` table. */
  const lightClientJob = (id: string): StepJob | null => {
    const job = getJob(storage, id);
    if (job === null) return null;
    const handedOff = hasTable(storage, "webhook_proofs") && storage.database.prepare("SELECT 1 FROM webhook_proofs WHERE job_id = ?").get(id) !== undefined;
    const status = job.status === "failed" ? "failed" : job.status === "published" || job.status === "on-chain" || handedOff ? "done" : job.status === "queued" ? "queued" : "running";
    return {
      jobId: `job:${id}`,
      kind: "light-client-update",
      subject: job.direction,
      status,
      startedAt: job.createdAt,
      updatedAt: job.updatedAt,
      etaAt: etaOf(job.direction, job.createdAt, status),
      error: job.error,
    };
  };

  /** When a GPU job is expected to end, from the benchmarks; null when it ended or nothing was measured. */
  const etaOf = (direction: ProofDirection, startedAt: number, status: StepJob["status"]): number | null => {
    if (status === "done" || status === "failed") return null;
    const estimate = input.gpuEstimate(direction);
    const duration = estimate.workerWarm ? estimate.warmMs : estimate.coldMs;
    return duration === null ? null : startedAt + duration;
  };

  const kindOfRow = (row: StepRow): RouteStepKind => row.kind;

  function proof(kind: RouteStepKind, subject: string): StepProof | null {
    switch (kind) {
      case "light-client-update": {
        if (!isDirection(subject)) return null;
        const held = heldLightClientProof(storage, subject);
        if (held === null) return null;
        return { kind, subject, chainId: sidesOf(pair, subject).destination.chainId, payload: held.payload, startSlot: held.startSlot, newSlot: held.newSlot, provedAt: held.at, where: held.where };
      }
      case "registry-light-client-update":
      case "open-deposits": {
        const done = latestDoneStepJob(storage, kind, subject);
        if (done === null) return null;
        return { kind, subject, ...JSON.parse(done.result as string), provedAt: done.updatedAt } as StepProof;
      }
      case "fork-observation": {
        const chainId = Number(subject);
        const observation = Number.isSafeInteger(chainId) && chainId > 0 ? latestObservationView(storage, chainId) : null;
        return observation === null ? null : { kind, subject, observation };
      }
      case "layout-rows":
      case "deliver": {
        const text = MESSAGE_ID.test(subject.toLowerCase()) ? (input.archive()?.readEvidence(subject.toLowerCase()) ?? null) : null;
        return text === null ? null : ({ kind, subject: subject.toLowerCase(), evidence: JSON.parse(text) } as StepProof);
      }
      default:
        return null;
    }
  }

  return {
    async submit(request) {
      failLostStepJobs(storage, now(), input.proverTimeoutMilliseconds);
      if (!isRequestableKind(request.kind)) return { invalid: `unknown kind ${String(request.kind)}` };
      if (request.liveness !== true) {
        const wait = callerWait(request.caller, now());
        if (wait > 0) return { refused: "rate-limited", retryAfterSeconds: wait, why: "limit" };
      }
      switch (request.kind) {
        case "light-client-update":
          return lightClientUpdate(request);
        case "registry-light-client-update":
          return registryUpdate(request);
        case "fork-observation":
          return forkObservation(request);
        case "open-deposits":
          return openDeposits(request);
        default:
          return evidence(request, request.kind);
      }
    },
    job(jobId) {
      const [prefix, ...rest] = jobId.split(":");
      const id = rest.join(":");
      if (prefix === "job") return lightClientJob(id);
      if (prefix === "observation") {
        const attempt = getObservationAttempt(storage, id);
        if (attempt === null) return null;
        const status = attempt.status === "proving" ? "running" : attempt.status === "failed" ? "failed" : "done";
        const side = pair.sides.find((candidate) => candidate.chainId === attempt.chainId);
        const direction = side === undefined ? "first-to-second" : directionFrom(pair, side);
        return {
          jobId,
          kind: "fork-observation",
          subject: String(attempt.chainId),
          status,
          startedAt: attempt.startedAt,
          updatedAt: attempt.endedAt ?? attempt.startedAt,
          etaAt: etaOf(direction, attempt.startedAt, status),
          error: attempt.error,
        };
      }
      if (prefix === "step") {
        const row = getStepJob(storage, jobId);
        if (row === null) return null;
        const side = row.kind === "registry-light-client-update" ? registrySideOf(pair, row.subject) : null;
        const etaAt = side === null ? null : etaOf(directionFrom(pair, side), row.startedAt, row.status);
        return { jobId, kind: kindOfRow(row), subject: row.subject, status: row.status, startedAt: row.startedAt, updatedAt: row.updatedAt, etaAt, error: row.error };
      }
      if (prefix === "ready" && rest.length === 2) {
        const [kind, subject] = rest as [RouteStepKind, string];
        if (proof(kind, subject) === null) return null;
        return { jobId, kind, subject, status: "done", startedAt: now(), updatedAt: now(), etaAt: null, error: null };
      }
      return null;
    },
    proof,
    async wait(jobId) {
      await running.get(jobId);
    },
    async settled() {
      while (running.size > 0) await Promise.all([...running.values()]);
    },
  };
}
