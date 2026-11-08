import { describe, expect, it } from "vitest";
import { ENDPOINTS_URL, createIdleTimeoutSync } from "../src/idle-timeout.ts";

const KEY = "fake-runpod-key-for-tests-0002";
const ENDPOINT = { id: "abc123def456", apiKey: KEY };

type Call = { url: string; method: string; authorization: string | null; body: string | null };

/** A RunPod REST double: GET gives the settings, PATCH changes them. A route set to an Error or a status fails. */
function fakeRunpod(settings: unknown = { idleTimeout: 60, workersMin: 0, workersMax: 1, flashboot: true }) {
  const state: { settings: unknown; get: Error | number | null; patch: Error | number | null } = { settings, get: null, patch: null };
  const calls: Call[] = [];
  const fetchFunction = (async (input: string | URL | Request, init?: RequestInit) => {
    const method = init?.method ?? "GET";
    calls.push({ url: String(input), method, authorization: new Headers(init?.headers).get("authorization"), body: typeof init?.body === "string" ? init.body : null });
    const failure = method === "GET" ? state.get : state.patch;
    if (failure instanceof Error) throw failure;
    if (typeof failure === "number") return new Response("{}", { status: failure });
    if (method === "PATCH") state.settings = { ...(state.settings as object), ...JSON.parse(String(init?.body)) };
    return Response.json(state.settings);
  }) as typeof fetch;
  return { state, calls, fetchFunction: () => fetchFunction };
}

function make(runpod = fakeRunpod(), options: { idle?: number; sync?: boolean; endpoints?: Array<typeof ENDPOINT>; seen?: number[] } = {}) {
  const lines: string[] = [];
  const record = (level: string) => (event: string, fields?: unknown) => void lines.push(`${level} ${event} ${JSON.stringify(fields)}`);
  const logger = { debug: record("debug"), info: record("info"), warn: record("warn"), error: record("error") };
  const sync = createIdleTimeoutSync({ endpoints: options.endpoints ?? [ENDPOINT], idleTimeoutSeconds: options.idle ?? 5, sync: options.sync ?? true, logger, fetchFunction: runpod.fetchFunction, ...(options.seen === undefined ? {} : { onObserved: (seconds: number) => options.seen?.push(seconds) }) });
  return { runpod, lines, sync };
}

describe("telling the history of the idle timeout (2026-11-08)", () => {
  it("reports the first endpoint's timeout as read and as set, and no other endpoint's", async () => {
    const seen: number[] = [];
    await make(fakeRunpod(), { seen, endpoints: [ENDPOINT, { id: "other123", apiKey: KEY }] }).sync.run();
    expect(seen).toEqual([60, 5]);
    const already: number[] = [];
    await make(fakeRunpod({ idleTimeout: 5 }), { seen: already }).sync.run();
    expect(already).toEqual([5]);
    // Nobody listening is fine.
    await make().sync.run();
  });
});

describe("setting the endpoint's idle timeout", () => {
  it("sets it when it differs: a GET, one PATCH with only idleTimeout, and a log with the short id and both numbers", async () => {
    const { runpod, lines, sync } = make();
    expect(sync.endpointIdleTimeoutSeconds()).toBeNull();
    await sync.run();
    expect(runpod.calls.map((call) => `${call.method} ${call.url}`)).toEqual([`GET ${ENDPOINTS_URL}/abc123def456`, `PATCH ${ENDPOINTS_URL}/abc123def456`]);
    expect(runpod.calls[1]?.body).toBe('{"idleTimeout":5}');
    expect(lines).toEqual(['info runpod_idle_timeout_set {"endpointId":"abc123","from":60,"to":5}']);
    expect(sync.endpointIdleTimeoutSeconds()).toBe(5);
  });

  it("changes nothing when it matches", async () => {
    const { runpod, lines, sync } = make(fakeRunpod({ idleTimeout: 5 }));
    await sync.run();
    expect(runpod.calls.map((call) => call.method)).toEqual(["GET"]);
    expect(lines).toEqual(['info runpod_idle_timeout_ok {"endpointId":"abc123","idleTimeoutSeconds":5}']);
    expect(sync.endpointIdleTimeoutSeconds()).toBe(5);
  });

  it("only reads and warns when syncing is off, and reports what RunPod has", async () => {
    const { runpod, lines, sync } = make(fakeRunpod(), { sync: false });
    await sync.run();
    expect(runpod.calls.map((call) => call.method)).toEqual(["GET"]);
    expect(lines).toEqual(['warn runpod_idle_timeout_differs {"endpointId":"abc123","from":60,"to":5,"synced":false}']);
    expect(sync.endpointIdleTimeoutSeconds()).toBe(60);
  });

  it("logs and goes on when RunPod cannot be read, answers badly, or refuses the change; the key is never in a log or a URL", async () => {
    const failing = fakeRunpod();
    failing.state.get = new TypeError("fetch failed");
    const first = make(failing);
    await expect(first.sync.run()).resolves.toBeUndefined();
    expect(first.lines).toEqual(['warn runpod_idle_timeout_failed {"endpointId":"abc123","reason":"TypeError"}']);
    expect(first.sync.endpointIdleTimeoutSeconds()).toBeNull();

    const refused = fakeRunpod();
    refused.state.get = 401;
    const second = make(refused);
    await second.sync.run();
    expect(second.lines).toEqual(['warn runpod_idle_timeout_failed {"endpointId":"abc123","reason":"RunPod answered 401 to GET"}']);

    const noField = make(fakeRunpod({ workersMin: 0 }));
    await noField.sync.run();
    expect(noField.lines[0]).toContain("the endpoint settings have no idleTimeout");
    const noObject = make(fakeRunpod(null));
    await noObject.sync.run();
    expect(noObject.lines[0]).toContain("the endpoint settings have no idleTimeout");

    // The change is refused: the value RunPod has stays the reported one.
    const stuck = fakeRunpod();
    stuck.state.patch = 403;
    const third = make(stuck);
    await third.sync.run();
    expect(third.lines).toEqual(['warn runpod_idle_timeout_failed {"endpointId":"abc123","reason":"RunPod answered 403 to PATCH"}']);
    expect(third.sync.endpointIdleTimeoutSeconds()).toBe(60);

    for (const run of [first, second, noField, noObject, third]) {
      expect(run.lines.join("\n")).not.toContain(KEY);
      expect(run.runpod.calls.every((call) => !call.url.includes(KEY) && call.authorization === `Bearer ${KEY}`)).toBe(true);
    }
  });

  it("reports the first endpoint, handles each endpoint on its own, and has nothing to report without one", async () => {
    const runpod = fakeRunpod();
    const { sync, lines } = make(runpod, { endpoints: [ENDPOINT, { id: "zzz999", apiKey: KEY }] });
    await sync.run();
    expect(runpod.calls.filter((call) => call.method === "PATCH").map((call) => call.url)).toEqual([`${ENDPOINTS_URL}/abc123def456`, `${ENDPOINTS_URL}/zzz999`]);
    expect(lines).toHaveLength(2);
    const none = make(fakeRunpod(), { endpoints: [] });
    await none.sync.run();
    expect(none.sync.endpointIdleTimeoutSeconds()).toBeNull();
    expect(none.runpod.calls).toEqual([]);
  });

  it("uses the global fetch when none is given", async () => {
    const real = globalThis.fetch;
    const seen: string[] = [];
    globalThis.fetch = (async (input: string | URL | Request) => (seen.push(String(input)), Response.json({ idleTimeout: 5 }))) as typeof fetch;
    try {
      const sync = createIdleTimeoutSync({ endpoints: [ENDPOINT], idleTimeoutSeconds: 5, sync: true, logger: { debug() {}, info() {}, warn() {}, error() {} } });
      await sync.run();
      expect(seen).toEqual([`${ENDPOINTS_URL}/abc123def456`]);
    } finally {
      globalThis.fetch = real;
    }
  });
});
