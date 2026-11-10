import type { Address } from "viem";
import { createPriceKeeper, poolReaderAtLatest, tokenValuationIn, type PricedToken, type PulseChainClient, type TokenValuation } from "@zk-bridge/shared";

/**
 * Values a fee token for the runner: the one price source of zkb.fi (`token-pricing.ts` of `@zkb/core`), the same PulseX
 * pools, block rule and stale rule as the dapp and the backend, read through the runner's PulseChain RPC. It replaced
 * the hand-written `tokenValuationsWei` of the configuration (owner: "where are the prices coming from?").
 */
export type TokenPricing = (token: PricingToken) => Promise<TokenValuation>;

/** A fee token as the runner knows it. */
export interface PricingToken {
  /** The token on the destination chain. */
  readonly address: Address;
  readonly decimals: number;
  /** The token on the source chain that zkb.fi minted it from, when it is a copy; null when it is native here. */
  readonly origin: { readonly chainId: number; readonly address: Address } | null;
}

/** Input of {@link createTokenPricing}. */
export interface TokenPricingInput {
  readonly destinationChainId: number;
  readonly wrappedNative: Address;
  /**
   * PulseChain, where the prices are: the pair's PulseChain side. Null on a testnet pair, whose tokens have no market
   * and are valued without a read.
   */
  readonly pulsechain: PulseChainClient | null;
  /** The clock in milliseconds, for the age of a stale price. */
  readonly now: () => number;
  /** How long a token's valuation is used before the pools are read again, as the dapp reads them every 30 s. Default 30 s. */
  readonly refreshMilliseconds?: number;
}

/** The default time a valuation is used before the pools are read again: the dapp's refresh. */
export const PRICE_REFRESH_MILLISECONDS = 30_000;

/**
 * Builds the valuation of one direction's fee tokens. The last good prices are held for the stale rule, and a token's
 * valuation is used for {@link PRICE_REFRESH_MILLISECONDS} before its pools are read again: one sweep judges an item
 * several times (before the evidence, before the layout calls, in the batch).
 */
export function createTokenPricing(input: TokenPricingInput): TokenPricing {
  const pulsechain = input.pulsechain;
  const keeper = createPriceKeeper({ poolReader: pulsechain === null ? null : () => poolReaderAtLatest(pulsechain), now: input.now });
  const refresh = input.refreshMilliseconds ?? PRICE_REFRESH_MILLISECONDS;
  const recent = new Map<string, { readonly at: number; readonly valuation: TokenValuation }>();
  return async (token) => {
    const key = `token:${token.address.toLowerCase()}:${token.decimals}:${token.origin?.chainId ?? ""}:${token.origin?.address.toLowerCase() ?? ""}`;
    const held = recent.get(key);
    if (held !== undefined && input.now() - held.at < refresh) return held.valuation;
    const subject: PricedToken = { chainId: input.destinationChainId, address: token.address, origin: token.origin };
    const holding = await keeper.read([{ key, token: subject, decimals: token.decimals }], [input.destinationChainId]);
    const valuation = tokenValuationIn(holding, key, input.destinationChainId, token.address.toLowerCase() === input.wrappedNative.toLowerCase());
    recent.set(key, { at: input.now(), valuation });
    return valuation;
  };
}

/**
 * The PulseChain client of a pair: its PulseChain side's (chain 369), where the PulseX pools are; null for a pair without
 * one (a testnet pair, whose tokens have no market).
 *
 * @param sides The pair's sides.
 * @param clientOf The client of a side's RPC.
 */
export function pulseChainClientOf<Side extends { readonly chainId: number; readonly rpcUrl: string }>(sides: readonly Side[], clientOf: (side: Side) => PulseChainClient): PulseChainClient | null {
  const side = sides.find((candidate) => candidate.chainId === 369);
  return side === undefined ? null : clientOf(side);
}
