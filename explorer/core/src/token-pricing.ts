/**
 * The one price source of zkb.fi: the dapp, the backend's batching and the delivery runner all price a token here, from
 * PulseX pools on PulseChain (owner: "sure, but you are building in a disconnect. where are the prices coming from?").
 *
 * The maths is `pulsex-pricing.ts` (PLS/USD from the stable pools, a token from its deepest WPLS pool, an Ethereum token
 * through its Omnibridge copy, a zkb.fi copy through its origin, none on a testnet). This module adds the reads and the
 * state of each price. The reads go through the caller's client (the dapp's RPC pool, the backend's or the runner's
 * server RPC): nothing here builds a client or names an endpoint. Every read of one call is pinned to one PulseChain
 * block and every quote carries it.
 *
 * Each price is in one of four states ({@link PriceState}): `known` (read now), `stale` (the source failed now; the last
 * price, at most {@link STALE_PRICE_MAX_SECONDS} old, is used), `no-market` (the source answered, and there is no price:
 * no pool deep enough, a testnet token) or `unreachable` (the source could not be read and no recent price is held).
 */
import type { Address } from "viem";
import {
  OMNIBRIDGE_PULSECHAIN,
  PULSEX_FACTORIES,
  STABLES,
  TESTNETS,
  WETH_ETHEREUM,
  WPLS,
  plsQuoteOf,
  poolOf,
  pricingAddress,
  stablePoolEntry,
  tokenQuoteOf,
  type Pool,
  type PriceQuote,
  type PricedToken,
  type Reserves,
} from "./pulsex-pricing.js";

// ---------------------------------------------------------------------------------------------------------------------
// Reading pools
// ---------------------------------------------------------------------------------------------------------------------

/**
 * Reads PulseChain at one named block: the pair address of two tokens on a factory (null when none), its reserves, and
 * (optionally) the Omnibridge copy of an Ethereum token. `failures`, when present, counts the reads that did not get
 * through (as opposed to the chain answering "nothing there"), so a dropped request is not read as "no market".
 */
export type PoolReader = {
  readonly block: bigint;
  readonly pairOf: (factory: Address, a: Address, b: Address) => Promise<Address | null>;
  readonly reservesOf: (pair: Address) => Promise<Reserves | null>;
  readonly bridgedCopyOf?: (ethereumToken: Address) => Promise<Address | null>;
  readonly failures?: () => number;
};

/** A pool reader that can say it met a failure of the source (a dropped request) as opposed to an answer of "no pool". */
export type CountingPoolReader = PoolReader & { readonly failures?: () => number };

const lower = (address: Address): string => address.toLowerCase();

/** The pools of a token against WPLS on both factories. */
const poolsOf = async (reader: PoolReader, token: Address): Promise<Pool[]> => {
  const found = await Promise.all(
    PULSEX_FACTORIES.map(async (factory): Promise<Pool | null> => {
      const pair = await reader.pairOf(factory, token, WPLS);
      if (pair === null) return null;
      const reserves = await reader.reservesOf(pair);
      if (reserves === null) return null;
      return poolOf(pair, token, reserves);
    }),
  );
  return found.filter((pool): pool is Pool => pool !== null);
};

/**
 * PLS in dollars at the reader's block: the median of each stable pool's price, weighted by its stable side (in whole
 * dollars, at 18 decimals), or null.
 */
export const plsUsd = async (reader: PoolReader): Promise<PriceQuote | null> =>
  plsQuoteOf(
    (await Promise.all(STABLES.map(async (stable) => (await poolsOf(reader, stable.address)).map((pool) => stablePoolEntry(pool, stable.decimals))))).flat(),
    reader.block,
  );

/**
 * A PulseChain token's price: its deepest WPLS pool (ties to the lower pool address) times PLS/USD, when the WPLS side
 * is worth at least `MINIMUM_DEPTH_USD`; else null.
 *
 * @throws When the PLS quote was read at another block than the reader's.
 */
export const tokenUsd = async (reader: PoolReader, token: Address, decimals: number, pls: PriceQuote): Promise<PriceQuote | null> => {
  if (pls.block !== reader.block) throw new Error(`the PLS price is from block ${pls.block}, the reader reads block ${reader.block}`);
  if (lower(token) === lower(WPLS)) return pls;
  return tokenQuoteOf(await poolsOf(reader, token), decimals, pls, reader.block);
};

/**
 * The PulseChain token whose pools price a token, reversing an Ethereum token out through the current Omnibridge
 * (`bridgedTokenAddress` at the reader's block); the known table when the reader cannot ask or the bridge has no copy.
 */
export const resolvePricingAddress = async (token: PricedToken, reader: PoolReader): Promise<Address | null> => {
  const subject = token.origin ?? { chainId: token.chainId, address: token.address };
  if (subject.chainId === 1 && !TESTNETS.has(token.chainId)) {
    const copy = reader.bridgedCopyOf === undefined ? null : await reader.bridgedCopyOf(subject.address);
    if (copy !== null) return copy;
  }
  return pricingAddress(token);
};

/** Where a native coin's dollar price came from. */
export type NativePriceSource = "pulsex-pls-usd" | "pulsex-weth-copy";

/**
 * A native coin's dollar price at the reader's PulseChain block, with its source; null where there is no real price
 * (testnets, never invented). PLS is PLS/USD; ETH is WETH from Ethereum (its Omnibridge copy) on PulseX.
 *
 * @param reader PulseChain pools, read at one block.
 * @param chainId The chain whose coin it is.
 */
export const nativeUsd = async (reader: PoolReader, chainId: number): Promise<(PriceQuote & { readonly source: NativePriceSource }) | null> => {
  if (chainId !== 369 && chainId !== 1) return null;
  const pls = await plsUsd(reader);
  if (pls === null) return null;
  if (chainId === 369) return { ...pls, source: "pulsex-pls-usd" };
  // WETH is in the known table, so it always resolves.
  const weth = (await resolvePricingAddress({ chainId: 1, address: WETH_ETHEREUM }, reader)) as Address;
  const quote = await tokenUsd(reader, weth, 18, pls);
  return quote === null ? null : { ...quote, source: "pulsex-weth-copy" };
};

const FACTORY_ABI = [{ type: "function", name: "getPair", stateMutability: "view", inputs: [{ name: "", type: "address" }, { name: "", type: "address" }], outputs: [{ name: "", type: "address" }] }] as const;
const PAIR_ABI = [
  { type: "function", name: "getReserves", stateMutability: "view", inputs: [], outputs: [{ name: "", type: "uint112" }, { name: "", type: "uint112" }, { name: "", type: "uint32" }] },
  { type: "function", name: "token0", stateMutability: "view", inputs: [], outputs: [{ name: "", type: "address" }] },
] as const;
const OMNIBRIDGE_ABI = [{ type: "function", name: "bridgedTokenAddress", stateMutability: "view", inputs: [{ name: "", type: "address" }], outputs: [{ name: "", type: "address" }] }] as const;
const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000";

/** The one call a pool reader needs: viem's `readContract` (a public client, or Ponder's client). */
export type ContractCaller = {
  readonly readContract: (call: { readonly address: Address; readonly abi: readonly unknown[]; readonly functionName: string; readonly args?: readonly unknown[]; readonly blockNumber?: bigint }) => Promise<unknown>;
};

/** Errors that are the chain's answer (no such pair, no data), not a failure to reach it. */
const ANSWERS = new Set(["ContractFunctionRevertedError", "ContractFunctionZeroDataError", "AbiDecodingZeroDataError"]);

/** Whether an error is the chain answering "nothing there", as opposed to the request not getting through. */
export const isChainAnswer = (error: unknown): boolean => {
  for (let cause: unknown = error, depth = 0; cause instanceof Error && depth < 8; cause = (cause as { cause?: unknown }).cause, depth += 1) {
    if (ANSWERS.has(cause.name)) return true;
  }
  return false;
};

/**
 * The caller, counting the reads that failed to get through. The pool reader reads a failed call as "no pool", which
 * would pass for "no market"; the count lets the price layer tell the two apart.
 */
export const countingCaller = <Caller extends ContractCaller>(client: Caller): { readonly caller: Caller; readonly failures: () => number } => {
  let failed = 0;
  const caller: Caller = {
    ...client,
    readContract: (async (call: Parameters<ContractCaller["readContract"]>[0]) => {
      try {
        return await client.readContract(call);
      } catch (error) {
        if (!isChainAnswer(error)) failed += 1;
        throw error;
      }
    }) as ContractCaller["readContract"],
  };
  return { caller, failures: () => failed };
};

/**
 * A pool reader over a contract caller, every call pinned to `block`. A call that fails reads as no pool or no copy; a
 * failure that is not the chain's answer is counted in `failures`.
 *
 * @param client The caller (on PulseChain).
 * @param block The block to read at.
 */
export const poolReaderOver = (client: ContractCaller, block: bigint): CountingPoolReader & { readonly failures: () => number } => {
  const { caller, failures } = countingCaller(client);
  const address = async (call: Parameters<ContractCaller["readContract"]>[0]): Promise<Address | null> => {
    const result = await caller.readContract({ ...call, blockNumber: block }).catch(() => ZERO_ADDRESS);
    return typeof result !== "string" || lower(result as Address) === ZERO_ADDRESS ? null : (result as Address);
  };
  return {
    block,
    failures,
    pairOf: (factory, a, b) => address({ address: factory, abi: FACTORY_ABI, functionName: "getPair", args: [a, b] }),
    reservesOf: async (pair) => {
      try {
        const [reserves, token0] = await Promise.all([caller.readContract({ address: pair, abi: PAIR_ABI, functionName: "getReserves", blockNumber: block }), caller.readContract({ address: pair, abi: PAIR_ABI, functionName: "token0", blockNumber: block })]);
        const [reserve0, reserve1] = reserves as readonly [bigint, bigint, number];
        return { token0: token0 as Address, reserve0, reserve1 };
      } catch {
        return null;
      }
    },
    bridgedCopyOf: (token) => address({ address: OMNIBRIDGE_PULSECHAIN, abi: OMNIBRIDGE_ABI, functionName: "bridgedTokenAddress", args: [token] }),
  };
};

/** A PulseChain client as a server holds one: a contract caller that also tells the latest block. */
export type PulseChainClient = ContractCaller & { readonly getBlockNumber: () => Promise<bigint> };

/**
 * A pool reader over a PulseChain client at its latest block (the backend's and the runner's server RPC).
 *
 * @param client The client.
 * @throws When the latest block cannot be read.
 */
export const poolReaderAtLatest = async (client: PulseChainClient): Promise<CountingPoolReader> => poolReaderOver(client, await client.getBlockNumber());

// ---------------------------------------------------------------------------------------------------------------------
// The state of a price
// ---------------------------------------------------------------------------------------------------------------------

/**
 * Why a price is or is not known. `known`: read at the latest block. `stale`: the source cannot be reached now, the
 * last price read is `ageSeconds` old and no older than {@link STALE_PRICE_MAX_SECONDS}, and it is still used.
 * `no-market`: the source answered and there is no price for it (no pool deep enough, a testnet token).
 * `unreachable`: the source could not be read and there is no last price recent enough, or there is no source.
 */
export type PriceState =
  | { readonly kind: "known" }
  | { readonly kind: "stale"; readonly ageSeconds: number }
  | { readonly kind: "no-market" }
  | { readonly kind: "unreachable" };

/** The oldest last-known price that is still used when the source cannot be read: 10 minutes. */
export const STALE_PRICE_MAX_SECONDS = 600;

/** Whether a price in this state can be used: it is known, or stale within the limit. */
export const isUsablePrice = (state: PriceState): boolean => state.kind === "known" || state.kind === "stale";

/** Prices by key; null where there is none. */
export type PriceMap = ReadonlyMap<string, PriceQuote | null>;

/** {@link PriceState} by the key of a {@link PriceMap}; a key that is absent has not been read yet. */
export type PriceStates = ReadonlyMap<string, PriceState>;

/** A token to price, under a key the caller chooses, with its decimals. */
export type PriceSubject = { readonly key: string; readonly token: PricedToken; readonly decimals: number };

/** The key of a chain's native coin in a {@link PriceMap}. */
export const nativePriceKey = (chainId: number): string => `native:${chainId}`;

/** Whether a token can have a price at all: not on a testnet, and itself or its origin on Ethereum or PulseChain. */
const canHavePrice = (token: PricedToken): boolean => {
  const subject = token.origin ?? { chainId: token.chainId, address: token.address };
  return !TESTNETS.has(token.chainId) && !TESTNETS.has(subject.chainId) && (subject.chainId === 1 || subject.chainId === 369);
};

/** Whether a native coin can have a price: PLS and ETH. */
const nativeCanHavePrice = (chainId: number): boolean => chainId === 1 || chainId === 369;

/**
 * The prices of tokens and of native coins, read through one pool reader pinned to one block. A token or a coin that
 * cannot have a price (a testnet's) is null without a read, and when nothing can have a price no reader is asked for.
 * Without a PLS price there is no token price (every token is priced against PLS).
 *
 * @param subjects The tokens, each under its key.
 * @param nativeChainIds The chains whose native coin to price, under {@link nativePriceKey}.
 * @param poolReader Gives the reader, pinned to the block the quotes carry.
 * @throws When the reader met a failure of its source while reading (a pool read that failed reads as "no pool" and
 *   would pass for "no market"), or when the reader cannot be had.
 */
export const readPrices = async (subjects: readonly PriceSubject[], nativeChainIds: readonly number[], poolReader: () => Promise<CountingPoolReader>): Promise<PriceMap> => {
  const natives = [...new Set(nativeChainIds)];
  const nothing = new Map<string, PriceQuote | null>([...subjects.map((subject): [string, null] => [subject.key, null]), ...natives.map((chainId): [string, null] => [nativePriceKey(chainId), null])]);
  if (!subjects.some((subject) => canHavePrice(subject.token)) && !natives.some(nativeCanHavePrice)) return nothing;
  const reader = await poolReader();
  const pls = await plsUsd(reader);
  const entries = await Promise.all(
    subjects.map(async (subject): Promise<[string, PriceQuote | null]> => {
      if (pls === null || !canHavePrice(subject.token)) return [subject.key, null];
      const address = await resolvePricingAddress(subject.token, reader);
      return [subject.key, address === null ? null : await tokenUsd(reader, address, subject.decimals, pls)];
    }),
  );
  const coins = await Promise.all(natives.map(async (chainId): Promise<[string, PriceQuote | null]> => [nativePriceKey(chainId), await nativeUsd(reader, chainId)]));
  if ((reader.failures?.() ?? 0) > 0) throw new Error("the price source failed while reading pools");
  return new Map([...entries, ...coins]);
};

/** The prices in use and their states, with when each key last had a price (milliseconds) and the latest error. */
export type PriceHolding = {
  /** The quotes in use: the latest read, or the last good quotes that are not yet older than the limit. */
  readonly data: PriceMap | undefined;
  readonly states: PriceStates;
  readonly seenAt: ReadonlyMap<string, number>;
  readonly error: unknown;
};

/**
 * After a good read: a price is known, its absence is a missing market.
 *
 * @param data The prices read.
 * @param nowMs The clock, in milliseconds.
 */
export const holdingAfterRead = (data: PriceMap, nowMs: number): PriceHolding => {
  const states = new Map<string, PriceState>();
  const seenAt = new Map<string, number>();
  for (const [name, quote] of data) {
    states.set(name, quote === null ? { kind: "no-market" } : { kind: "known" });
    if (quote !== null) seenAt.set(name, nowMs);
  }
  return { data, states, seenAt, error: null };
};

/**
 * After a failed read: a last price up to {@link STALE_PRICE_MAX_SECONDS} old is kept as stale; a key the source said
 * has no market keeps that; every other key is unreachable.
 *
 * @param before The holding before the read, or undefined.
 * @param wanted The keys the read was for.
 * @param nowMs The clock, in milliseconds.
 * @param error Why the read failed.
 */
export const holdingAfterFailure = (before: PriceHolding | undefined, wanted: readonly string[], nowMs: number, error: unknown): PriceHolding => {
  const states = new Map<string, PriceState>();
  const quotes = new Map<string, PriceQuote | null>();
  const seenAt = new Map<string, number>();
  for (const name of wanted) {
    const at = before?.seenAt.get(name);
    const quote = before?.data?.get(name) ?? null;
    const age = at === undefined ? Number.POSITIVE_INFINITY : Math.max(0, Math.floor((nowMs - at) / 1000));
    if (quote !== null && age <= STALE_PRICE_MAX_SECONDS) {
      states.set(name, { kind: "stale", ageSeconds: age });
      quotes.set(name, quote);
      seenAt.set(name, at!);
    } else if (before?.states.get(name)?.kind === "no-market") {
      // The source answered before that there is no market; a failed read later does not change that.
      states.set(name, { kind: "no-market" });
      quotes.set(name, null);
    } else {
      states.set(name, { kind: "unreachable" });
    }
  }
  return { data: quotes.size === 0 ? undefined : quotes, states, seenAt, error };
};

/** The price among the ones asked about that a fee cannot rely on, or that is old: its key and its state. */
export type PriceProblem = { readonly key: string; readonly state: Exclude<PriceState, { kind: "known" }> };

/**
 * Which of these prices is the problem: an unreachable one first, then one with no market, then a stale one (a fee
 * can still use that); null when all are known or not yet read. Keys never read are not a problem here.
 *
 * @param states The states.
 * @param keys The prices that matter.
 */
export const priceProblemOf = (states: PriceStates, keys: readonly string[]): PriceProblem | null => {
  for (const kind of ["unreachable", "no-market", "stale"] as const) {
    for (const key of keys) {
      const state = states.get(key);
      if (state !== undefined && state.kind === kind) return { key, state };
    }
  }
  return null;
};

/** Reads prices and holds the last good ones, so a failed read falls back to them by the stale rule. */
export type PriceKeeper = {
  /**
   * Reads the prices of these tokens and coins now. Never throws: a failed read gives the stale or unreachable states.
   *
   * @returns The quotes and the states of exactly these keys.
   */
  readonly read: (subjects: readonly PriceSubject[], nativeChainIds: readonly number[]) => Promise<PriceHolding>;
};

/**
 * A price keeper for a server (the backend's batching, the delivery runner): every read goes through `poolReader`, and
 * what each key last read is remembered across reads, so the stale rule is the dapp's. No reader (no PulseChain
 * endpoint): a testnet price is still `no-market` without a read, every other is `unreachable`.
 *
 * @param input The reader factory (or null) and the clock in milliseconds.
 */
export const createPriceKeeper = (input: { readonly poolReader: (() => Promise<CountingPoolReader>) | null; readonly now: () => number }): PriceKeeper => {
  let held: PriceHolding = { data: undefined, states: new Map(), seenAt: new Map(), error: null };
  const remember = (next: PriceHolding): void => {
    held = {
      data: new Map([...(held.data ?? []), ...(next.data ?? [])]),
      states: new Map([...held.states, ...next.states]),
      seenAt: new Map([...held.seenAt, ...next.seenAt]),
      error: next.error,
    };
  };
  const unreachable = async (): Promise<CountingPoolReader> => {
    throw new Error("no PulseChain endpoint to read prices from");
  };
  return {
    read: async (subjects, nativeChainIds) => {
      const wanted = [...subjects.map((subject) => subject.key), ...[...new Set(nativeChainIds)].map(nativePriceKey)];
      let next: PriceHolding;
      try {
        next = holdingAfterRead(await readPrices(subjects, nativeChainIds, input.poolReader ?? unreachable), input.now());
      } catch (error) {
        next = holdingAfterFailure(held, wanted, input.now(), error);
      }
      remember(next);
      return next;
    },
  };
};

// ---------------------------------------------------------------------------------------------------------------------
// A token's value for a tip
// ---------------------------------------------------------------------------------------------------------------------

/** What a token is worth, for judging a tip: in USD and in the destination's native coin. */
export type TokenValuation = {
  /** The worse state of the token's price and the destination coin's price (both are needed). */
  readonly state: PriceState;
  /** USD per whole token × 1e18, or null. */
  readonly usdE18: bigint | null;
  /** USD per whole native coin of the destination × 1e18, or null. */
  readonly nativeUsdE18: bigint | null;
  /** One whole token in wei of the destination's native coin, rounded down, or null. */
  readonly weiPerToken: bigint | null;
};

const SEVERITY: Readonly<Record<PriceState["kind"], number>> = { known: 0, stale: 1, "no-market": 2, unreachable: 3 };

/** The worse of two states: unreachable, then no market, then stale (the older age), then known. */
export const worsePriceState = (left: PriceState, right: PriceState): PriceState => {
  if (left.kind === "stale" && right.kind === "stale") return left.ageSeconds >= right.ageSeconds ? left : right;
  return SEVERITY[right.kind] > SEVERITY[left.kind] ? right : left;
};

const E18 = 10n ** 18n;

/**
 * A token's valuation from its price and its destination coin's price. A token is valued only when both are usable
 * (known or stale): the dapp, the backend and the runner then agree on which tips are priced. The wrapped native coin
 * is worth exactly 1e18 wei a whole token. A state that is usable without a quote reads as no market.
 *
 * @param token The token's quote and state (an absent state: not read yet, unreachable).
 * @param native The destination coin's quote and state.
 * @param tokenIsWrappedNative Whether the token is the destination's wrapped native coin.
 */
export const tokenValuationOf = (
  token: { readonly quote: PriceQuote | null; readonly state: PriceState | undefined },
  native: { readonly quote: PriceQuote | null; readonly state: PriceState | undefined },
  tokenIsWrappedNative: boolean,
): TokenValuation => {
  const settle = (side: typeof token): PriceState => {
    const state = side.state ?? { kind: "unreachable" };
    return isUsablePrice(state) && (side.quote === null || side.quote.usdE18 <= 0n) ? { kind: "no-market" } : state;
  };
  const state = worsePriceState(settle(token), settle(native));
  if (!isUsablePrice(state)) return { state, usdE18: null, nativeUsdE18: null, weiPerToken: null };
  const usdE18 = (token.quote as PriceQuote).usdE18;
  const nativeUsdE18 = (native.quote as PriceQuote).usdE18;
  return { state, usdE18, nativeUsdE18, weiPerToken: tokenIsWrappedNative ? E18 : (usdE18 * E18) / nativeUsdE18 };
};

/**
 * A token's valuation from a holding: the token under `tokenKey`, the destination coin under its native key.
 *
 * @param holding The prices and their states.
 * @param tokenKey The token's key.
 * @param destinationChainId The destination chain.
 * @param tokenIsWrappedNative Whether the token is the destination's wrapped native coin.
 */
export const tokenValuationIn = (holding: Pick<PriceHolding, "data" | "states">, tokenKey: string, destinationChainId: number, tokenIsWrappedNative: boolean): TokenValuation => {
  const nativeKey = nativePriceKey(destinationChainId);
  return tokenValuationOf(
    { quote: holding.data?.get(tokenKey) ?? null, state: holding.states.get(tokenKey) },
    { quote: holding.data?.get(nativeKey) ?? null, state: holding.states.get(nativeKey) },
    tokenIsWrappedNative,
  );
};
