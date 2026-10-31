import { redactError, redactSecrets } from "./redaction.js";

/**
 * Small HTTP checks of a connection. Every message is redacted, so a key in a URL or a header never reaches a screen or
 * a log. The module uses `fetch` and nothing from Node.js, so a browser can import it.
 */

/** One HTTP request. */
export interface HttpRequest {
  readonly url: string;
  readonly method: "GET" | "POST";
  readonly headers?: Readonly<Record<string, string>>;
  readonly body?: string;
}

/** One HTTP answer. */
export interface HttpResponse {
  readonly status: number;
  readonly text: string;
}

/** Sends a request. A test passes a fake. */
export type HttpClient = (request: HttpRequest) => Promise<HttpResponse>;

/** The outcome of one test. */
export interface TestOutcome {
  readonly ok: "pass" | "fail";
  /** One redacted sentence for the screen. */
  readonly message: string;
}

/** The longest that a test waits, in milliseconds. */
const TIMEOUT_MILLISECONDS = 15_000;

/**
 * An HTTP client that uses `fetch` and gives up after a time limit.
 *
 * @param milliseconds The time limit.
 */
export const fetchClientWithin =
  (milliseconds: number): HttpClient =>
  async (request) => {
    const response = await fetch(request.url, {
      method: request.method,
      ...(request.headers === undefined ? {} : { headers: { ...request.headers } }),
      ...(request.body === undefined ? {} : { body: request.body }),
      signal: AbortSignal.timeout(milliseconds),
    });
    return { status: response.status, text: (await response.text()).slice(0, 2_000) };
  };

/** The HTTP client that uses `fetch`, with a time limit. */
export const fetchClient: HttpClient = fetchClientWithin(TIMEOUT_MILLISECONDS);

/**
 * A passing outcome.
 *
 * @param message One sentence for the screen.
 */
export const passOutcome = (message: string): TestOutcome => ({ ok: "pass", message });

/**
 * A failing outcome with the known secrets removed from the message.
 *
 * @param message One sentence for the screen.
 * @param secrets The secret values that the test used.
 */
export const failOutcome = (message: string, secrets: readonly string[]): TestOutcome => ({
  ok: "fail",
  message: redactSecrets(message, secrets),
});

/**
 * A sentence for an HTTP status that the test did not expect.
 *
 * @param response The answer.
 * @param what What the request was, for the sentence.
 */
export const describeStatus = (response: HttpResponse, what: string): string => {
  if (response.status === 401 || response.status === 403) return `The server refused ${what} with ${response.status}: check the API key.`;
  if (response.status === 404) return `The server answered ${what} with 404: check the address.`;
  if (response.status === 503 || /no workers available/i.test(response.text)) return `No worker is available now (${response.status}). Wait for one to start.`;
  return `The server answered ${what} with ${response.status}: ${response.text.slice(0, 120)}`;
};

/**
 * `eth_chainId` on an RPC URL. The answer must equal the chain that the caller expects. A URL of another chain is
 * refused, so a pasted URL cannot point a dashboard at the wrong network.
 *
 * @param http Sends the request.
 * @param input The RPC URL and the chain identifier that it must report.
 */
export const testRpcChainId = async (http: HttpClient, input: { rpcUrl: string; expectedChainId: number }): Promise<TestOutcome> => {
  const secrets = [input.rpcUrl];
  try {
    const response = await http({
      url: input.rpcUrl,
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_chainId", params: [] }),
    });
    if (response.status !== 200) return failOutcome(describeStatus(response, "eth_chainId"), secrets);
    const answer = JSON.parse(response.text) as { result?: unknown };
    if (typeof answer.result !== "string") return failOutcome("The node returned no chain identifier.", secrets);
    const found = Number.parseInt(answer.result, 16);
    if (found !== input.expectedChainId) return failOutcome(`The node is on chain ${found}, not chain ${input.expectedChainId}.`, secrets);
    return passOutcome(`The node reports chain ${found}.`);
  } catch (error) {
    return failOutcome(`eth_chainId did not complete: ${redactError(error, secrets)}`, secrets);
  }
};

/**
 * `GET /api/heads` on an indexer URL. A healthy indexer answers 200 with a list of heads.
 *
 * @param http Sends the request.
 * @param input The indexer URL.
 */
export const testIndexerUrl = async (http: HttpClient, input: { indexerUrl: string }): Promise<TestOutcome> => {
  const secrets = [input.indexerUrl];
  try {
    const response = await http({ url: `${input.indexerUrl.replace(/\/+$/, "")}/api/heads`, method: "GET" });
    if (response.status !== 200) return failOutcome(describeStatus(response, "/api/heads"), secrets);
    const answer = JSON.parse(response.text) as { heads?: unknown };
    if (!Array.isArray(answer.heads)) return failOutcome("The server answered, but it is not an explorer indexer: /api/heads has no list of heads.", secrets);
    return passOutcome("The indexer answers /api/heads.");
  } catch (error) {
    return failOutcome(`The indexer did not answer: ${redactError(error, secrets)}`, secrets);
  }
};

/**
 * `GET /health` on a service base URL (the indexer, the prover request endpoint, the archive, the msgboard indexer).
 * The proxy in front of them passes only their routes and `/health`, so the bare base URL answers 404 by design; the
 * health route is the one address every one of them answers. Any 2xx passes.
 *
 * @param http Sends the request.
 * @param input The base URL of the service.
 */
export const testHealthUrl = async (http: HttpClient, input: { baseUrl: string }): Promise<TestOutcome> => {
  const secrets = [input.baseUrl];
  try {
    const response = await http({ url: `${input.baseUrl.replace(/\/+$/, "")}/health`, method: "GET" });
    if (response.status < 200 || response.status > 299) return failOutcome(describeStatus(response, "/health"), secrets);
    return passOutcome("The service answers /health.");
  } catch (error) {
    return failOutcome(`The service did not answer: ${redactError(error, secrets)}`, secrets);
  }
};

/**
 * A JSON-RPC node that need not be a chain node (the msgboard node): `eth_chainId` posted to it passes when the answer
 * is a JSON-RPC envelope at all, with a result or an error, since a node without that method still answers.
 *
 * @param http Sends the request.
 * @param input The node URL.
 */
export const testJsonRpcUrl = async (http: HttpClient, input: { url: string }): Promise<TestOutcome> => {
  const secrets = [input.url];
  try {
    const response = await http({
      url: input.url.replace(/^wss:/, "https:").replace(/^ws:/, "http:"),
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_chainId", params: [] }),
    });
    if (response.status !== 200) return failOutcome(describeStatus(response, "a JSON-RPC call"), secrets);
    const answer = JSON.parse(response.text) as { jsonrpc?: unknown; result?: unknown; error?: unknown };
    if (answer.jsonrpc !== "2.0" || (answer.result === undefined && answer.error === undefined)) return failOutcome("The server answered, but not as a JSON-RPC node.", secrets);
    return passOutcome("The node answers JSON-RPC.");
  } catch (error) {
    return failOutcome(`The node did not answer: ${redactError(error, secrets)}`, secrets);
  }
};
