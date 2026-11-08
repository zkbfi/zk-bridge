import { describe, expect, it } from "vitest";
import { BILLING_TTL_MILLISECONDS, BILLING_URL, GRAPHQL_URL, billingEndpoints, bucketRows, createBillingReader, figuresOf, parseBalance, parseBillingRows, runpodEndpointId, type BillingSnapshot } from "../src/billing.ts";
import { READ_SECRETS, makeConfig } from "./support.ts";

const KEY = "fake-runpod-key-for-tests-0001";
const NOW = Date.parse("2026-11-07T12:30:00Z");

/** The shape RunPod answers today for bucketSize=day (a bare array). */
const DAY_ROWS = [
  { time: "2026-11-05 00:00:00", amount: 1.8, timeBilledMs: 7_200_000, diskSpaceBilledGB: 2320 },
  { time: "2026-11-06 00:00:00", amount: 1.3131631457808908, timeBilledMs: 6_252_072, diskSpaceBilledGB: 2320 },
  { time: "2026-11-07 00:00:00", amount: 0.5, timeBilledMs: 1_800_000, diskSpaceBilledGB: 100 },
];
const HOUR_ROWS = [
  { time: "2026-11-06 10:00:00", amount: 9, timeBilledMs: 3_600_000 }, // ended before the 24 h window
  { time: "2026-11-06 13:00:00", amount: 0.25, timeBilledMs: 900_000 }, // ends 14:00, inside
  { time: "2026-11-07 11:00:00", amount: 0.1, timeBilledMs: 300_000 },
];
const BALANCE = { data: { myself: { clientBalance: 153.38, currentSpendPerHr: 0, spendLimit: 80 } } };

type Call = { url: string; method: string; authorization: string | null; body: string | null };

/** A fetch that answers by URL and records the calls. A value of Error makes that route fail. */
function fakeRunpod(answers: { day?: unknown; hour?: unknown; balance?: unknown } = {}) {
  const state = { day: answers.day ?? DAY_ROWS, hour: answers.hour ?? HOUR_ROWS, balance: answers.balance ?? BALANCE, status: 200 };
  const calls: Call[] = [];
  const fetchFunction = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    const headers = new Headers(init?.headers);
    calls.push({ url, method: init?.method ?? "GET", authorization: headers.get("authorization"), body: typeof init?.body === "string" ? init.body : null });
    const value = url.startsWith(GRAPHQL_URL) ? state.balance : url.includes("bucketSize=hour") ? state.hour : state.day;
    if (value instanceof Error) throw value;
    return new Response(JSON.stringify(value), { status: state.status, headers: { "content-type": "application/json" } });
  }) as typeof fetch;
  return { state, calls, fetchFunction: () => fetchFunction };
}

function reader(runpod = fakeRunpod(), clock = { now: NOW }, endpoints = [{ id: "abc123", apiKey: KEY }]) {
  const lines: string[] = [];
  const logger = { debug() {}, info() {}, warn: (event: string, fields?: unknown) => void lines.push(`${event} ${JSON.stringify(fields)}`), error() {} };
  return { runpod, clock, lines, reader: createBillingReader({ endpoints, now: () => clock.now, logger, fetchFunction: runpod.fetchFunction }) };
}

describe("parsing the RunPod answers", () => {
  it("reads a bare array and a `data` wrapper alike", () => {
    expect(parseBillingRows(DAY_ROWS)).toEqual(parseBillingRows({ data: DAY_ROWS }));
    expect(parseBillingRows(DAY_ROWS)[1]).toEqual({ time: "2026-11-06 00:00:00", amountUsd: 1.3131631457808908, billedSeconds: 6252.072 });
  });

  it("skips rows without a time, treats missing numbers as 0 and refuses another shape", () => {
    expect(parseBillingRows([{ amount: 1 }, null, "x", { time: "2026-11-06 00:00:00" }])).toEqual([{ time: "2026-11-06 00:00:00", amountUsd: 0, billedSeconds: 0 }]);
    expect(() => parseBillingRows({ error: "nope" })).toThrow(/not a list/);
    expect(() => parseBillingRows("x")).toThrow();
  });

  it("sums rows into days and hours", () => {
    const rows = parseBillingRows([...DAY_ROWS, { time: "2026-11-06 00:00:00", amount: 1, timeBilledMs: 3_600_000 }]);
    expect(bucketRows(rows, 10).map((bucket) => [bucket.start, bucket.amountUsd.toFixed(3), bucket.billedSeconds])).toEqual([
      ["2026-11-05", "1.800", 7200],
      ["2026-11-06", "2.313", 9852.072],
      ["2026-11-07", "0.500", 1800],
    ]);
    expect(bucketRows(parseBillingRows(HOUR_ROWS), 13)[1]?.start).toBe("2026-11-06T13");
  });

  it("orders buckets by time whatever the order of the rows", () => {
    expect(bucketRows(parseBillingRows([...DAY_ROWS].reverse()), 10).map((bucket) => bucket.start)).toEqual(["2026-11-05", "2026-11-06", "2026-11-07"]);
  });

  it("reads the balance and refuses an answer without one", () => {
    expect(parseBalance(BALANCE)).toEqual({ balanceUsd: 153.38, currentSpendPerHr: 0, spendLimit: 80 });
    expect(() => parseBalance({ errors: [{ message: "x" }] })).toThrow(/clientBalance/);
  });

  it("finds the endpoint identifier in both RunPod address shapes", () => {
    expect(runpodEndpointId("https://abc123.api.runpod.ai")).toBe("abc123");
    expect(runpodEndpointId("https://api.runpod.ai/v2/xyz789/runsync")).toBe("xyz789");
    expect(runpodEndpointId("https://prover.example.org")).toBeNull();
    expect(runpodEndpointId("not a url")).toBeNull();
    expect(runpodEndpointId("https://a-b.api.runpod.ai")).toBeNull();
    expect(runpodEndpointId("https://api.runpod.ai/v3/xyz789")).toBeNull();
  });

  it("builds the endpoints to read from the configuration: RunPod addresses with a key only", () => {
    const config = makeConfig({
      remote: { endpoints: [{ label: "dedicated", url: "https://gpu.example.org", apiKeyVariable: "RUNPOD_API_KEY" }, { label: "serverless", url: "https://abc123.api.runpod.ai", apiKeyVariable: "RUNPOD_API_KEY" }] },
      runpodApiKeyVariable: undefined,
    });
    expect(billingEndpoints(config, READ_SECRETS)).toEqual([{ id: "abc123", apiKey: READ_SECRETS.proverKeys[0]?.value }]);
    expect(billingEndpoints(makeConfig(), READ_SECRETS)).toEqual([]);
  });
});

describe("the reader", () => {
  it("asks RunPod per day and per hour for each endpoint and for the balance, with the key only in the Authorization header", async () => {
    const { reader: billing, runpod } = reader();
    const snapshot = await billing.read();
    const urls = runpod.calls.map((call) => call.url);
    expect(urls.filter((url) => url.startsWith(BILLING_URL) && url.includes("bucketSize=day") && url.includes("endpointId=abc123"))).toHaveLength(1);
    expect(urls.filter((url) => url.startsWith(BILLING_URL) && url.includes("bucketSize=hour") && url.includes("endpointId=abc123"))).toHaveLength(1);
    const graph = runpod.calls.find((call) => call.url === GRAPHQL_URL);
    expect(graph?.method).toBe("POST");
    expect(graph?.body).toContain("clientBalance");
    for (const call of runpod.calls) {
      expect(call.authorization).toBe(`Bearer ${KEY}`);
      expect(call.url + (call.body ?? "")).not.toContain(KEY);
    }
    expect(snapshot.spend?.days.map((day) => day.start)).toEqual(["2026-11-05", "2026-11-06", "2026-11-07"]);
    expect(snapshot.balance).toMatchObject({ balanceUsd: 153.38, spendLimit: 80, readAt: NOW });
  });

  it("sums the buckets of several endpoints", async () => {
    const { reader: billing } = reader(fakeRunpod(), { now: NOW }, [{ id: "a", apiKey: KEY }, { id: "b", apiKey: KEY }]);
    const snapshot = await billing.read();
    expect(snapshot.spend?.days[1]).toMatchObject({ start: "2026-11-06", amountUsd: 2 * 1.3131631457808908 });
  });

  it("serves the cache for ten minutes, then reads again", async () => {
    const { reader: billing, runpod, clock } = reader();
    await billing.read();
    const first = runpod.calls.length;
    expect(first).toBe(3);
    clock.now += BILLING_TTL_MILLISECONDS - 1;
    await billing.read();
    expect(runpod.calls.length).toBe(first);
    clock.now += 1;
    await billing.read();
    expect(runpod.calls.length).toBe(first * 2);
  });

  it("makes one read for page views that arrive together", async () => {
    const { reader: billing, runpod } = reader();
    await Promise.all([billing.read(), billing.read(), billing.read()]);
    expect(runpod.calls.length).toBe(3);
  });

  it("keeps the last good value after a failure, says how old it is, and retries after a minute", async () => {
    const { reader: billing, runpod, clock, lines } = reader();
    await billing.read();
    runpod.state.day = new Error("network down");
    runpod.state.balance = new Error("network down");
    clock.now += BILLING_TTL_MILLISECONDS;
    const stale = await billing.read();
    expect(stale.spend?.readAt).toBe(NOW);
    expect(stale.balance?.readAt).toBe(NOW);
    expect(figuresOf(stale, clock.now)).toMatchObject({ available: true, ageSeconds: 600, balanceAgeSeconds: 600, balanceUsd: 153.38 });
    expect(lines.join("\n")).toContain("billing_spend_unreadable");
    expect(lines.join("\n")).not.toContain(KEY);
    const calls = runpod.calls.length;
    clock.now += 30_000;
    await billing.read();
    expect(runpod.calls.length).toBe(calls);
    runpod.state.day = DAY_ROWS;
    runpod.state.balance = BALANCE;
    clock.now += 30_000;
    expect((await billing.read()).spend?.readAt).toBe(clock.now);
  });

  it("keeps the balance when only the billing fails, and the billing when only the balance fails", async () => {
    const { reader: billing, runpod, clock } = reader(fakeRunpod({ hour: new Error("x") }));
    const first = await billing.read();
    expect(first.spend).toBeNull();
    expect(first.balance?.balanceUsd).toBe(153.38);
    runpod.state.hour = HOUR_ROWS;
    runpod.state.balance = { data: { myself: {} } };
    clock.now += 60_000;
    const second = await billing.read();
    expect(second.spend).not.toBeNull();
    expect(second.balance?.readAt).toBe(NOW);
  });

  it("treats a RunPod error status and a bad body as a failure", async () => {
    const runpod = fakeRunpod();
    runpod.state.status = 401;
    const { reader: billing } = reader(runpod);
    expect(await billing.read()).toEqual({ spend: null, balance: null });
    const bad = reader(fakeRunpod({ day: { oops: true } }));
    expect((await bad.reader.read()).spend).toBeNull();
  });

  it("reads nothing without an endpoint", async () => {
    const { reader: billing, runpod } = reader(fakeRunpod(), { now: NOW }, []);
    expect(await billing.read()).toEqual({ spend: null, balance: null });
    expect(runpod.calls).toEqual([]);
  });

  it("times out a slow answer", async () => {
    const slow = (async (_url: string | URL | Request, init?: RequestInit) =>
      new Promise<Response>((_resolve, reject) => init?.signal?.addEventListener("abort", () => reject(new DOMException("timed out", "TimeoutError"))))) as typeof fetch;
    const lines: string[] = [];
    const logger = { debug() {}, info() {}, warn: (event: string, fields?: unknown) => void lines.push(`${event} ${JSON.stringify(fields)}`), error() {} };
    const billing = createBillingReader({ endpoints: [{ id: "abc123", apiKey: KEY }], now: () => NOW, fetchFunction: () => slow, timeoutMilliseconds: 20, logger });
    expect(await billing.read()).toEqual({ spend: null, balance: null });
    expect(lines.join("\n")).toContain("TimeoutError");
  });
});

describe("the figures", () => {
  const snapshot = async (): Promise<BillingSnapshot> => reader().reader.read();

  it("sums the hours that end inside the last 24 h, and derives the effective rate from amount over billed hours", async () => {
    const figures = figuresOf(await snapshot(), NOW);
    expect(figures.last24hUsd).toBeCloseTo(0.35, 6);
    expect(figures.last24hBilledSeconds).toBe(1200);
    // 7-day window: (1.8 + 1.3131631457808908 + 0.5) USD over (7200 + 6252.072 + 1800) s.
    expect(figures.effectiveUsdPerHour).toBeCloseTo(3.6131631457808908 / (15_252.072 / 3600), 3);
    expect(figures.ageSeconds).toBe(0);
  });

  it("averages the 7 full days before today and divides the balance by it", async () => {
    const figures = figuresOf(await snapshot(), NOW);
    expect(figures.averageDailyUsd7d).toBeCloseTo((1.8 + 1.3131631457808908) / 7, 4);
    expect(figures.balanceDaysLeft).toBeCloseTo(153.38 / ((1.8 + 1.3131631457808908) / 7), 0);
    expect(figures.currentSpendPerHr).toBe(0);
  });

  it("has no days left without spend, and no figures without a reading", () => {
    const empty = figuresOf({ spend: { days: [], hours: [], readAt: NOW }, balance: { balanceUsd: 10, currentSpendPerHr: 0, spendLimit: 80, readAt: NOW } }, NOW);
    expect(empty).toMatchObject({ available: true, effectiveUsdPerHour: null, averageDailyUsd7d: 0, balanceDaysLeft: null, last24hUsd: 0 });
    expect(figuresOf({ spend: null, balance: null }, NOW)).toMatchObject({ available: false, ageSeconds: null, last24hUsd: null, effectiveUsdPerHour: null, balanceUsd: null, balanceDaysLeft: null });
  });
});
