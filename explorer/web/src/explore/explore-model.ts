/**
 * Pure helpers of Explore: one-word statuses, the four numbers, the light-client cards and durations. A value the
 * indexer does not give stays null, and the page shows "—".
 */
import type { FeedItem, LightClientHead, PairConfig } from "@terminal/model/types";

/** A status in one word, for the pill at the right of a row (owner: "delivered, waiting, proving, mining, etc."). */
export const statusWord = (status: FeedItem["status"]): string =>
  ({ sent: "sent", waiting_for_finality: "waiting", covered: "proven", delivered: "delivered", failed_call: "failed", release_failed: "failed" })[status];

/** A duration as short text: "48 s", "14 min", "26 h", "3 d". */
export const durationText = (seconds: number): string => {
  if (seconds < 60) return `${Math.max(0, Math.round(seconds))} s`;
  if (seconds < 3600) return `${Math.round(seconds / 60)} min`;
  if (seconds < 172_800) return `${Math.round(seconds / 3600)} h`;
  return `${Math.round(seconds / 86_400)} d`;
};

/** The median of numbers, or null for none. */
export const median = (values: readonly number[]): number | null => {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? sorted[middle]! : (sorted[middle - 1]! + sorted[middle]!) / 2;
};

/** The four numbers at the top of Explore, from the feed. Null where the data does not say. */
export const exploreNumbers = (feed: readonly FeedItem[], now: number): { readonly transfers24h: number; readonly medianSeconds: number | null; readonly inFlight: number } => ({
  transfers24h: feed.filter((item) => item.sentAt >= now - 86_400).length,
  medianSeconds: median(feed.filter((item) => item.deliveredAt !== null).map((item) => item.deliveredAt! - item.sentAt)),
  inFlight: feed.filter((item) => item.status !== "delivered" && item.status !== "failed_call" && item.status !== "release_failed").length,
});

/** A light-client card: which chain checks which, how far behind it is, and how far it has verified. */
export type LightClientCard = {
  readonly holderChainId: number;
  readonly trackedChainId: number;
  readonly title: string;
  /** "26 h behind", "current", or "lag unknown". */
  readonly lagText: string;
  readonly behind: boolean;
  /** 0..1, how lit the bar is (1 = current). */
  readonly fill: number;
  readonly verifiedSlot: bigint | null;
  readonly lastUpdateAt: number | null;
};

/**
 * The light-client cards of a pair, from the indexer's heads.
 *
 * @param heads The heads.
 * @param pair The pair.
 */
export const lightClientCards = (heads: readonly LightClientHead[], pair: PairConfig): readonly LightClientCard[] =>
  heads.map((head) => {
    const holder = head.side === "first" ? pair.first : pair.second;
    const tracked = head.side === "first" ? pair.second : pair.first;
    const lagSeconds = head.lagSlots === null ? null : Number(head.lagSlots) * head.secondsPerSlot;
    const behind = lagSeconds !== null && lagSeconds > 3600;
    return {
      holderChainId: holder.chainId,
      trackedChainId: tracked.chainId,
      title: `${holder.name} checks ${tracked.name}`,
      lagText: lagSeconds === null ? "lag unknown" : lagSeconds <= 120 ? "current" : `${durationText(lagSeconds)} behind`,
      behind,
      fill: lagSeconds === null ? 0 : Math.max(0.04, 1 - Math.min(1, lagSeconds / 86_400)),
      verifiedSlot: head.storedHeadSlot,
      lastUpdateAt: head.lastUpdateAt,
    };
  });
