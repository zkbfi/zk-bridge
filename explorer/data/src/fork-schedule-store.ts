/**
 * Where a program keeps the last fork schedule it fetched from a chain's beacon node, so the fork cutover can decide from
 * it when the beacon node does not answer (`chooseSourceForks` of `@zkb/core`). Each surface brings its own place for the
 * text: `localStorage` in the dapp, a file in the terminal's config directory, memory and a file for the status service.
 * A store never throws: a place that cannot be read or written (a private window, a read-only disk) just holds no copy.
 */
import { z } from "zod";
import type { ForkScheduleCopy } from "@zkb/core";

/** The last schedule of each chain. */
export type ForkScheduleStore = {
  /** The copy saved for a chain, or null when there is none or it cannot be read. */
  load(chainId: number): Promise<ForkScheduleCopy | null>;
  /** Saves the copy of a chain. Errors are swallowed. */
  save(chainId: number, copy: ForkScheduleCopy): Promise<void>;
};

/** A place that holds text under a key: `localStorage`, a directory of files, memory. Either call may throw. */
export type ForkScheduleText = {
  read(key: string): string | null | Promise<string | null>;
  write(key: string, text: string): void | Promise<void>;
};

/** The key of a chain's copy. */
export const forkScheduleKey = (chainId: number): string => `zkb.fork-schedule.${chainId}`;

const copySchema = z.object({
  forks: z.array(z.object({ version: z.string().regex(/^0x[0-9a-f]{8}$/), epoch: z.number().int().nonnegative(), name: z.string() })),
  clock: z.object({ genesisTime: z.number().int().positive(), secondsPerSlot: z.number().int().positive(), slotsPerEpoch: z.number().int().positive() }),
  fetchedAt: z.number().int().positive(),
});

/**
 * A store over a place that holds text. A copy that does not parse counts as none.
 *
 * @param text The place.
 */
export const createForkScheduleStore = (text: ForkScheduleText): ForkScheduleStore => ({
  load: async (chainId) => {
    try {
      const raw = await text.read(forkScheduleKey(chainId));
      if (raw === null) return null;
      const parsed = copySchema.safeParse(JSON.parse(raw));
      return parsed.success ? parsed.data : null;
    } catch {
      return null;
    }
  },
  save: async (chainId, copy) => {
    try {
      await text.write(forkScheduleKey(chainId), JSON.stringify(copy));
    } catch {
      // A place that cannot be written holds no copy; the next fetch tries again.
    }
  },
});

/** A place in memory. */
export const memoryForkScheduleText = (): ForkScheduleText => {
  const entries = new Map<string, string>();
  return { read: (key) => entries.get(key) ?? null, write: (key, value) => void entries.set(key, value) };
};

/**
 * Several stores as one: a save goes to each, a load answers the newest copy of any (memory first, then a file, for a
 * service that restarts).
 *
 * @param stores The stores.
 */
export const layeredForkScheduleStore = (stores: readonly ForkScheduleStore[]): ForkScheduleStore => ({
  load: async (chainId) => {
    const copies = await Promise.all(stores.map((store) => store.load(chainId)));
    return copies.reduce<ForkScheduleCopy | null>((newest, copy) => (copy !== null && (newest === null || copy.fetchedAt > newest.fetchedAt) ? copy : newest), null);
  },
  save: async (chainId, copy) => {
    await Promise.all(stores.map((store) => store.save(chainId, copy)));
  },
});
