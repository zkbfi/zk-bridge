import { describe, expect, it } from "vitest";
import { createTimedCache, fetchFinalizedSlot, type Fetcher } from "../../src/lib/beacon";

const answering = (body: unknown, ok = true): Fetcher => async () => ({ ok, json: async () => body });

describe("fetchFinalizedSlot", () => {
  it("reads the slot of the finalized header", async () => {
    const fetcher = answering({ data: { header: { message: { slot: "123456" } } } });
    expect(await fetchFinalizedSlot("http://beacon", fetcher)).toBe(123456);
  });
  it("gives null for an error status, a bad body or a thrown error", async () => {
    expect(await fetchFinalizedSlot("http://beacon", answering({}, false))).toBeNull();
    expect(await fetchFinalizedSlot("http://beacon", answering({ data: {} }))).toBeNull();
    expect(await fetchFinalizedSlot("http://beacon", answering({ data: { header: { message: { slot: "x" } } } }))).toBeNull();
    const failing: Fetcher = async () => {
      throw new Error("down");
    };
    expect(await fetchFinalizedSlot("http://beacon", failing)).toBeNull();
  });
  it("calls the beacon path once for a base URL with a trailing slash", async () => {
    let seen = "";
    const fetcher: Fetcher = async (url) => {
      seen = url;
      return { ok: true, json: async () => ({}) };
    };
    await fetchFinalizedSlot("http://beacon/", fetcher);
    expect(seen).toBe("http://beacon/eth/v1/beacon/headers/finalized");
  });
});

describe("createTimedCache", () => {
  it("reuses a value until it expires", async () => {
    let clock = 0;
    let loads = 0;
    const cache = createTimedCache<number>(100, () => clock);
    const load = async () => ++loads;
    expect(await cache.get("k", load)).toBe(1);
    clock = 99;
    expect(await cache.get("k", load)).toBe(1);
    clock = 101;
    expect(await cache.get("k", load)).toBe(2);
  });
});
