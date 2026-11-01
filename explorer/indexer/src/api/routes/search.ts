import { db } from "ponder:api";
import { headUpdates, messages, tokens, transfers } from "ponder:schema";
import { eq, or, sql } from "ponder";
import type { Hono } from "hono";
import {
  MAXIMUM_QUERY_LENGTH,
  ZKB_SITES,
  classifyQuery,
  resolve,
  searchChainsFromPair,
  type SearchHeadUpdate,
  type SearchMessage,
  type SearchSites,
  type SearchSources,
  type SearchToken,
} from "@zk-bridge/shared";
import { pair } from "../../lib/pair";

const MAXIMUM_LIMIT = 50;

/** The hosts that results link to: the public ones of zkb.fi, or the ones that the deployment names. */
const sitesFromEnvironment = (): SearchSites => ({
  dapp: process.env.EXPLORER_SITE_DAPP ?? ZKB_SITES.dapp,
  indexer: process.env.EXPLORER_SITE_INDEXER ?? ZKB_SITES.indexer,
  status: process.env.EXPLORER_SITE_STATUS ?? ZKB_SITES.status,
  backend: process.env.EXPLORER_SITE_BACKEND ?? ZKB_SITES.backend,
  gateway: process.env.EXPLORER_SITE_GATEWAY ?? ZKB_SITES.gateway,
});

type MessageRow = typeof messages.$inferSelect;
type TransferRow = typeof transfers.$inferSelect;

const symbolsOf = async (): Promise<Map<string, string>> => {
  const rows = await db.select().from(tokens);
  return new Map(rows.flatMap((row) => (row.symbol === null ? [] : [[`${row.chainId}:${row.address.toLowerCase()}`, row.symbol] as const])));
};

const messageOf = (row: MessageRow, transfer: TransferRow | null, symbols: ReadonlyMap<string, string>): SearchMessage => ({
  messageId: row.messageId,
  kind: row.kind === "token" ? "token" : "message",
  status: row.status,
  sourceChainId: row.sourceChainId,
  destinationChainId: row.destinationChainId,
  sentTransactionHash: row.sentTransactionHash,
  deliveredTransactionHash: row.deliveredTransactionHash,
  symbol: transfer?.sourceToken == null ? null : (symbols.get(`${row.sourceChainId}:${transfer.sourceToken.toLowerCase()}`) ?? null),
});

const headUpdateOf = (row: { readonly chainId: number; readonly slot: bigint; readonly transactionHash: string }): SearchHeadUpdate => ({
  chainId: row.chainId,
  slot: row.slot.toString(),
  transactionHash: row.transactionHash,
});

/** The readers of the resolver over this indexer's own tables. */
const readers = (): NonNullable<SearchSources["indexer"]> => {
  const byCondition = async (condition: ReturnType<typeof eq>): Promise<SearchMessage | null> => {
    const [row] = await db.select().from(messages).leftJoin(transfers, eq(messages.messageId, transfers.messageId)).where(condition).limit(1);
    return row === undefined ? null : messageOf(row.messages, row.transfers, await symbolsOf());
  };
  return {
    message: (messageId) => byCondition(sql`${messages.messageId} = ${messageId}`),
    messageByTransaction: (hash) => byCondition(or(sql`${messages.sentTransactionHash} = ${hash}`, sql`${messages.deliveredTransactionHash} = ${hash}`) as ReturnType<typeof eq>),
    headUpdateByTransaction: async (hash) => {
      const [row] = await db.select().from(headUpdates).where(sql`${headUpdates.transactionHash} = ${hash}`).limit(1);
      return row === undefined ? null : headUpdateOf(row);
    },
    headUpdatesBySlot: async (slot) => (await db.select().from(headUpdates).where(eq(headUpdates.slot, BigInt(slot))).limit(5)).map(headUpdateOf),
    tokens: async (): Promise<SearchToken[]> =>
      (await db.select().from(tokens)).flatMap((row) => (row.symbol === null ? [] : [{ chainId: row.chainId, address: row.address.toLowerCase(), symbol: row.symbol, name: row.name }])),
    messagesByPrefix: async (prefix) => {
      const rows = await db.select().from(messages).leftJoin(transfers, eq(messages.messageId, transfers.messageId)).where(sql`${messages.messageId} like ${`${prefix}%`}`).limit(5);
      const symbols = await symbolsOf();
      return rows.map((row) => messageOf(row.messages, row.transfers, symbols));
    },
    transferCount: async (address) => {
      const [row] = await db
        .select({ count: sql<number>`count(*)::int` })
        .from(transfers)
        .where(or(eq(transfers.sender, address as `0x${string}`), eq(transfers.recipient, address as `0x${string}`), eq(transfers.paidTo, address as `0x${string}`)));
      return row?.count ?? 0;
    },
  };
};

/**
 * Registers `GET /api/search?q=&limit=`: the cross-referenced search of zkb.fi, run over this indexer's own tables. It
 * answers what the text is (`candidates`), the typed `results` with their links to the dapp, this indexer's page, the
 * status page, the backend and the block explorers, and the `problems` of a reader that failed. It reads no chain and
 * no other service, so it is fast and always answers.
 *
 * @param app The Hono application.
 */
export const registerSearchRoute = (app: Hono): void => {
  app.get("/api/search", async (c) => {
    const text = c.req.query("q");
    if (text === undefined) return c.json({ error: "missing q" }, 400);
    if (text.length > MAXIMUM_QUERY_LENGTH) return c.json({ error: `q is longer than ${MAXIMUM_QUERY_LENGTH} characters` }, 400);
    const limitText = c.req.query("limit");
    const limit = Number(limitText);
    if (limitText !== undefined && !(Number.isInteger(limit) && limit >= 1 && limit <= MAXIMUM_LIMIT)) return c.json({ error: `limit must be 1 to ${MAXIMUM_LIMIT}` }, 400);
    // Nothing to read for a text the search does not know.
    const known = classifyQuery(text).candidates.length > 0;
    const sources: SearchSources = { sites: sitesFromEnvironment(), chains: searchChainsFromPair(pair), ...(known ? { indexer: readers() } : {}) };
    return c.json(await resolve(text, sources, limitText === undefined ? {} : { limit }));
  });
};

