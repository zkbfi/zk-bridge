import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { Worker } from "node:worker_threads";
import { afterEach, describe, expect, it, vi } from "vitest";
import { fromRLP } from "@msgboard/sdk";
import { NONCES_PER_THREAD } from "../src/msgboard/grind-stamper.mjs";

// This file runs real worker threads, so it needs the real worker_threads and the real WASM engine.
vi.unmock("node:worker_threads");
const { grindOnThreads } = await import("../src/msgboard/grind.js");

const servers: Server[] = [];
afterEach(() => {
  for (const server of servers.splice(0)) server.close();
});

/** A node that answers the two calls of a grind. The work factors make the proof of work trivial. */
async function trivialBoard(): Promise<string> {
  const server = createServer((request, response) => {
    let body = "";
    request.on("data", (chunk) => (body += chunk));
    request.on("end", () => {
      const { id, method } = JSON.parse(body) as { id: number; method: string };
      const result = method === "msgboard_status" ? { enabled: true, count: "0x0", size: "0x0", workMultiplier: "0x1", workDivisor: "0xf4240" } : { hash: `0x${"ab".repeat(32)}`, number: "0x10" };
      response.setHeader("content-type", "application/json");
      response.end(JSON.stringify({ jsonrpc: "2.0", id, result }));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  servers.push(server);
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

describe("grindOnThreads with real worker threads", () => {
  it("has every worker search a range of nonces of its own, and returns a message the board accepts", async () => {
    const boardUrl = await trivialBoard();
    const input = { boardUrl, category: `0x${"11".repeat(32)}`, payload: "0xdeadbeef", timeoutMilliseconds: 60_000 } as const;
    const single = await grindOnThreads(input, 1);
    expect(single.nonce).toBeLessThan(BigInt(NONCES_PER_THREAD));
    // With one thread the search starts at 0. With several, a thread other than the first may win, and then the nonce
    // lies in its range. Whatever wins, the nonce belongs to the range of one of the threads and the message is whole.
    const many = await grindOnThreads(input, 4);
    expect(many.threads).toBe(4);
    expect(many.nonce).toBeLessThan(BigInt(4 * NONCES_PER_THREAD));
    expect(fromRLP(many.rlp)).toMatchObject({ category: input.category, data: input.payload, nonce: many.nonce });
  });

  it("starts the worker of thread 2 at the first nonce of the third range", async () => {
    const url = await trivialBoard();
    const worker = new Worker(new URL("../src/msgboard/grind-worker.mjs", import.meta.url), {
      workerData: { url, category: `0x${"11".repeat(32)}`, payload: "0xdeadbeef", timeoutMilliseconds: 60_000, threadIndex: 2 },
    });
    const reply = await new Promise<{ ok: boolean; nonce: string }>((resolve) => worker.once("message", resolve));
    void worker.terminate();
    expect(reply.ok).toBe(true);
    expect(BigInt(reply.nonce)).toBeGreaterThanOrEqual(BigInt(2 * NONCES_PER_THREAD));
    expect(BigInt(reply.nonce)).toBeLessThan(BigInt(3 * NONCES_PER_THREAD));
  });
});
