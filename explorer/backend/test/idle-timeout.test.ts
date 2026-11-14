import { afterEach, describe, expect, it, vi } from "vitest";
import { GRAPHQL_URL } from "../src/billing.ts";
import { createIdleTimeoutReader } from "../src/idle-timeout.ts";

const KEY = "fake-runpod-key-for-tests-0002";
const ENDPOINT = { id: "abc123def456", apiKey: KEY };
const OTHER = { id: "other123", apiKey: KEY };

type Call = { url: string; method: string; authorization: string | null; body: string | null };

/** A RunPod GraphQL double. `answer` is the JSON body, a status number or an Error. */
function fakeRunpod(answer: unknown = { data: { myself: { endpoints: [{ id: ENDPOINT.id, idleTimeout: 5 }, { id: OTHER.id, idleTimeout: 5 }] } } }) {
  const state: { answer: unknown } = { answer };
  const calls: Call[] = [];
  const fetchFunction = (async (input: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(input), method: init?.method ?? "GET", authorization: new Headers(init?.headers).get("authorization"), body: typeof init?.body === "string" ? init.body : null });
    if (state.answer instanceof Error) throw state.answer;
    if (typeof state.answer === "number") return new Response("{}", { status: state.answer });
    return Response.json(state.answer);
  }) as typeof fetch;
  return { state, calls, fetchFunction: () => fetchFunction };
}

const rows = (...list: unknown[]) => ({ data: { myself: { endpoints: list } } });

function make(runpod = fakeRunpod(), options: { endpoints?: Array<typeof ENDPOINT>; seen?: number[] } = {}) {
  const lines: string[] = [];
  const record = (level: string) => (event: string, fields?: unknown) => void lines.push(`${level} ${event} ${JSON.stringify(fields)}`);
  const logger = { debug: record("debug"), info: record("info"), warn: record("warn"), error: record("error") };
  const reader = createIdleTimeoutReader({
    endpoints: options.endpoints ?? [ENDPOINT, OTHER],
    logger,
    fetchFunction: runpod.fetchFunction,
    ...(options.seen === undefined ? {} : { onObserved: (seconds: number) => void options.seen?.push(seconds) }),
  });
  return { runpod, lines, reader };
}

afterEach(() => vi.useRealTimers());

describe("reading the idle timeout of the endpoints", () => {
  it("reads every endpoint with one GraphQL request and never writes", async () => {
    const { reader, runpod, lines } = make(fakeRunpod(rows({ id: ENDPOINT.id, idleTimeout: 60 }, { id: OTHER.id, idleTimeout: 60 })));
    expect(reader.endpointIdleTimeoutSeconds()).toBeNull();
    await reader.run();
    expect(runpod.calls).toHaveLength(1);
    expect(runpod.calls[0]).toMatchObject({ url: GRAPHQL_URL, method: "POST", authorization: `Bearer ${KEY}` });
    expect(runpod.calls[0]?.body).toContain("idleTimeout");
    expect(reader.endpointIdleTimeoutSeconds()).toBe(60);
    expect(lines.filter((line) => line.includes("runpod_idle_timeout_read"))).toHaveLength(2);
    expect(lines.join("\n")).not.toContain(KEY);
    expect(lines.join("\n")).not.toContain("differs_between_tiers");
  });

  it("tells the first endpoint's value to onObserved and logs when the tiers differ", async () => {
    const seen: number[] = [];
    const { reader, lines } = make(fakeRunpod(rows({ id: ENDPOINT.id, idleTimeout: 5 }, { id: OTHER.id, idleTimeout: 30 })), { seen });
    await reader.run();
    expect(seen).toEqual([5]);
    expect(lines.join("\n")).toContain('info runpod_idle_timeout_differs_between_tiers {"idleTimeoutSeconds":{"abc123":5,"other1":30}}');
  });

  it("warns for an endpoint that is missing or has no idleTimeout, and keeps the others", async () => {
    const seen: number[] = [];
    const { reader, lines } = make(fakeRunpod(rows({ id: ENDPOINT.id, idleTimeout: 5 }, { id: OTHER.id }, null)), { seen });
    await reader.run();
    expect(lines.join("\n")).toContain("the endpoint has no idleTimeout");
    expect(reader.endpointIdleTimeoutSeconds()).toBe(5);
    const missing = make(fakeRunpod(rows()), { seen });
    await missing.reader.run();
    expect(missing.lines.join("\n")).toContain("the endpoint is not in the answer");
    expect(missing.reader.endpointIdleTimeoutSeconds()).toBeNull();
  });

  it("warns and keeps the last value when the request fails, never with the key", async () => {
    const { reader, runpod, lines } = make();
    await reader.run();
    for (const answer of [new Error("network down"), 429, { errors: [{ message: "x" }] }, { data: { myself: null } }, null]) {
      runpod.state.answer = answer;
      await reader.run();
    }
    expect(reader.endpointIdleTimeoutSeconds()).toBe(5);
    const text = lines.join("\n");
    expect(text).toContain("warn runpod_idle_timeout_unread");
    expect(text).toContain("network down");
    expect(text).toContain("RunPod answered 429");
    expect(text).toContain("GraphQL errors");
    expect(text).toContain("no endpoint list");
    expect(text).not.toContain(KEY);
  });

  it("names a network error by its name", async () => {
    const failure = new DOMException("timed out", "TimeoutError");
    const { reader, lines } = make(fakeRunpod(failure as unknown as Error));
    await reader.run();
    expect(lines.join("\n")).toContain("TimeoutError");
  });

  it("reads nothing without an endpoint", async () => {
    const { reader, runpod } = make(fakeRunpod(), { endpoints: [] });
    await reader.run();
    expect(runpod.calls).toEqual([]);
    expect(reader.endpointIdleTimeoutSeconds()).toBeNull();
  });

  it("reads at start and then on the interval, until stopped", async () => {
    vi.useFakeTimers();
    const { reader, runpod } = make();
    const reading = reader.start(1000);
    await vi.advanceTimersByTimeAsync(0);
    expect(runpod.calls).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(2000);
    expect(runpod.calls).toHaveLength(3);
    await reading.stop();
    await vi.advanceTimersByTimeAsync(5000);
    expect(runpod.calls).toHaveLength(3);
  });
});
