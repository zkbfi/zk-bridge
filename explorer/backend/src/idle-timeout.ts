/**
 * Owns the idle timeout of the RunPod endpoints. `watch.warmup.idleTimeoutSeconds` is the single source: at start-up the
 * backend reads each endpoint's settings (`GET rest.runpod.io/v1/endpoints/<id>`) and, when `idleTimeout` differs, sets it
 * (`PATCH` with `{"idleTimeout": n}`). It never blocks or stops the backend: a failure is logged and the value stays
 * unknown or as read. The key travels in the Authorization header only, and no log line holds it.
 */
import type { BillingEndpoint } from "./billing.ts";
import type { Logger } from "./logger.ts";

export const ENDPOINTS_URL = "https://rest.runpod.io/v1/endpoints";
/** The longest wait for one RunPod answer, in milliseconds. */
export const IDLE_SYNC_TIMEOUT_MILLISECONDS = 10_000;

export interface IdleTimeoutSync {
  /** Reads every endpoint and sets the idle timeout where it differs (when syncing). Never throws. */
  run(): Promise<void>;
  /** What RunPod reports for the first endpoint (the one that gets the warm-up pings), after the last run; null while unknown. */
  endpointIdleTimeoutSeconds(): number | null;
}

/** The text of a failure: our own message, or the name of a network error. It never holds the key. */
function reasonOf(error: unknown): string {
  const { name, message } = error as Error;
  return name === "Error" ? message : name;
}

export function createIdleTimeoutSync(input: {
  endpoints: readonly BillingEndpoint[];
  /** The idle timeout the configuration asks for, in seconds. */
  idleTimeoutSeconds: number;
  /** False reads and reports only; nothing is changed at RunPod. */
  sync: boolean;
  logger: Logger;
  fetchFunction?: () => typeof fetch;
  timeoutMilliseconds?: number;
}): IdleTimeoutSync {
  const timeout = input.timeoutMilliseconds ?? IDLE_SYNC_TIMEOUT_MILLISECONDS;
  const doFetch = () => (input.fetchFunction ?? (() => fetch))();
  const known = new Map<string, number>();

  async function call(endpoint: BillingEndpoint, method: "GET" | "PATCH"): Promise<unknown> {
    const headers: Record<string, string> = { authorization: `Bearer ${endpoint.apiKey}` };
    const init: RequestInit = { method, headers, signal: AbortSignal.timeout(timeout) };
    if (method === "PATCH") {
      headers["content-type"] = "application/json";
      init.body = JSON.stringify({ idleTimeout: input.idleTimeoutSeconds });
    }
    const answer = await doFetch()(`${ENDPOINTS_URL}/${encodeURIComponent(endpoint.id)}`, init);
    if (!answer.ok) throw new Error(`RunPod answered ${answer.status} to ${method}`);
    return answer.json();
  }

  async function one(endpoint: BillingEndpoint): Promise<void> {
    const endpointId = endpoint.id.slice(0, 6);
    try {
      const settings = (await call(endpoint, "GET")) as { idleTimeout?: unknown } | null;
      const from = settings?.idleTimeout;
      if (typeof from !== "number" || !Number.isFinite(from)) throw new Error("the endpoint settings have no idleTimeout");
      known.set(endpoint.id, from);
      if (from === input.idleTimeoutSeconds) {
        input.logger.info("runpod_idle_timeout_ok", { endpointId, idleTimeoutSeconds: from });
        return;
      }
      if (!input.sync) {
        input.logger.warn("runpod_idle_timeout_differs", { endpointId, from, to: input.idleTimeoutSeconds, synced: false });
        return;
      }
      await call(endpoint, "PATCH");
      known.set(endpoint.id, input.idleTimeoutSeconds);
      input.logger.info("runpod_idle_timeout_set", { endpointId, from, to: input.idleTimeoutSeconds });
    } catch (error) {
      input.logger.warn("runpod_idle_timeout_failed", { endpointId, reason: reasonOf(error) });
    }
  }

  return {
    async run() {
      await Promise.all(input.endpoints.map(one));
    },
    endpointIdleTimeoutSeconds() {
      const first = input.endpoints[0];
      return first === undefined ? null : (known.get(first.id) ?? null);
    },
  };
}
