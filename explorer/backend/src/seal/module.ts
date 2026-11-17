/**
 * The `seal` module: per chain of the pair, once per epoch of that chain, the auto-seal of its deposit gate
 * ({@link createSealWatch}), and on a chain whose deposit gate seals from a `ForkRegistry` (PulseChain), the fork
 * observations that let it seal ({@link createObservationWatch}). It signs with the signer of `seal.signer`, configured as
 * the runner's signer of `explorer/bots` (a private key, a keystore, a mnemonic or a hardware wallet; secrets by
 * reference, never in the file), and sends through the runner's transaction port (exact gas with a buffer, the chain's
 * minimum priority fee, a receipt wait). Nothing is sent unless it simulated without a revert. On a chain with a registry it
 * also keeps the registry's own light client alive ({@link createRegistryKeepAlive}): the fallback poster of that route step
 * when nobody updated it for a period. Its one route serves the newest observation proof of a chain:
 * `GET /fork-observations/:chainId/latest`.
 */
import type { Hono } from "hono";
import { createPublicClient, http, type Address, type PublicClient } from "viem";
import {
  activeForkVersion,
  createBeaconProofSource,
  epochSeconds,
  fetchSourceForks,
  minimumPriorityFeeWei,
  offerSeal,
  readForkObservation,
  type GateChainClient,
  type PairSide,
  type ProofDirection,
} from "@zk-bridge/shared";
import { recentJobSeconds } from "../requests/jobs.ts";
import { JOB_BUDGET_WINDOW_MILLISECONDS, gpuBudgetWait } from "../requests/rate-limit.ts";
import { createObservationWatch, type BudgetState } from "./observe-watch.ts";
import { latestObservationView } from "./observations.ts";
import { createTransactionPort, sendTerms, type TransactionPort } from "../../../bots/src/chain/transactions.ts";
import type { Signer } from "../../../bots/src/signing/open-signer.ts";
import type { Logger as BotLogger } from "../../../bots/src/logging/logger.ts";
import type { Logger } from "../logger.ts";
import type { BackendModuleContext } from "../module.ts";
import { createSealWatch, type SealSender } from "./seal-watch.ts";
import { createRegistryKeepAlive } from "./registry-watch.ts";
import { createStepChainReads } from "../steps/chain.ts";
import { stepServiceOf } from "../steps/routes.ts";

/** What a test replaces. */
export type SealDependencies = {
  /** The client of a side. Default: viem over the side's RPC endpoint. */
  readonly client?: (side: PairSide) => PublicClient;
  /** The transaction port of a side. Default: the runner's port over the client and the signer. */
  readonly port?: (side: PairSide, signer: Signer) => TransactionPort;
  /** Runs `check` every so often. Default: `setInterval`, unreferenced. Returns the function that stops it. */
  readonly every?: (milliseconds: number, check: () => void) => () => void;
  /** The fetch of the beacon node's fork schedule. Default: the global fetch. */
  readonly fetch?: typeof fetch;
};

const intervalTimer = (milliseconds: number, check: () => void): (() => void) => {
  const timer = setInterval(check, milliseconds);
  timer.unref();
  return () => clearInterval(timer);
};

/** The send of a simulated seal: the fee quote of now, the gas of the simulation with the buffer, and the receipt. */
export function portSender(port: TransactionPort): SealSender {
  return async (call) => {
    const receipt = await port.send({ to: call.to, data: call.data, ...sendTerms(await port.feeQuote(), call.gas) });
    return { hash: receipt.hash, success: receipt.success };
  };
}

/** The backend logger in the shape of the runner's (`openSigner` logs the prompts of a hardware wallet through it). */
export function asBotLogger(logger: Logger): BotLogger {
  const adapted: BotLogger = {
    debug: (event, fields) => logger.debug(event, fields),
    info: (event, fields) => logger.info(event, fields),
    warn: (event, fields) => logger.warn(event, fields),
    error: (event, fields) => logger.error(event, fields),
    child: () => adapted,
  };
  return adapted;
}

/** `GET /fork-observations/:chainId/latest`: the newest observation proof of a chain, public fields only; 404 when none. */
export function register(app: Hono, context: BackendModuleContext): void {
  app.get("/fork-observations/:chainId/latest", (request) => {
    const chainId = Number(request.req.param("chainId"));
    const view = Number.isSafeInteger(chainId) && chainId > 0 ? latestObservationView(context.storage, chainId) : null;
    if (view === null) return request.json({ error: "no fork observation proof for this chain" }, 404);
    return request.json(view, 200);
  });
}

/** The direction whose source is a side: its GPU budget pays for an observation of that side's chain. */
function directionFrom(context: BackendModuleContext, side: PairSide): ProofDirection {
  return side.chainId === context.pair.sides[0].chainId ? "first-to-second" : "second-to-first";
}

/** The GPU budget of a direction now, priced as the request service prices it. */
async function budgetOf(context: BackendModuleContext, direction: ProofDirection): Promise<BudgetState> {
  const now = context.now();
  const usdPerHour = context.config.watch.warmup.gpuUsdPerHour;
  const budgetUsd = context.config.limits.gpuBudgetUsdPerDirectionPerDay;
  const spent = gpuBudgetWait({ jobs: recentJobSeconds(context.storage, direction, now - JOB_BUDGET_WINDOW_MILLISECONDS), usdPerHour, budgetUsd, now });
  return spent === null ? null : { ...spent, budgetUsd };
}

/**
 * Starts one watch per side whose gate is configured: a check at once, then one per epoch of the chain.
 *
 * @param context The context. Without `seal` in the configuration or without a signer the module logs why and does nothing.
 */
export async function start(context: BackendModuleContext, dependencies: SealDependencies = {}): Promise<() => Promise<void>> {
  const { config, pair, logger } = context;
  if (config.seal === undefined || context.openSealSigner === undefined) {
    logger.warn("seal_off", { reason: "the configuration has no seal section with a signer" });
    return async () => {};
  }
  const signer = await context.openSealSigner();
  const receiptTimeoutMilliseconds = config.seal.receiptTimeoutSeconds * 1000;
  const clientOf = dependencies.client ?? ((side: PairSide) => createPublicClient({ transport: http(side.rpcUrl) }) as PublicClient);
  const portOf =
    dependencies.port ??
    ((side: PairSide, chosen: Signer) =>
      createTransactionPort({ client: clientOf(side), signer: chosen, chainId: side.chainId, minimumPriorityFeeWei: minimumPriorityFeeWei(side.chainId), receiptTimeoutMilliseconds }));
  const every = dependencies.every ?? intervalTimer;
  // The alert path of the backend is its log: an `alert` line at error level, which the operator's log shipping picks
  // up. The status service also turns `gate-<chainId>` down once the gate is sealed (its webhook, when configured).
  const alert = (text: string): void => logger.error("alert", { text });
  const stoppers: Array<() => void> = [];
  const observing: number[] = [];
  const keepingAlive: number[] = [];
  const stepChain = context.stepChain ?? createStepChainReads({ clientOf: clientOf as (side: PairSide) => PublicClient });
  for (const side of pair.sides) {
    const client = clientOf(side) as unknown as GateChainClient;
    const beacon = side.beaconUrl === null ? undefined : createBeaconProofSource({ url: side.beaconUrl });
    const send = portSender(portOf(side, signer));
    const watch = createSealWatch({
      chainId: side.chainId,
      chainName: side.name,
      gate: side.contracts.gate,
      offer: () => offerSeal({ client, gate: side.contracts.gate, account: signer.address, ...(beacon === undefined ? {} : { beacon }) }),
      send,
      logger,
      alert,
    });
    void watch.check();
    const period = epochSeconds(side.chainId) * 1000;
    stoppers.push(every(period, () => void watch.check()));
    const registry = side.contracts.forkRegistry;
    if (registry !== null && context.headProver !== undefined && config.seal.registryKeepAlive.enabled) {
      const keepAlive = createRegistryKeepAlive({
        chainId: side.chainId,
        chainName: side.name,
        pair: config.pair,
        now: context.now,
        logger,
        alert,
        readState: () => stepChain.registryLightClient(side, registry),
        service: stepServiceOf(context),
        simulate: (call) => client.estimateGas({ account: signer.address, to: call.to, data: call.data }),
        send,
      });
      void keepAlive.check();
      stoppers.push(every(period, () => void keepAlive.check()));
      keepingAlive.push(side.chainId);
    }
    if (registry === null || side.beaconUrl === null || context.observationProver === undefined || !config.seal.observation.enabled) continue;
    const prover = context.observationProver;
    const beaconUrl = side.beaconUrl;
    const direction = directionFrom(context, side);
    const observe = createObservationWatch({
      chainId: side.chainId,
      chainName: side.name,
      registry,
      direction,
      storage: context.storage,
      now: context.now,
      logger,
      alert,
      limits: config.seal.observation,
      readFacts: async () => {
        const forks = await fetchSourceForks({ urls: [beaconUrl], ...(dependencies.fetch === undefined ? {} : { fetch: dependencies.fetch }) });
        if (forks.kind !== "known") throw new Error(forks.reason);
        const observed = await readForkObservation({ client, registry });
        return { activeVersion: activeForkVersion(forks.forks, forks.clock, Math.floor(context.now() / 1000)), registry: observed };
      },
      budget: () => budgetOf(context, direction),
      prove: () => prover.forkObservation({ direction, registry: registry as Address }),
      simulate: (data) => client.estimateGas({ account: signer.address, to: registry, data }),
      send,
      // A shape outside the allowed set: the seal watch seals from the registry now, not at its next epoch.
      onRecorded: ({ shapeAllowed }) => {
        if (!shapeAllowed) void watch.check();
      },
    });
    void observe.check();
    stoppers.push(every(period, () => void observe.check()));
    observing.push(side.chainId);
  }
  logger.info("seal_started", { chains: pair.sides.map((side) => side.chainId), observing, keepingAlive, signer: signer.address });
  return async () => {
    for (const stop of stoppers) stop();
  };
}
