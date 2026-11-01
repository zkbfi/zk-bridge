/**
 * The chain indexer reads of the progress routes: one message, the light client heads, the head updates of a chain and
 * the newest delivered messages of a direction. Every answer is kept for a few seconds, so a burst of public reads
 * never becomes a burst of indexer queries.
 */
import { z } from "zod";

/** How long one read may take, in milliseconds. */
export const INDEXER_READ_TIMEOUT_MILLISECONDS = 5_000;

/** How long an answer is kept, in milliseconds, by kind. */
export const CACHE_MILLISECONDS = { message: 5_000, heads: 10_000, headUpdates: 30_000, delivered: 60_000 } as const;

/** The most messages the cache keeps; the oldest goes first. */
export const MESSAGE_CACHE_LIMIT = 256;

/** How many head updates and delivered messages one read takes. */
export const LIST_LIMIT = 200;

const timestamped = z.object({ timestamp: z.number() }).passthrough();

/** One message as `GET /api/messages/:id` and `GET /api/feed` show it: the fields the progress reads. */
export const indexedMessageSchema = z
  .object({
    messageId: z.string(),
    status: z.string(),
    direction: z.object({ sourceChainId: z.number().int(), destinationChainId: z.number().int() }).passthrough(),
    sent: timestamped.extend({ transactionHash: z.string().nullable().optional() }).nullable(),
    covered: z.object({ headSlot: z.number().nullable(), timestamp: z.number().nullable() }).passthrough().nullable(),
    delivered: timestamped.extend({ success: z.boolean().nullable().optional(), transactionHash: z.string().nullable().optional() }).nullable(),
  })
  .passthrough();

/** One message. */
export type IndexedMessage = z.infer<typeof indexedMessageSchema>;

/** One light client as `GET /api/heads` shows it: the fields the progress reads. */
export const indexedHeadSchema = z
  .object({
    chainId: z.number().int(),
    trackedChainId: z.number().int(),
    storedHeadSlot: z.number().nullable(),
    storedHeadSlotTimestamp: z.number().nullable().optional(),
    lastUpdateTimestamp: z.number().nullable().optional(),
    finalizedSlot: z.number().nullable().optional(),
    lagSeconds: z.number().nullable().optional(),
  })
  .passthrough();

/** One light client. */
export type IndexedHead = z.infer<typeof indexedHeadSchema>;

const headsSchema = z.object({ heads: z.array(indexedHeadSchema) });

/** One head update: the slot it stored on a chain and when (seconds since 1970). */
export const headUpdateSchema = z.object({ chainId: z.number().int(), slot: z.number(), timestamp: z.number() }).passthrough();

/** One head update. */
export type HeadUpdate = z.infer<typeof headUpdateSchema>;

const headUpdatesSchema = z.object({ items: z.array(headUpdateSchema) });
const feedSchema = z.object({ items: z.array(indexedMessageSchema) });

/** The reads. Each throws when the indexer fails or answers a shape the reader does not know. */
export interface IndexerReads {
  /** The message, or null when the indexer does not know it. */
  message(messageId: string): Promise<IndexedMessage | null>;
  heads(): Promise<readonly IndexedHead[]>;
  /** The newest head updates stored on a chain, newest first. */
  headUpdates(chainId: number): Promise<readonly HeadUpdate[]>;
  /** The newest delivered messages from one chain to another, newest first. */
  delivered(sourceChainId: number, destinationChainId: number): Promise<readonly IndexedMessage[]>;
}

/** Builds the reads over the chain indexer at `baseUrl`. `fetchFunction` is read at call time. */
export function createIndexerReads(input: { baseUrl: string; now: () => number; fetchFunction?: () => typeof fetch; timeoutMilliseconds?: number }): IndexerReads {
  const base = input.baseUrl.replace(/\/+$/, "");
  const fetchFunction = input.fetchFunction ?? (() => globalThis.fetch);
  const timeout = input.timeoutMilliseconds ?? INDEXER_READ_TIMEOUT_MILLISECONDS;
  const cache = new Map<string, { at: number; answer: Promise<unknown> }>();

  async function read<Schema extends z.ZodType>(path: string, schema: Schema, what: string, allowMissing: boolean): Promise<z.infer<Schema> | null> {
    const answer = await fetchFunction()(`${base}${path}`, { signal: AbortSignal.timeout(timeout) });
    if (allowMissing && answer.status === 404) return null;
    if (!answer.ok) throw new Error(`the chain indexer answered ${answer.status} for ${what}`);
    const parsed = schema.safeParse(await answer.json());
    if (!parsed.success) throw new Error(`the chain indexer sent ${what} in an unknown shape`);
    return parsed.data;
  }

  /** One answer per key while it is fresh; a failed read is not kept. */
  function cached<Value>(key: string, keepMilliseconds: number, load: () => Promise<Value>): Promise<Value> {
    const known = cache.get(key);
    if (known !== undefined && input.now() - known.at < keepMilliseconds) return known.answer as Promise<Value>;
    const entry = { at: input.now(), answer: load() };
    cache.delete(key);
    cache.set(key, entry);
    // A failed read is not kept: the next call asks again.
    entry.answer.catch(() => cache.delete(key));
    // The map keeps its insertion order: the first key is the oldest.
    if (cache.size > MESSAGE_CACHE_LIMIT) cache.delete(cache.keys().next().value as string);
    return entry.answer;
  }

  return {
    message: (messageId) => cached(`message:${messageId}`, CACHE_MILLISECONDS.message, () => read(`/api/messages/${messageId}`, indexedMessageSchema, "a message", true)),
    heads: () => cached("heads", CACHE_MILLISECONDS.heads, async () => (await read("/api/heads", headsSchema, "the heads", false))!.heads),
    headUpdates: (chainId) =>
      cached(`head-updates:${chainId}`, CACHE_MILLISECONDS.headUpdates, async () => (await read(`/api/head-updates?chainId=${chainId}&limit=${LIST_LIMIT}`, headUpdatesSchema, "the head updates", false))!.items),
    delivered: (sourceChainId, destinationChainId) =>
      cached(`delivered:${sourceChainId}>${destinationChainId}`, CACHE_MILLISECONDS.delivered, async () => {
        const query = new URLSearchParams({ direction: `${sourceChainId}>${destinationChainId}`, status: "delivered", limit: String(LIST_LIMIT) });
        return (await read(`/api/feed?${query}`, feedSchema, "the feed", false))!.items;
      }),
  };
}
