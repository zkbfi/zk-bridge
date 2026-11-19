import { deliveryRouterAbi, routerDeliveryFromLogs, type PairSide, type TransferRow } from "@zk-bridge/shared";
import type { Hex } from "viem";

/** The client calls this module makes. Ponder's client caches both, so a reindex reads the same answers. */
export type RouterDeliveryClient = {
  readonly getTransactionReceipt: (input: { hash: Hex }) => Promise<{ readonly logs: readonly { address: Hex; topics: readonly Hex[]; data: Hex; logIndex: number }[] }>;
  readonly readContract: (input: { address: Hex; abi: typeof deliveryRouterAbi; functionName: "rewardAddress"; blockNumber: bigint }) => Promise<unknown>;
};

/** The inputs of {@link routerDeliveryPatch}. */
export type RouterDeliveryPatchInput = {
  readonly client: RouterDeliveryClient;
  readonly side: PairSide;
  /** The router that `TokensBridged` paid, lowercase. */
  readonly router: Hex;
  readonly token: Hex;
  readonly value: bigint;
  readonly transactionHash: Hex;
  /** The `to` of the delivery transaction: the bridge itself means a direct execution, which takes no fee. */
  readonly transactionTo: Hex | null;
  /** The log index of `TokensBridged`. */
  readonly logIndex: number;
  readonly blockNumber: bigint;
};

const lower = (address: string): Hex => address.toLowerCase() as Hex;

/** The router's reward address, or null when the router does not answer. */
const rewardAddressOf = async (input: RouterDeliveryPatchInput): Promise<Hex | null> => {
  try {
    const answer = await input.client.readContract({ address: input.router, abi: deliveryRouterAbi, functionName: "rewardAddress", blockNumber: input.blockNumber });
    return typeof answer === "string" && /^0x[0-9a-fA-F]{40}$/.test(answer) ? lower(answer) : null;
  } catch {
    return null;
  }
};

/**
 * Reads the split of one router delivery from its transaction receipt and returns the transfer facts to store. The
 * router's `Delivered` event wins; a router without it is read from the transfer logs (see `routerDeliveryFromLogs`).
 *
 * @param input The client, the side, the router and the `TokensBridged` event.
 * @returns The facts, or just the router when the receipt shows no trace of the router's callback.
 */
export const routerDeliveryPatch = async (input: RouterDeliveryPatchInput): Promise<Partial<TransferRow>> => {
  // The receipt that Ponder attaches to the event has no logs, so the handler reads the full receipt (cached by Ponder).
  const receipt = await input.client.getTransactionReceipt({ hash: input.transactionHash });
  const rewardAddress = await rewardAddressOf(input);
  const split = routerDeliveryFromLogs({
    logs: receipt.logs.map((log) => ({ address: log.address, topics: log.topics, data: log.data, logIndex: Number(log.logIndex) })),
    tokensBridgedLogIndex: input.logIndex,
    router: input.router,
    token: input.token,
    value: input.value,
    wrappedNative: input.side.contracts.wrappedNative,
    rewardAddress,
    boundaries: [input.side.contracts.bridge, input.side.contracts.mediator],
    feePossible: input.transactionTo === null || lower(input.transactionTo) !== lower(input.side.contracts.bridge),
  });
  if (split === null) return { deliveryRouter: input.router };
  return {
    deliveryRouter: input.router,
    routerAmount: split.amount,
    fee: split.fee,
    received: split.received,
    deliverer: split.deliverer,
    finalRecipient: split.finalRecipient,
    feeSource: split.feeSource,
    handOffReason: split.handOffReason,
    handOffRefused: split.handOffRefused || null,
    callFailedTarget: split.callFailed?.target ?? null,
    callFailedRecipient: split.callFailed?.recipient ?? null,
    callFailedGas: split.callFailed?.gasGiven ?? null,
  };
};
