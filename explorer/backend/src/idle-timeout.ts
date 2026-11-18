/**
 * Reads the idle timeout of the RunPod endpoints. The owner of the value is `deploy/runpod/endpoints.json`, applied with
 * `deploy/runpod/apply.mjs`; the backend never writes it. One REST v2 request per configured endpoint
 * (`GET api.runpod.io/v2/serverless/{id}`, field `workers.idleTimeout`) reads it, at start-up and then every
 * `billing.refreshSeconds`; an endpoint that fails does not stop the others. The first endpoint's value (the one
 * that gets the warm-up pings) is what `endpointIdleTimeoutSeconds()` answers and what `onObserved` is told; until a read
 * works, the code uses `watch.warmup.idleTimeoutSeconds` as a fallback. It never blocks or stops the backend: a failure is
 * logged and the last value stays; a RunPod error answer (RFC 9457) is logged with its title and detail. The key travels in
 * the Authorization header only, and no log line holds it.
 */
import type { BillingEndpoint } from "./billing.ts";
import { RUNPOD_REST_URL, reasonOf, runPodRequest } from "./runpod-rest.ts";
import type { Logger } from "./logger.ts";

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

export function createIdleTimeoutReader(input: {
  endpoints: readonly BillingEndpoint[];
  logger: Logger;
  /** Told the first endpoint's idle timeout after each read (the backend keeps the history for the billing breakdown). */
  onObserved?: (seconds: number) => void;
  fetchFunction?: () => typeof fetch;
  /** The base address of RunPod's REST API v2; {@link RUNPOD_REST_URL} when left out. */
  restUrl?: string;
  timeoutMilliseconds?: number;
}): IdleTimeoutReader {
  const timeout = input.timeoutMilliseconds ?? IDLE_READ_TIMEOUT_MILLISECONDS;
  const doFetch = () => (input.fetchFunction ?? (() => fetch))();
  const base = (input.restUrl ?? RUNPOD_REST_URL).replace(/\/+$/, "");
  const known = new Map<string, number>();
  let inFlight: Promise<void> = Promise.resolve();

  /** `workers.idleTimeout` of one endpoint, in seconds. @throws Error with the reason when it cannot be read. */
  async function readOne(endpoint: BillingEndpoint): Promise<number> {
    const body = await runPodRequest(doFetch(), `${base}/serverless/${encodeURIComponent(endpoint.id)}`, { apiKey: endpoint.apiKey, timeoutMilliseconds: timeout });
    const seconds = (body as { workers?: { idleTimeout?: unknown } | null } | null)?.workers?.idleTimeout;
    if (typeof seconds !== "number" || !Number.isFinite(seconds)) throw new Error("the endpoint has no idleTimeout");
    return seconds;
  }

  async function readAll(): Promise<void> {
    const first = input.endpoints[0] as BillingEndpoint;
    const results = await Promise.allSettled(input.endpoints.map(readOne));
    input.endpoints.forEach((endpoint, index) => {
      const endpointId = endpoint.id.slice(0, 6);
      const result = results[index] as PromiseSettledResult<number>;
      if (result.status === "rejected") {
        input.logger.warn("runpod_idle_timeout_unread", { endpointId, reason: reasonOf(result.reason) });
        return;
      }
      known.set(endpoint.id, result.value);
      input.logger.info("runpod_idle_timeout_read", { endpointId, idleTimeoutSeconds: result.value });
    });
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
