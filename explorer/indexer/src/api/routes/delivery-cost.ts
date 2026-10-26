import { db } from "ponder:api";
import { chainTips, deliveryCosts, messages, transfers } from "ponder:schema";
import { and, desc, eq, isNotNull, ne } from "ponder";
import type { Hono } from "hono";
import { env } from "node:process";
import { buildDeliveryCostReport, classifyDelivery, parseDeliveryCostSettings, type DeliveryKind } from "@zk-bridge/shared";
import { pair } from "../../lib/pair";

/** The settings are read once. A malformed variable stops the process at start. */
const settings = parseDeliveryCostSettings(
  env,
  pair.sides.map((side) => side.chainId),
);

/**
 * The SQL condition of each kind. `classifyDelivery` states the same rules, and the route checks every row against it.
 */
const kindCondition = (kind: DeliveryKind) => {
  if (kind === "message") return ne(messages.kind, "token");
  return and(eq(messages.kind, "token"), eq(transfers.hasCallback, kind === "token_callback"));
};

/**
 * The gas used by the newest recorded deliveries of one kind on one chain. Only a delivery whose send is indexed
 * counts (`sent_timestamp` is set), because the delivery creates the `messages` row with the placeholder kind `message`.
 */
const newestSamples = async (chainId: number, kind: DeliveryKind): Promise<bigint[]> => {
  const rows = await db
    .select({
      gasUsed: deliveryCosts.gasUsed,
      messageKind: messages.kind,
      sentTimestamp: messages.sentTimestamp,
      hasCallback: transfers.hasCallback,
    })
    .from(deliveryCosts)
    .innerJoin(messages, eq(deliveryCosts.messageId, messages.messageId))
    .leftJoin(transfers, eq(deliveryCosts.messageId, transfers.messageId))
    .where(and(eq(deliveryCosts.destinationChainId, chainId), isNotNull(messages.sentTimestamp), kindCondition(kind)))
    .orderBy(desc(deliveryCosts.timestamp), desc(deliveryCosts.messageId))
    .limit(settings.sampleLimit);
  return rows
    .filter(
      (row) =>
        classifyDelivery({ messageKind: row.messageKind, sendIndexed: row.sentTimestamp !== null, hasCallback: row.hasCallback }) === kind,
    )
    .map((row) => row.gasUsed);
};

/**
 * Registers `GET /api/delivery-cost?chainId=`. The answer is the report of `@zk-bridge/shared`: measured gas by kind of
 * delivery, the latest base fee and the configured proof cost.
 *
 * @param app The Hono application.
 */
export const registerDeliveryCostRoutes = (app: Hono): void => {
  app.get("/api/delivery-cost", async (c) => {
    const text = c.req.query("chainId");
    const chainId = text !== undefined && /^\d+$/.test(text) ? Number(text) : null;
    if (chainId === null) return c.json({ error: "chainId is required and must be a whole number" }, 400);
    if (!pair.sides.some((side) => side.chainId === chainId)) return c.json({ error: `unknown chainId ${chainId}` }, 400);
    const [tokenCallback, token, message] = await Promise.all([
      newestSamples(chainId, "token_callback"),
      newestSamples(chainId, "token"),
      newestSamples(chainId, "message"),
    ]);
    const [tip] = await db.select().from(chainTips).where(eq(chainTips.chainId, chainId)).limit(1);
    return c.json(
      buildDeliveryCostReport({
        chainId,
        samples: { token_callback: tokenCallback, token, message },
        baseFee: tip ?? null,
        settings,
      }),
    );
  });
};
