/**
 * The `seal` module: per chain of the pair, once per epoch of that chain, the auto-seal of its deposit gate
 * ({@link createSealWatch}). It signs with the signer of `seal.signer`, configured as the runner's signer of
 * `explorer/bots` (a private key, a keystore, a mnemonic or a hardware wallet; secrets by reference, never in the file),
 * and sends through the runner's transaction port (exact gas with a buffer, the chain's minimum priority fee, a receipt
 * wait). Nothing is sent unless `offerSeal` simulated the call without a revert. It adds no routes.
 */
import type { Hono } from "hono";
import { createPublicClient, http, type PublicClient } from "viem";
import { createBeaconProofSource, epochSeconds, minimumPriorityFeeWei, offerSeal, type GateChainClient, type PairSide } from "@zk-bridge/shared";
import { createTransactionPort, sendTerms, type TransactionPort } from "../../../bots/src/chain/transactions.ts";
import type { Signer } from "../../../bots/src/signing/open-signer.ts";
import type { Logger as BotLogger } from "../../../bots/src/logging/logger.ts";
import type { Logger } from "../logger.ts";
import type { BackendModuleContext } from "../module.ts";
import { createSealWatch, type SealSender } from "./seal-watch.ts";

/** What a test replaces. */
export type SealDependencies = {
  /** The client of a side. Default: viem over the side's RPC endpoint. */
  readonly client?: (side: PairSide) => PublicClient;
  /** The transaction port of a side. Default: the runner's port over the client and the signer. */
  readonly port?: (side: PairSide, signer: Signer) => TransactionPort;
  /** Runs `check` every so often. Default: `setInterval`, unreferenced. Returns the function that stops it. */
  readonly every?: (milliseconds: number, check: () => void) => () => void;
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

/** No routes. */
export function register(_app: Hono, _context: BackendModuleContext): void {}

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
  const stoppers: Array<() => void> = [];
  for (const side of pair.sides) {
    const client = clientOf(side) as unknown as GateChainClient;
    const beacon = side.beaconUrl === null ? undefined : createBeaconProofSource({ url: side.beaconUrl });
    const watch = createSealWatch({
      chainId: side.chainId,
      chainName: side.name,
      gate: side.contracts.gate,
      offer: () => offerSeal({ client, gate: side.contracts.gate, account: signer.address, ...(beacon === undefined ? {} : { beacon }) }),
      send: portSender(portOf(side, signer)),
      logger,
      // The alert path of the backend is its log: an `alert` line at error level, which the operator's log shipping picks
      // up. The status service also turns `gate-<chainId>` down once the gate is sealed (its webhook, when configured).
      alert: (text) => logger.error("alert", { text }),
    });
    void watch.check();
    stoppers.push(every(epochSeconds(side.chainId) * 1000, () => void watch.check()));
  }
  logger.info("seal_started", { chains: pair.sides.map((side) => side.chainId), signer: signer.address });
  return async () => {
    for (const stop of stoppers) stop();
  };
}
