/**
 * Prices at a block, for display: the dollar price of tokens and of each chain's native coin from PulseX pools on
 * PulseChain. The pool reader is the host's (its RPC, its transport); nothing here builds a client or names an endpoint.
 * Every quote carries the block it was read at.
 */
import { useEffect, useRef, useState } from "react";
import type { Address } from "viem";
import { nativeSymbolOf, type PriceQuote } from "@zkb/core";
import { nativeUsd, plsUsd, resolvePricingAddress, tokenUsd, type PoolReader } from "@zkb/data";

/** A token to price: what the oracle needs to know about it. */
export type PriceableToken = {
  readonly address: Address;
  readonly symbol: string;
  readonly decimals: number;
  /** Which chain of the pair holds it. */
  readonly side: "first" | "second";
  /** The token on the other chain that it bridges to, or null. */
  readonly counterpart: Address | null;
  /** True when the bridge minted it as the copy of a native token (its symbol cannot tell: ZRX is native). */
  readonly isBridgedCopy?: boolean | undefined;
};

/** A pair, as far as prices go: the two chains. */
export type PriceablePair = {
  readonly first: { readonly chainId: number };
  readonly second: { readonly chainId: number };
};

/** Prices by key: `<side>:<address>` for a token, `native:<chainId>` for a chain's native coin; null where there is none. */
export type PriceMap = ReadonlyMap<string, PriceQuote | null>;

/** The key of a token in a {@link PriceMap}. */
export const tokenPriceKey = (token: Pick<PriceableToken, "side" | "address">): string => `${token.side}:${token.address}`;

/** The key of a chain's native coin in a {@link PriceMap}. */
export const nativePriceKey = (chainId: number): string => `native:${chainId}`;

/** The tooltip on every dollar value. */
export const PRICE_NOTE = "From PulseX pools on PulseChain, through your RPC, at one block. Display only: never used for amounts or the fee you sign; it only picks the default fee and its warnings.";

const sideChain = (pair: PriceablePair, side: PriceableToken["side"]) => (side === "first" ? pair.first : pair.second);

/** The token, as the oracle reads it: its chain, address, and origin when zkb.fi minted it. */
const subjectOf = (token: PriceableToken, pair: PriceablePair) => {
  const own = sideChain(pair, token.side);
  const other = sideChain(pair, token.side === "first" ? "second" : "first");
  const minted = token.isBridgedCopy && token.counterpart !== null;
  return { chainId: own.chainId, address: token.address, origin: minted ? { chainId: other.chainId, address: token.counterpart! } : null };
};

const E18 = 10n ** 18n;
/** Sample prices for the sample data, by symbol (a bridged copy takes its origin's), read at no real block (0). */
const SAMPLE_USD_E18: Readonly<Record<string, bigint>> = { USDC: E18, WETH: 3_000n * E18, ETH: 3_000n * E18, WPLS: 30_000_000_000_000n, PLS: 30_000_000_000_000n };

/**
 * The sample prices of the sample data: USDC $1, ETH $3,000, PLS $0.00003, at block 0. Nothing is read.
 *
 * @param tokens The tokens to price.
 * @param pair The pair, for its native coins.
 */
export const samplePrices = (tokens: readonly PriceableToken[], pair: PriceablePair): PriceMap => {
  const quote = (symbol: string): PriceQuote | null => {
    const usdE18 = SAMPLE_USD_E18[symbol];
    return usdE18 === undefined ? null : { usdE18, block: 0n, pool: null };
  };
  return new Map([
    ...tokens.map((token): [string, PriceQuote | null] => [tokenPriceKey(token), quote(nativeSymbolOf(token))]),
    ...[pair.first, pair.second].map((chain): [string, PriceQuote | null] => [nativePriceKey(chain.chainId), quote(chain.chainId === 369 ? "PLS" : chain.chainId === 1 ? "ETH" : "")]),
  ]);
};

/**
 * The prices of tokens and native coins, read through a pool reader pinned to one block. Without a PLS price there is
 * no token price (every token is priced against PLS).
 *
 * @param tokens The tokens to price.
 * @param pair The pair, for its native coins.
 * @param reader The pool reader, pinned to the block the quotes carry.
 */
export const loadPrices = async (tokens: readonly PriceableToken[], pair: PriceablePair, reader: PoolReader): Promise<PriceMap> => {
  const pls = await plsUsd(reader);
  const entries = await Promise.all(
    tokens.map(async (token): Promise<[string, PriceQuote | null]> => {
      const address = pls === null ? null : await resolvePricingAddress(subjectOf(token, pair), reader);
      return [tokenPriceKey(token), address === null || pls === null ? null : await tokenUsd(reader, address, token.decimals, pls)];
    }),
  );
  const natives = await Promise.all([pair.first.chainId, pair.second.chainId].map(async (chainId): Promise<[string, PriceQuote | null]> => [nativePriceKey(chainId), await nativeUsd(reader, chainId)]));
  return new Map([...entries, ...natives]);
};

/**
 * Where the prices come from. `sample` reads nothing. `live` calls `poolReader` for a reader pinned to the latest block
 * of PulseChain; `id` names the endpoint behind it without carrying the URL, so the prices are read again when it changes.
 */
export type PriceSource =
  | { readonly mode: "sample" }
  | { readonly mode: "live"; readonly id: string; readonly poolReader: () => Promise<PoolReader> };

/** Options of {@link usePrices}. */
export type UsePricesOptions = {
  readonly tokens: readonly PriceableToken[];
  readonly pair: PriceablePair;
  /** The source, or null while there is none (no endpoint): no price is read. */
  readonly source: PriceSource | null;
  /** How often the prices are read again; default 30 s. */
  readonly refreshMilliseconds?: number;
};

/** What {@link usePrices} gives. */
export type PricesState = {
  /** The latest good prices; kept when a later read fails. Undefined before the first read, and for another source or token list. */
  readonly data: PriceMap | undefined;
  /** The error of the latest read, or null. */
  readonly error: unknown;
  readonly isError: boolean;
  /** True while a read is out, so a host can show or count the requests in flight. */
  readonly isFetching: boolean;
};

/** The default time between two reads, in milliseconds. */
export const PRICE_REFRESH_MILLISECONDS = 30_000;

/**
 * The prices of the tokens and of each chain's native coin, read now and again every 30 s while mounted. Display only.
 *
 * @param options The tokens, the pair and the source.
 */
export const usePrices = ({ tokens, pair, source, refreshMilliseconds = PRICE_REFRESH_MILLISECONDS }: UsePricesOptions): PricesState => {
  const key = source === null || tokens.length === 0 ? null : [source.mode === "sample" ? "sample" : source.id, pair.first.chainId, pair.second.chainId, tokens.map(tokenPriceKey).join(",")].join("|");
  const [state, setState] = useState<{ readonly key: string | null; readonly data: PriceMap | undefined; readonly error: unknown }>({ key, data: undefined, error: null });
  const [fetching, setFetching] = useState(false);
  const latest = useRef({ tokens, pair, source });
  latest.current = { tokens, pair, source };
  useEffect(() => {
    if (key === null) return;
    let stopped = false;
    const read = async (): Promise<void> => {
      const { tokens: wanted, pair: chains, source: from } = latest.current;
      setFetching(true);
      try {
        const data = from!.mode === "sample" ? samplePrices(wanted, chains) : await loadPrices(wanted, chains, await from!.poolReader());
        if (stopped) return;
        setState({ key, data, error: null });
      } catch (error) {
        if (stopped) return;
        setState((before) => ({ key, data: before.key === key ? before.data : undefined, error }));
      } finally {
        if (!stopped) setFetching(false);
      }
    };
    void read();
    const timer = setInterval(() => void read(), refreshMilliseconds);
    return () => {
      stopped = true;
      clearInterval(timer);
      setFetching(false);
    };
  }, [key, refreshMilliseconds]);
  const current = key !== null && state.key === key;
  return { data: current ? state.data : undefined, error: current ? state.error : null, isError: current && state.error !== null, isFetching: key !== null && fetching };
};
