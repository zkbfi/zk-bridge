import { db } from "ponder:api";
import { headUpdates, messages, transactionCosts } from "ponder:schema";
import { and, eq, or, sql } from "ponder";
import type { Hono } from "hono";
import type { Hex } from "viem";
import { costView, type MessageCosts, type TransactionCostRow } from "@zk-bridge/shared";

/** One transaction by chain and hash. */
type TransactionKey = { readonly chainId: number; readonly hash: Hex };

/** The stored costs of some transactions, in one query. */
const costRowsOf = async (keys: readonly TransactionKey[]): Promise<TransactionCostRow[]> =>
  keys.length === 0
    ? []
    : ((await db
        .select()
        .from(transactionCosts)
        .where(or(...keys.map((key) => and(eq(transactionCosts.chainId, key.chainId), eq(transactionCosts.transactionHash, key.hash)))))) as TransactionCostRow[]);

const find = (rows: readonly TransactionCostRow[], key: TransactionKey | null) => (key === null ? null : (rows.find((row) => row.chainId === key.chainId && row.transactionHash === key.hash) ?? null));

/** What {@link messageCostsOf} reads of a message row. */
type MessageCostSubject = {
  readonly sourceChainId: number;
  readonly destinationChainId: number;
  readonly sentTransactionHash: Hex | null;
  readonly deliveredTransactionHash: Hex | null;
  readonly coveredByHeadSlot: bigint | null;
};

/**
 * The step costs of a message, from the same rows as `GET /api/tx`: its send, its delivery, and the light client update
 * that covered it, shared by every message that update covered.
 *
 * @param message The message row.
 */
export const messageCostsOf = async (message: MessageCostSubject): Promise<MessageCosts> => {
  const slot = message.coveredByHeadSlot;
  const [update] =
    slot === null
      ? []
      : await db
          .select({ transactionHash: headUpdates.transactionHash })
          .from(headUpdates)
          .where(and(eq(headUpdates.chainId, message.destinationChainId), eq(headUpdates.slot, slot)));
  const sent = message.sentTransactionHash === null ? null : { chainId: message.sourceChainId, hash: message.sentTransactionHash };
  const delivered = message.deliveredTransactionHash === null ? null : { chainId: message.destinationChainId, hash: message.deliveredTransactionHash };
  const proof = update === undefined ? null : { chainId: message.destinationChainId, hash: update.transactionHash as Hex };
  const rows = await costRowsOf([sent, delivered, proof].filter((key): key is TransactionKey => key !== null));
  const proofRow = find(rows, proof);
  const [covered] =
    proofRow === null
      ? []
      : await db
          .select({ count: sql<number>`count(*)::int` })
          .from(messages)
          .where(and(eq(messages.destinationChainId, message.destinationChainId), eq(messages.coveredByHeadSlot, slot as bigint)));
  return {
    sent: costView(find(rows, sent)),
    delivered: costView(find(rows, delivered)),
    proof: proofRow === null ? null : { ...costView(proofRow)!, coveredMessages: covered?.count ?? 0 },
  };
};

/**
 * Registers `GET /api/tx/:chainId/:hash`: what one stored transaction (a send, a delivery, a light client update)
 * cost, in wei and in dollars at a named-block price.
 *
 * @param app The Hono application.
 */
export const registerTransactionRoutes = (app: Hono): void => {
  app.get("/api/tx/:chainId/:hash", async (c) => {
    const chainId = Number(c.req.param("chainId"));
    const hash = c.req.param("hash").toLowerCase();
    if (!Number.isSafeInteger(chainId) || chainId <= 0) return c.json({ error: "invalid chain" }, 400);
    if (!/^0x[0-9a-f]{64}$/.test(hash)) return c.json({ error: "invalid transaction hash" }, 400);
    const [row] = await costRowsOf([{ chainId, hash: hash as Hex }]);
    return row === undefined ? c.json({ error: "unknown transaction" }, 404) : c.json(costView(row));
  });
};
