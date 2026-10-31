import { describe, expect, it, vi } from "vitest";
import { createFallbackIndexerClient, type FallbackConnectionPort } from "../../src/data/indexer-client";
import { IndexerResponseError } from "../../src/data/json";

const MESSAGE_ID = `0x${"AB".repeat(32)}` as const;
const TRANSACTION = `0x${"cd".repeat(32)}` as const;

type Answer = { status: number; body: unknown };

const portWith = (answer: Answer, overrides: Partial<ReturnType<FallbackConnectionPort["connection"]>> = {}) => {
  const request = vi.fn(async () => answer);
  const connection = {
    baseUrl: "https://indexer.example.org",
    request,
    run: async <value,>(operations: { viaIndexer: () => Promise<value>; viaRpc: () => Promise<value> }) => operations.viaIndexer(),
    rpc: { findMessageByTransaction: vi.fn(async () => null) },
    ...overrides,
  };
  return { port: { connection: () => connection } satisfies FallbackConnectionPort, request, connection };
};

describe("the message read of the fallback client", () => {
  it("asks the newest connection for the lowercase identifier under its own base URL", async () => {
    const { port, request } = portWith({ status: 404, body: null });
    await createFallbackIndexerClient(port).message(MESSAGE_ID);
    expect(request).toHaveBeenCalledWith(`https://indexer.example.org/api/messages/${MESSAGE_ID.toLowerCase()}`);
  });

  it("gives null for status 404, because an unknown message is an answer", async () => {
    const { port } = portWith({ status: 404, body: null });
    expect(await createFallbackIndexerClient(port).message(MESSAGE_ID)).toBeNull();
  });

  it("throws for any other status that is not 200, and names the path but not the host", async () => {
    const { port } = portWith({ status: 500, body: null });
    const failure = createFallbackIndexerClient(port).message(MESSAGE_ID);
    await expect(failure).rejects.toThrow(IndexerResponseError);
    await expect(failure).rejects.toThrow(`The indexer answered 500 for /api/messages/${MESSAGE_ID.toLowerCase()}.`);
  });

  it("refuses a 200 answer that is not a message", async () => {
    const { port } = portWith({ status: 200, body: { nonsense: true } });
    await expect(createFallbackIndexerClient(port).message(MESSAGE_ID)).rejects.toThrow(IndexerResponseError);
  });

  it("reads the connection again at every call, because the runtime rebuilds it", async () => {
    let base = "https://one.example.org";
    const request = vi.fn(async (_url: string) => ({ status: 404, body: null }));
    const client = createFallbackIndexerClient({ connection: () => ({ baseUrl: base, request, run: vi.fn(), rpc: { findMessageByTransaction: vi.fn() } }) } as unknown as FallbackConnectionPort);
    await client.message(MESSAGE_ID);
    base = "https://two.example.org";
    await client.message(MESSAGE_ID);
    expect(request.mock.calls.map(([url]) => new URL(url).host)).toEqual(["one.example.org", "two.example.org"]);
  });
});

describe("the transaction lookup of the fallback client", () => {
  it("runs the GraphQL lookup on the indexer path", async () => {
    const posts: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init: { body: string }) => {
        posts.push(`${url} ${init.body}`);
        return new Response(JSON.stringify({ data: { messagess: { items: [{ messageId: MESSAGE_ID }] } } }), { status: 200 });
      }),
    );
    try {
      const { port } = portWith({ status: 200, body: {} });
      expect(await createFallbackIndexerClient(port).findMessageByTransaction(TRANSACTION)).toBe(MESSAGE_ID);
      expect(posts[0]).toContain("https://indexer.example.org/graphql");
      expect(posts[0]).toContain(TRANSACTION);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("runs the lookup on the chains when the connection takes the RPC path, and gives its answer", async () => {
    const found = vi.fn(async () => MESSAGE_ID);
    const { port } = portWith(
      { status: 200, body: {} },
      {
        run: async <value,>(operations: { viaIndexer: () => Promise<value>; viaRpc: () => Promise<value> }) => operations.viaRpc(),
        rpc: { findMessageByTransaction: found },
      },
    );
    expect(await createFallbackIndexerClient(port).findMessageByTransaction(TRANSACTION)).toBe(MESSAGE_ID);
    expect(found).toHaveBeenCalledWith(TRANSACTION);
  });
});

describe("the transaction cost read of the fallback client", () => {
  const cost = { chainId: 369, hash: TRANSACTION, block: "40", gasUsed: "100000", effectiveGasPriceWei: "1000000000", costWei: "100000000000000", costUsd: null, nativeUsd: null };
  it("asks the indexer's GET /api/tx for the lowercase hash and reads the answer", async () => {
    const { port, request } = portWith({ status: 200, body: cost });
    expect(await createFallbackIndexerClient(port).transactionCost(369, TRANSACTION.toUpperCase().replace("0X", "0x") as `0x${string}`)).toEqual(cost);
    expect(request).toHaveBeenCalledWith(`https://indexer.example.org/api/tx/369/${TRANSACTION}`);
  });
  it("gives null for 404 and throws for any other status", async () => {
    expect(await createFallbackIndexerClient(portWith({ status: 404, body: null }).port).transactionCost(369, TRANSACTION)).toBeNull();
    await expect(createFallbackIndexerClient(portWith({ status: 503, body: null }).port).transactionCost(369, TRANSACTION)).rejects.toThrow(`The indexer answered 503 for /api/tx/369/${TRANSACTION}.`);
  });
});
