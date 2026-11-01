import { describe, expect, it, vi } from "vitest";
import { ProverCommandError, type ProverBinary } from "@zk-bridge/shared/prover";
import { runArchiveCycle, health, start } from "../src/archive/module.ts";
import { directionOf, RETRY_DELAY_MILLISECONDS } from "../src/archive/build.ts";
import { MODULES } from "../src/main.ts";
import { createApp } from "../src/app.ts";
import { makeBackend, makeConfig } from "./support.ts";

const id = (digit: string) => `0x${digit.repeat(64)}`;
const transactionHash = (digit: string) => `0x${digit.repeat(64)}`;

type Item = { messageId: string; sourceChainId: number; destinationChainId: number; sentTransactionHash: string; sentLogIndex: number; coveredByHeadSlot: string };
const item = (digit: string, overrides: Partial<Item> = {}): Item => ({
  messageId: id(digit),
  sourceChainId: 369,
  destinationChainId: 1,
  sentTransactionHash: transactionHash(digit),
  sentLogIndex: Number.parseInt(digit, 16),
  coveredByHeadSlot: "100",
  ...overrides,
});

const evidenceFor = (messageId: string) => ({
  schemaVersion: 2,
  route: "pulsechain_to_ethereum",
  sourceTransactionHash: transactionHash("a"),
  logIndex: 1,
  message: { messageId, sender: `0x${"7".repeat(40)}`, executor: `0x${"8".repeat(40)}`, data: "0x", futureField: "kept" },
  destination: { chainId: 1, bridge: `0x${"b".repeat(40)}`, lightClient: `0x${"c".repeat(40)}` },
  anchor: { slot: 90, root: id("d") },
  deliveryStatus: "notDelivered",
  alreadyDelivered: false,
  execute: { to: `0x${"b".repeat(40)}`, data: "0xabcdef" },
  prerequisites: [],
  createdAt: "2026-10-28T00:00:00Z",
});

/** An indexer whose work list and message statuses the test sets. */
function fakeIndexer(state: { work: Item[]; statuses: Record<string, string> }) {
  return vi.fn(async (input: string | URL | Request) => {
    const url = new URL(String(input));
    if (url.pathname === "/api/undelivered") return Response.json({ items: state.work, nextCursor: null });
    const messageId = url.pathname.split("/").pop() as string;
    const status = state.statuses[messageId];
    return status === undefined ? Response.json({ error: "unknown" }, { status: 404 }) : Response.json({ status });
  });
}

function setup(evidence: ProverBinary["evidence"]) {
  const base = makeBackend({ config: makeConfig({ indexerUrl: "http://indexer.test/" }), enabled: ["archive"] });
  const prover: ProverBinary = { ...base.prover.binary, evidence };
  const context = { ...base.context, prover };
  const app = createApp({ context, modules: MODULES, enabled: ["archive"] });
  return { ...base, context, app };
}

describe("evidence archive", () => {
  it("builds evidence for each covered message from its transaction hash and log index", async () => {
    const calls: unknown[] = [];
    const backend = setup(async (request) => {
      calls.push(request);
      return evidenceFor(id(request.logIndex === 10 ? "a" : "b")) as never;
    });
    vi.stubGlobal("fetch", fakeIndexer({ work: [item("a"), item("b", { sourceChainId: 1, destinationChainId: 369 })], statuses: {} }));
    await runArchiveCycle(backend.context);
    expect(calls).toEqual([
      { direction: "second-to-first", transactionHash: transactionHash("a"), logIndex: 10 },
      { direction: "first-to-second", transactionHash: transactionHash("b"), logIndex: 11 },
    ]);
    expect((await backend.app.request(`/evidence/${id("a")}`)).status).toBe(200);
    expect((await backend.app.request(`/evidence/${id("b")}`)).status).toBe(200);
  });

  it("serves the stored evidence unchanged", async () => {
    const stored = evidenceFor(id("a"));
    const backend = setup(async () => stored as never);
    vi.stubGlobal("fetch", fakeIndexer({ work: [item("a")], statuses: {} }));
    await runArchiveCycle(backend.context);
    const answer = await backend.app.request(`/evidence/${id("a").toUpperCase().replace("0X", "0x")}`);
    expect(answer.headers.get("content-type")).toContain("application/json");
    expect(await answer.json()).toEqual(stored);
  });

  it("refuses a message id that is not 32 bytes and answers 404 for an unknown one", async () => {
    const backend = setup(async () => evidenceFor(id("a")) as never);
    expect((await backend.app.request("/evidence/0x1234")).status).toBe(400);
    expect((await backend.app.request(`/evidence/${"zz".repeat(32)}`)).status).toBe(400);
    expect((await backend.app.request(`/evidence/${id("f")}`)).status).toBe(404);
  });

  it("drops the entry once the indexer shows the message delivered", async () => {
    const state = { work: [item("a")], statuses: {} as Record<string, string> };
    const backend = setup(async () => evidenceFor(id("a")) as never);
    vi.stubGlobal("fetch", fakeIndexer(state));
    await runArchiveCycle(backend.context);
    expect((await backend.app.request(`/evidence/${id("a")}`)).status).toBe(200);
    state.work = [];
    state.statuses[id("a")] = "delivered";
    await runArchiveCycle(backend.context);
    expect((await backend.app.request(`/evidence/${id("a")}`)).status).toBe(404);
    expect(health(backend.context).detail).toContain("0 entries");
  });

  it.each(["release_failed"])("drops the entry for the status %s", async (status) => {
    const state = { work: [item("a")], statuses: {} as Record<string, string> };
    const backend = setup(async () => evidenceFor(id("a")) as never);
    vi.stubGlobal("fetch", fakeIndexer(state));
    await runArchiveCycle(backend.context);
    state.work = [];
    state.statuses[id("a")] = status;
    await runArchiveCycle(backend.context);
    expect((await backend.app.request(`/evidence/${id("a")}`)).status).toBe(404);
  });

  it("keeps an entry that left the work list but is not finished", async () => {
    const state = { work: [item("a")], statuses: {} as Record<string, string> };
    const backend = setup(async () => evidenceFor(id("a")) as never);
    vi.stubGlobal("fetch", fakeIndexer(state));
    await runArchiveCycle(backend.context);
    state.work = [];
    state.statuses[id("a")] = "sent";
    await runArchiveCycle(backend.context);
    expect((await backend.app.request(`/evidence/${id("a")}`)).status).toBe(200);
  });

  it("keeps an entry and retries later when the prover fails", async () => {
    const evidence = vi.fn<ProverBinary["evidence"]>().mockRejectedValueOnce(new ProverCommandError("evidence", 1, "boom")).mockResolvedValue(evidenceFor(id("a")) as never);
    const backend = setup(evidence);
    vi.stubGlobal("fetch", fakeIndexer({ work: [item("a")], statuses: {} }));
    await runArchiveCycle(backend.context);
    expect((await backend.app.request(`/evidence/${id("a")}`)).status).toBe(404);
    expect(health(backend.context).detail).toContain("1 failing");
    await runArchiveCycle(backend.context);
    expect(evidence).toHaveBeenCalledTimes(1);
    backend.clock.advance(RETRY_DELAY_MILLISECONDS);
    await runArchiveCycle(backend.context);
    expect(evidence).toHaveBeenCalledTimes(2);
    expect((await backend.app.request(`/evidence/${id("a")}`)).status).toBe(200);
    expect(health(backend.context).detail).toContain("0 failing");
  });

  it("an Ethereum-sourced message records the prover's refusal and retries after the next head", async () => {
    const evidence = vi.fn<ProverBinary["evidence"]>().mockRejectedValueOnce(new ProverCommandError("evidence", 2, "secret-rpc-url refused")).mockResolvedValue(evidenceFor(id("a")) as never);
    const backend = setup(evidence);
    const state = { work: [item("a", { sourceChainId: 1, destinationChainId: 369 })], statuses: {} };
    vi.stubGlobal("fetch", fakeIndexer(state));
    await runArchiveCycle(backend.context);
    const row = backend.storage.database.prepare("SELECT last_error FROM archive_entries").get() as { last_error: string };
    expect(row.last_error).toBe("ProverCommandError exit code 2");
    await runArchiveCycle(backend.context);
    expect(evidence).toHaveBeenCalledTimes(1);
    state.work = [item("a", { sourceChainId: 1, destinationChainId: 369, coveredByHeadSlot: "164" })];
    await runArchiveCycle(backend.context);
    expect(evidence).toHaveBeenCalledTimes(2);
    expect((await backend.app.request(`/evidence/${id("a")}`)).status).toBe(200);
  });

  it("builds evidence once and never again, however old it gets", async () => {
    const evidence = vi.fn<ProverBinary["evidence"]>().mockResolvedValue(evidenceFor(id("a")) as never);
    const backend = setup(evidence);
    vi.stubGlobal("fetch", fakeIndexer({ work: [item("a")], statuses: {} }));
    await runArchiveCycle(backend.context);
    backend.clock.advance(400 * 86_400_000);
    await runArchiveCycle(backend.context);
    expect(evidence).toHaveBeenCalledTimes(1);
    expect((await backend.app.request(`/evidence/${id("a")}`)).status).toBe(200);
  });

  it("refuses evidence that names a different message", async () => {
    const backend = setup(async () => evidenceFor(id("9")) as never);
    vi.stubGlobal("fetch", fakeIndexer({ work: [item("a")], statuses: {} }));
    await runArchiveCycle(backend.context);
    expect((await backend.app.request(`/evidence/${id("a")}`)).status).toBe(404);
    expect(health(backend.context).detail).toContain("1 failing");
  });

  it("skips a message whose chains are not the pair", async () => {
    const evidence = vi.fn<ProverBinary["evidence"]>();
    const backend = setup(evidence);
    vi.stubGlobal("fetch", fakeIndexer({ work: [item("a", { sourceChainId: 5, destinationChainId: 6 })], statuses: {} }));
    await runArchiveCycle(backend.context);
    expect(evidence).not.toHaveBeenCalled();
    expect(directionOf("nowhere", { sourceChainId: 1, destinationChainId: 369 })).toBeNull();
  });

  it("reports a failing indexer as degraded and keeps what it has", async () => {
    const backend = setup(async () => evidenceFor(id("a")) as never);
    vi.stubGlobal("fetch", vi.fn(async () => new Response("no", { status: 500 })));
    await runArchiveCycle(backend.context);
    expect(health(backend.context).state).toBe("degraded");
    vi.stubGlobal("fetch", vi.fn(async () => Response.json({ items: "wrong", nextCursor: null })));
    await runArchiveCycle(backend.context);
    expect(health(backend.context).state).toBe("degraded");
  });

  it("follows the pages of the work list", async () => {
    const backend = setup(async (request) => evidenceFor(id(request.logIndex === 10 ? "a" : "b")) as never);
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: string | URL | Request) => {
        const url = new URL(String(input));
        if (url.pathname.startsWith("/api/messages")) return Response.json({ error: "unknown" }, { status: 404 });
        return url.searchParams.get("after") === null
          ? Response.json({ items: [item("a")], nextCursor: "next" })
          : Response.json({ items: [item("b")], nextCursor: null });
      }),
    );
    await runArchiveCycle(backend.context);
    expect(backend.storage.database.prepare("SELECT count(*) AS total FROM evidence").get()).toEqual({ total: 2 });
  });

  it("without an indexer address the routes answer 404 and health says degraded", async () => {
    const backend = makeBackend({ enabled: ["archive"] });
    await runArchiveCycle(backend.context);
    expect((await backend.app.request(`/evidence/${id("a")}`)).status).toBe(404);
    expect(health(backend.context)).toEqual({ state: "degraded", detail: "indexerUrl is not set" });
    await (await start(backend.context))();
  });

  it("start runs a pass, stop waits for it, and no answer holds a secret", async () => {
    const backend = setup(async () => evidenceFor(id("a")) as never);
    vi.stubGlobal("fetch", fakeIndexer({ work: [item("a")], statuses: {} }));
    const stop = await start(backend.context);
    await stop();
    const answer = await (await backend.app.request(`/evidence/${id("a")}`)).text();
    expect(answer).not.toContain("secret");
    expect(health(backend.context).state).toBe("running");
  });
});
