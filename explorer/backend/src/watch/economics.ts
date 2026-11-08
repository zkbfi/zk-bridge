/**
 * What a batch of waiting messages is worth to the fee address, and what proving and delivering it costs, in dollars
 * at one named PulseChain block. The rules are the dapp's: the fee is the one the delivery router takes under each
 * message's delivery terms (`expectedFee`), valued with the PulseX price rules (`pulsex-oracle.ts`); the cost of a
 * delivery is `deliveryGasUsd` of the core fee rules. Testnet tokens have no price, so a testnet batch never pays early.
 *
 * The runner that delivers is not paid by the backend: "pays" means the fee address's take covers our costs.
 */
import type { Address, Hex } from "viem";
import {
  DEFAULT_GAS_LEVEL,
  TESTNETS,
  decodeMediatorMessage,
  deliveryGasUsd,
  expectedFee,
  minimumPriorityFeeWei,
  nativeUsd,
  payoutOf,
  plsUsd,
  poolReaderOver,
  readDeliveryTerms,
  resolvePricingAddress,
  tokenUsd,
  usdOf,
  type ContractCaller,
} from "@zk-bridge/shared";
import type { Economics } from "./batch.ts";

/**
 * The gas one delivery is counted at. A message has no gas limit of its own, so this is an estimate: the proof check
 * (the bridge test measures 290,655), the bridge, the release and the tip, rounded up. Above what a plain release uses,
 * so the cost errs high and a batch proves early only when it surely pays.
 */
export const DELIVERY_GAS = 400_000n;

/** The destination token of a message, as the indexer lists it. */
export type DestinationToken = {
  readonly address: Address;
  readonly decimals: number | null;
  readonly isBridgedCopy: boolean | null;
  readonly homeChainId: number | null;
  readonly homeToken: Address | null;
};

/** A waiting message to value. */
export type ValuedMessage = { readonly messageId: Hex; readonly destinationToken?: DestinationToken | null };

/** What the reader reads. */
export type EconomicsDependencies = {
  /** The call data of a message (`GET /api/messages/:id` of the chain indexer). */
  readonly readMessageData: (messageId: Hex) => Promise<Hex>;
  /** PulseChain, where the prices are; null when no endpoint is configured. */
  readonly pulsechain: (ContractCaller & { readonly getBlockNumber: () => Promise<bigint> }) | null;
  /** The base fee of the newest block of the destination chain, in wei (0 when it reports none). */
  readonly destinationBaseFee: () => Promise<bigint>;
};

/** Input of {@link createEconomicsReader}. */
export type EconomicsInput = {
  readonly destinationChainId: number;
  /** The delivery router of the destination: a message pays a fee only when it sends its tokens there. */
  readonly deliveryRouter: Address | null;
  readonly wrappedNative: Address;
  readonly dependencies: EconomicsDependencies;
};

/** The fee a message carries for the fee address, in base units of its destination token. 0 when it carries none. */
function feeOf(data: Hex, input: EconomicsInput, token: DestinationToken | null, gas: { baseFeeWei: bigint; priorityFeeWei: bigint }): bigint {
  const message = decodeMediatorMessage(data);
  if (message === null || input.deliveryRouter === null || message.recipient.toLowerCase() !== input.deliveryRouter.toLowerCase() || message.callbackData === null) return 0n;
  const terms = readDeliveryTerms(message.callbackData);
  if (terms.kind !== "director") return 0n;
  const payout = payoutOf(terms.director.settings, token?.address.toLowerCase() === input.wrappedNative.toLowerCase());
  try {
    return expectedFee(terms.director, { value: message.value, gasUsed: DELIVERY_GAS, ...gas, payout }).fee;
  } catch {
    // The router would revert on an overflow: no fee.
    return 0n;
  }
}

/**
 * Builds the reader of one direction. It keeps the call data of each message it read (call data never changes) while
 * the message waits.
 *
 * @returns A function that values the waiting messages; it answers `unknown` with the reason when it cannot, and
 *   throws only when a read fails.
 */
export function createEconomicsReader(input: EconomicsInput): (messages: readonly ValuedMessage[]) => Promise<Economics> {
  const { dependencies, destinationChainId } = input;
  const data = new Map<Hex, Hex>();
  return async (messages) => {
    if (TESTNETS.has(destinationChainId)) return { kind: "unknown", why: "testnet tokens have no price" };
    const pulsechain = dependencies.pulsechain;
    if (pulsechain === null) return { kind: "unknown", why: "no PulseChain endpoint to read prices from" };
    const block = await pulsechain.getBlockNumber();
    const reader = poolReaderOver(pulsechain, block);
    const [native, pls, baseFeeWei] = await Promise.all([nativeUsd(reader, destinationChainId), plsUsd(reader), dependencies.destinationBaseFee()]);
    if (native === null || pls === null) return { kind: "unknown", why: `no price for the destination's coin at PulseChain block ${block}` };
    const gas = { baseFeeWei, priorityFeeWei: minimumPriorityFeeWei(destinationChainId) };
    for (const known of [...data.keys()]) if (!messages.some((message) => message.messageId === known)) data.delete(known);
    const feesUsd = new Map<string, bigint>();
    let unpriced = 0;
    for (const message of messages) {
      const callData = data.get(message.messageId) ?? (await dependencies.readMessageData(message.messageId));
      data.set(message.messageId, callData);
      const token = message.destinationToken ?? null;
      const fee = feeOf(callData, input, token, gas);
      if (fee === 0n) continue;
      const pricing = token === null || token.decimals === null ? null : await resolvePricingAddress({ chainId: destinationChainId, address: token.address, origin: token.isBridgedCopy === true && token.homeChainId !== null && token.homeToken !== null ? { chainId: token.homeChainId, address: token.homeToken } : null }, reader);
      const quote = pricing === null ? null : await tokenUsd(reader, pricing, token?.decimals as number, pls);
      if (quote === null) {
        unpriced += 1;
        continue;
      }
      feesUsd.set(message.messageId, usdOf(fee, token?.decimals as number, quote.usdE18));
    }
    const deliveryUsd = deliveryGasUsd({ gasUsed: DELIVERY_GAS, ...gas, nativePriceE18: native.usdE18, level: DEFAULT_GAS_LEVEL });
    return { kind: "known", feesUsd, deliveryUsd, unpriced, block: String(block) };
  };
}
