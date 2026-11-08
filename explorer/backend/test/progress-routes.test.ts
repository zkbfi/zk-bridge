import { Hono } from "hono";
import { describe, expect, it } from "vitest";
import { insertJob, updateJob } from "../src/requests/jobs.ts";
import { recordBoardPost, recordProveTiming } from "../src/requests/timings.ts";
import { decisionBoardOf } from "../src/watch/decisions.ts";
import { createWarmupStore } from "../src/watch/warmup-store.ts";
import type { HeadUpdate, IndexedHead, IndexedMessage, IndexerReads } from "../src/progress/indexer.ts";
import { ESTIMATE_REUSE_MILLISECONDS, READS_PER_CALLER_PER_MINUTE, createReadLimiter, registerProgressRoutes, workerWarmAt } from "../src/progress/routes.ts";
import type { BillingReader, BillingSnapshot } from "../src/billing.ts";
import { makeBackend, makeConfig } from "./support.ts";

const ID = `0x${"ab".repeat(32)}`;
const SLOT = 12;

/** An indexer the test steers: each read answers its field, and an Error makes it fail. */
function fakeIndexer() {
  const state = {
    message: null as IndexedMessage | null | Error,
    heads: [] as readonly IndexedHead[] | Error,
    headUpdates: [] as readonly HeadUpdate[] | Error,
    delivered: [] as readonly IndexedMessage[],
    calls: { headUpdates: 0 },
  };
  const answer = <Value>(value: Value | Error): Promise<Value> => (value instanceof Error ? Promise.reject(value) : Promise.resolve(value));
  const reads: IndexerReads = {
    message: async () => answer(state.message),
    heads: async () => answer(state.heads),
    headUpdates: async () => {
      state.calls.headUpdates += 1;
      return answer(state.headUpdates);
    },
    delivered: async () => state.delivered,
  };
  return { state, reads };
}

function setup(options: { indexer?: IndexerReads | null; billing?: BillingReader; endpointIdle?: () => number | null; idleTimeoutSeconds?: number } = {}) {
  // The scenarios of these tests rest on a 60 s idle timeout, the setting before 2026-11-08.
  const backend = makeBackend({ config: makeConfig({ watch: { enabled: false, warmup: { idleTimeoutSeconds: options.idleTimeoutSeconds ?? 60 } } }) });
  if (options.endpointIdle !== undefined) (backend.context as { endpointIdleTimeoutSeconds?: () => number | null }).endpointIdleTimeoutSeconds = options.endpointIdle;
  if (options.billing !== undefined) (backend.context as { billing?: BillingReader }).billing = options.billing;
  const indexer = fakeIndexer();
  const app = new Hono();
  let caller = "10.0.0.1";
  registerProgressRoutes(app, backend.context, { indexer: options.indexer === undefined ? indexer.reads : options.indexer, callerOf: () => caller });
  const get = async (path: string, headers: Record<string, string> = {}) => {
    const answer = await app.request(path, { headers });
    return { status: answer.status, body: (await answer.json()) as Record<string, unknown>, headers: answer.headers };
  };
  return { ...backend, indexer, app, get, as: (next: string) => (caller = next) };
}

/** A message sent `secondsAgo` before the clock, from Ethereum (1) to PulseChain (369). */
const sentMessage = (now: number, secondsAgo: number, overrides: Partial<IndexedMessage> = {}): IndexedMessage => ({
  messageId: ID,
  status: "sent",
  direction: { sourceChainId: 1, destinationChainId: 369 },
  sent: { timestamp: Math.floor(now / 1000) - secondsAgo },
  covered: null,
  delivered: null,
  ...overrides,
});

describe("GET /progress/:messageId (2026-11-01)", () => {
  it("refuses an identifier that is not 32 bytes of hex", async () => {
    const run = setup();
    expect(await run.get("/progress/0x1234")).toMatchObject({ status: 400 });
  });

  it("answers 503 without an indexer or when it cannot be read, and 404 for an unknown, unsent or foreign message", async () => {
    expect(await setup({ indexer: null }).get(`/progress/${ID}`)).toMatchObject({ status: 503, body: { error: "the chain indexer is not configured" } });
    const run = setup();
    run.indexer.state.message = new Error("down");
    expect(await run.get(`/progress/${ID}`)).toMatchObject({ status: 503, body: { error: "the chain indexer cannot be read" } });
    run.indexer.state.message = null;
    expect(await run.get(`/progress/${ID}`)).toMatchObject({ status: 404, body: { error: "unknown message" } });
    run.indexer.state.message = sentMessage(run.clock.now(), 10, { sent: null });
    expect(await run.get(`/progress/${ID}`)).toMatchObject({ status: 404 });
    run.indexer.state.message = sentMessage(run.clock.now(), 10, { direction: { sourceChainId: 1, destinationChainId: 943 } });
    expect(await run.get(`/progress/${ID}`)).toMatchObject({ status: 404, body: { error: "the message is not of this pair" } });
  });

  it("names the job, its step and the estimate from recent proofs; the slot clock comes from the watcher's decision", async () => {
    const run = setup();
    const now = run.clock.now();
    const genesis = Math.floor(now / 1000) - 100_000 * SLOT;
    // An earlier proof: a cold worker took 60 s, the whole run 100 s, the board post 8 s.
    insertJob(run.storage, { id: "old", direction: "first-to-second", now: now - 900_000 });
    updateJob(run.storage, "old", { status: "on-chain", startSlot: "1", newSlot: "2" }, now - 800_000, ["queued"]);
    recordProveTiming(run.storage, { jobId: "old", direction: "first-to-second", startedAt: now - 900_000, provedAt: now - 800_000, timing: { wait_worker_ms: 60_000, not_ready_count: 1, total_ms: 100_000 } });
    recordBoardPost(run.storage, { jobId: "old", direction: "first-to-second", storedAt: now - 799_000, postedAt: now - 790_000, grindMs: 8_000 });
    // A proof of an older prover reports nothing and changes no estimate.
    recordProveTiming(run.storage, { jobId: "older", direction: "first-to-second", startedAt: now - 990_000, provedAt: now - 980_000, timing: null });
    run.indexer.state.message = sentMessage(now, 1_200, { status: "waiting_for_finality" });
    decisionBoardOf(run.context).record("first-to-second", { at: now, finalizedSlot: 99_990, headSlot: 99_000, genesisTime: genesis, secondsPerSlot: SLOT, due: true, why: "message", detail: "1 waiting message is final", outcome: "job-started" });
    insertJob(run.storage, { id: "new", direction: "first-to-second", now: now - 10_000, target: { startSlot: 99_000, newSlot: 99_990 } });
    updateJob(run.storage, "new", { status: "proving" }, now - 10_000, ["queued"]);
    const answer = await run.get(`/progress/${ID}`);
    expect(answer.status).toBe(200);
    expect(answer.body).toMatchObject({ messageId: ID, direction: "first-to-second", status: "waiting_for_finality", slot: 99_900, job: { jobId: "new", status: "proving" } });
    expect(answer.body.waitingOn).toMatchObject({ service: "gpu-worker-start", since: now - 10_000, eta: now - 10_000 + 100_000 });
    // A warm-up that made a worker ready before the job: the GPU proves.
    const store = createWarmupStore(run.storage);
    const session = store.openSession({ direction: "first-to-second", why: "message", dueAt: now, leadSeconds: 90, at: now - 120_000 });
    store.markReady(session, now - 60_000);
    run.indexer.state.message = sentMessage(now, 1_200, { status: "sent" });
    run.clock.advance(5_001);
    expect((await run.get(`/progress/${ID}`)).body.waitingOn).toMatchObject({ service: "gpu-proving" });
  });

  it("without a decision, takes the slot clock from the indexer's head; without heads, no slot", async () => {
    const run = setup();
    const now = run.clock.now();
    const nowSeconds = Math.floor(now / 1000);
    run.indexer.state.message = sentMessage(now, 60);
    run.indexer.state.heads = [
      { chainId: 1, trackedChainId: 369, storedHeadSlot: 5, storedHeadSlotTimestamp: 50 },
      { chainId: 369, trackedChainId: 1, storedHeadSlot: 1_000, storedHeadSlotTimestamp: nowSeconds - 600, finalizedSlot: 1_030 },
    ];
    const answer = await run.get(`/progress/${ID}`);
    expect(answer.body).toMatchObject({ slot: 1_045, waitingOn: { service: "source-chain-finality" } });
    run.indexer.state.heads = new Error("down");
    run.indexer.state.message = sentMessage(now, 61);
    run.clock.advance(5_000);
    expect((await run.get(`/progress/${ID}`)).body).toMatchObject({ slot: null });
  });

  it("limits each caller to its reads a minute, with Retry-After", async () => {
    const run = setup();
    run.indexer.state.message = null;
    for (let index = 0; index < READS_PER_CALLER_PER_MINUTE; index += 1) expect((await run.get(`/progress/${ID}`)).status).toBe(404);
    const refused = await run.get(`/progress/${ID}`);
    expect(refused).toMatchObject({ status: 429, body: { error: "rate-limited", retryAfterSeconds: 60 } });
    expect(refused.headers.get("Retry-After")).toBe("60");
    expect((await run.get("/benchmarks")).status).toBe(429);
    expect((await run.get("/directions/first-to-second/pipeline")).status).toBe(429);
    run.as("10.0.0.2");
    expect((await run.get(`/progress/${ID}`)).status).toBe(404);
    run.as("10.0.0.1");
    run.clock.advance(60_000);
    expect((await run.get(`/progress/${ID}`)).status).toBe(404);
  });

  it("reads the on-chain medians of a day once a minute", async () => {
    const run = setup();
    run.indexer.state.message = sentMessage(run.clock.now(), 60);
    await run.get(`/progress/${ID}`);
    await run.get(`/progress/${ID}`);
    expect(run.indexer.state.calls.headUpdates).toBe(2);
    run.clock.advance(ESTIMATE_REUSE_MILLISECONDS);
    await run.get(`/progress/${ID}`);
    expect(run.indexer.state.calls.headUpdates).toBe(4);
  });
});

describe("GET /directions/:direction/pipeline (2026-11-01)", () => {
  it("answers 404 for an unknown direction", async () => {
    expect(await setup().get("/directions/sideways/pipeline")).toMatchObject({ status: 404, body: { error: "unknown direction" } });
  });

  it("shows the running job, the newest proof, the head and the last decision", async () => {
    const run = setup();
    const now = run.clock.now();
    insertJob(run.storage, { id: "j", direction: "second-to-first", now: now - 20_000 });
    run.storage.database.prepare("INSERT INTO proofs (direction, job_id, start_slot, new_slot, body, stored_at) VALUES ('second-to-first', NULL, '10', '20', '{}', 5)").run();
    run.indexer.state.heads = [{ chainId: 1, trackedChainId: 369, storedHeadSlot: 10, finalizedSlot: 40, lastUpdateTimestamp: 100, lagSeconds: 30 }];
    const decision = { at: now, finalizedSlot: 40, headSlot: 10, genesisTime: 0, secondsPerSlot: 10, due: false, why: "proof-pending", detail: "the proof from slot 10 to slot 20 (board) waits to land" };
    decisionBoardOf(run.context).record("second-to-first", decision);
    const answer = await run.get("/directions/second-to-first/pipeline");
    expect(answer.status).toBe(200);
    expect(answer.body).toMatchObject({
      direction: "second-to-first",
      batch: null,
      job: { jobId: "j", status: "queued", step: "gpu-worker-start", elapsedMs: 20_000 },
      latestJob: { jobId: "j", status: "queued" },
      latestProof: { startSlot: 10, newSlot: 20, where: "board" },
      head: { slot: 10, finalizedSlot: 40, lastUpdateAt: 100_000, lagSeconds: 30 },
      decision,
    });
    run.indexer.state.heads = new Error("down");
    expect((await run.get("/directions/second-to-first/pipeline")).body).toMatchObject({ head: null });
  });

  it("carries the rule that starts a proof: the configured interval and margin, the proof cost, and whether prices exist (2026-11-07)", async () => {
    const config = makeConfig({ watch: { enabled: false, minIntervalSeconds: 3600, profitMargin: 1.5, pairs: { "eth-pls": { directions: { "second-to-first": { minIntervalSeconds: 0 } } } } } });
    const backend = makeBackend({ config });
    const app = new Hono();
    registerProgressRoutes(app, backend.context, { indexer: null, callerOf: () => "10.0.0.1" });
    const rule = async (direction: string) => ((await (await app.request(`/directions/${direction}/pipeline`)).json()) as { rule: unknown }).rule;
    // PAIR has a PulseChain mainnet side, so prices exist; the epoch of Ethereum is 32 x 12 s.
    expect(await rule("first-to-second")).toEqual({ minIntervalSeconds: 3600, lookaheadSeconds: 384, profitMargin: 1.5, proofCostUsd: "0.025000", priced: true });
    expect(await rule("second-to-first")).toMatchObject({ minIntervalSeconds: 0, lookaheadSeconds: 320 });
    // A testnet pair has no PulseChain mainnet side: nothing can be priced.
    const [first, second] = backend.context.pair.sides;
    const testnet = { ...backend.context, pair: { ...backend.context.pair, sides: [first, { ...second, chainId: 943 }] as const } };
    const other = new Hono();
    registerProgressRoutes(other, testnet, { indexer: null, callerOf: () => "10.0.0.1" });
    expect(((await (await other.request("/directions/first-to-second/pipeline")).json()) as { rule: unknown }).rule).toMatchObject({ priced: false });
  });

  it("works without an indexer: no head", async () => {
    expect((await setup({ indexer: null }).get("/directions/first-to-second/pipeline")).body).toMatchObject({ head: null, job: null, latestJob: null });
  });
});

describe("GET /benchmarks (2026-11-01)", () => {
  it("refuses a window it does not know, and takes a day by default", async () => {
    const run = setup();
    expect(await run.get("/benchmarks?window=1w")).toMatchObject({ status: 400 });
    const answer = await run.get("/benchmarks");
    expect(answer).toMatchObject({ status: 200, body: { window: "24h", windowSeconds: 86_400, indexer: "ok" } });
    expect((await run.get("/benchmarks?window=7d")).body).toMatchObject({ window: "7d", windowSeconds: 604_800 });
  });

  it("states the indexer as unavailable when it fails or is not set, and logs the failure", async () => {
    const run = setup();
    run.indexer.state.headUpdates = new Error("down");
    expect((await run.get("/benchmarks")).body).toMatchObject({ indexer: "unavailable" });
    expect(run.log.lines.some((line) => line.includes("benchmarks_indexer_unreadable"))).toBe(true);
    expect((await setup({ indexer: null }).get("/benchmarks")).body).toMatchObject({ indexer: "unavailable" });
  });
});

describe("the idle timeout on /billing (2026-11-08)", () => {
  it("gives the configured idle timeout and what RunPod reports for the endpoint, null while unknown or without a RunPod endpoint", async () => {
    expect(((await setup().get("/billing")).body as Record<string, any>).assumptions).toMatchObject({ idleTimeoutSeconds: 60, endpointIdleTimeoutSeconds: null });
    expect(((await setup({ endpointIdle: () => null }).get("/billing")).body as Record<string, any>).assumptions.endpointIdleTimeoutSeconds).toBeNull();
    expect(((await setup({ endpointIdle: () => 5, idleTimeoutSeconds: 5 }).get("/billing")).body as Record<string, any>).assumptions).toMatchObject({ idleTimeoutSeconds: 5, endpointIdleTimeoutSeconds: 5 });
  });
});

describe("GET /warmup/summary (2026-11-06)", () => {
  it("answers the daily totals with the assumptions, and never a host or a key", async () => {
    const run = setup();
    const store = createWarmupStore(run.storage);
    const start = run.context.now() - 3_600_000;
    const used = store.openSession({ direction: "first-to-second", why: "message", dueAt: start + 60_000, leadSeconds: 60, at: start });
    store.markReady(used, start + 30_000);
    store.endSession(used, "used", start + 70_000, 60);
    const wasted = store.openSession({ direction: "first-to-second", why: "message", dueAt: start + 600_000, leadSeconds: 60, at: start + 100_000 });
    store.endSession(wasted, "unusable", start + 110_000, 60);
    const answer = await run.get("/warmup/summary");
    expect(answer.status).toBe(200);
    expect(answer.body).toMatchObject({
      days: 7,
      assumptions: { idleTimeoutSeconds: 60, gpuUsdPerHour: 2.25 },
      total: { sessions: 2, used: 1, wasted: 1, billedSeconds: 200, wastedSeconds: 70, idleBeforeDueSeconds: 30 },
    });
    expect((answer.body.byDay as unknown[]).length).toBeGreaterThanOrEqual(1);
    expect(JSON.stringify(answer.body)).not.toMatch(/https?:|key|token/i);
    expect((await run.get("/warmup/summary?days=1")).body).toMatchObject({ days: 1 });
  });

  it("refuses a number of days it does not know, and limits the reads", async () => {
    const run = setup();
    for (const days of ["0", "31", "x", "1.5", "-1"]) expect((await run.get(`/warmup/summary?days=${days}`)).status).toBe(400);
    for (let index = 0; index < READS_PER_CALLER_PER_MINUTE; index += 1) await run.get("/warmup/summary");
    expect((await run.get("/warmup/summary")).status).toBe(429);
  });
});

describe("GET /warmup/summary with RunPod billing (2026-11-07)", () => {
  /** The context clock is read first, so the days are those of the test's own `now`. */
  const withBilling = (build: (now: number) => BillingSnapshot) => {
    const probe = setup();
    const now = probe.context.now();
    const reader: BillingReader = { read: async () => build(now) };
    return setup({ billing: reader });
  };
  const dayOf = (now: number, back: number) => new Date(now - back * 86_400_000).toISOString().slice(0, 10);

  function sessions(run: ReturnType<typeof setup>) {
    const store = createWarmupStore(run.storage);
    const start = run.context.now() - 3_600_000;
    const used = store.openSession({ direction: "first-to-second", why: "message", dueAt: start + 60_000, leadSeconds: 60, at: start });
    store.markReady(used, start + 30_000);
    store.endSession(used, "used", start + 70_000, 60);
    const wasted = store.openSession({ direction: "first-to-second", why: "message", dueAt: start + 600_000, leadSeconds: 60, at: start + 100_000 });
    store.endSession(wasted, "unusable", start + 110_000, 60);
  }

  const snapshot = (now: number): BillingSnapshot => ({
    spend: {
      // $0.76 an hour: 3 600 s billed for $0.76 each day.
      days: [-2, -1, 0].map((back) => ({ start: dayOf(now, -back), amountUsd: 0.76, billedSeconds: 3600 })).reverse(),
      hours: [{ start: new Date(now - 3_600_000).toISOString().slice(0, 13), amountUsd: 0.38, billedSeconds: 1800 }],
      readAt: now - 90_000,
    },
    balance: { balanceUsd: 153.38, currentSpendPerHr: 0, spendLimit: 80, readAt: now - 30_000 },
  });

  it("prices the wasted seconds at the rate RunPod billed, and gives the money next to the estimate", async () => {
    const run = withBilling(snapshot);
    sessions(run);
    const body = (await run.get("/warmup/summary")).body as Record<string, any>;
    expect(body.rateSource).toBe("runpod");
    expect(body.usdPerHour).toBeCloseTo(0.76, 4);
    // 70 wasted seconds at $0.76 an hour; the same seconds at the assumed $2.25 an hour would be 0.0438.
    expect(body.total.wastedSeconds).toBe(70);
    expect(body.total.wastedCostUsd).toBeCloseTo((70 / 3600) * 0.76, 4);
    expect(body.total.estimatedCostUsd).toBeCloseTo((200 / 3600) * 0.76, 4);
    expect(body.assumptions).toMatchObject({ gpuUsdPerHour: 2.25, gpuUsdPerHourIsFallback: true });
    expect(body.billing).toMatchObject({ available: true, ageSeconds: 90, last24hUsd: 0.38, last24hBilledSeconds: 1800, balanceUsd: 153.38, balanceAgeSeconds: 30, currentSpendPerHr: 0, spendLimit: 80, effectiveUsdPerHour: 0.76 });
    const today = (body.byDay as Array<Record<string, any>>)[0];
    expect(today).toMatchObject({ billedUsd: 0.76, runpodBilledSeconds: 3600, effectiveUsdPerHour: 0.76 });
    expect(body.total).toMatchObject({ billedUsd: 0.76, runpodBilledSeconds: 3600 });
    expect(JSON.stringify(body)).not.toMatch(/https?:|key|token/i);
  });

  it("keeps the account (balance, spend limit, spend now, days left) off a request that came through Caddy", async () => {
    const run = withBilling(snapshot);
    sessions(run);
    const body = (await run.get("/warmup/summary", { "x-forwarded-for": "203.0.113.7" })).body as Record<string, any>;
    expect(body.billing).toMatchObject({ available: true, last24hUsd: 0.38, effectiveUsdPerHour: 0.76 });
    for (const field of ["balanceUsd", "balanceAgeSeconds", "currentSpendPerHr", "spendLimit", "balanceDaysLeft"]) expect(body.billing).not.toHaveProperty(field);
    expect(body.total).toMatchObject({ billedUsd: 0.76 });
  });

  it("falls back to the assumed rate, and says so, when billing is missing, unread or has no billed time", async () => {
    for (const run of [setup(), withBilling(() => ({ spend: null, balance: null })), withBilling((now) => ({ spend: { days: [{ start: dayOf(now, 0), amountUsd: 0, billedSeconds: 0 }], hours: [], readAt: now }, balance: null }))]) {
      sessions(run);
      const body = (await run.get("/warmup/summary")).body as Record<string, any>;
      expect(body.rateSource).toBe("assumed");
      expect(body.usdPerHour).toBe(2.25);
      expect(body.total.wastedCostUsd).toBeCloseTo((70 / 3600) * 2.25, 3);
      expect(body.total.billedUsd === null || body.total.billedUsd === 0).toBe(true);
    }
    const none = (await setup().get("/warmup/summary")).body as Record<string, any>;
    expect(none.billing).toMatchObject({ available: false, ageSeconds: null, last24hUsd: null, balanceUsd: null });
  });

  it("answers from the cache of the reader: a read does not wait for RunPod beyond the reader", async () => {
    let reads = 0;
    const run = setup({ billing: { read: async () => ((reads += 1), { spend: null, balance: null }) } });
    await run.get("/warmup/summary");
    await run.get("/warmup/summary?days=1");
    expect(reads).toBe(2);
  });
});

describe("GET /billing (2026-11-07)", () => {
  const withBilling = (build: (now: number) => BillingSnapshot) => {
    const now = setup().context.now();
    return setup({ billing: { read: async () => build(now) } });
  };
  const dayOf = (now: number, back: number) => new Date(now - back * 86_400_000).toISOString().slice(0, 10);
  const snapshot = (now: number): BillingSnapshot => ({
    spend: {
      days: [2, 1, 0].map((back) => ({ start: dayOf(now, back), amountUsd: 0.76, billedSeconds: 3600 })).reverse(),
      hours: [{ start: new Date(now - 3_600_000).toISOString().slice(0, 13), amountUsd: 0.38, billedSeconds: 1800 }],
      readAt: now - 90_000,
    },
    balance: { balanceUsd: 153.38, currentSpendPerHr: 0, spendLimit: 80, readAt: now - 30_000 },
  });
  function sessions(run: ReturnType<typeof setup>) {
    const store = createWarmupStore(run.storage);
    const start = run.context.now() - 3_600_000;
    const used = store.openSession({ direction: "first-to-second", why: "message", dueAt: start + 60_000, leadSeconds: 60, at: start });
    store.markReady(used, start + 30_000);
    store.endSession(used, "used", start + 70_000, 60);
    const unused = store.openSession({ direction: "first-to-second", why: "message", dueAt: start + 600_000, leadSeconds: 60, at: start + 100_000 });
    store.endSession(unused, "unusable", start + 110_000, 60);
  }

  it("leads with what RunPod billed, and nests the workers started before a proof", async () => {
    const run = withBilling(snapshot);
    sessions(run);
    const body = (await run.get("/billing")).body as Record<string, any>;
    expect(body).toMatchObject({
      days: 7,
      rateSource: "runpod",
      usdPerHour: 0.76,
      available: true,
      ageSeconds: 90,
      last24h: { billedUsd: 0.38, billedSeconds: 1800 },
      effectiveUsdPerHour: 0.76,
      account: { balanceUsd: 153.38, balanceAgeSeconds: 30, spendNowUsdPerHour: 0, spendLimitUsd: 80 },
      assumptions: { gpuUsdPerHour: 2.25 },
    });
    expect(body.total).toMatchObject({ billedUsd: 2.28, billedSeconds: 10_800, effectiveUsdPerHour: 0.76 });
    expect(body.total.earlyStarts).toEqual({ sessions: 2, used: 1, unused: 1, unusedSeconds: 70, unusedUsd: Math.round((70 / 3600) * 0.76 * 10_000) / 10_000, waitingSeconds: 30 });
    expect(body.byDay).toHaveLength(3);
    // The test clock sits just after midnight UTC: the sessions started the hour before, on the day before.
    expect(body.byDay[1]).toMatchObject({ billedUsd: 0.76, billedSeconds: 3600, effectiveUsdPerHour: 0.76, earlyStarts: { sessions: 2, unused: 1 } });
    expect(body.byDay[0].earlyStarts).toEqual({ sessions: 0, used: 0, unused: 0, unusedSeconds: 0, unusedUsd: 0, waitingSeconds: 0 });
    expect(JSON.stringify(body)).not.toMatch(/https?:|key|token|wasted/i);
    expect((await run.get("/billing?days=1")).body).toMatchObject({ days: 1 });
    expect(((await run.get("/billing?days=1")).body as any).byDay).toHaveLength(2);
  });

  it("puts every billed second in one bucket, per day, in the total and over the last 24 hours (2026-11-07)", async () => {
    // The clock is just after midnight UTC. RunPod's hours: one billed before the records (1800 s) and the hour that is still
    // filling (not compared), so billing has reached the hour of `now`; the records of the hour before have no bill in it.
    const run = withBilling((at) => {
      const base = snapshot(at);
      const hours = [
        { start: new Date(at - 7_200_000).toISOString().slice(0, 13), amountUsd: 0.38, billedSeconds: 1800 },
        { start: new Date(at).toISOString().slice(0, 13), amountUsd: 0.01, billedSeconds: 10 },
      ];
      return { ...base, spend: { ...(base.spend as NonNullable<BillingSnapshot["spend"]>), hours } };
    });
    sessions(run);
    const now = run.context.now();
    // A job proved 30 minutes ago: a 50 s request on the worker after 20 s of waiting for a cold worker.
    recordProveTiming(run.storage, {
      jobId: "j1",
      direction: "first-to-second",
      startedAt: now - 1_900_000,
      provedAt: now - 1_800_000,
      timing: { wait_worker_ms: 20_000, not_ready_count: 1, remote_ms: 50_000, worker_total_ms: 48_000 },
    });
    const body = (await run.get("/billing")).body as Record<string, any>;
    // The sessions of the helper: a used one (cold start 30 s, ready, ends at 70 s, and the worker idles 60 s more until
    // the next request) and an unused one that starts at 100 s with 70 s billed; the used one's waiting takes its first 30 s.
    const total = body.total.breakdown;
    expect(total).toMatchObject({
      proving: { seconds: 48 },
      startingUp: { seconds: 50 },
      waitingForProof: { seconds: 100 },
      unusedEarlyStarts: { seconds: 40 },
      idleAfterJob: { seconds: 60 },
    });
    const claimed = 48 + 50 + 100 + 40 + 60;
    // Billing has reached the start of the current hour, which is today's first minutes: today (3600 s in the fixture) is
    // not compared, and the two days before it are (7200 s). Each day is priced at its own rate, here the same $0.76.
    expect(total.billed).toEqual({ seconds: 7200, usd: 1.52 });
    expect(total.unaccounted).toEqual({ seconds: 7200 - claimed, usd: Math.round((1.52 - (claimed / 3600) * 0.76) * 10_000) / 10_000 });
    expect(total.billedThrough).toBe(new Date(Math.floor(now / 3_600_000) * 3_600_000).toISOString());
    expect(body.byDay[0].breakdown.unaccounted).toBeNull();
    // The day totals add up to the bill of the day that was compared.
    for (const day of body.byDay.slice(1)) {
      const sum = ["proving", "startingUp", "waitingForProof", "unusedEarlyStarts", "idleAfterJob", "unaccounted"].reduce((acc, key) => acc + day.breakdown[key].seconds, 0);
      expect(sum).toBeCloseTo(day.billedSeconds, 2);
      expect(day.breakdown.billed.seconds).toBe(day.billedSeconds);
    }
    expect(body.last24h.breakdown).toMatchObject({ proving: { seconds: 48 }, unusedEarlyStarts: { seconds: 40 }, idleAfterJob: { seconds: 60 } });
    // The 24 h bill is 1800 s (the hour of the snapshot): unaccounted is that minus the buckets.
    expect(body.last24h.breakdown.unaccounted.seconds).toBe(1800 - claimed);
    expect(body.last24h.billedSeconds).toBe(1810);
    expect(body.last24h.breakdown.billed).toEqual({ seconds: 1800, usd: 0.38 });
    expect(body.last24h.breakdown.billedThrough).toBe(total.billedThrough);
    expect(body.last24h.breakdown.notYetBilled).toEqual({ seconds: 0, usd: 0 });
  });

  it("computes the buckets for days RunPod has no figure for, with unaccounted null", async () => {
    for (const run of [setup(), withBilling((now) => ({ spend: { days: [{ start: dayOf(now, 5), amountUsd: 1, billedSeconds: 100 }], hours: [], readAt: now }, balance: null }))]) {
      const noReading = run.context.billing === undefined;
      sessions(run);
      const body = (await run.get("/billing")).body as Record<string, any>;
      expect(body.total.breakdown.unusedEarlyStarts.seconds).toBe(70);
      expect(body.last24h.breakdown.unusedEarlyStarts.seconds).toBe(70);
      // With a reading but no billed hour, RunPod billed nothing in 24 h: the records are then all unaccounted for.
      if (noReading) expect(body.last24h.breakdown.unaccounted).toBeNull();
      else expect(body.last24h.breakdown.unaccounted).toEqual({ seconds: -140, usd: -1.4 });
      for (const day of body.byDay.filter((entry: any) => entry.billedUsd === null)) expect(day.breakdown.unaccounted).toBeNull();
      expect(body.byDay.some((day: any) => day.billedUsd === null && day.breakdown.unusedEarlyStarts.seconds > 0)).toBe(true);
    }
  });

  it("keeps the account off a request that came through Caddy", async () => {
    const run = withBilling(snapshot);
    const body = (await run.get("/billing", { "x-forwarded-for": "203.0.113.7" })).body as Record<string, any>;
    expect(body).not.toHaveProperty("account");
    expect(body).toMatchObject({ last24h: { billedUsd: 0.38 }, effectiveUsdPerHour: 0.76 });
  });

  it("says the rate is assumed, and bills nothing, when RunPod cannot be read or has no billed time", async () => {
    for (const run of [setup(), withBilling(() => ({ spend: null, balance: null })), withBilling((now) => ({ spend: { days: [{ start: dayOf(now, 0), amountUsd: 0, billedSeconds: 0 }], hours: [], readAt: now }, balance: null }))]) {
      sessions(run);
      const body = (await run.get("/billing")).body as Record<string, any>;
      expect(body).toMatchObject({ rateSource: "assumed", usdPerHour: 2.25 });
      expect(body.total.effectiveUsdPerHour).toBeNull();
      expect(body.total.earlyStarts.unusedUsd).toBeCloseTo((70 / 3600) * 2.25, 3);
    }
    const none = (await setup().get("/billing")).body as Record<string, any>;
    expect(none).toMatchObject({ available: false, ageSeconds: null, last24h: { billedUsd: null }, total: { billedUsd: null, billedSeconds: null } });
  });

  it("refuses a number of days it does not know, and shares the read limit", async () => {
    const run = setup();
    for (const days of ["0", "31", "x", "1.5", "-1"]) expect((await run.get(`/billing?days=${days}`)).status).toBe(400);
    for (let index = 0; index < READS_PER_CALLER_PER_MINUTE; index += 1) await run.get("/billing");
    expect((await run.get("/billing")).status).toBe(429);
  });
});

describe("the routes in the backend", () => {
  it("are served by the requests module, cross-origin, with the indexer of the configuration", async () => {
    const backend = makeBackend({ config: makeConfig({ indexerUrl: "http://127.0.0.1:9/" }) });
    const answer = await backend.app.request("/benchmarks", { headers: { origin: "https://next.zkb.fi" } });
    expect(answer.status).toBe(200);
    expect(answer.headers.get("Access-Control-Allow-Origin")).toBe("*");
    expect(await answer.json()).toMatchObject({ indexer: "unavailable" });
    const progress = await backend.app.request(`/progress/${ID}`, { headers: { "x-forwarded-for": "10.9.9.9" } });
    expect(progress.status).toBe(503);
    const without = makeBackend();
    expect((await without.app.request(`/progress/${ID}`)).status).toBe(503);
  });
});

describe("the read limiter", () => {
  it("forgets the callers of past minutes once it knows many", () => {
    let now = 0;
    const limiter = createReadLimiter({ perMinute: 1, now: () => now });
    for (let index = 0; index <= 10_000; index += 1) expect(limiter.take(`c${index}`)).toBe(0);
    expect(limiter.take("c0")).toBe(60);
    now = 60_000;
    expect(limiter.take("fresh")).toBe(0);
    expect(limiter.take("c0")).toBe(0);
  });
});

describe("a warm worker at a time", () => {
  it("needs a session that was ready by then and had not ended", () => {
    const backend = makeBackend();
    const store = createWarmupStore(backend.storage);
    expect(workerWarmAt(backend.storage, "first-to-second", 100)).toBe(false);
    const id = store.openSession({ direction: "first-to-second", why: "message", dueAt: 0, leadSeconds: 90, at: 0 });
    expect(workerWarmAt(backend.storage, "first-to-second", 100)).toBe(false);
    store.markReady(id, 50);
    expect(workerWarmAt(backend.storage, "first-to-second", 100)).toBe(true);
    store.endSession(id, "used", 80, 60);
    expect(workerWarmAt(backend.storage, "first-to-second", 100)).toBe(false);
    expect(workerWarmAt(backend.storage, "first-to-second", 70)).toBe(true);
  });
});
