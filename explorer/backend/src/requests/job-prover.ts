import { dirname, join } from "node:path";
import type { Pair } from "@zk-bridge/shared";
import { createProverBinary, type BackendSection, type CommandExecutor, type ForkObservationProver, type ForkProofProver, type HandoffProver, type HeadProver, type OpeningProver, type ProverBinary } from "@zk-bridge/shared/prover";
import { forkProofArchiveBases, handoffArchiveBases, type BackendConfig, type BackendSecrets } from "../config.ts";
import type { Logger } from "../logger.ts";

/** Input of {@link createProverFactories}. */
export interface ProverFactoryInput {
  readonly config: BackendConfig;
  readonly pair: Pair;
  readonly executor: CommandExecutor;
  /** The values of the secrets. They travel only in the environment of the child process. */
  readonly secrets: BackendSecrets;
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
  /** A wrapper without a proving backend, for `verify`, `evidence`, `handoff-update`, `fork-proof` and `opening-proof`. */
  readonly utilityProver: ProverBinary & HandoffProver & ForkProofProver & OpeningProver;
  /**
   * The wrapper for `fork-observation` and for `prove` from a named head (a fork registry's light client): the same remote
   * endpoints and keys as a proving job, and no webhook (the package comes back on standard output).
   */
  readonly observationProver: ForkObservationProver & HeadProver;
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
    handoffArchiveUrls: handoffArchiveBases(config),
    forkProofArchiveUrls: forkProofArchiveBases(config),
    logger: input.logger,
  };
  const webhookBase = config.publicUrl.replace(/\/+$/, "");
  // The single endpoint keeps the file it always had; a list becomes `[[prover.remote_endpoints]]`.
  const mode = { mode: "load-balancing" } as const;
  const backend: BackendSection =
    config.remote.endpoints === undefined
      ? { kind: "remote", mode, endpoint: config.remote.endpoint as string, apiKeyVariable: config.runpodApiKeyVariable as string }
      : { kind: "remote", mode, endpoints: config.remote.endpoints };
  return {
    proverForJob: (jobId) =>
      createProverBinary({
        ...common,
        backend,
        handoff: { webhookUrl: `${webhookBase}/webhook/jobs/${jobId}`, bearerVariable: config.webhookBearerVariable },
        proverSecret: input.secrets.proverKeys,
        baseEnvironment: { PATH: input.path, [config.webhookBearerVariable]: input.secrets.webhookBearer },
      }),
    utilityProver: createProverBinary({ ...common, backend: null, proverSecret: null, baseEnvironment: { PATH: input.path } }),
    observationProver: createProverBinary({ ...common, backend, proverSecret: input.secrets.proverKeys, baseEnvironment: { PATH: input.path } }),
  };
}
