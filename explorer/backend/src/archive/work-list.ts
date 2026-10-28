import { z } from "zod";

/** The most items that one page of the work list holds. The chain indexer allows 500. */
export const WORK_LIST_PAGE_SIZE = 500;

/** The most pages that one read follows. It stops a runaway cursor. */
export const MAXIMUM_WORK_LIST_PAGES = 200;

/** How long one call to the chain indexer may take, in milliseconds. */
export const INDEXER_TIMEOUT_MILLISECONDS = 30_000;

const hash = z.string().regex(/^0x[0-9a-fA-F]{64}$/, "must be 32 bytes of 0x hex");

const workItemSchema = z.object({
  messageId: hash,
  sourceChainId: z.number().int(),
  destinationChainId: z.number().int(),
  sentTransactionHash: hash,
  sentLogIndex: z.number().int().nonnegative(),
  coveredByHeadSlot: z.string().regex(/^\d+$/),
});

const workPageSchema = z.object({ items: z.array(workItemSchema), nextCursor: z.string().nullable() });

const messageSchema = z.object({ status: z.string() });

/** One message that a stored head covers and that nobody has delivered. */
export type WorkItem = z.infer<typeof workItemSchema>;

/** The message statuses that end the need for evidence. */
export const FINISHED_STATUSES: readonly string[] = ["delivered", "failed_call", "release_failed"];

/** The calls that the archive makes to the chain indexer. */
export interface IndexerClient {
  /** Every message that is covered and not delivered, oldest first. @throws When the indexer fails or answers a wrong shape. */
  readWorkList(): Promise<readonly WorkItem[]>;
  /** The status of one message, or null when the indexer does not know it. @throws When the indexer fails. */
  readStatus(messageId: string): Promise<string | null>;
}

/**
 * Builds the indexer client.
 *
 * @param input.baseUrl The address of the chain indexer.
 * @param input.fetchFunction The fetch function. It is read at call time so a test can replace it.
 */
export function createIndexerClient(input: { baseUrl: string; fetchFunction: () => typeof fetch }): IndexerClient {
  const base = input.baseUrl.replace(/\/+$/, "");
  const get = (path: string) => input.fetchFunction()(`${base}${path}`, { signal: AbortSignal.timeout(INDEXER_TIMEOUT_MILLISECONDS) });
  return {
    async readWorkList() {
      const items: WorkItem[] = [];
      let cursor: string | null = null;
      for (let page = 0; page < MAXIMUM_WORK_LIST_PAGES; page += 1) {
        const query: string = `?limit=${WORK_LIST_PAGE_SIZE}${cursor === null ? "" : `&after=${encodeURIComponent(cursor)}`}`;
        const answer = await get(`/api/undelivered${query}`);
        if (!answer.ok) throw new Error(`the chain indexer answered ${answer.status} for the work list`);
        const parsed = workPageSchema.safeParse(await answer.json());
        if (!parsed.success) throw new Error("the chain indexer sent a work list in an unknown shape");
        items.push(...parsed.data.items);
        cursor = parsed.data.nextCursor;
        if (cursor === null) return items;
      }
      throw new Error("the work list has more pages than the archive follows");
    },
    async readStatus(messageId) {
      const answer = await get(`/api/messages/${messageId}`);
      if (answer.status === 404) return null;
      if (!answer.ok) throw new Error(`the chain indexer answered ${answer.status} for a message`);
      const parsed = messageSchema.safeParse(await answer.json());
      if (!parsed.success) throw new Error("the chain indexer sent a message in an unknown shape");
      return parsed.data.status;
    },
  };
}
