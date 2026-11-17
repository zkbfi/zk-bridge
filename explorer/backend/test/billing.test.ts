import { describe, expect, it } from "vitest";
import { BILLING_RETRY_MILLISECONDS, BILLING_TTL_MILLISECONDS, BILLING_URL, GRAPHQL_URL, RUNPOD_REST_URL, billingEndpoints, bucketRows, createBillingReader, figuresOf, parseBalance, parseBillingRows, parseColdStarts, problemText, publicFiguresOf, runpodEndpointId, type BillingSnapshot } from "../src/billing.ts";
import { READ_SECRETS, makeConfig } from "./support.ts";

const KEY = "fake-runpod-key-for-tests-0001";
const NOW = Date.parse("2026-11-07T12:30:00Z");

/** One record of `GET /v2/billing/serverless`: an amount per endpoint and bucket, no billed time. */
const record = (serverlessId: string, startTime: string, totalAmount: number) => ({
  startTime,
  endTime: startTime,
  serverlessId,
  totalAmount,
  gpuAmount: totalAmount - 0.01,
  cpuAmount: 0,
  diskAmount: 0.01,
  feeAmount: 0,
});
const answerOf = (records: unknown[]) => ({ records, metadata: { recordCount: records.length, uniqueServerlessCount: 1, totals: {} } });

/** The shape RunPod answers for bucketSize=day, for the endpoint abc123 and for another endpoint of the account that is not read. */
const DAY_ROWS = [
  record("abc123", "2026-11-05T00:00:00Z", 1.8),
  record("abc123", "2026-11-06T00:00:00Z", 1.3131631457808908),
  record("abc123", "2026-11-07T00:00:00Z", 0.5),
  record("other99", "2026-11-06T00:00:00Z", 40),
];
const HOUR_ROWS = [
  record("abc123", "2026-11-06T10:00:00Z", 9), // ended before the 24 h window
  record("abc123", "2026-11-06T13:00:00Z", 0.25), // ends 14:00, inside
  record("abc123", "2026-11-07T11:00:00Z", 0.1),
  record("other99", "2026-11-07T11:00:00Z", 30),
];
const BALANCE = { data: { myself: { clientBalance: 153.38, currentSpendPerHr: 0, spendLimit: 80 } } };
const PROBLEM = { type: "about:blank", title: "Forbidden", status: 403, detail: "the key has no billing scope" };

/** `GET /v2/serverless/{id}/metrics/cold-starts` for one hour bucket: how many workers started cold and how long it took. */
const coldBucket = (time: string, count: number, min: number, max: number, total: number, p95: number) => ({ time, count, durationMs: { min, max, total, p70: p95, p90: p95, p95, p98: p95 } });
const COLD_STARTS = {
  startTime: "2026-11-06T12:00:00Z",
  endTime: "2026-11-07T12:30:00Z",
  interval: "1h",
  records: [coldBucket("2026-11-06T14:00:00Z", 2, 8000, 20000, 28000, 20000), coldBucket("2026-11-07T09:00:00Z", 1, 31000, 31000, 31000, 31000)],
  pagination: { nextCursor: null, hasNextPage: false },
};

type Call = { url: string; method: string; authorization: string | null; body: string | null };

/** A fetch that answers by URL and records the calls. A value of Error makes that route fail; a status other than 200 answers an RFC 9457 problem. */
function fakeRunpod(answers: { day?: unknown; hour?: unknown; balance?: unknown; coldStarts?: unknown } = {}) {
  const state = { day: answers.day ?? answerOf(DAY_ROWS), hour: answers.hour ?? answerOf(HOUR_ROWS), balance: answers.balance ?? BALANCE, coldStarts: answers.coldStarts ?? COLD_STARTS, status: 200 };
  const calls: Call[] = [];
  const fetchFunction = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    const headers = new Headers(init?.headers);
    calls.push({ url, method: init?.method ?? "GET", authorization: headers.get("authorization"), body: typeof init?.body === "string" ? init.body : null });
    const value = url.startsWith(GRAPHQL_URL) ? state.balance : url.includes("/metrics/cold-starts") ? state.coldStarts : url.includes("bucketSize=hour") ? state.hour : state.day;
    if (value instanceof Error) throw value;
    return new Response(JSON.stringify(state.status === 200 ? value : PROBLEM), { status: state.status, headers: { "content-type": state.status === 200 ? "application/json" : "application/problem+json" } });
  }) as typeof fetch;
  return { state, calls, fetchFunction: () => fetchFunction };
}

function reader(runpod = fakeRunpod(), clock = { now: NOW }, endpoints = [{ id: "abc123", apiKey: KEY }]) {
  const lines: string[] = [];
  const logger = { debug() {}, info() {}, warn: (event: string, fields?: unknown) => void lines.push(`${event} ${JSON.stringify(fields)}`), error() {} };
  return { runpod, clock, lines, reader: createBillingReader({ endpoints, now: () => clock.now, logger, fetchFunction: runpod.fetchFunction }) };
}

describe("parsing the RunPod answers", () => {
  it("reads the records of one endpoint, with the amount in USD and the bucket start in UTC", () => {
    const rows = parseBillingRows(answerOf(DAY_ROWS), new Set(["abc123"]));
    expect(rows).toHaveLength(3);
    expect(rows[1]).toEqual({ time: "2026-11-06 00:00:00", amountUsd: 1.3131631457808908 });
    expect(parseBillingRows(answerOf(DAY_ROWS))).toHaveLength(4);
  });

  it("skips records without a usable start, treats a missing amount as 0 and refuses another shape", () => {
    expect(parseBillingRows(answerOf([{ totalAmount: 1 }, null, "x", { startTime: "2026-11-06T00:00:00Z", serverlessId: "a" }]))).toEqual([{ time: "2026-11-06 00:00:00", amountUsd: 0 }]);
    expect(() => parseBillingRows({ error: "nope" })).toThrow(/no list of records/);
    expect(() => parseBillingRows("x")).toThrow();
  });

  it("turns a problem answer (RFC 9457) into its title and detail", () => {
    expect(() => parseBillingRows(PROBLEM)).toThrow("Forbidden: the key has no billing scope");
    expect(problemText(PROBLEM)).toBe("Forbidden: the key has no billing scope");
    expect(problemText({ title: "Not Found" })).toBe("Not Found");
    expect(problemText({ detail: "x" })).toBe("x");
    expect(problemText("<html>")).toBeNull();
    expect(problemText({ title: "a".repeat(500) })?.length).toBe(200);
  });

  it("sums rows into days and hours", () => {
    const rows = parseBillingRows(answerOf([...DAY_ROWS, record("abc123", "2026-11-06T00:00:00Z", 1)]), new Set(["abc123"]));
    expect(bucketRows(rows, 10).map((bucket) => [bucket.start, bucket.amountUsd.toFixed(3)])).toEqual([
      ["2026-11-05", "1.800"],
      ["2026-11-06", "2.313"],
      ["2026-11-07", "0.500"],
    ]);
    expect(bucketRows(parseBillingRows(answerOf(HOUR_ROWS), new Set(["abc123"])), 13)[1]?.start).toBe("2026-11-06T13");
  });

  it("orders buckets by time whatever the order of the rows", () => {
    expect(bucketRows(parseBillingRows(answerOf([...DAY_ROWS].reverse())), 10).map((bucket) => bucket.start)).toEqual(["2026-11-05", "2026-11-06", "2026-11-07"]);
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
    expect(billingEndpoints(config, READ_SECRETS)).toEqual([{ id: "abc123", apiKey: READ_SECRETS.proverKeys[0]?.value, label: "serverless" }]);
    expect(billingEndpoints(makeConfig(), READ_SECRETS)).toEqual([]);
  });
});

describe("the reader", () => {
  it("asks RunPod v2 once per day and once per hour for all the endpoints of a key, and for the balance, with the key only in the Authorization header", async () => {
    const { reader: billing, runpod } = reader();
    const snapshot = await billing.read();
    const urls = runpod.calls.map((call) => call.url);
    expect(BILLING_URL).toBe(`${RUNPOD_REST_URL}/billing/serverless`);
    expect(RUNPOD_REST_URL).toBe("https://api.runpod.io/v2");
    expect(urls.filter((url) => url.startsWith(`${BILLING_URL}?`) && url.includes("bucketSize=day") && url.includes("startTime=2026-10-07T00%3A00%3A00.000Z"))).toHaveLength(1);
    expect(urls.filter((url) => url.startsWith(`${BILLING_URL}?`) && url.includes("bucketSize=hour"))).toHaveLength(1);
    // RunPod answers 400 "startTime and endTime must be provided together" to a start without an end (seen live 2026-11-17).
    const billingUrls = urls.filter((url) => url.startsWith(`${BILLING_URL}?`));
    expect(billingUrls.every((url) => url.includes("startTime=") && url.includes("endTime="))).toBe(true);
    expect(urls.some((url) => url.includes("serverlessId") || url.includes("rest.runpod.io"))).toBe(false);
    const graph = runpod.calls.find((call) => call.url === GRAPHQL_URL);
    expect(graph?.method).toBe("POST");
    expect(graph?.body).toContain("clientBalance");
    for (const call of runpod.calls) {
      expect(call.authorization).toBe(`Bearer ${KEY}`);
      expect(call.url + (call.body ?? "")).not.toContain(KEY);
    }
    expect(snapshot.spend?.days.map((day) => day.start)).toEqual(["2026-11-05", "2026-11-06", "2026-11-07"]);
    // The other endpoint of the account (other99) is not ours and is not counted.
    expect(snapshot.spend?.days[1]?.amountUsd).toBeCloseTo(1.3131631457808908, 9);
    expect(snapshot.spend?.hours.map((hour) => hour.start)).toEqual(["2026-11-06T10", "2026-11-06T13", "2026-11-07T11"]);
    expect(snapshot.balance).toMatchObject({ balanceUsd: 153.38, spendLimit: 80, readAt: NOW });
  });

  it("sums the buckets of several endpoints of one key from one answer", async () => {
    const day = answerOf([record("a", "2026-11-06T00:00:00Z", 1), record("b", "2026-11-06T00:00:00Z", 2), record("c", "2026-11-06T00:00:00Z", 100)]);
    const runpod = fakeRunpod({ day });
    const { reader: billing } = reader(runpod, { now: NOW }, [{ id: "a", apiKey: KEY }, { id: "b", apiKey: KEY }]);
    const snapshot = await billing.read();
    expect(snapshot.spend?.days).toEqual([{ start: "2026-11-06", amountUsd: 3 }]);
    expect(runpod.calls.filter((call) => call.url.startsWith(BILLING_URL))).toHaveLength(2);
  });

  it("makes one pair of billing requests per distinct key", async () => {
    const runpod = fakeRunpod({ day: answerOf([record("a", "2026-11-06T00:00:00Z", 1), record("b", "2026-11-06T00:00:00Z", 2)]) });
    const { reader: billing } = reader(runpod, { now: NOW }, [{ id: "a", apiKey: KEY }, { id: "b", apiKey: `${KEY}-second` }]);
    const snapshot = await billing.read();
    expect(runpod.calls.filter((call) => call.url.startsWith(BILLING_URL))).toHaveLength(4);
    // Each key's answer counts only the endpoints of that key.
    expect(snapshot.spend?.days).toEqual([{ start: "2026-11-06", amountUsd: 3 }]);
  });

  it("reads the v2 address from its input", async () => {
    const runpod = fakeRunpod();
    const billing = createBillingReader({ endpoints: [{ id: "abc123", apiKey: KEY }], now: () => NOW, fetchFunction: runpod.fetchFunction, restUrl: "https://runpod.test/v2/" });
    await billing.read();
    expect(runpod.calls.filter((call) => call.url.startsWith("https://runpod.test/v2/billing/serverless?"))).toHaveLength(2);
  });

  it("serves the cache for the refresh time (an hour by default), then reads again", async () => {
    const { reader: billing, runpod, clock } = reader();
    await billing.read();
    const first = runpod.calls.length;
    expect(first).toBe(4);
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
    expect(runpod.calls.length).toBe(4);
  });

  it("keeps the last good value after a failure, says how old it is, and retries after the retry time (15 minutes by default)", async () => {
    const { reader: billing, runpod, clock, lines } = reader();
    await billing.read();
    runpod.state.day = new Error("network down");
    runpod.state.balance = new Error("network down");
    clock.now += BILLING_TTL_MILLISECONDS;
    const stale = await billing.read();
    expect(stale.spend?.readAt).toBe(NOW);
    expect(stale.balance?.readAt).toBe(NOW);
    expect(figuresOf(stale, clock.now)).toMatchObject({ available: true, ageSeconds: 3600, balanceAgeSeconds: 3600, balanceUsd: 153.38 });
    expect(lines.join("\n")).toContain("billing_spend_unreadable");
    expect(lines.join("\n")).not.toContain(KEY);
    const calls = runpod.calls.length;
    clock.now += BILLING_RETRY_MILLISECONDS - 1;
    await billing.read();
    expect(runpod.calls.length).toBe(calls);
    runpod.state.day = answerOf(DAY_ROWS);
    runpod.state.balance = BALANCE;
    clock.now += 1;
    expect((await billing.read()).spend?.readAt).toBe(clock.now);
  });

  it("keeps the balance when only the billing fails, and the billing when only the balance fails", async () => {
    const { reader: billing, runpod, clock } = reader(fakeRunpod({ hour: new Error("x") }));
    const first = await billing.read();
    expect(first.spend).toBeNull();
    expect(first.balance?.balanceUsd).toBe(153.38);
    runpod.state.hour = answerOf(HOUR_ROWS);
    runpod.state.balance = { data: { myself: {} } };
    clock.now += BILLING_RETRY_MILLISECONDS;
    const second = await billing.read();
    expect(second.spend).not.toBeNull();
    expect(second.balance?.readAt).toBe(NOW);
  });

  it("treats a RunPod error status and a bad body as a failure, and logs the title and detail of the problem answer", async () => {
    const runpod = fakeRunpod();
    runpod.state.status = 403;
    const { reader: billing, lines } = reader(runpod);
    expect(await billing.read()).toEqual({ spend: null, balance: null, coldStarts: null });
    expect(lines.join("\n")).toContain("RunPod answered 403: Forbidden: the key has no billing scope");
    expect(lines.join("\n")).not.toContain("TypeError");
    const bad = reader(fakeRunpod({ day: { oops: true } }));
    expect((await bad.reader.read()).spend).toBeNull();
    // A 200 that carries a problem document names the problem, not a missing list.
    const problem = reader(fakeRunpod({ day: PROBLEM }));
    expect((await problem.reader.read()).spend).toBeNull();
    expect(problem.lines.join("\n")).toContain("Forbidden: the key has no billing scope");
    // An answer that is not JSON at all is named by its status.
    const html = reader(fakeRunpod({ day: "<html>" }));
    expect((await html.reader.read()).spend).toBeNull();
  });

  it("waits for the next refresh after a 429, not for the retry time", async () => {
    const runpod = fakeRunpod();
    runpod.state.status = 429;
    const { reader: billing, clock, lines } = reader(runpod);
    await billing.read();
    expect(lines.join("\n")).toContain("RunPod answered 429");
    const calls = runpod.calls.length;
    clock.now += BILLING_TTL_MILLISECONDS - 1;
    await billing.read();
    expect(runpod.calls.length).toBe(calls);
    runpod.state.status = 200;
    clock.now += 1;
    expect((await billing.read()).spend).not.toBeNull();
  });

  it("takes the refresh and retry times from its input", async () => {
    const runpod = fakeRunpod({ day: new Error("x") });
    const clock = { now: NOW };
    const billing = createBillingReader({ endpoints: [{ id: "abc123", apiKey: KEY }], now: () => clock.now, fetchFunction: runpod.fetchFunction, ttlMilliseconds: 10_000, retryMilliseconds: 2_000 });
    await billing.read();
    const calls = runpod.calls.length;
    clock.now += 1_999;
    await billing.read();
    expect(runpod.calls.length).toBe(calls);
    clock.now += 1;
    await billing.read();
    expect(runpod.calls.length).toBeGreaterThan(calls);
  });

  it("reads nothing without an endpoint", async () => {
    const { reader: billing, runpod } = reader(fakeRunpod(), { now: NOW }, []);
    expect(await billing.read()).toEqual({ spend: null, balance: null, coldStarts: null });
    expect(runpod.calls).toEqual([]);
  });

  it("times out a slow answer", async () => {
    const slow = (async (_url: string | URL | Request, init?: RequestInit) =>
      new Promise<Response>((_resolve, reject) => init?.signal?.addEventListener("abort", () => reject(new DOMException("timed out", "TimeoutError"))))) as typeof fetch;
    const lines: string[] = [];
    const logger = { debug() {}, info() {}, warn: (event: string, fields?: unknown) => void lines.push(`${event} ${JSON.stringify(fields)}`), error() {} };
    const billing = createBillingReader({ endpoints: [{ id: "abc123", apiKey: KEY }], now: () => NOW, fetchFunction: () => slow, timeoutMilliseconds: 20, logger });
    expect(await billing.read()).toEqual({ spend: null, balance: null, coldStarts: null });
    expect(lines.join("\n")).toContain("TimeoutError");
  });
});

describe("parsing the cold starts", () => {
  it("counts the starts, averages their time, and keeps the longest start and the highest hourly p95", () => {
    const records = [null, { count: 0 }, { count: "x" }, { count: 2, durationMs: null }, { count: 1, durationMs: { total: 5, max: 9, p95: 7 } }, { count: 1, durationMs: { total: 1, max: 3, p95: 2 } }, { count: 1, durationMs: {} }];
    expect(parseColdStarts({ records }, "gpu-24gb")).toEqual({ label: "gpu-24gb", count: 5, averageMs: 1, maxMs: 9, worstHourP95Ms: 7 });
    expect(parseColdStarts({ records: [] }, "x")).toEqual({ label: "x", count: 0, averageMs: null, maxMs: null, worstHourP95Ms: null });
  });

  it("refuses an answer without records and names an RFC 9457 problem", () => {
    expect(() => parseColdStarts(null, "x")).toThrow(/no list of records/);
    expect(() => parseColdStarts("x", "x")).toThrow(/no list of records/);
    expect(() => parseColdStarts(PROBLEM, "x")).toThrow("Forbidden: the key has no billing scope");
  });
});

describe("an error answer that is not JSON", () => {
  it("is logged by its status alone", async () => {
    const html = (async () => new Response("<html>bad gateway</html>", { status: 502 })) as unknown as typeof fetch;
    const lines: string[] = [];
    const logger = { debug() {}, info() {}, warn: (event: string, fields?: unknown) => void lines.push(`${event} ${JSON.stringify(fields)}`), error() {} };
    const billing = createBillingReader({ endpoints: [{ id: "abc123", apiKey: KEY }], now: () => NOW, logger, fetchFunction: () => html });
    expect(await billing.read()).toEqual({ spend: null, balance: null, coldStarts: null });
    expect(lines.join("\n")).toContain('"reason":"RunPod answered 502"');
  });
});

describe("cold starts per tier", () => {
  const tiers = [{ id: "abc123", apiKey: KEY, label: "gpu-24gb" }, { id: "def456", apiKey: KEY }];

  it("reads each endpoint's cold starts of the last 24 hours at the billing refresh and sums them", async () => {
    const { reader: billing, runpod } = reader(fakeRunpod(), { now: NOW }, tiers);
    const snapshot = await billing.read();
    const calls = runpod.calls.filter((call) => call.url.includes("/metrics/cold-starts"));
    expect(calls.map((call) => call.url.split("?")[0]).sort()).toEqual([`${RUNPOD_REST_URL}/serverless/abc123/metrics/cold-starts`, `${RUNPOD_REST_URL}/serverless/def456/metrics/cold-starts`]);
    for (const call of calls) {
      expect(call.method).toBe("GET");
      expect(call.authorization).toBe(`Bearer ${KEY}`);
      expect(call.url).toContain("interval=1h");
      expect(call.url).toContain(`startTime=${encodeURIComponent(new Date(NOW - 86_400_000).toISOString())}`);
      expect(call.url).toContain(`endTime=${encodeURIComponent(new Date(NOW).toISOString())}`);
    }
    expect(snapshot.coldStarts).toEqual({
      readAt: NOW,
      tiers: [
        { label: "gpu-24gb", count: 3, averageMs: 19_667, maxMs: 31_000, worstHourP95Ms: 31_000 },
        { label: "def456", count: 3, averageMs: 19_667, maxMs: 31_000, worstHourP95Ms: 31_000 },
      ],
    });
  });

  it("reads no more often than the billing: the cache serves until the refresh time, with no extra request per page view", async () => {
    const { reader: billing, runpod, clock } = reader(fakeRunpod(), { now: NOW }, tiers);
    await billing.read();
    const first = runpod.calls.filter((call) => call.url.includes("/metrics/cold-starts")).length;
    clock.now += BILLING_TTL_MILLISECONDS - 1;
    await billing.read();
    await billing.read();
    expect(runpod.calls.filter((call) => call.url.includes("/metrics/cold-starts")).length).toBe(first);
    clock.now += 1;
    await billing.read();
    expect(runpod.calls.filter((call) => call.url.includes("/metrics/cold-starts")).length).toBe(first * 2);
  });

  it("reports 0 starts for an hour-free window and null figures where there are none", async () => {
    const { reader: billing } = reader(fakeRunpod({ coldStarts: { ...COLD_STARTS, records: [] } }), { now: NOW }, [tiers[0] as (typeof tiers)[0]]);
    expect((await billing.read()).coldStarts?.tiers).toEqual([{ label: "gpu-24gb", count: 0, averageMs: null, maxMs: null, worstHourP95Ms: null }]);
  });

  it("keeps the last good reading when it fails, and the rest of the billing is unaffected", async () => {
    const { reader: billing, runpod, clock, lines } = reader(fakeRunpod(), { now: NOW }, tiers);
    await billing.read();
    runpod.state.coldStarts = PROBLEM;
    runpod.state.status = 200;
    clock.now += BILLING_TTL_MILLISECONDS;
    const second = await billing.read();
    expect(second.coldStarts?.readAt).toBe(NOW);
    expect(second.spend?.readAt).toBe(clock.now);
    expect(lines.join("\n")).toContain("billing_cold_starts_unreadable");
    expect(lines.join("\n")).toContain("Forbidden: the key has no billing scope");
    expect(lines.join("\n")).not.toContain(KEY);
  });

  it("keeps the tiers that answer when another does not", async () => {
    const runpod = fakeRunpod();
    const answer = runpod.fetchFunction();
    const flaky = (async (url: string | URL | Request, init?: RequestInit) => (String(url).includes("def456/metrics") ? new Response("{}", { status: 500 }) : answer(url, init))) as typeof fetch;
    const lines: string[] = [];
    const logger = { debug() {}, info() {}, warn: (event: string, fields?: unknown) => void lines.push(`${event} ${JSON.stringify(fields)}`), error() {} };
    const billing = createBillingReader({ endpoints: tiers, now: () => NOW, logger, fetchFunction: () => flaky });
    expect((await billing.read()).coldStarts?.tiers.map((tier) => tier.label)).toEqual(["gpu-24gb"]);
    expect(lines.join("\n")).toContain("RunPod answered 500");
  });
});

describe("the figures", () => {
  const snapshot = async (): Promise<BillingSnapshot> => reader().reader.read();

  it("sums the hours that end inside the last 24 h; RunPod v2 reports no billed time, so the billed seconds and the effective rate are unknown (null), not 0", async () => {
    const figures = figuresOf(await snapshot(), NOW);
    expect(figures.last24hUsd).toBeCloseTo(0.35, 6);
    expect(figures.last24hBilledSeconds).toBeNull();
    expect(figures.effectiveUsdPerHour).toBeNull();
    expect(figures.ageSeconds).toBe(0);
  });

  it("averages the 7 full days before today and divides the balance by it", async () => {
    const figures = figuresOf(await snapshot(), NOW);
    expect(figures.averageDailyUsd7d).toBeCloseTo((1.8 + 1.3131631457808908) / 7, 4);
    expect(figures.balanceDaysLeft).toBeCloseTo(153.38 / ((1.8 + 1.3131631457808908) / 7), 0);
    expect(figures.currentSpendPerHr).toBe(0);
  });

  it("carries the state of the spend guard when it is given, and has none otherwise; the public figures leave it out", () => {
    const state = [{ tier: "gpu-24gb", endpointId: "aaa111", state: "held" as const, until: null, lastTrip: null, tripsLast24h: 3 }];
    const snap = { spend: null, balance: null };
    expect(figuresOf(snap, NOW, state).gpuGuard).toEqual(state);
    expect(figuresOf(snap, NOW)).not.toHaveProperty("gpuGuard");
    expect(publicFiguresOf(figuresOf(snap, NOW, state))).not.toHaveProperty("gpuGuard");
  });

  it("has no days left without spend, and no figures without a reading", () => {
    const empty = figuresOf({ spend: { days: [], hours: [], readAt: NOW }, balance: { balanceUsd: 10, currentSpendPerHr: 0, spendLimit: 80, readAt: NOW } }, NOW);
    expect(empty).toMatchObject({ available: true, effectiveUsdPerHour: null, averageDailyUsd7d: 0, balanceDaysLeft: null, last24hUsd: 0 });
    expect(figuresOf({ spend: null, balance: null }, NOW)).toMatchObject({ available: false, ageSeconds: null, last24hUsd: null, effectiveUsdPerHour: null, balanceUsd: null, balanceDaysLeft: null });
  });
});
