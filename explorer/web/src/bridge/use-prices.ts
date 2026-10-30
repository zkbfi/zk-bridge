/**
 * Prices for the bridge screen, from PulseX pools on PulseChain through the user's RPC (batched into multicall reads),
 * cached about 30 s. Display only.
 */
import { useQuery } from "@tanstack/react-query";
import { createPublicClient, defineChain, http, parseAbi, type Address } from "viem";
import { defaultRpcUrl } from "@terminal/config/default-rpc";
import type { PairConfig, TokenInfo } from "@terminal/model/types";
import { useServices } from "../app/services";
import { plsUsd, pricingAddress, tokenUsd, WPLS, type PoolReader } from "./price-oracle";

const PULSECHAIN = defineChain({
  id: 369,
  name: "PulseChain",
  nativeCurrency: { name: "Pulse", symbol: "PLS", decimals: 18 },
  rpcUrls: { default: { http: [] } },
  contracts: { multicall3: { address: "0xcA11bde05977b3631167028862bE2a173976CA11" } },
});

const FACTORY = parseAbi(["function getPair(address, address) view returns (address)"]);
const PAIR = parseAbi(["function getReserves() view returns (uint112, uint112, uint32)", "function token0() view returns (address)"]);
const ZERO = "0x0000000000000000000000000000000000000000";

/** A pool reader over a PulseChain RPC; reads are batched into multicall calls. */
export const poolReaderFor = (rpcUrl: string): PoolReader => {
  const client = createPublicClient({ chain: PULSECHAIN, transport: http(rpcUrl), batch: { multicall: true } });
  return {
    pairOf: async (factory, a, b) => {
      const pair = await client.readContract({ address: factory, abi: FACTORY, functionName: "getPair", args: [a, b] }).catch(() => ZERO);
      return pair === ZERO ? null : (pair as Address);
    },
    reservesOf: async (pair) => {
      try {
        const [[reserve0, reserve1], token0] = await Promise.all([
          client.readContract({ address: pair, abi: PAIR, functionName: "getReserves" }),
          client.readContract({ address: pair, abi: PAIR, functionName: "token0" }),
        ]);
        return { token0, reserve0, reserve1 };
      } catch {
        return null;
      }
    },
  };
};

const sideChain = (pair: PairConfig, side: TokenInfo["side"]) => (side === "first" ? pair.first : pair.second);

/** The PulseChain token whose pools price a token of the pair (a zkb token by its origin). */
export const pricingOf = (token: TokenInfo, pair: PairConfig): Address | null => {
  const own = sideChain(pair, token.side);
  const other = sideChain(pair, token.side === "first" ? "second" : "first");
  const minted = /^zkb/i.test(token.symbol) && token.counterpart !== null;
  return pricingAddress({ chainId: own.chainId, address: token.address, origin: minted ? { chainId: other.chainId, address: token.counterpart! } : null });
};

/** The PulseChain token that prices a chain's native coin: WPLS on PulseChain, WETH's copy for Ethereum. */
const nativePricingOf = (chainId: number): Address | null =>
  chainId === 369 ? WPLS : pricingAddress({ chainId, address: "0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2" });

/**
 * The dollar price of each token (key `<side>:<address>`) and of each chain's native coin (key `native:<chainId>`), or
 * null where there is none.
 *
 * @param tokens The tokens to price.
 */
export const usePrices = (tokens: readonly TokenInfo[]) => {
  const { pair, configuration, connection } = useServices();
  const rpc = connection?.resolved().rpcUrls[369]?.value ?? configuration.rpcUrls[369] ?? defaultRpcUrl(369);
  const live = configuration.dataMode === "live" && rpc !== null;
  return useQuery({
    queryKey: ["prices", rpc, tokens.map((token) => `${token.side}:${token.address}`).join(",")],
    enabled: live && tokens.length > 0,
    staleTime: 30_000,
    refetchInterval: 30_000,
    queryFn: async (): Promise<ReadonlyMap<string, number | null>> => {
      const reader = poolReaderFor(rpc!);
      const pls = await plsUsd(reader);
      const entries = await Promise.all(
        tokens.map(async (token): Promise<[string, number | null]> => {
          const address = pricingOf(token, pair);
          const decimals = token.decimals;
          return [`${token.side}:${token.address}`, address === null || pls === null ? null : await tokenUsd(reader, address, decimals, pls)];
        }),
      );
      const natives = await Promise.all(
        [pair.first.chainId, pair.second.chainId].map(async (chainId): Promise<[string, number | null]> => {
          const address = nativePricingOf(chainId);
          return [`native:${chainId}`, address === null || pls === null ? null : await tokenUsd(reader, address, 18, pls)];
        }),
      );
      return new Map([...entries, ...natives]);
    },
  });
};

/** The tooltip on every dollar value. */
export const PRICE_NOTE = "From PulseX pools on PulseChain, through your RPC. Display only: never used for amounts, tips or fees.";
