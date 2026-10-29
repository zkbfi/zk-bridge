/**
 * Red team: the msgboard indexer and GET /proofs/latest (malicious board content, stale proofs, deletion, floods).
 */
import { describe, expect, it } from "vitest";
import { encodeAbiParameters, type Hex } from "viem";
import { encodeProofMessage, proofCategory, type ProofDirection, type ProofMessage } from "@zk-bridge/shared";
import type { BoardFeed, BoardMessage } from "@zk-bridge/shared/msgboard";
import type { LightClientHead } from "@zk-bridge/shared/prover";
import { createApp } from "../../src/app.ts";
import type { BackendModuleContext } from "../../src/module.ts";
import { MODULES } from "../../src/main.ts";
import { chooseLatest, loadStoredProof, type TimedLightClientReader } from "../../src/msgboard-indexer/latest-proof.ts";
import { SEEN_LIMIT, startIndexer } from "../../src/msgboard-indexer/module.ts";
import { openStorage } from "../../src/storage.ts";
import { PAIR, controllableProver, makeClock, makeConfig, memoryLogger, fakeProofNeed } from "../support.ts";

const word = (byte: string): Hex => `0x${byte.repeat(32)}`;
const PROGRAM_KEY = word("11");
const rootOf = (slot: bigint): Hex => `0x${slot.toString(16).padStart(64, "0")}`;

function proofMessage(startSlot: bigint, newSlot: bigint, overrides: Partial<ProofMessage> = {}): ProofMessage {
  const publicValues = encodeAbiParameters(
    [{ type: "bytes32" }, { type: "bytes32" }, { type: "uint64" }, { type: "bytes32" }, { type: "bytes32" }, { type: "bytes32" }, { type: "uint64" }, { type: "bytes32" }, { type: "uint64" }, { type: "bytes32" }, { type: "bytes32" }],
    [word("aa"), rootOf(startSlot), startSlot, word("bb"), word("cc"), rootOf(newSlot), newSlot, word("dd"), 1n, word("ee"), word("ff")],
  );
  return { version: 1, pair: "eth-pls", direction: "first-to-second", programKey: PROGRAM_KEY, startSlot, startRoot: rootOf(startSlot), newSlot, newRoot: rootOf(newSlot), publicValues, proof: `0x${"ab".repeat(356)}`, ...overrides };
}
const payloadOf = (startSlot: bigint, newSlot: bigint, overrides: Partial<ProofMessage> = {}): Hex => encodeProofMessage(proofMessage(startSlot, newSlot, overrides));
const oraclePayload = (startSlot: bigint, newSlot: bigint): Hex => encodeProofMessage(proofMessage(startSlot, newSlot, { version: 2, proof: `0x${"ab".repeat(65)}` }), { acceptOracleProof: true });

function rig(options: { verify?: () => Promise<void> } = {}) {
  const storage = openStorage(":memory:");
  const clock = makeClock();
  const log = memoryLogger();
  const prover = controllableProver().binary;
  let verifyCalls = 0;
  prover.verify = async () => {
    verifyCalls += 1;
    await options.verify?.();
  };
  const context: BackendModuleContext = { storage, config: makeConfig({ msgboardUrl: "https://board.invalid" }), pair: PAIR, prover, proverForJob: () => prover, readProofNeed: fakeProofNeed().read, now: clock.now, logger: log.logger };
  const app = createApp({ context, modules: MODULES, enabled: ["msgboard-indexer"] });
  const heads: Record<ProofDirection, { slot: bigint; programKey: Hex }> = { "first-to-second": { slot: 100n, programKey: PROGRAM_KEY }, "second-to-first": { slot: 100n, programKey: PROGRAM_KEY } };
  const reader = (direction: ProofDirection): TimedLightClientReader => ({
    async read() {
      const head: LightClientHead = { headSlot: heads[direction].slot, headRoot: rootOf(heads[direction].slot), programKey: heads[direction].programKey };
      return { ...head, checkedAt: clock.now() };
    },
  });
  const recent: BoardMessage[] = [];
  const feed: BoardFeed = {
    async subscribe() {
      return { close: async () => {} };
    },
    async recent(category) {
      return recent.filter((message) => message.category === category);
    },
    async close() {},
  };
  const post = (direction: ProofDirection, data: Hex) => recent.push({ category: proofCategory("eth-pls", direction), data, hash: word("01") });
  const run = (pollMilliseconds = 3_600_000) => startIndexer(context, { pair: PAIR, feed, lightClients: { "first-to-second": reader("first-to-second"), "second-to-first": reader("second-to-first") }, pollMilliseconds, acceptOracleProof: false });
  return { storage, clock, app, heads, post, run, recent, log, verifyCalls: () => verifyCalls };
}

const latest = async (r: ReturnType<typeof rig>, direction = "first-to-second") => {
  const answer = await r.app.request(`/proofs/latest/${direction}`);
  return { status: answer.status, body: (await answer.json()) as Record<string, unknown> };
};

describe("malicious board content", () => {
  it("ATTACK an oracle proof on the board is never stored or served when acceptOracleProof is false", async () => {
    const r = rig();
    r.post("first-to-second", oraclePayload(100n, 200n));
    const stop = await r.run();
    expect(loadStoredProof(r.storage, "first-to-second")).toBeNull();
    expect(r.verifyCalls()).toBe(0);
    expect((await latest(r)).status).toBe(404);
    await stop();
  });

  it("ATTACK a proof of the other direction, or of another pair, posted on this direction's category is refused", async () => {
    const r = rig();
    r.post("first-to-second", payloadOf(100n, 200n, { direction: "second-to-first" }));
    r.post("first-to-second", payloadOf(100n, 200n, { pair: "sepolia-pls943" }));
    const stop = await r.run();
    expect(loadStoredProof(r.storage, "first-to-second")).toBeNull();
    expect(loadStoredProof(r.storage, "second-to-first")).toBeNull();
    expect(r.verifyCalls()).toBe(0);
    await stop();
  });

  it("ATTACK a proof for another program key is refused before the verifier runs", async () => {
    const r = rig();
    r.post("first-to-second", payloadOf(100n, 200n, { programKey: word("99") }));
    const stop = await r.run();
    expect(loadStoredProof(r.storage, "first-to-second")).toBeNull();
    expect(r.verifyCalls()).toBe(0);
    await stop();
  });

  it("ATTACK a shorter (stale) proof posted after a longer one does not replace it", async () => {
    const r = rig();
    r.post("first-to-second", payloadOf(100n, 300n));
    r.post("first-to-second", payloadOf(100n, 150n));
    r.post("first-to-second", payloadOf(90n, 400n));
    const stop = await r.run();
    expect(loadStoredProof(r.storage, "first-to-second")?.newSlot).toBe(300n);
    expect((await latest(r)).body.newSlot).toBe("300");
    await stop();
  });

  it("ATTACK a payload over the longest form is never queued or checked", async () => {
    const r = rig();
    r.post("first-to-second", `${payloadOf(100n, 200n)}${"00".repeat(4096)}`);
    const stop = await r.run();
    expect(r.verifyCalls()).toBe(0);
    expect(loadStoredProof(r.storage, "first-to-second")).toBeNull();
    await stop();
  });

  const pollTwice = async (count: number) => {
    const r = rig({ verify: async () => { throw new Error("does not verify"); } });
    for (let index = 0; index < count; index += 1) r.post("first-to-second", payloadOf(100n, 101n + BigInt(index)));
    const stop = await r.run(5);
    const first = r.verifyCalls();
    // Let several more polls run on the same indexer (same seen set).
    await new Promise((resolve) => setTimeout(resolve, 300));
    await stop();
    return { first, total: r.verifyCalls() };
  };

  it("ATTACK fewer than SEEN_LIMIT junk proofs are verified once, not on every poll (control)", async () => {
    const { first, total } = await pollTwice(100);
    expect(first).toBe(100);
    expect(total).toBe(100);
  });

  it("ATTACK SUCCEEDS more than SEEN_LIMIT junk proofs that start at the head make the indexer run the verifier for every one on every poll", async () => {
    const count = SEEN_LIMIT + 88;
    const { first, total } = await pollTwice(count);
    expect(first).toBe(count);
    // The least-recently-used set of 512 keys is thrashed: every later poll verifies all of them again.
    expect(total).toBeGreaterThanOrEqual(2 * count);
  });
});

describe("GET /proofs/latest", () => {
  it("ATTACK unknown directions and traversal-like paths answer 404 and touch nothing", async () => {
    const r = rig();
    const stop = await r.run();
    for (const direction of ["both", "..%2Fhealth", "first-to-second%00", "__proto__", "constructor"]) expect((await latest(r, direction)).status).toBe(404);
    await stop();
  });

  it("ATTACK one read of a lagging RPC node (an older head) answers 503 and keeps the good proof (BLOCKED, was K-4)", async () => {
    const r = rig();
    r.post("first-to-second", payloadOf(100n, 200n));
    const stop = await r.run();
    expect(loadStoredProof(r.storage, "first-to-second")).not.toBeNull();
    // A load-balanced RPC answers from a node one update behind.
    r.heads["first-to-second"].slot = 90n;
    r.clock.advance(5_000);
    expect((await latest(r)).status).toBe(503);
    r.heads["first-to-second"].slot = 100n;
    r.clock.advance(5_000);
    expect(loadStoredProof(r.storage, "first-to-second")).not.toBeNull();
    expect((await latest(r)).status).toBe(200);
    // A head past the start of the proof still ends it.
    r.heads["first-to-second"].slot = 150n;
    r.clock.advance(5_000);
    expect((await latest(r)).status).toBe(404);
    expect(loadStoredProof(r.storage, "first-to-second")).toBeNull();
    await stop();
  });

  it("ATTACK a lagging head read while a new proof is ingested keeps the good proof (BLOCKED, was K-4)", () => {
    // The ingest step chooses with the head that it read. A lagging read must neither drop the kept proof nor let a
    // proof that starts at the old head replace it.
    const kept = { pair: "eth-pls", direction: "first-to-second" as const, startSlot: 100n, newSlot: 200n, payload: payloadOf(100n, 200n), receivedAt: 1 };
    const lagging = { headSlot: 90n, headRoot: rootOf(90n), programKey: PROGRAM_KEY, checkedAt: 2 };
    expect(chooseLatest(kept, proofMessage(90n, 300n), lagging, 3)).toBe(kept);
    expect(chooseLatest(kept, proofMessage(100n, 300n), lagging, 3)).toBe(kept);
  });

  it("ATTACK a proof whose start root differs from the head root (same slot) is not served", async () => {
    const r = rig();
    r.post("first-to-second", payloadOf(100n, 200n, { startRoot: word("77"), publicValues: encodeAbiParameters(
      [{ type: "bytes32" }, { type: "bytes32" }, { type: "uint64" }, { type: "bytes32" }, { type: "bytes32" }, { type: "bytes32" }, { type: "uint64" }, { type: "bytes32" }, { type: "uint64" }, { type: "bytes32" }, { type: "bytes32" }],
      [word("aa"), word("77"), 100n, word("bb"), word("cc"), rootOf(200n), 200n, word("dd"), 1n, word("ee"), word("ff")],
    ) }));
    const stop = await r.run();
    expect(loadStoredProof(r.storage, "first-to-second")).toBeNull();
    expect((await latest(r)).status).toBe(404);
    await stop();
  });
});
