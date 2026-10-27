import { join } from "node:path";
import { createPublicClient, http, type Address, type PublicClient } from "viem";
import { proofCategory, type ProofDirection } from "@zk-bridge/shared";
import { BotConfigError, type RunnerConfig } from "../config/bot-config.ts";
import { createLightClientReader } from "../chain/light-client.ts";
import { createTransactionPort, type TransactionPort } from "../chain/transactions.ts";
import { createIndexerClient } from "../indexer/client.ts";
import { createBoardFeed, type BoardFeed } from "../msgboard/board.ts";
import { executeCommand, type CommandExecutor } from "../prover/execute-command.ts";
import { createProverBinary, type ProverBinary } from "../prover/prover-binary.ts";
import { sidesOfDirection, type BotContext } from "../runtime/context.ts";
import { acquireLock, type HeldLock } from "../runtime/lock-file.ts";
import { runLoop } from "../runtime/loop.ts";
import { createStateFile } from "../runtime/state-file.ts";
import { openSigner, type Signer } from "../signing/open-signer.ts";
import type { DeliveryDependencies, DeliverySettings } from "./delivery.ts";
import { createFileOutcomeSink } from "./outcomes.ts";
import { createRunner, type Runner } from "./runner.ts";
import { createSerialQueue } from "./serial-queue.ts";
import { createSourceReader } from "./source-reader.ts";
import { INITIAL_RUNNER_STATE, runnerStateSchema } from "./state.ts";
import { readRewardAddress } from "./router-reader.ts";

/** Replacements for the parts that touch the outside world. Tests pass fakes. */
export interface RunnerOverrides {
  readonly executor?: CommandExecutor;
  readonly feed?: BoardFeed;
  readonly publicClient?: (rpcUrl: string) => PublicClient;
  readonly signer?: Signer;
  /** Replaces the prover wrapper of a direction. The integration test uses it to stand in for Groth16 verification. */
  readonly prover?: (direction: ProofDirection) => ProverBinary;
  readonly now?: () => number;
}

/** Input of {@link startRunner}. */
export interface StartRunnerInput {
  readonly context: BotContext;
  readonly signal: AbortSignal;
  /** Check the board and sweep once for each direction, then return. No subscription opens. */
  readonly runOnce: boolean;
  readonly overrides?: RunnerOverrides;
}

function requireRunnerConfig(context: BotContext): RunnerConfig {
  const runner = context.config.runner;
  if (runner === undefined) throw new BotConfigError("The bot configuration has no runner section.");
  return runner;
}

/** Refuses to run when the Multicall3 address holds no code: every batch would revert. */
async function requireMulticall3(input: { readonly client: Pick<PublicClient, "getCode">; readonly address: Address; readonly chainName: string }): Promise<Address> {
  const code = await input.client.getCode({ address: input.address });
  if (code === undefined || code === "0x") {
    throw new BotConfigError(`runner.multicall3 ${input.address} holds no code on ${input.chainName}. Deploy Multicall3 there, or name the address of its deployment.`);
  }
  return input.address;
}

/** The delivery settings that the runner section of the configuration sets, with the wei texts read as numbers. */
export function deliverySettingsOf(runnerConfig: RunnerConfig): DeliverySettings {
  return {
    minimumMarginWei: BigInt(runnerConfig.minimumMarginWei),
    deliverWithoutOffer: runnerConfig.deliverWithoutOffer,
    tokenValuationsWei: valuations(runnerConfig.tokenValuationsWei),
    executionGasFallback: BigInt(runnerConfig.executionGasFallback),
    maximumPrerequisiteRounds: runnerConfig.maximumPrerequisiteRounds,
    prerequisiteGasFallback: BigInt(runnerConfig.prerequisiteGasFallback),
    maximumPrerequisiteSpendPerSweepWei: BigInt(runnerConfig.maximumPrerequisiteSpendPerSweepWei),
    maximumPrerequisiteSpendPerDayWei: BigInt(runnerConfig.maximumPrerequisiteSpendPerDayWei),
    maximumUnrecoveredPrerequisiteLossWei: BigInt(runnerConfig.maximumUnrecoveredPrerequisiteLossWei),
    maximumBatchSize: runnerConfig.maximumBatchSize,
    maximumBatchGas: BigInt(runnerConfig.maximumBatchGas),
  };
}

function valuations(settings: Readonly<Record<string, string>>): Readonly<Record<string, bigint>> {
  return Object.fromEntries(Object.entries(settings).map(([token, wei]) => [token.toLowerCase(), BigInt(wei)]));
}

function runnerStatePath(context: BotContext, direction: ProofDirection): string {
  return join(context.config.stateDirectory, `runner-${context.pair.name}-${direction}.json`);
}

/**
 * Starts the delivery runner. It first takes a lock file next to the state file of each direction, so that no second
 * runner process writes the same state. It releases the locks when the runner stops, also when it stops with an error.
 *
 * @throws LockHeldError when a live process already runs a runner over one of the state files.
 * @throws BotConfigError when a required setting is missing.
 */
export async function startRunner(input: StartRunnerInput): Promise<void> {
  const locks: HeldLock[] = [];
  try {
    for (const path of new Set((input.context.setup.directions as readonly ProofDirection[]).map((direction) => runnerStatePath(input.context, direction)))) {
      locks.push(await acquireLock({ path: `${path}.lock` }));
    }
    await runRunner(input);
  } finally {
    await Promise.all(locks.map((lock) => lock.release()));
  }
}

/**
 * Runs the delivery runner. For each direction of the setup file it
 *
 * 1. subscribes to the msgboard category of the direction, and reads the board again on each pass for the messages
 *    that a dropped socket missed;
 * 2. checks each proof message and posts `update` when the light client is behind;
 * 3. sweeps the covered, undelivered items of the indexer and delivers those whose fee pays.
 */
async function runRunner(input: StartRunnerInput): Promise<void> {
  const { context, signal } = input;
  const runnerConfig = requireRunnerConfig(context);
  const { setup, pair, vault, logger } = context;
  const overrides = input.overrides ?? {};
  if (setup.msgboardUrl === null) throw new BotConfigError("The setup file has no msgboard endpoint (msgboardUrl).");
  const boardUrl = await vault.resolve(setup.msgboardUrl);
  const signer = overrides.signer ?? (await openSigner({ settings: runnerConfig.signer, vault, logger }));
  logger.info("runner_signer_ready", { address: signer.address, kind: signer.kind });
  const makeClient = overrides.publicClient ?? ((rpcUrl: string) => createPublicClient({ transport: http(rpcUrl, { timeout: 30_000 }) }));
  const indexer = createIndexerClient({ baseUrl: runnerConfig.indexerUrl });
  const executor = overrides.executor ?? executeCommand;
  const feed =
    overrides.feed ??
    createBoardFeed({ boardUrl, reconnectDelayMilliseconds: 1_000, logger: logger.child({ bot: "runner" }) });
  const now = overrides.now ?? Date.now;
  const outcomes = createFileOutcomeSink({
    path: join(context.config.stateDirectory, `outcomes-${pair.name}.jsonl`),
    now: () => new Date(now()),
    knownSecrets: vault.knownSecrets,
  });
  const ports = new Map<number, { readonly chain: TransactionPort; readonly client: PublicClient }>();
  const portOf = (rpcUrl: string, chainId: number) => {
    const known = ports.get(chainId);
    if (known !== undefined) return known;
    const client = makeClient(rpcUrl);
    const created = {
      client,
      chain: createTransactionPort({
        client,
        signer,
        chainId,
        priorityFeeWei: runnerConfig.priorityFeeWei === undefined ? undefined : BigInt(runnerConfig.priorityFeeWei),
        receiptTimeoutMilliseconds: runnerConfig.receiptTimeoutSeconds * 1000,
      }),
    };
    ports.set(chainId, created);
    return created;
  };
  const queues = new Map<number, ReturnType<typeof createSerialQueue>>();
  const queueOf = (chainId: number) => {
    const known = queues.get(chainId) ?? createSerialQueue();
    queues.set(chainId, known);
    return known;
  };

  const jobs: Promise<void>[] = [];
  const subscriptions: Array<{ close(): Promise<void> }> = [];
  for (const direction of setup.directions as readonly ProofDirection[]) {
    const { source, destination } = sidesOfDirection(pair, direction);
    const directionLogger = logger.child({ bot: "runner", pair: pair.name, direction });
    const destinationPort = portOf(destination.rpcUrl, destination.chainId);
    const sourceClient = portOf(source.rpcUrl, source.chainId).client;
    const prover = overrides.prover?.(direction) ?? createProverBinary({
      binaryPath: runnerConfig.prover.binary,
      pair,
      executor,
      timeoutMilliseconds: runnerConfig.prover.timeoutSeconds * 1000,
      backend: null,
      proverSecret: null,
      baseEnvironment: { PATH: context.environment.PATH ?? "/usr/bin:/bin" },
      temporaryDirectory: join(context.config.stateDirectory, "tmp"),
      logger: directionLogger,
    });
    const deliveryRouter = (runnerConfig.deliveryRouter ?? destination.contracts.deliveryRouter) as Address | null;
    // A runner that only delivers directly uses no router, and reads no reward address.
    const rewardAddress = deliveryRouter === null ? null : await readRewardAddress({ client: destinationPort.client, deliveryRouter, chainName: destination.name });
    const multicall = deliveryRouter === null ? null : await requireMulticall3({ client: destinationPort.client, address: runnerConfig.multicall3 as Address, chainName: destination.name });
    const delivery: DeliveryDependencies = {
      direction,
      chain: destinationPort.chain,
      prover,
      indexer,
      source: createSourceReader(sourceClient, source.contracts.bridge),
      deliveryRouter,
      multicall,
      rewardAddress,
      wrappedNative: destination.contracts.wrappedNative,
      tokenFactory: destination.contracts.tokenFactory as Address,
      settings: deliverySettingsOf(runnerConfig),
      logger: directionLogger,
    };
    const runner: Runner = createRunner({
      pairName: pair.name,
      direction,
      sourceChainId: source.chainId,
      destinationChainId: destination.chainId,
      lightClientAddress: destination.contracts.lightClient,
      lightClient: createLightClientReader(destinationPort.client, destination.contracts.lightClient),
      delivery,
      state: createStateFile({
        path: runnerStatePath(context, direction),
        schema: runnerStateSchema,
        initial: INITIAL_RUNNER_STATE,
      }),
      outcomes,
      queue: queueOf(destination.chainId),
      now,
      maximumDeliveriesPerSweep: runnerConfig.maximumDeliveriesPerSweep,
      prerequisiteLossRefusalMilliseconds: runnerConfig.prerequisiteLossRefusalSeconds * 1000,
      logger: directionLogger,
    });
    const category = proofCategory(pair.name, direction);
    // `handleProofPayload` sweeps after it accepts a proof: the update goes with the first batch, or alone when none follows.
    const onPayload = async (payload: `0x${string}`): Promise<void> => {
      await runner.handleProofPayload(payload);
    };
    if (!input.runOnce) {
      subscriptions.push(
        await feed.subscribe(category, (message) => {
          onPayload(message.data).catch((error: unknown) => directionLogger.error("proof_message_failed", { error }));
        }),
      );
    }
    directionLogger.info("runner_started", { category, pollSeconds: runnerConfig.pollSeconds, deliveryRouter, rewardAddress });
    jobs.push(
      runLoop({
        name: `runner ${direction}`,
        intervalMilliseconds: runnerConfig.pollSeconds * 1000,
        step: async () => {
          for (const message of await feed.recent(category)) await onPayload(message.data);
          const summary = await runner.sweep();
          directionLogger.debug("runner_sweep", { ...summary });
        },
        signal,
        runOnce: input.runOnce,
        logger: directionLogger,
      }),
    );
  }
  await Promise.all(jobs);
  await Promise.all(subscriptions.map((subscription) => subscription.close()));
  await feed.close();
  await signer.dispose();
}
