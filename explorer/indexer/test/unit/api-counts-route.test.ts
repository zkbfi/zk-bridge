import { Hono } from "hono";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { bridgeStates, escrow, headUpdates, messages, tokens, transfers } from "../../ponder.schema";
import { cachedFor, resetBrowseCache } from "../../src/api/browse-cache";
import { registerCountsRoute } from "../../src/api/routes/counts";
import { calls, respondWith, type QueryCall } from "./support/fake-api";
import { addressOf } from "./support/handler-fixtures";

const app = new Hono();
registerCountsRoute(app);

const get = async () => {
  const response = await app.request("/api/counts");
  return { status: response.status, body: (await response.json()) as Record<string, any> };
};

const group = (sourceChainId: number, destinationChainId: number, kind: string, status: string, count: number) => ({ sourceChainId, destinationChainId, kind, status, count });

const serve = (answers: { messages?: unknown[]; updates?: unknown[]; tokens?: unknown[]; open?: unknown[]; escrow?: unknown[]; transfers?: unknown[] }) =>
  respondWith((call: QueryCall) => {
    if (call.table === messages) return call.fields !== undefined && "sourceChainId" in call.fields ? (answers.messages ?? []) : [{ address: addressOf("a3"), count: 2, last: "10" }];
    if (call.table === headUpdates) return call.fields !== undefined && "chainId" in call.fields ? (answers.updates ?? []) : [{ address: addressOf("f1"), count: 3, last: "20" }];
    if (call.table === tokens) return answers.tokens ?? [];
    if (call.table === bridgeStates) return answers.open ?? [];
    if (call.table === escrow) return answers.escrow ?? [];
    // The first read of transfers groups them by sender, the second by recipient.
    if (call.table === transfers) return calls.filter((other) => other.table === transfers).indexOf(call) === 0 ? [{ address: addressOf("a1"), count: 4, last: "30" }] : [{ address: addressOf("a2"), count: 1, last: "5" }];
    return [];
  });

beforeEach(() => {
  resetBrowseCache();
  vi.useFakeTimers();
  vi.setSystemTime(new Date(7_000_000));
});

describe("GET /api/counts", () => {
  it("counts the messages per status, kind and direction, and how many are in flight", async () => {
    serve({
      messages: [
        group(1, 369, "token", "sent", 3),
        group(1, 369, "token", "delivered", 100),
        group(1, 369, "message", "covered", 1),
        group(369, 1, "token", "waiting_for_finality", 2),
        group(369, 1, "token", "release_failed", 4),
      ],
    });
    const { status, body } = await get();
    expect(status).toBe(200);
    expect(body.asOf).toBe(7000);
    expect(body.messages).toEqual({
      total: 110,
      inFlight: 6,
      transfers: 109,
      plain: 1,
      byStatus: { sent: 3, waiting_for_finality: 2, covered: 1, delivered: 100, release_failed: 4 },
      directions: [
        { sourceChainId: 1, destinationChainId: 369, total: 104, inFlight: 4 },
        { sourceChainId: 369, destinationChainId: 1, total: 6, inFlight: 2 },
      ],
    });
  });

  it("counts a status that a newer indexer wrote and this build does not list", async () => {
    serve({ messages: [group(1, 369, "token", "paused", 2)] });
    const { body } = await get();
    expect(body.messages).toMatchObject({ total: 2, inFlight: 0, byStatus: { paused: 2, sent: 0 } });
  });

  it("counts light client updates and tokens per chain, with native tokens apart from bridged copies", async () => {
    serve({
      updates: [{ chainId: 1, count: 140 }, { chainId: 369, count: 81 }],
      tokens: [{ chainId: 1, isBridgedCopy: false, count: 2 }, { chainId: 369, isBridgedCopy: true, count: 1 }, { chainId: 369, isBridgedCopy: false, count: 3 }],
    });
    const { body } = await get();
    expect(body.lightClientUpdates).toEqual({ total: 221, chains: [{ chainId: 1, count: 140 }, { chainId: 369, count: 81 }] });
    expect(body.tokens).toEqual({
      total: 6,
      chains: [{ chainId: 1, total: 2, native: 2, copies: 0 }, { chainId: 369, total: 4, native: 3, copies: 1 }],
    });
  });

  it("counts the unique addresses by what they did, the contracts, the gates that are open and the escrow entries", async () => {
    serve({ open: [{ count: 1 }], escrow: [{ count: 9 }] });
    const { body } = await get();
    expect(body.addresses).toEqual({ total: 4, senders: 2, recipients: 1, posters: 1 });
    expect(body.gates).toEqual({ total: 2, open: 1 });
    expect(body.escrow).toEqual({ entries: 9 });
    expect(body.contracts).toBeGreaterThanOrEqual(12);
    expect(body.pair).toEqual(expect.any(String));
  });

  it("answers zero for tables that answer nothing", async () => {
    respondWith(() => []);
    const { body } = await get();
    expect(body).toMatchObject({ messages: { total: 0, inFlight: 0 }, addresses: { total: 0 }, gates: { open: 0 }, escrow: { entries: 0 } });
  });

  it("scans once for readers inside ten seconds", async () => {
    serve({});
    await get();
    const scans = calls.length;
    await get();
    expect(calls.length).toBe(scans);
    vi.setSystemTime(new Date(7_000_000 + 10_000));
    await get();
    expect(calls.length).toBe(scans * 2);
  });
});

describe("the browse cache", () => {
  it("forgets an answer that failed, so the next reader asks again", async () => {
    resetBrowseCache();
    await expect(cachedFor("k", () => Promise.reject(new Error("down")))).rejects.toThrow("down");
    await Promise.resolve();
    await expect(cachedFor("k", async () => 1)).resolves.toBe(1);
  });

  it("keeps a newer answer when an older failure settles late", async () => {
    resetBrowseCache();
    let fail: (reason: Error) => void = () => undefined;
    const slow = cachedFor("j", () => new Promise<number>((_, reject) => (fail = reject)));
    resetBrowseCache();
    const fresh = cachedFor("j", async () => 2);
    fail(new Error("late"));
    await expect(slow).rejects.toThrow("late");
    await expect(cachedFor("j", async () => 3)).resolves.toBe(2);
    await expect(fresh).resolves.toBe(2);
  });
});
