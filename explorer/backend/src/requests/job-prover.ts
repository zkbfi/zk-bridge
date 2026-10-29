import { dirname, join } from "node:path";
import type { Pair } from "@zk-bridge/shared";
import { createProverBinary, type CommandExecutor, type ProverBinary } from "@zk-bridge/shared/prover";
import type { BackendConfig } from "../config.ts";
import type { Logger } from "../logger.ts";

/** Input of {@link createProverFactories}. */
export interface ProverFactoryInput {
  readonly config: BackendConfig;
  readonly pair: Pair;
  readonly executor: CommandExecutor;
  /** The values of the two secrets. They travel only in the environment of the child process. */
  readonly secrets: { readonly runpodApiKey: string; readonly webhookBearer: string };
  /** The `PATH` of the child process. */
  readonly path: string;
  readonly logger: Logger;
}

/** The two kinds of prover wrapper that the backend needs. */
export interface ProverFactories {
  /**
   * The wrapper for one proving job. The prover config file names the webhook `<publicUrl>/webhook/jobs/<jobId>` and
   * the NAME of the bearer variable. The prover chooses the remote backend from the same file. No head is named, so the
   * prover starts from the head on chain.
   */
  readonly proverForJob: (jobId: string) => ProverBinary;
  /** A wrapper without a proving backend, for `verify` and `evidence`. */
  readonly utilityProver: ProverBinary;
}

/** Builds the prover wrappers from the configuration. */
export function createProverFactories(input: ProverFactoryInput): ProverFactories {
  const { config } = input;
  const common = {
    binaryPath: config.prover.binary,
    pair: input.pair,
    executor: input.executor,
    timeoutMilliseconds: config.prover.timeoutSeconds * 1000,
    temporaryDirectory: join(dirname(config.databasePath), "tmp"),
    stateCacheDirectory: join(dirname(config.databasePath), "beacon-states"),
    logger: input.logger,
  };
  const webhookBase = config.publicUrl.replace(/\/+$/, "");
  return {
    proverForJob: (jobId) =>
      createProverBinary({
        ...common,
        backend: { kind: "remote", mode: { mode: "load-balancing" }, endpoint: config.remote.endpoint, apiKeyVariable: config.runpodApiKeyVariable },
        handoff: { webhookUrl: `${webhookBase}/webhook/jobs/${jobId}`, bearerVariable: config.webhookBearerVariable },
        proverSecret: { variable: config.runpodApiKeyVariable, value: input.secrets.runpodApiKey },
        baseEnvironment: { PATH: input.path, [config.webhookBearerVariable]: input.secrets.webhookBearer },
      }),
    utilityProver: createProverBinary({ ...common, backend: null, proverSecret: null, baseEnvironment: { PATH: input.path } }),
  };
}
