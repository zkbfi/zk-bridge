import { PROOF_DIRECTIONS, type ProofDirection } from "@zk-bridge/shared";
import { countQueuedJobs, findLatestJob, type Job } from "./requests/jobs.ts";
import type { PreflightResult } from "@zk-bridge/shared/msgboard";
import type { Storage } from "./storage.ts";

/** The state of one module. */
export type ModuleHealth = {
  readonly state: "running" | "not built" | "degraded";
  readonly detail?: string;
};

/** What the start-up test of the grind engine found. The status service reads it as the check `grind-engine`. */
export type GrindEngineHealth =
  | { readonly state: "ok"; readonly durationMilliseconds: number }
  | { readonly state: "failed"; readonly reason: "load-failed" | "wrong-result" | "timeout"; readonly detail: string };

/** The health of the grind engine from the result of the preflight. */
export function grindEngineHealth(result: PreflightResult): GrindEngineHealth {
  return result.ok ? { state: "ok", durationMilliseconds: result.durationMilliseconds } : { state: "failed", reason: result.reason, detail: result.detail };
}

/** The answer of `GET /health`. */
export type HealthReport = {
  readonly status: "ok";
  readonly time: number;
  readonly modules: Readonly<Record<string, ModuleHealth>>;
  readonly queue: { readonly length: number };
  readonly lastJobs: Readonly<Record<ProofDirection, Job | null>>;
  /** The start-up test of the grind engine. Absent when no module that grinds runs. */
  readonly grindEngine?: GrindEngineHealth;
};

/** Collects the health of the running modules, the queue and the newest job of each direction. */
export function buildHealthReport(input: { storage: Storage; modules: Readonly<Record<string, ModuleHealth>>; now: number; grindEngine?: PreflightResult }): HealthReport {
  const lastJobs = Object.fromEntries(PROOF_DIRECTIONS.map((direction) => [direction, findLatestJob(input.storage, direction)])) as Record<ProofDirection, Job | null>;
  return { status: "ok", time: input.now, modules: input.modules, queue: { length: countQueuedJobs(input.storage) }, lastJobs, ...(input.grindEngine === undefined ? {} : { grindEngine: grindEngineHealth(input.grindEngine) }) };
}
