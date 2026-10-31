/**
 * Delivery status of a transfer, as the screens say it: which step it has reached, where its pulse sits, the words for
 * it, and which group it belongs to (in flight, needs you, delivered). The status is the one of `@zkb/data`
 * (`MessageStatus`); the clock is the caller's.
 */
import { useMemo } from "react";
import type { MessageStatus } from "@zkb/data";

/** Which tab a transfer belongs to. */
export type ActivityGroup = "in-flight" | "needs-you" | "delivered";

/** A proven transfer still undelivered after this long needs the user. */
export const NEEDS_YOU_AFTER_SECONDS = 30 * 60;

/** The step index a status has reached (0 sent, 1 final, 2 proven, 5 delivered; a failed delivery stays at 2). */
export const stepOf = (status: MessageStatus): number =>
  status === "sent" ? 0 : status === "waiting_for_finality" ? 1 : status === "covered" ? 2 : status === "delivered" ? 5 : 2;

/** Where the pulse sits for a status, 0 to 1. */
export const positionOf = (status: MessageStatus): number =>
  status === "sent" ? 0.18 : status === "waiting_for_finality" ? 0.42 : status === "covered" ? 0.72 : status === "delivered" ? 1 : 0.72;

/** What the words and the group of a transfer read. */
export type DeliveryStatusInput = {
  readonly status: MessageStatus;
  /** Unix seconds when it was sent. */
  readonly sentAt: number;
  /** The name of the destination chain. */
  readonly destinationName: string;
  /** Unix seconds now. */
  readonly now: number;
};

/**
 * The step in words, as the card says it.
 *
 * @param input The status, when it was sent, the destination and the time now.
 */
export const stepWords = ({ status, sentAt, destinationName, now }: DeliveryStatusInput): string => {
  if (status === "sent") return "Sent · waiting for finality";
  if (status === "waiting_for_finality") return "Final soon · waiting for the proof";
  if (status === "covered") {
    const minutes = Math.max(0, Math.round((now - sentAt) / 60));
    const waited = minutes === 0 ? "" : minutes < 90 ? ` for ${minutes} min` : minutes < 48 * 60 ? ` for ${Math.round(minutes / 60)} h` : ` for ${Math.round(minutes / 1440)} days`;
    return `Proven · waiting for a deliverer${waited}`;
  }
  if (status === "delivered") return `Delivered to ${destinationName}`;
  return status === "failed_call" ? "Delivered, but the call after it failed" : "The release failed";
};

/**
 * The group of a transfer: delivered, needs you (a failure, or proven and undelivered for 30 minutes), or in flight.
 *
 * @param status The status.
 * @param sentAt Unix seconds when it was sent.
 * @param now Unix seconds now.
 */
export const groupOf = (status: MessageStatus, sentAt: number, now: number): ActivityGroup => {
  if (status === "delivered") return "delivered";
  if (status === "failed_call" || status === "release_failed") return "needs-you";
  if (status === "covered" && now - sentAt > NEEDS_YOU_AFTER_SECONDS) return "needs-you";
  return "in-flight";
};

/** What {@link useDeliveryStatus} gives. */
export type DeliveryStatusView = {
  readonly group: ActivityGroup;
  readonly step: number;
  /** The pulse's position, 0 to 1. */
  readonly position: number;
  readonly words: string;
};

/**
 * The delivery status of one transfer. The host reads the status (from the indexer, or `deriveStatus` of `@zkb/data`)
 * and passes the clock; nothing here fetches.
 *
 * @param input The status, when it was sent, the destination and the time now.
 */
export const useDeliveryStatus = (input: DeliveryStatusInput): DeliveryStatusView => {
  const { status, sentAt, destinationName, now } = input;
  return useMemo(
    () => ({ group: groupOf(status, sentAt, now), step: stepOf(status), position: positionOf(status), words: stepWords({ status, sentAt, destinationName, now }) }),
    [status, sentAt, destinationName, now],
  );
};
