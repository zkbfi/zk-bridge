import { afterEach, describe, expect, it, vi } from "vitest";
import { checkForkProofRecord, type ForkProofProver, type ForkProofRecord } from "@zk-bridge/shared/prover";
import { createApp } from "../src/app.ts";
import { forkProofArchiveBases, handoffArchiveBases } from "../src/config.ts";
import {
  createForkProofCapture,
  hasForkProofOfBlock,
  readForkProof,
  recentForkProofs,
  sentMessagesReader,
  storeForkProof,
  CAPTURED_STATUSES,
  FEED_PAGE_SIZE,
  MAX_FEED_PAGES,
  type ForkCaptureTarget,
  type SentMessage,
} from "../src/archive/fork-proofs.ts";
import { MAX_RETRY_MILLISECONDS } from "../src/archive/handoffs.ts";
import { health, runForkProofCapture, start } from "../src/archive/module.ts";
import { createProverFactories } from "../src/requests/job-prover.ts";
import { MODULES } from "../src/main.ts";
import type { BackendModuleContext } from "../src/module.ts";
import { openStorage } from "../src/storage.ts";
import { forkProofRecordFixture } from "../../shared/test/support/fork-proof-fixture.ts";
import { makeBackend, makeClock, makeConfig, memoryLogger, PAIR } from "./support.ts";

/** A checked record of `chainId` for the block `blockNumber`; `seed` picks the state, `slot` changes the text alone. */
function record(chainId: number, blockNumber: number, seed = blockNumber % 200, slot = 5678): ForkProofRecord {
  const fixture = forkProofRecordFixture({ chainId, seed, executionBlockNumber: blockNumber, slot });
  const checked = checkForkProofRecord(fixture.text, { chainId });
  if (!checked.ok) throw new Error(checked.reason);
  return checked.record;
}

const message = (blockNumber: number, index = 0): SentMessage => ({
  messageId: `0x${(blockNumber * 10 + index).toString(16).padStart(64, "0")}`,
  transactionHash: `0x${(blockNumber * 100 + index).toString(16).padStart(64, "0")}`,
  blockNumber,
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("the fork proof table (2026-11-10)", () => {
  it("keeps the first record of a state, knows the same one again, and refuses a different one", () => {
    const storage = openStorage(":memory:");
    const first = record(943, 10);
    expect(storeForkProof(storage, first, 100)).toBe("stored");
    expect(storeForkProof(storage, first, 200)).toBe("known");
    expect(storeForkProof(storage, record(943, 10, 10, 9999), 300)).toBe("conflict");
    expect(storeForkProof(storage, record(943, 11), 400)).toBe("stored");
    expect(readForkProof(storage, 943, first.stateRoot.toUpperCase().replace("0X", "0x"))).toBe(first.text);
    expect(readForkProof(storage, 943, `0x${"00".repeat(32)}`)).toBeNull();
    expect(readForkProof(storage, 1, first.stateRoot)).toBeNull();
    expect(hasForkProofOfBlock(storage, 943, 10)).toBe(true);
    expect(hasForkProofOfBlock(storage, 943, 12)).toBe(false);
    expect(recentForkProofs(storage, 150).map((row) => [row.chainId, row.storedAt])).toEqual([[943, 400]]);
    expect(recentForkProofs(storage, 0)).toHaveLength(2);
  });

  it("names this backend's own route first, then the indexer's, then the configured ones", () => {
    const config = makeConfig({ listen: { host: "0.0.0.0", port: 9 }, indexerUrl: "http://indexer.test/", forkProofArchiveUrls: ["https://gateway.example/ipfs/cid/fork-proofs"] });
    expect(forkProofArchiveBases(config)).toEqual(["http://127.0.0.1:9/archive/fork-proofs", "http://indexer.test/api/proofs/fork-proofs", "https://gateway.example/ipfs/cid/fork-proofs"]);
    expect(handoffArchiveBases(config)).toEqual(["http://127.0.0.1:9/archive/handoffs", "http://indexer.test/api/proofs/handoffs"]);
  });

  it("hands the fork proof archive to the prover of the evidence command", async () => {
    const seen: string[] = [];
    const factories = createProverFactories({
      config: makeConfig({ listen: { host: "127.0.0.1", port: 9 } }),
      pair: PAIR,
      executor: async (spec) => {
        seen.push(spec.args[1] === undefined ? "" : (await import("node:fs")).readFileSync(spec.args[1], "utf8"));
        return { code: 1, stdout: "", stderr: "stop" };
      },
      secrets: { proverKeys: null, webhookBearer: "b" } as never,
      path: "/usr/bin",
      logger: memoryLogger().logger,
    });
    await expect(factories.utilityProver.forkProof({ direction: "first-to-second", transactionHash: `0x${"11".repeat(32)}`, chainId: 1 })).rejects.toThrow(/stop/);
    expect(seen[0]).toContain('fork_proof_archive_urls = ["http://127.0.0.1:9/archive/fork-proofs"]');
  });
});

describe("the sent messages of a direction, from the indexer feed", () => {
  const item = (blockNumber: number) => ({ messageId: message(blockNumber).messageId, sent: { transactionHash: message(blockNumber).transactionHash, blockNumber, timestamp: 1 }, extra: true });

  it("reads the final undelivered messages page by page, and skips an item without a send", async () => {
    const urls: string[] = [];
    const pages = [
      { items: [item(5), { messageId: message(6).messageId, sent: null }], nextCursor: "c1" },
      { items: [item(4)], nextCursor: null },
    ];
    const read = sentMessagesReader({
      indexerUrl: "http://indexer.test/",
      sourceChainId: 1,
      destinationChainId: 369,
      get: async (url) => {
        urls.push(url);
        return { status: 200, body: pages[urls.length - 1] };
      },
    });
    expect((await read()).map((entry) => entry.blockNumber)).toEqual([5, 4]);
    const first = new URL(urls[0] as string);
    expect(first.pathname).toBe("/api/feed");
    expect(Object.fromEntries(first.searchParams)).toEqual({ direction: "1>369", status: CAPTURED_STATUSES, limit: String(FEED_PAGE_SIZE) });
    expect(new URL(urls[1] as string).searchParams.get("cursor")).toBe("c1");
  });

  it("stops after the last page it follows, and refuses a failing or unknown answer", async () => {
    let calls = 0;
    const endless = sentMessagesReader({ indexerUrl: "http://indexer.test", sourceChainId: 1, destinationChainId: 369, get: async () => ({ status: 200, body: { items: [item(++calls)], nextCursor: "more" } }) });
    expect(await endless()).toHaveLength(MAX_FEED_PAGES);
    const failing = sentMessagesReader({ indexerUrl: "http://indexer.test", sourceChainId: 1, destinationChainId: 369, get: async () => ({ status: 503, body: null }) });
    await expect(failing()).rejects.toThrow(/answered 503/);
    const wrong = sentMessagesReader({ indexerUrl: "http://indexer.test", sourceChainId: 1, destinationChainId: 369, get: async () => ({ status: 200, body: { items: [{ messageId: "x" }] } }) });
    await expect(wrong()).rejects.toThrow(/unknown shape/);
  });
});

describe("the fork proof capture (2026-11-10)", () => {
  function setup(options: { messages?: () => Promise<readonly SentMessage[]>; answer?: (blockNumber: number, transactionHash: string) => ForkProofRecord | Error } = {}) {
    const storage = openStorage(":memory:");
    const clock = makeClock(1_800_000_000_000);
    const log = memoryLogger();
    const asked: Array<{ transactionHash: string; chainId: number; direction: string }> = [];
    const byTransaction = new Map<string, number>();
    const listed = [message(7), message(5), message(5, 1), message(6)];
    for (const entry of listed) byTransaction.set(entry.transactionHash, entry.blockNumber);
    const prover: ForkProofProver = {
      async forkProof(request) {
        asked.push({ transactionHash: request.transactionHash, chainId: request.chainId, direction: request.direction });
        const blockNumber = byTransaction.get(request.transactionHash) as number;
        const answer = options.answer?.(blockNumber, request.transactionHash) ?? record(943, blockNumber);
        if (answer instanceof Error) throw answer;
        return answer;
      },
    };
    const target: ForkCaptureTarget = { direction: "second-to-first", chainId: 943, readMessages: options.messages ?? (async () => listed) };
    const capture = createForkProofCapture({ storage, prover, targets: [target], intervalMilliseconds: 120_000, logger: log.logger, now: clock.now });
    return { storage, clock, log, asked, capture };
  }
  const events = (log: ReturnType<typeof memoryLogger>, name: string) => log.lines.filter((line) => line.includes(`"event":"${name}"`));
  const blocksAsked = (run: ReturnType<typeof setup>) => run.asked.map((entry) => Number(BigInt(entry.transactionHash) / 100n));

  it("asks once per block, oldest first, for the blocks without a record, and keeps each", async () => {
    const run = setup();
    storeForkProof(run.storage, record(943, 6), 1);
    await run.capture.runOnce();
    expect(blocksAsked(run)).toEqual([5, 7]);
    expect(run.asked[0]).toMatchObject({ chainId: 943, direction: "second-to-first", transactionHash: message(5).transactionHash });
    expect(hasForkProofOfBlock(run.storage, 943, 5) && hasForkProofOfBlock(run.storage, 943, 7)).toBe(true);
    expect(events(run.log, "fork_proof_captured")).toHaveLength(2);
    expect(run.capture.status()).toEqual({ kept: 3, failing: 0 });
    await run.capture.runOnce();
    expect(blocksAsked(run)).toHaveLength(2);
  });

  it("waits longer after each failure, at most six hours, and refuses a record of another block", async () => {
    let fail = true;
    const run = setup({ answer: (blockNumber) => (blockNumber === 7 && fail ? new Error("the beacon block is not final yet") : blockNumber === 6 ? record(943, 99) : record(943, blockNumber)) });
    await run.capture.runOnce();
    expect(blocksAsked(run)).toEqual([5, 6, 7]);
    expect(events(run.log, "fork_proof_capture_failed")).toHaveLength(2);
    expect(events(run.log, "fork_proof_capture_failed")[0]).toContain("the prover gave the record of block 99, not 6");
    expect(run.capture.status().failing).toBe(2);
    await run.capture.runOnce();
    expect(blocksAsked(run)).toHaveLength(3);
    run.clock.advance(120_000);
    await run.capture.runOnce();
    expect(blocksAsked(run)).toEqual([5, 6, 7, 6, 7]);
    expect(events(run.log, "fork_proof_capture_failed").at(-1)).toContain('"retryInSeconds":240');
    for (let index = 0; index < 10; index += 1) {
      run.clock.advance(MAX_RETRY_MILLISECONDS);
      await run.capture.runOnce();
    }
    expect(events(run.log, "fork_proof_capture_failed").at(-1)).toContain(`"retryInSeconds":${MAX_RETRY_MILLISECONDS / 1000}`);
    fail = false;
    run.clock.advance(MAX_RETRY_MILLISECONDS);
    await run.capture.runOnce();
    expect(hasForkProofOfBlock(run.storage, 943, 7)).toBe(true);
    expect(run.capture.status().failing).toBe(1);
  });

  it("logs a conflict when another record of the state arrived while the prover ran", async () => {
    const storage = openStorage(":memory:");
    const log = memoryLogger();
    const capture = createForkProofCapture({
      storage,
      prover: {
        async forkProof() {
          storeForkProof(storage, record(943, 5), 1);
          return record(943, 5, 5, 4321);
        },
      },
      targets: [{ direction: "second-to-first", chainId: 943, readMessages: async () => [message(5)] }],
      intervalMilliseconds: 120_000,
      logger: log.logger,
      now: () => 2,
    });
    await capture.runOnce();
    expect(log.lines.some((line) => line.includes("fork_proof_capture_conflict"))).toBe(true);
    expect(readForkProof(storage, 943, record(943, 5).stateRoot)).toBe(record(943, 5).text);
  });

  it("logs an indexer it cannot read and goes on; a second call joins the running pass", async () => {
    const run = setup({ messages: async () => Promise.reject(new Error("indexer down")) });
    const first = run.capture.runOnce();
    const second = run.capture.runOnce();
    await Promise.all([first, second, run.capture.settled()]);
    expect(events(run.log, "fork_proof_capture_read_failed")).toHaveLength(1);
    expect(run.asked).toEqual([]);
  });
});

describe("the fork proof route and the capture timer of the archive module (2026-11-10)", () => {
  it("serves a record unchanged, refuses a bad path, and lists the recent records on the live route", async () => {
    const backend = makeBackend({ enabled: ["archive"] });
    const kept = record(369, 5);
    storeForkProof(backend.storage, kept, backend.clock.now());
    storeForkProof(backend.storage, record(369, 6), backend.clock.now() - 8 * 86_400_000);
    const app = createApp({ context: backend.context, modules: MODULES, enabled: ["archive"] });
    const found = await app.request(`/archive/fork-proofs/369/${kept.stateRoot}.json`);
    expect(found.status).toBe(200);
    expect(found.headers.get("content-type")).toContain("application/json");
    expect(await found.text()).toBe(kept.text);
    expect((await app.request(`/archive/fork-proofs/369/0x${"00".repeat(32)}.json`)).status).toBe(404);
    expect((await app.request(`/archive/fork-proofs/369/${kept.stateRoot}`)).status).toBe(400);
    expect((await app.request(`/archive/fork-proofs/x/${kept.stateRoot}.json`)).status).toBe(400);
    const rows = (await (await app.request("/archive/proofs")).json()) as { forkProofs: Array<{ stateRoot: string; record: string }> };
    expect(rows.forkProofs).toEqual([{ chainId: 369, stateRoot: kept.stateRoot, record: kept.text, storedAt: backend.clock.now() }]);
  });

  it("runs the capture from start over the indexer feed of each direction with a beacon endpoint, and says why not otherwise", async () => {
    const base = makeBackend({ config: makeConfig({ indexerUrl: "http://indexer.test", forkProofCapture: { intervalSeconds: 60 } }), enabled: ["archive"] });
    const directions: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        // The archive service reads the work list of the same indexer: an empty one.
        if (new URL(url).pathname !== "/api/feed") return new Response(JSON.stringify({ items: [], nextCursor: null }), { status: 200 });
        const direction = new URL(url).searchParams.get("direction") as string;
        directions.push(direction);
        const blockNumber = direction === "1>369" ? 11 : 12;
        return new Response(JSON.stringify({ items: [{ messageId: message(blockNumber).messageId, sent: { transactionHash: message(blockNumber).transactionHash, blockNumber } }], nextCursor: null }), { status: 200 });
      }),
    );
    const context: BackendModuleContext = {
      ...base.context,
      forkProofProver: {
        async forkProof({ chainId, transactionHash }) {
          return record(chainId, Number(BigInt(transactionHash) / 100n));
        },
      },
    };
    const stop = await start(context);
    await runForkProofCapture(context);
    await stop();
    expect(new Set(directions)).toEqual(new Set(["1>369", "369>1"]));
    expect(hasForkProofOfBlock(base.storage, 1, 11) && hasForkProofOfBlock(base.storage, 369, 12)).toBe(true);
    expect(health(context).detail).toContain("2 fork proof records, 0 blocks failing");

    const withoutBeacon = makeBackend({ config: makeConfig({ indexerUrl: "http://indexer.test" }), enabled: ["archive"] });
    const pair = { ...PAIR, sides: [PAIR.sides[0], { ...PAIR.sides[1], beaconUrl: null }] as typeof PAIR.sides };
    directions.length = 0;
    const oneSide: BackendModuleContext = { ...withoutBeacon.context, pair, forkProofProver: context.forkProofProver as ForkProofProver };
    await runForkProofCapture(oneSide);
    expect(directions).toEqual(["1>369"]);

    const off = makeBackend({ config: makeConfig({ indexerUrl: "http://indexer.test", forkProofCapture: { enabled: false } }), enabled: ["archive"] });
    await (await start({ ...off.context, forkProofProver: context.forkProofProver as ForkProofProver }))();
    expect(off.log.lines.join("\n")).toContain("forkProofCapture.enabled is false");
    expect(health(off.context).detail).toContain("fork proof capture off");
    const noCommand = makeBackend({ config: makeConfig({ indexerUrl: "http://indexer.test" }), enabled: ["archive"] });
    await (await start(noCommand.context))();
    expect(noCommand.log.lines.join("\n")).toContain("no fork-proof command in this context");
    const noIndexer = makeBackend({ enabled: ["archive"] });
    await (await start({ ...noIndexer.context, forkProofProver: context.forkProofProver as ForkProofProver }))();
    expect(noIndexer.log.lines.join("\n")).toContain('"reason":"indexerUrl is not set"');
    await runForkProofCapture(noIndexer.context);
  });
});
