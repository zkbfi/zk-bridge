/** The warm-up ping of the remote prover: `GET <endpoint>/ping`, the health route of the load-balancing endpoint. */

/**
 * How long one ping may take, in milliseconds. The load-balancing endpoint can hold a ping until a cold worker is up;
 * a shorter timeout gives up on the request while RunPod still counts it and starts the worker anyway.
 */
export const PING_TIMEOUT_MILLISECONDS = 300_000;

/**
 * Builds the ping. It answers the HTTP status (200 ready, 204 a worker is starting) and throws when the endpoint cannot
 * be reached. The address and the key never leave this function; the caller logs only the status.
 */
export function createProverPing(input: { endpoint: string; apiKey: string; fetchFunction?: () => typeof fetch; timeoutMilliseconds?: number }): () => Promise<number> {
  const url = `${input.endpoint.replace(/\/+$/, "")}/ping`;
  const fetchFunction = input.fetchFunction ?? (() => globalThis.fetch);
  return async () => {
    const answer = await fetchFunction()(url, {
      headers: { authorization: `Bearer ${input.apiKey}` },
      signal: AbortSignal.timeout(input.timeoutMilliseconds ?? PING_TIMEOUT_MILLISECONDS),
    });
    await answer.body?.cancel();
    return answer.status;
  };
}
