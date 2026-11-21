/**
 * The reads of the views, as react-query hooks. Each one polls, keeps the last good data when a poll fails, and
 * reports the error, so a view shows both.
 */
import { useQuery } from "@tanstack/react-query";
import type { Address, Hex } from "viem";
import type { DeliveryCostReport } from "@zk-bridge/shared";
import type { FeedFilter, TokenInfo } from "@terminal/model/types";
import type { RouterAddressesReading } from "@terminal/chain/live-reads";
import { withFaucetTokens } from "../faucet/faucet-model";
import { useServices } from "./services";

const NO_TOKENS: readonly TokenInfo[] = [];

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

/**
 * The balances and allowances of an account on both chains. Needs the tokens.
 *
 * @param account The account, or null.
 * @param pairId The pair.
 * @param extra Tokens to read besides the listed ones, such as the testnet faucet token, which the indexer lists only after its first bridging.
 */
export const useSnapshots = (account: Address | null, pairId: string, extra: readonly TokenInfo[] = NO_TOKENS) => {
  const { chainAccess } = useServices();
  const tokens = useTokens(pairId);
  const read = withFaucetTokens(tokens.data ?? [], extra);
  return useQuery({
    queryKey: ["snapshots", pairId, account, read.length],
    queryFn: () => chainAccess.readSnapshots({ account: account as Address, tokens: read }),
    enabled: account !== null && tokens.data !== undefined,
    refetchInterval: POLL_MILLISECONDS,
    // The RPC transport already retries; the next poll is the retry after that. Retrying here too multiplied the requests.
    retry: 0,
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

/**
 * What the router answers to `rewardAddress()` and `failedDeliveryAddress()` on the destination chain. The read never
 * throws: a failure comes back as an `unreadable` reading. It is read once, because the two addresses are immutable.
 */
export const useRouterAddresses = (chainId: number | null, router: Address | null, options: { readonly enabled: boolean }) => {
  const { chainAccess } = useServices();
  return useQuery<RouterAddressesReading>({
    queryKey: ["router-addresses", chainId, router],
    queryFn: () => chainAccess.readRouterAddresses({ chainId: chainId as number, router: router as Address }),
    enabled: options.enabled && chainId !== null && router !== null,
    staleTime: Infinity,
  });
};

/** The priority fee that a delivery on a chain pays now, in wei per gas. */
/** The max fee per gas of a chain now (the gas reserve MAX keeps for the native coin). */
export const useMaxFee = (chainId: number, options: { readonly enabled: boolean }) => {
  const { chainAccess } = useServices();
  return useQuery({
    queryKey: ["max-fee", chainId],
    queryFn: async () => (await chainAccess.flowClient(chainId).estimateFeesPerGas()).maxFeePerGas,
    enabled: options.enabled,
    refetchInterval: POLL_MILLISECONDS,
  });
};

export const usePriorityFee = (chainId: number, options: { readonly enabled: boolean }) => {
  const { chainAccess } = useServices();
  return useQuery({
    queryKey: ["priority-fee", chainId],
    queryFn: async () => (await chainAccess.flowClient(chainId).estimateFeesPerGas()).maxPriorityFeePerGas,
    enabled: options.enabled,
    refetchInterval: POLL_MILLISECONDS,
  });
};

/**
 * The tokens a wallet used or bridged with zkb.fi before, as `<side>:<address>` keys (both the token sent and its
 * counterpart on the other chain), from the indexer's feed filtered by the address: the same source as the history.
 */
export const useUsedTokens = (account: Address | null, pairId: string) => {
  const { dataSource } = useServices();
  return useQuery({
    queryKey: ["used-tokens", pairId, account],
    enabled: account !== null,
    queryFn: async (): Promise<ReadonlySet<string>> => {
      const page = await dataSource.getFeed(pairId, { address: account as Address, kind: "token" }, 200);
      const keys = new Set<string>();
      for (const item of page.items) {
        if (item.token === null) continue;
        keys.add(`${item.token.side}:${item.token.address.toLowerCase()}`);
        if (item.token.counterpart !== null) keys.add(`${item.token.side === "first" ? "second" : "first"}:${item.token.counterpart.toLowerCase()}`);
      }
      return keys;
    },
    staleTime: 60_000,
  });
};
