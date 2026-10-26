/**
 * The reads of the views, as react-query hooks. Each one polls, keeps the last good data when a poll fails, and
 * reports the error, so a view shows both.
 */
import { useQuery } from "@tanstack/react-query";
import type { Address, Hex } from "viem";
import type { DeliveryCostReport } from "@zk-bridge/shared";
import type { FeedFilter } from "@terminal/model/types";
import { useServices } from "./services";

const POLL_MILLISECONDS = 15_000;

/** The health line of every pair. */
export const usePairHealth = () => {
  const { dataSource } = useServices();
  return useQuery({ queryKey: ["pairs"], queryFn: () => dataSource.listPairs(), refetchInterval: POLL_MILLISECONDS });
};

/** The summary bar. */
export const useSummary = (pairId: string) => {
  const { dataSource } = useServices();
  return useQuery({ queryKey: ["summary", pairId], queryFn: () => dataSource.getSummary(pairId), refetchInterval: POLL_MILLISECONDS });
};

/** The light client heads. */
export const useHeads = (pairId: string) => {
  const { dataSource } = useServices();
  return useQuery({ queryKey: ["heads", pairId], queryFn: () => dataSource.getHeads(pairId), refetchInterval: POLL_MILLISECONDS });
};

/** The feed under a filter. */
export const useFeed = (pairId: string, filter: FeedFilter, limit: number) => {
  const { dataSource } = useServices();
  return useQuery({
    queryKey: ["feed", pairId, filter, limit],
    queryFn: () => dataSource.getFeed(pairId, filter, limit),
    refetchInterval: POLL_MILLISECONDS,
    placeholderData: (previous) => previous,
  });
};

/** The audit rows. */
export const useAudit = (pairId: string) => {
  const { dataSource } = useServices();
  return useQuery({ queryKey: ["audit", pairId], queryFn: () => dataSource.getAudit(pairId), refetchInterval: POLL_MILLISECONDS });
};

/** The light client updates. */
export const useProver = (pairId: string) => {
  const { dataSource } = useServices();
  return useQuery({ queryKey: ["prover", pairId], queryFn: () => dataSource.getProver(pairId), refetchInterval: POLL_MILLISECONDS });
};

/** The tokens of both chains. */
export const useTokens = (pairId: string) => {
  const { dataSource } = useServices();
  return useQuery({ queryKey: ["tokens", pairId], queryFn: () => dataSource.listTokens(pairId), refetchInterval: 60_000 });
};

/** The balances, allowances, claimable amounts and fee rates of an account on both chains. Needs the tokens. */
export const useSnapshots = (account: Address | null, pairId: string) => {
  const { chainAccess } = useServices();
  const tokens = useTokens(pairId);
  return useQuery({
    queryKey: ["snapshots", pairId, account, tokens.data?.length ?? 0],
    queryFn: () => chainAccess.readSnapshots({ account: account as Address, tokens: tokens.data ?? [] }),
    enabled: account !== null && tokens.data !== undefined,
    refetchInterval: POLL_MILLISECONDS,
  });
};

/** The delivery cost report of a destination chain. It follows the indexer as it records deliveries. */
export const useDeliveryCost = (chainId: number, options: { readonly enabled: boolean }) => {
  const { dataSource } = useServices();
  return useQuery<DeliveryCostReport>({
    queryKey: ["delivery-cost", chainId],
    queryFn: () => dataSource.getDeliveryCost(chainId),
    enabled: options.enabled,
    refetchInterval: POLL_MILLISECONDS,
  });
};

/** One message by identifier. */
export const useMessage = (messageId: Hex) => {
  const { indexer } = useServices();
  return useQuery({ queryKey: ["message", messageId], queryFn: () => indexer.message(messageId), refetchInterval: POLL_MILLISECONDS });
};

/** The priority fee that a delivery on a chain pays now, in wei per gas. */
export const usePriorityFee = (chainId: number, options: { readonly enabled: boolean }) => {
  const { chainAccess } = useServices();
  return useQuery({
    queryKey: ["priority-fee", chainId],
    queryFn: async () => (await chainAccess.flowClient(chainId).estimateFeesPerGas()).maxPriorityFeePerGas,
    enabled: options.enabled,
    refetchInterval: POLL_MILLISECONDS,
  });
};
