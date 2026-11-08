/**
 * What RunPod billed, read from RunPod's own billing API: the per-day and per-hour endpoint billing
 * (`GET rest.runpod.io/v1/billing/endpoints`) and the account balance (GraphQL `myself`). One cached reader serves every
 * page view, so a request to `/billing` never reaches RunPod. A failed refresh keeps the last good value and the
 * age of it. The key is read from the environment by the caller, sent only in the Authorization header, and never logged.
 */
import { remoteEndpoints, type BackendConfig, type BackendSecrets } from "./config.ts";
import type { Logger } from "./logger.ts";

export const BILLING_URL = "https://rest.runpod.io/v1/billing/endpoints";
export const GRAPHQL_URL = "https://api.runpod.io/graphql";
const BALANCE_QUERY = "query { myself { clientBalance currentSpendPerHr spendLimit } }";

/** How long one reading serves the page views, in milliseconds. */
export const BILLING_TTL_MILLISECONDS = 10 * 60_000;
/** After a failed refresh, how long to wait before trying again, in milliseconds. */
export const BILLING_RETRY_MILLISECONDS = 60_000;
/** The longest wait for one RunPod answer, in milliseconds. */
export const BILLING_TIMEOUT_MILLISECONDS = 5_000;
/** How many days of billing one reading holds. */
export const BILLING_DAYS = 31;

/** One billing bucket (a UTC day or hour): what RunPod charged and the GPU seconds it billed, summed over the endpoints. */
export type BillingBucket = { readonly start: string; readonly amountUsd: number; readonly billedSeconds: number };

/** The account figures from RunPod. */
export type BillingBalance = { readonly balanceUsd: number; readonly currentSpendPerHr: number | null; readonly spendLimit: number | null };

/** What the reader holds: each part with the time it was read, since a part can fail on its own. */
export type BillingSnapshot = {
  readonly spend: { readonly days: readonly BillingBucket[]; readonly hours: readonly BillingBucket[]; readonly readAt: number } | null;
  readonly balance: (BillingBalance & { readonly readAt: number }) | null;
};

export interface BillingReader {
  /** The cached snapshot, refreshed when older than the cache time. Never throws. */
  read(): Promise<BillingSnapshot>;
}

/** An endpoint to read the billing of: its RunPod identifier and the key for it. */
export type BillingEndpoint = { readonly id: string; readonly apiKey: string };

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
    result.push({ id, apiKey: key });
  }
  return result;
}

const finite = (value: unknown): number | null => (typeof value === "number" && Number.isFinite(value) ? value : null);

/**
 * Reads the rows of one billing answer: an array, or an object with the array under `data`. A row has `time`
 * ("2026-11-06 00:00:00", UTC), `amount` (USD) and `timeBilledMs`. A row without a usable time is skipped.
 * @throws Error when the answer is neither shape.
 */
export function parseBillingRows(body: unknown): Array<{ time: string; amountUsd: number; billedSeconds: number }> {
  const rows = Array.isArray(body) ? body : typeof body === "object" && body !== null && Array.isArray((body as { data?: unknown }).data) ? (body as { data: unknown[] }).data : null;
  if (rows === null) throw new Error("the billing answer is not a list of rows");
  const parsed: Array<{ time: string; amountUsd: number; billedSeconds: number }> = [];
  for (const row of rows) {
    if (typeof row !== "object" || row === null) continue;
    const { time, amount, timeBilledMs } = row as Record<string, unknown>;
    if (typeof time !== "string" || !/^\d{4}-\d{2}-\d{2}/.test(time)) continue;
    parsed.push({ time, amountUsd: finite(amount) ?? 0, billedSeconds: (finite(timeBilledMs) ?? 0) / 1000 });
  }
  return parsed;
}

/** Sums rows into buckets by their time cut to `length` characters (10 for a day, 13 for an hour), oldest first. */
export function bucketRows(rows: ReturnType<typeof parseBillingRows>, length: 10 | 13): BillingBucket[] {
  const sums = new Map<string, { amountUsd: number; billedSeconds: number }>();
  for (const row of rows) {
    const key = row.time.slice(0, length).replace(" ", "T");
    const sum = sums.get(key) ?? { amountUsd: 0, billedSeconds: 0 };
    sum.amountUsd += row.amountUsd;
    sum.billedSeconds += row.billedSeconds;
    sums.set(key, sum);
  }
  return [...sums.entries()].sort(([a], [b]) => (a < b ? -1 : 1)).map(([start, sum]) => ({ start, amountUsd: sum.amountUsd, billedSeconds: sum.billedSeconds }));
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
    lists.flat().map((bucket) => ({ time: bucket.start.replace("T", " "), amountUsd: bucket.amountUsd, billedSeconds: bucket.billedSeconds })),
    length,
  );
}

/** Reads the billing and the balance. `fetchFunction` is a getter so a test can replace the fetch of the global. */
export function createBillingReader(input: {
  endpoints: readonly BillingEndpoint[];
  now: () => number;
  logger?: Logger;
  fetchFunction?: () => typeof fetch;
  ttlMilliseconds?: number;
  retryMilliseconds?: number;
  timeoutMilliseconds?: number;
}): BillingReader {
  const ttl = input.ttlMilliseconds ?? BILLING_TTL_MILLISECONDS;
  const retry = input.retryMilliseconds ?? BILLING_RETRY_MILLISECONDS;
  const timeout = input.timeoutMilliseconds ?? BILLING_TIMEOUT_MILLISECONDS;
  const doFetch = () => (input.fetchFunction ?? (() => fetch))();
  let snapshot: BillingSnapshot = { spend: null, balance: null };
  let nextTryAt = 0;
  let inFlight: Promise<void> | null = null;

  async function getJson(url: string, init: RequestInit & { headers: Record<string, string> }): Promise<unknown> {
    const answer = await doFetch()(url, { ...init, signal: AbortSignal.timeout(timeout) });
    if (!answer.ok) throw new Error(`RunPod answered ${answer.status}`);
    return answer.json();
  }

  async function refresh(): Promise<void> {
    const at = input.now();
    const day = (offsetHours: number) => new Date(at - offsetHours * 3_600_000).toISOString();
    const startOfDay = new Date(at - BILLING_DAYS * 86_400_000);
    startOfDay.setUTCHours(0, 0, 0, 0);
    const query = (bucket: "day" | "hour", start: string, id: string) => `${BILLING_URL}?bucketSize=${bucket}&startTime=${encodeURIComponent(start)}&endpointId=${encodeURIComponent(id)}`;
    const spend = async () => {
      const perEndpoint = await Promise.all(
        input.endpoints.map(async (endpoint) => {
          const headers = { authorization: `Bearer ${endpoint.apiKey}` };
          const [days, hours] = await Promise.all([
            getJson(query("day", startOfDay.toISOString(), endpoint.id), { headers }),
            getJson(query("hour", day(26), endpoint.id), { headers }),
          ]);
          return { days: bucketRows(parseBillingRows(days), 10), hours: bucketRows(parseBillingRows(hours), 13) };
        }),
      );
      return { days: mergeBuckets(perEndpoint.map((entry) => entry.days), 10), hours: mergeBuckets(perEndpoint.map((entry) => entry.hours), 13), readAt: at };
    };
    const balance = async () => {
      const first = input.endpoints[0] as BillingEndpoint;
      const body = await getJson(GRAPHQL_URL, { method: "POST", headers: { authorization: `Bearer ${first.apiKey}`, "content-type": "application/json" }, body: JSON.stringify({ query: BALANCE_QUERY }) });
      return { ...parseBalance(body), readAt: at };
    };
    const [spendResult, balanceResult] = await Promise.allSettled([spend(), balance()]);
    // A failed part keeps its last good value; only the error's own text is logged, which never holds the key.
    if (spendResult.status === "rejected") input.logger?.warn("billing_spend_unreadable", { reason: reasonOf(spendResult.reason) });
    if (balanceResult.status === "rejected") input.logger?.warn("billing_balance_unreadable", { reason: reasonOf(balanceResult.reason) });
    snapshot = {
      spend: spendResult.status === "fulfilled" ? spendResult.value : snapshot.spend,
      balance: balanceResult.status === "fulfilled" ? balanceResult.value : snapshot.balance,
    };
    nextTryAt = at + (spendResult.status === "fulfilled" && balanceResult.status === "fulfilled" ? ttl : Math.min(ttl, retry));
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
  readonly last24hBilledSeconds: number | null;
  /** The effective USD per billed hour over the last 7 days (amount / billed hours), or null without billed time. */
  readonly effectiveUsdPerHour: number | null;
  readonly balanceUsd: number | null;
  readonly balanceAgeSeconds: number | null;
  readonly currentSpendPerHr: number | null;
  readonly spendLimit: number | null;
  /** The average USD per day over the 7 full UTC days before today, or null without a reading. */
  readonly averageDailyUsd7d: number | null;
  /** The balance divided by that average; null when the average is 0 or either is unknown. */
  readonly balanceDaysLeft: number | null;
};

const round = (value: number, places = 4) => Math.round(value * 10 ** places) / 10 ** places;

/** The windows of the summary from a snapshot. */
export function figuresOf(snapshot: BillingSnapshot, at: number): BillingFigures {
  const { spend, balance } = snapshot;
  let last24hUsd: number | null = null;
  let last24hBilledSeconds: number | null = null;
  let effective: number | null = null;
  let average: number | null = null;
  if (spend !== null) {
    // An hour counts when it ends after the start of the 24 h window.
    const recent = spend.hours.filter((hour) => Date.parse(`${hour.start}:00:00Z`) + 3_600_000 > at - 86_400_000);
    last24hUsd = round(recent.reduce((sum, hour) => sum + hour.amountUsd, 0));
    last24hBilledSeconds = round(recent.reduce((sum, hour) => sum + hour.billedSeconds, 0), 2);
    const today = new Date(at).toISOString().slice(0, 10);
    const lastSeven = spend.days.filter((day) => day.start >= new Date(at - 7 * 86_400_000).toISOString().slice(0, 10));
    const amount = lastSeven.reduce((sum, day) => sum + day.amountUsd, 0);
    const seconds = lastSeven.reduce((sum, day) => sum + day.billedSeconds, 0);
    effective = seconds > 0 ? round(amount / (seconds / 3600)) : null;
    const full = spend.days.filter((day) => day.start < today && day.start >= new Date(at - 7 * 86_400_000).toISOString().slice(0, 10));
    average = round(full.reduce((sum, day) => sum + day.amountUsd, 0) / 7);
  }
  const balanceUsd = balance?.balanceUsd ?? null;
  return {
    available: spend !== null,
    ageSeconds: spend === null ? null : Math.max(0, Math.round((at - spend.readAt) / 1000)),
    last24hUsd,
    last24hBilledSeconds,
    effectiveUsdPerHour: effective,
    balanceUsd,
    balanceAgeSeconds: balance === null ? null : Math.max(0, Math.round((at - balance.readAt) / 1000)),
    currentSpendPerHr: balance?.currentSpendPerHr ?? null,
    spendLimit: balance?.spendLimit ?? null,
    averageDailyUsd7d: average,
    balanceDaysLeft: balanceUsd !== null && average !== null && average > 0 ? round(balanceUsd / average, 1) : null,
  };
}

/** The billing figures without the account: what RunPod billed and the rate stay public; the balance, the spend limit, the spend now and the days the balance lasts do not. */
export function publicFiguresOf(figures: BillingFigures): BillingFigures {
  return { ...figures, balanceUsd: null, balanceAgeSeconds: null, currentSpendPerHr: null, spendLimit: null, balanceDaysLeft: null };
}
