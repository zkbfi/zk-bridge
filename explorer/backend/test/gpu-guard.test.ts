import { afterEach, describe, expect, it, vi } from "vitest";
import { RUNPOD_REST_URL } from "../src/billing.ts";
import { openStorage, type Storage } from "../src/storage.ts";
import { createGpuGuard, type GpuGuardSettings } from "../src/gpu-guard.ts";

const KEY = "fake-runpod-key-for-tests-0003";
const A = { id: "aaa111bbb222", apiKey: KEY, label: "gpu-24gb" };
const B = { id: "bbb222ccc333", apiKey: KEY, label: "gpu-48gb" };
const START = Date.parse("2026-11-17T12:30:00Z");
const MINUTE = 60_000;
const SETTINGS: GpuGuardSettings = { enabled: true, checkSeconds: 300, stuckMinutes: 15, spendCheckSeconds: 3600, maxUsdPerHour: 0.5, cooldownMinutes: 10, maxTripsPerDay: 2, backoffSeconds: 900 };

type Call = { url: string; method: string; authorization: string | null; body: unknown };
type Tier = { workers: Array<{ id: string; status: string }> | "broken"; live: { min: number; max: number; idleTimeout: number }; records: unknown; patchStatus: number; down: boolean; getStatus: number; retryAfter?: string };

/** A RunPod v2 double with one state per endpoint id. A PATCH changes `live`, like RunPod does. */
function fakeRunpod() {
  const fresh = (): Tier => ({ workers: [], live: { min: 0, max: 1, idleTimeout: 5 }, records: [], patchStatus: 200, down: false, getStatus: 200 });
  const tiers: Record<string, Tier> = { [A.id]: fresh(), [B.id]: fresh() };
  const calls: Call[] = [];
  const fetchFunction = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input));
    const body = typeof init?.body === "string" ? JSON.parse(init.body) : null;
    const method = init?.method ?? "GET";
    calls.push({ url: String(input), method, authorization: new Headers(init?.headers).get("authorization"), body });
    const id = url.searchParams.get("serverlessId") ?? /\/serverless\/([a-z0-9]+)/.exec(url.pathname)?.[1] ?? "";
    const tier = tiers[id] as Tier;
    if (tier.down) throw new TypeError(`fetch failed for ${url}`);
    if (tier.getStatus !== 200 && method === "GET") return Response.json({ title: "Unauthorized", status: tier.getStatus, detail: "bad key" }, { status: tier.getStatus, ...(tier.retryAfter === undefined ? {} : { headers: { "retry-after": tier.retryAfter } }) });
    if (method === "PATCH") {
      if (tier.patchStatus !== 200) return Response.json({ title: "Bad Request", status: tier.patchStatus, detail: "nope" }, { status: tier.patchStatus });
      tier.live = body.workers;
      return Response.json({ id });
    }
    if (url.pathname.endsWith("/workers")) return tier.workers === "broken" ? Response.json({}) : Response.json({ workers: tier.workers });
    if (url.pathname.endsWith("/billing/serverless")) return Response.json({ records: tier.records });
    return Response.json({ id, workers: tier.live });
  }) as typeof fetch;
  return { tiers, calls, fetchFunction: () => fetchFunction };
}

function make(options: { settings?: Partial<GpuGuardSettings>; runpod?: ReturnType<typeof fakeRunpod>; storage?: Storage; clock?: { at: number } } = {}) {
  const runpod = options.runpod ?? fakeRunpod();
  const lines: string[] = [];
  const record = (level: string) => (event: string, fields?: unknown) => void lines.push(`${level} ${event} ${JSON.stringify(fields)}`);
  const clock = options.clock ?? { at: START };
  const guard = createGpuGuard({
    endpoints: [A, B],
    settings: { ...SETTINGS, ...options.settings },
    now: () => clock.at,
    logger: { debug: record("debug"), info: record("info"), warn: record("warn"), error: record("error") },
    fetchFunction: runpod.fetchFunction,
    ...(options.storage === undefined ? {} : { storage: options.storage }),
  });
  const advance = (minutes: number) => void (clock.at += minutes * MINUTE);
  const patches = () => runpod.calls.filter((call) => call.method === "PATCH");
  const stateOf = (name: string) => guard.state().find((tier) => tier.tier === name);
  return { runpod, lines, guard, advance, patches, stateOf, clock };
}

const running = (id = "w1") => [{ id, status: "RUNNING" }];

afterEach(() => vi.useRealTimers());

describe("the stuck worker signal", () => {
  it("does not trip before stuckMinutes, and trips after, with a PATCH that sets max 0 and keeps the idle timeout", async () => {
    const { guard, runpod, advance, patches, stateOf, lines } = make();
    runpod.tiers[A.id]!.workers = running();
    runpod.tiers[A.id]!.live = { min: 1, max: 3, idleTimeout: 30 };
    await guard.checkWorkers();
    advance(5);
    await guard.checkWorkers();
    advance(10);
    await guard.checkWorkers();
    expect(patches()).toHaveLength(0);
    advance(1);
    await guard.checkWorkers();
    expect(patches()).toHaveLength(1);
    expect(patches()[0]).toMatchObject({ url: `${RUNPOD_REST_URL}/serverless/${A.id}`, authorization: `Bearer ${KEY}`, body: { workers: { min: 0, max: 0, idleTimeout: 30 } } });
    expect(stateOf("gpu-24gb")).toMatchObject({ state: "tripped", tripsLast24h: 1, lastTrip: { signal: "stuck-worker" }, until: new Date(START + 16 * MINUTE + 10 * MINUTE).toISOString() });
    expect(stateOf("gpu-24gb")?.lastTrip?.evidence).toContain("worker w1 running for 16 minutes");
    expect(stateOf("gpu-48gb")).toMatchObject({ state: "ok", until: null, lastTrip: null });
    expect(lines.filter((line) => line.startsWith("error gpu_guard_tripped"))).toHaveLength(1);
    expect(lines.join("\n")).toContain('"tier":"gpu-24gb"');
    expect(lines.join("\n")).toContain('"endpointId":"aaa111"');
    expect(lines.join("\n")).not.toContain(KEY);
  });

  it("is cleared by a gap: a worker that is gone or idle at one check starts again from zero", async () => {
    const { guard, runpod, advance, patches } = make();
    const tier = runpod.tiers[A.id]!;
    tier.workers = running();
    await guard.checkWorkers();
    advance(10);
    tier.workers = [{ id: "w1", status: "IDLE" }];
    await guard.checkWorkers();
    advance(10);
    tier.workers = running();
    await guard.checkWorkers();
    advance(10);
    await guard.checkWorkers();
    expect(patches()).toHaveLength(0);
    advance(6);
    tier.workers = [];
    await guard.checkWorkers();
    advance(30);
    tier.workers = running();
    await guard.checkWorkers();
    expect(patches()).toHaveLength(0);
  });

  it("counts RUNNING, INITIALIZING and UNHEALTHY in any case, and not IDLE, THROTTLED or EXITED", async () => {
    for (const [status, trips] of [["RUNNING", 1], ["initializing", 1], ["Unhealthy", 1], ["IDLE", 0], ["THROTTLED", 0], ["EXITED", 0]] as const) {
      const { guard, runpod, advance, patches } = make();
      runpod.tiers[A.id]!.workers = [{ id: "w", status }];
      await guard.checkWorkers();
      advance(16);
      await guard.checkWorkers();
      expect(patches(), status).toHaveLength(trips);
    }
  });

  it("skips entries that are not workers and logs a list that is missing", async () => {
    const { guard, runpod, advance, patches, lines } = make();
    runpod.tiers[A.id]!.workers = [null, { id: 7, status: "RUNNING" }, { id: "w", status: 3 }] as never;
    runpod.tiers[B.id]!.workers = "broken";
    await guard.checkWorkers();
    advance(20);
    await guard.checkWorkers();
    expect(patches()).toHaveLength(0);
    expect(lines.filter((line) => line.includes("gpu_guard_check_failed") && line.includes("worker list is missing"))).toHaveLength(2);
  });

  it("one tier failing does not stop another, and the failure text has the problem but not the key", async () => {
    const { guard, runpod, advance, patches, lines } = make();
    runpod.tiers[A.id]!.getStatus = 401;
    runpod.tiers[B.id]!.workers = running();
    await guard.checkWorkers();
    advance(16);
    await guard.checkWorkers();
    expect(patches()).toHaveLength(1);
    expect(patches()[0]?.url).toContain(B.id);
    expect(lines.some((line) => line.includes("gpu_guard_check_failed") && line.includes("RunPod answered 401: Unauthorized: bad key") && line.includes("gpu-24gb"))).toBe(true);
    runpod.tiers[A.id]!.down = true;
    await guard.checkWorkers();
    expect(lines.some((line) => line.includes('"reason":"TypeError"'))).toBe(true);
    expect(lines.join("\n")).not.toContain(KEY);
  });

  it("a failed PATCH is logged, the tier is not marked tripped, and the next check tries again", async () => {
    const { guard, runpod, advance, patches, stateOf, lines } = make();
    const tier = runpod.tiers[A.id]!;
    tier.workers = running();
    await guard.checkWorkers();
    advance(16);
    tier.patchStatus = 400;
    await guard.checkWorkers();
    expect(stateOf("gpu-24gb")).toMatchObject({ state: "ok", tripsLast24h: 0 });
    expect(lines.some((line) => line.includes("gpu_guard_check_failed") && line.includes("RunPod answered 400: Bad Request: nope"))).toBe(true);
    tier.patchStatus = 200;
    advance(5);
    await guard.checkWorkers();
    expect(patches()).toHaveLength(2);
    expect(stateOf("gpu-24gb")?.state).toBe("tripped");
  });

  it("refuses an endpoint answer without worker counts", async () => {
    const { guard, runpod, advance, patches, lines } = make();
    runpod.tiers[A.id]!.workers = running();
    runpod.tiers[A.id]!.live = { min: 0, max: 1 } as never;
    await guard.checkWorkers();
    advance(16);
    await guard.checkWorkers();
    expect(patches()).toHaveLength(0);
    expect(lines.some((line) => line.includes("no workers min, max and idleTimeout"))).toBe(true);
  });
});

describe("the spend signal", () => {
  const hour = (startTime: string, totalAmount: unknown, serverlessId: string = A.id) => ({ startTime, endTime: startTime, serverlessId, totalAmount });

  it("asks for the last 3 hours of one endpoint, trips on a completed hour above the limit and not on one at or below it", async () => {
    const { guard, runpod, patches, stateOf } = make();
    runpod.tiers[A.id]!.records = [hour("2026-11-17T09:00:00Z", 0.5), hour("2026-11-17T10:00:00Z", 0.51), hour("2026-11-17T11:00:00Z", 0.1)];
    runpod.tiers[B.id]!.records = [hour("2026-11-17T11:00:00Z", 0.2, B.id)];
    await guard.checkSpend();
    const read = runpod.calls.find((call) => call.url.includes("/billing/serverless"))!;
    const query = new URL(read.url).searchParams;
    expect(read.method).toBe("GET");
    expect(read.url.startsWith(`${RUNPOD_REST_URL}/billing/serverless?`)).toBe(true);
    expect(query.get("bucketSize")).toBe("hour");
    expect(query.get("startTime")).toBe("2026-11-17T09:30:00.000Z");
    expect(query.get("endTime")).toBe("2026-11-17T12:30:00.000Z");
    expect(patches()).toHaveLength(1);
    expect(patches()[0]?.body).toEqual({ workers: { min: 0, max: 0, idleTimeout: 5 } });
    expect(stateOf("gpu-24gb")).toMatchObject({ state: "tripped", lastTrip: { signal: "spend", evidence: "hour 2026-11-17T10:00:00Z billed $0.51" } });
    expect(stateOf("gpu-48gb")?.state).toBe("ok");
  });

  it("keeps only the records of the tier's own endpoint, and skips a record without a serverlessId", async () => {
    const { guard, runpod, patches, stateOf } = make();
    runpod.tiers[A.id]!.records = [hour("2026-11-17T10:00:00Z", 9, B.id), { startTime: "2026-11-17T09:00:00Z", totalAmount: 9 }, hour("2026-11-17T11:00:00Z", 0.2)];
    await guard.checkSpend();
    expect(patches()).toHaveLength(0);
    expect(stateOf("gpu-24gb")?.state).toBe("ok");
  });

  it("adds the records of one hour together before it compares with the limit", async () => {
    const { guard, runpod, patches, stateOf } = make();
    runpod.tiers[A.id]!.records = [hour("2026-11-17T10:00:00Z", 0.3), hour("2026-11-17T10:00:00Z", 0.3), hour("2026-11-17T11:00:00Z", 0.2), hour("2026-11-17T11:00:00Z", 0.2)];
    await guard.checkSpend();
    expect(patches()).toHaveLength(1);
    expect(stateOf("gpu-24gb")?.lastTrip?.evidence).toBe("hour 2026-11-17T10:00:00Z billed $0.60");
  });

  it("names the dearest hour as the evidence when several are over the limit", async () => {
    const { guard, runpod, stateOf } = make();
    runpod.tiers[A.id]!.records = [hour("2026-11-17T09:00:00Z", 0.7), hour("2026-11-17T10:00:00Z", 1.2), hour("2026-11-17T11:00:00Z", 0.9)];
    await guard.checkSpend();
    expect(stateOf("gpu-24gb")?.lastTrip?.evidence).toBe("hour 2026-11-17T10:00:00Z billed $1.20");
  });

  it("does not judge an hour that is not over, and judges each hour once", async () => {
    const { guard, runpod, advance, patches, stateOf } = make();
    const tier = runpod.tiers[A.id]!;
    tier.records = [hour("2026-11-17T12:00:00Z", 0.9)];
    await guard.checkSpend();
    expect(patches()).toHaveLength(0);
    advance(31);
    await guard.checkSpend();
    expect(patches()).toHaveLength(1);
    // Put back after the cool-down; the same hour, still listed, does not trip again.
    advance(11);
    await guard.checkWorkers();
    expect(stateOf("gpu-24gb")?.state).toBe("ok");
    await guard.checkSpend();
    expect(patches()).toHaveLength(2);
    expect(patches()[1]?.body).toEqual({ workers: { min: 0, max: 1, idleTimeout: 5 } });
  });

  it("a tier that is already stopped is not stopped again, and the hour is judged", async () => {
    const { guard, runpod, advance, patches } = make();
    const tier = runpod.tiers[A.id]!;
    tier.records = [hour("2026-11-17T10:00:00Z", 0.9)];
    await guard.checkSpend();
    expect(patches()).toHaveLength(1);
    tier.records = [hour("2026-11-17T10:00:00Z", 0.9), hour("2026-11-17T11:00:00Z", 2)];
    await guard.checkSpend();
    expect(patches()).toHaveLength(1);
    advance(11);
    await guard.checkWorkers();
    expect(patches()).toHaveLength(2);
    tier.records = [hour("2026-11-17T11:00:00Z", 2)];
    await guard.checkSpend();
    expect(patches()).toHaveLength(2);
  });

  it("a failed PATCH leaves the hour unjudged so the next check trips", async () => {
    const { guard, runpod, patches } = make();
    const tier = runpod.tiers[A.id]!;
    tier.records = [hour("2026-11-17T10:00:00Z", 0.9)];
    tier.patchStatus = 500;
    await guard.checkSpend();
    tier.patchStatus = 200;
    await guard.checkSpend();
    expect(patches()).toHaveLength(2);
    expect(tier.live.max).toBe(0);
  });

  it("skips records without a usable start or amount, and logs an answer without records or with an error", async () => {
    const { guard, runpod, patches, lines } = make();
    runpod.tiers[A.id]!.records = [null, hour("not a time", 9), { startTime: 5, totalAmount: 9 }, hour("2026-11-17T10:00:00Z", "9"), hour("2026-11-17T10:00:00Z", Number.NaN)];
    runpod.tiers[B.id]!.records = { nothing: true };
    await guard.checkSpend();
    expect(patches()).toHaveLength(0);
    expect(lines.filter((line) => line.includes("gpu_guard_spend_unread") && line.includes("no list of records"))).toHaveLength(1);
    runpod.tiers[B.id]!.getStatus = 503;
    await guard.checkSpend();
    expect(lines.some((line) => line.includes("gpu_guard_spend_unread") && line.includes("RunPod answered 503"))).toBe(true);
    expect(lines.join("\n")).not.toContain(KEY);
  });
});

describe("restore, hold and release", () => {
  /** Trips tier A by a stuck worker at the start of the clock. */
  async function tripped(settings: Partial<GpuGuardSettings> = {}) {
    const made = make({ settings });
    const tier = made.runpod.tiers[A.id]!;
    tier.live = { min: 1, max: 3, idleTimeout: 30 };
    tier.workers = running();
    await made.guard.checkWorkers();
    made.advance(16);
    await made.guard.checkWorkers();
    expect(tier.live.max).toBe(0);
    return { ...made, tier };
  }

  it("restores the remembered workers after the cool-down, and not before", async () => {
    const { guard, advance, patches, tier, stateOf, lines } = await tripped();
    advance(9);
    await guard.checkWorkers();
    expect(patches()).toHaveLength(1);
    // While stopped, the worker list is not read.
    expect(tier.live.max).toBe(0);
    advance(1);
    await guard.checkWorkers();
    expect(tier.live).toEqual({ min: 1, max: 3, idleTimeout: 30 });
    expect(stateOf("gpu-24gb")).toMatchObject({ state: "ok", until: null, tripsLast24h: 1 });
    expect(lines.some((line) => line.startsWith("info gpu_guard_restored"))).toBe(true);
  });

  it("does not restore when someone else changed max, and forgets what it remembered", async () => {
    const { guard, advance, patches, tier, stateOf, lines } = await tripped();
    tier.live = { min: 0, max: 2, idleTimeout: 5 };
    advance(10);
    await guard.checkWorkers();
    expect(patches()).toHaveLength(1);
    expect(tier.live.max).toBe(2);
    expect(stateOf("gpu-24gb")?.state).toBe("ok");
    expect(lines.some((line) => line.includes("gpu_guard_overridden"))).toBe(true);
  });

  it("a failed restore is tried again at the next check", async () => {
    const { guard, advance, patches, tier, stateOf } = await tripped();
    advance(10);
    tier.patchStatus = 500;
    await guard.checkWorkers();
    expect(stateOf("gpu-24gb")?.state).toBe("tripped");
    tier.patchStatus = 200;
    advance(5);
    await guard.checkWorkers();
    expect(patches()).toHaveLength(3);
    expect(tier.live.max).toBe(3);
  });

  it("holds the trip that makes maxTripsPerDay in 24 hours, logs it, and does not restore it", async () => {
    const { guard, advance, patches, tier, stateOf, lines } = await tripped();
    advance(10);
    await guard.checkWorkers();
    expect(tier.live.max).toBe(3);
    tier.workers = running();
    await guard.checkWorkers();
    advance(16);
    await guard.checkWorkers();
    expect(stateOf("gpu-24gb")).toMatchObject({ state: "held", until: null, tripsLast24h: 2 });
    expect(lines.filter((line) => line.startsWith("error gpu_guard_held"))).toHaveLength(1);
    const before = patches().length;
    advance(120);
    await guard.checkWorkers();
    expect(patches()).toHaveLength(before);
    expect(tier.live.max).toBe(0);
    expect(stateOf("gpu-24gb")?.state).toBe("held");
  });

  it("releases a held tier when its live max is above 0 again", async () => {
    const { guard, advance, tier, stateOf, lines } = await tripped({ maxTripsPerDay: 1 });
    expect(stateOf("gpu-24gb")?.state).toBe("held");
    advance(61);
    await guard.checkWorkers();
    expect(stateOf("gpu-24gb")?.state).toBe("held");
    tier.live = { min: 0, max: 1, idleTimeout: 5 };
    advance(61);
    await guard.checkWorkers();
    expect(stateOf("gpu-24gb")).toMatchObject({ state: "ok", lastTrip: { signal: "stuck-worker" } });
    expect(lines.some((line) => line.startsWith("info gpu_guard_released"))).toBe(true);
    // Watching again: a new stuck worker trips as before.
    tier.workers = running("w2");
    await guard.checkWorkers();
    advance(16);
    await guard.checkWorkers();
    expect(stateOf("gpu-24gb")?.state).toBe("held");
  });

  it("reads a held tier's endpoint only every spendCheckSeconds, not at every worker check", async () => {
    const { guard, runpod, advance } = await tripped({ maxTripsPerDay: 1 });
    const reads = () => runpod.calls.filter((call) => call.method === "GET" && call.url.endsWith(`/serverless/${A.id}`)).length;
    const before = reads();
    for (let check = 0; check < 6; check += 1) {
      advance(5);
      await guard.checkWorkers();
    }
    expect(reads()).toBe(before);
    advance(31);
    await guard.checkWorkers();
    expect(reads()).toBe(before + 1);
    advance(5);
    await guard.checkWorkers();
    expect(reads()).toBe(before + 1);
    advance(55);
    await guard.checkWorkers();
    expect(reads()).toBe(before + 2);
  });

  it("counts only the trips of the last 24 hours", async () => {
    const { guard, advance, tier, stateOf } = await tripped();
    advance(24 * 60);
    expect(stateOf("gpu-24gb")?.tripsLast24h).toBe(0);
    await guard.checkWorkers();
    tier.workers = running();
    await guard.checkWorkers();
    advance(16);
    await guard.checkWorkers();
    expect(stateOf("gpu-24gb")).toMatchObject({ state: "tripped", tripsLast24h: 1 });
  });
});

describe("a restart", () => {
  /** A guard on a shared database and clock, and the same again after a restart: a new guard on the same storage. */
  function restartable(settings: Partial<GpuGuardSettings> = {}) {
    const storage = openStorage(":memory:");
    const runpod = fakeRunpod();
    const clock = { at: START };
    const first = make({ storage, runpod, clock, settings });
    const second = () => make({ storage, runpod, clock, settings });
    return { storage, runpod, clock, first, second };
  }
  const trip = async (guard: ReturnType<typeof make>) => {
    guard.runpod.tiers[A.id]!.workers = running();
    guard.runpod.tiers[A.id]!.live = { min: 1, max: 3, idleTimeout: 30 };
    await guard.guard.checkWorkers();
    guard.advance(16);
    await guard.guard.checkWorkers();
  };

  it("continues a cool-down and restores the remembered workers after it", async () => {
    const { runpod, first, second } = restartable();
    await trip(first);
    expect(runpod.tiers[A.id]!.live.max).toBe(0);
    const again = second();
    expect(again.stateOf("gpu-24gb")).toMatchObject({ state: "tripped", tripsLast24h: 1, lastTrip: { signal: "stuck-worker" } });
    again.advance(5);
    await again.guard.checkWorkers();
    expect(runpod.tiers[A.id]!.live.max).toBe(0);
    again.advance(6);
    await again.guard.checkWorkers();
    expect(runpod.tiers[A.id]!.live).toEqual({ min: 1, max: 3, idleTimeout: 30 });
    expect(again.stateOf("gpu-24gb")?.state).toBe("ok");
    expect(second().stateOf("gpu-24gb")).toMatchObject({ state: "ok", tripsLast24h: 1 });
  });

  it("keeps a hold, and keeps counting trips so a restart does not bypass maxTripsPerDay", async () => {
    const { runpod, first, second } = restartable({ maxTripsPerDay: 2 });
    await trip(first);
    runpod.tiers[A.id]!.live = { min: 1, max: 3, idleTimeout: 30 };
    first.advance(11);
    await first.guard.checkWorkers();
    const again = second();
    expect(again.stateOf("gpu-24gb")).toMatchObject({ state: "ok", tripsLast24h: 1 });
    await trip(again);
    expect(again.stateOf("gpu-24gb")).toMatchObject({ state: "held", tripsLast24h: 2 });
    const held = second();
    expect(held.stateOf("gpu-24gb")).toMatchObject({ state: "held", until: null });
    held.advance(120);
    await held.guard.checkWorkers();
    expect(runpod.tiers[A.id]!.live.max).toBe(0);
  });

  it("does not trip again after a restart on an hour it already judged", async () => {
    const { runpod, first, second } = restartable();
    runpod.tiers[A.id]!.records = [{ startTime: "2026-11-17T11:00:00Z", endTime: "2026-11-17T11:00:00Z", serverlessId: A.id, totalAmount: 0.9 }];
    await first.guard.checkSpend();
    expect(first.patches()).toHaveLength(1);
    first.advance(11);
    await first.guard.checkWorkers();
    expect(runpod.tiers[A.id]!.live.max).toBe(1);
    // The trip and the restore are two PATCHes on the shared RunPod double; no third one after the restart.
    expect(first.patches()).toHaveLength(2);
    const again = second();
    await again.guard.checkSpend();
    expect(again.patches()).toHaveLength(2);
    expect(again.stateOf("gpu-24gb")).toMatchObject({ state: "ok", tripsLast24h: 1 });
  });

  it("reads a row saved before the judged hours were kept", async () => {
    const { storage, second } = restartable();
    const row = { zeroed: null, held: false, trips: [START - 60 * MINUTE], last: { at: START - 60 * MINUTE, signal: "spend", evidence: "hour x billed $0.90" } };
    storage.database.prepare("INSERT INTO gpu_guard_state (endpoint_id, state) VALUES (?, ?)").run(A.id, JSON.stringify(row));
    expect(second().stateOf("gpu-24gb")).toMatchObject({ state: "ok", tripsLast24h: 1, lastTrip: { signal: "spend" } });
  });

  it("logs a saved row it cannot read and a failed write, and goes on", async () => {
    const { storage, first, second } = restartable();
    storage.database.prepare("INSERT INTO gpu_guard_state (endpoint_id, state) VALUES (?, ?)").run(A.id, "not json");
    const again = second();
    expect(again.stateOf("gpu-24gb")?.state).toBe("ok");
    expect(again.lines.some((line) => line.startsWith("warn gpu_guard_state_unreadable"))).toBe(true);
    storage.database.exec("DROP TABLE gpu_guard_state");
    await trip(first);
    expect(first.stateOf("gpu-24gb")?.state).toBe("tripped");
    expect(first.lines.some((line) => line.startsWith("warn gpu_guard_state_unsaved"))).toBe(true);
  });
});

describe("answers that are not what RunPod documents", () => {
  const guardWith = (answer: () => Response) => {
    const lines: string[] = [];
    const log = (event: string, fields?: unknown) => void lines.push(`${event} ${JSON.stringify(fields)}`);
    const guard = createGpuGuard({ endpoints: [A], settings: SETTINGS, now: () => START, logger: { debug: log, info: log, warn: log, error: log }, fetchFunction: () => (async () => answer()) as typeof fetch });
    return { guard, lines };
  };

  it("logs a status without a problem document, and a body that is not JSON or is null, for both checks", async () => {
    const down = guardWith(() => new Response("<html>bad gateway</html>", { status: 502 }));
    await down.guard.checkWorkers();
    await down.guard.checkSpend();
    expect(down.lines).toEqual([expect.stringContaining('"reason":"RunPod answered 502"'), expect.stringContaining('"reason":"RunPod answered 502"')]);
    const empty = guardWith(() => new Response("null"));
    await empty.guard.checkWorkers();
    await empty.guard.checkSpend();
    expect(empty.lines.map((line) => line.split(" ")[0])).toEqual(["gpu_guard_check_failed", "gpu_guard_spend_unread"]);
  });

  it("refuses a stopped tier's endpoint that has no workers object", async () => {
    const lines: string[] = [];
    const log = (event: string, fields?: unknown) => void lines.push(`${event} ${JSON.stringify(fields)}`);
    let live: unknown = { workers: { min: 0, max: 1, idleTimeout: 5 } };
    const clock = { at: START };
    const guard = createGpuGuard({
      endpoints: [A],
      settings: SETTINGS,
      now: () => clock.at,
      logger: { debug: log, info: log, warn: log, error: log },
      fetchFunction: () => (async (input: string, init?: RequestInit) => (String(input).endsWith("/workers") ? Response.json({ workers: [{ id: "w", status: "RUNNING" }] }) : init?.method === "PATCH" ? Response.json({}) : Response.json(live))) as typeof fetch,
    });
    await guard.checkWorkers();
    clock.at += 16 * MINUTE;
    await guard.checkWorkers();
    clock.at += 10 * MINUTE;
    live = { workers: null };
    await guard.checkWorkers();
    expect(lines.some((line) => line.startsWith("gpu_guard_check_failed") && line.includes("no workers min, max and idleTimeout"))).toBe(true);
    expect(guard.state()[0]?.state).toBe("tripped");
  });
});

describe("a 429 from RunPod", () => {
  const callsOf = (runpod: ReturnType<typeof fakeRunpod>, id: string) => runpod.calls.filter((call) => call.url.includes(id)).length;

  it("backs the tier off for backoffSeconds, skipping every call of both checks, and logs one warn per back-off", async () => {
    const { guard, runpod, advance, lines } = make();
    runpod.tiers[A.id]!.getStatus = 429;
    await guard.checkWorkers();
    await guard.checkSpend();
    expect(callsOf(runpod, A.id)).toBe(1);
    for (let check = 0; check < 2; check += 1) {
      advance(5);
      await guard.checkWorkers();
      await guard.checkSpend();
    }
    expect(callsOf(runpod, A.id)).toBe(1);
    expect(lines.filter((line) => line.includes("gpu_guard_rate_limited"))).toHaveLength(1);
    expect(lines.filter((line) => line.startsWith("warn gpu_guard_rate_limited"))[0]).toContain('"backoffSeconds":900');
    expect(lines.some((line) => line.includes("gpu_guard_check_failed") && line.includes("gpu-24gb"))).toBe(false);
    // The other tier is not held back.
    expect(callsOf(runpod, B.id)).toBeGreaterThanOrEqual(3);
    // After the back-off the tier is read again; a second 429 starts a second back-off with its own warn.
    advance(11);
    await guard.checkWorkers();
    expect(callsOf(runpod, A.id)).toBe(2);
    expect(lines.filter((line) => line.includes("gpu_guard_rate_limited"))).toHaveLength(2);
    runpod.tiers[A.id]!.getStatus = 200;
    advance(16);
    await guard.checkWorkers();
    expect(callsOf(runpod, A.id)).toBe(3);
    expect(lines.join("\n")).not.toContain(KEY);
  });

  it("uses Retry-After when RunPod sends it, and never waits longer than an hour", async () => {
    const { guard, runpod, advance } = make();
    runpod.tiers[A.id]!.getStatus = 429;
    runpod.tiers[A.id]!.retryAfter = "120";
    await guard.checkWorkers();
    advance(1);
    await guard.checkWorkers();
    expect(callsOf(runpod, A.id)).toBe(1);
    advance(1.5);
    await guard.checkWorkers();
    expect(callsOf(runpod, A.id)).toBe(2);
    runpod.tiers[A.id]!.retryAfter = "86400";
    advance(2);
    await guard.checkWorkers();
    expect(callsOf(runpod, A.id)).toBe(3);
    advance(59);
    await guard.checkWorkers();
    expect(callsOf(runpod, A.id)).toBe(3);
    advance(2);
    await guard.checkWorkers();
    expect(callsOf(runpod, A.id)).toBe(4);
  });

  it("backs off on a 429 of the spend check, and of a PATCH, too", async () => {
    const { guard, runpod, advance, lines } = make();
    runpod.tiers[A.id]!.workers = running();
    await guard.checkWorkers();
    advance(16);
    runpod.tiers[A.id]!.patchStatus = 429;
    await guard.checkWorkers();
    expect(lines.filter((line) => line.includes("gpu_guard_rate_limited"))).toHaveLength(1);
    const before = callsOf(runpod, A.id);
    await guard.checkSpend();
    expect(callsOf(runpod, A.id)).toBe(before);
  });
});

describe("start and stop", () => {
  it("checks at once and on both intervals, never overlaps, and stop waits for the check in flight", async () => {
    vi.useFakeTimers();
    const { guard, runpod } = make({ settings: { checkSeconds: 10, spendCheckSeconds: 100 } });
    const handle = guard.start();
    await vi.advanceTimersByTimeAsync(0);
    const count = (part: string) => runpod.calls.filter((call) => call.url.includes(part)).length;
    expect(count("/workers")).toBe(2);
    expect(count("/billing/serverless")).toBe(2);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(count("/workers")).toBe(4);
    await vi.advanceTimersByTimeAsync(90_000);
    expect(count("/billing/serverless")).toBe(4);
    await handle.stop();
    const total = runpod.calls.length;
    await vi.advanceTimersByTimeAsync(500_000);
    expect(runpod.calls).toHaveLength(total);
  });

  it("uses the first 6 characters of the endpoint identifier when it has no label, and the global fetch and default address", async () => {
    const calls: string[] = [];
    vi.stubGlobal("fetch", async (input: string) => {
      calls.push(String(input));
      return Response.json({ workers: [] });
    });
    try {
      const guard = createGpuGuard({ endpoints: [{ id: "zzz999yyy888", apiKey: KEY }], settings: SETTINGS, now: () => START, logger: { debug() {}, info() {}, warn() {}, error() {} }, restUrl: `${RUNPOD_REST_URL}/` });
      await guard.checkWorkers();
      expect(guard.state()[0]?.tier).toBe("zzz999");
      expect(calls).toEqual([`${RUNPOD_REST_URL}/serverless/zzz999yyy888/workers`]);
    } finally {
      vi.unstubAllGlobals();
    }
  });
});
