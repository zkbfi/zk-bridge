import { describe, expect, it, vi } from "vitest";
import { ProverCommandError, type ProverBinary } from "@zk-bridge/shared/prover";
import { MAXIMUM_WORK_LIST_PAGES, createIndexerClient } from "../src/archive/work-list.ts";
import { RETRY_DELAY_MILLISECONDS } from "../src/archive/build.ts";
import { health, runArchiveCycle } from "../src/archive/module.ts";
import { ARCHIVE_RPC_URLS, isNodeRequest, makeBackend, makeConfig, receiptResponse } from "./support.ts";

const id = (digit: string) => `0x${digit.repeat(64)}`;
const workItem = {
  messageId: id("a"),
  sourceChainId: 369,
  destinationChainId: 1,
  sentTransactionHash: id("b"),
  sentLogIndex: 3,
  coveredByHeadSlot: "100",
};

const clientOver = (respond: (url: URL) => Response) => createIndexerClient({ baseUrl: "http://indexer.test/", fetchFunction: () => (async (input: string | URL | Request) => respond(new URL(String(input)))) as typeof fetch });

describe("the chain indexer client", () => {
  it("follows the cursor from page to page", async () => {
    const urls: string[] = [];
    const client = clientOver((url) => {
      urls.push(url.search);
      return url.searchParams.has("after") ? Response.json({ items: [], nextCursor: null }) : Response.json({ items: [workItem], nextCursor: "next page" });
    });
    expect(await client.readWorkList()).toEqual([workItem]);
    expect(urls[1]).toContain("after=next%20page");
  });

  it("stops a cursor that never ends", async () => {
    const client = clientOver(() => Response.json({ items: [], nextCursor: "again" }));
    await expect(client.readWorkList()).rejects.toThrow("more pages");
    expect(MAXIMUM_WORK_LIST_PAGES).toBeGreaterThan(1);
  });

  it("fails on an error status or a wrong shape, for the work list and for one message", async () => {
    await expect(clientOver(() => new Response("no", { status: 500 })).readWorkList()).rejects.toThrow("answered 500 for the work list");
    await expect(clientOver(() => Response.json({ items: "x" })).readWorkList()).rejects.toThrow("unknown shape");
    await expect(clientOver(() => new Response("no", { status: 502 })).readStatus(id("a"))).rejects.toThrow("answered 502 for a message");
    await expect(clientOver(() => Response.json({ state: 1 })).readStatus(id("a"))).rejects.toThrow("unknown shape");
    expect(await clientOver(() => new Response("", { status: 404 })).readStatus(id("a"))).toBeNull();
    expect(await clientOver(() => Response.json({ status: "delivered" })).readStatus(id("a"))).toBe("delivered");
  });
});

describe("archive failures", () => {
  const setup = (evidence: ProverBinary["evidence"]) => {
    const base = makeBackend({ config: makeConfig({ indexerUrl: "http://indexer.test/", rpcUrls: ARCHIVE_RPC_URLS }), enabled: ["archive"] });
    return { ...base, context: { ...base.context, prover: { ...base.prover.binary, evidence } } };
  };
  const indexerWith = (respond: () => Response) => vi.fn(async (_input: string | URL | Request, init?: RequestInit) => (isNodeRequest(init) ? receiptResponse() : respond()));
  const workPage = () => Response.json({ items: [workItem], nextCursor: null });

  it("records a plain error, a thing that is no error, and an error with an exit code by name only", async () => {
    const outcomes: unknown[] = [new Error("with a secret address inside"), "a string", new ProverCommandError("evidence", 4, "tail")];
    for (const outcome of outcomes) {
      const backend = setup(async () => Promise.reject(outcome));
      vi.stubGlobal("fetch", indexerWith(workPage));
      await runArchiveCycle(backend.context);
      const row = backend.storage.database.prepare("SELECT last_error FROM archive_entries").get() as { last_error: string };
      expect(row.last_error).toBe(outcome instanceof ProverCommandError ? "ProverCommandError exit code 4" : outcome instanceof Error ? "Error" : "Error");
      expect(row.last_error).not.toContain("secret");
    }
  });

  it("retries by time when the head of the failure is unknown", async () => {
    const evidence = vi.fn<ProverBinary["evidence"]>().mockRejectedValue(new Error("x"));
    const backend = setup(evidence);
    vi.stubGlobal("fetch", indexerWith(workPage));
    await runArchiveCycle(backend.context);
    backend.storage.database.exec("UPDATE archive_entries SET failed_on_head_slot = NULL");
    await runArchiveCycle(backend.context);
    expect(evidence).toHaveBeenCalledTimes(1);
    backend.clock.advance(RETRY_DELAY_MILLISECONDS);
    await runArchiveCycle(backend.context);
    expect(evidence).toHaveBeenCalledTimes(2);
  });

  it("builds again at once when a failed entry has no retry time", async () => {
    const evidence = vi.fn<ProverBinary["evidence"]>().mockRejectedValue(new Error("x"));
    const backend = setup(evidence);
    vi.stubGlobal("fetch", indexerWith(workPage));
    await runArchiveCycle(backend.context);
    backend.storage.database.exec("UPDATE archive_entries SET retry_at = NULL");
    await runArchiveCycle(backend.context);
    expect(evidence).toHaveBeenCalledTimes(2);
  });

  it("reports a failing chain indexer that throws a thing that is no error", async () => {
    const backend = setup(async () => Promise.reject(new Error("unused")));
    vi.stubGlobal("fetch", vi.fn(async () => Promise.reject("down")));
    await runArchiveCycle(backend.context);
    expect(health(backend.context)).toEqual({ state: "degraded", detail: expect.stringContaining("the chain indexer failed (Error)") });
  });
});
