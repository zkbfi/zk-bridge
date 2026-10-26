import { afterEach, describe, expect, it, vi } from "vitest";
import { getAbiItem, type AbiEvent } from "viem";
import { createHttpChainReader, createViemChainReader, messageBridgeAbi, type ViemClientLike } from "../src/index.js";

const event = getAbiItem({ abi: messageBridgeAbi, name: "AffirmationCompleted" }) as AbiEvent;
const bridge = "0x00000000000000000000000000000000000000b1";

afterEach(() => vi.unstubAllGlobals());

const fakeClient = (): ViemClientLike & { calls: Record<string, unknown[]> } => {
  const calls: Record<string, unknown[]> = {};
  const note = (name: string, value: unknown) => (calls[name] = [...(calls[name] ?? []), value]);
  return {
    calls,
    getChainId: async () => 369,
    getBlock: async (arguments_) => {
      note("getBlock", arguments_);
      return "blockTag" in arguments_ ? { number: 9n, timestamp: 90n } : { number: arguments_.blockNumber, timestamp: 5n, baseFeePerGas: 7n };
    },
    getLogs: async (arguments_) => {
      note("getLogs", arguments_);
      return [
        {
          eventName: "AffirmationCompleted",
          address: "0x00000000000000000000000000000000000000B1",
          blockNumber: 4n,
          logIndex: 2,
          transactionHash: `0x${"ab".repeat(32)}`,
          args: { sender: "0xAbCdef0000000000000000000000000000000001", status: true, messageId: `0x${"cd".repeat(32)}` },
        },
      ];
    },
    readContract: async (call) => {
      note("readContract", call);
      return 42n;
    },
    getTransactionReceipt: async () => ({
      from: "0xAbCdef0000000000000000000000000000000002",
      blockNumber: 4n,
      gasUsed: 21_000n,
      effectiveGasPrice: 3n,
      logs: [{ address: "0x00000000000000000000000000000000000000B1", topics: [`0x${"11".repeat(32)}`] }],
    }),
  };
};

describe("createViemChainReader", () => {
  it("passes the chain identifier through", async () => {
    expect(await createViemChainReader(fakeClient()).getChainId()).toBe(369);
  });

  it("reads a block by number or by tag and gives a missing base fee as null", async () => {
    const client = fakeClient();
    const reader = createViemChainReader(client);
    expect(await reader.getBlock({ blockNumber: 4n })).toEqual({ number: 4n, timestamp: 5n, baseFeePerGas: 7n });
    expect(await reader.getBlock({ tag: "finalized" })).toEqual({ number: 9n, timestamp: 90n, baseFeePerGas: null });
    expect(client.calls.getBlock).toEqual([{ blockNumber: 4n }, { blockTag: "finalized" }]);
  });

  it("reads logs in strict mode and gives every address in lowercase, because the indexer stores lowercase", async () => {
    const client = fakeClient();
    const logs = await createViemChainReader(client).getLogs({ address: bridge, events: [event], fromBlock: 1n, toBlock: 9n });
    expect(client.calls.getLogs).toEqual([{ address: bridge, events: [event], fromBlock: 1n, toBlock: 9n, strict: true }]);
    expect(logs).toEqual([
      {
        eventName: "AffirmationCompleted",
        address: bridge,
        blockNumber: 4n,
        logIndex: 2,
        transactionHash: `0x${"ab".repeat(32)}`,
        args: { sender: "0xabcdef0000000000000000000000000000000001", status: true, messageId: `0x${"cd".repeat(32)}` },
      },
    ]);
  });

  it("keeps a log with no arguments, and reads views and receipts", async () => {
    const client = fakeClient();
    client.getLogs = async () => [{ eventName: "A", address: bridge, blockNumber: 1n, logIndex: 0, transactionHash: `0x${"01".repeat(32)}`, args: undefined }];
    const reader = createViemChainReader(client);
    expect((await reader.getLogs({ address: bridge, events: [event], fromBlock: 1n, toBlock: 1n }))[0]?.args).toEqual({});
    expect(await reader.readContract({ address: bridge, abi: messageBridgeAbi, functionName: "depositsOpen" })).toBe(42n);
    expect(await reader.getTransactionReceipt(`0x${"ab".repeat(32)}`)).toEqual({
      from: "0xabcdef0000000000000000000000000000000002",
      blockNumber: 4n,
      gasUsed: 21_000n,
      effectiveGasPrice: 3n,
      logs: [{ address: bridge, topics: [`0x${"11".repeat(32)}`] }],
    });
  });
});

describe("createHttpChainReader", () => {
  it("opens no connection until the first call, then sends JSON-RPC to the URL", async () => {
    const requests: { url: string; body: { method: string; params: unknown[] } }[] = [];
    const fetchMock = vi.fn(async (url: string, init: { body: string }) => {
      const body = JSON.parse(init.body) as { id: number; method: string; params: unknown[] };
      requests.push({ url, body });
      return new Response(JSON.stringify({ jsonrpc: "2.0", id: body.id, result: "0x171" }), { status: 200, headers: { "content-type": "application/json" } });
    });
    vi.stubGlobal("fetch", fetchMock);
    const reader = createHttpChainReader({ chainId: 369, name: "pulsechain", url: "https://rpc.example.org/v3/FAKEKEY1234567890" });
    expect(fetchMock).not.toHaveBeenCalled();
    expect(await reader.getChainId()).toBe(369);
    expect(requests[0]?.url).toBe("https://rpc.example.org/v3/FAKEKEY1234567890");
    expect(requests[0]?.body.method).toBe("eth_chainId");
  });
});
