import type { Hono } from "hono";
import type { Pair } from "@zk-bridge/shared";
import type { PreflightResult } from "@zk-bridge/shared/msgboard";
import type { ForkProofProver, HandoffProver, ProverBinary } from "@zk-bridge/shared/prover";
import type { BillingReader } from "./billing.ts";
import type { BackendConfig, ModuleName } from "./config.ts";
import type { LightClientFacts } from "./keepalive/plan.ts";
import type { PairSide } from "@zk-bridge/shared";
import type { ModuleHealth } from "./health.ts";
import type { Logger } from "./logger.ts";
import type { ProofNeedReader } from "./requests/proof-need.ts";
import type { Storage } from "./storage.ts";

/** What every module receives. */
export type BackendModuleContext = {
  readonly storage: Storage;
  readonly config: BackendConfig;
  /** The pair, from the deployment file and the endpoints of the configuration. No module reads the environment for them. */
  readonly pair: Pair;
  /** A prover wrapper without a proving backend: it runs `verify` and `evidence`. */
  readonly prover: ProverBinary;
  /** The prover wrapper for one proving job, with the webhook of that job. Used by the request service. */
  readonly proverForJob: (jobId: string) => ProverBinary;
  /** Whether a direction needs a proof, from the chain indexer. Used by the request service before it starts a job. */
  readonly readProofNeed: ProofNeedReader;
  /** Milliseconds since 1970. */
  readonly now: () => number;
  readonly logger: Logger;
  /**
   * Pings the remote prover's health route and answers the HTTP status. The watcher calls it to warm a worker before a
   * proof. Absent in a context without the key; the watcher then sends no warm-ups.
   */
  readonly pingProver?: () => Promise<number>;
  /** What RunPod billed, cached. Absent when no endpoint is a RunPod endpoint with a key; the summary then uses the assumed rate. */
  readonly billing?: BillingReader;
  /** The idle timeout that RunPod reports for the prover endpoint, from the start-up sync; null while unknown. Absent without a RunPod endpoint. */
  readonly endpointIdleTimeoutSeconds?: () => number | null;
  /** The `handoff-update` command, for the capture of the handoff archive (`archive/handoffs.ts`). Absent: no capture. */
  readonly handoffProver?: HandoffProver;
  /** The `fork-proof` command, for the fork proof capture (`archive/fork-proofs.ts`). Absent: no capture. */
  readonly forkProofProver?: ForkProofProver;
  /**
   * What the start-up test of the grind engine found, when a module that grinds runs. A failed engine means that no proof
   * of work is started. Absent in a context without the test.
   */
  readonly grindEngine?: PreflightResult;
  /** Reads the light client on a side. Default (absent): viem over the side's RPC endpoint. A test replaces it. */
  readonly readLightClientOf?: (side: PairSide) => Promise<LightClientFacts>;
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
