/**
 * Prices for the bridge screen, from PulseX pools on PulseChain through the user's RPC (batched into multicall reads),
 * read again about every 30 s. Display only. The hook and the sample prices live in `@zkb/react`; this module gives them
 * the dapp's RPC: the user's choice, then the configuration, then the default.
 */
import { useMemo } from "react";
import { rpcTransport } from "../app/rpc-transport";
import { createPublicClient } from "viem";
import { CLIENT_BATCH, rpcChain } from "@terminal/chain/rpc-transport";
import type { ContractCaller } from "@zk-bridge/shared";
import { PRICE_NOTE, samplePrices, usePrices as usePricesFrom, type CountingPoolReader, type PriceSource } from "@zkb/react";
import { defaultRpcUrl } from "@terminal/config/default-rpc";
import type { TokenInfo } from "@terminal/model/types";
import { useServices } from "../app/services";
import { poolReaderOver } from "./price-oracle";

export { PRICE_NOTE, samplePrices };

const PULSECHAIN = rpcChain({ id: 369, name: "PulseChain", symbol: "PLS" });

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
export const countingCaller = (client: ContractCaller): { readonly caller: ContractCaller; readonly failures: () => number } => {
  let failed = 0;
  const caller: ContractCaller = {
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

/** A pool reader over a PulseChain RPC at its latest block; reads are batched into multicall calls and all pinned there. */
export const poolReaderFor = async (rpcUrl: string): Promise<CountingPoolReader> => {
  const client = createPublicClient({ chain: PULSECHAIN, transport: rpcTransport(rpcUrl), batch: CLIENT_BATCH });
  const block = await client.getBlockNumber();
  const { caller, failures } = countingCaller(client as unknown as ContractCaller);
  return { ...poolReaderOver(caller, block), failures };
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
  const source = useMemo((): PriceSource | null => (sample ? { mode: "sample" } : live ? { mode: "live", id: rpc!, poolReader: () => poolReaderFor(rpc!) } : null), [sample, live, rpc]);
  return usePricesFrom({ tokens, pair, source });
};
