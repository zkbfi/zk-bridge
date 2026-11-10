/**
 * What a batch of waiting messages is worth to the fee address, and what proving and delivering it costs, in dollars
 * at one named PulseChain block. The rules are the dapp's and the runner's, from `@zkb/core`: the fee is the one the
 * delivery router takes under each message's delivery terms (`expectedFee`), the price is the one price source
 * (`token-pricing.ts`, PulseX pools through the backend's PulseChain client, with the dapp's stale rule), and each tip
 * is judged by the one verdict (`tipVerdictOfTerms`). The cost of a delivery is `deliveryGasUsd` of the core fee rules.
 *
 * A message whose token has no price (no market, a testnet token, or the source unreachable with no recent price)
 * cannot be valued: its tip pays when it is at least the frontend's automatic maximum (1% of the amount), and such a
 * message makes its batch pay (owner, 2026-11-09: "yes, deliver straight away"). A smaller tip counts nothing.
 *
 * The runner that delivers is not paid by the backend: "pays" means the fee address's take covers our costs.
 */
import type { Address, Hex } from "viem";
import {
  DEFAULT_GAS_LEVEL,
  PROOF_COST_USD,
  TESTNETS,
  WAD,
  createPriceKeeper,
  decodeMediatorMessage,
  deliveryGasUsd,
  expectedFee,
  feeValueOf,
  minimumPriorityFeeWei,
  nativePriceKey,
  payoutOf,
  poolReaderAtLatest,
  readDeliveryTerms,
  tipVerdictOfTerms,
  tokenValuationIn,
  type FeeDirector,
  type PayoutKind,
  type PriceSubject,
  type PulseChainClient,
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
  /** PulseChain, where the prices are; null when no endpoint is configured (a testnet pair needs none). */
  readonly pulsechain: PulseChainClient | null;
  /** The base fee of the newest block of the destination chain, in wei (0 when it reports none). */
  readonly destinationBaseFee: () => Promise<bigint>;
};

/** Input of {@link createEconomicsReader}. */
export type EconomicsInput = {
  readonly destinationChainId: number;
  /** The delivery router of the destination: a message pays a fee only when it sends its tokens there. */
  readonly deliveryRouter: Address | null;
  readonly wrappedNative: Address;
  /** The direction's profit margin (1e18 = 1), for the verdict on each tip alone. Default 1. */
  readonly marginWad?: bigint;
  readonly dependencies: EconomicsDependencies;
  /** The clock in milliseconds, for the age of a stale price. Default `Date.now`. */
  readonly now?: () => number;
};

/** The terms a message carries for the fee address: its director, the amount released to the router and the payout. Null when it carries none. */
function termsOf(data: Hex, input: EconomicsInput, token: DestinationToken | null): { readonly director: FeeDirector; readonly value: bigint; readonly payout: PayoutKind } | null {
  const message = decodeMediatorMessage(data);
  if (message === null || input.deliveryRouter === null || message.recipient.toLowerCase() !== input.deliveryRouter.toLowerCase() || message.callbackData === null) return null;
  const terms = readDeliveryTerms(message.callbackData);
  if (terms.kind !== "director") return null;
  return { director: terms.director, value: message.value, payout: payoutOf(terms.director.settings, isWrappedNative(token, input)) };
}

/** Whether the token is the destination's wrapped native coin. */
const isWrappedNative = (token: DestinationToken | null, input: EconomicsInput): boolean => token?.address.toLowerCase() === input.wrappedNative.toLowerCase();

/** The token as the price source reads it: its chain, address, and origin when zkb.fi minted it. */
const subjectOf = (messageId: Hex, token: DestinationToken, destinationChainId: number): PriceSubject => ({
  key: messageId,
  token: { chainId: destinationChainId, address: token.address, origin: token.isBridgedCopy === true && token.homeChainId !== null && token.homeToken !== null ? { chainId: token.homeChainId, address: token.homeToken } : null },
  decimals: token.decimals as number,
});

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
  const pulsechain = dependencies.pulsechain;
  const prices = createPriceKeeper({ poolReader: pulsechain === null ? null : () => poolReaderAtLatest(pulsechain), now: input.now ?? Date.now });
  const marginWad = input.marginWad ?? WAD;
  return async (messages) => {
    const baseFeeWei = await dependencies.destinationBaseFee();
    const gas = { baseFeeWei, priorityFeeWei: minimumPriorityFeeWei(destinationChainId) };
    for (const known of [...data.keys()]) if (!messages.some((message) => message.messageId === known)) data.delete(known);
    const carried: { readonly message: ValuedMessage; readonly token: DestinationToken | null; readonly terms: NonNullable<ReturnType<typeof termsOf>>; readonly fee: bigint }[] = [];
    for (const message of messages) {
      const callData = data.get(message.messageId) ?? (await dependencies.readMessageData(message.messageId));
      data.set(message.messageId, callData);
      const token = message.destinationToken ?? null;
      const terms = termsOf(callData, input, token);
      if (terms === null) continue;
      let fee = 0n;
      try {
        fee = expectedFee(terms.director, { value: terms.value, gasUsed: DELIVERY_GAS, ...gas, payout: terms.payout }).fee;
      } catch {
        // The router would revert on an overflow: no fee.
      }
      if (fee > 0n) carried.push({ message, token, terms, fee });
    }
    const subjects = carried.flatMap(({ message, token }) => (token === null || token.decimals === null ? [] : [subjectOf(message.messageId, token, destinationChainId)]));
    const holding = await prices.read(subjects, [destinationChainId]);
    const native = holding.data?.get(nativePriceKey(destinationChainId)) ?? null;
    const nativeState = holding.states.get(nativePriceKey(destinationChainId));
    const deliveryUsd = native === null ? null : deliveryGasUsd({ gasUsed: DELIVERY_GAS, ...gas, nativePriceE18: native.usdE18, level: DEFAULT_GAS_LEVEL });
    const feesUsd = new Map<string, bigint>();
    const atMaximum = new Set<string>();
    let unpriced = 0;
    for (const { message, token, terms, fee } of carried) {
      const valuation = tokenValuationIn(holding, message.messageId, destinationChainId, isWrappedNative(token, input));
      const decimals = token?.decimals ?? 0;
      const price = { state: token === null || token.decimals === null ? ({ kind: "unreachable" } as const) : valuation.state, perWholeToken: valuation.usdE18 };
      const verdict = tipVerdictOfTerms({
        director: terms.director,
        amount: terms.value,
        gas: { gasUsed: DELIVERY_GAS, ...gas, payout: terms.payout },
        decimals,
        price,
        cost: deliveryUsd === null ? null : PROOF_COST_USD + deliveryUsd,
        rule: { kind: "margin", marginWad },
      });
      if (verdict === "unpriced-at-max") atMaximum.add(message.messageId);
      else if (verdict === "unpriced-below-max") unpriced += 1;
      else feesUsd.set(message.messageId, feeValueOf(fee, decimals, price) as bigint);
    }
    const why =
      deliveryUsd !== null ? null : TESTNETS.has(destinationChainId) ? "testnet tokens have no price" : nativeState?.kind === "unreachable" ? "the prices could not be read" : `no price for the destination's coin`;
    return { kind: "known", feesUsd, deliveryUsd, unpriced, atMaximum, why, block: holding.data === undefined ? null : blockOf(holding.data) };
  };
}

/** The PulseChain block the prices were read at, from any quote; null when none has one. */
function blockOf(data: ReadonlyMap<string, { readonly block: bigint } | null>): string | null {
  for (const quote of data.values()) if (quote !== null) return String(quote.block);
  return null;
}
