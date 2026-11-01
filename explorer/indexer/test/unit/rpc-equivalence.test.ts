import { Hono } from "hono";
import { beforeAll, describe, expect, it, vi } from "vitest";
import { createRpcExplorerApi, tokenListItemView, indexTokens, type TokenRow } from "@zk-bridge/shared";
import { createFakeChain } from "../../../shared/test/support/fake-chain";
import { buildScenario, type Scenario, type ScenarioEvent } from "../../../shared/test/support/scenario";
import { chainTips, releaseEvents, messages, tokens, transfers } from "../../ponder.schema";
import { registerFeedRoutes } from "../../src/api/routes/feed";
import { pair } from "../../src/lib/pair";
import { respondWith } from "./support/fake-api";
import { createFakeDatabase } from "./support/fake-database";
import { callHandler } from "./support/fake-registry";
import { createEvent } from "./support/handler-fixtures";

/**
 * The RPC data source and the indexer must give one answer for one history. This test feeds the synthetic history of
 * `explorer/shared/test/support/scenario.ts` to both: to the real handlers of the indexer, which fill a fake database,
 * and to the RPC data source, which reads a fake chain. Then it compares the JSON of the feed, of one message and of the
 * token list. The indexer side runs its own routes, so the comparison covers the whole path of each source.
 */

const scenario: Scenario = buildScenario(pair);

beforeAll(async () => {
  await import("../../src/handlers/messages");
  await import("../../src/handlers/mediator");
  await import("../../src/handlers/chain");
});

const HANDLER_PREFIX = { bridge: "MessageBridge", mediator: "TokenMediator", lightClient: "BeaconLightClient", gate: "BeaconForkGate" } as const;

/** Feeds every event of the history to the handler of the indexer, in time order, and returns the database. */
const indexHistory = async () => {
  const database = createFakeDatabase();
  for (const chainId of [1, 369]) {
    const block = scenario.head[chainId] as bigint;
    database.seed(chainTips, { chainId, blockNumber: block, timestamp: scenario.timestampOf(chainId, block), baseFeePerGas: null });
  }
  const ordered = [...scenario.events].sort((left, right) => Number(scenario.timestampOf(left.chainId, left.blockNumber) - scenario.timestampOf(right.chainId, right.blockNumber)) || scenario.events.indexOf(left) - scenario.events.indexOf(right));
  let counter = 0;
  for (const event of ordered) {
    const client = {
      readContract: vi.fn(async (call: { address: string; functionName: string; args?: readonly unknown[] }) => scenario.view(event.chainId, call as never)),
      getTransactionReceipt: vi.fn(async () => ({ logs: [] })),
    };
    const context = { chain: { id: event.chainId }, db: database.handle, client };
    queueSqlAnswer(database, event);
    counter += 1;
    await callHandler(`${HANDLER_PREFIX[event.contract]}:${event.eventName}`, {
      event: createEvent(event.args, {
        id: `event-${counter}`,
        block: { number: event.blockNumber, timestamp: scenario.timestampOf(event.chainId, event.blockNumber), baseFeePerGas: null },
        transaction: { hash: event.transactionHash, from: event.from },
        // The fake chain of the RPC side numbers the logs by their place in the scenario; the same number goes here.
        log: { address: pair.sides.find((side) => side.chainId === event.chainId)!.contracts.mediator, logIndex: scenario.events.indexOf(event) },
      }),
      context,
    });
  }
  return database;
};

/** The handlers that query the database with SQL get the rows that the real query would return. */
const queueSqlAnswer = (database: ReturnType<typeof createFakeDatabase>, event: ScenarioEvent): void => {
  const rows = database.rows(messages) as Record<string, any>[];
  if (event.eventName === "HeadUpdated") {
    const executionBlock = scenario.view(event.chainId, { address: pair.sides.find((side) => side.chainId === event.chainId)!.contracts.lightClient, functionName: "executionBlockNumber", args: [event.args.executionBlockHash] } as never) as bigint;
    database.queueSqlRows(rows.filter((row) => row.destinationChainId === event.chainId && row.coveredByHeadSlot === null && row.sentBlockNumber !== null && row.sentBlockNumber <= executionBlock).map((row) => ({ messageId: row.messageId, sourceChainId: row.sourceChainId })));
  }
};

/** The `GET /api/feed` and `GET /api/messages/:id` answers of the indexer, from its own routes over the fake database. */
const indexerApi = (database: ReturnType<typeof createFakeDatabase>) => {
  const app = new Hono();
  registerFeedRoutes(app);
  const joined = () =>
    (database.rows(messages) as Record<string, any>[])
      .filter((row) => row.sentTimestamp !== null)
      .sort((left, right) => Number(right.sentTimestamp - left.sentTimestamp) || (left.messageId < right.messageId ? 1 : -1))
      .map((row) => ({ messages: row, transfers: (database.row(transfers, { messageId: row.messageId }) as unknown) ?? null }));
  respondWith((call) => {
    if (call.table === tokens) return database.rows(tokens);
    // The message's costs read their own tables; the RPC source reads no receipts, so the comparison leaves them out.
    if (call.table !== messages) return [];
    const all = joined();
    const wanted = all.filter((row) => call.whereValues.includes(row.messages.messageId));
    return call.limit === 1 ? wanted : all.slice(0, call.limit ?? all.length);
  });
  return async (path: string) => (await app.request(path)).json() as Promise<any>;
};

const rpcApi = () =>
  createRpcExplorerApi({
    pair,
    readers: { 1: createFakeChain(scenario, 1), 369: createFakeChain(scenario, 369) },
    nowSeconds: () => 1_700_003_612,
  });

describe("one history, two data sources", () => {
  it("gives the same feed, item for item", async () => {
    const database = await indexHistory();
    const indexer = await indexerApi(database)("/api/feed?limit=50");
    const rpc = (await rpcApi().get("/api/feed?limit=50")).body as { items: unknown[]; nextCursor: string | null };
    expect(indexer.items).toHaveLength(Object.keys(scenario.ids).length);
    expect(rpc.items).toEqual(indexer.items);
    expect(rpc.nextCursor).toBe(indexer.nextCursor);
  });

  it("gives the same status for each kind of message, so the statuses are the ones that the history means", async () => {
    const database = await indexHistory();
    const feed = await indexerApi(database)("/api/feed?limit=50");
    const statusOf = (id: string) => feed.items.find((item: { messageId: string }) => item.messageId === id).status;
    expect(statusOf(scenario.ids.delivered)).toBe("delivered");
    // A delivery that fails reverts and leaves no log, so the message is not delivered: no head covers it in this scenario.
    expect(statusOf(scenario.ids.failed)).toBe("waiting_for_finality");
    expect(statusOf(scenario.ids.paid)).toBe("delivered");
    expect(statusOf(scenario.ids.stuck)).toBe("release_failed");
    expect(statusOf(scenario.ids.callbackFailed)).toBe("delivered");
    expect(statusOf(scenario.ids.covered)).toBe("covered");
    expect(statusOf(scenario.ids.waiting)).toBe("waiting_for_finality");
    expect(statusOf(scenario.ids.young)).toBe("sent");
  });

  it("gives the same detail for one message, with its call data", async () => {
    const database = await indexHistory();
    const call = indexerApi(database);
    for (const id of [scenario.ids.delivered, scenario.ids.plain, scenario.ids.stuck, scenario.ids.callbackFailed]) {
      const { costs, ...indexer } = await call(`/api/messages/${id}`);
      expect(costs).toMatchObject({ sent: null, delivered: null });
      const { coverage, ...rpc } = (await rpcApi().get(`/api/messages/${id}`)).body as Record<string, unknown>;
      expect(coverage).toMatchObject({ source: "rpc" });
      expect(rpc).toEqual(indexer);
    }
  }, 30_000);

  it("gives the same token facts", async () => {
    const database = await indexHistory();
    const rows = database.rows(tokens) as unknown as TokenRow[];
    const index = indexTokens(rows);
    const byKey = (list: { chainId: number; address: string }[]) => [...list].sort((left, right) => left.chainId - right.chainId || left.address.localeCompare(right.address));
    const indexer = byKey(rows.map((row) => tokenListItemView(row, index) as { chainId: number; address: string }));
    const rpc = ((await rpcApi().get("/api/tokens")).body as { tokens: { chainId: number; address: string }[] }).tokens;
    expect(byKey(rpc)).toEqual(indexer);
  });

  it("records the release events that the history holds, so the history is the one that the handlers saw", async () => {
    const database = await indexHistory();
    expect(database.rows(releaseEvents).map((row) => row.kind).sort()).toEqual(["callback_failed", "release_failed"]);
  });
});
