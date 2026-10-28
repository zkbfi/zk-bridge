import { PROOF_DIRECTIONS, type ProofDirection } from "@zk-bridge/shared";
import { countQueuedJobs, findLatestJob, type Job } from "./requests/jobs.ts";
import type { Storage } from "./storage.ts";

/** The state of one module. */
export type ModuleHealth = {
  readonly state: "running" | "not built" | "degraded";
  readonly detail?: string;
};

/** The answer of `GET /health`. */
export type HealthReport = {
  readonly status: "ok";
  readonly time: number;
  readonly modules: Readonly<Record<string, ModuleHealth>>;
  readonly queue: { readonly length: number };
  readonly lastJobs: Readonly<Record<ProofDirection, Job | null>>;
};

/** Collects the health of the running modules, the queue and the newest job of each direction. */
export function buildHealthReport(input: { storage: Storage; modules: Readonly<Record<string, ModuleHealth>>; now: number }): HealthReport {
  const lastJobs = Object.fromEntries(PROOF_DIRECTIONS.map((direction) => [direction, findLatestJob(input.storage, direction)])) as Record<ProofDirection, Job | null>;
  return { status: "ok", time: input.now, modules: input.modules, queue: { length: countQueuedJobs(input.storage) }, lastJobs };
}
