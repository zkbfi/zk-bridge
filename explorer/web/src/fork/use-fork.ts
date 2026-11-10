/**
 * The fork surfaces' reads as react-query hooks: the cutover verdict of a route (decided again at each tick of the clock,
 * so a countdown keeps moving between reads), the gate and registry of a chain, and the offer of the seal call.
 */
import { useQuery } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import type { Address } from "viem";
import { decideForkCutover, forkCutoverText, type ForkCutoverText, type ForkCutoverVerdict, type SealOffer } from "@zk-bridge/shared";
import { useServices } from "../app/services";
import type { ForkChainState } from "./fork-port";

/** How often the chains and the beacon nodes are read. */
export const FORK_REFRESH_MILLISECONDS = 60_000;
/** How often the seal call is simulated again. */
export const SEAL_REFRESH_MILLISECONDS = 300_000;

/** The clock of the page in unix seconds, read again every `tickMilliseconds`. */
export const useClockSeconds = (tickMilliseconds: number): number => {
  const { now } = useServices();
  const [seconds, setSeconds] = useState(() => now());
  useEffect(() => {
    const timer = setInterval(() => setSeconds(now()), tickMilliseconds);
    return () => clearInterval(timer);
  }, [now, tickMilliseconds]);
  return seconds;
};

/** What a surface shows for a route. */
export type ForkCutoverView = {
  readonly sourceChainId: number;
  readonly destinationChainId: number;
  readonly verdict: ForkCutoverVerdict;
  readonly text: ForkCutoverText;
  /** The time of the verdict, unix seconds. */
  readonly nowSeconds: number;
};

/**
 * The fork cutover of the route of sends from a chain. Null while nothing is read: the sample page, a chain with no route,
 * and the first read.
 *
 * @param sourceChainId The chain that sends.
 * @param tickMilliseconds How often the verdict is decided again from the last facts. Default 15 s.
 */
export const useForkCutover = (sourceChainId: number, tickMilliseconds = 15_000): ForkCutoverView | null => {
  const { forks, pair } = useServices();
  const now = useClockSeconds(tickMilliseconds);
  const facts = useQuery({ queryKey: ["fork-facts", sourceChainId], queryFn: () => forks.facts(sourceChainId), refetchInterval: FORK_REFRESH_MILLISECONDS, staleTime: FORK_REFRESH_MILLISECONDS, retry: false });
  if (facts.data === undefined || facts.data === null) return null;
  const verdict = decideForkCutover({ sourceChainId, destinationChainId: facts.data.destinationChainId, source: facts.data.source, lightClientHead: facts.data.lightClientHead, nowSeconds: now });
  const nameOf = (chainId: number): string => (pair.first.chainId === chainId ? pair.first.name : pair.second.name);
  return { sourceChainId, destinationChainId: facts.data.destinationChainId, verdict, text: forkCutoverText(verdict, { source: nameOf(sourceChainId), destination: nameOf(facts.data.destinationChainId) }, now), nowSeconds: now };
};

/** The gate and the registry of a chain. Undefined while loading. */
export const useForkChainState = (chainId: number): ForkChainState | undefined => {
  const { forks } = useServices();
  return useQuery({ queryKey: ["fork-chain", chainId], queryFn: () => forks.chainState(chainId), refetchInterval: FORK_REFRESH_MILLISECONDS, staleTime: FORK_REFRESH_MILLISECONDS, retry: false }).data;
};

/**
 * Whether `seal(evidence)` would succeed now on the gate of a chain, from the account. Undefined without an account and while
 * loading. Not asked when the gate is sealed already or when it cannot be read.
 */
export const useSealOffer = (chainId: number, account: Address | null, enabled: boolean): SealOffer | undefined => {
  const { forks } = useServices();
  return useQuery({
    queryKey: ["fork-seal", chainId, account],
    enabled: enabled && account !== null,
    queryFn: () => forks.sealOffer(chainId, account as Address),
    refetchInterval: SEAL_REFRESH_MILLISECONDS,
    staleTime: SEAL_REFRESH_MILLISECONDS,
    retry: false,
  }).data;
};
