/**
 * Display helpers for the page. Amounts stay `bigint` until they become text, and the text is cut, never rounded, so a
 * shown amount never exceeds the real one.
 */
import { formatUnits } from "@terminal/format/amounts";
import { formatDuration as formatDurationText } from "@terminal/format/text";
import type { FeedStatus } from "@terminal/model/types";

export { formatAge, formatClock, formatDuration, formatTimestamp, shortenHex } from "@terminal/format/text";
export { formatUnits, parseUnits } from "@terminal/format/amounts";

/**
 * Formats an amount for a table: grouped thousands and at most six fraction digits, cut, with the symbol.
 *
 * @param amount The amount in base units.
 * @param token The decimals and the symbol of the token.
 */
export const formatAmountWithSymbol = (amount: bigint, token: { readonly decimals: number; readonly symbol: string }): string =>
  `${formatUnits(amount, token.decimals, { groupThousands: true, maximumFractionDigits: 6 })} ${token.symbol}`;

/** The words of each status, as the page shows them. */
export const STATUS_LABELS: Readonly<Record<FeedStatus, string>> = {
  sent: "Sent",
  waiting_for_finality: "Waiting for finality",
  covered: "Covered",
  delivered: "Delivered",
  release_failed: "Release failed",
};

/** What each status means, for the tooltip and the detail page. */
export const STATUS_MEANINGS: Readonly<Record<FeedStatus, string>> = {
  sent: "The send is on the source chain and is too young to be final.",
  waiting_for_finality: "The send is older than the finality window. No stored head covers it yet.",
  covered: "The destination light client stored a head at or after the send. Anyone can deliver it.",
  delivered: "The destination bridge ran the message. A delivery that fails reverts, so the message stays proven until someone delivers it again.",
  release_failed: "The mediator could not release the tokens to the recipient. This is final: the tokens stay in the mediator.",
};

/** The Chakra color palette of each status. */
export const STATUS_PALETTES: Readonly<Record<FeedStatus, string>> = {
  sent: "blue",
  waiting_for_finality: "orange",
  covered: "purple",
  delivered: "green",
  release_failed: "yellow",
};

/**
 * Formats a slot number with thousands separators.
 *
 * @param slot The slot.
 */
export const formatSlot = (slot: bigint): string => formatUnits(slot, 0, { groupThousands: true });

/**
 * The lag of a light client head as slots and time, for example `96 slots (16m 00s)`.
 *
 * @param head The head. The seconds per slot of the tracked chain turn slots into time.
 */
export const formatLag = (head: { readonly lagSlots: bigint | null; readonly secondsPerSlot: number }): string => {
  if (head.lagSlots === null) return "unknown";
  return `${formatSlot(head.lagSlots)} slots (${formatDurationText(Number(head.lagSlots) * head.secondsPerSlot)})`;
};

/** How serious a lag is, for the color: an hour is a warning, six hours is bad. */
export const lagSeverity = (head: { readonly lagSlots: bigint | null; readonly secondsPerSlot: number }): "unknown" | "good" | "warning" | "bad" => {
  if (head.lagSlots === null) return "unknown";
  const seconds = Number(head.lagSlots) * head.secondsPerSlot;
  if (seconds >= 6 * 3600) return "bad";
  if (seconds >= 3600) return "warning";
  return "good";
};
