/**
 * The Activity screen's model: what each of the wallet's transfers is doing, where it is on its steps, how long is left,
 * and whether it needs the user (proven but not delivered after a while).
 */
import { NEEDS_YOU_AFTER_SECONDS, groupOf as groupOfStatus, positionOf, stepOf, stepWords as stepWordsOf, type ActivityGroup } from "@zkb/react";
import type { ChainConfig, FeedItem, PairConfig } from "@terminal/model/types";
import { chainsFor, transferSteps } from "./bridge-model";
import type { Step } from "./StepList";

/** Block explorers of the chains zkb.fi serves. */
const EXPLORERS: Readonly<Record<number, string>> = {
  1: "https://etherscan.io/tx/",
  11155111: "https://sepolia.etherscan.io/tx/",
  369: "https://scan.pulsechain.com/tx/",
  943: "https://scan.v4.testnet.pulsechain.com/tx/",
};

/** A transaction's page on its chain's explorer, or undefined for a chain without one. */
export const txUrl = (chainId: number, hash: string | null): string | undefined => (hash === null || EXPLORERS[chainId] === undefined ? undefined : `${EXPLORERS[chainId]}${hash}`);

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

/** Seconds left for a transfer in flight, from the step estimates, at least 0. */
export const secondsLeft = (item: FeedItem, pair: PairConfig, now: number): number => {
  const { source, destination } = chainsFor(pair, item.direction);
  const total = transferSteps(source, destination).reduce((sum, step) => sum + step.seconds, 0);
  return Math.max(0, total - (now - item.sentAt));
};

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
