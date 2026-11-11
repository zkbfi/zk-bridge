/**
 * The GPU numbers of a route step: how long a proof takes on a warm worker and with a worker start (medians of the newest
 * proofs), whether a worker is warm now, and the 24 h budget of a direction.
 */
import type { ProofDirection } from "@zk-bridge/shared";
import { recentJobSeconds } from "../requests/jobs.ts";
import { JOB_BUDGET_WINDOW_MILLISECONDS, gpuSpendUsd } from "../requests/rate-limit.ts";
import { recentTimings, statOf } from "../requests/timings.ts";
import type { Storage } from "../storage.ts";
import type { GpuEstimate } from "./service.ts";
import type { GpuView } from "./list.ts";

/** How many of the newest proofs the estimate reads. */
export const GPU_SAMPLE = 20;

/** A warm-up session that started longer ago than this no longer counts as a warm worker, in milliseconds. */
export const SESSION_LIMIT_MILLISECONDS = 3_600_000;

/**
 * The estimate now: the median prover run of the newest proofs (warm), plus the median wait for a worker of those that
 * met a cold one (cold); a worker is warm while a warm-up session is ready, or for the idle timeout after the last proof.
 *
 * @param idleMilliseconds How long a worker stays up after its last proof (the endpoint's idle timeout).
 */
export function gpuEstimateNow(storage: Storage, now: number, idleMilliseconds: number): GpuEstimate {
  const recent = recentTimings(storage, GPU_SAMPLE);
  const warmMs = statOf(recent.map((timing) => timing.totalMs)).medianMs;
  const waitMs = statOf(recent.filter((timing) => (timing.notReadyCount ?? 0) > 0).map((timing) => timing.waitWorkerMs)).medianMs;
  const session = storage.database
    .prepare("SELECT 1 FROM warmup_sessions WHERE ready_at IS NOT NULL AND ready_at <= ? AND started_at > ? AND (ended_at IS NULL OR ended_at >= ?) LIMIT 1")
    .get(now, now - SESSION_LIMIT_MILLISECONDS, now);
  const last = (storage.database.prepare("SELECT max(proved_at) AS last FROM job_timings").get() as { last: number | null }).last;
  return {
    warmMs,
    coldMs: warmMs === null ? null : warmMs + (waitMs ?? 0),
    workerWarm: session !== undefined || (last !== null && last + idleMilliseconds > now),
  };
}

/** The GPU view of a direction: the estimate and the budget at the price of a GPU hour. */
export function gpuViewOf(input: { readonly storage: Storage; readonly direction: ProofDirection; readonly now: number; readonly estimate: GpuEstimate; readonly usdPerHour: number; readonly budgetUsd: number }): GpuView {
  const spentUsd = gpuSpendUsd(recentJobSeconds(input.storage, input.direction, input.now - JOB_BUDGET_WINDOW_MILLISECONDS), input.usdPerHour);
  const round = (value: number) => Math.round(value * 100) / 100;
  return { ...input.estimate, budgetUsd: input.budgetUsd, spentUsd: round(spentUsd), leftUsd: round(Math.max(0, input.budgetUsd - spentUsd)) };
}
