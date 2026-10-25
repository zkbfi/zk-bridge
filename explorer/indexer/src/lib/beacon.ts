/** A function with the signature of `fetch`. */
export type Fetcher = (url: string, init?: { signal?: AbortSignal }) => Promise<{ ok: boolean; json: () => Promise<unknown> }>;

/**
 * Reads the slot of the finalized header from a beacon node (`/eth/v1/beacon/headers/finalized`).
 *
 * @param beaconUrl The base URL of the beacon node.
 * @param fetcher The fetch function. Default: the global `fetch`.
 * @param timeoutMilliseconds How long to wait. Default: 3000.
 * @returns The slot, or null when the node does not answer with a slot.
 */
export const fetchFinalizedSlot = async (
  beaconUrl: string,
  fetcher: Fetcher = fetch as unknown as Fetcher,
  timeoutMilliseconds = 3000,
): Promise<number | null> => {
  try {
    const response = await fetcher(`${beaconUrl.replace(/\/$/, "")}/eth/v1/beacon/headers/finalized`, {
      signal: AbortSignal.timeout(timeoutMilliseconds),
    });
    if (!response.ok) return null;
    const body = (await response.json()) as { data?: { header?: { message?: { slot?: string } } } };
    const slot = body.data?.header?.message?.slot;
    return slot !== undefined && /^\d+$/.test(slot) ? Number(slot) : null;
  } catch {
    return null;
  }
};

/** A small cache that holds one value per key for a short time. */
export type TimedCache<value> = {
  readonly get: (key: string, load: () => Promise<value>) => Promise<value>;
};

/**
 * Makes a cache whose entries expire after a fixed time.
 *
 * @param lifetimeMilliseconds How long an entry stays.
 * @param now The clock. Default: `Date.now`.
 */
export const createTimedCache = <value>(lifetimeMilliseconds: number, now: () => number = Date.now): TimedCache<value> => {
  const entries = new Map<string, { readonly expiresAt: number; readonly value: value }>();
  return {
    get: async (key, load) => {
      const entry = entries.get(key);
      if (entry !== undefined && entry.expiresAt > now()) return entry.value;
      const loaded = await load();
      entries.set(key, { expiresAt: now() + lifetimeMilliseconds, value: loaded });
      return loaded;
    },
  };
};
