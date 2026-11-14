import { checkRequest, type ChainRules, type JsonRpcRequest, type Refusal } from "./rules.ts";

/**
 * One POST to rpc.zkb.fi: parse the body (one request or a batch), check every request (`rules.ts`), and either refuse
 * it or pass it to eRPC and return eRPC's answer. One refused request refuses its whole batch: each request gets a
 * JSON-RPC error with its own id, HTTP 200. What goes to eRPC is rebuilt from the checked fields, never the visitor's
 * bytes. Nothing of eRPC's configuration (its upstream URLs, keys or headers) reaches
 * the visitor: error messages lose every URL, and error data is kept only when it is revert data (hex).
 */

/** The answer to the visitor. */
export type ProxyAnswer = { readonly status: number; readonly body: string; readonly headers: Readonly<Record<string, string>> };

/** What one POST needs. */
export type ProxyInput = {
  readonly bodyText: string;
  readonly rules: ChainRules;
  /** The visitor's address for eRPC's per-IP limits (`X-Forwarded-For`), or null when unknown. */
  readonly visitorIp: string | null;
  readonly upstreamUrl: string;
  readonly maxBatchLength: number;
  readonly maxResponseBytes: number;
  readonly timeoutMilliseconds: number;
  readonly fetchFunction: typeof fetch;
};

/** What happened, for the counters of the module. */
export type ProxyOutcome = "served" | "refused" | "invalid" | "upstream-failed";

type Id = string | number | null;

const JSON_HEADERS = { "content-type": "application/json" };

/** The code of a body that is not JSON. */
const PARSE_ERROR = -32700;
/** The code of a request that is not a JSON-RPC request. */
const INVALID_REQUEST = -32600;
/** The code of an answer that could not be had from eRPC. */
const UPSTREAM_ERROR = -32603;

const errorOf = (id: Id, code: number, message: string) => ({ jsonrpc: "2.0", id, error: { code, message } });

const answer = (status: number, value: unknown, headers: Readonly<Record<string, string>> = JSON_HEADERS): ProxyAnswer => ({ status, body: JSON.stringify(value), headers });

const isObject = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);

/** The id of an entry, when it has one that JSON-RPC allows; else null. */
const idOf = (entry: unknown): Id => (isObject(entry) && (typeof entry.id === "string" || typeof entry.id === "number") ? entry.id : null);

/** The entry as a request, or null when it is not one (a notification without an id counts as not one: viem always sends an id). */
function asRequest(entry: unknown): JsonRpcRequest | null {
  if (!isObject(entry) || entry.jsonrpc !== "2.0" || typeof entry.method !== "string" || idOf(entry) === null) return null;
  if (entry.params !== undefined && !Array.isArray(entry.params)) return null;
  return entry as JsonRpcRequest;
}

/** The same errors for every entry: an array for a batch, one object otherwise. */
function errorsFor<Entry>(entries: readonly Entry[], batch: boolean, error: (entry: Entry, index: number) => object): unknown {
  const errors = entries.map(error);
  return batch ? errors : errors[0];
}

/** Removes every URL from a message, so an upstream address or key never reaches the visitor. */
export const withoutUrls = (message: string): string => message.replace(/\b[a-z][a-z0-9+.-]*:\/\/[^\s"'<>]+/gi, "[upstream]");

/** One answer of eRPC with its error cleaned: no URL in the message, data only when it is revert data. */
function cleaned(entry: unknown): unknown {
  if (!isObject(entry) || !isObject(entry.error)) return entry;
  const { code, message, data } = entry.error;
  const error = {
    code: typeof code === "number" ? code : UPSTREAM_ERROR,
    message: typeof message === "string" ? withoutUrls(message) : "the node answered an error",
    ...(typeof data === "string" && /^0x[0-9a-fA-F]*$/.test(data) ? { data } : {}),
  };
  return { ...entry, error };
}

/** Reads a body up to a limit. Resolves with null when it is larger. */
async function readLimited(response: Response, limit: number): Promise<string | null> {
  const reader = (response.body as ReadableStream<Uint8Array>).getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > limit) {
      await reader.cancel();
      return null;
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks).toString("utf8");
}

/**
 * Handles one POST.
 *
 * @returns The answer, and what happened.
 */
export async function handleRpc(input: ProxyInput): Promise<{ readonly answer: ProxyAnswer; readonly outcome: ProxyOutcome }> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(input.bodyText);
  } catch {
    return { answer: answer(200, errorOf(null, PARSE_ERROR, "the body is not JSON")), outcome: "invalid" };
  }
  const batch = Array.isArray(parsed);
  const entries: readonly unknown[] = batch ? (parsed as unknown[]) : [parsed];
  if (entries.length === 0) return { answer: answer(200, errorOf(null, INVALID_REQUEST, "the batch is empty")), outcome: "invalid" };
  if (entries.length > input.maxBatchLength) {
    const message = `rpc.zkb.fi refused the batch: it holds ${entries.length} requests, and the most it takes is ${input.maxBatchLength}`;
    return { answer: answer(200, errorsFor(entries, batch, (entry) => errorOf(idOf(entry), INVALID_REQUEST, message))), outcome: "refused" };
  }
  const requests = entries.map(asRequest);
  if (requests.includes(null)) {
    const message = "rpc.zkb.fi refused the batch: every entry must be a JSON-RPC 2.0 request with an id, a method and a params array";
    return { answer: answer(200, errorsFor(entries, batch, (entry) => errorOf(idOf(entry), INVALID_REQUEST, message))), outcome: "invalid" };
  }
  const checked = requests as JsonRpcRequest[];
  const outcomes = checked.map((request) => checkRequest(request, input.rules));
  const refusals = outcomes.map((outcome) => (outcome.ok ? null : outcome.refusal));
  const first = refusals.find((refusal): refusal is Refusal => refusal !== null);
  if (first !== undefined) {
    const body = errorsFor(checked, batch, ({ id, method }, index) => {
      const own = refusals[index] as Refusal | null;
      return own === null
        ? errorOf(id, first.code, `rpc.zkb.fi refused this batch because another request in it was refused: ${first.reason}`)
        : errorOf(id, own.code, `rpc.zkb.fi refused ${method}: ${own.reason}`);
    });
    return { answer: answer(200, body), outcome: "refused" };
  }
  // Only the rebuilt requests go on: fresh objects with the checked fields, never the visitor's bytes.
  return forward(input, outcomes.map((outcome) => (outcome as { readonly request: JsonRpcRequest }).request), batch);
}

/** Passes the checked requests to eRPC and returns its answer, cleaned. */
async function forward(input: ProxyInput, requests: readonly JsonRpcRequest[], batch: boolean): Promise<{ readonly answer: ProxyAnswer; readonly outcome: ProxyOutcome }> {
  const failed = (message: string) => ({
    answer: answer(502, errorsFor(requests, batch, ({ id }) => errorOf(id, UPSTREAM_ERROR, `rpc.zkb.fi ${message}`))),
    outcome: "upstream-failed" as const,
  });
  let response: Response;
  try {
    response = await input.fetchFunction(input.upstreamUrl, {
      method: "POST",
      headers: { "content-type": "application/json", ...(input.visitorIp === null ? {} : { "x-forwarded-for": input.visitorIp }) },
      body: JSON.stringify(batch ? requests : requests[0]),
      signal: AbortSignal.timeout(input.timeoutMilliseconds),
    });
  } catch (error) {
    return failed((error as Error).name === "TimeoutError" ? "got no answer from its node in time" : "could not reach its node");
  }
  const text = response.body === null ? "" : await readLimited(response, input.maxResponseBytes);
  if (text === null) return failed(`got an answer larger than ${input.maxResponseBytes} bytes from its node`);
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return failed(`got an answer it could not read from its node (HTTP ${response.status})`);
  }
  const body = Array.isArray(value) ? value.map(cleaned) : cleaned(value);
  const retryAfter = response.headers.get("retry-after");
  return { answer: answer(response.status, body, { ...JSON_HEADERS, ...(retryAfter === null ? {} : { "retry-after": retryAfter }) }), outcome: "served" };
}
