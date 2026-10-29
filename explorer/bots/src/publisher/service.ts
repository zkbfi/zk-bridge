import { createPublicClient, http, type PublicClient } from "viem";
import { proofCategory, type ProofDirection } from "@zk-bridge/shared";
import { join } from "node:path";
import type { SecretReference } from "@zk-bridge/shared/config";
import { BotConfigError, type PublisherConfig } from "../config/bot-config.ts";
import { createIndexerClient } from "../indexer/client.ts";
import { createBoardPublisher, grindInWorker, type BoardPublisher, type GrindFunction } from "@zk-bridge/shared/msgboard";
import { createLightClientReader, createProverBinary, executeCommand, type BackendSection, type CommandExecutor } from "@zk-bridge/shared/prover";
import { sidesOfDirection, type BotContext } from "../runtime/context.ts";
import { runLoop } from "../runtime/loop.ts";
import { createStateFile } from "../runtime/state-file.ts";
import { createBinaryProofSource } from "./proof-source.ts";
import { runPublisherStep, type PublisherDependencies } from "./publisher.ts";
import { INITIAL_PUBLISHER_STATE, publisherStateSchema } from "./state.ts";

/** The seconds to wait after the prover said that there is nothing to prove. */
export const UP_TO_DATE_WAIT_SECONDS = 120;

/** Replacements for the parts that touch the outside world. Tests pass fakes. */
export interface PublisherOverrides {
  readonly executor?: CommandExecutor;
  readonly grind?: GrindFunction;
  readonly board?: BoardPublisher;
  readonly publicClient?: (rpcUrl: string) => PublicClient;
  readonly now?: () => number;
}

/** Input of {@link startPublisher}. */
export interface StartPublisherInput {
  readonly context: BotContext;
  readonly signal: AbortSignal;
  /** Run one step for each direction and return. */
  readonly runOnce: boolean;
  readonly overrides?: PublisherOverrides;
}

function requirePublisherConfig(context: BotContext): PublisherConfig {
  const publisher = context.config.publisher;
  if (publisher === undefined) throw new BotConfigError("The bot configuration has no publisher section.");
  return publisher;
}

interface Proving {
  readonly backend: BackendSection;
  readonly secret: { readonly variable: string; readonly value: string };
}

/** What the chosen backend needs, once the setup file passed the checks. */
type ProvingPlan =
  | { readonly kind: "oracle"; readonly keyVariable: string }
  | { readonly kind: "remote"; readonly mode: PublisherConfig["remote"]; readonly endpoint: string; readonly apiKeyVariable: string; readonly apiKey: SecretReference };

/**
 * Refuses a setup that the chosen backend cannot run with. The oracle backend needs nothing from the setup file.
 *
 * @throws BotConfigError when the remote backend lacks its endpoint or its key reference.
 */
function planProving(context: BotContext, publisher: PublisherConfig): ProvingPlan {
  if (publisher.backend === "oracle") return { kind: "oracle", keyVariable: publisher.oracleKeyVariable };
  const { setup } = context;
  if (setup.endpointUrl === "") throw new BotConfigError("The setup file has no remote prover endpoint (endpointUrl).");
  if (setup.runpodApiKey === null) throw new BotConfigError("The setup file has no reference to the RunPod key (runpodApiKey).");
  return { kind: "remote", mode: publisher.remote, endpoint: setup.endpointUrl, apiKeyVariable: publisher.apiKeyVariable, apiKey: setup.runpodApiKey };
}

/** Resolves the secret that the prover process reads from its environment. */
async function resolveProving(context: BotContext, plan: ProvingPlan): Promise<Proving> {
  if (plan.kind === "oracle") {
    // Local testing only: the oracle key is a test key from the environment.
    const value = await context.vault.resolve({ source: "environment", variable: plan.keyVariable });
    return { backend: { kind: "oracle", keyVariable: plan.keyVariable }, secret: { variable: plan.keyVariable, value } };
  }
  const value = await context.vault.resolve(plan.apiKey);
  return {
    backend: { kind: "remote", mode: plan.mode, endpoint: plan.endpoint, apiKeyVariable: plan.apiKeyVariable },
    secret: { variable: plan.apiKeyVariable, value },
  };
}

/**
 * Starts the proof publisher: one loop for each direction of the setup file. The publisher holds no wallet. Its secrets
 * are the RunPod key and the endpoints, all resolved through the vault.
 *
 * @throws BotConfigError when a required setting is missing.
 */
export async function startPublisher(input: StartPublisherInput): Promise<void> {
  const { context, signal } = input;
  const publisher = requirePublisherConfig(context);
  const { setup, pair, vault, logger } = context;
  const overrides = input.overrides ?? {};
  const plan = planProving(context, publisher);
  if (setup.msgboardUrl === null) throw new BotConfigError("The setup file has no msgboard endpoint (msgboardUrl).");
  if (setup.policy.proveWhenTransferWaits && publisher.indexerUrl === undefined) {
    throw new BotConfigError("The policy proves when a transfer waits, so publisher.indexerUrl is required.");
  }
  const proving = await resolveProving(context, plan);
  const boardUrl = await vault.resolve(setup.msgboardUrl);
  const board =
    overrides.board ??
    createBoardPublisher({
      boardUrl,
      maximumMessageBytes: context.config.maximumMessageBytes,
      grind: overrides.grind ?? grindInWorker,
      grindTimeoutMilliseconds: 300_000,
      logger,
    });
  const binary = createProverBinary({
    binaryPath: publisher.prover.binary,
    pair,
    executor: overrides.executor ?? executeCommand,
    timeoutMilliseconds: publisher.prover.timeoutSeconds * 1000,
    backend: proving.backend,
    proverSecret: proving.secret,
    baseEnvironment: { PATH: context.environment.PATH ?? "/usr/bin:/bin" },
    temporaryDirectory: join(context.config.stateDirectory, "tmp"),
    logger,
  });
  const indexer = publisher.indexerUrl === undefined ? null : createIndexerClient({ baseUrl: publisher.indexerUrl });
  const makeClient = overrides.publicClient ?? ((rpcUrl: string) => createPublicClient({ transport: http(rpcUrl, { timeout: 30_000 }) }));
  const loops = setup.directions.map((direction: ProofDirection) => {
    const { source, destination } = sidesOfDirection(pair, direction);
    const directionLogger = logger.child({ bot: "publisher", pair: pair.name, direction });
    const dependencies: PublisherDependencies = {
      pairName: pair.name,
      direction,
      category: proofCategory(pair.name, direction),
      lightClient: createLightClientReader(makeClient(destination.rpcUrl), destination.contracts.lightClient),
      proofSource: createBinaryProofSource(binary),
      board,
      transferWaits:
        indexer === null
          ? null
          : async () => (await indexer.listFeed({ sourceChainId: source.chainId, destinationChainId: destination.chainId, statuses: ["waiting_for_finality"], limit: 1 })).items.length > 0,
      state: createStateFile({
        path: join(context.config.stateDirectory, `publisher-${pair.name}-${direction}.json`),
        schema: publisherStateSchema,
        initial: INITIAL_PUBLISHER_STATE,
      }),
      policy: setup.policy,
      republishSeconds: publisher.republishSeconds,
      retryBackoffSeconds: publisher.retryBackoffSeconds,
      upToDateWaitSeconds: UP_TO_DATE_WAIT_SECONDS,
      acceptOracleProof: publisher.backend === "oracle",
      now: overrides.now ?? Date.now,
      logger: directionLogger,
    };
    directionLogger.info("publisher_started", { category: dependencies.category, pollSeconds: publisher.pollSeconds });
    return runLoop({
      name: `publisher ${direction}`,
      intervalMilliseconds: publisher.pollSeconds * 1000,
      step: async () => {
        const result = await runPublisherStep(dependencies);
        directionLogger[result.action === "idle" ? "debug" : "info"]("publisher_step", { ...result });
      },
      signal,
      runOnce: input.runOnce,
      logger: directionLogger,
    });
  });
  await Promise.all(loops);
}
