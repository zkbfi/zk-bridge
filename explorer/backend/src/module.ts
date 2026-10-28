import type { Hono } from "hono";
import type { ProverBinary } from "@zk-bridge/shared/prover";
import type { BackendConfig, ModuleName } from "./config.ts";
import type { ModuleHealth } from "./health.ts";
import type { Logger } from "./logger.ts";
import type { Storage } from "./storage.ts";

/** What every module receives. */
export type BackendModuleContext = {
  readonly storage: Storage;
  readonly config: BackendConfig;
  /** A prover wrapper without a proving backend: it runs `verify` and `evidence`. */
  readonly prover: ProverBinary;
  /** The prover wrapper for one proving job, with the webhook of that job. Used by the request service. */
  readonly proverForJob: (jobId: string) => ProverBinary;
  /** Milliseconds since 1970. */
  readonly now: () => number;
  readonly logger: Logger;
};

/** The two functions every module exports, plus an optional health report. */
export interface BackendModule {
  /** Adds the routes of the module. */
  register(app: Hono, context: BackendModuleContext): void;
  /** Starts the background work. Resolves with the function that stops it. */
  start(context: BackendModuleContext): Promise<() => Promise<void>>;
  /** The state of the module for `GET /health`. A module that does not export it counts as running. */
  health?(context: BackendModuleContext): ModuleHealth;
}

/** The modules by name. */
export type ModuleTable = Readonly<Record<ModuleName, BackendModule>>;
