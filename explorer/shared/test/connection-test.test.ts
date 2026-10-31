import { afterEach, describe, expect, it, vi } from "vitest";
import { describeStatus, failOutcome, fetchClient, fetchClientWithin, passOutcome, testBeaconGenesis, testHealthUrl, testIndexerUrl, testJsonRpcUrl, testRpcChainId, type HttpClient } from "../src/index.js";

const KEY = "FAKEKEY1234567890";
const rpcUrl = `https://rpc.example.org/v3/${KEY}`;
const answering = (status: number, text: string): HttpClient => async () => ({ status, text });

afterEach(() => vi.unstubAllGlobals());

describe("fetchClient", () => {
  it("sends the method, the headers and the body, and returns the status and the text", async () => {
    const fetchMock = vi.fn(async () => new Response("answer text", { status: 201 }));
    vi.stubGlobal("fetch", fetchMock);
    const result = await fetchClient({ url: "http://x.test/a", method: "POST", headers: { "X-One": "1" }, body: '{"a":1}' });
    expect(result).toEqual({ status: 201, text: "answer text" });
    expect(fetchMock).toHaveBeenCalledWith("http://x.test/a", expect.objectContaining({ method: "POST", headers: { "X-One": "1" }, body: '{"a":1}', signal: expect.any(AbortSignal) }));
  });

  it("sends no headers and no body when the request has none, and cuts a long answer", async () => {
    const fetchMock = vi.fn(async () => new Response("x".repeat(5000), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    const result = await fetchClient({ url: "http://x.test/b", method: "GET" });
    expect(result.text).toHaveLength(2000);
    const init = (fetchMock.mock.calls[0] as unknown as [string, Record<string, unknown>])[1];
    expect(init).not.toHaveProperty("headers");
    expect(init).not.toHaveProperty("body");
  });
});

describe("outcomes", () => {
  it("passOutcome keeps the message and failOutcome removes the secrets from it", () => {
    expect(passOutcome("fine")).toEqual({ ok: "pass", message: "fine" });
    expect(failOutcome(`bad ${rpcUrl}`, [rpcUrl])).toEqual({ ok: "fail", message: expect.not.stringContaining(KEY) });
  });
});

describe("describeStatus", () => {
  it.each([
    [401, "", "check the API key"],
    [403, "", "check the API key"],
    [404, "", "check the address"],
    [503, "", "No worker is available"],
    [200, "no workers available", "No worker is available"],
    [502, "bad gateway", "answered the request with 502: bad gateway"],
  ])("explains status %i", (status, text, expected) => {
    expect(describeStatus({ status, text }, "the request")).toContain(expected);
  });
});

describe("testRpcChainId", () => {
  const input = { rpcUrl, expectedChainId: 369 };

  it("passes when the node reports the expected chain", async () => {
    expect(await testRpcChainId(answering(200, '{"result":"0x171"}'), input)).toEqual({ ok: "pass", message: "The node reports chain 369." });
  });

  it("refuses a node of another chain and says which chain it is", async () => {
    expect(await testRpcChainId(answering(200, '{"result":"0x1"}'), input)).toEqual({ ok: "fail", message: "The node is on chain 1, not chain 369." });
  });

  it("refuses an answer with no chain identifier, and a status that is not 200", async () => {
    expect(await testRpcChainId(answering(200, "{}"), input)).toEqual({ ok: "fail", message: "The node returned no chain identifier." });
    expect((await testRpcChainId(answering(502, "bad"), input)).message).toBe("The server answered eth_chainId with 502: bad");
  });

  it("sends eth_chainId to the URL and keeps the key out of a failure message", async () => {
    const requests: Parameters<HttpClient>[0][] = [];
    const ok: HttpClient = async (request) => {
      requests.push(request);
      return { status: 200, text: '{"result":"0x171"}' };
    };
    await testRpcChainId(ok, input);
    expect(requests[0]).toMatchObject({ url: rpcUrl, method: "POST" });
    expect(JSON.parse(requests[0]?.body ?? "{}")).toMatchObject({ method: "eth_chainId" });
    const broken: HttpClient = async (request) => {
      throw new Error(`connect failed for ${request.url}`);
    };
    const failed = await testRpcChainId(broken, input);
    expect(failed.ok).toBe("fail");
    expect(failed.message).not.toContain(KEY);
  });
});

describe("testIndexerUrl", () => {
  const input = { indexerUrl: `http://localhost:42069/${KEY}/` };

  it("passes when /api/heads answers with a list of heads, and asks the right path", async () => {
    const requests: string[] = [];
    const http: HttpClient = async (request) => {
      requests.push(request.url);
      return { status: 200, text: '{"heads":[]}' };
    };
    expect(await testIndexerUrl(http, input)).toEqual({ ok: "pass", message: "The indexer answers /api/heads." });
    expect(requests).toEqual([`http://localhost:42069/${KEY}/api/heads`]);
  });

  it("refuses a server that is not an explorer indexer", async () => {
    const result = await testIndexerUrl(answering(200, '{"hello":1}'), input);
    expect(result).toMatchObject({ ok: "fail", message: expect.stringContaining("not an explorer indexer") });
  });

  it("refuses a bad status and a failure, and keeps the URL out of the message", async () => {
    expect((await testIndexerUrl(answering(500, "boom"), input)).ok).toBe("fail");
    const broken: HttpClient = async (request) => {
      throw new Error(`cannot reach ${request.url}`);
    };
    const failed = await testIndexerUrl(broken, input);
    expect(failed.ok).toBe("fail");
    expect(failed.message).not.toContain(KEY);
  });
});

describe("fetchClientWithin", () => {
  it("gives up after its own time limit", async () => {
    const fetchMock = vi.fn(async () => new Response("ok", { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    await fetchClientWithin(1234)({ url: "http://x.test/c", method: "GET" });
    expect(fetchMock).toHaveBeenCalledWith("http://x.test/c", expect.objectContaining({ signal: expect.any(AbortSignal) }));
  });
});

describe("testHealthUrl", () => {
  it("asks /health of the base URL and passes on any 2xx", async () => {
    const seen: string[] = [];
    const http: HttpClient = async (request) => {
      seen.push(request.url);
      return { status: 200, text: "{}" };
    };
    expect((await testHealthUrl(http, { baseUrl: "https://indexer.zkb.fi/" })).ok).toBe("pass");
    expect(seen).toEqual(["https://indexer.zkb.fi/health"]);
    expect((await testHealthUrl(answering(204, ""), { baseUrl: "https://a.test" })).ok).toBe("pass");
  });

  it("fails on 404 and on an error, without the URL in the message", async () => {
    const notFound = await testHealthUrl(answering(404, ""), { baseUrl: rpcUrl });
    expect(notFound).toMatchObject({ ok: "fail" });
    expect(notFound.message).toContain("404");
    const down = await testHealthUrl(async () => {
      throw new Error(`fetch failed for ${rpcUrl}`);
    }, { baseUrl: rpcUrl });
    expect(down.ok).toBe("fail");
    expect(down.message).not.toContain(KEY);
  });
});

describe("testJsonRpcUrl", () => {
  it("passes on a result or an error envelope, and turns a websocket URL into http", async () => {
    const seen: string[] = [];
    const http: HttpClient = async (request) => {
      seen.push(request.url);
      return { status: 200, text: '{"jsonrpc":"2.0","id":1,"error":{"code":-32601,"message":"no method"}}' };
    };
    expect((await testJsonRpcUrl(http, { url: "wss://board.test/rpc" })).ok).toBe("pass");
    expect(seen).toEqual(["https://board.test/rpc"]);
    expect((await testJsonRpcUrl(answering(200, '{"jsonrpc":"2.0","id":1,"result":"0x1"}'), { url: "ws://b.test" })).ok).toBe("pass");
  });

  it("fails on a status, on an answer that is not JSON-RPC, and on an error", async () => {
    expect((await testJsonRpcUrl(answering(404, ""), { url: "https://b.test" })).ok).toBe("fail");
    expect((await testJsonRpcUrl(answering(200, "{}"), { url: "https://b.test" })).ok).toBe("fail");
    expect((await testJsonRpcUrl(answering(200, "<html>"), { url: "https://b.test" })).ok).toBe("fail");
  });
});

describe("testBeaconGenesis", () => {
  const root = `0x${"d8".repeat(32)}`;
  const genesis = (validatorsRoot: string) => JSON.stringify({ data: { genesis_time: "1655733600", genesis_validators_root: validatorsRoot, genesis_fork_version: "0x90000069" } });

  it("asks /eth/v1/beacon/genesis below the base URL, without a trailing slash", async () => {
    const http = vi.fn(async () => ({ status: 200, text: genesis(root) }));
    await testBeaconGenesis(http, { beaconUrl: "https://beacon.test/api/", expectedGenesisValidatorsRoot: root });
    expect(http).toHaveBeenCalledWith({ url: "https://beacon.test/api/eth/v1/beacon/genesis", method: "GET" });
  });

  it("passes when the genesis validators root is the chain's, in any letter case", async () => {
    const upper = `0x${"D8".repeat(32)}`;
    expect(await testBeaconGenesis(answering(200, genesis(upper)), { beaconUrl: "https://b.test", expectedGenesisValidatorsRoot: root })).toEqual({
      ok: "pass",
      message: "The beacon node serves this chain's genesis.",
    });
  });

  it("fails when the node is on another beacon chain", async () => {
    const outcome = await testBeaconGenesis(answering(200, genesis(`0x${"4b".repeat(32)}`)), { beaconUrl: "https://b.test", expectedGenesisValidatorsRoot: root });
    expect(outcome).toEqual({ ok: "fail", message: "The beacon node is on another chain: its genesis validators root differs." });
  });

  it("passes on any genesis when no root is known for the chain", async () => {
    expect((await testBeaconGenesis(answering(200, genesis(root)), { beaconUrl: "https://b.test", expectedGenesisValidatorsRoot: null })).ok).toBe("pass");
  });

  it("fails on an error status, an answer with no genesis, and a refused request, and never repeats a key in the URL", async () => {
    const keyedBeacon = `https://beacon.test/${KEY}`;
    const refused = await testBeaconGenesis(answering(403, '{"error":"The beacon surface requires a non-public key"}'), { beaconUrl: keyedBeacon, expectedGenesisValidatorsRoot: root });
    expect(refused).toEqual({ ok: "fail", message: expect.stringContaining("403") });
    expect((await testBeaconGenesis(answering(200, "{}"), { beaconUrl: "https://b.test", expectedGenesisValidatorsRoot: null })).ok).toBe("fail");
    expect((await testBeaconGenesis(answering(200, "<html>"), { beaconUrl: "https://b.test", expectedGenesisValidatorsRoot: null })).ok).toBe("fail");
    const failing: HttpClient = async () => {
      throw new Error(`connect failed to ${keyedBeacon}`);
    };
    const thrown = await testBeaconGenesis(failing, { beaconUrl: keyedBeacon, expectedGenesisValidatorsRoot: root });
    expect(thrown.ok).toBe("fail");
    expect(thrown.message).not.toContain(KEY);
  });
});
