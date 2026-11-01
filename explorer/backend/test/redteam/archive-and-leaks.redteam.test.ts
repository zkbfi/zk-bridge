/**
 * Red team: GET /evidence/:messageId, the archive's trust in the chain indexer, and secret leaks through the logger.
 */
import { describe, expect, it, vi } from "vitest";
import type { ProverBinary } from "@zk-bridge/shared/prover";
import { createApp } from "../../src/app.ts";
import { runArchiveCycle } from "../../src/archive/module.ts";
import { endpointSecrets } from "../../src/config.ts";
import { createLogger } from "../../src/logger.ts";
import { MODULES } from "../../src/main.ts";
import { makeBackend, makeConfig } from "../support.ts";

const id = (digit: string) => `0x${digit.repeat(64)}`;

type Item = { messageId: string; sourceChainId: number; destinationChainId: number; sentTransactionHash: string; sentLogIndex: number; coveredByHeadSlot: string };
const item = (digit: string, overrides: Partial<Item> = {}): Item => ({ messageId: id(digit), sourceChainId: 369, destinationChainId: 1, sentTransactionHash: id(digit), sentLogIndex: 1, coveredByHeadSlot: "100", ...overrides });

const evidenceFor = (messageId: string) => ({
  schemaVersion: 2,
  route: "pulsechain_to_ethereum",
  sourceTransactionHash: id("a"),
  logIndex: 1,
  message: { messageId, sender: `0x${"7".repeat(40)}`, executor: `0x${"8".repeat(40)}`, data: "0x" },
  destination: { chainId: 1, bridge: `0x${"b".repeat(40)}`, lightClient: `0x${"c".repeat(40)}` },
  anchor: { slot: 90, root: id("d") },
  deliveryStatus: "notDelivered",
  alreadyDelivered: false,
  execute: { to: `0x${"b".repeat(40)}`, data: "0xabcdef" },
  prerequisites: [],
  createdAt: "2026-10-28T00:00:00Z",
});

function setup(evidence: ProverBinary["evidence"], indexer: { work: Item[]; statuses: Record<string, string>; failWith?: string }) {
  const base = makeBackend({ config: makeConfig({ indexerUrl: "http://indexer.test/" }), enabled: ["archive"] });
  const context = { ...base.context, prover: { ...base.prover.binary, evidence } };
  const app = createApp({ context, modules: MODULES, enabled: ["archive"] });
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: string | URL | Request) => {
      if (indexer.failWith !== undefined) throw new Error(indexer.failWith);
      const url = new URL(String(input));
      if (url.pathname === "/api/undelivered") return Response.json({ items: indexer.work, nextCursor: null });
      const status = indexer.statuses[url.pathname.split("/").pop() as string];
      return status === undefined ? Response.json({}, { status: 404 }) : Response.json({ status });
    }),
  );
  return { ...base, context, app };
}

describe("GET /evidence/:messageId", () => {
  it("ATTACK path traversal, SQL text, encoded newlines and over-long ids are refused with 400 before any lookup", async () => {
    const backend = setup(async (request) => evidenceFor(id("1")) as never, { work: [], statuses: {} });
    for (const path of ["..%2F..%2Fetc%2Fpasswd", `${id("1")}%0a`, `${id("1")}%00`, `${id("1")}00`, `0x${"1".repeat(63)}'`, "0x' OR '1'='1", `${id("1")}%2F..`, "%2e%2e"]) {
      const answer = await backend.app.request(`/evidence/${path}`);
      expect([400, 404]).toContain(answer.status);
      if (answer.status === 404) expect(await answer.text()).not.toContain("evidence\":");
    }
    vi.unstubAllGlobals();
  });

  it("ATTACK evidence the prover builds for another message (indexer named a wrong transaction) is not stored or served", async () => {
    const backend = setup(async () => evidenceFor(id("2")) as never, { work: [item("1")], statuses: {} });
    await runArchiveCycle(backend.context);
    expect((await backend.app.request(`/evidence/${id("1")}`)).status).toBe(404);
    expect((await backend.app.request(`/evidence/${id("2")}`)).status).toBe(404);
    vi.unstubAllGlobals();
  });

  it("ATTACK an indexer item with chains outside the pair is ignored (no prover run)", async () => {
    const evidence = vi.fn(async () => evidenceFor(id("1")) as never);
    const backend = setup(evidence, { work: [item("1", { sourceChainId: 1, destinationChainId: 1 }), item("2", { sourceChainId: 11155111, destinationChainId: 943 })], statuses: {} });
    await runArchiveCycle(backend.context);
    expect(evidence).not.toHaveBeenCalled();
    vi.unstubAllGlobals();
  });

  it("ATTACK SUCCEEDS a lying chain indexer (drops a message from the work list and calls it delivered) makes the archive delete good evidence", async () => {
    const state = { work: [item("1")], statuses: {} as Record<string, string> };
    const backend = setup(async () => evidenceFor(id("1")) as never, state);
    await runArchiveCycle(backend.context);
    expect((await backend.app.request(`/evidence/${id("1")}`)).status).toBe(200);
    state.work = [];
    state.statuses[id("1")] = "delivered";
    await runArchiveCycle(backend.context);
    expect((await backend.app.request(`/evidence/${id("1")}`)).status).toBe(404);
    vi.unstubAllGlobals();
  });

  it("ATTACK an indexer error that names an endpoint key does not reach /health", async () => {
    const backend = setup(async () => evidenceFor(id("1")) as never, { work: [], statuses: {}, failWith: "fetch failed https://indexer.test/?key=topsecretkey123" });
    await runArchiveCycle(backend.context);
    const text = await (await backend.app.request("/health")).text();
    expect(text).toContain("degraded");
    expect(text).not.toContain("topsecretkey123");
    vi.unstubAllGlobals();
  });
});

describe("secret leaks through the logger", () => {
  const config = makeConfig({
    rpcUrls: { "1": "https://eth.example.org/v3/0123456789abcdef0123", "369": "https://user:pa55word@pls.example.org/rpc?apikey=shortk" },
    beaconUrls: { "1": "https://k3y5ecretsubdomain.beacon.example.org/" },
    msgboardUrl: "wss://board.example.org/ws/boardkey12345",
  });

  const logLine = (fields: Record<string, unknown>) => {
    const lines: string[] = [];
    const logger = createLogger({ write: (line) => lines.push(line), now: () => 0, knownSecrets: () => endpointSecrets(config, null) });
    logger.warn("event", fields);
    return lines[0] as string;
  };

  it("ATTACK RPC keys in the path, the query, the user info and the msgboard path are removed from errors and plain fields", () => {
    const line = logLine({
      error: new Error("HTTP request failed. URL: https://eth.example.org/v3/0123456789abcdef0123 Details: 0123456789abcdef0123"),
      other: { url: "https://user:pa55word@pls.example.org/rpc?apikey=shortk", alone: "pa55word shortk" },
      board: "connect wss://board.example.org/ws/boardkey12345 failed (boardkey12345)",
    });
    for (const secret of ["0123456789abcdef0123", "pa55word", "shortk", "boardkey12345"]) expect(line).not.toContain(secret);
  });

  it("ATTACK a key carried in the host name of an endpoint is removed even when an error names only the host (the whole-URL split yields the host)", () => {
    const line = logLine({ error: new Error("getaddrinfo ENOTFOUND k3y5ecretsubdomain.beacon.example.org") });
    expect(line).not.toContain("k3y5ecretsubdomain");
  });
});
