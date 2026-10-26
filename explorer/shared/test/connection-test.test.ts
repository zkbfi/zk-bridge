import { afterEach, describe, expect, it, vi } from "vitest";
import { describeStatus, failOutcome, fetchClient, passOutcome, testIndexerUrl, testRpcChainId, type HttpClient } from "../src/index.js";

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
