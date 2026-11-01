import { describe, expect, it, vi } from "vitest";
import type { ProverBinary } from "@zk-bridge/shared/prover";
import { runArchiveCycle } from "../src/archive/module.ts";
import { sourceChainIdOf } from "../src/archive/build.ts";
import { RECEIPT_TIMEOUT_MILLISECONDS, createReceiptIndexReader, receiptPositionOf } from "../src/archive/receipt.ts";
import { ARCHIVE_RPC_URLS, makeBackend, makeConfig } from "./support.ts";

const hash = (digit: string) => `0x${digit.repeat(64)}`;
const logs = (...indexes: number[]) => indexes.map((index) => ({ logIndex: `0x${index.toString(16)}` }));

describe("the position of a log inside its receipt", () => {
  it("is the position among the receipt logs, not the index inside the block (the live failure: block index 308)", () => {
    // A transaction late in the block: its logs are numbered 306 to 309 in the block and 0 to 3 in the receipt.
    expect(receiptPositionOf(logs(306, 307, 308, 309), 308)).toBe(2);
    expect(receiptPositionOf(logs(306, 307, 308, 309), 306)).toBe(0);
  });

  it("reads the hex quantity of any case and leaves the logs of a lower number alone", () => {
    expect(receiptPositionOf([{ logIndex: "0x1A" }, { logIndex: "0x1b" }], 27)).toBe(1);
  });

  it("is null when no log of the receipt has that block index", () => {
    expect(receiptPositionOf(logs(306, 307), 0)).toBeNull();
    expect(receiptPositionOf([], 3)).toBeNull();
  });
});

describe("the receipt reader", () => {
  const readerOver = (respond: (body: { method: string; params: unknown[] }, url: string) => Response | Promise<Response>) =>
    createReceiptIndexReader({
      rpcUrls: ARCHIVE_RPC_URLS,
      fetchFunction: () => (async (url: string, init: RequestInit) => respond(JSON.parse(String(init.body)), url)) as unknown as typeof fetch,
    });
  const ask = (reader: ReturnType<typeof readerOver>) => reader.receiptIndexOf({ chainId: 369, transactionHash: hash("3"), blockLogIndex: 308 });
  const answer = (result: unknown) => Response.json({ jsonrpc: "2.0", id: 1, result });

  it("asks the node of the source chain for the receipt and answers the position", async () => {
    const seen: unknown[] = [];
    const reader = readerOver((body, url) => {
      seen.push([url, body.method, body.params]);
      return answer({ logs: logs(300, 308) });
    });
    expect(await ask(reader)).toBe(1);
    expect(seen).toEqual([["https://rpc-369.example.org/", "eth_getTransactionReceipt", [hash("3")]]]);
    expect(RECEIPT_TIMEOUT_MILLISECONDS).toBeGreaterThan(0);
  });

  it("fails for a chain without a node", async () => {
    await expect(readerOver(() => answer({ logs: [] })).receiptIndexOf({ chainId: 5, transactionHash: hash("3"), blockLogIndex: 1 })).rejects.toThrow("no entry for chain 5");
  });

  it.each([
    ["an error status", () => new Response("no", { status: 502 }), "answered 502"],
    ["a JSON-RPC error", () => Response.json({ jsonrpc: "2.0", id: 1, error: { code: -32000, message: "x" } }), "unknown shape"],
    ["a wrong shape", () => answer({ logs: [{ logIndex: 3 }] }), "unknown shape"],
    ["no receipt", () => answer(null), "has no receipt"],
    ["a missing result", () => Response.json({ jsonrpc: "2.0", id: 1 }), "has no receipt"],
    ["a receipt without the log", () => answer({ logs: logs(1, 2) }), "no log with block index 308"],
  ])("fails on %s", async (_name, respond, message) => {
    await expect(ask(readerOver(respond))).rejects.toThrow(message);
  });
});

describe("the archive builds with the receipt index", () => {
  const item = { messageId: hash("a"), sourceChainId: 369, destinationChainId: 1, sentTransactionHash: hash("3"), sentLogIndex: 308, coveredByHeadSlot: "100" };
  const evidence = {
    schemaVersion: 2,
    route: "pulsechain_to_ethereum",
    sourceTransactionHash: hash("3"),
    logIndex: 2,
    message: { messageId: hash("a"), sender: `0x${"7".repeat(40)}`, executor: `0x${"8".repeat(40)}`, gasLimit: 250000, data: "0x" },
    destination: { chainId: 1, bridge: `0x${"b".repeat(40)}`, lightClient: `0x${"c".repeat(40)}` },
    anchor: { slot: 90, root: hash("d") },
    deliveryStatus: "notDelivered",
    alreadyDelivered: false,
    execute: { to: `0x${"b".repeat(40)}`, data: "0xabcdef" },
    prerequisites: [],
    createdAt: "2026-10-28T00:00:00Z",
  };
  const fetchWith = (receipt: unknown) =>
    vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      if (init?.method === "POST") return Response.json({ jsonrpc: "2.0", id: 1, result: receipt });
      const url = new URL(String(input));
      return url.pathname === "/api/undelivered" ? Response.json({ items: [item], nextCursor: null }) : Response.json({}, { status: 404 });
    });
  const setup = (prove: ProverBinary["evidence"]) => {
    const base = makeBackend({ config: makeConfig({ indexerUrl: "http://indexer.test/", rpcUrls: ARCHIVE_RPC_URLS }), enabled: ["archive"] });
    return { ...base, context: { ...base.context, prover: { ...base.prover.binary, evidence: prove } } };
  };

  it("hands the prover the position inside the receipt of the transaction that the indexer's block index 308 names", async () => {
    const prove = vi.fn<ProverBinary["evidence"]>().mockResolvedValue(evidence as never);
    const backend = setup(prove);
    vi.stubGlobal("fetch", fetchWith({ logs: logs(306, 307, 308, 309) }));
    await runArchiveCycle(backend.context);
    expect(prove).toHaveBeenCalledWith({ direction: "second-to-first", transactionHash: hash("3"), logIndex: 2 });
    vi.unstubAllGlobals();
  });

  it("reads the receipt from the node of the source chain of the direction", async () => {
    const prove = vi.fn<ProverBinary["evidence"]>().mockResolvedValue(evidence as never);
    const backend = setup(prove);
    const fetcher = fetchWith({ logs: logs(308) });
    vi.stubGlobal("fetch", fetcher);
    await runArchiveCycle(backend.context);
    expect(fetcher.mock.calls.filter(([, init]) => init?.method === "POST").map(([url]) => String(url))).toEqual(["https://rpc-369.example.org/"]);
    expect(sourceChainIdOf("eth-pls", "first-to-second")).toBe(1);
    expect(sourceChainIdOf("eth-pls", "second-to-first")).toBe(369);
    vi.unstubAllGlobals();
  });

  it("records a failure and does not run the prover when the receipt lacks the log", async () => {
    const prove = vi.fn<ProverBinary["evidence"]>();
    const backend = setup(prove);
    vi.stubGlobal("fetch", fetchWith({ logs: logs(1, 2) }));
    await runArchiveCycle(backend.context);
    expect(prove).not.toHaveBeenCalled();
    const row = backend.storage.database.prepare("SELECT last_error FROM archive_entries").get() as { last_error: string };
    expect(row.last_error).toBe("Error");
    vi.unstubAllGlobals();
  });
});
