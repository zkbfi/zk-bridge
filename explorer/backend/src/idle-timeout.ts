/**
 * Reads the idle timeout of the RunPod endpoints. The owner of the value is `deploy/runpod/endpoints.json`, applied with
 * `deploy/runpod/apply.mjs`; the backend never writes it. One GraphQL request (`myself { endpoints { id idleTimeout } }`)
 * reads every configured endpoint, at start-up and then every `billing.refreshSeconds`. The first endpoint's value (the one
 * that gets the warm-up pings) is what `endpointIdleTimeoutSeconds()` answers and what `onObserved` is told; until a read
 * works, the code uses `watch.warmup.idleTimeoutSeconds` as a fallback. It never blocks or stops the backend: a failure is
 * logged and the last value stays. The key travels in the Authorization header only, and no log line holds it.
 */
import { GRAPHQL_URL, type BillingEndpoint } from "./billing.ts";
import type { Logger } from "./logger.ts";

const QUERY = "query { myself { endpoints { id idleTimeout } } }";
/** The longest wait for one RunPod answer, in milliseconds. */
export const IDLE_READ_TIMEOUT_MILLISECONDS = 10_000;

export interface IdleTimeoutReader {
  /** Reads every endpoint once. Never throws. */
  run(): Promise<void>;
  /** Reads now, then every `intervalMilliseconds`. `stop` ends the timer and waits for a read in flight. */
  start(intervalMilliseconds: number): { stop(): Promise<void> };
  /** What RunPod reports for the first endpoint (the one that gets the warm-up pings), after the last read; null while unknown. */
  endpointIdleTimeoutSeconds(): number | null;
}

/** The text of a failure: our own message, or the name of a network error. It never holds the key. */
function reasonOf(error: unknown): string {
  const { name, message } = error as Error;
  return name === "Error" ? message : name;
}

export function createIdleTimeoutReader(input: {
  endpoints: readonly BillingEndpoint[];
  logger: Logger;
  /** Told the first endpoint's idle timeout after each read (the backend keeps the history for the billing breakdown). */
  onObserved?: (seconds: number) => void;
  fetchFunction?: () => typeof fetch;
  timeoutMilliseconds?: number;
}): IdleTimeoutReader {
  const timeout = input.timeoutMilliseconds ?? IDLE_READ_TIMEOUT_MILLISECONDS;
  const doFetch = () => (input.fetchFunction ?? (() => fetch))();
  const known = new Map<string, number>();
  let inFlight: Promise<void> = Promise.resolve();

  async function readAll(): Promise<void> {
    const first = input.endpoints[0] as BillingEndpoint;
    let rows: unknown[];
    try {
      const answer = await doFetch()(GRAPHQL_URL, {
        method: "POST",
        headers: { authorization: `Bearer ${first.apiKey}`, "content-type": "application/json" },
        body: JSON.stringify({ query: QUERY }),
        signal: AbortSignal.timeout(timeout),
      });
      if (!answer.ok) throw new Error(`RunPod answered ${answer.status}`);
      const body = (await answer.json()) as { data?: { myself?: { endpoints?: unknown } | null } | null; errors?: unknown } | null;
      if (Array.isArray(body?.errors) && body.errors.length > 0) throw new Error("RunPod answered with GraphQL errors");
      const list = body?.data?.myself?.endpoints;
      if (!Array.isArray(list)) throw new Error("the answer has no endpoint list");
      rows = list;
    } catch (error) {
      for (const endpoint of input.endpoints) input.logger.warn("runpod_idle_timeout_unread", { endpointId: endpoint.id.slice(0, 6), reason: reasonOf(error) });
      return;
    }
    for (const endpoint of input.endpoints) {
      const endpointId = endpoint.id.slice(0, 6);
      const row = rows.find((candidate) => (candidate as { id?: unknown } | null)?.id === endpoint.id) as { idleTimeout?: unknown } | undefined;
      const seconds = row?.idleTimeout;
      if (typeof seconds !== "number" || !Number.isFinite(seconds)) {
        input.logger.warn("runpod_idle_timeout_unread", { endpointId, reason: row === undefined ? "the endpoint is not in the answer" : "the endpoint has no idleTimeout" });
        continue;
      }
      known.set(endpoint.id, seconds);
      input.logger.info("runpod_idle_timeout_read", { endpointId, idleTimeoutSeconds: seconds });
    }
    const values = new Set(input.endpoints.map((endpoint) => known.get(endpoint.id)).filter((value) => value !== undefined));
    if (values.size > 1) input.logger.info("runpod_idle_timeout_differs_between_tiers", { idleTimeoutSeconds: Object.fromEntries([...known].map(([id, seconds]) => [id.slice(0, 6), seconds])) });
    const observed = known.get(first.id);
    if (observed !== undefined) input.onObserved?.(observed);
  }

  const reader: IdleTimeoutReader = {
    run() {
      inFlight = input.endpoints.length === 0 ? Promise.resolve() : readAll();
      return inFlight;
    },
    start(intervalMilliseconds) {
      void reader.run();
      const timer = setInterval(() => void reader.run(), intervalMilliseconds);
      timer.unref();
      return {
        async stop() {
          clearInterval(timer);
          await inFlight;
        },
      };
    },
    endpointIdleTimeoutSeconds() {
      const first = input.endpoints[0];
      return first === undefined ? null : (known.get(first.id) ?? null);
    },
  };
  return reader;
}
