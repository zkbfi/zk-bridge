import { afterEach, describe, expect, it, vi } from "vitest";
import { RUNPOD_REST_URL } from "../src/billing.ts";
import { createIdleTimeoutReader } from "../src/idle-timeout.ts";

const KEY = "fake-runpod-key-for-tests-0002";
const ENDPOINT = { id: "abc123def456", apiKey: KEY };
const OTHER = { id: "other123", apiKey: KEY };

type Call = { url: string; method: string; authorization: string | null; body: string | null };
type Answer = { status?: number; body?: unknown; error?: Error };

/** The endpoint as `GET /v2/serverless/{id}` answers it, cut to what is read. */
const endpoint = (idleTimeout: unknown) => ({ id: "x", name: "n", workers: { min: 0, max: 1, ...(idleTimeout === undefined ? {} : { idleTimeout }) } });

/** A RunPod v2 double: one answer per endpoint id (`answers`), or the same for all (`all`). */
function fakeRunpod(answers: Record<string, Answer> = { [ENDPOINT.id]: { body: endpoint(5) }, [OTHER.id]: { body: endpoint(5) } }) {
  const state: { answers: Record<string, Answer> } = { answers };
  const calls: Call[] = [];
  const fetchFunction = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    calls.push({ url, method: init?.method ?? "GET", authorization: new Headers(init?.headers).get("authorization"), body: typeof init?.body === "string" ? init.body : null });
    const id = url.slice(url.lastIndexOf("/") + 1);
    const answer = state.answers[id] ?? { status: 404, body: { title: "Not Found", status: 404, detail: `no endpoint ${id}` } };
    if (answer.error !== undefined) throw answer.error;
    return Response.json(answer.body ?? {}, { status: answer.status ?? 200 });
  }) as typeof fetch;
  return { state, calls, fetchFunction: () => fetchFunction };
}

const both = (first: unknown, second: unknown = first): Record<string, Answer> => ({ [ENDPOINT.id]: { body: endpoint(first) }, [OTHER.id]: { body: endpoint(second) } });

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
  it("reads each endpoint with one GET of REST v2 (workers.idleTimeout) and never writes", async () => {
    const { reader, runpod, lines } = make(fakeRunpod(both(60)));
    expect(reader.endpointIdleTimeoutSeconds()).toBeNull();
    await reader.run();
    expect(runpod.calls.map((call) => call.url).sort()).toEqual([`${RUNPOD_REST_URL}/serverless/${OTHER.id}`, `${RUNPOD_REST_URL}/serverless/${ENDPOINT.id}`].sort());
    for (const call of runpod.calls) expect(call).toMatchObject({ method: "GET", authorization: `Bearer ${KEY}`, body: null });
    expect(runpod.calls.some((call) => call.url.includes("graphql"))).toBe(false);
    expect(reader.endpointIdleTimeoutSeconds()).toBe(60);
    expect(lines.filter((line) => line.includes("runpod_idle_timeout_read"))).toHaveLength(2);
    expect(lines.join("\n")).not.toContain(KEY);
    expect(lines.join("\n")).not.toContain("differs_between_tiers");
  });

  it("tells the first endpoint's value to onObserved and logs when the tiers differ", async () => {
    const seen: number[] = [];
    const { reader, lines } = make(fakeRunpod(both(5, 30)), { seen });
    await reader.run();
    expect(seen).toEqual([5]);
    expect(lines.join("\n")).toContain('info runpod_idle_timeout_differs_between_tiers {"idleTimeoutSeconds":{"abc123":5,"other1":30}}');
  });

  it("warns for an endpoint that is missing or has no idleTimeout, and keeps the others", async () => {
    const seen: number[] = [];
    const { reader, lines } = make(fakeRunpod({ [ENDPOINT.id]: { body: endpoint(5) }, [OTHER.id]: { body: endpoint(undefined) } }), { seen });
    await reader.run();
    expect(lines.join("\n")).toContain("the endpoint has no idleTimeout");
    expect(reader.endpointIdleTimeoutSeconds()).toBe(5);
    const missing = make(fakeRunpod({}), { seen });
    await missing.reader.run();
    expect(missing.lines.join("\n")).toContain("RunPod answered 404: Not Found: no endpoint abc123def456");
    expect(missing.reader.endpointIdleTimeoutSeconds()).toBeNull();
    const nonsense = make(fakeRunpod({ [ENDPOINT.id]: { body: null }, [OTHER.id]: { body: "x" } }));
    await nonsense.reader.run();
    expect(nonsense.lines.join("\n")).toContain("the endpoint has no idleTimeout");
  });

  it("reads the other endpoints when one fails", async () => {
    const { reader, lines } = make(fakeRunpod({ [ENDPOINT.id]: { status: 500, body: { title: "Internal Server Error" } }, [OTHER.id]: { body: endpoint(30) } }));
    await reader.run();
    expect(reader.endpointIdleTimeoutSeconds()).toBeNull();
    expect(lines.filter((line) => line.includes("runpod_idle_timeout_unread"))).toHaveLength(1);
    expect(lines.filter((line) => line.includes("runpod_idle_timeout_read"))).toHaveLength(1);
  });

  it("warns and keeps the last value when the request fails, with the title and detail of the problem answer, never with the key", async () => {
    const { reader, runpod, lines } = make();
    await reader.run();
    const failures: Answer[] = [
      { error: new Error("network down") },
      { status: 429, body: { title: "Too Many Requests", status: 429, detail: "slow down" } },
      { status: 401, body: "not a problem document" },
      { status: 502, body: null },
    ];
    for (const failure of failures) {
      runpod.state.answers = { [ENDPOINT.id]: failure, [OTHER.id]: failure };
      await reader.run();
    }
    expect(reader.endpointIdleTimeoutSeconds()).toBe(5);
    const text = lines.join("\n");
    expect(text).toContain("warn runpod_idle_timeout_unread");
    expect(text).toContain("network down");
    expect(text).toContain("RunPod answered 429: Too Many Requests: slow down");
    expect(text).toContain('"RunPod answered 401"');
    expect(text).toContain('"RunPod answered 502"');
    expect(text).not.toContain(KEY);
  });

  it("logs an error answer that is not JSON by its status alone", async () => {
    const html = (async () => new Response("<html>", { status: 502 })) as unknown as typeof fetch;
    const lines: string[] = [];
    const logger = { debug() {}, info() {}, warn: (event: string, fields?: unknown) => void lines.push(`${event} ${JSON.stringify(fields)}`), error() {} };
    await createIdleTimeoutReader({ endpoints: [ENDPOINT], logger, fetchFunction: () => html }).run();
    expect(lines.join("\n")).toContain('"reason":"RunPod answered 502"');
  });

  it("names a network error by its name", async () => {
    const failure = new DOMException("timed out", "TimeoutError");
    const { reader, lines } = make(fakeRunpod({ [ENDPOINT.id]: { error: failure }, [OTHER.id]: { error: failure } }));
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
    expect(runpod.calls).toHaveLength(2);
    await vi.advanceTimersByTimeAsync(2000);
    expect(runpod.calls).toHaveLength(6);
    await reading.stop();
    await vi.advanceTimersByTimeAsync(5000);
    expect(runpod.calls).toHaveLength(6);
  });
});
