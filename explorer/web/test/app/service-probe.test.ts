import { afterEach, describe, expect, it, vi } from "vitest";
import type { HttpClient, HttpRequest } from "@zk-bridge/shared";
import { createProber, fixtureProber, probeIconUrl } from "../../src/app/service-probe";

/** A clock that moves 42 ms between the start and the end of a probe. */
const clock = () => {
  let t = 1_000;
  return () => (t += 21);
};

const answering =
  (status: number, text: string, seen: HttpRequest[] = []): HttpClient =>
  async (request) => {
    seen.push(request);
    return { status, text };
  };

describe("the service probe", () => {
  it("asks a service's /health with a plain GET and passes with the latency", async () => {
    const seen: HttpRequest[] = [];
    const probe = createProber({ http: answering(200, '{"state":"running"}', seen), now: clock() });
    expect(await probe("https://indexer.zkb.fi", { kind: "health" })).toEqual({ ok: true, ms: 21 });
    expect(seen).toEqual([{ url: "https://indexer.zkb.fi/health", method: "GET" }]);
  });

  it("calls a 404 down: the bare base URL is not what it asks, and /health missing is a fault", async () => {
    const result = await createProber({ http: answering(404, "") })("https://prove.zkb.fi/", { kind: "health" });
    expect(result.ok).toBe(false);
    expect(result.ok === false && result.reason).toContain("404");
  });

  it("calls a service down when it does not answer in time", async () => {
    const never: HttpClient = () => new Promise(() => undefined);
    const result = await createProber({ http: never, timeoutMs: 20 })("https://archive.zkb.fi", { kind: "health" });
    expect(result).toEqual({ ok: false, reason: "No answer within 0 s." });
  });

  it("calls a service down when the request fails", async () => {
    const failing: HttpClient = async () => {
      throw new TypeError("Failed to fetch");
    };
    expect((await createProber({ http: failing })("https://archive.zkb.fi", { kind: "health" })).ok).toBe(false);
  });

  it("posts eth_chainId to an RPC and passes only on the expected chain", async () => {
    const seen: HttpRequest[] = [];
    const probe = createProber({ http: answering(200, '{"jsonrpc":"2.0","id":1,"result":"0x171"}', seen), now: clock() });
    expect(await probe("https://one.valve.city/rpc/vk_demo/evm/369", { kind: "rpc", chainId: 369 })).toEqual({ ok: true, ms: 21 });
    expect(seen[0]).toMatchObject({ method: "POST", headers: { "Content-Type": "application/json" } });
    expect(JSON.parse(seen[0]!.body!)).toMatchObject({ method: "eth_chainId" });
    const wrong = await probe("https://one.valve.city/rpc/vk_demo/evm/369", { kind: "rpc", chainId: 1 });
    expect(wrong).toEqual({ ok: false, reason: "The node is on chain 369, not chain 1." });
  });

  it("calls an RPC that answers a GET-style 404 down", async () => {
    expect((await createProber({ http: answering(404, "") })("https://rpc.test", { kind: "rpc", chainId: 1 })).ok).toBe(false);
  });

  it("passes a msgboard node on any JSON-RPC envelope", async () => {
    const probe = createProber({ http: answering(200, '{"jsonrpc":"2.0","id":1,"error":{"code":-32601}}') });
    expect((await probe("wss://board.test", { kind: "jsonrpc" })).ok).toBe(true);
  });

  it("loads one known icon from the image server", async () => {
    const asked: string[] = [];
    const ok = createProber({ loadImage: async (url) => (asked.push(url), true) });
    expect((await ok("https://gib.show/image/{chainId}/{address}", { kind: "image" })).ok).toBe(true);
    expect(asked).toEqual([probeIconUrl("https://gib.show/image/{chainId}/{address}")]);
    expect(asked[0]).toBe("https://gib.show/image/1/0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2");
    const broken = createProber({ loadImage: async () => false });
    expect(await broken("https://img.test/{chainId}/{address}", { kind: "image" })).toEqual({ ok: false, reason: "The image server did not return an icon." });
  });

  it("answers on the sample page without a network, the same latency for the same URL", async () => {
    const first = await fixtureProber("https://a.test", { kind: "health" });
    expect(first.ok).toBe(true);
    expect(await fixtureProber("https://a.test", { kind: "health" })).toEqual(first);
  });
});

describe("the image check in a browser", () => {
  afterEach(() => vi.unstubAllGlobals());

  const stubImage = (outcome: "load" | "error", naturalWidth = 32) => {
    const sources: string[] = [];
    class FakeImage {
      onload: (() => void) | null = null;
      onerror: (() => void) | null = null;
      naturalWidth = naturalWidth;
      set src(value: string) {
        sources.push(value);
        queueMicrotask(() => (outcome === "load" ? this.onload?.() : this.onerror?.()));
      }
    }
    vi.stubGlobal("Image", FakeImage);
    return sources;
  };

  it("passes when the icon loads with a size, and fails on an error or an empty image", async () => {
    const sources = stubImage("load");
    expect((await createProber()("https://gib.show/image/{chainId}/{address}", { kind: "image" })).ok).toBe(true);
    expect(sources).toEqual(["https://gib.show/image/1/0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2"]);
    stubImage("load", 0);
    expect((await createProber()("https://img.test/{chainId}/{address}", { kind: "image" })).ok).toBe(false);
    stubImage("error");
    expect((await createProber()("https://img.test/{chainId}/{address}", { kind: "image" })).ok).toBe(false);
  });
});
