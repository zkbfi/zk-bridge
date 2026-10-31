/**
 * The calls to the indexer that the terminal data source does not make: one message by identifier, and a lookup of a message by transaction hash. The lookup uses the GraphQL route that Ponder serves, so the
 * indexer needs no new route. Every call may reject; the views show the error and keep the last good data.
 */
import type { Hex } from "viem";
import { costViewSchema, type CostView } from "@zk-bridge/shared";
import { IndexerResponseError, readArray, readRecord } from "./json";
import { parseMessageDetail, type MessageDetail } from "./message-detail";

/** What the page asks of the indexer besides the data source. */
export interface IndexerClient {
  /** One message, or null when the indexer does not know the identifier. */
  message(messageId: Hex): Promise<MessageDetail | null>;
  /** The identifier of the message whose send or delivery has this transaction hash, or null. */
  findMessageByTransaction(transactionHash: Hex): Promise<Hex | null>;
  /** What one stored transaction cost (`GET /api/tx/:chainId/:hash`), or null when the indexer does not store it. */
  transactionCost(chainId: number, transactionHash: Hex): Promise<CostView | null>;
}

/**
 * Reads an answer of `GET /api/tx/:chainId/:hash`.
 *
 * @throws IndexerResponseError when it has the wrong shape.
 */
export const parseTransactionCost = (value: unknown): CostView => {
  const parsed = costViewSchema.safeParse(value);
  if (!parsed.success) throw new IndexerResponseError("The transaction cost has an unknown shape.");
  return parsed.data;
};

/** Gets JSON. A test passes a fake. A 404 answer resolves to `notFound`. */
export type JsonRequester = (url: string, init?: { readonly body?: string }) => Promise<unknown | typeof NOT_FOUND>;

/** The marker that a requester returns for status 404. */
export const NOT_FOUND = Symbol("not found");

const defaultRequester: JsonRequester = async (url, init) => {
  const response = await fetch(url, {
    signal: AbortSignal.timeout(10_000),
    ...(init?.body === undefined ? {} : { method: "POST", headers: { "content-type": "application/json" }, body: init.body }),
  });
  if (response.status === 404) return NOT_FOUND;
  if (!response.ok) throw new IndexerResponseError(`The indexer answered ${response.status} for ${new URL(url).pathname}.`);
  return response.json();
};

/** Input of {@link createIndexerClient}. */
export type IndexerClientInput = {
  /** The base URL of the indexer. */
  readonly baseUrl: string;
  /** Replaces `fetch`. */
  readonly request?: JsonRequester;
};

/** The GraphQL document that finds a message by either transaction hash. */
export const transactionLookupQuery = (transactionHash: Hex): string =>
  `{ messagess(where: { OR: [{ sentTransactionHash: "${transactionHash.toLowerCase()}" }, { deliveredTransactionHash: "${transactionHash.toLowerCase()}" }] }, limit: 1) { items { messageId } } }`;

/**
 * Creates the client.
 *
 * @param input The base URL of the indexer.
 */
export const createIndexerClient = (input: IndexerClientInput): IndexerClient => {
  const base = input.baseUrl.replace(/\/$/, "");
  const request = input.request ?? defaultRequester;
  return {
    async message(messageId) {
      const answer = await request(`${base}/api/messages/${messageId.toLowerCase()}`);
      return answer === NOT_FOUND ? null : parseMessageDetail(answer);
    },
    async findMessageByTransaction(transactionHash) {
      const answer = await request(`${base}/graphql`, { body: JSON.stringify({ query: transactionLookupQuery(transactionHash) }) });
      if (answer === NOT_FOUND) return null;
      const items = readArray(readRecord(readRecord(readRecord(answer, "graphql answer").data, "graphql data").messagess, "messagess").items, "items");
      const first = items[0];
      return first === undefined ? null : (readRecord(first, "item").messageId as Hex);
    },
    async transactionCost(chainId, transactionHash) {
      const answer = await request(`${base}/api/tx/${chainId}/${transactionHash.toLowerCase()}`);
      return answer === NOT_FOUND ? null : parseTransactionCost(answer);
    },
  };
};

/** The part of the connection runtime that the fallback client needs. */
export type FallbackConnectionPort = {
  /** The newest connection. The runtime rebuilds it when the settings change, so read it at each call. */
  readonly connection: () => {
    readonly baseUrl: string;
    readonly request: (url: string) => Promise<{ readonly status: number; readonly body: unknown }>;
    readonly run: <value>(operations: { readonly viaIndexer: () => Promise<value>; readonly viaRpc: () => Promise<value> }) => Promise<value>;
    readonly rpc: { readonly findMessageByTransaction: (transactionHash: Hex) => Promise<Hex | null> };
  };
};

/**
 * Creates a client that falls back to the RPC source. A message read goes through the connection, which answers from
 * the indexer or from the chains. A lookup by transaction hash tries the GraphQL route first, then the chains.
 *
 * @param runtime The connection runtime.
 */
export const createFallbackIndexerClient = (runtime: FallbackConnectionPort): IndexerClient => ({
  async message(messageId) {
    const connection = runtime.connection();
    const path = `/api/messages/${messageId.toLowerCase()}`;
    const response = await connection.request(`${connection.baseUrl}${path}`);
    if (response.status === 404) return null;
    if (response.status !== 200) throw new IndexerResponseError(`The indexer answered ${response.status} for ${path}.`);
    return parseMessageDetail(response.body);
  },
  findMessageByTransaction(transactionHash) {
    const connection = runtime.connection();
    return connection.run({
      viaIndexer: () => createIndexerClient({ baseUrl: connection.baseUrl }).findMessageByTransaction(transactionHash),
      viaRpc: () => connection.rpc.findMessageByTransaction(transactionHash),
    });
  },
  async transactionCost(chainId, transactionHash) {
    // Only the indexer stores costs; the RPC source reads no receipts.
    const connection = runtime.connection();
    const path = `/api/tx/${chainId}/${transactionHash.toLowerCase()}`;
    const response = await connection.request(`${connection.baseUrl}${path}`);
    if (response.status === 404) return null;
    if (response.status !== 200) throw new IndexerResponseError(`The indexer answered ${response.status} for ${path}.`);
    return parseTransactionCost(response.body);
  },
});
