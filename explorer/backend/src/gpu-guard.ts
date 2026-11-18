/**
 * The GPU spend guard. It stops a RunPod tier that leaks, without stopping the other tiers, so testnet keeps proving
 * (docs/superpowers/specs/2026-11-17-gpu-spend-guard-design.md). A tier is one configured RunPod endpoint. Two signals trip it:
 * a worker that stays in a billed, busy state (`RUNNING`, `INITIALIZING`, `UNHEALTHY`) at every check for longer than
 * `stuckMinutes` (read from `GET /v2/serverless/{id}/workers` every `checkSeconds`), and a completed hour whose bill is
 * above `maxUsdPerHour` (read from `GET /v2/billing/serverless` every `spendCheckSeconds`). A trip reads the endpoint,
 * remembers its `workers` and sets `{ min: 0, max: 0, idleTimeout }` with `PATCH /v2/serverless/{id}`, which ends the
 * stuck worker. After `cooldownMinutes` the remembered `workers` are put back, but only when the endpoint still reads
 * `max: 0` (a change by someone else wins). The trip that makes `maxTripsPerDay` trips in 24 hours is not restored: the
 * tier is held at 0 until its live `max` is seen above 0 again (the owner ran `deploy/runpod/apply.mjs --apply`).
 * `deploy/runpod/endpoints.json` stays the owner of the worker counts; this is an emergency override.
 *
 * The state of each tier (`zeroed` with the workers to put back and when, `held`, the trips of the last 24 hours and the
 * last trip) is kept in the backend database (`gpu_guard_state`) when a `storage` is given, written after every trip,
 * restore, release and hold and read when the guard is created. A restart in a cool-down continues it, a hold stays,
 * and the trips keep counting. A failed write is logged and does not stop the guard.
 *
 * Every call goes to REST v2. It never throws and never blocks start-up; a failed read or write of one tier is logged
 * and retried at the next check, and does not stop the other tiers. A tier is never marked tripped unless the PATCH
 * worked. The key travels in the Authorization header only, and no log line holds it.
 */
import { RUNPOD_REST_URL, problemText, type BillingEndpoint } from "./billing.ts";
import type { Logger } from "./logger.ts";
import type { Storage } from "./storage.ts";

/** The longest wait for one RunPod answer, in milliseconds. */
export const GUARD_TIMEOUT_MILLISECONDS = 10_000;

/** The settings of `gpuGuard` in the backend configuration. */
export type GpuGuardSettings = {
  readonly enabled: boolean;
  readonly checkSeconds: number;
  readonly stuckMinutes: number;
  readonly spendCheckSeconds: number;
  readonly maxUsdPerHour: number;
  readonly cooldownMinutes: number;
  readonly maxTripsPerDay: number;
};

/** The state of one tier, for the private billing figures. */
export type GpuGuardTierState = {
  readonly tier: string;
  /** The first 6 characters of the endpoint identifier. */
  readonly endpointId: string;
  /** `ok`; `tripped` (set to 0 workers until `until`); `held` (set to 0 workers, not restored on its own). */
  readonly state: "ok" | "tripped" | "held";
  /** When a tripped tier is put back (ISO time); null otherwise. */
  readonly until: string | null;
  readonly lastTrip: { readonly at: string; readonly signal: "stuck-worker" | "spend"; readonly evidence: string } | null;
  readonly tripsLast24h: number;
};

export interface GpuGuard {
  /** Checks the workers of every tier once, and puts back or releases the tiers it stopped. Never throws. */
  checkWorkers(): Promise<void>;
  /** Checks the last completed hours of the bill of every tier once. Never throws. */
  checkSpend(): Promise<void>;
  /** Checks now, then on the intervals of the settings. `stop` ends the timers and waits for a check in flight. */
  start(): { stop(): Promise<void> };
  /** The state of each tier. */
  state(): GpuGuardTierState[];
}

type Workers = { readonly min: number; readonly max: number; readonly idleTimeout: number };
type Signal = "stuck-worker" | "spend";
type Tier = {
  readonly endpoint: BillingEndpoint;
  readonly name: string;
  /** When each worker was first seen busy, while it has been busy at every check since. */
  busySince: Map<string, number>;
  /** The start times of the hours already judged. */
  judged: Set<string>;
  /** Set when the guard changed the endpoint: what to put back, and when. */
  zeroed: { workers: Workers; restoreAt: number } | null;
  held: boolean;
  trips: number[];
  last: { at: number; signal: Signal; evidence: string } | null;
};

/** The worker states that are billed and busy. */
const BUSY = new Set(["running", "initializing", "unhealthy"]);

/** What is kept of a tier between restarts. `judged` holds the start times of the hours already judged that a spend check
 * can still read, so a restart does not trip a tier again on an hour it has already acted on. */
type SavedTier = Pick<Tier, "zeroed" | "held" | "trips" | "last"> & { judged?: string[] };

const DAY_MILLISECONDS = 86_400_000;
const HOUR_MILLISECONDS = 3_600_000;

/** The text of a failure: our own message, or the name of a network error. It never holds the key. */
function reasonOf(error: unknown): string {
  const { name, message } = error as Error;
  return name === "Error" ? message : name;
}

export function createGpuGuard(input: {
  endpoints: readonly BillingEndpoint[];
  settings: GpuGuardSettings;
  now: () => number;
  logger: Logger;
  fetchFunction?: () => typeof fetch;
  /** The base address of RunPod's REST API v2; {@link RUNPOD_REST_URL} when left out. */
  restUrl?: string;
  timeoutMilliseconds?: number;
  /** Where the state of each tier is kept across restarts; kept in memory only when left out. */
  storage?: Storage;
}): GpuGuard {
  const { settings, logger } = input;
  const timeout = input.timeoutMilliseconds ?? GUARD_TIMEOUT_MILLISECONDS;
  const doFetch = () => (input.fetchFunction ?? (() => fetch))();
  const base = (input.restUrl ?? RUNPOD_REST_URL).replace(/\/+$/, "");
  const tiers: Tier[] = input.endpoints.map((endpoint) => ({
    endpoint,
    name: endpoint.label ?? endpoint.id.slice(0, 6),
    busySince: new Map(),
    judged: new Set(),
    zeroed: null,
    held: false,
    trips: [],
    last: null,
  }));

  /** Puts back the state saved for each tier. A row that cannot be read is logged and the tier starts clean. */
  function load(): void {
    if (input.storage === undefined) return;
    for (const tier of tiers) {
      const row = input.storage.database.prepare("SELECT state FROM gpu_guard_state WHERE endpoint_id = ?").get(tier.endpoint.id) as { state: string } | undefined;
      if (row === undefined) continue;
      try {
        const saved = JSON.parse(row.state) as SavedTier;
        tier.zeroed = saved.zeroed;
        tier.held = saved.held;
        tier.trips = saved.trips;
        tier.last = saved.last;
        tier.judged = new Set(saved.judged ?? []);
        logger.info("gpu_guard_state_loaded", { tier: tier.name, endpointId: tier.endpoint.id.slice(0, 6), state: tier.held ? "held" : tier.zeroed === null ? "ok" : "tripped", tripsLast24h: tier.trips.length });
      } catch (error) {
        logger.warn("gpu_guard_state_unreadable", { tier: tier.name, endpointId: tier.endpoint.id.slice(0, 6), reason: reasonOf(error) });
      }
    }
  }

  /** Writes the state of the tier. A failure is logged; the guard goes on with the state in memory. */
  function save(tier: Tier): void {
    if (input.storage === undefined) return;
    // A spend check reads the last 3 hours; older judged hours can never come back, so they are not kept.
    const readable = input.now() - 4 * HOUR_MILLISECONDS;
    const judged = [...tier.judged].filter((start) => Date.parse(start) >= readable);
    const saved: SavedTier = { zeroed: tier.zeroed, held: tier.held, trips: tier.trips, last: tier.last, judged };
    try {
      input.storage.database.prepare("INSERT OR REPLACE INTO gpu_guard_state (endpoint_id, state) VALUES (?, ?)").run(tier.endpoint.id, JSON.stringify(saved));
    } catch (error) {
      logger.warn("gpu_guard_state_unsaved", { tier: tier.name, endpointId: tier.endpoint.id.slice(0, 6), reason: reasonOf(error) });
    }
  }
  load();

  /** One request to RunPod. @throws Error with the reason (and RunPod's problem text) when it does not answer 2xx. */
  async function call(tier: Tier, path: string, init: { method?: "PATCH"; body?: unknown } = {}): Promise<unknown> {
    const answer = await doFetch()(`${base}${path}`, {
      method: init.method ?? "GET",
      headers: { authorization: `Bearer ${tier.endpoint.apiKey}`, accept: "application/json", ...(init.body === undefined ? {} : { "content-type": "application/json" }) },
      ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }),
      signal: AbortSignal.timeout(timeout),
    });
    const body: unknown = await answer.json().catch(() => null);
    if (!answer.ok) {
      const problem = problemText(body);
      throw new Error(`RunPod answered ${answer.status}${problem === null ? "" : `: ${problem}`}`);
    }
    return body;
  }

  const endpointPath = (tier: Tier) => `/serverless/${encodeURIComponent(tier.endpoint.id)}`;

  /** `workers` of the endpoint now. @throws Error when it cannot be read or has no worker counts. */
  async function readWorkers(tier: Tier): Promise<Workers> {
    const body = (await call(tier, endpointPath(tier))) as { workers?: Partial<Record<keyof Workers, unknown>> | null } | null;
    const { min, max, idleTimeout } = body?.workers ?? {};
    if (typeof min !== "number" || typeof max !== "number" || typeof idleTimeout !== "number") throw new Error("the endpoint has no workers min, max and idleTimeout");
    return { min, max, idleTimeout };
  }

  const writeWorkers = (tier: Tier, workers: Workers) => call(tier, endpointPath(tier), { method: "PATCH", body: { workers } });

  const tripsInLastDay = (tier: Tier) => tier.trips.filter((at) => at > input.now() - DAY_MILLISECONDS).length;

  /** Stops the tier. Not marked tripped unless the PATCH worked. @throws Error when the endpoint cannot be read or changed. */
  async function trip(tier: Tier, signal: Signal, evidence: string): Promise<void> {
    const before = await readWorkers(tier);
    await writeWorkers(tier, { min: 0, max: 0, idleTimeout: before.idleTimeout });
    const at = input.now();
    tier.trips = [...tier.trips.filter((time) => time > at - DAY_MILLISECONDS), at];
    tier.zeroed = { workers: before, restoreAt: at + settings.cooldownMinutes * 60_000 };
    tier.last = { at, signal, evidence };
    tier.busySince.clear();
    logger.error("gpu_guard_tripped", { tier: tier.name, endpointId: tier.endpoint.id.slice(0, 6), signal, evidence, tripsLast24h: tier.trips.length });
    if (tier.trips.length >= settings.maxTripsPerDay) {
      tier.held = true;
      logger.error("gpu_guard_held", { tier: tier.name, endpointId: tier.endpoint.id.slice(0, 6), tripsLast24h: tier.trips.length, detail: "not restored; run deploy/runpod/apply.mjs --apply to set the workers again" });
    }
    save(tier);
  }

  /** The work on a tier the guard stopped: release a hold the owner lifted, or put the workers back after the cool-down. */
  async function settle(tier: Tier, zeroed: NonNullable<Tier["zeroed"]>): Promise<void> {
    if (!tier.held && input.now() < zeroed.restoreAt) return;
    const live = await readWorkers(tier);
    const endpointId = tier.endpoint.id.slice(0, 6);
    if (live.max > 0) {
      const released = tier.held;
      tier.held = false;
      tier.zeroed = null;
      save(tier);
      logger.info(released ? "gpu_guard_released" : "gpu_guard_overridden", { tier: tier.name, endpointId, max: live.max });
      return;
    }
    if (tier.held) return;
    await writeWorkers(tier, zeroed.workers);
    tier.zeroed = null;
    save(tier);
    logger.info("gpu_guard_restored", { tier: tier.name, endpointId, workers: zeroed.workers });
  }

  /** The workers of the tier now: the stuck one, as evidence, when there is one. @throws Error when the list cannot be read. */
  async function stuckWorker(tier: Tier): Promise<string | null> {
    const body = (await call(tier, `${endpointPath(tier)}/workers`)) as { workers?: unknown } | null;
    if (!Array.isArray(body?.workers)) throw new Error("the worker list is missing");
    const at = input.now();
    const busy = new Map<string, number>();
    let stuck: string | null = null;
    for (const worker of body.workers as Array<{ id?: unknown; status?: unknown }>) {
      if (typeof worker?.id !== "string" || typeof worker.status !== "string" || !BUSY.has(worker.status.toLowerCase())) continue;
      const since = tier.busySince.get(worker.id) ?? at;
      busy.set(worker.id, since);
      if (stuck === null && at - since > settings.stuckMinutes * 60_000) stuck = `worker ${worker.id} ${worker.status.toLowerCase()} for ${Math.floor((at - since) / 60_000)} minutes`;
    }
    tier.busySince = busy;
    return stuck;
  }

  async function guarded(tier: Tier, work: () => Promise<void>, event: string): Promise<void> {
    try {
      await work();
    } catch (error) {
      logger.warn(event, { tier: tier.name, endpointId: tier.endpoint.id.slice(0, 6), reason: reasonOf(error) });
    }
  }

  async function checkTier(tier: Tier): Promise<void> {
    if (tier.zeroed !== null) return settle(tier, tier.zeroed);
    const stuck = await stuckWorker(tier);
    if (stuck !== null) await trip(tier, "stuck-worker", stuck);
  }

  /** The completed hours of the last 3 that were not judged and are over the limit, with the dearest first, from the records of this tier's endpoint (a record without its `serverlessId` is skipped, like `parseBillingRows`). @throws Error when the bill cannot be read. */
  async function dearHours(tier: Tier): Promise<Array<{ start: string; amountUsd: number }>> {
    const at = input.now();
    const query = new URLSearchParams({ serverlessId: tier.endpoint.id, bucketSize: "hour", startTime: new Date(at - 3 * HOUR_MILLISECONDS).toISOString(), endTime: new Date(at).toISOString() });
    const body = (await call(tier, `/billing/serverless?${query.toString()}`)) as { records?: unknown } | null;
    if (!Array.isArray(body?.records)) throw new Error("the billing answer has no list of records");
    // The tier's own records only, and the records of one hour added together: the bill of an hour is their sum.
    const perHour = new Map<string, number>();
    for (const record of body.records as Array<{ startTime?: unknown; serverlessId?: unknown; totalAmount?: unknown }>) {
      const { startTime, serverlessId, totalAmount } = record ?? {};
      if (serverlessId !== tier.endpoint.id || typeof startTime !== "string" || typeof totalAmount !== "number" || !Number.isFinite(totalAmount)) continue;
      perHour.set(startTime, (perHour.get(startTime) ?? 0) + totalAmount);
    }
    const over: Array<{ start: string; amountUsd: number }> = [];
    for (const [startTime, amountUsd] of perHour) {
      const started = Date.parse(startTime);
      // An hour that is not over is still growing: it is judged when it is.
      if (Number.isNaN(started) || started + HOUR_MILLISECONDS > at || tier.judged.has(startTime)) continue;
      if (amountUsd > settings.maxUsdPerHour) over.push({ start: startTime, amountUsd });
      else tier.judged.add(startTime);
    }
    return over.sort((a, b) => b.amountUsd - a.amountUsd);
  }

  async function spendOfTier(tier: Tier): Promise<void> {
    const over = await dearHours(tier);
    const [worst] = over;
    // A tier that is already stopped is not stopped again; the hour is judged.
    if (worst !== undefined && tier.zeroed === null) await trip(tier, "spend", `hour ${worst.start} billed $${worst.amountUsd.toFixed(2)}`);
    for (const hour of over) tier.judged.add(hour.start);
    // The hours judged in this check, kept across a restart.
    save(tier);
  }

  let running = Promise.resolve();
  const guard: GpuGuard = {
    async checkWorkers() {
      await Promise.all(tiers.map((tier) => guarded(tier, () => checkTier(tier), "gpu_guard_check_failed")));
    },
    async checkSpend() {
      await Promise.all(tiers.map((tier) => guarded(tier, () => spendOfTier(tier), "gpu_guard_spend_unread")));
    },
    start() {
      const queue = (work: () => Promise<void>) => void (running = running.then(work));
      const workers = () => queue(() => guard.checkWorkers());
      const spend = () => queue(() => guard.checkSpend());
      workers();
      spend();
      const timers = [setInterval(workers, settings.checkSeconds * 1000), setInterval(spend, settings.spendCheckSeconds * 1000)];
      for (const timer of timers) timer.unref();
      return {
        async stop() {
          for (const timer of timers) clearInterval(timer);
          await running;
        },
      };
    },
    state() {
      return tiers.map((tier) => ({
        tier: tier.name,
        endpointId: tier.endpoint.id.slice(0, 6),
        state: tier.held ? "held" : tier.zeroed === null ? "ok" : "tripped",
        until: tier.zeroed === null || tier.held ? null : new Date(tier.zeroed.restoreAt).toISOString(),
        lastTrip: tier.last === null ? null : { at: new Date(tier.last.at).toISOString(), signal: tier.last.signal, evidence: tier.last.evidence },
        tripsLast24h: tripsInLastDay(tier),
      }));
    },
  };
  return guard;
}
