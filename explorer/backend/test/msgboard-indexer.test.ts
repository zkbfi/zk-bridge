import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { encodeAbiParameters, type Hex } from "viem";
import { encodeProofMessage, proofCategory, type ProofDirection, type ProofMessage } from "@zk-bridge/shared";
import type { BoardFeed, BoardMessage } from "@zk-bridge/shared/msgboard";
import { createLightClientReader, type LightClientHead } from "@zk-bridge/shared/prover";
import { createApp } from "../src/app.ts";
import { BackendConfigError } from "../src/config.ts";
import type { BackendModuleContext } from "../src/module.ts";
import { MODULES } from "../src/main.ts";
import { cacheLightClientReader, chooseLatest, createRecentSet, loadStoredProof, saveStoredProof, type StoredProof, type TimedHead, type TimedLightClientReader } from "../src/msgboard-indexer/latest-proof.ts";
import {
  buildDependencies,
  health,
  register,
  start,
  startIndexer,
  type IndexerDependencies,
} from "../src/msgboard-indexer/module.ts";
import { openStorage, type Storage } from "../src/storage.ts";
import { PAIR, controllableProver, makeClock, makeConfig, memoryLogger } from "./support.ts";

const created = vi.hoisted(() => ({ boardUrls: [] as string[] }));
vi.mock("@zk-bridge/shared/msgboard", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@zk-bridge/shared/msgboard")>()),
  createBoardFeed: (input: { boardUrl: string }) => {
    created.boardUrls.push(input.boardUrl);
    return { subscribe: async () => ({ close: async () => {} }), recent: async () => [], close: async () => {} };
  },
}));

const word = (byte: string): Hex => `0x${byte.repeat(32)}`;
const PROGRAM_KEY = word("11");
const rootOf = (slot: bigint): Hex => `0x${slot.toString(16).padStart(64, "0")}`;

function proofMessage(startSlot: bigint, newSlot: bigint, overrides: Partial<ProofMessage> = {}): ProofMessage {
  const publicValues = encodeAbiParameters(
    [
      { type: "bytes32" }, { type: "bytes32" }, { type: "uint64" }, { type: "bytes32" }, { type: "bytes32" }, { type: "bytes32" },
      { type: "uint64" }, { type: "bytes32" }, { type: "uint64" }, { type: "bytes32" }, { type: "bytes32" },
    ],
    [word("aa"), rootOf(startSlot), startSlot, word("bb"), word("cc"), rootOf(newSlot), newSlot, word("dd"), 1n, word("ee"), word("ff")],
  );
  return {
    version: 1,
    pair: "eth-pls",
    direction: "first-to-second",
    programKey: PROGRAM_KEY,
    startSlot,
    startRoot: rootOf(startSlot),
    newSlot,
    newRoot: rootOf(newSlot),
    publicValues,
    proof: `0x${"ab".repeat(356)}`,
    ...overrides,
  };
}

const oraclePayload = (startSlot: bigint, newSlot: bigint): Hex => encodeProofMessage(proofMessage(startSlot, newSlot, { version: 2, proof: `0x${"ab".repeat(65)}` }), { acceptOracleProof: true });
const payloadOf = (startSlot: bigint, newSlot: bigint, overrides: Partial<ProofMessage> = {}): Hex => encodeProofMessage(proofMessage(startSlot, newSlot, overrides));
const headAt = (slot: bigint): LightClientHead => ({ headSlot: slot, headRoot: rootOf(slot), programKey: PROGRAM_KEY });
const timedHeadAt = (slot: bigint, checkedAt = 0): TimedHead => ({ ...headAt(slot), checkedAt });

/** A light client reader whose head the test moves. */
function movableHead(slot: bigint, now: () => number) {
  let current = headAt(slot);
  const reader: TimedLightClientReader & { move(to: bigint): void; failNext(): void } = {
    async read() {
      if (failing) throw new Error("rpc down");
      return { ...current, checkedAt: now() };
    },
    move(to) {
      current = headAt(to);
    },
    failNext() {
      failing = true;
    },
  };
  let failing = false;
  return Object.assign(reader, { recover: () => (failing = false) });
}

/** A board that the test fills and breaks. */
function fakeBoard() {
  const handlers = new Map<Hex, (message: BoardMessage) => void>();
  const board = { recentMessages: [] as BoardMessage[], recentFails: 0, subscribeCalls: 0, subscribeFails: 0, closed: 0, subscriptionsClosed: 0 };
  const feed: BoardFeed = {
    async subscribe(category, onMessage) {
      board.subscribeCalls += 1;
      if (board.subscribeFails > 0) {
        board.subscribeFails -= 1;
        throw new Error("socket closed");
      }
      handlers.set(category, onMessage);
      return { close: async () => void (board.subscriptionsClosed += 1) };
    },
    async recent(category) {
      if (board.recentFails > 0) {
        board.recentFails -= 1;
        throw new Error("socket closed");
      }
      return board.recentMessages.filter((message) => message.category === category);
    },
    async close() {
      board.closed += 1;
    },
  };
  const message = (direction: ProofDirection, data: Hex): BoardMessage => ({ category: proofCategory("eth-pls", direction), data, hash: word("01") });
  const deliver = (direction: ProofDirection, data: Hex) => handlers.get(proofCategory("eth-pls", direction))?.(message(direction, data));
  return { feed, board, message, deliver };
}

type Rig = ReturnType<typeof makeRig>;

function makeRig(options: { storage?: Storage; verify?: () => Promise<void>; headSlot?: bigint; acceptOracleProof?: boolean } = {}) {
  const storage = options.storage ?? openStorage(":memory:");
  const clock = makeClock();
  const log = memoryLogger();
  const prover = controllableProver().binary;
  const verifyCalls: number[] = [];
  const verify = options.verify ?? (async () => {});
  prover.verify = async () => {
    verifyCalls.push(1);
    return verify();
  };
  const context: BackendModuleContext = { storage, config: makeConfig({ msgboardUrl: "https://board.invalid", acceptOracleProof: options.acceptOracleProof ?? false }), pair: PAIR, prover, proverForJob: () => prover, now: clock.now, logger: log.logger };
  const app = createApp({ context, modules: MODULES, enabled: ["msgboard-indexer"] });
  const heads = { "first-to-second": movableHead(options.headSlot ?? 100n, clock.now), "second-to-first": movableHead(options.headSlot ?? 100n, clock.now) };
  const board = fakeBoard();
  const dependencies: IndexerDependencies = { pair: PAIR, feed: board.feed, lightClients: heads, pollMilliseconds: 1_000, acceptOracleProof: options.acceptOracleProof ?? false };
  return { storage, clock, log, context, app, heads, board, dependencies, verifyCalls };
}

const latest = async (rig: Rig, direction: ProofDirection = "first-to-second") => {
  const answer = await rig.app.request(`/proofs/latest/${direction}`);
  return { status: answer.status, body: (await answer.json()) as Record<string, unknown> };
};

const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

beforeEach(() => {
  created.boardUrls.length = 0;
});

describe("chooseLatest", () => {
  const head = headAt(100n);
  const stored = (newSlot: bigint, startSlot = 100n): StoredProof => ({ pair: "eth-pls", direction: "first-to-second", startSlot, newSlot, payload: payloadOf(startSlot, newSlot), receivedAt: 1 });

  it("keeps the proof that starts at the head and reaches furthest", () => {
    const first = chooseLatest(null, proofMessage(100n, 120n), head, 5);
    expect(first).toMatchObject({ startSlot: 100n, newSlot: 120n, receivedAt: 5 });
    const longer = chooseLatest(first, proofMessage(100n, 150n), head, 6);
    expect(longer?.newSlot).toBe(150n);
    expect(longer?.receivedAt).toBe(6);
    const shorter = chooseLatest(longer, proofMessage(100n, 130n), head, 7);
    expect(shorter).toBe(longer);
  });

  it("lets the first proof stay when a later proof reaches the same slot", () => {
    const current = stored(120n);
    expect(chooseLatest(current, proofMessage(100n, 120n), head, 9)).toBe(current);
  });

  it("refuses a candidate that does not start at the head, even if it reaches furthest", () => {
    expect(chooseLatest(null, proofMessage(90n, 500n), head, 1)).toBeNull();
    expect(chooseLatest(null, proofMessage(110n, 500n), head, 1)).toBeNull();
    const current = stored(120n);
    expect(chooseLatest(current, proofMessage(90n, 500n), head, 1)).toBe(current);
  });

  it("refuses a candidate that does not move the head forward", () => {
    expect(chooseLatest(null, proofMessage(100n, 100n), head, 1)).toBeNull();
  });

  it("drops a kept proof that no longer starts at the head", () => {
    expect(chooseLatest(stored(120n, 90n), proofMessage(100n, 80n), head, 1)).toBeNull();
  });

  it("replaces a kept proof that went stale with a candidate that starts at the head", () => {
    const next = chooseLatest(stored(120n, 90n), proofMessage(100n, 110n), head, 3);
    expect(next?.startSlot).toBe(100n);
  });
});

describe("cacheLightClientReader", () => {
  it("reads the chain once in 3 seconds, again after that, says when it read, and does not keep a failure", async () => {
    const clock = makeClock();
    let reads = 0;
    let failing = true;
    const reader = cacheLightClientReader(
      {
        async read() {
          reads += 1;
          if (failing) throw new Error("down");
          return headAt(BigInt(reads));
        },
      },
      clock.now,
    );
    await expect(reader.read()).rejects.toThrow("down");
    failing = false;
    const first = await reader.read();
    expect(first.checkedAt).toBe(clock.now());
    clock.advance(2_999);
    expect(await reader.read()).toBe(first);
    expect(reads).toBe(2);
    clock.advance(1);
    const second = await reader.read();
    expect(second.headSlot).toBe(3n);
    expect(second.checkedAt).toBe(clock.now());
  });
});

describe("the msgboard indexer", () => {
  let stops: Array<() => Promise<void>> = [];
  afterEach(async () => {
    await Promise.all(stops.map((stop) => stop()));
    stops = [];
    vi.useRealTimers();
  });
  const run = async (rig: Rig) => {
    const stop = await startIndexer(rig.context, rig.dependencies);
    stops.push(stop);
    return stop;
  };

  it("keeps the proof that starts at the head and reaches furthest", async () => {
    const rig = makeRig();
    rig.board.board.recentMessages = [
      rig.board.message("first-to-second", payloadOf(100n, 130n)),
      rig.board.message("first-to-second", payloadOf(100n, 160n)),
      rig.board.message("first-to-second", payloadOf(100n, 140n)),
    ];
    await run(rig);
    const answer = await latest(rig);
    expect(answer.status).toBe(200);
    expect(answer.body).toMatchObject({ pair: "eth-pls", direction: "first-to-second", startSlot: "100", newSlot: "160", receivedAt: rig.clock.now() });
    expect(answer.body.payload).toBe(payloadOf(100n, 160n));
    expect(answer.body.headCheckedAt).toBe(rig.clock.now());
    expect(answer.body).toMatchObject({ programKey: PROGRAM_KEY, startRoot: rootOf(100n), newRoot: rootOf(160n) });
    expect(await latest(rig, "second-to-first")).toMatchObject({ status: 404, body: { error: "no usable proof" } });
  });

  it("keeps a proof that the live subscription delivers", async () => {
    const rig = makeRig();
    await run(rig);
    rig.board.deliver("second-to-first", payloadOf(100n, 125n, { direction: "second-to-first" }));
    await settle();
    expect((await latest(rig, "second-to-first")).body).toMatchObject({ direction: "second-to-first", newSlot: "125" });
  });

  it("keeps and serves an oracle proof when the setting is on", async () => {
    const rig = makeRig({ acceptOracleProof: true });
    rig.board.board.recentMessages = [rig.board.message("first-to-second", oraclePayload(100n, 130n))];
    await run(rig);
    expect(rig.verifyCalls.length).toBe(0);
    const answer = await latest(rig);
    expect(answer.status).toBe(200);
    expect(answer.body).toMatchObject({ newSlot: "130", payload: oraclePayload(100n, 130n), headCheckedAt: rig.clock.now() });
    expect((answer.body.proof as string).length).toBe(2 + 65 * 2);
  });

  it("refuses an oracle proof at intake when the setting is off", async () => {
    const rig = makeRig({ acceptOracleProof: false });
    rig.board.board.recentMessages = [rig.board.message("first-to-second", oraclePayload(100n, 130n))];
    await run(rig);
    expect(loadStoredProof(rig.storage, "first-to-second")).toBeNull();
    expect(rig.log.lines.some((line) => line.includes("oracle-proof-not-accepted"))).toBe(true);
  });

  it("does not serve a stored oracle proof when the setting is off", async () => {
    const rig = makeRig({ acceptOracleProof: false });
    await run(rig);
    saveStoredProof(rig.storage, { pair: "eth-pls", direction: "first-to-second", startSlot: 100n, newSlot: 130n, payload: oraclePayload(100n, 130n), receivedAt: 1 });
    expect((await latest(rig)).status).toBe(404);
  });

  it("gives a message another look after it was refused because it starts away from an old head", async () => {
    vi.useFakeTimers();
    const rig = makeRig();
    rig.board.board.recentMessages = [rig.board.message("first-to-second", payloadOf(130n, 160n))];
    await run(rig);
    expect(rig.log.lines.some((line) => line.includes("start-slot-differs-from-head"))).toBe(true);
    expect(loadStoredProof(rig.storage, "first-to-second")).toBeNull();
    rig.heads["first-to-second"].move(130n);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(loadStoredProof(rig.storage, "first-to-second")?.newSlot).toBe(160n);
  });

  it("gives a message another look after it was refused because its start root differs from an old head", async () => {
    vi.useFakeTimers();
    const rig = makeRig();
    const reader = rig.heads["first-to-second"];
    const spy = vi.spyOn(reader, "read").mockResolvedValue({ ...timedHeadAt(100n), headRoot: word("77") });
    rig.board.board.recentMessages = [rig.board.message("first-to-second", payloadOf(100n, 130n))];
    await run(rig);
    expect(rig.log.lines.some((line) => line.includes("start-root-differs-from-head"))).toBe(true);
    spy.mockRestore();
    await vi.advanceTimersByTimeAsync(1_000);
    expect(loadStoredProof(rig.storage, "first-to-second")?.newSlot).toBe(130n);
  });

  it("drops messages when the queue is full, counts them and goes on", async () => {
    const rig = makeRig();
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => (release = resolve));
    const slow = makeRig({ verify: () => gate });
    await startIndexer(slow.context, slow.dependencies).then((stop) => stops.push(stop));
    for (let index = 0; index < 70; index += 1) slow.board.deliver("first-to-second", payloadOf(100n, 101n + BigInt(index)));
    expect(slow.log.lines.filter((line) => line.includes("proof_queue_full")).length).toBe(6);
    release();
    await settle();
    await settle();
    expect(slow.verifyCalls.length).toBe(64);
    expect(loadStoredProof(slow.storage, "first-to-second")?.newSlot).toBe(164n);
    expect(rig.verifyCalls.length).toBe(0);
  });

  it("never queues a payload longer than the longest proof message", async () => {
    const rig = makeRig();
    await run(rig);
    rig.board.deliver("first-to-second", `0x${"ab".repeat(2_000)}`);
    rig.board.deliver("first-to-second", "0x1234");
    await settle();
    const refusals = rig.log.lines.filter((line) => line.includes("proof_refused"));
    expect(refusals.length).toBe(1);
  });

  it("refuses a proof that fails the check", async () => {
    const rig = makeRig({ verify: async () => Promise.reject(new Error("the proof does not verify")) });
    rig.board.board.recentMessages = [rig.board.message("first-to-second", payloadOf(100n, 130n))];
    await run(rig);
    expect(rig.verifyCalls.length).toBe(1);
    expect(await latest(rig)).toMatchObject({ status: 404, body: { error: "no usable proof" } });
    expect(loadStoredProof(rig.storage, "first-to-second")).toBeNull();
  });

  it("refuses text that is not a proof message, a wrong pair, a wrong program key and a proof that starts away from the head", async () => {
    const rig = makeRig();
    rig.board.board.recentMessages = [
      rig.board.message("first-to-second", "0x1234"),
      rig.board.message("first-to-second", payloadOf(100n, 130n, { programKey: word("99") })),
      rig.board.message("first-to-second", payloadOf(90n, 130n)),
      rig.board.message("first-to-second", payloadOf(100n, 130n, { direction: "second-to-first" })),
    ];
    await run(rig);
    expect(rig.verifyCalls.length).toBe(0);
    expect(loadStoredProof(rig.storage, "first-to-second")).toBeNull();
  });

  it("looks at a republished message once", async () => {
    const rig = makeRig();
    rig.board.board.recentMessages = [rig.board.message("first-to-second", payloadOf(100n, 130n))];
    const stop = await run(rig);
    rig.board.deliver("first-to-second", payloadOf(100n, 130n));
    await settle();
    expect(rig.verifyCalls.length).toBe(1);
    await stop();
  });

  it("forgets the memory of messages after a large number, so memory stays small", async () => {
    const rig = makeRig();
    rig.board.board.recentMessages = Array.from({ length: 513 }, (_, index) => rig.board.message("first-to-second", payloadOf(100n, 101n + BigInt(index))));
    await run(rig);
    expect((await latest(rig)).body.newSlot).toBe("613");
  });

  it("serves the proof after the board dropped it, from SQLite after a restart", async () => {
    const storage = openStorage(":memory:");
    const first = makeRig({ storage });
    first.board.board.recentMessages = [first.board.message("first-to-second", payloadOf(100n, 130n))];
    const stop = await startIndexer(first.context, first.dependencies);
    await stop();
    const second = makeRig({ storage });
    second.board.board.recentMessages = [];
    await run(second);
    const answer = await latest(second);
    expect(answer.status).toBe(200);
    expect(answer.body).toMatchObject({ startSlot: "100", newSlot: "130" });
    expect(second.verifyCalls.length).toBe(0);
  });

  it("answers 404 once the head moved past the proof's start", async () => {
    const rig = makeRig();
    rig.board.board.recentMessages = [rig.board.message("first-to-second", payloadOf(100n, 130n))];
    await run(rig);
    expect((await latest(rig)).status).toBe(200);
    rig.heads["first-to-second"].move(130n);
    expect(await latest(rig)).toMatchObject({ status: 404, body: { error: "no usable proof" } });
    expect(loadStoredProof(rig.storage, "first-to-second")).toBeNull();
  });

  it("answers 404 when the start slot matches but the header root differs", async () => {
    const rig = makeRig();
    rig.board.board.recentMessages = [rig.board.message("first-to-second", payloadOf(100n, 130n))];
    await run(rig);
    rig.heads["first-to-second"].move(100n);
    const reader = rig.dependencies.lightClients["first-to-second"];
    vi.spyOn(reader, "read").mockResolvedValue({ ...timedHeadAt(100n), headRoot: word("77") });
    expect((await latest(rig)).status).toBe(404);
  });

  it("answers 503 and never serves an unchecked proof when the light client cannot be read", async () => {
    const rig = makeRig();
    rig.board.board.recentMessages = [rig.board.message("first-to-second", payloadOf(100n, 130n))];
    await run(rig);
    rig.heads["first-to-second"].failNext();
    expect(await latest(rig)).toMatchObject({ status: 503, body: { error: "the light client cannot be read" } });
    expect(loadStoredProof(rig.storage, "first-to-second")).not.toBeNull();
  });

  it("answers 503 before the indexer starts, and 404 for an unknown direction", async () => {
    const rig = makeRig();
    saveStoredProof(rig.storage, { pair: "eth-pls", direction: "first-to-second", startSlot: 100n, newSlot: 130n, payload: payloadOf(100n, 130n), receivedAt: 1 });
    expect(await latest(rig)).toMatchObject({ status: 503, body: { error: "the msgboard indexer is not running" } });
    const unknown = await rig.app.request("/proofs/latest/sideways");
    expect(unknown.status).toBe(404);
    expect(await unknown.json()).toEqual({ error: "unknown direction" });
  });

  it("deletes a stored row that is not a proof message", async () => {
    const rig = makeRig();
    await run(rig);
    saveStoredProof(rig.storage, { pair: "eth-pls", direction: "first-to-second", startSlot: 100n, newSlot: 130n, payload: "0x1234", receivedAt: 1 });
    expect((await latest(rig)).status).toBe(404);
    expect(loadStoredProof(rig.storage, "first-to-second")).toBeNull();
  });

  it("drops the kept proof when the head moves while a candidate is checked", async () => {
    const rig = makeRig();
    saveStoredProof(rig.storage, { pair: "eth-pls", direction: "first-to-second", startSlot: 100n, newSlot: 120n, payload: payloadOf(100n, 120n), receivedAt: 1 });
    const reader = rig.heads["first-to-second"];
    const reads = [timedHeadAt(100n), timedHeadAt(120n)];
    vi.spyOn(reader, "read").mockImplementation(async () => reads.shift() ?? timedHeadAt(120n));
    rig.board.board.recentMessages = [rig.board.message("first-to-second", payloadOf(100n, 130n))];
    await run(rig);
    expect(loadStoredProof(rig.storage, "first-to-second")).toBeNull();
  });

  it("gives a message another look when the chain was unreadable at first", async () => {
    const rig = makeRig();
    const reader = rig.heads["first-to-second"];
    reader.failNext();
    rig.board.board.recentMessages = [rig.board.message("first-to-second", payloadOf(100n, 130n))];
    vi.useFakeTimers();
    await run(rig);
    expect(loadStoredProof(rig.storage, "first-to-second")).toBeNull();
    reader.recover();
    await vi.advanceTimersByTimeAsync(1_000);
    expect(loadStoredProof(rig.storage, "first-to-second")?.newSlot).toBe(130n);
  });

  it("logs and goes on when one message fails to store", async () => {
    const rig = makeRig();
    vi.spyOn(rig.storage.database, "prepare").mockImplementationOnce(() => {
      throw new Error("disk full");
    });
    rig.board.board.recentMessages = [rig.board.message("first-to-second", payloadOf(100n, 130n))];
    await run(rig);
    expect(rig.log.lines.some((line) => line.includes("proof_ingest_failed"))).toBe(true);
  });

  it("subscribes again after a socket close and reads recent messages", async () => {
    vi.useFakeTimers();
    const rig = makeRig();
    await run(rig);
    expect(rig.board.board.subscribeCalls).toBe(2);
    expect(health(rig.context)).toEqual({ state: "running" });
    rig.board.board.recentFails = 1;
    await vi.advanceTimersByTimeAsync(1_000);
    expect(health(rig.context)).toMatchObject({ state: "degraded" });
    expect(rig.board.board.subscriptionsClosed).toBe(2);
    rig.board.board.recentMessages = [rig.board.message("first-to-second", payloadOf(100n, 140n))];
    await vi.advanceTimersByTimeAsync(1_000);
    expect(rig.board.board.subscribeCalls).toBe(4);
    expect(health(rig.context)).toEqual({ state: "running" });
    expect(loadStoredProof(rig.storage, "first-to-second")?.newSlot).toBe(140n);
  });

  it("starts degraded when the board is down at the start and recovers", async () => {
    vi.useFakeTimers();
    const rig = makeRig();
    rig.board.board.subscribeFails = 1;
    await run(rig);
    expect(health(rig.context).state).toBe("degraded");
    await vi.advanceTimersByTimeAsync(1_000);
    expect(health(rig.context)).toEqual({ state: "running" });
  });

  it("stops the polling, closes the board and reports a stopped module", async () => {
    vi.useFakeTimers();
    const rig = makeRig();
    const stop = await startIndexer(rig.context, rig.dependencies);
    await stop();
    const calls = rig.board.board.subscribeCalls;
    await vi.advanceTimersByTimeAsync(5_000);
    expect(rig.board.board.subscribeCalls).toBe(calls);
    expect(rig.board.board.closed).toBe(1);
    expect(health(rig.context)).toEqual({ state: "degraded", detail: "stopped" });
  });

  it("does not poll again when the module stopped during a poll", async () => {
    vi.useFakeTimers();
    const rig = makeRig();
    const stop = await startIndexer(rig.context, rig.dependencies);
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => (release = resolve));
    const original = rig.board.feed.recent;
    let recentCalls = 0;
    rig.board.feed.recent = async (category) => {
      recentCalls += 1;
      await gate;
      return original(category);
    };
    await vi.advanceTimersByTimeAsync(1_000);
    await stop();
    release();
    await vi.advanceTimersByTimeAsync(5_000);
    expect(recentCalls).toBe(2);
  });

  it("reports degraded before it starts", () => {
    const rig = makeRig();
    expect(health(rig.context)).toEqual({ state: "degraded", detail: "not started" });
  });

  it("registers by itself in the module table", () => {
    expect(MODULES["msgboard-indexer"].register).toBe(register);
  });
});

describe("the real parts", () => {
  const contextWith = (config: Record<string, unknown> = {}): BackendModuleContext => ({ ...makeRig().context, config: makeConfig({ msgboardUrl: "https://board.invalid", ...config }) });

  it("builds one light client reader per direction and the board feed from the context alone", () => {
    created.boardUrls.length = 0;
    const dependencies = buildDependencies(contextWith());
    expect(dependencies.pair).toBe(PAIR);
    expect(Object.keys(dependencies.lightClients)).toEqual(["first-to-second", "second-to-first"]);
    expect(created.boardUrls).toEqual(["https://board.invalid"]);
  });

  it.each([
    [undefined, false],
    [false, false],
    [true, true],
  ])("takes the oracle setting %j from the configuration as %j", (value, expected) => {
    expect(buildDependencies(contextWith({ acceptOracleProof: value })).acceptOracleProof).toBe(expected);
  });

  it("ignores the process settings that earlier versions read", () => {
    vi.stubEnv("EXPLORER_MSGBOARD_URL", "https://other.invalid");
    vi.stubEnv("EXPLORER_ACCEPT_ORACLE_PROOFS", "true");
    created.boardUrls.length = 0;
    expect(buildDependencies(contextWith()).acceptOracleProof).toBe(false);
    expect(created.boardUrls).toEqual(["https://board.invalid"]);
    vi.unstubAllEnvs();
  });

  it("refuses to start without msgboardUrl in the configuration", async () => {
    const context = contextWith({ msgboardUrl: undefined });
    expect(() => buildDependencies(context)).toThrow(BackendConfigError);
    expect(() => buildDependencies(context)).toThrow("msgboardUrl");
    await expect(start(context)).rejects.toThrow("msgboardUrl");
  });

  it("starts and stops from the configuration", async () => {
    const context = contextWith();
    const stop = await start(context);
    expect(health(context)).toEqual({ state: "running" });
    await stop();
  });

  it("reads the head, the program key and the header root of that head", async () => {
    const calls: string[] = [];
    const reader = createLightClientReader(
      {
        readContract: (async (request: { functionName: string; args?: readonly unknown[] }) => {
          calls.push(`${request.functionName}${request.args === undefined ? "" : `(${String(request.args[0])})`}`);
          if (request.functionName === "head") return 77n;
          if (request.functionName === "programVKey") return PROGRAM_KEY;
          return rootOf(77n);
        }) as never,
        getBlockNumber: async () => 900n,
      },
      `0x${"3".repeat(40)}`,
    );
    expect(await reader.read()).toEqual({ headSlot: 77n, headRoot: rootOf(77n), programKey: PROGRAM_KEY });
    expect(calls).toContain("headers(77)");
  });
});

describe("createRecentSet", () => {
  it("forgets the key used longest ago when it is full", () => {
    const set = createRecentSet(2);
    set.add("a");
    set.add("b");
    expect(set.has("a")).toBe(true);
    set.add("c");
    expect(set.has("b")).toBe(false);
    expect(set.has("a")).toBe(true);
    expect(set.has("c")).toBe(true);
  });

  it("deletes a key, and adding a known key makes it the newest", () => {
    const set = createRecentSet(2);
    set.add("a");
    set.add("b");
    set.add("a");
    set.add("c");
    expect(set.has("b")).toBe(false);
    set.delete("a");
    expect(set.has("a")).toBe(false);
    expect(set.has("zz")).toBe(false);
  });
});
