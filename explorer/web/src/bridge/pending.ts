/**
 * Transfers the user just submitted, shown on Activity as "sent" until the indexer has them. Kept in memory for the
 * visit; an entry leaves when the feed shows a transfer with the same source transaction.
 */
import { useSyncExternalStore } from "react";
import type { Hex } from "viem";
import type { Direction, TokenInfo } from "@terminal/model/types";

/** A just-submitted transfer. */
export type PendingTransfer = {
  readonly sourceTransactionHash: Hex;
  readonly direction: Direction;
  readonly token: TokenInfo;
  readonly amount: bigint;
  readonly sentAt: number;
};

let entries: readonly PendingTransfer[] = [];
const listeners = new Set<() => void>();
const emit = (): void => listeners.forEach((listener) => listener());

/** Adds a just-submitted transfer. */
export const addPending = (entry: PendingTransfer): void => {
  if (entries.some((known) => known.sourceTransactionHash === entry.sourceTransactionHash)) return;
  entries = [entry, ...entries];
  emit();
};

/** Drops the entries whose source transaction the feed now has. */
export const settlePending = (indexed: ReadonlySet<string>): void => {
  const next = entries.filter((entry) => !indexed.has(entry.sourceTransactionHash.toLowerCase()));
  if (next.length !== entries.length) {
    entries = next;
    emit();
  }
};

/** Clears every entry (tests). */
export const clearPending = (): void => {
  entries = [];
  emit();
};

/** The just-submitted transfers, kept current. */
export const usePending = (): readonly PendingTransfer[] =>
  useSyncExternalStore(
    (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    () => entries,
  );
