import { z } from "zod";

const hexSchema = z.string().regex(/^0x[0-9a-fA-F]*$/);
const addressSchema = z.string().regex(/^0x[0-9a-fA-F]{40}$/);

const tokenSchema = z
  .object({ chainId: z.number().int(), address: addressSchema, symbol: z.string(), decimals: z.number().int().nonnegative() })
  .passthrough();

/** One transfer or message of the indexer feed (`explorer/indexer/README.md`, "API contract"). */
export const feedItemSchema = z
  .object({
    messageId: hexSchema,
    kind: z.enum(["token", "message"]),
    status: z.string(),
    direction: z.object({ sourceChainId: z.number().int(), destinationChainId: z.number().int() }).passthrough(),
    sender: addressSchema,
    executor: addressSchema,
    sent: z.object({ transactionHash: hexSchema, blockNumber: z.number().int(), timestamp: z.number().int() }).passthrough().nullable(),
    transfer: z
      .object({
        sourceToken: tokenSchema,
        // Null until the delivery registers the token: the indexer cannot name a copy that no message has created yet.
        destinationToken: tokenSchema.nullable(),
        recipient: addressSchema,
        value: z.string().regex(/^\d+$/),
        // True when the send locks a native token. The copy on the other chain is then the destination token.
        sourceIsNative: z.boolean().nullable().optional(),
      })
      .passthrough()
      .nullable(),
  })
  .passthrough();

/** One feed item. */
export type FeedItem = z.infer<typeof feedItemSchema>;

const feedPageSchema = z.object({ items: z.array(feedItemSchema), nextCursor: z.string().nullable() }).passthrough();
const messageSchema = feedItemSchema.and(z.object({ data: hexSchema }));

/** A feed item with the call data of its message. */
export type MessageWithData = z.infer<typeof messageSchema>;

/** The query of {@link IndexerClient.listFeed}. */
export interface FeedQuery {
  readonly sourceChainId: number;
  readonly destinationChainId: number;
  /** The statuses to list, such as `covered`. */
  readonly statuses: readonly string[];
  readonly limit: number;
  readonly cursor?: string;
}

/** The read side of the explorer indexer that the bots use. */
export interface IndexerClient {
  listFeed(query: FeedQuery): Promise<{ readonly items: readonly FeedItem[]; readonly nextCursor: string | null }>;
  getMessage(messageId: string): Promise<MessageWithData>;
}

/** The indexer answered with an error or with something that is not the documented shape. */
export class IndexerError extends Error {
  override readonly name = "IndexerError";
}

/** Input of {@link createIndexerClient}. */
export interface IndexerClientInput {
  readonly baseUrl: string;
  readonly fetch?: typeof fetch;
  readonly timeoutMilliseconds?: number;
}

/** Builds the client over `fetch`. */
export function createIndexerClient(input: IndexerClientInput): IndexerClient {
  const doFetch = input.fetch ?? fetch;
  async function get<Shape>(path: string, schema: z.ZodType<Shape>): Promise<Shape> {
    const response = await doFetch(new URL(path, input.baseUrl), { signal: AbortSignal.timeout(input.timeoutMilliseconds ?? 15_000) });
    if (!response.ok) throw new IndexerError(`the indexer answered ${response.status} for ${path.split("?")[0]}`);
    const parsed = schema.safeParse(await response.json());
    if (!parsed.success) throw new IndexerError(`the indexer answered an unexpected shape for ${path.split("?")[0]}: ${parsed.error.issues.map((issue) => issue.message).join("; ")}`);
    return parsed.data;
  }
  return {
    listFeed(query) {
      const parameters = new URLSearchParams({
        direction: `${query.sourceChainId}-${query.destinationChainId}`,
        status: query.statuses.join(","),
        limit: String(query.limit),
      });
      if (query.cursor !== undefined) parameters.set("cursor", query.cursor);
      return get(`/api/feed?${parameters.toString()}`, feedPageSchema);
    },
    getMessage(messageId) {
      return get(`/api/messages/${messageId}`, messageSchema);
    },
  };
}
