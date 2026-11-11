/**
 * Prices for the bridge screen, from PulseX pools on PulseChain through the user's RPC (batched into multicall reads),
 * read again about every 30 s. Display only. The hook and the sample prices live in `@zkb/react`; this module gives them
 * the dapp's RPC: the user's choice, then the configuration, then the default.
 */
import { useMemo } from "react";
import { rpcTransport } from "../app/rpc-transport";
import { createPublicClient } from "viem";
import { CLIENT_BATCH, rpcChain } from "@terminal/chain/rpc-transport";
import { countingCaller, isChainAnswer, poolReaderAtLatest, type PulseChainClient } from "@zk-bridge/shared";
import { PRICE_NOTE, samplePrices, usePrices as usePricesFrom, type CountingPoolReader, type PriceSource } from "@zkb/react";
import { defaultRpcUrl } from "@terminal/config/default-rpc";
import type { TokenInfo } from "@terminal/model/types";
import { useServices } from "../app/services";

export { PRICE_NOTE, samplePrices };

const PULSECHAIN = rpcChain({ id: 369, name: "PulseChain", symbol: "PLS" });

// Telling a chain's answer from a failed request is the one price source's (`@zkb/core`), shared with the backend and the runner.
export { countingCaller, isChainAnswer };

/**
 * A pool reader over a PulseChain RPC at its latest block; reads are batched into multicall calls and all pinned there.
 * It counts the reads that did not get through (`poolReaderAtLatest` of the one price source).
 */
export const poolReaderFor = (rpcUrl: string): Promise<CountingPoolReader> =>
  poolReaderAtLatest(createPublicClient({ chain: PULSECHAIN, transport: rpcTransport(rpcUrl), batch: CLIENT_BATCH }) as unknown as PulseChainClient);

/**
 * The dollar price of each token (key `<side>:<address>`) and of each chain's native coin (key `native:<chainId>`), or
 * null where there is none. Every quote is read at one PulseChain block and carries it.
 *
 * @param tokens The tokens to price.
 */
export const usePrices = (tokens: readonly TokenInfo[]) => {
  const { pair, configuration, connection } = useServices();
  // PulseChain always has a default RPC, so there is always one to read prices over.
  const rpc = connection?.resolved().rpcUrls[369]?.value ?? configuration.rpcUrls[369] ?? defaultRpcUrl(369)!;
  const sample = configuration.dataMode === "fixture";
  const source = useMemo((): PriceSource => (sample ? { mode: "sample" } : { mode: "live", id: rpc, poolReader: () => poolReaderFor(rpc) }), [sample, rpc]);
  return usePricesFrom({ tokens, pair, source });
};
