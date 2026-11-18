/**
 * The one request helper for RunPod's REST API v2 and the pieces its callers share (`billing.ts`, `idle-timeout.ts`,
 * `gpu-guard.ts`): the address, the bearer header, the timeout, RunPod's problem text in the error, and a 429 as a typed
 * error so each caller can back off. The key travels in the Authorization header only and is never in an error message.
 */

/** RunPod's REST API v2. */
export const RUNPOD_REST_URL = "https://api.runpod.io/v2";

/** The longest text of a RunPod problem document that goes into a log line. */
const PROBLEM_TEXT_LIMIT = 200;

/** `title: detail` of an RFC 9457 problem document, cut to {@link PROBLEM_TEXT_LIMIT} characters; null when the body is not one. */
export function problemText(body: unknown): string | null {
  if (typeof body !== "object" || body === null) return null;
  const { title, detail } = body as { title?: unknown; detail?: unknown };
  const parts = [title, detail].filter((part): part is string => typeof part === "string" && part !== "");
  return parts.length === 0 ? null : parts.join(": ").replace(/\s+/g, " ").slice(0, PROBLEM_TEXT_LIMIT);
}

/** The text of a failure: our own message, or the name of a network error. It never holds the key. */
export function reasonOf(error: unknown): string {
  const { name, message } = error as Error;
  return name === "Error" ? message : name;
}

/** RunPod answered with a status that is not 2xx. `status` is 429 when the request limit is reached. */
export class RunPodRequestError extends Error {
  /**
   * @param status The HTTP status.
   * @param retryAfterSeconds The whole seconds of a `Retry-After` header, or null when there is none or it is not a positive
   *   number of seconds (the date form is not read).
   */
  constructor(
    message: string,
    readonly status: number,
    readonly retryAfterSeconds: number | null,
  ) {
    super(message);
  }
}

/** The seconds of a `Retry-After` header, or null when it is not a positive whole number. */
function retryAfterOf(value: string | null): number | null {
  if (value === null || !/^\d+$/.test(value.trim())) return null;
  const seconds = Number(value);
  return seconds > 0 ? seconds : null;
}

/**
 * One request to RunPod: the bearer key, a JSON body when `body` is given, and a timeout.
 *
 * @returns The parsed JSON of a 2xx answer (null when the body is not JSON).
 * @throws RunPodRequestError for any other status, with RunPod's problem text (RFC 9457) in the message; the error of
 *   `fetch` itself (a timeout, a network failure) as it is.
 */
export async function runPodRequest(
  fetchFunction: typeof fetch,
  url: string,
  options: { readonly apiKey: string; readonly timeoutMilliseconds: number; readonly method?: string; readonly body?: unknown },
): Promise<unknown> {
  const hasBody = options.body !== undefined;
  const answer = await fetchFunction(url, {
    ...(options.method === undefined ? {} : { method: options.method }),
    headers: { authorization: `Bearer ${options.apiKey}`, accept: "application/json", ...(hasBody ? { "content-type": "application/json" } : {}) },
    ...(hasBody ? { body: JSON.stringify(options.body) } : {}),
    signal: AbortSignal.timeout(options.timeoutMilliseconds),
  });
  const body: unknown = await answer.json().catch(() => null);
  if (!answer.ok) {
    const problem = problemText(body);
    throw new RunPodRequestError(`RunPod answered ${answer.status}${problem === null ? "" : `: ${problem}`}`, answer.status, retryAfterOf(answer.headers.get("retry-after")));
  }
  return body;
}
