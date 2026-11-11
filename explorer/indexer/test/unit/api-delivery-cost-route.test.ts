import { Hono } from "hono";
import { beforeEach, describe, expect, it } from "vitest";
import { parseDeliveryCostReport } from "@zk-bridge/shared";
import { chainTips, deliveryCosts } from "../../ponder.schema";
import { registerDeliveryCostRoutes } from "../../src/api/routes/delivery-cost";
import { calls, respondWith, type QueryCall } from "./support/fake-api";

const app = new Hono();
registerDeliveryCostRoutes(app);

const get = async (path: string) => {
  const response = await app.request(path);
  return { status: response.status, body: (await response.json()) as Record<string, any> };
};

type Sample = { gasUsed: bigint; messageKind: string | null; sentTimestamp: bigint | null; hasCallback: boolean | null };
const sample = (gasUsed: bigint, overrides: Partial<Sample> = {}): Sample => ({
  gasUsed,
  messageKind: "token",
  sentTimestamp: 1_000n,
  hasCallback: false,
  ...overrides,
});

/** Which kind of delivery a query asks for: the kind condition puts `true` or `false` or neither into the `where` values. */
const kindOf = (call: QueryCall): "token_callback" | "token" | "message" => {
  if (call.whereValues.includes(true)) return "token_callback";
  return call.whereValues.includes(false) ? "token" : "message";
};

const serve = (samples: Partial<Record<"token_callback" | "token" | "message", Sample[]>>, tips: unknown[] = []) =>
  respondWith((call) => (call.table === chainTips ? tips : (samples[kindOf(call)] ?? [])));

beforeEach(() => serve({}));

describe("GET /api/delivery-cost", () => {
  it.each([
    ["", "chainId is required and must be a whole number"],
    ["?chainId=abc", "chainId is required and must be a whole number"],
    ["?chainId=-1", "chainId is required and must be a whole number"],
    ["?chainId=1.5", "chainId is required and must be a whole number"],
    ["?chainId=5", "unknown chainId 5"],
  ])("refuses the query %j with the message %j and runs no query", async (query, error) => {
    const { status, body } = await get(`/api/delivery-cost${query}`);
    expect(status).toBe(400);
    expect(body).toEqual({ error });
    expect(calls).toEqual([]);
  });

  it("answers a report that the shared parser accepts, with the defaults when nothing is measured", async () => {
    const { status, body } = await get("/api/delivery-cost?chainId=369");
    expect(status).toBe(200);
    const report = parseDeliveryCostReport(body);
    expect(report.chainId).toBe(369);
    expect(report.baseFee).toEqual({ wei: null, blockNumber: null, timestamp: null });
    expect(report.kinds.token).toMatchObject({ sampleCount: 0, isDefault: true, defaultGas: "600000" });
  });

  it("the delivery cost report has no proofCost field", async () => {
    const { body } = await get("/api/delivery-cost?chainId=369");
    expect(Object.keys(body).sort()).toEqual(["baseFee", "chainId", "kinds"]);
  });

  it("measures each kind from its own samples and reads the base fee from the newest tip", async () => {
    serve(
      {
        token_callback: [sample(900n, { hasCallback: true }), sample(700n, { hasCallback: true })],
        token: [sample(300n)],
        message: [sample(100n, { messageKind: "message", hasCallback: null }), sample(200n, { messageKind: "message", hasCallback: null })],
      },
      [{ chainId: 369, blockNumber: 77n, timestamp: 9_500n, baseFeePerGas: 11n }],
    );
    const { body } = await get("/api/delivery-cost?chainId=369");
    expect(body.baseFee).toEqual({ wei: "11", blockNumber: 77, timestamp: 9_500 });
    expect(body.kinds.token_callback).toMatchObject({ sampleCount: 2, averageGas: "800", p90Gas: "900", isDefault: false });
    expect(body.kinds.token).toMatchObject({ sampleCount: 1, averageGas: "300", p90Gas: "300" });
    expect(body.kinds.message).toMatchObject({ sampleCount: 2, averageGas: "150", p90Gas: "200" });
  });

  it("drops a row that the SQL kept but the rules of classifyDelivery put in another kind", async () => {
    serve({
      token: [sample(300n), sample(999n, { messageKind: "message" }), sample(998n, { sentTimestamp: null }), sample(997n, { hasCallback: null })],
    });
    const { body } = await get("/api/delivery-cost?chainId=369");
    expect(body.kinds.token).toMatchObject({ sampleCount: 1, p90Gas: "300" });
  });

  it("limits each query to the sample limit, joins the messages and the transfers, and filters by chain", async () => {
    await get("/api/delivery-cost?chainId=369");
    const sampleQueries = calls.filter((call) => call.table === deliveryCosts);
    expect(sampleQueries).toHaveLength(3);
    for (const query of sampleQueries) {
      expect(query.limit).toBe(200);
      expect(query.joins).toHaveLength(2);
      expect(query.ordered).toBe(true);
      expect(query.whereValues).toContain(369);
    }
    expect(sampleQueries.map(kindOf).sort()).toEqual(["message", "token", "token_callback"]);
    expect(calls.find((call) => call.table === chainTips)?.whereValues).toEqual([369]);
  });
});
