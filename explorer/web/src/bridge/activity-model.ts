/**
 * The Activity screen's model: what each of the wallet's transfers is doing, where it is on its steps, how long is left,
 * and whether it needs the user (proven but not delivered after a while).
 */
import { NEEDS_YOU_AFTER_SECONDS, groupOf as groupOfStatus, positionOf, stepOf, stepWords as stepWordsOf, type ActivityGroup } from "@zkb/react";
import type { ChainConfig, FeedItem, PairConfig } from "@terminal/model/types";
import { chainsFor, transferSteps } from "./bridge-model";
import type { Step } from "./StepList";
import { nativeSymbolOf } from "@zk-bridge/shared";
import { explorerLinks } from "@terminal/config/chain-metadata";
import { feeSummaryText } from "../data/fee-summary";
import { deliveryOutcome, type DeliveryOutcome } from "../explore/delivery-outcome";

/**
 * A transaction's page on its chain's main explorer, or undefined for a chain without one. The links come from the one
 * explorer table (`chain-metadata`), which knows that the PulseChain scans route by hash (`/#/tx/...`).
 */
export const txUrl = (chainId: number, hash: string | null): string | undefined => (hash === null ? undefined : explorerLinks(chainId, "tx", hash)[0]?.url);

/** A proven transfer still undelivered after this long needs the user. */
export { NEEDS_YOU_AFTER_SECONDS };
export type { ActivityGroup };

/** The step index a status has reached (0 sent, 1 final, 2 proven, 3 checked, 4 delivered). The rule lives in `@zkb/react`. */
export { stepOf, positionOf };

/** The step in words, as the card says it. */
export const stepWords = (item: FeedItem, destination: ChainConfig, now: number): string => stepWordsOf({ status: item.status, sentAt: item.sentAt, destinationName: destination.name, now });

/**
 * The group of a transfer: delivered, needs you (a failure, or proven and undelivered for 30 minutes), or in flight.
 *
 * @param item The transfer.
 * @param now Unix seconds now.
 */
export const groupOf = (item: FeedItem, now: number): ActivityGroup => groupOfStatus(item.status, item.sentAt, now);

/** "~6 min", "~40 s", "any moment". */
export const leftText = (seconds: number): string => (seconds <= 0 ? "any moment" : seconds < 60 ? `~${seconds} s` : `~${Math.round(seconds / 60)} min`);

const clock = (unix: number): string => new Date(unix * 1000).toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit", second: "2-digit" });

/**
 * The joined step list of a transfer: lit up to where it is; reached steps carry their time and, where known, a link to
 * the transaction on the chain's explorer; steps ahead carry an estimate and no link.
 *
 * @param item The transfer.
 * @param pair Its pair.
 */
export const stepsOf = (item: FeedItem, pair: PairConfig): { readonly steps: readonly Step[]; readonly current: number } => {
  const { source, destination } = chainsFor(pair, item.direction);
  const plan = transferSteps(source, destination);
  const current = stepOf(item.status);
  const steps: Step[] = plan.map((step, index) => {
    const at = index === 0 ? clock(item.sentAt) : index === plan.length - 1 && item.deliveredAt !== null ? clock(item.deliveredAt) : "";
    const href = index === 0 ? txUrl(source.chainId, item.sourceTransactionHash) : index === plan.length - 1 ? txUrl(destination.chainId, item.destinationTransactionHash) : undefined;
    return { label: step.label, at, estimate: step.estimate, ...(href === undefined ? {} : { href }) };
  });
  return { steps, current: Math.min(current, steps.length) };
};

/** "2 h ago", "yesterday", or the date. */
export const relativeTime = (unix: number, now: number): string => {
  const seconds = now - unix;
  if (seconds < 60) return "just now";
  if (seconds < 3600) return `${Math.round(seconds / 60)} min ago`;
  if (seconds < 86_400) return `${Math.round(seconds / 3600)} h ago`;
  if (seconds < 2 * 86_400) return "yesterday";
  return new Date(unix * 1000).toLocaleDateString();
};

/** The day heading a delivered transfer sits under. */
export const dayOf = (unix: number, now: number): string => {
  const days = Math.floor(now / 86_400) - Math.floor(unix / 86_400);
  return days === 0 ? "Today" : days === 1 ? "Yesterday" : new Date(unix * 1000).toLocaleDateString(undefined, { weekday: "long", month: "short", day: "numeric" });
};

/**
 * The delivery fee of a delivered transfer in one line ("12.3 tTKN sent · 0.0123 tTKN fee (0.1%) · 12.2877 tTKN
 * received"), or null when no delivery router delivered it, or the indexer has not read its fee.
 *
 * @param item The transfer.
 */
export const feeLineOf = (item: FeedItem): string | null => {
  const delivery = item.delivery ?? null;
  if (delivery === null || delivery.fee === null || item.token === null || item.amount === null) return null;
  const token = delivery.token ?? item.token;
  return feeSummaryText({
    sent: item.amount,
    sentDecimals: item.token.decimals,
    sentSymbol: nativeSymbolOf(item.token),
    fee: delivery.fee,
    received: delivery.received,
    decimals: token.decimals,
    symbol: nativeSymbolOf(token),
  });
};

/**
 * What a delivered transfer really did when the router did not pay the recipient as asked: the tokens are in the router
 * (its callback failed), the router handed them to its failed delivery address, or the call after the payout failed. Null
 * for an ordinary delivery. The row does not read the router, so the failed delivery address is not named here; the
 * message page names it.
 *
 * @param item The transfer.
 * @param destination The destination chain.
 */
export const outcomeOfItem = (item: FeedItem, destination: ChainConfig): DeliveryOutcome | null => {
  if (item.deliveredAt === null || item.status === "release_failed") return null;
  const delivery = item.delivery ?? null;
  return deliveryOutcome(
    {
      callbackFailed: item.callbackFailed === true,
      viaRouter: delivery !== null,
      handOffReason: delivery?.handOffReason ?? null,
      handOffRefused: delivery?.handOffRefused === true,
      callFailed: delivery?.callFailed ?? null,
    },
    { destination: destination.name, failedDelivery: null, amountText: null, recipient: null },
  );
};
