import { describe, expect, it } from "vitest";
import { handleRpc, withoutUrls, type ProxyInput } from "../src/rpc-proxy/proxy.ts";
import { selectorsOf, type ChainRules } from "../src/rpc-proxy/rules.ts";
import { DEFAULT_ANY_ADDRESS_FUNCTIONS, DEFAULT_RPC_METHODS, MULTICALL3_ADDRESS } from "../src/rpc-proxy/settings.ts";

const BRIDGE = "0x5897d3de91d59fb691e3887d6ffbba072384293a";
const RULES: ChainRules = {
  chainId: 943,
  methods: new Set(DEFAULT_RPC_METHODS),
  contracts: new Set([BRIDGE]),
  tokens: new Set(),
  maxCallGas: 30_000_000n,
  multicall3: MULTICALL3_ADDRESS.toLowerCase(),
  anyAddressSelectors: selectorsOf(DEFAULT_ANY_ADDRESS_FUNCTIONS),
};
const UPSTREAM = "http://127.0.0.1:8792/zkb/evm/943";

type Sent = { url: string; init: RequestInit };

/** An eRPC that answers each request with `answer(requests)`; records what was sent. */
function fakeErpc(answer: (body: unknown) => Response | Promise<Response>) {
  const sent: Sent[] = [];
  const fetchFunction = (async (url: string, init: RequestInit) => {
    sent.push({ url, init });
    return answer(JSON.parse(String(init.body)));
  }) as unknown as typeof fetch;
  return { sent, fetchFunction };
}

const echo = (body: unknown) => {
  const entries = Array.isArray(body) ? body : [body];
  const results = entries.map((entry: { id: number }) => ({ jsonrpc: "2.0", id: entry.id, result: "0x1" }));
  return Response.json(Array.isArray(body) ? results : results[0]);
};

const input = (bodyText: string, fetchFunction: typeof fetch, overrides: Partial<ProxyInput> = {}): ProxyInput => ({
  bodyText,
  rules: RULES,
  visitorIp: "203.0.113.7",
  upstreamUrl: UPSTREAM,
  maxBatchLength: 3,
  maxResponseBytes: 1024,
  timeoutMilliseconds: 1000,
  fetchFunction,
  ...overrides,
});

const rpc = (id: number | string, method: string, params?: unknown[]) => ({ jsonrpc: "2.0", id, method, ...(params === undefined ? {} : { params }) });
const parse = (body: string) => JSON.parse(body) as unknown;

describe("handleRpc: what is refused before eRPC", () => {
  it("answers a parse error for a body that is not JSON, and an invalid request for an empty batch", async () => {
    const erpc = fakeErpc(echo);
    const notJson = await handleRpc(input("{", erpc.fetchFunction));
    expect(notJson.outcome).toBe("invalid");
    expect(parse(notJson.answer.body)).toEqual({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "the body is not JSON" } });
    const empty = await handleRpc(input("[]", erpc.fetchFunction));
    expect(parse(empty.answer.body)).toEqual({ jsonrpc: "2.0", id: null, error: { code: -32600, message: "the batch is empty" } });
    expect(erpc.sent).toHaveLength(0);
  });

  it("refuses a batch longer than the limit, answering each id", async () => {
    const erpc = fakeErpc(echo);
    const batch = [rpc(1, "eth_chainId"), rpc("b", "eth_chainId"), rpc(3, "eth_chainId"), { jsonrpc: "2.0", method: "eth_chainId" }];
    const { answer, outcome } = await handleRpc(input(JSON.stringify(batch), erpc.fetchFunction));
    expect(outcome).toBe("refused");
    expect(answer.status).toBe(200);
    const errors = parse(answer.body) as { id: unknown; error: { message: string } }[];
    expect(errors.map((error) => error.id)).toEqual([1, "b", 3, null]);
    expect(errors[0]?.error.message).toBe("rpc.zkb.fi refused the batch: it holds 4 requests, and the most it takes is 3");
  });

  it("refuses an entry that is not a JSON-RPC request with an id, and the rest of its batch", async () => {
    const erpc = fakeErpc(echo);
    for (const bad of [{ jsonrpc: "2.0", method: "eth_chainId" }, { jsonrpc: "1.0", id: 2, method: "eth_chainId" }, { jsonrpc: "2.0", id: 2, method: 5 }, { jsonrpc: "2.0", id: 2, method: "eth_call", params: {} }, "x"]) {
      const { answer, outcome } = await handleRpc(input(JSON.stringify([rpc(1, "eth_chainId"), bad]), erpc.fetchFunction));
      expect(outcome).toBe("invalid");
      expect((parse(answer.body) as { error: { code: number } }[]).map((entry) => entry.error.code)).toEqual([-32600, -32600]);
    }
    const single = await handleRpc(input(JSON.stringify({ jsonrpc: "2.0", id: { no: 1 }, method: "eth_chainId" }), erpc.fetchFunction));
    expect(parse(single.answer.body)).toMatchObject({ id: null, error: { code: -32600 } });
    expect(erpc.sent).toHaveLength(0);
  });

  it("refuses one request with its reason, and a batch with one refused request as a whole", async () => {
    const erpc = fakeErpc(echo);
    const single = await handleRpc(input(JSON.stringify(rpc(9, "eth_sendRawTransaction", ["0x00"])), erpc.fetchFunction));
    expect(single.outcome).toBe("refused");
    expect(parse(single.answer.body)).toEqual({
      jsonrpc: "2.0",
      id: 9,
      error: { code: -32601, message: "rpc.zkb.fi refused eth_sendRawTransaction: eth_sendRawTransaction is not served here; rpc.zkb.fi answers only the reads the zkb.fi dapp makes" },
    });
    const batch = await handleRpc(input(JSON.stringify([rpc(1, "eth_blockNumber"), rpc(2, "eth_getLogs", [{}])]), erpc.fetchFunction));
    const [other, own] = parse(batch.answer.body) as { id: number; error: { code: number; message: string } }[];
    expect(own).toMatchObject({ id: 2, error: { code: -32602 } });
    expect(other).toEqual({
      jsonrpc: "2.0",
      id: 1,
      error: { code: -32602, message: "rpc.zkb.fi refused this batch because another request in it was refused: eth_getLogs must name its addresses, all of them zkb.fi contracts or bridged tokens of chain 943" },
    });
    expect(erpc.sent).toHaveLength(0);
  });
});

describe("handleRpc: passing to eRPC", () => {
  it("passes one request with the visitor's address and returns eRPC's answer", async () => {
    const erpc = fakeErpc(echo);
    const { answer, outcome } = await handleRpc(input(JSON.stringify(rpc(4, "eth_chainId")), erpc.fetchFunction));
    expect(outcome).toBe("served");
    expect(answer).toEqual({ status: 200, body: JSON.stringify({ jsonrpc: "2.0", id: 4, result: "0x1" }), headers: { "content-type": "application/json" } });
    expect(erpc.sent[0]?.url).toBe(UPSTREAM);
    expect(erpc.sent[0]?.init.headers).toEqual({ "content-type": "application/json", "x-forwarded-for": "203.0.113.7" });
    expect(parse(String(erpc.sent[0]?.init.body))).toEqual(rpc(4, "eth_chainId", []));
  });

  it("forwards the request rebuilt from what was checked, never the visitor's bytes (duplicate keys, extra fields)", async () => {
    const erpc = fakeErpc(echo);
    const outsider = "0x7777777777777777777777777777777777777777";
    // JSON.parse keeps the last "to"; the filter checks that one, and only that one is forwarded.
    const text = `{"jsonrpc":"2.0","id":1,"method":"eth_call","extra":1,"params":[{"to":"${outsider}","to":"${BRIDGE}","data":"0x","nonsense":true},"latest"]}`;
    const { outcome } = await handleRpc(input(text, erpc.fetchFunction));
    expect(outcome).toBe("served");
    const sent = String(erpc.sent[0]?.init.body);
    expect(sent).toBe(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_call", params: [{ to: BRIDGE, data: "0x" }, "latest"] }));
    expect(sent).not.toContain(outsider);
    const refused = await handleRpc(input(text.replace(`"to":"${BRIDGE}"`, `"TO":"${BRIDGE}"`), erpc.fetchFunction));
    expect(refused.outcome).toBe("refused");
  });

  it("passes a batch, and sends no forwarded header for an unknown visitor", async () => {
    const erpc = fakeErpc(echo);
    const batch = [rpc(1, "eth_chainId"), rpc(2, "eth_getLogs", [{ address: BRIDGE }])];
    const { answer } = await handleRpc(input(JSON.stringify(batch), erpc.fetchFunction, { visitorIp: null }));
    expect((parse(answer.body) as unknown[]).length).toBe(2);
    expect(erpc.sent[0]?.init.headers).toEqual({ "content-type": "application/json" });
    expect(parse(String(erpc.sent[0]?.init.body))).toEqual([rpc(1, "eth_chainId", []), rpc(2, "eth_getLogs", [{ address: BRIDGE }])]);
  });

  it("keeps eRPC's status and Retry-After, and cleans every error: no URL, data only when it is revert data", async () => {
    const erpc = fakeErpc(
      () =>
        new Response(
          JSON.stringify([
            { jsonrpc: "2.0", id: 1, error: { code: -32005, message: "rate limited by https://one.valve.city/rpc/SECRETKEY/evm/943 and wss://x.example/y", data: { upstream: "https://one.valve.city/rpc/SECRETKEY" } } },
            { jsonrpc: "2.0", id: 2, error: { code: 3, message: "execution reverted", data: "0x08c379a0" } },
            { jsonrpc: "2.0", id: 3, error: { message: 7, data: "0xzz" } },
            "odd",
          ]),
          { status: 429, headers: { "retry-after": "5" } },
        ),
    );
    const { answer } = await handleRpc(input(JSON.stringify([rpc(1, "eth_chainId"), rpc(2, "eth_chainId"), rpc(3, "eth_chainId")]), erpc.fetchFunction));
    expect(answer.status).toBe(429);
    expect(answer.headers).toEqual({ "content-type": "application/json", "retry-after": "5" });
    expect(answer.body).not.toContain("SECRETKEY");
    expect(parse(answer.body)).toEqual([
      { jsonrpc: "2.0", id: 1, error: { code: -32005, message: "rate limited by [upstream] and [upstream]" } },
      { jsonrpc: "2.0", id: 2, error: { code: 3, message: "execution reverted", data: "0x08c379a0" } },
      { jsonrpc: "2.0", id: 3, error: { code: -32603, message: "the node answered an error" } },
      "odd",
    ]);
  });

  it("answers 502 with an error per id when eRPC is unreachable, too slow, too large or unreadable", async () => {
    const cases: [typeof fetch, string][] = [
      [(async () => {
        throw new TypeError("fetch failed");
      }) as unknown as typeof fetch, "rpc.zkb.fi could not reach its node"],
      [(async () => {
        throw Object.assign(new Error("timeout"), { name: "TimeoutError" });
      }) as unknown as typeof fetch, "rpc.zkb.fi got no answer from its node in time"],
      [(async () => new Response("x".repeat(2048))) as unknown as typeof fetch, "rpc.zkb.fi got an answer larger than 1024 bytes from its node"],
      [(async () => new Response("<html>bad gateway</html>", { status: 502 })) as unknown as typeof fetch, "rpc.zkb.fi got an answer it could not read from its node (HTTP 502)"],
      [(async () => new Response(null, { status: 204 })) as unknown as typeof fetch, "rpc.zkb.fi got an answer it could not read from its node (HTTP 204)"],
    ];
    for (const [fetchFunction, message] of cases) {
      const { answer, outcome } = await handleRpc(input(JSON.stringify([rpc(1, "eth_chainId"), rpc(2, "eth_blockNumber")]), fetchFunction));
      expect(outcome).toBe("upstream-failed");
      expect(answer.status).toBe(502);
      expect(parse(answer.body)).toEqual([
        { jsonrpc: "2.0", id: 1, error: { code: -32603, message } },
        { jsonrpc: "2.0", id: 2, error: { code: -32603, message } },
      ]);
    }
  });
});

describe("withoutUrls", () => {
  it("removes every URL of any scheme and leaves other text", () => {
    expect(withoutUrls("failed at https://a.example/k?x=1, then ws://b:8545.")).toBe("failed at [upstream] then [upstream]");
    expect(withoutUrls("no address here")).toBe("no address here");
  });
});
