/**
 * Prices for the bridge screen, from PulseX pools on PulseChain through the user's RPC (batched into multicall reads),
 * cached about 30 s. Display only.
 */
import { useQuery } from "@tanstack/react-query";
import { rpcTransport } from "../app/rpc-transport";
import { createPublicClient, defineChain } from "viem";
import type { ContractCaller } from "@zk-bridge/shared";
import { defaultRpcUrl } from "@terminal/config/default-rpc";
import type { PairConfig, TokenInfo } from "@terminal/model/types";
import { useServices } from "../app/services";
import { nativeUsd, plsUsd, poolReaderOver, resolvePricingAddress, tokenUsd, type PoolReader, type PriceQuote } from "./price-oracle";

const PULSECHAIN = defineChain({
  id: 369,
  name: "PulseChain",
  nativeCurrency: { name: "Pulse", symbol: "PLS", decimals: 18 },
  rpcUrls: { default: { http: [] } },
  contracts: { multicall3: { address: "0xcA11bde05977b3631167028862bE2a173976CA11" } },
});

/** A pool reader over a PulseChain RPC at its latest block; reads are batched into multicall calls and all pinned there. */
export const poolReaderFor = async (rpcUrl: string): Promise<PoolReader> => {
  const client = createPublicClient({ chain: PULSECHAIN, transport: rpcTransport(rpcUrl), batch: { multicall: true } });
  const block = await client.getBlockNumber();
  return poolReaderOver(client as unknown as ContractCaller, block);
};

const sideChain = (pair: PairConfig, side: TokenInfo["side"]) => (side === "first" ? pair.first : pair.second);

/** The token, as the oracle reads it: its chain, address, and origin when zkb.fi minted it. */
const subjectOf = (token: TokenInfo, pair: PairConfig) => {
  const own = sideChain(pair, token.side);
  const other = sideChain(pair, token.side === "first" ? "second" : "first");
  const minted = /^zkb/i.test(token.symbol) && token.counterpart !== null;
  return { chainId: own.chainId, address: token.address, origin: minted ? { chainId: other.chainId, address: token.counterpart! } : null };
};


const E18 = 10n ** 18n;
/** Sample prices for the sample data, by symbol (a zkb copy takes its origin's), read at no real block (0). */
const SAMPLE_USD_E18: Readonly<Record<string, bigint>> = { USDC: E18, WETH: 3_000n * E18, ETH: 3_000n * E18, WPLS: 30_000_000_000_000n, PLS: 30_000_000_000_000n };

/**
 * The sample prices of the sample data: USDC $1, ETH $3,000, PLS $0.00003, at block 0. Nothing is read.
 *
 * @param tokens The tokens to price.
 * @param pair The pair, for its native coins.
 */
export const samplePrices = (tokens: readonly TokenInfo[], pair: PairConfig): ReadonlyMap<string, PriceQuote | null> => {
  const quote = (symbol: string): PriceQuote | null => {
    const usdE18 = SAMPLE_USD_E18[symbol.replace(/^zkb/i, "")];
    return usdE18 === undefined ? null : { usdE18, block: 0n, pool: null };
  };
  return new Map([
    ...tokens.map((token): [string, PriceQuote | null] => [`${token.side}:${token.address}`, quote(token.symbol)]),
    ...[pair.first, pair.second].map((chain): [string, PriceQuote | null] => [`native:${chain.chainId}`, quote(chain.chainId === 369 ? "PLS" : chain.chainId === 1 ? "ETH" : "")]),
  ]);
};

/**
 * The dollar price of each token (key `<side>:<address>`) and of each chain's native coin (key `native:<chainId>`), or
 * null where there is none. Every quote is read at one PulseChain block and carries it.
 *
 * @param tokens The tokens to price.
 */
export const usePrices = (tokens: readonly TokenInfo[]) => {
  const { pair, configuration, connection } = useServices();
  const rpc = connection?.resolved().rpcUrls[369]?.value ?? configuration.rpcUrls[369] ?? defaultRpcUrl(369);
  const live = configuration.dataMode === "live" && rpc !== null;
  const sample = configuration.dataMode === "fixture";
  return useQuery({
    queryKey: ["prices", sample ? "sample" : rpc, tokens.map((token) => `${token.side}:${token.address}`).join(",")],
    enabled: (live || sample) && tokens.length > 0,
    staleTime: 30_000,
    refetchInterval: 30_000,
    queryFn: async (): Promise<ReadonlyMap<string, PriceQuote | null>> => {
      if (sample) return samplePrices(tokens, pair);
      const reader = await poolReaderFor(rpc!);
      const pls = await plsUsd(reader);
      const entries = await Promise.all(
        tokens.map(async (token): Promise<[string, PriceQuote | null]> => {
          const address = pls === null ? null : await resolvePricingAddress(subjectOf(token, pair), reader);
          return [`${token.side}:${token.address}`, address === null || pls === null ? null : await tokenUsd(reader, address, token.decimals, pls)];
        }),
      );
      const natives = await Promise.all([pair.first.chainId, pair.second.chainId].map(async (chainId): Promise<[string, PriceQuote | null]> => [`native:${chainId}`, await nativeUsd(reader, chainId)]));
      return new Map([...entries, ...natives]);
    },
  });
};

/** The tooltip on every dollar value. */
export const PRICE_NOTE = "From PulseX pools on PulseChain, through your RPC, at one block. Display only: never used for amounts or the fee you sign; it only picks the default fee and its warnings.";
