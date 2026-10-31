import { afterEach, describe, expect, it, vi } from "vitest";
import { zeroHash } from "viem";
import { fetchJsonGet, readHistory, readLightClient, readSource, USER_AGENT, type JsonGet } from "../src/keepalive/sources.ts";

const LIGHT_CLIENT = "0x1dbbcc0bc25de5f6ae122fb0009b3ee4931fd958";

function client(values: { head: bigint; slotsPerPeriod: bigint; next: `0x${string}` }) {
  const calls: Array<{ functionName: string; args?: readonly unknown[]; blockNumber?: bigint }> = [];
  return {
    calls,
    getBlockNumber: async () => 77n,
    readContract: (async (request: { functionName: string; args?: readonly unknown[]; blockNumber?: bigint }) => {
      calls.push(request);
      switch (request.functionName) {
        case "head":
          return values.head;
        case "slotsPerPeriod":
          return values.slotsPerPeriod;
        case "genesisTime":
          return 1_000n;
        case "secondsPerSlot":
          return 12n;
        default:
          return values.next;
      }
    }) as never,
  };
}

describe("readLightClient", () => {
  it("reads every value at one block and asks for the committee after the head period", async () => {
    const fake = client({ head: 11_463_040n, slotsPerPeriod: 8192n, next: `0x${"d2".repeat(32)}` });
    const facts = await readLightClient(fake, LIGHT_CLIENT);
    expect(facts).toEqual({ headSlot: 11_463_040, slotsPerPeriod: 8192, genesisTime: 1000, secondsPerSlot: 12, nextCommitteeKnown: true });
    expect(fake.calls.every((call) => call.blockNumber === 77n)).toBe(true);
    expect(fake.calls.find((call) => call.functionName === "syncCommittees")?.args).toEqual([1400n]);
  });

  it("an empty next committee is not known", async () => {
    const facts = await readLightClient(client({ head: 10n, slotsPerPeriod: 8192n, next: zeroHash }), LIGHT_CLIENT);
    expect(facts.nextCommitteeKnown).toBe(false);
  });

  it("refuses a contract with zero slots per period", async () => {
    await expect(readLightClient(client({ head: 10n, slotsPerPeriod: 0n, next: zeroHash }), LIGHT_CLIENT)).rejects.toThrow(/not a beacon light client/);
  });
});

/** A beacon node fake: a map from path to answer, and a log of the paths asked. */
function node(answers: Record<string, { status: number; body: unknown }>) {
  const asked: string[] = [];
  const get: JsonGet = async (url) => {
    const path = url.replace("http://beacon", "");
    asked.push(path);
    return answers[path] ?? { status: 404, body: null };
  };
  return { asked, get };
}

const update = (slot: number) => ({ version: "gloas", data: { attested_header: { beacon: { slot: String(slot) } } } });

describe("readSource", () => {
  it("reads the finalized slot, with or without a trailing slash", async () => {
    const beacon = node({ "/eth/v1/beacon/headers/finalized": { status: 200, body: { data: { header: { message: { slot: "11477824" } } } } } });
    expect(await readSource(beacon.get, "http://beacon/")).toEqual({ finalizedSlot: 11_477_824 });
  });

  it("refuses an error status and an unknown shape", async () => {
    await expect(readSource(node({}).get, "http://beacon")).rejects.toThrow(/answered 404/);
    const odd = node({ "/eth/v1/beacon/headers/finalized": { status: 200, body: { data: {} } } });
    await expect(readSource(odd.get, "http://beacon")).rejects.toThrow(/unknown shape/);
    const empty = node({ "/eth/v1/beacon/headers/finalized": { status: 200, body: null } });
    await expect(readSource(empty.get, "http://beacon")).rejects.toThrow(/unknown shape/);
  });
});

describe("readHistory", () => {
  const route = (start: number, count: number) => `/eth/v1/beacon/light_client/updates?start_period=${start}&count=${count}`;

  it("asks nothing when no period is needed", async () => {
    const beacon = node({});
    expect(await readHistory(beacon.get, "http://beacon", [], 8192)).toEqual({ kind: "not-needed" });
    expect(beacon.asked).toEqual([]);
  });

  it("serves when every period came back, paging after the highest period received", async () => {
    const beacon = node({
      [route(1399, 3)]: { status: 200, body: [update(1399 * 8192 + 64)] },
      [route(1400, 2)]: { status: 200, body: [update(1400 * 8192 + 64), update(1401 * 8192 + 64)] },
    });
    expect(await readHistory(beacon.get, "http://beacon", [1399, 1400, 1401], 8192)).toEqual({ kind: "serves" });
    expect(beacon.asked).toEqual([route(1399, 3), route(1400, 2)]);
  });

  it("a node without the route (404 or 501) misses the first period", async () => {
    expect(await readHistory(node({}).get, "http://beacon", [1367], 8192)).toEqual({ kind: "missing", period: 1367 });
    const notImplemented = node({ [route(1367, 1)]: { status: 501, body: null } });
    expect(await readHistory(notImplemented.get, "http://beacon", [1367], 8192)).toEqual({ kind: "missing", period: 1367 });
  });

  it("names the first period a node that pruned history lacks, and stops when a page brings nothing new", async () => {
    const beacon = node({
      [route(10, 3)]: { status: 200, body: [update(11 * 8192)] },
      [route(12, 1)]: { status: 200, body: [] },
    });
    expect(await readHistory(beacon.get, "http://beacon", [10, 11, 12], 8192)).toEqual({ kind: "missing", period: 10 });
    expect(beacon.asked).toHaveLength(2);
  });

  it("refuses another status and a body that is not a list", async () => {
    await expect(readHistory(node({ [route(1, 1)]: { status: 500, body: null } }).get, "http://beacon", [1], 8192)).rejects.toThrow(/answered 500/);
    await expect(readHistory(node({ [route(1, 1)]: { status: 200, body: {} } }).get, "http://beacon", [1], 8192)).rejects.toThrow(/unknown shape/);
    await expect(readHistory(node({ [route(1, 1)]: { status: 200, body: [{}] } }).get, "http://beacon", [1], 8192)).rejects.toThrow(/unknown shape/);
  });
});

describe("fetchJsonGet", () => {
  afterEach(() => vi.restoreAllMocks());

  it("sends the beacon User-Agent and parses JSON, with null for a body that is not JSON", async () => {
    const seen: RequestInit[] = [];
    const fake = (async (_url: string, init: RequestInit) => {
      seen.push(init);
      return seen.length === 1 ? new Response(JSON.stringify({ ok: 1 }), { status: 200 }) : new Response("not json", { status: 404 });
    }) as unknown as typeof fetch;
    const get = fetchJsonGet(fake);
    expect(await get("http://beacon/a")).toEqual({ status: 200, body: { ok: 1 } });
    expect(await get("http://beacon/b")).toEqual({ status: 404, body: null });
    expect((seen[0]?.headers as Record<string, string>)["user-agent"]).toBe(USER_AGENT);
  });

  it("uses the global fetch by default", async () => {
    const spy = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("{}", { status: 200 }));
    expect(await fetchJsonGet()("http://beacon/c")).toEqual({ status: 200, body: {} });
    expect(spy).toHaveBeenCalledOnce();
  });
});
