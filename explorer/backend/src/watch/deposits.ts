/**
 * Reads what the `deposits-locked` rule of the watcher needs (`urgentReasons` in `decide.ts`): whether the bridge on the
 * destination chain of a direction has its deposits open, and whether the light client on the source chain holds a
 * head. Each answer serves {@link DEPOSITS_READ_TTL_MILLISECONDS}. A bridge opens for good and a light client never
 * loses its head, so once either answer is true it is kept and never read again.
 */
import type { DepositsFacts } from "./decide.ts";

/** How long one read of the bridge or of the remote light client serves, in milliseconds. */
export const DEPOSITS_READ_TTL_MILLISECONDS = 60_000;

/** Input of {@link createDepositsReader}. */
export type DepositsReaderInput = {
  /** `depositsOpen()` of the bridge on the destination chain of the direction. */
  readonly readOpen: () => Promise<boolean>;
  /** The head slot of the light client on the source chain (0: no head yet). */
  readonly readRemoteHeadSlot: () => Promise<number>;
  /** Milliseconds since 1970. */
  readonly now: () => number;
  /** Default: {@link DEPOSITS_READ_TTL_MILLISECONDS}. */
  readonly ttlMilliseconds?: number;
};

/** Builds the reader. A failed read throws; the watcher counts it as unknown, which holds nothing back. */
export function createDepositsReader(input: DepositsReaderInput): () => Promise<DepositsFacts> {
  const ttl = input.ttlMilliseconds ?? DEPOSITS_READ_TTL_MILLISECONDS;
  type Known = { readonly value: boolean; readonly at: number };
  let open: Known | null = null;
  let remote: Known | null = null;
  const current = (known: Known | null, now: number): known is Known => known !== null && (known.value || now - known.at < ttl);
  return async () => {
    const now = input.now();
    if (!current(open, now)) open = { value: await input.readOpen(), at: now };
    // An open bridge needs nothing more: the remote light client is not read.
    if (open.value) return { open: true, remoteHasHead: remote?.value ?? null };
    if (!current(remote, now)) remote = { value: (await input.readRemoteHeadSlot()) > 0, at: now };
    return { open: false, remoteHasHead: remote.value };
  };
}
