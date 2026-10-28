import { Hono } from "hono";
import { beforeEach, describe, expect, it } from "vitest";
import { messages } from "../../ponder.schema";
import { registerUndeliveredRoute } from "../../src/api/routes/undelivered";
import { calls, respondWith } from "./support/fake-api";
import { hashOf, sentMessageRow } from "./support/handler-fixtures";

const app = new Hono();
registerUndeliveredRoute(app);

const get = async (path: string) => {
  const response = await app.request(path);
  return { status: response.status, body: (await response.json()) as Record<string, any> };
};

/** A covered message, as the indexer stores it after a head covered the send. */
const coveredRow = (id: string, sentTimestamp: bigint, overrides: Record<string, unknown> = {}) => ({
  ...sentMessageRow(hashOf(id), 100n),
  sentTimestamp,
  sentTransactionHash: hashOf("e1"),
  sentLogIndex: 4,
  gasLimit: 250_000,
  status: "covered",
  coveredByHeadSlot: 9_000_000n,
  ...overrides,
});

const serve = (rows: unknown[]) => respondWith(() => rows);

beforeEach(() => serve([]));

describe("GET /api/undelivered", () => {
  it("lists covered messages oldest first and leaves out delivered ones", async () => {
    serve([coveredRow("01", 1_000n), coveredRow("02", 2_000n)]);
    const { status, body } = await get("/api/undelivered");
    expect(status).toBe(200);
    expect(body.items).toEqual([
      {
        messageId: hashOf("01"),
        sourceChainId: 1,
        destinationChainId: 369,
        sentTransactionHash: hashOf("e1"),
        sentLogIndex: 4,
        gasLimit: 250_000,
        coveredByHeadSlot: "9000000",
      },
      expect.objectContaining({ messageId: hashOf("02") }),
    ]);
    const query = calls.find((call) => call.table === messages);
    // The query asks for the status `covered` only, so a delivered message never reaches the list.
    expect(query?.whereValues).toEqual(["covered"]);
    expect(query?.ordered).toBe(true);
  });

  it("sends the direction and the position to the query", async () => {
    await get(`/api/undelivered?direction=1>369&after=1500:${hashOf("0a")}&limit=7`);
    const query = calls.find((call) => call.table === messages);
    expect(query?.whereValues).toEqual(["covered", 1, 369, 1_500n, 1_500n, hashOf("0a")]);
    expect(query?.limit).toBe(8);
  });

  it("pages with after and returns nextCursor only when more rows exist", async () => {
    serve([coveredRow("01", 1_000n), coveredRow("02", 2_000n), coveredRow("03", 3_000n)]);
    const full = await get("/api/undelivered?limit=2");
    expect(full.body.items).toHaveLength(2);
    expect(full.body.nextCursor).toBe(`2000:${hashOf("02")}`);
    serve([coveredRow("01", 1_000n), coveredRow("02", 2_000n)]);
    const last = await get("/api/undelivered?limit=2");
    expect(last.body.items).toHaveLength(2);
    expect(last.body.nextCursor).toBeNull();
  });

  it("leaves out a covered row that lacks a send fact instead of handing out a half empty item", async () => {
    serve([coveredRow("01", 1_000n, { sentLogIndex: null }), coveredRow("02", 2_000n)]);
    const { body } = await get("/api/undelivered");
    expect(body.items.map((item: { messageId: string }) => item.messageId)).toEqual([hashOf("02")]);
  });

  it("refuses a limit of 501 with 400", async () => {
    const { status, body } = await get("/api/undelivered?limit=501");
    expect(status).toBe(400);
    expect(body).toEqual({ error: "invalid limit: 501" });
    expect(calls).toEqual([]);
  });

  it("refuses a limit that is not a number", async () => {
    expect((await get("/api/undelivered?limit=many")).body).toEqual({ error: "invalid limit: many" });
  });

  it("refuses a limit of 0, a bad direction and a bad after position", async () => {
    expect((await get("/api/undelivered?limit=0")).status).toBe(400);
    expect((await get("/api/undelivered?direction=one")).body).toEqual({ error: "invalid direction: one" });
    expect((await get("/api/undelivered?after=nope")).body).toEqual({ error: "invalid after: nope" });
  });
});
