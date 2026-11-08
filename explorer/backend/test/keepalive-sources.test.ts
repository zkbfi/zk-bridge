import { afterEach, describe, expect, it, vi } from "vitest";
import { zeroHash } from "viem";
import { archiveSource, fetchJsonGet, handoffSources, hostOf, localArchiveSource, readHistory, readHistoryFrom, readLightClient, readSource, USER_AGENT, type HandoffSource, type JsonGet } from "../src/keepalive/sources.ts";

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

describe("the handoff sources of a missed period (2026-11-07)", () => {
  const SLOTS = 8192;
  const updatesPath = (start: number, count: number) => `/eth/v1/beacon/light_client/updates?start_period=${start}&count=${count}`;
  const statePath = (period: number) => `/eth/v1/beacon/states/${(period + 1) * SLOTS - 1}/finality_checkpoints`;
  const recordOf = (chainId: number, period: number) => ({ format: "zkb-handoff-update/1", chainId, period });

  /** A fake web: each host answers from its own map; a host listed in `down` cannot be reached. */
  function web(hosts: Record<string, Record<string, { status: number; body: unknown }>>, down: readonly string[] = []) {
    const asked: string[] = [];
    const get: JsonGet = async (url) => {
      const parsed = new URL(url);
      asked.push(`${parsed.host}${parsed.pathname}${parsed.search}`);
      if (down.includes(parsed.host)) throw new Error("connect ECONNREFUSED");
      return hosts[parsed.host]?.[`${parsed.pathname}${parsed.search}`] ?? { status: 404, body: null };
    };
    return { asked, get };
  }

  const endpoints = { chainId: 943, beaconUrl: "https://main.example/key/943", stateUrls: ["https://states.example"], handoffUrls: ["https://more.example"], archiveUrls: ["https://archive.example/api/proofs/handoffs"] };

  it("names hosts only", () => {
    expect(hostOf("https://user:secret@main.example:8443/key/943?x=1")).toBe("main.example:8443");
    expect(hostOf("not a url")).toBe("an endpoint");
  });

  it("first fails, second serves: the main node lacks the period and the next handoff URL has it", async () => {
    const fake = web({ "main.example": { "/key/943/eth/v1/beacon/light_client/updates?start_period=5&count=1": { status: 200, body: [] } }, "more.example": { [updatesPath(5, 1)]: { status: 200, body: [update(5 * SLOTS + 10)] } } });
    expect(await readHistoryFrom(handoffSources(fake.get, endpoints), [5], SLOTS)).toEqual({ kind: "serves" });
    // The main node serves the route, so its states and the state URL are not asked.
    expect(fake.asked).toEqual(["main.example/key/943/eth/v1/beacon/light_client/updates?start_period=5&count=1", `more.example${updatesPath(5, 1)}`]);
  });

  it("asks the states when the node lacks the route (chain 943), and they serve", async () => {
    const fake = web({ "states.example": { [statePath(5)]: { status: 200, body: {} }, [statePath(6)]: { status: 200, body: {} } } });
    expect(await readHistoryFrom(handoffSources(fake.get, endpoints), [5, 6], SLOTS)).toEqual({ kind: "serves" });
    expect(fake.asked).toContain(`main.example/key/943${statePath(5)}`);
    expect(fake.asked).not.toContain(`more.example${updatesPath(5, 2)}`);
  });

  it("the archive serves when no beacon node has the period", async () => {
    const fake = web({ "archive.example": { "/api/proofs/handoffs/943/5.json": { status: 200, body: recordOf(943, 5) } } });
    expect(await readHistoryFrom(handoffSources(fake.get, endpoints), [5], SLOTS)).toEqual({ kind: "serves" });
  });

  it("all fail: stranded with what each source answered, by host", async () => {
    const fake = web({ "archive.example": { "/api/proofs/handoffs/943/5.json": { status: 200, body: recordOf(943, 4) } } });
    const history = await readHistoryFrom(handoffSources(fake.get, { ...endpoints, local: () => false }), [5], SLOTS);
    expect(history).toEqual({
      kind: "missing",
      period: 5,
      tried: [
        "main.example (light_client/updates): does not serve the route (404 or 501)",
        `main.example (states): no state at slot ${6 * SLOTS - 1} (answered 404)`,
        `states.example (states): no state at slot ${6 * SLOTS - 1} (answered 404)`,
        "more.example (light_client/updates): does not serve the route (404 or 501)",
        `more.example (states): no state at slot ${6 * SLOTS - 1} (answered 404)`,
        "this backend (handoff archive): no record of period 5",
        "archive.example (handoff archive): period 5: not a handoff record of the period",
      ],
    });
    expect(JSON.stringify(history)).not.toContain("key");
  });

  it("a source that cannot answer makes the read fail instead of calling the light client stranded", async () => {
    const fake = web({}, ["archive.example", "more.example"]);
    await expect(readHistoryFrom(handoffSources(fake.get, endpoints), [5], SLOTS)).rejects.toThrow(/no source answered for period 5, and some could not be read: more.example \(light_client\/updates\): connect ECONNREFUSED; archive.example \(handoff archive\): connect ECONNREFUSED/);
  });

  it("a beacon node that answers an error is asked for its states too", async () => {
    const fake = web({ "main.example": { "/key/943/eth/v1/beacon/light_client/updates?start_period=5&count=1": { status: 500, body: null }, [`/key/943${statePath(5)}`]: { status: 200, body: {} } } });
    expect(await readHistoryFrom(handoffSources(fake.get, { ...endpoints, stateUrls: [], handoffUrls: [], archiveUrls: [] }), [5], SLOTS)).toEqual({ kind: "serves" });
  });

  it("a state probe that cannot be reached counts as no state", async () => {
    const fake = web({}, ["states.example"]);
    const history = await readHistoryFrom(handoffSources(fake.get, { ...endpoints, handoffUrls: [], archiveUrls: [] }), [5], SLOTS);
    expect(history.kind === "missing" && history.tried).toContain(`states.example (states): no state at slot ${6 * SLOTS - 1} (answered nothing)`);
  });

  it("a node that pruned some periods gives the rest, and the archive the others", async () => {
    const fake = web({
      "main.example": { "/key/943/eth/v1/beacon/light_client/updates?start_period=5&count=2": { status: 200, body: [update(6 * SLOTS + 1)] }, "/key/943/eth/v1/beacon/light_client/updates?start_period=5&count=3": { status: 200, body: [update(6 * SLOTS + 1)] }, "/key/943/eth/v1/beacon/light_client/updates?start_period=7&count=1": { status: 200, body: [] } },
      "archive.example": { "/api/proofs/handoffs/943/5.json": { status: 200, body: recordOf(943, 5) } },
    });
    const sources = handoffSources(fake.get, { ...endpoints, handoffUrls: [] });
    expect(await readHistoryFrom(sources, [5, 6], SLOTS)).toEqual({ kind: "serves" });
    const all = await readHistoryFrom(handoffSources(fake.get, { ...endpoints, handoffUrls: [] }), [5, 6, 7], SLOTS);
    expect(all).toMatchObject({ kind: "missing", period: 7 });
    expect(all.kind === "missing" && all.tried?.[0]).toBe("main.example (light_client/updates): no update for periods 5, 7");
  });

  it("each kind of source says what it has", async () => {
    const local: HandoffSource = localArchiveSource((period) => period === 3);
    expect(await local.ask([3], SLOTS)).toEqual({ served: [3], answer: "has period 3" });
    const archive = archiveSource(web({ "a.example": { "/943/3.json": { status: 200, body: recordOf(943, 3) }, "/943/4.json": { status: 200, body: recordOf(943, 4) } } }).get, "https://a.example/", 943);
    expect(await archive.ask([3, 4], SLOTS)).toEqual({ served: [3, 4], answer: "has periods 3, 4" });
    expect(await archive.ask([5], SLOTS)).toEqual({ served: [], answer: "period 5: answered 404" });
    const otherChain = archiveSource(web({ "a.example": { "/1/3.json": { status: 200, body: recordOf(943, 3) } } }).get, "https://a.example", 1);
    expect((await otherChain.ask([3], SLOTS)).served).toEqual([]);
    const nullBody = archiveSource(web({ "a.example": { "/1/3.json": { status: 200, body: null } } }).get, "https://a.example", 1);
    expect((await nullBody.ask([3], SLOTS)).answer).toBe("period 3: not a handoff record of the period");
    const states = handoffSources(web({ "m.example": { [statePath(3)]: { status: 200, body: {} } } }).get, { chainId: 1, beaconUrl: "https://m.example", stateUrls: [], handoffUrls: [], archiveUrls: [] });
    await states[0]?.ask([3], SLOTS);
    expect(await states[1]?.ask([3], SLOTS)).toEqual({ served: [3], answer: "holds the states of period 3" });
    const updates = handoffSources(web({ "m.example": { [updatesPath(3, 1)]: { status: 200, body: [update(3 * SLOTS)] } } }).get, { chainId: 1, beaconUrl: "https://m.example", stateUrls: [], handoffUrls: [], archiveUrls: [] });
    expect(await updates[0]?.ask([3], SLOTS)).toEqual({ served: [3], answer: "has period 3" });
    expect(await updates[1]?.ask([3], SLOTS)).toEqual({ served: [], answer: "not asked: the beacon node serves light_client/updates, so updates are not built from states" });
  });

  it("needs nothing when no period is missing, and passes a thrown non-error on", async () => {
    expect(await readHistoryFrom([], [], SLOTS)).toEqual({ kind: "not-needed" });
    const odd: HandoffSource = {
      label: "odd",
      ask: async () => {
        throw "text";
      },
    };
    await expect(readHistoryFrom([odd], [1], SLOTS)).rejects.toThrow("some could not be read: text");
    const throwsText = web({}, []);
    const failing: JsonGet = async () => {
      throw "plain";
    };
    await expect(readHistoryFrom(handoffSources(failing, { chainId: 1, beaconUrl: "https://m.example", stateUrls: [], handoffUrls: [], archiveUrls: ["https://a.example"] }), [1], SLOTS)).rejects.toThrow(/m.example \(light_client\/updates\): plain; a.example \(handoff archive\): plain/);
    expect(throwsText.asked).toEqual([]);
  });
});
