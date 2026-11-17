/**
 * What RunPod billed, read from RunPod's own billing API: the per-day and per-hour serverless billing
 * (`GET api.runpod.io/v2/billing/serverless`, REST v2), the cold starts per endpoint of the last 24 hours
 * (`GET /v2/serverless/{id}/metrics/cold-starts`) and the account balance (GraphQL `myself`, because REST v2 has no
 * balance read). One request per bucket size and key returns the records of every endpoint of the account, each with its
 * `serverlessId`; the reader keeps the records of the configured endpoints. A record carries the amounts (`totalAmount`,
 * `gpuAmount`, `diskAmount`) and no billed time, so a bucket holds dollars only: the billed seconds and the effective
 * rate of RunPod's bill are unknown, and the code prices our own seconds at the configured GPU price. One cached reader serves every
 * page view, so a request to `/billing` never reaches RunPod. The refresh and retry times are in the configuration
 * (`billing`). A failed refresh keeps the last good value and the age of it; a 429 (RunPod's request limit) waits
 * for the next refresh. An error answer is an RFC 9457 problem document; its `title` and `detail` go into the log reason.
 * The key is read from the environment by the caller, sent only in the Authorization header, and never logged.
 */
import { remoteEndpoints, type BackendConfig, type BackendSecrets } from "./config.ts";
import type { Logger } from "./logger.ts";
import type { GpuGuardTierState } from "./gpu-guard.ts";

/** The base address of RunPod's REST API v2. `createBillingReader` takes another one in `restUrl`. */
export const RUNPOD_REST_URL = "https://api.runpod.io/v2";
export const BILLING_URL = `${RUNPOD_REST_URL}/billing/serverless`;
export const GRAPHQL_URL = "https://api.runpod.io/graphql";
const BALANCE_QUERY = "query { myself { clientBalance currentSpendPerHr spendLimit } }";

/** How long one reading serves the page views, in milliseconds. The configuration (`billing.refreshSeconds`) sets it; this is its default. */
export const BILLING_TTL_MILLISECONDS = 3600 * 1000;
/** After a failed refresh, how long to wait before trying again, in milliseconds. The configuration (`billing.retrySeconds`) sets it; this is its default. */
export const BILLING_RETRY_MILLISECONDS = 900 * 1000;
/** The longest wait for one RunPod answer, in milliseconds. */
export const BILLING_TIMEOUT_MILLISECONDS = 5_000;
/** How many days of billing one reading holds. */
export const BILLING_DAYS = 31;

/** One billing bucket (a UTC day or hour): what RunPod charged in USD, summed over the endpoints. RunPod's v2 billing gives no billed time. */
export type BillingBucket = { readonly start: string; readonly amountUsd: number };

/** The account figures from RunPod. */
export type BillingBalance = { readonly balanceUsd: number; readonly currentSpendPerHr: number | null; readonly spendLimit: number | null };

/** The cold starts of one tier over the last 24 hours, from RunPod's own count: workers that started from nothing and how long that took. */
export type ColdStartTier = {
  readonly label: string;
  /** Cold starts counted by RunPod. */
  readonly count: number;
  /** Mean start time in milliseconds (RunPod's total divided by the count); null without a start. */
  readonly averageMs: number | null;
  /** The longest start in milliseconds; null without a start. */
  readonly maxMs: number | null;
  /** The highest of the hourly 95th percentiles, in milliseconds; null without a start. */
  readonly worstHourP95Ms: number | null;
};

/** What the reader holds: each part with the time it was read, since a part can fail on its own. */
export type BillingSnapshot = {
  readonly spend: { readonly days: readonly BillingBucket[]; readonly hours: readonly BillingBucket[]; readonly readAt: number } | null;
  readonly balance: (BillingBalance & { readonly readAt: number }) | null;
  /** The cold starts per tier, read at the same refresh as the billing (never per request). Absent in a snapshot made without the reader. */
  readonly coldStarts?: { readonly tiers: readonly ColdStartTier[]; readonly readAt: number } | null;
};

export interface BillingReader {
  /** The cached snapshot, refreshed when older than the cache time. Never throws. */
  read(): Promise<BillingSnapshot>;
}

/** An endpoint to read the billing of: its RunPod identifier, the key for it and the name of its tier (the first 6 characters of the identifier when left out). */
export type BillingEndpoint = { readonly id: string; readonly apiKey: string; readonly label?: string };

/** The RunPod endpoint identifier in `https://<id>.api.runpod.ai` or `https://api.runpod.ai/v2/<id>`; null for another address. */
export function runpodEndpointId(url: string): string | null {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }
  const host = parsed.hostname.toLowerCase();
  if (host.endsWith(".api.runpod.ai")) {
    const id = host.slice(0, -".api.runpod.ai".length);
    return /^[a-z0-9]+$/.test(id) ? id : null;
  }
  if (host === "api.runpod.ai") {
    const match = /^\/v2\/([A-Za-z0-9]+)(?:\/|$)/.exec(parsed.pathname);
    return match === null ? null : (match[1] as string);
  }
  return null;
}

/** The RunPod endpoints of the configuration that have a key, once each. */
export function billingEndpoints(config: BackendConfig, secrets: BackendSecrets): BillingEndpoint[] {
  const seen = new Set<string>();
  const result: BillingEndpoint[] = [];
  for (const endpoint of remoteEndpoints(config)) {
    const id = runpodEndpointId(endpoint.url);
    const key = secrets.proverKeys.find((candidate) => candidate.variable === endpoint.apiKeyVariable)?.value;
    if (id === null || key === undefined || key === "" || seen.has(id)) continue;
    seen.add(id);
    result.push({ id, apiKey: key, label: endpoint.label });
  }
  return result;
}

const finite = (value: unknown): number | null => (typeof value === "number" && Number.isFinite(value) ? value : null);

/** The longest text of a RunPod problem document that goes into a log line. */
const PROBLEM_TEXT_LIMIT = 200;

/** `title: detail` of an RFC 9457 problem document, cut to {@link PROBLEM_TEXT_LIMIT} characters; null when the body is not one. */
export function problemText(body: unknown): string | null {
  if (typeof body !== "object" || body === null) return null;
  const { title, detail } = body as { title?: unknown; detail?: unknown };
  const parts = [title, detail].filter((part): part is string => typeof part === "string" && part !== "");
  return parts.length === 0 ? null : parts.join(": ").replace(/\s+/g, " ").slice(0, PROBLEM_TEXT_LIMIT);
}

/**
 * Reads the records of one `GET /v2/billing/serverless` answer (`{ records, metadata }`). A record has `startTime` (the
 * bucket start, UTC), `serverlessId` and `totalAmount` (USD); it has no billed time. Only the
 * records of `serverlessIds` are kept when it is given. A record without a usable start is skipped.
 * @throws Error with the problem's title and detail when the answer is an RFC 9457 problem, and when it has no list of records.
 */
export function parseBillingRows(body: unknown, serverlessIds?: ReadonlySet<string>): Array<{ time: string; amountUsd: number }> {
  const records = typeof body === "object" && body !== null ? (body as { records?: unknown }).records : undefined;
  if (!Array.isArray(records)) throw new Error(problemText(body) ?? "the billing answer has no list of records");
  const parsed: Array<{ time: string; amountUsd: number }> = [];
  for (const row of records) {
    if (typeof row !== "object" || row === null) continue;
    const { startTime, totalAmount, serverlessId } = row as Record<string, unknown>;
    if (typeof startTime !== "string" || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/.test(startTime)) continue;
    if (serverlessIds !== undefined && !(typeof serverlessId === "string" && serverlessIds.has(serverlessId))) continue;
    parsed.push({ time: startTime.slice(0, 19).replace("T", " "), amountUsd: finite(totalAmount) ?? 0 });
  }
  return parsed;
}

/** Sums rows into buckets by their time cut to `length` characters (10 for a day, 13 for an hour), oldest first. */
export function bucketRows(rows: ReturnType<typeof parseBillingRows>, length: 10 | 13): BillingBucket[] {
  const sums = new Map<string, number>();
  for (const row of rows) {
    const key = row.time.slice(0, length).replace(" ", "T");
    sums.set(key, (sums.get(key) ?? 0) + row.amountUsd);
  }
  return [...sums.entries()].sort(([a], [b]) => (a < b ? -1 : 1)).map(([start, amountUsd]) => ({ start, amountUsd }));
}

/**
 * The cold starts of one tier from a `GET /v2/serverless/{id}/metrics/cold-starts` answer (`records`, one per time bucket,
 * each with `count` and `durationMs` `{ min, max, total, p95, ... }`).
 * @throws Error with the problem's title and detail when the answer is an RFC 9457 problem, and when it has no list of records.
 */
export function parseColdStarts(body: unknown, label: string): ColdStartTier {
  const records = typeof body === "object" && body !== null ? (body as { records?: unknown }).records : undefined;
  if (!Array.isArray(records)) throw new Error(problemText(body) ?? "the cold start answer has no list of records");
  let count = 0;
  let total = 0;
  let max: number | null = null;
  let p95: number | null = null;
  for (const record of records) {
    const { count: recordCount, durationMs } = (record ?? {}) as { count?: unknown; durationMs?: Record<string, unknown> | null };
    const amount = finite(recordCount);
    if (amount === null || amount <= 0) continue;
    count += amount;
    total += finite(durationMs?.total) ?? 0;
    const recordMax = finite(durationMs?.max);
    if (recordMax !== null) max = Math.max(max ?? recordMax, recordMax);
    const recordP95 = finite(durationMs?.p95);
    if (recordP95 !== null) p95 = Math.max(p95 ?? recordP95, recordP95);
  }
  return { label, count, averageMs: count === 0 ? null : Math.round(total / count), maxMs: max, worstHourP95Ms: p95 };
}

/** The balance from the GraphQL answer. @throws Error when it has no balance. */
export function parseBalance(body: unknown): BillingBalance {
  const myself = ((body as { data?: { myself?: Record<string, unknown> } } | null)?.data ?? {}).myself;
  const balance = finite(myself?.clientBalance);
  if (balance === null) throw new Error("the balance answer has no clientBalance");
  return { balanceUsd: balance, currentSpendPerHr: finite(myself?.currentSpendPerHr), spendLimit: finite(myself?.spendLimit) };
}

/** Merges the buckets of several endpoints into one list, by day (10) or hour (13). */
function mergeBuckets(lists: readonly (readonly BillingBucket[])[], length: 10 | 13): BillingBucket[] {
  return bucketRows(
    lists.flat().map((bucket) => ({ time: bucket.start.replace("T", " "), amountUsd: bucket.amountUsd })),
    length,
  );
}

/** Reads the billing and the balance. `fetchFunction` is a getter so a test can replace the fetch of the global. */
export function createBillingReader(input: {
  endpoints: readonly BillingEndpoint[];
  now: () => number;
  logger?: Logger;
  fetchFunction?: () => typeof fetch;
  /** The base address of RunPod's REST API v2; {@link RUNPOD_REST_URL} when left out. */
  restUrl?: string;
  ttlMilliseconds?: number;
  retryMilliseconds?: number;
  timeoutMilliseconds?: number;
}): BillingReader {
  const ttl = input.ttlMilliseconds ?? BILLING_TTL_MILLISECONDS;
  const retry = input.retryMilliseconds ?? BILLING_RETRY_MILLISECONDS;
  const timeout = input.timeoutMilliseconds ?? BILLING_TIMEOUT_MILLISECONDS;
  const doFetch = () => (input.fetchFunction ?? (() => fetch))();
  const restBase = (input.restUrl ?? RUNPOD_REST_URL).replace(/\/+$/, "");
  const billingUrl = `${restBase}/billing/serverless`;
  let snapshot: BillingSnapshot = { spend: null, balance: null, coldStarts: null };
  let nextTryAt = 0;
  let inFlight: Promise<void> | null = null;

  async function getJson(url: string, init: RequestInit & { headers: Record<string, string> }): Promise<unknown> {
    const answer = await doFetch()(url, { ...init, signal: AbortSignal.timeout(timeout) });
    if (!answer.ok) {
      // Error answers of REST v2 are RFC 9457 problem documents: say what RunPod says.
      const problem = problemText(await answer.json().catch(() => null));
      throw Object.assign(new Error(`RunPod answered ${answer.status}${problem === null ? "" : `: ${problem}`}`), { status: answer.status });
    }
    return answer.json();
  }

  async function refresh(): Promise<void> {
    const at = input.now();
    const day = (offsetHours: number) => new Date(at - offsetHours * 3_600_000).toISOString();
    const startOfDay = new Date(at - BILLING_DAYS * 86_400_000);
    startOfDay.setUTCHours(0, 0, 0, 0);
    const query = (bucket: "day" | "hour", start: string) => `${billingUrl}?bucketSize=${bucket}&startTime=${encodeURIComponent(start)}`;
    // One request per bucket size and key returns every endpoint of the account; the records of ours are kept.
    const keys = [...new Set(input.endpoints.map((endpoint) => endpoint.apiKey))];
    const spend = async () => {
      const perKey = await Promise.all(
        keys.map(async (key) => {
          const ids = new Set(input.endpoints.filter((endpoint) => endpoint.apiKey === key).map((endpoint) => endpoint.id));
          const headers = { authorization: `Bearer ${key}` };
          const [days, hours] = await Promise.all([getJson(query("day", startOfDay.toISOString()), { headers }), getJson(query("hour", day(26)), { headers })]);
          return { days: bucketRows(parseBillingRows(days, ids), 10), hours: bucketRows(parseBillingRows(hours, ids), 13) };
        }),
      );
      return { days: mergeBuckets(perKey.map((entry) => entry.days), 10), hours: mergeBuckets(perKey.map((entry) => entry.hours), 13), readAt: at };
    };
    const balance = async () => {
      const first = input.endpoints[0] as BillingEndpoint;
      const body = await getJson(GRAPHQL_URL, { method: "POST", headers: { authorization: `Bearer ${first.apiKey}`, "content-type": "application/json" }, body: JSON.stringify({ query: BALANCE_QUERY }) });
      return { ...parseBalance(body), readAt: at };
    };
    const coldStarts = async () => {
      const query = `interval=1h&limit=100&startTime=${encodeURIComponent(day(24))}&endTime=${encodeURIComponent(day(0))}`;
      const results = await Promise.allSettled(
        input.endpoints.map(async (endpoint) => {
          const label = endpoint.label ?? endpoint.id.slice(0, 6);
          const body = await getJson(`${restBase}/serverless/${encodeURIComponent(endpoint.id)}/metrics/cold-starts?${query}`, { headers: { authorization: `Bearer ${endpoint.apiKey}` } });
          return parseColdStarts(body, label);
        }),
      );
      results.forEach((result, index) => {
        if (result.status === "rejected") input.logger?.warn("billing_cold_starts_unreadable", { endpointId: (input.endpoints[index] as BillingEndpoint).id.slice(0, 6), reason: reasonOf(result.reason) });
      });
      const tiers = results.filter((result): result is PromiseFulfilledResult<ColdStartTier> => result.status === "fulfilled").map((result) => result.value);
      // Every tier failed: the last good reading stays (the reasons are logged above).
      if (tiers.length === 0) throw Object.assign(new Error("no tier's cold starts could be read"), { status: (results[0] as PromiseRejectedResult).reason?.status });
      return { tiers, readAt: at };
    };
    const [spendResult, balanceResult, coldStartResult] = await Promise.allSettled([spend(), balance(), coldStarts()]);
    // A failed part keeps its last good value; only the error's own text is logged, which never holds the key.
    if (spendResult.status === "rejected") input.logger?.warn("billing_spend_unreadable", { reason: reasonOf(spendResult.reason) });
    if (balanceResult.status === "rejected") input.logger?.warn("billing_balance_unreadable", { reason: reasonOf(balanceResult.reason) });
    snapshot = {
      spend: spendResult.status === "fulfilled" ? spendResult.value : snapshot.spend,
      balance: balanceResult.status === "fulfilled" ? balanceResult.value : snapshot.balance,
      coldStarts: coldStartResult.status === "fulfilled" ? coldStartResult.value : (snapshot.coldStarts ?? null),
    };
    // RunPod's request limit is per day: after a 429 the next try waits for the next refresh, not the short retry.
    const failures = [spendResult, balanceResult, coldStartResult].filter((result) => result.status === "rejected").map((result) => (result as PromiseRejectedResult).reason as { status?: number });
    nextTryAt = at + (failures.length === 0 || failures.some((failure) => failure.status === 429) ? ttl : Math.min(ttl, retry));
  }

  return {
    async read() {
      if (input.endpoints.length > 0 && input.now() >= nextTryAt) {
        inFlight ??= refresh().finally(() => {
          inFlight = null;
        });
        await inFlight;
      }
      return snapshot;
    },
  };
}

/** The text of a failure: our own message, or the name of a network error. It never holds the key, which travels in a header only. */
function reasonOf(error: unknown): string {
  const { name, message } = error as Error;
  return name === "Error" ? message : name;
}

/** Figures derived from a snapshot at a time. */
export type BillingFigures = {
  readonly available: boolean;
  /** Seconds since the spend figures were read, or null when never. */
  readonly ageSeconds: number | null;
  readonly last24hUsd: number | null;
  /** The seconds RunPod billed in the last 24 hours: always null, RunPod's serverless billing (REST v2) gives no billed time. */
  readonly last24hBilledSeconds: null;
  /** The effective USD per billed hour of RunPod's bill: always null, for the same reason. The price used for our own seconds is `warmup.gpuUsdPerHour`. */
  readonly effectiveUsdPerHour: null;
  readonly balanceUsd: number | null;
  readonly balanceAgeSeconds: number | null;
  readonly currentSpendPerHr: number | null;
  readonly spendLimit: number | null;
  /** The average USD per day over the 7 full UTC days before today, or null without a reading. */
  readonly averageDailyUsd7d: number | null;
  /** The balance divided by that average; null when the average is 0 or either is unknown. */
  readonly balanceDaysLeft: number | null;
  /** The state of each tier in the GPU spend guard (`gpu-guard.ts`); private, like the balance. Absent when the guard does not run. */
  readonly gpuGuard?: readonly GpuGuardTierState[];
};

const round = (value: number, places = 4) => Math.round(value * 10 ** places) / 10 ** places;

/** The windows of the summary from a snapshot. */
export function figuresOf(snapshot: BillingSnapshot, at: number, gpuGuard?: readonly GpuGuardTierState[]): BillingFigures {
  const { spend, balance } = snapshot;
  let last24hUsd: number | null = null;
  let average: number | null = null;
  if (spend !== null) {
    // An hour counts when it ends after the start of the 24 h window.
    const recent = spend.hours.filter((hour) => Date.parse(`${hour.start}:00:00Z`) + 3_600_000 > at - 86_400_000);
    last24hUsd = round(recent.reduce((sum, hour) => sum + hour.amountUsd, 0));
    const today = new Date(at).toISOString().slice(0, 10);
    const full = spend.days.filter((day) => day.start < today && day.start >= new Date(at - 7 * 86_400_000).toISOString().slice(0, 10));
    average = round(full.reduce((sum, day) => sum + day.amountUsd, 0) / 7);
  }
  const balanceUsd = balance?.balanceUsd ?? null;
  return {
    available: spend !== null,
    ageSeconds: spend === null ? null : Math.max(0, Math.round((at - spend.readAt) / 1000)),
    last24hUsd,
    last24hBilledSeconds: null,
    effectiveUsdPerHour: null,
    balanceUsd,
    balanceAgeSeconds: balance === null ? null : Math.max(0, Math.round((at - balance.readAt) / 1000)),
    currentSpendPerHr: balance?.currentSpendPerHr ?? null,
    spendLimit: balance?.spendLimit ?? null,
    averageDailyUsd7d: average,
    balanceDaysLeft: balanceUsd !== null && average !== null && average > 0 ? round(balanceUsd / average, 1) : null,
    ...(gpuGuard === undefined ? {} : { gpuGuard }),
  };
}

/** The billing figures without the account: what RunPod billed and the rate stay; the balance, its age, the spend limit, the spend now, the days the balance lasts and the state of the spend guard are left out. */
export function publicFiguresOf(figures: BillingFigures): Omit<BillingFigures, "balanceUsd" | "balanceAgeSeconds" | "currentSpendPerHr" | "spendLimit" | "balanceDaysLeft" | "gpuGuard"> {
  const { balanceUsd: _balance, balanceAgeSeconds: _age, currentSpendPerHr: _now, spendLimit: _limit, balanceDaysLeft: _days, gpuGuard: _guard, ...rest } = figures;
  return rest;
}
